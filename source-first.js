/**
 * @file source-first.js
 *
 * 搜尋的「原文優先」（alpha 批次 13）。
 *
 * ── 要解決的問題
 *
 * 實測：搜「應無所住」，全庫出現 1,887 次，散在 494 個檔案裡。
 *
 * 但其中只有 1 個是《金剛經》原文。其餘 493 個是歷代註疏、講記、
 * 對讀、隨筆——它們都在解釋那句話，而不是說那句話。
 *
 * 目前的搜尋結果把兩者混在一起排：140 筆來自《金剛般若經贊述釋記》，
 * 92 筆來自《金剛般若波羅蜜經講義》……讀者想找「佛到底怎麼說的」，
 * 得先翻過幾百筆後人的話。
 *
 * ── 這次做什麼
 *
 * 搜尋結果分兩層：
 *   上層「經文原文」—— 有 CBETA 經號、且不是註疏的檔案
 *   下層「後人講解」—— 其餘
 *
 * 不只排序，還要在視覺上一眼分得出來：原文那層用經文的字體與較大的
 * 字級，講解那層明顯退後。讀者不必點進去就知道哪個是佛說的。
 *
 * ── 憑什麼判斷「原文」
 *
 * 兩條線索，都可驗證、不靠猜：
 *   1. 檔名有 CBETA 經號（T0001、X0001 這種）→ 是藏經裡的一部
 *   2. 該檔名出現在 commentary-data.js 的註疏清單裡 → 那是「解釋」
 *      而不是「被解釋的經」
 *
 * 兩者都不是的（現代講記、對讀、索引）一律歸「後人講解」。
 *
 * 這不是完美的分類——某些經論本身就是論（T1585《成唯識論》），它既是
 * 「原文」也是「解釋」。但在搜尋結果裡把它放在上層是對的：它是藏經
 * 裡的一部，有經號，讀者要讀它本身。
 */

(function (global) {
  'use strict';

  var hasDom = (typeof document !== 'undefined');

  /** CBETA 經號：T0001、X0001、B0088、T1510a 這種。 */
  var CANON_ID_RE = /^([A-Z]\d{4}[a-z]?)[《(]/;

  var commentaryPaths = null;

  function $(id) { return document.getElementById(id); }

  /* ── 分類 ─────────────────────────────────────────────── */

  /** 從檔名取經號，取不到回 null。 */
  function canonId(filePath) {
    if (!filePath) return null;
    var name = String(filePath).split('/').pop() || '';
    var m = name.match(CANON_ID_RE);
    return m ? m[1] : null;
  }

  /**
   * 建立註疏路徑集合（只建一次）。
   *
   * commentary-data.js 的 141 部註疏是「已知在解釋某部經」的檔案。
   * 這個清單本身就是判斷依據，不必再重新掃描語料。
   */
  function getCommentaryPaths() {
    if (commentaryPaths) return commentaryPaths;

    /*
     * 只快取「非空」的結果。
     *
     * 實際踩過：如果 commentary-data.js 還沒載入就呼叫，會把空集合
     * 快取起來，之後就永遠是空的——所有註疏都被當成原文，而且不會
     * 報錯。這種靜默失效最難查。
     *
     * 所以空的就回傳臨時物件、不快取，下次再試。
     */
    var map = Object.create(null);
    var count = 0;

    var data = global.CommentaryData;
    if (data && Array.isArray(data.families)) {
      for (var i = 0; i < data.families.length; i++) {
        var fam = data.families[i];
        var comms = (fam && fam.commentaries) || [];
        for (var j = 0; j < comms.length; j++) {
          if (comms[j] && comms[j].path) {
            map[comms[j].path] = 1;
            count++;
          }
        }
      }
    }

    if (count > 0) commentaryPaths = map;
    return map;
  }

  /**
   * 判斷一個搜尋結果屬於「原文」還是「講解」。
   *
   * @param {string} file  結果的檔案路徑
   * @returns {'source'|'commentary'}
   */
  function classify(file) {
    if (!file) return 'commentary';
    if (getCommentaryPaths()[file]) return 'commentary';
    return canonId(file) ? 'source' : 'commentary';
  }

  /* ── 改寫結果面板 ─────────────────────────────────────── */

  /**
   * 在既有的搜尋結果容器上方插一條「分層說明」，並替每一組標上層級。
   *
   * 刻意不去改 app.js 的 renderSearchResults——那是 6,500 行的核心檔案，
   * ARCHITECTURE.md §18 明令不模組化它。這裡的做法是「觀察 DOM 變化再
   * 標記」，不動它的邏輯，只加資訊。
   */
  function decorate() {
    var box = $('searchResults');
    if (!box) return;

    var groups = box.querySelectorAll('.search-result-group');
    if (!groups.length) return;

    /*
     * 先標層級（classList 不觸發 childList 觀察），再算簽章。
     *
     * 順序重要：簽章要反映「標完之後」的狀態，否則第一次標完簽章對不上，
     * 下一輪又會重做。
     */
    var pre = box.querySelectorAll('.search-result-group');
    for (var p = 0; p < pre.length; p++) {
      var ph = pre[p].querySelector('.search-result-file');
      if (!ph) continue;
      var pf = ph.getAttribute('data-file-group') || '';
      var pk = classify(pf);
      pre[p].setAttribute('data-layer', pk);
    }

    var sig = signatureOf(box);
    if (sig === lastSignature) return;
    lastSignature = sig;

    var sourceCount = 0;
    var commCount = 0;

    /*
     * 套樣式。
     *
     * 層級（data-layer）在上面算簽章前就標好了，這裡只補 class。
     * classList 不是 childList 的變動，不會觸發我們的 observer。
     */
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      if (g.getAttribute('data-layer') === 'source') {
        sourceCount++;
        g.classList.add('is-source');
        g.classList.remove('is-commentary');
      } else {
        commCount++;
        g.classList.add('is-commentary');
        g.classList.remove('is-source');
      }
    }

    // 這一段會改 DOM，全部包起來避免觸發自己
    withoutObserving(function () {
      reorder(box);
      renderLegend(box, sourceCount, commCount);
    });
  }

  /**
   * 把「經文原文」的組移到「後人講解」前面。
   *
   * 只搬動 .search-result-group 這一層，不動裡面的東西——每一組的
   * 內容、展開狀態、data-* 全部原封不動。
   *
   * 這是整個功能的核心：讀者搜一句話，第一個看到的應該是佛怎麼說，
   * 而不是某位法師怎麼講。
   */
  function reorder(box) {
    var groups = Array.prototype.slice.call(box.querySelectorAll('.search-result-group'));
    if (groups.length < 2) return;

    var sources = groups.filter(function (g) { return g.classList.contains('is-source'); });
    if (!sources.length) return;

    /*
     * 已經排好了就不動。
     *
     * 判斷法：第一個 is-source 之前不該有 is-commentary。若不是這樣才
     * 需要搬。每次 MutationObserver 觸發都重排會讓捲動位置亂跳。
     */
    var firstSource = groups.indexOf(sources[0]);
    var needsMove = false;
    for (var i = 0; i < firstSource; i++) {
      if (groups[i].classList.contains('is-commentary')) { needsMove = true; break; }
    }
    if (!needsMove) return;

    var comments = groups.filter(function (g) { return g.classList.contains('is-commentary'); });

    var parent = groups[0].parentNode;
    if (!parent) return;

    var frag = document.createDocumentFragment();
    sources.forEach(function (g) { frag.appendChild(g); });
    comments.forEach(function (g) { frag.appendChild(g); });

    // 找出「顯示更多」按鈕，它要留在最後
    var more = box.querySelector('.search-load-more');
    if (more && more.parentNode === parent) {
      parent.insertBefore(frag, more);
    } else {
      parent.appendChild(frag);
    }
  }

  /**
   * 結果上方的分層說明。
   *
   * 不只寫數字——要寫出「這是佛說的」與「這是後人解的」的差別。那是
   * 整個功能的重點，不是統計。
   */
  function renderLegend(box, sourceCount, commCount) {
    var old = box.querySelector('.source-first-legend');
    if (old) old.remove();

    if (!sourceCount && !commCount) return;

    var legend = document.createElement('div');
    legend.className = 'source-first-legend';

    if (sourceCount) {
      var s = document.createElement('span');
      s.className = 'source-first-tag is-source';
      s.textContent = '經文原文 ' + sourceCount;
      legend.appendChild(s);
    }

    if (commCount) {
      var c = document.createElement('span');
      c.className = 'source-first-tag is-commentary';
      c.textContent = '後人講解 ' + commCount;
      legend.appendChild(c);
    }

    // 插在 .search-status 之後（那是「找到 N 個結果」）
    var status = box.querySelector('.search-status');
    if (status && status.nextSibling) {
      box.insertBefore(legend, status.nextSibling);
    } else if (status) {
      status.parentNode.appendChild(legend);
    } else {
      box.insertBefore(legend, box.firstChild);
    }
  }

  /* ── 監看 ─────────────────────────────────────────────── */

  /**
   * app.js 會用 innerHTML 重畫整個結果區，所以不能只在初始化時標一次。
   *
   * 用 MutationObserver 觀察子節點變化。這是唯一不動 app.js 又能跟上
   * 每次重畫的辦法。
   */
  var observer = null;

  /*
   * 防止自己觸發自己。
   *
   * ── 踩到的坑
   *
   * decorate() 會插入 legend、搬動 group。這些都是 DOM 變動，會再觸發
   * MutationObserver，於是 decorate → observer → decorate 無限迴圈。
   *
   * 第一版用一個 _busy 旗標，但它在 microtask 執行前就被清掉，完全擋
   * 不住。實際後果不是畫面閃一下，是整個頁面轉圈圈卡死（headless
   * Chrome 跑 60 秒還回不來）。
   *
   * 正解：在「自己做變動」的期間真的把 observer 停掉，做完再開。
   * disconnect/observe 是同步的，不會漏事件。
   */
  var suppress = 0;

  function withoutObserving(fn) {
    suppress++;
    try {
      fn();
    } finally {
      suppress--;
    }
  }

  /*
   * 內容簽章：同樣的結果只處理一次。
   *
   * ── 為什麼非有這個不可
   *
   * 第一版沒有簽章，只靠 suppress 擋遞迴。結果是頁面直接卡死——不是
   * 閃一下，是 headless Chrome 跑滿 60 秒還回不來，連 Debugger.pause
   * 都拿不到回應（主執行緒被佔滿）。
   *
   * 原因：decorate 每次都會 remove + insert legend，即使內容一模一樣。
   * 那是真實的 DOM 變動，於是「變動 → decorate → 變動」永遠停不下來。
   * suppress 只在單次 decorate 的期間有效，跨輪擋不住。
   *
   * 簽章從根本解決：內容沒變就完全不碰 DOM。
   */
  var lastSignature = '';

  function signatureOf(box) {
    var groups = box.querySelectorAll('.search-result-group');
    var parts = [];
    for (var i = 0; i < groups.length; i++) {
      var head = groups[i].querySelector('.search-result-file');
      parts.push(groups[i].getAttribute('data-layer') || '?');
      parts.push(head ? (head.getAttribute('data-file-group') || '') : '');
    }
    // 加上結果總數，換關鍵字但同檔案的狀況也能區分
    var status = box.querySelector('.search-status');
    parts.push(status ? status.textContent : '');
    return parts.join('|');
  }

  function watch() {
    var box = $('searchResults');
    if (!box || observer) return;

    if (typeof MutationObserver === 'undefined') {
      // 沒有 MutationObserver 的環境：至少標一次
      decorate();
      return;
    }

    observer = new MutationObserver(function () {
      if (suppress > 0) return;

      /*
       * app.js 用 innerHTML 一次換掉整區，所以一次搜尋只會觸發一次。
       * 但保險起見仍用 microtask 合併同一輪的多個變動。
       */
      if (observer._queued) return;
      observer._queued = true;
      Promise.resolve().then(function () {
        observer._queued = false;
        if (suppress > 0) return;
        decorate();
      });
    });

    observer.observe(box, { childList: true });
    withoutObserving(decorate);
  }

  function init() {
    if (!hasDom) return;
    watch();

    /*
     * 面板可能比這個腳本晚出現（側欄是延遲建立的）。
     * 用一個輕量的輪詢補上，直到找到為止。
     */
    var tries = 0;
    var timer = global.setInterval(function () {
      tries++;
      if ($('searchResults')) {
        watch();
        clearInterval(timer);
      }
      if (tries > 40) clearInterval(timer);
    }, 250);
  }

  if (hasDom) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  global.SourceFirst = {
    classify: classify,
    canonId: canonId,
    decorate: hasDom ? decorate : function () {},
    /** 測試用 */
    _commentaryPaths: getCommentaryPaths
  };

})(typeof window !== 'undefined' ? window : this);
