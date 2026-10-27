/**
 * @file lib/mailer.js — 寄送帳號信件（驗證、重設密碼、變更 Email、通知）
 *
 * 只用 Node 內建 fetch 呼叫寄信服務的 HTTP API，不加依賴。
 *   MAIL_PROVIDER=resend  — Resend（https://api.resend.com/emails），MAIL_API_KEY 為 API 金鑰
 *   MAIL_PROVIDER=log     — 不寄信，把信件內容（含連結）寫進日誌；本機測試與 CI 用
 *   未設定                — 停用寄信；需要寄信的功能（註冊、忘記密碼）暫停
 * MAIL_FROM 例如 `mdWebview <noreply@example.org>`。
 * 三個值都可以在後台網頁填寫（見 lib/integrations.js），環境變數有設定時優先。
 */

const dns = require('dns');
const { MAX_LOG_BUFFER } = require('./constants');
const integrations = require('./integrations');

const SEND_TIMEOUT_MS = 10000;
const outbox = []; // 最近寄出的信（log 模式與測試用），不含 API 金鑰
const OUTBOX_MAX = 50;
const failures = []; // 最近的寄送失敗時間戳

let logger = null;
function getLogger() {
  if (!logger) logger = require('./logger').Logger;
  return logger;
}

function getProvider() {
  const p = integrations.get('mailProvider').toLowerCase();
  if (p === 'resend' || p === 'log') return p;
  if (!p && process.env.NODE_TEST_CONTEXT) return 'log';
  return '';
}

function getFrom() {
  return integrations.get('mailFrom');
}

function getApiKey() {
  return integrations.get('mailApiKey');
}

function isConfigured() {
  const provider = getProvider();
  if (provider === 'log') return true;
  if (provider === 'resend') return !!getApiKey() && !!getFrom();
  return false;
}

/** 寄件人 `名稱 <a@example.org>` 或 `a@example.org` → { name, address, domain }；格式不對回傳 null。 */
function parseFrom(from) {
  const m = String(from || '').trim().match(/^(?:(.*?)\s*<\s*([^\s<>@]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,}))\s*>|([^\s<>@]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})))$/);
  if (!m) return null;
  return m[2]
    ? { name: m[1].replace(/^"|"$/g, '').trim(), address: m[2], domain: m[3].toLowerCase() }
    : { name: '', address: m[4], domain: m[5].toLowerCase() };
}

/** MAIL_FROM 的寄件網域。 */
function getSenderDomain() {
  const p = parseFrom(getFrom());
  return p ? p.domain : '';
}

/** 設定不完整時缺哪些項目（以環境變數名稱表示；也可以在後台網頁填寫）。 */
function getMissingEnv() {
  const provider = getProvider();
  if (provider === 'log') return [];
  const missing = [];
  if (!provider) missing.push('MAIL_PROVIDER');
  if (provider === 'resend' || !provider) {
    if (!getApiKey()) missing.push('MAIL_API_KEY');
    if (!getFrom()) missing.push('MAIL_FROM');
  }
  return missing;
}

function getStatus() {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  return {
    provider: getProvider() || null,
    from: getFrom() || null,
    senderDomain: getSenderDomain() || null,
    missingEnv: getMissingEnv(),
    apiKeySet: !!getApiKey(),
    settings: {
      provider: integrations.describe('mailProvider'),
      apiKey: integrations.describe('mailApiKey'),
      from: integrations.describe('mailFrom')
    },
    configured: isConfigured(),
    failures24h: failures.filter(t => t >= since).length,
    lastSentAt: outbox.length ? outbox[outbox.length - 1].at : null
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 簡單的信件版型：一段說明、一個按鈕、備用的純文字連結。 */
function renderMail({ siteName, heading, paragraphs = [], actionLabel = '', actionUrl = '', footer = '' }) {
  const text = [heading, '', ...paragraphs, '', actionUrl ? `${actionLabel}：${actionUrl}` : '', '', footer, '', `— ${siteName}`]
    .filter((line, i, arr) => !(line === '' && arr[i - 1] === ''))
    .join('\n');
  const html = `<!doctype html><html><body style="font-family:-apple-system,'Noto Sans TC',sans-serif;line-height:1.7;color:#222;max-width:560px;margin:0 auto;padding:24px">
<h2 style="font-size:20px;margin:0 0 16px">${escapeHtml(heading)}</h2>
${paragraphs.map(p => `<p style="margin:0 0 12px">${escapeHtml(p)}</p>`).join('\n')}
${actionUrl ? `<p style="margin:24px 0"><a href="${escapeHtml(actionUrl)}" style="background:#6c5ce7;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block">${escapeHtml(actionLabel)}</a></p>
<p style="font-size:13px;color:#666;word-break:break-all">如果按鈕無法使用，請複製這個網址到瀏覽器：<br>${escapeHtml(actionUrl)}</p>` : ''}
${footer ? `<p style="font-size:13px;color:#666;margin-top:24px">${escapeHtml(footer)}</p>` : ''}
<p style="font-size:13px;color:#999;margin-top:24px">— ${escapeHtml(siteName)}</p>
</body></html>`;
  return { text, html };
}

function remember(entry) {
  outbox.push(entry);
  if (outbox.length > OUTBOX_MAX) outbox.splice(0, outbox.length - OUTBOX_MAX);
}

function recordFailure() {
  const t = Date.now();
  failures.push(t);
  const cutoff = t - 24 * 60 * 60 * 1000;
  while (failures.length && failures[0] < cutoff) failures.shift();
  if (failures.length > MAX_LOG_BUFFER) failures.splice(0, failures.length - MAX_LOG_BUFFER);
}

/**
 * 寄一封信。回傳 { ok, id?, error? }；永不丟出例外，呼叫端依 ok 決定回應。
 * @param {{to:string, subject:string, text:string, html:string, tag?:string}} mail
 */
async function send(mail) {
  const provider = getProvider();
  const entry = { to: mail.to, subject: mail.subject, text: mail.text, tag: mail.tag || '', at: Date.now() };
  if (provider === 'log') {
    remember(entry);
    getLogger().info('Mail', `[log] To: ${mail.to} | ${mail.subject}\n${mail.text}`);
    return { ok: true, id: `log-${entry.at}` };
  }
  if (provider === 'resend') {
    const key = getApiKey();
    const from = getFrom();
    if (!key || !from) {
      recordFailure();
      return { ok: false, error: 'mail_not_configured' };
    }
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': `${mail.tag || 'mail'}-${mail.to}-${entry.at}`.slice(0, 256)
        },
        body: JSON.stringify({ from, to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        recordFailure();
        getLogger().warn('Mail', `Resend rejected mail "${mail.tag || mail.subject}" (${res.status}): ${String(data && data.message || '').slice(0, 200)}`);
        return { ok: false, error: `provider_${res.status}` };
      }
      remember(Object.assign(entry, { text: '[sent]' }));
      return { ok: true, id: data && data.id };
    } catch (err) {
      recordFailure();
      getLogger().warn('Mail', `Mail send failed: ${err.message}`);
      return { ok: false, error: 'network' };
    }
  }
  recordFailure();
  return { ok: false, error: 'mail_disabled' };
}

// ── Resend 金鑰檢查 ─────────────────────────────────────────
// 用 GET /domains 判斷：完整權限的金鑰會回網域清單（順便看驗證狀態）；
// 只能寄信的金鑰回 401 restricted_api_key（金鑰有效，這也是建議的權限）；其他 401／403 表示金鑰錯誤。
const RESEND_API = 'https://api.resend.com';
const CHECK_TIMEOUT_MS = 8000;

/** @returns {Promise<{state:'valid'|'valid_send_only'|'invalid'|'unreachable', domains?:Array, detail?:string}>} */
async function checkResendKey(key) {
  if (!key) return { state: 'invalid', detail: 'empty' };
  try {
    const res = await fetch(`${RESEND_API}/domains`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS)
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      const list = Array.isArray(data && data.data) ? data.data : [];
      return { state: 'valid', domains: list.slice(0, 20).map(d => ({ name: String(d.name || ''), status: String(d.status || ''), region: String(d.region || '') })) };
    }
    if (res.status === 401 && data && data.name === 'restricted_api_key') return { state: 'valid_send_only' };
    if (res.status === 401 || res.status === 403 || res.status === 400) return { state: 'invalid', detail: String(data && data.message || '').slice(0, 200) };
    return { state: 'unreachable', detail: `http-${res.status}` };
  } catch (err) {
    return { state: 'unreachable', detail: err && err.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
}

// ── 寄件網域的 DNS 檢查 ─────────────────────────────────────
// Resend 的記錄依帳號與建立時間有兩種樣子，只寄信（Sending only）時都不需要 MX：
//   新版：`resend._domainkey` TXT（DKIM），加上 `send`、`rsend` 兩筆 CNAME 指向 *.rmta.net。
//   舊版：`resend._domainkey` TXT（DKIM），加上 `send` 的 SPF TXT（include:amazonses.com）與退信 MX。
// 所以必要的只有兩項：DKIM、「寄信授權」（send 子網域有上述任一種記錄）。MX 只有要用 Resend 收信才需要，不檢查。
// 另建議 `_dmarc`（沒有的話 Gmail、Yahoo 等收件端更容易把信放進垃圾郵件匣）。
// DNS 只讀公開記錄；金鑰若有完整權限，另外向 Resend 查這個網域的驗證狀態（寄信專用金鑰查不到）。
const DNS_TIMEOUT_MS = 4000;

function makeResolver() {
  const r = new dns.promises.Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
  return r;
}

async function lookupTxt(resolver, name) {
  try {
    const rows = await resolver.resolveTxt(name);
    return { ok: true, values: rows.map(parts => parts.join('')) };
  } catch (err) {
    return { ok: false, values: [], code: err && err.code };
  }
}

async function lookupCname(resolver, name) {
  try {
    const rows = await resolver.resolveCname(name);
    return { ok: true, values: rows.map(v => String(v).toLowerCase()) };
  } catch (err) {
    return { ok: false, values: [], code: err && err.code };
  }
}

const RESEND_CNAME_TARGET = /(?:\.rmta\.net|\.amazonses\.com)\.?$/i;

/** 回傳 { domain, checkedAt, records: [{ id, label, name, type, required, ok, found, hint }], resend } */
async function checkDns() {
  const domain = getSenderDomain();
  if (!domain) return { domain: null, checkedAt: Date.now(), records: [], error: 'no_sender_domain' };
  const resolver = makeResolver();
  const send = `send.${domain}`;
  const rsend = `rsend.${domain}`;
  const key = getProvider() === 'resend' ? getApiKey() : '';
  const [sendCname, sendTxt, rsendCname, dkim, dmarc, resendCheck] = await Promise.all([
    lookupCname(resolver, send),
    lookupTxt(resolver, send),
    lookupCname(resolver, rsend),
    lookupTxt(resolver, `resend._domainkey.${domain}`),
    lookupTxt(resolver, `_dmarc.${domain}`),
    key ? checkResendKey(key) : Promise.resolve(null)
  ]);
  const sendByCname = sendCname.values.some(v => RESEND_CNAME_TARGET.test(v));
  const sendBySpf = sendTxt.values.some(v => /^v=spf1\b/i.test(v) && /amazonses\.com/i.test(v));
  const records = [
    {
      id: 'dkim', label: 'DKIM（簽章）', name: `resend._domainkey.${domain}`, type: 'TXT', required: true,
      ok: dkim.values.some(v => /\bp=[A-Za-z0-9+/=]{20,}/.test(v)),
      found: dkim.values.map(v => `${v.slice(0, 48)}…`),
      hint: '值以 p= 開頭，從 Resend 的 Domains 頁面複製'
    },
    {
      id: 'send', label: '寄信授權（SPF）', name: send, type: 'CNAME 或 TXT', required: true,
      ok: sendByCname || sendBySpf,
      found: [...sendCname.values.map(v => `CNAME ${v}`), ...sendTxt.values.map(v => `TXT ${v}`)],
      hint: '照 Resend 的 Domains 頁面新增：新版是 send、rsend 兩筆 CNAME（指向 *.rmta.net），舊版是 send 的 TXT（v=spf1 include:amazonses.com ~all）。只寄信的話不需要 MX'
    },
    {
      id: 'dmarc', label: 'DMARC', name: `_dmarc.${domain}`, type: 'TXT', required: false,
      ok: dmarc.values.some(v => /^v=DMARC1\b/i.test(v)),
      found: dmarc.values,
      hint: '建議值 v=DMARC1; p=none;（先觀察，不影響寄信）'
    }
  ];
  // 新版要兩筆 CNAME 才完整：send 有、rsend 沒有時提醒，但不擋（以 Resend 回報的狀態為準）。
  const note = sendByCname && !rsendCname.values.some(v => RESEND_CNAME_TARGET.test(v))
    ? `找不到 ${rsend} 的 CNAME，Resend 的 Domains 頁面若列了這一筆，也請一併新增`
    : '';
  let resend = null;
  if (resendCheck) {
    if (resendCheck.state === 'valid') {
      const d = resendCheck.domains.find(x => x.name.toLowerCase() === domain);
      resend = { state: d ? 'known' : 'domain_missing', domainStatus: d ? d.status : null };
    } else {
      resend = { state: resendCheck.state === 'valid_send_only' ? 'send_only' : resendCheck.state, domainStatus: null };
    }
  }
  return { domain, checkedAt: Date.now(), records, note, resend };
}

/** 測試與 log 模式用：取最近寄給某人的信。 */
function getOutbox(to = null) {
  return to ? outbox.filter(m => m.to === to) : outbox.slice();
}

function clearOutbox() {
  outbox.length = 0;
}

module.exports = {
  getProvider,
  getSenderDomain,
  parseFrom,
  checkResendKey,
  isConfigured,
  getStatus,
  checkDns,
  renderMail,
  send,
  getOutbox,
  clearOutbox
};
