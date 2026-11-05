/**
 * @file tests/test-source-first.test.js
 *
 * 搜尋的「原文優先」（alpha 批次 13）。
 *
 * 實測：搜「應無所住」，全庫 1,887 次、散在 494 個檔案。其中只有 198 個
 * 是經文原文，其餘 296 個在解釋那句話。原本兩者混在一起排，讀者想找
 * 「佛到底怎麼說的」得先翻過幾百筆後人的話。
 *
 * 這支測試守三件事：
 *   1. 分類對（不把註疏當成經）
 *   2. 重排對（原文真的在前）
 *   3. 不會卡死頁面（踩過無限迴圈）
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const JS = fs.readFileSync(path.join(ROOT_DIR, 'source-first.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT_DIR, 'style.css'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
const SW = fs.readFileSync(path.join(ROOT_DIR, 'sw.js'), 'utf8');

function section57() {
  const i = CSS.indexOf('§57');
  assert.ok(i > 0, '找不到 §57');
  return CSS.slice(i);
}

/** 在模擬的 window 上載入兩個模組，回傳 SourceFirst。 */
function load() {
  const win = {};
  const loadData = new Function('window', fs.readFileSync(
    path.join(ROOT_DIR, 'commentary-data.js'), 'utf8'
  ).replace('})(typeof window !== \'undefined\' ? window : this);', '})(window);'));
  loadData(win);

  const loadMod = new Function('window', JS.replace(
    '})(typeof window !== \'undefined\' ? window : this);', '})(window);'));
  loadMod(win);
  return win.SourceFirst;
}

describe('原文優先：分類', () => {
  test('有 CBETA 經號的算原文', () => {
    const S = load();
    assert.equal(S.canonId('01-大正藏/03般若部類/T0235《金剛般若波羅蜜經》.md'), 'T0235');
    assert.equal(S.classify('01-大正藏/03般若部類/T0235《金剛般若波羅蜜經》.md'), 'source');
  });

  test('註疏清單裡的檔案一定算講解，即使有經號', () => {
    // T1700《金剛般若經贊述》有經號，但它是註疏。只看經號會誤判。
    const S = load();
    assert.equal(S.classify('01-大正藏/03般若部類/T1700《金剛般若經贊述》.md'), 'commentary');
  });

  test('沒有經號的算講解', () => {
    const S = load();
    assert.equal(S.classify('0-索引.md'), 'commentary');
    assert.equal(S.classify('06-菩薩藏/999《金剛經講記》.md'), 'commentary');
  });

  test('帶小寫後綴的經號也能辨識', () => {
    const S = load();
    assert.equal(S.canonId('06-菩薩藏/300/T1510a《金剛般若論》.md'), 'T1510a');
  });

  test('邊界輸入不崩', () => {
    const S = load();
    for (const v of [null, undefined, '', 'abc', '沒有斜線的檔名']) {
      assert.doesNotThrow(() => S.classify(v));
    }
  });

  test('註疏清單真的有內容（不是空的）', () => {
    const S = load();
    assert.ok(Object.keys(S._commentaryPaths()).length > 100);
  });
});

describe('原文優先：資料載入順序', () => {
  test('資料晚到時不會把空集合快取起來', () => {
    // 踩過：commentary-data.js 還沒載入就呼叫，空 set 被快取，
    // 之後永遠是空的——所有註疏都被當成原文，而且不報錯。
    const win = {};
    const loadMod = new Function('window', JS.replace(
      '})(typeof window !== \'undefined\' ? window : this);', '})(window);'));
    loadMod(win);

    const target = '01-大正藏/03般若部類/T1700《金剛般若經贊述》.md';
    // 資料還沒到：暫時誤判可接受，但不能定型
    assert.equal(win.SourceFirst.classify(target), 'source');

    // 資料到了之後必須改判
    const loadData = new Function('window', fs.readFileSync(
      path.join(ROOT_DIR, 'commentary-data.js'), 'utf8'
    ).replace('})(typeof window !== \'undefined\' ? window : this);', '})(window);'));
    loadData(win);

    assert.equal(win.SourceFirst.classify(target), 'commentary');
  });
});

describe('原文優先：不會卡死（踩過的坑）', () => {
  test('有內容簽章', () => {
    // 第一版只靠 suppress 擋遞迴，結果頁面卡死——連 Debugger.pause
    // 都拿不到回應。decorate 每次都 remove+insert legend，那是真實的
    // DOM 變動，於是「變動→decorate→變動」停不下來。
    assert.match(JS, /signatureOf/);
    assert.match(JS, /lastSignature/);
    const fn = JS.match(/function signatureOf\(box\)[\s\S]*?\n  \}/);
    assert.ok(fn);
    assert.match(fn[0], /data-file-group|data-layer/);
  });

  test('簽章相同就直接返回', () => {
    assert.match(JS, /if \(sig === lastSignature\) return;/);
  });

  test('自己改 DOM 時暫停觀察', () => {
    assert.match(JS, /withoutObserving/);
    assert.match(JS, /suppress/);
    assert.match(JS, /if \(suppress > 0\) return;/);
  });

  test('用 microtask 合併同一輪的多次變動', () => {
    assert.match(JS, /_queued/);
    assert.match(JS, /Promise\.resolve\(\)\.then/);
  });
});

describe('原文優先：重排', () => {
  test('原文搬到講解前面', () => {
    const fn = JS.match(/function reorder\(box\)[\s\S]*?\n  \}/);
    assert.ok(fn, '找不到 reorder');
    assert.match(fn[0], /is-source/);
    assert.match(fn[0], /is-commentary/);
    assert.match(fn[0], /createDocumentFragment/);
  });

  test('「顯示更多」留在最後', () => {
    const fn = JS.match(/function reorder\(box\)[\s\S]*?\n  \}/);
    assert.match(fn[0], /search-load-more/);
  });

  test('已經排好就不動（否則捲動位置會亂跳）', () => {
    const fn = JS.match(/function reorder\(box\)[\s\S]*?\n  \}/);
    assert.match(fn[0], /needsMove/);
    assert.match(fn[0], /if \(!needsMove\) return;/);
  });
});

describe('原文優先：說明列', () => {
  test('同時寫出兩層的數量', () => {
    assert.match(JS, /經文原文/);
    assert.match(JS, /後人講解/);
  });

  test('用 DOM API 不用 innerHTML', () => {
    assert.doesNotMatch(JS, /\.innerHTML\s*=/);
  });
});

describe('原文優先：樣式', () => {
  test('原文有左側強調條', () => {
    const s = section57();
    assert.match(s, /\.search-result-group\.is-source::before/);
    assert.match(s, /var\(--accent\)/);
  });

  test('原文摘要用經文字體', () => {
    const s = section57();
    const block = s.match(/\.search-result-group\.is-source \.search-result-snippet\s*\{[\s\S]*?\n\}/);
    assert.ok(block);
    assert.match(block[0], /cjk-serif/);
  });

  test('講解那層明顯退後', () => {
    const s = section57();
    const block = s.match(/\.search-result-group\.is-commentary \.search-result-snippet\s*\{[\s\S]*?\n\}/);
    assert.ok(block);
    assert.match(block[0], /text-secondary/);
  });
});

describe('原文優先：接線', () => {
  test('Service Worker 有快取', () => {
    assert.match(SW, /'\/source-first\.js'/);
  });

  test('腳本有載入', () => {
    assert.match(HTML, /source-first\.js\?v=/);
  });

  test('在 commentary-data.js 之後載入', () => {
    // 順序反了會讓分類全部失效
    const dataIdx = HTML.indexOf('commentary-data.js');
    const modIdx = HTML.indexOf('source-first.js');
    assert.ok(dataIdx > 0 && modIdx > dataIdx, 'source-first.js 必須在 commentary-data.js 之後');
  });

  test('不改 app.js 的搜尋邏輯', () => {
    // ARCHITECTURE.md §18 明令不模組化 app.js；這裡只觀察 DOM。
    // 註解裡會提到那個函式名（說明為何不碰它），要先剝掉。
    const code = JS
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /renderSearchResults/);
    assert.match(code, /MutationObserver/);
  });
});

describe('原文優先：語料前提仍然成立', () => {
  test('語料裡原文與講解的數量都夠多（分層才有意義）', () => {
    const S = load();
    assert.ok(Object.keys(S._commentaryPaths()).length >= 141,
      '註疏清單變少了，分層會失準');
  });
});
