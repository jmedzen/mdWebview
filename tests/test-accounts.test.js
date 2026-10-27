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
