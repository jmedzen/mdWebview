/**
 * @file lib/oauth.js — Google、Facebook、Apple 登入（授權碼流程）
 *
 * 三家都由伺服器端以 fetch 換取身分，前端不經手 token。
 * - GET /api/auth/<provider>：產生 state、nonce 與 PKCE code_verifier（Google），
 *   state 放進 10 分鐘的 HttpOnly cookie，其餘存在記憶體，再 302 導向授權頁。
 * - 回調：比對 cookie 與 state，換 token，取回 { subject, email, emailVerified, name }。
 * - 身分鍵：Google、Apple 為 ID token 的 sub，Facebook 為 app-scoped id。
 * - ID token 經 TLS 直接從 token 端點取得，不另驗簽章；檢查 iss、aud、exp、nonce。
 * - Apple 的回調是跨站 POST（form_post），state cookie 必須是 SameSite=None; Secure。
 * - Apple 的 client secret 每次即時以 .p8 私鑰（ES256）簽發 5 分鐘的 JWT，不會過期。
 */

const crypto = require('crypto');
const fs = require('fs');
const { serializeCookie, appendSetCookie, parseCookies, isSecureRequest } = require('./session');
const integrations = require('./integrations');

const STATE_TTL_MS = 10 * 60 * 1000;
const STATE_MAX = 5000;
const FETCH_TIMEOUT_MS = 10000;
const STATE_COOKIE = 'mdw_oauth';
const FB_VERSION = 'v21.0';

const pending = new Map(); // state -> { provider, nonce, verifier, mode, userId, createdAt }

// fields：每個欄位對應 lib/integrations.js 的一個設定項（環境變數優先，其次是後台網頁填寫）。
const PROVIDERS = {
  google: {
    label: 'Google',
    fields: [
      { key: 'clientId', field: 'googleClientId', label: 'Client ID', placeholder: '123456789-xxxx.apps.googleusercontent.com' },
      { key: 'clientSecret', field: 'googleClientSecret', label: 'Client secret', secret: true, placeholder: 'GOCSPX- 開頭' }
    ],
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    issuers: ['https://accounts.google.com', 'accounts.google.com'],
    console: 'https://console.cloud.google.com/apis/credentials'
  },
  facebook: {
    label: 'Facebook',
    fields: [
      { key: 'appId', field: 'facebookAppId', label: 'App ID', placeholder: '純數字' },
      { key: 'appSecret', field: 'facebookAppSecret', label: 'App secret', secret: true, placeholder: '32 個英數字' }
    ],
    authorizeUrl: `https://www.facebook.com/${FB_VERSION}/dialog/oauth`,
    tokenUrl: `https://graph.facebook.com/${FB_VERSION}/oauth/access_token`,
    console: 'https://developers.facebook.com/apps/'
  },
  apple: {
    label: 'Apple',
    fields: [
      { key: 'clientId', field: 'appleClientId', label: 'Services ID', placeholder: '例如 co.example.web' },
      { key: 'teamId', field: 'appleTeamId', label: 'Team ID', placeholder: '10 個英數字' },
      { key: 'keyId', field: 'appleKeyId', label: 'Key ID', placeholder: '10 個英數字' },
      { key: 'privateKey', field: 'applePrivateKey', label: '私鑰（.p8 檔案內容）', secret: true, multiline: true, placeholder: '-----BEGIN PRIVATE KEY-----' }
    ],
    authorizeUrl: 'https://appleid.apple.com/auth/authorize',
    tokenUrl: 'https://appleid.apple.com/auth/token',
    issuers: ['https://appleid.apple.com'],
    console: 'https://developer.apple.com/account/resources/identifiers/list/serviceId'
  }
};

/** 目前生效的欄位值（環境變數優先、其次網頁設定）；overrides 是還沒儲存的候選值，儲存前驗證用。 */
function values(provider, overrides = {}) {
  const out = {};
  for (const f of PROVIDERS[provider].fields) {
    out[f.key] = overrides[f.key] !== undefined ? String(overrides[f.key]).trim() : integrations.get(f.field);
  }
  return out;
}

/** 讀 APPLE_PRIVATE_KEY_PATH 指向的 .p8 檔（舊的部署方式）；讀不到回傳 ''。 */
function readApplePrivateKeyFile() {
  const file = (process.env.APPLE_PRIVATE_KEY_PATH || '').trim();
  if (!file) return '';
  try { return fs.readFileSync(file, 'utf8'); } catch (_) { return ''; }
}

function normalizePem(text) {
  return String(text || '').trim().replace(/\\n/g, '\n');
}

function applePrivateKey(vals) {
  return normalizePem(vals.privateKey) || normalizePem(readApplePrivateKeyFile());
}

function isConfigured(provider, overrides = {}) {
  const p = PROVIDERS[provider];
  if (!p) return false;
  const vals = values(provider, overrides);
  if (provider === 'apple') return !!(vals.clientId && vals.teamId && vals.keyId && applePrivateKey(vals));
  return p.fields.every(f => !!vals[f.key]);
}

/** 金鑰齊全，而且管理員沒有把開關關掉。 */
function isEnabled(provider) {
  return isConfigured(provider) && integrations.isProviderEnabled(provider);
}

function enabledProviders() {
  return Object.keys(PROVIDERS).filter(isEnabled);
}

function callbackUrl(baseUrl, provider) {
  return `${baseUrl}/api/auth/${provider}/callback`;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function pruneState() {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [k, v] of pending) {
    if (v.createdAt < cutoff) pending.delete(k);
  }
  while (pending.size > STATE_MAX) pending.delete(pending.keys().next().value);
}

/**
 * 產生授權網址並設 state cookie。
 * @param {'login'|'link'|'reauth'} mode
 */
function begin(req, res, provider, { baseUrl, mode = 'login', userId = null }) {
  pruneState();
  const p = PROVIDERS[provider];
  const state = b64url(crypto.randomBytes(24));
  const nonce = b64url(crypto.randomBytes(16));
  const verifier = b64url(crypto.randomBytes(32));
  pending.set(state, { provider, nonce, verifier, mode, userId, createdAt: Date.now() });

  const secure = isSecureRequest(req);
  // Apple 的回調是跨站 POST，只有 SameSite=None（必須搭配 Secure）的 cookie 會被帶上。
  const sameSite = provider === 'apple' && secure ? 'None' : 'Lax';
  appendSetCookie(res, serializeCookie(STATE_COOKIE, state, {
    maxAgeSec: STATE_TTL_MS / 1000, secure, sameSite, path: `/api/auth/${provider}`
  }));

  const params = new URLSearchParams();
  const redirectUri = callbackUrl(baseUrl, provider);
  if (provider === 'google') {
    params.set('client_id', values('google').clientId);
    params.set('redirect_uri', redirectUri);
    params.set('response_type', 'code');
    params.set('scope', 'openid email profile');
    params.set('state', state);
    params.set('nonce', nonce);
    params.set('code_challenge', b64url(crypto.createHash('sha256').update(verifier).digest()));
    params.set('code_challenge_method', 'S256');
    params.set('prompt', 'select_account');
  } else if (provider === 'facebook') {
    params.set('client_id', values('facebook').appId);
    params.set('redirect_uri', redirectUri);
    params.set('response_type', 'code');
    params.set('scope', 'email,public_profile');
    params.set('state', state);
  } else if (provider === 'apple') {
    params.set('client_id', values('apple').clientId);
    params.set('redirect_uri', redirectUri);
    params.set('response_type', 'code');
    params.set('response_mode', 'form_post');
    params.set('scope', 'name email');
    params.set('state', state);
    params.set('nonce', nonce);
  }
  return `${p.authorizeUrl}?${params.toString()}`;
}

/** 取出並作廢 state；cookie 與參數不符時回傳 null。 */
function takeState(req, res, provider, stateParam) {
  const cookies = parseCookies(req);
  const cookieState = cookies[STATE_COOKIE];
  appendSetCookie(res, serializeCookie(STATE_COOKIE, '', {
    maxAgeSec: 0, secure: isSecureRequest(req), sameSite: 'Lax', path: `/api/auth/${provider}`
  }));
  if (typeof stateParam !== 'string' || !stateParam || !cookieState) return null;
  const a = Buffer.from(stateParam);
  const b = Buffer.from(cookieState);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const entry = pending.get(stateParam);
  pending.delete(stateParam);
  if (!entry || entry.provider !== provider || Date.now() - entry.createdAt > STATE_TTL_MS) return null;
  return entry;
}

function decodeJwtPayload(jwt) {
  if (typeof jwt !== 'string') return null;
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
}

function checkIdToken(claims, { issuers, audience, nonce }) {
  if (!claims) return 'invalid_id_token';
  if (!issuers.includes(claims.iss)) return 'bad_issuer';
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(audience)) return 'bad_audience';
  if (!claims.exp || claims.exp * 1000 < Date.now() - 60 * 1000) return 'expired';
  if (nonce && claims.nonce !== nonce) return 'bad_nonce';
  if (!claims.sub) return 'no_subject';
  return null;
}

async function postForm(url, fields) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`token_endpoint_${res.status}`);
    err.detail = data && (data.error_description || data.error || (data.error && data.error.message));
    throw err;
  }
  return data;
}

function appleClientSecret(vals = values('apple')) {
  const keyPem = applePrivateKey(vals);
  const iat = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: vals.keyId }));
  const payload = b64url(JSON.stringify({
    iss: vals.teamId, iat, exp: iat + 300, aud: 'https://appleid.apple.com', sub: vals.clientId
  }));
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), { key: keyPem, dsaEncoding: 'ieee-p1363' });
  return `${header}.${payload}.${b64url(signature)}`;
}

/**
 * 完成回調，回傳 { profile, entry }。
 * profile: { provider, subject, email, emailVerified, name }
 * @param {object} params 回調參數（GET query 或 Apple 的 POST 表單）
 */
async function complete(req, res, provider, params, { baseUrl }) {
  const entry = takeState(req, res, provider, params.state);
  if (!entry) {
    const err = new Error('invalid_state');
    err.code = 'invalid_state';
    throw err;
  }
  if (params.error) {
    const err = new Error(String(params.error).slice(0, 60));
    err.code = 'denied';
    throw err;
  }
  if (typeof params.code !== 'string' || !params.code) {
    const err = new Error('missing_code');
    err.code = 'missing_code';
    throw err;
  }
  const redirectUri = callbackUrl(baseUrl, provider);
  const vals = values(provider);
  let profile;
  if (provider === 'google') {
    const tokens = await postForm(PROVIDERS.google.tokenUrl, {
      code: params.code,
      client_id: vals.clientId,
      client_secret: vals.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: entry.verifier
    });
    const claims = decodeJwtPayload(tokens.id_token);
    const problem = checkIdToken(claims, { issuers: PROVIDERS.google.issuers, audience: vals.clientId, nonce: entry.nonce });
    if (problem) throw Object.assign(new Error(problem), { code: problem });
    profile = {
      provider, subject: String(claims.sub),
      email: claims.email || null,
      emailVerified: claims.email_verified === true || claims.email_verified === 'true',
      name: claims.name || null
    };
  } else if (provider === 'facebook') {
    const tokenUrl = new URL(PROVIDERS.facebook.tokenUrl);
    tokenUrl.search = new URLSearchParams({
      client_id: vals.appId, client_secret: vals.appSecret, redirect_uri: redirectUri, code: params.code
    }).toString();
    const tokRes = await fetch(tokenUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const tokens = await tokRes.json().catch(() => ({}));
    if (!tokRes.ok || !tokens.access_token) throw Object.assign(new Error('token_exchange_failed'), { code: 'token_exchange_failed' });
    const proof = crypto.createHmac('sha256', vals.appSecret).update(tokens.access_token).digest('hex');
    const meUrl = new URL(`https://graph.facebook.com/${FB_VERSION}/me`);
    meUrl.search = new URLSearchParams({ fields: 'id,name,email', access_token: tokens.access_token, appsecret_proof: proof }).toString();
    const meRes = await fetch(meUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const me = await meRes.json().catch(() => ({}));
    if (!meRes.ok || !me.id) throw Object.assign(new Error('profile_failed'), { code: 'profile_failed' });
    // Facebook 的 Email 沒有驗證旗標，一律視為未驗證，不拿來自動綁定既有帳號。
    profile = { provider, subject: String(me.id), email: me.email || null, emailVerified: false, name: me.name || null };
  } else if (provider === 'apple') {
    const tokens = await postForm(PROVIDERS.apple.tokenUrl, {
      client_id: vals.clientId,
      client_secret: appleClientSecret(vals),
      code: params.code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri
    });
    const claims = decodeJwtPayload(tokens.id_token);
    const problem = checkIdToken(claims, { issuers: PROVIDERS.apple.issuers, audience: vals.clientId, nonce: entry.nonce });
    if (problem) throw Object.assign(new Error(problem), { code: problem });
    // 名字只在第一次授權時由表單的 user 欄位送來。
    let name = null;
    try {
      const u = typeof params.user === 'string' ? JSON.parse(params.user) : null;
      if (u && u.name) name = [u.name.lastName, u.name.firstName].filter(Boolean).join('') || null;
    } catch (_) {}
    profile = {
      provider, subject: String(claims.sub),
      email: claims.email || null,
      emailVerified: !!claims.email && (claims.email_verified === true || claims.email_verified === 'true'),
      name
    };
  } else {
    throw Object.assign(new Error('unknown_provider'), { code: 'unknown_provider' });
  }
  return { profile, entry };
}

/** 後台顯示用：欄位只回報有沒有設定（非金鑰類才回傳值，金鑰類只回末四碼）。 */
function getStatus(baseUrl) {
  return Object.entries(PROVIDERS).map(([id, p]) => {
    const fields = p.fields.map(f => {
      const info = integrations.describe(f.field);
      return Object.assign({ key: f.key, label: f.label, placeholder: f.placeholder || '', secret: !!f.secret, multiline: !!f.multiline }, info);
    });
    let keyFile = null;
    if (id === 'apple') {
      const path = (process.env.APPLE_PRIVATE_KEY_PATH || '').trim();
      if (path) {
        keyFile = { env: 'APPLE_PRIVATE_KEY_PATH', readable: !!readApplePrivateKeyFile() };
        const pk = fields.find(f => f.key === 'privateKey');
        // 舊的部署方式：私鑰放在檔案裡，由環境變數指到路徑。視為已設定、不能在網頁上改。
        if (pk && !pk.set && keyFile.readable) Object.assign(pk, { set: true, source: 'file', locked: true, masked: '••••' });
      }
    }
    const configured = isConfigured(id);
    return {
      id,
      label: p.label,
      configured,
      enabled: integrations.isProviderEnabled(id),
      active: configured && integrations.isProviderEnabled(id),
      fields,
      keyFile,
      callbackUrl: baseUrl ? callbackUrl(baseUrl, id) : null,
      console: p.console
    };
  });
}

// ── 儲存前檢查金鑰 ─────────────────────────────────────────
// 每家都有「用假的授權碼換 token」這招：金鑰正確時回 invalid_grant，金鑰錯誤時回 invalid_client。
// 不會消耗任何真實的登入，也不需要使用者操作。
async function rawFetch(url, options) {
  const res = await fetch(url, Object.assign({ signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }, options));
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

/** 驗證 PEM 私鑰格式：必須是 Apple 用的 EC（P-256）私鑰。回傳錯誤訊息或 ''。 */
function validateApplePrivateKey(pem) {
  try {
    const key = crypto.createPrivateKey(normalizePem(pem));
    if (key.asymmetricKeyType !== 'ec') return '這不是 Apple 的 .p8 私鑰（應為 EC 私鑰）';
    return '';
  } catch (_) {
    return '私鑰格式不對，請貼上 .p8 檔案的完整內容（含 BEGIN PRIVATE KEY 與 END PRIVATE KEY 那兩行）';
  }
}

/**
 * @param {string} provider
 * @param {object} [overrides] 還沒儲存的候選值（欄位 key → 值）
 * @returns {Promise<{state:'incomplete'|'valid'|'invalid'|'unreachable'|'uncertain'|'redirect_mismatch', detail?:string}>}
 */
async function checkCredentials(provider, overrides = {}, baseUrl = '') {
  const p = PROVIDERS[provider];
  if (!p) return { state: 'incomplete' };
  const vals = values(provider, overrides);
  const redirectUri = callbackUrl(baseUrl || 'https://example.invalid', provider);
  try {
    if (provider === 'google') {
      if (!vals.clientId || !vals.clientSecret) return { state: 'incomplete' };
      const r = await rawFetch(p.tokenUrl, {
        method: 'POST',
        body: new URLSearchParams({ code: 'admin-credential-check', client_id: vals.clientId, client_secret: vals.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' })
      });
      return interpretTokenError(r);
    }
    if (provider === 'facebook') {
      if (!vals.appId || !vals.appSecret) return { state: 'incomplete' };
      const url = new URL(`https://graph.facebook.com/oauth/access_token`);
      url.search = new URLSearchParams({ client_id: vals.appId, client_secret: vals.appSecret, grant_type: 'client_credentials' }).toString();
      const r = await rawFetch(url);
      if (r.ok && r.data && r.data.access_token) return { state: 'valid' };
      if (r.status === 400 || r.status === 401 || r.status === 403) return { state: 'invalid', detail: String(r.data && r.data.error && r.data.error.message || '').slice(0, 200) };
      return { state: 'unreachable', detail: `http-${r.status}` };
    }
    if (provider === 'apple') {
      if (!vals.clientId || !vals.teamId || !vals.keyId || !applePrivateKey(vals)) return { state: 'incomplete' };
      let secret;
      try { secret = appleClientSecret(vals); } catch (_) { return { state: 'invalid', detail: 'private_key' }; }
      const r = await rawFetch(p.tokenUrl, {
        method: 'POST',
        body: new URLSearchParams({ client_id: vals.clientId, client_secret: secret, code: 'admin-credential-check', grant_type: 'authorization_code', redirect_uri: redirectUri })
      });
      return interpretTokenError(r);
    }
  } catch (err) {
    return { state: 'unreachable', detail: err && err.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
  return { state: 'incomplete' };
}

function interpretTokenError(r) {
  const code = r.data && r.data.error;
  if (code === 'invalid_client' || code === 'unauthorized_client') return { state: 'invalid', detail: String(r.data.error_description || code).slice(0, 200) };
  if (code === 'invalid_grant') return { state: 'valid' };
  // 金鑰通過了，但這個回調網址沒有登記在服務商後台：登入時一定會失敗，要提醒。
  if (code === 'redirect_uri_mismatch') return { state: 'redirect_mismatch' };
  if (r.status >= 500) return { state: 'unreachable', detail: `http-${r.status}` };
  // 回了別的錯誤（例如 invalid_request）：金鑰本身沒被拒絕，但也無法確認。
  return { state: 'uncertain', detail: String(code || `http-${r.status}`).slice(0, 80) };
}

module.exports = {
  PROVIDERS,
  values,
  isConfigured,
  isEnabled,
  enabledProviders,
  checkCredentials,
  validateApplePrivateKey,
  normalizePem,
  callbackUrl,
  begin,
  complete,
  takeState,
  decodeJwtPayload,
  checkIdToken,
  getStatus,
  _pending: pending
};
