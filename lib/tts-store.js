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
  pass(`(flags & ${FLAG_SAMPLE}) = 0`);
  return n;
}

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

function usage() {
  if (!db) return { available: false, bytes: 0, blobs: 0, durationMs: 0, days: [] };
  const c = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(duration_ms), 0) AS ms FROM blobs').get();
  const days = db.prepare('SELECT day, hits, misses, generated, failed, gen_ms FROM stats ORDER BY day DESC LIMIT 30').all()
    .map((r) => ({ day: r.day, hits: Number(r.hits), misses: Number(r.misses), generated: Number(r.generated), failed: Number(r.failed), genMs: Number(r.gen_ms) }));
  return { available: true, dir, bytes: usedBytes, blobs: Number(c.n), durationMs: Number(c.ms), days };
}

module.exports = {
  FLAG_SAMPLE, FLAG_TEMP, SHA_RE, EXT_MIME,
  cacheDir, open, close, isAvailable, getDir, tmpPath, blobPath,
  lookup, get, put, touch, remove, clear, gc, purgeTemp, bump, usage
};
