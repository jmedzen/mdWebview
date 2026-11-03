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
 *   - 快取：畫好的 JPEG 在記憶體留 80 張（同樣參數的圖內容一定相同），磁碟上另存一份（cacheDir()/out，
 *     預設上限 200 MB，重開機後也能用）；解碼後的背景圖留 8 張，同一張圖同時有好幾個請求
 *     （面板一次要 8 個版型）時只解碼一次；大背景圖先縮一份存在 cacheDir()/bg（見 lib/share-card-draw.js）
 *   - 畫圖在工作執行緒（lib/share-card-render-worker.js），不卡住網站其他請求（v4.24.0）
 *   - 預覽：opts.preview = 分享面板裡的小預覽（ShareCard.PREVIEW_PIXELS，JPEG 品質 80）
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const { CONFIG_PATH, APP_ROOT, INDEX_DIR } = require('./constants');
const ShareCard = require('../share-card.js');
const { createDrawer, writeAtomic, lruGet, lruSet } = require('./share-card-draw');

const PIC_EXT_RE = /\.(jpe?g|png|webp)$/i;
const FONT_EXT_RE = /\.(ttf|otf|ttc)$/i;
const SCAN_TTL_MS = 60000;
const MAX_DEPTH = 8;
const MAX_PICS = 5000;
const MAX_PIC_BYTES = 30 * 1024 * 1024;
const OUTPUT_CACHE_MAX = 80;
const DEFAULT_OUT_CACHE_MB = 200;

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
    picCount: picState.dir === picDir(env) ? picState.list.length : null,
    ...cacheStatus(env)
  };
}

const outputCache = new Map();
const pending = new Map();
let localDrawer = null;           // 工作執行緒不能用時，在主執行緒畫

// ── 磁碟快取（v4.24.0）──────────────────────────────────────────────────
//   <快取資料夾>/bg/  背景圖縮圖（每張原圖一份，約 1 MB）
//   <快取資料夾>/out/ 畫好的 JPEG（依全部參數雜湊命名；總量超過上限時從最久沒用的刪起）
// 快取資料夾 = SHARE_CARD_CACHE_DIR，沒設定時 = INDEX_DIR/share-card（Docker：/data/index/share-card）。

/** 快取資料夾；SHARE_CARD_CACHE_DIR=off 關掉磁碟快取（回空字串）。 */
function cacheDir(env = process.env) {
  const raw = String(env.SHARE_CARD_CACHE_DIR || '').trim();
  if (/^(off|0|false|none)$/i.test(raw)) return '';
  if (!raw) return path.join(INDEX_DIR, 'share-card');
  return path.isAbsolute(raw) ? raw : path.resolve(configDir(), raw);
}

/** 成品快取的上限（位元組）：SHARE_CARD_CACHE_MB，預設 200 MB。 */
function outCacheLimit(env = process.env) {
  const mb = Number(env.SHARE_CARD_CACHE_MB);
  return Math.round((Number.isFinite(mb) && mb >= 0 ? mb : DEFAULT_OUT_CACHE_MB) * 1024 * 1024);
}

const disk = { dir: '', bytes: -1, pruning: null, hits: 0, writes: 0, pruned: 0 };

/** 畫圖程式或字型一改，舊的成品就不能用：這個版本號放進成品檔名的雜湊裡。 */
let rendererStamp = '';
function getRendererStamp() {
  if (rendererStamp) return rendererStamp;
  const h = crypto.createHash('sha1');
  try { h.update(fs.readFileSync(require.resolve('../share-card.js'))); } catch (_) {}
  for (const f of fontInfo.loaded) {
    let size = 0;
    try { size = fs.statSync(f).size; } catch (_) {}
    h.update(`|${path.basename(f)}:${size}`);
  }
  rendererStamp = h.digest('hex').slice(0, 12);
  return rendererStamp;
}

function outFile(dir, key) {
  const h = crypto.createHash('sha1').update(`${getRendererStamp()}|${key}`).digest('hex');
  return path.join(dir, 'out', h.slice(0, 2), `${h.slice(2, 32)}.jpg`);
}

async function listOutFiles(dir) {
  const out = [];
  let subs;
  try { subs = await fs.promises.readdir(path.join(dir, 'out'), { withFileTypes: true }); } catch (_) { return out; }
  for (const sub of subs) {
    if (!sub.isDirectory()) continue;
    const subAbs = path.join(dir, 'out', sub.name);
    let names;
    try { names = await fs.promises.readdir(subAbs); } catch (_) { continue; }
    for (const name of names) {
      const abs = path.join(subAbs, name);
      try {
        const st = await fs.promises.stat(abs);
        if (!st.isFile()) continue;
        // 寫到一半中斷留下的暫存檔
        if (name.endsWith('.tmp')) { if (Date.now() - st.mtimeMs > 60000) await fs.promises.unlink(abs).catch(() => {}); continue; }
        out.push({ abs, size: st.size, mtime: st.mtimeMs });
      } catch (_) {}
    }
  }
  return out;
}

/** 成品總量超過上限時，從最久沒用的刪到上限的 80%。 */
function pruneOutCache(dir, env = process.env) {
  if (disk.pruning) return disk.pruning;
  disk.pruning = (async () => {
    const limit = outCacheLimit(env);
    const files = await listOutFiles(dir);
    let total = files.reduce((n, f) => n + f.size, 0);
    if (total > limit) {
      files.sort((a, b) => a.mtime - b.mtime);
      const target = Math.floor(limit * 0.8);
      for (const f of files) {
        if (total <= target) break;
        try { await fs.promises.unlink(f.abs); total -= f.size; disk.pruned++; } catch (_) {}
      }
    }
    if (disk.dir === dir) disk.bytes = total;
  })().catch(() => {}).finally(() => { disk.pruning = null; });
  return disk.pruning;
}

async function diskRead(dir, key) {
  const file = outFile(dir, key);
  try {
    const buf = await fs.promises.readFile(file);
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    disk.hits++;
    // 記下「最近用過」，清理時留著它
    const now = new Date();
    fs.promises.utimes(file, now, now).catch(() => {});
    return buf;
  } catch (_) {
    return null;
  }
}

async function diskWrite(dir, key, buf, env = process.env) {
  if (outCacheLimit(env) <= 0) return;
  try {
    await writeAtomic(outFile(dir, key), buf);
    disk.writes++;
    if (disk.dir !== dir) { disk.dir = dir; disk.bytes = -1; }
    if (disk.bytes < 0) await pruneOutCache(dir, env);
    else {
      disk.bytes += buf.length;
      if (disk.bytes > outCacheLimit(env)) await pruneOutCache(dir, env);
    }
  } catch (_) { /* 磁碟滿或不能寫：照樣回圖，只是沒存 */ }
}

// ── 畫圖工作執行緒（v4.24.0）────────────────────────────────────────────
// SHARE_CARD_WORKER=0 關掉（全部在主執行緒畫）。執行緒死掉時下一張自動重開；連續開不起來 3 次就改在主執行緒畫。
const ZERO_STATS = { decodes: 0, variantsMade: 0, variantHits: 0 };
// stats = 目前這個執行緒回報的累計；base = 之前（已關掉的）執行緒的累計
const worker = { w: null, seq: 0, jobs: new Map(), failures: 0, stats: { ...ZERO_STATS }, base: { ...ZERO_STATS }, rendered: 0 };

/** 執行緒要換掉了：把它的計數併進 base。 */
function retireWorkerStats() {
  for (const k of Object.keys(ZERO_STATS)) worker.base[k] += worker.stats[k] || 0;
  worker.stats = { ...ZERO_STATS };
}

function statSum(k) {
  return worker.base[k] + (worker.stats[k] || 0) + (localDrawer ? localDrawer.stats[k] : 0);
}
const WORKER_MAX_FAILURES = 3;

function workerEnabled(env = process.env) {
  return !/^(0|off|false|no)$/i.test(String(env.SHARE_CARD_WORKER || '').trim()) && worker.failures < WORKER_MAX_FAILURES;
}

function failWorkerJobs(err) {
  for (const { reject } of worker.jobs.values()) reject(err);
  worker.jobs.clear();
}

function getWorker() {
  if (worker.w) return worker.w;
  const w = new Worker(path.join(__dirname, 'share-card-render-worker.js'));
  w.unref();   // 沒有工作時不擋住行程結束（測試、關機）
  w.on('message', (msg) => {
    if (msg && msg.stats) worker.stats = msg.stats;
    const job = worker.jobs.get(msg && msg.id);
    if (!job) return;
    worker.jobs.delete(msg.id);
    if (worker.jobs.size === 0) w.unref();
    if (msg.ok) { worker.failures = 0; job.resolve(msg); } else job.reject(new Error(msg.error || 'share card worker failed'));
  });
  const onDead = (err) => {
    if (worker.w !== w) return;
    worker.w = null;
    worker.failures++;
    retireWorkerStats();
    failWorkerJobs(err instanceof Error ? err : new Error(`share card worker exited (${err})`));
  };
  w.on('error', onDead);
  w.on('exit', (code) => onDead(code));
  worker.w = w;
  return w;
}

function callWorker(payload) {
  return new Promise((resolve, reject) => {
    let w;
    try { w = getWorker(); } catch (err) { worker.failures++; reject(err); return; }
    const id = ++worker.seq;
    worker.jobs.set(id, { resolve, reject });
    w.ref();
    w.postMessage({ id, ...payload });
  });
}

/** 畫一張（工作執行緒優先，不行就在主執行緒）。回傳 { buf, decode, draw, encode, thread }。 */
async function drawCard(job) {
  if (workerEnabled()) {
    try {
      const r = await callWorker({ job });
      worker.rendered++;
      return { buf: Buffer.from(r.buf), decode: r.decode, draw: r.draw, encode: r.encode, thread: 'worker' };
    } catch (err) {
      if (workerEnabled()) throw err;   // 執行緒還能用：是這張本身畫不出來
    }
  }
  if (!localDrawer) localDrawer = createDrawer(canvasMod);
  const r = await localDrawer.draw(job);
  return { ...r, thread: 'main' };
}

/** 背景圖實際解碼的次數（工作執行緒＋主執行緒）。 */
function decodeCount() {
  return statSum('decodes');
}

/**
 * 畫一張卡，回傳 JPEG Buffer。
 * opts: { layout, size, preview, verse: {text, source}, greeting, date, siteName, host, label, qr, picAbs }
 * qr = QR 碼短網址（只畫在直式）；直式輸出 1620×2025（ShareCard.PIXEL_SIZES）。
 * preview = true 時（只對直式）輸出分享面板用的小預覽 ShareCard.PREVIEW_PIXELS。
 * 依序找：記憶體快取 → 正在畫的同一張 → 磁碟快取 → 畫（工作執行緒）並存到磁碟。
 * timing（可省略）會填上 { cache: 'hit'|'shared'|'disk'|'miss', decode, draw, encode, thread }（毫秒），給 Server-Timing 標頭用。
 */
async function render(opts, timing) {
  if (!available()) throw new Error('share card renderer unavailable');
  const size = ShareCard.normalizeSize(opts.size);
  const layout = ShareCard.normalizeLayout(opts.layout);
  const preview = Boolean(opts.preview) && size === 'portrait';
  const t = timing || {};
  t.cache = 'hit';
  let picStamp = '';
  if (opts.picAbs) {
    try { const st = await fs.promises.stat(opts.picAbs); picStamp = `${opts.picAbs}|${st.mtimeMs}|${st.size}`; } catch (_) {}
  }
  const key = JSON.stringify([layout, size, preview, opts.verse && opts.verse.text, opts.verse && opts.verse.source,
    opts.greeting, opts.date, opts.siteName, opts.host, opts.label || '', opts.qr || '', picStamp]);
  const hit = lruGet(outputCache, key);
  if (hit) return hit;
  if (pending.has(key)) { t.cache = 'shared'; return pending.get(key); }
  const dir = cacheDir();
  const job = (async () => {
    if (dir) {
      const t0 = Date.now();
      const saved = await diskRead(dir, key);
      if (saved) {
        t.cache = 'disk';
        t.read = Date.now() - t0;
        lruSet(outputCache, key, saved, OUTPUT_CACHE_MAX);
        return saved;
      }
    }
    t.cache = 'miss';
    const { picAbs, preview: _p, ...rest } = opts;
    const r = await drawCard({
      opts: { ...rest, layout, size },
      picAbs: picStamp ? picAbs : null,
      bgDir: dir ? path.join(dir, 'bg') : '',
      preview
    });
    t.decode = r.decode;
    t.draw = r.draw;
    t.encode = r.encode;
    t.thread = r.thread;
    lruSet(outputCache, key, r.buf, OUTPUT_CACHE_MAX);
    if (dir) await diskWrite(dir, key, r.buf);
    return r.buf;
  })().finally(() => pending.delete(key));
  pending.set(key, job);
  return job;
}

/** 後台狀態用：快取與工作執行緒的情況。 */
function cacheStatus(env = process.env) {
  const dir = cacheDir(env);
  return {
    cacheDir: dir,
    cacheLimitMB: Math.round(outCacheLimit(env) / 1024 / 1024),
    cacheBytes: disk.dir === dir && disk.bytes >= 0 ? disk.bytes : null,
    diskHits: disk.hits,
    diskWrites: disk.writes,
    diskPruned: disk.pruned,
    worker: Boolean(worker.w),
    workerEnabled: workerEnabled(env),
    workerRendered: worker.rendered,
    bgVariantsMade: statSum('variantsMade'),
    bgVariantHits: statSum('variantHits')
  };
}

/** 關掉工作執行緒（測試結束、伺服器關機）。 */
async function shutdown() {
  const w = worker.w;
  worker.w = null;
  retireWorkerStats();
  failWorkerJobs(new Error('share card worker shut down'));
  if (w) await w.terminate().catch(() => {});
}

/** 測試用：清掉記憶體裡的快取與工作執行緒（磁碟快取留著，除非 opts.disk）。 */
async function _resetForTests(opts = {}) {
  picState = { dir: '', list: [], scannedAt: 0, exists: false };
  outputCache.clear();
  pending.clear();
  if (localDrawer) localDrawer.clear();
  await shutdown();
  worker.failures = 0;
  disk.bytes = -1;
  disk.dir = '';
  if (opts.disk) {
    const dir = cacheDir();
    if (dir) await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
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
  cacheDir,
  cacheStatus,
  shutdown,
  decodeCount,
  _resetForTests
};
