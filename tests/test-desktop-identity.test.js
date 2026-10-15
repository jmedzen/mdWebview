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

  describe('桌面外殼的部署模式與固定連接埠', () => {
    // localStorage is scoped to the page origin, which for these shells is
    // http://127.0.0.1:<port>. Both shells used to pass PORT=0, so the origin
    // changed on every launch and the user's theme, font size, bookmarks, recent
    // files and reading progress were silently orphaned each time. The port must
    // therefore be a fixed value, with MDW_PORT_SCAN covering the case where it
    // is already taken.
    const tauriMain = () =>
      fs.readFileSync(
        path.join(ROOT_DIR, 'desktop', 'tauri', 'src-tauri', 'src', 'main.rs'),
        'utf8'
      );
    const electronMain = () =>
      fs.readFileSync(path.join(ELECTRON_DIR, 'main.js'), 'utf8');

    test('Electron 必須使用固定連接埠，不得再要求 PORT=0', () => {
      const src = electronMain();
      assert.equal(
        /PORT:\s*'0'/.test(src),
        false,
        "Electron 不得再使用 PORT: '0'（每次啟動都會換 origin，localStorage 會失效）"
      );
      assert.match(src, /LOCAL_PORT/, '應以具名常數宣告固定連接埠');
      assert.match(src, /PORT:\s*LOCAL_PORT/, '應把固定連接埠傳給 server.js');
      assert.match(src, /MDW_PORT_SCAN/, '應啟用埠掃描，避免埠被占用時崩潰');
    });

    test('Tauri 必須使用固定連接埠，不得再要求 PORT=0', () => {
      const src = tauriMain();
      assert.equal(
        /\.env\("PORT",\s*"0"\)/.test(src),
        false,
        'Tauri 不得再使用 .env("PORT", "0")'
      );
      assert.match(src, /LOCAL_PORT/, '應以具名常數宣告固定連接埠');
      assert.match(src, /\.env\("PORT",\s*LOCAL_PORT\)/, '應把固定連接埠傳給 server.js');
      assert.match(src, /MDW_PORT_SCAN/, '應啟用埠掃描，避免埠被占用時崩潰');
    });

    test('兩個外殼使用不同連接埠，可同時執行而不互相搶占 origin', () => {
      const tauriPort = (tauriMain().match(/const LOCAL_PORT: &str = "(\d+)"/) || [])[1];
      const electronPort = (electronMain().match(/const LOCAL_PORT = '(\d+)'/) || [])[1];
      assert.ok(tauriPort, 'Tauri 應宣告 LOCAL_PORT 常數');
      assert.ok(electronPort, 'Electron 應宣告 LOCAL_PORT 常數');
      assert.notEqual(
        tauriPort,
        electronPort,
        '兩個外殼必須使用不同連接埠，否則同時開啟時其中之一會被擠到別的 origin'
      );
    });

    test('兩個外殼都必須宣告 MDW_DEPLOY_TARGET 為單機模式', () => {
      const tauri = tauriMain();
      const electron = electronMain();

      for (const [name, src] of [['Tauri', tauri], ['Electron', electron]]) {
        assert.match(
          src,
          /MDW_DEPLOY_TARGET/,
          `${name} 應把部署模式傳給 server.js，否則會退回 web 模式並要求管理員帳號`
        );
        assert.match(src, /mac-app/, `${name} 在 macOS 應回報 mac-app`);
        assert.match(src, /win-app/, `${name} 在 Windows 應回報 win-app`);
      }
    });

    test('文件應說明固定連接埠與偏好設定的關係', () => {
      const readme = fs.readFileSync(path.join(ROOT_DIR, 'desktop', 'README.md'), 'utf8');
      assert.match(readme, /MDW_DEPLOY_TARGET/, 'desktop/README 應記載部署模式變數');
      assert.match(readme, /localStorage/, 'desktop/README 應說明 localStorage 與 origin 的關係');
      assert.match(readme, /MDW_PORT_SCAN/, 'desktop/README 應記載埠掃描行為');
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

  // ─────────────────────────────────────────────────────────────────────────
  // 產物架構驗證（PE header）
  //
  // 既有測試只斷言 workflow 裡出現 `--x64` / `--arm64` 字串，也就是只檢查
  // 「有沒有要求某架構」。真正的風險是交叉編譯時產物其實是錯的架構（例如
  // arm64 的 sidecar 抓到 x64 的 node.exe）：那種情況下字串斷言全數通過，
  // 出貨後 ARM64 使用者才會發現。以下測試確保 CI 真的去讀 PE 標頭。
  // ─────────────────────────────────────────────────────────────────────────
  describe('產物架構驗證', () => {
    const VERIFY_SCRIPT = path.join(
      ROOT_DIR,
      'desktop',
      'scripts',
      'verify-pe-arch.sh'
    );

    test('架構驗證腳本應存在且可執行', () => {
      assert.ok(
        fs.existsSync(VERIFY_SCRIPT),
        'desktop/scripts/verify-pe-arch.sh 必須存在'
      );
      const st = fs.statSync(VERIFY_SCRIPT);
      assert.ok(
        (st.mode & 0o111) !== 0,
        'verify-pe-arch.sh 必須有執行權限（CI 以 bash 呼叫，仍應保持一致）'
      );
    });

    test('腳本應讀取 PE Machine 欄位，而非依賴檔名', () => {
      const src = fs.readFileSync(VERIFY_SCRIPT, 'utf8');
      // e_lfanew 在 0x3C（60），Machine 在 PE 標頭 +4。
      assert.match(src, /-j60/, '應自 0x3C 讀取 e_lfanew');
      assert.match(src, /8664/, '應辨識 x64 的 machine code 0x8664');
      assert.match(src, /aa64/, '應辨識 ARM64 的 machine code 0xaa64');
      // 對應的拒絕路徑：架構不符必須讓建置失敗。
      assert.match(src, /exit 1/, '架構不符時必須以非零狀態結束');
    });

    test('CI 應在 Windows 兩個打包 job 都呼叫架構驗證', () => {
      const yml = fs.readFileSync(WORKFLOW, 'utf8');
      const calls = yml.match(/verify-pe-arch\.sh/g) || [];
      assert.ok(
        calls.length >= 2,
        `Tauri 與 Electron 都應呼叫 verify-pe-arch.sh（實際 ${calls.length} 次）`
      );
    });

    test('矩陣應帶上預期架構，驗證才有依據', () => {
      const yml = fs.readFileSync(WORKFLOW, 'utf8');
      const blocks = yml.split(/\n\s*-\s+label:/).slice(1);
      const winBlocks = blocks.filter((b) => /win_arch:\s*(x64|arm64)/.test(b));
      const arches = winBlocks.map(
        (b) => (b.match(/win_arch:\s*(x64|arm64)/) || [])[1]
      );
      assert.ok(arches.includes('x64'), '應有一列宣告 win_arch: x64');
      assert.ok(arches.includes('arm64'), '應有一列宣告 win_arch: arm64');
    });

    test('macOS 矩陣列不得帶 Windows 架構，否則驗證會誤判', () => {
      const yml = fs.readFileSync(WORKFLOW, 'utf8');
      const blocks = yml.split(/\n\s*-\s+label:/).slice(1);
      const macBlocks = blocks.filter((b) => /os:\s*macos-latest/.test(b));
      assert.ok(macBlocks.length >= 2, '應有 macOS 矩陣列');
      for (const b of macBlocks) {
        assert.match(
          b,
          /win_arch:\s*''/,
          'macOS 列的 win_arch 應為空字串，讓 Windows 專屬驗證以 if 條件略過'
        );
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Windows 執行期煙霧測試
  //
  // 打包 job 只證明「編譯得出來」。在這些測試之前，CI 從未執行過任何
  // Windows 執行檔，因此整個 Windows 專屬執行期路徑（payload 是否真的進了
  // 安裝檔、sidecar 能否從唯讀安裝目錄啟動、資料目錄是否解析到
  // %APPDATA%）完全沒有覆蓋。
  // ─────────────────────────────────────────────────────────────────────────
  describe('Windows 煙霧測試', () => {
    const SMOKE_SCRIPT = path.join(
      ROOT_DIR,
      'desktop',
      'scripts',
      'smoke-test-windows.ps1'
    );

    test('煙霧測試腳本應存在', () => {
      assert.ok(
        fs.existsSync(SMOKE_SCRIPT),
        'desktop/scripts/smoke-test-windows.ps1 必須存在'
      );
    });

    test('腳本應等待 HTTP 就緒並驗證資料目錄', () => {
      const src = fs.readFileSync(SMOKE_SCRIPT, 'utf8');
      assert.match(src, /Invoke-WebRequest/, '應實際發出 HTTP 請求');
      assert.match(src, /AssertUserDataPath/, '應可驗證使用者資料目錄');
      assert.match(
        src,
        /RawContentLength/,
        '應檢查回應大小，避免「有回應但 payload 不完整」也通過'
      );
    });

    test('資料目錄驗證應要求實際寫入檔案，而非只建立目錄', () => {
      const src = fs.readFileSync(SMOKE_SCRIPT, 'utf8');
      // 只檢查目錄存在／非空是不夠的：server.js 只要 mkdir 就會通過，
      // 但那正是 Windows 重導向設定檔最常見的失敗點（ENOENT）。
      assert.match(
        src,
        /-Recurse -File/,
        '應遞迴尋找檔案，而非只列舉第一層目錄項目'
      );
      assert.match(
        src,
        /wrote no files/,
        '應在「只有目錄、沒有檔案」時明確失敗'
      );
    });

    test('CI 不得預先建立使用者資料目錄，否則該斷言會空洞化', () => {
      const yml = fs.readFileSync(WORKFLOW, 'utf8');
      const smokeBlock = yml.slice(yml.indexOf('  windows-smoke:'));
      const prepStep = smokeBlock.slice(
        smokeBlock.indexOf('Prepare user data location'),
        smokeBlock.indexOf('Run smoke test')
      );
      assert.ok(prepStep, '應有準備使用者資料位置的步驟');
      // 若 CI 先把 logs/md/dicts 建好，應用程式什麼都不做也會通過驗證。
      assert.ok(
        !/New-Item[^\n]*'logs'/.test(prepStep) &&
          !/New-Item[^\n]*"logs"/.test(prepStep),
        'CI 不應預先建立 logs 等子目錄，否則無法證明應用程式自己建立了可寫目錄'
      );
      assert.match(
        prepStep,
        /Remove-Item/,
        '應先清空，避免暖 runner 的殘留資料讓驗證失真'
      );
    });

    test('腳本必須清掉整個行程樹，否則會殘留佔用埠的伺服器', () => {
      const src = fs.readFileSync(SMOKE_SCRIPT, 'utf8');
      // Electron 外殼會再 spawn Node 子行程；只 kill 父行程會留下孤兒。
      assert.match(src, /taskkill/, '應以 taskkill 結束行程');
      assert.match(src, /\/T/, 'taskkill 應帶 /T 一併結束子行程樹');
    });

    test('CI 應以原生 ARM64 runner 執行 ARM64 產物', () => {
      const yml = fs.readFileSync(WORKFLOW, 'utf8');
      const blocks = yml.split(/\n\s*-\s+label:/).slice(1);
      // windows-11-arm 是 GitHub 唯一的 Windows ARM runner；用它才能證明
      // ARM64 產物是原生執行，而不是靠 x64 模擬。
      assert.match(yml, /windows-11-arm/, '應使用 windows-11-arm runner');
      const armRows = blocks.filter((b) => /os:\s*windows-11-arm/.test(b));
      assert.ok(
        armRows.length >= 2,
        `Tauri 與 Electron 的 ARM64 產物都應在原生 ARM runner 上實跑（實際 ${armRows.length} 列）`
      );
    });

    test('Windows runner 應明確釘住版本，避免映像遷移造成漂移', () => {
      const yml = fs.readFileSync(WORKFLOW, 'utf8');
      assert.ok(
        !/runs-on:\s*windows-latest/.test(yml) &&
          !/os:\s*windows-latest/.test(yml),
        'windows-latest 會隨時間指向新映像；應明確指定 windows-2025'
      );
    });

    test('發佈前必須先通過煙霧測試', () => {
      const yml = fs.readFileSync(WORKFLOW, 'utf8');
      const releaseBlock = yml.slice(yml.indexOf('  release:'));
      assert.match(
        releaseBlock,
        /needs:\s*\[[^\]]*windows-smoke[^\]]*\]/,
        'release job 應依賴 windows-smoke，壞掉的產物不得被發佈'
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Tauri WebView2 安裝模式
  // ─────────────────────────────────────────────────────────────────────────
  describe('Tauri WebView2 安裝模式', () => {
    const TAURI_CONF = path.join(
      ROOT_DIR,
      'desktop',
      'tauri',
      'src-tauri',
      'tauri.conf.json'
    );

    test('應明確設定 offlineInstaller，而非依賴預設的連網下載', () => {
      const conf = JSON.parse(fs.readFileSync(TAURI_CONF, 'utf8'));
      const mode = conf.bundle.windows.webviewInstallMode;

      // Tauri 的預設是 downloadBootstrapper，官方文件明載「需要網際網路連線」。
      // 本專案的核心價值是離線閱讀，安裝階段卻要求連網是本末倒置。
      assert.ok(mode, 'bundle.windows.webviewInstallMode 必須顯式設定');
      assert.equal(
        mode.type,
        'offlineInstaller',
        '應使用 offlineInstaller，讓無 WebView2 的機器也能離線安裝'
      );
    });
  });
});
