# mdWebview — 桌面版打包

此目錄包含將 mdWebview 打包為 **macOS** 與 **Windows** 桌面安裝軟體的兩種外殼實作。

| 外殼 | 技術 | 產出 | 體積（約） |
| :--- | :--- | :--- | :--- |
| `electron/` | Electron 44 + electron-builder | macOS dmg/zip、Windows NSIS/portable | 250–300 MB |
| `tauri/` | Tauri v2 + 官方 Node sidecar | macOS dmg/app、Windows NSIS/MSI | 125 MB |

> **Electron 版本說明**：必須使用 **Electron 44 以上**。Electron 只附帶特定版本的 Node
> （43 為 Node 22、**44 為 Node 24.21**），而本專案宣告 `engines: >=24`。
> 已實測確認 Electron 44 內建 Node 24.21.0。

---

## 架構決策（必讀）

### 為什麼不重新實作前端

mdWebview 本體是一個 **Node.js HTTP 伺服器**，自己提供 SPA。兩個外殼都**不重寫任何應用邏輯**，而是：

1. 以**真正的 Node.js 行程**啟動未修改的 `server.js`
2. 等待它印出 `MDWEBVIEW_READY port=<port>`
3. 開一個原生視窗指向 `http://127.0.0.1:<port>`

這樣做的關鍵理由是 `server.js` 會：

- 用 `worker_threads` 從**磁碟上的實體檔案**載入 `render-worker.js` / `index-worker.js`
- 以 `process.cwd()`（`APP_ROOT`）解析靜態資源與 worker 路徑

任何「單一檔案二進位」方案（pkg／nexe／把 worker 包進 asar）都會破壞其中一項。詳見下方「為什麼不用 X」。

### 為什麼 Tauri 用 Node sidecar 而非 SEA

原本最直覺的做法是 Node 內建的 SEA（單一執行檔）。實測後改採 sidecar，原因：

- SEA 的 `require()` **不是檔案系統導向的**。`server.js` 第一個 `require('marked')` 就會拋 `ERR_UNKNOWN_BUILTIN_MODULE`，需要 `createRequire` 修補；且替換後 `require.main` 會變成 `undefined`，導致 `server.listen()` **靜默不執行**（行程看似啟動卻永不服務）。
- SEA 仍是 **Stability 1.1「Active development」**，macOS 上 postject 後**必須重新簽章**否則直接被 SIGKILL。
- 官方文件明載 macOS **x64「not currently supported and is skipped in the tests」**，而我們需要同時支援 Intel Mac。

sidecar 方案：體積與 SEA 幾乎相同（116 MB vs 115.8 MB），但**零程式碼修補、零重簽風險、零 Stability 疑慮**。

> ⚠️ **sidecar 必須使用 nodejs.org 官方發行版。**
> Homebrew／發行版／部分 nvm 的 Node 是約 50 KB 的 **shim**，連結到 `libnode.dylib`／`libnode.so`，單獨複製無法執行。`prepare-sidecar.sh` 已強制從 nodejs.org 下載。

### macOS 簽章（ad-hoc）與 Gatekeeper

本專案**沒有** Apple Developer ID 憑證（GitHub secrets 為空），因此 macOS 產物無法做真正的
Developer ID 簽章與公證。但**未簽章**會導致 macOS 15 之後出現 **「應用程式已損毀，無法打開」**
（`code has no resources but signature indicates they must be present`）——因為 bundle 只剩下連結器
自動加上的 ad-hoc 簽章，**缺少 `Contents/_CodeSignature/CodeResources`**，`codesign --verify --strict`
會直接失敗，Gatekeeper 便判定為損毀，而不是「未識別開發者」。

兩種外殼都改為**明確 ad-hoc 簽章**（`codesign --force -s -`）來修正：

| 外殼 | 設定 | 說明 |
| :--- | :--- | :--- |
| Tauri | `bundle.macOS.signingIdentity: "-"` | tauri-bundler 認得 `"-"` 這個哨兵值，會**逐字**傳給 `codesign -s -`，不做鑰匙圈查詢 |
| Electron | `mac.identity: "-"` | 需 electron-builder **≥ 26.0.13**（`MacTargetHelper` 支援 `"-"`；25.1.8 只會靜默跳過簽章） |

ad-hoc 簽章會一路簽進 bundle 內的巢狀執行檔（Tauri 的 sidecar、Electron 的 Frameworks），
因此**沒有** `_CodeSignature` 的問題與「損毀」判定都會消失。

> ⚠️ **Electron 必須保留 `com.apple.security.cs.disable-library-validation`**
> （已寫入 `build/entitlements.mac.plist`）。
> Electron 的 `Electron Framework` 帶有上游的 Team ID，而宿主是 ad-hoc 簽章（無 Team ID）。
> 一旦開啟 hardened runtime（本專案為 `true`）就會啟用 library validation，啟動時直接中止：
> `mapping process and mapped file (non-platform) have different Team IDs`。
> 移除這個 entitlement**或**把 `hardenedRuntime` 設為 `false`，都會讓 App 打不開。
>
> Tauri 不需要這個 entitlement：它只連結 Apple 系統 framework（以 `otool -L` 確認），
> bundle 內沒有其他帶 Team ID 的巢狀程式庫。

**使用者端繞行方式**（ad-hoc 簽章仍非 Apple 認可，首次開啟會顯示「未識別開發者」）：

```bash
# 方法一：右鍵 →「打開」→ 再點「打開」（只需一次）
# 方法二：命令列移除隔離屬性
xattr -dr com.apple.quarantine /Applications/mdWebview-Tauri.app
xattr -dr com.apple.quarantine /Applications/mdWebview-Electron.app
```

> 若要消除所有警告，唯一正解是加入 Apple Developer Program（USD 99/年）：
> 設定 `APPLE_CERTIFICATE`、`APPLE_ID`／`APPLE_PASSWORD`／`APPLE_TEAM_ID` 等 secrets 後，
> Tauri 與 electron-builder 都會自動改用 Developer ID 簽章並公證，**不需修改本專案的設定**。

### 資料目錄分離（app 唯讀、資料可寫）

安裝目錄必須保持唯讀且可被更新器覆寫，因此所有可寫資料都導向使用者資料目錄：

| 環境變數 | 內容 |
| :--- | :--- |
| `MDW_USER_DATA` | 應用程式資料根目錄（新增） |
| `CONFIG_PATH` | `<USER_DATA>/config.json` |
| `LOG_DIR` | `<USER_DATA>/logs`（**含數百 MB 的索引 `.bin`**） |
| `MD_ROOT` | `<USER_DATA>/md` |
| `DICTIONARY_PATH` | `<USER_DATA>/dicts` |
| `HOST` | `127.0.0.1`（僅監聽本機） |
| `PORT` | `0`（由 OS 配發空閒埠） |

實際落地位置：

| 外殼 | 決定目錄的欄位 | macOS | Windows |
| :--- | :--- | :--- | :--- |
| Tauri | `identifier` = `org.mdwebview.tauri` | `~/Library/Application Support/org.mdwebview.tauri/` | `%APPDATA%\org.mdwebview.tauri\` |
| Electron | `main.js` 內**顯式** `app.setPath('userData', …)` | `~/Library/Application Support/mdWebview-Electron/` | `%APPDATA%\mdWebview-Electron\` |

> **為何 Tauri 用 `identifier` 而 Electron 顯式指定？**
> Tauri 的 `app_data_dir()` 定義為 `data_dir()/<bundle identifier>`，是固定且可預期的。
>
> Electron 的 `app.getPath('userData')` 預設為 `appData/<app.name>`，
> 但 `app.name` 的來源**在各平台並不一致**，不能依賴：
> 打包後的 `app.asar` 內只有 `package.json` 的 `name`
> （`mdwebview-desktop`，且**不含** `productName`），
> 因此 Electron 實際解析出的 `app.name` 是 `mdwebview-desktop`，
> **macOS 與 Windows 皆然** —— 並非 `CFBundleName`／`ProductName`。
>
> 這會造成兩個問題：
> 1. 目錄名稱與文件、安裝捷徑顯示的名稱（`mdWebview-Electron`）不一致；
> 2. 使用者若使用受管控或已被重導向的設定檔，該目錄可能根本無法建立，
>    啟動時便以 `ENOENT: mkdir '…\mdwebview-desktop'` 失敗。
>
> 因此 `desktop/electron/main.js` 在**任何路徑被讀取之前**
> 顯式 `app.setName()` + `app.setPath('userData', …)`，
> 讓開發模式與打包後、macOS 與 Windows 的資料目錄完全一致。
> 這同時決定了單一實例鎖（single-instance lock）的鍵值，必須最先設定。
>
> 兩者也使用**不同的 bundle id／appId**（`org.mdwebview.tauri` 與
> `org.mdwebview.electron`）。macOS 上兩個 bundle id 相同的 App 會互相衝突，
> 因此這不只是命名偏好，而是必要區隔。
>
> ⚠️ 兩種外殼的索引快取**不共用**：切換外殼後首次啟動會各自重建索引。

> 為了支援上述行為，`lib/constants.js` 與 `lib/config.js` 做了相應調整：
> 新增 `USER_DATA`；當 `USER_DATA !== APP_ROOT`（桌面模式）時，
> **不再載入 app 目錄內的 `config.json`**。
> 因為該檔案在開發機上常含開發者的絕對路徑，會覆蓋啟動器設定的環境變數，
> 導致使用者安裝後被綁死到不存在的路徑。

---

## 本機開發

### Electron

```bash
cd desktop/electron
npm install
npm start          # 以原始碼啟動（會顯示伺服器輸出）
```

打包：

```bash
npm run dist:mac   # 產出 release/*.dmg 與 *.zip
npm run dist:win   # 產出 release/*-setup.exe 與 portable
```

### Tauri

需要 Rust 工具鏈與 Tauri CLI。

```bash
# 1. 放入官方 Node 作為 sidecar（會自動選 target triple 與 .exe 後綴）
bash desktop/scripts/prepare-sidecar.sh aarch64-apple-darwin darwin arm64
#    Windows: bash desktop/scripts/prepare-sidecar.sh x86_64-pc-windows-msvc win x64
#    Intel Mac: ... x86_64-apple-darwin darwin x64

# 2. 將應用程式 payload 複製到 src-tauri/payload
bash desktop/scripts/stage-payload.sh . desktop/tauri/src-tauri/payload

# 3. 打包
cd desktop/tauri
npx @tauri-apps/cli@^2 build
```

---

## 自動化流程

`.github/workflows/desktop-packages.yml` 會產生全部四個封裝：

| Artifact 名稱 | Runner | 內容 |
| :--- | :--- | :--- |
| `tauri-macos` | `macos-latest` | `.dmg`、`.app`（arm64） |
| `tauri-windows` | `windows-latest` | NSIS `.exe`、`.msi`（x64） |
| `tauri-windows-arm64` | `windows-latest` | NSIS `.exe`、`.msi`（原生 arm64） |
| `electron-macos` | `macos-latest` | `.dmg`、`.zip`（arm64 + x64） |
| `electron-windows` | `windows-latest` | NSIS installer、portable `.exe`（x64 + 原生 arm64） |

### 安裝檔命名（兩種外殼必須可分辨）

兩種外殼都叫 mdWebview，但**安裝檔名刻意不同**，以免在 Release 頁面混淆：

| 外殼 | 產品名稱 | macOS | Windows |
| :--- | :--- | :--- | :--- |
| Tauri | `mdWebview-Tauri` | `mdWebview-Tauri_3.8.1_aarch64.dmg`<br>`mdWebview-Tauri.app` | `mdWebview-Tauri_3.8.1_x64-setup.exe`<br>`mdWebview-Tauri_3.8.1_x64_en-US.msi`<br>`mdWebview-Tauri_3.8.1_arm64-setup.exe`<br>`mdWebview-Tauri_3.8.1_arm64_en-US.msi` |
| Electron | `mdWebview-Electron` | `mdWebview-Electron-3.8.1-arm64.dmg`<br>`mdWebview-Electron-3.8.1-x64.dmg`<br>`mdWebview-Electron-3.8.1-arm64-mac.zip`<br>`mdWebview-Electron-3.8.1-mac.zip` | `mdWebview-Electron-3.8.1-x64-setup.exe`<br>`mdWebview-Electron-3.8.1-x64-portable.exe`<br>`mdWebview-Electron-3.8.1-arm64-setup.exe`<br>`mdWebview-Electron-3.8.1-arm64-portable.exe` |

> **x64 與 arm64 並存**：Intel／AMD 機器需要 x64 版；Windows on ARM
> （Snapdragon X 等）另有原生 arm64 版，不必倚賴 x64 模擬。

命名規則差異（來自各自的打包器，非本專案自訂）：

- **Tauri**：`tauri-bundler` 固定以 `{productName}_{version}_{arch}` 組檔名，
  **以底線分隔**。Tauri 的設定 schema **沒有** `artifactName` 這種欄位，
  因此檔名**只能**由 `productName` 決定。
- **Electron**：`electron-builder` 的 `artifactName` 樣板（本專案明設
  `${productName}-${version}-${arch}...`），**以連字號分隔**。
  `.zip` 用的是 electron-builder 內建預設樣板，會**省略預設架構**（x64）
  的後綴，因此 x64 版是 `…-mac.zip`、arm64 版才是 `…-arm64-mac.zip`。

> 因此「`_` vs `-`」不只是外觀差異，而是兩套打包器的固定行為。
> 加上 `-Tauri` / `-Electron` 後綴，即使只看檔名也能立刻分辨。

流程設計重點：

- **`verify` job 先跑 `npm test`**，所有打包 job 全部 `needs: verify`——測試紅燈時**不可能**產出安裝檔（現有 279 項測試）。
- 推 `v*` tag 或手動 `workflow_dispatch` 觸發。
- 推 tag 時，`release` job 會把所有安裝檔附加到 GitHub Release。

---

## 為什麼不用其他方案

| 方案 | 結論 |
| :--- | :--- |
| **`pkg` (vercel/pkg)** | ❌ **已封存**（`archived=true`，最後 push 2024-01），Node 上限 18，無法滿足 `engines: >=24` |
| **`nexe`** | ❌ **實質已死**，最新 release 是 **v3.3.3（2017-08-30）** |
| **Node SEA** | ⚠️ 可行但需 4 行修補 + macOS 重簽；且 macOS x64 未經官方 CI 覆蓋。已改用 sidecar |
| **Tauri 重寫前端** | ❌ 需以 Rust 重寫整個閱讀器，成本極高且無必要 |
| **`file://` 載入前端** | ❌ Service Worker 與整個 HTTP server 架構都會失效。**必須保留 HTTP server** |

---

## 驗證狀態

以下為**實機驗證**結果（Apple Silicon macOS，本機環境）：

| 項目 | 結果 |
| :--- | :--- |
| 現有測試套件 | ✅ **279 項測試，全數通過**（0 失敗、0 略過） |
| 伺服器模式回歸 | ✅ `GET /` 與 `/api/tree` 皆 200；維持 `0.0.0.0` 綁定與 CWD 資料目錄 |
| Tauri `.app` 打包 | ✅ 成功產出 124.56 MiB bundle |
| Tauri 打包後執行 | ✅ sidecar 啟動、`GET /` 200、資料只寫入使用者目錄 |
| Tauri ad-hoc 簽章 | ✅ `codesign --verify --strict` rc=0、`--deep --strict` rc=0；含 `_CodeSignature/CodeResources` |
| Electron 打包 | ✅ 產出 `mdWebview-Electron-3.8.1-arm64-mac.zip`（126 MB） |
| Electron 打包後執行 | ✅ 內嵌伺服器啟動（port 8330）、`GET /` 與 `/app.js` 皆 200、0 個 worker 錯誤 |
| Electron ad-hoc 簽章 | ✅ `codesign --verify --strict` rc=0、`--deep --strict` rc=0；`flags=0x10002(adhoc,runtime)` |
| Gatekeeper 判定 | ✅ 隔離屬性下不再回報「損毀」，僅為可繞行的「未識別開發者」 |
| 封裝內容檢查 | ✅ 含 `server.js`/worker/`marked`；**不含** `config.json`、`logs`、`md`、`dicts`、`tests` |
| 資料目錄選擇邏輯 | ✅ 以真實 `main.js` 搭配替身 Electron 驗證 3 種情境：正常、`%APPDATA%` 不可建立（正確退回）、舊目錄自動移轉 |
| Windows 雙架構打包 | ✅ 本機以 electron-builder 26.17.0 產出 `win-unpacked`（x64）與 `win-arm64-unpacked`（ARM64），asar 內確認含修正後 `main.js` |
| 設定檔語法 | ✅ 3 個 workflow YAML、4 個 JSON 全部有效 |

> ⚠️ **本機無法驗證 DMG**：DSH 沙箱封鎖了 raw disk 存取
> （`newfs_apfs: Operation not permitted`），因此 `hdiutil` 無法在沙箱內建立磁碟映像。
> Tauri 的 `.app`、Electron 的 `.zip` 皆已驗證；DMG 需在 GitHub Actions runner 上產出。
> 這是**環境限制，不是設定錯誤**。

> ⚠️ **本機無法驗證 Windows 產物**：需在 Windows runner 上建置。
> 已驗證 Windows 路徑的**邏輯**：Node win-x64 壓縮檔結構與腳本假設一致
> （`node-v24.17.0-win-x64/node.exe`）。

---

## 已知限制

1. **首次啟動較慢**：大型藏經 vault（1.8 GB）首次會建立約 700 MB 的 bigram 索引。外殼的啟動逾時設為 120 秒並附說明訊息。
2. **ad-hoc 簽章版本仍會有警告**：macOS 顯示「未識別開發者」，需右鍵→打開（或見上方 §macOS 簽章）。
   ad-hoc 簽章已解決「應用程式已損毀」的誤判，但**無法**取代 Developer ID 公證；Windows 仍會有 SmartScreen 提示。
   正式散布需 Developer ID（USD 99/年）與 Windows 程式碼簽章憑證。
3. **未包含 Markdown 語料**：`md/`、`dicts/` 不進安裝檔，使用者首次啟動後將自己的藏經放入 `<USER_DATA>/md`。
4. **Windows 未簽章，可能被防毒或 Smart App Control 攔阻**：安裝檔本身未做程式碼簽章，
   可能出現 SmartScreen 警告，或被防毒軟體誤判隔離。詳見下方 §Windows 疑難排解。

### Windows 疑難排解

| 症狀 | 可能原因 | 處理方式 |
| :--- | :--- | :--- |
| 雙擊 portable `.exe` 出現「**Windows 無法存取指定的裝置、路徑或檔案**」 | 檔案被防毒軟體隔離／刪除，或下載不完整；此對話框由 Windows 殼層發出，表示程式**還沒開始執行** | 確認檔案仍在磁碟上（若已消失即為防毒所刪）；右鍵→內容→**解除封鎖**，或 `Unblock-File`；重新下載並比對檔案大小；改用具名安裝版 `.exe`（比 portable 少一層自解壓，較不易被誤判） |
| 安裝時出現 SmartScreen「Windows 已保護您的電腦」 | 未簽章的執行檔帶有 Mark-of-the-Web | 「更多資訊」→「仍要執行」；或先解除封鎖 |
| 程式完全無法啟動、沒有 Windows 殼層對話框 | 解壓縮階段失敗（`%TEMP%` 不可寫、空間不足） | 清出磁碟空間；確認 `%TEMP%` 可寫入 |

> **portable 版的運作方式**：每次啟動都會解壓到 `%TEMP%\<隨機名稱>`，
> 結束後刪除該目錄。因此 **portable 版不適合存放正式資料**——
> 啟動器結束時會連同該目錄一起刪除。需要長期保存請使用具名安裝版。
>
> **資料目錄**：Electron 版由 `desktop/electron/main.js` 顯式指定為
> `%APPDATA%\mdWebview-Electron`；若該位置無法建立（重導向／損毀的設定檔），
> 會依序退回 `%LOCALAPPDATA%\mdWebview-Electron`、再退回暫存目錄，
> 退回暫存目錄時會**明確警告**使用者，不會靜默搬移資料。
> 舊版曾使用的 `mdwebview-desktop` 目錄會在啟動時自動移轉過來。

