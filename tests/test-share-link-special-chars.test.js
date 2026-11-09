/**
 * 分享連結：檔名含特殊符號（空格、《》「」、＋、＆、％…）時不得失效
 *
 * 背景：選取經文後的「分享／附出處複製」與點行號複製的連結，以前只轉義 & 和 #，
 * 其餘原樣輸出，複製前還 decodeURIComponent 一次。實際回報的失敗連結：
 *   ?file=06-菩薩藏/045-049《唯識宗必修論疏》/047 能顯中邊慧日論 疏文斷句.md&line=738
 * 貼進 LINE 等聊天軟體後，自動連結在第一個空格處截斷，點開就找不到檔案；
 * 檔名含 % 時 decodeURIComponent 會丟 URIError，含 & 或 # 時 decode 把轉義還原而解析錯誤。
 *
 * 之後連結改為經文短連結 /F<碼>L<行>（見 test-share-link-short.test.js）；本檔守住
 * 「長連結」這一條路：辭典、帶 q 參數的頁面仍用 ?file=…，而且整串必須是純 ASCII
 * （Google Chat 連漢字也會斷），檔名裡任何符號都不能破壞它。
 *
 * 本檔包含：
 *   1. 純函式測試：以 vm 實際執行 app.js 的 encodeSharePath / fileShareQuery。
 *   2. 往返測試：產出的連結經 URL／parseUrlParams 還原後必須等於原檔名。
 *   3. 伺服器整合測試：以真實 http 請求驗證編碼後的連結能開到對應檔案。
 *   4. 頁首「連結」鈕：currentPageShareUrl 以目前頁面產生同樣安全的連結。
 *   5. 原始碼契約測試：複製連結的路徑不得再 decode 或自行拼 ?file=。
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { spawn } = require('child_process');

const ROOT_DIR = path.join(__dirname, '..');
const APP_JS = path.join(ROOT_DIR, 'app.js');

// 實際回報的失敗檔名與行號
const REPORTED_FILE = '06-菩薩藏/045-049《唯識宗必修論疏》/047 能顯中邊慧日論 疏文斷句.md';
const REPORTED_LINE = 738;
const BASE = 'https://mbt.mahabodhi.co/';

// 會讓舊版連結壞掉的檔名
const NASTY_FILES = [
  REPORTED_FILE,
  '01-經藏/「又」《深密經》、疏（上）.md',
  '甲&乙 #1.md',
  '50%測試.md',
  'C++導論.md',
  '問?答.md',
  'a b  c.md',
  'Śūraṅgama sūtra.md'
];

// ─────────────────────────────────────────────────────────────────────────
// 由 app.js 抽出純函式並在 vm 中實際執行（app.js 是 IIFE，無法 import）
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

function loadShareHelpers() {
  const source = fs.readFileSync(APP_JS, 'utf8');
  const sigs = [
    'function encodeShareComponent(str)',
    'function encodeSharePath(filePath)',
    'function fileShareQuery(filePath, line)',
    'function shareHash53(str)',
    'function sharePathCode(filePath)',
    'function shareFileUrl(base, filePath, line)',
    'function currentPageShareUrl(loc, filePath)',
    'function safeDecodeURIComponent(str)',
    'function parseUrlParams(search, hash)'
  ];
  let code = '';
  for (const sig of sigs) {
    const body = extractFunctionBody(source, sig);
    assert.ok(body, `app.js 應包含 ${sig}`);
    code += `${sig} ${body}\n`;
  }
  code += 'globalThis.__h = { encodeSharePath, fileShareQuery, sharePathCode, shareFileUrl, currentPageShareUrl, parseUrlParams };';
  const sandbox = { URLSearchParams, console };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.__h;
}

const H = loadShareHelpers();

/** 模擬聊天軟體的自動連結：從 http 開始，到第一個空白字元為止。 */
const linkify = (text) => (text.match(/https?:\/\/\S+/) || [''])[0];

/** 整串只有可見的 ASCII 字元（沒有空白、漢字、書名號）。 */
const isPlainAscii = (str) => /^[\x21-\x7e]+$/.test(str);

describe('分享連結 1：長連結的檔名編碼（純函式）', () => {
  test('實際回報的檔名：整條連結是純 ASCII，聊天軟體自動連結不會截斷', () => {
    const url = BASE + H.fileShareQuery(REPORTED_FILE, REPORTED_LINE);
    assert.ok(isPlainAscii(url), '連結只能有可見 ASCII 字元（漢字、書名號、空白都要編碼）');
    assert.equal(linkify(`第 ${REPORTED_LINE} 行\n${url}\n`), url, '自動連結應涵蓋整條連結');
    assert.equal(
      H.fileShareQuery(REPORTED_FILE, REPORTED_LINE),
      `?file=${encodeURIComponent(REPORTED_FILE).replace(/%2F/g, '/')}&line=738`
    );
  });

  test('/ 保留為路徑分隔，空格編為 %20，書名號編為 %E3%80%8A／%E3%80%8B', () => {
    assert.equal(H.fileShareQuery('a/《甲》 乙.md', 7), '?file=a/%E3%80%8A%E7%94%B2%E3%80%8B%20%E4%B9%99.md&line=7');
  });

  test('& # % + ? 與 ( ) \' * ! 都被編碼，不會破壞查詢字串，也不會讓連結在括號、引號處斷開', () => {
    assert.equal(H.encodeSharePath('a&b #1.md'), 'a%26b%20%231.md');
    assert.equal(H.encodeSharePath('50%.md'), '50%25.md');
    assert.equal(H.encodeSharePath('C++.md'), 'C%2B%2B.md');
    assert.equal(H.encodeSharePath('q?.md'), 'q%3F.md');
    assert.equal(H.encodeSharePath("a(1)'*!.md"), 'a%281%29%27%2A%21.md');
  });

  test('帶變音符號的拉丁字母（梵文）也編成純 ASCII', () => {
    const e = H.encodeSharePath('Śūraṅgama-01.md');
    assert.ok(isPlainAscii(e));
    assert.equal(decodeURIComponent(e), 'Śūraṅgama-01.md');
  });

  test('沒有行號時不附 &line=', () => {
    assert.equal(H.fileShareQuery('a/b.md'), '?file=a/b.md');
    assert.equal(H.fileShareQuery('a/b.md', 0), '?file=a/b.md');
    assert.equal(H.fileShareQuery('a/b.md', 12), '?file=a/b.md&line=12');
  });

  test('空值不丟例外', () => {
    assert.doesNotThrow(() => H.encodeSharePath(''));
    assert.doesNotThrow(() => H.encodeSharePath(undefined));
    assert.doesNotThrow(() => H.encodeSharePath(null));
  });
});

describe('分享連結 2：往返還原', () => {
  for (const file of NASTY_FILES) {
    test(`「${file}」：產出的連結還原後等於原檔名（伺服器解析與前端解析皆然）`, () => {
      const search = H.fileShareQuery(file, 7);
      const url = BASE + search;
      assert.ok(isPlainAscii(url), '連結須為純 ASCII');
      assert.equal(linkify(`「引文」\n${url}`), url, '自動連結不得截斷');

      // 伺服器端：new URL(...).searchParams
      assert.equal(new URL(url).searchParams.get('file'), file, '伺服器端解析');
      assert.equal(new URL(url).searchParams.get('line'), '7');

      // 前端：開網址列時走 parseUrlParams
      const route = H.parseUrlParams(search, '');
      assert.equal(route.file, file, '前端解析');
      assert.equal(route.line, 7);
    });
  }

  test('瀏覽器網址列（location.search）也能還原：pushState 的路徑與分享連結一致', () => {
    // 瀏覽器把 pushState 的網址正規化後再給 location.search；用 URL 模擬
    const search = new URL(BASE + H.fileShareQuery(REPORTED_FILE, REPORTED_LINE)).search;
    assert.equal(H.parseUrlParams(search, '').file, REPORTED_FILE);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 頁首「連結」鈕（#copyLinkBtn）：以前複製 decodeURIComponent(location.href)
// ─────────────────────────────────────────────────────────────────────────
describe('分享連結 3a：頁首「連結」鈕複製的連結', () => {
  /** 模擬瀏覽器的 window.location：網址列的 search 已被瀏覽器正規化成 %XX。 */
  const locOf = (rawUrl) => {
    const u = new URL(rawUrl);
    return { origin: u.origin, pathname: u.pathname, search: u.search, href: u.href };
  };
  const SHORT_RE = /^https:\/\/mbt\.mahabodhi\.co\/F[0-9a-f]{14}(?:L\d+)?$/;

  test('實際回報的檔名：複製出來的是英數短連結，行號保留', () => {
    const loc = locOf(`${BASE}?file=${encodeURIComponent(REPORTED_FILE)}&line=${REPORTED_LINE}`);
    const url = H.currentPageShareUrl(loc, REPORTED_FILE);
    assert.equal(url, `${BASE}F${H.sharePathCode(REPORTED_FILE)}L${REPORTED_LINE}`);
    assert.match(url, SHORT_RE);
    assert.equal(linkify(`第 ${REPORTED_LINE} 行\n${url}\n`), url, '自動連結應涵蓋整條連結');
  });

  test('舊寫法 decodeURIComponent(location.href) 會產生含空白、《》的連結（回歸對照）', () => {
    const loc = locOf(`${BASE}?file=${encodeURIComponent(REPORTED_FILE)}&line=${REPORTED_LINE}`);
    const old = decodeURIComponent(loc.href);
    assert.ok(/\s/.test(old), '舊寫法的輸出含空白，這就是被截斷的原因');
  });

  for (const file of NASTY_FILES) {
    test(`「${file}」：複製出來的是短連結，沒有行號就不附 L`, () => {
      const withLine = H.currentPageShareUrl(locOf(`${BASE}?file=${encodeURIComponent(file)}&line=12`), file);
      assert.match(withLine, SHORT_RE);
      assert.ok(withLine.endsWith('L12'));
      const noLine = H.currentPageShareUrl(locOf(`${BASE}?file=${encodeURIComponent(file)}`), file);
      assert.match(noLine, SHORT_RE);
      assert.ok(!/L\d+$/.test(noLine));
    });
  }

  test('網址列帶有 q 關鍵字：退回純 ASCII 長連結，file、line、q 全部保留', () => {
    const loc = locOf(`${BASE}?file=${encodeURIComponent('a/b c.md')}&line=5&q=${encodeURIComponent('如 是&我 聞')}`);
    const url = H.currentPageShareUrl(loc, 'a/b c.md');
    assert.ok(isPlainAscii(url), '長連結也必須是純 ASCII');
    const params = new URL(url).searchParams;
    assert.equal(params.get('file'), 'a/b c.md');
    assert.equal(params.get('line'), '5');
    assert.equal(params.get('q'), '如 是&我 聞');
  });

  test('辭典（dict:）不在經文清單裡：退回純 ASCII 長連結', () => {
    const url = H.shareFileUrl(BASE, 'dict:佛學 辭典/甲.md', 3);
    assert.ok(isPlainAscii(url));
    assert.equal(new URL(url).searchParams.get('file'), 'dict:佛學 辭典/甲.md');
    assert.equal(new URL(url).searchParams.get('line'), '3');
  });

  test('以目前開啟的檔案為準；沒有檔案時退回原網址', () => {
    const loc = locOf(`${BASE}?file=stale.md&line=3`);
    assert.equal(H.currentPageShareUrl(loc, 'a/new.md'), `${BASE}F${H.sharePathCode('a/new.md')}L3`);
    const home = locOf(`${BASE}?home=1`);
    assert.equal(H.currentPageShareUrl(home, ''), home.href);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. 伺服器：編碼後的分享連結真的開得到那個檔案
// ─────────────────────────────────────────────────────────────────────────
describe('分享連結 3：伺服器開得到含特殊符號的檔案', () => {
  const tmpDirs = [];
  let mdRoot;
  let child;
  let port;

  const get = (urlPath, headers) => new Promise((resolve, reject) => {
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

  const GOOGLEBOT = { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' };
  const SERVER_FILES = [
    { rel: REPORTED_FILE, title: '特殊檔名標題甲' },
    { rel: '05-經藏/甲&乙 #1.md', title: '特殊檔名標題乙' },
    { rel: '05-經藏/C++導論 50%.md', title: '特殊檔名標題丙' }
  ];

  before(async () => {
    mdRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mdweb-share-md-'));
    const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdweb-share-cfg-'));
    tmpDirs.push(mdRoot, cfgDir);
    for (const f of SERVER_FILES) {
      const full = path.join(mdRoot, f.rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, `# ${f.title}\n\n第一段。\n\n第二段。\n`, 'utf-8');
    }
    const configPath = path.join(cfgDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ settings: { mdRoot } }), 'utf-8');

    ({ child, port } = await new Promise((resolve, reject) => {
      const c = spawn(process.execPath, ['server.js'], {
        cwd: ROOT_DIR,
        env: Object.assign({}, process.env, { PORT: '0', HOST: '127.0.0.1', MD_ROOT: mdRoot, CONFIG_PATH: configPath })
      });
      let buf = '';
      const onData = (chunk) => {
        buf += chunk.toString();
        const m = buf.match(/MDWEBVIEW_READY port=(\d+)/);
        if (m) { c.stdout.off('data', onData); resolve({ child: c, port: parseInt(m[1], 10) }); }
      };
      c.stdout.on('data', onData);
      c.stderr.on('data', () => {});
      c.on('error', reject);
      c.on('exit', (code) => {
        if (!buf.includes('MDWEBVIEW_READY')) reject(new Error(`server exited early (${code}): ${buf.slice(-500)}`));
      });
      setTimeout(() => reject(new Error('server did not become ready in time')), 30000).unref();
    }));
  });

  after(async () => {
    if (child && child.exitCode === null) {
      await new Promise((resolve) => {
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} resolve(); }, 5000).unref();
      });
    }
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });

  for (const f of SERVER_FILES) {
    test(`爬蟲（LINE／Google 預覽）開「${f.rel}」的分享連結得到該檔案`, async () => {
      // 讀者／爬蟲實際送出的請求：瀏覽器會把連結中的漢字再編成 %XX
      const u = new URL(BASE + H.fileShareQuery(f.rel, 2));
      const res = await get(u.pathname + u.search, GOOGLEBOT);
      assert.equal(res.statusCode, 200, `HTTP ${res.statusCode}`);
      assert.ok(res.body.includes(f.title), '預覽頁應含該檔案的標題');
    });

    test(`讀者開「${f.rel}」的分享連結，/api/render 取得該檔案`, async () => {
      const res = await get(`/api/render?path=${encodeURIComponent(f.rel)}&line=2`);
      assert.equal(res.statusCode, 200, `HTTP ${res.statusCode}`);
      assert.ok(res.body.includes('第一段'), '應回傳該檔案的內容');
    });
  }

  test('被截斷的舊式連結（只到第一個空格）找不到檔案——這正是原本的失敗樣態', async () => {
    const truncated = linkify(`${BASE}?file=${REPORTED_FILE}&line=${REPORTED_LINE}`); // 舊版輸出
    const file = new URL(truncated).searchParams.get('file');
    assert.notEqual(file, REPORTED_FILE, '舊版連結被截斷後檔名已不完整');
    const res = await get('/' + `?file=${encodeURIComponent(file)}`, GOOGLEBOT);
    assert.notEqual(res.statusCode, 200);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. 原始碼契約：不得退回舊寫法
// ─────────────────────────────────────────────────────────────────────────
describe('分享連結 4：原始碼契約', () => {
  const source = fs.readFileSync(APP_JS, 'utf8');

  test('頁首「連結」鈕不得再複製 decodeURIComponent(location.href)，一律走 currentPageShareUrl', () => {
    assert.ok(!/decodeURIComponent\(\s*window\.location\.href/.test(source));
    assert.match(source, /const copyBtn = e\.target\.closest\('#copyLinkBtn'\);[\s\S]{0,400}currentPageShareUrl\(window\.location, state\.currentFile\)/);
  });

  test('不得對分享連結再 decodeURIComponent（會還原 %20 %26 %23，遇 % 還會丟例外）', () => {
    assert.ok(!/decodeURIComponent\(\s*currentShareUrl/.test(source));
  });

  test('不得自行以 split(&)/split(#) 拼 ?file=，一律走 fileShareQuery', () => {
    assert.ok(!/split\('&'\)\.join\('%26'\)/.test(source), '應移除手工轉義 & 的寫法');
    const uses = source.match(/fileShareQuery\(/g) || [];
    // 定義 1 次 + 長連結退路、頁首連結鈕、分享鈕與點行號的網址列
    assert.ok(uses.length >= 4, `fileShareQuery 應被長連結退路、頁首連結鈕、網址列等處使用（目前 ${uses.length} 處）`);
  });

  test('選字分享連結、點行號複製、頁首連結鈕都走 shareFileUrl（經文短連結）', () => {
    assert.match(source, /currentShareUrl = shareFileUrl\(baseUrl, state\.currentFile, lineNum\)/);
    assert.match(source, /const fullLineUrl = shareFileUrl\(window\.location\.origin \+ window\.location\.pathname, state\.currentFile, lineNum\)/);
    assert.match(source, /if \(!extra\.length\) return shareFileUrl\(base, file, line\)/);
  });
});
