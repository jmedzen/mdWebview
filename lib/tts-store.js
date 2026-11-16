/**
 * @file lib/tts-store.js — 朗讀音檔的磁碟快取（內容定址）與索引資料庫
 *
 *   <TTS_CACHE_DIR>/blobs/ab/<sha256>.<ext>   音檔（全站共用，不可變）
 *   <TTS_CACHE_DIR>/tmp/                       生成中的檔，驗證後 rename 進 blobs/
 *   <TTS_CACHE_DIR>/tts.db                     blob 索引與每日統計（node:sqlite）
 *
 * 快取資料夾 = TTS_CACHE_DIR；沒設定時 = <MDW_USER_DATA>/tts-cache（Docker 映像預設 /data/tts-cache）。
 * 不寫進經文庫（mdRoot 可能唯讀，而且會觸發檔案監視與索引重建）。
 */

const fs = require('fs');
const path = require('path');
const { USER_DATA, CONFIG_PATH } = require('./constants');

let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch (_) { /* 沒有 node:sqlite：朗讀功能停用 */ }

const FLAG_SAMPLE = 1;   // 音色試聽檔：GC 不刪
const FLAG_TEMP = 2;     // 「只讀我選的」的頭尾殘句、後台字典試聽：GC 優先刪
const FLAG_PIN = 4;      // 管理員預先生成時選「釘選」的文件：GC 不刪
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;
const SHA_RE = /^[0-9a-f]{64}$/;
const EXT_MIME = { m4a: 'audio/mp4', wav: 'audio/wav', mp3: 'audio/mpeg' };

let db = null;
let dir = '';
let usedBytes = 0;
const lastTouch = new Map();

function cacheDir(env = process.env) {
  const raw = String(env.TTS_CACHE_DIR || '').trim();
  if (!raw) return path.join(USER_DATA, 'tts-cache');
  return path.isAbsolute(raw) ? raw : path.resolve(path.dirname(CONFIG_PATH), raw);
}

function isAvailable() { return !!db; }

/** 開啟（或建立）快取；失敗時回傳 false，朗讀功能停用但不影響其他功能。 */
function open(customDir) {
  if (db) return true;
  if (!DatabaseSync) return false;
  try {
    dir = customDir || cacheDir();
    fs.mkdirSync(path.join(dir, 'blobs'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true });
    for (const f of fs.readdirSync(path.join(dir, 'tmp'))) { try { fs.unlinkSync(path.join(dir, 'tmp', f)); } catch (_) {} }
    db = new DatabaseSync(path.join(dir, 'tts.db'));
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS blobs (
        sha TEXT PRIMARY KEY, ext TEXT NOT NULL, bytes INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
        chars INTEGER NOT NULL DEFAULT 0, voice TEXT NOT NULL DEFAULT '', flags INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, last_played_at INTEGER NOT NULL, plays INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS blobs_lru ON blobs (flags, last_played_at);
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, voice TEXT NOT NULL, pin INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL, files TEXT NOT NULL DEFAULT '[]', file_index INTEGER NOT NULL DEFAULT 0,
        sentences_done INTEGER NOT NULL DEFAULT 0, generated INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage (
        day TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, kind, key)
      );
      CREATE TABLE IF NOT EXISTS listeners (day TEXT NOT NULL, h TEXT NOT NULL, PRIMARY KEY (day, h));
      CREATE TABLE IF NOT EXISTS reports (
        key TEXT PRIMARY KEY, path TEXT NOT NULL, unit INTEGER NOT NULL, text TEXT NOT NULL, spoken TEXT NOT NULL DEFAULT '',
        voice TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', n INTEGER NOT NULL DEFAULT 1,
        first_at INTEGER NOT NULL, last_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS stats (
        day TEXT PRIMARY KEY, hits INTEGER NOT NULL DEFAULT 0, misses INTEGER NOT NULL DEFAULT 0,
        generated INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, gen_ms INTEGER NOT NULL DEFAULT 0
      );
    `);
    usedBytes = Number(db.prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM blobs').get().n) || 0;
    return true;
  } catch (err) {
    db = null;
    try { require('./logger').Logger.error('TTS', `Cannot open TTS cache at ${dir}`, err); } catch (_) {}
    return false;
  }
}

function close() {
  if (db) { try { db.close(); } catch (_) {} }
  db = null; usedBytes = 0; lastTouch.clear();
}

function getDir() { return dir; }
function tmpPath(name) { return path.join(dir, 'tmp', name); }
function blobPath(sha, ext) { return path.join(dir, 'blobs', sha.slice(0, 2), `${sha}.${ext}`); }

/** 查一批 sha 是否已快取。回傳 Map(sha → { ext, bytes, ms })。 */
function lookup(shas) {
  const out = new Map();
  if (!db) return out;
  const list = shas.filter((s) => SHA_RE.test(s));
  for (let i = 0; i < list.length; i += 400) {
    const part = list.slice(i, i + 400);
    const rows = db.prepare(`SELECT sha, ext, bytes, duration_ms FROM blobs WHERE sha IN (${part.map(() => '?').join(',')})`).all(...part);
    for (const r of rows) out.set(r.sha, { ext: r.ext, bytes: Number(r.bytes), ms: Number(r.duration_ms) });
  }
  return out;
}

function get(sha) {
  if (!db || !SHA_RE.test(sha)) return null;
  const r = db.prepare('SELECT sha, ext, bytes, duration_ms, flags FROM blobs WHERE sha = ?').get(sha);
  return r ? { sha: r.sha, ext: r.ext, bytes: Number(r.bytes), ms: Number(r.duration_ms), flags: Number(r.flags), file: blobPath(r.sha, r.ext), mime: EXT_MIME[r.ext] || 'application/octet-stream' } : null;
}

/** 把 tmp 裡驗證過的音檔收進快取。同一 sha 已存在時丟掉新檔（內容定址，先到先贏）。 */
function put(sha, tmpFile, meta) {
  if (!db || !SHA_RE.test(sha)) throw new Error('TTS cache unavailable');
  const existing = get(sha);
  if (existing && fs.existsSync(existing.file)) { try { fs.unlinkSync(tmpFile); } catch (_) {} return existing; }
  const bytes = fs.statSync(tmpFile).size;
  const dest = blobPath(sha, meta.ext);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(tmpFile, dest);
  const now = Date.now();
  db.prepare(`INSERT OR REPLACE INTO blobs (sha, ext, bytes, duration_ms, chars, voice, flags, created_at, last_played_at, plays)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`)
    .run(sha, meta.ext, bytes, Math.round(meta.ms || 0), meta.chars || 0, String(meta.voice || ''), meta.flags || 0, now, now);
  usedBytes += bytes - (existing ? existing.bytes : 0);
  return get(sha);
}

/** 記一次播放（每個 blob 每小時最多寫一次資料庫）。 */
function touch(sha) {
  if (!db) return;
  const now = Date.now();
  if (now - (lastTouch.get(sha) || 0) < TOUCH_INTERVAL_MS) return;
  if (lastTouch.size > 20000) lastTouch.clear();
  lastTouch.set(sha, now);
  try { db.prepare('UPDATE blobs SET last_played_at = ?, plays = plays + 1 WHERE sha = ?').run(now, sha); } catch (_) {}
}

function remove(sha) {
  const b = get(sha);
  if (!b) return false;
  try { fs.unlinkSync(b.file); } catch (_) {}
  db.prepare('DELETE FROM blobs WHERE sha = ?').run(sha);
  usedBytes = Math.max(0, usedBytes - b.bytes);
  lastTouch.delete(sha);
  return true;
}

/** 清除：不給 shas 就清全部（含試聽檔）。回傳刪掉的筆數。 */
function clear(shas) {
  if (!db) return 0;
  if (Array.isArray(shas)) { let n = 0; for (const s of shas) if (remove(s)) n++; return n; }
  const n = Number(db.prepare('SELECT COUNT(*) AS n FROM blobs').get().n);
  db.exec('DELETE FROM blobs');
  try { fs.rmSync(path.join(dir, 'blobs'), { recursive: true, force: true }); } catch (_) {}
  fs.mkdirSync(path.join(dir, 'blobs'), { recursive: true });
  usedBytes = 0; lastTouch.clear();
  return n;
}

/**
 * 超過上限時刪到上限的 95%：先刪臨時檔，再刪最久沒播的；試聽檔不刪。
 * @returns {number} 刪掉的筆數
 */
function gc(limitBytes) {
  if (!db || !(limitBytes > 0) || usedBytes <= limitBytes) return 0;
  const target = limitBytes * 0.95; let n = 0;
  const pass = (where) => {
    while (usedBytes > target) {
      const rows = db.prepare(`SELECT sha FROM blobs WHERE ${where} ORDER BY last_played_at ASC LIMIT 200`).all();
      if (!rows.length) break;
      for (const r of rows) { if (usedBytes <= target) break; if (remove(r.sha)) n++; }
    }
  };
  pass(`(flags & ${FLAG_TEMP}) != 0`);
  pass(`(flags & ${FLAG_SAMPLE | FLAG_PIN}) = 0`);
  return n;
}

/** 把旗標加到已存在的 blob（例如釘選）。回傳更新的筆數。 */
function addFlags(shas, flag) {
  if (!db || !shas.length) return 0;
  let n = 0;
  const stmt = db.prepare('UPDATE blobs SET flags = flags | ? WHERE sha = ?');
  for (const s of shas) if (SHA_RE.test(s)) n += Number(stmt.run(flag, s).changes || 0);
  return n;
}

// ── 預先生成工作 ──
const JOB_FIELDS = 'id, scope, voice, pin, state, files, file_index, sentences_done, generated, failed, error, created_by, created_at, updated_at';
function rowToJob(r) {
  if (!r) return null;
  let files = [];
  try { files = JSON.parse(r.files); } catch (_) {}
  return { id: Number(r.id), scope: r.scope, voice: r.voice, pin: !!r.pin, state: r.state, files, fileIndex: Number(r.file_index),
    sentencesDone: Number(r.sentences_done), generated: Number(r.generated), failed: Number(r.failed), error: r.error,
    createdBy: r.created_by, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) };
}
function createJob(job) {
  if (!db) throw new Error('TTS cache unavailable');
  const now = Date.now();
  const r = db.prepare('INSERT INTO jobs (scope, voice, pin, state, files, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(job.scope, job.voice, job.pin ? 1 : 0, 'queued', JSON.stringify(job.files), job.createdBy || '', now, now);
  return getJob(Number(r.lastInsertRowid));
}
function getJob(id) { return db ? rowToJob(db.prepare(`SELECT ${JOB_FIELDS} FROM jobs WHERE id = ?`).get(id)) : null; }
function listJobs(limit = 30) { return db ? db.prepare(`SELECT ${JOB_FIELDS} FROM jobs ORDER BY id DESC LIMIT ?`).all(limit).map(rowToJob) : []; }
function updateJob(id, fields) {
  if (!db) return null;
  const map = { state: 'state', fileIndex: 'file_index', sentencesDone: 'sentences_done', generated: 'generated', failed: 'failed', error: 'error' };
  const sets = []; const vals = [];
  for (const [k, col] of Object.entries(map)) if (fields[k] !== undefined) { sets.push(`${col} = ?`); vals.push(fields[k]); }
  sets.push('updated_at = ?'); vals.push(Date.now());
  db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  return getJob(id);
}
function deleteJob(id) { if (db) db.prepare('DELETE FROM jobs WHERE id = ?').run(id); }

/** 臨時檔超過 maxAgeMs 就刪（每日維護時呼叫）。 */
function purgeTemp(maxAgeMs) {
  if (!db) return 0;
  const rows = db.prepare(`SELECT sha FROM blobs WHERE (flags & ${FLAG_TEMP}) != 0 AND created_at < ?`).all(Date.now() - maxAgeMs);
  let n = 0; for (const r of rows) if (remove(r.sha)) n++;
  return n;
}

function today() { return new Date().toISOString().slice(0, 10); }

function bump(field, by = 1) {
  if (!db || !['hits', 'misses', 'generated', 'failed', 'gen_ms'].includes(field)) return;
  try {
    db.prepare(`INSERT INTO stats (day, ${field}) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET ${field} = ${field} + excluded.${field}`).run(today(), Math.round(by));
  } catch (_) {}
}

// ── 朗讀使用統計（匿名、按日彙總）──
const USAGE_KEEP_DAYS = 400;
let lastUsagePrune = '';

function pruneUsage() {
  const d = today();
  if (!db || lastUsagePrune === d) return;
  lastUsagePrune = d;
  const cut = new Date(Date.now() - USAGE_KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  const cutL = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10); // 收聽者雜湊只留兩天（算當日人數用）
  try {
    db.prepare('DELETE FROM usage WHERE day < ?').run(cut);
    db.prepare('DELETE FROM listeners WHERE day < ?').run(cutL);
  } catch (_) {}
}

/** 某一類的計數加一（或加 by）。kind／key 由呼叫端驗證過。 */
function count(kind, key, by = 1) {
  if (!db || !kind || key == null) return;
  pruneUsage();
  try {
    db.prepare('INSERT INTO usage (day, kind, key, n) VALUES (?, ?, ?, ?) ON CONFLICT(day, kind, key) DO UPDATE SET n = n + excluded.n')
      .run(today(), String(kind), String(key).slice(0, 300), Math.round(by));
  } catch (_) {}
}

/** 記一個當日收聽者（h 是加了每日隨機鹽的雜湊，無法反推）；第一次出現時把當日人數加一。 */
function addListener(h) {
  if (!db || !h) return;
  try {
    const r = db.prepare('INSERT OR IGNORE INTO listeners (day, h) VALUES (?, ?)').run(today(), h);
    if (r.changes) count('total', 'listeners', 1);
  } catch (_) {}
}

/** 最近 days 天（含今天；0＝全部）的彙總。 */
function usageReport(days) {
  if (!db) return { available: false };
  const from = days > 0 ? new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10) : '0000-00-00';
  const rows = db.prepare('SELECT day, kind, key, n FROM usage WHERE day >= ? ORDER BY day').all(from);
  const st = db.prepare('SELECT day, hits, misses, generated, failed, gen_ms FROM stats WHERE day >= ? ORDER BY day').all(from);
  const daily = new Map();
  const dayRow = (d) => { if (!daily.has(d)) daily.set(d, { day: d, starts: 0, listeners: 0, sentences: 0, listenMs: 0, hits: 0, misses: 0, generated: 0, failed: 0, genMs: 0 }); return daily.get(d); };
  const kinds = {};
  for (const r of rows) {
    const n = Number(r.n);
    if (r.kind === 'total') { const o = dayRow(r.day); if (r.key in o) o[r.key] += n; continue; }
    if (r.kind === 'mode') dayRow(r.day).starts += n;
    const k = kinds[r.kind] || (kinds[r.kind] = {});
    k[r.key] = (k[r.key] || 0) + n;
  }
  for (const r of st) {
    const o = dayRow(r.day);
    o.hits += Number(r.hits); o.misses += Number(r.misses); o.generated += Number(r.generated); o.failed += Number(r.failed); o.genMs += Number(r.gen_ms);
  }
  // 範圍內沒有資料的日子補 0，趨勢圖的橫軸才是連續的日期
  const firstDay = days > 0 ? from : [...daily.keys()].sort()[0];
  if (firstDay) for (let t = Date.parse(firstDay + 'T00:00:00Z'), end = Date.parse(today() + 'T00:00:00Z'); t <= end; t += 86400000) dayRow(new Date(t).toISOString().slice(0, 10));
  const list = [...daily.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  const sum = (f) => list.reduce((x, o) => x + o[f], 0);
  const totals = {};
  for (const f of ['starts', 'listeners', 'sentences', 'listenMs', 'hits', 'misses', 'generated', 'failed', 'genMs']) totals[f] = sum(f);
  return { available: true, from: days > 0 ? from : (list[0] ? list[0].day : ''), daily: list, totals, kinds };
}

function usage() {
  if (!db) return { available: false, bytes: 0, blobs: 0, durationMs: 0, days: [] };
  const c = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(duration_ms), 0) AS ms FROM blobs').get();
  const days = db.prepare('SELECT day, hits, misses, generated, failed, gen_ms FROM stats ORDER BY day DESC LIMIT 30').all()
    .map((r) => ({ day: r.day, hits: Number(r.hits), misses: Number(r.misses), generated: Number(r.generated), failed: Number(r.failed), genMs: Number(r.gen_ms) }));
  return { available: true, dir, bytes: usedBytes, blobs: Number(c.n), durationMs: Number(c.ms), days };
}

// ── 讀者回報「這句念錯了」（同一句合併計數；只留最新的備註與音色）──
const REPORTS_MAX = 500;
function addReport(r) {
  if (!db) return false;
  const now = Date.now();
  db.prepare(`INSERT INTO reports (key, path, unit, text, spoken, voice, note, n, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(key) DO UPDATE SET n = n + 1, last_at = excluded.last_at, unit = excluded.unit, spoken = excluded.spoken, voice = excluded.voice,
      note = CASE WHEN excluded.note <> '' THEN excluded.note ELSE note END`)
    .run(r.key, r.path, r.unit, r.text, r.spoken || '', r.voice || '', r.note || '', now, now);
  const total = Number(db.prepare('SELECT COUNT(*) AS n FROM reports').get().n) || 0;
  if (total > REPORTS_MAX) db.prepare('DELETE FROM reports WHERE key IN (SELECT key FROM reports ORDER BY last_at ASC LIMIT ?)').run(total - REPORTS_MAX);
  return true;
}
function listReports(limit = 200) {
  if (!db) return [];
  return db.prepare('SELECT key, path, unit, text, spoken, voice, note, n, first_at AS firstAt, last_at AS lastAt FROM reports ORDER BY last_at DESC LIMIT ?').all(limit)
    .map((r) => Object.assign({}, r));
}
function deleteReport(key) { if (db) db.prepare('DELETE FROM reports WHERE key = ?').run(String(key)); }

module.exports = {
  addReport, listReports, deleteReport,
  FLAG_SAMPLE, FLAG_TEMP, FLAG_PIN, SHA_RE, EXT_MIME, addFlags,
  createJob, getJob, listJobs, updateJob, deleteJob,
  cacheDir, open, close, isAvailable, getDir, tmpPath, blobPath,
  lookup, get, put, touch, remove, clear, gc, purgeTemp, bump, usage, count, addListener, usageReport
};
