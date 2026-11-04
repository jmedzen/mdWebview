/**
 * @file tests/test-learning-paths.test.js
 *
 * 學習路徑「一條路走到底」（alpha 批次 4b）。
 *
 * 首頁三本書解決「不知道要讀什麼」；讀完之後的「下一步呢」是另一道牆。
 * 這四條路徑各自說明「為什麼是這個順序」，而不是只列書單。
 *
 * 這支測試守的重點，其中第一個是真的踩過的坑：
 *
 *   1. 按鈕 id 與程式查的 id 要一致。原本 HTML 寫 homePathsOpen、程式查
 *      learningPathsOpen，配上 `?.` 可選鏈之後完全靜默——按鈕看起來正常、
 *      按下去毫無反應，console 連警告都沒有。這種錯改起來五分鐘，
 *      找起來卻花了很久，所以用測試釘住。
 *   2. 每部經都要真的存在於語料（路徑靠 經號＋經名 解析，不是寫死路徑）。
 *   3. 字數標示要有依據（實測，不是憑感覺）。
 *   4. 不做進度條／分數／勾選——這個站台不把修行變成待辦清單。
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const INDEX_HTML = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
const APP_JS = fs.readFileSync(path.join(ROOT_DIR, 'app.js'), 'utf8');
const STYLE_CSS = fs.readFileSync(path.join(ROOT_DIR, 'style.css'), 'utf8');

const pathsBlock = APP_JS.match(/const LEARNING_PATHS = \[([\s\S]*?)\n  \];/);

describe('學習路徑：入口與 id 一致性', () => {
  test('首頁有「一條路走到底」的入口按鈕', () => {
    assert.match(INDEX_HTML, /id="homePathsOpen"/);
    assert.match(INDEX_HTML, /一條路走到底/);
  });

  test('入口自己的 id 就是程式查的那個（曾經寫錯成 learningPathsOpen）', () => {
    const setup = APP_JS.match(/function setupLearningPaths\(\)[\s\S]*?\n  \}/);
    assert.ok(setup, '應有 setupLearningPaths');
    // 程式必須查 homePathsOpen
    assert.match(setup[0], /\$\('homePathsOpen'\)/, '綁定時應查 homePathsOpen');
    // 不可以查一個 HTML 裡不存在的 id
    assert.doesNotMatch(setup[0], /\$\('learningPathsOpen'\)/,
      'learningPathsOpen 在 HTML 裡不存在；配上 ?. 會完全靜默');
  });

  test('所有 $() 查的 learning* id 都真的存在於 HTML', () => {
    for (const m of APP_JS.matchAll(/\$\('(learning[A-Za-z]+)'\)/g)) {
      assert.ok(INDEX_HTML.includes(`id="${m[1]}"`),
        `app.js 查 #${m[1]}，但 index.html 沒有這個 id`);
    }
  });

  test('overlay 有 dialog 語意與關閉鈕', () => {
    const tag = INDEX_HTML.match(/<div[^>]*id="learningPathsOverlay"[^>]*>/);
    assert.ok(tag);
    assert.match(tag[0], /role="dialog"/);
    assert.match(tag[0], /aria-modal="true"/);
    assert.match(tag[0], /aria-labelledby="learningPathsTitle"/);
    assert.match(INDEX_HTML, /id="learningPathsCloseBtn"/);
  });

  test('三個關閉途徑：關閉鈕、點背景、Esc', () => {
    const setup = APP_JS.match(/function setupLearningPaths\(\)[\s\S]*?\n  \}/);
    assert.match(setup[0], /learningPathsCloseBtn[\s\S]{0,120}addEventListener\('click'/);
    assert.match(setup[0], /e\.target === overlay[\s\S]{0,60}closeLearningPaths/);
    assert.match(setup[0], /e\.key !== 'Escape'/);
  });

  test('開關會接上焦點管理（鍵盤使用者進得去也出得來）', () => {
    assert.match(APP_JS, /function openLearningPaths\(\)[\s\S]*?activateModalFocus\(overlay/);
    assert.match(APP_JS, /function closeLearningPaths\(\)[\s\S]*?deactivateModalFocus\(overlay/);
  });
});

describe('學習路徑：內容', () => {
  test('有四條路徑，每條都有名稱與「為什麼是這個順序」', () => {
    assert.ok(pathsBlock, '應有 LEARNING_PATHS');
    const body = pathsBlock[1];
    assert.equal((body.match(/key: '/g) || []).length, 4, '應有四條');
    assert.equal((body.match(/why: '/g) || []).length, 4, '每條都要說明理由');
  });

  test('理由不是空話：每條都至少 30 字', () => {
    for (const m of pathsBlock[1].matchAll(/why: '([^']+)'/g)) {
      assert.ok(m[1].length >= 30, `理由太短，看不出判斷：${m[1]}`);
    }
  });

  test('每部經都有經號、經名與實測字數', () => {
    const steps = [...pathsBlock[1].matchAll(/tx: '(T\d+)', title: '([^']+)', hanzi: (\d+)/g)];
    assert.ok(steps.length >= 9, `應至少有 9 個步驟，實得 ${steps.length}`);
    for (const [, tx, title, hanzi] of steps) {
      assert.match(tx, /^T\d{4}$/, `經號格式不對：${tx}`);
      assert.ok(Number(hanzi) > 100, `${title} 的字數不合理：${hanzi}`);
    }
  });

  test('每一步都指向語料裡真的存在的檔案', () => {
    const mdDir = path.join(ROOT_DIR, 'md');
    if (!fs.existsSync(mdDir)) return; // CI 只有程式碼
    const names = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.md')) names.push(e.name);
      }
    })(mdDir);
    const norm = s => String(s || '').toLowerCase().replace(/[《》〈〉「」『』（）()\[\]\s，。、；：·‧_\-]/g, '');
    for (const m of pathsBlock[1].matchAll(/tx: '(T\d+)', title: '([^']+)'/g)) {
      const hit = names.some(n => norm(n).includes(norm(m[1])) && norm(n).includes(norm(m[2])));
      assert.ok(hit, `${m[1]}《${m[2]}》在 md/ 裡找不到——語料換版時這條路徑會斷`);
    }
  });

  test('心經用 T0253 而不是佔位檔 T0251', () => {
    const blocks = pathsBlock[1].split("key: '");
    for (const b of blocks) {
      if (!b.includes('般若波羅蜜多心經')) continue;
      assert.ok(b.includes("tx: 'T0253'"),
        '心經應指向 T0253（CBETA 真實譯本）；T0251 在語料裡是合成測試佔位檔');
    }
  });

  test('時數由字數換算，不是寫死的（避免文案與內容脫節）', () => {
    assert.match(APP_JS, /function pathReadingTime\(steps\)/);
    const fn = APP_JS.match(/function pathReadingTime\(steps\)[\s\S]*?\n  \}/);
    assert.match(fn[0], /s\.hanzi/, '應由 hanzi 累計');
    assert.doesNotMatch(pathsBlock[1], /meta: '約/, '不要再寫死時數');
  });

  test('不做進度條、分數或勾選清單', () => {
    // 只允許「讀過」的淡色記號（.is-read），不要進度百分比或分數
    assert.doesNotMatch(APP_JS, /learning-path[\s\S]{0,80}progress/i);
    assert.doesNotMatch(APP_JS, /learning-path[\s\S]{0,80}score/i);
    assert.doesNotMatch(APP_JS, /learning-path[\s\S]{0,80}percent/i);
  });
});

describe('學習路徑：行為', () => {
  test('點任一步驟：關掉 overlay 再開檔', () => {
    const setup = APP_JS.match(/function setupLearningPaths\(\)[\s\S]*?\n  \}/);
    assert.match(setup[0], /closeLearningPaths\(\)/);
    assert.match(setup[0], /openFile\(btn\.dataset\.path\)/);
  });

  test('找不到的檔案顯示為不可點，而不是按了沒反應', () => {
    const fn = APP_JS.match(/function renderLearningPaths\(\)[\s\S]*?\n  \}/);
    assert.match(fn[0], /disabled/, '解析不到檔案時按鈕應 disabled');
    assert.match(fn[0], /這份語料沒有收錄/, '要說明原因');
  });

  test('每次開啟都重畫（讀過的記號才會更新）', () => {
    const fn = APP_JS.match(/function openLearningPaths\(\)[\s\S]*?\n  \}/);
    assert.match(fn[0], /renderLearningPaths\(\)/);
  });

  test('路徑解析沿用 resolveStartPath（經號＋經名，不寫死資料夾）', () => {
    const fn = APP_JS.match(/function renderLearningPaths\(\)[\s\S]*?\n  \}/);
    assert.match(fn[0], /resolveStartPath\(s\)/);
  });
});

describe('學習路徑：樣式', () => {
  test('卡片可捲動（四條路徑會超過一個視窗）', () => {
    const body = STYLE_CSS.match(/\.learning-paths-body\s*\{([^}]*)\}/);
    assert.ok(body);
    assert.match(body[1], /overflow-y:\s*auto/);
  });

  test('摘要與名稱用襯線體；簡體顯示時換字型', () => {
    assert.match(STYLE_CSS, /\.learning-path-step-name\s*\{[^}]*var\(--cjk-serif\)/);
    assert.match(STYLE_CSS, /html\[data-display-script="hans"\] \.learning-path-step-name/);
  });

  test('手機：卡片貼底、可點高度足夠', () => {
    const mobile = STYLE_CSS.match(/@media \(max-width: 640px\)\s*\{\s*\n\s*\.learning-paths-card/);
    assert.ok(mobile, '應有手機斷點');
    const block = STYLE_CSS.slice(STYLE_CSS.indexOf('@media (max-width: 640px) {\n  .learning-paths-card'));
    assert.match(block.slice(0, 400), /min-height:\s*4[0-9]px/);
  });
});
