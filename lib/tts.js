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
const { config, saveConfig, getMdRoot } = require('./config');
const { getClientIP, parseByteRange, isRealPathWithinRoot, hasHiddenSegment } = require('./utils');
const { readJSONBody, requireAdmin, isAuthorizedAdmin, verifySameOrigin } = require('./auth');
const { sendJSON } = require('./static-cache');
const { Logger } = require('./logger');
const store = require('./tts-store');
const lexicon = require('./tts-lexicon');
const Seg = require('../tts-segment.js');

const KEY_VERSION = 'v1';
const SAMPLE_TEXT = '應無所住，而生其心。';
const UPSTREAM_PATHS = { health: '/health', models: '/v1/models', voices: '/v1/audio/voices', speech: '/v1/audio/speech', transcriptions: '/v1/audio/transcriptions' };
const HEALTH_INTERVAL_MS = 2 * 60 * 1000;
const HEALTH_TIMEOUT_MS = 3000;
const SPEECH_TIMEOUT_MS = 180 * 1000;
const LONG_POLL_MS = 25 * 1000;
const FAIL_MEMO_MS = 30 * 1000;
const BUSY_RETRY_MS = [1500, 3000];
const MAX_IDS_PER_REQUEST = 8;
const MAX_DOC_SENTENCES = 600;        // 一次 /api/tts/doc 最多回幾句
const WORKER_MIN_BYTES = 1024 * 1024; // 這麼大的檔改在 Worker 斷句，不卡主執行緒
const DOC_CACHE_MAX = 12;
const DOC_CACHE_MAX_UNITS = 800000;
const WARMUP_SENTENCES = 5;
const TEMP_TTL_MS = 10 * 60 * 1000;
const KEEP_WARM_IDLE_MS = 100 * 1000; // 這麼久沒有生成才送保溫請求（實測閒置 3 分鐘內仍是熱的）
const KEEP_WARM_TEXT = '南無阿彌陀佛';
const PRIORITY = { now: 0, prefetch: 1, warm: 2, bulk: 3 };
const POST_AAC = 'aac64-ln18-1';      // 後製設定版本（進快取鍵）：AAC-LC 64k 單聲道、裁靜音、-18 LUFS
const POST_WAV = 'wav-1';             // 沒有 ffmpeg：原樣存 WAV
const FFMPEG_FILTER = 'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.02,areverse,' +
  'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.02,areverse,loudnorm=I=-18:TP=-1.5:LRA=11';

const DEFAULT_SETTINGS = {
  enabled: false,
  baseUrl: '',
  voiceDir: '',          // audio.cpp 的 --voice-dir（只做記錄與檢查：本站不能改 audio.cpp 的啟動參數）
  builtinLexicon: true,  // 疊上內建的佛經讀音表（lib/tts-lexicon-buddhist.txt）
  autoTranscribe: true,  // 打開後台朗讀頁時，缺逐字稿的參考錄音用 audio.cpp 的 ASR 補上 .txt 並重建 prompt_text
  asrModel: 'qwen3-asr', // audio.cpp 上的 ASR 模型代號（要先在 audio.cpp 載入或設成 lazy）
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
  // audio.cpp 冷啟動的那一次推論要 35–45 秒；等待時間比它短的話，排在後面的請求會被
  // audio.cpp 以「前一個請求疑似卡住」立刻拒絕（503 server_busy）。
  busyTimeoutMs: 120000,
  keepWarm: true,        // 有人在聽的期間定時送一句短句，避免 audio.cpp 閒置後冷啟動（實測 35–45 秒）
  keepWarmMinutes: 30    // 最後一次朗讀活動之後保溫多久
};

let deps = { resolveMdPath: null };
let healthTimer = null;
let health = { ok: false, checkedAt: 0, error: 'not checked', info: null };
// audio.cpp 目前回報的音色名稱（每次健康檢查與後台檢查時更新）；null＝還不知道（連不上時沿用上一次的）
let upstreamVoices = { names: null, at: 0, base: '' };
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

/** 音色資料夾：絕對路徑（POSIX 或 Windows），不含控制字元；空字串＝未設定；不合法回傳 null。 */
function normalizeVoiceDir(raw) {
  let str = String(raw == null ? '' : raw).trim();
  if (!str) return '';
  if (str.length > 500 || /[\x00-\x1f]/.test(str)) return null;
  if (/^(['"]).*\1$/.test(str)) str = str.slice(1, -1); // 從啟動指令貼過來常帶引號
  if (!(path.posix.isAbsolute(str) || path.win32.isAbsolute(str))) return null;
  return str.length > 1 ? str.replace(/[\/\\]+$/, '') : str;
}

const VOICE_AUDIO_RE = /\.(wav|mp3|flac|ogg|opus|m4a)$/i;

/** prompt_text 一行「名稱|逐字稿」：逐字稿裡不能有換行或「|」。 */
function cleanTranscript(t) { return String(t || '').replace(/[\r\n|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1000); }

function readPromptText(dir) {
  const map = new Map();
  try {
    const txt = fs.readFileSync(path.join(dir, 'prompt_text'), 'utf8').slice(0, 512 * 1024);
    for (const line of txt.split(/\r?\n/)) {
      const i = line.indexOf('|');
      const t = i > 0 ? line.slice(i + 1).trim() : '';
      if (t) map.set(line.slice(0, i).trim(), t);
    }
  } catch (_) {}
  return map;
}

function readTxtTranscript(dir, name) {
  try { return cleanTranscript(fs.readFileSync(path.join(dir, `${name}.txt`), 'utf8').slice(0, 64 * 1024)); } catch (_) { return ''; }
}

/**
 * 看看音色資料夾（只在 audio.cpp 跟本站同一台主機、看得到這個路徑時有意義）：
 * 列出參考錄音，對照同名 .txt 與 prompt_text（audio.cpp 讀的逐字稿，一行「名稱|逐字稿」）。
 * 只讀檔名、.txt 與 prompt_text，不讀錄音內容；最多看 500 個項目。
 *   transcript：有逐字稿（.txt 或 prompt_text 任一）；inPrompt：prompt_text 裡有這一行（audio.cpp 讀得到）
 */
function inspectVoiceDir(dir) {
  if (!dir) return { configured: false };
  const out = { configured: true, path: dir, exists: false, voices: [], promptText: false, extraTranscripts: [], asr: voiceAsrStatus(dir) };
  let st;
  try { st = fs.statSync(dir); } catch (_) { return out; }
  if (!st.isDirectory()) { out.notDir = true; return out; }
  out.exists = true;
  let names = [];
  try { names = fs.readdirSync(dir).slice(0, 500); } catch (err) { out.error = err.code || 'unreadable'; return out; }
  out.promptText = names.includes('prompt_text');
  const prompt = out.promptText ? readPromptText(dir) : new Map();
  const set = new Set(names);
  for (const f of names.filter((n) => VOICE_AUDIO_RE.test(n) && !n.startsWith('.')).sort()) {
    const name = f.replace(VOICE_AUDIO_RE, '');
    const txtFile = set.has(`${name}.txt`) && !!readTxtTranscript(dir, name);
    out.voices.push({ name, file: f, transcript: txtFile || prompt.has(name), inPrompt: prompt.has(name), txtFile });
  }
  const audioNames = new Set(out.voices.map((v) => v.name));
  out.extraTranscripts = [...prompt.keys()].filter((n) => !audioNames.has(n)).slice(0, 50);
  return out;
}

// ── 參考錄音的逐字稿：缺的用 audio.cpp ASR 補 ──────────────────────────
const ASR_TIMEOUT_MS = 180000;
const ASR_MAX_BYTES = 50 * 1024 * 1024;
let voiceAsr = { dir: '', running: false, startedAt: 0, finishedAt: 0, done: [], errors: [], current: '' };

function voiceAsrStatus(dir) {
  if (voiceAsr.dir !== dir) return { running: false, done: [], errors: [] };
  return { running: voiceAsr.running, current: voiceAsr.current, done: voiceAsr.done.slice(0, 50), errors: voiceAsr.errors.slice(0, 50), finishedAt: voiceAsr.finishedAt };
}

async function transcribeFile(s, file) {
  const buf = fs.readFileSync(file);
  if (buf.length > ASR_MAX_BYTES) throw new Error('錄音檔超過 50 MB');
  const form = new FormData();
  form.append('model', s.asrModel);
  form.append('file', new Blob([buf], { type: 'audio/wav' }), 'voice.wav');
  const res = await fetchImpl(s.baseUrl + UPSTREAM_PATHS.transcriptions, { method: 'POST', body: form, redirect: 'error', signal: AbortSignal.timeout(ASR_TIMEOUT_MS) });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error((data && data.error && data.error.message) || `HTTP ${res.status}`);
  const text = cleanTranscript(data && data.text);
  if (!text) throw new Error('ASR 沒有回傳文字');
  return text;
}

/**
 * 重建 prompt_text：每個參考錄音一行，逐字稿以同名 .txt 為準，沒有 .txt 就沿用 prompt_text 原有的那一行。
 * 錄音已不存在的舊名稱不再寫入；舊檔先留一份 prompt_text.bak。內容沒變就不寫。
 */
function rebuildPromptText(dir) {
  const info = inspectVoiceDir(dir);
  if (!info.exists) return false;
  const prompt = readPromptText(dir);
  const lines = [];
  for (const v of info.voices) {
    const t = readTxtTranscript(dir, v.name) || cleanTranscript(prompt.get(v.name));
    if (t && !v.name.includes('|')) lines.push(`${v.name}|${t}`);
  }
  const next = lines.length ? lines.join('\n') + '\n' : '';
  const file = path.join(dir, 'prompt_text');
  let cur = null;
  try { cur = fs.readFileSync(file, 'utf8'); } catch (_) {}
  if (cur === next || (!next && cur === null)) return false;
  if (cur !== null) fs.writeFileSync(file + '.bak', cur);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, next);
  fs.renameSync(tmp, file);
  return true;
}

/** 需要動手嗎：有錄音缺逐字稿，或 prompt_text 跟 .txt／錄音對不上。 */
function voiceDirNeedsWork(info) {
  if (!info.exists) return false;
  return info.voices.some((v) => !v.transcript || !v.inPrompt) || info.extraTranscripts.length > 0;
}

/** 單一工作：缺 .txt 又不在 prompt_text 裡的 WAV 送 ASR，寫成 .txt（不覆蓋），最後重建 prompt_text。 */
function startVoiceTranscribe(s, opts) {
  const dir = s.voiceDir;
  if (!dir || voiceAsr.running) return false;
  if (!(opts && opts.force) && voiceAsr.dir === dir && Date.now() - voiceAsr.finishedAt < 60000) return false; // 剛跑過：別每次開頁都重跑
  const info = inspectVoiceDir(dir);
  if (!voiceDirNeedsWork(info)) return false;
  voiceAsr = { dir, running: true, startedAt: Date.now(), finishedAt: 0, done: [], errors: [], current: '' };
  (async () => {
    for (const v of info.voices.filter((x) => !x.transcript)) {
      if (!/\.wav$/i.test(v.file)) { voiceAsr.errors.push({ name: v.name, error: '只能轉寫 WAV' }); continue; }
      if (!s.baseUrl || !s.asrModel) { voiceAsr.errors.push({ name: v.name, error: '尚未設定 audio.cpp 網址或 ASR 模型' }); continue; }
      voiceAsr.current = v.name;
      try {
        const text = await transcribeFile(s, path.join(dir, v.file));
        fs.writeFileSync(path.join(dir, `${v.name}.txt`), text + '\n', { flag: 'wx' }); // 已有 .txt 就不覆蓋
        voiceAsr.done.push({ name: v.name, text: text.slice(0, 120) });
        Logger.info('TTS', `Transcribed reference voice ${v.name} (${text.length} chars)`);
      } catch (err) {
        voiceAsr.errors.push({ name: v.name, error: String(err.message || err).slice(0, 200) });
      }
    }
    voiceAsr.current = '';
    try { if (rebuildPromptText(dir)) voiceAsr.promptRebuilt = true; } catch (err) { voiceAsr.errors.push({ name: 'prompt_text', error: String(err.message || err).slice(0, 200) }); }
  })().catch(() => {}).finally(() => { voiceAsr.running = false; voiceAsr.finishedAt = Date.now(); });
  return true;
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
    const rev = Math.floor(Number(v.rev));
    out.push({
      id, voice,
      rev: rev >= 1 && rev <= 9999 ? rev : 1, // 參考錄音換了內容但檔名不變時，把版本加一讓舊快取失效
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
  if (has('voiceDir')) {
    const d = normalizeVoiceDir(input.voiceDir);
    if (d === null) return { error: '音色資料夾要填絕對路徑（例如 /Users/me/voices），或留白', field: 'voiceDir' };
    next.voiceDir = d;
  }
  if (has('asrModel')) {
    const m = String(input.asrModel).trim();
    if (m && !/^[\w.\-:]{1,100}$/.test(m)) return { error: 'ASR 模型代號格式不正確', field: 'asrModel' };
    next.asrModel = m;
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
  for (const k of ['enabled', 'guestGenerate', 'readNotes', 'readMantra', 'readNonScripture', 'warmup', 'keepWarm', 'autoTranscribe', 'builtinLexicon']) if (has(k)) next[k] = input[k] === true;
  if (has('seed')) next.seed = clampInt(input.seed, 0, 2147483647, cur.seed);
  if (has('concurrency')) next.concurrency = clampInt(input.concurrency, 1, 4, cur.concurrency);
  if (has('maxSentenceChars')) next.maxSentenceChars = clampInt(input.maxSentenceChars, 40, 200, cur.maxSentenceChars);
  if (has('perUserHour')) next.perUserHour = clampInt(input.perUserHour, 10, 100000, cur.perUserHour);
  if (has('perIpHour')) next.perIpHour = clampInt(input.perIpHour, 10, 100000, cur.perIpHour);
  if (has('cacheMb')) next.cacheMb = clampInt(input.cacheMb, 64, 4 * 1024 * 1024, cur.cacheMb);
  if (has('maxSelectionChars')) next.maxSelectionChars = clampInt(input.maxSelectionChars, 200, 20000, cur.maxSelectionChars);
  if (has('keepWarmMinutes')) next.keepWarmMinutes = clampInt(input.keepWarmMinutes, 5, 240, cur.keepWarmMinutes);
  if (has('busyTimeoutMs')) next.busyTimeoutMs = clampInt(input.busyTimeoutMs, 1000, 300000, cur.busyTimeoutMs);
  return { settings: next };
}

function segmentOptions(s) {
  return { maxLen: s.maxSentenceChars, readNotes: s.readNotes, readNonScripture: s.readNonScripture, lexicon: lexicon.entries(s.builtinLexicon !== false) };
}

/** 會改變斷句或口語化文字的全站設定＋字典版本：文件斷句快取用它判斷是否要重切。 */
function segmentSignature(s) {
  return [s.maxSentenceChars, s.readNotes ? 1 : 0, s.readNonScripture ? 1 : 0, lexicon.version(s.builtinLexicon !== false)].join('|');
}

function findVoice(s, id) { return s.voices.find((v) => v.id === id && v.enabled && !voiceGone(s, v)) || null; }

function voiceKey(s, voice) {
  const name = voice.rev > 1 ? `${voice.voice}#${voice.rev}` : voice.voice;
  return [s.model, name, s.seed, ffmpegReady() ? POST_AAC : POST_WAV].join('\n');
}

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
    if (s.model) { // 伺服器活著但模型被卸載（例如換成別的模型）時，生成會全部失敗
      const m = await upstreamJson(s.baseUrl, 'models');
      const ids = (Array.isArray(m && m.data) ? m.data : []).map((x) => x && x.id);
      if (!ids.includes(s.model)) throw new Error(`audio.cpp 上沒有模型「${s.model}」（目前有：${ids.filter(Boolean).join('、') || '無'}）`);
    }
    await refreshUpstreamVoices(s.baseUrl, s.model);
    health = { ok: true, checkedAt: Date.now(), error: '', info: { backend: h.backend || '', version: h.version || '', git: h.git || '', gitDate: h.git_date || '' } };
  } catch (err) {
    if (health.ok) Logger.warn('TTS', `audio.cpp is unreachable: ${err.message}`);
    health = { ok: false, checkedAt: Date.now(), error: String(err.message || err).slice(0, 200), info: null };
  }
  return health;
}

/** 抓 audio.cpp 的音色清單；失敗就保留上一次的結果（短暫斷線時不要把音色全部藏起來）。 */
async function refreshUpstreamVoices(base, model) {
  try {
    const v = await upstreamJson(base, 'voices', model ? `?model=${encodeURIComponent(model)}` : '');
    if (v && Array.isArray(v.voices)) setUpstreamVoices(base, v.voices);
  } catch (_) {}
}
function setUpstreamVoices(base, list) {
  upstreamVoices = { names: new Set(list.filter((x) => typeof x === 'string')), at: Date.now(), base };
}

/** 白名單裡這個音色在 audio.cpp 上已經不存在（參考錄音被刪掉或改名）。清單未知時一律當作存在。 */
function voiceGone(s, v) {
  return !!(upstreamVoices.names && upstreamVoices.base === s.baseUrl && !upstreamVoices.names.has(v.voice));
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
    if (v && Array.isArray(v.voices)) setUpstreamVoices(base, v.voices);
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
  lastGenerationAt = Date.now();
  const chars = Array.from(spoken).length;
  // 時長離譜（實測每字約 0.25 秒）多半是模型出錯：太短是吞字，太長是失控
  if (wav.ms < Math.max(150, chars * 40) || wav.ms > chars * 1500 + 5000) throw new Error(`implausible duration ${wav.ms} ms for ${chars} chars`);
  return { buf, ms: wav.ms };
}

// ── 保溫 ─────────────────────────────────────────────────────────────

let lastGenerationAt = 0;   // 上一次 audio.cpp 成功回傳音訊的時間
let lastReaderActivityAt = 0; // 上一次讀者開啟朗讀（doc／resolve／speak）的時間
let warming = null;

function noteReaderActivity() { lastReaderActivityAt = Date.now(); }

/**
 * 送一句短句讓 audio.cpp 保持在熱的狀態；結果丟棄，不進快取、不佔用讀者的佇列順位以外的資源。
 * 只在：已啟用保溫、服務可用、最近有人在聽、已閒置一段時間、而且佇列是空的時候送。
 * @param {boolean} [force] 讀者剛開啟朗讀時用：不看「最近有人在聽」，只看是否已閒置
 */
function keepWarmTick(force) {
  const s = getSettings();
  if (!s.keepWarm || !isUsable(s) || !health.ok || warming) return null;
  const now = Date.now();
  if (!force && now - lastReaderActivityAt > s.keepWarmMinutes * 60 * 1000) return null;
  if (now - lastGenerationAt < KEEP_WARM_IDLE_MS || running > 0 || queues.some((q) => q.length)) return null;
  const voice = findVoice(s, s.defaultVoice) || s.voices.find((v) => v.enabled);
  if (!voice) return null;
  running++; // 佔一個生成名額：保溫期間進來的讀者請求排在它後面，不會同時打 audio.cpp
  warming = requestSpeech(s, voice.voice, KEEP_WARM_TEXT).then(() => true, () => false)
    .finally(() => { running--; warming = null; setImmediate(pump); });
  return warming;
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
  // 一般錯誤（5xx、不是音訊、時長離譜）重試一次；伺服器忙碌多等一下、重試兩次
  for (let attempt = 0; attempt < 3 && !got; attempt++) {
    try { got = await requestSpeech(s, job.voiceName, job.spoken); }
    catch (err) {
      lastErr = err;
      if (err.client && !err.busy) break; // 4xx：重試也沒用
      if (attempt >= (err.busy ? 2 : 1)) break;
      await new Promise((r) => setTimeout(r, err.busy ? BUSY_RETRY_MS[attempt] : 300));
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

/**
 * 某篇（或其中一段行號範圍）在某個音色下已生成多少句（聽經目錄後台用）。
 * toLine＝0 表示到檔尾。回傳 { voiced, cached, voice } 或 null。
 */
async function coverage(filePath, voiceId, fromLine, toLine) {
  const s = getSettings();
  if (!s.enabled || !storeReady()) return null;
  const voice = findVoice(s, voiceId || s.defaultVoice) || findVoice(s, publicDefaultVoice(s));
  if (!voice) return null;
  const entry = await loadDoc(filePath);
  if (!entry) return null;
  const vKey = voiceKey(s, voice);
  const lo = fromLine || 1; const hi = toLine || Infinity;
  const shas = [];
  for (let i = 0; i < entry.units.length; i++) {
    const u = entry.units[i];
    if (u.line < lo || u.line >= hi || !isPlayable(u, s)) continue;
    shas.push(shaOf(entry, vKey, i));
  }
  const uniq = [...new Set(shas)]; // 重複的句子（偈頌、咒語）只生成一次
  return { voiced: uniq.length, cached: store.lookup(uniq).size, voice: voice.id };
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
  const list = s.voices.filter((v) => v.enabled && !voiceGone(s, v)); // 參考錄音已刪除的音色不給讀者
  const shas = list.map((v) => blobSha(SAMPLE_TEXT, voiceKey(s, v)));
  const have = store.lookup(shas);
  return list.map((v, i) => ({ id: v.id, name: v.name, tags: v.tags, rate: v.rate, sample: have.has(shas[i]) ? `/api/tts/audio/${shas[i]}` : null }));
}

function publicDefaultVoice(s) {
  const d = findVoice(s, s.defaultVoice);
  if (d) return d.id;
  const first = s.voices.find((v) => v.enabled && !voiceGone(s, v));
  return first ? first.id : '';
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
    defaultVoice: publicDefaultVoice(s),
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
  noteReaderActivity(); keepWarmTick(true); // 讀者一開啟朗讀就先暖機，等他按下播放時多半已經熱了
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
  const line = Math.floor(Number(p.line));
  if (!(line >= 1 && line < 1e8)) return null;
  if (p.n !== undefined) { // 前端只知道「這一行裡，這個點之前有幾個非空白字」
    const n = Math.floor(Number(p.n));
    return n >= 0 && n < 1e7 ? { line, n } : null;
  }
  const off = Math.floor(Number(p.off));
  return off >= 0 && off < 1e7 ? { line, off } : null;
}

const NON_SPACE = /[^\s\u3000]/g;
/**
 * 把 { line, n }（該行中這個點之前的非空白字數）換成 { line, off }（該行正規化文字的位移）。
 * 畫面上的文字與正規化文字的空白不一定相同，但非空白字的順序相同，所以用字數對位。
 */
function resolveStrippedPos(units, pos, isEnd) {
  if (pos.off !== undefined) return pos;
  let lo = 0, hi = units.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (units[mid].endLine < pos.line) lo = mid + 1; else hi = mid; }
  let acc = 0; let last = null;
  for (let k = lo; k < units.length && units[k].line <= pos.line; k++) {
    const u = units[k];
    if (u.endLine !== u.line) return isEnd ? { line: u.endLine, off: u.b } : { line: u.line, off: u.a }; // 跨行的偈頌：整個單位
    const count = (u.text.match(NON_SPACE) || []).length;
    if (pos.n < acc + count || (isEnd && pos.n === acc + count)) {
      let need = pos.n - acc; let i = 0;
      for (; i < u.text.length && need > 0; i++) if (!/[\s\u3000]/.test(u.text[i])) need--;
      return { line: pos.line, off: u.a + i };
    }
    acc += count; last = u;
  }
  return { line: pos.line, off: last ? last.b : 0 };
}

async function handleResolve(req, res) {
  const s = getSettings();
  if (!requireEnabled(res, s)) return;
  noteReaderActivity();
  const body = await readJSONBody(req);
  const rawStart = parsePos(body.start); const rawEnd = parsePos(body.end);
  const bad = () => sendJSON(res, 400, { error: '選取範圍不正確', code: 'BAD_RANGE' });
  if (typeof body.path !== 'string' || !rawStart || !rawEnd || rawEnd.line < rawStart.line) return bad();
  const entry = await loadDoc(body.path);
  if (!entry) return sendJSON(res, 404, { error: 'File not found' });
  const start = resolveStrippedPos(entry.units, rawStart, false); const end = resolveStrippedPos(entry.units, rawEnd, true);
  if (end.line < start.line || (end.line === start.line && end.off <= start.off)) return bad();
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
  noteReaderActivity();
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

/**
 * GET /api/tts/silence.wav：0.1 秒的靜音。前端在使用者手勢內先播它來解鎖 <audio>
 *（iOS 的要求），第一句還在生成時也不會失去播放權。用 data: URI 會被 CSP 擋下。
 */
let silenceWav = null;
function handleSilence(req, res) {
  if (!silenceWav) {
    const n = 800; const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + n * 2, 4); h.write('WAVE', 8); h.write('fmt ', 12);
    h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(8000, 24);
    h.writeUInt32LE(16000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(n * 2, 40);
    silenceWav = Buffer.concat([h, Buffer.alloc(n * 2)]);
  }
  res.writeHead(200, Object.assign({}, SECURITY_HEADERS, {
    'Content-Type': 'audio/wav', 'Content-Length': silenceWav.length, 'Cache-Control': 'public, max-age=31536000, immutable', 'Accept-Ranges': 'none'
  }));
  res.end(req.method === 'HEAD' ? undefined : silenceWav);
}

// ── 預先生成工作 ─────────────────────────────────────────────────────
//
// 管理員選一篇或一個資料夾、一個音色，在背景依序生成（優先序最低的 bulk，讀者的即時
// 請求永遠排在前面）。工作存在 tts.db，可暫停、繼續、取消；重開機後從斷點接著做。

const JOB_MAX_FILES = 5000;
const JOB_SAVE_EVERY = 10;
const jobRt = { running: false, id: null, file: '', fileTotal: 0, fileDone: 0, kick: null };

/** 資料夾或單篇 → 經文庫內的 .md 相對路徑清單（依名稱排序）。不合法時回傳 null。 */
async function resolveJobFiles(scope) {
  if (scope === 'listen:catalog') return deps.listenCatalogFiles ? deps.listenCatalogFiles() : null; // 聽經目錄裡的所有經
  const rel = String(scope || '').replace(/\\/g, '/').split('/').map((x) => x.trim()).filter(Boolean).join('/');
  if (rel.includes('\0') || rel.startsWith('dict:')) return null;
  if (/\.md$/i.test(rel)) {
    const r = deps.resolveMdPath ? deps.resolveMdPath(rel) : null;
    if (!r) return null;
    try { if (!(await fs.promises.stat(r.resolved)).isFile()) return null; } catch (_) { return null; }
    return [r.relPath];
  }
  const root = getMdRoot();
  const dir = path.resolve(root, rel);
  const relDir = path.relative(root, dir);
  if (relDir.startsWith('..') || path.isAbsolute(relDir) || (relDir && hasHiddenSegment(relDir))) return null;
  try { if (!(await fs.promises.stat(dir)).isDirectory() || !(await isRealPathWithinRoot(root, dir))) return null; } catch (_) { return null; }
  const out = [];
  const walk = async (d) => {
    if (out.length >= JOB_MAX_FILES) return;
    let ents; try { ents = await fs.promises.readdir(d, { withFileTypes: true }); } catch (_) { return; }
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of ents) {
      if (e.name.startsWith('.') || out.length >= JOB_MAX_FILES) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && /\.md$/i.test(e.name)) out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  await walk(dir);
  return out;
}

const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });

function jobState(id) { const j = store.getJob(id); return j ? j.state : 'deleted'; }

/** 依序跑排隊中的工作（同時只跑一個）。 */
async function runJobs() {
  if (jobRt.running || !store.isAvailable()) return;
  jobRt.running = true;
  try {
    for (;;) {
      const job = store.listJobs(200).reverse().find((j) => j.state === 'queued' || j.state === 'running');
      if (!job) break;
      await runOneJob(job);
    }
  } finally { jobRt.running = false; jobRt.id = null; jobRt.file = ''; }
}

async function runOneJob(job) {
  jobRt.id = job.id;
  store.updateJob(job.id, { state: 'running', error: '' });
  let { fileIndex, sentencesDone, generated, failed } = job;
  const save = () => store.updateJob(job.id, { fileIndex, sentencesDone, generated, failed });
  for (; fileIndex < job.files.length; fileIndex++) {
    const relPath = job.files[fileIndex];
    let entry = null;
    try { entry = await loadDoc(relPath); } catch (_) { entry = null; }
    jobRt.file = relPath; jobRt.fileDone = 0; jobRt.fileTotal = entry ? entry.units.filter((u) => u.kind !== 'skip').length : 0;
    if (!entry) continue; // 檔案已刪除或搬走：略過
    const pinShas = [];
    let sinceSave = 0;
    for (let i = 0; i < entry.units.length; i++) {
      const s = getSettings();
      const u = entry.units[i];
      if (!isPlayable(u, s)) continue;
      const voice = findVoice(s, job.voice);
      if (!voice || !s.enabled) { store.updateJob(job.id, { state: 'paused', error: voice ? '朗讀功能已關閉' : '這個音色已停用或移除' }); return; }
      // 暫停、取消、刪除：每一句都檢查
      for (;;) {
        const st = jobState(job.id);
        if (st === 'running') break;
        if (st !== 'paused') return; // cancelled / deleted
        save(); await sleep(2000);
      }
      const sha = blobSha(u.spoken, voiceKey(s, voice));
      if (store.get(sha)) { if (job.pin) pinShas.push(sha); }
      else {
        while (!(isUsable(s) && health.ok)) { // 服務中斷：等它回來，不把整篇標成失敗
          if (jobState(job.id) !== 'running') break;
          store.updateJob(job.id, { error: '等待朗讀服務恢復…' });
          await sleep(30000); await checkHealth();
        }
        if (jobState(job.id) !== 'running') { i--; continue; }
        try {
          await enqueue({ sha, spoken: u.spoken, voiceName: voice.voice, voiceId: voice.id, flags: job.pin ? store.FLAG_PIN : 0 }, 'bulk');
          generated++;
        } catch (_) { failed++; }
        store.updateJob(job.id, { error: '' });
      }
      sentencesDone++; jobRt.fileDone++;
      if (++sinceSave >= JOB_SAVE_EVERY) { sinceSave = 0; save(); }
    }
    if (pinShas.length) store.addFlags(pinShas, store.FLAG_PIN);
    save();
  }
  store.updateJob(job.id, { state: 'done', fileIndex, sentencesDone, generated, failed });
  Logger.info('TTS', `Pre-generation job #${job.id} finished: ${generated} generated, ${failed} failed`);
}

function kickJobs() { if (!jobRt.running) runJobs().catch((err) => Logger.error('TTS', 'Pre-generation runner failed', err)); }

function jobsPayload() {
  return {
    jobs: store.listJobs(30).map((j) => ({ id: j.id, scope: j.scope, voice: j.voice, pin: j.pin, state: j.state, files: j.files.length,
      fileIndex: j.fileIndex, sentencesDone: j.sentencesDone, generated: j.generated, failed: j.failed, error: j.error,
      createdAt: j.createdAt, updatedAt: j.updatedAt,
      current: jobRt.id === j.id ? { file: jobRt.file, done: jobRt.fileDone, total: jobRt.fileTotal } : null })),
    queue: queueStats()
  };
}

async function handleAdminJobs(req, res, sub) {
  if (!storeReady()) return sendJSON(res, 409, { error: '朗讀快取無法使用', code: 'TTS_STORE_UNAVAILABLE' });
  if (sub === 'jobs' && req.method === 'GET') return sendJSON(res, 200, jobsPayload());
  if (sub === 'jobs' && req.method === 'POST') {
    const body = await readJSONBody(req);
    const s = getSettings();
    const voice = s.voices.find((v) => v.id === body.voice && v.enabled);
    if (!voice) return sendJSON(res, 400, { error: '請選擇一個已開放的音色', code: 'UNKNOWN_VOICE' });
    const files = await resolveJobFiles(body.scope);
    if (!files) return sendJSON(res, 400, { error: '找不到這篇經文或資料夾', code: 'BAD_SCOPE' });
    if (!files.length) return sendJSON(res, 400, { error: '這個資料夾裡沒有 .md 檔', code: 'EMPTY_SCOPE' });
    const user = currentUser(req);
    const job = store.createJob({ scope: String(body.scope || '').trim() || '（整個經文庫）', voice: voice.id, pin: body.pin === true, files, createdBy: user ? String(user.username || user.email || user.id) : 'admin' });
    Logger.info('TTS', `Pre-generation job #${job.id} queued: ${files.length} files, voice ${voice.id}`, req);
    kickJobs();
    return sendJSON(res, 200, Object.assign({ ok: true, id: job.id }, jobsPayload()));
  }
  const m = /^jobs\/(\d+)$/.exec(sub);
  if (m && req.method === 'POST') {
    const id = Number(m[1]); const job = store.getJob(id);
    if (!job) return sendJSON(res, 404, { error: '找不到這個工作' });
    const body = await readJSONBody(req);
    const a = body.action;
    if (a === 'pause' && (job.state === 'running' || job.state === 'queued')) store.updateJob(id, { state: 'paused' });
    else if (a === 'resume' && job.state === 'paused') { store.updateJob(id, { state: 'queued', error: '' }); kickJobs(); }
    else if (a === 'cancel' && job.state !== 'done') store.updateJob(id, { state: 'cancelled' });
    else if (a === 'delete' && job.state !== 'running') store.deleteJob(id);
    else return sendJSON(res, 400, { error: '這個工作目前不能這樣操作', code: 'BAD_ACTION' });
    return sendJSON(res, 200, Object.assign({ ok: true }, jobsPayload()));
  }
  return sendJSON(res, 404, { error: 'Not found' });
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
    voiceDir: inspectVoiceDir(s.voiceDir),
    upstreamVoices: upstreamVoices.names && upstreamVoices.base === s.baseUrl ? [...upstreamVoices.names] : null,
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
    // raw：照原字念（「原讀法」對照試聽，不套任何字典）
    spoken = Seg.oralize(text, 'sent', body.raw === true ? Object.assign(segmentOptions(s), { lexicon: [] }) : segmentOptions(s));
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

// ── 匿名使用統計（數據分析）──────────────────────────────────────────
// 讀者端只送「事件種類＋白名單內的值」；不存 IP、帳號或選取的文字。
// 當日人數用「每日隨機鹽＋IP＋UA」的雜湊去重，鹽只在記憶體、每天換，雜湊兩天後刪除。
const EVENT_MODES = ['here', 'section', 'sentence', 'top', 'selection', 'heading', 'toc', 'chant', 'next-doc', 'resume', 'listen', 'tap'];
const EVENT_FEATURES = ['sleep', 'continue-next', 'chant', 'offline', 'pin-voice', 'panel', 'rate', 'voice-switch'];
const EVENT_ENDS = ['finished', 'stopped', 'sleep'];
const eventRate = new Map(); // ip → { t, n }：每分鐘最多 120 筆
let listenerSalt = { day: '', salt: '' };

function listenerHash(req) {
  const day = new Date().toISOString().slice(0, 10);
  if (listenerSalt.day !== day) listenerSalt = { day, salt: crypto.randomBytes(16).toString('hex') };
  return crypto.createHash('sha256').update(`${listenerSalt.salt}|${getClientIP(req)}|${req.headers['user-agent'] || ''}`).digest('hex').slice(0, 20);
}

function eventAllowed(req) {
  const ip = getClientIP(req); const now = Date.now();
  let e = eventRate.get(ip);
  if (!e || now - e.t > 60000) { e = { t: now, n: 0 }; eventRate.set(ip, e); }
  if (eventRate.size > 5000) for (const [k, v] of eventRate) if (now - v.t > 60000) eventRate.delete(k);
  return ++e.n <= 120;
}

// ── 讀者回報念錯的句子：只收「這篇的第幾句」，文字一律由伺服器從原檔取得 ──
const reportRate = new Map(); // ip → { t, n }
function reportAllowed(req) {
  const ip = getClientIP(req); const now = Date.now();
  let e = reportRate.get(ip);
  if (!e || now - e.t > HOUR_MS) { e = { t: now, n: 0 }; reportRate.set(ip, e); }
  if (reportRate.size > 5000) for (const [k, v] of reportRate) if (now - v.t > HOUR_MS) reportRate.delete(k);
  return ++e.n <= 20;
}

async function handleReport(req, res) {
  const s = getSettings();
  if (!requireEnabled(res, s) || !storeReady()) return;
  const body = await readJSONBody(req).catch(() => null);
  if (!body || typeof body.path !== 'string' || !Number.isInteger(body.i)) return sendJSON(res, 400, { error: '缺少 path 或 i', code: 'BAD_REQUEST' });
  if (!reportAllowed(req)) return sendJSON(res, 429, { error: '回報太頻繁，請稍後再試', code: 'RATE_LIMITED' });
  const entry = await loadDoc(body.path);
  if (!entry) return sendJSON(res, 404, { error: 'File not found' });
  const u = entry.units[body.i];
  if (!u || !isPlayable(u, s)) return sendJSON(res, 400, { error: '這一句不能回報', code: 'BAD_UNIT' });
  const voice = typeof body.voice === 'string' && s.voices.some((v) => v.id === body.voice) ? body.voice : '';
  const note = String(body.note || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 60);
  const key = crypto.createHash('sha256').update(`${entry.relPath || body.path}|${u.text}`).digest('hex').slice(0, 24);
  store.addReport({ key, path: entry.relPath || body.path, unit: body.i, text: String(u.text).slice(0, 400), spoken: String(u.spoken || '').slice(0, 400), voice, note });
  return sendJSON(res, 200, { ok: true });
}

async function handleEvent(req, res) {
  const s = getSettings();
  const body = await readJSONBody(req).catch(() => null);
  if (!s.enabled || !storeReady() || !body || typeof body !== 'object') return sendJSON(res, 200, { ok: true });
  if (!eventAllowed(req)) return sendJSON(res, 429, { error: 'Too many events' });
  const type = String(body.type || '');
  const voice = typeof body.voice === 'string' && s.voices.some((v) => v.id === body.voice) ? body.voice : '';
  if (type === 'start' && EVENT_MODES.includes(body.mode)) {
    store.count('mode', body.mode);
    if (voice) store.count('voice', voice);
    if (typeof body.path === 'string' && body.path.length <= 300 && deps.resolveMdPath) {
      const r = deps.resolveMdPath(body.path);
      if (r && r.relPath) store.count('doc', r.relPath);
    }
    store.addListener(listenerHash(req));
  } else if (type === 'listen') {
    const ms = Math.max(0, Math.min(3600000, Math.round(Number(body.ms) || 0)));
    const n = Math.max(0, Math.min(1000, Math.round(Number(body.n) || 0)));
    if (ms) store.count('total', 'listenMs', ms);
    if (n) { store.count('total', 'sentences', n); if (voice) store.count('voiceSentences', voice, n); }
  } else if (type === 'feature' && EVENT_FEATURES.includes(body.key)) {
    store.count('feature', body.key);
  } else if (type === 'end' && EVENT_ENDS.includes(body.key)) {
    store.count('end', body.key);
  }
  return sendJSON(res, 200, { ok: true });
}

const ANALYTICS_RANGES = { '1d': 1, '7d': 7, '30d': 30, '90d': 90, allTime: 0 };

function handleAdminAnalytics(res, query) {
  const days = Object.prototype.hasOwnProperty.call(ANALYTICS_RANGES, query && query.range) ? ANALYTICS_RANGES[query.range] : 30;
  const s = getSettings();
  if (!storeReady()) return sendJSON(res, 200, { available: false, enabled: s.enabled });
  const r = store.usageReport(days);
  r.enabled = s.enabled;
  r.voices = s.voices.map((v) => ({ id: v.id, name: v.name, voice: v.voice }));
  return sendJSON(res, 200, r);
}

async function handle(req, res, pathname, query) {
  const m = req.method;
  if (pathname.startsWith('/api/admin/tts/')) {
    if (!requireAdmin(req, res, sendJSON)) return true;
    const sub = pathname.slice('/api/admin/tts/'.length);
    if (sub === 'settings' && m === 'GET') {
      // 打開後台朗讀頁：缺逐字稿的參考錄音在背景用 ASR 補（可在設定關掉）
      const s = getSettings();
      if (s.autoTranscribe && s.voiceDir) startVoiceTranscribe(s);
      sendJSON(res, 200, adminSettingsPayload()); return true;
    }
    if (sub === 'voicedir/transcribe' && m === 'POST') {
      const s = getSettings();
      const started = startVoiceTranscribe(s, { force: true });
      sendJSON(res, 200, { started, voiceDir: inspectVoiceDir(s.voiceDir) }); return true;
    }
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
    if (sub === 'analytics' && m === 'GET') { handleAdminAnalytics(res, query); return true; }
    if (sub === 'reports' && m === 'GET') {
      const s = getSettings(); if (s.enabled) storeReady();
      sendJSON(res, 200, { reports: store.listReports(200), voices: s.voices.map((v) => ({ id: v.id, name: v.name })) }); return true;
    }
    if (sub === 'reports/delete' && m === 'POST') {
      const body = await readJSONBody(req);
      if (typeof body.key !== 'string') { sendJSON(res, 400, { error: '缺少 key', code: 'BAD_REQUEST' }); return true; }
      store.deleteReport(body.key); sendJSON(res, 200, { ok: true }); return true;
    }
    if (sub === 'jobs' || sub.startsWith('jobs/')) { await handleAdminJobs(req, res, sub); return true; }
    return false;
  }
  if (pathname === '/api/tts/status' && m === 'GET') { handleStatus(req, res); return true; }
  if (pathname === '/api/tts/silence.wav' && (m === 'GET' || m === 'HEAD')) { handleSilence(req, res); return true; }
  if (pathname === '/api/tts/doc' && m === 'GET') { await handleDoc(req, res, query); return true; }
  if (pathname.startsWith('/api/tts/audio/') && (m === 'GET' || m === 'HEAD')) { handleAudio(req, res, pathname.slice('/api/tts/audio/'.length)); return true; }
  if (pathname === '/api/tts/report' && m === 'POST') {
    if (!verifySameOrigin(req)) { sendJSON(res, 403, { error: '請求來源不符', code: 'BAD_ORIGIN' }); return true; }
    await handleReport(req, res); return true;
  }
  if (pathname === '/api/tts/event' && m === 'POST') {
    if (!verifySameOrigin(req)) { sendJSON(res, 403, { error: '請求來源不符', code: 'BAD_ORIGIN' }); return true; }
    await handleEvent(req, res); return true;
  }
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
  if (s.enabled && storeReady()) kickJobs(); // 重開機：接著做沒做完的預先生成
  let ticks = 0;
  healthTimer = setInterval(() => {
    if (getSettings().enabled) checkHealth().then(() => keepWarmTick(false)).catch(() => {});
    if (++ticks % 720 === 0) { try { store.purgeTemp(24 * HOUR_MS); } catch (_) {} } // 約每天一次
  }, HEALTH_INTERVAL_MS);
  healthTimer.unref();
}

function stop() {
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
  store.close(); storeTriedAt = 0;
}

module.exports = {
  init, start, stop, isTtsRoute, handle, checkHealth, getSettings, loadDoc, coverage,
  DEFAULT_SETTINGS, SAMPLE_TEXT, PRIORITY,
  // 測試用
  _internals: {
    normalizeBaseUrl, voiceGone, setUpstreamVoices, resetUpstreamVoices: () => { upstreamVoices = { names: null, at: 0, base: '' }; }, normalizeVoiceDir, inspectVoiceDir, startVoiceTranscribe, rebuildPromptText, cleanTranscript, voiceAsrState: () => voiceAsr, sanitizeVoices, validateSettings, parseWav, blobSha, voiceKey, enqueue, queueStats, loadDoc,
    generationAllowance, usageLog, docCache, failed, detectFfmpeg, probe, keepWarmTick, runJobs, resolveJobFiles, jobRt,
    setClock(v) { if (v.lastGenerationAt !== undefined) lastGenerationAt = v.lastGenerationAt; if (v.lastReaderActivityAt !== undefined) lastReaderActivityAt = v.lastReaderActivityAt; },
    setFetch(f) { fetchImpl = f || ((...a) => fetch(...a)); },
    setFfmpeg(v) { ffmpeg = Object.assign({ checked: true, path: '', ok: false }, v); },
    setHealth(v) { health = Object.assign({ ok: false, checkedAt: Date.now(), error: '', info: null }, v); },
    reset() { usageLog.clear(); docCache.clear(); failed.clear(); tempSentences.clear(); }
  }
};
