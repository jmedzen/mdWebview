/**
 * @file tests/test-kepan-ux-batch1.test.js
 *
 * 科判閱讀模式審計第一批（v4.27.7）：
 *   A1 ≥1 MB 的講記（虛擬捲動）也要有科判側欄、地標列、前後科；
 *   A2 地標列路徑預設收合，只留最後幾層，目前科一定看得到（手機也是）；
 *   A3 範圍選單依上層分組，不再出現兩個同名「乙一」。
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const APP_JS = fs.readFileSync(path.join(ROOT_DIR, 'app.js'), 'utf8');
const UI = require('../kepan-sidebar.js');

function tree(rows) {
  // rows: [父 id, 科判字, 科名]
  return UI.expandNodes({ title: 't', files: ['a'], heads: {}, nodes: rows.map(([p, m, t], i) => [p, m, t, 0, 0, i + 1]) });
}

describe('第一批：純函式與結構', () => {
  test('scopeOptions：範圍分屬不同上層時依上層分組', () => {
    const N = tree([[0, '甲一', '總標'], [1, '乙一', '明造論意'], [1, '乙二', '明論所依'], [0, '甲二', '廣釋'], [4, '乙一', '所知依分'], [4, '乙二', '所知相分']]);
    const g = UI.scopeOptions(N, 1);
    assert.equal(g.length, 2);
    assert.equal(N[g[0].parent].m, '甲一');
    assert.deepEqual(g[0].items.map(n => n.t), ['明造論意', '明論所依']);
    assert.deepEqual(g[1].items.map(n => n.t), ['所知依分', '所知相分']);
  });

  test('scopeOptions：只有一個上層（或範圍在最上層）時不分組', () => {
    const one = tree([[0, '甲一', '序分'], [1, '乙一', '通序'], [1, '乙二', '別序']]);
    assert.deepEqual(UI.scopeOptions(one, 1).map(g => g.parent), [0]);
    const top = tree([[0, '第一章', 'a'], [0, '第二章', 'b']]);
    assert.deepEqual(UI.scopeOptions(top, 0).map(g => g.parent), [0]);
    assert.equal(UI.scopeOptions(top, 0)[0].items.length, 2);
  });

  test('pathKeep：手機留 2 層、桌機留 3 層', () => {
    assert.equal(UI.pathKeep(390), 2);
    assert.equal(UI.pathKeep(768), 2);
    assert.equal(UI.pathKeep(1440), 3);
  });

  test('app.js：虛擬捲動開檔後也通知科判側欄，並提供定位介面', () => {
    const virt = APP_JS.slice(APP_JS.indexOf('async function tryOpenVirtualFile('), APP_JS.indexOf('async function openFile('));
    assert.match(virt, /window\.MdwKepan\.onDocumentRendered\(filePath\)/);
    assert.match(virt, /startsWith\('dict:'\)/, '辭典不走科判');
    assert.match(APP_JS, /window\.MdwKepan\.onChunkMounted\(sectionEl\)/, '新掛上的片段要改繪科判標題');
    assert.match(APP_JS, /window\.mdwScrollToLine = /);
    assert.match(APP_JS, /window\.mdwVirtualTopLine = /);
  });
});

// ───────────── 真瀏覽器 ─────────────

function loadPlaywright() { try { return require('playwright'); } catch (_) { return null; } }

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
const num = n => (n <= 10 ? CN[n] : n < 20 ? '十' + CN[n - 10] : CN[Math.floor(n / 10)] + '十' + (n % 10 ? CN[n % 10] : ''));

/** 一篇超過 1 MB 的科判講記（甲 › 乙 › 丙 › 丁 › 戊，共 40 個乙），會走虛擬捲動 */
function writeLargeSeries(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const para = '這一段是用來撐開檔案大小的正文，讓這一篇講記超過一百萬位元組而改走虛擬捲動。'.repeat(12);
  const L = ['---', 'title: "大檔講記"', '---', '', '# 大檔講記', ''];
  for (let a = 1; a <= 2; a++) {
    L.push(`## 甲${CN[a]}、第${a}大段（分二十科）`, '', para, '');
    for (let b = 1; b <= 20; b++) {
      L.push(`### 乙${num(b)}、第${a}之${b}`, '', para, '');
      for (let c = 1; c <= 2; c++) {
        L.push(`#### 丙${CN[c]}、第${a}之${b}之${c}`, '', para, '');
        for (let d = 1; d <= 2; d++) {
          L.push(`##### 丁${CN[d]}、第${a}之${b}之${c}之${d}`, '', para, '');
          for (let e = 1; e <= 2; e++) L.push(`###### 戊${CN[e]}、第${a}之${b}之${c}之${d}之${e}`, '', para, '', para, '');
        }
      }
    }
  }
  const text = L.join('\n') + '\n';
  fs.writeFileSync(path.join(dir, '大檔講記.md'), text);
  fs.writeFileSync(path.join(dir, '0總目錄.md'), '---\nkepan: true\n---\n- [[大檔講記]]\n');
  return Buffer.byteLength(text);
}

describe('第一批：瀏覽器實測', () => {
  const pw = loadPlaywright();
  const skip = !pw ? '未安裝 playwright' : false;
  let child = null, port = 0, tmp = '', browser = null;

  before(async () => {
    if (skip) return;
    try { browser = await pw.chromium.launch(); } catch (_) { browser = null; return; }
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdw-kepan-b1-'));
    const mdRoot = path.join(tmp, 'vault');
    const bytes = writeLargeSeries(path.join(mdRoot, '論', '講記'));
    assert.ok(bytes > 1048576, `測試檔要超過 1 MB（${bytes}）`);
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

  async function open(t, viewport, line) {
    if (!browser) { t.skip('無法啟動 Chromium'); return null; }
    const ctx = await browser.newContext({ viewport, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const file = encodeURIComponent('論/講記/大檔講記.md');
    await page.goto(`http://127.0.0.1:${port}/?file=${file}${line ? '&line=' + line : ''}`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => {
      const bar = document.getElementById('kepanBar');
      return bar && !bar.hidden && document.getElementById('kepanPath').children.length > 0;
    }, null, { timeout: 20000 });
    await page.waitForTimeout(1800);
    return { ctx, page, errors };
  }

  test('大檔：虛擬捲動也顯示科判分頁、地標列，後一科能跨段跳轉', { skip }, async (t) => {
    const h = await open(t, { width: 1280, height: 800 }); if (!h) return;
    try {
      const r = await h.page.evaluate(() => ({
        virtual: window.mdwIsVirtual(),
        kepanTab: !document.querySelector('.sidebar-tab[data-tab="kepan"]').hidden,
        here: window.MdwKepan._state.hereId,
      }));
      assert.ok(r.virtual, '測試檔應走虛擬捲動');
      assert.ok(r.kepanTab, '大檔也要有科判分頁');
      assert.ok(r.here > 0, '應標出目前所在的科');
      // 跳到樹裡很後面的末端科（必須掛上遠處的片段）
      const target = await h.page.evaluate(() => {
        const S = window.MdwKepan._state;
        const leaves = S.N.filter(n => n.id && !n.k.length);
        return leaves[leaves.length - 5].id;
      });
      await h.page.evaluate((id) => {
        const a = document.createElement('a'); a.href = '#'; a.dataset.go = String(id);
        document.getElementById('kepanPath').appendChild(a); a.click();
      }, target);
      await h.page.waitForTimeout(2500);
      const after = await h.page.evaluate(() => {
        const S = window.MdwKepan._state, n = S.N[S.hereId];
        const el = document.getElementById('L' + n.l);
        const bar = document.getElementById('kepanBar').getBoundingClientRect();
        return { here: S.hereId, gap: el ? (el.closest('h1,h2,h3,h4,h5,h6') || el).getBoundingClientRect().top - bar.bottom : null };
      });
      assert.equal(after.here, target, '應標到點選的科');
      assert.ok(after.gap !== null && after.gap >= -2 && after.gap <= 60, `目標標題應在地標列下方（差 ${after.gap}px）`);
      // 後一科
      await h.page.click('#kepanNext');
      await h.page.waitForTimeout(2000);
      assert.equal(await h.page.evaluate(() => window.MdwKepan._state.hereId), target + 1);
      assert.deepEqual(h.errors.filter(m => !/serviceWorker/.test(m)), []);
    } finally { await h.ctx.close(); }
  });

  for (const [name, viewport, keep] of [['桌機', { width: 1280, height: 800 }, 3], ['手機寬', { width: 390, height: 844 }, 2]]) {
    test(`${name}：地標列路徑收合，目前科一定看得到，可展開收起`, { skip }, async (t) => {
      const h = await open(t, viewport, 200); if (!h) return;
      try {
        // 跳到最深一層（戊）
        await h.page.evaluate(() => {
          const S = window.MdwKepan._state;
          const deep = S.N.find(n => n.m.startsWith('戊') && n.id > 50);
          const a = document.createElement('a'); a.href = '#'; a.dataset.go = String(deep.id);
          document.getElementById('kepanPath').appendChild(a); a.click();
        });
        await h.page.waitForTimeout(2000);
        const r = await h.page.evaluate(() => {
          const p = document.getElementById('kepanPath'), cur = p.querySelector('a.is-current');
          const pr = p.getBoundingClientRect(), cr = cur.getBoundingClientRect();
          return { links: p.querySelectorAll('a[data-go]').length, more: !!p.querySelector('[data-path-toggle][aria-expanded="false"]'),
            visible: cr.top >= pr.top - 1 && cr.bottom <= pr.bottom + 1, overflow: p.scrollHeight > p.clientHeight + 1 };
        });
        assert.equal(r.links, keep, `收合時只留 ${keep} 層`);
        assert.ok(r.more, '要有「上 N 層」展開鈕');
        assert.ok(r.visible, '目前科要在地標列可見範圍內');
        assert.ok(!r.overflow, '收合時路徑不需要列內捲動');
        await h.page.click('#kepanPath [data-path-toggle]');
        await h.page.waitForTimeout(300);
        const open5 = await h.page.evaluate(() => document.querySelectorAll('#kepanPath a[data-go]').length);
        assert.equal(open5, 5, '展開後顯示完整路徑（甲乙丙丁戊）');
        await h.page.click('#kepanPath [data-path-toggle]');
        await h.page.waitForTimeout(300);
        assert.equal(await h.page.evaluate(() => document.querySelectorAll('#kepanPath a[data-go]').length), keep);
      } finally { await h.ctx.close(); }
    });
  }

  test('範圍選單：兩個甲之下的乙分組顯示', { skip }, async (t) => {
    const h = await open(t, { width: 1280, height: 800 }); if (!h) return;
    try {
      const groups = await h.page.$$eval('#kepanScope optgroup', gs => gs.map(g => [g.label, g.children.length]));
      // 範圍在丙層（SCOPE_DEPTH=2）：依各乙分組
      assert.ok(groups.length >= 2, `應依上層分組（${JSON.stringify(groups.slice(0, 3))}）`);
      assert.equal(await h.page.$eval('#kepanScope option', o => o.value), '0', '第一項仍是全文');
    } finally { await h.ctx.close(); }
  });
});
