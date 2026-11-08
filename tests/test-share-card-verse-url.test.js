/**
 * 首頁「換一句」後網址列要跟著換（回歸測試）
 *
 * 問題：按「換一句」後畫面換了經句，但網址列仍是 /（從分享連結進來的也被清成 /），
 * 重新整理會跳回這個時段的那一句，直接複製網址列分享出去的也不是畫面上那一句。
 * 另外 /?verse=… 沒有被當成首頁網址，開了「自動回到上次閱讀」的讀者點分享連結
 * 會被帶去上次讀的那一篇，看不到分享的經句。
 *
 * 修正：換一句／分享連結進來後網址列是 /?verse=<代號>（replaceState，不多一筆上一頁）；
 * 回首頁也帶著；/?verse= 一律是首頁。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appJs = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start !== -1, `app.js 應包含 ${signature}`);
  let i = source.indexOf('{', start);
  let depth = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  for (; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i++; } continue; }
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated ${signature}`);
}

/** 在 vm 裡跑 app.js 真正的 homeVerseUrl / syncHomeVerseUrl，配一個假的 location/history。 */
function makeSandbox(href) {
  const u = new URL(href);
  const location = { pathname: u.pathname, search: u.search, hash: u.hash };
  const calls = [];
  const history = {
    state: null,
    replaceState(_s, _t, url) {
      calls.push(url);
      const n = new URL(url, 'http://x');
      location.pathname = n.pathname; location.search = n.search; location.hash = n.hash;
    }
  };
  const sandbox = { URLSearchParams, state: { _homeVerseOverride: null, currentFile: null }, window: { location }, history, calls };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction(appJs, 'function homeVerseUrl()')}\n${extractFunction(appJs, 'function syncHomeVerseUrl()')}\n` +
    'globalThis.homeVerseUrl = homeVerseUrl; globalThis.syncHomeVerseUrl = syncHomeVerseUrl;', sandbox);
  return sandbox;
}

describe('換一句後網址列跟著換', () => {
  test('換一句：網址列變成 /?verse=<新代號>，再換一次就換成新的', () => {
    const sb = makeSandbox('http://x/');
    sb.state._homeVerseOverride = { id: '957ba8d701', text: '心如工畫師' };
    sb.syncHomeVerseUrl();
    assert.equal(sb.window.location.search, '?verse=957ba8d701');
    sb.state._homeVerseOverride = { id: '971973ea09', text: '諸惡莫作' };
    sb.syncHomeVerseUrl();
    assert.equal(sb.window.location.search, '?verse=971973ea09');
    // 用 replaceState，不會多一筆上一頁
    assert.equal(sb.calls.length, 2);
  });

  test('沒換過（顯示這個時段的那一句）網址就是 /；找不到的 ?verse= 會被拿掉', () => {
    const sb = makeSandbox('http://x/?verse=0000000000');
    sb.syncHomeVerseUrl();
    assert.equal(sb.window.location.pathname + sb.window.location.search, '/');
  });

  test('不在首頁（正在讀經、搜尋）時不動網址', () => {
    const sb = makeSandbox('http://x/?file=a.md&line=3');
    sb.state._homeVerseOverride = { id: '957ba8d701' };
    sb.syncHomeVerseUrl();
    assert.equal(sb.window.location.search, '?file=a.md&line=3');
    const sb2 = makeSandbox('http://x/?search=%E7%A9%BA');
    sb2.state._homeVerseOverride = { id: '957ba8d701' };
    sb2.syncHomeVerseUrl();
    assert.equal(sb2.calls.length, 0);
  });

  test('接線：換一句後同步網址；回首頁帶著 ?verse=；分享連結進來留著 verse、清掉 d/g/l/b', () => {
    const shuffle = extractFunction(appJs, 'async function shuffleHomeVerse()');
    assert.match(shuffle, /renderHomeVerse\(\);\s*syncHomeVerseUrl\(\);/);
    const goHome = extractFunction(appJs, 'function goHome(clearUrl = true)');
    assert.match(goHome, /history\.pushState\(null, '', homeVerseUrl\(\)\)/);
    const apply = extractFunction(appJs, 'async function applyVerseLinkFromUrl()');
    assert.match(apply, /for \(const k of \['d', 'g', 'l', 'b'\]\) params\.delete\(k\);/);
    assert.match(apply, /syncHomeVerseUrl\(\);/);
  });

  test('/?verse=<代號> 一律是首頁，不會被「自動回到上次閱讀」帶走', () => {
    const sb = { URLSearchParams };
    vm.createContext(sb);
    vm.runInContext(`${extractFunction(appJs, 'function safeDecodeURIComponent(str)')}\n` +
      `${extractFunction(appJs, 'function parseUrlParams(search, hash)')}\nglobalThis.parse = parseUrlParams;`, sb);
    assert.deepEqual({ ...sb.parse('?verse=971973ea09&d=2026-11-02&l=A', '') }, { isHome: true });
    // 選句連結（?file=&quote=）照舊開那一篇
    assert.equal(sb.parse('?file=a.md&line=3&quote=abc', '').file, 'a.md');
    // 不像代號的不算
    assert.equal(sb.parse('?verse=xyz', ''), null);
  });
});
