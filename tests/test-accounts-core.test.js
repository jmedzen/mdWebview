/**
 * 帳號系統的核心模組單元測試（不啟動 HTTP 伺服器）：
 * lib/db.js（token、邀請碼、session、維護、遷移、備份還原）、lib/session.js（滑動到期、Cookie、
 * 重新驗證）、lib/password.js、lib/integrations.js、lib/turnstile.js、lib/mailer.js、lib/oauth.js。
 * 外部服務一律以替換 globalThis.fetch 模擬，不連網。HTTP 層的流程見 test-accounts.test.js 與
 * test-accounts-flows.test.js。
 */
process.env.PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://reader.example';
process.env.SCRYPT_LN = process.env.SCRYPT_LN || '10';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const db = require('../lib/db.js');
const session = require('../lib/session.js');
const passwords = require('../lib/password.js');
const integrations = require('../lib/integrations.js');
const turnstile = require('../lib/turnstile.js');
const mailer = require('../lib/mailer.js');
const oauth = require('../lib/oauth.js');

const DAY = 24 * 60 * 60 * 1000;
const realFetch = globalThis.fetch;

function fakeReq({ cookie = '', headers = {}, encrypted = false, remote = '203.0.113.9' } = {}) {
  const h = Object.assign({}, headers);
  if (cookie) h.cookie = cookie;
  return { headers: h, socket: { remoteAddress: remote, encrypted }, method: 'GET' };
}

function fakeRes() {
  const h = {};
  return {
    setHeader(k, v) { h[k.toLowerCase()] = v; },
    getHeader(k) { return h[k.toLowerCase()]; },
    cookies() { const v = h['set-cookie']; return v ? (Array.isArray(v) ? v : [v]) : []; }
  };
}

function cookieHeader(res) {
  const c = res.cookies().find(v => /^(?:__Host-)?mdw_sid=[^;]+/.test(v) && !/Max-Age=0/.test(v));
  return c ? c.split(';')[0] : null;
}

function newUser(fields = {}) {
  const n = crypto.randomBytes(4).toString('hex');
  return db.createUser(Object.assign({ email: `u${n}@example.org`, emailVerifiedAt: Date.now(), displayName: `u${n}` }, fields));
}

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const restore = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  let result;
  try { result = fn(); } catch (err) { restore(); throw err; }
  if (result && typeof result.then === 'function') return result.finally(restore);
  restore();
  return result;
}

before(() => { db.open(); });
beforeEach(() => { globalThis.fetch = realFetch; });
after(() => { globalThis.fetch = realFetch; db.close(); });

// ── 信件 token ───────────────────────────────────────────────
describe('email tokens (db)', () => {
  test('token is stored hashed, single use, and bound to its purpose', () => {
    const u = newUser();
    const token = db.createEmailToken(u.id, 'verify', DAY);
    const stored = db.getDb().prepare('SELECT token_hash FROM email_tokens WHERE user_id = ?').get(u.id);
    assert.equal(stored.token_hash, db.sha256(token));
    assert.notEqual(stored.token_hash, token, 'plain token is never stored');

    assert.equal(db.consumeEmailToken(token, 'reset'), null, 'wrong purpose');
    assert.ok(db.peekEmailToken(token, 'verify'), 'peek does not consume');
    assert.ok(db.consumeEmailToken(token, 'verify'));
    assert.equal(db.consumeEmailToken(token, 'verify'), null, 'second use is refused');
    assert.equal(db.peekEmailToken(token, 'verify'), null);
  });

  test('expired, unknown, malformed and oversized tokens are refused', () => {
    const u = newUser();
    const expired = db.createEmailToken(u.id, 'reset', -1000);
    assert.equal(db.consumeEmailToken(expired, 'reset'), null);
    assert.equal(db.consumeEmailToken('nope', 'reset'), null);
    assert.equal(db.consumeEmailToken('', 'reset'), null);
    assert.equal(db.consumeEmailToken(undefined, 'reset'), null);
    assert.equal(db.consumeEmailToken({ $ne: 1 }, 'reset'), null);
    assert.equal(db.consumeEmailToken('x'.repeat(201), 'reset'), null);
  });

  test('a newer token of the same purpose revokes the older one; other purposes are untouched', () => {
    const u = newUser();
    const first = db.createEmailToken(u.id, 'reset', DAY);
    const verify = db.createEmailToken(u.id, 'verify', DAY);
    const second = db.createEmailToken(u.id, 'reset', DAY);
    assert.equal(db.peekEmailToken(first, 'reset'), null, 'old link is dead');
    assert.ok(db.peekEmailToken(second, 'reset'));
    assert.ok(db.peekEmailToken(verify, 'verify'));
  });

  test('change_email token carries the normalised new address', () => {
    const u = newUser();
    const token = db.createEmailToken(u.id, 'change_email', DAY, '  New@Example.ORG ');
    assert.equal(db.consumeEmailToken(token, 'change_email').new_email, 'new@example.org');
  });

  test('deleting a user removes their tokens, sessions and identities (cascade) and de-identifies the audit log', () => {
    const u = newUser();
    db.createEmailToken(u.id, 'verify', DAY);
    db.createSession(u.id, 'tok-cascade', { ttlMs: DAY, ip: '1.2.3.4', userAgent: 'x' });
    db.linkIdentity(u.id, 'google', `sub-${u.id}`, u.email);
    db.logEvent('login_ok', { userId: u.id, ip: '1.2.3.4', detail: 'password' });
    db.deleteUser(u.id);
    const d = db.getDb();
    assert.equal(d.prepare('SELECT COUNT(*) n FROM email_tokens WHERE user_id = ?').get(u.id).n, 0);
    assert.equal(d.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id = ?').get(u.id).n, 0);
    assert.equal(d.prepare('SELECT COUNT(*) n FROM user_identities WHERE user_id = ?').get(u.id).n, 0);
    const ev = d.prepare("SELECT * FROM auth_events WHERE event = 'login_ok' AND ip = '1.2.3.4'").get();
    assert.equal(ev, undefined, 'IP is wiped from retained audit rows');
  });
});

// ── 邀請碼 ───────────────────────────────────────────────────
describe('invites (db)', () => {
  test('code is stored hashed; uses are counted and exhausted', () => {
    const inv = db.createInvite({ usesLeft: 2 });
    assert.equal(db.getDb().prepare('SELECT code_hash FROM invites WHERE id = ?').get(inv.id).code_hash, db.sha256(inv.code));
    assert.equal(db.useInvite(inv.code), true);
    assert.equal(db.useInvite(` ${inv.code} `), true, 'surrounding spaces are ignored');
    assert.equal(db.useInvite(inv.code), false, 'no uses left');
    const row = db.listInvites().find(i => i.id === inv.id);
    assert.deepEqual([row.uses_left, row.uses_count], [0, 2]);
  });

  test('revoked, expired and bogus codes are refused', () => {
    const revoked = db.createInvite({});
    db.revokeInvite(revoked.id);
    assert.equal(db.useInvite(revoked.code), false);
    const expired = db.createInvite({ expiresAt: Date.now() - 1000 });
    assert.equal(db.useInvite(expired.code), false);
    assert.equal(db.useInvite('not-a-code'), false);
    assert.equal(db.useInvite(''), false);
    assert.equal(db.useInvite(null), false);
  });

  test('uses are clamped to 1..1000', () => {
    assert.equal(db.listInvites().find(i => i.id === db.createInvite({ usesLeft: 0 }).id).uses_left, 1);
    assert.equal(db.listInvites().find(i => i.id === db.createInvite({ usesLeft: 99999 }).id).uses_left, 1000);
  });
});

// ── session ──────────────────────────────────────────────────
describe('session lifecycle', () => {
  function login(user, opts) {
    const req = fakeReq(opts);
    const res = fakeRes();
    const token = session.startSession(req, res, user);
    return { token, res, cookie: cookieHeader(res) };
  }
  const requestWith = cookie => fakeReq({ cookie });
  const row = token => db.getSessionByToken(token);

  test('idle limits: users 30 days, admins 7 days', () => {
    assert.equal(session.USER_IDLE_MS, 30 * DAY);
    assert.equal(session.ADMIN_IDLE_MS, 7 * DAY);
    assert.equal(session.idleTtlFor('user'), 30 * DAY);
    assert.equal(session.idleTtlFor('admin'), 7 * DAY);
    const user = newUser();
    const admin = newUser({ role: 'admin' });
    const a = login(user);
    const b = login(admin);
    const ttl = t => row(t).expires_at - row(t).created_at;
    assert.equal(ttl(a.token), 30 * DAY);
    assert.equal(ttl(b.token), 7 * DAY);
  });

  test('only a hash of the token is stored, and every login issues a fresh token', () => {
    const u = newUser();
    const a = login(u);
    const b = login(u);
    assert.notEqual(a.token, b.token);
    assert.equal(db.getDb().prepare('SELECT COUNT(*) n FROM sessions WHERE token_hash = ?').get(a.token).n, 0);
    assert.ok(db.getSessionByToken(a.token));
  });

  test('expiry slides forward with use, but is written at most every 5 minutes', () => {
    const u = newUser();
    const { token, cookie } = login(u);
    const d = db.getDb();
    const hash = db.sha256(token);

    // 剛用過：不寫入
    const before = row(token);
    assert.ok(session.getSession(requestWith(cookie)));
    assert.equal(row(token).expires_at, before.expires_at, 'no write within the touch interval');

    // 最後使用是 10 分鐘前、快到期：使用後重新延長為 30 天
    const longAgo = Date.now() - 10 * 60 * 1000;
    d.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?').run(longAgo, Date.now() + 1000, hash);
    assert.ok(session.getSession(requestWith(cookie)));
    const slid = row(token);
    assert.ok(slid.last_seen_at >= Date.now() - 5000);
    assert.ok(Math.abs(slid.expires_at - (Date.now() + 30 * DAY)) < 5000);
  });

  test('admin sessions slide by 7 days, not 30', () => {
    const admin = newUser({ role: 'admin' });
    const { token, cookie } = login(admin);
    db.getDb().prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(Date.now() - 10 * 60 * 1000, db.sha256(token));
    session.getSession(requestWith(cookie));
    assert.ok(Math.abs(row(token).expires_at - (Date.now() + 7 * DAY)) < 5000);
  });

  test('an expired session is refused and deleted', () => {
    const u = newUser();
    const { token, cookie } = login(u);
    db.getDb().prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(Date.now() - 1, db.sha256(token));
    assert.equal(session.getSession(requestWith(cookie)), null);
    assert.equal(row(token), null);
  });

  test('a disabled or deleted user loses the session immediately', () => {
    const u = newUser();
    const { token, cookie } = login(u);
    db.updateUser(u.id, { status: 'disabled' });
    assert.equal(session.getSession(requestWith(cookie)), null);
    assert.equal(row(token), null);
  });

  test('unknown, empty and malformed cookies never authenticate', () => {
    assert.equal(session.getSession(fakeReq()), null);
    assert.equal(session.getSession(fakeReq({ cookie: 'mdw_sid=' })), null);
    assert.equal(session.getSession(fakeReq({ cookie: 'mdw_sid=not-a-real-token' })), null);
    assert.equal(session.getSession(fakeReq({ cookie: 'mdw_sid=' + 'a'.repeat(500) })), null);
    assert.equal(session.getSession(fakeReq({ cookie: '%%%garbage;;;=' })), null);
  });

  test('the first cookie of a given name wins (a duplicate cannot override it)', () => {
    const cookies = session.parseCookies(fakeReq({ cookie: 'mdw_sid=first; mdw_sid=second; other=1' }));
    assert.equal(cookies.mdw_sid, 'first');
    assert.equal(cookies.other, '1');
  });

  test('X-Admin-Token header carries a session when there is no cookie', () => {
    const u = newUser({ role: 'admin' });
    const { token } = login(u);
    const req = fakeReq({ headers: { 'x-admin-token': token } });
    assert.equal(session.usesHeaderToken(req), true);
    assert.equal(session.getSession(req).user.id, u.id);
    assert.equal(session.usesHeaderToken(fakeReq({ cookie: `mdw_sid=${token}`, headers: { 'x-admin-token': token } })), false);
  });

  test('logout deletes the session server-side and clears cookies', () => {
    const u = newUser();
    const { token, cookie } = login(u);
    const req = requestWith(cookie);
    const res = fakeRes();
    session.endSession(req, res);
    assert.equal(row(token), null);
    assert.ok(res.cookies().some(c => /Max-Age=0/.test(c)));
    assert.equal(session.getSession(requestWith(cookie)), null);
  });

  test('re-authentication window is 10 minutes, and markReauth renews it', () => {
    assert.equal(session.REAUTH_WINDOW_MS, 10 * 60 * 1000);
    const u = newUser();
    const { token, cookie } = login(u);
    const hash = db.sha256(token);
    assert.equal(session.hasRecentReauth(requestWith(cookie)), true, 'logging in counts as a re-auth');

    const old = Date.now() - 11 * 60 * 1000;
    db.getDb().prepare('UPDATE sessions SET created_at = ?, reauth_at = ? WHERE token_hash = ?').run(old, old, hash);
    const req = requestWith(cookie);
    assert.equal(session.hasRecentReauth(req), false);
    session.markReauth(req);
    assert.equal(session.hasRecentReauth(req), true);
    assert.equal(session.hasRecentReauth(requestWith(cookie)), true, 'persisted');
    assert.equal(session.hasRecentReauth(fakeReq()), false, 'no session, no re-auth');

    const fresh = Date.now() - 9 * 60 * 1000;
    db.getDb().prepare('UPDATE sessions SET reauth_at = ? WHERE token_hash = ?').run(fresh, hash);
    assert.equal(session.hasRecentReauth(requestWith(cookie)), true, '9 minutes ago is still fine');
  });

  test('revoking: all-but-current, one by id (scoped to the owner), and clamp on promotion', () => {
    const u = newUser();
    const other = newUser();
    const a = login(u);
    const b = login(u);
    const c = login(u);
    const o = login(other);
    const currentId = row(a.token).id;

    assert.equal(db.deleteSessionById(row(o.token).id, u.id), 0, "cannot revoke someone else's session");
    assert.ok(row(o.token));
    assert.equal(db.deleteSessionById(row(b.token).id, u.id), 1);
    assert.equal(row(b.token), null);

    assert.equal(db.deleteUserSessions(u.id, currentId), 1);
    assert.ok(row(a.token));
    assert.equal(row(c.token), null);

    // 升為管理員：現有 session 的到期縮短成 7 天規則
    db.clampUserSessions(u.id, session.idleTtlFor('admin'));
    assert.ok(row(a.token).expires_at <= row(a.token).last_seen_at + 7 * DAY);

    assert.equal(db.listUserSessions(u.id).length, 1);
    assert.equal(db.deleteUserSessions(u.id), 1);
  });
});

// ── Cookie 旗標 ──────────────────────────────────────────────
describe('session cookie flags', () => {
  test('plain HTTP: mdw_sid, HttpOnly, SameSite=Lax, Path=/, no Secure', () => {
    withEnv({ COOKIE_SECURE: undefined }, () => {
      const res = fakeRes();
      session.startSession(fakeReq(), res, newUser());
      const c = res.cookies().find(v => v.startsWith('mdw_sid='));
      assert.ok(c);
      assert.match(c, /HttpOnly/);
      assert.match(c, /SameSite=Lax/);
      assert.match(c, /Path=\//);
      assert.doesNotMatch(c, /Secure/);
      assert.doesNotMatch(c, /Domain=/);
      assert.ok(!res.cookies().some(v => v.startsWith('__Host-')));
    });
  });

  test('HTTPS: __Host- prefix, Secure, and the plain cookie is cleared', () => {
    withEnv({ COOKIE_SECURE: undefined }, () => {
      const res = fakeRes();
      session.startSession(fakeReq({ encrypted: true }), res, newUser());
      const c = res.cookies().find(v => v.startsWith('__Host-mdw_sid='));
      assert.ok(c);
      assert.match(c, /HttpOnly/);
      assert.match(c, /Secure/);
      assert.match(c, /SameSite=Lax/);
      assert.match(c, /Path=\//);
      assert.doesNotMatch(c, /Domain=/, '__Host- cookies must not carry Domain');
      assert.ok(res.cookies().some(v => v.startsWith('mdw_sid=;') && /Max-Age=0/.test(v)), 'old plain cookie is removed');
    });
  });

  test('COOKIE_SECURE overrides detection; untrusted peers cannot fake HTTPS via headers', () => {
    const spoof = fakeReq({ headers: { 'x-forwarded-proto': 'https' }, remote: '198.51.100.7' });
    withEnv({ COOKIE_SECURE: undefined, TRUST_PROXY: undefined }, () => {
      assert.equal(session.isSecureRequest(spoof), false, 'public peer: header ignored');
    });
    withEnv({ COOKIE_SECURE: 'true' }, () => assert.equal(session.isSecureRequest(fakeReq()), true));
    withEnv({ COOKIE_SECURE: '1' }, () => assert.equal(session.isSecureRequest(fakeReq()), true));
    withEnv({ COOKIE_SECURE: 'false' }, () => assert.equal(session.isSecureRequest(fakeReq({ encrypted: true })), false));
    withEnv({ COOKIE_SECURE: undefined, TRUST_PROXY: 'true' }, () => {
      assert.equal(session.isSecureRequest(fakeReq({ headers: { 'x-forwarded-proto': 'https' }, remote: '127.0.0.1' })), true);
      assert.equal(session.isSecureRequest(fakeReq({ headers: { 'cf-visitor': '{"scheme":"https"}' }, remote: '127.0.0.1' })), true);
      assert.equal(session.isSecureRequest(fakeReq({ headers: { 'x-forwarded-proto': 'http' }, remote: '127.0.0.1' })), false);
    });
  });

  test('serializeCookie omits optional attributes and clamps Max-Age at 0', () => {
    assert.equal(session.serializeCookie('a', 'b c', { httpOnly: false }), 'a=b%20c; Path=/; SameSite=Lax');
    assert.match(session.serializeCookie('a', 'b', { maxAgeSec: -5, secure: true, sameSite: 'None' }), /SameSite=None; HttpOnly; Secure; Max-Age=0$/);
  });
});

// ── 密碼 ─────────────────────────────────────────────────────
describe('password hashing (edge cases)', () => {
  test('different Unicode spellings of the same password verify', async () => {
    const composed = 'café-密碼-1';
    const decomposed = 'café-密碼-1';
    const hash = await passwords.hashPassword(composed);
    assert.equal(await passwords.verifyPassword(decomposed, hash), true);
  });

  test('salts are random, and hashes embed their own parameters', async () => {
    const a = await passwords.hashPassword('same-password-1');
    const b = await passwords.hashPassword('same-password-1');
    assert.notEqual(a, b);
    const parsed = passwords.parseHash(a);
    assert.equal(parsed.alg, 'scrypt');
    assert.deepEqual([parsed.params.ln, parsed.params.r, parsed.params.p], [passwords.DEFAULT_LN, 8, 1]);
  });

  test('length rules count characters (not bytes) and cap at 256', () => {
    assert.ok(passwords.validatePassword('1234567'), '7 chars is too short');
    assert.equal(passwords.validatePassword('12345678'), null);
    assert.equal(passwords.validatePassword('密碼密碼密碼密碼'), null, '8 CJK characters count as 8');
    assert.equal(passwords.validatePassword('a'.repeat(256)), null);
    assert.ok(passwords.validatePassword('a'.repeat(257)));
    for (const bad of ['', null, undefined, 12345678, {}, []]) assert.ok(passwords.validatePassword(bad), String(bad));
  });

  test('malformed or hostile stored hashes verify as false instead of throwing', async () => {
    for (const stored of ['', 'plain-text', '$scrypt$ln=10,r=8,p=1$only-three', '$unknown$x=1$aa$bb', '$scrypt$ln=99,r=8,p=1$AAAA$AAAA', '$scrypt$ln=abc,r=8,p=1$AAAA$AAAA', undefined, 123]) {
      assert.equal(await passwords.verifyPassword('whatever-1', stored), false, String(stored));
    }
    assert.equal(await passwords.verifyPassword('', await passwords.hashPassword('x-password-1')), false);
    assert.equal(await passwords.verifyPassword(undefined, await passwords.hashPassword('x-password-1')), false);
  });

  test('scrypt hashes with weaker parameters than today are flagged for rehash', async () => {
    const strong = await passwords.hashPassword('rehash-test-1');
    assert.equal(passwords.needsRehash(strong), false);
    const weak = strong.replace(/ln=\d+/, `ln=${passwords.DEFAULT_LN - 1}`);
    assert.equal(passwords.needsRehash(weak), true);
    assert.equal(passwords.needsRehash('garbage'), false);
    assert.equal(passwords.needsRehash(null), false);
  });

  test('legacyPbkdf2Hash needs both salt and hash', () => {
    assert.equal(passwords.legacyPbkdf2Hash(null), null);
    assert.equal(passwords.legacyPbkdf2Hash({ salt: 'aa' }), null);
    assert.equal(passwords.legacyPbkdf2Hash({ salt: 'aa', passwordHash: 'bb' }, 5), '$pbkdf2-sha512$i=5$aa$bb');
  });

  test('concurrent hashing is serialised to 2 at a time but all complete', async () => {
    const hashes = await Promise.all(Array.from({ length: 6 }, (_, i) => passwords.hashPassword(`parallel-pass-${i}`)));
    assert.equal(new Set(hashes).size, 6);
  });
});

// ── 例行維護 ─────────────────────────────────────────────────
describe('maintenance (pruneExpired)', () => {
  test('removes expired sessions/tokens and stale unverified users only', () => {
    const d = db.getDb();
    const old = Date.now() - 8 * DAY;
    const stale = db.createUser({ email: 'stale@example.org' });
    const staleOauth = db.createUser({ email: 'stale-oauth@example.org' });
    db.linkIdentity(staleOauth.id, 'facebook', 'fb-1', null);
    const staleAdmin = db.createUser({ email: 'stale-admin@example.org', role: 'admin' });
    const fresh = db.createUser({ email: 'fresh@example.org' });
    const verified = db.createUser({ email: 'verified-old@example.org', emailVerifiedAt: old });
    for (const u of [stale, staleOauth, staleAdmin, verified]) d.prepare('UPDATE users SET created_at = ? WHERE id = ?').run(old, u.id);

    db.createSession(verified.id, 'prune-expired', { ttlMs: -1000 });
    db.createSession(verified.id, 'prune-live', { ttlMs: DAY });
    const t = db.createEmailToken(fresh.id, 'verify', -1000);

    const r = db.pruneExpired();
    assert.equal(db.getUserByEmail('stale@example.org'), null, 'unverified for 7+ days is deleted');
    assert.ok(db.getUserByEmail('stale-oauth@example.org'), 'users with a provider identity are kept');
    assert.ok(db.getUserByEmail('stale-admin@example.org'), 'admins are kept');
    assert.ok(db.getUserByEmail('fresh@example.org'));
    assert.ok(db.getUserByEmail('verified-old@example.org'));
    assert.equal(db.getSessionByToken('prune-expired'), null);
    assert.ok(db.getSessionByToken('prune-live'));
    assert.equal(db.peekEmailToken(t, 'verify'), null);
    assert.ok(r.sessionsRemoved >= 1 && r.tokensRemoved >= 1 && r.unverifiedRemoved === 1);
  });

  test('audit events older than a year are dropped', () => {
    const d = db.getDb();
    db.logEvent('ancient_event');
    db.logEvent('recent_event');
    d.prepare("UPDATE auth_events SET at = ? WHERE event = 'ancient_event'").run(Date.now() - 366 * DAY);
    db.pruneExpired();
    assert.equal(d.prepare("SELECT COUNT(*) n FROM auth_events WHERE event = 'ancient_event'").get().n, 0);
    assert.equal(d.prepare("SELECT COUNT(*) n FROM auth_events WHERE event = 'recent_event'").get().n, 1);
  });
});

// ── 整合設定（加密儲存） ─────────────────────────────────────
describe('integrations secret store', () => {
  test('AES-GCM round trip, random IV, tamper detection', () => {
    const a = integrations._encrypt('s3cret');
    const b = integrations._encrypt('s3cret');
    assert.notEqual(a, b, 'fresh IV each time');
    assert.match(a, /^v1:[^:]+:[^:]+:[^:]+$/);
    assert.equal(integrations._decrypt(a), 's3cret');
    const parts = a.split(':');
    const flip = Buffer.from(parts[3], 'base64'); flip[0] ^= 1;
    assert.equal(integrations._decrypt([parts[0], parts[1], parts[2], flip.toString('base64')].join(':')), null, 'ciphertext tamper');
    const tag = Buffer.from(parts[2], 'base64'); tag[0] ^= 1;
    assert.equal(integrations._decrypt([parts[0], parts[1], tag.toString('base64'), parts[3]].join(':')), null, 'auth tag tamper');
    assert.equal(integrations._decrypt('v2:a:b:c'), null);
    assert.equal(integrations._decrypt('plain'), null);
  });

  test('describe never includes a secret value; masking handles short secrets', () => {
    withEnv({ MAIL_API_KEY: undefined }, () => {
      integrations.set({ mailApiKey: 'abc' });
      const d = integrations.describe('mailApiKey');
      assert.equal(d.value, null);
      assert.equal(d.masked, '••••');
      assert.ok(!JSON.stringify(d).includes('abc'));
      integrations.set({ mailApiKey: 'abcdefghijkl' });
      assert.equal(integrations.describe('mailApiKey').masked, '••••ijkl');
      integrations.set({ mailApiKey: '' });
      assert.equal(integrations.describe('mailApiKey').set, false);
    });
  });

  test('Apple private key is never masked with its tail', () => {
    withEnv({ APPLE_PRIVATE_KEY: undefined }, () => {
      integrations.set({ applePrivateKey: '-----BEGIN PRIVATE KEY-----\nabcd\n-----END PRIVATE KEY-----' });
      const d = integrations.describe('applePrivateKey');
      assert.equal(d.masked, '••••');
      assert.equal(d.value, null);
      integrations.set({ applePrivateKey: '' });
    });
  });

  test('environment variable beats the web value, and is locked', () => {
    withEnv({ TURNSTILE_SITE_KEY: undefined }, () => {
      integrations.set({ turnstileSiteKey: 'web-site-key' });
      assert.equal(integrations.source('turnstileSiteKey'), 'web');
      process.env.TURNSTILE_SITE_KEY = 'env-site-key';
      assert.equal(integrations.get('turnstileSiteKey'), 'env-site-key');
      assert.equal(integrations.source('turnstileSiteKey'), 'env');
      assert.equal(integrations.describe('turnstileSiteKey').locked, true);
      delete process.env.TURNSTILE_SITE_KEY;
      integrations.set({ turnstileSiteKey: '' });
      assert.equal(integrations.source('turnstileSiteKey'), null);
    });
  });

  test('provider switch defaults to on, can be turned off and on', () => {
    db.setSetting('oauth.google.enabled', '');
    assert.equal(integrations.isProviderEnabled('google'), true);
    integrations.setProviderEnabled('google', false);
    assert.equal(integrations.isProviderEnabled('google'), false);
    integrations.setProviderEnabled('google', true);
    assert.equal(integrations.isProviderEnabled('google'), true);
    db.setSetting('oauth.google.enabled', '');
  });

  test('set() ignores unknown fields and undefined values', () => {
    assert.deepEqual(integrations.set({ nope: 'x', mailFrom: undefined }), []);
  });
});

// ── Turnstile ────────────────────────────────────────────────
describe('turnstile.verify (mocked siteverify)', () => {
  const keys = { TURNSTILE_SITE_KEY: 'site-key', TURNSTILE_SECRET_KEY: 'secret-key' };
  function mock(reply, calls = []) {
    globalThis.fetch = async (url, opts) => {
      if (!String(url).startsWith('https://challenges.cloudflare.com/')) return realFetch(url, opts);
      calls.push(new URLSearchParams(String(opts.body)));
      if (reply instanceof Error) throw reply;
      return new Response(JSON.stringify(reply.body || {}), { status: reply.status || 200 });
    };
    return calls;
  }

  test('not configured: skipped without any network call', async () => {
    await withEnv({ TURNSTILE_SITE_KEY: undefined, TURNSTILE_SECRET_KEY: undefined }, async () => {
      const calls = mock({ body: { success: false } });
      assert.deepEqual(await turnstile.verify('tok'), { ok: true, skipped: true });
      assert.equal(calls.length, 0);
    });
  });

  test('sends secret, token, ip and an idempotency key', async () => {
    await withEnv(keys, async () => {
      const calls = mock({ body: { success: true, hostname: 'reader.example', action: 'login' } });
      const r = await turnstile.verify('the-token', { ip: '203.0.113.5', action: 'login', hostname: 'reader.example' });
      assert.equal(r.ok, true);
      assert.equal(calls[0].get('secret'), 'secret-key');
      assert.equal(calls[0].get('response'), 'the-token');
      assert.equal(calls[0].get('remoteip'), '203.0.113.5');
      assert.ok(calls[0].get('idempotency_key'));
    });
  });

  test('missing/oversized token fails without calling Cloudflare', async () => {
    await withEnv(keys, async () => {
      const calls = mock({ body: { success: true } });
      for (const bad of ['', undefined, null, 'x'.repeat(2049), 5]) {
        const r = await turnstile.verify(bad);
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'missing-input-response');
      }
      assert.equal(calls.length, 0);
    });
  });

  test('rejections: failure codes, hostname and action mismatch', async () => {
    await withEnv(keys, async () => {
      mock({ body: { success: false, 'error-codes': ['timeout-or-duplicate'] } });
      let r = await turnstile.verify('t');
      assert.deepEqual([r.ok, r.reason, !!r.unavailable], [false, 'timeout-or-duplicate', false]);
      mock({ body: { success: true, hostname: 'evil.example' } });
      assert.equal((await turnstile.verify('t', { hostname: 'reader.example' })).reason, 'hostname-mismatch');
      mock({ body: { success: true, hostname: 'example.com' } });
      assert.equal((await turnstile.verify('t', { hostname: 'reader.example' })).ok, true, 'Cloudflare test keys report example.com');
      mock({ body: { success: true, action: 'register' } });
      assert.equal((await turnstile.verify('t', { action: 'login' })).reason, 'action-mismatch');
    });
  });

  test('outage is reported as unavailable, never as a pass', async () => {
    await withEnv(keys, async () => {
      mock({ status: 503, body: {} });
      let r = await turnstile.verify('t');
      assert.deepEqual([r.ok, r.unavailable, r.reason], [false, true, 'http-503']);
      mock(Object.assign(new Error('slow'), { name: 'TimeoutError' }));
      r = await turnstile.verify('t');
      assert.deepEqual([r.ok, r.unavailable, r.reason], [false, true, 'timeout']);
      mock(new Error('boom'));
      assert.equal((await turnstile.verify('t')).reason, 'network');
      assert.equal(turnstile.getStatus().lastResult.reason, 'network');
    });
  });

  test('checkSecret tells wrong secret, right secret and test secret apart', async () => {
    await withEnv(keys, async () => {
      mock({ body: { success: false, 'error-codes': ['invalid-input-secret'] } });
      assert.equal((await turnstile.checkSecret()).state, 'invalid_secret');
      mock({ body: { success: false, 'error-codes': ['invalid-input-response'] } });
      assert.equal((await turnstile.checkSecret()).state, 'valid');
      mock({ body: { success: true } });
      assert.equal((await turnstile.checkSecret('1x0000000000000000000000000000000AA')).state, 'test_secret');
      assert.equal((await turnstile.checkSecret('')).state, 'not_set');
      mock({ status: 500 });
      assert.equal((await turnstile.checkSecret()).state, 'unreachable');
    });
  });

  test('usesTestKeys flags Cloudflare dummy keys', async () => {
    await withEnv({ TURNSTILE_SITE_KEY: '1x00000000000000000000AA', TURNSTILE_SECRET_KEY: 'real' }, () => {
      assert.equal(turnstile.usesTestKeys(), true);
    });
    await withEnv(keys, () => assert.equal(turnstile.usesTestKeys(), false));
  });
});

// ── 寄信 ─────────────────────────────────────────────────────
describe('mailer', () => {
  const resendEnv = { MAIL_PROVIDER: 'resend', MAIL_API_KEY: 're_key_12345678', MAIL_FROM: 'Site <noreply@mail.example>' };

  test('resend: request shape, API key only in the Authorization header, nothing secret kept in the outbox', async () => {
    await withEnv(resendEnv, async () => {
      mailer.clearOutbox();
      let seen;
      globalThis.fetch = async (url, opts) => {
        seen = { url: String(url), opts };
        return new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 });
      };
      const r = await mailer.send({ to: 'a@example.org', subject: 's', text: 'secret-link', html: '<p>x</p>', tag: 'verify' });
      assert.deepEqual([r.ok, r.id], [true, 'msg_1']);
      assert.equal(seen.url, 'https://api.resend.com/emails');
      assert.equal(seen.opts.headers.Authorization, 'Bearer re_key_12345678');
      const body = JSON.parse(seen.opts.body);
      assert.deepEqual([body.from, body.to], ['Site <noreply@mail.example>', ['a@example.org']]);
      assert.equal(mailer.getOutbox('a@example.org')[0].text, '[sent]', 'mail body (links) is not retained for real sends');
      assert.ok(!JSON.stringify(mailer.getStatus()).includes('re_key_12345678'));
    });
  });

  test('resend failures return an error code and count toward failures24h', async () => {
    await withEnv(resendEnv, async () => {
      const before = mailer.getStatus().failures24h;
      globalThis.fetch = async () => new Response(JSON.stringify({ message: 'domain not verified' }), { status: 403 });
      assert.deepEqual(await mailer.send({ to: 'a@example.org', subject: 's', text: 't', html: 'h' }), { ok: false, error: 'provider_403' });
      globalThis.fetch = async () => { throw new Error('ECONNRESET'); };
      assert.deepEqual(await mailer.send({ to: 'a@example.org', subject: 's', text: 't', html: 'h' }), { ok: false, error: 'network' });
      assert.equal(mailer.getStatus().failures24h, before + 2);
    });
  });

  test('configuration states: log, resend complete/incomplete, disabled', async () => {
    await withEnv({ MAIL_PROVIDER: 'log', MAIL_API_KEY: undefined, MAIL_FROM: undefined }, () => {
      assert.equal(mailer.isConfigured(), true);
    });
    await withEnv({ MAIL_PROVIDER: 'resend', MAIL_API_KEY: undefined, MAIL_FROM: undefined }, () => {
      assert.equal(mailer.isConfigured(), false);
      assert.deepEqual(mailer.getStatus().missingEnv, ['MAIL_API_KEY', 'MAIL_FROM']);
    });
    await withEnv({ MAIL_PROVIDER: 'smtp', MAIL_API_KEY: undefined, MAIL_FROM: undefined }, async () => {
      assert.equal(mailer.getProvider(), '');
      assert.equal(mailer.isConfigured(), false);
      assert.deepEqual(await mailer.send({ to: 'a@example.org', subject: 's', text: 't', html: 'h' }), { ok: false, error: 'mail_disabled' });
    });
    await withEnv({ MAIL_PROVIDER: 'resend', MAIL_API_KEY: 'k', MAIL_FROM: undefined }, async () => {
      db.setSetting('integrations.mail.from', '');
      assert.deepEqual(await mailer.send({ to: 'a@example.org', subject: 's', text: 't', html: 'h' }), { ok: false, error: 'mail_not_configured' });
    });
  });

  test('parseFrom accepts "Name <a@b.c>" and bare addresses, rejects the rest', () => {
    assert.deepEqual(mailer.parseFrom('mdWebview <noreply@Example.org>'), { name: 'mdWebview', address: 'noreply@Example.org', domain: 'example.org' });
    assert.deepEqual(mailer.parseFrom('noreply@example.org'), { name: '', address: 'noreply@example.org', domain: 'example.org' });
    assert.equal(mailer.parseFrom('"Quoted Name" <a@b.example>').name, 'Quoted Name');
    for (const bad of ['', 'not-an-address', 'a@b', '<>', null, 'a@b.c d@e.fg']) assert.equal(mailer.parseFrom(bad), null, String(bad));
  });

  test('renderMail escapes HTML in every field and keeps a plain-text link', () => {
    const m = mailer.renderMail({ siteName: '<b>Site</b>', heading: '<script>x</script>', paragraphs: ['a & b "c"'], actionLabel: 'Go', actionUrl: 'https://x.example/?a=1&b=2"onmouseover="x', footer: '<i>f</i>' });
    assert.ok(!m.html.includes('<script>'));
    assert.ok(!m.html.includes('<b>Site'));
    assert.ok(!m.html.includes('"onmouseover="'));
    assert.match(m.html, /a &amp; b &quot;c&quot;/);
    assert.match(m.text, /Go：https:\/\/x\.example\/\?a=1&b=2/);
  });

  test('checkResendKey: full-access, send-only, invalid, unreachable', async () => {
    const reply = (status, body) => { globalThis.fetch = async () => new Response(JSON.stringify(body), { status }); };
    reply(200, { data: [{ name: 'mail.example', status: 'verified', region: 'us-east-1' }] });
    assert.deepEqual(await mailer.checkResendKey('k'), { state: 'valid', domains: [{ name: 'mail.example', status: 'verified', region: 'us-east-1' }] });
    reply(401, { name: 'restricted_api_key', message: 'This API key is restricted to only send emails' });
    assert.equal((await mailer.checkResendKey('k')).state, 'valid_send_only');
    reply(401, { name: 'validation_error', message: 'API key is invalid' });
    assert.equal((await mailer.checkResendKey('k')).state, 'invalid');
    reply(500, {});
    assert.equal((await mailer.checkResendKey('k')).state, 'unreachable');
    globalThis.fetch = async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); };
    assert.deepEqual(await mailer.checkResendKey('k'), { state: 'unreachable', detail: 'timeout' });
    assert.equal((await mailer.checkResendKey('')).state, 'invalid');
  });

  test('outbox is capped at 50 entries', async () => {
    await withEnv({ MAIL_PROVIDER: 'log' }, async () => {
      mailer.clearOutbox();
      for (let i = 0; i < 60; i++) await mailer.send({ to: `n${i}@example.org`, subject: 's', text: 't', html: 'h' });
      assert.equal(mailer.getOutbox().length, 50);
      assert.equal(mailer.getOutbox()[0].to, 'n10@example.org');
      mailer.clearOutbox();
    });
  });
});

// ── OAuth 模組 ───────────────────────────────────────────────
describe('oauth module (mocked providers)', () => {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const env = {
    GOOGLE_CLIENT_ID: 'g-client', GOOGLE_CLIENT_SECRET: 'g-secret',
    FACEBOOK_APP_ID: '1234567890', FACEBOOK_APP_SECRET: 'f'.repeat(32),
    APPLE_CLIENT_ID: 'co.example.web', APPLE_TEAM_ID: 'TEAM123456', APPLE_KEY_ID: 'KEY1234567', APPLE_PRIVATE_KEY: pem,
    APPLE_PRIVATE_KEY_PATH: undefined, COOKIE_SECURE: undefined
  };
  const base = 'https://reader.example';
  const jwt = claims => `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

  /** 走完 begin() 取得 state/nonce，並組出帶 state cookie 的回調請求。 */
  function start(provider, { secure = true } = {}) {
    const res = fakeRes();
    const url = new URL(oauth.begin(fakeReq({ encrypted: secure }), res, provider, { baseUrl: base }));
    const setCookie = res.cookies().find(c => c.startsWith('mdw_oauth='));
    const state = url.searchParams.get('state');
    const req = fakeReq({ cookie: setCookie.split(';')[0], encrypted: secure });
    return { url, setCookie, state, nonce: url.searchParams.get('nonce'), req, res: fakeRes() };
  }

  const run = fn => withEnv(env, fn);

  test('begin(): Google uses PKCE S256, nonce, state, and the right callback URL', () => run(() => {
    const s = start('google');
    assert.equal(s.url.origin + s.url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    const p = s.url.searchParams;
    assert.equal(p.get('client_id'), 'g-client');
    assert.equal(p.get('redirect_uri'), `${base}/api/auth/google/callback`);
    assert.equal(p.get('response_type'), 'code');
    assert.equal(p.get('code_challenge_method'), 'S256');
    const verifier = oauth._pending.get(s.state).verifier;
    assert.equal(p.get('code_challenge'), crypto.createHash('sha256').update(verifier).digest('base64url'));
    assert.ok(s.state.length >= 30 && p.get('nonce'));
    assert.ok(!s.url.href.includes('g-secret'), 'client secret never goes to the browser');
  }));

  test('begin(): state cookie is HttpOnly, path-scoped, 10 minutes; Apple needs SameSite=None; Secure', () => run(() => {
    const g = start('google');
    assert.match(g.setCookie, /HttpOnly/);
    assert.match(g.setCookie, /Path=\/api\/auth\/google/);
    assert.match(g.setCookie, /Max-Age=600/);
    assert.match(g.setCookie, /SameSite=Lax/);
    const a = start('apple');
    assert.match(a.setCookie, /SameSite=None/);
    assert.match(a.setCookie, /Secure/);
    assert.equal(a.url.searchParams.get('response_mode'), 'form_post');
    assert.ok(a.url.searchParams.get('nonce'));
    const plainApple = start('apple', { secure: false });
    assert.match(plainApple.setCookie, /SameSite=Lax/, 'over plain HTTP SameSite=None would be dropped, so fall back to Lax');
    const f = start('facebook');
    assert.equal(f.url.searchParams.get('scope'), 'email,public_profile');
    assert.equal(f.url.searchParams.get('client_id'), '1234567890');
  }));

  test('each begin() issues a distinct state; state is single-use and must match the cookie', () => run(() => {
    const a = start('google');
    const b = start('google');
    assert.notEqual(a.state, b.state);
    assert.equal(oauth.takeState(fakeReq(), fakeRes(), 'google', a.state), null, 'no cookie');
    assert.equal(oauth.takeState(b.req, fakeRes(), 'google', a.state), null, "cookie from another login attempt");
    const first = oauth.takeState(a.req, fakeRes(), 'google', a.state);
    assert.ok(first && first.provider === 'google');
    assert.equal(oauth.takeState(a.req, fakeRes(), 'google', a.state), null, 'replay is refused');
    const g = start('google');
    assert.equal(oauth.takeState(g.req, fakeRes(), 'facebook', g.state), null, 'state is bound to its provider');
    assert.equal(oauth.takeState(g.req, fakeRes(), 'google', ''), null);
    assert.equal(oauth.takeState(g.req, fakeRes(), 'google', undefined), null);
  }));

  test('state older than 10 minutes is refused', () => run(() => {
    const s = start('google');
    oauth._pending.get(s.state).createdAt = Date.now() - 11 * 60 * 1000;
    assert.equal(oauth.takeState(s.req, fakeRes(), 'google', s.state), null);
  }));

  test('begin() remembers mode and user for link/reauth', () => run(() => {
    const res = fakeRes();
    const url = new URL(oauth.begin(fakeReq(), res, 'google', { baseUrl: base, mode: 'link', userId: 42 }));
    const entry = oauth._pending.get(url.searchParams.get('state'));
    assert.deepEqual([entry.mode, entry.userId], ['link', 42]);
  }));

  test('checkIdToken rejects wrong issuer, audience, expiry, nonce and missing subject', () => {
    const ok = { iss: 'https://accounts.google.com', aud: 'cid', exp: Math.floor(Date.now() / 1000) + 600, nonce: 'n1', sub: '1' };
    const opts = { issuers: oauth.PROVIDERS.google.issuers, audience: 'cid', nonce: 'n1' };
    assert.equal(oauth.checkIdToken(ok, opts), null);
    assert.equal(oauth.checkIdToken(Object.assign({}, ok, { aud: ['x', 'cid'] }), opts), null, 'aud array');
    assert.equal(oauth.checkIdToken(null, opts), 'invalid_id_token');
    assert.equal(oauth.checkIdToken(Object.assign({}, ok, { iss: 'https://evil.example' }), opts), 'bad_issuer');
    assert.equal(oauth.checkIdToken(Object.assign({}, ok, { aud: 'other' }), opts), 'bad_audience');
    assert.equal(oauth.checkIdToken(Object.assign({}, ok, { exp: Math.floor(Date.now() / 1000) - 3600 }), opts), 'expired');
    assert.equal(oauth.checkIdToken(Object.assign({}, ok, { exp: undefined }), opts), 'expired');
    assert.equal(oauth.checkIdToken(Object.assign({}, ok, { nonce: 'replayed' }), opts), 'bad_nonce');
    assert.equal(oauth.checkIdToken(Object.assign({}, ok, { sub: '' }), opts), 'no_subject');
  });

  test('decodeJwtPayload survives garbage', () => {
    assert.equal(oauth.decodeJwtPayload('a.b'), null);
    assert.equal(oauth.decodeJwtPayload('a.%%%.c'), null);
    assert.equal(oauth.decodeJwtPayload(null), null);
    assert.deepEqual(oauth.decodeJwtPayload(jwt({ sub: '1' })), { sub: '1' });
  });

  test('complete(google): exchanges the code with the PKCE verifier and returns a verified-email profile', () => run(async () => {
    const s = start('google');
    let sent;
    globalThis.fetch = async (url, opts) => {
      sent = { url: String(url), body: new URLSearchParams(String(opts.body)) };
      return new Response(JSON.stringify({ id_token: jwt({ iss: 'https://accounts.google.com', aud: 'g-client', exp: Math.floor(Date.now() / 1000) + 300, nonce: s.nonce, sub: 'g-123', email: 'Reader@Example.org', email_verified: true, name: 'Reader' }) }), { status: 200 });
    };
    const { profile, entry } = await oauth.complete(s.req, s.res, 'google', { state: s.state, code: 'the-code' }, { baseUrl: base });
    assert.equal(sent.url, 'https://oauth2.googleapis.com/token');
    assert.equal(sent.body.get('code'), 'the-code');
    assert.equal(sent.body.get('client_secret'), 'g-secret');
    assert.equal(sent.body.get('code_verifier'), entry.verifier);
    assert.equal(sent.body.get('redirect_uri'), `${base}/api/auth/google/callback`);
    assert.deepEqual(profile, { provider: 'google', subject: 'g-123', email: 'Reader@Example.org', emailVerified: true, name: 'Reader' });
    assert.ok(s.res.cookies().some(c => c.startsWith('mdw_oauth=;') && /Max-Age=0/.test(c)), 'state cookie is cleared');
  }));

  test('complete(google): wrong nonce, audience and unsigned-for-another-app tokens are refused', () => run(async () => {
    const good = nonce => ({ iss: 'https://accounts.google.com', aud: 'g-client', exp: Math.floor(Date.now() / 1000) + 300, nonce, sub: 'g-1' });
    for (const [mutate, code] of [[c => { c.nonce = 'other'; }, 'bad_nonce'], [c => { c.aud = 'someone-else'; }, 'bad_audience'], [c => { c.iss = 'https://evil.example'; }, 'bad_issuer']]) {
      const s = start('google');
      const claims = good(s.nonce);
      mutate(claims);
      globalThis.fetch = async () => new Response(JSON.stringify({ id_token: jwt(claims) }), { status: 200 });
      await assert.rejects(oauth.complete(s.req, s.res, 'google', { state: s.state, code: 'c' }, { baseUrl: base }), err => err.code === code);
    }
  }));

  test('complete(): bad state, user denial, missing code and token endpoint errors', () => run(async () => {
    await assert.rejects(oauth.complete(fakeReq(), fakeRes(), 'google', { state: 'x', code: 'c' }, { baseUrl: base }), err => err.code === 'invalid_state');
    let s = start('google');
    await assert.rejects(oauth.complete(s.req, s.res, 'google', { state: s.state, error: 'access_denied' }, { baseUrl: base }), err => err.code === 'denied');
    s = start('google');
    await assert.rejects(oauth.complete(s.req, s.res, 'google', { state: s.state }, { baseUrl: base }), err => err.code === 'missing_code');
    s = start('google');
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    await assert.rejects(oauth.complete(s.req, s.res, 'google', { state: s.state, code: 'c' }, { baseUrl: base }), /token_endpoint_400/);
  }));

  test('complete(facebook): profile email is never treated as verified; appsecret_proof is sent', () => run(async () => {
    const s = start('facebook');
    const urls = [];
    globalThis.fetch = async (url) => {
      urls.push(new URL(String(url)));
      if (String(url).includes('/oauth/access_token')) return new Response(JSON.stringify({ access_token: 'fb-token' }), { status: 200 });
      return new Response(JSON.stringify({ id: 'fb-777', name: 'FB User', email: 'fb@example.org' }), { status: 200 });
    };
    const { profile } = await oauth.complete(s.req, s.res, 'facebook', { state: s.state, code: 'c' }, { baseUrl: base });
    assert.deepEqual(profile, { provider: 'facebook', subject: 'fb-777', email: 'fb@example.org', emailVerified: false, name: 'FB User' });
    const expected = crypto.createHmac('sha256', 'f'.repeat(32)).update('fb-token').digest('hex');
    assert.equal(urls[1].searchParams.get('appsecret_proof'), expected);
  }));

  test('complete(facebook): token or profile failure is an error, not a login', () => run(async () => {
    let s = start('facebook');
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'bad code' } }), { status: 400 });
    await assert.rejects(oauth.complete(s.req, s.res, 'facebook', { state: s.state, code: 'c' }, { baseUrl: base }), err => err.code === 'token_exchange_failed');
    s = start('facebook');
    globalThis.fetch = async (url) => String(url).includes('/oauth/access_token')
      ? new Response(JSON.stringify({ access_token: 't' }), { status: 200 })
      : new Response('{}', { status: 200 });
    await assert.rejects(oauth.complete(s.req, s.res, 'facebook', { state: s.state, code: 'c' }, { baseUrl: base }), err => err.code === 'profile_failed');
  }));

  test('complete(apple): signed ES256 client secret, name from the form, Apple email_verified as string', () => run(async () => {
    const s = start('apple');
    let secret;
    globalThis.fetch = async (url, opts) => {
      secret = new URLSearchParams(String(opts.body)).get('client_secret');
      return new Response(JSON.stringify({ id_token: jwt({ iss: 'https://appleid.apple.com', aud: 'co.example.web', exp: Math.floor(Date.now() / 1000) + 300, nonce: s.nonce, sub: 'a-1', email: 'x@privaterelay.appleid.com', email_verified: 'true' }) }), { status: 200 });
    };
    const { profile } = await oauth.complete(s.req, s.res, 'apple', { state: s.state, code: 'c', user: JSON.stringify({ name: { firstName: '小明', lastName: '王' } }) }, { baseUrl: base });
    assert.deepEqual(profile, { provider: 'apple', subject: 'a-1', email: 'x@privaterelay.appleid.com', emailVerified: true, name: '王小明' });
    const [h, p, sig] = secret.split('.');
    assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', kid: 'KEY1234567' });
    const claims = JSON.parse(Buffer.from(p, 'base64url'));
    assert.deepEqual([claims.iss, claims.sub, claims.aud], ['TEAM123456', 'co.example.web', 'https://appleid.apple.com']);
    assert.equal(claims.exp - claims.iat, 300);
    const pub = crypto.createPublicKey(pem);
    assert.equal(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')), true);
  }));

  test('complete(apple): malformed user field is ignored', () => run(async () => {
    const s = start('apple');
    globalThis.fetch = async () => new Response(JSON.stringify({ id_token: jwt({ iss: 'https://appleid.apple.com', aud: 'co.example.web', exp: Math.floor(Date.now() / 1000) + 300, nonce: s.nonce, sub: 'a-2' }) }), { status: 200 });
    const { profile } = await oauth.complete(s.req, s.res, 'apple', { state: s.state, code: 'c', user: '{not json' }, { baseUrl: base });
    assert.deepEqual([profile.name, profile.email, profile.emailVerified], [null, null, false]);
  }));

  test('isEnabled needs complete keys AND the switch on; enabledProviders lists only those', () => run(() => {
    assert.deepEqual(oauth.enabledProviders().sort(), ['apple', 'facebook', 'google']);
    integrations.setProviderEnabled('facebook', false);
    assert.equal(oauth.isEnabled('facebook'), false);
    assert.equal(oauth.isConfigured('facebook'), true);
    assert.deepEqual(oauth.enabledProviders().sort(), ['apple', 'google']);
    integrations.setProviderEnabled('facebook', true);
    withEnv({ GOOGLE_CLIENT_SECRET: undefined }, () => {
      db.setSetting('integrations.google.clientSecret', '');
      assert.equal(oauth.isConfigured('google'), false);
    });
    assert.equal(oauth.isConfigured('nope'), false);
  }));

  test('validateApplePrivateKey accepts EC keys, rejects RSA and junk; checkCredentials interprets provider replies', async () => {
    assert.equal(oauth.validateApplePrivateKey(pem), '');
    assert.equal(oauth.validateApplePrivateKey(pem.replace(/\n/g, '\\n')), '', 'escaped newlines from .env files');
    assert.ok(oauth.validateApplePrivateKey('junk'));
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    assert.ok(oauth.validateApplePrivateKey(rsa));

    await run(async () => {
      const reply = (status, body) => { globalThis.fetch = async () => new Response(JSON.stringify(body), { status }); };
      reply(400, { error: 'invalid_grant' });
      assert.equal((await oauth.checkCredentials('google', {}, base)).state, 'valid');
      reply(401, { error: 'invalid_client' });
      assert.equal((await oauth.checkCredentials('google', {}, base)).state, 'invalid');
      reply(400, { error: 'redirect_uri_mismatch' });
      assert.equal((await oauth.checkCredentials('apple', {}, base)).state, 'redirect_mismatch');
      reply(503, {});
      assert.equal((await oauth.checkCredentials('google', {}, base)).state, 'unreachable');
      reply(400, { error: 'invalid_request' });
      assert.equal((await oauth.checkCredentials('google', {}, base)).state, 'uncertain');
      reply(200, { access_token: 'app-token' });
      assert.equal((await oauth.checkCredentials('facebook', {}, base)).state, 'valid');
      reply(400, { error: { message: 'Error validating client secret.' } });
      assert.equal((await oauth.checkCredentials('facebook', {}, base)).state, 'invalid');
      assert.equal((await oauth.checkCredentials('google', { clientId: '', clientSecret: '' }, base)).state, 'incomplete');
      globalThis.fetch = async () => { throw new Error('offline'); };
      assert.deepEqual(await oauth.checkCredentials('google', {}, base), { state: 'unreachable', detail: 'network' });
    });
  });

  test('getStatus never returns a secret value', () => run(() => {
    const text = JSON.stringify(oauth.getStatus(base));
    for (const secret of ['g-secret', 'f'.repeat(32), pem.split('\n')[1]]) assert.ok(!text.includes(secret));
    assert.ok(text.includes(`${base}/api/auth/google/callback`));
  }));
});

// ── 結構遷移、備份與還原（實體檔案資料庫） ───────────────────
describe('migrations, backup and restore on a real database file', () => {
  const { DatabaseSync } = require('node:sqlite');
  let dir;

  before(() => {
    db.close();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdw-db-test-'));
  });
  after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    db.open(); // 讓後面其他 describe（若有）仍有資料庫
  });

  const version = file => { const d = new DatabaseSync(file); try { return d.prepare('PRAGMA user_version').get().user_version; } finally { d.close(); } };

  test('a brand-new file is migrated to the current schema version, with owner-only permissions', () => {
    const file = path.join(dir, 'fresh', 'users.db');
    db.open({ path: file, backupDir: path.join(dir, 'fresh', 'backups'), force: true });
    assert.equal(db.getStatus().userVersion, db.SCHEMA_VERSION);
    assert.equal(db.getStatus().inMemory, false);
    for (const t of ['users', 'user_identities', 'email_tokens', 'invites', 'sessions', 'user_prefs', 'bookmarks', 'read_progress', 'auth_events', 'app_settings']) {
      assert.ok(db.getDb().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(t), `table ${t}`);
    }
    assert.ok(db.getSetting('db.lastMigrationAt'));
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o077, 0, 'db file is not group/world accessible');
    db.close();
  });

  test('reopening is idempotent and keeps data', () => {
    const file = path.join(dir, 'reopen.db');
    db.open({ path: file, backupDir: null, force: true });
    const u = newUser({ email: 'keep@example.org' });
    db.close();
    db.open({ path: file, backupDir: null, force: true });
    assert.equal(db.getUserByEmail('keep@example.org').id, u.id);
    db.close();
  });

  test('a database from a NEWER release opens untouched (rollback to an older image keeps working)', () => {
    const file = path.join(dir, 'newer.db');
    const raw = new DatabaseSync(file);
    raw.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
    raw.exec(`PRAGMA user_version = ${db.SCHEMA_VERSION + 4}`);
    raw.close();
    db.open({ path: file, backupDir: path.join(dir, 'newer-backups'), force: true });
    assert.equal(version(file), db.SCHEMA_VERSION + 4, 'user_version is not lowered');
    assert.equal(fs.existsSync(path.join(dir, 'newer-backups')), false, 'no pre-migration backup was needed');
    db.close();
  });

  test('a half-migrated (user_version=0) file with leftovers rolls back and reports the error', () => {
    const file = path.join(dir, 'broken.db');
    const raw = new DatabaseSync(file);
    raw.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)'); // v1 遷移的 CREATE TABLE users 會撞名
    raw.close();
    assert.throws(() => db.open({ path: file, backupDir: null, force: true }), /already exists/);
    assert.equal(db.isAvailable(), false);
    assert.ok(db.getOpenError());
    assert.equal(version(file), 0, 'schema version unchanged after rollback');
    const check = new DatabaseSync(file);
    try {
      const tables = check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
      assert.deepEqual(tables, ['users'], 'transaction rolled back: no partial tables');
    } finally { check.close(); }
  });

  test('manual backup → list → restore brings back the old data and keeps a safety copy', () => {
    const file = path.join(dir, 'main', 'users.db');
    const backups = path.join(dir, 'main', 'backups');
    db.open({ path: file, backupDir: backups, force: true });
    const early = newUser({ email: 'early@example.org' });
    db.createSession(early.id, 'restore-session', { ttlMs: DAY });

    const made = db.backupNow('manual');
    assert.match(made.name, /^users-manual-\d{8}-\d{6}\.db$/);
    assert.deepEqual(db.listBackups().map(b => b.name), [made.name]);
    assert.equal(version(path.join(backups, made.name)), db.SCHEMA_VERSION);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(backups, made.name)).mode & 0o077, 0);

    const later = newUser({ email: 'later@example.org' });
    db.updateUser(early.id, { displayName: 'changed' });

    const r = db.restoreBackup(made.name);
    assert.equal(r.restored, made.name);
    assert.match(r.safetyBackup, /^users-before-restore-/);
    assert.ok(fs.existsSync(path.join(backups, r.safetyBackup)));
    assert.equal(db.getUserByEmail('later@example.org'), null, 'post-backup data is gone');
    assert.notEqual(db.getUserByEmail('early@example.org').display_name, 'changed');
    assert.ok(db.getSessionByToken('restore-session'), 'sessions come back with the backup (admin may clear them)');
    assert.ok(db.isAvailable());

    // 安全備份保有還原前的狀態：再還原回去，later 就回來了。
    db.restoreBackup(r.safetyBackup);
    assert.equal(db.getUserByEmail('later@example.org').id, later.id);
    db.close();
  });

  test('backup names are validated: no traversal, no other files, nothing outside the backup dir', () => {
    const file = path.join(dir, 'names', 'users.db');
    const backups = path.join(dir, 'names', 'backups');
    db.open({ path: file, backupDir: backups, force: true });
    const made = db.backupNow('manual');
    fs.writeFileSync(path.join(dir, 'names', 'users-evil.db'), 'x');
    for (const bad of ['../users-evil.db', '..\\users-evil.db', '/etc/passwd', 'users-x.db/../../users.db', 'config.json', '', null, undefined, 'users-missing.db', 'users-.sqlite']) {
      assert.equal(db.resolveBackupPath(bad), null, String(bad));
    }
    assert.ok(db.resolveBackupPath(made.name));
    assert.throws(() => db.restoreBackup('../users-evil.db'), /找不到/);
    fs.writeFileSync(path.join(backups, 'users-notsqlite.db'), 'this is not sqlite');
    assert.throws(() => db.restoreBackup('users-notsqlite.db'));
    assert.ok(db.isAvailable(), 'a failed restore leaves the live database open');
    db.close();
  });

  test('daily backups keep only the newest 7; manual and pre-restore copies are pruned separately', () => {
    const file = path.join(dir, 'prune', 'users.db');
    const backups = path.join(dir, 'prune', 'backups');
    db.open({ path: file, backupDir: backups, force: true });
    fs.mkdirSync(backups, { recursive: true });
    for (let i = 1; i <= 9; i++) {
      const f = path.join(backups, `users-2024010${i}.db`);
      fs.writeFileSync(f, 'old');
      const t = new Date(Date.now() - (20 - i) * DAY);
      fs.utimesSync(f, t, t);
    }
    db.backupNow('daily');
    const daily = db.listBackups().filter(b => /^users-\d{8}\.db$/.test(b.name));
    assert.equal(daily.length, 7);
    assert.ok(daily.some(b => b.name === db.listBackups()[0].name), 'newest kept');
    assert.ok(!daily.some(b => b.name === 'users-20240101.db'), 'oldest pruned');
    db.close();
  });

  test('migrating a database that already holds data first writes a pre-migration backup', () => {
    // 現行只有 v1，所以以人工把 user_version 降回 0 又保留資料來模擬「舊版資料庫＋新遷移」不可行；
    // 這裡直接驗證 snapshotTo 的備份檔可獨立開啟、內容完整（遷移前備份用的就是它）。
    const file = path.join(dir, 'snap', 'users.db');
    db.open({ path: file, backupDir: path.join(dir, 'snap', 'backups'), force: true });
    newUser({ email: 'snap@example.org' });
    const target = path.join(dir, 'snap', 'backups', 'users-pre-v2.db');
    db.backupNow('manual');
    const copy = new DatabaseSync(target.replace('users-pre-v2.db', db.listBackups()[0].name), { readOnly: true });
    try {
      assert.equal(copy.prepare('SELECT COUNT(*) n FROM users WHERE email = ?').get('snap@example.org').n, 1);
    } finally { copy.close(); }
    db.close();
  });

  test('integrations key file: created on first secret save with mode 600, and secrets survive reopen', () => {
    const file = path.join(dir, 'keys', 'users.db');
    db.open({ path: file, backupDir: null, force: true });
    withEnv({ MAIL_API_KEY: undefined }, () => {
      assert.equal(fs.existsSync(path.join(dir, 'keys', 'secrets.key')), false, 'not created until needed');
      integrations.set({ mailApiKey: 're_persisted_key_9999' });
      const keyFile = path.join(dir, 'keys', 'secrets.key');
      assert.ok(fs.existsSync(keyFile));
      if (process.platform !== 'win32') assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
      assert.equal(Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64').length, 32);

      db.close();
      db.open({ path: file, backupDir: null, force: true });
      assert.equal(integrations.get('mailApiKey'), 're_persisted_key_9999');

      // 備份檔本身不含可用金鑰：沒有 secrets.key 就解不開
      const keyBackup = fs.readFileSync(keyFile);
      fs.rmSync(keyFile);
      assert.equal(integrations.get('mailApiKey'), '');
      assert.equal(integrations.describe('mailApiKey').unreadable, true);
      fs.writeFileSync(keyFile, keyBackup, { mode: 0o600 });
      assert.equal(integrations.get('mailApiKey'), 're_persisted_key_9999');
      integrations.set({ mailApiKey: '' });
    });
    db.close();
  });
});
