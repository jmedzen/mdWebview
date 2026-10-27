/**
 * @file lib/mailer.js — 寄送帳號信件（驗證、重設密碼、變更 Email、通知）
 *
 * 只用 Node 內建 fetch 呼叫寄信服務的 HTTP API，不加依賴。
 *   MAIL_PROVIDER=resend  — Resend（https://api.resend.com/emails），MAIL_API_KEY 為 API 金鑰
 *   MAIL_PROVIDER=log     — 不寄信，把信件內容（含連結）寫進日誌；本機測試與 CI 用
 *   未設定                — 停用寄信；需要寄信的功能（註冊、忘記密碼）暫停
 * MAIL_FROM 例如 `mdWebview <noreply@example.org>`。金鑰只放環境變數，後台只顯示是否已設定。
 */

const { MAX_LOG_BUFFER } = require('./constants');

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
  const p = (process.env.MAIL_PROVIDER || '').trim().toLowerCase();
  if (p === 'resend' || p === 'log') return p;
  if (!p && process.env.NODE_TEST_CONTEXT) return 'log';
  return '';
}

function getFrom() {
  return (process.env.MAIL_FROM || '').trim();
}

function isConfigured() {
  const provider = getProvider();
  if (provider === 'log') return true;
  if (provider === 'resend') return !!(process.env.MAIL_API_KEY || '').trim() && !!getFrom();
  return false;
}

function getStatus() {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  return {
    provider: getProvider() || null,
    from: getFrom() || null,
    apiKeySet: !!(process.env.MAIL_API_KEY || '').trim(),
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
    const key = (process.env.MAIL_API_KEY || '').trim();
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

/** 測試與 log 模式用：取最近寄給某人的信。 */
function getOutbox(to = null) {
  return to ? outbox.filter(m => m.to === to) : outbox.slice();
}

function clearOutbox() {
  outbox.length = 0;
}

module.exports = {
  getProvider,
  isConfigured,
  getStatus,
  renderMail,
  send,
  getOutbox,
  clearOutbox
};
