/**
 * 粗體前處理不得吃掉換行（科判點擊不捲動）
 *
 * 背景：《辯中邊論述記科句》點科判節點，閱讀區不捲動。原因是 Obsidian 粗體
 * 前處理 `**…**` 的空白部分用了 \s，會跨行：上一段的收尾 `**` 後面接空行再接
 * 下一段 `**論曰：…**` 時，會把「收尾 ** + 空行 + 下一段」誤配成一組粗體並
 * 把換行 trim 掉，之後每一個錨點行號都比原檔少幾行，科判的行號對不到標題。
 *
 * 修正：前後空白只允許同一行內的空白（空格、tab、NBSP）。
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

// 第 1–3 行是跨行粗體收尾；第 4 行普通文字；第 6–7 行是下一段跨行粗體的開頭。
// 舊正規式會把「第 3 行的收尾 ** … 第 6 行的開頭 **」誤配成粗體並吃掉其間的換行。
const DOC = ['**論曰：三雜染者：', '一、煩惱雜染', '二、業雜染。**', '述曰：此同《瑜伽》。', '', '**論曰：二雜染者：', '一、因雜染。**', '', '### 丙三、總結前義', '', '尾端'].join('\n');
const HEADING_LINE = 9;

function headingLine(html) {
  const m = html.match(/<h3[^>]*><span id="L(\d+)"/);
  assert.ok(m, '應有帶錨點的 h3');
  return Number(m[1]);
}

describe('粗體前處理保留行號', () => {
  test('render-worker：跨行粗體後接空行再接粗體，標題錨點仍是原檔行號', () => {
    assert.equal(headingLine(loadRenderWorker()(DOC, 'doc/test.md', 0)), HEADING_LINE);
  });
  test('md-worker：同上', () => {
    assert.equal(headingLine(loadMdWorker()(DOC)), HEADING_LINE);
  });
  test('單行 ** 粗體 ** 仍會轉成 <strong>', () => {
    const html = loadRenderWorker()('a ** 粗 ** b', 'doc/test.md', 0);
    assert.match(html, /<strong>粗<\/strong>/);
  });
  test('app.js 內建備援的粗體／底線正規式空白不含換行', () => {
    const src = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    assert.ok(!/\[\\s\\u00A0\]\*\[\^/.test(src), 'app.js 不應再用 [\\s\\u00A0] 夾在粗體正規式裡');
  });
});
