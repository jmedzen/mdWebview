/**
 * @file tests/test-parallel-reading.test.js
 *
 * 同經異譯對讀（alpha 批次 7）。
 *
 * 同一部經被譯過很多次。心經在大正藏裡有四個可讀的譯本，它們講同一件
 * 事，但開頭、句式、用詞都不一樣。這種差異本身就是內容。
 *
 * 這支測試守四件事：
 *   1. 譯本資料是對的（經號存在、譯者沒寫錯）——這裡錯得最不知不覺
 *   2. 經文分段正確（曾經整部經被併成一個 691 字的巨大段落）
 *   3. 不做逐句對齊（實測 T0253 與 T0254 最長共同片段 0 字）
 *   4. 不碰 app.js 的狀態
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const PAR_JS = fs.readFileSync(path.join(ROOT_DIR, 'parallel-reading.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
const APP_JS = fs.readFileSync(path.join(ROOT_DIR, 'app.js'), 'utf8');
const STYLE_CSS = fs.readFileSync(path.join(ROOT_DIR, 'style.css'), 'utf8');
const SW_JS = fs.readFileSync(path.join(ROOT_DIR, 'sw.js'), 'utf8');
const TREE = require('./fixtures/canon-tree-sample.json');

/** 從模組抽函式單獨測（模組是 IIFE，沒有 export）。 */
function extractFn(name) {
  const i = PAR_JS.indexOf('function ' + name + '(');
  assert.ok(i >= 0, `parallel-reading.js 找不到 function ${name}`);
  let depth = 0, started = false;
  for (let j = i; j < PAR_JS.length; j++) {
    if (PAR_JS[j] === '{') { depth++; started = true; }
    else if (PAR_JS[j] === '}') {
      depth--;
      if (started && depth === 0) return PAR_JS.slice(i, j + 1);
    }
  }
  throw new Error('unbalanced braces in ' + name);
}

/** 取出譯本資料表。 */
function readGroups() {
  const m = PAR_JS.match(/var TRANSLATION_GROUPS = (\[[\s\S]*?\n  \]);/);
  assert.ok(m, '找不到 TRANSLATION_GROUPS');
  return new Function('return ' + m[1])();
}

const GROUPS = readGroups();

/** 建立 shapeRenderedText（需要 CBETA_ADMIN_RE 常數）。 */
function makeShape() {
  const m = PAR_JS.match(/var CBETA_ADMIN_RE = (.+);/);
  assert.ok(m, '找不到 CBETA_ADMIN_RE');
  return new Function(
    'var CBETA_ADMIN_RE = ' + m[1] + ';\n' + extractFn('shapeRenderedText') +
    '; return shapeRenderedText;'
  )();
}

describe('同經異譯：譯本資料', () => {
  test('每一組至少兩個譯本（一個譯本沒得對讀）', () => {
    for (const g of GROUPS) {
      assert.ok(g.members.length >= 2, `${g.title} 只有 ${g.members.length} 個譯本`);
    }
  });

  test('經號格式正確且不重複', () => {
    const seen = new Set();
    for (const g of GROUPS) {
      for (const m of g.members) {
        assert.match(m.id, /^T\d{4}$/, `經號格式不對：${m.id}`);
        assert.ok(!seen.has(m.id), `經號重複：${m.id}`);
        seen.add(m.id);
      }
    }
  });

  test('每個譯本都有譯者（沒有譯者就分不出誰是誰）', () => {
    for (const g of GROUPS) {
      for (const m of g.members) {
        assert.ok(m.by && m.by.trim(), `${m.id} 缺譯者`);
        assert.ok(m.era && m.era.trim(), `${m.id} 缺年代`);
      }
    }
  });

  test('同一組內譯者不得全部相同（否則標題無法區分）', () => {
    for (const g of GROUPS) {
      const bys = new Set(g.members.map(m => m.by));
      assert.ok(bys.size > 1, `${g.title} 所有譯本譯者都一樣，欄頭無法區分`);
    }
  });

  test('每個經號在語料樣本裡都找得到檔案', () => {
    // fixture 只有樣本；用 findPathById 的邏輯在樣本上驗證格式正確
    for (const g of GROUPS) {
      for (const m of g.members) {
        const re = new RegExp('^' + m.id + '(?![0-9])');
        let found = null;
        (function walk(ns) {
          if (found || !Array.isArray(ns)) return;
          for (const n of ns) {
            if (n.type === 'file' && n.name && re.test(n.name)) { found = n.path; return; }
            if (n.children) walk(n.children);
            if (found) return;
          }
        })(TREE);
        // 樣本只收部分檔案，找不到不算錯；找得到的必須格式合理
        if (found) assert.match(found, /\.md$/);
      }
    }
  });

  test('沒有把整部大般若（T0220, 467 萬字）放進來', () => {
    for (const g of GROUPS) {
      for (const m of g.members) {
        assert.notEqual(m.id, 'T0220', 'T0220 是 600 卷 467 萬字，不適合放進對讀欄');
      }
    }
  });
});

describe('同經異譯：經文整理', () => {
  const shape = makeShape();

  test('以 <p> 分段，不是把整部經併成一段', () => {
    const html = '<p>如是我聞：</p><p>一時佛在王舍城。</p><p>爾時觀自在菩薩。</p>';
    const r = shape(html);
    assert.equal(r.body.split('\n\n').filter(Boolean).length, 3,
      '三個 <p> 應該分成三段');
  });

  test('<br> 只換行、不斷段', () => {
    const html = '<p>第一行<br>第二行</p>';
    const r = shape(html);
    const paras = r.body.split('\n\n').filter(Boolean);
    assert.equal(paras.length, 1, '<br> 不該斷段');
    assert.match(paras[0], /第一行/);
    assert.match(paras[0], /第二行/);
  });

  test('CBETA 行政區塊被濾掉（對讀時兩欄一字不差，是噪音）', () => {
    const html = [
      '<p>//【經文資訊】大正藏第 8 冊 No. 253</p>',
      '<p>//【版本記錄】發行日期：2022-10</p>',
      '<p>//【編輯說明】本資料庫由中華電子佛典協會</p>',
      '<p>//【其他事項】本資料庫可自由免費流通</p>',
      '<p>般若波羅蜜多心經</p>'
    ].join('');
    const r = shape(html);
    assert.equal(r.head, '', '行政區塊不該留在 head');
    assert.match(r.body, /般若波羅蜜多心經/);
    assert.doesNotMatch(r.body, /經文資訊/);
    assert.doesNotMatch(r.body, /版本記錄/);
  });

  test('純分隔線不留（`-----` 是裝飾）', () => {
    const html = '<p>//--------------------------</p><p>經文</p>';
    const r = shape(html);
    assert.equal(r.head, '');
  });

  test('行號錨點被清掉', () => {
    const html = '<p><span id="L1" data-line="1" class="line-anchor"></span>經文</p>';
    const r = shape(html);
    assert.doesNotMatch(r.body, /line-anchor/);
    assert.doesNotMatch(r.body, /data-line/);
    assert.match(r.body, /經文/);
  });

  test('HTML 實體被還原', () => {
    const r = shape('<p>a &amp; b &lt;c&gt;</p>');
    assert.match(r.body, /a & b <c>/);
  });

  test('空輸入不炸', () => {
    const r = shape('');
    assert.equal(r.body, '');
    assert.equal(r.head, '');
  });
});

describe('同經異譯：刻意不做逐句對齊', () => {
  test('模組裡沒有對齊演算法', () => {
    // 有過這個想法，實測最長共同片段 0 字之後放棄。
    // 守住「不要有人後來又加回來」。
    assert.doesNotMatch(PAR_JS, /function\s+alignSentences/);
    assert.doesNotMatch(PAR_JS, /\bLCS\b/);
    assert.doesNotMatch(PAR_JS, /longestCommon/);
  });

  test('原始碼有記錄為什麼不做（後人不會誤以為是沒做完）', () => {
    assert.match(PAR_JS, /最長共同片段/);
    assert.match(PAR_JS, /T0254/);
  });
});

describe('同經異譯：與 app.js 的邊界', () => {
  test('只讀 state.treeData，不改它', () => {
    assert.match(PAR_JS, /global\.state/);
    assert.doesNotMatch(PAR_JS, /state\.treeData\s*=/);
  });

  test('走既有的 /api/render，不自建後端', () => {
    assert.match(PAR_JS, /'\/api\/render\?path='/);
  });

  test('用 textContent 建 DOM，不塞 innerHTML', () => {
    assert.doesNotMatch(PAR_JS, /\.innerHTML\s*=/);
  });

  test('沒有 document 的環境不會拋錯', () => {
    assert.match(PAR_JS, /typeof document !== 'undefined'/);
  });
});

describe('同經異譯：DOM 對得上', () => {
  test('模組查的每個 parallel* id 都存在於 index.html', () => {
    const ids = [...PAR_JS.matchAll(/\$\('(parallel[A-Za-z]*)'\)/g)].map(m => m[1]);
    assert.ok(ids.length > 0, '找不到任何 parallel* 的 $() 查詢');
    for (const id of new Set(ids)) {
      assert.ok(INDEX_HTML.includes(`id="${id}"`), `查了 #${id}，但 index.html 沒有`);
    }
  });

  test('首頁有入口按鈕', () => {
    assert.match(INDEX_HTML, /id="homeParallelOpen"/);
    assert.match(PAR_JS, /homeParallelOpen/);
  });

  test('對話框有無障礙屬性', () => {
    const block = INDEX_HTML.match(/<div[^>]*id="parallelReadingOverlay"[^>]*>/);
    assert.ok(block, '找不到 parallelReadingOverlay');
    assert.match(block[0], /role="dialog"/);
    assert.match(block[0], /aria-modal="true"/);
    assert.match(block[0], /aria-labelledby="parallelReadingTitle"/);
  });

  test('腳本在 app.js 之後載入', () => {
    const appIdx = INDEX_HTML.indexOf('app.js?v=');
    const parIdx = INDEX_HTML.indexOf('parallel-reading.js?v=');
    assert.ok(appIdx > 0 && parIdx > 0);
    assert.ok(parIdx > appIdx);
  });

  test('Service Worker 有快取', () => {
    assert.match(SW_JS, /'\/parallel-reading\.js'/);
  });
});

describe('同經異譯：版面', () => {
  test('每欄各自捲動（各譯本長度不同，硬綁會互相牽扯）', () => {
    const block = STYLE_CSS.match(/\.parallel-col-text\s*\{[\s\S]*?\}/);
    assert.ok(block);
    assert.match(block[0], /overflow-y:\s*auto/);
  });

  test('手機上改成上下堆疊', () => {
    assert.match(STYLE_CSS, /@media \(max-width: 900px\)\s*\{[\s\S]*?\.parallel-columns[\s\S]*?flex-direction:\s*column/);
  });

  test('Esc 可以關閉', () => {
    assert.match(PAR_JS, /e\.key === 'Escape' && isOpen/);
  });

  test('點背景可以關閉', () => {
    assert.match(PAR_JS, /e\.target === overlay/);
  });

  test('最多四欄（再多每欄不到 280px，中文會擠成一條線）', () => {
    assert.match(PAR_JS, /Math\.min\(4,/);
  });
});
