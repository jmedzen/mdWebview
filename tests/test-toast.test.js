const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const APP = path.join(ROOT_DIR, 'app.js');
const CSS = path.join(ROOT_DIR, 'style.css');
const HTML = path.join(ROOT_DIR, 'index.html');

// ═══════════════════════════════════════════════════════════════════
// Toast 核心邏輯擷取器
// app.js 是巨大的 IIFE，showToast / dismissToast 並未 export，因此改為把
// §16 TOAST NOTIFICATIONS 區段「原文擷取」後在沙箱中求值，搭配一個極簡的
// 假 DOM 與可控計時器。這樣測到的是真正的函式行為（duration、dedup、aria、
// eviction），而不是原始碼字串比對。
// ═══════════════════════════════════════════════════════════════════

function makeElement(tagName) {
  const el = {
    tagName: String(tagName).toUpperCase(),
    parentNode: null,
    childNodes: [],
    attributes: new Map(),
    textContent: '',
    _classes: new Set(),
    appendChild(child) {
      child.parentNode = el;
      el.childNodes.push(child);
      return child;
    },
    remove() {
      if (el.parentNode) {
        const i = el.parentNode.childNodes.indexOf(el);
        if (i >= 0) el.parentNode.childNodes.splice(i, 1);
      }
      el.parentNode = null;
    },
    setAttribute(k, v) { el.attributes.set(k, String(v)); },
    getAttribute(k) { return el.attributes.has(k) ? el.attributes.get(k) : null; },
    querySelectorAll(selector) {
      assert.equal(selector, '.toast-notification');
      const out = [];
      (function walk(nodes) {
        for (const n of nodes) {
          if (n._classes.has('toast-notification')) out.push(n);
          walk(n.childNodes);
        }
      })(el.childNodes);
      return out;
    },
  };
  Object.defineProperty(el, 'className', {
    get() { return Array.from(el._classes).join(' '); },
    set(v) { el._classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
  });
  el.classList = {
    add(...cs) { cs.forEach(c => el._classes.add(c)); },
    remove(...cs) { cs.forEach(c => el._classes.delete(c)); },
    contains(c) { return el._classes.has(c); },
    toggle(c, force) {
      const on = force === undefined ? !el._classes.has(c) : !!force;
      if (on) el._classes.add(c); else el._classes.delete(c);
      return on;
    },
  };
  return el;
}

// 產生假 DOM + 可手動推進的計時器；讓持久型與自動消失路徑都能被確定性驗證。
function createFakeDom() {
  const timers = new Map();
  let nextId = 0;
  const container = makeElement('div');
  const document_ = {
    createElement: (tag) => makeElement(tag),
    getElementById: (id) => (id === 'toastContainer' ? container : null),
  };
  return {
    container,
    document: document_,
    $: (id) => document_.getElementById(id),
    setTimeout: (fn, ms) => { const id = ++nextId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    requestAnimationFrame: () => 0,
    timers,
    // 觸發所有剩餘計時器（依註冊順序）。
    fireAll() {
      for (const [id, t] of Array.from(timers.entries())) { timers.delete(id); t.fn(); }
    },
  };
}

function makeToastModule() {
  const src = fs.readFileSync(APP, 'utf8');
  const start = src.indexOf('const TOAST_ICONS = {');
  const end = src.indexOf('// §17 BOOKMARKS');
  assert.ok(start > 0, 'app.js 必須存在 TOAST_ICONS 區段');
  assert.ok(end > start, 'app.js 必須存在 §17 BOOKMARKS 區段標記');
  const body = src.slice(start, end);

  const dom = createFakeDom();
  const factory = new Function(
    '$', 'document', 'requestAnimationFrame', 'setTimeout', 'clearTimeout',
    `${body}
    return { showToast, dismissToast, TOAST_ICONS, TOAST_ERROR_MIN_MS, TOAST_MAX_VISIBLE, TOAST_HAS_ICON_RE };`
  );
  const api = factory(dom.$, dom.document, dom.requestAnimationFrame, dom.setTimeout, dom.clearTimeout);
  return { api, dom };
}

// filterLogEntries 是純函式（只依賴傳入參數），可原文擷取後直接行為測試。
function makeFilterLogEntries() {
  const src = fs.readFileSync(APP, 'utf8');
  const start = src.indexOf('function filterLogEntries(');
  const end = src.indexOf('// Timezone Formatting Helper');
  assert.ok(start > 0 && end > start, 'app.js 必須存在 filterLogEntries 區段');
  const body = src.slice(start, end);
  return new Function(`${body}\nreturn filterLogEntries;`)();
}

// 取得 showToast 呼叫的「來源字面」片段，用於檢查型別與訊息一致性。
function toastCallSites() {
  const src = fs.readFileSync(APP, 'utf8');
  return src;
}

// ═══════════════════════════════════════════════════════════════════
describe('Toast 核心行為 (showToast/dismissToast 擷取後真實執行)', () => {
  test('T1：error 型別未指定 duration 時套用 4000ms 下限', () => {
    const { api, dom } = makeToastModule();
    api.showToast('boom', 'error');
    const durations = Array.from(dom.timers.values()).map(t => t.ms);
    assert.deepEqual(durations, [4000], 'error 預設應為 4000ms 而非 2200ms');
  });

  test('T1：error 明確指定的較短值會被墊高，較長值保留', () => {
    const { api, dom } = makeToastModule();
    api.showToast('a', 'error', 3500);
    assert.equal(Array.from(dom.timers.values())[0].ms, 4000, '3500 應被墊高至 4000');
    dom.timers.clear();

    api.showToast('b', 'error', 9000);
    assert.equal(Array.from(dom.timers.values())[0].ms, 9000, '較長的明確值不得被縮短');
  });

  test('T1：error duration 0/Infinity 仍為持久型，不建立計時器', () => {
    const { api, dom } = makeToastModule();
    api.showToast('p1', 'error', 0);
    api.showToast('p2', 'error', Infinity);
    assert.equal(dom.timers.size, 0, '持久型 error 不應排程自動消失');
    assert.equal(dom.container.childNodes.length, 2);
  });

  test('T1：其他型別的 duration 語意不變 (info 2200 / 明確 3000)', () => {
    const { api, dom } = makeToastModule();
    api.showToast('i', 'info');
    assert.equal(Array.from(dom.timers.values())[0].ms, 2200);
    dom.timers.clear();
    api.showToast('s', 'success', 3000);
    assert.equal(Array.from(dom.timers.values())[0].ms, 3000);
    dom.timers.clear();
    api.showToast('w', 'warning');
    assert.equal(Array.from(dom.timers.values())[0].ms, 2200);
  });

  test('T8：相同 type + 相同文字只保留一個節點，並重置其計時器', () => {
    const { api, dom } = makeToastModule();
    const first = api.showToast('內容片段載入失敗，請重試', 'error');
    const second = api.showToast('內容片段載入失敗，請重試', 'error');

    assert.equal(dom.container.childNodes.length, 1, '完全相同的 Toast 不得重複堆疊');
    assert.equal(first.el, second.el, 'dedup 應回傳既有節點與 handle');
    assert.equal(dom.timers.size, 1, '舊計時器應被清除，只留重置後的一個');
  });

  test('T8：文字不同或 type 不同時不視為重複', () => {
    const { api, dom } = makeToastModule();
    api.showToast('失敗 A', 'error');
    api.showToast('失敗 B', 'error');
    api.showToast('失敗 A', 'warning');
    assert.equal(dom.container.childNodes.length, 3, '不同訊息/型別必須各自保留');
  });

  test('T8：訊息自動消失後，相同訊息可再次顯示（無殘留、無洩漏）', () => {
    const { api, dom } = makeToastModule();
    api.showToast('重複訊息', 'error');
    dom.fireAll(); // 觸發 dismissToast -> add hide -> 排程移除
    dom.fireAll(); // 執行移除 timer
    assert.equal(dom.container.childNodes.length, 0, '節點應已自 DOM 移除');

    api.showToast('重複訊息', 'error');
    assert.equal(dom.container.childNodes.length, 1, '已消失的訊息可重新顯示');
  });

  test('T8：TOAST_MAX_VISIBLE 上限驅逐邏輯仍然正確', () => {
    const { api, dom } = makeToastModule();
    for (let i = 0; i < 5; i++) api.showToast(`訊息 ${i}`, 'info');
    const live = dom.container.querySelectorAll('.toast-notification');
    assert.ok(live.length <= 3, `可見 Toast 不得超過 ${3} 個，實際 ${live.length}`);
  });

  test('T9：error Toast 標記 role="alert"，其他型別不標記', () => {
    const { api } = makeToastModule();
    const err = api.showToast('壞了', 'error');
    assert.equal(err.el.getAttribute('role'), 'alert');
    const info = api.showToast('好的', 'info');
    assert.equal(info.el.getAttribute('role'), null, 'info 不應帶 role=alert');
    const warn = api.showToast('注意', 'warning');
    assert.equal(warn.el.getAttribute('role'), null);
  });

  test('T9/T7：自動圖示只會有一個前置字符，手寫 emoji 不重複', () => {
    const { api } = makeToastModule();
    const plain = api.showToast('已新增至書籤', 'success');
    assert.equal(plain.el.textContent, '✅ 已新增至書籤', '未帶 emoji 時補上型別圖示');

    const withEmoji = api.showToast('🗑️ 已從書籤移除', 'success');
    assert.equal(withEmoji.el.textContent, '🗑️ 已從書籤移除', '已帶 emoji 時不得再前置');

    const dingbat = api.showToast('✓ 已複製第 3 行分享連結', 'success');
    assert.equal(dingbat.el.textContent, '✓ 已複製第 3 行分享連結', '✓ 等 dingbat 不應再補圖示');
  });

  test('T3：內容片段失敗 Toast 不再手寫 ⚠️，改由 error 圖示呈現', () => {
    const { api } = makeToastModule();
    const t = api.showToast('內容片段載入失敗，請重試', 'error');
    assert.equal(t.el.textContent, '❌ 內容片段載入失敗，請重試');
    assert.ok(!t.el.textContent.includes('⚠️'), '不得同時出現 ⚠️ 與 ❌');
  });

  test('T2：新增 .toast-info 樣式，四種型別樣式齊備', () => {
    const css = fs.readFileSync(CSS, 'utf8');
    assert.match(css, /\.toast-notification\.toast-info\s*\{/, 'style.css 必須定義 .toast-info');
    for (const t of ['success', 'warning', 'error', 'loading']) {
      assert.match(
        css,
        new RegExp(`\\.toast-notification\\.toast-${t}\\s*\\{`),
        `style.css 必須定義 .toast-${t}`
      );
    }
  });

  test('T2：每個型別（含 info）都掛上自己的 class，樣式規則才是唯一來源', () => {
    const { api } = makeToastModule();
    for (const type of ['info', 'success', 'warning', 'error', 'loading']) {
      const t = api.showToast(`訊息-${type}`, type, 0);
      assert.ok(
        t.el.classList.contains(`toast-${type}`),
        `${type} Toast 應帶 toast-${type} class`
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('Toast 無障礙語意 (index.html 來源契約)', () => {
  test('T9：#toastContainer 具備 role=status / aria-live=polite / aria-atomic', () => {
    const html = fs.readFileSync(HTML, 'utf8');
    const tag = html.match(/<div id="toastContainer"[^>]*>/);
    assert.ok(tag, 'index.html 必須存在 #toastContainer');
    assert.match(tag[0], /role="status"/);
    assert.match(tag[0], /aria-live="polite"/);
    assert.match(tag[0], /aria-atomic="true"/);
  });

  test('T9：容器仍維持 pointer-events: none，未破壞點擊穿透', () => {
    const css = fs.readFileSync(CSS, 'utf8');
    const block = css.match(/\.toast-container\s*\{[^}]*\}/);
    assert.ok(block);
    assert.match(block[0], /pointer-events:\s*none/);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('Toast 訊息/型別一致性 (app.js 來源契約)', () => {
  test('T2：書籤與歷史紀錄 Toast 明確宣告型別', () => {
    const src = toastCallSites();
    assert.match(src, /showToast\('🗑️ 已從書籤移除', 'success'\)/);
    assert.match(src, /showToast\('🗑️ 已清除所有書籤', 'success'\)/);
    assert.match(src, /showToast\('🗑️ 已成功清除所有閱讀紀錄', 'success'\)/);
    assert.match(src, /showToast\('⚠️ 請先開啟一本經文檔案', 'warning'\)/);
    assert.doesNotMatch(src, /showToast\('🗑️ 已移除書籤'\)/, '應統一為「已從書籤移除」');
  });

  test('T7：書籤新增採單一語彙且不手寫型別圖示', () => {
    const src = toastCallSites();
    assert.match(src, /showToast\('已新增至書籤', 'success'\)/);
    assert.doesNotMatch(src, /已新增至書籤與最愛/);
    assert.doesNotMatch(src, /🔖 已新增至書籤/);
  });

  test('T3：日誌下載的 warning 型別修正', () => {
    const src = toastCallSites();
    assert.match(src, /showToast\('⚠️ 目前無可下載的日誌', 'warning'\)/);
    assert.doesNotMatch(src, /showToast\('⚠️ 目前無可下載的日誌', 'info'\)/);
  });

  test('T4：三處複製成功回饋一致為 success', () => {
    const src = toastCallSites();
    // 行分享連結（事件委派 + fallback 兩處）
    const lineCopies = src.match(/showToast\(`✓ 已複製第 \$\{lineNum\} 行分享連結`, 'success'\)/g) || [];
    assert.equal(lineCopies.length, 2, '兩處行分享連結 Toast 皆須為 success');
    // 分享彈窗路徑原本完全沒有 Toast，補上後與其他兩處一致
    assert.match(src, /showToast\(`✓ 已複製第 \$\{shareLineNum\} 行分享連結`, 'success'\)/);
    // 經文連結複製已為 success
    assert.match(src, /showToast\('🔗 已複製經文連結至剪貼簿', 'success'\)/);
  });

  test('T5：索引重建改用持久型 loading Toast，且所有結束路徑皆 dismiss', () => {
    const src = toastCallSites();
    assert.match(src, /showToast\('全文索引重建中…', 'loading', 0\)/);
    assert.match(src, /showToast\('辭典索引重建中…', 'loading', 0\)/);
    assert.doesNotMatch(src, /已觸發全文索引重建，後台建置中/, '舊的假進度 Toast 應移除');
    assert.doesNotMatch(src, /已觸發辭典索引重建，後台建置中/);
    // 完成、請求失敗、輪詢失敗、關閉面板四條路徑都必須收掉。
    assert.match(src, /dismissIndexRebuildToast\(\);[\s\S]{0,200}showToast\('✅ 全文索引重建完成！'/);
    assert.match(src, /dismissDictIndexRebuildToast\(\);[\s\S]{0,200}showToast\('✅ 辭典索引重建完成！'/);
    assert.match(src, /dismissIndexRebuildToast\(\);\n\s*dismissDictIndexRebuildToast\(\);/);
    // 輪詢非 OK 與 catch 都必須停止輪詢並清理
    assert.match(src, /重建狀態查詢失敗/);
  });

  test('T6：新增的失敗回饋 Toast（openFile / 搜尋 / 目錄 / 推薦設定 / 辭典）', () => {
    const src = toastCallSites();
    assert.match(src, /showToast\('經文載入失敗：' \+ err\.message, 'error'\)/);
    assert.match(src, /showToast\('搜尋失敗：' \+ err\.message, 'error'\)/);
    assert.match(src, /showToast\('檔案目錄載入失敗，請重新整理', 'error'\)/);
    assert.match(src, /showToast\('推薦閱讀設定儲存失敗：' \+ err\.message, 'error'\)/);
    const dictFails = src.match(/showToast\('辭典搜尋失敗', 'error'\)/g) || [];
    assert.equal(dictFails.length, 2, '辭典首頁與下一頁失敗皆須提示');
  });

  test('T7：頁面搜尋無結果訊息統一，且不手寫 🔍', () => {
    const src = toastCallSites();
    const matches = src.match(/showToast\(`未找到符合「\$\{(?:q|query)\}」的內容`, 'warning'\)/g) || [];
    assert.equal(matches.length, 2, '兩處頁面搜尋無結果應統一');
    assert.doesNotMatch(src, /🔍 未找到符合/);
  });

  test('T7：失敗訊息採全形冒號，成功訊息無多餘句號', () => {
    const src = toastCallSites();
    assert.doesNotMatch(src, /showToast\('❌ [^']*失敗: '/, '失敗訊息不得使用半形冒號');
    assert.match(src, /showToast\('❌ 更新密碼失敗：' \+ err\.message, 'error'\)/);
    assert.match(src, /showToast\('❌ 匯出備份失敗：' \+ err\.message, 'error'\)/);
    assert.match(src, /showToast\('❌ 還原失敗：' \+ err\.message, 'error'\)/);
    assert.match(src, /showToast\('❌ 清空快取失敗：' \+ err\.message, 'error'\)/);
    assert.match(src, /showToast\('❌ 儲存失敗：' \+ err\.message, 'error'\)/);
    assert.doesNotMatch(src, /已登出其他裝置。'/, '完成訊息不應有結尾句號');
  });

  test('T7：索引重建失敗不將英文 statusText 直接寫入中文介面', () => {
    const src = toastCallSites();
    assert.doesNotMatch(src, /errData\.error \|\| res\.statusText/);
    const httpFallbacks = src.match(/errData\.error \|\| `HTTP \$\{res\.status\}`/g) || [];
    assert.equal(httpFallbacks.length, 2, '兩個索引重建失敗路徑皆改用 HTTP <status>');
  });

  test('T7：移除推薦清單中冗餘的 ℹ️（由 info 型別圖示補上）', () => {
    const src = toastCallSites();
    assert.doesNotMatch(src, /showToast\(`ℹ️「/);
    assert.match(src, /showToast\(`「\$\{filePath\}」已在推薦清單中`, 'info'\)/);
  });

  test('T3：不存在「手寫 ⚠️ 卻宣告 error」的誤導性矛盾（抽樣核心站點）', () => {
    const src = toastCallSites();
    assert.doesNotMatch(src, /showToast\('⚠️ 內容片段載入失敗，請重試', 'error'\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('T10 用戶端日誌分類 filterLogEntries（純函式真實執行）', () => {
  const filter = makeFilterLogEntries();

  const entries = [
    { timestamp: 't', level: 'INFO', tag: 'Auth', message: '管理員登入成功', ip: '1.1.1.1' },
    { timestamp: 't', level: 'WARN', tag: 'Auth', message: '登入失敗：密碼錯誤', ip: '1.1.1.1' },
    { timestamp: 't', level: 'INFO', tag: 'Config', message: '系統設定已更新', ip: '1.1.1.1' },
    { timestamp: 't', level: 'INFO', tag: 'HTTP', message: 'GET /api/tree 200', ip: '1.1.1.1' },
    { timestamp: 't', level: 'INFO', tag: 'SEARCH', message: 'query 一切', ip: '1.1.1.1' },
    { timestamp: 't', level: 'INFO', tag: 'RENDER', message: 'rendered file', ip: '1.1.1.1' },
    { timestamp: 't', level: 'INFO', tag: 'BOT', message: 'crawler visit', ip: '1.1.1.1' },
    { timestamp: 't', level: 'INFO', tag: 'SYS', message: '啟動完成', ip: '1.1.1.1' },
  ];

  test('Auth 標籤可由既有的 error（安全）分類觸及', () => {
    const out = filter(entries, '', 'error').map(e => e.message);
    assert.ok(out.includes('管理員登入成功'), 'Auth 事件應可從 error 分類檢視');
    assert.ok(out.includes('登入失敗：密碼錯誤'));
    assert.ok(!out.includes('啟動完成'), '非錯誤事件不應誤入 error');
  });

  test('新增 security 分類可同時取得 Auth 與 Config 事件', () => {
    const out = filter(entries, '', 'security').map(e => e.tag);
    assert.deepEqual([...new Set(out)].sort(), ['Auth', 'Config']);
  });

  test('security 分類不影響既有分類語意', () => {
    assert.deepEqual(filter(entries, '', 'http').map(e => e.tag), ['HTTP']);
    assert.deepEqual(filter(entries, '', 'search').map(e => e.tag), ['SEARCH']);
    assert.deepEqual(filter(entries, '', 'render').map(e => e.tag), ['RENDER']);
    assert.deepEqual(filter(entries, '', 'bot').map(e => e.tag), ['BOT']);
    assert.equal(filter(entries, '', 'all').length, entries.length, 'all 應回傳全部');
  });

  test('分類過濾仍可與關鍵字過濾疊加', () => {
    const out = filter(entries, '登入', 'security').map(e => e.message);
    assert.deepEqual(out, ['管理員登入成功', '登入失敗：密碼錯誤']);
  });

  test('T10：index.html 提供 security 分類按鈕且事件處理器可端到端解析', () => {
    const html = fs.readFileSync(HTML, 'utf8');
    assert.match(html, /data-cat="security"[\s\S]{0,40}認證／設定/);
    const src = fs.readFileSync(APP, 'utf8');
    assert.match(
      src,
      /stateAdminLogCategory\s*=\s*e\.currentTarget\.getAttribute\('data-cat'\) \|\| 'all'/,
      '分類切換需從 data-cat 讀取，新增按鈕才會生效'
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('T5 持久型 Toast 生命週期（handle 真實行為）', () => {
  test('loading 0 建立的 handle 呼叫 dismiss 後收合並自 DOM 移除', () => {
    const { api, dom } = makeToastModule();
    const h = api.showToast('全文索引重建中…', 'loading', 0);
    assert.equal(dom.container.childNodes.length, 1);
    assert.equal(dom.timers.size, 0, '持久型不應有自動消失計時器');
    h.dismiss();
    assert.ok(h.el.classList.contains('hide'), 'dismiss 應先觸發淡出 class');
    dom.fireAll(); // 執行 TOAST_HIDE_MS 後的移除
    assert.equal(dom.container.childNodes.length, 0, '淡出後節點應從 DOM 移除');
  });

  test('重複觸發相同 loading Toast 只會有一個，dismiss 全部收掉且不殘留', () => {
    const { api, dom } = makeToastModule();
    const a = api.showToast('全文索引重建中…', 'loading', 0);
    const b = api.showToast('全文索引重建中…', 'loading', 0);
    assert.equal(a.el, b.el);
    assert.equal(dom.container.childNodes.length, 1);
    b.dismiss();
    dom.fireAll();
    assert.equal(dom.container.childNodes.length, 0);
    assert.equal(dom.timers.size, 0, '不應留下孤兒計時器');
  });
});
