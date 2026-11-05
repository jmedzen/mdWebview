/**
 * @file tests/test-margin-notes.test.js
 *
 * 經註並讀（alpha 批次 10）。
 *
 * 前面四個批次做的都是彈窗：藏經地圖、同經異譯、註疏譜系、逐句註疏。
 * 每一個都要離開經文。這個批次把註疏搬到經文旁邊，常駐、跟著捲動。
 *
 * 這支測試守的是「它真的會在對的時間出現在對的位置」，因為這個功能
 * 壞掉的方式不是拋錯，而是靜靜地什麼都不顯示。
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const JS = fs.readFileSync(path.join(ROOT_DIR, 'margin-notes.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT_DIR, 'style.css'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
const SW = fs.readFileSync(path.join(ROOT_DIR, 'sw.js'), 'utf8');
const DATA_JS = fs.readFileSync(path.join(ROOT_DIR, 'sidecar-data.js'), 'utf8');

function loadData() {
  const g = {};
  new Function('window', DATA_JS.replace(
    '})(typeof window !== \'undefined\' ? window : this);', '})(window);'))(g);
  return g.SidecarData;
}
const DATA = loadData();

/** 取出 style.css 裡 §54 之後的內容。 */
function section54() {
  const i = CSS.indexOf('§54');
  assert.ok(i > 0, '找不到 §54');
  return CSS.slice(i);
}

describe('經註並讀：模組邊界', () => {
  test('有自己的全域，不依賴 app.js 的內部', () => {
    assert.match(JS, /global\.MarginNotes\s*=/);
    assert.match(JS, /\(typeof window !== 'undefined' \? window : this\)/);
  });

  test('沒有 document 也能載入（測試/SSR 環境）', () => {
    assert.match(JS, /typeof document !== 'undefined'/);
    const fn = new Function('window', JS.replace(
      '})(typeof window !== \'undefined\' ? window : this);', '})(window);'));
    const g = {};
    assert.doesNotThrow(() => fn(g));
    assert.equal(typeof g.MarginNotes.isEnabled(), 'boolean');
  });

  test('不寫 innerHTML（避免把註疏當 HTML 解析）', () => {
    assert.doesNotMatch(JS, /\.innerHTML\s*=/);
  });

  test('不改 state.currentFile', () => {
    assert.match(JS, /state\.currentFile/);
    assert.doesNotMatch(JS, /state\.currentFile\s*=/);
  });

  test('不碰書寫方向（直書已永久否決）', () => {
    assert.doesNotMatch(JS, /writing-mode|vertical-rl/);
    assert.doesNotMatch(section54(), /writing-mode|vertical-rl/);
  });

  test('只讀 SidecarData，不重新解析語料', () => {
    assert.match(JS, /global\.SidecarData/);
    assert.doesNotMatch(JS, /fetch\(|XMLHttpRequest/);
  });
});

describe('經註並讀：取座標', () => {
  test('跳過註疏浮標（批次 9 踩過的坑）', () => {
    assert.match(JS, /\.sidecar-marker/);
    assert.match(JS, /FILTER_REJECT/);
  });

  test('座標規則與 sidecar-data 一致（去空白）', () => {
    assert.match(JS, /replace\(\/\[\\s\\u3000\]\+\/g, ''\)/);
  });

  test('段落起點要把整個 body 的文字都算進去', () => {
    // 只累加 <p> 會漏掉標題、清單的文字，整體座標就偏了
    assert.match(JS, /eachTextNode\(body/);
  });
});

describe('經註並讀：資料對得上', () => {
  test('至少 15 部經有足夠的註疏可以開邊欄', () => {
    const usable = DATA.works.filter(w => w.loci.length >= 5);
    assert.ok(usable.length >= 15, `只有 ${usable.length} 部`);
  });

  test('邊欄最常顯示的註文長度適合窄欄', () => {
    // 邊欄寬 292px、字 11.5px，一行約 20 字。中位數必須遠小於 200，
    // 否則邊欄會變成要一直往下捲的字牆。
    const lens = [];
    for (const w of DATA.works) {
      for (const l of w.loci) if (l.notes[0]) lens.push(l.notes[0].t.length);
    }
    lens.sort((a, b) => a - b);
    const median = lens[Math.floor(lens.length / 2)];
    assert.ok(median <= 60, `中位數 ${median} 字，邊欄放不下`);
  });
});

describe('經註並讀：版面', () => {
  test('用 fixed，不是 absolute＋sticky', () => {
    // absolute 會跟著內容捲走（實測 top 變成 -5324px，整個邊欄跑到視窗外）。
    // §54 裡有兩條 .margin-rail：一條是 display:none 的預設，一條是
    // 寬螢幕的定位規則。要驗的是後者。
    const s54 = section54();
    const blocks = [...s54.matchAll(/\.margin-rail\s*\{[\s\S]*?\n  \}/g)].map(m => m[0]);
    assert.ok(blocks.length >= 1, '找不到 .margin-rail 規則');
    const positioned = blocks.find(b => /position:/.test(b));
    assert.ok(positioned, '沒有任何 .margin-rail 設定 position');
    assert.match(positioned, /position:\s*fixed/);
    assert.doesNotMatch(positioned, /position:\s*absolute/);
    assert.doesNotMatch(positioned, /position:\s*sticky/);
  });

  test('窄螢幕不出現（不是降級，是本來就不該有）', () => {
    assert.match(section54(), /@media \(max-width: 1179px\)[\s\S]*?\.margin-rail \{ display: none !important/);
  });

  test('列印不輸出邊註', () => {
    // 不能用 lastIndexOf('@media print')——後面的批次（§55 經文流）
    // 也有自己的 @media print，會抓到錯的那一塊。
    const s54 = section54();
    const idx = s54.indexOf('@media print');
    assert.ok(idx > 0, '§54 裡沒有 @media print');
    assert.match(s54.slice(idx), /\.margin-rail \{ display: none !important/);
  });

  test('經文欄不會被邊欄擠窄', () => {
    // 邊欄是「多出來的」，用 padding 讓開，不是把經文壓縮
    assert.match(section54(), /html\.with-margin-rail \.content \{\s*padding-right/);
    assert.match(section54(), /max-width/);
  });

  test('邊註文字用 secondary 而不是 muted', () => {
    // muted 在深色底會糊成一片（實測整段讀不出來）
    const block = section54().match(/\.margin-note-text\s*\{[\s\S]*?\n\}/);
    assert.ok(block);
    assert.match(block[0], /color:\s*var\(--text-secondary\)/);
    assert.doesNotMatch(block[0], /color:\s*var\(--text-muted\)/);
  });

  test('延續顯示的註解仍讀得到（透明度不能太低）', () => {
    const block = section54().match(/\.margin-note\.is-lingering\s*\{[\s\S]*?\n\}/);
    assert.ok(block);
    const m = block[0].match(/opacity:\s*([\d.]+)/);
    assert.ok(m, '找不到 opacity');
    assert.ok(parseFloat(m[1]) >= 0.6, `透明度 ${m[1]} 太低，會看不見`);
  });

  test('邊欄會避開右側辭典欄', () => {
    assert.match(section54(), /--dict-rail-offset/);
    assert.match(JS, /syncDictOffset/);
    assert.match(JS, /ResizeObserver/);
  });
});

describe('經註並讀：入口與開關', () => {
  test('工具列有開關', () => {
    assert.match(HTML, /id="marginRailToggle"/);
    assert.match(JS, /marginRailToggle/);
  });

  test('開關會記住偏好', () => {
    assert.match(JS, /localStorage\.setItem/);
    assert.match(JS, /localStorage\.getItem/);
  });

  test('預設是開的（批次 8 的教訓：沒入口等於不存在）', () => {
    const m = JS.match(/function readPref\(\)[\s\S]*?\n  \}/);
    assert.ok(m);
    assert.match(m[0], /return true/);
  });

  test('aria-pressed 跟著狀態更新', () => {
    assert.match(JS, /setAttribute\('aria-pressed'/);
  });

  test('Service Worker 有快取', () => {
    assert.match(SW, /'\/margin-notes\.js'/);
  });

  test('腳本在 sidecar-data 之後（資料要先到）', () => {
    const dataIdx = HTML.indexOf('sidecar-data.js?v=');
    const marginIdx = HTML.indexOf('margin-notes.js?v=');
    assert.ok(dataIdx > 0 && marginIdx > dataIdx);
  });
});

describe('經註並讀：靜默失敗的防線', () => {
  test('找不到 DOM 節點時安靜退出，不拋錯', () => {
    assert.match(JS, /if \(!content\) return null/);
    assert.match(JS, /if \(!body\) return false/);
  });

  test('註解太少時不開邊欄（開一個空欄比不開更糟）', () => {
    assert.match(JS, /MIN_LOCI/);
    assert.match(JS, /loci\.length >= MIN_LOCI/);
  });

  test('沒有註解時留一句提示，不是空白', () => {
    assert.match(JS, /margin-note-empty/);
    assert.match(JS, /往下讀/);
  });

  test('捲動用 requestAnimationFrame，不是每個事件都重畫', () => {
    assert.match(JS, /requestAnimationFrame/);
    assert.match(JS, /rafPending/);
  });

  test('標記段落用 class，不插節點（避免污染座標）', () => {
    const fn = JS.match(/function markParagraph\(idx\)[\s\S]*?\n  \}/);
    assert.ok(fn, '找不到 markParagraph');
    assert.match(fn[0], /classList\.add\('has-margin-note'\)/);
    assert.doesNotMatch(fn[0], /createElement|inject|insertBefore/);
  });
});
