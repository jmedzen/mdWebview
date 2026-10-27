/**
 * 使用者帳號（lib/accounts.js、lib/db.js、lib/session.js、lib/password.js）整合測試。
 *
 * 帳號資料庫在測試時是記憶體資料庫（NODE_TEST_CONTEXT），寄信用 log 模式，
 * 信件內容從 mailer 的 outbox 取得。Turnstile 以替換 globalThis.fetch 模擬。
 */
process.env.PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://reader.example';
process.env.MAIL_PROVIDER = 'log';
process.env.SCRYPT_LN = process.env.SCRYPT_LN || '10';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

describe('password hashing', () => {
  const passwords = require('../lib/password.js');

  test('scrypt hashes verify and reject wrong passwords', async () => {
    const hash = await passwords.hashPassword('correct horse 馬');
    assert.match(hash, /^\$scrypt\$ln=\d+,r=8,p=1\$/);
    assert.equal(await passwords.verifyPassword('correct horse 馬', hash), true);
    assert.equal(await passwords.verifyPassword('wrong', hash), false);
    // 不存在的帳號也要跑一次雜湊並回傳 false
    assert.equal(await passwords.verifyPassword('anything', null), false);
  });

  test('legacy PBKDF2 admin credentials verify (100000 and 1000 iterations) and need rehash', async () => {
    const { hashPassword: legacy } = require('../lib/auth.js');
    for (const iterations of [100000, 1000]) {
      const { salt, hash } = await legacy('old-admin-pw', undefined, iterations);
      const stored = passwords.legacyPbkdf2Hash({ salt, passwordHash: hash }, 100000);
      assert.equal(await passwords.verifyPassword('old-admin-pw', stored), true, `i=${iterations}`);
      assert.equal(await passwords.verifyPassword('nope', stored), false);
      assert.equal(passwords.needsRehash(stored), true);
    }
  });

  test('password rules', () => {
    assert.ok(passwords.validatePassword('short'));
    assert.equal(passwords.validatePassword('long enough'), null);
  });
});

describe('account HTTP API', () => {
  let srv;
  let baseUrl = '';
  let accounts;
  let db;
  let mailer;
  const realFetch = globalThis.fetch;

  function request(pathName, { method = 'GET', body, headers = {}, cookie } = {}) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
      const h = Object.assign({ Connection: 'close' }, headers);
      if (data !== null && !h['Content-Type']) h['Content-Type'] = 'application/json';
      if (data !== null) h['Content-Length'] = Buffer.byteLength(data);
      if (method !== 'GET' && !('Origin' in h)) h.Origin = baseUrl;
      if (h.Origin === null) delete h.Origin;
      if (cookie) h.Cookie = cookie;
      const req = http.request(`${baseUrl}${pathName}`, { method, agent: false, headers: h }, res => {
        let buf = '';
        res.on('data', c => { buf += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(buf); } catch (_) {}
          resolve({ status: res.statusCode, headers: res.headers, body: buf, json });
        });
      });
      req.on('error', reject);
      if (data !== null) req.write(data);
      req.end();
    });
  }

  function sessionCookie(res) {
    const list = res.headers['set-cookie'] || [];
    const c = list.find(v => /^(?:__Host-)?mdw_sid=[^;]+/.test(v) && !/Max-Age=0/.test(v));
    return c ? c.split(';')[0] : null;
  }

  function lastToken(to, kind) {
    const mails = mailer.getOutbox(to);
    assert.ok(mails.length, `expected mail to ${to}`);
    const m = mails[mails.length - 1].text.match(new RegExp(`auth=${kind}&token=([^\\s&]+)`));
    assert.ok(m, `expected ${kind} link in mail`);
    return decodeURIComponent(m[1]);
  }

  const human = { elapsedMs: 5000, website: '' };

  async function registerAndVerify(email, password) {
    const reg = await request('/api/auth/register', { method: 'POST', body: Object.assign({ email, password, agree: true }, human) });
    assert.equal(reg.status, 200, reg.body);
    const v = await request('/api/auth/verify', { method: 'POST', body: { token: lastToken(email, 'verify') } });
    assert.equal(v.status, 200, v.body);
    return sessionCookie(v);
  }

  async function makeAdmin() {
    const passwords = require('../lib/password.js');
    let user = db.getUserByEmail('boss@example.org');
    if (!user) {
      user = db.createUser({ email: 'boss@example.org', emailVerifiedAt: Date.now(), displayName: 'boss', passwordHash: await passwords.hashPassword('boss-password'), role: 'admin' });
    }
    const login = await request('/api/auth/login', { method: 'POST', body: { identifier: 'boss@example.org', password: 'boss-password' } });
    assert.equal(login.status, 200, login.body);
    return sessionCookie(login);
  }

  before(async () => {
    srv = require('../server.js');
    accounts = require('../lib/accounts.js');
    db = require('../lib/db.js');
    mailer = require('../lib/mailer.js');
    await new Promise(r => srv.server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${srv.server.address().port}`;
      r();
    }));
  });

  beforeEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.TURNSTILE_SITE_KEY;
    delete process.env.TURNSTILE_SECRET_KEY;
    accounts.accountAttempts.clear();
    require('../lib/auth.js').apiRateLimits.clear(); // 全站 30 req/s 限流，測試連發會碰到
    for (const c of Object.values(accounts._counters)) c.clear();
    mailer.clearOutbox();
  });

  after(async () => {
    globalThis.fetch = realFetch;
    srv.resetTreeWatcher(); srv.resetDictWatcher(); srv.resetConfigWatcher();
    await srv.terminateWorkerPools();
    if (srv.server.closeAllConnections) srv.server.closeAllConnections();
    await new Promise(r => srv.server.close(r));
  });

  test('health and auth config are public', async () => {
    const h = await request('/api/health');
    assert.equal(h.status, 200);
    assert.equal(h.json.accounts, true);
    const c = await request('/api/auth/config');
    assert.equal(c.json.accountsEnabled, true);
    assert.equal(c.json.registrationPaused, false);
    assert.deepEqual(c.json.providers, []);
  });

  test('register → must verify → verify link logs in → /api/me', async () => {
    const email = 'reader1@example.org';
    const reg = await request('/api/auth/register', { method: 'POST', body: Object.assign({ email, password: 'reader-pass-1' }, human) });
    assert.equal(reg.status, 200);
    assert.equal(reg.json.ok, true);

    const early = await request('/api/auth/login', { method: 'POST', body: { identifier: email, password: 'reader-pass-1' } });
    assert.equal(early.status, 403);
    assert.equal(early.json.code, 'EMAIL_NOT_VERIFIED');

    const v = await request('/api/auth/verify', { method: 'POST', body: { token: lastToken(email, 'verify') } });
    assert.equal(v.status, 200);
    const cookie = sessionCookie(v);
    assert.ok(cookie, 'verify link signs the user in');
    const setCookie = v.headers['set-cookie'].join('\n');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(cookie, /^mdw_sid=/, 'plain HTTP uses the non-__Host- name');

    const me = await request('/api/me', { cookie });
    assert.equal(me.json.user.email, email);
    assert.equal(me.json.user.emailVerified, true);
    assert.equal(me.json.user.role, 'user');

    const reuse = await request('/api/auth/verify', { method: 'POST', body: { token: lastToken(email, 'verify') } });
    assert.equal(reuse.status, 400, 'verify tokens are single-use');

    const out = await request('/api/auth/logout', { method: 'POST', body: {}, cookie });
    assert.equal(out.status, 200);
    const after = await request('/api/me', { cookie });
    assert.equal(after.json.user, null, 'logout revokes the session server-side');
  });

  test('registering an existing email gives the same reply and sends an "already registered" mail', async () => {
    await registerAndVerify('dupe@example.org', 'dupe-pass-123');
    mailer.clearOutbox();
    const again = await request('/api/auth/register', { method: 'POST', body: Object.assign({ email: 'dupe@example.org', password: 'whatever-123' }, human) });
    assert.equal(again.status, 200);
    assert.equal(again.json.ok, true);
    assert.equal(mailer.getOutbox('dupe@example.org').length, 1);
    assert.doesNotMatch(mailer.getOutbox('dupe@example.org')[0].text, /auth=verify/);
  });

  test('honeypot and too-fast forms are silently dropped', async () => {
    const trap = await request('/api/auth/register', { method: 'POST', body: { email: 'bot1@example.org', password: 'bot-pass-123', website: 'http://spam', elapsedMs: 9000 } });
    assert.equal(trap.status, 200);
    const fast = await request('/api/auth/register', { method: 'POST', body: { email: 'bot2@example.org', password: 'bot-pass-123', elapsedMs: 300 } });
    assert.equal(fast.status, 200);
    assert.equal(db.getUserByEmail('bot1@example.org'), null);
    assert.equal(db.getUserByEmail('bot2@example.org'), null);
    assert.equal(mailer.getOutbox().length, 0);
  });

  test('registration is limited per IP', async () => {
    const statuses = [];
    for (let i = 0; i < 4; i++) {
      const r = await request('/api/auth/register', { method: 'POST', body: Object.assign({ email: `burst${i}@example.org`, password: 'burst-pass-1' }, human) });
      statuses.push(r.status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 429]);
  });

  test('password login locks the account after repeated failures', async () => {
    await registerAndVerify('lock@example.org', 'lock-pass-123');
    for (let i = 0; i < accounts.MAX_ATTEMPTS; i++) {
      const r = await request('/api/auth/login', { method: 'POST', body: { identifier: 'lock@example.org', password: 'bad' } });
      assert.equal(r.status, 401);
    }
    const locked = await request('/api/auth/login', { method: 'POST', body: { identifier: 'lock@example.org', password: 'lock-pass-123' } });
    assert.equal(locked.status, 429, 'even the right password waits out the lock');
  });

  test('password reset: generic reply, single-use link, other sessions revoked', async () => {
    const oldCookie = await registerAndVerify('reset@example.org', 'reset-pass-1');
    mailer.clearOutbox();
    const unknown = await request('/api/auth/reset-request', { method: 'POST', body: Object.assign({ email: 'nobody@example.org' }, human) });
    const known = await request('/api/auth/reset-request', { method: 'POST', body: Object.assign({ email: 'reset@example.org' }, human) });
    assert.equal(unknown.status, 200);
    assert.deepEqual(unknown.json, known.json, 'reply must not reveal whether the account exists');
    assert.equal(mailer.getOutbox('nobody@example.org').length, 0);

    const token = lastToken('reset@example.org', 'reset');
    const weak = await request('/api/auth/reset', { method: 'POST', body: { token, password: 'short' } });
    assert.equal(weak.status, 400);
    const ok = await request('/api/auth/reset', { method: 'POST', body: { token, password: 'brand-new-pass' } });
    assert.equal(ok.status, 200);
    assert.ok(sessionCookie(ok));
    const again = await request('/api/auth/reset', { method: 'POST', body: { token, password: 'another-pass-1' } });
    assert.equal(again.status, 400, 'reset links are single-use');

    assert.equal((await request('/api/me', { cookie: oldCookie })).json.user, null, 'old sessions are revoked');
    const login = await request('/api/auth/login', { method: 'POST', body: { identifier: 'reset@example.org', password: 'brand-new-pass' } });
    assert.equal(login.status, 200);
  });

  test('mutations require same origin and JSON', async () => {
    const evil = await request('/api/auth/login', { method: 'POST', body: { identifier: 'x', password: 'y' }, headers: { Origin: 'https://evil.example' } });
    assert.equal(evil.status, 403);
    assert.equal(evil.json.code, 'BAD_ORIGIN');
    const form = await request('/api/auth/login', { method: 'POST', body: 'identifier=x&password=y', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal(form.status, 415);

    // 以 cookie 登入的管理員：跨站請求不能改設定
    const cookie = await makeAdmin();
    const crossSite = await request('/api/admin/settings', { method: 'POST', body: { settings: { siteName: 'pwned' } }, cookie, headers: { Origin: 'https://evil.example' } });
    assert.equal(crossSite.status, 401);
    const noOrigin = await request('/api/admin/registration', { method: 'POST', body: { mode: 'closed' }, cookie, headers: { Origin: null } });
    assert.notEqual(noOrigin.status, 200, 'cookie-authenticated mutation without Origin/Referer is refused');
    assert.equal(db.getSetting('registration.mode', 'open'), 'open');
  });

  test('admin endpoints: users are refused, admins allowed; last admin cannot be demoted', async () => {
    const userCookie = await registerAndVerify('plain@example.org', 'plain-pass-1');
    assert.equal((await request('/api/admin/users', { cookie: userCookie })).status, 401);
    assert.equal((await request('/api/admin/settings', { cookie: userCookie })).status, 401);

    const adminCookie = await makeAdmin();
    const list = await request('/api/admin/users?q=plain', { cookie: adminCookie });
    assert.equal(list.status, 200);
    assert.equal(list.json.users[0].email, 'plain@example.org');
    assert.equal((await request('/api/admin/settings', { cookie: adminCookie })).status, 200);

    const status = await request('/api/admin/status', { cookie: adminCookie });
    assert.equal(status.json.isAuthenticated, true);

    const boss = db.getUserByEmail('boss@example.org');
    // 其他管理員都降級，只剩 boss
    for (const u of db.listUsers({ role: 'admin', limit: 200 }).rows) {
      if (u.id !== boss.id) db.updateUser(u.id, { role: 'user' });
    }
    const demote = await request(`/api/admin/users/${boss.id}/role`, { method: 'POST', body: { role: 'user' }, cookie: adminCookie });
    assert.equal(demote.status, 400);
    assert.equal(demote.json.code, 'LAST_ADMIN');

    const plain = db.getUserByEmail('plain@example.org');
    const disable = await request(`/api/admin/users/${plain.id}/status`, { method: 'POST', body: { status: 'disabled' }, cookie: adminCookie });
    assert.equal(disable.status, 200);
    assert.equal((await request('/api/me', { cookie: userCookie })).json.user, null, 'disabling logs the user out');
    const blocked = await request('/api/auth/login', { method: 'POST', body: { identifier: 'plain@example.org', password: 'plain-pass-1' } });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.code, 'ACCOUNT_DISABLED');
  });

  test('legal pages come from the database and registration then requires consent', async () => {
    const before = await request('/privacy');
    assert.equal(before.status, 404);
    const adminCookie = await makeAdmin();
    const save = await request('/api/admin/legal', { method: 'POST', body: { privacy: '# 隱私權政策\n\n我們只收必要的資料。', terms: '# 使用條款\n\n請善用。' }, cookie: adminCookie });
    assert.equal(save.status, 200);
    const page = await request('/privacy');
    assert.equal(page.status, 200);
    assert.match(page.body, /我們只收必要的資料/);
    assert.match(page.headers['content-security-policy'], /script-src 'self'/);

    const noAgree = await request('/api/auth/register', { method: 'POST', body: Object.assign({ email: 'consent@example.org', password: 'consent-pass' }, human) });
    assert.equal(noAgree.status, 400);
    assert.equal(noAgree.json.code, 'CONSENT_REQUIRED');

    await request('/api/admin/legal', { method: 'POST', body: { privacy: '', terms: '' }, cookie: adminCookie });
  });

  test('Turnstile: failure and outage are refused on sign-up, success passes', async () => {
    process.env.TURNSTILE_SITE_KEY = '1x00000000000000000000AA';
    process.env.TURNSTILE_SECRET_KEY = 'test-secret';
    let mode = 'fail';
    globalThis.fetch = async (url, opts) => {
      if (String(url).startsWith('https://challenges.cloudflare.com/')) {
        if (mode === 'down') throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
        const ok = mode === 'pass';
        return new Response(JSON.stringify({ success: ok, 'error-codes': ok ? [] : ['invalid-input-response'], hostname: 'reader.example', action: 'register' }), { status: 200 });
      }
      return realFetch(url, opts);
    };
    const body = (email) => Object.assign({ email, password: 'turnstile-pass', turnstileToken: 'tok' }, human);
    const failed = await request('/api/auth/register', { method: 'POST', body: body('ts1@example.org') });
    assert.equal(failed.status, 403);
    assert.equal(failed.json.code, 'TURNSTILE_FAILED');
    mode = 'down';
    const down = await request('/api/auth/register', { method: 'POST', body: body('ts2@example.org') });
    assert.equal(down.status, 503);
    mode = 'pass';
    const ok = await request('/api/auth/register', { method: 'POST', body: body('ts3@example.org') });
    assert.equal(ok.status, 200);
    assert.ok(db.getUserByEmail('ts3@example.org'));
    assert.equal(db.getUserByEmail('ts1@example.org'), null);
  });

  test('deleting my account needs a recent re-authentication', async () => {
    const cookie = await registerAndVerify('leaver@example.org', 'leaver-pass-1');
    const user = db.getUserByEmail('leaver@example.org');
    // 讓登入時間超過 10 分鐘
    db.getDb().prepare('UPDATE sessions SET created_at = ?, reauth_at = NULL WHERE user_id = ?').run(Date.now() - 60 * 60 * 1000, user.id);
    const first = await request('/api/me', { method: 'DELETE', cookie });
    assert.equal(first.status, 403);
    assert.equal(first.json.code, 'REAUTH_REQUIRED');
    const wrong = await request('/api/auth/reauth', { method: 'POST', body: { password: 'nope' }, cookie });
    assert.equal(wrong.status, 403);
    const re = await request('/api/auth/reauth', { method: 'POST', body: { password: 'leaver-pass-1' }, cookie });
    assert.equal(re.status, 200);
    const del = await request('/api/me', { method: 'DELETE', cookie });
    assert.equal(del.status, 200);
    assert.equal(db.getUserByEmail('leaver@example.org'), null);
  });

  test('admin mail/Turnstile info: admin only, secrets never in responses', async () => {
    const userCookie = await registerAndVerify('info-plain@example.org', 'plain-pass-123');
    const adminCookie = await makeAdmin();
    process.env.TURNSTILE_SITE_KEY = '0x4AAAAAAAsitekey';
    process.env.TURNSTILE_SECRET_KEY = 'super-secret-turnstile-value';
    const saved = { key: process.env.MAIL_API_KEY, from: process.env.MAIL_FROM };
    process.env.MAIL_API_KEY = 'super-secret-mail-key';
    process.env.MAIL_FROM = 'mdWebview <noreply@mail.example>';
    try {
      for (const [method, route] of [['GET', '/api/admin/mail/dns'], ['GET', '/api/admin/turnstile'], ['POST', '/api/admin/turnstile/test']]) {
        const anon = await request(route, { method, body: method === 'POST' ? {} : undefined });
        assert.ok([401, 403].includes(anon.status), `${route} anonymous -> ${anon.status}`);
        const plain = await request(route, { method, body: method === 'POST' ? {} : undefined, cookie: userCookie });
        assert.ok([401, 403].includes(plain.status), `${route} as normal user -> ${plain.status}`);
      }

      const ts = await request('/api/admin/turnstile', { cookie: adminCookie });
      assert.equal(ts.status, 200);
      assert.equal(ts.json.siteKey, '0x4AAAAAAAsitekey');
      assert.equal(ts.json.secretSet, true);
      assert.equal(ts.json.configured, true);
      assert.equal(ts.json.usesTestKeys, false);
      assert.deepEqual(ts.json.envVars, [{ name: 'TURNSTILE_SITE_KEY', set: true }, { name: 'TURNSTILE_SECRET_KEY', set: true }]);
      assert.ok(ts.json.protects.length >= 4);

      const mail = await request('/api/admin/mail', { cookie: adminCookie });
      assert.equal(mail.json.senderDomain, 'mail.example');
      assert.equal(mail.json.apiKeySet, true);
      assert.deepEqual(mail.json.missingEnv, []);

      const overview = await request('/api/admin/accounts-overview', { cookie: adminCookie });
      for (const res of [ts, mail, overview]) {
        assert.ok(!res.body.includes('super-secret-turnstile-value'), 'Turnstile secret leaked');
        assert.ok(!res.body.includes('super-secret-mail-key'), 'mail API key leaked');
      }
      assert.equal(overview.json.turnstile.siteKey, '0x4AAAAAAAsitekey');
    } finally {
      for (const [k, v] of [['MAIL_API_KEY', saved.key], ['MAIL_FROM', saved.from]]) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });

  test('admin Turnstile secret check tells a wrong secret from a right one', async () => {
    const adminCookie = await makeAdmin();
    const notSet = await request('/api/admin/turnstile/test', { method: 'POST', body: {}, cookie: adminCookie });
    assert.equal(notSet.json.state, 'not_set');

    process.env.TURNSTILE_SITE_KEY = '0x4AAAAAAAsitekey';
    process.env.TURNSTILE_SECRET_KEY = 'secret-under-test';
    let reply = { success: false, 'error-codes': ['invalid-input-response'] };
    let seenSecret = null;
    globalThis.fetch = async (url, opts) => {
      if (String(url).startsWith('https://challenges.cloudflare.com/')) {
        if (reply === 'down') throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
        seenSecret = new URLSearchParams(String(opts.body)).get('secret');
        return new Response(JSON.stringify(reply), { status: 200 });
      }
      return realFetch(url, opts);
    };
    const check = async () => (await request('/api/admin/turnstile/test', { method: 'POST', body: {}, cookie: adminCookie })).json;

    assert.equal((await check()).state, 'valid');
    assert.equal(seenSecret, 'secret-under-test');
    reply = { success: false, 'error-codes': ['invalid-input-secret'] };
    assert.equal((await check()).state, 'invalid_secret');
    reply = { success: true, 'error-codes': [] };
    assert.equal((await check()).state, 'test_secret');
    reply = 'down';
    const down = await check();
    assert.equal(down.state, 'unreachable');
    assert.equal(down.detail, 'timeout');
    assert.ok(db.listEvents({ event: 'admin_turnstile_check', limit: 5 }).length >= 1);
  });

  // 網頁設定的測試：先拿掉測試檔開頭設定的環境變數，結束時清掉網頁設定並還原。
  async function withWebSettings(run) {
    const integrations = require('../lib/integrations.js');
    const names = ['MAIL_PROVIDER', 'MAIL_API_KEY', 'MAIL_FROM', 'TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY'];
    const saved = Object.fromEntries(names.map(n => [n, process.env[n]]));
    names.forEach(n => delete process.env[n]);
    try {
      await run(integrations);
    } finally {
      for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }
      const clear = { mailProvider: '', mailApiKey: '', mailFrom: '', turnstileSiteKey: '', turnstileSecret: '' };
      const keep = Object.fromEntries(names.map(n => [n, process.env[n]]));
      names.forEach(n => delete process.env[n]);
      integrations.set(clear);
      for (const n of names) { if (keep[n] !== undefined) process.env[n] = keep[n]; }
    }
  }

  test('integrations: secrets are encrypted at rest and environment variables win', async () => {
    await withWebSettings(async (integrations) => {
      integrations.set({ mailApiKey: 're_secret_value_1234', mailFrom: 'Site <noreply@web.example>' });
      const raw = db.getSetting('integrations.mail.apiKey');
      assert.ok(raw.startsWith('v1:'), 'stored encrypted');
      assert.ok(!raw.includes('re_secret_value_1234'));
      assert.equal(integrations.get('mailApiKey'), 're_secret_value_1234');
      const d = integrations.describe('mailApiKey');
      assert.deepEqual([d.source, d.set, d.value, d.masked, d.locked], ['web', true, null, '••••1234', false]);
      assert.equal(integrations.describe('mailFrom').value, 'Site <noreply@web.example>');

      process.env.MAIL_FROM = 'Env <noreply@env.example>';
      assert.equal(integrations.get('mailFrom'), 'Env <noreply@env.example>');
      assert.equal(integrations.describe('mailFrom').locked, true);
      assert.deepEqual(integrations.set({ mailFrom: 'x@y.example' }), [], 'env-locked field is not written');
      delete process.env.MAIL_FROM;
      assert.equal(integrations.get('mailFrom'), 'Site <noreply@web.example>');

      // 被竄改或用別的金鑰加密的值：當作未設定，並標示需要重填。
      db.setSetting('integrations.mail.apiKey', 'v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AAAA');
      assert.equal(integrations.get('mailApiKey'), '');
      assert.equal(integrations.describe('mailApiKey').unreadable, true);
    });
  });

  test('admin can set up Resend on the web: key is checked, stored encrypted, never echoed', async () => {
    await withWebSettings(async (integrations) => {
      const adminCookie = await makeAdmin();
      let resendReply = { status: 401, body: { name: 'validation_error', message: 'API key is invalid' } };
      const sent = [];
      globalThis.fetch = async (url, opts) => {
        const u = String(url);
        if (u === 'https://api.resend.com/domains') {
          return new Response(JSON.stringify(resendReply.body), { status: resendReply.status });
        }
        if (u === 'https://api.resend.com/emails') {
          sent.push({ auth: opts.headers.Authorization, body: JSON.parse(opts.body) });
          return new Response(JSON.stringify({ id: 'mail-1' }), { status: 200 });
        }
        return realFetch(url, opts);
      };
      const save = body => request('/api/admin/mail/settings', { method: 'POST', body, cookie: adminCookie });

      const before = await request('/api/admin/accounts-overview', { cookie: adminCookie });
      assert.equal(before.json.setup.steps.find(st => st.id === 'mail').done, false);

      const badFrom = await save({ provider: 'resend', from: 'not an address', apiKey: 're_whatever_12345' });
      assert.equal(badFrom.status, 400);
      assert.equal(badFrom.json.code, 'INVALID_FROM');

      const badKey = await save({ provider: 'resend', from: 'Reader <noreply@mail.example>', apiKey: 're_wrong_key_12345' });
      assert.equal(badKey.status, 400);
      assert.equal(badKey.json.code, 'INVALID_API_KEY');
      assert.equal(integrations.get('mailApiKey'), '', 'rejected key is not saved');

      resendReply = { status: 401, body: { name: 'restricted_api_key', message: 'This API key is restricted to only send emails' } };
      const ok = await save({ provider: 'resend', from: 'Reader <noreply@mail.example>', apiKey: 're_good_key_abcd' });
      assert.equal(ok.status, 200, ok.body);
      assert.equal(ok.json.keyCheck.state, 'valid_send_only');
      assert.equal(ok.json.mail.configured, true);
      assert.equal(ok.json.mail.settings.apiKey.masked, '••••abcd');
      assert.ok(!ok.body.includes('re_good_key_abcd'), 'key is never echoed');
      assert.ok(!db.getSetting('integrations.mail.apiKey').includes('re_good_key_abcd'));
      assert.equal(ok.json.setup.steps.find(st => st.id === 'mail').done, true);
      assert.equal(ok.json.setup.steps.find(st => st.id === 'mailTest').done, false);

      const mailStatus = await request('/api/admin/mail', { cookie: adminCookie });
      assert.ok(!mailStatus.body.includes('re_good_key_abcd'));

      const test = await request('/api/admin/mail/test', { method: 'POST', body: {}, cookie: adminCookie });
      assert.equal(test.status, 200, test.body);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].auth, 'Bearer re_good_key_abcd');
      assert.equal(sent[0].body.from, 'Reader <noreply@mail.example>');
      assert.equal(test.json.setup.steps.find(st => st.id === 'mailTest').done, true);

      // 完整權限金鑰：寄件網域沒驗證時提醒；換金鑰會讓「測試信」步驟重來。
      resendReply = { status: 200, body: { data: [{ name: 'mail.example', status: 'pending', region: 'us-east-1' }] } };
      const full = await save({ apiKey: 're_full_access_key_9999' });
      assert.equal(full.json.keyCheck.state, 'valid');
      assert.ok(full.json.warnings.some(w => w.includes('pending')));
      assert.equal(full.json.setup.steps.find(st => st.id === 'mailTest').done, false);

      const cleared = await save({ clearApiKey: true });
      assert.equal(cleared.json.mail.apiKeySet, false);
      assert.equal(cleared.json.mail.configured, false);

      // 登入超過 10 分鐘：要先重新驗證身分。
      const admin = db.getUserByEmail('boss@example.org');
      db.getDb().prepare('UPDATE sessions SET created_at = ?, reauth_at = NULL WHERE user_id = ?').run(Date.now() - 60 * 60 * 1000, admin.id);
      const stale = await save({ apiKey: 're_good_key_abcd' });
      assert.equal(stale.status, 403);
      assert.equal(stale.json.code, 'REAUTH_REQUIRED');
    });
  });

  test('admin can set up Turnstile on the web and run a live check', async () => {
    await withWebSettings(async (integrations) => {
      const adminCookie = await makeAdmin();
      let siteverify = { success: false, 'error-codes': ['invalid-input-secret'] };
      globalThis.fetch = async (url, opts) => {
        if (String(url).startsWith('https://challenges.cloudflare.com/')) {
          return new Response(JSON.stringify(siteverify), { status: 200 });
        }
        return realFetch(url, opts);
      };
      const save = body => request('/api/admin/turnstile/settings', { method: 'POST', body, cookie: adminCookie });

      const badSite = await save({ siteKey: 'nonsense', secret: '0x4AAAA-secret' });
      assert.equal(badSite.json.code, 'INVALID_SITE_KEY');
      const badSecret = await save({ siteKey: '0x4AAAAAAAwebsitekey', secret: '0x4AAAA-wrong-secret' });
      assert.equal(badSecret.status, 400);
      assert.equal(badSecret.json.code, 'INVALID_SECRET');
      assert.equal(integrations.get('turnstileSiteKey'), '', 'nothing saved on a bad secret');

      siteverify = { success: false, 'error-codes': ['invalid-input-response'] };
      const ok = await save({ siteKey: '0x4AAAAAAAwebsitekey', secret: '0x4AAAA-right-secret' });
      assert.equal(ok.status, 200, ok.body);
      assert.equal(ok.json.info.configured, true);
      assert.equal(ok.json.info.settings.secret.source, 'web');
      assert.ok(!ok.body.includes('0x4AAAA-right-secret'));
      const cfg = await request('/api/auth/config');
      assert.equal(cfg.json.turnstileSiteKey, '0x4AAAAAAAwebsitekey', 'sign-up forms pick up the new site key');

      siteverify = { success: true, hostname: 'other.example', action: 'admin-test' };
      const wrongHost = await request('/api/admin/turnstile/verify', { method: 'POST', body: { token: 'tok' }, cookie: adminCookie });
      assert.equal(wrongHost.json.ok, false);
      assert.equal(wrongHost.json.reason, 'hostname-mismatch');

      siteverify = { success: true, hostname: 'reader.example', action: 'admin-test' };
      const live = await request('/api/admin/turnstile/verify', { method: 'POST', body: { token: 'tok' }, cookie: adminCookie });
      assert.equal(live.json.ok, true);
      assert.equal(live.json.setup.steps.find(st => st.id === 'turnstileTest').done, true);

      const off = await save({ disable: true });
      assert.equal(off.json.info.configured, false);
      assert.equal((await request('/api/auth/config')).json.turnstileSiteKey, '');
    });
  });

  // 第三方登入設定的測試：清掉環境變數與網頁設定，結束時還原。
  async function withSso(run) {
    const integrations = require('../lib/integrations.js');
    const names = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET', 'APPLE_CLIENT_ID', 'APPLE_TEAM_ID', 'APPLE_KEY_ID', 'APPLE_PRIVATE_KEY', 'APPLE_PRIVATE_KEY_PATH'];
    const saved = Object.fromEntries(names.map(n => [n, process.env[n]]));
    names.forEach(n => delete process.env[n]);
    const clearWeb = () => {
      integrations.set({ googleClientId: '', googleClientSecret: '', facebookAppId: '', facebookAppSecret: '', appleClientId: '', appleTeamId: '', appleKeyId: '', applePrivateKey: '' });
      for (const id of ['google', 'facebook', 'apple']) db.setSetting(`oauth.${id}.enabled`, '');
    };
    clearWeb();
    try {
      await run(integrations);
    } finally {
      names.forEach(n => delete process.env[n]);
      clearWeb();
      for (const n of names) { if (saved[n] !== undefined) process.env[n] = saved[n]; }
    }
  }

  test('admin can set up Google, Facebook and Apple sign-in on the web, with a switch for each', async () => {
    await withSso(async (integrations) => {
      const crypto = require('crypto');
      const rq = (...args) => { require('../lib/auth.js').apiRateLimits.clear(); return request(...args); }; // 全站 30 req/s 限流
      const adminCookie = await makeAdmin();
      const userCookie = await registerAndVerify('sso-plain@example.org', 'plain-pass-123');
      const post = (route, body, cookie = adminCookie) => rq(route, { method: 'POST', body, cookie });
      const save = body => post('/api/admin/auth-providers/settings', body);
      const providers = async () => (await rq('/api/admin/auth-providers', { cookie: adminCookie })).json.providers;
      const find = (list, id) => list.find(p => p.id === id);

      let google = { status: 400, body: { error: 'invalid_client', error_description: 'The OAuth client was not found.' } };
      let facebook = { status: 400, body: { error: { message: 'Error validating client secret.' } } };
      let apple = { status: 400, body: { error: 'invalid_client' } };
      const seen = [];
      globalThis.fetch = async (url, opts) => {
        const u = String(url);
        const reply = r => new Response(JSON.stringify(r.body), { status: r.status });
        if (u === 'https://oauth2.googleapis.com/token') { seen.push(['google', new URLSearchParams(String(opts.body)).get('client_secret')]); return reply(google); }
        if (u.startsWith('https://graph.facebook.com/oauth/access_token')) { seen.push(['facebook', new URL(u).searchParams.get('client_secret')]); return reply(facebook); }
        if (u === 'https://appleid.apple.com/auth/token') { seen.push(['apple', new URLSearchParams(String(opts.body)).get('client_secret')]); return reply(apple); }
        return realFetch(url, opts);
      };

      // 只有管理員能看、能改
      for (const [method, route] of [['GET', '/api/admin/auth-providers'], ['POST', '/api/admin/auth-providers/settings'], ['POST', '/api/admin/auth-providers/check']]) {
        const anon = await rq(route, { method, body: method === 'POST' ? {} : undefined });
        assert.ok([401, 403].includes(anon.status), `${route} anonymous`);
        const plain = await rq(route, { method, body: method === 'POST' ? {} : undefined, cookie: userCookie });
        assert.ok([401, 403].includes(plain.status), `${route} normal user`);
      }

      // 一開始三家都沒設定，登入畫面沒有任何第三方登入
      let list = await providers();
      assert.deepEqual(list.map(p => [p.id, p.configured, p.active]), [['google', false, false], ['facebook', false, false], ['apple', false, false]]);
      assert.deepEqual((await rq('/api/auth/config')).json.providers, []);
      assert.equal((await post('/api/admin/auth-providers/settings', { provider: 'nope' })).json.code, 'UNKNOWN_PROVIDER');

      // Google：格式不對、金鑰被拒絕都不會存；通過才存，且不會原樣回傳
      assert.equal((await save({ provider: 'google', fields: { clientId: 'abc', clientSecret: 'GOCSPX-secret-value-1' } })).json.code, 'INVALID_FIELD');
      const rejected = await save({ provider: 'google', fields: { clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-wrong-secret' } });
      assert.equal(rejected.status, 400);
      assert.equal(rejected.json.code, 'INVALID_CREDENTIALS');
      assert.equal(integrations.get('googleClientId'), '', 'nothing saved when the provider rejects the key');
      google = { status: 400, body: { error: 'invalid_grant', error_description: 'Malformed auth code.' } };
      const okGoogle = await save({ provider: 'google', fields: { clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret-value-1' } });
      assert.equal(okGoogle.status, 200, okGoogle.body);
      assert.equal(okGoogle.json.check.state, 'valid');
      assert.equal(seen[seen.length - 1][1], 'GOCSPX-secret-value-1', 'the candidate secret is what gets checked');
      assert.ok(!okGoogle.body.includes('GOCSPX-secret-value-1'), 'secret is never echoed');
      assert.ok(!db.getSetting('integrations.google.clientSecret').includes('GOCSPX-secret-value-1'), 'stored encrypted');
      google = find(okGoogle.json.providers, 'google');
      assert.deepEqual([google.configured, google.enabled, google.active], [true, true, true]);
      assert.equal(google.fields.find(f => f.key === 'clientId').value, '123-abc.apps.googleusercontent.com');
      assert.equal(google.fields.find(f => f.key === 'clientSecret').value, null);
      assert.equal(google.callbackUrl, 'https://reader.example/api/auth/google/callback');
      assert.deepEqual((await rq('/api/auth/config')).json.providers, ['google']);
      assert.equal(okGoogle.json.setup.steps.find(st => st.id === 'sso').done, true);

      // 開關：關掉後登入畫面不再出現，入口回 404；金鑰還在
      const off = await save({ provider: 'google', enabled: false });
      assert.equal(find(off.json.providers, 'google').enabled, false);
      assert.equal(find(off.json.providers, 'google').configured, true);
      assert.deepEqual((await rq('/api/auth/config')).json.providers, []);
      assert.equal((await rq('/api/auth/google')).status, 404);
      assert.equal(off.json.setup.steps.find(st => st.id === 'sso').done, false);
      const on = await save({ provider: 'google', enabled: true });
      assert.equal(find(on.json.providers, 'google').active, true);
      assert.equal((await rq('/api/auth/google', { headers: {} })).status, 302);

      // 沒設定的不能開
      assert.equal((await save({ provider: 'facebook', enabled: true })).json.code, 'NOT_CONFIGURED');

      // Facebook
      assert.equal((await save({ provider: 'facebook', fields: { appId: 'abc', appSecret: 'x'.repeat(32) } })).json.code, 'INVALID_FIELD');
      assert.equal((await save({ provider: 'facebook', fields: { appId: '1234567890', appSecret: 'bad'.repeat(10) } })).json.code, 'INVALID_CREDENTIALS');
      facebook = { status: 200, body: { access_token: '1234567890|app-token', token_type: 'bearer' } };
      const okFb = await save({ provider: 'facebook', fields: { appId: '1234567890', appSecret: 'f'.repeat(32) } });
      assert.equal(okFb.status, 200, okFb.body);
      assert.equal(find(okFb.json.providers, 'facebook').active, true);
      assert.ok(!okFb.body.includes('f'.repeat(32)));

      // Apple：私鑰格式不對被擋；真的 EC 私鑰可以，回應與資料庫都沒有私鑰內容
      const apple1 = { provider: 'apple', fields: { clientId: 'co.example.web', teamId: 'ABCDE12345', keyId: 'KEY1234567', privateKey: 'not a key' } };
      assert.equal((await save(apple1)).json.code, 'INVALID_FIELD');
      assert.equal((await save({ provider: 'apple', fields: { clientId: 'co.example.web', teamId: 'short', keyId: 'KEY1234567' } })).json.code, 'INVALID_FIELD');
      const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
      apple = { status: 400, body: { error: 'invalid_grant' } };
      const okApple = await save({ provider: 'apple', fields: { clientId: 'co.example.web', teamId: 'ABCDE12345', keyId: 'KEY1234567', privateKey: pem } });
      assert.equal(okApple.status, 200, okApple.body);
      assert.equal(okApple.json.check.state, 'valid');
      const jwt = seen[seen.length - 1][1];
      assert.equal(jwt.split('.').length, 3, 'Apple client secret is a signed JWT');
      const pemBody = pem.split('\n').filter(l => l && !l.startsWith('-----'))[1];
      assert.ok(!okApple.body.includes(pemBody) && !db.getSetting('integrations.apple.privateKey').includes(pemBody), 'private key is not echoed or stored in clear');
      const appleStatus = find(okApple.json.providers, 'apple');
      assert.equal(appleStatus.active, true);
      assert.equal(appleStatus.fields.find(f => f.key === 'privateKey').masked, '••••');
      assert.deepEqual((await rq('/api/auth/config')).json.providers.sort(), ['apple', 'facebook', 'google']);

      // 「檢查設定」用已存的金鑰再問一次服務商
      apple = { status: 400, body: { error: 'invalid_client' } };
      const recheck = await post('/api/admin/auth-providers/check', { provider: 'apple' });
      assert.equal(recheck.json.check.state, 'invalid');

      // 金鑰對、但回調網址沒登記：照存，並提醒
      google = { status: 400, body: { error: 'redirect_uri_mismatch' } };
      const mismatch = await post('/api/admin/auth-providers/check', { provider: 'google' });
      assert.equal(mismatch.json.check.state, 'redirect_mismatch');

      // 只換一個欄位時，其他金鑰留空代表不改
      google = { status: 400, body: { error: 'invalid_grant' } };
      const keep = await save({ provider: 'google', fields: { clientId: '999-zzz.apps.googleusercontent.com', clientSecret: '' } });
      assert.equal(keep.status, 200, keep.body);
      assert.equal(integrations.get('googleClientSecret'), 'GOCSPX-secret-value-1');
      assert.equal(integrations.get('googleClientId'), '999-zzz.apps.googleusercontent.com');

      // 環境變數優先：鎖定、網頁改不動
      process.env.GOOGLE_CLIENT_ID = '777-env.apps.googleusercontent.com';
      const locked = find(await providers(), 'google').fields.find(f => f.key === 'clientId');
      assert.deepEqual([locked.locked, locked.source, locked.value], [true, 'env', '777-env.apps.googleusercontent.com']);
      await save({ provider: 'google', fields: { clientId: '555-web.apps.googleusercontent.com' } });
      assert.equal(integrations.get('googleClientId'), '777-env.apps.googleusercontent.com');
      delete process.env.GOOGLE_CLIENT_ID;

      // 清掉網頁上設定的金鑰
      const cleared = await save({ provider: 'facebook', clear: ['appId', 'appSecret'] });
      assert.equal(find(cleared.json.providers, 'facebook').configured, false);
      assert.ok(!(await rq('/api/auth/config')).json.providers.includes('facebook'));

      // 登入超過 10 分鐘：要先重新驗證身分
      const admin = db.getUserByEmail('boss@example.org');
      db.getDb().prepare('UPDATE sessions SET created_at = ?, reauth_at = NULL WHERE user_id = ?').run(Date.now() - 60 * 60 * 1000, admin.id);
      const stale = await save({ provider: 'google', enabled: false });
      assert.equal(stale.status, 403);
      assert.equal(stale.json.code, 'REAUTH_REQUIRED');
    });
  });

  test('turning off a sign-in method cannot lock the admin out', async () => {
    await withSso(async (integrations) => {
      const adminCookie = await makeAdmin();
      const admin = db.getUserByEmail('boss@example.org');
      integrations.set({ googleClientId: '123-abc.apps.googleusercontent.com', googleClientSecret: 'GOCSPX-secret-value-1' });
      db.linkIdentity(admin.id, 'google', 'google-sub-boss', 'boss@example.org');
      const savedHash = db.getUserById(admin.id).password_hash;
      try {
        db.updateUser(admin.id, { passwordHash: null });
        const off = await request('/api/admin/auth-providers/settings', { method: 'POST', body: { provider: 'google', enabled: false }, cookie: adminCookie });
        assert.equal(off.status, 400);
        assert.equal(off.json.code, 'WOULD_LOCK_OUT');
        assert.equal(require('../lib/oauth.js').isEnabled('google'), true, 'still enabled');
        const clear = await request('/api/admin/auth-providers/settings', { method: 'POST', body: { provider: 'google', clear: ['clientSecret'] }, cookie: adminCookie });
        assert.equal(clear.json.code, 'WOULD_LOCK_OUT');
        db.updateUser(admin.id, { passwordHash: savedHash });
        const ok = await request('/api/admin/auth-providers/settings', { method: 'POST', body: { provider: 'google', enabled: false }, cookie: adminCookie });
        assert.equal(ok.status, 200, ok.body);
      } finally {
        db.updateUser(admin.id, { passwordHash: savedHash });
        db.unlinkIdentity(admin.id, 'google');
      }
    });
  });

  test('Apple private key can still come from APPLE_PRIVATE_KEY_PATH', async () => {
    await withSso(async (integrations) => {
      const crypto = require('crypto');
      const os = require('os');
      const adminCookie = await makeAdmin();
      const file = path.join(os.tmpdir(), `mdw-apple-${process.pid}.p8`);
      fs.writeFileSync(file, crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
      process.env.APPLE_PRIVATE_KEY_PATH = file;
      try {
        integrations.set({ appleClientId: 'co.example.web', appleTeamId: 'ABCDE12345', appleKeyId: 'KEY1234567' });
        const apple = (await request('/api/admin/auth-providers', { cookie: adminCookie })).json.providers.find(p => p.id === 'apple');
        const pk = apple.fields.find(f => f.key === 'privateKey');
        assert.deepEqual([apple.configured, pk.source, pk.locked, pk.set], [true, 'file', true, true]);
        assert.equal(apple.keyFile.readable, true);
        fs.rmSync(file);
        const gone = (await request('/api/admin/auth-providers', { cookie: adminCookie })).json.providers.find(p => p.id === 'apple');
        assert.equal(gone.configured, false);
        assert.equal(gone.keyFile.readable, false);
      } finally {
        fs.rmSync(file, { force: true });
        delete process.env.APPLE_PRIVATE_KEY_PATH;
      }
    });
  });

  test('admin mail DNS check accepts both Resend record styles and does not need MX', async () => {
    await withWebSettings(async () => {
      const adminCookie = await makeAdmin();
      const mailerMod = require('../lib/mailer.js');
      const dns = require('dns');
      const realResolver = dns.promises.Resolver;
      const nodata = () => Object.assign(new Error('nodata'), { code: 'ENODATA' });
      const records = { txt: {}, cname: {} };
      dns.promises.Resolver = class {
        async resolveTxt(name) { if (records.txt[name]) return records.txt[name]; throw nodata(); }
        async resolveCname(name) { if (records.cname[name]) return records.cname[name]; throw nodata(); }
      };
      try {
        process.env.MAIL_FROM = 'mdWebview <noreply@dev.mail.example>';
        const check = async () => {
          const res = await request('/api/admin/mail/dns', { cookie: adminCookie });
          assert.equal(res.status, 200);
          return { json: res.json, byId: Object.fromEntries(res.json.records.map(r => [r.id, r])) };
        };

        // 什麼都沒有
        let r = await check();
        assert.equal(r.json.domain, 'dev.mail.example');
        assert.deepEqual(r.json.records.map(x => x.id), ['dkim', 'send', 'dmarc'], 'no MX row');
        assert.ok(r.json.records.filter(x => x.required).every(x => !x.ok));

        // 新版（只開寄件）：DKIM + send、rsend 兩筆 CNAME，沒有 MX，也沒有 TXT
        records.txt['resend._domainkey.dev.mail.example'] = [['p=' + 'A'.repeat(60)]];
        records.cname['send.dev.mail.example'] = ['send.forge.rmta.net'];
        r = await check();
        assert.equal(r.byId.dkim.ok, true);
        assert.equal(r.byId.send.ok, true);
        assert.equal(r.byId.send.required, true);
        assert.ok(r.byId.send.found[0].startsWith('CNAME '), 'shows the CNAME found');
        assert.match(r.json.note, /rsend\.dev\.mail\.example/, 'nudges about the missing rsend CNAME');
        assert.equal(r.byId.dmarc.ok, false);
        assert.equal(r.byId.dmarc.required, false);
        assert.equal(r.byId.dmarc.name, '_dmarc.dev.mail.example');
        assert.ok(r.byId.dkim.found[0].length < 60, 'DKIM value is shortened');

        records.cname['rsend.dev.mail.example'] = ['rsend-apne1.forge.rmta.net'];
        r = await check();
        assert.equal(r.json.note, '');

        // 舊版：send 的 SPF TXT
        delete records.cname['send.dev.mail.example'];
        delete records.cname['rsend.dev.mail.example'];
        records.txt['send.dev.mail.example'] = [['v=spf1 include:amazonses.com ~all']];
        r = await check();
        assert.equal(r.byId.send.ok, true);

        // 指到別處的 CNAME 不算
        delete records.txt['send.dev.mail.example'];
        records.cname['send.dev.mail.example'] = ['example.org'];
        r = await check();
        assert.equal(r.byId.send.ok, false);

        records.txt['_dmarc.dev.mail.example'] = [['v=DMARC1; p=none;']];
        assert.equal((await check()).byId.dmarc.ok, true);

        delete process.env.MAIL_FROM;
        const none = (await request('/api/admin/mail/dns', { cookie: adminCookie })).json;
        assert.equal(none.domain, null);
        assert.deepEqual(none.records, []);
        assert.equal(mailerMod.getSenderDomain(), '');
      } finally {
        dns.promises.Resolver = realResolver;
      }
    });
  });

  test('admin mail DNS check also reports the status Resend itself gives the domain', async () => {
    await withWebSettings(async (integrations) => {
      const adminCookie = await makeAdmin();
      const dns = require('dns');
      const realResolver = dns.promises.Resolver;
      dns.promises.Resolver = class {
        async resolveTxt() { throw Object.assign(new Error('nodata'), { code: 'ENODATA' }); }
        async resolveCname() { throw Object.assign(new Error('nodata'), { code: 'ENODATA' }); }
      };
      let reply = { status: 200, body: { data: [{ name: 'dev.mail.example', status: 'verified', region: 'ap-northeast-1' }] } };
      globalThis.fetch = async (url, opts) => {
        if (String(url) === 'https://api.resend.com/domains') return new Response(JSON.stringify(reply.body), { status: reply.status });
        return realFetch(url, opts);
      };
      try {
        integrations.set({ mailProvider: 'resend', mailApiKey: 're_full_key_1234', mailFrom: 'noreply@dev.mail.example' });
        const get = async () => (await request('/api/admin/mail/dns', { cookie: adminCookie })).json;
        assert.deepEqual((await get()).resend, { state: 'known', domainStatus: 'verified' });

        reply = { status: 200, body: { data: [{ name: 'other.example', status: 'verified' }] } };
        assert.equal((await get()).resend.state, 'domain_missing');

        reply = { status: 401, body: { name: 'restricted_api_key', message: 'restricted' } };
        assert.equal((await get()).resend.state, 'send_only');

        integrations.set({ mailApiKey: '' });
        assert.equal((await get()).resend, null, 'no key, no Resend lookup');
      } finally {
        dns.promises.Resolver = realResolver;
      }
    });
  });

  test('every admin config card has a data-card key and the status-light code uses only known keys', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    const cards = [...html.matchAll(/<div[^>]*class="config-card[ "][^>]*>/g)].map(m => m[0]);
    assert.ok(cards.length >= 20);
    const keys = cards.map(c => { const m = c.match(/data-card="([^"]+)"/); assert.ok(m, `config card without data-card: ${c}`); return m[1]; });
    assert.equal(new Set(keys).size, keys.length, 'data-card keys must be unique');
    const used = [...app.matchAll(/\b(?:setAdminCardLight|L)\('([a-z]+)'/g)].map(m => m[1]);
    for (const k of used) assert.ok(keys.includes(k), `status light for unknown card ${k}`);
  });

  test('every admin account route has a matching call in the admin UI (app.js)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    for (const route of accounts.ADMIN_ROUTES) {
      const pattern = route.split('/:id').map(s => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('/\\$\\{[^}]+\\}');
      assert.match(src, new RegExp(`['\`]${pattern}(?:[?'\`]|\\$\\{)`), `admin UI is missing ${route}`);
    }
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.match(html, /id="adminTabUsersBtn"/);
    assert.match(html, /id="adminTabAccountSystemBtn"/);
  });

  test('legal text is not shipped in the repository', () => {
    // 條款內容只存在帳號資料庫（後台編輯），程式碼與文件裡不應出現條款全文的檔案。
    const files = fs.readdirSync(ROOT);
    assert.ok(!files.some(f => /^(privacy|terms)(-policy)?\.(md|html)$/i.test(f)));
  });
});
