const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT_DIR = path.resolve(__dirname, '..');
const appSource = fs.readFileSync(path.join(ROOT_DIR, 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
const swSource = fs.readFileSync(path.join(ROOT_DIR, 'sw.js'), 'utf8');
const bootSource = fs.readFileSync(path.join(ROOT_DIR, 'i18n', 'boot.js'), 'utf8');

const OpenCC = require('../vendor/opencc/t2cn.js');
const terms = require('../i18n/content-terms.js');
const ds = require('../i18n/display-script.js');

const converters = ds._createConverters(OpenCC, terms);
ds._setConverters(converters);

/**
 * 從 app.js 取出函式主體（以大括號配對到結尾），跳過字串與樣板內的括號。
 * 與 test-variant-locale.test.js 相同，必須從函式宣告處開始找。
 */
function extractFunctionBody(source, signature) {
  const start = source.indexOf(signature);
  if (start === -1) return null;
  const braceStart = source.indexOf('{', start + signature.length);
  if (braceStart === -1) return null;
  let depth = 0;
  let quote = null;
  for (let i = braceStart; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(braceStart, i + 1);
    }
  }
  return null;
}

// ── 簡易 DOM：只實作 display-script.js 用到的介面 ──────────────
class FakeText {
  constructor(data) { this.nodeType = 3; this.data = data; this.parentNode = null; }
}
class FakeElement {
  constructor(tag, attrs = {}, children = []) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.childNodes = [];
    this.parentNode = null;
    const cls = String(this.attrs.class || '').split(/\s+/).filter(Boolean);
    this.classList = { contains: (c) => cls.includes(c) };
    for (const c of children) this.appendChild(typeof c === 'string' ? new FakeText(c) : c);
  }
  get id() { return this.attrs.id || ''; }
  getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  hasAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n); }
  appendChild(c) { c.parentNode = this; this.childNodes.push(c); return c; }
}
const h = (tag, attrs, ...children) => new FakeElement(tag, attrs || {}, children);

function allText(node) {
  if (node.nodeType === 3) return node.data;
  return node.childNodes.map(allText).join('');
}

function snapshot(node) {
  if (node.nodeType === 3) return node.data;
  return { tag: node.tagName, attrs: { ...node.attrs }, kids: node.childNodes.map(snapshot) };
}

describe('繁簡顯示 1：OpenCC 轉換與佛學名相', () => {
  test('內文轉換（tw → cn 逐字）：常見經文名相', () => {
    const c = converters.content;
    assert.equal(c('祇樹給孤獨園'), '祇树给孤独园');
    assert.equal(c('乾闥婆'), '乾闼婆');
    assert.equal(c('著衣持鉢'), '着衣持钵');
    assert.equal(c('如是我聞。一時佛在舍衛國'), '如是我闻。一时佛在舍卫国');
    assert.equal(c('阿耨多羅三藐三菩提'), '阿耨多罗三藐三菩提');
  });

  test('content-terms.js 修正 OpenCC 誤轉的名相（乾慧地、乾陀羅）', () => {
    const raw = OpenCC.Converter({ from: 'tw', to: 'cn' });
    assert.equal(raw('乾慧地'), '干慧地', '前提：OpenCC 原本會誤轉，修正表才有意義');
    assert.equal(converters.content('乾慧地'), '乾慧地');
    assert.equal(converters.content('乾陀羅'), '乾陀罗');
    // 修正表不可誤傷「乾淨」這類本來就該轉成「干」的詞
    assert.equal(converters.content('乾淨'), '干净');
  });

  test('內文不做台灣慣用詞替換；介面則轉為大陸用語', () => {
    assert.equal(converters.content('軟體'), '软体');
    assert.equal(converters.ui('軟體'), '软件');
    assert.equal(converters.ui('搜尋檔案'), '搜索文件');
    assert.equal(converters.ui('偏好設定'), '偏好设置');
    assert.equal(converters.ui('複製連結'), '复制链接', 'UI 修正表：拷贝链接 → 复制链接');
  });

  test('轉換結果再轉一次不變（避免複製出來的文字被二次轉換成錯字）', () => {
    const offenders = new Set();
    for (const fn of [converters.content, converters.ui]) {
      for (let cp = 0x3400; cp < 0xa000; cp++) {
        const out = fn(String.fromCodePoint(cp));
        for (const ch of out) if (fn(ch) !== ch) offenders.add(ch);
      }
    }
    for (const ch of offenders) {
      assert.ok(ds.NON_IDEMPOTENT_OUTPUTS.test(ch), `「${ch}」再轉一次會改變，須加入 NON_IDEMPOTENT_OUTPUTS`);
    }
    assert.equal(ds.toContent('三麼耶'), '三么耶');
    assert.equal(ds.toContent(ds.toContent('三麼耶')), '三么耶');
    assert.equal(ds.toContent('什麼'), '什么');
  });

  test('修正表格式：每筆都是 [簡體輸出, 期望輸出] 字串對', () => {
    for (const group of ['content', 'ui']) {
      assert.ok(Array.isArray(terms[group]), `${group} 應為陣列`);
      for (const pair of terms[group]) {
        assert.equal(pair.length, 2);
        assert.equal(typeof pair[0], 'string');
        assert.equal(typeof pair[1], 'string');
        assert.notEqual(pair[0], pair[1]);
      }
    }
  });
});

describe('繁簡顯示 2：DOM 轉換範圍', () => {
  function buildPage() {
    return h('html', {},
      h('title', {}, '般若波羅蜜多心經 — 閱讀器'),
      h('header', {},
        h('button', { id: 'searchBtn', title: '頁內搜尋', 'aria-label': '搜尋檔案' }, '搜尋'),
        h('button', { id: 'displayScriptToggleBtn', 'data-no-t2s': '', title: '目前為繁體' }, '繁')
      ),
      h('article', { id: 'markdownBody', class: 'markdown-body' },
        h('h2', { id: '觀自在菩薩' }, '觀自在菩薩'),
        h('p', {},
          '行深般若波羅蜜多時，照見五蘊皆空。',
          h('a', { href: '/?file=般若/心經.md', 'data-target': '心經', title: '開啟心經' }, '心經')
        ),
        h('pre', {}, h('code', {}, '說明：這段是程式碼')),
        h('span', { class: 'katex' }, '數學'),
        h('div', { class: 'mermaid' }, '流程圖'),
        h('p', {}, '軟體')
      ),
      h('script', {}, 'var 說明 = "不可轉換";'),
      h('style', {}, '.說明 {}'),
      h('textarea', { placeholder: '每行一個路徑' }, '使用者輸入的內容'),
      h('input', { placeholder: '輸入關鍵字搜尋' }),
      h('div', { contenteditable: 'true' }, '編輯中的文字')
    );
  }

  test('轉換文字節點與 title／placeholder／aria-label，略過程式碼、數學、圖表與腳本', () => {
    const page = buildPage();
    ds._convertTree(page);
    const [title, header, body, script, style, textarea, input, editable] = page.childNodes;

    assert.equal(allText(title), '般若波罗蜜多心经 — 阅读器');
    assert.equal(allText(header.childNodes[0]), '搜索');
    assert.equal(header.childNodes[0].getAttribute('title'), '页内搜索');
    assert.equal(header.childNodes[0].getAttribute('aria-label'), '搜索文件');
    assert.equal(allText(header.childNodes[1]), '繁', '[data-no-t2s] 不轉換');
    assert.equal(header.childNodes[1].getAttribute('title'), '目前為繁體', '[data-no-t2s] 的屬性也不轉換');

    assert.equal(allText(body.childNodes[0]), '观自在菩萨');
    assert.equal(allText(body.childNodes[1]), '行深般若波罗蜜多时，照见五蕴皆空。心经');
    assert.equal(allText(body.childNodes[2]), '說明：這段是程式碼', 'pre/code 不轉換');
    assert.equal(allText(body.childNodes[3]), '數學', '.katex 不轉換');
    assert.equal(allText(body.childNodes[4]), '流程圖', '.mermaid 不轉換');
    assert.equal(allText(body.childNodes[5]), '软体', '內文區只做逐字轉換，不替換為「软件」');
    assert.equal(allText(script), 'var 說明 = "不可轉換";');
    assert.equal(allText(style), '.說明 {}');
    assert.equal(allText(textarea), '使用者輸入的內容', 'textarea 內容不轉換');
    assert.equal(textarea.getAttribute('placeholder'), '每行一个路径', 'textarea 的 placeholder 仍要轉換');
    assert.equal(input.getAttribute('placeholder'), '输入关键字搜索');
    assert.equal(allText(editable), '編輯中的文字', '可編輯區不轉換');
  });

  test('href、src、id、data-* 屬性一律不動', () => {
    const page = buildPage();
    ds._convertTree(page);
    const body = page.childNodes[2];
    const heading = body.childNodes[0];
    const link = body.childNodes[1].childNodes[1];
    assert.equal(heading.getAttribute('id'), '觀自在菩薩');
    assert.equal(link.getAttribute('href'), '/?file=般若/心經.md');
    assert.equal(link.getAttribute('data-target'), '心經');
    assert.equal(link.getAttribute('title'), '开启心经', 'title 是顯示用屬性，要轉換');
  });

  test('切回繁體時逐字還原，與原本完全相同（含 後／后、髮／發、乾／幹 等一對多字）', () => {
    const tricky = '皇后於其後梳髮，發願乾淨；若干幹部。';
    const page = buildPage();
    page.childNodes[2].appendChild(h('p', {}, tricky));
    const before = JSON.stringify(snapshot(page));
    ds._convertTree(page);
    assert.notEqual(JSON.stringify(snapshot(page)), before, '前提：轉換後內容應不同');
    ds._restoreTree(page);
    assert.equal(JSON.stringify(snapshot(page)), before);
  });

  test('重複轉換不會疊加（轉換結果有紀錄即略過）', () => {
    const p = h('p', { id: 'markdownBody' }, '後來');
    ds._convertTree(p);
    ds._convertTree(p);
    assert.equal(allText(p), '后来');
    ds._restoreTree(p);
    assert.equal(allText(p), '後來');
  });

  test('原文查詢：originalText、originalTextContent（可排除子樹）', () => {
    const anchor = h('span', { class: 'line-anchor' }, '12');
    const heading = h('h2', {}, anchor, '【後分】皇后');
    const body = h('article', { id: 'markdownBody' }, heading);
    ds._convertTree(body);
    assert.equal(allText(heading), '12【后分】皇后');
    assert.equal(ds.originalText(heading.childNodes[1]), '【後分】皇后');
    assert.equal(
      ds.originalTextContent(heading, el => el.classList.contains('line-anchor')),
      '【後分】皇后'
    );
    // 被程式改寫過的節點不再視為轉換結果，回傳目前內容
    heading.childNodes[1].data = '新標題';
    assert.equal(ds.originalText(heading.childNodes[1]), '新標題');
  });
});

describe('繁簡顯示 3：MutationObserver 紀錄處理', () => {
  test('新增節點、文字變更、屬性變更都會轉換；內文區沿用逐字規則', () => {
    const body = h('article', { id: 'markdownBody' });
    const ui = h('div', {});
    const root = h('div', {}, body, ui);

    const chunk = h('p', {}, '軟體與經典');
    body.appendChild(chunk);
    const toast = new FakeText('已複製連結');
    ui.appendChild(toast);
    ds._handleMutations([
      { type: 'childList', target: body, addedNodes: [chunk] },
      { type: 'childList', target: ui, addedNodes: [toast] }
    ]);
    assert.equal(allText(chunk), '软体与经典');
    assert.equal(toast.data, '已复制链接');

    toast.data = '設定已儲存';
    ds._handleMutations([{ type: 'characterData', target: toast }]);
    assert.equal(toast.data, '设置已保存');

    ui.setAttribute('title', '偏好設定');
    ds._handleMutations([{ type: 'attributes', target: ui, attributeName: 'title' }]);
    assert.equal(ui.getAttribute('title'), '偏好设置');

    ds._restoreTree(root);
    assert.equal(allText(chunk), '軟體與經典');
    assert.equal(toast.data, '設定已儲存');
    assert.equal(ui.getAttribute('title'), '偏好設定');
  });

  test('不轉換區內新增的節點維持原樣', () => {
    const code = h('code', {});
    const root = h('article', { id: 'markdownBody' }, h('pre', {}, code));
    const t = new FakeText('說明');
    code.appendChild(t);
    ds._handleMutations([{ type: 'childList', target: code, addedNodes: [t] }]);
    assert.equal(t.data, '說明');
    ds._restoreTree(root);
  });
});

describe('繁簡顯示 4：首次造訪依瀏覽器語言自動切換', () => {
  function loadDetector({ navigatorLanguage = 'zh-TW', storedValue = null, storageThrows = false, setFails = false } = {}) {
    const sigs = [
      'function isSimplifiedChineseLocale(lang)',
      'function normalizeDisplayScript(value)',
      'function maybeAutoSelectDisplayScriptFromLocale()'
    ];
    let code = '';
    for (const sig of sigs) {
      const body = extractFunctionBody(appSource, sig);
      assert.ok(body, `app.js 應包含 ${sig}`);
      code += `${sig} ${body}\n`;
    }
    code += 'globalThis.__maybe = maybeAutoSelectDisplayScriptFromLocale;';
    const store = new Map();
    if (storedValue !== null) store.set('mdWebview-display-script', storedValue);
    const writes = [];
    const sandbox = {
      navigator: { language: navigatorLanguage },
      STORAGE_KEYS: { DISPLAY_SCRIPT: 'mdWebview-display-script' },
      storage: {
        get(key, fallback = null) {
          if (storageThrows) throw new Error('blocked');
          return store.has(key) ? store.get(key) : fallback;
        },
        set(key, val) {
          if (storageThrows) throw new Error('blocked');
          if (setFails) return false;
          writes.push([key, String(val)]);
          store.set(key, String(val));
          return true;
        }
      }
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return { run: () => sandbox.__maybe(), store, writes };
  }

  for (const lang of ['zh-CN', 'zh-Hans', 'zh-Hans-CN', 'zh-SG', 'zh_CN']) {
    test(`${lang}、從未設定 → 自動切為簡體並寫入`, () => {
      const d = loadDetector({ navigatorLanguage: lang });
      assert.equal(d.run(), true);
      assert.equal(d.store.get('mdWebview-display-script'), 'hans');
    });
  }

  for (const lang of ['zh-TW', 'zh-HK', 'zh-Hant', 'zh', 'en-US', '']) {
    test(`${lang || '(空)'}、從未設定 → 維持繁體且不寫入`, () => {
      const d = loadDetector({ navigatorLanguage: lang });
      assert.equal(d.run(), false);
      assert.equal(d.writes.length, 0, '不寫入，日後語言改為簡體時仍可判斷');
    });
  }

  test('zh-CN 但曾手動切回繁體 → 不覆寫', () => {
    const d = loadDetector({ navigatorLanguage: 'zh-CN', storedValue: 'hant' });
    assert.equal(d.run(), false);
    assert.equal(d.store.get('mdWebview-display-script'), 'hant');
    assert.equal(d.writes.length, 0);
  });

  test('zh-TW 但曾手動選簡體 → 保持簡體，不顯示自動切換提示', () => {
    const d = loadDetector({ navigatorLanguage: 'zh-TW', storedValue: 'hans' });
    assert.equal(d.run(), false);
    assert.equal(d.store.get('mdWebview-display-script'), 'hans');
  });

  test('已存的值不合法 → 視為未設定，重新判斷', () => {
    const d = loadDetector({ navigatorLanguage: 'zh-CN', storedValue: 'simplified' });
    assert.equal(d.run(), true);
    assert.equal(d.store.get('mdWebview-display-script'), 'hans');
  });

  test('localStorage 被封鎖或寫入失敗 → 不自動切換（避免每次都跳提示）', () => {
    assert.equal(loadDetector({ navigatorLanguage: 'zh-CN', storageThrows: true }).run(), false);
    assert.equal(loadDetector({ navigatorLanguage: 'zh-CN', setFails: true }).run(), false);
  });

  test('初始化順序：先判定再讀取，state 才拿得到自動切換的結果', () => {
    const callIdx = appSource.indexOf('const displayScriptAutoSelected = maybeAutoSelectDisplayScriptFromLocale();');
    const readIdx = appSource.indexOf('const userDisplayScript = normalizeDisplayScript(storage.get(STORAGE_KEYS.DISPLAY_SCRIPT));');
    assert.ok(callIdx > 0, '應呼叫 maybeAutoSelectDisplayScriptFromLocale');
    assert.ok(readIdx > callIdx, '讀取 DISPLAY_SCRIPT 必須在判定之後');
    assert.match(appSource, /displayScript:\s*userDisplayScript \|\| 'hant'/, 'state 預設為繁體');
    const initBody = extractFunctionBody(appSource, 'function initDisplayScript()');
    assert.ok(initBody);
    assert.match(initBody, /displayScriptAutoSelected\)\s*showDisplayScriptNotice\(\)/, '只有自動切換時才顯示提示');
  });
});

describe('繁簡顯示 5：i18n/boot.js 開機前置', () => {
  function runBoot({ lang = 'zh-TW', stored = null, storageThrows = false } = {}) {
    const attrs = {};
    const appended = [];
    const timers = [];
    const sandbox = {
      localStorage: {
        getItem(k) {
          if (storageThrows) throw new Error('blocked');
          return k === 'mdWebview-display-script' ? stored : null;
        }
      },
      navigator: { language: lang },
      setTimeout: (fn, ms) => timers.push([fn, ms]),
      document: {
        documentElement: { setAttribute: (k, v) => { attrs[k] = v; } },
        currentScript: { src: 'https://example.test/i18n/boot.js?v=9.9.9' },
        createElement: () => ({}),
        head: { appendChild: (el) => appended.push(el) }
      }
    };
    vm.createContext(sandbox);
    vm.runInContext(bootSource, sandbox);
    return { attrs, appended, timers };
  }

  test('簡體瀏覽器首次造訪：先隱藏畫面並預載 OpenCC', () => {
    const r = runBoot({ lang: 'zh-CN' });
    assert.equal(r.attrs['data-display-script'], 'hans');
    assert.equal(r.attrs.lang, 'zh-Hans');
    assert.equal(r.appended.length, 1);
    assert.equal(r.appended[0].src, 'vendor/opencc/t2cn.js?v=9.9.9', '沿用頁面版本參數，與 SW 快取鍵一致');
    assert.equal(r.appended[0].id, 'mdwOpenccScript', 'display-script.js 會沿用同一個 script 元素');
    assert.ok(r.timers.some(([, ms]) => ms <= 5000), '需有保底計時器，避免畫面一直隱藏');
  });

  test('已選繁體或非簡體語言：不做任何事', () => {
    for (const r of [runBoot({ lang: 'zh-CN', stored: 'hant' }), runBoot({ lang: 'en-US' }), runBoot({ lang: 'zh-TW' })]) {
      assert.deepEqual(r.attrs, {});
      assert.equal(r.appended.length, 0);
    }
  });

  test('已選簡體：任何瀏覽器語言都預載', () => {
    const r = runBoot({ lang: 'en-US', stored: 'hans' });
    assert.equal(r.attrs['data-display-script'], 'hans');
    assert.equal(r.appended.length, 1);
  });

  test('localStorage 被封鎖時不拋錯，依語言判斷', () => {
    const r = runBoot({ lang: 'zh-CN', storageThrows: true });
    assert.equal(r.attrs['data-display-script'], 'hans');
  });

  test('判定規則與 app.js isSimplifiedChineseLocale 一致', () => {
    const body = extractFunctionBody(appSource, 'function isSimplifiedChineseLocale(lang)');
    const sandbox = { navigator: { language: '' } };
    vm.createContext(sandbox);
    vm.runInContext(`function isSimplifiedChineseLocale(lang) ${body}\nglobalThis.__f = isSimplifiedChineseLocale;`, sandbox);
    for (const lang of ['zh-CN', 'zh_CN', 'zh-Hans', 'zh-Hans-CN', 'zh-SG', 'zh-TW', 'zh-HK', 'zh-Hant', 'zh', 'en-US', 'ja-JP', 'ZH-cn']) {
      const fromBoot = runBoot({ lang }).attrs['data-display-script'] === 'hans';
      assert.equal(fromBoot, sandbox.__f(lang), `${lang} 判定不一致`);
    }
  });
});

describe('繁簡顯示 6：搜尋與偏好整合', () => {
  test('高亮以字組比對：畫面上的簡體字與原文繁體字都命中', () => {
    const body = extractFunctionBody(appSource, 'function termRegexSource(term, variants)');
    const escBody = extractFunctionBody(appSource, 'function escRegex(str)');
    assert.ok(body && escBody);
    const sandbox = { window: { mdSearchVariants: require('../i18n/search-variants.js') } };
    vm.createContext(sandbox);
    vm.runInContext(`function escRegex(str) ${escBody}\nfunction termRegexSource(term, variants) ${body}\nglobalThis.__p = termRegexSource;`, sandbox);
    const re = new RegExp(sandbox.__p('經後', true), 'g');
    const shown = converters.content('經後與经后');
    assert.equal((shown.match(re) || []).length, 2, '簡體畫面字形應命中');
    assert.equal(('經後 经后'.match(re) || []).length, 2, '繁體與簡體原文都應命中');
    const exact = new RegExp(sandbox.__p('經後', false), 'g');
    assert.deepEqual('經後 经后'.match(exact), ['經後'], '關閉字組比對時為字面比對');
  });

  test('簡體顯示時搜尋一律以字組比對（送出 variants=1，不改寫輸入框）', () => {
    const body = extractFunctionBody(appSource, 'function s2tQueryEnabled()');
    assert.match(body, /state\.autoS2T\s*\|\|\s*isHansDisplay\(\)/);
    assert.match(extractFunctionBody(appSource, 'function variantsParam()'), /s2tQueryEnabled\(\)/);
    assert.doesNotMatch(appSource, /[?&]s2t=/, '搜尋 API 改送 variants 參數');
    assert.doesNotMatch(appSource, /toTraditional|(?<!\.)hasSimplified\b|window\.s2t/, '不再把查詢改寫為繁體（s2t.js 已移除）');
    for (const api of ['/api/search?', '/api/dict-search?', '/api/search-file?']) {
      const i = appSource.indexOf(api);
      assert.ok(i > 0, api);
      assert.match(appSource.slice(i, i + 220), /variants=\$\{variantsParam\(\)\}/, `${api} 需帶 variants`);
    }
  });

  test('劃詞查詢送出還原後的繁體原文', () => {
    assert.match(appSource, /originalTextOfRange\(range\)/);
    assert.match(appSource, /activateSearchPanel\(rawSelected\)/);
    assert.match(appSource, /runDictSearch\(rawSelected\)/);
  });

  test('wikilink 標題索引以原文建立', () => {
    const body = extractFunctionBody(appSource, 'function buildHeadingMap(body)');
    assert.match(body, /originalTextContent\(h,/);
  });

  test('偏好備份：匯出 displayScript，匯入時驗證值並相容舊備份', () => {
    const exp = extractFunctionBody(appSource, 'function exportUserPreferences(');
    const imp = extractFunctionBody(appSource, 'function importUserPreferences(file)');
    assert.ok(exp && imp);
    assert.match(exp, /displayScript:\s*normalizeDisplayScript\(state\.displayScript\)/);
    assert.match(imp, /normalizeDisplayScript\(pref\.displayScript\)/, '只接受 hant／hans');
    const normalize = extractFunctionBody(appSource, 'function normalizeDisplayScript(value)');
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(`function normalizeDisplayScript(value) ${normalize}\nglobalThis.__n = normalizeDisplayScript;`, sandbox);
    assert.equal(sandbox.__n('hans'), 'hans');
    assert.equal(sandbox.__n('hant'), 'hant');
    for (const bad of [undefined, null, '', 'zh-CN', 'HANS', 1, true, {}]) {
      assert.equal(sandbox.__n(bad), null, `${String(bad)} 應視為無效`);
    }
  });
});

describe('繁簡顯示 7：靜態資源與頁面結構', () => {
  test('右上角切換按鈕：可及性屬性、不被轉換、位於 header-right', () => {
    const header = indexHtml.slice(indexHtml.indexOf('<div class="header-right">'), indexHtml.indexOf('</header>'));
    assert.match(header, /id="displayScriptToggleBtn"/);
    const btn = header.slice(header.indexOf('id="displayScriptToggleBtn"') - 10);
    assert.match(btn, /data-no-t2s/);
    assert.match(btn, /aria-label="/);
    assert.match(btn, /title="/);
  });

  test('boot.js 在 <head> 同步載入；其餘 i18n 腳本在 app.js 之前 defer 載入', () => {
    const headEnd = indexHtml.indexOf('</head>');
    const bootIdx = indexHtml.indexOf('<script src="i18n/boot.js');
    assert.ok(bootIdx > 0 && bootIdx < headEnd, 'boot.js 必須在 head 內');
    assert.doesNotMatch(indexHtml.slice(bootIdx, indexHtml.indexOf('>', bootIdx)), /defer|async/, 'boot.js 必須同步執行');
    const appIdx = indexHtml.indexOf('<script src="app.js');
    for (const f of ['zh-TW.js', 'zh-CN.js', 'i18n.js', 'content-terms.js', 'display-script.js']) {
      const idx = indexHtml.indexOf(`<script src="i18n/${f}`);
      assert.ok(idx > 0 && idx < appIdx, `${f} 應在 app.js 之前載入`);
    }
    assert.doesNotMatch(indexHtml, /<script src="vendor\/opencc/, 'OpenCC 只在需要簡體時才載入');
  });

  test('Service Worker 預快取新資源', () => {
    for (const f of ['/i18n/boot.js', '/i18n/zh-TW.js', '/i18n/zh-CN.js', '/i18n/i18n.js', '/i18n/content-terms.js', '/i18n/display-script.js', '/vendor/opencc/t2cn.js']) {
      assert.ok(swSource.includes(`'${f}'`), `sw.js SHELL_ASSETS 應包含 ${f}`);
      assert.ok(fs.existsSync(path.join(ROOT_DIR, f)), `${f} 應存在`);
    }
  });

  test('OpenCC 授權檔隨附', () => {
    const lic = fs.readFileSync(path.join(ROOT_DIR, 'vendor', 'opencc', 'LICENSE'), 'utf8');
    assert.match(lic, /MIT License/);
    assert.ok(fs.existsSync(path.join(ROOT_DIR, 'vendor', 'opencc', 'LICENSE-Apache-2.0.txt')));
  });

  test('簡體顯示等待期間隱藏畫面的 CSS 規則存在', () => {
    const css = fs.readFileSync(path.join(ROOT_DIR, 'style.css'), 'utf8');
    assert.match(css, /html\[data-display-script="hans"\]:not\(\[data-t2s-ready\]\) body\s*\{\s*visibility:\s*hidden;/);
  });
});
