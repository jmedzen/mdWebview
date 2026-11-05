/**
 * @file scripts/gen-sidecar.js
 *
 * 逐句註疏對位（alpha 批次 9）。
 *
 * ── 這是什麼
 *
 * 古代註疏家講經有個固定格式：先引一句經文，再解釋那一句。
 *
 *   「如是我聞」者，親承金口，而聞事非謬也。
 *   「一時」者，言則當理，理亦如言…
 *   「爾時，世尊」下明別序。
 *
 * 引號裡是經文，引號後面是解釋。把引文對回底本的位置，就得到
 * 「這一段經文，這位註疏家這樣讀」——而且可以同時擺好幾位。
 *
 * ── 為什麼不用字串完全比對
 *
 * 一開始我用「引文是否原封不動出現在經文裡」判斷，命中率 69%，看似可用，
 * 但跨註疏只湊出 17 句共註。原因是每個人引的長度不一樣：
 * 智者引「一時」，吉藏引「一時，佛在舍衛國」，宗密引更長的一句——
 * 字串不同，講的卻是同一處。
 *
 * 所以改用「位置」：引文在經文裡的起點。起點相距 12 字以內視為同一處，
 * 聚成一類。金剛經從 17 句共註變成 96 處裡有 38 處共註。
 *
 * ── 輸出格式
 *
 * sidecar-data.js：
 *   { base: 'T0235', text: 正規化經文, loci: [{p:起點, notes:[{by,era,t}]}] }
 *
 * `p` 是「正規化經文」（去空白）裡的索引。前端用同一套正規化就能對上。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const COMMENTARY_DATA = path.join(ROOT, 'commentary-data.js');

/** 引文起點相距這麼多字以內，算同一處。 */
const LOCUS_GAP = 12;

/** 每一處最多留幾位註疏家（超過就取前幾位，避免單點爆炸）。 */
const MAX_NOTES_PER_LOCUS = 6;

/** 單一註解最多留幾個字。 */
const MAX_NOTE_CHARS = 320;

/**
 * CBETA 檔頭去掉：`//` 註解行與 `No. NNN` 那一行。
 * 只去檔頭，不動內文——內文也可能有 `//` 開頭的行嗎？沒有，
 * CBETA 的 `//` 全部在檔頭。
 */
function cleanCbeta(raw) {
  return raw.split('\n')
    .filter(l => l.trim() && !l.startsWith('//'))
    .filter(l => !/^No\.\s*\d/.test(l.trim()))
    .join('\n');
}

/**
 * 正規化：去掉所有空白。
 *
 * 中文本來就不靠空白分詞，而 CBETA 的換行、全角空格、行內縮排都會干擾
 * 比對。前後端必須用同一套規則，否則索引對不上。
 */
function normalize(s) {
  return s.replace(/[\s\u3000]+/g, '');
}

/** 讀 commentary-data.js 裡的組別資料（不重跑整個掃描）。 */
function loadFamilies() {
  const src = fs.readFileSync(COMMENTARY_DATA, 'utf8');
  const g = {};
  new Function('window', src.replace(
    '})(typeof window !== \'undefined\' ? window : this);', '})(window);'))(g);
  return g.CommentaryData.families;
}

/**
 * 從一部註疏抽出「引文 → 解釋」。
 *
 * 格式不是一律 `「…」解釋`。實際看過的情況：
 *
 *   「如是」者，佛所說。           ← 引文後接「者」
 *   「爾時，世尊」下明別序。        ← 引文後接「下」
 *   「一時」者，言則當理…          ← 一般情況
 *
 * 所以引文後面那一段，先剝掉開頭的「者，」「下」「中」「云」這些
 * 轉接詞，再取到第一個句號為止。
 *
 * 解釋太短（少於 6 字）就不要——那多半是「是果，此之因果同約實相」這種
 * 殘句，硬留下來只會讓面板裡塞滿看不懂的片段。
 */
function extractNotes(text) {
  const out = [];
  const re = /「([^」]{2,80})」([^「]{0,600})/g;
  let m;
  while ((m = re.exec(text))) {
    const quote = normalize(m[1]);
    if (quote.length < 2) continue;

    let tail = m[2];

    // 剝掉開頭的轉接詞（含標點）
    tail = tail.replace(/^[\s\u3000]*[者下中云謂，。、：；]+\s*/, '');

    // 取到第一個句尾標點
    const stop = tail.search(/[。！？]/);
    let note = stop >= 0 ? tail.slice(0, stop + 1) : tail;

    // 去掉引文裡殘留的引號與校勘符號
    note = note.replace(/[「」『』]/g, '').trim();
    if (note.length > MAX_NOTE_CHARS) note = note.slice(0, MAX_NOTE_CHARS);

    if (note.length < 6) continue;
    out.push({ quote, note });
  }
  return out;
}

/** 從署名行抽朝代（只給面板顯示，抽不到就留空）。 */
const ERA_RE = /^(後秦|姚秦|元魏|北魏|東魏|劉宋|蕭齊|南齊|梁|陳|隋|唐|後唐|宋|南宋|北宋|遼|金|元|明|清|民國|吳|西晉|東晉|晉|漢|後漢|前秦|北周|北齊)(?![朝])/;

function readEra(filePath) {
  let lines;
  try {
    lines = fs.readFileSync(filePath, 'utf8').split('\n');
  } catch (_) { return ''; }

  let titleSkipped = false;
  for (let i = 0; i < Math.min(lines.length, 20); i++) {
    let line = lines[i].trim();
    if (!line || line.startsWith('//')) continue;
    if (/^No\.\s*\d/.test(line)) continue;
    const isHeading = /^#{1,6}\s/.test(line);
    if (isHeading) line = line.replace(/^#{1,6}\s*/, '').trim();
    if (!titleSkipped) { titleSkipped = true; continue; }
    if (line.length > 34) continue;
    if (/[┌┬┐├┼┤└┴┘│─]/.test(line)) continue;
    const norm = line.replace(/[\u3000\s]+/g, '').trim();
    if (!/(撰|述|說|記|集|解|造|鈔|科)$/.test(norm)) continue;
    const m = norm.match(ERA_RE);
    if (m) return m[1];
  }
  return '';
}

/**
 * 把一部註疏的引文對回經文，聚成「處」。
 *
 * @returns {{loci: Array, stats: object}}
 */
function alignCommentary(sutraNorm, commentaryPath, who, era) {
  let raw;
  try { raw = fs.readFileSync(commentaryPath, 'utf8'); } catch (_) {
    return { loci: [], stats: { quotes: 0, hits: 0 } };
  }

  const notes = extractNotes(cleanCbeta(raw));
  const placed = [];
  let hits = 0;

  /*
   * 對位要「順著講」。
   *
   * 註疏是照經文順序講下來的：先講開頭，再講中間，最後講結尾。所以每一條
   * 引文只要找「上一次用到的位置之後」的第一次出現就好。
   *
   * 不這樣做的話，短引文會全部撞在第一個出現的地方。實測：吉藏用「如是」
   * 講「洗足已」那一段（「第四句，亦有五：一者、明洗塵累…」），但那條
   * 引文被指到經文開頭的「如是我聞」，於是「洗足」的解釋被掛在「如是」
   * 底下——面板上看起來就是對錯了。
   *
   * 允許一點回退（BACKTRACK）：註疏家有時會回頭補述，完全不給退路
   * 會把那些全丟掉。
   */
  const BACKTRACK = 400;
  /*
   * 短引文只能「就近」對位。
   *
   * 「如是」「須菩提」「何以故」在金剛經裡各出現 7 次。如果允許它們
   * 自由搜尋，每一條都會撞在第一個出現的位置，於是「洗足」的解釋被
   * 掛到「如是我聞」底下——這是我實際看到的錯。
   *
   * 規則：短於 SHORT_QUOTE 字的引文，只在游標附近 NEAR_WINDOW 字內找；
   * 找不到就放棄。長引文本身夠獨特，可以全域找。
   */
  const SHORT_QUOTE = 8;
  const NEAR_WINDOW = 600;

  let cursor = 0;

  for (const n of notes) {
    const isShort = n.quote.length < SHORT_QUOTE;
    let pos = -1;

    if (isShort) {
      // 只往前一點點找（講者會回頭補述，但不會跳很遠）
      const lo = Math.max(0, cursor - BACKTRACK);
      const hi = Math.min(sutraNorm.length, cursor + NEAR_WINDOW);
      const window = sutraNorm.slice(lo, hi);
      const found = window.indexOf(n.quote);
      if (found >= 0) pos = lo + found;
    } else {
      pos = sutraNorm.indexOf(n.quote, Math.max(0, cursor - BACKTRACK));
    }

    if (pos < 0) continue;
    hits++;
    placed.push({ pos, len: n.quote.length, quote: n.quote, note: n.note, who, era });
    cursor = Math.max(cursor, pos + 1);
  }

  /*
   * 聚類：依起點排序，起點差距在 LOCUS_GAP 以內就併。
   *
   * 併的時候「處的起點」取最小值——那是這一段經文的開頭，前端拿它
   * 對回 DOM 才不會偏掉。
   */
  placed.sort((a, b) => a.pos - b.pos);
  const clusters = [];
  for (const p of placed) {
    const last = clusters[clusters.length - 1];
    if (last && p.pos - last.maxEnd <= LOCUS_GAP) {
      last.items.push(p);
      last.maxEnd = Math.max(last.maxEnd, p.pos + p.len);
    } else {
      clusters.push({ pos: p.pos, maxEnd: p.pos + p.len, items: [p] });
    }
  }

  const loci = clusters.map(c => {
    // 同一位在同一處只留一則（取最長的那則，資訊最多）
    const byWho = {};
    for (const it of c.items) {
      const prev = byWho[it.who];
      if (!prev || it.note.length > prev.note.length) byWho[it.who] = it;
    }
    const notesOut = Object.values(byWho)
      .sort((a, b) => b.note.length - a.note.length)
      .slice(0, MAX_NOTES_PER_LOCUS)
      .map(it => ({ by: it.who, era: it.era, t: it.note }));
    /*
     * q 必須是「在 c.pos 這個位置上的那條引文」。
     *
     * quoteAt() 取的是最短引文——最短的最不容易跨段落被截斷，聽起來
     * 很合理，但它可能來自這處聚類裡比較晚的一筆，位置比 c.pos 後面。
     * 實測就是這樣壞的：p=19（如是）、q=一時（其實在 24），前端驗證
     * 一看就對不上。
     *
     * 正確做法：錨點那筆的引文。
     */
    const anchor = c.items.slice().sort((a, b) => a.pos - b.pos)[0];
    return { p: c.pos, q: String(anchor && (anchor.quote || '') || '').slice(0, 16), notes: notesOut };
  }).filter(l => l.notes.length > 0);

  return { loci, stats: { quotes: notes.length, hits } };
}

/* ── 主流程 ─────────────────────────────────────────────── */

function main() {
  const families = loadFamilies();
  const out = [];
  let totalLoci = 0, totalMulti = 0, totalNotes = 0;

  for (const fam of families) {
    /*
     * commentary-data.js 裡的 path 是相對 md/ 的（那是前端 /api/render 的
     * 慣例），產生器這邊要自己補上 md/ 前綴。
     */
    const sutraPath = path.join(ROOT, 'md', fam.base.path);
    let sutraRaw;
    try { sutraRaw = fs.readFileSync(sutraPath, 'utf8'); } catch (_) { continue; }
    const sutraNorm = normalize(cleanCbeta(sutraRaw));

    /*
     * 只做「有兩部以上註疏」且底本不太大的組。
     *
     * 底本超過 20 萬字（例如《大般若經》）時，引文索引幾乎必然誤中
     * 別處——同一個詞在四萬字裡出現十幾次是常態，取第一個命中就是錯的。
     * 那種規模需要更細的定位（卷、品），不是這一版要解決的問題。
     */
    if (sutraNorm.length > 200000) continue;

    // 把整組的引文合起來聚類（跨註疏共註就是這樣產生的）
    const merged = [];
    for (const c of fam.commentaries) {
      const p = path.join(ROOT, 'md', c.path);
      const era = readEra(p);
      const who = c.by || String(c.name).replace(/^T\d+《?/, '').replace(/》$/, '');
      const r = alignCommentary(sutraNorm, p, who, era);
      for (const l of r.loci) merged.push(l);
    }
    if (!merged.length) continue;

    merged.sort((a, b) => a.p - b.p);
    const clusters = [];
    for (const l of merged) {
      const last = clusters[clusters.length - 1];
      if (last && l.p - last.anchor <= LOCUS_GAP) {
        last.items.push(l);
      } else {
        clusters.push({ anchor: l.p, items: [l] });
      }
    }

    const loci = [];
    for (const c of clusters) {
      /*
       * 這一處的錨點：最早的那一筆。
       *
       * p 與 q 必須來自同一筆，否則就是拿 A 的位置配 B 的引文——實測
       * 抓到過：p 指向「如是」（位置 19），q 卻寫著「一時」（位置 24），
       * 前端驗證一看就對不上，22% 的對位因此失效。
       *
       * 錨點那筆的引文通常最長（最早的引文涵蓋最廣），拿它當代表是
       * 安全的；若它沒有引文才退而求其次取最短的。
       */
      const anchorItem = c.items
        .slice()
        .sort((a, b) => a.p - b.p)[0];

      const byWho = {};
      for (const l of c.items) {
        for (const n of l.notes) {
          const prev = byWho[n.by];
          if (!prev || n.t.length > prev.t.length) byWho[n.by] = n;
        }
      }
      const notes = Object.values(byWho)
        .sort((a, b) => b.t.length - a.t.length)
        .slice(0, MAX_NOTES_PER_LOCUS);
      if (!notes.length) continue;
      /*
       * q 是「校驗用的引文」：取這處所有引文中最短的一條（最短的最不容易
       * 因為跨段落而被截斷）。前端拿它驗證座標有沒有跑掉——只要渲染與
       * 產生器的清洗規則有一點差異，絕對位置就會整體偏移，這時候用 q
       * 重新搜尋一次比盲目相信座標可靠。
       */
      /*
       * 座標與引文都取自锚點那一筆，保證兩者一致。
       *
       * 這裡有一個容易犯的錯：錨點是「最早的一筆」，但如果那一筆的引文
       * 沒有帶出（某些舊資料格式），就不能退回用別筆的引文——那會讓 p
       * 與 q 說不同的話。寧可 q 留空（前端就用 p），也不要錯配。
       */
      const anchorQuote = anchorItem.quote || anchorItem.q || '';
      loci.push({
        p: anchorItem.p,
        q: String(anchorQuote).slice(0, 16),
        notes
      });
    }

    /*
     * 剔除「經題註釋」。
     *
     * 註疏家開篇一定先解釋經名：「『金剛般若』此乃摧萬有於性空…」。
     * 那是整部經的標題，不是某一段經文，放進逐句對讀裡會變成第一條
     * 卻對不到任何內容——實測就是這樣：金剛經第 1 條顯示「金剛般若」，
     * 讀者只會覺得對錯了。
     *
     * 判準：位置落在經文前 40 字內，且引文本身是經題的一部分
     * （包含底本經名裡的連續 2 字以上）。這種一律丟掉。
     */
    const titleZone = sutraNorm.slice(0, 40);
    const titleCore = String(fam.base.name).replace(/^T\d+《?/, '').replace(/》$/, '');
    const before = loci.length;
    const kept = loci.filter(l => {
      if (l.p >= 40) return true;
      if (!l.q) return true;
      return titleCore.indexOf(l.q) < 0;
    });
    if (kept.length !== before) {
      loci.length = 0;
      Array.prototype.push.apply(loci, kept);
    }

    if (!loci.length) continue;

    const multi = loci.filter(l => l.notes.length >= 2).length;
    totalLoci += loci.length;
    totalMulti += multi;
    totalNotes += loci.reduce((s, l) => s + l.notes.length, 0);

    out.push({ base: fam.base.id, name: fam.base.name, path: fam.base.path, loci });
  }

  const js = `/**
 * @file sidecar-data.js
 *
 * 逐句註疏對位資料（alpha 批次 9）。**由 scripts/gen-sidecar.js 產生，不要手改。**
 *
 * 重新產生：node scripts/gen-sidecar.js
 *
 * ── 格式
 *
 *   { base: 'T0235', name: 底本檔名, path: 底本路徑,
 *     loci: [ { p: 正規化經文中的起點, notes: [ { by, era, t } ] } ] }
 *
 * p 對的是「去掉所有空白之後的經文」的索引。前端用同一套正規化
 * （把渲染後的純文字去掉 \\s 與全角空格）就能算出同一個座標。
 *
 * ── 這份資料代表什麼
 *
 * 古代註疏家講經的固定格式是先引一句、再解那句。把引文對回底本，
 * 就得到「這一段經文，這位註疏家這樣讀」。
 *
 * 只有一則的「處」也留著——那仍然是有價值的註腳；有多則的地方才是
 * 這個功能真正的重點：同一句話，兩三位註疏家各有各的讀法。
 */
(function (global) {
  'use strict';

  var WORKS = ${JSON.stringify(out)};

  var byBase = {};
  for (var i = 0; i < WORKS.length; i++) byBase[WORKS[i].base] = WORKS[i];

  global.SidecarData = {
    works: WORKS,
    /** 依底本經號取對位資料。 */
    forBase: function (id) { return byBase[id] || null; }
  };

})(typeof window !== 'undefined' ? window : this);
`;

  fs.writeFileSync(path.join(ROOT, 'sidecar-data.js'), js);

  console.log('底本組數:', out.length);
  console.log('對位處數:', totalLoci, '| 其中共註（≥2 家）:', totalMulti,
    '(' + Math.round(totalMulti / Math.max(1, totalLoci) * 100) + '%)');
  console.log('註解總則數:', totalNotes);
  console.log('檔案大小:', (js.length / 1024).toFixed(0) + 'KB');

  out.sort((a, b) => b.loci.filter(l => l.notes.length >= 2).length
    - a.loci.filter(l => l.notes.length >= 2).length)
    .slice(0, 8)
    .forEach(w => {
      const m = w.loci.filter(l => l.notes.length >= 2).length;
      console.log('  ' + String(w.name).replace(/\.md$/, '').slice(0, 34).padEnd(36) +
        String(w.loci.length).padStart(4) + ' 處 / 共註 ' + m);
    });
}

main();
