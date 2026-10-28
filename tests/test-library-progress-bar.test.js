/**
 * @file tests/test-library-progress-bar.test.js — 「書籤與歷程」抽屜的閱讀進度條
 *
 * 書籤頁原本只把進度寫在副標題（「加入於 … · 讀到 37%」），歷程頁卻有細進度條 +
 * 右側百分比。兩邊呈現不一致，而且書籤一旦沒有 b.time 就完全看不到進度。
 * 這裡驗證兩頁改用同一組 helper 與樣式，並把跨裝置同步回來的越界值收斂在 0–100。
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT_DIR = path.resolve(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT_DIR, 'app.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(ROOT_DIR, 'style.css'), 'utf8');

/** 從 app.js 抽出指定函式的原始碼（含大括號配對，忽略字串內的括號） */
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `app.js 應定義 ${name}()`);
  let depth = 0;
  let quote = null;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`無法擷取 ${name}()`);
}

function loadHelpers() {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(
    `${extractFunction(appSrc, 'libraryProgressPct')}\n`
    + `${extractFunction(appSrc, 'libraryProgressBarHtml')}\n`,
    ctx
  );
  return ctx;
}

describe('書籤與歷程 — 閱讀進度條', () => {
  const helpers = loadHelpers();

  test('百分比收斂為 0–100 的整數', () => {
    assert.equal(helpers.libraryProgressPct({ pct: 37.4 }), 37);
    assert.equal(helpers.libraryProgressPct({ pct: 0 }), 0);
    assert.equal(helpers.libraryProgressPct({ pct: 100 }), 100);
    assert.equal(helpers.libraryProgressPct({ pct: 130 }), 100, '越界值應夾在 100');
    assert.equal(helpers.libraryProgressPct({ pct: -20 }), 0, '負值應夾在 0');
    assert.equal(helpers.libraryProgressPct({ pct: 99.6 }), 100, '四捨五入而非無條件捨去');
  });

  test('沒有進度時回 null，不誤顯示 0%', () => {
    assert.equal(helpers.libraryProgressPct(null), null);
    assert.equal(helpers.libraryProgressPct({}), null, '缺少 pct 欄位視為沒有進度');
    assert.equal(helpers.libraryProgressPct({ pct: null }), null, '同步格式允許 pct 為 null');
    assert.equal(helpers.libraryProgressPct({ pct: NaN }), null);
    assert.equal(helpers.libraryProgressPct({ pct: '37' }), null, '字串不是合法進度');
  });

  test('進度條標記使用既有的 .library-bar 樣式，寬度即百分比', () => {
    const html = helpers.libraryProgressBarHtml(42);
    assert.match(html, /class="library-bar"/, '書籤與歷程必須共用同一組樣式');
    assert.match(html, /aria-hidden="true"/, '裝飾性進度條應對螢幕閱讀器隱藏');
    assert.match(html, /<i style="width:42%"><\/i>/, '內層寬度應等於百分比');
    assert.equal(helpers.libraryProgressBarHtml(null), '', '沒有進度時不輸出進度條');
  });

  test('書籤與歷程兩頁都使用同一組 helper（不再各自拼字串）', () => {
    const renderBody = extractFunction(appSrc, 'renderLibrary');

    // 書籤列表的渲染迴圈與歷程列表的渲染迴圈分開取，避免抓到巢狀的 if/else 分支。
    const bookmarkLoop = renderBody.slice(
      renderBody.indexOf('for (const b of list) {'),
      renderBody.indexOf('for (const r of list) {')
    );
    const recentLoop = renderBody.slice(renderBody.indexOf('for (const r of list) {'));

    assert.ok(bookmarkLoop.includes('libraryProgressPct('), '書籤頁應以 libraryProgressPct() 正規化百分比');
    assert.ok(bookmarkLoop.includes('libraryProgressBarHtml('), '書籤頁應以 libraryProgressBarHtml() 產生進度條');
    assert.ok(recentLoop.includes('libraryProgressPct('), '歷程頁應以 libraryProgressPct() 正規化百分比');
    assert.ok(recentLoop.includes('libraryProgressBarHtml('), '歷程頁應以 libraryProgressBarHtml() 產生進度條');

    assert.ok(
      !/<span class="library-bar"[^`]*style="width:\$\{/.test(renderBody),
      '不得再有內聯拼出的進度條，一律走 libraryProgressBarHtml()'
    );
  });

  test('書籤頁不再把進度塞進「加入於…」副標題', () => {
    assert.ok(
      !appSrc.includes('讀到 ${prog.pct}%'),
      '書籤副標題不應再硬塞進度；進度改由進度條與右側百分比呈現'
    );
  });

  test('進度條樣式存在且可隨主題變色', () => {
    assert.match(cssSrc, /\.library-bar\s*\{\s*display:\s*block;/, '應有 .library-bar 基礎樣式');
    assert.match(cssSrc, /\.library-bar i\s*\{[^}]*background:\s*var\(--accent\)/, '進度條填色應走主題變數');
  });
});
