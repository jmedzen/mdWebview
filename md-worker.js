/* ================================================================
   md-worker.js — High-Performance Markdown Rendering Web Worker
   Offloads all heavy parsing to background worker thread.
   ================================================================ */

/* global importScripts, marked, self */
importScripts('https://cdn.jsdelivr.net/npm/marked/marked.min.js');

marked.setOptions({
  breaks: true,
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

function preprocessObsidianFormatting(text) {
  if (!text) return '';
  // 1. Fix Obsidian bolding with inner spaces/NBSP: ** text ** -> <strong>text</strong>
  text = text.replace(/\*\*([\s\u00A0]*[^\*\n]+?[\s\u00A0]*)\*\*/g, (m, p1) => {
    const trimmed = p1.trim().replace(/^[\s\u00A0]+|[\s\u00A0]+$/g, '');
    return '<strong>' + trimmed + '</strong>';
  });
  // 2. Fix Obsidian double underscore bolding: __ text __ -> <strong>text</strong>
  text = text.replace(/__([\s\u00A0]*[^_\n]+?[\s\u00A0]*)__/g, (m, p1) => {
    const trimmed = p1.trim().replace(/^[\s\u00A0]+|[\s\u00A0]+$/g, '');
    return '<strong>' + trimmed + '</strong>';
  });
  return text;
}

function parseMarkdown(body) {
  if (!body) return { html: '' };
  body = preprocessObsidianFormatting(body);

  // ── 1. Extract footnote definitions (O(N) single pass) ────────
  const lines = body.split('\n');
  const cleanLines = [];
  const footnotes = [];
  let currentFootnote = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^\[\^([^\]]+)\]:\s*(.*)$/);
    if (match) {
      const id = match[1];
      const text = match[2];
      currentFootnote = { id, text: [text] };
      footnotes.push(currentFootnote);
    } else if (currentFootnote && (line.startsWith('    ') || line.startsWith('\t'))) {
      currentFootnote.text.push(line);
    } else if (currentFootnote && line.trim() === '') {
      currentFootnote.text.push(line);
    } else {
      if (currentFootnote) {
        while (currentFootnote.text.length > 1 && currentFootnote.text[currentFootnote.text.length - 1].trim() === '') {
          currentFootnote.text.pop();
        }
        currentFootnote = null;
      }
      cleanLines.push(line);
    }
  }

  // ── 2. Inject line-number anchors ────────────────────────────
  const annotatedLines = [];
  let prevWasBlank = true;
  for (let i = 0; i < cleanLines.length; i++) {
    const line = cleanLines[i];
    const lineNum = i + 1;
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
  }

  // ── 3. Parse main markdown body to HTML ─────────────────────
  let html = marked.parse(annotatedLines.join('\n'));

  // ── 4. Convert Obsidian-style [[wikilinks]] on HTML output ────
  if (html.includes('[[')) {
    html = convertWikilinks(html);
  }

  // ── 5. Process footnote references ──────────────────────────
  const refCounter = {};
  if (footnotes.length > 0) {
    html = html.replace(/\[\^([^\]]+)\]/g, (match, id) => {
      if (!refCounter[id]) refCounter[id] = 0;
      refCounter[id]++;
      const refId = `fn-ref-${id}-${refCounter[id]}`;
      return `<a href="#fn-def-${id}" id="${refId}" class="footnote-ref" title="註 ${id}">[${id}]</a>`;
    });

    // ── 6. Batch Process Footnotes (Single marked.parse Call) ──
    const FN_DELIM = '\n\n<!--FN_SPLIT_DELIMITER-->\n\n';
    const combinedFnText = footnotes.map(fn => fn.text.join('\n').trim()).join(FN_DELIM);
    let combinedFnHtml = marked.parse(combinedFnText).trim();
    if (combinedFnHtml.includes('[[')) {
      combinedFnHtml = convertWikilinks(combinedFnHtml);
    }
    const fnRenderedArray = combinedFnHtml.split(/<!--FN_SPLIT_DELIMITER-->/i);

    let footnotesHtml = '<div class="footnotes"><hr class="footnotes-divider"><ul class="footnotes-list">';

    footnotes.forEach((fn, idx) => {
      const id = fn.id;
      let fnRendered = (fnRenderedArray[idx] || '').trim();

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

/**
 * Convert Obsidian [[wikilinks]] in HTML output to <a> tags.
 * Supports: [[page]], [[page|display]], [[page#heading]], [[page#heading|display]], [[#heading]]
 * Fast exit if no wikilinks found. Skips matches inside <code>...</code> or <pre>...</pre> tags.
 */
function convertWikilinks(html) {
  if (!html || !html.includes('[[')) return html;
  return html.replace(/(<code[\s\S]*?<\/code>|<pre[\s\S]*?<\/pre>)|(?<!`)\[\[([^\]\n]+?)\]\]/gi, (match, codeBlock, inner) => {
    if (codeBlock) return codeBlock;
    if (!inner) return match;

    const pipeIdx = inner.indexOf('|');
    let target, display;
    if (pipeIdx !== -1) {
      target = inner.substring(0, pipeIdx).trim();
      display = inner.substring(pipeIdx + 1).trim();
    } else {
      target = inner.trim();
      display = target;
    }

    const hashIdx = target.indexOf('#');
    let file = target;
    let anchor = '';
    if (hashIdx !== -1) {
      file = target.substring(0, hashIdx).trim();
      anchor = target.substring(hashIdx).trim();
    }

    return `<a class="wikilink" data-wikilink-file="${escapeAttr(file)}" data-wikilink-anchor="${escapeAttr(anchor)}" href="javascript:void(0)" title="${escapeAttr(target)}">${escapeHtml(display)}</a>`;
  });
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escapeAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
