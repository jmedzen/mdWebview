/* ================================================================
   md-worker.js — Markdown rendering Web Worker
   All heavy parsing is done off the main thread so the UI stays smooth.
   ================================================================ */

/* global importScripts, marked, self */
importScripts('https://cdn.jsdelivr.net/npm/marked/marked.min.js');

marked.setOptions({
  breaks: false,
  gfm: true,
  headerIds: true,
  mangle: false,
});

self.onmessage = function (e) {
  const { id, body } = e.data;

  try {
    const result = parseMarkdown(body);
    self.postMessage({ id, ok: true, ...result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err.message });
  }
};

function parseMarkdown(body) {
  // ── 1. Extract footnote definitions ──────────────────────────
  const lines = body.split('\n');
  const cleanLines = [];
  const footnotes = [];
  const footnoteMap = {};
  let currentFootnote = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^\[\^([^\]]+)\]:\s*(.*)$/);
    if (match) {
      const id = match[1];
      const text = match[2];
      currentFootnote = { id, text: [text] };
      footnotes.push(currentFootnote);
      footnoteMap[id] = currentFootnote;
    } else if (currentFootnote && (line.startsWith('    ') || line.startsWith('\t'))) {
      currentFootnote.text.push(line);
    } else if (currentFootnote && line.trim() === '') {
      let isContinuation = false;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === '') continue;
        if (lines[j].startsWith('    ') || lines[j].startsWith('\t')) {
          isContinuation = true;
        }
        break;
      }
      if (isContinuation) {
        currentFootnote.text.push(line);
      } else {
        currentFootnote = null;
        cleanLines.push(line);
      }
    } else {
      currentFootnote = null;
      cleanLines.push(line);
    }
  }

  const cleanBody = cleanLines.join('\n');

  // ── 2. Inject line-number anchors ────────────────────────────
  const bodyLines = cleanBody.split('\n');
  const annotatedLines = [];
  let prevWasBlank = true;
  bodyLines.forEach((line, idx) => {
    const lineNum = idx + 1;
    const trimmed = line.trim();
    const isBlockStart =
      /^#{1,6}\s/.test(trimmed) ||
      /^[-*+]\s/.test(trimmed) ||
      /^\d+\.\s/.test(trimmed) ||
      /^>/.test(trimmed) ||
      /^```/.test(trimmed) ||
      (prevWasBlank && trimmed.length > 0);
    if (isBlockStart) {
      annotatedLines.push(`<span id="L${lineNum}" data-line="${lineNum}" class="line-anchor"></span>`);
    }
    annotatedLines.push(line);
    prevWasBlank = trimmed.length === 0;
  });
  const annotatedBody = annotatedLines.join('\n');

  // ── 3. Parse main markdown body ──────────────────────────────
  let html = marked.parse(annotatedBody);

  // ── 4. Process footnote references ──────────────────────────
  const refCounter = {};
  html = html.replace(/\[\^([^\]]+)\]/g, (match, id) => {
    if (!refCounter[id]) refCounter[id] = 0;
    refCounter[id]++;
    const refId = `fn-ref-${id}-${refCounter[id]}`;
    return `<a href="#fn-def-${id}" id="${refId}" class="footnote-ref" title="註 ${id}">[${id}]</a>`;
  });

  // ── 5. Build footnotes section ───────────────────────────────
  if (footnotes.length > 0) {
    let footnotesHtml = '<div class="footnotes"><hr class="footnotes-divider"><ul class="footnotes-list">';

    footnotes.forEach((fn) => {
      const id = fn.id;
      const fnText = fn.text.join('\n').trim();
      let fnRendered = marked.parse(fnText).trim();

      let backlinksHtml = '';
      const count = refCounter[id] || 0;
      if (count === 1) {
        backlinksHtml = ` <a href="#fn-ref-${id}-1" class="footnote-backlink" title="返回">↩</a>`;
      } else if (count > 1) {
        backlinksHtml = ' ';
        for (let r = 1; r <= count; r++) {
          backlinksHtml += `<a href="#fn-ref-${id}-${r}" class="footnote-backlink" title="返回至第 ${r} 處">↩<sup>${r}</sup></a> `;
        }
      }

      if (fnRendered.includes('</p>')) {
        const lastIdx = fnRendered.lastIndexOf('</p>');
        fnRendered = fnRendered.substring(0, lastIdx) + backlinksHtml + fnRendered.substring(lastIdx);
      } else {
        fnRendered += backlinksHtml;
      }

      footnotesHtml += `<li class="footnote-item" id="fn-def-${id}" data-id="${id}">
          <span class="footnote-label">[${id}]</span>
          <div class="footnote-item-content">${fnRendered}</div>
        </li>`;
    });

    footnotesHtml += '</ul></div>';
    html += footnotesHtml;
  }

  return { html };
}
