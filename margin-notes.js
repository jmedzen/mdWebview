/**
 * @file margin-notes.js
 *
 * 經註並讀（alpha 批次 10）。
 *
 * ── 這是什麼
 *
 * 把逐句註疏從「彈窗」搬到「經文旁邊的邊註欄」。
 *
 * 前面幾個批次做的事都是彈窗：藏經地圖、同經異譯、註疏譜系、逐句註疏。
 * 每一個都要你離開經文、蓋住經文、再回來。對一個閱讀器來說，這是錯的
 * 互動方式——你在讀經，不該為了理解一句話而把整頁關掉。
 *
 * 這次改成常駐：經文在左，註疏在右，你捲動，註疏跟著換。
 * 這是古籍「眉批」的版面——原文在中間，註在邊上，同時可見。
 *
 * ── 為什麼敢預設打開
 *
 * 批次 8 的教訓：功能存在但沒有入口，等於不存在（使用者直接說「頁面上
 * 沒有 ui 來檢視」）。
 *
 * 所以這個不藏在選單裡：有註疏的經一打開就會看到。但它做得很安靜——
 * 小字、淡色、細線，不搶經文。看不慣就按邊註欄右上角關掉，設定會記住。
 *
 * ── 與其他模組的關係
 *
 * 只讀 SidecarData（批次 9 產生的對位資料）與 state.currentFile。
 * 不碰 app.js 的狀態、不改 innerHTML、不改書寫方向。
 * 與 sidecar-reader.js 是同一份資料的兩種呈現：那個是「一次看一處」，
 * 這個是「讀到哪看到哪」。兩者互不依賴。
 */

(function (global) {
  'use strict';

  var hasDom = (typeof document !== 'undefined');
  var STORAGE_KEY = 'mdw.marginNotes';       // 'on' | 'off'
  var MIN_LOCI = 5;                          // 少於這個數量的經不值得開邊註欄
  var LINGER = 4;                            // 註解可以「延續」幾個段落

  var railEl = null;
  var bodyEl = null;
  var enabled = null;                        // null = 還沒讀設定
  var currentWork = null;
  var paraStarts = [];                       // 每一段的座標起點
  var lociByPara = {};                       // 段落索引 → [loci]
  var lastRendered = -1;
  var scrollBound = false;
  var rafPending = false;

  function $(id) { return document.getElementById(id); }

  /* ── 偏好 ─────────────────────────────────────────────── */

  function readPref() {
    try {
      var v = global.localStorage && global.localStorage.getItem(STORAGE_KEY);
      if (v === 'off') return false;
      if (v === 'on') return true;
    } catch (_) { /* 無痕模式之類 */ }
    return true;   // 預設打開（批次 8 的教訓）
  }

  function writePref(on) {
    try {
      global.localStorage && global.localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
    } catch (_) { /* 忽略 */ }
  }

  /* ── 座標（與 sidecar-data 同一套規則） ────────────────── */

  function normalize(s) {
    return String(s || '').replace(/[\s\u3000]+/g, '');
  }

  /**
   * 走訪經文的文字節點，跳過我們自己插進去的元素。
   *
   * 邊註欄本身不在 markdownBody 裡，但批次 9 的浮標在。浮標裡有數字，
   * 算進座標就整體偏移。
   */
  function eachTextNode(root, fn) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var el = node.parentElement;
        if (el && el.closest && el.closest('.sidecar-marker')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var node;
    while ((node = walker.nextNode())) fn(node);
  }

  /* ── 找資料 ───────────────────────────────────────────── */

  function baseIdOf(filePath) {
    if (!filePath) return null;
    var name = String(filePath).split('/').pop() || '';
    var m = name.match(/^(T\d{4})[《(]/);
    return m ? m[1] : null;
  }

  function lookupWork(filePath) {
    var data = global.SidecarData;
    if (!data || !Array.isArray(data.works)) return null;
    var id = baseIdOf(filePath);
    if (!id) return null;
    for (var i = 0; i < data.works.length; i++) {
      if (data.works[i].base === id) return data.works[i];
    }
    return null;
  }

  /**
   * 讓邊註欄避開右側辭典欄。
   *
   * 辭典欄可以收合、可以拖寬，所以不能寫死。用 CSS 變數把目前寬度
   * 傳給樣式表，邊註欄的 right 就跟著移動。
   */
  var dictObserver = null;

  function dictOffset() {
    var dict = document.querySelector('.dict-sidebar');
    if (!dict) return 0;
    var cs = global.getComputedStyle(dict);
    if (!cs || cs.display === 'none') return 0;
    if (dict.classList.contains('collapsed')) return 0;
    var w = dict.getBoundingClientRect().width;
    return w > 0 ? Math.round(w) : 0;
  }

  function syncDictOffset() {
    var root = document.documentElement;
    if (!root) return;
    root.style.setProperty('--dict-rail-offset', dictOffset() + 'px');
  }

  function watchDict() {
    if (dictObserver || typeof ResizeObserver === 'undefined') return;
    var dict = document.querySelector('.dict-sidebar');
    if (!dict) return;
    dictObserver = new ResizeObserver(function () { syncDictOffset(); });
    dictObserver.observe(dict);
  }

  /* ── 建立邊註欄 ───────────────────────────────────────── */

  /**
   * 邊註欄掛在 #content 裡，不是 fixed 到視窗。
   *
   * 這樣它自動跟著右側辭典欄的開關移動，不必自己去算辭典欄現在幾 px。
   * 內層 sticky 讓它在捲動時固定，外層 absolute 讓它撐滿整條捲軸高度。
   */
  function ensureRail() {
    if (railEl && railEl.isConnected) return railEl;

    var content = $('content');
    if (!content) return null;

    /*
     * fixed 定位要自己算「辭典欄現在佔多寬」。
     *
     * 用一個 ResizeObserver 盯著辭典欄，而不是每次捲動都去問
     * getBoundingClientRect——後者會在捲動時觸發強制重排。
     */
    syncDictOffset();

    railEl = document.createElement('aside');
    railEl.className = 'margin-rail';
    railEl.id = 'marginRail';
    railEl.setAttribute('aria-label', '經文註疏');

    var inner = document.createElement('div');
    inner.className = 'margin-rail-inner';

    var head = document.createElement('div');
    head.className = 'margin-rail-head';

    var label = document.createElement('span');
    label.className = 'margin-rail-label';
    label.textContent = '註';
    head.appendChild(label);

    /*
     * 標題顯示「這部經有幾家註」。讀者要一眼知道這條邊欄不是裝飾，
     * 而是真的有人講過這些話。
     */
    var meta = document.createElement('span');
    meta.className = 'margin-rail-meta';
    meta.id = 'marginRailMeta';
    head.appendChild(meta);

    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'margin-rail-close';
    close.id = 'marginRailClose';
    close.title = '收起邊註（可從右上角選單再打開）';
    close.setAttribute('aria-label', '收起邊註');
    close.textContent = '✕';
    close.addEventListener('click', function () { setEnabled(false, true); });
    head.appendChild(close);

    inner.appendChild(head);

    bodyEl = document.createElement('div');
    bodyEl.className = 'margin-rail-body';
    bodyEl.id = 'marginRailBody';
    inner.appendChild(bodyEl);

    railEl.appendChild(inner);
    content.appendChild(railEl);

    return railEl;
  }

  /* ── 把註解對到段落 ───────────────────────────────────── */

  /**
   * 建立「段落索引 → 註解」的對照表。
   *
   * 座標系與 sidecar-data 一致（去空白的純文字）。段落起點用累加算，
   * 因為 #markdownBody 裡只有 <p> 會被放註解，其他元素（標題、清單）
   * 的文字也會佔座標，所以累加必須把整個 body 的文字都算進去，不能
   * 只累加 <p>。
   *
   * 做法：先算出 body 每個文字節點屬於哪個 <p>（或沒有），再依序累加。
   */
  function buildIndex(work) {
    var body = $('markdownBody');
    if (!body) return false;

    var paras = body.querySelectorAll('p');
    if (!paras.length) return false;

    paraStarts = [];
    lociByPara = {};
    lastRendered = -1;

    // 段落 → 它在正規化座標裡的第幾個字開始
    var startOf = new Map();
    var acc = 0;
    var currentPara = null;

    eachTextNode(body, function (node) {
      var p = node.parentElement && node.parentElement.closest
        ? node.parentElement.closest('p')
        : null;

      if (p !== currentPara) {
        currentPara = p;
        if (p && !startOf.has(p)) startOf.set(p, acc);
      }
      acc += normalize(node.nodeValue).length;
    });

    for (var i = 0; i < paras.length; i++) {
      var s = startOf.get(paras[i]);
      paraStarts.push(s === undefined ? -1 : s);
    }

    /*
     * 每一處註解落在哪一段：找「起點不大於它的最後一段」。
     *
     * 有些註解註的是經題或段落之間的東西，起點會落在第一段之前
     * （paraStarts[0] 之前）——那種歸給第一段，不要丟掉。
     */
    var paraIdx = 0;
    for (var k = 0; k < work.loci.length; k++) {
      var pos = work.loci[k].p;
      while (paraIdx + 1 < paraStarts.length && paraStarts[paraIdx + 1] <= pos) paraIdx++;
      // 起點可能 -1（空段落），往後找第一個有效起點
      var target = paraIdx;
      while (target > 0 && paraStarts[target] < 0) target--;
      (lociByPara[target] = lociByPara[target] || []).push(work.loci[k]);
    }

    return true;
  }

  /* ── 目前讀到哪一段 ───────────────────────────────────── */

  /**
   * 用「視窗上方三分之一處」當閱讀線。
   *
   * 人的眼睛大致落在畫面偏上，那一行才是「正在讀的地方」。用正中央
   * 會讓人覺得邊註總是慢半拍。
   */
  function currentParaIndex() {
    var content = $('content');
    var body = $('markdownBody');
    if (!content || !body) return -1;

    var paras = body.querySelectorAll('p');
    if (!paras.length) return -1;

    var box = content.getBoundingClientRect();
    var line = box.top + box.height * 0.34;

    var lo = 0, hi = paras.length - 1, found = 0;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      var r = paras[mid].getBoundingClientRect();
      if (r.top <= line) { found = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return found;
  }

  /* ── 畫 ───────────────────────────────────────────────── */

  function renderNote(note) {
    var wrap = document.createElement('div');
    wrap.className = 'margin-note';

    var who = document.createElement('div');
    who.className = 'margin-note-who';

    if (note.era) {
      var era = document.createElement('span');
      era.className = 'margin-note-era';
      era.textContent = note.era;
      who.appendChild(era);
    }

    var name = document.createElement('span');
    name.className = 'margin-note-name';
    name.textContent = note.by;
    who.appendChild(name);

    wrap.appendChild(who);

    var text = document.createElement('p');
    text.className = 'margin-note-text';
    text.textContent = note.t;
    wrap.appendChild(text);

    return wrap;
  }

  /**
   * 依目前段落更新邊註欄。
   *
   * 「延續」規則：目前這一段沒有註解時，往回找 LINGER 段以內最近的一處
   * 繼續顯示，但標成淡色。讀者在段落之間移動時，註解不會忽然整片消失
   * 又出現——那比不顯示更干擾。
   *
   * 邊欄一次最多顯示兩家。一處常有四五家註，全塞進 300px 的邊欄會變成
   * 一堵字牆，反而沒人讀。其餘的用一個小按鈕帶到逐句註疏面板。
   */
  function paintAll() {
    if (!railEl || !bodyEl || !currentWork) return;

    var idx = currentParaIndex();
    if (idx < 0) return;

    var usedIdx = -1;
    var stale = false;
    var loci = lociByPara[idx] || null;

    if (!loci) {
      for (var back = 1; back <= LINGER; back++) {
        var probe = idx - back;
        if (probe < 0) break;
        if (lociByPara[probe]) {
          loci = lociByPara[probe];
          usedIdx = probe;
          stale = true;
          break;
        }
      }
    } else {
      usedIdx = idx;
    }

    // 沒有鄰近註解：清空但留一句提示，避免整條邊欄空白像壞掉
    if (!loci) {
      if (lastRendered !== -2) {
        bodyEl.textContent = '';
        var hint = document.createElement('p');
        hint.className = 'margin-note-empty';
        hint.textContent = '往下讀，有註解的地方會出現在這裡。';
        bodyEl.appendChild(hint);
        lastRendered = -2;
      }
      return;
    }

    if (usedIdx === lastRendered && !stale) return;
    lastRendered = usedIdx;

    /*
     * 在經文上標出「邊註現在講的是這一段」。
     *
     * 沒有這個標記，邊註欄只是「一直有字在換」——讀者的眼睛必須在
     * 左右兩邊來回找，才知道哪一則對應哪裡。加一條極細的左線，
     * 對應關係就成立了，而且幾乎不干擾閱讀。
     */
    markParagraph(usedIdx);

    bodyEl.textContent = '';

    /*
     * 一次顯示「目前這一處 + 接下來兩處」，不是只顯示一處。
     *
     * 原本只顯示一處，結果邊欄幾乎永遠是空的（實測：1440×900 只用了
     * 上方 100px 就沒了）。因為經文一段平均 49 字，而註解只落在特定
     * 幾段上——絕大多數段落根本沒有註解。
     *
     * 改成往前看：讀者讀到這裡，順便看到「接下來這幾句也有人講」。
     * 這才是並讀——不是等號式的對應，而是讓註解像另一條線一樣流在旁邊。
     */
    var shown = 0;
    var MAX_SHOWN = 3;

    // 先畫目前這一處（若它是延續來的，標淡）
    var first = loci[0];
    var show = first.notes.slice(0, 2);
    for (var i = 0; i < show.length; i++) {
      var node = renderNote(show[i]);
      if (stale) node.classList.add('is-lingering');
      bodyEl.appendChild(node);
      shown++;
    }

    if (first.notes.length > show.length) {
      bodyEl.appendChild(moreButton(first.notes.length - show.length));
    }

    /*
     * 再往後補幾處，讓邊欄有「接下來」的資訊。
     *
     * 只補同一段之後的：paraIdx 往後找，找不到就停。不跨越太遠——
     * 邊註若顯示到三頁之後的解釋，對讀者反而是干擾。
     */
    var added = 0;
    for (var k = usedIdx + 1; k < paraStarts.length && added < MAX_SHOWN - 1; k++) {
      var next = lociByPara[k];
      if (!next) continue;
      var item = next[0];
      if (!item || !item.notes.length) continue;

      var sep = document.createElement('div');
      sep.className = 'margin-note-ahead';
      // 讓讀者知道「這是下一句的」
      sep.textContent = '↓ ' + (item.q || '').slice(0, 8);
      bodyEl.appendChild(sep);

      var n2 = renderNote(item.notes[0]);
      n2.classList.add('is-ahead');
      bodyEl.appendChild(n2);
      added++;
      shown++;
    }
  }

  /**
   * 標出邊註對應的段落。
   *
   * 用一個 class 而不是插節點：插節點會改變座標系，而座標系正是這個
   * 功能的地基（批次 9 踩過浮標污染座標的坑）。
   */
  var markedPara = null;

  function markParagraph(idx) {
    var body = $('markdownBody');
    if (!body) return;
    var paras = body.querySelectorAll('p');
    if (!paras.length) return;

    var target = paras[idx] || null;
    if (markedPara === target) return;

    if (markedPara) markedPara.classList.remove('has-margin-note');
    markedPara = target;
    if (markedPara) markedPara.classList.add('has-margin-note');
  }

  function moreButton(n) {
    var more = document.createElement('button');
    more.type = 'button';
    more.className = 'margin-note-more';
    more.textContent = '同處另有 ' + n + ' 家 →';
    more.addEventListener('click', function () {
      if (global.SidecarReader && global.SidecarReader.open) {
        global.SidecarReader.open();
      }
    });
    return more;
  }

  /* ── 開關 ─────────────────────────────────────────────── */

  function setEnabled(on, fromUser) {
    enabled = !!on;
    if (fromUser) writePref(enabled);

    var root = document.documentElement;
    if (root) root.classList.toggle('with-margin-rail', enabled && !!currentWork);

    if (railEl) railEl.hidden = !(enabled && !!currentWork);

    if (!enabled || !currentWork) {
      if (markedPara) {
        markedPara.classList.remove('has-margin-note');
        markedPara = null;
      }
    }

    if (enabled && currentWork) {
      lastRendered = -1;
      paintAll();
    }

    syncToggle();
  }

  /** 換檔或渲染完成後重新評估。 */
  function refresh() {
    if (enabled === null) enabled = readPref();

    var file = global.state && global.state.currentFile;
    var work = lookupWork(file);
    var usable = !!(work && work.loci && work.loci.length >= MIN_LOCI);

    if (!usable) {
      currentWork = null;
      if (railEl) railEl.hidden = true;
      var root = document.documentElement;
      if (root) root.classList.remove('with-margin-rail');
      return;
    }

    currentWork = work;

    var rail = ensureRail();
    if (!rail) return;

    var meta = $('marginRailMeta');
    if (meta) {
      // 這部經有幾家註過（去重）
      var names = {};
      for (var i = 0; i < work.loci.length; i++) {
        for (var j = 0; j < work.loci[i].notes.length; j++) {
          names[work.loci[i].notes[j].by] = 1;
        }
      }
      var count = Object.keys(names).length;
      meta.textContent = count ? count + ' 家' : '';
    }

    if (!buildIndex(work)) {
      if (railEl) railEl.hidden = true;
      return;
    }

    setEnabled(enabled === null ? readPref() : enabled, false);
  }

  /* ── 捲動同步 ─────────────────────────────────────────── */

  function onScroll() {
    if (rafPending) return;
    rafPending = true;
    var raf = global.requestAnimationFrame || function (fn) { return global.setTimeout(fn, 16); };
    raf(function () {
      rafPending = false;
      if (enabled && currentWork) paintAll();
    });
  }

  function bindScroll() {
    if (scrollBound) return;
    var content = $('content');
    if (!content) return;
    content.addEventListener('scroll', onScroll, { passive: true });
    scrollBound = true;
  }

  /* ── 起動 ─────────────────────────────────────────────── */

  var lastFile = null;
  var lastLen = -1;

  function tick() {
    var file = global.state && global.state.currentFile;
    var body = $('markdownBody');
    var len = body ? body.textContent.length : 0;

    if (file !== lastFile) {
      lastFile = file;
      lastLen = -1;
      refresh();
      bindScroll();
    }

    // 內文長度變了＝渲染完成或換檔，重建索引
    if (len !== lastLen) {
      lastLen = len;
      if (len > 0) {
        refresh();
        bindScroll();
      }
    }
  }

  /**
   * 工具列開關。
   *
   * 按下去就切換並記住。aria-pressed 要跟著更新——這是給螢幕閱讀器
   * 判斷「現在是開還是關」用的，不是裝飾。
   */
  function setupToggle() {
    var btn = $('marginRailToggle');
    if (!btn) return;

    syncToggle(btn);
    btn.addEventListener('click', function () {
      setEnabled(!enabled, true);
      syncToggle(btn);
    });
  }

  function syncToggle(btn) {
    var el = btn || $('marginRailToggle');
    if (!el) return;
    el.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    el.classList.toggle('is-on', !!enabled);
  }

  function init() {
    if (!hasDom) return;
    enabled = readPref();
    setupToggle();
    syncDictOffset();
    watchDict();
    tick();
    global.setInterval(tick, 450);
    bindScroll();
  }

  if (hasDom) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  global.MarginNotes = {
    refresh: hasDom ? refresh : function () {},
    setEnabled: hasDom ? setEnabled : function () {},
    isEnabled: function () { return !!enabled; },
    /** 測試用。 */
    _indexSize: function () { return Object.keys(lociByPara).length; },
    _currentPara: hasDom ? currentParaIndex : function () { return -1; }
  };

})(typeof window !== 'undefined' ? window : this);
