/**
 * @file tests/test-next-reading.test.js
 *
 * 讀到卷末的「接下來讀什麼」（alpha 批次 3b）。
 *
 * 《大般若經》單一檔案就有兩千多頁。讀到底之後畫面就只是結束了——左邊的
 * 檔案樹不會告訴你「同一個資料夾裡的下一篇是哪一檔」，讀者得自己回頭翻目錄。
 *
 * 這支測試守的是四件事，每一件都真的壞過或很容易壞：
 *   1. 路徑格式對得上。/api/tree 給的是 `01-大正藏/…`，openFile 也可能收到
 *      `md/01-大正藏/…`。兩邊不統一就永遠找不到兄弟檔（實際踩過）。
 *   2. 只認同一個資料夾。跨部類亂跳比沒有導覽更糟。
 *   3. 不把目錄／索引檔當成下一篇。
 *   4. 沒有可去的地方就整塊隱藏，不留空殼。
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const INDEX_HTML = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
const APP_JS = fs.readFileSync(path.join(ROOT_DIR, 'app.js'), 'utf8');
const STYLE_CSS = fs.readFileSync(path.join(ROOT_DIR, 'style.css'), 'utf8');

describe('文末導覽：結構', () => {
  test('index.html 有 nextReading 區塊，預設 hidden', () => {
    assert.match(INDEX_HTML, /id="nextReading"[^>]*hidden/);
    assert.match(INDEX_HTML, /id="nextReadingPrev"/);
    assert.match(INDEX_HTML, /id="nextReadingNext"/);
  });

  test('兩個按鈕預設都 hidden（只有真的有目標才顯示）', () => {
    for (const id of ['nextReadingPrev', 'nextReadingNext']) {
      const tag = INDEX_HTML.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`));
      assert.ok(tag, id);
      assert.match(tag[0], /hidden/, `${id} 應預設 hidden`);
    }
  });

  test('按鈕上直接寫出經名，不是只寫「下一篇」', () => {
    assert.match(INDEX_HTML, /id="nextReadingNextName"/);
    assert.match(INDEX_HTML, /id="nextReadingPrevName"/);
    const fn = APP_JS.match(/function renderNextReading\(\)[\s\S]*?\n  \}/);
    assert.match(fn[0], /nextReadingNextName'\)\.textContent/,
      '應把經名寫進按鈕，讓讀者不必點進去才知道是什麼');
  });

  test('有 aria-label 說明這個導覽是什麼', () => {
    assert.match(INDEX_HTML, /id="nextReading"[^>]*aria-label=/);
  });
});

describe('文末導覽：兄弟檔查找', () => {
  test('路徑正規化：md/ 前綴與 ./ 都要能對上', () => {
    const fn = APP_JS.match(/function normTreePath\(p\)\s*\{([\s\S]*?)\n  \}/);
    assert.ok(fn, '應有 normTreePath');
    // 原始碼裡是 replace(/^\.\//, '') 與 replace(/^md\//, '')
    assert.ok(fn[1].includes(String.raw`/^\.\//`), '應去掉開頭的 ./');
    assert.ok(fn[1].includes(String.raw`/^md\//`), '應去掉開頭的 md/');
  });

  test('找兄弟檔時兩邊都先正規化（不然永遠對不上）', () => {
    const sib = APP_JS.match(/function siblingFilesOf\([\s\S]*?\n  \}/);
    assert.ok(sib, '應有 siblingFilesOf');
    assert.match(sib[0], /const target = normTreePath\(filePath\)/);
    assert.match(sib[0], /normTreePath\(node\.path\) === dirPart/);
    const next = APP_JS.match(/function nextReadingFor\([\s\S]*?\n  \}/);
    assert.match(next[0], /normTreePath\(f\.path\) === target/);
  });

  test('只取同一個資料夾的「檔案」，不含資料夾', () => {
    const sib = APP_JS.match(/function siblingFilesOf\([\s\S]*?\n  \}/);
    assert.match(sib[0], /\.filter\(c => c\.type === 'file'\)/);
  });

  test('資料夾路徑由檔案路徑切出來（最後一個 / 之前）', () => {
    const sib = APP_JS.match(/function siblingFilesOf\([\s\S]*?\n  \}/);
    assert.match(sib[0], /lastIndexOf\('\/'\)/);
  });

  test('找不到資料夾或檔案就回 null，不是硬塞一個結果', () => {
    const sib = APP_JS.match(/function siblingFilesOf\([\s\S]*?\n  \}/);
    assert.match(sib[0], /return null/);
    const next = APP_JS.match(/function nextReadingFor\([\s\S]*?\n  \}/);
    assert.match(next[0], /if \(idx < 0\) return null/);
  });
});

describe('文末導覽：該跳過什麼', () => {
  test('目錄／索引檔不當成下一篇', () => {
    const fn = APP_JS.match(/function isSkipAsNextReading\([\s\S]*?\n  \}/);
    assert.ok(fn, '應有 isSkipAsNextReading');
    assert.match(fn[0], /總目錄/);
    assert.match(fn[0], /索引/);
  });

  test('遇到要跳過的，會繼續往下找而不是放棄', () => {
    const next = APP_JS.match(/function nextReadingFor\([\s\S]*?\n  \}/);
    assert.match(next[0], /for \(let i = from;[\s\S]{0,160}i \+= step/,
      '應以迴圈跳過不適合的檔案');
    assert.match(next[0], /isSkipAsNextReading\(siblings\[i\]\)/);
  });

  test('辭典不適用（它有自己的前一條／後一條）', () => {
    const fn = APP_JS.match(/function renderNextReading\(\)[\s\S]*?\n  \}/);
    assert.match(fn[0], /startsWith\('dict:'\)/, '辭典應整塊隱藏');
  });
});

describe('文末導覽：顯隱與行為', () => {
  test('前後都沒有就整塊隱藏，不留空殼', () => {
    const fn = APP_JS.match(/function renderNextReading\(\)[\s\S]*?\n  \}/);
    assert.match(fn[0], /if \(!nav \|\| \(!nav\.prev && !nav\.next\)\)[\s\S]{0,80}hidden = true/);
  });

  test('只有一邊時，另一邊隱藏而不是顯示空按鈕', () => {
    const fn = APP_JS.match(/function renderNextReading\(\)[\s\S]*?\n  \}/);
    assert.match(fn[0], /prevBtn\.hidden = true/);
    assert.match(fn[0], /nextBtn\.hidden = true/);
  });

  test('開檔後會重算（renderNextReading 在 openFile 裡被呼叫）', () => {
    const openFn = APP_JS.match(/async function openFile\([\s\S]*?\n  \}/);
    assert.ok(openFn, '應有 openFile');
    assert.match(openFn[0], /renderNextReading\(\)/);
  });

  test('回首頁會收起來', () => {
    const goHome = APP_JS.match(/function goHome\([^)]*\)[\s\S]*?\n  \}/);
    assert.match(goHome[0], /nextReading[\s\S]{0,80}hidden = true/);
  });

  test('點下去開新的一篇並回到頂端（不是停在上一頁的捲動位置）', () => {
    const fn = APP_JS.match(/function setupNextReading\(\)[\s\S]*?\n  \}/);
    assert.ok(fn, '應有 setupNextReading');
    assert.match(fn[0], /openFile\(btn\.dataset\.path/);
    assert.match(fn[0], /scrollTop = 0/);
  });

  test('按鈕路徑以樹狀路徑存（/api/render 認得這個格式）', () => {
    const fn = APP_JS.match(/function renderNextReading\(\)[\s\S]*?\n  \}/);
    assert.match(fn[0], /prevBtn\.dataset\.path = nav\.prev\.path/);
    assert.match(fn[0], /nextBtn\.dataset\.path = nav\.next\.path/);
  });
});

describe('文末導覽：樣式', () => {
  test('有一條細線與留白，讀起來像書頁下緣', () => {
    const base = STYLE_CSS.match(/^\.next-reading\s*\{([^}]*)\}/m);
    assert.ok(base);
    assert.match(base[1], /border-top/);
    assert.match(base[1], /margin:\s*56px 0 32px/);
  });

  test('下一篇靠右（跟閱讀方向一致）', () => {
    const next = STYLE_CSS.match(/^\.next-reading-btn-next\s*\{([^}]*)\}/m);
    assert.ok(next);
    assert.match(next[1], /text-align:\s*right/);
  });

  test('經名用襯線體；簡體顯示時換字型', () => {
    assert.match(STYLE_CSS, /\.next-reading-name\s*\{[^}]*var\(--cjk-serif\)/);
    assert.match(STYLE_CSS, /html\[data-display-script="hans"\] \.next-reading-name/);
  });

  test('手機改單欄，可點高度足夠', () => {
    const mobile = STYLE_CSS.match(/@media \(max-width: 640px\)\s*\{\s*\n\s*\.next-reading\s*\{[\s\S]*?\n\}/);
    assert.ok(mobile, '應有手機斷點');
    assert.match(mobile[0], /flex-direction:\s*column/);
    assert.match(mobile[0], /min-height:\s*56px/);
  });
});
