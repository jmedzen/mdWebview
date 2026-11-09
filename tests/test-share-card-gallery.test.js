/**
 * 早安圖圖庫明細（後台「早安圖圖庫明細」）：上傳或改圖後，讓站長確認伺服器真的讀到了。
 *   - readImageSize：從檔頭讀 PNG／JPEG／WebP 的寬高，不解碼整張圖
 *   - 掃描：被略過的「看起來是圖」的檔案（格式不收、捷徑、太深）會列出來，不再默默消失
 *   - listPics({ force })：不等 60 秒快取就重掃
 *   - describePics：每張圖的大小、寬高、修改時間、可用與否
 *   - GET /api/admin/share-card?pics=1[&rescan=1]：管理員才能看，回 gallery
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const SC_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mdw-gal-cache-'));
process.env.SHARE_CARD_CACHE_DIR = SC_CACHE_DIR;
const sc = require('../lib/share-card-server');

// ── 手工做幾個只有檔頭的圖（readImageSize 只看檔頭） ─────────────────────────

function pngHeader(w, h) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b[24] = 8; b[25] = 6;   // 位元深度 8、RGBA
  return b;
}

function jpegHeader(w, h) {
  // SOI、APP0（16 位元組）、SOF0（高在前、寬在後）
  const b = Buffer.alloc(2 + 18 + 19);
  b[0] = 0xff; b[1] = 0xd8;
  b[2] = 0xff; b[3] = 0xe0; b.writeUInt16BE(16, 4); b.write('JFIF\0', 6, 'latin1');
  b[20] = 0xff; b[21] = 0xc0; b.writeUInt16BE(17, 22); b[24] = 8;
  b.writeUInt16BE(h, 25); b.writeUInt16BE(w, 27);
  return b;
}

function webpHeader(kind, w, h) {
  const b = Buffer.alloc(40);
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(32, 4); b.write('WEBP', 8, 'latin1');
  b.write(kind, 12, 'latin1');
  if (kind === 'VP8 ') { b.writeUInt16LE(w, 26); b.writeUInt16LE(h, 28); }
  else if (kind === 'VP8L') { b[20] = 0x2f; b.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 21); }
  else if (kind === 'VP8X') { b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3); }
  return b;
}

describe('readImageSize：從檔頭讀寬高', () => {
  test('PNG、JPEG、WebP（有損、無損、擴充）', () => {
    assert.deepEqual(sc.readImageSize(pngHeader(1536, 2048)), { width: 1536, height: 2048 });
    assert.deepEqual(sc.readImageSize(jpegHeader(3000, 4000)), { width: 3000, height: 4000 });
    assert.deepEqual(sc.readImageSize(webpHeader('VP8 ', 800, 1200)), { width: 800, height: 1200 });
    assert.deepEqual(sc.readImageSize(webpHeader('VP8L', 1000, 1500)), { width: 1000, height: 1500 });
    assert.deepEqual(sc.readImageSize(webpHeader('VP8X', 4096, 2160)), { width: 4096, height: 2160 });
  });

  test('不是圖、檔頭不完整、HEIC 改副檔名：回 null，不丟錯', () => {
    assert.equal(sc.readImageSize(null), null);
    assert.equal(sc.readImageSize(Buffer.alloc(0)), null);
    assert.equal(sc.readImageSize(Buffer.from('hello, this is not an image at all')), null);
    assert.equal(sc.readImageSize(pngHeader(10, 10).subarray(0, 20)), null);
    assert.equal(sc.readImageSize(jpegHeader(10, 10).subarray(0, 24)), null);
    const heic = Buffer.alloc(64);
    heic.writeUInt32BE(24, 0); heic.write('ftypheic', 4, 'latin1');
    assert.equal(sc.readImageSize(heic), null);
  });

  test('JPEG 的 SOF 排在很後面（前面有大段 EXIF）也找得到', () => {
    const exif = Buffer.alloc(4 + 60000);
    exif[0] = 0xff; exif[1] = 0xe1; exif.writeUInt16BE(60002, 2);
    const head = jpegHeader(640, 480);
    const buf = Buffer.concat([head.subarray(0, 2), exif, head.subarray(2)]);
    assert.deepEqual(sc.readImageSize(buf), { width: 640, height: 480 });
  });
});

describe('圖庫掃描與明細', () => {
  let tmp;
  let env;
  const realNow = Date.now;
  let offset = 0;

  const put = (rel, data = '') => {
    const abs = path.join(env.PIC_CARD_DIR, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
    return abs;
  };

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdw-gallery-'));
    env = { PIC_CARD_DIR: path.join(tmp, 'pic-card') };
    Date.now = () => realNow() + offset;
    put('ok/a.png', Buffer.concat([pngHeader(1620, 2025), Buffer.alloc(2000)]));
    put('ok/b.JPG', Buffer.concat([jpegHeader(3000, 4000), Buffer.alloc(500)]));
    put('c.webp', Buffer.concat([webpHeader('VP8X', 2048, 2560), Buffer.alloc(500)]));
    put('empty.png', '');
    put('fake.png', 'this is text, not a png');
    put('iphone.HEIC', 'x');
    put('anim.gif', 'x');
    put('notes.txt', 'x');
    put('.hidden.png', 'x');
    fs.writeFileSync(path.join(tmp, 'outside.png'), pngHeader(10, 10));
    try {
      fs.symlinkSync(path.join(tmp, 'outside.png'), path.join(env.PIC_CARD_DIR, 'link.png'));
      fs.symlinkSync(path.join(tmp, 'outside-dir'), path.join(env.PIC_CARD_DIR, 'broken-link.png'));   // 壞掉的捷徑不報
      fs.mkdirSync(path.join(tmp, 'other-dir'));
      fs.symlinkSync(path.join(tmp, 'other-dir'), path.join(env.PIC_CARD_DIR, 'linked-folder'));
    } catch (_) { /* 不能建 symlink 的環境：對應的斷言會跳過 */ }
    let deep = 'd0';
    for (let i = 1; i <= 10; i++) deep += `/d${i}`;
    put(`${deep}/too-deep.png`, pngHeader(10, 10));
    const big = put('big.png', pngHeader(10, 10));
    fs.truncateSync(big, 31 * 1024 * 1024);   // 稀疏檔：超過 30 MB
    await sc._resetForTests();
  });

  after(async () => {
    Date.now = realNow;
    await sc._resetForTests();
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(SC_CACHE_DIR, { recursive: true, force: true });
  });

  test('收 jpg／jpeg／png／webp 真檔案；格式不收、捷徑、太深的列在 skipped；隱藏檔與非圖檔不報', async () => {
    const s = await sc.listPics(env);
    assert.deepEqual(s.list, ['big.png', 'c.webp', 'empty.png', 'fake.png', 'ok/a.png', 'ok/b.JPG']);
    const by = Object.fromEntries(s.skipped.map(x => [x.path, x.reason]));
    assert.equal(by['iphone.HEIC'], 'format');
    assert.equal(by['anim.gif'], 'format');
    assert.equal(by['d0/d1/d2/d3/d4/d5/d6/d7/d8'], 'depth');
    assert.ok(!('notes.txt' in by), '非圖檔不用報');
    assert.ok(!('.hidden.png' in by), '隱藏檔不用報');
    assert.ok(!('broken-link.png' in by), '壞掉的捷徑不用報');
    if (fs.existsSync(path.join(env.PIC_CARD_DIR, 'link.png'))) {
      assert.equal(by['link.png'], 'symlink');
      assert.equal(by['linked-folder'], 'symlink');
      assert.ok(!s.list.includes('link.png'), '捷徑不收進清單');
    }
    assert.equal(s.truncated, false);
  });

  test('describePics：大小、寬高、修改時間、可用與否', async () => {
    const g = await sc.describePics(env);
    assert.equal(g.exists, true);
    assert.equal(g.count, 6);
    const by = Object.fromEntries(g.items.map(i => [i.path, i]));
    assert.deepEqual([by['ok/a.png'].width, by['ok/a.png'].height, by['ok/a.png'].problem], [1620, 2025, '']);
    assert.deepEqual([by['ok/b.JPG'].width, by['ok/b.JPG'].height, by['ok/b.JPG'].problem], [3000, 4000, '']);
    assert.deepEqual([by['c.webp'].width, by['c.webp'].height, by['c.webp'].problem], [2048, 2560, '']);
    assert.equal(by['ok/a.png'].size, 33 + 2000);
    assert.ok(Math.abs(by['ok/a.png'].mtimeMs - realNow()) < 60000, '修改時間要是檔案的 mtime');
    assert.equal(by['empty.png'].problem, 'empty');
    assert.equal(by['fake.png'].problem, 'header');
    assert.equal(by['big.png'].problem, 'too-large');
    assert.equal(g.badCount, 3);
    assert.equal(g.totalBytes, g.items.reduce((n, i) => n + i.size, 0));
    assert.ok(g.skipped.length >= 3);
    assert.equal(g.maxBytes, 30 * 1024 * 1024);
  });

  test('改圖後（換成不同大小）明細跟著變', async () => {
    put('ok/a.png', Buffer.concat([pngHeader(800, 1000), Buffer.alloc(100)]));
    offset += 61000;
    const g = await sc.describePics(env);
    const a = g.items.find(i => i.path === 'ok/a.png');
    assert.deepEqual([a.width, a.height, a.size], [800, 1000, 133]);
  });

  test('listPics force：不等 60 秒快取就看得到剛放進來的圖', async () => {
    await sc.listPics(env);
    put('fresh-upload.png', pngHeader(100, 100));
    const cached = await sc.listPics(env);
    assert.ok(!cached.list.includes('fresh-upload.png'), '快取期限內清單維持舊的');
    const forced = await sc.listPics(env, { force: true });
    assert.ok(forced.list.includes('fresh-upload.png'));
    const g = await sc.describePics(env);
    assert.ok(g.items.some(i => i.path === 'fresh-upload.png' && !i.problem));
  });

  test('資料夾不存在：exists false、沒有圖', async () => {
    const g = await sc.describePics({ PIC_CARD_DIR: path.join(tmp, 'nope') }, { force: true });
    assert.equal(g.exists, false);
    assert.equal(g.count, 0);
    assert.deepEqual(g.items, []);
    await sc._resetForTests();
  });
});

describe('GET /api/admin/share-card?pics=1', () => {
  const { server, terminateWorkerPools, resetTreeWatcher, resetDictWatcher, resetConfigWatcher } = require('../server.js');
  const accountsDb = require('../lib/db.js');
  let baseUrl = '';
  let tmp;
  let dropSession = () => {};
  const token = 'test-token-share-gallery';
  const prevPicDir = process.env.PIC_CARD_DIR;

  function request(p, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(new URL(p, baseUrl), { agent: false, headers: { Connection: 'close', ...headers } }, (res) => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdw-gallery-api-'));
    fs.mkdirSync(path.join(tmp, 'pics', 'batch'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'pics', 'batch', 'one.png'), Buffer.concat([pngHeader(1620, 2025), Buffer.alloc(100)]));
    process.env.PIC_CARD_DIR = path.join(tmp, 'pics');
    await sc._resetForTests();
    const username = `test-admin-${token}`;
    const user = accountsDb.getUserByUsername(username) ||
      accountsDb.createUser({ username, passwordHash: null, role: 'admin', displayName: username });
    accountsDb.createSession(user.id, token, { ttlMs: 60000, ip: '127.0.0.1', userAgent: 'test' });
    dropSession = () => accountsDb.deleteSessionByToken(token);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    }));
  });

  after(async () => {
    dropSession();
    if (prevPicDir === undefined) delete process.env.PIC_CARD_DIR; else process.env.PIC_CARD_DIR = prevPicDir;
    if (typeof resetTreeWatcher === 'function') resetTreeWatcher();
    if (typeof resetDictWatcher === 'function') resetDictWatcher();
    if (typeof resetConfigWatcher === 'function') resetConfigWatcher();
    if (typeof terminateWorkerPools === 'function') await terminateWorkerPools();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await sc._resetForTests();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('沒登入不給看；登入的管理員看得到每張圖，rescan 立刻讀到新檔', async () => {
    const anon = await request('/api/admin/share-card?pics=1');
    assert.ok([401, 403].includes(anon.statusCode), `未登入應拒絕，實際 ${anon.statusCode}`);
    assert.ok(!anon.body.includes('one.png'));

    const plain = await request('/api/admin/share-card', { 'X-Admin-Token': token });
    assert.equal(plain.statusCode, 200);
    assert.equal(JSON.parse(plain.body).gallery, undefined, '沒帶 pics=1 不附明細');

    const res = await request('/api/admin/share-card?pics=1', { 'X-Admin-Token': token });
    assert.equal(res.statusCode, 200);
    const d = JSON.parse(res.body);
    assert.equal(d.picCount, 1);
    assert.equal(d.gallery.count, 1);
    assert.deepEqual(
      [d.gallery.items[0].path, d.gallery.items[0].width, d.gallery.items[0].height, d.gallery.items[0].problem],
      ['batch/one.png', 1620, 2025, '']
    );

    fs.writeFileSync(path.join(tmp, 'pics', 'two.png'), pngHeader(1000, 1000));
    const stale = JSON.parse((await request('/api/admin/share-card?pics=1', { 'X-Admin-Token': token })).body);
    assert.equal(stale.gallery.count, 1, '快取期限內維持舊清單');
    const fresh = JSON.parse((await request('/api/admin/share-card?pics=1&rescan=1', { 'X-Admin-Token': token })).body);
    assert.equal(fresh.gallery.count, 2);
    assert.equal(fresh.picCount, 2);
  });
});
