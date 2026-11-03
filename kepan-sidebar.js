/**
 * 科判側欄（v4.20.0）。講記資料夾是科判系列時（伺服器 /api/kepan 判定），
 * 側欄的「大綱」換成「科判」：整部論的科判樹，閱讀時自動標出目前所在的科。
 *
 * 設計重點是「不迷路」：
 *   - 樹不會在閱讀時換根。一次只看一「地」（丙層），跨到下一地才換範圍，並短暫提示。
 *   - 只沿著目前閱讀位置那一條主幹展開；離開的分支自動收起（使用者自己打開的不收）。
 *   - 前 5 層正常縮排，更深的每層只縮 3px，四十層也放得進側欄寬度。
 *   - 可展開的科是帶框的 ＋／− 按鈕；末端科是書頁圖示，點了就讀。
 *   - 閱讀框頂端有地標列（卷、地、層數、全論位置）與從根到末端科的完整路徑；
 *     底部有前一科／後一科，跨卷時自動換檔。
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

  const SCOPE_DEPTH = 2;       // 以「丙」層（十七地）為一個範圍
  const FULL_LEVELS = 5;       // 前 5 層正常縮排
  const INDENT = 14;
  const DEEP_INDENT = 3;
  const ROW_HEIGHT = 28;
  const JUMP_GAP = 12;         // 跳到某科時，標題頂端與黏性地標列底緣的間距（同 app.js 跳行）

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
  function scopeOf(N, id) {
    if (!id || N[id].d < SCOPE_DEPTH) return 0;
    return ancestors(N, id).concat(id).find(x => N[x].d === SCOPE_DEPTH) || 0;
  }

  /** 第 level 層（範圍內相對層級）的縮排像素。 */
  function indentFor(level) {
    return level <= FULL_LEVELS ? level * INDENT : FULL_LEVELS * INDENT + (level - FULL_LEVELS) * DEEP_INDENT;
  }

  /** 展開的科 = 使用者打開的 ＋ 目前閱讀路徑上的（使用者手動收起的除外）。 */
  function computeExpanded(N, userOpen, userClosed, hereId) {
    const out = new Set(userOpen);
    if (hereId) for (const a of ancestors(N, hereId)) if (!userClosed.has(a)) out.add(a);
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
    const hs = payload.heads[fileIndex] || [];
    let lo = 0, hi = hs.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (hs[mid][0] <= line) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (best >= 0) return hs[best][1];
    for (let f = fileIndex - 1; f >= 0; f--) {
      const prev = payload.heads[f];
      if (prev && prev.length) return prev[prev.length - 1][1];
    }
    return hs.length ? hs[0][1] : 0;
  }

  /** 一行科判標題拆成段落，供閱讀框改繪成由淺到深的階梯。 */
  function headingSegments(text) {
    const NUM = '[一二三四五六七八九十]+';
    return String(text).replace(/ /g, ' ').trim()
      .split(new RegExp(`[\\s\\u3000]+(?=\\S${NUM}、?)|(?<=科）)(?=\\S${NUM}、)`))
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

  const api = {
    SCOPE_DEPTH, FULL_LEVELS, INDENT, DEEP_INDENT, JUMP_GAP,
    expandNodes, ancestors, scopeOf, indentFor, computeExpanded, visibleRows,
    hereFromLine, headingSegments, juanOf, jumpScrollTop, spyLine,
  };
  if (typeof document === 'undefined') return api;

  // ───────────── 瀏覽器接線 ─────────────

  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const LEAF_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 1.8h5.5L12.5 5v9.2H4z"/><path d="M6.3 8h4M6.3 10.8h4"/></svg>';
  const STORE = 'mdw-kepan-v1';

  const S = {
    payload: null, N: null, dir: '', file: '', fileIndex: -1,
    rootId: 0, scopeAll: false, hereId: 0,
    userOpen: new Set(), userClosed: new Set(), expanded: new Set(),
    rows: [], rowIndex: new Map(),
    anchors: [], anchorsDirty: true, barMax: 0,
    loadToken: 0, busyInTree: false, busyTimer: null,
  };
  const payloadCache = new Map();   // 資料夾 → payload|null

  function loadPrefs(dir) {
    try { const all = JSON.parse(localStorage.getItem(STORE)) || {}; return all[dir] || {}; } catch (_) { return {}; }
  }
  function savePrefs() {
    try {
      const all = JSON.parse(localStorage.getItem(STORE)) || {};
      all[S.dir] = { open: [...S.userOpen].slice(-300), all: S.scopeAll };
      localStorage.setItem(STORE, JSON.stringify(all));
    } catch (_) { /* 私密模式等：不記也能用 */ }
  }

  async function fetchPayload(filePath) {
    const dir = filePath.split('/').slice(0, -1).join('/');
    if (payloadCache.has(dir)) return payloadCache.get(dir);
    const p = fetch('/api/kepan?path=' + encodeURIComponent(filePath))
      .then(r => (r.ok ? r.json() : { kepan: null }))
      .then(j => j.kepan || null)
      .catch(() => null);
    payloadCache.set(dir, p);
    const v = await p;
    payloadCache.set(dir, v);
    return v;
  }

  // ── 側欄分頁：科判系列時以「科判」取代「大綱」 ──
  function setTabMode(on) {
    const kTab = document.querySelector('.sidebar-tab[data-tab="kepan"]');
    const tTab = document.querySelector('.sidebar-tab[data-tab="toc"]');
    if (!kTab || !tTab) return;
    const active = document.querySelector('.sidebar-tab.active');
    kTab.hidden = !on;
    tTab.hidden = on;
    if (on && active === tTab) kTab.click();
    if (!on && active === kTab) tTab.click();
    $('kepanBar').hidden = !on;
    $('kepanNav').hidden = !on;
    document.body.classList.toggle('has-kepan', on);
  }

  // ── 側欄樹 ──
  function rebuild() {
    const { N } = S;
    S.expanded = computeExpanded(N, S.userOpen, S.userClosed, S.hereId);
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
      html += `<div class="kepan-row ${cls}" data-id="${id}" role="treeitem" style="top:${i * ROW_HEIGHT}px;padding-left:${indentFor(lv) + 8}px" title="${esc(n.m + '、' + n.t)}（第 ${n.d + 1} 層）">`
        + guides + toggle + `<span class="kepan-mark">${esc(n.m)}</span><span class="kepan-title">${esc(n.t)}</span>`
        + (kids && !open ? `<span class="kepan-count">分${kids}</span>` : '') + '</div>';
    }
    $('kepanSpacer').innerHTML = html;
  }

  function renderScopeSelect() {
    const { N } = S, sel = $('kepanScope');
    const opts = [`<option value="0">全論（${esc(S.payload.title)}）</option>`];
    for (const n of N) if (n.d === SCOPE_DEPTH) opts.push(`<option value="${n.id}">${esc(n.m + ' ' + n.t)}</option>`);
    sel.innerHTML = opts.join('');
    sel.value = String(S.rootId);
  }

  function setScope(id, announce) {
    if (S.rootId === id) return;
    S.rootId = id;
    $('kepanScope').value = String(id);
    $('kepanTree').scrollTop = 0;
    if (announce && id) {
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
    const sc = scopeOf(S.N, id);
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
    const sc = scopeOf(N, id);
    const juan = juanOf(document.title);
    const pct = Math.round(id / (N.length - 1) * 100);
    $('kepanLandmark').innerHTML =
      (juan ? `<span>卷${esc(juan)}</span>` : '')
      + (sc ? `<b>${esc(N[sc].m + ' ' + N[sc].t)}</b>` : '')
      + (N[id].pg ? `<span>《披尋記》p.${N[id].pg}</span>` : '')
      + `<span>第 ${N[id].d + 1} 層</span>`
      + `<span class="kepan-progress" title="在全論中的位置"><i style="width:${pct}%"></i></span><span>全論 ${pct}%</span>`;
    $('kepanPath').innerHTML = ancestors(N, id).concat(id).map(x => {
      const n = N[x], sib = N[n.p].k;
      const pos = sib.length > 1 ? `<small>${sib.indexOf(x) + 1}/${sib.length}</small>` : '';
      return `<a href="#" data-go="${x}" title="${esc(n.m + '、' + n.t)}">${esc(n.m)} ${esc(n.t)}${pos}</a>`;
    }).join('<span class="kepan-sep">›</span>');
    const nx = N[id + 1], pv = id > 1 ? N[id - 1] : null;
    $('kepanPrev').disabled = !pv;
    $('kepanNext').disabled = !nx;
    $('kepanPrev').textContent = pv ? `← 前一科　${pv.m} ${pv.t}` : '已到最前';
    $('kepanNext').textContent = nx ? `後一科　${nx.m} ${nx.t} →` : '已到最後';
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
    if (S.anchorsDirty) collectAnchors();
    const y = spyLine($('content').scrollTop, S.barMax);
    let line = 0;
    for (const [top, l] of S.anchors) { if (top <= y) line = l; else break; }
    const id = hereFromLine(S.payload, S.fileIndex, line);
    // 剛點選的上層科與子科共用同一行標題時，保留點選的那一層
    if (S.pendingHere && (id === S.pendingHere || ancestors(S.N, id).includes(S.pendingHere))) {
      if (S.N[S.pendingHere].l === line || !line) return setHere(S.pendingHere, true);
    }
    S.pendingHere = 0;
    setHere(id, true);
  }

  // 一行多層的科判標題，改繪成由淺到深的階梯；保留行號錨點與標題 id
  function restyleHeadings() {
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

  // ── 對外：由 app.js 呼叫 ──
  async function onDocumentRendered(filePath) {
    const token = ++S.loadToken;
    if (!filePath || filePath.startsWith('dict:')) { setTabMode(false); return; }
    const payload = await fetchPayload(filePath);
    if (token !== S.loadToken) return;
    if (!payload) { setTabMode(false); S.payload = null; return; }
    const name = filePath.split('/').pop().replace(/\.md$/i, '');
    if (S.payload !== payload) {
      S.payload = payload;
      S.N = expandNodes(payload);
      S.dir = payload.dir;
      S.hereId = 0;
      const prefs = loadPrefs(S.dir);
      S.userOpen = new Set(prefs.open || []);
      S.userClosed = new Set();
      S.scopeAll = !!prefs.all;
      S.rootId = -1;
      renderScopeSelect();
    }
    S.file = filePath;
    S.fileIndex = payload.files.indexOf(name);
    setTabMode(true);
    S.barMax = 0;
    restyleHeadings();
    S.anchorsDirty = true;
    if (S.rootId === -1) S.rootId = 0;
    const want = S.pendingHere;
    if (want && S.N[want]) {
      // 從側欄或前後科換檔過來：openFile 稍後才捲到該行，等它捲完再恢復依捲動定位
      // 標題改繪會改變高度，所以由這裡再捲一次到目標行（app.js 的捲動可能早於改繪）
      const line = S.pendingLine;
      S.hereId = 0;
      setHere(want);
      scrollToLine(line);
      S.lockSpyUntil = Date.now() + 900;
      setTimeout(() => { if (token === S.loadToken) scrollToLine(line); }, 250);
      setTimeout(() => { if (token === S.loadToken) { S.lockSpyUntil = 0; spy(); } }, 950);
    } else {
      S.lockSpyUntil = 0;
      spy();
    }
    if (!S.hereId) rebuild();
  }

  function onDocumentClosed() {
    S.loadToken++;
    S.file = ''; S.fileIndex = -1;
    setTabMode(false);
  }

  function init() {
    if (!$('kepanTree')) return;
    $('kepanSpacer').addEventListener('click', e => {
      const row = e.target.closest('.kepan-row');
      if (!row) return;
      const id = +row.dataset.id;
      if (e.target.closest('[data-toggle]')) toggle(id); else goTo(id);
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
      setScope(id, false);
      rebuild();
      keepVisible(S.hereId);
      savePrefs();
    });
    $('kepanPath').addEventListener('click', e => {
      const a = e.target.closest('[data-go]');
      if (!a) return;
      e.preventDefault();
      goTo(+a.dataset.go);
    });
    $('kepanPrev').addEventListener('click', () => { if (S.hereId > 1) goTo(S.hereId - 1); });
    $('kepanNext').addEventListener('click', () => { if (S.N && S.N[S.hereId + 1]) goTo(S.hereId + 1); });
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
    window.addEventListener('resize', () => { S.anchorsDirty = true; renderRows(); });
    document.addEventListener('click', e => {
      if (e.target.closest('.sidebar-tab[data-tab="kepan"]')) requestAnimationFrame(() => { renderRows(); keepVisible(S.hereId); });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return Object.assign(api, { onDocumentRendered, onDocumentClosed, _state: S });
});
