/**
 * @file lib/kepan.js — 從講記標題抽取科判樹（v4.20.0）
 *
 * 長老講記把科判寫在標題裡，一行可能含多層：
 *   `## 甲一、本地分（分二科）  乙一、略辨地名（分二科）  丙一、徵`
 * Markdown 的 # 數最多六級，科判卻可深達四十層，所以層級一律依「甲乙…→子丑…→天地玄黃…」
 * 的字序判斷，不看 # 數。同一科常跨卷延續（下一卷開頭重述上一卷最後的科），
 * 因此整個資料夾的講記要依序串起來，建成一棵樹。
 *
 * 字序會重複用字（「辰」既是地支也在「日月盈昃辰宿列張」裡），原文也有誤植（「巳」寫成「己」、
 * 「已」）。pickDepth() 依編號是否能接續上一科來決定層級，接不上時改依編號就近接續，
 * 並把可疑處記在 problems 裡，供校對。
 *
 * 產出的樹只含科名與位置，不含內文；閱讀框照常載入原檔，側欄依行號定位。
 */

const fs = require('fs');
const path = require('path');
const { stripFrontmatter } = require('./markdown.js');

/** 科判層級字序：十干、十二支、千字文。索引即層級（0 起算）。 */
const LEVELS = Object.freeze([
  ...'甲乙丙丁戊己庚辛壬癸', ...'子丑寅卯辰巳午未申酉戌亥',
  ...'天地玄黃宇宙洪荒', ...'日月盈昃辰宿列張', ...'寒來暑往秋收冬藏',
]);
/** 常見誤植字 → 正字 */
const ALIAS = Object.freeze({ '已': '巳' });
/** 至少要有這麼多科，才把一個資料夾當成科判系列，避免一般文章的「甲、乙」被誤判。 */
const MIN_NODES = 30;

const NUM = '[一二三四五六七八九十]+';
const LV = '[' + [...new Set([...LEVELS, ...Object.keys(ALIAS)])].join('') + ']';
const SEG = new RegExp(`^(${LV})(${NUM})、?(.+?)(?:（分(${NUM})科）)?$`);
const SPLIT = new RegExp(`[\\s\\u3000]+(?=${LV}${NUM}、?)|(?<=科）)(?=${LV}${NUM}、)`);
const HEADING = /^#{1,6}\s+(.*)$/;

const CN = { '〇': 0, '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };

/**
 * 中文數字轉數字：「十一」=11、「一〇三」=103、「二百一十」=210。
 * @param {string} s
 * @returns {number}
 */
function cnNum(s) {
  if (/^\d+$/.test(s)) return Number(s);
  if (!/[十百]/.test(s)) return Number([...s].map(c => CN[c] ?? '').join('')) || 0;
  let total = 0, cur = 0;
  for (const c of s) {
    if (c === '百') { total += (cur || 1) * 100; cur = 0; }
    else if (c === '十') { total += (cur || 1) * 10; cur = 0; }
    else cur = CN[c] ?? 0;
  }
  return total + cur;
}

const depthsOf = ch => LEVELS.flatMap((c, i) => (c === (ALIAS[ch] || ch) ? [i] : []));

/**
 * 把一行標題拆成科判段落。不是科判標題時回傳空陣列。
 * @param {string} line - 原始一行（含 #）
 * @returns {{ ch: string, num: number, numText: string, title: string, split: number }[]}
 */
function parseHeadingSegments(line) {
  const h = String(line).replace(/ /g, ' ').match(HEADING);
  if (!h) return [];
  const out = [];
  for (const raw of h[1].trim().split(SPLIT)) {
    const m = raw.trim().match(SEG);
    if (!m) continue;
    const title = m[3].replace(/[。．.，、：；\s]+$/, '');
    // 講解文字誤用標題格式（如「巳一、『標』。巳二、…」）：含引號或句號的長句不是科名
    if (!/^[^「」『』。；？]{1,30}$/.test(title)) continue;
    out.push({ ch: ALIAS[m[1]] || m[1], num: cnNum(m[2]), numText: m[2], title, split: m[4] ? cnNum(m[4]) : 0 });
  }
  return out;
}

/** 把檔名自然排序：T2 在 T10 之前，T74A 在 T74B 之前。 */
function naturalCompare(a, b) {
  return a.localeCompare(b, 'zh-Hant', { numeric: true });
}

/**
 * 決定講記的閱讀順序：資料夾裡有「總目錄」就依其中 [[連結]] 的先後，否則依檔名自然排序。
 * @param {string[]} names - 不含副檔名的檔名
 * @param {string|null} tocText - 總目錄內文
 * @returns {string[]}
 */
function orderFiles(names, tocText) {
  const set = new Set(names);
  const ordered = [];
  if (tocText) {
    for (const m of tocText.matchAll(/\[\[([^\]|#]+)/g)) {
      const n = m[1].trim().replace(/\.md$/i, '');
      if (set.has(n) && !ordered.includes(n)) ordered.push(n);
    }
  }
  const rest = names.filter(n => !ordered.includes(n)).sort(naturalCompare);
  return ordered.concat(rest);
}

/**
 * 由依序排好的講記建出科判樹。
 *
 * @param {{ name: string, text: string }[]} docs - 依閱讀順序排列的講記（name 不含副檔名）
 * @param {{ title?: string }} [opts]
 * @returns {{
 *   title: string,
 *   files: string[],
 *   nodes: { id: number, p: number, d: number, m: string, n: number, t: string, k: number[],
 *            s?: number, pg?: number, f?: number, l?: number }[],
 *   heads: Object<number, number[][]>,
 *   problems: string[]
 * }}
 *   nodes[0] 是虛擬根；f/l 是該科第一次出現的檔案索引與原檔行號；
 *   heads[檔案索引] = [[行號, 該行最深的科], …]，供閱讀時把捲動位置對回科目。
 */
function buildKepanTree(docs, opts = {}) {
  const nodes = [{ id: 0, p: -1, d: -1, m: '', n: 0, t: opts.title || '', k: [] }];
  const heads = {};
  const problems = [];
  let stack = [];
  let page = 0;

  function pickDepth(ch, num, where) {
    const cands = depthsOf(ch);
    if (!cands.length) return -1;
    const ok = cands.filter(d => {
      if (d > stack.length) return false;
      if (num === 1) return d === 0 || stack[d - 1] !== undefined;
      const prev = stack[d];
      return prev !== undefined && (nodes[prev].n === num - 1 || nodes[prev].n === num);
    });
    if (ok.length) return Math.max(...ok);
    // 層級字接不上，多半是誤植（巳寫成己）：改依編號接在最近的同號前一科之後
    for (let d = stack.length - 1; d >= Math.max(0, stack.length - 4); d--) {
      if (num > 1 && stack[d] !== undefined && nodes[stack[d]].n === num - 1) {
        problems.push(`${where}：「${ch}${num}」層級字與上下文不合，依編號接在「${nodes[stack[d]].m}」之後`);
        return d;
      }
    }
    if (num === 1) {
      problems.push(`${where}：「${ch}${num}」層級字與上下文不合，暫作上一科的子科`);
      return stack.length;
    }
    problems.push(`${where}：「${ch}${num}」找不到可接續的上層，暫依最近層級放置`);
    const fallback = cands.filter(d => d <= stack.length);
    return fallback.length ? Math.max(...fallback) : stack.length;
  }

  docs.forEach((doc, fi) => {
    const text = String(doc.text || '');
    const src = text.match(/^source:\s*"(.*)"/m);
    const sp = src && src[1].match(/披尋記》\s*(?:Page|P|p\.?)?\s*(\d+)/);
    if (sp) page = Number(sp[1]);
    const { body, lineOffset } = stripFrontmatter(text);
    const lines = body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const pm = line.match(/^《披尋記》\s*([〇零一二三四五六七八九十百\d]+)\s*頁/);
      if (pm) { page = cnNum(pm[1]) || page; continue; }
      const segs = parseHeadingSegments(line);
      if (!segs.length) continue;
      const ln = lineOffset + i + 1;
      let deepest = -1;
      for (const seg of segs) {
        const d = pickDepth(seg.ch, seg.num, `${doc.name}:${ln}`);
        if (d < 0) continue;
        const existing = stack[d];
        if (existing !== undefined && nodes[existing].n === seg.num && nodes[existing].t === seg.title) {
          stack = stack.slice(0, d + 1);      // 跨卷重述同一科
          deepest = existing;
          continue;
        }
        const parent = d === 0 ? 0 : (stack[d - 1] ?? 0);
        const node = { id: nodes.length, p: parent, d, m: seg.ch + seg.numText, n: seg.num, t: seg.title, k: [], f: fi, l: ln };
        if (seg.split) node.s = seg.split;
        if (page) node.pg = page;
        nodes.push(node);
        nodes[parent].k.push(node.id);
        stack = stack.slice(0, d);
        stack[d] = node.id;
        deepest = node.id;
      }
      if (deepest > 0) (heads[fi] ||= []).push([ln, deepest]);
    }
  });

  for (const n of nodes) {
    if (n.s && n.s !== n.k.length) {
      problems.push(`${n.f !== undefined ? docs[n.f].name : ''}：${n.m}、${n.t} 標「分${n.s}科」，實際有 ${n.k.length} 個子科`);
    }
  }
  return { title: opts.title || '', files: docs.map(d => d.name), nodes, heads, problems };
}

/**
 * 給前端的精簡格式：每科一個陣列 [父, 層級字號, 科名, 披尋記頁, 檔案索引, 行號]，
 * 子科與層級由前端依父科重建，傳輸量約為完整物件的一半。
 * @param {ReturnType<typeof buildKepanTree>} tree
 */
function toClientPayload(tree, dirRel) {
  return {
    dir: dirRel,
    title: tree.title,
    files: tree.files,
    heads: tree.heads,
    nodes: tree.nodes.slice(1).map(n => [n.p, n.m, n.t, n.pg || 0, n.f ?? -1, n.l || 0]),
    problems: tree.problems.length,
  };
}

/** 資料夾 → { sig, payload|null }。sig 以檔案數與最新修改時間組成，檔案一改就重建。 */
const cache = new Map();

/**
 * 取得某個講記所在資料夾的科判樹；資料夾不是科判系列時回傳 null。
 * 只看同一層的 .md 檔（子資料夾如「卷分QA」不算）。
 *
 * @param {string} mdRoot - 經庫根目錄
 * @param {string} relFile - 講記相對於 mdRoot 的路徑
 * @returns {Promise<object|null>} toClientPayload() 的結果
 */
async function getKepanForFile(mdRoot, relFile) {
  const dirRel = path.posix.dirname(relFile.split(path.sep).join('/'));
  const dirAbs = path.join(mdRoot, dirRel);
  let entries;
  try {
    entries = await fs.promises.readdir(dirAbs, { withFileTypes: true });
  } catch (_) {
    return null;
  }
  const mdFiles = entries.filter(e => e.isFile() && /\.md$/i.test(e.name) && !e.name.startsWith('.'));
  const stats = await Promise.all(mdFiles.map(e => fs.promises.stat(path.join(dirAbs, e.name)).catch(() => null)));
  const sig = mdFiles.length + ':' + Math.max(0, ...stats.map(s => (s ? s.mtimeMs : 0)));
  const hit = cache.get(dirAbs);
  if (hit && hit.sig === sig) return hit.payload;

  const names = mdFiles.map(e => e.name.replace(/\.md$/i, ''));
  const tocName = names.find(n => n.includes('總目錄') || n.includes('目錄'));
  const texts = new Map();
  await Promise.all(names.map(async n => {
    texts.set(n, await fs.promises.readFile(path.join(dirAbs, n + '.md'), 'utf8').catch(() => ''));
  }));
  const order = orderFiles(names.filter(n => n !== tocName), tocName ? texts.get(tocName) : null);
  const title = path.posix.basename(dirRel);
  const tree = buildKepanTree(order.map(n => ({ name: n, text: texts.get(n) })), { title });
  const payload = tree.nodes.length - 1 >= MIN_NODES ? toClientPayload(tree, dirRel) : null;
  cache.set(dirAbs, { sig, payload });
  return payload;
}

/** 測試用：清空快取 */
function clearKepanCache() {
  cache.clear();
}

module.exports = {
  LEVELS,
  MIN_NODES,
  cnNum,
  parseHeadingSegments,
  orderFiles,
  buildKepanTree,
  toClientPayload,
  getKepanForFile,
  clearKepanCache,
};
