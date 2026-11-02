/**
 * @file lib/share-stats.js — 早安圖（每日經句分享卡）的事件定義與統計彙整
 *
 * 事件寫成 tag = 'ShareCard' 的結構化日誌（logs/access-*.jsonl），entry.share 帶：
 *   { ev, layout?, verse?, pic?, stage? }
 *   - ev     事件種類（見 SHARE_EVENTS）
 *   - layout 版型代號 A/B/C/I/J
 *   - verse  經句代號（sha1(verseKey) 前 10 字，見 lib/home.js verseId）
 *   - pic    伺服器依「經句＋日期」挑到的背景圖（圖庫內的相對路徑）
 *   - stage  失敗發生在哪一步（只有 ev = error 才有）
 * 不記任何使用者帳號、Email 或卡片上的問候語；IP 與其他日誌相同（只用來算獨立訪客）。
 *
 * 聚合時每筆事件換成幾個「鍵」，存在 analytics 每日摘要與 lifetime 的 share 映射裡：
 *   ev:<事件>、layout:<版型>、verse:<代號>、pic:<圖>、err:<步驟>
 * 版型／經句／背景圖只在「真的分享出去」的事件上計數（SEND_EVENTS），
 * 所以排行代表大家實際傳出去的卡片，而不是面板上自動畫出來的預覽。
 */

const SHARE_TAG = 'ShareCard';

/** 所有事件與後台顯示名稱（順序 = 後台表格順序）。 */
const SHARE_EVENTS = {
  open: '打開分享面板',
  line: '傳到 LINE（手機分享選單）',
  lineFile: '傳到 LINE（電腦版改存檔）',
  save: '存圖片',
  copyImage: '複製圖片',
  copyLink: '複製連結',
  shuffle: '換一句',
  visit: '從分享連結進站',
  og: '連結預覽抓圖（LINE／FB 等）',
  error: '失敗'
};

/** 由瀏覽器回報的事件；visit / og 只由伺服器自己記。 */
const CLIENT_EVENTS = new Set(['open', 'line', 'lineFile', 'save', 'copyImage', 'copyLink', 'shuffle', 'error']);

/** 「分享出去」的動作：版型、經句、背景圖排行只算這些。 */
const SEND_EVENTS = new Set(['line', 'lineFile', 'save', 'copyImage', 'copyLink']);

/** 失敗步驟與名稱。 */
const ERROR_STAGES = {
  preview: '面板預覽畫不出來',
  line: '傳到 LINE 時圖片畫不出來',
  save: '存圖片時圖片畫不出來',
  copyImage: '複製圖片失敗（瀏覽器不支援或拒絕）',
  shuffle: '換一句失敗',
  render: '伺服器畫圖失敗',
  meta: '伺服器準備卡片資料失敗',
  verse: '伺服器讀經句失敗'
};

/**
 * 不論是不是爬蟲都要算、但不算進請求數與訪客 IP 的伺服器事件：
 * og:image 幾乎都是 LINE／Facebook 的預覽機器人來抓，伺服器錯誤也不代表一位訪客。
 */
const SERVER_ONLY_EVENTS = new Set(['og']);

const MAX_FIELD = 200;

function cleanField(v) {
  if (v === undefined || v === null) return '';
  return String(v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_FIELD);
}

/** 只留下認得的欄位，給 Logger 寫進 entry.share。不合法的事件回 null。 */
function sanitizeShareFields(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const ev = cleanField(raw.ev);
  if (!Object.prototype.hasOwnProperty.call(SHARE_EVENTS, ev)) return null;
  const out = { ev };
  const layout = cleanField(raw.layout).toUpperCase();
  if (/^[A-Z]$/.test(layout)) out.layout = layout;
  const verse = cleanField(raw.verse);
  if (/^[0-9a-f]{10}$/.test(verse)) out.verse = verse;
  const pic = cleanField(raw.pic);
  if (pic && !pic.includes('..')) out.pic = pic;
  const stage = cleanField(raw.stage);
  if (ev === 'error') out.stage = Object.prototype.hasOwnProperty.call(ERROR_STAGES, stage) ? stage : 'other';
  return out;
}

/** 這筆日誌是不是早安圖事件；是就回傳 share 欄位。舊的 ShareCard 錯誤日誌（沒有 share）視為 server 失敗。 */
function shareFieldsOf(entry) {
  if (!entry || entry.tag !== SHARE_TAG) return null;
  if (entry.share && typeof entry.share === 'object') return sanitizeShareFields(entry.share);
  if (entry.level === 'ERROR') return { ev: 'error', stage: 'render' };
  return null;
}

/** 伺服器事件（og:image）：爬蟲也算，但不算請求數與訪客。 */
function isShareServerEntry(entry) {
  const s = shareFieldsOf(entry);
  return !!(s && SERVER_ONLY_EVENTS.has(s.ev));
}

/** 一筆事件要累加的鍵。 */
function shareKeysOf(entry) {
  const s = shareFieldsOf(entry);
  if (!s) return [];
  const keys = [`ev:${s.ev}`];
  if (SEND_EVENTS.has(s.ev)) {
    if (s.layout) keys.push(`layout:${s.layout}`);
    if (s.verse) keys.push(`verse:${s.verse}`);
    if (s.pic) keys.push(`pic:${s.pic}`);
  }
  if (s.ev === 'error') keys.push(`err:${s.stage || 'other'}`);
  return keys;
}

function countOf(v) {
  const n = Number(v && typeof v === 'object' ? v.count : v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * share 映射（鍵 → 次數；Map 或物件）→ 後台／報表用的摘要。
 * @param {Map|object} map
 * @param {{top?: number}} [opts]
 */
function summarizeShareMap(map, { top = 20 } = {}) {
  const entries = map instanceof Map ? [...map.entries()] : Object.entries(map || {});
  const events = Object.fromEntries(Object.keys(SHARE_EVENTS).map(k => [k, 0]));
  const layouts = new Map();
  const verses = new Map();
  const pics = new Map();
  const errors = new Map();
  for (const [key, raw] of entries) {
    const n = countOf(raw);
    if (!n) continue;
    const i = key.indexOf(':');
    if (i < 0) continue;
    const kind = key.slice(0, i);
    const val = key.slice(i + 1);
    if (kind === 'ev' && Object.prototype.hasOwnProperty.call(events, val)) events[val] += n;
    else if (kind === 'layout') layouts.set(val, (layouts.get(val) || 0) + n);
    else if (kind === 'verse') verses.set(val, (verses.get(val) || 0) + n);
    else if (kind === 'pic') pics.set(val, (pics.get(val) || 0) + n);
    else if (kind === 'err') errors.set(val, (errors.get(val) || 0) + n);
  }
  const sorted = (m) => [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  const sends = [...SEND_EVENTS].reduce((s, k) => s + events[k], 0);
  return {
    events,
    sends,
    sendRate: events.open > 0 ? Math.round((sends / events.open) * 1000) / 10 : null,
    actions: Object.keys(SHARE_EVENTS).map(ev => ({ ev, label: SHARE_EVENTS[ev], count: events[ev] })),
    layouts: sorted(layouts).map(([layout, count]) => ({ layout, count })),
    verses: sorted(verses).slice(0, top).map(([id, count]) => ({ id, count })),
    pics: sorted(pics).slice(0, top).map(([pic, count]) => ({ pic, count })),
    errors: sorted(errors).map(([stage, count]) => ({ stage, label: ERROR_STAGES[stage] || '其他', count }))
  };
}

/** 空的摘要（沒有任何事件時）。 */
function emptyShareSummary() {
  return summarizeShareMap({});
}

/**
 * 把摘要裡的經句代號換成經文（目前後台＋資料夾的經句清單）；
 * 已從清單刪掉的句子找不到時只顯示代號。不改動傳入的物件。
 */
async function withVerseTexts(summary) {
  if (!summary || !Array.isArray(summary.verses) || !summary.verses.length) return summary;
  let byId = new Map();
  try {
    const { config } = require('./config');
    const home = require('./home');
    const sutraQuotes = require('./sutra-quotes');
    const sl = (config.settings && config.settings.suggestList) || {};
    const folder = await sutraQuotes.getFolderVerses();
    const merged = home.mergeVerses(home.resolveVerses(sl.dailyVerses), folder.verses);
    byId = new Map(merged.map(v => [home.verseId(v.text), v]));
  } catch (_) {}
  return {
    ...summary,
    verses: summary.verses.map(v => {
      const hit = byId.get(v.id);
      return hit ? { ...v, text: hit.text, source: hit.source || '' } : { ...v, text: '', source: '' };
    })
  };
}

/** 趨勢圖每一格（一天或一小時）要的欄位。 */
const TREND_FIELDS = ['open', 'sends', 'visit', 'og', 'line', 'lineFile', 'save', 'copyImage', 'copyLink'];

function emptyTrendRow(extra = {}) {
  const row = { ...extra };
  for (const f of TREND_FIELDS) row[f] = 0;
  return row;
}

/** 把某個事件記 n 次到趨勢格子（分享出去的動作同時算進 sends）。 */
function addEventToTrendRow(row, ev, n = 1) {
  if (!row || !ev) return;
  if (Object.prototype.hasOwnProperty.call(row, ev)) row[ev] += n;
  if (SEND_EVENTS.has(ev)) row.sends += n;
}

/** 每日摘要的 share 映射 → 加到趨勢格子。 */
function addShareMapToTrendRow(row, map) {
  for (const [key, raw] of Object.entries(map || {})) {
    if (!key.startsWith('ev:')) continue;
    const n = countOf(raw);
    if (n) addEventToTrendRow(row, key.slice(3), n);
  }
}

/** 0–23 時的「打開面板／分享出去」次數。 */
function emptyHourBins() {
  return Array.from({ length: 24 }, (_, h) => ({ hour: h, open: 0, sends: 0 }));
}

module.exports = {
  TREND_FIELDS,
  emptyTrendRow,
  addEventToTrendRow,
  addShareMapToTrendRow,
  emptyHourBins,
  SHARE_TAG,
  SHARE_EVENTS,
  CLIENT_EVENTS,
  SEND_EVENTS,
  ERROR_STAGES,
  sanitizeShareFields,
  shareFieldsOf,
  isShareServerEntry,
  shareKeysOf,
  summarizeShareMap,
  emptyShareSummary,
  withVerseTexts
};
