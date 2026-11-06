'use strict';
/**
 * lib/watch-filter.js — 檔案監視器的事件過濾
 *
 * 全文索引與辭典索引只收 .md 檔。附件（PDF、docx、圖片…）在同一個資料夾裡被同步、改寫時，
 * 不該觸發整庫索引重建：重建的尖峰記憶體約 4GB，而且 alpine（musl）的 malloc 不太會還給系統，
 * 反覆重建會讓容器 RSS 一路墊高。
 */
const fs = require('fs');
const path = require('path');

/**
 * 這個異動會不會影響索引？
 *   - .md 檔：會。
 *   - 沒有檔名（平台沒給）：保守地當作會。
 *   - 其他副檔名的 change 事件：只是內容被改寫，不會。
 *   - 其他副檔名的 rename 事件（新增／刪除／搬移）：檔案不會；但目錄名可能含「.」，
 *     所以路徑存在而且是目錄、或已不存在又沒有副檔名時，仍當作會。
 */
function isIndexRelevantChange(rootDir, eventType, filename) {
  if (!filename) return true;
  if (filename.endsWith('.md')) return true;
  if (eventType === 'change') return false;
  try {
    return !fs.statSync(path.join(rootDir, filename)).isFile();
  } catch (_) {
    return path.extname(filename) === '';
  }
}

module.exports = { isIndexRelevantChange };
