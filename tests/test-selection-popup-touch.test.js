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
