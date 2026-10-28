const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT_DIR = path.resolve(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT_DIR, 'app.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
const cssSrc = fs.readFileSync(path.join(ROOT_DIR, 'style.css'), 'utf8');
const searchVariants = require('../i18n/search-variants.js');

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `app.js 應定義 ${name}()`);
  let depth = 0;
  let quote = null;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`無法擷取 ${name}()`);
}

function makeSandbox(opts = {}) {
  const state = {
    autoS2T: !!opts.autoS2T,
    displayScript: opts.displayScript || 'hant',
    fileTreeFilter: opts.fileTreeFilter || '',
    tocFilter: opts.tocFilter || '',
    ...(opts.state || {}),
  };
  const ctx = {
    state,
    TOC_ROW_H: 34,
    window: {
      mdSearchVariants: searchVariants,
      mdDisplayScript: opts.mdDisplayScript || null,
    },
    s2tQueryEnabled: () => !!state.autoS2T || state.displayScript === 'hans',
    escHtml: (s) => String(s ?? ''),
  };
  vm.createContext(ctx);
  for (const fn of [
    'cleanHeadingText',
    'foldSidebarFilterText',
    'parseSidebarFilterTerms',
    'matchesSidebarFilter',
    'filterTreeNodes',
    'buildVirtualTocItems',
  ]) {
    vm.runInContext(extractFunction(appSrc, fn), ctx);
  }
  return ctx;
}

describe('側欄即時篩選 — HTML 結構與 CSS 樣式', () => {
  test('index.html 在檔案瀏覽器與本頁大綱頂部皆有過濾輸入框與清除鈕', () => {
    assert.match(htmlSrc, /id="panelFiles"[\s\S]*?id="fileTreeFilterInput"[\s\S]*?id="fileTreeFilterClear"[\s\S]*?id="fileTree"/);
    assert.match(htmlSrc, /id="panelToc"[\s\S]*?id="tocFilterInput"[\s\S]*?id="tocFilterClear"[\s\S]*?id="tocList"/);
  });

  test('style.css 包含 .sidebar-filter-input 樣式且行動端強制 16px 防 iOS 放大', () => {
    assert.match(cssSrc, /\.sidebar-filter-wrap\s*\{/);
    assert.match(cssSrc, /\.sidebar-filter-input\s*\{/);
    assert.match(cssSrc, /\.sidebar-filter-clear\[hidden\]\s*\{\s*display:\s*none\s*!important;/);
    assert.match(cssSrc, /\.sidebar-filter-input\s*\{\s*font-size:\s*16px\s*!important;/);
  });

  test('app.js 綁定 input、Escape 清空、清除按鈕與切換檔案重置邏輯', () => {
    const setupEvents = extractFunction(appSrc, 'setupEventListeners');
    assert.match(setupEvents, /fileTreeFilterInput/);
    assert.match(setupEvents, /fileTreeFilterClear/);
    assert.match(setupEvents, /tocFilterInput/);
    assert.match(setupEvents, /tocFilterClear/);
    assert.match(setupEvents, /e\.key === 'Escape'/);

    const openFileFn = extractFunction(appSrc, 'openFile');
    assert.match(openFileFn, /if \(isSwitchingFile\) resetTocFilterUI\(\)/);

    const revealFn = extractFunction(appSrc, 'revealInFileTree');
    assert.match(revealFn, /if \(!row && state\.fileTreeFilter\)\s*\{\s*applyFileTreeFilter\(''\)/);
  });
});

describe('檔案瀏覽器即時篩選 — filterTreeNodes 邏輯', () => {
  const sampleTree = [
    {
      type: 'directory',
      name: '05-新標藏經',
      path: '05-新標藏經',
      children: [
        {
          type: 'directory',
          name: '解深密經',
          path: '05-新標藏經/解深密經',
          children: [
            { type: 'file', name: '《解深密經》卷一.md', path: '05-新標藏經/解深密經/《解深密經》卷一.md' },
            { type: 'file', name: '《解深密經》卷三.md', path: '05-新標藏經/解深密經/《解深密經》卷三.md' },
          ],
        },
        { type: 'file', name: '八識規矩頌.md', path: '05-新標藏經/八識規矩頌.md' },
      ],
    },
    {
      type: 'directory',
      name: '12-智師',
      path: '12-智師',
      children: [
        {
          type: 'directory',
          name: '智禪瑜伽論',
          path: '12-智師/智禪瑜伽論',
          children: [
            { type: 'file', name: '瑜伽講義智禪-71.md', path: '12-智師/智禪瑜伽論/瑜伽講義智禪-71.md' },
            { type: 'file', name: '瑜伽講義智禪-72.md', path: '12-智師/智禪瑜伽論/瑜伽講義智禪-72.md' },
          ],
        },
      ],
    },
  ];

  test('單一與空白多詞篩選：跨資料夾與檔名比對並修剪無關支線', () => {
    const ctx = makeSandbox();
    const terms = Array.from(ctx.parseSidebarFilterTerms('解深密 卷三'));
    const filtered = ctx.filterTreeNodes(sampleTree, terms);

    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].name, '05-新標藏經');
    assert.equal(filtered[0].children.length, 1);
    assert.equal(filtered[0].children[0].name, '解深密經');
    assert.equal(filtered[0].children[0].children.length, 1);
    assert.equal(filtered[0].children[0].children[0].name, '《解深密經》卷三.md');
  });

  test('命中資料夾名稱時保留其下所有檔案', () => {
    const ctx = makeSandbox();
    const terms = Array.from(ctx.parseSidebarFilterTerms('智禪瑜伽論'));
    const filtered = ctx.filterTreeNodes(sampleTree, terms);

    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].children[0].children.length, 2);
  });

  test('開啟簡繁字組比對或簡體顯示時，輸入簡體可命中繁體檔名', () => {
    const ctxOff = makeSandbox({ autoS2T: false, displayScript: 'hant' });
    assert.equal(
      ctxOff.filterTreeNodes(sampleTree, Array.from(ctxOff.parseSidebarFilterTerms('八识规矩颂'))).length,
      0,
      '未開啟簡繁比對且為繁體顯示時，簡體字面不命中'
    );

    const ctxOn = makeSandbox({ autoS2T: true, displayScript: 'hant' });
    const resOn = ctxOn.filterTreeNodes(sampleTree, Array.from(ctxOn.parseSidebarFilterTerms('八识规矩颂')));
    assert.equal(resOn.length, 1);
    assert.equal(resOn[0].children[0].name, '八識規矩頌.md');
  });
});

describe('本頁大綱即時過濾 — buildVirtualTocItems 與一般模式過濾', () => {
  test('虛擬大綱過濾：忽略父層收折狀態找出所有命中標題，清空後還原收折階層', () => {
    const ctx = makeSandbox({ autoS2T: true, tocFilter: '阿赖耶' });
    const v = {
      entries: [
        { h: '第一卷 總標綱要', level: 1 },
        { h: '甲一 釋阿賴耶識三相', level: 2 },
        { h: '乙一 自相門', level: 3 },
        { h: '甲二 釋末那識', level: 2 },
      ],
      _collapsedEntries: new Set([0]), // 第一卷原本處於收折狀態
    };

    ctx.buildVirtualTocItems(v);
    assert.equal(v._tocItems.length, 1, '即使上層收折，過濾時仍應命中子標題');
    assert.equal(v._tocItems[0].entryIndex, 1);
    assert.equal(v._tocItems[0].label, '甲一 釋阿賴耶識三相');
    assert.equal(v._tocItems[0].hasChildren, false, '過濾結果為扁平檢視，不顯示收折箭頭');

    // 清空過濾後，應恢復原本「第一卷收折、子項目隱藏」的狀態
    ctx.state.tocFilter = '';
    ctx.buildVirtualTocItems(v);
    assert.equal(v._tocItems.length, 1);
    assert.equal(v._tocItems[0].entryIndex, 0);
    assert.equal(v._tocItems[0].isCollapsed, true);
  });
});

describe('檔案瀏覽器篩選日誌與數據分析 — 注音/拼音組字感知與靜止去抖', () => {
  const serverSrc = fs.readFileSync(path.join(ROOT_DIR, 'server.js'), 'utf8');

  test('前端綁定 compositionstart / compositionend 與 e.isComposing 防護', () => {
    const setupEvents = extractFunction(appSrc, 'setupEventListeners');
    assert.match(setupEvents, /fileTreeFilterInput\.addEventListener\('compositionstart'/);
    assert.match(setupEvents, /fileTreeFilterInput\.addEventListener\('compositionend'/);
    assert.match(setupEvents, /e\.isComposing \|\| _isFileFilterComposing/);
  });

  test('注音與拼音組字過程不發送日誌，靜止滿去抖時間後才發送一次，且重複與清空不誤送', () => {
    const sentEvents = [];
    let pendingTimer = null;
    const timers = {
      setTimeout(fn, delay) {
        pendingTimer = { fn, delay };
        return pendingTimer;
      },
      clearTimeout(t) {
        if (pendingTimer === t) pendingTimer = null;
      },
    };

    const state = {
      fileTreeFilter: '',
      _lastFileTreeFilterMatches: 0,
    };

    const ctx = {
      state,
      $: () => null,
      renderFileTree: () => {},
      fetch: (url, opts) => {
        sentEvents.push({ url, body: JSON.parse(opts.body) });
        return Promise.resolve({ ok: true });
      },
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    };
    vm.createContext(ctx);

    const blockStart = appSrc.indexOf('const FILE_TREE_FILTER_LOG_DEBOUNCE_MS');
    const blockEnd = appSrc.indexOf('const ICON_COLLAPSE_ALL');
    assert.ok(blockStart > 0 && blockEnd > blockStart, '應找到檔案樹篩選日誌區塊');
    vm.runInContext(appSrc.slice(blockStart, blockEnd), ctx);

    // 1. 模擬注音輸入中（_isFileFilterComposing = true 或純注音符號）：不得排入計時器
    vm.runInContext(`_isFileFilterComposing = true;`, ctx);
    ctx.applyFileTreeFilter('ㄅㄛ');
    ctx.scheduleFileTreeFilterLog('ㄅㄛ');
    assert.equal(pendingTimer, null, 'IME 組字期間不得啟動日誌計時器');

    // 2. 即使瀏覽器未設 isComposing，純注音符號「ㄅㄛ ㄖㄜˇ」也不得排入日誌
    vm.runInContext(`_isFileFilterComposing = false;`, ctx);
    ctx.applyFileTreeFilter('ㄅㄛ ㄖㄜˇ');
    ctx.scheduleFileTreeFilterLog('ㄅㄛ ㄖㄜˇ');
    assert.equal(pendingTimer, null, '純注音符號不得啟動日誌計時器');

    // 3. 選字完成先輸出「般」，但馬上在去抖時間內繼續打「般若」
    ctx.applyFileTreeFilter('般');
    state._lastFileTreeFilterMatches = 42;
    ctx.scheduleFileTreeFilterLog('般');
    assert.ok(pendingTimer, '輸出國字後應啟動去抖計時器');
    assert.ok(pendingTimer.delay >= 1000, '靜止去抖時間應 >= 1000ms 以容納連續打字');
    const firstTimer = pendingTimer;

    // 繼續輸入第二個字「般若」，前一個計時器應被取消重置
    ctx.applyFileTreeFilter('般若');
    state._lastFileTreeFilterMatches = 12;
    ctx.scheduleFileTreeFilterLog('般若');
    assert.notEqual(pendingTimer, firstTimer, '新輸入應重置去抖計時器');
    assert.equal(sentEvents.length, 0, '去抖時間未到前不得發送任何請求');

    // 4. 靜止時間到：觸發計時器，應只送出最終的「般若」
    pendingTimer.fn();
    assert.equal(sentEvents.length, 1);
    assert.deepEqual(sentEvents[0], {
      url: '/api/tree-filter-event',
      body: { query: '般若', matches: 12 },
    });

    // 5. 相同字串再次觸發不應重複記錄
    ctx.scheduleFileTreeFilterLog('般若');
    if (pendingTimer) pendingTimer.fn();
    assert.equal(sentEvents.length, 1, '相同篩選詞不得重複發送日誌');

    // 6. 清空輸入框應取消待發計時器並重置去重狀態
    ctx.applyFileTreeFilter('唯識');
    state._lastFileTreeFilterMatches = 8;
    ctx.scheduleFileTreeFilterLog('唯識');
    assert.ok(pendingTimer);
    ctx.applyFileTreeFilter('');
    assert.equal(pendingTimer, null, '清空篩選時應取消尚未觸發的日誌計時器');
    assert.equal(sentEvents.length, 1, '清空動作本身不應發送日誌');
  });

  test('後端 handleTreeFilterEvent 寫入 Search 日誌並納入 Analytics 搜尋統計', async () => {
    assert.match(serverSrc, /pathname === '\/api\/tree-filter-event' && req\.method === 'POST'/);
    assert.match(serverSrc, /function handleTreeFilterEvent\(/);

    const { updateAnalyticsStoreEntry } = require('../lib/analytics.js');

    const logged = [];
    let response = null;
    const searchMetrics = { totalQueries: 0 };

    const ctx = {
      searchMetrics,
      readJSONBody: async (req) => req._body || {},
      sendJSON: (_res, status, payload) => { response = { status, payload }; },
      Logger: {
        info(tag, message, _req, extra) {
          logged.push({
            id: 'evt-1',
            timestamp: '2026-10-28T00:00:00.000Z',
            level: 'INFO',
            tag,
            ip: '127.0.0.1',
            message,
            ...(extra || {}),
          });
        },
      },
    };
    vm.createContext(ctx);
    vm.runInContext('async ' + extractFunction(serverSrc, 'handleTreeFilterEvent'), ctx);

    // 空白查詢應回 400 且不寫入日誌
    await ctx.handleTreeFilterEvent({ _body: { query: '   ' } }, {});
    assert.equal(response.status, 400);
    assert.equal(logged.length, 0);

    // 有效篩選事件應回 200、寫入 Search 日誌並累加 Analytics 搜尋統計
    await ctx.handleTreeFilterEvent({ _body: { query: '瑜伽師地論', matches: 5 } }, {});
    assert.equal(response.status, 200);
    assert.equal(searchMetrics.totalQueries, 1);
    assert.equal(logged.length, 1);
    assert.equal(logged[0].tag, 'Search');
    assert.equal(logged[0].query, '瑜伽師地論');
    assert.match(logged[0].message, /\[tree-filter\] Query: "瑜伽師地論" -> 5 matches/);

    const store = {
      version: 3,
      updatedAt: new Date(0).toISOString(),
      lifetime: {
        requests: 0, views: 0, searchCount: 0, ips: {}, files: {}, searches: {},
        dictSearchCount: 0, dictLookupCount: 0, dictBrowseCount: 0,
        dictSearches: {}, dictLookups: {},
      },
      daily: {},
      processedIds: {},
    };
    updateAnalyticsStoreEntry(store, logged[0]);
    assert.equal(store.lifetime.searchCount, 1, '應計入總搜尋次數');
    assert.equal(store.lifetime.searches['瑜伽師地論'].count, 1, '應計入熱門搜尋關鍵字');
  });
});

