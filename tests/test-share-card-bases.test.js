/**
 * 早安圖底色（奶油／月白／杏粉／素紙／墨夜）：share-card.js 的配色表與驗證、紙底版型真的換色、
 * B 滿版不受影響、C 經籤底框跟著換、伺服器快取鍵、網址參數（奶油不寫，舊連結不變）、面板的底色選擇。
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
  test('四種底色，奶油是第一個也是預設；不認得的值一律奶油', () => {
    assert.deepEqual(ShareCard.BASE_IDS, ['cream', 'moon', 'apricot', 'plain']);
    assert.equal(ShareCard.normalizeBase(''), 'cream');
    assert.equal(ShareCard.normalizeBase(undefined), 'cream');
    assert.equal(ShareCard.normalizeBase('<script>'), 'cream');
    assert.equal(ShareCard.normalizeBase('__proto__'), 'cream');
    assert.equal(ShareCard.normalizeBase('NIGHT'), 'cream', '墨夜已拿掉');
    assert.equal(ShareCard.normalizeBase('MOON'), 'moon');
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

  test('紙底版型（N 的字區）：奶油、素紙畫出不同紙色', () => {
    const cream = px('N', 'cream', 20, 1300);
    const apricot = px('N', 'apricot', 20, 1300);
    assert.notDeepEqual(cream, apricot);
    assert.ok(cream[1] > apricot[1], `${cream} / ${apricot}`);
  });

  test('不給 base 與 base=cream 畫出來一樣；畫完不影響下一張', () => {
    assert.deepEqual(px('J', undefined, 20, 20), px('J', 'cream', 20, 20));
    px('J', 'moon', 20, 20);
    assert.deepEqual(px('J', undefined, 20, 20), px('J', 'cream', 20, 20));
  });

  test('C 經籤：背景照片不變，中間的經籤底框跟著底色', () => {
    assert.deepEqual(px('C', 'moon', 20, 20), px('C', 'cream', 20, 20), '籤外的照片');
    assert.notDeepEqual(px('C', 'moon', 540, 700), px('C', 'cream', 540, 700));
  });

  test('B 只給奶油；K／L／M 各自專屬一種底色，其他底色退回 A', () => {
    const L = ShareCard.layoutFor;
    assert.equal(L('B', 'cream'), 'B');
    for (const b of ['moon', 'apricot', 'plain']) assert.equal(L('B', b), 'A', b);
    assert.equal(L('K', 'moon'), 'K'); assert.equal(L('K', 'cream'), 'A'); assert.equal(L('K', 'plain'), 'A');
    assert.equal(L('L', 'apricot'), 'L'); assert.equal(L('L', 'moon'), 'A');
    assert.equal(L('M', 'plain'), 'M'); assert.equal(L('M', 'apricot'), 'A');
    assert.deepEqual(ShareCard.layoutsFor('cream'), ['A', 'B', 'C', 'I', 'J', 'N', 'P', 'Q']);
    assert.equal(ShareCard.layoutsFor('moon').length, 8);
    assert.deepEqual(px('K', 'cream', 300, 300), px('A', 'cream', 300, 300), '不能用的版型畫成 A');
  });

  test('K／L／M 畫得出來，和 A 不一樣，頁面中央有圖', () => {
    for (const [layout, base] of [['K', 'moon'], ['L', 'apricot'], ['M', 'plain']]) {
      assert.notDeepEqual(px(layout, base, 540, 1085), px('A', base, 540, 1085), layout);
    }
  });

  test('經籤的字在籤底上夠清楚', () => {
    for (const id of ShareCard.BASE_IDS) {
      const t = ShareCard.BASES[id];
      const tag = '#' + t.tag.split(',').map(n => (+n).toString(16).padStart(2, '0')).join('');
      assert.ok(contrast(t.tagInk, tag) >= 7, `${id} tagInk`);
      assert.ok(contrast(t.tagSoft, tag) >= 4.5, `${id} tagSoft`);
      assert.ok(contrast(t.red, tag) >= 4.5, `${id} red`);
    }
  });
});

describe('lib/share-card-server：底色與快取', () => {
  test('不同底色是不同的成品；非奶油底要 B 拿到 A', async (t) => {
    if (!sc.available()) return t.skip('沒有 @napi-rs/canvas');
    const base = { size: 'portrait', preview: true, verse: { text: '諸行無常，是生滅法。', source: '涅槃經' }, greeting: '早安', date: '2026-11-08', siteName: 's', host: '' };
    const a = await sc.render({ ...base, layout: 'Q', base: 'cream' });
    const b = await sc.render({ ...base, layout: 'Q', base: 'moon' });
    assert.ok(!a.equals(b));
    const plain = await sc.render({ ...base, layout: 'Q' });
    assert.ok(plain.equals(a), '沒給 base = 奶油');
    // B 只給奶油；其他底色要 B 就是 A（同一張，不重畫）
    const timing = {};
    await sc.render({ ...base, layout: 'A', base: 'plain' });
    await sc.render({ ...base, layout: 'B', base: 'plain' }, timing);
    assert.equal(timing.cache, 'hit');
    const asA = await sc.render({ ...base, layout: 'A', base: 'moon' });
    assert.ok((await sc.render({ ...base, layout: 'B', base: 'moon' })).equals(asA));
  });
});

describe('網址與面板', () => {
  test('伺服器：base／b 參數經過 normalizeBase；奶油不寫進網址，og 圖與分享連結帶上非預設底色', () => {
    assert.match(serverJs, /const base = ShareCard\.normalizeBase\(query\.base \|\| query\.b\)/);
    assert.match(serverJs, /layout: ShareCard\.layoutFor\(query\.layout \|\| query\.l, base\)/);
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
