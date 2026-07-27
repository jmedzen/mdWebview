/* ================================================================
   render-worker.js — Node.js Worker Thread for Markdown SSR
   Runs in a separate OS thread, keeping the main event loop free.
   ================================================================ */

const { parentPort } = require('worker_threads');
const { marked } = require('marked');

marked.setOptions({ breaks: false, gfm: true, headerIds: true, mangle: false });

parentPort.on('message', ({ jobId, body }) => {
  try {
    const html = renderMarkdownSSR(body);
    parentPort.postMessage({ jobId, html });
  } catch (err) {
    parentPort.postMessage({ jobId, error: err.message });
  }
});

function renderMarkdownSSR(body) {
  // 1. Extract footnote definitions
  const lines = body.split('\n');
  const cleanLines = [];
  const footnotes = [];
  const footnoteMap = {};
  let currentFootnote = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^\[\^([^\]]+)\]:\s*(.*)$/);
    if (match) {
      const id = match[1], text = match[2];
      currentFootnote = { id, text: [text] };
      footnotes.push(currentFootnote);
      footnoteMap[id] = currentFootnote;
    } else if (currentFootnote && (line.startsWith('    ') || line.startsWith('\t'))) {
      currentFootnote.text.push(line);
    } else if (currentFootnote && line.trim() === '') {
      let isContinuation = false;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === '') continue;
        if (lines[j].startsWith('    ') || lines[j].startsWith('\t')) isContinuation = true;
        break;
      }
      if (isContinuation) { currentFootnote.text.push(line); }
      else { currentFootnote = null; cleanLines.push(line); }
    } else { currentFootnote = null; cleanLines.push(line); }
  }

  // 2. Inject line-number anchors
  const bodyLines = cleanLines;
  const annotatedLines = [];
  let prevWasBlank = true;
  bodyLines.forEach((line, idx) => {
    const lineNum = idx + 1;
    const trimmed = line.trim();
    const isBlockStart =
      /^#{1,6}\s/.test(trimmed) || /^[-*+]\s/.test(trimmed) ||
      /^\d+\.\s/.test(trimmed) || /^>/.test(trimmed) || /^```/.test(trimmed) ||
      (prevWasBlank && trimmed.length > 0);
    if (isBlockStart)
      annotatedLines.push(`<span id="L${lineNum}" data-line="${lineNum}" class="line-anchor"></span>`);
    annotatedLines.push(line);
    prevWasBlank = trimmed.length === 0;
  });
  // 3. Convert Obsidian-style wikilinks before markdown parsing
  const annotatedBody = convertWikilinks(annotatedLines.join('\n'));

  // 4. Parse main body
  let html = marked.parse(annotatedBody);

  // 4. Process footnote references
  const refCounter = {};
  html = html.replace(/\[\^([^\]]+)\]/g, (m, id) => {
    if (!refCounter[id]) refCounter[id] = 0;
    refCounter[id]++;
    return `<a href="#fn-def-${id}" id="fn-ref-${id}-${refCounter[id]}" class="footnote-ref" title="\u8a3b ${id}">[${id}]</a>`;
  });

  // 5. Footnotes section
  if (footnotes.length > 0) {
    let fhtml = '<div class="footnotes"><hr class="footnotes-divider"><ul class="footnotes-list">';
    footnotes.forEach((fn) => {
      const id = fn.id;
      let fnRendered = marked.parse(fn.text.join('\n').trim()).trim();
      const count = refCounter[id] || 0;
      let bl = count === 1 ? ` <a href="#fn-ref-${id}-1" class="footnote-backlink" title="\u8fd4\u56de">\u21a9</a>` : '';
      if (count > 1) {
        bl = ' ';
        for (let r = 1; r <= count; r++)
          bl += `<a href="#fn-ref-${id}-${r}" class="footnote-backlink">\u21a9<sup>${r}</sup></a> `;
      }
      if (fnRendered.includes('</p>')) {
        const li = fnRendered.lastIndexOf('</p>');
        fnRendered = fnRendered.slice(0, li) + bl + fnRendered.slice(li);
      } else { fnRendered += bl; }
      fhtml += `<li class="footnote-item" id="fn-def-${id}" data-id="${id}"><span class="footnote-label">[${id}]</span><div class="footnote-item-content">${fnRendered}</div></li>`;
    });
    fhtml += '</ul></div>';
    html += fhtml;
  }

  return html;
}

/**
 * Convert Obsidian [[wikilinks]] to HTML anchor tags.
 * Supports: [[page]], [[page|display]], [[page#heading]], [[page#heading|display]]
 * Runs as a single regex pass on the raw markdown string — O(n) with no DOM cost.
 */
function convertWikilinks(text) {
  // Negative lookbehind for backtick to skip wikilinks inside inline code
  return text.replace(/(?<!`)\[\[([^\]]+?)\]\]/g, (match, inner) => {
    const pipeIdx = inner.indexOf('|');
    let target, display;
    if (pipeIdx !== -1) {
      target = inner.substring(0, pipeIdx).trim();
      display = inner.substring(pipeIdx + 1).trim();
    } else {
      target = inner.trim();
      display = target;
    }

    // Split target into file and heading anchor parts
    const hashIdx = target.indexOf('#');
    let file = target;
    let anchor = '';
    if (hashIdx !== -1) {
      file = target.substring(0, hashIdx);
      anchor = target.substring(hashIdx); // includes the #
    }

    // data-wikilink stores the raw file name for client-side openFile resolution
    // href uses javascript:void(0) — actual navigation is handled by click delegation
    return `<a class="wikilink" data-wikilink-file="${escapeAttr(file)}" data-wikilink-anchor="${escapeAttr(anchor)}" href="javascript:void(0)" title="${escapeAttr(target)}">${escapeHtml(display)}</a>`;
  });
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escapeAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
