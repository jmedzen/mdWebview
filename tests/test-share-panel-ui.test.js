/**
 * 早安圖分享面板的版面：先選底色再看版型、版型位置用「3 / 8」、問候語下拉與 QR 同排、
 * 「傳到 LINE」是主按鈕且動作列固定在底部、換底色讓版型消失時要提示。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const appJs = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const styleCss = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');

describe('分享面板版面', () => {
  test('順序：底色 → 版型輪播 → 位置 → 問候與 QR → 動作', () => {
    const pos = id => indexHtml.indexOf(`id="${id}"`);
    const order = ['shareCardBases', 'shareCardBaseNote', 'shareCardSlides', 'shareCardDots', 'shareCardGreetings', 'shareCardQr', 'shareCardLine'].map(pos);
    assert.ok(order.every(n => n > 0), 'all elements exist');
    assert.deepEqual(order.slice().sort((a, b) => a - b), order, 'DOM order');
  });

  test('問候語是下拉（不是一排藥丸），和 QR 在同一個 options 區塊', () => {
    assert.match(appJs, /sel\.id = 'shareCardGreetingSel'/);
    assert.doesNotMatch(appJs, /share-card-greeting' \+/);
    assert.match(indexHtml, /<div class="share-card-options">\s*<div class="share-card-opt" id="shareCardGreetings">[\s\S]*?id="shareCardQr"/);
    assert.match(appJs, /closest\('input, textarea, select'\)/, '下拉裡按方向鍵不要換版型');
  });

  test('版型位置用「3 / 8」文字，不再畫一排圓點', () => {
    assert.match(appJs, /ctr\.textContent = `\$\{i \+ 1\} \/ \$\{L\.length\}`/);
    assert.doesNotMatch(appJs, /dots\.appendChild/);
  });

  test('底色色票下有說明；換底色讓原版型消失時提示並退回 A', () => {
    assert.match(appJs, /function renderShareBaseNote\(notice\)/);
    assert.match(appJs, /專屬版型：/);
    assert.match(appJs, /已換成「\$\{SCx\.LAYOUT_NAMES\.A\}」/);
    assert.match(appJs, /renderShareBaseNote\(notice\)/);
  });

  test('「傳到 LINE」獨占一排當主按鈕；動作列 sticky 固定在底部', () => {
    assert.match(styleCss, /\.share-card-act-line \{\s*grid-column: 1 \/ -1;/);
    assert.match(styleCss, /\.share-card-actions \{[^}]*position: sticky;[^}]*bottom:/);
    assert.match(styleCss, /\.share-card-actions \{[^}]*grid-template-columns: repeat\(3, 1fr\)/);
  });
});
