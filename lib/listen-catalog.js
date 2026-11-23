/**
 * @file lib/listen-catalog.js — 聽經目錄（ARCHITECTURE §25）
 *
 * 讀者端「聽經」頁的精選經目：分類 → 經 → 品／卷。點一品就用現有的朗讀從那一品開始讀。
 *
 * 資料存在 `config.settings.listenCatalog`（跟著設定備份走）：
 *   { categories: [{ id, name, note }],
 *     items: [{ id, name, sub, cat, path, enabled, split, range, parts }] }
 *   - split：'auto'（有品依品，否則依卷）、'juan'（只依卷）、'none'（不分段）、'manual'（手動）
 *   - range：只取檔案中的一段（節錄，例如普門品）：{ from: 錨點, to: 錨點|null }
 *   - parts：自動模式＝管理員的覆寫（改名、不收錄），以錨點對應；手動模式＝分段本身
 *   - 錨點 { head, line }：該段開頭的文字（去空白）與存檔當時的行號。檔案改過時用文字重新
 *     找最近的那一行，找不到就標示 moved（後台黃燈），不會默默讀錯地方。
 *
 * 斷句沿用朗讀的 `loadDoc()`（tts-segment.js 的標準句與記憶體快取），所以品卷的起點行號、
 * 字數都和實際朗讀一致。
 */

const crypto = require('crypto');
const { config, saveConfig } = require('./config');
const { sendJSON } = require('./static-cache');
const { readJSONBody, requireAdmin, verifySameOrigin } = require('./auth');

const MAX_ITEMS = 200;
const MAX_PARTS = 400;
const MAX_CATS = 30;
const SPLITS = ['auto', 'juan', 'none', 'manual'];
const NUM = '一二三四五六七八九十百千〇零';
const RE_JUAN = new RegExp('卷(?:第)?([' + NUM + ']+|上|中|下)$');
const RE_PIN = new RegExp('(?:品第[' + NUM + ']+(?:之[' + NUM + ']+)?|^[^卷]{1,8}第[' + NUM + ']+)$');
// 標題尾端的校勘夾注，例如大品般若「習應品第三(丹本名為習相應品)」：偵測與顯示名稱都不看它（錨點仍用原文）
const stripNote = (t) => t.replace(/[(（][^()（）]*[)）]$/, '');

let deps = { loadDoc: null, coverage: null };
const resolvedCache = new Map(); // item 簽章 → 解析結果

/** 預設經目（第一次打開時用；檔案不在經文庫裡的自動略過）。 */
const DEFAULT_CATEGORIES = [
  { id: 'jingtu', name: '淨土', note: '念佛往生' },
  { id: 'bore', name: '般若', note: '空慧' },
  { id: 'fahua', name: '法華・觀音', note: '' },
  { id: 'dizang', name: '地藏・孝親', note: '超薦、報恩' },
  { id: 'dasheng', name: '大乘經典', note: '' },
  { id: 'yijiao', name: '佛陀遺教', note: '短經入門' }
];
const T = '01-大正藏/';
const DEFAULT_ITEMS = [
  ['jingtu', '佛說阿彌陀經', '姚秦 鳩摩羅什 譯', '16淨土宗部類/T0366《佛說阿彌陀經》.md'],
  ['jingtu', '佛說無量壽經', '曹魏 康僧鎧 譯', '16淨土宗部類/T0360《佛說無量壽經》.md'],
  ['jingtu', '佛說觀無量壽佛經', '劉宋 畺良耶舍 譯', '16淨土宗部類/T0365《佛說觀無量壽佛經》.md'],
  ['jingtu', '藥師琉璃光如來本願功德經', '唐 玄奘 譯', '09經集部類/T0450《藥師琉璃光如來本願功德經》.md'],
  ['bore', '般若波羅蜜多心經', '唐 玄奘 譯', '03般若部類/T0251《般若波羅蜜多心經》.md'],
  ['bore', '金剛般若波羅蜜經', '姚秦 鳩摩羅什 譯', '03般若部類/T0235《金剛般若波羅蜜經》.md'],
  ['bore', '摩訶般若波羅蜜經', '姚秦 鳩摩羅什 譯', '03般若部類/T0223《摩訶般若波羅蜜經》.md'],
  ['fahua', '妙法蓮華經', '姚秦 鳩摩羅什 譯', '04法華部類/T0262《妙法蓮華經》.md'],
  ['fahua', '觀世音菩薩普門品', '妙法蓮華經 第二十五品', '04法華部類/T0262《妙法蓮華經》.md',
    { split: 'none', range: { from: { head: '妙法蓮華經觀世音菩薩普門品第二十五', line: 3179 }, to: { head: '妙法蓮華經陀羅尼品第二十六', line: 3270 } } }],
  ['dizang', '地藏菩薩本願經', '唐 實叉難陀 譯', '08大集部類/T0412《地藏菩薩本願經》.md'],
  ['dizang', '佛說盂蘭盆經', '西晉 竺法護 譯', '09經集部類/T0685《佛說盂蘭盆經》.md'],
  ['dasheng', '維摩詰所說經', '姚秦 鳩摩羅什 譯', '09經集部類/T0475《維摩詰所說經》.md'],
  ['dasheng', '大方廣圓覺修多羅了義經', '唐 佛陀多羅 譯', '09經集部類/T0842《大方廣圓覺修多羅了義經》.md'],
  ['yijiao', '佛遺教經', '姚秦 鳩摩羅什 譯', '07涅槃部類/T0389《佛垂般涅槃略說教誡經》.md'],
  ['yijiao', '佛說八大人覺經', '後漢 安世高 譯', '09經集部類/T0779《佛說八大人覺經》.md']
];

function newId() { return crypto.randomBytes(5).toString('hex'); }
const norm = (s) => String(s == null ? '' : s).replace(/[\s　]+/g, '');
const str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
const int = (v, d) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : d; };

function defaultCatalog() {
  return {
    categories: DEFAULT_CATEGORIES.map((c) => Object.assign({}, c)),
    items: DEFAULT_ITEMS.map(([cat, name, sub, p, extra], k) => Object.assign({
      id: 'd' + (k + 1), name, sub, cat, path: T + p, enabled: true, split: 'auto', range: null, parts: []
    }, extra ? JSON.parse(JSON.stringify(extra)) : {})),
    seeded: true
  };
}

function sanitizeAnchor(a) {
  if (!a || typeof a !== 'object') return null;
  const head = str(norm(a.head), 120); const line = int(a.line, 0);
  if (!head && !line) return null;
  return { head, line };
}

/** 驗證並整理管理員送來的目錄；不合法的欄位丟掉或換成預設，不整個拒絕。 */
function sanitizeCatalog(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const cats = []; const seen = new Set();
  for (const c of (Array.isArray(src.categories) ? src.categories : []).slice(0, MAX_CATS)) {
    if (!c || typeof c !== 'object') continue;
    const name = str(c.name, 30); if (!name) continue;
    let id = str(c.id, 24).replace(/[^\w-]/g, '') || newId();
    while (seen.has(id)) id = newId();
    seen.add(id); cats.push({ id, name, note: str(c.note, 40) });
  }
  if (!cats.length) cats.push({ id: 'all', name: '經典', note: '' });
  const items = []; const ids = new Set();
  for (const it of (Array.isArray(src.items) ? src.items : []).slice(0, MAX_ITEMS)) {
    if (!it || typeof it !== 'object') continue;
    const name = str(it.name, 60); const p = str(it.path, 400).replace(/\\/g, '/');
    if (!name || !p || p.includes('\0') || !/\.md$/i.test(p)) continue;
    let id = str(it.id, 24).replace(/[^\w-]/g, '') || newId();
    while (ids.has(id)) id = newId();
    ids.add(id);
    const split = SPLITS.includes(it.split) ? it.split : 'auto';
    let range = null;
    if (it.range && typeof it.range === 'object') {
      const from = sanitizeAnchor(it.range.from);
      if (from) range = { from, to: sanitizeAnchor(it.range.to) };
    }
    const parts = [];
    for (const pt of (Array.isArray(it.parts) ? it.parts : []).slice(0, MAX_PARTS)) {
      const a = sanitizeAnchor(pt); if (!a || !a.head) continue;
      parts.push({ head: a.head, line: a.line, title: str(pt.title, 60), on: pt.on !== false });
    }
    items.push({ id, name, sub: str(it.sub, 60), cat: cats.some((c) => c.id === it.cat) ? it.cat : cats[0].id,
      path: p, enabled: it.enabled !== false, split, range, parts });
  }
  return { categories: cats, items };
}

/**
 * 後台存檔前的檢查（sanitizeCatalog 會默默丟掉不合法的東西，這裡先把會被丟掉、或讀者會看錯的地方說出來）。
 * 回傳 { errors, warnings }，每筆 { code, msg, cat?, item? }。有 errors 時不存檔（400），warnings 只提示。
 * 前端 app.js §21.9 lcValidate() 用同樣的規則即時顯示，這裡是最後一道。
 */
function validateCatalog(raw) {
  const errors = []; const warnings = [];
  const src = raw && typeof raw === 'object' ? raw : {};
  const cats = Array.isArray(src.categories) ? src.categories.filter((c) => c && typeof c === 'object') : [];
  const items = Array.isArray(src.items) ? src.items.filter((i) => i && typeof i === 'object') : [];
  if (!cats.length) errors.push({ code: 'no-groups', msg: '至少要有一個群組' });
  if (cats.length > MAX_CATS) errors.push({ code: 'too-many-groups', msg: `群組最多 ${MAX_CATS} 個` });
  if (items.length > MAX_ITEMS) errors.push({ code: 'too-many-items', msg: `經最多 ${MAX_ITEMS} 部` });
  const names = new Map(); const ids = new Set();
  for (const c of cats) {
    const name = str(c.name, 30);
    if (c.id) ids.add(String(c.id));
    if (!name) { errors.push({ code: 'group-name', msg: '有群組沒有名稱', cat: c.id }); continue; }
    if (names.has(name)) errors.push({ code: 'group-dup', msg: `群組名稱「${name}」重複`, cat: c.id });
    names.set(name, c.id);
  }
  const seen = new Map();
  for (const it of items) {
    const name = str(it.name, 60); const p = str(it.path, 400).replace(/\\/g, '/');
    const label = name || '（沒有名稱）';
    if (!name) errors.push({ code: 'item-name', msg: '有經沒有顯示名稱', item: it.id });
    if (!p) errors.push({ code: 'item-path', msg: `「${label}」沒有經文檔案`, item: it.id });
    else if (!/\.md$/i.test(p) || p.includes('\0')) errors.push({ code: 'item-path', msg: `「${label}」的經文檔案要是 .md`, item: it.id });
    if (!ids.has(String(it.cat))) errors.push({ code: 'item-group', msg: `「${label}」不在任何群組裡`, item: it.id });
    if (p && it.enabled !== false) {
      const key = p + '|' + JSON.stringify(it.range || null);
      if (seen.has(key)) warnings.push({ code: 'item-dup', msg: `「${label}」和「${seen.get(key)}」是同一個檔案的同一段`, item: it.id });
      else seen.set(key, label);
    }
  }
  for (const c of cats) {
    if (str(c.name, 30) && !items.some((i) => String(i.cat) === String(c.id) && i.enabled !== false)) {
      warnings.push({ code: 'group-empty', msg: `群組「${str(c.name, 30)}」沒有顯示中的經，讀者頁不會出現`, cat: c.id });
    }
  }
  return { errors, warnings };
}

function getCatalog() {
  const c = config.settings && config.settings.listenCatalog;
  if (c && typeof c === 'object' && Array.isArray(c.items)) return c;
  return defaultCatalog();
}

function saveCatalog(raw) {
  const clean = sanitizeCatalog(raw);
  clean.updatedAt = Date.now();
  config.settings.listenCatalog = clean;
  saveConfig();
  resolvedCache.clear(); readyCache.clear();
  return clean;
}

// ── 品卷偵測 ─────────────────────────────────────────────────────────

const voiced = (u) => u && u.kind !== 'skip' && u.spoken;

/** 讀者看到的名稱：「妙法蓮華經方便品第二」→「方便品第二」；卷 →「卷第三」「卷上」。 */
function partLabel(text, type) {
  const t = stripNote(norm(text));
  if (type === '卷') { const m = RE_JUAN.exec(t); if (m) return '卷' + (/[上中下]/.test(m[1]) ? m[1] : '第' + m[1]); }
  return t.replace(/^(.{2,}?經)(?=.+品第)/, '') || t;
}

/**
 * 從斷句結果找出品與卷的標題。回傳 [{ k, type:'品'|'卷', head, line }]（k＝units 索引），
 * 卷尾重複的卷標題（例如「妙法蓮華經卷第一」在卷末又出現一次）略過。
 */
function scanHeadings(units) {
  const out = []; let lastJuan = null;
  for (let k = 0; k < units.length; k++) {
    const u = units[k];
    if (u.kind !== 'heading' || !(u.level > 0 || u.strict)) continue;
    const t = norm(u.text); const bare = stripNote(t);
    const j = RE_JUAN.exec(bare); const p = RE_PIN.test(bare);
    if (j && !p) {
      if (lastJuan === j[1]) continue;
      lastJuan = j[1];
      out.push({ k, type: '卷', head: t, line: u.line });
    } else if (p) out.push({ k, type: '品', head: t, line: u.line });
  }
  return out;
}

/** 依 split 自動分段：回傳 { unit:'品'|'卷'|'', parts:[{ k, head, line, title, juan }] }。 */
function autoParts(units, split, lo, hi) {
  if (split === 'none') return { unit: '', parts: [] };
  const hs = scanHeadings(units).filter((h) => h.k >= lo && h.k < hi);
  const pins = hs.filter((h) => h.type === '品');
  const usePin = split === 'auto' && pins.length >= 2;
  const list = usePin ? pins : hs.filter((h) => h.type === '卷');
  if (list.length < 2) return { unit: '', parts: [] };
  let juan = '';
  const parts = [];
  for (const h of hs) {
    if (h.type === '卷') juan = partLabel(h.head, '卷');
    if (list.includes(h)) parts.push({ k: h.k, head: h.head, line: h.line, title: partLabel(h.head, h.type), juan: usePin ? juan : '' });
  }
  return { unit: usePin ? '品' : '卷', parts };
}

/** 錨點 → units 索引：先找文字完全相同、離原行號最近的；再找以它開頭的；都沒有回傳 -1。 */
function findAnchor(units, a, lo, hi) {
  if (!a) return -1;
  const head = norm(a.head);
  const s = lo || 0; const e = hi === undefined ? units.length : hi;
  if (!head) { // 只有行號：找含這一行的第一個單位
    for (let k = s; k < e; k++) if (units[k].endLine >= a.line) return k;
    return -1;
  }
  let best = -1; let bestD = Infinity;
  for (const exact of [true, false]) {
    for (let k = s; k < e; k++) {
      const t = norm(units[k].text);
      if (exact ? t !== head : !(t.startsWith(head) || (head.length >= 4 && head.startsWith(t) && t.length >= 4 && units[k].kind === 'heading'))) continue;
      const d = Math.abs(units[k].line - (a.line || units[k].line));
      if (d < bestD) { best = k; bestD = d; }
    }
    if (best >= 0) return best;
  }
  return -1;
}

function charsBetween(units, a, b) {
  let n = 0;
  for (let k = a; k < b; k++) if (voiced(units[k])) n += units[k].spoken.length;
  return n;
}

/**
 * 解析一筆經目（需要斷句結果）。回傳讀者端用的形狀，外加 issues（後台燈號用）。
 * { line, endLine, chars, unit, parts:[{ t, juan, line, chars, head }], issues:[...] }
 * endLine＝停止的行（不含）；0＝讀到檔尾。
 */
function resolveItem(item, entry, opts) {
  const all = !!(opts && opts.all); // 後台：不收錄的段也列出來（off: true）
  const units = entry.units; const issues = [];
  let lo = 0; let hi = units.length;
  if (item.range) {
    const a = findAnchor(units, item.range.from);
    if (a < 0) issues.push('range-start');
    else lo = a;
    if (item.range.to) {
      const b = findAnchor(units, item.range.to, lo + 1);
      if (b < 0) issues.push('range-end'); else hi = b;
    }
  }
  let unit = ''; let raw = [];
  if (item.split === 'manual') {
    unit = '段';
    for (const p of item.parts) {
      const k = findAnchor(units, p, lo, hi);
      if (k < 0) { issues.push('part:' + p.head); continue; }
      raw.push({ k, head: p.head, line: units[k].line, title: p.title || p.head, juan: '', off: p.on === false });
    }
    raw.sort((x, y) => x.k - y.k);
    raw = raw.filter((p, i) => i === 0 || p.k !== raw[i - 1].k);
  } else {
    const d = autoParts(units, item.split, lo, hi);
    unit = d.unit;
    for (const p of d.parts) {
      const ov = item.parts.find((o) => o.head === p.head && Math.abs((o.line || p.line) - p.line) < 400) || item.parts.find((o) => o.head === p.head);
      if (ov && ov.on === false) { p.off = true; }
      if (ov && ov.title) p.title = ov.title;
      raw.push(p);
    }
  }
  // 每段的長度算到下一段（不收錄的段落仍然是邊界，只是不列出來）
  const parts = [];
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i];
    const end = i + 1 < raw.length ? raw[i + 1].k : hi;
    if (p.off && !all) continue;
    const o = { t: p.title, juan: p.juan || '', line: p.line, endLine: units[end] ? units[end].line : 0, chars: charsBetween(units, p.k, end), head: p.head };
    if (p.off) o.off = true;
    parts.push(o);
  }
  // 第一段之前的內容（經名、譯者）併入第一段的長度，從頭讀誦時一起讀
  if (parts.length && raw.length && raw[0].k > lo && !parts[0].off) parts[0].chars += charsBetween(units, lo, raw[0].k);
  const shown = all ? parts.filter((p) => !p.off).length : parts.length;
  return {
    line: units[lo] ? units[lo].line : 1,
    endLine: hi < units.length && units[hi] ? units[hi].line : 0,
    lastLine: units[hi - 1] ? units[hi - 1].endLine : 1,
    chars: charsBetween(units, lo, hi),
    unit: shown >= 2 ? unit : '',
    parts: shown >= 2 || all ? parts : [],
    issues
  };
}

async function resolveCached(item) {
  if (!deps.loadDoc) return null;
  let entry;
  try { entry = await deps.loadDoc(item.path); } catch (_) { entry = null; }
  if (!entry) return null;
  const key = entry.relPath + '|' + entry.sig + '|' + JSON.stringify([item.split, item.range, item.parts]);
  const hit = resolvedCache.get(item.id);
  if (hit && hit.key === key) return hit.r;
  const r = Object.assign(resolveItem(item, entry), { path: entry.relPath });
  resolvedCache.set(item.id, { key, r });
  if (resolvedCache.size > MAX_ITEMS * 2) resolvedCache.delete(resolvedCache.keys().next().value);
  return r;
}

/** 讀者端的目錄：只列出顯示中、檔案存在的經。 */
async function publicCatalog() {
  const c = getCatalog();
  const items = [];
  for (const it of c.items) {
    if (it.enabled === false) continue;
    const r = await resolveCached(it);
    if (!r) continue;
    items.push({ id: it.id, name: it.name, sub: it.sub, cat: it.cat, path: r.path, line: r.line, endLine: r.endLine, lastLine: r.lastLine,
      chars: r.chars, unit: r.unit, parts: r.parts.map((p) => ({ t: p.t, juan: p.juan, line: p.line, endLine: p.endLine, chars: p.chars })) });
  }
  const cats = c.categories.filter((cat) => items.some((i) => i.cat === cat.id));
  return { categories: cats, items, updatedAt: c.updatedAt || 0 };
}

/** 後台：完整目錄＋每部經的解析結果與問題。 */
async function adminCatalog() {
  const c = getCatalog();
  const status = {};
  for (const it of c.items) {
    const r = await resolveCached(it);
    status[it.id] = r ? { ok: true, line: r.line, endLine: r.endLine, chars: r.chars, unit: r.unit, parts: r.parts, issues: r.issues }
      : { ok: false, issues: ['missing'] };
  }
  return { catalog: { categories: c.categories, items: c.items }, seeded: !!c.seeded, status };
}

/** 後台：偵測一個檔案的品卷（不存檔），也回傳所有可當錨點的標題，供手動分段與節錄挑選。 */
async function detect(body) {
  const item = sanitizeCatalog({ categories: [{ id: 'x', name: 'x' }], items: [Object.assign({ name: 'x', cat: 'x' }, body || {})] }).items[0];
  if (!item || !deps.loadDoc) return null;
  const entry = await deps.loadDoc(item.path);
  if (!entry) return null;
  const units = entry.units;
  const r = resolveItem(item, entry, { all: true });
  // 候選錨點：所有標題，加上像「行由第一」這種獨立成行的短句
  const heads = [];
  for (let k = 0; k < units.length && heads.length < 600; k++) {
    const u = units[k];
    const t = norm(u.text);
    const shortLine = u.kind !== 'skip' && t.length <= 16 && !/[，。；？！、：]/.test(t) && (k === 0 || units[k - 1].line !== u.line) && (k + 1 >= units.length || units[k + 1].line !== u.line);
    if (u.kind === 'heading' || (shortLine && /第[一二三四五六七八九十百]+$/.test(t))) heads.push({ head: t, line: u.line, level: u.level || 0, chars: 0, k });
  }
  for (let i = 0; i < heads.length; i++) heads[i].chars = charsBetween(units, heads[i].k, i + 1 < heads.length ? heads[i + 1].k : units.length);
  return { path: entry.relPath, title: entry.title, totalChars: charsBetween(units, 0, units.length), resolved: r, headings: heads.map(({ k, ...h }) => h) };
}

/** 目錄裡所有經的檔案（預先生成整個目錄用；去重、只取顯示中的）。 */
function catalogFiles() {
  const seen = new Set(); const out = [];
  for (const it of getCatalog().items) if (it.enabled !== false && !seen.has(it.path)) { seen.add(it.path); out.push(it.path); }
  return out;
}

/**
 * 預先生成整個目錄用：每部顯示中的經一筆 { p, from, to, name }，範圍和讀者端、覆蓋率一致
 * （節錄的普門品只生成那一品，不會把整部法華經也排進去）。同一檔同一範圍只留一筆；檔案不存在的略過。
 */
async function catalogJobEntries() {
  const seen = new Set(); const out = [];
  for (const it of getCatalog().items) {
    if (it.enabled === false) continue;
    const r = await resolveCached(it);
    if (!r) continue;
    const key = `${r.path}|${r.line}|${r.endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ p: r.path, from: r.line || 0, to: r.endLine || 0, name: it.name });
  }
  return out;
}

// ── 路由 ─────────────────────────────────────────────────────────────

function isListenRoute(pathname) { return pathname === '/api/listen/catalog' || pathname === '/api/listen/ready' || pathname.startsWith('/api/admin/listen/'); }

// 讀者端：每部經在某個音色下已生成幾成（訪客不能生成新音檔時，標出哪些經可以直接聽）。
// 要對每部經查一次快取，所以結果依音色快取 10 分鐘。
const READY_TTL_MS = 10 * 60 * 1000;
const readyCache = new Map(); // voice → { at, items }

async function readyMap(voice) {
  const hit = readyCache.get(voice);
  if (hit && Date.now() - hit.at < READY_TTL_MS) return hit.items;
  const items = {};
  for (const it of getCatalog().items) {
    if (it.enabled === false) continue;
    const r = await resolveCached(it);
    if (!r) continue;
    const c = await deps.coverage(it.path, voice, r.line, r.endLine);
    if (c && c.voiced) items[it.id] = Math.floor(c.cached / c.voiced * 100);
  }
  if (readyCache.size > 30) readyCache.clear();
  readyCache.set(voice, { at: Date.now(), items });
  return items;
}

async function handle(req, res, pathname, query) {
  const m = req.method;
  if (pathname === '/api/listen/catalog' && m === 'GET') {
    const data = await publicCatalog();
    res.setHeader('Cache-Control', 'no-cache');
    sendJSON(res, 200, data); return true;
  }
  if (pathname === '/api/listen/ready' && m === 'GET') {
    // 讀者端：「開放朗讀」關閉時不回覆蓋率（後台的 /api/admin/listen/coverage 照常可用）
    if (!deps.coverage || (deps.readerEnabled && !deps.readerEnabled())) { sendJSON(res, 200, { available: false, items: {} }); return true; }
    const voice = /^v[0-9a-z]{1,10}$/.test(String(query.voice || '')) ? String(query.voice) : '';
    sendJSON(res, 200, { available: true, items: await readyMap(voice) }); return true;
  }
  if (!pathname.startsWith('/api/admin/listen/')) return false;
  if (!requireAdmin(req, res, sendJSON)) return true;
  if (m === 'POST' && !verifySameOrigin(req)) { sendJSON(res, 403, { error: '請求來源不符', code: 'BAD_ORIGIN' }); return true; }
  const sub = pathname.slice('/api/admin/listen/'.length);
  if (sub === 'catalog' && m === 'GET') { sendJSON(res, 200, await adminCatalog()); return true; }
  if (sub === 'catalog' && m === 'POST') {
    const body = await readJSONBody(req);
    if (!body || typeof body.catalog !== 'object') { sendJSON(res, 400, { error: '缺少 catalog', code: 'BAD_REQUEST' }); return true; }
    const v = validateCatalog(body.catalog);
    if (v.errors.length) { sendJSON(res, 400, { error: v.errors[0].msg, code: 'INVALID_CATALOG', errors: v.errors, warnings: v.warnings }); return true; }
    saveCatalog(body.catalog);
    sendJSON(res, 200, Object.assign({ ok: true }, await adminCatalog())); return true;
  }
  if (sub === 'catalog/reset' && m === 'POST') {
    if (config.settings) delete config.settings.listenCatalog;
    saveConfig(); resolvedCache.clear();
    sendJSON(res, 200, Object.assign({ ok: true }, await adminCatalog())); return true;
  }
  if (sub === 'detect' && m === 'POST') {
    const body = await readJSONBody(req);
    const d = await detect(body);
    if (!d) { sendJSON(res, 404, { error: '找不到這篇經文', code: 'NOT_FOUND' }); return true; }
    sendJSON(res, 200, d); return true;
  }
  if (sub === 'coverage' && m === 'GET') {
    if (!deps.coverage) { sendJSON(res, 200, { available: false }); return true; }
    const out = {};
    for (const it of getCatalog().items) {
      if (it.enabled === false) continue;
      const r = await resolveCached(it);
      if (!r) continue;
      out[it.id] = await deps.coverage(it.path, String(query.voice || ''), r.line, r.endLine, { admin: true }); // 停用中的音色也看得到進度
    }
    sendJSON(res, 200, { available: true, items: out }); return true;
  }
  return false;
}

function init(d) { deps = Object.assign(deps, d || {}); }

module.exports = {
  init, isListenRoute, handle, getCatalog, saveCatalog, sanitizeCatalog, validateCatalog, publicCatalog, adminCatalog, detect, catalogFiles, catalogJobEntries,
  _internals: { scanHeadings, autoParts, resolveItem, findAnchor, partLabel, defaultCatalog, resolvedCache }
};
