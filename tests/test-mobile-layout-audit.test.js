const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');

describe('手機版本排版與 RWD 審計自動化測試 (Mobile Layout & RWD Audit)', () => {
  const cssPath = path.join(ROOT_DIR, 'style.css');
  const cssContent = fs.readFileSync(cssPath, 'utf8');

  test('1. 非全螢幕彈窗防拉伸隔離檢驗 (P0 級)', () => {
    // 驗證全螢幕 stretch 僅限於 #adminSettingsOverlay，不再濫用 :not(.announcement-modal-overlay)
    assert.match(cssContent, /#adminSettingsOverlay\s*\{\s*padding:\s*0\s*!important;\s*align-items:\s*stretch\s*!important;/, '只有 #adminSettingsOverlay 應在手機端滿屏 stretch');
    
    // 驗證 userSettingsOverlay, adminLoginOverlay, setupModalOverlay 具備適當置中與 padding
    assert.match(cssContent, /#userSettingsOverlay,\s*#adminLoginOverlay,\s*#setupModalOverlay\s*\{[^}]*align-items:\s*center\s*!important;/, '使用者設定與登入彈窗應維持置中');
  });

  test('2. Admin UI 雙欄表單在手機端折行單欄化檢驗 (compact-row collapse)', () => {
    // 驗證 compact-row 在移動版轉為 column
    assert.match(cssContent, /\.compact-row\s*\{[^}]*flex-direction:\s*column\s*!important;/, 'compact-row 在手機版必須轉為 column 排列');
    assert.match(cssContent, /\.compact-row\s+\.form-group\.half,\s*\.compact-row\s+\.form-group\.third\s*\{[^}]*width:\s*100%\s*!important;/, '雙欄在手機版必須佔滿 100% 寬度');
  });

  test('3. 使用者設定書籤與近期閱讀清單防擠壓檢驗 (P0 級)', () => {
    // 驗證時間戳 flex-shrink: 0 與 nowrap
    assert.match(cssContent, /\.list-item-time\s*\{[^}]*flex-shrink:\s*0;[^}]*white-space:\s*nowrap;/, '清單時間標籤必須保持 flex-shrink: 0 與 white-space: nowrap');
    // 驗證刪除按鈕具備足夠點擊熱區
    assert.match(cssContent, /\.list-item-del-btn\s*\{[^}]*min-width:\s*28px;[^}]*min-height:\s*28px;/, '刪除按鈕必須具備至少 28px 觸控點擊區域');
  });

  test('4. 系統管理與備份按鈕組在手機端垂直堆疊檢驗', () => {
    assert.match(cssContent, /\.backup-action-buttons,\s*\.admin-action-buttons\s*\{[^}]*flex-direction:\s*column\s*!important;/, '備份與管理按鈕組在手機版必須垂直堆疊');
  });

  test('5. Admin UI 底部動作列按鈕佈局與 SEO 社群預覽卡片自適應檢驗', () => {
    // 驗證 modal-right-actions 在手機端支援 flex-wrap
    assert.match(cssContent, /\.modal-right-actions\s*\{[^}]*flex-wrap:\s*wrap;/, 'modal-right-actions 在手機端必須支援換行');
    // 驗證社群卡片預覽在手機端為 column
    assert.match(cssContent, /\.og-card-inner\s*\{[^}]*flex-direction:\s*column\s*!important;/, '社群卡片在手機端必須轉為垂直排列');
  });

  test('6. 行動端側邊欄 (Sidebar & Dict-Sidebar) 與遮罩層疊 (z-index) 及 iOS 輸入體驗檢驗 (P0 級)', () => {
    // 驗證 sidebar-backdrop 的 z-index 為 85
    assert.match(cssContent, /\.sidebar-backdrop\s*\{[^}]*z-index:\s*85;/s, '遮罩層 z-index 應為 85');

    // 驗證行動端 .dict-sidebar 的 z-index 必須為 90 !important，防止後方一般樣式 (z-index: 10) 覆寫，確保浮於遮罩之上
    assert.match(cssContent, /\.dict-sidebar\s*\{[^}]*z-index:\s*90\s*!important;[^}]*background:\s*var\(--bg-secondary\)\s*!important;/s, '行動端 dict-sidebar 必須有 z-index: 90 !important 與不透明背景');

    // 驗證行動端 .sidebar 的 z-index 必須為 90 !important
    assert.match(cssContent, /\.sidebar\s*\{[^}]*z-index:\s*90\s*!important;/s, '行動端 sidebar 必須有 z-index: 90 !important');

    // 驗證行動端 .dict-search-input 具備 16px !important，防止 iOS Safari 點擊聚焦時自動放大畫面
    assert.match(cssContent, /\.dict-search-input\s*\{[^}]*font-size:\s*16px\s*!important;/s, '行動端字典輸入框必須設為 16px !important 防止 iOS 自動放大');
  });
});

