'use strict';
/**
 * lib/share-card-server.js — 每日經句分享卡（早安圖）的伺服器端
 *
 *   - 背景圖庫：pic-card/ 資料夾（遞迴讀取所有子目錄的 jpg / png / webp）
 *       位置：環境變數 PIC_CARD_DIR（相對路徑以 config.json 所在資料夾為準），
 *       沒設定時 = config.json 所在資料夾下的 pic-card/（Docker：/data/pic-card → 主機 ./data/pic-card）
 *   - 挑圖：以「經句代號＋日期」雜湊挑一張，同一天同一句大家拿到同一張，換一句就換圖
 *   - 畫圖：@napi-rs/canvas（沒裝或載入失敗時 available() = false，前端改用瀏覽器畫）
 *       繪圖程式與瀏覽器共用 ../share-card.js
 *   - 字型：宋體（Noto Serif TC）從下列資料夾載入 .ttf / .otf / .ttc：
 *       環境變數 SHARE_CARD_FONT_DIR、config.json 旁的 fonts/、程式目錄的 fonts/（Docker 建置時下載宋體）、vendor/fonts/（隨程式附的 Dancing Script）
 *   - 快取：解碼後的背景圖留 8 張、畫好的 JPEG 留 80 張（同樣參數的圖內容一定相同）
 */

const fs = require('fs');
const path = require('path');
const { CONFIG_PATH, APP_ROOT } = require('./constants');
const ShareCard = require('../share-card.js');

const PIC_EXT_RE = /\.(jpe?g|png|webp)$/i;
const FONT_EXT_RE = /\.(ttf|otf|ttc)$/i;
const SCAN_TTL_MS = 60000;
const MAX_DEPTH = 8;
const MAX_PICS = 5000;
const MAX_PIC_BYTES = 30 * 1024 * 1024;
const IMAGE_CACHE_MAX = 8;
const OUTPUT_CACHE_MAX = 80;
const JPEG_QUALITY = 88;

function configDir() {
  return path.dirname(path.resolve(CONFIG_PATH));
}

/** 背景圖資料夾的實際路徑。 */
function picDir(env = process.env) {
  const raw = String(env.PIC_CARD_DIR || '').trim();
  if (!raw) return path.join(configDir(), 'pic-card');
  return path.isAbsolute(raw) ? raw : path.resolve(configDir(), raw);
}

/** 找字型的資料夾（依序）。 */
function fontDirs(env = process.env) {
  const out = [];
  const raw = String(env.SHARE_CARD_FONT_DIR || '').trim();
  if (raw) out.push(path.isAbsolute(raw) ? raw : path.resolve(configDir(), raw));
  out.push(path.join(configDir(), 'fonts'));
  out.push(path.join(APP_ROOT, 'fonts'));
  out.push(path.join(APP_ROOT, 'vendor', 'fonts'));   // 隨程式附的手寫體（Dancing Script）
  return [...new Set(out)];
}

// ── 背景圖清單 ──────────────────────────────────────────────────────────
let picState = { dir: '', list: [], scannedAt: 0, exists: false };
let scanning = null;

async function scanPics(dir) {
  const list = [];
  let exists = false;
  async function walk(abs, rel, depth) {
    if (depth > MAX_DEPTH || list.length >= MAX_PICS) return;
    let entries;
    try { entries = await fs.promises.readdir(abs, { withFileTypes: true }); } catch (_) { return; }
    if (depth === 0) exists = true;
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      if (ent.name.startsWith('.') || list.length >= MAX_PICS) continue;
      const childAbs = path.join(abs, ent.name);
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) await walk(childAbs, childRel, depth + 1);
      else if (ent.isFile() && PIC_EXT_RE.test(ent.name)) list.push(childRel);
    }
  }
  await walk(dir, '', 0);
  return { dir, list, exists, scannedAt: Date.now() };
}

/** 圖庫清單（相對路徑，排序固定）。最多每分鐘重掃一次。 */
async function listPics(env = process.env) {
  const dir = picDir(env);
  if (picState.dir === dir && Date.now() - picState.scannedAt < SCAN_TTL_MS) return picState;
  if (!scanning) {
    scanning = scanPics(dir).then(s => { picState = s; return s; }).finally(() => { scanning = null; });
  }
  return scanning;
}

/** 依「經句代號＋日期」穩定地挑一張。沒有圖回 null。 */
function pickPic(list, verseId, ymd) {
  if (!Array.isArray(list) || !list.length) return null;
  return list[ShareCard.hash32(`${verseId}|${ymd}`) % list.length];
}

/** 相對路徑 → 絕對路徑；不在圖庫內、副檔名不對、隱藏檔都回 null。 */
function resolvePic(rel, env = process.env) {
  const s = String(rel || '');
  if (!s || s.includes('\0') || !PIC_EXT_RE.test(s)) return null;
  if (s.split(/[\\/]/).some(seg => seg.startsWith('.') || seg === '')) return null;
  const dir = path.resolve(picDir(env));
  const abs = path.resolve(dir, s);
  const relative = path.relative(dir, abs);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return abs;
}

/** 確認圖檔真的在圖庫內（擋 symlink 跑出去）。 */
async function isRealPicPath(abs, env = process.env) {
  try {
    const [realDir, realFile] = await Promise.all([
      fs.promises.realpath(picDir(env)),
      fs.promises.realpath(abs)
    ]);
    const relative = path.relative(realDir, realFile);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
    const st = await fs.promises.stat(realFile);
    return st.isFile() && st.size <= MAX_PIC_BYTES;
  } catch (_) {
    return false;
  }
}

// ── 畫圖引擎 ────────────────────────────────────────────────────────────
let canvasMod;      // undefined = 還沒試；null = 載入失敗
let canvasError = '';
let fontInfo = { loaded: [], serif: false };

function loadCanvas() {
  if (canvasMod !== undefined) return canvasMod;
  try {
    canvasMod = require('@napi-rs/canvas');
    registerFonts();
  } catch (err) {
    canvasMod = null;
    canvasError = err && err.message ? err.message.split('\n')[0] : String(err);
  }
  return canvasMod;
}

function registerFonts(env = process.env) {
  const { GlobalFonts } = canvasMod;
  const loaded = [];
  for (const dir of fontDirs(env)) {
    let names;
    try { names = fs.readdirSync(dir); } catch (_) { continue; }
    for (const name of names.sort()) {
      if (!FONT_EXT_RE.test(name) || name.startsWith('.')) continue;
      try {
        if (GlobalFonts.registerFromPath(path.join(dir, name))) loaded.push(path.join(dir, name));
      } catch (_) {}
    }
  }
  const families = (GlobalFonts.families || []).map(f => f.family);
  fontInfo = {
    loaded,
    serif: families.some(f => /Noto Serif (TC|CJK)|Source Han Serif|Songti/i.test(f))
  };
}

/** 能不能在伺服器畫圖。 */
function available() {
  return Boolean(loadCanvas());
}

function status(env = process.env) {
  const ok = available();
  return {
    renderer: ok,
    rendererError: ok ? '' : canvasError,
    fonts: fontInfo.loaded.map(p => path.basename(p)),
    serifFont: fontInfo.serif,
    fontDirs: fontDirs(env),
    picDir: picDir(env),
    picDirExists: picState.dir === picDir(env) ? picState.exists : null,
    picCount: picState.dir === picDir(env) ? picState.list.length : null
  };
}

// 小型 LRU（Map 依插入順序）
function lruGet(map, key) {
  if (!map.has(key)) return undefined;
  const v = map.get(key);
  map.delete(key);
  map.set(key, v);
  return v;
}
function lruSet(map, key, value, max) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
}

const imageCache = new Map();
const outputCache = new Map();
const pending = new Map();

async function loadPicImage(abs) {
  if (!abs) return null;
  let st;
  try { st = await fs.promises.stat(abs); } catch (_) { return null; }
  const key = `${abs}|${st.mtimeMs}|${st.size}`;
  const hit = lruGet(imageCache, key);
  if (hit) return hit;
  try {
    const img = await canvasMod.loadImage(await fs.promises.readFile(abs));
    lruSet(imageCache, key, img, IMAGE_CACHE_MAX);
    return img;
  } catch (_) {
    return null;
  }
}

/**
 * 畫一張卡，回傳 JPEG Buffer。
 * opts: { layout, size, verse: {text, source}, greeting, date, siteName, host, label, picAbs }
 */
async function render(opts) {
  if (!available()) throw new Error('share card renderer unavailable');
  const size = ShareCard.normalizeSize(opts.size);
  const layout = ShareCard.normalizeLayout(opts.layout);
  let picStamp = '';
  if (opts.picAbs) {
    try { const st = await fs.promises.stat(opts.picAbs); picStamp = `${opts.picAbs}|${st.mtimeMs}`; } catch (_) {}
  }
  const key = JSON.stringify([layout, size, opts.verse && opts.verse.text, opts.verse && opts.verse.source,
    opts.greeting, opts.date, opts.siteName, opts.host, opts.label || '', picStamp]);
  const hit = lruGet(outputCache, key);
  if (hit) return hit;
  if (pending.has(key)) return pending.get(key);
  const job = (async () => {
    const [w, h] = ShareCard.SIZES[size];
    const canvas = canvasMod.createCanvas(w, h);
    const ctx = canvas.getContext('2d');
    const image = picStamp ? await loadPicImage(opts.picAbs) : null;
    ShareCard.draw(ctx, { ...opts, layout, size, image });
    const buf = await canvas.encode('jpeg', JPEG_QUALITY);
    lruSet(outputCache, key, buf, OUTPUT_CACHE_MAX);
    return buf;
  })().finally(() => pending.delete(key));
  pending.set(key, job);
  return job;
}

function _resetForTests() {
  picState = { dir: '', list: [], scannedAt: 0, exists: false };
  imageCache.clear();
  outputCache.clear();
}

module.exports = {
  picDir,
  fontDirs,
  listPics,
  pickPic,
  resolvePic,
  isRealPicPath,
  available,
  status,
  render,
  _resetForTests
};
