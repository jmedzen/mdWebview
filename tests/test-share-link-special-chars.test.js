/**
 * 分享連結：檔名含特殊符號（空格、《》「」、＋、＆、％…）時不得失效
 *
 * 背景：選取經文後的「分享／附出處複製」與點行號複製的連結，以前只轉義 & 和 #，
 * 其餘原樣輸出，複製前還 decodeURIComponent 一次。實際回報的失敗連結：
 *   ?file=06-菩薩藏/045-049《唯識宗必修論疏》/047 能顯中邊慧日論 疏文斷句.md&line=738
 * 貼進 LINE 等聊天軟體後，自動連結在第一個空格處截斷，點開就找不到檔案；
 * 檔名含 % 時 decodeURIComponent 會丟 URIError，含 & 或 # 時 decode 把轉義還原而解析錯誤。
 *
 * 本檔包含：
 *   1. 純函式測試：以 vm 實際執行 app.js 的 encodeSharePath / fileShareQuery。
 *   2. 往返測試：產出的連結經 URL／parseUrlParams 還原後必須等於原檔名。
 *   3. 伺服器整合測試：以真實 http 請求驗證編碼後的連結能開到對應檔案。
 *   4. 原始碼契約測試：複製連結的路徑不得再 decode 或自行拼 ?file=。
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
    'function encodeSharePath(filePath)',
    'function fileShareQuery(filePath, line)',
    'function safeDecodeURIComponent(str)',
    'function parseUrlParams(search, hash)'
  ];
  let code = '';
  for (const sig of sigs) {
    const body = extractFunctionBody(source, sig);
    assert.ok(body, `app.js 應包含 ${sig}`);
    code += `${sig} ${body}\n`;
  }
  code += 'globalThis.__h = { encodeSharePath, fileShareQuery, parseUrlParams };';
  const sandbox = { URLSearchParams, console };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.__h;
}

const H = loadShareHelpers();

/** 模擬聊天軟體的自動連結：從 http 開始，到第一個空白字元為止。 */
const linkify = (text) => (text.match(/https?:\/\/\S+/) || [''])[0];

describe('分享連結 1：檔名編碼（純函式）', () => {
  test('實際回報的檔名：連結不含空白或《》，聊天軟體自動連結不會截斷', () => {
    const url = BASE + H.fileShareQuery(REPORTED_FILE, REPORTED_LINE);
    assert.ok(!/\s/.test(url), '連結不得含空白字元');
    assert.ok(!/[《》「」、]/.test(url), '連結不得含《》「」、等標點');
    assert.equal(linkify(`第 ${REPORTED_LINE} 行\n${url}\n`), url, '自動連結應涵蓋整條連結');
  });

  test('漢字保持可讀，/ 保留為路徑分隔，空格編為 %20', () => {
    const q = H.fileShareQuery(REPORTED_FILE, REPORTED_LINE);
    assert.equal(
      q,
      '?file=06-菩薩藏/045-049%E3%80%8A唯識宗必修論疏%E3%80%8B/047%20能顯中邊慧日論%20疏文斷句.md&line=738'
    );
  });

  test('& # % + ? 都被編碼，不會破壞查詢字串', () => {
    assert.equal(H.encodeSharePath('甲&乙 #1.md'), '甲%26乙%20%231.md');
    assert.equal(H.encodeSharePath('50%測試.md'), '50%25測試.md');
    assert.equal(H.encodeSharePath('C++導論.md'), 'C%2B%2B導論.md');
    assert.equal(H.encodeSharePath('問?答.md'), '問%3F答.md');
  });

  test('帶變音符號的拉丁字母（梵文）與數字保持原樣', () => {
    assert.equal(H.encodeSharePath('Śūraṅgama-01.md'), 'Śūraṅgama-01.md');
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
      assert.ok(!/\s/.test(url), '連結不得含空白字元');
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

  test('不得對分享連結再 decodeURIComponent（會還原 %20 %26 %23，遇 % 還會丟例外）', () => {
    assert.ok(!/decodeURIComponent\(\s*currentShareUrl/.test(source));
  });

  test('不得自行以 split(&)/split(#) 拼 ?file=，一律走 fileShareQuery', () => {
    assert.ok(!/split\('&'\)\.join\('%26'\)/.test(source), '應移除手工轉義 & 的寫法');
    const uses = source.match(/fileShareQuery\(/g) || [];
    // 定義 1 次 + 選取分享連結、分享鈕（網址列）、點行號複製
    assert.ok(uses.length >= 4, `fileShareQuery 應被選取分享、分享鈕、點行號等處使用（目前 ${uses.length} 處）`);
  });
});
