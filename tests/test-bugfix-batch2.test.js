/**
 * Regression tests for the second audit batch (items 8–16).
 *
 *   8  SSR template injection: String.replace() replacement patterns ($$, $&)
 *   9  JSON-LD </script> break-out
 *  11  settings type validation (no half-applied config)
 *  12  render-chunk answers 304 before rendering; short reads are rejected
 *  13  readJSONBody keeps multi-byte UTF-8 split across chunks intact
 *  14  dict: paths are unreadable while the dictionary feature is disabled
 *  15  strict-mode search highlight never splits HTML entities
 *  16  getBaseUrl ignores X-Forwarded-Host from untrusted peers / bad hosts;
 *      console log lines cannot be forged with CR/LF
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mdw-b2-'));
const VAULT = path.join(TMP, 'md');
const DICTS = path.join(TMP, 'dicts');
fs.mkdirSync(path.join(VAULT, 'sub'), { recursive: true });
fs.mkdirSync(DICTS, { recursive: true });
fs.writeFileSync(path.join(VAULT, 'sub', 'math.md'),
  '# 標題 </script><b>x</b>\n\n價格 $& 與 $` 與 $\' 結束\n\n$$a+b$$\n');
// > 1 MB with many headings so the virtualized (section-index) path is used.
let big = '# 大檔\n\n';
for (let i = 0; i < 2500; i++) big += `## 條目${i}\n` + '經'.repeat(150) + '\n\n';
fs.writeFileSync(path.join(VAULT, 'sub', 'big.md'), big);
fs.writeFileSync(path.join(DICTS, 'd.md'), '# 詞\n\n內容\n');
process.env.CONFIG_PATH = path.join(TMP, 'config.json');
process.env.MD_ROOT = VAULT;

describe('13. readJSONBody', () => {
  const { readJSONBody } = require('../lib/auth.js');

  function fakeReq(chunks) {
    const req = new EventEmitter();
    req.destroy = () => {};
    setImmediate(() => { for (const c of chunks) req.emit('data', c); req.emit('end'); });
    return req;
  }

  test('a CJK character split across two chunks is decoded intact', async () => {
    const buf = Buffer.from(JSON.stringify({ msg: '佛光辭典' }), 'utf-8');
    const cut = buf.indexOf(Buffer.from('光')) + 1; // inside the 3-byte sequence
    const data = await readJSONBody(fakeReq([buf.subarray(0, cut), buf.subarray(cut)]));
    assert.equal(data.msg, '佛光辭典');
  });

  test('malformed and non-object bodies resolve to {}', async () => {
    assert.deepEqual(await readJSONBody(fakeReq([Buffer.from('{bad')])), {});
    assert.deepEqual(await readJSONBody(fakeReq([Buffer.from('[1,2]')])), {});
    assert.deepEqual(await readJSONBody(fakeReq([Buffer.from('null')])), {});
  });

  test('size limit is enforced in bytes', async () => {
    const big = Buffer.alloc(1024 * 1024 + 10, 0x61);
    await assert.rejects(readJSONBody(fakeReq([big])), /Payload too large/);
  });
});

describe('15. strict search highlight', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const grab = (name) => {
    const i = src.indexOf(`  function ${name}(`);
    return src.slice(i, src.indexOf('\n  }\n', i) + 4);
  };
  const highlight = new Function(grab('escHtml') + grab('escRegex') + grab('termRegexSource') + grab('highlightSearchTerm') + 'return highlightSearchTerm;')();
  const highlightVariants = new Function('window',
    grab('escHtml') + grab('escRegex') + grab('termRegexSource') + grab('highlightSearchTerm') + 'return highlightSearchTerm;'
  )({ mdSearchVariants: require('../i18n/search-variants.js') });

  test('terms that spell entity names do not break escaping', () => {
    const out = highlight('A & B "q" <c>', 'amp');
    assert.equal(out, 'A &amp; B &quot;q&quot; &lt;c&gt;');
    assert.equal(highlight('"quote"', 'quot'), '&quot;<mark>quot</mark>e&quot;');
  });

  test('matches are escaped inside <mark>', () => {
    assert.equal(highlight('x <b> y', '<b>'), 'x <mark>&lt;b&gt;</mark> y');
    assert.equal(highlight('般若波羅蜜', /(波羅)/gi), '般若<mark>波羅</mark>蜜');
  });

  test('字組比對：簡體查詢高亮繁體摘要，關閉時維持字面比對', () => {
    assert.equal(highlightVariants('然後，皇后', '后', true), '然<mark>後</mark>，皇<mark>后</mark>');
    assert.equal(highlightVariants('頭髮 <b>', '头发', true), '<mark>頭髮</mark> &lt;b&gt;');
    assert.equal(highlightVariants('然後，皇后', '后', false), '然後，皇<mark>后</mark>');
  });
});

describe('16. getBaseUrl and console log lines', () => {
  const { getBaseUrl } = require('../lib/utils.js');
  const { sanitizeConsoleLine } = require('../lib/logger.js');
  const req = (peer, headers) => ({ socket: { remoteAddress: peer }, headers });

  test('X-Forwarded-Host from an untrusted peer is ignored', () => {
    // 這裡驗證「沒有設定 siteUrl 時」由請求標頭推導網址；本機 config.json 或
    // SITE_URL 若設定了 siteUrl 會直接回傳該值，因此測試期間暫時清空。
    const { config } = require('../lib/config.js');
    const prevSiteUrl = config.settings.siteUrl;
    const prevEnvSiteUrl = process.env.SITE_URL;
    const prev = process.env.TRUST_PROXY;
    config.settings.siteUrl = '';
    delete process.env.SITE_URL;
    process.env.TRUST_PROXY = 'true';
    try {
      assert.equal(getBaseUrl(req('198.51.100.1', { host: 'real.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' }), ''),
        'http://real.example');
      assert.equal(getBaseUrl(req('127.0.0.1', { host: 'internal:8330', 'x-forwarded-host': 'site.example', 'x-forwarded-proto': 'https' }), ''),
        'https://site.example');
    } finally {
      if (prev === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = prev;
      config.settings.siteUrl = prevSiteUrl;
      if (prevEnvSiteUrl !== undefined) process.env.SITE_URL = prevEnvSiteUrl;
    }
  });

  test('malformed Host values are not reflected into absolute URLs', () => {
    const url = getBaseUrl(req('198.51.100.1', { host: 'x.example"><script>' }), '');
    assert.doesNotMatch(url, /[<>"]/);
  });

  test('configured siteUrl always wins', () => {
    assert.equal(getBaseUrl(req('198.51.100.1', { host: 'evil.example' }), 'https://site.example/'), 'https://site.example');
  });

  test('CR/LF cannot forge a separate console log line', () => {
    const out = sanitizeConsoleLine('q=a\n[2026-01-01] [ERROR] forged\r\u2028x');
    assert.doesNotMatch(out, /[\r\n\u2028]/);
    assert.match(out, /\\n\[2026-01-01\]/);
    assert.equal(sanitizeConsoleLine('中文\ttab'), '中文\ttab');
  });
});

describe('HTTP: 8, 9, 11, 12, 14', () => {
  let srv; let baseUrl = ''; let token = '';
  const { config, invalidateMdRootMemo } = require('../lib/config.js');

  function request(p, options = {}) {
    require('../lib/auth.js').apiRateLimits.clear();
    return new Promise((resolve, reject) => {
      const r = http.request(new URL(p, baseUrl), {
        agent: false, ...options, headers: { Connection: 'close', ...(options.headers || {}) }
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') }));
      });
      r.on('error', reject);
      if (options.body) r.write(options.body);
      r.end();
    });
  }

  before(async () => {
    srv = require('../server.js');
    const { hashPassword } = require('../lib/auth.js');
    const { salt, hash } = await hashPassword('correct-horse');
    config.admin = { username: 'admin', passwordHash: hash, salt };
    config.settings.mdRoot = VAULT;
    config.settings.siteUrl = 'https://site.example';
    config.settings.dictionaryPath = DICTS;
    config.settings.dictionaryEnabled = false;
    invalidateMdRootMemo();
    await new Promise(r => srv.server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${srv.server.address().port}`; r();
    }));
    const login = await request('/api/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'correct-horse' })
    });
    token = JSON.parse(login.body).token;
  });

  after(async () => {
    srv.resetTreeWatcher(); srv.resetDictWatcher(); srv.resetConfigWatcher();
    await srv.terminateWorkerPools();
    if (srv.server.closeAllConnections) srv.server.closeAllConnections();
    await new Promise(r => srv.server.close(r));
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  test('8. crawler SSR keeps $$, $&, $` and $\' literally', async () => {
    const res = await request('/?file=sub/math.md&ssr=1');
    assert.equal(res.statusCode, 200);
    const article = res.body.slice(res.body.indexOf('id="markdownBody"'));
    assert.match(article, /價格 \$&amp; 與 \$` 與 \$(?:'|&#39;) 結束/);
    assert.match(article, /data-math="a\+b">\$\$a\+b\$\$/, 'display math must keep both $$ delimiters');
    // $& would have re-inserted the matched <article> tag; there must be one.
    assert.equal((res.body.match(/id="markdownBody"/g) || []).length, 1);
  });

  test('9. JSON-LD cannot be terminated by a document title', async () => {
    const res = await request('/?file=sub/math.md&ssr=1');
    const m = res.body.match(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);
    assert.ok(m, 'JSON-LD block present');
    assert.doesNotMatch(m[1], /<\/script|<b>/i);
    const ld = JSON.parse(m[1]);
    assert.match(ld['@graph'][0].headline, /<\/script><b>x<\/b>/, 'title survives as data');
  });

  const postSettings = (settings) => request('/api/admin/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': token },
    body: JSON.stringify({ settings })
  });

  test('11. a wrongly typed field is rejected before anything is changed', async () => {
    const themeBefore = config.settings.defaultTheme;
    const res = await postSettings({ defaultTheme: 'zen', siteName: 123 });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).field, 'siteName');
    assert.equal(config.settings.defaultTheme, themeBefore, 'no partial update');
    assert.equal((await postSettings({ defaultTheme: '"><x' })).statusCode, 400, 'unknown theme');
  });

  test('11. null fields from a restored export are ignored, not stored as "null"', async () => {
    const res = await postSettings({ siteName: '測試站', downloadUrl: null, version: null });
    assert.equal(res.statusCode, 200);
    assert.equal(config.settings.siteName, '測試站');
    assert.notEqual(config.settings.downloadUrl, 'null');
    assert.notEqual(config.settings.version, 'null');
  });

  test('12. render-chunk answers If-None-Match with 304', async () => {
    const idx = await request('/api/section-index?path=sub/big.md');
    assert.equal(idx.statusCode, 200);
    const meta = JSON.parse(idx.body);
    assert.equal(meta.large, true);
    const c = meta.chunks[1];
    const first = await request(`/api/render-chunk?path=sub/big.md&from=${c.from}&to=${c.to}`);
    assert.equal(first.statusCode, 200);
    assert.ok(first.headers.etag);
    const again = await request(`/api/render-chunk?path=sub/big.md&from=${c.from}&to=${c.to}`, {
      headers: { 'If-None-Match': first.headers.etag }
    });
    assert.equal(again.statusCode, 304);
  });

  test('14. dict: files are unreadable while the dictionary is disabled', async () => {
    config.settings.dictionaryEnabled = false;
    assert.equal((await request('/api/render?path=dict:d.md')).statusCode, 404);
    assert.equal((await request('/api/section-index?path=dict:d.md')).statusCode, 404);
    config.settings.dictionaryEnabled = true;
    try {
      assert.equal((await request('/api/render?path=dict:d.md')).statusCode, 200);
    } finally {
      config.settings.dictionaryEnabled = false;
    }
  });

  test('login with a non-string password is a 400, not a 500', async () => {
    const res = await request('/api/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: { $ne: 1 } })
    });
    assert.equal(res.statusCode, 400);
    require('../lib/auth.js').loginAttempts.clear();
  });
});
