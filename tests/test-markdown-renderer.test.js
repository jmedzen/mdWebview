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
