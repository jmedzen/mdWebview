/**
 * @file parallel-reading.js
 *
 * 同經異譯對讀（alpha 批次 7）。
 *
 * ── 為什麼要有這個
 *
 * 同一部經被譯過很多次。心經在大正藏裡有四個可讀的譯本，它們講同一件
 * 事，但開頭、句式、用詞都不一樣：
 *
 *   T0253（般若共利言）從「觀自在菩薩行深般若波羅蜜多時」直接切入
 *   T0254（智慧輪）  從「如是我聞，一時薄誐梵住王舍城鷲峯山中」講起
 *
 * 這種差異本身就是內容。但在此之前，讀者只能開兩個視窗自己對——而且
 * 這個站連「這部經有幾個譯本」都不會告訴他。
 *
 * ── 為什麼不做逐句對齊
 *
 * 試過了。用「心經核心句」去四個譯本裡找最長共同片段：
 *
 *   T0252 共 13 字（行深般若波羅蜜多時照見五蘊）
 *   T0253 共 15 字（行深般若波羅蜜多時照見五蘊皆空）
 *   T0254 共  0 字
 *   T0255 共 10 字（薩行深般若波羅蜜多時）
 *
 * T0254 一個字都對不上，因為它是完整的「如是我聞」經本，句式跟其他三個
 * 完全不同。硬做逐句對齊會產出一張看起來很聰明、其實整排錯位的表——
 * 那比沒有這個功能更糟。
 *
 * 所以做**並列**：各譯本各自成欄、各自捲動，由人自己比對。這本來就是
 * 學者使用的方式，不是退而求其次。
 *
 * ── 與 app.js 的關係
 *
 * 完全獨立。只讀 state.treeData 找檔案路徑，用 /api/render 取內文，
 * 不改任何既有狀態。
 */

(function (global) {
  'use strict';

  /* ── 譯本資料 ──────────────────────────────────────────── */

  /**
   * 同經異譯組。
   *
   * 只認經號（T0253 這種），實際檔名從 state.treeData 解析——語料換版、
   * 改檔名都不會斷。譯者與年代是編輯判斷，寫死在這裡。
   *
   * 收錄標準：同一部經、有兩個以上可讀譯本、且各譯本都是完整經文
   * （不是節錄、不是註疏）。寧可少收，不要給人「這兩個可以對讀」的
   * 錯誤印象。
   */
  var TRANSLATION_GROUPS = [
    {
      id: 'heart',
      title: '般若波羅蜜多心經',
      note: '四個譯本，字數 576–684。最短的一部經，卻最能看出譯風差異。',
      members: [
        { id: 'T0253', by: '般若共利言等', era: '唐', note: '最通行的流通本系統' },
        { id: 'T0254', by: '智慧輪', era: '唐', note: '完整經本，有「如是我聞」' },
        { id: 'T0255', by: '法成', era: '唐', note: '燉煌石室本' },
        { id: 'T0252', by: '法月', era: '唐', note: '題為《普遍智藏》，重譯本' }
      ]
    },
    {
      id: 'amitabha',
      title: '阿彌陀經',
      note: '淨土核心經典。兩個譯本的分段與偈頌位置不同。',
      members: [
        { id: 'T0366', by: '鳩摩羅什', era: '姚秦', note: '流通最廣' },
        { id: 'T0367', by: '玄奘', era: '唐', note: '題為《稱讚淨土佛攝受經》' }
      ]
    },
    {
      id: 'diamond',
      title: '金剛般若波羅蜜經',
      note: '四個譯本。同一個句子在四個譯者筆下，可以差到認不出來。',
      /*
       * 原本想收 T0236（菩提流支）與 T0220（《大般若經》第九會）。
       * 前者不在這批語料裡；後者是 600 卷、467 萬字的整部大般若，
       * 放進對讀欄會讓瀏覽器卡死，而且逐句比對也沒有意義——讀者要的
       * 是「第九會那一段」，不是把 467 萬字鋪在旁邊。所以兩個都不收。
       */
      members: [
        { id: 'T0235', by: '鳩摩羅什', era: '姚秦', note: '最通行的流通本' },
        { id: 'T0237', by: '真諦', era: '陳', note: '' },
        { id: 'T0238', by: '笈多', era: '隋', note: '直譯體，最貼梵文語序' },
        { id: 'T0239', by: '義淨', era: '唐', note: '題為《能斷金剛般若》' }
      ]
    },
    {
      id: 'vimalakirti',
      title: '維摩詰所說經',
      note: '三個譯本，從「維摩詰」到「無垢稱」，連經名都不同。',
      members: [
        { id: 'T0475', by: '鳩摩羅什', era: '姚秦', note: '流通最廣' },
        { id: 'T0476', by: '玄奘', era: '唐', note: '題為《說無垢稱經》' },
        { id: 'T0474', by: '支謙', era: '吳', note: '題為《維摩詰經》，最早的譯本' }
      ]
    }
  ];

  /* ── 狀態 ──────────────────────────────────────────────── */

  var isOpen = false;
  var currentGroup = null;
  /** 目前選取的譯本經號（字串陣列，順序 = 欄位順序）。 */
  var selected = [];
  /** 已載入的內文快取：`{ 'T0253': { html, title, by } }`。 */
  var textCache = {};
  /** 防止舊的非同步結果蓋掉新的。 */
  var loadSeq = 0;

  /* ── 小工具 ────────────────────────────────────────────── */

  function $(id) {
    return document.getElementById(id);
  }

  /* ── 找檔案路徑 ────────────────────────────────────────── */

  /**
   * 從檔案樹裡找出某個經號的檔案路徑。
   *
   * 樹裡的檔名格式是 `T0253《般若波羅蜜多心經》.md`，所以用 `/^T0253[《(]/`
   * 比對開頭就好——不要用 includes，否則 T025 會誤中 T0250x。
   *
   * @param {string} id - 經號，例如 'T0253'
   * @returns {string|null}
   */
  function findPathById(id) {
    var st = global.state;
    var tree = st && st.treeData;
    if (!Array.isArray(tree)) return null;

    var re = new RegExp('^' + id + '(?![0-9])');
    var found = null;

    (function walk(nodes) {
      if (found || !Array.isArray(nodes)) return;
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (!n) continue;
        if (n.type === 'file' && n.name && re.test(n.name)) {
          found = n.path;
          return;
        }
        if (n.children) walk(n.children);
        if (found) return;
      }
    })(tree);

    return found;
  }

  /**
   * 找出某個經號屬於哪一組、以及它的譯者資訊。
   *
   * @param {string} id
   * @returns {{by:string, era:string, note:string}|null}
   */
  function findMemberInfo(id) {
    for (var i = 0; i < TRANSLATION_GROUPS.length; i++) {
      var g = TRANSLATION_GROUPS[i];
      for (var j = 0; j < g.members.length; j++) {
        if (g.members[j].id === id) return g.members[j];
      }
    }
    return null;
  }

  /** 找到一部經的顯示標題（樹裡的檔名去掉 .md）。 */
  function findTitleById(id) {
    var st = global.state;
    var tree = st && st.treeData;
    if (!Array.isArray(tree)) return id;
    var re = new RegExp('^' + id + '(?![0-9])');
    var found = null;
    (function walk(nodes) {
      if (found || !Array.isArray(nodes)) return;
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (!n) continue;
        if (n.type === 'file' && n.name && re.test(n.name)) { found = n.name; return; }
        if (n.children) walk(n.children);
        if (found) return;
      }
    })(tree);
    return found || id;
  }

  /* ── 取得內文 ──────────────────────────────────────────── */

  /** CBETA 的行政區塊標記（對讀時一律略過）。 */
  var CBETA_ADMIN_RE = /^【(經文資訊|版本記錄|編輯說明|原始資料|其他事項|缺字資料|校勘資訊)】|^本資料庫|^CBETA/;

  /**
   * 把 /api/render 回的 HTML 整理成「可讀的經文」。
   *
   * 原始輸出是給閱讀器用的，帶行號錨點與 `<br>`；而且開頭有一堆 CBETA
   * 的編輯說明行（`//【經文資訊】…`），那些在閱讀器裡是註解，在對讀時
   * 只是雜訊。這裡把它們拆開：說明行收進一個小區塊，正文照常分段。
   *
   * @param {string} html - /api/render 的輸出
   * @returns {{head: string, body: string}}
   */
  function shapeRenderedText(html) {
    /*
     * /api/render 的輸出結構是：一個 <p> 裡放好幾行、行間用 <br>，
     * 段落之間才是 </p><p>。
     *
     * 這裡犯過一次錯：把 <br> 與 </p> 都換成 \n 之後，又用「空行才斷段」
     * 的方式重組，結果整部經被併成一個 691 字的巨大段落——完全不可讀。
     *
     * 正確做法是保留「段落邊界」的資訊：</p> 換成一個哨兵，<br> 只換成
     * 普通換行。重組時哨兵才斷段。
     */
    var PARA = '\u0000PARA\u0000';
    var parts = String(html)
      .replace(/<span[^>]*class="line-anchor"[^>]*><\/span>/g, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, PARA)
      .replace(/<\/(div|h[1-6]|li|blockquote)>/gi, PARA)
      .replace(/<p[^>]*>/gi, '')
      .split(PARA);

    var headLines = [];
    var bodyParas = [];

    for (var i = 0; i < parts.length; i++) {
      var raw = parts[i]
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');

      // 一段裡面可能還有 <br> 造成的換行；逐行判定
      var lines = raw.split('\n');
      var kept = [];

      for (var j = 0; j < lines.length; j++) {
        var line = lines[j].trim();
        if (!line) continue;

        // CBETA 編輯說明行：`//【經文資訊】…`
        if (line.indexOf('//') === 0) {
          var clean = line.replace(/^\/+\s*/, '').trim();
          /*
           * 行政區塊對讀時沒有用：四個譯本的【經文資訊】【版本記錄】
           * 【編輯說明】幾乎一字不差，兩欄並排只是把同樣的字看兩遍，
           * 還會把真正的經文擠到螢幕外。只留經題、譯者這種每本都不同
           * 的資訊（那些在正文裡，不在這裡）。
           */
          // 純分隔線（`-----`）也是裝飾，不留
          if (clean && !CBETA_ADMIN_RE.test(clean) && !/^-{3,}$/.test(clean)) headLines.push(clean);
          continue;
        }
        kept.push(line);
      }

      if (kept.length) bodyParas.push(kept.join(''));
    }

    return { head: headLines.join('\n'), body: bodyParas.join('\n\n') };
  }

  /** 取一個譯本的內文（有快取）。 */
  function loadText(id) {
    if (textCache[id]) return Promise.resolve(textCache[id]);

    var path = findPathById(id);
    if (!path) {
      return Promise.reject(new Error('NOT_FOUND'));
    }

    return fetch('/api/render?path=' + encodeURIComponent(path), { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then(function (html) {
        var shaped = shapeRenderedText(html);
        var rec = {
          id: id,
          title: findTitleById(id),
          head: shaped.head,
          body: shaped.body
        };
        textCache[id] = rec;
        return rec;
      });
  }

  /* ── 渲染 ──────────────────────────────────────────────── */

  /**
   * 把一段純文字切成 <p>。
   *
   * 不直接用 innerHTML 塞入伺服器回傳的 HTML，因為對讀只需要「一段一段
   * 的文字」，而伺服器的 HTML 帶著閱讀器用的行號錨點、`<br>`、註解，
   * 那些在對讀欄裡沒有意義。自己建 DOM 也順便避開 XSS 面。
   */
  function textToParagraphs(container, text) {
    var lines = String(text || '').split('\n');
    var buf = [];

    function flush() {
      if (!buf.length) return;
      var p = document.createElement('p');
      p.textContent = buf.join('');
      container.appendChild(p);
      buf = [];
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) { flush(); continue; }
      buf.push(line);
    }
    flush();
  }

  /** 畫一欄譯本。 */
  function renderColumn(id, colIndex) {
    var col = document.createElement('div');
    col.className = 'parallel-col';
    col.setAttribute('data-id', id);

    var head = document.createElement('div');
    head.className = 'parallel-col-head';

    /*
     * 欄頭不要只寫經題。四個心經譯本有三個都叫《般若波羅蜜多心經》，
     * 並排時讀者根本分不出誰是誰——真正能分辨的是譯者。
     * 所以主標是譯者，副標才是經題 + 經號。
     */
    var info = findMemberInfo(id);
    var h = document.createElement('h3');
    h.className = 'parallel-col-title';
    h.textContent = info && info.by ? info.by : id;
    if (info && info.era) {
      var era = document.createElement('span');
      era.className = 'parallel-col-era';
      era.textContent = '（' + info.era + '）';
      h.appendChild(era);
    }
    head.appendChild(h);

    var meta = document.createElement('div');
    meta.className = 'parallel-col-meta';
    // 檔名本身已含經號（T0253《…》），不要再接一次
    var titleText = findTitleById(id).replace(/\.md$/, '');
    meta.textContent = titleText;
    head.appendChild(meta);

    if (info && info.note) {
      var note = document.createElement('div');
      note.className = 'parallel-col-note';
      note.textContent = info.note;
      head.appendChild(note);
    }

    col.appendChild(head);

    var text = document.createElement('div');
    text.className = 'parallel-col-text';
    text.setAttribute('role', 'article');
    text.setAttribute('aria-label', findTitleById(id));
    text.textContent = '載入中…';
    col.appendChild(text);

    return col;
  }

  /** 畫所有欄位。 */
  function renderColumns() {
    var wrap = $('parallelColumns');
    if (!wrap) return;
    wrap.textContent = '';

    if (!selected.length) {
      var empty = document.createElement('div');
      empty.className = 'parallel-status';
      empty.textContent = '選至少一個譯本。';
      wrap.appendChild(empty);
      return;
    }

    for (var i = 0; i < selected.length; i++) {
      wrap.appendChild(renderColumn(selected[i], i));
    }

    // 逐欄填入內文
    var seq = ++loadSeq;
    selected.forEach(function (id) {
      loadText(id)
        .then(function (rec) {
          if (seq !== loadSeq) return;   // 已經換過組合，丟掉舊結果
          var col = wrap.querySelector('.parallel-col[data-id="' + id + '"]');
          if (!col) return;
          var body = col.querySelector('.parallel-col-text');
          if (!body) return;
          body.textContent = '';

          // 經題與譯者先放一段小字
          if (rec.head) {
            var headEl = document.createElement('div');
            headEl.className = 'parallel-head';
            headEl.textContent = rec.head;
            body.appendChild(headEl);
          }
          textToParagraphs(body, rec.body);
          renderFoot();
        })
        .catch(function (err) {
          if (seq !== loadSeq) return;
          var col = wrap.querySelector('.parallel-col[data-id="' + id + '"]');
          if (!col) return;
          var body = col.querySelector('.parallel-col-text');
          if (!body) return;
          body.textContent = '';
          var msg = document.createElement('p');
          msg.className = 'parallel-note';
          msg.textContent = err && err.message === 'NOT_FOUND'
            ? '找不到這一部（語料裡沒有 ' + id + '）。'
            : '載入失敗，請稍後再試。';
          body.appendChild(msg);
          renderFoot();
        });
    });
  }

  /** 底部統計：字數對比是對讀最有用的量化資訊。 */
  function renderFoot() {
    var el = $('parallelFoot');
    if (!el) return;
    el.textContent = '';

    var loaded = selected.map(function (id) { return textCache[id]; }).filter(Boolean);
    if (!loaded.length) return;

    loaded.forEach(function (rec) {
      var han = (String(rec.body).match(/[\u4e00-\u9fff]/g) || []).length;
      var span = document.createElement('span');
      var k = document.createElement('strong');
      k.textContent = rec.id;
      span.appendChild(k);
      span.appendChild(document.createTextNode(' ' + han + ' 字'));
      el.appendChild(span);
    });

    // 字數差距：最能一眼看出的量化差異
    if (loaded.length >= 2) {
      var counts = loaded.map(function (r) {
        return (String(r.body).match(/[\u4e00-\u9fff]/g) || []).length;
      }).filter(function (n) { return n > 0; });
      if (counts.length >= 2) {
        var min = Math.min.apply(null, counts);
        var max = Math.max.apply(null, counts);
        if (min > 0 && max / min > 1.05) {
          var diff = document.createElement('span');
          var k2 = document.createElement('strong');
          k2.textContent = '差距';
          diff.appendChild(k2);
          diff.appendChild(document.createTextNode(
            ' 最長比最短多 ' + Math.round((max / min - 1) * 100) + '%'
          ));
          el.appendChild(diff);
        }
      }
    }
  }

  /** 畫譯本選擇列。 */
  function renderPicker() {
    var el = $('parallelPicker');
    if (!el) return;
    el.textContent = '';

    if (!currentGroup) return;

    selected.forEach(function (id, idx) {
      var slot = document.createElement('div');
      slot.className = 'parallel-slot';

      var label = document.createElement('span');
      label.className = 'parallel-slot-label';
      label.textContent = '第 ' + (idx + 1) + ' 欄';
      slot.appendChild(label);

      var sel = document.createElement('select');
      sel.setAttribute('aria-label', '第 ' + (idx + 1) + ' 欄的譯本');

      currentGroup.members.forEach(function (m) {
        var opt = document.createElement('option');
        opt.value = m.id;
        // 已經在別的欄出現的，標記出來但不禁止（有人會想並排同一本看不同段）
        opt.textContent = m.by + (m.era ? '（' + m.era + '）' : '') + '　' + m.id;
        if (m.id === id) opt.selected = true;
        sel.appendChild(opt);
      });

      sel.addEventListener('change', function () {
        selected[idx] = sel.value;
        renderPicker();
        renderColumns();
      });
      slot.appendChild(sel);

      // 只剩一欄時不給移除（對讀至少要一欄，但一欄沒意義——允許，但不給刪到 0）
      var rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'parallel-slot-remove';
      rm.textContent = '✕';
      rm.title = '移除這一欄';
      rm.setAttribute('aria-label', '移除第 ' + (idx + 1) + ' 欄');
      rm.disabled = selected.length <= 1;
      rm.addEventListener('click', function () {
        if (selected.length <= 1) return;
        selected.splice(idx, 1);
        renderPicker();
        renderColumns();
      });
      slot.appendChild(rm);

      el.appendChild(slot);
    });

    // 新增一欄
    var add = document.createElement('button');
    add.type = 'button';
    add.className = 'parallel-add';
    add.textContent = '+ 增加一欄';
    // 上限四欄：再多就每欄不到 280px，中文直排會擠成一條線
    var canAdd = selected.length < Math.min(4, currentGroup.members.length);
    add.disabled = !canAdd;
    if (!canAdd) add.title = '最多並排四欄';
    add.addEventListener('click', function () {
      if (!canAdd) return;
      // 挑一個還沒用過的譯本
      var unused = currentGroup.members.filter(function (m) {
        return selected.indexOf(m.id) < 0;
      });
      if (!unused.length) return;
      selected.push(unused[0].id);
      renderPicker();
      renderColumns();
    });
    el.appendChild(add);
  }

  /* ── 開關 ──────────────────────────────────────────────── */

  /**
   * 打開對讀。
   *
   * @param {string} [groupId] - 指定哪一組；不給就開第一組
   */
  function open(groupId) {
    var overlay = $('parallelReadingOverlay');
    if (!overlay) return;

    if (!currentGroup || (groupId && groupId !== currentGroup.id)) {
      currentGroup = TRANSLATION_GROUPS.filter(function (g) {
        return g.id === groupId;
      })[0] || TRANSLATION_GROUPS[0];
      // 預設並排兩欄：第一組最容易看出差異的兩個
      selected = currentGroup.members.slice(0, 2).map(function (m) { return m.id; });
    }

    isOpen = true;
    overlay.style.display = 'flex';

    var title = $('parallelReadingTitle');
    if (title) title.textContent = '同經異譯對讀 · ' + currentGroup.title;

    renderPicker();
    renderColumns();

    var closeBtn = $('parallelReadingCloseBtn');
    if (closeBtn && closeBtn.focus) closeBtn.focus();
  }

  function close() {
    var overlay = $('parallelReadingOverlay');
    if (overlay) overlay.style.display = 'none';
    isOpen = false;
    loadSeq++;   // 讓進行中的載入作廢
  }

  /* ── 初始化 ────────────────────────────────────────────── */

  function init() {
    var closeBtn = $('parallelReadingCloseBtn');
    if (closeBtn) closeBtn.addEventListener('click', close);

    var overlay = $('parallelReadingOverlay');
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

    /* 首頁的入口。用事件委派而非直接綁定：首頁 chip 可能在模組載入後
       才由 app.js 重建，直接綁會失效。 */
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      if (!t.closest('#homeParallelOpen')) return;
      open();
    });
  }

  var hasDom = (typeof document !== 'undefined');

  if (hasDom) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  global.ParallelReading = {
    open: hasDom ? open : function () {},
    close: hasDom ? close : function () {},
    groups: TRANSLATION_GROUPS,
    findPathById: findPathById,
    findMemberInfo: findMemberInfo,
    shapeRenderedText: shapeRenderedText,
    isOpen: function () { return hasDom && isOpen; }
  };

})(typeof window !== 'undefined' ? window : this);
