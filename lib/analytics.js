/**
 * @file lib/analytics.js — 90-Day Analytics Store, Aggregation, and Export Engine
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const { LOG_DIR, ANALYTICS_STORE_PATH, ANALYTICS_STORE_VERSION, IS_SINGLE_USER } = require('./constants');
const { formatTimestampInTz, isBotEntry, extractAnalyticsPath, extractAnalyticsQuery } = require('./utils');
const { verifySameOrigin, isAuthenticated } = require('./auth');

// analytics 於 server.js 中先於 logger 載入，且 logger.js 反過來 require analytics，
// 因此不可在此頂層 require('./logger')（會導致 setInMemoryLogBufferRef 尚未定義而崩潰）。
// 以 lazy accessor 於實際記錄時才取得 logger，尚未就緒時退回 console，永不拋錯。
let analyticsLoggerRef = null;
function getLogger() {
  if (analyticsLoggerRef) return analyticsLoggerRef;
  try {
    const mod = require('./logger');
    if (mod && mod.Logger) {
      analyticsLoggerRef = mod.Logger;
      return analyticsLoggerRef;
    }
  } catch (_) {}
  return console;
}

try {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
} catch (e) {
  getLogger().error('LogPruner', 'Failed to create logs directory', e);
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

/**
 * 回報持久化日誌寫入失敗。
 *
 * 關鍵：這裡「絕對不能」透過 Logger 記錄。Logger 每次記錄都會呼叫
 * appendToPersistentLog，因此一旦寫入持續失敗（LOG_DIR 被刪除或輪替、磁碟滿、
 * 權限不足），就會形成
 *
 *     寫入失敗 → Logger.error → appendToPersistentLog → 寫入失敗 → …
 *
 * 的自我維持無限迴圈：既不會停止，也會在數十秒內灌出 GB 級輸出並佔滿事件迴圈，
 * 使行程永遠無法結束。因此改為直接寫 stderr，且同一種失敗只回報一次。
 */
let persistentLogFailureReported = false;

function reportPersistentLogFailure(err) {
  if (persistentLogFailureReported) return;
  persistentLogFailureReported = true;
  const detail = (err && (err.code || err.message)) || String(err);
  try {
    process.stderr.write(
      `[analytics] persistent log write failed, further failures suppressed: ${detail}\n`
    );
  } catch (_) {}
}

function appendToPersistentLog(logEntry) {
  try {
    const filePath = getLogFilePath(new Date(logEntry.timestamp));
    const line = JSON.stringify(logEntry) + '\n';
    fs.appendFile(filePath, line, (err) => {
      if (err) reportPersistentLogFailure(err);
    });
  } catch (err) {
    reportPersistentLogFailure(err);
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

// 單調遞增的事件序號：相同時間戳/等級/tag/ip/訊息/path/query/durationMs 的兩筆事件
// 若無序號會產生相同 sha256，被 processedIds 去重而漏計。序號會寫入持久化日誌行，
// 因此同一行重新讀取 (backfill/dedup) 仍得到相同 id，不會重複計數。
let analyticsEventSeq = 0;

/**
 * 取得下一個事件序號並寫入 entry.seq。
 * @param {object} entry 日誌條目
 * @returns {number} 指派的序號
 */
function assignAnalyticsEventSeq(entry) {
  if (entry && entry.seq === undefined) {
    entry.seq = ++analyticsEventSeq;
  }
  return analyticsEventSeq;
}

function getAnalyticsEventId(entry) {
  const identity = {
    timestamp: entry.timestamp, level: entry.level, tag: entry.tag, ip: entry.ip,
    message: entry.message, path: entry.path || '', query: entry.query || '', durationMs: entry.durationMs || 0
  };
  // 僅在 entry 帶有序號時納入 identity：舊日誌行雜湊維持不變，與既有 processedIds 相容。
  if (entry.seq !== undefined && entry.seq !== null) identity.seq = entry.seq;
  return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

const MAX_PROCESSED_IDS = 2000;
const MAX_ANALYTICS_KEYS = 5000;
const MAX_FILE_IPS_TRACKED = 100;

/**
 * 清理舊版遺留的損壞路徑（例如未剝除 HTTP 存取尾綴 " -> 200 (41ms)" 的路徑）。
 * @param {string} rawPath
 * @returns {string}
 */
function cleanAnalyticsDocPath(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') return '';
  const cleaned = rawPath.replace(/\s*->\s*\d{3}(?:\s*\(\d+m?s?\)?)?.*$/, '').trim();
  if (!cleaned || cleaned.includes('..') || cleaned === 'not-exist-sutra-999.md') return '';
  return cleaned;
}

/**
 * 將可能為舊版物件 `{ views, requests, count }` 或損壞字串 `"[object Object]111"` 的數值安全轉為非負整數。
 * @param {*} val
 * @param {string} [prop]
 * @returns {number}
 */
function toSafeCount(val, prop = 'count') {
  if (typeof val === 'number' && Number.isFinite(val)) return Math.max(0, Math.floor(val));
  if (typeof val === 'string') {
    if (val.startsWith('[object Object]')) {
      return 1 + (val.length - '[object Object]'.length);
    }
    const parsed = Number(val);
    return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 1;
  }
  if (val && typeof val === 'object') {
    const c = val[prop] ?? val.views ?? val.requests ?? val.count;
    return Number.isFinite(Number(c)) ? Math.max(0, Math.floor(Number(c))) : 1;
  }
  return 0;
}

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

/**
 * 淘汰超出上限的 Map keys：優先保留計數較高或近期活躍的項目，避免熱門項目被隨機洗掉。
 */
function pruneAnalyticsMap(map, maxKeys = MAX_ANALYTICS_KEYS) {
  if (!map || typeof map !== 'object') return;
  const keys = Object.keys(map);
  const excess = keys.length - maxKeys;
  if (excess <= 0) return;

  // 依計數由小到大排序，優先淘汰計數最低的長尾項目（同分則淘汰較早寫入者）
  keys.sort((a, b) => toSafeCount(map[a]) - toSafeCount(map[b]));
  for (let i = 0; i < excess; i++) {
    delete map[keys[i]];
  }
}

function analyticsMapGetOrCreate(map, key, make, maxKeys = MAX_ANALYTICS_KEYS) {
  let entry = map[key];
  if (!entry) {
    entry = map[key] = make();
    if (Object.keys(map).length > maxKeys + 200) {
      pruneAnalyticsMap(map, maxKeys);
    }
  }
  return entry;
}

function createEmptyDailyBucket() {
  return {
    views: 0,
    searchCount: 0,
    dictSearchCount: 0,
    dictLookupCount: 0,
    ips: {},
    files: {},
    searches: {},
    dictSearches: {},
    dictLookups: {}
  };
}

/**
 * 將單日或多日聚合結構正規化為精簡數值映射（消除舊版巢狀物件與損壞路徑鍵）。
 */
function normalizeDailyBucket(bucket) {
  const norm = createEmptyDailyBucket();
  if (!bucket || typeof bucket !== 'object') return norm;

  const rawSearchesIsNum = typeof bucket.searches === 'number';
  norm.views = toSafeCount(bucket.views, 'views');
  norm.searchCount = toSafeCount(bucket.searchCount, 'count') || (rawSearchesIsNum ? toSafeCount(bucket.searches) : 0);
  norm.dictSearchCount = toSafeCount(bucket.dictSearchCount, 'count');
  norm.dictLookupCount = toSafeCount(bucket.dictLookupCount, 'count');

  for (const [ip, v] of Object.entries(bucket.ips || {})) {
    const c = toSafeCount(v, 'requests');
    if (c > 0) norm.ips[ip] = (norm.ips[ip] || 0) + c;
  }

  let computedViews = 0;
  for (const [rawPath, v] of Object.entries(bucket.files || {})) {
    const docPath = cleanAnalyticsDocPath(rawPath);
    if (!docPath) continue;
    const c = toSafeCount(v, 'views');
    if (c > 0) {
      norm.files[docPath] = (norm.files[docPath] || 0) + c;
      computedViews += c;
    }
  }
  if (computedViews > norm.views) norm.views = computedViews;

  if (bucket.searches && typeof bucket.searches === 'object') {
    let computedSearches = 0;
    for (const [q, v] of Object.entries(bucket.searches)) {
      const c = toSafeCount(v, 'count');
      if (c > 0) {
        norm.searches[q] = (norm.searches[q] || 0) + c;
        computedSearches += c;
      }
    }
    if (computedSearches > norm.searchCount) norm.searchCount = computedSearches;
  }

  if (bucket.dictSearches && typeof bucket.dictSearches === 'object') {
    for (const [q, v] of Object.entries(bucket.dictSearches)) {
      const c = toSafeCount(v, 'count');
      if (c > 0) norm.dictSearches[q] = (norm.dictSearches[q] || 0) + c;
    }
  }

  if (bucket.dictLookups && typeof bucket.dictLookups === 'object') {
    for (const [k, v] of Object.entries(bucket.dictLookups)) {
      const c = toSafeCount(v, 'count');
      if (c > 0) norm.dictLookups[k] = (norm.dictLookups[k] || 0) + c;
    }
  }

  return norm;
}

/**
 * 正規化並瘦身整個 analyticsStore（修復舊版路徑尾綴汙染、壓縮 processedIds 與 daily 結構）。
 */
function normalizeAnalyticsStore(store) {
  if (!store || typeof store !== 'object') return createEmptyAnalyticsStore();
  if (!store.lifetime || typeof store.lifetime !== 'object') {
    store.lifetime = createEmptyAnalyticsStore().lifetime;
  }
  const lt = store.lifetime;
  lt.requests = toSafeCount(lt.requests, 'requests');
  lt.views = toSafeCount(lt.views, 'views');
  lt.searchCount = toSafeCount(lt.searchCount, 'count');
  lt.dictSearchCount = toSafeCount(lt.dictSearchCount, 'count');
  lt.dictLookupCount = toSafeCount(lt.dictLookupCount, 'count');
  lt.dictBrowseCount = toSafeCount(lt.dictBrowseCount, 'count');
  lt.ips = lt.ips && typeof lt.ips === 'object' ? lt.ips : {};
  lt.searches = lt.searches && typeof lt.searches === 'object' ? lt.searches : {};
  lt.dictSearches = lt.dictSearches && typeof lt.dictSearches === 'object' ? lt.dictSearches : {};
  lt.dictLookups = lt.dictLookups && typeof lt.dictLookups === 'object' ? lt.dictLookups : {};

  // 清理並合併 lifetime.files 中的髒路徑，且將每檔 ips 映射的值簡化為 1 並限制上限
  const cleanedFiles = {};
  for (const [rawPath, stat] of Object.entries(lt.files || {})) {
    const docPath = cleanAnalyticsDocPath(rawPath);
    if (!docPath || !stat || typeof stat !== 'object') continue;
    let target = cleanedFiles[docPath];
    if (!target) {
      target = cleanedFiles[docPath] = {
        views: 0,
        ips: {},
        lastAccess: stat.lastAccess || new Date(0).toISOString()
      };
    }
    target.views += toSafeCount(stat.views, 'views');
    if (stat.ips && typeof stat.ips === 'object') {
      for (const ip of Object.keys(stat.ips)) {
        if (Object.keys(target.ips).length < MAX_FILE_IPS_TRACKED) {
          target.ips[ip] = 1;
        }
      }
    }
    if (stat.lastAccess && new Date(stat.lastAccess) > new Date(target.lastAccess)) {
      target.lastAccess = stat.lastAccess;
    }
  }
  lt.files = cleanedFiles;
  pruneAnalyticsMap(lt.files, MAX_ANALYTICS_KEYS);
  pruneAnalyticsMap(lt.ips, MAX_ANALYTICS_KEYS);
  pruneAnalyticsMap(lt.searches, MAX_ANALYTICS_KEYS);
  pruneAnalyticsMap(lt.dictSearches, MAX_ANALYTICS_KEYS);
  pruneAnalyticsMap(lt.dictLookups, MAX_ANALYTICS_KEYS);

  // 正規化 daily buckets 並限制最多保留 90 天
  const rawDaily = store.daily && typeof store.daily === 'object' ? store.daily : {};
  const cleanedDaily = {};
  for (const [dateKey, bucket] of Object.entries(rawDaily)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) continue;
    cleanedDaily[dateKey] = normalizeDailyBucket(bucket);
  }
  pruneDailyBuckets(cleanedDaily, 90);
  store.daily = cleanedDaily;

  // 壓縮 processedIds：僅保留最近 MAX_PROCESSED_IDS 筆，值存 1（省去每筆 26 bytes ISO 時間字串）
  const rawProcessed = store.processedIds && typeof store.processedIds === 'object' ? store.processedIds : {};
  const pKeys = Object.keys(rawProcessed);
  const keepKeys = pKeys.length > MAX_PROCESSED_IDS ? pKeys.slice(pKeys.length - MAX_PROCESSED_IDS) : pKeys;
  const compactProcessed = {};
  for (const k of keepKeys) compactProcessed[k] = 1;
  store.processedIds = compactProcessed;
  delete store._processedCount;

  return store;
}

function updateAnalyticsStoreEntry(store, entry) {
  const timestamp = new Date(entry.timestamp);
  if (Number.isNaN(timestamp.getTime())) return false;
  const id = entry.id || getAnalyticsEventId(entry);
  if (store.processedIds[id]) return false;

  if (isBotEntry(entry)) {
    return false;
  }

  store.processedIds[id] = 1;

  if (!store._processedCount) store._processedCount = Object.keys(store.processedIds).length;
  store._processedCount++;
  if (store._processedCount > MAX_PROCESSED_IDS + 500) {
    const pKeys = Object.keys(store.processedIds);
    const toPrune = pKeys.length - MAX_PROCESSED_IDS;
    if (toPrune > 0) {
      for (let i = 0; i < toPrune; i++) {
        delete store.processedIds[pKeys[i]];
      }
    }
    store._processedCount = Object.keys(store.processedIds).length;
  }

  const ip = entry.ip || '127.0.0.1';
  const dateKey = timestamp.toISOString().split('T')[0];
  if (!store.daily[dateKey]) {
    pruneDailyBuckets(store.daily, 90);
  }
  const daily = analyticsMapGetOrCreate(store.daily, dateKey, createEmptyDailyBucket);

  const lifetime = store.lifetime;
  lifetime.requests = (lifetime.requests || 0) + 1;

  const ipStat = analyticsMapGetOrCreate(lifetime.ips, ip, () => ({ requests: 0, lastAccess: entry.timestamp }));
  ipStat.requests++;
  if (new Date(entry.timestamp) > new Date(ipStat.lastAccess)) ipStat.lastAccess = entry.timestamp;

  daily.ips[ip] = toSafeCount(daily.ips[ip], 'requests') + 1;

  if (entry.tag === 'Render') {
    const docPath = cleanAnalyticsDocPath(extractAnalyticsPath(entry));
    if (docPath) {
      lifetime.views = (lifetime.views || 0) + 1;
      daily.views = toSafeCount(daily.views, 'views') + 1;

      const fStat = analyticsMapGetOrCreate(lifetime.files, docPath, () => ({ views: 0, ips: {}, lastAccess: entry.timestamp }));
      fStat.views++;
      if (!fStat.ips[ip] && Object.keys(fStat.ips).length < MAX_FILE_IPS_TRACKED) {
        fStat.ips[ip] = 1;
      }
      if (new Date(entry.timestamp) > new Date(fStat.lastAccess)) fStat.lastAccess = entry.timestamp;

      daily.files[docPath] = toSafeCount(daily.files[docPath], 'views') + 1;
    }
  }

  if (entry.tag === 'Search') {
    const q = extractAnalyticsQuery(entry);
    if (q) {
      lifetime.searchCount = (lifetime.searchCount || 0) + 1;
      daily.searchCount = toSafeCount(daily.searchCount, 'count') + 1;

      const sStat = analyticsMapGetOrCreate(lifetime.searches, q, () => ({ count: 0, lastSearch: entry.timestamp }));
      sStat.count++;
      if (new Date(entry.timestamp) > new Date(sStat.lastSearch)) sStat.lastSearch = entry.timestamp;

      daily.searches[q] = toSafeCount(daily.searches[q], 'count') + 1;
    }
  }

  if (entry.tag === 'DictSearch') {
    const q = extractAnalyticsQuery(entry);
    if (q) {
      lifetime.dictSearchCount = (lifetime.dictSearchCount || 0) + 1;
      daily.dictSearchCount = toSafeCount(daily.dictSearchCount, 'count') + 1;

      const dsStat = analyticsMapGetOrCreate(lifetime.dictSearches, q, () => ({ count: 0, lastSearch: entry.timestamp }));
      dsStat.count++;
      if (new Date(entry.timestamp) > new Date(dsStat.lastSearch)) dsStat.lastSearch = entry.timestamp;

      daily.dictSearches[q] = toSafeCount(daily.dictSearches[q], 'count') + 1;
    }
  }

  if (entry.tag === 'DictLookup') {
    const headword = extractAnalyticsQuery(entry);
    const docPath = cleanAnalyticsDocPath(extractAnalyticsPath(entry)) || extractAnalyticsPath(entry);
    if (headword || docPath) {
      lifetime.dictLookupCount = (lifetime.dictLookupCount || 0) + 1;
      daily.dictLookupCount = toSafeCount(daily.dictLookupCount, 'count') + 1;

      const key = `${docPath || ''}::${headword || ''}`;
      const dlStat = analyticsMapGetOrCreate(lifetime.dictLookups, key, () => ({ headword, path: docPath, count: 0, lastLookup: entry.timestamp }));
      dlStat.count++;
      if (new Date(entry.timestamp) > new Date(dlStat.lastLookup)) dlStat.lastLookup = entry.timestamp;

      daily.dictLookups[key] = toSafeCount(daily.dictLookups[key], 'count') + 1;
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
      getLogger().error('Analytics', 'Error saving analytics store', err);
    }
  });
  return analyticsStoreWrite;
}

let analyticsStoreSaveTimer = null;

// 啟動視窗緩衝：analytics store 尚未載入完成時，仍會寫入 jsonl 的條目先暫存於此，
// 待 initializeAnalyticsStore() 完成後補送。上限避免無界成長；超出時丟棄最舊者，
// 這些條目仍留在 jsonl（下次版本升級觸發 backfill 時可回收）。
const MAX_PENDING_STORE_ENTRIES = 2000;
const pendingAnalyticsEntries = [];

function flushPendingAnalyticsEntries() {
  if (!analyticsStoreInitialized || !analyticsStore) return;
  const pending = pendingAnalyticsEntries.splice(0, pendingAnalyticsEntries.length);
  for (const entry of pending) {
    if (updateAnalyticsStoreEntry(analyticsStore, entry)) scheduleAnalyticsStoreSave();
  }
}

function scheduleAnalyticsStoreSave() {
  if (analyticsStoreSaveTimer) return;
  analyticsStoreSaveTimer = setTimeout(() => {
    analyticsStoreSaveTimer = null;
    saveAnalyticsStore().catch(err => getLogger().error('Analytics', 'Error saving analytics aggregate', err));
  }, 30000);
  if (analyticsStoreSaveTimer && analyticsStoreSaveTimer.unref) {
    analyticsStoreSaveTimer.unref();
  }
}

function queueAnalyticsStoreEntry(entry) {
  if (!analyticsStoreInitialized || !analyticsStore) {
    if (entry) {
      pendingAnalyticsEntries.push(entry);
      if (pendingAnalyticsEntries.length > MAX_PENDING_STORE_ENTRIES) {
        pendingAnalyticsEntries.shift();
      }
    }
    return;
  }
  if (updateAnalyticsStoreEntry(analyticsStore, entry)) {
    scheduleAnalyticsStoreSave();
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
    let rawBytes = 0;
    try {
      const raw = await fs.promises.readFile(ANALYTICS_STORE_PATH, 'utf-8');
      rawBytes = Buffer.byteLength(raw);
      loaded = JSON.parse(raw);
    } catch (_) {}
    const needsBackfill = !loaded || loaded.version !== ANALYTICS_STORE_VERSION || !loaded.lifetime || !loaded.daily || !loaded.processedIds;
    analyticsStore = needsBackfill ? createEmptyAnalyticsStore() : normalizeAnalyticsStore(loaded);

    if (needsBackfill) {
      const files = (await fs.promises.readdir(LOG_DIR).catch(() => [])).sort();
      for (const file of files) {
        if (!file.endsWith('.jsonl') || file.includes('.sync-conflict-')) continue;
        await readAnalyticsFile(path.join(LOG_DIR, file), entry => {
          if (!entry.id) entry.id = getAnalyticsEventId(entry);
          updateAnalyticsStoreEntry(analyticsStore, entry);
        });
      }
      await saveAnalyticsStore();
    } else if (rawBytes > 0) {
      const normalizedBytes = Buffer.byteLength(JSON.stringify(analyticsStore));
      if (rawBytes - normalizedBytes > 32 * 1024) {
        await saveAnalyticsStore();
      }
    }
    analyticsStoreInitialized = true;
    // 補送啟動視窗期間暫存的條目（D5）：它們已寫入 jsonl，但先前因 store 尚未就緒
    // 而無法進入聚合。backfill 只發生於版本升級，故不能倚賴它回收。
    flushPendingAnalyticsEntries();
    return analyticsStore;
  })().catch(err => {
    analyticsStoreReady = null;
    getLogger().error('Analytics', 'Failed to initialize analytics aggregate', err);
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
  const docPath = cleanAnalyticsDocPath(extractAnalyticsPath(entry));
  const query = extractAnalyticsQuery(entry);
  // 保留原始序號，使精簡後的相同 tuple 仍可區分，且重讀同一行對應相同 id (F8)。
  const seqFields = entry.seq !== undefined ? { seq: entry.seq } : {};

  if (tag === 'DictSearch') {
    if (!query) return null;
    return {
      timestamp: entry.timestamp,
      tag: 'DictSearch',
      ip: entry.ip || '127.0.0.1',
      query: query,
      ...seqFields,
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
      ...seqFields,
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
      ...seqFields,
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
      ...seqFields,
      pruned: true
    };
  }

  if (entry.ip && entry.ip !== '127.0.0.1') {
    return {
      timestamp: entry.timestamp,
      tag: tag || 'HTTP',
      ip: entry.ip,
      ...seqFields,
      pruned: true
    };
  }

  return null;
}

/**
 * 將單一過期 jsonl 日誌檔的統計事件冪等歸檔至 analyticsStore（以單日最大值合併，避免重複計數），
 * 確保刪除 7 天前的原生 log 前，簡化日聚合數據已完整保存在 analyticsStore.daily 中。
 */
async function rollupLogFileToStore(filePath) {
  if (!analyticsStore) await initializeAnalyticsStore();
  if (!analyticsStore) return 0;

  const byDate = new Map(); // dateKey -> { bucket, lastTsByFile, ipsByFile, lastTsByIp, lastTsBySearch, lastTsByDictSearch, lastTsByDictLookup, metaByDictLookup }
  const seenIds = new Set();
  let validEvents = 0;

  await readAnalyticsFile(filePath, (entry) => {
    if (!entry || !entry.timestamp || isBotEntry(entry)) return;
    const ts = new Date(entry.timestamp);
    if (Number.isNaN(ts.getTime())) return;

    const id = entry.id || getAnalyticsEventId(entry);
    if (seenIds.has(id)) return;
    seenIds.add(id);
    validEvents++;

    const dateKey = ts.toISOString().split('T')[0];
    let dayAcc = byDate.get(dateKey);
    if (!dayAcc) {
      dayAcc = {
        bucket: createEmptyDailyBucket(),
        lastTsByFile: {},
        ipsByFile: {},
        lastTsByIp: {},
        lastTsBySearch: {},
        lastTsByDictSearch: {},
        lastTsByDictLookup: {},
        metaByDictLookup: {}
      };
      byDate.set(dateKey, dayAcc);
    }

    const ip = entry.ip || '127.0.0.1';
    dayAcc.bucket.ips[ip] = (dayAcc.bucket.ips[ip] || 0) + 1;
    if (!dayAcc.lastTsByIp[ip] || entry.timestamp > dayAcc.lastTsByIp[ip]) {
      dayAcc.lastTsByIp[ip] = entry.timestamp;
    }

    if (entry.tag === 'Render') {
      const docPath = cleanAnalyticsDocPath(extractAnalyticsPath(entry));
      if (docPath) {
        dayAcc.bucket.views++;
        dayAcc.bucket.files[docPath] = (dayAcc.bucket.files[docPath] || 0) + 1;
        if (!dayAcc.lastTsByFile[docPath] || entry.timestamp > dayAcc.lastTsByFile[docPath]) {
          dayAcc.lastTsByFile[docPath] = entry.timestamp;
        }
        if (!dayAcc.ipsByFile[docPath]) dayAcc.ipsByFile[docPath] = new Set();
        if (dayAcc.ipsByFile[docPath].size < MAX_FILE_IPS_TRACKED) {
          dayAcc.ipsByFile[docPath].add(ip);
        }
      }
    } else if (entry.tag === 'Search') {
      const q = extractAnalyticsQuery(entry);
      if (q) {
        dayAcc.bucket.searchCount++;
        dayAcc.bucket.searches[q] = (dayAcc.bucket.searches[q] || 0) + 1;
        if (!dayAcc.lastTsBySearch[q] || entry.timestamp > dayAcc.lastTsBySearch[q]) {
          dayAcc.lastTsBySearch[q] = entry.timestamp;
        }
      }
    } else if (entry.tag === 'DictSearch') {
      const q = extractAnalyticsQuery(entry);
      if (q) {
        dayAcc.bucket.dictSearchCount++;
        dayAcc.bucket.dictSearches[q] = (dayAcc.bucket.dictSearches[q] || 0) + 1;
        if (!dayAcc.lastTsByDictSearch[q] || entry.timestamp > dayAcc.lastTsByDictSearch[q]) {
          dayAcc.lastTsByDictSearch[q] = entry.timestamp;
        }
      }
    } else if (entry.tag === 'DictLookup') {
      const headword = extractAnalyticsQuery(entry);
      const docPath = cleanAnalyticsDocPath(extractAnalyticsPath(entry)) || extractAnalyticsPath(entry);
      if (headword || docPath) {
        const key = `${docPath || ''}::${headword || ''}`;
        dayAcc.bucket.dictLookupCount++;
        dayAcc.bucket.dictLookups[key] = (dayAcc.bucket.dictLookups[key] || 0) + 1;
        dayAcc.metaByDictLookup[key] = { headword, path: docPath };
        if (!dayAcc.lastTsByDictLookup[key] || entry.timestamp > dayAcc.lastTsByDictLookup[key]) {
          dayAcc.lastTsByDictLookup[key] = entry.timestamp;
        }
      }
    }
  });

  const lt = analyticsStore.lifetime;
  for (const [dateKey, dayAcc] of byDate.entries()) {
    const src = dayAcc.bucket;
    if (!analyticsStore.daily[dateKey]) {
      pruneDailyBuckets(analyticsStore.daily, 90);
    }
    const dst = analyticsMapGetOrCreate(analyticsStore.daily, dateKey, createEmptyDailyBucket);

    // 冪等合併：若該日 bucket 尚未完整計入，僅補齊差額至 daily 與 lifetime
    const viewDelta = Math.max(0, src.views - toSafeCount(dst.views, 'views'));
    dst.views = Math.max(toSafeCount(dst.views, 'views'), src.views);
    lt.views = (lt.views || 0) + viewDelta;

    const searchDelta = Math.max(0, src.searchCount - toSafeCount(dst.searchCount, 'count'));
    dst.searchCount = Math.max(toSafeCount(dst.searchCount, 'count'), src.searchCount);
    lt.searchCount = (lt.searchCount || 0) + searchDelta;

    const dsDelta = Math.max(0, src.dictSearchCount - toSafeCount(dst.dictSearchCount, 'count'));
    dst.dictSearchCount = Math.max(toSafeCount(dst.dictSearchCount, 'count'), src.dictSearchCount);
    lt.dictSearchCount = (lt.dictSearchCount || 0) + dsDelta;

    const dlDelta = Math.max(0, src.dictLookupCount - toSafeCount(dst.dictLookupCount, 'count'));
    dst.dictLookupCount = Math.max(toSafeCount(dst.dictLookupCount, 'count'), src.dictLookupCount);
    lt.dictLookupCount = (lt.dictLookupCount || 0) + dlDelta;

    for (const [ip, c] of Object.entries(src.ips)) {
      const prev = toSafeCount(dst.ips[ip], 'requests');
      const delta = Math.max(0, c - prev);
      dst.ips[ip] = Math.max(prev, c);
      lt.requests = (lt.requests || 0) + delta;
      const ipStat = analyticsMapGetOrCreate(lt.ips, ip, () => ({ requests: 0, lastAccess: dayAcc.lastTsByIp[ip] || `${dateKey}T00:00:00.000Z` }));
      ipStat.requests += delta;
      if (dayAcc.lastTsByIp[ip] && new Date(dayAcc.lastTsByIp[ip]) > new Date(ipStat.lastAccess)) {
        ipStat.lastAccess = dayAcc.lastTsByIp[ip];
      }
    }

    for (const [docPath, c] of Object.entries(src.files)) {
      const prev = toSafeCount(dst.files[docPath], 'views');
      const delta = Math.max(0, c - prev);
      dst.files[docPath] = Math.max(prev, c);
      const fStat = analyticsMapGetOrCreate(lt.files, docPath, () => ({ views: 0, ips: {}, lastAccess: dayAcc.lastTsByFile[docPath] || `${dateKey}T00:00:00.000Z` }));
      fStat.views += delta;
      const ipSet = dayAcc.ipsByFile[docPath];
      if (ipSet) {
        for (const ip of ipSet) {
          if (!fStat.ips[ip] && Object.keys(fStat.ips).length < MAX_FILE_IPS_TRACKED) {
            fStat.ips[ip] = 1;
          }
        }
      }
      if (dayAcc.lastTsByFile[docPath] && new Date(dayAcc.lastTsByFile[docPath]) > new Date(fStat.lastAccess)) {
        fStat.lastAccess = dayAcc.lastTsByFile[docPath];
      }
    }

    for (const [q, c] of Object.entries(src.searches)) {
      const prev = toSafeCount(dst.searches[q], 'count');
      const delta = Math.max(0, c - prev);
      dst.searches[q] = Math.max(prev, c);
      const sStat = analyticsMapGetOrCreate(lt.searches, q, () => ({ count: 0, lastSearch: dayAcc.lastTsBySearch[q] || `${dateKey}T00:00:00.000Z` }));
      sStat.count += delta;
      if (dayAcc.lastTsBySearch[q] && new Date(dayAcc.lastTsBySearch[q]) > new Date(sStat.lastSearch)) {
        sStat.lastSearch = dayAcc.lastTsBySearch[q];
      }
    }

    for (const [q, c] of Object.entries(src.dictSearches)) {
      const prev = toSafeCount(dst.dictSearches[q], 'count');
      const delta = Math.max(0, c - prev);
      dst.dictSearches[q] = Math.max(prev, c);
      const dsStat = analyticsMapGetOrCreate(lt.dictSearches, q, () => ({ count: 0, lastSearch: dayAcc.lastTsByDictSearch[q] || `${dateKey}T00:00:00.000Z` }));
      dsStat.count += delta;
      if (dayAcc.lastTsByDictSearch[q] && new Date(dayAcc.lastTsByDictSearch[q]) > new Date(dsStat.lastSearch)) {
        dsStat.lastSearch = dayAcc.lastTsByDictSearch[q];
      }
    }

    for (const [key, c] of Object.entries(src.dictLookups)) {
      const prev = toSafeCount(dst.dictLookups[key], 'count');
      const delta = Math.max(0, c - prev);
      dst.dictLookups[key] = Math.max(prev, c);
      const meta = dayAcc.metaByDictLookup[key] || {};
      const dlStat = analyticsMapGetOrCreate(lt.dictLookups, key, () => ({
        headword: meta.headword || '',
        path: meta.path || '',
        count: 0,
        lastLookup: dayAcc.lastTsByDictLookup[key] || `${dateKey}T00:00:00.000Z`
      }));
      dlStat.count += delta;
      if (dayAcc.lastTsByDictLookup[key] && new Date(dayAcc.lastTsByDictLookup[key]) > new Date(dlStat.lastLookup)) {
        dlStat.lastLookup = dayAcc.lastTsByDictLookup[key];
      }
    }
  }

  return validEvents;
}

/**
 * 檢查並歸檔單一原生 jsonl 日誌檔：
 * - 原生 log 只保留 7 天（依檔名日期 YYYY-MM-DD 或 mtime 判定）。
 * - 超過 7 天的原生 log 先確認已冪等聚合進 analyticsStore.daily 簡化數據，隨即刪除原生 .jsonl 檔。
 */
async function pruneLogFileAsync(filePath) {
  try {
    const baseName = path.basename(filePath);
    const stats = await fs.promises.stat(filePath);
    const now = Date.now();

    // 同步衝突副本（.sync-conflict-*）不屬於正式日誌，直接清理以防佔用空間
    if (baseName.includes('.sync-conflict-')) {
      await fs.promises.rm(filePath, { force: true });
      getLogger().info('LogPruner', `Removed sync-conflict file ${baseName} (${(stats.size / 1024).toFixed(1)}KB)`);
      return true;
    }

    let fileEndMs = stats.mtimeMs;
    const dateMatch = baseName.match(/^access-(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (dateMatch) {
      const parsedEnd = new Date(`${dateMatch[1]}T23:59:59.999Z`).getTime();
      if (!Number.isNaN(parsedEnd)) fileEndMs = parsedEnd;
    }

    if (now - fileEndMs <= LOG_PRUNE_AGE_MS) {
      // 7 天內的保留日誌：僅做冪等對帳（補齊上次重啟前未寫入 store 的差額），不刪除原生檔
      await rollupLogFileToStore(filePath);
      return false;
    }

    const retainedEvents = await rollupLogFileToStore(filePath);
    await fs.promises.rm(filePath, { force: true });
    getLogger().info(
      'LogPruner',
      `Archived & deleted expired raw log ${baseName}: freed ${(stats.size / 1024).toFixed(1)}KB (${retainedEvents} analytics events rolled into daily store)`
    );
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    getLogger().error('LogPruner', `Error pruning log file ${filePath}`, err);
    return false;
  }
}

let cleanOldLogsPromise = null;

async function cleanOldLogsJob() {
  if (cleanOldLogsPromise) return cleanOldLogsPromise;
  cleanOldLogsPromise = (async () => {
    try {
      await initializeAnalyticsStore();
      const files = await fs.promises.readdir(LOG_DIR);
      let storeModified = false;
      for (const file of files) {
        if (file.includes('.sync-conflict-')) {
          const filePath = path.join(LOG_DIR, file);
          try {
            await fs.promises.rm(filePath, { force: true });
          } catch (_) {}
          continue;
        }
        if (!file.endsWith('.jsonl')) continue;
        const filePath = path.join(LOG_DIR, file);
        await pruneLogFileAsync(filePath);
        storeModified = true;
      }
      if (storeModified) {
        analyticsCache.clear();
        await saveAnalyticsStore();
      }
    } catch (err) {
      getLogger().error('LogPruner', 'Error scanning log directory', err);
    } finally {
      cleanOldLogsPromise = null;
    }
  })();
  return cleanOldLogsPromise;
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
      const docPath = cleanAnalyticsDocPath(extractAnalyticsPath(entry));
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

  const rawCoveredDates = new Set();

  for (const file of files) {
    if (!file.endsWith('.jsonl') || file.includes('.sync-conflict-')) continue;
    try {
      const filePath = path.join(LOG_DIR, file);
      const dateMatch = file.match(/^access-(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (dateMatch) {
        rawCoveredDates.add(dateMatch[1]);
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

  // 雙層混合查詢（Two-Tier Hybrid Rollup）：
  // 超過 7 天的原生 access-YYYY-MM-DD.jsonl 已被歸檔並刪除，
  // 因此針對不在 rawCoveredDates 內的歷史日期，直接從 analyticsStore.daily 簡化數據合併統計。
  if (!isOneDay && analyticsStore && analyticsStore.daily) {
    const lifetime = analyticsStore.lifetime || {};
    for (const [dateKey, rawBucket] of Object.entries(analyticsStore.daily)) {
      if (rawCoveredDates.has(dateKey)) continue;
      const dayEndTime = new Date(`${dateKey}T23:59:59.999Z`).getTime();
      if (Number.isNaN(dayEndTime) || dayEndTime < cutoffTime) continue;

      const bucket = normalizeDailyBucket(rawBucket);
      const fallbackTs = `${dateKey}T12:00:00.000Z`;
      let tzDateKey = dateKey;
      if (requestedTz && requestedTz !== 'auto') {
        try {
          tzDateKey = formatTimestampInTz(new Date(fallbackTs), requestedTz, 'date') || dateKey;
        } catch (_) {}
      }

      let daily = dailyMap.get(tzDateKey);
      if (!daily) {
        daily = { date: tzDateKey, views: 0, ips: new Set() };
        dailyMap.set(tzDateKey, daily);
      }

      totalViews += bucket.views;
      totalSearches += bucket.searchCount;
      totalDictSearches += bucket.dictSearchCount;
      totalDictLookups += bucket.dictLookupCount;
      daily.views += bucket.views;

      const bucketIps = Object.keys(bucket.ips || {});
      for (const [ip, reqCount] of Object.entries(bucket.ips || {})) {
        globalUniqueIps.add(ip);
        daily.ips.add(ip);
        const ltIp = lifetime.ips && lifetime.ips[ip];
        const ipLastAccess = (ltIp && ltIp.lastAccess) || fallbackTs;
        let ipStat = ipMap.get(ip);
        if (!ipStat) {
          ipStat = { ip, requests: 0, lastAccess: ipLastAccess };
          ipMap.set(ip, ipStat);
        }
        ipStat.requests += reqCount;
        if (new Date(ipLastAccess) > new Date(ipStat.lastAccess)) {
          ipStat.lastAccess = ipLastAccess;
        }
      }

      for (const [docPath, viewCount] of Object.entries(bucket.files || {})) {
        const ltFile = lifetime.files && lifetime.files[docPath];
        const fileLastAccess = (ltFile && ltFile.lastAccess) || fallbackTs;
        let fStat = fileMap.get(docPath);
        if (!fStat) {
          const fileName = docPath.split('/').pop().replace(/\.md$/, '');
          fStat = { path: docPath, fileName, views: 0, ips: new Set(), lastAccess: fileLastAccess };
          fileMap.set(docPath, fStat);
        }
        fStat.views += viewCount;
        if (ltFile && ltFile.ips) {
          const knownIps = Object.keys(ltFile.ips);
          const limit = Math.min(knownIps.length, fStat.views);
          for (let i = 0; i < limit; i++) fStat.ips.add(knownIps[i]);
        }
        if (fStat.ips.size === 0 && fStat.views > 0) {
          fStat.ips.add(bucketIps[0] || '127.0.0.1');
        }
        if (new Date(fileLastAccess) > new Date(fStat.lastAccess)) {
          fStat.lastAccess = fileLastAccess;
        }
      }

      for (const [q, count] of Object.entries(bucket.searches || {})) {
        const ltSearch = lifetime.searches && lifetime.searches[q];
        const lastSearch = (ltSearch && ltSearch.lastSearch) || fallbackTs;
        let sStat = searchMap.get(q);
        if (!sStat) {
          sStat = { query: q, count: 0, lastSearch };
          searchMap.set(q, sStat);
        }
        sStat.count += count;
        if (new Date(lastSearch) > new Date(sStat.lastSearch)) {
          sStat.lastSearch = lastSearch;
        }
      }

      for (const [q, count] of Object.entries(bucket.dictSearches || {})) {
        const ltDs = lifetime.dictSearches && lifetime.dictSearches[q];
        const lastSearch = (ltDs && ltDs.lastSearch) || fallbackTs;
        let sStat = dictSearchMap.get(q);
        if (!sStat) {
          sStat = { query: q, count: 0, lastSearch };
          dictSearchMap.set(q, sStat);
        }
        sStat.count += count;
        if (new Date(lastSearch) > new Date(sStat.lastSearch)) {
          sStat.lastSearch = lastSearch;
        }
      }

      for (const [key, count] of Object.entries(bucket.dictLookups || {})) {
        const ltDl = lifetime.dictLookups && lifetime.dictLookups[key];
        const sepIdx = key.indexOf('::');
        const docPath = (ltDl && ltDl.path) || (sepIdx >= 0 ? key.slice(0, sepIdx) : '');
        const headword = (ltDl && ltDl.headword) || (sepIdx >= 0 ? key.slice(sepIdx + 2) : key);
        const lastLookup = (ltDl && ltDl.lastLookup) || fallbackTs;
        let lStat = dictLookupMap.get(key);
        if (!lStat) {
          lStat = { headword, path: docPath, count: 0, lastLookup };
          dictLookupMap.set(key, lStat);
        }
        lStat.count += count;
        if (new Date(lastLookup) > new Date(lStat.lastLookup)) {
          lStat.lastLookup = lastLookup;
        }
      }
    }
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

  // Session 只接受 cookie 或 X-Admin-Token 標頭，不接受網址參數（會留在瀏覽紀錄與日誌）。
  const authorized = isAuthenticated(req);
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

// Background startup initialization.
//
// Single-user bundles skip this entirely: the aggregate store, the daily jsonl
// logs and the retention timer all exist to describe *visitors*, and a
// single-user install has exactly one. Creating them anyway would leave an
// analytics footprint on disk for a mode that deliberately has none.
//
// Callers that still need the store (nothing does in single-user mode, because
// the analytics endpoints are not routed) can call initializeAnalyticsStore()
// explicitly; it stays exported and idempotent.
if (!IS_SINGLE_USER) {
  initializeAnalyticsStore().then(() => {
    cleanOldLogsJob();
    const cleanLogsTimer = setInterval(cleanOldLogsJob, 24 * 60 * 60 * 1000);
    if (cleanLogsTimer && cleanLogsTimer.unref) cleanLogsTimer.unref();
  }).catch(() => {});
}

module.exports = {
  // 以 getter 匯出：analyticsStore 於模組載入時為 null，稍後才由
  // initializeAnalyticsStore() 賦值。若直接以值匯出，取用端永遠只會拿到 null (D4)。
  get analyticsStore() { return analyticsStore; },
  getLogFilePath,
  appendToPersistentLog,
  getAnalyticsEventId,
  assignAnalyticsEventSeq,
  cleanAnalyticsDocPath,
  normalizeDailyBucket,
  normalizeAnalyticsStore,
  rollupLogFileToStore,
  updateAnalyticsStoreEntry,
  saveAnalyticsStore,
  queueAnalyticsStoreEntry,
  initializeAnalyticsStore,
  cleanOldLogsJob,
  pruneAnalyticsLogEntry,
  buildAggregateAnalyticsData,
  getAnalyticsData,
  parseAnalyticsRange,
  sanitizeCsvField,
  handleAnalyticsExport,
  setInMemoryLogBufferRef
};
