/**
 * @file lib/reports.js — 每日／每週報表信（使用者、流量、關鍵字）
 *
 * - 資料來源：流量與關鍵字讀 logs/access-YYYY-MM-DD.jsonl（保留 7 天的原始日誌，可算到小時），
 *   原始日誌已刪的日子改用 analytics-aggregates.json 的每日摘要（以 UTC 日為單位，報表標示「概估」）。
 *   使用者資訊讀 users.db（users、auth_events、sessions、bookmarks、read_progress）。
 * - 期間以後台設定的時區切日：日報 = 昨天 00:00–24:00，週報 = 到昨天為止的 7 天，各自與前一期比較。
 * - 圖表：lib/report-chart.js 同一份圖畫成 SVG（後台預覽）與 PNG（信件用 cid 內嵌，Gmail 不顯示 SVG）。
 * - 排程：每 5 分鐘檢查一次，到了設定的時間且這一期還沒寄過就寄。寄過的期別記在 app_settings，
 *   重啟不會重寄；寄失敗也不自動重試（避免每 5 分鐘重寄），後台可手動再寄。
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { LOG_DIR, IS_SINGLE_USER } = require('./constants');
const { isBotEntry, extractAnalyticsPath, extractAnalyticsQuery } = require('./utils');
const analytics = require('./analytics');
const db = require('./db');
const mailer = require('./mailer');
const chart = require('./report-chart');
const { config } = require('./config');
const shareStats = require('./share-stats');
const { LAYOUT_NAMES } = require('../share-card.js');

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const SETTINGS_KEY = 'reports.settings';
const HISTORY_KEY = 'reports.history';
const LAST_SENT_KEY = kind => `reports.lastSent.${kind}`;
const HISTORY_MAX = 30;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

const COLORS = {
  views: '#3b6fd8',
  visitors: '#e08a3c',
  compare: '#9aa3b2',
  signups: '#2f9e74',
  logins: '#8a63d2',
  searches: '#c2477a',
  share: '#e0a63c'
};

let logger = null;
function getLogger() {
  if (!logger) {
    try { logger = require('./logger').Logger; } catch (_) { logger = console; }
  }
  return logger;
}

// ── 設定 ─────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  timezone: 'Asia/Taipei',
  recipients: [],             // 空白 = 所有有 Email 的啟用中管理員
  daily: { enabled: true, hour: 8 },
  weekly: { enabled: true, weekday: 1, hour: 8 } // 週一早上寄上週（到週日為止）
};

function isValidTimezone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (_) { return false; }
}

function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function clampInt(v, min, max, fallback) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

/** 合併預設值並修正不合法的欄位；只回傳已知欄位。 */
function normalizeSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const d = s.daily && typeof s.daily === 'object' ? s.daily : {};
  const w = s.weekly && typeof s.weekly === 'object' ? s.weekly : {};
  const recipients = Array.isArray(s.recipients) ? s.recipients : [];
  return {
    timezone: typeof s.timezone === 'string' && isValidTimezone(s.timezone) ? s.timezone : DEFAULT_SETTINGS.timezone,
    recipients: [...new Set(recipients.map(r => String(r || '').trim().toLowerCase()).filter(isValidEmail))].slice(0, 10),
    daily: {
      enabled: d.enabled === undefined ? DEFAULT_SETTINGS.daily.enabled : !!d.enabled,
      hour: clampInt(d.hour, 0, 23, DEFAULT_SETTINGS.daily.hour)
    },
    weekly: {
      enabled: w.enabled === undefined ? DEFAULT_SETTINGS.weekly.enabled : !!w.enabled,
      weekday: clampInt(w.weekday, 0, 6, DEFAULT_SETTINGS.weekly.weekday),
      hour: clampInt(w.hour, 0, 23, DEFAULT_SETTINGS.weekly.hour)
    }
  };
}

function getSettings() {
  if (!db.isAvailable()) return normalizeSettings(null);
  return normalizeSettings(db.getJsonSetting(SETTINGS_KEY, null));
}

function saveSettings(input) {
  const next = normalizeSettings(Object.assign({}, getSettings(), input));
  db.setJsonSetting(SETTINGS_KEY, next);
  return next;
}

function adminEmails() {
  if (!db.isAvailable()) return [];
  return db.getDb().prepare("SELECT email FROM users WHERE role = 'admin' AND status = 'active' AND email IS NOT NULL ORDER BY id")
    .all().map(r => r.email);
}

function resolveRecipients(settings = getSettings()) {
  return settings.recipients.length ? settings.recipients : adminEmails();
}

function getHistory() {
  if (!db.isAvailable()) return [];
  const h = db.getJsonSetting(HISTORY_KEY, []);
  return Array.isArray(h) ? h : [];
}

function pushHistory(entry) {
  const h = getHistory();
  h.unshift(entry);
  db.setJsonSetting(HISTORY_KEY, h.slice(0, HISTORY_MAX));
}

// ── 時區工具 ─────────────────────────────────────────────
const partsFmtCache = new Map();
function tzParts(ms, tz) {
  let fmt = partsFmtCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short'
    });
    partsFmtCache.set(tz, fmt);
  }
  const p = {};
  for (const part of fmt.formatToParts(new Date(ms))) p[part.type] = part.value;
  return {
    y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, min: +p.minute, s: +p.second,
    wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday)
  };
}

function tzOffset(ms, tz) {
  const p = tzParts(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(ms / 1000) * 1000;
}

/** 某時區的 y/m/d 00:00 對應的 UTC 毫秒（處理日光節約時間）。d 可超出月份範圍。 */
function zonedMidnight(y, m, d, tz) {
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - tzOffset(guess, tz);
  const off2 = tzOffset(t, tz);
  if (guess - off2 !== t) t = guess - off2;
  return t;
}

function dateKey(ms, tz) {
  const p = tzParts(ms, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

function shortDate(ms, tz) {
  const p = tzParts(ms, tz);
  return `${p.m}/${p.d}`;
}

/**
 * 算出報表期間。日報：昨天；週報：到昨天為止的 7 天。另附前一期與趨勢圖用的較長期間。
 * @returns {{kind, tz, start, end, prevStart, prevEnd, trendStart, key, label}}
 */
function computePeriod(kind, nowMs, tz) {
  const t = tzParts(nowMs, tz);
  const days = kind === 'weekly' ? 7 : 1;
  const end = zonedMidnight(t.y, t.m, t.d, tz);
  const start = zonedMidnight(t.y, t.m, t.d - days, tz);
  const prevStart = zonedMidnight(t.y, t.m, t.d - days * 2, tz);
  const trendStart = zonedMidnight(t.y, t.m, t.d - (kind === 'weekly' ? 28 : 14), tz);
  const startParts = tzParts(start, tz);
  const lastDay = end - 1;
  const label = kind === 'weekly'
    ? `${dateKey(start, tz)} – ${dateKey(lastDay, tz)}`
    : `${dateKey(start, tz)}（週${WEEKDAYS[startParts.wd]}）`;
  const key = kind === 'weekly' ? `${dateKey(start, tz)}..${dateKey(lastDay, tz)}` : dateKey(start, tz);
  return { kind, tz, start, end, prevStart, prevEnd: start, trendStart, key, label };
}

// ── 流量與關鍵字 ─────────────────────────────────────────
function utcDateKey(ms) { return new Date(ms).toISOString().slice(0, 10); }

function topN(map, n) {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, n);
}

function inc(map, key, by = 1) { map.set(key, (map.get(key) || 0) + by); }

/** 早安圖事件記進圖表格子：打開面板、分享出去、從分享連結進站。 */
function addShareToBucket(bucket, ev, n) {
  if (ev === 'open') bucket.shareOpen += n;
  else if (ev === 'visit') bucket.shareVisit += n;
  else if (shareStats.SEND_EVENTS.has(ev)) bucket.shareSends += n;
}

/**
 * 統計 [start, end) 的流量與搜尋。bucketOf(ms) 回傳該時間所屬的圖表格子（-1 = 不畫）。
 * 原始日誌缺的日子用每日摘要補（只能整天計入，hourly 時不補）。
 */
async function collectTraffic(start, end, { bucketCount = 0, bucketOf = null, hourly = false } = {}) {
  await analytics.initializeAnalyticsStore();
  const out = {
    requests: 0, views: 0, searches: 0, zeroResults: 0, treeFilters: 0, dictSearches: 0, dictLookups: 0,
    approximate: false,
    ips: new Set(),
    files: new Map(), fileIps: new Map(),
    queries: new Map(), zeroQueries: new Map(), dictQueries: new Map(), lookups: new Map(), ipRequests: new Map(),
    share: new Map(),
    buckets: Array.from({ length: bucketCount }, () => ({ views: 0, ips: new Set(), searches: 0, shareOpen: 0, shareSends: 0, shareVisit: 0 }))
  };

  const firstDay = utcDateKey(start);
  const lastDay = utcDateKey(end - 1);
  const covered = new Set();
  let files = [];
  try { files = await fs.promises.readdir(LOG_DIR); } catch (_) {}
  const seen = new Set();

  const take = (entry) => {
    if (!entry) return;
    // 早安圖的 og:image 多半是預覽機器人抓的：算進早安圖，不算請求與訪客（見 lib/share-stats.js）
    const shareServerOnly = shareStats.isShareServerEntry(entry);
    if (!shareServerOnly && isBotEntry(entry)) return;
    const t = new Date(entry.timestamp).getTime();
    if (!(t >= start && t < end)) return;
    if (entry.id) {
      if (seen.has(entry.id)) return;
      seen.add(entry.id);
    }
    if (entry.tag === shareStats.SHARE_TAG) {
      const keys = shareStats.shareKeysOf(entry);
      for (const k of keys) inc(out.share, k);
      const sb = bucketOf && keys.length ? out.buckets[bucketOf(t)] : null;
      if (sb) addShareToBucket(sb, shareStats.shareFieldsOf(entry).ev, 1);
      if (shareServerOnly) return;
    }
    const ip = entry.ip || '127.0.0.1';
    out.requests++;
    out.ips.add(ip);
    inc(out.ipRequests, ip);
    const b = bucketOf ? bucketOf(t) : -1;
    const bucket = b >= 0 && b < out.buckets.length ? out.buckets[b] : null;
    if (bucket) bucket.ips.add(ip);

    if (entry.tag === 'Render') {
      const docPath = analytics.cleanAnalyticsDocPath(extractAnalyticsPath(entry));
      if (docPath) {
        out.views++;
        inc(out.files, docPath);
        let set = out.fileIps.get(docPath);
        if (!set) out.fileIps.set(docPath, set = new Set());
        set.add(ip);
        if (bucket) bucket.views++;
      }
    } else if (entry.tag === 'Search') {
      const q = extractAnalyticsQuery(entry);
      if (!q) return;
      const msg = String(entry.message || '');
      if (msg.startsWith('[tree-filter]')) { out.treeFilters++; return; }
      out.searches++;
      inc(out.queries, q);
      if (bucket) bucket.searches++;
      if (/->\s*0 matches/.test(msg)) { out.zeroResults++; inc(out.zeroQueries, q); }
    } else if (entry.tag === 'DictSearch') {
      const q = extractAnalyticsQuery(entry);
      if (q) { out.dictSearches++; inc(out.dictQueries, q); }
    } else if (entry.tag === 'DictLookup') {
      const headword = extractAnalyticsQuery(entry);
      const docPath = extractAnalyticsPath(entry) || '';
      if (headword || docPath) { out.dictLookups++; inc(out.lookups, `${docPath}::${headword}`); }
    }
  };

  for (const file of files) {
    const m = file.match(/^access-(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (!m || m[1] < firstDay || m[1] > lastDay) continue;
    covered.add(m[1]);
    try {
      const rl = readline.createInterface({ input: fs.createReadStream(path.join(LOG_DIR, file), { encoding: 'utf-8' }), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.trim()) continue;
        try { take(JSON.parse(line)); } catch (_) {}
      }
    } catch (_) {}
  }

  // 原始日誌已刪除的日子：用每日摘要（UTC 日）補，取中午落在期間內的那幾天。
  const store = analytics.analyticsStore;
  if (!hourly && store && store.daily) {
    for (const [day, raw] of Object.entries(store.daily)) {
      if (covered.has(day) || day < firstDay || day > lastDay) continue;
      const mid = new Date(`${day}T12:00:00Z`).getTime();
      if (!(mid >= start && mid < end)) continue;
      const bk = analytics.normalizeDailyBucket(raw);
      out.approximate = true;
      out.views += bk.views;
      out.searches += bk.searchCount;
      out.dictSearches += bk.dictSearchCount;
      out.dictLookups += bk.dictLookupCount;
      const b = bucketOf ? bucketOf(mid) : -1;
      const bucket = b >= 0 && b < out.buckets.length ? out.buckets[b] : null;
      if (bucket) { bucket.views += bk.views; bucket.searches += bk.searchCount; }
      for (const [ip, n] of Object.entries(bk.ips)) {
        out.requests += n;
        out.ips.add(ip);
        inc(out.ipRequests, ip, n);
        if (bucket) bucket.ips.add(ip);
      }
      for (const [p, n] of Object.entries(bk.files)) inc(out.files, p, n);
      for (const [q, n] of Object.entries(bk.searches)) inc(out.queries, q, n);
      for (const [q, n] of Object.entries(bk.dictSearches)) inc(out.dictQueries, q, n);
      for (const [k, n] of Object.entries(bk.dictLookups)) inc(out.lookups, k, n);
      for (const [k, n] of Object.entries(bk.share || {})) {
        inc(out.share, k, n);
        if (bucket && k.startsWith('ev:')) addShareToBucket(bucket, k.slice(3), n);
      }
    }
  }
  return out;
}

function summarizeTraffic(raw) {
  return {
    requests: raw.requests,
    views: raw.views,
    visitors: raw.ips.size,
    docs: raw.files.size,
    searches: raw.searches,
    uniqueQueries: raw.queries.size,
    zeroResults: raw.zeroResults,
    treeFilters: raw.treeFilters,
    dictSearches: raw.dictSearches,
    dictLookups: raw.dictLookups,
    approximate: raw.approximate
  };
}

// ── 使用者 ───────────────────────────────────────────────
function collectUsers(start, end, prevStart, trendStart, tz, trendDays) {
  if (!db.isAvailable()) return null;
  const d = db.getDb();
  const one = (sql, ...a) => d.prepare(sql).get(...a);
  const all = (sql, ...a) => d.prepare(sql).all(...a).map(row => Object.assign({}, row));

  const totals = one(`SELECT COUNT(*) AS total,
      SUM(role = 'admin') AS admins,
      SUM(status = 'disabled') AS disabled,
      SUM(email_verified_at IS NULL AND email IS NOT NULL) AS unverified,
      SUM(password_hash IS NOT NULL) AS withPassword
    FROM users`);
  const providers = all('SELECT provider, COUNT(DISTINCT user_id) AS n FROM user_identities GROUP BY provider ORDER BY n DESC');

  const newUsers = all(`SELECT u.id, u.email, u.username, u.display_name, u.role, u.status, u.created_at,
      u.email_verified_at, u.last_login_at, u.password_hash IS NOT NULL AS has_password,
      (SELECT group_concat(provider, ',') FROM user_identities WHERE user_id = u.id) AS providers
    FROM users u WHERE u.created_at >= ? AND u.created_at < ? ORDER BY u.created_at DESC LIMIT 50`, start, end);
  const newCount = one('SELECT COUNT(*) AS n FROM users WHERE created_at >= ? AND created_at < ?', start, end).n;
  const prevNewCount = one('SELECT COUNT(*) AS n FROM users WHERE created_at >= ? AND created_at < ?', prevStart, start).n;

  const loginRows = all(`SELECT COALESCE(detail, 'password') AS method, COUNT(*) AS n FROM auth_events
    WHERE event = 'login_ok' AND at >= ? AND at < ? GROUP BY method ORDER BY n DESC`, start, end);
  const logins = loginRows.reduce((s, r) => s + r.n, 0);
  const loginUsers = one("SELECT COUNT(DISTINCT user_id) AS n FROM auth_events WHERE event = 'login_ok' AND at >= ? AND at < ?", start, end).n;
  const prevLoginUsers = one("SELECT COUNT(DISTINCT user_id) AS n FROM auth_events WHERE event = 'login_ok' AND at >= ? AND at < ?", prevStart, start).n;

  const activeUsers = one(`SELECT COUNT(*) AS n FROM (
      SELECT user_id FROM sessions WHERE last_seen_at >= ? AND last_seen_at < ?
      UNION SELECT user_id FROM auth_events WHERE event = 'login_ok' AND at >= ? AND at < ? AND user_id IS NOT NULL
      UNION SELECT user_id FROM bookmarks WHERE updated_at >= ? AND updated_at < ?
      UNION SELECT user_id FROM read_progress WHERE updated_at >= ? AND updated_at < ?)`,
  start, end, start, end, start, end, start, end).n;

  const sync = one(`SELECT
      (SELECT COUNT(*) FROM bookmarks WHERE updated_at >= ? AND updated_at < ? AND deleted_at IS NULL) AS bookmarksAdded,
      (SELECT COUNT(*) FROM bookmarks WHERE deleted_at >= ? AND deleted_at < ?) AS bookmarksRemoved,
      (SELECT COUNT(*) FROM read_progress WHERE updated_at >= ? AND updated_at < ? AND deleted_at IS NULL) AS docsRead,
      (SELECT COUNT(DISTINCT user_id) FROM read_progress WHERE updated_at >= ? AND updated_at < ?) AS readers`,
  start, end, start, end, start, end, start, end);

  const topReaders = all(`SELECT u.id, u.email, u.username, u.display_name, COUNT(*) AS docs, MAX(rp.updated_at) AS last_at,
      (SELECT COUNT(*) FROM bookmarks b WHERE b.user_id = u.id AND b.deleted_at IS NULL) AS bookmarks
    FROM read_progress rp JOIN users u ON u.id = rp.user_id
    WHERE rp.updated_at >= ? AND rp.updated_at < ? AND rp.deleted_at IS NULL
    GROUP BY u.id ORDER BY docs DESC, last_at DESC LIMIT 10`, start, end);

  const eventRows = all('SELECT event, COUNT(*) AS n FROM auth_events WHERE at >= ? AND at < ? GROUP BY event', start, end);
  const ev = Object.fromEntries(eventRows.map(r => [r.event, r.n]));
  const sumPrefix = p => eventRows.filter(r => r.event.startsWith(p)).reduce((s, r) => s + r.n, 0);
  const security = {
    loginFail: ev.login_fail || 0,
    loginBlocked: ev.login_blocked || 0,
    botBlocked: sumPrefix('bot_'),
    resetRequests: ev.password_reset_request || 0,
    passwordResets: ev.password_reset || 0,
    emailVerified: ev.email_verify || 0,
    accountDeleted: ev.account_delete || 0,
    adminActions: sumPrefix('admin_'),
    mailFailed: ev.mail_failed || 0
  };

  // 趨勢：每天的新註冊與登入人數
  const trend = [];
  const tp = tzParts(trendStart, tz);
  for (let i = 0; i < trendDays; i++) {
    const s = zonedMidnight(tp.y, tp.m, tp.d + i, tz);
    const e = zonedMidnight(tp.y, tp.m, tp.d + i + 1, tz);
    trend.push({
      label: shortDate(s, tz),
      signups: one('SELECT COUNT(*) AS n FROM users WHERE created_at >= ? AND created_at < ?', s, e).n,
      logins: one("SELECT COUNT(DISTINCT user_id) AS n FROM auth_events WHERE event = 'login_ok' AND at >= ? AND at < ?", s, e).n
    });
  }

  return {
    totals: {
      total: totals.total || 0, admins: totals.admins || 0, disabled: totals.disabled || 0,
      unverified: totals.unverified || 0, withPassword: totals.withPassword || 0
    },
    providers,
    newCount, prevNewCount,
    newUsers: newUsers.map(u => Object.assign({}, u, { has_password: !!u.has_password })),
    logins, loginUsers, prevLoginUsers, loginMethods: loginRows,
    activeUsers,
    sync,
    topReaders,
    security,
    trend
  };
}

// ── 組合報表資料 ─────────────────────────────────────────
async function buildReport(kind, { now = Date.now(), settings = getSettings() } = {}) {
  const tz = settings.timezone;
  const p = computePeriod(kind, now, tz);
  const weekly = kind === 'weekly';

  // 本期：日報按小時、週報按天分格
  let labels, bucketOf;
  if (weekly) {
    const sp = tzParts(p.start, tz);
    const edges = Array.from({ length: 8 }, (_, i) => zonedMidnight(sp.y, sp.m, sp.d + i, tz));
    labels = edges.slice(0, 7).map(ms => shortDate(ms, tz));
    bucketOf = t => { for (let i = 0; i < 7; i++) if (t >= edges[i] && t < edges[i + 1]) return i; return -1; };
  } else {
    labels = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
    bucketOf = t => tzParts(t, tz).h;
  }
  const cur = await collectTraffic(p.start, p.end, { bucketCount: labels.length, bucketOf, hourly: !weekly });

  let prevBucketOf;
  if (weekly) {
    const pp = tzParts(p.prevStart, tz);
    const edges = Array.from({ length: 8 }, (_, i) => zonedMidnight(pp.y, pp.m, pp.d + i, tz));
    prevBucketOf = t => { for (let i = 0; i < 7; i++) if (t >= edges[i] && t < edges[i + 1]) return i; return -1; };
  } else {
    prevBucketOf = t => tzParts(t, tz).h;
  }
  const prev = await collectTraffic(p.prevStart, p.prevEnd, { bucketCount: labels.length, bucketOf: prevBucketOf, hourly: false });

  // 長期趨勢（日報 14 天、週報 28 天），按天
  const trendDays = weekly ? 28 : 14;
  const tp = tzParts(p.trendStart, tz);
  const trendEdges = Array.from({ length: trendDays + 1 }, (_, i) => zonedMidnight(tp.y, tp.m, tp.d + i, tz));
  const trendRaw = await collectTraffic(p.trendStart, p.end, {
    bucketCount: trendDays,
    bucketOf: t => {
      let lo = 0, hi = trendDays - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (t < trendEdges[mid]) hi = mid - 1;
        else if (t >= trendEdges[mid + 1]) lo = mid + 1;
        else return mid;
      }
      return -1;
    }
  });

  const prevQueries = prev.queries;
  const topQueries = topN(cur.queries, 15).map(([q, n]) => ({ q, n, prev: prevQueries.get(q) || 0, isNew: !prevQueries.has(q) }));
  const risingQueries = [...cur.queries.entries()]
    .map(([q, n]) => ({ q, n, prev: prevQueries.get(q) || 0 }))
    .filter(r => r.n >= 2 && r.n > r.prev * 1.5)
    .sort((a, b) => (b.n - b.prev) - (a.n - a.prev))
    .slice(0, 8);

  return {
    kind,
    siteName: (config.settings && config.settings.siteName) || 'mdWebview',
    generatedAt: now,
    period: p,
    traffic: {
      cur: summarizeTraffic(cur),
      prev: summarizeTraffic(prev),
      labels,
      buckets: cur.buckets.map(b => ({ views: b.views, visitors: b.ips.size, searches: b.searches })),
      prevBuckets: prev.buckets.map(b => ({ views: b.views, visitors: b.ips.size, searches: b.searches })),
      trend: trendRaw.buckets.map((b, i) => ({ label: shortDate(trendEdges[i], tz), views: b.views, visitors: b.ips.size, searches: b.searches })),
      topDocs: topN(cur.files, 10).map(([p2, n]) => ({
        path: p2, name: p2.split('/').pop().replace(/\.md$/i, ''), views: n,
        visitors: cur.fileIps.get(p2) ? cur.fileIps.get(p2).size : null,
        prev: prev.files.get(p2) || 0
      })),
      topIps: topN(cur.ipRequests, 5).map(([ip, n]) => ({ ip, n }))
    },
    keywords: {
      top: topQueries,
      rising: risingQueries,
      zero: topN(cur.zeroQueries, 10).map(([q, n]) => ({ q, n })),
      dict: topN(cur.dictQueries, 10).map(([q, n]) => ({ q, n })),
      lookups: topN(cur.lookups, 10).map(([k, n]) => {
        const i = k.indexOf('::');
        const dictPath = i >= 0 ? k.slice(0, i) : '';
        return { headword: i >= 0 ? k.slice(i + 2) : k, dict: dictPath.replace(/^dict:/, '').split('/').pop().replace(/\.md$/i, ''), n };
      })
    },
    shareCard: {
      cur: await shareStats.withVerseTexts(shareStats.summarizeShareMap(cur.share, { top: 5 })),
      prev: shareStats.summarizeShareMap(prev.share, { top: 5 }),
      // 日報 = 24 小時，週報 = 7 天（與 traffic.labels 對齊）
      buckets: cur.buckets.map(b => ({ open: b.shareOpen, sends: b.shareSends, visit: b.shareVisit }))
    },
    users: collectUsers(p.start, p.end, p.prevStart, p.trendStart, tz, trendDays)
  };
}

// ── 圖表 ─────────────────────────────────────────────────
function buildCharts(r) {
  const weekly = r.kind === 'weekly';
  const charts = [];
  charts.push({
    id: 'traffic',
    title: weekly ? '每日閱讀與訪客（虛線為上週同日閱讀）' : '每小時閱讀與訪客（虛線為前一天同時段閱讀）',
    legend: [['閱讀次數', COLORS.views], ['獨立訪客', COLORS.visitors], [weekly ? '上週閱讀' : '前一天閱讀', COLORS.compare]],
    scene: chart.timeChart({
      labels: r.traffic.labels,
      series: [
        { type: weekly ? 'line' : 'bar', area: weekly, color: COLORS.views, values: r.traffic.buckets.map(b => b.views) },
        { type: 'line', dashed: true, color: COLORS.compare, values: r.traffic.prevBuckets.map(b => b.views) },
        { type: 'line', color: COLORS.visitors, values: r.traffic.buckets.map(b => b.visitors) }
      ]
    })
  });
  charts.push({
    id: 'trend',
    title: `近 ${r.traffic.trend.length} 天趨勢`,
    legend: [['閱讀次數', COLORS.views], ['獨立訪客', COLORS.visitors], ['搜尋次數', COLORS.searches]],
    scene: chart.timeChart({
      labels: r.traffic.trend.map(t => t.label),
      height: 190,
      series: [
        { type: 'line', area: true, color: COLORS.views, values: r.traffic.trend.map(t => t.views) },
        { type: 'line', color: COLORS.visitors, values: r.traffic.trend.map(t => t.visitors) },
        { type: 'line', color: COLORS.searches, values: r.traffic.trend.map(t => t.searches) }
      ]
    })
  });
  // 有早安圖資料才畫（沒畫的圖不附加到信件）
  if (r.shareCard && r.shareCard.buckets && r.shareCard.buckets.some(x => x.open || x.sends || x.visit)) {
    const b = r.shareCard.buckets;
    charts.push(weekly ? {
      id: 'share',
      title: '早安圖：每日打開面板、分享出去與從分享連結進站',
      legend: [['打開分享面板', COLORS.compare], ['分享出去', COLORS.share], ['從分享連結進站', COLORS.signups]],
      scene: chart.timeChart({
        labels: r.traffic.labels,
        height: 180,
        series: [
          { type: 'line', dashed: true, color: COLORS.compare, values: b.map(x => x.open) },
          { type: 'line', area: true, color: COLORS.share, values: b.map(x => x.sends) },
          { type: 'line', color: COLORS.signups, values: b.map(x => x.visit) }
        ]
      })
    } : {
      id: 'share',
      title: '早安圖：幾點打開面板與分享出去',
      legend: [['打開分享面板', COLORS.compare], ['分享出去', COLORS.share]],
      scene: chart.timeChart({
        labels: r.traffic.labels,
        height: 170,
        series: [
          { type: 'bar', color: COLORS.compare, values: b.map(x => x.open) },
          { type: 'bar', color: COLORS.share, values: b.map(x => x.sends) }
        ]
      })
    });
  }
  if (r.users) {
    charts.push({
      id: 'users',
      title: `近 ${r.users.trend.length} 天新註冊與登入人數`,
      legend: [['新註冊', COLORS.signups], ['登入人數', COLORS.logins]],
      scene: chart.timeChart({
        labels: r.users.trend.map(t => t.label),
        height: 170,
        series: [
          { type: 'bar', color: COLORS.signups, values: r.users.trend.map(t => t.signups) },
          { type: 'line', color: COLORS.logins, values: r.users.trend.map(t => t.logins) }
        ]
      })
    });
  }
  return charts;
}

// ── 信件 HTML ────────────────────────────────────────────
function esc(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function num(n) { return (Number(n) || 0).toLocaleString('en-US'); }

function delta(cur, prev) {
  if (!prev && !cur) return { text: '持平', color: '#8a919c' };
  if (!prev) return { text: '新', color: '#2f9e74' };
  const pct = Math.round(((cur - prev) / prev) * 100);
  if (pct === 0) return { text: '持平', color: '#8a919c' };
  return pct > 0 ? { text: `▲ ${pct}%`, color: '#2f9e74' } : { text: `▼ ${Math.abs(pct)}%`, color: '#c0392b' };
}

function fmtTime(ms, tz) {
  if (!ms) return '—';
  const p = tzParts(ms, tz);
  return `${p.m}/${p.d} ${String(p.h).padStart(2, '0')}:${String(p.min).padStart(2, '0')}`;
}

const PROVIDER_NAMES = { google: 'Google', facebook: 'Facebook', apple: 'Apple' };
function loginMethodName(m) {
  if (m === 'password') return '密碼';
  if (m.startsWith('email_link')) return 'Email 連結';
  return PROVIDER_NAMES[m] || m;
}

const S = {
  section: 'margin:28px 0 0;padding:0',
  h2: 'font-size:17px;margin:0 0 12px;color:#1f2430;border-left:4px solid #3b6fd8;padding-left:10px',
  h3: 'font-size:14px;margin:18px 0 8px;color:#4a5160',
  table: 'width:100%;border-collapse:collapse;font-size:13px',
  th: 'text-align:left;padding:6px 8px;border-bottom:1px solid #e3e6eb;color:#8a919c;font-weight:600;font-size:12px',
  td: 'padding:6px 8px;border-bottom:1px solid #f0f2f5;color:#2b303b;vertical-align:top',
  num: 'text-align:right;white-space:nowrap',
  muted: 'color:#8a919c;font-size:12px'
};

function kpiTiles(tiles) {
  const cells = tiles.map(t => {
    const d = t.prev === undefined ? null : delta(t.value, t.prev);
    return `<td style="width:${Math.floor(100 / tiles.length)}%;padding:4px">
      <div style="background:#f6f7f9;border-radius:8px;padding:12px 10px;text-align:center">
        <div style="font-size:12px;color:#6b7280">${esc(t.label)}</div>
        <div style="font-size:22px;font-weight:700;color:#1f2430;margin-top:2px">${num(t.value)}</div>
        ${d ? `<div style="font-size:12px;color:${d.color};margin-top:2px">${esc(d.text)}<span style="color:#9aa3b2">（前期 ${num(t.prev)}）</span></div>` : (t.note ? `<div style="font-size:12px;color:#9aa3b2;margin-top:2px">${esc(t.note)}</div>` : '')}
      </div></td>`;
  }).join('');
  return `<table role="presentation" style="width:100%;border-collapse:collapse;table-layout:fixed"><tr>${cells}</tr></table>`;
}

/** 橫向長條：用表格與背景色畫，所有信箱都看得到（中文標籤不放進圖片）。 */
function barRows(rows, { color = '#3b6fd8', label = r => r.label, value = r => r.n, extra = null, extraHead = '' } = {}) {
  if (!rows.length) return `<p style="${S.muted}">這段期間沒有資料。</p>`;
  const max = Math.max(...rows.map(value), 1);
  return `<table role="presentation" style="${S.table}">
    ${extraHead ? `<tr><th style="${S.th};width:28px">#</th><th style="${S.th}">名稱</th><th style="${S.th}"></th><th style="${S.th};${S.num}">次數</th>${extraHead}</tr>` : ''}
    ${rows.map((r, i) => {
    const pct = Math.max(2, Math.round((value(r) / max) * 100));
    return `<tr>
      <td style="${S.td};width:28px;color:#9aa3b2">${i + 1}</td>
      <td style="${S.td};word-break:break-all">${label(r)}</td>
      <td style="${S.td};width:34%"><table role="presentation" style="width:100%;border-collapse:collapse"><tr>
        <td style="width:${pct}%;background:${color};height:10px;border-radius:5px;font-size:0;line-height:0">&nbsp;</td>
        <td style="font-size:0;line-height:0">&nbsp;</td></tr></table></td>
      <td style="${S.td};${S.num};font-weight:600">${num(value(r))}</td>
      ${extra ? extra(r) : ''}
    </tr>`;
  }).join('')}
  </table>`;
}

function chartBlock(c, src) {
  return `<div style="margin:12px 0 4px">
    <div style="font-size:13px;color:#4a5160;margin:0 0 6px">${esc(c.title)}</div>
    <img src="${src}" width="${c.scene.width}" alt="${esc(c.title)}" style="display:block;width:100%;max-width:${c.scene.width}px;height:auto;border:1px solid #eceef2;border-radius:8px">
    <div style="font-size:12px;color:#6b7280;margin-top:6px">${c.legend.map(([name, color]) => `<span style="display:inline-block;margin-right:14px"><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${color};vertical-align:middle;margin-right:4px"></span>${esc(name)}</span>`).join('')}</div>
  </div>`;
}

function userName(u) {
  const main = u.display_name || u.email || u.username || `#${u.id}`;
  const sub = u.display_name && u.email ? `<div style="${S.muted}">${esc(u.email)}</div>` : '';
  return `${esc(main)}${sub}`;
}

/**
 * 產生信件。imageSrc(chart) 決定圖片網址：寄信用 cid:、預覽用 SVG data URI。
 * @returns {{subject:string, html:string, text:string, charts:Array}}
 */
function renderReport(r, { imageSrc, adminUrl = '' } = {}) {
  const tz = r.period.tz;
  const weekly = r.kind === 'weekly';
  const name = weekly ? '每週報表' : '每日報表';
  const prevName = weekly ? '上週' : '前一天';
  const t = r.traffic;
  const charts = buildCharts(r);
  const chartById = Object.fromEntries(charts.map(c => [c.id, c]));
  const subject = `【${r.siteName}】${name} ${weekly ? `${shortDate(r.period.start, tz)}–${shortDate(r.period.end - 1, tz)}` : shortDate(r.period.start, tz)}｜閱讀 ${num(t.cur.views)}・訪客 ${num(t.cur.visitors)}${r.users ? `・新註冊 ${num(r.users.newCount)}` : ''}`;

  const parts = [];
  parts.push(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#eef0f3">
<div style="max-width:640px;margin:0 auto;padding:20px 12px;font-family:-apple-system,'Segoe UI',Roboto,'Noto Sans TC','PingFang TC','Microsoft JhengHei',sans-serif;line-height:1.6;color:#2b303b">
<div style="background:#ffffff;border-radius:12px;padding:24px 20px">
<div style="font-size:12px;color:#8a919c">${esc(r.siteName)}</div>
<h1 style="font-size:22px;margin:2px 0 4px;color:#1f2430">${esc(name)}</h1>
<div style="font-size:13px;color:#6b7280">${esc(r.period.label)}・時區 ${esc(tz)}・與${prevName}比較</div>`);

  // 總覽
  parts.push(`<div style="${S.section}">${kpiTiles([
    { label: '閱讀次數', value: t.cur.views, prev: t.prev.views },
    { label: '獨立訪客', value: t.cur.visitors, prev: t.prev.visitors },
    { label: '全文搜尋', value: t.cur.searches, prev: t.prev.searches },
    r.users ? { label: '新註冊', value: r.users.newCount, prev: r.users.prevNewCount } : { label: '被閱讀文章', value: t.cur.docs, prev: t.prev.docs }
  ])}</div>`);

  // 流量
  parts.push(`<div style="${S.section}"><h2 style="${S.h2}">📈 流量</h2>`);
  parts.push(kpiTiles([
    { label: '請求數', value: t.cur.requests, prev: t.prev.requests },
    { label: '被閱讀文章', value: t.cur.docs, prev: t.prev.docs },
    { label: '辭典搜尋', value: t.cur.dictSearches, prev: t.prev.dictSearches },
    { label: '辭典查閱', value: t.cur.dictLookups, prev: t.prev.dictLookups }
  ]));
  parts.push(chartBlock(chartById.traffic, imageSrc(chartById.traffic)));
  parts.push(chartBlock(chartById.trend, imageSrc(chartById.trend)));
  if (t.cur.approximate || t.prev.approximate) {
    parts.push(`<p style="${S.muted}">部分日期的原始日誌已超過 7 天保留期，改用每日摘要（以 UTC 日計），數字為概估。</p>`);
  }
  parts.push(`<h3 style="${S.h3}">熱門文章 Top 10</h3>`);
  parts.push(barRows(t.topDocs, {
    label: d => `${esc(d.name)}<div style="${S.muted}">${esc(d.path)}</div>`,
    value: d => d.views,
    extraHead: `<th style="${S.th};${S.num}">訪客</th><th style="${S.th};${S.num}">${prevName}</th>`,
    extra: d => `<td style="${S.td};${S.num}">${d.visitors === null ? '—' : num(d.visitors)}</td><td style="${S.td};${S.num};color:#8a919c">${num(d.prev)}</td>`
  }));
  if (t.topIps.length) {
    parts.push(`<h3 style="${S.h3}">請求最多的 IP</h3>`);
    parts.push(barRows(t.topIps, { color: '#9aa3b2', label: x => `<code style="font-size:12px">${esc(x.ip)}</code>`, value: x => x.n }));
  }
  parts.push('</div>');

  // 關鍵字
  const k = r.keywords;
  parts.push(`<div style="${S.section}"><h2 style="${S.h2}">🔍 關鍵字</h2>`);
  parts.push(kpiTiles([
    { label: '全文搜尋', value: t.cur.searches, prev: t.prev.searches },
    { label: '不同關鍵字', value: t.cur.uniqueQueries, prev: t.prev.uniqueQueries },
    { label: '查無結果', value: t.cur.zeroResults, prev: t.prev.zeroResults },
    { label: '檔名篩選', value: t.cur.treeFilters, prev: t.prev.treeFilters }
  ]));
  parts.push(`<h3 style="${S.h3}">熱門搜尋 Top 15</h3>`);
  parts.push(barRows(k.top, {
    color: COLORS.searches,
    label: x => `${esc(x.q)}${x.isNew ? ' <span style="font-size:11px;color:#2f9e74;border:1px solid #2f9e74;border-radius:4px;padding:0 4px">新</span>' : ''}`,
    value: x => x.n,
    extraHead: `<th style="${S.th};${S.num}">${prevName}</th>`,
    extra: x => `<td style="${S.td};${S.num};color:#8a919c">${num(x.prev)}</td>`
  }));
  if (k.rising.length) {
    parts.push(`<h3 style="${S.h3}">上升最多</h3><p style="margin:0;font-size:13px">${k.rising.map(x => `<span style="display:inline-block;background:#eef7f2;color:#1f6f50;border-radius:12px;padding:2px 10px;margin:0 6px 6px 0">${esc(x.q)} ${num(x.prev)}→${num(x.n)}</span>`).join('')}</p>`);
  }
  parts.push(`<h3 style="${S.h3}">查無結果的搜尋（可考慮補內容或同義詞）</h3>`);
  parts.push(barRows(k.zero, { color: '#c0392b', label: x => esc(x.q), value: x => x.n }));
  parts.push(`<h3 style="${S.h3}">辭典搜尋 Top 10</h3>`);
  parts.push(barRows(k.dict, { color: '#7a8bd1', label: x => esc(x.q), value: x => x.n }));
  parts.push(`<h3 style="${S.h3}">辭典查閱詞條 Top 10</h3>`);
  parts.push(barRows(k.lookups, { color: '#7a8bd1', label: x => `${esc(x.headword || '—')}${x.dict ? `<div style="${S.muted}">${esc(x.dict)}</div>` : ''}`, value: x => x.n }));
  parts.push('</div>');

  // 早安圖
  const sc = r.shareCard;
  if (sc) {
    const c = sc.cur;
    const pv = sc.prev;
    parts.push(`<div style="${S.section}"><h2 style="${S.h2}">🌅 早安圖</h2>`);
    parts.push(kpiTiles([
      { label: '打開分享面板', value: c.events.open, prev: pv.events.open },
      { label: '分享出去', value: c.sends, prev: pv.sends },
      { label: '從分享連結進站', value: c.events.visit, prev: pv.events.visit },
      { label: '連結預覽抓圖', value: c.events.og, prev: pv.events.og }
    ]));
    if (chartById.share) parts.push(chartBlock(chartById.share, imageSrc(chartById.share)));
    const used = c.actions.filter(a => a.count > 0 && a.ev !== 'open' && a.ev !== 'visit' && a.ev !== 'og');
    if (!used.length && !c.events.open && !c.events.visit && !c.events.og) {
      parts.push(`<p style="${S.muted}">這段期間沒有人使用早安圖。</p>`);
    } else {
      if (used.length) {
        parts.push(`<h3 style="${S.h3}">分享方式與其他動作</h3>`);
        parts.push(barRows(used, {
          color: '#e0a63c',
          label: a => `${esc(a.label)}${a.ev === 'error' && c.errors.length ? `<div style="${S.muted}">${esc(c.errors.map(e => `${e.label} ${num(e.count)}`).join('、'))}</div>` : ''}`,
          value: a => a.count
        }));
      }
      if (c.layouts.length) {
        parts.push(`<h3 style="${S.h3}">版型（分享出去的）</h3>`);
        parts.push(barRows(c.layouts, { color: '#e0a63c', label: l => `${esc(l.layout)} ${esc(LAYOUT_NAMES[l.layout] || '')}`, value: l => l.count }));
      }
      if (c.verses.length) {
        parts.push(`<h3 style="${S.h3}">最常分享的經句 Top 5</h3>`);
        parts.push(barRows(c.verses, {
          color: '#e0a63c',
          label: v => v.text ? `${esc(v.text)}${v.source ? `<div style="${S.muted}">${esc(v.source)}</div>` : ''}` : `<span style="${S.muted}">（已不在經句清單）${esc(v.id)}</span>`,
          value: v => v.count
        }));
      }
      if (c.pics.length) {
        parts.push(`<h3 style="${S.h3}">最常被分享的背景圖 Top 5</h3>`);
        parts.push(barRows(c.pics, { color: '#e0a63c', label: x => esc(x.pic), value: x => x.count }));
      }
    }
    parts.push('</div>');
  }

  // 使用者
  const u = r.users;
  parts.push(`<div style="${S.section}"><h2 style="${S.h2}">👥 使用者</h2>`);
  if (!u) {
    parts.push(`<p style="${S.muted}">帳號資料庫無法使用，沒有使用者資料。</p>`);
  } else {
    parts.push(kpiTiles([
      { label: '會員總數', value: u.totals.total, note: `管理員 ${u.totals.admins}` },
      { label: '新註冊', value: u.newCount, prev: u.prevNewCount },
      { label: '登入人數', value: u.loginUsers, prev: u.prevLoginUsers },
      { label: '活躍會員', value: u.activeUsers, note: '登入、使用或同步' }
    ]));
    parts.push(chartBlock(chartById.users, imageSrc(chartById.users)));

    const facts = [
      ['登入次數', `${num(u.logins)}${u.loginMethods.length ? `（${u.loginMethods.map(m => `${loginMethodName(m.method)} ${num(m.n)}`).join('、')}）` : ''}`],
      ['帳號狀態', `未驗證 Email ${num(u.totals.unverified)}・停用 ${num(u.totals.disabled)}・有密碼 ${num(u.totals.withPassword)}`],
      ['第三方綁定', u.providers.length ? u.providers.map(p => `${PROVIDER_NAMES[p.provider] || p.provider} ${num(p.n)}`).join('、') : '無'],
      ['閱讀同步', `${num(u.sync.readers)} 人讀了 ${num(u.sync.docsRead)} 篇・新增書籤 ${num(u.sync.bookmarksAdded)}・移除 ${num(u.sync.bookmarksRemoved)}`],
      ['安全', `登入失敗 ${num(u.security.loginFail)}・擋下機器人 ${num(u.security.botBlocked)}・停用帳號嘗試登入 ${num(u.security.loginBlocked)}・寄信失敗 ${num(u.security.mailFailed)}`],
      ['帳號異動', `Email 驗證 ${num(u.security.emailVerified)}・申請重設密碼 ${num(u.security.resetRequests)}・完成重設 ${num(u.security.passwordResets)}・刪除帳號 ${num(u.security.accountDeleted)}・管理操作 ${num(u.security.adminActions)}`]
    ];
    parts.push(`<table role="presentation" style="${S.table};margin-top:8px">${facts.map(([a, b]) => `<tr><td style="${S.td};width:88px;color:#6b7280;white-space:nowrap">${esc(a)}</td><td style="${S.td}">${esc(b)}</td></tr>`).join('')}</table>`);

    parts.push(`<h3 style="${S.h3}">新註冊會員（${num(u.newCount)}）</h3>`);
    if (!u.newUsers.length) {
      parts.push(`<p style="${S.muted}">這段期間沒有新會員。</p>`);
    } else {
      parts.push(`<table role="presentation" style="${S.table}"><tr><th style="${S.th}">會員</th><th style="${S.th}">註冊方式</th><th style="${S.th}">Email 驗證</th><th style="${S.th}">註冊時間</th></tr>
        ${u.newUsers.map(x => `<tr>
          <td style="${S.td};word-break:break-all">${userName(x)}${x.status === 'disabled' ? ' <span style="color:#c0392b;font-size:11px">停用</span>' : ''}${x.role === 'admin' ? ' <span style="color:#3b6fd8;font-size:11px">管理員</span>' : ''}</td>
          <td style="${S.td}">${esc([x.has_password ? '密碼' : '', ...(x.providers ? x.providers.split(',').map(p => PROVIDER_NAMES[p] || p) : [])].filter(Boolean).join('、') || '—')}</td>
          <td style="${S.td}">${x.email_verified_at ? '✓' : (x.email ? '<span style="color:#c0392b">未驗證</span>' : '—')}</td>
          <td style="${S.td};white-space:nowrap">${esc(fmtTime(x.created_at, tz))}</td></tr>`).join('')}
        ${u.newCount > u.newUsers.length ? `<tr><td colspan="4" style="${S.td};${S.muted}">另有 ${num(u.newCount - u.newUsers.length)} 位，請到後台「使用者」查看</td></tr>` : ''}
      </table>`);
    }

    parts.push(`<h3 style="${S.h3}">最常閱讀的會員 Top 10</h3>`);
    if (!u.topReaders.length) {
      parts.push(`<p style="${S.muted}">這段期間沒有會員同步閱讀紀錄。</p>`);
    } else {
      parts.push(barRows(u.topReaders, {
        color: COLORS.logins,
        label: x => userName(x),
        value: x => x.docs,
        extraHead: `<th style="${S.th};${S.num}">書籤</th><th style="${S.th};${S.num}">最後閱讀</th>`,
        extra: x => `<td style="${S.td};${S.num}">${num(x.bookmarks)}</td><td style="${S.td};${S.num};color:#8a919c">${esc(fmtTime(x.last_at, tz))}</td>`
      }));
    }
  }
  parts.push('</div>');

  parts.push(`<p style="font-size:12px;color:#9aa3b2;margin:28px 0 0;border-top:1px solid #eceef2;padding-top:12px">
    已過濾爬蟲。獨立訪客以 IP 計算。${adminUrl ? `<a href="${esc(adminUrl)}" style="color:#3b6fd8">到後台調整報表設定</a>` : '報表設定在後台「📬 報表」分頁。'}<br>
    產生時間 ${esc(fmtTime(r.generatedAt, tz))}（${esc(tz)}）</p>
</div></div></body></html>`);

  // 純文字版
  const lines = [
    `${r.siteName} ${name}`, `${r.period.label}（${tz}）`, '',
    `閱讀 ${num(t.cur.views)}（${prevName} ${num(t.prev.views)}）`,
    `獨立訪客 ${num(t.cur.visitors)}（${prevName} ${num(t.prev.visitors)}）`,
    `全文搜尋 ${num(t.cur.searches)}，查無結果 ${num(t.cur.zeroResults)}`,
    ''
  ];
  if (u) lines.push(`會員總數 ${num(u.totals.total)}，新註冊 ${num(u.newCount)}，登入人數 ${num(u.loginUsers)}，活躍會員 ${num(u.activeUsers)}`, '');
  lines.push('熱門文章：', ...t.topDocs.map((d, i) => `${i + 1}. ${d.name}（${num(d.views)}）`), '');
  lines.push('熱門搜尋：', ...k.top.map((x, i) => `${i + 1}. ${x.q}（${num(x.n)}）`), '');
  if (k.zero.length) lines.push('查無結果：', ...k.zero.map(x => `- ${x.q}（${num(x.n)}）`), '');
  if (sc) lines.push(`早安圖：打開面板 ${num(sc.cur.events.open)}，分享出去 ${num(sc.cur.sends)}，從分享連結進站 ${num(sc.cur.events.visit)}，連結預覽抓圖 ${num(sc.cur.events.og)}，失敗 ${num(sc.cur.events.error)}`, '');
  if (u && u.newUsers.length) lines.push('新會員：', ...u.newUsers.map(x => `- ${x.display_name || x.email || x.username}（${fmtTime(x.created_at, tz)}）`), '');
  lines.push('完整圖表請用支援 HTML 的信箱查看。');

  return { subject, html: parts.join('\n'), text: lines.join('\n'), charts };
}

function publicBaseUrl() {
  const raw = (process.env.PUBLIC_BASE_URL || '').trim() || ((config.settings && config.settings.siteUrl) || '').trim();
  return /^https?:\/\//i.test(raw) ? raw.replace(/\/+$/, '') : '';
}

/** 後台預覽：圖片用 SVG data URI。 */
async function renderPreview(kind, opts = {}) {
  const r = await buildReport(kind, opts);
  const out = renderReport(r, {
    imageSrc: c => `data:image/svg+xml;base64,${Buffer.from(chart.toSvg(c.scene)).toString('base64')}`,
    adminUrl: publicBaseUrl() ? `${publicBaseUrl()}/` : ''
  });
  return { subject: out.subject, html: out.html, period: { key: r.period.key, label: r.period.label } };
}

/** 寄出一期報表。to 省略時寄給設定的收件人。回傳 { ok, sent, failed, error? }。 */
async function sendReport(kind, { to = null, trigger = 'manual', now = Date.now() } = {}) {
  const settings = getSettings();
  const recipients = to ? [to] : resolveRecipients(settings);
  if (!recipients.length) return { ok: false, error: 'no_recipients' };
  if (!mailer.isConfigured()) return { ok: false, error: 'mail_not_configured' };
  const r = await buildReport(kind, { now, settings });
  const out = renderReport(r, { imageSrc: c => `cid:report-${c.id}`, adminUrl: publicBaseUrl() ? `${publicBaseUrl()}/` : '' });
  const attachments = out.charts.map(c => ({
    filename: `${c.id}.png`,
    content: chart.toPng(c.scene).toString('base64'),
    content_id: `report-${c.id}`,
    content_type: 'image/png'
  }));
  let sent = 0;
  const errors = [];
  for (const addr of recipients) {
    const res = await mailer.send({ to: addr, subject: out.subject, text: out.text, html: out.html, attachments, tag: `report-${kind}` });
    if (res.ok) sent++;
    else errors.push(`${addr}: ${res.error}`);
  }
  const entry = { kind, period: r.period.key, at: Date.now(), trigger, to: recipients, sent, ok: errors.length === 0, error: errors.join('; ') || null };
  try { pushHistory(entry); } catch (_) {}
  if (errors.length) getLogger().warn('Report', `${kind} report ${r.period.key}: ${errors.join('; ')}`);
  else getLogger().info('Report', `${kind} report ${r.period.key} sent to ${sent} recipient(s)`);
  return { ok: errors.length === 0, sent, failed: errors.length, error: errors.join('; ') || null, period: r.period.key };
}

// ── 排程 ─────────────────────────────────────────────────
/** 這一刻該寄哪些報表（不含已寄過的期別）。抽出來方便測試。 */
function dueReports(nowMs, settings = getSettings(), lastSent = k => db.getSetting(LAST_SENT_KEY(k))) {
  const tz = settings.timezone;
  const t = tzParts(nowMs, tz);
  const due = [];
  if (settings.daily.enabled && t.h >= settings.daily.hour) {
    const p = computePeriod('daily', nowMs, tz);
    if (lastSent('daily') !== p.key) due.push({ kind: 'daily', key: p.key });
  }
  if (settings.weekly.enabled && t.wd === settings.weekly.weekday && t.h >= settings.weekly.hour) {
    const p = computePeriod('weekly', nowMs, tz);
    if (lastSent('weekly') !== p.key) due.push({ kind: 'weekly', key: p.key });
  }
  return due;
}

let timer = null;
let running = false;

async function tick(nowMs = Date.now()) {
  if (running || !db.isAvailable() || !mailer.isConfigured()) return [];
  running = true;
  const results = [];
  try {
    for (const job of dueReports(nowMs)) {
      // 先記期別再寄：寄失敗不會每 5 分鐘重寄一次，後台可手動補寄。
      db.setSetting(LAST_SENT_KEY(job.kind), job.key);
      results.push(await sendReport(job.kind, { trigger: 'schedule', now: nowMs }));
    }
  } catch (err) {
    getLogger().error('Report', 'Scheduled report failed', err);
  } finally {
    running = false;
  }
  return results;
}

function start() {
  if (timer || IS_SINGLE_USER || process.env.NODE_TEST_CONTEXT) return;
  // 第一次啟用時，不補寄「今天以前」的報表：把目前這一期記為已寄。
  try {
    if (db.isAvailable()) {
      const s = getSettings();
      for (const kind of ['daily', 'weekly']) {
        if (db.getSetting(LAST_SENT_KEY(kind)) === null) {
          const due = dueReports(Date.now(), s, () => null).find(d => d.kind === kind);
          if (due) db.setSetting(LAST_SENT_KEY(kind), due.key);
        }
      }
    }
  } catch (_) {}
  timer = setInterval(() => { tick().catch(() => {}); }, CHECK_INTERVAL_MS);
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function nextRun(settings, nowMs = Date.now()) {
  const tz = settings.timezone;
  const t = tzParts(nowMs, tz);
  const out = {};
  if (settings.daily.enabled) {
    let at = zonedMidnight(t.y, t.m, t.d, tz) + settings.daily.hour * HOUR_MS;
    if (at <= nowMs) at = zonedMidnight(t.y, t.m, t.d + 1, tz) + settings.daily.hour * HOUR_MS;
    out.daily = at;
  }
  if (settings.weekly.enabled) {
    let add = (settings.weekly.weekday - t.wd + 7) % 7;
    let at = zonedMidnight(t.y, t.m, t.d + add, tz) + settings.weekly.hour * HOUR_MS;
    if (at <= nowMs) at = zonedMidnight(t.y, t.m, t.d + add + 7, tz) + settings.weekly.hour * HOUR_MS;
    out.weekly = at;
  }
  return out;
}

/** 後台狀態。 */
function status() {
  const settings = getSettings();
  return {
    available: db.isAvailable(),
    settings,
    recipients: resolveRecipients(settings),
    adminEmails: adminEmails(),
    mail: { configured: mailer.isConfigured(), provider: mailer.getProvider() },
    history: getHistory(),
    lastSent: { daily: db.isAvailable() ? db.getSetting(LAST_SENT_KEY('daily')) : null, weekly: db.isAvailable() ? db.getSetting(LAST_SENT_KEY('weekly')) : null },
    nextRun: nextRun(settings),
    scheduler: !!timer
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  normalizeSettings,
  getSettings,
  saveSettings,
  resolveRecipients,
  computePeriod,
  zonedMidnight,
  tzParts,
  collectTraffic,
  buildReport,
  renderReport,
  renderPreview,
  sendReport,
  dueReports,
  nextRun,
  tick,
  start,
  stop,
  status,
  DAY_MS
};
