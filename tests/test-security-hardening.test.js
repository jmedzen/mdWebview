/**
 * Security hardening regression tests.
 *
 *  A. getClientIP / TRUST_PROXY: forwarding headers are honoured only when the
 *     TCP peer is a trusted proxy, so a client that reaches the origin directly
 *     cannot pick its own IP, while traffic arriving through cloudflared (a
 *     loopback / private peer) still resolves to each visitor's real IP.
 *  B. Login lockout is charged before hashing, so parallel bursts and rotating
 *     X-Forwarded-For values cannot exceed the attempt limit.
 *  C. Read endpoints only serve Markdown (or image/PDF media), never hidden
 *     paths, and the vault cannot be pointed at a system directory.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// Isolate config writes and the vault BEFORE server.js is loaded.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mdw-sec-'));
const VAULT = path.join(TMP, 'md');
fs.mkdirSync(path.join(VAULT, 'sub'), { recursive: true });
fs.mkdirSync(path.join(VAULT, '.obsidian'), { recursive: true });
fs.writeFileSync(path.join(VAULT, 'sub', 'a.md'), '# Hello\n\nbody\n');
fs.writeFileSync(path.join(VAULT, 'sub', 'notes.txt'), 'not markdown\n');
fs.writeFileSync(path.join(VAULT, 'sub', 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
fs.writeFileSync(path.join(VAULT, '.obsidian', 'plugin.json'), '{"token":"secret"}');
fs.writeFileSync(path.join(VAULT, '.obsidian', 'hidden.md'), '# hidden\n');
process.env.CONFIG_PATH = path.join(TMP, 'config.json');
process.env.MD_ROOT = VAULT;

const { getClientIP, isForbiddenContentRoot } = require('../lib/utils.js');

function fakeReq(peer, headers = {}) {
  return { socket: { remoteAddress: peer }, headers };
}

function withTrustProxy(value, fn) {
  const prev = process.env.TRUST_PROXY;
  if (value === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = value;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = prev;
  }
}

describe('A. getClientIP — TRUST_PROXY peer validation', () => {
  test('TRUST_PROXY=true + cloudflared on loopback → real visitor IP from CF-Connecting-IP', () => {
    withTrustProxy('true', () => {
      assert.equal(getClientIP(fakeReq('127.0.0.1', { 'cf-connecting-ip': '203.0.113.7' })), '203.0.113.7');
      assert.equal(getClientIP(fakeReq('::ffff:127.0.0.1', { 'cf-connecting-ip': '198.51.100.9' })), '198.51.100.9');
    });
  });

  test('TRUST_PROXY=true + cloudflared in a Docker network (172.16/12, 10/8, 192.168/16)', () => {
    withTrustProxy('true', () => {
      for (const peer of ['172.18.0.5', '10.1.2.3', '192.168.1.20', 'fd00::5']) {
        assert.equal(getClientIP(fakeReq(peer, { 'cf-connecting-ip': '203.0.113.7' })), '203.0.113.7', peer);
      }
    });
  });

  test('distinct visitors through the same tunnel stay distinct (no collapse into one IP)', () => {
    withTrustProxy('true', () => {
      const a = getClientIP(fakeReq('172.18.0.2', { 'cf-connecting-ip': '203.0.113.1' }));
      const b = getClientIP(fakeReq('172.18.0.2', { 'cf-connecting-ip': '203.0.113.2' }));
      assert.notEqual(a, b);
    });
  });

  test('TRUST_PROXY=true + public peer → headers ignored (spoofing blocked)', () => {
    withTrustProxy('true', () => {
      assert.equal(getClientIP(fakeReq('198.51.100.50', { 'cf-connecting-ip': '1.2.3.4' })), '198.51.100.50');
      assert.equal(getClientIP(fakeReq('198.51.100.50', { 'x-forwarded-for': '1.2.3.4' })), '198.51.100.50');
    });
  });

  test('X-Forwarded-For takes the right-most untrusted hop, not the client-controlled left-most', () => {
    withTrustProxy('true', () => {
      const req = fakeReq('127.0.0.1', { 'x-forwarded-for': '6.6.6.6, 203.0.113.44, 10.0.0.2' });
      assert.equal(getClientIP(req), '203.0.113.44');
    });
  });

  test('True-Client-IP is not honoured', () => {
    withTrustProxy('true', () => {
      assert.equal(getClientIP(fakeReq('127.0.0.1', { 'true-client-ip': '6.6.6.6' })), '127.0.0.1');
    });
  });

  test('explicit IP / CIDR list', () => {
    withTrustProxy('203.0.113.10, 100.64.0.0/10', () => {
      assert.equal(getClientIP(fakeReq('203.0.113.10', { 'cf-connecting-ip': '8.8.8.8' })), '8.8.8.8');
      assert.equal(getClientIP(fakeReq('100.100.1.1', { 'cf-connecting-ip': '8.8.4.4' })), '8.8.4.4');
      assert.equal(getClientIP(fakeReq('127.0.0.1', { 'cf-connecting-ip': '8.8.8.8' })), '127.0.0.1');
    });
  });

  test('TRUST_PROXY unset → headers never trusted', () => {
    withTrustProxy(undefined, () => {
      assert.equal(getClientIP(fakeReq('127.0.0.1', { 'cf-connecting-ip': '8.8.8.8' })), '127.0.0.1');
    });
  });
});

describe('D. regex sanitizer (render-worker.js / md-worker.js) closes entity & control-char bypasses', () => {
  for (const file of ['render-worker.js', 'md-worker.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const start = src.indexOf('function sanitizeDangerousTags');
    const end = src.indexOf('function isDangerousUrl');
    const endOfIsDangerous = src.indexOf('\n}\n', end) + 3;
    const sanitize = new Function(src.slice(start, endOfIsDangerous) + '\nreturn sanitizeDangerousTags;')();

    test(`${file}: javascript: smuggled through entities / control chars is neutralized`, () => {
      const vectors = [
        '<a href="javascript&colon;alert(1)">x</a>',
        '<a href="java&Tab;script:alert(1)">x</a>',
        '<a href="java&NewLine;script:alert(1)">x</a>',
        '<a href="&#x01;javascript:alert(1)">x</a>',
        '<a href="&#106avascript:alert(1)">x</a>',
        '<a href="data:text/html,<script>alert(1)</script>">x</a>',
        '<img src="data:image/svg+xml,<svg onload=alert(1)>">',
        '<button formaction="javascript:alert(1)">x</button>'
      ];
      for (const v of vectors) {
        const out = sanitize(v);
        assert.doesNotMatch(out, /javascript|data:text|svg\+xml/i, `${v} => ${out}`);
      }
    });

    test(`${file}: legitimate links and inline raster images survive`, () => {
      assert.equal(sanitize('<a href="https://example.com/a">a</a>'), '<a href="https://example.com/a">a</a>');
      assert.equal(sanitize('<a href="#fn-def-1">1</a>'), '<a href="#fn-def-1">1</a>');
      assert.equal(sanitize('<img src="data:image/png;base64,AAAA">'), '<img src="data:image/png;base64,AAAA">');
    });

    test(`${file}: template/srcdoc wrappers are stripped`, () => {
      const out = sanitize('<template><p>x</p></template><iframe srcdoc="<script>1</script>"></iframe>');
      assert.doesNotMatch(out, /template|srcdoc|iframe/i);
    });

    test(`${file}: wikilinks no longer use a javascript: href`, () => {
      assert.doesNotMatch(src, /href="javascript:void\(0\)"/);
    });
  }
});

describe('C1. isForbiddenContentRoot', () => {
  test('rejects filesystem root, system dirs and the app dir', () => {
    for (const p of ['/', '/etc', '/etc/nginx', '/proc', '/usr/local/share', '/root']) {
      assert.equal(isForbiddenContentRoot(p, '/app'), true, p);
    }
    assert.equal(isForbiddenContentRoot('/app', '/app'), true);
  });
  test('accepts normal vault locations', () => {
    for (const p of ['/data/md', '/data/dicts', '/app/md', '/home/me/vault', '/var/www/md']) {
      assert.equal(isForbiddenContentRoot(p, '/app'), false, p);
    }
  });
});

describe('B/C2. HTTP endpoints', () => {
  let baseUrl = '';
  let srv;
  let token = '';

  function request(p, options = {}) {
    // These tests fire many requests per second; keep the 30 req/s API limiter
    // out of the way except where a test exercises lockout explicitly.
    require('../lib/auth.js').apiRateLimits.clear();
    return new Promise((resolve, reject) => {
      const req = http.request(new URL(p, baseUrl), {
        agent: false, ...options, headers: { Connection: 'close', ...(options.headers || {}) }
      }, (res) => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
      });
      req.on('error', reject);
      if (options.body) req.write(options.body);
      req.end();
    });
  }

  before(async () => {
    srv = require('../server.js');
    const { config, invalidateMdRootMemo } = require('../lib/config.js');
    const { hashPassword } = require('../lib/auth.js');
    const { salt, hash } = await hashPassword('correct-horse');
    config.admin = { username: 'admin', passwordHash: hash, salt };
    config.settings.mdRoot = VAULT;
    invalidateMdRootMemo();
    await new Promise(r => srv.server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${srv.server.address().port}`;
      r();
    }));
  });

  after(async () => {
    srv.resetTreeWatcher(); srv.resetDictWatcher(); srv.resetConfigWatcher();
    await srv.terminateWorkerPools();
    if (srv.server.closeAllConnections) srv.server.closeAllConnections();
    await new Promise(r => srv.server.close(r));
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  test('/api/file serves Markdown but refuses non-.md and hidden paths', async () => {
    assert.equal((await request('/api/file?path=sub/a.md')).statusCode, 200);
    assert.equal((await request('/api/file?path=sub/notes.txt')).statusCode, 403);
    assert.equal((await request('/api/file?path=.obsidian/plugin.json')).statusCode, 403);
    assert.equal((await request('/api/file?path=.obsidian/hidden.md')).statusCode, 403);
  });

  test('/api/render refuses non-.md and hidden paths', async () => {
    assert.equal((await request('/api/render?path=sub/a.md')).statusCode, 200);
    assert.equal((await request('/api/render?path=sub/a')).statusCode, 200); // .md fallback
    assert.equal((await request('/api/render?path=sub/notes.txt')).statusCode, 403);
    assert.equal((await request('/api/render?path=.obsidian/hidden.md')).statusCode, 403);
    assert.equal((await request('/api/section-index?path=sub/notes.txt')).statusCode, 404);
  });

  test('crawler SSR refuses non-.md', async () => {
    assert.equal((await request('/?file=sub/notes.txt&ssr=1')).statusCode, 403);
  });

  test('/api/media serves images only and does not reveal files outside the vault', async () => {
    assert.equal((await request('/api/media?path=pic.png&doc=sub/a.md')).statusCode, 200);
    assert.equal((await request('/api/media?path=notes.txt&doc=sub/a.md')).statusCode, 404);
    assert.equal((await request('/api/media?path=.obsidian/plugin.json')).statusCode, 404);
    const up = '../'.repeat(30);
    const existing = await request(`/api/media?path=${encodeURIComponent(up + 'etc/hosts')}`);
    const missing = await request(`/api/media?path=${encodeURIComponent(up + 'etc/definitely-missing')}`);
    assert.equal(existing.statusCode, missing.statusCode, 'existence oracle must be closed');
  });

  test('parallel login burst cannot exceed MAX_ATTEMPTS failures', async () => {
    const burst = await Promise.all(Array.from({ length: 12 }, () => request('/api/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrong' })
    })));
    const unauthorized = burst.filter(r => r.statusCode === 401).length;
    assert.ok(unauthorized <= 5, `got ${unauthorized} password checks, expected <= 5`);
    assert.ok(burst.some(r => r.statusCode === 429));
    require('../lib/auth.js').loginAttempts.clear();
  });

  test('first-run setup requires the one-time setup token', async () => {
    const { config } = require('../lib/config.js');
    const accountsDb = require('../lib/db.js');
    const savedAdmin = config.admin;
    const savedSiteUrl = config.settings.siteUrl;
    config.admin = null;
    // 管理員存在帳號資料庫：先清空，模擬全新部署。
    accountsDb.getDb().exec('DELETE FROM sessions; DELETE FROM users;');
    try {
      const setup = (extra) => request('/api/admin/setup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'intruder', password: 'password123', siteUrl: 'https://x.example', ...extra })
      });
      const missing = await setup({});
      assert.equal(missing.statusCode, 403);
      assert.equal(JSON.parse(missing.body).code, 'INVALID_SETUP_TOKEN');
      assert.equal((await setup({ setupToken: 'wrong-token' })).statusCode, 403);
      assert.equal(accountsDb.countActiveAdmins(), 0, 'no admin may be created without the token');

      const ok = await setup({ setupToken: srv.getSetupToken() });
      assert.equal(ok.statusCode, 200);
      assert.equal(accountsDb.getUserByUsername('intruder').role, 'admin');
      assert.equal(config.admin, null, 'setup must not write credentials to config.json');
      assert.equal((await setup({ setupToken: srv.getSetupToken() })).statusCode, 400, 'setup is one-time');
    } finally {
      accountsDb.getDb().exec("DELETE FROM sessions; DELETE FROM users WHERE username = 'intruder';");
      config.admin = savedAdmin;
      config.settings.siteUrl = savedSiteUrl;
    }
  });

  test('index.html never answers 304 / never sends an ETag (nonce-bearing CSP)', async () => {
    for (const p of ['/', '/index.html']) {
      const first = await request(p);
      assert.equal(first.statusCode, 200, p);
      assert.equal(first.headers.etag, undefined, `${p} must not send an ETag`);
      assert.match(first.headers['content-security-policy'], /'nonce-[^']+'/, p);
      const again = await request(p, { headers: { 'If-None-Match': 'W/"index-1"' } });
      assert.equal(again.statusCode, 200, `${p} must not reply 304`);
    }
  });

  test('admin cannot point the vault or dictionary at a system directory', async () => {
    const login = await request('/api/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'correct-horse' })
    });
    assert.equal(login.statusCode, 200);
    token = JSON.parse(login.body).token;
    const post = (settings) => request('/api/admin/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': token },
      body: JSON.stringify({ settings })
    });
    assert.equal((await post({ mdRoot: '/' })).statusCode, 400);
    assert.equal((await post({ mdRoot: '/etc' })).statusCode, 400);
    assert.equal((await post({ dictionaryEnabled: true, dictionaryPath: '/proc' })).statusCode, 400);
    const { config } = require('../lib/config.js');
    assert.equal(config.settings.mdRoot, VAULT);
  });
});
