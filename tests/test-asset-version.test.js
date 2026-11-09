/**
 * 前端資源指紋（lib/asset-version.js）與靜態資源快取政策。
 *
 * 要守住的問題：使用者的瀏覽器一直拿舊程式。根因是 ?v= 只用 package.json 版本號，
 * 而 ?v= 的資源被標成 immutable（一年內不再問伺服器）；dev 每次 push 都不升版，
 * 於是 `app.js?v=4.31.8` 永遠是第一次載入的那一版。
 *
 *   A. 單元：指紋隨「前端檔案內容」改變（含同樣大小的修改），不隨無關檔案或單純 mtime 改變。
 *   B. 整合：首頁 ?v=、sw.js 的 CACHE_VERSION、/api/version 三者同源；
 *            Cache-Control 依「請求網址」決定，與誰先請求無關；ETag 為內容雜湊。
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { createAssetVersioner, listClientFiles } = require('../lib/asset-version.js');

// ─────────────────────────────────────────────────────────────────────────────
// A. 單元
// ─────────────────────────────────────────────────────────────────────────────
function makeTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdw-asset-version-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

const BASE_FILES = {
  'app.js': 'console.log("app v1");',
  'style.css': 'body{color:red}',
  'index.html': '<html></html>',
  'sw.js': "const CACHE_VERSION = 'v__APP_VERSION__';",
  'i18n/zh-TW.js': 'window.zhTW={};',
  'vendor/lib/lib.js': 'var lib=1;',
  // 以下不應納入指紋
  'server.js': 'require("http")',
  'render-worker.js': 'worker',
  'package.json': '{"version":"1.0.0"}',
  'README.md': '# readme',
  'ARCHITECTURE.md': '# arch',
  'lib/helper.js': 'module.exports=1',
  'tests/x.test.js': 'test',
  '.hidden.js': 'hidden',
};

/** 可手動推進的時鐘，讓 TTL 行為確定性。 */
function makeClock() {
  let t = 1000000;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe('A. createAssetVersioner：指紋隨前端內容改變', () => {
  test('格式為 <版本>-<10 位十六進位>，且相同內容結果穩定', () => {
    const root = makeTree(BASE_FILES);
    const clock = makeClock();
    const a = createAssetVersioner({ root, appVersion: '1.2.3', now: clock.now });
    const id = a.get();
    assert.match(id, /^1\.2\.3-[0-9a-f]{10}$/);
    clock.advance(60000);
    assert.equal(a.get(), id);
    // 另一個實例、相同內容 → 相同指紋（多容器部署各自算出一致的值）
    assert.equal(createAssetVersioner({ root, appVersion: '1.2.3' }).get(), id);
  });

  test('「同樣大小」的修改也會改變指紋（不能只看 size / 版本號）', () => {
    const root = makeTree(BASE_FILES);
    const clock = makeClock();
    const a = createAssetVersioner({ root, appVersion: '1.0.0', now: clock.now });
    const before = a.get();
    // v1 → v2：位元組數完全相同
    fs.writeFileSync(path.join(root, 'app.js'), 'console.log("app v2");');
    clock.advance(10000);
    assert.notEqual(a.get(), before);
  });

  test('i18n 與 vendor 內的檔案變動同樣會改變指紋', () => {
    for (const rel of ['i18n/zh-TW.js', 'vendor/lib/lib.js', 'style.css', 'index.html', 'sw.js']) {
      const root = makeTree(BASE_FILES);
      const clock = makeClock();
      const a = createAssetVersioner({ root, appVersion: '1.0.0', now: clock.now });
      const before = a.get();
      fs.appendFileSync(path.join(root, rel), '\n// edit');
      clock.advance(10000);
      assert.notEqual(a.get(), before, `${rel} 變動應改變指紋`);
    }
  });

  test('新增前端檔案會改變指紋（不靠手寫清單登記）', () => {
    const root = makeTree(BASE_FILES);
    const clock = makeClock();
    const a = createAssetVersioner({ root, appVersion: '1.0.0', now: clock.now });
    const before = a.get();
    fs.writeFileSync(path.join(root, 'new-feature.js'), 'x');
    clock.advance(10000);
    assert.notEqual(a.get(), before);
  });

  test('伺服器端程式、文件、lib/、tests/、隱藏檔不納入指紋', () => {
    const root = makeTree(BASE_FILES);
    const files = listClientFiles(root);
    assert.deepEqual(files, [
      'app.js', 'i18n/zh-TW.js', 'index.html', 'style.css', 'sw.js', 'vendor/lib/lib.js'
    ]);

    const clock = makeClock();
    const a = createAssetVersioner({ root, appVersion: '1.0.0', now: clock.now });
    const before = a.get();
    fs.appendFileSync(path.join(root, 'server.js'), '\n// backend only');
    fs.appendFileSync(path.join(root, 'ARCHITECTURE.md'), '\nmore docs');
    fs.appendFileSync(path.join(root, 'lib/helper.js'), '\n// server lib');
    fs.appendFileSync(path.join(root, 'package.json'), '\n');
    clock.advance(10000);
    assert.equal(a.get(), before, '與瀏覽器無關的檔案改動不該讓全站快取失效');
  });

  test('只改 mtime、內容不變 → 指紋不變', () => {
    const root = makeTree(BASE_FILES);
    const clock = makeClock();
    const a = createAssetVersioner({ root, appVersion: '1.0.0', now: clock.now });
    const before = a.get();
    const future = new Date(Date.now() + 3600 * 1000);
    fs.utimesSync(path.join(root, 'app.js'), future, future);
    clock.advance(10000);
    assert.equal(a.get(), before);
  });

  test('TTL 內不重新檢查檔案；過了 TTL 才發現變動', () => {
    const root = makeTree(BASE_FILES);
    const clock = makeClock();
    const a = createAssetVersioner({ root, appVersion: '1.0.0', ttlMs: 5000, now: clock.now });
    const before = a.get();
    fs.writeFileSync(path.join(root, 'app.js'), 'console.log("app v2");');
    clock.advance(4999);
    assert.equal(a.get(), before, 'TTL 內回傳快取值（請求路徑不做檔案 I/O）');
    clock.advance(2);
    assert.notEqual(a.get(), before, '過了 TTL 應反映新內容');
  });

  test('升版號本身也會反映在指紋字首', () => {
    const root = makeTree(BASE_FILES);
    const a = createAssetVersioner({ root, appVersion: '1.0.0' }).get();
    const b = createAssetVersioner({ root, appVersion: '1.0.1' }).get();
    assert.ok(a.startsWith('1.0.0-') && b.startsWith('1.0.1-'));
    assert.equal(a.split('-')[1], b.split('-')[1], '雜湊只取決於檔案內容');
  });

  test('目錄不存在時退回純版本號，不拋錯', () => {
    const a = createAssetVersioner({ root: path.join(os.tmpdir(), 'mdw-no-such-dir-' + process.pid), appVersion: '9.9.9' });
    const id = a.get();
    assert.match(id, /^9\.9\.9(-[0-9a-f]{10})?$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. 整合（in-process server，沿用 test-server-api 的啟動方式）
// ─────────────────────────────────────────────────────────────────────────────
const { server, terminateWorkerPools, resetTreeWatcher, resetDictWatcher, resetConfigWatcher } = require('../server.js');
const { APP_VERSION } = require('../lib/constants.js');
const { getAssetVersion } = require('../lib/asset-version.js');
const { contentEtag, staticCacheControl } = require('../lib/static-cache.js');

let baseUrl = '';

function request(p, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(p, baseUrl), { method, agent: false, headers: { Connection: 'close', ...headers } }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('B. 伺服器：指紋、sw.js、/api/version 同源，Cache-Control 依請求網址決定', () => {
  before(async () => {
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (typeof resetTreeWatcher === 'function') resetTreeWatcher();
    if (typeof resetDictWatcher === 'function') resetDictWatcher();
    if (typeof resetConfigWatcher === 'function') resetConfigWatcher();
    if (typeof terminateWorkerPools === 'function') await terminateWorkerPools();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  test('GET /api/version 回傳版本與資源指紋，且永不快取', async () => {
    const res = await request('/api/version');
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /application\/json/);
    assert.equal(res.headers['cache-control'], 'no-store');
    const data = JSON.parse(res.body);
    assert.equal(data.version, APP_VERSION);
    assert.equal(data.assetVersion, getAssetVersion());
    assert.match(data.assetVersion, new RegExp(`^${APP_VERSION.replace(/\./g, '\\.')}-[0-9a-f]{10}$`));

    const head = await request('/api/version', {}, 'HEAD');
    assert.equal(head.statusCode, 200);
    assert.equal(head.body, '');
  });

  test('首頁：資源 ?v= 與 __APP_CONFIG__.assetVersion 皆為資源指紋，畫面版本顯示仍是純版本號', async () => {
    const asset = getAssetVersion();
    const res = await request('/');
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'no-cache', 'HTML 必須每次重新驗證');
    assert.equal(res.headers.etag, undefined, 'HTML 帶每次不同的 CSP nonce，不可有 ETag/304');

    assert.ok(!res.body.includes('__APP_VERSION__'), '佔位符必須全部被換掉');
    for (const f of ['app.js', 'style.css', 'i18n/boot.js', 'marked.min.js', 'kepan-sidebar.js']) {
      assert.ok(res.body.includes(`${f}?v=${asset}`), `${f} 的 ?v= 應為資源指紋 ${asset}`);
    }
    const versions = new Set([...res.body.matchAll(/\?v=([^"'&>\s]+)/g)].map(m => m[1]));
    assert.deepEqual([...versions], [asset], '所有 ?v= 必須同一個指紋，否則會新舊混用');

    assert.ok(res.body.includes(`"assetVersion":"${asset}"`), '__APP_CONFIG__ 應帶 assetVersion 供前端比對');
    assert.ok(res.body.includes(`"appVersion":"${APP_VERSION}"`));
    assert.ok(res.body.includes(`v${APP_VERSION}</strong>`), '系統頁顯示的版本仍是純版本號');
  });

  test('sw.js：CACHE_VERSION 取資源指紋、不快取、允許全站範圍', async () => {
    const asset = getAssetVersion();
    const res = await request('/sw.js');
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'no-cache, no-store, must-revalidate');
    assert.equal(res.headers['service-worker-allowed'], '/');
    assert.ok(res.body.includes(`const CACHE_VERSION = 'v${asset}';`));
    assert.ok(!res.body.includes('__APP_VERSION__'));
  });

  test('帶「目前指紋」的 ?v= → immutable；其他 ?v= 與無 ?v= → no-cache', async () => {
    const asset = getAssetVersion();
    const cur = await request(`/app.js?v=${asset}`);
    assert.equal(cur.statusCode, 200);
    assert.equal(cur.headers['cache-control'], 'public, max-age=31536000, immutable');

    const old = await request('/app.js?v=0.0.1-deadbeef00');
    assert.equal(old.statusCode, 200);
    assert.equal(old.headers['cache-control'], 'no-cache', '過期指紋回的是現在的內容，不能被釘成 immutable');

    const bare = await request('/app.js');
    assert.equal(bare.headers['cache-control'], 'no-cache');
  });

  test('Cache-Control 與「誰先請求」無關（記憶體快取項目不可帶走先到者的政策）', async () => {
    const asset = getAssetVersion();
    // 先以無 ?v= 的網址把 style.css 放進記憶體快取，再用帶指紋的網址請求
    const bare = await request('/style.css');
    assert.equal(bare.headers['cache-control'], 'no-cache');
    const versioned = await request(`/style.css?v=${asset}`);
    assert.equal(versioned.headers['cache-control'], 'public, max-age=31536000, immutable');
    const bareAgain = await request('/style.css');
    assert.equal(bareAgain.headers['cache-control'], 'no-cache');
  });

  test('ETag 為內容雜湊，304 也帶出依請求網址決定的 Cache-Control', async () => {
    const asset = getAssetVersion();
    const first = await request(`/marked.min.js?v=${asset}`);
    assert.match(first.headers.etag, /^W\/"[0-9a-f]{20}"$/);

    const second = await request(`/marked.min.js?v=${asset}`, { 'If-None-Match': first.headers.etag });
    assert.equal(second.statusCode, 304);
    assert.equal(second.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(second.headers.etag, first.headers.etag);

    // 同一個檔案、不同網址：ETag 相同（只取決於內容），Cache-Control 各自正確
    const bare = await request('/marked.min.js', { 'If-None-Match': first.headers.etag });
    assert.equal(bare.statusCode, 304);
    assert.equal(bare.headers['cache-control'], 'no-cache');
  });

  test('md-worker.js 與其 importScripts 目標都以版本化網址取得', async () => {
    const asset = getAssetVersion();
    const worker = await request(`/md-worker.js?v=${asset}`);
    assert.equal(worker.statusCode, 200);
    assert.equal(worker.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.ok(worker.body.includes("importScripts('marked.min.js' + ((self.location && self.location.search) || ''))"));
  });
});

describe('contentEtag / staticCacheControl 純函式', () => {
  test('contentEtag：同大小不同內容 → 不同；同內容 → 相同（不依賴 mtime）', () => {
    const a = contentEtag(Buffer.from('console.log("v1");'));
    const b = contentEtag(Buffer.from('console.log("v2");'));
    assert.notEqual(a, b);
    assert.equal(a, contentEtag(Buffer.from('console.log("v1");')));
    assert.match(a, /^W\/"[0-9a-f]{20}"$/);
  });

  test('staticCacheControl：各種網址形態', () => {
    const cur = getAssetVersion();
    assert.equal(staticCacheControl(`/app.js?v=${cur}`, '.js'), 'public, max-age=31536000, immutable');
    assert.equal(staticCacheControl(`/i18n/boot.js?x=1&v=${cur}`, '.js'), 'public, max-age=31536000, immutable');
    assert.equal(staticCacheControl('/app.js?v=old', '.js'), 'no-cache');
    assert.equal(staticCacheControl('/app.js?v=', '.js'), 'no-cache');
    assert.equal(staticCacheControl('/app.js', '.js'), 'no-cache');
    assert.equal(staticCacheControl('/style.css', '.css'), 'no-cache');
    assert.equal(staticCacheControl('/og-preview.png', '.png'), 'public, max-age=86400');
    assert.equal(staticCacheControl(`/icon-192.png?v=${cur}`, '.png'), 'public, max-age=31536000, immutable');
    assert.equal(staticCacheControl('/%E0%A4%A', '.js'), 'no-cache', '壞掉的網址不得拋錯');
  });
});
