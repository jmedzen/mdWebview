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
          if (fake.mode === 'reset') { req.socket.destroy(); return; }
          if (fake.mode === '500') return json(500, { error: { message: 'model exploded', type: 'server_error' } });
          if (fake.mode === 'noref') return json(400, { error: { message: 'Drama 3 reference audio requires reference_text', type: 'invalid_request_error' } });
          if (fake.mode === 'busy') return json(503, { error: { message: "model 'drama3' is busy", type: 'server_busy' } });
          if (fake.mode === 'json200') { res.writeHead(200, { 'Content-Type': 'audio/wav' }); return res.end(JSON.stringify({ error: { message: 'oops' } })); }
          if (fake.mode === 'html200') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>error</html>'); }
          const chars = Array.from(String(body.input)).length;
          // capped：模擬 drama3 的 context 被參考錄音吃光，聲音停在約 3.5 秒（實測 76 秒參考錄音）
          const wav = makeWav(fake.mode === 'tooshort' ? 10 : fake.mode === 'capped' ? 3500 : chars * 250);
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
  builtinLexicon: false, // 這些測試比對原文；內建佛經讀音表另有專門的測試
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

    test('參考錄音已刪除（audio.cpp 不再列出）的音色：讀者看不到，也不能用來生成；預設音色改用第一個還在的', async () => {
      const { config } = require('../lib/config.js');
      const tts = require('../lib/tts.js');
      const before = config.settings.tts;
      const st = baseSettings();
      st.voices.unshift({ id: 'v0', voice: 'deleted_voice', name: '已刪', tags: [], rate: 1, enabled: true });
      st.defaultVoice = 'v0';
      config.settings.tts = st;
      try {
        tts._internals.setUpstreamVoices(fake.url, ['demo_1_man', 'demo_3_woman']);
        const s = await request('/api/tts/status');
        assert.deepEqual(s.json.voices.map((v) => v.id), ['v1', 'v2']);
        assert.equal(s.json.defaultVoice, 'v1');
        const r = await speak([1], { voice: 'v0' });
        assert.ok(r.status >= 400, `status ${r.status}`);
      } finally { config.settings.tts = before; tts._internals.resetUpstreamVoices(); }
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
        if (mode === '500') assert.equal(fake.speech.length, 2, '5xx 重試一次');
        if (mode === 'busy') assert.equal(fake.speech.length, 3, '忙碌時多等一下、重試兩次');
      });
    }

    test('audio.cpp 整台連不上（連線被切斷）：回報 unavailable，不是 failed', async () => {
      fake.mode = 'reset'; tts._internals.failed.clear();
      const r = await speak([5], { voice: 'v2' });
      assert.equal(r.json.items[0].state, 'unavailable');
      fake.mode = 'ok'; tts._internals.failed.clear();
      assert.equal((await speak([5], { voice: 'v2' })).json.items[0].state, 'ready');
    });

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

    test('靜音檔（解鎖 <audio> 用）：合法的 WAV，可長期快取', async () => {
      const r = await request('/api/tts/silence.wav');
      assert.equal(r.status, 200); assert.equal(r.headers['content-type'], 'audio/wav');
      assert.equal(r.body.toString('latin1', 0, 4), 'RIFF');
      assert.equal(tts._internals.parseWav(r.body).ms, 100);
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
      config.settings.tts = Object.assign(baseSettings(), { model: 'not-loaded' });
      const h = await tts.checkHealth();
      assert.equal(h.ok, false);
      assert.match(h.error, /沒有模型「not-loaded」/);
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

    test('位置也可以用「該行中之前的非空白字數」表示（畫面文字與正規化文字的空白不同）', async () => {
      // 第 5 行：「一時，佛在…俱。」28 字之後是「爾時，世尊食時…」；選第二句的第 3–5 個字
      const r = await post('/api/tts/resolve', { path: P, voice: 'v1', start: { line: 5, n: 30 }, end: { line: 5, n: 33 } });
      assert.equal(r.status, 200);
      assert.deepEqual(r.json.sentences.map((x) => x.text), ['爾時，世尊食時，著衣持鉢，入舍衛大城乞食。']);
      const ex = await post('/api/tts/resolve', { path: P, voice: 'v1', exact: true, start: { line: 5, n: 3 }, end: { line: 5, n: 8 } });
      assert.equal(ex.json.sentences[0].text, '佛在舍衛國');
      // 偈頌（跨行單位）：選第 13 行的幾個字，回整個偈
      const v = await post('/api/tts/resolve', { path: P, voice: 'v1', start: { line: 13, n: 1 }, end: { line: 13, n: 4 } });
      assert.ok(v.json.sentences.some((x) => x.kind === 'verse'));
      assert.equal((await post('/api/tts/resolve', { path: P, start: { line: 5, n: 8 }, end: { line: 5, n: 3 } })).status, 400);
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

  describe('換音色後舊音色不再佔用 audio.cpp', () => {
    const L = 'tab0123456789abcdef';
    const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
    const voicesAfter = (n) => fake.speech.slice(n).map((b) => b.voice);
    /** 送出請求、等到伺服器收到後就中斷連線（模擬前端 AbortController.abort()） */
    function speakThenAbort(body, afterMs) {
      return new Promise((resolve) => {
        const req = http.request(new URL('/api/tts/speak', baseUrl), { method: 'POST', agent: false, headers: { 'Content-Type': 'application/json', Connection: 'close' } });
        req.on('error', () => resolve());
        req.end(JSON.stringify(body));
        setTimeout(() => { req.destroy(); resolve(); }, afterMs);
      });
    }

    test('用音色 A 播放、預取排隊中換成音色 B：之後 audio.cpp 只再收到 A 正在生成的那一句', async () => {
      fake.delayMs = 150;
      const pre = speak([1, 2, 3, 5], { priority: 'prefetch', listener: L, gen: 1 });
      await sleepMs(60); // 第一句已送到 audio.cpp，其餘三句在排隊
      assert.equal(fake.speech.length, 1);
      const switchAt = fake.speech.length;
      const now = await speak([1], { voice: 'v2', listener: L, gen: 2 });
      assert.equal(now.json.items[0].state, 'ready');
      const old = await pre;
      const after = voicesAfter(switchAt);
      assert.deepEqual(after, ['demo_1_man'], `換音色後送出的請求：${after.join(', ')}`);
      assert.equal(fake.speech.filter((b) => b.voice === 'demo_3_woman').length, 1, '舊音色只有換之前已在生成的那一句');
      assert.deepEqual(old.json.items.map((x) => x.state), ['ready', 'cancelled', 'cancelled', 'cancelled']);
      assert.ok(tts._internals.queueStats().cancelled >= 3);
      // 已生成的舊音色那一句留在快取
      const back = await speak([1], { listener: L, gen: 3 });
      assert.equal(back.json.items[0].state, 'ready');
      assert.equal(fake.speech.filter((b) => b.voice === 'demo_3_woman').length, 1, '換回音色 A 時直接命中快取');
      assert.equal(tts._internals.queueStats().queued, 0);
    });

    test('/api/tts/cancel（停止朗讀）把這位讀者排隊中的句子移出佇列', async () => {
      fake.delayMs = 150;
      const pre = speak([1, 2, 3, 5], { priority: 'prefetch', listener: L, gen: 1 });
      await sleepMs(60);
      const c = await post('/api/tts/cancel', { listener: L, gen: 2 });
      assert.equal(c.status, 200); assert.equal(c.json.dropped, 3);
      await pre;
      assert.equal(fake.speech.length, 1);
      assert.equal((await post('/api/tts/cancel', { gen: 2 })).status, 400, '缺 listener');
    });

    test('前端中斷請求（關頁、斷線）且沒有再來：寬限期後排隊的句子撤銷，上游只跑完已開始的那一句', async () => {
      tts._internals.setListenerGrace(20);
      try {
        fake.delayMs = 150;
        await speakThenAbort({ path: P, voice: 'v1', ids: [1, 2, 3, 5], priority: 'prefetch', listener: L, gen: 1 }, 60);
        await sleepMs(500);
        assert.equal(fake.speech.length, 1, fake.speech.map((b) => b.input).join(' / '));
        assert.equal(tts._internals.queueStats().queued, 0);
        assert.equal(tts._internals.queueStats().running, 0);
      } finally { tts._internals.setListenerGrace(3000); }
    });

    test('中斷後馬上用新的請求接上（換音色的正常流程）：不撤銷新的請求', async () => {
      tts._internals.setListenerGrace(100);
      try {
        fake.delayMs = 80;
        await speakThenAbort({ path: P, voice: 'v1', ids: [1, 2], priority: 'prefetch', listener: L, gen: 1 }, 30);
        const r = await speak([3, 5], { voice: 'v2', priority: 'prefetch', listener: L, gen: 2 });
        assert.deepEqual(r.json.items.map((x) => x.state), ['ready', 'ready']);
        assert.deepEqual(fake.speech.map((b) => b.voice), ['demo_3_woman', 'demo_1_man', 'demo_1_man']);
      } finally { tts._internals.setListenerGrace(3000); }
    });

    test('慢到的舊 gen 請求（亂序）不再排新工作', async () => {
      await post('/api/tts/cancel', { listener: L, gen: 5 });
      const r = await speak([2], { listener: L, gen: 4 });
      assert.equal(r.json.items[0].state, 'cancelled');
      assert.equal(fake.speech.length, 0);
    });

    test('別的讀者（或離線下載）也在等同一句：一位讀者換音色不影響他', async () => {
      fake.delayMs = 100;
      const other = speak([1, 2, 3], { priority: 'prefetch', listener: 'offline0123456789ab', gen: 1 });
      const mine = speak([1, 2, 3], { priority: 'prefetch', listener: L, gen: 1 });
      await sleepMs(30);
      await post('/api/tts/cancel', { listener: L, gen: 2 });
      const o = await other; await mine;
      assert.deepEqual(o.json.items.map((x) => x.state), ['ready', 'ready', 'ready']);
      assert.equal(fake.speech.length, 3, '沒有重複生成');
    });

    test('舊版前端（沒帶 listener）：照舊排進去就跑完', async () => {
      fake.delayMs = 50;
      const r = await speak([1, 2, 3], { priority: 'prefetch' });
      assert.deepEqual(r.json.items.map((x) => x.state), ['ready', 'ready', 'ready']);
      assert.equal(fake.speech.length, 3);
    });

    test('後台預生成工作：讀者撤銷不影響；管理員暫停時排隊的那一句移出佇列', async () => {
      fake.delayMs = 120;
      const { enqueue, releaseClaims, queueStats } = tts._internals;
      const s = tts.getSettings();
      const v1 = s.voices.find((v) => v.id === 'v1');
      const mk = (txt) => ({ sha: tts._internals.blobSha(txt, tts._internals.voiceKey(s, v1)), spoken: txt, voiceName: v1.voice, voiceId: 'v1', flags: 0 });
      const blocker = enqueue(mk('第一句佔住生成名額。'), 'now', { key: 'l:' + L, gen: 1 });
      await sleepMs(20); // 已送到 audio.cpp
      const bulk = enqueue(mk('預生成的一句經文。'), 'bulk', { key: 'job:77', gen: 0 });
      const shared = mk('讀者與預生成都要的一句。');
      const pShared = enqueue(shared, 'bulk', { key: 'job:77', gen: 0 });
      enqueue(shared, 'now', { key: 'l:' + L, gen: 1 }); // 讀者把它提前
      assert.equal(releaseClaims('l:' + L, Infinity), 0, '背景工作還在等，不移除');
      assert.equal(queueStats().byPriority[0], 0, '只剩背景工作在等：退回 bulk 優先序');
      assert.equal(releaseClaims('job:77', Infinity), 2, '管理員暫停：兩句都移出佇列');
      await assert.rejects(bulk, (e) => e.cancelled === true);
      await assert.rejects(pShared, (e) => e.cancelled === true);
      await blocker;
      assert.equal(fake.speech.length, 1);
    });

    test('同一範圍、同一音色的預生成工作不重複排', async () => {
      const admin = session('dupjob-tok', 'admin');
      fs.writeFileSync(path.join(VAULT, 'sub', 'b.md'), '# 乙\n\n如是我聞。\n');
      const a = await post('/api/admin/tts/jobs', { scope: 'sub/b.md', voice: 'v1' }, admin);
      await post(`/api/admin/tts/jobs/${a.json.id}`, { action: 'pause' }, admin);
      const b = await post('/api/admin/tts/jobs', { scope: 'sub/b.md', voice: 'v1' }, admin);
      assert.equal(b.status, 200);
      assert.equal(b.json.id, a.json.id, '沿用已排的工作');
      await post(`/api/admin/tts/jobs/${a.json.id}`, { action: 'cancel' }, admin);
      await post(`/api/admin/tts/jobs/${a.json.id}`, { action: 'delete' }, admin);
      fs.unlinkSync(path.join(VAULT, 'sub', 'b.md'));
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

    test('匿名使用統計：只收白名單內的事件，後台彙總得到；不存路徑以外的文字', async () => {
      const ev = (o, h) => post('/api/tts/event', o, h);
      assert.equal((await ev({ type: 'start', mode: 'here', voice: 'v1', path: P }, { Origin: 'https://evil.example' })).status, 403);
      for (const o of [
        { type: 'start', mode: 'section', voice: 'v1', path: P },
        { type: 'start', mode: 'sentence', voice: 'v2', path: P },
        { type: 'start', mode: 'bogus', voice: 'v1' },               // 不在白名單：不記
        { type: 'start', mode: 'here', voice: 'nope', path: '../x.md' }, // 音色、路徑不合法：只記啟動方式
        { type: 'listen', ms: 65000, n: 12, voice: 'v1' },
        { type: 'feature', key: 'sleep' }, { type: 'feature', key: '<script>' },
        { type: 'end', key: 'finished' }, { type: 'end', key: 'stopped' }
      ]) assert.equal((await ev(o)).status, 200);
      const r = await request('/api/admin/tts/analytics?range=7d', { headers: admin });
      assert.equal(r.status, 200);
      const k = r.json.kinds;
      assert.deepEqual(k.mode, { section: 1, sentence: 1, here: 1 });
      assert.deepEqual(k.voice, { v1: 1, v2: 1 });
      assert.deepEqual(k.doc, { [P]: 2 });
      assert.deepEqual(k.feature, { sleep: 1 });
      assert.deepEqual(k.end, { finished: 1, stopped: 1 });
      assert.equal(r.json.totals.starts, 3);
      assert.equal(r.json.totals.listeners, 1); // 同一個來源同一天只算一人
      assert.equal(r.json.totals.listenMs, 65000);
      assert.equal(r.json.totals.sentences, 12);
      assert.ok(!JSON.stringify(r.json).includes('127.0.0.1'));
      assert.equal((await request('/api/admin/tts/analytics')).status, 401);
    });

    test('讀者回報念錯：只收這篇的句子序號，文字由伺服器取；同一句合併計數；後台可列出與處理', async () => {
      const doc = await request(`/api/tts/doc?path=${encodeURIComponent(P)}&voice=v1&chapter=0`);
      const s0 = doc.json.sentences.find((x) => x.kind !== 'skip');
      assert.equal((await post('/api/tts/report', { path: P, i: s0.i }, { Origin: 'https://evil.example' })).status, 403);
      assert.equal((await post('/api/tts/report', { path: P, i: 99999 })).status, 400);
      assert.equal((await post('/api/tts/report', { path: '../x.md', i: 0 })).status, 404);
      assert.equal((await post('/api/tts/report', { path: P, i: s0.i, voice: 'v1', note: '<b>般</b>念錯' })).status, 200);
      assert.equal((await post('/api/tts/report', { path: P, i: s0.i, text: '任意文字' })).status, 200);
      const r = await request('/api/admin/tts/reports', { headers: admin });
      assert.equal(r.status, 200);
      assert.equal(r.json.reports.length, 1);
      const x = r.json.reports[0];
      assert.equal(x.n, 2);
      assert.equal(x.text, s0.text);
      assert.equal(x.note, 'b般/b念錯'); // 角括號拿掉；後到的空備註不覆蓋
      // 回報時選的音色：存 id 與當時的名稱；後到沒帶音色的回報不把它清掉
      assert.equal(x.voice, 'v1'); assert.equal(x.voiceName, '慧音');
      // 音色改名後，舊回報仍保留當時的名稱；換音色再回報，記成最新的那個
      config.settings.tts.voices[0].name = '慧音（新）';
      assert.equal((await request('/api/admin/tts/reports', { headers: admin })).json.reports[0].voiceName, '慧音');
      assert.equal((await post('/api/tts/report', { path: P, i: s0.i, voice: 'v2' })).status, 200);
      const x2 = (await request('/api/admin/tts/reports', { headers: admin })).json.reports[0];
      assert.equal(x2.voice, 'v2'); assert.equal(x2.voiceName, '法音'); assert.equal(x2.n, 3);
      // 不認得的音色 id 不存
      const s1 = doc.json.sentences.filter((y) => y.kind !== 'skip')[1];
      assert.equal((await post('/api/tts/report', { path: P, i: s1.i, voice: 'nope' })).status, 200);
      const x3 = (await request('/api/admin/tts/reports', { headers: admin })).json.reports.find((y) => y.unit === s1.i);
      assert.equal(x3.voice, ''); assert.equal(x3.voiceName, '');
      await post('/api/admin/tts/reports/delete', { key: x3.key }, admin);
      assert.equal((await request('/api/admin/tts/reports')).status, 401);
      assert.equal((await post('/api/admin/tts/reports/delete', { key: x.key }, admin)).status, 200);
      assert.equal((await request('/api/admin/tts/reports', { headers: admin })).json.reports.length, 0);
    });

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

    test('試聽：還沒存的新音色也能試；缺逐字稿回 NO_TRANSCRIPT 並說明；ASR 模型清單隨設定回傳', async () => {
      tts._internals.setUpstreamVoices(fake.url, ['demo_1_man', 'demo_3_woman', 'RA-new']);
      const r = await post('/api/admin/tts/sample', { voiceName: 'RA-new' }, admin);
      assert.equal(r.status, 200);
      assert.equal(fake.speech[fake.speech.length - 1].voice, 'RA-new');
      assert.equal((await post('/api/admin/tts/sample', { voiceName: 'not-listed' }, admin)).status, 400);
      assert.equal((await post('/api/admin/tts/sample', { voiceName: '../etc' }, admin)).status, 400);
      fake.mode = 'noref'; tts._internals.failed.clear();
      try {
        const e = await post('/api/admin/tts/sample', { voice: 'v2' }, admin);
        assert.equal(e.status, 409); assert.equal(e.json.code, 'NO_TRANSCRIPT');
        assert.match(e.json.error, /逐字稿/);
      } finally { fake.mode = 'ok'; tts._internals.failed.clear(); tts._internals.resetUpstreamVoices(); }
      await request('/api/admin/tts/health', { headers: admin });
      const g = await request('/api/admin/tts/settings', { headers: admin });
      assert.deepEqual(g.json.asrModels, ['qwen3-asr']);
      const h = await request('/api/admin/tts/health', { headers: admin });
      assert.deepEqual(h.json.asrModels.map(m => m.id), ['qwen3-asr']);
      assert.equal(h.json.models.some(m => m.id === 'qwen3-asr'), false, 'ASR 模型不混進朗讀模型');
    });

    test('後台改逐字稿：寫 .txt、重建 prompt_text；只能改資料夾裡有錄音的名稱', async () => {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mdw-voices-'));
      fs.writeFileSync(path.join(d, 'RA-甲.wav'), makeWav(4000));
      config.settings.tts = Object.assign({}, config.settings.tts, { voiceDir: d, autoTranscribe: false });
      try {
        const r = await post('/api/admin/tts/voicedir/transcript', { name: 'RA-甲', text: '如是我聞，\n一時佛在。' }, admin);
        assert.equal(r.status, 200);
        assert.equal(fs.readFileSync(path.join(d, 'RA-甲.txt'), 'utf8'), '如是我聞， 一時佛在。\n');
        assert.equal(fs.readFileSync(path.join(d, 'prompt_text'), 'utf8'), 'RA-甲|如是我聞， 一時佛在。\n');
        const v = r.json.voiceDir.voices[0];
        assert.equal(v.text, '如是我聞， 一時佛在。'); assert.equal(v.inPrompt, true); assert.equal(v.stale, false);
        assert.equal(v.audio.ms, 4000); assert.equal(v.audio.rate, 8000); assert.equal(v.audio.channels, 1);
        assert.equal((await post('/api/admin/tts/voicedir/transcript', { name: '../config', text: 'x' }, admin)).status, 400);
        assert.equal((await post('/api/admin/tts/voicedir/transcript', { name: 'RA-甲', text: '  ' }, admin)).status, 400);
        assert.equal(fs.existsSync(path.join(d, '..', 'config.txt')), false);
        assert.equal((await post('/api/admin/tts/voicedir/transcript', { name: 'RA-甲', text: 'x' })).status, 401);
      } finally {
        config.settings.tts = Object.assign({}, config.settings.tts, { voiceDir: '' });
        fs.rmSync(d, { recursive: true, force: true });
      }
    });

    test('參考錄音太長：後台標出每句可生成長度；被截短的聲音不進快取，回 REF_TOO_LONG', async () => {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mdw-voices-'));
      fs.writeFileSync(path.join(d, 'demo_3_woman.wav'), makeWav(76000));
      fs.writeFileSync(path.join(d, 'demo_1_man.wav'), makeWav(18000));
      fs.writeFileSync(path.join(d, 'prompt_text'), `demo_3_woman|${'歡'.repeat(1178)}\ndemo_1_man|${'迎'.repeat(288)}\n`);
      config.settings.tts = Object.assign({}, config.settings.tts, { voiceDir: d, autoTranscribe: false });
      try {
        const g = await request('/api/admin/tts/settings', { headers: admin });
        const long = g.json.voiceDir.voices.find(v => v.name === 'demo_3_woman');
        const short = g.json.voiceDir.voices.find(v => v.name === 'demo_1_man');
        assert.ok(long.budget.frames < 150, `76 秒參考錄音幾乎沒有生成空間：${long.budget.frames}`);
        assert.ok(long.budget.maxChars < 20);
        assert.equal(short.budget.frames, 1024, '18 秒參考錄音不受 context 限制');
        tts._internals.failed.clear();
        fake.mode = 'capped';
        const text = '一時佛在舍衛國祇樹給孤獨園，與大比丘眾千二百五十人俱。';
        const r = await post('/api/admin/tts/preview', { voice: 'v1', text: text + '甲' }, admin);
        assert.equal(r.status, 502); assert.equal(r.json.code, 'REF_TOO_LONG');
        assert.match(r.json.error, /剪成約 20 秒/);
        // 短的參考錄音碰到同樣的短音檔：不是 context 造成的，維持原本的判斷（3.5 秒對 28 字算合理）
        const ok = await post('/api/admin/tts/preview', { voice: 'v2', text: text + '乙' }, admin);
        assert.equal(ok.status, 200);
      } finally {
        fake.mode = 'ok'; tts._internals.failed.clear();
        config.settings.tts = Object.assign({}, config.settings.tts, { voiceDir: '' });
        fs.rmSync(d, { recursive: true, force: true });
      }
    });

    test('讀音字典：讀取、儲存、試聽套用字典', async () => {
      const g = await request('/api/admin/tts/lexicon', { headers: admin });
      assert.equal(g.json.exists, false); assert.ok(g.json.count > 5);
      const s = await post('/api/admin/tts/lexicon', { text: '南無｜拿摩\n須菩提\n' }, admin);
      assert.equal(s.json.count, 2); assert.equal(s.json.replacements, 1);
      const p = await post('/api/admin/tts/preview', { voice: 'v1', text: '南無觀世音菩薩' }, admin);
      assert.equal(p.status, 200); assert.equal(p.json.spoken, '拿摩觀世音菩薩');
      assert.equal((await post('/api/admin/tts/preview', { voice: 'v1', text: '' }, admin)).status, 400);
      // 「原讀法」對照：不套任何字典
      const raw = await post('/api/admin/tts/preview', { voice: 'v1', text: '南無觀世音菩薩', raw: true }, admin);
      assert.equal(raw.json.spoken, '南無觀世音菩薩');
      // 開內建佛經讀音表：試聽與讀取都看得到；描述裡附內建表與覆寫狀態
      const on = await post('/api/admin/tts/settings', { settings: { builtinLexicon: true } }, admin);
      assert.equal(on.json.settings.builtinLexicon, true);
      const p2 = await post('/api/admin/tts/preview', { voice: 'v1', text: '般若波羅蜜多' }, admin);
      assert.equal(p2.json.spoken, '波惹波羅蜜多');
      const g2 = await request('/api/admin/tts/lexicon', { headers: admin });
      const nm = g2.json.builtin.find((r) => r.word === '南無');
      assert.equal(nm.overridden, true); assert.equal(nm.override, '拿摩'); // 自訂寫了讀法：以自訂為準
      await post('/api/admin/tts/settings', { settings: { builtinLexicon: false } }, admin);
      assert.equal((await post('/api/admin/tts/lexicon', { text: 'x'.repeat(300 * 1024) }, admin)).status, 413);
      fs.rmSync(process.env.TTS_LEXICON_PATH, { force: true }); lexicon.resetCache();
    });

    test('預先生成：資料夾工作逐句生成、可暫停與繼續；釘選的音檔不被 LRU 刪；不合法的範圍被拒絕', async () => {
      fs.writeFileSync(path.join(VAULT, 'sub', 'job2.md'), '一切有為法，如夢幻泡影。如露亦如電，應作如是觀。\n');
      for (const bad of ['../etc', '.git', 'nope', 'sub/nope.md']) {
        assert.equal((await post('/api/admin/tts/jobs', { scope: bad, voice: 'v1' }, admin)).status, 400, bad);
      }
      assert.equal((await post('/api/admin/tts/jobs', { scope: 'sub', voice: 'v9' }, admin)).status, 400, '未開放的音色');
      assert.equal((await post('/api/admin/tts/jobs', { scope: 'sub', voice: 'v1' })).status, 401);
      const r = await post('/api/admin/tts/jobs', { scope: 'sub', voice: 'v2', pin: true }, admin);
      assert.equal(r.status, 200);
      const id = r.json.id;
      for (let i = 0; i < 100 && tts._internals.jobRt.running; i++) await new Promise((x) => setTimeout(x, 30));
      const done = (await request('/api/admin/tts/jobs', { headers: admin })).json.jobs.find((j) => j.id === id);
      assert.equal(done.state, 'done');
      assert.ok(done.files >= 2 && done.generated >= 5, JSON.stringify(done));
      // 讀者端看得到這些句子已快取
      const ss = (await request('/api/tts/doc?chapter=0&voice=v2&path=sub/job2.md')).json.sentences;
      assert.ok(ss.every((x) => x.kind === 'skip' || x.cached));
      // 釘選：GC 到幾乎 0 也不刪
      store.gc(1);
      assert.ok(store.get(ss.find((x) => x.sha).sha), '釘選的音檔不能被清掉');
      // 暫停與繼續
      const r2 = await post('/api/admin/tts/jobs', { scope: 'sub/job2.md', voice: 'v1' }, admin);
      await post(`/api/admin/tts/jobs/${r2.json.id}`, { action: 'pause' }, admin);
      assert.equal((await post(`/api/admin/tts/jobs/${r2.json.id}`, { action: 'nope' }, admin)).status, 400);
      await post(`/api/admin/tts/jobs/${r2.json.id}`, { action: 'resume' }, admin);
      for (let i = 0; i < 200 && tts._internals.jobRt.running; i++) await new Promise((x) => setTimeout(x, 30));
      const j2 = (await request('/api/admin/tts/jobs', { headers: admin })).json.jobs.find((j) => j.id === r2.json.id);
      assert.equal(j2.state, 'done');
      assert.equal((await post(`/api/admin/tts/jobs/${r2.json.id}`, { action: 'delete' }, admin)).status, 200);
      store.clear();
    });

    test('「開放朗讀」關閉：讀者端入口全關；後台試聽、字典試聽、快取、預先生成、覆蓋率照常可用', async () => {
      config.settings.tts = Object.assign(baseSettings(), { enabled: false });
      fs.writeFileSync(path.join(VAULT, 'sub', 'off.md'), '諸行無常，是生滅法。生滅滅已，寂滅為樂。\n');
      // 讀者端
      assert.deepEqual((await request('/api/tts/status')).json, { enabled: false, available: false, voices: [] });
      assert.equal((await request(`/api/tts/doc?path=${encodeURIComponent(P)}`)).status, 404);
      assert.equal((await speak([1])).status, 404);
      assert.equal((await post('/api/tts/resolve', { path: P, start: { line: 1, n: 0 }, end: { line: 3, n: 2 } })).status, 404);
      assert.equal((await post('/api/tts/report', { path: P, i: 1 })).status, 404);
      assert.deepEqual((await request('/api/listen/ready?voice=v1')).json, { available: false, items: {} });
      // 後台
      const st = await request('/api/admin/tts/settings', { headers: admin });
      assert.equal(st.status, 200); assert.equal(st.json.settings.enabled, false); assert.equal(st.json.storeAvailable, true);
      const sample = await post('/api/admin/tts/sample', { voice: 'v1' }, admin);
      assert.equal(sample.status, 200, JSON.stringify(sample.json));
      assert.equal((await request(sample.json.url)).status, 200, '後台試聽的音檔要能播');
      const pv = await post('/api/admin/tts/preview', { voice: 'v2', text: '般若波羅蜜多' }, admin);
      assert.equal(pv.status, 200, JSON.stringify(pv.json));
      assert.equal((await request('/api/admin/tts/cache', { headers: admin })).status, 200);
      assert.equal((await request('/api/admin/tts/reports', { headers: admin })).status, 200);
      const est = await post('/api/admin/tts/jobs/estimate', { scope: 'sub/off.md', voices: ['v1'] }, admin);
      assert.equal(est.status, 200, JSON.stringify(est.json));
      const job = await post('/api/admin/tts/jobs', { scope: 'sub/off.md', voice: 'v1' }, admin);
      assert.equal(job.status, 200, JSON.stringify(job.json));
      for (let i = 0; i < 200 && tts._internals.jobRt.running; i++) await new Promise((x) => setTimeout(x, 30));
      const done = (await request('/api/admin/tts/jobs', { headers: admin })).json.jobs.find((j) => j.id === job.json.id);
      assert.equal(done.state, 'done', JSON.stringify(done));
      assert.ok(done.generated >= 1, JSON.stringify(done));
      const cov = await tts.coverage('sub/off.md', 'v1', 0, 0);
      assert.ok(cov && cov.voiced >= 1 && cov.cached === cov.voiced, JSON.stringify(cov));
      assert.equal((await request('/api/admin/listen/coverage?voice=v1', { headers: admin })).json.available, true);
      // 打開之後，讀者端立刻看得到剛才預先生成的句子
      config.settings.tts.enabled = true;
      const ss = (await request('/api/tts/doc?chapter=0&voice=v1&path=sub/off.md')).json.sentences;
      assert.ok(ss.filter((x) => x.sha).every((x) => x.cached), JSON.stringify(ss));
      await post(`/api/admin/tts/jobs/${job.json.id}`, { action: 'delete' }, admin);
      store.clear();
    });

    test('「開放朗讀」關閉但伺服器還沒設定：後台試聽回 409，提示設定網址與模型（不再要求先開放朗讀）', async () => {
      config.settings.tts = Object.assign(baseSettings(), { enabled: false, baseUrl: '', model: '' });
      const r = await post('/api/admin/tts/sample', { voice: 'v1' }, admin);
      assert.equal(r.status, 409);
      assert.equal(r.json.error, '請先設定伺服器網址與模型');
    });

    test('聽經目錄一次預先生成：估算、多音色依序、節錄只生成那一段、失敗報告與重試', async () => {
      fs.mkdirSync(path.join(VAULT, 'lc'), { recursive: true });
      // 節錄：只取「普門品」那一段；另一部整部收錄
      fs.writeFileSync(path.join(VAULT, 'lc', 'lotus.md'), [
        '# 妙法蓮華經', '## 序品第一', '如是我聞，一時佛住王舍城耆闍崛山中。', '## 觀世音菩薩普門品第二十五',
        '爾時無盡意菩薩，即從座起，偏袒右肩。', '若有無量百千萬億眾生，受諸苦惱。', '## 陀羅尼品第二十六', '爾時藥王菩薩即從座起。'
      ].join('\n\n') + '\n');
      fs.writeFileSync(path.join(VAULT, 'lc', 'heart.md'), '觀自在菩薩，行深般若波羅蜜多時。照見五蘊皆空，度一切苦厄。\n');
      const lcMod = require('../lib/listen-catalog.js');
      const lines = fs.readFileSync(path.join(VAULT, 'lc', 'lotus.md'), 'utf8').split('\n');
      const ln = (t) => lines.findIndex((x) => x.includes(t)) + 1;
      config.settings.listenCatalog = lcMod.sanitizeCatalog({
        categories: [{ id: 'f', name: '經' }],
        items: [
          { id: 'p', name: '普門品', path: 'lc/lotus.md', cat: 'f', split: 'none',
            range: { from: { head: '觀世音菩薩普門品第二十五', line: ln('普門品') }, to: { head: '陀羅尼品第二十六', line: ln('陀羅尼品') } } },
          { id: 'h', name: '心經', path: 'lc/heart.md', cat: 'f' },
          { id: 'x', name: '隱藏', path: 'sub/a.md', cat: 'f', enabled: false }
        ]
      });
      lcMod._internals.resolvedCache.clear();
      const ents = await lcMod.catalogJobEntries();
      assert.deepEqual(ents.map((e) => e.name), ['普門品', '心經'], '隱藏的不排');
      assert.ok(ents[0].from > 1 && ents[0].to > ents[0].from, JSON.stringify(ents[0]));

      // 估算：還沒生成；兩個音色各算一份
      assert.equal((await post('/api/admin/tts/jobs/estimate', { scope: 'listen:catalog', voices: ['v1', 'v9'] }, admin)).status, 400, '未開放的音色');
      const e1 = await post('/api/admin/tts/jobs/estimate', { scope: 'listen:catalog', voices: ['v1', 'v2'] }, admin);
      assert.equal(e1.status, 200, JSON.stringify(e1.json));
      assert.equal(e1.json.files, 2);
      assert.deepEqual(e1.json.voices.map((v) => v.voice), ['v1', 'v2']);
      const n = e1.json.voices[0].sentences;
      assert.ok(n >= 4, JSON.stringify(e1.json));
      assert.equal(e1.json.voices[0].cached, 0); assert.equal(e1.json.voices[0].missing, n);
      assert.equal(e1.json.total.missing, n * 2);
      assert.ok(e1.json.total.estMs > 0 && e1.json.total.estBytes > 0);
      assert.equal(fake.speech.length, 0, '估算不會生成');

      // 先讓 v1 的一句已經在快取：估算要扣掉
      const hs = (await request('/api/tts/doc?chapter=0&voice=v1&path=lc/heart.md')).json.sentences.filter((x) => x.sha);
      await post('/api/tts/speak', { path: 'lc/heart.md', voice: 'v1', ids: [hs[0].id], priority: 'now' });
      const e2 = await post('/api/admin/tts/jobs/estimate', { scope: 'listen:catalog', voices: ['v1'] }, admin);
      assert.equal(e2.json.voices[0].cached, 1); assert.equal(e2.json.voices[0].missing, n - 1);

      // 開始：v1 一切正常；v2 生成失敗（時長異常）→ 報告裡列出失敗的句子
      fake.speech.length = 0;
      const r = await post('/api/admin/tts/jobs', { scope: 'listen:catalog', voices: ['v1', 'v2'], pin: true }, admin);
      assert.equal(r.status, 200);
      assert.equal(r.json.ids.length, 2);
      const wait = async () => { for (let i = 0; i < 300 && tts._internals.jobRt.running; i++) await new Promise((x) => setTimeout(x, 20)); };
      // 第二個音色先暫停：等第一個跑完，再讓 audio.cpp 回時長異常的音檔，然後繼續
      await post(`/api/admin/tts/jobs/${r.json.ids[1]}`, { action: 'pause' }, admin);
      await wait();
      fake.mode = 'tooshort';
      await post(`/api/admin/tts/jobs/${r.json.ids[1]}`, { action: 'resume' }, admin);
      await wait();
      const jobs = (await request('/api/admin/tts/jobs', { headers: admin })).json.jobs;
      const j1 = jobs.find((x) => x.id === r.json.ids[0]); const j2 = jobs.find((x) => x.id === r.json.ids[1]);
      assert.equal(j1.scope, '聽經目錄');
      assert.equal(j1.state, 'done'); assert.equal(j1.failed, 0); assert.equal(j1.generated, n - 1, '已快取的句子跳過');
      assert.ok(fake.speech.every((b) => !/序品|如是我聞|藥王/.test(b.input)), '節錄範圍外的句子不生成');
      assert.equal(j2.state, 'done'); assert.equal(j2.failed, n);
      assert.equal(j2.failures.length, n);
      assert.ok(j2.failures.every((f) => f.kind === 'duration' && f.line > 0 && f.label && f.reason));
      assert.ok(!('sha' in j2.failures[0]), '報告不外露 sha');
      assert.ok(j2.failures.some((f) => f.label === '普門品' && f.path === 'lc/lotus.md'));

      // 重試失敗的句子：只重做失敗的
      fake.mode = 'ok'; fake.speech.length = 0;
      assert.equal((await post(`/api/admin/tts/jobs/${j1.id}`, { action: 'retry' }, admin)).status, 400, '沒有失敗就不能重試');
      const rr = await post(`/api/admin/tts/jobs/${j2.id}`, { action: 'retry' }, admin);
      assert.equal(rr.status, 200);
      await wait();
      const j3 = (await request('/api/admin/tts/jobs', { headers: admin })).json.jobs.find((x) => x.id === rr.json.id);
      assert.equal(j3.scope, '聽經目錄（重試）');
      assert.equal(j3.state, 'done'); assert.equal(j3.failed, 0); assert.equal(j3.generated, n);
      const e3 = await post('/api/admin/tts/jobs/estimate', { scope: 'listen:catalog', voices: ['v1', 'v2'] }, admin);
      assert.equal(e3.json.total.missing, 0);
      for (const j of [j1, j2, j3]) await post(`/api/admin/tts/jobs/${j.id}`, { action: 'delete' }, admin);
      delete config.settings.listenCatalog;
      store.clear();
    });

    test('失敗原因：被截斷的聲音另外標出', () => {
      const { failureReason, jobEntry } = tts._internals;
      assert.equal(failureReason(Object.assign(new Error('truncated: reference recording too long'), { truncated: true })).kind, 'truncated');
      assert.equal(failureReason(new Error('implausible duration 10 ms for 20 chars')).kind, 'duration');
      assert.equal(failureReason(new Error('HTTP 500')).kind, 'error');
      assert.deepEqual(jobEntry('a/b.md'), { path: 'a/b.md', from: 0, to: 0, label: 'b.md' });
      assert.deepEqual(jobEntry({ p: 'a/b.md', from: 3, to: 9, name: '普門品' }), { path: 'a/b.md', from: 3, to: 9, label: '普門品' });
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

  test('normalizeVoiceDir：絕對路徑、去引號與結尾斜線；相對路徑不收', () => {
    assert.equal(I.normalizeVoiceDir('/Users/jm/SyncDev/23-ref Audio/'), '/Users/jm/SyncDev/23-ref Audio');
    assert.equal(I.normalizeVoiceDir('"/Users/jm/SyncDev/23-ref Audio"'), '/Users/jm/SyncDev/23-ref Audio');
    assert.equal(I.normalizeVoiceDir('C:\\voices\\'), 'C:\\voices');
    assert.equal(I.normalizeVoiceDir(''), '');
    for (const bad of ['voices', './voices', '~/voices', '/a\nb', 'x'.repeat(501)]) assert.equal(I.normalizeVoiceDir(bad), null, bad);
    assert.equal(I.validateSettings({ voiceDir: 'rel' }, {}).field, 'voiceDir');
    assert.equal(I.validateSettings({ voiceDir: '/v' }, {}).settings.voiceDir, '/v');
  });

  test('inspectVoiceDir：列出參考錄音，逐字稿看 .txt 或 prompt_text；inPrompt 只看 prompt_text', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mdw-voices-'));
    for (const f of ['甲.wav', '乙.wav', '丙.mp3', '.hidden.wav', 'notes.md']) fs.writeFileSync(path.join(d, f), 'x');
    fs.writeFileSync(path.join(d, '乙.txt'), '逐字稿');
    fs.writeFileSync(path.join(d, 'prompt_text'), '甲|你好。\n丙|\n丁|沒有錄音\n');
    const r = I.inspectVoiceDir(d);
    assert.equal(r.exists, true); assert.equal(r.promptText, true);
    assert.deepEqual(r.voices.map(v => [v.name, v.transcript, v.inPrompt, v.txtFile]).sort(),
      [['丙', false, false, false], ['乙', true, false, true], ['甲', true, true, false]].sort());
    assert.deepEqual(r.extraTranscripts, ['丁']);
    assert.equal(I.inspectVoiceDir(path.join(d, 'nope')).exists, false);
    assert.equal(I.inspectVoiceDir(path.join(d, 'notes.md')).notDir, true);
    assert.deepEqual(I.inspectVoiceDir(''), { configured: false });
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('缺逐字稿的 WAV 用 ASR 補成 .txt（不覆蓋），再重建 prompt_text（留 .bak、去掉沒有錄音的舊名）', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mdw-voices-'));
    fs.writeFileSync(path.join(d, 'RA-甲.wav'), 'RIFFfake');
    fs.writeFileSync(path.join(d, 'RA-乙.wav'), 'RIFFfake');
    fs.writeFileSync(path.join(d, 'RA-丙.mp3'), 'x');
    fs.writeFileSync(path.join(d, 'RA-乙.txt'), '乙的稿子\n');
    fs.writeFileSync(path.join(d, 'prompt_text'), 'Old-Name|舊的\n');
    const calls = [];
    I.setFetch(async (url, opt) => {
      calls.push({ url, model: opt.body.get('model') });
      return new Response(JSON.stringify({ text: '如是我聞。\n一時|佛在' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    try {
      const s = { voiceDir: d, baseUrl: 'http://asr.test', asrModel: 'qwen3-asr' };
      assert.equal(I.startVoiceTranscribe(s, { force: true }), true);
      for (let i = 0; i < 100 && I.voiceAsrState().running; i++) await new Promise(r => setTimeout(r, 10));
      assert.equal(calls.length, 1, '只有缺稿的 WAV 送 ASR');
      assert.equal(calls[0].url, 'http://asr.test/v1/audio/transcriptions');
      assert.equal(calls[0].model, 'qwen3-asr');
      assert.equal(fs.readFileSync(path.join(d, 'RA-甲.txt'), 'utf8'), '如是我聞。 一時 佛在\n');
      assert.equal(fs.readFileSync(path.join(d, 'prompt_text'), 'utf8'), 'RA-乙|乙的稿子\nRA-甲|如是我聞。 一時 佛在\n');
      assert.equal(fs.readFileSync(path.join(d, 'prompt_text.bak'), 'utf8'), 'Old-Name|舊的\n');
      const st = I.voiceAsrState();
      assert.deepEqual(st.done.map(x => x.name), ['RA-甲']);
      assert.deepEqual(st.errors.map(x => x.name), ['RA-丙']); // 不是 WAV
      // 什麼都不缺之後不再啟動
      fs.writeFileSync(path.join(d, 'RA-丙.txt'), '丙');
      I.rebuildPromptText(d);
      assert.equal(I.startVoiceTranscribe(s, { force: true }), false);
    } finally {
      I.setFetch(null);
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  test('ASR 回的簡體字轉成台灣繁體；.txt 跟 prompt_text 不一致時算要重建', async () => {
    assert.equal(I.toTraditional('今天我们要深入的是唐代，人类心理与宇宙实相'), '今天我們要深入的是唐代，人類心理與宇宙實相');
    assert.equal(I.toTraditional('如是我聞，一時佛在舍衛國'), '如是我聞，一時佛在舍衛國');
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mdw-voices-'));
    try {
      fs.writeFileSync(path.join(d, 'RA-甲.wav'), 'RIFFfake');
      fs.writeFileSync(path.join(d, 'RA-甲.txt'), '人類心理與宇宙實相\n');
      fs.writeFileSync(path.join(d, 'prompt_text'), 'RA-甲|人类心理与呃宇宙实相\n');
      const v = I.inspectVoiceDir(d).voices[0];
      assert.equal(v.stale, true); assert.equal(v.text, '人類心理與宇宙實相');
      // 不用 ASR，只重建 prompt_text（照 .txt）
      I.setFetch(async () => { throw new Error('不該呼叫 ASR'); });
      assert.equal(I.startVoiceTranscribe({ voiceDir: d, baseUrl: 'http://asr.test', asrModel: 'qwen3-asr' }, { force: true }), true);
      for (let i = 0; i < 100 && I.voiceAsrState().running; i++) await new Promise(r => setTimeout(r, 10));
      assert.equal(fs.readFileSync(path.join(d, 'prompt_text'), 'utf8'), 'RA-甲|人類心理與宇宙實相\n');
      assert.equal(I.inspectVoiceDir(d).voices[0].stale, false);
    } finally { I.setFetch(null); fs.rmSync(d, { recursive: true, force: true }); }
  });

  test('指定音色重新 ASR：覆蓋原本的 .txt，簡體轉繁體', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mdw-voices-'));
    try {
      fs.writeFileSync(path.join(d, 'RA-甲.wav'), 'RIFFfake');
      fs.writeFileSync(path.join(d, 'RA-乙.wav'), 'RIFFfake');
      fs.writeFileSync(path.join(d, 'RA-甲.txt'), '舊稿\n');
      fs.writeFileSync(path.join(d, 'RA-乙.txt'), '乙稿\n');
      const calls = [];
      I.setFetch(async () => { calls.push(1); return new Response(JSON.stringify({ text: '欢迎来到思辨之境' }), { status: 200, headers: { 'Content-Type': 'application/json' } }); });
      assert.equal(I.startVoiceTranscribe({ voiceDir: d, baseUrl: 'http://asr.test', asrModel: 'qwen3-asr' }, { force: true, names: ['RA-甲'] }), true);
      for (let i = 0; i < 100 && I.voiceAsrState().running; i++) await new Promise(r => setTimeout(r, 10));
      assert.equal(calls.length, 1);
      assert.equal(fs.readFileSync(path.join(d, 'RA-甲.txt'), 'utf8'), '歡迎來到思辨之境\n');
      assert.equal(fs.readFileSync(path.join(d, 'RA-乙.txt'), 'utf8'), '乙稿\n');
      assert.equal(fs.readFileSync(path.join(d, 'prompt_text'), 'utf8'), 'RA-乙|乙稿\nRA-甲|歡迎來到思辨之境\n');
      assert.equal(I.startVoiceTranscribe({ voiceDir: d, baseUrl: 'http://asr.test', asrModel: 'qwen3-asr' }, { force: true, names: ['不存在'] }), false);
    } finally { I.setFetch(null); fs.rmSync(d, { recursive: true, force: true }); }
  });

  test('estimateRefBudget：依實測校正（18 秒＋288 字可生成滿 1024 格；76 秒＋1178 字只剩約 4 秒）', () => {
    const a = I.estimateRefBudget(18186, 288, 5);
    assert.ok(Math.abs(a.promptRows - 510) < 40, `promptRows ${a.promptRows}`);
    assert.equal(a.frames, 1024);
    const b = I.estimateRefBudget(75829, 1178, 44);
    assert.ok(b.promptRows >= 1962, `估算要偏保守：${b.promptRows}`);
    assert.ok(b.maxMs < 4500 && b.maxMs >= 0);
    const c = I.estimateRefBudget(120000, 1314, 10);
    assert.equal(c.frames, 0); assert.equal(c.maxChars, 0);
  });

  test('parseSilences／pickTrimPoint：切在 12–28 秒間最接近 20 秒的停頓；沒有停頓就切 20 秒', () => {
    const log = '[silencedetect @ 0x1] silence_start: 5.2\n[silencedetect @ 0x1] silence_end: 5.6 | silence_duration: 0.4\n' +
      'silence_start: 17.9\nsilence_end: 18.5 | silence_duration: 0.6\nsilence_start: 23.1\nsilence_end: 23.5\nsilence_start: 31\n';
    const sil = I.parseSilences(log);
    assert.deepEqual(sil, [{ start: 5.2, end: 5.6 }, { start: 17.9, end: 18.5 }, { start: 23.1, end: 23.5 }]);
    assert.deepEqual(I.pickTrimPoint(sil, 76), { sec: 18.2, atPause: true });
    assert.deepEqual(I.pickTrimPoint([{ start: 5, end: 6 }], 76), { sec: 20, atPause: false });
  });

  test('trimReferenceVoice：剪短、原檔移到 _原始錄音、ASR 重做逐字稿（需要本機 ffmpeg）', async (t) => {
    const ff = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', path.join(os.homedir(), '.local/bin/ffmpeg')].find(f => fs.existsSync(f));
    if (!ff) { t.skip('沒有 ffmpeg'); return; }
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mdw-voices-'));
    I.setFfmpeg({ path: ff, ok: true });
    try {
      // 40 秒的錄音，19.0–19.8 秒是靜音
      const w = makeWav(40000); const rate = 8000;
      w.fill(0, 44 + Math.round(19.0 * rate) * 2, 44 + Math.round(19.8 * rate) * 2);
      fs.writeFileSync(path.join(d, 'RA-長.wav'), w);
      fs.writeFileSync(path.join(d, 'RA-長.txt'), '很長的舊稿\n');
      fs.writeFileSync(path.join(d, 'prompt_text'), 'RA-長|很長的舊稿\n');
      I.setFetch(async () => new Response(JSON.stringify({ text: '剪过的稿' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      const s = { voiceDir: d, baseUrl: 'http://asr.test', asrModel: 'qwen3-asr' };
      const r = await I.trimReferenceVoice(s, 'RA-長');
      assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.atPause, true);
      assert.ok(r.toSec > 19 && r.toSec < 19.8, String(r.toSec));
      assert.equal(r.original, path.join('_原始錄音', 'RA-長.wav'));
      assert.equal(I.readWavInfo(path.join(d, '_原始錄音', 'RA-長.wav')).ms, 40000);
      assert.equal(fs.readFileSync(path.join(d, '_原始錄音', 'RA-長.txt'), 'utf8'), '很長的舊稿\n');
      assert.ok(Math.abs(I.readWavInfo(path.join(d, 'RA-長.wav')).ms - r.toSec * 1000) < 100);
      for (let i = 0; i < 200 && I.voiceAsrState().running; i++) await new Promise(res => setTimeout(res, 10));
      assert.equal(fs.readFileSync(path.join(d, 'prompt_text'), 'utf8'), 'RA-長|剪過的稿\n');
      assert.deepEqual(fs.readdirSync(d).filter(f => f.startsWith('.')), [], '暫存檔要清掉');
      // 已經夠短：不再剪
      const again = await I.trimReferenceVoice(s, 'RA-長');
      assert.equal(again.code, 'NOT_LONG');
    } finally { I.setFetch(null); I.setFfmpeg({ ok: false }); fs.rmSync(d, { recursive: true, force: true }); }
  });

  test('readWavInfo 只讀檔頭算長度；不是 WAV 回 null', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mdw-voices-'));
    try {
      fs.writeFileSync(path.join(d, 'a.wav'), makeWav(2500));
      fs.writeFileSync(path.join(d, 'b.wav'), 'not a wav');
      assert.deepEqual(I.readWavInfo(path.join(d, 'a.wav')), { rate: 8000, channels: 1, bits: 16, ms: 2500 });
      assert.equal(I.readWavInfo(path.join(d, 'b.wav')), null);
      assert.equal(I.readWavInfo(path.join(d, 'nope.wav')), null);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });

  test('audio.cpp 已不再列出的音色算「已不存在」；清單未知或換了伺服器時不算', () => {
    const s = { baseUrl: 'http://a.test' };
    I.resetUpstreamVoices();
    assert.equal(I.voiceGone(s, { voice: 'RA-甲' }), false);
    I.setUpstreamVoices('http://a.test', ['RA-甲']);
    assert.equal(I.voiceGone(s, { voice: 'RA-甲' }), false);
    assert.equal(I.voiceGone(s, { voice: 'Ref-Audio-舊' }), true);
    assert.equal(I.voiceGone({ baseUrl: 'http://b.test' }, { voice: 'Ref-Audio-舊' }), false);
    I.resetUpstreamVoices();
  });

  test('內建佛經讀音表：每條都有讀法、注音與依據；疊在自訂字典下面，自訂有讀法時優先；只寫詞不影響', () => {
    const lx = require('../lib/tts-lexicon.js');
    const Seg = require('../tts-segment.js');
    fs.rmSync(process.env.TTS_LEXICON_PATH, { force: true }); lx.resetCache();
    const rows = lx.builtinRows();
    assert.ok(rows.length >= 30);
    for (const r of rows) { assert.ok(r.word && r.to && r.reading && r.source, r.word); assert.notEqual(r.word, r.to); }
    const words = new Set(); for (const r of rows) { assert.ok(!words.has(r.word), `重複：${r.word}`); words.add(r.word); }
    const say = (t, on) => Seg.oralize(t, 'sent', { lexicon: lx.entries(on) });
    assert.equal(say('南無阿彌陀佛', true), '拿摩阿彌陀佛');          // 預設字典裡「南無」只是斷句保護，不擋內建讀法
    assert.equal(say('般若波羅蜜多心經', true), '波惹波羅蜜多心經');
    assert.equal(say('摩訶迦葉', true), '摩呵迦攝');                 // 長詞先換
    assert.equal(say('佛在舍衛國祇樹給孤獨園', true), '佛在社衛國旗樹擠孤獨園');
    assert.equal(say('瑜伽行者', true), '瑜伽行者');                 // 一般「瑜伽」不改
    // 聽經目錄全面校對補充的條目
    assert.equal(say('維摩詰稽首佛足', true), '維摩潔啟首佛足');
    assert.equal(say('發大乘心，說一乘法', true), '發大聖心，說一聖法');
    assert.equal(say('毘盧遮那佛', true), '皮盧遮那佛');
    assert.equal(say('優婆塞、優婆夷', true), '優婆色、優婆夷');
    assert.equal(say('解脫諸縛，破無明闇', true), '解脫諸父，破無明暗');
    assert.equal(say('金銀七寶', true), '金吟七寶');
    assert.equal(say('般若', false), '般若');                        // 關掉內建
    assert.notEqual(lx.version(true), lx.version(false));            // 開關內建會讓斷句快取重算
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

describe('音色中文名自動去掉前後非中文字', () => {
  test('trimVoiceName 與 sanitizeVoices', () => {
    const I = require('../lib/tts')._internals;
    assert.equal(I.trimVoiceName('RA-m-米陸'), '米陸');
    assert.equal(I.trimVoiceName('RA-female-芙蓉2'), '芙蓉2');
    assert.equal(I.trimVoiceName('RA-male-都A1'), '都A1');
    assert.equal(I.trimVoiceName('demo_1_man'), 'demo_1_man');
    const out = I.sanitizeVoices([{ voice: 'RA-f-托瓦' }, { voice: 'RA-m-菩提', name: ' RA-m-菩提 ' }, { voice: 'x', name: '男聲・都' }]);
    assert.deepEqual(out.map(v => v.name), ['托瓦', '菩提', '男聲・都']);
  });
});
