const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');

describe('全站預設搜尋模式與偏好設定測試 (Default Search Mode & Preferences)', () => {
  test('lib/config.js settings 預設 defaultSearchMode 為 loose', () => {
    const configContent = fs.readFileSync(path.join(ROOT_DIR, 'lib/config.js'), 'utf8');
    assert.match(
      configContent,
      /defaultSearchMode:\s*['"]loose['"]/,
      'config.settings 必須預設 defaultSearchMode 為 "loose"'
    );

    // 驗證環境變數覆寫
    assert.match(
      configContent,
      /DEFAULT_SEARCH_MODE\s*===\s*['"]strict['"]\s*\|\|\s*process\.env\.DEFAULT_SEARCH_MODE\s*===\s*['"]loose['"]/,
      'loadConfig() 必須支援 DEFAULT_SEARCH_MODE 環境變數覆寫 ("strict" 或 "loose")'
    );

    const { config } = require('../lib/config.js');
    assert.equal(config.settings.defaultSearchMode, 'loose', 'require 時 config.settings.defaultSearchMode 應為 "loose"');
  });

  test('index.html 後台設定面板包含 settingsDefaultSearchMode 且包含 loose/strict 選項', () => {
    const indexHtml = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
    assert.match(
      indexHtml,
      /<select[^>]*id=["']settingsDefaultSearchMode["']/,
      'index.html 必須包含 id="settingsDefaultSearchMode" 選單'
    );
    assert.match(
      indexHtml,
      /<option[^>]*value=["']loose["'][^>]*>.*寬鬆.*<\/option>/,
      '選單必須包含 value="loose"（寬鬆）選項'
    );
    assert.match(
      indexHtml,
      /<option[^>]*value=["']strict["'][^>]*>.*嚴格.*<\/option>/,
      '選單必須包含 value="strict"（嚴格）選項'
    );
  });

  test('server.js /api/admin/settings POST 會解構並校驗 defaultSearchMode', () => {
    const serverContent = fs.readFileSync(path.join(ROOT_DIR, 'server.js'), 'utf8');
    assert.match(
      serverContent,
      /defaultSearchMode[\s\S]*?=\s*data\.settings/,
      'server.js 的 POST /api/admin/settings 必須解構 defaultSearchMode'
    );
    assert.match(
      serverContent,
      /defaultSearchMode\s*===\s*['"]strict['"]\s*\|\|\s*defaultSearchMode\s*===\s*['"]loose['"]/,
      'server.js 必須檢驗 defaultSearchMode 只接受 "strict" 或 "loose"'
    );
  });

  test('app.js state.searchMode 初始化以 localStorage 為主、appConfig.defaultSearchMode 為 fallback', () => {
    const appContent = fs.readFileSync(path.join(ROOT_DIR, 'app.js'), 'utf8');
    assert.match(
      appContent,
      /searchMode:\s*\(\(\)\s*=>\s*\{[\s\S]*?storage\.get\(STORAGE_KEYS\.SEARCH_MODE\)[\s\S]*?appConfig\.defaultSearchMode[\s\S]*?\}\)\(\)/,
      'app.js 必須優先使用 localStorage 偏好，不存在時 fallback 至 appConfig.defaultSearchMode'
    );
  });

  test('app.js 偏好備份與還原包含 searchMode 且向下相容', () => {
    const appContent = fs.readFileSync(path.join(ROOT_DIR, 'app.js'), 'utf8');
    assert.match(
      appContent,
      /preferences:\s*\{[\s\S]*?searchMode:\s*state\.searchMode/,
      'exportUserPreferences 必須在 preferences 中包含 searchMode: state.searchMode'
    );
    assert.match(
      appContent,
      /pref\.searchMode\s*===\s*['"]loose['"]\s*\|\|\s*pref\.searchMode\s*===\s*['"]strict['"]/,
      'importUserPreferences 必須校驗 pref.searchMode 並還原至 state 與 localStorage'
    );
  });
});
