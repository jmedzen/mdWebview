const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { server, terminateWorkerPools, resetTreeWatcher, resetDictWatcher, resetConfigWatcher } = require('../server.js');

let baseUrl = '';

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const reqOptions = {
      agent: false,
      ...options,
      headers: {
        Connection: 'close',
        ...(options.headers || {})
      }
    };
    const req = http.request(url, reqOptions, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body
        });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

describe('HTTP 伺服器與 REST API 整合測試', () => {
  before(async () => {
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (typeof resetTreeWatcher === 'function') resetTreeWatcher();
    if (typeof resetDictWatcher === 'function') resetDictWatcher();
    if (typeof resetConfigWatcher === 'function') resetConfigWatcher();
    if (typeof terminateWorkerPools === 'function') {
      await terminateWorkerPools();
    }
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    await new Promise((resolve) => server.close(resolve));
  });

  test('GET / 首頁動態 SSR 與安全標頭', async () => {
    const res = await request('/');
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['content-type'].includes('text/html'));
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');

    // CSP 應注入 per-request nonce
    const csp = res.headers['content-security-policy'];
    assert.ok(csp, '應具備 Content-Security-Policy 標頭');
    assert.ok(csp.includes('nonce-'), 'CSP 應包含動態 nonce');

    // 內文應包含 window.__APP_CONFIG__ 注入
    assert.ok(res.body.includes('window.__APP_CONFIG__'), '應注入 APP_CONFIG 腳本');
  });

  test('GET /api/tree 取得經文檔案樹', async () => {
    const res = await request('/api/tree');
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['content-type'].includes('application/json'));
    const data = JSON.parse(res.body);
    assert.ok(Array.isArray(data), '回傳資料應為陣列');
    assert.ok(data.length > 0, '檔案樹不應為空');
  });

  test('GET /api/suggest-list 推薦經論清單', async () => {
    const res = await request('/api/suggest-list');
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.ok(Array.isArray(data.items), '應回傳 items 推薦經論清單陣列');
  });

  test('GET /api/search 全文搜尋 API 與 s2t 參數支援', async () => {
    // 測試 s2t=1
    const resTrad = await request('/api/search?q=觀自在&s2t=1');
    assert.equal(resTrad.statusCode, 200);
    const dataTrad = JSON.parse(resTrad.body);
    assert.ok(Array.isArray(dataTrad.results), '搜尋結果應包含 results 陣列');

    // 測試 s2t=0 保留原始輸入
    const resRaw = await request('/api/search?q=观自在&s2t=0');
    assert.equal(resRaw.statusCode, 200);
    const dataRaw = JSON.parse(resRaw.body);
    assert.equal(dataRaw.query, '观自在', '當 s2t=0 時，query 應保留原始簡體字串');
  });

  test('安全防禦：路徑穿越 (Path Traversal) 與敏感檔案存取防護', async () => {
    // 試圖讀取 server.js 後端源碼
    const resServer = await request('/server.js');
    assert.equal(resServer.statusCode, 403, 'server.js 應被 403 禁止存取');

    // 試圖路徑穿越讀取 package.json
    const resPkg = await request('/package.json');
    assert.equal(resPkg.statusCode, 403, 'package.json 應被 403 禁止存取');

    // 不存在檔案回傳 404
    const res404 = await request('/no-such-file-12345.xyz');
    assert.equal(res404.statusCode, 404, '不存在的資源應回傳 404');

    // 靜態檔案不支援 POST，應回傳 405
    const res405 = await request('/index.html', { method: 'POST' });
    assert.equal(res405.statusCode, 405, '靜態檔案 POST 應回傳 405 Method Not Allowed');
  });

  test('GET /sitemap.xml 格式正確且具備快取防禦與自動更新機制', async () => {
    const res = await request('/sitemap.xml');
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['content-type'].includes('application/xml'));
    assert.equal(res.headers['cache-control'], 'public, max-age=3600');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.ok(res.body.includes('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'), '應為合法 sitemap urlset');
    assert.ok(res.body.includes('<loc>'), '應包含 loc 節點');
    assert.ok(res.body.includes('<lastmod>'), '應包含 lastmod 節點');
  });
});
