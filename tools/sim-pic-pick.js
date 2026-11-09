#!/usr/bin/env node
/**
 * 早安圖背景圖「挑得平不平均」的模擬器。
 *
 * 做法：照伺服器真正的流程跑——先用 lib/share-card-server 的 listPics() 掃一個圖庫資料夾，
 * 再對很多組「經句代號 × 日期」呼叫 pickPic()，數每張圖被挑中幾次；然後在圖庫裡「新增一張圖」
 * （把掃描時鐘撥過 1 分鐘的快取時間讓它重掃），再模擬一次，看新圖被挑中的機率是不是 1/(N+1)。
 * 輸出：每張圖的次數／占比／離期望值幾個標準差、卡方檢定，以及新增那張圖的實際機率。
 *
 * 用法：
 *   node tools/sim-pic-pick.js                          用 53 張假圖（兩個子資料夾）
 *   node tools/sim-pic-pick.js --pics 120               假圖張數
 *   node tools/sim-pic-pick.js --dir data/pic-card      照這個資料夾的檔名建假圖（不動原資料夾、不讀圖內容）
 *   node tools/sim-pic-pick.js --verses data/sutra-quote/每日經句選集.md
 *                                                       用真的經句（算真的代號）；沒給就用 467 個合成代號
 *   node tools/sim-pic-pick.js --days 365 --add last    新圖排在最後｜first｜middle｜folder（新子資料夾）
 *   node tools/sim-pic-pick.js --verbose                逐張列出
 *
 * 不碰網路與真正的圖庫；結果可重現（沒有亂數）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const sc = require(path.join(ROOT, 'lib', 'share-card-server'));
const home = require(path.join(ROOT, 'lib', 'home'));

/** 圖庫清單的重掃間隔（lib/share-card-server.js 的 SCAN_TTL_MS = 60 秒）；撥時鐘用，多撥一點。 */
const RESCAN_AFTER_MS = 61000;

// ── 統計 ────────────────────────────────────────────────────────────────

/** 標準常態分布的累積機率（Abramowitz–Stegun 7.1.26，誤差 < 1.5e-7）。 */
function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

/** 各格次數對「全部一樣多」的卡方檢定。p 越小越不均勻（Wilson–Hilferty 近似）。 */
function chiSquare(counts) {
  const k = counts.length;
  const total = counts.reduce((a, b) => a + b, 0);
  const expected = total / k;
  let chi2 = 0;
  for (const c of counts) chi2 += (c - expected) ** 2 / expected;
  const df = k - 1;
  const z = df > 0 ? (chi2 - df) / Math.sqrt(2 * df) : 0;
  const w = df > 0 ? (Math.cbrt(chi2 / df) - (1 - 2 / (9 * df))) / Math.sqrt(2 / (9 * df)) : 0;
  return { k, total, expected, chi2, df, z, p: 1 - normalCdf(w) };
}

// ── 輸入資料 ────────────────────────────────────────────────────────────

/** 合成經句代號：和真的一樣是 10 碼十六進位（SHA-1 前 10 碼），但不用真經句。 */
function syntheticVerseIds(n) {
  return Array.from({ length: n }, (_, i) => crypto.createHash('sha1').update(`synthetic-verse-${i}`).digest('hex').slice(0, 10));
}

/** 從「經句｜出處」格式的 md 檔算真的經句代號（和 server.js 的 verseId 同一支）。 */
function verseIdsFromMarkdown(file) {
  const verses = home.parseQuoteMarkdown(fs.readFileSync(file, 'utf8'));
  return [...new Set(verses.map(v => home.verseId(v.text)).filter(Boolean))];
}

/** 連續 n 天（YYYY-MM-DD）。 */
function dateRange(n, start = '2026-01-01') {
  const out = [];
  const d = new Date(`${start}T00:00:00Z`);
  for (let i = 0; i < n; i++) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

/** 假圖庫的相對路徑：兩個子資料夾，每個資料夾裡「NNN-名稱.png」。 */
function fakePicNames(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(`ba${1 + (i % 2)}-sel1/${String(i * 3 + 1).padStart(3, '0')}-pic.png`);
  return out;
}

/** 照名單在 root 下建空檔案，回傳 root。 */
function buildLibrary(root, names) {
  for (const rel of names) {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '');
  }
  return root;
}

/** 新圖放哪裡：排序後的最前面、中間、最後面，或新子資料夾。 */
function newPicName(where) {
  switch (where) {
    case 'first': return '000-new.png';
    case 'middle': return 'ba1-sel1/200-new.png';
    case 'folder': return 'ba3-new-batch/001-new.png';
    case 'last':
    default: return 'zzz-new.png';
  }
}

// ── 模擬 ────────────────────────────────────────────────────────────────

/** 對 ids × dates 的每一組呼叫 pickFn(list, id, date)，回傳 Map(圖 → 次數)，沒被挑到的也有 0。 */
function countPicks(list, ids, dates, pickFn = sc.pickPic) {
  const counts = new Map(list.map(p => [p, 0]));
  let none = 0;
  for (const date of dates) {
    for (const id of ids) {
      const p = pickFn(list, id, date);
      if (p === null || p === undefined) { none++; continue; }
      counts.set(p, (counts.get(p) || 0) + 1);
    }
  }
  return { counts, none, total: ids.length * dates.length };
}

/** 彙整一次模擬：卡方、最多／最少、前半與後半（依清單排序）各占多少。 */
function summarize(list, run) {
  const arr = list.map(p => run.counts.get(p) || 0);
  const chi = chiSquare(arr);
  const half = Math.floor(list.length / 2);
  const firstHalf = arr.slice(0, half).reduce((a, b) => a + b, 0);
  return {
    ...chi,
    min: Math.min(...arr), max: Math.max(...arr),
    firstHalfShare: firstHalf / run.total,
    expectedFirstHalfShare: half / list.length,
    arr
  };
}

/** 某一格的實際次數對期望值是幾個標準差（二項分布）。 */
function sigmaOf(count, total, k) {
  const p = 1 / k;
  return (count - total * p) / Math.sqrt(total * p * (1 - p));
}

/**
 * 整套流程：掃圖庫 → 模擬 → 新增一張圖 → 撥時鐘讓它重掃 → 再模擬。
 * 回傳 { before: {list, run, stats}, after: {list, run, stats, newPic, newCount, newShare, newSigma, seen} }。
 */
async function simulate({ names, ids, dates, add = 'last' }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdw-picsim-'));
  const env = { PIC_CARD_DIR: path.join(tmp, 'pic-card') };
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    buildLibrary(env.PIC_CARD_DIR, names);
    await sc._resetForTests();
    const s1 = await sc.listPics(env);
    const run1 = countPicks(s1.list, ids, dates);
    const before = { list: s1.list, run: run1, stats: summarize(s1.list, run1) };

    const newPic = newPicName(add);
    buildLibrary(env.PIC_CARD_DIR, [newPic]);
    // 不撥時鐘：還在快取期限內，清單不會有新圖（伺服器的行為：最多每分鐘重掃一次）
    const stale = await sc.listPics(env);
    const seenBeforeTtl = stale.list.includes(newPic);
    offset += RESCAN_AFTER_MS;
    const s2 = await sc.listPics(env);
    const run2 = countPicks(s2.list, ids, dates);
    const stats = summarize(s2.list, run2);
    const newCount = run2.counts.get(newPic) || 0;
    const after = {
      list: s2.list, run: run2, stats, newPic,
      newCount, newShare: newCount / run2.total, newSigma: sigmaOf(newCount, run2.total, s2.list.length),
      seenBeforeTtl, seenAfterTtl: s2.list.includes(newPic)
    };
    return { before, after };
  } finally {
    Date.now = realNow;
    await sc._resetForTests();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── 命令列 ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = { pics: 53, days: 365, add: 'last', verbose: false, dir: '', verses: '', syntheticVerses: 467 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--pics') o.pics = parseInt(next(), 10);
    else if (a === '--days') o.days = parseInt(next(), 10);
    else if (a === '--add') o.add = next();
    else if (a === '--dir') o.dir = next();
    else if (a === '--verses') o.verses = next();
    else if (a === '--synthetic-verses') o.syntheticVerses = parseInt(next(), 10);
    else if (a === '--verbose' || a === '-v') o.verbose = true;
    else if (a === '-h' || a === '--help') { o.help = true; }
    else throw new Error(`不認得的參數：${a}`);
  }
  return o;
}

/** 照 scanPics 的規則（遞迴、略過隱藏、只收 jpg/png/webp）列出資料夾裡的圖檔相對路徑。 */
function listRealNames(dir) {
  const out = [];
  (function walk(abs, rel) {
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      if (ent.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(path.join(abs, ent.name), childRel);
      else if (ent.isFile() && /\.(jpe?g|png|webp)$/i.test(ent.name)) out.push(childRel);
    }
  })(dir, '');
  return out;
}

const pct = (x) => `${(x * 100).toFixed(3)}%`;

function printRun(title, list, run, stats, verbose) {
  console.log(`\n== ${title} ==`);
  console.log(`圖 ${list.length} 張，共挑 ${run.total} 次（每張期望 ${stats.expected.toFixed(1)} 次 = ${pct(1 / list.length)}）`);
  console.log(`最少 ${stats.min} 次、最多 ${stats.max} 次；卡方 χ²=${stats.chi2.toFixed(1)}（自由度 ${stats.df}，z=${stats.z.toFixed(2)}，p=${stats.p.toFixed(3)}）`);
  console.log(`清單前半 ${pct(stats.firstHalfShare)}（期望 ${pct(stats.expectedFirstHalfShare)}）`);
  if (run.none) console.log(`⚠ ${run.none} 次沒挑到圖`);
  if (verbose) {
    list.forEach((p, i) => {
      const c = run.counts.get(p) || 0;
      console.log(`  ${String(i + 1).padStart(3)}  ${String(c).padStart(7)}  ${pct(c / run.total)}  ${sigmaOf(c, run.total, list.length) >= 0 ? '+' : ''}${sigmaOf(c, run.total, list.length).toFixed(2)}σ  ${p}`);
    });
  }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); return; }
  const names = o.dir ? listRealNames(path.resolve(o.dir)) : fakePicNames(o.pics);
  if (!names.length) throw new Error('圖庫是空的');
  const ids = o.verses ? verseIdsFromMarkdown(path.resolve(o.verses)) : syntheticVerseIds(o.syntheticVerses);
  const dates = dateRange(o.days);
  console.log(`圖庫：${o.dir ? o.dir : '假圖'} → ${names.length} 張；經句：${ids.length} 句（${o.verses ? '真的' : '合成'}）；日期：${dates.length} 天；新圖放：${o.add}`);

  const { before, after } = await simulate({ names, ids, dates, add: o.add });
  printRun('新增前', before.list, before.run, before.stats, o.verbose);
  console.log(`\n新增 ${after.newPic}`);
  console.log(`  不到 1 分鐘（還在快取期限內）清單看得到新圖嗎？ ${after.seenBeforeTtl ? '是' : '否（符合預期：最多每分鐘重掃一次）'}`);
  console.log(`  超過 1 分鐘後清單看得到新圖嗎？ ${after.seenAfterTtl ? '是' : '否 ⚠'}`);
  printRun('新增後', after.list, after.run, after.stats, o.verbose);
  const expected = 1 / after.list.length;
  console.log(`\n新圖被挑中 ${after.newCount} 次 = ${pct(after.newShare)}；期望 1/${after.list.length} = ${pct(expected)}；差 ${after.newSigma >= 0 ? '+' : ''}${after.newSigma.toFixed(2)}σ`);
  const perCard = after.newShare;
  console.log(`換一句看到這張新圖的機率每次約 ${pct(perCard)}，平均要換約 ${Math.round(1 / perCard)} 次才會看到一次。`);
  const bad = after.stats.p < 0.001 || Math.abs(after.newSigma) > 4 || !after.seenAfterTtl;
  console.log(bad ? '\n結論：⚠ 不平均' : '\n結論：✓ 每張圖（含新增的）被挑中的機率一樣');
  if (bad) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(err => { console.error(err.message || err); process.exit(2); });
}

module.exports = {
  normalCdf, chiSquare, syntheticVerseIds, verseIdsFromMarkdown, dateRange, fakePicNames, buildLibrary,
  newPicName, countPicks, summarize, sigmaOf, simulate, listRealNames, RESCAN_AFTER_MS
};
