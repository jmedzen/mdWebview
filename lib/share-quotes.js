'use strict';
/**
 * lib/share-quotes.js — 選字製作的早安圖（選句）
 *
 * 登入的讀者在經文裡選一段字，從選字彈窗「⋯ 更多 → 製作早安圖」做成早安圖。
 *
 * 安全設計：公開的圖片網址、預覽網址與分享連結只帶選句代號（q=<id>），
 * 不帶文字，所以沒有人能透過本站網址畫出任意文字。代號只能由登入的使用者
 * 建立（POST /api/share-card/quote），而且伺服器會到經文原檔核對這段字：
 *   - 只比對「字」（\p{L}\p{N}），標點、空白、Markdown 記號都忽略；
 *   - 簡繁字組視為同一字（i18n/search-variants.js 的 fold），簡體顯示時選的字也對得上；
 *   - 卡片上的文字一律取自原檔（含原檔的標點），不是使用者送來的字串，
 *     因此夾帶任何原文沒有的字都會被拒絕或不會出現在卡片上。
 *
 * 本檔只放純函式（擷取、正規化、出處名稱），資料庫存取在 lib/db.js，
 * HTTP 處理在 server.js。
 */

const searchVariants = require('../i18n/search-variants');

/** 卡片上文字的字數上限與下限（不含空白；標點算在內）。超過 60 字有些版型會擠爆。 */
const MAX_CHARS = 60;
const MIN_CHARS = 2;
/** 送來的選取文字長度上限（選太長直接拒絕，不做比對）。 */
const MAX_INPUT_CHARS = 400;
/** 以選取起點行號為準，往前／往後找幾行。 */
const WINDOW_BEFORE = 3;
const WINDOW_AFTER = 40;
/** 每人配額（管理員不限）。 */
const QUOTA_PER_HOUR = 30;
const QUOTA_PER_DAY = 200;

const KEY_CHAR_RE = /[\p{L}\p{N}]/u;
const HAN_RE = /\p{Script=Han}/u;
const ASCII_DIGIT_RE = /[0-9]/;
// 卡片上不要引號（「」『』“”‘’﹁﹂﹃﹄）：選句常從對話中間截出來，留著會只剩半邊。
const QUOTE_MARK_RE = /[「」『』“”‘’﹁﹂﹃﹄"]/g;
// 選句後面緊接的句末標點可以帶上（最多一個）
const END_PUNCT_RE = /[，。；：、！？,.;:!?…]/;
const CLOSE_MARK_RE = /[」』”’﹂﹄)）】》〉]/;

/**
 * 一行 Markdown → 純文字（長度可以改變，所以以「行」為單位處理，行數不變）。
 * 去掉 HTML 標籤、註腳標記、圖片、連結網址、強調記號、標題／引言／清單符號、表格線。
 */
function cleanMarkdownLine(line) {
  let s = String(line || '');
  s = s.replace(/<!--.*?-->/g, '');
  s = s.replace(/<[^>]{0,200}>/g, '');
  s = s.replace(/\[\^[^\]]{0,40}\]:?/g, '');           // 註腳 [^1]、[^1]:
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '');          // 圖片
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');       // 連結 → 文字
  s = s.replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2');// wikilink
  s = s.replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)+/, '');
  s = s.replace(/[*_`~=]{1,3}/g, '');
  s = s.replace(/\|/g, ' ');
  return s;
}

/**
 * 建比對用的鍵：只留下字（\p{L}\p{N}），簡繁字組 fold 成同一字。
 * 回傳 { key, starts, ends }：key 的每個 UTF-16 位置對應到原字串的 [start, end)。
 */
function buildKey(text, { hanOnly = false, dropDigits = false } = {}) {
  const fold = searchVariants && typeof searchVariants.fold === 'function' ? searchVariants.fold : (x => x);
  let key = '';
  const starts = [];
  const ends = [];
  let i = 0;
  for (const ch of String(text || '')) {
    const len = ch.length;
    const keep = KEY_CHAR_RE.test(ch) && (!hanOnly || HAN_RE.test(ch)) && !(dropDigits && ASCII_DIGIT_RE.test(ch));
    if (keep) {
      const k = fold(ch.toLowerCase());
      for (let u = 0; u < k.length; u++) { starts.push(i); ends.push(i + len); }
      key += k;
    }
    i += len;
  }
  return { key, starts, ends };
}

/** 卡片上文字的字數（不含空白）。 */
function cardLength(text) {
  return Array.from(String(text || '').replace(/\s+/g, '')).length;
}

/** 擷取出來的原文整理成卡片文字：拿掉引號、合併換行與多餘空白（中文字之間的空白直接拿掉）。 */
function tidyCardText(raw) {
  let s = String(raw || '').replace(QUOTE_MARK_RE, '');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/(?<=[^\x00-\x7f]) (?=[^\x00-\x7f])/g, '');
  return s;
}

/**
 * 在 sourceText 裡找 selected 這段字，回傳原文擷取結果或 null。
 * 先比對全部的字；對不上再改用「只比對漢字」與「忽略阿拉伯數字」（選到註腳號碼時）。
 * @returns {{ text: string, start: number, end: number } | null}
 */
function locate(sourceText, selected) {
  const selHasHan = HAN_RE.test(String(selected || ''));
  const tries = [{}, { dropDigits: true }];
  if (selHasHan) tries.push({ hanOnly: true });
  for (const opt of tries) {
    const sel = buildKey(selected, opt).key;
    if (Array.from(sel).length < MIN_CHARS) continue;
    const src = buildKey(sourceText, opt);
    const idx = src.key.indexOf(sel);
    if (idx < 0) continue;
    const start = src.starts[idx];
    let end = src.ends[idx + sel.length - 1];
    // 帶上緊接的收尾引號與一個句末標點
    const rest = sourceText.slice(end, end + 6);
    let j = 0;
    const chars = Array.from(rest);
    while (j < chars.length && CLOSE_MARK_RE.test(chars[j])) j++;
    if (j < chars.length && END_PUNCT_RE.test(chars[j])) j++;
    end += chars.slice(0, j).join('').length;
    return { text: sourceText.slice(start, end), start, end };
  }
  return null;
}

/**
 * 從整份 Markdown 原文擷取選句。先在行號附近找，找不到再找全文。
 * @param {string} markdown 原檔內容
 * @param {string} selected 讀者選取的文字
 * @param {number|null} line 選取起點的行號（1 起算）
 * @returns {{ ok: true, text: string, line: number } | { ok: false, code: string }}
 */
function extractQuote(markdown, selected, line) {
  const sel = String(selected || '');
  if (!sel.trim()) return { ok: false, code: 'EMPTY' };
  if (Array.from(sel).length > MAX_INPUT_CHARS) return { ok: false, code: 'TOO_LONG' };
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const tryRange = (from, to) => {
    const slice = lines.slice(from, to).map(cleanMarkdownLine).join('\n');
    const hit = locate(slice, sel);
    if (!hit) return null;
    const lineNo = from + 1 + (slice.slice(0, hit.start).match(/\n/g) || []).length;
    return { text: tidyCardText(hit.text), line: lineNo };
  };
  let hit = null;
  const n = Number(line);
  if (Number.isInteger(n) && n >= 1) {
    hit = tryRange(Math.max(0, n - 1 - WINDOW_BEFORE), Math.min(lines.length, n - 1 + WINDOW_AFTER));
  }
  if (!hit) hit = tryRange(0, lines.length);
  if (!hit) return { ok: false, code: 'NOT_IN_SOURCE' };
  const len = cardLength(hit.text);
  if (len > MAX_CHARS) return { ok: false, code: 'TOO_LONG', length: len };
  if (len < MIN_CHARS) return { ok: false, code: 'TOO_SHORT' };
  return { ok: true, text: hit.text, line: hit.line };
}

/** 比對／去重用的鍵（只看字，簡繁合一）。 */
function textKey(text) {
  return buildKey(text).key;
}

/**
 * 卡片上的出處：檔名去掉 .md 與開頭的經號（T0235、X1234 之類），
 * 去掉後若只剩非漢字就保留原名。辭典路徑 dict:… 一樣取檔名。
 */
function sourceTitle(filePath) {
  let name = String(filePath || '').replace(/^dict:/, '').split('/').pop() || '';
  name = name.replace(/\.md$/i, '').trim();
  const stripped = name.replace(/^[A-Za-z]{0,4}\d[\w.-]*[\s_]+/, '').trim();
  if (stripped && HAN_RE.test(stripped)) name = stripped;
  return name.replace(/^《|》$/g, '').slice(0, 60);
}

/** 選句代號：10 位十六進位（與每日經句代號同格式，前端與統計共用驗證）。 */
const ID_RE = /^[0-9a-f]{10}$/;

module.exports = {
  MAX_CHARS,
  MIN_CHARS,
  MAX_INPUT_CHARS,
  QUOTA_PER_HOUR,
  QUOTA_PER_DAY,
  ID_RE,
  cleanMarkdownLine,
  buildKey,
  cardLength,
  tidyCardText,
  locate,
  extractQuote,
  textKey,
  sourceTitle
};
