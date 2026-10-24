/**
 * @file lib/auth.js — Authentication, Session Store, and Rate Limiting
 */

const crypto = require('crypto');
const net = require('net');
const { getClientIP } = require('./utils');
const { IS_SINGLE_USER, IS_LOOPBACK_ONLY } = require('./constants');

// Session store mapping: token -> { expiry: timestamp }
const sessions = new Map();
const SESSION_DURATION = 6 * 60 * 60 * 1000; // 6 hours session expiry

// Periodic background cleanup of expired session tokens (every 15 minutes)
const sessionCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (session.expiry && now > session.expiry) {
      sessions.delete(token);
    }
  }
}, 15 * 60 * 1000);
if (sessionCleanupTimer && sessionCleanupTimer.unref) sessionCleanupTimer.unref();

// Rate limiting / brute-force protection map: ip -> { attempts: count, lockUntil: timestamp }
const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCK_DURATION = 15 * 60 * 1000; // 15 minutes lockout
const MAX_LOGIN_ENTRIES = 10000;

// Periodic cleanup for rate limits and login attempts (every 1 hour)
const rateLimitCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (now > session.expiry) {
      sessions.delete(token);
    }
  }
  for (const [ip, attempt] of loginAttempts.entries()) {
    if (now > attempt.lockUntil && attempt.attempts > 0) {
      if (now > attempt.lockUntil + 60 * 60 * 1000) {
        loginAttempts.delete(ip);
      }
    }
  }
}, 60 * 60 * 1000);
if (rateLimitCleanupTimer && rateLimitCleanupTimer.unref) rateLimitCleanupTimer.unref();

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

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
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

function isAuthenticated(req) {
  if (!verifySameOrigin(req)) return false;
  const token = req.headers['x-admin-token'];
  if (!token) return false;
  const session = sessions.get(token);
  if (!session) return false;

  if (Date.now() > session.expiry) {
    sessions.delete(token); // Session expired
    return false;
  }

  // Slide session expiry on active request
  session.expiry = Date.now() + SESSION_DURATION;
  return true;
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
  sessions,
  SESSION_DURATION,
  loginAttempts,
  MAX_ATTEMPTS,
  LOCK_DURATION,
  MAX_LOGIN_ENTRIES,
  apiRateLimits,
  checkApiRateLimit,
  timingSafeCompare,
  hashPassword,
  generateSessionToken,
  verifySameOrigin,
  isAuthenticated,
  isLoopbackRequest,
  isAuthorizedAdmin,
  requireAdmin,
  readJSONBody
};
