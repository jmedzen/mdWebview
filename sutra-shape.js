/**
 * @file sutra-shape.js
 *
 * 「這部經的形狀」——把整部經的結構畫成一張可點的地圖（alpha 批次 12）。
 *
 * ── 要解決的問題
 *
 * 語料裡有 2,231 個檔案超過三萬字，《大般若經》單一檔案 467 萬字、
 * 1,894 個標題。從首頁經文流點進去，中位數 7,373 字，四分之一超過
 * 25,110 字，32 個檔案超過十萬字。
 *
 * 讀者面對一堵 467 萬字的牆，唯一的工具是左邊的大綱列表——那是一個
 * 1,894 項的清單。清單告訴你「有哪些標題」，不告訴你「這部經長什麼
 * 樣子、我現在在哪、還剩多少」。
 *
 * ── 這次做什麼
 *
 * 在閱讀頁頂端放一條「卷軸」：整部經的結構壓成一排細塊，每一塊是一
 * 卷（或一品）。寬度按內文比例分配——大般若經第一分很長，第十會很短，
 * 在地圖上就是看得出長短。
 *
 * 上面再疊一個「你在這裡」的標記，隨捲動移動。
 *
 * ── 為什麼不是進度條
 *
 * 進度條只回答「幾 %」。這個要回答的是「這部經有幾卷、我讀到第幾卷、
 * 接下來那幾卷叫什麼」——地圖，不是儀表板。
 *
 * 所以它可點：點第 400 卷就跳到第 400 卷。這是導覽，不是計分。
 *
 * ── 與既有功能的邊界
 *
 * 左側的「大綱」面板（app.js 的 buildToc）是逐項列表，適合找特定標題；
 * 這裡是整體形狀，適合決定「要不要繼續讀、從哪裡讀」。兩者互補，不取代。
 */

(function (global) {
  'use strict';

  var hasDom = (typeof document !== 'undefined');

  /** 低於這個規模不值得畫地圖——一兩卷的經，列表就夠了。 */
  var MIN_MARKS = 4;

  var MARK_LIMIT = 180;        // 最多畫幾塊（再多就沒有一塊點得動）

  var barEl = null;
  var currentFile = null;
  var marks = [];               // [{ label, ratio, top, height }]
  var spyBound = false;
  var rafPending = false;

  function $(id) { return document.getElementById(id); }

  /* ── 解析結構 ─────────────────────────────────────────── */

  /**
   * 從已渲染的 DOM 抓標題，不要重讀檔案。
   *
   * 理由：app.js 用 Worker 分塊渲染，我們拿不到原始 markdown；但畫面上
   * 已經有 <h2> 了。用 DOM 同時保證「標題是真的被顯示出來的」——有些
   * 檔案裡的 ## 會被過濾掉，用 DOM 就不會畫出一個點不到的塊。
   */
  function collectHeadings(body) {
    if (!body) return [];

    var out = [];

    // 正常情況：markdown 的 ## 變成 <h2>、# 變成 <h1>
    var nodes = body.querySelectorAll('h1, h2, h3');
    for (var i = 0; i < nodes.length; i++) {
      var text = (nodes[i].textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      out.push({ el: nodes[i], text: text });
    }
    if (out.length) return out;

    /*
     * 退路：沒有 <h2> 的渲染環境。
     *
     * 實際會遇到兩種情況：
     *   1. 檔案本身沒有 ## 標題（純經文，占 53.5%）
     *   2. 渲染器把標題當成一般段落輸出
     *
     * 第二種如果直接放棄，地圖就永遠不出現——而它正是最需要地圖的那種
     * 大部頭。所以退而找「看起來像標題的段落」：只有一行的短 <p>，
     * 且含「品」「卷」這類字。
     */
    var paras = body.querySelectorAll('p');
    for (var k = 0; k < paras.length; k++) {
      var t = (paras[k].textContent || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 40) continue;
      if (!/[品卷]/.test(t)) continue;
      out.push({ el: paras[k], text: t });
    }
    return out;
  }

  /**
   * 標題清得太長或太雜時，退一步只取「卷」。
   *
   * 實際遇到的髒資料：
   *   「大般若波羅蜜多經卷第二三藏法師玄奘奉　詔譯」
   *     ← 卷名與譯者行被合併成一個標題
   * 這種標題直接畫上去會讓地圖變成看不懂的長條。
   */
  function simplify(text) {
    // 「卷第二三藏法師玄奘奉詔譯」→「卷第二」
    var m = text.match(/^(.*?卷[第]?[一二三四五六七八九十百千\d]+)/);
    if (m && m[1].length >= 2) return m[1];
    if (text.length <= 22) return text;
    return text.slice(0, 20) + '…';
  }

  /**
   * 建立「區塊」序列。
   *
   * 優先序：
   *   1. 有「品」就用品（法華、大般若、華嚴都是這樣分部）
   *   2. 沒有品就用卷
   *   3. 都沒有就用全部標題
   *
   * 判斷看標題字串本身，不猜語義。
   */
  function buildMarks(body) {
    var heads = collectHeadings(body);
    if (heads.length < MIN_MARKS) return [];

    var pins = heads.filter(function (h) { return /品/.test(h.text); });
    var juans = heads.filter(function (h) { return /卷/.test(h.text) && !/品/.test(h.text); });

    var chosen;
    var kind;
    if (pins.length >= MIN_MARKS) { chosen = pins; kind = 'pin'; }
    else if (juans.length >= MIN_MARKS) { chosen = juans; kind = 'juan'; }
    else { chosen = heads; kind = 'head'; }

    /*
     * 太多就抽稀。
     *
     * 大般若經有 772 品，全部畫出來每塊不到 0.4px，點不動也看不出來。
     * 抽稀的方式是「等距取樣」而不是「取前面 N 個」——取前面會讓地圖
     * 只反映開頭，後面全部空白，那比不畫更誤導。
     */
    var step = 1;
    if (chosen.length > MARK_LIMIT) {
      step = Math.ceil(chosen.length / MARK_LIMIT);
    }

    var picked = [];
    for (var i = 0; i < chosen.length; i += step) picked.push(chosen[i]);

    /*
     * 每一塊的位置與高度，用「下一個標題的 top」減「這個標題的 top」算。
     *
     * 這樣地圖的長短比例就等於真實篇幅：大般若經第一分很長、第十會很
     * 短，在地圖上看得出來。
     */
    var bodyRect = body.getBoundingClientRect();
    var total = body.scrollHeight || bodyRect.height || 1;

    /*
     * 位置一律換算成「相對 #markdownBody 頂端」。
     *
     * 不能用 el.offsetTop——那是相對最近的 positioned 祖先。實際踩到：
     * 點法華經第 10 品，捲到 80,414px（整份文件 51% 處），因為那幾個
     * 標題的 offsetParent 不是 body。
     *
     * 正解：用 getBoundingClientRect 的差值，它不受 offsetParent 影響。
     * 座標系要跟 body.scrollHeight 一致（body 頂端為 0）。
     */
    function topWithin(el) {
      return el.getBoundingClientRect().top - bodyRect.top;
    }

    var out = [];
    for (var k = 0; k < picked.length; k++) {
      var el = picked[k].el;
      var top = topWithin(el);
      var nextTop = k + 1 < picked.length
        ? topWithin(picked[k + 1].el)
        : total;

      var height = Math.max(1, nextTop - top);
      out.push({
        label: simplify(picked[k].text),
        full: picked[k].text,
        ratio: top / total,
        height: height / total,
        top: top,
        el: el
      });
    }

    out.kind = kind;
    out.totalCount = chosen.length;
    out.shownCount = picked.length;
    out.step = step;
    return out;
  }

  /* ── 畫 ───────────────────────────────────────────────── */

  function ensureBar() {
    if (barEl && barEl.isConnected) return barEl;

    var content = $('content');
    var wrapper = $('contentWrapper');
    if (!content || !wrapper) return null;

    barEl = document.createElement('div');
    barEl.className = 'sutra-shape';
    barEl.id = 'sutraShape';
    barEl.setAttribute('role', 'navigation');
    barEl.setAttribute('aria-label', '這部經的結構');

    /*
     * 說明列：左邊寫「772 品」，右邊寫「全 467 萬字」。
     *
     * 沒有這一行，地圖只是抽象的灰條——讀者不知道自己在看什麼。有了
     * 字數與品數，「467 萬字」才變成看得見的長度。
     */
    var cap = document.createElement('div');
    cap.className = 'sutra-shape-caption';
    cap.id = 'sutraShapeCaption';
    barEl.appendChild(cap);

    var track = document.createElement('div');
    track.className = 'sutra-shape-track';
    track.id = 'sutraShapeTrack';

    var strip = document.createElement('div');
    strip.className = 'sutra-shape-strip';
    strip.id = 'sutraShapeStrip';
    track.appendChild(strip);
    barEl.appendChild(track);

    // 「你在這裡」：一條細線，跟著捲動移動
    var here = document.createElement('div');
    here.className = 'sutra-shape-here';
    here.id = 'sutraShapeHere';
    track.appendChild(here);

    // hover 時顯示那一塊是什麼
    var tip = document.createElement('div');
    tip.className = 'sutra-shape-tip';
    tip.id = 'sutraShapeTip';
    tip.hidden = true;
    track.appendChild(tip);

    /*
     * 插在 contentHeader 之後、kepanBar 之前。
     *
     * 位置在經文最上方，但它很薄（28px），不會把經文推下去太多。
     */
    var header = $('contentHeader');
    if (header && header.parentNode === wrapper) {
      wrapper.insertBefore(barEl, header.nextSibling);
    } else {
      wrapper.insertBefore(barEl, wrapper.firstChild);
    }

    bindScroll();
    return barEl;
  }

  /**
   * 標題列：品數與總字數。
   *
   * 「467 萬字」放在地圖旁邊，抽象的長條才有尺度。
   */
  function renderCaption() {
    var cap = $('sutraShapeCaption');
    if (!cap || !marks.length) return;

    /*
     * 只算漢字。
     *
     * 用「去空白總字元」會把標點、梵文轉寫、校勘符號都算進去：大般若經
     * 實際 467 萬漢字，去空白算是 556 萬——多出來的 89 萬全是這些。
     * 「556 萬字」對讀者是錯的資訊。
     */
    var body = $('markdownBody');
    var raw = body ? (body.textContent || '') : '';
    var chars = (raw.match(/[\u4e00-\u9fff]/g) || []).length;

    var kindName = marks.kind === 'pin' ? '品'
      : marks.kind === 'juan' ? '卷' : '節';

    cap.textContent = '';

    var left = document.createElement('span');
    left.className = 'sutra-shape-count';
    left.textContent = marks.totalCount + ' ' + kindName
      + (marks.shownCount < marks.totalCount ? '（圖上每 ' + marks.step + ' 個畫一格）' : '');
    cap.appendChild(left);

    if (chars > 0) {
      var right = document.createElement('span');
      right.className = 'sutra-shape-chars';
      right.textContent = chars >= 10000
        ? (chars / 10000).toFixed(0) + ' 萬字'
        : chars.toLocaleString() + ' 字';
      cap.appendChild(right);
    }
  }

  function renderBar() {
    var bar = ensureBar();
    if (!bar) return;

    if (marks.length) renderCaption();

    var strip = $('sutraShapeStrip');
    if (!strip) return;

    strip.textContent = '';

    for (var i = 0; i < marks.length; i++) {
      (function (mk, idx) {
        var seg = document.createElement('button');
        seg.type = 'button';
        seg.className = 'sutra-shape-seg';
        seg.setAttribute('aria-label', mk.label);

        /*
         * 高度用 flex-grow 表示篇幅。
         *
         * 用 flex 而不是絕對定位：這樣瀏覽器自己算比例，視窗縮放時不必
         * 重算。grow 給一個下限，避免極短的塊變成 0px 點不到。
         */
        seg.style.flexGrow = String(Math.max(mk.height * 100, 0.6));
        seg.style.flexBasis = '0';

        // 每 10 塊標一個刻度，太多標籤會擠成一團
        if (idx % 10 === 0 || idx === marks.length - 1) {
          seg.classList.add('is-major');
        }

        seg.addEventListener('click', function () {
          jumpTo(mk);
        });

        seg.addEventListener('mouseenter', function () { showTip(seg, mk); });
        seg.addEventListener('focus', function () { showTip(seg, mk); });
        seg.addEventListener('mouseleave', hideTip);
        seg.addEventListener('blur', hideTip);

        strip.appendChild(seg);
      })(marks[i], i);
    }

    bar.hidden = false;
    updateHere();
  }

  function showTip(seg, mk) {
    var tip = $('sutraShapeTip');
    if (!tip) return;
    tip.textContent = mk.full || mk.label;
    tip.hidden = false;

    var barRect = barEl.getBoundingClientRect();
    var segRect = seg.getBoundingClientRect();
    var left = segRect.left - barRect.left + segRect.width / 2;
    tip.style.left = Math.max(6, Math.min(left, barRect.width - 6)) + 'px';
  }

  function hideTip() {
    var tip = $('sutraShapeTip');
    if (tip) tip.hidden = true;
  }

  /* ── 跳與追蹤 ─────────────────────────────────────────── */

  function jumpTo(mk) {
    if (!mk || !mk.el) return;
    var content = $('content');
    var body = $('markdownBody');
    if (!content || !body) return;

    /*
     * 目標位置 = 該標題相對 body 的位移 + body 相對 content 的位移。
     *
     * 直接把「相對 body」的值丟給 scrollTo 會少算 contentHeader 的高度，
     * 跳過去會差一截。
     */
    var bodyTop = body.getBoundingClientRect().top
      - content.getBoundingClientRect().top
      + content.scrollTop;

    var target = bodyTop + mk.ratio * (body.scrollHeight || 1);
    content.scrollTo({ top: Math.max(0, target - 24), behavior: 'smooth' });
  }

  /**
   * 更新「你在這裡」。
   *
   * 用捲動位置對照每一塊的 top，找出目前落在哪一塊。線性掃描就夠——
   * marks 最多 180 個。
   */
  function updateHere() {
    var here = $('sutraShapeHere');
    if (!here || !marks.length) return;

    var content = $('content');
    var body = $('markdownBody');
    if (!content || !body) return;

    var total = body.scrollHeight || 1;
    if (total <= 1) { here.hidden = true; return; }

    var ratio = content.scrollTop / total;
    if (ratio < 0) ratio = 0;
    if (ratio > 1) ratio = 1;

    here.hidden = false;
    here.style.left = (ratio * 100) + '%';

    // 目前在哪一塊：讓那一塊亮起來
    var idx = 0;
    for (var i = 0; i < marks.length; i++) {
      if (marks[i].ratio <= ratio) idx = i; else break;
    }

    var strip = $('sutraShapeStrip');
    if (strip) {
      var prev = strip.querySelector('.sutra-shape-seg.is-current');
      if (prev) prev.classList.remove('is-current');
      var cur = strip.children[idx];
      if (cur) cur.classList.add('is-current');
    }
  }

  function onScroll() {
    if (rafPending) return;
    rafPending = true;
    var raf = global.requestAnimationFrame || function (fn) { return global.setTimeout(fn, 16); };
    raf(function () {
      rafPending = false;
      updateHere();
    });
  }

  function bindScroll() {
    if (spyBound) return;
    var content = $('content');
    if (!content) return;
    content.addEventListener('scroll', onScroll, { passive: true });
    spyBound = true;
  }

  /* ── 起動 ─────────────────────────────────────────────── */

  function refresh() {
    var file = global.state && global.state.currentFile;
    var body = $('markdownBody');

    if (!file || !body || !body.children.length) {
      if (barEl) barEl.hidden = true;
      marks = [];
      return;
    }

    // 同一份文件不重算（這個函式會被 450ms 輪詢呼叫）
    var sig = file + '::' + body.children.length;
    if (sig === currentFile) { updateHere(); return; }
    currentFile = sig;

    marks = buildMarks(body);

    if (!marks.length) {
      if (barEl) barEl.hidden = true;
      return;
    }

    renderBar();
  }

  var lastFile = null;
  var lastLen = -1;

  function tick() {
    var file = global.state && global.state.currentFile;
    var body = $('markdownBody');
    var len = body ? body.children.length : 0;

    if (file !== lastFile || len !== lastLen) {
      lastFile = file;
      lastLen = len;
      refresh();
    }
  }

  function init() {
    if (!hasDom) return;
    tick();
    global.setInterval(tick, 500);
  }

  if (hasDom) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  global.SutraShape = {
    refresh: hasDom ? refresh : function () {},
    /** 測試用 */
    _marks: function () { return marks; },
    _build: hasDom ? buildMarks : function () { return []; }
  };

})(typeof window !== 'undefined' ? window : this);
