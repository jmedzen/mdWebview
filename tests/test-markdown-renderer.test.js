const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Load renderMarkdownSSR from render-worker.js in sandbox
let workerCode = fs.readFileSync(path.join(__dirname, '../render-worker.js'), 'utf8');
workerCode = workerCode.replace("const { parentPort } = require('worker_threads');", "const parentPort = { on: () => {}, postMessage: () => {} };");
workerCode += '\n;global.renderMarkdownSSR = renderMarkdownSSR;';

const sandbox = { global: {}, require, escapeHtml: s => s, escapeAttr: s => s, console };
vm.createContext(sandbox);
vm.runInContext(workerCode, sandbox);
const renderMarkdownSSR = sandbox.global.renderMarkdownSSR;

describe('Markdown 渲染引擎與表格/行號錨點測試', () => {
  test('GFM 原生 Markdown 表格渲染為 <table>，而非純文字段落', () => {
    const md = [
      '# 表格測試',
      '',
      '| 欄位 A | 欄位 B | 欄位 C |',
      '| --- | :---: | ---: |',
      '| 數值 1 | 數值 2 | 數值 3 |',
      '| 內容 X | 內容 Y | 內容 Z |'
    ].join('\n');

    const html = renderMarkdownSSR(md, 'test.md', 0);
    assert.ok(html.includes('<table>'), '應包含 <table> 標籤');
    assert.ok(html.includes('<th>'), '應包含 <th> 表頭標籤');
    assert.ok(html.includes('<td>'), '應包含 <td> 儲存格標籤');
    assert.ok(!html.includes('<p><span id="L3"'), '表格不得被誤包裝在 <p> 內');
  });

  test('原生 HTML 大表格保留結構，無 <p> 污染與 <br> 破壞', () => {
    const md = [
      '# 佛學對照表',
      '',
      '---',
      '',
      '<table class="hanhsiu-table">',
      '<tbody>',
      '<tr>',
      '<th colspan="2">五識相應地</th>',
      '</tr>',
      '<tr>',
      '<td>眼識</td>',
      '<td>色處</td>',
      '</tr>',
      '</tbody>',
      '</table>'
    ].join('\n');

    const html = renderMarkdownSSR(md, 'table-test.md', 0);
    assert.ok(html.includes('<table class="hanhsiu-table">'), '應保留原生 table 屬性');
    assert.ok(html.includes('<hr>'), '--- 應正確渲染為 <hr>');
    assert.ok(!html.includes('<p><table'), 'table 標籤不得緊跟在 <p> 之後');
    assert.ok(!html.includes('<p><span id="L5"><table'), 'table 行首不得被前置 span');
  });

  test('行號錨點在標題、引言與清單中精準注入', () => {
    const md = [
      '# 第一章 本地分',
      '> 觀自在菩薩行深般若波羅蜜多時',
      '- 第一點觀察',
      '- 第二點分析'
    ].join('\n');

    const html = renderMarkdownSSR(md, 'anchors.md', 0);
    assert.ok(html.includes('id="L1"'), '標題應具有行號錨點 L1');
    assert.ok(html.includes('id="L2"'), '引言應具有行號錨點 L2');
    assert.ok(html.includes('id="L3"'), '清單項目應具有行號錨點 L3');
    assert.ok(html.includes('id="L4"'), '清單項目應具有行號錨點 L4');
  });

  test('程式碼區塊（Code Blocks）內部不應被注入錨點', () => {
    const md = [
      '```javascript',
      'const a = 1;',
      'const b = 2;',
      '```'
    ].join('\n');

    const html = renderMarkdownSSR(md, 'code.md', 0);
    assert.ok(!html.includes('data-line="2"'), '程式碼內容行不應注入行號錨點');
    assert.ok(!html.includes('data-line="3"'), '程式碼內容行不應注入行號錨點');
  });

  test('Wikilink 雙向連結語法解析', () => {
    const md = [
      '參考：[[金剛般若波羅蜜經]]',
      '別名：[[大智度論|智論導讀]]',
      '章節：[[瑜伽師地論#本地分]]'
    ].join('\n');

    const html = renderMarkdownSSR(md, 'wikilinks.md', 0);
    assert.ok(html.includes('data-wikilink-file="金剛般若波羅蜜經"'), '應識別基本雙鏈');
    assert.ok(html.includes('智論導讀'), '應顯示別名');
    assert.ok(html.includes('data-wikilink-anchor="#本地分"'), '應識別章節錨點');
  });

  test('Obsidian 圖片嵌入語法解析', () => {
    const md = '![[schema-diagram.jpg]]';
    const html = renderMarkdownSSR(md, 'doc/test.md', 0);
    assert.ok(html.includes('<img'), '應渲染為 <img> 標籤');
    assert.ok(html.includes('/api/media?path=schema-diagram.jpg'), 'src 應指向 /api/media 端點');
  });

  test('Footnote 註腳安全防禦：惡意標籤消毒與 ID 屬性跳脫 (P0-1)', () => {
    const md = [
      '正文參考[^malicious]與[^xss-id]。',
      '',
      '[^malicious]: 註腳內文包含 <script>alert(1)</script><style>body{color:red}</style>危險標籤。',
      '[^"><img src=x onerror=alert(1)>]: 包含注入引號的惡意標記。'
    ].join('\n');
    const html = renderMarkdownSSR(md, 'doc/test-footnote.md', 0);
    assert.ok(!html.includes('<script>'), '不得包含 <script> 標籤');
    assert.ok(!html.includes('<style>'), '不得包含 <style> 標籤');
    assert.ok(!html.includes('onerror='), '不得包含未過濾之 onerror 事件');
    assert.ok(html.includes('class="footnotes"'), '應正常生成 footnotes 區塊');
    assert.ok(html.includes('fn-def-'), '應生成 fn-def 錨點');
  });
});

describe('SSR 掃描閘門 (Per-document Scan Gates)', () => {
  // 背景：marked 在每個 tokenization 步驟都會呼叫擴充的 start(src)，且傳入的是
  // 「整份剩餘後綴」，因此無條件 src.indexOf(...) 會退化成 O(n²)。修正後每次
  // 解析前以 setScanGates() 依文件內容開關掃描，無標記時 start() 回傳 -1。
  //
  // 這組測試守護兩個方向：
  //   1. 語意不變 —— 有標記時輸出必須與修正前完全相同（含段落中間的 $$）。
  //   2. 效能不回歸 —— 無標記的大型文件不得再走 O(n²) 掃描。

  test('區塊數學 $$...$$ 渲染為 math-block', () => {
    const html = renderMarkdownSSR('$$\nE = mc^2\n$$\n', 'math.md', 0);
    assert.ok(html.includes('class="math-block"'), '應包含 math-block 區塊');
    assert.ok(html.includes('E = mc^2'), '應保留公式內容');
  });

  test('行內數學 $x$ 渲染為 math-inline', () => {
    const html = renderMarkdownSSR('數值 $x^2 + y^2$\n', 'math.md', 0);
    assert.ok(html.includes('class="math-inline"'), '應包含 math-inline');
    assert.ok(html.includes('x^2 + y^2'), '應保留公式內容');
  });

  test('Obsidian 高亮 ==text== 渲染為 mark', () => {
    const html = renderMarkdownSSR('這是 ==重點== 文字。\n', 'hl.md', 0);
    assert.ok(html.includes('class="obsidian-highlight"'), '應包含 obsidian-highlight');
    assert.ok(html.includes('<mark'), '應渲染為 <mark> 標籤');
  });

  test('段落中間的 $$ 仍必須解析為 math-block（防止移除 start 的迴歸）', () => {
    // 這是關鍵守門測試：mathBlock 的 start() 不能整個刪除，只能在無標記時停用。
    // 若有人改成直接移除 start()，此案例會由 math-block 退化成純文字。
    const html = renderMarkdownSSR('前文 $$x$$ 後文\n', 'mid.md', 0);
    assert.ok(html.includes('class="math-block"'), '段落中間的 $$ 仍應產生 math-block');

    const noBlankLine = renderMarkdownSSR('p1\n$$\nz\n$$\n', 'mid2.md', 0);
    assert.ok(noBlankLine.includes('class="math-block"'), '未空行前的 $$ 仍應產生 math-block');
  });

  test('無標記文件中 $ 不應被誤判（純文字美元符號）', () => {
    const html = renderMarkdownSSR('價格 $5 元。\n', 'dollar.md', 0);
    assert.ok(!html.includes('math-inline'), '不成對的 $ 不應產生 math-inline');
    assert.ok(html.includes('$5'), '應保留原始文字');
  });

  test('無標記大型文件不得再走 O(n²) 掃描（效能守門）', () => {
    // marked calls every extension's start(src) on each tokenization step, where
    // src is the entire *remaining suffix*. An unconditional src.indexOf(...)
    // therefore rescans the whole tail every step -> O(n²). setScanGates() closes
    // the gates per document so that a text containing no $ or == performs no
    // scans at all.
    //
    // Guarding this by wall-clock time proved unreliable: the same code measured
    // 0.4s idle and >3s while the rest of the suite ran, so a timing threshold
    // produced false failures. This asserts the *work performed* instead —
    // counting real indexOf calls inside the three gated hooks, which is
    // completely independent of machine load and of how fast the host is.
    //
    // Measured behaviour: unmarked documents perform 0 scans; documents that do
    // contain a marker perform >0 (the gates still open).
    const workerSrc = fs.readFileSync(path.join(__dirname, '../render-worker.js'), 'utf8');

    const hookTargets = [
      "return _scanEq ? src.indexOf('==') : -1;",
      "return _scanDollar2 ? src.indexOf('$$') : -1;",
      "return _scanDollar ? src.indexOf('$') : -1;"
    ];

    let instrumented = workerSrc
      .replace("const { parentPort } = require('worker_threads');",
               'const parentPort = { on: () => {}, postMessage: () => {} };');

    let hooksFound = 0;
    for (const needle of hookTargets) {
      if (!instrumented.includes(needle)) continue;
      // Count only when the hook's own gate is open; a closed gate must cost nothing.
      const gate = needle.slice(needle.indexOf('_scan'), needle.indexOf(' ? '));
      const inner = needle.replace('return ', '').replace(/;$/, '');
      instrumented = instrumented.replace(
        needle,
        () => `if (${gate}) { global.__scanCount++; } return ${inner};`
      );
      hooksFound++;
    }

    // If the hooks are ever renamed, fail loudly rather than silently stopping
    // to guard anything.
    assert.equal(hooksFound, 3,
      '應找到三個受閘門控制的 start() 掃描點；找不到表示 render-worker.js 結構已變更，此守門測試必須同步更新');

    instrumented += '\n;global.renderMarkdownSSR = renderMarkdownSSR;';
    const probe = { global: {}, require, escapeHtml: (s) => s, escapeAttr: (s) => s, console };
    vm.createContext(probe);
    vm.runInContext('global.__scanCount = 0;', probe);
    vm.runInContext(instrumented, probe);

    const scanCountFor = (md) => {
      probe.global.__scanCount = 0;
      const html = probe.global.renderMarkdownSSR(md, 'perf.md', 0);
      return { scans: probe.global.__scanCount, html };
    };

    const para = '這是一段用於效能守門的測試文字，內容不含任何數學或高亮標記，僅作為大量段落填充。\n\n';
    const big = '# 效能守門文件\n\n' + para.repeat(60000);
    assert.ok(
      big.length > 2 * 1024 * 1024,
      `合成文件應大於 2M 字元，實際 ${(big.length / 1048576).toFixed(2)}M 字元`
    );

    const unmarked = scanCountFor(big);
    assert.ok(unmarked.html.includes('效能守門文件'), '內容應正確渲染');
    assert.equal(
      unmarked.scans,
      0,
      `無標記文件不應執行任何掃描，實際 ${unmarked.scans} 次；` +
      '非 0 表示掃描閘門失效，已退回 O(n²) 全檔重複掃描'
    );

    // Guards must still OPEN when the markers are present, otherwise "0 scans"
    // could be satisfied by disabling the features outright.
    for (const [label, text] of [
      ['$ 行內數學', '# t\n\n$x$ ' + para.repeat(200)],
      ['== 高亮', '# t\n\n==x== ' + para.repeat(200)],
      ['$$ 區塊數學', '# t\n\n$$\nz\n$$\n' + para.repeat(200)]
    ]) {
      assert.ok(
        scanCountFor(text).scans > 0,
        `含 ${label} 的文件仍必須實際掃描（閘門不得恆關）`
      );
    }
  });
});
