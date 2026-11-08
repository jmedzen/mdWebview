/**
 * Regression tests for three small server fixes:
 *
 *  1. /api/media honours single byte ranges (206 / 416) and advertises Accept-Ranges.
 *  2. An oversized JSON body is answered with 413 instead of a dropped connection.
 *  3. The API rate limiter never evicts an IP that is actively counting, and prunes
 *     expired windows instead of letting the Map sit at its size cap.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mdw-range-'));
const VAULT = path.join(TMP, 'md');
fs.mkdirSync(path.join(VAULT, 'sub'), { recursive: true });
fs.writeFileSync(path.join(VAULT, 'sub', 'a.md'), '# Hello\n');
const PDF = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
fs.writeFileSync(path.join(VAULT, 'sub', 'doc.pdf'), PDF);
process.env.CONFIG_PATH = path.join(TMP, 'config.json');
process.env.MD_ROOT = VAULT;

const { parseByteRange } = require('../lib/utils.js');
const auth = require('../lib/auth.js');

describe('parseByteRange', () => {
  test('closed, open-ended and suffix ranges', () => {
    assert.deepEqual(parseByteRange('bytes=0-99', 1000), { start: 0, end: 99 });
    assert.deepEqual(parseByteRange('bytes=900-', 1000), { start: 900, end: 999 });
    assert.deepEqual(parseByteRange('bytes=-100', 1000), { start: 900, end: 999 });
    assert.deepEqual(parseByteRange('bytes=-5000', 1000), { start: 0, end: 999 }); // longer than file
    assert.deepEqual(parseByteRange('bytes=990-5000', 1000), { start: 990, end: 999 }); // end clamped
  });

  test('unsatisfiable ranges', () => {
    assert.deepEqual(parseByteRange('bytes=1000-', 1000), { unsatisfiable: true });
    assert.deepEqual(parseByteRange('bytes=-0', 1000), { unsatisfiable: true });
    assert.deepEqual(parseByteRange('bytes=0-0', 0), { unsatisfiable: true });
  });

  test('unusable headers are ignored (full body)', () => {
    for (const h of [undefined, '', 'bytes=', 'bytes=-', 'items=0-1', 'bytes=5-2', 'bytes=0-1,5-9', 'garbage']) {
      assert.equal(parseByteRange(h, 1000), null, String(h));
    }
  });
});

describe('/api/media Range and oversized-body handling over HTTP', () => {
  let baseUrl = '';
  let srv;

  function request(p, options = {}) {
    auth.apiRateLimits.clear(); // many requests per second; keep the 30 req/s limiter out of the way
    return new Promise((resolve, reject) => {
      const req = http.request(new URL(p, baseUrl), {
        agent: false, ...options, headers: { Connection: 'close', ...(options.headers || {}) }
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      if (options.body) req.write(options.body);
      req.end();
    });
  }

  before(async () => {
    srv = require('../server.js');
    const { config, invalidateMdRootMemo } = require('../lib/config.js');
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

  const media = '/api/media?path=doc.pdf&doc=sub/a.md';

  test('no Range header: 200, full body, Accept-Ranges advertised', async () => {
    const r = await request(media);
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers['accept-ranges'], 'bytes');
    assert.equal(r.headers['content-length'], '1000');
    assert.deepEqual(r.body, PDF);
  });

  test('Range: bytes=10-19 → 206 with exactly those bytes', async () => {
    const r = await request(media, { headers: { Range: 'bytes=10-19' } });
    assert.equal(r.statusCode, 206);
    assert.equal(r.headers['content-range'], 'bytes 10-19/1000');
    assert.equal(r.headers['content-length'], '10');
    assert.deepEqual(r.body, PDF.subarray(10, 20));
  });

  test('open-ended and suffix ranges', async () => {
    const open = await request(media, { headers: { Range: 'bytes=990-' } });
    assert.equal(open.statusCode, 206);
    assert.equal(open.headers['content-range'], 'bytes 990-999/1000');
    assert.deepEqual(open.body, PDF.subarray(990));
    const suffix = await request(media, { headers: { Range: 'bytes=-4' } });
    assert.equal(suffix.statusCode, 206);
    assert.deepEqual(suffix.body, PDF.subarray(996));
  });

  test('unsatisfiable range → 416 with Content-Range: bytes */size', async () => {
    const r = await request(media, { headers: { Range: 'bytes=5000-' } });
    assert.equal(r.statusCode, 416);
    assert.equal(r.headers['content-range'], 'bytes */1000');
    assert.equal(r.body.length, 0);
  });

  test('multi-range and If-Range requests fall back to the whole file', async () => {
    const multi = await request(media, { headers: { Range: 'bytes=0-1,5-9' } });
    assert.equal(multi.statusCode, 200);
    assert.equal(multi.body.length, 1000);
    const cond = await request(media, { headers: { Range: 'bytes=0-9', 'If-Range': 'W/"x"' } });
    assert.equal(cond.statusCode, 200);
    assert.equal(cond.body.length, 1000);
  });

  test('HEAD with Range reports the 206 headers without a body', async () => {
    const r = await request(media, { method: 'HEAD', headers: { Range: 'bytes=0-9' } });
    assert.equal(r.statusCode, 206);
    assert.equal(r.headers['content-length'], '10');
    assert.equal(r.body.length, 0);
  });

  test('a body over 1 MiB is answered with 413, not a dropped connection', async () => {
    for (const route of ['/api/dict-event', '/api/tree-filter-event', '/api/share-card/event']) {
      const big = Buffer.from(JSON.stringify({ query: 'x'.repeat(2 * 1024 * 1024) }));
      const r = await request(route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(big.length) },
        body: big
      });
      assert.equal(r.statusCode, 413, route);
      assert.equal(JSON.parse(r.body.toString()).code, 'PAYLOAD_TOO_LARGE', route);
      assert.equal(r.headers.connection, 'close', route);
    }
  });

  test('a normal small body is still accepted', async () => {
    const r = await request('/api/tree-filter-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '心經', matches: 2 })
    });
    assert.equal(r.statusCode, 200);
  });
});

describe('readJSONBody oversize', () => {
  function fakeReq(chunks, headers = {}) {
    const req = new EventEmitter();
    req.headers = headers;
    req.destroyed = false;
    req.destroy = () => { req.destroyed = true; };
    setImmediate(() => { for (const c of chunks) req.emit('data', c); req.emit('end'); });
    return req;
  }

  test('rejects with status 413 and leaves the socket for the caller to answer', async () => {
    const req = fakeReq([Buffer.alloc(auth.MAX_JSON_BODY_BYTES + 1)]);
    await assert.rejects(auth.readJSONBody(req), err => err.status === 413 && /Payload too large/.test(err.message));
    assert.equal(req.destroyed, false);
  });

  test('a declared Content-Length over the limit is refused up front', async () => {
    const req = fakeReq([], { 'content-length': String(auth.MAX_JSON_BODY_BYTES + 1) });
    await assert.rejects(auth.readJSONBody(req), err => err.status === 413);
    assert.equal(req.destroyed, false);
  });
});

describe('checkApiRateLimit eviction', () => {
  const fakeReq = (ip) => ({ socket: { remoteAddress: ip }, headers: {} });
  const hit = (ip) => auth.checkApiRateLimit(fakeReq(ip), {}, null);

  test('blocks the 31st request within a window', () => {
    auth.apiRateLimits.clear();
    for (let i = 0; i < 30; i++) assert.equal(hit('198.51.100.1'), true);
    assert.equal(hit('198.51.100.1'), false);
    auth.apiRateLimits.clear();
  });

  test('expired windows are pruned when a new window opens', () => {
    auth.apiRateLimits.clear();
    const stale = Date.now() - 5000;
    for (let i = 0; i < 50; i++) auth.apiRateLimits.set(`10.0.0.${i}`, { count: 1, windowStart: stale });
    hit('198.51.100.2');
    assert.equal(auth.apiRateLimits.size, 1);
    auth.apiRateLimits.clear();
  });

  test('at the size cap the stalest window is evicted, not an IP that just became active', () => {
    auth.apiRateLimits.clear();
    const cap = 10000;
    const now = Date.now();
    // Inserted first, with an expired window: this key sits at the front of the Map.
    auth.apiRateLimits.set('198.51.100.3', { count: 31, windowStart: now - 2000 });
    // Fill to the cap with other clients whose windows are still open.
    for (let i = 0; i < cap - 1; i++) auth.apiRateLimits.set(`fresh-${i}`, { count: 1, windowStart: now });
    assert.equal(auth.apiRateLimits.size, cap);
    // The first client opens a new window (it is now the most recent writer) ...
    assert.equal(hit('198.51.100.3'), true);
    // ... then one more distinct client pushes the Map over the cap.
    assert.equal(hit('198.51.100.4'), true);
    assert.ok(auth.apiRateLimits.size <= cap);
    assert.ok(auth.apiRateLimits.has('198.51.100.3'), 'the active IP must not be the one evicted');
    assert.ok(!auth.apiRateLimits.has('fresh-0'), 'the entry with the earliest window goes instead');
    auth.apiRateLimits.clear();
  });
});
