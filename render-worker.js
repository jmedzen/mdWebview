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

  // 3. Parse main body
  let html = marked.parse(annotatedLines.join('\n'));

  // 3.5. Process Obsidian-style wikilinks [[TargetFile#Anchor|Alias]]
  html = processObsidianWikilinks(html);

  // 4. Process footnote references
  const refCounter = {};
  html = html.replace(/\[\^([^\]]+)\]/g, (m, id) => {
    if (!refCounter[id]) refCounter[id] = 0;
    refCounter[id]++;
    return `<a href="#fn-def-${id}" id="fn-ref-${id}-${refCounter[id]}" class="footnote-ref" title="註 ${id}">[${id}]</a>`;
  });

  // 5. Footnotes section
  if (footnotes.length > 0) {
    let fhtml = '<div class="footnotes"><hr class="footnotes-divider"><ul class="footnotes-list">';
    footnotes.forEach((fn) => {
      const id = fn.id;
      let fnRendered = marked.parse(fn.text.join('\n').trim()).trim();
      fnRendered = processObsidianWikilinks(fnRendered);
      const count = refCounter[id] || 0;
      let bl = count === 1 ? ` <a href="#fn-ref-${id}-1" class="footnote-backlink" title="返回">↩</a>` : '';
      if (count > 1) {
        bl = ' ';
        for (let r = 1; r <= count; r++)
          bl += `<a href="#fn-ref-${id}-${r}" class="footnote-backlink">↩<sup>${r}</sup></a> `;
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

function processObsidianWikilinks(html) {
  if (!html) return '';
  return html.replace(/(<code[\s\S]*?<\/code>)|\[\[([^\]\|#]+)?(?:#([^\]\|]+))?(?:\|([^\]]+))?\]\]/gi, (match, codeBlock, rawFile, rawAnchor, rawAlias) => {
    if (codeBlock) return codeBlock;

    const file = rawFile ? rawFile.trim() : '';
    const anchor = rawAnchor ? rawAnchor.trim() : '';
    let label = rawAlias ? rawAlias.trim() : '';

    if (!label) {
      if (file && anchor) {
        label = `${file} > ${anchor}`;
      } else if (file) {
        label = file;
      } else if (anchor) {
        label = `#${anchor}`;
      } else {
        label = match;
      }
    }

    return `<a href="javascript:void(0);" class="internal-link" data-target-file="${escAttr(file)}" data-target-anchor="${escAttr(anchor)}" title="內部連結: ${escAttr(file || '本頁')}${anchor ? '#' + escAttr(anchor) : ''}">${escHtml(label)}</a>`;
  });
}

function escHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escAttr(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
