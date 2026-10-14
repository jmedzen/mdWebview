/**
 * @file test-section-index-cache.test.js
 *
 * 迴歸測試：章節索引快取的「讀寫分離 + 寫入去抖 + 關機沖刷」。
 *
 * 背景（v3.7.9 修正前）：
 *   磁碟 bin 檔寫入的是 20 筆上限的讀取 LRU 本身，而 vault 中有 321 個大檔，
 *   因此每次開機／批次改檔都得重建約 300 個索引，且每建好一個就把整份覆寫一次
 *   （實測單次開機 324–429 次寫入、累計 148 MB、最慢單次 38.6 秒）。
 *
 * 本檔鎖定三項不變式：
 *   1. 磁碟鏡像不受 20 筆 LRU 上限限制 → bin 檔可持久化超過 20 筆。
 *   2. 連續多次建置只觸發一次寫入（去抖合併）。
 *   3. flushAllSectionIndexSaves() 可重複呼叫且具冪等性（關機沖刷的基礎）。
 *
 * 注意：LOG_DIR 必須在 require('../server.js') 之前設定，才能把 bin 檔隔離到
 * 暫存目錄，避免污染 repo 的 logs/。
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// 隔離：bin 檔改寫到暫存目錄。
const TEST_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mdwebview-si-cache-'));
process.env.LOG_DIR = TEST_LOG_DIR;
// 縮短去抖時間（仍遠長於建置迴圈，確保不會在迴圈中途觸發）。
process.env.SECTION_INDEX_SAVE_DEBOUNCE_MS = '3000';

const {
  server,
  getSectionIndex,
  flushAllSectionIndexSaves,
  terminateWorkerPools,
  resetTreeWatcher,
  resetDictWatcher,
  resetConfigWatcher
} = require('../server');

const SECTION_BIN = path.join(TEST_LOG_DIR, 'section-index-cache.bin');
const MAGIC = 0x53455832; // "SEX2"

// 共用收尾：所有測試結束後才釋放 worker pool 與暫存目錄。
// 不可寫在個別 test 的 t.after 中——terminateWorkerPools() 一旦執行，
// 後續測試若還需要建立索引就會卡住。
after(async () => {
  if (typeof resetTreeWatcher === 'function') resetTreeWatcher();
  if (typeof resetDictWatcher === 'function') resetDictWatcher();
  if (typeof resetConfigWatcher === 'function') resetConfigWatcher();
  if (typeof terminateWorkerPools === 'function') await terminateWorkerPools();
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  try { fs.rmSync(TEST_LOG_DIR, { recursive: true, force: true }); } catch (_) {}
});

/** 讀取 bin 檔的 fileCount；檔案不存在時回傳 -1。 */
function readBinFileCount(binPath) {
  if (!fs.existsSync(binPath)) return -1;
  const buf = fs.readFileSync(binPath);
  if (buf.length < 8) return -1;
  assert.equal(buf.readUInt32BE(0), MAGIC, 'bin 檔魔數應為 SEX2');
  return buf.readUInt32BE(4);
}

/** 走訪 vault，蒐集所有 >=1MB 的 markdown/txt 檔案。 */
function collectLargeFiles(mdRoot) {
  const out = [];
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of ents) {
      if (ent.name.startsWith('.')) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      if (!/\.(md|txt)$/i.test(ent.name)) continue;
      try {
        const st = fs.statSync(p);
        if (st.size >= 1024 * 1024) out.push({ fullPath: p, relPath: path.relative(mdRoot, p), size: st.size });
      } catch (_) {}
    }
  };
  walk(mdRoot);
  return out;
}

test('Section Index Cache: 磁碟鏡像可持久化超過 20 筆（突破 LRU 上限）', async (t) => {

  const mdRoot = path.join(process.cwd(), 'md');
  if (!fs.existsSync(mdRoot)) {
    t.skip('vault (md/) 不存在，略過');
    return;
  }

  const largeFiles = collectLargeFiles(mdRoot);
  if (largeFiles.length <= 20) {
    t.skip(`vault 中 >=1MB 的檔案僅 ${largeFiles.length} 個，不足以驗證突破 20 筆上限`);
    return;
  }

  // 對前 25 個大檔建立索引，模擬一次全量掃描。
  const sample = largeFiles.slice(0, 25);
  for (const f of sample) {
    const st = fs.statSync(f.fullPath);
    await getSectionIndex(f.fullPath, st, f.relPath);
  }

  await flushAllSectionIndexSaves();

  const count = readBinFileCount(SECTION_BIN);
  assert.ok(count > 20,
    `bin 檔應持久化超過 20 筆（實際 ${count} 筆）；若仍為 <= 20，代表磁碟快取又被 20 筆 LRU 上限截斷，全量掃描將無法受益於快取而反覆重建`);
  assert.ok(count >= sample.length,
    `已索引 ${sample.length} 個檔案，bin 檔應至少含 ${sample.length} 筆（實際 ${count} 筆）`);
});

test('Section Index Cache: 連續建置合併為單次寫入（去抖）', async (t) => {
  const mdRoot = path.join(process.cwd(), 'md');
  if (!fs.existsSync(mdRoot)) {
    t.skip('vault (md/) 不存在，略過');
    return;
  }
  const largeFiles = collectLargeFiles(mdRoot);
  if (largeFiles.length < 2) {
    t.skip('大檔不足，略過');
    return;
  }


  // 精確統計 bin 檔的寫入次數（doSaveSectionIndexBin 寫入 <bin>.tmp 再 rename）。
  const realWriteFile = fs.promises.writeFile;
  const written = [];
  fs.promises.writeFile = function (file, ...rest) {
    if (typeof file === 'string' && file.endsWith('.tmp')) written.push(file);
    return realWriteFile.call(fs.promises, file, ...rest);
  };

  try {
    // 連續建立多個索引；去抖視窗內不急著寫檔。
    // 刻意選用與上一個測試不重疊的檔案，確保是「真的重建」而非快取命中。
    const need = largeFiles.slice(25, 33);
    let built = 0;
    for (const f of need) {
      const st = fs.statSync(f.fullPath);
      await getSectionIndex(f.fullPath, st, f.relPath);
      built++;
    }
    assert.equal(written.length, 0,
      `去抖視窗內不應寫檔，卻已寫入 ${written.length} 次（建置 ${built} 個索引）`);

    // 主動沖刷：多個建置應合併為單次寫入。
    await flushAllSectionIndexSaves();
    assert.equal(written.length, 1,
      `建置 ${built} 個索引後應合併為 1 次寫入（實際 ${written.length} 次）；` +
      `若等於 ${built}，代表去抖未生效，仍是每次建置都整份重寫（v3.7.9 前的行為）`);
  } finally {
    fs.promises.writeFile = realWriteFile;
  }
});
