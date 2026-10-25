/**
 * 搜尋字組（簡繁變體）在前端 app.js 的行為：辭典詞頭查詢（前綴／模糊）、
 * 搜尋結果摘要高亮、本頁搜尋高亮。以 vm 執行 app.js 中的真實函式。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const sv = require('../i18n/search-variants.js');

/** 從 app.js 取出函式主體（以大括號配對到結尾），跳過字串與樣板內的括號。 */
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

/** 以「函式宣告到下一個兩格縮排的 }」擷取（函式內有含引號的 regex 時用） */
function grab(name) {
  const i = appSource.indexOf(`  function ${name}(`);
  assert.ok(i >= 0, name);
  return appSource.slice(i, appSource.indexOf('\n  }\n', i) + 4);
}

/** 把 app.js 的多個函式載入同一個 vm 沙箱。 */
function loadFunctions(sandbox, signatures) {
  vm.createContext(sandbox);
  let code = '';
  for (const sig of signatures) {
    const body = extractFunctionBody(appSource, sig);
    assert.ok(body, `app.js 應包含 ${sig}`);
    code += `${sig} ${body}\n`;
  }
  const names = signatures.map(s => s.match(/function\s+(\w+)/)[1]);
  code += `globalThis.__fns = { ${names.join(', ')} };`;
  vm.runInContext(code, sandbox);
  return sandbox.__fns;
}

describe('前端字組 1：辭典詞頭查詢', () => {
  function setup(variantsOn) {
    const captured = {};
    const sandbox = {
      window: { mdSearchVariants: sv },
      state: {},
      s2tQueryEnabled: () => variantsOn,
      dictSelectedSet: () => new Set([0]),
      renderDictHeadwordResults: (matched, q) => { captured.hws = Array.from(matched, m => m.hw); captured.q = q; },
      $: () => ({ innerHTML: '' })
    };
    const fns = loadFunctions(sandbox, [
      'function extractCJKBigrams(text)',
      'function intersectSortedIdx(a, b)',
      'function buildDictFrontendIndex(data)',
      'function dictFoldedIndex(idx)',
      'function dictVariantMatcher(q)',
      'function dictSearchPrefix(q)',
      'function dictSearchFuzzy(q)'
    ]);
    const hws = ['頭髮', '頭陀', '後來', '后妃', '發心', '著衣', '无为法', '觀自在'];
    fns.buildDictFrontendIndex({ files: [{ name: 'x', path: 'dict:x.md' }], entries: hws.map((h, i) => [0, i, i + 1, h]) });
    return { fns, captured, sandbox };
  }

  test('前綴查詢：简体输入命中繁体词头（頭髮、頭陀），结果依原排序', () => {
    const { fns, captured } = setup(true);
    fns.dictSearchPrefix('头');
    assert.deepEqual(captured.hws, ['頭陀', '頭髮'].sort());
    fns.dictSearchPrefix('后');
    assert.deepEqual(captured.hws.slice().sort(), ['后妃', '後來'].sort(), '后 同時命中 後來 與 后妃');
    fns.dictSearchPrefix('無為');
    assert.deepEqual(captured.hws, ['无为法'], '繁体输入命中简体词头');
  });

  test('模糊查詢（含 bigram 字組展開）：发心、着衣、自在', () => {
    const { fns, captured } = setup(true);
    fns.dictSearchFuzzy('发心');
    assert.deepEqual(captured.hws, ['發心']);
    fns.dictSearchFuzzy('着衣');
    assert.deepEqual(captured.hws, ['著衣']);
    fns.dictSearchFuzzy('观自');
    assert.deepEqual(captured.hws, ['觀自在']);
    fns.dictSearchFuzzy('为法');
    assert.deepEqual(captured.hws, ['无为法']);
  });

  test('前綴查不到時退回模糊查詢', () => {
    const { fns, captured } = setup(true);
    fns.dictSearchPrefix('来');
    assert.deepEqual(captured.hws, ['後來']);
  });

  test('字組比對關閉時（繁體顯示、未開啟設定）維持字面比對', () => {
    const { fns, captured } = setup(false);
    fns.dictSearchPrefix('头');
    assert.deepEqual(captured.hws, []);
    fns.dictSearchPrefix('頭');
    assert.deepEqual(captured.hws, ['頭陀', '頭髮'].sort());
    fns.dictSearchFuzzy('着衣');
    assert.deepEqual(captured.hws, []);
  });
});

describe('前端字組 2：搜尋結果摘要高亮', () => {
  const fnSandbox = { window: { mdSearchVariants: sv } };
  vm.createContext(fnSandbox);
  vm.runInContext(grab('escRegex') + grab('termRegexSource') + grab('sameSearchChar') +
    'globalThis.__fns = { termRegexSource, sameSearchChar };', fnSandbox);
  const fns = fnSandbox.__fns;
  test('寬鬆模式：字組比對可跨標點，關閉時只命中字面', () => {
    // LOOSE_TRANSPARENT_RE 是 app.js 頂層常數，需一併載入
    const sandbox = { window: { mdSearchVariants: sv } };
    vm.createContext(sandbox);
    const m = appSource.match(/const LOOSE_TRANSPARENT_RE = (\/.+\/u);/);
    vm.runInContext(`const LOOSE_TRANSPARENT_RE = ${m[1]};\n` +
      grab('escHtml') + grab('highlightLooseSnippet') +
      '\nglobalThis.__h = highlightLooseSnippet;', sandbox);
    assert.equal(sandbox.__h('然後，來了 <x>', ['后来'], true), '然<mark>後，來</mark>了 &lt;x&gt;');
    assert.equal(sandbox.__h('然後，來了', ['后来'], false), '然後，來了');
    assert.equal(sandbox.__h('然後，來了', ['後來'], false), '然<mark>後，來</mark>了');
  });

  test('sameSearchChar／termRegexSource', () => {
    assert.equal(fns.sameSearchChar('后', '後', true), true);
    assert.equal(fns.sameSearchChar('后', '後', false), false);
    assert.equal(fns.sameSearchChar('a', 'a', false), true);
    assert.equal(fns.termRegexSource('a.b', false), 'a\\.b');
    assert.equal(fns.termRegexSource('头', true), '[头頭]');
  });
});

describe('前端字組 3：本頁搜尋高亮（highlightTextNodes）', () => {
  // 只實作 highlightTextNodes 用到的 DOM 介面
  class TextNode {
    constructor(text) { this.nodeType = 3; this.textContent = text; this.parentNode = null; }
  }
  class Mark {
    constructor() { this.className = ''; this.textContent = ''; }
  }
  class Fragment {
    constructor() { this.children = []; }
    appendChild(n) { this.children.push(n); return n; }
  }
  function run(texts, query, variants) {
    const parent = {
      replaced: [],
      replaceChild(frag, old) { this.replaced.push({ old: old.textContent, parts: frag.children.map(c => (c instanceof Mark ? `[${c.textContent}]` : c.textContent)).join('') }); }
    };
    const nodes = texts.map(t => { const n = new TextNode(t); n.parentNode = parent; return n; });
    const sandbox = {
      window: { mdSearchVariants: sv },
      NodeFilter: { SHOW_TEXT: 4 },
      document: {
        createTreeWalker: () => {
          let i = -1;
          return { get currentNode() { return nodes[i]; }, nextNode() { i++; return i < nodes.length ? nodes[i] : null; } };
        },
        createDocumentFragment: () => new Fragment(),
        createTextNode: (t) => new TextNode(t),
        createElement: () => new Mark()
      }
    };
    const fns = loadFunctions(sandbox, ['function highlightTextNodes(root, query, variants)']);
    const marks = fns.highlightTextNodes({}, query, variants);
    return { marks: Array.from(marks, m => m.textContent), replaced: parent.replaced.map(r => r.parts) };
  }

  test('簡體畫面（DOM 為簡體字）以繁體或簡體查詢都能高亮，位置對應原文', () => {
    const r = run(['然后如是，皇后在此', '头发长'], '後', true);
    assert.deepEqual(r.marks, ['后', '后']);
    assert.deepEqual(r.replaced, ['然[后]如是，皇[后]在此']);
    assert.deepEqual(run(['头发长'], '頭髮', true).marks, ['头发']);
  });

  test('字組比對關閉時維持字面（不分大小寫）比對', () => {
    assert.deepEqual(run(['然后如是', '然後'], '後', false).marks, ['後']);
    assert.deepEqual(run(['ABC abc'], 'abc', false).marks, ['ABC', 'abc']);
  });
});
