/**
 * @file tests/test-a11y-baseline.test.js
 *
 * 可及性基線（alpha 批次 1b）。
 *
 * 這個站台的閱讀體驗做得比多數同類網站細，但鍵盤與螢幕閱讀器的路徑一直缺了
 * 幾塊基礎設施。這支測試守住的都是「一旦拿掉就會默默變壞」的東西：
 *
 *   1. skip-link：頁首十幾個按鈕＋整棵檔案樹，沒有它就是每次換頁都要 Tab 一輪。
 *   2. .sr-only：給螢幕閱讀器的文字工具類別。
 *   3. 每個 .modal-overlay 都要有 role="dialog" + aria-modal + aria-labelledby。
 *   4. 焦點鎖：Tab 不能跑到背景；關閉後焦點要回到看得見的地方（不能是 body）。
 *   5. prefers-reduced-motion 要蓋到全站動畫，不只零星幾個選擇器。
 *
 * 這裡只做「原始碼層級」的斷言（不需要瀏覽器），行為面的驗證用
 * tests/test-modal-focus-behaviour 的說明對照（見檔案末的註解）。
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const INDEX_HTML = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
const APP_JS = fs.readFileSync(path.join(ROOT_DIR, 'app.js'), 'utf8');
const STYLE_CSS = fs.readFileSync(path.join(ROOT_DIR, 'style.css'), 'utf8');

/** 取出 <main> 的開標籤字串（用來檢查 tabindex）。 */
function mainTag() {
  const m = INDEX_HTML.match(/<main[^>]*id="content"[^>]*>/);
  return m ? m[0] : '';
}

describe('skip-link：鍵盤使用者的第一道門', () => {
  test('index.html 在 <body> 之後立刻提供 skip-link', () => {
    // 檔頭 §BODY 的段落索引註解裡也寫了 "<body>" 字樣，所以不能直接用
    // indexOf('<body>')：那會命中註解，切出來的區間等於整個檔案。
    const headEnd = INDEX_HTML.indexOf('</head>');
    assert.ok(headEnd > 0, 'index.html 應有 </head>');
    const bodyIdx = INDEX_HTML.indexOf('<body', headEnd);
    const skipIdx = INDEX_HTML.indexOf('class="skip-link"');
    assert.ok(bodyIdx > headEnd, '</head> 之後應有 <body>');
    assert.ok(skipIdx > bodyIdx, 'skip-link 應位於 <body> 內');
    // 必須是 body 之後的第一個元素，Tab 第一次才會停在它上面。
    // 先去掉註解：skip-link 上方有一段說明文字，裡面也會提到 <main> 等標籤。
    const between = INDEX_HTML.slice(bodyIdx, skipIdx).replace(/<!--[\s\S]*?-->/g, '');
    const otherElements = between.match(/<(?!\/|!--)[a-zA-Z][^>]*>/g) || [];
    // 允許 <body> 自身的開標籤；其餘元素都不該出現在 skip-link 之前
    const blockers = otherElements.filter(t => !/^<body/.test(t));
    assert.equal(
      blockers.length,
      0,
      `skip-link 之前不應有其他元素，否則 Tab 會先停在別的地方：${blockers.slice(0, 3).join(' ')}`
    );
  });

  test('skip-link 指向 #content，且 <main> 有 tabindex="-1" 才收得到焦點', () => {
    assert.match(INDEX_HTML, /class="skip-link"\s+href="#content"/,
      'skip-link 應指向 #content');
    const tag = mainTag();
    assert.ok(tag, '應有 <main id="content">');
    assert.match(tag, /tabindex="-1"/,
      '<main> 需要 tabindex="-1"，否則錨點跳過去後焦點不會轉移，鍵盤使用者還是從頁首繼續 Tab');
  });

  test('skip-link 平時不可見、聚焦時才出現（用 clip，不是 display:none）', () => {
    const block = STYLE_CSS.match(/\.skip-link\s*\{([^}]*)\}/);
    assert.ok(block, 'style.css 應有 .skip-link 樣式');
    const body = block[1];
    assert.match(body, /clip:\s*rect\(0 0 0 0\)|clip-path:\s*inset\(50%\)/,
      '應該用 clip / clip-path 隱藏');
    assert.doesNotMatch(body, /display:\s*none/,
      '不可用 display:none：那會讓元素無法被聚焦，skip-link 就完全失效');
    assert.doesNotMatch(body, /visibility:\s*hidden/,
      '不可用 visibility:hidden：同樣無法聚焦');
    // 聚焦時要恢復尺寸
    const focusBlock = STYLE_CSS.match(/\.skip-link:focus[^{]*\{([^}]*)\}/);
    assert.ok(focusBlock, '應有 .skip-link:focus 樣式');
    assert.match(focusBlock[1], /clip:\s*auto|clip-path:\s*none/, '聚焦時應解除裁切');
  });

  test('skip-link 的 accent 底色配主題前景（不是寫死白字）', () => {
    const block = STYLE_CSS.match(/\.skip-link\s*\{([^}]*)\}/);
    assert.match(block[1], /background:\s*var\(--accent\)/);
    assert.match(block[1], /color:\s*var\(--bg-primary\)/,
      '深色主題的 accent 是淡紫／淡黃，配白色會看不清');
  });
});

describe('.sr-only：螢幕閱讀器專用文字', () => {
  test('style.css 定義 .sr-only，且不是用 display:none', () => {
    const block = STYLE_CSS.match(/\.sr-only\s*\{([^}]*)\}/);
    assert.ok(block, 'style.css 應有 .sr-only');
    const body = block[1];
    assert.match(body, /clip-path:\s*inset\(50%\)|clip:\s*rect/);
    assert.doesNotMatch(body, /display:\s*none/,
      '.sr-only 用 display:none 的話螢幕閱讀器也讀不到，失去意義');
  });
});

describe('對話框語意：role / aria-modal / aria-labelledby', () => {
  /** 抓出所有 modal overlay 的開標籤（含跨行的屬性）。 */
  const overlays = (() => {
    const out = [];
    const re = /<div[^>]*class="[^"]*(?:modal-overlay|media-lightbox-overlay)[^"]*"[^>]*>/g;
    for (const m of INDEX_HTML.matchAll(re)) {
      const tag = m[0];
      const id = (tag.match(/id="([^"]+)"/) || [])[1] || '(no-id)';
      out.push({ id, tag });
    }
    return out;
  })();

  test('至少找得到 8 個 overlay（避免選擇器失效導致測試空過）', () => {
    assert.ok(overlays.length >= 8, `只找到 ${overlays.length} 個 overlay，選擇器可能已失效`);
  });

  test('每個 overlay 都有 role="dialog"', () => {
    const bad = overlays.filter(o => !/role="dialog"/.test(o.tag)).map(o => o.id);
    assert.deepEqual(bad, [], `這些 overlay 缺 role="dialog"：${bad.join(', ')}`);
  });

  test('每個 overlay 都有 aria-modal="true"', () => {
    const bad = overlays.filter(o => !/aria-modal="true"/.test(o.tag)).map(o => o.id);
    assert.deepEqual(bad, [], `這些 overlay 缺 aria-modal="true"：${bad.join(', ')}`);
  });

  test('每個 overlay 都有 aria-labelledby 或 aria-label', () => {
    const bad = overlays
      .filter(o => !/aria-labelledby="[^"]+"/.test(o.tag) && !/aria-label="[^"]+"/.test(o.tag))
      .map(o => o.id);
    assert.deepEqual(bad, [], `這些 overlay 沒有可讀名稱：${bad.join(', ')}`);
  });

  test('aria-labelledby 指向的 id 真的存在', () => {
    for (const o of overlays) {
      const m = o.tag.match(/aria-labelledby="([^"]+)"/);
      if (!m) continue;
      for (const id of m[1].split(/\s+/)) {
        assert.ok(
          INDEX_HTML.includes(`id="${id}"`),
          `${o.id} 的 aria-labelledby 指向不存在的 id="${id}"`
        );
      }
    }
  });
});

describe('焦點管理：焦點鎖與焦點還原', () => {
  test('app.js 提供共用的 trapFocusWithin，且只攔 Tab', () => {
    assert.match(APP_JS, /function trapFocusWithin\(/, '應有 trapFocusWithin');
    const fn = APP_JS.match(/function trapFocusWithin\(container\)\s*\{([\s\S]*?)\n  \}/);
    assert.ok(fn, 'trapFocusWithin 應可辨識');
    const body = fn[1];
    assert.match(body, /e\.key !== 'Tab'/, '只應攔截 Tab，其餘按鍵交給各自的處理');
    assert.match(body, /shiftKey/, 'Shift+Tab 要反向循環');
  });

  test('開啟對話框會上鎖、關閉會解鎖', () => {
    assert.match(APP_JS, /function activateModalFocus\(/, '應有 activateModalFocus');
    assert.match(APP_JS, /function deactivateModalFocus\(/, '應有 deactivateModalFocus');
    // activate 內要呼叫 trapFocusWithin；deactivate 內要解掉
    const act = APP_JS.match(/function activateModalFocus\([\s\S]*?\n  \}/)[0];
    assert.match(act, /trapFocusWithin\(overlay\)/);
    const deact = APP_JS.match(/function deactivateModalFocus\([\s\S]*?\n  \}/)[0];
    assert.match(deact, /_mdwTrap/, 'deactivate 應釋放焦點鎖');
  });

  test('焦點還原會排除「看不見」的目標（尺寸為 0 的元素 focus() 會無聲失敗）', () => {
    const fn = APP_JS.match(/function restoreFocusFor\([\s\S]*?\n  \}/)[0];
    assert.match(fn, /getClientRects\(\)\.length/, '應檢查目標是否真的可見');
    assert.match(fn, /userMenuBtn/, '看不到目標時應退回開啟選單的頭像按鈕');
  });

  test('設定、後台、分享卡、帳號、燈箱、安裝教學都接上了焦點管理', () => {
    // 這些是使用者最常開的對話框；逐一確認開／關都有呼叫。
    const cases = [
      ['使用者偏好設定', /activateModalFocus\(\$\('userSettingsOverlay'\)\)/],
      ['後台系統設定', /activateModalFocus\(\$\('adminSettingsOverlay'\)\)/],
      ['管理員首次設定', /activateModalFocus\(\$\('adminSetupOverlay'\)/],
      ['安裝教學', /activateModalFocus\(overlay, done \|\| null\)/],
      ['媒體燈箱', /activateModalFocus\(overlay, \$\('mediaLightboxCloseBtn'\)\)/],
      ['分享卡', /activateModalFocus\(ov, card\)/],
      ['帳號相關（共用 openOverlay）', /function openOverlay\(id\)[\s\S]{0,300}activateModalFocus\(el\)/]
    ];
    for (const [name, re] of cases) {
      assert.match(APP_JS, re, `${name} 的開啟流程應呼叫 activateModalFocus`);
    }
    // 關閉端
    assert.match(APP_JS, /function closeUserSettingsModal\([\s\S]{0,300}deactivateModalFocus\(overlay\)/);
    assert.match(APP_JS, /function closeAdminModal\([\s\S]{0,600}deactivateModalFocus\(overlay\)/);
    assert.match(APP_JS, /function closeOverlay\([\s\S]{0,400}deactivateModalFocus\(el\)/);
    assert.match(APP_JS, /function closeMediaLightbox\([\s\S]{0,900}deactivateModalFocus\(overlay\)/);
    assert.match(APP_JS, /function closeInstallGuide\([\s\S]{0,400}deactivateModalFocus\(overlay\)/);
  });

  test('書籤抽屜改用共用工具，不再自己寫一份只找 button/input 的迴圈', () => {
    assert.match(APP_JS, /trapFocusWithin\(drawer\)/);
    assert.doesNotMatch(
      APP_JS,
      /querySelectorAll\('button, input'\)\s*\)\.filter\(el => !el\.hidden/,
      '舊的抽屜專用迴圈應已移除（它漏掉連結與 tabindex 元素）'
    );
  });

  test('userMenuAction 會記下觸發列，供對話框關閉後還原焦點', () => {
    assert.match(APP_JS, /_pendingReturnFocus\s*=\s*e\.currentTarget/);
  });
});

describe('prefers-reduced-motion：全站動畫都要能被關掉', () => {
  test('style.css 有一段蓋掉所有元素的總表', () => {
    // 找 `*, *::before, *::after` 的 reduce 區塊
    const blocks = [...STYLE_CSS.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/g)]
      .map(m => m[1]);
    assert.ok(blocks.length > 0, '應有 reduce 區塊');
    const hasGlobal = blocks.some(b =>
      /\*\s*,\s*\n?\s*\*::before/.test(b) &&
      /animation-duration:\s*0\.01ms\s*!important/.test(b) &&
      /transition-duration:\s*0\.01ms\s*!important/.test(b)
    );
    assert.ok(hasGlobal, '應有一段「所有元素」的 animation/transition 降級總表');
  });

  test('總表也把 scroll-behavior 設回 auto', () => {
    const blocks = [...STYLE_CSS.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/g)]
      .map(m => m[1]);
    assert.ok(
      blocks.some(b => /scroll-behavior:\s*auto\s*!important/.test(b)),
      '平滑捲動對前庭敏感者也是不適來源'
    );
  });

  test('原本零星的 reduce 區塊仍保留（不因總表而退化）', () => {
    // 至少要有 5 段（原本 6 段，加上總表）；只留總表代表有人刪掉了精確規則
    const count = (STYLE_CSS.match(/prefers-reduced-motion:\s*reduce/g) || []).length;
    assert.ok(count >= 6, `reduce 區塊只剩 ${count} 段，原有的精確規則可能被誤刪`);
  });
});
