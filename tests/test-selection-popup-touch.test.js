const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { resolveTestMdRoot } = require('./helpers/md-root');

const ROOT_DIR = path.resolve(__dirname, '..');
const appJs = fs.readFileSync(path.join(ROOT_DIR, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT_DIR, 'style.css'), 'utf8');

function popupSource() {
  const start = appJs.indexOf('function setupSelectionPopup()');
  const end = appJs.indexOf('function getSelectionLineNumber(');
  assert.ok(start > 0 && end > start, '找不到 setupSelectionPopup()');
  return appJs.slice(start, end);
}

describe('選字彈窗支援觸控（手機長按選字、拖曳把手）', () => {
  const src = popupSource();

  test('1. 監聽 selectionchange（去抖）與 touchend，並保留 mouseup', () => {
    assert.match(src, /addEventListener\('selectionchange'/);
    assert.match(src, /addEventListener\('touchend'/);
    assert.match(src, /addEventListener\('mouseup'/);
    assert.match(src, /scheduleSelectionCheck\(SELECTION_CHANGE_DELAY\)/);
    assert.match(src, /clearTimeout\(selectionTimer\)/, '三個觸發來源共用同一個計時器');
  });

  test('2. 滑鼠拖曳中不由 selectionchange 觸發，選取清空時立即隱藏', () => {
    assert.match(src, /if \(mouseSelecting\) return;/);
    assert.match(src, /selection\.isCollapsed/);
  });

  test('3. 觸控時彈窗放在選取下方以避開系統選單，邊界用 visualViewport', () => {
    assert.match(src, /if \(lastInputWasTouch\)/);
    assert.match(src, /lastRect\.bottom \+ HANDLE_GAP/);
    assert.match(src, /window\.visualViewport/);
  });

  test('4. 點彈窗時暫緩隱藏，彈窗本身不可選字', () => {
    assert.match(src, /popup\.addEventListener\('touchstart'/);
    assert.match(src, /popupTouchGuardUntil/);
    assert.match(css, /\.selection-share-popup\s*\{[^}]*user-select:\s*none/);
    assert.match(css, /\.selection-share-popup\s*\{[^}]*-webkit-touch-callout:\s*none/);
    assert.match(css, /\.selection-share-popup\.touch button\s*\{[^}]*min-height:\s*40px/);
  });
});

describe('選字彈窗 v4.10.0：兩排圖示、更多選單、新動作', () => {
  const src = popupSource();

  test('1. 主列：劃線色點＋複製、辭典、搜尋、分享、更多', () => {
    for (const id of ['selectionCopyBtn', 'selectionDictBtn', 'selectionSearchBtn', 'selectionShareBtn', 'selectionMoreBtn']) {
      assert.match(src, new RegExp(`id="${id}"`), id);
    }
    assert.match(src, /class="sel-hl-label"[^>]*>劃線</);
    assert.match(css, /\.selection-share-popup button\s*\{[^}]*flex-direction:\s*column/, '桌機按鈕上圖示下文字');
  });

  test('2. 更多：附出處複製、在本篇中尋找（與 Cmd+F 共用頁內搜尋）', () => {
    for (const id of ['selectionCiteBtn', 'selectionFindBtn']) {
      assert.match(src, new RegExp(`id="${id}"`), id);
    }
    assert.match(src, /openPageSearch\(\);[\s\S]{0,120}doPageSearch\(q\)/);
  });

  test('3. 附出處格式含經名、行號與連結；分享直接複製帶行號的連結，不呼叫系統分享', () => {
    assert.match(src, /——\$\{name\}\$\{currentLineNum \? `第 \$\{currentLineNum\} 行` : ''\}/);
    assert.doesNotMatch(src, /navigator\.share/, '分享不叫系統分享面板');
    assert.match(src, /shareBtn\.addEventListener\('click'[\s\S]{0,900}writeClipboard\(shareUrl, `✓ 已複製第 \$\{shareLineNum\} 行分享連結`\)/);
    assert.doesNotMatch(src, /selectionLinkBtn/, '「複製本行連結」已併入分享');
  });

  test('4. 點彈窗內按鈕不重新計算選取，避免「更多」被收起', () => {
    assert.match(src, /addEventListener\('mouseup', \(e\) => \{[\s\S]{0,200}if \(popup\.contains\(e\.target\)\) return;/);
    assert.match(src, /const hidePopup = \(\) => \{\s*popupPinned = false;\s*popup\.classList\.remove\('visible'\);\s*setMoreOpen\(false\);/);
  });
});

// ---------------------------------------------------------------------------
// v4.17.1：手機點「⋯ 更多」第一次會自己關閉
// iOS 點選字以外的地方會收掉選取，但 selectionchange 送達的時間不一定，
// 可能晚於 800ms 的暫緩時間，舊版就把彈窗連同剛打開的「更多」一起收掉；
// 第二次點時選取早已清空，所以就正常。改成手指一碰彈窗就釘住，直到點彈窗外。
// ---------------------------------------------------------------------------

describe('選字彈窗「更多」：選取被系統延遲清掉時不可自己關閉（靜態）', () => {
  const src = popupSource();
  test('碰到彈窗就釘住，選取清空時釘住中不收起', () => {
    assert.match(src, /let popupPinned = false;/);
    assert.match(src, /if \(popup\.contains\(e\.target\)\) \{\s*if \(popup\.classList\.contains\('visible'\)\) popupPinned = true;/);
    assert.equal((src.match(/if \(!popupPinned && Date\.now\(\) >= popupTouchGuardUntil\) hidePopup\(\);/g) || []).length, 2);
    assert.match(src, /const hidePopup = \(\) => \{\s*popupPinned = false;/);
  });
});

const { before, after } = require('node:test');
const { spawn } = require('node:child_process');
const os = require('node:os');

function loadPlaywright() {
  try { return require('playwright'); } catch (_) { return null; }
}

function startServer(env, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT_DIR, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`server not ready:\n${out}`)); }, timeoutMs);
    const onData = (chunk) => {
      out += chunk.toString();
      const m = out.match(/MDWEBVIEW_READY port=(\d+)/);
      if (m) { clearTimeout(timer); resolve({ child, port: Number(m[1]) }); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}:\n${out}`)); });
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

describe('選字彈窗「更多」：iPhone 觸控實測', () => {
  const pw = loadPlaywright();
  const mdRoot = resolveTestMdRoot();
  const FILE = '01-大正藏/03般若部類/T0251《般若波羅蜜多心經》.md';
  const hasCorpus = fs.existsSync(path.join(mdRoot, FILE));
  const skip = !pw ? '未安裝 playwright' : (!hasCorpus ? 'md/ 為空（先跑 tests/fixtures/make-test-corpus.js）' : false);

  let child = null;
  let port = 0;
  let userData = '';
  let browser = null;

  before(async () => {
    if (skip) return;
    try { browser = await pw.chromium.launch(); } catch (_) { browser = null; return; }
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mdw-sel-more-'));
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

  // 開經文、用觸控選「觀自在菩薩」，等彈窗出現；
  // 並模擬 iOS：點彈窗後過 clearDelay 毫秒系統才把選取清掉
  async function openWithSelection(t, clearDelay) {
    if (!browser) { t.skip('無法啟動 Chromium'); return null; }
    const ctx = await browser.newContext({ ...pw.devices['iPhone 13'], serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${port}/?file=${encodeURIComponent(FILE)}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#markdownBody p');
    await page.touchscreen.tap(30, 300);
    await page.evaluate((delay) => {
      const w = document.createTreeWalker(document.getElementById('markdownBody'), NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w.nextNode()) && !n.textContent.includes('觀自在')) { /* find */ }
      n.parentElement.scrollIntoView({ block: 'center' });
      const i = n.textContent.indexOf('觀自在');
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + 5);
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(r);
      document.addEventListener('touchend', (e) => {
        if (e.target.closest && e.target.closest('.selection-share-popup')) {
          setTimeout(() => getSelection().removeAllRanges(), delay);
        }
      }, true);
    }, clearDelay);
    await page.waitForSelector('#selectionSharePopup.visible', { timeout: 5000 });
    return { ctx, page };
  }

  const popupState = (page) => page.evaluate(() => ({
    visible: document.getElementById('selectionSharePopup').classList.contains('visible'),
    moreOpen: !document.getElementById('selectionMoreMenu').hidden
  }));

  for (const delay of [0, 1000]) {
    test(`點一次「更多」就打開並保持（選取在 ${delay}ms 後被清掉）`, { skip }, async (t) => {
      const h = await openWithSelection(t, delay); if (!h) return;
      try {
        await h.page.tap('#selectionMoreBtn');
        await h.page.waitForTimeout(delay + 600);
        assert.equal(await h.page.evaluate(() => getSelection().toString()), '', '模擬的系統清除選取有生效');
        assert.deepEqual(await popupState(h.page), { visible: true, moreOpen: true });
        // 選單項目仍用原本選的字
        await h.page.tap('#selectionFindBtn');
        await h.page.waitForTimeout(300);
        assert.equal(await h.page.evaluate(() => document.getElementById('pageSearchInput').value), '觀自在菩薩');
        assert.equal((await popupState(h.page)).visible, false);
      } finally { await h.ctx.close(); }
    });
  }

  test('釘住後點彈窗外仍會收起', { skip }, async (t) => {
    const h = await openWithSelection(t, 1000); if (!h) return;
    try {
      await h.page.tap('#selectionMoreBtn');
      await h.page.waitForTimeout(1500);
      assert.deepEqual(await popupState(h.page), { visible: true, moreOpen: true });
      await h.page.touchscreen.tap(20, 120);
      await h.page.waitForTimeout(500);
      assert.deepEqual(await popupState(h.page), { visible: false, moreOpen: false });
    } finally { await h.ctx.close(); }
  });
});
