/**
 * @file lib/tts-lexicon.js — 朗讀的讀音字典
 *
 * 檔案：TTS_LEXICON_PATH，沒設定時是 config.json 旁的 `tts-lexicon.txt`（Docker：/data/tts-lexicon.txt）。
 * 格式：一行一條「詞｜替換」（全形或半形直線都可），`#` 開頭是註解；只寫詞＝只保護這個詞不被切開。
 * 替換在斷句之後、雜湊之前套用，所以改字典只有真的被替換到的句子會重新生成。
 * 熱重載：每 10 秒最多檢查一次 mtime／大小，沒變就不重讀（比照 lib/sutra-quotes.js）。
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

/** [[詞, 替換]]，給 tts-segment 的 `lexicon` 選項。 */
function entries() { return load(false).entries; }
/** 字典內容的雜湊：文件斷句結果的快取用它判斷要不要重切。 */
function version() { return load(false).hash; }
function describe() { const c = load(true); return { path: lexiconPath(), exists: c.exists, text: c.text, count: c.entries.length, replacements: c.entries.filter((e) => e[1]).length }; }

function save(text) {
  const s = String(text == null ? '' : text).replace(/\r\n/g, '\n');
  if (Buffer.byteLength(s) > MAX_BYTES) throw Object.assign(new Error('讀音字典太大（上限 200 KB）'), { code: 'TOO_LARGE' });
  const file = lexiconPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, s, 'utf8');
  return describe();
}

function resetCache() { cache.checkedAt = 0; cache.sig = ''; }

module.exports = { lexiconPath, entries, version, describe, save, resetCache, DEFAULT_TEXT, MAX_BYTES };
