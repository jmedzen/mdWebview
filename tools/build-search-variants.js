#!/usr/bin/env node
/**
 * 產生 i18n/search-variants.js 的「字組」資料（搜尋用簡繁變體類別）。
 *
 * 簡體顯示用 vendor/opencc/t2cn.js 的 tw → cn 逐字轉換；搜尋若要與畫面一致，
 * 就必須用「同一張表」判斷哪些字算同一個字。做法：
 *
 *   1. 對 BMP 中 bigram 索引視為 CJK 的兩個區段（U+3400–U+4DBF、U+4E00–U+9FFF）
 *      逐字轉換 s = convert(t)；s ≠ t 時把 t 與 s 歸為同一組。
 *   2. 再併入 EXTRA_VARIANTS（OpenCC 不會輸出、但確為簡繁對應的字）。
 *   3. 以 union-find 取等價類，只保留兩字以上的組。
 *
 * 不收錄超出上述區段的字（Ext-B 以後的 astral 字、相容表意字）：索引的
 * bigram 抽取把這些字當作斷詞，若列入字組，含該字的檔案無法從索引找到。
 *
 * 用法：
 *   node tools/build-search-variants.js          重新產生並寫回 i18n/search-variants.js
 *   node tools/build-search-variants.js --check  只比對，不一致時以非零狀態結束
 *
 * OpenCC 升級後務必重跑；tests/test-search-variants.test.js 會檢查是否同步。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TARGET = path.join(ROOT, 'i18n', 'search-variants.js');
const BEGIN = '// @generated-begin';
const END = '// @generated-end';

/**
 * OpenCC tw → cn 不會產生、但確為簡繁對應的字（簡 → 繁）。
 * 來源是舊版搜尋框的 s2t.js（v3.10.x 以前），只留 bigram 區段內的字；
 * 語料中出現次數（2026-10 實測 md/ + dicts/）：縆 36、缐 3、迳 3、㳽 2、谘 1，
 * 其餘為 0，但都是 GB 簡化字，使用者可能直接輸入。
 */
const EXTRA_VARIANTS = [
  ['㓰', '劃'], ['㳽', '瀰'], ['䌽', '綵'], ['䙓', '襬'], ['䦆', '钁'], ['䩄', '靦'],
  ['侭', '儘'], ['渖', '瀋'], ['稆', '穭'], ['縆', '緪'], ['缐', '線'], ['讬', '託'],
  ['谘', '諮'], ['迳', '逕'], ['钜', '鉅'], ['锺', '鍾'], ['镟', '鏇']
];

function inIndexRange(ch) {
  if (typeof ch !== 'string' || ch.length !== 1) return false;
  const c = ch.charCodeAt(0);
  return (c >= 0x3400 && c <= 0x4DBF) || (c >= 0x4E00 && c <= 0x9FFF);
}

/**
 * @param {Function} [convert] - 逐字轉換函式，預設為 vendored OpenCC tw → cn
 * @returns {{ classes: string, simplified: string }}
 *   classes：以 | 分隔的字組，每組第一字為簡體字形，其餘依碼位排序。
 *   simplified：所有「簡體字形」（OpenCC 輸出與 EXTRA_VARIANTS 的簡字），依碼位排序。
 */
function buildVariantData(convert) {
  if (!convert) {
    const OpenCC = require(path.join(ROOT, 'vendor', 'opencc', 't2cn.js'));
    convert = OpenCC.Converter({ from: 'tw', to: 'cn' });
  }
  const parent = new Map();
  const find = (c) => {
    while (parent.get(c) !== c) {
      parent.set(c, parent.get(parent.get(c)));
      c = parent.get(c);
    }
    return c;
  };
  const union = (a, b) => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const simplified = new Set();
  for (let cp = 0x3400; cp <= 0x9FFF; cp++) {
    if (cp > 0x4DBF && cp < 0x4E00) continue;
    const t = String.fromCharCode(cp);
    const s = convert(t);
    if (s === t || !inIndexRange(s)) continue;
    union(t, s);
    simplified.add(s);
  }
  for (const [s, t] of EXTRA_VARIANTS) {
    if (!inIndexRange(s) || !inIndexRange(t)) throw new Error(`EXTRA_VARIANTS 超出索引區段：${s} → ${t}`);
    union(s, t);
    simplified.add(s);
  }

  const groups = new Map();
  for (const c of parent.keys()) {
    const r = find(c);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(c);
  }
  const byCode = (a, b) => a.charCodeAt(0) - b.charCodeAt(0);
  const classes = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    members.sort((a, b) => {
      const sa = simplified.has(a), sb = simplified.has(b);
      if (sa !== sb) return sa ? -1 : 1;
      return byCode(a, b);
    });
    classes.push(members.join(''));
  }
  classes.sort((a, b) => byCode(a, b));
  return { classes: classes.join('|'), simplified: Array.from(simplified).sort(byCode).join('') };
}

function renderBlock(data) {
  return [
    BEGIN,
    '  // 由 tools/build-search-variants.js 產生，請勿手動修改。',
    `  const CLASSES = '${data.classes}';`,
    `  const SIMPLIFIED = '${data.simplified}';`,
    '  ' + END
  ].join('\n');
}

function readCurrentBlock(src) {
  const a = src.indexOf(BEGIN);
  const b = src.indexOf(END);
  if (a < 0 || b < 0 || b < a) throw new Error(`${TARGET} 缺少 ${BEGIN} / ${END} 標記`);
  return { start: a, end: b + END.length, text: src.slice(a, b + END.length) };
}

if (require.main === module) {
  const src = fs.readFileSync(TARGET, 'utf8');
  const cur = readCurrentBlock(src);
  const next = renderBlock(buildVariantData());
  if (process.argv.includes('--check')) {
    if (cur.text !== next) {
      console.error('i18n/search-variants.js 與 vendored OpenCC 不一致，請執行 node tools/build-search-variants.js');
      process.exit(1);
    }
    console.log('i18n/search-variants.js 已同步');
  } else if (cur.text === next) {
    console.log('i18n/search-variants.js 無變更');
  } else {
    fs.writeFileSync(TARGET, src.slice(0, cur.start) + next + src.slice(cur.end));
    console.log('已更新 i18n/search-variants.js');
  }
}

module.exports = { buildVariantData, renderBlock, readCurrentBlock, EXTRA_VARIANTS, TARGET };
