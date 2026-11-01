/**
 * 劃重點：定位規則（highlights.js）、伺服器儲存與同步（POST /api/me/sync 的 highlights）、
 * 以及 app.js／index.html 的接線（靜態檢查）。
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
const H = require('../highlights.js');
const sync = require('../library-sync.js');

const NOW = 1_800_000_000_000;
const TEXT = '般若波羅蜜多心經\n觀自在菩薩，行深般若波羅蜜多時，照見五蘊皆空，度一切苦厄。\n舍利子，色不異空，空不異色；色即是空，空即是色。\n受想行識，亦復如是。';
function linesOf(text, firstLine) {
  const out = [];
  let pos = 0;
  text.split('\n').forEach((l, i) => { out.push({ line: firstLine + i * 2, pos }); pos += l.length + 1; });
  return out;
}

describe('highlights.js anchoring', () => {
  const ls = linesOf(TEXT, 5);
  const at = (q) => { const s = TEXT.indexOf(q); return H.makeAnchor(TEXT, s, s + q.length, ls); };

  test('makeAnchor records line, offset in line, quote and context; trims whitespace', () => {
    const a = at('照見五蘊皆空');
    assert.equal(a.line, 7);
    assert.equal(a.off, '觀自在菩薩，行深般若波羅蜜多時，'.length);
    assert.equal(a.q, '照見五蘊皆空');
    assert.ok(a.pre.endsWith('多時，'));
    assert.ok(a.suf.startsWith('，度一切'));
    const s = TEXT.indexOf('度一切苦厄');
    const t = H.makeAnchor(TEXT, s - 0, s + 7, ls); // 含換行
    assert.equal(t.q, '度一切苦厄。');
    assert.equal(H.makeAnchor(TEXT, 8, 9, ls), null, 'whitespace only');
  });

  test('locate: unchanged text is found exactly', () => {
    const a = at('色即是空，空即是色');
    const r = H.locate(TEXT, a, ls);
    assert.deepEqual([r.s, r.e, r.exact], [TEXT.indexOf('色即是空'), TEXT.indexOf('色即是空') + 9, true]);
  });

  test('locate: lines inserted before, quote follows to the new line', () => {
    const a = at('照見五蘊皆空');
    const t2 = '序\n新增一段。\n' + TEXT;
    const ls2 = linesOf(t2, 5);
    const r = H.locate(t2, a, ls2);
    assert.equal(t2.slice(r.s, r.e), '照見五蘊皆空');
    assert.equal(H.lineAt(ls2, r.s).line, 11);
  });

  test('locate: one character changed inside the quote → fuzzy match on the new text', () => {
    const a = at('照見五蘊皆空');
    const t2 = TEXT.replace('照見五蘊皆空', '照見五陰皆空');
    const r = H.locate(t2, a, ls);
    assert.equal(r.exact, false);
    assert.equal(t2.slice(r.s, r.e), '照見五陰皆空');
  });

  test('locate: repeated phrase picks the occurrence whose context matches', () => {
    const t2 = '甲：色即是空。\n' + TEXT;
    const ls2 = linesOf(t2, 3);
    const a = at('色即是空');
    const r = H.locate(t2, a, ls2);
    assert.ok(t2.slice(r.s - 5, r.s).endsWith('空不異色；'));
  });

  test('locate: passage removed → null (shown as 找不到原處, data kept)', () => {
    const a = at('受想行識');
    const t2 = TEXT.replace('受想行識，亦復如是。', '（此段已刪）');
    assert.equal(H.locate(t2, a, ls), null);
    assert.equal(H.locate('', a, ls), null);
  });

  test('approxSearch returns span and edit cost', () => {
    const r = H.approxSearch('abcdef', 'xxabXdefyy');
    assert.equal(r.cost, 1);
    assert.equal('xxabXdefyy'.slice(r.s, r.e), 'abXdef');
  });

  test('findMovedFile: same file name, else unique sutra number; ambiguous → null', () => {
    const files = ['a/T0251《心經》.md', 'b/T1579卷1.md', 'b/T1579卷2.md', 'c/X0001.md'];
    assert.equal(H.findMovedFile('old/T0251《心經》.md', files), 'a/T0251《心經》.md');
    assert.equal(H.findMovedFile('old/T0251舊檔名.md', files), 'a/T0251《心經》.md');
    assert.equal(H.findMovedFile('old/T1579卷9.md', files), null);
    assert.equal(H.findMovedFile('old/無經號.md', files), null);
    assert.equal(H.sutraNumber('x/T0220a《大般若》.md'), 'T0220a');
  });

  test('normalizeWire validates ids, quotes, colours and clamps timestamps', () => {
    assert.equal(H.normalizeWire(null, NOW), null);
    assert.equal(H.normalizeWire({ id: 'bad id', path: 'a.md', updatedAt: 1, q: 'x' }, NOW), null);
    assert.equal(H.normalizeWire({ id: 'a1', path: 'a.md', updatedAt: 1, q: '  ' }, NOW), null);
    const w = H.normalizeWire({ id: 'a1', path: 'a.md', updatedAt: NOW * 2, q: 'x'.repeat(900), c: 'purple', line: -1 }, NOW);
    assert.equal(w.q.length, H.LIMITS.maxQuote);
    assert.equal(w.c, 'r');
    assert.equal(w.line, 1);
    assert.equal(w.updatedAt, NOW + H.LIMITS.maxClockSkewMs);
    assert.deepEqual(H.normalizeWire({ id: 'a1', path: 'a.md', updatedAt: 5, deleted: true }, NOW), { id: 'a1', path: 'a.md', updatedAt: 5, deleted: true });
  });

  test('mergeRemote keys highlights by id (several per file)', () => {
    const make = w => ({ id: w.id, filePath: w.path, ts: w.updatedAt });
    const local = [{ id: 'a', filePath: 'f.md', ts: 10 }];
    const r = sync.mergeRemote(local, {}, [{ id: 'b', path: 'f.md', updatedAt: 20 }, { id: 'a', path: 'f.md', updatedAt: 30, deleted: true }],
      { make, localKey: 'id', wireKey: 'id' });
    assert.deepEqual(r.list.map(x => x.id), ['b']);
    assert.equal(r.tombs.a, 30);
  });
});

describe('highlight sync over HTTP', () => {
  let srv, baseUrl = '', accounts, db, mailer;
  const human = { elapsedMs: 5000, website: '' };

  function request(pathName, { method = 'GET', body, headers = {}, cookie } = {}) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : JSON.stringify(body);
      const h = Object.assign({ Connection: 'close', Origin: baseUrl }, headers);
      if (data !== null) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
      if (method === 'GET') delete h.Origin;
      if (cookie) h.Cookie = cookie;
      const req = http.request(`${baseUrl}${pathName}`, { method, agent: false, headers: h }, res => {
        let buf = '';
        res.on('data', c => { buf += c; });
        res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, headers: res.headers, body: buf, json }); });
      });
      req.on('error', reject);
      if (data !== null) req.write(data);
      req.end();
    });
  }
  const sessionCookie = res => {
    const c = (res.headers['set-cookie'] || []).find(v => /^(?:__Host-)?mdw_sid=[^;]+/.test(v) && !/Max-Age=0/.test(v));
    return c ? c.split(';')[0] : null;
  };
  async function signup(email) {
    const reg = await request('/api/auth/register', { method: 'POST', body: Object.assign({ email, password: 'reader-pass-1', agree: true }, human) });
    assert.equal(reg.status, 200, reg.body);
    const mails = mailer.getOutbox(email);
    const token = decodeURIComponent(mails[mails.length - 1].text.match(/auth=verify&token=([^\s&]+)/)[1]);
    const v = await request('/api/auth/verify', { method: 'POST', body: { token } });
    return sessionCookie(v);
  }
  const push = (cookie, body) => request('/api/me/sync', { method: 'POST', body, cookie });

  before(async () => {
    srv = require('../server.js');
    accounts = require('../lib/accounts.js');
    db = require('../lib/db.js');
    mailer = require('../lib/mailer.js');
    await new Promise(r => srv.server.listen(0, '127.0.0.1', () => { baseUrl = `http://127.0.0.1:${srv.server.address().port}`; r(); }));
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

  test('highlights sync between devices: add, recolour, delete', async () => {
    const a = await signup('hl-two@example.org');
    const b = sessionCookie(await request('/api/auth/login', { method: 'POST', body: { identifier: 'hl-two@example.org', password: 'reader-pass-1' } }));
    const t = Date.now();
    const hl = { id: 'h1', path: 'sutra/a.md', updatedAt: t, line: 7, off: 16, q: '照見五蘊皆空', pre: '多時，', suf: '，度一切', c: 'r' };
    const r1 = await push(a, { cursor: 0, bookmarks: [{ path: 'sutra/a.md', title: '甲', updatedAt: t }], highlights: [hl, Object.assign({}, hl, { id: 'h2', q: '色即是空', line: 9 })] });
    assert.equal(r1.status, 200, r1.body);
    assert.equal(r1.json.highlights.length, 2);

    const pull = await push(b, { cursor: 0 });
    const got = pull.json.highlights.find(x => x.id === 'h1');
    assert.equal(got.q, '照見五蘊皆空');
    assert.equal(got.line, 7);
    assert.equal(got.c, 'r');

    const r2 = await push(b, { cursor: pull.json.cursor, highlights: [Object.assign({}, hl, { c: 'b', updatedAt: t + 10 }), { id: 'h2', path: 'sutra/a.md', updatedAt: t + 10, deleted: true }] });
    assert.equal(r2.status, 200);
    const back = await push(a, { cursor: r1.json.cursor });
    assert.equal(back.json.highlights.find(x => x.id === 'h1').c, 'b');
    assert.equal(back.json.highlights.find(x => x.id === 'h2').deleted, true);

    // 舊的改動不能蓋掉新的
    await push(a, { highlights: [Object.assign({}, hl, { c: 'g', updatedAt: t + 5 })] });
    const all = await push(b, { cursor: 0 });
    assert.equal(all.json.highlights.find(x => x.id === 'h1').c, 'b');
  });

  test('invalid highlights are dropped; account export includes highlights; account delete removes them', async () => {
    const c = await signup('hl-del@example.org');
    const r = await push(c, { highlights: [{ id: 'ok1', path: 'x.md', updatedAt: Date.now(), q: '如是我聞', line: 1, off: 0, c: 'y' }, { id: '', path: 'x.md', updatedAt: 1, q: 'a' }, { id: 'n1', path: 'x.md', updatedAt: Date.now(), q: '' }] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.highlights.map(x => x.id), ['ok1']);
    const exp = await request('/api/me/export', { cookie: c });
    assert.equal(exp.status, 200);
    assert.equal(exp.json.highlights[0].text, '如是我聞');
    const uid = db.getUserByEmail('hl-del@example.org').id;
    db.getDb().prepare('DELETE FROM users WHERE id = ?').run(uid);
    assert.equal(db.getDb().prepare('SELECT COUNT(*) AS n FROM highlights WHERE user_id = ?').get(uid).n, 0);
  });
});

describe('highlights client wiring (static checks)', () => {
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');

  test('highlights.js ships: script tag before app.js, precached, copied into the image', () => {
    const hi = html.indexOf('highlights.js?v=');
    assert.ok(hi > 0 && hi < html.indexOf('app.js?v='));
    assert.match(sw, /'\/highlights\.js'/);
    assert.match(dockerfile, /COPY[^\n]*highlights\.js/);
  });

  test('drawn with the CSS Custom Highlight API (no DOM changes) in four underline colours', () => {
    assert.match(app, /CSS\.highlights\.set\(`mdw-hl-\$\{c\}`/);
    for (const c of ['r', 'y', 'g', 'b']) assert.match(css, new RegExp(`::highlight\\(mdw-hl-${c}\\) \\{ text-decoration: underline`));
  });

  test('highlighting adds a bookmark; removing a bookmark asks before deleting its highlights', () => {
    const create = app.slice(app.indexOf('function createHighlightFromRange'), app.indexOf('function recolorHighlight'));
    assert.match(create, /makeBookmarkEntry\(fp/);
    const toggle = app.slice(app.indexOf('function toggleBookmark'), app.indexOf('function updateBookmarkButtonUI'));
    assert.match(toggle, /confirmRemoveBookmarkHighlights\(\[filePath\]\)/);
    assert.match(toggle, /removeHighlightsOfFiles\(\[filePath\]\)/);
  });

  test('every local highlight mutation goes through persistLibrary', () => {
    const direct = app.match(/storage\.setJson\(STORAGE_KEYS\.HIGHLIGHTS,/g) || [];
    assert.equal(direct.length, 2, 'only remote merge and first-login init write directly');
    assert.ok((app.match(/persistLibrary\('l'\)/g) || []).length >= 6);
  });

  test('re-anchoring and lost marking are skipped while Simplified display is on', () => {
    const paint = app.slice(app.indexOf('function paintHighlights'), app.indexOf('function flashHighlight'));
    assert.match(paint, /const trustworthy = !idx\.conv/);
    assert.match(paint, /if \(trustworthy\) \{/);
  });
});
