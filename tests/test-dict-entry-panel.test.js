const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// app.js 是 IIFE，無法 import；沿用專案慣例以原始碼靜態斷言守護辭典釋義面板的契約。
// 互動行為（查詞、返回、Esc、最近查過、手機抽屜）另以瀏覽器實測驗證。
const ROOT_DIR = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT_DIR, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT_DIR, 'style.css'), 'utf8');

function fnBody(signature) {
  const start = app.indexOf(signature);
  assert.ok(start >= 0, `找不到 ${signature}`);
  let i = app.indexOf(') {', start) + 2;
  let depth = 0;
  for (; i < app.length; i++) {
    if (app[i] === '{') depth++;
    else if (app[i] === '}') { depth--; if (depth === 0) return app.slice(start, i + 1); }
  }
  return app.slice(start);
}

describe('辭典釋義面板', () => {
  test('index.html 有釋義區、返回列、最近查過與手機拉把', () => {
    for (const id of ['dictEntry', 'dictEntryBack', 'dictEntryBody', 'dictEntryOthers', 'dictEntryPrev', 'dictEntryNext', 'dictEntryOpen', 'dictHistory', 'dictSheetHandle']) {
      assert.match(html, new RegExp(`id="${id}"`), `缺少 #${id}`);
    }
  });

  test('點查詢結果先在面板開釋義，不再直接把整部辭典開進主閱讀區', () => {
    const i = app.indexOf("const item = e.target.closest('.dict-result-item');");
    assert.ok(i >= 0);
    const after = app.slice(i, i + 400);
    assert.match(after, /if \(openDictResultItem\(item\)\) return;/);
  });

  test('釋義以 render-chunk 只取單一詞條', () => {
    assert.match(fnBody('async function fetchDictEntryHtml('), /\/api\/render-chunk\?path=\$\{encodeURIComponent\(filePath\)\}&from=\$\{ei\}&to=\$\{ei\}/);
  });

  test('面板內容移除 id，避免和主閱讀區的 #L 行號錨點撞號', () => {
    const body = fnBody('function fillDictEntryBody(');
    assert.match(body, /setSanitizedHTML\(el, html\)/);
    assert.match(body, /removeAttribute\('id'\)/);
  });

  test('返回列顯示結果筆數，只有一筆時隱藏', () => {
    const body = fnBody('async function showDictEntry(');
    assert.match(body, /‹ 查詢結果（\$\{resultCount\}）/);
    assert.match(body, /back\.hidden = resultCount <= 1/);
  });

  test('點進搜尋框、輸入、切換模式都回到查詢結果', () => {
    assert.match(app, /dictSearchInput\.addEventListener\('focus', \(\) => \{ if \(state\.dictView === 'entry'\) setDictView\('results'\); \}\)/);
    assert.match(app, /dictSearchInput\.addEventListener\('input', \(e\) => \{ setDictView\('results'\);/);
    assert.match(app, /state\.dictMode = newMode;\n\s*setDictView\('results'\);/);
  });

  test('Esc 在釋義畫面回到查詢結果，對話框開著時不攔截', () => {
    const body = fnBody('function setupDictEntryPanel(');
    assert.match(body, /e\.key !== 'Escape' \|\| !state\.dictSidebarOpen \|\| state\.dictView !== 'entry'/);
    assert.match(body, /\.modal-overlay/);
  });

  test('選字「辭典」：列出詞條清單（不直接開第一筆）、經文中的詞以 CSS Highlight 標示、不把焦點移進搜尋框', () => {
    const i = app.indexOf("dictBtn.addEventListener('click'");
    const body = app.slice(i, i + 2200);
    assert.match(body, /setDictLookupHighlight\(lookupRange\)/);
    assert.match(body, /await lookupDictWord\(rawSelected\);/);
    assert.doesNotMatch(body, /openExact: true/);
    assert.doesNotMatch(body, /dictInput\.focus\(\)/);
    assert.match(fnBody('async function lookupDictWord('), /if \(opts\.openExact\) openDictExactMatch\(q\)/);
    // 「最近查過」仍直接開釋義
    assert.match(app, /lookupDictWord\(chip\.getAttribute\('data-dict-history'\), \{ openExact: true \}\)/);
    assert.match(css, /::highlight\(mdw-dict-lookup\)/);
  });

  test('關閉面板時清除經文標示', () => {
    assert.match(fnBody('function toggleDictSidebar('), /clearDictLookupHighlight\(\)/);
  });

  test('最近查過存在 localStorage，最多 12 筆', () => {
    assert.match(app, /DICT_HISTORY: 'mdWebview-dict-history'/);
    assert.match(app, /const DICT_HISTORY_MAX = 12;/);
  });

  test('手機：底部抽屜、不蓋遮罩、看釋義時收起模式分頁', () => {
    const mobile = css.slice(css.indexOf('@media (max-width: 768px)'));
    assert.match(mobile, /\.dict-sidebar\.collapsed \{\s*transform: translateY\(100%\)/);
    assert.match(mobile, /\.dict-sidebar\.dict-showing-entry \.dict-tabs/);
    assert.doesNotMatch(fnBody('function updateSidebarBackdrop('), /rightOpen/);
  });

  test('按鈕文字為「全文開啟 ↖」', () => {
    assert.match(html, /id="dictEntryOpen"[^>]*>全文開啟 ↖</);
  });

  test('辭典面板字級跟隨使用者的內文字級，沒有寫死的 px', () => {
    const a = css.indexOf('/* ── §35 Dictionary Sidebar');
    const b = css.indexOf('.entry-nav {', a);
    const sec = css.slice(a, b);
    assert.match(sec, /--dict-font-size: var\(--content-font-size, 16px\)/);
    assert.doesNotMatch(sec, /font-size:\s*[0-9.]+px/, '面板內不得有固定 px 字級');
    assert.doesNotMatch(sec, /var\(--sidebar-font-size\)/, '面板不再用檔案樹較小的字級');
    assert.match(sec, /\.dict-entry-md \{[^}]*font-size: var\(--content-font-size, 16px\)/);
  });

  test('寬度不夠時收起左側欄，閱讀區不被擠窄', () => {
    assert.match(fnBody('function toggleDictSidebar('), /window\.innerWidth - leftSidebar\.getBoundingClientRect\(\)\.width - panelW < 520/);
  });
});
