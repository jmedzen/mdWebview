/**
 * @file tests/test-single-user-mode.test.js
 *
 * End-to-end verification of single-user (desktop/mobile) deployment mode.
 *
 * The server is started in a real child process with MDW_DEPLOY_TARGET=win-app
 * because that is the only honest way to test it: lib/constants.js resolves the
 * deployment mode once at require() time, so an in-process require would test
 * web mode no matter what the environment says.
 *
 * What must hold in single-user mode:
 *   - no administrator account is ever demanded (the reader must not be walled
 *     behind a first-run modal asking for a public canonical URL it cannot have)
 *   - privileged maintenance is available without a login from this machine
 *   - SEO surfaces are absent or neutralised
 *   - analytics endpoints do not exist
 *   - web-only behaviour is completely unchanged
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');

/** Start server.js in a child process and wait for its readiness line. */
function startServer(env, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT_DIR,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`server did not become ready in time. Output:\n${out}`));
    }, timeoutMs);

    const onData = (chunk) => {
      out += chunk.toString();
      const m = out.match(/MDWEBVIEW_READY port=(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ child, port: Number(m[1]), output: () => out });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early with code ${code}. Output:\n${out}`));
    });
  });
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
      resolve();
    }, 8000).unref();
  });
}

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: options.method || 'GET', headers: options.headers || {} },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

describe('單機模式（MDW_DEPLOY_TARGET=win-app）', () => {
  let child = null;
  let port = 0;
  let userData = '';

  before(async () => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mdw-single-user-'));
    const started = await startServer({
      MDW_DEPLOY_TARGET: 'win-app',
      PORT: '0',
      HOST: '127.0.0.1',
      MDW_USER_DATA: userData,
      CONFIG_PATH: path.join(userData, 'config.json'),
      LOG_DIR: path.join(userData, 'logs'),
      MD_ROOT: path.join(userData, 'md'),
      DICTIONARY_PATH: path.join(userData, 'dicts'),
      DICTIONARY_ENABLED: 'false',
      // Keep this spawned server small: several test files run concurrently and
      // CPU-derived worker pools would oversubscribe the machine.
      MDW_RENDER_POOL_SIZE: '2',
      MDW_INDEX_POOL_SIZE: '2'
    });
    child = started.child;
    port = started.port;
  });

  after(async () => {
    await stopServer(child);
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) {}
  });

  test('/api/admin/status 回報 single-user，且不需要管理員設定', async () => {
    const res = await request(port, '/api/admin/status');
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);

    assert.equal(data.authMode, 'single-user', 'authMode 必須為 single-user');
    assert.equal(data.isSingleUser, true);
    assert.equal(data.deployTarget, 'win-app');
    assert.equal(data.requiresPassword, false);

    // The client raises the first-run setup modal when isSetup is false, and that
    // modal demands a public canonical URL. Reporting true is what keeps a local
    // user from being locked out of their own reader.
    assert.equal(data.isSetup, true, '單機模式不得要求建立管理員帳號');
  });

  test('status 仍不得洩漏檔案系統路徑', async () => {
    const res = await request(port, '/api/admin/status');
    const data = JSON.parse(res.body);
    assert.equal(data.settings.mdRoot, undefined, 'mdRoot 必須被移除');
    assert.equal(data.settings.dictionaryPath, undefined, 'dictionaryPath 必須被移除');
    assert.equal(JSON.stringify(data).includes(userData), false,
      '回應不得包含使用者資料目錄路徑');
  });

  test('本機請求不需 token 即可執行維護操作（重建索引）', async () => {
    const res = await request(port, '/api/admin/rebuild-index', { method: 'POST' });
    assert.equal(res.status, 200, '本機來源的維護操作應被允許');
  });

  test('本機請求不需 token 即可讀取硬體監控', async () => {
    const res = await request(port, '/api/admin/hardware');
    assert.equal(res.status, 200);
  });

  test('單機模式拒絕建立管理員帳號（403）', async () => {
    const res = await request(port, '/api/admin/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'x', password: 'password123', siteUrl: 'https://example.org' })
    });
    assert.equal(res.status, 403, '單機模式不應允許建立管理員');
  });

  test('單機模式不使用管理員密碼（409 而非 401）', async () => {
    const res = await request(port, '/api/admin/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'a', newPassword: 'password123' })
    });
    assert.equal(res.status, 409);
    const data = JSON.parse(res.body);
    assert.equal(data.authMode, 'single-user');
  });

  test('SEO 端點：robots.txt 全面封鎖，sitemap.xml 不存在', async () => {
    const robots = await request(port, '/robots.txt');
    assert.equal(robots.status, 200);
    assert.match(robots.body, /User-agent: \*/);
    assert.match(robots.body, /Disallow: \//, '單機模式的 robots.txt 應全面封鎖');
    assert.equal(/Sitemap:/i.test(robots.body), false,
      '單機模式不應宣傳 sitemap 位置');

    const sitemap = await request(port, '/sitemap.xml');
    assert.equal(sitemap.status, 404, '單機模式不應提供 sitemap.xml');
  });

  test('數據分析端點在單機模式不存在', async () => {
    for (const p of ['/api/admin/analytics', '/api/admin/analytics/export', '/api/admin/seo-stats']) {
      const res = await request(port, p);
      assert.equal(res.status, 404, `${p} 在單機模式應回 404`);
    }
  });

  test('閱讀本體功能不受影響', async () => {
    for (const p of ['/', '/api/tree', '/app.js', '/style.css']) {
      const res = await request(port, p);
      assert.equal(res.status, 200, `${p} 應正常回應`);
    }
  });

  test('注入的頁面帶有 deployTarget 與 single-user 標記', async () => {
    const res = await request(port, '/');
    assert.equal(res.status, 200);
    assert.match(res.body, /data-deploy-target/, '頁面必須標記部署目標');
    assert.match(res.body, /"isSingleUser":true/, '注入設定必須標示單機模式');
    assert.match(res.body, /"authMode":"single-user"/);
  });

  test('單機模式的讀者不需登入即可取得經文內容', async () => {
    // The whole point of the mode: browsing must work with no credential at all.
    const tree = await request(port, '/api/tree');
    assert.equal(tree.status, 200);
  });
});

describe('線上模式（web）行為維持不變', () => {
  let child = null;
  let port = 0;
  let userData = '';

  before(async () => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mdw-web-'));
    const started = await startServer({
      MDW_DEPLOY_TARGET: 'web',
      PORT: '0',
      HOST: '127.0.0.1',
      MDW_USER_DATA: userData,
      CONFIG_PATH: path.join(userData, 'config.json'),
      LOG_DIR: path.join(userData, 'logs'),
      MD_ROOT: path.join(userData, 'md'),
      DICTIONARY_PATH: path.join(userData, 'dicts'),
      DICTIONARY_ENABLED: 'false',
      // Keep this spawned server small: several test files run concurrently and
      // CPU-derived worker pools would oversubscribe the machine.
      MDW_RENDER_POOL_SIZE: '2',
      MDW_INDEX_POOL_SIZE: '2'
    });
    child = started.child;
    port = started.port;
  });

  after(async () => {
    await stopServer(child);
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) {}
  });

  test('預設部署目標為 web，且要求建立管理員', async () => {
    const res = await request(port, '/api/admin/status');
    const data = JSON.parse(res.body);
    assert.equal(data.authMode, 'admin', 'web 模式必須要求管理員');
    assert.equal(data.isSingleUser, false);
    assert.equal(data.deployTarget, 'web');
    assert.equal(data.requiresPassword, true);
    assert.equal(data.isSetup, false, '尚未設定的 web 站台應回報 isSetup=false');
  });

  test('未登入時維護操作仍被拒絕（401）— 不得因新模式而放寬', async () => {
    for (const p of ['/api/admin/hardware', '/api/admin/logs']) {
      const res = await request(port, p);
      assert.equal(res.status, 401, `${p} 在 web 模式未登入時必須回 401`);
    }
  });

  test('未登入時重建索引仍被拒絕', async () => {
    const res = await request(port, '/api/admin/rebuild-index', { method: 'POST' });
    assert.equal(res.status, 401);
  });

  test('web 模式仍可建立管理員，且拒絕空白的 Canonical URL', async () => {
    const missingUrl = await request(port, '/api/admin/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'password123' })
    });
    assert.equal(missingUrl.status, 400, 'web 模式仍必須要求首頁權威 URL');
  });

  test('web 模式仍提供 sitemap.xml 與 robots.txt', async () => {
    const robots = await request(port, '/robots.txt');
    assert.equal(robots.status, 200);
    // Default configuration is private (noindex), so a blanket disallow is
    // expected — the point is that the web handler answers, not the stub.
    assert.match(robots.body, /User-agent: \*/);

    const sitemap = await request(port, '/sitemap.xml');
    assert.equal(sitemap.status, 200, 'web 模式必須提供 sitemap.xml');
  });

  test('web 模式的 analytics 端點存在（未登入仍為 401，而非 404）', async () => {
    const res = await request(port, '/api/admin/analytics');
    assert.equal(res.status, 401, 'web 模式 analytics 應存在但需授權');
  });
});

describe('部署模式啟動契約', () => {
  test('未知的 MDW_DEPLOY_TARGET 回退 web 並記錄警告', async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mdw-bogus-'));
    const started = await startServer({
      MDW_DEPLOY_TARGET: 'not-a-real-target',
      PORT: '0',
      HOST: '127.0.0.1',
      MDW_USER_DATA: userData,
      CONFIG_PATH: path.join(userData, 'config.json'),
      LOG_DIR: path.join(userData, 'logs'),
      MD_ROOT: path.join(userData, 'md'),
      DICTIONARY_ENABLED: 'false',
      // Keep this spawned server small: several test files run concurrently and
      // CPU-derived worker pools would oversubscribe the machine.
      MDW_RENDER_POOL_SIZE: '2',
      MDW_INDEX_POOL_SIZE: '2'
    });
    try {
      const res = await request(started.port, '/api/admin/status');
      const data = JSON.parse(res.body);
      assert.equal(data.deployTarget, 'web', '未知值必須回退 web');
      assert.equal(data.isSingleUser, false, '未知值不得意外開啟單機模式');
    } finally {
      await stopServer(started.child);
      try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) {}
    }
  });
});
