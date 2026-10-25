const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT_DIR, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT_DIR, 'style.css'), 'utf8');

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `app.js 應定義 ${name}()`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`無法擷取 ${name}()`);
}

describe('閱讀框麵包屑 — 點擊在檔案樹中定位並閃爍', () => {
  const header = extractFunction(app, 'renderContentHeader');
  const reveal = extractFunction(app, 'revealInFileTree');

  test('每一層 parent 與檔名都渲染成可點擊、可鍵盤操作的區段', () => {
    assert.match(header, /parts\.slice\(0, i \+ 1\)\.join\('\/'\)/, '每層資料夾應帶累積路徑');
    assert.match(header, /crumbs\.push\(\{ name: fileName, path: displayPath \}\)/);
    assert.match(header, /class="file-path-seg file-path-link" role="button" tabindex="0" data-reveal-path=/);
    assert.match(header, /e\.key === 'Enter' \|\| e\.key === ' '/);
  });

  test('辭典檔不在主樹內，麵包屑不可點擊', () => {
    assert.match(header, /isDict\s*\n?\s*\? `<span class="file-path-seg">/);
  });

  test('定位前先展開側欄並切到檔案瀏覽器分頁', () => {
    assert.match(reveal, /sidebar\.classList\.remove\('collapsed'\)/);
    assert.match(reveal, /\.sidebar-tab\[data-tab="files"\]/);
  });

  test('展開所有上層資料夾，資料夾本身也展開', () => {
    assert.match(reveal, /expandTreeAncestors\(row\)/);
    assert.match(reveal, /childrenEl\.classList\.add\('expanded'\)/);
  });

  test('卷動到中央並重新觸發閃爍動畫', () => {
    assert.match(reveal, /scrollIntoView\(\{ block: 'center'/);
    assert.match(reveal, /classList\.remove\('tree-reveal-flash'\)[\s\S]*offsetWidth[\s\S]*classList\.add\('tree-reveal-flash'\)/);
    assert.match(reveal, /animationend/);
  });

  test('CSS 定義閃爍動畫與可點擊樣式', () => {
    assert.match(css, /@keyframes tree-reveal-flash/);
    assert.match(css, /\.tree-item-row\.tree-reveal-flash\s*\{\s*animation: tree-reveal-flash/);
    assert.match(css, /\.content-header \.file-path-link\s*\{[^}]*cursor: pointer/);
  });
});
