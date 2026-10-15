/**
 * @file tests/test-desktop-identity.test.js
 *
 * Regression tests for the desktop shells' per-user data directory and for the
 * Windows packaging matrix.
 *
 * Background
 * ----------
 * Electron derives `app.getPath('userData')` from `app.name`, which it resolves
 * from the packaged package.json — `productName` first, then `name`. The
 * packaged asar only ever contained `name` ("mdwebview-desktop"), so every
 * platform silently used `.../mdwebview-desktop` instead of the documented
 * `.../mdWebview-Electron`. On Windows that mismatch surfaced as a startup
 * failure when the derived directory could not be created:
 *
 *     ENOENT: no such file or directory, mkdir
 *       'C:\Users\<user>\AppData\Roaming\mdwebview-desktop'
 *
 * The launcher must therefore pin the name explicitly and be able to fall back
 * when the preferred location is unusable — but never silently, because the
 * fallback candidates are not all safe for real user data.
 *
 * A native Windows ARM64 build is also produced; x64 must remain, since Intel
 * and AMD machines cannot run the ARM64 build.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const ELECTRON_DIR = path.join(ROOT_DIR, 'desktop', 'electron');
const WORKFLOW = path.join(ROOT_DIR, '.github', 'workflows', 'desktop-packages.yml');

const readElectronPkg = () =>
  JSON.parse(fs.readFileSync(path.join(ELECTRON_DIR, 'package.json'), 'utf8'));

describe('桌面外殼資料目錄與 Windows 打包矩陣 (Desktop Identity)', () => {
  describe('Electron 產品識別', () => {
    test('package.json 應同時具備頂層 name 與 productName', () => {
      const pkg = readElectronPkg();
      assert.equal(
        pkg.name,
        'mdwebview-desktop',
        '底層套件名稱應維持 mdwebview-desktop（避免動到既有生態）'
      );
      assert.equal(
        pkg.productName,
        'mdWebview-Electron',
        // 這一行就是修正重點：缺少頂層 productName 時，Electron 會退回 name，
        // Windows 便去建立 %APPDATA%\\mdwebview-desktop。
        '頂層 productName 必須存在，否則 Electron 會以 name 推導 userData'
      );
    });

    test('build.productName 應與頂層 productName 一致', () => {
      const pkg = readElectronPkg();
      assert.equal(
        pkg.build.productName,
        pkg.productName,
        'build.productName（影響安裝檔名）應與頂層 productName（影響 userData）一致'
      );
    });

    test('main.js 應在讀取任何路徑前顯式設定 app 名稱與 userData', () => {
      const src = fs.readFileSync(path.join(ELECTRON_DIR, 'main.js'), 'utf8');

      assert.match(
        src,
        /app\.setName\(\s*PRODUCT_NAME\s*\)/,
        'main.js 應顯式 app.setName(PRODUCT_NAME)'
      );
      assert.match(
        src,
        /app\.setPath\(\s*'userData'/,
        "main.js 應顯式 app.setPath('userData', ...)"
      );

      // setName/setPath 必須出現在單一實例鎖之前：該鎖以 userData 為鍵值。
      const setNameAt = src.indexOf('app.setName(');
      const lockAt = src.indexOf('requestSingleInstanceLock');
      assert.ok(lockAt > 0, 'main.js 應使用 requestSingleInstanceLock');
      assert.ok(
        setNameAt > 0 && setNameAt < lockAt,
        'app.setName／setPath 必須早於 requestSingleInstanceLock，否則鎖會綁錯目錄'
      );
    });

    test('main.js 應具備退回機制，且退回暫存目錄時必須警告使用者', () => {
      const src = fs.readFileSync(path.join(ELECTRON_DIR, 'main.js'), 'utf8');

      assert.match(src, /LOCALAPPDATA/, '應以 %LOCALAPPDATA% 作為第二順位');
      assert.match(src, /os\.tmpdir\(\)/, '應有最終退回位置');
      assert.match(
        src,
        /temporary\s*:\s*true/,
        '退回暫存目錄時應標記 temporary，讓呼叫端能提出警告'
      );
      assert.match(
        src,
        /showMessageBoxSync/,
        '退回暫存目錄時必須以對話框警告，不可靜默搬移資料'
      );
    });

    test('main.js 應能移轉舊版 mdwebview-desktop 目錄的資料', () => {
      const src = fs.readFileSync(path.join(ELECTRON_DIR, 'main.js'), 'utf8');
      assert.match(
        src,
        /mdwebview-desktop/,
        '應辨識舊版資料目錄名稱，避免使用者誤以為資料遺失'
      );
      assert.match(src, /migrateLegacyUserData/, '應有移轉舊目錄的函式');
    });
  });

  describe('Windows 打包矩陣', () => {
    test('Electron 應同時產出 x64 與 arm64 的 NSIS 與 portable', () => {
      const pkg = readElectronPkg();
      const targets = pkg.build.win.target.map((t) => t.target);
      for (const name of ['nsis', 'portable']) {
        assert.ok(targets.includes(name), `win.target 應包含 ${name}`);
      }

      // 架構由 CI 逐列以 --x64 / --arm64 指定（見下一個測試的說明）。
      const yml = fs.readFileSync(WORKFLOW, 'utf8');
      const blocks = yml.split(/\n\s*-\s+label:/).slice(1);
      const winRows = blocks.filter((b) => /--win\b/.test(b));
      const flags = winRows.map((b) => (b.match(/--win\s+--(x64|arm64)/) || [])[1]);

      assert.ok(
        flags.includes('x64'),
        'CI 應有 --x64 一列：Intel／AMD 機器無法執行 arm64 版'
      );
      assert.ok(
        flags.includes('arm64'),
        'CI 應有 --arm64 一列，供 Windows on ARM 原生執行'
      );
    });

    test('產出檔名應含 ${arch}，否則兩種架構會互相覆蓋', () => {
      const pkg = readElectronPkg();
      assert.match(
        pkg.build.nsis.artifactName,
        /\$\{arch\}/,
        'nsis.artifactName 需含 ${arch}'
      );
      assert.match(
        pkg.build.portable.artifactName,
        /\$\{arch\}/,
        'portable.artifactName 需含 ${arch}'
      );
    });

    test('Windows 上傳清單應涵蓋 exe 與 blockmap', () => {
      const yml = fs.readFileSync(WORKFLOW, 'utf8');
      assert.match(
        yml,
        /desktop\/electron\/release\/\*\.exe/,
        'Electron 上傳清單應包含 Windows .exe'
      );
    });

    test('Tauri 應產出原生 Windows ARM64，且使用 arm64 的 Node sidecar', () => {
      const yml = fs.readFileSync(WORKFLOW, 'utf8');
      const blocks = yml.split(/\n\s*-\s+label:/).slice(1);
      const armRow = blocks.find((b) => b.includes('aarch64-pc-windows-msvc'));

      assert.ok(armRow, 'tauri matrix 應包含 aarch64-pc-windows-msvc 一列');
      assert.match(
        armRow,
        /node_arch:\s*arm64/,
        // sidecar 的檔名帶 triple，內容也必須是 arm64 的 node.exe，
        // 否則 ARM64 版會內嵌 x64 的 Node（可跑，但白白多一層模擬）。
        'Windows ARM64 版應使用 arm64 的 Node sidecar'
      );
      assert.match(
        armRow,
        /--target aarch64-pc-windows-msvc/,
        '應明確指定 --target，避免打包到宿主架構'
      );
    });

    test('x64 Windows 產物不得被移除', () => {
      const yml = fs.readFileSync(WORKFLOW, 'utf8');
      const blocks = yml.split(/\n\s*-\s+label:/).slice(1);
      const x64Row = blocks.find(
        (b) => b.includes('x86_64-pc-windows-msvc') && !b.includes('aarch64')
      );
      // arm64 是「外加」而非「取代」：仍須保留 x64 產物。
      assert.ok(x64Row, 'tauri matrix 應保留 x86_64-pc-windows-msvc 一列');
    });
  });

  describe('Tauri sidecar 腳本', () => {
    test('交叉編譯時執行驗證失敗不應中止建置', () => {
      const src = fs.readFileSync(
        path.join(ROOT_DIR, 'desktop', 'scripts', 'prepare-sidecar.sh'),
        'utf8'
      );
      // 腳本結尾若直接執行 sidecar，在 x64 runner 上建置 arm64 會失敗。
      assert.ok(
        !/^\s*"\$DEST"\s+--version\s*$/m.test(src),
        '不可無條件執行 sidecar --version；交叉編譯時無法執行會導致建置失敗'
      );
      assert.match(
        src,
        /Skipped runtime check/,
        '應在無法執行時略過檢查並說明原因'
      );
    });
  });
});
