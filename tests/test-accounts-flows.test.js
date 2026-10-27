/**
 * 帳號系統 HTTP 流程補充測試（與 test-accounts.test.js 共用相同的測試方式）：
 * 第三方登入的帳號對應規則、管理 API 授權矩陣、登入限速與鎖定、註冊模式與邀請碼、
 * 驗證／重設連結過期、密碼與 Email 變更、session 管理、條款版本、匯出與刪除、
 * 管理員動作的重新驗證與最後管理員保護、舊管理員搬遷、CSRF 規則。
 * 外部服務以替換 globalThis.fetch 模擬；不連網。
 */
process.env.PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://reader.example';
process.env.MAIL_PROVIDER = 'log';
process.env.SCRYPT_LN = process.env.SCRYPT_LN || '10';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');

const DAY = 24 * 60 * 60 * 1000;

describe('account flows over HTTP', () => {
  let srv, baseUrl = '', accounts, db, mailer, session;
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
  // 全站 30 req/s 限流：測試連發請求時每次先清掉
  const rq = (...args) => { require('../lib/auth.js').apiRateLimits.clear(); return request(...args); };

  const sessionCookie = res => {
    const c = (res.headers['set-cookie'] || []).find(v => /^(?:__Host-)?mdw_sid=[^;]+/.test(v) && !/Max-Age=0/.test(v));
    return c ? c.split(';')[0] : null;
  };
  const cookieOf = (res, name) => {
    const c = (res.headers['set-cookie'] || []).find(v => v.startsWith(`${name}=`) && !/Max-Age=0/.test(v));
    return c ? c.split(';')[0] : null;
  };
  function lastToken(to, kind) {
    to = to.toLowerCase();
    const mails = mailer.getOutbox(to);
    assert.ok(mails.length, `expected mail to ${to}`);
    const m = mails[mails.length - 1].text.match(new RegExp(`auth=${kind}&token=([^\\s&]+)`));
    assert.ok(m, `expected ${kind} link in mail to ${to}`);
    return decodeURIComponent(m[1]);
  }
  const human = { elapsedMs: 5000, website: '' };
  const post = (route, body, cookie) => rq(route, { method: 'POST', body, cookie });

  async function registerAndVerify(email, password = 'reader-pass-1') {
    const reg = await post('/api/auth/register', Object.assign({ email, password, agree: true }, human));
    assert.equal(reg.status, 200, reg.body);
    const v = await post('/api/auth/verify', { token: lastToken(email, 'verify') });
    assert.equal(v.status, 200, v.body);
    return sessionCookie(v);
  }
  async function loginAs(identifier, password) {
    const r = await post('/api/auth/login', { identifier, password });
    assert.equal(r.status, 200, r.body);
    return sessionCookie(r);
  }
  async function makeAdmin(email = 'boss@example.org') {
    let user = db.getUserByEmail(email);
    if (!user) {
      user = db.createUser({ email, emailVerifiedAt: Date.now(), displayName: 'boss', passwordHash: await require('../lib/password.js').hashPassword('boss-password'), role: 'admin' });
    }
    return loginAs(email, 'boss-password');
  }
  const staleSession = (userId) => db.getDb().prepare('UPDATE sessions SET created_at = ?, reauth_at = NULL WHERE user_id = ?').run(Date.now() - 60 * 60 * 1000, userId);

  before(async () => {
    srv = require('../server.js');
    accounts = require('../lib/accounts.js');
    db = require('../lib/db.js');
    mailer = require('../lib/mailer.js');
    session = require('../lib/session.js');
    await new Promise(r => srv.server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${srv.server.address().port}`;
      r();
    }));
  });

  beforeEach(() => {
    globalThis.fetch = realFetch;
    for (const k of ['TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY']) delete process.env[k];
    process.env.MAIL_PROVIDER = 'log';
    accounts.accountAttempts.clear();
    require('../lib/auth.js').apiRateLimits.clear();
    for (const c of Object.values(accounts._counters)) c.clear();
    mailer.clearOutbox();
    db.setSetting('registration.mode', 'open');
  });

  after(async () => {
    globalThis.fetch = realFetch;
    srv.resetTreeWatcher(); srv.resetDictWatcher(); srv.resetConfigWatcher();
    await srv.terminateWorkerPools();
    if (srv.server.closeAllConnections) srv.server.closeAllConnections();
    await new Promise(r => srv.server.close(r));
  });

  // ── 授權矩陣 ───────────────────────────────────────────────
  test('every admin route refuses anonymous visitors and ordinary users (GET and POST)', async () => {
    const userCookie = await registerAndVerify('matrix-user@example.org');
    const routes = accounts.ADMIN_ROUTES.map(r => r.replace(':id', '1'));
    assert.ok(routes.length >= 30);
    for (const route of routes) {
      for (const method of ['GET', 'POST']) {
        const anon = await rq(route, { method, body: method === 'POST' ? {} : undefined });
        assert.equal(anon.status, 401, `anonymous ${method} ${route}`);
        const plain = await rq(route, { method, body: method === 'POST' ? {} : undefined, cookie: userCookie });
        assert.equal(plain.status, 401, `user ${method} ${route}`);
      }
    }
    for (const [method, route] of [['DELETE', '/api/admin/users/1'], ['GET', '/api/admin/users/1/export']]) {
      assert.equal((await rq(route, { method, cookie: userCookie })).status, 401, `${method} ${route}`);
    }
  });

  test('self-service endpoints need a login', async () => {
    for (const [method, route] of [['PATCH', '/api/me'], ['DELETE', '/api/me'], ['POST', '/api/me/email'], ['GET', '/api/me/sessions'], ['DELETE', '/api/me/sessions'], ['GET', '/api/me/export'], ['DELETE', '/api/me/identities/google'], ['POST', '/api/auth/password'], ['POST', '/api/auth/reauth'], ['POST', '/api/auth/accept-terms']]) {
      const r = await rq(route, { method, body: method === 'GET' || method === 'DELETE' ? undefined : {} });
      assert.equal(r.status, 401, `${method} ${route}`);
      assert.equal(r.json.code, 'LOGIN_REQUIRED');
    }
    assert.equal((await rq('/api/me')).json.user, null);
  });

  // ── 登入限速與鎖定 ─────────────────────────────────────────
  test('per-IP limit: 20 failures in 15 minutes block even the correct password', async () => {
    await registerAndVerify('iplimit@example.org', 'ip-limit-pass');
    accounts.accountAttempts.clear();
    for (let i = 0; i < 20; i++) {
      const r = await post('/api/auth/login', { identifier: `ghost${i}@example.org`, password: 'wrong-password' });
      assert.equal(r.status, 401, `attempt ${i + 1}`);
    }
    const blocked = await post('/api/auth/login', { identifier: 'iplimit@example.org', password: 'ip-limit-pass' });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.json.code, 'RATE_LIMITED');
  });

  test('a successful login refunds the failure charge for IP and account', async () => {
    await registerAndVerify('refund@example.org', 'refund-pass-1');
    for (let i = 0; i < 4; i++) await post('/api/auth/login', { identifier: 'refund@example.org', password: 'bad' });
    assert.equal(accounts.accountAttempts.get('refund@example.org').fails, 4);
    assert.equal((await post('/api/auth/login', { identifier: 'refund@example.org', password: 'refund-pass-1' })).status, 200);
    assert.equal(accounts.accountAttempts.has('refund@example.org'), false);
    // 清零後又有 4 次失敗空間，不會被舊的失敗累積鎖住
    for (let i = 0; i < 4; i++) assert.equal((await post('/api/auth/login', { identifier: 'refund@example.org', password: 'bad' })).status, 401);
  });

  test('lock is per account, case-insensitive, and unknown accounts cannot be told from wrong passwords', async () => {
    await registerAndVerify('Case.Lock@Example.org', 'case-lock-pass');
    const wrong = await post('/api/auth/login', { identifier: 'case.lock@example.org', password: 'bad' });
    const ghost = await post('/api/auth/login', { identifier: 'no.such@example.org', password: 'bad' });
    assert.deepEqual([wrong.status, wrong.json], [ghost.status, ghost.json], 'same reply for wrong password and unknown account');
    for (let i = 0; i < accounts.MAX_ATTEMPTS; i++) await post('/api/auth/login', { identifier: i % 2 ? 'CASE.LOCK@example.org' : 'case.lock@example.org', password: 'bad' });
    const locked = await post('/api/auth/login', { identifier: 'Case.Lock@example.org', password: 'case-lock-pass' });
    assert.equal(locked.status, 429);
    assert.ok(locked.json.retryAfter > 0);
    // 另一個帳號不受影響
    await registerAndVerify('other-ok@example.org', 'other-ok-pass');
    assert.equal((await post('/api/auth/login', { identifier: 'other-ok@example.org', password: 'other-ok-pass' })).status, 200);
  });

  test('lock delay doubles with further failures up to 15 minutes; admin can list and clear lockouts', async () => {
    await registerAndVerify('backoff@example.org', 'backoff-pass');
    const adminCookie = await makeAdmin();
    accounts.accountAttempts.set('backoff@example.org', { fails: 4, lockUntil: 0 });
    await post('/api/auth/login', { identifier: 'backoff@example.org', password: 'bad' });
    const a = accounts.accountAttempts.get('backoff@example.org');
    assert.equal(a.fails, 5);
    assert.ok(Math.abs(a.lockUntil - (Date.now() + 60 * 1000)) < 5000, '5th failure: 1 minute');
    accounts.accountAttempts.set('backoff@example.org', { fails: 30, lockUntil: 0 });
    await post('/api/auth/login', { identifier: 'backoff@example.org', password: 'bad' }).catch(() => {});
    assert.ok(accounts.accountAttempts.get('backoff@example.org').lockUntil - Date.now() <= 15 * 60 * 1000 + 1000, 'capped at 15 minutes');

    const list = await rq('/api/admin/lockouts', { cookie: adminCookie });
    assert.equal(list.status, 200);
    const row = list.json.accounts.find(x => x.key === 'backoff@example.org');
    assert.ok(row && row.lockedUntil);
    assert.deepEqual([list.json.limits.ipFailLimit, list.json.limits.accountAttempts, list.json.limits.ipWindowMinutes], [20, 5, 15]);

    const cleared = await post('/api/admin/lockouts/clear', { key: 'backoff@example.org' }, adminCookie);
    assert.equal(cleared.status, 200);
    assert.equal((await post('/api/auth/login', { identifier: 'backoff@example.org', password: 'backoff-pass' })).status, 200);
    await post('/api/admin/lockouts/clear', {}, adminCookie);
    assert.deepEqual((await rq('/api/admin/lockouts', { cookie: adminCookie })).json.accounts, []);
  });

  test('after 3 failures login needs Turnstile when configured; a Cloudflare outage falls back to rate limits only', async () => {
    await registerAndVerify('ts-login@example.org', 'ts-login-pass');
    process.env.TURNSTILE_SITE_KEY = 'site';
    process.env.TURNSTILE_SECRET_KEY = 'secret';
    let mode = 'pass';
    globalThis.fetch = async (url, opts) => {
      if (!String(url).startsWith('https://challenges.cloudflare.com/')) return realFetch(url, opts);
      if (mode === 'down') throw Object.assign(new Error('t'), { name: 'TimeoutError' });
      return new Response(JSON.stringify({ success: mode === 'pass', 'error-codes': mode === 'pass' ? [] : ['invalid-input-response'], hostname: 'reader.example', action: 'login' }), { status: 200 });
    };
    // 前 3 次失敗不需要驗證
    for (let i = 0; i < 3; i++) assert.equal((await post('/api/auth/login', { identifier: 'ts-login@example.org', password: 'bad' })).status, 401);
    // 第 4 次起，沒帶 token 或驗證失敗就被擋（連正確密碼也是）
    mode = 'fail';
    const need = await post('/api/auth/login', { identifier: 'ts-login@example.org', password: 'ts-login-pass', turnstileToken: 'bad' });
    assert.equal(need.status, 403);
    assert.equal(need.json.code, 'TURNSTILE_REQUIRED');
    mode = 'pass';
    assert.equal((await post('/api/auth/login', { identifier: 'ts-login@example.org', password: 'ts-login-pass', turnstileToken: 'good' })).status, 200);
    // 故障時不把大家擋在門外
    for (let i = 0; i < 3; i++) await post('/api/auth/login', { identifier: 'ts-login@example.org', password: 'bad' });
    mode = 'down';
    const outage = await post('/api/auth/login', { identifier: 'ts-login@example.org', password: 'ts-login-pass', turnstileToken: 'tok' });
    assert.equal(outage.status, 200);
  });

  // ── 註冊模式、邀請碼、機器人防護 ───────────────────────────
  test('registration modes: closed, invite-only (single use, revoke, expiry), and validation of the admin settings', async () => {
    const adminCookie = await makeAdmin();
    const reg = (email, extra = {}) => post('/api/auth/register', Object.assign({ email, password: 'invite-pass-1' }, human, extra));

    assert.equal((await post('/api/admin/registration', { mode: 'bogus' }, adminCookie)).json.code, 'INVALID_MODE');
    assert.equal((await post('/api/admin/registration', { hourlyCap: 0 }, adminCookie)).json.code, 'INVALID_CAP');
    assert.equal((await post('/api/admin/registration', { hourlyCap: 99999 }, adminCookie)).json.code, 'INVALID_CAP');

    await post('/api/admin/registration', { mode: 'closed' }, adminCookie);
    const closed = await reg('closed@example.org');
    assert.equal(closed.status, 403);
    assert.equal(closed.json.code, 'REGISTRATION_CLOSED');
    assert.equal((await rq('/api/auth/config')).json.registrationMode, 'closed');

    await post('/api/admin/registration', { mode: 'invite' }, adminCookie);
    assert.equal((await reg('noinvite@example.org')).json.code, 'INVALID_INVITE');
    assert.equal((await reg('badinvite@example.org', { inviteCode: 'nope' })).json.code, 'INVALID_INVITE');

    const made = await post('/api/admin/invites', { usesLeft: 1, note: 'for a friend' }, adminCookie);
    assert.equal(made.status, 200);
    const code = made.json.code;
    assert.ok(code && !JSON.stringify(made.json.invites).includes(code), 'list never shows the full code');
    assert.equal((await reg('first@example.org', { inviteCode: code })).status, 200);
    accounts._counters.registerByIp.clear();
    assert.equal((await reg('second@example.org', { inviteCode: code })).json.code, 'INVALID_INVITE', 'single use');

    const revokable = (await post('/api/admin/invites', { usesLeft: 5 }, adminCookie)).json;
    const revoked = await post(`/api/admin/invites/${revokable.invites[0].id}/revoke`, {}, adminCookie);
    assert.equal(revoked.status, 200);
    assert.ok(revoked.json.invites[0].revoked_at);
    assert.equal((await reg('third@example.org', { inviteCode: revokable.code })).json.code, 'INVALID_INVITE');

    const timed = await post('/api/admin/invites', { expiresInDays: 1 }, adminCookie);
    const expiresAt = timed.json.invites[0].expires_at;
    assert.ok(Math.abs(expiresAt - (Date.now() + DAY)) < 5000);
    db.getDb().prepare('UPDATE invites SET expires_at = ? WHERE id = ?').run(Date.now() - 1, timed.json.invites[0].id);
    assert.equal((await reg('fourth@example.org', { inviteCode: timed.json.code })).json.code, 'INVALID_INVITE');
    assert.equal((await rq('/api/admin/invites', { cookie: adminCookie })).status, 200);
  });

  test('disposable domains are refused, and the hourly signup cap throttles everyone', async () => {
    const adminCookie = await makeAdmin();
    const set = await post('/api/admin/registration', { disposableDomains: 'Mailinator.com, @trashmail.example\nnot a domain' }, adminCookie);
    assert.deepEqual(set.json.disposableDomains, ['mailinator.com', 'trashmail.example']);
    const body = email => Object.assign({ email, password: 'dispo-pass-1' }, human);
    for (const email of ['x@mailinator.com', 'x@sub.mailinator.com', 'x@trashmail.example']) {
      const r = await post('/api/auth/register', body(email));
      assert.equal(r.json.code, 'DISPOSABLE_EMAIL', email);
    }
    assert.equal((await post('/api/auth/register', body('fine@notmailinator.com'))).status, 200, 'suffix match only on a dot boundary');
    await post('/api/admin/registration', { disposableDomains: [] }, adminCookie);

    await post('/api/admin/registration', { hourlyCap: 1 }, adminCookie);
    accounts._counters.registerByIp.clear();
    accounts._counters.signupsGlobal.hit('all');
    const capped = await post('/api/auth/register', body('capped@example.org'));
    assert.equal(capped.status, 429);
    assert.ok(Number(db.getSetting('registration.capHitAt')) > 0, 'admin can see that the cap was hit');
    await post('/api/admin/registration', { hourlyCap: 30 }, adminCookie);
  });

  test('without a working mail setup sign-up and password reset are paused, with a clear code', async () => {
    process.env.MAIL_PROVIDER = 'smtp';
    try {
      const reg = await post('/api/auth/register', Object.assign({ email: 'nomail@example.org', password: 'nomail-pass-1' }, human));
      assert.equal(reg.status, 503);
      assert.equal(reg.json.code, 'REGISTRATION_PAUSED');
      assert.deepEqual(reg.json.missing, ['MAIL']);
      assert.equal((await rq('/api/auth/config')).json.registrationPaused, true);
      for (const route of ['/api/auth/reset-request', '/api/auth/resend-verification']) {
        const r = await post(route, Object.assign({ email: 'nomail@example.org' }, human));
        assert.equal(r.status, 503, route);
        assert.equal(r.json.code, 'MAIL_UNAVAILABLE');
      }
    } finally {
      process.env.MAIL_PROVIDER = 'log';
    }
    assert.equal((await rq('/api/auth/config')).json.registrationPaused, false);
  });

  test('invalid input on sign-up: bad email, weak password, oversized body', async () => {
    const bad = await post('/api/auth/register', Object.assign({ email: 'not-an-email', password: 'long-enough-1' }, human));
    assert.equal(bad.json.code, 'INVALID_EMAIL');
    const weak = await post('/api/auth/register', Object.assign({ email: 'weak@example.org', password: 'short' }, human));
    assert.equal(weak.json.code, 'WEAK_PASSWORD');
    // 超大請求：伺服器回 413 或直接切斷連線都可以，重點是不處理
    const huge = await rq('/api/auth/register', { method: 'POST', body: JSON.stringify({ email: 'big@example.org', password: 'x'.repeat(200 * 1024) }) })
      .catch(err => ({ status: err.code === 'ECONNRESET' || err.code === 'EPIPE' ? 413 : 0 }));
    assert.equal(huge.status, 413);
    assert.equal(db.getUserByEmail('big@example.org'), null);
    assert.equal(db.getUserByEmail('weak@example.org'), null);
  });

  // ── 驗證與重設連結 ─────────────────────────────────────────
  test('verification link expires after 24h; resend revokes the old link; verified accounts get no resend', async () => {
    const email = 'expire@example.org';
    await post('/api/auth/register', Object.assign({ email, password: 'expire-pass-1' }, human));
    const first = lastToken(email, 'verify');
    db.getDb().prepare('UPDATE email_tokens SET expires_at = ? WHERE user_id = ?').run(Date.now() - 1, db.getUserByEmail(email).id);
    assert.equal((await post('/api/auth/verify', { token: first })).json.code, 'INVALID_TOKEN', 'expired');

    mailer.clearOutbox();
    const resend = await post('/api/auth/resend-verification', Object.assign({ email }, human));
    assert.equal(resend.status, 200);
    const second = lastToken(email, 'verify');
    assert.notEqual(first, second);
    assert.equal((await post('/api/auth/verify', { token: 'bogus' })).status, 400);
    const ok = await post('/api/auth/verify', { token: second });
    assert.equal(ok.status, 200);
    assert.ok(db.getUserByEmail(email).email_verified_at);

    mailer.clearOutbox();
    const again = await post('/api/auth/resend-verification', Object.assign({ email }, human));
    assert.equal(again.status, 200);
    assert.deepEqual(again.json, resend.json, 'same reply');
    assert.equal(mailer.getOutbox(email).length, 0, 'already verified: nothing sent');
  });

  test('a reset link cannot be used as a verify link (and vice versa); reset link expires after 1h', async () => {
    const email = 'purpose@example.org';
    await registerAndVerify(email, 'purpose-pass-1');
    await post('/api/auth/reset-request', Object.assign({ email }, human));
    const reset = lastToken(email, 'reset');
    assert.equal((await post('/api/auth/verify', { token: reset })).status, 400);
    assert.equal((await post('/api/auth/confirm-email', { token: reset })).status, 400);
    const row = db.getDb().prepare("SELECT expires_at, created_at FROM email_tokens WHERE purpose = 'reset' AND user_id = ?").get(db.getUserByEmail(email).id);
    assert.equal(row.expires_at - row.created_at, 60 * 60 * 1000);
    db.getDb().prepare("UPDATE email_tokens SET expires_at = ? WHERE purpose = 'reset'").run(Date.now() - 1);
    assert.equal((await post('/api/auth/reset', { token: reset, password: 'brand-new-pass' })).json.code, 'INVALID_TOKEN');
    assert.equal((await post('/api/auth/login', { identifier: email, password: 'purpose-pass-1' })).status, 200, 'password unchanged');
  });

  test('a rejected weak password does not burn the reset link', async () => {
    const email = 'noburn@example.org';
    await registerAndVerify(email, 'noburn-pass-1');
    await post('/api/auth/reset-request', Object.assign({ email }, human));
    const token = lastToken(email, 'reset');
    assert.equal((await post('/api/auth/reset', { token, password: 'short' })).status, 400);
    assert.equal((await post('/api/auth/reset', { token, password: 'a-good-new-pass' })).status, 200);
  });

  test('reset clears the account lockout and reset-request sends nothing for disabled accounts', async () => {
    const email = 'unlock@example.org';
    await registerAndVerify(email, 'unlock-pass-1');
    for (let i = 0; i < 5; i++) await post('/api/auth/login', { identifier: email, password: 'bad' });
    assert.equal((await post('/api/auth/login', { identifier: email, password: 'unlock-pass-1' })).status, 429);
    await post('/api/auth/reset-request', Object.assign({ email }, human));
    await post('/api/auth/reset', { token: lastToken(email, 'reset'), password: 'unlock-new-pass' });
    assert.equal((await post('/api/auth/login', { identifier: email, password: 'unlock-new-pass' })).status, 200);

    db.updateUser(db.getUserByEmail(email).id, { status: 'disabled' });
    mailer.clearOutbox();
    await post('/api/auth/reset-request', Object.assign({ email }, human));
    assert.equal(mailer.getOutbox(email).length, 0);
  });

  test('mail is rate-limited per address (3/hour)', async () => {
    const email = 'mailcap@example.org';
    await registerAndVerify(email, 'mailcap-pass-1');
    mailer.clearOutbox();
    // 上限是每個地址每小時 3 封，其中 1 封已經是註冊時的驗證信
    for (let i = 0; i < 5; i++) await post('/api/auth/reset-request', Object.assign({ email }, human));
    assert.equal(mailer.getOutbox(email).length, 2);
  });

  test('a reset link also verifies an unverified email and lets a social-only account set a password', async () => {
    const user = db.createUser({ email: 'social-only@example.org', emailVerifiedAt: Date.now() });
    db.linkIdentity(user.id, 'google', 'g-social-only', user.email);
    await post('/api/auth/reset-request', Object.assign({ email: user.email }, human));
    const r = await post('/api/auth/reset', { token: lastToken(user.email, 'reset'), password: 'now-i-have-one' });
    assert.equal(r.status, 200);
    assert.equal(r.json.user.hasPassword, true);
    assert.deepEqual(r.json.user.providers, ['google']);
  });

  // ── 密碼、Email、session、個人資料 ─────────────────────────
  test('change password: needs the current one, revokes other devices, keeps this one', async () => {
    const a = await registerAndVerify('chpw@example.org', 'chpw-pass-1');
    const b = await loginAs('chpw@example.org', 'chpw-pass-1');
    assert.equal((await post('/api/auth/password', { currentPassword: 'wrong', newPassword: 'chpw-new-pass' }, a)).json.code, 'WRONG_PASSWORD');
    assert.equal((await post('/api/auth/password', { currentPassword: 'chpw-pass-1', newPassword: 'short' }, a)).json.code, 'WEAK_PASSWORD');
    const ok = await post('/api/auth/password', { currentPassword: 'chpw-pass-1', newPassword: 'chpw-new-pass' }, a);
    assert.equal(ok.status, 200);
    assert.ok((await rq('/api/me', { cookie: a })).json.user, 'this device stays signed in');
    assert.equal((await rq('/api/me', { cookie: b })).json.user, null, 'other device is signed out');
    assert.equal((await post('/api/auth/login', { identifier: 'chpw@example.org', password: 'chpw-pass-1' })).status, 401);
    assert.equal((await post('/api/auth/login', { identifier: 'chpw@example.org', password: 'chpw-new-pass' })).status, 200);
  });

  test('a social-only account needs a recent re-auth before setting its first password', async () => {
    const user = db.createUser({ email: 'first-pw@example.org', emailVerifiedAt: Date.now() });
    db.linkIdentity(user.id, 'google', 'g-first-pw', user.email);
    const token = crypto.randomBytes(16).toString('base64url');
    db.createSession(user.id, token, { ttlMs: DAY });
    const cookie = `mdw_sid=${token}`;
    staleSession(user.id);
    const stale = await post('/api/auth/password', { newPassword: 'first-password-1' }, cookie);
    assert.equal(stale.status, 403);
    assert.equal(stale.json.code, 'REAUTH_REQUIRED');
    assert.equal((await post('/api/auth/reauth', { password: 'x' }, cookie)).json.code, 'USE_PROVIDER');
    db.markSessionReauth(db.getSessionByToken(token).id);
    assert.equal((await post('/api/auth/password', { newPassword: 'first-password-1' }, cookie)).status, 200);
    assert.equal(db.getUserById(user.id).password_hash.startsWith('$scrypt$'), true);
  });

  test('re-auth with a wrong password counts toward the account lockout', async () => {
    const cookie = await registerAndVerify('reauth-lock@example.org', 'reauth-lock-pass');
    for (let i = 0; i < accounts.MAX_ATTEMPTS; i++) assert.equal((await post('/api/auth/reauth', { password: 'bad' }, cookie)).status, 403);
    const locked = await post('/api/auth/reauth', { password: 'reauth-lock-pass' }, cookie);
    assert.equal(locked.status, 429);
  });

  test('change email: confirmation goes to the NEW address, notice to the old one, link works once, takes effect only then', async () => {
    const old = 'old-addr@example.org';
    const neu = 'new-addr@example.org';
    const cookie = await registerAndVerify(old, 'chmail-pass-1');
    mailer.clearOutbox();
    assert.equal((await post('/api/me/email', { newEmail: old }, cookie)).json.code, 'SAME_EMAIL');
    assert.equal((await post('/api/me/email', { newEmail: 'bad' }, cookie)).json.code, 'INVALID_EMAIL');
    assert.equal((await post('/api/me/email', { newEmail: neu }, cookie)).status, 200);
    assert.equal(db.getUserByEmail(old).email, old, 'not changed yet');
    assert.equal(db.getUserByEmail(neu), null);
    assert.match(mailer.getOutbox(old).pop().text, /new-addr@example\.org/, 'old address is warned');
    const token = lastToken(neu, 'email');
    const done = await post('/api/auth/confirm-email', { token });
    assert.equal(done.status, 200);
    assert.equal((await rq('/api/me', { cookie })).json.user.email, neu);
    assert.equal((await post('/api/auth/confirm-email', { token })).status, 400, 'single use');
    assert.equal((await post('/api/auth/login', { identifier: old, password: 'chmail-pass-1' })).status, 401);
    assert.equal((await post('/api/auth/login', { identifier: neu, password: 'chmail-pass-1' })).status, 200);
  });

  test('change email to an address someone else owns looks identical but sends and changes nothing', async () => {
    await registerAndVerify('owner@example.org', 'owner-pass-1');
    const cookie = await registerAndVerify('taker@example.org', 'taker-pass-1');
    mailer.clearOutbox();
    const r = await post('/api/me/email', { newEmail: 'owner@example.org' }, cookie);
    assert.equal(r.status, 200);
    assert.equal(mailer.getOutbox('owner@example.org').length, 0);

    // 發出連結後新信箱才被別人註冊：連結仍回成功，但不套用
    await post('/api/me/email', { newEmail: 'late@example.org' }, cookie);
    const token = lastToken('late@example.org', 'email');
    db.createUser({ email: 'late@example.org', emailVerifiedAt: Date.now() });
    assert.equal((await post('/api/auth/confirm-email', { token })).status, 200);
    assert.equal(db.getUserByEmail('taker@example.org').email, 'taker@example.org');
  });

  test('profile name can be changed but not emptied', async () => {
    const cookie = await registerAndVerify('profile@example.org', 'profile-pass-1');
    const r = await rq('/api/me', { method: 'PATCH', body: { displayName: '  新名字  ' }, cookie });
    assert.equal(r.json.user.displayName, '新名字');
    assert.equal((await rq('/api/me', { method: 'PATCH', body: { displayName: '   ' }, cookie })).json.code, 'INVALID_NAME');
    const long = await rq('/api/me', { method: 'PATCH', body: { displayName: 'x'.repeat(200) }, cookie });
    assert.equal(long.json.user.displayName.length, 60);
  });

  test('session list marks the current one; revoking one, others, or self works and is scoped to the owner', async () => {
    const a = await registerAndVerify('sess@example.org', 'sess-pass-1');
    const b = await loginAs('sess@example.org', 'sess-pass-1');
    const c = await loginAs('sess@example.org', 'sess-pass-1');
    const other = await registerAndVerify('sess-other@example.org', 'sess-other-pass');
    const list = (await rq('/api/me/sessions', { cookie: a })).json.sessions;
    assert.equal(list.length, 3);
    assert.equal(list.filter(s => s.current).length, 1);
    assert.ok(list.every(s => !('token' in s) && !('token_hash' in s)));

    const otherId = (await rq('/api/me/sessions', { cookie: other })).json.sessions[0].id;
    assert.equal((await rq(`/api/me/sessions/${otherId}`, { method: 'DELETE', cookie: a })).json.removed, 0, "cannot revoke another user's session");
    assert.ok((await rq('/api/me', { cookie: other })).json.user);

    const bId = list.find(s => !s.current && s.id !== list.find(x => x.current).id).id;
    assert.equal((await rq(`/api/me/sessions/${bId}`, { method: 'DELETE', cookie: a })).json.removed, 1);
    assert.equal((await rq('/api/me/sessions', { method: 'DELETE', cookie: a })).json.removed, 1, 'revokes the remaining other one');
    assert.ok((await rq('/api/me', { cookie: a })).json.user);
    assert.equal((await rq('/api/me', { cookie: b })).json.user && (await rq('/api/me', { cookie: c })).json.user, null);

    const selfId = (await rq('/api/me/sessions', { cookie: a })).json.sessions[0].id;
    const self = await rq(`/api/me/sessions/${selfId}`, { method: 'DELETE', cookie: a });
    assert.ok(self.headers['set-cookie'].some(v => /Max-Age=0/.test(v)), 'revoking yourself clears the cookie');
    assert.equal((await rq('/api/me', { cookie: a })).json.user, null);
  });

  // ── 匯出與刪除 ─────────────────────────────────────────────
  test('export is an attachment with the user\'s data but no credentials or tokens', async () => {
    const cookie = await registerAndVerify('export@example.org', 'export-pass-1');
    const user = db.getUserByEmail('export@example.org');
    const d = db.getDb();
    d.prepare('INSERT INTO bookmarks (user_id, path, anchor, title, updated_at) VALUES (?, ?, ?, ?, ?)').run(user.id, 'a/b.md', '#h', '書籤', Date.now());
    d.prepare('INSERT INTO bookmarks (user_id, path, title, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?)').run(user.id, 'gone.md', '已刪', Date.now(), Date.now());
    d.prepare('INSERT INTO read_progress (user_id, path, position, heading, updated_at) VALUES (?, ?, ?, ?, ?)').run(user.id, 'a/b.md', 0.5, '第一章', Date.now());
    d.prepare('INSERT INTO user_prefs (user_id, data, version, updated_at) VALUES (?, ?, 1, ?)').run(user.id, '{"theme":"zen"}', Date.now());

    const r = await rq('/api/me/export', { cookie });
    assert.equal(r.status, 200);
    assert.match(r.headers['content-disposition'], /attachment; filename="my-account-data\.json"/);
    assert.equal(r.headers['cache-control'], 'no-store');
    const data = r.json;
    assert.equal(data.account.email, 'export@example.org');
    assert.deepEqual(data.bookmarks.map(b => b.path), ['a/b.md'], 'soft-deleted bookmarks are not exported');
    assert.equal(data.readProgress[0].position, 0.5);
    assert.deepEqual(data.preferences.data, { theme: 'zen' });
    assert.ok(data.securityEvents.length > 0);
    assert.ok(!/password_hash|\$scrypt\$|token_hash|passwordHash/.test(r.body), 'no credential material');

    // 別人的資料不會混進來
    const other = await registerAndVerify('export-other@example.org', 'export-other-pass');
    assert.deepEqual((await rq('/api/me/export', { cookie: other })).json.bookmarks, []);
  });

  test('deleting your account removes your data; the last admin is protected', async () => {
    const cookie = await registerAndVerify('bye@example.org', 'bye-pass-1');
    const user = db.getUserByEmail('bye@example.org');
    db.getDb().prepare('INSERT INTO bookmarks (user_id, path, updated_at) VALUES (?, ?, ?)').run(user.id, 'x.md', Date.now());
    assert.equal((await rq('/api/me', { method: 'DELETE', cookie })).status, 200);
    assert.equal(db.getDb().prepare('SELECT COUNT(*) n FROM bookmarks WHERE user_id = ?').get(user.id).n, 0);
    assert.equal(db.getDb().prepare('SELECT COUNT(*) n FROM sessions WHERE user_id = ?').get(user.id).n, 0);
    assert.equal((await rq('/api/me', { cookie })).json.user, null);
    assert.equal((await post('/api/auth/login', { identifier: 'bye@example.org', password: 'bye-pass-1' })).status, 401);

    const adminCookie = await makeAdmin();
    for (const a of db.listUsers({ role: 'admin', limit: 100 }).rows) if (a.email !== 'boss@example.org') db.updateUser(a.id, { role: 'user' });
    const refused = await rq('/api/me', { method: 'DELETE', cookie: adminCookie });
    assert.equal(refused.status, 400);
    assert.equal(refused.json.code, 'LAST_ADMIN');
    assert.ok(db.getUserByEmail('boss@example.org'));
  });

  // ── 條款版本 ───────────────────────────────────────────────
  test('terms flow: first publish asks everyone, minor edits do not, major edits do, accepting clears it', async () => {
    const adminCookie = await makeAdmin();
    const resetLegal = () => { for (const k of ['privacy', 'terms']) db.setSetting(`legal.${k}`, ''); for (const k of ['version', 'majorVersion', 'updatedAt']) db.setSetting(`legal.${k}`, '0'); };
    resetLegal();
    try {
      const early = await registerAndVerify('early-bird@example.org', 'early-bird-pass');
      assert.equal((await rq('/api/me', { cookie: early })).json.user.needsConsent, false, 'no legal text yet');
      assert.deepEqual((await rq('/api/legal')).json, { privacy: false, terms: false, version: 0, majorVersion: 0, updatedAt: 0 });

      const v1 = await post('/api/admin/legal', { privacy: '隱私 v1', terms: '條款 v1' }, adminCookie);
      assert.deepEqual([v1.json.version, v1.json.majorVersion], [1, 1]);
      assert.equal((await rq('/api/me', { cookie: early })).json.user.needsConsent, true, 'existing users must consent to the first policy');

      const refused = await post('/api/auth/register', Object.assign({ email: 'late-bird@example.org', password: 'late-bird-pass' }, human));
      assert.equal(refused.json.code, 'CONSENT_REQUIRED', 'new sign-ups must tick the box once a policy exists');
      const withConsent = await post('/api/auth/register', Object.assign({ email: 'consented@example.org', password: 'consented-pass', agree: true }, human));
      assert.equal(withConsent.status, 200);
      assert.equal(db.getUserByEmail('consented@example.org').terms_version, '1', 'accepted version is recorded');
      const consented = sessionCookie(await post('/api/auth/verify', { token: lastToken('consented@example.org', 'verify') }));
      assert.equal((await rq('/api/me', { cookie: consented })).json.user.needsConsent, false);

      // 小修改：版本號 +1，但不要求重新同意
      const v2 = await post('/api/admin/legal', { privacy: '隱私 v2', terms: '條款 v2' }, adminCookie);
      assert.deepEqual([v2.json.version, v2.json.majorVersion], [2, 1]);
      assert.equal((await rq('/api/me', { cookie: consented })).json.user.needsConsent, false);
      assert.equal(db.getUserByEmail('consented@example.org').terms_version, '1');

      // 重大變更：全部人要重新同意
      const v3 = await post('/api/admin/legal', { privacy: '隱私 v3', terms: '條款 v3', major: true }, adminCookie);
      assert.deepEqual([v3.json.version, v3.json.majorVersion], [3, 3]);
      assert.equal((await rq('/api/me', { cookie: consented })).json.user.needsConsent, true);
      const accepted = await post('/api/auth/accept-terms', {}, consented);
      assert.equal(accepted.json.user.needsConsent, false);
      const row = db.getUserByEmail('consented@example.org');
      assert.equal(row.terms_version, '3');
      assert.ok(row.terms_accepted_at);

      // 公開頁面反映最新內容，且 HTML 會跳脫
      await post('/api/admin/legal', { privacy: '<script>alert(1)</script> 隱私' }, adminCookie);
      const page = await rq('/privacy');
      // 內容是管理員寫的 Markdown，原樣輸出；安全靠頁面 CSP 不允許行內腳本
      const scriptSrc = page.headers['content-security-policy'].match(/script-src ([^;]*)/)[1];
      assert.ok(!/unsafe-inline|unsafe-eval|\*/.test(scriptSrc), `script-src is strict: ${scriptSrc}`);
      assert.equal((await rq('/terms')).status, 200);
      assert.equal((await rq('/legal-theme.js')).status, 200);
    } finally {
      resetLegal();
    }
  });

  // ── 第三方登入的帳號對應 ───────────────────────────────────
  describe('OAuth sign-in against mocked providers', () => {
    const OAUTH_ENV = {
      GOOGLE_CLIENT_ID: 'g-client', GOOGLE_CLIENT_SECRET: 'g-secret',
      FACEBOOK_APP_ID: '1234567890', FACEBOOK_APP_SECRET: 'f'.repeat(32)
    };
    const saved = {};
    before(() => { for (const [k, v] of Object.entries(OAUTH_ENV)) { saved[k] = process.env[k]; process.env[k] = v; } });
    after(() => { for (const k of Object.keys(OAUTH_ENV)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

    const jwt = claims => `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

    /** 走完 /api/auth/<provider>，回傳帶 state 的回調網址與要送的 Cookie。 */
    async function begin(provider, { cookie = '', mode } = {}) {
      const r = await rq(`/api/auth/${provider}${mode ? `?mode=${mode}` : ''}`, { cookie });
      assert.equal(r.status, 302, r.body);
      const url = new URL(r.headers.location);
      const state = url.searchParams.get('state');
      const oauthCookie = cookieOf(r, 'mdw_oauth');
      assert.ok(state && oauthCookie);
      return { state, nonce: url.searchParams.get('nonce'), cookie: [cookie, oauthCookie].filter(Boolean).join('; ') };
    }

    function mockGoogle(profile) {
      return nonce => {
        globalThis.fetch = async (url, opts) => {
          if (String(url) === 'https://oauth2.googleapis.com/token') {
            return new Response(JSON.stringify({ id_token: jwt(Object.assign({ iss: 'https://accounts.google.com', aud: 'g-client', exp: Math.floor(Date.now() / 1000) + 300, nonce }, profile)) }), { status: 200 });
          }
          return realFetch(url, opts);
        };
      };
    }
    function mockFacebook(profile) {
      globalThis.fetch = async (url, opts) => {
        const u = String(url);
        if (u.includes('/oauth/access_token')) return new Response(JSON.stringify({ access_token: 'fb-token' }), { status: 200 });
        if (u.startsWith('https://graph.facebook.com/')) return new Response(JSON.stringify(profile), { status: 200 });
        return realFetch(url, opts);
      };
    }
    const outcome = r => {
      assert.equal(r.status, 302, r.body);
      const q = new URL(r.headers.location, 'https://x.example').searchParams;
      return { status: q.get('status'), code: q.get('code'), mode: q.get('mode') };
    };
    async function googleLogin(profile, { cookie = '', mode } = {}) {
      const s = await begin('google', { cookie, mode });
      mockGoogle(profile)(s.nonce);
      const r = await rq(`/api/auth/google/callback?state=${encodeURIComponent(s.state)}&code=abc`, { cookie: s.cookie });
      return { r, out: outcome(r) };
    }
    async function facebookLogin(profile, opts = {}) {
      const s = await begin('facebook', opts);
      mockFacebook(profile);
      const r = await rq(`/api/auth/facebook/callback?state=${encodeURIComponent(s.state)}&code=abc`, { cookie: s.cookie });
      return { r, out: outcome(r) };
    }

    test('config lists enabled providers; start redirects to the provider with state, and refuses when disabled', async () => {
      assert.deepEqual((await rq('/api/auth/config')).json.providers.sort(), ['facebook', 'google']);
      assert.equal((await rq('/api/auth/apple')).status, 404, 'apple has no keys');
      const r = await rq('/api/auth/google');
      assert.equal(r.status, 302);
      assert.match(r.headers.location, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
      const set = r.headers['set-cookie'].find(c => c.startsWith('mdw_oauth='));
      assert.match(set, /HttpOnly/);
      assert.match(set, /Path=\/api\/auth\/google/);
      db.setSetting('oauth.google.enabled', '0');
      try {
        assert.equal((await rq('/api/auth/google')).status, 404);
        const cb = await rq('/api/auth/google/callback?state=x&code=y');
        assert.equal(outcome(cb).code, 'PROVIDER_DISABLED');
      } finally { db.setSetting('oauth.google.enabled', ''); }
    });

    test('new Google user: account created without a password, email verified, signed in', async () => {
      const { r, out } = await googleLogin({ sub: 'g-new-1', email: 'Fresh.User@Example.org', email_verified: true, name: '新使用者' });
      assert.deepEqual([out.status, out.code], ['ok', null]);
      const cookie = sessionCookie(r);
      assert.ok(cookie);
      const me = (await rq('/api/me', { cookie })).json.user;
      assert.deepEqual([me.email, me.emailVerified, me.hasPassword, me.providers, me.displayName], ['fresh.user@example.org', true, false, ['google'], '新使用者']);
      // 再登入一次：同一個帳號
      const again = await googleLogin({ sub: 'g-new-1', email: 'fresh.user@example.org', email_verified: true });
      assert.equal((await rq('/api/me', { cookie: sessionCookie(again.r) })).json.user.id, me.id);
    });

    test('state is bound to the browser: missing cookie, other cookie, replay, or forged state all fail', async () => {
      const s = await begin('google');
      mockGoogle({ sub: 'g-x', email: 'x@example.org', email_verified: true })(s.nonce);
      const noCookie = await rq(`/api/auth/google/callback?state=${encodeURIComponent(s.state)}&code=abc`);
      assert.equal(outcome(noCookie).code, 'OAUTH_FAILED');
      const forged = await rq('/api/auth/google/callback?state=forged&code=abc', { cookie: s.cookie });
      assert.equal(outcome(forged).code, 'OAUTH_FAILED');
      const ok = await rq(`/api/auth/google/callback?state=${encodeURIComponent(s.state)}&code=abc`, { cookie: s.cookie });
      assert.equal(outcome(ok).status, 'ok');
      const replay = await rq(`/api/auth/google/callback?state=${encodeURIComponent(s.state)}&code=abc`, { cookie: s.cookie });
      assert.equal(outcome(replay).code, 'OAUTH_FAILED');
      assert.equal(db.getUserByEmail('x@example.org').id > 0, true);
    });

    test('user cancelling at the provider is reported as DENIED; a wrong nonce in the ID token is refused', async () => {
      const s = await begin('google');
      const denied = await rq(`/api/auth/google/callback?state=${encodeURIComponent(s.state)}&error=access_denied`, { cookie: s.cookie });
      assert.equal(outcome(denied).code, 'DENIED');
      const s2 = await begin('google');
      mockGoogle({ sub: 'g-bad-nonce', email: 'badnonce@example.org', email_verified: true })('some-other-nonce');
      const bad = await rq(`/api/auth/google/callback?state=${encodeURIComponent(s2.state)}&code=abc`, { cookie: s2.cookie });
      assert.equal(outcome(bad).code, 'OAUTH_FAILED');
      assert.equal(db.getUserByEmail('badnonce@example.org'), null);
    });

    test('Google with a verified email that matches a VERIFIED account: auto-links, notifies, signs in', async () => {
      const cookie = await registerAndVerify('link-me@example.org', 'link-me-pass-1');
      const userId = db.getUserByEmail('link-me@example.org').id;
      mailer.clearOutbox();
      const { r, out } = await googleLogin({ sub: 'g-link-me', email: 'link-me@example.org', email_verified: true });
      assert.equal(out.status, 'ok');
      assert.equal((await rq('/api/me', { cookie: sessionCookie(r) })).json.user.id, userId);
      assert.deepEqual(db.listIdentities(userId).map(i => i.provider), ['google']);
      assert.equal(mailer.getOutbox('link-me@example.org').length, 1, 'owner is told a login method was linked');
      assert.match(mailer.getOutbox('link-me@example.org')[0].subject, /綁定/);
      assert.ok(db.getUserById(userId).password_hash, 'password kept');
      assert.ok((await rq('/api/me', { cookie })).json.user, 'existing session untouched');
    });

    test('Google with a verified email matching an UNVERIFIED account: takes over (password and sessions wiped)', async () => {
      const email = 'squatted@example.org';
      await post('/api/auth/register', Object.assign({ email, password: 'attacker-chosen-pass' }, human));
      const squatterSession = crypto.randomBytes(16).toString('base64url');
      const id = db.getUserByEmail(email).id;
      db.createSession(id, squatterSession, { ttlMs: DAY });
      const { r, out } = await googleLogin({ sub: 'g-real-owner', email, email_verified: true });
      assert.equal(out.status, 'ok');
      const row = db.getUserById(id);
      assert.ok(row.email_verified_at);
      assert.equal(row.password_hash, null, 'the squatter\'s password no longer works');
      assert.equal(db.getSessionByToken(squatterSession), null, 'squatter sessions are gone');
      assert.equal((await post('/api/auth/login', { identifier: email, password: 'attacker-chosen-pass' })).status, 401);
      assert.equal((await rq('/api/me', { cookie: sessionCookie(r) })).json.user.id, id);
    });

    test('Google email WITHOUT email_verified never links to an existing account', async () => {
      await registerAndVerify('no-flag@example.org', 'no-flag-pass-1');
      const { out } = await googleLogin({ sub: 'g-no-flag', email: 'no-flag@example.org', email_verified: false });
      assert.deepEqual([out.status, out.code], ['error', 'EMAIL_IN_USE']);
      assert.deepEqual(db.listIdentities(db.getUserByEmail('no-flag@example.org').id), []);
    });

    test('Facebook: email is never trusted for linking, even when it matches a verified account', async () => {
      await registerAndVerify('fb-victim@example.org', 'fb-victim-pass');
      const { r, out } = await facebookLogin({ id: 'fb-attacker', name: 'Attacker', email: 'fb-victim@example.org' });
      assert.deepEqual([out.status, out.code], ['error', 'EMAIL_IN_USE']);
      assert.equal(sessionCookie(r), null, 'no session issued');
      assert.deepEqual(db.listIdentities(db.getUserByEmail('fb-victim@example.org').id), []);
      assert.equal(db.getIdentity('facebook', 'fb-attacker'), null);
    });

    test('Facebook new user with an email: account stays unverified, verification mail is sent, FB login keeps working', async () => {
      mailer.clearOutbox();
      const { r, out } = await facebookLogin({ id: 'fb-new-1', name: 'FB 新人', email: 'fb-new@example.org' });
      assert.equal(out.status, 'ok');
      const user = db.getUserByEmail('fb-new@example.org');
      assert.equal(user.email_verified_at, null);
      assert.equal(user.password_hash, null);
      assert.ok(lastToken('fb-new@example.org', 'verify'));
      assert.equal((await rq('/api/me', { cookie: sessionCookie(r) })).json.user.id, user.id);
      assert.equal((await facebookLogin({ id: 'fb-new-1', name: 'FB 新人', email: 'fb-new@example.org' })).out.status, 'ok');
      // 之後點信中連結就變已驗證
      await post('/api/auth/verify', { token: lastToken('fb-new@example.org', 'verify') });
      assert.ok(db.getUserByEmail('fb-new@example.org').email_verified_at);
    });

    test('Facebook without an email still creates an account (name only)', async () => {
      const { r, out } = await facebookLogin({ id: 'fb-no-email', name: '沒有信箱' });
      assert.equal(out.status, 'ok');
      const me = (await rq('/api/me', { cookie: sessionCookie(r) })).json.user;
      assert.deepEqual([me.email, me.displayName, me.providers], [null, '沒有信箱', ['facebook']]);
    });

    test('registration mode applies to new social users but not to existing identities', async () => {
      await googleLogin({ sub: 'g-existing-id', email: 'existing-id@example.org', email_verified: true });
      db.setSetting('registration.mode', 'closed');
      assert.equal((await googleLogin({ sub: 'g-blocked', email: 'blocked@example.org', email_verified: true })).out.code, 'REGISTRATION_CLOSED');
      db.setSetting('registration.mode', 'invite');
      assert.equal((await googleLogin({ sub: 'g-blocked2', email: 'blocked2@example.org', email_verified: true })).out.code, 'INVITE_REQUIRED');
      assert.equal((await googleLogin({ sub: 'g-existing-id', email: 'existing-id@example.org', email_verified: true })).out.status, 'ok', 'returning user can still sign in');
      assert.equal(db.getUserByEmail('blocked@example.org'), null);
    });

    test('disposable email domains are refused for new social users; sign-ups are rate-limited per IP', async () => {
      db.setJsonSetting('registration.disposableDomains', ['trash.example']);
      try {
        assert.equal((await googleLogin({ sub: 'g-trash', email: 'a@trash.example', email_verified: true })).out.code, 'DISPOSABLE_EMAIL');
      } finally { db.setJsonSetting('registration.disposableDomains', []); }
      accounts._counters.registerByIp.clear();
      for (let i = 0; i < 3; i++) assert.equal((await googleLogin({ sub: `g-rate-${i}`, email: `rate${i}@example.org`, email_verified: true })).out.status, 'ok');
      assert.equal((await googleLogin({ sub: 'g-rate-3', email: 'rate3@example.org', email_verified: true })).out.code, 'RATE_LIMITED');
    });

    test('a disabled account cannot sign in through a provider', async () => {
      await googleLogin({ sub: 'g-disabled', email: 'disabled-social@example.org', email_verified: true });
      db.updateUser(db.getUserByEmail('disabled-social@example.org').id, { status: 'disabled' });
      const { r, out } = await googleLogin({ sub: 'g-disabled', email: 'disabled-social@example.org', email_verified: true });
      assert.deepEqual([out.status, out.code], ['error', 'ACCOUNT_DISABLED']);
      assert.equal(sessionCookie(r), null);
    });

    test('link mode: needs a login, links to the signed-in user, refuses an identity owned by someone else or a second Google', async () => {
      const anon = await rq('/api/auth/google?mode=link');
      assert.equal(outcome(anon).code, 'LOGIN_REQUIRED');

      const cookie = await registerAndVerify('linker@example.org', 'linker-pass-1');
      const linker = db.getUserByEmail('linker@example.org');
      const ok = await googleLogin({ sub: 'g-linker', email: 'whatever@example.org', email_verified: true }, { cookie, mode: 'link' });
      assert.deepEqual([ok.out.status, ok.out.mode], ['ok', 'link']);
      assert.deepEqual(db.listIdentities(linker.id).map(i => [i.provider, i.subject]), [['google', 'g-linker']]);
      assert.equal(sessionCookie(ok.r), null, 'link does not start another session');

      const second = await googleLogin({ sub: 'g-linker-second' }, { cookie, mode: 'link' });
      assert.equal(second.out.code, 'ALREADY_LINKED');

      const stranger = await registerAndVerify('stranger@example.org', 'stranger-pass-1');
      const taken = await googleLogin({ sub: 'g-linker' }, { cookie: stranger, mode: 'link' });
      assert.equal(taken.out.code, 'IDENTITY_IN_USE');
    });

    test('link mode is bound to the user who started it', async () => {
      const a = await registerAndVerify('bind-a@example.org', 'bind-a-pass-1');
      const b = await registerAndVerify('bind-b@example.org', 'bind-b-pass-1');
      const s = await begin('google', { cookie: a, mode: 'link' });
      mockGoogle({ sub: 'g-bind', email: 'x@example.org', email_verified: true })(s.nonce);
      const swapped = s.cookie.replace(a, b);
      const r = await rq(`/api/auth/google/callback?state=${encodeURIComponent(s.state)}&code=abc`, { cookie: swapped });
      assert.equal(outcome(r).code, 'LOGIN_REQUIRED');
      assert.equal(db.getIdentity('google', 'g-bind'), null);
    });

    test('re-auth through the provider counts only for the linked identity', async () => {
      const cookie = await registerAndVerify('reauth-sso@example.org', 'reauth-sso-pass');
      const user = db.getUserByEmail('reauth-sso@example.org');
      db.linkIdentity(user.id, 'google', 'g-reauth', user.email);
      staleSession(user.id);
      assert.equal((await rq('/api/me', { method: 'DELETE', cookie })).json.code, 'REAUTH_REQUIRED');
      const wrong = await googleLogin({ sub: 'g-someone-else' }, { cookie, mode: 'reauth' });
      assert.equal(wrong.out.code, 'IDENTITY_MISMATCH');
      assert.equal((await rq('/api/me', { method: 'DELETE', cookie })).json.code, 'REAUTH_REQUIRED', 'still stale');
      const right = await googleLogin({ sub: 'g-reauth' }, { cookie, mode: 'reauth' });
      assert.deepEqual([right.out.status, right.out.mode], ['ok', 'reauth']);
      assert.equal((await rq('/api/me', { method: 'DELETE', cookie })).status, 200);
    });

    test('unlinking: refused for the only login method, allowed when a password remains; 404 when not linked', async () => {
      const r = await googleLogin({ sub: 'g-only-method', email: 'only-method@example.org', email_verified: true });
      const socialOnly = sessionCookie(r.r);
      const last = await rq('/api/me/identities/google', { method: 'DELETE', cookie: socialOnly });
      assert.equal(last.status, 400);
      assert.equal(last.json.code, 'LAST_LOGIN_METHOD');
      assert.equal((await rq('/api/me/identities/facebook', { method: 'DELETE', cookie: socialOnly })).json.code, 'NOT_LINKED');
      assert.equal((await rq('/api/me/identities/twitter', { method: 'DELETE', cookie: socialOnly })).status, 404);

      const cookie = await registerAndVerify('has-both@example.org', 'has-both-pass-1');
      db.linkIdentity(db.getUserByEmail('has-both@example.org').id, 'google', 'g-has-both', null);
      const ok = await rq('/api/me/identities/google', { method: 'DELETE', cookie });
      assert.equal(ok.status, 200);
      assert.deepEqual(ok.json.user.providers, []);
    });
  });

  // ── 管理員動作 ─────────────────────────────────────────────
  test('admin user list: filters, pagination, and no credential fields', async () => {
    const adminCookie = await makeAdmin();
    await registerAndVerify('list-a@example.org', 'list-a-pass-1');
    const disabled = db.createUser({ email: 'list-disabled@example.org', emailVerifiedAt: Date.now() });
    db.updateUser(disabled.id, { status: 'disabled' });
    db.createUser({ email: 'list-unverified@example.org' });
    const withGoogle = db.createUser({ email: 'list-google@example.org', emailVerifiedAt: Date.now() });
    db.linkIdentity(withGoogle.id, 'google', 'g-list', null);

    const get = q => rq(`/api/admin/users?${q}`, { cookie: adminCookie });
    assert.deepEqual((await get('status=disabled&q=list-')).json.users.map(u => u.email), ['list-disabled@example.org']);
    assert.deepEqual((await get('verified=no&q=list-')).json.users.map(u => u.email), ['list-unverified@example.org']);
    assert.deepEqual((await get('provider=google&q=list-')).json.users.map(u => u.email), ['list-google@example.org']);
    assert.ok((await get('role=admin')).json.users.every(u => u.role === 'admin'));
    assert.ok((await get('verified=yes&q=list-')).json.users.every(u => u.email !== 'list-unverified@example.org'));
    assert.deepEqual((await get('provider=password&q=list-')).json.users.map(u => u.email), ['list-a@example.org']);
    const page = await get('q=list-&limit=2&page=2');
    assert.equal(page.json.limit, 2);
    assert.equal(page.json.page, 2);
    assert.equal(page.json.users.length, 2);
    assert.equal(page.json.total, 4);
    assert.ok(!/password_hash|\$scrypt\$/.test(page.body));
    assert.equal((await get('limit=100000')).json.limit, 100, 'page size is capped');
    assert.equal((await rq('/api/admin/users/999999', { cookie: adminCookie })).status, 404);
    const detail = await rq(`/api/admin/users/${withGoogle.id}`, { cookie: adminCookie });
    assert.deepEqual(detail.json.user.providers, ['google']);
    assert.ok(Array.isArray(detail.json.user.recentEvents));
    assert.ok(!/password_hash|\$scrypt\$/.test(detail.body));
  });

  test('admin actions: force logout, resend verification, send reset, unlink, export, enable/disable', async () => {
    const adminCookie = await makeAdmin();
    const victimCookie = await registerAndVerify('victim@example.org', 'victim-pass-1');
    const victim = db.getUserByEmail('victim@example.org');
    const act = (action, body = {}) => post(`/api/admin/users/${victim.id}/${action}`, body, adminCookie);

    assert.equal((await act('logout')).status, 200);
    assert.equal((await rq('/api/me', { cookie: victimCookie })).json.user, null);

    assert.equal((await act('resend-verification')).json.code, 'ALREADY_VERIFIED');
    const unverified = db.createUser({ email: 'needs-verify@example.org' });
    mailer.clearOutbox();
    assert.equal((await post(`/api/admin/users/${unverified.id}/resend-verification`, {}, adminCookie)).status, 200);
    assert.ok(lastToken('needs-verify@example.org', 'verify'));

    mailer.clearOutbox();
    assert.equal((await act('send-reset')).status, 200);
    assert.ok(lastToken('victim@example.org', 'reset'));
    const noMail = db.createUser({ username: 'legacy-name', passwordHash: 'x' });
    assert.equal((await post(`/api/admin/users/${noMail.id}/send-reset`, {}, adminCookie)).json.code, 'NO_EMAIL');

    assert.equal((await act('unlink', { provider: 'google' })).json.code, 'NOT_LINKED');
    db.linkIdentity(victim.id, 'google', 'g-victim', null);
    assert.equal((await act('unlink', { provider: 'google' })).status, 200);
    db.updateUser(victim.id, { passwordHash: null });
    db.linkIdentity(victim.id, 'google', 'g-victim', null);
    assert.equal((await act('unlink', { provider: 'google' })).json.code, 'LAST_LOGIN_METHOD');

    const exp = await rq(`/api/admin/users/${victim.id}/export`, { cookie: adminCookie });
    assert.equal(exp.json.account.email, 'victim@example.org');

    assert.equal((await act('status', { status: 'disabled' })).json.user.status, 'disabled');
    assert.equal((await act('status', { status: 'active' })).json.user.status, 'active');
    assert.equal((await act('nonsense')).status, 404);
    assert.equal((await post('/api/admin/users/999999/logout', {}, adminCookie)).status, 404);
    const events = (await rq(`/api/admin/auth-events?user=${victim.id}`, { cookie: adminCookie })).json.events.map(e => e.event);
    for (const e of ['admin_force_logout', 'admin_send_reset', 'admin_unlink', 'admin_disable', 'admin_enable']) assert.ok(events.includes(e), e);
  });

  test('promoting/demoting and deleting other users needs a recent re-auth; the last admin cannot be disabled or deleted', async () => {
    const adminCookie = await makeAdmin();
    const boss = db.getUserByEmail('boss@example.org');
    for (const a of db.listUsers({ role: 'admin', limit: 100 }).rows) if (a.id !== boss.id) db.updateUser(a.id, { role: 'user' });
    await registerAndVerify('promote@example.org', 'promote-pass-1');
    const target = db.getUserByEmail('promote@example.org');

    staleSession(boss.id);
    const stale = await post(`/api/admin/users/${target.id}/role`, { role: 'admin' }, adminCookie);
    assert.equal(stale.status, 403);
    assert.equal(stale.json.code, 'REAUTH_REQUIRED');
    assert.equal((await rq(`/api/admin/users/${target.id}`, { method: 'DELETE', cookie: adminCookie })).json.code, 'REAUTH_REQUIRED');
    assert.equal(db.getUserById(target.id).role, 'user');
    assert.equal((await post('/api/auth/reauth', { password: 'boss-password' }, adminCookie)).status, 200);

    const sessionsBefore = db.getDb().prepare('SELECT expires_at - last_seen_at AS ttl FROM sessions WHERE user_id = ?');
    const targetCookie = await loginAs('promote@example.org', 'promote-pass-1');
    assert.ok(sessionsBefore.get(target.id).ttl > 8 * DAY);
    assert.equal((await post(`/api/admin/users/${target.id}/role`, { role: 'admin' }, adminCookie)).json.user.role, 'admin');
    assert.ok(sessionsBefore.get(target.id).ttl <= 7 * DAY, 'existing sessions follow the 7-day admin rule at once');
    assert.equal((await rq('/api/admin/lockouts', { cookie: targetCookie })).status, 200, 'new admin can use admin routes');
    assert.equal((await post(`/api/admin/users/${target.id}/role`, { role: 'user' }, adminCookie)).json.user.role, 'user');
    assert.equal((await rq('/api/admin/lockouts', { cookie: targetCookie })).status, 401, 'demoted at once');

    assert.equal((await post(`/api/admin/users/${boss.id}/status`, { status: 'disabled' }, adminCookie)).json.code, 'LAST_ADMIN');
    assert.equal((await rq(`/api/admin/users/${boss.id}`, { method: 'DELETE', cookie: adminCookie })).json.code, 'LAST_ADMIN');

    assert.equal((await rq(`/api/admin/users/${target.id}`, { method: 'DELETE', cookie: adminCookie })).status, 200);
    assert.equal(db.getUserById(target.id), null);
  });

  test('accounts overview, bot stats, auth events, mail test and backup routes behave for an admin', async () => {
    const adminCookie = await makeAdmin();
    const ov = (await rq('/api/admin/accounts-overview', { cookie: adminCookie })).json;
    for (const key of ['database', 'mail', 'turnstile', 'setup', 'providers', 'registration', 'legal', 'counts', 'me']) assert.ok(key in ov, key);
    assert.equal(ov.publicBaseUrl, 'https://reader.example');
    assert.equal(ov.publicBaseUrlSource, 'env');
    assert.ok(ov.counts.users >= 1 && ov.counts.admins >= 1);
    assert.equal(ov.me.role, 'admin');
    assert.ok(!/password_hash|\$scrypt\$|g-secret|re_/.test(JSON.stringify(ov)), 'no secret material in the overview');

    // 機器人統計看得到被擋下的註冊
    await post('/api/auth/register', { email: 'bot@example.org', password: 'bot-pass-1234', website: 'spam', elapsedMs: 9000 });
    const stats = (await rq('/api/admin/bot-stats', { cookie: adminCookie })).json;
    assert.ok(stats.blocked.honeypot >= 1);
    assert.ok('signups24h' in stats && 'turnstile' in stats);

    const events = (await rq('/api/admin/auth-events?event=bot_&limit=5', { cookie: adminCookie })).json.events;
    assert.ok(events.length && events.every(e => e.event.startsWith('bot_')));

    const mail = await post('/api/admin/mail/test', { to: 'tester@example.org' }, adminCookie);
    assert.equal(mail.status, 200);
    assert.equal(mailer.getOutbox('tester@example.org').length, 1);
    assert.equal((await post('/api/admin/mail/test', { to: 'not-an-email' }, adminCookie)).json.code, 'INVALID_EMAIL');
    assert.equal((await rq('/api/admin/mail', { cookie: adminCookie })).json.provider, 'log');

    // 測試用的記憶體資料庫：可列出、不能備份／還原
    assert.deepEqual((await rq('/api/admin/db-backups', { cookie: adminCookie })).json.backups, []);
    assert.equal((await post('/api/admin/db-backups', {}, adminCookie)).json.code, 'BACKUP_UNAVAILABLE');
    assert.equal((await rq('/api/admin/db-backups/download?name=users-x.db', { cookie: adminCookie })).status, 404);
    assert.equal((await rq('/api/admin/db-backups/download?name=../../etc/passwd', { cookie: adminCookie })).status, 404);
    assert.equal((await post('/api/admin/db-backups/restore', { name: 'users-x.db' }, adminCookie)).json.code, 'RESTORE_FAILED');
    staleSession(db.getUserByEmail('boss@example.org').id);
    assert.equal((await rq('/api/admin/db-backups/download?name=users-x.db', { cookie: adminCookie })).json.code, 'REAUTH_REQUIRED');
    assert.equal((await post('/api/admin/db-backups/restore', { name: 'users-x.db' }, adminCookie)).json.code, 'REAUTH_REQUIRED');
  });

  // ── 舊管理員搬遷與相容端點 ─────────────────────────────────
  test('legacy config.json admin: logs in once, is migrated into users.db, and the returned token works as X-Admin-Token', async () => {
    const { config } = require('../lib/config.js');
    const legacy = await require('../lib/auth.js').hashPassword('legacy-admin-pass');
    const saved = config.admin;
    config.admin = { username: 'oldadmin', salt: legacy.salt, passwordHash: legacy.hash };
    try {
      const bad = await post('/api/admin/login', { username: 'oldadmin', password: 'wrong' });
      assert.equal(bad.status, 401);
      assert.equal(db.getUserByUsername('oldadmin'), null, 'nothing migrated on failure');
      const ok = await post('/api/admin/login', { username: 'oldadmin', password: 'legacy-admin-pass' });
      assert.equal(ok.status, 200, ok.body);
      assert.ok(ok.json.token);
      const user = db.getUserByUsername('oldadmin');
      assert.equal(user.role, 'admin');
      assert.ok(user.password_hash.startsWith('$scrypt$'), 'rehashed to scrypt on first successful login');

      const viaHeader = await rq('/api/admin/accounts-overview', { headers: { 'X-Admin-Token': ok.json.token } });
      assert.equal(viaHeader.status, 200);
      assert.equal((await rq('/api/admin/accounts-overview', { headers: { 'X-Admin-Token': 'bogus' } })).status, 401);

      // 之後用帳號名稱＋新的 scrypt 密碼照常登入
      assert.equal((await post('/api/auth/login', { identifier: 'oldadmin', password: 'legacy-admin-pass' })).status, 200);
      const out = await post('/api/admin/logout', {}, undefined);
      assert.equal(out.status, 200);
    } finally {
      config.admin = saved;
    }
  });

  test('legacy admin login endpoint refuses non-admin accounts', async () => {
    await registerAndVerify('not-admin@example.org', 'not-admin-pass-1');
    const r = await post('/api/admin/login', { username: 'not-admin@example.org', password: 'not-admin-pass-1' });
    assert.equal(r.status, 403);
    assert.equal(r.json.code, 'NOT_ADMIN');
    assert.equal(r.json.token, undefined);
  });

  test('first-run setup is closed once an admin exists, and needs the setup token before that', async () => {
    await makeAdmin();
    const r = await post('/api/admin/setup', { username: 'second', password: 'second-admin-pass', siteUrl: 'https://reader.example', setupToken: 'x' });
    assert.equal(r.status, 400);
    assert.equal(db.getUserByUsername('second'), null);
  });

  // ── 同源／CSRF ─────────────────────────────────────────────
  test('CSRF rules: Origin/Referer must match; Sec-Fetch-Site is the fallback; JSON only; header tokens are exempt from cookie rules', async () => {
    const cookie = await registerAndVerify('csrf@example.org', 'csrf-pass-1');
    const patch = (headers, extra = {}) => rq('/api/me', Object.assign({ method: 'PATCH', body: { displayName: 'ok' }, cookie, headers }, extra));
    assert.equal((await patch({ Origin: 'https://evil.example' })).status, 403);
    assert.equal((await patch({ Origin: 'null' })).status, 403, 'opaque origin without fallback headers');
    assert.equal((await patch({ Origin: null, Referer: 'https://evil.example/page' })).status, 403);
    assert.equal((await patch({ Origin: null, Referer: `${baseUrl}/page` })).status, 200);
    assert.equal((await patch({ Origin: null })).status, 403, 'no Origin, no Referer, no Sec-Fetch-Site');
    assert.equal((await patch({ Origin: null, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await patch({ Origin: null, 'Sec-Fetch-Site': 'same-site' })).status, 403, 'same-site (a sibling subdomain) is not enough');
    assert.equal((await patch({ Origin: null, 'Sec-Fetch-Site': 'same-origin' })).status, 200);
    assert.equal((await patch({ Origin: null, 'Sec-Fetch-Site': 'none' })).status, 200, 'user-initiated navigation');
    assert.equal((await patch({ 'Content-Type': 'text/plain' }, { body: '{"displayName":"x"}' })).status, 415);
    assert.equal((await patch({ 'Content-Type': 'application/x-www-form-urlencoded' }, { body: 'displayName=x' })).status, 415);

    // DELETE 沒有內容，不要求 JSON，但仍要同源
    assert.equal((await rq('/api/me/sessions', { method: 'DELETE', cookie, headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await rq('/api/me/sessions', { method: 'DELETE', cookie })).status, 200);
  });

  test('cookie-less header-token requests keep the older rule: a foreign Origin is refused, no Origin is accepted', async () => {
    await makeAdmin();
    const login = await post('/api/admin/login', { username: 'boss@example.org', password: 'boss-password' });
    const token = login.json.token;
    const call = headers => rq('/api/admin/registration', { method: 'POST', body: { hourlyCap: 30 }, headers: Object.assign({ 'X-Admin-Token': token }, headers) });
    assert.equal((await call({ Origin: null })).status, 200);
    assert.equal((await call({ Origin: 'https://evil.example' })).status, 403);
  });

  test('logout clears the cookie and kills the session; login always issues a new cookie value (no fixation)', async () => {
    const first = await registerAndVerify('fixation@example.org', 'fixation-pass-1');
    const second = await loginAs('fixation@example.org', 'fixation-pass-1');
    assert.notEqual(first, second);
    const out = await post('/api/auth/logout', {}, second);
    assert.ok(out.headers['set-cookie'].some(c => /^mdw_sid=;/.test(c) && /Max-Age=0/.test(c) && /HttpOnly/.test(c)));
    assert.equal((await rq('/api/me', { cookie: second })).json.user, null);
    assert.ok((await rq('/api/me', { cookie: first })).json.user, 'other devices unaffected');
  });
});
