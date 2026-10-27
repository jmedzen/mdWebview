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

const STATE_TTL_MS = 10 * 60 * 1000;
const STATE_MAX = 5000;
const FETCH_TIMEOUT_MS = 10000;
const STATE_COOKIE = 'mdw_oauth';
const FB_VERSION = 'v21.0';

const pending = new Map(); // state -> { provider, nonce, verifier, mode, userId, createdAt }

const PROVIDERS = {
  google: {
    label: 'Google',
    env: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    issuers: ['https://accounts.google.com', 'accounts.google.com'],
    console: 'https://console.cloud.google.com/apis/credentials'
  },
  facebook: {
    label: 'Facebook',
    env: ['FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET'],
    authorizeUrl: `https://www.facebook.com/${FB_VERSION}/dialog/oauth`,
    tokenUrl: `https://graph.facebook.com/${FB_VERSION}/oauth/access_token`,
    console: 'https://developers.facebook.com/apps/'
  },
  apple: {
    label: 'Apple',
    env: ['APPLE_CLIENT_ID', 'APPLE_TEAM_ID', 'APPLE_KEY_ID', 'APPLE_PRIVATE_KEY_PATH'],
    authorizeUrl: 'https://appleid.apple.com/auth/authorize',
    tokenUrl: 'https://appleid.apple.com/auth/token',
    issuers: ['https://appleid.apple.com'],
    console: 'https://developer.apple.com/account/resources/identifiers/list/serviceId'
  }
};

function env(name) {
  return (process.env[name] || '').trim();
}

function isConfigured(provider) {
  const p = PROVIDERS[provider];
  if (!p) return false;
  return p.env.every(name => !!env(name));
}

function enabledProviders() {
  return Object.keys(PROVIDERS).filter(isConfigured);
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
    params.set('client_id', env('GOOGLE_CLIENT_ID'));
    params.set('redirect_uri', redirectUri);
    params.set('response_type', 'code');
    params.set('scope', 'openid email profile');
    params.set('state', state);
    params.set('nonce', nonce);
    params.set('code_challenge', b64url(crypto.createHash('sha256').update(verifier).digest()));
    params.set('code_challenge_method', 'S256');
    params.set('prompt', 'select_account');
  } else if (provider === 'facebook') {
    params.set('client_id', env('FACEBOOK_APP_ID'));
    params.set('redirect_uri', redirectUri);
    params.set('response_type', 'code');
    params.set('scope', 'email,public_profile');
    params.set('state', state);
  } else if (provider === 'apple') {
    params.set('client_id', env('APPLE_CLIENT_ID'));
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

function appleClientSecret() {
  const keyPem = fs.readFileSync(env('APPLE_PRIVATE_KEY_PATH'), 'utf8');
  const iat = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: env('APPLE_KEY_ID') }));
  const payload = b64url(JSON.stringify({
    iss: env('APPLE_TEAM_ID'), iat, exp: iat + 300, aud: 'https://appleid.apple.com', sub: env('APPLE_CLIENT_ID')
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
  let profile;
  if (provider === 'google') {
    const tokens = await postForm(PROVIDERS.google.tokenUrl, {
      code: params.code,
      client_id: env('GOOGLE_CLIENT_ID'),
      client_secret: env('GOOGLE_CLIENT_SECRET'),
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: entry.verifier
    });
    const claims = decodeJwtPayload(tokens.id_token);
    const problem = checkIdToken(claims, { issuers: PROVIDERS.google.issuers, audience: env('GOOGLE_CLIENT_ID'), nonce: entry.nonce });
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
      client_id: env('FACEBOOK_APP_ID'), client_secret: env('FACEBOOK_APP_SECRET'), redirect_uri: redirectUri, code: params.code
    }).toString();
    const tokRes = await fetch(tokenUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const tokens = await tokRes.json().catch(() => ({}));
    if (!tokRes.ok || !tokens.access_token) throw Object.assign(new Error('token_exchange_failed'), { code: 'token_exchange_failed' });
    const proof = crypto.createHmac('sha256', env('FACEBOOK_APP_SECRET')).update(tokens.access_token).digest('hex');
    const meUrl = new URL(`https://graph.facebook.com/${FB_VERSION}/me`);
    meUrl.search = new URLSearchParams({ fields: 'id,name,email', access_token: tokens.access_token, appsecret_proof: proof }).toString();
    const meRes = await fetch(meUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const me = await meRes.json().catch(() => ({}));
    if (!meRes.ok || !me.id) throw Object.assign(new Error('profile_failed'), { code: 'profile_failed' });
    // Facebook 的 Email 沒有驗證旗標，一律視為未驗證，不拿來自動綁定既有帳號。
    profile = { provider, subject: String(me.id), email: me.email || null, emailVerified: false, name: me.name || null };
  } else if (provider === 'apple') {
    const tokens = await postForm(PROVIDERS.apple.tokenUrl, {
      client_id: env('APPLE_CLIENT_ID'),
      client_secret: appleClientSecret(),
      code: params.code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri
    });
    const claims = decodeJwtPayload(tokens.id_token);
    const problem = checkIdToken(claims, { issuers: PROVIDERS.apple.issuers, audience: env('APPLE_CLIENT_ID'), nonce: entry.nonce });
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

function getStatus(baseUrl) {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    label: p.label,
    configured: isConfigured(id),
    envVars: p.env.map(name => ({ name, set: !!env(name) })),
    callbackUrl: baseUrl ? callbackUrl(baseUrl, id) : null,
    console: p.console,
    privateKeyReadable: id === 'apple' && env('APPLE_PRIVATE_KEY_PATH')
      ? (() => { try { fs.accessSync(env('APPLE_PRIVATE_KEY_PATH'), fs.constants.R_OK); return true; } catch (_) { return false; } })()
      : undefined
  }));
}

module.exports = {
  PROVIDERS,
  isConfigured,
  enabledProviders,
  callbackUrl,
  begin,
  complete,
  takeState,
  decodeJwtPayload,
  checkIdToken,
  getStatus,
  _pending: pending
};
