'use strict';
/**
 * lib/sutra-quotes.js — 每日經文的「資料夾來源」
 *
 * 每日經文有兩個來源，合併後去重：
 *   1. 後台「推薦閱讀 → 每日經文」文字框（config.settings.suggestList.dailyVerses）
 *   2. sutra-quote/ 資料夾裡所有 .md 檔（這個模組）
 *
 * 資料夾位置：
 *   - 環境變數 SUTRA_QUOTE_DIR（絕對路徑；相對路徑以 config.json 所在資料夾為準）
 *   - 沒設定時 = config.json 所在資料夾下的 sutra-quote/
 *     （Docker 預設 CONFIG_PATH=/data/config.json → /data/sutra-quote → 主機的 ./data/sutra-quote）
 *
 * 檔案格式：一行一句「經句｜出處｜經文路徑」，只認全形「｜」（出處、路徑可省略），
 * 標題、空行與其他行略過。解析規則見 lib/home.js parseQuoteMarkdown。
 *
 * 快取：每次讀取最多每 10 秒重新掃一次資料夾，只有檔案的修改時間或大小變了才重新解析。
 */

const fs = require('fs');
const path = require('path');
const { CONFIG_PATH } = require('./constants');
const { parseQuoteMarkdown, mergeVerses } = require('./home');

const SCAN_TTL_MS = 10000;
const MAX_DEPTH = 4;
const MAX_FILES = 500;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_FOLDER_VERSES = 20000;

/** 資料夾的實際路徑。 */
function quoteDir(env = process.env) {
  const base = path.dirname(path.resolve(CONFIG_PATH));
  const raw = String(env.SUTRA_QUOTE_DIR || '').trim();
  if (!raw) return path.join(base, 'sutra-quote');
  return path.isAbsolute(raw) ? raw : path.resolve(base, raw);
}

/** 遞迴列出 .md 檔（略過 . 開頭的檔案與資料夾），依相對路徑排序，結果穩定。 */
async function listMarkdown(dir) {
  const out = [];
  async function walk(abs, rel, depth) {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
    let entries;
    try { entries = await fs.promises.readdir(abs, { withFileTypes: true }); } catch (_) { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
    for (const ent of entries) {
      if (ent.name.startsWith('.') || out.length >= MAX_FILES) continue;
      const childAbs = path.join(abs, ent.name);
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) await walk(childAbs, childRel, depth + 1);
      else if (ent.isFile() && /\.md$/i.test(ent.name)) out.push({ abs: childAbs, rel: childRel });
    }
  }
  await walk(dir, '', 0);
  return out;
}

function emptyState(dir) {
  return { dir, exists: false, files: [], verses: [], count: 0, errors: [], scannedAt: 0 };
}

let cache = null;          // 上一次的結果
let fileCache = new Map(); // abs → { mtimeMs, size, verses }
let pending = null;

async function scan(dir) {
  let st;
  try { st = await fs.promises.stat(dir); } catch (_) { st = null; }
  if (!st || !st.isDirectory()) {
    fileCache = new Map();
    return { ...emptyState(dir), scannedAt: Date.now() };
  }
  const files = await listMarkdown(dir);
  const next = new Map();
  const errors = [];
  const perFile = [];
  let all = [];
  for (const f of files) {
    let fst;
    try { fst = await fs.promises.stat(f.abs); } catch (err) { errors.push({ file: f.rel, error: err.code || err.message }); continue; }
    const old = fileCache.get(f.abs);
    let verses;
    if (old && old.mtimeMs === fst.mtimeMs && old.size === fst.size) {
      verses = old.verses;
    } else if (fst.size > MAX_FILE_BYTES) {
      errors.push({ file: f.rel, error: 'too-large' });
      verses = [];
    } else {
      try {
        verses = parseQuoteMarkdown(await fs.promises.readFile(f.abs, 'utf-8'), MAX_FOLDER_VERSES);
      } catch (err) {
        errors.push({ file: f.rel, error: err.code || err.message });
        continue;
      }
    }
    next.set(f.abs, { mtimeMs: fst.mtimeMs, size: fst.size, verses });
    perFile.push({ file: f.rel, count: verses.length });
    if (all.length < MAX_FOLDER_VERSES) all = all.concat(verses.slice(0, MAX_FOLDER_VERSES - all.length));
  }
  fileCache = next;
  const verses = mergeVerses(all);
  return { dir, exists: true, files: perFile, verses, count: verses.length, errors, scannedAt: Date.now() };
}

/**
 * 取得資料夾來源的經句（含快取）。
 * @param {{force?:boolean, dir?:string}} [opts]
 * @returns {Promise<{dir:string, exists:boolean, files:{file:string,count:number}[], verses:object[], count:number, errors:object[], scannedAt:number}>}
 */
async function getFolderVerses(opts = {}) {
  const dir = opts.dir || quoteDir();
  if (!opts.force && cache && cache.dir === dir && Date.now() - cache.scannedAt < SCAN_TTL_MS) return cache;
  if (pending && !opts.force) return pending;
  if (cache && cache.dir !== dir) fileCache = new Map();
  pending = scan(dir)
    .then(r => { cache = r; return r; })
    .catch(() => (cache = { ...emptyState(dir), scannedAt: Date.now() }))
    .finally(() => { pending = null; });
  return pending;
}

/** 測試用：清掉快取。 */
function resetCache() {
  cache = null;
  fileCache = new Map();
  pending = null;
}

module.exports = {
  quoteDir,
  getFolderVerses,
  resetCache,
  MAX_FOLDER_VERSES
};
