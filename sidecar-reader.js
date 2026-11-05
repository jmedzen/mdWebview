/**
 * @file sidecar-reader.js
 *
 * 逐句註疏（alpha 批次 9）。
 *
 * ── 這是什麼
 *
 * 讀金剛經讀到「如是我聞」，面板裡會出現：
 *
 *   隋·天台智者大師   言則當理，理亦如言…故言一時也。
 *   胡吉藏            第四句，亦有五：一者、明洗塵累…
 *   金剛般若經贊述    佛初成道，初一時中，度五人俱隣等…
 *
 * 同一句話，兩三位註疏家怎麼各自讀它。
 *
 * ── 為什麼這件事以前做不到
 *
 * 古代註疏講經的格式是先引一句、再解那句。引文就是座標——把引文對回
 * 底本，就得到「這一段經文有誰註過」。資料由 scripts/gen-sidecar.js
 * 產生（19 部經、4,090 處、999 處有兩家以上）。
 *
 * 批次 8 只做到「這部經有 14 部註疏」——那是一份書單。這個批次把它變成
 * 逐句的對讀：你讀到哪裡，就看到那裡有哪些人講過。
 *
 * ── 與 app.js 的關係
 *
 * 完全獨立。只讀渲染後的 #markdownBody 純文字（算座標）、只讀
 * state.currentFile（判斷是哪部經）。不碰 app.js 的任何狀態，
 * 不改 innerHTML，不改版面寬度。
 *
 * ── 刻意不做的事
 *
 * 不做「自動摘要」、不做「AI 解讀」、不排序誰講得比較好。
 * 註疏家的話原樣呈現，長短不一就長短不一。
 */

(function (global) {
  'use strict';

  var hasDom = (typeof document !== 'undefined');
  var isOpen = false;
  var currentWork = null;      // SidecarData 裡的那一筆
  var currentLocus = null;     // 目前選中的「處」
  var markers = [];            // { p, el }

  function $(id) { return document.getElementById(id); }

  /* ── 座標 ──────────────────────────────────────────────── */

  /**
   * 把渲染後的純文字正規化成與 sidecar-data 相同的座標系。
   *
   * 產生器用的是「CBETA 原文去掉所有空白」。渲染後多出什麼？
   *   - 段落之間沒有空白（innerText 會補換行，textContent 不會）
   *   - 標題、清單符號不影響
   *
   * 所以用 textContent 再抽掉空白，就會落在同一個索引上。
   * 這也是為什麼產生器與前端都只做「去空白」這一件事——規則越少越不會錯。
   */
  function normalize(s) {
    return String(s || '').replace(/[\s\u3000]+/g, '');
  }

  /** 目前文件的座標系（快取，換檔才重算）。 */
  var docText = null;
  var docFile = null;

  /**
   * 依序走訪經文的文字節點，跳過我們自己插進去的浮標。
   *
   * 這是必要的：浮標是一個 button，裡面有數字（「3」）。如果直接讀
   * markdownBody.textContent，那些數字會被算進經文，座標就整體偏移了。
   * 我自己踩過這個坑——浮標一多，越後面的話對位就越歪。
   */
  function eachTextNode(body, fn) {
    var walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
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

  function getDocText() {
    if (docFile === global.state?.currentFile && docText !== null) return docText;
    var body = $('markdownBody');
    if (!body) return '';
    var parts = [];
    eachTextNode(body, function (n) { parts.push(n.nodeValue); });
    docText = normalize(parts.join(''));
    docFile = global.state?.currentFile;
    return docText;
  }

  /* ── 找資料 ────────────────────────────────────────────── */

  /** 從目前檔案路徑取經號。 */
  function baseIdOf(filePath) {
    if (!filePath) return null;
    var name = String(filePath).split('/').pop() || '';
    var m = name.match(/^(T\d{4})[《(]/);
    return m ? m[1] : null;
  }

  function lookup(filePath) {
    var data = global.SidecarData;
    if (!data || !Array.isArray(data.works)) return null;
    var id = baseIdOf(filePath);
    if (!id) return null;
    for (var i = 0; i < data.works.length; i++) {
      if (data.works[i].base === id) return data.works[i];
    }
    return null;
  }

  /* ── 面板 ──────────────────────────────────────────────── */

  /**
   * 把一「處」的註解畫進面板。
   *
   * 註疏家的名字是主角（和批次 8 的卡片同一個原則）。朝代做成小小的
   * 前綴——「隋」一個字就足以定出位置，不需要「隋代天台智者大師」。
   */
  function renderNotes(locus, contextText) {
    var list = $('sidecarNotes');
    if (!list) return;
    list.textContent = '';

    // 這一段經文長什麼樣：先給座標感，不然讀者不知道在註哪
    var ctx = $('sidecarContext');
    if (ctx) {
      ctx.textContent = contextText
        ? '「' + contextText.slice(0, 46) + (contextText.length > 46 ? '…' : '') + '」'
        : '';
      ctx.hidden = !contextText;
    }

    locus.notes.forEach(function (n) {
      var item = document.createElement('div');
      item.className = 'sidecar-note';

      var head = document.createElement('div');
      head.className = 'sidecar-note-head';

      if (n.era) {
        var era = document.createElement('span');
        era.className = 'sidecar-note-era';
        era.textContent = n.era;
        head.appendChild(era);
      }

      var who = document.createElement('span');
      who.className = 'sidecar-note-who';
      who.textContent = n.by || '佚名';
      head.appendChild(who);

      item.appendChild(head);

      var text = document.createElement('p');
      text.className = 'sidecar-note-text';
      text.textContent = n.t;
      item.appendChild(text);

      list.appendChild(item);
    });
  }

  /** 更新面板標題與統計。 */
  function renderHead(work) {
    var title = $('sidecarTitle');
    if (title) title.textContent = '逐句註疏';

    var meta = $('sidecarMeta');
    if (meta) {
      var multi = work.loci.filter(function (l) { return l.notes.length >= 2; }).length;
      meta.textContent = work.loci.length + ' 處有註解' +
        (multi ? '，其中 ' + multi + ' 處有兩家以上' : '');
    }

    var list = $('sidecarLocusList');
    if (list) {
      list.textContent = '';
      work.loci.forEach(function (l, i) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sidecar-locus-btn';
        btn.setAttribute('data-idx', String(i));

        var num = document.createElement('span');
        num.className = 'sidecar-locus-num';
        num.textContent = String(i + 1);
        btn.appendChild(num);

        var dot = document.createElement('span');
        dot.className = 'sidecar-locus-dot';
        dot.textContent = l.notes.length >= 2 ? '●●●' : '●';
        dot.title = l.notes.length + ' 家';
        btn.appendChild(dot);

        /*
         * 左欄顯示「引文」而不是「誰註的」。
         *
         * 原本顯示作者名，結果同一位移家連續出現五六次「胡吉藏」——
         * 讀者完全分不出那一條是哪一條。引文才是這一處的身分證：
         * 「如是」「飯食」「善付囑」，一眼就知道在講哪裡。
         */
        var label = document.createElement('span');
        label.className = 'sidecar-locus-who';
        label.textContent = l.q || ('第 ' + (i + 1) + ' 處');
        btn.appendChild(label);

        btn.addEventListener('click', function () {
          selectLocus(i, true);
        });

        list.appendChild(btn);
      });
    }
  }

  /**
   * 算出這一處在「目前這份文件」裡的真實位置。
   *
   * sidecar-data 的 p 是在「產生器清洗過的原文」上的座標。前端的渲染
   * 多多少少會不一樣（段落合併、標題處理、我們自己的浮標…）。只要有一點
   * 差異，絕對位置就會整體偏移，越後面偏越多。
   *
   * 所以先驗證：p 附近的文字有沒有包含 q（引文）。有就直接用；沒有就
   * 用 q 全文搜尋。兩者都失敗才退回 p——寧可位置略有偏差，也不要整批
   * 對不到。
   */
  function resolvePosition(locus, doc) {
    if (!locus) return 0;
    var p = locus.p || 0;
    var q = locus.q || '';

    if (q) {
      // 先看原本的位置對不對（允許 ±4 字的誤差）
      var lo = Math.max(0, p - 4);
      var near = doc.slice(lo, lo + q.length + 8);
      if (near.indexOf(q) >= 0) return lo + near.indexOf(q);

      // 位置不對就用引文重找
      var found = doc.indexOf(q);
      if (found >= 0) return found;
    }
    return p;
  }

  /** 選中某一處：更新面板內容，並把經文捲到那裡。 */
  function selectLocus(idx, scrollToText) {
    if (!currentWork) return;
    var locus = currentWork.loci[idx];
    if (!locus) return;
    currentLocus = locus;

    var doc = getDocText();
    var realPos = resolvePosition(locus, doc);

    /*
     * 語境文字優先用引文本身（q），沒有的話才退回位置附近的文字。
     *
     * 為什麼不用位置：有些註解註的是「經題」而不是經文（「『金剛般若』
     * 此乃摧萬有於性空…」）。那種註解的 p 落在檔案開頭，切出來的語境
     * 會是經題而不是它真正在講的那一段，看起來就像對錯了。
     *
     * 引文是註疏家自己寫下的「我在講這一句」，以它為準永遠不會錯。
     */
    var contextText = locus.q || doc.slice(realPos, realPos + 60);

    renderNotes(locus, contextText);

    // 標記選中狀態
    var list = $('sidecarLocusList');
    if (list) {
      Array.prototype.forEach.call(list.children, function (el, i) {
        el.classList.toggle('is-active', i === idx);
      });
    }

    if (scrollToText) scrollToPosition(realPos);
  }

  /**
   * 把經文捲到某個正規化位置。
   *
   * 難點：正規化座標沒有對應的 DOM 節點。做法是把 target 之前的所有
   * 文字節點長度加起來，邊加邊找「跨過 target 的那個節點」，再讓它
   * scrollIntoView。
   *
   * 這是 O(節點數)，只在點擊時跑一次，可以接受。
   */
  function scrollToPosition(pos) {
    var body = $('markdownBody');
    if (!body) return;

    var acc = 0;
    var found = null;
    eachTextNode(body, function (node) {
      if (found) return;
      var len = normalize(node.nodeValue).length;
      if (len === 0) return;
      if (acc + len > pos) { found = node.parentElement; return; }
      acc += len;
    });

    if (found) {
      found.classList.add('sidecar-flash');
      global.setTimeout(function () { found.classList.remove('sidecar-flash'); }, 1400);
      found.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  /* ── 開關 ──────────────────────────────────────────────── */

  function open() {
    if (!hasDom) return;
    var overlay = $('sidecarOverlay');
    if (!overlay) return;

    var work = lookup(global.state?.currentFile);
    if (!work || !work.loci.length) {
      if (global.showToast) global.showToast('這部經還沒有逐句註疏', 'info', 2200);
      return;
    }

    currentWork = work;
    renderHead(work);
    selectLocus(0, false);

    overlay.style.display = 'flex';
    isOpen = true;

    var closeBtn = $('sidecarCloseBtn');
    if (closeBtn && closeBtn.focus) closeBtn.focus();
  }

  function close() {
    var overlay = $('sidecarOverlay');
    if (overlay) overlay.style.display = 'none';
    isOpen = false;
  }

  /* ── 經文裡的浮標 ─────────────────────────────────────── */

  /**
   * 在「有註解」的經文段落旁邊放一個小記號。
   *
   * 這是整個功能的入口感：讀者不用先知道有這個功能，讀到有註的地方
   * 就會看到它可以點。沒有這層，功能又會變成「存在但沒人發現」——
   * 批次 8 就是這樣被指出來的。
   *
   * 段落層級就夠了：一處註解可能落在段中間，但讀者要的是「這一段有
   * 人講過」，不是精確到字。
   */
  function placeMarkers() {
    clearMarkers();
    var body = $('markdownBody');
    if (!body) return;

    var work = lookup(global.state?.currentFile);
    if (!work || !work.loci.length) return;

    var paras = body.querySelectorAll('p');
    if (!paras.length) return;

    var doc = getDocText();

    // 段落起點表（用同一套「排除浮標」的取法，才不會自己干擾自己）
    var starts = [];
    var acc = 0;
    for (var k = 0; k < paras.length; k++) {
      starts.push(acc);
      acc += paragraphLength(paras[k]);
    }

    // 每一處註解落在第幾段（座標先校正過）
    var perPara = {};
    work.loci.forEach(function (l, i) {
      var pos = resolvePosition(l, doc);
      for (var m = starts.length - 1; m >= 0; m--) {
        if (starts[m] <= pos) {
          (perPara[m] = perPara[m] || []).push(i);
          return;
        }
      }
      (perPara[0] = perPara[0] || []).push(i);
    });

    Object.keys(perPara).forEach(function (k) {
      var para = paras[Number(k)];
      if (!para || para.querySelector('.sidecar-marker')) return;
      var idxs = perPara[k];

      var marker = document.createElement('button');
      marker.type = 'button';
      marker.className = 'sidecar-marker';
      marker.setAttribute('aria-label', '看這一段的註疏（' + idxs.length + ' 處）');
      marker.title = idxs.length + ' 處註疏';

      var n = document.createElement('span');
      n.className = 'sidecar-marker-count';
      n.textContent = String(idxs.length);
      marker.appendChild(n);

      marker.addEventListener('click', function (e) {
        e.stopPropagation();
        open();
        selectLocus(idxs[0], true);
      });

      para.appendChild(marker);
      markers.push({ p: Number(k), el: marker });
    });
  }

  /** 一段的座標長度（排除浮標）。 */
  function paragraphLength(para) {
    var parts = [];
    var walker = document.createTreeWalker(para, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var el = node.parentElement;
        if (el && el.closest && el.closest('.sidecar-marker')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var node;
    while ((node = walker.nextNode())) parts.push(node.nodeValue);
    return normalize(parts.join('')).length;
  }

  function clearMarkers() {
    markers.forEach(function (m) {
      if (m.el && m.el.parentElement) m.el.parentElement.removeChild(m.el);
    });
    markers = [];
  }

  /* ── 接上 app.js ──────────────────────────────────────── */

  var lastFile = null;
  var lastLen = -1;

  function tick() {
    var cur = global.state?.currentFile;
    if (cur !== lastFile) {
      lastFile = cur;
      lastLen = -1;
      docText = null;
      docFile = null;
      close();
    }
    // 內容長度變了才重放浮標（渲染完成後 textContent 才有東西）
    var body = $('markdownBody');
    var len = body ? body.textContent.length : 0;
    if (len !== lastLen) {
      lastLen = len;
      if (len > 0) placeMarkers();
    }
  }

  function init() {
    if (!hasDom) return;

    var closeBtn = $('sidecarCloseBtn');
    if (closeBtn) closeBtn.addEventListener('click', close);

    // 工具列入口
    var openBtn = $('sidecarOpenBtn');
    if (openBtn) openBtn.addEventListener('click', open);

    var overlay = $('sidecarOverlay');
    if (overlay) {
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) close();
      });
    }

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isOpen) {
        e.stopPropagation();
        close();
      }
    });

    global.setInterval(tick, 400);
    tick();
  }

  if (hasDom) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  global.SidecarReader = {
    open: hasDom ? open : function () {},
    close: hasDom ? close : function () {},
    isOpen: function () { return isOpen; },
    lookup: lookup,
    /** 測試用：目前文件的座標文字。 */
    _docText: function () { return getDocText(); }
  };

})(typeof window !== 'undefined' ? window : this);
