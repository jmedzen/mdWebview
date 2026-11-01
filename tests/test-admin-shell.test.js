// 後台外框（v4.4.0）：左側分組導覽的每個頁面都要對得到分頁與卡片，
// 每張卡片也都要屬於某個頁面，否則新增的卡片會在後台裡找不到。
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');

const navItems = [...html.matchAll(/<button[^>]*class="admin-nav-item"[^>]*>/g)].map(m => {
  const tag = m[0];
  const get = name => (tag.match(new RegExp(`${name}="([^"]*)"`)) || [])[1];
  return { page: get('data-page'), pane: get('data-pane'), cards: (get('data-cards') || '').split(',').filter(Boolean) };
});

const paneMap = (() => {
  const m = app.match(/const ADMIN_PANES = \{([\s\S]*?)\};/);
  assert.ok(m, 'app.js 要有 ADMIN_PANES');
  return Object.fromEntries([...m[1].matchAll(/(\w+):\s*'([^']+)'/g)].map(x => [x[1], x[2]]));
})();

/** 取出某個分頁（id）的 HTML 片段：從它的開頭到下一個 admin-tab-pane 為止。 */
function paneHtml(id) {
  const start = html.indexOf(`id="${id}"`);
  assert.ok(start > 0, `index.html 找不到 #${id}`);
  const next = html.indexOf('class="admin-tab-pane"', start + 1);
  const end = next > 0 ? next : html.indexOf('§MEDIA LIGHTBOX', start);
  return html.slice(start, end);
}

const cardsIn = id => [...paneHtml(id).matchAll(/data-card="([^"]+)"/g)].map(m => m[1]);

describe('後台外框與導覽', () => {
  test('舊的橫向分頁列已移除，改用全頁外框', () => {
    assert.doesNotMatch(html, /class="admin-tab-btn/);
    assert.doesNotMatch(html, /id="adminTabsNav"/);
    assert.match(html, /<div class="admin-shell" id="adminShell"/);
    assert.match(html, /<nav class="admin-nav" id="adminNav">/);
    assert.match(html, /id="adminBackBtn"/);
    assert.match(html, /id="adminPageTitle"/);
  });

  test('每個導覽項目都有唯一的頁面名稱，並指向存在的分頁', () => {
    assert.ok(navItems.length >= 15, `導覽項目太少：${navItems.length}`);
    const pages = navItems.map(n => n.page);
    assert.equal(new Set(pages).size, pages.length, '頁面名稱不可重複');
    for (const n of navItems) {
      assert.ok(paneMap[n.pane], `頁面 ${n.page} 的 data-pane="${n.pane}" 不在 ADMIN_PANES`);
      assert.match(html, new RegExp(`class="admin-tab-pane[^"]*" id="${paneMap[n.pane]}"`), `找不到分頁 #${paneMap[n.pane]}`);
    }
  });

  test('頁面列出的卡片都在它的分頁裡', () => {
    for (const n of navItems) {
      const inPane = cardsIn(paneMap[n.pane]);
      for (const c of n.cards) assert.ok(inPane.includes(c), `頁面 ${n.page} 要顯示的卡片 ${c} 不在 #${paneMap[n.pane]}`);
    }
  });

  test('每張卡片都屬於某個頁面', () => {
    for (const [paneKey, id] of Object.entries(paneMap)) {
      const pagesOfPane = navItems.filter(n => n.pane === paneKey);
      assert.ok(pagesOfPane.length > 0, `分頁 ${paneKey} 沒有任何導覽項目`);
      if (pagesOfPane.some(n => n.cards.length === 0)) continue; // 有頁面顯示整個分頁
      const listed = new Set(pagesOfPane.flatMap(n => n.cards));
      for (const c of cardsIn(id)) assert.ok(listed.has(c), `卡片 ${c}（#${id}）沒有出現在任何頁面`);
    }
  });

  test('只屬於公開網站的頁面在單機模式要藏起來', () => {
    for (const page of ['seo', 'users', 'registration', 'sso', 'legal', 'setup', 'mail', 'turnstile', 'analytics', 'reports', 'security']) {
      const re = new RegExp(`(<div class="admin-nav-group" data-web-only>(?:(?!admin-nav-group")[\\s\\S])*data-page="${page}"|data-page="${page}"[^>]*data-web-only)`);
      assert.match(html, re, `頁面 ${page} 應標記 data-web-only`);
    }
    for (const page of ['site', 'reading', 'homepage', 'suggest', 'hardware', 'logs', 'backup']) {
      assert.doesNotMatch(html, new RegExp(`data-page="${page}"[^>]*data-web-only`), `頁面 ${page} 單機模式也要能用`);
    }
  });

  test('目前頁面記在 #admin/<頁面>，關閉後台時清掉', () => {
    assert.match(app, /const ADMIN_HASH_PREFIX = '#admin';/);
    assert.match(app, /function showAdminPage\(/);
    assert.match(app, /setAdminHash\(null\)/);
  });

  test('總覽是第一頁，打開後台沒有指定頁面時先看總覽', () => {
    assert.equal(navItems[0].page, 'overview');
    assert.match(app, /showAdminPage\(fromHash \|\| 'overview'/);
    for (const id of ['ovTodoList', 'ovKpiViews', 'ovTrend', 'ovHealth', 'ovPages']) {
      assert.match(html, new RegExp(`id="${id}"`), `總覽缺少 #${id}`);
    }
    assert.match(app, /function preloadAdminLights\(/, '打開後台要預載各頁燈號');
  });

  test('底部儲存列：每個 data-save 都有對應的存檔方式，存檔成功會清掉未儲存紀錄', () => {
    assert.match(html, /id="adminSaveBar"/);
    const block = name => (app.match(new RegExp(`const ${name} = \\{([^}]*)\\}`)) || [])[1] || '';
    const handled = [...(block('ADMIN_SAVE_FORMS') + block('ADMIN_SAVE_BUTTONS')).matchAll(/(\w+):/g)].map(m => m[1]);
    const keys = [...new Set(navItems.map(n => (html.match(new RegExp(`data-page="${n.page}" data-save="(\\w+)"`)) || [])[1]).filter(Boolean))];
    assert.ok(keys.length >= 6, `data-save 太少：${keys}`);
    for (const k of keys) {
      assert.ok(handled.includes(k), `data-save="${k}" 沒有對應的存檔方式`);
      assert.match(app, new RegExp(`markAdminSaved\\('${k}'\\)`), `存檔成功時沒有呼叫 markAdminSaved('${k}')`);
    }
    // 卡片裡被儲存列取代的按鈕要藏起來
    for (const id of ['adminRegSaveBtn', 'adminLegalSaveBtn', 'adminReportsSaveBtn']) {
      assert.match(html, new RegExp(`class="[^"]*admin-legacy-save[^"]*" id="${id}"`), `${id} 應標記 admin-legacy-save`);
    }
  });

  test('重複項目已移除：後台改密碼、報表自己的時區欄位', () => {
    assert.doesNotMatch(html, /data-card="password"/);
    assert.doesNotMatch(html, /id="btnChangePassword"/);
    assert.match(html, /<input type="hidden" id="adminReportsTz">/);
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert.match(server, /syncReportsTimezone\(config\.settings\.timezone\)/);
  });

  test('後台不再寫死藍色徽章', () => {
    assert.doesNotMatch(html, /rgba\(56, 139, 253/);
  });

  test('⌘K／Ctrl+K 搜尋：有入口、索引涵蓋頁面卡片欄位、Esc 先關搜尋', () => {
    assert.match(html, /id="adminSearchBtn"/);
    assert.match(html, /id="adminPalette" hidden role="dialog"/);
    assert.match(html, /id="adminPaletteInput"[^>]*data-no-dirty/);
    assert.match(app, /function buildAdminSearchIndex\(/);
    assert.match(app, /kind: 'page'/);
    assert.match(app, /kind: 'card'/);
    assert.match(app, /kind: 'field'/);
    assert.match(app, /\(e\.metaKey \|\| e\.ctrlKey\) && !e\.altKey && \(e\.key === 'k' \|\| e\.key === 'K'\)/);
    assert.match(app, /if \(e\.key === 'Escape'\) \{\s*if \(isAdminSearchOpen\(\)\) \{\s*closeAdminSearch\(\);/);
  });

  test('手機版：清單與頁面分開顯示', () => {
    assert.match(css, /\.admin-shell\[data-view="list"\] \.admin-main,\s*\.admin-shell\[data-view="page"\] \.admin-side \{\s*display: none;/);
  });
});
