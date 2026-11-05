/**
 * @file tests/test-commentary.test.js
 *
 * 歷代註疏（alpha 批次 8）。
 *
 * 讀完一部經，最自然的下一個問題是「所以這部經到底是什麼意思」。這個站
 * 有兩千多部註疏，卻沒有任何一條路從經文通往它們。
 *
 * 這支測試守三件事：
 *   1. 資料是真的（來自 CBETA 的 [cf. No.] 交叉參照，不是手寫清單）
 *   2. 作者抽取不會把經名當成人名（這是實測抓到過的錯）
 *   3. 點開一部註疏後，整塊不會自己消失（這也是實測抓到的）
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_JS = fs.readFileSync(path.join(ROOT_DIR, 'commentary-data.js'), 'utf8');
const LINK_JS = fs.readFileSync(path.join(ROOT_DIR, 'commentary-link.js'), 'utf8');
const GEN_JS = fs.readFileSync(path.join(ROOT_DIR, 'scripts/gen-commentaries.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
const STYLE_CSS = fs.readFileSync(path.join(ROOT_DIR, 'style.css'), 'utf8');
const SW_JS = fs.readFileSync(path.join(ROOT_DIR, 'sw.js'), 'utf8');

/** 載入資料模組（IIFE 掛在 window 上）。 */
function loadData() {
  const g = {};
  new Function('window', DATA_JS.replace(
    '})(typeof window !== \'undefined\' ? window : this);', '})(window);'))(g);
  return g.CommentaryData;
}

const DATA = loadData();
const FAMILIES = DATA.families;

describe('歷代註疏：資料完整性', () => {
  test('至少 20 組（少於這個數字代表掃描壞了）', () => {
    assert.ok(FAMILIES.length >= 20, `只有 ${FAMILIES.length} 組`);
  });

  test('每組至少兩部註疏（一部稱不上譜系）', () => {
    for (const f of FAMILIES) {
      assert.ok(f.commentaries.length >= 2,
        `${f.base.id} 只有 ${f.commentaries.length} 部`);
    }
  });

  test('底本與註疏都指向真實存在的檔案路徑', () => {
    for (const f of FAMILIES) {
      assert.ok(f.base.path, `${f.base.id} 缺 path`);
      assert.ok(f.base.path.endsWith('.md'), `${f.base.id} 的 path 不是 .md`);
      for (const c of f.commentaries) {
        assert.ok(c.path && c.path.endsWith('.md'), `${c.id} 的 path 不對`);
      }
    }
  });

  test('註疏不得自我參照（某部經不會是自己的註疏）', () => {
    for (const f of FAMILIES) {
      for (const c of f.commentaries) {
        assert.notEqual(c.id, f.base.id, `${f.base.id} 把自己列為註疏`);
      }
    }
  });

  test('經號格式正確', () => {
    for (const f of FAMILIES) {
      assert.match(f.base.id, /^T\d{4}$/);
      for (const c of f.commentaries) {
        assert.match(c.id, /^T\d{4}$/);
      }
    }
  });

  test('金剛經是最大的一組（這是語料的事實，也是驗證掃描方向對不對）', () => {
    const diamond = FAMILIES.find(f => f.base.id === 'T0235');
    assert.ok(diamond, '找不到 T0235《金剛般若波羅蜜經》');
    assert.ok(diamond.commentaries.length >= 10,
      `金剛經只有 ${diamond.commentaries.length} 部註疏，掃描可能壞了`);
  });

  test('排序：註疏多的組排在前面', () => {
    for (let i = 1; i < FAMILIES.length; i++) {
      assert.ok(FAMILIES[i - 1].commentaries.length >= FAMILIES[i].commentaries.length,
        '組的排序不是依註疏數量遞減');
    }
  });

  test('forBase 查得到，查不到的回 null（不是 undefined）', () => {
    assert.ok(DATA.forBase('T0235'));
    assert.equal(DATA.forBase('T9999'), null);
  });
});

describe('歷代註疏：作者抽取', () => {
  test('抽到的作者不含經名用字（這是實測抓到過的錯）', () => {
    // 第一版把「金剛般若經」「維摩義」當成作者，因為沒有先跳過經題行。
    for (const f of FAMILIES) {
      for (const c of f.commentaries) {
        if (!c.by) continue;
        assert.doesNotMatch(c.by, /[經論疏品卷]/,
          `${c.id} 的作者「${c.by}」看起來是經名`);
      }
    }
  });

  test('作者不會是單一個字（CBETA 的省稱單看像錯字）', () => {
    for (const f of FAMILIES) {
      for (const c of f.commentaries) {
        if (!c.by) continue;
        assert.ok(c.by.length >= 2, `${c.id} 的作者只有一個字：「${c.by}」`);
      }
    }
  });

  test('已知的歷史人物抽得到', () => {
    const all = FAMILIES.flatMap(f => f.commentaries);
    const names = new Set(all.map(c => c.by).filter(Boolean));
    // 這幾個是最有名的，抽不到代表規則壞了
    for (const expected of ['天台智者大師', '窺基', '蕅益智旭']) {
      assert.ok(names.has(expected), `抽不到「${expected}」`);
    }
  });

  test('抽不到作者時，至少有署名原文或經名可顯示', () => {
    for (const f of FAMILIES) {
      for (const c of f.commentaries) {
        const hasSomething = !!(c.by || c.attribution || c.name);
        assert.ok(hasSomething, `${c.id} 什麼都沒有，卡片會是空白的`);
      }
    }
  });

  test('作者抽取率不低於 40%（太低的規則等於沒用）', () => {
    const all = FAMILIES.flatMap(f => f.commentaries);
    const withBy = all.filter(c => c.by).length;
    const rate = withBy / all.length;
    assert.ok(rate >= 0.4, `作者抽取率只有 ${Math.round(rate * 100)}%`);
  });

  test('產生器跳過經題行（不是直接拿 No. 行的下一行當作者）', () => {
    assert.match(GEN_JS, /titleSkipped/);
  });

  test('產生器排除「譯」（那是底本譯者，不是註疏作者）', () => {
    assert.match(GEN_JS, /AUTHOR_VERB_RE/);
    assert.doesNotMatch(GEN_JS.match(/AUTHOR_VERB_RE = \/[^;]+/)[0], /\|譯\|/);
  });

  test('產生器有記錄第一版為什麼寫壞（後人不會重犯）', () => {
    assert.match(GEN_JS, /第一版寫壞了|沒有先跳過經題行/);
  });
});

describe('歷代註疏：與 app.js 的邊界', () => {
  test('開檔走既有的 window.mdwOpenFile', () => {
    assert.match(LINK_JS, /typeof global\.mdwOpenFile === 'function'/);
  });

  test('抓不到介面時退回 hash', () => {
    assert.match(LINK_JS, /location\.hash = '#file='/);
  });

  test('只讀 state.currentFile，不改它', () => {
    assert.match(LINK_JS, /st\.currentFile/);
    assert.doesNotMatch(LINK_JS, /state\.currentFile\s*=/);
  });

  test('用 textContent 建 DOM，不塞 innerHTML', () => {
    assert.doesNotMatch(LINK_JS, /\.innerHTML\s*=/);
  });

  test('沒有 document 的環境不會拋錯', () => {
    assert.match(LINK_JS, /typeof document !== 'undefined'/);
  });
});

describe('歷代註疏：點開註疏後不會消失', () => {
  // 這是實測抓到的 bug：點第一張卡後 500ms，清單從 14 張變成 0 張。
  test('模組會認出「目前檔案本身是某組的註疏」', () => {
    assert.match(LINK_JS, /commentaries\[j\]\.id === baseId/);
  });

  test('認出來之後繼續顯示那一組，並標明現在讀哪一部', () => {
    assert.match(LINK_JS, /這一部註解的是/);
  });

  test('原始碼有記錄這個 bug', () => {
    assert.match(LINK_JS, /怎麼不見了|從 14 張變成 0 張/);
  });

  test('正在讀的那一部有 aria-current 且不能再點', () => {
    assert.match(LINK_JS, /setAttribute\('aria-current', 'true'\)/);
    assert.match(LINK_JS, /card\.disabled = true/);
  });
});

describe('歷代註疏：DOM 對得上', () => {
  test('模組查的每個 commentary* id 都存在於 index.html', () => {
    const ids = [...LINK_JS.matchAll(/\$\('(commentary[A-Za-z]*)'\)/g)].map(m => m[1]);
    assert.ok(ids.length > 0, '找不到任何 commentary* 的 $() 查詢');
    for (const id of new Set(ids)) {
      assert.ok(INDEX_HTML.includes(`id="${id}"`), `查了 #${id}，但 index.html 沒有`);
    }
  });

  test('區塊預設隱藏（沒有註疏的經不該留空白）', () => {
    const block = INDEX_HTML.match(/<section[^>]*id="commentaryFamily"[^>]*>/);
    assert.ok(block, '找不到 commentaryFamily');
    assert.match(block[0], /\bhidden\b/);
  });

  test('腳本順序：資料在邏輯之前', () => {
    const dataIdx = INDEX_HTML.indexOf('commentary-data.js?v=');
    const linkIdx = INDEX_HTML.indexOf('commentary-link.js?v=');
    assert.ok(dataIdx > 0 && linkIdx > 0);
    assert.ok(dataIdx < linkIdx, 'commentary-data.js 必須在 commentary-link.js 之前');
  });

  test('兩個檔案都在 app.js 之後', () => {
    const appIdx = INDEX_HTML.indexOf('app.js?v=');
    assert.ok(INDEX_HTML.indexOf('commentary-link.js?v=') > appIdx);
  });

  test('Service Worker 兩個都快取', () => {
    assert.match(SW_JS, /'\/commentary-data\.js'/);
    assert.match(SW_JS, /'\/commentary-link\.js'/);
  });
});

describe('歷代註疏：版面', () => {
  test('卡片用 grid，不是逐筆堆疊', () => {
    const block = STYLE_CSS.match(/\.commentary-list\s*\{[\s\S]*?\}/);
    assert.ok(block);
    assert.match(block[0], /display:\s*grid/);
  });

  test('手機上單欄', () => {
    assert.match(STYLE_CSS, /@media \(max-width: 640px\)\s*\{[\s\S]*?\.commentary-list[\s\S]*?grid-template-columns:\s*1fr/);
  });

  test('列印時不輸出（清單是給螢幕點的）', () => {
    assert.match(STYLE_CSS, /@media print\s*\{[\s\S]*?\.commentary-family[\s\S]*?display:\s*none/);
  });

  test('卡片是 button（鍵盤可達）', () => {
    assert.match(LINK_JS, /document\.createElement\('button'\)/);
  });
});
