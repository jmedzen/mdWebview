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

  return {
    LIMITS, COLORS, newId, normalizeWire, lineAt, lineStart, trimRange, makeAnchor,
    contextScore, approxSearch, locate, sutraNumber, findMovedFile
  };
});
