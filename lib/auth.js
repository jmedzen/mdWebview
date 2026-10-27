/**
 * @file lib/auth.js — 管理員權限檢查、同源檢查、API 限速
 */

const crypto = require('crypto');
const net = require('net');
const { getClientIP } = require('./utils');
const { IS_SINGLE_USER, IS_LOOPBACK_ONLY } = require('./constants');

// 帳號、session 與登入限速都在 lib/accounts.js、lib/session.js（資料庫版）。
// 這裡延遲載入，避免 logger → analytics → auth 的循環相依在載入時拿到半成品。
function accounts() { return require('./accounts'); }
function sessionStore() { return require('./session'); }

const MAX_ATTEMPTS = 5;
const LOCK_DURATION = 15 * 60 * 1000; // 帳號連續失敗的最長鎖定時間
const MAX_LOGIN_ENTRIES = 10000;

/**
 * 登入失敗計數（以帳號為單位）。保留這個名稱給舊程式與測試使用，
 * 實際資料在 lib/accounts.js；clear() 也會清掉以 IP 計的失敗次數。
 */
const loginAttempts = {
  clear() { accounts().accountAttempts.clear(); },
  get size() { return accounts().accountAttempts.size; },
  get(key) { return accounts().accountAttempts.get(key); },
  delete(key) { return accounts().accountAttempts.delete(key); }
};

// API Sliding window rate limits: ip -> { count: number, windowStart: timestamp }
const apiRateLimits = new Map();
const API_RATE_LIMIT_WINDOW_MS = 1000;
const API_RATE_LIMIT_MAX = 30;
const MAX_RATE_LIMIT_ENTRIES = 10000;

function checkApiRateLimit(req, res, onBlock) {
  const ip = getClientIP(req);
  const now = Date.now();
  let record = apiRateLimits.get(ip);

  if (!record || (now - record.windowStart) >= API_RATE_LIMIT_WINDOW_MS) {
    record = { count: 1, windowStart: now };
    apiRateLimits.set(ip, record);
    if (apiRateLimits.size > MAX_RATE_LIMIT_ENTRIES) {
      const oldestKey = apiRateLimits.keys().next().value;
      apiRateLimits.delete(oldestKey);
    }
    return true;
  }

  record.count += 1;
  if (record.count > API_RATE_LIMIT_MAX) {
    if (typeof onBlock === 'function') {
      onBlock(ip, record.count);
    }
    return false;
  }

  return true;
}

function timingSafeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA); // dummy operation
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function hashPassword(password, salt, iterations = 100000) {
  return new Promise((resolve, reject) => {
    if (!salt) {
      salt = crypto.randomBytes(16).toString('hex');
    }
    crypto.pbkdf2(password, salt, iterations, 64, 'sha512', (err, derivedKey) => {
      if (err) return reject(err);
      resolve({ salt, hash: derivedKey.toString('hex'), iterations });
    });
  });
}

function verifySameOrigin(req) {
  const origin = req.headers['origin'];
  const referer = req.headers['referer'];
  const host = req.headers['host'];
  if (!host) return true;

  if (origin) {
    try {
      const originHost = new URL(origin).host;
      if (originHost !== host) return false;
    } catch (_) {
      return false;
    }
  } else if (referer) {
    try {
      const refererHost = new URL(referer).host;
      if (refererHost !== host) return false;
    } catch (_) {
      return false;
    }
  }
  return true;
}

/**
 * 目前請求的管理員帳號；不是管理員或 session 無效時回傳 null。
 * 以 cookie 帶 session 的請求，若會改資料（非 GET/HEAD）還要通過嚴格同源檢查，
 * 因為瀏覽器會自動附上 cookie；以 X-Admin-Token 標頭帶 session 的沿用舊規則。
 */
function getAdminUser(req) {
  if (!verifySameOrigin(req)) return null;
  const s = sessionStore().getSession(req);
  if (!s || s.user.role !== 'admin') return null;
  const method = String(req.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && !accounts().isSameOriginStrict(req)) return null;
  return s.user;
}

function isAuthenticated(req) {
  return !!getAdminUser(req);
}

/**
 * True when the request genuinely arrived over the loopback interface.
 *
 * Deliberately reads `req.socket.remoteAddress` and NOT `getClientIP()`.
 * getClientIP honours TRUST_PROXY, so it returns whatever the client put in
 * X-Forwarded-For / CF-Connecting-IP; a remote attacker could therefore send
 * `X-Forwarded-For: 127.0.0.1` and be treated as local. In single-user mode that
 * would hand out administrator-equivalent privileges, so the check must use the
 * only value the peer cannot forge: the TCP peer address.
 *
 * Accepts the whole 127.0.0.0/8 range, IPv6 ::1, and IPv4-mapped IPv6
 * (::ffff:127.0.0.1) as Node reports it on dual-stack listeners.
 *
 * @param {import('http').IncomingMessage} req
 * @returns {boolean}
 */
function isLoopbackRequest(req) {
  if (!req || !req.socket) return false;
  let addr = req.socket.remoteAddress;
  if (typeof addr !== 'string' || addr === '') return false;
  // Node prefixes IPv4-mapped addresses on dual-stack sockets.
  if (addr.startsWith('::ffff:')) addr = addr.substring(7);
  // Strip an IPv6 zone index (fe80::1%eth0) — never loopback, but be explicit.
  const zoneIndex = addr.indexOf('%');
  if (zoneIndex !== -1) addr = addr.substring(0, zoneIndex);
  if (addr === '::1') return true;
  if (net.isIPv4(addr)) return addr.startsWith('127.');
  return false;
}

/**
 * Authorization gate for administrative endpoints.
 *
 * Web deployments require a real admin session, exactly as before. Single-user
 * bundles have no meaningful way to log in — the account is intentionally never
 * created — so a request that provably came from this machine is treated as the
 * owner. Anything arriving from off-machine is still rejected, which keeps the
 * loopback HTTP port from becoming a remote root hole.
 *
 * @param {import('http').IncomingMessage} req
 * @returns {boolean}
 */
function isAuthorizedAdmin(req) {
  if (isAuthenticated(req)) return true;
  if (!IS_SINGLE_USER) return false;
  // Fail closed: a single-user request must still prove it came from this
  // machine. IS_LOOPBACK_ONLY is unconditionally true for single-user targets
  // (see lib/constants.js), so this is deliberately not a bypassable branch —
  // no environment variable may widen privileged endpoints to the network.
  return IS_LOOPBACK_ONLY && isLoopbackRequest(req);
}

/**
 * Enforce the admin gate, replying 401 when it fails.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {(status:number, body:object)=>void} sendJSON reply helper
 * @returns {boolean} true when the caller may proceed
 */
function requireAdmin(req, res, sendJSON) {
  if (isAuthorizedAdmin(req)) return true;
  if (typeof sendJSON === 'function') {
    sendJSON(res, 401, { error: 'Unauthorized' });
  }
  return false;
}

/**
 * Read and parse a JSON request body (max 1 MiB).
 *
 * Chunks are collected as Buffers and decoded once at the end: decoding each
 * chunk separately corrupts any multi-byte UTF-8 character (all CJK text) that
 * happens to straddle a chunk boundary. The limit is measured in bytes.
 * A malformed or non-object body resolves to {} so callers' field validation
 * answers 400, as before.
 */
function readJSONBody(req) {
  return new Promise((resolve, reject) => {
    const MAX_SIZE = 1024 * 1024; // 1MB size limit to prevent DoS memory exhaustion
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', chunk => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf-8');
      size += buf.length;
      if (size > MAX_SIZE) {
        settled = true;
        chunks.length = 0;
        req.destroy();
        reject(new Error('Payload too large'));
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {});
      } catch (_) {
        resolve({});
      }
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

module.exports = {
  loginAttempts,
  MAX_ATTEMPTS,
  LOCK_DURATION,
  MAX_LOGIN_ENTRIES,
  apiRateLimits,
  checkApiRateLimit,
  timingSafeCompare,
  hashPassword,
  verifySameOrigin,
  getAdminUser,
  isAuthenticated,
  isLoopbackRequest,
  isAuthorizedAdmin,
  requireAdmin,
  readJSONBody
};
