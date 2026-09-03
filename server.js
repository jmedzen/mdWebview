const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const os = require('os');
const net = require('net');
const readline = require('readline');
const { Worker } = require('worker_threads');
const { marked } = require('marked');  // Still needed for inline fallback
let toTraditional = s => s, hasSimplified = () => false;
try {
  const s2t = require('./s2t');
  toTraditional = s2t.toTraditional;
  hasSimplified = s2t.hasSimplified;
} catch (e) {
  // Graceful fallback if s2t is not available
}

// Configure marked once at startup
marked.setOptions({ breaks: true, gfm: true, headerIds: true, mangle: false });
marked.use({
  tokenizer: {
    del(src) {
      // Standard GFM double tildes strikethrough only (prevent single tildes ~P11~P12~ range syntax from trigger del)
      const cap = /^~~(?=[^\s~])([\s\S]*?[^\s~])~~/.exec(src);
      if (cap) {
        return {
          type: 'del',
          raw: cap[0],
          text: cap[1],
          tokens: this.lexer.inlineTokens(cap[1])
        };
      }
      return undefined;
    }
  }
});

// ── System Log Buffer (Recent 600 logs) ────────────────────────────────────
const MAX_LOG_BUFFER = 600;
const systemLogBuffer = [];

// ── 90-Day Persistent File Logging & IP Tracking ────────────────────────────
const LOG_DIR = process.env.LOG_DIR || path.join(process.cwd(), 'logs');
const ANALYTICS_STORE_PATH = path.join(LOG_DIR, 'analytics-aggregates.json');
const ANALYTICS_STORE_VERSION = 1;
let analyticsStore = null;
let analyticsStoreReady = null;
let analyticsStoreWrite = Promise.resolve();
let analyticsStoreInitialized = false;
try {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
} catch (e) {
  console.error('Failed to create logs directory:', e);
}

function getLogFilePath(dateObj = new Date()) {
  const yyyy = dateObj.getUTCFullYear();
  const mm = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dateObj.getUTCDate()).padStart(2, '0');
  return path.join(LOG_DIR, `access-${yyyy}-${mm}-${dd}.jsonl`);
}

function appendToPersistentLog(logEntry) {
  try {
    const filePath = getLogFilePath(new Date(logEntry.timestamp));
    const line = JSON.stringify(logEntry) + '\n';
    fs.appendFile(filePath, line, (err) => {
      if (err) console.error('Error writing to persistent log file:', err);
    });
  } catch (err) {
    console.error('Error formatting persistent log entry:', err);
  }
}

function createEmptyAnalyticsStore() {
  return {
    version: ANALYTICS_STORE_VERSION,
    updatedAt: new Date(0).toISOString(),
    lifetime: { requests: 0, views: 0, searchCount: 0, ips: {}, files: {}, searches: {}, dictSearchCount: 0, dictLookupCount: 0, dictBrowseCount: 0, dictSearches: {}, dictLookups: {} },
    daily: {},
    processedIds: {}
  };
}

function getAnalyticsEventId(entry) {
  const identity = JSON.stringify({
    timestamp: entry.timestamp, level: entry.level, tag: entry.tag, ip: entry.ip,
    message: entry.message, path: entry.path || '', query: entry.query || '', durationMs: entry.durationMs || 0
  });
  return crypto.createHash('sha256').update(identity).digest('hex');
}

function extractAnalyticsPath(entry) {
  if (entry.path) return entry.path;
  if (!entry.message) return '';
  const access = entry.message.match(/Access file: "([^"]+)"/);
  if (access) return access[1];
  const pathMatch = entry.message.match(/path=([^&\\s]+)/);
  if (!pathMatch) return '';
  try { return decodeURIComponent(pathMatch[1]); } catch (_) { return pathMatch[1]; }
}

function extractAnalyticsQuery(entry) {
  if (entry.query) return String(entry.query).trim();
  if (!entry.message) return '';
  const queryMatch = entry.message.match(/Query: "([^"]+)"/);
  if (queryMatch) return queryMatch[1].trim();
  const paramMatch = entry.message.match(/q=([^&\\s]+)/);
  if (!paramMatch) return '';
  try { return decodeURIComponent(paramMatch[1]).trim(); } catch (_) { return paramMatch[1].trim(); }
}

function updateLatest(stat, timestamp, field = 'lastAccess') {
  if (!stat[field] || new Date(timestamp) > new Date(stat[field])) stat[field] = timestamp;
}

const MAX_PROCESSED_IDS = 10000;
// Upper bound on each analytics aggregate map (ips/files/searches, both the
// lifetime and per-day buckets). These keys are partly attacker-influenceable
// (X-Forwarded-For, share `?file=`, search `q=`), so they must never grow
// without bound and bloat memory + the persisted store.
const MAX_ANALYTICS_KEYS = 10000;

// String-keyed objects keep insertion order, so deleting from the front evicts
// the oldest entries. Runs only when a NEW key is added, keeping it O(1) in the
// common case.
function pruneAnalyticsMap(map, maxKeys = MAX_ANALYTICS_KEYS) {
  const keys = Object.keys(map);
  const excess = keys.length - maxKeys;
  if (excess > 0) {
    for (let i = 0; i < excess; i++) delete map[keys[i]];
  }
}

function analyticsMapGetOrCreate(map, key, make, maxKeys = MAX_ANALYTICS_KEYS) {
  let entry = map[key];
  if (!entry) {
    entry = map[key] = make();
    pruneAnalyticsMap(map, maxKeys);
  }
  return entry;
}

function updateAnalyticsStoreEntry(store, entry) {
  const timestamp = new Date(entry.timestamp);
  if (Number.isNaN(timestamp.getTime())) return false;
  const id = entry.id || getAnalyticsEventId(entry);
  if (store.processedIds[id]) return false;
  store.processedIds[id] = timestamp.toISOString();

  // Prune oldest processedIds if exceeding capacity
  const pKeys = Object.keys(store.processedIds);
  if (pKeys.length > MAX_PROCESSED_IDS) {
    for (let i = 0; i < pKeys.length - MAX_PROCESSED_IDS; i++) {
      delete store.processedIds[pKeys[i]];
    }
  }

  const ip = entry.ip || '127.0.0.1';
  const dateKey = timestamp.toISOString().split('T')[0];
  const bucket = store.daily[dateKey] || (store.daily[dateKey] = {
    requests: 0, views: 0, searches: 0, ips: {}, files: {}, searches: {}, dictSearchCount: 0, dictLookupCount: 0, dictBrowseCount: 0
  });
  const lifetime = store.lifetime;
  lifetime.requests++;
  bucket.requests++;

  const ipStat = analyticsMapGetOrCreate(lifetime.ips, ip, () => ({ requests: 0, lastAccess: entry.timestamp }));
  ipStat.requests++;
  updateLatest(ipStat, entry.timestamp);
  const bucketIp = analyticsMapGetOrCreate(bucket.ips, ip, () => ({ requests: 0, lastAccess: entry.timestamp }));
  bucketIp.requests++;
  updateLatest(bucketIp, entry.timestamp);

  if (entry.tag === 'Render' || entry.tag === 'ShareLink') {
    const docPath = extractAnalyticsPath(entry);
    if (docPath) {
      lifetime.views++;
      bucket.views++;
      const file = analyticsMapGetOrCreate(lifetime.files, docPath, () => ({ views: 0, ips: {}, lastAccess: entry.timestamp }));
      file.views++;
      if (!file.ips[ip]) {
        file.ips[ip] = true;
        pruneAnalyticsMap(file.ips);
      }
      updateLatest(file, entry.timestamp);
      const bucketFile = analyticsMapGetOrCreate(bucket.files, docPath, () => ({ views: 0, ips: {}, lastAccess: entry.timestamp }));
      bucketFile.views++;
      if (!bucketFile.ips[ip]) {
        bucketFile.ips[ip] = true;
        pruneAnalyticsMap(bucketFile.ips);
      }
      updateLatest(bucketFile, entry.timestamp);
    }
  }

  if (entry.tag === 'Search') {
    const query = extractAnalyticsQuery(entry);
    if (query) {
      lifetime.searchCount++;
      bucket.searches++;
      const search = analyticsMapGetOrCreate(lifetime.searches, query, () => ({ count: 0, lastSearch: entry.timestamp }));
      search.count++;
      updateLatest(search, entry.timestamp, 'lastSearch');
      const bucketSearch = analyticsMapGetOrCreate(bucket.searches, query, () => ({ count: 0, lastSearch: entry.timestamp }));
      bucketSearch.count++;
      updateLatest(bucketSearch, entry.timestamp, 'lastSearch');
    }
  }

  if (entry.tag === 'DictSearch') {
    const query = extractAnalyticsQuery(entry);
    if (query) {
      lifetime.dictSearchCount = (lifetime.dictSearchCount || 0) + 1;
      bucket.dictSearchCount = (bucket.dictSearchCount || 0) + 1;
      if (!lifetime.dictSearches) lifetime.dictSearches = {};
      const s = analyticsMapGetOrCreate(lifetime.dictSearches, query, () => ({ count: 0, lastSearch: entry.timestamp }));
      s.count = (s.count || 0) + 1;
      updateLatest(s, entry.timestamp, 'lastSearch');
    }
  }

  if (entry.tag === 'DictLookup') {
    const headword = extractAnalyticsQuery(entry);
    const docPath = extractAnalyticsPath(entry);
    if (headword || docPath) {
      lifetime.dictLookupCount = (lifetime.dictLookupCount || 0) + 1;
      bucket.dictLookupCount = (bucket.dictLookupCount || 0) + 1;
      if (!lifetime.dictLookups) lifetime.dictLookups = {};
      const key = `${docPath || ''}::${headword || ''}`;
      const l = analyticsMapGetOrCreate(lifetime.dictLookups, key, () => ({ count: 0, headword, path: docPath, lastLookup: entry.timestamp }));
      l.count = (l.count || 0) + 1;
      updateLatest(l, entry.timestamp, 'lastLookup');
    }
  }

  if (entry.tag === 'DictBrowse') {
    lifetime.dictBrowseCount = (lifetime.dictBrowseCount || 0) + 1;
    bucket.dictBrowseCount = (bucket.dictBrowseCount || 0) + 1;
  }

  return true;
}

async function saveAnalyticsStore() {
  if (!analyticsStore) return;
  analyticsStore.updatedAt = new Date().toISOString();
  const tempPath = `${ANALYTICS_STORE_PATH}.tmp-${process.pid}`;
  await fs.promises.writeFile(tempPath, JSON.stringify(analyticsStore), 'utf-8');
  await fs.promises.rename(tempPath, ANALYTICS_STORE_PATH);
}

let analyticsStoreSaveTimer = null;

function queueAnalyticsStoreEntry(entry) {
  if (!analyticsStoreInitialized || !analyticsStore) return;
  if (updateAnalyticsStoreEntry(analyticsStore, entry)) {
    if (!analyticsStoreSaveTimer) {
      analyticsStoreSaveTimer = setTimeout(() => {
        analyticsStoreSaveTimer = null;
        saveAnalyticsStore().catch(err => console.error('Error saving analytics aggregate:', err));
      }, 30000);
    }
  }
}

async function readAnalyticsFile(filePath, onEntry) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { onEntry(JSON.parse(line)); } catch (_) {}
  }
}

async function initializeAnalyticsStore() {
  if (analyticsStoreReady) return analyticsStoreReady;
  analyticsStoreReady = (async () => {
    let loaded = null;
    try { loaded = JSON.parse(await fs.promises.readFile(ANALYTICS_STORE_PATH, 'utf-8')); } catch (_) {}
    analyticsStore = loaded && loaded.version === ANALYTICS_STORE_VERSION ? loaded : createEmptyAnalyticsStore();
    if (!analyticsStore.lifetime || !analyticsStore.daily || !analyticsStore.processedIds) analyticsStore = createEmptyAnalyticsStore();

    const files = await fs.promises.readdir(LOG_DIR).catch(() => []);
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      await readAnalyticsFile(path.join(LOG_DIR, file), entry => {
        if (!entry.id) entry.id = getAnalyticsEventId(entry);
        updateAnalyticsStoreEntry(analyticsStore, entry);
      });
    }
    await saveAnalyticsStore();
    analyticsStoreInitialized = true;
    return analyticsStore;
  })().catch(err => {
    analyticsStoreReady = null;
    console.error('Failed to initialize analytics aggregate:', err);
    throw err;
  });
  return analyticsStoreReady;
}

// ── 7-Day Log Pruning & Permanent Analytics Retention Job ────────────────────
const LOG_PRUNE_AGE_DAYS = 7;
const LOG_PRUNE_AGE_MS = LOG_PRUNE_AGE_DAYS * 24 * 60 * 60 * 1000;

function pruneAnalyticsLogEntry(entry) {
  if (!entry || !entry.timestamp) return null;

  const tag = entry.tag || '';
  if (tag === 'Index') return null;

  if (entry.message) {
    if (entry.message.includes('/favicon.ico') ||
        entry.message.includes('/style.css') ||
        entry.message.includes('/marked.min.js') ||
        entry.message.includes('/apple-touch-icon') ||
        entry.message.includes('Indexing progress')) {
      return null;
    }
  }

  const docPath = extractAnalyticsPath(entry);
  const query = extractAnalyticsQuery(entry);

  if (tag === 'DictSearch') {
    if (!query) return null;
    return {
      timestamp: entry.timestamp,
      tag: 'DictSearch',
      ip: entry.ip || '127.0.0.1',
      query: query,
      pruned: true
    };
  }

  if (tag === 'DictLookup') {
    if (!docPath && !query) return null;
    return {
      timestamp: entry.timestamp,
      tag: 'DictLookup',
      ip: entry.ip || '127.0.0.1',
      ...(docPath ? { path: docPath } : {}),
      ...(query ? { query: query } : {}),
      pruned: true
    };
  }

  if (tag === 'Render' || tag === 'ShareLink' || docPath) {
    if (!docPath) return null;
    return {
      timestamp: entry.timestamp,
      tag: 'Render',
      ip: entry.ip || '127.0.0.1',
      path: docPath,
      pruned: true
    };
  }

  if (tag === 'Search' || query) {
    if (!query) return null;
    return {
      timestamp: entry.timestamp,
      tag: 'Search',
      ip: entry.ip || '127.0.0.1',
      query: query,
      pruned: true
    };
  }

  if (entry.ip && entry.ip !== '127.0.0.1') {
    return {
      timestamp: entry.timestamp,
      tag: tag || 'HTTP',
      ip: entry.ip,
      pruned: true
    };
  }

  return null;
}

async function pruneLogFileAsync(filePath) {
  try {
    const stats = await fs.promises.stat(filePath);
    const now = Date.now();
    if (now - stats.mtimeMs <= LOG_PRUNE_AGE_MS) return; // Keep full logs within 7 days

    // Read first non-empty line to check if already pruned
    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let alreadyPruned = false;
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && parsed.pruned) alreadyPruned = true;
      } catch (_) {}
      break;
    }
    rl.close();
    stream.destroy();

    if (alreadyPruned) return;

    // Perform pruning
    const prunedEntries = [];
    const readStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const readRl = readline.createInterface({ input: readStream, crlfDelay: Infinity });

    for await (const line of readRl) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        const pruned = pruneAnalyticsLogEntry(parsed);
        if (pruned) prunedEntries.push(JSON.stringify(pruned));
      } catch (_) {}
    }

    const tempPath = `${filePath}.tmp-${process.pid}`;
    const fileContent = prunedEntries.length > 0 ? prunedEntries.join('\n') + '\n' : '';
    await fs.promises.writeFile(tempPath, fileContent, 'utf-8');
    await fs.promises.rename(tempPath, filePath);

    const newStats = await fs.promises.stat(filePath);
    console.log(`[LogPruner] Pruned ${path.basename(filePath)}: reduced from ${(stats.size / 1024).toFixed(1)}KB to ${(newStats.size / 1024).toFixed(1)}KB (${prunedEntries.length} analytics entries retained)`);
  } catch (err) {
    console.error(`[LogPruner] Error pruning log file ${filePath}:`, err);
  }
}

async function cleanOldLogsJob() {
  try {
    const files = await fs.promises.readdir(LOG_DIR);
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const filePath = path.join(LOG_DIR, file);
      await pruneLogFileAsync(filePath);
    }
  } catch (err) {
    console.error('[LogPruner] Error scanning log directory:', err);
  }
}

// Backfill aggregate data before log pruning job runs
initializeAnalyticsStore().then(() => {
  cleanOldLogsJob();
  setInterval(cleanOldLogsJob, 24 * 60 * 60 * 1000);
}).catch(() => {});

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

// decodeURIComponent throws URIError on malformed escapes (e.g. a bare '%' or
// '%E0%A4%A'). A single bad request must never crash the server, so every
// request-path use goes through this wrapper; downstream path.resolve + the
// isSafe path.relative check still confine the (possibly un-decoded) result.
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

  // Security & Performance: truncate oversized messages to prevent DoS / log bloat
  if (messageStr.length > 2000) {
    messageStr = messageStr.substring(0, 2000) + '… [truncated]';
  }

  const clientIp = extractIpFromParam(reqOrIp);

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
    ...(safePath ? { path: safePath } : {}),
    ...(extra.query ? { query: String(extra.query).substring(0, 300) } : {}),
    ...(extra.durationMs ? { durationMs: extra.durationMs } : {})
  };
  entry.id = getAnalyticsEventId(entry);

  systemLogBuffer.push(entry);
  if (systemLogBuffer.length > MAX_LOG_BUFFER) {
    systemLogBuffer.shift();
  }

  // Persist asynchronously to disk
  appendToPersistentLog(entry);
  queueAnalyticsStoreEntry(entry);
}

// ── Logger Utility ──────────────────────────────────────────────────────────
const Logger = {
  formatTimestamp() {
    return new Date().toISOString();
  },
  info(tag, msg, reqOrIp = '127.0.0.1', extra = {}) {
    const decoded = safeDecodeURI(msg);
    const ip = extractIpFromParam(reqOrIp);
    pushToLogBuffer('INFO', tag, decoded, ip, extra);
    console.log(`[${this.formatTimestamp()}] [INFO] [${tag}] [IP:${ip}] ${decoded}`);
  },
  warn(tag, msg, reqOrIp = '127.0.0.1', extra = {}) {
    const decoded = safeDecodeURI(msg);
    const ip = extractIpFromParam(reqOrIp);
    pushToLogBuffer('WARN', tag, decoded, ip, extra);
    console.warn(`[${this.formatTimestamp()}] [WARN] [${tag}] [IP:${ip}] ${decoded}`);
  },
  error(tag, msg, err, reqOrIp = '127.0.0.1', extra = {}) {
    const decodedMsg = safeDecodeURI(err ? `${msg}: ${err.message || err}` : msg);
    const ip = extractIpFromParam(reqOrIp);
    pushToLogBuffer('ERROR', tag, decodedMsg, ip, extra);
    console.error(`[${this.formatTimestamp()}] [ERROR] [${tag}] [IP:${ip}] ${decodedMsg}`, err ? (err.stack || err) : '');
  },
  debug(tag, msg, reqOrIp = '127.0.0.1', extra = {}) {
    const decoded = safeDecodeURI(msg);
    const ip = extractIpFromParam(reqOrIp);
    pushToLogBuffer('DEBUG', tag, decoded, ip, extra);
    if (process.env.DEBUG) {
      console.log(`[${this.formatTimestamp()}] [DEBUG] [${tag}] [IP:${ip}] ${decoded}`);
    }
  }
};

// ── Last-resort error containment ──────────────────────────────────────────
// Never let an uncaught exception or unhandled rejection take down the whole
// server. Log it and keep serving. The per-request guards above handle the
// known vectors; this is defense-in-depth for anything unexpected.
process.on('uncaughtException', (err) => {
  Logger.error('Process', 'Uncaught exception', err);
});
process.on('unhandledRejection', (reason) => {
  Logger.error('Process', 'Unhandled rejection', reason instanceof Error ? reason : new Error(String(reason)));
});

// ── Worker Thread Pool ─────────────────────────────────────────────────────
// 動態偵測 CPU 核心數：預留 1 個核心給主事件迴圈，其餘全數投入背景 Worker Pool
const numCpus = os.cpus().length || 4;
const POOL_SIZE = Math.max(2, numCpus - 1);
const workerPool = [];
const jobCallbacks = new Map(); // jobId -> { resolve, reject }
let jobIdSeq = 0;
const jobQueue = []; // queue for when all workers are busy

function createWorker(index) {
  const WORKER_PATH = path.join(APP_ROOT, 'render-worker.js');
  const w = new Worker(WORKER_PATH);
  w.idle = true;
  w.currentJobId = null;
  w.index = index;

  w.on('message', ({ jobId, html, error }) => {
    const cb = jobCallbacks.get(jobId);
    if (cb) {
      jobCallbacks.delete(jobId);
      if (error) cb.reject(new Error(error));
      else cb.resolve(html);
    }
    w.currentJobId = null;
    w.idle = true;
    flushQueue();
  });

  w.on('error', (err) => {
    Logger.error('WorkerPool', `[Worker #${w.index}] Thread error`, err);
    if (w.currentJobId) {
      const cb = jobCallbacks.get(w.currentJobId);
      if (cb) {
        jobCallbacks.delete(w.currentJobId);
        cb.reject(err);
      }
      w.currentJobId = null;
    }
    w.idle = true;
    flushQueue();
  });

  w.on('exit', (code) => {
    // The timeout path already removed this worker and spawned a replacement
    // (marking it `terminated`); the async 'exit' event must not spawn a second.
    if (w.terminated) return;
    console.warn(`[Worker ${w.index}] Exited with code ${code}. Re-spawning...`);
    
    // Clean up active job if it died mid-execution to prevent leaking callbacks
    if (w.currentJobId) {
      const cb = jobCallbacks.get(w.currentJobId);
      if (cb) {
        jobCallbacks.delete(w.currentJobId);
        cb.reject(new Error('Worker thread terminated unexpectedly'));
      }
    }
    
    // Remove the dead worker from the pool
    const idx = workerPool.indexOf(w);
    if (idx !== -1) {
      workerPool.splice(idx, 1);
    }
    
    // Respawn a new worker at the same index
    const newWorker = createWorker(w.index);
    workerPool.push(newWorker);
    flushQueue();
  });

  return w;
}

function initWorkerPool() {
  for (let i = 0; i < POOL_SIZE; i++) {
    const w = createWorker(i);
    workerPool.push(w);
  }
  console.log(`  Workers: ${POOL_SIZE} render thread(s) ready`);
}

function flushQueue() {
  if (jobQueue.length === 0) return;
  const freeWorker = workerPool.find(w => w.idle);
  if (!freeWorker) return;
  const { jobId, body, filePath, lineOffset, resolve, reject } = jobQueue.shift();
  jobCallbacks.set(jobId, { resolve, reject });
  freeWorker.currentJobId = jobId;
  freeWorker.idle = false;
  freeWorker.postMessage({ jobId, body, filePath, lineOffset });
}

const JOB_TIMEOUT_MS = 30000; // 30 seconds

function renderWithWorker(body, filePath, lineOffset) {
  lineOffset = lineOffset || 0;
  return new Promise((resolve, reject) => {
    const jobId = ++jobIdSeq;
    const timer = setTimeout(() => {
      const cb = jobCallbacks.get(jobId);
      if (cb) {
        jobCallbacks.delete(jobId);
        cb.reject(new Error('Worker render timeout after 30s'));

        // Terminate and respawn worker thread if stuck on this jobId
        const stuckWorker = workerPool.find(w => w.currentJobId === jobId);
        if (stuckWorker) {
          Logger.warn('WorkerPool', `[Worker #${stuckWorker.index}] Timed out on job #${jobId}. Terminating & respawning worker...`);
          stuckWorker.terminated = true; // suppress the 'exit' handler's own respawn
          try { stuckWorker.terminate(); } catch (_) {}
          const idx = workerPool.indexOf(stuckWorker);
          if (idx !== -1) workerPool.splice(idx, 1);
          const newWorker = createWorker(stuckWorker.index);
          workerPool.push(newWorker);
          flushQueue();
        }
      }
    }, JOB_TIMEOUT_MS);
    
    const wrappedResolve = (val) => { clearTimeout(timer); resolve(val); };
    const wrappedReject = (err) => { clearTimeout(timer); reject(err); };
    
    const freeWorker = workerPool.find(w => w.idle);
    if (freeWorker) {
      jobCallbacks.set(jobId, { resolve: wrappedResolve, reject: wrappedReject });
      freeWorker.currentJobId = jobId;
      freeWorker.idle = false;
      freeWorker.postMessage({ jobId, body, filePath, lineOffset });
    } else {
      // All workers busy — queue the job
      jobQueue.push({ jobId, body, filePath, lineOffset, resolve: wrappedResolve, reject: wrappedReject });
    }
  });
}

const PORT = process.env.PORT || 8330;
const APP_ROOT = path.resolve(process.cwd());
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(APP_ROOT, 'config.json');

let config = {
  admin: null, // { username, passwordHash, salt }
  settings: {
    mdRoot: process.env.MD_ROOT || path.join(APP_ROOT, 'md'),
    defaultFontSize: parseInt(process.env.DEFAULT_FONT_SIZE, 10) || 16,
    defaultTheme: process.env.DEFAULT_THEME || 'obsidian-dark',
    siteName: process.env.SITE_NAME || 'mdWebview',
    enableVersion: process.env.ENABLE_VERSION ? process.env.ENABLE_VERSION === 'true' : false,
    version: process.env.VERSION || '',
    enableDownload: process.env.ENABLE_DOWNLOAD ? process.env.ENABLE_DOWNLOAD === 'true' : false,
    downloadUrl: process.env.DOWNLOAD_URL || '',
    dictionaryEnabled: process.env.DICTIONARY_ENABLED ? process.env.DICTIONARY_ENABLED === 'true' : false,
    dictionaryPath: process.env.DICTIONARY_PATH || deriveDictRoot(),
    suggestList: {
      adminList: [],
      adminPickCount: 3,
      blackList: [],
      hotPickCount: 5,
      enabled: false
    }
  }
};

function loadConfig() {
  try {
    // 1. Initial environment variables as base defaults
    if (process.env.SITE_NAME) config.settings.siteName = process.env.SITE_NAME;
    if (process.env.ENABLE_VERSION !== undefined) config.settings.enableVersion = process.env.ENABLE_VERSION === 'true';
    if (process.env.VERSION !== undefined) config.settings.version = process.env.VERSION;
    if (process.env.ENABLE_DOWNLOAD !== undefined) config.settings.enableDownload = process.env.ENABLE_DOWNLOAD === 'true';
    if (process.env.DOWNLOAD_URL !== undefined) config.settings.downloadUrl = process.env.DOWNLOAD_URL;

    // 2. Try reading local config.json in APP_ROOT if present
    const defaultConfigPath = path.join(APP_ROOT, 'config.json');
    if (fs.existsSync(defaultConfigPath)) {
      const raw = fs.readFileSync(defaultConfigPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed.settings) config.settings = { ...config.settings, ...parsed.settings };
      if (parsed.admin && !config.admin) config.admin = parsed.admin;
    }

    // 3. HIGHEST PRIORITY: Persistent CONFIG_PATH (/data/config.json)
    // Saved admin settings must always override defaults across container updates!
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed.settings) {
        config.settings = { ...config.settings, ...parsed.settings };
      }
      if (parsed.admin) {
        config.admin = parsed.admin;
      }
    }
  } catch (err) {
    console.error('Error loading config:', err);
  }
}

function saveConfig() {
  fs.promises.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8')
    .catch(err => console.error('Error saving config:', err));
}

loadConfig();

function getMdRoot() {
  const configured = config.settings.mdRoot;

  // 1. If configured path exists and contains files/directories, use it directly
  if (configured && fs.existsSync(configured)) {
    try {
      const items = fs.readdirSync(configured);
      if (items.some(name => !name.startsWith('.'))) {
        return configured;
      }
    } catch (_) {}
  }

  // 2. If configured path is invalid or empty (e.g. host absolute path inside Docker container),
  // fallback to candidates that actually exist and contain files
  const candidates = [
    process.env.MD_ROOT,
    '/data/md',
    '/data',
    path.join(APP_ROOT, 'md')
  ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      try {
        const items = fs.readdirSync(candidate);
        if (items.some(name => !name.startsWith('.'))) {
          config.settings.mdRoot = candidate;
          return candidate;
        }
      } catch (_) {}
    }
  }

  return configured || path.join(APP_ROOT, 'md');
}

// Dictionary files live in a `dicts/` directory that is a sibling of the markdown
// vault (mdRoot). Deriving from mdRoot (rather than APP_ROOT) keeps the dict dir on
// the same persistent `/data` volume as the vault inside Docker — `/data/md` →
// `/data/dicts` — instead of the ephemeral `/app` image layer.
function deriveDictRoot(mdRoot) {
  const base = mdRoot || process.env.MD_ROOT || path.join(APP_ROOT, 'md');
  return path.join(path.dirname(path.resolve(base)), 'dicts');
}

// ── Realpath confinement (symlink escape defense) ──────────────────────────
// Lexical `path.relative` checks are bypassable by a symlink inside the vault: a
// link pointing outside still lexically "resolves" inside, so the `..` guard passes
// while the OS follows the link out. Resolving both the target and the vault root to
// canonical paths and re-checking containment closes this for every file handler.
const realpathCache = new Map(); // root -> canonical realpath

async function getRootRealpath(root) {
  if (realpathCache.has(root)) return realpathCache.get(root);
  const real = await fs.promises.realpath(root);
  realpathCache.set(root, real);
  return real;
}

// Returns true only when resolvedPath's canonical target lives inside `root`.
// Throws ENOENT (etc.) for a nonexistent path so callers can preserve 404 semantics.
async function isRealPathWithinRoot(root, resolvedPath) {
  const realTarget = await fs.promises.realpath(resolvedPath);
  const realRoot = await getRootRealpath(root);
  const rel = path.relative(realRoot, realTarget);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Legacy single-root wrapper for vault-only handlers (file/media).
async function isRealPathWithinMdRoot(resolvedPath) {
  return isRealPathWithinRoot(getMdRoot(), resolvedPath);
}

// MIME types
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.pdf':  'application/pdf',
};

// Security Headers
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' fonts.googleapis.com; font-src 'self' fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self';"
};

// Build response headers for the dynamic index.html, injecting a per-request
// nonce into script-src so the single inline config script can run, while any
// inline <script>/event-handler that arrives via rendered markdown is blocked.
function indexHtmlHeaders(extra, nonce) {
  const csp = SECURITY_HEADERS['Content-Security-Policy'].replace(
    "script-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`
  );
  return Object.assign({}, extra, SECURITY_HEADERS, { 'Content-Security-Policy': csp });
}

// Escape operator-supplied config strings before injecting them into HTML text/attributes.
function escapeHtmlString(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Serialize for inline <script> such that no config value can break out via "</script>"
// (or the U+2028/U+2029 line separators that terminate a JS string literal early).
function safeJsonForScript(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

let rawIndexHtml = null;
function getIndexHtml(nonce, callback) {
  const renderDynamicIndex = (templateBuf, nonce) => {
    let html = templateBuf.toString('utf-8');
    const defaultTheme = escapeHtmlString(config.settings.defaultTheme || 'obsidian-dark');
    const defaultFontSize = parseInt(config.settings.defaultFontSize, 10) || 16;
    const siteName = escapeHtmlString(config.settings.siteName || 'mdWebview');

    // 1. Inject theme & font-size into <html> element
    html = html.replace(/<html([^>]*)>/i, (match, p1) => {
      let attrs = p1;
      if (/data-theme="[^"]*"/i.test(attrs)) {
        attrs = attrs.replace(/data-theme="[^"]*"/i, `data-theme="${defaultTheme}"`);
      } else {
        attrs += ` data-theme="${defaultTheme}"`;
      }

      if (/style="[^"]*"/i.test(attrs)) {
        attrs = attrs.replace(/style="([^"]*)"/i, `style="$1; --content-font-size: ${defaultFontSize}px;"`);
      } else {
        attrs += ` style="--content-font-size: ${defaultFontSize}px;"`;
      }
      return `<html${attrs}>`;
    });

    // 2. Inject font size display value
    html = html.replace(
      /<span id="fontSizeDisplay" class="font-size-display">\d+<\/span>/i,
      `<span id="fontSizeDisplay" class="font-size-display">${defaultFontSize}</span>`
    );

    // 3. Inject site name into title and logo
    html = html.replace(
      /<title>.*?<\/title>/i,
      `<title>${siteName} — 佛典經論閱讀器</title>`
    );
    html = html.replace(
      /<span class="logo-text">.*?<\/span>/i,
      `<span class="logo-text">${siteName}</span>`
    );

    // 4. Inject server config script
    // Strip the absolute vault path: the frontend never reads mdRoot from this
    // payload, and shipping it on every page load would disclose the filesystem.
    const clientSettings = Object.assign({}, config.settings);
    delete clientSettings.mdRoot;
    delete clientSettings.dictionaryPath;
    const configScript = `<script nonce="${nonce}">window.__APP_CONFIG__ = ${safeJsonForScript(clientSettings)};</script>`;
    if (html.includes('</head>')) {
      html = html.replace('</head>', `${configScript}\n</head>`);
    } else {
      html = configScript + html;
    }

    return Buffer.from(html, 'utf-8');
  };

  if (rawIndexHtml) {
    return callback(null, renderDynamicIndex(rawIndexHtml, nonce));
  }
  const indexPath = path.join(APP_ROOT, 'index.html');
  fs.readFile(indexPath, (err, data) => {
    if (err) return callback(err);
    rawIndexHtml = data;
    callback(null, renderDynamicIndex(rawIndexHtml, nonce));
  });
}

function sendCompressed(req, res, statusCode, headers, data) {
  const acceptEncoding = req.headers['accept-encoding'] || '';
  const contentType = headers['Content-Type'] || '';
  const isCompressible = contentType.includes('text/') || 
                         contentType.includes('javascript') || 
                         contentType.includes('json') || 
                         contentType.includes('xml');

  if (isCompressible && data.length > 1024 && acceptEncoding.includes('gzip')) {
    zlib.gzip(data, { level: zlib.constants.Z_BEST_SPEED }, (err, compressed) => {
      if (err) {
        res.writeHead(statusCode, headers);
        res.end(data);
        return;
      }
      res.writeHead(statusCode, Object.assign({}, headers, {
        'Content-Encoding': 'gzip',
        'Content-Length': compressed.length
      }));
      res.end(compressed);
    });
  } else {
    res.writeHead(statusCode, Object.assign({}, headers, {
      'Content-Length': data.length
    }));
    res.end(data);
  }
}

function sendJSON(res, statusCode, data) {
  const jsonStr = JSON.stringify(data);
  const payload = Buffer.from(jsonStr, 'utf-8');
  
  const headers = Object.assign({
    'Content-Type': 'application/json; charset=utf-8'
  }, SECURITY_HEADERS);

  // Use the cached Accept-Encoding from the response object (attached during request routing)
  const acceptEncoding = res.reqHeadersAcceptEncoding || '';
  if (payload.length > 1024 && acceptEncoding.includes('gzip')) {
    zlib.gzip(payload, { level: zlib.constants.Z_BEST_SPEED }, (err, compressed) => {
      if (err) {
        res.writeHead(statusCode, headers);
        res.end(payload);
        return;
      }
      res.writeHead(statusCode, Object.assign({}, headers, {
        'Content-Encoding': 'gzip',
        'Content-Length': compressed.length
      }));
      res.end(compressed);
    });
  } else {
    res.writeHead(statusCode, headers);
    res.end(payload);
  }
}

let cachedTree = null;
let treeWatcher = null;
const searchCache = new Map(); // key: "folder::q" -> { time, data }
const SEARCH_CACHE_MAX = 30;

const searchMetrics = {
  totalQueries: 0,
  cacheHits: 0,
  cacheMisses: 0,
  totalSearchTimeMs: 0,
  lastSearchTimeMs: 0
};

const httpMetrics = {
  totalRequests: 0,
  totalResponseTimeMs: 0,
  recentRequestTimes: [] // Timestamps for 60s sliding window RPM
};

// Bound the sliding-window RPM buffer so a flood of requests can never grow it
// unboundedly (the 30 req/s API rate limit ≈ 1800/min; 5000 gives ample headroom).
const MAX_RECENT_REQUEST_TIMES = 5000;

let treeWatcherDebounceTimer = null;
let treeWatcherStartTime = 0;

function setupTreeWatcher() {
  if (treeWatcher) return;
  try {
    const mdRoot = getMdRoot();
    if (fs.existsSync(mdRoot)) {
      treeWatcherStartTime = Date.now();
      treeWatcher = fs.watch(mdRoot, { recursive: true }, (eventType, filename) => {
        // Ignore initial macOS fs.watch attach noise within 3 seconds of initialization
        if (Date.now() - treeWatcherStartTime < 3000) {
          return;
        }

        // Ignore hidden system files (.DS_Store, .git, .tmp, etc.)
        if (filename && (filename.startsWith('.') || filename.includes('/.'))) {
          return;
        }

        // Invalidate tree and search cache
        cachedTree = null;
        searchCache.clear();
        invalidateSectionIndexes();

        // Debounce index rebuild by 1.5 seconds to handle batch file operations cleanly
        if (treeWatcherDebounceTimer) {
          clearTimeout(treeWatcherDebounceTimer);
        }
        treeWatcherDebounceTimer = setTimeout(() => {
          treeWatcherDebounceTimer = null;
          Logger.info('Index', `Vault file changed: "${filename || 'unknown'}" (${eventType}). Aborting active build & restarting Bigram Index build...`);
          buildSearchIndexAsync(true).catch(() => {});
        }, 1500);
      });
    }
  } catch (err) {
    Logger.error('Index', 'Error setting up tree watcher', err);
  }
}

function resetTreeWatcher() {
  if (treeWatcherDebounceTimer) {
    clearTimeout(treeWatcherDebounceTimer);
    treeWatcherDebounceTimer = null;
  }
  if (treeWatcher) {
    try {
      treeWatcher.close();
    } catch (err) {}
    treeWatcher = null;
  }
  cachedTree = null;
  searchCache.clear();
  searchIndex.ready = false;
  Logger.info('Index', 'Vault configuration changed: Resetting tree watcher and Bigram Index');
}

async function scanDirAsync(dir, relativePath) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    return [];
  }
  const result = [];
  const promises = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    const relPath = relativePath ? relativePath + '/' + entry.name : entry.name;
    if (entry.isDirectory()) {
      promises.push(
        scanDirAsync(fullPath, relPath).then(children => {
          if (children.length > 0) {
            result.push({
              name: entry.name,
              path: relPath,
              type: 'directory',
              children: children,
            });
          }
        })
      );
    } else if (entry.name.endsWith('.md')) {
      let fileSize = 0;
      try { fileSize = fs.statSync(fullPath).size; } catch (_) {}
      result.push({
        name: entry.name.replace(/\.md$/, ''),
        path: relPath,
        type: 'file',
        size: fileSize
      });
    }
  }
  await Promise.all(promises);
  result.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-TW', { numeric: true, sensitivity: 'base' });
  });
  return result;
}

// ── API: Directory Tree ──────────────────────────────────────
async function handleTree(req, res) {
  setupTreeWatcher();
  if (cachedTree) {
    return sendJSON(res, 200, cachedTree);
  }
  try {
    const tree = await scanDirAsync(getMdRoot(), '');
    cachedTree = tree;
    sendJSON(res, 200, tree);
  } catch (err) {
    Logger.error('Tree', 'Failed to scan vault directory', err, req);
    sendJSON(res, 500, { error: 'Failed to load file tree' });
  }
}

// ── API: File Content ────────────────────────────────────────
async function handleFile(req, res, query) {
  const filePath = query.path;
  if (!filePath) {
    return sendJSON(res, 400, { error: 'Missing path parameter' });
  }

  const line = query.line;
  if (line) {
    console.log(`[API File] Reading file "${filePath}" with requested line: ${line}`);
  }

  if (filePath.includes('\0')) {
    return sendJSON(res, 400, { error: 'Invalid path' });
  }

  const fullPath = path.join(getMdRoot(), filePath);
  const resolved = path.resolve(fullPath);

  // Check for path traversal using path.relative to prevent partial-name matching
  const relative = path.relative(getMdRoot(), resolved);
  const isSafe = !relative.startsWith('..') && !path.isAbsolute(relative);

  if (!isSafe) {
    return sendJSON(res, 403, { error: 'Access denied' });
  }

  try {
    // Reject symlinks that escape the vault (realpath throws ENOENT → 404 below)
    if (!(await isRealPathWithinMdRoot(resolved))) {
      return sendJSON(res, 403, { error: 'Access denied' });
    }
    const raw = await fs.promises.readFile(resolved, 'utf-8');
    sendJSON(res, 200, { content: raw, path: filePath, line: line || null });
  } catch (err) {
    sendJSON(res, 404, { error: 'File not found: ' + filePath });
  }
}

// ── API: Media & Image File Server ───────────────────────────
async function handleMedia(req, res, query) {
  let rawPath = query.path ? safeDecodeURIComponent(query.path).trim() : '';
  if (!rawPath) {
    res.writeHead(400, Object.assign({ 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
    return res.end('Missing path parameter');
  }

  // Normalize Windows path separators
  if (rawPath.includes('\\')) {
    rawPath = rawPath.replace(/\\/g, '/');
  }
  const baseName = path.basename(rawPath);
  const docPath = query.doc ? safeDecodeURIComponent(query.doc).trim() : '';
  const docFolder = docPath ? path.dirname(docPath) : '';

  const mdRoot = getMdRoot();
  let resolvedPath = null;

  // Candidate paths to check in order of priority (Climb from docFolder up to mdRoot)
  const candidates = [];

  let currFolder = docFolder;
  while (true) {
    if (currFolder && currFolder !== '.') {
      candidates.push(path.join(mdRoot, currFolder, rawPath));
      candidates.push(path.join(mdRoot, currFolder, baseName));
      candidates.push(path.join(mdRoot, currFolder, 'z-附件', baseName));
      candidates.push(path.join(mdRoot, currFolder, 'attachments', baseName));
      candidates.push(path.join(mdRoot, currFolder, 'media', baseName));
    } else {
      candidates.push(path.join(mdRoot, rawPath));
      candidates.push(path.join(mdRoot, baseName));
      candidates.push(path.join(mdRoot, 'z-附件', baseName));
      candidates.push(path.join(mdRoot, 'attachments', baseName));
      candidates.push(path.join(mdRoot, 'media', baseName));
    }
    if (!currFolder || currFolder === '.' || currFolder === '/' || currFolder === '') break;
    const parent = path.dirname(currFolder);
    if (parent === currFolder) break;
    currFolder = (parent === '.' || parent === '/') ? '' : parent;
  }

  for (const cand of candidates) {
    try {
      const stat = await fs.promises.stat(cand);
      if (stat.isFile()) {
        resolvedPath = cand;
        break;
      }
    } catch (_) {}
  }

  if (!resolvedPath) {
    res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
    return res.end('Media not found');
  }

  // Security check: ensure resolvedPath stays within mdRoot
  const relative = path.relative(mdRoot, resolvedPath);
  const isSafe = !relative.startsWith('..') && !path.isAbsolute(relative);
  if (!isSafe) {
    res.writeHead(403, Object.assign({ 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
    return res.end('Access denied');
  }

  // Symlink escape check: canonical target must stay within the vault
  if (!(await isRealPathWithinMdRoot(resolvedPath))) {
    res.writeHead(403, Object.assign({ 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
    return res.end('Access denied');
  }

  const ext = path.extname(resolvedPath).toLowerCase();
  const MIME_TYPES = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.bmp': 'image/bmp',
    '.pdf': 'application/pdf'
  };
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  try {
    const stat = await fs.promises.stat(resolvedPath);
    const etag = `W/"${stat.size}-${stat.mtimeMs}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, Object.assign({ 'ETag': etag, 'Cache-Control': 'public, max-age=86400' }, SECURITY_HEADERS));
      return res.end();
    }

    if (req.method === 'HEAD') {
      res.writeHead(200, Object.assign({
        'Content-Type': contentType,
        'Content-Length': stat.size,
        'ETag': etag,
        'Cache-Control': 'public, max-age=86400'
      }, SECURITY_HEADERS));
      return res.end();
    }

    const stream = fs.createReadStream(resolvedPath);
    const mediaHeaders = {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'ETag': etag,
      'Cache-Control': 'public, max-age=86400'
    };
    // Directly navigating to a vault .svg serves an executable same-origin document.
    // A restrictive CSP neutralizes any embedded script without affecting <img> use.
    if (ext === '.svg') {
      mediaHeaders['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'";
    }
    res.writeHead(200, Object.assign({}, SECURITY_HEADERS, mediaHeaders));
    stream.pipe(res);
    // Destroy the source stream on early client disconnect to avoid fd/buffer leaks.
    req.on('close', () => stream.destroy());
    res.on('close', () => stream.destroy());
  } catch (err) {
    res.writeHead(500, Object.assign({ 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
    res.end('Error serving media');
  }
}


async function handleRender(req, res, query) {
  let filePath = query.path;
  if (!filePath || filePath.includes('\0')) {
    return sendJSON(res, 400, { error: 'Invalid path' });
  }

  // Normalize path segments (remove spaces around slashes)
  filePath = filePath.replace(/\\/g, '/').split('/').map(s => s.trim()).filter(Boolean).join('/');

  const { root, fsRel } = resolveRoot(filePath);
  let resolved = path.resolve(path.join(root, fsRel));

  // Fallback: if resolved file doesn't exist directly, try with .md extension
  if (!fs.existsSync(resolved) && !filePath.endsWith('.md')) {
    const mdCandidate = path.resolve(path.join(root, fsRel + '.md'));
    if (fs.existsSync(mdCandidate)) {
      resolved = mdCandidate;
      filePath = filePath + '.md';
    }
  }

  const relative = path.relative(root, resolved);
  const isSafe = !relative.startsWith('..') && !path.isAbsolute(relative);
  if (!isSafe) return sendJSON(res, 403, { error: 'Access denied' });

  try {
    const renderStart = Date.now();
    const stat = await fs.promises.stat(resolved);
    // Symlink escape check: canonical target must stay within its root
    if (!(await isRealPathWithinRoot(root, resolved))) {
      return sendJSON(res, 403, { error: 'Access denied' });
    }
    const etag = `W/"${stat.size}-${stat.mtimeMs}"`;
    if (req.headers['if-none-match'] === etag) {
      Logger.debug('Render', `304 Not Modified: "${filePath}" (${Date.now() - renderStart}ms)`);
      res.writeHead(304, Object.assign({ 'ETag': etag, 'Cache-Control': 'no-cache' }, SECURITY_HEADERS));
      res.end();
      return;
    }

    let raw = await fs.promises.readFile(resolved, 'utf-8');

    // Strip frontmatter before rendering (O(1) fast scanning without regex string-duplication)
    let frontmatter = {};
    if (raw.startsWith('---\n') || raw.startsWith('---\r\n')) {
      const isCrlf = raw.startsWith('---\r\n');
      const startOffset = isCrlf ? 5 : 4;
      const endFmIndex = raw.indexOf(isCrlf ? '\r\n---' : '\n---', startOffset);
      if (endFmIndex !== -1) {
        const fmText = raw.substring(startOffset, endFmIndex);
        fmText.split(/\r?\n/).forEach((l) => {
          const idx = l.indexOf(':');
          if (idx !== -1) {
            const k = l.substring(0, idx).trim();
            const v = l.substring(idx + 1).trim();
            if (k) frontmatter[k] = v;
          }
        });
        const contentStart = endFmIndex + (isCrlf ? 5 : 4);
        const nextNL = raw.indexOf('\n', contentStart);
        raw = nextNL !== -1 ? raw.substring(nextNL + 1) : raw.substring(contentStart);
      }
    }

    // Offload CPU-bound rendering to worker thread pool
    const html = await renderWithWorker(raw, filePath);
    Logger.info('Render', `Loaded document: "${filePath}" (${Date.now() - renderStart}ms)`, req, { path: filePath });

    // Encode frontmatter as base64 in response header (avoids JSON wrapping the HTML)
    const metaHeader = Buffer.from(JSON.stringify(frontmatter), 'utf-8').toString('base64');

    const responseHeaders = Object.assign({
      'Content-Type': 'text/html; charset=utf-8',
      'ETag': etag,
      'Cache-Control': 'no-cache',
      'X-Document-Meta': metaHeader,
    }, SECURITY_HEADERS);

    // Gzip compress if client supports it — reduces payload ~10x
    const acceptEncoding = req.headers['accept-encoding'] || '';
    if (acceptEncoding.includes('gzip')) {
      zlib.gzip(Buffer.from(html, 'utf-8'), { level: zlib.constants.Z_BEST_SPEED }, (err, compressed) => {
        if (err) {
          res.writeHead(200, responseHeaders);
          res.end(html);
          return;
        }
        res.writeHead(200, Object.assign(responseHeaders, {
          'Content-Encoding': 'gzip',
          'Content-Length': compressed.length,
        }));
        res.end(compressed);
      });
    } else {
      res.writeHead(200, responseHeaders);
      res.end(html);
    }
  } catch (err) {
    sendJSON(res, 404, { error: 'File not found: ' + filePath });
  }
}

// ── API: Section Index (large-file chunk metadata) ────────────────────────
// Multi-root path resolution. Dictionary files live outside the vault in
// config.settings.dictionaryPath and are addressed with a `dict:` prefix that rides
// through the client's opaque path string. `fsRel` is joined against the root on
// disk; `relPath` keeps the `dict:` prefix so cache keys / response `file` never
// collide with same-named vault files.
function resolveRoot(filePath) {
  const p = String(filePath || '');
  if (p.startsWith('dict:')) {
    return { root: config.settings.dictionaryPath, fsRel: p.slice(5), relPath: p };
  }
  return { root: getMdRoot(), fsRel: p, relPath: p };
}

// Normalizes + resolves a markdown path with the same traversal guard as handleRender.
function resolveMdPath(filePath) {
  let p = String(filePath || '').replace(/\\/g, '/').split('/').map(s => s.trim()).filter(Boolean).join('/');
  if (!p || p.includes('\0')) return null;
  const { root, fsRel, relPath } = resolveRoot(p);
  let resolved = path.resolve(path.join(root, fsRel));
  let outFsRel = fsRel;
  let outRelPath = relPath;
  if (!fs.existsSync(resolved) && !fsRel.endsWith('.md')) {
    const candidate = path.resolve(path.join(root, fsRel + '.md'));
    if (fs.existsSync(candidate)) { resolved = candidate; outFsRel = fsRel + '.md'; outRelPath = relPath + '.md'; }
  }
  const relative = path.relative(root, resolved);
  const isSafe = !relative.startsWith('..') && !path.isAbsolute(relative);
  if (!isSafe) return null;
  return { resolved, relPath: outRelPath, root };
}

async function handleSectionIndex(req, res, query) {
  const r = resolveMdPath(query.path);
  if (!r) return sendJSON(res, 404, { error: 'File not found' });

  try {
    const stat = await fs.promises.stat(r.resolved);
    // Symlink escape check: canonical target must stay within the vault
    if (!(await isRealPathWithinRoot(r.root, r.resolved))) {
      return sendJSON(res, 403, { error: 'Access denied' });
    }
    if (stat.size < LARGE_FILE_MIN_BYTES) {
      return sendJSON(res, 200, { large: false });
    }
    const idx = await getSectionIndex(r.resolved, stat, r.relPath);
    if (!idx || idx.entries.length === 0) {
      return sendJSON(res, 200, { large: false });
    }

    const etag = `W/"${stat.size}-${stat.mtimeMs}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, Object.assign({ 'ETag': etag, 'Cache-Control': 'no-cache' }, SECURITY_HEADERS));
      res.end();
      return;
    }

    // Trimmed client payload: only what the frontend needs for TOC + navigation.
    const entries = idx.entries.map(e => ({
      h: e.headword,
      ls: e.lineStart,
      le: e.lineEnd,
      level: e.level || (e.groupIdx > 0 ? e.groupIdx : 1)
    }));
    const groups = (idx.groups || []).map(g => ({ h: g.headword, first: g.firstEntry, last: g.lastEntry }));
    // Precomputed chunk boundaries (byte-bounded), so the client requests exactly
    // the ranges the chunk renderer will produce — no off-by-whole-chunk drift.
    const chunks = computeChunkRanges(idx);

    // Count a large-file open as a "view" so virtualized reads are visible to
    // analytics. `/api/section-index` is fetched once per open (mirroring the
    // Render log in handleRender); we log on the fresh-200 path only, matching
    // handleRender's skip on 304. Never log here per-chunk — that would inflate
    // views by the number of scrolled chunks.
    Logger.info('Render', `Loaded document (virtualized): "${r.relPath}"`, req, { path: r.relPath });

    res.setHeader('ETag', etag);
    sendJSON(res, 200, {
      large: true,
      file: idx.relPath,
      entryLevel: idx.entryLevel,
      preambleLineCount: idx.preambleLineCount,
      totalLines: idx.totalLines,
      entries,
      groups,
      chunks,
    });
  } catch (err) {
    sendJSON(res, 404, { error: 'File not found: ' + query.path });
  }
}

// ── API: Chunked Render (renders a slice of a large file) ─────────────────
const CHUNK_ENTRIES = 100;     // default max entries per chunk
const CHUNK_MAX_BYTES = 262144; // 256KB safety cap per render job

// Deterministic tiling of a large file's entries into byte-bounded chunks.
// Mirrors handleRenderChunk's from/to clamping exactly, so the client can
// request chunks by their precomputed [from, to] boundaries.
function computeChunkRanges(idx) {
  const total = idx.entries.length;
  const ranges = [];
  let from = 0;
  while (from < total) {
    let to = Math.min(from + CHUNK_ENTRIES - 1, total - 1);
    let start = (from === 0) ? 0 : idx.entries[from].offset;
    let end = idx.entries[to].offset + idx.entries[to].len;
    while (to > from && (end - start) > CHUNK_MAX_BYTES) {
      to--;
      end = idx.entries[to].offset + idx.entries[to].len;
    }
    ranges.push({
      from,
      to,
      lineStart: (from === 0) ? 1 : idx.entries[from].lineStart,
    });
    from = to + 1;
  }
  return ranges;
}

async function handleRenderChunk(req, res, query) {
  const r = resolveMdPath(query.path);
  if (!r) return sendJSON(res, 404, { error: 'File not found' });

  let from = parseInt(query.from, 10);
  let to = parseInt(query.to, 10);
  if (Number.isNaN(from) || Number.isNaN(to) || from < 0 || to < from) {
    return sendJSON(res, 400, { error: 'Invalid from/to range' });
  }

  try {
    const stat = await fs.promises.stat(r.resolved);
    // Symlink escape check: canonical target must stay within the vault
    if (!(await isRealPathWithinRoot(r.root, r.resolved))) {
      return sendJSON(res, 403, { error: 'Access denied' });
    }
    if (stat.size < LARGE_FILE_MIN_BYTES) {
      return handleRender(req, res, query); // small file: full render
    }
    const idx = await getSectionIndex(r.resolved, stat, r.relPath);
    if (!idx || idx.entries.length === 0) {
      return handleRender(req, res, query);
    }

    const total = idx.entries.length;
    from = Math.max(0, Math.min(from, total - 1));
    to = Math.max(from, Math.min(to, total - 1));
    if (to - from + 1 > CHUNK_ENTRIES) to = from + CHUNK_ENTRIES - 1;

    let start = (from === 0) ? 0 : idx.entries[from].offset;
    let end = idx.entries[to].offset + idx.entries[to].len;
    while (to > from && (end - start) > CHUNK_MAX_BYTES) {
      to--;
      end = idx.entries[to].offset + idx.entries[to].len;
    }

    const lineOffset = (from === 0) ? 0 : (idx.entries[from].lineStart - 1);
    const byteLen = end - start;

    const fh = await fs.promises.open(r.resolved, 'r');
    let body;
    try {
      const buf = Buffer.alloc(byteLen);
      await fh.read(buf, 0, byteLen, start);
      body = buf.toString('utf-8');
    } finally {
      await fh.close();
    }

    const html = await renderWithWorker(body, r.relPath, lineOffset);

    const metaHeader = Buffer.from(JSON.stringify({
      from,
      to,
      lineStart: (from === 0) ? 1 : idx.entries[from].lineStart,
      totalEntries: total,
    }), 'utf-8').toString('base64');

    const etag = `W/"${stat.size}-${stat.mtimeMs}-${from}-${to}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, Object.assign({ 'ETag': etag, 'Cache-Control': 'no-cache' }, SECURITY_HEADERS));
      res.end();
      return;
    }

    const responseHeaders = Object.assign({
      'Content-Type': 'text/html; charset=utf-8',
      'ETag': etag,
      'Cache-Control': 'no-cache',
      'X-Chunk-Meta': metaHeader,
    }, SECURITY_HEADERS);

    const acceptEncoding = req.headers['accept-encoding'] || '';
    if (acceptEncoding.includes('gzip')) {
      zlib.gzip(Buffer.from(html, 'utf-8'), { level: zlib.constants.Z_BEST_SPEED }, (err, compressed) => {
        if (err) {
          res.writeHead(200, responseHeaders);
          res.end(html);
          return;
        }
        res.writeHead(200, Object.assign(responseHeaders, { 'Content-Encoding': 'gzip', 'Content-Length': compressed.length }));
        res.end(compressed);
      });
    } else {
      res.writeHead(200, responseHeaders);
      res.end(html);
    }
  } catch (err) {
    sendJSON(res, 404, { error: 'File not found: ' + query.path });
  }
}

// ── API: Full-text Search ────────────────────────────────────
async function collectFilesAsync(dir, relativePath = '') {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    return [];
  }
  let files = [];
  const promises = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    const relPath = relativePath ? relativePath + '/' + entry.name : entry.name;
    if (entry.isDirectory()) {
      promises.push(
        collectFilesAsync(fullPath, relPath).then(subFiles => {
          files = files.concat(subFiles);
        })
      );
    } else if (entry.name.endsWith('.md')) {
      files.push({ fullPath, relPath, name: entry.name });
    }
  }
  await Promise.all(promises);
  return files;
}

function flattenTreeToFiles(nodes, mdRoot) {
  const files = [];
  function walk(nodeList) {
    for (const node of nodeList) {
      if (node.type === 'directory' && node.children) {
        walk(node.children);
      } else if (node.type === 'file') {
        files.push({
          fullPath: path.join(mdRoot, node.path),
          relPath: node.path,
          name: node.name + '.md',
          size: node.size || 0
        });
      }
    }
  }
  walk(nodes);
  return files;
}

// ── Full-Text Bigram Inverted Index ──────────────────────────────
const SEARCH_INDEX_CACHE_FILE = path.join(LOG_DIR, 'search-index-cache.json');
const SEARCH_INDEX_CACHE_BIN = path.join(LOG_DIR, 'search-index-cache.bin');

let searchIndex = {
  ready: false,
  building: false,
  vaultSig: null,
  createdAt: null,
  fileList: [],         // [{ id, relPath, name, fullPath }]
  fileMap: new Map(),   // relPath -> fileId
  units: [],            // unitId -> { fileId, entryIndex(-1=whole file), headword, byteOffset, byteLength, lineStart }
  bigrams: new Map(),   // bigram (e.g. "成無") -> number or Uint16Array/Uint32Array of unitId
};

// ── Document Section Index (large-file chunking + entry-level search) ────────
const LARGE_FILE_MIN_BYTES = 1024 * 1024; // files >= 1MB get a section index
const SECTION_INDEX_CACHE_BIN = path.join(LOG_DIR, 'section-index-cache.bin');
const DICT_SECTION_INDEX_CACHE_BIN = path.join(LOG_DIR, 'dict-section-index-cache.bin');
const SECTION_INDEX_MAGIC = 0x53455832; // "SEX2"
const SECTION_INDEX_MAX_CACHE = 20;

const sectionIndexCache = new Map();    // relPath -> section index object (LRU, insertion order)
const dictSectionIndexCache = new Map(); // dict: relPath -> section index (unbounded; only a few dict files)
const sectionIndexPromises = new Map(); // relPath -> Promise (dedupe concurrent builds)
let sectionIndexBinLoaded = false;
let dictSectionIndexBinLoaded = false;
let sectionJobSeq = 0;

function setSectionIndex(relPath, idx) {
  if (sectionIndexCache.has(relPath)) sectionIndexCache.delete(relPath);
  sectionIndexCache.set(relPath, idx);
  while (sectionIndexCache.size > SECTION_INDEX_MAX_CACHE) {
    const oldest = sectionIndexCache.keys().next().value;
    sectionIndexCache.delete(oldest);
  }
}

function invalidateSectionIndexes() {
  sectionIndexCache.clear();
  sectionIndexBinLoaded = false;
}

function invalidateDictSectionIndexes() {
  dictSectionIndexCache.clear();
  dictSectionIndexBinLoaded = false;
}

/**
 * Builds a section index for one file in a transient worker_thread.
 * Section scanning is IO-bound, so files are parallelized across workers by the
 * caller (one worker per file), never within a single file.
 */
function buildSectionIndex(relPath, fullPath) {
  return new Promise((resolve, reject) => {
    const WORKER_PATH = path.join(APP_ROOT, 'index-worker.js');
    const w = new Worker(WORKER_PATH);
    const jobId = `section-${++sectionJobSeq}`;
    let settled = false;
    let timeout = null;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      try { w.terminate(); } catch (_) {}
      fn(arg);
    };
    // A hung section-scan worker would otherwise leave the request promise pending
    // forever; time out and terminate it like the render pool does.
    timeout = setTimeout(() => finish(reject, new Error('section worker timed out')), JOB_TIMEOUT_MS);
    w.on('message', ({ jobId: rId, ok, result, error }) => {
      if (rId !== jobId) return;
      if (ok) finish(resolve, result);
      else finish(reject, new Error(error || 'section worker failed'));
    });
    w.on('error', (err) => finish(reject, err));
    w.on('exit', (code) => finish(reject, new Error(`section worker exited with code ${code}`)));
    w.postMessage({ type: 'section', jobId, fullPath });
  });
}

async function getSectionIndex(fullPath, stat, relPath) {
  // Dictionary files use a separate, unbounded cache + dedicated bin so their
  // (large) section indexes are never evicted by the vault's 20-entry LRU.
  const isDict = relPath.startsWith('dict:');
  const cache = isDict ? dictSectionIndexCache : sectionIndexCache;

  // 1. In-memory (validate against current size/mtime)
  const cached = cache.get(relPath);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    if (!isDict) setSectionIndex(relPath, cached); // refresh LRU order
    return cached;
  }

  // 2. Binary disk cache (load all once; small — only large files are indexed)
  const binPath = isDict ? DICT_SECTION_INDEX_CACHE_BIN : SECTION_INDEX_CACHE_BIN;
  const binLoaded = isDict ? dictSectionIndexBinLoaded : sectionIndexBinLoaded;
  if (!binLoaded) {
    if (isDict) dictSectionIndexBinLoaded = true;
    else sectionIndexBinLoaded = true;
    try {
      const all = await loadAllSectionIndexesFromBinAsync(binPath);
      for (const idx of all) {
        if (isDict) dictSectionIndexCache.set(idx.relPath, idx);
        else setSectionIndex(idx.relPath, idx);
      }
    } catch (_) {}
    const binHit = cache.get(relPath);
    if (binHit && binHit.size === stat.size && binHit.mtimeMs === stat.mtimeMs) return binHit;
  }

  // 3. Build (dedupe concurrent builds for the same file)
  const existing = sectionIndexPromises.get(relPath);
  if (existing) return existing;

  const promise = (async () => {
    const result = await buildSectionIndex(relPath, fullPath);
    const idx = {
      relPath,
      fullPath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      entryLevel: result.entryLevel,
      preambleLineCount: result.preambleLineCount,
      totalLines: result.totalLines,
      totalBytes: result.totalBytes,
      entries: result.entries,
      groups: result.groups,
    };
    if (isDict) dictSectionIndexCache.set(relPath, idx);
    else setSectionIndex(relPath, idx);
    sectionIndexPromises.delete(relPath);

    // Persist to disk asynchronously in the background
    if (isDict) saveDictSectionIndexBinAsync();
    else saveSectionIndexBinAsync();

    return idx;
  })().catch((err) => {
    sectionIndexPromises.delete(relPath);
    throw err;
  });

  sectionIndexPromises.set(relPath, promise);
  return promise;
}

/**
 * Aggregate binary format (one file, one section each):
 *   magic u32 | fileCount u32 | per-file records...
 * Per-file record:
 *   relPathLen u16 + relPath | size u32 | mtimeMs f64 | entryLevel u8 |
 *   preambleLineCount u32 | totalLines u32 | totalBytes u32 |
 *   entryCount u32 | groupCount u32 |
 *   entries: [ headwordLen u16 + headword | offset u32 | len u32 | lineStart u32 | lineEnd u32 | groupIdx i16 ]
 *   groups:  [ headwordLen u16 + headword | level u8 | firstEntry u32 | lastEntry u32 ]
 */
async function loadAllSectionIndexesFromBinAsync(binPath = SECTION_INDEX_CACHE_BIN) {
  const result = [];
  if (!fs.existsSync(binPath)) return result;
  const buf = await fs.promises.readFile(binPath);
  if (buf.length < 8) return result;
  let pos = 0;
  if (buf.readUInt32BE(pos) !== SECTION_INDEX_MAGIC) return result;
  pos += 4;
  const fileCount = buf.readUInt32BE(pos); pos += 4;

  for (let f = 0; f < fileCount; f++) {
    const relLen = buf.readUInt16BE(pos); pos += 2;
    const relPath = buf.toString('utf-8', pos, pos + relLen); pos += relLen;
    const size = buf.readUInt32BE(pos); pos += 4;
    const mtimeMs = buf.readDoubleBE(pos); pos += 8;
    const entryLevel = buf.readUInt8(pos); pos += 1;
    const preambleLineCount = buf.readUInt32BE(pos); pos += 4;
    const totalLines = buf.readUInt32BE(pos); pos += 4;
    const totalBytes = buf.readUInt32BE(pos); pos += 4;
    const entryCount = buf.readUInt32BE(pos); pos += 4;
    const groupCount = buf.readUInt32BE(pos); pos += 4;

    const entries = new Array(entryCount);
    for (let i = 0; i < entryCount; i++) {
      const hLen = buf.readUInt16BE(pos); pos += 2;
      const headword = buf.toString('utf-8', pos, pos + hLen); pos += hLen;
      const offset = buf.readUInt32BE(pos); pos += 4;
      const len = buf.readUInt32BE(pos); pos += 4;
      const lineStart = buf.readUInt32BE(pos); pos += 4;
      const lineEnd = buf.readUInt32BE(pos); pos += 4;
      const groupIdx = buf.readInt16BE(pos); pos += 2;
      const level = (groupIdx >= 1 && groupIdx <= 6) ? groupIdx : 1;
      entries[i] = { headword, offset, len, lineStart, lineEnd, groupIdx, level };
    }

    const groups = new Array(groupCount);
    for (let i = 0; i < groupCount; i++) {
      const hLen = buf.readUInt16BE(pos); pos += 2;
      const headword = buf.toString('utf-8', pos, pos + hLen); pos += hLen;
      const level = buf.readUInt8(pos); pos += 1;
      const firstEntry = buf.readUInt32BE(pos); pos += 4;
      const lastEntry = buf.readUInt32BE(pos); pos += 4;
      groups[i] = { headword, level, firstEntry, lastEntry };
    }

    result.push({ relPath, size, mtimeMs, entryLevel, preambleLineCount, totalLines, totalBytes, entries, groups });
  }
  return result;
}

// Serializes section-index disk saves. Building several large-file indexes in
// quick succession triggers concurrent saves, and each writer reuses the same
// `.tmp` path — one writer's `rename` consumes it, leaving the other's rename
// failing with ENOENT. Chaining them makes writes strictly sequential.
let sectionIndexSaveChain = Promise.resolve();

async function saveSectionIndexBinAsync() {
  sectionIndexSaveChain = sectionIndexSaveChain.then(() => doSaveSectionIndexBin(sectionIndexCache, SECTION_INDEX_CACHE_BIN, 'section-index'));
  return sectionIndexSaveChain;
}

async function saveDictSectionIndexBinAsync() {
  sectionIndexSaveChain = sectionIndexSaveChain.then(() => doSaveSectionIndexBin(dictSectionIndexCache, DICT_SECTION_INDEX_CACHE_BIN, 'dict-section-index'));
  return sectionIndexSaveChain;
}

async function doSaveSectionIndexBin(cache, binPath, label) {
  try {
    const saveStart = Date.now();
    const files = Array.from(cache.values());
    if (files.length === 0) return;

    fs.mkdirSync(LOG_DIR, { recursive: true });

    let totalBytes = 4 + 4; // magic + fileCount
    for (const idx of files) {
      totalBytes += 2 + Buffer.byteLength(idx.relPath) + 4 + 8 + 1 + 4 + 4 + 4 + 4 + 4;
      for (const e of idx.entries) totalBytes += 2 + Buffer.byteLength(e.headword) + 4 + 4 + 4 + 4 + 2;
      for (const g of idx.groups) totalBytes += 2 + Buffer.byteLength(g.headword) + 1 + 4 + 4;
    }

    const buf = Buffer.allocUnsafe(totalBytes);
    let pos = 0;
    buf.writeUInt32BE(SECTION_INDEX_MAGIC, pos); pos += 4;
    buf.writeUInt32BE(files.length, pos); pos += 4;

    for (const idx of files) {
      const relB = Buffer.from(idx.relPath);
      buf.writeUInt16BE(relB.length, pos); pos += 2;
      relB.copy(buf, pos); pos += relB.length;
      buf.writeUInt32BE(idx.size, pos); pos += 4;
      buf.writeDoubleBE(idx.mtimeMs, pos); pos += 8;
      buf.writeUInt8(idx.entryLevel, pos); pos += 1;
      buf.writeUInt32BE(idx.preambleLineCount, pos); pos += 4;
      buf.writeUInt32BE(idx.totalLines, pos); pos += 4;
      buf.writeUInt32BE(idx.totalBytes, pos); pos += 4;
      buf.writeUInt32BE(idx.entries.length, pos); pos += 4;
      buf.writeUInt32BE(idx.groups.length, pos); pos += 4;

      for (const e of idx.entries) {
        const hB = Buffer.from(e.headword);
        buf.writeUInt16BE(hB.length, pos); pos += 2;
        hB.copy(buf, pos); pos += hB.length;
        buf.writeUInt32BE(e.offset, pos); pos += 4;
        buf.writeUInt32BE(e.len, pos); pos += 4;
        buf.writeUInt32BE(e.lineStart, pos); pos += 4;
        buf.writeUInt32BE(e.lineEnd, pos); pos += 4;
        const gIdx = e.level || e.groupIdx || 1;
        buf.writeInt16BE(gIdx, pos); pos += 2;
      }
      for (const g of idx.groups) {
        const hB = Buffer.from(g.headword);
        buf.writeUInt16BE(hB.length, pos); pos += 2;
        hB.copy(buf, pos); pos += hB.length;
        buf.writeUInt8(g.level, pos); pos += 1;
        buf.writeUInt32BE(g.firstEntry, pos); pos += 4;
        buf.writeUInt32BE(g.lastEntry, pos); pos += 4;
      }
    }

    const tmpFile = binPath + '.tmp';
    await fs.promises.writeFile(tmpFile, buf);
    try {
      await fs.promises.rename(tmpFile, binPath);
    } catch (err) {
      // Defense-in-depth: if the target already exists (e.g. a stray concurrent
      // save), the cache is effectively committed — ignore the ENOENT rather than
      // logging a spurious error. Any other error is real and rethrown.
      if (err.code === 'ENOENT' && fs.existsSync(binPath)) {
        // no-op: another writer already committed an equivalent file
      } else {
        throw err;
      }
    }
    Logger.info('Index', `Saved ${label} cache (${(buf.length / 1024 / 1024).toFixed(2)} MB, ${files.length} file(s)) in ${Date.now() - saveStart}ms`);
  } catch (err) {
    Logger.error('Index', `Failed to save ${label} cache`, err);
  }
}

/**
 * Computes a quick fingerprint of all files in vault based on path, size, and mtime
 */
function computeVaultSignature(files) {
  const sortedPaths = files.map(f => f.relPath).sort();
  const hash = crypto.createHash('md5');
  hash.update(`count:${sortedPaths.length}\n`);
  for (let i = 0; i < sortedPaths.length; i++) {
    hash.update(sortedPaths[i] + '\n');
  }
  return hash.digest('hex');
}

/**
 * Loads Bigram Index from binary disk cache (.bin) for ultra-fast startup and minimal RAM allocation
 */
async function loadSearchIndexFromBinCacheAsync(expectedVaultSig) {
  try {
    if (!fs.existsSync(SEARCH_INDEX_CACHE_BIN)) return false;
    Logger.info('Index', 'Loading Bigram Index from disk cache...');
    const loadStart = Date.now();
    const binBuf = await fs.promises.readFile(SEARCH_INDEX_CACHE_BIN);
    if (binBuf.length < 10) return false;

    let readPos = 0;
    const magic = binBuf.readUInt32BE(readPos); readPos += 4;
    // New v3 format magics (unit-level indexing). Old magics (0x42475831/32) are
    // deliberately rejected so a stale file-level cache is rebuilt.
    if (magic !== 0x42475833 && magic !== 0x42475834) return false;
    const isUint16Format = (magic === 0x42475833);

    const sigLen = binBuf.readUInt16BE(readPos); readPos += 2;
    const vaultSig = binBuf.toString('utf-8', readPos, readPos + sigLen); readPos += sigLen;

    if (vaultSig !== expectedVaultSig) {
      Logger.info('Index', `Disk cache signature mismatch (Expected: ${expectedVaultSig.substring(0, 8)}, Cached: ${vaultSig.substring(0, 8)}), rebuilding...`);
      return false;
    }

    const fileCount = binBuf.readUInt32BE(readPos); readPos += 4;
    const unitCount = binBuf.readUInt32BE(readPos); readPos += 4;
    const bigramCount = binBuf.readUInt32BE(readPos); readPos += 4;

    const fileList = new Array(fileCount);
    const fileMap = new Map();
    for (let i = 0; i < fileCount; i++) {
      const id = binBuf.readUInt32BE(readPos); readPos += 4;

      const relLen = binBuf.readUInt16BE(readPos); readPos += 2;
      const relPath = binBuf.toString('utf-8', readPos, readPos + relLen); readPos += relLen;

      const nameLen = binBuf.readUInt16BE(readPos); readPos += 2;
      const name = binBuf.toString('utf-8', readPos, readPos + nameLen); readPos += nameLen;

      const fullLen = binBuf.readUInt16BE(readPos); readPos += 2;
      const fullPath = binBuf.toString('utf-8', readPos, readPos + fullLen); readPos += fullLen;

      const fileObj = { id, relPath, name, fullPath };
      fileList[i] = fileObj;
      fileMap.set(relPath, id);
    }

    const units = new Array(unitCount);
    for (let i = 0; i < unitCount; i++) {
      const unitId = binBuf.readUInt32BE(readPos); readPos += 4;
      const fileId = binBuf.readUInt32BE(readPos); readPos += 4;
      const entryIndex = binBuf.readInt32BE(readPos); readPos += 4;

      const headwordLen = binBuf.readUInt16BE(readPos); readPos += 2;
      const headword = binBuf.toString('utf-8', readPos, readPos + headwordLen); readPos += headwordLen;

      const byteOffset = binBuf.readUInt32BE(readPos); readPos += 4;
      const byteLength = binBuf.readUInt32BE(readPos); readPos += 4;
      const lineStart = binBuf.readUInt32BE(readPos); readPos += 4;

      units[unitId] = { unitId, fileId, entryIndex, headword, byteOffset, byteLength, lineStart };
    }

    const bigrams = new Map();
    for (let i = 0; i < bigramCount; i++) {
      const bgLen = binBuf.readUInt8(readPos); readPos += 1;
      const bgStr = binBuf.toString('utf-8', readPos, readPos + bgLen); readPos += bgLen;
      const count = binBuf.readUInt32BE(readPos); readPos += 4;

      if (count === 1) {
        const singleId = isUint16Format ? binBuf.readUInt16BE(readPos) : binBuf.readUInt32BE(readPos);
        readPos += isUint16Format ? 2 : 4;
        bigrams.set(bgStr, singleId);
      } else {
        const arr = isUint16Format ? new Uint16Array(count) : new Uint32Array(count);
        if (isUint16Format) {
          for (let j = 0; j < count; j++) {
            arr[j] = binBuf.readUInt16BE(readPos); readPos += 2;
          }
        } else {
          for (let j = 0; j < count; j++) {
            arr[j] = binBuf.readUInt32BE(readPos); readPos += 4;
          }
        }
        bigrams.set(bgStr, arr);
      }
    }

    let createdAt = null;
    try {
      const stat = await fs.promises.stat(SEARCH_INDEX_CACHE_BIN);
      createdAt = stat.mtime ? stat.mtime.toISOString() : null;
    } catch (_) {}

    searchIndex = {
      ready: true,
      building: false,
      vaultSig: expectedVaultSig,
      createdAt,
      fileList,
      fileMap,
      units,
      bigrams
    };

    Logger.info('Index', `Loaded Bigram Index from disk cache: ${fileCount} files, ${unitCount} units, ${bigrams.size} bigrams in ${Date.now() - loadStart}ms`);
    if (global.gc) global.gc();
    return true;
  } catch (err) {
    Logger.error('Index', 'Failed to read binary search index cache', err);
    return false;
  }
}

/**
 * Saves Bigram index as compact binary cache file (.bin) atomically (Crash-Safe)
 */
async function saveSearchIndexBinCacheAsync(vaultSig, fileList, units, bigrams) {
  try {
    const saveStart = Date.now();
    const useUint16 = units.length < 65536;
    const magic = useUint16 ? 0x42475833 : 0x42475834;
    const bytesPerId = useUint16 ? 2 : 4;

    let totalBytes = 4 + 2 + Buffer.byteLength(vaultSig || '') + 4 + 4 + 4;

    for (const f of fileList) {
      totalBytes += 4 + 2 + Buffer.byteLength(f.relPath) + 2 + Buffer.byteLength(f.name) + 2 + Buffer.byteLength(f.fullPath);
    }

    for (const u of units) {
      totalBytes += 4 + 4 + 4 + 2 + Buffer.byteLength(u.headword || '') + 4 + 4 + 4;
    }

    const entries = Array.from(bigrams.entries());
    for (const entry of entries) {
      const bg = entry[0];
      const val = entry[1];
      const count = typeof val === 'number' ? 1 : val.length;
      totalBytes += 1 + Buffer.byteLength(bg) + 4 + (count * bytesPerId);
    }

    const buf = Buffer.allocUnsafe(totalBytes);
    let pos = 0;

    buf.writeUInt32BE(magic, pos); pos += 4;
    const sigBuf = Buffer.from(vaultSig || '');
    buf.writeUInt16BE(sigBuf.length, pos); pos += 2;
    sigBuf.copy(buf, pos); pos += sigBuf.length;

    buf.writeUInt32BE(fileList.length, pos); pos += 4;
    buf.writeUInt32BE(units.length, pos); pos += 4;
    buf.writeUInt32BE(entries.length, pos); pos += 4;

    for (const f of fileList) {
      buf.writeUInt32BE(f.id, pos); pos += 4;

      const relB = Buffer.from(f.relPath);
      buf.writeUInt16BE(relB.length, pos); pos += 2;
      relB.copy(buf, pos); pos += relB.length;

      const nameB = Buffer.from(f.name);
      buf.writeUInt16BE(nameB.length, pos); pos += 2;
      nameB.copy(buf, pos); pos += nameB.length;

      const fullB = Buffer.from(f.fullPath);
      buf.writeUInt16BE(fullB.length, pos); pos += 2;
      fullB.copy(buf, pos); pos += fullB.length;
    }

    for (const u of units) {
      buf.writeUInt32BE(u.unitId, pos); pos += 4;
      buf.writeUInt32BE(u.fileId, pos); pos += 4;
      buf.writeInt32BE(u.entryIndex, pos); pos += 4;

      const hwB = Buffer.from(u.headword || '');
      buf.writeUInt16BE(hwB.length, pos); pos += 2;
      hwB.copy(buf, pos); pos += hwB.length;

      buf.writeUInt32BE(u.byteOffset, pos); pos += 4;
      buf.writeUInt32BE(u.byteLength, pos); pos += 4;
      buf.writeUInt32BE(u.lineStart, pos); pos += 4;
    }

    for (const entry of entries) {
      const bgB = Buffer.from(entry[0]);
      const val = entry[1];
      const isSingle = typeof val === 'number';
      const count = isSingle ? 1 : val.length;

      buf.writeUInt8(bgB.length, pos); pos += 1;
      bgB.copy(buf, pos); pos += bgB.length;

      buf.writeUInt32BE(count, pos); pos += 4;

      if (useUint16) {
        if (isSingle) {
          buf.writeUInt16BE(val, pos); pos += 2;
        } else {
          for (let j = 0; j < count; j++) {
            buf.writeUInt16BE(val[j], pos); pos += 2;
          }
        }
      } else {
        if (isSingle) {
          buf.writeUInt32BE(val, pos); pos += 4;
        } else {
          for (let j = 0; j < count; j++) {
            buf.writeUInt32BE(val[j], pos); pos += 4;
          }
        }
      }
    }

    // Write to temporary file first and atomically rename for 100% crash-safe disk persistence
    const tmpCacheFile = SEARCH_INDEX_CACHE_BIN + '.tmp';
    await fs.promises.writeFile(tmpCacheFile, buf);
    await fs.promises.rename(tmpCacheFile, SEARCH_INDEX_CACHE_BIN);

    const sizeMb = (buf.length / (1024 * 1024)).toFixed(1);
    Logger.info('Index', `Saved Binary Bigram Index cache (${sizeMb} MB, ${units.length} units) atomically in ${Date.now() - saveStart}ms`);
  } catch (err) {
    Logger.error('Index', 'Failed to save binary search index cache', err);
  }
}

/**
 * Tries to load the Bigram index from disk cache if vault fingerprint matches
 */
async function loadSearchIndexFromCacheAsync(expectedVaultSig) {
  // Binary cache is the only on-disk format (the legacy JSON cache is retired).
  return loadSearchIndexFromBinCacheAsync(expectedVaultSig);
}

/**
 * Saves the compiled Bigram index to disk cache for fast server restart
 */
async function saveSearchIndexCacheAsync(vaultSig, fileList, bigrams) {
  try {
    const saveStart = Date.now();
    const bigramsArr = Array.from(bigrams.entries());
    const data = {
      version: '1.0',
      builtAt: new Date().toISOString(),
      vaultSig,
      fileList,
      bigrams: bigramsArr
    };
    const jsonStr = JSON.stringify(data);
    await fs.promises.writeFile(SEARCH_INDEX_CACHE_FILE, jsonStr, 'utf-8');
    const sizeMb = (Buffer.byteLength(jsonStr) / (1024 * 1024)).toFixed(1);
    Logger.info('Index', `Saved Bigram Index to disk cache (${sizeMb} MB) in ${Date.now() - saveStart}ms`);
  } catch (err) {
    Logger.error('Index', 'Failed to save search index cache', err);
  }
}

function extractBigrams(text, onBigram) {
  if (!text || typeof onBigram !== 'function') return;
  let prevChar = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if ((ch >= 0x4E00 && ch <= 0x9FFF) || (ch >= 0x3400 && ch <= 0x4DBF)) {
      const currChar = text[i];
      if (prevChar) {
        onBigram(prevChar + currChar);
      }
      prevChar = currChar;
    } else {
      prevChar = '';
    }
  }
}

function extractQueryBigrams(text) {
  const set = new Set();
  extractBigrams(text, (bg) => set.add(bg));
  return Array.from(set);
}

// Sorted-merge intersection of two ascending numeric arrays — O(n+m), zero heap
// allocation. Shared by full-vault search and dictionary full-text search.
function intersectSorted(a, b) {
  const result = [];
  let i = 0, j = 0;
  const aLen = a.length, bLen = b.length;
  while (i < aLen && j < bLen) {
    const av = a[i], bv = b[j];
    if (av < bv) i++;
    else if (av > bv) j++;
    else { result.push(av); i++; j++; }
  }
  return result;
}

let activeIndexBuildId = 0;

// Runs a pool of transient worker_threads over `tasks` with a shared counter.
// `buildMessage(task)` → { type, payload } (jobId is added by the pool);
// `onMessage(result, task)` processes one worker result (may throw to abort the pool).
async function runIndexWorkerPool(tasks, buildMessage, onMessage, concurrency) {
  let next = 0;
  const total = tasks.length;
  if (total === 0) return;

  async function runWorker(workerId) {
    const w = new Worker(path.join(APP_ROOT, 'index-worker.js'));
    let seq = 0;
    const pending = new Map(); // jobId -> { resolve, reject }
    w.on('message', (msg) => {
      const p = pending.get(msg.jobId);
      if (!p) return;
      pending.delete(msg.jobId);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || 'index worker error'));
    });
    w.on('error', (err) => {
      for (const p of pending.values()) p.reject(err);
      pending.clear();
    });
    w.on('exit', (code) => {
      if (code !== 0) {
        for (const p of pending.values()) p.reject(new Error('index worker exited ' + code));
        pending.clear();
      }
    });

    const request = (type, payload) => new Promise((resolve, reject) => {
      const jobId = `w${workerId}-${++seq}`;
      // Time out a hung scan so the thread and pending request don't leak forever.
      const timer = setTimeout(() => {
        if (pending.has(jobId)) {
          pending.delete(jobId);
          reject(new Error('index worker job timed out'));
        }
      }, JOB_TIMEOUT_MS);
      pending.set(jobId, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      w.postMessage({ type, jobId, ...payload });
    });

    try {
      while (true) {
        const i = next++;
        if (i >= total) break;
        const task = tasks[i];
        const { type, payload } = buildMessage(task);
        const result = await request(type, payload);
        onMessage(result, task);
      }
    } finally {
      try { w.terminate(); } catch (_) {}
    }
  }

  const workers = [];
  for (let i = 0; i < concurrency; i++) workers.push(runWorker(i));
  await Promise.all(workers);
}

async function buildSearchIndexAsync(forceRebuild = false) {
  if (searchIndex.building && !forceRebuild) return;

  const buildId = ++activeIndexBuildId;
  searchIndex.building = true;
  const indexStart = Date.now();

  try {
    if (!cachedTree || forceRebuild) {
      cachedTree = await scanDirAsync(getMdRoot(), '');
      setupTreeWatcher();
    }
    if (buildId !== activeIndexBuildId) {
      Logger.info('Index', `[Build #${buildId}] Aborted during initial directory scan.`);
      return;
    }

    const files = flattenTreeToFiles(cachedTree, getMdRoot());
    const vaultSig = computeVaultSignature(files);

    // If index is already ready and signature hasn't changed, skip rebuild!
    if (searchIndex.ready && searchIndex.vaultSig === vaultSig && !forceRebuild) {
      searchIndex.building = false;
      return;
    }

    // Try loading index from disk cache first if not forced
    if (!forceRebuild) {
      const loadedFromCache = await loadSearchIndexFromCacheAsync(vaultSig);
      if (buildId !== activeIndexBuildId) return;
      if (loadedFromCache) {
        Logger.info('Index', `Loaded valid Bigram Index from disk cache for ${files.length} files (${searchIndex.bigrams.size} unique 2-grams) in ${Date.now() - indexStart}ms (Vault Unchanged)`);
        searchIndex.building = false;
        return;
      }
    }

    Logger.info('Index', `Starting Full-text Bigram Inverted Index build #${buildId} for ${files.length} files...`);

    // Build the unit list: large files → one unit per dictionary entry; small files → one whole-file unit.
    const fileList = [];
    const fileMap = new Map();
    const units = [];
    let unitSeq = 0;

    for (let fIdx = 0; fIdx < files.length; fIdx++) {
      if (buildId !== activeIndexBuildId) {
        Logger.info('Index', `[Build #${buildId}] Aborted during unit construction.`);
        return;
      }
      const file = files[fIdx];
      const fileId = fIdx;
      fileList[fileId] = { id: fileId, relPath: file.relPath, name: file.name, fullPath: file.fullPath };
      fileMap.set(file.relPath, fileId);

      if ((file.size || 0) >= LARGE_FILE_MIN_BYTES) {
        let idx = null;
        try {
          const stat = await fs.promises.stat(file.fullPath);
          idx = await getSectionIndex(file.fullPath, stat, file.relPath);
        } catch (_) {}
        if (idx && idx.entries && idx.entries.length > 0) {
          for (let ei = 0; ei < idx.entries.length; ei++) {
            const e = idx.entries[ei];
            units.push({ unitId: unitSeq++, fileId, entryIndex: ei, headword: e.headword, byteOffset: e.offset, byteLength: e.len, lineStart: e.lineStart });
          }
          continue;
        }
        // Fall through to a whole-file unit if the section index failed to build.
      }
      units.push({ unitId: unitSeq++, fileId, entryIndex: -1, headword: '', byteOffset: 0, byteLength: file.size || 0, lineStart: 1 });
    }

    // Group units by file path so each worker task reads one file handle and reuses it.
    const byFile = new Map();
    for (const u of units) {
      const fullPath = fileList[u.fileId].fullPath;
      let g = byFile.get(fullPath);
      if (!g) { g = { fullPath, units: [] }; byFile.set(fullPath, g); }
      g.units.push({ unitId: u.unitId, byteOffset: u.byteOffset, byteLength: u.byteLength });
    }
    const tasks = Array.from(byFile.values());

    const bigrams = new Map();
    const concurrency = Math.max(1, Math.min(os.cpus().length - 1, 8));
    let doneUnits = 0;
    const totalUnits = units.length;

    await runIndexWorkerPool(tasks,
      (task) => ({ type: 'index-build-file', payload: { fullPath: task.fullPath, units: task.units } }),
      (result, task) => {
        for (const r of result.results) {
          for (const bg of r.bigrams) {
            let list = bigrams.get(bg);
            if (!list) { list = []; bigrams.set(bg, list); }
            list.push(r.unitId);
          }
        }
        doneUnits += task.units.length;
        if (doneUnits % 20000 === 0 || doneUnits === totalUnits) {
          Logger.info('Index', `Indexing progress (build #${buildId}): ${doneUnits}/${totalUnits} units...`);
        }
      },
      concurrency);

    if (buildId !== activeIndexBuildId) {
      Logger.info('Index', `[Build #${buildId}] Aborted: Vault files modified during indexing.`);
      return;
    }

    // Sort posting lists for O(n+m) sorted-merge intersection, then compact to TypedArrays
    const compactBigrams = new Map();
    const useUint16 = units.length < 65536;
    for (const [bg, list] of bigrams.entries()) {
      if (list.length === 1) {
        compactBigrams.set(bg, list[0]); // Primitive number (0 bytes V8 Heap overhead!)
      } else {
        list.sort((a, b) => a - b);
        compactBigrams.set(bg, useUint16 ? new Uint16Array(list) : new Uint32Array(list));
      }
    }

    const createdAt = new Date().toISOString();
    searchIndex = {
      ready: true,
      building: false,
      vaultSig,
      createdAt,
      fileList,
      fileMap,
      units,
      bigrams: compactBigrams
    };

    Logger.info('Index', `Full-text Bigram Index built #${buildId} for ${fileList.length} files / ${units.length} units (${compactBigrams.size} unique 2-grams) in ${Date.now() - indexStart}ms`);

    // Save binary cache to disk for ultra-fast server restarts
    await saveSearchIndexBinCacheAsync(vaultSig, fileList, units, compactBigrams);
    if (global.gc) global.gc();
  } catch (err) {
    if (buildId === activeIndexBuildId) {
      searchIndex.building = false;
    }
    Logger.error('Index', `Failed to build Bigram search index #${buildId}`, err);
  }
}

// ── Dictionary Index (dedicated full-text bigram index for dictionary files) ─
// Separate from the vault `searchIndex`: dictionaries live in their own root
// (config.settings.dictionaryPath), are entry-level (one unit per headword), and
// are served by `/api/dict-headwords` + `/api/dict-search` only — never mixed into
// the main vault search or its disk cache.
const DICT_INDEX_CACHE_BIN = path.join(LOG_DIR, 'dict-index-cache.bin');

let dictIndex = {
  ready: false,
  building: false,
  dictSig: null,
  fileList: [],       // [{ id, relPath:'dict:*.md', name:'*.md', fullPath }]
  fileMap: new Map(), // relPath -> fileId
  units: [],          // unitId -> { fileId, entryIndex, headword, byteOffset, byteLength, lineStart }
  bigrams: new Map(),
};
let activeDictIndexBuildId = 0;
let dictWatcher = null;
let dictWatcherDebounceTimer = null;

// Returns the configured dictionary root (absolute), or null when disabled/unset.
function getDictionaryPath() {
  if (!config.settings.dictionaryEnabled) return null;
  const p = config.settings.dictionaryPath;
  if (!p) return null;
  return path.resolve(p);
}

// Lists `.md` files directly inside the dictionary root (flat, non-recursive).
function cleanHeadword(hw) {
  return String(hw || '').replace(/^【/, '').replace(/】$/, '').trim();
}

const DICT_HEADING_RE = /^(#{1,6})\s+(.*)$/;

// Fallback entry counter: scans a dictionary file's headings directly when its
// section index is unavailable (e.g. index build failed in a fresh container).
// Counts the deepest heading level — the entry level per scanSections() in
// index-worker.js — and only non-empty headwords, matching the count that
// handleDictHeadwords reports from a built index. Ensures 辭典選擇 never shows 0.
async function scanDictEntryCount(fullPath) {
  let headings = [];
  try {
    const text = await fs.promises.readFile(fullPath, 'utf-8');
    for (const line of text.split('\n')) {
      const m = DICT_HEADING_RE.exec(line);
      if (!m) continue;
      headings.push({ depth: m[1].length, clean: !!cleanHeadword(m[2]) });
    }
  } catch (_) {
    return 0;
  }
  if (headings.length === 0) return 0;
  let entryLevel = 0;
  for (const h of headings) if (h.depth > entryLevel) entryLevel = h.depth;
  let count = 0;
  for (const h of headings) if (h.depth === entryLevel && h.clean) count++;
  return count;
}

async function scanDictFiles() {
  const root = getDictionaryPath();
  if (!root) return [];
  let entries;
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || !entry.isFile() || !entry.name.endsWith('.md')) continue;
    const fullPath = path.join(root, entry.name);
    let size = 0;
    try { size = fs.statSync(fullPath).size; } catch (_) {}
    files.push({ relPath: 'dict:' + entry.name, name: entry.name, fullPath, size });
  }
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return files;
}

// Fingerprint of the dictionary folder (path + size + mtime) so the disk cache
// is only reused when the dictionary files are byte-for-byte unchanged.
async function computeDictSignature(files) {
  const hash = crypto.createHash('md5');
  hash.update(`count:${files.length}\n`);
  for (const f of files) {
    let mtime = '';
    try { mtime = String((await fs.promises.stat(f.fullPath)).mtimeMs); } catch (_) {}
    hash.update(`${f.relPath}\n${f.size}\n${mtime}\n`);
  }
  return hash.digest('hex');
}

async function loadDictIndexFromBinCacheAsync(expectedDictSig) {
  try {
    if (!fs.existsSync(DICT_INDEX_CACHE_BIN)) return false;
    const loadStart = Date.now();
    const binBuf = await fs.promises.readFile(DICT_INDEX_CACHE_BIN);
    if (binBuf.length < 10) return false;

    let readPos = 0;
    const magic = binBuf.readUInt32BE(readPos); readPos += 4;
    if (magic !== 0x44475833 && magic !== 0x44475834) return false;
    const isUint16Format = (magic === 0x44475833);

    const sigLen = binBuf.readUInt16BE(readPos); readPos += 2;
    const dictSig = binBuf.toString('utf-8', readPos, readPos + sigLen); readPos += sigLen;
    if (dictSig !== expectedDictSig) return false;

    const fileCount = binBuf.readUInt32BE(readPos); readPos += 4;
    const unitCount = binBuf.readUInt32BE(readPos); readPos += 4;
    const bigramCount = binBuf.readUInt32BE(readPos); readPos += 4;

    const fileList = new Array(fileCount);
    const fileMap = new Map();
    for (let i = 0; i < fileCount; i++) {
      const id = binBuf.readUInt32BE(readPos); readPos += 4;
      const relLen = binBuf.readUInt16BE(readPos); readPos += 2;
      const relPath = binBuf.toString('utf-8', readPos, readPos + relLen); readPos += relLen;
      const nameLen = binBuf.readUInt16BE(readPos); readPos += 2;
      const name = binBuf.toString('utf-8', readPos, readPos + nameLen); readPos += nameLen;
      const fullLen = binBuf.readUInt16BE(readPos); readPos += 2;
      const fullPath = binBuf.toString('utf-8', readPos, readPos + fullLen); readPos += fullLen;
      const fileObj = { id, relPath, name, fullPath };
      fileList[i] = fileObj;
      fileMap.set(relPath, id);
    }

    const units = new Array(unitCount);
    for (let i = 0; i < unitCount; i++) {
      const unitId = binBuf.readUInt32BE(readPos); readPos += 4;
      const fileId = binBuf.readUInt32BE(readPos); readPos += 4;
      const entryIndex = binBuf.readInt32BE(readPos); readPos += 4;
      const headwordLen = binBuf.readUInt16BE(readPos); readPos += 2;
      const headword = binBuf.toString('utf-8', readPos, readPos + headwordLen); readPos += headwordLen;
      const byteOffset = binBuf.readUInt32BE(readPos); readPos += 4;
      const byteLength = binBuf.readUInt32BE(readPos); readPos += 4;
      const lineStart = binBuf.readUInt32BE(readPos); readPos += 4;
      units[unitId] = { unitId, fileId, entryIndex, headword, byteOffset, byteLength, lineStart };
    }

    const bigrams = new Map();
    for (let i = 0; i < bigramCount; i++) {
      const bgLen = binBuf.readUInt8(readPos); readPos += 1;
      const bgStr = binBuf.toString('utf-8', readPos, readPos + bgLen); readPos += bgLen;
      const count = binBuf.readUInt32BE(readPos); readPos += 4;
      if (count === 1) {
        const singleId = isUint16Format ? binBuf.readUInt16BE(readPos) : binBuf.readUInt32BE(readPos);
        readPos += isUint16Format ? 2 : 4;
        bigrams.set(bgStr, singleId);
      } else {
        const arr = isUint16Format ? new Uint16Array(count) : new Uint32Array(count);
        if (isUint16Format) {
          for (let j = 0; j < count; j++) { arr[j] = binBuf.readUInt16BE(readPos); readPos += 2; }
        } else {
          for (let j = 0; j < count; j++) { arr[j] = binBuf.readUInt32BE(readPos); readPos += 4; }
        }
        bigrams.set(bgStr, arr);
      }
    }

    let createdAt = null;
    try {
      const stat = await fs.promises.stat(DICT_INDEX_CACHE_BIN);
      createdAt = stat.mtime ? stat.mtime.toISOString() : null;
    } catch (_) {}

    dictIndex = { ready: true, building: false, dictSig: expectedDictSig, createdAt, fileList, fileMap, units, bigrams };
    Logger.info('DictIndex', `Loaded dictionary index from disk cache: ${fileCount} files, ${unitCount} units, ${bigrams.size} bigrams in ${Date.now() - loadStart}ms`);
    if (global.gc) global.gc();
    return true;
  } catch (err) {
    Logger.error('DictIndex', 'Failed to read dictionary index cache', err);
    return false;
  }
}

async function saveDictIndexBinCacheAsync(dictSig, fileList, units, bigrams) {
  try {
    const saveStart = Date.now();
    const useUint16 = units.length < 65536;
    const magic = useUint16 ? 0x44475833 : 0x44475834;
    const bytesPerId = useUint16 ? 2 : 4;

    let totalBytes = 4 + 2 + Buffer.byteLength(dictSig || '') + 4 + 4 + 4;
    for (const f of fileList) {
      totalBytes += 4 + 2 + Buffer.byteLength(f.relPath) + 2 + Buffer.byteLength(f.name) + 2 + Buffer.byteLength(f.fullPath);
    }
    for (const u of units) {
      totalBytes += 4 + 4 + 4 + 2 + Buffer.byteLength(u.headword || '') + 4 + 4 + 4;
    }
    const entries = Array.from(bigrams.entries());
    for (const entry of entries) {
      const val = entry[1];
      const count = typeof val === 'number' ? 1 : val.length;
      totalBytes += 1 + Buffer.byteLength(entry[0]) + 4 + (count * bytesPerId);
    }

    const buf = Buffer.allocUnsafe(totalBytes);
    let pos = 0;

    buf.writeUInt32BE(magic, pos); pos += 4;
    const sigBuf = Buffer.from(dictSig || '');
    buf.writeUInt16BE(sigBuf.length, pos); pos += 2;
    sigBuf.copy(buf, pos); pos += sigBuf.length;

    buf.writeUInt32BE(fileList.length, pos); pos += 4;
    buf.writeUInt32BE(units.length, pos); pos += 4;
    buf.writeUInt32BE(entries.length, pos); pos += 4;

    for (const f of fileList) {
      buf.writeUInt32BE(f.id, pos); pos += 4;
      const relB = Buffer.from(f.relPath);
      buf.writeUInt16BE(relB.length, pos); pos += 2; relB.copy(buf, pos); pos += relB.length;
      const nameB = Buffer.from(f.name);
      buf.writeUInt16BE(nameB.length, pos); pos += 2; nameB.copy(buf, pos); pos += nameB.length;
      const fullB = Buffer.from(f.fullPath);
      buf.writeUInt16BE(fullB.length, pos); pos += 2; fullB.copy(buf, pos); pos += fullB.length;
    }

    for (const u of units) {
      buf.writeUInt32BE(u.unitId, pos); pos += 4;
      buf.writeUInt32BE(u.fileId, pos); pos += 4;
      buf.writeInt32BE(u.entryIndex, pos); pos += 4;
      const hwB = Buffer.from(u.headword || '');
      buf.writeUInt16BE(hwB.length, pos); pos += 2; hwB.copy(buf, pos); pos += hwB.length;
      buf.writeUInt32BE(u.byteOffset, pos); pos += 4;
      buf.writeUInt32BE(u.byteLength, pos); pos += 4;
      buf.writeUInt32BE(u.lineStart, pos); pos += 4;
    }

    for (const entry of entries) {
      const bgB = Buffer.from(entry[0]);
      const val = entry[1];
      const isSingle = typeof val === 'number';
      const count = isSingle ? 1 : val.length;
      buf.writeUInt8(bgB.length, pos); pos += 1;
      bgB.copy(buf, pos); pos += bgB.length;
      buf.writeUInt32BE(count, pos); pos += 4;
      if (useUint16) {
        if (isSingle) { buf.writeUInt16BE(val, pos); pos += 2; }
        else { for (let j = 0; j < count; j++) { buf.writeUInt16BE(val[j], pos); pos += 2; } }
      } else {
        if (isSingle) { buf.writeUInt32BE(val, pos); pos += 4; }
        else { for (let j = 0; j < count; j++) { buf.writeUInt32BE(val[j], pos); pos += 4; } }
      }
    }

    const tmpCacheFile = DICT_INDEX_CACHE_BIN + '.tmp';
    await fs.promises.writeFile(tmpCacheFile, buf);
    await fs.promises.rename(tmpCacheFile, DICT_INDEX_CACHE_BIN);
    Logger.info('DictIndex', `Saved dictionary index cache (${(buf.length / 1048576).toFixed(1)} MB, ${units.length} units) in ${Date.now() - saveStart}ms`);
  } catch (err) {
    Logger.error('DictIndex', 'Failed to save dictionary index cache', err);
  }
}

async function buildDictIndexAsync(forceRebuild = false) {
  if (dictIndex.building && !forceRebuild) return;

  const buildId = ++activeDictIndexBuildId;
  dictIndex.building = true;
  const indexStart = Date.now();

  try {
    const files = await scanDictFiles();
    if (buildId !== activeDictIndexBuildId) return;
    const dictSig = await computeDictSignature(files);

    if (dictIndex.ready && dictIndex.dictSig === dictSig && !forceRebuild) {
      dictIndex.building = false;
      return;
    }

    if (files.length === 0) {
      dictIndex = { ready: false, building: false, dictSig: null, fileList: [], fileMap: new Map(), units: [], bigrams: new Map() };
      return;
    }

    if (!forceRebuild) {
      const loaded = await loadDictIndexFromBinCacheAsync(dictSig);
      if (buildId !== activeDictIndexBuildId) return;
      if (loaded) { dictIndex.building = false; return; }
    }

    // One unit per entry (dictionaries are entry-level; whole-file fallback only
    // if a section index can't be built for a small dictionary file).
    const fileList = [];
    const fileMap = new Map();
    const units = [];
    let unitSeq = 0;

    for (let fIdx = 0; fIdx < files.length; fIdx++) {
      if (buildId !== activeDictIndexBuildId) return;
      const file = files[fIdx];
      const fileId = fIdx;
      fileList[fileId] = { id: fileId, relPath: file.relPath, name: file.name, fullPath: file.fullPath };
      fileMap.set(file.relPath, fileId);

      let idx = null;
      try {
        const stat = await fs.promises.stat(file.fullPath);
        idx = await getSectionIndex(file.fullPath, stat, file.relPath);
      } catch (_) {}
      if (idx && idx.entries && idx.entries.length > 0) {
        for (let ei = 0; ei < idx.entries.length; ei++) {
          const e = idx.entries[ei];
          units.push({ unitId: unitSeq++, fileId, entryIndex: ei, headword: e.headword, byteOffset: e.offset, byteLength: e.len, lineStart: e.lineStart });
        }
        continue;
      }
      units.push({ unitId: unitSeq++, fileId, entryIndex: -1, headword: '', byteOffset: 0, byteLength: file.size || 0, lineStart: 1 });
    }

    const byFile = new Map();
    for (const u of units) {
      const fullPath = fileList[u.fileId].fullPath;
      let g = byFile.get(fullPath);
      if (!g) { g = { fullPath, units: [] }; byFile.set(fullPath, g); }
      g.units.push({ unitId: u.unitId, byteOffset: u.byteOffset, byteLength: u.byteLength });
    }
    const tasks = Array.from(byFile.values());

    const bigrams = new Map();
    const concurrency = Math.max(1, Math.min(os.cpus().length - 1, 8));

    await runIndexWorkerPool(tasks,
      (task) => ({ type: 'index-build-file', payload: { fullPath: task.fullPath, units: task.units } }),
      (result) => {
        for (const r of result.results) {
          for (const bg of r.bigrams) {
            let list = bigrams.get(bg);
            if (!list) { list = []; bigrams.set(bg, list); }
            list.push(r.unitId);
          }
        }
      },
      concurrency);

    if (buildId !== activeDictIndexBuildId) return;

    const compactBigrams = new Map();
    const useUint16 = units.length < 65536;
    for (const [bg, list] of bigrams.entries()) {
      if (list.length === 1) compactBigrams.set(bg, list[0]);
      else { list.sort((a, b) => a - b); compactBigrams.set(bg, useUint16 ? new Uint16Array(list) : new Uint32Array(list)); }
    }

    dictIndex = {
      ready: true,
      building: false,
      dictSig,
      createdAt: new Date().toISOString(),
      fileList,
      fileMap,
      units,
      bigrams: compactBigrams
    };

    Logger.info('DictIndex', `Dictionary full-text index built for ${fileList.length} files / ${units.length} entries (${compactBigrams.size} unique 2-grams) in ${Date.now() - indexStart}ms`);
    await saveDictIndexBinCacheAsync(dictSig, fileList, units, compactBigrams);
    if (global.gc) global.gc();
  } catch (err) {
    dictIndex.building = false;
    Logger.error('DictIndex', 'Failed to build dictionary index', err);
  }
}

function invalidateDictIndex() {
  activeDictIndexBuildId++;
  dictIndex.ready = false;
  dictIndex.building = false;
}

/**
 * Builds the section index for every dictionary file in the background so the
 * first dictionary open is warm even after a restart. buildDictIndexAsync can
 * short-circuit after loading the bigram bin without ever building a section
 * index (server.js:2758-2761), which leaves the first click paying a full
 * 23MB scan; this closes that gap. Fire-and-forget — never blocks boot.
 */
async function warmDictSectionIndexes() {
  try {
    const files = await scanDictFiles();
    for (const f of files) {
      const stat = await fs.promises.stat(f.fullPath);
      await getSectionIndex(f.fullPath, stat, f.relPath);
    }
  } catch (_) {}
}

function setupDictWatcher() {
  if (dictWatcher) return;
  const root = getDictionaryPath();
  if (!root || !fs.existsSync(root)) return;
  try {
    dictWatcher = fs.watch(root, (eventType, filename) => {
      if (filename && (filename.startsWith('.') || filename.includes('/.'))) return;
      invalidateDictIndex();
      invalidateDictSectionIndexes();
      if (dictWatcherDebounceTimer) clearTimeout(dictWatcherDebounceTimer);
      dictWatcherDebounceTimer = setTimeout(() => {
        dictWatcherDebounceTimer = null;
        buildDictIndexAsync(true).catch(() => {});
      }, 1500);
    });
  } catch (err) {
    Logger.error('DictIndex', 'Error setting up dictionary watcher', err);
  }
}

function resetDictWatcher() {
  if (dictWatcherDebounceTimer) { clearTimeout(dictWatcherDebounceTimer); dictWatcherDebounceTimer = null; }
  if (dictWatcher) { try { dictWatcher.close(); } catch (_) {} dictWatcher = null; }
  invalidateDictIndex();
  invalidateDictSectionIndexes();
}

// ── API: Dictionary Headwords (client-side prefix/fuzzy index) ────────────
async function handleDictHeadwords(req, res) {
  try {
    setupDictWatcher();
    const files = await scanDictFiles();
    if (files.length === 0) {
      return sendJSON(res, 200, { files: [], entries: [] });
    }

    // Compute per-file entry counts (cached section index, or a direct scan).
    const fileList = files.map(f => ({ path: f.relPath, name: f.name.replace(/\.md$/, ''), size: f.size, entryCount: 0 }));
    const perFileIdx = new Array(files.length).fill(null);
    const perFileMtime = new Array(files.length).fill('');
    for (let fi = 0; fi < files.length; fi++) {
      const f = files[fi];
      let stat = null;
      try { stat = await fs.promises.stat(f.fullPath); perFileMtime[fi] = String(stat.mtimeMs); } catch (_) {}
      let idx = null;
      try {
        if (stat) idx = await getSectionIndex(f.fullPath, stat, f.relPath);
      } catch (_) {}
      perFileIdx[fi] = idx;
      if (idx && idx.entries && idx.entries.length > 0) {
        for (const e of idx.entries) {
          if (cleanHeadword(e.headword)) fileList[fi].entryCount++;
        }
      } else {
        // Section index unavailable — fall back to a direct heading scan so the
        // entry count reflects the file contents instead of showing 0.
        fileList[fi].entryCount = await scanDictEntryCount(f.fullPath);
      }
    }

    // ETag folds the entry counts in, so a client that cached a `0` count before
    // the section index finished building is invalidated on the next poll instead
    // of being served a stale 304 forever (the old ETag only keyed on size+mtime).
    const etagParts = files.map((f, fi) => `${f.relPath}:${f.size}:${perFileMtime[fi]}:${fileList[fi].entryCount}`);
    const etag = `W/"${crypto.createHash('md5').update(etagParts.join('|')).digest('hex')}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, Object.assign({ 'ETag': etag, 'Cache-Control': 'no-cache' }, SECURITY_HEADERS));
      return res.end();
    }

    // Build the headword entries array from the already-loaded section indexes.
    const entries = [];
    for (let fi = 0; fi < files.length; fi++) {
      const idx = perFileIdx[fi];
      if (!idx || !idx.entries) continue;
      for (let ei = 0; ei < idx.entries.length; ei++) {
        const e = idx.entries[ei];
        const clean = cleanHeadword(e.headword);
        if (!clean) continue;
        entries.push([fi, ei, e.lineStart, clean]);
      }
    }

    const headers = Object.assign({ 'ETag': etag, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' }, SECURITY_HEADERS);
    sendCompressed(req, res, 200, headers, Buffer.from(JSON.stringify({ files: fileList, entries }), 'utf-8'));
  } catch (err) {
    Logger.error('Dict', 'Failed to list dictionary headwords', err);
    sendJSON(res, 500, { error: 'Failed to list dictionary headwords' });
  }
}

// ── API: Dictionary Full-text Search ──────────────────────────────────────
async function handleDictSearch(req, res, query) {
  // Cap full-text matches per selected dictionary. Without this, a common term
  // (e.g. 一切) yields tens of thousands of matches, and the unbounded `results`
  // array plus the client-side render balloon memory on repeated searches.
  const DICT_SEARCH_MAX_PER_FILE = 1500;
  const rawQ = (query.q || '').trim();
  const q = toTraditional(rawQ);
  if (!q || q.length === 0) {
    return sendJSON(res, 400, { error: 'Missing query parameter' });
  }
  const terms = q.split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return sendJSON(res, 400, { error: 'Missing query parameter' });
  }

  // Optional comma-separated list of `dict:` paths restricting the search.
  const filesParam = query.files ? String(query.files).split(',').map(s => s.trim()).filter(Boolean) : null;

  const maxProximityDist = Math.max(10, parseInt(config.settings.maxProximityDistance) || 150);

  try {
    if (!dictIndex.ready && !dictIndex.building) {
      buildDictIndexAsync().catch(() => {});
    }
    setupDictWatcher();

    const files = await scanDictFiles();
    if (files.length === 0) {
      return sendJSON(res, 200, { query: q, results: [], total: 0, capped: false });
    }

    let fileSet = null;
    if (filesParam && filesParam.length > 0) fileSet = new Set(filesParam);

    const results = [];
    let candidateUnits = null;

    if (dictIndex.ready && terms.some(t => t.length >= 2) && dictIndex.units && dictIndex.units.length > 0) {
      let finalCandidates = null;
      for (const term of terms) {
        if (term.length < 2) continue;
        const qBigrams = extractQueryBigrams(term);
        if (qBigrams.length === 0) continue;
        let termCandidates = null;
        for (const bg of qBigrams) {
          const val = dictIndex.bigrams.get(bg);
          if (val === undefined || val === null) { termCandidates = []; break; }
          if (termCandidates === null) termCandidates = typeof val === 'number' ? [val] : Array.from(val);
          else {
            const posting = typeof val === 'number' ? [val] : val;
            termCandidates = intersectSorted(termCandidates, posting);
            if (termCandidates.length === 0) break;
          }
        }
        if (termCandidates !== null) {
          if (finalCandidates === null) finalCandidates = termCandidates;
          else { finalCandidates = intersectSorted(finalCandidates, termCandidates); if (finalCandidates.length === 0) break; }
        }
      }

      if (finalCandidates && finalCandidates.length > 0) {
        candidateUnits = finalCandidates.map(uid => dictIndex.units[uid]).filter(Boolean);
        if (fileSet) {
          candidateUnits = candidateUnits.filter(u => fileSet.has(dictIndex.fileList[u.fileId].relPath));
        }
        if (candidateUnits.length === 0) candidateUnits = null;
      }
    }

    let unitsToScan;
    if (candidateUnits && candidateUnits.length > 0) {
      unitsToScan = candidateUnits.map(u => {
        const f = dictIndex.fileList[u.fileId];
        return {
          unitId: u.unitId,
          file: f.relPath,
          fileName: f.name.replace(/\.md$/, ''),
          entryIndex: u.entryIndex,
          headword: u.headword,
          byteOffset: u.byteOffset,
          byteLength: u.byteLength,
          lineStart: u.lineStart,
          fullPath: f.fullPath,
        };
      });
    } else {
      const scanFiles = fileSet ? files.filter(f => fileSet.has(f.relPath)) : files;
      unitsToScan = scanFiles.map(f => ({
        unitId: -1,
        file: f.relPath,
        fileName: f.name.replace(/\.md$/, ''),
        entryIndex: -1,
        headword: '',
        byteOffset: 0,
        byteLength: f.size || 0,
        lineStart: 1,
        fullPath: f.fullPath,
      }));
    }

    const byFile = new Map();
    for (const u of unitsToScan) {
      let g = byFile.get(u.fullPath);
      if (!g) { g = { fullPath: u.fullPath, units: [] }; byFile.set(u.fullPath, g); }
      g.units.push(u);
    }
    const scanTasks = Array.from(byFile.values());
    const concurrency = Math.max(1, Math.min(os.cpus().length - 1, 8));

    let hitCap = false;
    await runIndexWorkerPool(scanTasks,
      (task) => ({ type: 'search-scan', payload: { fullPath: task.fullPath, units: task.units, terms, maxProximityDist, maxPerFile: DICT_SEARCH_MAX_PER_FILE } }),
      (result) => {
        if (result.matches.length >= DICT_SEARCH_MAX_PER_FILE) hitCap = true;
        for (const m of result.matches) {
          results.push({ file: m.file, fileName: m.fileName, headword: m.headword, entryIndex: m.entryIndex, line: m.line, snippet: m.snippet });
        }
      },
      concurrency);

    results.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));

    sendJSON(res, 200, { query: q, results, total: results.length, capped: hitCap });
  } catch (err) {
    Logger.error('Dict', `Dictionary search failed for "${q}"`, err);
    sendJSON(res, 500, { error: 'Dictionary search failed' });
  }
}

// ── API: Dictionary Analytics Event (client-side beacon) ────────────────────
// Fire-and-forget endpoint for the client-side dictionary panel. Dictionary
// queries auto-search on every keystroke (no Enter), so we deliberately do NOT
// count a search when the query is typed or the full-text endpoint is hit.
// Instead a single result CLICK is the only event that counts, and it records
// both 辭典查詢 (the query string that produced the result) and 辭典點閱 (the
// headword that was opened). This keeps the search/lookup counts in lockstep
// with actual user intent rather than debounced keystrokes.
//   kind: 'lookup' → a result was clicked; payload carries { file, headword, query }
// Never blocks the caller; a malformed body simply yields an empty payload.
async function handleDictEvent(req, res) {
  let data = {};
  try { data = await readJSONBody(req); } catch (_) {}
  const kind = String(data.kind || '').trim();
  const file = String(data.file || '').trim().slice(0, 500);
  const headword = String(data.headword || '').trim().slice(0, 300);
  const query = String(data.query || '').trim().slice(0, 500);

  if (kind === 'lookup') {
    if (!file && !headword) return sendJSON(res, 400, { error: 'Missing lookup target' });
    Logger.info('DictLookup', `Lookup: "${headword}" in ${file || '(unknown)'}`, req, { path: file || undefined, query: headword || undefined });
    if (query) {
      Logger.info('DictSearch', `Dictionary query: "${query}" (clicked)`, req, { query });
    }
    return sendJSON(res, 200, { ok: true });
  }
  return sendJSON(res, 400, { error: 'Unknown event kind' });
}

// ── API: Full-text Search ────────────────────────────────────
async function handleSearch(req, res, query) {
  const searchStart = Date.now();
  const rawQ = (query.q || '').trim();
  const q = toTraditional(rawQ);
  if (!q || q.length === 0) {
    return sendJSON(res, 400, { error: 'Missing query parameter' });
  }

  const terms = q.split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return sendJSON(res, 400, { error: 'Missing query parameter' });
  }

  const targetFolder = query.folder ? query.folder.trim().replace(/^\/+|\/+$/g, '') : '';
  const cacheKey = `${targetFolder}::${q}`;
  const cached = searchCache.get(cacheKey);
  if (cached && (Date.now() - cached.time) < 60000) {
    searchMetrics.totalQueries++;
    searchMetrics.cacheHits++;
    searchMetrics.lastSearchTimeMs = 0;
    Logger.info('Search', `Query: "${q}"${targetFolder ? `, Scope: "${targetFolder}"` : ''} (Cache Hit) -> ${cached.data.results.length} matches (0ms)`, req, { query: q });
    return sendJSON(res, 200, cached.data);
  }

  const results = [];
  const SNIPPET_RADIUS = 60;
  const maxProximityDist = Math.max(10, parseInt(config.settings.maxProximityDistance) || 150);

  try {
    // Reuse cached tree to avoid redundant filesystem traversal
    if (!cachedTree) {
      cachedTree = await scanDirAsync(getMdRoot(), '');
      setupTreeWatcher();
    }
    // Ensure Bigram Index build is triggered in background if not ready
    if (!searchIndex.ready && !searchIndex.building) {
      buildSearchIndexAsync().catch(() => {});
    }

    let files = flattenTreeToFiles(cachedTree, getMdRoot());
    const isFilenameOnly = targetFolder === '__FILENAME_ONLY__';
    const folderFilter = isFilenameOnly ? '' : targetFolder;

    // Filter files by target directory or specific file path if specified
    if (folderFilter) {
      files = files.filter(f => f.relPath === folderFilter || f.relPath.startsWith(folderFilter + '/'));
    }

    const initialFileCount = files.length;
    let usedIndex = false;
    let candidateUnits = null; // narrowed unit list (entry-level for large files); null = full scan

    // Bigram Inverted Index filtering using sorted-merge intersection (zero Set allocation)
    if (searchIndex.ready && terms.some(t => t.length >= 2) && !isFilenameOnly && searchIndex.units && searchIndex.units.length > 0) {
      let finalCandidates = null; // sorted array of unit IDs

      for (const term of terms) {
        if (term.length < 2) continue;
        const qBigrams = extractQueryBigrams(term);
        if (qBigrams.length === 0) continue;

        let termCandidates = null; // sorted array of unit IDs
        for (const bg of qBigrams) {
          const val = searchIndex.bigrams.get(bg);
          if (val === undefined || val === null) {
            termCandidates = [];
            break;
          }

          if (termCandidates === null) {
            termCandidates = typeof val === 'number' ? [val] : Array.from(val);
          } else {
            const posting = typeof val === 'number' ? [val] : val;
            termCandidates = intersectSorted(termCandidates, posting);
            if (termCandidates.length === 0) break;
          }
        }

        if (termCandidates !== null) {
          if (finalCandidates === null) {
            finalCandidates = termCandidates;
          } else {
            finalCandidates = intersectSorted(finalCandidates, termCandidates);
            if (finalCandidates.length === 0) break;
          }
        }
      }

      if (finalCandidates && finalCandidates.length > 0) {
        candidateUnits = finalCandidates
          .map(uid => searchIndex.units[uid])
          .filter(Boolean);

        if (folderFilter) {
          candidateUnits = candidateUnits.filter(u => {
            const f = searchIndex.fileList[u.fileId];
            return f && (f.relPath === folderFilter || f.relPath.startsWith(folderFilter + '/'));
          });
        }
        if (candidateUnits.length === 0) candidateUnits = null; // all filtered out → full-scan fallback
        else usedIndex = true;
      }
    }

    const isSingleFile = files.length === 1;
    const MAX_RESULTS = isSingleFile ? 5000 : 1500;
    const MAX_FILE_MATCHES = isSingleFile ? 5000 : 250;

    if (isFilenameOnly) {
      for (const file of files) {
        if (results.length >= MAX_RESULTS) break;
        const cleanName = file.name.replace(/\.md$/, '');
        const cleanNameLower = cleanName.toLowerCase();
        const relPathLower = file.relPath.toLowerCase();

        const matchesAll = terms.every(term => {
          const tLower = term.toLowerCase();
          return cleanNameLower.includes(tLower) || relPathLower.includes(tLower);
        });

        if (matchesAll) {
          results.push({
            file: file.relPath,
            fileName: cleanName,
            line: 1,
            snippet: `📄 檔名對比匹配: "${file.relPath}"`,
          });
        }
      }
    } else {
      // Build the list of units to scan. When the bigram index narrowed to a set of
      // candidate entries (large files) we scan only those; otherwise fall back to one
      // whole-file unit per file so every file is still covered.
      let unitsToScan;
      if (candidateUnits && candidateUnits.length > 0) {
        unitsToScan = candidateUnits.map(u => {
          const f = searchIndex.fileList[u.fileId];
          return {
            unitId: u.unitId,
            file: f.relPath,
            fileName: f.name.replace(/\.md$/, ''),
            entryIndex: u.entryIndex,
            headword: u.headword,
            byteOffset: u.byteOffset,
            byteLength: u.byteLength,
            lineStart: u.lineStart,
            fullPath: f.fullPath,
          };
        });
      } else {
        unitsToScan = files.map((f, i) => ({
          unitId: i,
          file: f.relPath,
          fileName: f.name.replace(/\.md$/, ''),
          entryIndex: -1,
          headword: '',
          byteOffset: 0,
          byteLength: f.size || 0,
          lineStart: 1,
          fullPath: f.fullPath,
        }));
      }

      // Group units by file → one worker task per file (reuses the file handle inside the worker).
      const byFile = new Map();
      for (const u of unitsToScan) {
        let g = byFile.get(u.fullPath);
        if (!g) { g = { fullPath: u.fullPath, units: [] }; byFile.set(u.fullPath, g); }
        g.units.push(u);
      }
      const scanTasks = Array.from(byFile.values());
      const concurrency = Math.max(1, Math.min(os.cpus().length - 1, 8));

      await runIndexWorkerPool(scanTasks,
        (task) => ({ type: 'search-scan', payload: { fullPath: task.fullPath, units: task.units, terms, maxProximityDist, maxPerFile: MAX_FILE_MATCHES } }),
        (result) => {
          for (const m of result.matches) {
            if (results.length >= MAX_RESULTS) break;
            results.push({ file: m.file, fileName: m.fileName, headword: m.headword, entryIndex: m.entryIndex, line: m.line, snippet: m.snippet });
          }
        },
        concurrency);

      // Post-processing: deduplicate adjacent matches in same file (within 2 lines).
      // Parallel workers produce non-deterministic order, so sort by (file, line) first.
      if (terms.length > 1 && results.length > 1) {
        results.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
        const deduped = [results[0]];
        for (let di = 1; di < results.length; di++) {
          const prev = deduped[deduped.length - 1];
          const curr = results[di];
          if (prev.file === curr.file && Math.abs(prev.line - curr.line) <= 2) continue;
          deduped.push(curr);
        }
        results.length = 0;
        for (const r of deduped) results.push(r);
      }
    }

    const searchDuration = Date.now() - searchStart;
    searchMetrics.totalQueries++;
    searchMetrics.cacheMisses++;
    searchMetrics.totalSearchTimeMs += searchDuration;
    searchMetrics.lastSearchTimeMs = searchDuration;

    const searchData = { query: q, results, total: results.length, capped: results.length >= MAX_RESULTS };
    if (searchCache.size >= SEARCH_CACHE_MAX) {
      const oldestKey = searchCache.keys().next().value;
      searchCache.delete(oldestKey);
    }
    searchCache.set(cacheKey, { time: Date.now(), data: searchData });

    const indexInfo = usedIndex ? ` (Index Candidates: ${candidateUnits ? candidateUnits.length : 0}/${searchIndex.units.length} units)` : '';
    Logger.info('Search', `Query: "${q}"${targetFolder ? `, Scope: "${targetFolder}"` : ''}${indexInfo} -> ${results.length} matches in ${searchDuration}ms`, req, { query: q });
    sendJSON(res, 200, searchData);
  } catch (err) {
    Logger.error('Search', `Search failed for query "${q}"`, err, req);
    sendJSON(res, 500, { error: 'Search failed' });
  }
}

// ── API: In-page (Ctrl+F) full-file search ─────────────────────
// Used by app.js `doPageSearchVirtual` for large files: returns EVERY match in a
// single file (ordered by line), scoped by entry so the client can jump to any
// entry — not just the currently-mounted virtualization chunks.
async function handleSearchFile(req, res, query) {
  const rawQ = (query.q || '').trim();
  const q = toTraditional(rawQ);
  const relPath = query.path;
  if (!q || !relPath) {
    return sendJSON(res, 400, { error: 'Missing query or path parameter' });
  }

  const terms = q.split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return sendJSON(res, 400, { error: 'Missing query parameter' });
  }

  const maxProximityDist = Math.max(10, parseInt(config.settings.maxProximityDistance) || 150);
  const MAX_RESULTS = 5000;

  try {
    if (!cachedTree) {
      cachedTree = await scanDirAsync(getMdRoot(), '');
      setupTreeWatcher();
    }
    if (!searchIndex.ready && !searchIndex.building) {
      buildSearchIndexAsync().catch(() => {});
    }

    const files = flattenTreeToFiles(cachedTree, getMdRoot());
    const file = files.find(f => f.relPath === relPath);
    if (!file) {
      return sendJSON(res, 404, { error: 'File not found: ' + relPath });
    }

    // Prefer entry-level units from the index; fall back to one whole-file unit.
    let units = null;
    if (searchIndex.ready && searchIndex.fileMap && searchIndex.fileMap.has(relPath)) {
      const fileId = searchIndex.fileMap.get(relPath);
      const fileUnits = searchIndex.units.filter(u => u && u.fileId === fileId);
      if (fileUnits.length > 0) units = fileUnits;
    }
    if (!units) {
      units = [{ unitId: 0, fileId: -1, entryIndex: -1, headword: '', byteOffset: 0, byteLength: file.size || 0, lineStart: 1 }];
    }

    const scanUnits = units.map(u => ({
      unitId: u.unitId,
      file: file.relPath,
      fileName: file.name.replace(/\.md$/, ''),
      entryIndex: u.entryIndex,
      headword: u.headword,
      byteOffset: u.byteOffset,
      byteLength: u.byteLength,
      lineStart: u.lineStart,
    }));

    const matches = [];
    await runIndexWorkerPool([{ fullPath: file.fullPath, units: scanUnits }],
      (t) => ({ type: 'search-scan', payload: { fullPath: t.fullPath, units: t.units, terms, maxProximityDist, maxPerFile: MAX_RESULTS } }),
      (result) => {
        for (const m of result.matches) {
          matches.push({ line: m.line, entryIndex: m.entryIndex, headword: m.headword, snippet: m.snippet });
        }
      },
      1);

    matches.sort((a, b) => a.line - b.line);
    sendJSON(res, 200, { path: relPath, query: q, matches, total: matches.length });
  } catch (err) {
    Logger.error('Search', `Search-file failed for "${relPath}" / "${q}"`, err, req);
    sendJSON(res, 500, { error: 'File search failed' });
  }
}

function serveStatic(req, res, pathname) {
  // Restrict methods for static files
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, Object.assign({ 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
    res.end('Method Not Allowed');
    return;
  }

  let filePath = path.join(APP_ROOT, safeDecodeURIComponent(pathname));

  // Default to index.html
  if (pathname === '/' || pathname === '') {
    filePath = path.join(APP_ROOT, 'index.html');
  }

  if (pathname.includes('\0')) {
    res.writeHead(400, Object.assign({ 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
    res.end('Invalid path');
    return;
  }

  const resolved = path.resolve(filePath);
  
  // Check for path traversal using path.relative to prevent partial-name matching
  const relative = path.relative(APP_ROOT, resolved);
  const isSafe = !relative.startsWith('..') && !path.isAbsolute(relative);
  const baseName = path.basename(resolved);
  const ext = path.extname(resolved).toLowerCase();

  // 1. Blacklist Check: Block hidden files/folders, server backend source code, worker threads, and project config files
  const isHiddenFile = baseName.startsWith('.') || relative.split(path.sep).some(segment => segment.startsWith('.'));
  const isServerSource = baseName === 'server.js' || baseName === 'render-worker.js' || baseName === 'md-worker.js' || baseName === 'index-worker.js';
  const isSensitiveConfig = resolved === CONFIG_PATH || 
                            baseName === 'package.json' || 
                            baseName === 'package-lock.json' || 
                            baseName === 'Dockerfile' || 
                            baseName.toLowerCase() === 'readme.md';

  if (!isSafe || isHiddenFile || isServerSource || isSensitiveConfig) {
    res.writeHead(403, Object.assign({ 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
    res.end('Forbidden');
    return;
  }

  // 2. Whitelist Check: Allow explicit public client assets and safe static media/font/document extensions
  const ALLOWED_EXACT_FILES = new Set(['index.html', 'app.js', 'style.css', 'marked.min.js', 'favicon.ico']);
  const ALLOWED_EXTENSIONS = new Set(['.css', '.js', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.woff', '.woff2', '.ttf', '.pdf']);

  const isAllowedExact = ALLOWED_EXACT_FILES.has(baseName);
  const isAllowedExt = ALLOWED_EXTENSIONS.has(ext);

  if (!isAllowedExact && !isAllowedExt) {
    res.writeHead(403, Object.assign({ 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
    res.end('Access Denied');
    return;
  }

  // Intercept root or index.html requests to serve dynamic index with injected config.settings
  if (pathname === '/' || pathname === '' || path.basename(resolved) === 'index.html') {
    const nonce = crypto.randomBytes(16).toString('base64');
    getIndexHtml(nonce, (err, data) => {
      if (err) {
        res.writeHead(500, Object.assign({ 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
        res.end('Server Error');
        return;
      }
      const etag = `W/"index-${data.length}-${config.settings.defaultFontSize}-${config.settings.defaultTheme}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, Object.assign({ 'ETag': etag, 'Cache-Control': 'no-cache' }, SECURITY_HEADERS));
        res.end();
        return;
      }
      const headers = indexHtmlHeaders({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        'ETag': etag
      }, nonce);
      sendCompressed(req, res, 200, headers, data);
    });
    return;
  }

  fs.stat(resolved, (err, stats) => {
    if (err || !stats.isFile()) {
      // Fallback to index.html for SPA routing
      const nonce = crypto.randomBytes(16).toString('base64');
      getIndexHtml(nonce, (err2, data) => {
        if (err2) {
          res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
          res.end('Not Found');
          return;
        }

        // SPA fallback ETag based on length
        const etag = `W/"index-${data.length}"`;
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304, Object.assign({ 'ETag': etag, 'Cache-Control': 'no-cache' }, SECURITY_HEADERS));
          res.end();
          return;
        }

        const headers = indexHtmlHeaders({
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
          'ETag': etag
        }, nonce);

        sendCompressed(req, res, 200, headers, data);
      });
      return;
    }

    // Static file found — generate weak ETag based on size and mtime
    const mtime = stats.mtime.getTime();
    const size = stats.size;
    const etag = `W/"${size}-${mtime}"`;

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, Object.assign({ 'ETag': etag, 'Cache-Control': 'no-cache' }, SECURITY_HEADERS));
      res.end();
      return;
    }

    const ext = path.extname(resolved).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    // Set Cache-Control: immutable for versioned assets, no-cache for code, long cache for images
    let cacheControl = 'no-cache';
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const hasVersionQuery = urlObj.search && /[?&]v=/.test(urlObj.search);
    if (hasVersionQuery) {
      cacheControl = 'public, max-age=31536000, immutable';
    } else if (ext === '.png' || ext === '.jpg' || ext === '.ico') {
      cacheControl = 'public, max-age=86400';
    }

    const headers = Object.assign({
      'Content-Type': contentType,
      'Cache-Control': cacheControl,
      'ETag': etag
    }, SECURITY_HEADERS);

    fs.readFile(resolved, (err3, data) => {
      if (err3) {
        res.writeHead(500, Object.assign({ 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
        res.end('Server Error');
        return;
      }
      sendCompressed(req, res, 200, headers, data);
    });
  });
}

// Session store mapping: token -> { expiry: timestamp }
const sessions = new Map();
const SESSION_DURATION = 2 * 60 * 60 * 1000; // 2 hours session expiry

// Periodic background cleanup of expired session tokens (every 15 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (session.expiry && now > session.expiry) {
      sessions.delete(token);
    }
  }
}, 15 * 60 * 1000);

// Rate limiting / brute-force protection map: ip -> { attempts: count, lockUntil: timestamp }
const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCK_DURATION = 15 * 60 * 1000; // 15 minutes lockout
const MAX_LOGIN_ENTRIES = 10000;

function getClientIP(req) {
  let ip = '';
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded && typeof forwarded === 'string') {
    ip = forwarded.split(',')[0].trim();
  }
  if (!ip || !net.isIP(ip)) {
    const realIp = req.headers['x-real-ip'];
    if (realIp && typeof realIp === 'string' && net.isIP(realIp.trim())) {
      ip = realIp.trim();
    }
  }
  if (!ip || !net.isIP(ip)) {
    ip = req.socket ? (req.socket.remoteAddress || '127.0.0.1') : '127.0.0.1';
  }
  // Remove IPv6 mapped IPv4 prefix if present (::ffff:127.0.0.1 -> 127.0.0.1)
  if (ip.startsWith('::ffff:')) {
    ip = ip.substring(7);
  }
  if (!net.isIP(ip)) {
    ip = '127.0.0.1';
  }
  return ip.substring(0, 45);
}

// ── Global API Rate Limiter (Sliding Window per IP: max 30 req/sec) ─────────
const apiRateLimits = new Map();
const API_RATE_LIMIT_WINDOW_MS = 1000;
const API_RATE_LIMIT_MAX = 30;

const MAX_RATE_LIMIT_ENTRIES = 10000;

function checkApiRateLimit(req, res) {
  const ip = getClientIP(req);
  const now = Date.now();
  let record = apiRateLimits.get(ip);

  if (!record || (now - record.windowStart) >= API_RATE_LIMIT_WINDOW_MS) {
    record = { count: 1, windowStart: now };
    apiRateLimits.set(ip, record);
    // Evict oldest entry if Map size exceeds limit
    if (apiRateLimits.size > MAX_RATE_LIMIT_ENTRIES) {
      const oldestKey = apiRateLimits.keys().next().value;
      apiRateLimits.delete(oldestKey);
    }
    return true;
  }

  record.count += 1;
  if (record.count > API_RATE_LIMIT_MAX) {
    Logger.warn('Security', `IP ${ip} exceeded API rate limit (${record.count} req/s). Blocked with 429.`);
    sendJSON(res, 429, { error: '請求過於頻繁 (429 Too Many Requests)，請稍後再試。' });
    return false;
  }

  return true;
}

function timingSafeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA); // dummy operation
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function hashPassword(password, salt, iterations = 100000) {
  return new Promise((resolve, reject) => {
    if (!salt) {
      salt = crypto.randomBytes(16).toString('hex');
    }
    crypto.pbkdf2(password, salt, iterations, 64, 'sha512', (err, derivedKey) => {
      if (err) return reject(err);
      resolve({ salt, hash: derivedKey.toString('hex'), iterations });
    });
  });
}

// Clean up expired sessions and stale rate limit attempts every 1 hour to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (now > session.expiry) {
      sessions.delete(token);
    }
  }
  for (const [ip, attempt] of loginAttempts.entries()) {
    if (now > attempt.lockUntil && attempt.attempts > 0) {
      // Clear after lock duration has passed plus 1 hour idle time
      if (now > attempt.lockUntil + 60 * 60 * 1000) {
        loginAttempts.delete(ip);
      }
    }
  }
}, 60 * 60 * 1000);

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function verifySameOrigin(req) {
  const origin = req.headers['origin'];
  const referer = req.headers['referer'];
  const host = req.headers['host'];
  if (!host) return true;

  if (origin) {
    try {
      const originHost = new URL(origin).host;
      if (originHost !== host) return false;
    } catch (_) {
      return false;
    }
  } else if (referer) {
    try {
      const refererHost = new URL(referer).host;
      if (refererHost !== host) return false;
    } catch (_) {
      return false;
    }
  }
  return true;
}

function isAuthenticated(req) {
  if (!verifySameOrigin(req)) return false;
  const token = req.headers['x-admin-token'];
  if (!token) return false;
  const session = sessions.get(token);
  if (!session) return false;
  
  if (Date.now() > session.expiry) {
    sessions.delete(token); // Session expired
    return false;
  }
  
  // Slide session expiry on active request
  session.expiry = Date.now() + SESSION_DURATION;
  return true;
}

function readJSONBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    const MAX_SIZE = 1024 * 1024; // 1MB size limit to prevent DoS memory exhaustion
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > MAX_SIZE) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        resolve({});
      }
    });
    req.on('error', (err) => {
      reject(err);
    });
  });
}

// ── Analytics Aggregator & Data Exporter ────────────────────────────────────
const analyticsCache = new Map();
const ANALYTICS_CACHE_TTL = 60000; // 60s in-memory cache
const ANALYTICS_CACHE_MAX = 20;

function sanitizeCsvField(val) {
  if (val === null || val === undefined) return '""';
  let str = String(val);
  // Neutralize CSV Formula Injection characters (=, +, -, @, tab, CR)
  if (/^[=+\-@\t\r]/.test(str)) {
    str = "'" + str;
  }
  return `"${str.replace(/"/g, '""')}"`;
}

function parseAnalyticsRange(value) {
  const key = value || '30d';
  if (!['1d', '7d', '30d', '90d', 'allTime'].includes(key)) {
    throw new Error('Invalid analytics range');
  }
  return key;
}

function buildAggregateAnalyticsData(requestedTz, rangeKey) {
  const store = analyticsStore || createEmptyAnalyticsStore();
  const lifetime = store.lifetime;
  const fileEntries = Object.entries(lifetime.files || {});
  const searchEntries = Object.entries(lifetime.searches || {});
  const ipEntries = Object.entries(lifetime.ips || {});
  const dictSearchEntries = Object.entries(lifetime.dictSearches || {});
  const dictLookupEntries = Object.entries(lifetime.dictLookups || {});
  const dailyTrend = Object.entries(store.daily || {}).map(([date, bucket]) => ({
    date,
    views: bucket.views || 0,
    uniqueIps: Object.keys(bucket.ips || {}).length
  })).sort((a, b) => a.date.localeCompare(b.date));

  return {
    range: rangeKey,
    tz: requestedTz,
    summary: {
      totalViews: lifetime.views || 0,
      uniqueIps: ipEntries.length,
      totalSearches: lifetime.searchCount || 0,
      activeFiles: fileEntries.length,
      dictSearches: lifetime.dictSearchCount || 0,
      dictLookups: lifetime.dictLookupCount || 0
    },
    topFiles: fileEntries.map(([filePath, stat]) => ({
      path: filePath,
      fileName: filePath.split('/').pop().replace(/\\.md$/, ''),
      views: stat.views || 0,
      uniqueIps: Object.keys(stat.ips || {}).length,
      lastAccess: stat.lastAccess
    })).sort((a, b) => b.views - a.views).slice(0, 50),
    topSearches: searchEntries.map(([query, stat]) => ({ query, count: stat.count || 0, lastSearch: stat.lastSearch }))
      .sort((a, b) => b.count - a.count).slice(0, 30),
    topDictSearches: dictSearchEntries.map(([query, stat]) => ({ query, count: stat.count || 0, lastSearch: stat.lastSearch }))
      .sort((a, b) => b.count - a.count).slice(0, 30),
    topLookups: dictLookupEntries.map(([key, stat]) => ({
      headword: stat.headword || '',
      path: stat.path || '',
      fileName: (stat.path || '').replace(/^dict:/, '').replace(/\.md$/, ''),
      count: stat.count || 0,
      lastLookup: stat.lastLookup
    })).sort((a, b) => b.count - a.count).slice(0, 50),
    dailyTrend,
    ipDistribution: ipEntries.map(([ip, stat]) => ({ ip, requests: stat.requests || 0, lastAccess: stat.lastAccess }))
      .sort((a, b) => b.requests - a.requests).slice(0, 20)
  };
}

async function getAnalyticsData(rangeKey = '30d', requestedTz = 'auto') {
  rangeKey = parseAnalyticsRange(rangeKey);
  await initializeAnalyticsStore();
  await analyticsStoreWrite;
  if (rangeKey === 'allTime') {
    const cacheKey = `${rangeKey}-${requestedTz}`;
    const cached = analyticsCache.get(cacheKey);
    const now = Date.now();
    if (cached && (now - cached.timestamp) < ANALYTICS_CACHE_TTL) return cached.data;
    const data = buildAggregateAnalyticsData(requestedTz, rangeKey);
    // Cap the allTime branch too: cacheKey embeds the raw `tz` query string, so
    // distinct tz values would otherwise grow the cache without bound.
    if (analyticsCache.size >= ANALYTICS_CACHE_MAX) {
      const oldestKey = analyticsCache.keys().next().value;
      analyticsCache.delete(oldestKey);
    }
    analyticsCache.set(cacheKey, { timestamp: now, data });
    return data;
  }

  const rangeDays = Number.parseInt(rangeKey, 10);
  const cacheKey = `${rangeKey}-${requestedTz}`;
  const cached = analyticsCache.get(cacheKey);
  const now = Date.now();
  if (cached && (now - cached.timestamp) < ANALYTICS_CACHE_TTL) {
    return cached.data;
  }

  const cutoffTime = now - (rangeDays * 24 * 60 * 60 * 1000);

  let files = [];
  try {
    files = await fs.promises.readdir(LOG_DIR);
  } catch (_) {}

  const fileMap = new Map();
  const searchMap = new Map();
  const ipMap = new Map();
  const dailyMap = new Map();
  const dictSearchMap = new Map();
  const dictLookupMap = new Map();
  let totalViews = 0;
  let totalSearches = 0;
  let totalDictSearches = 0;
  let totalDictLookups = 0;
  const globalUniqueIps = new Set();

  function processEntry(entry) {
    const t = new Date(entry.timestamp).getTime();
    if (Number.isNaN(t) || t < cutoffTime) return;

    const ip = entry.ip || '127.0.0.1';
    globalUniqueIps.add(ip);

    let ipStat = ipMap.get(ip);
    if (!ipStat) {
      ipStat = { ip, requests: 0, lastAccess: entry.timestamp };
      ipMap.set(ip, ipStat);
    }
    ipStat.requests++;
    if (new Date(entry.timestamp) > new Date(ipStat.lastAccess)) {
      ipStat.lastAccess = entry.timestamp;
    }

    const dObj = new Date(entry.timestamp);
    const dateStr = dObj.toISOString().split('T')[0];
    let daily = dailyMap.get(dateStr);
    if (!daily) {
      daily = { date: dateStr, views: 0, ips: new Set() };
      dailyMap.set(dateStr, daily);
    }
    daily.views++;
    daily.ips.add(ip);

    if (entry.tag === 'Render' || entry.tag === 'ShareLink') {
      let docPath = entry.path;
      if (!docPath && entry.message) {
        const match = entry.message.match(/path=([^&\s]+)/);
        if (match) docPath = safeDecodeURIComponent(match[1]);
      }
      if (!docPath && entry.message && entry.message.includes('Access file:')) {
        const match = entry.message.match(/Access file: "([^"]+)"/);
        if (match) docPath = match[1];
      }

      if (docPath) {
        totalViews++;
        let fStat = fileMap.get(docPath);
        if (!fStat) {
          const fileName = docPath.split('/').pop().replace(/\.md$/, '');
          fStat = { path: docPath, fileName, views: 0, ips: new Set(), lastAccess: entry.timestamp };
          fileMap.set(docPath, fStat);
        }
        fStat.views++;
        fStat.ips.add(ip);
        if (new Date(entry.timestamp) > new Date(fStat.lastAccess)) {
          fStat.lastAccess = entry.timestamp;
        }
      }
    }

    if (entry.tag === 'Search') {
      let q = entry.query;
      if (!q && entry.message) {
        const match = entry.message.match(/Query: "([^"]+)"/);
        if (match) q = match[1];
      }
      if (!q && entry.message) {
        const match = entry.message.match(/q=([^&\s]+)/);
        if (match) q = safeDecodeURIComponent(match[1]);
      }
      if (q && q.trim().length > 0) {
        totalSearches++;
        const cleanQ = q.trim();
        let sStat = searchMap.get(cleanQ);
        if (!sStat) {
          sStat = { query: cleanQ, count: 0, lastSearch: entry.timestamp };
          searchMap.set(cleanQ, sStat);
        }
        sStat.count++;
        if (new Date(entry.timestamp) > new Date(sStat.lastSearch)) {
          sStat.lastSearch = entry.timestamp;
        }
      }
    }

    if (entry.tag === 'DictSearch') {
      const q = (entry.query || '').trim();
      if (q.length > 0) {
        totalDictSearches++;
        let sStat = dictSearchMap.get(q);
        if (!sStat) {
          sStat = { query: q, count: 0, lastSearch: entry.timestamp };
          dictSearchMap.set(q, sStat);
        }
        sStat.count++;
        if (new Date(entry.timestamp) > new Date(sStat.lastSearch)) {
          sStat.lastSearch = entry.timestamp;
        }
      }
    }

    if (entry.tag === 'DictLookup') {
      const headword = (entry.query || '').trim();
      const docPath = entry.path || '';
      if (headword || docPath) {
        totalDictLookups++;
        const key = `${docPath}::${headword}`;
        let lStat = dictLookupMap.get(key);
        if (!lStat) {
          lStat = { headword, path: docPath, count: 0, lastLookup: entry.timestamp };
          dictLookupMap.set(key, lStat);
        }
        lStat.count++;
        if (new Date(entry.timestamp) > new Date(lStat.lastLookup)) {
          lStat.lastLookup = entry.timestamp;
        }
      }
    }
  }

  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;
    const filePath = path.join(LOG_DIR, file);
    try {
      const stats = await fs.promises.stat(filePath);
      if (stats.mtimeMs < cutoffTime - (24 * 60 * 60 * 1000)) continue;

      const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
      const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

      for await (const line of rl) {
        if (!line.trim()) continue;
        try { processEntry(JSON.parse(line)); } catch (_) {}
      }
    } catch (_) {}
  }

  // Merge in-memory buffer items directly
  for (const memItem of systemLogBuffer) {
    processEntry(memItem);
  }

  const topFiles = Array.from(fileMap.values())
    .map(f => ({
      path: f.path,
      fileName: f.fileName,
      views: f.views,
      uniqueIps: f.ips.size,
      lastAccess: f.lastAccess
    }))
    .sort((a, b) => b.views - a.views)
    .slice(0, 50);

  const topSearches = Array.from(searchMap.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 30);

  const topDictSearches = Array.from(dictSearchMap.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 30);

  const topLookups = Array.from(dictLookupMap.values())
    .map(l => ({
      headword: l.headword,
      path: l.path,
      fileName: l.path.replace(/^dict:/, '').replace(/\.md$/, ''),
      count: l.count,
      lastLookup: l.lastLookup
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 50);

  const ipDistribution = Array.from(ipMap.values())
    .sort((a, b) => b.requests - a.requests)
    .slice(0, 20);

  const dailyTrend = Array.from(dailyMap.values())
    .map(d => ({
      date: d.date,
      views: d.views,
      uniqueIps: d.ips.size
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const resultData = {
    range: rangeKey,
    tz: requestedTz,
    summary: {
      totalViews,
      uniqueIps: globalUniqueIps.size,
      totalSearches,
      activeFiles: fileMap.size,
      dictSearches: totalDictSearches,
      dictLookups: totalDictLookups
    },
    topFiles,
    topSearches,
    topDictSearches,
    topLookups,
    dailyTrend,
    ipDistribution
  };

  if (analyticsCache.size >= ANALYTICS_CACHE_MAX) {
    const oldestKey = analyticsCache.keys().next().value;
    analyticsCache.delete(oldestKey);
  }
  analyticsCache.set(cacheKey, { timestamp: now, data: resultData });
  return resultData;
}

function createBlacklistChecker(blackList) {
  if (!Array.isArray(blackList) || blackList.length === 0) {
    return () => false;
  }

  const rules = blackList
    .map(p => String(p).trim().replace(/\\/g, '/'))
    .filter(Boolean);

  if (rules.length === 0) return () => false;

  const matchers = rules.map(rule => {
    if (rule.includes('*') || rule.includes('?')) {
      const regexStr = '^' + rule
        .replace(/([.+^${}()|[\]\\])/g, '\\$1')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') + '$';
      const regex = new RegExp(regexStr, 'i');
      return (path) => regex.test(path) || regex.test(path.replace(/\.md$/, ''));
    }

    if (rule.endsWith('/')) {
      return (path) => path.startsWith(rule);
    }

    const ruleWithMd = rule.endsWith('.md') ? rule : rule + '.md';
    const ruleWithoutMd = rule.endsWith('.md') ? rule.slice(0, -3) : rule;

    return (path) => {
      const pathWithoutMd = path.endsWith('.md') ? path.slice(0, -3) : path;
      return path === rule || path === ruleWithMd || pathWithoutMd === ruleWithoutMd;
    };
  });

  return function isBlacklisted(path) {
    if (!path) return false;
    const normPath = String(path).trim().replace(/\\/g, '/');
    return matchers.some(matcher => matcher(normPath));
  };
}

const HOT_LIST_CACHE_TTL = 60000; // 60s memory cache to avoid scanning 90-day logs on every suggest-list call
let hotListCache = null;
let hotListCacheTime = 0;
let hotListCacheKey = "";

async function buildHotList(blackList) {
  const isBlacklisted = createBlacklistChecker(blackList);
  const now = Date.now();
  const cacheKey = JSON.stringify(blackList || []);
  if (hotListCache && hotListCacheKey === cacheKey && (now - hotListCacheTime) < HOT_LIST_CACHE_TTL) {
    return hotListCache;
  }

  // Collect top files for 7d, 30d, 90d windows
  const windows = [7, 30, 90];
  const windowMaps = windows.map(() => new Map());

  let files = [];
  try { files = await fs.promises.readdir(LOG_DIR); } catch (_) {}

  const maxCutoff = now - (90 * 24 * 60 * 60 * 1000);

  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;
    const filePath = path.join(LOG_DIR, file);
    try {
      const stats = await fs.promises.stat(filePath);
      if (stats.mtimeMs < maxCutoff - (24 * 60 * 60 * 1000)) continue;

      const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
      const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const item = JSON.parse(line);
          if (item.tag !== 'Render' && item.tag !== 'ShareLink') continue;

          let docPath = item.path;
          if (!docPath && item.message) {
            const m1 = item.message.match(/Access file: "([^"]+)"/);
            if (m1) docPath = m1[1];
          }
          if (!docPath) continue;
          docPath = docPath.trim().replace(/\\/g, '/');
          if (isBlacklisted(docPath)) continue;

          const t = new Date(item.timestamp).getTime();
          windows.forEach((days, idx) => {
            if (t >= now - (days * 24 * 60 * 60 * 1000)) {
              const m = windowMaps[idx];
              const fileName = docPath.split('/').pop().replace(/\.md$/, '');
              let stat = m.get(docPath);
              if (!stat) { stat = { path: docPath, fileName, views: 0 }; m.set(docPath, stat); }
              stat.views++;
            }
          });
        } catch (_) {}
      }
    } catch (_) {}
  }

  // Also scan in-memory buffer
  for (const item of systemLogBuffer) {
    if (item.tag !== 'Render' && item.tag !== 'ShareLink') continue;
    let docPath = item.path;
    if (!docPath && item.message) {
      const m1 = item.message.match(/Access file: "([^"]+)"/);
      if (m1) docPath = m1[1];
    }
    if (!docPath) continue;
    docPath = docPath.trim().replace(/\\/g, '/');
    if (isBlacklisted(docPath)) continue;
    const t = new Date(item.timestamp).getTime();
    windows.forEach((days, idx) => {
      if (t >= now - (days * 24 * 60 * 60 * 1000)) {
        const m = windowMaps[idx];
        const fileName = docPath.split('/').pop().replace(/\.md$/, '');
        let stat = m.get(docPath);
        if (!stat) { stat = { path: docPath, fileName, views: 0 }; m.set(docPath, stat); }
        stat.views++;
      }
    });
  }

  // Merge: 7d top5 -> 30d top5 -> 90d top5, deduplicated
  const seen = new Set();
  const result = [];
  for (let idx = 0; idx < windows.length; idx++) {
    const top5 = Array.from(windowMaps[idx].values())
      .sort((a, b) => b.views - a.views)
      .slice(0, 5);
    for (const item of top5) {
      if (!seen.has(item.path)) {
        seen.add(item.path);
        result.push({ path: item.path, fileName: item.fileName, views: item.views, source: `${windows[idx]}d` });
      }
    }
  }
  hotListCache = result;
  hotListCacheTime = now;
  hotListCacheKey = cacheKey;
  return result;
}

async function handleSuggestList(req, res) {
  try {
    const sl = config.settings.suggestList || {};
    const adminList = Array.isArray(sl.adminList) ? sl.adminList : [];
    const adminPickCount = Math.max(0, parseInt(sl.adminPickCount) || 3);
    const hotPickCount = Math.max(0, parseInt(sl.hotPickCount) || 5);
    const blackList = Array.isArray(sl.blackList) ? sl.blackList : [];
    const isBlacklisted = createBlacklistChecker(blackList);

    // Admin picks: filter blacklist then shuffle and pick adminPickCount
    const validAdmin = adminList
      .map(p => p.replace(/\\/g, '/').split('/').map(s => s.trim()).filter(Boolean).join('/'))
      .filter(p => p && !isBlacklisted(p));
    // Shuffle admin list for variety
    for (let i = validAdmin.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [validAdmin[i], validAdmin[j]] = [validAdmin[j], validAdmin[i]];
    }
    const adminPicks = validAdmin.slice(0, adminPickCount).map(p => {
      const cleanNoExt = p.replace(/\.md$/i, '').trim();
      const fileName = cleanNoExt.split('/').pop().trim();
      return {
        path: p,
        fileName: fileName || p,
        type: 'admin'
      };
    });

    // Hot picks: from log analysis
    const hotRaw = await buildHotList(blackList);
    const adminPathSet = new Set(adminPicks.map(a => a.path));
    const hotPicks = hotRaw
      .filter(h => !adminPathSet.has(h.path))
      .slice(0, hotPickCount)
      .map(h => ({ path: h.path, fileName: h.fileName, type: 'hot', source: h.source }));

    const items = [...adminPicks, ...hotPicks];
    // Randomly shuffle combined items so admin and hot picks interleave
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    sendJSON(res, 200, { items, adminPickCount, hotPickCount, enabled: sl.enabled !== false });
  } catch (err) {
    Logger.error('Suggest', 'Failed to build suggestion list', err, req);
    sendJSON(res, 500, { error: 'Failed to load suggestions' });
  }
}

async function getDockerMemoryLimit() {
  try {
    const raw = await fs.promises.readFile('/sys/fs/cgroup/memory.max', 'utf-8');
    const val = raw.trim();
    if (val && val !== 'max') {
      const bytes = parseInt(val, 10);
      if (Number.isFinite(bytes) && bytes > 0) return bytes;
    }
  } catch (_) {}

  try {
    const raw = await fs.promises.readFile('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf-8');
    const val = raw.trim();
    if (val) {
      const bytes = parseInt(val, 10);
      if (Number.isFinite(bytes) && bytes > 0 && bytes < 9007199254740991) return bytes;
    }
  } catch (_) {}

  return os.totalmem();
}

async function getDirSizeAsync(dirPath) {
  let size = 0;
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        size += await getDirSizeAsync(full);
      } else if (entry.isFile()) {
        const s = await fs.promises.stat(full).catch(() => null);
        if (s) size += s.size;
      }
    }
  } catch (_) {}
  return size;
}

let lastCpuTimes = null;

function getCpuUsagePct() {
  const cpus = os.cpus();
  if (!cpus || cpus.length === 0) return 0;
  let totalIdle = 0;
  let totalTick = 0;
  for (const cpu of cpus) {
    for (const type in cpu.times) {
      totalTick += cpu.times[type];
    }
    totalIdle += cpu.times.idle;
  }
  if (!lastCpuTimes) {
    lastCpuTimes = { idle: totalIdle, total: totalTick };
    return 0;
  }
  const idleDelta = totalIdle - lastCpuTimes.idle;
  const totalDelta = totalTick - lastCpuTimes.total;
  lastCpuTimes = { idle: totalIdle, total: totalTick };
  if (totalDelta <= 0) return 0;
  const usedPct = 100 - (idleDelta / totalDelta) * 100;
  return parseFloat(Math.min(100, Math.max(0, usedPct)).toFixed(1));
}

function isDockerContainer() {
  try {
    if (fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv')) return true;
    if (fs.existsSync('/proc/1/cgroup')) {
      const content = fs.readFileSync('/proc/1/cgroup', 'utf-8');
      if (content.includes('docker') || content.includes('containerd') || content.includes('kubepods')) return true;
    }
  } catch (_) {}
  return false;
}

async function getSystemHardwareStats() {
  const cpus = os.cpus() || [];
  const loadAvg = os.loadavg() || [0, 0, 0];
  const containerMemLimit = await getDockerMemoryLimit();
  const processMem = process.memoryUsage();
  const cpuUsagePct = getCpuUsagePct();
  const isDocker = isDockerContainer();

  let storageStats = { total: 0, free: 0, available: 0, used: 0, usagePct: 0 };
  try {
    const sf = await fs.promises.statfs(getMdRoot());
    const total = sf.blocks * sf.bsize;
    const free = sf.bfree * sf.bsize;
    const avail = sf.bavail * sf.bsize;
    const used = total - free;
    storageStats = {
      total,
      free,
      available: avail,
      used,
      usagePct: total > 0 ? parseFloat(((used / total) * 100).toFixed(1)) : 0
    };
  } catch (_) {}

  let cacheSize = 0;
  try {
    if (fs.existsSync(SEARCH_INDEX_CACHE_BIN)) {
      cacheSize = fs.statSync(SEARCH_INDEX_CACHE_BIN).size;
    } else if (fs.existsSync(SEARCH_INDEX_CACHE_FILE)) {
      cacheSize = fs.statSync(SEARCH_INDEX_CACHE_FILE).size;
    }
  } catch (_) {}

  let analyticsStoreSize = 0;
  try { analyticsStoreSize = (await fs.promises.stat(ANALYTICS_STORE_PATH)).size; } catch (_) {}
  const logsDirSize = await getDirSizeAsync(LOG_DIR);

  let indexFileMtime = searchIndex.createdAt || null;
  try {
    if (fs.existsSync(SEARCH_INDEX_CACHE_BIN)) {
      const stat = fs.statSync(SEARCH_INDEX_CACHE_BIN);
      indexFileMtime = stat.mtime ? stat.mtime.toISOString() : (stat.birthtime ? stat.birthtime.toISOString() : indexFileMtime);
    } else if (fs.existsSync(SEARCH_INDEX_CACHE_FILE)) {
      const stat = fs.statSync(SEARCH_INDEX_CACHE_FILE);
      indexFileMtime = stat.mtime ? stat.mtime.toISOString() : (stat.birthtime ? stat.birthtime.toISOString() : indexFileMtime);
    }
  } catch (err) {
    Logger.error('Hardware', 'Failed to stat search index cache file', err);
  }

  if (indexFileMtime) {
    searchIndex.createdAt = indexFileMtime;
  }

  let dictCacheSize = 0;
  let dictIndexFileMtime = dictIndex.createdAt || null;
  try {
    if (fs.existsSync(DICT_INDEX_CACHE_BIN)) {
      const stat = fs.statSync(DICT_INDEX_CACHE_BIN);
      dictCacheSize = stat.size;
      dictIndexFileMtime = stat.mtime ? stat.mtime.toISOString() : (stat.birthtime ? stat.birthtime.toISOString() : dictIndexFileMtime);
    }
  } catch (err) {
    Logger.error('Hardware', 'Failed to stat dictionary index cache file', err);
  }
  if (dictIndexFileMtime) {
    dictIndex.createdAt = dictIndexFileMtime;
  }

  const now = Date.now();
  const cutoff = now - 60000;
  httpMetrics.recentRequestTimes = httpMetrics.recentRequestTimes.filter(t => t >= cutoff);
  const requestsPerMin = httpMetrics.recentRequestTimes.length;
  const avgResponseTimeMs = httpMetrics.totalRequests > 0 ? parseFloat((httpMetrics.totalResponseTimeMs / httpMetrics.totalRequests).toFixed(1)) : 0;
  
  let activeSessions = 0;
  for (const [_, session] of sessions.entries()) {
    if (session && session.expiry > now) {
      activeSessions++;
    }
  }

  const totalSearchQueries = searchMetrics.totalQueries;
  const searchCacheHits = searchMetrics.cacheHits;
  const searchCacheMisses = searchMetrics.cacheMisses;
  const hitRatePct = totalSearchQueries > 0 ? parseFloat(((searchCacheHits / totalSearchQueries) * 100).toFixed(1)) : 0;
  const avgSearchTimeMs = searchCacheMisses > 0 ? parseFloat((searchMetrics.totalSearchTimeMs / searchCacheMisses).toFixed(1)) : 0;
  const vaultTotalSizeBytes = searchIndex.fileList ? searchIndex.fileList.reduce((acc, f) => acc + (f.size || 0), 0) : 0;

  return {
    timestamp: new Date().toISOString(),
    system: {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      isDocker,
      sysUptime: Math.floor(os.uptime()),
      processUptime: Math.floor(process.uptime())
    },
    cpu: {
      model: cpus.length > 0 ? cpus[0].model : 'Unknown CPU',
      cores: cpus.length,
      usagePct: cpuUsagePct,
      loadAvg: [
        parseFloat(loadAvg[0].toFixed(2)),
        parseFloat(loadAvg[1].toFixed(2)),
        parseFloat(loadAvg[2].toFixed(2))
      ]
    },
    memory: {
      containerLimit: containerMemLimit,
      hostTotal: os.totalmem(),
      hostFree: os.freemem(),
      rss: processMem.rss,
      heapTotal: processMem.heapTotal,
      heapUsed: processMem.heapUsed,
      external: processMem.external,
      arrayBuffers: processMem.arrayBuffers,
      rssUsagePct: parseFloat(((processMem.rss / containerMemLimit) * 100).toFixed(1)),
      heapUsagePct: parseFloat(((processMem.heapUsed / processMem.heapTotal) * 100).toFixed(1))
    },
    storage: {
      vaultPath: getMdRoot(),
      vaultFs: storageStats,
      cacheSizeBytes: cacheSize,
      analyticsStoreSizeBytes: analyticsStoreSize,
      logsDirSizeBytes: logsDirSize
    },
    index: {
      ready: searchIndex.ready,
      building: searchIndex.building,
      totalFiles: searchIndex.fileList ? searchIndex.fileList.length : 0,
      totalUnits: searchIndex.units ? searchIndex.units.length : 0,
      uniqueBigrams: searchIndex.bigrams ? searchIndex.bigrams.size : 0,
      cacheSizeBytes: cacheSize,
      vaultSig: searchIndex.vaultSig || '',
      createdAt: indexFileMtime,
      lastModified: indexFileMtime
    },
    dictIndex: {
      enabled: config.settings.dictionaryEnabled === true,
      ready: dictIndex.ready,
      building: dictIndex.building,
      totalFiles: dictIndex.fileList ? dictIndex.fileList.length : 0,
      totalUnits: dictIndex.units ? dictIndex.units.length : 0,
      uniqueBigrams: dictIndex.bigrams ? dictIndex.bigrams.size : 0,
      cacheSizeBytes: dictCacheSize,
      createdAt: dictIndexFileMtime,
      lastModified: dictIndexFileMtime
    },
    search: {
      totalQueries: totalSearchQueries,
      cacheHits: searchCacheHits,
      cacheMisses: searchCacheMisses,
      hitRatePct: hitRatePct,
      avgSearchTimeMs: avgSearchTimeMs,
      lastSearchTimeMs: searchMetrics.lastSearchTimeMs,
      cacheEntries: searchCache.size,
      vaultTotalSizeBytes: vaultTotalSizeBytes
    },
    network: {
      totalRequests: httpMetrics.totalRequests,
      requestsPerMin: requestsPerMin,
      avgResponseTimeMs: avgResponseTimeMs,
      activeSessions: activeSessions
    },
    workers: {
      count: workerPool.length,
      idle: workerPool.filter(w => w.idle).length
    }
  };
}

async function handleHardwareStats(req, res) {
  if (!isAuthenticated(req)) {
    return sendJSON(res, 401, { error: 'Unauthorized' });
  }
  try {
    const stats = await getSystemHardwareStats();
    return sendJSON(res, 200, stats);
  } catch (err) {
    return sendJSON(res, 500, { error: err.message });
  }
}

async function handleRebuildIndex(req, res) {
  if (!isAuthenticated(req)) {
    return sendJSON(res, 401, { error: 'Unauthorized' });
  }
  try {
    searchCache.clear();
    invalidateSectionIndexes();
    buildSearchIndexAsync(true).catch(err => {
      Logger.error('Index', 'Manual index rebuild error', err);
    });
    return sendJSON(res, 200, { success: true, message: 'Index rebuild initiated' });
  } catch (err) {
    return sendJSON(res, 500, { error: err.message });
  }
}

async function handleRebuildDictIndex(req, res) {
  if (!isAuthenticated(req)) {
    return sendJSON(res, 401, { error: 'Unauthorized' });
  }
  try {
    buildDictIndexAsync(true).catch(err => {
      Logger.error('DictIndex', 'Manual dictionary index rebuild error', err);
    });
    return sendJSON(res, 200, { success: true, message: 'Dictionary index rebuild initiated' });
  } catch (err) {
    return sendJSON(res, 500, { error: err.message });
  }
}

async function handleAnalytics(req, res, query) {
  if (!isAuthenticated(req)) {
    return sendJSON(res, 401, { error: 'Unauthorized' });
  }

  try {
    const data = await getAnalyticsData(parseAnalyticsRange(query.range), query.tz || 'auto');
    return sendJSON(res, 200, data);
  } catch (err) {
    return sendJSON(res, 400, { error: err.message });
  }
}

async function handleAnalyticsExport(req, res, query) {
  const token = query.token || req.headers['x-admin-token'];
  let authorized = isAuthenticated(req);
  if (!authorized && token && sessions.has(token)) {
    const session = sessions.get(token);
    if (session && Date.now() < session.expiry) {
      authorized = true;
    }
  }
  if (!authorized) {
    return sendJSON(res, 401, { error: 'Unauthorized' });
  }

  const format = query.format === 'csv' ? 'csv' : 'json';
  let rangeKey;
  try { rangeKey = parseAnalyticsRange(query.range); } catch (err) { return sendJSON(res, 400, { error: err.message }); }
  const data = await getAnalyticsData(rangeKey, query.tz || 'auto');

  if (format === 'csv') {
    let csv = '\uFEFF';
    csv += '排名,文章標題/檔名,文章路徑,總點閱數,獨立IP數,最後閱讀時間\n';
    data.topFiles.forEach((f, idx) => {
      csv += `${idx + 1},${sanitizeCsvField(f.fileName)},${sanitizeCsvField(f.path)},${f.views},${f.uniqueIps},${sanitizeCsvField(f.lastAccess)}\n`;
    });

    res.writeHead(200, Object.assign({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="analytics-report-${rangeKey}.csv"`
    }, SECURITY_HEADERS));
    return res.end(csv);
  } else {
    res.writeHead(200, Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="analytics-report-${rangeKey}.json"`
    }, SECURITY_HEADERS));
    return res.end(JSON.stringify(data, null, 2));
  }
}

// ── HTTP Server ──────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const reqStart = Date.now();
  res.reqHeadersAcceptEncoding = req.headers['accept-encoding'] || '';
  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsed.pathname;
  const query = Object.fromEntries(parsed.searchParams);
  // Redact any ?token= session token so it never reaches the HTTP access log.
  const logSearch = parsed.search ? parsed.search.replace(/([?&]token=)[^&]*/gi, '$1[REDACTED]') : '';

  // HTTP Access Logging Middleware
  const origEnd = res.end;
  res.end = function(...args) {
    origEnd.apply(res, args);
    const duration = Date.now() - reqStart;
    const now = Date.now();

    httpMetrics.totalRequests++;
    httpMetrics.totalResponseTimeMs += duration;
    httpMetrics.recentRequestTimes.push(now);
    if (httpMetrics.recentRequestTimes.length > MAX_RECENT_REQUEST_TIMES) {
      httpMetrics.recentRequestTimes.splice(0, httpMetrics.recentRequestTimes.length - MAX_RECENT_REQUEST_TIMES);
    }

    const isSpecialTagRoute = pathname === '/api/search' || pathname === '/api/search-file' || pathname === '/api/render';
    if (!isSpecialTagRoute && (pathname.startsWith('/api/') || pathname.startsWith('/admin/') || res.statusCode >= 400 || duration > 50)) {
      Logger.info('HTTP', `${req.method} ${pathname}${logSearch || ''} -> ${res.statusCode} (${duration}ms)`, req, { durationMs: duration });
    } else {
      Logger.debug('HTTP', `${req.method} ${pathname} -> ${res.statusCode} (${duration}ms)`, req, { durationMs: duration });
    }
  };

  // Log share link access if present
  if ((pathname === '/' || pathname === '') && query.file) {
    Logger.info('ShareLink', `Access file: "${query.file}" at line: ${query.line || 'none'}`, req, { path: query.file });
  }

  // Global API Rate Limiting Check (30 req/sec max)
  if (pathname.startsWith('/api/')) {
    if (!checkApiRateLimit(req, res)) {
      return;
    }
  }

  // API routes
  if (pathname === '/api/tree' && req.method === 'GET') {
    return handleTree(req, res);
  }
  if (pathname === '/api/file' && req.method === 'GET') {
    return handleFile(req, res, query);
  }
  if (pathname === '/api/media' && (req.method === 'GET' || req.method === 'HEAD')) {
    return handleMedia(req, res, query);
  }
  if (pathname === '/api/render' && req.method === 'GET') {
    return handleRender(req, res, query);
  }
  if (pathname === '/api/section-index' && req.method === 'GET') {
    return handleSectionIndex(req, res, query);
  }
  if (pathname === '/api/render-chunk' && req.method === 'GET') {
    return handleRenderChunk(req, res, query);
  }
  if (pathname === '/api/search' && req.method === 'GET') {
    return handleSearch(req, res, query);
  }
  if (pathname === '/api/search-file' && req.method === 'GET') {
    return handleSearchFile(req, res, query);
  }
  if (pathname === '/api/dict-headwords' && req.method === 'GET') {
    return handleDictHeadwords(req, res);
  }
  if (pathname === '/api/dict-search' && req.method === 'GET') {
    return handleDictSearch(req, res, query);
  }
  if (pathname === '/api/dict-event' && req.method === 'POST') {
    return handleDictEvent(req, res);
  }

  // Admin API routes
  if (pathname === '/api/admin/status' && req.method === 'GET') {
    // Redact the absolute vault path (and any other filesystem-layout detail) from
    // the anonymous status payload — it is a useful recon primitive for traversal.
    const safeSettings = Object.assign({}, config.settings);
    delete safeSettings.mdRoot;
    delete safeSettings.dictionaryPath;
    return sendJSON(res, 200, {
      isSetup: !!config.admin,
      isAuthenticated: isAuthenticated(req),
      settings: safeSettings
    });
  }
  if (pathname === '/api/admin/analytics' && req.method === 'GET') {
    return handleAnalytics(req, res, query);
  }
  if (pathname === '/api/admin/analytics/export' && req.method === 'GET') {
    return handleAnalyticsExport(req, res, query);
  }
  if (pathname === '/api/admin/logs' && req.method === 'GET') {
    if (!isAuthenticated(req)) {
      return sendJSON(res, 401, { error: 'Unauthorized' });
    }
    return sendJSON(res, 200, { logs: systemLogBuffer });
  }
  if (pathname === '/api/admin/setup' && req.method === 'POST') {
    if (config.admin) {
      return sendJSON(res, 400, { error: 'Admin already configured' });
    }
    // First-run admin creation must originate from loopback so a remote attacker
    // cannot claim admin on a fresh (unconfigured) deployment first-come-first-served.
    const ip = getClientIP(req);
    if (ip !== '127.0.0.1' && ip !== '::1') {
      return sendJSON(res, 403, { error: 'Admin setup is only allowed from localhost' });
    }
    return readJSONBody(req).then(data => {
      const { username, password } = data;
      if (!username || !password || username.trim() === '' || password.trim() === '') {
        return sendJSON(res, 400, { error: 'Username and password are required' });
      }
      if (password.length < 8) {
        return sendJSON(res, 400, { error: '密碼長度至少需為 8 個字元' });
      }
      return hashPassword(password).then(({ salt, hash }) => {
        config.admin = {
          username: username.trim(),
          passwordHash: hash,
          salt: salt
        };
        saveConfig();
        return sendJSON(res, 200, { success: true });
      });
    }).catch(err => {
      return sendJSON(res, 500, { error: err.message });
    });
  }
  if (pathname === '/api/admin/login' && req.method === 'POST') {
    if (!config.admin) {
      return sendJSON(res, 400, { error: 'Admin not configured' });
    }

    const ip = getClientIP(req);
    const attempt = loginAttempts.get(ip) || { attempts: 0, lockUntil: 0 };

    if (Date.now() < attempt.lockUntil) {
      const waitMinutes = Math.ceil((attempt.lockUntil - Date.now()) / 60000);
      return sendJSON(res, 429, { error: `登入失敗次數過多，請於 ${waitMinutes} 分鐘後再試。` });
    }

    return readJSONBody(req).then(data => {
      const { username, password } = data;
      if (!username || !password) {
        return sendJSON(res, 400, { error: 'Username and password are required' });
      }

      // Perform async hashing
      return hashPassword(password, config.admin.salt, 100000).then(({ hash }) => {
        if (hash === config.admin.passwordHash) {
          return { hash };
        }
        // Fallback for legacy 1000 iterations
        return hashPassword(password, config.admin.salt, 1000).then(legacy => {
          return { hash: legacy.hash === config.admin.passwordHash ? legacy.hash : hash };
        });
      }).then(({ hash }) => {
        const isUsernameCorrect = timingSafeCompare(username, config.admin.username);
        const isPasswordCorrect = timingSafeCompare(hash, config.admin.passwordHash);

        if (isUsernameCorrect && isPasswordCorrect) {
          loginAttempts.delete(ip); // Clear attempts on success
          const token = generateSessionToken();
          sessions.set(token, { expiry: Date.now() + SESSION_DURATION });
          return sendJSON(res, 200, { success: true, token });
        } else {
          attempt.attempts += 1;
          if (attempt.attempts >= MAX_ATTEMPTS) {
            attempt.lockUntil = Date.now() + LOCK_DURATION;
            console.warn(`[Security Alert] IP ${ip} locked out for 15 minutes due to ${MAX_ATTEMPTS} failed login attempts.`);
          }
          loginAttempts.set(ip, attempt); // Correctly save the attempt block in all paths
          // Evict oldest entries if over limit
          if (loginAttempts.size > MAX_LOGIN_ENTRIES) {
            const oldestKey = loginAttempts.keys().next().value;
            loginAttempts.delete(oldestKey);
          }
          return sendJSON(res, 401, { error: '帳號或密碼錯誤' });
        }
      });
    }).catch(err => {
      return sendJSON(res, 500, { error: err.message });
    });
  }
  if (pathname === '/api/admin/logout' && req.method === 'POST') {
    const token = req.headers['x-admin-token'];
    if (token) {
      sessions.delete(token);
    }
    return sendJSON(res, 200, { success: true });
  }
  if (pathname === '/api/admin/settings' && req.method === 'GET') {
    if (!isAuthenticated(req)) {
      return sendJSON(res, 401, { error: 'Unauthorized' });
    }
    return sendJSON(res, 200, { settings: config.settings });
  }
  if (pathname === '/api/admin/settings' && req.method === 'POST') {
    if (!isAuthenticated(req)) {
      return sendJSON(res, 401, { error: 'Unauthorized' });
    }
    return readJSONBody(req).then(data => {
      const { mdRoot, defaultFontSize, defaultTheme, siteName, createIfNotExists, enableVersion, version, enableDownload, downloadUrl, suggestList, maxProximityDistance, dictionaryEnabled, dictionaryPath } = data.settings || {};
      if (!mdRoot || mdRoot.trim() === '') {
        return sendJSON(res, 400, { error: 'Directory path cannot be empty' });
      }

      const resolvedPath = path.resolve(mdRoot.trim());
      const nextDictEnabled = dictionaryEnabled !== undefined ? !!dictionaryEnabled : config.settings.dictionaryEnabled;
      const nextDictPath = (dictionaryPath !== undefined)
        ? (String(dictionaryPath).trim() ? path.resolve(String(dictionaryPath).trim()) : deriveDictRoot(resolvedPath))
        : config.settings.dictionaryPath;

      const updateSettings = () => {
        if (config.settings.mdRoot !== resolvedPath) {
          config.settings.mdRoot = resolvedPath;
          resetTreeWatcher();
        }
        if (defaultFontSize) {
          config.settings.defaultFontSize = Math.max(12, Math.min(32, parseInt(defaultFontSize)));
        }
        if (defaultTheme) {
          config.settings.defaultTheme = defaultTheme;
        }
        if (siteName !== undefined) {
          config.settings.siteName = siteName.trim() || 'mdWebview';
        }
        if (enableVersion !== undefined) {
          config.settings.enableVersion = !!enableVersion;
        }
        if (version !== undefined) {
          config.settings.version = String(version).trim();
        }
        if (enableDownload !== undefined) {
          config.settings.enableDownload = !!enableDownload;
        }
        if (downloadUrl !== undefined) {
          config.settings.downloadUrl = String(downloadUrl).trim();
        }
        if (maxProximityDistance !== undefined) {
          const dist = parseInt(maxProximityDistance);
          if (!Number.isNaN(dist)) {
            config.settings.maxProximityDistance = Math.max(10, Math.min(5000, dist));
          }
        }
        if (suggestList !== undefined && typeof suggestList === 'object') {
          const sl = suggestList;
          const existing = config.settings.suggestList || {};
          config.settings.suggestList = {
            adminList: Array.isArray(sl.adminList) ? sl.adminList.map(String).filter(p => p.trim()) : existing.adminList || [],
            adminPickCount: Number.isFinite(parseInt(sl.adminPickCount)) ? Math.max(0, parseInt(sl.adminPickCount)) : (existing.adminPickCount ?? 3),
            blackList: Array.isArray(sl.blackList) ? sl.blackList.map(String).filter(p => p.trim()) : existing.blackList || [],
            hotPickCount: Number.isFinite(parseInt(sl.hotPickCount)) ? Math.max(0, parseInt(sl.hotPickCount)) : (existing.hotPickCount ?? 5),
            enabled: sl.enabled !== undefined ? !!sl.enabled : (existing.enabled === true)
          };
        }
        if (config.settings.dictionaryEnabled !== nextDictEnabled || config.settings.dictionaryPath !== nextDictPath) {
          config.settings.dictionaryEnabled = nextDictEnabled;
          config.settings.dictionaryPath = nextDictPath;
          resetDictWatcher();
        }
        saveConfig();
        return sendJSON(res, 200, { success: true, settings: config.settings });
      };

      const afterVaultOk = () => {
        if (nextDictEnabled && nextDictPath) {
          return fs.promises.stat(nextDictPath).then(ds => {
            if (!ds.isDirectory()) {
              return sendJSON(res, 400, { error: 'Dictionary path is not a directory' });
            }
            return updateSettings();
          }).catch(err => {
            if (err.code === 'ENOENT') {
              if (createIfNotExists) {
                return fs.promises.mkdir(nextDictPath, { recursive: true })
                  .then(() => updateSettings())
                  .catch(mkdirErr => sendJSON(res, 500, { error: 'Failed to create dictionary directory: ' + mkdirErr.message }));
              }
              return sendJSON(res, 404, {
                error: `辭典目錄路徑 "${nextDictPath}" 不存在。`,
                code: 'DIR_NOT_FOUND',
                path: nextDictPath,
                field: 'dictionaryPath'
              });
            }
            return sendJSON(res, 400, { error: 'Dictionary path does not exist or is not readable' });
          });
        }
        return updateSettings();
      };

      return fs.promises.stat(resolvedPath).then(stats => {
        if (!stats.isDirectory()) {
          return sendJSON(res, 400, { error: 'Provided path is not a directory' });
        }
        return afterVaultOk();
      }).catch(err => {
        if (err.code === 'ENOENT') {
          if (createIfNotExists) {
            return fs.promises.mkdir(resolvedPath, { recursive: true })
              .then(() => afterVaultOk())
              .catch(mkdirErr => sendJSON(res, 500, { error: 'Failed to create directory: ' + mkdirErr.message }));
          }
          return sendJSON(res, 404, {
            error: `目錄路徑 "${resolvedPath}" 不存在。`,
            code: 'DIR_NOT_FOUND',
            path: resolvedPath,
            field: 'mdRoot'
          });
        }
        return sendJSON(res, 400, { error: 'Directory path does not exist or is not readable' });
      });
    }).catch(err => {
      return sendJSON(res, 500, { error: err.message });
    });
  }

  // Admin hardware status API
  if (pathname === '/api/admin/hardware' && req.method === 'GET') {
    return handleHardwareStats(req, res);
  }

  // Admin rebuild index API
  if (pathname === '/api/admin/rebuild-index' && req.method === 'POST') {
    return handleRebuildIndex(req, res);
  }
  if (pathname === '/api/admin/rebuild-dict-index' && req.method === 'POST') {
    return handleRebuildDictIndex(req, res);
  }

  // Public suggest-list API (no auth required)
  if (pathname === '/api/suggest-list' && req.method === 'GET') {
    return handleSuggestList(req, res);
  }

  // Static files
  serveStatic(req, res, pathname);
});

initWorkerPool();

server.listen(PORT, () => {
  console.log('');
  console.log('  🪷  mdWebview is running');
  console.log('  ───────────────────────');
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Vault:   ${getMdRoot()}`);
  console.log('');

  // Eagerly build Bigram Inverted Index in background on boot
  buildSearchIndexAsync().catch(() => {});

  // Set up the dictionary directory watcher (and index) at boot so the index
  // rebuilds automatically when dictionary files change — not only on fulltext.
  if (config.settings.dictionaryEnabled) {
    setupDictWatcher();
    buildDictIndexAsync().catch(() => {});
    // Warm the (large) dictionary section indexes so the first entry open is
    // fast even after a restart, independent of the bigram index build above.
    warmDictSectionIndexes().catch(() => {});
  }
});
