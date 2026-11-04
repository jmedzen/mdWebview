/**
 * @file tests/test-vertical-writing.test.js
 *
 * 直書模式（alpha 批次 5）。
 *
 * 漢傳佛教的典籍一千年來都是直排的——大正藏、卍續藏、CBETA 的原始排版
 * 沒有一部是橫排。這個站已經在「我的書架」用直排書脊，卻讓經文本身
 * 由左往右橫著走。這支測試守的是「這個功能真的能用，而且不會弄壞
 * 原本的橫排」。
 *
 * 重點：
 *   1. 預設必須是橫排（不能因為加了直書就改變多數人的閱讀體驗）。
 *   2. 只有經文轉向，選單與側欄不轉（轉了整個介面會變迷宮）。
 *   3. 表格、程式碼、數學式在直排裡必須保持可讀（橫躺）。
 *   4. 一定要切得回來（快速鍵 + 設定 + 右上角按鈕 + 還原偏好）。
 *   5. 使用者的閱讀寬度偏好不能被直書覆寫。
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const INDEX_HTML = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
const APP_JS = fs.readFileSync(path.join(ROOT_DIR, 'app.js'), 'utf8');
const STYLE_CSS = fs.readFileSync(path.join(ROOT_DIR, 'style.css'), 'utf8');

describe('直書模式：預設與切換', () => {
  test('預設是橫排（沒有偏好時不啟用）', () => {
    assert.match(APP_JS, /function isVerticalWriting\(\)\s*\{\s*return storage\.get\(STORAGE_KEYS\.VERTICAL_WRITING\) === '1';/);
  });

  test('直書偏好有獨立的 storage key', () => {
    assert.match(APP_JS, /VERTICAL_WRITING:\s*'mdWebview-vertical-writing'/);
  });

  test('有切換函式，且會寫回偏好', () => {
    assert.match(APP_JS, /function toggleVerticalWriting\(\)/);
    assert.match(APP_JS, /storage\.set\(STORAGE_KEYS\.VERTICAL_WRITING/);
  });

  test('啟動時會還原上次的直書偏好', () => {
    assert.match(APP_JS, /if \(isVerticalWriting\(\)\) applyVerticalWriting\(true, \{ silent: true \}\)/);
  });

  test('初始化有被接上', () => {
    assert.match(APP_JS, /setupVerticalWriting\(\);/);
  });

  test('快速鍵是 Shift+V，且會避開輸入框', () => {
    assert.match(APP_JS, /e\.shiftKey && \(e\.key === 'V' \|\| e\.key === 'v'\)/);
    assert.match(APP_JS, /t\.tagName === 'INPUT' \|\| t\.tagName === 'TEXTAREA' \|\| t\.isContentEditable/);
  });

  test('快速鍵在沒有開檔案時不作用', () => {
    assert.match(APP_JS, /if \(!state\.currentFile\) return;/);
  });
});

describe('直書模式：CSS 只作用在經文', () => {
  test('writing-mode 掛在有 data-vertical-writing 的根上', () => {
    assert.match(STYLE_CSS, /html\[data-vertical-writing="1"\] \.markdown-body\s*\{[\s\S]*?writing-mode: vertical-rl;/);
  });

  test('方向是由右往左', () => {
    const block = STYLE_CSS.match(/html\[data-vertical-writing="1"\] \.markdown-body\s*\{[\s\S]*?\}/);
    assert.ok(block, '找不到直書主區塊');
    assert.match(block[0], /writing-mode:\s*vertical-rl/);
  });

  test('側欄與選單不轉向', () => {
    // 直書選擇器只允許出現在 .markdown-body / #content / .content-wrapper
    // 等內容區，不可以擴散到 .sidebar 或 .app-header
    const selectors = STYLE_CSS.match(/html\[data-vertical-writing="1"\][^{]*\{/g) || [];
    for (const sel of selectors) {
      assert.ok(
        !/\.sidebar|\.app-header|\.file-tree|\.dict-sidebar/.test(sel),
        `直書不應作用在周邊介面：${sel.trim()}`
      );
    }
  });

  test('表格與程式碼在直排裡保持橫排', () => {
    assert.match(STYLE_CSS, /html\[data-vertical-writing="1"\] \.markdown-body table[\s\S]{0,400}?writing-mode: horizontal-tb;/);
    assert.match(STYLE_CSS, /html\[data-vertical-writing="1"\] \.markdown-body pre[\s\S]{0,200}?writing-mode: horizontal-tb;/);
  });

  test('表格會被側轉，避免在直排流裡壞掉', () => {
    const block = STYLE_CSS.match(/html\[data-vertical-writing="1"\] \.markdown-body table[\s\S]*?\{[\s\S]*?\}/);
    assert.ok(block, '找不到表格的直書規則');
    assert.match(block[0], /transform: rotate\(90deg\)/);
  });

  test('直書在手機上有調整（字級與表格）', () => {
    assert.match(STYLE_CSS, /@media \(max-width: 768px\)\s*\{[\s\S]*?html\[data-vertical-writing="1"\]/);
  });

  test('列印時直書沿用紙本樣式', () => {
    assert.match(STYLE_CSS, /@media print\s*\{[\s\S]*?html\[data-vertical-writing="1"\] \.markdown-body/);
  });
});

describe('直書模式：不可以覆寫使用者的偏好', () => {
  test('不覆寫 --content-max-width', () => {
    const verticalBlocks = STYLE_CSS.match(/html\[data-vertical-writing="1"\][\s\S]*?(?=\nhtml\[data-vertical-writing|\n@media|\n\/\* =)/g) || [];
    for (const b of verticalBlocks) {
      assert.ok(
        !/--content-max-width\s*:/.test(b),
        '直書不可改寫 --content-max-width（那是使用者的閱讀寬度偏好）'
      );
    }
  });
});

describe('直書模式：一定有切回來的路', () => {
  test('HTML 有切換鈕', () => {
    assert.match(INDEX_HTML, /id="verticalToggle"/);
    assert.match(INDEX_HTML, /class="vertical-toggle"/);
  });

  test('切換鈕有 aria-pressed 表示狀態', () => {
    assert.match(INDEX_HTML, /id="verticalToggle"[\s\S]{0,200}?aria-pressed="true"/);
    assert.match(APP_JS, /btn\.setAttribute\('aria-pressed', on \? 'true' : 'false'\)/);
  });

  test('偏好設定裡有書寫方向的分段控制', () => {
    assert.match(INDEX_HTML, /id="settingWritingModeGroup"/);
    assert.match(INDEX_HTML, /data-value="vertical">直書/);
    assert.match(INDEX_HTML, /data-value="horizontal">橫排/);
  });

  test('設定頁的按鈕會與實際狀態同步', () => {
    assert.match(APP_JS, /function syncWritingModeButtons\(\)/);
    assert.match(APP_JS, /syncWritingModeButtons\(\);/);
  });

  test('第一次開啟有說明（捲動方向跟橫排相反）', () => {
    assert.match(INDEX_HTML, /id="verticalHint"/);
    assert.match(INDEX_HTML, /由右往左讀/);
    assert.match(APP_JS, /VERTICAL_HINT_SEEN/);
  });

  test('說明條可以關掉，而且只出現一次', () => {
    assert.match(APP_JS, /verticalHintOk/);
    assert.match(APP_JS, /storage\.set\(STORAGE_KEYS\.VERTICAL_HINT_SEEN, '1'\)/);
  });
});

describe('直書模式：可及性', () => {
  test('切換鈕有螢幕閱讀器可讀的標籤', () => {
    assert.match(INDEX_HTML, /id="verticalToggle"[\s\S]{0,400}?class="sr-only">切換直書／橫排/);
  });

  test('說明條是 role=status（會被讀出來但不搶焦點）', () => {
    assert.match(INDEX_HTML, /id="verticalHint" role="status"|role="status"[^>]*id="verticalHint"/);
  });

  test('直書時「回到頂部」不再進入 tab 順序', () => {
    assert.match(APP_JS, /backTop\.setAttribute\('tabindex', '-1'\)/);
  });
});

describe('直書模式：DOM 對得上（防止 alpha 批次 2a 的靜默失敗重演）', () => {
  /*
   * 學到的教訓：批次 2a 的學習路徑按鈕，HTML 裡叫 homePathsOpen，
   * 程式卻查 learningPathsOpen。配上 ?. 可選鏈，按下去完全沒反應、
   * 沒有錯誤、沒有警告——花了很久才找到。
   *
   * 所以每個新功能的 $('...') 都要驗證對應的 id 真的在 HTML 裡。
   */
  test('app.js 查的每個 vertical* id 都存在於 index.html', () => {
    const ids = [...APP_JS.matchAll(/\$\('(vertical[A-Za-z]*)'\)/g)].map(m => m[1]);
    assert.ok(ids.length > 0, '找不到任何 vertical* 的 $() 查詢');
    for (const id of new Set(ids)) {
      assert.ok(
        INDEX_HTML.includes(`id="${id}"`),
        `app.js 查了 #${id}，但 index.html 沒有這個 id`
      );
    }
  });

  test('設定頁的分段控制 id 存在', () => {
    assert.ok(APP_JS.includes("$('settingWritingModeGroup')"));
    assert.ok(INDEX_HTML.includes('id="settingWritingModeGroup"'));
  });
});
