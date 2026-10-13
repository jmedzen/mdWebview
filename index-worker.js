/**
 * index-worker.js — worker_threads for CPU/IO-heavy index & search work.
 *
 * This is a separate, short-lived worker pool from render-worker.js. The render
 * pool enforces a 30s timeout + respawn (server.js:548) tuned for short render
 * jobs; index builds and search scans can run longer, so they use this file.
 *
 * Message protocol (each message carries a `jobId` echoed back):
 *   { type:'section',     jobId, fullPath }
 *       → { ok, result:{entryLevel,preambleLineCount,totalLines,totalBytes,entries,groups} }
 *   { type:'index-build-file', jobId, fullPath, units:[{unitId,byteOffset,byteLength}] }
 *       → { ok, result:{ results:[{unitId, bigrams:[...]}] } }
 *   { type:'search-scan', jobId, fullPath, units:[{unitId,file,fileName,entryIndex,headword,byteOffset,byteLength,lineStart}], terms, maxProximityDist, maxPerFile, ignorePunct, skip }
 *       `skip` is the pagination cursor: the number of matches already delivered for this
 *       file by earlier pages. Matches are numbered in document order across ALL units by
 *       one running counter, and only indices in [skip, skip+maxPerFile) are emitted, so
 *       `maxPerFile` is the page SIZE rather than a hard ceiling — the same file is simply
 *       re-scanned with a larger `skip` for the next page. Absent or invalid `skip` means 0.
 *       → { ok, result:{ matches:[{file,fileName,entryIndex,headword,line,snippet}], truncated } }
 *       `line` is absolute (`u.lineStart + m.line - 1`). `truncated` is true iff at least
 *       one further match exists beyond the emitted window, in which case the scan
 *       early-exits; it is false when the window reached end of file (or `skip` was absent).
 */
'use strict';

const { parentPort } = require('worker_threads');
const fs = require('fs');
const { extractBigramsFromText, scanText } = require('./lib/text');

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/**
 * Scans a markdown document and extracts its section (entry) index.
 * Entries are headings at the deepest heading level present; shallower headings
 * are treated as "groups" (category dividers) and folded into the first entry
 * that follows them, so `entries[]` still tiles the file exactly.
 *
 * Returns entries with byte-accurate `offset` (start of the heading line, ASCII
 * '#') so byte-range reads never split a UTF-8 code point.
 */
function scanSections(text) {
  const headings = [];
  let byteOffset = 0;
  let lineNum = 1;
  let idx = 0;
  const len = text.length;
  let sawHeading = false;
  let preambleLineCount = 0;

  while (idx < len) {
    let nl = text.indexOf('\n', idx);
    if (nl === -1) nl = len;
    let contentEnd = nl;
    let isCRLF = false;
    if (contentEnd > idx && text.charCodeAt(contentEnd - 1) === 13) {
      contentEnd--;
      isCRLF = true;
    }
    const line = text.substring(idx, contentEnd);

    const m = HEADING_RE.exec(line);
    if (m) {
      if (!sawHeading) { preambleLineCount = lineNum - 1; sawHeading = true; }
      headings.push({ level: m[1].length, offset: byteOffset, lineStart: lineNum, headword: m[2].trim() });
    }

    byteOffset += Buffer.byteLength(line) + (nl === len ? 0 : (isCRLF ? 2 : 1));
    idx = (nl === len) ? len : nl + 1;
    lineNum++;
  }

  const totalBytes = byteOffset;
  const totalLines = lineNum - 1;

  if (headings.length === 0) {
    return { entryLevel: 0, preambleLineCount: 0, totalLines, totalBytes, entries: [], groups: [] };
  }

  // Find deepest heading level
  let deepestLevel = 1;
  for (let i = 0; i < headings.length; i++) {
    if (headings[i].level > deepestLevel) deepestLevel = headings[i].level;
  }

  const entries = [];
  const groups = [];
  let currentGroupIdx = -1;

  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    if (h.level < deepestLevel) {
      currentGroupIdx = groups.length;
      groups.push({
        headword: h.headword,
        level: h.level,
        firstEntry: entries.length,
        lastEntry: entries.length
      });
    } else {
      entries.push({
        headword: h.headword,
        level: h.level,
        offset: h.offset,
        lineStart: h.lineStart,
        lineEnd: -1,
        len: 0,
        groupIdx: currentGroupIdx
      });
      if (currentGroupIdx >= 0) {
        groups[currentGroupIdx].lastEntry = entries.length - 1;
      }
    }
  }

  // If no deepest headings found, treat all headings as entries
  if (entries.length === 0) {
    for (let i = 0; i < headings.length; i++) {
      const h = headings[i];
      entries.push({
        headword: h.headword,
        level: h.level,
        offset: h.offset,
        lineStart: h.lineStart,
        lineEnd: -1,
        len: 0,
        groupIdx: -1
      });
    }
    deepestLevel = 1;
  }

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    e.lineEnd = (i + 1 < entries.length) ? (entries[i + 1].lineStart - 1) : totalLines;
    e.len = (i + 1 < entries.length) ? (entries[i + 1].offset - e.offset) : (totalBytes - e.offset);
  }

  return { entryLevel: deepestLevel, preambleLineCount, totalLines, totalBytes, entries, groups };
}

// Note: extractBigramsFromText, localLineAt, SNIPPET_RADIUS, scanText are shared via ./lib/text.js

parentPort.on('message', async (msg) => {
  try {
    if (msg.type === 'section') {
      const text = await fs.promises.readFile(msg.fullPath, 'utf-8');
      const result = scanSections(text);
      parentPort.postMessage({ jobId: msg.jobId, ok: true, result });
    } else if (msg.type === 'index-build-file') {
      const { fullPath, units } = msg;
      const fileBuf = await fs.promises.readFile(fullPath);
      const results = [];
      const fileSize = fileBuf.length;
      for (const u of units) {
        const offset = u.byteOffset || 0;
        const length = u.byteLength || 0;
        if (offset >= fileSize) {
          results.push({ unitId: u.unitId, bigrams: [] });
          continue;
        }
        const end = Math.min(fileSize, offset + length);
        const slice = fileBuf.subarray(offset, end);
        const bigrams = Array.from(extractBigramsFromText(slice.toString('utf-8')));
        results.push({ unitId: u.unitId, bigrams });
      }
      parentPort.postMessage({ jobId: msg.jobId, ok: true, result: { results } });
    } else if (msg.type === 'search-scan') {
      const { fullPath, units, terms, maxProximityDist, maxPerFile, ignorePunct } = msg;
      const cap = typeof maxPerFile === 'number' ? maxPerFile : Infinity;
      // Cursor pagination. Matches are numbered in document order across all units;
      // `skip` counts the matches already delivered by earlier pages. Matches with
      // index < skip are counted but not emitted, the emitted page window is
      // [skip, skip + cap), and `truncated` reports that at least one further match
      // exists past that window. Absent/invalid `skip` means 0, so callers that do
      // not paginate behave exactly as before (and get truncated: false).
      const rawSkip = Number(msg.skip);
      const skip = Number.isFinite(rawSkip) && rawSkip > 0 ? Math.floor(rawSkip) : 0;
      const endExclusive = skip + cap;
      const fileBuf = await fs.promises.readFile(fullPath);
      const matches = [];
      const fileSize = fileBuf.length;
      let seen = 0;
      let truncated = false;
      for (const u of units) {
        // Early exit: a further match already proved a next page exists, so the
        // remaining units cannot change the result.
        if (truncated) break;
        const offset = u.byteOffset || 0;
        const length = u.byteLength || 0;
        if (offset >= fileSize) continue;
        const end = Math.min(fileSize, offset + length);
        const slice = fileBuf.subarray(offset, end);
        const ms = scanText(slice.toString('utf-8'), terms, maxProximityDist, ignorePunct);
        for (const m of ms) {
          const idx = seen++;
          if (idx < skip) continue;
          if (idx >= endExclusive) { truncated = true; break; }
          matches.push({
            file: u.file,
            fileName: u.fileName,
            entryIndex: u.entryIndex,
            headword: u.headword,
            line: u.lineStart + m.line - 1,
            snippet: m.snippet,
          });
        }
      }
      parentPort.postMessage({ jobId: msg.jobId, ok: true, result: { matches, truncated } });
    } else {
      parentPort.postMessage({ jobId: msg.jobId, ok: false, error: 'Unknown message type: ' + msg.type });
    }
  } catch (err) {
    parentPort.postMessage({ jobId: msg.jobId, ok: false, error: err.message });
  }
});
