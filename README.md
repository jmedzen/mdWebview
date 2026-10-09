# 🪷 mdWebview — 佛典經論閱讀器 / Buddhist Sutra Commentary Reader

[繁體中文](#繁體中文) | [English](#english)

---

## 繁體中文

`mdWebview` (v3.6.6) 是一款專為**佛典經論譯注與釋記**設計的網頁端 Obsidian 風格 Markdown 閱讀器。它提供輕量、流暢、排版精美的單頁應用（SPA）介面，支援數千篇大型經論檔案的極速閱讀、全文檢索與研習。

### ✨ 核心特色

- 📂 **Obsidian 風格檔案瀏覽器**：自動掃描 `md/` 資料夾下的多層級 Markdown 檔案，以樹狀目錄直觀呈現，支援名稱與修改時間動態排序、檔案數量標示與目錄全展/全折疊（配備自訂向量雙箭頭圖示）。
- 🔗 **Obsidian 雙向連結 ([[Wikilink]])**：支援 `[[頁面名稱]]`、`[[頁面名稱|顯示文字]]` 及 `[[頁面名稱#章節標題]]` 語法，點擊即可流暢切換並自動滾動高亮對應標題。
- ⚡ **多執行緒與高效能架構**：
  - **Worker Thread SSR 與背壓防護**：將重度 CPU 運算的 Markdown 解析與註腳錨點生成移至背景工作執行緒池（Worker Threads）。配備佇列上限防爆（503 Backpressure）、任務入列即時計時（30s 逾時隔離）、連線中斷即刻取消 (`req.on('close')`) 與 15 秒 8 次崩潰退避重生機制。
  - **全非同步非阻塞 I/O**：伺服器端全數採用 Promise-based 非同步檔案存取，目錄樹掃描與設定記憶化快取杜絕 Event Loop 凍結。
  - **智慧快取與 Gzip 壓縮**：結合記憶體 Tree 快取、弱 ETag（304 Not Modified）、500 筆 LRU 靜態資源長效快取與動態 Gzip 壓縮，顯著降低網路傳輸與載入時間。
  - **前端 LRU 快取與前端並發守衛**：前端配備最近使用（LRU）渲染快取、世代守衛標記（`_openToken`，徹底杜絕快速切換檔案時舊請求覆蓋新畫面）、`AbortController` 請求取消、二分搜尋閱讀進度儲存（杜絕 Layout Thrashing）與 `O(1)` 大綱標籤映射。
- 🔍 **倒排索引與空白 AND 鄰近搜尋 (Proximity Search)**：
  - **Bigram 雙字元倒排索引**：後端建立標點/換行透明全庫 2-gram 記憶體與二進位檔快取（`.bin`），支援 6,000+ 經文檔案毫秒級檢索。
  - **寬鬆模式（忽略標點與換行）**：支援一鍵切換寬鬆比對模式，自動忽略標點符號與換行（例如搜尋「佛法僧」可精準命中「佛法，僧」、「佛、法、僧」或跨行「佛法\n僧」）；空白仍為多詞分隔（走 AND 與鄰近距離比對）。全站預設為寬鬆模式，使用者偏好儲存於 localStorage，管理員可於後台調整。
  - **單飛重建互斥 (Single-Flight)**：索引防抖與管理員重建共用單飛旗標，杜絕並行重複計算與暫存檔寫入衝突。
  - **空白多關鍵詞 AND 搜尋**：支援輸入 `阿賴耶識 唯識` 或 `解深密經 圓測` 空白分隔關鍵詞進行交集比對。
  - **鄰近詞距上限限制 (Proximity Filtering)**：自動過濾字詞相隔過遠的非相關結果。可在管理員後台面板自訂「搜尋鄰近詞距上限」（預設 150 字元）。
- 📑 **自動大綱導航 (TOC)**：開啟經論檔案後，自動解析 Markdown 標題（H1~H6）並動態生成側邊欄大綱，支援點擊滾動與閱讀進度追蹤（ScrollSpy）。
- 🔔 **全系統 Toast 提示訊息**：全站操作（複製連結、書籤、歷史記錄、主題切換、搜尋、管理員登入/儲存/數據導出）配備毛玻璃動畫 Toast 提示與 `success` / `warning` / `error` / `info` 狀態燈號。
- 🎨 **五種精緻閱讀主題**：
  - 🌙 **暗色 Dark** (深色科技)
  - ☀️ **亮色 Light** (明亮清新)
  - 🔆 **Solarized** (經典護眼)
  - 🍵 **禪風 Zen** (平和淡雅)
  - 🍂 **Gruvbox** (暖色復古)
- 📱 **使用者設定與視覺排版自訂**：
  - **視覺排版面板**：自由調整字型大小、行高（1.6 / 1.8 / 2.0）、文字對齊方式與閱讀版寬（800px / 1000px / 100%）。
  - **簡體中文自動轉繁體 (autoS2T)**：整合至視覺排版 Tab，UI 深度匹配 5 種主題風格；全站預設為關閉 (`false`)，使用者偏好保存於 `localStorage`，搜尋請求自動同步轉換。
  - **閱讀進度記憶**：支援自動記錄與還原個別篇章滾動位置。
- 🔎 **浮動本頁搜尋**：支援透過快速鍵喚出頁面內搜尋框（`Ctrl + F`），具備相符項目計數、高亮與前後切換功能。
- 🔗 **分享與精確跳轉**：支援 URL 參數分享（`?file=...&line=...`），能直接定位並亮顯目標行號；支援 `?frontpage=1` 或 `?home=1` 參數強制開啟首頁。
- 🌐 **全方位 SEO、Sitemap 防抖與社群卡片**：
  - **Sitemap 20 秒智慧防抖**：檔案變更時啟動 20 秒延遲沉降防抖，避免大量檔案寫入時頻繁掃描磁碟造成 CPU / I/O 尖峰。
  - **Stale-While-Revalidate 機制**：防抖期間或更新時瞬時回傳現存快取（0ms 阻塞），沉降後背景非同步自動更新。
  - **SEO 與社群標籤**：內建爬蟲專用 SSR 預渲染、Schema.org JSON-LD 結構化資料、開機背景預熱快取，並提供後台 OpenGraph 即時預覽。
- 🔒 **安全性、後台管理與日誌修剪**：
  - 內建 PBKDF2 密碼雜湊防護、IP Rate-Limiting 防暴力破解與 Session 管理。
  - **嚴格安全防禦**：Footnote 註腳 XSS 雙重消毒與屬性跳脫、畸形 Host 標頭 400 防禦與連線逾時銷毀（防 DoS）、嚴格信任代理白名單（防 IP 偽造）、Analytics 匯出同源驗證。
  - **後台控制台**： Segmented Control Pills 分頁、iOS 風格開關切換器、硬體系統監控、日誌檢視器與數據匯出 (CSV/JSON)。
  - **90 天 Analytics 淘汰與 7 天 Log 修剪**：Analytics store 每日 bucket 90 天自動修剪；7 天以上歷史日誌自動精簡瘦身（節省 85% ~ 95% 空間），同時保留全時段關鍵計數。
- 📦 **離線與自託管友善**：所有核心前端庫（如 Marked.js）皆改為本地託管，無外網 CDN 單點故障風險；Service Worker 離線提供明確 504 回退並支援無縫即時更新（`SKIP_WAITING`）。
- 🐳 **Docker 與 GitHub Actions 自動化 CI/CD**：
  - **多平台映像檔構建**：內建 Dockerfile、`docker-compose.yml` 與 GitHub Actions，自動發布 `linux/amd64` 與 `linux/arm64` 雙架構 Docker Image 至 GHCR (`ghcr.io`)。
  - **GHCR 自動清理工作流程**：配備自動映像檔修剪維護機制（`cleanup-ghcr.yml`），構建完成後全自動執行或每週定時排程，自動保留最新 5 個版本、保護 `latest`/`main`/`dev` 分支標籤，並徹底清除未標記（untagged）與孤立 multi-arch 子層。

---

### 📂 專案結構

> 📐 **深入架構說明**：請參閱 [`ARCHITECTURE.md`](./ARCHITECTURE.md)，含系統架構圖、API 路由索引、State 物件說明、config 欄位一覽。

```text
mdWebview/
├── .github/workflows/  # GitHub Actions 自動化工作流程
│   ├── docker-image.yml# 多平台 Docker 映像檔構建與發布 (GHCR)
│   └── cleanup-ghcr.yml# GHCR 映像檔自動清理維護（保留最新 5 版本）
├── md/                 # 存放 Markdown 文件庫（支援多層資料夾）
├── dicts/              # 辭典檔案目錄（.txt 格式，每條目 === 分隔）
├── tests/              # Node.js 原生測試套件（單元測試與 API 整合測試）
├── index.html          # 前端 SPA Shell（含 PWA manifest 引用、SSR 注入點）
├── app.js              # 前端邏輯（狀態管理、樹狀圖、大綱、搜尋、辭典、主題、管理員面板）
├── style.css           # 樣式系統（5 主題、響應式、Glassmorphism、Markdown 增強）
├── sw.js               # Service Worker（PWA 離線快取）
├── md-worker.js        # 前端 Web Worker：Markdown 解析（在瀏覽器背景執行緒執行）
├── render-worker.js    # Node.js Worker Thread：SSR Markdown 渲染（伺服器端）
├── index-worker.js     # Node.js Worker Thread：Bigram 倒排索引建立與搜尋
├── marked.min.js       # 本地託管 Marked.js 引擎（無外部 CDN 依賴）
├── s2t.js              # 簡繁轉換模組（搜尋時自動處理簡體輸入）
├── manifest.json       # PWA Manifest 靜態預設（執行期由 server.js 動態覆寫）
├── lib/                # 核心原生 CommonJS 模組（constants, utils, config, auth, worker-pool, analytics, logger, static-cache, text）
├── server.js           # Node.js 後端主服務（HTTP 路由入口、API 分發、定時維護）
├── config.json         # 系統設定（站名、主題、辭典、公告、推薦清單等，後台儲存後持久化）
├── ARCHITECTURE.md     # 📐 架構說明文件（API 索引、State 說明、資料流圖）
├── Dockerfile          # Docker 容器構建設定
├── docker-compose.yml  # Docker Compose 部署設定
├── package.json        # Node.js 套件設定（v3.6.6）
└── README.md           # 本說明文件
```

---

### 🚀 快速開始

#### 1. 使用 Node.js 本地執行
- 系統需求：需安裝 **Node.js** v24 或以上版本。

```bash
# 啟動伺服器
npm start
# 或
npm run dev
# 或直接執行
node server.js
```
預設伺服器埠號為 `http://localhost:8330`。

#### 2. 使用 Docker Compose 部署
> 💡 **提示**：管理員於後台（`/admin`）調整並儲存的所有設定皆會自動持久化儲存於 `./data/config.json`，在 Docker Image 升級或容器重啟後皆會持續保留。

```yaml
version: '3.8'
services:
  mdWebview:
    image: ghcr.io/jmedzen/mdwebview:latest
    container_name: mdWebview
    ports:
      - "8330:8330"
    environment:
      - PORT=8330
      - CONFIG_PATH=/data/config.json
      - MD_ROOT=/data/md
      - DICTIONARY_PATH=/data/dicts
    volumes:
      - ./data:/data
      - ./md:/data/md
      - ./dicts:/data/dicts
    restart: unless-stopped
```

```bash
docker-compose up -d
```

---

### ⌨️ 快捷鍵與 URL 參數指南

| 快捷鍵 / URL 參數 | 功能說明 |
| :--- | :--- |
| <kbd>Ctrl</kbd> + <kbd>F</kbd> 或 <kbd>Cmd</kbd> + <kbd>F</kbd> | 開啟本頁搜尋框 |
| <kbd>Esc</kbd> | 關閉本頁搜尋框 / 退出使用者與後台設定彈窗 Modal |
| <kbd>Enter</kbd> / <kbd>Shift</kbd> + <kbd>Enter</kbd> | 搜尋框開啟時，跳轉至下一個 / 上一個符合項 |
| <kbd>Ctrl</kbd> + <kbd>+</kbd> 或 <kbd>Cmd</kbd> + <kbd>+</kbd> | 放大閱讀區域字型 |
| <kbd>Ctrl</kbd> + <kbd>-</kbd> 或 <kbd>Cmd</kbd> + <kbd>-</kbd> | 縮小閱讀區域字型 |
| `?file=路徑&line=行號` | 分享特定經論與精確跳轉至指定行號 |
| `?frontpage=1` 或 `?home=1` | 強制開啟首頁 (Frontpage) 歡迎畫面 |

---

### 📝 經論 Markdown 撰寫規範建議

1. **標題階層**：使用 `#`、`##`、`###` 標示章節目錄，將自動解析為側邊欄大綱。
2. **Obsidian 雙向連結**：可使用 `[[目標檔案名]]` 或 `[[目標檔案名#章節標題]]` 建立內部關聯與快速跳轉。
3. **單波浪號與刪除線**：單個波浪號 `P11~P12` 或 `10~20` 維持原樣呈現；僅雙波浪號 `~~刪除文字~~` 會解析為刪除線。
4. **註腳支援**：標準 Markdown 註腳格式，例如：
   ```markdown
   論文 餘九皆通見、修所斷。[^1]
   
   [^1]: 指其餘九支皆通於見道與修道所斷。
   ```

---

<br/>

---

## English

`mdWebview` (v3.6.6) is a web-based Obsidian-style Markdown reader specially designed for **Buddhist Sutra Commentaries and Scholastic Translations**. It provides a lightweight, fluent, and aesthetically pleasing Single Page Application (SPA) interface, capable of high-speed reading, full-text search, and study across thousands of large Markdown documents.

### ✨ Key Features

- 📂 **Obsidian-Style File Explorer**: Automatically scans multi-level Markdown files under the `md/` directory with auto-sorting, file count indicators, and custom vector dual-chevron Collapse/Expand icons.
- 🔗 **Obsidian Wikilinks ([[Wikilink]])**: Fully supports `[[page]]`, `[[page|display]]`, and `[[page#heading]]` syntaxes for seamless navigation and smooth scrolling to target headings.
- ⚡ **Multi-Threaded & High Performance Architecture**:
  - **Worker Thread SSR with Backpressure**: Offloads heavy CPU-bound Markdown parsing and footnote processing to background worker thread pools. Protected by queue bounds (`503 Service Unavailable` backpressure), entry-level 30s timers, client disconnect cancellation (`req.on('close')`), and crash-loop backoff retry (up to 8 times within 15 seconds).
  - **Asynchronous Non-Blocking I/O**: Promise-based asynchronous file operations throughout the server. Directory tree scanning and settings memoization prevent Event Loop stalls.
  - **Smart Caching & Gzip Compression**: Combines memory tree caching, weak ETags (304 Not Modified), 500-entry LRU static asset caching, and dynamic Gzip compression.
  - **Frontend LRU Cache & Concurrency Guard**: Equipped with an LRU rendering cache, generation guard tokens (`_openToken` to prevent out-of-order document rendering races), `AbortController` cancellation, binary search reading progress saving (eliminating layout thrashing), and `O(1)` outline tag mapping.
- 🔍 **Bigram Inverted Index & Space-Separated AND Search with Proximity Filtering**:
  - **Bigram Inverted Index**: Server-side 2-gram in-memory and binary disk cache (`.bin`) for sub-millisecond search across 6,000+ commentary files.
  - **Single-Flight Rebuild**: Serializes concurrent index build requests between file watcher debounce and admin triggers to prevent memory doubling.
  - **Multi-Term AND Search**: Supports space-separated queries (e.g., `阿賴耶識 唯識`).
  - **Proximity Distance Filtering**: Filters out matches where terms are too far apart. Maximum character distance (`MAX_PROXIMITY_DISTANCE`) is configurable in the Admin Panel (default 150 chars).
- 📑 **Auto Outline Navigation (TOC)**: Dynamically parses Markdown headings (H1–H6) into a sidebar table of contents with click-to-scroll and ScrollSpy progress tracking.
- 🔔 **Systemwide Toast Notifications**: Glassmorphism toast alerts with `success`, `warning`, `error`, and `info` status badges across all user actions.
- 🎨 **Five Curated Reading Themes**:
  - 🌙 **Obsidian Dark**
  - ☀️ **Obsidian Light**
  - 🔆 **Solarized**
  - 🍵 **Zen**
  - 🍂 **Gruvbox**
- 📱 **User Preferences & Visual Typography**:
  - **Typography Settings**: Adjust font size, line height (1.6 / 1.8 / 2.0), text alignment, and reading max width (800px / 1000px / 100%).
  - **Auto Simplified-to-Traditional Chinese (autoS2T)**: Integrated into the Appearance & Typography tab with full theme palette match; defaults to `false` systemwide, persisted per user in `localStorage`, and automatically passes `s2t` parameters to search queries.
  - **Reading Progress Tracking**: Automatically records and restores scroll positions across documents.
- 🔎 **In-Page Search**: Floating in-page search bar (`Ctrl + F`) with match counts and previous/next navigation.
- 🔗 **URL Sharing & Deep Linking**: Share exact reading positions using `?file=...&line=...`, or force frontpage display with `?frontpage=1`.
- 🌐 **Comprehensive SEO, Debounced Sitemap & Social Cards**:
  - **20-Second Sitemap Debounce**: Automatically debounces file changes over a 20-second quiet period, preventing disk scanning CPU spikes during bulk uploads.
  - **Stale-While-Revalidate**: Immediately serves cached sitemap instances (0ms latency) during debounce windows or rebuilds.
  - **Crawler SSR & Metadata**: Pre-renders crawler-specific HTML with Schema.org JSON-LD structured data and live OpenGraph social card previews.
- 🔒 **Security, Admin Panel & 90-Day Analytics Pruning**:
  - Built-in PBKDF2 password hashing, IP rate limiting, and session management.
  - **Strict Security Hardening**: Double sanitization and attribute escaping on footnote elements (XSS defense), malformed Host header 400 rejection and socket timeout destruction (DoS prevention), strict trusted proxy CIDR whitelist, and mandatory Same-Origin verification on analytics exports.
  - Admin Panel with Segmented Control Pills, iOS-style toggle switches, hardware system monitor, log viewer, and CSV/JSON analytics export.
  - **90-Day Analytics & 7-Day Log Pruning**: Automatic 90-day retention on daily analytics buckets with map pruning; raw log files older than 7 days are automatically pruned while permanently preserving key all-time aggregates.
- 📦 **Offline & Self-Hosting Friendly**: Fully self-hosted core frontend libraries with zero external CDN dependencies; Service Worker provides clean 504 offline fallback and seamless immediate updates (`SKIP_WAITING`).
- 🐳 **Docker & GitHub Actions Automated CI/CD**:
  - **Multi-Architecture Builds**: Automatically builds and publishes multi-platform (`linux/amd64`, `linux/arm64`) container images to GitHub Container Registry (`ghcr.io`).
  - **GHCR Automated Image Cleanup**: Built-in retention workflow (`cleanup-ghcr.yml`) triggered automatically after image builds or via weekly schedule, retaining the latest 5 versions, protecting `latest`/`main`/`dev` pointer tags, and safely purging untagged/orphaned manifests.

---

### 📂 Project Structure

> 📐 **Deep-dive architecture**: See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for system diagrams, API route index, State field reference, and config field reference.

```text
mdWebview/
├── .github/workflows/  # GitHub Actions automated workflows
│   ├── docker-image.yml# Multi-arch Docker image build & publish to GHCR
│   └── cleanup-ghcr.yml# Automated GHCR image pruning (retains latest 5 versions)
├── md/                 # Markdown document vault (supports nested directories)
├── dicts/              # Dictionary files directory (.txt, entries separated by ===)
├── tests/              # Native Node.js test suite (unit and API integration tests)
├── index.html          # Frontend SPA shell (SSR injection point, PWA manifest link)
├── app.js              # Frontend logic (state, tree, TOC, search, dict, themes, admin panel)
├── style.css           # Style system (5 themes, responsive, Glassmorphism, Markdown enhancements)
├── sw.js               # Service Worker (PWA offline caching)
├── md-worker.js        # Frontend Web Worker: Markdown parsing (browser background thread)
├── render-worker.js    # Node.js Worker Thread: SSR Markdown rendering (server-side)
├── index-worker.js     # Node.js Worker Thread: Bigram inverted index build & search
├── marked.min.js       # Self-hosted Marked.js engine (zero external CDN dependency)
├── s2t.js              # Simplified-to-Traditional Chinese converter (for search input)
├── manifest.json       # PWA Manifest static defaults (overridden at runtime by server.js)
├── lib/                # Core native CommonJS modules (constants, utils, config, auth, worker-pool, analytics, logger, static-cache)
├── server.js           # Node.js backend server (HTTP router, API dispatch, background maintenance)
├── config.json         # System config (site name, theme, dict, announcements, suggest list)
├── ARCHITECTURE.md     # 📐 Architecture reference (API index, State fields, data flow diagrams)
├── Dockerfile          # Docker image build configuration
├── docker-compose.yml  # Docker Compose deployment setup
├── package.json        # Node.js package manifest (v3.6.6)
└── README.md           # Project documentation
```

---

### 🚀 Quick Start

#### 1. Local Run with Node.js
- Prerequisites: **Node.js** v24 or above recommended.

```bash
# Start server
npm start
# or
npm run dev
# or direct run
node server.js
```
The default server URL is `http://localhost:8330`.

#### 2. Deploy with Docker Compose
> 💡 **Note**: All settings configured and saved via the Admin Panel (`/admin`) are automatically persisted in `./data/config.json` and will be strictly preserved across Docker image updates and container restarts.

```yaml
version: '3.8'
services:
  mdWebview:
    image: ghcr.io/jmedzen/mdwebview:latest
    container_name: mdWebview
    ports:
      - "8330:8330"
    environment:
      - PORT=8330
      - CONFIG_PATH=/data/config.json
      - MD_ROOT=/data/md
      - DICTIONARY_PATH=/data/dicts
    volumes:
      - ./data:/data
      - ./md:/data/md
      - ./dicts:/data/dicts
    restart: unless-stopped
```

```bash
docker-compose up -d
```

---

### 3. Keyboard Shortcuts & URL Parameters

| Shortcut / URL Parameter | Description |
| :--- | :--- |
| <kbd>Ctrl</kbd> + <kbd>F</kbd> or <kbd>Cmd</kbd> + <kbd>F</kbd> | Open in-page search bar |
| <kbd>Esc</kbd> | Close in-page search bar / Exit settings modals |
| <kbd>Enter</kbd> / <kbd>Shift</kbd> + <kbd>Enter</kbd> | Jump to next / previous match when search bar is open |
| <kbd>Ctrl</kbd> + <kbd>+</kbd> or <kbd>Cmd</kbd> + <kbd>+</kbd> | Increase font size |
| <kbd>Ctrl</kbd> + <kbd>-</kbd> or <kbd>Cmd</kbd> + <kbd>-</kbd> | Decrease font size |
| `?file=PATH&line=NUM` | Deep link to specific commentary and line number |
| `?frontpage=1` or `?home=1` | Force display of the frontpage (Welcome Screen) |

---

### 📝 Markdown Formatting Tips

1. **Heading Structure**: Use `#`, `##`, `###` headings to automatically build the sidebar Table of Contents.
2. **Obsidian Wikilinks**: Use `[[filename]]` or `[[filename#heading]]` for internal cross-references and deep jumping.
3. **Footnote Support**: Standard Markdown footnote syntax:
   ```markdown
   Sutra passage text.[^1]
   
   [^1]: Scholastic commentary or translation note.
   ```
