/**
 * 前端「新版本偵測」（app.js §16.4）。
 *
 * 長時間開著的分頁／手機 PWA 不會重新載入 index.html，因此拿不到新程式。
 * 前端把頁面載入時的資源指紋（__APP_CONFIG__.assetVersion）定期與 /api/version 比對，
 * 不同就顯示常駐橫幅，由使用者決定何時重新載入。
 *
 * app.js 是一支巨大的 IIFE，這些函式沒有 export，所以沿用 test-toast 的作法：
 * 把該區段「原文擷取」後在假 DOM / 假 fetch 的沙箱裡真的執行。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT_DIR, 'app.js'), 'utf8');
const CSS_SRC = fs.readFileSync(path.join(ROOT_DIR, 'style.css'), 'utf8');

function sectionSource() {
  const start = APP_SRC.indexOf('const UPDATE_CHECK_MIN_GAP_MS');
  const end = APP_SRC.indexOf('// §16.5 PWA 安裝引導');
  assert.ok(start > 0, 'app.js 必須存在 UPDATE_CHECK_MIN_GAP_MS（§16.4 新版本偵測）');
  assert.ok(end > start, 'app.js 必須存在 §16.5 區段標記');
  return APP_SRC.slice(start, end);
}

function makeElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    className: '',
    textContent: '',
    type: '',
    children: [],
    attrs: {},
    listeners: {},
    parentNode: null,
    setAttribute(k, v) { el.attrs[k] = String(v); },
    addEventListener(type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn); },
    append(...kids) { kids.forEach(k => { k.parentNode = el; el.children.push(k); }); },
    appendChild(k) { k.parentNode = el; el.children.push(k); return k; },
    removeChild(k) { el.children = el.children.filter(c => c !== k); k.parentNode = null; return k; },
    click() { (el.listeners.click || []).forEach(fn => fn({ type: 'click' })); },
  };
  return el;
}

/**
 * @param {object} o
 * @param {string} [o.assetVersion] 此頁載入時的指紋；省略代表舊伺服器（沒有該欄位）
 * @param {boolean} [o.online=true]
 * @param {(url:string, init:object)=>Promise<any>} [o.fetchImpl]
 */
function makeWatcher(o = {}) {
  const body = makeElement('body');
  const docListeners = {};
  const winListeners = {};
  const intervals = [];
  const fetchCalls = [];
  let reloads = 0;
  let nowMs = 1_000_000;

  const document = {
    body,
    visibilityState: 'visible',
    createElement: makeElement,
    addEventListener(t, fn) { (docListeners[t] = docListeners[t] || []).push(fn); },
  };
  const window = {
    __APP_CONFIG__: o.assetVersion === undefined ? {} : { assetVersion: o.assetVersion },
    location: { reload() { reloads++; } },
    addEventListener(t, fn) { (winListeners[t] = winListeners[t] || []).push(fn); },
  };
  const navigator = { onLine: o.online !== false };
  const fetch = async (url, init) => {
    fetchCalls.push({ url, init });
    return o.fetchImpl ? o.fetchImpl(url, init) : { ok: true, json: async () => ({ assetVersion: o.assetVersion }) };
  };
  const setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };
  const DateShim = { now: () => nowMs };

  const factory = new Function(
    'window', 'document', 'navigator', 'fetch', 'setInterval', 'Date',
    `${sectionSource()}
    return { checkForNewVersion, announceNewVersion, initUpdateWatcher, loadedAssetVersion,
             reloadForNewVersion, dismissUpdateBanner,
             UPDATE_CHECK_MIN_GAP_MS, UPDATE_CHECK_INTERVAL_MS };`
  );
  const api = factory(window, document, navigator, fetch, setInterval, DateShim);

  const banners = () => body.children.filter(c => c.className === 'update-banner');
  return {
    api, body, document, window, navigator, fetchCalls, intervals, docListeners, winListeners, banners,
    reloads: () => reloads,
    advance(ms) { nowMs += ms; },
  };
}

const respond = (assetVersion) => async () => ({ ok: true, json: async () => ({ version: '1.0.0', assetVersion }) });

describe('新版本偵測：checkForNewVersion', () => {
  test('指紋相同 → 不顯示橫幅', async () => {
    const w = makeWatcher({ assetVersion: '1.0.0-aaaaaaaaaa', fetchImpl: respond('1.0.0-aaaaaaaaaa') });
    assert.equal(await w.api.checkForNewVersion(true), false);
    assert.equal(w.banners().length, 0);
    assert.equal(w.fetchCalls.length, 1);
    assert.equal(w.fetchCalls[0].url, '/api/version');
    assert.equal(w.fetchCalls[0].init.cache, 'no-store', '版本檢查本身不可被快取');
  });

  test('指紋不同 → 顯示一個橫幅，含「重新載入」與「稍後」按鈕，重複偵測不會疊第二個', async () => {
    const w = makeWatcher({ assetVersion: '1.0.0-aaaaaaaaaa', fetchImpl: respond('1.0.0-bbbbbbbbbb') });
    assert.equal(await w.api.checkForNewVersion(true), true);
    assert.equal(await w.api.checkForNewVersion(true), true);
    const banners = w.banners();
    assert.equal(banners.length, 1);
    assert.equal(banners[0].attrs.role, 'status');
    const buttons = banners[0].children.filter(c => c.tagName === 'BUTTON');
    assert.deepEqual(buttons.map(b => b.textContent), ['重新載入', '稍後']);
    assert.ok(buttons.every(b => b.type === 'button'), '按鈕不可是 submit');
    assert.match(banners[0].children[0].textContent, /新版本/);
  });

  test('按「重新載入」→ 重新整理頁面', async () => {
    const w = makeWatcher({ assetVersion: '1.0.0-aaaaaaaaaa', fetchImpl: respond('1.0.0-bbbbbbbbbb') });
    await w.api.checkForNewVersion(true);
    const reload = w.banners()[0].children.find(c => c.textContent === '重新載入');
    assert.equal(w.reloads(), 0);
    reload.click();
    assert.equal(w.reloads(), 1);
  });

  test('按「稍後」→ 橫幅消失；同一版不再煩使用者，再出新版才再提示', async () => {
    let server = '1.0.0-bbbbbbbbbb';
    const w = makeWatcher({ assetVersion: '1.0.0-aaaaaaaaaa', fetchImpl: async () => ({ ok: true, json: async () => ({ assetVersion: server }) }) });
    await w.api.checkForNewVersion(true);
    w.banners()[0].children.find(c => c.textContent === '稍後').click();
    assert.equal(w.banners().length, 0);

    await w.api.checkForNewVersion(true);
    assert.equal(w.banners().length, 0, '同一個新版不重複提示');

    server = '1.0.0-cccccccccc';
    await w.api.checkForNewVersion(true);
    assert.equal(w.banners().length, 1, '又出了更新的版本，應再次提示');
  });

  test('兩次檢查至少相隔 60 秒；force 可略過', async () => {
    const w = makeWatcher({ assetVersion: '1.0.0-aaaaaaaaaa', fetchImpl: respond('1.0.0-aaaaaaaaaa') });
    await w.api.checkForNewVersion(false);
    await w.api.checkForNewVersion(false);
    assert.equal(w.fetchCalls.length, 1, '間隔內不重複打 API');
    w.advance(w.api.UPDATE_CHECK_MIN_GAP_MS - 1);
    await w.api.checkForNewVersion(false);
    assert.equal(w.fetchCalls.length, 1);
    w.advance(2);
    await w.api.checkForNewVersion(false);
    assert.equal(w.fetchCalls.length, 2);
    await w.api.checkForNewVersion(true);
    assert.equal(w.fetchCalls.length, 3, 'force 略過最短間隔');
  });

  test('舊伺服器（頁面沒有 assetVersion）→ 整個功能停用，不打 API', async () => {
    const w = makeWatcher({});
    assert.equal(w.api.loadedAssetVersion(), '');
    assert.equal(await w.api.checkForNewVersion(true), false);
    assert.equal(w.fetchCalls.length, 0);
    w.api.initUpdateWatcher();
    assert.equal(Object.keys(w.docListeners).length + Object.keys(w.winListeners).length + w.intervals.length, 0);
  });

  test('離線 → 不打 API、不顯示橫幅', async () => {
    const w = makeWatcher({ assetVersion: '1.0.0-aaaaaaaaaa', online: false, fetchImpl: respond('1.0.0-bbbbbbbbbb') });
    assert.equal(await w.api.checkForNewVersion(true), false);
    assert.equal(w.fetchCalls.length, 0);
    assert.equal(w.banners().length, 0);
  });

  test('API 失敗（網路錯誤、非 200、非 JSON、缺欄位）一律靜默略過', async () => {
    const cases = {
      網路錯誤: async () => { throw new Error('network down'); },
      非200: async () => ({ ok: false, json: async () => ({ assetVersion: '1.0.0-bbbbbbbbbb' }) }),
      非JSON: async () => ({ ok: true, json: async () => { throw new SyntaxError('not json'); } }),
      缺欄位: async () => ({ ok: true, json: async () => ({ version: '1.0.0' }) }),
      空字串: async () => ({ ok: true, json: async () => ({ assetVersion: '' }) }),
      型別錯誤: async () => ({ ok: true, json: async () => ({ assetVersion: 42 }) }),
    };
    for (const [name, fetchImpl] of Object.entries(cases)) {
      const w = makeWatcher({ assetVersion: '1.0.0-aaaaaaaaaa', fetchImpl });
      assert.equal(await w.api.checkForNewVersion(true), false, name);
      assert.equal(w.banners().length, 0, `${name}：不得顯示橫幅`);
    }
  });
});

describe('新版本偵測：initUpdateWatcher 的觸發時機', () => {
  const newVersionFetch = respond('1.0.0-bbbbbbbbbb');

  test('分頁回到前景時檢查；在背景時不檢查', async () => {
    const w = makeWatcher({ assetVersion: '1.0.0-aaaaaaaaaa', fetchImpl: newVersionFetch });
    w.api.initUpdateWatcher();
    const [onVisibility] = w.docListeners.visibilitychange;

    w.document.visibilityState = 'hidden';
    onVisibility();
    await Promise.resolve();
    assert.equal(w.fetchCalls.length, 0);

    w.document.visibilityState = 'visible';
    onVisibility();
    await new Promise(r => setImmediate(r));
    assert.equal(w.fetchCalls.length, 1);
    assert.equal(w.banners().length, 1);
  });

  test('網路恢復（online）立即檢查，不受最短間隔限制', async () => {
    const w = makeWatcher({ assetVersion: '1.0.0-aaaaaaaaaa', fetchImpl: respond('1.0.0-aaaaaaaaaa') });
    w.api.initUpdateWatcher();
    await w.api.checkForNewVersion(false);
    assert.equal(w.fetchCalls.length, 1);
    w.winListeners.online[0]();
    await new Promise(r => setImmediate(r));
    assert.equal(w.fetchCalls.length, 2);
  });

  test('bfcache 還原（pageshow.persisted）才檢查，一般載入不重複檢查', async () => {
    const w = makeWatcher({ assetVersion: '1.0.0-aaaaaaaaaa', fetchImpl: respond('1.0.0-aaaaaaaaaa') });
    w.api.initUpdateWatcher();
    const [onPageShow] = w.winListeners.pageshow;
    onPageShow({ persisted: false });
    await new Promise(r => setImmediate(r));
    assert.equal(w.fetchCalls.length, 0);
    onPageShow({ persisted: true });
    await new Promise(r => setImmediate(r));
    assert.equal(w.fetchCalls.length, 1);
  });

  test('分頁一直停在前景時每 15 分鐘輪詢；在背景時跳過', async () => {
    const w = makeWatcher({ assetVersion: '1.0.0-aaaaaaaaaa', fetchImpl: newVersionFetch });
    w.api.initUpdateWatcher();
    assert.equal(w.intervals.length, 1);
    assert.equal(w.intervals[0].ms, 15 * 60 * 1000);

    w.document.visibilityState = 'hidden';
    w.intervals[0].fn();
    await new Promise(r => setImmediate(r));
    assert.equal(w.fetchCalls.length, 0);

    w.document.visibilityState = 'visible';
    w.intervals[0].fn();
    await new Promise(r => setImmediate(r));
    assert.equal(w.fetchCalls.length, 1);
  });
});

describe('新版本偵測：與 Service Worker、Worker、樣式的接線（原始碼檢查）', () => {
  test('SW 發現更新時不直接跳橫幅，而是向伺服器比對（避免剛更新完又叫人更新）', () => {
    const m = APP_SRC.match(/newWorker\.state === 'installed' && navigator\.serviceWorker\.controller\) \{([\s\S]*?)\n\s*\}\n/);
    assert.ok(m, '應存在 SW installed 的處理區塊');
    assert.ok(m[1].includes('checkForNewVersion(true)'));
    assert.ok(!m[1].includes('announceNewVersion('), '不可在未比對指紋前直接宣告新版本');
    assert.ok(!m[1].includes('showToast('), '不再用 5 秒即消失的 toast');
  });

  test('initPwaServiceWorker 會啟動偵測器', () => {
    const m = APP_SRC.match(/function initPwaServiceWorker\(\) \{\s*\n\s*initUpdateWatcher\(\);/);
    assert.ok(m, 'initPwaServiceWorker 開頭應呼叫 initUpdateWatcher()');
  });

  test('Markdown Worker 以版本化網址建立（SW 才能判定頁面比 SW 新）', () => {
    assert.ok(APP_SRC.includes("new Worker('/md-worker.js' + assetVersionQuery())"));
  });

  test('橫幅樣式存在，疊在 toast 之上並使用主題變數', () => {
    const m = CSS_SRC.match(/\.update-banner \{([^}]*)\}/);
    assert.ok(m, 'style.css 應定義 .update-banner');
    assert.match(m[1], /position:\s*fixed/);
    const z = Number((m[1].match(/z-index:\s*(\d+)/) || [])[1]);
    assert.ok(z > 10000, `z-index (${z}) 應高於 toast (10000)`);
    assert.ok(/var\(--bg-tertiary\)/.test(m[1]) && /var\(--accent\)/.test(m[1]), '應使用主題變數');
    const reload = CSS_SRC.match(/\.update-banner-reload \{([^}]*)\}/);
    assert.ok(reload && /color:\s*var\(--bg-primary\)/.test(reload[1]), '強調色底的文字必須用 var(--bg-primary)');
  });
});
