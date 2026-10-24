const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');

describe('全站版本號一致性測試 (Version Consistency)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  const version = pkg.version;

  test('README.md 應包含當前版本號 (v + version + )', () => {
    const readmeContent = fs.readFileSync(path.join(ROOT_DIR, 'README.md'), 'utf8');
    assert.ok(
      readmeContent.includes(`(v${version})`),
      `README.md 應包含 "(v${version})"`
    );
  });

  test('ARCHITECTURE.md 應包含版本標頭與 APP_VERSION 表格列', () => {
    const archContent = fs.readFileSync(path.join(ROOT_DIR, 'ARCHITECTURE.md'), 'utf8');
    assert.ok(
      archContent.includes(`版本：v${version}`),
      `ARCHITECTURE.md 應包含 "版本：v${version}"`
    );

    const appVerRow = archContent.split('\n').find(line => line.includes('| `APP_VERSION` |'));
    assert.ok(appVerRow, 'ARCHITECTURE.md 應包含 `APP_VERSION` 定義列');
    assert.ok(
      appVerRow.includes(`'${version}'`),
      `ARCHITECTURE.md 內的 APP_VERSION 表格列應包含 '${version}'`
    );
  });

  /**
   * server.js / style.css 的 @version 標頭。
   *
   * 這兩個檔案的版本標頭**不在** version 反向斷言（第 111 行）的掃描清單內，
   * 歷來只能靠人工升版時記得改。v3.9.0 升版時就漏掉了 server.js，讓它停在
   * '3.8.2'（一個從未發行過的版本號）長達一整個版本。改用精確斷言守住，
   * 避免再次無聲漂移。
   */
  test('server.js 與 style.css 的 @version 標頭應等於當前版本', () => {
    const files = [
      ['server.js', /@version\s+([0-9]+\.[0-9]+\.[0-9]+)/],
      ['style.css', /\(style\.css\)\s+v?([0-9]+\.[0-9]+\.[0-9]+)/]
    ];
    for (const [relPath, pattern] of files) {
      const content = fs.readFileSync(path.join(ROOT_DIR, relPath), 'utf8');
      const m = content.match(pattern);
      assert.ok(m, `${relPath} 應包含可辨識的版本標頭`);
      assert.equal(
        m[1],
        version,
        `${relPath} 的版本標頭為 '${m[1]}'，應為當前版本 '${version}'`
      );
    }
  });

  test('app.js 應包含頂部版本標頭且 appVer fallback 出現至少 2 次', () => {
    const appContent = fs.readFileSync(path.join(ROOT_DIR, 'app.js'), 'utf8');
    assert.ok(
      appContent.includes(`(app.js) v${version}`),
      `app.js 頂部標頭應包含 "(app.js) v${version}"`
    );

    const appVerFallbackLines = appContent
      .split('\n')
      .filter(line => line.includes('appVer') && line.includes(`'${version}'`));
    assert.ok(
      appVerFallbackLines.length >= 2,
      `app.js 內 appVer fallback 字面值 '${version}' 應至少出現 2 次，實際出現 ${appVerFallbackLines.length} 次`
    );
  });

  test('index.html 應包含三個版本徽章 (v + version)', () => {
    const indexHtml = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
    const targetVer = `v${version}`;

    assert.ok(
      indexHtml.includes(`id="userSettingsHeaderVersion">${targetVer}<`),
      `index.html 應包含 userSettingsHeaderVersion 徽章 (${targetVer})`
    );
    assert.ok(
      indexHtml.includes(`id="systemTabVersion">${targetVer}<`),
      `index.html 應包含 systemTabVersion 徽章 (${targetVer})`
    );
    assert.ok(
      indexHtml.includes(`id="userSettingsFooterVersion">版本 ${targetVer}<`),
      `index.html 應包含 userSettingsFooterVersion 徽章 (版本 ${targetVer})`
    );
  });

  /**
   * 反向斷言：不得殘留「上一版的現行版本標記」。
   *
   * 注意 ARCHITECTURE.md 會刻意累積**歷史註記**（例如「深度跳轉定位對齊（v3.7.6）」
   * 記錄該版做了什麼），這些是準確的歷史敘述，不應被後續升版改寫。因此這裡只針對
   * 「現行版本標記」（標頭版本列與 APP_VERSION 表格列）斷言，並另外守住歷史註記
   * 不被誤刪（避免誤用全域 sed 取代把歷史一併改寫）。
   *
   * 版本資訊優先由 git 最近的 release commit 推導「上一版」，升版後不需手動修改本測試。
   *
   * 注意：不可只用 patch 減一推算。升到 X.Y.0 時 patch 為 0，減一會得到 X.(Y-1).-1
   * 這種無效版本，導致本反向斷言被 skip 而完全失去守衛作用（v3.8.0 升版時實際發生）。
   * 因此改為讀取 git 歷史中最近一個「與現行版本不同」的 release 版本；git 不可用時
   * 才退回 patch 減一，且此時若無法推導則明確失敗而非靜默略過。
   */
  const prevVersion = (() => {
    try {
      const { execSync } = require('node:child_process');
      const log = execSync('git log --format=%s -n 200', {
        cwd: ROOT_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
      });
      const found = [...log.matchAll(/chore\(release\):\s*v(\d+\.\d+\.\d+)/g)]
        .map(m => m[1])
        .find(v => v !== version);
      if (found) return found;
    } catch (_) { /* git 不可用時退回算術推算 */ }

    const [maj, min, pat] = version.split('.').map(Number);
    return pat > 0 ? `${maj}.${min}.${pat - 1}` : null;
  })();

  test('反向斷言：不得殘留舊版本的現行版本標記', () => {
    // 無法推導上一版時必須明確失敗，不可 skip ——
    // 靜默略過會讓整個守衛形同不存在（v3.8.0 升版時曾因此失去保護）。
    assert.ok(
      prevVersion,
      '無法從 git 歷史或 package.json 推導上一版版本號，反向斷言無法執行'
    );
    const oldVersion = prevVersion;
    const oldTag = `v${oldVersion}`;

    // 這三個檔案中的版本引用全部都是「現行標記」，可直接全面禁止。
    for (const relPath of ['app.js', 'index.html', 'README.md']) {
      const content = fs.readFileSync(path.join(ROOT_DIR, relPath), 'utf8');
      assert.ok(
        !content.includes(oldTag),
        `${relPath} 內不得再出現舊版本字串 "${oldTag}"`
      );
    }

    // ARCHITECTURE.md 允許歷史註記，但現行標記必須已更新。
    const arch = fs.readFileSync(path.join(ROOT_DIR, 'ARCHITECTURE.md'), 'utf8');
    assert.ok(
      !arch.includes(`版本：${oldTag}`),
      `ARCHITECTURE.md 版本標頭不得仍為 "${oldTag}"`
    );

    const appVerRow = arch.split('\n').find(line => line.includes('| `APP_VERSION` |'));
    assert.ok(appVerRow, 'ARCHITECTURE.md 應包含 `APP_VERSION` 定義列');
    assert.ok(
      !appVerRow.includes(`'${oldVersion}'`),
      `ARCHITECTURE.md 的 APP_VERSION 表格列不得仍為 '${oldVersion}'`
    );
  });

  test('ARCHITECTURE.md 應保留歷史功能註記（避免升版全域取代誤刪）', () => {
    const arch = fs.readFileSync(path.join(ROOT_DIR, 'ARCHITECTURE.md'), 'utf8');
    assert.ok(
      arch.includes('（v3.7.6）'),
      'ARCHITECTURE.md 應保留 v3.7.6 的歷史功能註記（不得被升版的全域取代改寫）'
    );
  });

  /**
   * 版本 fallback 守衛：app.js 內所有「取不到 __APP_CONFIG__ 時的字面值版本」
   * 必須等於當前版本。歷史上此處曾殘留 '3.7.0' 長達數個版本，導致匯出的
   * 設定備份標記為錯誤的版本號（見 app.js 設定匯出）。
   */
  test('app.js 內所有版本 fallback 字面值皆應等於當前版本', () => {
    const appContent = fs.readFileSync(path.join(ROOT_DIR, 'app.js'), 'utf8');
    const fallbackLines = appContent
      .split('\n')
      .map((line, i) => ({ line, no: i + 1 }))
      .filter(({ line }) => line.includes('__APP_CONFIG__') && line.includes('.appVersion'));

    assert.ok(
      fallbackLines.length >= 3,
      `app.js 內應至少 3 處 appVersion fallback，實際 ${fallbackLines.length} 處`
    );

    for (const { line, no } of fallbackLines) {
      const m = line.match(/:\s*'([0-9]+\.[0-9]+\.[0-9]+)'/);
      assert.ok(m, `app.js:${no} 的 appVersion fallback 應為純版本字面值`);
      assert.equal(
        m[1],
        version,
        `app.js:${no} 的 appVersion fallback 為 '${m[1]}'，應為當前版本 '${version}'`
      );
    }
  });
});
