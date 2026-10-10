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

  test('反向斷言：核心檔案內不得再出現舊版本字串 v3.6.7', () => {
    const targetFiles = ['app.js', 'index.html', 'README.md', 'ARCHITECTURE.md'];
    for (const relPath of targetFiles) {
      const content = fs.readFileSync(path.join(ROOT_DIR, relPath), 'utf8');
      assert.ok(
        !content.includes('v3.6.7'),
        `${relPath} 內不得再出現舊版本字串 "v3.6.7"`
      );
    }
  });
});
