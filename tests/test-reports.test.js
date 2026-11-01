/**
 * 每日／每週報表信（lib/reports.js、lib/report-chart.js）測試：
 * 期間與時區切日、排程判斷、流量／關鍵字／使用者統計、信件內容、PNG/SVG 圖表、
 * Resend 內嵌圖片附件，以及後台 API。日誌放在暫存目錄，Resend 以替換 fetch 模擬。
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mdw-reports-'));
process.env.LOG_DIR = LOG_DIR;
process.env.PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://reader.example';
process.env.SCRYPT_LN = process.env.SCRYPT_LN || '10';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const zlib = require('zlib');

const db = require('../lib/db.js');
const chart = require('../lib/report-chart.js');
const reports = require('../lib/reports.js');
const mailer = require('../lib/mailer.js');

const HOUR = 60 * 60 * 1000;
const TZ = 'Asia/Taipei';
// 2026-11-01 10:00 台北（02:00Z），週日
const NOW = Date.parse('2026-11-01T02:00:00Z');

let seq = 0;
function entry(ts, tag, extra = {}) {
  return Object.assign({ id: `t${++seq}`, timestamp: new Date(ts).toISOString(), level: 'INFO', tag, ip: '198.51.100.1', message: '' }, extra);
}

function writeLogs(entries) {
  for (const f of fs.readdirSync(LOG_DIR)) if (f.endsWith('.jsonl')) fs.rmSync(path.join(LOG_DIR, f));
  const byDay = {};
  for (const e of entries) (byDay[e.timestamp.slice(0, 10)] = byDay[e.timestamp.slice(0, 10)] || []).push(JSON.stringify(e));
  for (const [d, lines] of Object.entries(byDay)) fs.writeFileSync(path.join(LOG_DIR, `access-${d}.jsonl`), lines.join('\n') + '\n');
}

function pngSize(buf) {
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

before(() => { db.open(); });
after(async () => {
  reports.stop();
  // 記錄日誌會載入 logger，連帶啟動 worker pool；不關掉測試行程不會結束。
  await require('../lib/worker-pool.js').terminateWorkerPools();
  fs.rmSync(LOG_DIR, { recursive: true, force: true });
});

describe('report charts', () => {
  const scene = chart.timeChart({
    labels: ['10/25', '10/26', '10/27'],
    series: [
      { type: 'bar', color: '#3b6fd8', values: [3, 7, 0] },
      { type: 'line', color: '#e08a3c', values: [1, 2, 3] },
      { type: 'line', dashed: true, color: '#9aa3b2', values: [2, 2, 2] }
    ],
    width: 300,
    height: 120
  });

  test('SVG output is well-formed and carries the axis labels', () => {
    const svg = chart.toSvg(scene);
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="300" height="120"/);
    assert.match(svg, />10\/26<\/text>/);
    assert.match(svg, /stroke-dasharray="5 4"/);
    assert.ok(svg.endsWith('</svg>'));
  });

  test('PNG output is a valid 2x image whose pixels are not blank', () => {
    const png = chart.toPng(scene);
    assert.deepEqual(pngSize(png), { w: 600, h: 240 });
    const idat = [];
    let off = 8;
    while (off < png.length) {
      const len = png.readUInt32BE(off);
      const type = png.toString('ascii', off + 4, off + 8);
      if (type === 'IDAT') idat.push(png.subarray(off + 8, off + 8 + len));
      off += 12 + len;
    }
    const raw = zlib.inflateSync(Buffer.concat(idat));
    assert.equal(raw.length, (600 * 3 + 1) * 240);
    // 某些像素應接近長條的藍色
    let blue = 0;
    for (let i = 0; i < raw.length - 2; i++) if (raw[i] < 80 && raw[i + 1] > 90 && raw[i + 1] < 130 && raw[i + 2] > 190) blue++;
    assert.ok(blue > 100, `expected blue bar pixels, got ${blue}`);
  });

  test('nice scale and short number formatting', () => {
    assert.deepEqual(chart.niceScale(0), { max: 4, step: 1 });
    assert.equal(chart.niceScale(37).max, 40);
    assert.equal(chart.formatShort(1500), '1.5k');
    assert.equal(chart.formatShort(25000), '25k');
    assert.equal(chart.formatShort(2_400_000), '2.4M');
  });
});

describe('report periods and schedule', () => {
  test('daily period is yesterday in the report time zone', () => {
    const p = reports.computePeriod('daily', NOW, TZ);
    assert.equal(p.key, '2026-10-31');
    assert.equal(new Date(p.start).toISOString(), '2026-10-30T16:00:00.000Z');
    assert.equal(p.end - p.start, 24 * HOUR);
    assert.equal(p.start - p.prevStart, 24 * HOUR);
  });

  test('weekly period covers the 7 days up to yesterday', () => {
    const p = reports.computePeriod('weekly', NOW, TZ);
    assert.equal(p.key, '2026-10-25..2026-10-31');
    assert.equal(p.end - p.start, 7 * 24 * HOUR);
  });

  test('day boundaries follow daylight saving time', () => {
    // 2026-11-01 是美國結束夏令時間那天：當天有 25 小時
    const start = reports.zonedMidnight(2026, 11, 1, 'America/New_York');
    const end = reports.zonedMidnight(2026, 11, 2, 'America/New_York');
    assert.equal(new Date(start).toISOString(), '2026-11-01T04:00:00.000Z');
    assert.equal(end - start, 25 * HOUR);
  });

  test('due reports respect hour, weekday and what was already sent', () => {
    const s = reports.normalizeSettings({ timezone: TZ, daily: { enabled: true, hour: 8 }, weekly: { enabled: true, weekday: 0, hour: 9 } });
    const none = () => null;
    assert.deepEqual(reports.dueReports(Date.parse('2026-10-31T23:00:00Z'), s, none), []); // 台北 07:00
    assert.deepEqual(reports.dueReports(NOW, s, none).map(d => d.kind), ['daily', 'weekly']); // 週日 10:00
    assert.deepEqual(reports.dueReports(NOW, s, k => (k === 'daily' ? '2026-10-31' : null)).map(d => d.kind), ['weekly']);
    const off = reports.normalizeSettings({ timezone: TZ, daily: { enabled: false }, weekly: { enabled: false } });
    assert.deepEqual(reports.dueReports(NOW, off, none), []);
  });

  test('settings are normalized', () => {
    const s = reports.normalizeSettings({ timezone: 'Mars/Base', recipients: ['A@B.org', 'bad', 'a@b.org'], daily: { hour: 99 }, weekly: { weekday: 9 } });
    assert.equal(s.timezone, 'Asia/Taipei');
    assert.deepEqual(s.recipients, ['a@b.org']);
    assert.equal(s.daily.hour, 8);
    assert.equal(s.weekly.weekday, 1);
  });

  test('next run is in the future', () => {
    const s = reports.normalizeSettings({ timezone: TZ });
    const n = reports.nextRun(s, NOW);
    assert.equal(new Date(n.daily).toISOString(), '2026-11-02T00:00:00.000Z'); // 明天台北 08:00
    assert.equal(new Date(n.weekly).toISOString(), '2026-11-02T00:00:00.000Z'); // 週一 08:00
  });
});

describe('report content', () => {
  const yesterday = Date.parse('2026-10-30T16:00:00Z'); // 台北 10/31 00:00
  before(() => {
    writeLogs([
      entry(yesterday + 1 * HOUR, 'Render', { path: '經藏/金剛經.md', ip: '198.51.100.1' }),
      entry(yesterday + 1 * HOUR + 1, 'Render', { path: '經藏/金剛經.md', ip: '198.51.100.2' }),
      entry(yesterday + 9 * HOUR, 'Render', { path: '經藏/心經.md', ip: '198.51.100.2' }),
      entry(yesterday + 9 * HOUR, 'Render', { path: '經藏/心經.md', ip: '198.51.100.3', isBot: true }),
      entry(yesterday + 10 * HOUR, 'Search', { query: '般若', message: '[fulltext] Query: "般若" -> 12 matches in 3ms' }),
      entry(yesterday + 10 * HOUR, 'Search', { query: '般若', message: '[fulltext] Query: "般若" -> 12 matches in 3ms' }),
      entry(yesterday + 11 * HOUR, 'Search', { query: '不存在詞', message: '[fulltext] Query: "不存在詞" -> 0 matches in 3ms' }),
      entry(yesterday + 11 * HOUR, 'Search', { query: '金', message: '[tree-filter] Query: "金" -> 3 matches' }),
      entry(yesterday + 12 * HOUR, 'DictSearch', { query: '涅槃' }),
      entry(yesterday + 12 * HOUR, 'DictLookup', { query: '涅槃', path: 'dict:佛學大辭典.md' }),
      entry(yesterday - 2 * HOUR, 'Render', { path: '經藏/金剛經.md' }), // 前一天
      entry(yesterday - 2 * HOUR, 'Search', { query: '般若', message: '[fulltext] Query: "般若" -> 1 matches' }),
      entry(yesterday + 25 * HOUR, 'Render', { path: '經藏/金剛經.md' }) // 今天，不算
    ]);
    const u = db.createUser({ email: 'newbie@example.org', displayName: '新同學' });
    db.getDb().prepare('UPDATE users SET created_at = ? WHERE id = ?').run(yesterday + 3 * HOUR, u.id);
    db.logEvent('login_ok', { userId: u.id, detail: 'google' });
    db.getDb().prepare("UPDATE auth_events SET at = ? WHERE user_id = ? AND event = 'login_ok'").run(yesterday + 4 * HOUR, u.id);
    db.getDb().prepare('INSERT INTO read_progress (user_id, path, position, updated_at) VALUES (?, ?, ?, ?)').run(u.id, '經藏/金剛經.md', 50, yesterday + 5 * HOUR);
  });

  test('traffic, keywords and users are counted for the right day', async () => {
    const r = await reports.buildReport('daily', { now: NOW, settings: reports.normalizeSettings({ timezone: TZ }) });
    const t = r.traffic.cur;
    assert.equal(t.views, 3, 'bots and other days are excluded');
    assert.equal(t.visitors, 2);
    assert.equal(t.searches, 3, 'tree-filter is not a full-text search');
    assert.equal(t.treeFilters, 1);
    assert.equal(t.zeroResults, 1);
    assert.equal(t.dictSearches, 1);
    assert.equal(t.dictLookups, 1);
    assert.equal(r.traffic.prev.views, 1);
    assert.equal(r.traffic.buckets[1].views, 2, '01:00 local hour');
    assert.equal(r.traffic.buckets[9].views, 1);
    assert.deepEqual(r.traffic.topDocs[0], { path: '經藏/金剛經.md', name: '金剛經', views: 2, visitors: 2, prev: 1 });
    assert.deepEqual(r.keywords.top[0], { q: '般若', n: 2, prev: 1, isNew: false });
    assert.equal(r.keywords.top.find(x => x.q === '不存在詞').isNew, true);
    assert.deepEqual(r.keywords.zero, [{ q: '不存在詞', n: 1 }]);
    assert.equal(r.keywords.lookups[0].headword, '涅槃');
    assert.equal(r.keywords.lookups[0].dict, '佛學大辭典');
    assert.equal(r.users.newCount, 1);
    assert.equal(r.users.newUsers[0].email, 'newbie@example.org');
    assert.equal(r.users.loginUsers, 1);
    assert.deepEqual(r.users.loginMethods, [{ method: 'google', n: 1 }]);
    assert.equal(r.users.topReaders[0].email, 'newbie@example.org');
    assert.equal(r.users.trend.length, 14);
  });

  test('rendered mail references every chart by cid and escapes user text', async () => {
    db.createUser({ email: 'x@example.org', displayName: '<script>alert(1)</script>' });
    const r = await reports.buildReport('weekly', { now: NOW, settings: reports.normalizeSettings({ timezone: TZ }) });
    const out = reports.renderReport(r, { imageSrc: c => `cid:report-${c.id}` });
    assert.match(out.subject, /每週報表 10\/25–10\/31/);
    for (const c of out.charts) assert.ok(out.html.includes(`src="cid:report-${c.id}"`), c.id);
    assert.ok(!out.html.includes('<script>alert(1)</script>'));
    assert.match(out.html, /熱門搜尋 Top 15/);
    assert.match(out.text, /熱門搜尋/);
  });

  test('preview embeds SVG charts as data URIs', async () => {
    const p = await reports.renderPreview('daily');
    assert.match(p.html, /data:image\/svg\+xml;base64,/);
    assert.ok(!p.html.includes('cid:'));
  });

  test('sending attaches PNG charts inline through Resend', async () => {
    const realFetch = globalThis.fetch;
    const saved = { p: process.env.MAIL_PROVIDER, k: process.env.MAIL_API_KEY, f: process.env.MAIL_FROM };
    process.env.MAIL_PROVIDER = 'resend';
    process.env.MAIL_API_KEY = 're_test_key';
    process.env.MAIL_FROM = 'Reports <noreply@reader.example>';
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return new Response(JSON.stringify({ id: 'mail_1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    try {
      const r = await reports.sendReport('daily', { to: 'boss@example.org', now: NOW });
      assert.equal(r.ok, true);
      assert.equal(calls.length, 1);
      const body = calls[0].body;
      assert.deepEqual(body.to, ['boss@example.org']);
      assert.ok(body.attachments.length >= 3);
      for (const a of body.attachments) {
        assert.match(a.content_id, /^report-/);
        assert.ok(body.html.includes(`cid:${a.content_id}`));
        pngSize(Buffer.from(a.content, 'base64'));
      }
      const h = reports.status().history[0];
      assert.equal(h.ok, true);
      assert.equal(h.kind, 'daily');
    } finally {
      globalThis.fetch = realFetch;
      for (const [k, v] of [['MAIL_PROVIDER', saved.p], ['MAIL_API_KEY', saved.k], ['MAIL_FROM', saved.f]]) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });

  test('scheduled tick sends once per period', async () => {
    process.env.MAIL_PROVIDER = 'log';
    try {
      reports.saveSettings({ timezone: TZ, recipients: ['boss@example.org'], daily: { enabled: true, hour: 8 }, weekly: { enabled: false } });
      mailer.clearOutbox();
      const first = await reports.tick(NOW);
      assert.equal(first.length, 1);
      assert.equal(first[0].ok, true);
      assert.equal((await reports.tick(NOW + HOUR)).length, 0, 'not sent twice');
      assert.equal(mailer.getOutbox('boss@example.org').length, 1);
    } finally {
      delete process.env.MAIL_PROVIDER;
    }
  });
});

describe('report admin API', () => {
  let srv;
  let base = '';
  let cookie = '';
  const accounts = require('../lib/accounts.js');

  function rq(p, { method = 'GET', body, auth = true } = {}) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : JSON.stringify(body);
      const headers = { Connection: 'close' };
      if (data !== null) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
      if (method !== 'GET') headers.Origin = base;
      if (auth && cookie) headers.Cookie = cookie;
      const req = http.request(`${base}${p}`, { method, headers, agent: false }, res => {
        let buf = '';
        res.on('data', c => { buf += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: (() => { try { return JSON.parse(buf); } catch (_) { return null; } })() }));
      });
      req.on('error', reject);
      if (data !== null) req.write(data);
      req.end();
    });
  }

  before(async () => {
    process.env.MAIL_PROVIDER = 'log';
    srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      accounts.handle(req, res, u.pathname, Object.fromEntries(u.searchParams)).then(h => { if (!h) { res.writeHead(404); res.end(); } });
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${srv.address().port}`;
    const passwords = require('../lib/password.js');
    db.createUser({ email: 'boss2@example.org', emailVerifiedAt: Date.now(), passwordHash: await passwords.hashPassword('boss-password'), role: 'admin' });
    const login = await rq('/api/auth/login', { method: 'POST', body: { identifier: 'boss2@example.org', password: 'boss-password' } });
    assert.equal(login.status, 200);
    cookie = (login.headers['set-cookie'] || []).find(v => /mdw_sid=/.test(v)).split(';')[0];
  });
  after(() => { delete process.env.MAIL_PROVIDER; return new Promise(r => srv.close(r)); });

  test('anonymous visitors are refused', async () => {
    assert.equal((await rq('/api/admin/reports', { auth: false })).status, 401);
    assert.equal((await rq('/api/admin/reports/send', { method: 'POST', body: { kind: 'daily' }, auth: false })).status, 401);
  });

  test('status, settings, preview and send', async () => {
    const st = await rq('/api/admin/reports');
    assert.equal(st.status, 200);
    assert.ok(st.json.adminEmails.includes('boss2@example.org'));

    const bad = await rq('/api/admin/reports/settings', { method: 'POST', body: { timezone: 'Nowhere/City' } });
    assert.equal(bad.status, 400);
    const badMail = await rq('/api/admin/reports/settings', { method: 'POST', body: { recipients: 'ok@example.org, nope' } });
    assert.equal(badMail.status, 400);

    const ok = await rq('/api/admin/reports/settings', { method: 'POST', body: { timezone: 'Asia/Tokyo', recipients: 'a@example.org\nb@example.org', daily: { enabled: false, hour: 6 }, weekly: { enabled: true, weekday: 5, hour: 7 } } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.settings.timezone, 'Asia/Tokyo');
    assert.deepEqual(ok.json.settings.recipients, ['a@example.org', 'b@example.org']);
    assert.equal(ok.json.settings.daily.enabled, false);
    assert.equal(ok.json.settings.weekly.weekday, 5);
    assert.equal(ok.json.nextRun.daily, undefined);

    const pv = await rq('/api/admin/reports/preview?kind=weekly');
    assert.equal(pv.status, 200);
    assert.match(pv.json.subject, /每週報表/);
    assert.equal((await rq('/api/admin/reports/preview?kind=monthly')).status, 400);

    mailer.clearOutbox();
    const send = await rq('/api/admin/reports/send', { method: 'POST', body: { kind: 'daily', to: 'test@example.org' } });
    assert.equal(send.status, 200, JSON.stringify(send.json));
    assert.equal(mailer.getOutbox('test@example.org').length, 1);
    assert.equal(send.json.status.history[0].trigger, 'test');
  });
});
