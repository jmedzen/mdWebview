/**
 * @file lib/asset-version.js — 前端資源的內容指紋（asset version / build id）
 *
 * 為什麼需要它
 * ─────────────
 * index.html 裡每個資源網址都帶 `?v=<版本>`，伺服器對「帶 ?v= 的請求」回
 * `Cache-Control: public, max-age=31536000, immutable`——瀏覽器一年內不會再問伺服器。
 * 這個設計只有在「?v= 的值會隨內容改變」時才安全。過去 ?v= 只用 package.json 的版本號，
 * 而版本號只在發版時才升：dev 分支每次 push 都會重建映像，但版本號不變，於是
 * `app.js?v=4.31.8` 這個網址永遠指向「使用者第一次載入時的那一版」，新功能與修正
 * 一律被 immutable 快取擋在門外（Service Worker 的 CACHE_VERSION 也是同一個原因不更新）。
 *
 * 作法
 * ────
 * 對「會送到瀏覽器的前端檔案」計算內容雜湊，與 package.json 版本串成
 * `<version>-<hash>`。內容有任何變動，指紋就變、?v= 就變、sw.js 的 CACHE_VERSION 也跟著變，
 * 不必靠人記得升版號。版本號仍留在字首，方便人眼辨識。
 *
 * 範圍刻意用「掃描目錄＋副檔名白名單」而非手寫清單：新增前端檔案時不必記得來這裡登記，
 * 漏登記會造成「改了檔案卻不換指紋」，是最糟的失敗方向；多掃到則只是多換一次指紋。
 *
 * 成本
 * ────
 * 每 CHECK_TTL_MS（預設 5 秒）最多重新 stat 一次所有檔案；只有 size／mtime 簽章改變才
 * 重讀檔案、重算雜湊。穩定狀態（容器內檔案不變）下只剩幾十次 stat。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { APP_ROOT, APP_VERSION } = require('./constants');

const CHECK_TTL_MS = 5000;
const HASH_LENGTH = 10;

/** 根目錄下「只給伺服器用」或會頻繁變動但與瀏覽器無關的檔案，不納入指紋。 */
const ROOT_EXCLUDE = new Set([
  'server.js', 'render-worker.js', 'index-worker.js',
  'package.json', 'package-lock.json', 'config.json'
]);

/** 會被瀏覽器載入的副檔名；README／ARCHITECTURE.md 之類的文件不在其中，改文件不該讓全站快取失效。 */
const CLIENT_EXTENSIONS = new Set([
  '.js', '.css', '.html', '.json', '.svg', '.png', '.ico', '.woff', '.woff2', '.ttf'
]);

/** 會遞迴掃描的子目錄（i18n 字串表、vendor 第三方函式庫與字型）。 */
const CLIENT_DIRS = ['i18n', 'vendor'];

function isClientFile(name) {
  return !name.startsWith('.') && CLIENT_EXTENSIONS.has(path.extname(name).toLowerCase());
}

/**
 * 列出納入指紋的檔案（相對路徑、POSIX 分隔、已排序，確保跨平台雜湊一致）。
 * @param {string} root 應用程式根目錄
 * @returns {string[]}
 */
function listClientFiles(root) {
  const out = [];

  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (e.isFile() && isClientFile(e.name) && !ROOT_EXCLUDE.has(e.name)) out.push(e.name);
  }

  const walk = (rel) => {
    let items = [];
    try { items = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch (_) { return; }
    for (const e of items) {
      if (e.name.startsWith('.')) continue;
      const childRel = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(childRel);
      else if (e.isFile() && isClientFile(e.name)) out.push(childRel);
    }
  };
  for (const dir of CLIENT_DIRS) walk(dir);

  return out.sort();
}

/**
 * 建立一個指紋計算器。獨立成工廠函式是為了讓測試能指定暫存目錄與假時鐘。
 *
 * @param {object}   [opts]
 * @param {string}   [opts.root=APP_ROOT]
 * @param {string}   [opts.appVersion=APP_VERSION]
 * @param {number}   [opts.ttlMs=CHECK_TTL_MS] 兩次檢查檔案是否變動之間的最短間隔
 * @param {()=>number} [opts.now=Date.now]
 * @returns {{ get: () => string, refresh: () => string }}
 */
function createAssetVersioner(opts = {}) {
  const root = opts.root || APP_ROOT;
  const appVersion = opts.appVersion || APP_VERSION;
  const ttlMs = opts.ttlMs === undefined ? CHECK_TTL_MS : opts.ttlMs;
  const now = opts.now || Date.now;

  let state = null; // { id, signature, checkedAt }

  function compute() {
    const files = listClientFiles(root);
    const stats = [];
    for (const rel of files) {
      try {
        const st = fs.statSync(path.join(root, rel));
        stats.push({ rel, size: st.size, mtimeMs: st.mtimeMs });
      } catch (_) { /* 檔案在列舉與 stat 之間消失：視為不存在 */ }
    }
    const signature = stats.map(s => `${s.rel}:${s.size}:${s.mtimeMs}`).join('|');
    if (state && state.signature === signature) return { id: state.id, signature };

    const hash = crypto.createHash('sha1');
    for (const s of stats) {
      let content;
      try { content = fs.readFileSync(path.join(root, s.rel)); } catch (_) { continue; }
      hash.update(s.rel);
      hash.update('\0');
      hash.update(content);
      hash.update('\0');
    }
    return { id: `${appVersion}-${hash.digest('hex').slice(0, HASH_LENGTH)}`, signature };
  }

  function refresh() {
    let result;
    try {
      result = compute();
    } catch (_) {
      // 讀不到任何檔案時退回純版本號：行為等同修正前，絕不讓請求因此失敗。
      result = { id: appVersion, signature: '' };
    }
    state = { id: result.id, signature: result.signature, checkedAt: now() };
    return state.id;
  }

  function get() {
    if (state && now() - state.checkedAt < ttlMs) return state.id;
    return refresh();
  }

  return { get, refresh };
}

const defaultVersioner = createAssetVersioner();

/** 目前前端資源的指紋，例如 `4.31.8-1a2b3c4d5e`。 */
function getAssetVersion() {
  return defaultVersioner.get();
}

module.exports = {
  getAssetVersion,
  createAssetVersioner,
  listClientFiles,
  CHECK_TTL_MS
};
