/**
 * 科判側欄（v4.20.0）。講記資料夾是科判系列時（伺服器 /api/kepan 判定），
 * 側欄的「大綱」換成「科判」：整部論的科判樹，閱讀時自動標出目前所在的科。
 *
 * 設計重點是「不迷路」：
 *   - 樹不會在閱讀時換根。一次只看一「地」（丙層），跨到下一地才換範圍，並短暫提示。
 *   - 只沿著目前閱讀位置那一條主幹展開；離開的分支自動收起（使用者自己打開的不收）。
 *   - 前 5 層正常縮排，更深的每層只縮 3px，四十層也放得進側欄寬度。
 *   - 可展開的科是帶框的 ＋／− 按鈕；末端科是書頁圖示，點了就讀。
 *   - 下拉選單下方有快速搜尋（v4.21.0）：輸入科判字或科名，結果暫時取代樹，點選即前往。
 *   - 閱讀框頂端有地標列（卷、層數、在整棵樹的位置）與從根到末端科的完整路徑；
 *     底部有前一科／後一科（沿用辭典前一條／後一條的浮動膠囊，按鈕上寫前後科科名），跨卷時自動換檔。
 *
 * 多講輪（v4.25.0）：同一部經論講過多次時，伺服器每輪給一棵樹（payload.rounds 列出各輪）。
 * 側欄上方有講輪切換鈕；前後科、搜尋都只在本輪。兩輪相同的科（payload.alt）在地標列顯示「另講」，
 * 點了跳到另一輪的同一科。章節式標題（第一章／第一節…）的樹以章為範圍（payload.scopeDepth）。
 *
 * 上半部是純函式（Node 測試直接 require），下半部是瀏覽器接線，由 app.js 在文件渲染後呼叫
 * window.MdwKepan.onDocumentRendered(filePath)。
 */
(function (root, factory) {
  const model = factory();
  if (typeof module === 'object' && module.exports) module.exports = model;
  else root.MdwKepan = model;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ALL_LABEL = '全文（不分組）';   // 範圍選單第一項：整棵樹
  const SCOPE_DEPTH = 2;       // 以「丙」層（十七地）為一個範圍
  const FULL_LEVELS = 5;       // 前 5 層正常縮排
  const INDENT = 14;          // 前 FULL_LEVELS 層每層縮排
  const MID_LEVELS = 12;      // 到這一層為止用 MID_INDENT
  const MID_INDENT = 6;       // 6–12 層每層縮排
  const INDENT_CAP = 112;     // 13 層以後不再增加（FULL_LEVELS*INDENT + 7*MID_INDENT）
  const ROW_HEIGHT = 28;
  const JUMP_GAP = 12;         // 跳到某科時，標題頂端與黏性地標列底緣的間距（同 app.js 跳行）
  const MIN_ROWS = 6;          // 沒有目前位置時，樹至少展開到這麼多列（頂層只有一科的樹不至於只看到一列）

  // ───────────── 純函式 ─────────────

  /**
   * 把伺服器的精簡格式展開成節點陣列。nodes[0] 是虛擬根。
   * @param {{ title: string, files: string[], heads: Object, nodes: Array }} payload
   * @returns {{ id, p, d, m, t, pg, f, l, k: number[] }[]}
   */
  function expandNodes(payload) {
    const N = [{ id: 0, p: -1, d: -1, m: '', t: payload.title || '', pg: 0, f: -1, l: 0, k: [] }];
    payload.nodes.forEach(([p, m, t, pg, f, l], i) => {
      const id = i + 1;
      N.push({ id, p, d: N[p].d + 1, m, t, pg, f, l, k: [] });
      N[p].k.push(id);
    });
    return N;
  }

  /** 從根（不含虛擬根）到 id 的上層，不含自己。 */
  function ancestors(N, id) {
    const a = [];
    for (let p = N[id].p; p > 0; p = N[p].p) a.unshift(p);
    return a;
  }

  /** 某科所屬的範圍（丙層那一科）；比丙層淺的科屬於全論（0）。 */
  function scopeOf(N, id, depth) {
    const sd = depth === undefined ? SCOPE_DEPTH : depth;
    if (!id || N[id].d < sd) return 0;
    return ancestors(N, id).concat(id).find(x => N[x].d === sd) || 0;
  }

  /**
   * 目前這科在其他講輪的同一科（v4.25.0）。本科沒有對照時往上找最近有對照的上層科。
   * @returns {{ id: number, hits: Array<[number, string, number, number]> }|null}
   *   id 是有對照的那一科（本科或上層），hits 為 [輪次, 檔名, 行號, 該輪科 id]
   */
  function altFor(payload, N, id) {
    const alt = payload && payload.alt;
    if (!alt || !id) return null;
    for (let x = id; x > 0; x = N[x].p) if (alt[x] && alt[x].length) return { id: x, hits: alt[x] };
    return null;
  }

  /**
   * 切換到第 ri 輪時要去的位置：目前這科（或上層）在該輪有對照就去那一科，否則到該輪開頭。
   * @returns {{ file: string, line: number, id: number }}
   */
  function roundTarget(payload, N, hereId, ri) {
    const a = altFor(payload, N, hereId);
    const hit = a && a.hits.find(h => h[0] === ri);
    if (hit) return { file: hit[1], line: hit[2], id: hit[3] };
    const r = payload.rounds[ri];
    return { file: r.file, line: 0, id: 0 };
  }

  /**
   * 第 level 層（範圍內相對層級）的縮排像素。三段式，確保深層還留得下科名（v4.27.16）：
   *   0–5 層每層 14px，6–12 層每層 6px，13 層以後不再增加（上限 INDENT_CAP）。
   * 實測瑜伽師地論本地分最深 40 層：舊版縮排 175px、300px 側欄只剩 95px 給科名；
   * 新版上限 112px，手機 280px 時也還有 150px 以上。
   */
  function indentFor(level) {
    if (level <= FULL_LEVELS) return level * INDENT;
    if (level <= MID_LEVELS) return FULL_LEVELS * INDENT + (level - FULL_LEVELS) * MID_INDENT;
    return INDENT_CAP;
  }

  /**
   * 展開的科 = 使用者打開的 ＋ 目前閱讀路徑上的（使用者手動收起的除外）。
   * 另外（v4.27.16）：看得到幾列少於 minRows 時，從頂端往下逐層展開，直到有足夠的列。
   * 有些樹的頂層只有一科（瑜伽師地論本地分整個資料夾只有「甲一 本地分」），
   * 第一次打開只看到一列，像壞了；這裡只補到看得見為止，不動 userOpen。
   */
  function computeExpanded(N, userOpen, userClosed, hereId, minRows) {
    const out = new Set(userOpen);
    if (hereId) for (const a of ancestors(N, hereId)) if (!userClosed.has(a)) out.add(a);
    if (!minRows) return out;
    let rows = visibleRows(N, 0, out).length, guard = 0;
    while (rows < minRows && guard++ < 8) {
      // 目前看得見、還沒展開的分科，優先展最前面那個（閱讀順序）
      let opened = false;
      for (const id of visibleRows(N, 0, out)) {
        if (N[id].k.length && !out.has(id) && !userClosed.has(id)) { out.add(id); opened = true; break; }
      }
      if (!opened) break;
      rows = visibleRows(N, 0, out).length;
    }
    return out;
  }

  /** 範圍 rootId 之下目前看得到的列（依閱讀順序）。rootId 為 0 時是全論。 */
  function visibleRows(N, rootId, expanded) {
    const rows = [];
    const walk = id => {
      rows.push(id);
      if (expanded.has(id)) for (const k of N[id].k) walk(k);
    };
    if (rootId) walk(rootId); else for (const k of N[0].k) walk(k);
    return rows;
  }

  /**
   * 依閱讀位置的行號找出目前的科：該檔中行號 ≤ line 的最後一個科判標題。
   * 在第一個科判標題之前，仍屬上一卷最後的科。
   */
  function hereFromLine(payload, fileIndex, line) {
    return hereInfo(payload, fileIndex, line).id;
  }

  /**
   * 同 hereFromLine，另說明這個「目前科」是自己找出來的還是承前借來的（v4.27.16）。
   *   own       = true：本檔自己有科判標題，位置確定。
   *   inherited = true：本檔沒有科判標題，位置沿用前一篇最後一科（卷末續講、QA 附錄等）。
   * none=true 表示前面也沒有任何科判可借（例：全書第一篇就沒有標題）。
   * 借來的科不能當成「讀者在這一科」，介面要寫明「承前」，不能默默顯示成目前位置。
   * @returns {{ id: number, own: boolean, inherited: boolean, none: boolean }}
   */
  function hereInfo(payload, fileIndex, line) {
    const hs = (payload && payload.heads[fileIndex]) || [];
    let lo = 0, hi = hs.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (hs[mid][0] <= line) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (best >= 0) return { id: hs[best][1], own: true, inherited: false, none: false };
    // 在第一個科判標題之前：本卷卷首仍屬上一卷最後一科（跨卷延續），先往前借
    for (let f = fileIndex - 1; f >= 0; f--) {
      const prev = payload && payload.heads[f];
      if (prev && prev.length) return { id: prev[prev.length - 1][1], own: false, inherited: !hs.length, none: false };
    }
    // 前面沒有任何科判可借：本檔自己有標題就取第一個，否則真的沒有位置
    if (hs.length) return { id: hs[0][1], own: true, inherited: false, none: false };
    return { id: 0, own: false, inherited: false, none: true };
  }

  /** 一行科判標題拆成段落，供閱讀框改繪成由淺到深的階梯。 */
  function headingSegments(text) {
    const NUM = '[一二三四五六七八九十]+';
    return String(text).replace(/ /g, ' ').trim()
      .split(new RegExp(`[\\s\\u3000]+(?=\\S${NUM}、?)|(?<=科）)(?=\\S${NUM}、)|(?<=[；;])(?=[甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥天地玄黃宇宙洪荒日月盈昃宿列張寒來暑往秋收冬藏已]${NUM}、?)`))
      .map(s => s.replace(/[；;]+$/, ''))
      .map(s => {
        const m = s.match(new RegExp(`^(\\S)(${NUM})、?(.*?)(?:（(分${NUM}科)）)?$`));
        return m ? { mark: m[1] + m[2], title: m[3], split: m[4] || '' } : { mark: '', title: s, split: '' };
      })
      .filter(seg => seg.mark || seg.title);
  }

  /** 從檔名或標題取出卷數（「卷九」→「九」）。 */
  function juanOf(title) {
    const m = String(title || '').match(/卷([〇零一二三四五六七八九十百]+)/);
    return m ? m[1] : '';
  }

  /** 讓標題頂端落在黏性列下方 gap 像素處的 scrollTop。 */
  function jumpScrollTop(headingTop, contentTop, scrollTop, barH, gap) {
    return Math.max(0, headingTop - contentTop + scrollTop - barH - (gap === undefined ? JUMP_GAP : gap));
  }

  /** 捲動定位的判定線：標題要越過黏性列底下才算讀到（取本篇最高列高，避免列高變動來回跳）。 */
  function spyLine(scrollTop, barMax) {
    return scrollTop + Math.max(80, barMax + JUMP_GAP + 16);
  }

  /** 搜尋用的正規化：去空白與標點、英文小寫，「五識 身」「五識身」都找得到。 */
  function normalizeQuery(s) {
    return String(s || '').toLowerCase()
      .replace(/[\s\u3000、，。；：！？「」『』（）()《》〈〉【】．·・,.;:!?'"\-—…／/]+/g, '');
  }

  /**
   * 快速搜尋科名（v4.21.0）：在整個科判系列裡找科判字（丙一）或科名含有關鍵字的科。
   * 以空白分開的多個關鍵字須全部符合。目前範圍（rootId 那一地）裡的結果排前面，
   * 其餘依閱讀順序。
   * @param {Array} N expandNodes 的結果
   * @param {string} query
   * @param {{ rootId?: number, limit?: number, hay?: string[] }} [opts] hay 為快取的正規化字串
   * @returns {{ ids: number[], total: number, inScope: number }}
   */
  function searchNodes(N, query, opts) {
    const o = opts || {};
    const terms = String(query || '').split(/[\s\u3000]+/).map(normalizeQuery).filter(Boolean);
    if (!terms.length) return { ids: [], total: 0, inScope: 0 };
    const limit = o.limit || 200, rootId = o.rootId || 0, hay = o.hay || [];
    const near = [], far = [];
    for (let id = 1; id < N.length; id++) {
      const h = hay[id] !== undefined ? hay[id] : (hay[id] = normalizeQuery(N[id].m + N[id].t));
      if (!terms.every(t => h.includes(t))) continue;
      (rootId && scopeOf(N, id, o.scopeDepth) === rootId ? near : far).push(id);
    }
    // 科判字完全相同（輸入「丙一」）的科排在最前
    const exact = normalizeQuery(query);
    const all = near.concat(far);
    const head = all.filter(id => normalizeQuery(N[id].m) === exact);
    const ids = head.length ? head.concat(all.filter(id => normalizeQuery(N[id].m) !== exact)) : all;
    return { ids: ids.slice(0, limit), total: ids.length, inScope: near.length };
  }

  /**
   * 末端科的 id 清單（沒有子科的科），依文件順序。前後科只在這些科之間走（v4.27.16）。
   * @param {Array} N expandNodes 的結果
   * @returns {number[]}
   */
  function leafIds(N) {
    const out = [];
    for (let id = 1; id < N.length; id++) if (!N[id].k.length) out.push(id);
    return out;
  }

  /** 在排序好的 leafs 裡找第一個 > id（dir=1）或 < id（dir=-1）的；沒有回 0。二分搜尋。 */
  function seekLeaf(leafs, id, dir) {
    let lo = 0, hi = leafs.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (dir > 0 ? leafs[mid] > id : leafs[mid] < id) { best = mid; if (dir > 0) hi = mid - 1; else lo = mid + 1; }
      else if (dir > 0) lo = mid + 1; else hi = mid - 1;
    }
    return best < 0 ? 0 : leafs[best];
  }

  /**
   * 前後科（v4.27.16 起只走末端科）：首末科沒有前後科，回傳 0。
   *   - 停在末端科：就是前一個／後一個末端科。
   *   - 停在分科：後一科是它子樹的第一個末端科（往下讀不漏內容），
   *     前一科是它之前最後一個末端科（不含自己子樹）。
   * 全樹實測：8,623 個分科的「後一科」都等於子樹第一個末端科，零例外；
   * 末端科 next→prev 雙向可逆，也零例外，所以沿用單調的 id 序即可。
   * @param {Array} N expandNodes 的結果
   * @param {number} id
   * @param {number[]} [leafs] 先算好的 leafIds(N)，重複呼叫時省一次走訪
   * @returns {{ prev: number, next: number }}
   */
  function navTargets(N, id, leafs) {
    if (!id || !N[id]) return { prev: 0, next: 0 };
    const L = leafs || leafIds(N);
    return { prev: seekLeaf(L, id, -1), next: seekLeaf(L, id, 1) };
  }
  // 前後科按鈕上的字：寫該科的科判字與科名；沒有（首末科）時寫 edge
  function navLabel(n, edge) {
    return n ? `${n.m || ''} ${shortTitle(n.t)}`.trim() : edge;
  }

  /**
   * 顯示用的科名：拿掉「(分四科)」「（分二科）」這類科數註記（v4.27.9）。
   * 樹上已有「分N」小字，路徑、膠囊、選單只需要科名；完整原文仍在滑過提示裡。
   */
  function shortTitle(t) {
    const s = String(t || '').replace(/[（(]分[〇零一二三四五六七八九十百\d]+科[）)]/g, '').trim();
    return s || String(t || '');
  }

  /**
   * 單擊／雙擊分流（v4.26.0）：有子科的列，單擊跳到該科、雙擊展開／收合。
   * 第一下先等 delay 毫秒；期間同一列再點一下就算雙擊（不跳轉、只切換），
   * 否則時間到才當單擊。點了別列時，前一列待決的單擊立即生效。
   * 不靠瀏覽器的 dblclick 事件：手機上的雙點也走同一條路。
   * @param {number} delay
   * @param {{ set: Function, clear: Function }} [timers] 測試時注入
   */
  function makeTapGate(delay, timers) {
    const T = timers || { set: (f, ms) => setTimeout(f, ms), clear: h => clearTimeout(h) };
    let pending = null;
    function flush() {
      if (!pending) return;
      const p = pending;
      pending = null;
      T.clear(p.h);
      p.single(p.key);
    }
    return {
      tap(key, single, double) {
        if (pending && pending.key === key) {
          T.clear(pending.h);
          pending = null;
          double(key);
          return 'double';
        }
        flush();
        const p = { key, single };
        p.h = T.set(() => { if (pending === p) { pending = null; single(key); } }, delay);
        pending = p;
        return 'pending';
      },
      flush,
      cancel() { if (pending) { T.clear(pending.h); pending = null; } },
      get pendingKey() { return pending ? pending.key : null; },
    };
  }

  /**
   * 講次選單的一行說明：只顯示 frontmatter round_note 手寫的說明（v4.27.1 起不再自動摘要內容）。
   * @param {object} r - payload.rounds 的一項
   * @returns {string}
   */
  function roundDetail(r) {
    return (r && r.note) || '';
  }

  /**
   * 講次選單的分組。伺服器有 roundGroups 就照用；舊快取沒有時每輪自成一組、以年份地點為題。
   * @returns {{ topic: string, rounds: number[] }[]}
   */
  function roundGroups(payload) {
    const rounds = (payload && payload.rounds) || [];
    if (payload && Array.isArray(payload.roundGroups) && payload.roundGroups.length) return payload.roundGroups;
    return rounds.map((r, i) => ({ topic: r.topic || r.label, rounds: [i] }));
  }

  /**
   * 範圍選單的選項：範圍那一層的科，依上層分組。只有一個上層（或範圍就在最上層）時不分組。
   * @returns {{ parent: number, items: object[] }[]} parent 為 0 表示不加分組標題
   */
  function scopeOptions(N, depth) {
    const groups = [], byParent = new Map();
    for (const n of N) {
      if (n.id === 0 || n.d !== depth) continue;
      const p = n.p > 0 ? n.p : 0;
      let g = byParent.get(p);
      if (!g) { g = { parent: p, items: [] }; byParent.set(p, g); groups.push(g); }
      g.items.push(n);
    }
    if (groups.length <= 1) return groups.map(g => ({ parent: 0, items: g.items }));
    return groups;
  }

  /** 「第一章」「第二節」「第三項」這種章節式科判字。 */
  const CHAPTER_MARK = /^第[〇零一二三四五六七八九十百]+(章|節|項)$/;

  /**
   * 範圍選單的選項（v4.27.16 起另附章節資訊）：同一層的科依閱讀順序，
   * 章節式標題（第一章／第X章）的樹另把「章」與「序／節」分開，
   * 免得 43 章中間夾著 6 節，選單看起來沒有結構。
   * @returns {{ parent: number, label: string, items: object[] }[]}
   *   label 為空字串表示不加分組標題
   */
  function scopeSections(N, depth) {
    const base = scopeOptions(N, depth);
    const all = base.flatMap(g => g.items);
    const chapterish = all.filter(n => CHAPTER_MARK.test(n.m));
    if (chapterish.length < all.length * 0.5) return base.map(g => ({ parent: g.parent, label: '', items: g.items }));
    const chapters = all.filter(n => /章$/.test(n.m) && CHAPTER_MARK.test(n.m));
    const others = all.filter(n => !chapters.includes(n));
    const out = [];
    if (others.length) out.push({ parent: 0, label: others.length > 1 ? '序與附說' : '', items: others });
    if (chapters.length) out.push({ parent: 0, label: chapters.length > 1 ? '章' : '', items: chapters });
    return out;
  }

  /** 地標列路徑收合時保留幾層（含目前科）：手機 2 層、桌機 3 層。 */
  function pathKeep(width) {
    return width <= 768 ? 2 : 3;
  }

  /**
   * 講次按鈕上的字（v4.27.8）。
   * @returns {{ content: string, round: string, count: string, title: string }}
   *   content：分好幾段內容時才有（目前這一段的內容名），round：目前講次，count：同一內容共幾講
   */
  function roundPickerLabel(payload) {
    const rounds = (payload && payload.rounds) || [];
    const groups = roundGroups(payload);
    const cur = payload ? payload.roundIndex : -1, cr = rounds[cur] || {};
    const cg = groups.find(g => g.rounds.includes(cur)) || { topic: cr.label || '', rounds: [cur] };
    const multi = groups.length > 1;
    return {
      content: multi ? cg.topic : '',
      round: cr.label || '',
      count: cg.rounds.length > 1 ? `共 ${cg.rounds.length} 講` : '',
      title: multi
        ? `這部經論有 ${groups.length} 段內容、共講過 ${rounds.length} 次；點此換內容或講次`
        : `這部經論講過 ${rounds.length} 次；點此換講次`,
    };
  }

  const DOUBLE_TAP_MS = 260;

  const api = {
    DOUBLE_TAP_MS, makeTapGate,
    SCOPE_DEPTH, FULL_LEVELS, INDENT, MID_LEVELS, MID_INDENT, INDENT_CAP, JUMP_GAP, MIN_ROWS,
    expandNodes, ancestors, scopeOf, altFor, roundTarget, indentFor, computeExpanded, visibleRows,
    hereFromLine, hereInfo, headingSegments, juanOf, jumpScrollTop, spyLine, normalizeQuery, searchNodes,
    navTargets, navLabel, leafIds, seekLeaf, roundDetail, roundGroups, scopeOptions, scopeSections, CHAPTER_MARK, pathKeep, roundPickerLabel, shortTitle,
  };
  if (typeof document === 'undefined') return api;

  // ───────────── 瀏覽器接線 ─────────────

  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const LEAF_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 1.8h5.5L12.5 5v9.2H4z"/><path d="M6.3 8h4M6.3 10.8h4"/></svg>';
  const STORE = 'mdw-kepan-v1';
  const PATH_STORE = 'mdw-kepan-path-open';

  const S = {
    payload: null, N: null, dir: '', file: '', fileIndex: -1,
    rootId: 0, scopeAll: true, scopePick: '', hereId: 0,
    userOpen: new Set(), userClosed: new Set(), expanded: new Set(),
    rows: [], rowIndex: new Map(),
    anchors: [], anchorsDirty: true, barMax: 0,
    loadToken: 0, busyInTree: false, busyTimer: null,
    hay: [], found: [], active: -1, composing: false,
    leafs: null,          // 末端科 id 清單（navTargets 用，換樹時重建）
    inherited: false,     // 本篇沒有科判標題，目前科是承前借來的（地標列要寫明）
    noKepan: false,       // 本篇與前面都沒有科判可借
    scopeDepth: SCOPE_DEPTH, pendingAlt: null, virtual: false,
    pathOpen: (() => { try { return localStorage.getItem('mdw-kepan-path-open') === '1'; } catch (_) { return false; } })(),
  };
  // 資料夾 → { list: payload[], none: Set<檔名>, wait: Map<檔名, Promise> }。
  // 同一資料夾可能有好幾棵樹（每輪一棵、合輯每篇一棵），依檔名找所屬的那棵。
  const payloadCache = new Map();

  function loadPrefs(dir) {
    try { const all = JSON.parse(localStorage.getItem(STORE)) || {}; return all[dir] || {}; } catch (_) { return {}; }
  }
  function savePrefs() {
    try {
      const all = JSON.parse(localStorage.getItem(STORE)) || {};
      // pick：讀者自己在範圍選單選過才記（'all' 全文／'part' 某一段）；沒選過就照預設「全文（不分組）」
      all[S.dir] = { open: [...S.userOpen].slice(-300), pick: S.scopePick || undefined };
      localStorage.setItem(STORE, JSON.stringify(all));
    } catch (_) { /* 私密模式等：不記也能用 */ }
  }

  async function fetchPayload(filePath) {
    const parts = filePath.split('/');
    const name = parts.pop().replace(/\.md$/i, '');
    const dir = parts.join('/');
    let c = payloadCache.get(dir);
    if (!c) payloadCache.set(dir, (c = { list: [], none: new Set(), near: new Map(), wait: new Map() }));
    const known = c.list.find(p => p.files.includes(name) || p.toc === name);
    if (known) return known;
    if (c.none.has(name)) return null;
    if (c.wait.has(name)) return c.wait.get(name);
    const p = fetch('/api/kepan?path=' + encodeURIComponent(filePath))
      .then(r => (r.ok ? r.json() : { kepan: null }))
      .then(j => { if (j.nearby) c.near.set(name, j.nearby); return j.kepan || null; })
      .catch(() => null)
      .then(v => {
        c.wait.delete(name);
        if (!v) { c.none.add(name); return null; }
        // 同一棵樹已經有了（例：從總目錄進來）就沿用同一份，避免側欄重設
        const same = c.list.find(x => (x.key || x.dir) === (v.key || v.dir));
        if (same) { if (!same.files.includes(name)) same.toc = name; return same; }
        if (!v.files.includes(name)) v.toc = name;
        c.list.push(v);
        return v;
      });
    c.wait.set(name, p);
    return p;
  }

  // ── 側欄分頁：科判系列時以「科判」取代「大綱」 ──
  // mode：true 科判系列；false 不是；'none' 本篇沒有科判標題、但同一部經的其他講次有（v4.27.8：
  // 科判與大綱兩個分頁都留著，科判分頁裡說明並列出可去的講次）
  function setTabMode(mode) {
    const on = mode === true, none = mode === 'none';
    const kTab = document.querySelector('.sidebar-tab[data-tab="kepan"]');
    const tTab = document.querySelector('.sidebar-tab[data-tab="toc"]');
    if (!kTab || !tTab) return;
    const active = document.querySelector('.sidebar-tab.active');
    kTab.hidden = !on && !none;
    tTab.hidden = on;
    if (on && active === tTab) kTab.click();
    // 第一次讀到某部科判系列：從「檔案」自動換到「科判」分頁，讓人知道有科判樹（每部只一次；
    // 正在看搜尋結果時不搶走，v4.27.9）
    else if (on && active && active.dataset.tab === 'files' && S.dir && !seenBook(S.dir)) kTab.click();
    if (on && S.dir) markSeen(S.dir);
    if (!on && !none && active === kTab) tTab.click();
    $('kepanBar').hidden = !on;
    $('kepanNav').hidden = !on;
    document.body.classList.toggle('has-kepan', on);
    const panel = $('panelKepan');
    if (panel) panel.classList.toggle('is-none', none);
    if ($('kepanNone')) $('kepanNone').hidden = !none;
  }

  const SEEN_STORE = 'mdw-kepan-seen';
  function seenBook(dir) {
    try { return (JSON.parse(localStorage.getItem(SEEN_STORE)) || []).includes(dir); } catch (_) { return true; }
  }
  function markSeen(dir) {
    try {
      const all = JSON.parse(localStorage.getItem(SEEN_STORE)) || [];
      if (!all.includes(dir)) { all.push(dir); localStorage.setItem(SEEN_STORE, JSON.stringify(all.slice(-200))); }
    } catch (_) { /* 私密模式：每次都換也無妨 */ }
  }

  // 操作說明（v4.27.13）：原本樹頂有一條要按「知道了」才收的提示（v4.27.9），在私密瀏覽、
  // localStorage 被擋或舊快取時每次都冒出來、關不掉。改成搜尋框旁的「?」小鈕：
  // 說明只在按了才出現，點別處／Esc／再按一次就收；從沒看過的人鈕上有個小點，看過一次就不再有。
  // 記不住（私密模式）也只是多一個小點，不擋樹。
  const HINT_STORE = 'mdw-kepan-hint-done';
  function hintSeen() {
    try { return localStorage.getItem(HINT_STORE) === '1'; } catch (_) { return false; }
  }
  function helpHtml(touch) {
    const rows = [
      ['點科名', '跳到那一科閱讀'],
      [touch ? '點 ＋／−，或連點兩下' : '點 ＋／−，或雙擊', '展開、收合子科'],
      ['搜尋框', '打科名或科判字（如 丙一）'],
      ['範圍選單', '只看其中一段，或全文'],
    ];
    if (!touch) rows.push(['鍵盤 [ ／ ]', '前一科／後一科']);
    return '<div class="kepan-help-head"><span>科判樹怎麼用</span>'
      + '<button type="button" class="kepan-help-close" data-help-close aria-label="關閉說明">✕</button></div>'
      + '<dl class="kepan-help-list">' + rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('') + '</dl>';
  }
  function renderHint() {
    const btn = $('kepanHelpBtn');
    if (btn) btn.classList.toggle('is-new', !hintSeen());
  }
  function setHelp(open) {
    const btn = $('kepanHelpBtn'), box = $('kepanHelp');
    if (!btn || !box) return;
    if (open) {
      const touch = typeof matchMedia === 'function' && matchMedia('(hover: none)').matches;
      box.innerHTML = helpHtml(touch);
      try { localStorage.setItem(HINT_STORE, '1'); } catch (_) { /* 記不住也無妨 */ }
      btn.classList.remove('is-new');
    }
    box.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  function initHelp() {
    const btn = $('kepanHelpBtn'), box = $('kepanHelp');
    if (!btn || !box) return;
    renderHint();
    btn.addEventListener('click', e => { e.stopPropagation(); setHelp(box.hidden); });
    box.addEventListener('click', e => { if (e.target.closest('[data-help-close]')) { setHelp(false); btn.focus(); } });
    document.addEventListener('click', e => {
      if (!box.hidden && !box.contains(e.target) && e.target !== btn) setHelp(false);
    }, true);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !box.hidden) { setHelp(false); btn.focus(); }
    });
  }

  /** 本篇沒有科判：說明，並列出本經有科判的講次（點了開那一講的第一篇） */
  /**
   * 這棵樹有幾處層級存疑（v4.27.16）：只在地標列末尾放一顆小標記，
   * 點開才列出前幾筆（檔案:行 + 說明），可跳到那一行核對原文。
   * 不改抽取結果，只是把伺服器已經算好的 problems 說明出來。
   */
  function renderProblems() {
    const box = $('kepanProblems'), P = S.payload;
    if (!box) return;
    const n = (P && P.problems) || 0;
    box.hidden = !n;
    if (!n) { box.innerHTML = ''; return; }
    const sample = (P.problemSample || []).map(text => {
      // 「檔名:行：說明」→ 可點的按鈕
      const m = String(text).match(/^(.*?):(\d+)：(.+)$/);
      if (!m) return `<li class="kepan-problem-item">${esc(String(text))}</li>`;
      return `<li class="kepan-problem-item"><button type="button" class="kepan-problem-go" data-problem-file="${esc(m[1])}" data-problem-line="${m[2]}" title="跳到原文那一行核對">`
        + `<span class="kp-at">${esc(m[1])}:${esc(m[2])}</span>`
        + `<span class="kp-msg">${esc(m[3])}</span></button></li>`;
    }).join('');
    box.innerHTML = `<button type="button" class="kepan-problem-toggle" id="kepanProblemBtn" aria-expanded="false" title="這棵科判樹有 ${n} 處層級存疑（多為原文誤植或標題格式特殊），點開看前幾筆">`
      + `層級存疑 ${n}</button>`
      + `<div class="kepan-problem-list" id="kepanProblemList" hidden>`
      + `<p class="kepan-problem-head">抽取時層級接不上，已就近接續。多為原文誤植或標題格式特殊，可點擊核對：</p>`
      + `<ul>${sample}</ul>`
      + (n > (P.problemSample || []).length ? `<p class="kepan-problem-more">另有 ${n - P.problemSample.length} 筆未列出</p>` : '')
      + '</div>';
  }

  function setProblemList(open) {
    const btn = $('kepanProblemBtn'), list = $('kepanProblemList');
    if (!btn || !list) return;
    list.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  }

  function renderNone(near) {
    const box = $('kepanNone');
    if (!box) return;
    const list = (near.others || []).map(o =>
      `<button type="button" class="kepan-none-item" data-none-file="${esc(o.file)}">`
      + `<span class="kni-label">${esc(o.label)}</span>`
      + (o.topic && o.topic !== o.label ? `<span class="kni-topic">${esc(o.topic)}</span>` : '')
      + `<span class="kni-n">${o.n} 科</span></button>`).join('');
    // 合輯（per-file）時說明「這一部只有幾篇有科判」，免得讀者以為壞了（v4.27.16）
    const others = near.others || [];
    const sub = others.length
      ? `《${esc(near.title)}》以下講次有科判，可以切過去看：`
      : `《${esc(near.title)}》這部講記沒有科判標題。`;
    box.innerHTML = `<p class="kepan-none-msg">本篇沒有科判標題。</p>`
      + `<p class="kepan-none-sub">${sub}</p>`
      + (list ? `<div class="kepan-none-list">${list}</div>` : '')
      + `<p class="kepan-none-tip">本篇的段落請看「大綱」分頁。</p>`;
    box.dataset.dir = near.dir || '';
  }

  // ── 側欄樹 ──
  function rebuild() {
    const { N } = S;
    // 沒有任何「目前位置」時（剛開檔、還沒定位），至少展開到看得見幾列（v4.27.16）
    S.expanded = computeExpanded(N, S.userOpen, S.userClosed, S.hereId, S.hereId ? 0 : MIN_ROWS);
    S.rows = visibleRows(N, S.rootId, S.expanded);
    S.rowIndex = new Map(S.rows.map((id, i) => [id, i]));
    $('kepanSpacer').style.height = S.rows.length * ROW_HEIGHT + 'px';
    renderRows();
  }

  function renderRows() {
    const tree = $('kepanTree'), { N } = S;
    if (!tree || !N) return;
    const top = tree.scrollTop, h = tree.clientHeight || 600;
    const from = Math.max(0, Math.floor(top / ROW_HEIGHT) - 6);
    const to = Math.min(S.rows.length, Math.ceil((top + h) / ROW_HEIGHT) + 6);
    const onPath = new Set(S.hereId ? ancestors(N, S.hereId) : []);
    const base = S.rootId ? N[S.rootId].d : 0;
    const alt = S.payload && S.payload.rounds ? S.payload.alt : null;
    let html = '';
    for (let i = from; i < to; i++) {
      const id = S.rows[i], n = N[id], kids = n.k.length, open = S.expanded.has(id);
      const lv = n.d - base;
      let guides = '';
      // 深層只畫最近的一條線，避免一整排細線
      for (let a = 0; a < lv; a++) if (a < FULL_LEVELS || a === lv - 1) guides += `<i class="kepan-guide" style="left:${indentFor(a) + 15}px"></i>`;
      const cls = (kids ? 'is-branch' : 'is-leaf') + (id === S.hereId ? ' is-here' : onPath.has(id) ? ' is-onpath' : '');
      const toggle = kids
        ? `<button type="button" class="kepan-toggle" data-toggle title="${open ? '收合' : '展開'}（分${kids}科）" aria-expanded="${open}">${open ? '−' : '+'}</button>`
        : `<span class="kepan-leaf" title="末端科，點選閱讀">${LEAF_ICON}</span>`;
      html += `<div class="kepan-row ${cls}" data-id="${id}" role="treeitem" style="top:${i * ROW_HEIGHT}px;padding-left:${indentFor(lv) + 8}px" title="${esc(n.m + '、' + n.t)}（第 ${n.d + 1} 層${kids ? `；雙擊${open ? '收合' : '展開'}` : ''}）">`
        + guides + toggle + `<span class="kepan-mark">${esc(n.m)}</span><span class="kepan-title">${esc(shortTitle(n.t))}</span>`
        // 縮排到底（超過 MID_LEVELS 層）時，用 L18 這種小徽章補回「在第幾層」的資訊（v4.27.16）
        + (n.d > MID_LEVELS - 1 ? `<span class="kepan-depth">L${n.d + 1}</span>` : '')
        + (alt && alt[id] && alt[id].length ? `<span class="kepan-alt-dot" title="其他講次也講到這一科：${esc(alt[id].map(h => (S.payload.rounds[h[0]] || {}).label).join('、'))}"></span>` : '')
        + (kids && !open ? `<span class="kepan-count">分${kids}</span>` : '') + '</div>';
    }
    $('kepanSpacer').innerHTML = html;
  }

  // 講次選單（v4.27.0；v4.27.1 改稱講次、拿掉自動摘要）：以「講的內容」為主分組，同一內容才列出年份地點來選；只有一輪時不顯示
  function renderRounds() {
    const box = $('kepanRounds'), P = S.payload;
    if (!box) return;
    const rounds = P.rounds || [];
    box.hidden = rounds.length < 2;
    if (rounds.length < 2) { box.innerHTML = ''; return; }
    const groups = roundGroups(P);
    const cur = P.roundIndex;
    let menu = '';
    for (const g of groups) {
      const multi = g.rounds.length > 1;
      menu += `<div class="krm-group${multi ? ' is-multi' : ''}" role="group" aria-label="${esc(g.topic)}">`
        + `<div class="krm-topic"><span>${esc(g.topic)}</span>${multi ? `<span class="krm-badge">同一內容 ${g.rounds.length} 講</span>` : ''}</div>`;
      for (const i of g.rounds) {
        const r = rounds[i], on = i === cur;
        const size = `${r.n} 科` + (r.k > 1 ? `・${r.k} 篇` : '');
        const detail = roundDetail(r);
        menu += `<button type="button" class="krm-item${on ? ' is-current' : ''}" data-round="${i}" role="menuitemradio" aria-checked="${on}">`
          + `<span class="krm-line"><span class="krm-label">${esc(r.label)}</span><span class="krm-n">${size}</span></span>`
          + (detail ? `<span class="krm-detail">${esc(detail)}</span>` : '') + '</button>';
      }
      menu += '</div>';
    }
    // 按鈕（v4.27.8）：只有一段內容時一行「講次 2002–2003・共 2 講」；
    // 分好幾段內容（摩訶般若各品）時兩行，分別標「內容」與「講次」，不再寫「1／5 段」
    const pl = roundPickerLabel(P);
    box.innerHTML = `<button type="button" class="kepan-round-pick${pl.content ? '' : ' is-compact'}" id="kepanRoundPick" aria-haspopup="menu" aria-expanded="false" aria-controls="kepanRoundMenu" title="${esc(pl.title)}">`
      + (pl.content ? `<span class="krp-row"><span class="krp-k">內容</span><span class="krp-topic">${esc(pl.content)}</span></span>` : '')
      + `<span class="krp-row"><span class="krp-k">講次</span><span class="krp-value">${esc(pl.round)}</span>`
      + (pl.count ? `<span class="krp-meta">${esc(pl.count)}</span>` : '') + '</span>'
      + `<span class="krp-caret" aria-hidden="true">⌄</span></button>`
      + `<div class="kepan-round-menu" id="kepanRoundMenu" role="menu" aria-label="選擇講次" hidden>${menu}</div>`;
  }

  function setRoundMenu(open) {
    const pick = $('kepanRoundPick'), menu = $('kepanRoundMenu');
    if (!pick || !menu) return;
    menu.hidden = !open;
    pick.setAttribute('aria-expanded', String(open));
    if (open) {
      const cur = menu.querySelector('.krm-item.is-current') || menu.querySelector('.krm-item');
      if (cur) { cur.scrollIntoView({ block: 'nearest' }); cur.focus({ preventScroll: true }); }
    }
  }

  // 跳到另一輪：有對照的科就到那一科，否則到該輪第一篇
  function goRound(ri, viaAlt) {
    const P = S.payload;
    if (!P || !P.rounds || !P.rounds[ri] || ri === P.roundIndex) return;
    const t = viaAlt || roundTarget(P, S.N, S.hereId, ri);
    const file = (P.dir ? P.dir + '/' : '') + t.file + '.md';
    S.pendingAlt = t.id ? { key: P.dir + '#' + P.rounds[ri].label, id: t.id, line: t.line } : null;
    S.pendingHere = 0;
    if (typeof window.mdwOpenFile === 'function') {
      S.lockSpyUntil = Date.now() + 5000;
      window.mdwOpenFile(file, t.line || undefined);
    }
    if (window.innerWidth <= 768 && typeof window.mdwCloseMobileSidebars === 'function') window.mdwCloseMobileSidebars();
  }

  function renderScopeSelect() {
    const { N } = S, sel = $('kepanScope');
    // 第一項是整棵樹、不分組（v4.27.5 起固定寫「全文（不分組）」；書名已在側欄標題與地標列）
    // 範圍分屬不同上層時依上層分組（v4.27.7）：否則會出現兩個「乙一」分不出來
    let html = `<option value="0">${ALL_LABEL}</option>`;
    // 章節式標題的樹：把「序與附說」與「章」分成兩組，43 章中間不再夾著 6 節（v4.27.16）
    for (const g of scopeSections(N, S.scopeDepth)) {
      const items = g.items.map(n => `<option value="${n.id}">${esc(n.m + ' ' + shortTitle(n.t))}</option>`).join('');
      const label = g.label || (g.parent ? N[g.parent].m + ' ' + shortTitle(N[g.parent].t) : '');
      html += label ? `<optgroup label="${esc(label)}">${items}</optgroup>` : items;
    }
    sel.innerHTML = html;
    sel.value = String(S.rootId);
  }

  function setScope(id, announce) {
    if (S.rootId === id) return;
    S.rootId = id;
    $('kepanScope').value = String(id);
    $('kepanTree').scrollTop = 0;
    if (announce && id && Date.now() > (S.quietUntil || 0)) {
      const t = $('kepanToast');
      t.textContent = `已進入 ${S.N[id].m} ${S.N[id].t}`;
      t.hidden = false;
      clearTimeout(t._timer);
      t._timer = setTimeout(() => { t.hidden = true; }, 2500);
    }
  }

  function keepVisible(id) {
    const tree = $('kepanTree'), i = S.rowIndex.get(id);
    if (i === undefined || !tree.clientHeight) return;
    const y = i * ROW_HEIGHT;
    if (y < tree.scrollTop || y + ROW_HEIGHT > tree.scrollTop + tree.clientHeight) tree.scrollTop = y - tree.clientHeight * 0.35;
  }

  function setHere(id, fromScroll) {
    if (!id || id === S.hereId) return;
    const tree = $('kepanTree');
    const anchor = S.hereId && S.rowIndex.has(S.hereId) ? S.rowIndex.get(S.hereId) * ROW_HEIGHT - tree.scrollTop : null;
    const sc = scopeOf(S.N, id, S.scopeDepth);
    const crossed = !S.scopeAll && sc !== S.rootId;
    if (crossed) setScope(sc, S.hereId !== 0);
    S.hereId = id;
    rebuild();
    // 沿主幹往下讀時，目前所在的列停在原來的高度附近，不跳
    if (anchor !== null && !crossed && S.rowIndex.has(id)) tree.scrollTop = S.rowIndex.get(id) * ROW_HEIGHT - anchor;
    renderRows();
    if (!fromScroll || !S.busyInTree) keepVisible(id);
    renderBar();
  }

  function toggle(id) {
    const tree = $('kepanTree');
    const before = S.rowIndex.get(id) * ROW_HEIGHT - tree.scrollTop;
    if (S.expanded.has(id)) { S.userOpen.delete(id); S.userClosed.add(id); }
    else { S.userOpen.add(id); S.userClosed.delete(id); }
    rebuild();
    if (S.rowIndex.has(id)) tree.scrollTop = S.rowIndex.get(id) * ROW_HEIGHT - before;   // 被點的那一列不動
    renderRows();
    savePrefs();
  }

  // ── 閱讀框：地標列、完整路徑、前後科 ──
  function renderBar() {
    const { N } = S, id = S.hereId;
    if (!id) return;
    const juan = juanOf(document.title);
    const pct = Math.round(id / (N.length - 1) * 100);
    const P = S.payload;
    const a = altFor(P, N, id);
    const alt = a ? `<span class="kepan-alt" title="${esc(a.id === id ? '同一科在其他講次也講過，點講次名稱過去' : `上層「${N[a.id].m} ${shortTitle(N[a.id].t)}」在其他講次也講過`)}">其他講次：`
      + a.hits.map(h => `<a href="#" data-alt-round="${h[0]}" data-alt-id="${h[3]}" data-alt-file="${esc(h[1])}" data-alt-line="${h[2]}">${esc(P.rounds[h[0]].label)}</a>`).join('')
      + '</span>' : '';
    // 本篇沒有科判標題時，寫明這個位置是「承前」來的，不假裝讀者在這一科（v4.27.16）
    const inheritNote = S.inherited
      ? `<span class="kepan-inherit" title="這篇沒有科判標題，位置沿用前一篇最後一科；點路徑可前往那一科">承前</span>` : '';
    $('kepanLandmark').innerHTML =
      (juan ? `<span>卷${esc(juan)}</span>` : '')
      + (N[id].pg ? `<span>《披尋記》p.${N[id].pg}</span>` : '')
      + (S.inherited ? inheritNote : `<span>第 ${N[id].d + 1} 層</span>`)
      + `<span class="kepan-progress" title="目前這一科在「${esc(P.title)}」全部 ${N.length - 1} 科中的位置"><i style="width:${pct}%"></i></span><span>${pct}%</span>`
      + alt;
    // 路徑預設只留最後幾層（目前科一定看得到），前面收成「⋯ 上 N 層」，點了展開完整路徑（v4.27.7）
    const chain = ancestors(N, id).concat(id);
    const keep = pathKeep(window.innerWidth);
    const hidden = S.pathOpen ? 0 : Math.max(0, chain.length - keep);
    const links = chain.slice(hidden).map(x => {
      const n = N[x], sib = N[n.p].k;
      const pos = sib.length > 1 ? `<small>${sib.indexOf(x) + 1}/${sib.length}</small>` : '';
      const cur = x === id && !S.inherited;
      return `<a href="#" data-go="${x}"${cur ? ' class="is-current" aria-current="location"' : ''} title="${esc(n.m + '、' + n.t)}">${esc(n.m)} ${esc(shortTitle(n.t))}${pos}</a>`;
    }).join('<span class="kepan-sep">›</span>');
    const more = hidden
      ? `<button type="button" class="kepan-path-more" data-path-toggle aria-expanded="false" title="顯示完整路徑：${esc(chain.slice(0, hidden).map(x => N[x].m + ' ' + shortTitle(N[x].t)).join(' › '))}">⋯ 上 ${hidden} 層</button><span class="kepan-sep">›</span>`
      : '';
    const less = S.pathOpen && chain.length > keep
      ? `<button type="button" class="kepan-path-more is-open" data-path-toggle aria-expanded="true" title="只顯示最後幾層">收起</button>` : '';
    const path = $('kepanPath');
    path.innerHTML = more + links + less;
    if (S.pathOpen) path.scrollTop = path.scrollHeight;   // 展開後若仍在列內捲動，停在目前科
    const t = navTargets(N, id, S.leafs || (S.leafs = leafIds(N)));
    const nx = t.next ? N[t.next] : null, pv = t.prev ? N[t.prev] : null;
    setNavBtn($('kepanPrev'), pv, '前一科', '已是第一科');
    setNavBtn($('kepanNext'), nx, '後一科', '已是最後一科');
  }

  // 前後科按鈕：按鈕上寫該科科名（不寫目前科名）；首末科停用
  function setNavBtn(btn, n, kind, edge) {
    if (!btn) return;
    const name = navLabel(n, edge);
    btn.disabled = !n;
    const span = btn.querySelector('.kepan-nav-name');
    if (span) span.textContent = name; else btn.textContent = name;
    btn.title = n ? `${kind}：${n.m}、${n.t}（鍵盤 ${kind === '前一科' ? '[' : ']'}）` : edge;
    btn.setAttribute('aria-label', n ? `${kind}：${n.m} ${n.t}` : edge);
  }

  // 點側欄或路徑上的科：打開所在講記並捲到該科標題
  function goTo(id) {
    const { N, payload } = S;
    let target = id;
    while (!N[target].l && N[target].k.length) target = N[target].k[0];
    const n = N[target];
    if (n.f < 0) return;
    const file = (payload.dir ? payload.dir + '/' : '') + payload.files[n.f] + '.md';
    S.pendingHere = id;
    S.pendingLine = n.l;
    if (file === S.file) {
      // 先把地標列換成目標科（路徑長短會改變列高），再依新的列高捲動
      setHere(id);
      scrollToLine(n.l);
    } else if (typeof window.mdwOpenFile === 'function') {
      // 換檔期間舊文件的捲動事件不算數；先把側欄標到目標科
      S.lockSpyUntil = Date.now() + 5000;
      setHere(id);
      window.mdwOpenFile(file, n.l);
    }
    if (window.innerWidth <= 768 && typeof window.mdwCloseMobileSidebars === 'function') window.mdwCloseMobileSidebars();
  }

  /** 閱讀框頂端黏性地標列目前的高度（會換行、手機上更高，隨所在的科而變）。 */
  function barHeight() {
    const bar = $('kepanBar');
    const h = bar && !bar.hidden ? bar.getBoundingClientRect().height || 0 : 0;
    if (h > S.barMax) S.barMax = h;
    return h;
  }

  function scrollToLine(line) {
    if (S.virtual) {
      // 大檔：目標段落可能還沒掛上，交給 app.js 的虛擬捲動（它也會讓開地標列）
      S.lockSpyUntil = Date.now() + 1500;
      if (typeof window.mdwScrollToLine === 'function') {
        Promise.resolve(window.mdwScrollToLine(line)).then(() => { S.lockSpyUntil = Date.now() + 300; });
      }
      return;
    }
    const content = $('content'), el = document.getElementById('L' + line);
    if (!content || !el) return;
    const target = el.closest('h1, h2, h3, h4, h5, h6') || el;
    const top = jumpScrollTop(target.getBoundingClientRect().top, content.getBoundingClientRect().top, content.scrollTop, barHeight());
    S.lockSpyUntil = Date.now() + 400;
    content.scrollTop = top;
  }

  // ── 捲動定位 ──
  function collectAnchors() {
    const content = $('content'), hs = S.payload.heads[S.fileIndex] || [];
    const cTop = content.getBoundingClientRect().top - content.scrollTop;
    S.anchors = [];
    for (const [line] of hs) {
      const el = document.getElementById('L' + line);
      if (!el) continue;
      const h = el.closest('h1, h2, h3, h4, h5, h6') || el;
      S.anchors.push([h.getBoundingClientRect().top - cTop, line]);
    }
    S.anchorsDirty = false;
  }

  function spy() {
    if (!S.payload || S.fileIndex < 0) return;
    if (S.lockSpyUntil && Date.now() < S.lockSpyUntil) return;
    let line = 0;
    if (S.virtual) line = virtualSpyLine();
    else {
      if (S.anchorsDirty) collectAnchors();
      const y = spyLine($('content').scrollTop, S.barMax);
      for (const [top, l] of S.anchors) { if (top <= y) line = l; else break; }
    }
    const info = hereInfo(S.payload, S.fileIndex, line);
    const id = info.id;
    // 這篇自己沒有科判標題時，記下來：地標列要寫「承前」，不能假裝讀者在這一科（v4.27.16）
    S.inherited = !!info.inherited;
    S.noKepan = !!info.none;
    // 剛點選的上層科與子科共用同一行標題時，保留點選的那一層
    // 同一行並列的多個終端科（共用一段文）也算：點了「辛一」不要被改回同行最後的「辛二」
    const sameLine = S.pendingHere && S.N[id] && S.N[S.pendingHere] && S.N[id].f === S.N[S.pendingHere].f && S.N[id].l === S.N[S.pendingHere].l;
    if (S.pendingHere && (id === S.pendingHere || sameLine || ancestors(S.N, id).includes(S.pendingHere))) {
      S.inherited = false;   // 使用者剛點過，位置是明確的，不是承前
      if (S.N[S.pendingHere].l === line || !line) return setHere(S.pendingHere, true);
    }
    S.pendingHere = 0;
    setHere(id, true);
  }

  /**
   * 大檔（虛擬捲動）的閱讀位置：只有附近幾段掛在畫面上，不能事先量好所有標題。
   * 以畫面頂端那一行為底，再看已掛上的科判標題有沒有已經捲進地標列下緣。
   */
  function virtualSpyLine() {
    const top = typeof window.mdwVirtualTopLine === 'function' ? window.mdwVirtualTopLine() : -1;
    let line = top > 0 ? top : 0;
    const content = $('content'), hs = S.payload.heads[S.fileIndex] || [];
    const y = content.getBoundingClientRect().top + S.barMax + JUMP_GAP + 4;
    for (const [l] of hs) {
      if (l <= line) continue;
      const el = document.getElementById('L' + l);
      if (!el) continue;
      const h = el.closest('h1, h2, h3, h4, h5, h6') || el;
      if (h.getBoundingClientRect().top <= y) line = l; else break;
    }
    return line;
  }

  // 一行多層的科判標題，改繪成由淺到深的階梯；保留行號錨點與標題 id
  function restyleHeadings() {
    if (S.payload.chapters) return;   // 章節式標題本來就一行一層，不必改繪
    const hs = S.payload.heads[S.fileIndex] || [];
    for (const [line] of hs) {
      const el = document.getElementById('L' + line);
      const h = el && el.closest('h1, h2, h3, h4, h5, h6');
      if (!h || h.classList.contains('kepan-heading')) continue;
      const segs = headingSegments(h.textContent);
      if (!segs.length) continue;
      // 行號錨點原封不動搬回去：app.js 的行號快取與「跳到某行」都指向這些節點
      const anchors = Array.from(h.querySelectorAll('.line-anchor'));
      h.classList.add('kepan-heading');
      h.textContent = '';
      anchors.forEach(a => h.appendChild(a));
      h.insertAdjacentHTML('beforeend', segs.map(s =>
        `<span class="kepan-seg">${s.mark ? `<span class="kepan-mark">${esc(s.mark)}</span>` : ''}${esc(s.title)}${s.split ? `<small>${esc(s.split)}</small>` : ''}</span>`).join(''));
    }
  }

  // ── 快速搜尋科名（v4.21.0）：下拉選單下方的搜尋框，結果暫時取代樹 ──
  const RESULT_LIMIT = 200;

  function markHit(text, query) {
    const lower = text.toLowerCase(), on = new Array(text.length).fill(false);
    for (const t of String(query).toLowerCase().split(/[\s\u3000]+/).filter(Boolean)) {
      const i = lower.indexOf(t);
      if (i >= 0) for (let j = i; j < i + t.length; j++) on[j] = true;
    }
    let html = '', open = false;
    for (let j = 0; j < text.length; j++) {
      if (on[j] !== open) { html += on[j] ? '<mark>' : '</mark>'; open = on[j]; }
      html += esc(text[j]);
    }
    return html + (open ? '</mark>' : '');
  }

  function runSearch() {
    const input = $('kepanSearch'), box = $('kepanResults');
    if (!input || !S.N) return;
    const q = input.value.trim();
    $('kepanSearchClear').hidden = !input.value;
    if (!q) { showResults(false); return; }
    const { ids, total, inScope } = searchNodes(S.N, q, { rootId: S.rootId, limit: RESULT_LIMIT, hay: S.hay, scopeDepth: S.scopeDepth });
    S.found = ids;
    S.active = ids.length ? 0 : -1;
    const { N } = S;
    let html = `<div class="kepan-results-head" role="presentation">`
      + (total ? `找到 ${total} 科${S.rootId && inScope && inScope < total ? `（目前範圍內 ${inScope}）` : ''}${total > ids.length ? `，先列 ${ids.length} 科` : ''}` : '沒有符合的科名')
      + `<span class="kepan-results-keys">Enter 前往・Esc 清除</span></div>`;
    ids.forEach((id, i) => {
      const n = N[id], sc = scopeOf(N, id, S.scopeDepth), par = n.p > 0 ? N[n.p] : null;
      const where = [sc && sc !== id ? N[sc].m + ' ' + shortTitle(N[sc].t) : '', par && par.id !== sc ? par.m + ' ' + shortTitle(par.t) : '']
        .filter(Boolean).join(' › ');
      html += `<div class="kepan-hit${i === S.active ? ' is-active' : ''}" id="kepanHit${i}" role="option" aria-selected="${i === S.active}" data-hit="${id}" title="${esc(n.m + '、' + n.t)}">`
        + `<div class="kepan-hit-title"><span class="kepan-mark">${markHit(n.m, q)}</span>${markHit(n.t, q)}</div>`
        + `<div class="kepan-hit-where">${esc(where)}<small class="kepan-hit-level">第 ${n.d + 1} 層</small></div></div>`;
    });
    box.innerHTML = html;
    box.scrollTop = 0;
    showResults(true);
  }

  function showResults(on) {
    const input = $('kepanSearch'), box = $('kepanResults');
    if (!box) return;
    box.hidden = !on;
    $('kepanTree').hidden = on;
    input.setAttribute('aria-expanded', String(on));
    if (on && S.active >= 0) input.setAttribute('aria-activedescendant', 'kepanHit' + S.active);
    else input.removeAttribute('aria-activedescendant');
    if (!on) { S.found = []; S.active = -1; box.innerHTML = ''; requestAnimationFrame(renderRows); }
  }

  function clearSearch() {
    const input = $('kepanSearch');
    if (!input) return;
    input.value = '';
    $('kepanSearchClear').hidden = true;
    showResults(false);
  }

  function setActive(i) {
    if (!S.found.length) return;
    const n = S.found.length;
    S.active = (i + n) % n;
    const box = $('kepanResults');
    box.querySelectorAll('.kepan-hit.is-active').forEach(el => { el.classList.remove('is-active'); el.setAttribute('aria-selected', 'false'); });
    const el = $('kepanHit' + S.active);
    if (el) {
      el.classList.add('is-active');
      el.setAttribute('aria-selected', 'true');
      el.scrollIntoView({ block: 'nearest' });
    }
    $('kepanSearch').setAttribute('aria-activedescendant', 'kepanHit' + S.active);
  }

  // 選了一個結果：清掉搜尋、回到樹並把該科攤開在畫面上，同時打開所在講記捲到那裡
  function chooseHit(id) {
    if (!id || !S.N[id]) return;
    clearSearch();
    for (const a of ancestors(S.N, id)) S.userClosed.delete(a);
    S.busyInTree = false;
    if (!S.scopeAll) setScope(scopeOf(S.N, id, S.scopeDepth), false);
    if (id === S.hereId) { rebuild(); keepVisible(id); }
    goTo(id);
    requestAnimationFrame(() => { renderRows(); keepVisible(id); });
  }

  function initSearch() {
    const input = $('kepanSearch');
    if (!input) return;
    input.addEventListener('compositionstart', () => { S.composing = true; });
    input.addEventListener('compositionend', () => { S.composing = false; runSearch(); });
    input.addEventListener('input', e => {
      // 注音、倉頡等輸入法選字時不搜尋，選定後（compositionend）再搜
      if (S.composing || e.isComposing) return;
      runSearch();
    });
    input.addEventListener('keydown', e => {
      if (e.isComposing || S.composing || e.keyCode === 229) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(S.active + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(S.active - 1); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (!S.found.length && input.value.trim()) runSearch();
        if (S.found.length) chooseHit(S.found[Math.max(0, S.active)]);
      } else if (e.key === 'Escape') {
        if (input.value) { e.preventDefault(); e.stopPropagation(); clearSearch(); }
        else input.blur();
      }
    });
    $('kepanSearchClear').addEventListener('click', () => { clearSearch(); input.focus(); });
    $('kepanResults').addEventListener('mousedown', e => { if (e.target.closest('[data-hit]')) e.preventDefault(); });
    $('kepanResults').addEventListener('click', e => {
      const hit = e.target.closest('[data-hit]');
      if (hit) chooseHit(+hit.dataset.hit);
    });
  }

  // ── 對外：由 app.js 呼叫 ──
  async function onDocumentRendered(filePath) {
    const token = ++S.loadToken;
    if (!filePath || filePath.startsWith('dict:')) { setTabMode(false); return; }
    const payload = await fetchPayload(filePath);
    if (token !== S.loadToken) return;
    if (!payload) {
      const parts = filePath.split('/'), nm = parts.pop().replace(/\.md$/i, '');
      const c = payloadCache.get(parts.join('/'));
      const near = c && c.near.get(nm);
      S.payload = null;
      if (near) { renderNone(near); setTabMode('none'); } else setTabMode(false);
      return;
    }
    const name = filePath.split('/').pop().replace(/\.md$/i, '');
    if (S.payload !== payload) {
      S.payload = payload;
      S.N = expandNodes(payload);
      S.leafs = null;
      S.dir = payload.key || payload.dir;
      S.scopeDepth = payload.scopeDepth === undefined ? SCOPE_DEPTH : payload.scopeDepth;
      S.hereId = 0;
      // 從另一輪的「另講」或講輪鈕過來：換成這棵樹裡的那一科
      const pa = S.pendingAlt;
      S.pendingAlt = null;
      if (pa && pa.key === S.dir && S.N[pa.id]) { S.pendingHere = pa.id; S.pendingLine = S.N[pa.id].l || pa.line; }
      else S.pendingHere = 0;
      const prefs = loadPrefs(S.dir);
      S.userOpen = new Set(prefs.open || []);
      S.userClosed = new Set();
      // v4.27.12 起預設「全文（不分組）」；只有讀者自己選過某一段才跟著讀到的段落換範圍。
      // 舊版存的 all:false 分不出是選過還是只展開過，一律當沒選過
      S.scopePick = prefs.pick === 'part' || prefs.pick === 'all' ? prefs.pick : '';
      S.scopeAll = S.scopePick !== 'part';
      S.rootId = -1;
      S.hay = [];
      clearSearch();
      renderScopeSelect();
      renderRounds();
      renderHint();
      renderProblems();
    }
    // 開檔後第一次定位不提示「已進入…」（讀者沒有跨範圍，只是剛打開）
    if (S.file !== filePath) S.quietUntil = Date.now() + 2500;
    S.file = filePath;
    S.fileIndex = payload.files.indexOf(name);
    S.virtual = typeof window.mdwIsVirtual === 'function' && !!window.mdwIsVirtual();
    setTabMode(true);
    S.barMax = 0;
    restyleHeadings();
    S.anchorsDirty = true;
    if (S.rootId === -1) { S.rootId = 0; $('kepanScope').value = '0'; }   // 選單初始在整棵樹，不留空白
    const want = S.pendingHere;
    if (want && S.N[want]) {
      // 從側欄或前後科換檔過來：openFile 稍後才捲到該行，等它捲完再恢復依捲動定位
      // 標題改繪會改變高度，所以由這裡再捲一次到目標行（app.js 的捲動可能早於改繪）
      const line = S.pendingLine;
      S.hereId = 0;
      setHere(want);
      if (S.virtual) {
        // 大檔：openFile 已用虛擬捲動到該行，不再重捲，只等它定位完
        S.lockSpyUntil = Date.now() + 1500;
        setTimeout(() => { if (token === S.loadToken) { S.lockSpyUntil = 0; spy(); } }, 1600);
      } else {
        scrollToLine(line);
        S.lockSpyUntil = Date.now() + 900;
        setTimeout(() => { if (token === S.loadToken) scrollToLine(line); }, 250);
        setTimeout(() => { if (token === S.loadToken) { S.lockSpyUntil = 0; spy(); } }, 950);
      }
    } else {
      S.lockSpyUntil = 0;
      spy();
    }
    if (!S.hereId) rebuild();
  }

  /** 大檔虛擬捲動新掛上一段（app.js 呼叫）：改繪其中的科判標題 */
  function onChunkMounted() {
    if (!S.payload || !S.virtual || S.fileIndex < 0) return;
    restyleHeadings();
  }

  function onDocumentClosed() {
    S.loadToken++;
    S.file = ''; S.fileIndex = -1;
    setTabMode(false);
  }

  function init() {
    if (!$('kepanTree')) return;
    // 有子科的列：單擊跳轉（稍等一下）、雙擊展開／收合；末端科與 +/− 鈕立即反應。
    // 鍵盤（Enter／空白鍵觸發的 click，detail 為 0）不等。
    const gate = makeTapGate(DOUBLE_TAP_MS);
    $('kepanSpacer').addEventListener('click', e => {
      const row = e.target.closest('.kepan-row');
      if (!row) return;
      const id = +row.dataset.id;
      if (e.target.closest('[data-toggle]')) { gate.cancel(); toggle(id); return; }
      if (!S.N || !S.N[id] || !S.N[id].k.length || e.detail === 0) { gate.flush(); goTo(id); return; }
      gate.tap(id, goTo, toggle);
    });
    // 雙擊時不要選取文字
    $('kepanSpacer').addEventListener('mousedown', e => {
      if (e.detail > 1 && e.target.closest('.kepan-row')) e.preventDefault();
    });
    $('kepanTree').addEventListener('scroll', () => {
      S.busyInTree = true;
      clearTimeout(S.busyTimer);
      S.busyTimer = setTimeout(() => { S.busyInTree = false; }, 1500);
      requestAnimationFrame(renderRows);
    }, { passive: true });
    $('kepanScope').addEventListener('change', e => {
      const id = +e.target.value;
      S.scopeAll = id === 0;
      S.scopePick = id === 0 ? 'all' : 'part';
      setScope(id, false);
      rebuild();
      keepVisible(S.hereId);
      savePrefs();
      if ($('kepanSearch') && $('kepanSearch').value.trim()) runSearch();   // 換地後「本地」排序跟著變
    });
    initSearch();
    initHelp();
    // 鍵盤 [ ／ ]：前一科／後一科（v4.27.9；不在輸入框、不帶修飾鍵時）
    document.addEventListener('keydown', e => {
      if (e.key !== '[' && e.key !== ']') return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      if (!document.body.classList.contains('has-kepan')) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      step(e.key === '[' ? 'prev' : 'next');
    });
    if ($('kepanNone')) {
      $('kepanNone').addEventListener('click', e => {
        const b = e.target.closest('[data-none-file]');
        if (!b || typeof window.mdwOpenFile !== 'function') return;
        const dir = $('kepanNone').dataset.dir;
        window.mdwOpenFile((dir ? dir + '/' : '') + b.dataset.noneFile + '.md');
        if (window.innerWidth <= 768 && typeof window.mdwCloseMobileSidebars === 'function') window.mdwCloseMobileSidebars();
      });
    }
    if ($('kepanRounds')) {
      const box = $('kepanRounds');
      box.addEventListener('click', e => {
        if (e.target.closest('#kepanRoundPick')) { setRoundMenu($('kepanRoundMenu').hidden); return; }
        const b = e.target.closest('[data-round]');
        if (!b) return;
        setRoundMenu(false);
        goRound(+b.dataset.round);
      });
      box.addEventListener('keydown', e => {
        const menu = $('kepanRoundMenu');
        if (!menu || menu.hidden) return;
        if (e.key === 'Escape') { e.preventDefault(); setRoundMenu(false); $('kepanRoundPick').focus(); return; }
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        const items = [...menu.querySelectorAll('.krm-item')];
        const i = items.indexOf(document.activeElement);
        const next = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
        if (next) next.focus();
      });
      document.addEventListener('click', e => {
        if (!e.target.closest('#kepanRounds')) setRoundMenu(false);
      });
    }
    if ($('kepanProblems')) {
      $('kepanProblems').addEventListener('click', e => {
        if (e.target.closest('#kepanProblemBtn')) { setProblemList($('kepanProblemList').hidden); return; }
        const go = e.target.closest('[data-problem-file]');
        if (!go || typeof window.mdwOpenFile !== 'function') return;
        const dir = S.payload && S.payload.dir;
        window.mdwOpenFile((dir ? dir + '/' : '') + go.dataset.problemFile + '.md', +go.dataset.problemLine);
        if (window.innerWidth <= 768 && typeof window.mdwCloseMobileSidebars === 'function') window.mdwCloseMobileSidebars();
      });
    }
    $('kepanLandmark').addEventListener('click', e => {
      const a = e.target.closest('[data-alt-round]');
      if (!a) return;
      e.preventDefault();
      goRound(+a.dataset.altRound, { file: a.dataset.altFile, line: +a.dataset.altLine, id: +a.dataset.altId });
    });
    $('kepanPath').addEventListener('click', e => {
      if (e.target.closest('[data-path-toggle]')) {
        S.pathOpen = !S.pathOpen;
        try { localStorage.setItem(PATH_STORE, S.pathOpen ? '1' : '0'); } catch (_) { /* 不記也能用 */ }
        renderBar();
        return;
      }
      const a = e.target.closest('[data-go]');
      if (!a) return;
      e.preventDefault();
      goTo(+a.dataset.go);
    });
    // 前後科只走末端科（v4.27.16）：停在分科時，後一科是它子樹的第一個末端科
    const step = key => {
      if (!S.N || !S.hereId) return;
      const id = navTargets(S.N, S.hereId, S.leafs || (S.leafs = leafIds(S.N)))[key];
      if (id) goTo(id);
    };
    $('kepanPrev').addEventListener('click', () => step('prev'));
    $('kepanNext').addEventListener('click', () => step('next'));
    const content = $('content');
    if (content) {
      let raf = 0;
      content.addEventListener('scroll', () => {
        if (raf) return;
        raf = requestAnimationFrame(() => { raf = 0; spy(); });
      }, { passive: true });
    }
    // 圖片載入、字級調整等會改變標題位置
    if (typeof ResizeObserver === 'function' && $('markdownBody')) {
      new ResizeObserver(() => { S.anchorsDirty = true; }).observe($('markdownBody'));
    }
    // 地標列在正文之前、佔版面：它變高變矮時，所有標題的位置都跟著移動
    if (typeof ResizeObserver === 'function' && $('kepanBar')) {
      new ResizeObserver(() => { S.anchorsDirty = true; barHeight(); }).observe($('kepanBar'));
    }
    window.addEventListener('resize', () => { S.anchorsDirty = true; renderRows(); if (S.N && S.hereId) renderBar(); });
    document.addEventListener('click', e => {
      if (e.target.closest('.sidebar-tab[data-tab="kepan"]')) requestAnimationFrame(() => { renderRows(); keepVisible(S.hereId); });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return Object.assign(api, { onDocumentRendered, onDocumentClosed, onChunkMounted, _state: S });
});
