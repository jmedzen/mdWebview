/**
 * @file tests/test-canon-map.test.js
 *
 * 藏經地圖（alpha 批次 6）。
 *
 * 側邊欄的檔案樹是「目錄」——它告訴你東西在哪，卻不告訴你「這裡有多大」。
 * 7,222 個檔案、1.3 GB 擺在可折疊清單裡，人只看得到自己展開的那三四層。
 *
 * 這支測試守三件事：
 *   1. 面積必須正比於字數（不然就不是地圖，是裝飾）
 *   2. 不能有方塊遺失、重疊、小到點不到
 *   3. 開啟檔案只走 app.js 既有的介面，不自己操作 DOM
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const INDEX_HTML = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
const APP_JS = fs.readFileSync(path.join(ROOT_DIR, 'app.js'), 'utf8');
const CANON_JS = fs.readFileSync(path.join(ROOT_DIR, 'canon-map.js'), 'utf8');
const STYLE_CSS = fs.readFileSync(path.join(ROOT_DIR, 'style.css'), 'utf8');
const SW_JS = fs.readFileSync(path.join(ROOT_DIR, 'sw.js'), 'utf8');

/** 從模組抽一個函式出來單獨測（模組用 IIFE，沒有 export）。 */
function extractFn(name) {
  const i = CANON_JS.indexOf('function ' + name + '(');
  assert.ok(i >= 0, `canon-map.js 找不到 function ${name}`);
  let depth = 0, started = false;
  for (let j = i; j < CANON_JS.length; j++) {
    if (CANON_JS[j] === '{') { depth++; started = true; }
    else if (CANON_JS[j] === '}') {
      depth--;
      if (started && depth === 0) return CANON_JS.slice(i, j + 1);
    }
  }
  throw new Error('unbalanced braces in ' + name);
}

const mod = new Function(
  'var BYTES_PER_CHAR = 4.2;\n' +
  extractFn('humanChars') + extractFn('subtreeBytes') +
  extractFn('subtreeFiles') + extractFn('sliceAndDice') +
  '; return { humanChars, subtreeBytes, subtreeFiles, sliceAndDice };'
)();

describe('藏經地圖：字數換算', () => {
  test('億／萬／千／字四級都會出現', () => {
    assert.match(mod.humanChars(1395000000), /億字$/);
    assert.match(mod.humanChars(420000), /萬字$/);
    assert.match(mod.humanChars(42000), /萬字$/);
    assert.match(mod.humanChars(4200), /千字$/);
    assert.match(mod.humanChars(420), /^約 \d+ 字$/);
  });

  test('0 位元組回空字串（不要顯示「約 0 字」）', () => {
    assert.equal(mod.humanChars(0), '');
    assert.equal(mod.humanChars(null), '');
  });

  test('10 萬字以上不帶小數（避免假精確）', () => {
    assert.doesNotMatch(mod.humanChars(420000), /\.\d/);
  });
});

describe('藏經地圖：方塊圖演算法', () => {
  const items = [
    { entry: { name: 'A' }, bytes: 1000 },
    { entry: { name: 'B' }, bytes: 500 },
    { entry: { name: 'C' }, bytes: 250 },
    { entry: { name: 'D' }, bytes: 125 }
  ];
  const W = 800, H = 500;
  const rects = mod.sliceAndDice(items, { x: 0, y: 0, w: W, h: H });
  const total = items.reduce((s, it) => s + it.bytes, 0);

  test('每一項都拿到一個矩形（不會遺失）', () => {
    assert.equal(rects.length, items.length);
  });

  test('面積嚴格正比於資料量', () => {
    for (const r of rects) {
      const expected = r.entry.bytes / total;
      const actual = (r.w * r.h) / (W * H);
      assert.ok(
        Math.abs(expected - actual) < 0.001,
        `${r.entry.name}：期望 ${(expected * 100).toFixed(2)}%，實得 ${(actual * 100).toFixed(2)}%`
      );
    }
  });

  test('覆蓋整個舞台（不留空洞）', () => {
    const covered = rects.reduce((s, r) => s + r.w * r.h, 0);
    assert.ok(Math.abs(covered - W * H) / (W * H) < 0.001, '覆蓋率不足');
  });

  test('矩形之間不重疊', () => {
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j];
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        assert.ok(!(ox > 0.5 && oy > 0.5), '方塊重疊');
      }
    }
  });

  test('只有一項時佔滿整個矩形', () => {
    const one = mod.sliceAndDice([{ entry: { name: 'X' }, bytes: 10 }], { x: 0, y: 0, w: 300, h: 200 });
    assert.equal(one.length, 1);
    assert.equal(one[0].w, 300);
    assert.equal(one[0].h, 200);
  });

  test('空輸入不炸', () => {
    assert.deepEqual(mod.sliceAndDice([], { x: 0, y: 0, w: 300, h: 200 }), []);
  });

  test('長寬比不會失控（最大 12:1）', () => {
    const tree = require('./fixtures/canon-tree-sample.json');
    const entries = tree.map(n => ({
      node: n,
      bytes: mod.subtreeBytes(n),
      files: mod.subtreeFiles(n)
    })).filter(e => e.bytes > 0).sort((a, b) => b.bytes - a.bytes);
    const rs = mod.sliceAndDice(entries, { x: 0, y: 0, w: 1000, h: 560 });
    for (const r of rs) {
      const ratio = Math.max(r.w, r.h) / Math.max(1, Math.min(r.w, r.h));
      assert.ok(ratio < 12, `長寬比 ${ratio.toFixed(1)}:1 太扁：${r.entry.node.name}`);
    }
  });
});

describe('藏經地圖：樹的走訪', () => {
  test('subtreeBytes 會加總整個子樹', () => {
    const node = {
      type: 'directory',
      children: [
        { type: 'file', size: 100 },
        { type: 'directory', children: [{ type: 'file', size: 50 }] }
      ]
    };
    assert.equal(mod.subtreeBytes(node), 150);
  });

  test('subtreeFiles 會數整個子樹的檔案', () => {
    const node = {
      type: 'directory',
      children: [
        { type: 'file', size: 1 },
        { type: 'directory', children: [{ type: 'file', size: 1 }, { type: 'file', size: 1 }] }
      ]
    };
    assert.equal(mod.subtreeFiles(node), 3);
  });

  test('空節點不會爆', () => {
    assert.equal(mod.subtreeBytes(null), 0);
    assert.equal(mod.subtreeFiles(null), 0);
  });
});

describe('藏經地圖：與 app.js 的邊界', () => {
  test('開啟檔案走 app.js 既有的 window.mdwOpenFile', () => {
    assert.match(CANON_JS, /typeof global\.mdwOpenFile === 'function'/);
    assert.match(APP_JS, /window\.mdwOpenFile = /);
  });

  test('抓不到介面時退回 hash，不直接操作 DOM', () => {
    assert.match(CANON_JS, /location\.hash = '#file=' \+ encodeURIComponent\(path\)/);
  });

  test('只讀 state.treeData，不改它', () => {
    assert.match(CANON_JS, /st\.treeData/);
    assert.doesNotMatch(CANON_JS, /state\.treeData\s*=/);
  });

  test('沒有 document 的環境不會拋錯', () => {
    assert.match(CANON_JS, /typeof document !== 'undefined'/);
  });
});

describe('藏經地圖：DOM 對得上', () => {
  test('app.js／canon-map.js 查的每個 canonMap* id 都存在於 index.html', () => {
    const ids = [...CANON_JS.matchAll(/\$\('(canonMap[A-Za-z]*)'\)/g)].map(m => m[1]);
    assert.ok(ids.length > 0, '找不到任何 canonMap* 的 $() 查詢');
    for (const id of new Set(ids)) {
      assert.ok(INDEX_HTML.includes(`id="${id}"`), `查了 #${id}，但 index.html 沒有`);
    }
  });

  test('首頁有入口按鈕', () => {
    assert.match(INDEX_HTML, /id="homeMapOpen"/);
    assert.match(CANON_JS, /\$\('homeMapOpen'\)/);
  });

  test('對話框有正確的無障礙屬性', () => {
    const block = INDEX_HTML.match(/<div[^>]*id="canonMapOverlay"[^>]*>/);
    assert.ok(block, '找不到 canonMapOverlay');
    assert.match(block[0], /role="dialog"/);
    assert.match(block[0], /aria-modal="true"/);
    assert.match(block[0], /aria-labelledby="canonMapTitle"/);
  });

  test('腳本在 app.js 之後載入（才能用 mdwOpenFile）', () => {
    const appIdx = INDEX_HTML.indexOf('app.js?v=');
    const canonIdx = INDEX_HTML.indexOf('canon-map.js?v=');
    assert.ok(appIdx > 0 && canonIdx > 0);
    assert.ok(canonIdx > appIdx, 'canon-map.js 必須排在 app.js 之後');
  });

  test('Service Worker 有快取這個模組', () => {
    assert.match(SW_JS, /'\/canon-map\.js'/);
  });
});

describe('藏經地圖：視覺與可及性', () => {
  test('方塊用絕對定位（不用 flex 換行，避免留下空洞）', () => {
    const block = STYLE_CSS.match(/\.canon-map-cell\s*\{[\s\S]*?\}/);
    assert.ok(block);
    assert.match(block[0], /position:\s*absolute/);
  });

  test('字數常駐顯示（地圖的價值，不藏到 hover）', () => {
    const block = STYLE_CSS.match(/\.canon-map-size\s*\{[\s\S]*?\}/);
    assert.ok(block);
    assert.doesNotMatch(block[0], /opacity:\s*0;/);
  });

  test('尊重減少動態偏好', () => {
    assert.match(STYLE_CSS, /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?canon-map-cell/);
  });

  test('手機上有調整', () => {
    assert.match(STYLE_CSS, /@media \(max-width: 768px\)\s*\{[\s\S]*?canon-map-card/);
  });

  test('列印時不輸出地圖（對話框不該印出來）', () => {
    assert.match(STYLE_CSS, /@media print\s*\{[\s\S]*?canon-map/);
  });

  test('Esc 可以關閉', () => {
    assert.match(CANON_JS, /e\.key === 'Escape' && isOpen/);
  });

  test('點背景可以關閉', () => {
    assert.match(CANON_JS, /e\.target === overlay/);
  });
});
