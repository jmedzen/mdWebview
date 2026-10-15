/**
 * @file lib/logger.js — System Logger and In-Memory Buffer
 */

const net = require('net');
const { MAX_LOG_BUFFER, IS_SINGLE_USER } = require('./constants');
const { getClientIP, getCrawlerName } = require('./utils');
const { appendToPersistentLog, queueAnalyticsStoreEntry, getAnalyticsEventId, setInMemoryLogBufferRef, assignAnalyticsEventSeq } = require('./analytics');

const systemLogBuffer = [];
setInMemoryLogBufferRef(systemLogBuffer);

function safeDecodeURI(str) {
  if (typeof str !== 'string' || !str.includes('%')) return str;
  try {
    return decodeURIComponent(str);
  } catch (_) {
    return str.replace(/(?:%[0-9A-Fa-f]{2})+/g, (match) => {
      try {
        return decodeURIComponent(match);
      } catch (_) {
        return match;
      }
    });
  }
}

function safeDecodeURIComponent(str) {
  if (typeof str !== 'string') return str;
  try {
    return decodeURIComponent(str);
  } catch (_) {
    return str;
  }
}

function extractIpFromParam(reqOrIp) {
  if (!reqOrIp) return '127.0.0.1';
  if (typeof reqOrIp === 'string') {
    const clean = reqOrIp.startsWith('::ffff:') ? reqOrIp.substring(7) : reqOrIp;
    return net.isIP(clean) ? clean.substring(0, 45) : '127.0.0.1';
  }
  if (typeof reqOrIp === 'object' && (reqOrIp.headers || reqOrIp.socket)) {
    return getClientIP(reqOrIp);
  }
  return '127.0.0.1';
}

/**
 * 寫入一筆結構化日誌（記憶體緩衝、jsonl 檔、分析聚合）。
 * 這裡是唯一的 URL 解碼點；Logger.info/warn/debug/error 一律傳入原始訊息字串，
 * 由本函式單次解碼，避免 `%2520` 被解碼兩次而破壞結構化欄位。
 * @param {string} level
 * @param {string} tag
 * @param {string|object} msg
 * @param {object|string} [reqOrIp]
 * @param {object} [extra]
 */
function pushToLogBuffer(level, tag, msg, reqOrIp = '127.0.0.1', extra = {}) {
  let messageStr = (typeof msg === 'object' && msg !== null) ? (msg.stack || msg.message || JSON.stringify(msg)) : String(msg);
  messageStr = safeDecodeURI(messageStr);

  if (messageStr.length > 2000) {
    messageStr = messageStr.substring(0, 2000) + '… [truncated]';
  }

  const clientIp = extractIpFromParam(reqOrIp);
  const crawlerName = (extra && extra.bot) || (reqOrIp && typeof reqOrIp === 'object' && reqOrIp.headers ? getCrawlerName(reqOrIp, extra.queryObj || null) : null);
  const isBot = Boolean(extra && extra.isBot !== undefined ? extra.isBot : crawlerName);

  let safePath = extra.path;
  if (safePath && typeof safePath === 'string' && safePath.length > 500) {
    safePath = safePath.substring(0, 500) + '…';
  }

  // query 超過 300 字元時比照 message/path 加上省略標記，避免靜默截斷造成分析資料落差。
  let safeQuery = extra.query;
  if (safeQuery && typeof safeQuery === 'string' && safeQuery.length > 300) {
    safeQuery = safeQuery.substring(0, 300) + '…';
  }

  const entry = {
    id: '',
    timestamp: new Date().toISOString(),
    level,
    tag,
    ip: clientIp,
    message: messageStr,
    ...(isBot ? { isBot: true } : {}),
    ...(crawlerName ? { bot: crawlerName } : {}),
    ...(safePath ? { path: safePath } : {}),
    ...(safeQuery ? { query: String(safeQuery) } : {}),
    ...(extra.durationMs ? { durationMs: extra.durationMs } : {})
  };
  // 指派單調序號後才計算 id，使相同 tuple 的事件仍可區分 (F8)；序號會隨 jsonl 持久化。
  assignAnalyticsEventSeq(entry);
  entry.id = getAnalyticsEventId(entry);

  systemLogBuffer.push(entry);
  if (systemLogBuffer.length > MAX_LOG_BUFFER) {
    systemLogBuffer.shift();
  }

  // 單機模式：仍保留記憶體環狀緩衝（除錯與「系統日誌」面板需要），
  // 但不落地為 jsonl、也不進入流量分析聚合。理由有兩個：
  //   1. 隱私——單一使用者的每一次點擊都是自己的閱讀行為，沒有分析價值，
  //      沒有理由在磁碟上留下逐次瀏覽紀錄。
  //   2. 寫入量——桌面版的使用者資料夾不該為了沒人看的統計而持續增長。
  if (IS_SINGLE_USER) return;

  appendToPersistentLog(entry);
  queueAnalyticsStoreEntry(entry);
}

const Logger = {
  formatTimestamp() {
    return new Date().toISOString();
  },
  /**
   * INFO 層級記錄。console 輸出的解碼版本僅供顯示；交由 pushToLogBuffer 寫入的訊息
   * 一律保持原始字串，由該函式單次解碼，避免 `%2520` 被解碼兩次而破壞結構化欄位。
   * @param {string} tag
   * @param {string} msg
   * @param {object|string} [reqOrIp] HTTP request 或 IP 字串
   * @param {object} [extra]
   */
  info(tag, msg, reqOrIp = '127.0.0.1', extra = {}) {
    const decoded = safeDecodeURI(msg);
    const ip = extractIpFromParam(reqOrIp);
    pushToLogBuffer('INFO', tag, msg, reqOrIp, extra);
    console.log(`[${this.formatTimestamp()}] [INFO] [${tag}] [IP:${ip}] ${decoded}`);
  },
  warn(tag, msg, reqOrIp = '127.0.0.1', extra = {}) {
    const decoded = safeDecodeURI(msg);
    const ip = extractIpFromParam(reqOrIp);
    pushToLogBuffer('WARN', tag, msg, reqOrIp, extra);
    console.warn(`[${this.formatTimestamp()}] [WARN] [${tag}] [IP:${ip}] ${decoded}`);
  },
  /**
   * ERROR 層級記錄。`err` 為第 3 個參數；若誤將 request 物件放在此位置，
   * 會被偵測並平移至 reqOrIp，同時將 err 視為不存在，避免訊息變成 "[object Object]" 並遺失 IP。
   * 與 info/warn 相同，寫入緩衝的訊息保持原始字串，由 pushToLogBuffer 單次解碼。
   * @param {string} tag
   * @param {string} msg
   * @param {Error|object|null} [err]
   * @param {object|string} [reqOrIp]
   * @param {object} [extra]
   */
  error(tag, msg, err, reqOrIp = '127.0.0.1', extra = {}) {
    // 防呆：request 形狀的物件 (具 headers 或 socket 且非 Error) 誤放 err 欄位時平移至 reqOrIp。
    if (err && typeof err === 'object' && !(err instanceof Error) &&
        (err.headers || err.socket)) {
      reqOrIp = err;
      err = null;
      if (extra === undefined || extra === null) extra = {};
    }
    const combined = err ? `${msg}: ${err.message || err}` : msg;
    const decodedMsg = safeDecodeURI(combined);
    const ip = extractIpFromParam(reqOrIp);
    pushToLogBuffer('ERROR', tag, combined, reqOrIp, extra);
    console.error(`[${this.formatTimestamp()}] [ERROR] [${tag}] [IP:${ip}] ${decodedMsg}`, err ? (err.stack || err) : '');
  },
  debug(tag, msg, reqOrIp = '127.0.0.1', extra = {}) {
    const decoded = safeDecodeURI(msg);
    const ip = extractIpFromParam(reqOrIp);
    pushToLogBuffer('DEBUG', tag, msg, reqOrIp, extra);
    if (process.env.DEBUG) {
      console.log(`[${this.formatTimestamp()}] [DEBUG] [${tag}] [IP:${ip}] ${decoded}`);
    }
  }
};

const { setWorkerPoolLogger } = require('./worker-pool');
setWorkerPoolLogger(Logger);

module.exports = {
  systemLogBuffer,
  pushToLogBuffer,
  Logger,
  safeDecodeURI,
  safeDecodeURIComponent,
  extractIpFromParam
};
