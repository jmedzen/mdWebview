/**
 * 介面字串表：繁體中文（台灣）。站台預設語系，也是 t() 找不到鍵時的後備。
 *
 * 大部分介面文字直接寫在 index.html／app.js 中，切換簡體時由
 * display-script.js 即時轉換；這裡只收錄需要「依語系撰寫不同措辭」的字串
 * （繁簡切換本身的提示）。新增鍵時，zh-CN.js 必須有同名鍵
 * （tests/test-i18n.test.js 會檢查）。
 */
(function (global) {
  'use strict';
  const table = {
    'script.toggle.label': '繁',
    'script.toggle.title': '目前為繁體顯示，點擊切換為簡體',
    'script.toggle.aria': '切換繁體／簡體顯示（目前：繁體）',
    'script.switched': '已切換為繁體顯示',
    'script.autoNotice.title': '已切換為繁體顯示',
    'script.autoNotice.body': '依瀏覽器語言自動切換。隨時可點右上角「{label}」按鈕切換繁體／簡體。',
    'script.autoNotice.dismiss': '知道了',
    'script.loadFailed': '簡體轉換元件載入失敗，暫以繁體顯示：{error}',
    'settings.displayScript.title': '繁簡顯示',
    'settings.displayScript.desc': '整個網站以繁體或簡體顯示。經文原文為繁體，簡體為即時轉換，不影響搜尋結果'
  };
  const root = (global.MDW_I18N_TABLES = global.MDW_I18N_TABLES || {});
  root['zh-TW'] = table;
  if (typeof module !== 'undefined' && module.exports) module.exports = table;
})(typeof globalThis !== 'undefined' ? globalThis : this);
