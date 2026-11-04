/**
 * @file tests/test-focus-mode.test.js
 *
 * 專注模式（alpha 批次 2c）。
 *
 * 讀長經的時候，左邊的檔案樹、上面的工具列、右邊的辭典都在搶注意力。
 * 這個模式把它們收起來，只留經文，用 F 進出、Esc 離開。
 *
 * 這支測試守的重點：
 *   1. 只在「正在讀一篇文章」時才有效——首頁沒有周邊可收。
 *   2. 一定要有「離開」的路：只收不放的介面會把用滑鼠的人困住。
 *   3. 不動使用者的偏好（閱讀寬度、側欄、主題），離開後原樣回來。
 *   4. 在輸入框裡打字不會誤觸 F。
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const INDEX_HTML = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
const APP_JS = fs.readFileSync(path.join(ROOT_DIR, 'app.js'), 'utf8');
const STYLE_CSS = fs.readFileSync(path.join(ROOT_DIR, 'style.css'), 'utf8');

const setupFn = APP_JS.match(/function setupFocusMode\(\)[\s\S]*?\n  \}\n/);
const setFn = APP_JS.match(/function setFocusMode\([\s\S]*?\n  \}\n/);
const canFn = APP_JS.match(/function canUseFocusMode\(\)[\s\S]*?\n  \}/);

describe('專注模式：入口與出口', () => {
  test('頁首有專注模式按鈕，帶 aria-pressed', () => {
    assert.match(INDEX_HTML, /id="focusModeBtn"/);
    const tag = INDEX_HTML.match(/<button[^>]*id="focusModeBtn"[^>]*>/)[0];
    assert.match(tag, /aria-pressed="false"/, '切換鈕要有 aria-pressed 表示狀態');
    assert.match(tag, /aria-label=/, '純圖示按鈕需要可讀名稱');
  });

  test('有「離開專注」按鈕，且放在 <main> 外面', () => {
    assert.match(INDEX_HTML, /id="focusModeExit"/);
    const exitIdx = INDEX_HTML.indexOf('id="focusModeExit"');
    const mainIdx = INDEX_HTML.indexOf('<main class="content"');
    const mainEnd = INDEX_HTML.indexOf('</main>');
    assert.ok(exitIdx > 0 && mainIdx > 0);
    assert.ok(exitIdx < mainIdx || exitIdx > mainEnd,
      '退出鈕不可放在 <main> 內：那裡的 fixed 定位會以捲動容器為基準，按鈕會跟著內容跑掉');
  });

  test('三種離開方式都接上了：按鈕、Esc、F', () => {
    assert.ok(setupFn, '應有 setupFocusMode');
    const b = setupFn[0];
    assert.match(b, /focusModeBtn[\s\S]{0,120}addEventListener\('click'/, 'F 按鈕');
    assert.match(b, /focusModeExit[\s\S]{0,160}addEventListener\('click'/, '退出按鈕');
    assert.match(b, /e\.key === 'Escape'/, 'Esc 離開');
    assert.match(b, /e\.key === 'f' \|\| e\.key === 'F'/, 'F 進出');
  });

  test('只在讀文章時可用；首頁按 F 會說明而不是靜默', () => {
    assert.ok(canFn, '應有 canUseFocusMode');
    assert.match(canFn[0], /state\.currentFile/, '判斷依據是「有沒有正在讀的檔案」');
    const toggle = APP_JS.match(/function toggleFocusMode\(\)[\s\S]*?\n  \}/);
    assert.ok(toggle, '應有 toggleFocusMode');
    assert.match(toggle[0], /showToast\(/, '首頁按 F 應提示，而不是完全沒反應');
  });

  test('在輸入框裡打字不會觸發 F', () => {
    assert.match(setupFn[0], /isContentEditable/);
    assert.match(setupFn[0], /INPUT\|TEXTAREA\|SELECT/);
  });

  test('有對話框開著時 Esc 先給對話框（不搶它的關閉）', () => {
    assert.match(setupFn[0], /\.modal-overlay/);
    assert.match(setupFn[0], /anyModal/);
  });
});

describe('專注模式：不動使用者的偏好', () => {
  test('只切換 body 的 class，不改 DOM 結構或其他設定', () => {
    assert.ok(setFn, '應有 setFocusMode');
    const b = setFn[0];
    assert.match(b, /classList\.toggle\('focus-mode'/, '應以 class 切換，由 CSS 負責收起');
    // 不可以去改 style.display 或使用者的寬度設定
    assert.doesNotMatch(b, /style\.display\s*=/, '不要直接改元素的 display，交給 CSS §45');
    assert.doesNotMatch(b, /contentMaxWidth|setProperty\('--content-max-width/,
      '不可改使用者的閱讀寬度設定');
    assert.doesNotMatch(b, /sidebarCollapsed\s*=/, '不可改動側欄偏好');
  });

  test('CSS 不改 --content-max-width（那是使用者自己選的閱讀寬度）', () => {
    // 先去掉註解再檢查：說明「為什麼不改」的註解裡也會出現 max-width 字樣，
    // 直接掃原文會誤判。
    const css = STYLE_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const block = css.match(/body\.focus-mode \.content-wrapper\s*\{([^}]*)\}/);
    if (block) {
      assert.doesNotMatch(block[1], /max-width/,
        '專注模式不該蓋掉使用者的閱讀寬度段位');
    }
    // 也不該用 !important 硬蓋
    assert.doesNotMatch(css, /body\.focus-mode \.content-wrapper\s*\{[^}]*max-width[^}]*!important/);
    // 也不該去動那個變數
    assert.doesNotMatch(css, /body\.focus-mode[^{]*\{[^}]*--content-max-width\s*:/,
      '不該覆寫 --content-max-width 變數');
  });

  test('偏好會記住，下次開文章沿用', () => {
    assert.match(APP_JS, /FOCUS_MODE:\s*'mdWebview-focus-mode'/);
    assert.match(setFn[0], /storage\.set\(STORAGE_KEYS\.FOCUS_MODE/, '應寫入偏好');
    assert.match(setupFn[0], /FOCUS_MODE[\s\S]{0,200}setFocusMode\(true, \{ silent: true \}\)/,
      '下次開文章時應沿用上次的選擇');
  });

  test('回首頁會自動離開專注模式', () => {
    const goHome = APP_JS.match(/function goHome\([^)]*\)[\s\S]*?\n  \}/);
    assert.ok(goHome);
    assert.match(goHome[0], /isFocusMode\(\)[\s\S]{0,80}setFocusMode\(false/,
      '首頁沒有周邊可收，留著只會讓版面變窄');
  });
});

describe('專注模式：樣式', () => {
  test('收起頁首、側欄、辭典、麵包屑與頁內搜尋', () => {
    const block = STYLE_CSS.match(/body\.focus-mode \.app-header,[\s\S]*?\{([^}]*)\}/);
    assert.ok(block, '應有一段集中收起周邊的規則');
    const sel = STYLE_CSS.slice(STYLE_CSS.indexOf('body.focus-mode .app-header'),
      STYLE_CSS.indexOf('body.focus-mode .app-header') + 700);
    for (const part of ['.app-header', '.sidebar', '.dict-sidebar', '.content-header', '.page-search-bar']) {
      assert.ok(sel.includes(part), `應收起 ${part}`);
    }
    assert.match(block[1], /display:\s*none\s*!important/);
  });

  test('整個 content-header 一起收（避免留下標題與下框線）', () => {
    // 只收 .file-path-row 會留下 .file-title 和它的 border-bottom
    assert.doesNotMatch(STYLE_CSS, /body\.focus-mode \.content-header \.file-path-row/,
      '應收整個 .content-header，而不是只收 path row');
  });

  test('.content 不可改成 flex（fixed 子元素會被當 flex item 排到畫面外）', () => {
    assert.doesNotMatch(STYLE_CSS, /body\.focus-mode \.content\s*\{[^}]*display:\s*flex/,
      '改成 flex 會讓 fixed 定位的退出鈕位置跑掉（實測 x=-18）');
  });

  test('退出鈕只在專注模式出現，平時 display:none', () => {
    const base = STYLE_CSS.match(/^\.focus-exit\s*\{([^}]*)\}/m);
    assert.ok(base, '應有 .focus-exit 基礎樣式');
    assert.match(base[1], /display:\s*none/);
    assert.match(STYLE_CSS, /body\.focus-mode \.focus-exit\s*\{[^}]*display:\s*inline-flex/);
  });

  test('手機斷點有調整（小螢幕留白要更小）', () => {
    const mobile = STYLE_CSS.match(/@media \(max-width: 768px\)\s*\{\s*\n\s*body\.focus-mode \.content-wrapper/);
    assert.ok(mobile, '應有手機專注模式調整');
  });
});
