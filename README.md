# 🪷 mdWebview — 佛典經論閱讀器 / Buddhist Sutra Commentary Reader

[繁體中文](#繁體中文) | [English](#english)

---

## 繁體中文

`mdWebview` (v1.13.5) 是一款專為**佛典經論譯注與釋記**設計的網頁端 Obsidian 風格 Markdown 閱讀器。它提供輕量、流暢、排版精美的單頁應用（SPA）介面，支援數千篇大型經論檔案的極速閱讀、全文檢索與研習。

### ✨ 核心特色

- 📂 **Obsidian 風格檔案瀏覽器**：自動掃描 `md/` 資料夾下的多層級 Markdown 檔案，以樹狀目錄直觀呈現，支援名稱與修改時間動態排序、檔案數量標示與目錄全展/全折疊（配備自訂向量雙箭頭圖示）。
- 🔗 **Obsidian 雙向連結 ([[Wikilink]])**：支援 `[[頁面名稱]]`、`[[頁面名稱|顯示文字]]` 及 `[[頁面名稱#章節標題]]` 語法，點擊即可流暢切換並自動滾動高亮對應標題。
- ⚡ **多執行緒與高效能架構**：
  - **Worker Thread SSR**：將重度 CPU 運算的 Markdown 解析與註腳錨點生成移至背景工作執行緒池（Worker Threads），避免主事件迴圈卡死。
  - **全非同步非阻塞 I/O**：伺服器端全數採用 Promise-based 非同步檔案存取。
  - **智慧快取與 Gzip 壓縮**：結合記憶體 Tree 快取、弱 ETag（304 Not Modified）、靜態資源長效快取與動態 Gzip 壓縮，顯著降低網路傳輸與載入時間。
  - **前端 LRU 快取與演算法優化**：前端配備最近使用（LRU）渲染快取、`O(log N)` 二進位搜尋行號定位與 `O(1)` 大綱標籤映射。
- 🔍 **倒排索引與空白 AND 鄰近搜尋 (Proximity Search)**：
  - **Bigram 雙字元倒排索引**：後端建立全庫 2-gram 記憶體與二進位檔快取（`.bin`），支援 6,000+ 經文檔案毫秒級檢索。
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
- 🔎 **浮動本頁搜尋**：支援透過快速鍵喚出頁面內搜尋框（`Ctrl + F`），具備相符項目計數、高亮與前後切換功能。
- 🅰️ **動態字型與版寬控制**：可自由調整閱讀區域字型大小，預設基準根據管理員後台「預設字體大小」連動 UI 縮放。
- 🔗 **分享與精確跳轉**：支援 URL 參數分享（`?file=...&line=...`），能直接定位並亮顯目標行號；支援 `?frontpage=1` 或 `?home=1` 參數強制開啟首頁。
- 🔒 **安全性、後台管理與日誌修剪**：
  - 內建 PBKDF2 密碼雜湊防護、IP Rate-Limiting 防暴力破解與 Session 管理。
  - **後台控制台**： Segmented Control Pills 分頁、iOS 風格開關切換器、硬體系統監控、日誌檢視器與數據匯出 (CSV/JSON)。
  - **7 天 Log 修剪與全時段統計保留**：7 天以上歷史日誌自動精簡瘦身（節省 85% ~ 95% 空間），同時永久保留極簡統計資料以維護 `allTime` 全時段分析計算。
- 📦 **離線與自託管友善**：所有核心前端庫（如 Marked.js）皆改為本地託管，無外網 CDN 單點故障風險。
- 🐳 **Docker 與 CI/CD 支援**：內建 Dockerfile、`docker-compose.yml` 與 GitHub Actions，自動發布多平台 Docker Image 至 GHCR (`ghcr.io`)。

---

### 📂 專案結構

```text
mdWebview/
├── md/                 # 存放佛典經論 Markdown 檔案的目錄（支援多層資料夾）
├── index.html          # 主頁面結構與佈局
├── app.js              # 前端邏輯（樹狀圖、大綱、搜尋、字型、主題、LRU 快取、Wikilink、Toast）
├── style.css           # 樣式表（含主題色彩定義、自適應排版、Wikilink 樣式、Modal 彈窗）
├── md-worker.js        # 前端 Web Worker Markdown 解析器
├── render-worker.js    # Node.js Worker Thread SSR Markdown 渲染器
├── marked.min.js       # 本地託管 Marked.js 引擎
├── server.js           # Node.js 後端服務（Bigram 倒排索引、全非同步 API、Worker Pool、Gzip、後台）
├── config.json         # 系統設定檔 (包含後台管理員與 maxProximityDistance 設定)
├── Dockerfile          # Docker 容器構建設定檔
├── docker-compose.yml  # Docker Compose 部署設定檔
├── package.json        # 專案設定檔 (v1.13.1)
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

`mdWebview` (v1.13.5) is a web-based Obsidian-style Markdown reader specially designed for **Buddhist Sutra Commentaries and Scholastic Translations**. It provides a lightweight, fluent, and aesthetically pleasing Single Page Application (SPA) interface, capable of high-speed reading, full-text search, and study across thousands of large Markdown documents.

### ✨ Key Features

- 📂 **Obsidian-Style File Explorer**: Automatically scans multi-level Markdown files under the `md/` directory with auto-sorting, file count indicators, and custom vector dual-chevron Collapse/Expand icons.
- 🔗 **Obsidian Wikilinks ([[Wikilink]])**: Fully supports `[[page]]`, `[[page|display]]`, and `[[page#heading]]` syntaxes for seamless navigation and smooth scrolling to target headings.
- ⚡ **Multi-Threaded & High Performance Architecture**:
  - **Worker Thread SSR**: Offloads heavy CPU-bound Markdown parsing and footnote processing to background worker thread pools.
  - **Asynchronous Non-Blocking I/O**: Promise-based asynchronous file operations throughout the server.
  - **Smart Caching & Gzip Compression**: Combines memory tree caching, weak ETags (304 Not Modified), static asset caching, and dynamic Gzip compression.
  - **Frontend LRU Cache & Algorithm Optimizations**: Equipped with an LRU rendering cache, `O(log N)` binary search line positioning, and `O(1)` outline tag mapping.
- 🔍 **Bigram Inverted Index & Space-Separated AND Search with Proximity Filtering**:
  - **Bigram Inverted Index**: Server-side 2-gram in-memory and binary disk cache (`.bin`) for sub-millisecond search across 6,000+ commentary files.
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
- 🔎 **In-Page Search**: Floating in-page search bar (`Ctrl + F`) with match counts and previous/next navigation.
- 🅰️ **Dynamic Font & Width Scaling**: Easily scale reading font size and container max width.
- 🔗 **URL Sharing & Deep Linking**: Share exact reading positions using `?file=...&line=...`, or force frontpage display with `?frontpage=1`.
- 🔒 **Security, Admin Panel & 7-Day Log Pruning**:
  - Built-in PBKDF2 password hashing, IP rate limiting, and session management.
  - Admin Panel with Segmented Control Pills, iOS-style toggle switches, hardware system monitor, log viewer, and CSV/JSON analytics export.
  - **7-Day Log Pruning**: Log files older than 7 days are automatically pruned (saving 85%–95% disk space) while permanently retaining lightweight analytics data for `allTime` calculations.
- 📦 **Offline & Self-Hosting Friendly**: Fully self-hosted core frontend libraries with zero external CDN dependencies.
- 🐳 **Docker & CI/CD Integration**: Includes Dockerfile, `docker-compose.yml`, and GitHub Actions workflow for multi-arch container image publishing (`ghcr.io`).

---

### 📂 Project Structure

```text
mdWebview/
├── md/                 # Directory containing Buddhist commentary Markdown files
├── index.html          # Main HTML application page
├── app.js              # Frontend logic (Tree view, TOC, search, themes, LRU cache, Wikilinks, Toast)
├── style.css           # Styling (Themes, responsive layout, Wikilinks, Modals)
├── md-worker.js        # Frontend Web Worker Markdown parser
├── render-worker.js    # Node.js Worker Thread SSR Markdown renderer
├── marked.min.js       # Self-hosted Marked.js engine
├── server.js           # Node.js backend server (Bigram index, Async APIs, Worker Pool, Gzip, Admin)
├── config.json         # Configuration file (Admin setup & maxProximityDistance)
├── Dockerfile          # Docker image build configuration
├── docker-compose.yml  # Docker Compose deployment setup
├── package.json        # Node.js package manifest (v1.13.1)
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
