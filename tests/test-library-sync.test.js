/**
 * 書籤／歷程跨裝置同步：合併規則（library-sync.js）、伺服器儲存與 API（POST /api/me/sync）、
 * 以及 app.js 內與瀏覽器相容性有關的程式碼結構。
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
const sync = require('../library-sync.js');

const NOW = 1_800_000_000_000;

describe('library-sync merge rules', () => {
  const make = w => ({ filePath: w.path, fileName: w.title, ts: w.updatedAt });

  test('normalizeWireItem validates and clamps', () => {
    assert.equal(sync.normalizeWireItem(null, 'bookmark', NOW), null);
    assert.equal(sync.normalizeWireItem({ path: '', updatedAt: 1 }, 'bookmark', NOW), null);
    assert.equal(sync.normalizeWireItem({ path: 'a.md' }, 'bookmark', NOW), null, 'timestamp required');
    assert.equal(sync.normalizeWireItem({ path: 'x'.repeat(501), updatedAt: 1 }, 'bookmark', NOW), null);
    assert.equal(sync.normalizeWireItem({ path: 'a\0b', updatedAt: 1 }, 'bookmark', NOW), null);
    const future = sync.normalizeWireItem({ path: 'a.md', updatedAt: NOW + 10 * 3600e3, title: 'T'.repeat(300) }, 'bookmark', NOW);
    assert.equal(future.updatedAt, NOW + sync.LIMITS.maxClockSkewMs, 'future timestamps are clamped');
    assert.equal(future.title.length, sync.LIMITS.maxTitleLength);
    const h = sync.normalizeWireItem({ path: 'a.md', updatedAt: 5, pct: 250, line: -3 }, 'history', NOW);
    assert.equal(h.pct, 100);
    assert.equal(h.line, null);
  });

  test('newer remote wins, older remote loses, ties keep local', () => {
    const local = [{ filePath: 'a.md', fileName: 'local', ts: 100 }];
    let r = sync.mergeRemote(local, {}, [{ path: 'a.md', title: 'remote', updatedAt: 200 }], { make });
    assert.equal(r.list[0].fileName, 'remote');
    r = sync.mergeRemote(local, {}, [{ path: 'a.md', title: 'remote', updatedAt: 50 }], { make });
    assert.equal(r.list[0].fileName, 'local');
    assert.equal(r.changed, false);
    r = sync.mergeRemote(local, {}, [{ path: 'a.md', title: 'remote', updatedAt: 100 }], { make });
    assert.equal(r.list[0].fileName, 'local');
  });

  test('tombstones beat older items and are beaten by newer ones', () => {
    const local = [{ filePath: 'a.md', fileName: 'a', ts: 100 }];
    let r = sync.mergeRemote(local, {}, [{ path: 'a.md', updatedAt: 150, deleted: true }], { make });
    assert.equal(r.list.length, 0);
    assert.equal(r.tombs['a.md'], 150);
    // 刪除之後，較舊的「新增」不能復活
    r = sync.mergeRemote(r.list, r.tombs, [{ path: 'a.md', title: 'a', updatedAt: 120 }], { make });
    assert.equal(r.list.length, 0);
    // 較新的新增可以
    r = sync.mergeRemote(r.list, r.tombs, [{ path: 'a.md', title: 'a', updatedAt: 300 }], { make });
    assert.equal(r.list.length, 1);
    assert.equal(r.tombs['a.md'], undefined);
  });

  test('merge is idempotent and order independent', () => {
    const ops = [
      { path: 'a.md', title: 'v1', updatedAt: 10 },
      { path: 'a.md', updatedAt: 20, deleted: true },
      { path: 'a.md', title: 'v3', updatedAt: 30 },
      { path: 'b.md', title: 'b', updatedAt: 15 },
      { path: 'b.md', updatedAt: 14, deleted: true }
    ];
    const run = (order) => {
      let list = [], tombs = {};
      for (const i of order) ({ list, tombs } = sync.mergeRemote(list, tombs, [ops[i]], { make }));
      return JSON.stringify(list.map(x => [x.filePath, x.fileName, x.ts]));
    };
    const base = run([0, 1, 2, 3, 4]);
    for (const order of [[4, 3, 2, 1, 0], [2, 0, 1, 4, 3], [0, 1, 2, 3, 4, 0, 1, 2, 3, 4]]) {
      assert.equal(run(order), base);
    }
  });

  test('cap keeps the newest entries', () => {
    const remote = Array.from({ length: 30 }, (_, i) => ({ path: `f${i}.md`, title: `f${i}`, updatedAt: 1000 + i }));
    const r = sync.mergeRemote([], {}, remote, { make, cap: 20 });
    assert.equal(r.list.length, 20);
    assert.equal(r.list[0].filePath, 'f29.md');
  });

  test('pruneTombs drops tombstones older than the TTL', () => {
    const t = sync.pruneTombs({ old: NOW - sync.LIMITS.tombstoneTtlMs - 1, fresh: NOW - 1000 }, NOW);
    assert.deepEqual(Object.keys(t), ['fresh']);
  });
});

describe('library sync over HTTP', () => {
  let srv, baseUrl = '', accounts, db, mailer;
  const human = { elapsedMs: 5000, website: '' };

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
    const c = (res.headers['set-cookie'] || []).find(v => /^(?:__Host-)?mdw_sid=[^;]+/.test(v) && !/Max-Age=0/.test(v));
    return c ? c.split(';')[0] : null;
  }

  async function signup(email) {
    const reg = await request('/api/auth/register', { method: 'POST', body: Object.assign({ email, password: 'reader-pass-1', agree: true }, human) });
    assert.equal(reg.status, 200, reg.body);
    const mails = mailer.getOutbox(email);
    const token = decodeURIComponent(mails[mails.length - 1].text.match(/auth=verify&token=([^\s&]+)/)[1]);
    const v = await request('/api/auth/verify', { method: 'POST', body: { token } });
    assert.equal(v.status, 200, v.body);
    return sessionCookie(v);
  }

  const push = (cookie, body, extra) => request('/api/me/sync', Object.assign({ method: 'POST', body, cookie }, extra));

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
    accounts.accountAttempts.clear();
    accounts.syncRate.clear();
    require('../lib/auth.js').apiRateLimits.clear();
    for (const c of Object.values(accounts._counters)) c.clear();
    mailer.clearOutbox();
  });

  after(async () => {
    srv.resetTreeWatcher(); srv.resetDictWatcher(); srv.resetConfigWatcher();
    await srv.terminateWorkerPools();
    if (srv.server.closeAllConnections) srv.server.closeAllConnections();
    await new Promise(r => srv.server.close(r));
  });

  test('requires login, same origin and JSON', async () => {
    assert.equal((await push(null, {})).status, 401);
    const cookie = await signup('sync-guard@example.org');
    assert.equal((await push(cookie, {}, { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await push(cookie, 'x=1', { headers: { 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await push(cookie, {})).status, 200);
  });

  test('bookmark progress syncs to another device', async () => {
    const a = await signup('sync-bmprog@example.org');
    const login = await request('/api/auth/login', { method: 'POST', body: { identifier: 'sync-bmprog@example.org', password: 'reader-pass-1' } });
    const b = sessionCookie(login);
    const t = Date.now();
    assert.equal((await push(a, { bookmarks: [{ path: 'sutra/p.md', title: 'P', updatedAt: t, pct: 55, line: 321 }] })).status, 200);
    const pull = await push(b, { cursor: 0 });
    assert.equal(pull.json.bookmarks[0].pct, 55);
    assert.equal(pull.json.bookmarks[0].line, 321);
  });

  test('two devices converge: add, update, delete (tombstone), pull by cursor', async () => {
    const a = await signup('sync-two@example.org');
    const login = await request('/api/auth/login', { method: 'POST', body: { identifier: 'sync-two@example.org', password: 'reader-pass-1' } });
    const b = sessionCookie(login);
    assert.notEqual(a, b);

    const t = Date.now();
    const r1 = await push(a, {
      cursor: 0,
      bookmarks: [{ path: 'sutra/a.md', title: '甲經', updatedAt: t }, { path: 'sutra/b.md', title: '乙經', updatedAt: t }],
      history: [{ path: 'sutra/a.md', title: '甲經', updatedAt: t, pct: 42, line: 99 }]
    });
    assert.equal(r1.status, 200, r1.body);
    assert.ok(r1.json.cursor >= 3);

    const pullB = await push(b, { cursor: 0 });
    assert.deepEqual(pullB.json.bookmarks.map(x => x.path).sort(), ['sutra/a.md', 'sutra/b.md']);
    assert.equal(pullB.json.history[0].pct, 42);
    assert.equal(pullB.json.history[0].line, 99);

    // B 刪掉 a.md，並把 b.md 改名
    const r2 = await push(b, { cursor: pullB.json.cursor, bookmarks: [{ path: 'sutra/a.md', updatedAt: t + 10, deleted: true }, { path: 'sutra/b.md', title: '乙經（新）', updatedAt: t + 20 }] });
    assert.equal(r2.status, 200);

    const pullA = await push(a, { cursor: r1.json.cursor });
    const byPath = Object.fromEntries(pullA.json.bookmarks.map(x => [x.path, x]));
    assert.equal(byPath['sutra/a.md'].deleted, true);
    assert.equal(byPath['sutra/b.md'].title, '乙經（新）');

    // 增量：沒有新異動就是空的
    const none = await push(a, { cursor: pullA.json.cursor });
    assert.deepEqual(none.json.bookmarks, []);
    assert.deepEqual(none.json.history, []);
  });

  test('older writes never override newer ones, and replays are harmless', async () => {
    const c = await signup('sync-lww@example.org');
    const t = Date.now();
    await push(c, { bookmarks: [{ path: 'x.md', title: 'new', updatedAt: t }] });
    const stale = await push(c, { cursor: 0, bookmarks: [{ path: 'x.md', title: 'stale', updatedAt: t - 5000 }, { path: 'x.md', updatedAt: t - 1, deleted: true }] });
    assert.equal(stale.json.bookmarks.length, 1);
    assert.equal(stale.json.bookmarks[0].title, 'new');
    assert.equal(!!stale.json.bookmarks[0].deleted, false);
    const again = await push(c, { cursor: 0, bookmarks: [{ path: 'x.md', title: 'new', updatedAt: t }] });
    assert.equal(again.json.bookmarks[0].title, 'new');
  });

  test('an old tombstone cannot resurrect nor erase a re-added bookmark', async () => {
    const c = await signup('sync-readd@example.org');
    const t = Date.now();
    await push(c, { bookmarks: [{ path: 'y.md', title: 'y', updatedAt: t }] });
    await push(c, { bookmarks: [{ path: 'y.md', updatedAt: t + 1, deleted: true }] });
    const readd = await push(c, { bookmarks: [{ path: 'y.md', title: 'y2', updatedAt: t + 2 }] });
    const row = readd.json.bookmarks.find(x => x.path === 'y.md');
    assert.equal(row.title, 'y2');
    assert.equal(!!row.deleted, false);
  });

  test('each account only sees its own data', async () => {
    const u1 = await signup('sync-own1@example.org');
    const u2 = await signup('sync-own2@example.org');
    await push(u1, { bookmarks: [{ path: 'private.md', title: 'mine', updatedAt: Date.now() }] });
    const other = await push(u2, { cursor: 0 });
    assert.deepEqual(other.json.bookmarks, []);
  });

  test('invalid items are skipped, future timestamps clamped, history capped', async () => {
    const c = await signup('sync-caps@example.org');
    const farFuture = Date.now() + 365 * 86400e3;
    const r = await push(c, {
      bookmarks: [null, 5, { path: '', updatedAt: 1 }, { path: 'ok.md', title: 'ok', updatedAt: farFuture }],
      history: Array.from({ length: 300 }, (_, i) => ({ path: `h${i}.md`, title: `h${i}`, updatedAt: Date.now() - i * 1000, pct: i % 101 }))
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.bookmarks.length, 1);
    assert.ok(r.json.bookmarks[0].updatedAt <= Date.now() + sync.LIMITS.maxClockSkewMs + 1000);
    // 單次請求最多收 500 筆；伺服器只保留最近 200 筆歷程
    const pulled = await push(c, { cursor: 0 });
    assert.equal(pulled.json.history.length, sync.LIMITS.maxHistory);
    const paths = new Set(pulled.json.history.map(h => h.path));
    assert.ok(paths.has('h0.md'), 'newest kept');
    assert.ok(!paths.has('h299.md'), 'oldest dropped');
  });

  test('per-request item cap and per-account bookmark cap', async () => {
    const c = await signup('sync-limit@example.org');
    const t = Date.now();
    const many = Array.from({ length: sync.LIMITS.maxItemsPerRequest + 50 }, (_, i) => ({ path: `m${i}.md`, title: 'm', updatedAt: t }));
    const r = await push(c, { bookmarks: many });
    assert.equal(r.json.bookmarks.length, sync.LIMITS.maxItemsPerRequest);

    // 灌到帳號上限
    const d = db.getDb();
    const uid = db.getUserByEmail('sync-limit@example.org').id;
    const ins = d.prepare('INSERT OR IGNORE INTO bookmarks (user_id, path, title, updated_at, seq) VALUES (?, ?, ?, ?, 0)');
    for (let i = 0; i < sync.LIMITS.maxBookmarks; i++) ins.run(uid, `fill${i}.md`, 'f', t);
    const over = await push(c, { cursor: 1e9, bookmarks: [{ path: 'one-too-many.md', title: 'x', updatedAt: t + 1 }] });
    assert.equal(over.status, 200);
    assert.equal(over.json.rejected, 1);
    const row = d.prepare('SELECT 1 FROM bookmarks WHERE user_id = ? AND path = ?').get(uid, 'one-too-many.md');
    assert.equal(row, undefined);
  });

  test('oversized body is rejected with 413, bad JSON with 400', async () => {
    const c = await signup('sync-big@example.org');
    const big = JSON.stringify({ bookmarks: [{ path: 'a.md', title: 'x'.repeat(1100 * 1024), updatedAt: 1 }] });
    // 超過上限時伺服器會中斷連線；client 可能先收到 413，也可能直接收到連線重設
    const res = await push(c, big).catch(e => ({ status: e.code }));
    assert.ok(res.status === 413 || res.status === 'ECONNRESET' || res.status === 'EPIPE', String(res.status));
    assert.equal((await push(c, '{not json')).status, 400);
    assert.equal((await push(c, '[1,2]')).status, 400);
  });

  test('rate limit: 60 per minute per account, with Retry-After', async () => {
    const c = await signup('sync-rate@example.org');
    for (let i = 0; i < 60; i++) {
      const r = await push(c, { cursor: 0 });
      assert.equal(r.status, 200, `request ${i}`);
      require('../lib/auth.js').apiRateLimits.clear();
    }
    const blocked = await push(c, { cursor: 0 });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers['retry-after']) > 0);
    assert.equal(blocked.json.code, 'RATE_LIMITED');
  });

  test('sendBeacon-style request (Blob application/json, no custom headers) is accepted', async () => {
    const c = await signup('sync-beacon@example.org');
    const r = await push(c, JSON.stringify({ bookmarks: [{ path: 'beacon.md', title: 'b', updatedAt: Date.now() }] }), { headers: { 'Content-Type': 'application/json' } });
    assert.equal(r.status, 200);
    const pulled = await push(c, { cursor: 0 });
    assert.equal(pulled.json.bookmarks[0].path, 'beacon.md');
  });

  test('account export includes synced data but not deleted bookmarks or history', async () => {
    const c = await signup('sync-export@example.org');
    const t = Date.now();
    await push(c, {
      bookmarks: [{ path: 'keep.md', title: 'k', updatedAt: t }, { path: 'gone.md', title: 'g', updatedAt: t }],
      history: [{ path: 'keep.md', title: 'k', updatedAt: t, pct: 10 }, { path: 'gone.md', title: 'g', updatedAt: t, pct: 5 }]
    });
    await push(c, { bookmarks: [{ path: 'gone.md', updatedAt: t + 1, deleted: true }], history: [{ path: 'gone.md', updatedAt: t + 1, deleted: true }] });
    const ex = await request('/api/me/export', { cookie: c });
    assert.deepEqual(ex.json.bookmarks.map(b => b.path), ['keep.md']);
    assert.deepEqual(ex.json.readProgress.map(b => b.path), ['keep.md']);
  });

  test('deleting an account removes its synced rows', async () => {
    const c = await signup('sync-del@example.org');
    await push(c, { bookmarks: [{ path: 'z.md', title: 'z', updatedAt: Date.now() }] });
    const uid = db.getUserByEmail('sync-del@example.org').id;
    db.getDb().prepare('DELETE FROM users WHERE id = ?').run(uid);
    assert.equal(db.getDb().prepare('SELECT COUNT(*) AS n FROM bookmarks WHERE user_id = ?').get(uid).n, 0);
  });
});

describe('client wiring (static checks)', () => {
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');

  test('library-sync.js ships: script tag before app.js, precached, copied into the image', () => {
    const li = html.indexOf('library-sync.js');
    const ai = html.indexOf('app.js?v=');
    assert.ok(li > 0 && li < ai);
    assert.match(sw, /'\/library-sync\.js'/);
    assert.match(dockerfile, /COPY[^\n]*library-sync\.js/);
  });

  test('every local bookmark/history mutation goes through persistLibrary', () => {
    // 直接寫 BOOKMARKS／RECENT_FILES 的地方只允許：遠端合併後與登入初始化（各兩處）；其餘都走 persistLibrary
    const direct = app.match(/storage\.setJson\(STORAGE_KEYS\.(BOOKMARKS|RECENT_FILES)/g) || [];
    assert.equal(direct.length, 4, 'unexpected direct writes');
    assert.equal(app.includes("storage.remove(STORAGE_KEYS.BOOKMARKS);\n          renderBookmarksList"), false);
    assert.ok((app.match(/persistLibrary\('[bh]'\)/g) || []).length >= 9);
  });

  test('flush on hide uses sendBeacon with a JSON Blob, falls back to keepalive fetch, covers pagehide and visibilitychange', () => {
    assert.match(app, /navigator\.sendBeacon\(SYNC_URL, new Blob\(\[payload\], \{ type: 'application\/json' \}\)\)/);
    assert.match(app, /keepalive: true/);
    assert.match(app, /addEventListener\('pagehide', flushLibrarySyncOnHide\)/);
    assert.match(app, /visibilityState === 'hidden'\) flushLibrarySyncOnHide/);
  });

  test('multi-tab: storage event reloads lists; logout clears local data only after a successful flush', () => {
    assert.match(app, /addEventListener\('storage'/);
    const fn = app.slice(app.indexOf('async function finishLibrarySyncBeforeLogout'), app.indexOf('function setupLibrarySync'));
    assert.match(fn, /if \(ok\) clearLocalLibrary\(\)/);
  });

  test('switching accounts on one browser never merges the previous account\'s local data', () => {
    const fn = app.slice(app.indexOf('function onLibraryAccountChange'), app.indexOf('function clearLocalLibrary'));
    assert.match(fn, /m\.uid && m\.uid !== syncRt\.user\.id/);
    assert.match(fn, /clearLocalLibrary\(\)/);
  });

  test('storage access is guarded (Safari private mode / blocked storage)', () => {
    const fn = app.slice(app.indexOf('function syncMeta()'), app.indexOf('function rebuildLibrarySnap'));
    assert.match(fn, /syncMetaMemory/);
  });
});

describe('bookmark reading progress', () => {
  test('keeps pct/line on bookmarks and treats missing progress as null', () => {
    const b = sync.normalizeWireItem({ path: 'a.md', updatedAt: 5, pct: 37.4, line: 120 }, 'bookmark', NOW);
    assert.equal(b.pct, 37);
    assert.equal(b.line, 120);
    const none = sync.normalizeWireItem({ path: 'a.md', updatedAt: 5, pct: null }, 'bookmark', NOW);
    assert.equal(none.pct, null);
    assert.equal(none.line, null);
  });
});
