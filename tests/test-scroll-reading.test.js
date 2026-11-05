/**
 * @file tests/test-scroll-reading.test.js
 *
 * 首頁經文流（alpha 批次 11）。
 *
 * 前九個批次做的功能全部掛在首頁下方六個小晶片裡，而首頁第一屏是一朵
 * 蓮花、一個搜尋框、三張入門卡——十輪的成果，換來一個啟動器。
 *
 * 佛典閱讀器的首頁不讀經，是本末倒置。
 *
 * 這支測試守兩件事：
 *   1. 資料本身讀得下去（不是抽句、不是咒語、不是殘缺字）
 *   2. 首頁真的會出現它（沒入口的功能等於不存在）
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_JS = fs.readFileSync(path.join(ROOT_DIR, 'passages-data.js'), 'utf8');
const JS = fs.readFileSync(path.join(ROOT_DIR, 'scroll-reading.js'), 'utf8');
const GEN = fs.readFileSync(path.join(ROOT_DIR, 'scripts/gen-passages.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT_DIR, 'style.css'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
const SW = fs.readFileSync(path.join(ROOT_DIR, 'sw.js'), 'utf8');
const MD_ROOT = path.join(ROOT_DIR, 'md');

function loadData() {
  const g = {};
  new Function('window', DATA_JS.replace(
    '})(typeof window !== \'undefined\' ? window : this);', '})(window);'))(g);
  return g.PassagesData;
}
const DATA = loadData();
const LIST = DATA.list;

function hanzi(s) { return (s.match(/[\u4e00-\u9fff]/g) || []).length; }
function section55() {
  const i = CSS.indexOf('§55');
  assert.ok(i > 0, '找不到 §55');
  return CSS.slice(i);
}

describe('經文流：資料完整性', () => {
  test('有足夠的段落可以連續讀', () => {
    assert.ok(LIST.length >= 300, `只有 ${LIST.length} 段`);
  });

  test('每段都有路徑、行號、經號、經名、內文', () => {
    for (const s of LIST) {
      assert.ok(s.p && typeof s.p === 'string', '缺路徑');
      assert.ok(Number.isInteger(s.l) && s.l > 0, `行號不對: ${s.l}`);
      assert.match(s.id, /^T\d{4}$/);
      assert.ok(s.t && s.t.length > 0, '缺經名');
      assert.ok(s.x && s.x.length > 0, '缺內文');
    }
  });

  test('路徑指向真實檔案，且不含 md/ 前綴', () => {
    // 前端 openFile() 用的是檔案樹慣例（不含 md/）
    for (const s of LIST.slice(0, 40)) {
      assert.ok(!s.p.startsWith('md/'), `路徑帶了 md/ 前綴: ${s.p}`);
      assert.ok(fs.existsSync(path.join(MD_ROOT, s.p)), `檔案不存在: ${s.p}`);
    }
  });

  test('行號對得上真實內容', () => {
    // 這是最關鍵的一條：點「看這一段」要跳到正確那一行
    let checked = 0;
    for (const s of LIST.slice(0, 80)) {
      const lines = fs.readFileSync(path.join(MD_ROOT, s.p), 'utf8').split('\n');
      assert.equal((lines[s.l - 1] || '').trim(), s.x,
        `${s.id} 第 ${s.l} 行對不上`);
      checked++;
    }
    assert.ok(checked >= 60, `只驗了 ${checked} 筆`);
  });

  test('涵蓋多部經，不是同一部重複', () => {
    const files = new Set(LIST.map(s => s.p));
    assert.ok(files.size >= 300, `只有 ${files.size} 個檔案`);
  });

  test('相鄰不重複同一部經', () => {
    for (let i = 1; i < LIST.length; i++) {
      assert.notEqual(LIST[i].p, LIST[i - 1].p,
        `第 ${i} 段與前一段同檔`);
    }
  });
});

describe('經文流：讀得下去', () => {
  test('不是抽句——每段都有足夠長度自成一格', () => {
    for (const s of LIST) {
      const n = hanzi(s.x);
      assert.ok(n >= 34, `${s.id} 只有 ${n} 字，像半句`);
      assert.ok(n <= 150, `${s.id} 有 ${n} 字，在手機上是一堵牆`);
    }
  });

  test('沒有殘缺字（CBETA 有些經本大量缺字）', () => {
    // T0388《大雲無想經》整段是「盲今已□□□□□□…」，擺在首頁會像壞掉
    for (const s of LIST) {
      const missing = (s.x.match(/[□◻◼▢]/g) || []).length;
      assert.ok(missing < 3, `${s.id} 有 ${missing} 個缺字`);
    }
  });

  test('沒有製式開場洗版', () => {
    // 「一時，佛在…」在語料裡佔四成。第一版連續 43 段都是它。
    const formula = /^(一時|爾時|佛告|如是我聞|其時|於時)/;
    const count = LIST.filter(s => formula.test(s.x)).length;
    assert.ok(count / LIST.length < 0.12,
      `製式開場佔 ${(count / LIST.length * 100).toFixed(1)}%，讀起來會很單調`);
  });

  test('不會連續三段都是製式開場', () => {
    const formula = /^(一時|爾時|佛告|如是我聞|其時|於時)/;
    let run = 0;
    for (const s of LIST) {
      run = formula.test(s.x) ? run + 1 : 0;
      assert.ok(run <= 2, '連續三段開場');
    }
  });

  test('不含註疏（首頁要給的是經文，不是解釋）', () => {
    const COMMENTARY = /(疏|註|注|述記|贊述|略釋|義記|玄義|科文|鈔|講義|會解|纂要|直解|句解|論$|釋$)/;
    for (const s of LIST) {
      assert.ok(!COMMENTARY.test(s.t), `${s.id}《${s.t}》是註疏`);
    }
  });

  test('部類分佈以核心經典為主', () => {
    // 第一版等距抽樣 → 密教部 27.6%、經集部 25.7%，第一屏連續五段陀羅尼
    const byCanon = {};
    for (const s of LIST) {
      const c = s.p.split('/')[1] || '';
      byCanon[c] = (byCanon[c] || 0) + 1;
    }
    const tantra = (byCanon['10密教部類'] || 0) / LIST.length;
    assert.ok(tantra < 0.10, `密教部佔 ${(tantra * 100).toFixed(1)}%，第一屏會是咒語`);
    assert.ok((byCanon['03般若部類'] || 0) >= 20, '般若部太少');
    assert.ok((byCanon['01阿含部類'] || 0) >= 20, '阿含部太少');
  });

  test('產生器留下配額的理由', () => {
    assert.match(GEN, /QUOTA/);
    assert.match(GEN, /陀羅尼|咒語/);
  });

  test('產生器留下開場限流的理由', () => {
    assert.match(GEN, /OPENING_FORMULA/);
    assert.match(GEN, /43 段|連續/);
  });
});

describe('經文流：介面', () => {
  test('有自己的全域，無 document 也能載入', () => {
    assert.match(JS, /global\.ScrollReading\s*=/);
    const fn = new Function('window', JS.replace(
      '})(typeof window !== \'undefined\' ? window : this);', '})(window);'));
    assert.doesNotThrow(() => fn({}));
  });

  test('不塞 innerHTML', () => {
    assert.doesNotMatch(JS, /\.innerHTML\s*=/);
  });

  test('走 public 介面 mdwOpenFile，不呼叫 app.js 內部', () => {
    assert.match(JS, /global\.mdwOpenFile/);
    assert.doesNotMatch(JS, /state\.currentFile\s*=/);
  });

  test('「看這一段」帶行號（有上下文），不是只給檔案', () => {
    assert.match(JS, /openFile\(item\.p, item\.l\)/);
  });

  test('DOM 會回收，捲很久不會累積上萬節點', () => {
    assert.match(JS, /MAX_DOM/);
    assert.match(JS, /rendered\.shift\(\)/);
  });

  test('無限捲動用 IntersectionObserver', () => {
    assert.match(JS, /IntersectionObserver/);
  });

  test('關掉會記住', () => {
    assert.match(JS, /localStorage\.setItem/);
    assert.match(JS, /mdw\.scrollReading/);
  });

  test('預設是開的（批次 8 的教訓）', () => {
    const fn = JS.match(/function readPref\(\)[\s\S]*?\n  \}/);
    assert.ok(fn);
    assert.match(fn[0], /return true/);
  });

  test('沒有資料時安靜退出', () => {
    assert.match(JS, /if \(!data \|\| !data\.list/);
  });
});

describe('經文流：版面', () => {
  test('經文是首頁最大的字（不是又一塊小方塊）', () => {
    const block = section55().match(/\.scroll-reading-text\s*\{[\s\S]*?\n\}/);
    assert.ok(block);
    const m = block[0].match(/font-size:\s*calc\(([\d.]+)px/);
    assert.ok(m, '找不到 font-size');
    assert.ok(parseFloat(m[1]) >= 14, `經文只有 ${m[1]}px，不是主角`);
  });

  test('手機上經文改左對齊（兩端對齊會出現字距空隙）', () => {
    const mobile = section55().match(/@media \(max-width: 760px\)[\s\S]*?\n\}/);
    assert.ok(mobile);
    assert.match(mobile[0], /text-align:\s*left/);
  });

  test('列印首頁不輸出經文流', () => {
    const print = CSS.slice(CSS.lastIndexOf('@media print'));
    assert.match(print, /\.scroll-reading \{ display: none !important/);
  });

  test('Service Worker 兩個都快取', () => {
    assert.match(SW, /'\/passages-data\.js'/);
    assert.match(SW, /'\/scroll-reading\.js'/);
  });

  test('腳本順序：資料在邏輯之前', () => {
    const d = HTML.indexOf('passages-data.js?v=');
    const s = HTML.indexOf('scroll-reading.js?v=');
    assert.ok(d > 0 && s > d, '腳本順序不對');
  });
});

describe('經文流：API', () => {
  test('at() 會繞回開頭，捲到底不會停', () => {
    assert.equal(DATA.at(LIST.length).p, LIST[0].p);
    assert.equal(DATA.at(-1).p, LIST[LIST.length - 1].p);
  });

  test('after() 取 n 段', () => {
    const got = DATA.after(0, 3);
    assert.equal(got.length, 3);
    assert.equal(got[0].p, LIST[1].p);
  });

  test('空資料不炸', () => {
    // 用一個空的 window 重新載入模組，真的走一遍「沒有資料」的路徑
    const g = {};
    new Function('window', DATA_JS.replace(
      '})(typeof window !== \'undefined\' ? window : this);', '})(window);'))(g);
    g.PassagesData.list = [];
    assert.deepEqual(g.PassagesData.after(0, 3), []);
    assert.equal(g.PassagesData.at(0), null);
  });
});
