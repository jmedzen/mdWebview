/**
 * @file text.js — 全文搜尋文字處理與掃描純函式模組
 *
 * 提供 CJK 判定、標點/空白透明判定 (Transparent Set T)、
 * 標點透明 Bigram 提取、寬鬆查詢詞正規化，以及工作執行緒共用的 scanText 掃描器。
 * 純 CommonJS 模組，無 worker 或外部依賴，可由主執行緒、Worker 與測試直接引入。
 */
'use strict';

// 摘要擷取半徑（前後各 60 字元）
const SNIPPET_RADIUS = 60;

// ── 透明集合 T (Transparent Set) ──────────────────────────────────────────
// T: /[\p{P}\n\r\u0085\u2028\u2029]/u
// 包含 Unicode 標點 (\p{P}) 與行終止符（LF \n、CR \r、NEL \u0085、LINE SEPARATOR \u2028、PARAGRAPH SEPARATOR \u2029）。
// 空白（半形空白、Tab、全形空格 U+3000、NBSP 等）視為詞分隔符號，不再屬於透明集合。
//
// [不變式說明]
// 索引抽取必須使用 ⊇ 掃描透明集的集合；目前磁碟 .bin 以『標點+空白+換行』建置，比掃描的『標點+換行』更寬，故仍為合法超集。若日後要【放寬】掃描範圍（例如重新加入空白透明），必須 bump magic 並重建索引。
//
// 索引建置需走訪逾 1GB 文本，建立 65536 大小的 Uint8Array 查表以維持 O(1) 效能；
// 非 BMP 字元 (code >= 0x10000) 則回退至正規表達式。
const TRANSPARENT_RE = /[\p{P}\n\r\u0085\u2028\u2029]/u;
const TRANSPARENT_BMP = new Uint8Array(65536);
for (let i = 0; i < 65536; i++) {
  if (TRANSPARENT_RE.test(String.fromCharCode(i))) {
    TRANSPARENT_BMP[i] = 1;
  }
}

/**
 * 判定字元是否為 CJK 統一表意文字（BMP 常用區 0x4E00–0x9FFF 與 擴展A區 0x3400–0x4DBF）
 * @param {string|number} ch - 單一字元字串或 Unicode 碼位數值
 * @returns {boolean}
 */
function isCJKIdeograph(ch) {
  const code = typeof ch === 'number' ? ch : ch.charCodeAt(0);
  return (code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF);
}

/**
 * 判定字元是否屬於透明集合 T（標點符號、換行；不含空白）
 * @param {string|number} ch - 單一字元字串或 Unicode 碼位數值
 * @returns {boolean}
 */
function isTransparent(ch) {
  if (typeof ch === 'number') {
    if (ch >= 0 && ch < 0x10000) return TRANSPARENT_BMP[ch] === 1;
    if (ch >= 0x10000) return TRANSPARENT_RE.test(String.fromCodePoint(ch));
    return false;
  }
  if (typeof ch !== 'string' || ch.length === 0) return false;
  const cp = ch.codePointAt(0);
  if (cp < 0x10000) return TRANSPARENT_BMP[cp] === 1;
  return TRANSPARENT_RE.test(String.fromCodePoint(cp));
}

/**
 * 標點/換行透明 Bigram 提取演算法。
 * - CJK 字元：與前一 CJK 字元組合為 2-gram，並將 currChar 設為 prevChar
 * - T 字元（標點、換行）：略過 (continue) 並保留 prevChar，使 Bigram 跨標點與換行相連
 * - 其他字元（空白、拉丁字母、數字、非 BMP 擴展字）：重設 prevChar = ''，形成斷詞
 *
 * [不變式說明]
 * 索引抽取必須使用 ⊇ 掃描透明集的集合；目前磁碟 .bin 以『標點+空白+換行』建置，比掃描的『標點+換行』更寬，故仍為合法超集。若日後要【放寬】掃描範圍（例如重新加入空白透明），必須 bump magic 並重建索引。
 *
 * @param {string} text - 輸入文本
 * @returns {Set<string>} - 不重複的雙字元集合
 */
function extractBigramsFromText(text) {
  const set = new Set();
  if (!text) return set;
  let prevChar = '';
  const len = text.length;

  for (let i = 0; i < len; i++) {
    const ch = text.charCodeAt(i);
    if ((ch >= 0x4E00 && ch <= 0x9FFF) || (ch >= 0x3400 && ch <= 0x4DBF)) {
      const currChar = text[i];
      if (prevChar) set.add(prevChar + currChar);
      prevChar = currChar;
    } else if (ch < 0x10000 && TRANSPARENT_BMP[ch] === 1) {
      // BMP 透明字元：略過且保留 prevChar
      continue;
    } else if (ch >= 0xD800 && ch <= 0xDBFF) {
      // 代理對（非 BMP 字元）
      const cp = text.codePointAt(i);
      if (cp !== undefined && cp >= 0x10000 && TRANSPARENT_RE.test(String.fromCodePoint(cp))) {
        i++;
        continue; // 非 BMP 透明字元：略過且保留 prevChar
      }
      i++;
      prevChar = ''; // 非 BMP 符號/文字中斷
    } else {
      prevChar = '';
    }
  }
  return set;
}

/**
 * 寬鬆搜尋詞正規化：移除所有透明字元 T（標點、換行）
 * @param {string} term - 查詢詞
 * @returns {string} - 純實質字元字串
 */
function normalizeLooseTerm(term) {
  if (!term || typeof term !== 'string') return '';
  let res = '';
  const len = term.length;

  for (let i = 0; i < len; i++) {
    const ch = term.charCodeAt(i);
    if (ch >= 0xD800 && ch <= 0xDBFF) {
      const cp = term.codePointAt(i);
      if (cp !== undefined && cp >= 0x10000) {
        if (!TRANSPARENT_RE.test(String.fromCodePoint(cp))) {
          res += term[i] + term[i + 1];
        }
        i++;
        continue;
      }
    }
    if (TRANSPARENT_BMP[ch] !== 1) {
      res += term[i];
    }
  }
  return res;
}

/**
 * 1-based 行號快速計算（二分搜尋換行索引陣列）
 * @param {number[]} lineBreaks - 每行結尾換行字元索引
 * @param {number} pos - 文本內字元位移
 * @returns {number} 1-based 行號
 */
function localLineAt(lineBreaks, pos) {
  let lo = 0, hi = lineBreaks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lineBreaks[mid] < pos) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1;
}

/**
 * 寬鬆模式子字串比對器 (Zero Allocation Loose Substring Matcher)
 * 在原文座標中尋找正規化後的 chars 序列，中間遇透明字元 T 略過，遇不匹配字元中斷重試。
 * @param {string} text - 原始文本
 * @param {string|string[]} chars - 已正規化（無 T）之搜尋目標字串或字元陣列
 * @param {number} from - 起始搜尋索引
 * @param {number[]} out - 輸出陣列，扁平推入 [start0, end0, start1, end1, ...]
 * @returns {number[]} out
 */
function findLoose(text, chars, from, out) {
  if (!text || !chars) return out;
  const norm = typeof chars === 'string' ? normalizeLooseTerm(chars) : chars;
  const charList = typeof norm === 'string' ? Array.from(norm) : norm;
  if (charList.length === 0) return out;

  const firstChar = charList[0];
  const firstLen = firstChar.length;
  let pos = from || 0;
  const textLen = text.length;

  while (pos < textLen) {
    const start = text.indexOf(firstChar, pos);
    if (start === -1) break;

    let idx = start + firstLen;
    let k = 1;

    while (idx < textLen && k < charList.length) {
      const code = text.charCodeAt(idx);
      if (code >= 0xD800 && code <= 0xDBFF) {
        const cp = text.codePointAt(idx);
        if (TRANSPARENT_RE.test(String.fromCodePoint(cp))) {
          idx += 2;
          continue;
        }
        const ch = String.fromCodePoint(cp);
        if (ch === charList[k]) {
          k++;
          idx += 2;
        } else {
          break;
        }
      } else {
        if (TRANSPARENT_BMP[code] === 1) {
          idx++;
          continue;
        }
        if (text[idx] === charList[k]) {
          k++;
          idx++;
        } else {
          break;
        }
      }
    }

    if (k === charList.length) {
      out.push(start, idx);
      pos = idx > start ? idx : start + 1;
    } else {
      pos = start + 1;
    }
  }
  return out;
}

/**
 * 掃描單元文本尋找符合詞彙（支援嚴格模式與寬鬆模式）
 * - ignorePunct 為 falsy：行為與改動前 index-worker.js 完全一致
 * - ignorePunct 為 truthy：忽略標點與換行（空白為詞分隔不忽略），以原文座標計算行號、鄰近距離與摘要
 * @param {string} text - 掃描文本
 * @param {string[]} terms - 查詢詞陣列
 * @param {number} maxProximityDist - 多詞最大鄰近字元距離
 * @param {boolean} [ignorePunct=false] - 是否啟用寬鬆模式
 * @returns {Array<{line: number, snippet: string}>}
 */
function scanText(text, terms, maxProximityDist, ignorePunct) {
  const matches = [];
  const lineBreaks = [];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineBreaks.push(i);

  // ── 嚴格模式 (Strict Mode) ────────────────────────────────────────────────
  if (!ignorePunct) {
    if (terms.length === 1) {
      const term = terms[0];
      let pos = 0;
      while (pos < text.length) {
        const matchIdx = text.indexOf(term, pos);
        if (matchIdx === -1) break;
        const line = localLineAt(lineBreaks, matchIdx);

        const lineStartIdx = text.lastIndexOf('\n', matchIdx) + 1;
        let lineEndIdx = text.indexOf('\n', matchIdx);
        if (lineEndIdx === -1) lineEndIdx = text.length;
        const lineText = text.substring(lineStartIdx, lineEndIdx);
        const idxInLine = matchIdx - lineStartIdx;
        const s = Math.max(0, idxInLine - SNIPPET_RADIUS);
        const e = Math.min(lineText.length, idxInLine + term.length + SNIPPET_RADIUS);
        let snippet = lineText.substring(s, e).trim();
        if (s > 0) snippet = '…' + snippet;
        if (e < lineText.length) snippet = snippet + '…';

        matches.push({ line, snippet });
        pos = matchIdx + term.length;
      }
      return matches;
    }

    // 多詞嚴格模式（鄰近過濾）
    if (!terms.every(t => text.includes(t))) return matches;

    const termPositions = [];
    for (const term of terms) {
      const posList = [];
      let p = 0;
      while (p < text.length) {
        const idx = text.indexOf(term, p);
        if (idx === -1) break;
        posList.push(idx);
        p = idx + term.length;
      }
      if (posList.length === 0) return matches;
      termPositions.push(posList);
    }

    const p0List = termPositions[0];
    for (const p0 of p0List) {
      let clusterValid = true;
      let minPos = p0;
      let maxPos = p0 + terms[0].length;

      for (let tIdx = 1; tIdx < terms.length; tIdx++) {
        const tLen = terms[tIdx].length;
        const list = termPositions[tIdx];
        let foundClose = false;
        const windowStart = minPos - maxProximityDist;
        let lo = 0, hi = list.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (list[mid] < windowStart) lo = mid + 1;
          else hi = mid;
        }
        for (let k = lo; k < list.length; k++) {
          const p = list[k];
          if (p > maxPos + maxProximityDist) break;
          const potentialMin = Math.min(minPos, p);
          const potentialMax = Math.max(maxPos, p + tLen);
          if (potentialMax - potentialMin <= maxProximityDist) {
            minPos = potentialMin;
            maxPos = potentialMax;
            foundClose = true;
            break;
          }
        }
        if (!foundClose) { clusterValid = false; break; }
      }

      if (clusterValid) {
        const line = localLineAt(lineBreaks, minPos);
        const s = Math.max(0, minPos - SNIPPET_RADIUS);
        const e = Math.min(text.length, maxPos + SNIPPET_RADIUS);
        let snippet = text.substring(s, e).replace(/\r?\n/g, ' ').trim();
        if (s > 0) snippet = '…' + snippet;
        if (e < text.length) snippet = snippet + '…';
        matches.push({ line, snippet });
      }
    }

    return matches;
  }

  // ── 寬鬆模式 (Loose Mode: ignorePunct = true) ─────────────────────────────
  const cleanTerms = terms.map(normalizeLooseTerm).filter(Boolean);
  if (cleanTerms.length === 0) return matches;

  // 單詞寬鬆掃描
  if (cleanTerms.length === 1) {
    const term = cleanTerms[0];
    const positions = [];
    findLoose(text, term, 0, positions);
    for (let i = 0; i < positions.length; i += 2) {
      const start = positions[i];
      const end = positions[i + 1];
      const line = localLineAt(lineBreaks, start);
      const s = Math.max(0, start - SNIPPET_RADIUS);
      const e = Math.min(text.length, end + SNIPPET_RADIUS);
      let snippet = text.substring(s, e).replace(/\r?\n/g, ' ').trim();
      if (s > 0) snippet = '…' + snippet;
      if (e < text.length) snippet = snippet + '…';
      matches.push({ line, snippet });
    }
    return matches;
  }

  // 多詞寬鬆掃描（扁平座標陣列 [start0, end0, start1, end1, ...]）
  const termPositions = [];
  for (const term of cleanTerms) {
    const posList = [];
    findLoose(text, term, 0, posList);
    if (posList.length === 0) return matches;
    termPositions.push(posList);
  }

  const p0List = termPositions[0];
  for (let i0 = 0; i0 < p0List.length; i0 += 2) {
    const p0 = p0List[i0];
    const p0End = p0List[i0 + 1];
    let clusterValid = true;
    let minPos = p0;
    let maxPos = p0End;

    for (let tIdx = 1; tIdx < cleanTerms.length; tIdx++) {
      const list = termPositions[tIdx];
      let foundClose = false;
      const windowStart = minPos - maxProximityDist;
      const count = list.length >> 1;
      let lo = 0, hi = count;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid * 2] < windowStart) lo = mid + 1;
        else hi = mid;
      }
      for (let k = lo; k < count; k++) {
        const p = list[k * 2];
        const tEnd = list[k * 2 + 1];
        if (p > maxPos + maxProximityDist) break;
        const potentialMin = Math.min(minPos, p);
        const potentialMax = Math.max(maxPos, tEnd);
        if (potentialMax - potentialMin <= maxProximityDist) {
          minPos = potentialMin;
          maxPos = potentialMax;
          foundClose = true;
          break;
        }
      }
      if (!foundClose) { clusterValid = false; break; }
    }

    if (clusterValid) {
      const line = localLineAt(lineBreaks, minPos);
      const s = Math.max(0, minPos - SNIPPET_RADIUS);
      const e = Math.min(text.length, maxPos + SNIPPET_RADIUS);
      let snippet = text.substring(s, e).replace(/\r?\n/g, ' ').trim();
      if (s > 0) snippet = '…' + snippet;
      if (e < text.length) snippet = snippet + '…';
      matches.push({ line, snippet });
    }
  }

  return matches;
}

module.exports = {
  isCJKIdeograph,
  isTransparent,
  extractBigramsFromText,
  normalizeLooseTerm,
  SNIPPET_RADIUS,
  localLineAt,
  findLoose,
  scanText
};
