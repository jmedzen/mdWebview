/**
 * @file lib/db.js — 帳號資料庫（node:sqlite）
 *
 * 所有 SQL 都集中在這個檔案：帳號、第三方登入綁定、信件 token、邀請碼、
 * session、稽核紀錄與帳號相關設定。其他模組只呼叫這裡匯出的函式，將來若要
 * 換成 PostgreSQL 也只需要改這一層。
 *
 * - 只在 web 模式開啟；單機 App 模式不建立 users.db。
 * - 路徑：USERS_DB_PATH，預設與 config.json 同一個目錄（Docker 為 /data/users.db）。
 *   在 `node --test` 底下預設改用記憶體資料庫，測試互不干擾也不弄髒工作目錄。
 * - 結構版本記在 PRAGMA user_version，啟動時依序補跑缺少的遷移（單一交易，
 *   失敗即回滾並丟出錯誤）。遷移前若已有資料，先自動備份成 users-pre-v<N>.db。
 * - 時間一律存 Unix 毫秒；token 與邀請碼只存 SHA-256（hex）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { IS_SINGLE_USER, CONFIG_PATH } = require('./constants');

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (_) {
  DatabaseSync = null;
}

const IS_TEST_RUN = !!process.env.NODE_TEST_CONTEXT;

function resolveDbPath() {
  const fromEnv = (process.env.USERS_DB_PATH || '').trim();
  if (fromEnv) return fromEnv;
  if (IS_TEST_RUN) return ':memory:';
  return path.join(path.dirname(CONFIG_PATH), 'users.db');
}

function resolveBackupDir(dbPath) {
  const fromEnv = (process.env.DB_BACKUP_DIR || '').trim();
  if (fromEnv) return fromEnv;
  if (dbPath === ':memory:') return null;
  return path.join(path.dirname(dbPath), 'backups');
}

const BACKUP_KEEP = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

// ── 結構遷移 ─────────────────────────────────────────────────
// 只加不減：舊映像遇到較新的 user_version 照常啟動、不跑遷移，所以能退版。
const MIGRATIONS = [
  // v1：帳號、第三方綁定、信件 token、邀請碼、session、同步資料、稽核紀錄、設定
  `
  CREATE TABLE users (
    id                  INTEGER PRIMARY KEY,
    email               TEXT UNIQUE,            -- 去空白、轉小寫；舊管理員可暫無
    username            TEXT UNIQUE,            -- 只給舊管理員沿用原登入名
    email_verified_at   INTEGER,
    display_name        TEXT,
    password_hash       TEXT,                   -- NULL = 只用第三方登入
    role                TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
    status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
    created_at          INTEGER NOT NULL,
    password_changed_at INTEGER,
    last_login_at       INTEGER,
    terms_version       TEXT,
    terms_accepted_at   INTEGER,
    signup_ip           TEXT
  );

  CREATE TABLE user_identities (
    provider   TEXT NOT NULL,
    subject    TEXT NOT NULL,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email      TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (provider, subject)
  );
  CREATE INDEX user_identities_user ON user_identities(user_id);

  CREATE TABLE email_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose    TEXT NOT NULL CHECK (purpose IN ('verify','reset','change_email')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER,
    new_email  TEXT
  );
  CREATE INDEX email_tokens_user ON email_tokens(user_id);

  CREATE TABLE invites (
    id         INTEGER PRIMARY KEY,
    code_hash  TEXT NOT NULL UNIQUE,
    code_hint  TEXT,
    note       TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    uses_left  INTEGER NOT NULL DEFAULT 1,
    uses_count INTEGER NOT NULL DEFAULT 0,
    revoked_at INTEGER
  );

  CREATE TABLE sessions (
    id           INTEGER PRIMARY KEY,
    token_hash   TEXT NOT NULL UNIQUE,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    reauth_at    INTEGER,
    ip           TEXT,
    user_agent   TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE INDEX sessions_expiry ON sessions(expires_at);

  CREATE TABLE user_prefs (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data       TEXT NOT NULL,
    version    INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE bookmarks (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    path       TEXT NOT NULL,
    anchor     TEXT,
    title      TEXT,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    PRIMARY KEY (user_id, path)
  );

  CREATE TABLE read_progress (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    path       TEXT NOT NULL,
    position   REAL NOT NULL,
    heading    TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, path)
  );
  CREATE INDEX read_progress_recent ON read_progress(user_id, updated_at DESC);

  CREATE TABLE auth_events (
    id       INTEGER PRIMARY KEY,
    user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    event    TEXT NOT NULL,
    detail   TEXT,
    ip       TEXT,
    at       INTEGER NOT NULL
  );
  CREATE INDEX auth_events_at ON auth_events(at);
  CREATE INDEX auth_events_user ON auth_events(user_id);

  CREATE TABLE app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // v2：書籤／歷程同步。seq 是每位使用者遞增的異動序號，裝置用它拉取「上次之後的異動」，
  // 不受各裝置時鐘影響；deleted_at 為墓碑，read_progress 的 position 存閱讀百分比。
  `
  ALTER TABLE bookmarks ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE read_progress ADD COLUMN title TEXT;
  ALTER TABLE read_progress ADD COLUMN line INTEGER;
  ALTER TABLE read_progress ADD COLUMN deleted_at INTEGER;
  ALTER TABLE read_progress ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX bookmarks_seq ON bookmarks(user_id, seq);
  CREATE INDEX read_progress_seq ON read_progress(user_id, seq);
  `,
  // v3：書籤自己記閱讀進度（position 為百分比，line 為行號），不再只靠歷程。
  `
  ALTER TABLE bookmarks ADD COLUMN position REAL;
  ALTER TABLE bookmarks ADD COLUMN line INTEGER;
  `
];

const SCHEMA_VERSION = MIGRATIONS.length;

let db = null;
let dbPath = null;
let backupDir = null;
let lastMigrationAt = null;
let openError = null;
let maintenanceTimer = null;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function now() { return Date.now(); }

function isAvailable() {
  return !!db;
}

function getOpenError() {
  return openError;
}

/** 資料庫所在目錄；記憶體資料庫回傳 null。 */
function getDataDir() {
  if (!dbPath || dbPath === ':memory:') return null;
  return path.dirname(dbPath);
}

function backupFileName(prefix) {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  return `${prefix}-${stamp}.db`;
}

/** 以 VACUUM INTO 產生一致的線上快照；WAL 模式下不能直接複製 users.db。 */
function snapshotTo(targetPath) {
  if (!db) throw new Error('Database is not open');
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  if (fs.existsSync(targetPath)) fs.rmSync(targetPath);
  db.exec(`VACUUM INTO '${targetPath.replace(/'/g, "''")}'`);
  try { fs.chmodSync(targetPath, 0o600); } catch (_) {}
  return targetPath;
}

function runMigrations() {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  if (current >= SCHEMA_VERSION) return current;
  if (current > 0 && backupDir) {
    snapshotTo(path.join(backupDir, `users-pre-v${current + 1}.db`));
  }
  db.exec('BEGIN');
  try {
    for (let v = current; v < SCHEMA_VERSION; v++) {
      db.exec(MIGRATIONS[v]);
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw err;
  }
  lastMigrationAt = now();
  setSetting('db.lastMigrationAt', String(lastMigrationAt));
  return SCHEMA_VERSION;
}

/**
 * 開啟資料庫並跑遷移。單機模式或 node:sqlite 不可用時回傳 null（帳號功能停用）。
 * 遷移失敗會丟出錯誤，由呼叫端決定是否拒絕啟動。
 */
function open(options = {}) {
  if (db) return db;
  if (IS_SINGLE_USER && !options.force) return null;
  if (!DatabaseSync) {
    openError = new Error('node:sqlite is not available in this Node.js version');
    return null;
  }
  dbPath = options.path || resolveDbPath();
  backupDir = options.backupDir !== undefined ? options.backupDir : resolveBackupDir(dbPath);
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  const journal = (process.env.USERS_DB_JOURNAL || 'wal').trim().toLowerCase() === 'delete' ? 'DELETE' : 'WAL';
  if (dbPath !== ':memory:') db.exec(`PRAGMA journal_mode = ${journal}`);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  try {
    runMigrations();
  } catch (err) {
    try { db.close(); } catch (_) {}
    db = null;
    openError = err;
    throw err;
  }
  if (dbPath !== ':memory:') {
    try { fs.chmodSync(dbPath, 0o600); } catch (_) {}
  }
  const stored = getSetting('db.lastMigrationAt');
  if (stored) lastMigrationAt = Number(stored) || lastMigrationAt;
  openError = null;
  return db;
}

function close() {
  if (maintenanceTimer) {
    clearInterval(maintenanceTimer);
    maintenanceTimer = null;
  }
  if (!db) return;
  try { db.close(); } catch (_) {}
  db = null;
}

function getDb() {
  if (!db) throw new Error('Account database is not available');
  return db;
}

function tx(fn) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const result = fn(d);
    d.exec('COMMIT');
    return result;
  } catch (err) {
    try { d.exec('ROLLBACK'); } catch (_) {}
    throw err;
  }
}

function plain(row) {
  return row ? Object.assign({}, row) : null;
}

// ── 設定（key-value） ────────────────────────────────────────
function getSetting(key, fallback = null) {
  const row = getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  getDb().prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, String(value), now());
}

function getJsonSetting(key, fallback) {
  const raw = getSetting(key);
  if (raw === null) return fallback;
  try { return JSON.parse(raw); } catch (_) { return fallback; }
}

function setJsonSetting(key, value) {
  setSetting(key, JSON.stringify(value));
}

// ── 使用者 ───────────────────────────────────────────────────
function normalizeEmail(email) {
  if (typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}

function getUserById(id) {
  return plain(getDb().prepare('SELECT * FROM users WHERE id = ?').get(id));
}

function getUserByEmail(email) {
  const e = normalizeEmail(email);
  if (!e) return null;
  return plain(getDb().prepare('SELECT * FROM users WHERE email = ?').get(e));
}

function getUserByUsername(username) {
  if (typeof username !== 'string' || !username.trim()) return null;
  return plain(getDb().prepare('SELECT * FROM users WHERE username = ?').get(username.trim()));
}

function createUser(fields) {
  const t = now();
  const info = getDb().prepare(`INSERT INTO users
      (email, username, email_verified_at, display_name, password_hash, role, status, created_at,
       password_changed_at, terms_version, terms_accepted_at, signup_ip)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`)
    .run(
      fields.email ? normalizeEmail(fields.email) : null,
      fields.username || null,
      fields.emailVerifiedAt || null,
      fields.displayName || null,
      fields.passwordHash || null,
      fields.role === 'admin' ? 'admin' : 'user',
      t,
      fields.passwordHash ? t : null,
      fields.termsVersion || null,
      fields.termsVersion ? t : null,
      fields.signupIp || null
    );
  return getUserById(Number(info.lastInsertRowid));
}

const USER_UPDATABLE = {
  email: 'email', username: 'username', emailVerifiedAt: 'email_verified_at', displayName: 'display_name',
  passwordHash: 'password_hash', role: 'role', status: 'status', passwordChangedAt: 'password_changed_at',
  lastLoginAt: 'last_login_at', termsVersion: 'terms_version', termsAcceptedAt: 'terms_accepted_at'
};

function updateUser(id, fields) {
  const sets = [];
  const values = [];
  for (const [key, column] of Object.entries(USER_UPDATABLE)) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      sets.push(`${column} = ?`);
      let v = fields[key];
      if (key === 'email' && v) v = normalizeEmail(v);
      values.push(v === undefined ? null : v);
    }
  }
  if (!sets.length) return getUserById(id);
  values.push(id);
  getDb().prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getUserById(id);
}

function deleteUser(id) {
  return tx(d => {
    // 稽核紀錄保留但去識別：user_id 由外鍵設為 NULL，IP 一併清空。
    d.prepare('UPDATE auth_events SET ip = NULL, detail = NULL WHERE user_id = ?').run(id);
    d.prepare('DELETE FROM users WHERE id = ?').run(id);
  });
}

function countUsers(where = {}) {
  let sql = 'SELECT COUNT(*) AS n FROM users WHERE 1=1';
  const params = [];
  if (where.role) { sql += ' AND role = ?'; params.push(where.role); }
  if (where.status) { sql += ' AND status = ?'; params.push(where.status); }
  if (where.since) { sql += ' AND created_at >= ?'; params.push(where.since); }
  if (where.unverified) sql += ' AND email_verified_at IS NULL';
  return getDb().prepare(sql).get(...params).n;
}

function countActiveAdmins() {
  return getDb().prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'").get().n;
}

/**
 * 後台使用者清單：搜尋與篩選（Email、名稱、狀態、角色、登入方式），依建立時間新到舊。
 */
function listUsers({ q = '', status = '', role = '', provider = '', verified = '', limit = 50, offset = 0 } = {}) {
  let where = ' WHERE 1=1';
  const params = [];
  if (q) {
    where += ' AND (u.email LIKE ? OR u.display_name LIKE ? OR u.username LIKE ?)';
    const like = `%${q.replace(/[%_]/g, m => '\\' + m)}%`;
    params.push(like, like, like);
    where = where.replace(/LIKE \?/g, "LIKE ? ESCAPE '\\'");
  }
  if (status === 'active' || status === 'disabled') { where += ' AND u.status = ?'; params.push(status); }
  if (role === 'admin' || role === 'user') { where += ' AND u.role = ?'; params.push(role); }
  if (verified === 'yes') where += ' AND u.email_verified_at IS NOT NULL';
  if (verified === 'no') where += ' AND u.email_verified_at IS NULL';
  if (provider === 'password') where += ' AND u.password_hash IS NOT NULL';
  else if (provider) {
    where += ' AND EXISTS (SELECT 1 FROM user_identities i WHERE i.user_id = u.id AND i.provider = ?)';
    params.push(provider);
  }
  const d = getDb();
  const total = d.prepare(`SELECT COUNT(*) AS n FROM users u${where}`).get(...params).n;
  const rows = d.prepare(`SELECT u.id, u.email, u.username, u.display_name, u.role, u.status, u.email_verified_at,
      u.created_at, u.last_login_at, (u.password_hash IS NOT NULL) AS has_password,
      (SELECT GROUP_CONCAT(provider) FROM user_identities i WHERE i.user_id = u.id) AS providers,
      (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS session_count
      FROM users u${where} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`)
    .all(now(), ...params, Math.min(Math.max(limit, 1), 200), Math.max(offset, 0))
    .map(plain);
  return { total, rows };
}

// ── 第三方登入綁定 ───────────────────────────────────────────
function getIdentity(provider, subject) {
  return plain(getDb().prepare('SELECT * FROM user_identities WHERE provider = ? AND subject = ?').get(provider, String(subject)));
}

function listIdentities(userId) {
  return getDb().prepare('SELECT provider, subject, email, created_at FROM user_identities WHERE user_id = ? ORDER BY created_at')
    .all(userId).map(plain);
}

function linkIdentity(userId, provider, subject, email) {
  getDb().prepare(`INSERT INTO user_identities (provider, subject, user_id, email, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(provider, subject) DO UPDATE SET user_id = excluded.user_id, email = excluded.email`)
    .run(provider, String(subject), userId, email || null, now());
}

function unlinkIdentity(userId, provider) {
  return getDb().prepare('DELETE FROM user_identities WHERE user_id = ? AND provider = ?').run(userId, provider).changes;
}

// ── 信件 token ───────────────────────────────────────────────
function createEmailToken(userId, purpose, ttlMs, newEmail = null) {
  const token = crypto.randomBytes(32).toString('base64url');
  const t = now();
  const d = getDb();
  // 同一用途只留最新一封，舊連結立即失效。
  d.prepare('DELETE FROM email_tokens WHERE user_id = ? AND purpose = ? AND used_at IS NULL').run(userId, purpose);
  d.prepare(`INSERT INTO email_tokens (token_hash, user_id, purpose, created_at, expires_at, new_email)
    VALUES (?, ?, ?, ?, ?, ?)`).run(sha256(token), userId, purpose, t, t + ttlMs, newEmail ? normalizeEmail(newEmail) : null);
  return token;
}

/** 取用 token：檢查用途與期限，標記為已用。無效時回傳 null。 */
function consumeEmailToken(token, purpose) {
  if (typeof token !== 'string' || !token || token.length > 200) return null;
  const d = getDb();
  const row = d.prepare('SELECT * FROM email_tokens WHERE token_hash = ?').get(sha256(token));
  if (!row || row.purpose !== purpose || row.used_at || row.expires_at < now()) return null;
  d.prepare('UPDATE email_tokens SET used_at = ? WHERE token_hash = ?').run(now(), row.token_hash);
  return plain(row);
}

function peekEmailToken(token, purpose) {
  if (typeof token !== 'string' || !token || token.length > 200) return null;
  const row = getDb().prepare('SELECT * FROM email_tokens WHERE token_hash = ?').get(sha256(token));
  if (!row || row.purpose !== purpose || row.used_at || row.expires_at < now()) return null;
  return plain(row);
}

// ── 邀請碼 ───────────────────────────────────────────────────
function createInvite({ createdBy, usesLeft = 1, expiresAt = null, note = '' }) {
  const code = crypto.randomBytes(9).toString('base64url');
  const info = getDb().prepare(`INSERT INTO invites (code_hash, code_hint, note, created_by, created_at, expires_at, uses_left)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(sha256(code), code.slice(0, 4), note ? String(note).slice(0, 200) : null, createdBy || null, now(), expiresAt, Math.max(1, Math.min(1000, usesLeft | 0)));
  return { id: Number(info.lastInsertRowid), code };
}

function listInvites() {
  return getDb().prepare(`SELECT id, code_hint, note, created_at, expires_at, uses_left, uses_count, revoked_at,
      (SELECT COALESCE(email, username) FROM users WHERE id = invites.created_by) AS created_by
      FROM invites ORDER BY created_at DESC LIMIT 200`).all().map(plain);
}

function revokeInvite(id) {
  return getDb().prepare('UPDATE invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now(), id).changes;
}

/** 檢查並用掉一次邀請碼；成功回傳 true。 */
function useInvite(code) {
  if (typeof code !== 'string' || !code.trim()) return false;
  const d = getDb();
  const row = d.prepare('SELECT * FROM invites WHERE code_hash = ?').get(sha256(code.trim()));
  if (!row || row.revoked_at || row.uses_left <= 0) return false;
  if (row.expires_at && row.expires_at < now()) return false;
  d.prepare('UPDATE invites SET uses_left = uses_left - 1, uses_count = uses_count + 1 WHERE id = ?').run(row.id);
  return true;
}

// ── Session ──────────────────────────────────────────────────
function createSession(userId, token, { ttlMs, ip, userAgent }) {
  const t = now();
  getDb().prepare(`INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, reauth_at, ip, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(sha256(token), userId, t, t, t + ttlMs, t, ip || null, userAgent ? String(userAgent).slice(0, 300) : null);
}

function getSessionByToken(token) {
  if (typeof token !== 'string' || !token || token.length > 200) return null;
  return plain(getDb().prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha256(token)));
}

function touchSession(id, { lastSeenAt, expiresAt, ip }) {
  getDb().prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ?, ip = COALESCE(?, ip) WHERE id = ?')
    .run(lastSeenAt, expiresAt, ip || null, id);
}

function markSessionReauth(id) {
  getDb().prepare('UPDATE sessions SET reauth_at = ? WHERE id = ?').run(now(), id);
}

function deleteSessionById(id, userId = null) {
  if (userId !== null) {
    return getDb().prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').run(id, userId).changes;
  }
  return getDb().prepare('DELETE FROM sessions WHERE id = ?').run(id).changes;
}

function deleteSessionByToken(token) {
  if (typeof token !== 'string' || !token) return 0;
  return getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token)).changes;
}

function deleteUserSessions(userId, exceptId = null) {
  if (exceptId !== null) {
    return getDb().prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(userId, exceptId).changes;
  }
  return getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes;
}

function listUserSessions(userId) {
  return getDb().prepare(`SELECT id, created_at, last_seen_at, expires_at, ip, user_agent FROM sessions
    WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC`).all(userId, now()).map(plain);
}

/** 角色改變時，把該使用者現有 session 的到期時間套用新規則。 */
/** 尚未過期的 session 數；adminOnly 時只算管理員的。 */
function countActiveSessions({ adminOnly = false } = {}) {
  if (!db) return 0;
  const sql = adminOnly
    ? "SELECT COUNT(*) AS n FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.expires_at > ? AND u.role = 'admin'"
    : 'SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?';
  return db.prepare(sql).get(now()).n;
}

function clampUserSessions(userId, ttlMs) {
  getDb().prepare('UPDATE sessions SET expires_at = MIN(expires_at, last_seen_at + ?) WHERE user_id = ?').run(ttlMs, userId);
}

// ── 稽核紀錄 ─────────────────────────────────────────────────
function logEvent(event, { userId = null, actorId = null, ip = null, detail = null } = {}) {
  if (!db) return;
  try {
    db.prepare('INSERT INTO auth_events (user_id, actor_id, event, detail, ip, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId, actorId, String(event).slice(0, 60), detail ? String(detail).slice(0, 300) : null, ip, now());
  } catch (_) {}
}

function listEvents({ userId = null, ip = '', event = '', limit = 100, before = null } = {}) {
  let sql = `SELECT e.id, e.event, e.detail, e.ip, e.at, e.user_id, e.actor_id,
      COALESCE(u.email, u.username) AS user_label, COALESCE(a.email, a.username) AS actor_label
      FROM auth_events e
      LEFT JOIN users u ON u.id = e.user_id
      LEFT JOIN users a ON a.id = e.actor_id WHERE 1=1`;
  const params = [];
  if (userId) { sql += ' AND e.user_id = ?'; params.push(userId); }
  if (ip) { sql += ' AND e.ip = ?'; params.push(ip); }
  if (event) { sql += ' AND e.event LIKE ?'; params.push(`${event}%`); }
  if (before) { sql += ' AND e.id < ?'; params.push(before); }
  sql += ' ORDER BY e.id DESC LIMIT ?';
  params.push(Math.min(Math.max(limit, 1), 500));
  return getDb().prepare(sql).all(...params).map(plain);
}

function countEventsSince(since, prefix) {
  return getDb().prepare('SELECT event, COUNT(*) AS n FROM auth_events WHERE at >= ? AND event LIKE ? GROUP BY event')
    .all(since, `${prefix}%`).map(plain);
}

function lastEvent(event) {
  return plain(getDb().prepare('SELECT * FROM auth_events WHERE event = ? ORDER BY id DESC LIMIT 1').get(event));
}

// ── 例行維護 ─────────────────────────────────────────────────
const EVENT_RETENTION_MS = 365 * DAY_MS;
const UNVERIFIED_RETENTION_MS = 7 * DAY_MS;

function pruneExpired() {
  if (!db) return {};
  const t = now();
  const d = db;
  const sessionsRemoved = d.prepare('DELETE FROM sessions WHERE expires_at < ?').run(t).changes;
  const tokensRemoved = d.prepare('DELETE FROM email_tokens WHERE expires_at < ? OR used_at < ?').run(t, t - DAY_MS).changes;
  const eventsRemoved = d.prepare('DELETE FROM auth_events WHERE at < ?').run(t - EVENT_RETENTION_MS).changes;
  // 7 天未驗證的 Email 帳號自動刪除（有第三方綁定或管理員的不刪）。
  const stale = d.prepare(`SELECT id FROM users WHERE email_verified_at IS NULL AND role = 'user' AND created_at < ?
      AND NOT EXISTS (SELECT 1 FROM user_identities i WHERE i.user_id = users.id)`).all(t - UNVERIFIED_RETENTION_MS);
  for (const row of stale) deleteUser(row.id);
  return { sessionsRemoved, tokensRemoved, eventsRemoved, unverifiedRemoved: stale.length };
}

// ── 備份 ─────────────────────────────────────────────────────
function listBackups() {
  if (!backupDir || !fs.existsSync(backupDir)) return [];
  return fs.readdirSync(backupDir)
    .filter(name => /^users-[\w.-]+\.db$/.test(name))
    .map(name => {
      const st = fs.statSync(path.join(backupDir, name));
      return { name, size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function resolveBackupPath(name) {
  if (!backupDir || typeof name !== 'string' || !/^users-[\w.-]+\.db$/.test(name)) return null;
  const full = path.join(backupDir, name);
  if (path.dirname(full) !== path.resolve(backupDir)) return null;
  return fs.existsSync(full) ? full : null;
}

/** 立即備份；每日例行備份同名覆寫，並只保留最近 7 份每日備份。 */
function backupNow(kind = 'manual') {
  if (!db || !backupDir) return null;
  let name;
  if (kind === 'daily') name = backupFileName('users');
  else {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    name = `users-manual-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}.db`;
  }
  const target = path.join(backupDir, name);
  snapshotTo(target);
  const daily = listBackups().filter(b => /^users-\d{8}\.db$/.test(b.name));
  for (const old of daily.slice(BACKUP_KEEP)) {
    try { fs.rmSync(path.join(backupDir, old.name)); } catch (_) {}
  }
  const manual = listBackups().filter(b => b.name.startsWith('users-manual-') || b.name.startsWith('users-before-restore-'));
  for (const old of manual.slice(BACKUP_KEEP)) {
    try { fs.rmSync(path.join(backupDir, old.name)); } catch (_) {}
  }
  return { name, size: fs.statSync(target).size };
}

/**
 * 還原：先備份現況，關閉資料庫，換檔，重開（重開時會補跑遷移）。
 * 備份當時存在的 session 會重新生效，所以呼叫端應視需要清空 sessions。
 */
function restoreBackup(name) {
  const source = resolveBackupPath(name);
  if (!source) throw new Error('找不到這份備份');
  if (!dbPath || dbPath === ':memory:') throw new Error('記憶體資料庫無法還原');
  // 先確認來源是可開啟的 SQLite 檔。
  const probe = new DatabaseSync(source, { readOnly: true });
  try { probe.prepare('PRAGMA user_version').get(); } finally { probe.close(); }
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  // 同一秒內連續還原（例如立刻還原回剛產生的安全備份）時不能覆寫要還原的來源檔。
  let safety = `users-before-restore-${stamp}.db`;
  for (let n = 2; safety === name || fs.existsSync(path.join(backupDir, safety)); n++) safety = `users-before-restore-${stamp}-${n}.db`;
  snapshotTo(path.join(backupDir, safety));
  const keepPath = dbPath;
  const keepBackupDir = backupDir;
  close();
  for (const suffix of ['-wal', '-shm']) {
    try { fs.rmSync(keepPath + suffix, { force: true }); } catch (_) {}
  }
  fs.copyFileSync(source, keepPath);
  open({ path: keepPath, backupDir: keepBackupDir, force: true });
  startMaintenance();
  return { restored: name, safetyBackup: safety };
}

function getStatus() {
  if (!db) {
    return { available: false, error: openError ? openError.message : null };
  }
  let size = 0;
  let walSize = 0;
  if (dbPath && dbPath !== ':memory:') {
    try { size = fs.statSync(dbPath).size; } catch (_) {}
    try { walSize = fs.statSync(dbPath + '-wal').size; } catch (_) {}
  }
  return {
    available: true,
    userVersion: db.prepare('PRAGMA user_version').get().user_version,
    schemaVersion: SCHEMA_VERSION,
    lastMigrationAt,
    size,
    walSize,
    inMemory: dbPath === ':memory:',
    backupsEnabled: !!backupDir,
    users: countUsers()
  };
}

function runMaintenance() {
  if (!db) return;
  try { pruneExpired(); } catch (_) {}
  try {
    if (backupDir) {
      const today = backupFileName('users');
      if (!fs.existsSync(path.join(backupDir, today))) backupNow('daily');
    }
  } catch (_) {}
}

/** 每小時清過期資料，並確保當天有一份每日備份。 */
function startMaintenance() {
  if (maintenanceTimer || !db) return;
  maintenanceTimer = setInterval(runMaintenance, 60 * 60 * 1000);
  if (maintenanceTimer.unref) maintenanceTimer.unref();
  // 啟動後稍等再跑第一次（清過期資料、當天第一份備份），不拖慢開機。
  const first = setTimeout(runMaintenance, 60 * 1000);
  if (first.unref) first.unref();
}

module.exports = {
  open,
  close,
  isAvailable,
  getOpenError,
  getDataDir,
  getDb,
  tx,
  sha256,
  normalizeEmail,
  SCHEMA_VERSION,
  // settings
  getSetting,
  setSetting,
  getJsonSetting,
  setJsonSetting,
  // users
  getUserById,
  getUserByEmail,
  getUserByUsername,
  createUser,
  updateUser,
  deleteUser,
  countUsers,
  countActiveAdmins,
  listUsers,
  // identities
  getIdentity,
  listIdentities,
  linkIdentity,
  unlinkIdentity,
  // email tokens
  createEmailToken,
  consumeEmailToken,
  peekEmailToken,
  // invites
  createInvite,
  listInvites,
  revokeInvite,
  useInvite,
  // sessions
  createSession,
  getSessionByToken,
  touchSession,
  markSessionReauth,
  deleteSessionById,
  deleteSessionByToken,
  deleteUserSessions,
  listUserSessions,
  countActiveSessions,
  clampUserSessions,
  // events
  logEvent,
  listEvents,
  countEventsSince,
  lastEvent,
  // maintenance & backups
  pruneExpired,
  runMaintenance,
  startMaintenance,
  listBackups,
  resolveBackupPath,
  backupNow,
  restoreBackup,
  getStatus
};
