const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT_DIR, rel), 'utf8');

/**
 * 版本號的唯一來源是 package.json（升版只改它與 package-lock.json，例如
 * `npm version patch --no-git-tag-version`）。其餘地方：
 *   - index.html / sw.js 只放 __APP_VERSION__ 佔位符，由 server 送出時換成實際版本
 *     （資源網址 ?v= 用來破瀏覽器快取，sw.js 的 CACHE_VERSION 讓舊快取失效）。
 *   - lib/constants.js 的 APP_VERSION 讀自 package.json。
 *   - app.js 執行時讀 __APP_CONFIG__.appVersion，原始檔不寫死版本。
 * 這個測試守住「不要把現行版本號又寫死回原始檔」。
 */
describe('版本號單一來源 (package.json)', () => {
  const version = JSON.parse(read('package.json')).version;
  const escaped = version.replace(/\./g, '\\.');
  const literal = new RegExp(`(?<![0-9.])v?${escaped}(?![0-9])`);

  test('package.json 與 package-lock.json 版本一致', () => {
    const lock = JSON.parse(read('package-lock.json'));
    assert.equal(lock.version, version);
    assert.equal(lock.packages[''].version, version);
  });

  test('index.html 與 sw.js 使用 __APP_VERSION__ 佔位符，不寫死版本', () => {
    const html = read('index.html');
    assert.ok(/\?v=__APP_VERSION__/.test(html), 'index.html 資源網址應使用 ?v=__APP_VERSION__');
    assert.ok(!/\?v=\d/.test(html), 'index.html 不應有寫死版本的 ?v=');
    assert.match(read('sw.js'), /CACHE_VERSION = 'v__APP_VERSION__'/);
  });

  test('現行版本號不得寫死在原始檔（只存在 package.json）', () => {
    for (const rel of ['index.html', 'sw.js', 'app.js', 'style.css', 'server.js', 'README.md', 'lib/constants.js']) {
      const lines = read(rel).split('\n');
      lines.forEach((line, i) => {
        assert.ok(!literal.test(line), `${rel}:${i + 1} 不應寫死現行版本 ${version}`);
      });
    }
  });

  test('lib/constants.js 的 APP_VERSION 讀自 package.json', () => {
    const { APP_VERSION } = require('../lib/constants');
    assert.equal(APP_VERSION, version);
  });

  test('server 會替換 __APP_VERSION__：?v= 與 sw.js 換成資源指紋，畫面上的版本顯示仍是純版本號', () => {
    const src = read('lib/static-cache.js');
    // 畫面上顯示的版本（v__APP_VERSION__）是給人看的，維持 package.json 版本。
    assert.ok(/replace\(\/__APP_VERSION__\/g, APP_VERSION\)/.test(src));
    // 資源網址的 ?v= 是破快取用，必須帶內容指紋，否則 dev 不升版時使用者永遠拿舊檔（見 lib/asset-version.js）。
    assert.ok(/replace\(\/\\\?v=__APP_VERSION__\/g, \(\) => `\?v=\$\{assetVersion\}`\)/.test(src),
      'index.html 的 ?v=__APP_VERSION__ 應換成資源指紋');
    // sw.js 的 CACHE_VERSION 同樣取資源指紋，指紋變 → sw.js 位元組變 → 瀏覽器安裝新 SW。
    assert.ok(/replace\(\/__APP_VERSION__\/g, \(\) => assetVersion\)/.test(src),
      'sw.js 的 __APP_VERSION__ 應換成資源指紋');
  });

  test('app.js 的 appVersion fallback 不寫死版本', () => {
    const lines = read('app.js').split('\n').filter(l => l.includes('__APP_CONFIG__') && l.includes('.appVersion'));
    assert.ok(lines.length >= 3);
    for (const l of lines) assert.ok(!/'\d+\.\d+\.\d+'/.test(l), `不應有寫死的版本字面值: ${l.trim()}`);
  });
});
