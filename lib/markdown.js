/**
 * @file lib/markdown.js — Markdown 與 Frontmatter 文本處理模組
 *
 * 提供 YAML Frontmatter 快速剝離、metadata 解析與行號偏移 (lineOffset) 計算。
 * 純 CommonJS 模組，無外部依賴，可供主執行緒、Worker 與測試直接引用。
 */
'use strict';

/**
 * 剝離 Markdown 文字開頭的 YAML frontmatter，解析鍵值對並計算剝離的行號偏移。
 *
 * @param {string} text - 原始 Markdown 字串
 * @returns {{ body: string, frontmatter: Object, lineOffset: number }}
 *   - body: 剝離 frontmatter 後的正文
 *   - frontmatter: 解析出的 key-value 物件
 *   - lineOffset: 被移除的前綴所包含的換行數（\n 的數量）
 */
function stripFrontmatter(text) {
  if (!text || typeof text !== 'string') {
    return { body: '', frontmatter: {}, lineOffset: 0 };
  }

  const isLf = text.startsWith('---\n');
  const isCrlf = text.startsWith('---\r\n');
  if (!isLf && !isCrlf) {
    return { body: text, frontmatter: {}, lineOffset: 0 };
  }

  const startOffset = isCrlf ? 5 : 4;
  const endMarker = isCrlf ? '\r\n---' : '\n---';
  const endFmIndex = text.indexOf(endMarker, startOffset);

  if (endFmIndex === -1) {
    return { body: text, frontmatter: {}, lineOffset: 0 };
  }

  const frontmatter = {};
  const fmText = text.substring(startOffset, endFmIndex);
  const fmLines = fmText.split(/\r?\n/);
  for (let i = 0; i < fmLines.length; i++) {
    const l = fmLines[i];
    const idx = l.indexOf(':');
    if (idx !== -1) {
      const k = l.substring(0, idx).trim();
      let v = l.substring(idx + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (k) frontmatter[k] = v;
    }
  }

  const contentStart = endFmIndex + (isCrlf ? 5 : 4);
  const nextNL = text.indexOf('\n', contentStart);
  const bodyIndex = nextNL !== -1 ? nextNL + 1 : contentStart;

  const strippedPrefix = text.substring(0, bodyIndex);
  let lineOffset = 0;
  for (let i = 0; i < strippedPrefix.length; i++) {
    if (strippedPrefix.charCodeAt(i) === 10) { // '\n'
      lineOffset++;
    }
  }

  const body = text.substring(bodyIndex);
  return { body, frontmatter, lineOffset };
}

module.exports = {
  stripFrontmatter
};
