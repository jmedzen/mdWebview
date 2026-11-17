/**
 * @file tests/test-focus-mode-pill.test.js
 *
 * 專注模式右上角的 pill（#focusModeExit）要能點選離開專注模式：
 *   - 桌機原本 pointer-events: none，只能按 Esc；現在滑鼠點、Enter／空白鍵都能離開。
 *   - iPad 等觸控裝置點 pill 離開（原本就有，保持）。
 *   - 所有離開路徑共用 exitFocusMode()，離開後鍵盤焦點回到專注模式按鈕。
 *
 * 靜態檢查一定跑；真瀏覽器（Playwright）只在本機裝得起來時跑，否則略過。
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveTestMdRoot } = require('./helpers/md-root');

const ROOT_DIR = path.resolve(__dirname, '..');
const APP_JS = fs.readFileSync(path.join(ROOT_DIR, 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT_DIR, 'style.css'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');

describe('專注模式 pill：靜態檢查', () => {
  test('pill 是有 aria-label 的 <button>', () => {
    assert.match(HTML, /<button type="button" class="focus-mode-pill" id="focusModeExit" aria-label="離開專注模式"/);
  });

  test('.focus-mode-pill 不可再設 pointer-events: none，且要有 pointer 游標', () => {
    const rule = CSS.match(/\n\.focus-mode-pill\s*\{([^}]*)\}/);
    assert.ok(rule, '找不到 .focus-mode-pill 規則');
    assert.doesNotMatch(rule[1], /pointer-events:\s*none/);
    assert.match(rule[1], /cursor:\s*pointer/);
  });

  test('pill 有 hover／focus-visible 樣式與 44px 點擊區', () => {
    assert.match(CSS, /\.focus-mode-pill:hover,\s*\n\.focus-mode-pill:focus-visible\s*\{/);
    assert.match(CSS, /\.focus-mode-pill::before\s*\{[^}]*height:\s*44px/);
  });

  test('pill、Esc、視窗變窄都走同一個 exitFocusMode()', () => {
    assert.match(APP_JS, /const exitFocusMode = /);
    assert.match(APP_JS, /focusModeExit\.addEventListener\('click', \(\) => \{\s*exitFocusMode\(/);
    assert.match(APP_JS, /if \(focusModeNarrowMq\.matches\) exitFocusMode\(\);/);
    assert.doesNotMatch(APP_JS, /document\.body\.classList\.remove\('focus-mode'\)[\s\S]{0,40}e\.preventDefault/);
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

describe('專注模式 pill：瀏覽器實測', () => {
  const pw = loadPlaywright();
  const mdRoot = resolveTestMdRoot();
  const hasCorpus = fs.existsSync(mdRoot) && fs.readdirSync(mdRoot).length > 0;
  const skip = !pw ? '未安裝 playwright' : (!hasCorpus ? 'md/ 為空（先跑 tests/fixtures/make-test-corpus.js）' : false);

  let child = null;
  let port = 0;
  let userData = '';
  let browser = null;

  before(async () => {
    if (skip) return;
    try { browser = await pw.chromium.launch(); } catch (_) { browser = null; return; }
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mdw-focus-pill-'));
    const started = await startServer({
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

  async function enterFocus(t, ctxOpts) {
    if (!browser) { t.skip('無法啟動 Chromium'); return null; }
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block', ...ctxOpts });
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#focusModeBtn', { state: 'visible' });
    await page.click('#focusModeBtn');
    await page.waitForSelector('#focusModeExit', { state: 'visible' });
    return { ctx, page };
  }
  const inFocus = (page) => page.evaluate(() => document.body.classList.contains('focus-mode'));

  test('桌機：滑鼠點 pill 離開專注模式，焦點回到專注模式按鈕', { skip }, async (t) => {
    const h = await enterFocus(t); if (!h) return;
    try {
      assert.equal(await inFocus(h.page), true);
      assert.equal(await h.page.$eval('#focusModeExit', el => getComputedStyle(el).cursor), 'pointer');
      await h.page.click('#focusModeExit', { timeout: 3000 });
      assert.equal(await inFocus(h.page), false);
      assert.equal(await h.page.isVisible('#focusModeExit'), false);
      assert.equal(await h.page.isVisible('.app-header'), true);
    } finally { await h.ctx.close(); }
  });

  test('桌機：Tab 到 pill 按 Enter／空白鍵都能離開', { skip }, async (t) => {
    for (const key of ['Enter', ' ']) {
      const h = await enterFocus(t); if (!h) return;
      try {
        await h.page.focus('#focusModeExit');
        await h.page.keyboard.press(key === ' ' ? 'Space' : key);
        assert.equal(await inFocus(h.page), false, `按 ${key === ' ' ? 'Space' : key} 應離開`);
        assert.equal(await h.page.evaluate(() => document.activeElement && document.activeElement.id), 'focusModeBtn');
      } finally { await h.ctx.close(); }
    }
  });

  test('桌機：Esc 仍可離開', { skip }, async (t) => {
    const h = await enterFocus(t); if (!h) return;
    try {
      await h.page.keyboard.press('Escape');
      assert.equal(await inFocus(h.page), false);
    } finally { await h.ctx.close(); }
  });

  test('iPad 觸控：點 pill 離開，點擊區至少 44px 高', { skip }, async (t) => {
    const h = await enterFocus(t, { ...pw.devices['iPad Pro 11 landscape'], serviceWorkers: 'block' });
    if (!h) return;
    try {
      const box = await h.page.$eval('#focusModeExit', (el) => {
        const r = el.getBoundingClientRect();
        const b = getComputedStyle(el, '::before');
        return { top: r.top, bottom: r.bottom, x: r.left + r.width / 2, hitH: parseFloat(b.height) };
      });
      assert.ok(box.hitH >= 44, `點擊區高度 ${box.hitH} < 44`);
      // 點在 pill 外框下方幾 px（仍在 44px 點擊區內）也要能離開
      await h.page.touchscreen.tap(box.x, box.bottom + 4);
      assert.equal(await inFocus(h.page), false);
    } finally { await h.ctx.close(); }
  });
});
