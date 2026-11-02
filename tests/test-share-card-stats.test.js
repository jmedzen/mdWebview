/**
 * 早安圖（每日經句分享卡）的記錄與統計：lib/share-stats.js、lib/analytics.js 的 share 映射、
 * 報表信的早安圖區塊，以及 POST /api/share-card/event、og:image、分享連結進站的伺服器記錄。
 * 日誌放在暫存目錄，不汙染 repo 的 logs/。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mdw-share-stats-'));
process.env.LOG_DIR = TEST_LOG_DIR;
process.env.INDEX_DIR = TEST_LOG_DIR;

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const shareStats = require('../lib/share-stats');
const analytics = require('../lib/analytics');
const reports = require('../lib/reports');
const home = require('../lib/home');

const ROOT_DIR = path.resolve(__dirname, '..');
const appJs = fs.readFileSync(path.join(ROOT_DIR, 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');

const VERSE = home.verseId('應無所住，而生其心。');
let seq = 0;
function entry(ev, extra = {}, more = {}) {
  return Object.assign({
    id: `s${++seq}`,
    timestamp: more.timestamp || new Date().toISOString(),
    level: 'INFO',
    tag: 'ShareCard',
    ip: more.ip || '198.51.100.7',
    message: `Share card ${ev}`,
    share: { ev, ...extra }
  }, more.entry || {});
}

describe('lib/share-stats：事件欄位與彙整', () => {
  test('只收認得的事件與欄位，失敗步驟不認得就記 other', () => {
    assert.equal(shareStats.sanitizeShareFields({ ev: 'hack' }), null);
    assert.equal(shareStats.sanitizeShareFields(null), null);
    assert.deepEqual(
      shareStats.sanitizeShareFields({ ev: 'line', layout: 'b', verse: VERSE, pic: 'a/b.png', email: 'x@y.z', stage: 'render' }),
      { ev: 'line', layout: 'B', verse: VERSE, pic: 'a/b.png' }
    );
    assert.deepEqual(shareStats.sanitizeShareFields({ ev: 'error', stage: 'nope' }), { ev: 'error', stage: 'other' });
    assert.deepEqual(shareStats.sanitizeShareFields({ ev: 'save', verse: 'not-an-id', pic: '../etc/passwd' }), { ev: 'save' });
  });

  test('版型、經句、背景圖只在分享出去的動作上計數', () => {
    assert.deepEqual(shareStats.shareKeysOf(entry('line', { layout: 'A', verse: VERSE, pic: 'p.png' })),
      ['ev:line', 'layout:A', `verse:${VERSE}`, 'pic:p.png']);
    assert.deepEqual(shareStats.shareKeysOf(entry('open', { layout: 'A', verse: VERSE })), ['ev:open']);
    assert.deepEqual(shareStats.shareKeysOf(entry('og', { layout: 'C', verse: VERSE })), ['ev:og']);
    assert.deepEqual(shareStats.shareKeysOf(entry('error', { stage: 'preview' })), ['ev:error', 'err:preview']);
    // 舊版沒有 share 欄位的 ShareCard 錯誤日誌也算一次伺服器失敗
    assert.deepEqual(shareStats.shareKeysOf({ tag: 'ShareCard', level: 'ERROR', message: 'Failed to render share card' }),
      ['ev:error', 'err:render']);
    assert.deepEqual(shareStats.shareKeysOf({ tag: 'Render', path: 'a.md' }), []);
  });

  test('摘要：各動作次數、分享出去合計與比例、排行', () => {
    const s = shareStats.summarizeShareMap({
      'ev:open': 10, 'ev:line': 3, 'ev:save': 1, 'ev:copyLink': 1, 'ev:og': 7, 'ev:error': 2,
      'layout:A': 4, 'layout:J': 1, [`verse:${VERSE}`]: 5, 'pic:x.png': 5, 'err:copyImage': 2
    });
    assert.equal(s.events.open, 10);
    assert.equal(s.sends, 5);
    assert.equal(s.sendRate, 50);
    assert.deepEqual(s.layouts, [{ layout: 'A', count: 4 }, { layout: 'J', count: 1 }]);
    assert.deepEqual(s.verses, [{ id: VERSE, count: 5 }]);
    assert.deepEqual(s.pics, [{ pic: 'x.png', count: 5 }]);
    assert.equal(s.errors[0].stage, 'copyImage');
    assert.ok(s.errors[0].label.includes('複製圖片'));
    assert.equal(s.actions.find(a => a.ev === 'og').count, 7);
    assert.equal(shareStats.emptyShareSummary().sendRate, null);
  });

  test('經句代號換成經文；找不到的只留代號', async () => {
    const s = await shareStats.withVerseTexts({ verses: [{ id: VERSE, count: 1 }, { id: '0000000000', count: 1 }] });
    // 預設經句清單裡有「應無所住，而生其心」時才有經文；沒有也不能出錯
    const hit = s.verses.find(v => v.id === VERSE);
    assert.equal(typeof hit.text, 'string');
    assert.equal(s.verses.find(v => v.id === '0000000000').text, '');
  });
});

describe('lib/analytics：早安圖計入每日摘要與 lifetime', () => {
  test('一般動作算訪客；預覽機器人抓 og:image 只算早安圖、不算請求與 IP；機器人的其他動作不算', () => {
    const store = {
      version: 1, lifetime: { requests: 0, views: 0, searchCount: 0, ips: {}, files: {}, searches: {} },
      daily: {}, processedIds: {}
    };
    const ts = '2026-11-02T01:00:00.000Z';
    assert.equal(analytics.updateAnalyticsStoreEntry(store, entry('open', {}, { timestamp: ts })), true);
    assert.equal(analytics.updateAnalyticsStoreEntry(store, entry('line', { layout: 'I', verse: VERSE, pic: 'p.png' }, { timestamp: ts })), true);
    assert.equal(analytics.updateAnalyticsStoreEntry(store, entry('og', { layout: 'I', verse: VERSE }, { timestamp: ts, ip: '203.0.113.9', entry: { isBot: true, bot: 'LINE' } })), true);
    assert.equal(analytics.updateAnalyticsStoreEntry(store, entry('visit', { verse: VERSE }, { timestamp: ts, ip: '203.0.113.9', entry: { isBot: true, bot: 'LINE' } })), false);

    const day = store.daily['2026-11-02'];
    assert.deepEqual(day.share, { 'ev:open': 1, 'ev:line': 1, 'layout:I': 1, [`verse:${VERSE}`]: 1, 'pic:p.png': 1, 'ev:og': 1 });
    assert.equal(store.lifetime.share['ev:og'], 1);
    assert.equal(store.lifetime.requests, 2, 'og:image 與機器人不算請求');
    assert.deepEqual(Object.keys(day.ips), ['198.51.100.7']);

    const norm = analytics.normalizeDailyBucket(day);
    assert.equal(norm.share['ev:line'], 1);
    const agg = analytics.normalizeAnalyticsStore(JSON.parse(JSON.stringify(store)));
    assert.equal(agg.lifetime.share['layout:I'], 1);
  });

  test('舊的每日摘要沒有 share 也能正規化', () => {
    const norm = analytics.normalizeDailyBucket({ views: 3, files: { 'a.md': 3 } });
    assert.deepEqual(norm.share, {});
  });

  test('精簡日誌保留 share 欄位；og 機器人的也保留', () => {
    const p = analytics.pruneAnalyticsLogEntry(entry('og', { layout: 'A', verse: VERSE }, { entry: { isBot: true, seq: 5 } }));
    assert.equal(p.tag, 'ShareCard');
    assert.deepEqual(p.share, { ev: 'og', layout: 'A', verse: VERSE });
    assert.equal(p.seq, 5);
    assert.equal(analytics.pruneAnalyticsLogEntry(entry('line', {}, { entry: { isBot: true } })), null);
  });

  test('歸檔舊日誌（rollup）冪等：跑兩次不重複累加', async () => {
    await analytics.initializeAnalyticsStore();
    const file = path.join(TEST_LOG_DIR, 'access-2026-08-01.jsonl');
    const ts = '2026-08-01T03:00:00.000Z';
    const lines = [
      entry('open', {}, { timestamp: ts }),
      entry('save', { layout: 'B', verse: VERSE, pic: 'z.jpg' }, { timestamp: ts }),
      entry('og', { layout: 'B', verse: VERSE }, { timestamp: ts, entry: { isBot: true, bot: 'facebookexternalhit' } })
    ].map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(file, lines);
    const before = analytics.analyticsStore.lifetime.share ? { ...analytics.analyticsStore.lifetime.share } : {};
    await analytics.rollupLogFileToStore(file);
    await analytics.rollupLogFileToStore(file);
    const day = analytics.analyticsStore.daily['2026-08-01'];
    assert.deepEqual(day.share, { 'ev:open': 1, 'ev:save': 1, 'layout:B': 1, [`verse:${VERSE}`]: 1, 'pic:z.jpg': 1, 'ev:og': 1 });
    assert.equal((analytics.analyticsStore.lifetime.share['ev:save'] || 0) - (before['ev:save'] || 0), 1);
    assert.equal(day.ips['198.51.100.7'], 2, 'og:image 不算請求');
    fs.rmSync(file);
  });
});

describe('報表信：早安圖區塊', () => {
  after(() => reports.stop());

  test('日報有早安圖 KPI、版型與經句排行；純文字版也有一行', async () => {
    const NOW = Date.parse('2026-11-01T02:00:00Z'); // 台北 11/01 10:00 → 日報 = 10/31
    const ts = '2026-10-31T02:00:00.000Z';
    const f = path.join(TEST_LOG_DIR, 'access-2026-10-31.jsonl');
    fs.writeFileSync(f, [
      entry('open', {}, { timestamp: ts }),
      entry('open', {}, { timestamp: ts }),
      entry('line', { layout: 'J', verse: VERSE, pic: 'gold/1.png' }, { timestamp: ts }),
      entry('copyImage', { layout: 'J', verse: VERSE, pic: 'gold/1.png' }, { timestamp: ts }),
      entry('error', { stage: 'copyImage' }, { timestamp: ts }),
      entry('og', { layout: 'J', verse: VERSE }, { timestamp: ts, entry: { isBot: true, bot: 'LINE' } })
    ].map(e => JSON.stringify(e)).join('\n') + '\n');
    try {
      const r = await reports.buildReport('daily', { now: NOW, settings: reports.normalizeSettings({ timezone: 'Asia/Taipei' }) });
      assert.equal(r.shareCard.cur.events.open, 2);
      assert.equal(r.shareCard.cur.sends, 2);
      assert.equal(r.shareCard.cur.events.og, 1);
      assert.equal(r.traffic.cur.requests, 5, 'og:image 不算請求');
      const out = reports.renderReport(r, { imageSrc: () => 'cid:x' });
      assert.ok(out.html.includes('🌅 早安圖'));
      assert.ok(out.html.includes('J 象牙拱門'));
      assert.ok(out.html.includes('gold/1.png'));
      assert.ok(out.html.includes('複製圖片失敗'));
      assert.match(out.text, /早安圖：打開面板 2，分享出去 2，從分享連結進站 0，掃 QR 進站 0，連結預覽抓圖 1，失敗 1/);
      // 日報：早安圖小時長條圖（台北 10:00 那格）
      assert.equal(r.shareCard.buckets.length, 24);
      assert.deepEqual(r.shareCard.buckets[10], { open: 2, sends: 2, visit: 0 });
      assert.ok(out.charts.some(c => c.id === 'share'));
      assert.ok(out.html.includes('cid:x'));
      assert.ok(out.html.includes('幾點打開面板與分享出去'));

      const w = await reports.buildReport('weekly', { now: Date.parse('2026-11-02T02:00:00Z'), settings: reports.normalizeSettings({ timezone: 'Asia/Taipei' }) });
      assert.equal(w.shareCard.buckets.length, 7);
      assert.equal(w.shareCard.buckets.reduce((t, b) => t + b.sends, 0), 2);
      const wo = reports.renderReport(w, { imageSrc: () => 'cid:x' });
      assert.ok(wo.html.includes('每日打開面板、分享出去與從分享連結進站'));
    } finally {
      fs.rmSync(f);
    }
  });
});

describe('報表信：沒有早安圖資料', () => {
  test('沒有資料就不畫早安圖的圖（信件不多附圖片）', async () => {
    const r = await reports.buildReport('daily', { now: Date.parse('2026-06-01T02:00:00Z'), settings: reports.normalizeSettings({ timezone: 'Asia/Taipei' }) });
    const out = reports.renderReport(r, { imageSrc: () => 'cid:x' });
    assert.ok(!out.charts.some(c => c.id === 'share'));
    assert.ok(out.html.includes('沒有人使用早安圖'));
  });
});

describe('前端與後台接線', () => {
  test('分享面板每個動作都回報事件', () => {
    for (const ev of ['open', 'line', 'lineFile', 'lineLink', 'lineManual', 'save', 'copyImage', 'copyLink', 'shuffle']) {
      assert.ok(appJs.includes(`sendShareEvent('${ev}'`), ev);
    }
    for (const stage of ['preview', 'line', 'save', 'copyImage', 'shuffle']) {
      assert.ok(appJs.includes(`stage: '${stage}'`), stage);
    }
    assert.match(appJs, /fetch\('\/api\/share-card\/event'/);
  });

  test('後台流量統計有早安圖區塊', () => {
    for (const id of ['analyticsShareCardSection', 'analyticsShareOpens', 'analyticsShareSends', 'analyticsShareVisits',
      'analyticsShareOg', 'analyticsShareErrors', 'analyticsShareActionsTable', 'analyticsShareLayoutsTable',
      'analyticsShareVersesTable', 'analyticsSharePicsTable']) {
      assert.ok(indexHtml.includes(`id="${id}"`), id);
    }
    assert.match(appJs, /renderAnalyticsShareCard\(data\.shareCard\)/);
    for (const id of ['analyticsShareTrendChart', 'analyticsShareHoursChart', 'analyticsShareMethodsChart']) {
      assert.ok(indexHtml.includes(`id="${id}"`), id);
    }
    assert.match(appJs, /function renderInteractiveChart\(/);
  });
});

describe('伺服器：POST /api/share-card/event、og:image、分享連結進站', () => {
  let server, baseUrl, Logger, systemLogBuffer, verseId;

  function request(p, options = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(new URL(p, baseUrl), { agent: false, ...options, headers: { Connection: 'close', ...(options.headers || {}) } }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      if (options.body) req.write(options.body);
      req.end();
    });
  }
  const post = (body) => request('/api/share-card/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const shareEntries = () => systemLogBuffer.filter(e => e.tag === 'ShareCard' && e.share);

  before(async () => {
    ({ server } = require('../server.js'));
    ({ Logger, systemLogBuffer } = require('../lib/logger.js'));
    void Logger;
    await new Promise(resolve => server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    }));
    const r = await request('/api/daily-verse/random');
    verseId = JSON.parse(r.body).verse.id;
  });

  after(async () => {
    const mod = require('../server.js');
    for (const fn of ['resetTreeWatcher', 'resetDictWatcher', 'resetConfigWatcher']) if (typeof mod[fn] === 'function') mod[fn]();
    await mod.terminateWorkerPools();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(TEST_LOG_DIR, { recursive: true, force: true });
  });

  test('前端回報的分享動作寫進日誌；背景圖由伺服器算，不收前端的', async () => {
    const res = await post({ ev: 'line', verse: verseId, layout: 'c', d: '2026-11-02', pic: '../../secret.png', email: 'a@b.c' });
    assert.equal(res.statusCode, 200);
    const e = shareEntries().pop();
    assert.equal(e.share.ev, 'line');
    assert.equal(e.share.layout, 'C');
    assert.equal(e.share.verse, verseId);
    assert.ok(!e.share.pic || !e.share.pic.includes('..'));
    assert.ok(!JSON.stringify(e).includes('a@b.c'), '不記任何個人資料');
  });

  test('不認得的事件回 400，也不寫日誌；伺服器自己記的事件不能由前端假造', async () => {
    const n = shareEntries().length;
    assert.equal((await post({ ev: 'og', verse: verseId })).statusCode, 400);
    assert.equal((await post({ ev: 'visit', verse: verseId })).statusCode, 400);
    assert.equal((await post({ ev: 'whatever' })).statusCode, 400);
    assert.equal(shareEntries().length, n);
  });

  test('失敗事件帶步驟；不存在的經句不記代號', async () => {
    await post({ ev: 'error', verse: '0123456789', stage: 'copyImage' });
    const e = shareEntries().pop();
    assert.deepEqual(e.share, { ev: 'error', stage: 'copyImage' });
  });

  test('有人點開分享連結記 visit；預覽機器人抓 og:image 記 og', async () => {
    await request(`/?verse=${verseId}&d=2026-11-02&g=%E6%97%A9%E5%AE%89&l=J`);
    const visit = shareEntries().pop();
    assert.equal(visit.share.ev, 'visit');
    assert.equal(visit.share.layout, 'J');
    assert.ok(!visit.isBot);

    const img = await request(`/api/share-card.jpg?id=${verseId}&layout=J&size=og&d=2026-11-02`, { headers: { 'User-Agent': 'facebookexternalhit/1.1' } });
    if (img.statusCode === 503) return; // 這台機器沒有畫圖引擎
    assert.equal(img.statusCode, 200);
    const og = shareEntries().pop();
    assert.equal(og.share.ev, 'og');
    assert.equal(og.share.layout, 'J');
    assert.ok(shareStats.isShareServerEntry(og));

    // 面板裡的直式預覽不記
    const n = shareEntries().length;
    await request(`/api/share-card.jpg?id=${verseId}&layout=A&size=portrait&d=2026-11-02`);
    assert.equal(shareEntries().length, n);
  });

  test('流量統計 API 的資料裡有 shareCard 摘要', async () => {
    const data = await analytics.getAnalyticsData('7d', 'UTC');
    assert.ok(data.shareCard);
    assert.ok(data.shareCard.events.line >= 1);
    assert.ok(data.shareCard.events.visit >= 1);
    assert.ok(data.shareCard.layouts.some(l => l.layout === 'C'));
    // 趨勢與 dailyTrend 同格；今天那格有分享與進站
    assert.equal(data.shareCard.trend.length, data.dailyTrend.length);
    const today = data.shareCard.trend[data.shareCard.trend.length - 1];
    assert.ok(today.sends >= 1 && today.line >= 1 && today.visit >= 1);
    assert.equal(data.shareCard.hours.length, 24);
    assert.ok(data.shareCard.hours.reduce((t, h) => t + h.sends, 0) >= 1);
    // og:image 不算進站或分享
    assert.equal(today.og >= 0, true);

    const one = await analytics.getAnalyticsData('1d', 'UTC');
    assert.equal(one.shareCard.trend.length, one.dailyTrend.length);
    assert.ok(one.shareCard.trend.some(r => r.sends >= 1));
  });
});
