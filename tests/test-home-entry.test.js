/**
 * @file tests/test-home-entry.test.js
 *
 * 首頁的兩個新人入口（alpha 批次 2a / 2b）。
 *
 * 這個站台的目標讀者同時包含「已經在讀藏經的人」與「只是路過、想看看佛法是
 * 什麼的人」。後者打開首頁看到的是七千多個檔案與一個搜尋框——搜尋的前提是
 * 你已經知道要搜什麼。多數人不知道，於是就離開了。
 *
 * 2a 給三本長度差距很大的經，各自標明字數與時間，並在讀過之後自動收起。
 * 2b 把首頁搜尋拆成「經名 / 經文 / 辭典」三段，不再把所有結果混在一起排。
 *
 * 這支測試守的是「三本書指向的檔案真的存在」與「三段真的分開」這兩件事——
 * 兩者都會在語料換版或選擇器改名時悄悄壞掉，而畫面看起來仍然正常。
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const INDEX_HTML = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
const APP_JS = fs.readFileSync(path.join(ROOT_DIR, 'app.js'), 'utf8');
const STYLE_CSS = fs.readFileSync(path.join(ROOT_DIR, 'style.css'), 'utf8');

describe('2a 首頁「第一次來」三本書', () => {
  test('index.html 有 homeStart 區塊與三張卡片', () => {
    assert.match(INDEX_HTML, /id="homeStart"/, '應有 #homeStart');
    const keys = [...INDEX_HTML.matchAll(/data-start="([a-z]+)"/g)].map(m => m[1]);
    assert.deepEqual(keys, ['heart', 'amitabha', 'diamond'], '應有三張卡片，順序由短到長');
  });

  test('每張卡片都寫了字數與預估時間（不是只有經名）', () => {
    for (const m of INDEX_HTML.matchAll(/data-start="([a-z]+)"[\s\S]{0,700}?<\/button>/g)) {
      const block = m[0];
      assert.match(block, /約 [\d,]+ 字/, `${m[1]} 應標示字數`);
      assert.match(block, /\d+ 分鐘/, `${m[1]} 應標示預估時間`);
      assert.match(block, /class="home-start-why"/, `${m[1]} 應說明「讀了會得到什麼」`);
    }
  });

  test('卡片是可點的 button（鍵盤可達），不是 div', () => {
    for (const key of ['heart', 'amitabha', 'diamond']) {
      const re = new RegExp(`<button[^>]*data-start="${key}"`);
      assert.match(INDEX_HTML, re, `${key} 應為 <button>`);
    }
  });

  test('app.js 的 HOME_START_PATHS 涵蓋三個 key，且經號／經名與卡片一致', () => {
    const block = APP_JS.match(/const HOME_START_PATHS = \[([\s\S]*?)\n  \];/);
    assert.ok(block, '應有 HOME_START_PATHS');
    const body = block[1];
    for (const key of ['heart', 'amitabha', 'diamond']) {
      assert.ok(body.includes(`key: '${key}'`), `HOME_START_PATHS 應含 ${key}`);
    }
    // 心經刻意用 T0253：T0251 在語料裡是「合成測試語料」佔位檔（只有 75 漢字）
    assert.match(body, /tx: 'T0253'/, '心經應指向 T0253（CBETA 真實譯本），不是佔位檔 T0251');
    assert.match(body, /tx: 'T0366'/, '阿彌陀經應指向 T0366');
    assert.match(body, /tx: 'T0235'/, '金剛經應指向 T0235');
  });

  test('三本書指向的檔案真的存在於 md/（語料換版時會抓到）', () => {
    const mdDir = path.join(ROOT_DIR, 'md');
    if (!fs.existsSync(mdDir)) return; // CI 只有程式碼，沒有語料
    const all = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.md')) all.push({ path: p, name: e.name.replace(/\.md$/i, '') });
      }
    })(mdDir);
    const norm = s => String(s || '').toLowerCase().replace(/[《》〈〉「」『』（）()\[\]\s，。、；：·‧_\-]/g, '');
    const specs = [
      { key: 'heart', tx: 'T0253', title: '般若波羅蜜多心經' },
      { key: 'amitabha', tx: 'T0366', title: '佛說阿彌陀經' },
      { key: 'diamond', tx: 'T0235', title: '金剛般若波羅蜜經' }
    ];
    for (const s of specs) {
      const hit = all.find(f =>
        norm(f.name).includes(norm(s.tx)) && norm(f.name).includes(norm(s.title)));
      assert.ok(hit, `${s.key} 應找得到 ${s.tx}《${s.title}》`);
    }
  });

  test('心經指向的那個檔案不是「合成測試語料」佔位檔', () => {
    const mdDir = path.join(ROOT_DIR, 'md');
    if (!fs.existsSync(mdDir)) return;
    const p = path.join(mdDir, '01-大正藏/03般若部類/T0253《般若波羅蜜多心經》.md');
    if (!fs.existsSync(p)) return;
    const text = fs.readFileSync(p, 'utf8');
    assert.ok(!text.includes('合成測試語料'),
      'T0253 應是真實經文；若語料換成佔位檔，新人第一本書就讀不到內容');
    // 真的心經一定含這幾句
    assert.ok(text.includes('色即是空'), 'T0253 應含經文核心');
    assert.ok(text.includes('觀自在菩薩'), 'T0253 應含經文核心');
  });

  test('讀過之後會收起：有 HOME_START_DONE 鍵與 renderHomeStart', () => {
    assert.match(APP_JS, /HOME_START_DONE:\s*'mdWebview-home-start-done'/);
    assert.match(APP_JS, /function renderHomeStart\(/);
    assert.match(APP_JS, /function openHomeStart\(/);
    // renderHome 要把 renderHomeStart 一起畫
    const fn = APP_JS.match(/function renderHome\(\)\s*\{([\s\S]*?)\n  \}/);
    assert.match(fn[1], /renderHomeStart\(\)/, 'renderHome 應呼叫 renderHomeStart');
    // 有閱讀紀錄就算上手
    assert.match(APP_JS, /RECENT_FILES[\s\S]{0,200}length > 0/);
  });

  test('找不到檔案時要說清楚，不是靜默失敗', () => {
    const fn = APP_JS.match(/function openHomeStart\([\s\S]*?\n  \}/);
    assert.ok(fn, '應有 openHomeStart');
    assert.match(fn[0], /showToast\(/, '找不到時應提示，而不是按了沒反應');
    assert.match(fn[0], /找不到《/);
  });

  test('樣式存在，且手機是單欄、可點高度足夠', () => {
    assert.match(STYLE_CSS, /\.home-start-card\s*\{/);
    assert.match(STYLE_CSS, /\.home-start-list\s*\{/);
    const mobile = STYLE_CSS.match(/@media \(max-width: 640px\)\s*\{([\s\S]*?)\n\}/);
    assert.ok(mobile, '應有手機斷點');
    assert.match(mobile[1], /grid-template-columns:\s*1fr/, '手機應改單欄');
    assert.match(mobile[1], /min-height:\s*5[0-9]px/, '手機可點高度應 ≥ 50px');
  });

  test('簡體顯示時卡片用簡體字型（不用 TC 字形畫簡體字）', () => {
    assert.match(STYLE_CSS, /html\[data-display-script="hans"\] \.home-start-name/);
  });
});

describe('2b 首頁搜尋三段式', () => {
  test('renderHomeSearchResults 會產生「經名」「經文」兩個分段標題', () => {
    const fn = APP_JS.match(/function renderHomeSearchResults\(\)[\s\S]*?\n  \}/);
    assert.ok(fn, '應有 renderHomeSearchResults');
    assert.match(fn[0], /經名/, '應有「經名」分段');
    assert.match(fn[0], /經文/, '應有「經文」分段');
    assert.match(fn[0], /home-search-group/, '分段標題應有專屬 class');
  });

  test('辭典是獨立一段，且只在後端有結果時才出現', () => {
    assert.match(APP_JS, /function renderHomeSearchDictSection\(/);
    const fn = APP_JS.match(/async function renderHomeSearchDictSection\([\s\S]*?\n  \}/);
    assert.match(fn[0], /state\.dictionaryEnabled/, '辭典沒開就不該出現這一段');
    assert.match(fn[0], /slice\(0, 3\)/, '首頁只放前三筆（常見詞會有上千筆）');
  });

  test('辭典請求帶 variants=1 的機制（簡體顯示時才對得上繁體詞頭）', () => {
    const fn = APP_JS.match(/async function renderHomeSearchDictSection\([\s\S]*?\n  \}/);
    assert.match(fn[0], /variants=\$\{variantsParam\(\)\}/,
      '少了 variants，簡體查詢對不上辭典的繁體詞頭');
  });

  test('辭典是延後補上，不擋住前兩段', () => {
    const fn = APP_JS.match(/function renderHomeSearchResults\(\)[\s\S]*?\n  \}/);
    // 呼叫時不要把結果 await 進來；它在背景跑，回來自己插
    assert.match(fn[0], /renderHomeSearchDictSection\(ul, q\);\s*$/m,
      '辭典區塊應在函式尾端非同步補上，不要 await');
    assert.doesNotMatch(fn[0], /await renderHomeSearchDictSection/,
      '不要 await：辭典要掃 35 萬行，會讓前兩段一起卡住');
  });

  test('舊查詢的結果不會蓋掉新查詢（序號比對）', () => {
    const fn = APP_JS.match(/async function renderHomeSearchDictSection\([\s\S]*?\n  \}/);
    assert.match(fn[0], /seq !== _homeDictSeq/, '應用序號丟棄過期結果');
    assert.match(fn[0], /input\.value\.trim\(\) !== q/, '使用者已改字就不該插入');
  });

  test('鍵盤導覽會跳過分段標題（標題不可被選中）', () => {
    const fn = APP_JS.match(/function setHomeSearchActive\([\s\S]*?\n  \}/);
    assert.ok(fn, '應有 setHomeSearchActive');
    assert.match(fn[0], /querySelectorAll\('\.home-search-opt'\)/,
      '應只以 .home-search-opt 為索引基準，不含分段標題');
  });

  test('方向鍵與 Enter 也以「可選項」計數，不是 children.length', () => {
    assert.match(APP_JS, /const homeOpts = \(\) => Array\.from\(results\.querySelectorAll\('\.home-search-opt'\)\)/);
    assert.doesNotMatch(APP_JS, /const n = results\.children\.length;/, '不應再用 children.length');
  });

  test('選了辭典條目會開到那一行', () => {
    const fn = APP_JS.match(/function chooseHomeSearchOption\([\s\S]*?\n  \}/);
    assert.match(fn[0], /li\.dataset\.dict/, '應處理辭典條目');
    assert.match(fn[0], /openFile\(li\.dataset\.dict, Number\(li\.dataset\.dictLine\)/,
      '應帶行號開檔，直接跳到那一條');
  });

  test('目錄／索引檔不會排在經名第一位', () => {
    const fn = APP_JS.match(/function homeTitleMatches\([\s\S]*?\n  \}/);
    assert.match(fn[0], /INDEX_FILE/, '應把目錄／索引檔往後推');
    assert.match(fn[0], /總目錄/, '應認得「總目錄」');
  });

  test('同一書名只留一筆，不讓一部經佔滿五個名額', () => {
    const fn = APP_JS.match(/function homeTitleMatches\([\s\S]*?\n  \}/);
    assert.match(fn[0], /const seen = Object\.create\(null\)/);
    assert.match(fn[0], /if \(seen\[base\]\) continue;/, '重複書名應跳過');
  });

  test('樣式：分段標題不可被選取，辭典條目用襯線體', () => {
    assert.match(STYLE_CSS, /\.home-search-group\s*\{/);
    const g = STYLE_CSS.match(/\.home-search-group\s*\{([^}]*)\}/);
    assert.match(g[1], /user-select:\s*none/, '標題不該被反白選取');
    assert.match(g[1], /cursor:\s*default/, '標題不該看起來可點');
    assert.match(STYLE_CSS, /\.home-search-opt\.is-dict \.home-search-name/);
  });
});
