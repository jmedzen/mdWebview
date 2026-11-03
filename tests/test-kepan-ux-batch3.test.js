/**
 * @file tests/test-kepan-ux-batch3.test.js
 *
 * 科判閱讀模式審計第三批（v4.27.9）：
 *   B4 第一次讀到某部科判系列時從「檔案」換到「科判」分頁；B5 觸控放大＋／−；B6 樹頂一次性操作提示；
 *   B7「另講」改「其他講次」、樹上標出有對照的科；B8 顯示時拿掉「(分N科)」；
 *   C1 拿掉側欄重複的「科判」標題；C2 開檔後第一次定位不跳「已進入」；C3 進度提示；
 *   C4 鍵盤 [ ] 前後科；C5 搜尋結果層數改小字放後面。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const UI = require('../kepan-sidebar.js');
const ROOT = path.join(__dirname, '..');
const JS = fs.readFileSync(path.join(ROOT, 'kepan-sidebar.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');

describe('B8：顯示用科名', () => {
  test('拿掉科數註記，其他括號保留', () => {
    assert.equal(UI.shortTitle('正宗分(分四科)'), '正宗分');
    assert.equal(UI.shortTitle('隨問別答(分六科)(略八住處.廣十八)'), '隨問別答(略八住處.廣十八)');
    assert.equal(UI.shortTitle('欲住處（分二科）'), '欲住處');
    assert.equal(UI.shortTitle('攝住處(一發心住)'), '攝住處(一發心住)');
    assert.equal(UI.shortTitle('(分二科)'), '(分二科)', '整個科名只有註記時保留原文');
  });

  test('前後科膠囊用短科名', () => {
    assert.equal(UI.navLabel({ m: '甲一', t: '正宗分(分四科)' }, 'x'), '甲一 正宗分');
  });

  test('樹、路徑、選單、搜尋都用 shortTitle；滑過提示保留原文', () => {
    assert.match(JS, /<span class="kepan-title">\$\{esc\(shortTitle\(n\.t\)\)\}/);
    assert.match(JS, /\$\{esc\(n\.m\)\} \$\{esc\(shortTitle\(n\.t\)\)\}\$\{pos\}/);
    assert.match(JS, /title="\$\{esc\(n\.m \+ '、' \+ n\.t\)\}"/);
  });
});

describe('其餘項目：接線', () => {
  test('B4：第一次讀某部科判系列自動換到科判分頁（只從檔案分頁換）', () => {
    assert.match(JS, /active\.dataset\.tab === 'files' && S\.dir && !seenBook\(S\.dir\)\) kTab\.click\(\)/);
    assert.match(JS, /markSeen\(S\.dir\)/);
  });

  test('B5：觸控放大＋／−可按範圍', () => {
    assert.match(CSS, /\.kepan-toggle::after \{ content: ''; position: absolute; inset:/);
  });

  test('B6：樹頂一次性提示，可關掉並記住', () => {
    assert.match(HTML, /id="kepanHint"[^>]*hidden/);
    assert.match(JS, /HINT_STORE = 'mdw-kepan-hint-done'/);
    assert.match(JS, /雙擊/);
  });

  test('B7：「另講」改「其他講次」，樹上有對照的科加小點', () => {
    assert.doesNotMatch(JS, />另講`/);
    assert.match(JS, /其他講次：/);
    assert.match(JS, /kepan-alt-dot/);
    assert.match(CSS, /\.kepan-alt-dot \{/);
  });

  test('C1：科判分頁不再有重複的「科判」標題', () => {
    const panel = HTML.slice(HTML.indexOf('id="panelKepan"'), HTML.indexOf('id="kepanTree"'));
    assert.doesNotMatch(panel, /<h3>科判<\/h3>/);
  });

  test('C2：開檔後的第一次定位不提示「已進入」', () => {
    assert.match(JS, /announce && id && Date\.now\(\) > \(S\.quietUntil \|\| 0\)/);
    assert.match(JS, /S\.quietUntil = Date\.now\(\) \+ 2500/);
  });

  test('C4：鍵盤 [ ] 前後科，輸入框內不攔', () => {
    assert.match(JS, /e\.key !== '\[' && e\.key !== '\]'/);
    assert.match(JS, /INPUT\|TEXTAREA\|SELECT/);
  });

  test('C5：搜尋結果層數改小字', () => {
    assert.match(JS, /<small class="kepan-hit-level">第 \$\{n\.d \+ 1\} 層<\/small>/);
  });
});
