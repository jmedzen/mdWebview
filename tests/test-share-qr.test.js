/**
 * 早安圖 QR 碼（v4.18.0）：lib/share-qr.js 的短網址、路徑解析、找行號與挑經；
 * share-card.js 的 QR 格子、只畫在直式、畫布放大 1.5 倍；前端開關預設關。
 */
const fs = require('fs');
const path = require('path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const shareQr = require('../lib/share-qr');
const ShareCard = require('../share-card.js');

const ROOT = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

describe('lib/share-qr：短網址', () => {
  test('網址全大寫英數：協定、主機名大寫，V/Q＋代號前 7 碼＋版型', () => {
    assert.equal(shareQr.qrUrl('https://mbt.mahabodhi.co', 'verse', '3fa2c91b0d', 'a'), 'HTTPS://MBT.MAHABODHI.CO/V3FA2C91A');
    assert.equal(shareQr.qrUrl('https://mbt.mahabodhi.co/', 'quote', '8c1e04b7fa', 'Q'), 'HTTPS://MBT.MAHABODHI.CO/Q8C1E04BQ');
    assert.equal(shareQr.qrUrl('http://localhost:8080', 'verse', '3fa2c91b0d'), 'HTTP://LOCALHOST:8080/V3FA2C91');
    assert.equal(shareQr.qrUrl('https://example.org/sub', 'verse', '3fa2c91b0d', 'B'), 'HTTPS://EXAMPLE.ORG/sub/V3FA2C91B');
    assert.equal(shareQr.qrUrl('https://x.org', 'verse', 'nothex', 'A'), '');
    assert.equal(shareQr.qrUrl('not a url', 'verse', '3fa2c91b0d', 'A'), '');
  });

  test('mbt.mahabodhi.co 的 QR 是 25×25 格（英數模式、容錯 M）', () => {
    const m = ShareCard.qrMatrix(shareQr.qrUrl('https://mbt.mahabodhi.co', 'verse', '3fa2c91b0d', 'A'));
    assert.equal(m.modules.length, 25);
    // 小寫網址只能用位元組模式，格子較多
    assert.equal(ShareCard.qrMatrix('https://mbt.mahabodhi.co/v3fa2c91a').modules.length, 29);
  });

  test('解析路徑：大小寫通用、版型可省略、其他路徑不認', () => {
    assert.deepEqual(shareQr.parseQrPath('/V3FA2C91A'), { kind: 'verse', code: '3fa2c91', layout: 'A' });
    assert.deepEqual(shareQr.parseQrPath('/q8c1e04b'), { kind: 'quote', code: '8c1e04b', layout: '' });
    assert.deepEqual(shareQr.parseQrPath('/V3FA2C91A/'), { kind: 'verse', code: '3fa2c91', layout: 'A' });
    for (const p of ['/', '/vendor/x.js', '/V3FA2C9', '/V3FA2C91AB', '/X3FA2C91A', '/V3FA2C9GA', '/api/V3FA2C91A']) {
      assert.equal(shareQr.parseQrPath(p), null, p);
    }
  });

  test('在原文找行號：跨行、去 Markdown 記號、忽略標點', () => {
    const md = ['# 經', '', '佛告**須菩提**：凡所有相，', '皆是虛妄。', '', '一切有為法，', '如夢幻泡影。'].join('\n');
    assert.equal(shareQr.findLine(md, '凡所有相，皆是虛妄。'), 3);
    assert.equal(shareQr.findLine(md, '一切有為法如夢幻泡影'), 6);
    assert.equal(shareQr.findLine(md, '應無所住'), null);
  });

  test('用出處挑經：檔名（去經號）相同的優先，再來是互相包含的', () => {
    const files = [
      { relPath: '般若部/T0251 般若波羅蜜多心經.md' },
      { relPath: '般若部/T0235 金剛般若波羅蜜經.md' },
      { relPath: '注疏/金剛般若波羅蜜經疏.md' },
      { relPath: '其他/法華經.md' }
    ];
    const c = shareQr.candidateFiles(files, '《金剛般若波羅蜜經》').map(f => f.relPath);
    assert.deepEqual(c, ['般若部/T0235 金剛般若波羅蜜經.md', '注疏/金剛般若波羅蜜經疏.md']);
    assert.deepEqual(shareQr.candidateFiles(files, '經'), []);
  });

  test('每日經句定位：有路徑用路徑；沒有就用出處；結果快取', async () => {
    shareQr._resetForTests();
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mdw-share-qr-'));
    fs.writeFileSync(path.join(tmp, 'a.md'), '第一行\n應無所住，而生其心。\n');
    let listed = 0;
    const deps = {
      resolveMdPath: p => (p === 'a.md' ? { resolved: path.join(tmp, 'a.md'), relPath: 'a.md' } : null),
      listFiles: async () => { listed++; return [{ fullPath: path.join(tmp, 'a.md'), relPath: '經/T0235 金剛經.md' }]; }
    };
    assert.deepEqual(await shareQr.locateVerse({ text: '應無所住，而生其心。', path: 'a.md' }, deps), { path: 'a.md', line: 2 });
    assert.deepEqual(await shareQr.locateVerse({ text: '應無所住，而生其心。', source: '金剛經' }, deps), { path: '經/T0235 金剛經.md', line: 2 });
    await shareQr.locateVerse({ text: '應無所住，而生其心。', source: '金剛經' }, deps);
    assert.equal(listed, 1, '第二次用快取');
    assert.equal(await shareQr.locateVerse({ text: '不在檔案裡的句子', source: '金剛經' }, deps), null);
  });
});

describe('share-card.js：QR 小籤', () => {
  function fakeCtx(width) {
    const calls = { rects: 0, scale: null, transformsReset: 0 };
    let t = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    const stack = [];
    const noop = () => {};
    const grad = { addColorStop: noop };
    return {
      calls,
      canvas: { width },
      save() { stack.push({ ...t }); },
      restore() { t = stack.pop() || t; },
      scale(x) { calls.scale = x; t = { ...t, a: t.a * x, d: t.d * x }; },
      translate: noop, rotate: noop,
      getTransform() { return { ...t }; },
      setTransform() { calls.transformsReset++; t = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; },
      fillRect(x, y, w, h) { if (calls.transformsReset && w === h && w <= 4) calls.rects++; },
      fillText: noop, strokeRect: noop, beginPath: noop, moveTo: noop, lineTo: noop, quadraticCurveTo: noop,
      closePath: noop, fill: noop, stroke: noop, arc: noop, clip: noop, drawImage: noop, ellipse: noop, bezierCurveTo: noop,
      measureText: s => ({ width: String(s).length * 20 }),
      createLinearGradient: () => grad, createRadialGradient: () => grad,
      getImageData: () => ({ data: new Uint8ClampedArray(4) })
    };
  }

  test('八款直式都畫 QR；og 連結預覽圖不畫；直式畫布 1620 寬時放大 1.5 倍', () => {
    assert.deepEqual(ShareCard.PIXEL_SIZES.portrait, [1620, 2025]);
    const opts = { size: 'portrait', verse: { text: '應無所住，而生其心。', source: '金剛經' }, date: '2026-11-02', qr: 'HTTPS://MBT.MAHABODHI.CO/V3FA2C91A' };
    for (const layout of ShareCard.LAYOUTS) {
      const ctx = fakeCtx(1620);
      ShareCard.draw(ctx, { ...opts, layout });
      assert.equal(ctx.calls.scale, 1.5, layout);
      assert.ok(ctx.calls.rects > 100, `${layout} 沒畫 QR 格子`);
      const og = fakeCtx(1200);
      ShareCard.draw(og, { ...opts, layout, size: 'og' });
      assert.equal(og.calls.rects, 0, `${layout} og 不該有 QR`);
      const none = fakeCtx(1620);
      ShareCard.draw(none, { ...opts, layout, qr: '' });
      assert.equal(none.calls.rects, 0, `${layout} 沒給網址不該有 QR`);
    }
  });
});

describe('前端：附 QR 碼開關', () => {
  test('面板有開關（膠囊），預設附，記在本機', () => {
    assert.match(indexHtml, /id="shareCardQr"/);
    assert.match(appJs, /storage\.get\(SHARE_QR_KEY, '1'\) === '1'/);
    assert.match(appJs, /qr=1/);
  });

  test('QR 產生器隨程式附上（MIT），瀏覽器只在自己畫圖時載入', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'vendor', 'qrcode', 'qrcode.js')));
    assert.match(fs.readFileSync(path.join(ROOT, 'vendor', 'qrcode', 'LICENSE'), 'utf8'), /MIT License/);
    assert.doesNotMatch(indexHtml, /vendor\/qrcode/);
    assert.match(appJs, /\/vendor\/qrcode\/qrcode\.js/);
  });
});
