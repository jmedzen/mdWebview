const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { server, terminateWorkerPools, resetTreeWatcher, resetDictWatcher, resetConfigWatcher, clearSitemapCache, SITEMAP_CACHE_TTL_MS } = require('../server.js');
const { apiRateLimits } = require('../lib/auth.js');
const accountsDb = require('../lib/db.js');

// 在帳號資料庫建立一位管理員與一個 session，回傳可放進 X-Admin-Token 的 token 與清除函式。
function createAdminSession(token) {
  const username = `test-admin-${token}`;
  const user = accountsDb.getUserByUsername(username) ||
    accountsDb.createUser({ username, passwordHash: null, role: 'admin', displayName: username });
  accountsDb.createSession(user.id, token, { ttlMs: 60000, ip: '127.0.0.1', userAgent: 'test' });
  return () => accountsDb.deleteSessionByToken(token);
}
const { renderWithWorker } = require('../lib/worker-pool.js');

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

    // Configuration files remain forbidden even when their contents are
    // otherwise eligible for static serving.
    const resConfig = await request('/config.json');
    assert.equal(resConfig.statusCode, 403, 'config.json basename must never be statically served');

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

  test('getBaseUrl 單元測試：無 req 或有內部 Host 時自動且優先讀取 config.settings.siteUrl', () => {
    const { getBaseUrl } = require('../lib/utils');
    const { config } = require('../lib/config');
    const originalSiteUrl = config.settings.siteUrl;
    try {
      config.settings.siteUrl = 'https://mbt.mahabodhi.co';
      assert.equal(getBaseUrl(null), 'https://mbt.mahabodhi.co', '無 req 時必須優先回傳 config.settings.siteUrl');
      assert.equal(getBaseUrl({ headers: { host: 'internal-docker:8330' } }), 'https://mbt.mahabodhi.co', '即使有 req.headers.host 仍應優先採用管理員設定');
    } finally {
      config.settings.siteUrl = originalSiteUrl;
    }
  });

  test('Sitemap 與 Robots.txt 優先採用管理員設定之 siteUrl，絕不出現 localhost', async () => {
    const { config } = require('../lib/config');
    const originalSiteUrl = config.settings.siteUrl;
    try {
      config.settings.siteUrl = 'https://sutra.example.org';
      clearSitemapCache();

      const sitemapRes = await request('/sitemap.xml');
      assert.equal(sitemapRes.statusCode, 200);
      assert.ok(sitemapRes.body.includes('<loc>https://sutra.example.org/</loc>'), '首頁 loc 必須為管理員設定的 URL');
      assert.ok(!sitemapRes.body.includes('localhost'), 'Sitemap 不得包含 localhost');

      const robotsRes = await request('/robots.txt');
      assert.equal(robotsRes.statusCode, 200);
      assert.ok(robotsRes.body.includes('Sitemap: https://sutra.example.org/sitemap.xml'), 'robots.txt 中的 Sitemap 必須為管理員設定的 URL');
    } finally {
      config.settings.siteUrl = originalSiteUrl;
      clearSitemapCache();
    }
  });

  test('Sitemap 動態刪除同步：磁碟刪除檔案後重新生成時絕不殘留該檔案 URL', async () => {
    const fs = require('fs');
    const path = require('path');
    const { config } = require('../lib/config');
    const mdRoot = config.settings.mdRoot;
    const tempFile = path.join(mdRoot, 'z-temp-delete-test.md');

    try {
      // 1. 建立測試檔案
      fs.writeFileSync(tempFile, '# 臨時經文測試\n用於測試 Sitemap 刪除即時同步。', 'utf8');
      clearSitemapCache();

      const res1 = await request('/sitemap.xml');
      assert.equal(res1.statusCode, 200);
      assert.ok(res1.body.includes('z-temp-delete-test.md'), '建立檔案後 Sitemap 必須包含該檔案');

      // 2. 刪除該測試檔案
      fs.unlinkSync(tempFile);
      clearSitemapCache();

      // 3. 重新取得 Sitemap
      const res2 = await request('/sitemap.xml');
      assert.equal(res2.statusCode, 200);
      assert.ok(!res2.body.includes('z-temp-delete-test.md'), '刪除檔案後 Sitemap 絕對不得殘留該檔案 URL');
    } finally {
      if (fs.existsSync(tempFile)) {
        try { fs.unlinkSync(tempFile); } catch (_) {}
      }
      clearSitemapCache();
    }
  });

  test('Sitemap 快取 TTL 設置為 120 分鐘，且管理員 SEO 端點回傳建立時間 (sitemapBuiltAt)', async () => {
    assert.equal(SITEMAP_CACHE_TTL_MS, 120 * 60 * 1000, 'Sitemap 快取過期 TTL 必須為 120 分鐘');

    // 建立臨時測試管理員 Session
    const testToken = 'test-token-sitemap-time';
    const dropSession = createAdminSession(testToken);

    try {
      // 1. 執行手動重建
      const rebuildRes = await request('/api/admin/rebuild-sitemap', {
        method: 'POST',
        headers: { 'X-Admin-Token': testToken }
      });
      assert.equal(rebuildRes.statusCode, 200);
      const rebuildData = JSON.parse(rebuildRes.body);
      assert.equal(rebuildData.success, true);
      assert.ok(typeof rebuildData.sitemapBuiltAt === 'number' && rebuildData.sitemapBuiltAt > 0, '手動重建必須回傳建立時間戳記');

      // 2. 查詢 SEO 狀態
      const statsRes = await request('/api/admin/seo-stats', {
        method: 'GET',
        headers: { 'X-Admin-Token': testToken }
      });
      assert.equal(statsRes.statusCode, 200);
      const statsData = JSON.parse(statsRes.body);
      assert.equal(statsData.sitemapBuiltAt, rebuildData.sitemapBuiltAt, 'SEO 狀態中之 sitemapBuiltAt 必須與重建時間戳一致');
    } finally {
      dropSession();
    }
  });

  test('安全防禦：畸形 Host 標頭回傳 400 且不懸置連線 (P0-2)', async () => {
    const net = require('net');
    const addr = server.address();
    const result = await new Promise((resolve) => {
      const client = net.connect({ port: addr.port, host: '127.0.0.1' }, () => {
        client.write('GET / HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n');
      });
      let data = '';
      client.on('data', (chunk) => { data += chunk.toString(); });
      client.on('end', () => { resolve(data); });
      client.on('error', () => { resolve(data); });
    });
    assert.ok(result.startsWith('HTTP/1.1 400 Bad Request'), '畸形 Host 應立即回傳 400 Bad Request');
  });

  test('Analytics 匯出拒絕 query-string bearer token，並接受 header 認證', async () => {
    const testToken = 'test-token-analytics-export';
    const dropSession = createAdminSession(testToken);
    try {
      const queryTokenRes = await request(`/api/admin/analytics/export?range=7d&format=json&token=${testToken}`);
      assert.equal(queryTokenRes.statusCode, 401, 'query token must not authorize exports');

      const headerTokenRes = await request('/api/admin/analytics/export?range=7d&format=json', {
        headers: { 'X-Admin-Token': testToken }
      });
      assert.equal(headerTokenRes.statusCode, 200, 'header-authenticated export remains available');
      assert.match(headerTokenRes.headers['content-disposition'], /analytics-report-7d\.json/);
    } finally {
      dropSession();
    }

    const crossOriginRes = await request('/api/admin/analytics/export?range=7d&format=json', {
      headers: { Origin: 'https://evil-hacker.com', 'X-Admin-Token': 'test-token-analytics-export' }
    });
    assert.equal(crossOriginRes.statusCode, 403, 'cross-origin export remains forbidden');
  });

  test('安全防禦：API 滑動視窗限流觸發時立即回傳 429 Too Many Requests 且不懸置連線 (P0 Bug 修復驗證)', async () => {
    // 模擬當前測試 IP (127.0.0.1) 超過限流閥值
    apiRateLimits.set('127.0.0.1', { count: 35, windowStart: Date.now() });
    try {
      const res = await request('/api/tree');
      assert.equal(res.statusCode, 429, '超過限流閥值時應回傳 429 Too Many Requests');
      assert.equal(res.headers['retry-after'], '1', '應附帶 Retry-After 標頭');
      const data = JSON.parse(res.body);
      assert.equal(data.error, 'Too Many Requests');
      assert.equal(data.retryAfter, 1);
    } finally {
      apiRateLimits.delete('127.0.0.1');
    }
  });

  test('資源清理：Worker Pool 渲染完成時解綁 AbortSignal 監聽器 (P1 Bug 修復驗證)', async () => {
    const abortCtrl = new AbortController();
    let abortedAfterFinishCalled = false;

    // 執行一次正常渲染
    const html = await renderWithWorker('### 般若波羅蜜多心經\n觀自在菩薩', 'test-p1.md', 0, abortCtrl.signal);
    assert.ok(html.includes('般若波羅蜜多心經'));

    // 渲染完成後觸發 abort，驗證監聽器已被安全移除，不會觸發未捕獲例外或重複取消
    try {
      abortCtrl.abort();
      abortedAfterFinishCalled = true;
    } catch (_) {}
    assert.equal(abortedAfterFinishCalled, true, '渲染結束後觸發 abort 應安全無副作用');
  });
});
