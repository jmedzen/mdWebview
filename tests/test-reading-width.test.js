const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const appJs = fs.readFileSync(path.join(ROOT_DIR, 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
const styleCss = fs.readFileSync(path.join(ROOT_DIR, 'style.css'), 'utf8');

// 從 app.js 取出桌面寬度相關的常數與函式，獨立執行
function loadWidthHelpers() {
  const start = appJs.indexOf('const DESKTOP_WIDTH_PAD_PX');
  const endMarker = 'function desktopMaxWidthCss(id) {';
  const endStart = appJs.indexOf(endMarker);
  assert.ok(start > 0 && endStart > start, '找不到 DESKTOP_WIDTH_* 區段');
  const end = appJs.indexOf('\n  }\n', endStart) + 4;
  const src = appJs.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function(`${src}\nreturn { DESKTOP_WIDTH_PRESETS, DESKTOP_WIDTH_DEFAULT, normalizeDesktopMaxWidth, desktopMaxWidthCss };`)();
}

describe('桌面閱讀寬度：每行字數段位', () => {
  const h = loadWidthHelpers();

  test('五個段位：窄 32、標準 40（預設）、寬 50、特寬 64、全寬', () => {
    assert.deepEqual(h.DESKTOP_WIDTH_PRESETS.map(p => [p.id, p.chars, p.label]), [
      ['cpl32', 32, '窄'], ['cpl40', 40, '標準'], ['cpl50', 50, '寬'], ['cpl64', 64, '特寬'], ['full', 0, '全寬']
    ]);
    assert.equal(h.DESKTOP_WIDTH_DEFAULT, 'cpl40');
  });

  test('舊版 px／百分比值轉成最接近的段位', () => {
    assert.equal(h.normalizeDesktopMaxWidth('680px'), 'cpl32');
    assert.equal(h.normalizeDesktopMaxWidth('800px'), 'cpl40');
    assert.equal(h.normalizeDesktopMaxWidth('1000px'), 'cpl50');
    assert.equal(h.normalizeDesktopMaxWidth('100%'), 'full');
    assert.equal(h.normalizeDesktopMaxWidth('1200px'), 'cpl64');
    assert.equal(h.normalizeDesktopMaxWidth('95%'), 'cpl40');
    assert.equal(h.normalizeDesktopMaxWidth(null), 'cpl40');
    assert.equal(h.normalizeDesktopMaxWidth('garbage'), 'cpl40');
    assert.equal(h.normalizeDesktopMaxWidth('cpl64'), 'cpl64');
  });

  test('寬度隨字級：字數 × --content-font-size + 96px', () => {
    assert.equal(h.desktopMaxWidthCss('cpl40'), 'calc(var(--content-font-size, 16px) * 40 + 96px)');
    assert.equal(h.desktopMaxWidthCss('full'), '100%');
    assert.equal(h.desktopMaxWidthCss('unknown'), h.desktopMaxWidthCss('cpl40'));
  });

  test('桌面另存 MAX_WIDTH_DESKTOP，手機仍用原本的 MAX_WIDTH 與百分比選項', () => {
    assert.match(appJs, /MAX_WIDTH_DESKTOP:\s*'mdWebview-user-maxwidth-desktop'/);
    assert.match(appJs, /storage\.set\(STORAGE_KEYS\.MAX_WIDTH_DESKTOP, id\)/);
    for (const v of ['85%', '90%', '95%', '100%']) {
      assert.ok(appJs.includes(`value: '${v}'`), `手機選項 ${v} 必須保留`);
    }
    assert.match(styleCss, /@media \(max-width: 768px\) \{\s*:root, html \{\s*--content-max-width: 95%;/);
  });

  test('index.html 靜態按鈕與 CSS 預設值為新段位', () => {
    for (const id of ['cpl32', 'cpl40', 'cpl50', 'cpl64', 'full']) {
      assert.ok(indexHtml.includes(`data-value="${id}"`), `缺少 ${id} 按鈕`);
    }
    assert.match(styleCss, /--content-max-width: calc\(var\(--content-font-size, 16px\) \* 40 \+ 96px\);/);
  });
});
