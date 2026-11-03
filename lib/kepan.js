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
 *
 * 多講輪（v4.25.0）：同一部經論講過多次時，各輪的科判各自成樹，不串在一起。
 *   - 講記 frontmatter `round: "1996 法雲寺"`：同一輪寫同一個值，依此分組，每輪一棵樹。
 *   - 總目錄 frontmatter `kepan:`：true 一定當科判系列；false 不顯示科判；
 *     per-file 是多場講學的合輯，每篇各自一棵樹；沒寫就依科數自動判定（≥ MIN_NODES）。
 *   - 單篇 frontmatter `kepan: false`：這篇不算（例：講義原文）。
 *   - 兩輪的科判相同處（從根到該科的科判字與科名都一樣）互相連結，閱讀時可跳到另一輪的同一科。
 *   - 章節式標題（第一章／第一節／第一項／甲、／一、）另行解析，例：攝論 1996 年講記。
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
/** 總目錄寫明 kepan: true／per-file 時，每棵樹只要有這麼多科就顯示。 */
const MIN_NODES_FORCED = 5;

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

/** 章節式標題的層級：章 → 節 → 項 → 甲、乙、 → 一、二、 */
const CH_RANK = { '章': 0, '節': 1, '項': 2 };
const STEMS = '甲乙丙丁戊己庚辛壬癸';

/**
 * 章節式標題（「第一章、序說」「第二節、攝大乘」「甲、總標」「一、引經」）。不是時回傳 null。
 * @param {string} line - 原始一行（含 #）
 * @returns {{ rank: number, m: string, n: number, t: string }|null}
 */
function parseChapterHeading(line) {
  const h = String(line).replace(/ /g, ' ').match(HEADING);
  if (!h) return null;
  const text = h[1].trim();
  let m = text.match(/^第([〇零一二三四五六七八九十百]+)(章|節|項)[、．.\s\u3000]*(.*)$/);
  let out = null;
  if (m) out = { rank: CH_RANK[m[2]], m: `第${m[1]}${m[2]}`, n: cnNum(m[1]), t: m[3] };
  else if ((m = text.match(new RegExp(`^([${STEMS}])、(.+)$`)))) out = { rank: 3, m: m[1], n: STEMS.indexOf(m[1]) + 1, t: m[2] };
  else if ((m = text.match(/^([一二三四五六七八九十]+)、(.+)$/))) out = { rank: 4, m: m[1], n: cnNum(m[1]), t: m[2] };
  if (!out) return null;
  out.t = out.t.replace(/[。．.，、：；\s]+$/, '');
  if (out.rank > 2 && !/^[^「」『』。；？]{1,30}$/.test(out.t)) return null;
  if (out.t.length > 40) return null;
  return out;
}

/** 這組講記用章節式標題（第X章／節／項）而不是甲乙科判字。 */
function usesChapters(docs) {
  let ch = 0, kp = 0;
  for (const d of docs) {
    for (const line of String(d.text || '').split('\n')) {
      if (!line.startsWith('#')) continue;
      const c = parseChapterHeading(line);
      if (c && c.rank <= 2) ch++;
      else if (parseHeadingSegments(line).length) kp++;
    }
  }
  return ch >= 5 && ch > kp;
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
  if (opts.chapters ?? usesChapters(docs)) return buildChapterTree(docs, opts);
  const nodes = [{ id: 0, p: -1, d: -1, m: '', n: 0, t: opts.title || '', k: [] }];
  const heads = {};
  const problems = [];
  let stack = [];
  let page = 0;

  function pickDepth(ch, num, where) {
    const cands = depthsOf(ch);
    if (!cands.length) return -1;
    if (!stack.length && cands[0] > 0) {
      // 單篇講記常從中間某層講起（如從「丙一」開始）：上面幾層以虛擬根（0）補齊，不算誤植
      stack = new Array(cands[0]).fill(0);
      return cands[0];
    }
    const ok = cands.filter(d => {
      if (d > stack.length) return false;
      if (num === 1) return d === 0 || stack[d - 1] !== undefined;
      const prev = stack[d];
      return prev !== undefined && (prev === 0 || nodes[prev].n === num - 1 || nodes[prev].n === num);
    });
    if (ok.length) return Math.max(...ok);
    // 層級字接不上，多半是誤植（巳寫成己）：改依編號接在最近的同號前一科之後
    for (let d = stack.length - 1; d >= Math.max(0, stack.length - 4); d--) {
      if (num > 1 && stack[d] && nodes[stack[d]].n === num - 1) {
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
        if (existing && nodes[existing].n === seg.num && nodes[existing].t === seg.title) {
          stack = stack.slice(0, d + 1);      // 跨卷重述同一科
          deepest = existing;
          continue;
        }
        const parent = d === 0 ? 0 : (stack[d - 1] ?? 0);
        const node = { id: nodes.length, p: parent, d: nodes[parent].d + 1, m: seg.ch + seg.numText, n: seg.num, t: seg.title, k: [], f: fi, l: ln };
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
 * 章節式標題建樹：依「章 → 節 → 項 → 甲、 → 一、」的位階，較低位階接在最近的較高位階之下。
 * 回傳格式同 buildKepanTree。
 */
function buildChapterTree(docs, opts = {}) {
  const nodes = [{ id: 0, p: -1, d: -1, m: '', n: 0, t: opts.title || '', k: [] }];
  const heads = {};
  let stack = [];   // [{ rank, id }]
  docs.forEach((doc, fi) => {
    const { body, lineOffset } = stripFrontmatter(String(doc.text || ''));
    const lines = body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const c = parseChapterHeading(lines[i]);
      if (!c) continue;
      const ln = lineOffset + i + 1;
      const same = stack.findIndex(e => e.rank === c.rank && nodes[e.id].m === c.m && nodes[e.id].t === c.t);
      if (same >= 0) {          // 跨卷重述同一章節
        stack = stack.slice(0, same + 1);
        (heads[fi] ||= []).push([ln, stack[same].id]);
        continue;
      }
      while (stack.length && stack[stack.length - 1].rank >= c.rank) stack.pop();
      const parent = stack.length ? stack[stack.length - 1].id : 0;
      const node = { id: nodes.length, p: parent, d: nodes[parent].d + 1, m: c.m, n: c.n, t: c.t, k: [], f: fi, l: ln };
      nodes.push(node);
      nodes[parent].k.push(node.id);
      stack.push({ rank: c.rank, id: node.id });
      (heads[fi] ||= []).push([ln, node.id]);
    }
  });
  return { title: opts.title || '', files: docs.map(d => d.name), nodes, heads, problems: [], chapters: true };
}

/**
 * 側欄下拉選單的範圍層級：最淺而至少有 4 科的一層，最深到丙層（2）。
 * 瑜伽師地論本地分是丙層（十七地）；攝論 1996 是章。
 */
function pickScopeDepth(nodes) {
  const count = [0, 0, 0];
  for (const n of nodes) if (n.d >= 0 && n.d < 3) count[n.d]++;
  for (let d = 0; d < 2; d++) if (count[d] >= 4) return d;
  return 2;
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
    scopeDepth: pickScopeDepth(tree.nodes),
    ...(tree.chapters ? { chapters: true } : {}),
  };
}

/** frontmatter 的 kepan 值：true／false／'per-file'；沒寫或看不懂為 undefined。 */
function kepanFlag(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'true' || s === 'yes') return true;
  if (s === 'false' || s === 'no') return false;
  if (s === 'per-file' || s === 'perfile' || s === 'file') return 'per-file';
  return undefined;
}

/**
 * 把講記分成各自成樹的組。
 *   per-file：每篇一組（合輯）。
 *   有任何一篇寫了 round：同 round 同一組（依第一次出現的順序），沒寫 round 的各自一組。
 *   都沒寫：整個資料夾一組（舊行為）。
 * @param {string[]} order - 依閱讀順序的檔名
 * @param {Map<string, object>} fm - 檔名 → frontmatter
 * @param {*} mode - kepanFlag(總目錄 kepan)
 * @returns {{ label: string, names: string[], perFile: boolean }[]}
 */
function groupFiles(order, fm, mode) {
  const titleOf = n => (fm.get(n) || {}).title || n;
  if (mode === 'per-file') return order.map(n => ({ label: titleOf(n), names: [n], perFile: true }));
  const roundOf = n => String((fm.get(n) || {}).round || '').trim();
  if (!order.some(roundOf)) return [{ label: '', names: order.slice(), perFile: false }];
  const groups = [], byLabel = new Map();
  for (const n of order) {
    const r = roundOf(n);
    if (!r) { groups.push({ label: titleOf(n), names: [n], perFile: true }); continue; }
    if (!byLabel.has(r)) { const g = { label: r, names: [], perFile: false }; byLabel.set(r, g); groups.push(g); }
    byLabel.get(r).names.push(n);
  }
  return groups;
}

/**
 * 對照用的科名：去掉括號內的補充、「分N科」與句尾的科數（「序分(分二科)」「序分二」都是「序分」），
 * 再去空白標點。各輪記錄的寫法不一，科判字也常有誤植，所以只比科名。
 */
const keyText = s => String(s || '')
  .replace(/[（(][^（）()]*[）)]/g, '')
  .replace(/分[一二三四五六七八九十]+科/g, '')
  .replace(/[\s\u3000]*[一二三四五六七八九十]+$/, '')
  .replace(/[\s\u3000、，。；：（）()．.]+/g, '');

/** 每科的對照鍵：從根到該科的科名。兩輪的鍵相同，就是同一科。 */
function nodeKeys(nodes) {
  const keys = [''];
  for (let i = 1; i < nodes.length; i++) {
    const n = nodes[i];
    keys[i] = keys[n.p] + '/' + keyText(n.t);
  }
  return keys;
}

/**
 * 各輪之間的對照（另講）：alt[本輪科 id] = [[輪次, 檔名, 行號, 該輪科 id], …]。
 * @param {{ tree: object }[]} rounds
 */
function linkRounds(rounds) {
  // 主鍵：從根到該科的完整路徑。各輪開頭常不同（序分的分法、從哪一層講起），
  // 所以另用「上一科＋本科」的短鍵：在兩輪裡都只出現一次時，也算同一科。
  const keyMaps = rounds.map(r => {
    const nodes = r.tree.nodes, keys = nodeKeys(nodes), first = new Map();
    keys.forEach((k, id) => { if (id && !first.has(k)) first.set(k, id); });
    const short = [''], count = new Map(), byShort = new Map();
    for (let id = 1; id < nodes.length; id++) {
      const n = nodes[id], par = nodes[n.p];
      short[id] = keyText(par.t) + '/' + keyText(n.t);
      count.set(short[id], (count.get(short[id]) || 0) + 1);
      byShort.set(short[id], id);
    }
    return { keys, first, short, count, byShort };
  });
  const findIn = (oi, ri, id) => {
    const a = keyMaps[ri], b = keyMaps[oi];
    const hit = b.first.get(a.keys[id]);
    if (hit) return hit;
    const k = a.short[id];
    return a.count.get(k) === 1 && b.count.get(k) === 1 ? b.byShort.get(k) : 0;
  };
  return rounds.map((r, ri) => {
    const alt = {};
    const { keys } = keyMaps[ri];
    for (let id = 1; id < keys.length; id++) {
      const hits = [];
      rounds.forEach((o, oi) => {
        if (oi === ri) return;
        const tid = findIn(oi, ri, id);
        if (!tid) return;
        const tn = o.tree.nodes[tid];
        hits.push([oi, o.tree.files[tn.f], tn.l, tid]);
      });
      if (hits.length) alt[id] = hits;
    }
    return alt;
  });
}

/** 資料夾 → { sig, byFile: Map<檔名, payload> }。sig 以檔案數與最新修改時間組成，檔案一改就重建。 */
const cache = new Map();

/**
 * 建出一個資料夾所有的科判樹（每輪一棵、合輯每篇一棵），回傳 檔名 → 該檔所屬的那棵樹。
 * @param {string} dirRel
 * @param {Map<string, string>} texts - 檔名 → 內文
 * @returns {Map<string, object>}
 */
function buildFolder(dirRel, texts) {
  const byFile = new Map();
  const names = [...texts.keys()];
  const fm = new Map(names.map(n => [n, stripFrontmatter(texts.get(n)).frontmatter || {}]));
  const tocName = names.find(n => n.includes('總目錄')) || names.find(n => n.includes('目錄'));
  const mode = tocName ? kepanFlag(fm.get(tocName).kepan) : undefined;
  if (mode === false) return byFile;
  const order = orderFiles(names.filter(n => n !== tocName), tocName ? texts.get(tocName) : null)
    .filter(n => kepanFlag(fm.get(n).kepan) !== false);
  const folder = path.posix.basename(dirRel);
  const min = mode === undefined ? MIN_NODES : MIN_NODES_FORCED;
  const built = [];
  for (const g of groupFiles(order, fm, mode)) {
    const title = g.perFile ? g.label : (g.label ? `${folder}・${g.label}` : folder);
    const tree = buildKepanTree(g.names.map(n => ({ name: n, text: texts.get(n) })), { title });
    if (tree.nodes.length - 1 >= min) built.push({ group: g, tree });
  }
  // 講輪（同一部經論的幾次宣講）才有切換與對照；合輯的各篇彼此無關
  const rounds = built.filter(b => !b.group.perFile);
  const alts = rounds.length > 1 ? linkRounds(rounds) : [];
  const roundList = rounds.length > 1
    ? rounds.map(b => ({ label: b.group.label, file: b.tree.files[0], n: b.tree.nodes.length - 1 }))
    : null;
  for (const b of built) {
    const payload = toClientPayload(b.tree, dirRel);
    payload.key = dirRel + (b.group.perFile ? '#' + b.tree.files[0] : b.group.label ? '#' + b.group.label : '');
    if (!b.group.perFile && b.group.label) payload.round = b.group.label;
    const ri = rounds.indexOf(b);
    if (roundList && ri >= 0) {
      payload.rounds = roundList;
      payload.roundIndex = ri;
      payload.alt = alts[ri];
    }
    for (const n of b.tree.files) byFile.set(n, payload);
  }
  // 總目錄頁也顯示科判（有講輪時顯示第一輪，可從講輪切換）
  const main = rounds[0] || null;
  if (tocName && main && mode !== 'per-file') byFile.set(tocName, byFile.get(main.tree.files[0]));
  return byFile;
}

/**
 * 取得某個講記所屬的科判樹；不屬於任何科判樹時回傳 null。
 * 只看同一層的 .md 檔（子資料夾如「卷分QA」不算）。
 *
 * @param {string} mdRoot - 經庫根目錄
 * @param {string} relFile - 講記相對於 mdRoot 的路徑
 * @returns {Promise<object|null>} toClientPayload() 的結果，另加 key、round、rounds、roundIndex、alt
 */
async function getKepanForFile(mdRoot, relFile) {
  const relPosix = relFile.split(path.sep).join('/');
  const dirRel = path.posix.dirname(relPosix);
  const name = path.posix.basename(relPosix).replace(/\.md$/i, '');
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
  if (hit && hit.sig === sig) return hit.byFile.get(name) || null;

  const names = mdFiles.map(e => e.name.replace(/\.md$/i, ''));
  const texts = new Map();
  await Promise.all(names.map(async n => {
    texts.set(n, await fs.promises.readFile(path.join(dirAbs, n + '.md'), 'utf8').catch(() => ''));
  }));
  const byFile = buildFolder(dirRel, new Map(names.map(n => [n, texts.get(n)])));
  cache.set(dirAbs, { sig, byFile });
  return byFile.get(name) || null;
}

/** 測試用：清空快取 */
function clearKepanCache() {
  cache.clear();
}

module.exports = {
  LEVELS,
  MIN_NODES,
  MIN_NODES_FORCED,
  parseChapterHeading,
  usesChapters,
  buildChapterTree,
  pickScopeDepth,
  kepanFlag,
  groupFiles,
  linkRounds,
  buildFolder,
  cnNum,
  parseHeadingSegments,
  orderFiles,
  buildKepanTree,
  toClientPayload,
  getKepanForFile,
  clearKepanCache,
};
