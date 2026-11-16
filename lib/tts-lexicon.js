/**
 * @file lib/tts-lexicon.js — 朗讀的讀音字典
 *
 * 檔案：TTS_LEXICON_PATH，沒設定時是 config.json 旁的 `tts-lexicon.txt`（Docker：/data/tts-lexicon.txt）。
 * 格式：一行一條「詞｜替換」（全形或半形直線都可），`#` 開頭是註解；只寫詞＝只保護這個詞不被切開。
 * 替換在斷句之後、雜湊之前套用，所以改字典只有真的被替換到的句子會重新生成。
 * 熱重載：每 10 秒最多檢查一次 mtime／大小，沒變就不重讀（比照 lib/sutra-quotes.js）。
 * 另有兩份隨程式附的內建表（後台同一個開關）：佛經讀音表（詞）與罕見字讀音表（單字，見 charMap）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CONFIG_PATH } = require('./constants');
const { parseLexicon } = require('../tts-segment.js');

const RESCAN_MS = 10 * 1000;
const MAX_BYTES = 200 * 1024;

/** 檔案不存在時的預設：只保護不替換（替換會改變快取鍵，交給管理員試聽後再加）。 */
const DEFAULT_TEXT = [
  '# 朗讀讀音字典：一行一條「詞｜替換」。只寫詞＝朗讀時不在這個詞中間斷句。',
  '# 例：般若｜波惹',
  '阿耨多羅三藐三菩提', '般若波羅蜜多', '般若波羅蜜', '菩薩摩訶薩', '摩訶薩', '須菩提', '舍利弗',
  '波羅蜜多', '三摩地', '比丘尼', '優婆塞', '優婆夷', '阿羅漢', '辟支佛', '南無', ''
].join('\n');

// ── 內建佛經讀音表（lib/tts-lexicon-buddhist.txt，跟著程式更新；後台可整份關掉，或在自訂字典裡逐條覆寫）──
const BUILTIN_PATH = path.join(__dirname, 'tts-lexicon-buddhist.txt');
let builtin = loadBuiltin();

function loadBuiltin() {
  let text = '';
  try { text = fs.readFileSync(BUILTIN_PATH, 'utf8'); } catch (_) {}
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s[0] === '#') continue;
    const [word, to, reading, source] = s.split(/[｜|]/).map((x) => (x || '').trim());
    if (word && to) rows.push({ word, to, reading: reading || '', source: source || '' });
  }
  return { rows, hash: crypto.createHash('sha1').update(text).digest('hex').slice(0, 12) };
}

// ── 罕見字讀音表（lib/tts-lexicon-rare.txt，tools/rare-chars/build-readings.py 產生；跟「內建佛經讀音表」同一個開關）──
// 一字一條「字｜改讀為｜讀音｜依據」，改讀為「-」＝朗讀時略過。逐字查表（不走詞的比對），九千多字也不拖慢斷句。
const RARE_PATH = path.join(__dirname, 'tts-lexicon-rare.txt');
const rare = loadRare();

function loadRare() {
  let text = '';
  try { text = fs.readFileSync(RARE_PATH, 'utf8'); } catch (_) {}
  const map = Object.create(null); let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s[0] === '#') continue;
    const [ch, to] = s.split('｜');
    if (!ch || Array.from(ch).length !== 1 || !to) continue;
    map[ch] = to === '-' ? '' : to;
    if (to === '-') skipped++;
  }
  return { map, count: Object.keys(map).length, skipped, hash: crypto.createHash('sha1').update(text).digest('hex').slice(0, 12) };
}

let rareCache = { sig: null, map: null };

let cache = { text: DEFAULT_TEXT, entries: parseLexicon(DEFAULT_TEXT), hash: '', sig: 'default', checkedAt: 0, exists: false };
cache.hash = hashOf(cache.text);

function hashOf(text) { return crypto.createHash('sha1').update(text).digest('hex').slice(0, 12); }

function lexiconPath(env = process.env) {
  const raw = String(env.TTS_LEXICON_PATH || '').trim();
  if (!raw) return path.join(path.dirname(CONFIG_PATH), 'tts-lexicon.txt');
  return path.isAbsolute(raw) ? raw : path.resolve(path.dirname(CONFIG_PATH), raw);
}

function load(force) {
  const now = Date.now();
  if (!force && now - cache.checkedAt < RESCAN_MS) return cache;
  cache.checkedAt = now;
  const file = lexiconPath();
  let sig = 'default'; let text = DEFAULT_TEXT; let exists = false;
  try {
    const st = fs.statSync(file);
    sig = `${st.size}-${st.mtimeMs}`; exists = true;
    if (sig === cache.sig) return cache;
    text = st.size > MAX_BYTES ? DEFAULT_TEXT : fs.readFileSync(file, 'utf8');
  } catch (_) { if (cache.sig === 'default') return cache; }
  cache = { text, entries: parseLexicon(text), hash: hashOf(text), sig, checkedAt: now, exists };
  return cache;
}

/**
 * [[詞, 替換]]，給 tts-segment 的 `lexicon` 選項。
 * useBuiltin：疊上內建佛經讀音表；自訂字典裡同一個詞有寫讀法就以自訂為準。
 * 要停用某一條：自訂字典寫「詞｜詞」（照原字念）。只寫詞（不斷句保護）不影響內建的讀法。
 */
function entries(useBuiltin) {
  const own = load(false).entries;
  if (!useBuiltin) return own;
  const have = new Set(own.filter((e) => e[1]).map((e) => e[0]));
  // 長的詞先換（「摩訶迦葉」要比「摩訶」「迦葉」先處理）
  return own.concat(builtin.rows.filter((r) => !have.has(r.word)).map((r) => [r.word, r.to])).sort((x, y) => y[0].length - x[0].length);
}
/**
 * 罕見字讀音表 {字: 改讀為}，給 tts-segment 的 `charMap` 選項；沒開內建讀音表時回 null。
 * 自訂字典裡寫了讀法的單字（含「字｜字」＝照原字念）以自訂為準，不再查表。
 */
function charMap(useBuiltin) {
  if (!useBuiltin || !rare.count) return null;
  const c = load(false);
  if (rareCache.sig === c.hash) return rareCache.map;
  const own = c.entries.filter((e) => e[1] && Array.from(e[0]).length === 1).map((e) => e[0]);
  let map = rare.map;
  if (own.some((ch) => ch in rare.map)) {
    map = Object.assign(Object.create(null), rare.map);
    for (const ch of own) delete map[ch];
  }
  rareCache = { sig: c.hash, map };
  return map;
}

/** 字典內容的雜湊：文件斷句結果的快取用它判斷要不要重切。 */
function version(useBuiltin) { return load(false).hash + (useBuiltin ? `+${builtin.hash}+${rare.hash}` : ''); }
function describe() {
  const c = load(true);
  const own = new Map(c.entries.filter((e) => e[1]).map((e) => [e[0], e[1]]));
  return {
    path: lexiconPath(), exists: c.exists, text: c.text, count: c.entries.length, replacements: c.entries.filter((e) => e[1]).length,
    builtin: builtin.rows.map((r) => Object.assign({}, r, { overridden: own.has(r.word), override: own.get(r.word) || '' })),
    rare: { count: rare.count, skipped: rare.skipped }
  };
}

function save(text) {
  const s = String(text == null ? '' : text).replace(/\r\n/g, '\n');
  if (Buffer.byteLength(s) > MAX_BYTES) throw Object.assign(new Error('讀音字典太大（上限 200 KB）'), { code: 'TOO_LARGE' });
  const file = lexiconPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, s, 'utf8');
  return describe();
}

function resetCache() { cache.checkedAt = 0; cache.sig = ''; }

module.exports = { lexiconPath, entries, charMap, version, describe, save, resetCache, DEFAULT_TEXT, MAX_BYTES, BUILTIN_PATH, builtinRows: () => builtin.rows };
