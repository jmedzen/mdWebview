'use strict';
/**
 * lib/home.js — 首頁用的小工具（每日經文、辭典釋義摘要）
 *
 * 首頁不再用彈窗，改成：每日一句經文 → 繼續閱讀 → 一行公告 → 每日一詞（附釋義）＋今日推薦。
 * 這裡放伺服器端需要的純函式，方便單獨測試：
 *   - DEFAULT_DAILY_VERSES  後台沒設定過經句時使用的預設清單
 *   - parseVerses / versesToText  後台文字框（一行一句）⇄ 陣列
 *   - resolveVerses   依設定決定首頁要用哪一份清單
 *   - excerptFromMarkdown  把辭典條目的 Markdown 收成一小段純文字
 *   - readDictExcerpt  依 section index 的位元組位置讀出條目並摘要
 */

const fs = require('fs');

/**
 * 預設經句。文字依 CBETA 經文核對；出處只寫經名，不寫卷次，避免版本差異。
 * 管理員在後台改過（包括清空）之後就不再使用這份。
 */
const DEFAULT_DAILY_VERSES = Object.freeze([
  { text: '應無所住，而生其心。', source: '金剛般若波羅蜜經' },
  { text: '一切有為法，如夢幻泡影，如露亦如電，應作如是觀。', source: '金剛般若波羅蜜經' },
  { text: '色不異空，空不異色；色即是空，空即是色。', source: '般若波羅蜜多心經' },
  { text: '諸惡莫作，諸善奉行，自淨其意，是諸佛教。', source: '增壹阿含經' },
  { text: '心如工畫師，能畫諸世間。', source: '大方廣佛華嚴經' },
  { text: '若人欲了知，三世一切佛，應觀法界性，一切唯心造。', source: '大方廣佛華嚴經' },
  { text: '從是西方，過十萬億佛土，有世界名曰極樂。', source: '佛說阿彌陀經' }
].map(Object.freeze));

const MAX_VERSES = 366;
const MAX_TEXT = 200;
const MAX_SOURCE = 60;
const MAX_PATH = 300;

/** 去掉出處兩側使用者可能自己加的書名號，顯示時由前端統一加上。 */
function cleanSource(s) {
  return String(s || '').trim().replace(/^《+/, '').replace(/》+$/, '').trim().slice(0, MAX_SOURCE);
}

/**
 * 後台文字框 → 經句陣列。一行一句，格式：「經句｜出處｜經文路徑」，出處與路徑可省略。
 * 全形「｜」與半形「|」都接受。空行與 # 開頭的行略過。
 *
 * @param {string|Array} input 文字框內容，或已是陣列（匯入備份時）
 * @returns {{text:string, source:string, path:string}[]}
 */
function parseVerses(input) {
  if (Array.isArray(input)) {
    return input
      .map(v => (v && typeof v === 'object') ? v : { text: String(v || '') })
      .map(v => ({
        text: String(v.text || '').trim().slice(0, MAX_TEXT),
        source: cleanSource(v.source),
        path: String(v.path || '').trim().slice(0, MAX_PATH)
      }))
      .filter(v => v.text)
      .slice(0, MAX_VERSES);
  }
  const out = [];
  for (const raw of String(input || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/[｜|]/).map(s => s.trim());
    const text = (parts[0] || '').slice(0, MAX_TEXT);
    if (!text) continue;
    out.push({ text, source: cleanSource(parts[1]), path: (parts[2] || '').slice(0, MAX_PATH) });
    if (out.length >= MAX_VERSES) break;
  }
  return out;
}

/** 經句陣列 → 後台文字框內容（parseVerses 的反向）。 */
function versesToText(verses) {
  return (Array.isArray(verses) ? verses : [])
    .map(v => [v.text, v.source, v.path].map(s => String(s || '').trim()))
    .map(([t, s, p]) => p ? `${t}｜${s}｜${p}` : (s ? `${t}｜${s}` : t))
    .join('\n');
}

/**
 * 首頁實際使用的經句清單。從未設定（undefined）時用預設清單；
 * 管理員刻意清空（空陣列）時就是不顯示，不可偷偷補回預設。
 */
function resolveVerses(setting) {
  if (setting === undefined || setting === null) return DEFAULT_DAILY_VERSES.map(v => ({ ...v, path: '' }));
  return parseVerses(setting);
}

/**
 * 把一段 Markdown 收成純文字摘要：去掉標題列、連結、強調、HTML、註腳與多餘空白。
 *
 * @param {string} md       條目原文（通常第一行是詞條標題）
 * @param {number} [max=90] 最多幾個字（以字元計，CJK 一字一元）
 * @returns {string}
 */
function excerptFromMarkdown(md, max = 90) {
  let s = String(md || '');
  s = s.replace(/^﻿/, '');
  // 去掉所有標題列（辭典條目第一行就是詞條本身，首頁另外顯示）
  s = s.split(/\r?\n/).filter(line => !/^\s{0,3}#{1,6}\s/.test(line)).join('\n');
  s = s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\^[^\]]+\]/g, '')
    .replace(/^\s*>+\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~|==|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  return chars.slice(0, max).join('').replace(/[，、；：,;:\s]+$/, '') + '…';
}

/**
 * 依 section index 的位元組位置讀出辭典條目，回傳摘要。讀不到就回空字串，
 * 首頁只是少了釋義，不影響其他內容。
 *
 * @param {string} fullPath 辭典檔絕對路徑
 * @param {number} offset   條目起始位元組
 * @param {number} len      條目位元組長度
 * @param {number} [max=90]
 */
async function readDictExcerpt(fullPath, offset, len, max = 90) {
  if (!fullPath || !Number.isFinite(offset) || !Number.isFinite(len) || len <= 0) return '';
  // 摘要只要前幾十個字，條目再長也只讀前 4KB（UTF-8 中文約 1300 字）。
  const byteLen = Math.min(len, 4096);
  let fh;
  try {
    fh = await fs.promises.open(fullPath, 'r');
    const buf = Buffer.alloc(byteLen);
    const { bytesRead } = await fh.read(buf, 0, byteLen, offset);
    // 截在多位元組字元中間時，toString 會在尾端留下替代字元，一併去掉。
    const text = buf.subarray(0, bytesRead).toString('utf-8').replace(/�+$/, '');
    return excerptFromMarkdown(text, max);
  } catch (_) {
    return '';
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

module.exports = {
  DEFAULT_DAILY_VERSES,
  MAX_VERSES,
  parseVerses,
  versesToText,
  resolveVerses,
  excerptFromMarkdown,
  readDictExcerpt
};
