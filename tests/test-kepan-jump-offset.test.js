/**
 * @file tests/test-kepan-jump-offset.test.js
 *
 * 科判閱讀模式：閱讀框頂端的黏性地標列（#kepanBar）會換行、在手機上更高，且隨所在的科
 * 改變。點側欄的科、前一科／後一科、或從搜尋（?line=）跳進科判講記時，目標標題必須
 * 落在地標列底下，不可被它蓋住（v4.21.1 回歸）。
 *
 * 純函式與原始碼結構一定跑；真瀏覽器（Playwright）只在本機裝得起來時跑，否則略過。
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const APP_JS = fs.readFileSync(path.join(ROOT_DIR, 'app.js'), 'utf8');
const KEPAN_JS = fs.readFileSync(path.join(ROOT_DIR, 'kepan-sidebar.js'), 'utf8');
const UI = require('../kepan-sidebar.js');

describe('科判跳轉讓開黏性地標列：純函式與結構', () => {
  test('jumpScrollTop 讓標題落在列底下 JUMP_GAP 處', () => {
    // 標題在視窗 y=500，捲動容器頂 y=100，已捲 200，列高 90
    assert.equal(UI.jumpScrollTop(500, 100, 200, 90), 500 - 100 + 200 - 90 - UI.JUMP_GAP);
    assert.equal(UI.jumpScrollTop(500, 100, 200, 0), 500 - 100 + 200 - UI.JUMP_GAP);
    assert.equal(UI.jumpScrollTop(110, 100, 0, 90), 0, '不可捲成負值');
  });

  test('spyLine 的判定線必須越過列底，跳到的科才會被標為目前所在', () => {
    for (const bar of [0, 40, 90, 180]) {
      const st = 1000;
      const headingTop = st + bar + UI.JUMP_GAP;   // 跳轉後標題的位置
      assert.ok(UI.spyLine(st, bar) >= headingTop, `列高 ${bar}px 時判定線 ${UI.spyLine(st, bar)} 應 ≥ ${headingTop}`);
    }
    assert.equal(UI.spyLine(0, 0), 80, '沒有地標列時維持原本的 80px');
  });

  test('kepan-sidebar.js：同檔點科先換地標列再捲動；捲動扣掉列高', () => {
    assert.match(KEPAN_JS, /if \(file === S\.file\) \{[\s\S]*?setHere\(id\);\s*scrollToLine\(n\.l\);/,
      '同檔跳科必須先 setHere（重繪地標列）再 scrollToLine，否則用的是舊列高');
    assert.match(KEPAN_JS, /jumpScrollTop\(.*barHeight\(\)\)/, 'scrollToLine 必須扣掉地標列實際高度');
    assert.match(KEPAN_JS, /observe\(\$\('kepanBar'\)\)/, '地標列變高變矮要讓標題位置快取失效');
  });

  test('app.js：跳到某行（含搜尋、虛擬捲動）都扣掉黏性列高度', () => {
    assert.match(APP_JS, /function stickyTopInset\(containerEl\)/);
    assert.match(APP_JS, /targetScrollTop -= 12 \+ inset;/, 'safeScrollToElement 的 start 對齊要扣列高');
    assert.match(APP_JS, /const expectedTop = cr\.top \+ 12 \+ stickyTopInset\(c\);/, 'scrollToLine 的重流修正要用同一條基準');
    const virt = APP_JS.slice(APP_JS.indexOf('async function scrollToLineVirtual('));
    assert.match(virt.slice(0, 6000), /- 12 - stickyTopInset\(content\)\)/, '虛擬捲動第一次定位要扣列高');
    assert.match(virt.slice(0, 6000), /- 12 - stickyTopInset\(c\);/, '虛擬捲動修正迴圈要扣列高');
    assert.match(APP_JS, /new ResizeObserver\([\s\S]{0,400}lastLineJump[\s\S]{0,200}\.observe\(stickyBar\)/,
      '跳行後地標列才換高度時要重新對齊');
  });
});

// ───────────── 真瀏覽器 ─────────────

function loadPlaywright() {
  try { return require('playwright'); } catch (_) { return null; }
}

function startServer(env, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], { cwd: ROOT_DIR, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
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

const CN = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const LONG = '此科判標題刻意寫得很長以便路徑換成好幾行';

/** 五篇講記、每篇五層深、標題很長：地標列路徑會換成多行 */
function writeDeepSeries(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const FM = '---\ntitle: "測試講記"\nsource: "《瑜伽師地論》卷一.《披尋記》Page5-Page9.1996/9/20.Tape1"\n---\n';
  const para = (s) => `${s}的講解。${'這一段是用來撐開版面的正文，讓文件夠長可以捲動。'.repeat(6)}`;
  for (let i = 1; i <= 5; i++) {
    const L = [];
    if (i === 1) L.push('## 甲一、總科（分五科）');
    L.push(`## 乙${CN[i]}、第${i}篇${LONG}（分二科）`, '', para('乙'), '');
    for (let j = 1; j <= 2; j++) {
      L.push(`### 丙${CN[j]}、第${i}之${j}${LONG}（分二科）`, '', para('丙'), '');
      for (let k = 1; k <= 2; k++) {
        L.push(`#### 丁${CN[k]}、第${i}之${j}之${k}${LONG}（分三科）`, '', para('丁'), '');
        for (let m = 1; m <= 3; m++) {
          L.push(`##### 戊${CN[m]}、第${i}之${j}之${k}之${m}${LONG}`, '', para('戊'), '', para('戊'), '', para('戊'), '');
        }
      }
    }
    fs.writeFileSync(path.join(dir, `講記T${i}.md`), FM + L.join('\n') + '\n');
  }
  fs.writeFileSync(path.join(dir, '0總目錄.md'), [1, 2, 3, 4, 5].map(i => `- [[講記T${i}]]`).join('\n') + '\n');
}

describe('科判跳轉讓開黏性地標列：瀏覽器實測', () => {
  const pw = loadPlaywright();
  const skip = !pw ? '未安裝 playwright' : false;
  let child = null, port = 0, tmp = '', browser = null;

  before(async () => {
    if (skip) return;
    try { browser = await pw.chromium.launch(); } catch (_) { browser = null; return; }
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdw-kepan-jump-'));
    const mdRoot = path.join(tmp, 'vault');
    writeDeepSeries(path.join(mdRoot, '論', '講記'));
    ({ child, port } = await startServer({
      MDW_DEPLOY_TARGET: 'win-app', PORT: '0', HOST: '127.0.0.1',
      MDW_USER_DATA: tmp, CONFIG_PATH: path.join(tmp, 'config.json'),
      LOG_DIR: path.join(tmp, 'logs'), INDEX_DIR: path.join(tmp, 'index'),
      MD_ROOT: mdRoot, DICTIONARY_PATH: path.join(tmp, 'dicts'), DICTIONARY_ENABLED: 'false',
      MDW_RENDER_POOL_SIZE: '1', MDW_INDEX_POOL_SIZE: '1'
    }));
  });

  after(async () => {
    if (browser) await browser.close().catch(() => {});
    await stopServer(child);
    if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} }
  });

  async function open(t, viewport, query) {
    if (!browser) { t.skip('無法啟動 Chromium'); return null; }
    const ctx = await browser.newContext({ viewport, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const file = encodeURIComponent('論/講記/講記T2.md');
    await page.goto(`http://127.0.0.1:${port}/?file=${file}${query || ''}`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => {
      const bar = document.getElementById('kepanBar');
      return bar && !bar.hidden && document.getElementById('kepanPath').children.length > 0;
    }, null, { timeout: 15000 });
    await page.waitForTimeout(1200);
    return { ctx, page };
  }

  /** 目前所在科的標題頂端相對於地標列底緣的距離 */
  const gapBelowBar = (page, line) => page.evaluate((ln) => {
    const S = window.MdwKepan._state;
    const n = S.N[S.hereId];
    const el = document.getElementById('L' + (ln || n.l));
    const h = el.closest('h1, h2, h3, h4, h5, h6') || el;
    const bar = document.getElementById('kepanBar').getBoundingClientRect();
    return { gap: h.getBoundingClientRect().top - bar.bottom, barH: bar.height, scrollTop: document.getElementById('content').scrollTop };
  }, line);

  function assertClear(r, what) {
    assert.ok(r.scrollTop > 0, `${what}：應有捲動`);
    assert.ok(r.barH > 30, `${what}：地標列應有實際高度（${r.barH}px）`);
    assert.ok(r.gap >= 0, `${what}：標題被地標列蓋住 ${-r.gap}px（列高 ${r.barH}px）`);
    assert.ok(r.gap <= 40, `${what}：標題離地標列太遠（${r.gap}px）`);
  }

  for (const [name, viewport] of [['桌機', { width: 1280, height: 800 }], ['手機寬', { width: 390, height: 844 }]]) {
    test(`${name}：點側欄深層的科，標題不被地標列遮住`, { skip }, async (t) => {
      const h = await open(t, viewport); if (!h) return;
      try {
        // 找同一檔、文件後段的末端科
        const id = await h.page.evaluate(() => {
          const S = window.MdwKepan._state;
          const f = S.fileIndex;
          const leaves = S.N.filter(n => n.f === f && !n.k.length);
          return leaves[leaves.length - 3].id;
        });
        await h.page.evaluate((target) => {
          // 點路徑上的科與點側欄列走同一個 goTo；用路徑列的 data-go 點選以避開側欄虛擬列表
          const a = document.createElement('a');
          a.href = '#'; a.dataset.go = String(target); a.textContent = 'x';
          document.getElementById('kepanPath').appendChild(a);
          a.click();
        }, id);
        await h.page.waitForTimeout(800);
        assert.equal(await h.page.evaluate(() => window.MdwKepan._state.hereId), id, '應標到點選的科');
        assertClear(await gapBelowBar(h.page), `${name} 點科`);
      } finally { await h.ctx.close(); }
    });

    test(`${name}：後一科跳轉，標題不被地標列遮住`, { skip }, async (t) => {
      const h = await open(t, viewport); if (!h) return;
      try {
        for (let i = 0; i < 4; i++) { await h.page.click('#kepanNext'); await h.page.waitForTimeout(500); }
        assertClear(await gapBelowBar(h.page), `${name} 後一科`);
      } finally { await h.ctx.close(); }
    });

    test(`${name}：前一科／後一科是辭典式浮動膠囊，按鈕寫前後科名、長名截斷不溢出`, { skip }, async (t) => {
      const h = await open(t, viewport); if (!h) return;
      try {
        await h.page.click('#kepanNext'); await h.page.waitForTimeout(500);
        const r = await h.page.evaluate(() => {
          const S = window.MdwKepan._state, N = S.N, id = S.hereId;
          const nav = document.getElementById('kepanNav'), cs = getComputedStyle(nav);
          const box = nav.getBoundingClientRect();
          const name = b => b.querySelector('.kepan-nav-name');
          const prev = document.getElementById('kepanPrev'), next = document.getElementById('kepanNext');
          const t = window.MdwKepan.navTargets(N, id, window.MdwKepan.leafIds(N));
          return {
            position: cs.position, radius: parseFloat(cs.borderTopLeftRadius),
            inView: box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
            prevText: name(prev).textContent, nextText: name(next).textContent,
            // v4.27.16 起前後科只走末端科，不再假設 id±1
            wantPrev: t.prev ? `${N[t.prev].m} ${N[t.prev].t}` : '已是第一科',
            wantNext: t.next ? `${N[t.next].m} ${N[t.next].t}` : '已是最後一科',
            wantLeafNext: t.next ? !N[t.next].k.length : true,
            here: `${N[id].m} ${N[id].t}`, navText: nav.textContent,
            truncated: name(next).scrollWidth > name(next).clientWidth,
          };
        });
        assert.equal(r.position, 'fixed', '浮動膠囊');
        assert.ok(r.radius >= 20, '圓角膠囊同辭典');
        assert.ok(r.inView, '膠囊整個在視窗內');
        assert.equal(r.prevText, r.wantPrev);
        assert.equal(r.nextText, r.wantNext);
        assert.ok(r.wantLeafNext, '後一科應是末端科（v4.27.16）');
        assert.ok(!r.navText.includes(r.here), '不寫目前科名');
        assert.ok(r.truncated, '長科名以刪節號截斷');
        // 回到第一科：前一科停用
        await h.page.evaluate(() => { const a = document.createElement('a'); a.href = '#'; a.dataset.go = '1'; document.getElementById('kepanPath').appendChild(a); a.click(); });
        await h.page.waitForFunction(() => window.MdwKepan._state.hereId === 1, null, { timeout: 10000 });
        await h.page.waitForTimeout(300);
        assert.ok(await h.page.$eval('#kepanPrev', b => b.disabled && b.textContent.includes('已是第一科')));
      } finally { await h.ctx.close(); }
    });

    test(`${name}：浮動膠囊對齊閱讀區正中（側欄開或收都一樣）`, { skip }, async (t) => {
      const h = await open(t, viewport); if (!h) return;
      try {
        const offset = () => h.page.evaluate(() => {
          const c = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return (r.left + r.right) / 2; };
          return { off: c('kepanNav') - c('content'), contentLeft: document.getElementById('content').getBoundingClientRect().left };
        });
        const a = await offset();
        assert.ok(Math.abs(a.off) <= 1, `膠囊偏離閱讀區中心 ${a.off}px`);
        if (viewport.width > 768) {
          assert.ok(a.contentLeft > 100, '桌機側欄打開時閱讀區應在側欄右邊');
          await h.page.click('#sidebarToggle');
          await h.page.waitForTimeout(900);
          const b = await offset();
          assert.ok(b.contentLeft < a.contentLeft, '收起側欄後閱讀區應左移');
          assert.ok(Math.abs(b.off) <= 1, `收起側欄後膠囊偏離閱讀區中心 ${b.off}px`);
        }
      } finally { await h.ctx.close(); }
    });

    test(`${name}：從搜尋（?line=）跳進科判講記，標題不被地標列遮住`, { skip }, async (t) => {
      if (!browser) { t.skip('無法啟動 Chromium'); return; }
      // 找講記T2 後段某個戊科標題的行號
      const text = fs.readFileSync(path.join(tmp, 'vault', '論', '講記', '講記T2.md'), 'utf8').split('\n');
      const line = text.findIndex(l => l.startsWith('##### 戊二、第2之2之1')) + 1;
      const h = await open(t, viewport, `&line=${line}`); if (!h) return;
      try {
        await h.page.waitForTimeout(800);
        assertClear(await gapBelowBar(h.page, line), `${name} 搜尋跳轉`);
      } finally { await h.ctx.close(); }
    });
  }
});
