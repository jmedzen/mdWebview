const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const appJs = fs.readFileSync(path.join(ROOT_DIR, 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
const styleCss = fs.readFileSync(path.join(ROOT_DIR, 'style.css'), 'utf8');

/**
 * 取出 app.js 裡某個函式的完整原始碼（以大括號配對到結尾）。
 *
 * 之所以需要它：安裝引導的行為大多綁在瀏覽器事件與 DOM 上，無法在 Node
 * 裡直接執行。但「哪些判斷被寫出來」是可以靜態驗證的契約，而這些契約
 * 一旦被後續修改悄悄破壞，症狀（引導不再出現、或對已安裝者再三騷擾）
 * 在人工測試時極難察覺。
 */
function extractFunction(source, name) {
  const startIdx = source.indexOf(`function ${name}(`);
  if (startIdx === -1) return '';
  const braceStart = source.indexOf('{', startIdx);
  if (braceStart === -1) return '';
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(startIdx, i + 1);
    }
  }
  return '';
}

describe('PWA 安裝引導 (Install Prompt)', () => {
  describe('HTML 結構', () => {
    test('首頁應有安裝卡片，且預設隱藏', () => {
      assert.match(indexHtml, /id="installCard"/, 'index.html 應包含安裝卡片 #installCard');
      // 預設必須是 hidden，否則會在 JS 判斷之前閃現給第一次造訪的人。
      const cardTag = indexHtml.match(/<div[^>]*id="installCard"[^>]*>/);
      assert.ok(cardTag, '應能找到 #installCard 元素');
      assert.match(cardTag[0], /\bhidden\b/, '安裝卡片預設必須帶 hidden 屬性');
    });

    test('安裝卡片應有接受與婉拒兩顆按鈕', () => {
      assert.match(indexHtml, /id="installCardAccept"/, '應有「加到桌面」按鈕');
      assert.match(indexHtml, /id="installCardLater"/, '應有「以後再說」按鈕');
    });

    test('應有 iOS 圖文教學 Modal', () => {
      assert.match(indexHtml, /id="installGuideOverlay"/, '應有 iOS 安裝教學 Modal');
      assert.match(indexHtml, /id="installGuideDoneBtn"/, '教學 Modal 應有完成按鈕');
    });

    test('iOS 教學應有三個步驟', () => {
      const steps = indexHtml.match(/class="install-guide-step"/g) || [];
      assert.equal(steps.length, 3, `iOS 教學應為三步，實際 ${steps.length} 步`);
    });

    test('iOS 教學的示意圖必須是 inline SVG，不可依賴外部圖檔', () => {
      // 教學內容最需要在離線時顯示，而外部圖檔正是離線最容易缺失的部分。
      const guideStart = indexHtml.indexOf('id="installGuideOverlay"');
      const guideEnd = indexHtml.indexOf('id="announcementModalOverlay"');
      assert.ok(guideStart > 0 && guideEnd > guideStart, '應能界定教學 Modal 的範圍');
      const guideHtml = indexHtml.slice(guideStart, guideEnd);
      const svgCount = (guideHtml.match(/<svg/g) || []).length;
      assert.ok(svgCount >= 3, `教學示意圖應為 inline SVG（至少 3 個），實際 ${svgCount} 個`);
      assert.doesNotMatch(guideHtml, /<img[^>]+src=/, '教學區塊不應使用外部 <img> 圖檔');
    });

    test('設定頁應有常駐安裝入口', () => {
      assert.match(indexHtml, /id="installSettingsSection"/, '設定頁應有安裝區塊');
      assert.match(indexHtml, /id="btnInstallPwa"/, '設定頁應有安裝按鈕');
      // 常駐入口預設隱藏，由 JS 依能力與安裝狀態決定是否顯示。
      const sectionTag = indexHtml.match(/<div[^>]*id="installSettingsSection"[^>]*>/);
      assert.ok(sectionTag, '應能找到 #installSettingsSection');
      assert.match(sectionTag[0], /display:\s*none/, '設定頁安裝區塊預設應隱藏');
    });

    test('文案不得出現技術術語', () => {
      // 目標讀者不懂「PWA」「Service Worker」，出現這些詞只會讓人放棄。
      const start = indexHtml.indexOf('id="installCard"');
      const end = indexHtml.indexOf('id="installGuideOverlay"');
      const userFacing = indexHtml.slice(start, end);
      assert.doesNotMatch(userFacing, /PWA/);
      assert.doesNotMatch(userFacing, /Service\s*Worker/i);
      assert.doesNotMatch(userFacing, /離線快取/);
    });
  });

  describe('時機判斷邏輯', () => {
    test('應以「讀過 2 篇」或「有續讀紀錄」判定投入程度', () => {
      const fn = extractFunction(appJs, 'shouldOfferInstall');
      assert.ok(fn, '應存在 shouldOfferInstall 函式');
      assert.match(fn, /recentFiles/, '應以最近開啟紀錄判斷');
      assert.match(fn, /LAST_READ_PROGRESS/, '應以續讀紀錄判斷');
      assert.match(fn, /canOfferInstall/, '應先確認瀏覽器具備安裝能力');
    });

    test('必須有 3 天靜默期，避免被拒絕後反覆騷擾', () => {
      const fn = extractFunction(appJs, 'isInstallSnoozed');
      assert.ok(fn, '應存在 isInstallSnoozed 函式');
      assert.match(
        fn, /INSTALL_SNOOZE_DAYS\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/,
        '靜默期應以 INSTALL_SNOOZE_DAYS 常數計算，避免天數散落多處失去同步'
      );
      assert.match(fn, /INSTALL_DISMISSED/, '靜默期應讀取 INSTALL_DISMISSED 時間戳');
    });

    test('靜默期常數應為 3 天', () => {
      // 天數是產品決策，集中在一處宣告，測試直接鎖住數值本身，
      // 任何調整都會被看見，不會悄悄生效。
      assert.match(
        appJs, /const\s+INSTALL_SNOOZE_DAYS\s*=\s*3\s*;/,
        'INSTALL_SNOOZE_DAYS 應為 3'
      );
    });

    test('已安裝者不得再看到任何引導', () => {
      const fn = extractFunction(appJs, 'canOfferInstall');
      assert.ok(fn, '應存在 canOfferInstall 函式');
      assert.match(fn, /isStandaloneMode/, '應排除 standalone 模式');
      assert.match(fn, /INSTALL_INSTALLED/, '應排除已記錄安裝的狀態');
    });

    test('「以後再說」必須寫入靜默期時間戳', () => {
      const fn = extractFunction(appJs, 'setupInstallPrompt');
      assert.ok(fn, '應存在 setupInstallPrompt 函式');
      assert.match(fn, /installCardLater/, '應綁定「以後再說」按鈕');
      assert.match(fn, /INSTALL_DISMISSED/, '按下後應寫入靜默期時間戳');
    });
  });

  describe('平台差異處理', () => {
    test('iPadOS 需以多點觸控判定，不能只靠 UA', () => {
      const fn = extractFunction(appJs, 'isIOSDevice');
      assert.ok(fn, '應存在 isIOSDevice 函式');
      assert.match(fn, /maxTouchPoints/, 'iPadOS 的 UA 偽裝成 macOS，必須用 maxTouchPoints 補判');
    });

    test('standalone 判定需涵蓋 iOS 專屬的 navigator.standalone', () => {
      const fn = extractFunction(appJs, 'isStandaloneMode');
      assert.ok(fn, '應存在 isStandaloneMode 函式');
      assert.match(fn, /display-mode/, '應檢查 display-mode 媒體查詢');
      assert.match(fn, /navigator\.standalone/, 'iOS Safari 不支援 display-mode，需檢查 navigator.standalone');
    });

    test('iOS 走圖文教學，而非呼叫不存在的原生 prompt', () => {
      const fn = extractFunction(appJs, 'triggerInstall');
      assert.ok(fn, '應存在 triggerInstall 函式');
      assert.match(fn, /isIOSDevice/, '應區分 iOS');
      assert.match(fn, /showInstallGuide/, 'iOS 應顯示圖文教學');
    });

    test('非 iOS 但無 prompt 時，必須給予可行動的提示而非靜默失敗', () => {
      const fn = extractFunction(appJs, 'triggerInstall');
      assert.match(fn, /_deferredInstallPrompt/, '應檢查延後的安裝事件');
      // 按鈕按了沒反應是最糟的體驗，必須有 fallback 提示。
      assert.match(fn, /showToast/, '無 prompt 時應顯示提示訊息');
    });
  });

  describe('事件綁定', () => {
    test('必須監聽 beforeinstallprompt 並阻止預設橫幅', () => {
      const fn = extractFunction(appJs, 'setupInstallPrompt');
      assert.match(fn, /beforeinstallprompt/, '應監聽 beforeinstallprompt');
      assert.match(fn, /preventDefault/, '應 preventDefault 以避免與自製引導衝突');
    });

    test('必須監聽 appinstalled 以記錄安裝完成', () => {
      const fn = extractFunction(appJs, 'setupInstallPrompt');
      assert.match(fn, /appinstalled/, '應監聽 appinstalled');
    });

    test('setupInstallPrompt 必須在 init 中被呼叫', () => {
      // 函式寫了卻沒呼叫是這類功能的典型靜默失敗：程式碼看起來完整，
      // 但引導永遠不會出現。
      const initIdx = appJs.indexOf('function init(');
      assert.ok(initIdx > 0, '應存在 init 函式');
      const initBody = appJs.slice(initIdx, initIdx + 40000);
      const callIdx = initBody.indexOf('setupInstallPrompt()');
      assert.ok(callIdx > 0, 'init() 內必須呼叫 setupInstallPrompt()');
      // 且必須在 init 結束前呼叫（init 以 setupInstallPrompt 之後的 } 收束）。
      const beforeReturn = initBody.slice(0, initBody.indexOf('\n  }\n'));
      assert.ok(
        beforeReturn.includes('setupInstallPrompt()'),
        'setupInstallPrompt() 必須在 init() 函式體內呼叫'
      );
    });

    test('回首頁時應重新評估是否顯示引導', () => {
      // 使用者可能在閱讀過程中跨過門檻，回到首頁時才適合談安裝。
      const fn = extractFunction(appJs, 'goHome');
      assert.ok(fn, '應存在 goHome 函式');
      assert.match(fn, /maybeShowInstallCard/, 'goHome 應重新評估安裝卡片');
    });
  });

  describe('樣式', () => {
    test('hidden 屬性必須能覆蓋 display:flex', () => {
      // .install-card 用了 display:flex，而 hidden 屬性的預設樣式優先權較低，
      // 若不明確覆蓋，卡片會無視 JS 判斷而永遠顯示。
      assert.match(
        styleCss,
        /\.install-card\[hidden\]\s*\{[^}]*display:\s*none\s*!important/,
        '必須以 .install-card[hidden] { display: none !important } 覆蓋 flex'
      );
    });

    test('字級應跟隨 --ui-font-scale，維持無障礙一致性', () => {
      const blocks = styleCss.match(/\.install-card[^{]*\{[^}]*\}/g) || [];
      const guideBlocks = styleCss.match(/\.install-guide[^{]*\{[^}]*\}/g) || [];
      const all = [...blocks, ...guideBlocks].join('\n');
      assert.match(all, /var\(--ui-font-scale/, '安裝引導的字級應乘上 --ui-font-scale');
    });

    test('應尊重 prefers-reduced-motion', () => {
      assert.match(styleCss, /prefers-reduced-motion[^{]*\{[^}]*install-card/, '應為安裝卡片提供 reduced-motion 處理');
    });
  });
});
