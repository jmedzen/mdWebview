/**
 * @file lib/index-dir.js — 索引快取目錄（INDEX_DIR）與舊位置遷移
 *
 * v4.19.0 以前，全文 bigram 索引、字典索引、章節索引的快取檔都寫在 LOG_DIR
 * （logs/）裡，和存取日誌混在一起：備份日誌時會把 ~650MB 的索引一起帶走，
 * 清日誌時又可能誤刪索引而觸發長時間重建。現在索引改放在獨立的 INDEX_DIR
 * （預設 <MDW_USER_DATA>/index，Docker 為 /data/index）。
 *
 * 已經在跑的站台升級時，索引檔還在 logs/ 裡。migrateLegacyIndexFiles() 在
 * 伺服器啟動時把它們搬到新目錄，讓升級後不必重建索引：
 *   - 同一個檔案系統 → rename（瞬間完成）。
 *   - 跨檔案系統（Docker 的 logs 與 index 是不同掛載點）→ 複製到暫存檔、
 *     改名、再刪除舊檔；複製失敗就保留舊檔，索引照常重建，不會讓伺服器起不來。
 *   - 新目錄已有同名檔時以新目錄為準，舊檔直接刪掉（避免每次啟動都重搬）。
 */

const fs = require('fs');
const path = require('path');

/** 所有索引快取檔名。新增索引檔時也要加到這裡，否則升級時不會被搬走。 */
const INDEX_CACHE_FILES = Object.freeze([
  'search-index-cache.bin',
  'search-index-cache.json',
  'dict-index-cache.bin',
  'section-index-cache.bin',
  'dict-section-index-cache.bin',
]);

function sameDir(a, b) {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch (_) {
    return path.resolve(a) === path.resolve(b);
  }
}

/**
 * 把舊 LOG_DIR 裡的索引快取檔搬到 INDEX_DIR。
 * @param {{ logDir: string, indexDir: string, logger?: { info: Function, warn: Function } }} opts
 * @returns {{ moved: string[], skipped: string[], failed: string[] }}
 */
function migrateLegacyIndexFiles({ logDir, indexDir, logger } = {}) {
  const result = { moved: [], skipped: [], failed: [] };
  if (!logDir || !indexDir) return result;
  if (!fs.existsSync(logDir)) return result;
  // INDEX_DIR 被設成與 LOG_DIR 相同（例如 INDEX_DIR=/data/logs 想維持舊行為）時不用搬。
  if (fs.existsSync(indexDir) && sameDir(logDir, indexDir)) return result;

  const present = INDEX_CACHE_FILES.filter(name => {
    try { return fs.statSync(path.join(logDir, name)).isFile(); } catch (_) { return false; }
  });
  // 寫到一半中斷留下的暫存檔沒有用處，順手清掉。
  for (const name of INDEX_CACHE_FILES) {
    try { fs.unlinkSync(path.join(logDir, name + '.tmp')); } catch (_) {}
  }
  if (present.length === 0) return result;

  try {
    fs.mkdirSync(indexDir, { recursive: true });
  } catch (err) {
    if (logger) logger.warn('Index', `Cannot create index directory ${indexDir}; legacy index files stay in ${logDir} and indexes will be rebuilt`, err);
    result.failed.push(...present);
    return result;
  }

  for (const name of present) {
    const from = path.join(logDir, name);
    const to = path.join(indexDir, name);
    if (fs.existsSync(to)) {
      // 新目錄的檔案比較新（或至少是這一版寫的），舊檔已無用。
      try { fs.unlinkSync(from); } catch (_) {}
      result.skipped.push(name);
      continue;
    }
    try {
      fs.renameSync(from, to);
      result.moved.push(name);
    } catch (err) {
      if (err && err.code !== 'EXDEV') {
        if (logger) logger.warn('Index', `Failed to move ${name} to ${indexDir}; it will be rebuilt`, err);
        result.failed.push(name);
        continue;
      }
      // 跨檔案系統：先複製到暫存檔再改名，確保 INDEX_DIR 裡永遠不會出現半個檔案。
      const tmp = to + '.migrate-tmp';
      try {
        fs.copyFileSync(from, tmp);
        fs.renameSync(tmp, to);
        try { fs.unlinkSync(from); } catch (_) {}
        result.moved.push(name);
      } catch (copyErr) {
        try { fs.unlinkSync(tmp); } catch (_) {}
        if (logger) logger.warn('Index', `Failed to copy ${name} to ${indexDir}; it will be rebuilt`, copyErr);
        result.failed.push(name);
      }
    }
  }

  if (logger && result.moved.length) {
    logger.info('Index', `Moved ${result.moved.length} legacy index file(s) from ${logDir} to ${indexDir}: ${result.moved.join(', ')}`);
  }
  return result;
}

module.exports = { INDEX_CACHE_FILES, migrateLegacyIndexFiles };
