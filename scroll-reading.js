/**
 * @file scroll-reading.js
 *
 * 首頁經文流（alpha 批次 11）。
 *
 * ── 為什麼要動首頁
 *
 * 前九個批次做的東西（藏經地圖、同經異譯、註疏譜系、逐句註疏、經註並讀）
 * 全部掛在首頁下方六個小晶片裡。而首頁的第一屏是一朵蓮花、站名、搜尋框
 * 與三張入門卡——十輪的功能，換來一個「啟動器」。
 *
 * 一個佛典閱讀器的首頁不讀經，是本末倒置。
 *
 * ── 這次的做法
 *
 * 首頁往下就是經文，一段接一段，像翻一本書。捲到底自動接下一段，不會
 * 停在「沒有了」。
 *
 * 不做「隨機抽一句」——抽句是斷的。這裡給的是完整段落，有主語有動作，
 * 單獨看也讀得懂（見 scripts/gen-passages.js 的挑選規則）。
 *
 * ── 與其他部分怎麼接
 *
 * 每段底下標出處（經號與經名），並帶兩條路：
 *   「讀這部經」  → mdwOpenFile(path)，從頭讀
 *   「看這一段」  → mdwOpenFile(path, line)，跳到原文那一行
 *
 * 第二條是重點：它把「首頁讀到的一段話」變成「在整部經裡的位置」。
 * 只給第一條，讀者會失去他在讀的那一段；只給第二條，他沒有上下文。
 *
 * ── 入口
 *
 * 不需要入口——它就是首頁本身，往下捲就看到了。第一次來的訪客與回訪
 * 的人都會經過，不像前面五個功能都要先知道它存在。
 */

(function (global) {
  'use strict';

  var hasDom = (typeof document !== 'undefined');

  var STORAGE_KEY = 'mdw.scrollReading';   // 'on' | 'off'
  var BATCH = 6;                            // 一次載入幾段
  var MAX_DOM = 60;                         // DOM 裡最多留幾段（避免長捲動卡頓）

  var feedEl = null;
  var sentinelEl = null;
  var observer = null;
  var cursor = 0;
  var rendered = [];                        // 已渲染的元素，用來回收舊的
  var enabled = null;
  var seeded = false;

  function $(id) { return document.getElementById(id); }

  /* ── 偏好 ─────────────────────────────────────────────── */

  function readPref() {
    try {
      var v = global.localStorage && global.localStorage.getItem(STORAGE_KEY);
      if (v === 'off') return false;
    } catch (_) { /* 無痕模式 */ }
    return true;
  }

  function writePref(on) {
    try {
      global.localStorage && global.localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
    } catch (_) { /* 忽略 */ }
  }

  /* ── 建構 ─────────────────────────────────────────────── */

  /**
   * 把經文流插在「入門卡」之後、「我的書架」之前。
   *
   * 位置是刻意選的：第一屏仍然是站名與搜尋（那是給「我已經知道要讀
   * 什麼」的人），但往下一捲就是經文，而不是公告與推薦。
   */
  function ensureFeed() {
    if (feedEl && feedEl.isConnected) return feedEl;

    var home = $('welcomeScreen');
    if (!home) return null;

    feedEl = document.createElement('section');
    feedEl.className = 'scroll-reading';
    feedEl.id = 'scrollReading';
    feedEl.setAttribute('aria-labelledby', 'scrollReadingLabel');

    var head = document.createElement('div');
    head.className = 'scroll-reading-head';

    var label = document.createElement('h2');
    label.className = 'scroll-reading-title';
    label.id = 'scrollReadingLabel';
    label.textContent = '翻著讀';
    head.appendChild(label);

    var sub = document.createElement('span');
    sub.className = 'scroll-reading-sub';
    sub.textContent = '一段接一段，捲到底就接著下一段';
    head.appendChild(sub);

    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'scroll-reading-close';
    close.id = 'scrollReadingClose';
    close.title = '收起經文流';
    close.setAttribute('aria-label', '收起經文流');
    close.textContent = '✕';
    close.addEventListener('click', function () { setEnabled(false, true); });
    head.appendChild(close);

    feedEl.appendChild(head);

    var list = document.createElement('div');
    list.className = 'scroll-reading-list';
    list.id = 'scrollReadingList';
    feedEl.appendChild(list);

    // 載入哨兵：捲到這裡就補下一批
    sentinelEl = document.createElement('div');
    sentinelEl.className = 'scroll-reading-sentinel';
    sentinelEl.id = 'scrollReadingSentinel';
    feedEl.appendChild(sentinelEl);

    /*
     * 插在入門區塊後面。
     *
     * 用 home-start 當錨點：它有明確的「讀完就收起」行為，經文流接在
     * 它後面，順序是「不知道讀什麼 → 挑一本」→「不想挑 → 直接讀」。
     */
    var anchor = $('homeStart');
    var parent = anchor && anchor.parentNode ? anchor.parentNode : home;

    if (anchor && anchor.nextSibling) {
      parent.insertBefore(feedEl, anchor.nextSibling);
    } else if (anchor) {
      parent.appendChild(feedEl);
    } else {
      // 找不到入門區塊就放在快捷晶片之前
      var quick = home.querySelector('.home-quick');
      if (quick && quick.parentNode) quick.parentNode.insertBefore(feedEl, quick);
      else home.appendChild(feedEl);
    }

    return feedEl;
  }

  /* ── 畫一段 ───────────────────────────────────────────── */

  function openFile(p, line) {
    if (typeof global.mdwOpenFile === 'function') {
      global.mdwOpenFile(p, line);
    }
  }

  function renderPassage(item, idx) {
    var art = document.createElement('article');
    art.className = 'scroll-reading-item';

    var text = document.createElement('p');
    text.className = 'scroll-reading-text';
    text.textContent = item.x;
    art.appendChild(text);

    var meta = document.createElement('div');
    meta.className = 'scroll-reading-meta';

    var src = document.createElement('span');
    src.className = 'scroll-reading-src';
    src.textContent = item.id + '《' + item.t + '》';
    meta.appendChild(src);

    var read = document.createElement('button');
    read.type = 'button';
    read.className = 'scroll-reading-act';
    read.textContent = '讀這部經';
    read.addEventListener('click', function () { openFile(item.p); });
    meta.appendChild(read);

    var jump = document.createElement('button');
    jump.type = 'button';
    jump.className = 'scroll-reading-act scroll-reading-act-jump';
    jump.textContent = '看這一段';
    jump.title = '跳到這部經的這一段（有上下文）';
    jump.addEventListener('click', function () { openFile(item.p, item.l); });
    meta.appendChild(jump);

    /*
     * 這一段如果是金剛經、法華經這些有逐句註疏的，多給一條路。
     *
     * 首頁讀到一段話，最自然的下一個問題是「這是什麼意思」。前面幾個
     * 批次已經把資料接好了，這裡只是把它露出一條線。
     */
    var data = global.SidecarData;
    if (data && Array.isArray(data.works)) {
      for (var i = 0; i < data.works.length; i++) {
        if (data.works[i].base === item.id && data.works[i].loci.length >= 5) {
          var note = document.createElement('button');
          note.type = 'button';
          note.className = 'scroll-reading-act scroll-reading-act-note';
          note.textContent = '有歷代註疏';
          note.addEventListener('click', function () { openFile(item.p, item.l); });
          meta.appendChild(note);
          break;
        }
      }
    }

    art.appendChild(meta);
    return art;
  }

  function appendBatch() {
    if (!feedEl) return;
    var data = global.PassagesData;
    if (!data || !data.list || !data.list.length) return;

    var list = $('scrollReadingList');
    if (!list) return;

    for (var i = 0; i < BATCH; i++) {
      var item = data.at(cursor + i);
      if (!item) break;
      var el = renderPassage(item, cursor + i);
      list.appendChild(el);
      rendered.push(el);
    }
    cursor += BATCH;

    // 回收太舊的段，避免捲很久之後 DOM 累積上萬個節點
    while (rendered.length > MAX_DOM) {
      var old = rendered.shift();
      if (old && old.parentNode) old.parentNode.removeChild(old);
    }
  }

  /* ── 無限捲動 ─────────────────────────────────────────── */

  function watchSentinel() {
    if (observer || typeof IntersectionObserver === 'undefined') return;
    if (!sentinelEl) return;

    observer = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) {
          appendBatch();
          break;
        }
      }
    }, { rootMargin: '600px' });

    observer.observe(sentinelEl);
  }

  /* ── 開關 ─────────────────────────────────────────────── */

  function setEnabled(on, fromUser) {
    enabled = !!on;
    if (fromUser) writePref(enabled);

    var feed = ensureFeed();
    if (feed) feed.hidden = !enabled;

    if (!enabled) {
      if (observer) { observer.disconnect(); observer = null; }
    } else if (!seeded) {
      seeded = true;
      appendBatch();
      appendBatch();      // 一次兩批，讓第一屏下方就有內容可捲
      watchSentinel();
    }
  }

  /* ── 起動 ─────────────────────────────────────────────── */

  function init() {
    if (!hasDom) return;
    enabled = readPref();

    var data = global.PassagesData;
    if (!data || !data.list || !data.list.length) return;

    var feed = ensureFeed();
    if (!feed) return;

    feed.hidden = !enabled;
    if (enabled && !seeded) {
      seeded = true;
      appendBatch();
      appendBatch();
      watchSentinel();
    }
  }

  if (hasDom) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  global.ScrollReading = {
    refresh: hasDom ? init : function () {},
    setEnabled: hasDom ? setEnabled : function () {},
    isEnabled: function () { return enabled !== false; },
    /** 測試用 */
    _cursor: function () { return cursor; },
    _seed: hasDom ? init : function () {}
  };

})(typeof window !== 'undefined' ? window : this);
