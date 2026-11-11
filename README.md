# 🪷 mdWebview — 佛典經論閱讀器 / Buddhist Sutra Commentary Reader

[繁體中文](#繁體中文) | [English](#english)

---

## 繁體中文

`mdWebview` 是一個用瀏覽器閱讀佛典經論的網站。把整批經論放進去，就能像翻書一樣閱讀、搜尋，還能隨時查佛學辭典。讀者不需要安裝任何東西，打開網址就能用。

### ✨ 可以做什麼

**閱讀**

- 📂 **左側目錄**：所有經論依資料夾排列，點一下就能打開。頂部有篩選框可即時依檔名或資料夾找經論，也可依檔名或修改時間排序、一次全部展開或收起。
- 📑 **自動目錄**：文章裡的標題會自動整理成目錄，頂部有過濾框可即時篩選本篇標題；點標題就能跳到那一段，往下捲動時也會顯示目前讀到哪個標題。
- 🌳 **科判側欄**：長老講記這類把科判寫在標題裡的系列（如《瑜伽師地論》本地分），左側「大綱」會換成「科判」，顯示整部論的科判樹，再深都放得下。閱讀時樹上自動標出目前所在的科，只展開這一條主幹；帶框的 ＋／− 可再展開，書頁圖示是可直接閱讀的末端科。閱讀框頂端有卷、地與完整科判路徑，底部「前一科／後一科」可跨卷連讀。
- 🕮 **記得讀到哪裡**：下次打開同一篇，會自動回到上次閱讀的位置。
- ↔️ **左右欄寬度可調整**：把滑鼠移到左右兩側的邊緣，會出現一條亮色的把手，按住往左右拖曳就能調整寬度。手機上會自動隱藏，避免佔用空間。
- 🎨 **八種閱讀配色**：夜藍、霧灰、素紙、月白、竹青、苔夜、禪風、Gruvbox，挑自己看得順眼的。
- 📱 **排版自己調**：字的大小、行距、文字靠左或靠中、每行多寬，都能自己設定。
- 🔤 **簡繁字形一併比對**：開啟後，搜尋、辭典與本篇找字時簡體與繁體字形互相命中（如 后／後、发／發／髮、着／著），簡體來源的檔案也找得到。簡體顯示時一律開啟。
  - 系統預設關閉，但若你的瀏覽器語言是簡體中文（`zh-CN`／`zh-Hans`／`zh-SG`），
    首次造訪會自動幫你開啟並記住。之後你仍可隨時在偏好設定裡關掉；
    一旦手動選擇過，系統就不會再更動你的設定。
- 🀄 **繁體／簡體顯示**：點右上角的選單按鈕（頭像），在「繁簡顯示」選繁體或简体，就能把整個網站（介面與經文）切換成簡體或切回繁體。同一個選單也能換主題、登入、開偏好設定。
  - 系統預設繁體；若你的瀏覽器語言是簡體中文，首次造訪會自動切成簡體，並跳出提示告訴你可從右上角選單切回。
  - 經文原文仍是繁體，簡體是在你的瀏覽器裡即時轉換的；簡體顯示時搜尋會一併比對簡繁字形，輸入簡體或繁體都找得到。
- 🔖 **書籤與歷程**：右上角選單的「書籤與歷程」會從右側滑出一個面板（手機上是全螢幕）。書籤依資料夾分組，可收合、排序、刪除；歷程依今天／昨天／更早分組。兩個分頁都會顯示每篇讀到幾成的進度條，按「繼續閱讀」回到上次的位置。同一個選單也能直接調整字級大小。
- 🖍️ **劃重點**：選取經文後，選字小選單最前面有朱、黃、綠、藍四個色點，點一下就在字下畫線；點已劃線的地方可改色、複製或取消。劃線會掛在書籤下，在「書籤與歷程」裡逐條展開、跳回原處。經文日後小改時劃線會跟著新文字走，真的找不到時標成「找不到原處」，不會刪掉。
- ✂️ **選字小選單**：同一個選單還能複製（可附出處）、查辭典、全站搜尋、複製這一行的分享連結，登入後也能把選取的句子做成早安圖。
- 🔎 **在這一篇裡找字**：按 <kbd>Ctrl</kbd> + <kbd>F</kbd>（Mac 為 <kbd>Cmd</kbd> + <kbd>F</kbd>）就能在目前這篇裡找字，會顯示找到幾個，並可前後跳看。

**搜尋**

- 🔍 **全站找字**：一次搜尋所有經論，結果很快就出來。
  - 用空白分開幾個詞，會找出同時包含這些詞的段落（例如輸入「阿賴耶識 唯識」）。
  - 不怕標點、空白與換行：搜尋「佛法僧」也能找到「佛法，僧」、「佛、法、僧」、「佛法　僧」（寬鬆比對，預設開啟；搜尋面板的 ≈／= 按鈕或偏好設定可切換）。
  - 相隔太遠、明顯不相關的結果會自動省略。
- 📖 **佛學辭典**：可依詞條開頭查、模糊查，或全文查。結果可以一直往下翻，直到把整部辭典查完，不會中途停住。
- 🔗 **文章互相連結**：文章之間可以用 `[[檔名]]` 互相連結，點一下就能跳過去。
- 🔗 **分享特定段落**：可以把某一句的網址複製給別人，對方一打開就直接跳到那一行。

**其它**

- 🔔 **操作提示**：複製、加書籤、換配色等操作都會跳出小提示；如果操作失敗，提示會停留久一點，讓你看清楚發生什麼事。
- 🌐 **分享到社群**：把網址貼到 Facebook、Line 等地方時，會自動顯示標題、簡介與預覽圖。
- ☁️ **登入後跨裝置同步**：書籤、閱讀歷程與劃重點會同步到同一個帳號的其他裝置。
- 🔒 **後台管理**：管理員可設定站名、公告與推薦清單，查看使用情況與系統狀態，並匯出報表。密碼以加密方式保存，有人反覆嘗試登入會被暫時擋下；登入與登出也都有記錄，方便日後追查。
- 📦 **離線也能看**：核心程式都放在自己的網站上，不依賴外部服務。看過的內容在斷網後仍可重看；若點開還沒下載過的經文，會清楚顯示「目前處於離線狀態，此經文尚未快取」，而不是空白畫面。
- 📲 **加到手機桌面**：可以像 App 一樣放在桌面，點一下就讀，不必每次開瀏覽器。
  - 讀過幾篇之後，首頁會出現一張卡片詢問；不想裝也有「以後再說」，3 天內不再打擾。
  - iPhone／iPad 沒有捷徑可觸發，會顯示三個步驟的圖文教學。
  - 偏好設定裡永遠保留入口，改變主意時隨時找得到。
  - 已加到桌面的人不會再看到任何提示。
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
      # 搜尋索引（約 650MB，可重建、不必備份）。保留下來，重開或更新容器時就不必重建索引。
      - ./index:/data/index
    restart: unless-stopped
```

```bash
docker-compose up -d
```

**資料夾分工**

| 資料夾（容器內） | 放什麼 | 要備份嗎 |
| :--- | :--- | :--- |
| `./data`（`/data`） | 網站設定 `config.json`、帳號 `users.db`、`backups/`、`secrets.key` | ✅ 一定要 |
| `./data/logs`（`/data/logs`，可用 `LOG_DIR` 改） | 存取日誌與流量統計（保留 90 天） | 想留統計就備份 |
| `./index`（`/data/index`，可用 `INDEX_DIR` 改） | 全文搜尋、辭典、章節的索引快取（`*.bin`） | 不用，刪掉會自動重建 |
| `./data/tts-cache`（`/data/tts-cache`，可用 `TTS_CACHE_DIR` 改） | 朗讀（TTS）生成的音檔，全站共用；另有讀音字典 `./data/tts-lexicon.txt` | 建議備份：刪掉可以重新生成，但每小時的音檔要花 GPU 半小時以上 |

> 🔄 **從 v4.18 以前升級**：以前索引放在 `logs/` 裡。v4.19.0 第一次啟動時會自動把 `logs/` 裡的索引檔搬到 `index/`，不必重建；`logs/` 和 `index/` 是不同掛載點時改用複製，幾 GB 以內大約幾秒到幾十秒。沒有加 `./index` 掛載也能跑，索引會存在 `./data/index`。

**關於記憶體**

經論檔案很多時，搜尋索引會佔用約 650MB，首次建立索引時的尖峰用量約為兩倍。建議主機至少 **4GB**（**8GB** 更充裕）。若記憶體不足，可在啟動時調整：

```bash
NODE_MAX_OLD_SPACE_MB=8192 docker-compose up -d
```

> 💡 **小提醒**：後台的設定會存到 `./data/config.json`，更新版本或重開容器都不會不見。

**怎麼進入後台**

點網站右上角的選單按鈕（頭像）登入，再從選單點「後台系統設定」即可管理。第一次使用時，會請你先設定管理員的 Email（或帳號名稱）與密碼。網站設定存在 `config.json`，帳號存在同一個資料夾的 `users.db`。

後台左邊是分組的頁面清單，右邊一次只顯示一頁（手機上先看清單、點進去再看那一頁）。打開時先看到「總覽」，所有需要處理的項目（例如寄信還沒設定）都列在那裡，點了就到對應的頁面。

| 分組 | 頁面 |
| :--- | :--- |
| 網站 | 網站與經文庫、閱讀預設、首頁頁尾與公告、推薦閱讀（含每日經文與早安圖）、搜尋引擎與分享 |
| 讀者與登入 | 使用者、註冊與邀請碼、登入方式、條款與隱私 |
| 外部服務 | 開站設定、寄信、Turnstile 人機驗證 |
| 營運 | 數據分析、報表信 |
| 系統 | 系統狀態（含重建索引等維護）、安全與攔截、日誌、備份與還原 |

設定類的頁面改了欄位後，畫面底部會出現儲存列，按「儲存」（寄信、Turnstile、登入方式是「儲存並檢查」）才會生效，也可以「還原」。按 <kbd>Ctrl</kbd>／<kbd>Cmd</kbd> + <kbd>K</kbd> 可以搜尋後台的頁面與欄位。網址帶 `#admin/<頁面>` 可以直接打開某一頁。單機版會藏起帳號、搜尋引擎與數據分析相關的頁面。

**每日經文（首頁正中間那一句）**

經句有兩個來源，合併後去掉重複的：

1. 後台「推薦閱讀 → 每日經文」文字框，一行一句。
2. 經句資料夾 `./data/sutra-quote/`（容器內 `/data/sutra-quote`，也就是 `config.json` 旁邊）。資料夾裡所有 `.md` 檔（含子資料夾）中，**有全形「｜」的行**就算一句，格式同文字框：`經句｜出處｜經文路徑`（出處與路徑可省略）。標題、空行、一般段落都會略過；檔案改了約 10 秒內生效。想放在別處可設環境變數 `SUTRA_QUOTE_DIR`（絕對路徑，或相對於 `config.json` 所在資料夾）。

```markdown
# 金剛經
應無所住，而生其心。｜金剛般若波羅蜜經
一切有為法，如夢幻泡影，如露亦如電，應作如是觀。｜金剛般若波羅蜜經｜01-大正藏/08般若部類/T0235.md
```

後台可設定「每幾小時換一句」（預設 6 小時，從網站時區的午夜起算），同一時段所有讀者看到同一句。後台也會顯示兩個來源各有幾句、合併後共幾句。

首頁經句下有兩顆按鈕：

- **↻ 換一句**：隨機換成清單裡的另一句（只換自己畫面上的，不影響別人）。
- **分享早安圖**：把畫面上這一句做成「早安圖」（依時間顯示早安／午安／晚安、日期、節氣）。八種版型左右滑選：晨光留白、沉浸全幅、經籤直書、晨鐘大字、象牙拱門、上圖下文、左右分割、三段式（三段式的問候是英文手寫體 Good Morning／Afternoon／Evening）。面板下方四顆按鈕：「傳到 LINE」（直式 1080×1350 圖片，手機會叫出系統分享選 LINE；電腦會存成圖檔）、存圖片（手機會顯示大圖，長按選「加入照片」存進相簿；電腦版下載檔案）、複製圖片，以及「複製連結」（複製 `/?verse=…` 連結，貼到 LINE 會顯示 1200×630 的卡片預覽，點開就到首頁這一句）。

背景圖放在 `./data/pic-card/`（容器內 `/data/pic-card`，可用環境變數 `PIC_CARD_DIR` 改位置），**所有子資料夾**的 jpg／png／webp 都會讀進來，約一分鐘內生效；同一天同一句會固定用同一張圖。沒有圖時用預設的天空漸層。

卡片由伺服器畫（套件 `@napi-rs/canvas`，宋體 Noto Serif TC 在建置 Docker 映像時下載；也可以自己把 .ttf／.otf 放到 `./data/fonts/`）。伺服器不能畫時改由讀者的瀏覽器畫，但 LINE 連結預覽就只能用網站預設的分享圖。後台「推薦閱讀 → 每日經文」區塊會顯示圖庫張數與畫圖狀態，展開「早安圖圖庫明細」可看到每張圖的大小、寬高、修改時間與可不可用（由新到舊，剛上傳或改過的標「新」），伺服器不收的檔案（heic、avif、gif、捷徑等）也會列出來；上傳或改圖後按「重新掃描」就能立刻確認。

畫好的卡片和縮小過的背景圖會存在索引資料夾的 `share-card/`（容器內 `/data/index/share-card`），重開機後同一張不必重畫；背景圖可以放大圖，伺服器第一次用到時會自動縮一份剛好夠用的。成品快取上限預設 200 MB（環境變數 `SHARE_CARD_CACHE_MB`），超過時刪最久沒用的；`SHARE_CARD_CACHE_DIR` 可改位置（設 `off` 關掉）。

**讀者帳號（線上網站）**

讀者可以用 Email 註冊，或用 Google、Facebook、Apple 登入（金鑰填好、後台打開開關的才會出現）。帳號資料存在 `./data/users.db`，每天自動備份到 `./data/backups/`，請把整個 `./data` 資料夾一起備份。

**寄信、Turnstile 與第三方登入都可以直接在網頁上設定。** 第一次建立管理員後，後台會自動打開「🔑 帳號系統」的「開站設定」，照步驟貼上 Resend 的 API 金鑰與寄件 Email、檢查 DNS、寄測試信，再填 Cloudflare Turnstile 的金鑰並實測一次即可，不需要登入伺服器。網頁上填的金鑰會加密後存在 `users.db`，加密用的 `./data/secrets.key` 請和資料庫一起備份（資料庫備份檔本身不含可用的金鑰）。 Google、Facebook、Apple 各有一個開關，區塊內有申請金鑰的步驟、要加到服務商後台的回調網址（可一鍵複製）、金鑰欄位與「檢查設定」；金鑰儲存前會先向服務商確認，Apple 的私鑰可以直接貼上或選 .p8 檔。關掉開關不會刪除金鑰，已綁定的帳號也保留。

也可以改用環境變數，環境變數有設定時優先於網頁設定。金鑰不要寫進 `docker-compose.yml`：把 [.env.example](.env.example) 複製成 `.env` 填好，`docker compose` 會自動讀取。可用的變數：

| 變數 | 用途 |
| :--- | :--- |
| `PUBLIC_BASE_URL` | 對外網址，驗證信與第三方登入的連結都用它（沒設時改用後台的首頁權威 URL） |
| `MAIL_PROVIDER`、`MAIL_API_KEY`、`MAIL_FROM` | 寄驗證信與重設密碼信（目前支援 Resend，也可在後台設定）。沒設定時註冊與忘記密碼會暫停 |
| `TURNSTILE_SITE_KEY`、`TURNSTILE_SECRET_KEY` | Cloudflare 人機驗證，防機器人註冊（可不設，也可在後台設定） |
| `GOOGLE_*`、`FACEBOOK_*`、`APPLE_*` | 第三方登入（可不設，也可在後台設定）。Apple 私鑰可用 `APPLE_PRIVATE_KEY_PATH`（檔案路徑）或 `APPLE_PRIVATE_KEY`（.p8 內容） |

後台的「👥 使用者」可以查帳號、停用、設管理員、管理註冊方式與邀請碼；「🔑 帳號系統」有開站設定步驟，可以設定寄信（Resend 金鑰、寄件人，並檢查 DKIM、寄信授權與 DMARC 的 DNS，只寄信不需要 MX）與 Turnstile 人機驗證（填金鑰、實際通過一次確認網域），看第三方登入狀態，並編輯隱私權政策與使用條款（發布在 `/privacy`、`/terms`）、備份與還原帳號資料庫。舊版存在 `config.json` 的管理員會在第一次登入時自動搬進帳號資料庫。

**線上部署與單機離線部署**

同一份程式碼同時支援「公開網站」與「單機桌面版」，由環境變數 `MDW_DEPLOY_TARGET` 決定：

| 值 | 用途 | 管理員帳號 | SEO | 數據分析 |
| :--- | :--- | :---: | :---: | :---: |
| `web`（預設） | 公開多人網站／Docker | ✅ 需要 | ✅ 啟用 | ✅ 啟用 |
| `mac-app`／`win-app`／`linux-app`／`ios-app`／`android-app` | 單機離線部署 | ❌ 不需要 | ❌ 停用 | ❌ 停用 |

單機模式的特點：

- **免登入**：只有你一個人使用，開啟即可閱讀，不再要求填寫公開網址。
- **維護免密碼但僅限本機**：重建索引、清除快取等操作不需要密碼，
  且只接受來自這台電腦的請求（判定 TCP 連線來源，無法用偽造標頭繞過）。
- **不蒐集足跡**：不寫入訪客紀錄、不做流量分析、不產生 sitemap。
- 若想用區網其他裝置閱讀，可設 `MDW_ALLOW_LAN=true`（但維護功能仍限本機）。

> ⚠️ 拼錯的 `MDW_DEPLOY_TARGET` 會**回退 `web`**（安全預設），
> 避免本該受保護的部署意外變成免登入。

> 💡 單機模式只是伺服器的一種執行型態，本專案不含桌面外殼程式。
> 若你要自行以 Tauri／Electron 等方案包裝，請使用**固定連接埠**而非隨機埠——
> 瀏覽器的偏好設定（主題、字級、書籤、閱讀進度）以網址來源為界，
> 隨機埠會讓這些設定每次啟動都失效。設 `MDW_PORT_SCAN=1` 可在埠被占用時自動往後找。

---

### 📂 專案裡有什麼

> 📐 **想深入了解運作原理**：請參閱 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。

```text
mdWebview/
├── md/                 # 你的經論檔案放這裡（可再分資料夾）
├── dicts/              # 佛學辭典檔案
├── data/               # Docker 掛載：config.json、users.db、backups/、secrets.key、sutra-quote/、pic-card/
├── logs/               # 存取日誌與流量統計（自動產生）
├── index/              # 搜尋索引快取 *.bin 與早安圖快取（自動產生，可刪除重建）
├── server.js           # 網站主程式
├── lib/                # 主程式的模組（設定、帳號、寄信、報表、科判、早安圖、索引…共 32 個）
├── render-worker.js    # 伺服器端把 Markdown 變成網頁（背景執行緒）
├── index-worker.js     # 建立與查詢全文搜尋索引（背景執行緒）
├── index.html          # 網站主頁（也包含整個後台）
├── app.js              # 網頁的互動邏輯（目錄、閱讀、搜尋、辭典、劃重點、後台）
├── style.css           # 外觀與八種配色
├── kepan-sidebar.js    # 科判側欄
├── highlights.js       # 劃重點的定位規則（瀏覽器與伺服器共用）
├── library-sync.js     # 書籤與歷程的同步規則（瀏覽器與伺服器共用）
├── share-card.js       # 早安圖的版型與畫法（瀏覽器與伺服器共用）
├── md-worker.js        # 瀏覽器端的 Markdown 解析（備援）
├── sw.js               # 離線瀏覽支援
├── marked.min.js       # 把 Markdown 變成網頁的程式（自帶，不需連外網）
├── i18n/               # 繁簡顯示切換、簡繁字形比對表與介面字串
├── vendor/             # 自帶的第三方程式（KaTeX、Pele〔Mermaid 語法圖表〕、OpenCC、QR 碼、手寫字型）
├── manifest.json       # 加到手機主畫面的設定
├── tests/              # 自動測試（npm test）
├── tools/              # 開發工具（產生簡繁字組表）
├── Dockerfile、docker-compose.yml、docker-entrypoint.sh   # Docker 打包與啟動
├── .env.example        # 金鑰設定範本（複製成 .env）
├── ARCHITECTURE.md     # 給開發者的深入說明
└── README.md           # 本文件
```

### 🛠️ 開發與測試

```bash
npm ci
npm start      # http://localhost:8330，可用 PORT 改埠
npm test       # 執行 tests/ 裡的所有測試
```

- 本機已經有一個正式的網站在跑時，測試請換一個埠（例如 `PORT=8401`），並用另一份 `CONFIG_PATH`，以免動到正式的設定與帳號資料。
- 分支流程：從 `dev` 開功能分支 → PR 合回 `dev` → 驗證後由 `dev` 開 PR 到 `main` 發布。`dev` 與 `main` 推上 GitHub 後會自動建出 Docker 映像（`:dev`、`:latest`）。
- 版本號只寫在 `package.json` 與 `package-lock.json`。
- 環境變數總表、後台的程式結構與資料流請看 [`ARCHITECTURE.md`](./ARCHITECTURE.md)（§0、§10.1、§21–§23）。

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

`mdWebview` is a website for reading Buddhist sutras and commentaries in your browser. Put your texts in, and you can read them like a book, search across all of them, and look up a Buddhist dictionary at any time. Readers do not need to install anything — just open the site.

### ✨ What You Can Do

**Reading**

- 📂 **Directory on the left**: All texts are arranged by folder — click one to open it. Filter by file or folder name at the top, sort by name or by date modified, and expand or collapse everything at once.
- 📑 **Automatic contents**: Headings in an article automatically become a table of contents with a quick filter box at the top. Click a heading to jump to that section, and as you scroll it shows which section you are in.
- 🌳 **Outline (科判) sidebar**: For lecture series whose headings carry a traditional outline (科判), such as the 《瑜伽師地論》本地分 lectures, the Contents tab becomes 科判: the whole treatise as one tree, however deep. The section you are reading is highlighted and only its branch is open; boxed ＋／− rows expand, page icons are sections you can read. The top of the reader shows the fascicle, the 地 and the full outline path, and 前一科／後一科 at the bottom read on across files.
- 🕮 **Remembers where you stopped**: Reopen the same article and it takes you back to where you left off.
- ↔️ **Adjustable side columns**: Move your mouse to either edge of the page and a bright handle appears — drag it left or right to change the width. Hidden automatically on phones.
- 🎨 **Eight reading color schemes**: Night, Mist, Paper, Moon, Bamboo, Moss, Zen, and Gruvbox. Pick whichever is easiest on your eyes.
- 📱 **Adjust the layout**: Set the text size, line spacing, whether text is left-aligned or centered, and how wide each line is.
- 🔤 **Match Simplified and Traditional forms**: When on, searches, dictionary look-ups and find-in-article treat Simplified and Traditional forms as the same character (后／後, 发／發／髮, 着／著), so Simplified-source files are found too. Always on in Simplified display.
  - Off by default, but if your browser language is Simplified Chinese (`zh-CN`, `zh-Hans`, `zh-SG`) it turns on automatically on your first visit and is remembered. You can switch it off any time in the settings; once you have chosen, the system will not change it for you.
- 🀄 **Traditional / Simplified display**: Open the menu at the top right (the avatar button) and pick 繁體 or 简体 under 繁簡顯示 to switch the whole site (interface and texts). The same menu also changes the theme, signs you in, and opens preferences.
  - Traditional is the default. If your browser language is Simplified Chinese, your first visit switches to Simplified automatically and a notice points you to the button.
  - The texts themselves stay Traditional; Simplified is converted in your browser on the fly. In Simplified display, searches match Simplified and Traditional forms, so typing either finds the text.
- 🔖 **Bookmarks & History**: 書籤與歷程 in the top-right menu slides out a panel from the right (full screen on phones). Bookmarks are grouped by folder and can be collapsed, sorted and deleted; recent reading is grouped into today / yesterday / earlier. Both tabs show a progress bar for how far you read each text, and 繼續閱讀 takes you back to where you stopped. The same menu also adjusts the text size.
- 🖍️ **Highlights**: Select some text and the small selection menu starts with four color dots (vermilion, yellow, green, blue); tap one to underline the passage. Tap a highlight to recolor, copy or remove it. Highlights belong to bookmarks and are listed under each bookmark in Bookmarks & History, where you can jump back to them. When a text is lightly edited later, highlights follow the new wording; if one can no longer be found it is marked as such, never deleted.
- ✂️ **Selection menu**: The same menu copies (optionally with the source), looks up the dictionary, searches the whole library, copies a link to the line, and — when signed in — turns the selected sentence into a greeting card.
- 🔎 **Find text in this article**: Press <kbd>Ctrl</kbd> + <kbd>F</kbd> (<kbd>Cmd</kbd> + <kbd>F</kbd> on Mac) to search the article you are reading. It shows how many matches there are, and you can step through them.

**Searching**

- 🔍 **Search everything**: Search across all texts at once, with results appearing quickly.
  - Separate words with spaces to find passages containing all of them (for example, `阿賴耶識 唯識`).
  - Punctuation and line breaks do not get in the way: searching `佛法僧` also finds `佛法，僧` and `佛、法、僧` (loose matching, on by default; toggle it with the ≈／= button in the search panel or in the settings).
  - Results where the words are far apart and clearly unrelated are left out automatically.
- 📖 **Buddhist dictionary**: Look up entries by their beginning, by approximate spelling, or by full text. You can keep paging through results all the way to the end of the dictionary instead of stopping partway.
- 🔗 **Link articles together**: Use `[[filename]]` to link between articles — click and it jumps straight there.
- 🔗 **Share a specific passage**: Copy the link for a particular sentence and whoever opens it lands right on that line.

**Other**

- 🔔 **Helpful messages**: Copying, bookmarking, and switching color schemes each show a small message. If something fails, the message stays up longer so you can see what happened.
- 🌐 **Sharing on social media**: Paste a link into Facebook, Line, or similar and it shows a title, description, and preview image.
- ☁️ **Sync across devices**: When signed in, bookmarks, reading history and highlights sync to your other devices.
- 🔒 **Admin area**: Administrators can set the site name, announcements, and recommended reading, view usage and system status, and export reports. Passwords are stored encrypted, repeated failed sign-in attempts are temporarily blocked, and sign-ins and sign-outs are logged for later review.
- 📦 **Works offline**: The core files are all hosted on your own site with no outside services. Anything you have already viewed stays readable without a network; if you open a text that was never downloaded, you get a clear "you are offline and this text is not cached yet" message rather than a blank page.
- 📲 **Add to your home screen**: Install it like an app and open a text in one tap, without launching a browser.
  - After you have read a few texts, a card on the home page offers to install it. Choose "later" and it stays quiet for 3 days.
  - iPhone and iPad cannot be triggered programmatically, so a three-step illustrated guide is shown instead.
  - The settings panel always keeps an entry, so you can change your mind later.
  - Anyone who has already installed it never sees the prompts again.
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
      # Search index (~650MB, rebuildable, no need to back up). Keeping it means restarts and updates skip the rebuild.
      - ./index:/data/index
    restart: unless-stopped
```

```bash
docker-compose up -d
```

**What goes where**

| Folder (in container) | Contents | Back up? |
| :--- | :--- | :--- |
| `./data` (`/data`) | Site settings `config.json`, accounts `users.db`, `backups/`, `secrets.key` | ✅ Yes |
| `./data/logs` (`/data/logs`, override with `LOG_DIR`) | Access logs and traffic statistics (kept 90 days) | If you want the statistics |
| `./index` (`/data/index`, override with `INDEX_DIR`) | Full-text, dictionary and section index caches (`*.bin`) | No — deleted files are rebuilt automatically |
| `./data/tts-cache` (`/data/tts-cache`, override with `TTS_CACHE_DIR`) | Read-aloud (TTS) audio shared by all readers, plus the pronunciation lexicon `./data/tts-lexicon.txt` | Recommended — it can be regenerated, but an hour of audio costs over half an hour of GPU time |

> 🔄 **Upgrading from v4.18 or earlier**: indexes used to live in `logs/`. On its first start, v4.19.0 moves the index files from `logs/` into `index/` so nothing has to be rebuilt; when `logs/` and `index/` are separate mounts it copies them instead (seconds to a few tens of seconds). Without the `./index` mount it still works and keeps the index in `./data/index`.

**About memory**

With a large collection of texts, the search index takes up roughly 650MB, and building it for the first time needs about twice that at its peak. At least **4GB** (**8GB** is more comfortable) is recommended. If memory is tight, adjust it at startup:

```bash
NODE_MAX_OLD_SPACE_MB=8192 docker-compose up -d
```

> 💡 **Tip**: Admin settings are saved to `./data/config.json`, so they survive version updates and container restarts.

**How to reach the admin area**

Open the menu at the top right of the site (the avatar button), sign in, then choose "後台系統設定" (System administration). The first time you use it, you will be asked to set the administrator's email (or a username) and password. Site settings are stored in `config.json`; accounts are stored in `users.db` in the same folder.

The admin area lists grouped pages on the left and shows one page at a time on the right (on phones you see the list first, then the page). It opens on Overview, which collects everything that needs attention (for example, mail not set up yet) and links straight to the right page.

| Group | Pages |
| :--- | :--- |
| Site | Site & library, Reading defaults, Home footer & announcements, Recommended reading (incl. daily verse and greeting cards), Search engines & sharing |
| Readers & sign-in | Users, Sign-up & invite codes, Sign-in methods, Terms & privacy |
| External services | Site setup, Mail, Turnstile |
| Operations | Analytics, Report emails |
| System | System status (incl. index rebuilds), Security & blocking, Logs, Backup & restore |

On settings pages, a save bar appears at the bottom once you change a field; nothing takes effect until you press Save (Save & check for mail, Turnstile and sign-in methods), or Revert. <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>K</kbd> searches admin pages and fields, and `#admin/<page>` in the URL opens a page directly. The single-user build hides the account, search-engine and analytics pages.

**Reader accounts (online site)**

Readers can sign up with an email address or sign in with Google, Facebook or Apple (only the ones you configure appear). Accounts live in `./data/users.db` and are backed up daily to `./data/backups/`, so back up the whole `./data` folder.

**Mail, Turnstile and third-party sign-in can all be set up in the browser.** After you create the first administrator, the admin panel opens "🔑 Account system → Site setup": paste your Resend API key and sender address, check DNS, send a test email, then add your Cloudflare Turnstile keys and pass one live check. Keys entered on the web are encrypted in `users.db`; keep `./data/secrets.key` with your database backups (backup files alone do not contain usable keys).

Environment variables still work and take precedence over web settings. Keep secrets out of `docker-compose.yml`: copy [.env.example](.env.example) to `.env` and fill it in; `docker compose` reads it automatically. Available variables:

| Variable | Purpose |
| :--- | :--- |
| `PUBLIC_BASE_URL` | Public address used in verification emails and sign-in callbacks (falls back to the canonical URL in the admin panel) |
| `MAIL_PROVIDER`, `MAIL_API_KEY`, `MAIL_FROM` | Sends verification and password-reset emails (Resend is supported). Without it, sign-up and password reset are paused |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | Cloudflare bot check for sign-up (optional) |
| `GOOGLE_*`, `FACEBOOK_*`, `APPLE_*` | Third-party sign-in (optional; can also be set in the admin panel). The Apple key is either a file path (`APPLE_PRIVATE_KEY_PATH`) or the `.p8` contents (`APPLE_PRIVATE_KEY`) |

In the admin panel, "👥 Users" lists accounts and lets you disable them, grant admin, and manage sign-up mode and invite codes; "🔑 Account system" walks you through site setup (mail and Turnstile), shows sign-in status, edits the privacy policy and terms (published at `/privacy` and `/terms`), and backs up or restores the account database. An administrator stored in an older `config.json` is moved into the account database on first sign-in.

**Online vs. single-user offline deployment**

One codebase serves both a public website and a single-user offline deployment. The `MDW_DEPLOY_TARGET` environment variable selects which:

| Value | Purpose | Admin account | SEO | Analytics |
| :--- | :--- | :---: | :---: | :---: |
| `web` (default) | Public site / Docker | ✅ required | ✅ enabled | ✅ enabled |
| `mac-app` / `win-app` / `linux-app` / `ios-app` / `android-app` | Single-user offline deployment | ❌ not needed | ❌ disabled | ❌ disabled |

In single-user mode:

- **No sign-in** — one reader, one machine: the app opens straight into reading and never asks for a public canonical URL.
- **Password-free maintenance, local only** — rebuilding indexes and clearing caches needs no password, but is accepted only from this machine, decided by the TCP peer address so forged headers cannot bypass it.
- **No tracking** — no visit logs, no analytics, no sitemap.
- Set `MDW_ALLOW_LAN=true` to read from another device on your network (maintenance stays local-only).

> ⚠️ A misspelled `MDW_DEPLOY_TARGET` falls back to `web`, the safe default, so a deployment that should be protected never silently becomes login-free.

> 💡 Single-user mode is only a run mode of the server; this project ships no desktop shell. If you wrap it yourself with Tauri, Electron or similar, use a **fixed port** rather than a random one — browser preferences (theme, font size, bookmarks, reading progress) are scoped to the page origin, so a random port would discard them on every launch. Set `MDW_PORT_SCAN=1` to walk forward when the port is taken.

---

### 📂 What Is in the Project

> 📐 **Want the technical details?** See [`ARCHITECTURE.md`](./ARCHITECTURE.md).

```text
mdWebview/
├── md/                 # Put your texts here (subfolders allowed)
├── dicts/              # Buddhist dictionary files
├── data/               # Docker mount: config.json, users.db, backups/, secrets.key, sutra-quote/, pic-card/
├── logs/               # Access logs and traffic statistics (generated)
├── index/              # Search index caches *.bin and the greeting-card cache (generated; safe to delete)
├── server.js           # The main server program
├── lib/                # Server modules (settings, accounts, mail, reports, outlines, greeting cards, indexes… 32 in all)
├── render-worker.js    # Server-side Markdown rendering (background thread)
├── index-worker.js     # Builds and queries the full-text index (background thread)
├── index.html          # The main page (also contains the whole admin area)
├── app.js              # Page behavior (contents, reading, search, dictionary, highlights, admin)
├── style.css           # Appearance and the eight color schemes
├── kepan-sidebar.js    # Outline (科判) sidebar
├── highlights.js       # Highlight anchoring rules (shared by browser and server)
├── library-sync.js     # Bookmark and history sync rules (shared by browser and server)
├── share-card.js       # Greeting-card layouts and drawing (shared by browser and server)
├── md-worker.js        # In-browser Markdown parsing (fallback)
├── sw.js               # Offline support
├── marked.min.js       # Turns Markdown into web pages (bundled, no internet needed)
├── i18n/               # Traditional/Simplified display, variant table and interface strings
├── vendor/             # Bundled third-party code (KaTeX, Pele for Mermaid-syntax diagrams, OpenCC, QR codes, a script font)
├── manifest.json       # Settings for adding the site to your phone's home screen
├── tests/              # Automated tests (npm test)
├── tools/              # Developer tools (generating the variant table)
├── Dockerfile, docker-compose.yml, docker-entrypoint.sh   # Docker packaging and startup
├── .env.example        # Template for secrets (copy to .env)
├── ARCHITECTURE.md     # In-depth notes for developers
└── README.md           # This document
```

### 🛠️ Development and Testing

```bash
npm ci
npm start      # http://localhost:8330; change with PORT
npm test       # runs every test in tests/
```

- If a production instance is already running on this machine, test on another port (for example `PORT=8401`) with a separate `CONFIG_PATH`, so you never touch the real settings and account database.
- Branch flow: branch off `dev` → PR back into `dev` → once verified, a `dev` → `main` PR releases it. Pushes to `dev` and `main` build Docker images automatically (`:dev`, `:latest`).
- The version number lives only in `package.json` and `package-lock.json`.
- For the full environment-variable list, the admin code structure and data flow, see [`ARCHITECTURE.md`](./ARCHITECTURE.md) (§0, §10.1, §21–§23).

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
