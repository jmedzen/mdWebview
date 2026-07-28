# 🪷 mdWebview — 佛典經論閱讀器 / Buddhist Sutra Commentary Reader

[繁體中文](#-繁體中文) | [English](#-english)

---

## 🇭🇰 繁體中文

`mdWebview` 是一款專為**佛典經論譯注與釋記**設計的網頁端 Obsidian 風格 Markdown 閱讀器。它提供輕量、流暢、排版精美的單頁應用（SPA）介面，支援數千篇大型經論檔案的極速閱讀、全文檢索與研習。

### ✨ 核心特色

- 📂 **Obsidian 風格檔案瀏覽器**：自動掃描 `md/` 資料夾下的多層級 Markdown 檔案，以樹狀目錄直觀呈現，支援自動排序與檔案數量標示，無大量檔案截斷限制。
- 🔗 **Obsidian 雙向連結 ([[Wikilink]])**：支援 `[[頁面名稱]]`、`[[頁面名稱|顯示文字]]` 及 `[[頁面名稱#章節標題]]` 語法，點擊即可流暢切換並自動滾動高亮對應標題。
- ⚡ **多執行緒與高效能架構**：
  - **Worker Thread SSR**：將重度 CPU 運算的 Markdown 解析與註腳錨點生成移至背景工作執行緒池（Worker Threads），避免主事件迴圈卡死。
  - **全非同步非阻塞 I/O**：伺服器端全數採用 Promise-based 非同步檔案存取。
  - **智慧快取與 Gzip 壓縮**：結合記憶體 Tree 快取、弱 ETag（304 Not Modified）、靜態資源長效快取與動態 Gzip 壓縮，顯著降低網路傳輸與載入時間。
  - **前端 LRU 快取與演算法優化**：前端配備最近使用（LRU）渲染快取、`O(log N)` 二進位搜尋行號定位與 `O(1)` 大綱標籤映射。
- 🔍 **高效全文搜尋**：伺服器端高效檢索所有經論內容，提供關鍵字定位與前後文上下文片段（Snippet）預覽，點擊搜尋結果即可直接跳轉至該位置。
- 📑 **自動大綱導航 (TOC)**：開啟經論檔案後，自動解析 Markdown 標題（H1~H6）並動態生成側邊欄大綱，支援點擊滾動與閱讀進度追蹤（ScrollSpy）。
- 🎨 **五種精緻閱讀主題**：
  - 🌙 **Obsidian Dark** (深色科技)
  - ☀️ **Obsidian Light** (明亮清新)
  - 🔆 **Solarized** (經典護眼)
  - 🍵 **禪風 Zen** (平和淡雅)
  - 📜 **經典金 Classic Gold** (復古溫潤)
- 🔎 **浮動本頁搜尋**：支援透過快速鍵喚出頁面內搜尋框（`Ctrl + F`），具備相符項目計數、高亮與前後切換功能。
- 🅰️ **動態字型縮放**：可自由調整閱讀區域字型大小（`Ctrl + +` / `Ctrl + -`），體貼不同視力需求的讀者。
- 🔗 **分享與精確跳轉**：支援 URL 參數分享（`?file=...&line=...`），能直接定位並亮顯目標行號。
- 🔒 **安全性與後台管理**：內建 PBKDF2 密碼雜湊防護、IP Rate-Limiting 防暴力破解、Session 管理與後台設定介面。
- 📦 **離線與自託管友善**：所有核心前端庫（如 Marked.js）皆改為本地託管，無外網 CDN 單點故障風險。
- 🐳 **Docker 與 CI/CD 支援**：內建 Dockerfile、`docker-compose.yml` 與 GitHub Actions，自動發布多平台 Docker Image 至 GHCR (`ghcr.io`)。

---

### 📂 專案結構

```text
mdWebview/
├── md/                 # 存放佛典經論 Markdown 檔案的目錄（支援多層資料夾）
│   ├── 成唯識論釋記/
│   ├── 金剛經論釋記/
│   └── ...
├── index.html          # 主頁面結構與佈局
├── app.js              # 前端邏輯（樹狀圖、大綱、搜尋、字型、主題、LRU 快取、Wikilink）
├── style.css           # 樣式表（含主題色彩定義、自適應排版、Wikilink 樣式）
├── md-worker.js        # 前端 Web Worker Markdown 解析器
├── render-worker.js    # Node.js Worker Thread SSR Markdown 渲染器
├── marked.min.js       # 本地託管 Marked.js 引擎
├── server.js           # Node.js 後端服務（全非同步 API、Worker Pool、Gzip、ETag、後台）
├── Dockerfile          # Docker 容器構建設定檔
├── docker-compose.yml  # Docker Compose 部署設定檔
├── package.json        # 專案設定檔
└── README.md           # 本說明文件
```

---

### 🚀 快速開始

#### 1. 使用 Node.js 本地執行
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
```bash
docker-compose up -d
```

---

### ⌨️ 快捷鍵指南

| 快捷鍵 | 功能說明 |
| :--- | :--- |
| <kbd>Ctrl</kbd> + <kbd>F</kbd> 或 <kbd>Cmd</kbd> + <kbd>F</kbd> | 開啟本頁搜尋框 |
| <kbd>Esc</kbd> | 關閉本頁搜尋框 |
| <kbd>Enter</kbd> / <kbd>Shift</kbd> + <kbd>Enter</kbd> | 搜尋框開啟時，跳轉至下一個 / 上一個符合項 |
| <kbd>Ctrl</kbd> + <kbd>+</kbd> 或 <kbd>Cmd</kbd> + <kbd>+</kbd> | 放大閱讀區域字型 |
| <kbd>Ctrl</kbd> + <kbd>-</kbd> 或 <kbd>Cmd</kbd> + <kbd>-</kbd> | 縮小閱讀區域字型 |

---

### 📝 經論 Markdown 撰寫規範建議

1. **標題階層**：使用 `#`、`##`、`###` 標示章節目錄，將自動解析為側邊欄大綱。
2. **Obsidian 雙向連結**：可使用 `[[目標檔案名]]` 或 `[[目標檔案名#章節標題]]` 建立內部關聯與快速跳轉。
3. **註腳支援**：標準 Markdown 註腳格式，例如：
   ```markdown
   論文 餘九皆通見、修所斷。[^1]
   
   [^1]: 指其餘九支皆通於見道與修道所斷。
   ```

---

<br/>

---

## 🇬🇧 English

`mdWebview` is a web-based Obsidian-style Markdown reader specially designed for **Buddhist Sutra Commentaries and Scholastic Translations**. It provides a lightweight, fluent, and aesthetically pleasing Single Page Application (SPA) interface, capable of high-speed reading, full-text search, and study across thousands of large Markdown documents.

### ✨ Key Features

- 📂 **Obsidian-Style File Explorer**: Automatically scans multi-level Markdown files under the `md/` directory and renders a directory tree with auto-sorting and file counts.
- 🔗 **Obsidian Wikilinks ([[Wikilink]])**: Fully supports `[[page]]`, `[[page|display]]`, and `[[page#heading]]` syntaxes for seamless navigation and smooth scrolling to target headings.
- ⚡ **Multi-Threaded & High Performance Architecture**:
  - **Worker Thread SSR**: Offloads heavy CPU-bound Markdown parsing and footnote processing to background worker thread pools.
  - **Asynchronous Non-Blocking I/O**: Promise-based asynchronous file operations throughout the server.
  - **Smart Caching & Gzip Compression**: Combines memory tree caching, weak ETags (304 Not Modified), static asset caching, and dynamic Gzip compression.
  - **Frontend LRU Cache & Algorithm Optimizations**: Equipped with an LRU rendering cache, `O(log N)` binary search line positioning, and `O(1)` outline tag mapping.
- 🔍 **Fast Full-Text Search**: Server-side full-text search across all commentaries with keyword highlighting and snippet preview.
- 📑 **Auto Outline Navigation (TOC)**: Dynamically parses Markdown headings (H1–H6) into a sidebar table of contents with click-to-scroll and ScrollSpy progress tracking.
- 🎨 **Five Curated Reading Themes**:
  - 🌙 **Obsidian Dark**
  - ☀️ **Obsidian Light**
  - 🔆 **Solarized**
  - 🍵 **Zen**
  - 📜 **Classic Gold**
- 🔎 **In-Page Search**: Floating in-page search bar (`Ctrl + F`) with match counts and previous/next navigation.
- 🅰️ **Dynamic Font Resizing**: Easily scale reading font size (`Ctrl + +` / `Ctrl + -`).
- 🔗 **URL Deep Linking**: Share exact reading positions using URL parameters (`?file=...&line=...`).
- 🔒 **Security & Admin Dashboard**: Built-in PBKDF2 password hashing, IP rate limiting, session management, and settings control panel.
- 📦 **Offline & Self-Hosting Friendly**: Fully self-hosted core frontend libraries with zero external CDN dependencies.
- 🐳 **Docker & CI/CD Integration**: Includes Dockerfile, `docker-compose.yml`, and GitHub Actions workflow for multi-arch container image publishing (`ghcr.io`).

---

### 📂 Project Structure

```text
mdWebview/
├── md/                 # Directory containing Buddhist commentary Markdown files
│   ├── 成唯識論釋記/
│   ├── 金剛經論釋記/
│   └── ...
├── index.html          # Main HTML application page
├── app.js              # Frontend logic (Tree view, TOC, search, themes, LRU cache, Wikilinks)
├── style.css           # Styling (Themes, responsive layout, Wikilinks)
├── md-worker.js        # Frontend Web Worker Markdown parser
├── render-worker.js    # Node.js Worker Thread SSR Markdown renderer
├── marked.min.js       # Self-hosted Marked.js engine
├── server.js           # Node.js backend server (Async APIs, Worker Pool, Gzip, ETag, Admin)
├── Dockerfile          # Docker image build configuration
├── docker-compose.yml  # Docker Compose deployment setup
├── package.json        # Node.js package manifest
└── README.md           # Project documentation
```

---

### 🚀 Quick Start

#### 1. Local Run with Node.js
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
```bash
docker-compose up -d
```

---

### ⌨️ Keyboard Shortcuts

| Shortcut | Description |
| :--- | :--- |
| <kbd>Ctrl</kbd> + <kbd>F</kbd> or <kbd>Cmd</kbd> + <kbd>F</kbd> | Open in-page search bar |
| <kbd>Esc</kbd> | Close in-page search bar |
| <kbd>Enter</kbd> / <kbd>Shift</kbd> + <kbd>Enter</kbd> | Jump to next / previous match when search bar is open |
| <kbd>Ctrl</kbd> + <kbd>+</kbd> or <kbd>Cmd</kbd> + <kbd>+</kbd> | Increase font size |
| <kbd>Ctrl</kbd> + <kbd>-</kbd> or <kbd>Cmd</kbd> + <kbd>-</kbd> | Decrease font size |

---

### 📝 Markdown Formatting Tips

1. **Heading Structure**: Use `#`, `##`, `###` headings to automatically build the sidebar Table of Contents.
2. **Obsidian Wikilinks**: Use `[[filename]]` or `[[filename#heading]]` for internal cross-references and deep jumping.
3. **Footnote Support**: Standard Markdown footnote syntax:
   ```markdown
   Sutra passage text.[^1]
   
   [^1]: Scholastic commentary or translation note.
   ```
