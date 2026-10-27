/**
 * @file lib/password.js — 密碼雜湊（scrypt）與舊格式相容
 *
 * 儲存格式：`$scrypt$ln=17,r=8,p=1$<salt b64>$<hash b64>`，參數跟著雜湊走，
 * 將來調高 N 時舊密碼仍可驗證。舊管理員的 PBKDF2 雜湊搬進資料庫時存成
 * `$pbkdf2-sha512$i=<次數>$<salt>$<hash hex>`（salt 為原本的 hex 字串），
 * 驗證成功後由呼叫端用 needsRehash() 判斷是否改存 scrypt。
 *
 * - 先做 Unicode NFC 正規化，避免不同裝置輸入的同一中文字編碼不同。
 * - 長度 8–256 字；上限防止故意送超長密碼耗資源。
 * - 同時最多 2 個雜湊在跑（各約 128 MiB），避免登入洪水吃光記憶體、拖慢讀檔。
 */

const crypto = require('crypto');

// `node --test` 底下降低成本，讓測試不必每次花數百毫秒與 128 MiB。
const IS_TEST_RUN = !!process.env.NODE_TEST_CONTEXT;
const DEFAULT_LN = (() => {
  const fromEnv = parseInt(process.env.SCRYPT_LN || '', 10);
  if (Number.isInteger(fromEnv) && fromEnv >= 10 && fromEnv <= 20) return fromEnv;
  return IS_TEST_RUN ? 12 : 17;
})();
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 32;
const SALT_BYTES = 16;
const MAXMEM = 256 * 1024 * 1024;

const MIN_LENGTH = 8;
const MAX_LENGTH = 256;
const MAX_CONCURRENT = 2;

let running = 0;
const queue = [];

function withSlot(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      running++;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => {
        running--;
        const next = queue.shift();
        if (next) next();
      });
    };
    if (running < MAX_CONCURRENT) run();
    else queue.push(run);
  });
}

function normalizePassword(password) {
  return typeof password === 'string' ? password.normalize('NFC') : '';
}

/** 回傳錯誤訊息；合格時回傳 null。 */
function validatePassword(password) {
  if (typeof password !== 'string' || !password) return '請輸入密碼';
  const p = normalizePassword(password);
  if ([...p].length < MIN_LENGTH) return `密碼至少需要 ${MIN_LENGTH} 個字元`;
  if ([...p].length > MAX_LENGTH) return `密碼不能超過 ${MAX_LENGTH} 個字元`;
  return null;
}

function scryptAsync(password, salt, ln) {
  const N = 2 ** ln;
  return withSlot(() => new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEYLEN, { N, r: SCRYPT_R, p: SCRYPT_P, maxmem: MAXMEM }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  }));
}

function pbkdf2Async(password, salt, iterations) {
  return withSlot(() => new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, iterations, 64, 'sha512', (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  }));
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await scryptAsync(normalizePassword(password), salt, DEFAULT_LN);
  return `$scrypt$ln=${DEFAULT_LN},r=${SCRYPT_R},p=${SCRYPT_P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** 把 config.json 舊管理員的 PBKDF2 憑證轉成可存進資料庫的字串。 */
function legacyPbkdf2Hash(admin, iterations = 100000) {
  if (!admin || !admin.salt || !admin.passwordHash) return null;
  return `$pbkdf2-sha512$i=${iterations}$${admin.salt}$${admin.passwordHash}`;
}

function parseHash(stored) {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  // ['', 'scrypt', 'ln=17,r=8,p=1', salt, hash]
  if (parts.length !== 5 || parts[0] !== '') return null;
  const [, alg, paramStr, salt, hash] = parts;
  const params = {};
  for (const kv of paramStr.split(',')) {
    const [k, v] = kv.split('=');
    params[k] = parseInt(v, 10);
  }
  return { alg, params, salt, hash };
}

function safeEqual(a, b) {
  if (a.length !== b.length) {
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

// 帳號不存在時也對一組假雜湊跑一次，讓回應時間一致，不洩露帳號是否存在。
let dummyHash = null;
async function getDummyHash() {
  if (!dummyHash) dummyHash = await hashPassword(crypto.randomBytes(12).toString('hex'));
  return dummyHash;
}

/**
 * 驗證密碼。stored 為 null（帳號不存在或只用第三方登入）時仍跑一次假雜湊並回傳 false。
 * PBKDF2 舊格式在 100,000 次失敗時另試 1,000 次（最早期版本）。
 */
async function verifyPassword(password, stored) {
  const pw = normalizePassword(password);
  const parsed = parseHash(stored);
  if (!parsed || !pw) {
    const dummy = parseHash(await getDummyHash());
    await scryptAsync(pw || 'x', Buffer.from(dummy.salt, 'base64'), dummy.params.ln);
    return false;
  }
  if (parsed.alg === 'scrypt') {
    const ln = parsed.params.ln;
    if (!Number.isInteger(ln) || ln < 1 || ln > 22) return false;
    const key = await scryptAsync(pw, Buffer.from(parsed.salt, 'base64'), ln);
    return safeEqual(key, Buffer.from(parsed.hash, 'base64'));
  }
  if (parsed.alg === 'pbkdf2-sha512') {
    const expected = Buffer.from(parsed.hash, 'hex');
    // 舊程式以 hex 字串本身當 salt（未解碼），密碼也未做 NFC，這裡照原樣沿用。
    const raw = typeof password === 'string' ? password : '';
    const key = await pbkdf2Async(raw, parsed.salt, parsed.params.i || 100000);
    if (safeEqual(key, expected)) return true;
    if ((parsed.params.i || 100000) !== 1000) {
      const legacy = await pbkdf2Async(raw, parsed.salt, 1000);
      return safeEqual(legacy, expected);
    }
    return false;
  }
  return false;
}

/** 演算法是 PBKDF2，或 scrypt 參數低於現行值時回傳 true。 */
function needsRehash(stored) {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  if (parsed.alg !== 'scrypt') return true;
  return (parsed.params.ln || 0) < DEFAULT_LN || parsed.params.r !== SCRYPT_R || parsed.params.p !== SCRYPT_P;
}

module.exports = {
  hashPassword,
  verifyPassword,
  needsRehash,
  validatePassword,
  legacyPbkdf2Hash,
  parseHash,
  MIN_LENGTH,
  MAX_LENGTH,
  DEFAULT_LN
};
