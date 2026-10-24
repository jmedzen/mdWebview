const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
const appSource = fs.readFileSync(path.join(ROOT_DIR, 'app.js'), 'utf8');

const zhTW = require('../i18n/zh-TW.js');
const zhCN = require('../i18n/zh-CN.js');
const i18n = require('../i18n/i18n.js');
const OpenCC = require('../vendor/opencc/t2cn.js');

function htmlKeys() {
  const keys = new Set();
  for (const m of indexHtml.matchAll(/data-i18n="([^"]+)"/g)) keys.add(m[1]);
  for (const m of indexHtml.matchAll(/data-i18n-attr="([^"]+)"/g)) {
    for (const pair of m[1].split(';')) {
      const key = pair.slice(pair.indexOf(':') + 1).trim();
      if (key) keys.add(key);
    }
  }
  return keys;
}

describe('i18n 1：字串表一致性', () => {
  test('zh-TW 與 zh-CN 的鍵完全相同', () => {
    assert.deepEqual(Object.keys(zhCN).sort(), Object.keys(zhTW).sort());
  });

  test('index.html 的 data-i18n／data-i18n-attr 鍵都存在於兩份字串表', () => {
    const keys = htmlKeys();
    assert.ok(keys.size > 0, '前提：index.html 應有 data-i18n 標記');
    for (const k of keys) {
      assert.ok(Object.prototype.hasOwnProperty.call(zhTW, k), `zh-TW 缺少 ${k}`);
      assert.ok(Object.prototype.hasOwnProperty.call(zhCN, k), `zh-CN 缺少 ${k}`);
    }
  });

  test('app.js 以 i18nT() 使用的鍵都存在', () => {
    const used = new Set([...appSource.matchAll(/i18nT\('([^']+)'/g)].map(m => m[1]));
    assert.ok(used.size > 0);
    for (const k of used) {
      assert.ok(Object.prototype.hasOwnProperty.call(zhTW, k), `zh-TW 缺少 ${k}`);
      assert.ok(Object.prototype.hasOwnProperty.call(zhCN, k), `zh-CN 缺少 ${k}`);
    }
  });

  test('zh-CN 字串已全為簡體（再轉一次 tw → cn 不應變動）', () => {
    const conv = OpenCC.Converter({ from: 'tw', to: 'cn' });
    for (const [k, v] of Object.entries(zhCN)) {
      assert.equal(conv(v), v, `zh-CN ${k} 仍含繁體字：${v}`);
    }
  });

  test('兩份字串表的 {參數} 佔位一致', () => {
    const params = (s) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
    for (const k of Object.keys(zhTW)) {
      assert.deepEqual(params(zhCN[k]), params(zhTW[k]), `${k} 的參數不一致`);
    }
  });
});

describe('i18n 2：t() 查表行為', () => {
  test('依語系取字串，切換語系即時生效', () => {
    i18n.setLocale('zh-TW');
    assert.equal(i18n.t('script.toggle.label'), '繁');
    i18n.setLocale('zh-CN');
    assert.equal(i18n.t('script.toggle.label'), '简');
    i18n.setLocale('zh-TW');
  });

  test('{name} 參數取代，未提供的參數保留原樣', () => {
    i18n.setLocale('zh-CN');
    assert.match(i18n.t('script.autoNotice.body', { label: '简' }), /「简」/);
    assert.match(i18n.t('script.autoNotice.body'), /\{label\}/);
    i18n.setLocale('zh-TW');
  });

  test('不存在的語系退回 zh-TW；不存在的鍵回傳鍵名', () => {
    assert.equal(i18n.setLocale('en-US'), 'zh-TW');
    assert.equal(i18n.t('no.such.key'), 'no.such.key');
  });

  test('zh-CN 缺鍵時退回 zh-TW', () => {
    const tables = globalThis.MDW_I18N_TABLES;
    tables['zh-CN']['only.tw'] = undefined;
    delete tables['zh-CN']['only.tw'];
    tables['zh-TW']['only.tw'] = '僅繁體';
    try {
      i18n.setLocale('zh-CN');
      assert.equal(i18n.t('only.tw'), '僅繁體');
    } finally {
      delete tables['zh-TW']['only.tw'];
      i18n.setLocale('zh-TW');
    }
  });
});
