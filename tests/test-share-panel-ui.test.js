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

describe('分享面板版面（預覽優先）', () => {
  test('順序：版型輪播 → 一排控制（底色、問候、QR）→ 動作；沒有說明文字、位置圓點、底色提示列', () => {
    const pos = id => indexHtml.indexOf(`id="${id}"`);
    const order = ['shareCardSlides', 'shareCardBases', 'shareCardGreetings', 'shareCardQr', 'shareCardLine'].map(pos);
    assert.ok(order.every(n => n > 0), 'all elements exist');
    assert.deepEqual(order.slice().sort((a, b) => a - b), order, 'DOM order');
    for (const gone of ['shareCardHint', 'shareCardDots', 'shareCardBaseNote', 'shareCardBaseLabel']) {
      assert.ok(!indexHtml.includes(`id="${gone}"`), `${gone} removed`);
    }
    assert.match(indexHtml, /<div class="share-card-controls">\s*<div class="share-card-bases"[\s\S]*?id="shareCardGreetings"[\s\S]*?id="shareCardQr"/);
  });

  test('問候語是下拉、直接露在外面；下拉裡按方向鍵不會換版型', () => {
    assert.match(appJs, /sel\.id = 'shareCardGreetingSel'/);
    assert.match(appJs, /sel\.setAttribute\('aria-label', '問候語'\)/);
    assert.match(appJs, /closest\('input, textarea, select'\)/);
  });

  test('色票不寫字：名稱與專屬版型在 title／aria-label；換底色讓版型消失時用 toast 提示並退回 A', () => {
    assert.match(appJs, /專屬版型：/);
    assert.doesNotMatch(appJs, /share-card-base-name/);
    assert.match(appJs, /if \(notice\) showToast\(notice, 'info'/);
    assert.match(appJs, /已換成「\$\{SCx\.LAYOUT_NAMES\.A\}」/);
  });

  test('「傳到 LINE」是主按鈕，存圖／複製圖／複製連結是純圖示（有 title 與 aria-label），同一排固定在底部', () => {
    for (const id of ['shareCardSave', 'shareCardCopyImg', 'shareCardCopyLink']) {
      assert.match(indexHtml, new RegExp(`id="${id}" title="[^"]+" aria-label="[^"]+"`));
    }
    assert.match(styleCss, /\.share-card-actions \{[^}]*display: flex;[^}]*position: sticky;[^}]*bottom:/);
    assert.match(styleCss, /\.share-card-act-line \{\s*flex: 1;/);
    assert.match(styleCss, /\.share-card-act:not\(\.share-card-act-line\) \{[^}]*font-size: 0;/);
  });
});
