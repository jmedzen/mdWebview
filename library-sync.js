/**
 * 書籤與閱讀歷程的同步規則（瀏覽器與伺服器共用，純函式，無 I/O）。
 *
 * 每一筆資料以路徑為 key，帶一個毫秒時間戳 `ts`；刪除以「墓碑」表示（同路徑、
 * 帶刪除時間）。同一路徑在各處的版本中，時間戳最大者勝（last-write-wins），
 * 與裝置、順序、重送次數都無關，因此多次合併的結果一致（可交換、冪等）。
 *
 * 線上格式：{ path, title, updatedAt, deleted?, pct?, line? }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MdwLibrarySync = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LIMITS = {
    maxPathLength: 500,
    maxTitleLength: 200,
    maxItemsPerRequest: 500,   // 每次請求、每種資料最多幾筆
    maxBookmarks: 2000,        // 每個帳號
    maxHistory: 200,           // 伺服器保留的歷程筆數（畫面只顯示最近 20 筆）
    maxClockSkewMs: 60 * 1000, // 超過伺服器時間這麼多的時間戳視為未來，截斷
    tombstoneTtlMs: 90 * 24 * 3600 * 1000
  };

  function cleanPath(v) {
    if (typeof v !== 'string') return '';
    const s = v.trim();
    if (!s || s.length > LIMITS.maxPathLength || s.indexOf('\0') >= 0) return '';
    return s;
  }

  function cleanTs(v, now) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(Math.floor(n), now + LIMITS.maxClockSkewMs);
  }

  /**
   * 整理一筆來自外部的線上資料。無效時回傳 null。
   * @param {'bookmark'|'history'} kind
   */
  function normalizeWireItem(raw, kind, now) {
    if (!raw || typeof raw !== 'object') return null;
    const path = cleanPath(raw.path);
    const updatedAt = cleanTs(raw.updatedAt, now);
    if (!path || !updatedAt) return null;
    const item = { path, updatedAt, deleted: raw.deleted === true };
    item.title = typeof raw.title === 'string' ? raw.title.slice(0, LIMITS.maxTitleLength) : '';
    if (kind === 'history') {
      const pct = Number(raw.pct);
      item.pct = Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct))) : null;
      const line = Number(raw.line);
      item.line = Number.isFinite(line) && line > 0 ? Math.floor(line) : null;
    }
    return item;
  }

  /**
   * 把遠端異動併入本機清單。
   * @param {Array} local 本機清單，元素 { filePath, fileName, ts, ... }
   * @param {Object} tombs 本機墓碑 { [path]: deletedTs }
   * @param {Array} remote 線上格式的異動
   * @param {{kind:string, make:(w:Object)=>Object, cap?:number}} opts
   *   make 把線上格式轉成本機元素（需帶 filePath、ts）
   * @returns {{list:Array, tombs:Object, changed:boolean}}
   */
  function mergeRemote(local, tombs, remote, opts) {
    const byPath = new Map();
    for (const it of local || []) byPath.set(it.filePath, it);
    const nextTombs = Object.assign({}, tombs || {});
    let changed = false;
    for (const w of remote || []) {
      const cur = byPath.get(w.path);
      const curTs = Math.max(cur ? (cur.ts || 0) : 0, nextTombs[w.path] || 0);
      if (w.updatedAt <= curTs) continue;
      changed = true;
      if (w.deleted) {
        byPath.delete(w.path);
        nextTombs[w.path] = w.updatedAt;
      } else {
        byPath.set(w.path, opts.make(w));
        delete nextTombs[w.path];
      }
    }
    let list = Array.from(byPath.values()).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    if (opts.cap && list.length > opts.cap) {
      list = list.slice(0, opts.cap);
      changed = true;
    }
    return { list, tombs: nextTombs, changed };
  }

  /** 丟掉過舊的墓碑，避免本機中繼資料無限增長。 */
  function pruneTombs(tombs, now) {
    const out = {};
    for (const k of Object.keys(tombs || {})) {
      if (now - tombs[k] < LIMITS.tombstoneTtlMs) out[k] = tombs[k];
    }
    return out;
  }

  return { LIMITS, cleanPath, cleanTs, normalizeWireItem, mergeRemote, pruneTombs };
});
