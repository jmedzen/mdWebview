/**
 * 劃重點的定位規則（瀏覽器與伺服器共用，純函式，無 I/O）。
 *
 * 一處劃線記下：起始行號 line、在該行內的位移 off、劃到的原文 q（繁體原文，
 * 不受簡體顯示影響）、前後文 pre／suf。經文檔案日後小幅修改時，依序：
 *   1. 找全篇與 q 完全相同的位置，以前後文吻合度與離原位置的距離挑最好的一處；
 *   2. 在原位置附近容許少數字不同（近似比對），劃線跟著新文字走；
 *   3. 以前後文夾出中間那段（劃到的字被改得較多、但前後沒動）；
 *   4. 都找不到：回傳 null，由畫面標成「找不到原處」，資料不刪。
 *
 * 文字 text 是內文所有文字節點依序接起來的字串（不含換行）；lineStarts 是
 * [{ line, pos }]（pos 遞增），表示第 line 行從 text 的第 pos 個字開始。
 *
 * 線上格式（同步用）：{ id, path, updatedAt, deleted?, line, off, q, pre, suf, c }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MdwHighlights = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LIMITS = {
    maxQuote: 500,          // 一次最多劃幾個字
    context: 24,            // 前後文各記幾個字
    maxHighlights: 5000,    // 每個帳號
    maxPerRequest: 200,     // 每次同步請求最多幾筆
    maxIdLength: 40,
    maxPathLength: 500,
    maxClockSkewMs: 60 * 1000,
    fuzzyWindow: 2500       // 近似比對在原位置前後找多遠（字）
  };

  /** 顏色：朱、黃、綠、藍。第一個是預設。 */
  const COLORS = ['r', 'y', 'g', 'b'];

  const ID_RE = /^[A-Za-z0-9_-]+$/;
  const WS_RE = /\s/;

  function newId() {
    const rnd = Math.random().toString(36).slice(2, 10);
    return Date.now().toString(36) + rnd;
  }

  function cleanStr(v, max) {
    return typeof v === 'string' ? v.slice(0, max) : '';
  }

  function cleanInt(v, min) {
    const n = Number(v);
    return Number.isFinite(n) && n >= min ? Math.floor(n) : null;
  }

  /** 整理一筆來自外部的線上資料。無效時回傳 null。 */
  function normalizeWire(raw, now) {
    if (!raw || typeof raw !== 'object') return null;
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (!id || id.length > LIMITS.maxIdLength || !ID_RE.test(id)) return null;
    const p = typeof raw.path === 'string' ? raw.path.trim() : '';
    if (!p || p.length > LIMITS.maxPathLength || p.indexOf('\0') >= 0) return null;
    const ts = Number(raw.updatedAt);
    if (!Number.isFinite(ts) || ts <= 0) return null;
    const updatedAt = Math.min(Math.floor(ts), now + LIMITS.maxClockSkewMs);
    if (raw.deleted === true) return { id, path: p, updatedAt, deleted: true };
    const q = cleanStr(raw.q, LIMITS.maxQuote);
    if (!q.trim()) return null;
    return {
      id, path: p, updatedAt, deleted: false,
      line: cleanInt(raw.line, 1) || 1,
      off: cleanInt(raw.off, 0) || 0,
      q,
      pre: cleanStr(raw.pre, LIMITS.context * 2),
      suf: cleanStr(raw.suf, LIMITS.context * 2),
      c: COLORS.includes(raw.c) ? raw.c : COLORS[0]
    };
  }

  /** text 中第 pos 個字屬於哪一行、在行內第幾個字。 */
  function lineAt(lineStarts, pos) {
    let lo = 0, hi = (lineStarts || []).length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lineStarts[mid].pos <= pos) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (ans < 0) return { line: 1, off: pos };
    return { line: lineStarts[ans].line, off: pos - lineStarts[ans].pos };
  }

  /** 第 line 行的起點；該行不在 text 裡（例如大檔只載入一部分）時回傳 null。 */
  function lineStart(lineStarts, line) {
    let lo = 0, hi = (lineStarts || []).length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const l = lineStarts[mid].line;
      if (l === line) return lineStarts[mid].pos;
      if (l < line) lo = mid + 1; else hi = mid - 1;
    }
    return null;
  }

  /** 去掉選取頭尾的空白；回傳 null 表示沒有字。 */
  function trimRange(text, s, e) {
    while (s < e && WS_RE.test(text[s])) s++;
    while (e > s && WS_RE.test(text[e - 1])) e--;
    return e > s ? { s, e } : null;
  }

  /** 由 text 的 [s, e) 建立一處劃線的定位資料。 */
  function makeAnchor(text, s, e, lineStarts) {
    const t = trimRange(text, s, e);
    if (!t) return null;
    const at = lineAt(lineStarts, t.s);
    return {
      line: at.line,
      off: at.off,
      q: text.slice(t.s, t.e),
      pre: text.slice(Math.max(0, t.s - LIMITS.context), t.s),
      suf: text.slice(t.e, t.e + LIMITS.context)
    };
  }

  function commonSuffixLen(a, b) {
    let n = 0;
    while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
    return n;
  }

  function commonPrefixLen(a, b) {
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
  }

  /** 前後文吻合幾個字。 */
  function contextScore(text, s, e, a) {
    const pre = a.pre || '';
    const suf = a.suf || '';
    return commonSuffixLen(text.slice(Math.max(0, s - pre.length), s), pre)
      + commonPrefixLen(text.slice(e, e + suf.length), suf);
  }

  /**
   * 近似子字串比對（Sellers）：在 text 中找與 pattern 編輯距離最小的一段。
   * 回傳 { s, e, cost }；pattern 或 text 為空時回傳 null。
   */
  function approxSearch(pattern, text) {
    const m = pattern.length;
    if (!m || !text.length) return null;
    const endBest = approxEnd(pattern, text);
    if (!endBest) return null;
    // 由結尾往回找起點：把字串反過來，在結尾之前的那段裡再比一次
    const revP = pattern.split('').reverse().join('');
    const head = text.slice(Math.max(0, endBest.e - m * 2 - 2), endBest.e);
    const revT = head.split('').reverse().join('');
    const back = approxEnd(revP, revT);
    if (!back) return null;
    const s = endBest.e - back.e;
    return { s, e: endBest.e, cost: endBest.cost };
  }

  function approxEnd(pattern, text) {
    const m = pattern.length;
    let col = new Array(m + 1);
    for (let i = 0; i <= m; i++) col[i] = i;
    let best = { e: 0, cost: m };
    for (let j = 0; j < text.length; j++) {
      const next = new Array(m + 1);
      next[0] = 0;
      const ch = text[j];
      for (let i = 1; i <= m; i++) {
        const sub = col[i - 1] + (pattern[i - 1] === ch ? 0 : 1);
        next[i] = Math.min(sub, col[i] + 1, next[i - 1] + 1);
      }
      col = next;
      if (col[m] < best.cost) best = { e: j + 1, cost: col[m] };
    }
    return best.cost < m ? best : null;
  }

  function allIndexes(text, q, cap) {
    const out = [];
    let i = text.indexOf(q);
    while (i >= 0 && out.length < cap) {
      out.push(i);
      i = text.indexOf(q, i + 1);
    }
    return out;
  }

  /**
   * 在 text 中找出這處劃線現在的位置。
   * @returns {{s:number, e:number, exact:boolean}|null}
   */
  function locate(text, a, lineStarts) {
    if (!a || !a.q || !text) return null;
    const q = a.q;
    const ls = lineStart(lineStarts, a.line);
    const expected = ls == null ? null : ls + (a.off || 0);

    // 1. 完全相同
    const hits = allIndexes(text, q, 400);
    if (hits.length) {
      let best = null;
      for (const s of hits) {
        const ctx = contextScore(text, s, s + q.length, a);
        const dist = expected == null ? 0 : Math.abs(s - expected);
        const score = ctx * 1000 - dist;
        if (!best || score > best.score) best = { s, score };
      }
      return { s: best.s, e: best.s + q.length, exact: true };
    }

    // 2. 原位置附近，容許少數字不同
    const maxCost = Math.max(1, Math.floor(q.length / 4));
    if (expected != null && q.length >= 2) {
      const w0 = Math.max(0, expected - LIMITS.fuzzyWindow);
      const w1 = Math.min(text.length, expected + q.length + LIMITS.fuzzyWindow);
      const r = approxSearch(q, text.slice(w0, w1));
      if (r && r.cost <= maxCost) {
        const s = w0 + r.s, e = w0 + r.e;
        // 很短的劃線容易誤認：只差一個字時，要前後文也對得上
        if (q.length > 4 || contextScore(text, s, e, a) >= 4) {
          const t = trimRange(text, s, e);
          if (t) return { s: t.s, e: t.e, exact: false };
        }
      }
    }

    // 3. 前後文夾出中間那段
    const pre = (a.pre || '').slice(-12);
    const suf = (a.suf || '').slice(0, 12);
    if (pre.length >= 4 && suf.length >= 4) {
      const maxLen = Math.ceil(q.length * 1.5) + 10;
      let best = null;
      for (const p of allIndexes(text, pre, 200)) {
        const s = p + pre.length;
        const k = text.indexOf(suf, s);
        if (k < 0 || k - s > maxLen || k - s < 1) continue;
        const dist = expected == null ? 0 : Math.abs(s - expected);
        if (!best || dist < best.dist) best = { s, e: k, dist };
      }
      if (best) {
        const t = trimRange(text, best.s, best.e);
        if (t) return { s: t.s, e: t.e, exact: false };
      }
    }
    return null;
  }

  /** 取出檔名開頭的經號（例如 T0251、X1234、T0220a），沒有時回傳 ''。 */
  function sutraNumber(filePath) {
    const base = String(filePath || '').split('/').pop().replace(/\.md$/i, '');
    const m = base.match(/^([A-Z]{1,3}\d{2,5}[a-z]?)(?![0-9])/);
    return m ? m[1] : '';
  }

  /**
   * 書籤指向的檔案不見時，找它搬到哪裡去了：先找同檔名，再找同經號；
   * 恰好一個候選才算數（多個就無法確定，當作已刪除）。
   * @param {string} oldPath
   * @param {Iterable<string>} files 目前文庫裡所有檔案路徑
   * @returns {string|null}
   */
  function findMovedFile(oldPath, files) {
    const base = String(oldPath || '').split('/').pop();
    const num = sutraNumber(oldPath);
    const sameName = [];
    const sameNum = [];
    for (const f of files) {
      if (f === oldPath) return f;
      const b = f.split('/').pop();
      if (b === base) sameName.push(f);
      else if (num && sutraNumber(f) === num) sameNum.push(f);
    }
    if (sameName.length === 1) return sameName[0];
    if (sameName.length === 0 && sameNum.length === 1) return sameNum[0];
    return null;
  }

  // ───────────────────────────────────────────────────────────
  // 匯出成 Markdown：書籤＋劃線（含上下文）
  //
  // 上下文取自原始 .md：每處劃線前後各取約 EXPORT.context 個字，再往外找最近的
  // 句讀（。！？；：，）收尾，最多多走 EXPORT.slack 個字；不跨段落。
  // 同一段裡兩處劃線相距不到 EXPORT.mergeGap 個字（= 兩邊的上下文會重疊），
  // 就合成一段上下文，同一段文字只出現一次，劃到的字用 ==…== 標出。
  // ───────────────────────────────────────────────────────────
  const EXPORT = {
    context: 60,
    slack: 30,
    mergeGap: 120
  };
  const CJK_RE = /[⺀-鿿豈-﫿　-〿＀-￯]/;
  const STOP_RE = /[。！？；：，、!?;:,.」』）)]/;

  /** 一行 Markdown 去掉標記，只留讀者看得到的字（近似畫面上的內文）。 */
  function plainLine(line) {
    let s = String(line || '');
    s = s.replace(/^\s*>+\s?/, '');
    s = s.replace(/^\s*#{1,6}\s+/, '');
    s = s.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '');
    s = s.replace(/!\[\[[^\]]*\]\]/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '');
    s = s.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2').replace(/\[\[([^\]]*)\]\]/g, '$1');
    s = s.replace(/\[\^[^\]]*\]/g, '');
    s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    s = s.replace(/<[^>]+>/g, '');
    s = s.replace(/(\*\*|__|==|~~|`)/g, '');
    s = s.replace(/\*/g, '');
    s = s.replace(/\\([\\`*_{}\[\]()#+\-.!>|=~])/g, '$1');
    if (/^\s*\|.*\|\s*$/.test(s)) s = s.replace(/^\s*\|/, '').replace(/\|\s*$/, '').replace(/\s*\|\s*/g, ' ');
    return s.trim();
  }

  function softJoin(a, b) {
    if (!a || !b) return '';
    return CJK_RE.test(a[a.length - 1]) || CJK_RE.test(b[0]) ? '' : ' ';
  }

  /**
   * 原始 Markdown → 純文字索引。
   * @returns {{ text:string, lineStarts:Array, blocks:Array<{s,e}>, headings:Array<{pos,text}> }}
   *   text 與畫面內文一樣是接起來的字串；blocks 是段落（空行、標題、程式碼區塊為界）。
   */
  function plainTextOfMarkdown(md) {
    const lines = String(md || '').split(/\r?\n/);
    let i = 0;
    // 跳過開頭的 YAML frontmatter（行號照原檔算）
    if (lines[0] === '---') {
      const end = lines.indexOf('---', 1);
      if (end > 0) i = end + 1;
    }
    let text = '';
    const lineStarts = [];
    const blocks = [];
    const headings = [];
    let block = null;
    let inCode = false;
    const close = () => { if (block) { block.e = text.length; if (block.e > block.s) blocks.push(block); block = null; } };
    for (; i < lines.length; i++) {
      const raw = lines[i];
      const t = raw.trim();
      if (t.startsWith('```')) { inCode = !inCode; close(); continue; }
      if (inCode) continue;
      if (!t || /^(?:[-*_]\s*){3,}$/.test(t) || /^\[\^[^\]]+\]:/.test(t) || /^\|?\s*:?-{2,}/.test(t)) { close(); continue; }
      const isHeading = /^#{1,6}\s/.test(t);
      const plain = plainLine(raw);
      if (!plain) continue;
      if (isHeading) close();
      if (block) text += softJoin(text, plain);
      else block = { s: text.length, e: text.length };
      lineStarts.push({ line: i + 1, pos: text.length });
      if (isHeading) headings.push({ pos: text.length, text: plain });
      text += plain;
      if (isHeading) close();
    }
    close();
    return { text, lineStarts, blocks, headings };
  }

  function blockIndexAt(blocks, pos) {
    let lo = 0, hi = blocks.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (blocks[mid].s <= pos) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  function headingBefore(headings, pos) {
    let ans = null;
    for (const h of headings) { if (h.pos <= pos) ans = h; else break; }
    return ans ? ans.text : '';
  }

  /** 從 s 往前最多 slack 個字找句讀，回傳句讀之後的位置；找不到回傳 s。 */
  function backToStop(text, s, min, slack) {
    for (let p = s; p > Math.max(min, s - slack); p--) {
      if (STOP_RE.test(text[p - 1])) return p;
    }
    return s;
  }

  function forwardToStop(text, e, max, slack) {
    for (let p = e; p < Math.min(max, e + slack); p++) {
      if (STOP_RE.test(text[p])) return p + 1;
    }
    return e;
  }

  /**
   * 把同一份文件的劃線依位置排好，鄰近的合成一段上下文。
   * @param {{text,lineStarts,blocks,headings}|null} doc  plainTextOfMarkdown 的結果；拿不到原文時給 null
   * @param {Array<{line,off,q,pre,suf,c}>} items
   * @returns {{ excerpts: Array<{line, heading, text, marks:Array<[s,e]>, colors:string[], cut:[boolean,boolean]}>, lost: Array }}
   *   excerpts[].text 是那段上下文，marks 是劃線在其中的位置；lost 是在原文裡找不到的劃線。
   */
  function buildExcerpts(doc, items, opts) {
    const o = Object.assign({}, EXPORT, opts || {});
    const found = [];
    const lost = [];
    for (const h of items || []) {
      const r = doc && doc.text ? locate(doc.text, h, doc.lineStarts) : null;
      if (!r) { lost.push(h); continue; }
      const b = blockIndexAt(doc.blocks, r.s);
      const be = blockIndexAt(doc.blocks, Math.max(r.s, r.e - 1));
      found.push({ s: r.s, e: r.e, b: Math.max(0, b), be: Math.max(0, be), h });
    }
    found.sort((x, y) => (x.s - y.s) || (x.e - y.e));

    const groups = [];
    for (const f of found) {
      const g = groups[groups.length - 1];
      if (g && f.b <= g.be && f.s - g.e <= o.mergeGap) {
        g.items.push(f);
        g.e = Math.max(g.e, f.e);
        g.be = Math.max(g.be, f.be);
      } else {
        groups.push({ s: f.s, e: f.e, b: f.b, be: f.be, items: [f] });
      }
    }

    const text = doc ? doc.text : '';
    const excerpts = groups.map(g => {
      const blk = doc.blocks[g.b] || { s: 0, e: text.length };
      const blkEnd = (doc.blocks[g.be] || blk).e;
      let ws = Math.max(blk.s, g.s - o.context);
      let we = Math.min(blkEnd, g.e + o.context);
      if (ws > blk.s) ws = backToStop(text, ws, blk.s, o.slack);
      if (we < blkEnd) we = forwardToStop(text, we, blkEnd, o.slack);
      // 合併重疊的劃線，避免 ==…== 交錯
      const marks = [];
      for (const f of g.items) {
        const last = marks[marks.length - 1];
        if (last && f.s <= last[1]) last[1] = Math.max(last[1], f.e);
        else marks.push([f.s, f.e]);
      }
      const colors = [];
      for (const f of g.items) if (!colors.includes(f.h.c)) colors.push(f.h.c);
      return {
        line: lineAt(doc.lineStarts, g.s).line,
        heading: headingBefore(doc.headings, g.s),
        text: text.slice(ws, we),
        marks: marks.map(([s, e]) => [s - ws, e - ws]),
        colors,
        count: g.items.length,
        cut: [ws > blk.s, we < blkEnd]
      };
    });
    return { excerpts, lost };
  }

  /** Markdown 內文跳脫：只處理會改變排版的字元。 */
  function mdEscape(s) {
    return String(s || '').replace(/\s+/g, ' ').replace(/([\\`*_[\]<>|=~])/g, '\\$1');
  }

  function markText(text, marks) {
    let out = '';
    let p = 0;
    for (const [s, e] of marks) {
      out += mdEscape(text.slice(p, s)) + '==' + mdEscape(text.slice(s, e)).trim() + '==';
      p = e;
    }
    return out + mdEscape(text.slice(p));
  }

  function quoteBlock(body) {
    return '> ' + body;
  }

  /**
   * 組出整份「書籤與劃線」Markdown。
   * @param {Object} p
   * @param {Array} p.bookmarks   [{ filePath, fileName, pct?, ts? }]（順序即輸出順序）
   * @param {Array} p.highlights  [{ filePath, line, off, q, pre, suf, c }]
   * @param {Map<string, Object|null>} p.docs  filePath → plainTextOfMarkdown 結果；null = 拿不到原文
   * @param {string} [p.baseUrl]  例：https://example.org/ → 產生回到原處的連結
   * @param {string} [p.title]
   * @param {string} [p.dateText]
   * @param {Object} [p.colorNames] { r:'朱', ... }
   */
  function buildLibraryMarkdown(p) {
    const names = p.colorNames || {};
    const bookmarks = (p.bookmarks || []).slice();
    const byFile = new Map();
    for (const h of p.highlights || []) {
      if (!byFile.has(h.filePath)) byFile.set(h.filePath, []);
      byFile.get(h.filePath).push(h);
    }
    // 有劃線卻沒有書籤（理論上不會發生）也要匯出
    for (const fp of byFile.keys()) {
      if (!bookmarks.some(b => b.filePath === fp)) bookmarks.push({ filePath: fp });
    }
    const titleOf = b => b.fileName || String(b.filePath).replace(/^dict:/, '').split('/').pop().replace(/\.md$/i, '');
    const linkOf = (fp, line) => {
      if (!p.baseUrl || String(fp).startsWith('dict:')) return '';
      // 與畫面上「分享第 N 行」同樣的網址格式（中文不編碼，只跳脫會斷開網址的字元）
      const f = String(fp).replace(/%/g, '%25').replace(/&/g, '%26').replace(/#/g, '%23').replace(/ /g, '%20').replace(/</g, '%3C').replace(/>/g, '%3E');
      return `${p.baseUrl}?file=${f}${line ? `&line=${line}` : ''}`;
    };
    const withHl = bookmarks.filter(b => byFile.has(b.filePath));
    const without = bookmarks.filter(b => !byFile.has(b.filePath));
    const total = (p.highlights || []).length;

    const out = [];
    out.push(`# ${p.title || '我的書籤與劃線'}`, '');
    out.push(`${p.dateText ? `匯出時間：${p.dateText}　` : ''}書籤 ${bookmarks.length} 個・劃線 ${total} 處`, '');
    out.push('> 劃到的字以 ==螢光== 標出；相鄰的劃線共用一段上下文。', '');

    for (const b of withHl) {
      const fp = b.filePath;
      const doc = p.docs ? p.docs.get(fp) : null;
      const items = byFile.get(fp).slice().sort((x, y) => (x.line - y.line) || ((x.off || 0) - (y.off || 0)));
      const { excerpts, lost } = buildExcerpts(doc || null, items);
      out.push('---', '', `## ${mdEscape(titleOf(b))}`, '');
      const meta = [`\`${String(fp).replace(/`/g, '')}\``, `劃線 ${items.length} 處`];
      if (typeof b.pct === 'number') meta.push(`讀到 ${Math.round(b.pct)}%`);
      const link = linkOf(fp);
      if (link) meta.push(`[開啟](<${link}>)`);
      out.push(meta.join('・'), '');
      let lastHeading = '';
      for (const x of excerpts) {
        if (x.heading && x.heading !== lastHeading && x.heading !== titleOf(b)) {
          out.push(`### ${mdEscape(x.heading)}`, '');
          lastHeading = x.heading;
        }
        const body = (x.cut[0] ? '……' : '') + markText(x.text, x.marks) + (x.cut[1] ? '……' : '');
        out.push(quoteBlock(body), '');
        const lineLink = linkOf(fp, x.line);
        const where = lineLink ? `[第 ${x.line} 行](<${lineLink}>)` : `第 ${x.line} 行`;
        const cols = x.colors.map(c => names[c] || c).filter(Boolean).join('、');
        out.push(`<sub>${where}${cols ? `・${cols}` : ''}</sub>`, '');
      }
      if (lost.length) {
        out.push(doc ? '**原文已更動、找不到原處的劃線**（以下是劃線當時記下的前後文）：' : '_無法取得原文，以下是劃線當時記下的前後文。_', '');
        for (const h of lost) {
          const body = (h.pre ? '……' + mdEscape(h.pre) : '') + '==' + mdEscape(h.q).trim() + '==' + (h.suf ? mdEscape(h.suf) + '……' : '');
          out.push(quoteBlock(body), '', `<sub>第 ${h.line} 行${names[h.c] ? `・${names[h.c]}` : ''}</sub>`, '');
        }
      }
    }

    if (without.length) {
      out.push('---', '', withHl.length ? '## 其他書籤' : '## 書籤', '');
      for (const b of without) {
        const link = linkOf(b.filePath);
        const name = mdEscape(titleOf(b));
        const pct = typeof b.pct === 'number' ? `　讀到 ${Math.round(b.pct)}%` : '';
        out.push(`- ${link ? `[${name}](<${link}>)` : name}${pct}`);
      }
      out.push('');
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  }

  return {
    LIMITS, COLORS, newId, normalizeWire, lineAt, lineStart, trimRange, makeAnchor,
    contextScore, approxSearch, locate, sutraNumber, findMovedFile,
    EXPORT, plainLine, plainTextOfMarkdown, buildExcerpts, buildLibraryMarkdown
  };
});
