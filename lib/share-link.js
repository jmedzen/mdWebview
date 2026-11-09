'use strict';
/**
 * lib/share-link.js — 經文某一行的短分享連結
 *
 *   <網站>/F<14 碼>[L<行>]    例：https://mbt.mahabodhi.co/F0cc8f84595a4c9L738
 *
 * 14 碼 = 經文路徑（相對於經文根目錄，NFC 正規化）的 53 位元雜湊（小寫十六進位）。
 * 整條連結只有英數字，貼進 LINE、Google Chat 等任何聊天軟體都不會被截斷，
 * 也不必把漢字、書名號、空格一個個編成 %XX（原本一條連結可以長到 250 字元）。
 * 不需要資料庫：伺服器用經文清單反查雜湊，找到就 302 轉到 /?file=…&line=…，
 * 找不到（檔案改名或刪除）回首頁。
 *
 * 雜湊（cyrb53）必須和 app.js 的 shareHash53() 逐字相同，兩邊才算得出同一個碼；
 * tests/test-share-link-short.test.js 會把兩份拿出來對照。改動請兩邊一起改。
 */

const CODE_LEN = 14;
const PATH_RE = /^\/F([0-9a-f]{14})(?:L(\d{1,7}))?\/?$/i;

/** cyrb53：53 位元、無需 BigInt 的字串雜湊（輸入以 UTF-16 碼元計）。 */
function hash53(str) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** 經文路徑 → 14 碼（小寫十六進位）。 */
function pathCode(relPath) {
  return hash53(String(relPath == null ? '' : relPath).normalize('NFC')).toString(16).padStart(CODE_LEN, '0');
}

/** 解析路徑 /F0cc8f84595a4c9L738 → { code(小寫), line(數字或 null) }；不符回 null。 */
function parsePath(pathname) {
  const m = PATH_RE.exec(String(pathname || ''));
  if (!m) return null;
  const line = m[2] ? parseInt(m[2], 10) : null;
  return { code: m[1].toLowerCase(), line: line && line > 0 ? line : null };
}

const indexCache = new WeakMap();

/**
 * 經文清單 [{ relPath }] → Map<碼, [路徑…]>。同一份清單只算一次。
 * 路徑一律以 NFC 計碼，macOS 的檔名是 NFD 也對得上。
 */
function indexFor(files) {
  let idx = indexCache.get(files);
  if (!idx) {
    idx = new Map();
    for (const f of files) {
      if (!f || !f.relPath) continue;
      const code = pathCode(f.relPath);
      const list = idx.get(code);
      if (list) list.push(f.relPath);
      else idx.set(code, [f.relPath]);
    }
    indexCache.set(files, idx);
  }
  return idx;
}

/** 反查：碼 → 經文路徑（取排序後第一個）；找不到回 null。 */
function resolve(files, code) {
  const hits = indexFor(files).get(String(code || '').toLowerCase());
  if (!hits || !hits.length) return null;
  return { path: hits.slice().sort()[0], ambiguous: hits.length > 1 };
}

module.exports = { CODE_LEN, hash53, pathCode, parsePath, indexFor, resolve };
