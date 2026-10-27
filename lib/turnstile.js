/**
 * @file lib/turnstile.js — Cloudflare Turnstile 人機驗證
 *
 * TURNSTILE_SITE_KEY 給前端，TURNSTILE_SECRET_KEY 只在伺服器端呼叫 siteverify。
 * 兩者都可以在後台網頁填寫（見 lib/integrations.js），環境變數有設定時優先。
 * 沒設定時回傳 { ok: true, skipped: true }，由隱藏欄位與限速提供基本防護。
 * token 5 分鐘有效且只能驗一次；逾時（5 秒）或 Cloudflare 故障時回傳
 * { ok: false, unavailable: true }，由呼叫端決定要拒絕（註冊、寄信）或放行（登入）。
 */

const integrations = require('./integrations');

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TIMEOUT_MS = 5000;

let lastResult = null;

function getSiteKey() {
  return integrations.get('turnstileSiteKey');
}

function getSecret() {
  return integrations.get('turnstileSecret');
}

function isConfigured() {
  return !!getSiteKey() && !!getSecret();
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
      secret: getSecret(),
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

/** Cloudflare 官方測試金鑰（1x、2x、3x 開頭）：永遠通過／永遠失敗，不能用在正式網站。 */
function usesTestKeys() {
  return /^[123]x0{10,}/.test(getSiteKey()) || /^[123]x0{10,}/.test(getSecret());
}

function getStatus() {
  return {
    configured: isConfigured(),
    siteKeySet: !!getSiteKey(),
    secretSet: !!getSecret(),
    usesTestKeys: usesTestKeys(),
    lastResult
  };
}

/**
 * 確認 secret 有沒有被 Cloudflare 接受。送一個假的回應 token：
 * secret 正確時 Cloudflare 回 invalid-input-response；secret 錯誤時回 invalid-input-secret。
 * 這個檢查不會消耗任何真實的驗證。candidate 有給時檢查這個值（儲存前先驗）。
 */
async function checkSecret(candidate) {
  const secret = candidate === undefined ? getSecret() : String(candidate || '').trim();
  if (!secret) return { state: 'not_set' };
  try {
    const body = new URLSearchParams({ secret, response: 'admin-secret-check' });
    const res = await fetch(SITEVERIFY_URL, { method: 'POST', body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { state: 'unreachable', detail: `http-${res.status}` };
    const data = await res.json();
    const codes = (data && data['error-codes']) || [];
    if (codes.includes('invalid-input-secret')) return { state: 'invalid_secret' };
    if (data && data.success === true) return { state: 'test_secret' };
    return { state: 'valid' };
  } catch (err) {
    return { state: 'unreachable', detail: err && err.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
}

module.exports = { getSiteKey, isConfigured, usesTestKeys, verify, checkSecret, getStatus };
