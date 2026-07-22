# 🪷 mdWebview — 佛典經論閱讀器

mdWebview 是一款專為**佛典經論譯注與釋記**設計的網頁端 Obsidian 風格 Markdown 閱讀器。它提供輕量、流暢、排版精美的單頁應用（SPA）介面，支援數千篇大型經論檔案的極速閱讀、全文檢索與研習。

---

## ✨ 核心特色

- 📂 **Obsidian 風格檔案瀏覽器**：自動掃描 `md/` 資料夾下的多層級 Markdown 檔案，以樹狀目錄直觀呈現，支援自動排序與檔案數量標示，無大量檔案截斷限制。
- ⚡ **多執行緒與高效能架構**：
  - **Worker Thread SSR**：將重度 CPU 運算的 Markdown 解析與註腳錨點生成移至背景工作執行緒池（Worker Threads），避免主事件迴圈卡死。
  - **全非同步非阻塞 I/O**：伺服器端全數採用 Promise-based 非同步檔案存取。
  - **智慧快取與 Gzip 壓縮**：結合記憶體 Tree 快取、弱 ETag（304 Not Modified）、版本化靜態資源長效快取（`immutable`）與動態 Gzip 壓縮，顯著降低網路傳輸與載入時間。
  - **前端 LRU 快取與演算法優化**：前端配備最近使用（LRU）渲染快取、`O(log N)` 二進位搜尋行號定位與 `O(1)` 大綱標籤映射。
- 🔍 **高效全文搜尋**：伺服器端高效檢索所有經論內容，提供關鍵字定位與前後文上下文片段（Snippet）預覽，點擊搜尋結果即可直接跳轉至該位置。
- 📑 **自動大綱導航 (TOC)**：開啟經論檔案後，自動解析 Markdown 標題（H1~H6）並動態生成側邊欄大綱，支援點擊滾動與閱讀進度追蹤（ScrollSpy）。
- 🎨 **五種精緻閱讀主題**：
  - 🌙 **Obsidian Dark** (深色科技)
  - ☀️ **Obsidian Light** (明亮清新)
  - 🔆 **Solarized** (經典護眼)
  - 🍵 **禪風 Zen** (平和淡雅)
  - 📜 **經典金** (復古溫潤)
- 🔎 **浮動本頁搜尋**：支援透過快速鍵喚出頁面內搜尋框（`Ctrl + F`），具備相符項目計數、高亮與前後切換功能。
- 🅰️ **動態字型縮放**：可自由調整閱讀區域字型大小（`Ctrl + +` / `Ctrl + -`），體貼不同視力需求的讀者。
- 🔗 **分享與精確跳轉**：支援 URL 參數分享（`?file=...&line=...`），能直接定位並亮顯目標行號。
- 🔒 **安全性與後台管理**：內建 PBKDF2 密碼雜湊防護、IP Rate-Limiting 防暴力破解、Session 管理與後台設定介面。
- 📦 **離線與自託管友善**：所有核心前端庫（如 Marked.js）皆改為本地託管，無外網 CDN 單點故障風險。

---

## 📂 專案結構

```text
mdWebview/
├── md/                 # 存放佛典經論 Markdown 檔案的目錄（支援多層資料夾）
│   ├── 成唯識論釋記/
│   ├── 金剛經論釋記/
│   └── ...
├── index.html          # 主頁面結構與佈局（支援動態版本快取破壞）
├── app.js              # 前端邏輯（樹狀圖、大綱、搜尋、字型、主題、LRU 快取）
├── style.css           # 樣式表（含主題色彩定義、自適應排版、compositing 提示）
├── render-worker.js    # Node.js Worker Thread SSR Markdown 渲染器
├── marked.min.js       # 本地託管 Marked.js 引擎
├── server.js           # Node.js 後端服務（全非同步 API、Worker Pool、Gzip、ETag、後台）
├── package.json        # 專案設定檔
└── README.md           # 本說明文件
```

---

## 🚀 快速開始

### 1. 環境需求
- 系統需安裝 **Node.js** (建議 v14 或以上版本，已相容 Node v26+)。

### 2. 安裝與執行
1. **啟動伺服器**：
   ```bash
   npm start
   # 或
   npm run dev
   # 或直接執行
   node server.js
   ```

2. **瀏覽閱讀**：
   開啟瀏覽器並造訪 `http://localhost:8330` 即可開始閱讀。

---

## ⌨️ 快捷鍵指南

| 快捷鍵 | 功能說明 |
| :--- | :--- |
| <kbd>Ctrl</kbd> + <kbd>F</kbd> 或 <kbd>Cmd</kbd> + <kbd>F</kbd> | 開啟本頁搜尋框 |
| <kbd>Esc</kbd> | 關閉本頁搜尋框 |
| <kbd>Enter</kbd> / <kbd>Shift</kbd> + <kbd>Enter</kbd> | 搜尋框開啟時，跳轉至下一個 / 上一個符合項 |
| <kbd>Ctrl</kbd> + <kbd>+</kbd> 或 <kbd>Cmd</kbd> + <kbd>+</kbd> | 放大閱讀區域字型 |
| <kbd>Ctrl</kbd> + <kbd>-</kbd> 或 <kbd>Cmd</kbd> + <kbd>-</kbd> | 縮小閱讀區域字型 |

---

## 📝 經論 Markdown 撰寫規範建議

為了獲得最佳的閱讀體驗，建議您的 Markdown 檔案採用以下規範：
1. **標題階層**：使用 `#`、`##`、`###` 標示章節目錄，這將被自動解析為側邊欄的大綱。
2. **註腳支援**：經典註釋常用註腳，本閱讀器支援標準 Markdown 註腳格式，例如：
   ```markdown
   論文 餘九皆通見、修所斷。[^1]
   
   [^1]: 指其餘九支皆通於見道與修道所斷。
   ```
3. **元數據 (Frontmatter)**：您可在檔案最上方加入 YAML Frontmatter，用以指定標題、作者或版本資訊，例如：
   ```yaml
   ---
   title: 金剛般若經贊述釋記
   author: 窺基大師 撰 / 後學 敬錄
   ---
   ```
