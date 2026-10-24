/**
 * 全庫搜尋深層連結 (?search=) 與 WebSite/SearchAction 結構化資料測試
 *
 * 背景（兩個既有缺陷）：
 *   1. `seoEnableSearchBox` 是空轉開關——值被寫進 config.json、開關也畫在
 *      設定頁，但全庫沒有任何程式碼讀取它，因此永遠不會產生任何標記。
 *   2. `app.js` 的 `getFileFromURL()` 有解析 `?q=` / `?query=`，但呼叫端
 *      （開機流程）只把 query 丟掉、沒有傳進 `openFile()` 的第三個參數
 *      `highlightQuery`，所以網址帶了關鍵字也不會閃示。
 *
 * 本次新增 `?search=<kw>` 深層連結（可分享／加書籤／設為瀏覽器搜尋引擎），
 * 並補上真正由 `seoEnableSearchBox` 驅動的 WebSite + SearchAction 標記。
 *
 * 本檔包含：
 *   1. 真實行為測試（面板）— 以假 DOM 在 `vm` 中實際執行 `activateSearchPanel`，
 *      驗證側欄展開、分頁切換、搜尋觸發與網址同步，而非只比對原始碼字串。
 *   2. 真實行為測試（解析）— 以 `vm` 實際執行純函式 `parseUrlParams`。
 *      app.js 是 IIFE 無法 import，但此二函式無需真實瀏覽器即可求值
 *      （沿用 tests/test-toast.test.js 與 test-markdown-renderer.test.js 的慣例）。
 *   3. 伺服器端整合測試 — 以真實 http 請求驗證標記只在正確條件下出現。
 *   4. 原始碼契約測試 — 守護 UI 文字與呼叫端接線不會被改回空轉。
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');

const ROOT_DIR = path.join(__dirname, '..');
const APP_JS = path.join(ROOT_DIR, 'app.js');
const INDEX_HTML = path.join(ROOT_DIR, 'index.html');
const STATIC_CACHE_JS = path.join(ROOT_DIR, 'lib', 'static-cache.js');

// ─────────────────────────────────────────────────────────────────────────
// 由 app.js 抽出純函式並在 vm 中實際執行
// ─────────────────────────────────────────────────────────────────────────
function extractFunctionBody(source, signature) {
  const start = source.indexOf(signature);
  if (start === -1) return null;
  let i = source.indexOf('{', start);
  if (i === -1) return null;
  let depth = 0;
  let inLineComment = false;
  let inBlockComment = false;
  let quote = null;
  for (; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (inLineComment) { if (ch === '\n') inLineComment = false; continue; }
    if (inBlockComment) { if (ch === '*' && next === '/') { inBlockComment = false; i++; } continue; }
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') { inLineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(source.indexOf('{', start), i + 1);
    }
  }
  return null;
}

/**
 * 建立可執行 `parseUrlParams` 的沙箱。
 * `safeDecodeURIComponent` 直接沿用 app.js 內的區域實作，確保測到的是
 * 真實行為而非另寫一份近似品。
 */
function loadFromApp(snippets, bootstrap) {
  const source = fs.readFileSync(APP_JS, 'utf8');
  let code = '';
  for (const sig of snippets) {
    const body = extractFunctionBody(source, sig);
    assert.ok(body, `app.js 應包含 ${sig}`);
    code += `${sig} ${body}\n`;
  }
  code += bootstrap;
  const sandbox = { URLSearchParams, console };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox;
}

function loadParseUrlParams() {
  return loadFromApp(
    ['function safeDecodeURIComponent(str)', 'function parseUrlParams(search, hash)'],
    'globalThis.__parse = parseUrlParams;'
  ).__parse;
}

// ─────────────────────────────────────────────────────────────────────────
// 極簡假 DOM：足以驅動 activateSearchPanel 的真實分支
// ─────────────────────────────────────────────────────────────────────────
function makeClassList(el) {
  return {
    add(...cs) { cs.forEach((c) => el._classes.add(c)); },
    remove(...cs) { cs.forEach((c) => el._classes.delete(c)); },
    contains(c) { return el._classes.has(c); },
    toggle(c, force) {
      const on = force === undefined ? !el._classes.has(c) : !!force;
      if (on) el._classes.add(c); else el._classes.delete(c);
      return on;
    }
  };
}

function makeEl(classes = []) {
  const el = {
    _classes: new Set(classes),
    value: '',
    focusCalls: 0,
    focus() { el.focusCalls++; }
  };
  el.classList = makeClassList(el);
  return el;
}

/**
 * 在沙箱中實際執行 activateSearchPanel，並回報它對 DOM/狀態做了什麼。
 * 這比原始碼字串比對有力：能證明「側欄真的展開、分頁真的切換、搜尋真的
 * 被觸發、輸入框真的被填入」。
 */
function runActivateSearchPanel(query, opts = {}) {
  const sidebarEl = makeEl(opts.sidebarCollapsed ? ['collapsed'] : []);
  const searchTab = makeEl();
  const searchPanel = makeEl();
  const otherTab = makeEl(['active']);
  const otherPanel = makeEl(['active']);
  const input = makeEl();
  const calls = { search: [], dictToggled: [], pushedUrls: [] };

  const sandbox = {
    URLSearchParams,
    console,
    window: {
      innerWidth: opts.mobile ? 400 : 1400,
      location: { search: opts.locationSearch || '', pathname: '/' }
    },
    document: {
      querySelector: (sel) => {
        if (sel === '.sidebar-tab[data-tab="search"]') return searchTab;
        if (sel === '.sidebar-panel[data-panel="search"]') return searchPanel;
        return null;
      }
    },
    state: { sidebarCollapsed: !!opts.sidebarCollapsed, dictSidebarOpen: !!opts.dictSidebarOpen, sidebarTab: '' },
    $: (id) => (id === 'sidebar' ? sidebarEl : id === 'globalSearchInput' ? input : null),
    $$: (sel) => (sel === '.sidebar-tab' ? [otherTab, searchTab] : sel === '.sidebar-panel' ? [otherPanel, searchPanel] : []),
    isMobileBrowser: () => !!opts.mobile,
    toggleDictSidebar: (v) => calls.dictToggled.push(v),
    updateSidebarBackdrop: () => { calls.backdrop = (calls.backdrop || 0) + 1; },
    performGlobalSearch: (q) => calls.search.push(q),
    history: { pushState: (_a, _b, url) => calls.pushedUrls.push(url) }
  };
  vm.createContext(sandbox);
  const source = fs.readFileSync(APP_JS, 'utf8');
  const body = extractFunctionBody(source, 'function activateSearchPanel(query, opts)');
  const decodeBody = extractFunctionBody(source, 'function safeDecodeURIComponent(str)');
  assert.ok(body, 'app.js 應包含 activateSearchPanel');
  assert.ok(decodeBody, 'app.js 應包含 safeDecodeURIComponent');
  vm.runInContext(
    `function safeDecodeURIComponent(str) ${decodeBody}\n` +
    `function activateSearchPanel(query, opts) ${body}\nglobalThis.__run = activateSearchPanel;`,
    sandbox
  );
  sandbox.__run(query);
  return { sidebarEl, searchTab, searchPanel, otherTab, otherPanel, input, calls, state: sandbox.state };
}

describe('全庫搜尋深層連結 1：activateSearchPanel 面板開啟行為', () => {
  test('應展開收合的側欄、切到搜尋分頁並執行搜尋', () => {
    const r = runActivateSearchPanel('般若', { sidebarCollapsed: true });
    assert.equal(r.sidebarEl.classList.contains('collapsed'), false, '側欄應被展開');
    assert.equal(r.state.sidebarCollapsed, false, 'state.sidebarCollapsed 應同步');
    assert.ok(r.searchTab.classList.contains('active'), '搜尋分頁應為 active');
    assert.ok(r.searchPanel.classList.contains('active'), '搜尋面板應為 active');
    assert.ok(!r.otherTab.classList.contains('active'), '其他分頁應被取消 active');
    assert.ok(!r.otherPanel.classList.contains('active'), '其他面板應被取消 active');
    assert.equal(r.state.sidebarTab, 'search', 'state.sidebarTab 應為 search');
    assert.deepEqual(r.calls.search, ['般若'], '應以該關鍵字執行搜尋');
    assert.equal(r.input.value, '般若', '輸入框應被填入關鍵字');
    assert.ok(r.calls.backdrop >= 1, '應更新側欄遮罩');
  });

  test('空白關鍵字不應觸發任何動作', () => {
    const r = runActivateSearchPanel('   ', { sidebarCollapsed: true });
    assert.deepEqual(r.calls.search, [], '空字串不應執行搜尋');
    assert.ok(r.sidebarEl.classList.contains('collapsed'), '空字串不應展開側欄');
  });

  test('行動版應同時收合辭典側欄，避免雙側欄疊在一起', () => {
    const r = runActivateSearchPanel('法', { mobile: true, dictSidebarOpen: true });
    assert.deepEqual(r.calls.dictToggled, [false], '行動版應收合辭典側欄');
  });

  test('桌面版且辭典側欄未開時不應多餘地收合', () => {
    const r = runActivateSearchPanel('法', { mobile: false, dictSidebarOpen: false });
    assert.deepEqual(r.calls.dictToggled, [], '不應無故呼叫 toggleDictSidebar');
  });

  test('應同步網址為 ?search=，讓搜尋結果可分享', () => {
    const r = runActivateSearchPanel('般若', { locationSearch: '' });
    assert.deepEqual(r.calls.pushedUrls, ['/?search=' + encodeURIComponent('般若')]);
  });

  test('已是同一組 ?search= 時不應重複推入歷史', () => {
    // window.location.search 不含 pathname，且是已編碼形式（真實瀏覽器行為）。
    const same = '?search=' + encodeURIComponent('般若');
    const r = runActivateSearchPanel('般若', { locationSearch: same });
    assert.deepEqual(r.calls.pushedUrls, [], '相同參數不應再推入，否則返回鍵要按兩次');
  });
});

describe('全庫搜尋深層連結 2：parseUrlParams 網址解析', () => {
  let parse;

  before(() => {
    parse = loadParseUrlParams();
  });

  /**
   * vm 內的物件字面值來自另一個 realm，原型與本檔不同，`deepStrictEqual`
   * 會因原型不符而失敗（即使結構相同）。統一經 JSON 來回轉成本 realm 的
   * 純物件再比對，避免測試被 realm 細節干擾。
   */
  const plain = (v) => (v === null || v === undefined ? v : JSON.parse(JSON.stringify(v)));

  test('?search= 應回傳搜尋關鍵字', () => {
    assert.deepEqual(plain(parse('?search=%E8%88%AC%E8%8B%A5', '')), { search: '般若' });
  });

  test('?search= 不應依賴 ?file= 才成立', () => {
    const r = parse('?search=test', '');
    assert.ok(r && r.search === 'test', '?search= 應獨立於 file 分支之外成立');
    assert.equal(r.file, undefined);
  });

  test('?search= 應去除前後空白', () => {
    assert.deepEqual(plain(parse('?search=%20%20%E7%A9%BA%20%20', '')), { search: '空' });
  });

  test('?search= 為空或純空白時應視為未提供', () => {
    assert.equal(parse('?search=', ''), null, '?search= 空值不應觸發搜尋');
    assert.equal(parse('?search=%20%20', ''), null, '?search= 純空白不應觸發搜尋');
  });

  test('?search= 超過 500 字元應截斷（防禦性上限）', () => {
    const long = '字'.repeat(900);
    const r = parse(`?search=${encodeURIComponent(long)}`, '');
    assert.equal(r.search.length, 500, '過長關鍵字應截斷為 500 字元');
  });

  test('?search= 應與 ?file= 並存時優先作為搜尋入口', () => {
    const r = parse('?file=a.md&search=hello', '');
    assert.equal(r.search, 'hello', '明確的搜尋意圖應優先於開檔');
  });

  test('?search= 應與 ?home=1 並存時優先，優先序才一致', () => {
    const r = parse('?home=1&search=hello', '');
    assert.equal(r.search, 'hello', 'search 應一致地優先於 home');
  });

  test('?q= 應仍隨 ?file= 一同回傳（修復被丟棄的閃示關鍵字）', () => {
    assert.deepEqual(plain(parse('?file=a.md&line=12&q=%E6%B3%95', '')), {
      file: 'a.md', line: 12, query: '法'
    });
  });

  test('?query= 為 ?q= 的別名', () => {
    const r = parse('?file=a.md&query=abc', '');
    assert.equal(r.query, 'abc');
  });

  test('沒有任何搜尋參數且非 file/home 時應回傳 null', () => {
    assert.equal(parse('', ''), null);
    assert.equal(parse('?other=1', ''), null);
  });

  test('既有入口不得回歸：home / frontpage / page=home', () => {
    assert.deepEqual(plain(parse('?home=1', '')), { isHome: true });
    assert.deepEqual(plain(parse('?frontpage=1', '')), { isHome: true });
    assert.deepEqual(plain(parse('?page=home', '')), { isHome: true });
    assert.equal(parse('?home=0', ''), null, 'home=0 不應回首頁');
  });

  test('既有入口不得回歸：雜湊格式 #file= 與 #home', () => {
    assert.deepEqual(plain(parse('', '#file=a.md')), { file: 'a.md', line: null });
    assert.deepEqual(plain(parse('', '#home')), { isHome: true });
  });

  test('?file= 的檔案路徑應正確解碼（含中文與斜線）', () => {
    const r = parse(`?file=${encodeURIComponent('01-大正藏/T0251《心經》.md')}`, '');
    assert.equal(r.file, '01-大正藏/T0251《心經》.md');
  });

  test('畸形路徑不得拋出例外', () => {
    assert.doesNotThrow(() => parse('?file=%E0%A4%A', ''));
    assert.doesNotThrow(() => parse('?search=%E0%A4%A', ''));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. 伺服器端：WebSite + SearchAction 標記的真實輸出
// ─────────────────────────────────────────────────────────────────────────
describe('全庫搜尋深層連結 3：WebSite + SearchAction 伺服器端輸出', () => {
  // 以子行程隔離啟動，才能分別以不同 config 驗證。
  const { spawn } = require('child_process');

  const startServer = (env) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT_DIR,
      env: Object.assign({}, process.env, { PORT: '0', HOST: '127.0.0.1' }, env)
    });
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/MDWEBVIEW_READY port=(\d+)/);
      if (m) {
        child.stdout.off('data', onData);
        resolve({ child, port: parseInt(m[1], 10) });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', () => {});
    child.on('error', reject);
    child.on('exit', (code) => {
      if (!buf.includes('MDWEBVIEW_READY')) reject(new Error(`server exited early (${code}): ${buf.slice(-500)}`));
    });
    setTimeout(() => reject(new Error('server did not become ready in time')), 30000).unref();
  });

  const stopServer = (child) => new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} resolve(); }, 5000).unref();
  });

  const get = (port, urlPath, headers) => new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'GET', headers: headers || {} },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { body += d; });
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });

  /**
   * 取出頁面中所有 JSON-LD 區塊並實際解析。
   *
   * 不可用 `body.includes('SearchAction')` 這種子字串斷言：設定面板的說明
   * 文字本身就含有 "WebSite + SearchAction" 字樣，會被誤判為「有輸出標記」。
   * 只認真正解析得動的結構化資料。
   */
  const extractJsonLd = (html) => {
    const blocks = [];
    const re = /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const parsed = JSON.parse(m[1]);
      blocks.push(parsed);
    }
    return blocks;
  };

  /** 攤平 @graph，回傳所有節點。 */
  const flattenNodes = (blocks) => {
    const out = [];
    for (const b of blocks) {
      if (b && Array.isArray(b['@graph'])) out.push(...b['@graph']);
      else out.push(b);
    }
    return out;
  };

  const findSearchAction = (html) => {
    for (const node of flattenNodes(extractJsonLd(html))) {
      if (node && node.potentialAction && node.potentialAction['@type'] === 'SearchAction') {
        return node.potentialAction;
      }
    }
    return null;
  };

  test('開啟 seoEnableSearchBox 後，首頁應輸出 WebSite + SearchAction', async () => {
    const { child, port } = await startServer({
      SEO_ENABLE_SEARCH_BOX: 'true',
      SITE_URL: 'https://example.test'
    });
    try {
      const res = await get(port, '/', { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' });
      assert.equal(res.statusCode, 200);

      const nodes = flattenNodes(extractJsonLd(res.body));
      const website = nodes.find((n) => n && n['@type'] === 'WebSite');
      assert.ok(website, '首頁應含 WebSite 節點');
      assert.equal(website.url, 'https://example.test/', 'WebSite.url 應為站台根網址');

      const action = findSearchAction(res.body);
      assert.ok(action, '首頁應含 SearchAction');
      assert.equal(
        action.target.urlTemplate,
        'https://example.test/?search={search_term_string}',
        'SearchAction 樣板應為 <base>/?search={search_term_string}'
      );
      assert.equal(action['query-input'], 'required name=search_term_string', '應含 query-input 宣告');
    } finally {
      await stopServer(child);
    }
  });

  test('未開啟 seoEnableSearchBox 時，首頁不得出現 SearchAction', async () => {
    const { child, port } = await startServer({
      SEO_ENABLE_SEARCH_BOX: 'false',
      SITE_URL: 'https://example.test'
    });
    try {
      const res = await get(port, '/', { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' });
      assert.equal(res.statusCode, 200);
      assert.equal(findSearchAction(res.body), null, '未開啟時不應輸出 SearchAction');
    } finally {
      await stopServer(child);
    }
  });

  test('單機模式即使開啟開關也不得輸出（robots 已全面 Disallow）', async () => {
    const { child, port } = await startServer({
      SEO_ENABLE_SEARCH_BOX: 'true',
      SITE_URL: 'https://example.test',
      MDW_DEPLOY_TARGET: 'win-app'
    });
    try {
      const res = await get(port, '/', { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' });
      assert.equal(res.statusCode, 200);
      assert.equal(findSearchAction(res.body), null, '單機模式不應輸出 SearchAction');
    } finally {
      await stopServer(child);
    }
  });

  test('經文 SSR 頁面不得輸出站台層級的 SearchAction', async () => {
    const { child, port } = await startServer({
      SEO_ENABLE_SEARCH_BOX: 'true',
      SITE_URL: 'https://example.test'
    });
    try {
      const file = encodeURIComponent('01-大正藏/03般若部類/T0251《般若波羅蜜多心經》.md');
      const res = await get(port, `/?file=${file}&ssr=1`, {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)'
      });
      assert.equal(res.statusCode, 200);
      assert.equal(
        findSearchAction(res.body),
        null,
        '經文頁屬子頁面，不應輸出站台層級的 SearchAction'
      );
      // 經文頁的 @graph 內含 isPartOf 的 WebSite，但不得再疊一層頂層節點。
      const websiteCount = flattenNodes(extractJsonLd(res.body))
        .filter((n) => n && n['@type'] === 'WebSite').length;
      assert.ok(websiteCount <= 1, `經文頁 WebSite 節點數應 <=1，實際 ${websiteCount}`);
    } finally {
      await stopServer(child);
    }
  });

  test('JSON-LD 必須帶 CSP nonce，否則會被瀏覽器 CSP 阻擋', async () => {
    const { child, port } = await startServer({
      SEO_ENABLE_SEARCH_BOX: 'true',
      SITE_URL: 'https://example.test'
    });
    try {
      const res = await get(port, '/', { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' });
      const m = res.body.match(/<script type="application\/ld\+json" nonce="([^"]+)">/);
      assert.ok(m, 'application/ld+json script 應帶 nonce 屬性');
      assert.ok(
        res.headers['content-security-policy'].includes(`nonce-${m[1]}`),
        'CSP 標頭應包含該 nonce'
      );
    } finally {
      await stopServer(child);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. 原始碼契約：避免接線被改回空轉
// ─────────────────────────────────────────────────────────────────────────
describe('全庫搜尋深層連結 4：原始碼契約', () => {
  test('開機流程應把 urlInfo.search 接上 activateSearchPanel', () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    assert.ok(
      /urlInfo\.search[\s\S]{0,120}activateSearchPanel\(/.test(src),
      '開機流程應處理 urlInfo.search 並呼叫 activateSearchPanel'
    );
  });

  test('開機流程應把 urlInfo.query 傳進 openFile（修復被丟棄的 ?q=）', () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    assert.ok(
      /openFile\(urlInfo\.file,\s*urlInfo\.line,\s*urlInfo\.query\)/.test(src),
      'openFile 呼叫應帶入 urlInfo.query，否則 ?q= 仍會被丟棄'
    );
  });

  test('popstate 處理應支援 ?search=', () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    const handler = extractFunctionBody(src, 'const handleUrlChange = async () =>');
    assert.ok(handler, '應能找到 handleUrlChange');
    assert.ok(handler.includes('info.search'), 'handleUrlChange 應處理 info.search');
    assert.ok(handler.includes('activateSearchPanel'), 'handleUrlChange 應呼叫 activateSearchPanel');
  });

  test('activateSearchPanel 應存在且真的執行搜尋', () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    const body = extractFunctionBody(src, 'function activateSearchPanel(query, opts)');
    assert.ok(body, '應定義 activateSearchPanel');
    assert.ok(body.includes('performGlobalSearch('), 'activateSearchPanel 應實際執行搜尋');
    assert.ok(body.includes('globalSearchInput'), 'activateSearchPanel 應同步輸入框內容');
  });

  test('右鍵選單的全文庫搜尋應改用共用 helper，避免兩份實作走鐘', () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    assert.ok(
      /searchBtn\.addEventListener\('click'[\s\S]{0,900}?activateSearchPanel\(/.test(src),
      '右鍵搜尋按鈕應呼叫 activateSearchPanel'
    );
  });

  test('static-cache.js 應有受 seoEnableSearchBox 驅動的 SearchAction 產出', () => {
    const src = fs.readFileSync(STATIC_CACHE_JS, 'utf8');
    assert.ok(
      src.includes('seoEnableSearchBox === true'),
      'static-cache.js 應讀取 seoEnableSearchBox，否則開關仍是空轉'
    );
    assert.ok(src.includes('SearchAction'), 'static-cache.js 應產出 SearchAction');
    assert.ok(
      src.includes('{search_term_string}'),
      'SearchAction 樣板應使用 {search_term_string} 佔位符'
    );
  });

  test('設定頁說明不得再宣稱會產生 Google 檢索框（功能已下線）', () => {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    assert.ok(
      !html.includes('Sitelinks Searchbox'),
      'index.html 不應再以 Sitelinks Searchbox 命名（Google 已於 2024-11-21 下線）'
    );
    assert.ok(
      !/提供搜尋結果站內檢索框/.test(html),
      'index.html 不應再宣稱會提供搜尋結果站內檢索框'
    );
  });

  test('搜尋關鍵字長度上限應為 500（防禦性邊界）', () => {
    const appSrc = fs.readFileSync(APP_JS, 'utf8');
    const body = extractFunctionBody(appSrc, 'function parseUrlParams(search, hash)');
    assert.ok(body.includes('slice(0, 500)'), 'parseUrlParams 應套用 500 字元上限');
  });
});
