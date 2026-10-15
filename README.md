# 🪷 mdWebview — 佛典經論閱讀器 / Buddhist Sutra Commentary Reader

[繁體中文](#繁體中文) | [English](#english)

---

## 繁體中文

`mdWebview` (v3.9.0) 是一個用瀏覽器閱讀佛典經論的網站。把整批經論放進去，就能像翻書一樣閱讀、搜尋，還能隨時查佛學辭典。讀者不需要安裝任何東西，打開網址就能用。

### ✨ 可以做什麼

**閱讀**

- 📂 **左側目錄**：所有經論依資料夾排列，點一下就能打開。可依檔名或修改時間排序，也能一次全部展開或收起。
- 📑 **自動目錄**：文章裡的標題會自動整理成目錄，點標題就能跳到那一段；往下捲動時，也會顯示目前讀到哪個標題。
- 🕮 **記得讀到哪裡**：下次打開同一篇，會自動回到上次閱讀的位置。
- ↔️ **左右欄寬度可調整**：把滑鼠移到左右兩側的邊緣，會出現一條亮色的把手，按住往左右拖曳就能調整寬度。手機上會自動隱藏，避免佔用空間。
- 🎨 **五種閱讀配色**：暗色、亮色、Solarized、禪風、Gruvbox，挑自己看得順眼的。
- 📱 **排版自己調**：字的大小、行距、文字靠左或靠中、每行多寬，都能自己設定。
- 🔤 **簡體自動轉繁體**：讀簡體資料時可以開啟自動轉換；搜尋時也會一併轉換，不怕漏找。
- 🔎 **在這一篇裡找字**：按 <kbd>Ctrl</kbd> + <kbd>F</kbd>（Mac 為 <kbd>Cmd</kbd> + <kbd>F</kbd>）就能在目前這篇裡找字，會顯示找到幾個，並可前後跳看。

**搜尋**

- 🔍 **全站找字**：一次搜尋所有經論，結果很快就出來。
  - 用空白分開幾個詞，會找出同時包含這些詞的段落（例如輸入「阿賴耶識 唯識」）。
  - 不怕標點與換行：搜尋「佛法僧」也能找到「佛法，僧」、「佛、法、僧」。
  - 相隔太遠、明顯不相關的結果會自動省略。
- 📖 **佛學辭典**：可依詞條開頭查、模糊查，或全文查。結果可以一直往下翻，直到把整部辭典查完，不會中途停住。
- 🔗 **文章互相連結**：文章之間可以用 `[[檔名]]` 互相連結，點一下就能跳過去。
- 🔗 **分享特定段落**：可以把某一句的網址複製給別人，對方一打開就直接跳到那一行。

**其它**

- 🔔 **操作提示**：複製、加書籤、換配色等操作都會跳出小提示；如果操作失敗，提示會停留久一點，讓你看清楚發生什麼事。
- 🌐 **分享到社群**：把網址貼到 Facebook、Line 等地方時，會自動顯示標題、簡介與預覽圖。
- 🔒 **後台管理**：管理員可設定站名、公告與推薦清單，查看使用情況與系統狀態，並匯出報表。密碼以加密方式保存，有人反覆嘗試登入會被暫時擋下；登入與登出也都有記錄，方便日後追查。
- 📦 **離線也能看**：核心程式都放在自己的網站上，不依賴外部服務。看過的內容在斷網後仍可重看；若點開還沒下載過的經文，會清楚顯示「目前處於離線狀態，此經文尚未快取」，而不是空白畫面。
- 🐳 **可安裝在自己的電腦或伺服器**：支援 Docker，一個指令就能啟動。

---

### 🚀 怎麼開始

#### 我只是想閱讀

打開網站首頁就可以了，不需要安裝任何東西。

1. 從左邊目錄選一篇經論。
2. 開始閱讀。標題會自動變成目錄，方便跳段。
3. 想在這一篇找字，按 <kbd>Ctrl</kbd> + <kbd>F</kbd>。
4. 想找遍全部經論，用上方的搜尋框。

#### 我想自己架設（給管理者）

需要先安裝 **Node.js 24 以上版本**。

```bash
# 啟動網站
npm start
```

啟動後打開 `http://localhost:8330`。

**用 Docker 啟動（推薦）**

把下面的內容存成 `docker-compose.yml`，然後執行 `docker-compose up -d` 即可：

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
      # 經論數量多時，搜尋索引會佔用較多記憶體。
      # 建議主機至少準備 4GB（8GB 更充裕）。如記憶體不足，可調整下方數字。
      - NODE_OPTIONS=--max-old-space-size=${NODE_MAX_OLD_SPACE_MB:-6144}
    volumes:
      - ./data:/data
      - ./md:/data/md
      - ./dicts:/data/dicts
    restart: unless-stopped
```

```bash
docker-compose up -d
```

**關於記憶體**

經論檔案很多時，搜尋索引會佔用約 650MB，首次建立索引時的尖峰用量約為兩倍。建議主機至少 **4GB**（**8GB** 更充裕）。若記憶體不足，可在啟動時調整：

```bash
NODE_MAX_OLD_SPACE_MB=8192 docker-compose up -d
```

> 💡 **小提醒**：後台的設定會存到 `./data/config.json`，更新版本或重開容器都不會不見。

**怎麼進入後台**

在網站右上角點「偏好設定與系統管理」（齒輪圖示），登入後即可管理。第一次使用時，會請你先設定管理員帳號與密碼。所有設定都存在 `config.json`。

**線上部署與單機離線部署**

同一份程式碼同時支援「公開網站」與「單機桌面版」，由環境變數 `MDW_DEPLOY_TARGET` 決定：

| 值 | 用途 | 管理員帳號 | SEO | 數據分析 |
| :--- | :--- | :---: | :---: | :---: |
| `web`（預設） | 公開多人網站／Docker | ✅ 需要 | ✅ 啟用 | ✅ 啟用 |
| `mac-app`／`win-app`／`linux-app` | 單機桌面版 | ❌ 不需要 | ❌ 停用 | ❌ 停用 |

桌面版（Tauri／Electron）會自動帶入對應的單機值。單機模式的特點：

- **免登入**：只有你一個人使用，開啟即可閱讀，不再要求填寫公開網址。
- **維護免密碼但僅限本機**：重建索引、清除快取等操作不需要密碼，
  且只接受來自這台電腦的請求（判定 TCP 連線來源，無法用偽造標頭繞過）。
- **不蒐集足跡**：不寫入訪客紀錄、不做流量分析、不產生 sitemap。
- 若想用區網其他裝置閱讀，可設 `MDW_ALLOW_LAN=true`（但維護功能仍限本機）。

> ⚠️ 拼錯的 `MDW_DEPLOY_TARGET` 會**回退 `web`**（安全預設），
> 避免本該受保護的部署意外變成免登入。

> 💡 桌面版使用**固定連接埠**（Tauri `8330`／Electron `8331`）而非隨機埠。
> 瀏覽器的偏好設定（主題、字級、書籤、閱讀進度）以網址來源為界，
> 隨機埠會讓這些設定每次啟動都失效。若該埠被占用，會自動往後找（`MDW_PORT_SCAN=1`）。

---

### 📂 專案裡有什麼

> 📐 **想深入了解運作原理**：請參閱 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。

```text
mdWebview/
├── md/                 # 你的經論檔案放這裡（可再分資料夾）
├── dicts/              # 佛學辭典檔案（.txt）
├── tests/              # 自動測試
├── lib/                # 網站主程式會用到的模組
├── index.html          # 網站主頁
├── app.js              # 網頁的互動邏輯（目錄、搜尋、辭典、配色、後台）
├── style.css           # 外觀與五種配色
├── sw.js               # 離線瀏覽支援
├── server.js           # 網站主程式
├── marked.min.js       # 把 Markdown 變成網頁的程式（自帶，不需連外網）
├── s2t.js              # 簡體轉繁體
├── manifest.json       # 加到手機主畫面的設定
├── config.json         # 網站設定（站名、公告、推薦清單等）
├── package.json        # 專案資訊（v3.9.0）
├── Dockerfile          # 打包成 Docker 的設定
├── docker-compose.yml  # Docker 啟動設定
├── ARCHITECTURE.md     # 給開發者的深入說明
└── README.md           # 本文件
```

---

### ⌨️ 快速鍵與網址參數

| 快速鍵 / 網址 | 功能 |
| :--- | :--- |
| <kbd>Ctrl</kbd> + <kbd>F</kbd> 或 <kbd>Cmd</kbd> + <kbd>F</kbd> | 在這一篇裡找字 |
| <kbd>Esc</kbd> | 關閉搜尋框或設定視窗 |
| <kbd>Enter</kbd> / <kbd>Shift</kbd> + <kbd>Enter</kbd> | 跳到下一個 / 上一個找到的字 |
| <kbd>Ctrl</kbd> + <kbd>+</kbd> 或 <kbd>Cmd</kbd> + <kbd>+</kbd> | 字放大 |
| <kbd>Ctrl</kbd> + <kbd>-</kbd> 或 <kbd>Cmd</kbd> + <kbd>-</kbd> | 字縮小 |
| `?file=路徑&line=行號` | 分享某篇經論的某一行，對方打開就直接跳到那裡 |
| `?file=路徑&q=關鍵字` | 開啟該篇並在文內標示該關鍵字 |
| `?search=關鍵字` | 直接執行全庫搜尋，可分享、加書籤，或設為瀏覽器的自訂搜尋引擎 |
| `?frontpage=1` 或 `?home=1` | 直接回到首頁 |

---

### 📝 寫經論檔案的小建議

1. **標題**：用 `#`、`##`、`###` 標示章節，會自動變成側邊目錄。
2. **互相連結**：用 `[[檔名]]` 或 `[[檔名#章節標題]]` 連結到其他文章。
3. **波浪號**：單一個 `~`（例如 `P11~P12`、`10~20`）會照原樣顯示；只有 `~~文字~~` 才會變成刪除線。
4. **註腳**：寫法如下。

   ```markdown
   論文 餘九皆通見、修所斷。[^1]

   [^1]: 指其餘九支皆通於見道與修道所斷。
   ```

---

<br/>

---

## English

`mdWebview` (v3.9.0) is a website for reading Buddhist sutras and commentaries in your browser. Put your texts in, and you can read them like a book, search across all of them, and look up a Buddhist dictionary at any time. Readers do not need to install anything — just open the site.

### ✨ What You Can Do

**Reading**

- 📂 **Directory on the left**: All texts are arranged by folder — click one to open it. Sort by name or by date modified, and expand or collapse everything at once.
- 📑 **Automatic contents**: Headings in an article automatically become a table of contents. Click a heading to jump to that section, and as you scroll it shows which section you are in.
- 🕮 **Remembers where you stopped**: Reopen the same article and it takes you back to where you left off.
- ↔️ **Adjustable side columns**: Move your mouse to either edge of the page and a bright handle appears — drag it left or right to change the width. Hidden automatically on phones.
- 🎨 **Five reading color schemes**: Dark, Light, Solarized, Zen, and Gruvbox. Pick whichever is easiest on your eyes.
- 📱 **Adjust the layout**: Set the text size, line spacing, whether text is left-aligned or centered, and how wide each line is.
- 🔤 **Simplified to Traditional Chinese**: Turn on automatic conversion when reading Simplified Chinese texts. Searches are converted the same way, so nothing is missed.
- 🔎 **Find text in this article**: Press <kbd>Ctrl</kbd> + <kbd>F</kbd> (<kbd>Cmd</kbd> + <kbd>F</kbd> on Mac) to search the article you are reading. It shows how many matches there are, and you can step through them.

**Searching**

- 🔍 **Search everything**: Search across all texts at once, with results appearing quickly.
  - Separate words with spaces to find passages containing all of them (for example, `阿賴耶識 唯識`).
  - Punctuation and line breaks do not get in the way: searching `佛法僧` also finds `佛法，僧` and `佛、法、僧`.
  - Results where the words are far apart and clearly unrelated are left out automatically.
- 📖 **Buddhist dictionary**: Look up entries by their beginning, by approximate spelling, or by full text. You can keep paging through results all the way to the end of the dictionary instead of stopping partway.
- 🔗 **Link articles together**: Use `[[filename]]` to link between articles — click and it jumps straight there.
- 🔗 **Share a specific passage**: Copy the link for a particular sentence and whoever opens it lands right on that line.

**Other**

- 🔔 **Helpful messages**: Copying, bookmarking, and switching color schemes each show a small message. If something fails, the message stays up longer so you can see what happened.
- 🌐 **Sharing on social media**: Paste a link into Facebook, Line, or similar and it shows a title, description, and preview image.
- 🔒 **Admin area**: Administrators can set the site name, announcements, and recommended reading, view usage and system status, and export reports. Passwords are stored encrypted, repeated failed sign-in attempts are temporarily blocked, and sign-ins and sign-outs are logged for later review.
- 📦 **Works offline**: The core files are all hosted on your own site with no outside services. Anything you have already viewed stays readable without a network; if you open a text that was never downloaded, you get a clear "you are offline and this text is not cached yet" message rather than a blank page.
- 🐳 **Install on your own computer or server**: Docker is supported — one command gets it running.

---

### 🚀 Getting Started

#### I just want to read

Open the site's home page. Nothing to install.

1. Pick a text from the directory on the left.
2. Start reading. Headings automatically become a table of contents for jumping between sections.
3. To find text in the current article, press <kbd>Ctrl</kbd> + <kbd>F</kbd>.
4. To search all texts, use the search box at the top.

#### I want to host it myself (for administrators)

You will need **Node.js 24 or newer**.

```bash
# Start the site
npm start
```

Then open `http://localhost:8330`.

**Run with Docker (recommended)**

Save the following as `docker-compose.yml`, then run `docker-compose up -d`:

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
      # With many texts, the search index uses a fair amount of memory.
      # At least 4GB (8GB is more comfortable) is recommended. Adjust the number below if needed.
      - NODE_OPTIONS=--max-old-space-size=${NODE_MAX_OLD_SPACE_MB:-6144}
    volumes:
      - ./data:/data
      - ./md:/data/md
      - ./dicts:/data/dicts
    restart: unless-stopped
```

```bash
docker-compose up -d
```

**About memory**

With a large collection of texts, the search index takes up roughly 650MB, and building it for the first time needs about twice that at its peak. At least **4GB** (**8GB** is more comfortable) is recommended. If memory is tight, adjust it at startup:

```bash
NODE_MAX_OLD_SPACE_MB=8192 docker-compose up -d
```

> 💡 **Tip**: Admin settings are saved to `./data/config.json`, so they survive version updates and container restarts.

**How to reach the admin area**

Click the gear icon in the top right of the site ("Preferences & System Administration") and sign in. The first time you use it, you will be asked to set an administrator account and password. All settings are stored in `config.json`.

**Online vs. single-user offline deployment**

One codebase serves both a public website and a single-user desktop app. The `MDW_DEPLOY_TARGET` environment variable selects which:

| Value | Purpose | Admin account | SEO | Analytics |
| :--- | :--- | :---: | :---: | :---: |
| `web` (default) | Public site / Docker | ✅ required | ✅ enabled | ✅ enabled |
| `mac-app` / `win-app` / `linux-app` | Single-user desktop app | ❌ not needed | ❌ disabled | ❌ disabled |

The desktop shells pass the matching single-user value automatically. In single-user mode:

- **No sign-in** — one reader, one machine: the app opens straight into reading and never asks for a public canonical URL.
- **Password-free maintenance, local only** — rebuilding indexes and clearing caches needs no password, but is accepted only from this machine, decided by the TCP peer address so forged headers cannot bypass it.
- **No tracking** — no visit logs, no analytics, no sitemap.
- Set `MDW_ALLOW_LAN=true` to read from another device on your network (maintenance stays local-only).

> ⚠️ A misspelled `MDW_DEPLOY_TARGET` falls back to `web`, the safe default, so a deployment that should be protected never silently becomes login-free.

> 💡 The desktop apps use a **fixed port** (Tauri `8330` / Electron `8331`) rather than a random one. Browser preferences — theme, font size, bookmarks, reading progress — are scoped to the page origin, so a random port would discard them on every launch. If the port is taken, the server walks forward (`MDW_PORT_SCAN=1`).

---

### 📂 What Is in the Project

> 📐 **Want the technical details?** See [`ARCHITECTURE.md`](./ARCHITECTURE.md).

```text
mdWebview/
├── md/                 # Put your texts here (subfolders allowed)
├── dicts/              # Buddhist dictionary files (.txt)
├── tests/              # Automated tests
├── lib/                # Modules used by the main server program
├── index.html          # The main page
├── app.js              # Page behavior (contents, search, dictionary, themes, admin)
├── style.css           # Appearance and the five color schemes
├── sw.js               # Offline support
├── server.js           # The main server program
├── marked.min.js       # Turns Markdown into web pages (bundled, no internet needed)
├── s2t.js              # Simplified to Traditional Chinese conversion
├── manifest.json       # Settings for adding the site to your phone's home screen
├── config.json         # Site settings (name, announcements, recommended reading, etc.)
├── package.json        # Project information (v3.9.0)
├── Dockerfile          # Settings for packaging with Docker
├── docker-compose.yml  # Docker startup settings
├── ARCHITECTURE.md     # In-depth notes for developers
└── README.md           # This document
```

---

### ⌨️ Shortcuts and URL Parameters

| Shortcut / URL | What it does |
| :--- | :--- |
| <kbd>Ctrl</kbd> + <kbd>F</kbd> or <kbd>Cmd</kbd> + <kbd>F</kbd> | Find text in the current article |
| <kbd>Esc</kbd> | Close the search box or a settings window |
| <kbd>Enter</kbd> / <kbd>Shift</kbd> + <kbd>Enter</kbd> | Jump to the next / previous match |
| <kbd>Ctrl</kbd> + <kbd>+</kbd> or <kbd>Cmd</kbd> + <kbd>+</kbd> | Make text larger |
| <kbd>Ctrl</kbd> + <kbd>-</kbd> or <kbd>Cmd</kbd> + <kbd>-</kbd> | Make text smaller |
| `?file=PATH&line=NUM` | Share a specific line of a text; it opens right at that line |
| `?file=PATH&q=KEYWORD` | Open that text and mark the keyword inside it |
| `?search=KEYWORD` | Run a whole-library search immediately — shareable, bookmarkable, and usable as a browser custom search engine |
| `?frontpage=1` or `?home=1` | Go straight back to the home page |

---

### 📝 Tips for Writing Your Texts

1. **Headings**: Use `#`, `##`, and `###` for sections — they become the sidebar contents automatically.
2. **Linking**: Use `[[filename]]` or `[[filename#heading]]` to link to another article.
3. **Tildes**: A single `~` (such as `P11~P12` or `10~20`) is shown as-is; only `~~text~~` becomes strikethrough.
4. **Footnotes**: Written like this.

   ```markdown
   Sutra passage text.[^1]

   [^1]: Scholastic commentary or translation note.
   ```
