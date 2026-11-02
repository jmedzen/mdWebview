/**
 * @file tests/test-mobile-home-buttons.test.js
 *
 * 手機首頁「瀏覽全部經目」與經句下「在經藏中搜尋 →」點了沒反應的回歸測試。
 *
 * 兩個原因疊在一起：
 *   1. 開站時遮罩（#sidebarBackdrop）在側欄還沒收合前就被打開，收合後沒有同步，
 *      整個首頁蓋著一層點不穿的遮罩，第一下點擊只會被遮罩吃掉。
 *   2. #content 的「點內容區就收側欄」寫在冒泡階段：按鈕剛打開側欄，事件冒泡到
 *      #content 又立刻收掉。改成捕獲階段，先收再讓按鈕打開。
 *
 * 靜態檢查一定跑；真瀏覽器（Playwright + iPhone 觸控模擬）只在本機裝得起來時跑，
 * 否則略過，不讓沒有瀏覽器的環境失敗。
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const APP_JS = fs.readFileSync(path.join(ROOT_DIR, 'app.js'), 'utf8');

describe('手機首頁按鈕：靜態檢查', () => {
  test('#content 點擊收側欄須在捕獲階段，不可把按鈕剛打開的側欄收掉', () => {
    const m = APP_JS.match(/\$\('content'\)\.addEventListener\('click',\s*\(\)\s*=>\s*\{[\s\S]*?closeMobileSidebars\(\);[\s\S]*?\}\s*,\s*true\s*\);/);
    assert.ok(m, "$('content') 的 click 監聽必須帶 capture=true");
  });

  test('首頁搜尋下拉清單須疊在下方按鈕之上', () => {
    const css = fs.readFileSync(path.join(ROOT_DIR, 'style.css'), 'utf8');
    const m = css.match(/\.home-hero > \.home-search\s*\{[^}]*z-index:\s*(\d+)/);
    assert.ok(m && Number(m[1]) > 1, '.home-hero > .home-search 的 z-index 必須大於其他 hero 子元素（1）');
  });

  test('開站收合手機側欄後要同步遮罩', () => {
    const m = APP_JS.match(/sidebar\.classList\.add\('collapsed'\);\s*state\.sidebarCollapsed = true;\s*\}\s*(?:\/\/[^\n]*\n\s*)*updateSidebarBackdrop\(\);\s*await loadTree\(\);/);
    assert.ok(m, '收合側欄後、loadTree 前必須呼叫 updateSidebarBackdrop()');
  });
});

function loadPlaywright() {
  try { return require('playwright'); } catch (_) { return null; }
}

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
      if (m) { clearTimeout(timer); resolve({ child, port: Number(m[1]) }); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited early with code ${code}. Output:\n${out}`)); });
  });
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); resolve(); }, 8000).unref();
  });
}

describe('手機首頁按鈕：iPhone 觸控實測', () => {
  const pw = loadPlaywright();
  const mdRoot = path.join(ROOT_DIR, 'md');
  const hasCorpus = fs.existsSync(mdRoot) && fs.readdirSync(mdRoot).length > 0;
  const skip = !pw ? '未安裝 playwright' : (!hasCorpus ? 'md/ 為空（先跑 tests/fixtures/make-test-corpus.js）' : false);

  let child = null;
  let port = 0;
  let userData = '';
  let browser = null;

  before(async () => {
    if (skip) return;
    try { browser = await pw.chromium.launch(); } catch (_) { browser = null; return; }
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mdw-mobile-home-'));
    const started = await startServer({
      // 單機模式不需要先建立管理員，首頁不會被設定視窗蓋住
      MDW_DEPLOY_TARGET: 'win-app',
      PORT: '0',
      HOST: '127.0.0.1',
      MDW_USER_DATA: userData,
      CONFIG_PATH: path.join(userData, 'config.json'),
      LOG_DIR: path.join(userData, 'logs'),
      MD_ROOT: mdRoot,
      DICTIONARY_PATH: path.join(userData, 'dicts'),
      DICTIONARY_ENABLED: 'false',
      MDW_RENDER_POOL_SIZE: '2',
      MDW_INDEX_POOL_SIZE: '2'
    });
    child = started.child;
    port = started.port;
  });

  after(async () => {
    if (browser) await browser.close().catch(() => {});
    await stopServer(child);
    if (userData) { try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) {} }
  });

  async function openHome(t) {
    if (!browser) { t.skip('無法啟動 Chromium'); return null; }
    const ctx = await browser.newContext({ ...pw.devices['iPhone 13'], serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#homeBrowse', { state: 'visible' });
    return { ctx, page };
  }

  const sidebarState = (page) => page.evaluate(() => ({
    sidebarOpen: !document.getElementById('sidebar').classList.contains('collapsed'),
    backdrop: document.getElementById('sidebarBackdrop').classList.contains('active')
  }));

  test('開站後側欄收合時，遮罩不可蓋住首頁', { skip }, async (t) => {
    const h = await openHome(t); if (!h) return;
    try {
      assert.deepEqual(await sidebarState(h.page), { sidebarOpen: false, backdrop: false });
      const top = await h.page.evaluate(() => {
        const r = document.getElementById('homeBrowse').getBoundingClientRect();
        const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return el && el.closest('#homeBrowse') ? 'homeBrowse' : (el && (el.id || el.className));
      });
      assert.equal(top, 'homeBrowse', '「瀏覽全部經目」不得被其他元素蓋住');
    } finally { await h.ctx.close(); }
  });

  test('點「瀏覽全部經目」打開側欄的檔案分頁', { skip }, async (t) => {
    const h = await openHome(t); if (!h) return;
    try {
      await h.page.tap('#homeBrowse', { timeout: 5000 });
      await h.page.waitForTimeout(300);
      assert.deepEqual(await sidebarState(h.page), { sidebarOpen: true, backdrop: true });
      const tab = await h.page.evaluate(() => document.querySelector('.sidebar-tab.active')?.dataset.tab);
      assert.equal(tab, 'files');
    } finally { await h.ctx.close(); }
  });

  test('點經句下「在經藏中搜尋 →」打開側欄搜尋並帶入經句', { skip }, async (t) => {
    const h = await openHome(t); if (!h) return;
    try {
      const btn = h.page.locator('#homeVerseOpen');
      if (!(await btn.isVisible()) || (await btn.getAttribute('data-path'))) { t.skip('今日經句不是搜尋型'); return; }
      const query = await btn.getAttribute('data-query');
      await btn.scrollIntoViewIfNeeded();
      await btn.tap({ timeout: 5000 });
      await h.page.waitForTimeout(300);
      assert.deepEqual(await sidebarState(h.page), { sidebarOpen: true, backdrop: true });
      const res = await h.page.evaluate(() => ({
        tab: document.querySelector('.sidebar-tab.active')?.dataset.tab,
        value: document.getElementById('globalSearchInput').value,
        search: new URLSearchParams(location.search).get('search')
      }));
      assert.equal(res.tab, 'search');
      assert.equal(res.value, query);
      assert.equal(res.search, query);
    } finally { await h.ctx.close(); }
  });

  test('首頁搜尋框的「在全文中搜尋」選項，點了也要打開側欄搜尋', { skip }, async (t) => {
    const h = await openHome(t); if (!h) return;
    try {
      await h.page.tap('#homeSearchInput');
      await h.page.fill('#homeSearchInput', '舍利子');
      await h.page.waitForSelector('.home-search-opt.is-fulltext', { state: 'visible' });
      await h.page.tap('.home-search-opt.is-fulltext', { timeout: 5000 });
      await h.page.waitForTimeout(300);
      const s = await sidebarState(h.page);
      assert.equal(s.sidebarOpen, true);
      assert.equal(await h.page.evaluate(() => document.getElementById('globalSearchInput').value), '舍利子');
    } finally { await h.ctx.close(); }
  });

  test('側欄開著時點首頁內容區（遮罩）仍會收起側欄', { skip }, async (t) => {
    const h = await openHome(t); if (!h) return;
    try {
      await h.page.tap('#homeBrowse', { timeout: 5000 });
      await h.page.waitForTimeout(300);
      const vp = h.page.viewportSize();
      await h.page.touchscreen.tap(vp.width - 20, vp.height / 2);
      await h.page.waitForTimeout(300);
      assert.deepEqual(await sidebarState(h.page), { sidebarOpen: false, backdrop: false });
    } finally { await h.ctx.close(); }
  });
});
