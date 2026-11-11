/**
 * @file lib/tts.js — 朗讀（TTS）：audio.cpp 代理、生成佇列、後製、文件斷句快取與路由
 *
 * 瀏覽器只和 mdWebview 說話，只能傳「路徑、位置、音色代號、句子序號」；audio.cpp 的網址、
 * 模型、voice 名稱都只在後台設定（或環境變數），而且對外只連寫死的四條路徑，
 * 模型管理端點完全不碰。朗讀的文字一律由伺服器從原檔取得，不接受前端傳來的文字。
 *
 * 實測過的 audio.cpp 回應格式（v0.9.4-dev，見 ARCHITECTURE.md「朗讀（TTS）」）：
 *   GET  /health            {"status":"ok","backend":…,"version":…,"git":…}
 *   GET  /v1/models         {"data":[{"id","family","task":"tts"|"asr","mode","loaded",…}]}
 *   GET  /v1/audio/voices   {"voices":["demo_1_man",…]}（只有名稱）
 *   POST /v1/audio/speech   200 audio/wav（PCM16，標頭 x-audiocpp-audio-duration-ms）；
 *                           錯誤一律 application/json {"error":{"message","type"}}，忙碌 503 server_busy。
 *                           `response_format` 與 `language` 會被忽略、不支援 `speed` 的模型回 500。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { Worker } = require('worker_threads');

const { APP_ROOT, IS_SINGLE_USER, SECURITY_HEADERS } = require('./constants');
const { config, saveConfig } = require('./config');
const { getClientIP, parseByteRange, isRealPathWithinRoot } = require('./utils');
const { readJSONBody, requireAdmin, isAuthorizedAdmin, verifySameOrigin } = require('./auth');
const { sendJSON } = require('./static-cache');
const { Logger } = require('./logger');
const store = require('./tts-store');
const lexicon = require('./tts-lexicon');
const Seg = require('../tts-segment.js');

const KEY_VERSION = 'v1';
const SAMPLE_TEXT = '應無所住，而生其心。';
const UPSTREAM_PATHS = { health: '/health', models: '/v1/models', voices: '/v1/audio/voices', speech: '/v1/audio/speech' };
const HEALTH_INTERVAL_MS = 2 * 60 * 1000;
const HEALTH_TIMEOUT_MS = 3000;
const SPEECH_TIMEOUT_MS = 120 * 1000;
const LONG_POLL_MS = 25 * 1000;
const FAIL_MEMO_MS = 30 * 1000;
const MAX_IDS_PER_REQUEST = 8;
const MAX_DOC_SENTENCES = 600;        // 一次 /api/tts/doc 最多回幾句
const WORKER_MIN_BYTES = 1024 * 1024; // 這麼大的檔改在 Worker 斷句，不卡主執行緒
const DOC_CACHE_MAX = 12;
const DOC_CACHE_MAX_UNITS = 800000;
const WARMUP_SENTENCES = 5;
const TEMP_TTL_MS = 10 * 60 * 1000;
const PRIORITY = { now: 0, prefetch: 1, warm: 2, bulk: 3 };
const POST_AAC = 'aac64-ln18-1';      // 後製設定版本（進快取鍵）：AAC-LC 64k 單聲道、裁靜音、-18 LUFS
const POST_WAV = 'wav-1';             // 沒有 ffmpeg：原樣存 WAV
const FFMPEG_FILTER = 'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.02,areverse,' +
  'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.02,areverse,loudnorm=I=-18:TP=-1.5:LRA=11';

const DEFAULT_SETTINGS = {
  enabled: false,
  baseUrl: '',
  model: '',
  voices: [],            // [{ id, voice, name, tags, rate, enabled }]
  defaultVoice: '',
  seed: 1234,
  concurrency: 1,
  maxSentenceChars: 120,
  guestGenerate: false,
  perUserHour: 600,
  perIpHour: 900,
  cacheMb: 20480,
  readNotes: false,
  readMantra: true,
  readNonScripture: false,
  warmup: true,
  maxSelectionChars: 3000,
  busyTimeoutMs: 30000
};

let deps = { resolveMdPath: null };
let healthTimer = null;
let health = { ok: false, checkedAt: 0, error: 'not checked', info: null };
let ffmpeg = { checked: false, path: '', ok: false };
let fetchImpl = (...a) => fetch(...a);

// ── 設定 ─────────────────────────────────────────────────────────────

function envValue(name) { return String(process.env[name] || '').trim(); }

/** 生效的設定：config.settings.tts 疊上預設值；TTS_BASE_URL／TTS_MODEL／TTS_CACHE_MB 環境變數優先。 */
function getSettings() {
  const s = Object.assign({}, DEFAULT_SETTINGS, (config.settings && config.settings.tts) || {});
  const locked = {};
  if (envValue('TTS_BASE_URL')) { s.baseUrl = normalizeBaseUrl(envValue('TTS_BASE_URL')) || ''; locked.baseUrl = true; }
  if (envValue('TTS_MODEL')) { s.model = envValue('TTS_MODEL'); locked.model = true; }
  if (envValue('TTS_CACHE_MB') && Number(envValue('TTS_CACHE_MB')) > 0) { s.cacheMb = Math.floor(Number(envValue('TTS_CACHE_MB'))); locked.cacheMb = true; }
  s.voices = Array.isArray(s.voices) ? s.voices : [];
  s.locked = locked;
  return s;
}

/** 只留 origin（http／https、不帶帳密、路徑、查詢）；不合法回傳 null。 */
function normalizeBaseUrl(raw) {
  const str = String(raw || '').trim();
  if (!str) return '';
  let u;
  try { u = new URL(str); } catch (_) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  return u.origin;
}

const VOICE_NAME_RE = /^[^\/\\\x00-\x1f]{1,100}$/;

function sanitizeVoices(list) {
  if (!Array.isArray(list)) return null;
  if (list.length > 24) return null;
  const out = []; const ids = new Set();
  for (const v of list) {
    if (!v || typeof v !== 'object') return null;
    const voice = String(v.voice || '').trim();
    if (!VOICE_NAME_RE.test(voice) || voice.includes('..')) return null;
    let id = typeof v.id === 'string' && /^v[0-9a-z]{1,10}$/.test(v.id) && !ids.has(v.id) ? v.id : '';
    if (!id) do { id = 'v' + crypto.randomBytes(3).toString('hex'); } while (ids.has(id));
    ids.add(id);
    const rate = Number(v.rate);
    out.push({
      id, voice,
      name: String(v.name || voice).trim().slice(0, 40) || voice,
      tags: (Array.isArray(v.tags) ? v.tags : []).map((t) => String(t).trim().slice(0, 20)).filter(Boolean).slice(0, 6),
      rate: rate >= 0.5 && rate <= 2 ? Math.round(rate * 100) / 100 : 1,
      enabled: v.enabled !== false
    });
  }
  return out;
}

const clampInt = (v, lo, hi, dflt) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt; };

/** 驗證後台送來的設定；回傳 { settings } 或 { error, field }。環境變數鎖定的欄位維持原值。 */
function validateSettings(input, current) {
  const cur = Object.assign({}, DEFAULT_SETTINGS, current || {});
  const next = Object.assign({}, cur);
  const has = (k) => input[k] !== undefined && input[k] !== null;
  if (has('baseUrl')) {
    const b = normalizeBaseUrl(input.baseUrl);
    if (b === null) return { error: '伺服器網址必須是 http:// 或 https:// 開頭，且不含帳號密碼', field: 'baseUrl' };
    next.baseUrl = b;
  }
  if (has('model')) {
    const m = String(input.model).trim();
    if (m && !/^[\w.\-:]{1,100}$/.test(m)) return { error: '模型代號格式不正確', field: 'model' };
    next.model = m;
  }
  if (has('voices')) {
    const v = sanitizeVoices(input.voices);
    if (!v) return { error: '音色清單格式不正確（voice 不可含路徑，最多 24 個）', field: 'voices' };
    next.voices = v;
  }
  if (has('defaultVoice')) next.defaultVoice = String(input.defaultVoice);
  if (!next.voices.some((v) => v.id === next.defaultVoice && v.enabled)) {
    const first = next.voices.find((v) => v.enabled);
    next.defaultVoice = first ? first.id : '';
  }
  for (const k of ['enabled', 'guestGenerate', 'readNotes', 'readMantra', 'readNonScripture', 'warmup']) if (has(k)) next[k] = input[k] === true;
  if (has('seed')) next.seed = clampInt(input.seed, 0, 2147483647, cur.seed);
  if (has('concurrency')) next.concurrency = clampInt(input.concurrency, 1, 4, cur.concurrency);
  if (has('maxSentenceChars')) next.maxSentenceChars = clampInt(input.maxSentenceChars, 40, 200, cur.maxSentenceChars);
  if (has('perUserHour')) next.perUserHour = clampInt(input.perUserHour, 10, 100000, cur.perUserHour);
  if (has('perIpHour')) next.perIpHour = clampInt(input.perIpHour, 10, 100000, cur.perIpHour);
  if (has('cacheMb')) next.cacheMb = clampInt(input.cacheMb, 64, 4 * 1024 * 1024, cur.cacheMb);
  if (has('maxSelectionChars')) next.maxSelectionChars = clampInt(input.maxSelectionChars, 200, 20000, cur.maxSelectionChars);
  if (has('busyTimeoutMs')) next.busyTimeoutMs = clampInt(input.busyTimeoutMs, 1000, 300000, cur.busyTimeoutMs);
  return { settings: next };
}

function segmentOptions(s) {
  return { maxLen: s.maxSentenceChars, readNotes: s.readNotes, readNonScripture: s.readNonScripture, lexicon: lexicon.entries() };
}

/** 會改變斷句或口語化文字的全站設定＋字典版本：文件斷句快取用它判斷是否要重切。 */
function segmentSignature(s) {
  return [s.maxSentenceChars, s.readNotes ? 1 : 0, s.readNonScripture ? 1 : 0, lexicon.version()].join('|');
}

function findVoice(s, id) { return s.voices.find((v) => v.id === id && v.enabled) || null; }

function voiceKey(s, voice) { return [s.model, voice.voice, s.seed, ffmpegReady() ? POST_AAC : POST_WAV].join('\n'); }

/** 快取鍵：口語化之後的文字＋模型＋音色＋seed＋後製版本。字典與斷句規則的版本不進鍵。 */
function blobSha(spoken, vKey) {
  return crypto.createHash('sha256').update(`${KEY_VERSION}\n${spoken}\n${vKey}`).digest('hex');
}

// ── ffmpeg ───────────────────────────────────────────────────────────

function detectFfmpeg(force) {
  if (ffmpeg.checked && !force) return ffmpeg;
  const candidates = [envValue('TTS_FFMPEG'), 'ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg',
    path.join(process.env.HOME || '', '.local/bin/ffmpeg')].filter(Boolean);
  ffmpeg = { checked: true, path: '', ok: false };
  if (/^(off|0|false|none)$/i.test(envValue('TTS_FFMPEG'))) return ffmpeg;
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 5000 });
      if (r.status === 0 && /\baac\b/.test(r.stdout || '')) { ffmpeg = { checked: true, path: c, ok: true }; break; }
    } catch (_) { /* 試下一個 */ }
  }
  return ffmpeg;
}

function ffmpegReady() { return detectFfmpeg(false).ok; }

/** WAV → 裁頭尾靜音、響度正規化、AAC-LC 64k 單聲道 m4a（faststart：可邊下載邊播）。 */
function transcode(wav, outFile) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'wav', '-i', 'pipe:0', '-af', FFMPEG_FILTER,
      '-ar', '44100', '-ac', '1', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', '-progress', 'pipe:1', '-f', 'ipod', outFile];
    const p = spawn(ffmpeg.path, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} }, 60000);
    p.stdout.on('data', (d) => { out += d; if (out.length > 65536) out = out.slice(-8192); });
    p.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${err.trim().slice(0, 300)}`));
      const m = out.match(/out_time_(?:us|ms)=(\d+)(?![\s\S]*out_time_(?:us|ms)=)/);
      resolve({ ms: m ? Math.round(Number(m[1]) / 1000) : 0 });
    });
    p.stdin.on('error', () => {});
    p.stdin.end(wav);
  });
}

// ── audio.cpp ────────────────────────────────────────────────────────

async function upstreamJson(base, key, query) {
  const res = await fetchImpl(base + UPSTREAM_PATHS[key] + (query || ''), { redirect: 'error', signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function checkHealth() {
  const s = getSettings();
  if (!s.baseUrl) { health = { ok: false, checkedAt: Date.now(), error: 'not configured', info: null }; return health; }
  try {
    const h = await upstreamJson(s.baseUrl, 'health');
    if (!h || h.status !== 'ok') throw new Error('status is not ok');
    health = { ok: true, checkedAt: Date.now(), error: '', info: { backend: h.backend || '', version: h.version || '', git: h.git || '', gitDate: h.git_date || '' } };
  } catch (err) {
    if (health.ok) Logger.warn('TTS', `audio.cpp is unreachable: ${err.message}`);
    health = { ok: false, checkedAt: Date.now(), error: String(err.message || err).slice(0, 200), info: null };
  }
  return health;
}

/** 後台「儲存並檢查」：健康狀態＋可用的 TTS 模型＋音色名稱。模型的磁碟路徑不回傳。 */
async function probe(base, model) {
  const out = { ok: false, health: null, models: [], voices: [], error: '' };
  if (!base) { out.error = '尚未設定伺服器網址'; return out; }
  try {
    const h = await upstreamJson(base, 'health');
    out.health = { status: h.status, backend: h.backend || '', version: h.version || '', git: h.git || '', gitDate: h.git_date || '' };
    const m = await upstreamJson(base, 'models', '?include_params=true');
    out.models = (Array.isArray(m && m.data) ? m.data : []).filter((x) => x && x.task === 'tts').map((x) => ({
      id: String(x.id), family: String(x.family || ''), mode: String(x.mode || ''), loaded: x.loaded === true,
      seed: Array.isArray(x.params) && x.params.some((p) => p && p.name === 'seed')
    }));
    const v = await upstreamJson(base, 'voices', model ? `?model=${encodeURIComponent(model)}` : '');
    out.voices = (Array.isArray(v && v.voices) ? v.voices : []).filter((x) => typeof x === 'string' && VOICE_NAME_RE.test(x)).slice(0, 200);
    out.ok = h.status === 'ok';
  } catch (err) { out.error = String(err.message || err).slice(0, 200); }
  return out;
}

/** 解析 WAV；不是合法的 PCM WAV 就丟錯（錯誤內容絕不能進快取）。 */
function parseWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error('response is not a WAV file');
  }
  let pos = 12; let fmt = null; let dataLen = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('latin1', pos, pos + 4); const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ' && pos + 24 <= buf.length) fmt = { format: buf.readUInt16LE(pos + 8), channels: buf.readUInt16LE(pos + 10), rate: buf.readUInt32LE(pos + 12), bits: buf.readUInt16LE(pos + 22) };
    if (id === 'data') { dataLen = Math.min(size, buf.length - pos - 8); break; }
    pos += 8 + size + (size % 2);
  }
  if (!fmt || !fmt.rate || !fmt.channels || !fmt.bits || dataLen <= 0) throw new Error('WAV has no audio data');
  return { rate: fmt.rate, channels: fmt.channels, bits: fmt.bits, ms: Math.round(dataLen / (fmt.rate * fmt.channels * fmt.bits / 8) * 1000) };
}

/** 向 audio.cpp 生成一句，驗證是音訊才回傳 WAV。失敗丟錯，err.busy 表示伺服器忙。 */
async function requestSpeech(s, voiceName, spoken) {
  const body = { model: s.model, input: spoken, voice: voiceName, seed: s.seed, busy_timeout_ms: s.busyTimeoutMs };
  const res = await fetchImpl(s.baseUrl + UPSTREAM_PATHS.speech, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(SPEECH_TIMEOUT_MS)
  });
  const type = String(res.headers.get('content-type') || '').toLowerCase();
  const buf = Buffer.from(await res.arrayBuffer());
  if (!res.ok || !type.startsWith('audio/')) {
    let msg = `HTTP ${res.status}`; let kind = '';
    try { const j = JSON.parse(buf.toString('utf8')); if (j && j.error) { msg = String(j.error.message || msg).slice(0, 200); kind = String(j.error.type || ''); } } catch (_) {}
    throw Object.assign(new Error(msg), { status: res.status, busy: res.status === 503 || kind === 'server_busy', client: res.status >= 400 && res.status < 500 });
  }
  const wav = parseWav(buf);
  const chars = Array.from(spoken).length;
  // 時長離譜（實測每字約 0.25 秒）多半是模型出錯：太短是吞字，太長是失控
  if (wav.ms < Math.max(150, chars * 40) || wav.ms > chars * 1500 + 5000) throw new Error(`implausible duration ${wav.ms} ms for ${chars} chars`);
  return { buf, ms: wav.ms };
}

// ── 生成佇列（優先序＋single-flight）─────────────────────────────────

const queues = [[], [], [], []];
const inflight = new Map(); // sha → job
const failed = new Map();   // sha → { at, error }
let running = 0;

function queueStats() { return { running, queued: queues.reduce((n, q) => n + q.length, 0), byPriority: queues.map((q) => q.length) }; }

/**
 * 排入生成。相同 sha 的請求合併；已在排隊的若這次優先序較高就往前移。
 * @returns {Promise<{ sha, ext, ms, bytes }>}
 */
function enqueue(job, priority) {
  const pri = PRIORITY[priority] !== undefined ? PRIORITY[priority] : PRIORITY.prefetch;
  const existing = inflight.get(job.sha);
  if (existing) {
    if (!existing.started && pri < existing.pri) {
      const q = queues[existing.pri]; const at = q.indexOf(existing);
      if (at >= 0) { q.splice(at, 1); existing.pri = pri; queues[pri].push(existing); }
    }
    return existing.promise;
  }
  const f = failed.get(job.sha);
  if (f && Date.now() - f.at < FAIL_MEMO_MS) return Promise.reject(new Error(f.error));
  job.pri = pri; job.started = false;
  job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
  job.promise.catch(() => {});
  inflight.set(job.sha, job);
  queues[pri].push(job);
  setImmediate(pump);
  return job.promise;
}

function pump() {
  const s = getSettings();
  while (running < s.concurrency) {
    const q = queues.find((x) => x.length);
    if (!q) return;
    const job = q.shift();
    job.started = true; running++;
    runJob(job, s).then((r) => { job.resolve(r); }, (err) => {
      failed.set(job.sha, { at: Date.now(), error: String(err.message || err) });
      if (failed.size > 2000) failed.clear();
      store.bump('failed');
      Logger.warn('TTS', `Generation failed (${job.sha.slice(0, 10)}): ${err.message}`);
      job.reject(err);
    }).finally(() => { running--; inflight.delete(job.sha); setImmediate(pump); });
  }
}

async function runJob(job, s) {
  const cached = store.get(job.sha);
  if (cached && fs.existsSync(cached.file)) return cached;
  const t0 = Date.now();
  let got; let lastErr;
  for (let attempt = 0; attempt < 2 && !got; attempt++) {
    try { got = await requestSpeech(s, job.voiceName, job.spoken); }
    catch (err) {
      lastErr = err;
      if (err.client && !err.busy) break; // 4xx：重試也沒用
      if (attempt === 0) await new Promise((r) => setTimeout(r, err.busy ? 1500 : 300));
    }
  }
  if (!got) throw lastErr || new Error('generation failed');
  const rnd = crypto.randomBytes(6).toString('hex');
  let ext; let ms; const tmp = store.tmpPath(`${job.sha}.${rnd}`);
  try {
    if (ffmpegReady()) {
      const r = await transcode(got.buf, tmp);
      ext = 'm4a'; ms = r.ms || got.ms;
      const head = Buffer.alloc(12); const fd = fs.openSync(tmp, 'r');
      try { fs.readSync(fd, head, 0, 12, 0); } finally { fs.closeSync(fd); }
      if (head.toString('latin1', 4, 8) !== 'ftyp' || fs.statSync(tmp).size < 200) throw new Error('transcoded file is not a valid m4a');
    } else {
      fs.writeFileSync(tmp, got.buf); ext = 'wav'; ms = got.ms;
    }
    const blob = store.put(job.sha, tmp, { ext, ms, chars: Array.from(job.spoken).length, voice: job.voiceId || '', flags: job.flags || 0 });
    store.bump('generated'); store.bump('gen_ms', Date.now() - t0);
    const removed = store.gc(s.cacheMb * 1024 * 1024);
    if (removed) Logger.info('TTS', `Cache over ${s.cacheMb} MB: removed ${removed} least recently played files`);
    return blob;
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw err;
  }
}

// ── 限額 ─────────────────────────────────────────────────────────────

const usageLog = new Map(); // key → [timestamps]
const HOUR_MS = 60 * 60 * 1000;

function usedInHour(key) {
  const list = usageLog.get(key);
  if (!list) return 0;
  const cut = Date.now() - HOUR_MS;
  while (list.length && list[0] < cut) list.shift();
  if (!list.length) usageLog.delete(key);
  return list.length;
}

function recordUse(key, n) {
  let list = usageLog.get(key);
  if (!list) { if (usageLog.size > 20000) usageLog.clear(); list = []; usageLog.set(key, list); }
  const now = Date.now();
  for (let i = 0; i < n; i++) list.push(now);
}

function currentUser(req) {
  try { return require('./session').getUser(req); } catch (_) { return null; }
}

/** 這個請求能不能生成新音檔，以及還剩多少額度。單機版不限。 */
function generationAllowance(req, s) {
  if (IS_SINGLE_USER) return { allowed: true, remaining: Infinity, keys: [] };
  const user = currentUser(req);
  const admin = !user && isAuthorizedAdmin(req);
  if (!user && !admin && !s.guestGenerate) return { allowed: false, reason: 'login', remaining: 0, keys: [] };
  const ipKey = 'ip:' + getClientIP(req);
  const userKey = user ? 'u:' + user.id : (admin ? 'admin' : null);
  let remaining = s.perIpHour - usedInHour(ipKey);
  if (userKey) remaining = Math.min(remaining, s.perUserHour - usedInHour(userKey));
  return { allowed: remaining > 0, reason: remaining > 0 ? '' : 'quota', remaining: Math.max(0, remaining), keys: userKey ? [ipKey, userKey] : [ipKey] };
}

// ── 文件斷句快取 ─────────────────────────────────────────────────────

const docCache = new Map(); // relPath → entry（Map 的順序＝LRU）

function segmentInWorker(text, opts) {
  return new Promise((resolve, reject) => {
    const w = new Worker(path.join(APP_ROOT, 'lib', 'tts-segment-worker.js'), { workerData: { text, opts } });
    w.once('message', (m) => { resolve(m); w.terminate(); });
    w.once('error', reject);
    w.once('exit', (code) => { if (code !== 0) reject(new Error(`segment worker exited ${code}`)); });
  });
}

/**
 * 取得文件的句子與章節（依 path＋mtime＋size＋全站設定快取在記憶體）。
 * @returns {Promise<object|null>} null＝找不到檔案或不允許讀取
 */
async function loadDoc(filePath) {
  const r = deps.resolveMdPath ? deps.resolveMdPath(filePath) : null;
  if (!r) return null;
  let st;
  try { st = await fs.promises.stat(r.resolved); } catch (_) { return null; }
  if (!st.isFile() || !(await isRealPathWithinRoot(r.root, r.resolved))) return null;
  const s = getSettings();
  const sig = `${st.size}-${st.mtimeMs}-${segmentSignature(s)}`;
  let e = docCache.get(r.relPath);
  if (e && e.sig === sig) { docCache.delete(r.relPath); docCache.set(r.relPath, e); return e; }
  if (e && e.pending && e.pendingSig === sig) return e.pending;
  const pending = (async () => {
    const text = await fs.promises.readFile(r.resolved, 'utf8');
    const opts = segmentOptions(s);
    let seg;
    if (st.size >= WORKER_MIN_BYTES) seg = await segmentInWorker(text, opts);
    else { const d = Seg.segmentDoc(text, opts); const c = Seg.detectChapters(d.units); seg = { units: d.units, stats: d.stats, layer: c.layer, chapters: c.chapters }; }
    const entry = { relPath: r.relPath, sig, units: seg.units, stats: seg.stats, layer: seg.layer, chapters: seg.chapters, shas: new Map(), title: path.basename(r.relPath).replace(/\.md$/i, '') };
    docCache.delete(r.relPath); docCache.set(r.relPath, entry);
    let total = 0; for (const v of docCache.values()) total += v.units ? v.units.length : 0;
    while ((docCache.size > DOC_CACHE_MAX || total > DOC_CACHE_MAX_UNITS) && docCache.size > 1) {
      const k = docCache.keys().next().value; total -= docCache.get(k).units.length; docCache.delete(k);
    }
    return entry;
  })();
  docCache.set(r.relPath, { pending, pendingSig: sig, units: [] });
  try { return await pending; }
  catch (err) { docCache.delete(r.relPath); throw err; }
}

function shaOf(entry, vKey, i) {
  let arr = entry.shas.get(vKey);
  if (!arr) { if (entry.shas.size > 8) entry.shas.clear(); arr = new Array(entry.units.length); entry.shas.set(vKey, arr); }
  if (!arr[i]) arr[i] = blobSha(entry.units[i].spoken, vKey);
  return arr[i];
}

/** 這個單位在目前的全站設定下要不要播（咒語可設定略過；skip 一律不播）。 */
function isPlayable(u, s) { return u.kind !== 'skip' && (u.kind !== 'mantra' || s.readMantra); }

function describeUnits(entry, from, to, s, vKey) {
  const shas = []; const list = [];
  for (let i = from; i < to; i++) {
    const u = entry.units[i];
    const o = { i, line: u.line, endLine: u.endLine, a: u.a, b: u.b, kind: isPlayable(u, s) ? u.kind : 'skip', text: u.text };
    if (u.group) o.g = u.group;
    if (u.level !== undefined) o.level = u.level;
    if (o.kind !== 'skip' && vKey) { o.sha = shaOf(entry, vKey, i); shas.push(o.sha); }
    list.push(o);
  }
  const have = store.lookup(shas);
  for (const o of list) if (o.sha) { const b = have.get(o.sha); o.cached = !!b; if (b) o.ms = b.ms; }
  return list;
}

// ── 臨時句子（「只讀我選的」的頭尾殘句、後台試聽）─────────────────────

const tempSentences = new Map(); // token → { spoken, at }

function addTemp(spoken) {
  const now = Date.now();
  for (const [k, v] of tempSentences) { if (now - v.at > TEMP_TTL_MS) tempSentences.delete(k); else break; }
  if (tempSentences.size > 5000) tempSentences.clear();
  const token = 'x' + crypto.randomBytes(9).toString('hex');
  tempSentences.set(token, { spoken, at: now });
  return token;
}

// ── 讀者端路由 ───────────────────────────────────────────────────────

function isTtsRoute(pathname) { return pathname.startsWith('/api/tts/') || pathname.startsWith('/api/admin/tts/'); }

let storeTriedAt = 0;
/** 快取在第一次需要時才開（沒啟用朗讀的站不會多出 tts-cache 資料夾）；開失敗每分鐘最多重試一次。 */
function storeReady() {
  if (store.isAvailable()) return true;
  if (Date.now() - storeTriedAt < 60000) return false;
  storeTriedAt = Date.now();
  if (store.open()) return true;
  Logger.warn('TTS', 'Read-aloud cache is unavailable (node:sqlite missing or cache directory not writable)');
  return false;
}

function isUsable(s) { return !!(s.enabled && s.baseUrl && s.model && storeReady()); }

function publicVoices(s) {
  const list = s.voices.filter((v) => v.enabled);
  const shas = list.map((v) => blobSha(SAMPLE_TEXT, voiceKey(s, v)));
  const have = store.lookup(shas);
  return list.map((v, i) => ({ id: v.id, name: v.name, tags: v.tags, rate: v.rate, sample: have.has(shas[i]) ? `/api/tts/audio/${shas[i]}` : null }));
}

function handleStatus(req, res) {
  const s = getSettings();
  if (!s.enabled || !storeReady()) return sendJSON(res, 200, { enabled: false, available: false, voices: [] });
  const allow = generationAllowance(req, s);
  const up = isUsable(s) && health.ok;
  return sendJSON(res, 200, {
    enabled: true,
    available: up,                       // false：朗讀服務暫時無法使用（已快取的音檔仍可播）
    canGenerate: up && allow.allowed,
    generateBlocked: allow.allowed ? '' : allow.reason, // 'login' | 'quota'
    voices: publicVoices(s),
    defaultVoice: s.defaultVoice,
    limits: { maxIds: MAX_IDS_PER_REQUEST, maxSelectionChars: s.maxSelectionChars, maxSentenceChars: s.maxSentenceChars },
    format: ffmpegReady() ? 'm4a' : 'wav',
    sampleText: SAMPLE_TEXT
  });
}

function requireEnabled(res, s) {
  if (s.enabled && storeReady()) return true;
  sendJSON(res, 404, { error: '朗讀功能尚未啟用', code: 'TTS_DISABLED' });
  return false;
}

async function handleDoc(req, res, query) {
  const s = getSettings();
  if (!requireEnabled(res, s)) return;
  const entry = await loadDoc(query.path);
  if (!entry) return sendJSON(res, 404, { error: 'File not found' });
  const voice = findVoice(s, String(query.voice || s.defaultVoice));
  const vKey = voice ? voiceKey(s, voice) : '';
  const base = { path: entry.relPath, title: entry.title, layer: entry.layer, guessed: !!entry.stats.guessed, total: entry.units.length, voice: voice ? voice.id : null };
  let ci = -1;
  if (query.chapter !== undefined) ci = clampInt(query.chapter, 0, Math.max(0, entry.chapters.length - 1), 0);
  else if (query.line !== undefined) { // 「從目前位置朗讀」：找含這一行的章
    const line = clampInt(query.line, 1, 1e9, 1);
    ci = 0;
    for (let k = 0; k < entry.chapters.length; k++) if (entry.chapters[k].line <= line) ci = k; else break;
  }
  if (ci < 0 || !entry.chapters.length) {
    return sendJSON(res, 200, Object.assign(base, { chapters: entry.chapters.map((c) => ({ i: c.i, title: c.title, part: c.part, line: c.line, from: c.from, to: c.to, chars: c.chars, layer: c.layer })) }));
  }
  const c = entry.chapters[ci];
  const offset = clampInt(query.offset, 0, Math.max(0, c.to - c.from - 1), 0);
  const from = c.from + offset; const to = Math.min(c.to, from + MAX_DOC_SENTENCES);
  return sendJSON(res, 200, Object.assign(base, {
    chapter: { i: c.i, title: c.title, part: c.part, line: c.line, from: c.from, to: c.to, chars: c.chars, layer: c.layer, count: entry.chapters.length },
    from, to, more: to < c.to, sentences: describeUnits(entry, from, to, s, vKey)
  }));
}

function parsePos(p) {
  if (!p || typeof p !== 'object') return null;
  const line = Math.floor(Number(p.line)); const off = Math.floor(Number(p.off));
  return line >= 1 && off >= 0 && line < 1e8 && off < 1e7 ? { line, off } : null;
}

async function handleResolve(req, res) {
  const s = getSettings();
  if (!requireEnabled(res, s)) return;
  const body = await readJSONBody(req);
  const start = parsePos(body.start); const end = parsePos(body.end);
  if (typeof body.path !== 'string' || !start || !end || end.line < start.line || (end.line === start.line && end.off <= start.off)) {
    return sendJSON(res, 400, { error: '選取範圍不正確', code: 'BAD_RANGE' });
  }
  const entry = await loadDoc(body.path);
  if (!entry) return sendJSON(res, 404, { error: 'File not found' });
  const voice = findVoice(s, String(body.voice || s.defaultVoice));
  const vKey = voice ? voiceKey(s, voice) : '';
  const snap = Seg.snapSelection(entry.units, start, end, { lexicon: [] });
  if (!snap) return sendJSON(res, 200, { empty: true, sentences: [] });
  const exact = body.exact === true;
  let from = exact ? snap.selFrom : snap.from; let to = exact ? snap.selTo : snap.to;
  // 太長的選取只回前面一段，其餘由前端沿著句子序號繼續要（不卡住畫面）
  let chars = 0; let cut = to;
  for (let i = from; i <= to; i++) { chars += entry.units[i].text.length; if (chars > s.maxSelectionChars || i - from >= MAX_DOC_SENTENCES) { cut = i; break; } }
  const sentences = describeUnits(entry, from, cut + 1, s, vKey);
  if (exact && vKey) { // 頭尾殘句：按實際選取切，屬臨時快取
    const trim = (o, u, a, b) => {
      const text = u.text.slice(Math.max(0, a - u.a), b === null ? undefined : Math.max(0, b - u.a));
      if (!text.trim() || text === u.text || o.kind === 'skip') return;
      const spoken = Seg.oralize(text, u.kind, segmentOptions(s));
      if (!spoken) return;
      o.text = text; o.temp = true; o.id = addTemp(spoken); o.sha = blobSha(spoken, vKey);
      const b0 = store.get(o.sha); o.cached = !!b0; if (b0) o.ms = b0.ms; else delete o.ms;
    };
    const first = sentences[0]; const last = sentences[sentences.length - 1];
    const uf = entry.units[first.i]; const ul = entry.units[last.i];
    const sameUnit = first === last;
    if (uf.endLine === uf.line && start.line === uf.line && start.off > uf.a) {
      trim(first, uf, start.off, sameUnit && end.line === uf.line && end.off < uf.b ? end.off : null);
      if (first.temp) first.a = start.off;
      if (first.temp && sameUnit && end.line === uf.line && end.off < uf.b) first.b = end.off;
    }
    if ((!sameUnit || !first.temp) && cut === to && ul.endLine === ul.line && end.line === ul.line && end.off < ul.b) {
      trim(last, ul, ul.a, end.off);
      if (last.temp) last.b = end.off;
    }
  }
  return sendJSON(res, 200, {
    path: entry.relPath, voice: voice ? voice.id : null,
    from, to, selFrom: snap.selFrom, selTo: snap.selTo, truncatedAt: cut < to ? cut : null,
    flags: exact ? {} : snap.flags, sentences
  });
}

async function handleSpeak(req, res) {
  const s = getSettings();
  if (!requireEnabled(res, s)) return;
  const body = await readJSONBody(req);
  const ids = Array.isArray(body.ids) ? body.ids.slice(0, MAX_IDS_PER_REQUEST) : [];
  if (typeof body.path !== 'string' || !ids.length) return sendJSON(res, 400, { error: '缺少 path 或 ids', code: 'BAD_REQUEST' });
  const voice = findVoice(s, String(body.voice || s.defaultVoice));
  if (!voice) return sendJSON(res, 400, { error: '未知的音色', code: 'UNKNOWN_VOICE' });
  const entry = await loadDoc(body.path);
  if (!entry) return sendJSON(res, 404, { error: 'File not found' });
  const vKey = voiceKey(s, voice);
  const priority = body.priority === 'now' ? 'now' : 'prefetch';
  const items = []; const wanted = [];
  for (const raw of ids) {
    if (typeof raw === 'string' && /^x[0-9a-f]{18}$/.test(raw)) {
      const t = tempSentences.get(raw);
      if (!t) { items.push({ id: raw, state: 'gone' }); continue; }
      const it = { id: raw, sha: blobSha(t.spoken, vKey), spoken: t.spoken, flags: store.FLAG_TEMP };
      items.push(it); wanted.push(it); continue;
    }
    const i = Number(raw);
    if (!Number.isInteger(i) || i < 0 || i >= entry.units.length) { items.push({ i: raw, state: 'gone' }); continue; }
    const u = entry.units[i];
    if (!isPlayable(u, s)) { items.push({ i, state: 'skip' }); continue; }
    const it = { i, sha: shaOf(entry, vKey, i), spoken: u.spoken, flags: 0 };
    items.push(it); wanted.push(it);
  }
  const have = store.lookup(wanted.map((w) => w.sha));
  const missing = [];
  for (const it of wanted) {
    const b = have.get(it.sha);
    if (b) { it.state = 'ready'; it.ms = b.ms; store.bump('hits'); } else missing.push(it);
  }
  if (missing.length) {
    store.bump('misses', missing.length);
    const up = isUsable(s) && health.ok;
    const allow = generationAllowance(req, s);
    const fresh = missing.filter((it) => !inflight.has(it.sha));
    let budget = allow.allowed ? allow.remaining : 0;
    const waits = [];
    for (const it of missing) {
      const already = inflight.has(it.sha);
      if (!up) { it.state = 'unavailable'; continue; }
      if (!already && !allow.allowed) { it.state = allow.reason === 'login' ? 'login' : 'quota'; continue; }
      if (!already && budget <= 0) { it.state = 'quota'; continue; }
      if (!already) budget--;
      it.state = 'pending';
      waits.push(enqueue({ sha: it.sha, spoken: it.spoken, voiceName: voice.voice, voiceId: voice.id, flags: it.flags }, priority)
        .then((b) => { it.state = 'ready'; it.ms = b.ms; }, (err) => { it.state = 'failed'; it.error = String(err.message || err).slice(0, 160); }));
    }
    const started = fresh.filter((it) => it.state === 'pending').length;
    if (started) for (const k of allow.keys) recordUse(k, started);
    if (waits.length) {
      let timer;
      await Promise.race([Promise.all(waits), new Promise((r) => { timer = setTimeout(r, LONG_POLL_MS); })]);
      clearTimeout(timer);
    }
    // 順便暖機：即時請求之後，把後面幾句以最低的讀者優先序先生成
    if (priority === 'now' && s.warmup && up && allow.allowed) {
      const lastI = Math.max(-1, ...items.filter((x) => Number.isInteger(x.i)).map((x) => x.i));
      let n = 0; let extra = Math.min(WARMUP_SENTENCES, Math.max(0, budget));
      for (let i = lastI + 1; lastI >= 0 && i < entry.units.length && n < extra; i++) {
        const u = entry.units[i];
        if (u.kind === 'heading' && n > 0) break;
        if (!isPlayable(u, s)) continue;
        const sha = shaOf(entry, vKey, i);
        if (store.get(sha) || inflight.has(sha)) { n++; continue; }
        enqueue({ sha, spoken: u.spoken, voiceName: voice.voice, voiceId: voice.id, flags: 0 }, 'warm').catch(() => {});
        for (const k of allow.keys) recordUse(k, 1);
        n++;
      }
    }
  }
  return sendJSON(res, 200, {
    voice: voice.id,
    items: items.map((it) => {
      const o = { state: it.state };
      if (it.i !== undefined) o.i = it.i; if (it.id) o.id = it.id;
      if (it.sha) { o.sha = it.sha; if (it.state === 'ready') { o.url = `/api/tts/audio/${it.sha}`; o.ms = it.ms; } }
      if (it.error) o.error = it.error;
      return o;
    })
  });
}

/** GET /api/tts/audio/<sha>：只服務快取裡已存在的檔；強 ETag、immutable、支援 Range。 */
function handleAudio(req, res, sha) {
  const b = store.SHA_RE.test(sha) ? store.get(sha) : null;
  let stat = null;
  if (b) { try { stat = fs.statSync(b.file); } catch (_) { store.remove(sha); } }
  if (!b || !stat) {
    res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, SECURITY_HEADERS));
    return res.end('Not found');
  }
  const etag = `"${sha.slice(0, 32)}"`;
  const common = { 'ETag': etag, 'Cache-Control': 'public, max-age=31536000, immutable', 'Accept-Ranges': 'bytes' };
  if (req.headers['if-none-match'] === etag && !req.headers.range) {
    res.writeHead(304, Object.assign({}, SECURITY_HEADERS, common));
    return res.end();
  }
  const ifRange = req.headers['if-range'];
  const range = ifRange && ifRange !== etag ? null : parseByteRange(req.headers.range, stat.size);
  if (range && range.unsatisfiable) {
    res.writeHead(416, Object.assign({ 'Content-Range': `bytes */${stat.size}`, 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
    return res.end();
  }
  const headers = Object.assign({}, SECURITY_HEADERS, common, {
    'Content-Type': b.mime, 'Content-Length': range ? range.end - range.start + 1 : stat.size, 'X-Tts-Duration-Ms': String(b.ms)
  });
  if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD') return res.end();
  if (!range || range.start === 0) store.touch(sha);
  const stream = fs.createReadStream(b.file, range ? { start: range.start, end: range.end } : undefined);
  stream.on('error', () => { res.destroy(); });
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

// ── 後台路由 ─────────────────────────────────────────────────────────

function adminSettingsPayload() {
  const s = getSettings();
  const out = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) out[k] = s[k];
  detectFfmpeg(false);
  return {
    settings: out, locked: s.locked, env: { baseUrl: 'TTS_BASE_URL', model: 'TTS_MODEL', cacheMb: 'TTS_CACHE_MB' },
    health: { ok: health.ok, checkedAt: health.checkedAt, error: health.error, info: health.info },
    ffmpeg: { ok: ffmpeg.ok, path: ffmpeg.path }, storeAvailable: s.enabled ? storeReady() : store.isAvailable(), singleUser: IS_SINGLE_USER,
    sampleText: SAMPLE_TEXT, bounds: { maxSentenceChars: [40, 200], concurrency: [1, 4], cacheMb: [64, 4194304] }
  };
}

async function handleAdminSettingsPost(req, res) {
  const body = await readJSONBody(req);
  const input = body && typeof body.settings === 'object' && body.settings ? body.settings : {};
  const before = getSettings();
  const stored = Object.assign({}, DEFAULT_SETTINGS, (config.settings && config.settings.tts) || {});
  const v = validateSettings(input, stored);
  if (v.error) return sendJSON(res, 400, { error: v.error, code: 'INVALID_FIELD', field: v.field });
  config.settings.tts = v.settings;
  saveConfig();
  const after = getSettings();
  if (segmentSignature(before) !== segmentSignature(after)) docCache.clear();
  const result = { ok: true };
  if (body.check === true || before.baseUrl !== after.baseUrl) {
    result.probe = await probe(after.baseUrl, after.model);
    await checkHealth();
  }
  store.gc(after.cacheMb * 1024 * 1024);
  Logger.info('TTS', 'Read-aloud settings updated', req);
  return sendJSON(res, 200, Object.assign(result, adminSettingsPayload()));
}

async function adminSynthesize(req, res, flags) {
  const s = getSettings();
  const body = await readJSONBody(req);
  const voice = s.voices.find((v) => v.id === body.voice);
  if (!voice) return sendJSON(res, 400, { error: '未知的音色', code: 'UNKNOWN_VOICE' });
  if (!isUsable(s)) return sendJSON(res, 409, { error: '請先啟用朗讀並設定伺服器網址與模型', code: 'TTS_NOT_CONFIGURED' });
  let spoken = SAMPLE_TEXT;
  if (flags === store.FLAG_TEMP) { // 讀音字典試聽：管理員輸入一句，套字典後生成
    const text = String(body.text || '').replace(/\s+/g, ' ').trim();
    if (!text || Array.from(text).length > s.maxSentenceChars) return sendJSON(res, 400, { error: `請輸入 1–${s.maxSentenceChars} 個字`, code: 'BAD_TEXT' });
    lexicon.resetCache();
    spoken = Seg.oralize(text, 'sent', segmentOptions(s));
  }
  const sha = blobSha(spoken, voiceKey(s, voice));
  try {
    const b = await enqueue({ sha, spoken, voiceName: voice.voice, voiceId: voice.id, flags }, 'now');
    return sendJSON(res, 200, { ok: true, sha, url: `/api/tts/audio/${sha}`, ms: b.ms, spoken });
  } catch (err) {
    return sendJSON(res, 502, { error: `生成失敗：${String(err.message || err).slice(0, 200)}`, code: 'TTS_FAILED' });
  }
}

async function handleAdminClear(req, res) {
  const body = await readJSONBody(req);
  if (body.scope === 'all') {
    const n = store.clear();
    Logger.info('TTS', `Cache cleared (${n} files)`, req);
    return sendJSON(res, 200, { ok: true, removed: n });
  }
  if (body.scope === 'path' && typeof body.path === 'string') {
    const s = getSettings();
    const entry = await loadDoc(body.path);
    if (!entry) return sendJSON(res, 404, { error: 'File not found' });
    const shas = [];
    for (const v of s.voices) { const k = voiceKey(s, v); for (const u of entry.units) if (u.spoken) shas.push(blobSha(u.spoken, k)); }
    const n = store.clear(shas);
    return sendJSON(res, 200, { ok: true, removed: n });
  }
  return sendJSON(res, 400, { error: 'scope 必須是 all 或 path', code: 'BAD_REQUEST' });
}

async function handle(req, res, pathname, query) {
  const m = req.method;
  if (pathname.startsWith('/api/admin/tts/')) {
    if (!requireAdmin(req, res, sendJSON)) return true;
    const sub = pathname.slice('/api/admin/tts/'.length);
    if (sub === 'settings' && m === 'GET') { sendJSON(res, 200, adminSettingsPayload()); return true; }
    if (sub === 'settings' && m === 'POST') { await handleAdminSettingsPost(req, res); return true; }
    if (sub === 'health' && m === 'GET') {
      const s = getSettings(); const p = await probe(s.baseUrl, s.model); await checkHealth();
      sendJSON(res, 200, p); return true;
    }
    if (sub === 'sample' && m === 'POST') { await adminSynthesize(req, res, store.FLAG_SAMPLE); return true; }
    if (sub === 'preview' && m === 'POST') { await adminSynthesize(req, res, store.FLAG_TEMP); return true; }
    if (sub === 'lexicon' && m === 'GET') { sendJSON(res, 200, lexicon.describe()); return true; }
    if (sub === 'lexicon' && m === 'POST') {
      const body = await readJSONBody(req);
      if (typeof body.text !== 'string') { sendJSON(res, 400, { error: '缺少 text', code: 'BAD_REQUEST' }); return true; }
      try { const d = lexicon.save(body.text); docCache.clear(); sendJSON(res, 200, Object.assign({ ok: true }, d)); }
      catch (err) { sendJSON(res, err.code === 'TOO_LARGE' ? 413 : 500, { error: err.message, code: err.code || 'WRITE_FAILED' }); }
      return true;
    }
    if (sub === 'cache' && m === 'GET') {
      const s = getSettings(); if (s.enabled) storeReady();
      sendJSON(res, 200, Object.assign(store.usage(), { limitBytes: s.cacheMb * 1024 * 1024, queue: queueStats(), ffmpeg: { ok: ffmpegReady(), path: ffmpeg.path } }));
      return true;
    }
    if (sub === 'cache/clear' && m === 'POST') { await handleAdminClear(req, res); return true; }
    return false;
  }
  if (pathname === '/api/tts/status' && m === 'GET') { handleStatus(req, res); return true; }
  if (pathname === '/api/tts/doc' && m === 'GET') { await handleDoc(req, res, query); return true; }
  if (pathname.startsWith('/api/tts/audio/') && (m === 'GET' || m === 'HEAD')) { handleAudio(req, res, pathname.slice('/api/tts/audio/'.length)); return true; }
  if ((pathname === '/api/tts/resolve' || pathname === '/api/tts/speak') && m === 'POST') {
    if (!verifySameOrigin(req)) { sendJSON(res, 403, { error: '請求來源不符', code: 'BAD_ORIGIN' }); return true; }
    if (pathname === '/api/tts/resolve') await handleResolve(req, res); else await handleSpeak(req, res);
    return true;
  }
  return false;
}

// ── 生命週期 ─────────────────────────────────────────────────────────

/** @param {{ resolveMdPath: Function }} d server.js 的路徑解析（含 .md／隱藏路徑／庫外檢查） */
function init(d) {
  deps = Object.assign(deps, d || {});
  return true;
}

/** 啟動健康檢查與每日維護（伺服器開始 listen 之後呼叫；測試不呼叫，避免留下計時器）。 */
function start() {
  if (healthTimer) return;
  const s = getSettings();
  if (s.enabled) { detectFfmpeg(false); if (!ffmpeg.ok) Logger.warn('TTS', 'ffmpeg not found: audio will be cached as WAV (about 10x larger). Set TTS_FFMPEG or install ffmpeg.'); }
  checkHealth().catch(() => {});
  let ticks = 0;
  healthTimer = setInterval(() => {
    if (getSettings().enabled) checkHealth().catch(() => {});
    if (++ticks % 720 === 0) { try { store.purgeTemp(24 * HOUR_MS); } catch (_) {} } // 約每天一次
  }, HEALTH_INTERVAL_MS);
  healthTimer.unref();
}

function stop() {
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
  store.close(); storeTriedAt = 0;
}

module.exports = {
  init, start, stop, isTtsRoute, handle, checkHealth, getSettings,
  DEFAULT_SETTINGS, SAMPLE_TEXT, PRIORITY,
  // 測試用
  _internals: {
    normalizeBaseUrl, sanitizeVoices, validateSettings, parseWav, blobSha, voiceKey, enqueue, queueStats, loadDoc,
    generationAllowance, usageLog, docCache, failed, detectFfmpeg, probe,
    setFetch(f) { fetchImpl = f || ((...a) => fetch(...a)); },
    setFfmpeg(v) { ffmpeg = Object.assign({ checked: true, path: '', ok: false }, v); },
    setHealth(v) { health = Object.assign({ ok: false, checkedAt: Date.now(), error: '', info: null }, v); },
    reset() { usageLog.clear(); docCache.clear(); failed.clear(); tempSentences.clear(); }
  }
};
