/**
 * @file lib/integrations.js — 寄信與 Turnstile 的設定來源
 *
 * 每個設定項有兩個來源，環境變數優先：
 *   1. 環境變數（.env、docker compose）— 有值就用，後台顯示「由環境變數設定」且不能改
 *   2. 後台網頁填寫 — 存在帳號資料庫的 app_settings
 * 兩邊都沒有就是未設定。這樣第一次架站的人可以全部在網頁上完成，
 * 已經用 .env 部署的站台行為不變。
 *
 * 金鑰類（Resend API 金鑰、Turnstile secret）以 AES-256-GCM 加密後才寫進資料庫，
 * 加密金鑰是資料庫旁邊的 secrets.key（權限 600，第一次儲存時產生）。下載的資料庫備份
 * 因此不含可用的金鑰；搬到別台機器時若沒有一起搬 secrets.key，只要在後台重新填一次。
 * 金鑰只寫不讀：API 只回報有沒有設定與末四碼。
 * 第三方登入（Google、Facebook、Apple）的金鑰也走同一套；各家的開關另存在 oauth.<provider>.enabled。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FIELDS = {
  mailProvider: { env: 'MAIL_PROVIDER', key: 'integrations.mail.provider', secret: false },
  mailApiKey: { env: 'MAIL_API_KEY', key: 'integrations.mail.apiKey', secret: true },
  mailFrom: { env: 'MAIL_FROM', key: 'integrations.mail.from', secret: false },
  turnstileSiteKey: { env: 'TURNSTILE_SITE_KEY', key: 'integrations.turnstile.siteKey', secret: false },
  turnstileSecret: { env: 'TURNSTILE_SECRET_KEY', key: 'integrations.turnstile.secret', secret: true },
  googleClientId: { env: 'GOOGLE_CLIENT_ID', key: 'integrations.google.clientId', secret: false },
  googleClientSecret: { env: 'GOOGLE_CLIENT_SECRET', key: 'integrations.google.clientSecret', secret: true },
  facebookAppId: { env: 'FACEBOOK_APP_ID', key: 'integrations.facebook.appId', secret: false },
  facebookAppSecret: { env: 'FACEBOOK_APP_SECRET', key: 'integrations.facebook.appSecret', secret: true },
  appleClientId: { env: 'APPLE_CLIENT_ID', key: 'integrations.apple.clientId', secret: false },
  appleTeamId: { env: 'APPLE_TEAM_ID', key: 'integrations.apple.teamId', secret: false },
  appleKeyId: { env: 'APPLE_KEY_ID', key: 'integrations.apple.keyId', secret: false },
  // .p8 私鑰的內容（PEM 文字）；既有的 APPLE_PRIVATE_KEY_PATH（檔案路徑）仍然支援，見 lib/oauth.js
  applePrivateKey: { env: 'APPLE_PRIVATE_KEY', key: 'integrations.apple.privateKey', secret: true, noMask: true }
};

const KEY_FILE_NAME = 'secrets.key';
let memoryKey = null; // 記憶體資料庫（測試）用，不落地

function db() {
  return require('./db');
}

function dbReady() {
  try { return db().isAvailable(); } catch (_) { return false; }
}

function keyFilePath() {
  const dir = db().getDataDir();
  return dir ? path.join(dir, KEY_FILE_NAME) : null;
}

/** 取得加密金鑰；create=false 時找不到就回傳 null（讀取時不要憑空產生新金鑰）。 */
function getCipherKey(create) {
  const file = keyFilePath();
  if (!file) {
    if (!memoryKey && create) memoryKey = crypto.randomBytes(32);
    return memoryKey;
  }
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    const buf = Buffer.from(raw, 'base64');
    if (buf.length === 32) return buf;
  } catch (_) { /* 還沒有金鑰檔 */ }
  if (!create) return null;
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, key.toString('base64') + '\n', { mode: 0o600, flag: 'w' });
  try { fs.chmodSync(file, 0o600); } catch (_) {}
  return key;
}

function encrypt(plain) {
  const key = getCipherKey(true);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${data.toString('base64')}`;
}

/** 解不開（金鑰檔遺失或不符）時回傳 null。 */
function decrypt(stored) {
  const parts = String(stored).split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  const key = getCipherKey(false);
  if (!key) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64'));
    d.setAuthTag(Buffer.from(parts[2], 'base64'));
    return Buffer.concat([d.update(Buffer.from(parts[3], 'base64')), d.final()]).toString('utf8');
  } catch (_) {
    return null;
  }
}

function envValue(name) {
  return (process.env[FIELDS[name].env] || '').trim();
}

/** 網頁填寫的值；{ value, unreadable } */
function storedValue(name) {
  if (!dbReady()) return { value: '', unreadable: false };
  const f = FIELDS[name];
  const raw = db().getSetting(f.key);
  if (raw === null || raw === '') return { value: '', unreadable: false };
  if (!f.secret) return { value: raw, unreadable: false };
  const plain = decrypt(raw);
  return plain === null ? { value: '', unreadable: true } : { value: plain, unreadable: false };
}

/** 實際生效的值：環境變數優先，其次是網頁填寫。 */
function get(name) {
  return envValue(name) || storedValue(name).value;
}

function source(name) {
  if (envValue(name)) return 'env';
  if (storedValue(name).value) return 'web';
  return null;
}

function mask(value) {
  if (!value) return null;
  return value.length <= 8 ? '••••' : `••••${value.slice(-4)}`;
}

/** 後台顯示用：非金鑰項目回傳值，金鑰只回傳末四碼。 */
function describe(name) {
  const f = FIELDS[name];
  const stored = storedValue(name);
  const value = get(name);
  return {
    env: f.env,
    source: source(name),
    set: !!value,
    value: f.secret ? null : (value || null),
    masked: f.secret ? (f.noMask ? (value ? '••••' : null) : mask(value)) : null,
    locked: !!envValue(name),
    unreadable: stored.unreadable && !envValue(name)
  };
}

/**
 * 寫入網頁設定。value 為 '' 表示清除；環境變數已設定的項目不能從網頁改。
 * @returns {string[]} 實際寫入的欄位
 */
function set(updates) {
  if (!dbReady()) throw Object.assign(new Error('帳號資料庫無法使用，不能儲存設定'), { code: 'DB_UNAVAILABLE' });
  const changed = [];
  for (const [name, value] of Object.entries(updates)) {
    const f = FIELDS[name];
    if (!f || value === undefined) continue;
    if (envValue(name)) continue;
    const v = String(value).trim();
    db().setSetting(f.key, v ? (f.secret ? encrypt(v) : v) : '');
    changed.push(name);
  }
  return changed;
}

/** 登入方式的開關：沒設定過視為開啟（金鑰齊全就能用，和以前的行為一致）。 */
function isProviderEnabled(provider) {
  if (!dbReady()) return true;
  return db().getSetting(`oauth.${provider}.enabled`) !== '0';
}

function setProviderEnabled(provider, enabled) {
  if (!dbReady()) throw Object.assign(new Error('帳號資料庫無法使用，不能儲存設定'), { code: 'DB_UNAVAILABLE' });
  db().setSetting(`oauth.${provider}.enabled`, enabled ? '1' : '0');
}

module.exports = { FIELDS, get, source, describe, set, mask, isProviderEnabled, setProviderEnabled, _encrypt: encrypt, _decrypt: decrypt };
