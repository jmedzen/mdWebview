/**
 * 早安圖底色（奶油／月白／杏粉／素紙／墨夜）：share-card.js 的配色表與驗證、紙底版型真的換色、
 * B/C 滿版版型不受影響、伺服器快取鍵、網址參數（奶油不寫，舊連結不變）、面板的底色選擇。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
process.env.SHARE_CARD_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mdw-sc-bases-'));
const ShareCard = require('../share-card.js');
const sc = require('../lib/share-card-server');
const appJs = fs.readFileSync(path.join(ROOT_DIR, 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
const serverJs = fs.readFileSync(path.join(ROOT_DIR, 'server.js'), 'utf8');

function lum(hex) {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a, b) {
  const x = lum(a), y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

describe('share-card.js：底色配色表', () => {
  test('五種底色，奶油是第一個也是預設；不認得的值一律奶油', () => {
    assert.deepEqual(ShareCard.BASE_IDS, ['cream', 'moon', 'apricot', 'plain', 'night']);
    assert.equal(ShareCard.normalizeBase(''), 'cream');
    assert.equal(ShareCard.normalizeBase(undefined), 'cream');
    assert.equal(ShareCard.normalizeBase('<script>'), 'cream');
    assert.equal(ShareCard.normalizeBase('__proto__'), 'cream');
    assert.equal(ShareCard.normalizeBase('NIGHT'), 'night');
    assert.equal(ShareCard.BASE_NAMES.moon, '月白');
  });

  test('奶油底維持原本的紙色（#f6f0e2 → #efe6d0）', () => {
    const t = ShareCard.BASES.cream;
    assert.equal(t.top, '#f6f0e2');
    assert.equal(t.bottom, '#efe6d0');
    assert.equal(t.rgb, '246,240,226');
  });

  test('每種底色：rgb 與 top 一致；經句、日期、出處、頁尾在紙色上都夠清楚', () => {
    for (const id of ShareCard.BASE_IDS) {
      const t = ShareCard.BASES[id];
      const rgb = [1, 3, 5].map(i => parseInt(t.top.slice(i, i + 2), 16)).join(',');
      assert.equal(t.rgb, rgb, `${id} rgb`);
      for (const bg of [t.top, t.bottom]) {
        assert.ok(contrast(t.ink, bg) >= 7, `${id} ink`);
        assert.ok(contrast(t.inkSoft, bg) >= 4.5, `${id} inkSoft`);
        assert.ok(contrast(t.source, bg) >= 3.5, `${id} source`);
        assert.ok(contrast(t.muted, bg) >= 3, `${id} muted`);
        assert.ok(contrast(t.red, bg) >= 4.5, `${id} red`);
      }
    }
  });
});

describe('share-card.js：畫圖時真的換色', () => {
  const { createCanvas } = require('@napi-rs/canvas');
  const opts = { size: 'portrait', verse: { text: '一切有為法，如夢幻泡影。', source: '金剛經' }, greeting: '早安', date: '2026-11-08', siteName: 's' };
  const px = (layout, base, x, y) => {
    const c = createCanvas(1080, 1350);
    ShareCard.draw(c.getContext('2d'), { ...opts, layout, base });
    return Array.from(c.getContext('2d').getImageData(x, y, 1, 1).data.slice(0, 3));
  };

  test('紙底版型（N 的字區）：奶油、墨夜畫出不同紙色，墨夜是深色', () => {
    const cream = px('N', 'cream', 20, 1300);
    const night = px('N', 'night', 20, 1300);
    assert.notDeepEqual(cream, night);
    assert.ok(cream[0] > 200 && night[0] < 60, `${cream} / ${night}`);
  });

  test('不給 base 與 base=cream 畫出來一樣；畫完不影響下一張', () => {
    assert.deepEqual(px('J', undefined, 20, 20), px('J', 'cream', 20, 20));
    px('J', 'night', 20, 20);
    assert.deepEqual(px('J', undefined, 20, 20), px('J', 'cream', 20, 20));
  });

  test('B/C 滿版版型不受底色影響', () => {
    for (const layout of ['B', 'C']) {
      assert.deepEqual(px(layout, 'night', 500, 1200), px(layout, 'cream', 500, 1200), layout);
    }
  });
});

describe('lib/share-card-server：底色與快取', () => {
  test('不同底色是不同的成品；B/C 不同底色共用同一張', async (t) => {
    if (!sc.available()) return t.skip('沒有 @napi-rs/canvas');
    const base = { size: 'portrait', preview: true, verse: { text: '諸行無常，是生滅法。', source: '涅槃經' }, greeting: '早安', date: '2026-11-08', siteName: 's', host: '' };
    const a = await sc.render({ ...base, layout: 'Q', base: 'cream' });
    const b = await sc.render({ ...base, layout: 'Q', base: 'moon' });
    assert.ok(!a.equals(b));
    const plain = await sc.render({ ...base, layout: 'Q' });
    assert.ok(plain.equals(a), '沒給 base = 奶油');
    await sc.render({ ...base, layout: 'B', base: 'cream' });
    const timing = {};
    await sc.render({ ...base, layout: 'B', base: 'night' }, timing);
    assert.equal(timing.cache, 'hit');
  });
});

describe('網址與面板', () => {
  test('伺服器：base／b 參數經過 normalizeBase；奶油不寫進網址，og 圖與分享連結帶上非預設底色', () => {
    assert.match(serverJs, /base: ShareCard\.normalizeBase\(query\.base \|\| query\.b\)/);
    assert.match(serverJs, /p\.base && p\.base !== 'cream' \? `&\$\{key\}=\$\{p\.base\}` : ''/);
    assert.equal((serverJs.match(/shareCardBaseQs\(p, 'base'\)/g) || []).length, 2, 'verse 與 quote 的 og:image');
    assert.equal((serverJs.match(/shareCardBaseQs\(p, 'b'\)/g) || []).length, 2, 'verse 與 quote 的分享連結');
  });

  test('面板：底色色票、記在本機、換底色重畫；預覽快取鍵含底色；分享連結的 b= 讀完清掉', () => {
    assert.match(indexHtml, /id="shareCardBases" role="radiogroup" aria-label="底色"/);
    assert.match(appJs, /SHARE_BASE_KEY = 'mdWebview-share-card-base'/);
    assert.match(appJs, /function renderShareBases\(\)/);
    assert.match(appJs, /storage\.set\(SHARE_BASE_KEY, base\)/);
    assert.match(appJs, /const key = `\$\{layout\}\|\$\{shareRt\.base\}\|/);
    assert.match(appJs, /for \(const k of \['d', 'g', 'l', 'b'\]\) params\.delete\(k\)/);
    assert.match(appJs, /layout, base: shareRt\.base, size: drawSize/);
  });
});
