/**
 * @file lib/accounts.js — 使用者帳號 API 與頁面
 *
 * 路由（只在 web 模式、帳號資料庫可用時啟用）：
 *   公開：/api/health、/api/auth/*、/api/legal、/privacy、/terms
 *   登入者：/api/me、/api/me/*
 *   管理員：/api/admin/users…、registration、invites、bot-stats、auth-providers、
 *          mail、auth-events、lockouts、db-backups、legal、accounts-overview
 *
 * 防護重點：
 * - 會改資料的請求一律檢查同源（缺 Origin 與 Referer 時看 Sec-Fetch-Site，都沒有就拒絕）
 *   並只接受 application/json；Apple 的 form_post 回調例外，改以 state 比對防偽造。
 * - 註冊、忘記密碼、重寄驗證信不論信箱是否存在都回同一句話，不洩漏誰註冊過。
 * - 每 IP（15 分鐘 20 次失敗）與每帳號（連續 5 次失敗後指數延遲，最多 15 分鐘）限速，
 *   在算雜湊前就先記一次。
 * - 防機器人：Turnstile、隱藏欄位與填表時間、每 IP 每小時 3 次註冊、全站每小時上限、
 *   拋棄式信箱網域清單。
 */

const db = require('./db');
const passwords = require('./password');
const session = require('./session');
const mailer = require('./mailer');
const turnstile = require('./turnstile');
const integrations = require('./integrations');
const oauth = require('./oauth');
const { config } = require('./config');
const { Logger } = require('./logger');
const { getClientIP } = require('./utils');
const { SECURITY_HEADERS, IS_SINGLE_USER } = require('./constants');

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const VERIFY_TTL_MS = 24 * HOUR_MS;
const RESET_TTL_MS = HOUR_MS;
const CHANGE_EMAIL_TTL_MS = 24 * HOUR_MS;

// 每帳號：連續 MAX_ATTEMPTS 次失敗後開始延遲（1、2、4…分鐘，最多 15 分鐘）。
const MAX_ATTEMPTS = 5;
const ACCOUNT_MAX_DELAY_MS = 15 * MINUTE_MS;
// 每 IP：15 分鐘內 20 次失敗。共用網路（寺院、學校）背後可能有很多人。
const IP_FAIL_LIMIT = 20;
const IP_FAIL_WINDOW_MS = 15 * MINUTE_MS;
// 失敗 3 次後，登入改為要求 Turnstile（若已設定）。
const TURNSTILE_AFTER_FAILS = 3;
const REGISTER_PER_IP_PER_HOUR = 3;
const DEFAULT_HOURLY_SIGNUP_CAP = 30;
const MAIL_PER_ADDRESS_PER_HOUR = 3;
const MAIL_PER_IP_PER_HOUR = 10;
const MIN_FORM_FILL_MS = 2000;
const MAX_TRACKED_KEYS = 10000;

// ── 記憶體計數器（單一程序；重啟歸零可接受，成敗另寫入 auth_events） ──────
class SlidingCounter {
  constructor(windowMs) {
    this.windowMs = windowMs;
    this.map = new Map();
  }
  prune(key, t = Date.now()) {
    const list = this.map.get(key);
    if (!list) return [];
    const cutoff = t - this.windowMs;
    while (list.length && list[0] < cutoff) list.shift();
    if (!list.length) this.map.delete(key);
    return list;
  }
  count(key) {
    return this.prune(key).length;
  }
  hit(key) {
    const t = Date.now();
    const list = this.prune(key, t);
    list.push(t);
    this.map.set(key, list);
    if (this.map.size > MAX_TRACKED_KEYS) this.map.delete(this.map.keys().next().value);
    return list.length;
  }
  undo(key) {
    const list = this.map.get(key);
    if (list && list.length) list.pop();
  }
  reset(key) {
    this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
  entries() {
    const out = [];
    for (const key of [...this.map.keys()]) {
      const n = this.count(key);
      if (n) out.push([key, n]);
    }
    return out;
  }
}

const ipFailures = new SlidingCounter(IP_FAIL_WINDOW_MS);
const registerByIp = new SlidingCounter(HOUR_MS);
const signupsGlobal = new SlidingCounter(HOUR_MS);
const mailByAddress = new SlidingCounter(HOUR_MS);
const mailByIp = new SlidingCounter(HOUR_MS);

// 每帳號連續失敗：key -> { fails, lockUntil }
class AccountAttempts extends Map {
  clear() {
    super.clear();
    ipFailures.clear();
  }
}
const accountAttempts = new AccountAttempts();

function accountKey(identifier) {
  return String(identifier || '').trim().toLowerCase().slice(0, 254);
}

function accountLockRemaining(key) {
  const a = accountAttempts.get(key);
  if (!a || !a.lockUntil) return 0;
  return Math.max(0, a.lockUntil - Date.now());
}

function chargeAccount(key) {
  const a = accountAttempts.get(key) || { fails: 0, lockUntil: 0 };
  a.fails += 1;
  if (a.fails >= MAX_ATTEMPTS) {
    const delay = Math.min(ACCOUNT_MAX_DELAY_MS, MINUTE_MS * 2 ** (a.fails - MAX_ATTEMPTS));
    a.lockUntil = Date.now() + delay;
  }
  accountAttempts.set(key, a);
  if (accountAttempts.size > MAX_TRACKED_KEYS) accountAttempts.delete(accountAttempts.keys().next().value);
  return a;
}

// ── 小工具 ───────────────────────────────────────────────────
function json(res, status, body, extraHeaders = {}) {
  const payload = Buffer.from(JSON.stringify(body), 'utf-8');
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': payload.length
  }, SECURITY_HEADERS, extraHeaders));
  res.end(payload);
}

function redirect(res, location) {
  res.writeHead(302, Object.assign({ Location: location, 'Cache-Control': 'no-store' }, SECURITY_HEADERS));
  res.end();
}

function readBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', chunk => {
      if (done) return;
      size += chunk.length;
      if (size > maxBytes) {
        done = true;
        req.destroy();
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    req.on('error', err => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

async function readForm(req) {
  const raw = await readBody(req);
  return Object.fromEntries(new URLSearchParams(raw));
}

function lenientSameOrigin(req) {
  const host = req.headers.host;
  if (!host) return true;
  try {
    if (req.headers.origin) return new URL(req.headers.origin).host === host;
    if (req.headers.referer) return new URL(req.headers.referer).host === host;
  } catch (_) {
    return false;
  }
  return true;
}

/**
 * 同源檢查（收緊版）：Origin 或 Referer 必須與 Host 相同；兩者都沒有時看
 * Sec-Fetch-Site，仍沒有就拒絕。
 */
function isSameOriginStrict(req) {
  const host = req.headers.host;
  // 以 X-Admin-Token 標頭帶 session 的請求（命令列工具、舊版管理介面）不會被跨站偽造，
  // 沿用舊的寬鬆規則：有 Origin/Referer 就要相符，都沒有則放行。
  if (session.usesHeaderToken(req)) return lenientSameOrigin(req);
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  try {
    if (origin && origin !== 'null') return new URL(origin).host === host;
    if (referer) return new URL(referer).host === host;
  } catch (_) {
    return false;
  }
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  return site === 'same-origin' || site === 'none';
}

function isJsonRequest(req) {
  const type = String(req.headers['content-type'] || '').toLowerCase();
  return type.startsWith('application/json');
}

/** 會改資料的請求：同源 + JSON。不合格時已回應，回傳 false。 */
function guardMutation(req, res, { requireJson = true } = {}) {
  if (!isSameOriginStrict(req)) {
    json(res, 403, { error: '請求來源不符', code: 'BAD_ORIGIN' });
    return false;
  }
  if (requireJson && !isJsonRequest(req)) {
    json(res, 415, { error: '只接受 JSON 請求', code: 'JSON_REQUIRED' });
    return false;
  }
  return true;
}

function str(v, max = 1000) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function siteName() {
  return (config.settings && config.settings.siteName) || 'mdWebview';
}

/**
 * 組信件連結與 OAuth 回調用的對外網址。只用 PUBLIC_BASE_URL 或後台設定的首頁權威 URL，
 * 絕不使用請求的 Host 標頭，否則攻擊者能讓重設信指向自己的網站。
 */
function publicBaseUrl() {
  const raw = (process.env.PUBLIC_BASE_URL || '').trim() || ((config.settings && config.settings.siteUrl) || '').trim();
  if (!/^https?:\/\//i.test(raw)) return '';
  return raw.replace(/\/+$/, '');
}

function baseHostname() {
  try { return new URL(publicBaseUrl()).hostname; } catch (_) { return ''; }
}

function audit(req, event, { userId = null, actorId = null, detail = null } = {}) {
  db.logEvent(event, { userId, actorId, detail, ip: req ? getClientIP(req) : null });
}

// ── 設定 ─────────────────────────────────────────────────────
function getRegistrationSettings() {
  const mode = db.getSetting('registration.mode', 'open');
  return {
    mode: ['open', 'invite', 'closed'].includes(mode) ? mode : 'open',
    hourlyCap: Math.max(1, parseInt(db.getSetting('registration.hourlyCap', String(DEFAULT_HOURLY_SIGNUP_CAP)), 10) || DEFAULT_HOURLY_SIGNUP_CAP),
    disposableDomains: db.getJsonSetting('registration.disposableDomains', [])
  };
}

function getLegal() {
  return {
    privacy: db.getSetting('legal.privacy', ''),
    terms: db.getSetting('legal.terms', ''),
    version: parseInt(db.getSetting('legal.version', '0'), 10) || 0,
    majorVersion: parseInt(db.getSetting('legal.majorVersion', '0'), 10) || 0,
    updatedAt: parseInt(db.getSetting('legal.updatedAt', '0'), 10) || 0
  };
}

function legalExists(legal = getLegal()) {
  return !!(legal.privacy.trim() || legal.terms.trim());
}

/** 註冊或第三方登入暫停的原因；空陣列代表可以註冊。 */
function registrationBlockers() {
  const blockers = [];
  if (!publicBaseUrl()) blockers.push('PUBLIC_BASE_URL');
  if (!mailer.isConfigured()) blockers.push('MAIL');
  return blockers;
}

function needsConsent(user, legal = getLegal()) {
  if (!user || !legalExists(legal) || !legal.majorVersion) return false;
  return (parseInt(user.terms_version || '0', 10) || 0) < legal.majorVersion;
}

function publicUser(user) {
  if (!user) return null;
  const identities = db.listIdentities(user.id);
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    displayName: user.display_name || '',
    role: user.role,
    emailVerified: !!user.email_verified_at,
    hasPassword: !!user.password_hash,
    providers: identities.map(i => i.provider),
    identities: identities.map(i => ({ provider: i.provider, email: i.email, createdAt: i.created_at })),
    createdAt: user.created_at,
    needsConsent: needsConsent(user)
  };
}

// ── 舊管理員搬遷 ─────────────────────────────────────────────
/**
 * config.json 的管理員搬進 users 表（role=admin）。Email 取自 ADMIN_EMAIL；
 * 沒設定時先以原帳號名稱搬入，登入後在後台提示補上 Email。
 * 密碼存成 PBKDF2 舊格式，下次登入成功時自動改存 scrypt。
 * config.admin 保留一個版本，以便退回舊映像。
 */
function migrateLegacyAdmin() {
  if (!db.isAvailable() || !config.admin || !config.admin.username) return null;
  const username = String(config.admin.username).trim();
  if (db.getUserByUsername(username)) return null;
  const email = db.normalizeEmail(process.env.ADMIN_EMAIL || '');
  const hash = passwords.legacyPbkdf2Hash(config.admin, 100000);
  if (!hash) return null;
  if (email && db.getUserByEmail(email)) {
    // 該 Email 已有帳號：只補上 username 與管理員角色，不覆寫既有密碼。
    const existing = db.getUserByEmail(email);
    if (!existing.username) db.updateUser(existing.id, { username, role: 'admin' });
    return existing;
  }
  const user = db.createUser({
    email: isValidEmail(email) ? email : null,
    username,
    emailVerifiedAt: isValidEmail(email) ? Date.now() : null,
    displayName: username,
    passwordHash: hash,
    role: 'admin'
  });
  db.logEvent('admin_migrated', { userId: user.id, detail: 'config.json admin moved into users.db' });
  return user;
}

function hasAdmin() {
  if (!db.isAvailable()) return false;
  try { return db.countActiveAdmins() > 0; } catch (_) { return false; }
}

// ── 信件 ─────────────────────────────────────────────────────
function canSendMail(req, to) {
  const ip = getClientIP(req);
  if (mailByAddress.count(to) >= MAIL_PER_ADDRESS_PER_HOUR) return false;
  if (req && mailByIp.count(ip) >= MAIL_PER_IP_PER_HOUR) return false;
  return true;
}

async function sendAccountMail(req, to, kind, { token = '', extra = {} } = {}) {
  if (!to) return { ok: false, error: 'no_address' };
  if (!canSendMail(req, to)) {
    audit(req, 'mail_rate_limited', { detail: kind });
    return { ok: false, error: 'rate_limited' };
  }
  mailByAddress.hit(to);
  if (req) mailByIp.hit(getClientIP(req));
  const base = publicBaseUrl();
  const name = siteName();
  let mail;
  if (kind === 'verify') {
    mail = mailer.renderMail({
      siteName: name, heading: `請確認你的 Email`,
      paragraphs: [`感謝你註冊 ${name}。請按下面的按鈕確認這是你的信箱，連結 24 小時內有效。`],
      actionLabel: '確認 Email', actionUrl: `${base}/?auth=verify&token=${encodeURIComponent(token)}`,
      footer: '如果你沒有註冊，請忽略這封信，帳號會在 7 天後自動刪除。'
    });
    mail.subject = `${name}：請確認你的 Email`;
  } else if (kind === 'exists') {
    mail = mailer.renderMail({
      siteName: name, heading: '你已經有帳號了',
      paragraphs: [`有人（可能是你）用這個信箱在 ${name} 註冊。這個信箱已經有帳號，直接登入即可；忘記密碼的話可以重設。`],
      actionLabel: '前往登入', actionUrl: `${base}/?auth=login`,
      footer: '如果不是你，請忽略這封信，你的帳號不受影響。'
    });
    mail.subject = `${name}：你已經有帳號了`;
  } else if (kind === 'reset') {
    mail = mailer.renderMail({
      siteName: name, heading: '重設密碼',
      paragraphs: ['我們收到重設密碼的要求。請按下面的按鈕設定新密碼，連結 1 小時內有效、只能使用一次。'],
      actionLabel: '設定新密碼', actionUrl: `${base}/?auth=reset&token=${encodeURIComponent(token)}`,
      footer: '如果你沒有要求重設，請忽略這封信，密碼不會改變。'
    });
    mail.subject = `${name}：重設密碼`;
  } else if (kind === 'change_email') {
    mail = mailer.renderMail({
      siteName: name, heading: '確認新的 Email',
      paragraphs: [`請按下面的按鈕，把你在 ${name} 的登入信箱改成這個地址。連結 24 小時內有效。`],
      actionLabel: '確認變更', actionUrl: `${base}/?auth=email&token=${encodeURIComponent(token)}`,
      footer: '如果你沒有要求變更，請忽略這封信。'
    });
    mail.subject = `${name}：確認新的 Email`;
  } else if (kind === 'email_change_notice') {
    mail = mailer.renderMail({
      siteName: name, heading: '有人要求變更你的登入信箱',
      paragraphs: [`你的 ${name} 帳號申請把登入信箱改成 ${extra.newEmail || '另一個地址'}。新信箱確認後才會生效。`],
      footer: '如果不是你，請立即登入並修改密碼，或回覆網站管理員。'
    });
    mail.subject = `${name}：登入信箱變更通知`;
  } else if (kind === 'linked') {
    mail = mailer.renderMail({
      siteName: name, heading: '已綁定新的登入方式',
      paragraphs: [`你的 ${name} 帳號剛綁定了 ${extra.provider || '第三方'} 登入。`],
      footer: '如果不是你，請登入後到「帳號設定」解除綁定並修改密碼。'
    });
    mail.subject = `${name}：已綁定新的登入方式`;
  } else if (kind === 'test') {
    mail = mailer.renderMail({
      siteName: name, heading: '測試信',
      paragraphs: [`這是 ${name} 管理後台寄出的測試信。收到這封信表示寄信設定正確。`]
    });
    mail.subject = `${name}：測試信`;
  } else {
    return { ok: false, error: 'unknown_kind' };
  }
  const result = await mailer.send({ to, subject: mail.subject, text: mail.text, html: mail.html, tag: kind });
  if (!result.ok) audit(req, 'mail_failed', { detail: `${kind}:${result.error}` });
  return result;
}

// ── 防機器人 ─────────────────────────────────────────────────
/** 隱藏欄位有值、或填表少於 2 秒：當作機器人。 */
function looksLikeBot(body) {
  if (str(body.website, 200).trim()) return 'honeypot';
  const elapsed = Number(body.elapsedMs);
  if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < MIN_FORM_FILL_MS) return 'too_fast';
  return null;
}

function isDisposable(email) {
  const domain = String(email).split('@')[1] || '';
  const list = getRegistrationSettings().disposableDomains || [];
  return list.some(d => domain === d || domain.endsWith(`.${d}`));
}

/**
 * 註冊與寄信類表單：Turnstile 必須通過；Cloudflare 故障時拒絕並請使用者稍後再試。
 * 不合格時已回應，回傳 false。
 */
async function requireTurnstile(req, res, body, action) {
  const result = await turnstile.verify(str(body.turnstileToken, 2048), { ip: getClientIP(req), action, hostname: baseHostname() });
  if (result.ok) return true;
  if (result.unavailable) {
    audit(req, 'bot_turnstile_unavailable', { detail: `${action}:${result.reason}` });
    json(res, 503, { error: '人機驗證暫時無法使用，請稍後再試', code: 'TURNSTILE_UNAVAILABLE' });
    return false;
  }
  audit(req, 'bot_turnstile', { detail: `${action}:${result.reason}` });
  json(res, 403, { error: '人機驗證未通過，請再試一次', code: 'TURNSTILE_FAILED' });
  return false;
}

const GENERIC_MAIL_REPLY = { ok: true, message: '如果這個信箱可以使用，我們已寄出信件，請查收（也請看看垃圾郵件匣）。' };

// ── /api/auth ────────────────────────────────────────────────
function authConfig() {
  const enabled = db.isAvailable();
  const reg = enabled ? getRegistrationSettings() : null;
  const legal = enabled ? getLegal() : null;
  return {
    accountsEnabled: enabled,
    registrationMode: reg ? reg.mode : 'closed',
    registrationPaused: enabled ? registrationBlockers().length > 0 : true,
    providers: enabled ? oauth.enabledProviders() : [],
    turnstileSiteKey: enabled && turnstile.isConfigured() ? turnstile.getSiteKey() : '',
    passwordMinLength: passwords.MIN_LENGTH,
    legal: legal ? { privacy: !!legal.privacy.trim(), terms: !!legal.terms.trim(), version: legal.version } : { privacy: false, terms: false, version: 0 }
  };
}

async function handleRegister(req, res) {
  const body = await readJson(req);
  const ip = getClientIP(req);
  const reg = getRegistrationSettings();
  if (reg.mode === 'closed') return json(res, 403, { error: '目前暫停開放註冊', code: 'REGISTRATION_CLOSED' });
  const blockers = registrationBlockers();
  if (blockers.length) return json(res, 503, { error: '註冊功能尚未設定完成，請聯絡網站管理員', code: 'REGISTRATION_PAUSED', missing: blockers });

  const bot = looksLikeBot(body);
  if (bot) {
    audit(req, 'bot_honeypot', { detail: `register:${bot}` });
    return json(res, 200, GENERIC_MAIL_REPLY);
  }

  const email = db.normalizeEmail(str(body.email, 300));
  const password = str(body.password, 1000);
  const displayName = str(body.displayName, 60).trim();
  if (!isValidEmail(email)) return json(res, 400, { error: '請輸入有效的 Email', code: 'INVALID_EMAIL', field: 'email' });
  const pwError = passwords.validatePassword(password);
  if (pwError) return json(res, 400, { error: pwError, code: 'WEAK_PASSWORD', field: 'password' });
  const legal = getLegal();
  if (legalExists(legal) && body.agree !== true) {
    return json(res, 400, { error: '請先閱讀並同意隱私權政策與使用條款', code: 'CONSENT_REQUIRED', field: 'agree' });
  }
  if (isDisposable(email)) {
    audit(req, 'bot_disposable', { detail: email.split('@')[1] });
    return json(res, 400, { error: '不接受這個信箱網域，請改用其他信箱', code: 'DISPOSABLE_EMAIL', field: 'email' });
  }
  if (registerByIp.count(ip) >= REGISTER_PER_IP_PER_HOUR) {
    audit(req, 'bot_ratelimit', { detail: 'register_ip' });
    return json(res, 429, { error: '註冊次數過多，請一小時後再試', code: 'RATE_LIMITED' });
  }
  if (signupsGlobal.count('all') >= reg.hourlyCap) {
    audit(req, 'bot_ratelimit', { detail: 'register_global_cap' });
    db.setSetting('registration.capHitAt', String(Date.now()));
    return json(res, 429, { error: '目前註冊人數過多，請稍後再試', code: 'RATE_LIMITED' });
  }
  if (!(await requireTurnstile(req, res, body, 'register'))) return;

  let inviteOk = true;
  if (reg.mode === 'invite') {
    inviteOk = db.useInvite(str(body.inviteCode, 100));
    if (!inviteOk) return json(res, 403, { error: '邀請碼無效或已用完', code: 'INVALID_INVITE', field: 'inviteCode' });
  }

  registerByIp.hit(ip);
  const existing = db.getUserByEmail(email);
  if (existing) {
    // 已註冊者再註冊：改寄「你已有帳號」的信，回應與新註冊相同。
    await sendAccountMail(req, email, 'exists');
    audit(req, 'register_existing', { userId: existing.id });
    return json(res, 200, GENERIC_MAIL_REPLY);
  }
  const passwordHash = await passwords.hashPassword(password);
  signupsGlobal.hit('all');
  const user = db.createUser({
    email,
    displayName: displayName || email.split('@')[0],
    passwordHash,
    termsVersion: legalExists(legal) ? String(legal.version) : null,
    signupIp: ip
  });
  audit(req, 'register', { userId: user.id });
  const token = db.createEmailToken(user.id, 'verify', VERIFY_TTL_MS);
  await sendAccountMail(req, email, 'verify', { token });
  Logger.info('Auth', `New account registered (id ${user.id})`, req);
  return json(res, 200, GENERIC_MAIL_REPLY);
}

function findLoginUser(identifier) {
  const id = String(identifier || '').trim();
  if (!id) return null;
  if (id.includes('@')) return db.getUserByEmail(id);
  return db.getUserByUsername(id);
}

/**
 * 密碼登入。adminOnly 供舊的 /api/admin/login 使用：非管理員一律回「沒有管理權限」。
 * 回傳 { status, body, user }，由呼叫端決定回應格式。
 */
async function passwordLogin(req, res, body, { adminOnly = false } = {}) {
  const ip = getClientIP(req);
  const identifier = typeof body.identifier === 'string' ? body.identifier
    : (typeof body.email === 'string' ? body.email : body.username);
  const password = body.password;
  if (typeof identifier !== 'string' || !identifier.trim() || typeof password !== 'string' || !password) {
    return { status: 400, body: { error: '請輸入帳號與密碼', code: 'MISSING_FIELDS' } };
  }
  const key = accountKey(identifier);

  if (ipFailures.count(ip) >= IP_FAIL_LIMIT) {
    return { status: 429, body: { error: '登入失敗次數過多，請 15 分鐘後再試。', code: 'RATE_LIMITED' } };
  }
  const lockMs = accountLockRemaining(key);
  if (lockMs > 0) {
    const waitMinutes = Math.ceil(lockMs / 60000);
    return { status: 429, body: { error: `登入失敗次數過多，請於 ${waitMinutes} 分鐘後再試。`, code: 'RATE_LIMITED', retryAfter: Math.ceil(lockMs / 1000) } };
  }

  const prior = accountAttempts.get(key);
  const needsChallenge = turnstile.isConfigured() &&
    (ipFailures.count(ip) >= TURNSTILE_AFTER_FAILS || (prior && prior.fails >= TURNSTILE_AFTER_FAILS));
  if (needsChallenge) {
    const result = await turnstile.verify(str(body.turnstileToken, 2048), { ip, action: 'login', hostname: baseHostname() });
    // Cloudflare 故障時退回只靠限速，免得把所有人擋在門外。
    if (!result.ok && !result.unavailable) {
      audit(req, 'bot_turnstile', { detail: `login:${result.reason}` });
      return { status: 403, body: { error: '請先完成人機驗證', code: 'TURNSTILE_REQUIRED' } };
    }
  }

  // 在算雜湊前先記一次失敗：否則同時送出的一批請求都能通過上面的檢查。
  ipFailures.hit(ip);
  const attempt = chargeAccount(key);

  let user = findLoginUser(identifier);
  let ok = false;
  if (!user && config.admin && String(config.admin.username || '') === String(identifier).trim()) {
    // 尚未搬遷的舊管理員：驗證舊憑證，通過就搬進資料庫。
    ok = await passwords.verifyPassword(password, passwords.legacyPbkdf2Hash(config.admin, 100000));
    if (ok) user = migrateLegacyAdmin() || findLoginUser(identifier);
  } else {
    ok = await passwords.verifyPassword(password, user ? user.password_hash : null);
  }

  if (!ok || !user) {
    db.logEvent('login_fail', { userId: user ? user.id : null, ip, detail: user ? null : 'unknown_account' });
    Logger.warn('Auth', `Failed login attempt #${attempt.fails} for "${String(identifier).slice(0, 100)}"`, req);
    if (attempt.lockUntil > Date.now()) {
      Logger.warn('Auth', `Account "${String(identifier).slice(0, 100)}" temporarily locked out after ${attempt.fails} failed attempts.`, req);
    }
    return { status: 401, body: { error: '帳號或密碼錯誤', code: 'INVALID_CREDENTIALS' } };
  }

  // 密碼正確：退還這次的失敗計數。
  ipFailures.undo(ip);
  accountAttempts.delete(key);

  if (user.status !== 'active') {
    db.logEvent('login_blocked', { userId: user.id, ip, detail: 'disabled' });
    return { status: 403, body: { error: '這個帳號已被停用', code: 'ACCOUNT_DISABLED' } };
  }
  if (user.email && !user.email_verified_at && !user.username) {
    return { status: 403, body: { error: '請先到信箱點擊驗證連結，再登入', code: 'EMAIL_NOT_VERIFIED' } };
  }
  if (adminOnly && user.role !== 'admin') {
    return { status: 403, body: { error: '沒有管理權限', code: 'NOT_ADMIN' } };
  }

  if (passwords.needsRehash(user.password_hash)) {
    const newHash = await passwords.hashPassword(password);
    db.updateUser(user.id, { passwordHash: newHash });
    db.logEvent('password_rehash', { userId: user.id, ip });
  }
  const token = session.startSession(req, res, user);
  db.logEvent('login_ok', { userId: user.id, ip, detail: 'password' });
  Logger.info('Auth', `Password login succeeded for "${String(identifier).slice(0, 100)}" (role ${user.role})`, req);
  return { status: 200, body: { success: true, user: publicUser(db.getUserById(user.id)) }, token, user };
}

async function handleLogin(req, res) {
  const body = await readJson(req);
  const result = await passwordLogin(req, res, body);
  return json(res, result.status, result.body);
}

/** 舊的管理員登入端點：給命令列工具與舊版前端，回應另附 token（以 X-Admin-Token 送回）。 */
async function handleLegacyAdminLogin(req, res) {
  try {
    const body = await readJson(req);
    const result = await passwordLogin(req, res, { username: body.username, password: body.password }, { adminOnly: true });
    if (result.status === 200) return json(res, 200, Object.assign({}, result.body, { token: result.token }));
    return json(res, result.status, result.body);
  } catch (err) {
    Logger.error('Auth', 'Admin login processing failed', err, req);
    return json(res, 500, { error: 'Internal Server Error' });
  }
}

function handleLogout(req, res) {
  const s = session.getSession(req);
  if (s) db.logEvent('logout', { userId: s.user.id, ip: getClientIP(req) });
  session.endSession(req, res);
  Logger.info('Auth', 'User logout', req);
  return json(res, 200, { success: true });
}

async function handleVerify(req, res, purpose) {
  const body = await readJson(req);
  const row = db.consumeEmailToken(str(body.token, 200), purpose);
  if (!row) return json(res, 400, { error: '連結無效或已過期，請重新申請', code: 'INVALID_TOKEN' });
  let user = db.getUserById(row.user_id);
  if (!user) return json(res, 400, { error: '連結無效或已過期，請重新申請', code: 'INVALID_TOKEN' });
  if (purpose === 'verify') {
    user = db.updateUser(user.id, { emailVerifiedAt: user.email_verified_at || Date.now() });
    audit(req, 'email_verify', { userId: user.id });
  } else {
    // 變更 Email：新信箱若已被別人使用，回應仍相同，但不套用。
    const taken = db.getUserByEmail(row.new_email);
    if (taken && taken.id !== user.id) {
      audit(req, 'email_change_conflict', { userId: user.id });
      return json(res, 200, { success: true, message: 'Email 已更新' });
    }
    user = db.updateUser(user.id, { email: row.new_email, emailVerifiedAt: Date.now() });
    audit(req, 'email_change', { userId: user.id });
  }
  if (user.status !== 'active') return json(res, 200, { success: true, message: 'Email 已確認' });
  // 連結證明了信箱所有權，直接登入（若目前是別的帳號就換成這個）。
  const current = session.getUser(req);
  if (!current || current.id !== user.id) session.startSession(req, res, user);
  db.logEvent('login_ok', { userId: user.id, ip: getClientIP(req), detail: `email_link:${purpose}` });
  return json(res, 200, { success: true, message: purpose === 'verify' ? 'Email 已確認，歡迎！' : 'Email 已更新', user: publicUser(db.getUserById(user.id)) });
}

async function handleResendVerification(req, res) {
  const body = await readJson(req);
  if (registrationBlockers().length) return json(res, 503, { error: '寄信功能尚未設定完成', code: 'MAIL_UNAVAILABLE' });
  if (looksLikeBot(body)) {
    audit(req, 'bot_honeypot', { detail: 'resend' });
    return json(res, 200, GENERIC_MAIL_REPLY);
  }
  const email = db.normalizeEmail(str(body.email, 300));
  if (!isValidEmail(email)) return json(res, 400, { error: '請輸入有效的 Email', code: 'INVALID_EMAIL', field: 'email' });
  if (!(await requireTurnstile(req, res, body, 'resend'))) return;
  const user = db.getUserByEmail(email);
  if (user && !user.email_verified_at && user.status === 'active') {
    const token = db.createEmailToken(user.id, 'verify', VERIFY_TTL_MS);
    await sendAccountMail(req, email, 'verify', { token });
  }
  return json(res, 200, GENERIC_MAIL_REPLY);
}

async function handleResetRequest(req, res) {
  const body = await readJson(req);
  if (registrationBlockers().length) return json(res, 503, { error: '寄信功能尚未設定完成', code: 'MAIL_UNAVAILABLE' });
  if (looksLikeBot(body)) {
    audit(req, 'bot_honeypot', { detail: 'reset' });
    return json(res, 200, GENERIC_MAIL_REPLY);
  }
  const email = db.normalizeEmail(str(body.email, 300));
  if (!isValidEmail(email)) return json(res, 400, { error: '請輸入有效的 Email', code: 'INVALID_EMAIL', field: 'email' });
  if (!(await requireTurnstile(req, res, body, 'reset'))) return;
  const user = db.getUserByEmail(email);
  if (user && user.status === 'active') {
    const token = db.createEmailToken(user.id, 'reset', RESET_TTL_MS);
    await sendAccountMail(req, email, 'reset', { token });
    audit(req, 'password_reset_request', { userId: user.id });
  }
  return json(res, 200, GENERIC_MAIL_REPLY);
}

async function handleReset(req, res) {
  const body = await readJson(req);
  const password = str(body.password, 1000);
  const pwError = passwords.validatePassword(password);
  if (pwError) return json(res, 400, { error: pwError, code: 'WEAK_PASSWORD', field: 'password' });
  const token = str(body.token, 200);
  if (!db.peekEmailToken(token, 'reset')) return json(res, 400, { error: '連結無效或已過期，請重新申請', code: 'INVALID_TOKEN' });
  const hash = await passwords.hashPassword(password);
  const row = db.consumeEmailToken(token, 'reset');
  if (!row) return json(res, 400, { error: '連結無效或已過期，請重新申請', code: 'INVALID_TOKEN' });
  let user = db.getUserById(row.user_id);
  if (!user) return json(res, 400, { error: '連結無效或已過期，請重新申請', code: 'INVALID_TOKEN' });
  // 重設信也證明了信箱所有權；只用第三方登入的人可以用這個流程補設密碼。
  user = db.updateUser(user.id, {
    passwordHash: hash,
    passwordChangedAt: Date.now(),
    emailVerifiedAt: user.email_verified_at || Date.now()
  });
  db.deleteUserSessions(user.id);
  accountAttempts.delete(accountKey(user.email));
  audit(req, 'password_reset', { userId: user.id });
  if (user.status === 'active') session.startSession(req, res, user);
  return json(res, 200, { success: true, message: '密碼已更新，其他裝置都已登出。', user: publicUser(user) });
}

async function handleChangePassword(req, res, s) {
  const body = await readJson(req);
  const newPassword = str(body.newPassword, 1000);
  const pwError = passwords.validatePassword(newPassword);
  if (pwError) return json(res, 400, { error: pwError, code: 'WEAK_PASSWORD', field: 'newPassword' });
  const user = s.user;
  if (user.password_hash) {
    const ok = await passwords.verifyPassword(str(body.currentPassword, 1000), user.password_hash);
    if (!ok) {
      audit(req, 'password_change_fail', { userId: user.id });
      return json(res, 403, { error: '目前密碼不正確', code: 'WRONG_PASSWORD', field: 'currentPassword' });
    }
  } else if (!session.hasRecentReauth(req)) {
    return json(res, 403, { error: '請先重新驗證身分', code: 'REAUTH_REQUIRED' });
  }
  const hash = await passwords.hashPassword(newPassword);
  db.updateUser(user.id, { passwordHash: hash, passwordChangedAt: Date.now() });
  const removed = db.deleteUserSessions(user.id, s.session.id);
  session.markReauth(req);
  audit(req, user.password_hash ? 'password_change' : 'password_set', { userId: user.id });
  Logger.info('Auth', `Password changed for account id ${user.id}; ${removed} other session(s) revoked`, req);
  return json(res, 200, { success: true, message: '密碼已更新，已登出其他裝置。' });
}

async function handleReauth(req, res, s) {
  const body = await readJson(req);
  if (!s.user.password_hash) return json(res, 400, { error: '這個帳號沒有密碼，請用第三方登入重新驗證', code: 'USE_PROVIDER' });
  const key = accountKey(s.user.email || s.user.username);
  if (accountLockRemaining(key) > 0) return json(res, 429, { error: '失敗次數過多，請稍後再試', code: 'RATE_LIMITED' });
  const attempt = chargeAccount(key);
  const ok = await passwords.verifyPassword(str(body.password, 1000), s.user.password_hash);
  if (!ok) {
    audit(req, 'reauth_fail', { userId: s.user.id, detail: `#${attempt.fails}` });
    return json(res, 403, { error: '密碼不正確', code: 'WRONG_PASSWORD' });
  }
  accountAttempts.delete(key);
  session.markReauth(req);
  audit(req, 'reauth', { userId: s.user.id });
  return json(res, 200, { success: true });
}

function handleAcceptTerms(req, res, s) {
  const legal = getLegal();
  db.updateUser(s.user.id, { termsVersion: String(legal.version), termsAcceptedAt: Date.now() });
  audit(req, 'terms_accept', { userId: s.user.id, detail: `v${legal.version}` });
  return json(res, 200, { success: true, user: publicUser(db.getUserById(s.user.id)) });
}

// ── 第三方登入 ───────────────────────────────────────────────
function oauthDone(res, status, code = '', mode = 'login') {
  const params = new URLSearchParams({ auth: 'oauth', status, mode });
  if (code) params.set('code', code);
  return redirect(res, `/?${params.toString()}`);
}

function handleOAuthStart(req, res, provider, query) {
  if (!oauth.isConfigured(provider)) return json(res, 404, { error: '這個登入方式尚未啟用', code: 'PROVIDER_DISABLED' });
  const base = publicBaseUrl();
  if (!base) return oauthDone(res, 'error', 'NO_BASE_URL');
  const mode = ['login', 'link', 'reauth'].includes(query.mode) ? query.mode : 'login';
  const current = session.getUser(req);
  if ((mode === 'link' || mode === 'reauth') && !current) return oauthDone(res, 'error', 'LOGIN_REQUIRED', mode);
  const url = oauth.begin(req, res, provider, { baseUrl: base, mode, userId: current ? current.id : null });
  return redirect(res, url);
}

async function createUserFromProfile(req, profile) {
  const ip = getClientIP(req);
  const reg = getRegistrationSettings();
  if (reg.mode !== 'open') return { error: reg.mode === 'invite' ? 'INVITE_REQUIRED' : 'REGISTRATION_CLOSED' };
  if (registerByIp.count(ip) >= REGISTER_PER_IP_PER_HOUR) {
    audit(req, 'bot_ratelimit', { detail: `oauth_${profile.provider}_ip` });
    return { error: 'RATE_LIMITED' };
  }
  if (signupsGlobal.count('all') >= reg.hourlyCap) {
    audit(req, 'bot_ratelimit', { detail: 'register_global_cap' });
    db.setSetting('registration.capHitAt', String(Date.now()));
    return { error: 'RATE_LIMITED' };
  }
  let email = profile.email ? db.normalizeEmail(profile.email) : null;
  if (email && (!isValidEmail(email) || db.getUserByEmail(email))) email = null;
  if (email && isDisposable(email)) return { error: 'DISPOSABLE_EMAIL' };
  registerByIp.hit(ip);
  signupsGlobal.hit('all');
  const user = db.createUser({
    email,
    emailVerifiedAt: email && profile.emailVerified ? Date.now() : null,
    displayName: profile.name || (email ? email.split('@')[0] : `${oauth.PROVIDERS[profile.provider].label} 使用者`),
    signupIp: ip
  });
  db.linkIdentity(user.id, profile.provider, profile.subject, profile.email);
  audit(req, 'register', { userId: user.id, detail: `oauth:${profile.provider}` });
  // Facebook 給的 Email 沒有驗證旗標：先當未驗證並寄驗證信。這樣的帳號仍可用 Facebook 登入。
  if (email && !profile.emailVerified && mailer.isConfigured() && publicBaseUrl()) {
    const token = db.createEmailToken(user.id, 'verify', VERIFY_TTL_MS);
    await sendAccountMail(req, email, 'verify', { token });
  }
  return { user };
}

/**
 * 帳號對應規則：
 * - 該家使用者 ID 已綁定 → 直接登入
 * - Email 可信（Google email_verified、Apple 給的 Email）且有同 Email 帳號：
 *     已驗證 → 綁定後登入並寄信通知；未驗證 → 以第三方為所有權證明，標為已驗證、
 *     清掉原密碼與所有 session（防止有人先用別人的 Email 註冊埋伏）
 * - Facebook 的 Email 與既有帳號相同 → 不自動綁定
 * - 完全沒有對應帳號 → 建新帳號（不設密碼）
 */
async function resolveLogin(req, profile) {
  const identity = db.getIdentity(profile.provider, profile.subject);
  if (identity) return { user: db.getUserById(identity.user_id) };
  const email = profile.email ? db.normalizeEmail(profile.email) : '';
  const existing = email ? db.getUserByEmail(email) : null;
  if (existing) {
    if (!profile.emailVerified) return { error: 'EMAIL_IN_USE' };
    if (existing.email_verified_at) {
      db.linkIdentity(existing.id, profile.provider, profile.subject, profile.email);
      audit(req, 'oauth_link', { userId: existing.id, detail: `${profile.provider}:auto` });
      await sendAccountMail(req, existing.email, 'linked', { extra: { provider: oauth.PROVIDERS[profile.provider].label } });
      return { user: db.getUserById(existing.id) };
    }
    db.deleteUserSessions(existing.id);
    const user = db.updateUser(existing.id, { emailVerifiedAt: Date.now(), passwordHash: null });
    db.linkIdentity(user.id, profile.provider, profile.subject, profile.email);
    audit(req, 'oauth_claim_unverified', { userId: user.id, detail: profile.provider });
    return { user };
  }
  return createUserFromProfile(req, profile);
}

async function handleOAuthCallback(req, res, provider, params) {
  const base = publicBaseUrl();
  let result;
  try {
    result = await oauth.complete(req, res, provider, params, { baseUrl: base });
  } catch (err) {
    audit(req, 'oauth_fail', { detail: `${provider}:${err.code || err.message}`.slice(0, 120) });
    Logger.warn('Auth', `OAuth ${provider} callback failed: ${err.code || err.message}`, req);
    return oauthDone(res, 'error', err.code === 'denied' ? 'DENIED' : 'OAUTH_FAILED');
  }
  const { profile, entry } = result;
  const current = session.getUser(req);

  if (entry.mode === 'link' || entry.mode === 'reauth') {
    if (!current || current.id !== entry.userId) return oauthDone(res, 'error', 'LOGIN_REQUIRED', entry.mode);
    const identity = db.getIdentity(profile.provider, profile.subject);
    if (entry.mode === 'reauth') {
      if (!identity || identity.user_id !== current.id) return oauthDone(res, 'error', 'IDENTITY_MISMATCH', 'reauth');
      session.markReauth(req);
      audit(req, 'reauth', { userId: current.id, detail: provider });
      return oauthDone(res, 'ok', '', 'reauth');
    }
    if (identity && identity.user_id !== current.id) return oauthDone(res, 'error', 'IDENTITY_IN_USE', 'link');
    if (db.listIdentities(current.id).some(i => i.provider === provider && i.subject !== profile.subject)) {
      return oauthDone(res, 'error', 'ALREADY_LINKED', 'link');
    }
    db.linkIdentity(current.id, profile.provider, profile.subject, profile.email);
    audit(req, 'oauth_link', { userId: current.id, detail: provider });
    return oauthDone(res, 'ok', '', 'link');
  }

  const resolved = await resolveLogin(req, profile);
  if (resolved.error) {
    audit(req, 'oauth_login_refused', { detail: `${provider}:${resolved.error}` });
    return oauthDone(res, 'error', resolved.error);
  }
  const user = resolved.user;
  if (!user || user.status !== 'active') {
    db.logEvent('login_blocked', { userId: user ? user.id : null, ip: getClientIP(req), detail: 'disabled' });
    return oauthDone(res, 'error', 'ACCOUNT_DISABLED');
  }
  session.startSession(req, res, user);
  db.logEvent('login_ok', { userId: user.id, ip: getClientIP(req), detail: provider });
  Logger.info('Auth', `Login succeeded via ${provider} (account id ${user.id})`, req);
  return oauthDone(res, 'ok');
}

// ── /api/me ──────────────────────────────────────────────────
async function handleUpdateMe(req, res, s) {
  const body = await readJson(req);
  const fields = {};
  if (typeof body.displayName === 'string') {
    const name = body.displayName.trim().slice(0, 60);
    if (!name) return json(res, 400, { error: '名稱不能空白', code: 'INVALID_NAME', field: 'displayName' });
    fields.displayName = name;
  }
  const user = db.updateUser(s.user.id, fields);
  return json(res, 200, { success: true, user: publicUser(user) });
}

async function handleChangeEmail(req, res, s) {
  const body = await readJson(req);
  if (registrationBlockers().length) return json(res, 503, { error: '寄信功能尚未設定完成', code: 'MAIL_UNAVAILABLE' });
  const newEmail = db.normalizeEmail(str(body.newEmail, 300));
  if (!isValidEmail(newEmail)) return json(res, 400, { error: '請輸入有效的 Email', code: 'INVALID_EMAIL', field: 'newEmail' });
  if (newEmail === s.user.email) return json(res, 400, { error: '這已經是你的 Email', code: 'SAME_EMAIL', field: 'newEmail' });
  if (isDisposable(newEmail)) return json(res, 400, { error: '不接受這個信箱網域，請改用其他信箱', code: 'DISPOSABLE_EMAIL', field: 'newEmail' });
  if (!(await requireTurnstile(req, res, body, 'change_email'))) return;
  // 新信箱已被使用時，回應與成功相同，避免洩露。
  if (!db.getUserByEmail(newEmail)) {
    const token = db.createEmailToken(s.user.id, 'change_email', CHANGE_EMAIL_TTL_MS, newEmail);
    await sendAccountMail(req, newEmail, 'change_email', { token });
    if (s.user.email && s.user.email_verified_at) {
      await sendAccountMail(req, s.user.email, 'email_change_notice', { extra: { newEmail } });
    }
  }
  audit(req, 'email_change_request', { userId: s.user.id });
  return json(res, 200, { success: true, message: '已寄確認信到新信箱，點擊信中連結後才會生效。' });
}

function handleListSessions(req, res, s) {
  const rows = db.listUserSessions(s.user.id).map(r => ({
    id: r.id, createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.expires_at,
    ip: r.ip, userAgent: r.user_agent, current: r.id === s.session.id
  }));
  return json(res, 200, { sessions: rows });
}

function handleDeleteSessions(req, res, s, id) {
  let removed;
  if (id) {
    removed = db.deleteSessionById(id, s.user.id);
    if (id === s.session.id) session.clearSessionCookie(req, res);
  } else {
    removed = db.deleteUserSessions(s.user.id, s.session.id);
  }
  audit(req, 'session_revoke', { userId: s.user.id, detail: id ? `one:${id}` : `others:${removed}` });
  return json(res, 200, { success: true, removed });
}

function loginMethodCount(user) {
  return (user.password_hash ? 1 : 0) + db.listIdentities(user.id).length;
}

function handleUnlinkMe(req, res, s, provider) {
  const identities = db.listIdentities(s.user.id);
  if (!identities.some(i => i.provider === provider)) return json(res, 404, { error: '沒有綁定這個登入方式', code: 'NOT_LINKED' });
  if (loginMethodCount(s.user) <= 1) {
    return json(res, 400, { error: '這是你唯一的登入方式，請先設定密碼或綁定其他方式', code: 'LAST_LOGIN_METHOD' });
  }
  db.unlinkIdentity(s.user.id, provider);
  audit(req, 'oauth_unlink', { userId: s.user.id, detail: provider });
  return json(res, 200, { success: true, user: publicUser(db.getUserById(s.user.id)) });
}

function exportUser(userId) {
  const d = db.getDb();
  const user = db.getUserById(userId);
  return {
    exportedAt: new Date().toISOString(),
    account: {
      email: user.email, username: user.username, displayName: user.display_name, role: user.role,
      emailVerifiedAt: user.email_verified_at, createdAt: user.created_at, lastLoginAt: user.last_login_at,
      termsVersion: user.terms_version, termsAcceptedAt: user.terms_accepted_at
    },
    identities: db.listIdentities(userId).map(i => ({ provider: i.provider, email: i.email, createdAt: i.created_at })),
    sessions: db.listUserSessions(userId).map(r => ({ createdAt: r.created_at, lastSeenAt: r.last_seen_at, ip: r.ip, userAgent: r.user_agent })),
    preferences: (() => {
      const row = d.prepare('SELECT data, updated_at FROM user_prefs WHERE user_id = ?').get(userId);
      if (!row) return null;
      try { return { data: JSON.parse(row.data), updatedAt: row.updated_at }; } catch (_) { return null; }
    })(),
    bookmarks: d.prepare('SELECT path, anchor, title, updated_at FROM bookmarks WHERE user_id = ? AND deleted_at IS NULL').all(userId).map(r => Object.assign({}, r)),
    readProgress: d.prepare('SELECT path, position, heading, updated_at FROM read_progress WHERE user_id = ?').all(userId).map(r => Object.assign({}, r)),
    securityEvents: db.listEvents({ userId, limit: 200 }).map(e => ({ event: e.event, ip: e.ip, at: e.at }))
  };
}

function handleExportMe(req, res, s) {
  const data = exportUser(s.user.id);
  const payload = Buffer.from(JSON.stringify(data, null, 2), 'utf-8');
  res.writeHead(200, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': 'attachment; filename="my-account-data.json"',
    'Cache-Control': 'no-store',
    'Content-Length': payload.length
  }, SECURITY_HEADERS));
  res.end(payload);
}

function handleDeleteMe(req, res, s) {
  if (!session.hasRecentReauth(req)) return json(res, 403, { error: '刪除帳號前請先重新驗證身分', code: 'REAUTH_REQUIRED' });
  if (s.user.role === 'admin' && db.countActiveAdmins() <= 1) {
    return json(res, 400, { error: '你是最後一位管理員，請先指定其他管理員', code: 'LAST_ADMIN' });
  }
  audit(req, 'account_delete', { userId: s.user.id });
  db.deleteUser(s.user.id);
  session.clearSessionCookie(req, res);
  Logger.info('Auth', 'Account deleted by its owner', req);
  return json(res, 200, { success: true });
}

// ── 管理員 ───────────────────────────────────────────────────
function adminUserView(user) {
  return Object.assign(publicUser(user), {
    status: user.status,
    lastLoginAt: user.last_login_at,
    passwordChangedAt: user.password_changed_at,
    termsVersion: user.terms_version,
    signupIp: user.signup_ip,
    sessions: db.listUserSessions(user.id).map(r => ({ id: r.id, lastSeenAt: r.last_seen_at, ip: r.ip, userAgent: r.user_agent })),
    recentEvents: db.listEvents({ userId: user.id, limit: 20 })
  });
}

function requireReauth(req, res) {
  if (session.hasRecentReauth(req)) return true;
  json(res, 403, { error: '這個操作需要先重新驗證身分（10 分鐘內有效）', code: 'REAUTH_REQUIRED' });
  return false;
}

function lastAdminGuard(res, target, { demote = false, disable = false, remove = false }) {
  if (target.role !== 'admin' || target.status !== 'active') return true;
  if ((demote || disable || remove) && db.countActiveAdmins() <= 1) {
    json(res, 400, { error: '不能停用、刪除或降級最後一位啟用中的管理員', code: 'LAST_ADMIN' });
    return false;
  }
  return true;
}

async function handleAdminUserAction(req, res, admin, id, action) {
  const target = db.getUserById(id);
  if (!target) return json(res, 404, { error: '找不到這位使用者', code: 'NOT_FOUND' });
  const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readJson(req);
  const meta = { userId: target.id, actorId: admin.id };

  if (action === 'status') {
    const status = body.status === 'disabled' ? 'disabled' : 'active';
    if (status === 'disabled' && !lastAdminGuard(res, target, { disable: true })) return;
    db.updateUser(target.id, { status });
    if (status === 'disabled') db.deleteUserSessions(target.id);
    audit(req, status === 'disabled' ? 'admin_disable' : 'admin_enable', meta);
  } else if (action === 'role') {
    if (!requireReauth(req, res)) return;
    const role = body.role === 'admin' ? 'admin' : 'user';
    if (role === 'user' && !lastAdminGuard(res, target, { demote: true })) return;
    db.updateUser(target.id, { role });
    // 升為 admin：現有 session 立即改用 7 天規則。
    db.clampUserSessions(target.id, session.idleTtlFor(role));
    audit(req, 'admin_role', Object.assign({ detail: role }, meta));
  } else if (action === 'logout') {
    const removed = db.deleteUserSessions(target.id);
    audit(req, 'admin_force_logout', Object.assign({ detail: String(removed) }, meta));
  } else if (action === 'resend-verification') {
    if (!target.email || target.email_verified_at) return json(res, 400, { error: '這個帳號不需要驗證', code: 'ALREADY_VERIFIED' });
    const token = db.createEmailToken(target.id, 'verify', VERIFY_TTL_MS);
    const r = await sendAccountMail(null, target.email, 'verify', { token });
    if (!r.ok) return json(res, 502, { error: '寄信失敗', code: 'MAIL_FAILED', detail: r.error });
    audit(req, 'admin_resend_verification', meta);
  } else if (action === 'send-reset') {
    if (!target.email) return json(res, 400, { error: '這個帳號沒有 Email', code: 'NO_EMAIL' });
    const token = db.createEmailToken(target.id, 'reset', RESET_TTL_MS);
    const r = await sendAccountMail(null, target.email, 'reset', { token });
    if (!r.ok) return json(res, 502, { error: '寄信失敗', code: 'MAIL_FAILED', detail: r.error });
    audit(req, 'admin_send_reset', meta);
  } else if (action === 'unlink') {
    const provider = str(body.provider, 20);
    if (!db.listIdentities(target.id).some(i => i.provider === provider)) return json(res, 404, { error: '沒有綁定這個登入方式', code: 'NOT_LINKED' });
    if (loginMethodCount(target) <= 1) return json(res, 400, { error: '這是該帳號唯一的登入方式', code: 'LAST_LOGIN_METHOD' });
    db.unlinkIdentity(target.id, provider);
    audit(req, 'admin_unlink', Object.assign({ detail: provider }, meta));
  } else if (action === 'delete') {
    if (!requireReauth(req, res)) return;
    if (!lastAdminGuard(res, target, { remove: true })) return;
    audit(req, 'admin_delete_user', meta);
    db.deleteUser(target.id);
    return json(res, 200, { success: true });
  } else if (action === 'export') {
    audit(req, 'admin_export_user', meta);
    return json(res, 200, exportUser(target.id));
  } else {
    return json(res, 404, { error: 'Unknown action' });
  }
  return json(res, 200, { success: true, user: adminUserView(db.getUserById(target.id)) });
}

async function handleAdminRegistration(req, res, admin) {
  if (req.method === 'GET') return json(res, 200, Object.assign(getRegistrationSettings(), { blockers: registrationBlockers() }));
  const body = await readJson(req);
  if (body.mode !== undefined) {
    if (!['open', 'invite', 'closed'].includes(body.mode)) return json(res, 400, { error: '未知的註冊模式', code: 'INVALID_MODE' });
    db.setSetting('registration.mode', body.mode);
  }
  if (body.hourlyCap !== undefined) {
    const cap = parseInt(body.hourlyCap, 10);
    if (!Number.isInteger(cap) || cap < 1 || cap > 10000) return json(res, 400, { error: '每小時上限需為 1–10000', code: 'INVALID_CAP' });
    db.setSetting('registration.hourlyCap', String(cap));
  }
  if (body.disposableDomains !== undefined) {
    const raw = Array.isArray(body.disposableDomains) ? body.disposableDomains : String(body.disposableDomains).split(/[\s,]+/);
    const list = [...new Set(raw.map(d => String(d).trim().toLowerCase().replace(/^@/, '')).filter(d => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)))].slice(0, 2000);
    db.setJsonSetting('registration.disposableDomains', list);
  }
  audit(req, 'admin_registration_settings', { actorId: admin.id, detail: JSON.stringify({ mode: body.mode, hourlyCap: body.hourlyCap }).slice(0, 200) });
  return json(res, 200, Object.assign({ success: true }, getRegistrationSettings(), { blockers: registrationBlockers() }));
}

async function handleAdminInvites(req, res, admin, id, action) {
  if (req.method === 'GET') return json(res, 200, { invites: db.listInvites() });
  if (id && action === 'revoke') {
    db.revokeInvite(id);
    audit(req, 'admin_invite_revoke', { actorId: admin.id, detail: String(id) });
    return json(res, 200, { success: true, invites: db.listInvites() });
  }
  const body = await readJson(req);
  const days = parseInt(body.expiresInDays, 10);
  const invite = db.createInvite({
    createdBy: admin.id,
    usesLeft: parseInt(body.usesLeft, 10) || 1,
    expiresAt: Number.isInteger(days) && days > 0 ? Date.now() + days * 24 * HOUR_MS : null,
    note: str(body.note, 200)
  });
  audit(req, 'admin_invite_create', { actorId: admin.id, detail: String(invite.id) });
  return json(res, 200, { success: true, code: invite.code, invites: db.listInvites() });
}

function botStats() {
  const since = Date.now() - 24 * HOUR_MS;
  const rows = db.countEventsSince(since, 'bot_');
  const byKind = { turnstile: 0, honeypot: 0, ratelimit: 0, disposable: 0, turnstile_unavailable: 0 };
  for (const r of rows) {
    const kind = r.event.replace(/^bot_/, '');
    byKind[kind] = (byKind[kind] || 0) + r.n;
  }
  const signups = db.countUsers({ since });
  const capHitAt = parseInt(db.getSetting('registration.capHitAt', '0'), 10) || null;
  return {
    since,
    blocked: byKind,
    signups24h: signups,
    signupsLastHour: signupsGlobal.count('all'),
    capHitAt,
    turnstile: turnstile.getStatus()
  };
}

function lockouts() {
  const t = Date.now();
  const accounts = [];
  for (const [key, a] of accountAttempts) {
    if (a.lockUntil > t || a.fails > 0) accounts.push({ key, fails: a.fails, lockedUntil: a.lockUntil > t ? a.lockUntil : null });
  }
  const ips = ipFailures.entries().map(([ip, n]) => ({ ip, fails: n, locked: n >= IP_FAIL_LIMIT }));
  return { accounts, ips, limits: { ipFailLimit: IP_FAIL_LIMIT, ipWindowMinutes: IP_FAIL_WINDOW_MS / MINUTE_MS, accountAttempts: MAX_ATTEMPTS } };
}

async function handleAdminLockoutsClear(req, res, admin) {
  const body = await readJson(req);
  const key = str(body.key, 300);
  if (key) {
    accountAttempts.delete(key);
    ipFailures.reset(key);
  } else {
    accountAttempts.clear();
  }
  audit(req, 'admin_lockouts_clear', { actorId: admin.id, detail: key || 'all' });
  return json(res, 200, Object.assign({ success: true }, lockouts()));
}

async function handleAdminLegal(req, res, admin) {
  if (req.method === 'GET') return json(res, 200, getLegal());
  const body = await readJson(req);
  const legal = getLegal();
  const privacy = typeof body.privacy === 'string' ? body.privacy.slice(0, 200000) : legal.privacy;
  const terms = typeof body.terms === 'string' ? body.terms.slice(0, 200000) : legal.terms;
  const version = legal.version + 1;
  db.setSetting('legal.privacy', privacy);
  db.setSetting('legal.terms', terms);
  db.setSetting('legal.version', String(version));
  db.setSetting('legal.updatedAt', String(Date.now()));
  // 第一次發布或勾選「重大變更」：已註冊者下次登入要重新同意。
  if (body.major === true || !legal.majorVersion) db.setSetting('legal.majorVersion', String(version));
  audit(req, 'admin_legal_update', { actorId: admin.id, detail: `v${version}${body.major === true ? ' major' : ''}` });
  return json(res, 200, Object.assign({ success: true }, getLegal()));
}

async function handleAdminMailTest(req, res, admin) {
  const body = await readJson(req);
  const to = db.normalizeEmail(str(body.to, 300)) || admin.email;
  if (!isValidEmail(to)) return json(res, 400, { error: '請輸入收件 Email', code: 'INVALID_EMAIL' });
  const r = await sendAccountMail(null, to, 'test');
  audit(req, 'admin_mail_test', { actorId: admin.id, detail: r.ok ? 'ok' : r.error });
  if (!r.ok) return json(res, 502, { error: `寄信失敗（${r.error}）`, code: 'MAIL_FAILED' });
  if (mailer.getProvider() === 'resend') db.setSetting('integrations.mail.testedAt', String(Date.now()));
  return json(res, 200, { success: true, message: `測試信已寄到 ${to}`, status: mailer.getStatus(), setup: setupProgress() });
}

const MAIL_KEY_MESSAGES = {
  invalid: 'Resend 不接受這個 API 金鑰，請到 Resend 的 API Keys 頁面重新複製',
  unreachable: '暫時連不上 Resend，金鑰已先儲存，稍後請寄測試信確認'
};

/** 後台儲存寄信設定。API 金鑰先向 Resend 驗過才存；寄件人格式不對直接拒絕。 */
async function handleAdminMailSettings(req, res, admin) {
  if (!requireReauth(req, res)) return;
  const body = await readJson(req);
  const updates = {};
  const warnings = [];
  if (body.provider !== undefined) {
    const p = str(body.provider, 20).toLowerCase();
    if (!['resend', 'log', ''].includes(p)) return json(res, 400, { error: '不支援這個寄信服務', code: 'INVALID_PROVIDER' });
    updates.mailProvider = p;
  }
  if (body.from !== undefined) {
    const from = str(body.from, 300).trim();
    if (from && !mailer.parseFrom(from)) return json(res, 400, { error: '寄件人格式應為「名稱 <noreply@你的網域>」或「noreply@你的網域」', code: 'INVALID_FROM' });
    updates.mailFrom = from;
  }
  let keyCheck = null;
  if (body.clearApiKey === true) {
    updates.mailApiKey = '';
  } else if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
    const key = body.apiKey.trim().slice(0, 300);
    keyCheck = await mailer.checkResendKey(key);
    if (keyCheck.state === 'invalid') return json(res, 400, { error: MAIL_KEY_MESSAGES.invalid, code: 'INVALID_API_KEY', keyCheck });
    if (keyCheck.state === 'unreachable') warnings.push(MAIL_KEY_MESSAGES.unreachable);
    updates.mailApiKey = key;
  }
  const changed = integrations.set(updates);
  if (changed.length) db.setSetting('integrations.mail.testedAt', '');
  // 完整權限的金鑰查得到網域：寄件網域不在清單或還沒驗證時提醒。
  const domain = mailer.getSenderDomain();
  if (keyCheck && keyCheck.state === 'valid' && domain) {
    const d = keyCheck.domains.find(x => x.name.toLowerCase() === domain);
    if (!d) warnings.push(`Resend 帳號裡沒有 ${domain} 這個網域，請先在 Resend 的 Domains 新增並驗證`);
    else if (d.status !== 'verified') warnings.push(`${domain} 在 Resend 的狀態是「${d.status}」，驗證通過前寄不出信`);
  }
  audit(req, 'admin_mail_settings', { actorId: admin.id, detail: changed.join(',') || 'none' });
  return json(res, 200, { success: true, changed, warnings, keyCheck: keyCheck && { state: keyCheck.state, domains: keyCheck.domains }, mail: mailer.getStatus(), setup: setupProgress() });
}

const TURNSTILE_SECRET_MESSAGES = {
  invalid_secret: 'Cloudflare 不接受這個 secret，請到 Turnstile 的設定頁重新複製',
  unreachable: '暫時連不上 Cloudflare，secret 已先儲存，稍後請用下方的實測確認'
};

/** 後台儲存 Turnstile 設定。secret 先向 Cloudflare 驗過才存。 */
async function handleAdminTurnstileSettings(req, res, admin) {
  if (!requireReauth(req, res)) return;
  const body = await readJson(req);
  const updates = {};
  const warnings = [];
  let secretCheck = null;
  if (body.disable === true) {
    updates.turnstileSiteKey = '';
    updates.turnstileSecret = '';
  } else {
    if (body.siteKey !== undefined) {
      const siteKey = str(body.siteKey, 200).trim();
      if (siteKey && !/^[0-9]x[A-Za-z0-9_-]{8,}$/.test(siteKey)) return json(res, 400, { error: 'Site key 格式不對，應以 0x 開頭（從 Cloudflare 的 Turnstile 頁面複製）', code: 'INVALID_SITE_KEY' });
      updates.turnstileSiteKey = siteKey;
    }
    if (typeof body.secret === 'string' && body.secret.trim()) {
      const secret = body.secret.trim().slice(0, 300);
      secretCheck = await turnstile.checkSecret(secret);
      if (secretCheck.state === 'invalid_secret') return json(res, 400, { error: TURNSTILE_SECRET_MESSAGES.invalid_secret, code: 'INVALID_SECRET', secretCheck });
      if (secretCheck.state === 'unreachable') warnings.push(TURNSTILE_SECRET_MESSAGES.unreachable);
      updates.turnstileSecret = secret;
    }
  }
  const changed = integrations.set(updates);
  if (changed.length) db.setSetting('integrations.turnstile.testedAt', '');
  if (turnstile.usesTestKeys()) warnings.push('目前是 Cloudflare 的測試金鑰，任何人都會通過驗證，正式網站請換成自己的金鑰');
  else if (turnstile.getSiteKey() && !turnstile.isConfigured()) warnings.push('還缺 secret，Turnstile 要兩個都填才會啟用');
  audit(req, 'admin_turnstile_settings', { actorId: admin.id, detail: changed.join(',') || 'none' });
  return json(res, 200, { success: true, changed, warnings, secretCheck, info: turnstileInfo(), setup: setupProgress() });
}

/** 後台實測：管理員在設定頁完成一次 Turnstile，用目前的金鑰到 Cloudflare 驗證（含網域比對）。 */
async function handleAdminTurnstileVerify(req, res, admin) {
  const body = await readJson(req);
  if (!turnstile.isConfigured()) return json(res, 400, { error: 'Turnstile 還沒設定完成', code: 'TURNSTILE_NOT_CONFIGURED' });
  const result = await turnstile.verify(str(body.token, 2048), { ip: getClientIP(req), action: 'admin-test', hostname: baseHostname() });
  if (result.ok) db.setSetting('integrations.turnstile.testedAt', String(Date.now()));
  audit(req, 'admin_turnstile_verify', { actorId: admin.id, detail: result.ok ? 'ok' : (result.reason || 'failed') });
  return json(res, 200, { ok: !!result.ok, reason: result.reason || null, unavailable: !!result.unavailable, info: turnstileInfo(), setup: setupProgress() });
}

/**
 * 初次設定的進度：對外網址 → 寄信服務 → 測試信 → Turnstile → Turnstile 實測。
 * 寄信用 log 模式只算「測試用」，不算完成。
 */
function setupProgress() {
  const testedAt = key => parseInt(db.getSetting(key, '0'), 10) || null;
  const mailReal = mailer.getProvider() === 'resend' && mailer.isConfigured();
  const steps = [
    { id: 'baseUrl', label: '設定對外網址', done: !!publicBaseUrl(), required: true },
    { id: 'mail', label: '連接寄信服務（Resend）', done: mailReal, required: true },
    { id: 'mailTest', label: '寄一封測試信', done: mailReal && !!testedAt('integrations.mail.testedAt'), at: testedAt('integrations.mail.testedAt'), required: true },
    { id: 'turnstile', label: '設定 Turnstile 人機驗證', done: turnstile.isConfigured() && !turnstile.usesTestKeys(), required: false },
    { id: 'turnstileTest', label: '實際通過一次 Turnstile', done: turnstile.isConfigured() && !!testedAt('integrations.turnstile.testedAt'), at: testedAt('integrations.turnstile.testedAt'), required: false }
  ];
  return { steps, complete: steps.every(s => s.done), requiredComplete: steps.filter(s => s.required).every(s => s.done) };
}

/** 後台顯示用：site key 本來就會送到瀏覽器，可以完整顯示；secret 只回報有沒有設定。 */
function turnstileInfo() {
  const st = turnstile.getStatus();
  return Object.assign({}, st, {
    siteKey: turnstile.getSiteKey() || null,
    expectedHostname: baseHostname() || null,
    protects: ['註冊', '忘記密碼', '重寄驗證信', '變更 Email', '登入（連續失敗 3 次後）'],
    envVars: [
      { name: 'TURNSTILE_SITE_KEY', set: st.siteKeySet },
      { name: 'TURNSTILE_SECRET_KEY', set: st.secretSet }
    ],
    settings: {
      siteKey: integrations.describe('turnstileSiteKey'),
      secret: integrations.describe('turnstileSecret')
    }
  });
}

function overview(admin) {
  const base = publicBaseUrl();
  return {
    database: db.getStatus(),
    publicBaseUrl: base || null,
    publicBaseUrlSource: (process.env.PUBLIC_BASE_URL || '').trim() ? 'env' : (base ? 'siteUrl' : null),
    mail: mailer.getStatus(),
    turnstile: turnstileInfo(),
    setup: setupProgress(),
    providers: oauth.getStatus(base),
    registration: Object.assign(getRegistrationSettings(), { blockers: registrationBlockers() }),
    legal: (() => { const l = getLegal(); return { privacy: !!l.privacy.trim(), terms: !!l.terms.trim(), version: l.version, updatedAt: l.updatedAt }; })(),
    me: publicUser(admin),
    adminNeedsEmail: !admin.email,
    counts: {
      users: db.countUsers(),
      admins: db.countActiveAdmins(),
      disabled: db.countUsers({ status: 'disabled' }),
      unverified: db.countUsers({ unverified: true })
    }
  };
}

async function handleAdminDbBackups(req, res, admin, sub) {
  if (sub === '' && req.method === 'GET') return json(res, 200, { backups: db.listBackups(), status: db.getStatus() });
  if (sub === '' && req.method === 'POST') {
    const r = db.backupNow('manual');
    if (!r) return json(res, 400, { error: '這個資料庫無法備份（記憶體資料庫或未設定備份目錄）', code: 'BACKUP_UNAVAILABLE' });
    audit(req, 'admin_db_backup', { actorId: admin.id, detail: r.name });
    return json(res, 200, { success: true, backup: r, backups: db.listBackups() });
  }
  if (sub === 'download' && req.method === 'GET') {
    if (!requireReauth(req, res)) return;
    const name = str(new URL(req.url, 'http://x').searchParams.get('name'), 200);
    const file = db.resolveBackupPath(name);
    if (!file) return json(res, 404, { error: '找不到這份備份', code: 'NOT_FOUND' });
    audit(req, 'admin_db_download', { actorId: admin.id, detail: name });
    const fs = require('fs');
    const stat = fs.statSync(file);
    res.writeHead(200, Object.assign({
      'Content-Type': 'application/vnd.sqlite3',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Content-Length': stat.size,
      'Cache-Control': 'no-store'
    }, SECURITY_HEADERS));
    fs.createReadStream(file).pipe(res);
    return;
  }
  if (sub === 'restore' && req.method === 'POST') {
    if (!requireReauth(req, res)) return;
    const body = await readJson(req);
    const name = str(body.name, 200);
    try {
      const r = db.restoreBackup(name);
      if (body.clearSessions === true) db.getDb().exec('DELETE FROM sessions');
      db.logEvent('admin_db_restore', { actorId: null, ip: getClientIP(req), detail: `${name} by ${admin.email || admin.username}` });
      Logger.warn('Auth', `Account database restored from backup ${name}`, req);
      return json(res, 200, Object.assign({ success: true }, r));
    } catch (err) {
      return json(res, 400, { error: err.message, code: 'RESTORE_FAILED' });
    }
  }
  return json(res, 404, { error: 'Not found' });
}

// ── 條款頁面 ─────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderLegalPage(res, kind) {
  const legal = db.isAvailable() ? getLegal() : { privacy: '', terms: '', updatedAt: 0 };
  const md = kind === 'privacy' ? legal.privacy : legal.terms;
  const title = kind === 'privacy' ? '隱私權政策' : '使用條款';
  const name = siteName();
  let bodyHtml;
  if (md && md.trim()) {
    const { marked } = require('marked');
    // 內容由管理員撰寫；頁面的 CSP 不允許行內腳本，所以即使貼了 <script> 也不會執行。
    bodyHtml = marked.parse(md);
  } else {
    bodyHtml = `<p>網站管理員尚未提供${title}。</p>`;
  }
  const html = `<!doctype html>
<html lang="zh-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} — ${escapeHtml(name)}</title>
<meta name="robots" content="noindex">
<style>
:root{color-scheme:light dark;--bg:#fafaf7;--fg:#222;--muted:#666;--link:#5b4bd6}
@media (prefers-color-scheme:dark){:root{--bg:#181825;--fg:#ddd;--muted:#999;--link:#a99cff}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.8 -apple-system,"Noto Sans TC","PingFang TC",sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px 64px}
a{color:var(--link)}nav{font-size:14px;margin-bottom:24px}h1{font-size:28px;line-height:1.3}
h2{margin-top:2em;font-size:21px}h3{font-size:18px}table{border-collapse:collapse;width:100%;font-size:15px}
td,th{border:1px solid rgba(128,128,128,.4);padding:6px 8px;vertical-align:top}.muted{color:var(--muted);font-size:14px}
</style></head><body><main>
<nav><a href="/">← 回到 ${escapeHtml(name)}</a> · <a href="/privacy">隱私權政策</a> · <a href="/terms">使用條款</a></nav>
<article>${/^\s*#\s/.test(md || '') ? '' : `<h1>${escapeHtml(title)}</h1>`}${bodyHtml}</article>
${legal.updatedAt ? `<p class="muted">最後更新：${new Date(legal.updatedAt).toISOString().slice(0, 10)}</p>` : ''}
</main></body></html>`;
  const payload = Buffer.from(html, 'utf-8');
  res.writeHead(md && md.trim() ? 200 : 404, Object.assign({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-cache'
  }, SECURITY_HEADERS));
  res.end(payload);
}

// ── 路由 ─────────────────────────────────────────────────────
// 後台路由對照表：測試會檢查每一條都在 app.js 有對應的呼叫（見 tests/test-accounts.test.js）。
const ADMIN_ROUTES = [
  '/api/admin/accounts-overview',
  '/api/admin/users',
  '/api/admin/users/:id',
  '/api/admin/users/:id/status',
  '/api/admin/users/:id/role',
  '/api/admin/users/:id/logout',
  '/api/admin/users/:id/resend-verification',
  '/api/admin/users/:id/send-reset',
  '/api/admin/users/:id/unlink',
  '/api/admin/users/:id/export',
  '/api/admin/registration',
  '/api/admin/invites',
  '/api/admin/invites/:id/revoke',
  '/api/admin/bot-stats',
  '/api/admin/auth-providers',
  '/api/admin/mail',
  '/api/admin/mail/test',
  '/api/admin/mail/dns',
  '/api/admin/mail/settings',
  '/api/admin/turnstile',
  '/api/admin/turnstile/test',
  '/api/admin/turnstile/settings',
  '/api/admin/turnstile/verify',
  '/api/admin/auth-events',
  '/api/admin/lockouts',
  '/api/admin/lockouts/clear',
  '/api/admin/db-backups',
  '/api/admin/db-backups/download',
  '/api/admin/db-backups/restore',
  '/api/admin/legal'
];

const ACCOUNT_ADMIN_PREFIXES = ADMIN_ROUTES.map(r => r.split('/:')[0]);

function isAccountAdminPath(pathname) {
  return ACCOUNT_ADMIN_PREFIXES.some(p => pathname === p || pathname.startsWith(`${p}/`));
}

/** server.js 用來判斷要不要把請求交給 handle()。 */
function isAccountRoute(pathname) {
  return pathname === '/api/health' || pathname === '/privacy' || pathname === '/terms' ||
    pathname === '/api/legal' || pathname === '/api/me' || pathname.startsWith('/api/me/') ||
    pathname.startsWith('/api/auth/') || isAccountAdminPath(pathname);
}

function notAvailable(res) {
  return json(res, 404, {
    error: IS_SINGLE_USER ? '單機模式沒有帳號功能' : '帳號功能目前無法使用',
    code: 'ACCOUNTS_UNAVAILABLE',
    authMode: IS_SINGLE_USER ? 'single-user' : 'admin'
  });
}

/**
 * 處理帳號相關路由。處理了就回傳 true；不是帳號路由就回傳 false，交回 server.js。
 * @param {(req:any)=>any|null} getAdmin 回傳通過管理員驗證的使用者（含同源檢查），否則 null
 */
async function handle(req, res, pathname, query) {
  const method = req.method;

  if (pathname === '/api/health' && (method === 'GET' || method === 'HEAD')) {
    let dbOk = true;
    if (db.isAvailable()) {
      try { db.getDb().prepare('SELECT 1').get(); } catch (_) { dbOk = false; }
    } else if (!IS_SINGLE_USER && db.getOpenError()) {
      dbOk = false;
    }
    json(res, dbOk ? 200 : 503, { ok: dbOk, accounts: db.isAvailable() });
    return true;
  }

  if ((pathname === '/privacy' || pathname === '/terms') && (method === 'GET' || method === 'HEAD')) {
    renderLegalPage(res, pathname.slice(1));
    return true;
  }

  const isAuth = pathname.startsWith('/api/auth/');
  const isMe = pathname === '/api/me' || pathname.startsWith('/api/me/');
  const isLegal = pathname === '/api/legal';
  const isAdmin = pathname.startsWith('/api/admin/') && isAccountAdminPath(pathname);
  if (!isAuth && !isMe && !isLegal && !isAdmin) return false;

  try {
    if (pathname === '/api/auth/config' && method === 'GET') {
      json(res, 200, authConfig());
      return true;
    }
    if (!db.isAvailable()) {
      notAvailable(res);
      return true;
    }
    if (isLegal && method === 'GET') {
      const l = getLegal();
      json(res, 200, { privacy: !!l.privacy.trim(), terms: !!l.terms.trim(), version: l.version, majorVersion: l.majorVersion, updatedAt: l.updatedAt });
      return true;
    }

    // 第三方登入：開始（GET）與回調（Google/Facebook 為 GET，Apple 為跨站 POST）
    const oauthMatch = pathname.match(/^\/api\/auth\/(google|facebook|apple)(\/callback)?$/);
    if (oauthMatch) {
      const provider = oauthMatch[1];
      if (!oauthMatch[2] && method === 'GET') {
        handleOAuthStart(req, res, provider, query);
        return true;
      }
      if (oauthMatch[2] && method === 'GET') {
        await handleOAuthCallback(req, res, provider, query);
        return true;
      }
      if (oauthMatch[2] && method === 'POST' && provider === 'apple') {
        // Apple 送的是表單編碼的跨站 POST：豁免同源與 JSON 檢查，改以 state 比對防偽造。
        const form = await readForm(req);
        await handleOAuthCallback(req, res, provider, form);
        return true;
      }
      json(res, 405, { error: 'Method Not Allowed' });
      return true;
    }

    const mutating = method !== 'GET' && method !== 'HEAD';
    if (mutating && !guardMutation(req, res, { requireJson: method !== 'DELETE' })) return true;

    // 公開的帳號端點
    if (method === 'POST') {
      if (pathname === '/api/auth/register') { await handleRegister(req, res); return true; }
      if (pathname === '/api/auth/login') { await handleLogin(req, res); return true; }
      if (pathname === '/api/auth/logout') { handleLogout(req, res); return true; }
      if (pathname === '/api/auth/verify') { await handleVerify(req, res, 'verify'); return true; }
      if (pathname === '/api/auth/confirm-email') { await handleVerify(req, res, 'change_email'); return true; }
      if (pathname === '/api/auth/resend-verification') { await handleResendVerification(req, res); return true; }
      if (pathname === '/api/auth/reset-request') { await handleResetRequest(req, res); return true; }
      if (pathname === '/api/auth/reset') { await handleReset(req, res); return true; }
    }

    if (pathname === '/api/me' && method === 'GET') {
      const s = session.getSession(req);
      json(res, 200, { user: s ? publicUser(s.user) : null });
      return true;
    }

    const s = session.getSession(req);
    if (!s) {
      json(res, 401, { error: '請先登入', code: 'LOGIN_REQUIRED' });
      return true;
    }

    if (isAuth) {
      if (pathname === '/api/auth/password' && method === 'POST') { await handleChangePassword(req, res, s); return true; }
      if (pathname === '/api/auth/reauth' && method === 'POST') { await handleReauth(req, res, s); return true; }
      if (pathname === '/api/auth/accept-terms' && method === 'POST') { handleAcceptTerms(req, res, s); return true; }
      json(res, 404, { error: 'Not found' });
      return true;
    }

    if (isMe) {
      if (pathname === '/api/me' && method === 'PATCH') { await handleUpdateMe(req, res, s); return true; }
      if (pathname === '/api/me' && method === 'DELETE') { handleDeleteMe(req, res, s); return true; }
      if (pathname === '/api/me/email' && method === 'POST') { await handleChangeEmail(req, res, s); return true; }
      if (pathname === '/api/me/sessions' && method === 'GET') { handleListSessions(req, res, s); return true; }
      if (pathname === '/api/me/sessions' && method === 'DELETE') { handleDeleteSessions(req, res, s, null); return true; }
      const sm = pathname.match(/^\/api\/me\/sessions\/(\d+)$/);
      if (sm && method === 'DELETE') { handleDeleteSessions(req, res, s, parseInt(sm[1], 10)); return true; }
      const im = pathname.match(/^\/api\/me\/identities\/(google|facebook|apple)$/);
      if (im && method === 'DELETE') { handleUnlinkMe(req, res, s, im[1]); return true; }
      if (pathname === '/api/me/export' && method === 'GET') { handleExportMe(req, res, s); return true; }
      json(res, 404, { error: 'Not found' });
      return true;
    }

    // 管理員端點：有效 session 且 role=admin
    if (s.user.role !== 'admin') {
      json(res, 401, { error: 'Unauthorized' });
      return true;
    }
    const admin = s.user;
    if (pathname === '/api/admin/accounts-overview' && method === 'GET') { json(res, 200, overview(admin)); return true; }
    if (pathname === '/api/admin/users' && method === 'GET') {
      const page = Math.max(1, parseInt(query.page, 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 50));
      const r = db.listUsers({ q: str(query.q, 100), status: query.status, role: query.role, provider: str(query.provider, 20), verified: query.verified, limit, offset: (page - 1) * limit });
      json(res, 200, { total: r.total, page, limit, users: r.rows.map(u => Object.assign(u, { has_password: !!u.has_password })) });
      return true;
    }
    const um = pathname.match(/^\/api\/admin\/users\/(\d+)(?:\/([a-z-]+))?$/);
    if (um) {
      const id = parseInt(um[1], 10);
      if (!um[2] && method === 'GET') {
        const u = db.getUserById(id);
        if (!u) json(res, 404, { error: '找不到這位使用者', code: 'NOT_FOUND' });
        else json(res, 200, { user: adminUserView(u) });
        return true;
      }
      if (!um[2] && method === 'DELETE') { await handleAdminUserAction(req, res, admin, id, 'delete'); return true; }
      if (um[2] === 'export' && method === 'GET') { await handleAdminUserAction(req, res, admin, id, 'export'); return true; }
      if (um[2] && method === 'POST') { await handleAdminUserAction(req, res, admin, id, um[2]); return true; }
    }
    if (pathname === '/api/admin/registration') { await handleAdminRegistration(req, res, admin); return true; }
    if (pathname === '/api/admin/invites' && (method === 'GET' || method === 'POST')) { await handleAdminInvites(req, res, admin, null, null); return true; }
    const invm = pathname.match(/^\/api\/admin\/invites\/(\d+)\/revoke$/);
    if (invm && method === 'POST') { await handleAdminInvites(req, res, admin, parseInt(invm[1], 10), 'revoke'); return true; }
    if (pathname === '/api/admin/bot-stats' && method === 'GET') { json(res, 200, botStats()); return true; }
    if (pathname === '/api/admin/auth-providers' && method === 'GET') { json(res, 200, { providers: oauth.getStatus(publicBaseUrl()), publicBaseUrl: publicBaseUrl() || null }); return true; }
    if (pathname === '/api/admin/mail' && method === 'GET') { json(res, 200, mailer.getStatus()); return true; }
    if (pathname === '/api/admin/mail/test' && method === 'POST') { await handleAdminMailTest(req, res, admin); return true; }
    if (pathname === '/api/admin/mail/dns' && method === 'GET') { json(res, 200, await mailer.checkDns()); return true; }
    if (pathname === '/api/admin/mail/settings' && method === 'POST') { await handleAdminMailSettings(req, res, admin); return true; }
    if (pathname === '/api/admin/turnstile' && method === 'GET') { json(res, 200, turnstileInfo()); return true; }
    if (pathname === '/api/admin/turnstile/settings' && method === 'POST') { await handleAdminTurnstileSettings(req, res, admin); return true; }
    if (pathname === '/api/admin/turnstile/verify' && method === 'POST') { await handleAdminTurnstileVerify(req, res, admin); return true; }
    if (pathname === '/api/admin/turnstile/test' && method === 'POST') {
      const result = await turnstile.checkSecret();
      audit(req, 'admin_turnstile_check', { actorId: admin.id, detail: result.state });
      json(res, 200, Object.assign({ info: turnstileInfo() }, result));
      return true;
    }
    if (pathname === '/api/admin/auth-events' && method === 'GET') {
      json(res, 200, { events: db.listEvents({ userId: parseInt(query.user, 10) || null, ip: str(query.ip, 60), event: str(query.event, 60), limit: parseInt(query.limit, 10) || 100, before: parseInt(query.before, 10) || null }) });
      return true;
    }
    if (pathname === '/api/admin/lockouts' && method === 'GET') { json(res, 200, lockouts()); return true; }
    if (pathname === '/api/admin/lockouts/clear' && method === 'POST') { await handleAdminLockoutsClear(req, res, admin); return true; }
    const bm = pathname.match(/^\/api\/admin\/db-backups(?:\/(download|restore))?$/);
    if (bm) { await handleAdminDbBackups(req, res, admin, bm[1] || ''); return true; }
    if (pathname === '/api/admin/legal' && (method === 'GET' || method === 'POST')) { await handleAdminLegal(req, res, admin); return true; }
    json(res, 404, { error: 'Not found' });
    return true;
  } catch (err) {
    if (err && err.status === 413) {
      if (!res.headersSent) json(res, 413, { error: 'Payload too large' });
      return true;
    }
    Logger.error('Auth', `Account request failed: ${req.method} ${pathname}`, err, req);
    if (!res.headersSent) json(res, 500, { error: 'Internal Server Error' });
    return true;
  }
}

/**
 * 首次設定：建立第一位管理員並直接登入。呼叫端（server.js）已驗過一次性設定碼。
 * 回傳 { status, body }；成功時 body 另附 token（給舊版用 X-Admin-Token 的工具）。
 */
async function setupFirstAdmin(req, res, { username, email, password }) {
  if (!db.isAvailable()) return { status: 503, body: { error: '帳號資料庫無法使用，請查看伺服器日誌', code: 'ACCOUNTS_UNAVAILABLE' } };
  if (hasAdmin()) return { status: 400, body: { error: 'Admin already configured' } };
  const name = str(username, 100).trim();
  const mail = db.normalizeEmail(str(email, 300));
  if (!name && !mail) return { status: 400, body: { error: 'Username and password are required' } };
  if (mail && !isValidEmail(mail)) return { status: 400, body: { error: '請輸入有效的 Email', field: 'email' } };
  const pwError = passwords.validatePassword(typeof password === 'string' ? password : '');
  if (pwError) return { status: 400, body: { error: pwError, field: 'password' } };
  if ((name && db.getUserByUsername(name)) || (mail && db.getUserByEmail(mail))) {
    return { status: 400, body: { error: '這個帳號名稱或 Email 已被使用' } };
  }
  const user = db.createUser({
    email: mail || null,
    username: name || null,
    emailVerifiedAt: mail ? Date.now() : null,
    displayName: name || mail.split('@')[0],
    passwordHash: await passwords.hashPassword(password),
    role: 'admin',
    signupIp: getClientIP(req)
  });
  audit(req, 'admin_setup', { userId: user.id });
  const token = session.startSession(req, res, user);
  return { status: 200, body: { success: true, token, user: publicUser(user) } };
}

/** 啟動時呼叫：開資料庫、搬舊管理員、啟動例行維護。失敗時回傳錯誤（不丟出）。 */
function init() {
  if (IS_SINGLE_USER) return null;
  try {
    db.open();
    if (!db.isAvailable()) return db.getOpenError();
    migrateLegacyAdmin();
    db.startMaintenance();
    return null;
  } catch (err) {
    return err;
  }
}

module.exports = {
  init,
  handle,
  isAccountRoute,
  ADMIN_ROUTES,
  MAX_ATTEMPTS,
  accountAttempts,
  ipFailures,
  hasAdmin,
  migrateLegacyAdmin,
  publicUser,
  publicBaseUrl,
  handleLegacyAdminLogin,
  setupFirstAdmin,
  handleChangePassword,
  handleLogout,
  isSameOriginStrict,
  authConfig,
  getLegal,
  _counters: { registerByIp, signupsGlobal, mailByAddress, mailByIp }
};
