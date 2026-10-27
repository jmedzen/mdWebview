/**
 * 介面字串表：简体中文（大陆）。鍵必須與 zh-TW.js 一致。
 */
(function (global) {
  'use strict';
  const table = {
    'script.toggle.label': '简',
    'script.switched': '已切换为简体显示',
    'script.autoNotice.title': '已切换为简体显示',
    'script.autoNotice.body': '根据浏览器语言自动切换为「{label}」体。随时可点击右上角菜单，在「繁简显示」切换回繁体。',
    'script.autoNotice.dismiss': '知道了',
    'script.loadFailed': '简体转换组件加载失败，暂以繁体显示：{error}',
    'settings.displayScript.title': '繁简显示',
    'settings.displayScript.desc': '整个网站以繁体或简体显示。经文原文为繁体，简体为即时转换；简体显示时搜索会一并比对简繁字形'
  };
  const root = (global.MDW_I18N_TABLES = global.MDW_I18N_TABLES || {});
  root['zh-CN'] = table;
  if (typeof module !== 'undefined' && module.exports) module.exports = table;
})(typeof globalThis !== 'undefined' ? globalThis : this);
