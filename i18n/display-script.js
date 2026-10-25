/**
 * 繁／簡顯示切換引擎（Display Script）
 *
 * 站台的經文與介面原文一律是繁體。切換為簡體時，不另外產生一份簡體內容，
 * 而是在瀏覽器端即時轉換畫面上的文字節點：
 *
 *   - 內文區（經文、辭典、搜尋結果、目錄、檔案樹…）用 OpenCC「tw → cn」
 *     逐字轉換，不做詞彙替換，避免經文用詞被改寫；再套用 content-terms.js
 *     的佛學名相修正（例如 干慧地 → 乾慧地）。
 *   - 介面區（按鈕、設定、提示）用 OpenCC「twp → cn」，連同台灣慣用詞一併
 *     轉為大陸用語（檔案 → 文件、搜尋 → 搜索），再套用 UI 用語修正表。
 *
 * 每個被轉換的文字節點與屬性都以 WeakMap 保存原文，因此：
 *   - 切回繁體時可逐字還原，而不是用簡轉繁「反推」（後／后、髮／发 無法反推）。
 *   - 劃詞搜尋、辭典查詢取得的是原始繁體字，搜尋結果與繁體版一致。
 *
 * 動態產生的 DOM（虛擬捲動區塊、搜尋結果、Toast…）由 MutationObserver
 * 自動轉換，app.js 各處的渲染程式不需要個別處理。
 *
 * 不轉換：script、style、textarea、code、pre、kbd、samp、svg、.katex、
 * .mermaid、[data-no-t2s]、可編輯區塊。屬性只轉換 title、placeholder、
 * aria-label 三種顯示用屬性，href、src、id、data-* 一律不動。
 *
 * 本檔不依賴 DOM 以外的瀏覽器 API，節點操作只用 nodeType、childNodes、
 * parentNode、data、getAttribute／setAttribute，方便在 node:test 中以
 * 簡易 DOM 驗證。
 */
(function (global) {
  'use strict';

  const HAN_RE = /[㐀-鿿豈-﫿]|[\ud840-\ud87f][\udc00-\udfff]/;

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA',
    'CODE', 'PRE', 'KBD', 'SAMP', 'SVG'
  ]);
  // 內容不轉換、但 placeholder 等顯示屬性仍要轉換的元素
  const ATTR_ONLY_TAGS = new Set(['TEXTAREA']);
  const SKIP_CLASSES = ['katex', 'mermaid', 'ignore-opencc'];

  // 內文區：經文本身、以及顯示經文片段或經名的清單。這些區域只做逐字轉換。
  const CONTENT_IDS = new Set([
    'markdownBody', 'headerActiveFile', 'fileTree',
    'searchResults', 'tocList', 'dictResults', 'dictFileList',
    'recentFilesList', 'bookmarksList'
  ]);
  // .file-path：內文標頭的經名路徑（同列的「連結」「書籤」按鈕屬介面用語）
  const CONTENT_CLASSES = ['markdown-body', 'suggest-list', 'file-path'];

  const ATTRS = ['title', 'placeholder', 'aria-label'];

  const textRecords = new WeakMap();   // Text → { orig, conv }
  const attrRecords = new WeakMap();   // Element → { [attr]: { orig, conv } }

  let contentConv = null;
  let uiConv = null;
  let observer = null;
  let active = false;
  let loadPromise = null;

  function hasClass(el, name) {
    return !!(el.classList && el.classList.contains(name));
  }

  function tagOf(el) {
    return String(el.tagName || el.nodeName || '').toUpperCase();
  }

  function isSkipElement(el) {
    if (SKIP_TAGS.has(tagOf(el))) return true;
    for (const c of SKIP_CLASSES) if (hasClass(el, c)) return true;
    if (el.hasAttribute && el.hasAttribute('data-no-t2s')) return true;
    const ce = el.getAttribute ? el.getAttribute('contenteditable') : null;
    if (ce === '' || ce === 'true' || ce === 'plaintext-only') return true;
    return false;
  }

  function isContentElement(el) {
    if (el.id && CONTENT_IDS.has(el.id)) return true;
    if (tagOf(el) === 'TITLE') return true;
    for (const c of CONTENT_CLASSES) if (hasClass(el, c)) return true;
    return false;
  }

  /** 由某元素往上判斷：是否位於不轉換區、是否位於內文區。 */
  function contextOf(el) {
    let skip = false;
    let content = false;
    for (let n = el; n && n.nodeType === 1; n = n.parentNode) {
      if (!skip && isSkipElement(n)) skip = true;
      if (!content && isContentElement(n)) content = true;
      if (skip && content) break;
    }
    return { skip, content };
  }

  /**
   * OpenCC 的輸出字中，少數再轉一次還會變（麼→么→幺、薴→苧→苎）。
   * 程式若把已轉換的文字複製成新節點（例如清除搜尋高亮時），再轉一次就會
   * 變成錯字，所以這些字一律原樣保留。清單由 tests/test-display-script.test.js
   * 以全字掃描驗證，OpenCC 升級時若有新增會自動提醒。
   */
  const NON_IDEMPOTENT_OUTPUTS = /([么苧])/;

  function convertString(str, isContent) {
    const fn = isContent ? contentConv : uiConv;
    if (!fn || !str || !HAN_RE.test(str)) return str;
    if (!NON_IDEMPOTENT_OUTPUTS.test(str)) return fn(str);
    return str.split(NON_IDEMPOTENT_OUTPUTS)
      .map((part, i) => (i % 2 === 1 ? part : fn(part)))
      .join('');
  }

  function convertText(node, isContent) {
    const cur = node.data;
    const rec = textRecords.get(node);
    if (rec && rec.conv === cur) return;
    const conv = convertString(cur, isContent);
    if (conv === cur) {
      if (rec) textRecords.delete(node);
      return;
    }
    textRecords.set(node, { orig: cur, conv });
    node.data = conv;
  }

  function convertAttr(el, name, isContent) {
    if (!el.getAttribute) return;
    const cur = el.getAttribute(name);
    if (cur == null) return;
    let recs = attrRecords.get(el);
    const rec = recs && recs[name];
    if (rec && rec.conv === cur) return;
    const conv = convertString(cur, isContent);
    if (conv === cur) {
      if (rec) delete recs[name];
      return;
    }
    if (!recs) { recs = {}; attrRecords.set(el, recs); }
    recs[name] = { orig: cur, conv };
    el.setAttribute(name, conv);
  }

  function convertTree(root, ctx) {
    if (!root) return;
    if (root.nodeType === 3) {
      const c = ctx || (root.parentNode ? contextOf(root.parentNode) : { skip: false, content: false });
      if (!c.skip) convertText(root, c.content);
      return;
    }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    const start = ctx || (root.nodeType === 1 ? contextOf(root) : { skip: false, content: false });
    if (start.skip) return;
    const stack = [[root, start.content]];
    while (stack.length) {
      const [node, content] = stack.pop();
      if (node.nodeType === 1) {
        for (const a of ATTRS) convertAttr(node, a, content);
      }
      const kids = node.childNodes;
      if (!kids) continue;
      for (let i = kids.length - 1; i >= 0; i--) {
        const k = kids[i];
        if (k.nodeType === 3) {
          convertText(k, content);
        } else if (k.nodeType === 1) {
          if (!isSkipElement(k)) stack.push([k, content || isContentElement(k)]);
          else if (ATTR_ONLY_TAGS.has(tagOf(k))) for (const a of ATTRS) convertAttr(k, a, content);
        }
      }
    }
  }

  function restoreTree(root) {
    if (!root) return;
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (node.nodeType === 3) {
        const rec = textRecords.get(node);
        if (rec) {
          if (node.data === rec.conv) node.data = rec.orig;
          textRecords.delete(node);
        }
        continue;
      }
      if (node.nodeType === 1) {
        const recs = attrRecords.get(node);
        if (recs) {
          for (const name of Object.keys(recs)) {
            if (node.getAttribute(name) === recs[name].conv) node.setAttribute(name, recs[name].orig);
          }
          attrRecords.delete(node);
        }
      }
      const kids = node.childNodes;
      if (kids) for (let i = 0; i < kids.length; i++) stack.push(kids[i]);
    }
  }

  function handleMutations(mutations) {
    for (const m of mutations) {
      if (m.type === 'childList') {
        if (!m.addedNodes || m.addedNodes.length === 0) continue;
        const ctx = m.target.nodeType === 1 ? contextOf(m.target) : { skip: false, content: false };
        if (ctx.skip) continue;
        for (const n of m.addedNodes) {
          if (n.nodeType === 3) convertText(n, ctx.content);
          else if (n.nodeType === 1) {
            if (!isSkipElement(n)) convertTree(n, { skip: false, content: ctx.content || isContentElement(n) });
            else if (ATTR_ONLY_TAGS.has(tagOf(n))) for (const a of ATTRS) convertAttr(n, a, ctx.content);
          }
        }
      } else if (m.type === 'characterData') {
        const p = m.target.parentNode;
        if (!p) continue;
        const ctx = contextOf(p);
        if (!ctx.skip) convertText(m.target, ctx.content);
      } else if (m.type === 'attributes') {
        const el = m.target;
        const base = ATTR_ONLY_TAGS.has(tagOf(el)) ? el.parentNode : el;
        const ctx = base && base.nodeType === 1 ? contextOf(base) : { skip: false, content: false };
        if (!ctx.skip) convertAttr(el, m.attributeName, ctx.content);
      }
    }
  }

  /**
   * 以 OpenCC 建立兩組轉換器。terms 為 { content: [[簡, 正]], ui: [[簡, 正]] }，
   * 在 OpenCC 轉換「之後」套用，所以鍵是轉換後的簡體字串。
   */
  function createConverters(OpenCC, terms) {
    const t = terms || {};
    const content = Array.isArray(t.content) ? t.content : [];
    const ui = Array.isArray(t.ui) ? t.ui : [];
    return {
      content: OpenCC.ConverterFactory(OpenCC.Locale.from.tw, OpenCC.Locale.to.cn, content.length ? [content] : []),
      ui: OpenCC.ConverterFactory(OpenCC.Locale.from.twp, OpenCC.Locale.to.cn, ui.length ? [ui] : [])
    };
  }

  function setConverters(conv) {
    contentConv = conv ? conv.content : null;
    uiConv = conv ? conv.ui : null;
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      let el = document.getElementById('mdwOpenccScript');
      if (!el) {
        el = document.createElement('script');
        el.id = 'mdwOpenccScript';
        el.src = src;
        el.async = true;
        document.head.appendChild(el);
      }
      if (global.OpenCC) { resolve(); return; }
      el.addEventListener('load', () => resolve(), { once: true });
      el.addEventListener('error', () => reject(new Error('無法載入 ' + src)), { once: true });
    });
  }

  /** 載入 OpenCC（僅在需要簡體時才下載）並建立轉換器。 */
  function load(src) {
    if (contentConv && uiConv) return Promise.resolve();
    if (!loadPromise) {
      loadPromise = (global.OpenCC ? Promise.resolve() : loadScript(src))
        .then(() => {
          if (!global.OpenCC) throw new Error('OpenCC 未定義');
          setConverters(createConverters(global.OpenCC, global.MDW_CONVERT_TERMS));
        })
        .catch(err => { loadPromise = null; throw err; });
    }
    return loadPromise;
  }

  function enable(root) {
    if (!contentConv || !uiConv) throw new Error('轉換器尚未載入');
    const target = root || document.documentElement;
    convertTree(target);
    if (!observer && typeof MutationObserver !== 'undefined') {
      observer = new MutationObserver(muts => {
        handleMutations(muts);
        // 丟棄自己改寫文字所產生的紀錄，避免下一輪重複處理
        observer.takeRecords();
      });
    }
    if (observer) {
      observer.observe(target, {
        childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ATTRS
      });
    }
    active = true;
  }

  function disable(root) {
    if (observer) {
      handleMutations(observer.takeRecords());
      observer.disconnect();
    }
    restoreTree(root || document.documentElement);
    active = false;
  }

  /** 取得文字節點的原文（未轉換或已被改寫時回傳目前內容）。 */
  function originalText(node) {
    if (!node || node.nodeType !== 3) return '';
    const rec = textRecords.get(node);
    return rec && rec.conv === node.data ? rec.orig : node.data;
  }

  function originalSlice(node, start, end) {
    const rec = textRecords.get(node);
    if (rec && rec.conv === node.data && rec.orig.length === rec.conv.length) {
      return rec.orig.slice(start, end);
    }
    return node.data.slice(start, end);
  }

  /**
   * 取得元素內文字的原文。exclude(el) 回傳 true 的子樹會被略過
   * （例如標題裡的 .line-anchor 行號）。
   */
  function originalTextContent(el, exclude) {
    if (!el) return '';
    let out = '';
    const walk = (n) => {
      if (n.nodeType === 3) { out += originalText(n); return; }
      if (n.nodeType !== 1 && n.nodeType !== 11) return;
      if (n.nodeType === 1 && exclude && exclude(n)) return;
      const kids = n.childNodes;
      for (let i = 0; i < kids.length; i++) walk(kids[i]);
    };
    walk(el);
    return out;
  }

  /**
   * 把 Range 範圍內的文字還原成原文。
   *
   * 先取 range 內每個文字節點的「轉換後片段」與「原文片段」，再以
   * range.toString()（含瀏覽器插入的換行）逐字對齊；對不上的字元
   * （區塊間的換行、空白）原樣保留。只要有任一節點的轉換改變了長度，
   * 就無法逐字對齊，回傳 null 由呼叫端退回其他做法。
   */
  function originalTextOfRange(range) {
    if (!range) return null;
    const shown = range.toString();
    if (!active) return shown;
    const rootNode = range.commonAncestorContainer;
    const nodes = [];
    if (rootNode.nodeType === 3) {
      nodes.push(rootNode);
    } else {
      const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT, null);
      let n;
      while ((n = walker.nextNode())) {
        if (range.intersectsNode(n)) nodes.push(n);
      }
    }
    let conv = '';
    let orig = '';
    for (const n of nodes) {
      const s = n === range.startContainer ? range.startOffset : 0;
      const e = n === range.endContainer ? range.endOffset : n.data.length;
      const rec = textRecords.get(n);
      if (rec && rec.conv === n.data && rec.orig.length !== rec.conv.length) return null;
      conv += n.data.slice(s, e);
      orig += originalSlice(n, s, e);
    }
    let out = '';
    let j = 0;
    for (let i = 0; i < shown.length; i++) {
      if (j < conv.length && shown[i] === conv[j]) {
        out += orig[j];
        j++;
      } else {
        out += shown[i];
      }
    }
    return j === conv.length ? out : null;
  }

  const api = {
    HAN_RE,
    load,
    enable,
    disable,
    isActive: () => active,
    isLoaded: () => !!(contentConv && uiConv),
    toContent: (str) => convertString(str, true),
    toUi: (str) => convertString(str, false),
    NON_IDEMPOTENT_OUTPUTS,
    originalText,
    originalTextContent,
    originalTextOfRange,
    // 以下供測試使用
    _createConverters: createConverters,
    _setConverters: setConverters,
    _convertTree: convertTree,
    _restoreTree: restoreTree,
    _handleMutations: handleMutations,
    _setActive: (v) => { active = !!v; }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.mdDisplayScript = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
