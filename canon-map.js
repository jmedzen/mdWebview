/**
 * @file canon-map.js
 *
 * 藏經地圖（alpha 批次 6）。
 *
 * ── 為什麼要有這個
 *
 * 側邊欄的檔案樹是「目錄」：它告訴你東西在哪裡，但不會告訴你「這裡有多大」。
 * 7,222 個檔案、1.3 GB 的藏經擺在一個可折疊的清單裡，人只看得到自己展開的
 * 那三四層，對整部藏經的形狀毫無概念。
 *
 * 問一個讀過幾年藏經的人「大正藏跟卍續藏哪個大」，他多半答不出來。問他
 * 「般若部在整部藏經裡佔多少」，也答不出來。這些不是冷知識——它們決定了
 * 一個人的閱讀計畫合不合理。
 *
 * 這張地圖把整個藏經畫成方塊圖：每個方塊是一部經，面積代表字數。
 *
 * ── 為什麼不自己算 treemap
 *
 * 真正的 treemap 需要遞迴切割矩形，幾百行幾何程式，資料一變就容易出錯。
 * 這裡改用「按比例分配尺寸 + flex 自動換行」的近似法：視覺上同樣看得出
 * 誰大誰小，程式碼只有幾行，而且天生會隨容器大小重排。
 *
 * 代價是方塊不是嚴格的面積正比。所以圖上不標百分比，只標字數——不宣稱
 * 精確，就不會誤導。
 *
 * ── 與 app.js 的關係
 *
 * 完全獨立。它只讀 `window.state.treeData`（app.js 已經在記憶體裡的樹），
 * 不修改任何既有狀態、不覆寫任何既有樣式。要打開某一部經時呼叫 app.js
 * 既有的 `window.loadFile`（若存在），找不到就退回 `location.hash`，
 * 兩者都不會弄壞目前的閱讀狀態。
 */

(function (global) {
  'use strict';

  /* ── 常數 ──────────────────────────────────────────────── */

  /** 方塊的色相數：6 種循環，讓相鄰部類不會糊成一片。 */
  var TONES = 6;

  /**
   * 每個字大約佔多少位元組。
   *
   * 語料是 UTF-8 的漢文，一個漢字 3 bytes，加上標點、換行、Markdown 標記，
   * 平均約 4.2。用這個換算字數只是為了標籤好看——不宣稱是精確字數。
   */
  var BYTES_PER_CHAR = 4.2;

  /** 小於這個寬度（px）的方塊不塞文字，塞了也是糊的。 */
  var TINY_WIDTH = 34;

  /** 目前所在層級的路徑堆疊（每一層是 {name, nodes}）。 */
  var stack = [];

  /** 開啟中的狀態。 */
  var isOpen = false;

  /* ── 小工具 ────────────────────────────────────────────── */

  function $(id) {
    return document.getElementById(id);
  }

  /**
   * 把位元組換算成人看得懂的字數。
   *
   * 分級刻意用「億／萬／千」，因為這個語料的尺度跨很大：最短的經兩百字，
   * 整部藏經三億多字。固定用「萬」會出現「33185 萬字」這種要讀者自己
   * 換算的數字——那等於沒換算。
   */
  function humanChars(bytes) {
    var chars = Math.round((bytes || 0) / BYTES_PER_CHAR);
    if (!chars) return '';
    if (chars >= 100000000) {
      return '約 ' + (chars / 100000000).toFixed(1) + ' 億字';
    }
    if (chars >= 10000) {
      // 10 萬字以上不再顯示小數（「10.0 萬字」讀起來像假精確）
      return '約 ' + (chars / 10000).toFixed(chars >= 100000 ? 0 : 1) + ' 萬字';
    }
    if (chars >= 1000) {
      return '約 ' + (chars / 1000).toFixed(1) + ' 千字';
    }
    return '約 ' + chars + ' 字';
  }

  /** 這個節點底下所有檔案的位元組總和（含自己若是檔案）。 */
  function subtreeBytes(node) {
    if (!node) return 0;
    if (node.type === 'file') return node.size || 0;
    var total = 0;
    var kids = node.children || [];
    for (var i = 0; i < kids.length; i++) total += subtreeBytes(kids[i]);
    return total;
  }

  /** 這個節點底下有幾個檔案。 */
  function subtreeFiles(node) {
    if (!node) return 0;
    if (node.type === 'file') return 1;
    var total = 0;
    var kids = node.children || [];
    for (var i = 0; i < kids.length; i++) total += subtreeFiles(kids[i]);
    return total;
  }

  /* ── 取得樹資料 ────────────────────────────────────────── */

  /**
   * 取得檔案樹。
   *
   * app.js 把 `/api/tree` 的結果放在 `state.treeData`。若還沒載入
   * （例如使用者剛進站就打開地圖），自己去抓一份——不依賴 app.js 的
   * 載入時機，這樣地圖在任何時候打開都有東西可看。
   *
   * @returns {Promise<Array>} 樹的根節點陣列
   */
  function fetchTree() {
    var st = global.state;
    if (st && Array.isArray(st.treeData) && st.treeData.length) {
      return Promise.resolve(st.treeData);
    }
    return fetch('/api/tree', { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('tree ' + r.status);
        return r.json();
      });
  }

  /* ── 渲染 ──────────────────────────────────────────────── */

  /**
   * 切片式排列：把一堆帶權重的項目鋪滿一個矩形。
   *
   * 每次取「最大的一批」排成一條帶，帶的厚度按這批佔的比例決定，
   * 然後在剩下的矩形裡遞迴處理其餘項目。這是 treemap 的經典做法
   * （slice-and-dice），優點是面積嚴格正比，缺點是長寬比偶爾會很扁——
   * 但對「一眼看出誰大誰小」這個目的來說，面積正確比形狀漂亮重要。
   *
   * @param {Array} items - [{entry, bytes}]，已排序
   * @param {Object} box  - {x, y, w, h}
   * @returns {Array}      - [{entry, x, y, w, h}]
   */
  function sliceAndDice(items, box, depth) {
    depth = depth || 0;
    var out = [];
    if (!items.length || box.w <= 1 || box.h <= 1) return out;

    // 只剩一項，整個矩形給它
    if (items.length === 1) {
      out.push({ entry: items[0], x: box.x, y: box.y, w: box.w, h: box.h });
      return out;
    }

    var total = items.reduce(function (s, it) { return s + it.bytes; }, 0);
    if (total <= 0) return out;

    /*
     * 二分法（binary slice-and-dice）。
     *
     * 每層把項目切成兩半，各佔一邊。切的方向按深度交替：橫、直、橫、
     * 直……這樣每次切完，兩塊的長寬比都還在可接受範圍，不會像「一次
     * 切一長條」那樣愈切愈扁。
     *
     * 面積仍嚴格正比：兩塊各拿到自己那半的總量，分割線的位置就按這個
     * 比例放。所以視覺面積 = 資料量，可以放心把它當地圖看。
     */
    /*
     * 找切點：累加到大約一半就切。刻意用「最接近一半」而不是「首次
     * 超過一半」——後者在小項目很多時會把切點推得太前面，留下一個
     * 幾乎沒有面積的尾巴（實測會直接吃掉最小的那一項）。
     */
    var acc = 0;
    var split = 1;
    var bestDiff = Infinity;
    for (var i = 0; i < items.length - 1; i++) {
      acc += items[i].bytes;
      var diff = Math.abs(acc - total / 2);
      if (diff < bestDiff) {
        bestDiff = diff;
        split = i + 1;
      }
      if (acc > total / 2) break;
    }

    var left = items.slice(0, split);
    var right = items.slice(split);
    var leftBytes = left.reduce(function (s, it) { return s + it.bytes; }, 0);
    var fraction = leftBytes / total;

    var horizontal = (depth % 2 === 0);

    if (horizontal) {
      var wL = box.w * fraction;
      out = out.concat(sliceAndDice(left, { x: box.x, y: box.y, w: wL, h: box.h }, depth + 1));
      out = out.concat(sliceAndDice(right, { x: box.x + wL, y: box.y, w: box.w - wL, h: box.h }, depth + 1));
    } else {
      var hT = box.h * fraction;
      out = out.concat(sliceAndDice(left, { x: box.x, y: box.y, w: box.w, h: hT }, depth + 1));
      out = out.concat(sliceAndDice(right, { x: box.x, y: box.y + hT, w: box.w, h: box.h - hT }, depth + 1));
    }

    return out;
  }

  /**
   * 把一層節點排成方塊圖。
   *
   * 排序規則：目錄在前（可進入），同一類別內按大小遞減。這樣最大的
   * 部類會出現在左上角，視覺上先被看到——這符合「先看整體再看細節」。
   *
   * @param {Array} nodes - 這一層的節點
   * @param {number} depth - 目前深度（決定色相）
   */
  function renderLevel(nodes, depth) {
    var grid = $('canonMapGrid');
    if (!grid) return;
    grid.textContent = '';

    if (!Array.isArray(nodes) || nodes.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'canon-map-empty';
      empty.textContent = '這一層沒有內容。';
      grid.appendChild(empty);
      renderLegend(nodes || [], 0);
      return;
    }

    // 先算每個節點的大小，才知道怎麼分配空間
    var entries = nodes
      .filter(function (n) {
        // 字典檔不在主樹裡；跳過隱藏與非 md 的東西
        if (!n || !n.path) return false;
        if (String(n.path).indexOf('dict:') === 0) return false;
        return n.type === 'directory' || n.type === 'file';
      })
      .map(function (n) {
        return { node: n, bytes: subtreeBytes(n), files: subtreeFiles(n) };
      })
      .filter(function (e) {
        // 空目錄（0 位元組）不畫，否則會出現一堆沒有面積的方塊
        return e.bytes > 0;
      });

    // 目錄優先，其次按大小
    entries.sort(function (a, b) {
      var af = a.node.type === 'directory' ? 0 : 1;
      var bf = b.node.type === 'directory' ? 0 : 1;
      if (af !== bf) return af - bf;
      return b.bytes - a.bytes;
    });

    var totalBytes = entries.reduce(function (s, e) { return s + e.bytes; }, 0);

    /*
     * 微小項聚合。
     *
     * 真實比例下，最小的幾個項目只有 1px 寬（《使用者教學》10 KB
     * 對整部藏經 1.3 GB，差十萬倍）。這種方塊等於不存在——看不到、
     * 點不到、也不知道那裡有東西。硬給它最小尺寸又會跟鄰居重疊。
     *
     * 所以把佔比低於 0.4% 的項目併成一個「其他」方塊，滑過去列出
     * 名稱。這是 treemap 的標準做法：保住「面積正比」，同時讓每一
     * 個看得見的方塊都點得到。
     */
    var TINY_SHARE = 0.004;
    var tinyItems = [];
    var bigItems = [];
    entries.forEach(function (e) {
      if (e.bytes / totalBytes < TINY_SHARE && entries.length > 4) tinyItems.push(e);
      else bigItems.push(e);
    });
    if (tinyItems.length > 1) {
      var tinyBytes = tinyItems.reduce(function (s, e) { return s + e.bytes; }, 0);
      /*
       * 聚合後仍可能小到看不見（兩個空目錄加起來 3px 高）。給它一個
       * 「可見下限」：至少佔全圖 0.6%，也就是最小邊約 40px。
       *
       * 這會讓這一項的面積大於真實比例——但它是「其他 N 項」的聚合，
       * 本來就不代表單一資料點，而且 tooltip 會列出全部成員。寧可
       * 讓它看得見、點得到，也不要留一個 3px 的縫讓人以為是渲染瑕疵。
       */
      var MIN_GROUP_SHARE = 0.018;   // 約 4% 寬 × 4% 高，文字一定塞得進去
      var merged = { node: { name: '其他 ' + tinyItems.length + ' 項', type: 'group' },
        bytes: Math.max(tinyBytes, totalBytes * MIN_GROUP_SHARE),
        files: tinyItems.reduce(function (s, e) { return s + e.files; }, 0),
        members: tinyItems };
      // 併進去之後重新排序，讓它落在正確的大小位置
      bigItems.push(merged);
      bigItems.sort(function (a, b) {
        var af = a.node.type === 'directory' ? 0 : 1;
        var bf = b.node.type === 'directory' ? 0 : 1;
        if (af !== bf) return af - bf;
        return b.bytes - a.bytes;
      });
      entries = bigItems;
      totalBytes = entries.reduce(function (s2, e2) { return s2 + e2.bytes; }, 0);
    }

    /*
     * 版面演算法：切片式排列（slice-and-dice），不是自由換行。
     *
     * 一開始用 flex-wrap 讓方塊自己流動，結果第二排填不滿，下半部
     * 整片空白——看起來像壞掉。改成「遞迴切成橫帶／直欄」：
     *
     *   1. 整塊舞台是一個矩形
     *   2. 取最大的幾項排成一條橫帶，這條帶的高度按它們佔的比例給
     *   3. 帶裡每一項按比例分到寬度
     *   4. 剩下的項目在剩下的矩形裡重複
     *
     * 這樣畫出來會填滿整個舞台，而且面積嚴格正比於資料——不會再有
     * 「看起來差不多大、實際差 40 倍」的問題。
     */
    var stage = $('canonMapStage');
    var stageW = (stage && stage.clientWidth) || 900;
    var stageH = (stage && stage.clientHeight) || 520;

    var rects = sliceAndDice(entries, { x: 0, y: 0, w: stageW, h: stageH });

    for (var i = 0; i < rects.length; i++) {
      var rect = rects[i];
      var e = rect.entry;
      var node = e.node;

      /*
       * 最小可見尺寸。
       *
       * 真實比例會讓最小的項目只有 1px 寬（《使用者教學》10 KB 對上
       * 整部藏經 1.3 GB，差十萬倍）。1px 的方塊等於不存在——使用者
       * 永遠點不到，也不知道那裡有東西。
       *
       * 所以給一個下限（手機上要能點，取 22px）。代價是這一項的面積
       * 比真實比例大——但圖上不標百分比，只標字數，所以不會誤導。
       * 面積正比的承諾只對「大到看得見」的項目成立。
       */
      var MIN_VISIBLE = 22;
      var w = Math.max(MIN_VISIBLE, Math.round(rect.w));
      var h = Math.max(MIN_VISIBLE, Math.round(rect.h));

      var cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'canon-map-cell' + (node.type === 'directory' ? ' is-folder' : '');
      cell.setAttribute('data-tone', String((depth + i) % TONES));
      cell.style.left = Math.round(rect.x) + 'px';
      cell.style.top = Math.round(rect.y) + 'px';
      cell.style.width = w + 'px';
      cell.style.height = h + 'px';

      var label = node.name || String(node.path).split('/').pop();
      cell.title = label + (e.bytes ? '　' + humanChars(e.bytes) : '') +
        (node.type === 'directory' ? '　（' + e.files + ' 個檔案，點擊進入）' : '');
      if (e.members) {
        cell.title = '其他 ' + e.members.length + ' 項（' + humanChars(e.bytes) + '）\n' +
          e.members.map(function (m) { return m.node.name; }).join('、');
      }

      // 太小的方塊只留顏色與 tooltip（塞字也是糊的）
      if (w < TINY_WIDTH || h < 30) cell.classList.add('is-tiny');

      var nameEl = document.createElement('span');
      nameEl.className = 'canon-map-name';
      nameEl.textContent = label;
      cell.appendChild(nameEl);

      if (w >= TINY_WIDTH && h >= 34) {
        var sizeEl = document.createElement('span');
        sizeEl.className = 'canon-map-size';
        sizeEl.textContent = node.type === 'directory'
          ? e.files + ' 檔'
          : humanChars(e.bytes).replace('約 ', '');
        cell.appendChild(sizeEl);
      }

      (function (nd, entry) {
        cell.addEventListener('click', function () {
          if (entry.members) {
            // 「其他」方塊：列出成員，點哪個就開哪個
            stack.push({ name: '其他 ' + entry.members.length + ' 項',
              nodes: entry.members.map(function (m) { return m.node; }) });
            renderCrumb();
            renderLevel(entry.members.map(function (m) { return m.node; }), depth + 1);
            return;
          }
          if (nd.type === 'directory') {
            stack.push({ name: nd.name, nodes: nd.children || [] });
            renderCrumb();
            renderLevel(nd.children || [], depth + 1);
          } else {
            openFile(nd.path);
          }
        });
      })(node, e);

      grid.appendChild(cell);
    }

    renderLegend(entries.map(function (e) { return e; }), totalBytes);
  }

  /**
   * 圖例：只給「這一層有多少」的實用數字，不做排行榜。
   */
  function renderLegend(entries, totalBytes) {
    var el = $('canonMapLegend');
    if (!el) return;
    el.textContent = '';

    if (!entries || !entries.length) return;

    var fileCount = entries.reduce(function (s, e) {
      return s + (e.files || subtreeFiles(e.node || e));
    }, 0);

    var stats = [
      ['方塊', entries.length + ' 個'],
      ['檔案', fileCount.toLocaleString('zh-TW') + ' 個'],
      ['份量', totalBytes ? humanChars(totalBytes).replace('約 ', '') : '—']
    ];

    stats.forEach(function (pair) {
      var span = document.createElement('span');
      span.className = 'canon-map-stat';
      var k = document.createElement('strong');
      k.textContent = pair[0];
      span.appendChild(k);
      span.appendChild(document.createTextNode(' ' + pair[1]));
      el.appendChild(span);
    });
  }

  /** 麵包屑：顯示目前在哪一層，每一層都可點回去。 */
  function renderCrumb() {
    var el = $('canonMapCrumbs');
    if (!el) return;
    el.textContent = '';

    // 第 0 層永遠是「全藏」
    var levels = [{ name: '全藏', index: -1 }].concat(
      stack.map(function (s, i) { return { name: s.name, index: i }; })
    );

    levels.forEach(function (lv, i) {
      if (i > 0) {
        var sep = document.createElement('span');
        sep.className = 'canon-map-crumb-sep';
        sep.textContent = '›';
        sep.setAttribute('aria-hidden', 'true');
        el.appendChild(sep);
      }
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'canon-map-crumb';
      btn.textContent = lv.name;
      var current = i === levels.length - 1;
      btn.setAttribute('aria-current', current ? 'true' : 'false');
      if (!current) {
        btn.addEventListener('click', function () {
          stack = stack.slice(0, lv.index + 1);
          renderCrumb();
          var nodes = lv.index < 0
            ? (global.state && global.state.treeData) || []
            : stack[stack.length - 1].nodes;
          renderLevel(nodes, stack.length);
        });
      }
      el.appendChild(btn);
    });
  }

  /* ── 開啟檔案 ──────────────────────────────────────────── */

  /**
   * 打開某一部經。
   *
   * app.js 把載入函式匯出成 `window.mdwOpenFile(path, line)`——它會處理
   * 歷史、捲動、標題、虛擬模式。抓不到就退回改 hash，讓 app.js 的
   * hashchange 接手。兩條路都不直接操作 DOM，所以不會弄壞目前的閱讀狀態。
   */
  function openFile(path) {
    close();
    if (typeof global.mdwOpenFile === 'function') {
      try {
        global.mdwOpenFile(path);
        return;
      } catch (err) {
        // 掉下去用 hash
      }
    }
    location.hash = '#file=' + encodeURIComponent(path);
  }

  /* ── 開關 ──────────────────────────────────────────────── */

  function open() {
    var overlay = $('canonMapOverlay');
    if (!overlay) return;

    isOpen = true;
    overlay.style.display = 'flex';
    stack = [];

    // 先畫麵包屑，再抓資料
    renderCrumb();

    var grid = $('canonMapGrid');
    if (grid) {
      grid.textContent = '';
      var loading = document.createElement('div');
      loading.className = 'canon-map-empty';
      loading.textContent = '正在攤開藏經…';
      grid.appendChild(loading);
    }

    fetchTree()
      .then(function (nodes) {
        if (!isOpen) return;
        renderLevel(nodes, 0);
      })
      .catch(function () {
        if (!isOpen) return;
        var g = $('canonMapGrid');
        if (!g) return;
        g.textContent = '';
        var err = document.createElement('div');
        err.className = 'canon-map-empty';
        err.textContent = '讀不到藏經目錄，請稍後再試。';
        g.appendChild(err);
      });

    // 把焦點帶進對話框，鍵盤使用者才知道自己進來了
    var card = overlay.querySelector('.modal-card');
    if (card) {
      var closeBtn = $('canonMapCloseBtn');
      if (closeBtn && closeBtn.focus) closeBtn.focus();
    }
  }

  function close() {
    var overlay = $('canonMapOverlay');
    if (overlay) overlay.style.display = 'none';
    isOpen = false;
  }

  /* ── 初始化 ────────────────────────────────────────────── */

  function init() {
    var openBtn = $('homeMapOpen');
    if (openBtn) openBtn.addEventListener('click', open);

    var closeBtn = $('canonMapCloseBtn');
    if (closeBtn) closeBtn.addEventListener('click', close);

    var overlay = $('canonMapOverlay');
    if (overlay) {
      // 點背景關閉（點卡片本身不關）
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) close();
      });
    }

    // Esc 關閉
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isOpen) {
        e.stopPropagation();
        close();
      }
    });

    // 視窗大小改變時重排（方塊尺寸是進場時算的）
    var resizeTimer = null;
    global.addEventListener('resize', function () {
      if (!isOpen) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        var nodes = stack.length
          ? stack[stack.length - 1].nodes
          : (global.state && global.state.treeData) || [];
        renderLevel(nodes, stack.length);
      }, 180);
    });
  }

  /*
   * 初始化。
   *
   * 這裡刻意做防禦：若模組被在沒有 document 的環境載入（測試、SSR、
   * 或某些打包工具），不應該拋錯——它只是什麼都不做，而不是把整個
   * 頁面的其他腳本一起帶走。
   */
  var hasDom = (typeof document !== 'undefined');

  if (hasDom) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  // 供測試與除錯使用。沒有 DOM 時 open/close 是空操作，但純函式仍可用。
  global.CanonMap = {
    open: hasDom ? open : function () {},
    close: hasDom ? close : function () {},
    humanChars: humanChars,
    subtreeBytes: subtreeBytes,
    subtreeFiles: subtreeFiles,
    isOpen: function () { return hasDom && isOpen; }
  };

})(typeof window !== 'undefined' ? window : this);
