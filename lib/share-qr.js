'use strict';
/**
 * lib/share-qr.js — 早安圖上 QR 碼的短網址
 *
 * QR 裡放的是短網址，掃了由伺服器轉到原文那一行：
 *   <網站>/V<7 碼><版型>   每日經句（7 碼 = 經句代號 verseId 的前 7 個十六進位字，大寫）
 *   <網站>/Q<7 碼><版型>   經文選句（7 碼 = 選句代號的前 7 個字）
 *   例：HTTPS://MBT.MAHABODHI.CO/V3FA2C91A
 * 網址的協定與主機名一律大寫，整串只有大寫英數，QR 可以用「英數模式」存，格子較少（25×25）。
 * 伺服器比對時大小寫通用；版型字母只用來記統計，可省略。
 *
 * 每日經句沒有行號：在它的經文路徑（｜第三欄）裡找這一句；沒填路徑就用出處經名找同名的經。
 * 找到的行號快取 10 分鐘。找不到就回首頁顯示那一句（/?verse=<id>）。
 */

const fs = require('fs');
const shareQuotes = require('./share-quotes');

const CODE_LEN = 7;
const PATH_RE = /^\/([VQ])([0-9A-F]{7})([A-Z])?\/?$/i;
const TARGET_TTL_MS = 10 * 60 * 1000;
const TARGET_CACHE_MAX = 500;
const MAX_FILE_BYTES = 40 * 1024 * 1024;
const MAX_CANDIDATES = 6;

/** 代號 → 短碼（7 個大寫十六進位字）。 */
function shortCode(id) {
  const s = String(id || '');
  return /^[0-9a-f]{10}$/.test(s) ? s.slice(0, CODE_LEN).toUpperCase() : '';
}

/**
 * QR 用的短網址。baseUrl 例：https://mbt.mahabodhi.co（後面若有子路徑則保留原樣）。
 * kind：'verse' | 'quote'；layout：A、B…（可省略）。代號不合法回 ''。
 */
function qrUrl(baseUrl, kind, id, layout) {
  const code = shortCode(id);
  if (!code) return '';
  let origin = '';
  let basePath = '';
  try {
    const u = new URL(String(baseUrl || ''));
    origin = `${u.protocol}//${u.host}`.toUpperCase();
    basePath = u.pathname.replace(/\/+$/, '');
  } catch (_) {
    return '';
  }
  const L = /^[A-Z]$/i.test(String(layout || '')) ? String(layout).toUpperCase() : '';
  return `${origin}${basePath}/${kind === 'quote' ? 'Q' : 'V'}${code}${L}`;
}

/** 解析路徑 /V3FA2C91A → { kind, code(小寫), layout } 或 null。 */
function parseQrPath(pathname) {
  const m = PATH_RE.exec(String(pathname || ''));
  if (!m) return null;
  return {
    kind: m[1].toUpperCase() === 'Q' ? 'quote' : 'verse',
    code: m[2].toLowerCase(),
    layout: m[3] ? m[3].toUpperCase() : ''
  };
}

/** 在 Markdown 原文裡找這句的行號（1 起算）；找不到回 null。 */
function findLine(markdown, text) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const clean = lines.map(shareQuotes.cleanMarkdownLine).join('\n');
  const hit = shareQuotes.locate(clean, String(text || ''));
  if (!hit) return null;
  return 1 + (clean.slice(0, hit.start).match(/\n/g) || []).length;
}

/** 經名比對用：去掉書名號、空白與標點。 */
function titleKey(s) {
  return String(s || '').replace(/[《》〈〉「」『』\s\p{P}]/gu, '');
}

/** 由出處挑候選檔：檔名（去經號）與出處相同的優先，再來是互相包含的。 */
function candidateFiles(files, source) {
  const want = titleKey(source);
  if (Array.from(want).length < 2) return [];
  const exact = [];
  const partial = [];
  for (const f of files) {
    const t = titleKey(shareQuotes.sourceTitle(f.relPath));
    if (!t) continue;
    if (t === want) exact.push(f);
    else if (Array.from(t).length >= 2 && (t.includes(want) || want.includes(t))) partial.push(f);
  }
  return exact.concat(partial).slice(0, MAX_CANDIDATES);
}

async function readSmall(abs) {
  const st = await fs.promises.stat(abs);
  if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
  return fs.promises.readFile(abs, 'utf-8');
}

const targetCache = new Map();

/**
 * 每日經句 → { path, line } 或 null。
 * deps：{ resolveMdPath(p) → {resolved, relPath}|null, listFiles() → Promise<[{fullPath, relPath}]> }
 */
async function locateVerse(verse, deps) {
  if (!verse || !verse.text) return null;
  const key = `${verse.text}\u0000${verse.path || ''}\u0000${verse.source || ''}`;
  const hit = targetCache.get(key);
  if (hit && Date.now() - hit.at < TARGET_TTL_MS) return hit.target;
  let target = null;
  const tryFile = async (abs, relPath) => {
    try {
      const md = await readSmall(abs);
      if (md === null) return null;
      const line = findLine(md, verse.text);
      return line ? { path: relPath, line } : null;
    } catch (_) {
      return null;
    }
  };
  if (verse.path) {
    const r = deps.resolveMdPath(verse.path);
    if (r) target = (await tryFile(r.resolved, r.relPath)) || { path: r.relPath, line: null };
  }
  if (!target && verse.source && deps.listFiles) {
    let files = [];
    try { files = await deps.listFiles(); } catch (_) { files = []; }
    for (const f of candidateFiles(files, verse.source)) {
      target = await tryFile(f.fullPath, f.relPath);
      if (target) break;
    }
  }
  targetCache.set(key, { target, at: Date.now() });
  while (targetCache.size > TARGET_CACHE_MAX) targetCache.delete(targetCache.keys().next().value);
  return target;
}

/** 轉址目標：經文那一行，或首頁。 */
function fileUrl(path, line) {
  return `/?file=${encodeURIComponent(path)}${line ? `&line=${line}` : ''}`;
}

function _resetForTests() {
  targetCache.clear();
}

module.exports = {
  CODE_LEN,
  shortCode,
  qrUrl,
  parseQrPath,
  findLine,
  candidateFiles,
  locateVerse,
  fileUrl,
  _resetForTests
};
