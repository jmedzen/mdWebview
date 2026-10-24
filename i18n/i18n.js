/**
 * 介面字串查表（i18n）
 *
 *   t('script.switched')                      → 依目前語系取字串
 *   t('script.autoNotice.body', { label: '简' }) → {label} 以參數取代
 *
 * 查不到時依序退回 zh-TW、最後回傳鍵名本身，畫面不會出現 undefined。
 *
 * 靜態 HTML 以屬性標記：
 *   <span data-i18n="settings.displayScript.title"></span>        → textContent
 *   <button data-i18n-attr="title:script.toggle.title;aria-label:script.toggle.aria">
 *
 * 語系切換後呼叫 apply(document) 重新填入。字串一律以 textContent／
 * setAttribute 寫入，不經 innerHTML。
 */
(function (global) {
  'use strict';

  const FALLBACK = 'zh-TW';
  let locale = FALLBACK;

  function tables() {
    return global.MDW_I18N_TABLES || {};
  }

  function t(key, params) {
    const all = tables();
    const cur = all[locale] || {};
    const fb = all[FALLBACK] || {};
    let str = Object.prototype.hasOwnProperty.call(cur, key) ? cur[key]
      : Object.prototype.hasOwnProperty.call(fb, key) ? fb[key]
      : key;
    if (params) {
      str = str.replace(/\{(\w+)\}/g, (m, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m);
    }
    return str;
  }

  function setLocale(loc) {
    locale = tables()[loc] ? loc : FALLBACK;
    return locale;
  }

  function getLocale() {
    return locale;
  }

  function apply(root) {
    const scope = root || document;
    scope.querySelectorAll('[data-i18n]').forEach(el => {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    scope.querySelectorAll('[data-i18n-attr]').forEach(el => {
      String(el.getAttribute('data-i18n-attr')).split(';').forEach(pair => {
        const idx = pair.indexOf(':');
        if (idx <= 0) return;
        const attr = pair.slice(0, idx).trim();
        const key = pair.slice(idx + 1).trim();
        if (attr && key) el.setAttribute(attr, t(key));
      });
    });
  }

  const api = { t, setLocale, getLocale, apply, FALLBACK };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.mdI18n = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
