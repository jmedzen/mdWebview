/**
 * 註腳行號錨點測試
 *
 * 背景：全庫搜尋命中註腳內文（例如《大智度論》卷三十的 [^119]）時，點選結果
 * 不會跳到註腳。三份渲染器（render-worker.js、md-worker.js、app.js 內建備援）
 * 都會先把 `[^id]: …` 定義從正文抽出、另外排在文末，但：
 *   1. 註腳那幾行沒有任何 `#L<n>` 錨點，scrollToLine 只好退回「行號 ≤ 目標的
 *      最後一個錨點」，也就是正文最後一段，離真正的註腳可能有幾千像素；
 *   2. 錨點行號用的是「抽掉註腳後」的陣列索引，註腳定義若夾在正文中間，之後
 *      每一行的錨點都會往前偏移，搜尋結果、書籤、分享連結都會跳錯行。
 *
 * 修正後：每行註腳文字都有自己的錨點（帶 data-fn），正文錨點一律用原檔行號；
 * anchorAtOrBefore 的二分搜尋略過註腳錨點，避免排在文末的註腳打亂遞增順序。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

function loadRenderWorker() {
  let code = fs.readFileSync(path.join(ROOT, 'render-worker.js'), 'utf8');
  code = code.replace("const { parentPort } = require('worker_threads');", 'const parentPort = { on: () => {}, postMessage: () => {} };');
  code += '\n;global.renderMarkdownSSR = renderMarkdownSSR;';
  const sb = { global: {}, require, console };
  vm.createContext(sb);
  vm.runInContext(code, sb);
  return sb.global.renderMarkdownSSR;
}

function loadMdWorker() {
  const sb = { self: {}, console };
  sb.importScripts = (f) => vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sb);
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'md-worker.js'), 'utf8') + '\n;self.__parse = parseMarkdown;', sb);
  return (md) => sb.self.__parse(md, 'doc/test.md').html;
}

/** Pull a top-level-ish `function name(...) { ... }` out of app.js by brace matching. */
function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start !== -1, `app.js 應包含 ${signature}`);
  let i = source.indexOf('{', start);
  let depth = 0;
  let quote = null;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') { i = source.indexOf('\n', i); continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unbalanced ' + signature);
}

const renderSSR = loadRenderWorker();
const renderMdWorker = loadMdWorker();

/** All line anchors in document order: [{ line, fn }] */
function anchors(html) {
  return Array.from(html.matchAll(/<span id="L(\d+)" data-line="\1" class="line-anchor"( data-fn="1")?><\/span>/g))
    .map(m => ({ line: Number(m[1]), fn: !!m[2] }));
}

const DOC_FOOTNOTES_AT_END = [
  '# 大智度論卷第三十',                 // 1
  '',                                   // 2
  '正文第一段[^1]。',                   // 3
  '',                                   // 4
  '正文第二段[^119]。',                 // 5
  '',                                   // 6
  '[^1]: 註一。',                       // 7
  '[^119]: 善知清淨心，盡脫婬怒癡，成就於三明，以此為三達。', // 8
].join('\n');

const DOC_FOOTNOTES_INTERLEAVED = [
  '# 卷首',                             // 1
  '',                                   // 2
  '甲段[^a]。',                         // 3
  '',                                   // 4
  '[^a]: 甲註第一行',                   // 5
  '    甲註續行',                       // 6
  '',                                   // 7
  '乙段在註腳定義之後。',               // 8
  '',                                   // 9
  '## 第二節',                          // 10
].join('\n');

for (const [name, render] of [['render-worker.js（伺服器渲染）', renderSSR], ['md-worker.js（瀏覽器 worker）', renderMdWorker]]) {
  describe(`註腳行號錨點：${name}`, () => {
    test('註腳那一行有自己的 #L 錨點（行號 = 原檔行號），且位在該註腳的 <li> 內', () => {
      const html = render(DOC_FOOTNOTES_AT_END, 'doc/t.md', 0);
      const fnAnchors = anchors(html).filter(a => a.fn).map(a => a.line);
      assert.deepEqual(fnAnchors, [7, 8]);
      const li = html.match(/<li class="footnote-item" id="fn-def-119"[\s\S]*?<\/li>/)[0];
      assert.ok(li.includes('id="L8"'), '[^119] 的錨點應在 fn-def-119 之內');
      assert.ok(li.includes('善知清淨心'), '註腳內文照常渲染');
    });

    test('註腳定義夾在正文中間時，之後的正文錨點仍是原檔行號（不再往前偏移）', () => {
      const html = render(DOC_FOOTNOTES_INTERLEAVED, 'doc/t.md', 0);
      const body = anchors(html).filter(a => !a.fn).map(a => a.line);
      assert.deepEqual(body, [1, 3, 8, 10]);
      assert.ok(/id="L8"[^>]*><\/span>乙段/.test(html), 'L8 應指向「乙段」');
      assert.ok(/id="L10"[^>]*><\/span>第二節/.test(html), 'L10 應指向「第二節」標題');
      const fn = anchors(html).filter(a => a.fn).map(a => a.line);
      assert.deepEqual(fn, [5, 6], '註腳第一行與續行各有錨點');
    });

    test('錨點 id 不重複', () => {
      for (const md of [DOC_FOOTNOTES_AT_END, DOC_FOOTNOTES_INTERLEAVED]) {
        const ids = anchors(render(md, 'doc/t.md', 0)).map(a => a.line);
        assert.equal(new Set(ids).size, ids.length);
      }
    });

    test('註腳裡的清單記號保留在錨點之前，縮排程式碼區塊不插錨點', () => {
      const md = [
        '正文[^x]',
        '',
        '[^x]: - 清單一',
        '    - 清單二',
        '',
        '        code();',
      ].join('\n');
      const html = render(md, 'doc/t.md', 0);
      assert.ok(html.includes('<li><span id="L3"'), '清單項目仍是 <li>，錨點在項目內');
      assert.ok(!/<code>[^<]*&lt;span/.test(html) && !/<code>[\s\S]*?id="L6"/.test(html), '程式碼區塊內不得出現錨點');
    });
  });
}

describe('註腳行號錨點：render-worker 的 lineOffset（frontmatter／大檔分段）', () => {
  test('註腳錨點與正文錨點都加上 lineOffset', () => {
    const html = renderSSR(DOC_FOOTNOTES_INTERLEAVED, 'doc/t.md', 100);
    assert.deepEqual(anchors(html).map(a => a.line).sort((a, b) => a - b), [101, 103, 105, 106, 108, 110]);
  });
});

describe('註腳行號錨點：app.js 內建備援渲染器與跳轉', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

  test('inlineParseMarkdown 用原檔行號（cleanNums）並為註腳插錨點', () => {
    const fnSrc = extractFunction(src, 'function inlineParseMarkdown(body)');
    assert.ok(fnSrc.includes('const lineNum = cleanNums[i];'), '正文錨點應改用原檔行號');
    assert.ok(fnSrc.includes('anchorFootnoteLines(fn, 0)'), '註腳文字應經過 anchorFootnoteLines');
  });

  test('三份 anchorFootnoteLines 輸出一致', () => {
    const sb = {};
    vm.createContext(sb);
    vm.runInContext(extractFunction(src, 'function anchorFootnoteLines(fn, lineOffset)') + ';this.f = anchorFootnoteLines;', sb);
    const fn = { text: ['註一', '    續行', '', '        code', '- 項'], nums: [7, 8, 9, 10, 11] };
    const viaApp = JSON.stringify(Array.from(sb.f(fn, 0)));
    for (const file of ['render-worker.js', 'md-worker.js']) {
      const s2 = {};
      vm.createContext(s2);
      vm.runInContext(extractFunction(fs.readFileSync(path.join(ROOT, file), 'utf8'), 'function anchorFootnoteLines(fn, lineOffset)') + ';this.f = anchorFootnoteLines;', s2);
      assert.equal(JSON.stringify(Array.from(s2.f(fn, 0))), viaApp, `${file} 與 app.js 應一致`);
    }
  });

  test('anchorAtOrBefore 略過註腳錨點：文末的註腳不會打亂二分搜尋', () => {
    const sb = {};
    vm.createContext(sb);
    const code = 'let cachedLineAnchors = [];\n'
      + src.slice(src.indexOf('  let _bodyAnchorsFor = null;'), src.indexOf('function anchorAtOrBefore(lineNum)'))
      + extractFunction(src, 'function anchorAtOrBefore(lineNum)')
      + ';this.set = (a) => { cachedLineAnchors = a; }; this.find = anchorAtOrBefore;';
    vm.runInContext(code, sb);
    const mk = (line, fn) => ({ line, dataset: { line: String(line) }, hasAttribute: (k) => k === 'data-fn' && fn });
    // Document order of DOC_FOOTNOTES_INTERLEAVED: body 1,3,8,10 then footnotes 5,6.
    sb.set([mk(1), mk(3), mk(8), mk(10), mk(5, true), mk(6, true)]);
    assert.equal(sb.find(9).line, 8, '第 9 行（空行）屬於「乙段」');
    assert.equal(sb.find(12).line, 10);
    assert.equal(sb.find(4).line, 3);
  });
});
