/**
 * 書籤與閱讀歷程的伺服器端同步（POST /api/me/sync）。
 *
 * 規則見 library-sync.js：以路徑為 key、時間戳大者勝、刪除留墓碑。
 * 每次寫入都會取得該使用者遞增的 seq；裝置帶上次收到的 cursor（seq），
 * 伺服器回傳 seq 之後的所有異動，因此不受裝置時鐘影響。
 */
'use strict';

const db = require('./db');
const sync = require('../library-sync');

const { LIMITS } = sync;

function maxSeq(d, userId) {
  const a = d.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM bookmarks WHERE user_id = ?').get(userId).m;
  const b = d.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM read_progress WHERE user_id = ?').get(userId).m;
  return Math.max(a, b);
}

function toWireBookmark(r) {
  const w = { path: r.path, title: r.title || '', updatedAt: r.deleted_at || r.updated_at };
  if (r.deleted_at) w.deleted = true;
  return w;
}

function toWireHistory(r) {
  const w = { path: r.path, title: r.title || '', updatedAt: r.deleted_at || r.updated_at, pct: Math.round(r.position), line: r.line || null };
  if (r.deleted_at) w.deleted = true;
  return w;
}

/**
 * 套用一批異動並回傳 cursor 之後的所有異動。
 * @param {number} userId
 * @param {{cursor?:number, bookmarks?:Array, history?:Array}} payload
 * @param {number} [now]
 */
function syncLibrary(userId, payload, now = Date.now()) {
  const d = db.getDb();
  const cursor = Math.max(0, Math.floor(Number(payload && payload.cursor)) || 0);
  const inB = (Array.isArray(payload && payload.bookmarks) ? payload.bookmarks : []).slice(0, LIMITS.maxItemsPerRequest)
    .map(x => sync.normalizeWireItem(x, 'bookmark', now)).filter(Boolean);
  const inH = (Array.isArray(payload && payload.history) ? payload.history : []).slice(0, LIMITS.maxItemsPerRequest)
    .map(x => sync.normalizeWireItem(x, 'history', now)).filter(Boolean);

  let rejected = 0;
  d.exec('BEGIN IMMEDIATE');
  try {
    let seq = maxSeq(d, userId);

    const getB = d.prepare('SELECT updated_at, deleted_at FROM bookmarks WHERE user_id = ? AND path = ?');
    const putB = d.prepare(`INSERT INTO bookmarks (user_id, path, anchor, title, updated_at, deleted_at, seq) VALUES (?, ?, NULL, ?, ?, ?, ?)
      ON CONFLICT(user_id, path) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at, seq = excluded.seq`);
    let liveB = d.prepare('SELECT COUNT(*) AS n FROM bookmarks WHERE user_id = ? AND deleted_at IS NULL').get(userId).n;
    for (const w of inB) {
      const cur = getB.get(userId, w.path);
      const curTs = cur ? Math.max(cur.updated_at, cur.deleted_at || 0) : 0;
      if (w.updatedAt <= curTs) continue;
      const wasLive = !!cur && !cur.deleted_at;
      if (!w.deleted && !wasLive && liveB >= LIMITS.maxBookmarks) { rejected++; continue; }
      if (!w.deleted && !wasLive) liveB++;
      if (w.deleted && wasLive) liveB--;
      putB.run(userId, w.path, w.title, w.deleted ? (cur ? cur.updated_at : w.updatedAt) : w.updatedAt, w.deleted ? w.updatedAt : null, ++seq);
    }

    const getH = d.prepare('SELECT updated_at, deleted_at FROM read_progress WHERE user_id = ? AND path = ?');
    const putH = d.prepare(`INSERT INTO read_progress (user_id, path, position, heading, title, line, updated_at, deleted_at, seq) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, path) DO UPDATE SET position = excluded.position, title = excluded.title, line = excluded.line,
        updated_at = excluded.updated_at, deleted_at = excluded.deleted_at, seq = excluded.seq`);
    for (const w of inH) {
      const cur = getH.get(userId, w.path);
      const curTs = cur ? Math.max(cur.updated_at, cur.deleted_at || 0) : 0;
      if (w.updatedAt <= curTs) continue;
      putH.run(userId, w.path, w.pct == null ? 0 : w.pct, w.title, w.line, w.deleted ? (cur ? cur.updated_at : w.updatedAt) : w.updatedAt, w.deleted ? w.updatedAt : null, ++seq);
    }

    // 歷程只留最近 maxHistory 筆有效紀錄（其餘直接刪除，不留墓碑：本來就是會被擠掉的舊資料）。
    d.prepare(`DELETE FROM read_progress WHERE user_id = ? AND deleted_at IS NULL AND path NOT IN
      (SELECT path FROM read_progress WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?)`)
      .run(userId, userId, LIMITS.maxHistory);
    // 過舊的墓碑清掉。
    const cutoff = now - LIMITS.tombstoneTtlMs;
    d.prepare('DELETE FROM bookmarks WHERE user_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?').run(userId, cutoff);
    d.prepare('DELETE FROM read_progress WHERE user_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?').run(userId, cutoff);

    const outB = d.prepare('SELECT path, title, updated_at, deleted_at FROM bookmarks WHERE user_id = ? AND seq > ? ORDER BY seq').all(userId, cursor).map(toWireBookmark);
    const outH = d.prepare('SELECT path, title, position, line, updated_at, deleted_at FROM read_progress WHERE user_id = ? AND seq > ? ORDER BY seq').all(userId, cursor).map(toWireHistory);
    d.exec('COMMIT');
    return { cursor: seq, bookmarks: outB, history: outH, rejected, serverTime: now };
  } catch (err) {
    try { d.exec('ROLLBACK'); } catch (_) {}
    throw err;
  }
}

module.exports = { syncLibrary };
