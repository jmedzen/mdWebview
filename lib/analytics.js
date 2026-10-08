/**
 * @file lib/analytics.js — 90-Day Analytics Store, Aggregation, and Export Engine
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const { LOG_DIR, ANALYTICS_STORE_PATH, ANALYTICS_STORE_VERSION } = require('./constants');
const { formatTimestampInTz, isBotEntry, extractAnalyticsPath, extractAnalyticsQuery } = require('./utils');
const { verifySameOrigin, isAuthenticated, sessions } = require('./auth');

try {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
} catch (e) {
  console.error('Failed to create logs directory:', e);
}

let analyticsStore = null;
let analyticsStoreReady = null;
let analyticsStoreWrite = Promise.resolve();
let analyticsStoreInitialized = false;

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

const MAX_PROCESSED_IDS = 10000;
const MAX_ANALYTICS_KEYS = 10000;

function pruneDailyBuckets(dailyMap, maxDays = 90) {
  if (!dailyMap) return;
  const days = Object.keys(dailyMap).sort();
  if (days.length > maxDays) {
    const excess = days.length - maxDays;
    for (let i = 0; i < excess; i++) {
      delete dailyMap[days[i]];
    }
  }
}

function pruneAnalyticsMap(map, maxKeys = MAX_ANALYTICS_KEYS) {
  if (!map || typeof map !== 'object') return;
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

  if (!store._processedCount) store._processedCount = Object.keys(store.processedIds).length;
  store._processedCount++;
  if (store._processedCount > MAX_PROCESSED_IDS + 1000) {
    const pKeys = Object.keys(store.processedIds);
    const toPrune = pKeys.length - MAX_PROCESSED_IDS;
    if (toPrune > 0) {
      for (let i = 0; i < toPrune; i++) {
        delete store.processedIds[pKeys[i]];
      }
    }
    store._processedCount = Object.keys(store.processedIds).length;
  }

  if (isBotEntry(entry)) {
    return true;
  }

  const ip = entry.ip || '127.0.0.1';
  const dateKey = timestamp.toISOString().split('T')[0];
  if (!store.daily[dateKey]) {
    pruneDailyBuckets(store.daily, 90);
  }
  const daily = analyticsMapGetOrCreate(store.daily, dateKey, () => ({
    views: 0,
    searchCount: 0,
    dictSearchCount: 0,
    dictLookupCount: 0,
    ips: {},
    files: {},
    searches: {},
    dictSearches: {},
    dictLookups: {}
  }));

  const lifetime = store.lifetime;
  lifetime.requests = (lifetime.requests || 0) + 1;

  const ipStat = analyticsMapGetOrCreate(lifetime.ips, ip, () => ({ requests: 0, lastAccess: entry.timestamp }));
  ipStat.requests++;
  if (new Date(entry.timestamp) > new Date(ipStat.lastAccess)) ipStat.lastAccess = entry.timestamp;

  daily.ips[ip] = (daily.ips[ip] || 0) + 1;

  if (entry.tag === 'Render') {
    const docPath = extractAnalyticsPath(entry);
    if (docPath) {
      lifetime.views = (lifetime.views || 0) + 1;
      daily.views = (daily.views || 0) + 1;

      const fStat = analyticsMapGetOrCreate(lifetime.files, docPath, () => ({ views: 0, ips: {}, lastAccess: entry.timestamp }));
      fStat.views++;
      fStat.ips[ip] = (fStat.ips[ip] || 0) + 1;
      if (new Date(entry.timestamp) > new Date(fStat.lastAccess)) fStat.lastAccess = entry.timestamp;

      daily.files[docPath] = (daily.files[docPath] || 0) + 1;
    }
  }

  if (entry.tag === 'Search') {
    const q = extractAnalyticsQuery(entry);
    if (q) {
      lifetime.searchCount = (lifetime.searchCount || 0) + 1;
      daily.searchCount = (daily.searchCount || 0) + 1;

      const sStat = analyticsMapGetOrCreate(lifetime.searches, q, () => ({ count: 0, lastSearch: entry.timestamp }));
      sStat.count++;
      if (new Date(entry.timestamp) > new Date(sStat.lastSearch)) sStat.lastSearch = entry.timestamp;

      daily.searches[q] = (daily.searches[q] || 0) + 1;
    }
  }

  if (entry.tag === 'DictSearch') {
    const q = extractAnalyticsQuery(entry);
    if (q) {
      lifetime.dictSearchCount = (lifetime.dictSearchCount || 0) + 1;
      daily.dictSearchCount = (daily.dictSearchCount || 0) + 1;

      const dsStat = analyticsMapGetOrCreate(lifetime.dictSearches, q, () => ({ count: 0, lastSearch: entry.timestamp }));
      dsStat.count++;
      if (new Date(entry.timestamp) > new Date(dsStat.lastSearch)) dsStat.lastSearch = entry.timestamp;

      daily.dictSearches[q] = (daily.dictSearches[q] || 0) + 1;
    }
  }

  if (entry.tag === 'DictLookup') {
    const headword = extractAnalyticsQuery(entry);
    const docPath = extractAnalyticsPath(entry);
    if (headword || docPath) {
      lifetime.dictLookupCount = (lifetime.dictLookupCount || 0) + 1;
      daily.dictLookupCount = (daily.dictLookupCount || 0) + 1;

      const key = `${docPath || ''}::${headword || ''}`;
      const dlStat = analyticsMapGetOrCreate(lifetime.dictLookups, key, () => ({ headword, path: docPath, count: 0, lastLookup: entry.timestamp }));
      dlStat.count++;
      if (new Date(entry.timestamp) > new Date(dlStat.lastLookup)) dlStat.lastLookup = entry.timestamp;

      daily.dictLookups[key] = (daily.dictLookups[key] || 0) + 1;
    }
  }

  return true;
}

async function saveAnalyticsStore() {
  if (!analyticsStore) return;
  analyticsStoreWrite = analyticsStoreWrite.then(async () => {
    try {
      if (analyticsStore.lifetime) {
        if (analyticsStore.lifetime.ips) pruneAnalyticsMap(analyticsStore.lifetime.ips);
        if (analyticsStore.lifetime.searches) pruneAnalyticsMap(analyticsStore.lifetime.searches);
        if (analyticsStore.lifetime.dictSearches) pruneAnalyticsMap(analyticsStore.lifetime.dictSearches);
        if (analyticsStore.lifetime.dictLookups) pruneAnalyticsMap(analyticsStore.lifetime.dictLookups);
      }
      analyticsStore.updatedAt = new Date().toISOString();
      const tempPath = `${ANALYTICS_STORE_PATH}.tmp-${process.pid}`;
      await fs.promises.writeFile(tempPath, JSON.stringify(analyticsStore), 'utf-8');
      await fs.promises.rename(tempPath, ANALYTICS_STORE_PATH);
    } catch (err) {
      console.error('Error saving analytics store:', err);
    }
  });
  return analyticsStoreWrite;
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
      if (analyticsStoreSaveTimer && analyticsStoreSaveTimer.unref) {
        analyticsStoreSaveTimer.unref();
      }
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
    const needsBackfill = !loaded || loaded.version !== ANALYTICS_STORE_VERSION || !loaded.lifetime || !loaded.daily || !loaded.processedIds;
    analyticsStore = needsBackfill ? createEmptyAnalyticsStore() : loaded;

    if (!needsBackfill && analyticsStore && analyticsStore.daily) {
      for (const bucket of Object.values(analyticsStore.daily)) {
        if (typeof bucket.searches === 'number' || Number.isNaN(bucket.searches)) {
          bucket.searchCount = Number.isFinite(bucket.searches) ? bucket.searches : (bucket.searchCount || 0);
          bucket.searches = {};
        } else if (!bucket.searches || typeof bucket.searches !== 'object') {
          bucket.searches = {};
        }
        if (bucket.searchCount === undefined) {
          bucket.searchCount = 0;
        }
      }
    }

    if (needsBackfill) {
      const files = (await fs.promises.readdir(LOG_DIR).catch(() => [])).sort();
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        await readAnalyticsFile(path.join(LOG_DIR, file), entry => {
          if (!entry.id) entry.id = getAnalyticsEventId(entry);
          updateAnalyticsStoreEntry(analyticsStore, entry);
        });
      }
      await saveAnalyticsStore();
    }
    analyticsStoreInitialized = true;
    return analyticsStore;
  })().catch(err => {
    analyticsStoreReady = null;
    console.error('Failed to initialize analytics aggregate:', err);
    throw err;
  });
  return analyticsStoreReady;
}

const LOG_PRUNE_AGE_DAYS = 7;
const LOG_PRUNE_AGE_MS = LOG_PRUNE_AGE_DAYS * 24 * 60 * 60 * 1000;

function pruneAnalyticsLogEntry(entry) {
  if (!entry || !entry.timestamp) return null;
  if (isBotEntry(entry)) return null;

  const tag = entry.tag || '';
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

  if (tag === 'Render') {
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
    if (now - stats.mtimeMs <= LOG_PRUNE_AGE_MS) return;

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

const analyticsCache = new Map();
const ANALYTICS_CACHE_TTL = 60000;
const ANALYTICS_CACHE_MAX = 20;

function sanitizeCsvField(val) {
  if (val === null || val === undefined) return '""';
  let str = String(val);
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
  const trendMap = new Map();
  Object.entries(store.daily || {}).forEach(([date, bucket]) => {
    let dateKey = date;
    if (requestedTz && requestedTz !== 'auto') {
      try {
        dateKey = formatTimestampInTz(new Date(`${date}T12:00:00Z`), requestedTz, 'date') || date;
      } catch (_) {}
    }
    const existing = trendMap.get(dateKey) || { date: dateKey, views: 0, ips: new Set() };
    existing.views += (bucket.views || 0);
    Object.keys(bucket.ips || {}).forEach(ip => existing.ips.add(ip));
    trendMap.set(dateKey, existing);
  });
  const dailyTrend = Array.from(trendMap.values()).map(item => ({
    date: item.date,
    views: item.views,
    uniqueIps: item.ips.size
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
      fileName: filePath.split('/').pop().replace(/\.md$/, ''),
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
      fileName: (stat.path || '').replace(/^dict:/, '').replace(/\.md$/, '') || stat.headword || '',
      count: stat.count || 0,
      lastLookup: stat.lastLookup
    })).sort((a, b) => b.count - a.count).slice(0, 50),
    dailyTrend,
    ipDistribution: ipEntries.map(([ip, stat]) => ({ ip, requests: stat.requests || 0, lastAccess: stat.lastAccess }))
      .sort((a, b) => b.requests - a.requests).slice(0, 20)
  };
}

let inMemoryLogBufferRef = [];
function setInMemoryLogBufferRef(buf) {
  if (Array.isArray(buf)) inMemoryLogBufferRef = buf;
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
  const seenEntryIds = new Set();

  const isOneDay = rangeKey === '1d';

  if (isOneDay) {
    for (let offset = 24; offset >= 0; offset--) {
      const slotTime = new Date(now - (offset * 60 * 60 * 1000));
      const slotKey = formatTimestampInTz(slotTime, requestedTz, 'hour');
      if (!dailyMap.has(slotKey)) {
        dailyMap.set(slotKey, { date: slotKey, views: 0, ips: new Set() });
      }
    }
  } else {
    for (let offset = rangeDays - 1; offset >= 0; offset--) {
      const slotTime = new Date(now - (offset * 24 * 60 * 60 * 1000));
      const slotKey = formatTimestampInTz(slotTime, requestedTz, 'date');
      if (!dailyMap.has(slotKey)) {
        dailyMap.set(slotKey, { date: slotKey, views: 0, ips: new Set() });
      }
    }
  }

  function processEntry(entry) {
    if (isBotEntry(entry)) return;
    const t = new Date(entry.timestamp).getTime();
    if (Number.isNaN(t) || t < cutoffTime) return;

    const id = entry.id || getAnalyticsEventId(entry);
    if (seenEntryIds.has(id)) return;
    seenEntryIds.add(id);

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

    const timeKey = isOneDay
      ? formatTimestampInTz(entry.timestamp, requestedTz, 'hour')
      : formatTimestampInTz(entry.timestamp, requestedTz, 'date');

    let daily = dailyMap.get(timeKey);
    if (!daily) {
      daily = { date: timeKey, views: 0, ips: new Set() };
      dailyMap.set(timeKey, daily);
    }
    daily.ips.add(ip);

    if (entry.tag === 'Render') {
      const docPath = extractAnalyticsPath(entry);
      if (docPath) {
        totalViews++;
        daily.views++;
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
      const q = extractAnalyticsQuery(entry);
      if (q && q.length > 0) {
        totalSearches++;
        let sStat = searchMap.get(q);
        if (!sStat) {
          sStat = { query: q, count: 0, lastSearch: entry.timestamp };
          searchMap.set(q, sStat);
        }
        sStat.count++;
        if (new Date(entry.timestamp) > new Date(sStat.lastSearch)) {
          sStat.lastSearch = entry.timestamp;
        }
      }
    }

    if (entry.tag === 'DictSearch') {
      const q = extractAnalyticsQuery(entry);
      if (q && q.length > 0) {
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
      const headword = extractAnalyticsQuery(entry);
      const docPath = extractAnalyticsPath(entry);
      if (headword || docPath) {
        totalDictLookups++;
        const key = `${docPath || ''}::${headword || ''}`;
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
    try {
      const filePath = path.join(LOG_DIR, file);
      const dateMatch = file.match(/^access-(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (dateMatch) {
        const fileEndTime = new Date(`${dateMatch[1]}T23:59:59.999Z`).getTime();
        if (!Number.isNaN(fileEndTime) && fileEndTime < cutoffTime) continue;
      } else {
        const stats = await fs.promises.stat(filePath);
        if (stats.mtimeMs < cutoffTime - (24 * 60 * 60 * 1000)) continue;
      }

      const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
      const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

      for await (const line of rl) {
        if (!line.trim()) continue;
        try { processEntry(JSON.parse(line)); } catch (_) {}
      }
    } catch (_) {}
  }

  for (const memItem of inMemoryLogBufferRef) {
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
      headword: l.headword || '',
      path: l.path || '',
      fileName: (l.path || '').replace(/^dict:/, '').replace(/\.md$/, '') || l.headword || '',
      count: l.count || 0,
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

async function handleAnalyticsExport(req, res, query) {
  if (!verifySameOrigin(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Forbidden: Cross-origin request blocked' }));
    return;
  }

  const token = query.token || req.headers['x-admin-token'];
  let authorized = isAuthenticated(req);
  if (!authorized && token && sessions.has(token)) {
    const session = sessions.get(token);
    if (session && Date.now() < session.expiry) {
      authorized = true;
    }
  }
  if (!authorized) {
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  const format = query.format === 'csv' ? 'csv' : 'json';
  let rangeKey;
  try {
    rangeKey = parseAnalyticsRange(query.range);
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: err.message }));
    return;
  }
  const data = await getAnalyticsData(rangeKey, query.tz || 'auto');

  if (format === 'csv') {
    const tz = query.tz || 'auto';
    const formatTime = (ts) => {
      if (!ts) return '';
      try {
        const d = new Date(ts);
        if (Number.isNaN(d.getTime())) return String(ts);
        const timeZone = (tz && tz !== 'auto') ? tz : 'UTC';
        return new Intl.DateTimeFormat('zh-TW', {
          timeZone,
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit',
          hour12: false
        }).format(d).replace(/\//g, '-');
      } catch (_) {
        return String(ts);
      }
    };

    let csv = '\uFEFF';
    csv += `[數據分析報表 - mdWebview]\n`;
    csv += `時間範圍,${rangeKey},統計時區,${tz},報表生成時間,${formatTime(new Date())}\n\n`;

    csv += `[數據摘要]\n`;
    csv += `指標項目,數值\n`;
    csv += `總閱讀點閱數 (PV),${data.summary.totalViews || 0}\n`;
    csv += `獨立訪客數 (UV),${data.summary.uniqueIps || 0}\n`;
    csv += `搜尋總次數,${data.summary.totalSearches || 0}\n`;
    csv += `活躍文章數,${data.summary.activeFiles || 0}\n`;
    const avgViews = (data.summary.activeFiles > 0) ? (data.summary.totalViews / data.summary.activeFiles).toFixed(1) : '0';
    csv += `平均每篇點閱數,${avgViews}\n`;
    csv += `辭典搜尋次數,${data.summary.dictSearches || 0}\n`;
    csv += `辭典查閱詞條數,${data.summary.dictLookups || 0}\n\n`;

    csv += `[熱門閱讀經論排行 (Top ${data.topFiles.length})]\n`;
    csv += '排名,文章標題/檔名,文章路徑,總點閱數,獨立IP數,最後閱讀時間\n';
    data.topFiles.forEach((f, idx) => {
      csv += `${idx + 1},${sanitizeCsvField(f.fileName)},${sanitizeCsvField(f.path)},${f.views || 0},${f.uniqueIps || 0},${sanitizeCsvField(formatTime(f.lastAccess))}\n`;
    });
    csv += '\n';

    if (data.topSearches && data.topSearches.length > 0) {
      csv += `[熱門全文搜尋關鍵字 (Top ${data.topSearches.length})]\n`;
      csv += '排名,搜尋關鍵字,搜尋次數,最後搜尋時間\n';
      data.topSearches.forEach((s, idx) => {
        csv += `${idx + 1},${sanitizeCsvField(s.query)},${s.count || 0},${sanitizeCsvField(formatTime(s.lastSearch))}\n`;
      });
      csv += '\n';
    }

    if (data.topLookups && data.topLookups.length > 0) {
      csv += `[熱門辭典查閱詞條 (Top ${data.topLookups.length})]\n`;
      csv += '排名,查閱詞條,所屬辭典,查閱次數,最後查閱時間\n';
      data.topLookups.forEach((l, idx) => {
        csv += `${idx + 1},${sanitizeCsvField(l.headword)},${sanitizeCsvField(l.fileName || l.path)},${l.count || 0},${sanitizeCsvField(formatTime(l.lastLookup))}\n`;
      });
      csv += '\n';
    }

    if (data.topDictSearches && data.topDictSearches.length > 0) {
      csv += `[熱門辭典搜尋關鍵字 (Top ${data.topDictSearches.length})]\n`;
      csv += '排名,搜尋關鍵字,搜尋次數,最後搜尋時間\n';
      data.topDictSearches.forEach((s, idx) => {
        csv += `${idx + 1},${sanitizeCsvField(s.query)},${s.count || 0},${sanitizeCsvField(formatTime(s.lastSearch))}\n`;
      });
      csv += '\n';
    }

    csv += `[每日閱讀趨勢]\n`;
    csv += '日期,閱讀次數 (PV),獨立訪客 (UV)\n';
    data.dailyTrend.forEach((d) => {
      csv += `${sanitizeCsvField(d.date)},${d.views || 0},${d.uniqueIps || 0}\n`;
    });
    csv += '\n';

    csv += `[IP 訪問分佈 (Top ${data.ipDistribution.length})]\n`;
    csv += 'IP 位址,請求次數,最後訪問時間\n';
    data.ipDistribution.forEach((ip) => {
      csv += `${sanitizeCsvField(ip.ip)},${ip.requests || 0},${sanitizeCsvField(formatTime(ip.lastAccess))}\n`;
    });

    const filename = `mdWebview-analytics-${rangeKey}-${new Date().toISOString().substring(0, 10)}.csv`;
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`
    });
    res.end(csv);
    return;
  }

  const filename = `mdWebview-analytics-${rangeKey}-${new Date().toISOString().substring(0, 10)}.json`;
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`
  });
  res.end(JSON.stringify(data, null, 2));
}

// Background startup initialization
initializeAnalyticsStore().then(() => {
  cleanOldLogsJob();
  const cleanLogsTimer = setInterval(cleanOldLogsJob, 24 * 60 * 60 * 1000);
  if (cleanLogsTimer && cleanLogsTimer.unref) cleanLogsTimer.unref();
}).catch(() => {});

module.exports = {
  analyticsStore,
  getLogFilePath,
  appendToPersistentLog,
  getAnalyticsEventId,
  updateAnalyticsStoreEntry,
  saveAnalyticsStore,
  queueAnalyticsStoreEntry,
  initializeAnalyticsStore,
  cleanOldLogsJob,
  buildAggregateAnalyticsData,
  getAnalyticsData,
  parseAnalyticsRange,
  sanitizeCsvField,
  handleAnalyticsExport,
  setInMemoryLogBufferRef
};
