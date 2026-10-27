/**
 * @file lib/turnstile.js — Cloudflare Turnstile 人機驗證
 *
 * TURNSTILE_SITE_KEY 給前端，TURNSTILE_SECRET_KEY 只在伺服器端呼叫 siteverify。
 * 沒設定時回傳 { ok: true, skipped: true }，由隱藏欄位與限速提供基本防護。
 * token 5 分鐘有效且只能驗一次；逾時（5 秒）或 Cloudflare 故障時回傳
 * { ok: false, unavailable: true }，由呼叫端決定要拒絕（註冊、寄信）或放行（登入）。
 */

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TIMEOUT_MS = 5000;

let lastResult = null;

function getSiteKey() {
  return (process.env.TURNSTILE_SITE_KEY || '').trim();
}

function isConfigured() {
  return !!getSiteKey() && !!(process.env.TURNSTILE_SECRET_KEY || '').trim();
}

/**
 * @param {string} token 前端元件取得的回應 token
 * @param {{ip?:string, action?:string, hostname?:string}} opts
 */
async function verify(token, { ip = '', action = '', hostname = '' } = {}) {
  if (!isConfigured()) return { ok: true, skipped: true };
  if (typeof token !== 'string' || !token || token.length > 2048) {
    return record({ ok: false, reason: 'missing-input-response' });
  }
  try {
    const body = new URLSearchParams({
      secret: process.env.TURNSTILE_SECRET_KEY.trim(),
      response: token,
      idempotency_key: require('crypto').randomUUID()
    });
    if (ip) body.set('remoteip', ip);
    const res = await fetch(SITEVERIFY_URL, { method: 'POST', body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return record({ ok: false, unavailable: true, reason: `http-${res.status}` });
    const data = await res.json();
    if (!data || data.success !== true) {
      return record({ ok: false, reason: (data && data['error-codes'] || []).join(',') || 'failed' });
    }
    // 測試金鑰回傳的 hostname 為 example.com、action 為空，只在兩者都有值時比對。
    if (hostname && data.hostname && data.hostname !== hostname && data.hostname !== 'example.com') {
      return record({ ok: false, reason: 'hostname-mismatch' });
    }
    if (action && data.action && data.action !== action) {
      return record({ ok: false, reason: 'action-mismatch' });
    }
    return record({ ok: true });
  } catch (err) {
    return record({ ok: false, unavailable: true, reason: err && err.name === 'TimeoutError' ? 'timeout' : 'network' });
  }
}

function record(result) {
  lastResult = Object.assign({ at: Date.now() }, result);
  return result;
}

function getStatus() {
  return {
    configured: isConfigured(),
    siteKeySet: !!getSiteKey(),
    secretSet: !!(process.env.TURNSTILE_SECRET_KEY || '').trim(),
    lastResult
  };
}

module.exports = { getSiteKey, isConfigured, verify, getStatus };
