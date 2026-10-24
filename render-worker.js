/* ================================================================
   render-worker.js — High-Performance Node.js Worker Thread for SSR
   Runs in a separate OS thread, keeping the main event loop free.
   ================================================================ */

const { parentPort } = require('worker_threads');
const { marked } = require('marked');

// ── Per-document scan gates (O(n²) defense) ──────────────────────────────────
// marked calls every extension's start(src) on *each* tokenization step, and it
// passes the ENTIRE remaining suffix (marked v18 does `e.slice(1)` and folds the
// results with Math.min). An unconditional `src.indexOf(...)` therefore rescans
// the whole tail at every step, which is O(n²) in document length: a 5.42MB
// math-free file spent 13.2s in renderWithWorker with 95.6% of CPU samples
// inside start(), versus ~230ms once the scan is skipped.
//
// `setScanGates()` is called with the exact string that is about to be handed to
// marked.parse(), so a document containing no marker never pays for the scan.
// The win comes entirely from not executing indexOf on the full suffix; the
// skipped return value is irrelevant. Both -1 and undefined were measured at
// ~388ms with byte-identical output, because marked only consumes a start hint
// when it is a number >= 0. -1 is used as the conventional "not found".
//
// NOTE: without the gate, `return undefined` does NOT help (measured 8,211ms vs
// 222ms for -1) because indexOf still runs on the full suffix. The gate, not the
// sentinel, is what removes the O(n²) cost.
//
// `marked` runs synchronously here (async option is not enabled), so this
// module-level state cannot interleave between jobs.
let _scanEq = false;
let _scanDollar = false;
let _scanDollar2 = false;

function setScanGates(text) {
  _scanEq = text.indexOf('==') !== -1;
  _scanDollar = text.indexOf('$') !== -1;
  _scanDollar2 = text.indexOf('$$') !== -1;
}

marked.setOptions({ breaks: true, gfm: true, headerIds: true, mangle: false });
marked.use({
  tokenizer: {
    del(src) {
      // Standard GFM double tildes strikethrough only (prevent single tildes ~P11~P12~ range syntax from trigger del)
      const cap = /^~~(?=[^\s~])([\s\S]*?[^\s~])~~/.exec(src);
      if (cap) {
        return {
          type: 'del',
          raw: cap[0],
          text: cap[1],
          tokens: this.lexer.inlineTokens(cap[1])
        };
      }
      return undefined;
    }
  },
  extensions: [
    {
      name: 'highlight',
      level: 'inline',
      start(src) { return _scanEq ? src.indexOf('==') : -1; },
      tokenizer(src, tokens) {
        const rule = /^==(?=[^\s=])([\s\S]*?[^\s=])==/;
        const match = rule.exec(src);
        if (match) {
          return {
            type: 'highlight',
            raw: match[0],
            text: match[1],
            tokens: this.lexer.inlineTokens(match[1])
          };
        }
      },
      renderer(token) {
        return `<mark class="obsidian-highlight">${this.parser.parseInline(token.tokens)}</mark>`;
      }
    },
    {
      name: 'mathBlock',
      level: 'block',
      start(src) { return _scanDollar2 ? src.indexOf('$$') : -1; },
      tokenizer(src, tokens) {
        const rule = /^\$\$[\r\n]*([\s\S]*?)[\r\n]*\$\$/;
        const match = rule.exec(src);
        if (match) {
          return {
            type: 'mathBlock',
            raw: match[0],
            text: match[1].trim()
          };
        }
      },
      renderer(token) {
        return `<div class="math-block" data-math="${escapeAttr(token.text)}">$$${escapeHtml(token.text)}$$</div>\n`;
      }
    },
    {
      name: 'mathInline',
      level: 'inline',
      start(src) { return _scanDollar ? src.indexOf('$') : -1; },
      tokenizer(src, tokens) {
        const rule = /^\$(?!\s)([^$\n]+?)(?<!\s)\$/;
        const match = rule.exec(src);
        if (match) {
          return {
            type: 'mathInline',
            raw: match[0],
            text: match[1].trim()
          };
        }
      },
      renderer(token) {
        return `<span class="math-inline" data-math="${escapeAttr(token.text)}">$${escapeHtml(token.text)}$</span>`;
      }
    }
  ]
});

parentPort.on('message', ({ jobId, body, filePath, lineOffset }) => {
  try {
    const html = renderMarkdownSSR(body, filePath, lineOffset || 0);
    parentPort.postMessage({ jobId, html });
  } catch (err) {
    parentPort.postMessage({ jobId, error: err.message });
  }
});

function preprocessObsidianFormatting(text) {
  if (!text) return '';
  // 1. Strip Obsidian comments: %% comment %% (single line & multi-line)
  if (text.includes('%%')) {
    text = text.replace(/%%[\s\S]*?%%/g, '');
  }
  // 2. Fix Obsidian bolding with inner spaces/NBSP: ** text ** -> <strong>text</strong>
  if (text.includes('**')) {
    text = text.replace(/\*\*([\s\u00A0]*[^\*\n]+?[\s\u00A0]*)\*\*/g, (m, p1) => {
      const trimmed = p1.trim().replace(/^[\s\u00A0]+|[\s\u00A0]+$/g, '');
      return '<strong>' + escapeHtml(trimmed) + '</strong>';
    });
  }
  // 3. Fix Obsidian double underscore bolding: __ text __ -> <strong>text</strong>
  if (text.includes('__')) {
    text = text.replace(/__([\s\u00A0]*[^_\n]+?[\s\u00A0]*)__/g, (m, p1) => {
      const trimmed = p1.trim().replace(/^[\s\u00A0]+|[\s\u00A0]+$/g, '');
      return '<strong>' + escapeHtml(trimmed) + '</strong>';
    });
  }
  return text;
}

function convertObsidianImages(text, currentFilePath) {
  if (!text) return '';

  // 1. Match Obsidian double bracket image embeds: ![[image.png]] or ![[image.png|300]] or ![[image.png|300x200]]
  text = text.replace(/!\[\[([^\]\n]+?\.(?:png|jpg|jpeg|gif|svg|webp|ico|bmp))(?:\|([^\]\n]+))?\]\]/gi, (match, imgPath, options) => {
    imgPath = imgPath.trim();
    let styleAttr = '';
    let altAttr = escapeHtml(imgPath);

    if (options) {
      options = options.trim();
      if (/^\d+$/.test(options)) {
        styleAttr = ` style="width:${options}px; max-width:100%; height:auto;"`;
      } else if (/^\d+x\d+$/i.test(options)) {
        const [w, h] = options.toLowerCase().split('x');
        styleAttr = ` style="width:${w}px; height:${h}px; max-width:100%;"`;
      } else {
        altAttr = escapeHtml(options);
      }
    }

    const src = `/api/media?path=${encodeURIComponent(imgPath)}&doc=${encodeURIComponent(currentFilePath || '')}`;
    return `<img class="markdown-img" src="${src}" alt="${altAttr}"${styleAttr} loading="lazy" />`;
  });

  // 2. Match Obsidian shorthand single bracket image embeds: ![image.png] (not followed by '(')
  text = text.replace(/!\[([^\]\n]+\.(?:png|jpg|jpeg|gif|svg|webp|ico|bmp))\](?!\()/gi, (match, imgPath) => {
    imgPath = imgPath.trim();
    const src = `/api/media?path=${encodeURIComponent(imgPath)}&doc=${encodeURIComponent(currentFilePath || '')}`;
    return `<img class="markdown-img" src="${src}" alt="${escapeHtml(imgPath)}" loading="lazy" />`;
  });

  return text;
}

function normalizeImageSrcs(html, currentFilePath) {
  if (!html || !html.includes('<img')) return html;
  return html.replace(/<img\s+([^>]*?)src=["']([^"']+)["']([^>]*?)>/gi, (match, p1, src, p2) => {
    if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:') || src.startsWith('/api/media')) {
      return match;
    }
    const newSrc = `/api/media?path=${encodeURIComponent(src)}&doc=${encodeURIComponent(currentFilePath || '')}`;
    return `<img ${p1}src="${newSrc}"${p2}>`;
  });
}

function renderMarkdownSSR(body, filePath, lineOffset) {
  lineOffset = lineOffset || 0;
  if (!body) return '';
  body = preprocessObsidianFormatting(body);
  body = convertObsidianImages(body, filePath);

  // 1. Extract footnote definitions (O(N) single pass)
  const lines = body.split('\n');
  const cleanLines = [];
  const footnotes = [];
  let currentFootnote = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^\[\^([^\]]+)\]:\s*(.*)$/);
    if (match) {
      const id = match[1], text = match[2];
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

  // 2. Inject line-number anchors
  const annotatedLines = [];
  let inCodeBlock = false;
  let inRawHtmlTable = false;

  for (let i = 0; i < cleanLines.length; i++) {
    const line = cleanLines[i];
    const lineNum = lineOffset + i + 1;
    const trimmed = line.trim();

    // 1. Code blocks: do not inject anchors
    if (trimmed.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      annotatedLines.push(line);
      continue;
    }
    if (inCodeBlock) {
      annotatedLines.push(line);
      continue;
    }

    // 2. Horizontal rules: leave clean so marked produces <hr>
    if (/^(?:[-*_]\s*){3,}$/.test(trimmed)) {
      annotatedLines.push(line);
      continue;
    }

    // 3. Blockquotes
    const isQuoteLine = /^>/.test(trimmed);
    if (isQuoteLine) {
      const quoteContent = line.replace(/^>\s?/, '');
      annotatedLines.push(`> <span id="L${lineNum}" data-line="${lineNum}" class="line-anchor"></span>${quoteContent}`);
      continue;
    }

    // 4. Heading: insert anchor inside the heading text
    const headingMatch = line.match(/^(#{1,6}\s+)(.*)$/);
    if (headingMatch) {
      annotatedLines.push(`${headingMatch[1]}<span id="L${lineNum}" data-line="${lineNum}" class="line-anchor"></span>${headingMatch[2]}`);
      continue;
    }

    // 5. List item: insert anchor inside the list item text
    const listMatch = line.match(/^(\s*(?:[-*+]|\d+\.)\s+)(.*)$/);
    if (listMatch) {
      annotatedLines.push(`${listMatch[1]}<span id="L${lineNum}" data-line="${lineNum}" class="line-anchor"></span>${listMatch[2]}`);
      continue;
    }

    // 6. GFM Markdown Table rows
    // Delimiter row: e.g. | --- | :---: | ---: | or |---|---|
    if (/^\|(?:\s*:?-+:?\s*\|)+\s*$/.test(trimmed)) {
      annotatedLines.push(line);
      continue;
    }
    // GFM Table row (starts and ends with |)
    if (/^\|(.+)\|$/.test(trimmed)) {
      const tableRowAnnotated = line.replace(/^(\s*\|\s*)(.*)$/, `$1<span id="L${lineNum}" data-line="${lineNum}" class="line-anchor"></span>$2`);
      annotatedLines.push(tableRowAnnotated);
      continue;
    }

    // 7. Raw HTML Tables
    if (/<table\b/i.test(trimmed)) inRawHtmlTable = true;
    if (/<\/table>/i.test(trimmed)) {
      inRawHtmlTable = false;
      annotatedLines.push(line);
      continue;
    }

    if (inRawHtmlTable) {
      // For <td> or <th>, insert anchor inside the cell tag
      if (/<(?:td|th)\b/i.test(line)) {
        const cellAnnotated = line.replace(/(<(?:td|th)\b[^>]*>)/i, `$1<span id="L${lineNum}" data-line="${lineNum}" class="line-anchor"></span>`);
        annotatedLines.push(cellAnnotated);
      } else {
        annotatedLines.push(line);
      }
      continue;
    }

    // 8. Other Raw HTML block tags (<div>, <details>, <section>, etc.)
    if (/^<\/?(?:div|details|summary|section|article|aside|header|footer|figure|figcaption|blockquote|pre|ul|ol|li|hr|p|style|script)\b/i.test(trimmed)) {
      annotatedLines.push(line);
      continue;
    }

    // 9. Regular line / paragraph start
    if (trimmed.length > 0) {
      annotatedLines.push(`<span id="L${lineNum}" data-line="${lineNum}" class="line-anchor"></span>${line}`);
    } else {
      annotatedLines.push(line);
    }
  }

  // 3. Parse main body to HTML
  const annotated = annotatedLines.join('\n');
  setScanGates(annotated); // must gate on the exact string passed to marked.parse
  let html = marked.parse(annotated);
  // Normalize image srcs first, then sanitize last. Sanitizing after normalization
  // ensures any attributes rebuilt by normalizeImageSrcs (which preserves the
  // original tag's pre-/post-src attributes verbatim) are still stripped of
  // event handlers and dangerous elements in the final pass.
  html = normalizeImageSrcs(html, filePath);
  html = sanitizeDangerousTags(html);

  // 4. Convert Obsidian-style [[wikilinks]] on HTML output
  if (html.includes('[[')) {
    html = convertWikilinks(html);
  }

  // 4.5. Convert Obsidian Callouts ([!NOTE], [!WARNING], etc.)
  if (html.includes('[!')) {
    html = convertObsidianCallouts(html);
  }

  // 5. Process footnote references
  const refCounter = {};
  if (footnotes.length > 0) {
    html = html.replace(/\[\^([^\]]+)\]/g, (m, rawId) => {
      const id = rawId;
      if (!refCounter[id]) refCounter[id] = 0;
      refCounter[id]++;
      const safeId = escapeAttr(id);
      const safeLabel = escapeHtml(id);
      return `<a href="#fn-def-${safeId}" id="fn-ref-${safeId}-${refCounter[id]}" class="footnote-ref" title="註 ${safeLabel}">[${safeLabel}]</a>`;
    });

    // 6. Batch Process Footnotes (Single marked.parse Call)
    const FN_DELIM = '\n\n<!--FN_SPLIT_DELIMITER-->\n\n';
    const combinedFnText = footnotes.map(fn => fn.text.join('\n').trim()).join(FN_DELIM);
    setScanGates(combinedFnText); // same gates as the main body parse above
    let combinedFnHtml = marked.parse(combinedFnText).trim();
    combinedFnHtml = normalizeImageSrcs(combinedFnHtml, filePath);
    combinedFnHtml = sanitizeDangerousTags(combinedFnHtml);
    if (combinedFnHtml.includes('[[')) {
      combinedFnHtml = convertWikilinks(combinedFnHtml);
    }
    const fnRenderedArray = combinedFnHtml.split(/<!--FN_SPLIT_DELIMITER-->/i);

    let fhtml = '<div class="footnotes"><hr class="footnotes-divider"><ul class="footnotes-list">';
    footnotes.forEach((fn, idx) => {
      const id = fn.id;
      const safeId = escapeAttr(id);
      const safeLabel = escapeHtml(id);
      let fnRendered = (fnRenderedArray[idx] || '').trim();
      const count = refCounter[id] || 0;
      let bl = count === 1 ? ` <a href="#fn-ref-${safeId}-1" class="footnote-backlink" title="返回">↩</a>` : '';
      if (count > 1) {
        bl = ' ';
        for (let r = 1; r <= count; r++)
          bl += `<a href="#fn-ref-${safeId}-${r}" class="footnote-backlink" title="返回至第 ${r} 處">↩<sup>${r}</sup></a> `;
      }
      if (fnRendered.includes('</p>')) {
        const li = fnRendered.lastIndexOf('</p>');
        fnRendered = fnRendered.slice(0, li) + bl + fnRendered.slice(li);
      } else { fnRendered += bl; }
      fhtml += `<li class="footnote-item" id="fn-def-${safeId}" data-id="${safeId}"><span class="footnote-label">[${safeLabel}]</span><div class="footnote-item-content">${fnRendered}</div></li>`;
    });
    fhtml += '</ul></div>';
    fhtml = sanitizeDangerousTags(fhtml);
    html += fhtml;
  }

  return html;
}

function sanitizeDangerousTags(html) {
  if (!html) return '';
  return html
    // 1. Strip <script> entirely, including a bare/unclosed opening tag (in a
    //    real parser script-data state runs to EOF, so drop everything after it).
    .replace(/<script\b[^>]*>[\s\S]*?(?:<\/script\s*>|$)/gi, '')
    // 2. Strip a broad set of active/unsafe elements (opening + closing tags).
    //    Includes <svg>/<math> (mXSS vectors), <template>/<noscript>/<xmp>
    //    (parser-differential vectors) and <style>/<base>/<meta>/<link>/<form>
    //    which can exfiltrate or hijack the page.
    .replace(/<\/?(?:script|iframe|embed|object|frame|frameset|style|math|form|base|meta|link|svg|video|audio|source|applet|noscript|template|textarea|xmp|plaintext|noembed|noframes|portal|isindex|title)\b[^>]*>/gi, '')
    // 3. Strip inline event handlers regardless of what precedes `on*`. The
    //    original required whitespace, letting `<img/onerror=...>` (where `/`
    //    is a self-closing flag) slip through. `\b` also catches `data-on*`.
    .replace(/\bon[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '')
    // 4. srcdoc embeds a whole document; never allow it.
    .replace(/\bsrcdoc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '')
    // 5. Neutralize javascript:/vbscript:/data: pseudo-protocols in every
    //    URL-bearing attribute, decoding entities the way a browser would.
    .replace(/((?:xlink:)?href|src|action|formaction|poster|background|lowsrc|dynsrc|data|cite)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, (m, attr, val) => {
      const raw = /^["']/.test(val) ? val.slice(1, -1) : val;
      if (isDangerousUrl(raw, attr)) return attr + '="#"';
      return m;
    });
}

// Named character references a browser decodes inside attribute values that
// matter for spelling a URL scheme. Numeric references are accepted with or
// without the trailing ';', exactly as HTML parsers do.
const URL_NAMED_ENTITIES = {
  colon: ':', tab: '\t', newline: '\n', lpar: '(', rpar: ')', sol: '/', bsol: '\\',
  period: '.', comma: ',', semi: ';', excl: '!', quest: '?', num: '#', percnt: '%',
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0'
};

function decodeUrlEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => { const c = parseInt(h, 16); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ''; })
    .replace(/&#([0-9]+);?/g, (_, d) => { const c = parseInt(d, 10); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ''; })
    .replace(/&([a-z]+);/gi, (m, name) => {
      const v = URL_NAMED_ENTITIES[name.toLowerCase()];
      return v !== undefined ? v : m;
    });
}

function isDangerousUrl(rawValue, attr) {
  // Browsers ignore leading C0 controls/spaces and strip tab/CR/LF anywhere in
  // a URL before reading the scheme, so `\x01java\tscript:` is javascript:.
  const compact = decodeUrlEntities(rawValue).replace(/[\u0000-\u0020\u007f-\u009f\u00a0\u200b-\u200d\u2028\u2029\ufeff]+/g, '').toLowerCase();
  if (/^(?:javascript|vbscript|livescript|mocha):/.test(compact)) return true;
  if (compact.startsWith('data:')) {
    // Inline raster images are fine as <img src>; any other data: URL can
    // carry an HTML/SVG document.
    const a = String(attr).toLowerCase();
    return !(a === 'src' && /^data:image\/(?:png|jpe?g|gif|webp|bmp);/.test(compact));
  }
  return false;
}

/**
 * Convert Obsidian [[wikilinks]] in HTML output to <a> tags.
 * Fast exit if no [[ found. Skips matches inside <code>...</code> or <pre>...</pre> tags.
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
      if (pipeIdx === -1 && file === '' && display.startsWith('#')) {
        display = display.substring(1).trim();
      }
    }

    return `<a class="wikilink" data-wikilink-file="${escapeAttr(file)}" data-wikilink-anchor="${escapeAttr(anchor)}" href="#" title="${escapeAttr(target)}">${escapeHtml(display)}</a>`;
  });
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escapeAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const CALLOUT_ICONS = {
  quote: '”', cite: '”',
  note: 'ℹ', info: 'ℹ', todo: '☑',
  abstract: '📋', summary: '📋', tldr: '📋',
  tip: '💡', hint: '💡', important: '💡',
  success: '✓', check: '✓', done: '✓',
  question: '?', help: '?', faq: '?',
  warning: '⚠️', caution: '⚠️', attention: '⚠️',
  failure: '✕', fail: '✕', missing: '✕',
  danger: '⚡', error: '⚡',
  bug: '🪲',
  example: '🧪'
};

function convertObsidianCallouts(html) {
  if (!html || !html.includes('[!')) return html;

  let prevHtml;
  let iterations = 0;

  do {
    prevHtml = html;
    html = html.replace(/<blockquote>\s*(?:<p>)?\s*(?:(<span[^>]*class="line-anchor"[^>]*><\/span>)\s*)?\[!([a-zA-Z0-9_-]+)\]([+-])?(?:[ \t]+([^\n<]+))?(?:<\/p>)?([\s\S]*?)<\/blockquote>/gi, (match, lineAnchor = '', rawType, foldSign, customTitle, bodyContent) => {
      const type = rawType.toLowerCase();
      const icon = CALLOUT_ICONS[type] || 'ℹ';

      let titleText = customTitle ? customTitle.trim() : (type.charAt(0).toUpperCase() + type.slice(1));
      titleText = titleText.replace(/<\/p>$/i, '').trim();
      // Defense-in-depth: the capture above already excludes '<', but escape the
      // remaining HTML-significant characters before interpolating into markup.
      titleText = escapeHtml(titleText);

      let cleanBody = bodyContent ? bodyContent.trim() : '';

      // Strip leading <br> tags, leading/trailing empty <p> tags, and redundant line-anchor wrappers
      cleanBody = cleanBody
        .replace(/^(?:\s*<br\s*\/?>\s*)+/gi, '')
        .replace(/^(?:\s*<p>\s*(?:<span[^>]*class="line-anchor"[^>]*><\/span>|<br\s*\/?>|\s*)*<\/p>\s*)+/gi, (m) => {
          const anchors = m.match(/<span[^>]*class="line-anchor"[^>]*><\/span>/g);
          return anchors ? anchors.join('') : '';
        })
        .replace(/(?:\s*<p>\s*(?:<span[^>]*class="line-anchor"[^>]*><\/span>|<br\s*\/?>|\s*)*<\/p>\s*)+$/gi, (m) => {
          const anchors = m.match(/<span[^>]*class="line-anchor"[^>]*><\/span>/g);
          return anchors ? anchors.join('') : '';
        })
        .replace(/<p>\s*(?:<span[^>]*class="line-anchor"[^>]*><\/span>|\s*)*<\/p>/gi, (m) => {
          const anchors = m.match(/<span[^>]*class="line-anchor"[^>]*><\/span>/g);
          return anchors ? anchors.join('') : '';
        })
        .trim()
        .replace(/^(?:\s*<br\s*\/?>\s*)+/gi, '');

      const isFoldable = foldSign === '+' || foldSign === '-';
      const isExpanded = foldSign === '+';

      if (isFoldable) {
        return `${lineAnchor}<details class="callout" data-callout="${type}"${isExpanded ? ' open' : ''}>
  <summary class="callout-title">
    <span class="callout-icon">${icon}</span>
    <span class="callout-title-inner">${titleText}</span>
    <span class="callout-fold-icon">›</span>
  </summary>
  <div class="callout-content">${cleanBody}</div>
</details>`;
      } else {
        return `${lineAnchor}<div class="callout" data-callout="${type}">
  <div class="callout-title">
    <span class="callout-icon">${icon}</span>
    <span class="callout-title-inner">${titleText}</span>
  </div>
  <div class="callout-content">${cleanBody}</div>
</div>`;
      }
    });
    iterations++;
  } while (html !== prevHtml && iterations < 5 && html.includes('[!'));

  return html;
}
