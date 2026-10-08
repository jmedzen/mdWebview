/**
 * @file lib/logger.js — System Logger and In-Memory Buffer
 */

const net = require('net');
const { MAX_LOG_BUFFER } = require('./constants');
const { getClientIP, getCrawlerName } = require('./utils');
const { appendToPersistentLog, queueAnalyticsStoreEntry, getAnalyticsEventId, setInMemoryLogBufferRef } = require('./analytics');

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
    ...(extra.query ? { query: String(extra.query).substring(0, 300) } : {}),
    ...(extra.durationMs ? { durationMs: extra.durationMs } : {})
  };
  entry.id = getAnalyticsEventId(entry);

  systemLogBuffer.push(entry);
  if (systemLogBuffer.length > MAX_LOG_BUFFER) {
    systemLogBuffer.shift();
  }

  appendToPersistentLog(entry);
  queueAnalyticsStoreEntry(entry);
}

const Logger = {
  formatTimestamp() {
    return new Date().toISOString();
  },
  info(tag, msg, reqOrIp = '127.0.0.1', extra = {}) {
    const decoded = safeDecodeURI(msg);
    const ip = extractIpFromParam(reqOrIp);
    pushToLogBuffer('INFO', tag, decoded, reqOrIp, extra);
    console.log(`[${this.formatTimestamp()}] [INFO] [${tag}] [IP:${ip}] ${decoded}`);
  },
  warn(tag, msg, reqOrIp = '127.0.0.1', extra = {}) {
    const decoded = safeDecodeURI(msg);
    const ip = extractIpFromParam(reqOrIp);
    pushToLogBuffer('WARN', tag, decoded, reqOrIp, extra);
    console.warn(`[${this.formatTimestamp()}] [WARN] [${tag}] [IP:${ip}] ${decoded}`);
  },
  error(tag, msg, err, reqOrIp = '127.0.0.1', extra = {}) {
    const decodedMsg = safeDecodeURI(err ? `${msg}: ${err.message || err}` : msg);
    const ip = extractIpFromParam(reqOrIp);
    pushToLogBuffer('ERROR', tag, decodedMsg, reqOrIp, extra);
    console.error(`[${this.formatTimestamp()}] [ERROR] [${tag}] [IP:${ip}] ${decodedMsg}`, err ? (err.stack || err) : '');
  },
  debug(tag, msg, reqOrIp = '127.0.0.1', extra = {}) {
    const decoded = safeDecodeURI(msg);
    const ip = extractIpFromParam(reqOrIp);
    pushToLogBuffer('DEBUG', tag, decoded, reqOrIp, extra);
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
