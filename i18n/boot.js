/**
 * 繁簡顯示的開機前置（在 <head> 同步執行，必須輕量）
 *
 * 簡體顯示要等 OpenCC 載入、轉換完成後才能呈現，否則畫面會先閃一下繁體。
 * 這支腳本在 body 解析前判斷「這次會不會是簡體」：
 *   - localStorage 已存 'hans'，或
 *   - 尚未存過偏好、且瀏覽器主要語言為簡體中文（與 app.js 的
 *     isSimplifiedChineseLocale 規則相同：zh-CN／zh-Hans／zh-SG）
 * 是的話就提前下載 OpenCC，並在 <html> 加上 data-display-script="hans"，
 * 讓 style.css 先隱藏 body；app.js 轉換完成後加上 data-t2s-ready 再顯示。
 * 4 秒後無論如何都會顯示，避免腳本出錯時整頁空白。
 *
 * 真正的偏好判定與寫入仍由 app.js 負責，這裡不寫入 localStorage。
 */
(function () {
  'use strict';
  var KEY = 'mdWebview-display-script';
  var stored = null;
  try { stored = localStorage.getItem(KEY); } catch (_) { /* 無痕模式等 */ }

  var hans = stored === 'hans';
  if (stored !== 'hans' && stored !== 'hant') {
    var tag = '';
    try { tag = String(navigator.language || '').toLowerCase().replace(/_/g, '-'); } catch (_) {}
    hans = /^zh\b/.test(tag) && /-(hans|cn|sg)\b/.test(tag);
  }
  if (!hans) return;

  var html = document.documentElement;
  html.setAttribute('data-display-script', 'hans');
  html.setAttribute('lang', 'zh-Hans');

  var current = document.currentScript;
  var ver = '';
  if (current && current.src) {
    var m = current.src.match(/[?&]v=([^&]+)/);
    if (m) ver = '?v=' + m[1];
  }
  var s = document.createElement('script');
  s.id = 'mdwOpenccScript';
  s.src = 'vendor/opencc/t2cn.js' + ver;
  s.async = true;
  document.head.appendChild(s);

  setTimeout(function () { html.setAttribute('data-t2s-ready', '1'); }, 4000);
})();
