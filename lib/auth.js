/**
 * @file lib/auth.js — Authentication, Session Store, and Rate Limiting
 */

const crypto = require('crypto');
const net = require('net');
const { getClientIP } = require('./utils');

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

function readJSONBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    const MAX_SIZE = 1024 * 1024; // 1MB size limit to prevent DoS memory exhaustion
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > MAX_SIZE) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (_) {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

module.exports = {
  sessions,
  SESSION_DURATION,
  loginAttempts,
  MAX_ATTEMPTS,
  LOCK_DURATION,
  apiRateLimits,
  checkApiRateLimit,
  timingSafeCompare,
  hashPassword,
  generateSessionToken,
  verifySameOrigin,
  isAuthenticated,
  readJSONBody
};
