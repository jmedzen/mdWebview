/**
 * 活躍使用者統計（後台「使用者」頁的日活躍／週活躍／月活躍）：
 * lib/db.js 的 recordActivity／activityStats、v6 遷移回填，以及 session 登入與續期時的記錄。
 */
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const db = require('../lib/db.js');
const session = require('../lib/session.js');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function newUser(fields = {}) {
  const n = crypto.randomBytes(4).toString('hex');
  return db.createUser(Object.assign({ email: `a${n}@example.org`, emailVerifiedAt: Date.now(), displayName: `a${n}` }, fields));
}

describe('activityStats', () => {
  before(() => { db.open(); });
  beforeEach(() => {
    db.getDb().exec('DELETE FROM user_activity; DELETE FROM sessions; DELETE FROM users;');
  });
  after(() => { db.close(); });

  test('rolling 24h / 7d / 30d windows count each user once, with the previous window for comparison', () => {
    const at = Date.UTC(2026, 10, 25, 10, 30);
    const a = newUser(); const b = newUser(); const c = newUser(); const d = newUser();
    // a：今天活動很多次，只算一次
    db.recordActivity(a.id, at - 10 * 60 * 1000);
    db.recordActivity(a.id, at - 2 * HOUR);
    db.recordActivity(a.id, at - 2 * HOUR + 60 * 1000);
    // b：3 天前（週活躍、不算日活躍），也在前一天活躍過
    db.recordActivity(b.id, at - 3 * DAY);
    db.recordActivity(b.id, at - 30 * HOUR);
    // c：20 天前（月活躍）
    db.recordActivity(c.id, at - 20 * DAY);
    // d：40 天前（都不算，但算進前 30 天的比較）
    db.recordActivity(d.id, at - 40 * DAY);
    const s = db.activityStats({ at, tz: 'UTC' });
    assert.equal(s.total, 4);
    assert.deepEqual(s.dau, { count: 1, admins: 0, previous: 1 });
    assert.deepEqual(s.wau, { count: 2, admins: 0, previous: 0 });
    assert.deepEqual(s.mau, { count: 3, admins: 0, previous: 1 });
  });

  test('admins are counted and reported separately; disabled and deleted accounts are left out', () => {
    const at = Date.now();
    const admin = newUser({ role: 'admin' });
    const off = newUser();
    const gone = newUser();
    const user = newUser();
    for (const u of [admin, off, gone, user]) db.recordActivity(u.id, at - HOUR);
    db.updateUser(off.id, { status: 'disabled' });
    db.deleteUser(gone.id);
    const s = db.activityStats({ at, tz: 'UTC' });
    assert.equal(s.dau.count, 2);
    assert.equal(s.dau.admins, 1);
    assert.equal(s.total, 2);
    const left = db.getDb().prepare('SELECT COUNT(*) AS n FROM user_activity WHERE user_id = ?').get(gone.id).n;
    assert.equal(left, 0, 'activity rows go with the deleted account');
  });

  test('daily series is split by local date in the given time zone, oldest first', () => {
    // 2026-11-25 02:00 UTC = 台北 10:00；前一晚 20:00 UTC = 台北 11/25 04:00（同一天）
    const at = Date.UTC(2026, 10, 25, 2, 0);
    const a = newUser(); const b = newUser();
    db.recordActivity(a.id, Date.UTC(2026, 10, 24, 20, 0));
    db.recordActivity(b.id, Date.UTC(2026, 10, 24, 10, 0)); // 台北 11/24 18:00
    const tpe = db.activityStats({ at, tz: 'Asia/Taipei', days: 7 });
    assert.equal(tpe.daily.length, 7);
    assert.equal(tpe.daily[6].date, '2026-11-25');
    assert.equal(tpe.daily[6].count, 1);
    assert.equal(tpe.daily[5].date, '2026-11-24');
    assert.equal(tpe.daily[5].count, 1);
    const utc = db.activityStats({ at, tz: 'UTC', days: 7 });
    assert.equal(utc.daily[6].date, '2026-11-25');
    assert.equal(utc.daily[6].count, 0);
    assert.equal(utc.daily[5].count, 2);
    assert.equal(db.activityStats({ at, tz: 'Not/AZone' }).tz, 'UTC', 'bad time zone falls back to UTC');
  });

  test('logging in and a later session refresh both record activity', () => {
    const u = newUser();
    const headers = { 'user-agent': 'test' };
    const res = { h: {}, setHeader(k, v) { this.h[k.toLowerCase()] = v; }, getHeader(k) { return this.h[k.toLowerCase()]; } };
    const token = session.startSession({ headers, socket: { remoteAddress: '203.0.113.5' } }, res, u);
    assert.equal(db.activityStats({ tz: 'UTC' }).dau.count, 1);
    // 模擬 3 小時後再回來：session 續期時記下新的那個小時
    db.getDb().exec('DELETE FROM user_activity');
    const sid = db.getSessionByToken(token).id;
    db.getDb().prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(Date.now() - 3 * HOUR, sid);
    const r = session.getSession({ headers: { cookie: `mdw_sid=${token}` }, socket: { remoteAddress: '203.0.113.5' } });
    assert.ok(r && r.user.id === u.id);
    assert.equal(db.activityStats({ tz: 'UTC' }).dau.count, 1);
  });
});

describe('v6 migration backfills activity from existing data', () => {
  const { DatabaseSync } = require('node:sqlite');
  let dir;
  before(() => { db.close(); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdw-activity-')); });
  after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  test('sessions, logins and reading progress from before the upgrade show up', () => {
    const file = path.join(dir, 'users.db');
    db.open({ path: file, backupDir: null, force: true });
    const t = Date.now();
    const a = newUser(); const b = newUser(); const c = newUser();
    db.updateUser(a.id, { lastLoginAt: t - 2 * HOUR });
    db.getDb().prepare(`INSERT INTO read_progress (user_id, path, position, updated_at) VALUES (?, 'x.md', 0.5, ?)`).run(b.id, t - 3 * DAY);
    db.getDb().prepare(`INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at) VALUES ('h', ?, ?, ?, ?)`)
      .run(c.id, t - 60 * DAY, t - 20 * DAY, t + DAY);
    db.close();
    // 退回 v5：拿掉新表，重開時跑 v6 遷移
    const raw = new DatabaseSync(file);
    raw.exec('DROP TABLE user_activity; PRAGMA user_version = 5;');
    raw.close();
    db.open({ path: file, backupDir: null, force: true });
    assert.equal(db.getStatus().userVersion, db.SCHEMA_VERSION);
    const s = db.activityStats({ tz: 'UTC' });
    assert.equal(s.dau.count, 1);
    assert.equal(s.wau.count, 2);
    assert.equal(s.mau.count, 3);
    assert.ok(s.since <= t - 60 * DAY);
  });
});
