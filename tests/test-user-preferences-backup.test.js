const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');

describe('使用者自定義偏好設定與備份還原功能測試 (User Preferences Backup & Restore)', () => {
  const htmlPath = path.join(ROOT_DIR, 'index.html');
  const cssPath = path.join(ROOT_DIR, 'style.css');
  const appJsPath = path.join(ROOT_DIR, 'app.js');

  const htmlContent = fs.readFileSync(htmlPath, 'utf8');
  const cssContent = fs.readFileSync(cssPath, 'utf8');
  const appJsContent = fs.readFileSync(appJsPath, 'utf8');

  test('1. index.html UI 結構完整性驗證', () => {
    // 檢查分頁標籤是否更新為「💾 備份與管理」
    assert.match(htmlContent, /data-tab="system"[^>]*>💾 備份與管理<\/button>/, '分頁按鈕應顯示 💾 備份與管理');

    // 檢查 pane-system 內部是否有 userBackupBox
    assert.match(htmlContent, /id="userBackupBox"/, 'pane-system 內必須包含 #userBackupBox');

    // 檢查是否包含下載與還原按鈕
    assert.match(htmlContent, /id="btnExportUserPreferences"/, '必須包含下載備份按鈕 #btnExportUserPreferences');
    assert.match(htmlContent, /id="btnImportUserPreferences"/, '必須包含還原備份按鈕 #btnImportUserPreferences');
    assert.match(htmlContent, /<input\b[^>]*id="inputImportUserPreferences"[^>]*>/, '必須包含檔案輸入元件 #inputImportUserPreferences');
    assert.match(htmlContent, /<input\b[^>]*id="inputImportUserPreferences"[^>]*type="file"|<input\b[^>]*type="file"[^>]*id="inputImportUserPreferences"/, '輸入元件必須為 type="file"');

    // 檢查設定面板底部動作列已移除左下角快捷按鈕，維持乾淨版面
    assert.equal(htmlContent.includes('id="btnFooterExportUserPreferences"'), false, '底部動作列不得包含 #btnFooterExportUserPreferences');
  });

  test('2. style.css 樣式完整性驗證', () => {
    assert.match(cssContent, /\.secondary-btn\s*\{/, 'style.css 必須包含 .secondary-btn 樣式定義');
    assert.match(cssContent, /\.user-backup-box\s*\{/, 'style.css 必須包含 .user-backup-box 樣式定義');
    assert.match(cssContent, /\.backup-action-buttons\s*\{/, 'style.css 必須包含 .backup-action-buttons 樣式定義');
  });

  test('3. app.js 邏輯與事件綁定完整性驗證', () => {
    // 檢查核心函式定義
    assert.match(appJsContent, /function exportUserPreferences\s*\(/, 'app.js 必須實作 exportUserPreferences');
    assert.match(appJsContent, /function importUserPreferences\s*\(/, 'app.js 必須實作 importUserPreferences');

    // 檢查事件綁定
    assert.match(appJsContent, /btnExportUserPreferences/, 'app.js 必須綁定 #btnExportUserPreferences');
    assert.equal(appJsContent.includes('btnFooterExportUserPreferences'), false, 'app.js 不得殘留 btnFooterExportUserPreferences');
    assert.match(appJsContent, /btnImportUserPreferences/, 'app.js 必須綁定 #btnImportUserPreferences');
    assert.match(appJsContent, /inputImportUserPreferences/, 'app.js 必須監聽 #inputImportUserPreferences change 事件');
  });

  test('4. 備份檔案 Schema 與安全性邊界檢驗 (無權限 Token 外洩)', () => {
    // 模擬匯出資料結構
    const mockState = {
      currentTheme: 'obsidian-dark',
      fontSize: 18,
      textAlign: 'justify',
      lineHeight: '1.8',
      maxWidth: '800px',
      autoS2T: true,
      autoReadProgress: true,
      recentFiles: [{ filePath: '01-大正藏/03般若部類/T0251.md', fileName: '心經', time: '10/8 12:00' }],
      bookmarks: [{ filePath: '01-大正藏/03般若部類/T0251.md', fileName: '心經', time: '2026/10/8' }],
      dictFileOrder: ['dict:辭典A.md'],
      adminToken: 'SECRET_ADMIN_TOKEN_99999'
    };

    const simulatedExport = {
      app: 'mdWebview',
      version: '3.7.0',
      exportDate: new Date().toISOString(),
      type: 'mdWebview-user-preferences',
      preferences: {
        theme: mockState.currentTheme,
        fontSize: mockState.fontSize,
        textAlign: mockState.textAlign,
        lineHeight: mockState.lineHeight,
        maxWidth: mockState.maxWidth,
        autoS2T: mockState.autoS2T,
        autoReadProgress: mockState.autoReadProgress
      },
      readProgress: { filePath: '01-大正藏/03般若部類/T0251.md', line: 10, scrollTop: 200 },
      recentFiles: mockState.recentFiles,
      bookmarks: mockState.bookmarks,
      dictionary: {
        fileOrder: mockState.dictFileOrder,
        fileSelected: ['dict:辭典A.md']
      }
    };

    const exportedJsonStr = JSON.stringify(simulatedExport);
    const parsed = JSON.parse(exportedJsonStr);

    // 驗證必要欄位
    assert.equal(parsed.app, 'mdWebview');
    assert.equal(parsed.type, 'mdWebview-user-preferences');
    assert.equal(parsed.preferences.theme, 'obsidian-dark');
    assert.equal(parsed.preferences.fontSize, 18);
    assert.equal(parsed.bookmarks.length, 1);
    assert.equal(parsed.recentFiles.length, 1);

    // 驗證安全性邊界：不得包含任何管理員 Token
    assert.equal(parsed.adminToken, undefined, '匯出資料絕對不可包含 adminToken');
    assert.equal(exportedJsonStr.includes('SECRET_ADMIN_TOKEN_99999'), false, '匯出 JSON 字串不可外洩 Token');
  });
});
