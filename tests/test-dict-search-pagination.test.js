/**
 * 辭典全文搜尋分頁 (Dictionary Full-text Search Pagination) 測試
 *
 * 背景：`handleDictSearch` 原本把每個辭典檔的命中數硬截斷在
 * DICT_SEARCH_MAX_PER_FILE=1500，且因為保留「文件順序最早的 1500 筆」，
 * 高頻詞（例如「一切」）在大辭典尾端的命中永遠無法觸及
 * （實測：dict:法相辭典.md 的「一切」只到第 17172 行 / 全檔 156712 行）。
 * 修正方向是「有界分頁」而非提高上限：worker 支援 skip 游標並回報是否還有
 * 下一頁，server 以 after/nextAfter/hasMore 串接，前端以「取代式」翻頁
 * （而非無限累加）讓 DOM 大小與頁數無關。
 *
 * 本檔同時包含：
 *   1. 真實行為測試 — 以 worker_threads 實際驅動 index-worker.js，對暫存檔驗證
 *      skip / truncated 語意（不依賴 repo 內任何語料）。
 *   2. 原始碼契約測試 — app.js 為 IIFE 無法 import，故沿用 tests/test-reader-highlight.test.js
 *      與 tests/test-dict-deep-jump-alignment.test.js 的既有慣例，以原始碼正則守護
 *      server 端 after 解析／nextAfter 建構與前端分頁快取的結構契約。
 *   3. 選擇性整合測試 — 需要真實 dicts/ 語料，語料不存在時 graceful skip。
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

const ROOT_DIR = path.resolve(__dirname, '..');
const APP_JS = path.join(ROOT_DIR, 'app.js');
const SERVER_JS = path.join(ROOT_DIR, 'server.js');
const WORKER_JS = path.join(ROOT_DIR, 'index-worker.js');
const DICTS_DIR = path.join(ROOT_DIR, 'dicts');

const appContent = fs.readFileSync(APP_JS, 'utf8');
const serverContent = fs.readFileSync(SERVER_JS, 'utf8');
const workerContent = fs.readFileSync(WORKER_JS, 'utf8');

// 取得函式本體，讓斷言限定在該函式內，避免跨函式誤匹配。
function extractFunctionBody(source, signature) {
  const start = source.indexOf(signature);
  if (start === -1) return null;
  let i = source.indexOf('{', start);
  if (i === -1) return null;
  let depth = 0;
  let inLineComment = false;
  let inBlockComment = false;
  let quote = null;
  for (; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (inLineComment) { if (ch === '\n') inLineComment = false; continue; }
    if (inBlockComment) { if (ch === '*' && next === '/') { inBlockComment = false; i++; } continue; }
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') { inLineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return source.slice(start, i + 1); }
  }
  return null;
}

function listDictCorpora() {
  try {
    return fs.readdirSync(DICTS_DIR).filter(n => n.endsWith('.md') && !n.startsWith('.'));
  } catch (_) {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 1. index-worker.js search-scan：真實 skip / truncated 語意
// ─────────────────────────────────────────────────────────────────────────
describe('辭典全文搜尋分頁 1：index-worker.js skip / truncated 語意', () => {
  let tmpDir = '';
  let docPath = '';
  let docSize = 0;
  let worker = null;

  // 5 個「法」命中，分散在不同行，外加若干無關行。
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dict-page-worker-'));
    docPath = path.join(tmpDir, 'dict-sample.md');
    const lines = [];
    for (let i = 1; i <= 20; i++) lines.push(i % 4 === 0 ? `法 命中的第 ${i} 行` : `無關內容 ${i}`);
    fs.writeFileSync(docPath, lines.join('\n'), 'utf-8');
    docSize = fs.statSync(docPath).size;
    worker = new Worker(WORKER_JS);
  });

  after(async () => {
    if (worker) await worker.terminate();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 單一 unit 掃描（不涉及 entry 切分），純粹驗證游標計數語意。
  function scan({ skip, maxPerFile, terms = ['法'], units }) {
    const payload = {
      type: 'search-scan',
      jobId: 1,
      fullPath: docPath,
      units: units || [{
        unitId: 0, file: 'dict:dict-sample.md', fileName: 'dict-sample',
        entryIndex: -1, headword: '', byteOffset: 0, byteLength: docSize, lineStart: 1,
      }],
      terms,
      maxProximityDist: 150,
      maxPerFile,
    };
    if (skip !== undefined) payload.skip = skip;
    return new Promise((resolve, reject) => {
      const onMessage = (m) => { worker.off('error', onError); resolve(m); };
      const onError = (e) => { worker.off('message', onMessage); reject(e); };
      worker.once('message', onMessage);
      worker.once('error', onError);
      worker.postMessage(payload);
    });
  }

  test('無 skip 時行為與改動前一致：回傳最早的 cap 筆且 truncated=true', async () => {
    const r = await scan({ maxPerFile: 2 });
    assert.equal(r.ok, true, 'worker 應回報 ok');
    assert.equal(r.result.matches.length, 2, '應回傳 cap 筆命中');
    assert.deepEqual(r.result.matches.map(m => m.line), [4, 8], '應為文件順序最早的兩筆');
    assert.equal(r.result.truncated, true, '仍有後續命中時 truncated 必為 true');
  });

  test('skip 會跳過文件順序中前 skip 筆並往前推進視窗', async () => {
    const r = await scan({ skip: 2, maxPerFile: 2 });
    assert.deepEqual(r.result.matches.map(m => m.line), [12, 16], '第二頁應為第 3、4 筆命中');
    assert.equal(r.result.truncated, true, '第 5 筆仍存在，故 truncated=true');
  });

  test('最後一頁（不足 cap 且無後續）回報 truncated=false', async () => {
    const r = await scan({ skip: 4, maxPerFile: 2 });
    assert.deepEqual(r.result.matches.map(m => m.line), [20], '第 5 筆為最後一頁唯一命中');
    assert.equal(r.result.truncated, false, '沒有後續命中時 truncated 必為 false');
  });

  test('skip 超出實際命中總數時回傳空頁且 truncated=false', async () => {
    const r = await scan({ skip: 5, maxPerFile: 2 });
    assert.equal(r.result.matches.length, 0, '游標走到底應回傳空頁');
    assert.equal(r.result.truncated, false, '空頁不得宣稱還有下一頁');
  });

  test('skip=0 與省略 skip 等價（舊呼叫端零行為變更）', async () => {
    const withZero = await scan({ skip: 0, maxPerFile: 100 });
    const without = await scan({ maxPerFile: 100 });
    assert.equal(withZero.result.matches.length, 5, '全檔共 5 筆命中');
    assert.equal(without.result.matches.length, 5, '省略 skip 應等同 skip=0');
    assert.equal(without.result.truncated, false, '省略 skip 時 truncated 預設為 false');
    assert.deepEqual(
      withZero.result.matches.map(m => m.line),
      without.result.matches.map(m => m.line),
      'skip=0 與省略 skip 的命中順序必須完全相同'
    );
  });

  test('skip 可跨多個 unit 累計（游標是全檔順序而非單一 unit）', async () => {
    // 兩個 unit 各含一部分行：前 10 行與後 10 行。
    const head = fs.readFileSync(docPath, 'utf-8');
    const headBytes = Buffer.byteLength(head.split('\n').slice(0, 10).join('\n') + '\n', 'utf-8');
    const units = [
      { unitId: 0, file: 'dict:dict-sample.md', fileName: 'dict-sample', entryIndex: 0, headword: 'a', byteOffset: 0, byteLength: headBytes, lineStart: 1 },
      { unitId: 1, file: 'dict:dict-sample.md', fileName: 'dict-sample', entryIndex: 1, headword: 'b', byteOffset: headBytes, byteLength: docSize - headBytes, lineStart: 11 },
    ];
    // 前 10 行含第 4、8 行命中；後 10 行含第 12、16、20 行命中。
    const page1 = await scan({ units, maxPerFile: 3 });
    assert.deepEqual(page1.result.matches.map(m => m.line), [4, 8, 12], '第一頁應跨 unit 取滿 3 筆');
    assert.equal(page1.result.truncated, true, '跨 unit 後仍有命中');

    const page2 = await scan({ units, maxPerFile: 3, skip: 3 });
    assert.deepEqual(page2.result.matches.map(m => m.line), [16, 20], '第二頁應接續第二個 unit 的命中');
    assert.equal(page2.result.truncated, false, '兩個 unit 合計僅剩 2 筆');
  });

  test('行號仍以 u.lineStart + m.line - 1 計算', async () => {
    const r = await scan({ maxPerFile: 100 });
    for (const m of r.result.matches) {
      assert.equal(typeof m.line, 'number', 'line 應為數字');
      assert.ok(m.line >= 1 && m.line <= 20, `line ${m.line} 應落在檔案行數範圍內`);
    }
    assert.deepEqual(r.result.matches.map(m => m.line), [4, 8, 12, 16, 20], '行號需與實際命中行一致');
  });

  test('match 物件形狀維持不變（file/fileName/entryIndex/headword/line/snippet）', async () => {
    const r = await scan({ maxPerFile: 1 });
    assert.deepEqual(
      Object.keys(r.result.matches[0]).sort(),
      ['entryIndex', 'file', 'fileName', 'headword', 'line', 'snippet'],
      '公開的 match 欄位不得增減'
    );
  });

  test('訊息信封仍為 { jobId, ok:true, result:{ matches, truncated } }', async () => {
    const r = await scan({ maxPerFile: 1 });
    assert.equal(r.jobId, 1, 'jobId 需原樣回傳');
    assert.equal(r.ok, true, 'ok 需為 true');
    assert.ok(Array.isArray(r.result.matches), 'result.matches 需為陣列');
    assert.equal(typeof r.result.truncated, 'boolean', 'result.truncated 需為布林');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. server.js：after 解析與 nextAfter / hasMore 建構契約
// ─────────────────────────────────────────────────────────────────────────
describe('辭典全文搜尋分頁 2：server.js after / nextAfter / hasMore 契約', () => {
  const handlerBody = extractFunctionBody(serverContent, 'async function handleDictSearch(');

  test('可擷取 handleDictSearch 函式本體（防斷言空洞化）', () => {
    assert.ok(handlerBody, '應能擷取 handleDictSearch 函式本體');
    assert.ok(handlerBody.length > 2000, 'handleDictSearch 本體長度應合理');
  });

  test('接受 after 參數並以防禦性 JSON 解析處理', () => {
    assert.match(handlerBody, /query\.after/, '應讀取 query.after 參數');
    assert.match(handlerBody, /JSON\.parse\(\s*String\(\s*query\.after\s*\)\s*\)/, '應以 JSON.parse 解析 after');
    assert.match(handlerBody, /catch\s*\(\s*_\s*\)\s*\{\s*afterMap\s*=\s*\{\s*\}\s*;?\s*\}/, '解析失敗時必須回退為空游標（第 1 頁）');
  });

  test('after 值需被收斂為非負整數並忽略非有限值', () => {
    assert.match(handlerBody, /Number\.isFinite\(\s*n\s*\)/, '應以 Number.isFinite 過濾 NaN / Infinity');
    assert.match(handlerBody, /n\s*>\s*0/, '0 與負數不得成為有效游標');
    assert.match(handlerBody, /Math\.floor\(\s*n\s*\)/, '應以 Math.floor 收斂為整數');
    assert.match(handlerBody, /!Array\.isArray\(\s*parsed\s*\)/, '陣列不得被當成游標物件');
  });

  test('after 的鍵必須與結果 file（dict: relPath）一致，否則翻頁會原地重複', () => {
    // 結果／nextAfter 使用 u.file（'dict:xxx.md'），而 worker task 以 fullPath 分組；
    // 兩者必須顯式對照，否則 after 永遠對不上、第 2 頁會等於第 1 頁。
    assert.match(handlerBody, /relPathByFullPath/, '應建立 fullPath → relPath 的對照表');
    assert.match(
      handlerBody,
      /skipFor\s*=\s*\(\s*fullPath\s*\)\s*=>\s*afterMap\[\s*relPathByFullPath\.get\(\s*fullPath\s*\)\s*\]/,
      'skipFor 應以 relPath（非 fullPath）查詢 after 游標'
    );
  });

  test('每個檔案的 skip 需傳入 worker payload', () => {
    assert.match(handlerBody, /skip\s*:\s*skipFor\(\s*task\.fullPath\s*\)/, 'payload 需帶入該檔案的 skip');
    assert.match(handlerBody, /maxPerFile\s*:\s*DICT_SEARCH_MAX_PER_FILE/, 'maxPerFile 仍是頁面大小');
  });

  test('結果回呼需取得 task 才能把 truncated 歸屬到正確檔案', () => {
    assert.match(
      handlerBody,
      /\(\s*result\s*,\s*task\s*\)\s*=>\s*\{/,
      '回呼簽名需為 (result, task)，否則空 matches 的 truncated 無法歸屬檔案'
    );
    assert.match(handlerBody, /result\.truncated/, '需讀取 worker 回報的 truncated');
  });

  test('nextAfter = 先前 skip + 本頁 delivered，且對每個掃描過的檔案都成立（含已耗盡者）', () => {
    // 關鍵迴歸：早期版本只在 stat.truncated 時才寫入 nextAfter，導致已耗盡的檔案
    // 在下一頁的 after 物件中缺鍵 → skipFor 回退為 0 → 該檔從頭重掃，永不終止。
    assert.match(handlerBody, /nextAfter\[\s*relPath\s*\]\s*=\s*stat\.skip\s*\+\s*stat\.delivered/, 'nextAfter 應為累計游標');
    assert.doesNotMatch(
      handlerBody,
      /if\s*\(\s*stat\.truncated\s*\)\s*\{\s*nextAfter\[/,
      'nextAfter 不得只寫入 truncated 的檔案（會使耗盡檔案游標遺失並重新開始）'
    );
    assert.match(handlerBody, /stat\.delivered\s*\+=\s*result\.matches\.length/, '需累計本頁 delivered');
  });

  test('hasMore 為任一檔案仍有後續即 true（耗盡檔案不得讓 hasMore 永遠為 true）', () => {
    assert.match(handlerBody, /if\s*\(\s*stat\.truncated\s*\)\s*hasMore\s*=\s*true\s*;/, 'hasMore 只由 truncated 決定');
  });

  test('接受 done 參數並排除已耗盡檔案，同時累積回報 exhausted', () => {
    assert.match(handlerBody, /query\.done/, '應讀取 query.done 參數');
    assert.match(handlerBody, /String\(\s*query\.done\s*\)\.split\(\s*','\s*\)/, 'done 為逗號分隔清單');
    assert.match(handlerBody, /doneSet\.has\(/, 'done 需以 Set 判斷並排除');
    assert.match(handlerBody, /\.filter\(\s*t\s*=>\s*!doneSet\.has\(/, 'scanTasks 需過濾掉已耗盡檔案（不得重掃）');
    assert.match(handlerBody, /exhausted\.add\(/, '非 truncated 的檔案需標記為 exhausted');
    assert.match(handlerBody, /exhausted\s*:\s*Array\.from\(\s*exhausted\s*\)/, '回應需含 exhausted 陣列');
    assert.match(handlerBody, /new Set\(\s*doneSet\s*\)/, 'exhausted 需為跨頁累積（含先前 done）');
  });

  test('done 只接受屬於本次查詢檔案集的 relPath', () => {
    assert.match(handlerBody, /relPathSet\s*=\s*new Set\(/, '需建立合法 relPath 集合');
    assert.match(handlerBody, /relPathSet\.has\(/, '只允許合法路徑進入 doneSet');
  });

  test('回應保留 query/results/total/capped 並新增 nextAfter/hasMore/exhausted', () => {
    assert.match(
      handlerBody,
      /sendJSON\(\s*res\s*,\s*200\s*,\s*\{\s*query\s*:\s*q\s*,\s*results\s*,\s*total\s*:\s*results\.length\s*,\s*capped\s*:\s*hitCap\s*,\s*nextAfter\s*,\s*hasMore\s*,\s*exhausted\s*:\s*Array\.from\(\s*exhausted\s*\)\s*\}\s*\)/,
      '回應欄位需為 query/results/total/capped/nextAfter/hasMore/exhausted'
    );
    assert.match(handlerBody, /total\s*:\s*results\.length/, 'total 仍是本頁筆數');
  });

  test('既有排序、空檔案早退與錯誤處理維持不變', () => {
    assert.match(
      handlerBody,
      /results\.sort\(\s*\(\s*a\s*,\s*b\s*\)\s*=>\s*\(\s*a\.file\s*===\s*b\.file\s*\?\s*a\.line\s*-\s*b\.line\s*:\s*a\.file\.localeCompare\(\s*b\.file\s*\)\s*\)\s*\)/,
      '排序規則需維持 file 再 line'
    );
    assert.match(
      handlerBody,
      /results\s*:\s*\[\s*\]\s*,\s*total\s*:\s*0\s*,\s*capped\s*:\s*false/,
      '無辭典檔案時仍應回傳空結果'
    );
    assert.match(
      handlerBody,
      /sendJSON\(\s*res\s*,\s*500\s*,\s*\{\s*error\s*:\s*'Dictionary search failed'\s*\}\s*\)/,
      '例外處理與訊息需維持不變'
    );
  });

  test('runIndexWorkerPool 回呼確實帶入 task（分頁歸屬的前提）', () => {
    const poolContent = fs.readFileSync(path.join(ROOT_DIR, 'lib', 'worker-pool.js'), 'utf8');
    const runnerBody = extractFunctionBody(poolContent, 'async function runIndexWorkerPool(');
    assert.ok(runnerBody, '應能擷取 runIndexWorkerPool 本體');
    assert.match(runnerBody, /onMessage\(\s*result\s*,\s*task\s*\)/, 'onMessage 需同時收到 result 與 task');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. app.js：前端分頁快取與翻頁契約
// ─────────────────────────────────────────────────────────────────────────
describe('辭典全文搜尋分頁 3：app.js 翻頁與快取契約', () => {
  const searchBody = extractFunctionBody(appContent, 'function dictSearchFulltext(');
  const renderBody = extractFunctionBody(appContent, 'function renderDictFulltextResults(');
  const pagerBody = extractFunctionBody(appContent, 'function renderDictFulltextPager(');
  const nextBody = extractFunctionBody(appContent, 'function dictFulltextNextPage(');
  const prevBody = extractFunctionBody(appContent, 'function dictFulltextPrevPage(');
  const showBody = extractFunctionBody(appContent, 'function showDictFulltextPage(');
  const cacheBody = extractFunctionBody(appContent, 'async function runDictSearch(');

  test('可擷取所有分頁相關函式本體（防斷言空洞化）', () => {
    assert.ok(searchBody, '應能擷取 dictSearchFulltext');
    assert.ok(renderBody, '應能擷取 renderDictFulltextResults');
    assert.ok(pagerBody, '應能擷取 renderDictFulltextPager');
    assert.ok(nextBody, '應能擷取 dictFulltextNextPage');
    assert.ok(prevBody, '應能擷取 dictFulltextPrevPage');
    assert.ok(showBody, '應能擷取 showDictFulltextPage');
    assert.ok(cacheBody, '應能擷取 runDictSearch');
  });

  test('快取結構為 { query, files, pageIndex, pages[] }，每頁另存 done/exhausted', () => {
    assert.match(searchBody, /pageIndex\s*:\s*0/, '新查詢需從第 0 頁開始');
    assert.match(searchBody, /pages\s*:\s*\[\s*normalizeDictFulltextPage\(/, 'pages 需為頁面紀錄陣列');
    const normalizeBody = extractFunctionBody(appContent, 'function normalizeDictFulltextPage(');
    assert.ok(normalizeBody, '應能擷取 normalizeDictFulltextPage');
    for (const field of ['after', 'done', 'results', 'total', 'capped', 'hasMore', 'nextAfter', 'exhausted', 'scrollTop']) {
      assert.match(normalizeBody, new RegExp(field + '\\s*:'), `每頁紀錄需包含 ${field}`);
    }
  });

  test('翻頁一律「取代」結果內容，而非累加', () => {
    assert.match(renderBody, /results\.innerHTML\s*=\s*html\s*;/, '渲染需以 innerHTML 整體取代');
    assert.doesNotMatch(renderBody, /insertAdjacentHTML|appendChild|innerHTML\s*\+=/, '不得以累加方式插入結果');
    assert.doesNotMatch(nextBody, /insertAdjacentHTML|appendChild/, '下一頁不得累加到既有列表');
  });

  test('下一頁以目前頁的 nextAfter 作為 after 參數，並帶上累積的 done 清單', () => {
    assert.match(nextBody, /const\s+after\s*=\s*page\.nextAfter\s*;/, '需取用目前頁的 nextAfter');
    assert.match(nextBody, /fetchDictFulltextPage\(\s*cache\.query\s*,\s*cache\.files\s*,\s*after\s*,\s*controller\s*,\s*done\s*\)/, '需把 after 與 done 帶入請求');
    // done 必須是「先前頁面已耗盡」與「本頁回報耗盡」的累積聯集。
    assert.match(nextBody, /page\.done\s*\|\|\s*\[\]/, '需沿用先前累積的 done');
    assert.match(nextBody, /page\.exhausted\s*\|\|\s*\[\]/, '需併入本頁回報的 exhausted');
    const fetchBody = extractFunctionBody(appContent, 'function fetchDictFulltextPage(');
    assert.ok(fetchBody, '應能擷取 fetchDictFulltextPage');
    assert.match(fetchBody, /after\s*=/, '應組出 after 查詢字串');
    assert.match(fetchBody, /JSON\.stringify\(\s*after\s*\)/, 'after 需以 JSON 編碼');
    assert.match(fetchBody, /&done=/, '需組出 done 查詢字串');
    assert.match(fetchBody, /done\.join\(\s*','\s*\)/, 'done 需以逗號串接');
    assert.match(fetchBody, /encodeURIComponent/, 'after/done 需 URL 編碼');
  });

  test('下一頁僅在目前頁 hasMore 時可用，上一頁僅在 pageIndex > 0 時可用', () => {
    assert.match(nextBody, /if\s*\(\s*!page\s*\|\|\s*!page\.hasMore\s*\|\|\s*!page\.nextAfter\s*\)\s*return\s*;/, '無 hasMore 時不得翻下一頁');
    assert.match(prevBody, /cache\.pageIndex\s*<=\s*0/, '第 0 頁不得再往前翻');
    assert.match(pagerBody, /const\s+nextDisabled\s*=\s*!data\.hasMore\s*;/, '下一頁按鈕應依 hasMore 停用');
    assert.match(pagerBody, /const\s+prevDisabled\s*=\s*idx\s*<=\s*0\s*;/, '上一頁按鈕應依 pageIndex 停用');
  });

  test('單頁且無後續時不渲染分頁器', () => {
    assert.match(
      pagerBody,
      /if\s*\(\s*pagerCount\s*<=\s*1\s*&&\s*!data\.hasMore\s*&&\s*idx\s*===\s*0\s*\)\s*return\s+''\s*;/,
      '單頁且 hasMore=false 時分頁器應為空字串'
    );
    assert.match(pagerBody, /第\s*\$\{\s*idx\s*\+\s*1\s*\}\s*頁/, '分頁器需顯示「第 N 頁」');
    assert.match(pagerBody, /上一頁/, '分頁器需有上一頁按鈕');
    assert.match(pagerBody, /下一頁/, '分頁器需有下一頁按鈕');
    assert.match(pagerBody, /data-dict-page="prev"/, '上一頁按鈕需帶 data-dict-page="prev"');
    assert.match(pagerBody, /data-dict-page="next"/, '下一頁按鈕需帶 data-dict-page="next"');
  });

  test('翻回已快取頁面不再發請求，並還原該頁 scrollTop', () => {
    assert.match(nextBody, /if\s*\(\s*cache\.pageIndex\s*\+\s*1\s*<\s*cache\.pages\.length\s*\)\s*\{/, '已有下一頁快取時應直接重用');
    assert.match(showBody, /current\.scrollTop\s*=\s*results\.scrollTop\s*;/, '切頁前需寫回目前頁的滾動位置');
    assert.match(showBody, /results\.scrollTop\s*=\s*page\.scrollTop\s*\|\|\s*0\s*;/, '切頁後需還原目標頁的滾動位置');
    assert.match(showBody, /cache\.pageIndex\s*=\s*clamped\s*;/, '需更新目前頁索引');
  });

  test('新查詢、模式切換、變更辭典選取都會重置分頁快取', () => {
    // 查詢變更
    assert.match(cacheBody, /state\.dictFulltextCache\.query\s*!==\s*q/, '查詢改變需偵測');
    assert.match(cacheBody, /state\.dictFulltextCache\s*=\s*null\s*;/, '查詢改變需重置快取');
    // 空查詢
    assert.match(cacheBody, /if\s*\(\s*!q\s*\)\s*\{[\s\S]{0,200}?state\.dictFulltextCache\s*=\s*null\s*;/, '空查詢需重置快取');
    // 模式切換
    const tabBody = appContent.slice(appContent.indexOf("const dictTabs = $('dictTabs')"));
    assert.match(
      tabBody.slice(0, 800),
      /state\.dictFulltextCache\s*=\s*null\s*;/,
      '模式切換需重置分頁快取'
    );
    // 辭典選取變更（checkbox 與全選）
    const fileListBody = appContent.slice(appContent.indexOf("const dictFileList = $('dictFileList')"));
    const resets = fileListBody.slice(0, 2000).match(/state\.dictFulltextCache\s*=\s*null\s*;/g) || [];
    assert.ok(resets.length >= 2, `變更辭典選取（單檔與全選）皆需重置分頁快取，實際找到 ${resets.length} 處`);
  });

  test('滾動位置改以每頁保存，state.dictFulltextScrollTop 仍持續更新', () => {
    assert.match(appContent, /page\.scrollTop\s*=\s*dictResults\.scrollTop\s*;/, '滾動時需寫入目前頁紀錄');
    assert.match(appContent, /state\.dictFulltextScrollTop\s*=\s*dictResults\.scrollTop\s*;/, 'state.dictFulltextScrollTop 仍需更新');
  });

  test('保留既有行為：狀態列、高亮、點擊開啟與檔案分組', () => {
    assert.match(renderBody, /找到\s*\$\{\s*data\.total\s*\}\s*筆/, '狀態列需顯示本頁筆數');
    assert.match(renderBody, /data\.capped\s*\?\s*'（已達上限）'\s*:\s*''/, '狀態列需保留（已達上限）提示');
    assert.match(renderBody, /highlightSearchTerm\(\s*r\.snippet\s*,\s*q\s*\)/, '摘要仍需關鍵字高亮');
    assert.match(renderBody, /data-file="\$\{\s*escHtml\(\s*r\.file\s*\)\s*\}"/, '結果項仍需 data-file');
    assert.match(renderBody, /data-line="\$\{\s*escHtml\(\s*r\.line\s*\)\s*\}"/, '結果項仍需 data-line');
    assert.match(renderBody, /entryAttr/, '結果項仍需 data-entry');
    assert.match(renderBody, /dictFileOrderIndex\(\)/, '仍需依 dictFileOrderIndex 分組排序');
    assert.match(renderBody, /dict-result-group/, '仍需輸出檔案群組容器');
  });

  test('分頁器點擊以事件委派處理，且不落入結果開啟邏輯', () => {
    const clickIdx = appContent.indexOf("dictResults.addEventListener('click'");
    assert.ok(clickIdx > -1, '應保留 dictResults 點擊委派');
    const clickBody = appContent.slice(clickIdx, clickIdx + 1200);
    assert.match(clickBody, /closest\(\s*'\[data-dict-page\]'\s*\)/, '需以 closest 找出分頁按鈕');
    assert.match(clickBody, /dictFulltextNextPage\(\)/, '點擊下一頁需呼叫 dictFulltextNextPage');
    assert.match(clickBody, /dictFulltextPrevPage\(\)/, '點擊上一頁需呼叫 dictFulltextPrevPage');
    const pageIdx = clickBody.indexOf('data-dict-page');
    const itemIdx = clickBody.indexOf("closest('.dict-result-item')");
    assert.ok(pageIdx > -1 && itemIdx > -1 && pageIdx < itemIdx, '分頁按鈕處理需早於結果項處理');
  });

  test('分頁相關 CSS 存在且使用既有主題變數', () => {
    const css = fs.readFileSync(path.join(ROOT_DIR, 'style.css'), 'utf8');
    assert.match(css, /\.dict-pager\s*\{/, 'style.css 需有 .dict-pager 規則');
    assert.match(css, /\.dict-pager-btn\s*\{/, 'style.css 需有 .dict-pager-btn 規則');
    assert.match(css, /\.dict-pager-info\s*\{/, 'style.css 需有 .dict-pager-info 規則');
    const pagerCss = css.slice(css.indexOf('.dict-pager {'), css.indexOf('.dict-pager') + 2000);
    assert.match(pagerCss, /flex-wrap\s*:\s*wrap/, '窄側邊欄需允許換行避免溢出');
    assert.match(pagerCss, /var\(--border-subtle\)/, '應重用既有色彩變數');
    assert.doesNotMatch(pagerCss, /#[0-9a-fA-F]{3,6}\b/, '不得硬編碼新色碼');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. 真實語料整合測試（語料不存在時 graceful skip）
// ─────────────────────────────────────────────────────────────────────────
const corpora = listDictCorpora();
const hasCorpora = corpora.length > 0;
const hasBigDict = corpora.includes('法相辭典.md');

describe('辭典全文搜尋分頁 4：真實語料整合（需 dicts/ 語料）', () => {
  test('dicts/ 語料存在時應能列出至少一個辭典檔', { skip: hasCorpora ? false : 'dicts/ 語料不存在，略過整合測試' }, () => {
    assert.ok(corpora.length > 0, '應至少有一個 .md 辭典檔');
  });

  test('高頻詞在第一頁受限，但 after 游標能推進到檔案更後段', { skip: hasBigDict ? false : '缺少 dicts/法相辭典.md，略過' }, async () => {
    // 以真實分頁 API 行為的等價模型驗證：同一 unit 掃描，skip 越大 firstLine 必須越後。
    const fullPath = path.join(DICTS_DIR, '法相辭典.md');
    const buf = fs.readFileSync(fullPath);
    const worker = new Worker(WORKER_JS);
    const scan = (skip) => new Promise((resolve, reject) => {
      const payload = {
        type: 'search-scan', jobId: 1, fullPath,
        units: [{ unitId: -1, file: 'dict:法相辭典.md', fileName: '法相辭典', entryIndex: -1, headword: '', byteOffset: 0, byteLength: buf.length, lineStart: 1 }],
        terms: ['一切'], maxProximityDist: 150, maxPerFile: 1500, skip,
      };
      const onMessage = (m) => { worker.off('error', onError); resolve(m); };
      const onError = (e) => { worker.off('message', onMessage); reject(e); };
      worker.once('message', onMessage);
      worker.once('error', onError);
      worker.postMessage(payload);
    });
    try {
      const p0 = await scan(0);
      const p1 = await scan(1500);
      assert.equal(p0.result.matches.length, 1500, '第一頁應滿 1500 筆');
      assert.equal(p0.result.truncated, true, '高頻詞第一頁應標示仍有後續');
      assert.equal(p1.result.matches.length, 1500, '第二頁應滿 1500 筆');
      const first0 = p0.result.matches[0].line;
      const first1 = p1.result.matches[0].line;
      assert.ok(first1 > first0, `第二頁起點行（${first1}）必須大於第一頁起點行（${first0}）`);
      // 第一頁原本只到約 17172 行（全檔 156712 行），第二頁必須突破該界線。
      const last0 = p0.result.matches[p0.result.matches.length - 1].line;
      assert.ok(first1 >= last0, `第二頁不得與第一頁重疊（${first1} vs ${last0}）`);
    } finally {
      await worker.terminate();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. 多檔游標走查迴歸測試（關鍵：走查必須終止且不得重複）
//
// 這正是先前的測試套件漏掉的 bug：已耗盡的檔案被排除在 nextAfter 之外，導致
// 下一頁的 after 物件缺少該檔的鍵、skipFor 回退為 0，該檔便從頭重掃，
// 使整個走查永不終止（30 頁交付 170698 筆但只有 84970 筆唯一）。
//
// 本測試以「臨時辭典語料 + 真實 server 路由 + 真實 worker」端到端走查，
// 不依賴 repo 內任何語料。伺服器監聽 ephemeral port（0），絕不觸碰 8330/8341。
// ─────────────────────────────────────────────────────────────────────────
describe('辭典全文搜尋分頁 5：多檔走查必須終止且無重複（真實 server 端到端）', () => {
  // 各檔命中數刻意設計為 >、<、剛好 <= 頁面大小 1500 的組合，讓「哪一頁耗盡」
  // 與「多檔並行但提前耗盡」兩種情況都被覆蓋。
  //   A: 4000（3 頁才耗盡，會跨頁與其他檔並行）
  //   B: 2000（2 頁）
  //   C:  300（第 1 頁即耗盡，必須立刻進 exhausted 且之後不得再被掃描）
  //   D: 1800（2 頁）
  const FILE_HITS = { 'A辭典.md': 4000, 'B辭典.md': 2000, 'C辭典.md': 300, 'D辭典.md': 1800 };
  const TOTAL_HITS = Object.values(FILE_HITS).reduce((a, b) => a + b, 0);

  let baseUrl = '';
  let tmpRoot = '';
  let serverMod = null;
  let httpMod = null;

  before(async () => {
    // 準備臨時語料：每個檔案以條目（### 標題）包住固定的「法」命中。**每行恰好一個
    // 「法」**且行文各自不同，這樣 server 回傳的 (file, line, snippet) 對每一筆命中都是
    // 唯一鍵，重複偵測才有意義（若一行含多個命中，同 line/snippet 會重複出現，
    // 那是語料特性而非游標重掃）。
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dict-page-walk-'));
    const dictsDir = path.join(tmpRoot, 'dicts');
    const mdDir = path.join(tmpRoot, 'md');
    fs.mkdirSync(dictsDir, { recursive: true });
    fs.mkdirSync(mdDir, { recursive: true });
    for (const [name, hits] of Object.entries(FILE_HITS)) {
      const lines = [`# ${name}`, ''];
      let left = hits;
      let entry = 0;
      let seq = 0;
      while (left > 0) {
        entry++;
        lines.push(`### 【詞條${entry}】`, '');
        // 每個條目固定 20 行、每行恰好一個「法」，行文帶序號以確保 snippet 唯一。
        for (let row = 0; row < 20 && left > 0; row++) {
          seq++;
          lines.push(`法 命中序號 ${seq} 之其餘內容文字`);
          left--;
        }
        lines.push('');
      }
      fs.writeFileSync(path.join(dictsDir, name), lines.join('\n'), 'utf-8');
    }
    fs.writeFileSync(path.join(tmpRoot, 'config.json'), JSON.stringify({
      admin: { username: 't', passwordHash: 'x', salt: 'y' },
      settings: {
        mdRoot: mdDir,
        dictionaryEnabled: true,
        dictionaryPath: dictsDir,
        maxProximityDistance: 180,
        timezone: 'auto',
      },
    }), 'utf-8');

    // server.js 的各項路徑常數在 require 時就決定，必須先設好環境變數再載入。
    process.env.CONFIG_PATH = path.join(tmpRoot, 'config.json');
    process.env.MD_ROOT = mdDir;
    process.env.DICTIONARY_PATH = dictsDir;
    process.env.LOG_DIR = path.join(tmpRoot, 'logs');
    serverMod = require('../server.js');
    httpMod = require('http');

    await new Promise((resolve) => {
      serverMod.server.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${serverMod.server.address().port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (serverMod) {
      if (typeof serverMod.terminateWorkerPools === 'function') await serverMod.terminateWorkerPools();
      if (typeof serverMod.resetTreeWatcher === 'function') serverMod.resetTreeWatcher();
      if (typeof serverMod.resetDictWatcher === 'function') serverMod.resetDictWatcher();
      if (typeof serverMod.resetConfigWatcher === 'function') serverMod.resetConfigWatcher();
      if (typeof serverMod.server.closeAllConnections === 'function') serverMod.server.closeAllConnections();
      await new Promise((resolve) => serverMod.server.close(resolve));
    }
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // 逐位元組組回 Buffer 再解碼：分塊回應若直接 d += chunk 會切斷多位元組字元。
  function getJson(pathname) {
    return new Promise((resolve, reject) => {
      const req = httpMod.get(baseUrl + pathname, { agent: false }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          try { resolve(JSON.parse(text)); } catch (e) { reject(new Error(text.slice(0, 300))); }
        });
      });
      req.on('error', reject);
    });
  }

  // 走查整個游標序列，回傳完整軌跡供各項契約斷言。
  // sendDone=false 模擬「只帶 after 的舊客戶端」：此時 done 不會遮蔽 fix 1
  // （每個檔案都必須自帶最終游標），是偵測「已耗盡檔案從頭重掃」的關鍵情境。
  async function walkAllPages(q, maxPages, sendDone = true) {
    const base = `/api/dict-search?q=${encodeURIComponent(q)}&s2t=1`;
    const seen = new Set();
    const skipHistory = new Map();
    let duplicates = 0;
    let delivered = 0;
    let after = null;
    let done = [];
    const pages = [];

    for (let i = 0; i < maxPages; i++) {
      let url = base;
      if (after) url += `&after=${encodeURIComponent(JSON.stringify(after))}`;
      if (sendDone && done.length) url += `&done=${encodeURIComponent(done.join(','))}`;
      const j = await getJson(url);

      const perFile = {};
      for (const r of j.results) {
        perFile[r.file] = (perFile[r.file] || 0) + 1;
        const key = `${r.file}|${r.line}|${r.snippet}`;
        if (seen.has(key)) duplicates++;
        else seen.add(key);
      }
      delivered += j.total;

      // 每個檔案回報的游標只允許前進，永不後退（後退即代表重掃）。
      for (const [f, v] of Object.entries(j.nextAfter || {})) {
        const prev = skipHistory.get(f);
        if (prev !== undefined) {
          assert.ok(
            v >= prev,
            `檔案 ${f} 的游標不得後退：第 ${i + 1} 頁為 ${v}，前一頁為 ${prev}（後退代表該檔被重新掃描）`
          );
        }
        skipHistory.set(f, v);
      }

      pages.push({ index: i, total: j.total, hasMore: j.hasMore, exhausted: j.exhausted, nextAfter: j.nextAfter, perFile });
      if (!j.hasMore) return { pages, delivered, unique: seen.size, duplicates, skipHistory, terminated: true };

      after = j.nextAfter;
      done = j.exhausted || [];
    }
    return { pages, delivered, unique: seen.size, duplicates, skipHistory, terminated: false };
  }

  test('多檔走查必須在有限頁數內終止（這正是先前的 bug）', async () => {
    // 上限：總命中 8100 / 頁面大小 1500 = 6 頁的理論下限，放寬到 12 頁仍應足以完成。
    // 若游標遺失導致重掃，走查永遠不會回報 hasMore=false，此斷言會直接失敗。
    const r = await walkAllPages('法', 12);
    assert.equal(
      r.terminated,
      true,
      `走查必須終止（12 頁內回報 hasMore=false），實際走完 ${r.pages.length} 頁仍未終止；` +
        '若已耗盡的檔案未保留游標，它會從頭重掃而永不結束'
    );
  });

  test('走查期間不得有任何重複命中，且交付數等於語料總命中數', async () => {
    const r = await walkAllPages('法', 12);
    assert.equal(r.duplicates, 0, `整趟走查不得有重複命中，實際 duplicates=${r.duplicates}`);
    assert.equal(r.unique, TOTAL_HITS, `唯一命中數應等於語料總命中數 ${TOTAL_HITS}`);
    assert.equal(r.delivered, TOTAL_HITS, `交付總數應等於語料總命中數 ${TOTAL_HITS}`);
  });

  test('[核心] 只帶 after（不傳 done）的走查也必須終止且零重複 — 耗盡檔案不得從頭重掃', async () => {
    // 這正是原始 bug 的觸發情境：若 nextAfter 只寫入 truncated 的檔案，已耗盡的
    // 檔案在下一頁缺鍵 → skipFor 回退為 0 → 從第 1 筆重來，走查永不終止。
    // 注意 done 缺席時 fix 2 無法遮蔽 fix 1，故此測試是 fix 1 的真正守門員。
    const r = await walkAllPages('法', 12, false);
    assert.equal(
      r.terminated,
      true,
      `after-only 走查必須在 12 頁內終止，實際走完 ${r.pages.length} 頁仍未終止（耗盡檔案被重掃）`
    );
    assert.equal(r.duplicates, 0, `after-only 走查不得有重複命中，實際 duplicates=${r.duplicates}`);
    assert.equal(r.unique, TOTAL_HITS, `after-only 唯一命中數應等於 ${TOTAL_HITS}`);
    assert.equal(r.delivered, TOTAL_HITS, `after-only 交付總數應等於 ${TOTAL_HITS}`);
    // 每個檔案都必須有回報游標（含耗盡者），否則游標在客戶端就遺失了。
    for (const name of Object.keys(FILE_HITS)) {
      const rel = 'dict:' + name;
      const last = r.skipHistory.get(rel);
      assert.equal(typeof last, 'number', `耗盡檔 ${rel} 仍必須回報最終游標（否則下一頁會從 0 重掃）`);
      assert.equal(last, FILE_HITS[name], `${rel} 的最終游標應等於其總命中數 ${FILE_HITS[name]}`);
    }
  });

  test('hasMore 僅在最後一頁為 false', async () => {
    const r = await walkAllPages('法', 12);
    for (let i = 0; i < r.pages.length; i++) {
      const isLast = i === r.pages.length - 1;
      assert.equal(
        r.pages[i].hasMore,
        !isLast,
        `第 ${i + 1} 頁 hasMore 應為 ${!isLast}（只有最後一頁可為 false）`
      );
    }
  });

  test('已耗盡的檔案會出現在 exhausted，且之後不再被掃描、不再貢獻結果', async () => {
    const r = await walkAllPages('法', 12);
    const exhaustedAt = new Map(); // file -> page index where it first became exhausted
    for (const p of r.pages) {
      for (const f of p.exhausted || []) {
        if (!exhaustedAt.has(f)) exhaustedAt.set(f, p.index);
      }
      // 一旦某檔被標為 exhausted，之後的每一頁都必須繼續回報它（累積語意）。
      for (const [f, at] of exhaustedAt) {
        assert.ok(
          (p.exhausted || []).includes(f),
          `檔案 ${f} 自第 ${at + 1} 頁起即已耗盡，第 ${p.index + 1} 頁的 exhausted 仍必須包含它（需跨頁累積）`
        );
      }
    }
    // 所有檔案最終都必須被標為耗盡。
    for (const name of Object.keys(FILE_HITS)) {
      const rel = 'dict:' + name;
      assert.ok(exhaustedAt.has(rel), `檔案 ${rel} 最終應被回報為 exhausted`);
    }
    // 耗盡之後不得再出現該檔的結果。
    for (const p of r.pages) {
      for (const f of p.exhausted || []) {
        const at = exhaustedAt.get(f);
        if (at !== undefined && p.index > at) {
          assert.ok(
            !p.perFile[f],
            `檔案 ${f} 已於第 ${at + 1} 頁耗盡，第 ${p.index + 1} 頁不得再回傳它的結果`
          );
        }
      }
    }
  });

  test('已耗盡的檔案確實被排除在掃描之外（下一頁起不再出現在 nextAfter 的掃描集合）', async () => {
    // 明確以 done 參數重放：把全部檔案標為 done 後，不應再有任何結果或掃描。
    const allDone = Object.keys(FILE_HITS).map(n => 'dict:' + n);
    const j = await getJson(
      `/api/dict-search?q=${encodeURIComponent('法')}&s2t=1&done=${encodeURIComponent(allDone.join(','))}`
    );
    assert.equal(j.total, 0, '所有檔案皆 done 時不得回傳任何結果');
    assert.equal(j.results.length, 0, '所有檔案皆 done 時 results 應為空');
    assert.equal(j.hasMore, false, '所有檔案皆 done 時 hasMore 必須為 false');
    assert.deepEqual(
      (j.exhausted || []).slice().sort(),
      allDone.slice().sort(),
      'done 清單必須原樣保留在 exhausted 中，讓客戶端能繼續傳遞'
    );
  });

  test('缺鍵/壞值的 after 與 done 不得使走查重啟或崩潰', async () => {
    const variants = [
      'notjson', '[]', '"x"', '{"dict:A辭典.md":-5}', '{"dict:A辭典.md":"abc"}', '{"dict:A辭典.md":1e309}',
    ];
    for (const bad of variants) {
      const j = await getJson(`/api/dict-search?q=${encodeURIComponent('法')}&s2t=1&after=${encodeURIComponent(bad)}`);
      assert.equal(j.total > 0, true, `after=${bad} 應被視為第 1 頁而非錯誤`);
      assert.equal(j.results[0].file, 'dict:A辭典.md', `after=${bad} 應回到第 1 頁起點`);
    }
    // done 的非法值（未知檔名、空字串、路徑跳脫）必須被忽略，不得讓回應變成 0 筆。
    for (const badDone of ['nope.md', ',,', '../../../etc/passwd', 'dict:A辭典.md']) {
      const j = await getJson(`/api/dict-search?q=${encodeURIComponent('法')}&s2t=1&done=${encodeURIComponent(badDone)}`);
      assert.ok(j.total > 0 || badDone === 'dict:A辭典.md', `done=${badDone} 的未知項應被忽略`);
      assert.equal(j.results.some(r => r.file === 'dict:A辭典.md'), badDone !== 'dict:A辭典.md',
        `done=${badDone} 時 A 檔的可見性應符合預期`);
    }
  });

  test('單一檔案的 after-only 客戶端（不傳 done）仍不會重啟該檔', async () => {
    // 只帶 after、完全不帶 done：exhausted 檔案的游標仍會被 carried forward，
    // 因此不會從 0 重掃（這是 fix 1 的核心保證）。
    const base = `/api/dict-search?q=${encodeURIComponent('法')}&s2t=1&files=${encodeURIComponent('dict:C辭典.md')}`;
    const p1 = await getJson(base);
    assert.equal(p1.total, 300, 'C 檔共 300 筆，第一頁即全數交付');
    assert.equal(p1.hasMore, false, 'C 檔不足一頁，第一頁即耗盡');
    assert.equal(p1.nextAfter['dict:C辭典.md'], 300, '耗盡檔仍必須回報最終游標 300');
    // 帶著最終游標再請求一次，必須是空的（不得從頭重來）。
    const p2 = await getJson(base + `&after=${encodeURIComponent(JSON.stringify(p1.nextAfter))}`);
    assert.equal(p2.total, 0, '以最終游標續查應為 0 筆，不得重啟');
    assert.equal(p2.hasMore, false, '重複查詢已耗盡檔時 hasMore 應為 false');
  });
});
