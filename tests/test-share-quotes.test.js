/**
 * 選字製作早安圖（選句）：lib/share-quotes.js 的原文核對與擷取、share-card.js 的頁尾字與防出界、
 * 統計的選句欄位，以及 HTTP：POST/GET /api/share-card/quote、q= 畫圖、分享連結 og、後台清單與隱藏。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mdw-share-quotes-'));
const MD_ROOT = path.join(TMP, 'md');
fs.mkdirSync(path.join(MD_ROOT, '經'), { recursive: true });
const FILE = '經/T0235 金剛般若波羅蜜經.md';
const SUTRA = [
  '# 金剛般若波羅蜜經',
  '',
  '姚秦 三藏法師 鳩摩羅什 譯',
  '',
  '如是我聞：一時，佛在舍衛國祇樹給孤獨園，與大比丘眾千二百五十人俱。',
  '',
  '佛告**須菩提**：「凡所有相，皆是虛妄。若見諸相非相，則見如來。」[^1]',
  '',
  '「是故須菩提！諸菩薩摩訶薩應如是生清淨心，不應住色生心，不應住聲香味觸法生心，應無所住而生其心。」',
  '',
  '一切有為法，',
  '如夢幻泡影，如露亦如電，應作如是觀。',
  '',
  '[^1]: 註腳內容。'
].join('\n');
fs.writeFileSync(path.join(MD_ROOT, FILE), SUTRA);
process.env.MD_ROOT = MD_ROOT;
process.env.LOG_DIR = path.join(TMP, 'logs');
process.env.SCRYPT_LN = process.env.SCRYPT_LN || '10';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const sq = require('../lib/share-quotes');
const ShareCard = require('../share-card.js');
const shareStats = require('../lib/share-stats');

describe('lib/share-quotes：原文核對與擷取', () => {
  test('卡片文字取自原檔：去掉 Markdown 記號、引號與註腳，帶上句末標點', () => {
    const r = sq.extractQuote(SUTRA, '凡所有相，皆是虛妄。若見諸相非相，則見如來', 7);
    assert.deepEqual(r, { ok: true, text: '凡所有相，皆是虛妄。若見諸相非相，則見如來。', line: 7 });
    const b = sq.extractQuote(SUTRA, '佛告須菩提', 7);
    assert.equal(b.text, '佛告須菩提：');
  });

  test('標點、空白不同也對得上；簡體選字對回繁體原文', () => {
    assert.equal(sq.extractQuote(SUTRA, '凡所有相 皆是虛妄', 7).text, '凡所有相，皆是虛妄。');
    assert.equal(sq.extractQuote(SUTRA, '应无所住而生其心', 9).text, '應無所住而生其心。');
  });

  test('跨行選取合併成一段；行號錯了也會找全文並回報實際行號', () => {
    const r = sq.extractQuote(SUTRA, '一切有為法，\n如夢幻泡影', 11);
    assert.equal(r.text, '一切有為法，如夢幻泡影，');
    assert.equal(sq.extractQuote(SUTRA, '應作如是觀', 1).line, 12);
  });

  test('原文沒有的字拒絕；夾帶的外文字不會出現在卡片上', () => {
    assert.equal(sq.extractQuote(SUTRA, '我是假經文', 7).code, 'NOT_IN_SOURCE');
    const r = sq.extractQuote(SUTRA, '凡所有相BUY NOW皆是虛妄', 7);
    if (r.ok) assert.ok(!/BUY|NOW/.test(r.text));
  });

  test('長度：超過上限、太短、空白都拒絕', () => {
    const long = '舍利子是諸法空相不生不滅不垢不淨不增不減'.repeat(4);
    assert.equal(sq.extractQuote(long, long, 1).code, 'TOO_LONG');
    assert.equal(sq.extractQuote(SUTRA, '佛', 7).ok, false);
    assert.equal(sq.extractQuote(SUTRA, '   ', 7).code, 'EMPTY');
    assert.equal(sq.extractQuote(SUTRA, 'x'.repeat(sq.MAX_INPUT_CHARS + 1), 7).code, 'TOO_LONG');
  });

  test('出處名稱去掉經號與副檔名', () => {
    assert.equal(sq.sourceTitle(FILE), '金剛般若波羅蜜經');
    assert.equal(sq.sourceTitle('X/X1234 楞嚴經集註.md'), '楞嚴經集註');
    assert.equal(sq.sourceTitle('80-01.md'), '80-01');
    assert.equal(sq.sourceTitle('dict:佛光/佛光大辭典.md'), '佛光大辭典');
  });
});

describe('share-card.js：頁尾字與防出界', () => {
  test('label 只收認得的字', () => {
    assert.equal(ShareCard.normalizeLabel('經文選句'), '經文選句');
    assert.equal(ShareCard.normalizeLabel('<script>'), '每日經句');
    assert.equal(ShareCard.normalizeLabel(), '每日經句');
  });

  test('fitText 縮到最小還放不下時截斷補「…」，行數與高度都在框內', () => {
    const text = '若人欲了知三世一切佛應觀法界性一切唯心造'.repeat(6);
    const r = ShareCard.fitText(text, { boxW: 400, boxH: 200, maxSize: 40, minSize: 30, advance: 1.1, lead: 1.6, maxLines: 4 });
    const h = r.size + (r.lines.length - 1) * r.size * 1.6;
    assert.ok(h <= 200, `height ${h}`);
    assert.ok(r.lines.length <= 4);
    assert.ok(r.lines[r.lines.length - 1].endsWith('…'));
  });
});

describe('lib/share-stats：選句欄位', () => {
  test('quote 取代 verse；分享出去才進選句排行，所有事件都算 qev', () => {
    const f = shareStats.sanitizeShareFields({ ev: 'line', verse: '0123456789', quote: 'abcdef0123' });
    assert.deepEqual(f, { ev: 'line', quote: 'abcdef0123' });
    const keys = shareStats.shareKeysOf({ tag: 'ShareCard', share: { ev: 'line', quote: 'abcdef0123', layout: 'A' } });
    assert.ok(keys.includes('qev:line') && keys.includes('quote:abcdef0123') && keys.includes('ev:line'));
    const openKeys = shareStats.shareKeysOf({ tag: 'ShareCard', share: { ev: 'open', quote: 'abcdef0123' } });
    assert.deepEqual(openKeys.sort(), ['ev:open', 'qev:open']);
    const sum = shareStats.summarizeShareMap({ 'ev:line': 3, 'qev:line': 2, 'qev:open': 4, 'quote:abcdef0123': 2 });
    assert.equal(sum.quoteSends, 2);
    assert.equal(sum.quoteEvents.open, 4);
    assert.deepEqual(sum.quotes, [{ id: 'abcdef0123', count: 2 }]);
    assert.equal(sum.sends, 3);
  });
});

describe('HTTP：選句建立、畫圖、分享連結、後台', () => {
  let srv, baseUrl = '', db;

  function request(pathName, { method = 'GET', body, headers = {}, cookie } = {}) {
    require('../lib/auth.js').apiRateLimits.clear();
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : JSON.stringify(body);
      const h = Object.assign({ Connection: 'close' }, headers);
      if (data !== null && !h['Content-Type']) h['Content-Type'] = 'application/json';
      if (data !== null) h['Content-Length'] = Buffer.byteLength(data);
      if (method !== 'GET' && !('Origin' in h)) h.Origin = baseUrl;
      if (cookie) h.Cookie = cookie;
      const req = http.request(`${baseUrl}${pathName}`, { method, agent: false, headers: h }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          let json = null;
          try { json = JSON.parse(buf.toString('utf8')); } catch (_) {}
          resolve({ status: res.statusCode, headers: res.headers, body: buf.toString('utf8'), json, raw: buf });
        });
      });
      req.on('error', reject);
      if (data !== null) req.write(data);
      req.end();
    });
  }
  const cookieOf = res => {
    const c = (res.headers['set-cookie'] || []).find(v => /^(?:__Host-)?mdw_sid=[^;]+/.test(v) && !/Max-Age=0/.test(v));
    return c ? c.split(';')[0] : null;
  };
  async function login(email, password, role = 'user') {
    if (!db.getUserByEmail(email)) {
      db.createUser({ email, emailVerifiedAt: Date.now(), displayName: email.split('@')[0],
        passwordHash: await require('../lib/password.js').hashPassword(password), role });
    }
    const r = await request('/api/auth/login', { method: 'POST', body: { identifier: email, password } });
    assert.equal(r.status, 200, r.body);
    return cookieOf(r);
  }
  const create = (cookie, text, line = 7, p = FILE, headers) =>
    request('/api/share-card/quote', { method: 'POST', body: { path: p, line, text }, cookie, headers });

  let reader, admin, quoteId;

  before(async () => {
    srv = require('../server.js');
    db = require('../lib/db.js');
    await new Promise(r => srv.server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${srv.server.address().port}`;
      r();
    }));
    reader = await login('reader@example.org', 'reader-pass-1');
    admin = await login('boss@example.org', 'boss-password', 'admin');
  });

  after(async () => {
    for (const fn of ['resetTreeWatcher', 'resetDictWatcher', 'resetConfigWatcher']) if (typeof srv[fn] === 'function') srv[fn]();
    await srv.terminateWorkerPools();
    if (typeof srv.server.closeAllConnections === 'function') srv.server.closeAllConnections();
    await new Promise(r => srv.server.close(r));
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  test('沒登入回 401；跨站請求回 403', async () => {
    assert.equal((await create(null, '凡所有相，皆是虛妄')).status, 401);
    assert.equal((await create(reader, '凡所有相，皆是虛妄', 7, FILE, { Origin: 'https://evil.example' })).status, 403);
  });

  test('登入後建立選句：文字取自原檔；同一段重按拿回同一個代號', async () => {
    const r = await create(reader, '凡所有相，皆是虛妄');
    assert.equal(r.status, 200, r.body);
    assert.equal(r.json.quote.text, '凡所有相，皆是虛妄。');
    assert.equal(r.json.quote.source, '金剛般若波羅蜜經');
    assert.equal(r.json.quote.line, 7);
    assert.match(r.json.quote.id, /^[0-9a-f]{10}$/);
    quoteId = r.json.quote.id;
    const again = await create(reader, '凡所有相 皆是虛妄。');
    assert.equal(again.json.quote.id, quoteId);
    assert.equal(again.json.reused, true);
  });

  test('原文沒有的字、路徑跳脫、不存在的檔案都拒絕', async () => {
    assert.equal((await create(reader, '這是假的經文')).json.code, 'NOT_IN_SOURCE');
    assert.equal((await create(reader, '凡所有相', 7, '../secret.md')).status, 404);
    assert.equal((await create(reader, '凡所有相', 7, '經/不存在.md')).status, 404);
  });

  test('公開讀取選句；q= 畫圖與 meta；亂猜的代號 404', async () => {
    const g = await request(`/api/share-card/quote?id=${quoteId}`);
    assert.equal(g.status, 200);
    assert.equal(g.json.quote.path, FILE);
    const meta = await request(`/api/share-card/meta?q=${quoteId}&d=2026-11-02`);
    assert.equal(meta.status, 200);
    assert.equal(meta.json.label, '經文選句');
    assert.equal(meta.json.verse.text, '凡所有相，皆是虛妄。');
    assert.equal((await request('/api/share-card/meta?q=0000000000')).status, 404);
    const img = await request(`/api/share-card.jpg?q=${quoteId}&layout=A&size=og&d=2026-11-02`);
    assert.ok(img.status === 200 || img.status === 503, String(img.status));
    if (img.status === 200) assert.equal(img.headers['content-type'], 'image/jpeg');
    const bad = await request('/api/share-card.jpg?q=ffffffffff&layout=A');
    assert.ok(bad.status === 404 || bad.status === 503);
  });

  test('分享連結：og 換成選句的早安圖；網址不帶文字', async () => {
    const r = await request(`/?file=${encodeURIComponent(FILE)}&line=7&quote=${quoteId}&d=2026-11-02&l=N`);
    assert.equal(r.status, 200);
    assert.ok(r.body.includes(`/api/share-card.jpg?q=${quoteId}&amp;layout=N&amp;size=og`), 'og:image uses q=');
    assert.ok(r.body.includes('經文選句'));
  });

  test('分享事件帶選句代號', async () => {
    const r = await request('/api/share-card/event', { method: 'POST', body: { ev: 'copyLink', quote: quoteId, layout: 'B', d: '2026-11-02' } });
    assert.equal(r.status, 200);
    const { systemLogBuffer } = require('../lib/logger.js');
    const e = systemLogBuffer.filter(x => x.tag === 'ShareCard' && x.share && x.share.ev === 'copyLink').pop();
    assert.equal(e.share.quote, quoteId);
    assert.equal(e.share.verse, undefined);
  });

  test('早安圖 QR：meta 給短網址；qr=1 的直式圖 1620×2025', async () => {
    const meta = await request(`/api/share-card/meta?q=${quoteId}&d=2026-11-02&layout=N`);
    assert.equal(meta.status, 200);
    assert.equal(meta.json.qrUrl, `${baseUrl.toUpperCase()}/Q${quoteId.slice(0, 7).toUpperCase()}N`);
    const img = await request(`/api/share-card.jpg?q=${quoteId}&layout=N&size=portrait&d=2026-11-02&qr=1`);
    assert.ok(img.status === 200 || img.status === 503, String(img.status));
  });

  test('早安圖 QR 短網址：選句轉到原文那一行（大小寫通用），記 qrScan', async () => {
    const code = quoteId.slice(0, 7);
    const r = await request(`/Q${code.toUpperCase()}B`);
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, `/?file=${encodeURIComponent(FILE)}&line=7`);
    assert.equal(r.headers['cache-control'], 'no-store');
    const { systemLogBuffer } = require('../lib/logger.js');
    const e = systemLogBuffer.filter(x => x.tag === 'ShareCard' && x.share && x.share.ev === 'qrScan').pop();
    assert.equal(e.share.quote, quoteId);
    assert.equal(e.share.layout, 'B');
    const lower = await request(`/q${code}`);
    assert.equal(lower.status, 302);
    assert.equal(lower.headers.location, `/?file=${encodeURIComponent(FILE)}&line=7`);
  });

  test('早安圖 QR 短網址：每日經句用出處找到經文行號；找不到的代號回首頁', async () => {
    const home = require('../lib/home');
    const id = home.verseId('一切有為法，如夢幻泡影，如露亦如電，應作如是觀。');
    const r = await request(`/V${id.slice(0, 7).toUpperCase()}A`);
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, `/?file=${encodeURIComponent(FILE)}&line=11`);
    // 預設經句裡找不到原文的（這個測試語料沒有心經）回首頁顯示那一句
    const id2 = home.verseId('色不異空，空不異色；色即是空，空即是色。');
    const r2 = await request(`/V${id2.slice(0, 7)}`);
    assert.equal(r2.status, 302);
    assert.equal(r2.headers.location, `/?verse=${id2}`);
    const none = await request('/V0000000A');
    assert.equal(none.status, 302);
    assert.equal(none.headers.location, '/');
    // 不像短網址的路徑照舊
    assert.notEqual((await request('/VXYZ')).status, 302);
  });

  test('後台清單只給管理員；隱藏後圖片、讀取、預覽都失效，也不能重新建立', async () => {
    assert.equal((await request('/api/admin/share-quotes', { cookie: reader })).status, 401);
    const list = await request('/api/admin/share-quotes', { cookie: admin });
    assert.equal(list.status, 200);
    const item = list.json.items.find(x => x.id === quoteId);
    assert.ok(item);
    assert.equal(item.user, 'reader');
    assert.equal((await request('/api/admin/share-quotes/hide', { method: 'POST', body: { id: quoteId, hidden: true }, cookie: reader })).status, 401);
    assert.equal((await request('/api/admin/share-quotes/hide', { method: 'POST', body: { id: quoteId, hidden: true }, cookie: admin })).status, 200);
    assert.equal((await request(`/api/share-card/quote?id=${quoteId}`)).status, 404);
    assert.equal((await request(`/api/share-card/meta?q=${quoteId}`)).status, 404);
    const link = await request(`/?file=${encodeURIComponent(FILE)}&line=7&quote=${quoteId}`);
    assert.ok(!link.body.includes(`q=${quoteId}`));
    assert.equal((await create(reader, '凡所有相，皆是虛妄')).json.code, 'HIDDEN');
    assert.equal((await request('/api/admin/share-quotes/hide', { method: 'POST', body: { id: quoteId, hidden: false }, cookie: admin })).status, 200);
    assert.equal((await request(`/api/share-card/quote?id=${quoteId}`)).status, 200);
  });

  test('每人每小時配額；管理員不限', async () => {
    const u = db.getUserByEmail('reader@example.org');
    const t = Date.now();
    for (let i = 0; i < sq.QUOTA_PER_HOUR; i++) {
      db.createShareQuote({ id: `aa${String(i).padStart(8, '0')}`, userId: u.id, path: FILE, line: 1, text: 'x', source: '', textKey: `k${i}` });
    }
    assert.ok(db.countShareQuotesSince(u.id, t - 1000) >= sq.QUOTA_PER_HOUR);
    const r = await create(reader, '應無所住而生其心', 9);
    assert.equal(r.status, 429);
    const a = await create(admin, '應無所住而生其心', 9);
    assert.equal(a.status, 200, a.body);
  });
});
