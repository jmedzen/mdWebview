const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const appJs = fs.readFileSync(path.join(ROOT_DIR, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT_DIR, 'style.css'), 'utf8');

function popupSource() {
  const start = appJs.indexOf('function setupSelectionPopup()');
  const end = appJs.indexOf('function getSelectionLineNumber(');
  assert.ok(start > 0 && end > start, '找不到 setupSelectionPopup()');
  return appJs.slice(start, end);
}

describe('選字彈窗支援觸控（手機長按選字、拖曳把手）', () => {
  const src = popupSource();

  test('1. 監聽 selectionchange（去抖）與 touchend，並保留 mouseup', () => {
    assert.match(src, /addEventListener\('selectionchange'/);
    assert.match(src, /addEventListener\('touchend'/);
    assert.match(src, /addEventListener\('mouseup'/);
    assert.match(src, /scheduleSelectionCheck\(SELECTION_CHANGE_DELAY\)/);
    assert.match(src, /clearTimeout\(selectionTimer\)/, '三個觸發來源共用同一個計時器');
  });

  test('2. 滑鼠拖曳中不由 selectionchange 觸發，選取清空時立即隱藏', () => {
    assert.match(src, /if \(mouseSelecting\) return;/);
    assert.match(src, /selection\.isCollapsed/);
  });

  test('3. 觸控時彈窗放在選取下方以避開系統選單，邊界用 visualViewport', () => {
    assert.match(src, /if \(lastInputWasTouch\)/);
    assert.match(src, /lastRect\.bottom \+ HANDLE_GAP/);
    assert.match(src, /window\.visualViewport/);
  });

  test('4. 點彈窗時暫緩隱藏，彈窗本身不可選字', () => {
    assert.match(src, /popup\.addEventListener\('touchstart'/);
    assert.match(src, /popupTouchGuardUntil/);
    assert.match(css, /\.selection-share-popup\s*\{[^}]*user-select:\s*none/);
    assert.match(css, /\.selection-share-popup\s*\{[^}]*-webkit-touch-callout:\s*none/);
    assert.match(css, /\.selection-share-popup\.touch button\s*\{[^}]*min-height:\s*40px/);
  });
});

describe('選字彈窗 v4.10.0：兩排圖示、更多選單、新動作', () => {
  const src = popupSource();

  test('1. 主列：劃線色點＋複製、辭典、搜尋、分享、更多', () => {
    for (const id of ['selectionCopyBtn', 'selectionDictBtn', 'selectionSearchBtn', 'selectionShareBtn', 'selectionMoreBtn']) {
      assert.match(src, new RegExp(`id="${id}"`), id);
    }
    assert.match(src, /class="sel-hl-label"[^>]*>劃線</);
    assert.match(css, /\.selection-share-popup button\s*\{[^}]*flex-direction:\s*column/, '桌機按鈕上圖示下文字');
  });

  test('2. 更多：附出處複製、在本篇中尋找（與 Cmd+F 共用頁內搜尋）', () => {
    for (const id of ['selectionCiteBtn', 'selectionFindBtn']) {
      assert.match(src, new RegExp(`id="${id}"`), id);
    }
    assert.match(src, /openPageSearch\(\);[\s\S]{0,120}doPageSearch\(q\)/);
  });

  test('3. 附出處格式含經名、行號與連結；分享直接複製帶行號的連結，不呼叫系統分享', () => {
    assert.match(src, /——\$\{name\}\$\{currentLineNum \? `第 \$\{currentLineNum\} 行` : ''\}/);
    assert.doesNotMatch(src, /navigator\.share/, '分享不叫系統分享面板');
    assert.match(src, /shareBtn\.addEventListener\('click'[\s\S]{0,900}writeClipboard\(rawUrl, `✓ 已複製第 \$\{shareLineNum\} 行分享連結`\)/);
    assert.doesNotMatch(src, /selectionLinkBtn/, '「複製本行連結」已併入分享');
  });

  test('4. 點彈窗內按鈕不重新計算選取，避免「更多」被收起', () => {
    assert.match(src, /addEventListener\('mouseup', \(e\) => \{[\s\S]{0,200}if \(popup\.contains\(e\.target\)\) return;/);
    assert.match(src, /const hidePopup = \(\) => \{\s*popup\.classList\.remove\('visible'\);\s*setMoreOpen\(false\);/);
  });
});
