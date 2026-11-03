/**
 * 迴歸測試：≥1MB 的大檔（虛擬分塊渲染）不得把 YAML frontmatter 當正文顯示。
 *
 * 背景：handleRenderChunk 的第一塊從 byte 0 開始讀，修正前沒有剝離 frontmatter，
 * marked 把開頭的 `---` 渲染成 <hr>，鍵值行加結尾 `---` 渲染成 setext <h2>。
 * 一般大小檔案走 handleRender（有剝離），所以只有大檔會出現。
 * 同時 /api/section-index 需回傳 frontmatter，讓前端頁首顯示標題與作者。
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mdweb-large-fm-'));
const tmpVault = path.join(tmpRoot, 'vault');
const tmpLogs = path.join(tmpRoot, 'logs');
const tmpConfig = path.join(tmpRoot, 'config.json');
fs.mkdirSync(tmpVault, { recursive: true });
fs.mkdirSync(tmpLogs, { recursive: true });
fs.writeFileSync(tmpConfig, JSON.stringify({ settings: { mdRoot: tmpVault } }), 'utf-8');

process.env.LOG_DIR = tmpLogs;
process.env.INDEX_DIR = tmpLogs;
process.env.CONFIG_PATH = tmpConfig;
process.env.MD_ROOT = tmpVault;

const {
  server,
  terminateWorkerPools,
  resetTreeWatcher,
  resetDictWatcher,
  resetConfigWatcher
} = require('../server.js');

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

// 刻意與使用者手寫的檔案相同：結尾 `---` 後緊接 `# 標題`，沒有空行。
function writeLarge(name, fmLines, afterFm) {
  const lines = ['---', ...fmLines, '---', ...afterFm];
  const para = '諸佛所知隱不現，皆具所有如所有，諸法真俗理圓中，處處說顯性相義。'.repeat(8);
  let n = 1;
  while (Buffer.byteLength(lines.join('\n'), 'utf-8') < 1.2 * 1024 * 1024) {
    lines.push('', `## 第${n}節`, '', para, '', para);
    n++;
  }
  fs.writeFileSync(path.join(tmpVault, name), lines.join('\n') + '\n', 'utf-8');
}

describe('大檔虛擬渲染：frontmatter 不得出現在正文', () => {
  before(async () => {
    writeLarge('a.md', ['title: "攝大乘論科釋彙正"', 'author: "無為學舍"', 'round: "六譯四釋"', 'kepan: true'],
      ['# 《攝大乘論科釋彙正．六譯四釋彙總》', '開頭段落。']);
    writeLarge('b.md', ['title: "分別瑜伽品"', 'author: "玅境長老"'], ['', '前一篇 · 目錄 · 後一篇']);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    }));
  });

  after(async () => {
    if (typeof resetTreeWatcher === 'function') resetTreeWatcher();
    if (typeof resetDictWatcher === 'function') resetDictWatcher();
    if (typeof resetConfigWatcher === 'function') resetConfigWatcher();
    if (typeof terminateWorkerPools === 'function') await terminateWorkerPools();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
  });

  for (const [file, title, firstBodyLine] of [['a.md', '攝大乘論科釋彙正', 7], ['b.md', '分別瑜伽品', 6]]) {
    test(`${file}: section-index 帶 frontmatter，第一塊不含 frontmatter 且行號對齊`, async () => {
      const si = await request('/api/section-index', { path: file });
      assert.equal(si.statusCode, 200);
      const idx = JSON.parse(si.body);
      assert.equal(idx.large, true, '應走虛擬分塊渲染');
      assert.equal(idx.frontmatter.title, title);

      const c = await request('/api/render-chunk', { path: file, from: 0, to: idx.chunks[0].to });
      assert.equal(c.statusCode, 200);
      assert.ok(!c.body.includes('title:'), '第一塊不得含 frontmatter 鍵值');
      assert.ok(!c.body.includes('author:'), '第一塊不得含 frontmatter 鍵值');
      assert.ok(!/^\s*<hr>/.test(c.body), '開頭不得出現 frontmatter 的 <hr>');
      const m = c.body.match(/data-line="(\d+)"/);
      assert.ok(m, '應有 data-line 錨點');
      assert.equal(parseInt(m[1], 10), firstBodyLine, '第一個錨點必須是原始檔正文的行號');
    });
  }
});
