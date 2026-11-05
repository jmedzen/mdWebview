/**
 * @file tests/test-sidecar.test.js
 *
 * 逐句註疏（alpha 批次 9）。
 *
 * 古代註疏講經的格式是先引一句、再解那句。把引文對回底本，就得到
 * 「這一段經文，這位註疏家這樣讀」——而且可以同時擺好幾位。
 *
 * 這支測試守四件事：
 *   1. 座標是對的（p 與 q 必須說同一件事）
 *   2. 不會退化成「全部撞在第一個出現的位置」
 *   3. 浮標不會污染自己量出來的座標
 *   4. 沒有內文的地方不會留下空殼
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_JS = fs.readFileSync(path.join(ROOT_DIR, 'sidecar-data.js'), 'utf8');
const READER_JS = fs.readFileSync(path.join(ROOT_DIR, 'sidecar-reader.js'), 'utf8');
const GEN_JS = fs.readFileSync(path.join(ROOT_DIR, 'scripts/gen-sidecar.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
const STYLE_CSS = fs.readFileSync(path.join(ROOT_DIR, 'style.css'), 'utf8');
const SW_JS = fs.readFileSync(path.join(ROOT_DIR, 'sw.js'), 'utf8');
const MD_ROOT = path.join(ROOT_DIR, 'md');

function loadData() {
  const g = {};
  new Function('window', DATA_JS.replace(
    '})(typeof window !== \'undefined\' ? window : this);', '})(window);'))(g);
  return g.SidecarData;
}

const DATA = loadData();
const WORKS = DATA.works;

/** 產生器用的清洗規則（測試要跟它一致才驗得準）。 */
function cleanCbeta(raw) {
  return raw.split('\n')
    .filter(l => l.trim() && !l.startsWith('//'))
    .filter(l => !/^No\.\s*\d/.test(l.trim()))
    .join('\n');
}
function normalize(s) {
  return s.replace(/[\s\u3000]+/g, '');
}

describe('逐句註疏：資料完整性', () => {
  test('至少 10 部經有逐句對位', () => {
    assert.ok(WORKS.length >= 10, `只有 ${WORKS.length} 部`);
  });

  test('每一部都有至少一處，而且都指向真實檔案', () => {
    for (const w of WORKS) {
      assert.ok(w.loci.length > 0, `${w.base} 沒有任何一處`);
      assert.ok(fs.existsSync(path.join(MD_ROOT, w.path)), `${w.base} 的路徑不存在`);
    }
  });

  test('經號格式正確、不得重複', () => {
    const seen = new Set();
    for (const w of WORKS) {
      assert.match(w.base, /^T\d{4}$/);
      assert.ok(!seen.has(w.base), `${w.base} 重複出現`);
      seen.add(w.base);
    }
  });

  test('每一處都有註解，而且註解有作者與內文', () => {
    for (const w of WORKS) {
      for (const l of w.loci) {
        assert.ok(l.notes.length > 0, `${w.base} 有一處沒有註解`);
        for (const n of l.notes) {
          assert.ok(n.by, `${w.base} 有一則沒有作者`);
          assert.ok(n.t && n.t.length >= 6, `${w.base} 有一則內文過短`);
        }
      }
    }
  });

  test('座標遞增（註疏是順著經文講的）', () => {
    for (const w of WORKS) {
      for (let i = 1; i < w.loci.length; i++) {
        assert.ok(w.loci[i].p >= w.loci[i - 1].p,
          `${w.base} 第 ${i} 處的位置倒退`);
      }
    }
  });
});

describe('逐句註疏：座標對得上原文', () => {
  test('抽樣：q 必須真的出現在 p 附近', () => {
    // 這是最關鍵的一條。實際壞過三次：
    //   p=19（如是）配 q=一時（其實在 24）——錨點與引文來自不同筆
    let checked = 0;
    for (const w of WORKS.slice(0, 8)) {
      const raw = fs.readFileSync(path.join(MD_ROOT, w.path), 'utf8');
      const doc = normalize(cleanCbeta(raw));
      for (const l of w.loci.slice(0, 25)) {
        if (!l.q) continue;
        const win = doc.slice(Math.max(0, l.p - 2), l.p + l.q.length + 2);
        assert.ok(win.includes(l.q),
          `${w.base} p=${l.p} 找不到 q="${l.q}"（附近是「${doc.slice(l.p, l.p + 10)}」）`);
        checked++;
      }
    }
    assert.ok(checked >= 40, `只驗了 ${checked} 筆，樣本太少`);
  });

  test('短引文不得全部撞在同一個位置', () => {
    // 「如是」「須菩提」各出現 7 次。若允許自由搜尋，全部會落在第一個。
    const diamond = WORKS.find(w => w.base === 'T0235');
    assert.ok(diamond);
    const positions = new Set(diamond.loci.map(l => l.p));
    assert.ok(positions.size >= diamond.loci.length * 0.9,
      '位置重複太多，短引文可能全部撞在一起了');
  });

  test('金剛經第一處是正文，不是經題註釋', () => {
    // 註疏開篇會解釋經名（「『金剛般若』此乃摧萬有於性空…」）。那對不到
    // 任何一段經文，留著只會讓第一條看起來像對錯了。
    const diamond = WORKS.find(w => w.base === 'T0235');
    const first = diamond.loci[0];
    assert.ok(first.p > 0, '第一處落在檔案最開頭，可能是經題註釋');
    assert.notEqual(first.q, '金剛般若');
  });

  test('產生器有留下「順著講」的理由', () => {
    assert.match(GEN_JS, /順著講|游標/);
  });

  test('產生器有留下短引文只就近找的理由', () => {
    assert.match(GEN_JS, /SHORT_QUOTE/);
    assert.match(GEN_JS, /各出現 7 次|撞在第一個/);
  });
});

describe('逐句註疏：浮標不得污染座標', () => {
  test('取座標時排除自己的浮標', () => {
    // 浮標裡有數字（「3」）。若直接讀 textContent，那些數字會被算進
    // 經文，越後面對位越歪。
    assert.match(READER_JS, /closest\('\.sidecar-marker'\)/);
    assert.match(READER_JS, /FILTER_REJECT/);
  });

  test('捲動定位也用同一套排除規則', () => {
    assert.match(READER_JS, /function eachTextNode/);
    const body = READER_JS.slice(READER_JS.indexOf('function scrollToPosition'));
    assert.match(body.slice(0, 900), /eachTextNode/);
  });

  test('有引文時優先用引文當語境', () => {
    // 有些註解註的是經題，p 落在檔案開頭，切出來的語境會是經題。
    // 用引文本身當語境永遠不會錯。
    assert.match(READER_JS, /locus\.q \|\|/);
  });

  test('座標不符時用引文重找，不是盲目相信 p', () => {
    assert.match(READER_JS, /function resolvePosition/);
    assert.match(READER_JS, /doc\.indexOf\(q\)/);
  });
});

describe('逐句註疏：與 app.js 的邊界', () => {
  test('只讀 state.currentFile，不改它', () => {
    assert.match(READER_JS, /state\?\.currentFile/);
    assert.doesNotMatch(READER_JS, /state\.currentFile\s*=/);
  });

  test('不塞 innerHTML', () => {
    assert.doesNotMatch(READER_JS, /\.innerHTML\s*=/);
  });

  test('沒有 document 的環境不會拋錯', () => {
    assert.match(READER_JS, /typeof document !== 'undefined'/);
  });

  test('不改版面寬度或書寫方向', () => {
    // 批次 5 的直書已經被永久否決，這裡不能再碰
    assert.doesNotMatch(READER_JS, /writing-mode|vertical-rl/);
    assert.doesNotMatch(STYLE_CSS.match(/§53[\s\S]*?(?=§|$)/)?.[0] || '',
      /writing-mode|vertical-rl/);
  });
});

describe('逐句註疏：入口與 DOM', () => {
  test('經文裡的浮標是入口之一', () => {
    assert.match(READER_JS, /sidecar-marker/);
    assert.match(READER_JS, /placeMarkers/);
  });

  test('工具列有直接入口（浮標只出現在有註的段落）', () => {
    assert.match(INDEX_HTML, /id="sidecarOpenBtn"/);
    assert.match(READER_JS, /sidecarOpenBtn/);
  });

  test('模組查的每個 sidecar* id 都存在於 index.html', () => {
    const ids = [...READER_JS.matchAll(/\$\('(sidecar[A-Za-z]*)'\)/g)].map(m => m[1]);
    assert.ok(ids.length > 0);
    for (const id of new Set(ids)) {
      assert.ok(INDEX_HTML.includes(`id="${id}"`), `查了 #${id}，但 index.html 沒有`);
    }
  });

  test('對話框有無障礙屬性', () => {
    const block = INDEX_HTML.match(/<div[^>]*id="sidecarOverlay"[^>]*>/);
    assert.ok(block);
    assert.match(block[0], /role="dialog"/);
    assert.match(block[0], /aria-modal="true"/);
  });

  test('腳本順序：資料在邏輯之前、都在 app.js 之後', () => {
    const appIdx = INDEX_HTML.indexOf('app.js?v=');
    const dataIdx = INDEX_HTML.indexOf('sidecar-data.js?v=');
    const readerIdx = INDEX_HTML.indexOf('sidecar-reader.js?v=');
    assert.ok(appIdx > 0 && dataIdx > appIdx && readerIdx > dataIdx,
      '腳本順序不對');
  });

  test('Service Worker 兩個都快取', () => {
    assert.match(SW_JS, /'\/sidecar-data\.js'/);
    assert.match(SW_JS, /'\/sidecar-reader\.js'/);
  });

  test('沒有註解的地方不留空殼', () => {
    assert.match(READER_JS, /if \(!work \|\| !work\.loci\.length\) return;/);
  });
});

describe('逐句註疏：版面', () => {
  test('浮標用絕對定位（不能壓在標點上）', () => {
    // inline + vertical-align:super 會隨最後一行浮動，實測壓在「坐。」上
    const block = STYLE_CSS.match(/\.sidecar-marker\s*\{[\s\S]*?\n\}/);
    assert.ok(block);
    assert.match(block[0], /position:\s*absolute/);
  });

  test('浮標預設半透明，hover 才全亮（讀經優先）', () => {
    const m = STYLE_CSS.match(/\.sidecar-marker\s*\{[\s\S]*?\n\}/);
    assert.ok(m, '找不到 .sidecar-marker 規則');
    assert.match(m[0], /opacity:\s*0\./);
    assert.match(STYLE_CSS, /\.sidecar-marker:hover[\s\S]*?opacity:\s*1/);
  });

  test('手機上左欄改成橫向條', () => {
    assert.match(STYLE_CSS, /@media \(max-width: 760px\)\s*\{[\s\S]*?\.sidecar-loci[\s\S]*?overflow-x:\s*auto/);
  });

  test('列印時浮標與面板都不輸出', () => {
    assert.match(STYLE_CSS, /@media print\s*\{[\s\S]*?\.sidecar-marker/);
  });

  test('左欄顯示引文而不是作者名', () => {
    // 顯示作者名會連續出現五六次「胡吉藏」，讀者分不出是哪一條
    assert.match(READER_JS, /label\.textContent = l\.q \|\|/);
  });
});
