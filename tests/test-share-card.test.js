/**
 * 每日經句：換一句、分享早安圖（share-card.js 繪圖、lib/share-card-server.js 圖庫與伺服器畫圖）。
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const ShareCard = require('../share-card.js');
const home = require('../lib/home');
const sc = require('../lib/share-card-server');
const appJs = fs.readFileSync(path.join(ROOT_DIR, 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
const serverJs = fs.readFileSync(path.join(ROOT_DIR, 'server.js'), 'utf8');
const dockerfile = fs.readFileSync(path.join(ROOT_DIR, 'Dockerfile'), 'utf8');
const swJs = fs.readFileSync(path.join(ROOT_DIR, 'sw.js'), 'utf8');

describe('share-card.js：日期與斷行', () => {
  test('日期字樣：星期、節氣、中文數字（只看日期，不受時區影響）', () => {
    const d = ShareCard.dateInfo('2026-11-02');
    assert.equal(d.week, '星期一');
    assert.equal(d.term, '霜降');
    assert.equal(d.day, '02');
    assert.equal(d.monthCn, '十一月');
    assert.equal(d.cnFull, '二〇二六年十一月二日');
    assert.equal(ShareCard.dateInfo('2026-11-07').term, '立冬');
    assert.equal(ShareCard.dateInfo('2026-01-02').term, '冬至');
  });

  test('日期、問候、版型、尺寸只收合法值', () => {
    assert.equal(ShareCard.normalizeDate('2026-02-30'), null);
    assert.equal(ShareCard.normalizeDate('2026-2-3'), null);
    assert.equal(ShareCard.normalizeDate('<x>'), null);
    assert.equal(ShareCard.normalizeDate('2026-02-28'), '2026-02-28');
    assert.equal(ShareCard.normalizeGreeting('晚安'), '晚安');
    assert.equal(ShareCard.normalizeGreeting('<b>'), '早安');
    assert.equal(ShareCard.normalizeLayout('c'), 'C');
    assert.equal(ShareCard.normalizeLayout('Z'), 'A');
    assert.equal(ShareCard.normalizeSize('og'), 'og');
    assert.equal(ShareCard.normalizeSize('huge'), 'portrait');
    assert.equal(ShareCard.greetingForHour(7), '早安');
    assert.equal(ShareCard.greetingForHour(13), '午安');
    assert.equal(ShareCard.greetingForHour(22), '晚安');
  });

  test('斷行：分句盡量不拆，行尾標點拿掉，太長才硬切', () => {
    assert.deepEqual(ShareCard.packLines('若人欲識佛境界，當淨其意如虛空。', 8), ['若人欲識佛境界', '當淨其意如虛空']);
    assert.deepEqual(ShareCard.packLines('若人欲了知，三世一切佛，應觀法界性，一切唯心造。', 11),
      ['若人欲了知，三世一切佛', '應觀法界性，一切唯心造']);
    const long = ShareCard.packLines('一二三四五六七八九十甲乙', 5);
    assert.deepEqual(long, ['一二三四五', '六七八九十', '甲乙']);
    assert.ok(long.every(l => Array.from(l).length <= 5));
  });

  test('zonedNow：同一個瞬間在不同時區的日期與問候', () => {
    const t = new Date('2026-11-02T23:30:00Z');
    assert.deepEqual(ShareCard.zonedNow('Asia/Taipei', t), { ymd: '2026-11-03', hour: 7 });
    assert.deepEqual(ShareCard.zonedNow('America/Los_Angeles', t), { ymd: '2026-11-02', hour: 15 });
    assert.deepEqual(ShareCard.zonedNow('UTC', t), { ymd: '2026-11-02', hour: 23 });
    assert.deepEqual(ShareCard.zonedNow('Not/AZone', t), { ymd: '2026-11-02', hour: 23 });
    assert.equal(ShareCard.greetingForHour(ShareCard.zonedNow('Asia/Taipei', t).hour), '早安');
    for (const g of ['法安', '自在', '吉祥']) { assert.ok(ShareCard.GREETINGS.includes(g)); assert.equal(ShareCard.normalizeGreeting(g), g); }
    assert.equal(ShareCard.greetingForHour(ShareCard.zonedNow('America/Los_Angeles', t).hour), '午安');
  });

  test('版型 Q 的英文問候：自在＝Boundless Ease（不用軍隊口令 At Ease），每個問候都有英文', () => {
    const en = ShareCard.GREETING_EN;
    assert.equal(en['自在'], 'Boundless Ease');
    assert.equal(en['法安'], 'Dharma Peace');
    assert.equal(en['吉祥'], 'Blessings');
    assert.ok(!Object.values(en).some(v => /^at ease$/i.test(v)));
    for (const g of ShareCard.GREETINGS) {
      assert.ok(en[g], `${g} 缺英文`);
      assert.ok(en[g].length <= 'Good Afternoon'.length, `${g} 的英文太長，會擠到 QR 碼`);
    }
  });

  test('印章字取站名前兩個漢字，沒有就用「吉祥」', () => {
    assert.equal(ShareCard.sealText('大覺藏集'), '大覺');
    assert.equal(ShareCard.sealText('mdWebview'), '吉祥');
  });

  test('經句代號：同一句（標點不同）代號相同，10 碼十六進位', () => {
    const a = home.verseId('應無所住，而生其心。');
    assert.match(a, /^[0-9a-f]{10}$/);
    assert.equal(home.verseId('應無所住而生其心'), a);
    assert.notEqual(home.verseId('色即是空'), a);
    assert.equal(home.verseId(''), '');
  });
});

describe('lib/share-card-server：圖庫', () => {
  let tmp;
  const env = () => ({ PIC_CARD_DIR: path.join(tmp, 'pic-card') });
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdw-piccard-'));
    const dir = path.join(tmp, 'pic-card');
    fs.mkdirSync(path.join(dir, 'a', 'b', 'c'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.hidden'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'top.jpg'), 'x');
    fs.writeFileSync(path.join(dir, 'a', 'one.PNG'), 'x');
    fs.writeFileSync(path.join(dir, 'a', 'b', 'c', 'deep.webp'), 'x');
    fs.writeFileSync(path.join(dir, 'a', 'note.txt'), 'x');
    fs.writeFileSync(path.join(dir, '.hidden', 'secret.jpg'), 'x');
    fs.writeFileSync(path.join(tmp, 'outside.jpg'), 'x');
    sc._resetForTests();
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('遞迴讀所有子資料夾的 jpg/png/webp，略過隱藏資料夾與其他檔案', async () => {
    const s = await sc.listPics(env());
    assert.equal(s.exists, true);
    assert.deepEqual(s.list, ['a/b/c/deep.webp', 'a/one.PNG', 'top.jpg']);
  });

  test('挑圖：同一句同一天固定同一張；沒有圖回 null', () => {
    const list = ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg'];
    const p1 = sc.pickPic(list, 'abc', '2026-11-02');
    assert.equal(sc.pickPic(list, 'abc', '2026-11-02'), p1);
    assert.ok(list.includes(p1));
    const picks = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(id => sc.pickPic(list, id, '2026-11-02')));
    assert.ok(picks.size > 1, '不同經句應該會分到不同圖');
    assert.equal(sc.pickPic([], 'abc', '2026-11-02'), null);
  });

  test('路徑檢查：擋 ..、隱藏檔、錯的副檔名', async () => {
    const e = env();
    assert.ok(sc.resolvePic('a/one.PNG', e));
    assert.equal(sc.resolvePic('../outside.jpg', e), null);
    assert.equal(sc.resolvePic('a/../../outside.jpg', e), null);
    assert.equal(sc.resolvePic('.hidden/secret.jpg', e), null);
    assert.equal(sc.resolvePic('a/note.txt', e), null);
    assert.equal(sc.resolvePic('/etc/passwd.jpg', e), null);
    assert.equal(await sc.isRealPicPath(sc.resolvePic('top.jpg', e), e), true);
  });

  test('symlink 指到圖庫外面的檔案不給讀', async (t) => {
    const e = env();
    const link = path.join(tmp, 'pic-card', 'link.jpg');
    try { fs.symlinkSync(path.join(tmp, 'outside.jpg'), link); } catch (_) { t.skip('不能建立 symlink'); return; }
    assert.equal(await sc.isRealPicPath(sc.resolvePic('link.jpg', e), e), false);
  });
});

describe('lib/share-card-server：伺服器畫圖', () => {
  test('所有版型 × 兩種尺寸都畫得出 JPEG，尺寸正確', async (t) => {
    if (!sc.available()) { t.skip('@napi-rs/canvas 不可用'); return; }
    const { loadImage } = require('@napi-rs/canvas');
    for (const layout of ShareCard.LAYOUTS) {
      for (const size of ['portrait', 'og']) {
        const buf = await sc.render({
          layout, size, verse: { text: '一切有為法，如夢幻泡影，如露亦如電，應作如是觀。', source: '金剛般若波羅蜜經' },
          greeting: '早安', date: '2026-11-02', siteName: '測試站', host: 'example.org', picAbs: null
        });
        assert.equal(buf[0], 0xff);
        assert.equal(buf[1], 0xd8);
        const img = await loadImage(buf);
        assert.deepEqual([img.width, img.height], ShareCard.PIXEL_SIZES[size]);
      }
    }
  });

  test('Q 版型的英文手寫體 Dancing Script 隨程式附上，會被載入', async (t) => {
    if (!sc.available()) { t.skip('@napi-rs/canvas 不可用'); return; }
    assert.ok(fs.existsSync(path.join(ROOT_DIR, 'vendor', 'fonts', 'DancingScript-700.ttf')));
    assert.ok(sc.fontDirs({}).some(d => d.endsWith(path.join('vendor', 'fonts'))));
    assert.ok(sc.status().fonts.includes('DancingScript-700.ttf'), '字型沒被載入');
  });

  test('分享面板小預覽：直式版面畫在 864×1080，比全尺寸小很多；快取和全尺寸分開', async (t) => {
    if (!sc.available()) { t.skip('@napi-rs/canvas 不可用'); return; }
    const { loadImage } = require('@napi-rs/canvas');
    assert.deepEqual(ShareCard.PREVIEW_PIXELS, [864, 1080]);
    const opts = { layout: 'A', size: 'portrait', verse: { text: '諸惡莫作，眾善奉行。', source: '' }, greeting: '早安', date: '2026-11-03', siteName: 's', host: '', qr: 'https://example.org/v/0123456789A' };
    const timing = {};
    const small = await sc.render({ ...opts, preview: true }, timing);
    const full = await sc.render(opts);
    assert.notEqual(small, full);
    const img = await loadImage(small);
    assert.deepEqual([img.width, img.height], [864, 1080]);
    assert.ok(small.length < full.length / 2, `預覽 ${small.length} B 應比全尺寸 ${full.length} B 小很多`);
    assert.equal(timing.cache, 'miss');
    for (const k of ['decode', 'draw', 'encode']) assert.ok(Number.isFinite(timing[k]), `timing.${k}`);
    const again = {};
    await sc.render({ ...opts, preview: true }, again);
    assert.equal(again.cache, 'hit');
    // og 沒有預覽版：preview 只對直式有效
    const og = await loadImage(await sc.render({ ...opts, size: 'og', preview: true }));
    assert.deepEqual([og.width, og.height], ShareCard.PIXEL_SIZES.og);
  });

  test('同一張背景圖同時有 8 個版型在畫，只解碼一次', async (t) => {
    if (!sc.available()) { t.skip('@napi-rs/canvas 不可用'); return; }
    const { createCanvas } = require('@napi-rs/canvas');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdw-piccard-dec-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const c = createCanvas(600, 400);
    const x = c.getContext('2d');
    x.fillStyle = '#9ec5e8';
    x.fillRect(0, 0, 600, 400);
    const picAbs = path.join(tmp, 'bg.png');
    fs.writeFileSync(picAbs, c.toBuffer('image/png'));
    sc._resetForTests();
    const before = sc.decodeCount();
    const verse = { text: '應無所住，而生其心。', source: '金剛經' };
    await Promise.all(ShareCard.LAYOUTS.map(layout => sc.render({ layout, size: 'portrait', preview: true, verse, greeting: '早安', date: '2026-11-03', siteName: 's', host: '', picAbs })));
    assert.equal(sc.decodeCount() - before, 1);
  });

  test('同樣參數第二次直接用快取', async (t) => {
    if (!sc.available()) { t.skip('@napi-rs/canvas 不可用'); return; }
    const opts = { layout: 'B', size: 'og', verse: { text: '應無所住，而生其心。', source: '' }, greeting: '午安', date: '2026-11-03', siteName: 's', host: '' };
    const a = await sc.render(opts);
    const b = await sc.render(opts);
    assert.equal(a, b);
  });
});

describe('首頁與伺服器接線', () => {
  test('首頁經句下有「換一句」與「分享早安圖」，分享面板有四顆動作按鈕', () => {
    assert.match(indexHtml, /id="homeVerseShuffle"/);
    assert.match(indexHtml, /id="homeVerseShare"/);
    assert.match(indexHtml, /id="shareCardOverlay"/);
    assert.doesNotMatch(indexHtml, /id="shareMode(Image|Link)"/, '分享方式切換已拿掉，連結功能在「複製連結」');
    assert.match(indexHtml, /id="shareCardCopyLink"/);
    assert.match(indexHtml, /<script src="share-card\.js\?v=[^"]+" defer><\/script>\s*<script src="highlights\.js/);
  });

  test('卡片沒帶日期／問候時用網站時區；瀏覽器端畫卡用讀者本機時間', () => {
    assert.match(serverJs, /ShareCard\.zonedNow\(dailyVerseTimezone\(\)\)\.ymd/);
    assert.match(serverJs, /GREETINGS\.includes\(query\.g\) \? query\.g : '吉祥'/, '沒帶問候的連結預覽用不分時間的「吉祥」');
    assert.doesNotMatch(appJs, /\/\?verse=\$\{encodeURIComponent\(v\.id\)\}&d=\$\{shareRt\.date\}&g=/, '「時間問候」模式的連結不帶問候');
    assert.match(appJs, /function shareLinkGreeting\(\)/);
    assert.match(appJs, /SHARE_GREETING_MODES = \['time', '法安', '自在', '吉祥'\]/);
    assert.match(indexHtml, /id="shareCardGreetings"/);
    assert.match(appJs, /shareRt\.date = localYmd\(now\);/);
    assert.match(appJs, /shareRt\.greeting = shareGreetingFor\(shareRt\.greetingMode, now\);/);
  });

  test('分享卡永遠用畫面上正在顯示的那一句', () => {
    assert.match(appJs, /state\._homeVerseOverride \|\| \('verse' in data/);
    assert.match(appJs, /shareRt\.verse = verse/);
    // 沒傳選句（選字製作）時用首頁正在顯示的那一句
    assert.match(appJs, /const verse = subject && subject\.kind === 'quote' \? subject : state\._homeVerseCurrent;/);
  });

  test('「傳到 LINE」走系統分享（檔案）；「複製連結」複製帶 ?verse= 的分享連結', () => {
    assert.match(appJs, /navigator\.share\(\{ files: \[file\] \}\)/);
    assert.match(appJs, /\/\?verse=\$\{encodeURIComponent\(v\.id\)\}/);
  });

  test('手機不能分享檔案（Firefox Android）時「傳到 LINE」顯示大圖兩步驟（長按複製→開啟 LINE），另附改傳連結，不再下載', () => {
    assert.match(appJs, /function canShareFiles\(\)/);
    assert.match(appJs, /function shareLinkToLine\(\)/);
    assert.match(appJs, /async function lineManualImage\(\)/);
    const fn = appJs.slice(appJs.indexOf('async function shareToLine()'), appJs.indexOf('function isPhoneOrTablet()'));
    // 先判斷，再畫圖
    assert.ok(fn.indexOf('isPhoneOrTablet() && !canShareFiles()') < fn.indexOf('await getShareCardBlob'));
    assert.ok(fn.indexOf('if (isPhoneOrTablet()) { lineManualImage(); return; }') < fn.indexOf('downloadBlob('), '手機不會走下載');
    const man = appJs.slice(appJs.indexOf('async function lineManualImage()'), appJs.indexOf('async function shareToLine()'));
    assert.match(man, /showSaveImageOverlay\(blob, /);
    assert.match(man, /https:\/\/line\.me\/R\//);
    assert.match(man, /shareLinkToLine\(\)/);
    assert.match(man, /sendShareEvent\('lineManual'\)/);
    assert.match(appJs, /傳到 LINE（兩步）/);
    assert.match(indexHtml, /id="shareCardLineLabel"/);
    const link = appJs.slice(appJs.indexOf('function shareLinkToLine()'), appJs.indexOf('async function lineManualImage()'));
    assert.match(link, /navigator\.share\(\{ text, url \}\)/);
    assert.match(link, /lineMsgUrl\(/);
    assert.match(link, /sendShareEvent\('lineLink'\)/);
  });

  test('不能複製圖片（Firefox）時改顯示大圖讓人長按複製，電腦版改存檔', () => {
    assert.match(appJs, /function canCopyImage\(\)/);
    assert.match(appJs, /ClipboardItem\.supports\('image\/png'\)/);
    const fn = appJs.slice(appJs.indexOf('async function copyShareImage()'), appJs.indexOf('function setupShareCard()'));
    assert.match(fn, /if \(!canCopyImage\(\)\) \{ copyImageByHand\(\); return; \}/);
    assert.match(fn, /'image\/png': await png/, '不收 Promise 時再試一次');
    const hand = appJs.slice(appJs.indexOf('async function copyImageByHand()'), appJs.indexOf('async function copyShareImage()'));
    assert.match(hand, /showSaveImageOverlay\(blob, '/);
    assert.match(hand, /downloadBlob\(blob, shareCardFileName\(\)\)/);
  });

  test('手機「存圖片」顯示大圖讓人長按存相簿（和「傳到 LINE」的分享選單不同）；電腦版仍是下載', () => {
    assert.match(appJs, /function isPhoneOrTablet\(\)/);
    assert.match(appJs, /function showSaveImageOverlay\(blob, tip, actions\)/);
    const fn = appJs.slice(appJs.indexOf('async function saveShareImage()'), appJs.indexOf('async function copyShareImage()'));
    assert.match(fn, /isPhoneOrTablet\(\)/);
    assert.match(fn, /showSaveImageOverlay\(blob\)/);
    assert.doesNotMatch(fn, /navigator\.share/, '存圖片不再叫分享選單，避免和傳到 LINE 一樣');
    assert.match(fn, /downloadBlob\(blob, shareCardFileName\(\)\)/);
  });

  test('分享面板只載小預覽、選中的先載；傳出去／存下來的仍是全尺寸', () => {
    assert.match(serverJs, /preview: query\.size === 'preview'/);
    assert.match(serverJs, /'Server-Timing': shareCardServerTiming\(timing\)/);
    assert.match(appJs, /const size = 'preview';/);
    assert.match(appJs, /SHARE_PREVIEW_PARALLEL = 2/);
    assert.match(appJs, /bumpSharePreview\(layout\)/);
    // 分享、存檔、複製圖片都拿全尺寸
    const fullUses = appJs.match(/getShareCardBlob\(shareRt\.layout, 'portrait'\)/g) || [];
    assert.ok(fullUses.length >= 5, `全尺寸用處 ${fullUses.length}`);
    assert.ok(!/getShareCardBlob\(shareRt\.layout, 'preview'\)/.test(appJs), '分享動作不可以拿預覽圖');
    // 瀏覽器備援畫圖也支援預覽尺寸
    assert.match(appJs, /SC\.PREVIEW_PIXELS/);
  });

  test('分享連結換 og:image；API 路由都接上', () => {
    assert.match(serverJs, /query\.verse && !query\.file/);
    assert.match(serverJs, /handleVerseShareLink/);
    for (const route of ['/api/daily-verse/random', '/api/share-card.jpg', '/api/share-card/meta', '/api/pic-card', '/api/admin/share-card']) {
      assert.ok(serverJs.includes(`'${route}'`), route);
    }
    assert.match(serverJs, /verse: withVerseId\(dailyVerse\.verse\)/);
  });

  test('Docker 映像帶 share-card.js 與宋體；Service Worker 快取 share-card.js', () => {
    assert.match(dockerfile, /share-card\.js/);
    assert.match(dockerfile, /Noto\+Serif\+TC/);
    assert.match(swJs, /'\/share-card\.js'/);
  });
});
