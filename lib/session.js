/**
 * @file lib/session.js — Cookie session
 *
 * 隨機 token 放 HttpOnly + SameSite=Lax 的 cookie，資料庫只存 SHA-256。
 * - 名稱：HTTPS 時為 `__Host-mdw_sid`（加 Secure；前綴讓子網域無法覆寫），
 *   純 HTTP（區網、本機開發）時改用 `mdw_sid`，否則瀏覽器根本不會送回 cookie。
 * - COOKIE_SECURE=auto（預設）依連線判斷：TLS socket，或受信任代理（TRUST_PROXY）
 *   送來的 X-Forwarded-Proto: https。也可固定為 true / false。
 * - 「沒用才過期」：一般使用者 30 天、admin 7 天沒使用就過期；每次請求延長，
 *   但最多每 5 分鐘寫一次資料庫。
 */

const crypto = require('crypto');
const db = require('./db');
const { getClientIP, isTrustedProxyPeer } = require('./utils');

const DAY_MS = 24 * 60 * 60 * 1000;
const USER_IDLE_MS = 30 * DAY_MS;
const ADMIN_IDLE_MS = 7 * DAY_MS;
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const REAUTH_WINDOW_MS = 10 * 60 * 1000;

const COOKIE_SECURE_NAME = '__Host-mdw_sid';
const COOKIE_PLAIN_NAME = 'mdw_sid';

function idleTtlFor(role) {
  return role === 'admin' ? ADMIN_IDLE_MS : USER_IDLE_MS;
}

function parseCookies(req) {
  const header = req && req.headers ? req.headers.cookie : '';
  const out = {};
  if (!header || typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    if (!name || Object.prototype.hasOwnProperty.call(out, name)) continue;
    let value = part.slice(idx + 1).trim();
    try { value = decodeURIComponent(value); } catch (_) {}
    out[name] = value;
  }
  return out;
}

function isSecureRequest(req) {
  const mode = (process.env.COOKIE_SECURE || 'auto').trim().toLowerCase();
  if (mode === 'true' || mode === '1') return true;
  if (mode === 'false' || mode === '0') return false;
  if (req && req.socket && req.socket.encrypted) return true;
  const socketIp = req && req.socket ? String(req.socket.remoteAddress || '') : '';
  const peer = socketIp.startsWith('::ffff:') ? socketIp.slice(7) : socketIp;
  if (isTrustedProxyPeer(peer)) {
    const proto = String((req.headers && req.headers['x-forwarded-proto']) || '').split(',')[0].trim().toLowerCase();
    if (proto === 'https') return true;
    // Cloudflare Tunnel 會帶 CF-Visitor: {"scheme":"https"}
    const visitor = String((req.headers && req.headers['cf-visitor']) || '');
    if (/"scheme"\s*:\s*"https"/.test(visitor)) return true;
  }
  return false;
}

function serializeCookie(name, value, { maxAgeSec = null, secure = false, sameSite = 'Lax', httpOnly = true, path = '/' } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}`;
  if (httpOnly) c += '; HttpOnly';
  if (secure) c += '; Secure';
  if (maxAgeSec !== null) c += `; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`;
  return c;
}

function appendSetCookie(res, cookie) {
  const prev = res.getHeader('Set-Cookie');
  if (!prev) res.setHeader('Set-Cookie', [cookie]);
  else res.setHeader('Set-Cookie', (Array.isArray(prev) ? prev : [prev]).concat(cookie));
}

/**
 * 取得 session token：先看 cookie，再看 X-Admin-Token 標頭（舊版管理介面與命令列工具用）。
 * 標頭只能由同源腳本送出（跨站要先過 CORS 預檢），所以帶標頭的請求不受 CSRF 影響。
 */
function getSessionToken(req) {
  const cookies = parseCookies(req);
  const fromCookie = cookies[COOKIE_SECURE_NAME] || cookies[COOKIE_PLAIN_NAME];
  if (fromCookie) return fromCookie;
  const header = req && req.headers ? req.headers['x-admin-token'] : '';
  return typeof header === 'string' && header ? header : null;
}

/** 這個請求是否以標頭（而非 cookie）帶 session。 */
function usesHeaderToken(req) {
  const cookies = parseCookies(req);
  if (cookies[COOKIE_SECURE_NAME] || cookies[COOKIE_PLAIN_NAME]) return false;
  const header = req && req.headers ? req.headers['x-admin-token'] : '';
  return typeof header === 'string' && !!header;
}

function setSessionCookie(req, res, token, role) {
  const secure = isSecureRequest(req);
  const name = secure ? COOKIE_SECURE_NAME : COOKIE_PLAIN_NAME;
  // Cookie 本身給較長的 Max-Age；真正的到期由資料庫的 expires_at 決定（使用即延長）。
  appendSetCookie(res, serializeCookie(name, token, { maxAgeSec: 400 * 24 * 60 * 60, secure }));
  // 從 HTTP 換到 HTTPS（或反之）時，清掉另一個名稱的舊 cookie。
  const other = secure ? COOKIE_PLAIN_NAME : null;
  if (other) appendSetCookie(res, serializeCookie(other, '', { maxAgeSec: 0, secure: false }));
}

function clearSessionCookie(req, res) {
  const secure = isSecureRequest(req);
  if (secure) appendSetCookie(res, serializeCookie(COOKIE_SECURE_NAME, '', { maxAgeSec: 0, secure: true }));
  appendSetCookie(res, serializeCookie(COOKIE_PLAIN_NAME, '', { maxAgeSec: 0, secure: false }));
}

/** 每次登入都發新 token（防 session fixation）。 */
function startSession(req, res, user) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.createSession(user.id, token, {
    ttlMs: idleTtlFor(user.role),
    ip: getClientIP(req),
    userAgent: req.headers['user-agent'] || ''
  });
  setSessionCookie(req, res, token, user.role);
  db.updateUser(user.id, { lastLoginAt: Date.now() });
  req._mdwSession = undefined;
  return token;
}

/**
 * 解析目前請求的 session，回傳 { session, user } 或 null。
 * 結果快取在 req 上，同一請求內多次呼叫只查一次資料庫。
 */
function getSession(req) {
  if (!req) return null;
  if (req._mdwSession !== undefined) return req._mdwSession;
  req._mdwSession = null;
  if (!db.isAvailable()) return null;
  const token = getSessionToken(req);
  if (!token) return null;
  let session;
  try { session = db.getSessionByToken(token); } catch (_) { return null; }
  if (!session) return null;
  const t = Date.now();
  if (session.expires_at < t) {
    try { db.deleteSessionById(session.id); } catch (_) {}
    return null;
  }
  const user = db.getUserById(session.user_id);
  if (!user || user.status !== 'active') {
    try { db.deleteSessionById(session.id); } catch (_) {}
    return null;
  }
  if (t - session.last_seen_at > TOUCH_INTERVAL_MS) {
    const expiresAt = t + idleTtlFor(user.role);
    try { db.touchSession(session.id, { lastSeenAt: t, expiresAt, ip: getClientIP(req) }); } catch (_) {}
    session.last_seen_at = t;
    session.expires_at = expiresAt;
  }
  req._mdwSession = { session, user, token };
  return req._mdwSession;
}

function getUser(req) {
  const s = getSession(req);
  return s ? s.user : null;
}

function endSession(req, res) {
  const token = getSessionToken(req);
  if (token && db.isAvailable()) {
    try { db.deleteSessionByToken(token); } catch (_) {}
  }
  clearSessionCookie(req, res);
  req._mdwSession = null;
}

/** 敏感操作要求 10 分鐘內重新驗證（登入本身也算一次）。 */
function hasRecentReauth(req) {
  const s = getSession(req);
  if (!s) return false;
  const at = s.session.reauth_at || s.session.created_at;
  return Date.now() - at <= REAUTH_WINDOW_MS;
}

function markReauth(req) {
  const s = getSession(req);
  if (!s) return;
  db.markSessionReauth(s.session.id);
  s.session.reauth_at = Date.now();
}

module.exports = {
  USER_IDLE_MS,
  ADMIN_IDLE_MS,
  REAUTH_WINDOW_MS,
  COOKIE_SECURE_NAME,
  COOKIE_PLAIN_NAME,
  idleTtlFor,
  parseCookies,
  isSecureRequest,
  serializeCookie,
  appendSetCookie,
  getSessionToken,
  usesHeaderToken,
  startSession,
  getSession,
  getUser,
  endSession,
  clearSessionCookie,
  hasRecentReauth,
  markReauth
};
