/**
 * @file commentary-link.js
 *
 * 歷代註疏（alpha 批次 8）。
 *
 * ── 為什麼要有這個
 *
 * 讀完一部經，最自然的下一個問題是「所以這部經到底是什麼意思」。
 * 這個站有兩千多部註疏，卻沒有任何一條路從經文通往它們——讀者得先
 * 知道「金剛經有十四部註疏」這件事，才有辦法去找。
 *
 * 這條連結是接上的：讀到金剛經卷末，直接列出十四部註解，從隋代天台
 * 智者大師到民國的江味農。
 *
 * ── 資料是怎麼來的
 *
 * 不是猜的，也不是我列的清單。CBETA 在每一部註疏開頭標了它註的是哪
 * 部經：
 *
 *   No. 1698 [cf. No. 235]
 *
 * 掃過全部 7,222 個檔案，234 個有這個標記，整理成 33 組、152 部註疏。
 * 產生器在 scripts/gen-commentaries.js，資料在 commentary-data.js。
 *
 * ── 與 app.js 的關係
 *
 * 完全獨立。訂閱 app.js 既有的檔案載入事件，只在「這部經有兩部以上
 * 註疏」時才顯示。不碰 app.js 的任何狀態。
 */

(function (global) {
  'use strict';

  var hasDom = (typeof document !== 'undefined');
  var currentBaseId = null;
  var isReady = false;

  function $(id) {
    return document.getElementById(id);
  }

  /* ── 找出目前檔案的經號 ────────────────────────────────── */

  /**
   * 從檔案路徑或檔名取出 CBETA 經號。
   *
   * 語料裡的檔名有兩種：
   *   `T0235《金剛般若波羅蜜經》.md`
   *   `001.《玄奘三藏譯撰全輯》....md`   ← 菩薩藏那批，沒有經號
   *
   * 只有第一種能對上註疏資料。
   *
   * @param {string} filePath
   * @returns {string|null} 例如 'T0235'
   */
  function extractBaseId(filePath) {
    if (!filePath) return null;
    var name = String(filePath).split('/').pop() || '';
    var m = name.match(/^(T\d{4})[《(]/);
    return m ? m[1] : null;
  }

  /* ── 渲染 ──────────────────────────────────────────────── */

  /** 取註疏組（沒有就回 null）。 */
  function lookup(baseId) {
    var data = global.CommentaryData;
    if (!data || !Array.isArray(data.families)) return null;
    for (var i = 0; i < data.families.length; i++) {
      if (data.families[i].base.id === baseId) return data.families[i];
    }
    return null;
  }

  /**
   * 畫一張註疏卡。
   *
   * 卡片的主角是「誰寫的」，不是「經號是什麼」——讀者認的是「天台智者
   * 大師」這個名字，不是 T1698。抽不到作者時才退回顯示經名。
   */
  function renderCard(entry) {
    var card = document.createElement('button');
    card.type = 'button';
    card.className = 'commentary-card';
    card.setAttribute('data-path', entry.path);

    /*
     * 排版決定：署名是主角，經名是配角。
     *
     * 但「抽不到署名」時不要把經名塞進作者欄——那會讓同一張卡上出現
     * 兩次同樣的字（作者欄一次、經名欄一次），看起來像 bug。寧可作者欄
     * 留白、只留經名，卡片自己就說明它是哪一部。
     */
    var attr = entry.attribution || '';
    var looksLikeTitle = /序$/.test(attr) || /^(刊行|御製|重刊|新刊)/.test(attr);
    var nameText = String(entry.name).replace(/^T\d+/, '');

    function addName() {
      var el = document.createElement('span');
      el.className = 'commentary-name';
      el.textContent = nameText;
      card.appendChild(el);
    }

    if (entry.by) {
      var author = document.createElement('span');
      author.className = 'commentary-author';
      author.textContent = entry.by;
      if (entry.era) {
        var era = document.createElement('span');
        era.className = 'commentary-era';
        era.textContent = '（' + entry.era + '）';
        author.appendChild(era);
      }
      card.appendChild(author);
      addName();
    } else if (attr && !looksLikeTitle) {
      // 有署名原文（「京兆慈恩寺基法師撰」）就照原樣顯示，那本身也是資訊
      card.className += ' is-anonymous';
      var raw = document.createElement('span');
      raw.className = 'commentary-author';
      raw.textContent = attr;
      card.appendChild(raw);
      addName();
    } else {
      // 連署名都沒有：直接把經名當標題，不要再重複一次
      card.className += ' is-anonymous is-title-only';
      var only = document.createElement('span');
      only.className = 'commentary-author';
      only.textContent = String(entry.name).replace(/^T\d+《?/, '').replace(/》$/, '');
      card.appendChild(only);
    }

    var idEl = document.createElement('span');
    idEl.className = 'commentary-id';
    idEl.textContent = entry.id;
    card.appendChild(idEl);

    card.title = entry.name + (entry.attribution ? '　' + entry.attribution : '');
    card.addEventListener('click', function () {
      openFile(entry.path);
    });

    return card;
  }

  /** 開啟檔案：走 app.js 既有的介面。 */
  function openFile(path) {
    if (typeof global.mdwOpenFile === 'function') {
      global.mdwOpenFile(path, 1);
      return;
    }
    // 退路：用 hash（app.js 的深層連結會接住）
    global.location.hash = '#file=' + encodeURIComponent(path);
  }

  /**
   * 依目前檔案更新整塊。
   *
   * @param {string} filePath
   */
  function update(filePath) {
    if (!hasDom) return;

    var section = $('commentaryFamily');
    var list = $('commentaryList');
    if (!section || !list) return;

    var baseId = extractBaseId(filePath);
    var family = baseId ? lookup(baseId) : null;

    /*
     * 點開一部註疏之後，讀者已經進到「註疏」裡了。
     *
     * 這時如果把整塊收起來，感覺像「怎麼不見了」——他正想回頭看同組的
     * 另一部。所以：如果目前檔案本身就是某一組的註疏，就繼續顯示那一組，
     * 並在標題上說明現在讀的是哪一部。
     *
     * 這是實測到的：點第一張卡後 500ms，清單從 14 張變成 0 張。
     */
    var parent = null;
    if (!family && baseId) {
      var all = (global.CommentaryData && global.CommentaryData.families) || [];
      for (var i = 0; i < all.length; i++) {
        for (var j = 0; j < all[i].commentaries.length; j++) {
          if (all[i].commentaries[j].id === baseId) { parent = all[i]; break; }
        }
        if (parent) break;
      }
      if (parent) family = parent;
    }

    currentBaseId = family ? family.base.id : baseId;

    if (!family || family.commentaries.length < 2) {
      section.hidden = true;
      list.textContent = '';
      return;
    }

    var count = $('commentaryCount');
    if (count) count.textContent = family.commentaries.length + ' 部';

    var intro = $('commentaryIntro');
    if (intro) {
      if (parent) {
        // 正在讀某一部註疏：標明它註的是哪部經
        intro.textContent = '這一部註解的是《' +
          String(family.base.name).replace(/^T\d+《?/, '').replace(/》$/, '') +
          '》。同組另外 ' + (family.commentaries.length - 1) + ' 部：';
      } else {
        intro.textContent = '這部經留下 ' + family.commentaries.length +
          ' 部註解，從' + (family.commentaries[0].era || '早期') + '一路到近代。' +
          '點開任一部，就是另一種讀法。';
      }
    }

    list.textContent = '';
    family.commentaries.forEach(function (c) {
      var card = renderCard(c);
      if (c.id === baseId) {
        card.classList.add('is-current');
        card.setAttribute('aria-current', 'true');
        card.disabled = true;   // 已經在讀這一部，不用再點
      }
      list.appendChild(card);
    });

    section.hidden = false;
  }

  /* ── 接上 app.js 的載入流程 ───────────────────────────── */

  /**
   * app.js 沒有「檔案載入完成」的事件，所以用兩條路：
   *
   *   1. 攔 window.mdwOpenFile（app.js 的公開介面）
   *   2. 監看 state.currentFile 的變化（MutationObserver 太重，用輕量輪詢）
   *
   * 輪詢看起來笨，但這裡是最可靠的做法：app.js 有多條路徑會換檔
   * （樹點擊、搜尋結果、深層連結、前後篇導覽），逐一攔會漏。輪詢
   * 250ms、只比對一個字串，成本可忽略。
   */
  function startWatching() {
    if (!hasDom) return;

    var lastSeen;

    function tick() {
      var st = global.state;
      var cur = st && st.currentFile;
      if (cur !== lastSeen) {
        lastSeen = cur;
        if (cur) update(cur);
        else {
          var section = $('commentaryFamily');
          if (section) section.hidden = true;
        }
      }
    }

    // 先跑一次（深層連結直接進到某部經的情況）
    tick();
    global.setInterval(tick, 250);

    // 攔 mdwOpenFile：立即反應，不等輪詢
    var origOpen = global.mdwOpenFile;
    if (typeof origOpen === 'function') {
      global.mdwOpenFile = function (filePath, line) {
        var r = origOpen.apply(this, arguments);
        // app.js 是非同步載入，稍等一下再更新
        global.setTimeout(function () { update(filePath); }, 60);
        return r;
      };
    }
  }

  function init() {
    if (isReady) return;
    isReady = true;
    startWatching();
  }

  if (hasDom) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  global.CommentaryLink = {
    update: hasDom ? update : function () {},
    extractBaseId: extractBaseId,
    lookup: function (id) { return lookup(id); },
    current: function () { return currentBaseId; }
  };

})(typeof window !== 'undefined' ? window : this);
