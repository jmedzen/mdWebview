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
 *   { type:'search-scan', jobId, fullPath, units:[{unitId,file,fileName,entryIndex,headword,byteOffset,byteLength,lineStart}], terms, maxProximityDist, maxPerFile }
 *       → { ok, result:{ matches:[{file,fileName,entryIndex,headword,line,snippet}] } }
 */
'use strict';

const { parentPort } = require('worker_threads');
const fs = require('fs');

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const SNIPPET_RADIUS = 60;

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
      headings.push({ depth: m[1].length, offset: byteOffset, lineStart: lineNum, headword: m[2].trim() });
    }

    byteOffset += Buffer.byteLength(line) + (isCRLF ? 2 : 1);
    idx = (nl === len) ? len : nl + 1;
    lineNum++;
  }

  const totalBytes = byteOffset;
  const totalLines = lineNum - 1;

  if (headings.length === 0) {
    return { entryLevel: 0, preambleLineCount: 0, totalLines, totalBytes, entries: [], groups: [] };
  }

  let entryLevel = 0;
  for (const h of headings) if (h.depth > entryLevel) entryLevel = h.depth;

  const entries = [];
  const groups = [];
  let currentGroupIdx = -1;
  let pendingGroupOffset = -1;
  let pendingGroupLine = -1;

  for (const h of headings) {
    if (h.depth < entryLevel) {
      groups.push({ headword: h.headword, level: h.depth, firstEntry: entries.length, lastEntry: entries.length - 1 });
      currentGroupIdx = groups.length - 1;
      pendingGroupOffset = h.offset;
      pendingGroupLine = h.lineStart;
    } else {
      // Fold a preceding group header into this entry's start (renders once, as prefix).
      const offset = pendingGroupOffset >= 0 ? pendingGroupOffset : h.offset;
      const lineStart = pendingGroupLine >= 0 ? pendingGroupLine : h.lineStart;
      entries.push({ headword: h.headword, offset, lineStart, lineEnd: -1, len: 0, groupIdx: currentGroupIdx });
      pendingGroupOffset = -1;
      pendingGroupLine = -1;
      if (currentGroupIdx >= 0) groups[currentGroupIdx].lastEntry = entries.length - 1;
    }
  }

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    e.lineEnd = (i + 1 < entries.length) ? (entries[i + 1].lineStart - 1) : totalLines;
    e.len = (i + 1 < entries.length) ? (entries[i + 1].offset - e.offset) : (totalBytes - e.offset);
  }

  const validGroups = groups.filter(g => g.lastEntry >= g.firstEntry);

  return { entryLevel, preambleLineCount, totalLines, totalBytes, entries, groups: validGroups };
}

function isCJK(codePoint) {
  return (
    (codePoint >= 0x4E00 && codePoint <= 0x9FFF) ||   // CJK Unified Ideographs
    (codePoint >= 0x3400 && codePoint <= 0x4DBF) ||   // CJK Extension A
    (codePoint >= 0x20000 && codePoint <= 0x2A6DF) || // CJK Extension B
    (codePoint >= 0x2A700 && codePoint <= 0x2B73F) || // CJK Extension C
    (codePoint >= 0x2B740 && codePoint <= 0x2B81F) || // CJK Extension D
    (codePoint >= 0x2B820 && codePoint <= 0x2CEAF) || // CJK Extension E
    (codePoint >= 0x2CEB0 && codePoint <= 0x2EBEF) || // CJK Extension F
    (codePoint >= 0x30000 && codePoint <= 0x323AF) || // CJK Extension G, H
    (codePoint >= 0x2EBF0 && codePoint <= 0x2EE5D) || // CJK Extension I
    (codePoint >= 0xF900 && codePoint <= 0xFAFF) ||   // CJK Compatibility Ideographs
    (codePoint >= 0x2F800 && codePoint <= 0x2FA1D)    // CJK Compatibility Ideographs Supplement
  );
}

/**
 * Extract unique bigrams of consecutive CJK chars. MUST stay byte-for-byte
 * identical to extractBigrams() in server.js so query bigrams and index bigrams
 * match exactly.
 */
function extractBigramsFromText(text) {
  const set = new Set();
  let prevChar = '';
  const textLen = text.length;
  for (let i = 0; i < textLen;) {
    const codePoint = text.codePointAt(i);
    const charLen = codePoint > 0xFFFF ? 2 : 1;
    if (isCJK(codePoint)) {
      const currChar = charLen === 1 ? text[i] : text.slice(i, i + 2);
      if (prevChar) set.add(prevChar + currChar);
      prevChar = currChar;
    } else {
      prevChar = '';
    }
    i += charLen;
  }
  return set;
}

// 1-based line number (within `text`) of byte position `pos`.
function localLineAt(lineBreaks, pos) {
  let lo = 0, hi = lineBreaks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lineBreaks[mid] < pos) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1;
}

/**
 * Scan one unit of text for term matches. Mirrors the single/multi-term logic in
 * server.js, but scoped to a byte-range slice. Returns [{ line (local 1-based), snippet }].
 */
function scanText(text, terms, maxProximityDist) {
  const matches = [];
  const lineBreaks = [];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineBreaks.push(i);

  if (terms.length === 1) {
    const term = terms[0];
    let pos = 0;
    while (pos < text.length) {
      const matchIdx = text.indexOf(term, pos);
      if (matchIdx === -1) break;
      const line = localLineAt(lineBreaks, matchIdx);

      const lineStartIdx = text.lastIndexOf('\n', matchIdx) + 1;
      let lineEndIdx = text.indexOf('\n', matchIdx);
      if (lineEndIdx === -1) lineEndIdx = text.length;
      const lineText = text.substring(lineStartIdx, lineEndIdx);
      const idxInLine = matchIdx - lineStartIdx;
      const s = Math.max(0, idxInLine - SNIPPET_RADIUS);
      const e = Math.min(lineText.length, idxInLine + term.length + SNIPPET_RADIUS);
      let snippet = lineText.substring(s, e).trim();
      if (s > 0) snippet = '…' + snippet;
      if (e < lineText.length) snippet = snippet + '…';

      matches.push({ line, snippet });
      pos = matchIdx + term.length;
    }
    return matches;
  }

  // Multi-term with proximity filtering (mirrors server.js).
  if (!terms.every(t => text.includes(t))) return matches;

  const termPositions = [];
  for (const term of terms) {
    const posList = [];
    let p = 0;
    while (p < text.length) {
      const idx = text.indexOf(term, p);
      if (idx === -1) break;
      posList.push(idx);
      p = idx + term.length;
    }
    if (posList.length === 0) return matches;
    termPositions.push(posList);
  }

  const p0List = termPositions[0];
  for (const p0 of p0List) {
    let clusterValid = true;
    let minPos = p0;
    let maxPos = p0 + terms[0].length;

    for (let tIdx = 1; tIdx < terms.length; tIdx++) {
      const tLen = terms[tIdx].length;
      const list = termPositions[tIdx];
      let foundClose = false;
      const windowStart = minPos - maxProximityDist;
      let lo = 0, hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid] < windowStart) lo = mid + 1;
        else hi = mid;
      }
      for (let k = lo; k < list.length; k++) {
        const p = list[k];
        if (p > maxPos + maxProximityDist) break;
        const potentialMin = Math.min(minPos, p);
        const potentialMax = Math.max(maxPos, p + tLen);
        if (potentialMax - potentialMin <= maxProximityDist) {
          minPos = potentialMin;
          maxPos = potentialMax;
          foundClose = true;
          break;
        }
      }
      if (!foundClose) { clusterValid = false; break; }
    }

    if (clusterValid) {
      const line = localLineAt(lineBreaks, minPos);
      const s = Math.max(0, minPos - SNIPPET_RADIUS);
      const e = Math.min(text.length, maxPos + SNIPPET_RADIUS);
      let snippet = text.substring(s, e).replace(/\r?\n/g, ' ').trim();
      if (s > 0) snippet = '…' + snippet;
      if (e < text.length) snippet = snippet + '…';
      matches.push({ line, snippet });
    }
  }

  return matches;
}

parentPort.on('message', async (msg) => {
  try {
    if (msg.type === 'section') {
      const text = await fs.promises.readFile(msg.fullPath, 'utf-8');
      const result = scanSections(text);
      parentPort.postMessage({ jobId: msg.jobId, ok: true, result });
    } else if (msg.type === 'index-build-file') {
      const { fullPath, units } = msg;
      const fh = await fs.promises.open(fullPath, 'r');
      const results = [];
      try {
        for (const u of units) {
          const buf = Buffer.alloc(u.byteLength);
          await fh.read(buf, 0, u.byteLength, u.byteOffset);
          const bigrams = Array.from(extractBigramsFromText(buf.toString('utf-8')));
          results.push({ unitId: u.unitId, bigrams });
        }
      } finally {
        await fh.close();
      }
      parentPort.postMessage({ jobId: msg.jobId, ok: true, result: { results } });
    } else if (msg.type === 'search-scan') {
      const { fullPath, units, terms, maxProximityDist, maxPerFile } = msg;
      const cap = typeof maxPerFile === 'number' ? maxPerFile : Infinity;
      const fh = await fs.promises.open(fullPath, 'r');
      const matches = [];
      try {
        for (const u of units) {
          if (matches.length >= cap) break;
          const buf = Buffer.alloc(u.byteLength);
          await fh.read(buf, 0, u.byteLength, u.byteOffset);
          const ms = scanText(buf.toString('utf-8'), terms, maxProximityDist);
          for (const m of ms) {
            if (matches.length >= cap) break;
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
      } finally {
        await fh.close();
      }
      parentPort.postMessage({ jobId: msg.jobId, ok: true, result: { matches } });
    } else {
      parentPort.postMessage({ jobId: msg.jobId, ok: false, error: 'Unknown message type: ' + msg.type });
    }
  } catch (err) {
    parentPort.postMessage({ jobId: msg.jobId, ok: false, error: err.message });
  }
});
