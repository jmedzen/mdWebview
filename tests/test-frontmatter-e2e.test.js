/**
 * 迴歸測試：YAML frontmatter 造成的行號偏移（端對端，真正走 server.js 的 handleRender）
 *
 * 背景：/api/search 掃描的是「原始檔」（含 frontmatter），行號為原始檔行號；
 * 但修正前 handleRender 剝離 frontmatter 後以 lineOffset = 0 交給 render-worker，
 * 導致渲染出的 data-line 錨點比原始行號少了「frontmatter 行數」。
 * 前端以 getElementById('L' + line) 跳轉，因此點擊搜尋結果會落到下方數個段落。
 *
 * 本測試刻意以真正的 HTTP 伺服器驗證 /api/search 與 /api/render 的行號完全一致，
 * 這是單純呼叫 stripFrontmatter/renderWithWorker 的單元測試無法覆蓋的（handleRender 的接線）。
 *
 * 注意：必須在 require('../server.js') 之前設定環境變數，且 LOG_DIR/CONFIG_PATH 都要指向
 * 臨時目錄；否則伺服器會把臨時 vault 的索引寫回專案 logs/ 並覆蓋真正的索引快取
 * （lib/config.js 的合併順序是：預設值 → 專案 config.json → CONFIG_PATH，
 *   所以 MD_ROOT 環境變數會被專案 config.json 覆寫，必須用 CONFIG_PATH 指定 mdRoot）。
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mdweb-fm-e2e-'));
const tmpVault = path.join(tmpRoot, 'vault');
const tmpLogs = path.join(tmpRoot, 'logs');
const tmpConfig = path.join(tmpRoot, 'config.json');
fs.mkdirSync(tmpVault, { recursive: true });
fs.mkdirSync(tmpLogs, { recursive: true });
fs.writeFileSync(tmpConfig, JSON.stringify({ settings: { mdRoot: tmpVault } }), 'utf-8');

process.env.LOG_DIR = tmpLogs;
process.env.CONFIG_PATH = tmpConfig;
process.env.MD_ROOT = tmpVault;

const {
  server,
  terminateWorkerPools,
  resetTreeWatcher,
  resetDictWatcher,
  resetConfigWatcher
} = require('../server.js');

const FM_LINES = 9;          // frontmatter 佔第 1~9 行
const MARKER_LINE = 40;      // 命中文字所在的原始檔行號
const DOC_REL = 'doc.md';
const MARKER = '怎麼樣學習佛法呢就是聞思修這三個方法';

let baseUrl = '';

function request(pathname, queryObj) {
  const url = new URL(pathname, baseUrl);
  for (const [k, v] of Object.entries(queryObj || {})) url.searchParams.set(k, v);
  return new Promise((resolve, reject) => {
    const req = http.request(url, { agent: false, headers: { Connection: 'close' } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('Frontmatter 行號偏移端對端迴歸測試 (/api/search 行號 === /api/render 錨點)', () => {
  before(async () => {
    // 建立含 9 行 frontmatter 的文件，命中文字刻意落在原始檔第 40 行
    const lines = [
      '---',
      'title: 測試經文',
      '講者: 玅境長老',
      '經名: 維摩詰所說經',
      '品次: 佛國品第一',
      '類型: 筆錄',
      '年份: 2000',
      '地點: 法雲寺禪學院',
      '---'
    ];
    while (lines.length < MARKER_LINE - 1) {
      lines.push(`這是第${lines.length + 1}行前置段落。`);
    }
    lines.push(MARKER);   // 第 40 行
    lines.push('命中之後的段落。');
    fs.writeFileSync(path.join(tmpVault, DOC_REL), lines.join('\n') + '\n', 'utf-8');

    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    }));
  });

  after(async () => {
    // 與 test-server-api.test.js 相同的收尾：fs.watch／worker pool 若未關閉會讓事件迴圈無法結束。
    if (typeof resetTreeWatcher === 'function') resetTreeWatcher();
    if (typeof resetDictWatcher === 'function') resetDictWatcher();
    if (typeof resetConfigWatcher === 'function') resetConfigWatcher();
    if (typeof terminateWorkerPools === 'function') await terminateWorkerPools();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
  });

  test('frontmatter 不得讓渲染錨點落後原始檔行號', async () => {
    // 1) 搜尋回報的行號必須是原始檔行號
    const s = await request('/api/search', { q: MARKER, mode: 'loose', s2t: '0' });
    assert.equal(s.statusCode, 200, `search HTTP ${s.statusCode}`);
    const searchData = JSON.parse(s.body);
    assert.equal(searchData.total, 1, '應恰好命中 1 筆');
    assert.equal(searchData.results[0].line, MARKER_LINE,
      `/api/search 回報行號應為原始檔第 ${MARKER_LINE} 行，實際 ${searchData.results[0].line}`);

    // 2) 渲染出的 data-line 錨點必須等於同一個行號
    const r = await request('/api/render', { path: DOC_REL });
    assert.equal(r.statusCode, 200, `render HTTP ${r.statusCode}`);
    const anchorIdx = r.body.lastIndexOf('data-line="', r.body.indexOf(MARKER));
    assert.ok(anchorIdx >= 0, '渲染 HTML 應在命中文字之前帶有 data-line 錨點');
    const anchor = parseInt(r.body.slice(anchorIdx + 11, r.body.indexOf('"', anchorIdx + 11)), 10);

    assert.equal(anchor, searchData.results[0].line,
      `渲染錨點 (${anchor}) 必須等於搜尋行號 (${searchData.results[0].line})，` +
      `相差即為 frontmatter 行數偏移（frontmatter 共 ${FM_LINES} 行）`);
    assert.equal(anchor, MARKER_LINE, `渲染錨點必須等於原始檔第 ${MARKER_LINE} 行`);
  });
});
