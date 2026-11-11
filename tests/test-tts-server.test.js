/**
 * 朗讀（TTS）後端整合測試：用 node:http 起一個假的 audio.cpp，照實測的回應格式回覆
 * （正常 WAV、500 JSON、503 server_busy、200 但內容不是音訊、時長離譜），
 * 驗證代理、快取、佇列、限額、Range 與後台設定。
 *
 * 測試一律關掉 ffmpeg（TTS_FFMPEG=off）：快取存 WAV，CI 不需要安裝 ffmpeg。
 */
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mdw-tts-'));
const VAULT = path.join(TMP, 'md');
fs.mkdirSync(path.join(VAULT, 'sub'), { recursive: true });
process.env.CONFIG_PATH = path.join(TMP, 'config.json');
process.env.MD_ROOT = VAULT;
process.env.TTS_CACHE_DIR = path.join(TMP, 'tts-cache');
process.env.TTS_LEXICON_PATH = path.join(TMP, 'tts-lexicon.txt');
process.env.TTS_FFMPEG = 'off';
delete process.env.TTS_BASE_URL; delete process.env.TTS_MODEL; delete process.env.TTS_CACHE_MB;

const DOC = [
  '# 測試經',
  '如是我聞：',
  '一時，佛在舍衛國祇樹給孤獨園，與大比丘眾千二百五十人俱。爾時，世尊食時，著衣持鉢，入舍衛大城乞食。',
  '（一）',
  '般若波羅蜜多甚深微妙，諸菩薩摩訶薩應如是學。',
  '爾時世尊而說偈言：\n一切有為法　如夢幻泡影\n如露亦如電　應作如是觀'
].join('\n\n') + '\n';
fs.writeFileSync(path.join(VAULT, 'sub', 'a.md'), DOC);

const auth = require('../lib/auth.js');
const accountsDb = require('../lib/db.js');
const store = require('../lib/tts-store.js');
const lexicon = require('../lib/tts-lexicon.js');

// ── 假的 audio.cpp ────────────────────────────────────────────────────
const fake = { mode: 'ok', delayMs: 0, speech: [], paths: [], server: null, url: '' };

function makeWav(ms) {
  const rate = 8000; const n = Math.round(rate * ms / 1000); const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(8000 * Math.sin(i / 5)), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

function startFake() {
  fake.server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    fake.paths.push(`${req.method} ${u.pathname}`);
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (u.pathname === '/health') return json(200, { status: 'ok', backend: 'metal', models: 2, version: 'dev', git: '04a58777', git_date: '2026-11-06' });
    if (u.pathname === '/v1/models') return json(200, { object: 'list', data: [
      { id: 'drama3', family: 'fish_drama3', task: 'tts', mode: 'offline', loaded: true, path: '/secret/models/drama3.gguf', params: [{ name: 'seed', type: 'int' }] },
      { id: 'qwen3-asr', family: 'qwen3_asr', task: 'asr', mode: 'offline', loaded: true, path: '/secret/models/asr.gguf' }] });
    if (u.pathname === '/v1/audio/voices') return json(200, { voices: ['demo_1_man', 'demo_3_woman'] });
    if (u.pathname === '/v1/audio/speech' && req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        fake.speech.push(body);
        setTimeout(() => {
          if (fake.mode === '500') return json(500, { error: { message: 'model exploded', type: 'server_error' } });
          if (fake.mode === 'busy') return json(503, { error: { message: "model 'drama3' is busy", type: 'server_busy' } });
          if (fake.mode === 'json200') { res.writeHead(200, { 'Content-Type': 'audio/wav' }); return res.end(JSON.stringify({ error: { message: 'oops' } })); }
          if (fake.mode === 'html200') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>error</html>'); }
          const chars = Array.from(String(body.input)).length;
          const wav = makeWav(fake.mode === 'tooshort' ? 10 : chars * 250);
          res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length, 'x-audiocpp-audio-duration-ms': String(chars * 250) });
          res.end(wav);
        }, fake.delayMs);
      });
      return;
    }
    json(404, { error: { message: 'unknown endpoint', type: 'not_found' } });
  });
  return new Promise((r) => fake.server.listen(0, '127.0.0.1', () => { fake.url = `http://127.0.0.1:${fake.server.address().port}`; r(); }));
}

// ── 測試用的請求工具 ──────────────────────────────────────────────────
let baseUrl = ''; let srv; let tts; let config; let saveConfig;

function request(p, options = {}) {
  auth.apiRateLimits.clear();
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(p, baseUrl), { agent: false, ...options, headers: { Connection: 'close', ...(options.headers || {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks); let json = null;
        try { json = JSON.parse(body.toString('utf8')); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, body, json });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}
const post = (p, obj, headers) => request(p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: JSON.stringify(obj) });

function session(token, role) {
  const username = `tts-${role}-${token}`;
  const user = accountsDb.getUserByUsername(username) || accountsDb.createUser({ username, passwordHash: null, role, displayName: username });
  accountsDb.createSession(user.id, token, { ttlMs: 600000, ip: '127.0.0.1', userAgent: 'test' });
  return { 'X-Admin-Token': token };
}

const P = 'sub/a.md';
const baseSettings = () => ({
  enabled: true, baseUrl: fake.url, model: 'drama3', defaultVoice: 'v1', seed: 1234, guestGenerate: true, warmup: false, keepWarm: false,
  voices: [{ id: 'v1', voice: 'demo_3_woman', name: '慧音', tags: ['女聲'], rate: 1, enabled: true },
    { id: 'v2', voice: 'demo_1_man', name: '法音', tags: ['男聲'], rate: 1, enabled: true },
    { id: 'v9', voice: 'hidden_voice', name: '未開放', tags: [], rate: 1, enabled: false }]
});
const sentences = async (voice) => (await request(`/api/tts/doc?chapter=0&path=${encodeURIComponent(P)}${voice ? '&voice=' + voice : ''}`)).json.sentences;
const speak = (ids, extra, headers) => post('/api/tts/speak', Object.assign({ path: P, voice: 'v1', ids, priority: 'now' }, extra || {}), headers);

describe('朗讀（TTS）後端', () => {
  before(async () => {
    await startFake();
    srv = require('../server.js');
    tts = require('../lib/tts.js');
    ({ config, saveConfig } = require('../lib/config.js'));
    config.settings.mdRoot = VAULT;
    require('../lib/config.js').invalidateMdRootMemo();
    await new Promise((r) => srv.server.listen(0, '127.0.0.1', () => { baseUrl = `http://127.0.0.1:${srv.server.address().port}`; r(); }));
  });

  after(async () => {
    srv.resetTreeWatcher(); srv.resetDictWatcher(); srv.resetConfigWatcher();
    tts.stop();
    await srv.terminateWorkerPools();
    if (srv.server.closeAllConnections) srv.server.closeAllConnections();
    await new Promise((r) => srv.server.close(r));
    if (fake.server.closeAllConnections) fake.server.closeAllConnections();
    await new Promise((r) => fake.server.close(r));
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  beforeEach(() => {
    fake.mode = 'ok'; fake.delayMs = 0; fake.speech.length = 0; fake.paths.length = 0;
    config.settings.tts = baseSettings();
    tts._internals.reset();
    tts._internals.setHealth({ ok: true });
    if (store.isAvailable()) store.clear(); // 每個測試從空的快取開始
  });

  describe('停用時', () => {
    test('狀態回 enabled:false，其他路由 404，而且不會建立快取資料夾', async () => {
      config.settings.tts = { enabled: false };
      const s = await request('/api/tts/status');
      assert.deepEqual(s.json, { enabled: false, available: false, voices: [] });
      assert.equal((await request(`/api/tts/doc?path=${encodeURIComponent(P)}`)).status, 404);
      assert.equal((await speak([1])).status, 404);
      assert.equal(fs.existsSync(process.env.TTS_CACHE_DIR), false);
    });
  });

  describe('狀態與資訊外洩', () => {
    test('讀者只看得到音色代號與顯示名，看不到伺服器網址與 audio.cpp 的 voice 名稱', async () => {
      const s = await request('/api/tts/status');
      assert.equal(s.json.enabled, true); assert.equal(s.json.available, true);
      assert.deepEqual(s.json.voices.map((v) => v.id), ['v1', 'v2']);
      const raw = s.body.toString('utf8');
      assert.ok(!raw.includes('127.0.0.1') && !raw.includes('demo_3_woman') && !raw.includes('hidden_voice'));
      assert.equal(s.json.format, 'wav');
    });

    test('匿名的 /api/admin/status 不含 tts 設定', async () => {
      const r = await request('/api/admin/status');
      assert.equal(r.json.settings.tts, undefined);
      assert.ok(!r.body.toString('utf8').includes(fake.url));
    });

    test('快取資料夾不能從靜態路徑讀到', async () => {
      await speak([1]);
      assert.notEqual((await request('/tts-cache/tts.db')).status, 200);
    });
  });

  describe('文件斷句 API', () => {
    test('章節表與句子：含位置、種類、原文，不朗讀單位標成 skip', async () => {
      const d = await request(`/api/tts/doc?path=${encodeURIComponent(P)}`);
      assert.equal(d.status, 200);
      assert.equal(d.json.chapters.length, 1);
      const ss = await sentences('v1');
      assert.deepEqual(ss.map((x) => x.kind), ['heading', 'intro', 'sent', 'sent', 'skip', 'sent', 'intro', 'verse']);
      assert.equal(ss[2].line, 5); assert.equal(ss[2].a, 0);
      assert.equal(ss[7].line, 12); assert.equal(ss[7].endLine, 13);
      assert.ok(ss.filter((x) => x.kind !== 'skip').every((x) => /^[0-9a-f]{64}$/.test(x.sha) && x.cached === false));
      assert.equal(ss[4].sha, undefined);
    });

    test('line 參數找到含該行的章；不存在的檔與庫外路徑 404', async () => {
      const d = await request(`/api/tts/doc?line=9&path=${encodeURIComponent(P)}`);
      assert.equal(d.json.chapter.i, 0);
      for (const bad of ['nope.md', '../../etc/passwd', '/etc/passwd', '.git/config', 'sub/a.md%00.txt']) {
        assert.equal((await request(`/api/tts/doc?path=${bad}`)).status, 404, bad);
      }
    });

    test('不同音色的 sha 不同；同音色穩定', async () => {
      const a = await sentences('v1'); const b = await sentences('v2'); const c = await sentences('v1');
      assert.notEqual(a[2].sha, b[2].sha);
      assert.equal(a[2].sha, c[2].sha);
    });
  });

  describe('生成與快取', () => {
    test('第一次生成：送給 audio.cpp 的是白名單的 voice、固定 seed、原檔的文字；第二次直接命中快取', async () => {
      const r = await speak([2]);
      assert.equal(r.status, 200);
      assert.equal(r.json.items[0].state, 'ready');
      assert.match(r.json.items[0].url, /^\/api\/tts\/audio\/[0-9a-f]{64}$/);
      assert.equal(fake.speech.length, 1);
      assert.deepEqual(Object.keys(fake.speech[0]).sort(), ['busy_timeout_ms', 'input', 'model', 'seed', 'voice']);
      assert.equal(fake.speech[0].model, 'drama3'); assert.equal(fake.speech[0].voice, 'demo_3_woman'); assert.equal(fake.speech[0].seed, 1234);
      assert.equal(fake.speech[0].input, '一時，佛在舍衛國祇樹給孤獨園，與大比丘眾千二百五十人俱。');
      const again = await speak([2]);
      assert.equal(again.json.items[0].state, 'ready');
      assert.equal(fake.speech.length, 1, '已快取的句子不再送給 audio.cpp');
      assert.equal((await sentences('v1'))[2].cached, true);
    });

    test('single-flight：同一句同時被要求兩次，只生成一次', async () => {
      fake.delayMs = 150;
      const [a, b] = await Promise.all([speak([3]), speak([3])]);
      assert.equal(a.json.items[0].state, 'ready'); assert.equal(b.json.items[0].state, 'ready');
      assert.equal(fake.speech.length, 1);
    });

    test('不朗讀單位回 skip、超出範圍回 gone、一次最多 8 句', async () => {
      const r = await speak([4, 999, -1, 'abc']);
      assert.deepEqual(r.json.items.map((x) => x.state), ['skip', 'gone', 'gone', 'gone']);
      const many = await speak([0, 1, 2, 3, 5, 6, 7, 0, 1, 2]);
      assert.equal(many.json.items.length, 8);
    });

    test('只對外連寫死的四條路徑，模型管理端點完全不碰', async () => {
      await speak([1]); await tts.checkHealth();
      const allowed = new Set(['GET /health', 'GET /v1/models', 'GET /v1/audio/voices', 'POST /v1/audio/speech']);
      assert.ok(fake.paths.length > 0 && fake.paths.every((p) => allowed.has(p)), fake.paths.join(', '));
    });
  });

  describe('錯誤內容絕不進快取', () => {
    const before = () => store.usage().blobs;
    for (const mode of ['500', 'json200', 'html200', 'tooshort', 'busy']) {
      test(`audio.cpp 回 ${mode}：回報 failed，快取沒有新增`, async () => {
        const n = before();
        fake.mode = mode;
        const r = await speak([5], { voice: 'v2' });
        assert.equal(r.json.items[0].state, 'failed');
        assert.ok(r.json.items[0].error);
        assert.equal(before(), n);
        assert.equal((await request(r.json.items[0].sha ? `/api/tts/audio/${r.json.items[0].sha}` : '/api/tts/audio/x')).status, 404);
        if (mode === '500' || mode === 'busy') assert.equal(fake.speech.length, 2, '5xx 與忙碌重試一次');
      });
    }

    test('失敗後恢復正常：可以重新生成', async () => {
      fake.mode = '500';
      assert.equal((await speak([5], { voice: 'v2' })).json.items[0].state, 'failed');
      fake.mode = 'ok'; tts._internals.failed.clear();
      assert.equal((await speak([5], { voice: 'v2' })).json.items[0].state, 'ready');
    });
  });

  describe('不接受任意文字、網址或 voice 路徑', () => {
    test('voice 只認白名單代號；未開放的音色、網址、路徑一律 400', async () => {
      for (const v of ['v9', 'demo_3_woman', 'http://evil.example/x.wav', '../../etc/passwd', '']) {
        const r = await speak([1], { voice: v || undefined });
        if (v === '') { assert.equal(r.status, 200); continue; } // 沒給就用預設音色
        assert.equal(r.status, 400, v); assert.equal(r.json.code, 'UNKNOWN_VOICE');
      }
      assert.ok(fake.speech.every((b) => b.voice === 'demo_3_woman'));
    });

    test('前端傳來的 text、voice_ref、input 都被忽略：朗讀的文字只來自原檔', async () => {
      await speak([6], { text: '任意文字', input: '任意文字', voice_ref: '/etc/passwd', model: 'other', seed: 1 });
      assert.equal(fake.speech.length, 1);
      assert.equal(fake.speech[0].input, '爾時世尊而說偈言：');
      assert.equal(fake.speech[0].model, 'drama3'); assert.equal(fake.speech[0].seed, 1234);
      assert.equal(fake.speech[0].voice_ref, undefined);
    });

    test('跨站的 POST 被拒絕', async () => {
      const r = await speak([1], {}, { Origin: 'https://evil.example' });
      assert.equal(r.status, 403);
    });
  });

  describe('音檔傳輸', () => {
    let url; let size;
    beforeEach(async () => {
      url = (await speak([2])).json.items[0].url;
      size = Number((await request(url)).headers['content-length']);
    });

    test('200：強 ETag、immutable、Accept-Ranges、正確的 Content-Type', async () => {
      const r = await request(url);
      assert.equal(r.status, 200);
      assert.equal(r.headers['content-type'], 'audio/wav');
      assert.equal(r.headers['cache-control'], 'public, max-age=31536000, immutable');
      assert.equal(r.headers['accept-ranges'], 'bytes');
      assert.match(r.headers.etag, /^"[0-9a-f]{32}"$/);
      assert.equal(r.body.toString('latin1', 0, 4), 'RIFF');
      assert.equal(r.body.length, size);
    });

    test('Range：206 只回要求的位元組；尾端與開放範圍', async () => {
      const a = await request(url, { headers: { Range: 'bytes=10-19' } });
      assert.equal(a.status, 206); assert.equal(a.headers['content-range'], `bytes 10-19/${size}`); assert.equal(a.body.length, 10);
      const b = await request(url, { headers: { Range: 'bytes=-5' } });
      assert.equal(b.status, 206); assert.equal(b.body.length, 5);
      const c = await request(url, { headers: { Range: `bytes=${size - 3}-` } });
      assert.equal(c.status, 206); assert.equal(c.body.length, 3);
    });

    test('超出範圍 416；If-None-Match 304；HEAD 不帶內容', async () => {
      const a = await request(url, { headers: { Range: `bytes=${size}-` } });
      assert.equal(a.status, 416); assert.equal(a.headers['content-range'], `bytes */${size}`);
      const etag = (await request(url)).headers.etag;
      assert.equal((await request(url, { headers: { 'If-None-Match': etag } })).status, 304);
      const h = await request(url, { method: 'HEAD' });
      assert.equal(h.status, 200); assert.equal(h.body.length, 0); assert.equal(Number(h.headers['content-length']), size);
    });

    test('只服務快取裡的檔：不存在的 sha、路徑、非 hex 一律 404', async () => {
      for (const bad of ['0'.repeat(64), '..%2f..%2fconfig.json', 'abc', 'A'.repeat(64), '0'.repeat(64) + '.wav']) {
        assert.equal((await request(`/api/tts/audio/${bad}`)).status, 404, bad);
      }
    });
  });

  describe('權限與限額', () => {
    test('訪客預設不能生成新音檔，但已快取的照常播放；登入者可以生成', async () => {
      await speak([2]); // 先由（允許訪客生成的設定）建好快取
      config.settings.tts = Object.assign(baseSettings(), { guestGenerate: false });
      const st = await request('/api/tts/status');
      assert.equal(st.json.canGenerate, false); assert.equal(st.json.generateBlocked, 'login');
      const r = await speak([2, 5], { voice: 'v1' });
      assert.equal(r.json.items[0].state, 'ready');
      assert.equal(r.json.items[1].state, 'login');
      const n = fake.speech.length;
      const user = session('tok-user-1', 'user');
      const u = await speak([5], {}, user);
      assert.equal(u.json.items[0].state, 'ready');
      assert.equal(fake.speech.length, n + 1);
      assert.equal((await request('/api/tts/status', { headers: user })).json.canGenerate, true);
    });

    test('每小時限額：超過後回 quota，快取命中不計入', async () => {
      config.settings.tts = Object.assign(baseSettings(), { guestGenerate: false, perUserHour: 2, perIpHour: 100 });
      const user = session('tok-user-2', 'user');
      const r = await speak([0, 1, 6], { voice: 'v2' }, user);
      assert.deepEqual(r.json.items.map((x) => x.state), ['ready', 'ready', 'quota']);
      const again = await speak([0, 1], { voice: 'v2' }, user);
      assert.deepEqual(again.json.items.map((x) => x.state), ['ready', 'ready']);
      assert.equal((await request('/api/tts/status', { headers: user })).json.generateBlocked, 'quota');
    });
  });

  describe('服務不可用', () => {
    test('audio.cpp 連不上：未快取的回 unavailable，已快取的照常；狀態 available:false', async () => {
      await speak([2]);
      tts._internals.setHealth({ ok: false, error: 'ECONNREFUSED' });
      const r = await speak([2, 7], { voice: 'v1' });
      assert.equal(r.json.items[0].state, 'ready');
      assert.equal(r.json.items[1].state, 'unavailable');
      const st = await request('/api/tts/status');
      assert.equal(st.json.available, false); assert.equal(st.json.canGenerate, false);
      assert.equal((await request(r.json.items[0].url)).status, 200);
    });

    test('健康檢查：正常時 ok，網址連不上時不可用', async () => {
      assert.equal((await tts.checkHealth()).ok, true);
      config.settings.tts = Object.assign(baseSettings(), { baseUrl: 'http://127.0.0.1:9' });
      assert.equal((await tts.checkHealth()).ok, false);
    });
  });

  describe('選取吸附 API', () => {
    test('只傳位置：伺服器回完整句與延伸旗標', async () => {
      const r = await post('/api/tts/resolve', { path: P, voice: 'v1', start: { line: 5, off: 35 }, end: { line: 5, off: 37 } });
      assert.equal(r.status, 200);
      assert.deepEqual(r.json.sentences.map((x) => x.text), ['爾時，世尊食時，著衣持鉢，入舍衛大城乞食。']);
      const intro = await post('/api/tts/resolve', { path: P, voice: 'v1', start: { line: 3, off: 0 }, end: { line: 3, off: 2 } });
      assert.equal(intro.json.flags.intro, true); assert.equal(intro.json.flags.extended, true);
      assert.equal(intro.json.sentences.length, 2);
    });

    test('exact（只讀我選的）：頭尾殘句是臨時句子，可生成並標為臨時快取', async () => {
      const r = await post('/api/tts/resolve', { path: P, voice: 'v1', exact: true, start: { line: 5, off: 3 }, end: { line: 5, off: 8 } });
      const s0 = r.json.sentences[0];
      assert.equal(s0.temp, true); assert.equal(s0.text, '佛在舍衛國'); assert.match(s0.id, /^x[0-9a-f]{18}$/);
      const g = await speak([s0.id]);
      assert.equal(g.json.items[0].state, 'ready');
      assert.equal(fake.speech[fake.speech.length - 1].input, '佛在舍衛國');
      assert.equal(store.get(g.json.items[0].sha).flags & store.FLAG_TEMP, store.FLAG_TEMP);
      assert.equal((await speak(['x' + '0'.repeat(18)])).json.items[0].state, 'gone');
    });

    test('範圍不合法 400；選到沒有文字的地方回 empty', async () => {
      for (const body of [{ path: P }, { path: P, start: { line: 5, off: 9 }, end: { line: 5, off: 3 } }, { path: P, start: { line: 0, off: 0 }, end: { line: 1, off: 1 } }, { start: { line: 1, off: 0 }, end: { line: 1, off: 2 } }]) {
        assert.equal((await post('/api/tts/resolve', body)).status, 400);
      }
      const e = await post('/api/tts/resolve', { path: P, start: { line: 2, off: 0 }, end: { line: 2, off: 4 } });
      assert.equal(e.json.empty, true);
    });
  });

  describe('快取跟隨文件', () => {
    test('改一句：只有那一句重新生成；搬到新路徑：全部命中', async () => {
      const file = path.join(VAULT, 'sub', 'b.md');
      fs.writeFileSync(file, DOC);
      const ids = [0, 1, 2, 3, 5, 6, 7];
      const sp = (p, list) => post('/api/tts/speak', { path: p, voice: 'v2', ids: list, priority: 'now' });
      await sp('sub/b.md', ids);
      const n0 = fake.speech.length;
      fs.writeFileSync(file, DOC.replace('著衣持鉢', '著衣持缽'));
      const t = Date.now() / 1000 + 5; fs.utimesSync(file, t, t);
      const r = await sp('sub/b.md', ids);
      assert.ok(r.json.items.every((x) => x.state === 'ready'));
      assert.equal(fake.speech.length, n0 + 1);
      assert.equal(fake.speech[fake.speech.length - 1].input, '爾時，世尊食時，著衣持缽，入舍衛大城乞食。');
      fs.mkdirSync(path.join(VAULT, 'moved'), { recursive: true });
      fs.renameSync(file, path.join(VAULT, 'moved', 'c.md'));
      const n1 = fake.speech.length;
      const m = await sp('moved/c.md', ids);
      assert.ok(m.json.items.every((x) => x.state === 'ready'));
      assert.equal(fake.speech.length, n1, '搬移後不需要重新生成');
    });

    test('讀音字典：只有被替換到的句子換 sha', async () => {
      const a = await sentences('v1');
      fs.writeFileSync(process.env.TTS_LEXICON_PATH, '般若｜波惹\n');
      lexicon.resetCache(); tts._internals.docCache.clear();
      const b = await sentences('v1');
      const changed = a.filter((x, i) => x.sha !== b[i].sha).map((x) => x.i);
      assert.deepEqual(changed, [5]);
      await speak([5]);
      assert.equal(fake.speech[fake.speech.length - 1].input, '波惹波羅蜜多甚深微妙，諸菩薩摩訶薩應如是學。');
      fs.rmSync(process.env.TTS_LEXICON_PATH, { force: true });
      lexicon.resetCache(); tts._internals.docCache.clear();
    });
  });

  describe('保溫與音色版本', () => {
    const warmInputs = () => fake.speech.filter((b) => b.input === '南無阿彌陀佛').length;

    test('有人在聽且已閒置：送一句短句，結果不進快取；剛生成過或沒人在聽就不送', async () => {
      config.settings.tts = Object.assign(baseSettings(), { keepWarm: true });
      tts._internals.setClock({ lastGenerationAt: 0, lastReaderActivityAt: Date.now() });
      const n = store.isAvailable() ? store.usage().blobs : 0;
      assert.equal(await tts._internals.keepWarmTick(false), true);
      assert.equal(warmInputs(), 1);
      assert.equal(fake.speech[0].voice, 'demo_3_woman');
      assert.equal(store.usage().blobs, n, '保溫的音檔不進快取');
      assert.equal(tts._internals.keepWarmTick(false), null, '剛生成過：不送');
      tts._internals.setClock({ lastGenerationAt: 0, lastReaderActivityAt: Date.now() - 31 * 60 * 1000 });
      assert.equal(tts._internals.keepWarmTick(false), null, '超過 30 分鐘沒人聽：不送');
      assert.equal(warmInputs(), 1);
    });

    test('關閉保溫或服務不可用時不送；讀者開啟朗讀時先暖機', async () => {
      tts._internals.setClock({ lastGenerationAt: 0, lastReaderActivityAt: Date.now() });
      assert.equal(tts._internals.keepWarmTick(false), null, 'keepWarm 關閉');
      config.settings.tts = Object.assign(baseSettings(), { keepWarm: true });
      tts._internals.setHealth({ ok: false });
      assert.equal(tts._internals.keepWarmTick(false), null, '服務不可用');
      tts._internals.setHealth({ ok: true });
      tts._internals.setClock({ lastGenerationAt: 0, lastReaderActivityAt: 0 });
      await request(`/api/tts/doc?path=${encodeURIComponent(P)}`);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(warmInputs(), 1, '開啟朗讀就暖機');
      await request(`/api/tts/doc?path=${encodeURIComponent(P)}`);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(warmInputs(), 1, '已經熱了就不再送');
    });

    test('音色版本（rev）：換了參考錄音後加一，sha 全部改變；audio.cpp 收到的 voice 名稱不變', async () => {
      const a = (await sentences('v1'))[2].sha;
      const st = baseSettings(); st.voices[0].rev = 2; config.settings.tts = st;
      const b = (await sentences('v1'))[2].sha;
      assert.notEqual(a, b);
      await speak([2]);
      assert.equal(fake.speech[fake.speech.length - 1].voice, 'demo_3_woman');
    });
  });

  describe('LRU 清理（lib/tts-store.js）', () => {
    test('超過上限：先刪臨時檔，再刪最久沒播的；試聽檔不刪', () => {
      const put = (ch, flags) => {
        const sha = ch.repeat(64); const tmp = store.tmpPath(`t-${ch}`);
        fs.writeFileSync(tmp, Buffer.alloc(1000)); store.put(sha, tmp, { ext: 'wav', ms: 1000, flags });
        return sha;
      };
      store.clear();
      const sample = put('a', store.FLAG_SAMPLE); const old = put('b', 0); const temp = put('c', store.FLAG_TEMP); const fresh = put('d', 0);
      const db = new (require('node:sqlite').DatabaseSync)(path.join(store.getDir(), 'tts.db'));
      db.prepare('UPDATE blobs SET last_played_at = ? WHERE sha = ?').run(1000, sample);
      db.prepare('UPDATE blobs SET last_played_at = ? WHERE sha = ?').run(2000, old);
      db.close();
      assert.equal(store.usage().bytes, 4000);
      assert.equal(store.gc(3500), 1);
      assert.equal(store.get(temp), null, '臨時檔先刪');
      assert.equal(store.gc(2500), 1);
      assert.equal(store.get(old), null, '最久沒播的先刪');
      assert.ok(store.get(sample) && store.get(fresh));
      assert.equal(store.gc(100), 1);
      assert.ok(store.get(sample), '試聽檔不刪');
      assert.equal(fs.existsSync(store.blobPath(old, 'wav')), false);
      store.clear();
    });
  });

  describe('後台 API', () => {
    let admin;
    before(() => { admin = session('tok-admin-1', 'admin'); });

    test('未登入 401；一般使用者 401', async () => {
      const user = session('tok-user-3', 'user');
      for (const p of ['settings', 'health', 'lexicon', 'cache']) {
        assert.equal((await request(`/api/admin/tts/${p}`)).status, 401, p);
        assert.equal((await request(`/api/admin/tts/${p}`, { headers: user })).status, 401, p);
      }
      assert.equal((await post('/api/admin/tts/settings', { settings: { enabled: false } })).status, 401);
      assert.equal((await post('/api/admin/tts/cache/clear', { scope: 'all' })).status, 401);
    });

    test('讀設定：含欄位範圍、健康狀態、ffmpeg 狀態', async () => {
      const r = await request('/api/admin/tts/settings', { headers: admin });
      assert.equal(r.status, 200);
      assert.equal(r.json.settings.maxSentenceChars, 120);
      assert.equal(r.json.settings.cacheMb, 20480);
      assert.deepEqual(r.json.bounds.maxSentenceChars, [40, 200]);
      assert.equal(r.json.ffmpeg.ok, false);
    });

    test('儲存並檢查：只列 TTS 模型、不回傳模型路徑；設定寫進 config.json', async () => {
      const r = await post('/api/admin/tts/settings', { check: true, settings: { maxSentenceChars: 80, cacheMb: 1024, baseUrl: fake.url + '/some/path?x=1' } }, admin);
      assert.equal(r.status, 200);
      assert.equal(r.json.settings.maxSentenceChars, 80); assert.equal(r.json.settings.cacheMb, 1024);
      assert.equal(r.json.settings.baseUrl, fake.url, '只留 origin');
      assert.deepEqual(r.json.probe.models.map((m) => m.id), ['drama3']);
      assert.ok(!JSON.stringify(r.json).includes('/secret/models'));
      assert.deepEqual(r.json.probe.voices, ['demo_1_man', 'demo_3_woman']);
      const saved = JSON.parse(fs.readFileSync(process.env.CONFIG_PATH, 'utf8'));
      assert.equal(saved.settings.tts.maxSentenceChars, 80);
    });

    test('句長上限改了之後，文件重新斷句', async () => {
      const long = '若卵生、若胎生、若濕生、若化生，'.repeat(10) + '我皆令入無餘涅槃而滅度之。';
      fs.writeFileSync(path.join(VAULT, 'sub', 'long.md'), long + '\n');
      const count = async () => (await request('/api/tts/doc?chapter=0&path=sub/long.md')).json.sentences.length;
      const a = await count();
      await post('/api/admin/tts/settings', { settings: { maxSentenceChars: 40 } }, admin);
      assert.ok(await count() > a);
    });

    test('不合法的設定被拒絕：非 http 網址、帶帳密、voice 含路徑；數值夾在範圍內', async () => {
      for (const bad of [{ baseUrl: 'file:///etc/passwd' }, { baseUrl: 'ftp://x' }, { baseUrl: 'http://user:pw@host' }, { baseUrl: 'not a url' },
        { voices: [{ voice: '../x' }] }, { voices: [{ voice: 'a/b' }] }, { voices: [{ voice: 'a\\b' }] }, { voices: 'x' }, { model: 'a b;c' }]) {
        const r = await post('/api/admin/tts/settings', { settings: bad }, admin);
        assert.equal(r.status, 400, JSON.stringify(bad));
      }
      const r = await post('/api/admin/tts/settings', { settings: { maxSentenceChars: 5, concurrency: 99, cacheMb: 1, voices: [{ voice: 'demo_1_man', name: '甲' }, { id: 'v1', voice: 'demo_3_woman' }, { id: 'v1', voice: 'dup' }] } }, admin);
      assert.equal(r.status, 200);
      assert.equal(r.json.settings.maxSentenceChars, 40); assert.equal(r.json.settings.concurrency, 4); assert.equal(r.json.settings.cacheMb, 64);
      const ids = r.json.settings.voices.map((v) => v.id);
      assert.equal(new Set(ids).size, 3); assert.ok(ids.every((id) => /^v[0-9a-z]{1,10}$/.test(id)));
      assert.ok(ids.includes(r.json.settings.defaultVoice));
    });

    test('環境變數 TTS_BASE_URL／TTS_MODEL 優先，後台顯示鎖定', async () => {
      process.env.TTS_BASE_URL = 'http://10.0.0.5:8301'; process.env.TTS_MODEL = 'env-model';
      try {
        const r = await request('/api/admin/tts/settings', { headers: admin });
        assert.equal(r.json.settings.baseUrl, 'http://10.0.0.5:8301'); assert.equal(r.json.settings.model, 'env-model');
        assert.deepEqual(r.json.locked, { baseUrl: true, model: true });
      } finally { delete process.env.TTS_BASE_URL; delete process.env.TTS_MODEL; }
    });

    test('試聽：產生固定經句並出現在讀者端的音色卡片；清除全部後消失', async () => {
      const r = await post('/api/admin/tts/sample', { voice: 'v1' }, admin);
      assert.equal(r.status, 200);
      assert.equal(fake.speech[fake.speech.length - 1].input, '應無所住，而生其心。');
      const st = await request('/api/tts/status');
      assert.equal(st.json.voices[0].sample, r.json.url);
      assert.equal(st.json.voices[1].sample, null);
      assert.equal((await post('/api/admin/tts/sample', { voice: 'nope' }, admin)).status, 400);
      const c = await post('/api/admin/tts/cache/clear', { scope: 'all' }, admin);
      assert.ok(c.json.removed >= 1);
      assert.equal((await request('/api/tts/status')).json.voices[0].sample, null);
    });

    test('讀音字典：讀取、儲存、試聽套用字典', async () => {
      const g = await request('/api/admin/tts/lexicon', { headers: admin });
      assert.equal(g.json.exists, false); assert.ok(g.json.count > 5);
      const s = await post('/api/admin/tts/lexicon', { text: '南無｜拿摩\n須菩提\n' }, admin);
      assert.equal(s.json.count, 2); assert.equal(s.json.replacements, 1);
      const p = await post('/api/admin/tts/preview', { voice: 'v1', text: '南無觀世音菩薩' }, admin);
      assert.equal(p.status, 200); assert.equal(p.json.spoken, '拿摩觀世音菩薩');
      assert.equal((await post('/api/admin/tts/preview', { voice: 'v1', text: '' }, admin)).status, 400);
      assert.equal((await post('/api/admin/tts/lexicon', { text: 'x'.repeat(300 * 1024) }, admin)).status, 413);
      fs.rmSync(process.env.TTS_LEXICON_PATH, { force: true }); lexicon.resetCache();
    });

    test('快取用量與清除單篇', async () => {
      await speak([1, 2]);
      const u = await request('/api/admin/tts/cache', { headers: admin });
      assert.equal(u.status, 200);
      assert.ok(u.json.blobs >= 2 && u.json.bytes > 0);
      assert.equal(u.json.limitBytes, 20480 * 1024 * 1024);
      assert.ok(Array.isArray(u.json.days) && u.json.days[0].generated >= 2);
      const c = await post('/api/admin/tts/cache/clear', { scope: 'path', path: P }, admin);
      assert.ok(c.json.removed >= 2);
      assert.equal((await sentences('v1'))[1].cached, false);
      assert.equal((await post('/api/admin/tts/cache/clear', { scope: 'nope' }, admin)).status, 400);
    });
  });
});

describe('lib/tts.js 純函式', () => {
  const tts = require('../lib/tts.js');
  const I = tts._internals;

  test('normalizeBaseUrl', () => {
    assert.equal(I.normalizeBaseUrl('http://192.168.2.66:8301/'), 'http://192.168.2.66:8301');
    assert.equal(I.normalizeBaseUrl('https://tts.example.org/v1/audio?x=1#y'), 'https://tts.example.org');
    assert.equal(I.normalizeBaseUrl(''), '');
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'http://u:p@h', '192.168.2.66:8301', 'gopher://x']) assert.equal(I.normalizeBaseUrl(bad), null, bad);
  });

  test('parseWav 拒絕不是音訊的內容', () => {
    assert.throws(() => I.parseWav(Buffer.from('{"error":{"message":"x"}}')));
    assert.throws(() => I.parseWav(Buffer.from('RIFF....WAVEfmt ')));
    assert.throws(() => I.parseWav(makeWav(0)));
    const w = I.parseWav(makeWav(500));
    assert.equal(w.ms, 500); assert.equal(w.rate, 8000);
  });

  test('快取鍵：文字、模型、音色、seed、後製版本任一不同就不同；字典與規則版本不進鍵', () => {
    const s = { model: 'drama3', seed: 1234 }; const v = { voice: 'demo_3_woman' };
    I.setFfmpeg({ ok: false });
    const k = I.voiceKey(s, v);
    const base = I.blobSha('應無所住，而生其心。', k);
    assert.match(base, /^[0-9a-f]{64}$/);
    assert.equal(I.blobSha('應無所住，而生其心。', I.voiceKey({ model: 'drama3', seed: 1234 }, { voice: 'demo_3_woman' })), base);
    assert.notEqual(I.blobSha('應無所住而生其心。', k), base);
    assert.notEqual(I.blobSha('應無所住，而生其心。', I.voiceKey({ model: 'other', seed: 1234 }, v)), base);
    assert.notEqual(I.blobSha('應無所住，而生其心。', I.voiceKey({ model: 'drama3', seed: 1 }, v)), base);
    assert.notEqual(I.blobSha('應無所住，而生其心。', I.voiceKey(s, { voice: 'demo_1_man' })), base);
    I.setFfmpeg({ ok: true, path: 'ffmpeg' });
    assert.notEqual(I.blobSha('應無所住，而生其心。', I.voiceKey(s, v)), base);
    I.setFfmpeg({ ok: false });
  });
});
