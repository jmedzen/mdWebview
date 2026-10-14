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
   * 反向斷言：升版後不得殘留「上一版的現行版本標記」。
   *
   * 注意 ARCHITECTURE.md 會刻意累積**歷史註記**（例如「深度跳轉定位對齊（v3.7.6）」
   * 記錄該版做了什麼），這些是準確的歷史敘述，不應被後續升版改寫。因此這裡只針對
   * 「現行版本標記」（標頭版本列與 APP_VERSION 表格列）斷言，並另外以歷史註記數量
   * 守住誤用全域取代（sed 全檔替換）把歷史一併改寫的情況。
   */
  test('反向斷言：不得殘留舊版本的現行版本標記（v3.7.6）', () => {
    const oldVersion = '3.7.6';
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

    // 歷史註記不得被升版的全域取代誤刪：v3.7.6 的功能註記應維持存在。
    assert.ok(
      arch.includes(`（${oldTag}）`),
      `ARCHITECTURE.md 應保留 v3.7.6 的歷史功能註記（不得被升版的全域取代改寫）`
    );
  });
});
