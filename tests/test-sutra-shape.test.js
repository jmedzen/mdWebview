/**
 * @file tests/test-sutra-shape.test.js
 *
 * 「這部經的形狀」（alpha 批次 12）。
 *
 * 語料裡 2,231 個檔案超過三萬字，《大般若經》單檔 467 萬字、1,894 個
 * 標題。左邊的大綱是一個 1,894 項的清單——它告訴你「有哪些標題」，
 * 不告訴你「這部經長什麼樣子、我現在在哪」。
 *
 * 這支測試守的是「地圖不會畫錯、不會消失、不會點不到」。
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const JS = fs.readFileSync(path.join(ROOT_DIR, 'sutra-shape.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT_DIR, 'style.css'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
const SW = fs.readFileSync(path.join(ROOT_DIR, 'sw.js'), 'utf8');
const MD_ROOT = path.join(ROOT_DIR, 'md');

function section56() {
  const i = CSS.indexOf('§56');
  assert.ok(i > 0, '找不到 §56');
  return CSS.slice(i);
}

describe('經文地圖：模組邊界', () => {
  test('有自己的全域，無 document 也能載入', () => {
    assert.match(JS, /global\.SutraShape\s*=/);
    const fn = new Function('window', JS.replace(
      '})(typeof window !== \'undefined\' ? window : this);', '})(window);'));
    assert.doesNotThrow(() => fn({}));
  });

  test('不寫 innerHTML', () => {
    assert.doesNotMatch(JS, /\.innerHTML\s*=/);
  });

  test('不改 state.currentFile', () => {
    assert.match(JS, /state\.currentFile/);
    assert.doesNotMatch(JS, /state\.currentFile\s*=/);
  });

  test('不碰書寫方向（直書已永久否決）', () => {
    assert.doesNotMatch(JS, /writing-mode|vertical-rl/);
    assert.doesNotMatch(section56(), /writing-mode|vertical-rl/);
  });

  test('不重讀檔案，只用已渲染的 DOM', () => {
    // app.js 用 Worker 分塊渲染，我們拿不到原始 markdown；
    // 用 DOM 也保證「畫出來的塊一定點得到」
    assert.doesNotMatch(JS, /fetch\(|XMLHttpRequest|readFile/);
    assert.match(JS, /querySelectorAll/);
  });
});

describe('經文地圖：座標正確（踩過的坑）', () => {
  test('不用 offsetTop 算位置', () => {
    // offsetTop 是相對最近的 positioned 祖先。實測點法華經第 10 品
    // 會跳到錯的位置，因為那幾個標題的 offsetParent 不是 body。
    //
    // 注意：程式碼的註解裡提到 offsetTop（說明為何不用），要先去掉
    // 註解才驗得準。
    const build = JS.slice(JS.indexOf('function buildMarks'));
    const fnBody = build.slice(0, build.indexOf('out.kind'));
    const code = fnBody
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /\.offsetTop/);
    assert.match(code, /getBoundingClientRect/);
  });

  test('jumpTo 用相对座標，不直接丟 offsetTop 給 scrollTo', () => {
    const fn = JS.match(/function jumpTo\(mk\)[\s\S]*?\n  \}/);
    assert.ok(fn);
    assert.doesNotMatch(fn[0], /\.offsetTop/);
    assert.match(fn[0], /scrollHeight|ratio/);
  });

  test('比例算得出來（不是全部 0 或 1）', () => {
    assert.match(JS, /ratio:/);
    assert.match(JS, /top \/ total/);
  });
});

describe('經文地圖：不會消失', () => {
  test('沒有 h2 時退而找像標題的段落', () => {
    // 兩個真實情況：
    //   1. 檔案本身沒有 ## 標題（占 53.5%）
    //   2. 渲染器把標題當一般段落輸出
    // 第二種若直接放棄，最需要地圖的大部頭就永遠沒有地圖。
    assert.match(JS, /退路/);
    assert.match(JS, /paras = body\.querySelectorAll\('p'\)/);
  });

  test('標題太少就不畫（一兩卷的經，列表就夠）', () => {
    assert.match(JS, /MIN_MARKS/);
  });

  test('太多就抽稀，而且是等距不是取前面', () => {
    // 取前面會讓地圖只反映開頭，後面全空白——比不畫更誤導
    assert.match(JS, /MARK_LIMIT/);
    assert.match(JS, /step = Math\.ceil/);
    assert.match(JS, /i \+= step/);
  });

  test('極短的塊有最小寬度，否則點不到', () => {
    // 規則裡有 /* */ 註解，先剝掉再驗
    const s56 = section56();
    const start = s56.indexOf('.sutra-shape-seg {');
    assert.ok(start > 0, '找不到 .sutra-shape-seg');
    const block = s56.slice(start, s56.indexOf('\n}', start));
    const code = block.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(code, /min-width:\s*\d+px/);
  });

  test('沒有內容時安靜隱藏', () => {
    assert.match(JS, /if \(!file \|\| !body \|\| !body\.children\.length\)/);
  });
});

describe('經文地圖：標題清理', () => {
  test('切掉黏在卷名後面的譯者行', () => {
    // 實際髒資料：「大般若波羅蜜多經卷第二三藏法師玄奘奉　詔譯」
    // 整串會變成看不懂的長條
    assert.match(JS, /function simplify/);
    assert.match(JS, /卷\[第\]\?/);
  });

  test('太長的標題會截斷', () => {
    assert.match(JS, /slice\(0, 20\)/);
  });
});

describe('經文地圖：尺度看得懂', () => {
  test('有說明列（品數與字數）', () => {
    // 沒有這一行，地圖只是抽象的灰條
    assert.match(JS, /sutraShapeCaption/);
    assert.match(JS, /renderCaption/);
  });

  test('字數只算漢字', () => {
    // 用「去空白總字元」會把標點、梵文算進去：大般若經實際 467 萬漢字，
    // 去空白算是 556 萬——多出來的 89 萬全是雜訊
    const fn = JS.match(/function renderCaption[\s\S]*?\n  \}/);
    assert.ok(fn);
    assert.match(fn[0], /u4e00-\\u9fff/);
  });

  test('抽稀時說明「圖上每 N 個畫一格」', () => {
    assert.match(JS, /圖上每/);
  });
});

describe('經文地圖：版面', () => {
  test('比經文欄寬（地圖是整體比例，越寬越準）', () => {
    // §56 裡有兩條 .sutra-shape：第一條是基礎樣式，第二條（在補述區）
    // 才加負 margin 撐寬。要驗的是後者。
    const s56 = section56();
    const blocks = [];
    let idx = 0;
    while ((idx = s56.indexOf('.sutra-shape {', idx)) >= 0) {
      blocks.push(s56.slice(idx, s56.indexOf('\n}', idx)));
      idx += 10;
    }
    assert.ok(blocks.length >= 2, `只找到 ${blocks.length} 條 .sutra-shape`);
    const wide = blocks.find(b => /margin-left:\s*-\d+px/.test(b));
    assert.ok(wide, '沒有任何一條撐寬');
  });

  test('「你在這裡」在軌道內，不在說明列上', () => {
    // bar 加了 caption 之後，here 相對 bar 定位會跑到文字上
    assert.match(JS, /sutraShapeTrack/);
    const css = section56().match(/\.sutra-shape-track\s*\{[\s\S]*?\n\}/);
    assert.ok(css);
    assert.match(css[0], /position:\s*relative/);
  });

  test('手機上更薄', () => {
    const mobile = section56().match(/@media \(max-width: 760px\)[\s\S]*?\n\}/);
    assert.ok(mobile);
    assert.match(mobile[0], /height:\s*16px|height:\s*20px/);
  });

  test('列印不輸出導覽', () => {
    const s56 = section56();
    const idx = s56.indexOf('@media print');
    assert.ok(idx > 0, '§56 裡沒有 @media print');
    assert.match(s56.slice(idx), /\.sutra-shape \{ display: none !important/);
  });

  test('目前那一塊比其他的亮', () => {
    assert.match(section56(), /\.sutra-shape-seg\.is-current/);
    const cur = section56().match(/\.sutra-shape-seg\.is-current\s*\{[\s\S]*?\n\}/);
    assert.ok(cur);
    assert.match(cur[0], /var\(--accent\)/);
  });
});

describe('經文地圖：接線', () => {
  test('Service Worker 有快取', () => {
    assert.match(SW, /'\/sutra-shape\.js'/);
  });

  test('腳本有載入', () => {
    assert.match(HTML, /sutra-shape\.js\?v=/);
  });

  test('捲動用 requestAnimationFrame', () => {
    assert.match(JS, /requestAnimationFrame/);
    assert.match(JS, /rafPending/);
  });
});

describe('經文地圖：語料前提仍然成立', () => {
  test('語料裡真的有大部頭（地圖才有意義）', () => {
    const big = path.join(MD_ROOT, '01-大正藏/03般若部類/T0220《大般若波羅蜜多經》.md');
    assert.ok(fs.existsSync(big));
    const text = fs.readFileSync(big, 'utf8');
    const h2 = (text.match(/^##\s+\S/gm) || []).length;
    assert.ok(h2 > 500, `大般若經只有 ${h2} 個標題，地圖失去意義`);
  });

  test('語料裡有帶品名的經（地圖用得到）', () => {
    const lotus = path.join(MD_ROOT, '01-大正藏/04法華部類/T0262《妙法蓮華經》.md');
    assert.ok(fs.existsSync(lotus));
    const text = fs.readFileSync(lotus, 'utf8');
    const pins = (text.match(/^##\s+\S*品/gm) || []).length;
    assert.ok(pins >= 20, `法華經只有 ${pins} 品`);
  });
});
