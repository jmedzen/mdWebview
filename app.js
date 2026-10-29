/* ================================================================
   mdWebview — Application Logic (app.js) v4.2.5
   Tree · Viewer · Search · Theme · Dict · Admin

   ── 段落索引（Section Map）─────────────────────────────────────
   §0  Globals & State           LRU cache, Web Worker, state{}
   §1  Init & Boot Hooks         loadSettings, initUI, URL params
   §2  Site Name & Footer        updateSiteNameUI, updateWelcomeFooter
   §3  Suggest List              fetchSuggestList, renderSuggestList
   §4  Announcement Modal        checkAndShowAnnouncementModal, openAnnouncementModal
   §5  File Tree                 buildTree, renderTree, sortTree
   §6  Markdown Viewer           openFile, virtualized rendering, footnotes
   §6.5 Media Lightbox           openMediaLightbox, zoom, pan, pinch
   §7  Wikilink Resolver         wikilinkIndex, resolveWikilink
   §8  Table of Contents         buildToc, renderToc, scrollSpy
   §9  Global Search             doSearch, renderSearchResults
   §10 Dictionary Sidebar        dictPanel, prefix/fulltext lookup
   §11 In-Page Search (Ctrl+F)   pageSearch, highlightMatches
   §12 Theme                     applyTheme, persistTheme
   §13 Font Size                 changeFontSize, persistFontSize
   §14 Text/Layout Preferences   textAlign, lineHeight, maxWidth, readProgress
   §15 Recent Files              recentFiles (localStorage, max 20)
   §16 Toast Notifications       showToast
   §16.5 PWA Install Prompt      install card, iOS guide modal, settings entry
   §17 Bookmarks                 bookmarks (localStorage)
   §18 Read Progress             autoSaveProgress, restoreProgress
   §18.5 Preferences Backup      export / import user preferences JSON
   §19 Sidebar Resize            drag-to-resize sidebar width
   §20 Event Listeners           setupEventListeners — keyboard, click, popstate wiring
   §21 Admin Panel               settings UI, analytics, logs
       §21.1 面板開關與髒值追蹤      closeAdminModal, setAdminDirty
       §21.2 帳號與設定維護          password, backup/restore, diagnostics
       §21.3 流量趨勢圖繪製          computeNiceScale, monotonePath
       §21.4 硬體監控儀表板          loadHardwareStats, renderHardwareDashboard
       §21.5 日誌與流量報表          fetchAdminLogs, renderAdminAnalytics
       §21.6 設定表單與 SEO          setupAdminTabEvents, loadSeoSettings
       §21.7 使用者帳號              initAccounts, 登入／註冊、我的帳號、後台使用者與帳號系統
   §22 Utilities                 escHtml, formatDate, helpers
   §23 Boot Entry                DOMContentLoaded → init()
   ================================================================ */

(function () {
  'use strict';

  // ── Per-document scan gates (O(n²) defense) ──────────────────────────────
  // Mirrors render-worker.js / md-worker.js: marked calls each extension's
  // start(src) on every tokenization step, passing the ENTIRE remaining suffix,
  // so an unconditional indexOf is O(n²) in document length. Gate per document
  // so marker-free documents skip the scan entirely. See render-worker.js for
  // the CPU-profile measurements.
  let _scanEq = false;
  let _scanDollar = false;
  let _scanDollar2 = false;

  function setScanGates(text) {
    _scanEq = text.indexOf('==') !== -1;
    _scanDollar = text.indexOf('$') !== -1;
    _scanDollar2 = text.indexOf('$$') !== -1;
  }

  // ═══════════════════════════════════════════════════════════
  // §0 GLOBALS & STATE (LRU cache, Web Worker, state{})
  // ═══════════════════════════════════════════════════════════

  // ── LocalStorage Key 常數池 (Centralized Storage Keys) ───
  const STORAGE_KEYS = {
    THEME: 'mdWebview-user-theme',
    FONT_SIZE: 'mdWebview-user-fontsize',
    TEXT_ALIGN: 'mdWebview-user-textalign',
    LINE_HEIGHT: 'mdWebview-user-lineheight',
    MAX_WIDTH: 'mdWebview-user-maxwidth',
    AUTO_S2T: 'mdWebview-auto-s2t',
    // 繁／簡顯示：'hant'（繁體，預設）或 'hans'（簡體）。i18n/boot.js 也直接讀這個鍵。
    DISPLAY_SCRIPT: 'mdWebview-display-script',
    READ_PROGRESS_ENABLED: 'mdWebview-user-readprogress',
    LAST_READ_PROGRESS: 'mdWebview-last-read-progress',
    RECENT_FILES: 'mdWebview-user-recentfiles',
    BOOKMARKS: 'mdWebview-user-bookmarks',
    LIBRARY_PREFS: 'mdWebview-user-library',
    ADMIN_TOKEN: 'mdWebview-admin-token',
    ADMIN_TZ: 'mdWebview-admin-tz',
    DICT_FILE_ORDER: 'mdWebview-dict-file-order',
    DICT_FILE_SELECT: 'mdWebview-dict-selected',
    FORCE_FULL: 'mdWebview-force-full',
    SEARCH_MODE: 'mdWebview-search-mode',
    ANNOUNCEMENT_ACK: 'mdWebview-announcement-modal-ack',
    // 安裝引導狀態。DISMISSED 存「以後再說」的時間戳（用來算靜默期），
    // INSTALLED 存 '1'（一旦安裝就永久不再提）。
    INSTALL_DISMISSED: 'mdWebview-install-dismissed',
    INSTALL_INSTALLED: 'mdWebview-install-done',
    SYNC_META: 'mdWebview-sync-meta'
  };

  // ── 安全 LocalStorage 存取工具 (Safe Storage Helper) ───────
  const storage = {
    get: (key, fallback = null) => {
      try {
        const val = localStorage.getItem(key);
        return val !== null ? val : fallback;
      } catch (_) {
        return fallback;
      }
    },
    set: (key, val) => {
      try {
        localStorage.setItem(key, String(val));
        return true;
      } catch (_) {
        return false;
      }
    },
    remove: (key) => {
      try {
        localStorage.removeItem(key);
        return true;
      } catch (_) {
        return false;
      }
    },
    getJson: (key, fallback = null) => {
      try {
        const val = localStorage.getItem(key);
        if (!val) return fallback;
        const parsed = JSON.parse(val);
        return parsed !== null && parsed !== undefined ? parsed : fallback;
      } catch (_) {
        return fallback;
      }
    },
    setJson: (key, val) => {
      try {
        localStorage.setItem(key, JSON.stringify(val));
        return true;
      } catch (_) {
        return false;
      }
    }
  };

  const appConfig = window.__APP_CONFIG__ || {};
  const userFont = storage.get(STORAGE_KEYS.FONT_SIZE);
  const userTheme = storage.get(STORAGE_KEYS.THEME);
  const userAlign = storage.get(STORAGE_KEYS.TEXT_ALIGN);
  const userLineHeight = storage.get(STORAGE_KEYS.LINE_HEIGHT);
  const userMaxWidth = storage.get(STORAGE_KEYS.MAX_WIDTH);
  const userReadProgress = storage.get(STORAGE_KEYS.READ_PROGRESS_ENABLED);

  /**
   * 判斷瀏覽器的主要語言是否為簡體中文。
   *
   * 站台的內文一律是繁體，簡體中文使用者讀起來會有落差，因此對他們預設開啟
   * 「簡繁字形一併比對」是合理的體貼，而不是自作主張——他們仍可在偏好設定裡
   * 隨手關掉。
   *
   * 判定只看主要語言（第一個），理由是一個只把 zh-CN 排在次要順位、主要
   * 語言其實是英文的使用者，預期看到的介面仍是英文語境，不該被套用轉換。
   *
   * 涵蓋的標籤：zh-CN、zh_CN、zh-Hans、zh-Hans-CN、zh-SG 等。zh-Hans 是
   * 「簡體中文」的語法標記，Chrome 在某些平台上會用它而非 zh-CN；zh-SG
   * （新加坡）官方用簡體，故一併視為簡體。
   *
   * @param {string} [lang] - 語言標籤，預設取 navigator.language
   * @returns {boolean}
   */
  function isSimplifiedChineseLocale(lang) {
    let tag = '';
    try {
      tag = String(lang !== undefined ? lang : (navigator.language || '')).toLowerCase();
    } catch (_) {
      return false;
    }
    if (!tag) return false;
    // 正規化分隔符：BCP 47 用 '-'，但部分舊環境或外掛會給 '_'
    tag = tag.replace(/_/g, '-');
    // 必須是中文語系，避免把 'zh' 之外的標籤誤判
    if (!/^zh\b/.test(tag)) return false;
    // 明確的簡體標記
    if (/-hans\b/.test(tag)) return true;
    if (/-cn\b/.test(tag)) return true;
    if (/-sg\b/.test(tag)) return true;
    // 裸 'zh' 不判定：無法區分繁簡，寧可維持站台原本的繁體預設
    return false;
  }

  /**
   * 首次造訪且瀏覽器語言為簡體中文時，自動開啟「簡繁字形一併比對」並寫入 localStorage。
   *
   * 只在「使用者從未表達過偏好」時介入：
   *   - 已有 AUTO_S2T 記錄（不論 true 或 false）→ 完全尊重，不再覆寫。
   *     這一點很重要：使用者若曾手動關掉，下次進站不該又被自動打開。
   *   - 沒有記錄且語言為簡體 → 寫入 'true'。
   *
   * 寫入 localStorage 而非只改記憶體狀態，是為了讓使用者的設定在重新整理、
   * 換分頁、以及之後的偏好備份匯出時都保持一致；否則「自動開啟」會變成每次
   * 載入都重新判斷，使用者手動關閉後仍會被再次開啟。
   *
   * @returns {boolean} 是否因此自動開啟
   */
  function maybeAutoEnableS2TFromLocale() {
    let existing = null;
    try {
      existing = storage.get(STORAGE_KEYS.AUTO_S2T);
    } catch (_) {
      return false;
    }
    // 使用者已經做過選擇，一律不覆寫。
    if (existing === 'true' || existing === 'false') return false;
    if (!isSimplifiedChineseLocale()) return false;
    try {
      storage.set(STORAGE_KEYS.AUTO_S2T, 'true');
    } catch (_) {
      return false;
    }
    return true;
  }

  // 必須在讀取 userAutoS2T 之前執行，否則 state 會沿用舊值。
  maybeAutoEnableS2TFromLocale();
  const userAutoS2T = storage.get(STORAGE_KEYS.AUTO_S2T);

  /**
   * 正規化繁簡顯示值。只接受 'hant'／'hans'，其餘（含舊備份檔的缺值）回傳 null。
   * @param {*} value
   * @returns {'hant'|'hans'|null}
   */
  function normalizeDisplayScript(value) {
    return value === 'hans' || value === 'hant' ? value : null;
  }

  /**
   * 首次造訪且瀏覽器語言為簡體中文時，自動切換為簡體顯示並寫入 localStorage。
   *
   * 與 maybeAutoEnableS2TFromLocale 同一套原則：
   *   - 已有 DISPLAY_SCRIPT 記錄（'hant' 或 'hans'）→ 完全尊重，不再覆寫。
   *     使用者切回繁體後，下次進站不該又被切成簡體。
   *   - 沒有記錄且語言為簡體 → 寫入 'hans'，並回傳 true 讓畫面顯示一次提示。
   *   - 沒有記錄且語言不是簡體 → 不寫入，維持預設繁體。日後瀏覽器語言改成
   *     簡體時仍會在第一次進站時判斷一次。
   *
   * @returns {boolean} 是否因此自動切換為簡體
   */
  function maybeAutoSelectDisplayScriptFromLocale() {
    let existing = null;
    try {
      existing = storage.get(STORAGE_KEYS.DISPLAY_SCRIPT);
    } catch (_) {
      return false;
    }
    if (normalizeDisplayScript(existing)) return false;
    if (!isSimplifiedChineseLocale()) return false;
    try {
      if (!storage.set(STORAGE_KEYS.DISPLAY_SCRIPT, 'hans')) return false;
    } catch (_) {
      return false;
    }
    return true;
  }

  // 必須在讀取 userDisplayScript 之前執行，理由同上。
  const displayScriptAutoSelected = maybeAutoSelectDisplayScriptFromLocale();
  const userDisplayScript = normalizeDisplayScript(storage.get(STORAGE_KEYS.DISPLAY_SCRIPT));

  function safeJsonParse(key, fallback) {
    const parsed = storage.getJson(key, fallback);
    return Array.isArray(parsed) ? parsed : fallback;
  }

  // ── Client Logger Utility ─────────────────────────────────
  const log = {
    info: (msg, ...args) => console.log(`%c[mdWebview]%c ${msg}`, 'color:#8b6b43;font-weight:bold', 'color:inherit', ...args),
    warn: (msg, ...args) => console.warn(`%c[mdWebview]%c ${msg}`, 'color:#d97706;font-weight:bold', 'color:inherit', ...args),
    error: (msg, ...args) => console.error(`%c[mdWebview]%c ${msg}`, 'color:#dc2626;font-weight:bold', 'color:inherit', ...args)
  };

  function isMobileBrowser() {
    const ua = navigator.userAgent || '';
    const isMobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
    const isSmallWidth = window.innerWidth <= 768;
    return isMobileUA || isSmallWidth;
  }

  const isMobile = isMobileBrowser();
  const isNarrowScreen = isMobileBrowser;

  function getTodayDateIso() {
    return new Date().toISOString().slice(0, 10);
  }

  // ── State ─────────────────────────────────────────────────
  /**
   * @typedef {Object} AppState
   * @description 前端全域應用狀態。所有 UI 狀態與快取集中於此，
   *              避免散落全域變數。透過直接屬性賦值更新（無 proxy）。
   *
   * ── 核心閱讀狀態 ──────────────────────────────────────────────
   * @property {string|null}  currentFile       - 當前開啟的檔案路徑（null = 首頁歡迎畫面）
   * @property {string}       currentTheme      - 主題 ID ('obsidian-dark'|'obsidian-light'|'solarized'|'zen'|'gruvbox'|'paper'|'moon'|'bamboo')
   * @property {number}       defaultFontSize   - 伺服器設定的預設字體大小（px），作為重置基準
   * @property {number}       fontSize          - 目前閱讀字體大小（px），使用者可調整
   * @property {string}       textAlign         - 文字對齊 ('justify'|'left')
   * @property {string}       lineHeight        - 行高倍數字串 ('1.6'|'1.8'|'2.0')
   * @property {string}       maxWidth          - 閱讀區最大寬度 CSS 值 ('800px'|'100%'|…)
   * @property {boolean}      autoReadProgress  - 是否自動記錄與恢復閱讀進度
   * @property {boolean}      autoS2T           - 搜尋時是否簡繁字形一併比對（預設 false；瀏覽器語言為
   *   簡體中文且使用者從未設定過時，首次造訪會自動開啟並寫入 localStorage）
   * @property {string}       displayScript     - 繁簡顯示 ('hant'|'hans'，預設 'hant'；規則同上，
   *   瀏覽器語言為簡體中文且從未設定過時，首次造訪自動切為 'hans' 並提示)
   * @property {boolean}      isMobile          - 是否為行動裝置（UA 或視窗寬度 <= 768px）
   *
   * ── 站台設定 ──────────────────────────────────────────────────
   * @property {string}       siteName          - 站台名稱（來自 config.settings.siteName，預設 'mdWebview'）
   *
   * ── 檔案系統 ──────────────────────────────────────────────────
   * @property {Array|null}   treeData          - 檔案樹資料（null = 尚未載入；由 /api/tree 回傳）
   * @property {string}       fileSort          - 檔案樹排序方式 ('name-asc'|'name-desc'|'modified-asc'|'modified-desc')
   * @property {Map}          fileSizes         - filePath → 檔案大小（bytes）的 Map，用於判斷是否需要虛擬化
   *
   * ── 歷史與書籤 ────────────────────────────────────────────────
   * @property {string[]}     recentFiles       - 最近開啟的檔案路徑列表（最多 20 筆，持久化於 localStorage）
   * @property {Object[]}     bookmarks         - 書籤物件列表（{path, title, line, ts}，持久化於 localStorage）
   *
   * ── 側邊欄 ────────────────────────────────────────────────────
   * @property {string}       sidebarTab        - 目前選中的側邊欄分頁 ('files'|'search'|'toc')
   * @property {boolean}      sidebarCollapsed  - 側邊欄是否已收合
   *
   * ── 頁內搜尋（Ctrl+F）──────────────────────────────────────────
   * @property {Object[]}     pageSearchMatches - 頁內搜尋命中節點列表
   * @property {number}       pageSearchIndex   - 目前高亮的命中項目索引（-1 = 無）
   * @property {string|null}  pageSearchQuery   - 最後一次頁內搜尋的關鍵詞
   *
   * ── 全文搜尋 ──────────────────────────────────────────────────
   * @property {string}       searchSort        - 全文搜尋結果排序 ('relevance'|'file-asc'|'file-desc'|'count-desc')
   * @property {Object|null}  lastSearchData    - 最後一次搜尋回傳資料（用於換頁排序時不重新請求）
   * @property {number}       searchRenderLimit - 已渲染的搜尋結果筆數（分批渲染計數）
   *
   * ── ScrollSpy（閱讀進度 & TOC 追蹤）──────────────────────────
   * @property {IntersectionObserver|null} scrollSpyObserver    - 用於 TOC 高亮的 IntersectionObserver
   * @property {Function|null}             scrollSpyHandler     - scroll 事件 handler 參考（用於移除）
   * @property {Function|null}             scrollSpyResizeHandler - resize 事件 handler 參考
   * @property {number|null}               scrollSpyRaf         - requestAnimationFrame ID
   * @property {Function|null}             refreshScrollSpy     - 重新初始化 ScrollSpy 的函數參考
   *
   * ── 大型檔案虛擬化（> 1MB）────────────────────────────────────
   * @property {Object|null}  virtual           - 虛擬化狀態物件（null = 非虛擬化模式）
   *                                              {si: SectionIndex, chunks: Chunk[], currentChunk: number,
   *                                               totalEntries: number, visibleStart: number, visibleEnd: number}
   * @property {Map}          sectionIndexCache - filePath → {etag, si} 的 section index 快取
   *
   * ── 辭典側邊欄 ────────────────────────────────────────────────
   * @property {boolean}      dictionaryEnabled  - 後台是否啟用辭典功能
   * @property {Object|null}  dictHeadwords      - 辭典詞條索引（由 /api/dict/headwords 載入）
   * @property {Object|null}  dictIndex          - 當前辭典條目詳情
   * @property {string|null}  dictSelected       - 目前查詢的辭典詞條
   * @property {string[]|null} dictFileOrder     - 辭典檔案顯示順序
   * @property {boolean}      dictSidebarOpen    - 辭典側邊欄是否開啟
   * @property {string}       dictMode           - 查詢模式 ('prefix'|'fulltext')
   * @property {AbortController|null} dictAbortController - 用於取消進行中的辭典請求
   * @property {Object|null}  dictFulltextCache  - 辭典全文搜尋的分頁走訪快取
   *   { query, files, pageIndex, pages: [{ after, done, results, total, capped,
   *     hasMore, nextAfter, exhausted, scrollTop }] }
   *   `pages` 是已抓取的分頁陣列（每筆由 normalizeDictFulltextPage 正規化），
   *   `after` 為產生該頁的游標、`nextAfter` 為下一頁游標、`done`/`exhausted`
   *   為累計已走完的辭典清單；`scrollTop` 保存該頁自己的捲動位置。
   *   因整份結果集可能極大，任一時刻只渲染一頁（replace 而非 append），
   *   翻回上一頁時直接重用快取而不重新請求；新查詢／切換模式／變更辭典
   *   選取都會重置為第 0 頁。
   * @property {number}       dictFulltextScrollTop - 目前分頁的滾動位置
   * @property {number|null}  dictSidebarWidth   - 辭典側邊欄寬度（px，使用者可拖拉調整）
   * @property {string|null}  dictHeadwordsETag  - 辭典 headwords 的 ETag（用於 304 Not Modified）
   * @property {number|null}  dictPollTimer      - 辭典輪詢 timer ID（檢查辭典更新）
   *
   * ── 後台管理 ──────────────────────────────────────────────────
   * @property {boolean}      isAdmin            - 目前登入者是否為管理員（session 在 HttpOnly cookie，前端不保存 token）
   * @property {Object}       account            - 帳號狀態：config（/api/auth/config）、user（/api/me）
   *
   * ── 公告彈窗 ──────────────────────────────────────────────────
   * @property {Object|null}  _announcementModalContext  - 公告彈窗最後一次開啟時的資料快照（用於判斷是否需要重新顯示）
   * @property {Object[]|null} _cachedSuggestItems        - 最後一次 /api/suggest-list 回傳的推薦項目快取
   */
  const state = {
    currentFile: null,
    currentTheme: userTheme || appConfig.defaultTheme || 'obsidian-dark',
    defaultFontSize: appConfig.defaultFontSize ? parseInt(appConfig.defaultFontSize) : 16,
    fontSize: userFont ? parseInt(userFont) : (appConfig.defaultFontSize ? parseInt(appConfig.defaultFontSize) : 16),
    textAlign: userAlign || 'justify',
    lineHeight: userLineHeight || '1.8',
    maxWidth: (isMobile && (!userMaxWidth || userMaxWidth === '100%')) ? '95%' : (userMaxWidth || '800px'),
    autoReadProgress: userReadProgress !== 'false',
    autoS2T: userAutoS2T === 'true',
    displayScript: userDisplayScript || 'hant',
    isMobile: isMobile,
    recentFiles: safeJsonParse('mdWebview-user-recentfiles', []),
    bookmarks: safeJsonParse('mdWebview-user-bookmarks', []),
    sidebarTab: 'files',
    sidebarCollapsed: false,
    treeData: null,
    pageSearchMatches: [],
    pageSearchIndex: -1,
    scrollSpyObserver: null,
    scrollSpyHandler: null,
    scrollSpyResizeHandler: null,
    scrollSpyRaf: null,
    refreshScrollSpy: null,
    isAdmin: false,
    account: { config: null, user: null },
    // Deployment mode, confirmed by /api/admin/status. The injected config gives
    // an initial hint so the very first paint is already correct.
    isSingleUser: appConfig.isSingleUser === true || appConfig.authMode === 'single-user',
    authMode: appConfig.authMode || 'admin',
    deployTarget: appConfig.deployTarget || 'web',
    siteName: appConfig.siteName || 'mdWebview',
    fileSort: 'name-asc',
    fileTreeFilter: '',
    tocFilter: '',
    searchSort: 'relevance',
    searchMode: (() => {
      const saved = storage.get(STORAGE_KEYS.SEARCH_MODE);
      if (saved === 'loose' || saved === 'strict') return saved;
      const def = appConfig.defaultSearchMode;
      return (def === 'strict' || def === 'loose') ? def : 'loose';
    })(),
    lastSearchData: null,
    searchRenderLimit: 0,
    fileSizes: new Map(),
    dictFileSizePaths: new Set(),
    virtual: null,
    sectionIndexCache: new Map(), // filePath -> { etag, si } for virtual opens
    pageSearchQuery: null,
    dictionaryEnabled: !!appConfig.dictionaryEnabled,
    dictHeadwords: null,
    dictIndex: null,
    dictSelected: null,
    dictFileOrder: null,
    dictSidebarOpen: false,
    dictMode: 'prefix',
    dictAbortController: null,
    // 全文搜尋分頁快取：{ query, files, pageIndex, pages: [...] }。每頁各自保存
    // scrollTop，切頁時先寫回目前頁再還原目標頁，故翻頁不會遺失閱讀位置。
    dictFulltextCache: null,
    dictFulltextScrollTop: 0,
    dictSidebarWidth: null,
    dictHeadwordsETag: null,
    dictPollTimer: null,
    _adminDirty: false,
    _openToken: 0,
    _openFileAbort: null,
  };

  let _lastAdminSettings = null;

  // Files at/above this byte size use virtualized rendering (must match server LARGE_FILE_MIN_BYTES).
  const LARGE_FILE_MIN_BYTES = 1048576;

  // Number of search-result rows rendered in one pass. A single search on a large
  // dictionary can return thousands of matches (up to 5000 for a single file);
  // building them all into the DOM at once froze the main thread. Rendering in
  // batches keeps the search panel responsive; "顯示更多" appends another batch.
  const SEARCH_RENDER_BATCH = 300;

  // 前端透明集合鏡像：此處為 lib/text.js 透明集合 T (TRANSPARENT_RE / isTransparent) 的前端鏡像，任何變更必須兩邊同步保持一致
  const LOOSE_TRANSPARENT_RE = /[\p{P}\n\r\u0085\u2028\u2029]/u;

  function safeDecodeURIComponent(str) {
    if (!str) return '';
    try {
      return decodeURIComponent(str);
    } catch (_) {
      try {
        return decodeURIComponent(String(str).replace(/%(?![0-9a-fA-F]{2})/g, '%25'));
      } catch (_) {
        return String(str);
      }
    }
  }

  // ── LRU Render Cache ─────────────────────────────────────
  // Caches last N rendered HTML results to avoid re-parsing unchanged files.
  const CACHE_MAX = 10;
  const renderCache = new Map(); // path -> html (insertion-order LRU)

  // Cached line anchors for the currently active document (prevents querySelectorAll on every mouseup)
  let cachedLineAnchors = [];
  function updateCachedLineAnchors(container) {
    cachedLineAnchors = Array.from(container.querySelectorAll('.line-anchor'));
  }

  function cacheGet(key) {
    if (!renderCache.has(key)) return null;
    const val = renderCache.get(key);
    // Re-insert to mark as recently used
    renderCache.delete(key);
    renderCache.set(key, val);
    // Sync sub-map insertion order
    if (renderCache.__meta && renderCache.__meta.has(key)) {
      const m = renderCache.__meta.get(key);
      renderCache.__meta.delete(key);
      renderCache.__meta.set(key, m);
    }
    if (renderCache.__etag && renderCache.__etag.has(key)) {
      const e = renderCache.__etag.get(key);
      renderCache.__etag.delete(key);
      renderCache.__etag.set(key, e);
    }
    return val;
  }

  function cacheSet(key, val) {
    if (renderCache.has(key)) renderCache.delete(key);
    renderCache.set(key, val);
    // Evict oldest entry if over limit
    if (renderCache.size > CACHE_MAX) {
      const oldestKey = renderCache.keys().next().value;
      renderCache.delete(oldestKey);
      if (renderCache.__meta) renderCache.__meta.delete(oldestKey);
      if (renderCache.__etag) renderCache.__etag.delete(oldestKey);
    }
  }

  // ── Markdown Web Worker ───────────────────────────────────
  // Spins up a single shared worker, reused across all file opens.
  let _mdWorker = null;
  let _workerCallbacks = {}; // id -> { resolve, reject }
  let _workerIdSeq = 0;

  function getMdWorker() {
    if (_mdWorker) return _mdWorker;
    _mdWorker = new Worker('/md-worker.js');
    _mdWorker.onmessage = (e) => {
      const { id, ok, html, error } = e.data;
      const cb = _workerCallbacks[id];
      if (!cb) return;
      delete _workerCallbacks[id];
      if (ok) cb.resolve(html);
      else cb.reject(new Error(error));
    };
    _mdWorker.onerror = (err) => {
      // Fallback: terminate worker so next call re-creates it
      console.error('[md-worker] Worker error, will recreate on next call:', err && err.message);
      // Reject any pending callbacks so their Promise + captured body don't leak.
      for (const id of Object.keys(_workerCallbacks)) {
        const cb = _workerCallbacks[id];
        delete _workerCallbacks[id];
        try { cb.reject(new Error('md-worker failed')); } catch (_) {}
      }
      try { _mdWorker.terminate(); } catch (_) {}
      _mdWorker = null;
    };
    return _mdWorker;
  }

  function parseMarkdownInWorker(body) {
    return new Promise((resolve, reject) => {
      const id = ++_workerIdSeq;
      _workerCallbacks[id] = { resolve, reject };
      try {
        getMdWorker().postMessage({ id, body });
      } catch (err) {
        delete _workerCallbacks[id];
        reject(err);
      }
    });
  }

  // ── DOM Helpers ───────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const $$ = (sel, root) => (root || document).querySelectorAll(sel);

  // ═══════════════════════════════════════════════════════════
  // §1 INIT & BOOT HOOKS (loadSettings, initUI, URL params)
  // ═══════════════════════════════════════════════════════════
  /**
   * 應用程式主要啟動函數，由 DOMContentLoaded 事件觸發。
   * 按序執行：marked 初始化 → 載入使用者設定 → 初始化 UI 元件 →
   * 取得目錄樹 → 取得推薦列表並觸發公告彈窗 → 處理 URL 深連結。
   */
  async function init() {
    // 繁簡顯示最先處理：簡體時 body 由 CSS 隱藏，愈早轉換完成愈早顯示。
    initDisplayScript();

    // Configure marked once at startup (not on every render)
    marked.setOptions({ breaks: true, gfm: true, headerIds: true, mangle: false });
    marked.use({
      tokenizer: {
        del(src) {
          // Standard GFM double tildes strikethrough only (prevent single tildes ~P11~P12~ range syntax from trigger del)
          const cap = /^~~(?=[^\s~])([\s\S]*?[^\s~])~~/.exec(src);
          if (cap) {
            return {
              type: 'del',
              raw: cap[0],
              text: cap[1],
              tokens: this.lexer.inlineTokens(cap[1])
            };
          }
          return undefined;
        }
      },
      extensions: [
        {
          name: 'highlight',
          level: 'inline',
          start(src) { return _scanEq ? src.indexOf('==') : -1; },
          tokenizer(src, tokens) {
            const rule = /^==(?=[^\s=])([\s\S]*?[^\s=])==/;
            const match = rule.exec(src);
            if (match) {
              return {
                type: 'highlight',
                raw: match[0],
                text: match[1],
                tokens: this.lexer.inlineTokens(match[1])
              };
            }
          },
          renderer(token) {
            return `<mark class="obsidian-highlight">${this.parser.parseInline(token.tokens)}</mark>`;
          }
        },
        {
          name: 'mathBlock',
          level: 'block',
          start(src) { return _scanDollar2 ? src.indexOf('$$') : -1; },
          tokenizer(src, tokens) {
            const rule = /^\$\$[\r\n]*([\s\S]*?)[\r\n]*\$\$/;
            const match = rule.exec(src);
            if (match) {
              return {
                type: 'mathBlock',
                raw: match[0],
                text: match[1].trim()
              };
            }
          },
          renderer(token) {
            return `<div class="math-block" data-math="${escHtml(token.text)}">$$${escHtml(token.text)}$$</div>\n`;
          }
        },
        {
          name: 'mathInline',
          level: 'inline',
          start(src) { return _scanDollar ? src.indexOf('$') : -1; },
          tokenizer(src, tokens) {
            const rule = /^\$(?!\s)([^$\n]+?)(?<!\s)\$/;
            const match = rule.exec(src);
            if (match) {
              return {
                type: 'mathInline',
                raw: match[0],
                text: match[1].trim()
              };
            }
          },
          renderer(token) {
            return `<span class="math-inline" data-math="${escHtml(token.text)}">$${escHtml(token.text)}$</span>`;
          }
        }
      ]
    });
    // Pre-warm the Web Worker so first file open has no startup delay
    getMdWorker();

    await checkAdminStatus();
    applyTheme(state.currentTheme, false);
    applyFontSize(state.fontSize, false);
    applyTextAlign(state.textAlign, false);
    applyLineHeight(state.lineHeight, false);
    applyMaxWidth(state.maxWidth, false);
    applyAutoReadProgress(state.autoReadProgress, false);
    applyAutoS2T(state.autoS2T, false);

    // Ensure initial user preferences are saved in localStorage so subsequent changes
    // to defaultTheme or defaultFontSize by the administrator do not override existing users.
    if (!storage.get(STORAGE_KEYS.THEME) && state.currentTheme) {
      storage.set(STORAGE_KEYS.THEME, state.currentTheme);
    }
    if (!storage.get(STORAGE_KEYS.FONT_SIZE) && state.fontSize) {
      storage.set(STORAGE_KEYS.FONT_SIZE, state.fontSize);
    }

    updateWelcomeShortcuts();
    updateWelcomeFooter(appConfig);
    setupEventListeners();
    // 帳號：不等網路，避免拖慢第一次開啟經文。
    initAccounts().catch(err => console.error('Account init failed:', err));
    if (isMobileBrowser() || window.innerWidth <= 768) {
      const sidebar = $('sidebar');
      if (sidebar) sidebar.classList.add('collapsed');
      state.sidebarCollapsed = true;
    }
    await loadTree();
    fetchSuggestList(true); // Load recommend & hot list for homepage and check landing announcement modal

    // Open file from URL query or hash on first load; if home/frontpage specified, show welcome screen; if none, attempt restoring last read progress
    const urlInfo = getFileFromURL();
    if (urlInfo && urlInfo.search) {
      // ?search= 為明確的入口意圖，優先於其他參數（此時不會有 file）。
      activateSearchPanel(urlInfo.search);
    } else if (urlInfo && urlInfo.isHome) {
      goHome(false);
    } else if (urlInfo && urlInfo.file) {
      // query 一併傳入，否則 ?file=...&q=... 的關鍵字會被靜默丟棄
      // （highlightQuery 一直是 openFile 的既有參數，只是沒有來源）。
      await openFile(urlInfo.file, urlInfo.line, urlInfo.query);
    } else {
      restoreReadProgress();
    }

    // Handle browser back / forward
    const handleUrlChange = async () => {
      const info = getFileFromURL();
      if (info && info.search) {
        // 上一頁／下一頁回到 ?search= 時必須重建面板：期間可能已開啟別的
        // 經文、側欄被收合或分頁被切走。popstate 只在真實的歷史移動時
        // 觸發，故不需去重。
        activateSearchPanel(info.search);
      } else if (info && info.isHome) {
        goHome(false);
      } else if (info && info.file && info.file !== state.currentFile) {
        await openFile(info.file, info.line, info.query);
      } else if (info && info.line) {
        // Same file, different line
        scrollToLine(info.line);
      }
    };
    window.addEventListener('hashchange', handleUrlChange);
    window.addEventListener('popstate', handleUrlChange);

    initPwaServiceWorker();
    setupInstallPrompt();
  }

  function initPwaServiceWorker() {
    if ('serviceWorker' in navigator) {
      // `init()` 由 DOMContentLoaded 觸發，且在抵達這裡之前已有多個 await
      // （checkAdminStatus、loadTree、可能還有 openFile）。在 localhost 或
      // 快取命中的情況下，這些 await 會讓 window 的 `load` 事件在監聽器掛上
      // 之前就發生，於是 `addEventListener('load', …)` 永遠不會被呼叫——
      // Service Worker 從未註冊，離線閱讀形同無效（實測：load 於 2468ms 觸發，
      // 監聽器 2575ms 才掛上）。因此若文件已載入完成就直接註冊，否則才等 load。
      const registerSw = () => {
        navigator.serviceWorker.register('/sw.js')
          .then(reg => {
            try { reg.update(); } catch (_) {}
            reg.addEventListener('updatefound', () => {
              const newWorker = reg.installing;
              if (newWorker) {
                newWorker.addEventListener('statechange', () => {
                  if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                    try { newWorker.postMessage({ action: 'SKIP_WAITING' }); } catch (_) {}
                    showToast('🎉 發現新版本！已在背景準備就緒，重新載入即可生效', 'info', 5000);
                  }
                });
              }
            });
          })
          .catch(err => {
            console.warn('[PWA] Service Worker registration failed:', err);
          });
      };

      if (document.readyState === 'complete') {
        registerSw();
      } else {
        window.addEventListener('load', registerSw, { once: true });
      }
    }

    // Network status monitoring
    window.addEventListener('offline', () => {
      showToast('📶 目前處於離線狀態，可繼續閱讀已快取經文', 'warning', 4000);
    });
    window.addEventListener('online', () => {
      showToast('🌐 網路連線已恢復', 'success', 3000);
    });
  }

  // ═══════════════════════════════════════════════════════════
  // §16.5 PWA 安裝引導
  // ═══════════════════════════════════════════════════════════
  //
  // 目標：讓使用者把站台加到手機桌面。這件事在技術上早就可行，但沒有任何
  // 引導，於是幾乎沒有人知道要做——功能做完卻無人使用，等於沒做。
  //
  // 幾個刻意的設計決定：
  //
  // 1. 不在第一次造訪就提。那時使用者連這是什麼都不知道，此刻談安裝只會被
  //    關掉，而且會被記住「這站很煩」。改為等使用者讀過東西（見
  //    shouldOfferInstall）之後才出現。
  //
  // 2. 被拒絕後靜默 3 天。但「以後再說」不寫入永久紀錄，偏好設定裡永遠
  //    保留一個入口——使用者改變主意時找得到路。
  //
  // 3. iOS 沒有 beforeinstallprompt，無法用程式觸發安裝。硬要做只會變成
  //    一個按了沒反應的按鈕，所以改走圖文教學（showInstallGuide）。
  //
  // 4. 文案避開「PWA」「安裝應用程式」等詞。目標讀者要的是「把經書帶在
  //    身上」，不是「部署一個 Web App」。

  /**
   * 「以後再說」之後的靜默天數。
   *
   * 3 天而非更長：這個數字要在「不再騷擾」與「還來得及被想起」之間取捨。
   * 30 天對多數讀者而言等於「永遠不會再看到」，安裝率被壓得過低；3 天大致
   * 涵蓋一次連續閱讀的節奏，過了就換個時機再提一次。若使用者真的不需要，
   * 第二次婉拒後通常也已建立起明確態度，此時再拉長也無意義。
   */
  const INSTALL_SNOOZE_DAYS = 3;

  /** beforeinstallprompt 事件的暫存（只能呼叫一次，用完即失效） */
  let _deferredInstallPrompt = null;
  /** 已安裝的旗標：避免同一分頁內重複顯示引導 */
  let _installDone = false;

  /**
   * 是否為 iOS（含 iPadOS）。
   *
   * iPadOS 13 以後的 Safari 使用者代理偽裝成 macOS，只看 UA 會漏掉所有 iPad，
   * 因此額外用「Mac 平台 + 多點觸控」判定。這個判斷只影響要走哪一種引導，
   * 誤判最壞情況是顯示 iOS 教學，不會造成功能錯誤。
   *
   * @returns {boolean}
   */
  function isIOSDevice() {
    const ua = navigator.userAgent || '';
    if (/iphone|ipad|ipod/i.test(ua)) return true;
    return navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1;
  }

  /**
   * 是否已以「安裝後」的形式執行（standalone 視窗）。
   *
   * iOS Safari 不支援 display-mode 媒體查詢，另有專屬的 navigator.standalone，
   * 兩者都要檢查。已經裝好的人不該再看到任何安裝引導。
   *
   * @returns {boolean}
   */
  function isStandaloneMode() {
    try {
      if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
    } catch (_) {}
    return navigator.standalone === true;
  }

  /**
   * 這個瀏覽器「有沒有能力」安裝。
   *
   * iOS 一律視為可引導（走教學），因為 Safari 不會發出 beforeinstallprompt，
   * 不能用事件判斷。其餘瀏覽器則必須真的收到過該事件才算數，否則會出現
   * 「引導了但按下去沒反應」的窘境。
   *
   * @returns {boolean}
   */
  function canOfferInstall() {
    if (isStandaloneMode() || _installDone) return false;
    if (storage.get(STORAGE_KEYS.INSTALL_INSTALLED) === '1') return false;
    if (isIOSDevice()) return true;
    return !!_deferredInstallPrompt;
  }

  /**
   * 使用者是否已投入足夠心力，值得談安裝。
   *
   * 判定依據是「真實使用痕跡」而非時間或次數：
   *   - 讀過 2 篇以上（recentFiles）
   *   - 有續讀紀錄（LAST_READ_PROGRESS）→ 回頭客
   * 任一成立即可。這兩個訊號都來自既有資料，不需要新增埋點。
   *
   * @returns {boolean}
   */
  function shouldOfferInstall() {
    if (!canOfferInstall()) return false;
    if (state.recentFiles && state.recentFiles.length >= 2) return true;
    const progress = storage.getJson(STORAGE_KEYS.LAST_READ_PROGRESS);
    return !!(progress && progress.filePath);
  }

  /**
   * 是否仍在「被拒絕後」的靜默期內（3 天）。
   *
   * 靜默期長度集中定義在 INSTALL_SNOOZE_DAYS，避免天數散落在多處而失去同步。
   *
   * @returns {boolean} true 表示仍在靜默期，不應主動顯示引導
   */
  function isInstallSnoozed() {
    const raw = storage.get(STORAGE_KEYS.INSTALL_DISMISSED);
    if (!raw) return false;
    const ts = parseInt(raw, 10);
    if (!Number.isFinite(ts)) return false;
    return (Date.now() - ts) < INSTALL_SNOOZE_DAYS * 24 * 60 * 60 * 1000;
  }

  /**
   * 首頁安裝卡片的文案。iOS 與其他平台走不同的說明：
   * iOS 只能教學，因此描述「怎麼加」；其餘平台描述「加了有什麼好處」。
   */
  function applyInstallCardCopy() {
    const title = $('installCardTitle');
    const desc = $('installCardDesc');
    const accept = $('installCardAccept');
    if (!title || !desc || !accept) return;

    if (isIOSDevice()) {
      title.textContent = '把經書放到手機桌面';
      desc.textContent = 'iPhone 需要手動加入：點下方分享鈕，選「加入主畫面」，再按「新增」。點一下就能讀，沒網路也能看。';
      accept.textContent = '看怎麼加入';
    } else {
      title.textContent = '把經書放到手機桌面';
      desc.textContent = '加入桌面後不必再開瀏覽器，點一下就能讀，已讀過的經文沒有網路也能看。';
      accept.textContent = '好，加到桌面';
    }
  }

  /**
   * 依當前狀態決定是否顯示首頁安裝卡片。
   *
   * @param {boolean} [force=false] - true 時略過時機與靜默期判斷（供設定頁手動開啟）
   */
  function maybeShowInstallCard(force = false) {
    const card = $('installCard');
    if (!card) return;

    if (_installDone || isStandaloneMode()) {
      card.hidden = true;
      return;
    }
    if (!force && (isInstallSnoozed() || !shouldOfferInstall())) {
      card.hidden = true;
      return;
    }
    applyInstallCardCopy();
    card.hidden = false;
  }

  /** 隱藏首頁安裝卡片 */
  function hideInstallCard() {
    const card = $('installCard');
    if (card) card.hidden = true;
  }

  /**
   * 顯示 iOS 圖文教學 Modal。
   *
   * 非 iOS 平台不顯示：那裡的安裝由原生對話框完成，教學反而多餘。
   */
  function showInstallGuide() {
    if (!isIOSDevice()) return false;
    const overlay = $('installGuideOverlay');
    if (!overlay) return false;
    overlay.style.display = 'flex';
    overlay.setAttribute('aria-hidden', 'false');
    const done = $('installGuideDoneBtn');
    if (done) {
      try { done.focus(); } catch (_) {}
    }
    return true;
  }

  /** 關閉 iOS 圖文教學 Modal */
  function closeInstallGuide() {
    const overlay = $('installGuideOverlay');
    if (!overlay) return;
    overlay.style.display = 'none';
    overlay.setAttribute('aria-hidden', 'true');
    // 看完教學即視為「已處理」，進入靜默期，避免每次回首頁都再問一次。
    storage.set(STORAGE_KEYS.INSTALL_DISMISSED, String(Date.now()));
    hideInstallCard();
  }

  /**
   * 觸發安裝流程。
   *
   * iOS 走圖文教學；其餘平台呼叫原生 prompt。若 prompt 不存在（例如已經
   * 用過一次），退回顯示提示，而不是靜默失敗——按鈕沒反應是最糟的體驗。
   */
  async function triggerInstall() {
    if (isStandaloneMode() || _installDone) {
      showToast('✅ 已經加入桌面了', 'info', 2500);
      return;
    }

    if (isIOSDevice()) {
      showInstallGuide();
      return;
    }

    if (!_deferredInstallPrompt) {
      showToast('請從瀏覽器選單選擇「安裝應用程式」或「加到主畫面」', 'info', 4500);
      return;
    }

    const promptEvent = _deferredInstallPrompt;
    _deferredInstallPrompt = null;
    try {
      promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      if (choice && choice.outcome === 'accepted') {
        markInstalled();
      } else {
        storage.set(STORAGE_KEYS.INSTALL_DISMISSED, String(Date.now()));
        hideInstallCard();
      }
    } catch (err) {
      console.warn('[PWA] install prompt failed:', err);
      showToast('安裝未完成，可從瀏覽器選單手動加入', 'warning', 4000);
    }
  }

  /** 記錄「已安裝」狀態並收起所有引導 */
  function markInstalled() {
    _installDone = true;
    storage.set(STORAGE_KEYS.INSTALL_INSTALLED, '1');
    hideInstallCard();
    updateInstallSettingsVisibility();
    showToast('✅ 已加入桌面，點圖示就能開始閱讀', 'success', 4000);
  }

  /**
   * 更新設定頁「加到桌面」區塊的可見性。
   *
   * 已安裝或瀏覽器無安裝能力時整段隱藏——對已經裝好的人來說那只是雜訊。
   * 但 iOS 例外：Safari 不發事件，只能靠裝置判斷，故 iOS 一律顯示。
   */
  function updateInstallSettingsVisibility() {
    const section = $('installSettingsSection');
    if (!section) return;
    const available = !isStandaloneMode() && !_installDone
      && storage.get(STORAGE_KEYS.INSTALL_INSTALLED) !== '1'
      && (isIOSDevice() || !!_deferredInstallPrompt);
    section.style.display = available ? '' : 'none';
  }

  /**
   * 綁定安裝引導相關事件。於 init() 尾端呼叫一次。
   */
  function setupInstallPrompt() {
    // 瀏覽器認為可安裝時才拿得到這個事件。必須 preventDefault，否則部分
    // 平台會自行跳出小橫幅，與我們自己的引導互相干擾。
    window.addEventListener('beforeinstallprompt', e => {
      try { e.preventDefault(); } catch (_) {}
      _deferredInstallPrompt = e;
      updateInstallSettingsVisibility();
      maybeShowInstallCard();
    });

    // 使用者從瀏覽器選單自行安裝時也會觸發，一併記錄。
    window.addEventListener('appinstalled', () => {
      markInstalled();
    });

    const accept = $('installCardAccept');
    if (accept) accept.addEventListener('click', triggerInstall);

    const later = $('installCardLater');
    if (later) {
      later.addEventListener('click', () => {
        storage.set(STORAGE_KEYS.INSTALL_DISMISSED, String(Date.now()));
        hideInstallCard();
      });
    }

    const settingsBtn = $('btnInstallPwa');
    if (settingsBtn) settingsBtn.addEventListener('click', triggerInstall);

    const guideDone = $('installGuideDoneBtn');
    if (guideDone) guideDone.addEventListener('click', closeInstallGuide);

    const guideClose = $('installGuideCloseBtn');
    if (guideClose) guideClose.addEventListener('click', closeInstallGuide);

    const guideOverlay = $('installGuideOverlay');
    if (guideOverlay) {
      // 點背景關閉，與其他 Modal 的行為一致。
      guideOverlay.addEventListener('click', e => {
        if (e.target === guideOverlay) closeInstallGuide();
      });
    }

    // Esc 關閉教學（它是 Modal，理應支援鍵盤退出）。
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      const overlay = $('installGuideOverlay');
      if (overlay && overlay.style.display === 'flex') closeInstallGuide();
    });

    // 已安裝（standalone）者直接顯示「已安裝」而非引導。
    if (isStandaloneMode()) {
      _installDone = true;
      hideInstallCard();
    }

    updateInstallSettingsVisibility();
    maybeShowInstallCard();
  }

  /**
   * 解析網址列參數為應用可用的路由資訊（純函式，可獨立測試）。
   *
   * 支援的入口：
   *   ?file=<path>&line=<n>&q=<kw>  — 開啟指定經文（q 會在文內閃示關鍵字）
   *   ?search=<kw>                  — 直接執行全庫搜尋（可分享／加書籤／設為
   *                                   瀏覽器搜尋引擎）
   *   ?home=1 / ?frontpage=1        — 回首頁
   *   #file=... / #home             — 舊版雜湊格式，保留回溯相容
   *
   * ?search= 獨立於 ?file= 之外：它是「搜尋」而非「跳行」，因此即使在沒有
   * file 參數的情況下也必須成立。這也是原本 ?q= 失效的原因——它被掛在 file
   * 分支底下，而呼叫端又沒把 query 傳進 openFile，等於整條路徑都沒接上。
   *
   * @param {string} search - location.search（含開頭的 ?）
   * @param {string} hash   - location.hash（含開頭的 #）
   * @returns {{isHome?:boolean,file?:string,line?:number|null,query?:string|null,search?:string}|null}
   */
  function parseUrlParams(search, hash) {
    let searchParams;
    try {
      searchParams = new URLSearchParams(search || '');
    } catch (e) {
      searchParams = new URLSearchParams('');
    }

    // 全庫搜尋入口，優先於其他所有參數（含 file 與 home）。空字串／純空白
    // 視為「沒有參數」，否則 ?search= 會清空結果面板並讓使用者以為功能壞掉。
    //
    // 之所以能安全地擺在最前面：search= 是本次新增的參數，既有網址不可能
    // 帶有它，因此不會改變任何現存書籤的行為；而將它統一置頂可避免
    // ?file=x&search=y 與 ?home=1&search=y 出現不一致的優先順序。
    //
    // 500 字元上限是防禦性邊界（/api/search 本身不截斷，只受 Node 約 16KB 的
    // 請求行上限保護）：避免精心構造的超長網址驅動一次極昂貴的搜尋。真實的
    // 搜尋詞遠短於此，故正常使用不會察覺。
    const rawSearch = searchParams.get('search');
    if (rawSearch !== null && rawSearch.trim()) {
      return { search: rawSearch.trim().slice(0, 500) };
    }

    // Check for explicit frontpage / home URL parameters (e.g. ?home=1, ?frontpage=1, ?home, ?frontpage, ?page=home)
    const pageVal = (searchParams.get('page') || '').toLowerCase();
    const hasHomeParam = searchParams.has('home') || searchParams.has('frontpage') || pageVal === 'home' || pageVal === 'frontpage';
    if (hasHomeParam) {
      const homeVal = searchParams.get('home') || searchParams.get('frontpage');
      if (homeVal !== 'false' && homeVal !== '0') {
        return { isHome: true };
      }
    }

    // 1. Try query parameters first (server readable)
    let searchFile = searchParams.get('file');
    if (!searchFile) {
      const match = (search || '').match(/[?&]file=([^&]+)/);
      if (match) searchFile = match[1];
    }
    if (searchFile) {
      searchFile = safeDecodeURIComponent(searchFile);
      const searchLine = searchParams.get('line') ? parseInt(searchParams.get('line')) : null;
      const searchQuery = searchParams.get('q') || searchParams.get('query') || null;
      return { file: searchFile, line: searchLine, query: searchQuery };
    }

    // 2. Fallback to hash (backwards compatibility)
    if (hash && hash.startsWith('#file=')) {
      try {
        const params = new URLSearchParams(hash.slice(1));
        const file = params.get('file');
        const line = params.get('line') ? parseInt(params.get('line')) : null;
        return file ? { file: safeDecodeURIComponent(file), line } : null;
      } catch (e) {
        return null;
      }
    }
    if (hash === '#home' || hash === '#frontpage') {
      return { isHome: true };
    }

    return null;
  }

  function getFileFromURL() {
    return parseUrlParams(window.location.search, window.location.hash);
  }

  /**
   * Safely scroll an element into view inside an overflow container without
   * causing the outer window/body to scroll up on iOS Safari / Mobile browsers.
   */
  function safeScrollToElement(targetEl, containerEl, blockPos = 'start') {
    if (!targetEl) return;
    if (!containerEl) containerEl = $('content');
    if (!containerEl) return;

    const targetRect = targetEl.getBoundingClientRect();
    const containerRect = containerEl.getBoundingClientRect();
    
    let targetScrollTop = containerEl.scrollTop + (targetRect.top - containerRect.top);
    
    if (blockPos === 'start') {
      targetScrollTop -= 12;
    } else if (blockPos === 'center') {
      targetScrollTop -= (containerRect.height / 2) - (targetRect.height / 2);
    }

    containerEl.scrollTo({
      top: Math.max(0, targetScrollTop),
      behavior: 'smooth'
    });

    // iOS Safari Safety Guard: Force window scrollY back to 0 to prevent header shifting
    if (window.scrollY !== 0) {
      window.scrollTo(0, 0);
    }
  }

  // iOS Safari Window Scroll Guard — Keep window.scrollY strictly at 0
  window.addEventListener('scroll', () => {
    if (window.scrollY !== 0) {
      window.scrollTo(0, 0);
    }
  }, { passive: true });

  function clearLineKeywordHighlights() {
    const highlights = document.querySelectorAll('mark.search-keyword-highlight');
    highlights.forEach(mark => {
      const parent = mark.parentNode;
      if (parent) {
        parent.replaceChild(document.createTextNode(mark.textContent), mark);
        parent.normalize();
      }
    });
  }

  /**
   * 閱讀區高亮是否以字組比對（簡繁變體互相命中，見 i18n/search-variants.js）。
   * 簡體顯示時畫面上是 OpenCC 轉換後的字，而轉換結果必定與原字同組，
   * 所以同一套字組比對同時適用於原文與畫面字形。
   */
  function highlightVariants() {
    return s2tQueryEnabled() || !!(state.lastSearchData && state.lastSearchData.variants);
  }

  /** 查詢詞的 RegExp 片段：字組比對時每個字為 [字組]，否則為字面跳脫。 */
  function termRegexSource(term, variants) {
    const sv = variants ? window.mdSearchVariants : null;
    return sv ? sv.termPattern(term, false) : escRegex(term);
  }

  /** 兩字是否視為相同（字組比對時同組即相同）。 */
  function sameSearchChar(a, b, variants) {
    if (a === b) return true;
    const sv = window.mdSearchVariants;
    return !!(variants && sv && sv.same(a, b));
  }

  function highlightLineKeyword(anchorEl, query, searchMode) {
    if (!anchorEl || !query || typeof query !== 'string') return { matched: false, hitBlock: null, firstMark: null };
    const mode = searchMode || (state.lastSearchData && state.lastSearchData.mode) || state.searchMode || 'loose';

    // ── 嚴格模式 (Strict Mode)：保留字面 regex 與單區塊/連續節點走訪行為 ──
    if (mode !== 'loose') {
      const terms = query.trim().split(/\s+/).filter(Boolean);
      if (terms.length === 0) return { matched: false, hitBlock: null, firstMark: null };

      const variants = highlightVariants();
      const regexPattern = terms.map(t => termRegexSource(t, variants)).join('|');
      if (!regexPattern) return { matched: false, hitBlock: null, firstMark: null };
      const regex = new RegExp(`(${regexPattern})`, 'gi');

      const lineTextNodes = [];
      function nextNode(node) {
        if (node.firstChild) return node.firstChild;
        while (node) {
          if (node.nextSibling) return node.nextSibling;
          node = node.parentNode;
        }
        return null;
      }

      let node = nextNode(anchorEl);
      while (node) {
        if (node.nodeType === 1 && node.classList && node.classList.contains('line-anchor')) break;
        if (node.nodeType === 3 && node.nodeValue && node.nodeValue.length > 0) {
          lineTextNodes.push(node);
        }
        node = nextNode(node);
      }

      let firstMark = null;
      let hitBlock = null;

      lineTextNodes.forEach(textNode => {
        const val = textNode.nodeValue;
        if (!val || !regex.test(val)) return;

        regex.lastIndex = 0;
        const fragment = document.createDocumentFragment();
        let lastIdx = 0;
        let match;

        while ((match = regex.exec(val)) !== null) {
          const matchStart = match.index;
          const matchText = match[0];

          if (matchStart > lastIdx) {
            fragment.appendChild(document.createTextNode(val.substring(lastIdx, matchStart)));
          }

          const mark = document.createElement('mark');
          mark.className = 'search-keyword-highlight';
          mark.textContent = matchText;
          fragment.appendChild(mark);
          if (!firstMark) {
            firstMark = mark;
            hitBlock = textNode.parentElement?.closest('p, h1, h2, h3, h4, h5, h6, li, blockquote, tr, pre, table, .obsidian-callout') || textNode.parentElement;
          }

          lastIdx = matchStart + matchText.length;
        }

        if (lastIdx < val.length) {
          fragment.appendChild(document.createTextNode(val.substring(lastIdx)));
        }

        if (textNode.parentNode) {
          textNode.parentNode.replaceChild(fragment, textNode);
        }
      });

      return { matched: !!firstMark, hitBlock: hitBlock || anchorEl.parentElement, firstMark };
    }

    // ── 寬鬆模式 (Loose Mode)：標點與換行透明（空白不透明），有界連續區塊走訪 ──
    const startBlock = anchorEl.closest('p, h1, h2, h3, h4, h5, h6, li, blockquote, tr, pre, table, .obsidian-callout') || anchorEl.parentElement;
    const windowBlocks = [];
    if (startBlock) {
      // 往前擴展至多 2 個兄弟區塊（遇標題或 hr 不跨越）
      let prev = startBlock.previousElementSibling;
      let prevCount = 0;
      while (prev && prevCount < 2) {
        if (/^H[1-6]$/i.test(prev.tagName) || prev.tagName === 'HR') break;
        windowBlocks.unshift(prev);
        prev = prev.previousElementSibling;
        prevCount++;
      }
      windowBlocks.push(startBlock);
      // 往後擴展至多 20 個兄弟區塊（遇下一個標題停止）
      let next = startBlock.nextElementSibling;
      let nextCount = 0;
      while (next && nextCount < 20) {
        if (/^H[1-6]$/i.test(next.tagName) && nextCount > 0) break;
        windowBlocks.push(next);
        if (/^H[1-6]$/i.test(next.tagName)) break;
        next = next.nextElementSibling;
        nextCount++;
      }
    } else if (anchorEl.parentElement) {
      windowBlocks.push(anchorEl.parentElement);
    }

    const textNodeItems = [];
    for (const blk of windowBlocks) {
      const walker = document.createTreeWalker(
        blk,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode(n) {
            if (!n.nodeValue || n.nodeValue.length === 0) return NodeFilter.FILTER_REJECT;
            if (n.parentElement && n.parentElement.closest('.line-anchor')) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          }
        }
      );
      let cur;
      while ((cur = walker.nextNode())) {
        textNodeItems.push({ node: cur, block: blk });
      }
    }

    // 建立字元序列（跨區塊時插入虛擬換行 \n，在寬鬆模式下為透明字元）
    const seq = [];
    let lastBlk = null;
    for (const { node, block } of textNodeItems) {
      if (lastBlk && block !== lastBlk) {
        seq.push({ ch: '\n', node: null, startIdx: -1, endIdx: -1, block });
      }
      lastBlk = block;

      const val = node.nodeValue;
      let idx = 0;
      while (idx < val.length) {
        const cp = val.codePointAt(idx);
        const ch = cp > 0xFFFF ? String.fromCodePoint(cp) : val[idx];
        seq.push({ ch, node, startIdx: idx, endIdx: idx + ch.length, block });
        idx += ch.length;
      }
    }

    const rawTerms = (state.lastSearchData && Array.isArray(state.lastSearchData.terms) && state.lastSearchData.terms.length > 0)
      ? state.lastSearchData.terms
      : query.trim().split(/\s+/).filter(Boolean);

    const terms = rawTerms.filter(Boolean);
    const variants = highlightVariants();

    const matchedRanges = [];
    for (const term of terms) {
      const cleanChars = [];
      let tIdx = 0;
      while (tIdx < term.length) {
        const cp = term.codePointAt(tIdx);
        const ch = cp > 0xFFFF ? String.fromCodePoint(cp) : term[tIdx];
        tIdx += ch.length;
        if (!LOOSE_TRANSPARENT_RE.test(ch)) {
          cleanChars.push(ch);
        }
      }
      if (cleanChars.length === 0) continue;

      const firstChar = cleanChars[0];
      let pos = 0;
      const seqLen = seq.length;

      while (pos < seqLen) {
        let start = -1;
        for (let i = pos; i < seqLen; i++) {
          if (sameSearchChar(seq[i].ch, firstChar, variants)) {
            start = i;
            break;
          }
        }
        if (start === -1) break;

        let idx = start + 1;
        let k = 1;
        while (idx < seqLen && k < cleanChars.length) {
          const item = seq[idx];
          if (LOOSE_TRANSPARENT_RE.test(item.ch)) {
            idx++;
            continue;
          }
          if (sameSearchChar(item.ch, cleanChars[k], variants)) {
            k++;
            idx++;
          } else {
            break;
          }
        }

        if (k === cleanChars.length) {
          matchedRanges.push({ start, end: idx });
          pos = idx > start ? idx : start + 1;
        } else {
          pos = start + 1;
        }
      }
    }

    if (matchedRanges.length === 0) {
      return { matched: false, hitBlock: null, firstMark: null };
    }

    let firstItem = null;
    for (const range of matchedRanges) {
      for (let i = range.start; i < range.end; i++) {
        if (seq[i].node) {
          firstItem = seq[i];
          break;
        }
      }
      if (firstItem) break;
    }
    const hitBlock = firstItem
      ? (firstItem.block || firstItem.node.parentElement?.closest('p, h1, h2, h3, h4, h5, h6, li, blockquote, tr, pre, table, .obsidian-callout') || startBlock)
      : startBlock;

    const nodeHighlights = new Map();
    for (const range of matchedRanges) {
      for (let i = range.start; i < range.end; i++) {
        const item = seq[i];
        if (!item.node) continue;
        let list = nodeHighlights.get(item.node);
        if (!list) {
          list = [];
          nodeHighlights.set(item.node, list);
        }
        list.push({ start: item.startIdx, end: item.endIdx });
      }
    }

    let firstMark = null;
    for (const [textNode, intervals] of nodeHighlights.entries()) {
      intervals.sort((a, b) => a.start - b.start || a.end - b.end);
      const merged = [];
      for (const intv of intervals) {
        if (merged.length === 0) {
          merged.push({ start: intv.start, end: intv.end });
        } else {
          const prev = merged[merged.length - 1];
          if (intv.start <= prev.end) {
            prev.end = Math.max(prev.end, intv.end);
          } else {
            merged.push({ start: intv.start, end: intv.end });
          }
        }
      }

      const val = textNode.nodeValue;
      const frag = document.createDocumentFragment();
      let lastIdx = 0;
      for (const { start, end } of merged) {
        if (start > lastIdx) {
          frag.appendChild(document.createTextNode(val.substring(lastIdx, start)));
        }
        const mark = document.createElement('mark');
        mark.className = 'search-keyword-highlight';
        mark.textContent = val.substring(start, end);
        frag.appendChild(mark);
        if (!firstMark) firstMark = mark;
        lastIdx = end;
      }
      if (lastIdx < val.length) {
        frag.appendChild(document.createTextNode(val.substring(lastIdx)));
      }
      if (textNode.parentNode) {
        textNode.parentNode.replaceChild(frag, textNode);
      }
    }

    return { matched: true, hitBlock, firstMark };
  }

  /**
   * 捲動至指定行並選擇性閃示關鍵字高亮（非虛擬化路徑；虛擬化則轉交
   * scrollToLineVirtual）。
   *
   * 定位目標一律是「要求的那一行」anchor（`target`），而非 `hlRes.firstMark`：
   * 寬鬆模式的高亮視窗會向前納入兄弟區塊（見 highlightLineKeyword），
   * firstMark 因此可能位在要求行之前，若以它定位游標會停在該 mark 而非使用者
   * 點選的行。關鍵字 mark 僅用於閃示。
   *
   * @param {number} lineNum        - 目標行號（0/null 時直接返回）
   * @param {string} [highlightQuery] - 要閃示的關鍵字（可省略）
   * @param {string} [searchMode]   - 高亮模式（'loose'/'strict'），預設沿用上次搜尋
   */
  function scrollToLine(lineNum, highlightQuery, searchMode) {
    clearLineKeywordHighlights();
    if (!lineNum) return;

    if (isVirtualMode()) {
      scrollToLineVirtual(lineNum, highlightQuery, searchMode);
      return;
    }

    // Try exact line anchor first; fall back to the anchor of the block that
    // contains the line (body continuation lines carry no anchor of their own —
    // see anchorAtOrBefore).
    if (!cachedLineAnchors.length) {
      const mb = $('markdownBody');
      if (mb) updateCachedLineAnchors(mb);
    }
    let target = document.getElementById('L' + lineNum);
    if (!target) target = anchorAtOrBefore(lineNum);
    if (target) {
      const mode = searchMode || (state.lastSearchData && state.lastSearchData.mode) || state.searchMode || 'loose';
      let hlRes = null;
      if (highlightQuery) {
        hlRes = highlightLineKeyword(target, highlightQuery, mode);
      }

      let scrollTarget;
      let flashBlock;

      if (hlRes && hlRes.matched) {
        flashBlock = hlRes.hitBlock;
      } else {
        flashBlock = target.closest('p, h1, h2, h3, h4, h5, h6, li, blockquote, tr, pre, table, .obsidian-callout') || target.nextElementSibling || target.parentElement;
      }
      // 一律以「要求的那一行」anchor 為定位目標，關鍵字 mark 只用於閃示。寬鬆模式
      // 的高亮視窗會向前納入兄弟區塊（見 highlightLineKeyword），firstMark 因此可能
      // 位在要求行之前；若以它定位，游標會停在該 mark 而非使用者點選的行。
      scrollTarget = target;

      if (flashBlock) {
        flashBlock.classList.add('line-highlight');
        setTimeout(() => flashBlock.classList.remove('line-highlight'), 2500);
      }

      safeScrollToElement(scrollTarget, $('content'), 'start');

      // 佈局未定時量測與重流修正（Requirement [D]）
      requestAnimationFrame(() => {
        const c = $('content');
        if (!c || !scrollTarget || !scrollTarget.isConnected) return;
        const tr = scrollTarget.getBoundingClientRect();
        const cr = c.getBoundingClientRect();
        const expectedTop = cr.top + 12;
        if (Math.abs(tr.top - expectedTop) > 16) {
          safeScrollToElement(scrollTarget, c, 'start');
        }
      });
    }
  }

  /**
   * Apply deployment-mode differences to the UI.
   *
   * Single-user bundles hide everything that only makes sense for a public,
   * multi-user, crawlable site — the administrator login, the SEO and analytics
   * tabs — and reveal the local maintenance controls that would otherwise sit
   * behind an admin login that does not exist.
   *
   * DOM visibility is driven by `data-single-user-only` / `data-web-only`
   * attributes (styled in style.css) rather than ad-hoc inline styles, so the
   * markup states its own intent and CSS keeps the two modes consistent.
   */
  function applyDeployModeUI() {
    const single = state.isSingleUser === true;
    document.documentElement.setAttribute('data-deploy-target', single ? 'single-user' : 'web');

    const adminLoginBtn = $('menuOpenAdminLoginBtn');
    if (adminLoginBtn) adminLoginBtn.style.display = single ? 'none' : '';
    updateUserMenu();

    // The status line explains how this install is authorised.
    const statusText = $('adminStatusText');
    if (statusText) {
      if (single) {
        statusText.textContent = '單機模式：本機免登入，可直接使用系統維護功能';
      } else if (!statusText.textContent || statusText.textContent.indexOf('檢查中') !== -1) {
        statusText.textContent = '登入狀態：尚未登入';
      }
    }

    // Tabs that exist only for a public deployment.
    const webOnlyTabs = ['adminTabSeoBtn', 'adminTabAnalyticsBtn', 'adminTabUsersBtn', 'adminTabAccountSystemBtn'];
    for (const id of webOnlyTabs) {
      const btn = $(id);
      if (btn) btn.style.display = single ? 'none' : '';
    }

    // If the SEO/analytics pane happens to be the active one, fall back to the
    // configuration tab so the panel is never left showing an empty section.
    if (single) {
      const activePane = document.querySelector('.admin-tab-pane.active');
      if (activePane && ['adminPaneSeo', 'adminPaneAnalytics', 'adminPaneUsers', 'adminPaneAccountSystem'].includes(activePane.id)) {
        const configBtn = $('adminTabConfigBtn');
        if (configBtn) configBtn.click();
      }
    }
  }

  // ── Admin Status Checker ──
  async function checkAdminStatus() {
    try {
      const headers = {};
      const res = await fetch('/api/admin/status', { headers });
      if (!res.ok) throw new Error('Status check failed');
      const data = await res.json();
      
      // If admin is not set, force show setup overlay
      // Deployment mode decides whether an administrator account exists at all.
      // Single-user bundles (desktop/mobile) never create one, so the first-run
      // setup modal must never appear: it would demand a public canonical URL
      // that a local installation does not have, blocking the reader entirely.
      state.isSingleUser = data.isSingleUser === true || data.authMode === 'single-user';
      state.authMode = data.authMode || (state.isSingleUser ? 'single-user' : 'admin');
      applyDeployModeUI();

      if (!state.isSingleUser) {
        if (!data.isSetup) {
          $('adminSetupOverlay').style.display = 'flex';
          const setupSiteUrlEl = $('setupSiteUrl');
          if (setupSiteUrlEl && !setupSiteUrlEl.value) {
            setupSiteUrlEl.value = (data.settings && data.settings.siteUrl) ? data.settings.siteUrl : (window.location.origin || '');
          }
        } else {
          $('adminSetupOverlay').style.display = 'none';
        }
      } else {
        // Defensive: a stale stylesheet or an older cached page could still
        // leave the overlay visible, which would lock the user out of the app.
        const setupOverlay = $('adminSetupOverlay');
        if (setupOverlay) setupOverlay.style.display = 'none';
      }

      // If token is invalid according to server, clear it. In single-user mode
      // the server authorises loopback callers directly, so there is no token to
      // hold and nothing to clear.
      state.isAdmin = !state.isSingleUser && !!data.isAuthenticated;
      updateUserMenu();
      // 舊版把管理員 token 存在 localStorage；改用 cookie 後一律清掉。
      storage.remove(STORAGE_KEYS.ADMIN_TOKEN);

      // Clean legacy contaminated keys from older versions
      storage.remove('mdWebview-fontsize');
      storage.remove('mdWebview-theme');

      // If client doesn't have custom user font size / theme settings saved in localStorage,
      // load default settings configured by the server.
      if (data.settings) {
        if (data.settings.defaultFontSize) {
          state.defaultFontSize = parseInt(data.settings.defaultFontSize);
        }
        const userSavedFont = storage.get(STORAGE_KEYS.FONT_SIZE);
        if (userSavedFont) {
          applyFontSize(parseInt(userSavedFont), true);
        } else if (data.settings.defaultFontSize) {
          applyFontSize(data.settings.defaultFontSize, false);
        }

        const userSavedTheme = storage.get(STORAGE_KEYS.THEME);
        if (userSavedTheme) {
          applyTheme(userSavedTheme, true);
        } else if (data.settings.defaultTheme) {
          applyTheme(data.settings.defaultTheme, false);
        }

        if (data.settings.siteName) {
          state.siteName = data.settings.siteName;
          updateSiteNameUI();
        }

        if (data.settings.enableAnnouncement !== undefined) {
          appConfig.enableAnnouncement = data.settings.enableAnnouncement;
          if (!appConfig.announcement) appConfig.announcement = {};
          appConfig.announcement.enabled = !!data.settings.enableAnnouncement;
        }
        if (data.settings.announcementMessage !== undefined) {
          appConfig.announcementMessage = data.settings.announcementMessage;
          if (!appConfig.announcement) appConfig.announcement = {};
          appConfig.announcement.message = data.settings.announcementMessage;
        }
        if (data.settings.announcementUpdatedAt !== undefined) {
          appConfig.announcementUpdatedAt = data.settings.announcementUpdatedAt;
          if (!appConfig.announcement) appConfig.announcement = {};
          appConfig.announcement.updatedAt = data.settings.announcementUpdatedAt;
        }

        updateWelcomeFooter(data.settings);
      }
    } catch (err) {
      console.error('Error checking admin status:', err);
      showToast('❌ 後台狀態載入失敗', 'error');
    }
  }

  // ═══════════════════════════════════════════════════════════
  // §2 SITE NAME & FOOTER (updateSiteNameUI, updateWelcomeFooter)
  // ═══════════════════════════════════════════════════════════
  function updateSiteNameUI() {
    $$('.logo-text').forEach(el => el.textContent = state.siteName);
    $$('.welcome-title').forEach(el => el.textContent = state.siteName);

    const modalTitle = $('announcementModalTitle');
    if (modalTitle) modalTitle.textContent = `${state.siteName}線上閱讀`;

    if (!state.currentFile) {
      document.title = `${state.siteName} — 佛典經論閱讀器`;
    }
  }

  function updateWelcomeFooter(settings) {
    const footerEl = $('welcomeFooter');
    if (!footerEl) return;
    if (!settings) settings = window.__APP_CONFIG__ || {};

    const isVersionEnabled = settings.enableVersion === true || settings.enableVersion === 'true';
    const isDownloadEnabled = settings.enableDownload === true || settings.enableDownload === 'true';
    // Only display '本日訊息' if admin explicitly opened "開啟訊息彈窗" (enableAnnouncement === true)
    let isAnnouncementEnabled = false;
    if (settings.enableAnnouncement !== undefined) {
      isAnnouncementEnabled = settings.enableAnnouncement === true || settings.enableAnnouncement === 'true';
    } else if (settings.announcement && settings.announcement.enabled !== undefined) {
      isAnnouncementEnabled = settings.announcement.enabled === true || settings.announcement.enabled === 'true';
    } else if (typeof appConfig !== 'undefined' && appConfig) {
      if (appConfig.enableAnnouncement !== undefined) {
        isAnnouncementEnabled = appConfig.enableAnnouncement === true || appConfig.enableAnnouncement === 'true';
      } else if (appConfig.announcement && appConfig.announcement.enabled !== undefined) {
        isAnnouncementEnabled = appConfig.announcement.enabled === true || appConfig.announcement.enabled === 'true';
      }
    }

    const parts = [];
    if (isVersionEnabled && settings.version && String(settings.version).trim()) {
      parts.push(`<span>版本：${escHtml(String(settings.version).trim())}</span>`);
    }
    if (isDownloadEnabled && settings.downloadUrl && String(settings.downloadUrl).trim()) {
      parts.push(`<span>下載：<a href="${escHtml(String(settings.downloadUrl).trim())}" target="_blank" rel="noopener noreferrer" class="welcome-download-link">離線閱讀完整版</a></span>`);
    }
    if (isAnnouncementEnabled) {
      parts.push(`<span><a href="javascript:void(0)" class="welcome-download-link welcome-announcement-link" id="welcomeAnnouncementLink" role="button">本日訊息</a></span>`);
    }

    if (parts.length > 0) {
      footerEl.innerHTML = parts.join('<span class="welcome-footer-sep">·</span>');
      footerEl.style.display = 'flex';

      const announceLink = $('welcomeAnnouncementLink');
      if (announceLink) {
        announceLink.addEventListener('click', (e) => {
          e.preventDefault();
          showAnnouncementModal();
        });
      }
    } else {
      footerEl.innerHTML = '';
      footerEl.style.display = 'none';
    }
  }
  // ── Go Home: close reader, return to welcome screen ────────
  function goHome(clearUrl = true) {
    // Invalidate every pending open, including operations that cannot be aborted
    // (for example response-body decoding), before changing the visible screen.
    state._openToken++;
    if (state._openFileAbort) {
      state._openFileAbort.abort();
      state._openFileAbort = null;
    }
    state.currentFile = null;

    // Release any virtualized document and full-render scroll-spy observer so
    // returning home doesn't pin a large file's index, TOC rows, or headings.
    teardownVirtual();
    disconnectScrollSpy();
    headingTextMap.clear();
    cachedLineAnchors = [];
    resetTocFilterUI();
    const tocList = $('tocList');
    if (tocList) {
      tocList.innerHTML = '<div class="panel-placeholder"><span class="panel-placeholder-icon">📑</span><span>開啟檔案後顯示大綱</span></div>';
    }
    updateEntryNav();

    const welcome = $('welcomeScreen');
    const wrapper = $('contentWrapper');
    const loading = $('contentLoading');

    if (welcome) welcome.style.display = 'flex';
    if (wrapper) wrapper.style.display = 'none';
    if (loading) loading.style.display = 'none';

    // 回到首頁是唯一適合談安裝的時機（閱讀中打擾最不可取）。每次回首頁
    // 重新評估：使用者可能剛讀完第二篇，正好跨過門檻。
    maybeShowInstallCard();

    if (clearUrl) {
      // Clear URL query parameters
      const cleanUrl = window.location.pathname;
      history.pushState(null, '', cleanUrl);
    }

    // Reset document title
    document.title = `${state.siteName} — 佛典經論閱讀器`;

    // Clear active file indicator & tree highlight
    updateActiveFileUI(null);
    $$('.tree-item-row.active').forEach(el => el.classList.remove('active'));

    // Close page search if open
    closePageSearch();
  }

  // ── Platform Detection & Welcome Shortcuts ──────────────────
  function detectPlatform() {
    const ua = navigator.userAgent || '';
    const platform = navigator.platform || '';

    const isiPhone = /iPhone|iPod/i.test(ua);
    const isiPad = /iPad/i.test(ua) || (platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isIOS = isiPhone || isiPad;
    const isMac = !isIOS && (/Mac/i.test(platform) || /Macintosh/i.test(ua));
    const isAndroidMobile = /Android|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua);

    if (isiPhone) return 'iphone';
    if (isIOS) return 'ios';
    if (isMac) return 'mac';
    if (isAndroidMobile) return 'mobile';
    return 'pc';
  }

  function updateWelcomeShortcuts() {
    const container = $('welcomeShortcuts');
    if (!container) return;

    const plat = detectPlatform();

    if (plat === 'mac') {
      container.innerHTML = `
        <div class="shortcut-item"><kbd>⌘ Cmd</kbd>+<kbd>F</kbd> 本頁搜尋</div>
        <div class="shortcut-item"><kbd>⌘ Cmd</kbd>+<kbd>+</kbd> / <kbd>−</kbd> 調整字型</div>
      `;
    } else if (plat === 'iphone' || plat === 'mobile') {
      container.innerHTML = `
        <div class="shortcut-item">🔍 點擊右上角按鈕搜尋本頁</div>
        <div class="shortcut-item">🅰️ 點擊右上角按鈕調整字型</div>
      `;
    } else if (plat === 'ios') {
      container.innerHTML = `
        <div class="shortcut-item">🔍 點擊右上角按鈕或 <kbd>⌘ Cmd</kbd>+<kbd>F</kbd> 搜尋本頁</div>
        <div class="shortcut-item">🅰️ 點擊右上角按鈕或 <kbd>⌘ Cmd</kbd>+<kbd>+</kbd> / <kbd>−</kbd> 調整字型</div>
      `;
    } else {
      container.innerHTML = `
        <div class="shortcut-item"><kbd>Ctrl</kbd>+<kbd>F</kbd> 本頁搜尋</div>
        <div class="shortcut-item"><kbd>Ctrl</kbd>+<kbd>+</kbd> / <kbd>−</kbd> 調整字型</div>
      `;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // §3 SUGGEST LIST (Homepage Recommend & Hot)
  // ═══════════════════════════════════════════════════════════

  /**
   * 從 /api/suggest-list 取得首頁推薦列表與公告資訊，並更新前端狀態。
   *
   * @param {boolean} [triggerModal=false] - 是否在取得資料後觸發公告彈窗檢查。
   *   只有開機 boot 階段（init() 呼叫時）傳 `true`；
   *   其他呼叫點（切換分頁、開啟使用者設定、後台儲存）一律傳 `false`，
   *   避免非首次開啟場景重複觸發彈窗。
   */
  async function fetchSuggestList(triggerModal = false) {
    try {
      const res = await fetch('/api/suggest-list');
      if (!res.ok) {
        if (triggerModal) checkAndShowAnnouncementModal(state._cachedSuggestItems || [], appConfig.announcement, appConfig.suggestListUpdatedAt);
        return;
      }
      const data = await res.json();
      const items = data.items || [];
      state._cachedSuggestItems = items;
      renderSuggestList(items, data.enabled !== false);
      if (data.suggestListUpdatedAt) {
        appConfig.suggestListUpdatedAt = data.suggestListUpdatedAt;
      }
      if (data.announcement) {
        appConfig.announcement = data.announcement;
        appConfig.enableAnnouncement = !!data.announcement.enabled;
        updateWelcomeFooter(appConfig);
      }
      if (triggerModal) {
        checkAndShowAnnouncementModal(items, data.announcement, data.suggestListUpdatedAt);
      }
    } catch (_) {
      if (triggerModal) {
        checkAndShowAnnouncementModal(state._cachedSuggestItems || [], appConfig.announcement, appConfig.suggestListUpdatedAt);
      }
    }
  }

  function resolveSuggestPath(rawPath) {
    if (!rawPath) return '';
    if (rawPath.startsWith('dict:')) return rawPath;
    // Normalize slashes and trim spaces around path segments
    const cleanPath = rawPath
      .replace(/\\/g, '/')
      .split('/')
      .map(s => s.trim())
      .filter(Boolean)
      .join('/');

    if (!cleanPath) return '';

    const cleanNoExt = cleanPath.replace(/\.md$/i, '').trim();
    const baseName = cleanNoExt.split('/').pop().trim();

    // Try lookup in wikilinkIndex
    const resolved =
      wikilinkIndex.get(cleanPath) ||
      wikilinkIndex.get(cleanPath.toLowerCase()) ||
      wikilinkIndex.get(cleanNoExt) ||
      wikilinkIndex.get(cleanNoExt.toLowerCase()) ||
      wikilinkIndex.get(baseName) ||
      wikilinkIndex.get(baseName.toLowerCase());

    if (resolved) return resolved;

    // Fallback: append .md if missing
    return cleanPath.endsWith('.md') ? cleanPath : cleanPath + '.md';
  }

  function renderSuggestList(items, showOnHomepage = true) {
    state._cachedSuggestItems = items || [];
    renderSuggestListToElement($('suggestList'), items, false);
    renderSuggestListToElement($('menuSuggestList'), items, true);

    const container = $('suggestListContainer');
    if (container) {
      container.style.display = (showOnHomepage && items && items.length > 0) ? 'block' : 'none';
    }
  }

  function renderSuggestListToElement(list, items, closeOverlayOnClick = false) {
    if (!list) return;
    if (!items || items.length === 0) {
      list.innerHTML = '<div class="list-empty-hint">尚無推薦或熱門經論</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    for (const item of items) {
      const li = document.createElement('li');
      li.className = 'suggest-item';
      const targetPath = resolveSuggestPath(item.path);
      li.title = targetPath || item.path || '';

      const isDict = item.type === 'dict';
      const isHot = item.type === 'hot';

      const icon = document.createElement('span');
      icon.className = 'suggest-item-icon';
      icon.textContent = isDict ? '📖' : (isHot ? '✨' : '🪷');

      const name = document.createElement('span');
      name.className = 'suggest-item-name';
      if (isDict) {
        name.innerHTML = `<span class="suggest-dict-word">${escHtml(item.fileName)}</span>` +
          (item.dictName ? ` <span class="suggest-dict-source">(${escHtml(item.dictName)})</span>` : '');
      } else {
        name.textContent = item.fileName || item.path;
      }

      const badge = document.createElement('span');
      badge.className = 'suggest-item-badge ' + (isDict ? 'suggest-badge-dict' : (isHot ? 'suggest-badge-hot' : 'suggest-badge-admin'));
      badge.textContent = isDict ? '單詞' : (isHot ? '熱門' : '推薦');

      li.appendChild(icon);
      li.appendChild(name);
      li.appendChild(badge);

      li.addEventListener('click', () => {
        const pathToOpen = resolveSuggestPath(item.path);
        if (pathToOpen) {
          openFile(pathToOpen, item.line || null);
          if (closeOverlayOnClick) {
            const overlay = $('userSettingsOverlay');
            if (overlay) overlay.style.display = 'none';
          }
        }
      });
      frag.appendChild(li);
    }
    list.innerHTML = '';
    list.appendChild(frag);
  }

  // ═══════════════════════════════════════════════════════════
  // §4 ANNOUNCEMENT & DAILY RECOMMEND MODAL (Opening Page Landing Popup)
  // ═══════════════════════════════════════════════════════════

  const ANNOUNCEMENT_ACK_KEY = STORAGE_KEYS.ANNOUNCEMENT_ACK;

  function getTodayDateString() {
    return getTodayDateIso();
  }

  function computeItemsSignature(items) {
    if (!items || !items.length) return '';
    return items
      .map(i => `${i.type || ''}:${i.path || ''}:${i.fileName || ''}:${i.line || ''}`)
      .sort()
      .join('|');
  }

  /**
   * 根據三個觸發條件決定是否顯示公告彈窗。已閱讀後不會因換日而重複彈出。
   *
   * 觸發條件（任一成立即顯示）：
   *   1. 公告更新：訊息文字變更，或 announcementUpdatedAt 時間戳推進
   *   2. 推薦項目更新：推薦清單內容簽章（type+path+fileName+line）與已儲存簽章不符
   *   3. 後台推薦設定更新：suggestListUpdatedAt 時間戳大於已儲存的值
   *
   * 注意：舊版依「換日（todayDateKey !== ack.dateKey）」觸發的邏輯已在 v3.4.8 移除。
   *
   * @param {Object[]} items           - /api/suggest-list 回傳的推薦項目陣列
   * @param {Object}   announcementData - 公告物件 { enabled, message, updatedAt }
   * @param {number}   suggestUpdatedAt - 後台推薦設定最後儲存時間戳（毫秒 epoch）
   */
  function checkAndShowAnnouncementModal(items, announcementData, suggestUpdatedAt) {
    const ann = announcementData || (appConfig && appConfig.announcement) || {};
    const isEnabled = ann.enabled !== undefined
      ? !!ann.enabled
      : (appConfig && appConfig.enableAnnouncement !== undefined ? !!appConfig.enableAnnouncement : false);

    if (!isEnabled) {
      return;
    }

    const rawMsg = ann.message !== undefined
      ? ann.message
      : (appConfig && appConfig.announcementMessage ? appConfig.announcementMessage : '');
    const currentMsg = String(rawMsg || '').trim();
    const currentUpdatedAt = Number(ann.updatedAt || (appConfig && appConfig.announcementUpdatedAt) || 0);
    const currentSuggestUpdatedAt = Number(suggestUpdatedAt || (appConfig && appConfig.suggestListUpdatedAt) || 0);

    const currentItemsSig = computeItemsSignature(items);

    const ack = storage.getJson(STORAGE_KEYS.ANNOUNCEMENT_ACK);

    let shouldShow = false;
    if (!ack) {
      // First visit with modal enabled
      shouldShow = true;
    } else {
      // Condition 1: 公告訊息是否有更新（文字變更 或 更新時間戳推進）
      const announcementUpdated = (currentMsg !== (ack.announcement || '')) ||
        (currentUpdatedAt > 0 && Number(ack.announcementUpdatedAt || 0) < currentUpdatedAt);

      // Condition 2: 推薦項目是否有更新（推薦清單內容實質變更 或 後台更新推薦設定）
      // 注意：完全移除換日判斷 (todayDateKey !== ack.dateKey)，使用者閱讀過之後絕不因換日而重複彈出！
      const suggestItemsChanged = Boolean(
        currentItemsSig &&
        ack.itemsSig &&
        currentItemsSig !== ack.itemsSig
      );
      const suggestSettingsUpdated = (currentSuggestUpdatedAt > 0 && Number(ack.suggestUpdatedAt || 0) < currentSuggestUpdatedAt);

      if (announcementUpdated || suggestItemsChanged || suggestSettingsUpdated) {
        shouldShow = true;
      }
    }

    if (shouldShow) {
      openAnnouncementModal(items, currentMsg, currentUpdatedAt, currentSuggestUpdatedAt, currentItemsSig);
    }
  }

  async function showAnnouncementModal() {
    try {
      const res = await fetch('/api/suggest-list');
      if (res.ok) {
        const data = await res.json();
        if (data.items) state._cachedSuggestItems = data.items;
        if (data.suggestListUpdatedAt) {
          appConfig.suggestListUpdatedAt = data.suggestListUpdatedAt;
        }
        if (data.announcement) {
          appConfig.announcement = data.announcement;
          appConfig.enableAnnouncement = !!data.announcement.enabled;
          appConfig.announcementMessage = data.announcement.message || '';
          appConfig.announcementUpdatedAt = data.announcement.updatedAt || 0;
          updateWelcomeFooter(appConfig);
        }
      }
    } catch (_) {}

    const ann = (appConfig && appConfig.announcement) || {};
    const rawMsg = (ann.message !== undefined)
      ? ann.message
      : (appConfig && appConfig.announcementMessage !== undefined ? appConfig.announcementMessage : '');
    const currentMsg = String(rawMsg || '').trim();
    const currentUpdatedAt = Number(ann.updatedAt || (appConfig && appConfig.announcementUpdatedAt) || 0);
    const currentSuggestUpdatedAt = Number(appConfig && appConfig.suggestListUpdatedAt || 0);

    const items = state._cachedSuggestItems || [];
    const currentItemsSig = computeItemsSignature(items);

    openAnnouncementModal(items, currentMsg, currentUpdatedAt, currentSuggestUpdatedAt, currentItemsSig);
  }

  /**
   * 開啟公告彈窗並填入推薦列表與公告訊息。
   * 將本次開啟的資料快照存入 state._announcementModalContext，
   * 供 closeAnnouncementModal 關閉時寫入 localStorage（作為下次的比對基準）。
   *
   * @param {Object[]} items           - 推薦項目陣列（渲染至彈窗內的推薦列表）
   * @param {string}   message         - 公告訊息文字（空字串則隱藏訊息區塊）
   * @param {number}   updatedAt       - 公告最後更新時間戳（毫秒 epoch）
   * @param {number}   suggestUpdatedAt - 後台推薦設定最後儲存時間戳（毫秒 epoch）
   * @param {string}   itemsSig         - 推薦項目內容簽章（pipe 分隔的 type:path:fileName:line）
   */
  function openAnnouncementModal(items, message, updatedAt, suggestUpdatedAt, itemsSig) {
    const overlay = $('announcementModalOverlay');
    if (!overlay) return;

    const modalTitle = $('announcementModalTitle');
    if (modalTitle) {
      modalTitle.textContent = `${state.siteName || 'mdWebview'}線上閱讀`;
    }

    state._announcementModalContext = {
      announcement: message,
      announcementUpdatedAt: updatedAt,
      suggestUpdatedAt: suggestUpdatedAt,
      itemsSig: itemsSig
    };

    const dateEl = $('announcementModalDate');
    if (dateEl) {
      try {
        dateEl.textContent = new Date().toLocaleDateString(activeLocale(), {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          weekday: 'short'
        });
      } catch (_) {
        dateEl.textContent = getTodayDateString();
      }
    }

    const noticeBox = $('announcementNoticeBox');
    const noticeContent = $('announcementNoticeContent');
    if (message && message.trim()) {
      if (noticeContent) noticeContent.textContent = message.trim();
      if (noticeBox) noticeBox.style.display = 'flex';
    } else {
      if (noticeBox) noticeBox.style.display = 'none';
      if (noticeContent) noticeContent.textContent = '';
    }

    const listEl = $('announcementSuggestList');
    if (listEl) {
      renderAnnouncementSuggestList(listEl, items);
    }

    const modalBody = overlay.querySelector('.announcement-modal-body');
    if (modalBody) {
      modalBody.scrollTop = 0;
    }

    document.body.classList.add('modal-open');
    overlay.style.setProperty('display', 'flex', 'important');
    overlay.style.display = 'flex';
    overlay.setAttribute('aria-hidden', 'false');
  }

  /**
   * 關閉公告彈窗。
   * 若 markAsAcknowledged 為 true，將 state._announcementModalContext 寫入
   * localStorage（ANNOUNCEMENT_ACK_KEY），記錄使用者已閱讀的狀態，
   * 下次開啟時以此為基準判斷是否需要重新顯示。
   *
   * 使用 setProperty('display','none','important') 確保覆蓋 CSS !important 規則。
   *
   * @param {boolean} [markAsAcknowledged=true] - 是否寫入已讀記錄至 localStorage
   */
  function closeAnnouncementModal(markAsAcknowledged = true) {
    const overlay = $('announcementModalOverlay');
    if (!overlay) return;

    if (markAsAcknowledged && state._announcementModalContext) {
      storage.setJson(STORAGE_KEYS.ANNOUNCEMENT_ACK, state._announcementModalContext);
    }

    document.body.classList.remove('modal-open');
    overlay.style.setProperty('display', 'none', 'important');
    overlay.style.display = 'none';
    overlay.setAttribute('aria-hidden', 'true');
  }

  function renderAnnouncementSuggestList(list, items) {
    if (!list) return;
    if (!items || items.length === 0) {
      list.innerHTML = '<li class="suggest-item" style="cursor:default;"><span class="suggest-item-name">尚無每日推薦經論</span></li>';
      return;
    }

    const frag = document.createDocumentFragment();
    for (const item of items) {
      const li = document.createElement('li');
      li.className = 'suggest-item';
      const targetPath = resolveSuggestPath(item.path);
      li.title = targetPath || item.path || '';

      const isDict = item.type === 'dict';
      const isHot = item.type === 'hot';

      const icon = document.createElement('span');
      icon.className = 'suggest-item-icon';
      icon.textContent = isDict ? '📖' : (isHot ? '✨' : '🪷');

      const name = document.createElement('span');
      name.className = 'suggest-item-name';
      if (isDict) {
        name.innerHTML = `<span class="suggest-dict-word">${escHtml(item.fileName)}</span>` +
          (item.dictName ? ` <span class="suggest-dict-source">(${escHtml(item.dictName)})</span>` : '');
      } else {
        name.textContent = item.fileName || item.path;
      }

      const badge = document.createElement('span');
      badge.className = 'suggest-item-badge ' + (isDict ? 'suggest-badge-dict' : (isHot ? 'suggest-badge-hot' : 'suggest-badge-admin'));
      badge.textContent = isDict ? '單詞' : (isHot ? '熱門' : '推薦');

      const arrow = document.createElement('span');
      arrow.className = 'suggest-item-arrow';
      arrow.textContent = '→';

      li.appendChild(icon);
      li.appendChild(name);
      li.appendChild(badge);
      li.appendChild(arrow);

      li.addEventListener('click', () => {
        const pathToOpen = resolveSuggestPath(item.path);
        if (pathToOpen) {
          closeAnnouncementModal(true);
          openFile(pathToOpen, item.line || null);
        }
      });

      frag.appendChild(li);
    }

    list.innerHTML = '';
    list.appendChild(frag);
  }

  // ═══════════════════════════════════════════════════════════
  // §5 TREE VIEW (File Browser)
  // ═══════════════════════════════════════════════════════════

  async function loadTree() {
    const container = $('fileTree');
    try {
      const res = await fetch('/api/tree');
      if (!res.ok) throw new Error('Failed to load tree');
      state.treeData = await res.json();
      buildWikilinkIndex(state.treeData);
      buildFileSizeMap(state.treeData);
      populateSearchFolderSelect(state.treeData);
      renderFileTree();
    } catch (err) {
      container.innerHTML = `<div class="panel-placeholder"><span class="placeholder-icon">⚠️</span><span>載入失敗: ${escHtml(err.message)}</span></div>`;
      showToast('檔案目錄載入失敗，請重新整理', 'error');
    }
  }

  // Walk the tree once and record every file's byte size, so openFile can decide
  // whether to take the virtualized path without an extra network round-trip.
  function buildFileSizeMap(nodes) {
    state.fileSizes.clear();
    (function walk(list) {
      if (!Array.isArray(list)) return;
      for (const n of list) {
        if (n.type === 'file' && typeof n.size === 'number') {
          state.fileSizes.set(n.path, n.size);
        }
        if (n.children) walk(n.children);
      }
    })(nodes);
  }

  function populateSearchFolderSelect(nodes) {
    const select = $('searchFolderSelect');
    if (!select) return;

    const currentVal = select.value;
    const folders = [];

    function extractFolders(list) {
      if (!Array.isArray(list)) return;
      for (const node of list) {
        if (node.type === 'directory') {
          folders.push({
            path: node.path,
            name: node.name
          });
          if (node.children) {
            extractFolders(node.children);
          }
        }
      }
    }

    extractFolders(nodes);
    folders.sort((a, b) => a.path.localeCompare(b.path, 'zh-TW'));

    let html = '<option value="">📁 所有資料夾 (全庫搜尋)</option>';
    html += '<option value="__FILENAME_ONLY__">🏷️ 全庫檔名搜尋 (僅比對檔名)</option>';
    html += '<option value="__CURRENT_FILE__">📄 本頁搜尋 (僅限目前開啟檔案)</option>';
    folders.forEach(f => {
      const depth = (f.path.match(/\//g) || []).length;
      const indent = depth > 0 ? '&nbsp;&nbsp;'.repeat(depth) + '└ ' : '';
      html += `<option value="${escHtml(f.path)}">${indent}📁 ${escHtml(f.name)} (${escHtml(f.path)})</option>`;
    });
    select.innerHTML = html;
    if (currentVal) {
      select.value = currentVal;
    }
  }

  /**
   * 側欄即時篩選（檔案瀏覽器與本頁大綱共用）的正規化工具：
   * 轉小寫，並在開啟簡繁字組比對或簡體顯示時將字元折疊為字組代表字。
   */
  function foldSidebarFilterText(str) {
    if (!str) return '';
    const lower = String(str).toLowerCase();
    const sv = s2tQueryEnabled() ? window.mdSearchVariants : null;
    return sv ? sv.fold(lower) : lower;
  }

  function parseSidebarFilterTerms(query) {
    const q = (query || '').trim();
    if (!q) return [];
    return q.split(/\s+/).filter(Boolean).map(foldSidebarFilterText);
  }

  function matchesSidebarFilter(text, foldedTerms) {
    if (!foldedTerms || foldedTerms.length === 0) return true;
    const target = foldSidebarFilterText(text);
    for (let i = 0; i < foldedTerms.length; i++) {
      if (!target.includes(foldedTerms[i])) return false;
    }
    return true;
  }

  /**
   * 依關鍵字遞迴篩選檔案樹：
   * - 若資料夾或上層路徑已命中，保留其下子項目（或有更精確命中時只留命中項）
   * - 若檔案本身（檔名或完整相對路徑）命中全部詞組則保留
   * - 只要子樹中有任何命中檔案，即保留該上層資料夾
   */
  function filterTreeNodes(nodes, foldedTerms) {
    if (!Array.isArray(nodes)) return [];
    if (!foldedTerms || foldedTerms.length === 0) return nodes;
    const out = [];
    for (const node of nodes) {
      if (node.type === 'directory') {
        const selfMatch = matchesSidebarFilter(`${node.path || ''} ${node.name || ''}`, foldedTerms);
        const filteredChildren = filterTreeNodes(node.children || [], foldedTerms);
        if (filteredChildren.length > 0) {
          out.push({ ...node, children: filteredChildren });
        } else if (selfMatch && Array.isArray(node.children) && node.children.length > 0) {
          out.push({ ...node });
        }
      } else {
        if (matchesSidebarFilter(`${node.path || ''} ${node.name || ''}`, foldedTerms)) {
          out.push(node);
        }
      }
    }
    return out;
  }

  function renderTreeNodes(nodes, container, level, expandAll = false) {
    if (!Array.isArray(nodes) || !container) return;
    const frag = document.createDocumentFragment();
    nodes.forEach((node) => {
      const item = document.createElement('div');
      item.className = 'tree-item';

      if (node.type === 'directory') {
        const expClass = expandAll ? ' expanded' : '';
        const iconChar = expandAll ? '📂' : '📁';
        item.innerHTML = `
          <div class="tree-item-row tree-folder" style="padding-left:${8 + level * 16}px" data-path="${escHtml(node.path)}">
            <span class="tree-chevron${expClass}">›</span>
            <span class="tree-icon">${iconChar}</span>
            <span class="tree-name">${escHtml(node.name)}</span>
            <span class="tree-file-count">${countFiles(node)}</span>
          </div>
          <div class="tree-children${expClass}"></div>
        `;
        const childrenEl = item.querySelector('.tree-children');
        if (Array.isArray(node.children)) {
          renderTreeNodes(node.children, childrenEl, level + 1, expandAll);
        }

        const row = item.querySelector('.tree-item-row');
        row.addEventListener('click', () => {
          const chevron = row.querySelector('.tree-chevron');
          chevron.classList.toggle('expanded');
          childrenEl.classList.toggle('expanded');
          row.querySelector('.tree-icon').textContent = childrenEl.classList.contains('expanded') ? '📂' : '📁';
        });
      } else {
        item.innerHTML = `
          <div class="tree-item-row tree-file" style="padding-left:${8 + level * 16 + 16}px" data-path="${escHtml(node.path)}">
            <span class="tree-icon">📄</span>
            <span class="tree-name">${escHtml(node.name)}</span>
          </div>
        `;
        const row = item.querySelector('.tree-item-row');
        row.addEventListener('click', () => openFile(node.path));
      }

      frag.appendChild(item);
    });
    container.appendChild(frag);
  }

  function renderFileTree() {
    const container = $('fileTree');
    if (!container || !Array.isArray(state.treeData)) return;
    const sorted = sortTreeNodes(state.treeData, state.fileSort);
    const terms = parseSidebarFilterTerms(state.fileTreeFilter);
    const isFiltering = terms.length > 0;
    const visibleNodes = isFiltering ? filterTreeNodes(sorted, terms) : sorted;
    state._lastFileTreeFilterMatches = isFiltering
      ? visibleNodes.reduce((sum, n) => sum + countFiles(n), 0)
      : 0;

    container.innerHTML = '';
    if (visibleNodes.length === 0) {
      if (isFiltering) {
        container.innerHTML = `<div class="panel-placeholder"><span class="placeholder-icon">📂</span><span>沒有符合「${escHtml(state.fileTreeFilter.trim())}」的檔案</span></div>`;
      } else {
        container.innerHTML = `<div class="panel-placeholder"><span class="placeholder-icon">📂</span><span>目錄內尚無經文檔案</span></div>`;
      }
      updateCollapseBtnUI($('fileCollapseAllBtn'), false);
      return;
    }

    renderTreeNodes(visibleNodes, container, 0, isFiltering);
    updateCollapseBtnUI($('fileCollapseAllBtn'), isFiltering);

    if (state.currentFile && !String(state.currentFile).startsWith('dict:')) {
      const target = container.querySelector(`.tree-file[data-path="${CSS.escape(state.currentFile)}"]`);
      if (target) {
        target.classList.add('active');
        if (!isFiltering) expandTreeAncestors(target);
      }
    }
  }

  // ── 檔案瀏覽器篩選日誌與數據分析（含注音/拼音組字感知與靜止去抖）──────
  // 中文輸入法（注音、拼音）在選字完成前會連續觸發 input 事件，且使用者打一個詞
  // 可能分兩三次選字。因此：
  //   1. compositionstart 期間一律不排程日誌，待 compositionend 才開始計時；
  //   2. 純注音符號（ㄅ–ㄩ 與聲調符號）不送出日誌；
  //   3. 輸入框完全無動作滿 FILE_TREE_FILTER_LOG_DEBOUNCE_MS (1200ms) 後才送出，
  //      且與上一筆已記錄字串相同時不重複送出。
  const FILE_TREE_FILTER_LOG_DEBOUNCE_MS = 1200;
  const BOPOMOFO_ONLY_RE = /^[\u3105-\u312F\u02CA\u02C7\u02CB\u02D9\s]+$/;
  let _fileFilterLogTimer = null;
  let _isFileFilterComposing = false;
  let _lastLoggedFileTreeFilter = '';

  function sendFileTreeFilterEvent(query, matches) {
    const q = String(query || '').trim();
    if (!q) return;
    try {
      fetch('/api/tree-filter-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q, matches: Number(matches) || 0 }),
        keepalive: true
      }).catch(() => {});
    } catch (_) {}
  }

  function cancelFileTreeFilterLog() {
    if (_fileFilterLogTimer) {
      clearTimeout(_fileFilterLogTimer);
      _fileFilterLogTimer = null;
    }
  }

  function scheduleFileTreeFilterLog(rawQuery) {
    cancelFileTreeFilterLog();
    if (_isFileFilterComposing) return;
    const q = String(rawQuery == null ? state.fileTreeFilter : rawQuery).trim();
    if (!q || BOPOMOFO_ONLY_RE.test(q)) return;

    _fileFilterLogTimer = setTimeout(() => {
      _fileFilterLogTimer = null;
      if (_isFileFilterComposing) return;
      const finalQ = String(state.fileTreeFilter || '').trim();
      if (!finalQ || BOPOMOFO_ONLY_RE.test(finalQ)) return;
      if (finalQ === _lastLoggedFileTreeFilter) return;
      _lastLoggedFileTreeFilter = finalQ;
      sendFileTreeFilterEvent(finalQ, state._lastFileTreeFilterMatches || 0);
    }, FILE_TREE_FILTER_LOG_DEBOUNCE_MS);
  }

  function applyFileTreeFilter(rawQuery) {
    const val = rawQuery == null ? '' : String(rawQuery);
    state.fileTreeFilter = val;
    const input = $('fileTreeFilterInput');
    if (input && input.value !== val) input.value = val;
    const clearBtn = $('fileTreeFilterClear');
    if (clearBtn) clearBtn.hidden = !val.trim();
    if (!val.trim()) {
      cancelFileTreeFilterLog();
      _lastLoggedFileTreeFilter = '';
    }
    renderFileTree();
  }

  const ICON_COLLAPSE_ALL = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3.5L8 6.5L13 3.5"/><path d="M3 12.5L8 9.5L13 12.5"/></svg>`;
  const ICON_EXPAND_ALL = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6.5L8 3.5L13 6.5"/><path d="M3 9.5L8 12.5L13 9.5"/></svg>`;

  function updateCollapseBtnUI(btn, isExpanded) {
    if (!btn) return;
    if (isExpanded) {
      btn.innerHTML = ICON_COLLAPSE_ALL;
      btn.title = '摺疊全部';
    } else {
      btn.innerHTML = ICON_EXPAND_ALL;
      btn.title = '展開全部';
    }
  }

  function sortTreeNodes(nodes, sortMode) {
    if (!Array.isArray(nodes)) return [];
    // Deep-clone to avoid mutating original data
    const cloned = nodes.map(n => Array.isArray(n.children)
      ? { ...n, children: sortTreeNodes(n.children, sortMode) }
      : { ...n }
    );
    return cloned.sort((a, b) => {
      // Always keep directories before files
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      switch (sortMode) {
        case 'name-asc':
          return a.name.localeCompare(b.name, 'zh-TW', { numeric: true, sensitivity: 'base' });
        case 'name-desc':
          return b.name.localeCompare(a.name, 'zh-TW', { numeric: true, sensitivity: 'base' });
        case 'modified-desc': {
          const tA = a.mtime ? Date.parse(a.mtime) || 0 : 0;
          const tB = b.mtime ? Date.parse(b.mtime) || 0 : 0;
          if (tA !== tB) return tB - tA;
          return a.name.localeCompare(b.name, 'zh-TW', { numeric: true, sensitivity: 'base' });
        }
        case 'modified-asc': {
          const tA = a.mtime ? Date.parse(a.mtime) || 0 : 0;
          const tB = b.mtime ? Date.parse(b.mtime) || 0 : 0;
          if (tA !== tB) return tA - tB;
          return a.name.localeCompare(b.name, 'zh-TW', { numeric: true, sensitivity: 'base' });
        }
        default:
          return a.name.localeCompare(b.name, 'zh-TW', { numeric: true, sensitivity: 'base' });
      }
    });
  }

  function countFiles(node) {
    if (node.type === 'file') return 1;
    return (node.children || []).reduce((sum, c) => sum + countFiles(c), 0);
  }

  function collapseAllFolders() {
    const btn = $('fileCollapseAllBtn');
    const allFolders = $$('.tree-children', $('fileTree'));
    const anyExpanded = Array.from(allFolders).some(el => el.classList.contains('expanded'));

    if (anyExpanded) {
      // Collapse all
      allFolders.forEach(el => {
        el.classList.remove('expanded');
        const row = el.previousElementSibling;
        if (row) {
          const chevron = row.querySelector('.tree-chevron');
          if (chevron) chevron.classList.remove('expanded');
          const icon = row.querySelector('.tree-icon');
          if (icon) icon.textContent = '📁';
        }
      });
      updateCollapseBtnUI(btn, false);
    } else {
      // Expand all
      allFolders.forEach(el => {
        el.classList.add('expanded');
        const row = el.previousElementSibling;
        if (row) {
          const chevron = row.querySelector('.tree-chevron');
          if (chevron) chevron.classList.add('expanded');
          const icon = row.querySelector('.tree-icon');
          if (icon) icon.textContent = '📂';
        }
      });
      updateCollapseBtnUI(btn, true);
    }
  }

  function updateActiveFileUI(filePath, meta) {
    const indicator = $('headerActiveFile');
    if (!indicator) return;

    if (!filePath) {
      indicator.innerHTML = `<span class="active-file-icon">🏠</span><span class="active-file-title">首頁</span>`;
      indicator.title = `首頁 (${escHtml(state.siteName || 'mdWebview')})`;
    } else {
      // Dictionary files are namespaced `dict:…`; strip the prefix for display.
      const isDict = filePath.startsWith('dict:');
      const displayPath = isDict ? filePath.slice(5) : filePath;
      const parts = displayPath.split('/');
      const fileName = parts.pop().replace(/\.md$/, '');
      const folderName = parts.length > 0 ? parts[parts.length - 1] : '';
      const displayTitle = (meta && meta.title) ? meta.title : fileName;

      let html = `<span class="active-file-icon">${isDict ? '📖' : '📄'}</span><span class="active-file-title">${escHtml(displayTitle)}</span>`;
      if (folderName) {
        html += `<span class="active-file-folder">[${escHtml(folderName)}]</span>`;
      }

      indicator.innerHTML = html;
      indicator.title = `當前${isDict ? '辭典' : '經論'}: ${displayPath}`;
    }
  }

  /** 展開某個樹節點列的所有上層資料夾，讓它在檔案樹中可見。 */
  function expandTreeAncestors(rowEl) {
    let parent = rowEl.closest('.tree-children');
    while (parent) {
      parent.classList.add('expanded');
      const row = parent.previousElementSibling;
      if (row) {
        const chevron = row.querySelector('.tree-chevron');
        if (chevron) chevron.classList.add('expanded');
        const icon = row.querySelector('.tree-icon');
        if (icon) icon.textContent = '📂';
      }
      const grandparent = parent.parentElement;
      parent = grandparent ? grandparent.closest('.tree-children') : null;
    }
  }

  /**
   * 麵包屑點擊：在左側檔案樹中定位某個資料夾或檔案，卷動到該列並閃爍提示。
   *
   * 側欄收合時先展開（行動版同時關閉辭典側欄），並切到「檔案瀏覽器」分頁；
   * 隱藏中的面板無法 scrollIntoView，因此卷動延到下一次版面配置之後。
   * 點的是資料夾時也一併展開它本身，讓使用者直接看到其中的經論。
   *
   * @param {string} treePath - 主樹相對路徑（不含 `dict:` 前綴）
   */
  function revealInFileTree(treePath) {
    if (!treePath) return;
    const sidebar = $('sidebar');
    if (sidebar && sidebar.classList.contains('collapsed')) {
      sidebar.classList.remove('collapsed');
      state.sidebarCollapsed = false;
      if ((isMobileBrowser() || window.innerWidth <= 768) && state.dictSidebarOpen) {
        toggleDictSidebar(false);
      }
      updateSidebarBackdrop();
    }
    const filesTab = document.querySelector('.sidebar-tab[data-tab="files"]');
    if (filesTab && !filesTab.classList.contains('active')) filesTab.click();

    let row = document.querySelector(`.tree-item-row[data-path="${CSS.escape(treePath)}"]`);
    if (!row && state.fileTreeFilter) {
      applyFileTreeFilter('');
      row = document.querySelector(`.tree-item-row[data-path="${CSS.escape(treePath)}"]`);
    }
    if (!row) return;
    expandTreeAncestors(row);
    if (row.classList.contains('tree-folder')) {
      const childrenEl = row.nextElementSibling;
      if (childrenEl && childrenEl.classList.contains('tree-children')) {
        childrenEl.classList.add('expanded');
        const chevron = row.querySelector('.tree-chevron');
        if (chevron) chevron.classList.add('expanded');
        const icon = row.querySelector('.tree-icon');
        if (icon) icon.textContent = '📂';
      }
    }

    requestAnimationFrame(() => {
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      // 移除後強制 reflow 再加回，連續點同一節點也會重新閃爍
      row.classList.remove('tree-reveal-flash');
      void row.offsetWidth;
      row.classList.add('tree-reveal-flash');
      row.addEventListener('animationend', () => row.classList.remove('tree-reveal-flash'), { once: true });
    });
  }

  function highlightActiveFile(path, meta) {
    updateActiveFileUI(path, meta);

    $$('.tree-item-row.active').forEach((el) => el.classList.remove('active'));
    if (!path) return;

    const target = document.querySelector(`.tree-file[data-path="${CSS.escape(path)}"]`);
    if (target) {
      target.classList.add('active');
      expandTreeAncestors(target);

      // Auto-scroll active file item into view in sidebar
      setTimeout(() => {
        target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }, 100);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // §6 MARKDOWN VIEWER & VIRTUALIZED LARGE-FILE RENDERING
  // ═══════════════════════════════════════════════════════════

  function isVirtualMode() {
    return !!(state.virtual && state.virtual.filePath === state.currentFile);
  }

  /**
   * 判斷某檔案是否以虛擬滾動（分塊）方式呈現。
   *
   * 字典檔（`dict:`）永遠走虛擬路徑，且它們不在主樹的 `state.fileSizes` 對照表中
   * （`/api/tree` 不含 `dict:` 節點），因此單靠檔案大小判斷會漏掉字典檔，讓呼叫端
   * 誤以為一般檔案而補送 scrollTop 還原（破壞剛完成的跳轉定位）。凡需要「這是不是
   * 虛擬檔案」的判斷都應走這裡，而非各自比對檔案大小。
   *
   * @param {string|null} filePath - 檔案路徑（可能為 `dict:` 前綴或主樹相對路徑）
   * @returns {boolean} `dict:` 檔案，或大小 >= LARGE_FILE_MIN_BYTES 的檔案為 true
   */
  function isVirtualizedFile(filePath) {
    if (!filePath) return false;
    if (String(filePath).startsWith('dict:')) return true;
    return (state.fileSizes.get(filePath) || 0) >= LARGE_FILE_MIN_BYTES;
  }

  function chunkIndexForEntry(entryIndex) {
    // Chunk boundaries are byte-bounded and non-uniform (server clamps chunks to
    // CHUNK_MAX_BYTES), so find the range by binary search over the precomputed
    // [from, to] ranges instead of assuming a fixed 100-entry grid.
    const ranges = state.virtual.chunkRanges;
    let lo = 0, hi = ranges.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ranges[mid].from <= entryIndex) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  function insertChunkSorted(ci, sectionEl) {
    const body = $('markdownBody');
    const siblings = body.querySelectorAll('section.chunk');
    for (const sib of siblings) {
      const c = parseInt(sib.getAttribute('data-chunk'), 10);
      if (c > ci) { body.insertBefore(sectionEl, sib); return; }
    }
    // Insert before the bottom spacer (if present) so it always stays last.
    const v = state.virtual;
    if (v && v.spacerBottom) body.insertBefore(sectionEl, v.spacerBottom);
    else body.appendChild(sectionEl);
  }

  // Load (or return the already-loaded) chunk containing `entryIndex`.
  async function ensureChunk(entryIndex) {
    const v = state.virtual;
    if (!v) return null;
    if (entryIndex < 0) entryIndex = 0;
    if (entryIndex >= v.totalEntries) entryIndex = v.totalEntries - 1;

    const ci = chunkIndexForEntry(entryIndex);
    if (v.chunks.has(ci)) return v.chunks.get(ci).sectionEl;
    // A previously failed chunk left a retry placeholder behind; drop it and
    // re-attempt the load below rather than returning the stale placeholder.
    if (v.errorChunks.has(ci)) {
      const ph = v.errorChunks.get(ci);
      if (ph.parentNode) ph.remove();
      v.errorChunks.delete(ci);
    }
    if (v.inflight.has(ci)) {
      await v.inflight.get(ci);
      const c = v.chunks.get(ci);
      return c ? c.sectionEl : null;
    }

    const range = v.chunkRanges[ci];
    const from = range.from;
    const to = range.to;

    const p = (async () => {
      try {
        const res = await fetch(`/api/render-chunk?path=${encodeURIComponent(v.filePath)}&from=${from}&to=${to}`, {
          signal: v.abortController.signal
        });
        if (!res.ok) throw new Error('chunk load failed: ' + res.status);
        // The user may have switched files while this chunk was in flight; if the
        // virtual document we belong to is no longer current, drop the result so it
        // can't be inserted into the wrong file's body.
        if (state.virtual !== v) return null;
        const html = await res.text();
        // The document may have been torn down while the response body was
        // streaming; never mutate the DOM from a stale chunk after that await.
        if (state.virtual !== v) return null;
        const sectionEl = document.createElement('section');
        sectionEl.className = 'chunk';
        sectionEl.setAttribute('data-chunk', ci);
        sectionEl.setAttribute('data-from', from);
        sectionEl.setAttribute('data-to', to);
        setSanitizedHTML(sectionEl, html);
        postProcessMarkdownDOM(sectionEl);
        insertChunkSorted(ci, sectionEl);
        v.chunks.set(ci, { sectionEl, from, to });
        // Measure this chunk and refresh the spacers so `scrollTop` keeps mapping
        // to the absolute position (mounting above/below never shifts the view).
        v.chunkHeights.set(ci, sectionEl.offsetHeight);
        updateAvgPxPerLine();
        refreshSpacers();
        updateCachedLineAnchors($('markdownBody'));
        return sectionEl;
      } catch (err) {
        // Surface the failure instead of leaving a silent gap: drop an inline
        // retry placeholder at this chunk's position and notify once per attempt.
        if (state.virtual === v) {
          const placeholder = buildChunkErrorPlaceholder(ci, from, to);
          insertChunkSorted(ci, placeholder);
          v.errorChunks.set(ci, placeholder);
          showToast('內容片段載入失敗，請重試', 'error');
        }
        return null;
      }
    })();

    v.inflight.set(ci, p);
    try {
      return await p;
    } finally {
      v.inflight.delete(ci);
    }
  }

  // A compact inline "load failed" box with a retry button, mounted at the same
  // position a real chunk would occupy so the reader isn't left with a blank gap.
  function buildChunkErrorPlaceholder(ci, from, to) {
    const sectionEl = document.createElement('section');
    sectionEl.className = 'chunk chunk-error';
    sectionEl.setAttribute('data-chunk', ci);
    sectionEl.setAttribute('data-from', from);
    sectionEl.setAttribute('data-to', to);

    const box = document.createElement('div');
    box.className = 'chunk-error-box';
    const msg = document.createElement('span');
    msg.textContent = '⚠️ 內容片段載入失敗';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chunk-retry-btn';
    btn.textContent = '重試';
    btn.addEventListener('click', () => {
      const v = state.virtual;
      if (!v) return;
      const r = v.chunkRanges[ci];
      if (r) ensureChunk(r.from);
    });
    box.appendChild(msg);
    box.appendChild(btn);
    sectionEl.appendChild(box);
    return sectionEl;
  }

  // Drop chunks farther than `windowSize` away from the center to bound memory (~7 mounted).
  function recycleDistantChunks(centerCi, windowSize = 2) {
    const v = state.virtual;
    if (!v) return;
    const keep = new Set();
    for (let c = centerCi - windowSize; c <= centerCi + windowSize; c++) keep.add(c);
    let removed = false;
    for (const [ci, data] of Array.from(v.chunks.entries())) {
      if (!keep.has(ci)) {
        data.sectionEl.remove();
        v.chunks.delete(ci);
        v.chunkHeights.delete(ci);
        removed = true;
      }
    }
    if (v.errorChunks) {
      for (const [ci, placeholderEl] of Array.from(v.errorChunks.entries())) {
        if (!keep.has(ci)) {
          if (placeholderEl && placeholderEl.parentNode) placeholderEl.remove();
          v.errorChunks.delete(ci);
          removed = true;
        }
      }
    }
    if (removed) {
      refreshSpacers();
      updateCachedLineAnchors($('markdownBody'));
    }
  }

  // Binary search: last entry whose lineStart <= line.
  function entryIndexForLine(line) {
    const entries = state.virtual.entries;
    let lo = 0, hi = entries.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (entries[mid].ls <= line) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  // Rough absolute source line at the top of the viewport, from scrollTop and the
  // calibrated px-per-line. Used only to pick which chunks to mount when the
  // viewport is inside a spacer (fast scrollbar jumps); anchors refine it when
  // the viewport overlaps mounted content.
  function estimateLineFromScrollTop() {
    const v = state.virtual;
    const content = $('content');
    if (!v || !content) return 1;
    const avg = v.avgPxPerLine || 40;
    return Math.max(1, Math.floor(content.scrollTop / avg) + 1);
  }

  function updateAvgPxPerLine() {
    const v = state.virtual;
    if (!v) return;
    let px = 0, lines = 0;
    for (const ci of v.chunks.keys()) {
      const data = v.chunks.get(ci);
      if (!data || !data.sectionEl || !data.sectionEl.parentNode) continue;
      // Measure LIVE height, not the cached chunkHeights value. The cache is only
      // written on (re)mount, so after the user changes font size / line height /
      // max width the stored value is stale and `avgPxPerLine` would then map
      // scrollTop to the wrong line — the TOC-click "wrong heading" bug. This runs
      // on chunk mount/recycle, never per scroll frame, so offsetHeight is cheap.
      const h = data.sectionEl.offsetHeight;
      if (h <= 0) continue;
      v.chunkHeights.set(ci, h);
      // Source-line span of this chunk (used only as a proportional weight).
      const firstLs = v.entries[data.from].ls;
      const lastLe = v.entries[data.to].le;
      const lineCount = Math.max(1, lastLe - firstLs + 1);
      px += h; lines += lineCount;
    }
    if (lines > 0) v.avgPxPerLine = px / lines;
  }

  // Recompute the top/bottom spacer heights so the total scrollable height stays
  // equal to the whole document, and mounting/recycling a chunk simply trades
  // spacer height for real content (or vice-versa) without shifting the view.
  // Spacer height is derived from exact source-line counts × calibrated
  // px-per-line (more accurate than a flat per-entry average).
  function refreshSpacers() {
    const v = state.virtual;
    if (!v || !v.spacerTop || !v.spacerBottom) return;
    const cis = Array.from(v.chunks.keys()).filter(ci => v.chunks.get(ci)).sort((a, b) => a - b);
    if (cis.length === 0) {
      v.spacerTop.style.height = '0px';
      v.spacerBottom.style.height = '0px';
      return;
    }
    const firstCi = cis[0];
    const lastCi = cis[cis.length - 1];
    const firstData = v.chunks.get(firstCi);
    const lastData = v.chunks.get(lastCi);
    const firstEntry = v.entries[firstData.from];
    const lastEntry = v.entries[lastData.to];
    // Chunk 0 includes the file preamble (renders from line 1); later chunks
    // start at their first entry's heading line.
    const firstRenderedLine = firstData.from === 0 ? 1 : (firstEntry ? firstEntry.ls : 1);
    const linesAbove = Math.max(0, firstRenderedLine - 1);
    const linesBelow = Math.max(0, v.totalLines - (lastEntry ? lastEntry.le : 0));
    const avg = v.avgPxPerLine || 40;
    v.spacerTop.style.height = (linesAbove * avg) + 'px';
    v.spacerBottom.style.height = (linesBelow * avg) + 'px';
  }

  // Re-measure the mounted chunks and rebuild the spacer geometry after a user
  // setting that changes rendered line height (font size / line height / max
  // width) has been applied. Without this, `avgPxPerLine` and `chunkHeights`
  // stay calibrated to the previous font size, so `estimateLineFromScrollTop()`
  // maps scrollTop to the wrong line and the scroll handler re-mounts chunks
  // around the wrong heading (the "TOC click opens the wrong heading" bug).
  function recalibrateVirtualGeometry(preserve) {
    const v = state.virtual;
    if (!v || !v.spacerTop || !v.spacerBottom) return;
    const content = $('content');
    if (!content) return;

    for (const [ci, data] of Array.from(v.chunks.entries())) {
      if (data && data.sectionEl && data.sectionEl.parentNode) {
        v.chunkHeights.set(ci, data.sectionEl.offsetHeight);
      }
    }
    v.avgPxPerLine = null;
    updateAvgPxPerLine();
    refreshSpacers();
    updateCachedLineAnchors($('markdownBody'));

    // Re-anchor the line the reader was on before the reflow so changing the
    // font doesn't yank their place to a different heading.
    if (preserve && preserve.line > 0) {
      const el = document.getElementById('L' + preserve.line);
      if (el) {
        const r = el.getBoundingClientRect();
        const cr = content.getBoundingClientRect();
        content.scrollTop = Math.max(0, content.scrollTop + (r.top - cr.top) - preserve.top);
      }
    }
  }

  // Capture the line currently at the top of the content viewport (and its pixel
  // offset from the viewport top) using actual anchor rects — NOT the px-per-line
  // estimate, which is precisely what a font-size change is about to invalidate.
  function captureTopAnchor() {
    const v = state.virtual;
    const content = $('content');
    if (!v || !content || !cachedLineAnchors.length) return null;
    const cr = content.getBoundingClientRect();
    for (const a of cachedLineAnchors) {
      const r = a.getBoundingClientRect();
      if (r.bottom >= cr.top) {
        return { line: parseInt(a.dataset.line || '0', 10), top: r.top - cr.top };
      }
    }
    return null;
  }

  // The anchor of the block that *contains* line `lineNum`: the last anchor whose
  // data-line is <= lineNum (cachedLineAnchors is in ascending document order, so a
  // binary search suffices). A search match can land on a body continuation line
  // that carries no anchor of its own — render-worker only emits an anchor at block
  // starts. The numerically-NEAREST anchor is wrong for those: for a match in the
  // middle of a multi-line entry it can be the NEXT entry's heading, which sends
  // the jump one entry too far and makes the forward-walking keyword highlight miss
  // the matched text entirely (the "cmd+f sometimes fails + no highlight" bug). The
  // containing block's anchor is always at-or-before the line, so the jump lands on
  // the right entry and the highlight walk reaches the body text.
  function anchorAtOrBefore(lineNum) {
    if (!cachedLineAnchors.length) return null;
    let lo = 0, hi = cachedLineAnchors.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const n = parseInt(cachedLineAnchors[mid].dataset.line || '0', 10);
      if (n <= lineNum) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return cachedLineAnchors[ans];
  }

  // Mount a single contiguous window of chunks centered on `centerCi`, removing
  // every chunk outside it. Keeps the mounted set contiguous so the spacers only
  // ever represent the "above first chunk" and "below last chunk" regions.
  async function setMountedWindow(centerCi, radius = 1) {
    const v = state.virtual;
    if (!v) return;
    const keep = new Set();
    for (let c = centerCi - radius; c <= centerCi + radius; c++) keep.add(c);
    for (const [c, data] of Array.from(v.chunks.entries())) {
      if (!keep.has(c)) {
        data.sectionEl.remove();
        v.chunks.delete(c);
        v.chunkHeights.delete(c);
      }
    }
    // Mount the window concurrently (each chunk is an independent fetch) instead
    // of serially, so a result click doesn't pay three sequential round-trips.
    const mounts = [];
    for (let c = centerCi - radius; c <= centerCi + radius; c++) {
      if (c < 0 || c >= v.chunkRanges.length) continue;
      mounts.push(ensureChunk(v.chunkRanges[c].from));
    }
    await Promise.all(mounts);
    updateAvgPxPerLine();
    refreshSpacers();
    updateCachedLineAnchors($('markdownBody'));
  }

  /**
   * 虛擬滾動版本的深層跳行：掛載目標區塊後，以其實際 rect 精準定位。
   *
   * 與 scrollToLine 相同，定位目標是「要求的那一行」anchor（`target`）而非
   * `hlRes.firstMark`（理由見 scrollToLine）；`target` 只在迴圈外解析一次並重複
   * 使用，修正迴圈中絕不重新呼叫 anchorAtOrBefore() / 重新查詢 DOM——切換檔案後
   * 殘留的影格若對新文件重新解析，可能取到最後一個 anchor 而把畫面甩到文末。
   *
   * 首次定位後會執行有界的自我修正迴圈（最多 4 次）：字體、行高、最大寬度都會
   * 改變實際行高，且 spacer 高度以單一 avgPxPerLine 估算（離已掛載窗越遠誤差越大），
   * 故第一次可能失準。迴圈以 `target.getBoundingClientRect().top -
   * #content.getBoundingClientRect().top - 12` 為誤差，收斂（|d| <= 2）或無進展
   * （|d| 未下降 / 已達捲動邊界）即中止；並以 `state.virtual !== v`（文件已換）、
   * `jumpToken = state._openToken` 快照（期間又開了新檔）與 `target.isConnected`
   * （節點已卸載）三重守衛防止對已失效的文件繼續捲動。RAF 使用 v._lineJumpRaf
   * 專屬欄位，不可重用 v._scrollRaf（那是 setupVirtualScroll 的節流閘門）。
   *
   * @param {number} lineNum          - 目標行號（0/null 時直接返回）
   * @param {string} [highlightQuery] - 要閃示的關鍵字（可省略）
   * @param {string} [searchMode]     - 高亮模式（'loose'/'strict'），預設沿用上次搜尋
   * @returns {Promise<void>}
   */
  async function scrollToLineVirtual(lineNum, highlightQuery, searchMode) {
    clearLineKeywordHighlights();
    if (!lineNum) return;
    const v = state.virtual;
    if (!v) return;

    const entryIndex = entryIndexForLine(lineNum);
    const ci = chunkIndexForEntry(entryIndex);

    // Mount a contiguous window around the target, then position by the target
    // element's *actual* rect. Spacers keep the layout stable, so this lands
    // exactly on the requested line (large-file jumps were previously drifting
    // because chunks mounted above the target shifted the document mid-scroll).
    await setMountedWindow(ci, 1);

    let target = document.getElementById('L' + lineNum);
    if (!target) target = anchorAtOrBefore(lineNum);
    if (!target) {
      showToast(`⚠️ 找不到第 ${lineNum} 行`, 'warning');
      return;
    }

    const mode = searchMode || (state.lastSearchData && state.lastSearchData.mode) || state.searchMode || 'loose';
    let hlRes = null;
    if (highlightQuery) {
      hlRes = highlightLineKeyword(target, highlightQuery, mode);
    }

    let scrollTarget;
    let flashBlock;

    if (hlRes && hlRes.matched) {
      flashBlock = hlRes.hitBlock;
    } else {
      flashBlock = target.closest('p, h1, h2, h3, h4, h5, h6, li, blockquote, tr, pre, table, .obsidian-callout') || target.nextElementSibling || target.parentElement;
    }
    // 一律以「要求的那一行」anchor 為定位目標（理由同 scrollToLine）。target 僅在迴圈
    // 外解析一次並重複使用；切勿於修正迴圈中重新呼叫 anchorAtOrBefore()，否則切換檔案
    // 後殘留的影格可能對新文件取到最後一個 anchor，把畫面甩到文末。
    scrollTarget = target;

    const content = $('content');
    const targetRect = scrollTarget.getBoundingClientRect();
    const containerRect = content.getBoundingClientRect();
    content.scrollTop = Math.max(0, content.scrollTop + (targetRect.top - containerRect.top) - 12);

    // 有界的事後修正：字體大小／行高／最大寬度都會改變實際行高，且 spacer 高度是以單一
    // avgPxPerLine 估算（離已掛載窗越遠誤差越大），因此第一次定位可能失準。以 anchor 的
    // 實際 rect 最多修正 3 次即收斂；任何文件切換、節點卸載或無進展即中止。
    const jumpToken = state._openToken;
    let lastAbs = Infinity;
    const alignJump = (attempt) => {
      if (state.virtual !== v || state._openToken !== jumpToken) return;
      if (!target.isConnected) return;
      const c = $('content');
      if (!c) return;
      const d = (target.getBoundingClientRect().top - c.getBoundingClientRect().top) - 12;
      const abs = Math.abs(d);
      if (abs <= 2) return;
      if (abs >= lastAbs || attempt >= 3) return;
      lastAbs = abs;
      const next = Math.max(0, c.scrollTop + d);
      if (next === c.scrollTop) return; // 已達捲動邊界，視為終止
      c.scrollTop = next;
      // 獨立欄位：不可重用 v._scrollRaf（那是 setupVirtualScroll 的節流閘門）。
      v._lineJumpRaf = requestAnimationFrame(() => { v._lineJumpRaf = null; alignJump(attempt + 1); });
    };
    v._lineJumpRaf = requestAnimationFrame(() => { v._lineJumpRaf = null; alignJump(0); });

    if (flashBlock) {
      flashBlock.classList.add('line-highlight');
      setTimeout(() => flashBlock.classList.remove('line-highlight'), 2500);
    }
    updateVirtualScrollSpy(lineNum);
  }

  async function jumpToEntry(entryIndex) {
    const v = state.virtual;
    if (!v) return;
    const line = v.entries[entryIndex] ? v.entries[entryIndex].ls : 1;
    await scrollToLineVirtual(line, null);
    updateEntryNav();
    if (isMobileBrowser() || window.innerWidth <= 768) {
      closeMobileSidebars();
    }
  }

  // Virtualized TOC geometry. Each mounted row has a FIXED height so the mounted
  // window can be derived from tocList.scrollTop with exact arithmetic; only a
  // small window (~viewport + buffer) is ever in the DOM. Building all 32K rows
  // at once was the source of the sidebar/TOC tab freeze.
  const TOC_ROW_H = 34;         // px height of a virtualized TOC entry row
  const TOC_GROUP_H = 30;       // px height of a virtualized TOC group header
  const TOC_WINDOW_BUFFER = 12; // extra rows mounted above/below the viewport

  // The entry whose heading is actually at the top of the content viewport,
  // measured from the rendered anchors. The arithmetic px-per-line estimate is
  // accurate enough for chunk management but NOT for the scroll-spy highlight:
  // heading lines are taller than body lines and entries vary in length, so
  // `estimateLineFromScrollTop()` drifts by an entry or two and the TOC would
  // highlight the entry below the one the reader is on.
  function topVisibleEntryIndex() {
    const v = state.virtual;
    const content = $('content');
    if (!v || !content || !cachedLineAnchors.length) return -1;

    const rough = estimateLineFromScrollTop();
    const crTop = content.getBoundingClientRect().top;

    // Binary search the cached anchors (document order == line order) for the
    // last anchor at/before the rough line, so the subsequent walk is O(1).
    let lo = 0, hi = cachedLineAnchors.length - 1, idx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const ln = parseInt(cachedLineAnchors[mid].dataset.line || '0', 10);
      if (ln <= rough) { idx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }

    // Walk up to the first anchor whose bottom edge is still below the viewport
    // top (i.e. the topmost visible line), then settle on it.
    while (idx > 0 && cachedLineAnchors[idx].getBoundingClientRect().bottom > crTop) idx--;
    while (idx + 1 < cachedLineAnchors.length && cachedLineAnchors[idx].getBoundingClientRect().bottom <= crTop) idx++;

    const topLine = parseInt(cachedLineAnchors[idx].dataset.line || '0', 10);
    if (topLine <= 0) return -1;
    return entryIndexForLine(topLine);
  }

  function findVisibleAncestorEntry(v, entryIdx) {
    if (entryIdx < 0 || !v || !v.entries || !v.entries[entryIdx]) return entryIdx;
    if (v._tocEntryItemIndex && v._tocEntryItemIndex.has(entryIdx)) {
      return entryIdx;
    }
    let targetLevel = v.entries[entryIdx].level || 1;
    for (let i = entryIdx - 1; i >= 0; i--) {
      const curLevel = v.entries[i].level || 1;
      if (curLevel < targetLevel) {
        targetLevel = curLevel;
        if (v._tocEntryItemIndex && v._tocEntryItemIndex.has(i)) {
          return i;
        }
      }
    }
    return entryIdx;
  }

  function updateVirtualScrollSpy(line) {
    const v = state.virtual;
    if (!v || !v._tocItems || v._tocItems.length === 0) return;
    let ei = topVisibleEntryIndex();
    if (ei < 0) ei = entryIndexForLine(line); // no anchors mounted yet → fall back

    // Always clear active class on rendered rows first
    if (v._tocRowEls) {
      v._tocRowEls.forEach(el => el.classList.remove('active'));
    }

    v._activeTocEntry = ei;
    const visibleEntry = findVisibleAncestorEntry(v, ei);

    let row = v._tocRowEls.get(visibleEntry);
    if (!row && isTocPanelVisible()) {
      centerTocOnEntry(visibleEntry);
      row = v._tocRowEls.get(visibleEntry);
    }
    if (row) {
      row.classList.add('active');
      row.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    }
  }

  function isTocPanelVisible() {
    const panel = $('panelToc');
    return !!(panel && panel.classList.contains('active'));
  }

  function cleanHeadingText(text) {
    if (!text) return '';
    return text
      .replace(/^\*\*+|\*\*+$/g, '')
      .replace(/^__+|__+$/g, '')
      .replace(/^[*_]+|[*_]+$/g, '')
      .replace(/^==+|==+$/g, '')
      .replace(/\[\^[^\]]+\]/g, '')
      .trim();
  }

  // Flat fixed-height item list + prefix offsets. Only ~O(window) rows are
  // mounted; the offsets let renderTocWindow find the visible slice in O(log n).
  function buildVirtualTocItems(v) {
    const items = [];
    const entryItemIndex = new Map();
    let minLevel = 6;
    if (v.entries && v.entries.length > 0) {
      for (let i = 0; i < v.entries.length; i++) {
        const lvl = v.entries[i].level || 1;
        if (lvl < minLevel) minLevel = lvl;
        if (minLevel === 1) break;
      }
    } else {
      minLevel = 1;
    }
    v._collapsedEntries = v._collapsedEntries || new Set();
    const filterTerms = parseSidebarFilterTerms(state.tocFilter);
    const isFiltering = filterTerms.length > 0;

    let skipUntilLevel = -1;

    for (let i = 0; i < (v.entries || []).length; i++) {
      const e = v.entries[i];
      const level = e.level || 1;

      if (!isFiltering && skipUntilLevel > 0) {
        if (level > skipUntilLevel) {
          continue; // Child under a collapsed ancestor
        } else {
          skipUntilLevel = -1; // Exited the collapsed subtree
        }
      }

      const label = cleanHeadingText(e.h || '');
      if (isFiltering && !matchesSidebarFilter(label, filterTerms)) {
        continue;
      }

      const hasChildren = !isFiltering && (i + 1 < v.entries.length) && ((v.entries[i + 1].level || 1) > level);
      const isCollapsed = !isFiltering && v._collapsedEntries.has(i);
      const depth = Math.max(0, level - minLevel);

      items.push({
        type: 'entry',
        entryIndex: i,
        label,
        level,
        depth,
        hasChildren,
        isCollapsed,
        h: TOC_ROW_H
      });
      entryItemIndex.set(i, items.length - 1);

      if (hasChildren && isCollapsed) {
        skipUntilLevel = level;
      }
    }

    const offsets = new Array(items.length + 1);
    offsets[0] = 0;
    for (let i = 0; i < items.length; i++) offsets[i + 1] = offsets[i] + items[i].h;
    v._tocItems = items;
    v._tocOffsets = offsets;
    v._tocEntryItemIndex = entryItemIndex;
    v._tocTotalHeight = offsets[offsets.length - 1];
  }

  function renderTocWindow() {
    const v = state.virtual;
    const tocList = $('tocList');
    if (!v || !v._tocItems || !v._tocOffsets || !v._tocWindow) return;
    const items = v._tocItems;
    const offsets = v._tocOffsets;
    if (items.length === 0) {
      v._tocRenderedStart = -1;
      v._tocRenderedEnd = -1;
      v._tocSpacerTop.style.height = '0px';
      v._tocSpacerBottom.style.height = '0px';
      v._tocRowEls.clear();
      const q = (state.tocFilter || '').trim();
      v._tocWindow.innerHTML = q
        ? `<div class="panel-placeholder"><span class="placeholder-icon">📑</span><span>沒有符合「${escHtml(q)}」的標題</span></div>`
        : '<div class="panel-placeholder"><span class="placeholder-icon">📑</span><span>此文件沒有標題</span></div>';
      return;
    }
    const scrollTop = tocList.scrollTop;
    const viewportH = tocList.clientHeight || 400;

    // First item whose top edge is at/below the viewport top (binary search).
    let lo = 0, hi = items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid] <= scrollTop) lo = mid + 1;
      else hi = mid;
    }
    const first = Math.max(0, lo - 1);
    let last = first;
    const bottom = scrollTop + viewportH;
    while (last < items.length && offsets[last + 1] <= bottom) last++;

    const start = Math.max(0, first - TOC_WINDOW_BUFFER);
    const end = Math.min(items.length - 1, last + TOC_WINDOW_BUFFER);

    // Wheel scrolling usually moves scrollTop a few pixels per frame, which is
    // far smaller than one row (34px), so the mounted [start, end] window rarely
    // changes on adjacent frames. Rebuilding the window (clearing + recreating
    // ~47 rows) every frame regardless was the "大量刷新" churn the user saw.
    // Skip the rebuild when the window is unchanged; the existing rows already
    // carry the correct geometry and active highlight.
    if (start === v._tocRenderedStart && end === v._tocRenderedEnd) return;
    v._tocRenderedStart = start;
    v._tocRenderedEnd = end;

    v._tocSpacerTop.style.height = offsets[start] + 'px';
    const win = v._tocWindow;
    win.textContent = '';
    v._tocRowEls.clear();
    const frag = document.createDocumentFragment();
    for (let i = start; i <= end; i++) {
      const item = items[i];
      const el = document.createElement('div');
      el.className = 'toc-item-row virtual' + (item.isCollapsed ? ' collapsed' : '');
      el.setAttribute('data-entry', item.entryIndex);
      el.setAttribute('data-level', item.level || 1);
      el.setAttribute('data-index', item.entryIndex);

      const depth = item.depth || 0;
      const indent = depth * 16 + 8;
      el.style.paddingLeft = `${indent}px`;

      if (depth > 0) {
        el.classList.add('is-nested');
        el.style.setProperty('--guide-left', `${indent - 10}px`);
      }

      const chevron = document.createElement('span');
      chevron.className = 'toc-item-chevron' + (item.hasChildren ? '' : ' empty');
      chevron.textContent = '▾';
      if (item.hasChildren) {
        chevron.title = item.isCollapsed ? '展開' : '摺疊';
        chevron.addEventListener('click', (e) => {
          e.stopPropagation();
          if (v._collapsedEntries.has(item.entryIndex)) {
            v._collapsedEntries.delete(item.entryIndex);
          } else {
            v._collapsedEntries.add(item.entryIndex);
          }
          buildVirtualTocItems(v);
          v._tocRenderedStart = -1;
          v._tocRenderedEnd = -1;
          renderTocWindow();
          syncTocCollapseBtnState();
          updateVirtualScrollSpy(estimateLineFromScrollTop());
        });
      }
      el.appendChild(chevron);

      const label = document.createElement('span');
      label.className = 'toc-item-label';
      label.textContent = item.label || '';
      label.title = item.label || '';
      el.appendChild(label);

      el.addEventListener('click', () => jumpToEntry(item.entryIndex));
      v._tocRowEls.set(item.entryIndex, el);
      frag.appendChild(el);
    }
    win.appendChild(frag);
    v._tocSpacerBottom.style.height = (v._tocTotalHeight - offsets[end + 1]) + 'px';

    // Re-apply the active highlight if the active entry (or visible ancestor) is mounted.
    if (v._activeTocEntry != null) {
      const visibleEntry = findVisibleAncestorEntry(v, v._activeTocEntry);
      const active = v._tocRowEls.get(visibleEntry);
      if (active) active.classList.add('active');
    }
  }

  function centerTocOnEntry(ei) {
    const v = state.virtual;
    const tocList = $('tocList');
    if (!v || !v._tocOffsets || !v._tocEntryItemIndex) return;
    const visibleEntry = findVisibleAncestorEntry(v, ei);
    const itemIdx = v._tocEntryItemIndex.get(visibleEntry);
    if (itemIdx == null) return;
    const target = v._tocOffsets[itemIdx];
    const viewportH = tocList.clientHeight || 400;
    tocList.scrollTop = Math.max(0, target - Math.floor(viewportH / 2));
    renderTocWindow();
  }

  /**
   * 拆除已虛擬化的（分塊）文件：卸載其滾動 handler、取消所有待處理的 RAF
   * （包含 `v._scrollRaf`、TOC 的 `v._tocRaf`，以及行跳轉事後修正的
   * `v._lineJumpRaf`——後者若未取消，會對已卸載的文件繼續捲動），並釋放
   * 每份文件的大型結構（section index、TOC items/offsets、chunk/heights Map），
   * 使切換檔案或返回首頁時不會把它們釘在記憶體中一整個 session。
   */
  function teardownVirtual() {
    const v = state.virtual;
    if (!v) {
      updateEntryNav();
      return;
    }
    if (v.abortController) v.abortController.abort();
    const content = $('content');
    if (v._scrollHandler && content) content.removeEventListener('scroll', v._scrollHandler);
    if (v._scrollRaf) { cancelAnimationFrame(v._scrollRaf); v._scrollRaf = null; }
    // 取消仍在排隊的「行跳轉事後修正」影格，避免它對已卸載的文件繼續捲動。
    if (v._lineJumpRaf) { cancelAnimationFrame(v._lineJumpRaf); v._lineJumpRaf = null; }
    const tocList = $('tocList');
    if (v._tocScrollHandler && tocList) tocList.removeEventListener('scroll', v._tocScrollHandler);
    if (v._tocRaf) { cancelAnimationFrame(v._tocRaf); v._tocRaf = null; }
    if (v.chunks) v.chunks.clear();
    if (v.inflight) v.inflight.clear();
    if (v.errorChunks) v.errorChunks.clear();
    if (v.chunkHeights) v.chunkHeights.clear();
    if (v.headwordMap) v.headwordMap.clear();
    if (v.entryMap) v.entryMap.clear();
    if (v._tocRowEls) v._tocRowEls.clear();
    if (v._collapsedEntries) v._collapsedEntries.clear();
    v._tocItems = null;
    v._tocOffsets = null;
    v._tocEntryItemIndex = null;
    v._tocSpacerTop = null;
    v._tocWindow = null;
    v._tocSpacerBottom = null;
    v.entries = null;
    v.groups = null;
    v.chunkRanges = null;
    state.virtual = null;
    updateEntryNav();
  }

  // Disconnect full-render scroll-spy handlers & observers so they stop
  // observing the previous document's headings.
  function disconnectScrollSpy() {
    if (state.scrollSpyHandler) {
      const content = $('content');
      if (content) content.removeEventListener('scroll', state.scrollSpyHandler);
      state.scrollSpyHandler = null;
    }
    if (state.scrollSpyResizeHandler) {
      window.removeEventListener('resize', state.scrollSpyResizeHandler);
      state.scrollSpyResizeHandler = null;
    }
    if (state.scrollSpyRaf) {
      cancelAnimationFrame(state.scrollSpyRaf);
      state.scrollSpyRaf = null;
    }
    if (state.scrollSpyObserver) {
      state.scrollSpyObserver.disconnect();
      state.scrollSpyObserver = null;
    }
    state.refreshScrollSpy = null;
  }

  // Build the TOC directly from the section index (not from DOM headings). For
  // very large files this can be tens of thousands of rows, so only a small
  // window is mounted (see buildVirtualTocItems / renderTocWindow).
  function renderVirtualTOC() {
    const v = state.virtual;
    const tocList = $('tocList');
    disconnectScrollSpy();
    buildVirtualTocItems(v);

    if (!v.entries || v.entries.length === 0) {
      tocList.innerHTML = '<div class="panel-placeholder"><span class="placeholder-icon">📑</span><span>此文件沒有標題</span></div>';
      return;
    }

    tocList.innerHTML = '';
    v._tocSpacerTop = document.createElement('div');
    v._tocSpacerTop.className = 'toc-spacer';
    v._tocWindow = document.createElement('div');
    v._tocWindow.className = 'toc-window';
    v._tocSpacerBottom = document.createElement('div');
    v._tocSpacerBottom.className = 'toc-spacer';
    v._tocRowEls = new Map();
    v._activeTocEntry = -1;
    tocList.appendChild(v._tocSpacerTop);
    tocList.appendChild(v._tocWindow);
    tocList.appendChild(v._tocSpacerBottom);

    if (v._tocScrollHandler) tocList.removeEventListener('scroll', v._tocScrollHandler);
    const onTocScroll = () => {
      if (v._tocRaf) return;
      v._tocRaf = requestAnimationFrame(() => {
        v._tocRaf = null;
        if (state.virtual !== v) return;
        renderTocWindow();
      });
    };
    v._tocScrollHandler = onTocScroll;
    tocList.addEventListener('scroll', onTocScroll, { passive: true });

    renderTocWindow();
    syncTocCollapseBtnState();
    updateVirtualScrollSpy(1);
  }

  function setupVirtualScroll() {
    const v = state.virtual;
    if (!v) return;
    const content = $('content');
    if (v._scrollHandler) content.removeEventListener('scroll', v._scrollHandler);

    const onScroll = () => {
      if (!isVirtualMode()) return;
      // Topmost visible line, estimated arithmetically from scrollTop and the
      // calibrated px-per-line. Deliberately no getBoundingClientRect()/
      // offsetHeight here — those force a synchronous layout on every scroll
      // frame and were the source of the mid-read UI freeze. The chunk-mount
      // decision only needs entry-level accuracy (the mounted window already
      // spans ±1 chunk), so an approximate line is sufficient; scroll-spy
      // tolerates ±1 entry near boundaries.
      const topLine = estimateLineFromScrollTop();

      const ci = chunkIndexForEntry(entryIndexForLine(topLine));

      // If the viewport jumped far from the mounted window, rebuild a contiguous
      // window in one collapse-safe step; otherwise prefetch/recycle incrementally.
      let centerFar = true;
      for (const c of v.chunks.keys()) {
        if (c >= ci - 1 && c <= ci + 1) { centerFar = false; break; }
      }
      if (centerFar) {
        setMountedWindow(ci, 2);
      } else {
        const nextCi = ci + 1;
        const prevCi = ci - 1;
        // Prefetch neighbors eagerly; failures already render an inline retry
        // placeholder via ensureChunk, so swallow the rejection to avoid noise.
        if (nextCi < v.chunkRanges.length) ensureChunk(v.chunkRanges[nextCi].from).catch(() => {});
        if (prevCi >= 0) ensureChunk(v.chunkRanges[prevCi].from).catch(() => {});
        recycleDistantChunks(ci);
      }
      updateVirtualScrollSpy(topLine);
      updateEntryNav();
    };

    const throttled = () => {
      if (v._scrollRaf) return;
      v._scrollRaf = requestAnimationFrame(() => { v._scrollRaf = null; onScroll(); });
    };
    v._scrollHandler = throttled;
    content.addEventListener('scroll', throttled, { passive: true });
  }

  // Attempt to open a large file via the virtualized path. Returns true if
  // handled; false means the caller should fall through to the full render.
  async function tryOpenVirtualFile(filePath, scrollToLineNum, highlightQuery, token, signal, searchMode) {
    // Reuse a cached section index when the file is unchanged: send If-None-Match
    // so the server answers 304 and skips the multi-MB payload on re-opens.
    const cachedSi = state.sectionIndexCache.get(filePath);
    const headers = {};
    if (cachedSi) headers['If-None-Match'] = cachedSi.etag;
    const res = await fetch(`/api/section-index?path=${encodeURIComponent(filePath)}`, { headers, signal });
    if (token !== undefined && token !== state._openToken) return false;
    let si;
    if (res.status === 304 && cachedSi) {
      si = cachedSi.si;
    } else if (res.ok) {
      const etag = res.headers.get('ETag');
      si = await res.json();
      if (token !== undefined && token !== state._openToken) return false;
      if (etag) {
        // Bounded LRU so the cache can't grow unboundedly across many large files.
        state.sectionIndexCache.delete(filePath);
        state.sectionIndexCache.set(filePath, { etag, si });
        while (state.sectionIndexCache.size > 12) {
          state.sectionIndexCache.delete(state.sectionIndexCache.keys().next().value);
        }
      }
    } else {
      return false;
    }
    if (!si || !si.large || !Array.isArray(si.entries) || si.entries.length === 0) return false;
    if (!Array.isArray(si.chunks) || si.chunks.length === 0) return false;
    if (token !== undefined && token !== state._openToken) return false;

    const v = {
      filePath,
      abortController: new AbortController(),
      entries: si.entries,       // [{h, ls, le}]
      groups: si.groups || [],
      totalLines: si.totalLines,
      totalEntries: si.entries.length,
      chunkRanges: si.chunks,    // [{from, to, lineStart}] — server's actual byte-bounded chunk boundaries
      chunks: new Map(),
      inflight: new Map(),
      errorChunks: new Map(),     // chunkIndex -> failed-load retry placeholder
      chunkHeights: new Map(),   // chunkIndex -> measured pixel height
      avgPxPerLine: null,        // calibrated average rendered pixel height per source line
      spacerTop: null,           // top spacer element (keeps scrollTop → absolute position)
      spacerBottom: null,        // bottom spacer element
      headwordMap: new Map(),
      entryMap: new Map(),
      _tocItems: null,
      _tocOffsets: null,
      _tocEntryItemIndex: null,
      _tocTotalHeight: 0,
      _tocRowEls: new Map(),
      _tocSpacerTop: null,
      _tocWindow: null,
      _tocSpacerBottom: null,
      _tocScrollHandler: null,
      _tocRaf: null,
      _tocRenderedStart: -1,
      _tocRenderedEnd: -1,
      _activeTocEntry: -1,
      _scrollHandler: null,
      _scrollRaf: null,
    };

    // Tear down any previous virtual document (large→large switch, or a prior
    // failed attempt) so its index, TOC rows and chunk Maps are released.
    teardownVirtual();
    if (token !== undefined && token !== state._openToken) return false;
    state.virtual = v;

    si.entries.forEach((e, i) => {
      if (e.h && !v.headwordMap.has(e.h)) v.headwordMap.set(e.h, i);
      const clean = (e.h || '').replace(/^【/, '').replace(/】$/, '').trim();
      if (clean && !v.entryMap.has(clean)) v.entryMap.set(clean, i);
    });

    renderContentHeader(filePath, {});
    const dispName = filePath.startsWith('dict:') ? filePath.slice(5).split('/').pop().replace(/\.md$/, '') : filePath.split('/').pop().replace(/\.md$/, '');
    document.title = `${dispName} — ${state.siteName}`;

    renderVirtualTOC();

    // Spacer-based virtual scroll: a top/bottom spacer holds the pixel height of
    // all unmounted entries, so `content.scrollTop` maps to the absolute line
    // position and mounting/recycling a chunk never shifts already-visible text.
    $('markdownBody').innerHTML = '';
    // Reset the reader's scroll offset before mounting the new document. When
    // switching from a large file scrolled to a deep line, `content.scrollTop`
    // otherwise carries over the previous file's huge offset.
    $('content').scrollTop = 0;
    v.spacerTop = document.createElement('div');
    v.spacerTop.className = 'chunk-spacer';
    v.spacerBottom = document.createElement('div');
    v.spacerBottom.className = 'chunk-spacer';
    $('markdownBody').appendChild(v.spacerTop);
    $('markdownBody').appendChild(v.spacerBottom);

    // Reveal the reader (openFile left the loading spinner up before branching here).
    $('contentLoading').style.display = 'none';
    $('contentWrapper').style.display = 'block';

    if (scrollToLineNum) {
      await scrollToLineVirtual(scrollToLineNum, highlightQuery, searchMode);
    } else {
      await ensureChunk(0);
      $('content').scrollTop = 0;
    }
    if (token !== undefined && token !== state._openToken) return false;
    // Attach the scroll handler only AFTER the initial mount/scroll has settled.
    // Attaching it earlier lets a scroll event fired by the transition (scrollTop
    // clamp / spacer growth) invoke onScroll mid-mount, whose
    // `estimateLineFromScrollTop()` then reads a transient scrollTop and re-mounts
    // the window around chunk 0 — racing `scrollToLineVirtual`'s `setMountedWindow`
    // and dropping a "後段" (deep-line) jump at the top of the file instead of on
    // the matched entry.
    setupVirtualScroll();
    updateEntryNav();
    setTimeout(() => saveReadProgress(filePath), 350);
    return true;
  }

  async function openFile(filePath, scrollToLineNum, highlightQuery, searchMode) {
    if (state._openFileAbort) {
      state._openFileAbort.abort();
      state._openFileAbort = null;
    }
    const token = ++state._openToken;
    const abortCtrl = new AbortController();
    state._openFileAbort = abortCtrl;
    cachedLineAnchors = [];

    const isSwitchingFile = state.currentFile !== filePath;
    state.currentFile = filePath;
    if (isSwitchingFile) resetTocFilterUI();
    log.info(`Opening file "${filePath}"${scrollToLineNum ? ` (Line: ${scrollToLineNum})` : ''}`);

    addRecentFile(filePath);
    updateBookmarkButtonUI(filePath);
    updateEntryNav();

    // If search selector is set to __CURRENT_FILE__, automatically update search results for newly opened file
    const searchFolderSelect = $('searchFolderSelect');
    if (searchFolderSelect && searchFolderSelect.value === '__CURRENT_FILE__') {
      const searchInput = $('globalSearchInput');
      if (searchInput && searchInput.value.trim()) {
        performGlobalSearch(searchInput.value.trim());
      }
    }

    // Update URL search parameters — preserve line param if provided using unencoded Chinese URL
    const cleanFile = encodeURIComponent(filePath).replace(/%2F/g, '/');
    let newSearch = `?file=${cleanFile}`;
    if (scrollToLineNum) newSearch += `&line=${scrollToLineNum}`;

    if (safeDecodeURIComponent(window.location.search) !== safeDecodeURIComponent(newSearch)) {
      const newUrl = window.location.pathname + newSearch;
      history.pushState(null, '', newUrl);
    }

    // Auto-collapse sidebars on mobile screens when opening a file
    if (isMobileBrowser() || window.innerWidth <= 768) {
      closeMobileSidebars();
    }

    // Large files take the virtualized path (chunked render + lazy TOC) to keep the UI responsive.
    // Dictionary files always take the virtualized path (they can be 20MB+ and are
    // not listed in the main tree's fileSizes map).
    const isDictFile = filePath.startsWith('dict:');
    const forceFull = new URLSearchParams(window.location.search).get('full') === '1'
      || storage.get(STORAGE_KEYS.FORCE_FULL) === '1';

    // Same-file navigation: if this dict/large file is already open in virtual
    // mode, skip the full section-index refetch + teardown and just jump to the
    // requested entry — consecutive dictionary result clicks then feel instant.
    if (state.virtual && state.virtual.filePath === filePath && !forceFull) {
      highlightActiveFile(filePath);
      await scrollToLineVirtual(scrollToLineNum || 1, highlightQuery, searchMode);
      if (token !== state._openToken) return;
      return;
    }

    const loading = $('contentLoading');
    const welcome = $('welcomeScreen');
    const wrapper = $('contentWrapper');
    const content = $('content');

    welcome.style.display = 'none';
    wrapper.style.display = 'none';
    loading.style.display = 'flex';

    // Close page search and reset heading O(1) map for new file
    closePageSearch();
    headingTextMap.clear();

    highlightActiveFile(filePath);

    const fileSize = state.fileSizes.get(filePath) || 0;
    if ((fileSize >= LARGE_FILE_MIN_BYTES || isDictFile) && !forceFull) {
      try {
        const handled = await tryOpenVirtualFile(filePath, scrollToLineNum, highlightQuery, token, abortCtrl.signal, searchMode);
        if (token !== state._openToken) return;
        if (handled) return;
      } catch (err) {
        if (token !== state._openToken) return;
        if (err && (err.name === 'AbortError' || err.code === 20)) return;
        console.warn('[Virtual] open failed, falling back to full render:', err);
        showToast('ℹ️ 大檔快速模式不可用，已改以全文模式開啟', 'info', 3000);
      }
    }

    // Full-render path: release any lingering virtual document and scroll-spy
    // observer from a previously opened file before rendering the new one.
    teardownVirtual();
    disconnectScrollSpy();

    try {
      // Revalidate cached HTML before returning it. The server's 304 path keeps
      // the warm-cache fast path while ensuring edited files replace stale HTML.
      cacheGet(filePath); // Refresh LRU position while conditional validation runs.

      // Build fetch headers — send ETag for 304 Not Modified support
      const fetchHeaders = {};
      const cachedEtag = renderCache.__etag ? renderCache.__etag.get(filePath) : null;
      if (cachedEtag) fetchHeaders['If-None-Match'] = cachedEtag;

      // SSR endpoint returns raw HTML (text/html) + gzip: avoids JSON.parse overhead
      const res = await fetch(`/api/render?path=${encodeURIComponent(filePath)}&line=${scrollToLineNum || ''}`, {
        headers: fetchHeaders,
        signal: abortCtrl.signal
      });
      if (token !== state._openToken) return;

      if (res.status === 304) {
        // Server says content unchanged — use cached HTML
        const cachedHtml = cacheGet(filePath);
        if (cachedHtml) {
          if (token !== state._openToken) return;
          const el = $('markdownBody');
          setSanitizedHTML(el, cachedHtml);
          postProcessMarkdownDOM(el);
          const cachedMeta = renderCache.__meta ? renderCache.__meta.get(filePath) : {};
          renderContentHeader(filePath, cachedMeta || {});
          
          loading.style.display = 'none';
          wrapper.style.display = 'block';
          updateCachedLineAnchors(el);
          if (scrollToLineNum) {
            setTimeout(() => scrollToLine(scrollToLineNum, highlightQuery, searchMode), 80);
          } else {
            content.scrollTop = 0;
          }
          setTimeout(() => saveReadProgress(filePath), 350);
          const dispName = filePath.startsWith('dict:') ? filePath.slice(5).split('/').pop().replace(/\.md$/, '') : filePath.split('/').pop().replace(/\.md$/, '');
          document.title = `${(cachedMeta && cachedMeta.title) || dispName} — ${state.siteName}`;

          // Defer TOC generation & line-anchor indexing to idle time
          const scheduleIdle = window.requestIdleCallback || ((cb) => setTimeout(cb, 10));
          scheduleIdle(() => {
            if (token !== state._openToken) return;
            updateCachedLineAnchors(el);
            const headings = Array.from(el.querySelectorAll('h1, h2, h3, h4, h5, h6'));
            headings.forEach((h, i) => { if (!h.id) h.id = 'heading-' + i; });
            generateTOC(headings);
          });
          return;
        } else {
          // 304 Not Modified received, but item was evicted from LRU cache!
          if (renderCache.__etag) renderCache.__etag.delete(filePath);
          return openFile(filePath, scrollToLineNum, highlightQuery, searchMode);
        }
      }
      if (!res.ok) throw new Error('File not found');

      // res.text() is much faster than res.json() for large HTML payloads
      const [html, metaB64, etag] = await Promise.all([
        res.text(),
        Promise.resolve(res.headers.get('X-Document-Meta') || 'e30='),
        Promise.resolve(res.headers.get('ETag') || '')
      ]);
      if (token !== state._openToken) return;

      // Decode frontmatter from base64 header
      let frontmatter = {};
      // atob() decodes as Latin-1, not UTF-8 — use TextDecoder for correct Chinese character handling
      try {
        const bytes = Uint8Array.from(atob(metaB64), c => c.charCodeAt(0));
        frontmatter = JSON.parse(new TextDecoder('utf-8').decode(bytes));
      } catch (_) {}

      // Store metadata for cache restoration
      if (!renderCache.__meta) renderCache.__meta = new Map();
      if (!renderCache.__etag) renderCache.__etag = new Map();
      renderCache.__meta.set(filePath, frontmatter);
      if (etag) renderCache.__etag.set(filePath, etag);

      renderContentHeader(filePath, frontmatter);

      // Insert pre-rendered HTML
      const el = $('markdownBody');
      setSanitizedHTML(el, html);
      postProcessMarkdownDOM(el);

      // Cache for instant re-opens
      cacheSet(filePath, html);

      // Index line anchors immediately so scrollToLine finds them without waiting for idle
      updateCachedLineAnchors(el);

      // Reveal text immediately (FCP First)
      loading.style.display = 'none';
      wrapper.style.display = 'block';

      if (scrollToLineNum) {
        setTimeout(() => scrollToLine(scrollToLineNum, highlightQuery, searchMode), 80);
      } else {
        content.scrollTop = 0;
      }
      setTimeout(() => saveReadProgress(filePath), 350);

      const dispName = filePath.startsWith('dict:') ? filePath.slice(5).split('/').pop().replace(/\.md$/, '') : filePath.split('/').pop().replace(/\.md$/, '');
      document.title = `${frontmatter.title || dispName} — ${state.siteName}`;

      // Defer TOC generation & line-anchor indexing to idle time (non-blocking)
      const scheduleIdle = window.requestIdleCallback || ((cb) => setTimeout(cb, 10));
      scheduleIdle(() => {
        if (token !== state._openToken) return;
        updateCachedLineAnchors(el);
        const headings = Array.from(el.querySelectorAll('h1, h2, h3, h4, h5, h6'));
        headings.forEach((h, i) => { if (!h.id) h.id = 'heading-' + i; });
        generateTOC(headings);
      });
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.code === 20)) return;
      if (token !== state._openToken) return;
      headingTextMap.clear();
      cachedLineAnchors = [];
      loading.style.display = 'none';
      wrapper.style.display = 'block';
      $('markdownBody').innerHTML = `<div class="panel-placeholder"><span class="placeholder-icon">⚠️</span><span>載入失敗: ${escHtml(err.message)}</span></div>`;
      showToast('經文載入失敗：' + err.message, 'error');
    }
  }

  function parseFrontmatter(raw) {
    if (!raw || typeof raw !== 'string') return { frontmatter: {}, body: '' };
    if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) return { frontmatter: {}, body: raw };

    const startOffset = raw.startsWith('---\r\n') ? 5 : 4;
    const endIdx = raw.indexOf('\n---\n', startOffset);
    const endIdxAlt = raw.indexOf('\r\n---\r\n', startOffset);
    const actualEndIdx = endIdx !== -1 ? endIdx : endIdxAlt;

    if (actualEndIdx === -1) return { frontmatter: {}, body: raw };

    const fmRaw = raw.substring(startOffset, actualEndIdx);
    const bodyOffset = endIdx !== -1 ? actualEndIdx + 5 : actualEndIdx + 7;
    const body = raw.substring(bodyOffset);

    const fm = {};
    fmRaw.split('\n').forEach((line) => {
      const idx = line.indexOf(':');
      if (idx > 0) {
        const key = line.substring(0, idx).trim();
        let val = line.substring(idx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        fm[key] = val;
      }
    });

    return { frontmatter: fm, body };
  }

  function renderContentHeader(filePath, fm) {
    updateActiveFileUI(filePath, fm);
    const header = $('contentHeader');
    const displayPath = filePath.startsWith('dict:') ? filePath.slice(5) : filePath;
    const parts = displayPath.split('/');
    const fileName = parts.pop().replace(/\.md$/, '');
    const isDict = filePath.startsWith('dict:');

    // 麵包屑：主樹檔案的每一層都可點擊，在檔案樹中定位該資料夾／檔案（辭典不在主樹內）
    const crumbs = parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }));
    crumbs.push({ name: fileName, path: displayPath });
    const sep = '<span class="file-path-sep"> / </span>';
    const crumbHtml = crumbs.map(c => isDict
      ? `<span class="file-path-seg">${escHtml(c.name)}</span>`
      : `<span class="file-path-seg file-path-link" role="button" tabindex="0" data-reveal-path="${escHtml(c.path)}" title="在檔案樹中定位">${escHtml(c.name)}</span>`
    ).join(sep);

    let html = `<div class="file-path-row">`;
    html += `<div class="file-path">${crumbHtml}</div>`;
    html += `<button class="copy-link-btn" id="copyLinkBtn" title="複製連結">`;
    html += `<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M4.715 6.542L3.343 7.914a3 3 0 104.243 4.243l1.828-1.829A3 3 0 008.586 5.5L8 6.086a1 1 0 00-.154.199 2 2 0 01.861 3.337L6.88 11.45a2 2 0 11-2.83-2.83l.793-.792a4 4 0 01-.128-1.287zm5.57-1.084a3 3 0 10-4.243-4.243L4.214 3.043A3 3 0 007.407 10.5l.585-.585a1 1 0 00.154-.199 2 2 0 01-.861-3.337l1.827-1.828a2 2 0 112.83 2.83l-.793.792a4 4 0 01.128 1.287z"/></svg>`;
    html += `<span class="copy-link-label" id="copyLinkLabel">連結</span></button>`;
    html += `<button class="bookmark-btn" id="bookmarkBtn" title="加入/取消書籤">`;
    html += `<span class="bookmark-icon">🔖</span>`;
    html += `<span class="bookmark-label" id="bookmarkLabel">加書籤</span></button>`;
    html += `</div>`;

    if (fm.title) {
      html += `<div class="file-title">${escHtml(fm.title)}</div>`;
    }
    if (fm.date || fm.query_range) {
      const meta = [];
      if (fm.date) meta.push(fm.date);
      if (fm.query_range) meta.push(fm.query_range);
      html += `<div class="file-meta">${escHtml(meta.join(' · '))}</div>`;
    }
    header.innerHTML = html;

    header.querySelectorAll('.file-path-link').forEach((seg) => {
      const reveal = () => revealInFileTree(seg.getAttribute('data-reveal-path'));
      seg.addEventListener('click', reveal);
      seg.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); reveal(); }
      });
    });

    // Update bookmark button initial UI state
    updateBookmarkButtonUI(filePath);
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }


  async function renderMarkdown(body, cacheKey) {
    const el = $('markdownBody');

    // ── Check cache first: instant re-render for previously visited files ──
    const cached = cacheKey ? cacheGet(cacheKey) : null;
    let html;
    if (cached) {
      html = cached;
    } else {
      // Offload all heavy parsing to the Web Worker so main thread is never blocked.
      // Falls back to inline parsing if Worker fails (e.g., file:// protocol).
      try {
        html = await parseMarkdownInWorker(body);
      } catch (err) {
        console.warn('[renderMarkdown] Worker unavailable, falling back to inline parse:', err.message);
        html = inlineParseMarkdown(body);
      }
      if (cacheKey) cacheSet(cacheKey, html);
    }

    // Insert HTML into DOM
    setSanitizedHTML(el, html);
    postProcessMarkdownDOM(el);

    // Add IDs to headings for scroll spy
    const headings = el.querySelectorAll('h1, h2, h3, h4, h5, h6');
    headings.forEach((h, i) => {
      if (!h.id) h.id = 'heading-' + i;
    });
  }

  function preprocessObsidianFormatting(text) {
    if (!text) return '';
    // 1. Strip Obsidian comments: %% comment %% (single line & multi-line)
    if (text.includes('%%')) {
      text = text.replace(/%%[\s\S]*?%%/g, '');
    }
    // 2. Fix Obsidian bolding with inner spaces/NBSP: ** text ** -> <strong>text</strong>
    if (text.includes('**')) {
      text = text.replace(/\*\*([\s\u00A0]*[^\*\n]+?[\s\u00A0]*)\*\*/g, (m, p1) => {
        const trimmed = p1.trim().replace(/^[\s\u00A0]+|[\s\u00A0]+$/g, '');
        return '<strong>' + escHtml(trimmed) + '</strong>';
      });
    }
    // 3. Fix Obsidian double underscore bolding: __ text __ -> <strong>text</strong>
    if (text.includes('__')) {
      text = text.replace(/__([\s\u00A0]*[^_\n]+?[\s\u00A0]*)__/g, (m, p1) => {
        const trimmed = p1.trim().replace(/^[\s\u00A0]+|[\s\u00A0]+$/g, '');
        return '<strong>' + escHtml(trimmed) + '</strong>';
      });
    }
    return text;
  }

  // Inline fallback: runs on main thread (same logic as md-worker.js)
  // Client-side mirror of the server's HTML sanitizer. Used only by the legacy
  // inline-markdown fallback (renderMarkdown → inlineParseMarkdown), which is
  // currently unreachable but kept safe in case it is ever wired back up.
  function sanitizeDangerousTags(html) {
    if (!html) return '';
    return html
      // 1. Strip <script> entirely, including a bare/unclosed opening tag (in a
      //    real parser script-data state runs to EOF, so drop everything after it).
      .replace(/<script\b[^>]*>[\s\S]*?(?:<\/script\s*>|$)/gi, '')
      // 2. Strip a broad set of active/unsafe elements (opening + closing tags).
      //    Includes <svg>/<math> (mXSS vectors), <template>/<noscript>/<xmp>
      //    (parser-differential vectors) and <style>/<base>/<meta>/<link>/<form>
      //    which can exfiltrate or hijack the page.
      .replace(/<\/?(?:script|iframe|embed|object|frame|frameset|style|math|form|base|meta|link|svg|video|audio|source|applet|noscript|template|textarea|xmp|plaintext|noembed|noframes|portal|isindex|title)\b[^>]*>/gi, '')
      // 3. Strip inline event handlers regardless of what precedes `on*`. The
      //    original required whitespace, letting `<img/onerror=...>` (where `/`
      //    is a self-closing flag) slip through. `\b` also catches `data-on*`.
      .replace(/\bon[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '')
      // 4. srcdoc embeds a whole document; never allow it.
      .replace(/\bsrcdoc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '')
      // 5. Neutralize javascript:/vbscript:/data: pseudo-protocols in every
      //    URL-bearing attribute, decoding entities the way a browser would.
      .replace(/((?:xlink:)?href|src|action|formaction|poster|background|lowsrc|dynsrc|data|cite)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, (m, attr, val) => {
        const raw = /^["']/.test(val) ? val.slice(1, -1) : val;
        if (isDangerousUrl(raw, attr)) return attr + '="#"';
        return m;
      });
  }

  // Named character references a browser decodes inside attribute values that
  // matter for spelling a URL scheme. Numeric references are accepted with or
  // without the trailing ';', exactly as HTML parsers do.
  const URL_NAMED_ENTITIES = {
    colon: ':', tab: '\t', newline: '\n', lpar: '(', rpar: ')', sol: '/', bsol: '\\',
    period: '.', comma: ',', semi: ';', excl: '!', quest: '?', num: '#', percnt: '%',
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0'
  };

  function decodeUrlEntities(s) {
    return String(s)
      .replace(/&#x([0-9a-f]+);?/gi, (_, h) => { const c = parseInt(h, 16); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ''; })
      .replace(/&#([0-9]+);?/g, (_, d) => { const c = parseInt(d, 10); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ''; })
      .replace(/&([a-z]+);/gi, (m, name) => {
        const v = URL_NAMED_ENTITIES[name.toLowerCase()];
        return v !== undefined ? v : m;
      });
  }

  function isDangerousUrl(rawValue, attr) {
    // Browsers ignore leading C0 controls/spaces and strip tab/CR/LF anywhere in
    // a URL before reading the scheme, so `\x01java\tscript:` is javascript:.
    const compact = decodeUrlEntities(rawValue).replace(/[\u0000-\u0020\u007f-\u009f\u00a0\u200b-\u200d\u2028\u2029\ufeff]+/g, '').toLowerCase();
    if (/^(?:javascript|vbscript|livescript|mocha):/.test(compact)) return true;
    if (compact.startsWith('data:')) {
      // Inline raster images are fine as <img src>; any other data: URL can
      // carry an HTML/SVG document.
      const a = String(attr).toLowerCase();
      return !(a === 'src' && /^data:image\/(?:png|jpe?g|gif|webp|bmp);/.test(compact));
    }
    return false;
  }

  const CALLOUT_ICONS = {
    quote: '”', cite: '”',
    note: 'ℹ', info: 'ℹ', todo: '☑',
    abstract: '📋', summary: '📋', tldr: '📋',
    tip: '💡', hint: '💡', important: '💡',
    success: '✓', check: '✓', done: '✓',
    question: '?', help: '?', faq: '?',
    warning: '⚠️', caution: '⚠️', attention: '⚠️',
    failure: '✕', fail: '✕', missing: '✕',
    danger: '⚡', error: '⚡',
    bug: '🪲',
    example: '🧪'
  };

  function convertObsidianCallouts(html) {
    if (!html || !html.includes('[!')) return html;

    let prevHtml;
    let iterations = 0;

    do {
      prevHtml = html;
      html = html.replace(/<blockquote>\s*(?:<p>)?\s*(?:(<span[^>]*class="line-anchor"[^>]*><\/span>)\s*)?\[!([a-zA-Z0-9_-]+)\]([+-])?(?:[ \t]+([^\n<]+))?(?:<\/p>)?([\s\S]*?)<\/blockquote>/gi, (match, lineAnchor = '', rawType, foldSign, customTitle, bodyContent) => {
        const type = rawType.toLowerCase();
        const icon = CALLOUT_ICONS[type] || 'ℹ';

        let titleText = customTitle ? customTitle.trim() : (type.charAt(0).toUpperCase() + type.slice(1));
        titleText = titleText.replace(/<\/p>$/i, '').trim();
        titleText = escHtml(titleText);

        let cleanBody = bodyContent ? bodyContent.trim() : '';

        // Strip leading <br> tags, leading/trailing empty <p> tags, and redundant line-anchor wrappers
        cleanBody = cleanBody
          .replace(/^(?:\s*<br\s*\/?>\s*)+/gi, '')
          .replace(/^(?:\s*<p>\s*(?:<span[^>]*class="line-anchor"[^>]*><\/span>|<br\s*\/?>|\s*)*<\/p>\s*)+/gi, (m) => {
            const anchors = m.match(/<span[^>]*class="line-anchor"[^>]*><\/span>/g);
            return anchors ? anchors.join('') : '';
          })
          .replace(/(?:\s*<p>\s*(?:<span[^>]*class="line-anchor"[^>]*><\/span>|<br\s*\/?>|\s*)*<\/p>\s*)+$/gi, (m) => {
            const anchors = m.match(/<span[^>]*class="line-anchor"[^>]*><\/span>/g);
            return anchors ? anchors.join('') : '';
          })
          .replace(/<p>\s*(?:<span[^>]*class="line-anchor"[^>]*><\/span>|\s*)*<\/p>/gi, (m) => {
            const anchors = m.match(/<span[^>]*class="line-anchor"[^>]*><\/span>/g);
            return anchors ? anchors.join('') : '';
          })
          .trim()
          .replace(/^(?:\s*<br\s*\/?>\s*)+/gi, '');

        const isFoldable = foldSign === '+' || foldSign === '-';
        const isExpanded = foldSign === '+';

        if (isFoldable) {
          return `${lineAnchor}<details class="callout" data-callout="${type}"${isExpanded ? ' open' : ''}>
  <summary class="callout-title">
    <span class="callout-icon">${icon}</span>
    <span class="callout-title-inner">${titleText}</span>
    <span class="callout-fold-icon">›</span>
  </summary>
  <div class="callout-content">${cleanBody}</div>
</details>`;
        } else {
          return `${lineAnchor}<div class="callout" data-callout="${type}">
  <div class="callout-title">
    <span class="callout-icon">${icon}</span>
    <span class="callout-title-inner">${titleText}</span>
  </div>
  <div class="callout-content">${cleanBody}</div>
</div>`;
        }
      });
      iterations++;
    } while (html !== prevHtml && iterations < 5 && html.includes('[!'));

    return html;
  }

  function renderMath(container) {
    if (!container) return;
    const blocks = container.querySelectorAll('.math-block, .math-inline');
    if (blocks.length === 0) return;
    if (window.katex) {
      blocks.forEach(el => {
        if (el.dataset.katexRendered) return;
        const tex = el.getAttribute('data-math') || el.textContent.replace(/^\$+|\$+$/g, '').trim();
        const isDisplay = el.classList.contains('math-block');
        try {
          window.katex.render(tex, el, { displayMode: isDisplay, throwOnError: false });
          el.dataset.katexRendered = 'true';
        } catch (err) {
          console.warn('[KaTeX error]', err);
        }
      });
    }
  }

  // Mermaid 語法的圖表由 Pele（vendor/pele）渲染：同步回傳 SVG 字串，輸出不含
  // script / 事件處理器 / HTML 標籤。顏色走 CSS 變數（style.css 對應各主題），
  // 所以切換主題不必重畫。
  const MERMAID_MIN_SCALE = 0.75;

  function renderMermaid(container) {
    if (!container || !window.pele) return;
    const blocks = container.querySelectorAll('pre > code.language-mermaid');
    if (blocks.length === 0) return;
    blocks.forEach((codeEl, idx) => {
      if (codeEl.dataset.mermaidRendered) return;
      const pre = codeEl.closest('pre');
      if (!pre) return;
      const graphDefinition = codeEl.textContent.trim();
      if (!graphDefinition) return;
      codeEl.dataset.mermaidRendered = 'true';
      try {
        // idPrefix 讓同頁多張圖的 SVG 內部 id（marker、clipPath…）不互相衝突
        const { svg, width } = window.pele.render(graphDefinition, {
          idPrefix: 'pele-' + Date.now() + '-' + idx + '-'
        });
        const containerDiv = document.createElement('div');
        containerDiv.className = 'mermaid-container';
        containerDiv.innerHTML = svg;
        // 寬圖縮到容器寬時字會小到讀不了：最多縮到原寬的 MERMAID_MIN_SCALE，
        // 再寬就交給 .mermaid-container 橫向捲動
        const svgEl = containerDiv.firstElementChild;
        if (svgEl && width) svgEl.style.minWidth = Math.round(width * MERMAID_MIN_SCALE) + 'px';
        if (pre.parentNode) pre.parentNode.replaceChild(containerDiv, pre);
      } catch (err) {
        // 渲染失敗就保留原始程式碼區塊
        console.warn('[Pele render error]', err);
      }
    });
  }

  function postProcessMarkdownDOM(container) {
    if (!container) return;
    renderMath(container);
    renderMermaid(container);
  }

  // ── Rendered-Markdown sanitizer (DOM allowlist) ───────────────────────────
  // Every rendered document (server /api/render, chunked render, md-worker,
  // render cache) is inserted through setSanitizedHTML(). The server-side regex
  // filter stays as a first pass, but regexes cannot model how a browser parses
  // HTML (named entities such as `&colon;`, control characters in URLs, odd
  // attribute syntax). Here the browser's own parser builds an inert <template>
  // fragment, which is walked against an allowlist and then MOVED into the page
  // — never re-serialized — so there is no parse/serialize mismatch to exploit.
  const SANITIZE_DROP_TAGS = new Set([
    'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
    'svg', 'math', 'form', 'template', 'noscript', 'link', 'meta', 'base', 'title',
    'textarea', 'select', 'option', 'button', 'portal', 'video', 'audio', 'source',
    'track', 'canvas', 'dialog', 'slot', 'xmp', 'plaintext', 'noembed', 'noframes', 'head'
  ]);
  const SANITIZE_ALLOWED_TAGS = new Set([
    'a', 'abbr', 'b', 'bdi', 'bdo', 'blockquote', 'br', 'caption', 'center', 'cite', 'code',
    'col', 'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption',
    'figure', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'input', 'ins',
    'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'section',
    'small', 'span', 'strike', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td',
    'tfoot', 'th', 'thead', 'time', 'tr', 'tt', 'u', 'ul', 'var', 'wbr', 'article', 'aside',
    'header', 'footer', 'nav', 'main', 'hgroup', 'address'
  ]);
  const SANITIZE_GLOBAL_ATTRS = new Set(['id', 'class', 'title', 'lang', 'dir', 'style', 'role', 'align', 'valign']);
  const SANITIZE_TAG_ATTRS = {
    a: new Set(['href', 'target', 'rel']),
    img: new Set(['src', 'alt', 'width', 'height', 'loading']),
    td: new Set(['colspan', 'rowspan', 'width']),
    th: new Set(['colspan', 'rowspan', 'width', 'scope']),
    col: new Set(['span', 'width']),
    colgroup: new Set(['span', 'width']),
    ol: new Set(['start', 'type', 'reversed']),
    li: new Set(['value']),
    details: new Set(['open']),
    input: new Set(['type', 'checked', 'disabled']),
    font: new Set(['color', 'size']),
    time: new Set(['datetime']),
    q: new Set(['cite']),
    blockquote: new Set(['cite'])
  };
  const SANITIZE_SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
  const SANITIZE_DATA_IMAGE_RE = /^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,[a-z0-9+/=\s]+$/i;

  function isSafeUrl(value, attrName) {
    const v = String(value || '').trim();
    if (v === '' || v.startsWith('#')) return true;
    if (attrName === 'src' && SANITIZE_DATA_IMAGE_RE.test(v)) return true;
    let parsed;
    try { parsed = new URL(v, window.location.href); } catch (_) { return false; }
    // Same-origin relative URLs resolve to the page's own scheme.
    return SANITIZE_SAFE_PROTOCOLS.has(parsed.protocol);
  }

  function sanitizeElementAttributes(el, tag) {
    const tagAttrs = SANITIZE_TAG_ATTRS[tag];
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const allowed = SANITIZE_GLOBAL_ATTRS.has(name) ||
        (tagAttrs && tagAttrs.has(name)) ||
        (/^data-[a-z0-9_.-]+$/.test(name)) ||
        (/^aria-[a-z]+$/.test(name));
      if (!allowed) { el.removeAttribute(attr.name); continue; }
      if ((name === 'href' || name === 'src' || name === 'cite') && !isSafeUrl(attr.value, name)) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (name === 'style' && /expression\s*\(|url\s*\(|@import|behavior\s*:|-moz-binding/i.test(attr.value)) {
        el.removeAttribute(attr.name);
        continue;
      }
      // DOM clobbering: a document id must never shadow one of the app's own
      // elements (e.g. id="markdownBody"), which the UI looks up by id.
      if (name === 'id') {
        const existing = document.getElementById(attr.value);
        // Allowed only when the existing element is itself earlier rendered
        // document content (strictly inside the reader), never the reader
        // container or any other piece of the app shell.
        const reader = document.getElementById('markdownBody');
        const isPriorContent = existing && reader && existing !== reader && reader.contains(existing);
        if (existing && !isPriorContent) {
          el.removeAttribute(attr.name);
        }
      }
    }
    if (tag === 'input' && (el.getAttribute('type') || '').toLowerCase() !== 'checkbox') {
      return false; // only GFM task-list checkboxes
    }
    if (tag === 'input') el.setAttribute('disabled', '');
    if (tag === 'a' && el.getAttribute('target')) {
      el.setAttribute('rel', 'noopener noreferrer');
    }
    return true;
  }

  function sanitizeNodeTree(root) {
    // Snapshot children first: the loop mutates the tree.
    for (const node of Array.from(root.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) continue;
      if (node.nodeType !== Node.ELEMENT_NODE) {
        node.remove(); // comments, processing instructions, CDATA
        continue;
      }
      const tag = node.localName;
      if (SANITIZE_DROP_TAGS.has(tag) || node.namespaceURI !== 'http://www.w3.org/1999/xhtml') {
        node.remove();
        continue;
      }
      if (!SANITIZE_ALLOWED_TAGS.has(tag)) {
        // Unknown but harmless wrapper (e.g. <center>-like legacy tags,
        // custom elements): keep its text/children, drop the element itself.
        sanitizeNodeTree(node);
        node.replaceWith(...Array.from(node.childNodes));
        continue;
      }
      if (!sanitizeElementAttributes(node, tag)) {
        node.remove();
        continue;
      }
      sanitizeNodeTree(node);
    }
  }

  /** Parse untrusted HTML inertly and return a sanitized DocumentFragment. */
  function sanitizeRenderedHtml(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = String(html || '');
    const frag = tpl.content;
    sanitizeNodeTree(frag);
    return frag;
  }

  /** Replace el's content with sanitized HTML (no re-serialization). */
  function setSanitizedHTML(el, html) {
    if (!el) return;
    el.replaceChildren(sanitizeRenderedHtml(html));
  }
  window.__mdwSanitizeRenderedHtml = sanitizeRenderedHtml; // exposed for tests

  function inlineParseMarkdown(body) {
    if (!body) return '';
    body = preprocessObsidianFormatting(body);

    // ── 1. Extract footnote definitions (O(N) single pass) ────────
    const lines = body.split('\n');
    const cleanLines = [];
    const footnotes = [];
    let currentFootnote = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = line.match(/^\[\^([^\]]+)\]:\s*(.*)$/);
      if (match) {
        const id = match[1];
        const text = match[2];
        currentFootnote = { id, text: [text] };
        footnotes.push(currentFootnote);
      } else if (currentFootnote && (line.startsWith('    ') || line.startsWith('\t'))) {
        currentFootnote.text.push(line);
      } else if (currentFootnote && line.trim() === '') {
        currentFootnote.text.push(line);
      } else {
        if (currentFootnote) {
          while (currentFootnote.text.length > 1 && currentFootnote.text[currentFootnote.text.length - 1].trim() === '') {
            currentFootnote.text.pop();
          }
          currentFootnote = null;
        }
        cleanLines.push(line);
      }
    }

    // ── 2. Inject line-number anchors ────────────────────────────
    const annotatedLines = [];
    let inCodeBlock = false;
    let inRawHtmlTable = false;

    for (let i = 0; i < cleanLines.length; i++) {
      const line = cleanLines[i];
      const lineNum = i + 1;
      const trimmed = line.trim();

      // 1. Code blocks: do not inject anchors
      if (trimmed.startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        annotatedLines.push(line);
        continue;
      }
      if (inCodeBlock) {
        annotatedLines.push(line);
        continue;
      }

      // 2. Horizontal rules: leave clean so marked produces <hr>
      if (/^(?:[-*_]\s*){3,}$/.test(trimmed)) {
        annotatedLines.push(line);
        continue;
      }

      // 3. Blockquotes
      const isQuoteLine = /^>/.test(trimmed);
      if (isQuoteLine) {
        const quoteContent = line.replace(/^>\s?/, '');
        annotatedLines.push(`> <span id="L${lineNum}" data-line="${lineNum}" class="line-anchor"></span>${quoteContent}`);
        continue;
      }

      // 4. Heading: insert anchor inside the heading text
      const headingMatch = line.match(/^(#{1,6}\s+)(.*)$/);
      if (headingMatch) {
        annotatedLines.push(`${headingMatch[1]}<span id="L${lineNum}" data-line="${lineNum}" class="line-anchor"></span>${headingMatch[2]}`);
        continue;
      }

      // 5. List item: insert anchor inside the list item text
      const listMatch = line.match(/^(\s*(?:[-*+]|\d+\.)\s+)(.*)$/);
      if (listMatch) {
        annotatedLines.push(`${listMatch[1]}<span id="L${lineNum}" data-line="${lineNum}" class="line-anchor"></span>${listMatch[2]}`);
        continue;
      }

      // 6. GFM Markdown Table rows
      // Delimiter row: e.g. | --- | :---: | ---: | or |---|---|
      if (/^\|(?:\s*:?-+:?\s*\|)+\s*$/.test(trimmed)) {
        annotatedLines.push(line);
        continue;
      }
      // GFM Table row (starts and ends with |)
      if (/^\|(.+)\|$/.test(trimmed)) {
        const tableRowAnnotated = line.replace(/^(\s*\|\s*)(.*)$/, `$1<span id="L${lineNum}" data-line="${lineNum}" class="line-anchor"></span>$2`);
        annotatedLines.push(tableRowAnnotated);
        continue;
      }

      // 7. Raw HTML Tables
      if (/<table\b/i.test(trimmed)) inRawHtmlTable = true;
      if (/<\/table>/i.test(trimmed)) {
        inRawHtmlTable = false;
        annotatedLines.push(line);
        continue;
      }

      if (inRawHtmlTable) {
        // For <td> or <th>, insert anchor inside the cell tag
        if (/<(?:td|th)\b/i.test(line)) {
          const cellAnnotated = line.replace(/(<(?:td|th)\b[^>]*>)/i, `$1<span id="L${lineNum}" data-line="${lineNum}" class="line-anchor"></span>`);
          annotatedLines.push(cellAnnotated);
        } else {
          annotatedLines.push(line);
        }
        continue;
      }

      // 8. Other Raw HTML block tags (<div>, <details>, <section>, etc.)
      if (/^<\/?(?:div|details|summary|section|article|aside|header|footer|figure|figcaption|blockquote|pre|ul|ol|li|hr|p|style|script)\b/i.test(trimmed)) {
        annotatedLines.push(line);
        continue;
      }

      // 9. Regular line / paragraph start
      if (trimmed.length > 0) {
        annotatedLines.push(`<span id="L${lineNum}" data-line="${lineNum}" class="line-anchor"></span>${line}`);
      } else {
        annotatedLines.push(line);
      }
    }

    // ── 3. Parse main markdown body to HTML ─────────────────────
    const annotated = annotatedLines.join('\n');
    setScanGates(annotated); // must gate on the exact string passed to marked.parse
    let html = marked.parse(annotated);
    html = sanitizeDangerousTags(html);

    // ── 4. Convert Obsidian-style [[wikilinks]] on HTML output ────
    if (html.includes('[[')) {
      html = convertWikilinks(html);
    }

    // ── 4.5. Convert Obsidian Callouts ([!NOTE], [!WARNING], etc.) ────
    if (html.includes('[!')) {
      html = convertObsidianCallouts(html);
    }

    // ── 5. Process footnote references ──────────────────────────
    const refCounter = {};
    if (footnotes.length > 0) {
      html = html.replace(/\[\^([^\]]+)\]/g, (match, id) => {
        if (!refCounter[id]) refCounter[id] = 0;
        refCounter[id]++;
        const refId = `fn-ref-${id}-${refCounter[id]}`;
        return `<a href="#fn-def-${id}" id="${refId}" class="footnote-ref" title="註 ${id}">[${id}]</a>`;
      });

      // ── 6. Batch Process Footnotes (Single marked.parse Call) ──
      const FN_DELIM = '\n\n<!--FN_SPLIT_DELIMITER-->\n\n';
      const combinedFnText = footnotes.map(fn => fn.text.join('\n').trim()).join(FN_DELIM);
      setScanGates(combinedFnText); // same gates as the main body parse above
      let combinedFnHtml = marked.parse(combinedFnText).trim();
      combinedFnHtml = sanitizeDangerousTags(combinedFnHtml);
      if (combinedFnHtml.includes('[[')) {
        combinedFnHtml = convertWikilinks(combinedFnHtml);
      }
      if (combinedFnHtml.includes('[!')) {
        combinedFnHtml = convertObsidianCallouts(combinedFnHtml);
      }
      const fnRenderedArray = combinedFnHtml.split(/<!--FN_SPLIT_DELIMITER-->/i);

      let footnotesHtml = '<div class="footnotes"><hr class="footnotes-divider"><ul class="footnotes-list">';

      footnotes.forEach((fn, idx) => {
        const id = fn.id;
        let fnRendered = (fnRenderedArray[idx] || '').trim();

        let backlinksHtml = '';
        const count = refCounter[id] || 0;
        if (count === 1) {
          backlinksHtml = ` <a href="#fn-ref-${id}-1" class="footnote-backlink" title="返回">↩</a>`;
        } else if (count > 1) {
          backlinksHtml = ' ';
          for (let r = 1; r <= count; r++) {
            backlinksHtml += `<a href="#fn-ref-${id}-${r}" class="footnote-backlink" title="返回至第 ${r} 處">↩<sup>${r}</sup></a> `;
          }
        }

        if (fnRendered.includes('</p>')) {
          const lastIdx = fnRendered.lastIndexOf('</p>');
          fnRendered = fnRendered.substring(0, lastIdx) + backlinksHtml + fnRendered.substring(lastIdx);
        } else {
          fnRendered += backlinksHtml;
        }

        footnotesHtml += `<li class="footnote-item" id="fn-def-${id}" data-id="${id}">
            <span class="footnote-label">[${id}]</span>
            <div class="footnote-item-content">${fnRendered}</div>
          </li>`;
      });

      footnotesHtml += '</ul></div>';
      html += footnotesHtml;
    }

    return html;
  }

  // ═══════════════════════════════════════════════════════════
  // §7 OBSIDIAN WIKILINK SUPPORT
  // ═══════════════════════════════════════════════════════════

  /**
   * Name→path index for resolving wikilinks.
   * Built once on tree load; O(1) per link resolution.
   */
  const wikilinkIndex = new Map();

  function buildWikilinkIndex(treeNodes) {
    wikilinkIndex.clear();
    (function walk(nodes) {
      for (const node of nodes) {
        if (node.type === 'directory' && node.children) {
          walk(node.children);
        } else if (node.type === 'file') {
          // Bare file name (e.g. "大智度論釋記_卷21")
          const nameNoExt = node.name.replace(/\.md$/i, '').trim();
          wikilinkIndex.set(nameNoExt, node.path);
          wikilinkIndex.set(nameNoExt.toLowerCase(), node.path);

          // Full relative path without .md
          const pathNoExt = node.path.replace(/\.md$/i, '').trim();
          wikilinkIndex.set(pathNoExt, node.path);
          wikilinkIndex.set(pathNoExt.toLowerCase(), node.path);

          // Basename without .md
          const baseName = node.path.split('/').pop().replace(/\.md$/i, '').trim();
          wikilinkIndex.set(baseName, node.path);
          wikilinkIndex.set(baseName.toLowerCase(), node.path);
        }
      }
    })(treeNodes);
  }

  /**
   * Convert Obsidian [[wikilinks]] in HTML output to <a> tags.
   * Fast exit if no [[ found. Skips matches inside <code>...</code> or <pre>...</pre> tags.
   */
  function convertWikilinks(html) {
    if (!html || !html.includes('[[')) return html;
    return html.replace(/(<code[\s\S]*?<\/code>|<pre[\s\S]*?<\/pre>)|(?<!`)\[\[([^\]\n]+?)\]\]/gi, (match, codeBlock, inner) => {
      if (codeBlock) return codeBlock;
      if (!inner) return match;

      const pipeIdx = inner.indexOf('|');
      let target, display;
      if (pipeIdx !== -1) {
        target = inner.substring(0, pipeIdx).trim();
        display = inner.substring(pipeIdx + 1).trim();
      } else {
        target = inner.trim();
        display = target;
      }

      const hashIdx = target.indexOf('#');
      let file = target;
      let anchor = '';
      if (hashIdx !== -1) {
        file = target.substring(0, hashIdx).trim();
        anchor = target.substring(hashIdx).trim();
        if (pipeIdx === -1 && file === '' && display.startsWith('#')) {
          display = display.substring(1).trim();
        }
      }

      return `<a class="wikilink" data-wikilink-file="${escHtml(file)}" data-wikilink-anchor="${escHtml(anchor)}" href="#" title="${escHtml(target)}">${escHtml(display)}</a>`;
    });
  }

  /**
   * Handle click on a rendered wikilink: resolve file name → tree path, then openFile.
   */
  function handleWikilinkClick(linkEl) {
    let fileName = linkEl.getAttribute('data-wikilink-file') || '';
    const anchor = linkEl.getAttribute('data-wikilink-anchor') || '';

    fileName = fileName.trim().replace(/\.md$/i, '');

    // Case 1: Pure anchor link within current file (e.g. [[#heading]])
    if (!fileName && anchor) {
      scrollToHeadingByText(anchor.substring(1));
      return;
    }

    // Case 1b: dict-mode self-reference. Dictionary files link their own entries
    // as [[佛光辭典#【一切】|【一切】]], so while reading a `dict:` file resolve
    // those in-place via the virtual entry index instead of the vault tree —
    // which would resolve to nothing and drop the reader out of dict mode.
    if (state.currentFile && state.currentFile.startsWith('dict:')) {
      const currentDictName = state.currentFile.replace(/^dict:/, '').split('/').pop().replace(/\.md$/i, '');
      if (!fileName || fileName.toLowerCase() === currentDictName.toLowerCase()) {
        const target = anchor ? anchor.substring(1) : fileName;
        if (target) scrollToHeadingByText(target);
        return;
      }
    }

    // Resolve file name to tree path
    const filePath = wikilinkIndex.get(fileName) || wikilinkIndex.get(fileName.toLowerCase());

    // Case 2: Target file is the currently open document — do NOT reload the file!
    const isSameFile = (filePath && state.currentFile && (filePath === state.currentFile || filePath.endsWith('/' + state.currentFile))) ||
      (state.currentFile && fileName && fileName.toLowerCase() === state.currentFile.split('/').pop().replace(/\.md$/i, '').toLowerCase());

    if (isSameFile) {
      if (anchor) {
        scrollToHeadingByText(anchor.substring(1));
      }
      return;
    }

    if (!filePath) {
      console.warn(`[Wikilink] Could not resolve "${fileName}" — file not found in tree.`);
      showToast(`⚠️ 找不到目標檔案「${fileName}」`, 'warning');
      return;
    }

    // Case 3: Target is a DIFFERENT file
    openFile(filePath).then(() => {
      if (anchor) {
        setTimeout(() => scrollToHeadingByText(anchor.substring(1)), 150);
      }
    });
  }

  // ── O(1) Heading Text Map for Instant Link Navigation ──
  const headingTextMap = new Map();

  function buildHeadingMap(body) {
    headingTextMap.clear();
    if (!body) return;
    const headings = body.querySelectorAll('h1, h2, h3, h4, h5, h6');
    for (let i = 0; i < headings.length; i++) {
      const h = headings[i];
      if (!h.id) h.id = 'heading-' + i;

      // 以原文建表：wikilink 的錨點文字來自繁體原文，簡體顯示下 DOM 已是簡體
      const ds = window.mdDisplayScript;
      let rawText;
      if (ds && ds.isActive()) {
        rawText = ds.originalTextContent(h, el => el.classList && el.classList.contains('line-anchor')).trim();
      } else {
        const clone = h.cloneNode(true);
        clone.querySelectorAll('.line-anchor').forEach(el => el.remove());
        rawText = clone.textContent.trim();
      }
      const cleanText = rawText.replace(/^【/, '').replace(/】$/, '').trim();

      if (rawText && !headingTextMap.has(rawText)) {
        headingTextMap.set(rawText, h);
      }
      if (cleanText && !headingTextMap.has(cleanText)) {
        headingTextMap.set(cleanText, h);
      }
      if (h.id && !headingTextMap.has(h.id)) {
        headingTextMap.set(h.id, h);
      }
    }
  }

  /**
   * Scroll to a heading whose ID or text matches the anchor text.
   * O(1) Instant Map Lookup replacing expensive N-node DOM scans.
   */
  function scrollToHeadingByText(text) {
    if (!text) return;
    const targetText = decodeURIComponent(text).trim();
    if (!targetText) return;

    if (isVirtualMode()) {
      const v = state.virtual;
      const cleanText = targetText.replace(/^【/, '').replace(/】$/, '').trim();
      let ei = v.headwordMap.get(targetText);
      if (ei == null) ei = v.entryMap.get(cleanText);
      if (ei == null) {
        for (const [key, idx] of v.entryMap) {
          if (key.includes(cleanText) || (cleanText.length > 1 && cleanText.includes(key))) {
            ei = idx; break;
          }
        }
      }
      if (ei != null) {
        jumpToEntry(ei);
      } else {
        console.warn(`[Wikilink] Heading "${targetText}" not found in virtual index.`);
        showToast(`⚠️ 找不到章節「${targetText}」`, 'warning');
      }
      return;
    }

    const body = $('markdownBody');
    if (!body) return;

    // Populate O(1) Map index if empty
    if (headingTextMap.size === 0) {
      buildHeadingMap(body);
    }

    const cleanText = targetText.replace(/^【/, '').replace(/】$/, '').trim();

    // 1. O(1) Instant Map & ID Lookup
    let targetEl = headingTextMap.get(targetText) ||
                   headingTextMap.get(cleanText) ||
                   document.getElementById(targetText) ||
                   document.getElementById(encodeURIComponent(targetText));

    // 2. Fallback to fuzzy substring match if exact key missed
    if (!targetEl) {
      for (const [key, el] of headingTextMap.entries()) {
        if (key.includes(cleanText) || (cleanText.length > 1 && cleanText.includes(key))) {
          targetEl = el;
          break;
        }
      }
    }

    if (targetEl) {
      safeScrollToElement(targetEl, $('content'), 'start');
      targetEl.classList.add('highlight-flash');
      setTimeout(() => targetEl.classList.remove('highlight-flash'), 2000);
    } else {
      console.warn(`[Wikilink] Heading "${targetText}" not found in document.`);
      showToast(`⚠️ 找不到章節「${targetText}」`, 'warning');
    }
  }

  // ═══════════════════════════════════════════════════════════
  // §8 TABLE OF CONTENTS (TOC & ScrollSpy)
  // ═══════════════════════════════════════════════════════════

  function generateTOC(headings) {
    const tocList = $('tocList');
    headings = headings || $$('h1, h2, h3, h4, h5, h6', $('markdownBody'));

    // Filter valid headings & extract clean text (stripping .line-anchor spans)
    const validItems = [];
    headings.forEach((h, idx) => {
      if (!h.id) h.id = 'heading-' + idx;
      const clone = h.cloneNode(true);
      clone.querySelectorAll('.line-anchor').forEach(el => el.remove());
      const rawText = clone.textContent.trim();
      const text = cleanHeadingText(rawText);
      if (text) {
        validItems.push({ h, text, level: parseInt(h.tagName.charAt(1)) || 1 });
      }
    });

    if (validItems.length === 0) {
      tocList.innerHTML = '<div class="panel-placeholder"><span class="placeholder-icon">📑</span><span>此文件沒有標題</span></div>';
      return;
    }

    tocList.innerHTML = '';

    let minLevel = 6;
    for (let i = 0; i < validItems.length; i++) {
      if (validItems[i].level < minLevel) {
        minLevel = validItems[i].level;
        if (minLevel === 1) break;
      }
    }
    const fragment = document.createDocumentFragment();
    const rows = [];

    validItems.forEach((itemObj, idx) => {
      const { h, text, level } = itemObj;

      const row = document.createElement('div');
      row.className = 'toc-item-row';
      row.setAttribute('data-level', level);
      row.setAttribute('data-target', h.id);
      row.setAttribute('data-index', idx);

      // Indent level matching Obsidian (16px per depth)
      const depth = level - minLevel;
      const indent = depth * 16 + 8;
      row.style.paddingLeft = `${indent}px`;

      if (depth > 0) {
        row.classList.add('is-nested');
        row.style.setProperty('--guide-left', `${indent - 10}px`);
      }

      const chevron = document.createElement('span');
      chevron.className = 'toc-item-chevron empty';
      chevron.textContent = '▾';

      const label = document.createElement('span');
      label.className = 'toc-item-label';
      label.textContent = text;
      label.title = text;

      row.appendChild(chevron);
      row.appendChild(label);

      // Dedicated click handler on chevron to prevent mis-clicks triggering page jump
      chevron.addEventListener('click', (e) => {
        e.stopPropagation();
        if (chevron.classList.contains('empty')) return;
        const isCollapsed = row.classList.toggle('collapsed');
        chevron.title = isCollapsed ? '展開' : '摺疊';
        toggleSubtreeVisibility(rows, idx, isCollapsed);
        syncTocCollapseBtnState();
        if (state.refreshScrollSpy) {
          state.refreshScrollSpy(false);
        }
      });

      row.addEventListener('click', () => {
        safeScrollToElement(h, $('content'), 'start');
        // Immediate visual active feedback
        rows.forEach(r => r.classList.remove('active'));
        row.classList.add('active');
        if (isMobileBrowser() || window.innerWidth <= 768) {
          closeMobileSidebars();
        }
      });

      fragment.appendChild(row);
      rows.push(row);
    });

    // Determine parent chevrons
    for (let i = 0; i < rows.length; i++) {
      const curLevel = parseInt(rows[i].getAttribute('data-level'));
      const nextRow = rows[i + 1];
      if (nextRow && parseInt(nextRow.getAttribute('data-level')) > curLevel) {
        const chev = rows[i].querySelector('.toc-item-chevron');
        chev.classList.remove('empty');
        chev.title = '摺疊';
      }
    }

    tocList.appendChild(fragment);
    applyStandardTocFilter();
    syncTocCollapseBtnState();
    setupScrollSpy(validItems.map(item => item.h));
  }

  function resetTocFilterUI() {
    state.tocFilter = '';
    const input = $('tocFilterInput');
    if (input && input.value !== '') input.value = '';
    const clearBtn = $('tocFilterClear');
    if (clearBtn) clearBtn.hidden = true;
  }

  function applyStandardTocFilter() {
    const tocList = $('tocList');
    if (!tocList || isVirtualMode()) return;
    const rows = Array.from($$('.toc-item-row', tocList));
    const oldEmpty = $('tocFilterEmpty');
    if (oldEmpty) oldEmpty.remove();
    if (rows.length === 0) return;

    const terms = parseSidebarFilterTerms(state.tocFilter);
    if (terms.length === 0) {
      // 還原依階層收折狀態決定的可見性
      let hideBelowLevel = Infinity;
      for (let i = 0; i < rows.length; i++) {
        const curLevel = parseInt(rows[i].getAttribute('data-level'), 10) || 1;
        if (curLevel > hideBelowLevel) {
          rows[i].classList.add('is-hidden');
        } else {
          rows[i].classList.remove('is-hidden');
          if (rows[i].classList.contains('collapsed')) {
            hideBelowLevel = curLevel;
          } else {
            hideBelowLevel = Infinity;
          }
        }
      }
      return;
    }

    let matchCount = 0;
    const ds = window.mdDisplayScript;
    for (let i = 0; i < rows.length; i++) {
      const labelEl = rows[i].querySelector('.toc-item-label');
      const text = (ds && ds.isActive() && labelEl)
        ? ds.originalTextContent(labelEl)
        : (labelEl ? labelEl.textContent : rows[i].textContent);
      if (matchesSidebarFilter(text || '', terms)) {
        rows[i].classList.remove('is-hidden');
        matchCount++;
      } else {
        rows[i].classList.add('is-hidden');
      }
    }

    if (matchCount === 0) {
      const empty = document.createElement('div');
      empty.id = 'tocFilterEmpty';
      empty.className = 'panel-placeholder';
      empty.innerHTML = `<span class="placeholder-icon">📑</span><span>沒有符合「${escHtml(state.tocFilter.trim())}」的標題</span>`;
      tocList.appendChild(empty);
    }
  }

  function applyTocFilter(rawQuery) {
    const val = rawQuery == null ? '' : String(rawQuery);
    state.tocFilter = val;
    const input = $('tocFilterInput');
    if (input && input.value !== val) input.value = val;
    const clearBtn = $('tocFilterClear');
    if (clearBtn) clearBtn.hidden = !val.trim();

    const tocList = $('tocList');
    if (isVirtualMode() && state.virtual) {
      const v = state.virtual;
      buildVirtualTocItems(v);
      v._tocRenderedStart = -1;
      v._tocRenderedEnd = -1;
      if (tocList) tocList.scrollTop = 0;
      renderTocWindow();
      syncTocCollapseBtnState();
      if (!val.trim()) {
        updateVirtualScrollSpy(estimateLineFromScrollTop());
      }
      return;
    }

    applyStandardTocFilter();
    if (tocList) tocList.scrollTop = 0;
    syncTocCollapseBtnState();
    if (!val.trim() && state.refreshScrollSpy) {
      state.refreshScrollSpy(false);
    }
  }

  function toggleSubtreeVisibility(rows, parentIdx, isCollapsed) {
    const parentLevel = parseInt(rows[parentIdx].getAttribute('data-level'));
    let hideBelowLevel = isCollapsed ? parentLevel : Infinity;

    for (let i = parentIdx + 1; i < rows.length; i++) {
      const curLevel = parseInt(rows[i].getAttribute('data-level'));
      if (curLevel <= parentLevel) break; // Exited the subtree

      if (curLevel > hideBelowLevel) {
        rows[i].classList.add('is-hidden');
      } else {
        rows[i].classList.remove('is-hidden');
        if (rows[i].classList.contains('collapsed')) {
          hideBelowLevel = curLevel;
        } else {
          hideBelowLevel = Infinity;
        }
      }
    }
  }

  function syncTocCollapseBtnState() {
    const btn = $('tocCollapseAllBtn');
    if (!btn) return;
    if (isVirtualMode()) {
      const v = state.virtual;
      const isExpanded = !v || !v._collapsedEntries || v._collapsedEntries.size === 0;
      updateCollapseBtnUI(btn, isExpanded);
    } else {
      const rows = $$('.toc-item-row', $('tocList'));
      const anyCollapsed = Array.from(rows).some(el => el.classList.contains('collapsed'));
      updateCollapseBtnUI(btn, !anyCollapsed);
    }
  }

  function tocCollapseAll() {
    const btn = $('tocCollapseAllBtn');
    if (isVirtualMode()) {
      const v = state.virtual;
      if (!v || !v.entries || v.entries.length === 0) return;
      v._collapsedEntries = v._collapsedEntries || new Set();
      if (v._collapsedEntries.size > 0) {
        // Expand all
        v._collapsedEntries.clear();
      } else {
        // Collapse all parents with children
        for (let i = 0; i < v.entries.length; i++) {
          const curLevel = v.entries[i].level || 1;
          const nextLevel = (i + 1 < v.entries.length) ? (v.entries[i + 1].level || 1) : 1;
          if (nextLevel > curLevel) {
            v._collapsedEntries.add(i);
          }
        }
      }
      buildVirtualTocItems(v);
      v._tocRenderedStart = -1;
      v._tocRenderedEnd = -1;
      renderTocWindow();
      syncTocCollapseBtnState();
      updateVirtualScrollSpy(estimateLineFromScrollTop());
      return;
    }

    const rows = $$('.toc-item-row', $('tocList'));
    if (rows.length === 0) return;

    const anyCollapsed = Array.from(rows).some(el => el.classList.contains('collapsed'));

    if (anyCollapsed) {
      // Expand all
      rows.forEach(r => {
        r.classList.remove('collapsed');
        r.classList.remove('is-hidden');
        const chev = r.querySelector('.toc-item-chevron');
        if (chev && !chev.classList.contains('empty')) {
          chev.title = '摺疊';
        }
      });
    } else {
      // Collapse all parents while preserving tree hierarchy
      let minLevel = 6;
      rows.forEach(r => {
        const lvl = parseInt(r.getAttribute('data-level'), 10) || 1;
        if (lvl < minLevel) minLevel = lvl;
      });
      rows.forEach((r, i) => {
        const chev = r.querySelector('.toc-item-chevron');
        const hasChildren = chev && !chev.classList.contains('empty');
        if (hasChildren) {
          r.classList.add('collapsed');
          chev.title = '展開';
        }
        const level = parseInt(r.getAttribute('data-level'));
        if (level > minLevel) {
          r.classList.add('is-hidden');
        } else {
          r.classList.remove('is-hidden');
        }
      });
    }
    if (state.tocFilter && state.tocFilter.trim()) {
      applyStandardTocFilter();
    }
    syncTocCollapseBtnState();
    if (state.refreshScrollSpy) {
      state.refreshScrollSpy(false);
    }
  }

  function setupScrollSpy(headings) {
    disconnectScrollSpy();

    const tocList = $('tocList');
    const tocItems = Array.from($$('.toc-item-row', tocList));
    if (tocItems.length === 0) return;

    const content = $('content');
    if (!content) return;

    headings = headings || Array.from($$('h1, h2, h3, h4, h5, h6', $('markdownBody')));
    const validHeadings = headings.filter(h => h && h.isConnected);
    if (validHeadings.length === 0) return;

    const tocMap = new Map();
    tocItems.forEach((item) => {
      const target = item.getAttribute('data-target');
      if (target) tocMap.set(target, item);
    });

    let currentActiveTarget = null;
    let scrollIntoViewTimeout = null;

    function findVisibleRow(row) {
      if (!row || !row.classList.contains('is-hidden')) return row;
      const level = parseInt(row.getAttribute('data-level')) || 1;
      const idx = parseInt(row.getAttribute('data-index')) || 0;
      let targetLevel = level;
      for (let i = idx - 1; i >= 0; i--) {
        const curLevel = parseInt(tocItems[i].getAttribute('data-level')) || 1;
        if (curLevel < targetLevel) {
          targetLevel = curLevel;
          if (!tocItems[i].classList.contains('is-hidden')) {
            return tocItems[i];
          }
        }
      }
      return row;
    }

    function updateActiveHeading(forceScroll = false) {
      if (isVirtualMode()) return;
      if (!headings || validHeadings.length === 0) return;

      const contentRect = content.getBoundingClientRect();
      const contentScrollTop = content.scrollTop;
      const isAtBottom = contentScrollTop + content.clientHeight >= content.scrollHeight - 20;

      let activeH = null;

      if (isAtBottom) {
        // At bottom of page, activate last heading
        activeH = validHeadings[validHeadings.length - 1];
      } else {
        // Find the last heading whose top edge is <= reading offset line (70px below content top)
        const readingLine = 70;
        for (let i = 0; i < validHeadings.length; i++) {
          const h = validHeadings[i];
          const rect = h.getBoundingClientRect();
          const topRel = rect.top - contentRect.top;
          if (topRel <= readingLine) {
            activeH = h;
          } else {
            break;
          }
        }
        // If before the first heading, but near top of document (scrollTop < 120), activate first heading
        if (!activeH && contentScrollTop < 120 && validHeadings.length > 0) {
          activeH = validHeadings[0];
        }
      }

      const activeTargetId = activeH ? activeH.id : null;
      if (!activeTargetId) return;

      const targetRow = tocMap.get(activeTargetId);
      if (!targetRow) return;

      const visibleRow = findVisibleRow(targetRow);

      if (currentActiveTarget !== activeTargetId || forceScroll) {
        currentActiveTarget = activeTargetId;

        // Remove active from all rows
        tocItems.forEach(r => r.classList.remove('active'));

        if (visibleRow) {
          visibleRow.classList.add('active');

          if (isTocPanelVisible()) {
            if (scrollIntoViewTimeout) clearTimeout(scrollIntoViewTimeout);
            scrollIntoViewTimeout = setTimeout(() => {
              visibleRow.scrollIntoView({ block: 'nearest', behavior: 'auto' });
            }, forceScroll ? 10 : 50);
          }
        }
      } else if (visibleRow && !visibleRow.classList.contains('active')) {
        tocItems.forEach(r => r.classList.remove('active'));
        visibleRow.classList.add('active');
      }
    }

    let rafPending = false;
    const scrollHandler = () => {
      if (rafPending) return;
      rafPending = true;
      state.scrollSpyRaf = requestAnimationFrame(() => {
        rafPending = false;
        state.scrollSpyRaf = null;
        updateActiveHeading(false);
      });
    };

    content.addEventListener('scroll', scrollHandler, { passive: true });
    window.addEventListener('resize', scrollHandler, { passive: true });
    state.scrollSpyHandler = scrollHandler;
    state.scrollSpyResizeHandler = scrollHandler;
    state.refreshScrollSpy = (forceScroll) => updateActiveHeading(forceScroll);

    // Initial check on load
    updateActiveHeading(false);
  }

  // ═══════════════════════════════════════════════════════════
  // §9 GLOBAL SEARCH (Bigram Full-Text & Filename Search)
  // ═══════════════════════════════════════════════════════════

  /**
   * 切換全文搜尋比對模式（寬鬆／精確）。搜尋面板的 ≈／= 按鈕與偏好設定的
   * 「寬鬆比對」開關都經由這裡，兩邊保持同步。
   * @param {'loose'|'strict'} mode
   * @param {{rerun?: boolean}} [opts] - rerun 預設 true：有上次搜尋時以新模式重搜
   */
  function setSearchMode(mode, opts = {}) {
    if (mode !== 'loose' && mode !== 'strict') return;
    const changed = state.searchMode !== mode;
    state.searchMode = mode;
    storage.set(STORAGE_KEYS.SEARCH_MODE, mode);
    updateSearchModeUI();
    if (!changed || opts.rerun === false || !state.lastSearchData) return;
    const inputVal = $('globalSearchInput') ? $('globalSearchInput').value.trim() : '';
    const q = inputVal || state.lastSearchData.query || '';
    if (q) performGlobalSearch(q);
  }

  function updateSearchModeUI() {
    const isLoose = state.searchMode === 'loose';
    const looseChk = $('settingLooseSearchCheck');
    if (looseChk) looseChk.checked = isLoose;
    const searchModeBtn = $('searchModeBtn');
    if (!searchModeBtn) return;
    searchModeBtn.classList.toggle('active', isLoose);
    searchModeBtn.setAttribute('aria-pressed', isLoose ? 'true' : 'false');
    searchModeBtn.setAttribute('title', isLoose
      ? '寬鬆比對：已忽略標點與換行（點擊切換為精確模式）'
      : '精確比對：完全符合原始文字（點擊切換為寬鬆模式）');
    searchModeBtn.setAttribute('aria-label', isLoose ? '寬鬆搜尋模式（忽略標點與換行）' : '精確搜尋模式（字面完全比對）');
    searchModeBtn.innerHTML = isLoose
      ? `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6c1.8-2 3.8-2 5.5 0s3.8 2 5.5 0"/><path d="M2.5 10c1.8-2 3.8-2 5.5 0s3.8 2 5.5 0"/></svg>`
      : `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 6h9"/><path d="M3.5 10h9"/></svg>`;
  }

  let searchAbortController = null;

  /**
   * 打開側邊欄的「全文搜尋」分頁、帶入關鍵字並執行搜尋。
   *
   * 抽成函式是因為這個流程有三個入口：網址列的 ?search=、右鍵選單的
   * 「全文庫搜尋」，以及瀏覽器上一頁／下一頁。原本只有右鍵選單那條路徑
   * 手寫了這一整段（展開側邊欄 → 切分頁 → 填入 → 搜尋），重複實作必然
   * 走鐘，故集中於此。
   *
   * @param {string} query 要搜尋的關鍵字
   */
  /**
   * @param {string} query
   */
  function activateSearchPanel(query) {
    const q = (query || '').trim();
    if (!q) return;

    // 展開側邊欄（行動版另需處理辭典側欄與遮罩）
    const sidebar = $('sidebar');
    if (sidebar && sidebar.classList.contains('collapsed')) {
      sidebar.classList.remove('collapsed');
      state.sidebarCollapsed = false;
    }
    if (isMobileBrowser() || window.innerWidth <= 768) {
      if (state.dictSidebarOpen) toggleDictSidebar(false);
    }
    updateSidebarBackdrop();

    // 切到搜尋分頁
    $$('.sidebar-tab').forEach((t) => t.classList.remove('active'));
    const searchTab = document.querySelector('.sidebar-tab[data-tab="search"]');
    if (searchTab) searchTab.classList.add('active');

    $$('.sidebar-panel').forEach((p) => p.classList.remove('active'));
    const searchPanel = document.querySelector('.sidebar-panel[data-panel="search"]');
    if (searchPanel) searchPanel.classList.add('active');
    state.sidebarTab = 'search';

    // 填入原文並執行；簡繁字組比對由伺服器處理，輸入框內容保持不變。
    const searchInput = $('globalSearchInput');
    if (searchInput) searchInput.value = q;
    performGlobalSearch(q);

    // 同步網址，讓右鍵搜尋的結果也能直接分享或加書籤；已是同一組參數時
    // 不重複推入歷史，避免返回鍵要按兩次才離開。
    // 注意：window.location.search 不含 pathname，故比對時不可混入 "/"。
    const desired = `?search=${encodeURIComponent(q)}`;
    if (safeDecodeURIComponent(window.location.search) !== safeDecodeURIComponent(desired)) {
      history.pushState(null, '', window.location.pathname + desired);
    }
  }

  async function performGlobalSearch(query) {
    if (!query || query.trim().length === 0) {
      if (searchAbortController) {
        searchAbortController.abort();
        searchAbortController = null;
      }
      state.lastSearchData = null;
      $('searchResults').innerHTML = '<div class="panel-placeholder"><span class="placeholder-icon">🔍</span><span>輸入關鍵詞開始搜尋</span></div>';
      return;
    }

    let folder = $('searchFolderSelect') ? $('searchFolderSelect').value : '';

    if (folder === '__CURRENT_FILE__') {
      if (!state.currentFile) {
        if (searchAbortController) {
          searchAbortController.abort();
          searchAbortController = null;
        }
        state.lastSearchData = null;
        $('searchResults').innerHTML = '<div class="panel-placeholder"><span class="placeholder-icon">📄</span><span>目前尚未開啟任何經文檔案</span></div>';
        return;
      }
      folder = state.currentFile;
    }

    if (searchAbortController) searchAbortController.abort();
    searchAbortController = new AbortController();

    $('searchResults').innerHTML = '<div class="search-loading"><div class="spinner"></div><span>搜尋中…</span></div>';

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&folder=${encodeURIComponent(folder)}&variants=${variantsParam()}&mode=${state.searchMode}`, {
        signal: searchAbortController.signal,
      });
      if (!res.ok) throw new Error('Search failed');
      const data = await res.json();
      renderSearchResults(data);
    } catch (err) {
      if (err.name === 'AbortError') return;
      $('searchResults').innerHTML = `<div class="panel-placeholder"><span class="placeholder-icon">⚠️</span><span>搜尋失敗: ${escHtml(err.message)}</span></div>`;
      showToast('搜尋失敗：' + err.message, 'error');
    }
  }

  function renderSearchResults(data) {
    const container = $('searchResults');
    state.lastSearchData = data;
    state.searchRenderLimit = SEARCH_RENDER_BATCH;

    if (data.mode === 'loose' && Array.isArray(data.terms) && data.terms.length === 0) {
      container.innerHTML = '<div class="panel-placeholder"><span class="placeholder-icon">🔍</span><span>查詢只包含標點符號</span></div>';
      return;
    }

    if (data.results.length === 0) {
      container.innerHTML = '<div class="panel-placeholder"><span class="placeholder-icon">🔍</span><span>沒有找到結果</span></div>';
      return;
    }

    renderSearchResultsPortion(container, data);
  }

  function renderSearchResultsPortion(container, data) {
    const limit = state.searchRenderLimit || SEARCH_RENDER_BATCH;
    // Preserve scroll position across "顯示更多" (innerHTML resets scrollTop; the
    // items above the viewport are identical, so restoring keeps the user in place).
    const prevScrollTop = container.scrollTop;
    const parts = [`<div class="search-status">找到 ${data.total} 個結果${data.capped ? '（已達上限）' : ''}</div>`];

    // Group by file
    const groups = {};
    data.results.forEach((r) => {
      if (!groups[r.file]) groups[r.file] = { fileName: r.fileName, items: [] };
      groups[r.file].items.push(r);
    });

    // Apply sort
    let sortedGroups = Object.entries(groups);
    switch (state.searchSort) {
      case 'file-asc':
        sortedGroups.sort(([, a], [, b]) => a.fileName.localeCompare(b.fileName, 'zh-TW', { numeric: true }));
        break;
      case 'file-desc':
        sortedGroups.sort(([, a], [, b]) => b.fileName.localeCompare(a.fileName, 'zh-TW', { numeric: true }));
        break;
      case 'count-desc':
        sortedGroups.sort(([, a], [, b]) => b.items.length - a.items.length);
        break;
      case 'relevance':
      default:
        // Keep original order (server already sorted by relevance)
        break;
    }

    const rawQuery = data.query || '';
    const isLoose = data.mode === 'loose';
    const terms = (isLoose && Array.isArray(data.terms) && data.terms.length > 0)
      ? data.terms
      : rawQuery.trim().split(/\s+/).filter(Boolean);
    // Match against the RAW snippet (highlightSearchTerm escapes afterwards);
    // matching escaped HTML let terms like "amp" split "&amp;" apart.
    const variants = !!data.variants;
    const escapedTerms = terms.filter(Boolean).map(t => termRegexSource(t, variants));
    const precompiledRegex = (!isLoose && escapedTerms.length > 0) ? new RegExp(`(${escapedTerms.join('|')})`, 'gi') : null;

    let rendered = 0;
    outer:
    for (const [file, group] of sortedGroups) {
      if (rendered >= limit) break;
      parts.push(`<div class="search-result-group">`);
      parts.push(`<div class="search-result-file" data-file-group="${escHtml(file)}">`);
      parts.push(`<span class="search-result-file-chevron expanded">›</span>`);
      parts.push(`<span class="search-result-file-icon">📄</span>${escHtml(group.fileName)}`);
      parts.push(`<span class="search-result-count">${group.items.length}</span></div>`);
      parts.push(`<div class="search-result-group-body">`);
      for (const item of group.items) {
        if (rendered >= limit) {
          parts.push(`</div></div>`);
          break outer;
        }
        const snippet = isLoose
          ? highlightLooseSnippet(item.snippet, terms, variants)
          : highlightSearchTerm(item.snippet, precompiledRegex);
        const headwordTag = item.headword
          ? `<span class="search-result-headword">${escHtml(item.headword)}</span>`
          : '';
        const entryAttr = (item.entryIndex !== undefined && item.entryIndex !== null && item.entryIndex >= 0)
          ? ` data-entry="${escHtml(item.entryIndex)}"` : '';
        parts.push(`
          <div class="search-result-item" data-file="${escHtml(item.file)}" data-line="${escHtml(item.line)}"${entryAttr}>
            <span class="search-result-line">第 ${item.line} 行</span>
            ${headwordTag}
            <span class="search-result-snippet">${snippet}</span>
          </div>`);
        rendered++;
      }
      parts.push(`</div></div>`);
    }

    const remaining = data.results.length - rendered;
    if (remaining > 0) {
      parts.push(`<button class="search-load-more" data-action="load-more">顯示更多（還有 ${remaining} 筆）</button>`);
    }

    container.innerHTML = parts.join('');
    if (prevScrollTop > 0) container.scrollTop = prevScrollTop;
  }

  function searchCollapseAll() {
    const btn = $('searchCollapseAllBtn');
    const bodies = $$('.search-result-group-body', $('searchResults'));
    const anyExpanded = Array.from(bodies).some(el => !el.classList.contains('collapsed'));

    if (anyExpanded) {
      // Collapse all
      bodies.forEach(el => el.classList.add('collapsed'));
      $$('.search-result-file-chevron', $('searchResults')).forEach(el => el.classList.add('collapsed'));
      updateCollapseBtnUI(btn, false);
    } else {
      // Expand all
      bodies.forEach(el => el.classList.remove('collapsed'));
      $$('.search-result-file-chevron', $('searchResults')).forEach(el => el.classList.remove('collapsed'));
      updateCollapseBtnUI(btn, true);
    }
  }

  function highlightSearchTerm(text, compiledRegexOrQuery, variants) {
    const raw = text == null ? '' : String(text);
    if (!compiledRegexOrQuery) return escHtml(raw);

    let regex;
    if (compiledRegexOrQuery instanceof RegExp) {
      regex = compiledRegexOrQuery;
    } else {
      regex = new RegExp(`(${termRegexSource(String(compiledRegexOrQuery), variants)})`, 'gi');
    }
    // Split the raw text on the (single capturing group) regex: odd indices are
    // matches. Each segment is escaped on its own, so a match can never land
    // inside an HTML entity produced by escaping.
    const parts = raw.split(regex);
    let out = '';
    for (let i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      out += (i % 2 === 1) ? `<mark>${escHtml(parts[i])}</mark>` : escHtml(parts[i]);
    }
    return out;
  }


  // 前端透明集合鏡像：定義於上方 LOOSE_TRANSPARENT_RE，與 lib/text.js 透明集合 T 保持一致
  function highlightLooseSnippet(rawSnippet, terms, variants) {
    if (!rawSnippet) return '';
    if (!terms || terms.length === 0) return escHtml(rawSnippet);

    const sv = window.mdSearchVariants;
    const spans = [];
    for (const term of terms) {
      if (!term) continue;
      const cleanTerm = Array.from(term).filter(c => !LOOSE_TRANSPARENT_RE.test(c)).join('');
      const chars = Array.from(cleanTerm);
      if (chars.length === 0) continue;
      if (variants && sv) {
        // 字組比對：字與字之間可夾標點，每個字比對整個簡繁字組
        const re = new RegExp(sv.termPattern(cleanTerm, true), 'gu');
        let m;
        while ((m = re.exec(rawSnippet)) !== null) {
          if (m[0].length === 0) { re.lastIndex++; continue; }
          spans.push({ start: m.index, end: m.index + m[0].length });
        }
        continue;
      }
      const firstChar = chars[0];
      const firstLen = firstChar.length;
      let pos = 0;
      const textLen = rawSnippet.length;

      while (pos < textLen) {
        const start = rawSnippet.indexOf(firstChar, pos);
        if (start === -1) break;

        let idx = start + firstLen;
        let k = 1;
        while (idx < textLen && k < chars.length) {
          const cp = rawSnippet.codePointAt(idx);
          const ch = cp > 0xFFFF ? String.fromCodePoint(cp) : rawSnippet[idx];
          const chLen = ch.length;
          if (LOOSE_TRANSPARENT_RE.test(ch)) {
            idx += chLen;
            continue;
          }
          if (ch === chars[k]) {
            k++;
            idx += chLen;
          } else {
            break;
          }
        }

        if (k === chars.length) {
          spans.push({ start, end: idx });
          pos = idx > start ? idx : start + 1;
        } else {
          pos = start + 1;
        }
      }
    }

    if (spans.length === 0) return escHtml(rawSnippet);

    spans.sort((a, b) => a.start - b.start || a.end - b.end);
    const merged = [];
    for (const s of spans) {
      if (merged.length === 0) {
        merged.push({ start: s.start, end: s.end });
      } else {
        const prev = merged[merged.length - 1];
        if (s.start <= prev.end) {
          prev.end = Math.max(prev.end, s.end);
        } else {
          merged.push({ start: s.start, end: s.end });
        }
      }
    }

    let html = '';
    let lastIdx = 0;
    for (const { start, end } of merged) {
      if (start > lastIdx) {
        html += escHtml(rawSnippet.substring(lastIdx, start));
      }
      html += '<mark>' + escHtml(rawSnippet.substring(start, end)) + '</mark>';
      lastIdx = end;
    }
    if (lastIdx < rawSnippet.length) {
      html += escHtml(rawSnippet.substring(lastIdx));
    }
    return html;
  }

  // ═══════════════════════════════════════════════════════════
  // §10 DICTIONARY LOOKUP PANEL (Right Hidden Sidebar)
  // ═══════════════════════════════════════════════════════════

  function syncDictToggleVisibility() {
    const btn = $('dictToggleBtn');
    if (btn) btn.style.display = state.dictionaryEnabled ? 'flex' : 'none';
    if (!state.dictionaryEnabled) toggleDictSidebar(false);
  }

  function updateSidebarBackdrop() {
    const backdrop = $('sidebarBackdrop');
    if (!backdrop) return;
    const isNarrow = isMobileBrowser() || window.innerWidth <= 768;
    const leftOpen = !$('sidebar')?.classList.contains('collapsed');
    const rightOpen = state.dictSidebarOpen && !$('dictSidebar')?.classList.contains('collapsed');
    if (isNarrow && (leftOpen || rightOpen)) {
      backdrop.classList.add('active');
    } else {
      backdrop.classList.remove('active');
    }
  }

  function closeMobileSidebars() {
    const isNarrow = isMobileBrowser() || window.innerWidth <= 768;
    if (!isNarrow) return;
    const sidebar = $('sidebar');
    if (sidebar && !sidebar.classList.contains('collapsed')) {
      sidebar.classList.add('collapsed');
      state.sidebarCollapsed = true;
    }
    if (state.dictSidebarOpen) {
      toggleDictSidebar(false);
    }
    updateSidebarBackdrop();
  }

  function toggleDictSidebar(force) {
    const sidebar = $('dictSidebar');
    if (!sidebar) return;
    const isNarrow = isMobileBrowser() || window.innerWidth <= 768;
    const shouldOpen = typeof force === 'boolean' ? force : !state.dictSidebarOpen;
    state.dictSidebarOpen = shouldOpen;
    sidebar.classList.toggle('collapsed', !shouldOpen);
    if (shouldOpen) {
      // Mutual exclusion on mobile: collapse left sidebar
      if (isNarrow) {
        const leftSidebar = $('sidebar');
        if (leftSidebar && !leftSidebar.classList.contains('collapsed')) {
          leftSidebar.classList.add('collapsed');
          state.sidebarCollapsed = true;
        }
      }
      sidebar.style.width = (!isNarrow && state.dictSidebarWidth) ? state.dictSidebarWidth + 'px' : '';
    } else {
      sidebar.style.width = '';
      stopDictPolling();
    }
    const handle = $('dictResizeHandle');
    if (handle) handle.style.display = (shouldOpen && !isNarrow) ? 'block' : 'none';
    const btn = $('dictToggleBtn');
    if (btn) btn.classList.toggle('active', shouldOpen);
    if (shouldOpen) {
      ensureDictHeadwords();
      startDictPolling();
      const inputVal = ($('dictSearchInput')?.value || '').trim();
      const results = $('dictResults');
      if (!inputVal && results && (!results.querySelector('.dict-result-item') && !results.querySelector('.dict-placeholder'))) {
        results.innerHTML = '<div class="dict-placeholder"><span>📖</span><span>輸入詞條開始查詢</span></div>';
      }
    }
    updateSidebarBackdrop();
  }

  // Toggles the collapsible "辭典選擇" file-list box with a slide animation.
  // Hidden by default; all dictionaries remain selected when collapsed.
  function toggleDictFileList(force) {
    const list = $('dictFileList');
    const btn = $('dictFileListToggle');
    if (!list || !btn) return;
    const shouldOpen = typeof force === 'boolean' ? force : list.classList.contains('collapsed');
    list.classList.toggle('collapsed', !shouldOpen);
    btn.classList.toggle('open', shouldOpen);
    btn.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
  }

  // Fire-and-forget beacon to the dictionary analytics endpoint. Records search-
  // result clicks ('lookup'), which drive both 辭典查詢 (query) and 辭典點閱
  // (headword) — see handleDictEvent in server.js.
  function sendDictEvent(kind, payload = {}) {
    if (!state.dictionaryEnabled) return;
    try {
      fetch('/api/dict-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, ...payload }),
        keepalive: true
      }).catch(() => {});
    } catch (_) {}
  }

  // CJK bigram extractor — MUST match extractBigrams() in server.js and
  // extractBigramsFromText() in index-worker.js so prefix/fuzzy matching stays
  // consistent with the server-side full-text bigram index.
  function extractCJKBigrams(text) {
    const set = new Set();
    let prev = '';
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      if ((ch >= 0x4E00 && ch <= 0x9FFF) || (ch >= 0x3400 && ch <= 0x4DBF)) {
        const c = text[i];
        if (prev) set.add(prev + c);
        prev = c;
      } else {
        prev = '';
      }
    }
    return set;
  }

  function cleanDictHeadword(hw) {
    return String(hw || '').replace(/^【/, '').replace(/】$/, '').trim();
  }

  let dictHeadwordsPromise = null;

  async function ensureDictHeadwords() {
    if (state.dictHeadwords) return state.dictHeadwords;
    if (dictHeadwordsPromise) return dictHeadwordsPromise;
    renderDictFileList();
    dictHeadwordsPromise = (async () => {
      try {
        await fetchDictHeadwords();
        return state.dictHeadwords;
      } catch (err) {
        state.dictHeadwords = null;
        state.dictHeadwordsETag = null;
        state.dictIndex = null;
        renderDictFileList();
        showToast('❌ 辭典詞頭載入失敗', 'error');
        return null;
      } finally {
        dictHeadwordsPromise = null;
      }
    })();
    return dictHeadwordsPromise;
  }

  // Fetches the dictionary headword list, revalidating with ETag so unchanged
  // requests cost only a 304. Returns true when the data actually changed.
  async function fetchDictHeadwords() {
    const headers = {};
    if (state.dictHeadwordsETag) headers['If-None-Match'] = state.dictHeadwordsETag;
    const res = await fetch('/api/dict-headwords', { headers });
    if (res.status === 304) return false; // unchanged
    if (!res.ok) throw new Error('HTTP ' + res.status);
    state.dictHeadwordsETag = res.headers.get('ETag') || '';
    const data = await res.json();
    state.dictHeadwords = data;
    buildDictFrontendIndex(data);
    // Reconcile dictionary sizes with the current listing. Preserve main-tree
    // sizes, but remove stale dictionary paths that disappeared from this list.
    const dictFiles = data.files || [];
    const currentDictPaths = new Set(dictFiles.map(f => f.path));
    for (const oldPath of state.dictFileSizePaths) {
      const currentFile = dictFiles.find(f => f.path === oldPath);
      if (!currentFile || !Number.isFinite(currentFile.size)) state.fileSizes.delete(oldPath);
    }
    state.dictFileSizePaths = currentDictPaths;
    dictFiles.forEach(f => {
      if (Number.isFinite(f.size)) state.fileSizes.set(f.path, f.size);
    });
    // Prune selection indices beyond the current file count (files removed), and
    // on first load restore the user's saved selection (by path) — falling back
    // to "all selected" when no preference has ever been saved.
    const n = (data.files || []).length;
    if (state.dictSelected === null) {
      const saved = loadDictFileSelect();
      if (saved !== null) {
        const savedSet = new Set(saved);
        state.dictSelected = new Set();
        (data.files || []).forEach((f, i) => { if (savedSet.has(f.path)) state.dictSelected.add(i); });
      } else {
        state.dictSelected = new Set((data.files || []).map((_, i) => i));
      }
    } else {
      for (const i of Array.from(state.dictSelected)) if (i >= n) state.dictSelected.delete(i);
    }
    renderDictFileList();
    return true;
  }

  function startDictPolling() {
    stopDictPolling();
    state.dictPollTimer = setInterval(async () => {
      if (!state.dictSidebarOpen || !state.dictionaryEnabled) return;
      try {
        const changed = await fetchDictHeadwords();
        if (changed) {
          const q = ($('dictSearchInput')?.value || '').trim();
          if (q) runDictSearch(q);
        }
      } catch (_) { /* ignore transient poll errors */ }
    }, 20000);
  }

  function stopDictPolling() {
    if (state.dictPollTimer) { clearInterval(state.dictPollTimer); state.dictPollTimer = null; }
  }

  function buildDictFrontendIndex(data) {
    const files = data.files || [];
    const raw = data.entries || [];
    const sorted = raw.map(r => ({ hw: r[3], fi: r[0], ei: r[1], line: r[2] }));
    sorted.sort((a, b) => (a.hw < b.hw ? -1 : a.hw > b.hw ? 1 : (a.fi - b.fi || a.ei - b.ei)));
    const bigrams = new Map();
    sorted.forEach((it, idx) => {
      const bs = extractCJKBigrams(it.hw);
      for (const bg of bs) {
        let arr = bigrams.get(bg);
        if (!arr) { arr = []; bigrams.set(bg, arr); }
        arr.push(idx);
      }
    });
    state.dictIndex = { files, sorted, bigrams, count: sorted.length };
  }

  const DICT_FILE_ORDER_KEY = STORAGE_KEYS.DICT_FILE_ORDER;

  // Loads the user's preferred dictionary file order (array of `dict:` paths)
  // from localStorage once; falls back to an empty array (server order).
  function loadDictFileOrder() {
    if (state.dictFileOrder !== null) return;
    const parsed = storage.getJson(STORAGE_KEYS.DICT_FILE_ORDER, []);
    state.dictFileOrder = Array.isArray(parsed) ? parsed.map(String) : [];
  }

  function saveDictFileOrder() {
    storage.setJson(STORAGE_KEYS.DICT_FILE_ORDER, state.dictFileOrder || []);
  }

  const DICT_FILE_SELECT_KEY = STORAGE_KEYS.DICT_FILE_SELECT;

  // Loads the saved dictionary selection (array of `dict:` paths) once. Returns
  // null when no preference was ever saved, so the "all selected" default still
  // applies on first run.
  function loadDictFileSelect() {
    const parsed = storage.getJson(STORAGE_KEYS.DICT_FILE_SELECT, null);
    return Array.isArray(parsed) ? parsed.map(String) : null;
  }

  function saveDictFileSelect(paths) {
    storage.setJson(STORAGE_KEYS.DICT_FILE_SELECT, paths || []);
  }

  // Persists the current checkbox selection as `dict:` paths so reopening the
  // panel restores the user's preferred dictionaries.
  function persistDictSelection() {
    saveDictFileSelect(dictSelectedFiles());
  }

  // Canonical file indices in the user's preferred display order. Unknown paths
  // in the saved order are dropped; newly added files are appended at the end.
  function dictFileOrderIndex() {
    const files = (state.dictHeadwords && state.dictHeadwords.files) || [];
    if (files.length === 0) return [];
    loadDictFileOrder();
    const order = state.dictFileOrder || [];
    const idxByPath = new Map(files.map((f, i) => [f.path, i]));
    const result = [];
    for (const p of order) {
      const i = idxByPath.get(p);
      if (i !== undefined) result.push(i);
    }
    for (let i = 0; i < files.length; i++) {
      if (!result.includes(i)) result.push(i);
    }
    return result;
  }

  // Moves canonical file index `fromFi` before (or after) `toFi` and persists
  // the new order, then re-renders the list and results.
  function reorderDictFiles(fromFi, toFi, before) {
    const files = (state.dictHeadwords && state.dictHeadwords.files) || [];
    const order = dictFileOrderIndex();
    if (order.indexOf(fromFi) < 0 || order.indexOf(toFi) < 0 || fromFi === toFi) return;
    order.splice(order.indexOf(fromFi), 1);
    const targetPos = order.indexOf(toFi);
    order.splice(before ? targetPos : targetPos + 1, 0, fromFi);
    state.dictFileOrder = order.map(i => files[i].path);
    saveDictFileOrder();
    renderDictFileList();
    runDictSearch($('dictSearchInput')?.value || '');
  }

  function renderDictFileList() {
    const container = $('dictFileList');
    if (!container) return;
    if (!state.dictHeadwords) {
      container.innerHTML = state._dictLoading
        ? '<div class="dict-file-empty">載入辭典清單…</div>'
        : '<div class="dict-file-empty">未掃描到辭典檔</div>';
      return;
    }
    const files = state.dictHeadwords.files || [];
    if (files.length === 0) {
      container.innerHTML = '<div class="dict-file-empty">未掃描到辭典檔</div>';
      return;
    }
    const selected = state.dictSelected || new Set(files.map((_, i) => i));
    const allOn = files.every((_, i) => selected.has(i));
    let html = `<div class="dict-file-list-header"><span>辭典選擇</span><button class="dict-file-all-toggle" data-dict-toggle-all>${allOn ? '全不選' : '全選'}</button></div>`;
    for (const fi of dictFileOrderIndex()) {
      const f = files[fi];
      html += `<label class="dict-file-item" data-dict-drag="${fi}"><span class="dict-file-drag" aria-hidden="true" title="拖曳排序">⠿</span><input type="checkbox" data-dict-file="${fi}" ${selected.has(fi) ? 'checked' : ''}><span class="dict-file-name">${escHtml(f.name)}</span><span class="dict-file-count">${(f.entryCount || 0).toLocaleString()} 筆</span></label>`;
    }
    container.innerHTML = html;
  }

  function dictSelectedFiles() {
    const files = (state.dictIndex && state.dictIndex.files) || [];
    const selected = state.dictSelected;
    if (!selected) return files.map(f => f.path);
    return files.filter((_, i) => selected.has(i)).map(f => f.path);
  }

  function dictSelectedSet() {
    const files = (state.dictIndex && state.dictIndex.files) || [];
    if (!state.dictSelected) return new Set(files.map((_, i) => i));
    return new Set(state.dictSelected);
  }

  function intersectSortedIdx(a, b) {
    const out = [];
    let i = 0, j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] < b[j]) i++;
      else if (a[i] > b[j]) j++;
      else { out.push(a[i]); i++; j++; }
    }
    return out;
  }

  async function runDictSearch(query) {
    let q = (query || '').trim();
    if (!q) {
      state.dictFulltextCache = null;
      state.dictFulltextScrollTop = 0;
      $('dictResults').innerHTML = '<div class="dict-placeholder"><span>📖</span><span>輸入詞條開始查詢</span></div>';
      return;
    }
    if (!state.dictHeadwords) {
      await ensureDictHeadwords();
    }
    // Re-check input in case it was updated while loading
    const currentInputVal = ($('dictSearchInput')?.value || '').trim();
    if (currentInputVal && currentInputVal !== q) {
      q = currentInputVal;
    }
    if (!q) return;
    // Invalidate cached fulltext results if query has changed
    if (state.dictFulltextCache && state.dictFulltextCache.query !== q) {
      state.dictFulltextCache = null;
      state.dictFulltextScrollTop = 0;
    }
    // No dictionaries selected → don't run any search (prefix/fuzzy/fulltext).
    const totalFiles = (state.dictIndex && state.dictIndex.files) ? state.dictIndex.files.length : 0;
    if (totalFiles > 0 && dictSelectedSet().size === 0) {
      $('dictResults').innerHTML = '<div class="dict-placeholder"><span>⚠️</span><span>未選取任何辭典，請先在「辭典選擇」勾選至少一個</span></div>';
      return;
    }
    if (state.dictMode === 'fulltext') {
      dictSearchFulltext(q);
    } else {
      // Switching to a local (prefix/fuzzy) mode — abort any in-flight full-text
      // request so its late response can't overwrite the local results.
      if (state.dictAbortController) { state.dictAbortController.abort(); state.dictAbortController = null; }
      if (state.dictMode === 'fuzzy') dictSearchFuzzy(q);
      else dictSearchPrefix(q);
    }
  }

  /**
   * 字組比對用的詞頭索引：每個詞頭換成字組代表字（fold）後排序，供前綴二分搜尋。
   * 只在第一次以字組比對查詢時建立，之後隨 state.dictIndex 一起失效。
   */
  function dictFoldedIndex(idx) {
    if (idx.folded) return idx.folded;
    const sv = window.mdSearchVariants;
    const folded = idx.sorted.map((it, i) => ({ hw: sv.fold(it.hw), i }));
    folded.sort((a, b) => (a.hw < b.hw ? -1 : a.hw > b.hw ? 1 : a.i - b.i));
    idx.folded = folded;
    return folded;
  }

  /** 查詢字串若含有簡繁變體字，且字組比對開啟，回傳 mdSearchVariants；否則 null。 */
  function dictVariantMatcher(q) {
    const sv = window.mdSearchVariants;
    return (sv && s2tQueryEnabled() && sv.hasVariants(q)) ? sv : null;
  }

  function dictSearchPrefix(q) {
    const idx = state.dictIndex;
    const results = $('dictResults');
    if (!idx || idx.sorted.length === 0) {
      results.innerHTML = '<div class="dict-placeholder"><span>📖</span><span>無可用詞頭</span></div>';
      return;
    }
    const sel = dictSelectedSet();
    const sv = dictVariantMatcher(q);
    if (sv) {
      // 字組比對：在 fold 後的詞頭上做同樣的前綴二分搜尋，結果依原排序輸出
      const folded = dictFoldedIndex(idx);
      const fq = sv.fold(q);
      let lo = 0, hi = folded.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (folded[mid].hw < fq) lo = mid + 1; else hi = mid; }
      const hits = [];
      for (let i = lo; i < folded.length && folded[i].hw.startsWith(fq); i++) {
        const it = idx.sorted[folded[i].i];
        if (sel.has(it.fi)) hits.push(folded[i].i);
      }
      if (hits.length === 0) return dictSearchFuzzy(q);
      hits.sort((a, b) => a - b);
      renderDictHeadwordResults(hits.map(i => idx.sorted[i]), q);
      return;
    }
    const sorted = idx.sorted;
    // Binary search the sorted array for [q, q + U+FFFF).
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid].hw < q) lo = mid + 1; else hi = mid; }
    const start = lo;
    const upper = q + '\uffff';
    lo = start; hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid].hw < upper) lo = mid + 1; else hi = mid; }
    const end = lo;
    const matched = [];
    for (let i = start; i < end; i++) {
      const it = sorted[i];
      if (it.hw.startsWith(q) && sel.has(it.fi)) matched.push(it);
    }
    if (matched.length === 0) {
      // If exact prefix match yields no results, automatically fallback to fuzzy substring search
      return dictSearchFuzzy(q);
    }
    renderDictHeadwordResults(matched, q);
  }

  function dictSearchFuzzy(q) {
    const idx = state.dictIndex;
    const results = $('dictResults');
    if (!idx || idx.sorted.length === 0) {
      results.innerHTML = '<div class="dict-placeholder"><span>📖</span><span>無可用詞頭</span></div>';
      return;
    }
    const sel = dictSelectedSet();
    const sv = dictVariantMatcher(q);
    // 字組比對：bigram 取所有字組組合的 posting 聯集，比對時兩邊都 fold
    const fq = sv ? sv.fold(q) : q;
    const hwMatches = sv ? (hw) => sv.fold(hw).includes(fq) : (hw) => hw.includes(q);
    const qBigrams = extractCJKBigrams(q);
    let candidateIdx = null;
    if (qBigrams.size > 0) {
      for (const bg of qBigrams) {
        let posting;
        if (sv) {
          const combos = sv.expandBigram(bg);
          if (!combos) continue; // 組合過多：此 bigram 不參與縮小範圍
          const lists = combos.map(c => idx.bigrams.get(c)).filter(Boolean);
          posting = lists.length === 0 ? null
            : lists.length === 1 ? lists[0]
            : Array.from(new Set(lists.flat())).sort((a, b) => a - b);
        } else {
          posting = idx.bigrams.get(bg);
        }
        if (!posting) { candidateIdx = []; break; }
        candidateIdx = (candidateIdx === null) ? posting.slice() : intersectSortedIdx(candidateIdx, posting);
        if (candidateIdx.length === 0) break;
      }
    }
    const matched = [];
    if (candidateIdx && candidateIdx.length > 0) {
      for (const i of candidateIdx) {
        const it = idx.sorted[i];
        if (hwMatches(it.hw) && sel.has(it.fi)) matched.push(it);
      }
    } else if (candidateIdx === null) {
      // No CJK bigrams (e.g. single char / non-CJK) → linear includes scan.
      for (const it of idx.sorted) {
        if (hwMatches(it.hw) && sel.has(it.fi)) matched.push(it);
      }
    }
    renderDictHeadwordResults(matched, q);
  }

  function renderDictHeadwordResults(matched, q) {
    const results = $('dictResults');
    if (matched.length === 0) {
      results.innerHTML = '<div class="dict-placeholder"><span>🔍</span><span>沒有找到結果</span></div>';
      return;
    }
    const files = state.dictIndex.files || [];
    const groups = new Map();
    for (const it of matched) {
      if (!groups.has(it.fi)) groups.set(it.fi, []);
      groups.get(it.fi).push(it);
    }
    let html = `<div class="dict-status">找到 ${matched.length} 筆</div>`;
    for (const fi of dictFileOrderIndex()) {
      const items = groups.get(fi);
      if (!items || items.length === 0) continue;
      const f = files[fi] || { name: '未知', path: '' };
      html += `<div class="dict-result-group"><div class="dict-result-file">📖 ${escHtml(f.name)}<span class="dict-result-file-count">${items.length}</span></div>`;
      for (const it of items) {
        html += `<div class="dict-result-item" data-file="${escHtml(f.path)}" data-line="${it.line}" data-entry="${it.ei}" data-headword="${escHtml(it.hw)}"><span class="dict-result-headword">${highlightSearchTerm(it.hw, q, s2tQueryEnabled())}</span></div>`;
      }
      html += `</div>`;
    }
    results.innerHTML = html;
  }

  function dictSearchFulltext(q) {
    const filesParam = dictSelectedFiles().map(encodeURIComponent).join(',');
    const results = $('dictResults');
    // If fulltext results for the same query and files are already cached, restore the
    // cached page the user was on. The cache holds the whole page walk (see
    // state.dictFulltextCache), so returning to a query never refetches.
    if (state.dictFulltextCache && state.dictFulltextCache.query === q && state.dictFulltextCache.files === filesParam) {
      if (state.dictAbortController) { state.dictAbortController.abort(); state.dictAbortController = null; }
      const cache = state.dictFulltextCache;
      const page = cache.pages[cache.pageIndex] || cache.pages[0];
      renderDictFulltextResults(page, q, cache.pageIndex, cache.pages.length);
      const scroll = page && typeof page.scrollTop === 'number' ? page.scrollTop : state.dictFulltextScrollTop;
      if (scroll && results) results.scrollTop = scroll;
      return;
    }
    if (state.dictAbortController) state.dictAbortController.abort();
    const controller = new AbortController();
    state.dictAbortController = controller;
    results.innerHTML = '<div class="dict-loading"><div class="spinner"></div><span>搜尋中…</span></div>';
    fetchDictFulltextPage(q, filesParam, null, controller)
      .then(data => {
        // Drop responses from a superseded request (a newer query or mode switch
        // aborted this controller) so a stale result never overwrites the view.
        if (state.dictAbortController !== controller) return;
        state.dictAbortController = null;
        state.dictFulltextCache = {
          query: q,
          files: filesParam,
          pageIndex: 0,
          pages: [normalizeDictFulltextPage(data, null, [])],
        };
        state.dictFulltextScrollTop = 0;
        renderDictFulltextResults(state.dictFulltextCache.pages[0], q, 0, 1);
      })
      .catch(err => {
        if (err.name === 'AbortError') return;
        if (state.dictAbortController !== controller) return;
        state.dictAbortController = null;
        results.innerHTML = `<div class="dict-placeholder"><span>⚠️</span><span>搜尋失敗: ${escHtml(err.message)}</span></div>`;
        showToast('辭典搜尋失敗', 'error');
      });
  }

  /**
   * 抓取辭典全文搜尋的單一分頁（GET /api/dict-search）。
   *
   * `after` 是上一頁的 nextAfter 游標（第一頁為 null），`done` 是累計已走完的
   * 檔案清單；兩者只在非空時才附帶於查詢字串。中斷與過期判斷由呼叫端透過傳入的
   * controller 自行負責（本函式不含任何 staleness 邏輯）。
   *
   * @param {string} q           - 查詢字串
   * @param {string} filesParam  - 逗號分隔且已 encodeURIComponent 的辭典路徑
   * @param {Object|null} after  - 游標物件（relPath → 已交付命中數），首頁為 null
   * @param {AbortController} [controller] - 用於取消請求（可省略）
   * @param {string[]} [done]    - 已走完的 relPath 清單（可省略）
   * @returns {Promise<Object>} 原始 JSON 分頁資料（未正規化）
   */
  function fetchDictFulltextPage(q, filesParam, after, controller, done) {
    let url = `/api/dict-search?q=${encodeURIComponent(q)}&files=${filesParam}&variants=${variantsParam()}`;
    if (after && Object.keys(after).length > 0) {
      url += `&after=${encodeURIComponent(JSON.stringify(after))}`;
    }
    if (done && done.length > 0) {
      url += `&done=${encodeURIComponent(done.join(','))}`;
    }
    const opts = controller ? { signal: controller.signal } : {};
    return fetch(url, opts).then(res => {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  /**
   * 把單頁 API payload 正規化為分頁快取紀錄（state.dictFulltextCache.pages 的元素）。
   *
   * @param {Object} data       - /api/dict-search 的原始回應
   * @param {Object|null} after - 產生此頁的游標（首頁為 null）
   * @param {string[]} [done]   - 請求此頁時送出的累計已走完檔案清單
   * @returns {{after: (Object|null), done: string[], results: Object[], total: number, capped: boolean, hasMore: boolean, nextAfter: (Object|null), exhausted: string[], scrollTop: number}}
   *   `hasMore` 決定「下一頁」是否可用，`exhausted` / `done` 供走訪時累計為下一頁的
   *   `done`；`scrollTop` 為此頁自己的捲動位置（切頁時保存／還原）。
   */
  function normalizeDictFulltextPage(data, after, done) {
    return {
      after: after || null,
      done: done || [],
      results: data.results || [],
      total: data.total || 0,
      capped: !!data.capped,
      hasMore: !!data.hasMore,
      nextAfter: data.nextAfter || null,
      exhausted: Array.isArray(data.exhausted) ? data.exhausted : [],
      scrollTop: 0,
    };
  }

  // pagerIndex / pagerCount drive the page indicator; the result list is rendered from
  // one page record at a time, so page navigation always REPLACES the DOM content.
  function renderDictFulltextResults(data, q, pagerIndex, pagerCount) {
    const results = $('dictResults');
    const list = data.results || [];
    if (list.length === 0) {
      results.innerHTML = '<div class="dict-placeholder"><span>🔍</span><span>沒有找到結果</span></div>';
      return;
    }
    const groups = new Map();
    for (const r of list) {
      if (!groups.has(r.file)) groups.set(r.file, { name: r.fileName, items: [] });
      groups.get(r.file).items.push(r);
    }
    const files = (state.dictIndex && state.dictIndex.files) || [];
    let html = `<div class="dict-status">找到 ${data.total} 筆${data.capped ? '（已達上限）' : ''}</div>`;
    for (const fi of dictFileOrderIndex()) {
      const f = files[fi];
      if (!f) continue;
      const g = groups.get(f.path);
      if (!g || g.items.length === 0) continue;
      html += `<div class="dict-result-group"><div class="dict-result-file">📖 ${escHtml(g.name)}<span class="dict-result-file-count">${g.items.length}</span></div>`;
      for (const r of g.items) {
        const cleanHeadword = cleanDictHeadword(r.headword);
        const headwordTag = cleanHeadword ? `<span class="dict-result-headword">${escHtml(cleanHeadword)}</span>` : '';
        const entryAttr = (r.entryIndex !== undefined && r.entryIndex !== null && r.entryIndex >= 0) ? ` data-entry="${escHtml(r.entryIndex)}"` : '';
        html += `<div class="dict-result-item" data-file="${escHtml(r.file)}" data-line="${escHtml(r.line)}" data-headword="${escHtml(cleanHeadword)}"${entryAttr}>${headwordTag}<span class="dict-result-snippet">${highlightSearchTerm(r.snippet, q, s2tQueryEnabled())}</span></div>`;
      }
      html += `</div>`;
    }
    html += renderDictFulltextPager(data, pagerIndex, pagerCount);
    results.innerHTML = html;
  }

  /**
   * 顯示快取中已抓取的第 `index` 頁，並還原該頁自己的捲動位置。
   *
   * 結果列表是整份「替換」而非追加，因此無論走訪到第幾頁，DOM 中的結果數都固定在
   * 一頁的量；`index` 會先夾在 [0, pages.length-1]，切頁前把目前頁的 DOM scrollTop
   * 存回快取紀錄，切頁後再套用目標頁保存的值（同時同步 state.dictFulltextScrollTop）。
   *
   * @param {number} index - 目標分頁索引（超界時夾至有效範圍）
   */
  function showDictFulltextPage(index) {
    const cache = state.dictFulltextCache;
    if (!cache || !Array.isArray(cache.pages) || cache.pages.length === 0) return;
    const clamped = Math.max(0, Math.min(index, cache.pages.length - 1));
    const results = $('dictResults');
    const current = cache.pages[cache.pageIndex];
    if (current && results) current.scrollTop = results.scrollTop;
    cache.pageIndex = clamped;
    const page = cache.pages[clamped];
    renderDictFulltextResults(page, cache.query, clamped, cache.pages.length);
    if (results) results.scrollTop = page.scrollTop || 0;
    state.dictFulltextScrollTop = page.scrollTop || 0;
  }

  /**
   * 前往下一頁。只在目前頁 `hasMore` 且帶有 `nextAfter` 時才動作。
   *
   * 已抓取過（使用者曾翻回去再翻過來）則直接由快取顯示，不重新請求；否則以目前頁的
   * `nextAfter` 作為 `after`、並把「目前頁已累計的 done + 本頁回報的 exhausted」取
   * 聯集後作為 `done` 送出，讓已走完的辭典不再被重掃。回應抵達時若 controller 已
   * 被取代、或快取已被重置／查詢或檔案集已變更，則丟棄該回應，避免復活過期結果。
   */
  function dictFulltextNextPage() {
    const cache = state.dictFulltextCache;
    if (!cache || !Array.isArray(cache.pages) || cache.pages.length === 0) return;
    const page = cache.pages[cache.pageIndex];
    if (!page || !page.hasMore || !page.nextAfter) return;
    // Already fetched (user paged back then forward) → reuse, no refetch.
    if (cache.pageIndex + 1 < cache.pages.length) {
      showDictFulltextPage(cache.pageIndex + 1);
      return;
    }
    const results = $('dictResults');
    const current = cache.pages[cache.pageIndex];
    if (current && results) current.scrollTop = results.scrollTop;
    if (state.dictAbortController) state.dictAbortController.abort();
    const controller = new AbortController();
    state.dictAbortController = controller;
    if (results) results.innerHTML = '<div class="dict-loading"><div class="spinner"></div><span>載入下一頁…</span></div>';
    const after = page.nextAfter;
    // Cumulative exhausted list: the pages already walked plus what this page reported
    // (server union). It is passed forward as `done` so finished dictionaries are never
    // rescanned for this query walk.
    const done = Array.from(new Set([].concat(page.done || [], page.exhausted || [])));
    const expectedQuery = cache.query;
    const expectedFiles = cache.files;
    fetchDictFulltextPage(cache.query, cache.files, after, controller, done)
      .then(data => {
        if (state.dictAbortController !== controller) return;
        state.dictAbortController = null;
        // The cache may have been reset (new query / mode or file-set change) while this
        // page was in flight; drop the response rather than resurrect stale results.
        if (state.dictFulltextCache !== cache || cache.query !== expectedQuery || cache.files !== expectedFiles) return;
        cache.pages.push(normalizeDictFulltextPage(data, after, done));
        showDictFulltextPage(cache.pages.length - 1);
      })
      .catch(err => {
        if (err.name === 'AbortError') return;
        if (state.dictAbortController !== controller) return;
        state.dictAbortController = null;
        if (results) results.innerHTML = `<div class="dict-placeholder"><span>⚠️</span><span>搜尋失敗: ${escHtml(err.message)}</span></div>`;
        showToast('辭典搜尋失敗', 'error');
      });
  }

  /**
   * 返回上一頁：只做本地快取切換（showDictFulltextPage），不重新請求；
   * 第 0 頁時不動作。
   */
  function dictFulltextPrevPage() {
    const cache = state.dictFulltextCache;
    if (!cache || cache.pageIndex <= 0) return;
    showDictFulltextPage(cache.pageIndex - 1);
  }

  /**
   * 產生分頁器（上一頁／下一頁）的 HTML 片段。
   *
   * 結果列表每次換頁都以整份替換（外層 renderDictFulltextResults 直接覆寫
   * innerHTML），所以 DOM 中永遠只有一頁的結果；「下一頁」以 `hasMore` 決定是否
   * 停用、「上一頁」以 `pagerIndex > 0` 決定。整份結果集僅單頁時回傳空字串，
   * 讓小結果集不會出現無意義的分頁器。
   *
   * @param {Object} data       - 目前頁的快取紀錄（讀取 `hasMore`）
   * @param {number} pagerIndex - 目前頁索引（0-based）
   * @param {number} pagerCount - 已抓取的分頁總數
   * @returns {string} 分頁器 HTML；無需分頁時為 ''
   */
  function renderDictFulltextPager(data, pagerIndex, pagerCount) {
    const idx = Math.max(0, pagerIndex | 0);
    const nextDisabled = !data.hasMore;
    const prevDisabled = idx <= 0;
    if (pagerCount <= 1 && !data.hasMore && idx === 0) return '';
    return `<div class="dict-pager">` +
      `<button type="button" class="dict-pager-btn" data-dict-page="prev"${prevDisabled ? ' disabled' : ''}>上一頁</button>` +
      `<span class="dict-pager-info">第 ${idx + 1} 頁</span>` +
      `<button type="button" class="dict-pager-btn" data-dict-page="next"${nextDisabled ? ' disabled' : ''}>下一頁</button>` +
      `</div>`;
  }

  // ── Dictionary entry prev/next navigation (main reader) ──
  let _entryNavEi = -1;
  function updateEntryNav() {
    const nav = $('entryNav');
    if (!nav) return;
    if (!state.currentFile || !state.currentFile.startsWith('dict:') || !isVirtualMode()) {
      nav.style.display = 'none';
      _entryNavEi = -1;
      return;
    }
    const v = state.virtual;
    const ei = topVisibleEntryIndex();
    if (ei < 0) {
      nav.style.display = 'none';
      _entryNavEi = -1;
      return;
    }
    if (ei === _entryNavEi && nav.style.display === 'flex') return;
    _entryNavEi = ei;
    nav.style.display = 'flex';
    const entry = v.entries[ei];
    const clean = entry ? cleanDictHeadword(entry.h) : '';
    $('entryNavLabel').textContent = clean || '';
    $('entryNavPrev').disabled = (ei <= 0);
    $('entryNavNext').disabled = (ei >= v.entries.length - 1);
  }

  function dictNavStep(delta) {
    if (!isVirtualMode()) return;
    const v = state.virtual;
    const ei = topVisibleEntryIndex();
    if (ei < 0) return;
    const target = ei + delta;
    if (target < 0 || target >= v.entries.length) return;
    jumpToEntry(target);
  }

  // ═══════════════════════════════════════════════════════════
  // §11 PAGE SEARCH (In-page Ctrl+F)
  // ═══════════════════════════════════════════════════════════

  let pageSearchAbortController = null;

  function openPageSearch() {
    const bar = $('pageSearchBar');
    bar.classList.add('visible');
    const input = $('pageSearchInput');
    input.focus();
    input.select();
  }

  function closePageSearch() {
    if (pageSearchAbortController) {
      pageSearchAbortController.abort();
      pageSearchAbortController = null;
    }
    $('pageSearchBar').classList.remove('visible');
    clearPageHighlights();
    $('pageSearchCount').textContent = '';
    $('pageSearchInput').value = '';
    state.pageSearchMatches = [];
    state.pageSearchIndex = -1;
  }

  async function doPageSearch(query) {
    clearPageHighlights();
    state.pageSearchMatches = [];
    state.pageSearchIndex = -1;
    state.pageSearchQuery = null;

    const q = (query || '').trim();

    if (!q || q.length === 0) {
      if (pageSearchAbortController) {
        pageSearchAbortController.abort();
        pageSearchAbortController = null;
      }
      $('pageSearchCount').textContent = '';
      return;
    }

    if (isVirtualMode()) {
      await doPageSearchVirtual(q);
      return;
    }

    const body = $('markdownBody');
    if (!body || !body.textContent) return;

    // 字組比對：畫面上的簡體字與輸入的繁／簡字都屬同一字組
    const matches = highlightTextNodes(body, q, s2tQueryEnabled());
    state.pageSearchMatches = matches;

    if (matches.length > 0) {
      state.pageSearchIndex = 0;
      matches[0].classList.add('active');
      safeScrollToElement(matches[0], $('content'), 'center');
    } else {
      showToast(`未找到符合「${q}」的內容`, 'warning');
    }

    $('pageSearchCount').textContent = matches.length > 0 ? `1/${matches.length}` : '0/0';
  }

  // Server-side in-page search for virtualized files: covers the whole document
  // (not just the ~7 mounted chunks). Returns matches [{ line, entryIndex, headword, snippet }].
  async function doPageSearchVirtual(query) {
    const v = state.virtual;
    if (!v) return;
    state.pageSearchQuery = query;
    if (pageSearchAbortController) {
      pageSearchAbortController.abort();
    }
    pageSearchAbortController = new AbortController();
    const signal = pageSearchAbortController.signal;
    try {
      const res = await fetch(`/api/search-file?path=${encodeURIComponent(v.filePath)}&q=${encodeURIComponent(query)}&variants=${variantsParam()}`, { signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (signal.aborted) return;
      const matches = Array.isArray(data.matches) ? data.matches : [];
      state.pageSearchMatches = matches;
      state.pageSearchIndex = -1;
      if (matches.length > 0) {
        state.pageSearchIndex = 0;
        const m = matches[0];
        await scrollToLineVirtual(m.line, query);
        if (signal.aborted) return;
        $('pageSearchCount').textContent = `1/${matches.length}`;
      } else {
        showToast(`未找到符合「${query}」的內容`, 'warning');
        $('pageSearchCount').textContent = '0/0';
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      state.pageSearchMatches = [];
      showToast('本頁搜尋失敗：' + err.message, 'error');
      $('pageSearchCount').textContent = '';
    }
  }

  function navigatePageSearch(direction) {
    const matches = state.pageSearchMatches;
    if (matches.length === 0) return;

    if (isVirtualMode()) {
      state.pageSearchIndex += direction;
      if (state.pageSearchIndex >= matches.length) {
        state.pageSearchIndex = 0;
        showToast('ℹ️ 已搜尋至文末，回到第 1 筆結果', 'info');
      }
      if (state.pageSearchIndex < 0) state.pageSearchIndex = matches.length - 1;
      const m = matches[state.pageSearchIndex];
      scrollToLineVirtual(m.line, state.pageSearchQuery || null);
      $('pageSearchCount').textContent = `${state.pageSearchIndex + 1}/${matches.length}`;
      return;
    }

    // Remove current active
    if (state.pageSearchIndex >= 0 && state.pageSearchIndex < matches.length) {
      matches[state.pageSearchIndex].classList.remove('active');
    }

    // Move index
    state.pageSearchIndex += direction;
    if (state.pageSearchIndex >= matches.length) {
      state.pageSearchIndex = 0;
      showToast('ℹ️ 已搜尋至文末，回到第 1 筆結果', 'info');
    }
    if (state.pageSearchIndex < 0) state.pageSearchIndex = matches.length - 1;

    // Set new active
    matches[state.pageSearchIndex].classList.add('active');
    safeScrollToElement(matches[state.pageSearchIndex], $('content'), 'center');

    $('pageSearchCount').textContent = `${state.pageSearchIndex + 1}/${matches.length}`;
  }

  function highlightTextNodes(root, query, variants) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const textNodes = [];
    while (walker.nextNode()) {
      textNodes.push(walker.currentNode);
    }

    const matches = [];
    // 字組比對：兩邊都換成字組代表字（fold 不改變長度，位置可直接對應原文）
    const sv = variants ? window.mdSearchVariants : null;
    const norm = (s) => (sv ? sv.fold(s.toLowerCase()) : s.toLowerCase());
    const lowerQuery = norm(query);

    for (const textNode of textNodes) {
      const text = textNode.textContent;
      const lowerText = norm(text);

      // Find all match positions
      const positions = [];
      let searchStart = 0;
      while (true) {
        const idx = lowerText.indexOf(lowerQuery, searchStart);
        if (idx === -1) break;
        positions.push(idx);
        searchStart = idx + lowerQuery.length;
      }

      if (positions.length === 0) continue;

      // Build fragments
      const fragment = document.createDocumentFragment();
      let lastEnd = 0;

      for (const pos of positions) {
        // Text before match
        if (pos > lastEnd) {
          fragment.appendChild(document.createTextNode(text.substring(lastEnd, pos)));
        }
        // Match
        const mark = document.createElement('mark');
        mark.className = 'search-highlight';
        mark.textContent = text.substring(pos, pos + query.length);
        matches.push(mark);
        fragment.appendChild(mark);
        lastEnd = pos + query.length;
      }

      // Remaining text
      if (lastEnd < text.length) {
        fragment.appendChild(document.createTextNode(text.substring(lastEnd)));
      }

      textNode.parentNode.replaceChild(fragment, textNode);
    }

    return matches;
  }

  function clearPageHighlights() {
    state.pageSearchMatches = [];
    state.pageSearchIndex = -1;
    const body = $('markdownBody');
    if (!body) return;
    const marks = $$('.search-highlight', body);
    const uniqueParents = new Set();
    marks.forEach((mark) => {
      const parent = mark.parentNode;
      if (parent) {
        parent.replaceChild(document.createTextNode(mark.textContent), mark);
        uniqueParents.add(parent);
      }
    });
    uniqueParents.forEach(parent => {
      parent.normalize();
    });
  }

  // ═══════════════════════════════════════════════════════════
  // §12 THEME
  // ═══════════════════════════════════════════════════════════

  const THEME_HEADER_COLORS = {
    'obsidian-dark': '#0f1522',
    'obsidian-light': '#eeeeec',
    'solarized': '#141814',
    'zen': '#ece5d8',
    'gruvbox': '#1d2021',
    'paper': '#f3efe6',
    'moon': '#e7ecf4',
    'bamboo': '#e8ecdf'
  };

  /** 淺色主題（Turnstile 等第三方元件要用 light 外觀） */
  const LIGHT_THEMES = new Set(['obsidian-light', 'zen', 'paper', 'moon', 'bamboo']);

  /**
   * 套用指定主題，更新 data-theme 屬性、所有主題下拉選單、狀態列顏色。
   * 特殊處理：強制移除並重新插入 <meta name="theme-color"> 以觸發 iOS WebKit 狀態列重繪。
   *
   * @param {string}  theme                  - 主題 ID ('obsidian-dark'|'obsidian-light'|'solarized'|'zen'|'gruvbox'|'paper'|'moon'|'bamboo')
   * @param {boolean} [saveToLocalStorage=true] - 是否將選擇持久化至 localStorage
   * @param {boolean} [notify=false]            - 是否以 Toast 通知使用者
   */
  function applyTheme(theme, saveToLocalStorage = true, notify = false) {
    document.documentElement.setAttribute('data-theme', theme);
    const select = $('themeSelect');
    if (select) select.value = theme;
    const settingSelect = $('settingThemeSelect');
    if (settingSelect) settingSelect.value = theme;
    updateUserMenuTheme(theme);

    if (saveToLocalStorage) {
      storage.set(STORAGE_KEYS.THEME, theme);
    }
    state.currentTheme = theme;

    // Dynamically update <meta name="theme-color"> so iOS Safari / PWA status bar matches the active theme
    const themeColor = THEME_HEADER_COLORS[theme] || '#0f1522';
    document.documentElement.style.backgroundColor = themeColor;
    if (document.body) document.body.style.backgroundColor = themeColor;
    const header = $('appHeader');
    if (header) header.style.backgroundColor = themeColor;

    // Dynamically update <meta name="theme-color"> so iOS Safari / PWA status bar matches the active theme
    let metaTheme = document.getElementById('metaThemeColor') || document.querySelector('meta[name="theme-color"]');
    if (!metaTheme) {
      metaTheme = document.createElement('meta');
      metaTheme.name = 'theme-color';
      metaTheme.id = 'metaThemeColor';
      document.head.appendChild(metaTheme);
    }
    metaTheme.content = themeColor;
    const extraMetas = document.querySelectorAll('meta[name="theme-color"]');
    if (extraMetas.length > 1) {
      for (let i = 1; i < extraMetas.length; i++) extraMetas[i].remove();
    }

    // Force Mobile WebKit/Chromium GPU composite layer repaint for active file pill
    const activePill = $('headerActiveFile');
    if (activePill) {
      activePill.classList.add('theme-updating');
      void activePill.offsetWidth; // Force reflow & style recalculation
      setTimeout(() => activePill.classList.remove('theme-updating'), 60);
    }

    if (notify) {
      const themeMap = { 'obsidian-dark': '🌌 夜藍 Night', 'obsidian-light': '🌫️ 霧灰 Mist', 'paper': '📜 素紙 Paper', 'moon': '🌕 月白 Moon', 'bamboo': '🎋 竹青 Bamboo', 'solarized': '🌿 苔夜 Moss', 'zen': '🍵 禪風 Zen', 'gruvbox': '🍂 Gruvbox' };
      showToast(`🎨 已切換閱讀主題為「${themeMap[theme] || theme}」`, 'info');
    }
  }

  // ═══════════════════════════════════════════════════════════
  // §13 FONT SIZE
  // ═══════════════════════════════════════════════════════════

  function applyFontSize(size, saveToLocalStorage = true) {
    size = Math.max(12, Math.min(32, size));
    state.fontSize = size;

    // Capture the reader's top line BEFORE the reflow; the font change rewrites
    // rendered line height, which invalidates the virtual-scroll px-per-line
    // calibration and would otherwise drift to the wrong heading.
    const topAnchor = isVirtualMode() ? captureTopAnchor() : null;

    document.documentElement.style.setProperty('--content-font-size', size + 'px');

    // Default base is configured by admin in settings (default 16px)
    const defaultBase = state.defaultFontSize || 16;
    const delta = size - defaultBase;

    // UI elements scale by 0.5x ratio relative to defaultBase
    // uiScale = 1 + (delta / (defaultBase * 2))
    const uiScale = 1 + (delta / (defaultBase * 2));
    document.documentElement.style.setProperty('--ui-font-scale', uiScale);

    recalibrateVirtualGeometry(topAnchor);

    const display = $('fontSizeDisplay');
    if (display) display.textContent = size;
    const menuDisplay = $('userMenuFontSize');
    if (menuDisplay) menuDisplay.textContent = size;
    if (saveToLocalStorage) {
      storage.set(STORAGE_KEYS.FONT_SIZE, size);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // §14 TEXT ALIGN, LINE HEIGHT, MAX WIDTH, READ PROGRESS
  // ═══════════════════════════════════════════════════════════

  function applyTextAlign(align, saveToLocalStorage = true) {
    if (!align) align = 'justify';
    state.textAlign = align;
    document.documentElement.style.setProperty('--content-text-align', align);

    const group = $('settingTextAlignGroup');
    if (group) {
      $$('.segment-btn', group).forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-value') === align);
      });
    }

    if (saveToLocalStorage) {
      storage.set(STORAGE_KEYS.TEXT_ALIGN, align);
    }
  }

  function applyLineHeight(lh, saveToLocalStorage = true) {
    if (!lh) lh = '1.8';
    state.lineHeight = lh;
    const topAnchor = isVirtualMode() ? captureTopAnchor() : null;
    document.documentElement.style.setProperty('--content-line-height', lh);
    recalibrateVirtualGeometry(topAnchor);

    const group = $('settingLineHeightGroup');
    if (group) {
      $$('.segment-btn', group).forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-value') === lh);
      });
    }

    if (saveToLocalStorage) {
      storage.set(STORAGE_KEYS.LINE_HEIGHT, lh);
    }
  }

  function renderMaxWidthControl() {
    const group = $('settingMaxWidthGroup');
    if (!group) return;

    const isMobile = isMobileBrowser();
    let currentVal = state.maxWidth;
    if (!currentVal) {
      currentVal = isMobile ? '95%' : '800px';
    }

    const options = isMobile ? [
      { label: '85%', value: '85%' },
      { label: '90%', value: '90%' },
      { label: '95%', value: '95%' },
      { label: '100% 全寬', value: '100%' }
    ] : [
      { label: '680px', value: '680px' },
      { label: '800px', value: '800px' },
      { label: '1000px', value: '1000px' }
    ];

    let html = '';
    options.forEach(opt => {
      const active = (currentVal === opt.value) ? ' active' : '';
      html += `<button type="button" class="segment-btn${active}" data-value="${opt.value}">${opt.label}</button>`;
    });
    group.innerHTML = html;

    $$('.segment-btn', group).forEach(btn => {
      btn.addEventListener('click', () => {
        applyMaxWidth(btn.getAttribute('data-value'));
      });
    });
  }

  function applyMaxWidth(mw, saveToLocalStorage = true) {
    const isMobile = isMobileBrowser();
    if (!mw) mw = isMobile ? '95%' : '800px';
    state.maxWidth = mw;
    const topAnchor = isVirtualMode() ? captureTopAnchor() : null;
    document.documentElement.style.setProperty('--content-max-width', mw);
    recalibrateVirtualGeometry(topAnchor);

    const group = $('settingMaxWidthGroup');
    if (group) {
      $$('.segment-btn', group).forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-value') === mw);
      });
    }

    if (saveToLocalStorage) {
      storage.set(STORAGE_KEYS.MAX_WIDTH, mw);
    }
  }

  function applyAutoReadProgress(enabled, saveToLocalStorage = true) {
    state.autoReadProgress = enabled;
    const chk = $('settingAutoReadProgressCheck');
    if (chk) chk.checked = enabled;

    if (saveToLocalStorage) {
      storage.set(STORAGE_KEYS.READ_PROGRESS_ENABLED, enabled ? 'true' : 'false');
    }
  }

  function applyAutoS2T(enabled, saveToLocalStorage = true) {
    state.autoS2T = !!enabled;
    const chk = $('settingAutoS2TCheck');
    if (chk) chk.checked = !!enabled;

    if (saveToLocalStorage) {
      storage.set(STORAGE_KEYS.AUTO_S2T, enabled ? 'true' : 'false');
    }
    if (state.fileTreeFilter && state.fileTreeFilter.trim()) {
      renderFileTree();
    }
    if (state.tocFilter && state.tocFilter.trim()) {
      applyTocFilter(state.tocFilter);
    }
  }

  // ── 繁／簡顯示 (Display Script) ───────────────────────────
  //
  // 經文與介面原文都是繁體；簡體顯示由 i18n/display-script.js 在瀏覽器端
  // 即時轉換畫面文字（保留原文，切回繁體可逐字還原）。這裡負責偏好、
  // 按鈕狀態、首次自動切換提示，以及與搜尋的銜接。

  function isHansDisplay() {
    return state.displayScript === 'hans';
  }

  /** 搜尋 API 的 variants 參數：字組比對開啟時為 '1'。 */
  function variantsParam() {
    return s2tQueryEnabled() ? '1' : '0';
  }

  /**
   * 搜尋是否以簡繁字組比對（i18n/search-variants.js）。簡體顯示時一律開啟：
   * 畫面是簡體，使用者自然會輸入簡體，而經文多為繁體；繁體顯示時由
   * 「簡繁字形一併比對」設定（autoS2T）決定，關閉時為字面比對。
   */
  function s2tQueryEnabled() {
    return !!state.autoS2T || isHansDisplay();
  }

  /** 目前介面語系，用於 i18n 與日期格式。 */
  function activeLocale() {
    return isHansDisplay() ? 'zh-CN' : 'zh-TW';
  }

  function i18nT(key, params) {
    return window.mdI18n ? window.mdI18n.t(key, params) : key;
  }

  function assetVersionQuery() {
    const el = document.querySelector('script[src*="app.js"]');
    const m = el && (el.getAttribute('src') || '').match(/[?&]v=([^&]+)/);
    return m ? `?v=${m[1]}` : '';
  }

  function markDisplayScriptReady() {
    document.documentElement.setAttribute('data-t2s-ready', '1');
  }

  function updateDisplayScriptUI() {
    const root = document.documentElement;
    root.setAttribute('lang', isHansDisplay() ? 'zh-Hans' : 'zh-TW');
    root.setAttribute('data-display-script', state.displayScript);
    if (window.mdI18n) {
      window.mdI18n.setLocale(activeLocale());
      window.mdI18n.apply(document);
    }
    const group = $('settingDisplayScriptGroup');
    if (group) {
      $$('.segment-btn', group).forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-value') === state.displayScript);
      });
    }
    updateUserMenuScript();
  }

  /**
   * 內文區是否有「轉換後才產生、沒有原文紀錄」的文字節點。
   *
   * 搜尋高亮會把文字節點切開再組回去，新節點只拿得到簡體字，切回繁體時
   * 無法逐字還原。偵測到這種節點就重新渲染目前檔案，確保繁體與原文一致。
   * 圖表（.mermaid-container 內的 Pele SVG）本來就不轉換，裡面的簡體字是原文，
   * 不算數，否則圖表含簡體字時每次切回繁體都會整篇重渲染。
   */
  function contentHasUnrestorableText() {
    const ds = window.mdDisplayScript;
    const body = $('markdownBody');
    const sv = window.mdSearchVariants;
    if (!ds || !body || !sv) return false;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = walker.nextNode())) {
      if (ds.originalText(n) === n.data && sv.hasSimplified(n.data) &&
          !(n.parentElement && n.parentElement.closest('code, pre, .katex, .mermaid, .mermaid-container, .pele'))) {
        return true;
      }
    }
    return false;
  }

  function rerenderCurrentFile() {
    const file = state.currentFile;
    if (!file) return;
    const scroller = $('content');
    const top = scroller ? scroller.scrollTop : 0;
    Promise.resolve(openFile(file))
      .then(() => { if (scroller) scroller.scrollTop = top; })
      .catch(err => log.warn('重新渲染失敗', err));
  }

  /**
   * 套用繁簡顯示。
   * @param {'hant'|'hans'} script
   * @param {boolean} [saveToLocalStorage=true]
   * @param {{ announce?: boolean }} [opts] - announce：完成後顯示 Toast
   * @returns {Promise<boolean>} 是否成功套用（簡體元件載入失敗時回傳 false，畫面維持繁體）
   */
  async function applyDisplayScript(script, saveToLocalStorage = true, opts) {
    opts = opts || {};
    const next = normalizeDisplayScript(script) || 'hant';
    const ds = window.mdDisplayScript;
    state.displayScript = next;
    if (saveToLocalStorage) storage.set(STORAGE_KEYS.DISPLAY_SCRIPT, next);

    if (next === 'hans') {
      try {
        if (!ds) throw new Error('display-script.js 未載入');
        await ds.load(`vendor/opencc/t2cn.js${assetVersionQuery()}`);
        // 下載期間使用者又切回繁體
        if (state.displayScript !== 'hans') return false;
        updateDisplayScriptUI();
        if (!ds.isActive()) ds.enable(document.documentElement);
      } catch (err) {
        log.warn('簡體轉換元件載入失敗，暫以繁體顯示', err);
        // 只退回畫面，不改寫偏好：下次進站仍會再試
        state.displayScript = 'hant';
        updateDisplayScriptUI();
        markDisplayScriptReady();
        showToast(i18nT('script.loadFailed', { error: err.message || String(err) }), 'error');
        return false;
      }
    } else {
      let needRerender = false;
      if (ds && ds.isActive()) {
        needRerender = contentHasUnrestorableText();
        ds.disable(document.documentElement);
      }
      updateDisplayScriptUI();
      if (needRerender) rerenderCurrentFile();
    }

    markDisplayScriptReady();
    if (opts.announce) showToast(i18nT('script.switched'), 'success');
    return true;
  }

  function dismissDisplayScriptNotice() {
    const el = document.getElementById('displayScriptNotice');
    const btn = $('userMenuBtn');
    if (btn) btn.classList.remove('pulse');
    if (!el) return;
    if (el._timer) clearTimeout(el._timer);
    el.classList.remove('show');
    setTimeout(() => el.remove(), 220);
  }

  /**
   * 首次依瀏覽器語言自動切換為簡體時，在右上角選單按鈕下方顯示提示，
   * 告訴使用者為何是簡體、以及如何切回。只在自動切換的那一次出現。
   */
  function showDisplayScriptNotice() {
    const btn = $('userMenuBtn');
    if (!btn || document.getElementById('displayScriptNotice')) return;

    const el = document.createElement('div');
    el.id = 'displayScriptNotice';
    el.className = 'display-script-notice';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    // 字串已依語系取自 i18n 表，不需再轉換
    el.setAttribute('data-no-t2s', '');

    const title = document.createElement('div');
    title.className = 'display-script-notice-title';
    title.textContent = i18nT('script.autoNotice.title');
    const body = document.createElement('div');
    body.className = 'display-script-notice-body';
    body.textContent = i18nT('script.autoNotice.body', { label: i18nT('script.toggle.label') });
    const actions = document.createElement('div');
    actions.className = 'display-script-notice-actions';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'display-script-notice-dismiss';
    ok.textContent = i18nT('script.autoNotice.dismiss');
    ok.addEventListener('click', dismissDisplayScriptNotice);
    actions.appendChild(ok);
    el.append(title, body, actions);
    document.body.appendChild(el);

    // 對齊按鈕：提示框貼齊視窗右側，箭頭指向按鈕中央
    const r = btn.getBoundingClientRect();
    const right = Math.max(8, Math.round(window.innerWidth - r.right - 4));
    el.style.top = `${Math.round(r.bottom + 10)}px`;
    el.style.right = `${right}px`;
    const arrowRight = Math.round(window.innerWidth - (r.left + r.width / 2) - right - 6);
    el.style.setProperty('--notice-arrow-right', `${Math.max(10, arrowRight)}px`);

    btn.classList.add('pulse');
    requestAnimationFrame(() => el.classList.add('show'));
    el._timer = setTimeout(dismissDisplayScriptNotice, 15000);
  }

  function initDisplayScript() {
    const group = $('settingDisplayScriptGroup');
    if (group) {
      $$('.segment-btn', group).forEach(b => {
        b.addEventListener('click', () => {
          const v = normalizeDisplayScript(b.getAttribute('data-value'));
          if (v && v !== state.displayScript) {
            dismissDisplayScriptNotice();
            applyDisplayScript(v, true, { announce: true });
          }
        });
      });
    }

    updateDisplayScriptUI();
    if (isHansDisplay()) {
      applyDisplayScript('hans', false).then(ok => {
        if (ok && displayScriptAutoSelected) showDisplayScriptNotice();
      });
    } else {
      markDisplayScriptReady();
    }
  }

  // ═══════════════════════════════════════════════════════════
  // §14b LIBRARY SYNC（書籤與歷程跨裝置同步）
  //
  // 本機 localStorage 永遠是第一手資料（離線可用）。登入後，異動以「路徑 + 時間戳」
  // 逐筆送到伺服器，並拉回其他裝置的異動；規則見 library-sync.js（時間戳大者勝，刪除留墓碑）。
  // 中繼資料（meta）：uid 這份本機資料屬於誰、cursor 上次拉到的伺服器序號、
  // tb/th 書籤／歷程的墓碑、db/dh 尚未送出的路徑。
  // ═══════════════════════════════════════════════════════════
  const SYNC_URL = '/api/me/sync';
  const SYNC_PUSH_DELAY_MS = 4000;
  const SYNC_PULL_MIN_GAP_MS = 20000;
  const SYNC_POLL_MS = 90000;
  const SYNC_BEACON_MAX_BYTES = 60000;
  const LibSync = window.MdwLibrarySync;

  const librarySnap = { b: new Map(), h: new Map() };
  let syncMetaMemory = null; // localStorage 不能用（Safari 私密模式等）時的後備
  const syncRt = { timer: null, inflight: null, lastPullAt: 0, user: null, status: 'local', retryAt: 0 };

  function syncMeta() {
    let m = storage.getJson(STORAGE_KEYS.SYNC_META, null) || syncMetaMemory;
    if (!m || typeof m !== 'object') m = {};
    m.tb = m.tb || {}; m.th = m.th || {}; m.db = m.db || {}; m.dh = m.dh || {};
    m.cursor = Number(m.cursor) || 0;
    m.uid = m.uid || null;
    return m;
  }

  function saveSyncMeta(m) {
    syncMetaMemory = m;
    storage.setJson(STORAGE_KEYS.SYNC_META, m);
  }

  function rebuildLibrarySnap() {
    librarySnap.b = new Map((state.bookmarks || []).map(i => [i.filePath, i.ts]));
    librarySnap.h = new Map((state.recentFiles || []).map(i => [i.filePath, i.ts]));
  }

  /**
   * 把 state.bookmarks（'b'）或 state.recentFiles（'h'）寫回 localStorage，並與上次的快照比對：
   * 新增或時間戳變動的記為待送出，消失的記為墓碑。所有本機異動都經過這裡。
   */
  function persistLibrary(kind) {
    const isB = kind === 'b';
    const list = (isB ? state.bookmarks : state.recentFiles) || [];
    const snap = librarySnap[kind];
    const m = syncMeta();
    const tombs = isB ? m.tb : m.th;
    const dirty = isB ? m.db : m.dh;
    const now = Date.now();
    const seen = new Set();
    for (const it of list) {
      if (!it.ts) it.ts = now;
      seen.add(it.filePath);
      if (snap.get(it.filePath) !== it.ts) {
        dirty[it.filePath] = 1;
        delete tombs[it.filePath];
      }
      snap.set(it.filePath, it.ts);
    }
    for (const p of Array.from(snap.keys())) {
      if (seen.has(p)) continue;
      snap.delete(p);
      tombs[p] = Math.max(now, (tombs[p] || 0) + 1);
      dirty[p] = 1;
    }
    storage.setJson(isB ? STORAGE_KEYS.BOOKMARKS : STORAGE_KEYS.RECENT_FILES, list);
    saveSyncMeta(m);
    scheduleLibrarySync();
  }

  function wireFromLocal(kind, path, m) {
    const isB = kind === 'b';
    const list = (isB ? state.bookmarks : state.recentFiles) || [];
    const it = list.find(i => i.filePath === path);
    const tomb = (isB ? m.tb : m.th)[path] || 0;
    if (it && (it.ts || 0) >= tomb) {
      const w = { path, title: it.fileName || '', updatedAt: it.ts };
      w.pct = typeof it.pct === 'number' ? it.pct : null;
      w.line = it.line || null;
      return w;
    }
    if (tomb) return { path, title: '', updatedAt: tomb, deleted: true };
    return null;
  }

  function buildSyncBody(m) {
    const b = [], h = [];
    for (const p of Object.keys(m.db)) { const w = wireFromLocal('b', p, m); if (w) b.push(w); }
    for (const p of Object.keys(m.dh)) { const w = wireFromLocal('h', p, m); if (w) h.push(w); }
    const cap = LibSync.LIMITS.maxItemsPerRequest;
    return { cursor: m.cursor, bookmarks: b.slice(0, cap), history: h.slice(0, cap) };
  }

  function hasPendingSync() {
    const m = syncMeta();
    return Object.keys(m.db).length > 0 || Object.keys(m.dh).length > 0;
  }

  function scheduleLibrarySync(delay = SYNC_PUSH_DELAY_MS) {
    if (!syncRt.user || syncRt.timer) return;
    syncRt.timer = setTimeout(() => { syncRt.timer = null; runLibrarySync('push'); }, Math.max(delay, syncRt.retryAt - Date.now()));
  }

  function setSyncStatus(status) {
    syncRt.status = status;
    renderSyncStatus();
  }

  function renderSyncStatus() {
    const el = $('librarySyncStatus');
    if (!el) return;
    const map = {
      local: ['', false],
      syncing: ['同步中…', true],
      ok: ['已同步到你的帳號', true],
      pending: ['離線中，連線後會自動同步', true],
      error: ['同步暫時失敗，稍後會再試', true]
    };
    const [text, show] = map[syncRt.status] || ['', false];
    el.hidden = !show;
    el.textContent = text;
    el.setAttribute('data-status', syncRt.status);
  }

  function libraryItemFromWire(kind, w) {
    const isB = kind === 'b';
    const fallback = w.path.replace(/^dict:/, '').split('/').pop().replace(/\.md$/i, '');
    const base = { filePath: w.path, fileName: w.title || fallback, ts: w.updatedAt };
    if (isB) {
      base.time = new Date(w.updatedAt).toLocaleDateString(activeLocale());
      if (typeof w.pct === 'number') { base.pct = w.pct; base.line = w.line || null; }
    } else {
      base.time = new Date(w.updatedAt).toLocaleString(activeLocale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      if (typeof w.pct === 'number') { base.pct = w.pct; base.line = w.line || null; }
    }
    return base;
  }

  /** 把伺服器回傳的異動併入本機；回傳是否有變動。 */
  function applyRemoteLibrary(res, m) {
    const mb = LibSync.mergeRemote(state.bookmarks, m.tb, res.bookmarks, { make: w => libraryItemFromWire('b', w) });
    const mh = LibSync.mergeRemote(state.recentFiles, m.th, res.history, { make: w => libraryItemFromWire('h', w), cap: 20 });
    if (mb.changed) { state.bookmarks = mb.list; m.tb = mb.tombs; }
    if (mh.changed) { state.recentFiles = mh.list; m.th = mh.tombs; }
    return mb.changed || mh.changed;
  }

  /** 跨裝置的「繼續閱讀」：其他裝置讀得比較新時，以歷程第一筆為準（沒有捲動位置，用行號）。 */
  function adoptNewestHistoryAsResume() {
    const top = (state.recentFiles || [])[0];
    if (!top) return;
    const last = storage.getJson(STORAGE_KEYS.LAST_READ_PROGRESS, null);
    if (last && last.filePath === top.filePath) return;
    if (last && (last.timestamp || 0) >= (top.ts || 0)) return;
    storage.setJson(STORAGE_KEYS.LAST_READ_PROGRESS, { filePath: top.filePath, line: top.line || null, timestamp: top.ts || Date.now() });
  }

  function refreshLibraryUi() {
    rebuildLibrarySnap();
    renderBookmarksList();
    renderRecentFilesList();
    if (state.currentFile) updateBookmarkButtonUI(state.currentFile);
  }

  function runLibrarySync(reason) {
    if (!syncRt.user) return Promise.resolve(false);
    if (syncRt.inflight) return syncRt.inflight;
    syncRt.inflight = (async () => {
      try {
        const m0 = syncMeta();
        const body = buildSyncBody(m0);
        const sent = {
          b: Object.fromEntries(body.bookmarks.map(w => [w.path, w.updatedAt])),
          h: Object.fromEntries(body.history.map(w => [w.path, w.updatedAt]))
        };
        setSyncStatus('syncing');
        const r = await accountApi(SYNC_URL, { method: 'POST', body });
        if (r.status === 401) { syncRt.user = null; setSyncStatus('local'); return false; }
        if (r.status === 429) {
          syncRt.retryAt = Date.now() + (Number(r.data.retryAfter) || 30) * 1000;
          setSyncStatus('error');
          scheduleLibrarySync(30000);
          return false;
        }
        if (!r.ok) {
          setSyncStatus(r.status === 0 ? 'pending' : 'error');
          if (hasPendingSync()) scheduleLibrarySync(30000);
          return false;
        }
        syncRt.retryAt = 0;
        const m = syncMeta();
        // 送出期間若又改過同一筆，保留待送出狀態
        for (const [kind, dirty, tombs] of [['b', m.db, m.tb], ['h', m.dh, m.th]]) {
          for (const p of Object.keys(sent[kind])) {
            const cur = Math.max(librarySnap[kind].get(p) || 0, tombs[p] || 0);
            if (cur === sent[kind][p]) delete dirty[p];
          }
        }
        const changed = applyRemoteLibrary(r.data, m);
        m.cursor = r.data.cursor;
        m.uid = syncRt.user.id;
        m.tb = LibSync.pruneTombs(m.tb, Date.now());
        m.th = LibSync.pruneTombs(m.th, Date.now());
        if (changed) {
          storage.setJson(STORAGE_KEYS.BOOKMARKS, state.bookmarks);
          storage.setJson(STORAGE_KEYS.RECENT_FILES, state.recentFiles);
          adoptNewestHistoryAsResume();
        }
        saveSyncMeta(m);
        if (changed) refreshLibraryUi();
        syncRt.lastPullAt = Date.now();
        setSyncStatus('ok');
        if (hasPendingSync()) scheduleLibrarySync(SYNC_PUSH_DELAY_MS);
        return true;
      } catch (err) {
        log.warn('library sync failed', err);
        setSyncStatus('error');
        return false;
      } finally {
        syncRt.inflight = null;
      }
    })();
    return syncRt.inflight;
  }

  /** 頁面要被隱藏或關閉：用 sendBeacon（不行就 keepalive fetch）把待送出的異動送出去。 */
  function flushLibrarySyncOnHide() {
    if (!syncRt.user || !hasPendingSync()) return;
    const payload = JSON.stringify(buildSyncBody(syncMeta()));
    try {
      if (navigator.sendBeacon && payload.length < SYNC_BEACON_MAX_BYTES) {
        if (navigator.sendBeacon(SYNC_URL, new Blob([payload], { type: 'application/json' }))) return;
      }
    } catch (_) { /* 退回 fetch */ }
    try {
      if (payload.length < SYNC_BEACON_MAX_BYTES) {
        fetch(SYNC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, credentials: 'same-origin', keepalive: true }).catch(() => {});
      }
    } catch (_) { /* 放棄；下次開啟會再送 */ }
  }

  function pullLibraryIfStale() {
    if (!syncRt.user || document.visibilityState === 'hidden') return;
    if (Date.now() - syncRt.lastPullAt < SYNC_PULL_MIN_GAP_MS) return;
    runLibrarySync('pull');
  }

  /** 登入狀態改變時由 setAccountUser 呼叫。 */
  function onLibraryAccountChange(user) {
    if (!LibSync) return;
    const prev = syncRt.user;
    syncRt.user = user && !state.isSingleUser ? user : null;
    if (!syncRt.user) { setSyncStatus('local'); return; }
    if (prev && prev.id === syncRt.user.id) return;
    const m = syncMeta();
    if (m.uid && m.uid !== syncRt.user.id) {
      // 這份本機資料屬於別人（同一台電腦換帳號登入）：不可併進新帳號，直接清掉
      clearLocalLibrary();
    }
    const m2 = syncMeta();
    if (!m2.uid) {
      // 第一次登入：把這台裝置原有的書籤與歷程全部標記為待送出，與帳號上的資料合併
      m2.cursor = 0;
      for (const i of state.bookmarks || []) { if (!i.ts) i.ts = Date.now(); m2.db[i.filePath] = 1; }
      for (const i of state.recentFiles || []) { if (!i.ts) i.ts = Date.now(); m2.dh[i.filePath] = 1; }
      storage.setJson(STORAGE_KEYS.BOOKMARKS, state.bookmarks);
      storage.setJson(STORAGE_KEYS.RECENT_FILES, state.recentFiles);
    }
    m2.uid = syncRt.user.id;
    saveSyncMeta(m2);
    rebuildLibrarySnap();
    runLibrarySync('login');
  }

  function clearLocalLibrary() {
    state.bookmarks = [];
    state.recentFiles = [];
    storage.remove(STORAGE_KEYS.BOOKMARKS);
    storage.remove(STORAGE_KEYS.RECENT_FILES);
    storage.remove(STORAGE_KEYS.LAST_READ_PROGRESS);
    storage.remove(STORAGE_KEYS.SYNC_META);
    syncMetaMemory = null;
    refreshLibraryUi();
  }

  /**
   * 登出前：先把異動送上伺服器。成功才清掉本機的書籤與歷程（資料已安全在帳號上）；
   * 送不出去就保留本機資料，不會遺失。回傳是否已清除。
   */
  async function finishLibrarySyncBeforeLogout() {
    if (!syncRt.user) return false;
    if (syncRt.timer) { clearTimeout(syncRt.timer); syncRt.timer = null; }
    if (syncRt.inflight) await syncRt.inflight;
    let ok = true;
    if (hasPendingSync()) ok = await runLibrarySync('logout');
    if (ok && hasPendingSync()) ok = false;
    if (ok) clearLocalLibrary();
    return ok;
  }

  function setupLibrarySync() {
    rebuildLibrarySnap();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushLibrarySyncOnHide();
      else pullLibraryIfStale();
    });
    window.addEventListener('pagehide', flushLibrarySyncOnHide);
    window.addEventListener('online', () => runLibrarySync('online'));
    window.addEventListener('offline', () => { if (syncRt.user && hasPendingSync()) setSyncStatus('pending'); });
    setInterval(pullLibraryIfStale, SYNC_POLL_MS);
    // 同一個瀏覽器的其他分頁改了資料：重新讀取並重畫（storage 事件只在「其他」分頁觸發）
    window.addEventListener('storage', (e) => {
      if (e.key !== null && ![STORAGE_KEYS.BOOKMARKS, STORAGE_KEYS.RECENT_FILES, STORAGE_KEYS.SYNC_META].includes(e.key)) return;
      state.bookmarks = safeJsonParse(STORAGE_KEYS.BOOKMARKS, []);
      state.recentFiles = safeJsonParse(STORAGE_KEYS.RECENT_FILES, []);
      refreshLibraryUi();
    });
  }

  // ═══════════════════════════════════════════════════════════
  // §15 RECENT FILES (Top 20)
  // ═══════════════════════════════════════════════════════════
  function addRecentFile(filePath, title) {
    if (!filePath) return;
    const cleanPath = filePath.startsWith('dict:') ? filePath.slice(5) : filePath;
    const fileName = title || cleanPath.split('/').pop().replace(/\.md$/, '');
    let list = state.recentFiles || [];
    const prev = list.find(item => item.filePath === filePath);
    list = list.filter(item => item.filePath !== filePath);
    const entry = {
      filePath,
      fileName,
      time: new Date().toLocaleString(activeLocale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
      ts: Date.now()
    };
    // 沿用上次讀到的位置，直到這次捲動後由 saveReadProgress 更新
    if (prev && typeof prev.pct === 'number') { entry.pct = prev.pct; entry.line = prev.line || null; }
    list.unshift(entry);
    if (list.length > 20) {
      // 超過 20 筆被擠掉的舊紀錄不算「刪除」，不要同步成墓碑
      for (const dropped of list.slice(20)) librarySnap.h.delete(dropped.filePath);
      list = list.slice(0, 20);
    }
    state.recentFiles = list;
    persistLibrary('h');
    renderRecentFilesList();
  }

  /** 把目前讀到的位置（百分比、行號）記在最近閱讀那一筆上，給「書籤與歷程」顯示與跳回。 */
  function updateRecentProgress(filePath, pct, line) {
    const bm = (state.bookmarks || []).find(i => i.filePath === filePath);
    if (bm && !(bm.pct === pct && bm.line === (line || null))) {
      bm.pct = pct;
      bm.line = line || null;
      bm.ts = Date.now();
      persistLibrary('b');
      if (isLibraryOpen() && libraryUi.tab === 'bookmarks') renderLibrary();
    }
    const item = (state.recentFiles || []).find(i => i.filePath === filePath);
    if (!item) return;
    if (item.pct === pct && item.line === line) return;
    item.pct = pct;
    item.line = line || null;
    item.ts = Date.now();
    persistLibrary('h');
    if (isLibraryOpen() && libraryUi.tab === 'recent') renderLibrary();
  }

  /** 歷程有變動時，若「書籤與歷程」抽屜開著就重畫。 */
  function renderRecentFilesList() {
    if (isLibraryOpen()) renderLibrary();
  }

  // ═══════════════════════════════════════════════════════════
  // §16 TOAST NOTIFICATIONS
  // ═══════════════════════════════════════════════════════════
  // Stacked, queue-aware toasts. `type` picks a border color and, when the
  // message doesn't already carry an emoji, a matching icon. `type: 'loading'`
  // (or duration 0/Infinity) yields a persistent toast; dismiss it via the
  // returned handle's .dismiss(). Rapid successive events stack instead of
  // clobbering each other.
  const TOAST_ICONS = { info: 'ℹ️', success: '✅', warning: '⚠️', error: '❌', loading: '⏳' };
  const TOAST_MAX_VISIBLE = 3;
  const TOAST_HIDE_MS = 300; // keep in sync with .toast-notification transition
  // Error messages interpolate `${err.message}` (sometimes 38+ CJK chars), so the
  // 2200 ms default is too short to actually read one. 4000 ms is the floor,
  // not an override: callers passing a longer duration keep it.
  const TOAST_ERROR_MIN_MS = 4000;
  // Emoji + the check/cross dingbats (✓ ✔ ✕ ✖ ✗ ✘) callers already prepend.
  const TOAST_HAS_ICON_RE = /^(?:\p{Extended_Pictographic}|[✓-✘])/u;

  function dismissToast(el, immediate = false) {
    if (!el || !el.parentNode) return;
    if (el._toastTimer) { clearTimeout(el._toastTimer); el._toastTimer = null; }
    el.classList.remove('show');
    if (immediate) { el.remove(); return; }
    el.classList.add('hide');
    setTimeout(() => el.remove(), TOAST_HIDE_MS);
  }

  /**
   * 顯示一個堆疊式 Toast 通知。
   * type 決定邊框顏色，若訊息未含 emoji 則自動在前方插入對應圖示。
   * duration 為 0 或 Infinity 時為持久型 Toast（需手動呼叫 dismiss()）。
   * error 型別擁有 4000ms 的最短顯示時間（僅墊高，不縮短呼叫端指定的較長值）。
   * 相同 type + 文字且仍在畫面上的 Toast 不會重複堆疊，只會重置其計時器。
   * type === 'error' 的節點帶 role="alert" 以讓螢幕閱讀器即時朗讀（容器本身
   * 為 role="status" aria-live="polite"）。
   *
   * @param {string}  msg             - 通知文字
   * @param {'info'|'success'|'warning'|'error'|'loading'} [type='info'] - 類型
   * @param {number}  [duration=2200] - 顯示毫秒數（0 = 持久）
   * @returns {{ el: HTMLElement, dismiss: Function }} - 可手動關閉的 handle
   */
  function showToast(msg, type = 'info', duration = 2200) {
    const container = $('toastContainer');
    if (!container) return { dismiss() {} };

    const icon = TOAST_ICONS[type] || TOAST_ICONS.info;
    const text = TOAST_HAS_ICON_RE.test(String(msg).trim())
      ? msg : `${icon} ${msg}`;

    // Error toasts interpolate server messages and are the highest-value ones to
    // read, so enforce a floor without touching other types' duration semantics.
    if (type === 'error' && duration !== 0 && duration !== Infinity) {
      duration = Math.max(duration, TOAST_ERROR_MIN_MS);
    }

    // Message-level dedup: a mounted window can reject several chunks at once and
    // emit the same failure N times. Reuse the live node (same type + resolved
    // text) instead of stacking duplicates, refreshing its timer.
    const existing = Array.from(container.querySelectorAll('.toast-notification'))
      .find(n => !n.classList.contains('hide') && n._toastType === type && n._toastText === text);
    if (existing) {
      if (existing._toastTimer) { clearTimeout(existing._toastTimer); existing._toastTimer = null; }
      const persistentExisting = type === 'loading' || duration === 0 || duration === Infinity;
      if (!persistentExisting) {
        existing._toastTimer = setTimeout(() => dismissToast(existing), duration);
      }
      return { el: existing, dismiss() { dismissToast(existing); } };
    }

    const el = document.createElement('div');
    // Every type carries its own class (including info) so the CSS rules are the
    // single source of truth for the border colour rather than the base default.
    el.className = 'toast-notification toast-' + type;
    el.textContent = text;
    el._toastType = type;
    el._toastText = text;
    // The container is role="status" (polite); errors must interrupt, so mark the
    // individual node as an assertive alert.
    if (type === 'error') el.setAttribute('role', 'alert');
    container.appendChild(el);

    // Stack cap: evict oldest toasts past the limit so a burst never fills the screen.
    const active = Array.from(container.querySelectorAll('.toast-notification'));
    for (let i = 0; i < active.length - TOAST_MAX_VISIBLE; i++) {
      dismissToast(active[i], true);
    }

    requestAnimationFrame(() => el.classList.add('show'));

    const persistent = type === 'loading' || duration === 0 || duration === Infinity;
    if (!persistent) {
      el._toastTimer = setTimeout(() => dismissToast(el), duration);
    }

    return { el, dismiss() { dismissToast(el); } };
  }

  // ═══════════════════════════════════════════════════════════
  // §17 BOOKMARKS (localStorage)
  // ═══════════════════════════════════════════════════════════
  function toggleBookmark(filePath, title) {
    if (!filePath) {
      showToast('⚠️ 請先開啟一本經文檔案', 'warning');
      return false;
    }
    const fileName = title || filePath.split('/').pop().replace(/\.md$/, '');
    let list = state.bookmarks || [];
    const idx = list.findIndex(item => item.filePath === filePath);
    let isBookmarked = false;

    if (idx >= 0) {
      list.splice(idx, 1);
      isBookmarked = false;
      showToast('🗑️ 已從書籤移除', 'success');
    } else {
      const seen = (state.recentFiles || []).find(r => r.filePath === filePath);
      const entry = {
        filePath,
        fileName,
        time: new Date().toLocaleDateString(activeLocale()),
        ts: Date.now()
      };
      // 加書籤時帶入目前已讀的位置
      if (seen && typeof seen.pct === 'number') { entry.pct = seen.pct; entry.line = seen.line || null; }
      list.unshift(entry);
      isBookmarked = true;
      showToast('已新增至書籤', 'success');
    }

    state.bookmarks = list;
    persistLibrary('b');
    renderBookmarksList();
    updateBookmarkButtonUI(filePath);
    return isBookmarked;
  }

  function updateBookmarkButtonUI(filePath) {
    const btn = $('bookmarkBtn');
    const lbl = $('bookmarkLabel');
    if (!btn) return;

    const list = state.bookmarks || [];
    const isBookmarked = list.some(item => item.filePath === filePath);

    if (isBookmarked) {
      btn.classList.add('bookmarked');
      if (lbl) lbl.textContent = '已加書籤';
      btn.title = '取消書籤';
    } else {
      btn.classList.remove('bookmarked');
      if (lbl) lbl.textContent = '加書籤';
      btn.title = '加入書籤與最愛';
    }
  }

  /** 書籤有變動時更新選單上的書籤數，抽屜開著就重畫。 */
  function renderBookmarksList() {
    if (isLibraryOpen()) renderLibrary();
    updateLibraryCount();
  }

  // ═══════════════════════════════════════════════════════════
  // §18 READ PROGRESS AUTO-SAVE / RESTORE
  // ═══════════════════════════════════════════════════════════
  let _saveProgressTimer = null;
  function saveReadProgress(filePath) {
    if (!filePath || !state.autoReadProgress) return;
    if (_saveProgressTimer) clearTimeout(_saveProgressTimer);
    _saveProgressTimer = setTimeout(() => {
      const content = $('content');
      if (!content) return;

      // Find top visible line anchor without layout thrashing
      let currentLine = null;
      if (state.virtual && typeof estimateLineFromScrollTop === 'function') {
        currentLine = estimateLineFromScrollTop();
      } else {
        const anchors = (cachedLineAnchors && cachedLineAnchors.length > 0)
          ? cachedLineAnchors
          : Array.from($$('.line-anchor[data-line]', $('markdownBody')));
        if (anchors.length > 0) {
          const targetTop = content.getBoundingClientRect().top + 20;
          let low = 0, high = anchors.length - 1;
          let bestIdx = -1;
          while (low <= high) {
            const mid = (low + high) >> 1;
            const top = anchors[mid].getBoundingClientRect().top;
            if (top >= targetTop) {
              bestIdx = mid;
              high = mid - 1;
            } else {
              low = mid + 1;
            }
          }
          if (bestIdx !== -1) {
            currentLine = parseInt(anchors[bestIdx].getAttribute('data-line'), 10) || null;
          } else {
            currentLine = parseInt(anchors[anchors.length - 1].getAttribute('data-line'), 10) || null;
          }
        }
      }

      const progress = {
        filePath,
        scrollTop: content.scrollTop,
        line: currentLine,
        timestamp: Date.now()
      };
      storage.setJson(STORAGE_KEYS.LAST_READ_PROGRESS, progress);
      const scrollable = content.scrollHeight - content.clientHeight;
      const pct = scrollable > 0 ? Math.round(Math.min(1, Math.max(0, content.scrollTop / scrollable)) * 100) : 100;
      updateRecentProgress(filePath, pct, currentLine);
    }, 250);
  }

  /**
   * 還原上次的閱讀進度（由 localStorage 的 LAST_READ_PROGRESS 讀取）。
   *
   * 虛擬滾動檔案（大型檔與所有 `dict:` 字典檔）直接 early-return：openFile 已用
   * 絕對行號捲動定位，此時 scrollTop 沒有意義，因為區塊高度是延遲載入的；字典檔
   * 不在主樹的 fileSizes 中，故不可只用檔案大小判斷（否則會補送 scrollTo 破壞剛
   * 完成的跳轉定位）。因此一律走 isVirtualizedFile()。
   *
   * 非虛擬檔案會在 150ms / 500ms 兩個延遲點補正 scrollTop。守衛 token 必須在
   * openFile()「之後」才取得：openFile 本身會遞增 state._openToken，之後任何新開檔
   * 都會使其改變；若在呼叫前取得，token 會與 openFile 剛寫入的值不同而使還原永遠
   * 失效。延遲期間只要 token 變動或 currentFile 已非目標檔案即放棄捲動，且每次都
   * 重新查詢 #content（節點可能已被換掉）。
   *
   * @param {boolean} [force=false] - 「繼續閱讀」按鈕：使用者主動要求，不受自動恢復開關限制
   * @returns {boolean} 是否已排入還原流程（沒有可還原資料或功能關閉時為 false）
   */
  function restoreReadProgress(force = false) {
    if (!force && !state.autoReadProgress) return false;
    const data = storage.getJson(STORAGE_KEYS.LAST_READ_PROGRESS);
    if (!data || !data.filePath) return false;
    try {
      // Pass line for server-side rendering hint, but primarily use scrollTop for precise restoration
      openFile(data.filePath, data.line).then(() => {
        // 虛擬滾動檔案（大型檔與所有 dict: 字典檔）以絕對行號還原，openFile 已經捲動
        // 定位；此時 scrollTop 沒有意義，因為區塊高度是延遲載入的。字典檔不在主樹的
        // fileSizes 中，故不可只用檔案大小判斷（否則會在此對字典檔補送 scrollTo，
        // 破壞剛完成的跳轉定位）。
        if (isVirtualizedFile(data.filePath)) return;
        // 於 openFile 完成後才取得 token：openFile 本身會遞增 _openToken，之後任何
        // 新開檔都會使其改變。延遲還原期間若使用者已切換檔案，即不再捲動。
        const restoreToken = state._openToken;
        const content = $('content');
        if (!content || typeof data.scrollTop !== 'number') return;
        setTimeout(() => {
          if (state._openToken !== restoreToken || state.currentFile !== data.filePath) return;
          const c = $('content');
          if (c) c.scrollTo({ top: data.scrollTop, behavior: 'instant' });
        }, 150);
        setTimeout(() => {
          if (state._openToken !== restoreToken || state.currentFile !== data.filePath) return;
          const c = $('content');
          if (!c) return;
          c.scrollTo({ top: data.scrollTop, behavior: 'instant' });
          // Re-save after final scroll position is settled
          saveReadProgress(data.filePath);
        }, 500);
      });
      return true;
    } catch (_) {}
    return false;
  }

  // ═══════════════════════════════════════════════════════════
  // §18.5 USER PREFERENCES BACKUP (EXPORT & IMPORT)
  // ═══════════════════════════════════════════════════════════

  /**
   * 匯出並下載當前使用者的個人偏好設定、閱讀進度、書籤與歷史紀錄 (JSON 格式)
   */
  function exportUserPreferences() {
    try {
      const appVer = (window.__APP_CONFIG__ && window.__APP_CONFIG__.appVersion) ? String(window.__APP_CONFIG__.appVersion).trim() : '4.2.5';
      const cleanVer = appVer.replace(/^v/, '');

      const backupData = {
        app: 'mdWebview',
        version: cleanVer,
        exportDate: new Date().toISOString(),
        type: 'mdWebview-user-preferences',
        preferences: {
          theme: state.currentTheme || storage.get(STORAGE_KEYS.THEME) || 'obsidian-dark',
          fontSize: state.fontSize || parseInt(storage.get(STORAGE_KEYS.FONT_SIZE), 10) || 16,
          textAlign: state.textAlign || storage.get(STORAGE_KEYS.TEXT_ALIGN) || 'justify',
          lineHeight: state.lineHeight || storage.get(STORAGE_KEYS.LINE_HEIGHT) || '1.8',
          maxWidth: state.maxWidth || storage.get(STORAGE_KEYS.MAX_WIDTH) || (isMobileBrowser() ? '95%' : '800px'),
          autoS2T: state.autoS2T !== undefined ? state.autoS2T : (storage.get(STORAGE_KEYS.AUTO_S2T) === 'true'),
          displayScript: normalizeDisplayScript(state.displayScript) || normalizeDisplayScript(storage.get(STORAGE_KEYS.DISPLAY_SCRIPT)) || 'hant',
          autoReadProgress: state.autoReadProgress !== undefined ? state.autoReadProgress : (storage.get(STORAGE_KEYS.READ_PROGRESS_ENABLED) !== 'false'),
          searchMode: state.searchMode
        },
        readProgress: storage.getJson(STORAGE_KEYS.LAST_READ_PROGRESS, null),
        recentFiles: state.recentFiles || [],
        bookmarks: state.bookmarks || [],
        dictionary: {
          fileOrder: state.dictFileOrder || [],
          fileSelected: loadDictFileSelect() || []
        }
      };

      const jsonStr = JSON.stringify(backupData, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const dateStr = getTodayDateIso();
      a.href = url;
      a.download = `mdWebview-user-preferences-${dateStr}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('📥 個人自訂偏好備份已成功下載', 'success');
    } catch (err) {
      console.error('[ExportUserPreferences] 匯出失敗:', err);
      showToast('❌ 下載備份失敗：' + (err.message || '未知錯誤'), 'error');
    }
  }

  /**
   * 從使用者上傳的 JSON 備份檔中還原個人偏好與閱讀紀錄
   * @param {File} file
   */
  function importUserPreferences(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
      try {
        const text = e.target.result;
        let data;
        try {
          data = JSON.parse(text);
        } catch (jsonErr) {
          throw new Error('檔案非有效 JSON 格式');
        }

        if (!data || typeof data !== 'object') {
          throw new Error('備份檔案資料格式不正確');
        }

        // 識別標記校驗
        if (data.type && data.type !== 'mdWebview-user-preferences') {
          throw new Error('此檔案不是 mdWebview 個人偏好備份檔');
        }

        // 1. 還原外觀與排版設定
        const pref = data.preferences || {};
        if (pref.theme && typeof pref.theme === 'string') {
          applyTheme(pref.theme, true, false);
        }
        if (pref.fontSize && typeof pref.fontSize === 'number' && !isNaN(pref.fontSize)) {
          applyFontSize(pref.fontSize, true);
        }
        if (pref.textAlign && typeof pref.textAlign === 'string') {
          applyTextAlign(pref.textAlign, true);
        }
        if (pref.lineHeight && (typeof pref.lineHeight === 'string' || typeof pref.lineHeight === 'number')) {
          applyLineHeight(String(pref.lineHeight), true);
        }
        if (pref.maxWidth && typeof pref.maxWidth === 'string') {
          applyMaxWidth(pref.maxWidth, true);
        }
        if (typeof pref.autoS2T === 'boolean') {
          applyAutoS2T(pref.autoS2T, true);
        }
        // 舊版備份沒有 displayScript：保留目前設定，不回退成繁體
        if (normalizeDisplayScript(pref.displayScript) && pref.displayScript !== state.displayScript) {
          applyDisplayScript(pref.displayScript, true);
        }
        if (typeof pref.autoReadProgress === 'boolean') {
          applyAutoReadProgress(pref.autoReadProgress, true);
        }
        if (pref.searchMode === 'loose' || pref.searchMode === 'strict') {
          setSearchMode(pref.searchMode, { rerun: false });
        }

        // 2. 還原書籤最愛
        if (Array.isArray(data.bookmarks)) {
          state.bookmarks = data.bookmarks;
          persistLibrary('b');
          renderBookmarksList();
          if (state.currentFile) updateBookmarkButtonUI(state.currentFile);
        }

        // 3. 還原最近開啟檔案紀錄
        if (Array.isArray(data.recentFiles)) {
          state.recentFiles = data.recentFiles;
          persistLibrary('h');
          renderRecentFilesList();
        }

        // 4. 還原上次閱讀進度
        if (data.readProgress && typeof data.readProgress === 'object') {
          storage.setJson(STORAGE_KEYS.LAST_READ_PROGRESS, data.readProgress);
        }

        // 5. 還原辭典自訂項目
        if (data.dictionary && typeof data.dictionary === 'object') {
          if (Array.isArray(data.dictionary.fileOrder)) {
            state.dictFileOrder = data.dictionary.fileOrder;
            saveDictFileOrder();
          }
          if (Array.isArray(data.dictionary.fileSelected)) {
            saveDictFileSelect(data.dictionary.fileSelected);
          }
        }

        // 重新同步偏好面板控制元件狀態
        renderMaxWidthControl();
        showToast('✅ 已成功還原個人偏好與閱讀紀錄！', 'success');
      } catch (err) {
        console.error('[ImportUserPreferences] 還原失敗:', err);
        showToast('❌ 還原備份失敗：' + (err.message || '檔案格式無效'), 'error');
      }
    };
    reader.onerror = function() {
      showToast('❌ 讀取備份檔案失敗', 'error');
    };
    reader.readAsText(file, 'utf-8');
  }

  // ═══════════════════════════════════════════════════════════
  // §19 SIDEBAR RESIZE
  // ═══════════════════════════════════════════════════════════

  function setupResizeHandle() {
    const handle = $('resizeHandle');
    const sidebar = $('sidebar');
    let isResizing = false;
    let startX, startWidth;

    handle.addEventListener('mousedown', (e) => {
      isResizing = true;
      startX = e.clientX;
      startWidth = sidebar.offsetWidth;
      handle.classList.add('active');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      const dx = e.clientX - startX;
      const newWidth = Math.max(220, Math.min(500, startWidth + dx));
      sidebar.style.width = newWidth + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (!isResizing) return;
      isResizing = false;
      handle.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });
  }

  function setupDictResizeHandle() {
    const handle = $('dictResizeHandle');
    const sidebar = $('dictSidebar');
    if (!handle || !sidebar) return;
    let isResizing = false;
    let startX, startWidth;

    handle.addEventListener('mousedown', (e) => {
      if (sidebar.classList.contains('collapsed')) return;
      isResizing = true;
      startX = e.clientX;
      startWidth = sidebar.offsetWidth;
      handle.classList.add('active');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      // Right-side panel: dragging left widens it, so invert dx.
      const dx = startX - e.clientX;
      const newWidth = Math.max(240, Math.min(560, startWidth + dx));
      sidebar.style.width = newWidth + 'px';
      state.dictSidebarWidth = newWidth;
    });

    document.addEventListener('mouseup', () => {
      if (!isResizing) return;
      isResizing = false;
      handle.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });
  }

  // ── Settings Form Toggle Interactions ──
  function syncFooterToggleInputs() {
    const versionToggle = $('settingsEnableVersion');
    const versionInput = $('settingsVersion');
    if (versionToggle && versionInput) {
      versionInput.disabled = !versionToggle.checked;
    }
    const downloadToggle = $('settingsEnableDownload');
    const downloadInput = $('settingsDownloadUrl');
    if (downloadToggle && downloadInput) {
      downloadInput.disabled = !downloadToggle.checked;
    }
    const dictToggle = $('settingsEnableDictionary');
    const dictInput = $('settingsDictionaryPath');
    if (dictToggle && dictInput) {
      dictInput.disabled = !dictToggle.checked;
    }
    const announcementToggle = $('settingsEnableAnnouncement');
    const announcementInput = $('settingsAnnouncementMessage');
    if (announcementToggle && announcementInput) {
      announcementInput.disabled = !announcementToggle.checked;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // §6.5 MEDIA LIGHTBOX (文檔圖片全螢幕半透明放大、縮放與平移)
  // ═══════════════════════════════════════════════════════════
  const mediaLightboxState = {
    isOpen: false,
    scale: 1,
    translateX: 0,
    translateY: 0,
    isDragging: false,
    dragStartX: 0,
    dragStartY: 0,
    startTranslateX: 0,
    startTranslateY: 0,
    hasMoved: false,
    pointers: new Map(), // pointerId => { x, y }
    initialPinchDist: 0,
    initialPinchScale: 1,
    initialPinchCenter: { x: 0, y: 0 },
    previousBodyOverflow: ''
  };

  const LIGHTBOX_MIN_SCALE = 0.5;
  const LIGHTBOX_MAX_SCALE = 8.0;

  function updateLightboxTransform(transitionDuration = 0) {
    const canvas = $('mediaLightboxCanvas');
    if (!canvas) return;
    if (transitionDuration > 0) {
      canvas.style.transition = `transform ${transitionDuration}ms cubic-bezier(0.2, 0, 0.2, 1)`;
    } else {
      canvas.style.transition = 'none';
    }
    canvas.style.transform = `translate3d(${mediaLightboxState.translateX}px, ${mediaLightboxState.translateY}px, 0) scale(${mediaLightboxState.scale})`;
    const scaleText = $('mediaLightboxScaleText');
    if (scaleText) {
      scaleText.textContent = `${Math.round(mediaLightboxState.scale * 100)}%`;
    }
  }

  function zoomLightboxAt(newScale, focalX, focalY, transitionDuration = 0) {
    const viewport = $('mediaLightboxViewport');
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    const clampedScale = Math.max(LIGHTBOX_MIN_SCALE, Math.min(LIGHTBOX_MAX_SCALE, newScale));
    const oldScale = mediaLightboxState.scale;
    if (Math.abs(clampedScale - oldScale) < 0.001) return;

    // 焦點相對於圖片中心與位移的距離
    const fx = (typeof focalX === 'number') ? focalX : centerX;
    const fy = (typeof focalY === 'number') ? focalY : centerY;

    const dx = fx - centerX - mediaLightboxState.translateX;
    const dy = fy - centerY - mediaLightboxState.translateY;

    const ratio = clampedScale / oldScale;
    mediaLightboxState.translateX -= dx * (ratio - 1);
    mediaLightboxState.translateY -= dy * (ratio - 1);
    mediaLightboxState.scale = clampedScale;

    updateLightboxTransform(transitionDuration);
  }

  function resetLightboxZoom(transitionDuration = 240) {
    mediaLightboxState.scale = 1;
    mediaLightboxState.translateX = 0;
    mediaLightboxState.translateY = 0;
    updateLightboxTransform(transitionDuration);
  }

  function openMediaLightbox(src, altText = '') {
    const overlay = $('mediaLightboxOverlay');
    const img = $('mediaLightboxImg');
    const caption = $('mediaLightboxCaption');
    if (!overlay || !img) return;

    mediaLightboxState.isOpen = true;
    mediaLightboxState.scale = 1;
    mediaLightboxState.translateX = 0;
    mediaLightboxState.translateY = 0;
    mediaLightboxState.pointers.clear();
    mediaLightboxState.lastPinchDist = 0;
    mediaLightboxState.lastTapTime = 0;

    img.src = src;
    img.alt = altText || '';

    if (caption) {
      const cleanAlt = (altText || '').trim();
      if (cleanAlt) {
        caption.textContent = cleanAlt;
        caption.style.display = 'block';
      } else {
        caption.textContent = '';
        caption.style.display = 'none';
      }
    }

    resetLightboxZoom(0);

    // 鎖定頁面背景滾動
    mediaLightboxState.previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    overlay.style.display = 'flex';
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
  }

  function closeMediaLightbox() {
    const overlay = $('mediaLightboxOverlay');
    if (!overlay || !mediaLightboxState.isOpen) return;

    overlay.classList.remove('open');
    overlay.style.display = 'none';
    overlay.setAttribute('aria-hidden', 'true');
    mediaLightboxState.isOpen = false;
    mediaLightboxState.pointers.clear();
    mediaLightboxState.isDragging = false;
    mediaLightboxState.lastPinchDist = 0;

    const viewport = $('mediaLightboxViewport');
    if (viewport) viewport.classList.remove('is-dragging');

    const img = $('mediaLightboxImg');
    if (img) img.src = '';

    // 恢復背景滾動
    document.body.style.overflow = mediaLightboxState.previousBodyOverflow || '';
  }

  function initMediaLightboxEvents() {
    const overlay = $('mediaLightboxOverlay');
    const viewport = $('mediaLightboxViewport');
    const backdrop = $('mediaLightboxBackdrop');
    const closeBtn = $('mediaLightboxCloseBtn');
    const zoomInBtn = $('mediaLightboxZoomInBtn');
    const zoomOutBtn = $('mediaLightboxZoomOutBtn');
    const resetBtn = $('mediaLightboxResetBtn');
    const img = $('mediaLightboxImg');
    if (!overlay || !viewport) return;

    // 關閉按鈕
    if (closeBtn) {
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeMediaLightbox();
      });
    }

    // 縮放按鈕群
    if (zoomInBtn) {
      zoomInBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        zoomLightboxAt(mediaLightboxState.scale * 1.3, undefined, undefined, 200);
      });
    }

    if (zoomOutBtn) {
      zoomOutBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        zoomLightboxAt(mediaLightboxState.scale * 0.77, undefined, undefined, 200);
      });
    }

    if (resetBtn) {
      resetBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        resetLightboxZoom(220);
      });
    }

    // 滑鼠滾輪縮放 (Wheel Zoom)
    viewport.addEventListener('wheel', (e) => {
      if (!mediaLightboxState.isOpen) return;
      e.preventDefault();
      const delta = e.deltaY < 0 ? 1.15 : 0.87;
      zoomLightboxAt(mediaLightboxState.scale * delta, e.clientX, e.clientY, 0);
    }, { passive: false });

    // 雙擊縮放 (Double Click to Zoom 2.5x <-> 1x)
    viewport.addEventListener('dblclick', (e) => {
      if (!mediaLightboxState.isOpen) return;
      e.preventDefault();
      if (mediaLightboxState.scale <= 1.05) {
        zoomLightboxAt(2.5, e.clientX, e.clientY, 240);
      } else {
        resetLightboxZoom(240);
      }
    });

    // 指針手勢（滑鼠拖曳、單指平移、雙指捏合縮放、行動版雙擊）
    viewport.addEventListener('pointerdown', (e) => {
      if (!mediaLightboxState.isOpen) return;
      // 忽略右鍵
      if (e.button !== 0 && e.pointerType === 'mouse') return;

      mediaLightboxState.downTarget = e.target;

      try {
        viewport.setPointerCapture(e.pointerId);
      } catch (_) {}

      mediaLightboxState.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (mediaLightboxState.pointers.size === 1) {
        mediaLightboxState.isDragging = true;
        mediaLightboxState.hasMoved = false;
        mediaLightboxState.dragStartX = e.clientX;
        mediaLightboxState.dragStartY = e.clientY;
        mediaLightboxState.startTranslateX = mediaLightboxState.translateX;
        mediaLightboxState.startTranslateY = mediaLightboxState.translateY;
        viewport.classList.add('is-dragging');
      } else if (mediaLightboxState.pointers.size === 2) {
        mediaLightboxState.isDragging = false;
        mediaLightboxState.hasMoved = true;
        const pts = Array.from(mediaLightboxState.pointers.values());
        mediaLightboxState.lastPinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
        mediaLightboxState.lastPinchCenter = {
          x: (pts[0].x + pts[1].x) / 2,
          y: (pts[0].y + pts[1].y) / 2
        };
      }
    });

    viewport.addEventListener('pointermove', (e) => {
      if (!mediaLightboxState.isOpen || !mediaLightboxState.pointers.has(e.pointerId)) return;

      mediaLightboxState.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (mediaLightboxState.pointers.size === 1 && mediaLightboxState.isDragging) {
        const dx = e.clientX - mediaLightboxState.dragStartX;
        const dy = e.clientY - mediaLightboxState.dragStartY;
        if (Math.hypot(dx, dy) > 4) {
          mediaLightboxState.hasMoved = true;
        }
        mediaLightboxState.translateX = mediaLightboxState.startTranslateX + dx;
        mediaLightboxState.translateY = mediaLightboxState.startTranslateY + dy;
        updateLightboxTransform(0);
      } else if (mediaLightboxState.pointers.size === 2) {
        const pts = Array.from(mediaLightboxState.pointers.values());
        const currDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
        const currCenterX = (pts[0].x + pts[1].x) / 2;
        const currCenterY = (pts[0].y + pts[1].y) / 2;

        if (mediaLightboxState.lastPinchDist) {
          const scaleDelta = currDist / mediaLightboxState.lastPinchDist;
          const panDx = currCenterX - mediaLightboxState.lastPinchCenter.x;
          const panDy = currCenterY - mediaLightboxState.lastPinchCenter.y;
          mediaLightboxState.translateX += panDx;
          mediaLightboxState.translateY += panDy;
          zoomLightboxAt(mediaLightboxState.scale * scaleDelta, currCenterX, currCenterY, 0);
        }
        mediaLightboxState.lastPinchDist = currDist;
        mediaLightboxState.lastPinchCenter = { x: currCenterX, y: currCenterY };
      }
    });

    function handlePointerUpOrCancel(e) {
      if (!mediaLightboxState.pointers.has(e.pointerId)) return;

      try {
        if (viewport.hasPointerCapture(e.pointerId)) {
          viewport.releasePointerCapture(e.pointerId);
        }
      } catch (_) {}

      mediaLightboxState.pointers.delete(e.pointerId);

      if (mediaLightboxState.pointers.size === 0) {
        viewport.classList.remove('is-dragging');

        // 行動端雙擊 (Double Tap to Zoom 1x <-> 2.5x)
        const wasOnImg = mediaLightboxState.downTarget === img || (img && img.contains(mediaLightboxState.downTarget));
        if (!mediaLightboxState.hasMoved && wasOnImg) {
          const now = Date.now();
          if (now - (mediaLightboxState.lastTapTime || 0) < 320) {
            if (mediaLightboxState.scale <= 1.05) {
              zoomLightboxAt(2.5, e.clientX, e.clientY, 240);
            } else {
              resetLightboxZoom(240);
            }
            mediaLightboxState.lastTapTime = 0;
          } else {
            mediaLightboxState.lastTapTime = now;
          }
        } else if (!mediaLightboxState.hasMoved && mediaLightboxState.isDragging) {
          // 若點擊在背景空白處（viewport 或 backdrop），則關閉燈箱
          const wasBackground = mediaLightboxState.downTarget === viewport || mediaLightboxState.downTarget === backdrop;
          if (wasBackground) {
            closeMediaLightbox();
          }
        }
        mediaLightboxState.isDragging = false;
        mediaLightboxState.lastPinchDist = 0;
      } else if (mediaLightboxState.pointers.size === 1) {
        // 從雙指轉為單指
        const remaining = mediaLightboxState.pointers.values().next().value;
        mediaLightboxState.isDragging = true;
        mediaLightboxState.dragStartX = remaining.x;
        mediaLightboxState.dragStartY = remaining.y;
        mediaLightboxState.startTranslateX = mediaLightboxState.translateX;
        mediaLightboxState.startTranslateY = mediaLightboxState.translateY;
        mediaLightboxState.lastPinchDist = 0;
      }
    }

    viewport.addEventListener('pointerup', handlePointerUpOrCancel);
    viewport.addEventListener('pointercancel', handlePointerUpOrCancel);

    // 點擊背景遮罩關閉
    if (backdrop) {
      backdrop.addEventListener('click', (e) => {
        e.stopPropagation();
        closeMediaLightbox();
      });
    }

    // 防止 iOS 行動端燈箱開啟時背景彈動或滾動
    overlay.addEventListener('touchmove', (e) => {
      if (mediaLightboxState.isOpen) {
        e.preventDefault();
      }
    }, { passive: false });

    // 鍵盤監聽（Esc 關閉、+ 放大、- 縮小、0 重設）
    window.addEventListener('keydown', (e) => {
      if (!mediaLightboxState.isOpen) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        closeMediaLightbox();
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        zoomLightboxAt(mediaLightboxState.scale * 1.25, undefined, undefined, 180);
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        zoomLightboxAt(mediaLightboxState.scale * 0.8, undefined, undefined, 180);
      } else if (e.key === '0') {
        e.preventDefault();
        resetLightboxZoom(200);
      }
    });
  }

  // 掛載到 window 供全域與測試調用
  window.openMediaLightbox = openMediaLightbox;
  window.closeMediaLightbox = closeMediaLightbox;
  window.zoomMediaLightbox = zoomLightboxAt;
  window.resetMediaLightbox = resetLightboxZoom;
  window.mediaLightboxState = mediaLightboxState;

  // ═══════════════════════════════════════════════════════════
  // §20 EVENT LISTENERS (全站事件綁定：鍵盤、側邊欄、搜尋、排序、捲動…)
  //
  // 此區塊原本被誤歸在 §6.5 圖片燈箱之下，導致「找事件綁定」的人
  // 會在燈箱章節裡迷路。setupEventListeners() 長達約 1,270 行，是
  // 全檔最大的單一函式，內容涵蓋側邊欄切換、搜尋排序、檔案排序、
  // 捲動監聽、快捷鍵等數十個獨立綁定。與燈箱唯一的關聯只有第一行
  // 的 initMediaLightboxEvents()。
  //
  // 尾端巢狀宣告了 openUserSettingsOverlay()（§21 的入口），
  // 因為它與這裡的偏好設定事件綁定共用同一批元素查詢。
  // ═══════════════════════════════════════════════════════════

  function setupEventListeners() {
    initMediaLightboxEvents();

    // ── Social share preview image fallback ──
    const ogImg = $('ogPreviewImg') || document.getElementById('ogPreviewImg');
    if (ogImg) ogImg.addEventListener('error', () => { ogImg.src = '/icon-512.png'; }, { once: true });

    // ── Sidebar toggle ──
    $('sidebarToggle').addEventListener('click', () => {
      const sidebar = $('sidebar');
      const isNarrow = isMobileBrowser() || window.innerWidth <= 768;
      const willOpen = sidebar.classList.contains('collapsed');
      sidebar.classList.toggle('collapsed');
      state.sidebarCollapsed = sidebar.classList.contains('collapsed');
      // Mutual exclusion on mobile: if opening left sidebar, close right dictionary
      if (willOpen && isNarrow && state.dictSidebarOpen) {
        toggleDictSidebar(false);
      }
      updateSidebarBackdrop();
    });

    // ── Mobile: Backdrop click to close open sidebars ──
    $('sidebarBackdrop')?.addEventListener('click', () => {
      closeMobileSidebars();
    });

    // ── Logo / site name → go home ──
    document.querySelector('.app-logo')?.addEventListener('click', () => {
      goHome();
    });

    // ── Mobile: Close sidebars when clicking content area ──
    $('content').addEventListener('click', () => {
      if (isMobileBrowser() || window.innerWidth <= 768) {
        closeMobileSidebars();
      }
    });

    // ── Mobile & Desktop: Window resize / orientation change sync ──
    window.addEventListener('resize', debounce(() => {
      const isNarrow = isMobileBrowser() || window.innerWidth <= 768;
      if (isNarrow) {
        const leftOpen = !$('sidebar')?.classList.contains('collapsed');
        const rightOpen = state.dictSidebarOpen && !$('dictSidebar')?.classList.contains('collapsed');
        if (leftOpen && rightOpen) {
          toggleDictSidebar(false);
        }
      }
      updateSidebarBackdrop();
    }, 150));

    // ── Sidebar tabs ──
    $$('.sidebar-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        const tabName = tab.getAttribute('data-tab');
        $$('.sidebar-tab').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        $$('.sidebar-panel').forEach((p) => p.classList.remove('active'));
        const panel = document.querySelector(`.sidebar-panel[data-panel="${tabName}"]`);
        if (panel) panel.classList.add('active');
        state.sidebarTab = tabName;

        // Auto-focus search input
        if (tabName === 'search') {
          setTimeout(() => $('globalSearchInput').focus(), 100);
        }

        // When the TOC tab is opened, recenter/refresh on the active heading.
        // While hidden, scrollTop/scrollIntoView writes are no-ops; defer until after layout.
        if (tabName === 'toc') {
          requestAnimationFrame(() => {
            if (isVirtualMode()) {
              const v = state.virtual;
              const ei = (v && v._activeTocEntry >= 0) ? v._activeTocEntry : 0;
              centerTocOnEntry(ei);
            } else if (state.refreshScrollSpy) {
              state.refreshScrollSpy(true);
            }
          });
        }
      });
    });

    // ── File Sort Dropdown ──
    $('fileSortBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      $('fileSortDropdown').classList.toggle('open');
      $('searchSortDropdown').classList.remove('open');
    });
    $$('.sort-option', $('fileSortDropdown')).forEach(opt => {
      opt.addEventListener('click', () => {
        const sort = opt.getAttribute('data-sort');
        state.fileSort = sort;
        // Update active indicator and label
        $$('.sort-option', $('fileSortDropdown')).forEach(o => o.classList.remove('active'));
        opt.classList.add('active');
        const labels = { 'name-asc': '名稱↑', 'name-desc': '名稱↓', 'modified-desc': '時間↓', 'modified-asc': '時間↑' };
        $('fileSortLabel').textContent = labels[sort] || '名稱';
        $('fileSortDropdown').classList.remove('open');
        // Re-render tree with new sort (preserving active filter)
        renderFileTree();
      });
    });

    // ── File Collapse All ──
    $('fileCollapseAllBtn').addEventListener('click', collapseAllFolders);

    // ── File Tree Quick Filter ──
    const fileTreeFilterInput = $('fileTreeFilterInput');
    const fileTreeFilterClear = $('fileTreeFilterClear');
    if (fileTreeFilterInput) {
      const debouncedFileFilter = debounce((v) => applyFileTreeFilter(v), 60);
      fileTreeFilterInput.addEventListener('compositionstart', () => {
        _isFileFilterComposing = true;
        cancelFileTreeFilterLog();
      });
      fileTreeFilterInput.addEventListener('compositionend', () => {
        _isFileFilterComposing = false;
        const val = fileTreeFilterInput.value;
        if (fileTreeFilterClear) fileTreeFilterClear.hidden = !val.trim();
        applyFileTreeFilter(val);
        scheduleFileTreeFilterLog(val);
      });
      fileTreeFilterInput.addEventListener('input', (e) => {
        const val = e.target.value;
        if (fileTreeFilterClear) fileTreeFilterClear.hidden = !val.trim();
        debouncedFileFilter(val);
        if (e.isComposing || _isFileFilterComposing) {
          cancelFileTreeFilterLog();
        } else {
          scheduleFileTreeFilterLog(val);
        }
      });
      fileTreeFilterInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && fileTreeFilterInput.value) {
          e.preventDefault();
          e.stopPropagation();
          applyFileTreeFilter('');
        }
      });
    }
    if (fileTreeFilterClear) {
      fileTreeFilterClear.addEventListener('click', () => {
        applyFileTreeFilter('');
        if (fileTreeFilterInput) fileTreeFilterInput.focus();
      });
    }

    // ── Search Sort Dropdown ──
    $('searchSortBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      $('searchSortDropdown').classList.toggle('open');
      $('fileSortDropdown').classList.remove('open');
    });
    $$('.sort-option', $('searchSortDropdown')).forEach(opt => {
      opt.addEventListener('click', () => {
        const sort = opt.getAttribute('data-sort');
        state.searchSort = sort;
        $$('.sort-option', $('searchSortDropdown')).forEach(o => o.classList.remove('active'));
        opt.classList.add('active');
        const labels = { 'relevance': '相關性', 'file-asc': '檔名↑', 'file-desc': '檔名↓', 'count-desc': '命中↓' };
        $('searchSortLabel').textContent = labels[sort] || '相關性';
        $('searchSortDropdown').classList.remove('open');
        // Re-render with new sort (if we have data)
        if (state.lastSearchData) renderSearchResults(state.lastSearchData);
      });
    });

    // ── Search Mode (Loose ≈ / Strict =) ──
    const searchModeBtn = $('searchModeBtn');
    if (searchModeBtn) {
      updateSearchModeUI();
      searchModeBtn.addEventListener('click', () => {
        setSearchMode(state.searchMode === 'loose' ? 'strict' : 'loose');
      });
    }

    // ── Search Collapse All ──
    $('searchCollapseAllBtn').addEventListener('click', searchCollapseAll);

    // ── TOC Collapse All ──
    $('tocCollapseAllBtn').addEventListener('click', tocCollapseAll);

    // ── TOC Quick Filter ──
    const tocFilterInput = $('tocFilterInput');
    const tocFilterClear = $('tocFilterClear');
    if (tocFilterInput) {
      const debouncedTocFilter = debounce((v) => applyTocFilter(v), 50);
      tocFilterInput.addEventListener('input', (e) => {
        const val = e.target.value;
        if (tocFilterClear) tocFilterClear.hidden = !val.trim();
        debouncedTocFilter(val);
      });
      tocFilterInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && tocFilterInput.value) {
          e.preventDefault();
          e.stopPropagation();
          applyTocFilter('');
        }
      });
    }
    if (tocFilterClear) {
      tocFilterClear.addEventListener('click', () => {
        applyTocFilter('');
        if (tocFilterInput) tocFilterInput.focus();
      });
    }

    // ── Close dropdowns on outside click ──
    document.addEventListener('click', () => {
      $('fileSortDropdown').classList.remove('open');
      $('searchSortDropdown').classList.remove('open');
    });

    // ── Theme ──
    const themeSel = $('themeSelect');
    if (themeSel) {
      themeSel.addEventListener('change', (e) => {
        applyTheme(e.target.value, true, true);
      });
    }

    // ── Footnotes & Line Anchor Click Delegation ──
    $('markdownBody').addEventListener('click', (e) => {
      // ── Media Image Lightbox Click ──
      const imgEl = e.target.closest('img');
      if (imgEl && $('markdownBody').contains(imgEl)) {
        const src = imgEl.currentSrc || imgEl.getAttribute('src') || imgEl.src;
        if (src) {
          e.preventDefault();
          e.stopPropagation();
          openMediaLightbox(src, imgEl.getAttribute('alt') || imgEl.getAttribute('title') || '');
          return;
        }
      }

      // ── Line Anchor / Line Link Click ──
      const lineEl = e.target.closest('.line-anchor, [data-line]');
      if (lineEl && !e.target.closest('a, button, input, select, textarea')) {
        const lineVal = lineEl.getAttribute('data-line') || (lineEl.id && lineEl.id.replace(/^L/, ''));
        const lineNum = lineVal ? parseInt(lineVal, 10) : null;
        if (lineNum && state.currentFile) {
          const cleanFile = state.currentFile.split('&').join('%26').split('#').join('%23');
          const lineSearch = `?file=${cleanFile}&line=${lineNum}`;
          const newUrl = window.location.pathname + lineSearch;
          history.pushState(null, '', newUrl);

          const fullLineUrl = window.location.origin + window.location.pathname + lineSearch;
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(fullLineUrl).then(
              () => showToast(`✓ 已複製第 ${lineNum} 行分享連結`, 'success'),
              () => showToast('❌ 複製失敗（剪貼簿權限被拒）', 'error')
            );
          } else {
            if (fallbackCopy(fullLineUrl)) showToast(`✓ 已複製第 ${lineNum} 行分享連結`, 'success');
            else showToast('❌ 複製失敗', 'error');
          }
          scrollToLine(lineNum);
        }
      }

      // ── Wikilink Click Delegation ──
      const wikilink = e.target.closest('.wikilink');
      if (wikilink) {
        e.preventDefault();
        handleWikilinkClick(wikilink);
        return;
      }

      const refLink = e.target.closest('.footnote-ref');
      if (refLink) {
        e.preventDefault();
        const targetId = refLink.getAttribute('href').substring(1);
        const targetEl = document.getElementById(targetId);
        if (targetEl) {
          safeScrollToElement(targetEl, $('content'), 'center');
          targetEl.classList.add('highlight-flash');
          setTimeout(() => {
            targetEl.classList.remove('highlight-flash');
          }, 2000);
        }
        return;
      }

      const backLink = e.target.closest('.footnote-backlink');
      if (backLink) {
        e.preventDefault();
        const targetId = backLink.getAttribute('href').substring(1);
        const targetEl = document.getElementById(targetId);
        if (targetEl) {
          safeScrollToElement(targetEl, $('content'), 'center');
          targetEl.classList.add('highlight-flash');
          setTimeout(() => {
            targetEl.classList.remove('highlight-flash');
          }, 2000);
        }
        return;
      }

      // ── Standard internal anchor links <a href="#..."> ──
      const anchorLink = e.target.closest('a[href^="#"]');
      if (anchorLink) {
        const href = anchorLink.getAttribute('href');
        if (href && href.length > 1) {
          e.preventDefault();
          scrollToHeadingByText(href.substring(1));
        }
      }
    });

    // ── Media Image Click Capture (Global - Desktop & Mobile) ──
    document.addEventListener('click', (e) => {
      const imgEl = e.target.closest('img');
      if (!imgEl) return;
      if (imgEl.closest('#mediaLightboxOverlay') ||
          imgEl.closest('#appHeader') ||
          imgEl.closest('#sidebarTabs') ||
          imgEl.closest('.modal-header') ||
          imgEl.classList.contains('tab-icon') ||
          imgEl.classList.contains('logo-icon')) {
        return;
      }
      if (imgEl.closest('.markdown-body') ||
          imgEl.closest('#markdownBody') ||
          imgEl.closest('#contentWrapper') ||
          imgEl.closest('.dict-body') ||
          imgEl.closest('#dictResults') ||
          imgEl.classList.contains('markdown-img')) {
        const src = imgEl.currentSrc || imgEl.getAttribute('src') || imgEl.src;
        if (src) {
          e.preventDefault();
          e.stopPropagation();
          openMediaLightbox(src, imgEl.getAttribute('alt') || imgEl.getAttribute('title') || '');
        }
      }
    }, true);

    // ── Font size ──
    const fontDec = $('fontDecrease');
    if (fontDec) fontDec.addEventListener('click', () => applyFontSize(state.fontSize - 1));
    const fontInc = $('fontIncrease');
    if (fontInc) fontInc.addEventListener('click', () => applyFontSize(state.fontSize + 1));

    // ── Global search (Triggers ONLY on Enter key or Search button click) ──
    const searchInput = $('globalSearchInput');
    const searchBtn = $('globalSearchBtn');

    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        if (!e.target.value.trim()) {
          if (searchAbortController) {
            searchAbortController.abort();
            searchAbortController = null;
          }
          state.lastSearchData = null;
          $('searchResults').innerHTML = '<div class="panel-placeholder"><span class="placeholder-icon">🔍</span><span>輸入關鍵詞開始搜尋</span></div>';
        }
      });
      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          performGlobalSearch(searchInput.value);
        }
      });
    }

    if (searchBtn) {
      searchBtn.addEventListener('click', () => {
        if (searchInput) {
          performGlobalSearch(searchInput.value);
        }
      });
    }

    // ── Search results container click event delegation (bound ONCE) ──
    const searchResultsContainer = $('searchResults');
    if (searchResultsContainer) {
      searchResultsContainer.addEventListener('click', (e) => {
        // Load-more button: render another batch of results without re-fetching.
        if (e.target.closest('.search-load-more')) {
          state.searchRenderLimit = (state.searchRenderLimit || SEARCH_RENDER_BATCH) + SEARCH_RENDER_BATCH;
          if (state.lastSearchData) renderSearchResultsPortion($('searchResults'), state.lastSearchData);
          return;
        }

        // Toggle / Expand file header node
        const fileEl = e.target.closest('.search-result-file');
        if (fileEl) {
          const groupEl = fileEl.closest('.search-result-group');
          const body = groupEl ? groupEl.querySelector('.search-result-group-body') : fileEl.nextElementSibling;
          const chevron = fileEl.querySelector('.search-result-file-chevron');
          if (body) {
            const isCollapsed = body.classList.contains('collapsed');
            if (isCollapsed) {
              // Expand sub nodes
              body.classList.remove('collapsed');
              if (chevron) chevron.classList.remove('collapsed');
            } else {
              // Collapse sub nodes
              body.classList.add('collapsed');
              if (chevron) chevron.classList.add('collapsed');
            }
          }
          return;
        }

        // Open-file click on result item — pass line number for auto-scrolling
        const itemEl = e.target.closest('.search-result-item');
        if (itemEl) {
          const file = itemEl.getAttribute('data-file');
          const line = itemEl.getAttribute('data-line');
          const query = (state.lastSearchData && state.lastSearchData.query) || $('globalSearchInput')?.value || '';
          const searchMode = (state.lastSearchData && state.lastSearchData.mode) || state.searchMode || 'loose';
          openFile(file, line ? parseInt(line, 10) : null, query, searchMode);
        }
      });
    }

    // ── Page search ──
    const debouncedPageSearch = debounce(doPageSearch, 200);
    $('pageSearchInput').addEventListener('input', (e) => {
      debouncedPageSearch(e.target.value);
    });
    $('pageSearchInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) {
          navigatePageSearch(-1);
        } else {
          navigatePageSearch(1);
        }
      }
      if (e.key === 'Escape') {
        closePageSearch();
      }
    });
    $('pageSearchPrev').addEventListener('click', () => navigatePageSearch(-1));
    $('pageSearchNext').addEventListener('click', () => navigatePageSearch(1));
    $('pageSearchClose').addEventListener('click', closePageSearch);

    // ── Header Page Search Button ──
    const headerSearchBtn = $('headerPageSearchBtn');
    if (headerSearchBtn) {
      headerSearchBtn.addEventListener('click', () => {
        const bar = $('pageSearchBar');
        if (bar && bar.classList.contains('visible')) {
          closePageSearch();
        } else {
          openPageSearch();
        }
      });
    }

    // ── Dictionary Lookup Panel ──
    const dictToggleBtn = $('dictToggleBtn');
    if (dictToggleBtn) {
      dictToggleBtn.addEventListener('click', () => toggleDictSidebar());
    }
    const dictSidebarClose = $('dictSidebarClose');
    if (dictSidebarClose) {
      dictSidebarClose.addEventListener('click', () => toggleDictSidebar(false));
    }
    const dictFileListToggle = $('dictFileListToggle');
    if (dictFileListToggle) {
      dictFileListToggle.addEventListener('click', () => toggleDictFileList());
    }
    const dictTabs = $('dictTabs');
    if (dictTabs) {
      dictTabs.addEventListener('click', (e) => {
        const tab = e.target.closest('.dict-tab');
        if (!tab) return;
        const newMode = tab.getAttribute('data-mode') || 'prefix';
        if (state.dictMode === newMode) return;
        if (state.dictMode === 'fulltext' && $('dictResults')) {
          state.dictFulltextScrollTop = $('dictResults').scrollTop;
        }
        // A mode switch is a new result context: drop the page walk so the next
        // full-text search starts fresh at page 0.
        state.dictFulltextCache = null;
        state.dictMode = newMode;
        $$('.dict-tab', dictTabs).forEach(t => t.classList.toggle('active', t === tab));
        runDictSearch($('dictSearchInput')?.value || '');
      });
    }
    const dictSearchInput = $('dictSearchInput');
    if (dictSearchInput) {
      const debouncedDictSearch = debounce((v) => runDictSearch(v), 80);
      dictSearchInput.addEventListener('input', (e) => debouncedDictSearch(e.target.value));
    }
    const dictFileList = $('dictFileList');
    if (dictFileList) {
      dictFileList.addEventListener('change', (e) => {
        const cb = e.target.closest('input[data-dict-file]');
        if (!cb) return;
        const idx = parseInt(cb.getAttribute('data-dict-file'), 10);
        if (state.dictSelected === null) state.dictSelected = new Set();
        if (cb.checked) state.dictSelected.add(idx);
        else state.dictSelected.delete(idx);
        // Changing the selected dictionary set invalidates the page walk (its cursors
        // are keyed by file path), so drop the whole cache and restart at page 0.
        state.dictFulltextCache = null;
        state.dictFulltextScrollTop = 0;
        persistDictSelection();
        renderDictFileList();
        runDictSearch($('dictSearchInput')?.value || '');
      });
      dictFileList.addEventListener('click', (e) => {
        const allBtn = e.target.closest('[data-dict-toggle-all]');
        if (!allBtn) return;
        const files = (state.dictHeadwords && state.dictHeadwords.files) || [];
        const allOn = files.every((_, i) => state.dictSelected && state.dictSelected.has(i));
        state.dictSelected = new Set(allOn ? [] : files.map((_, i) => i));
        state.dictFulltextCache = null;
        state.dictFulltextScrollTop = 0;
        persistDictSelection();
        renderDictFileList();
        runDictSearch($('dictSearchInput')?.value || '');
      });

      // ── Drag-to-reorder dictionary file list ──
      // Driven by Pointer Events instead of HTML5 drag-and-drop, which iOS Safari
      // never fires. The whole item is the grab surface: a quick tap (no movement)
      // falls through to the native label → checkbox toggle, while a drag past a
      // small threshold reorders the item. `.dict-file-item { touch-action: none }`
      // (style.css) lets the gesture register on iOS instead of scrolling the list.
      const DRAG_THRESHOLD = 8; // px of movement before a touch counts as a drag
      let _dictDragFi = -1;
      let _dictDragOverFi = -1;
      let _dictDragBefore = true;
      let _dictDragPointerId = null;
      let _dictDragStartY = 0;
      let _dictDragActive = false;
      let _dictDragSuppressClick = false;
      const clearDictDragMarks = () => {
        $$('.dict-file-item', dictFileList).forEach(el => el.classList.remove('dragging', 'drag-over', 'drag-over-after'));
      };
      const dictItemAtY = (y) => {
        const items = $$('.dict-file-item', dictFileList);
        for (const item of items) {
          const r = item.getBoundingClientRect();
          if (y >= r.top && y <= r.bottom) {
            return { item, fi: parseInt(item.getAttribute('data-dict-drag'), 10), rect: r };
          }
        }
        return null;
      };
      const onDictDragMove = (e) => {
        if (_dictDragFi < 0 || e.pointerId !== _dictDragPointerId) return;
        if (!_dictDragActive) {
          if (Math.abs(e.clientY - _dictDragStartY) < DRAG_THRESHOLD) return;
          _dictDragActive = true;
          _dictDragSuppressClick = true;
          const src = Array.from($$('.dict-file-item', dictFileList))
            .find(el => parseInt(el.getAttribute('data-dict-drag'), 10) === _dictDragFi);
          if (src) src.classList.add('dragging');
        }
        e.preventDefault();
        const over = dictItemAtY(e.clientY);
        if (!over || over.fi === _dictDragFi) { _dictDragOverFi = -1; clearDictDragMarks(); return; }
        _dictDragOverFi = over.fi;
        _dictDragBefore = (e.clientY - over.rect.top) < (over.rect.height / 2);
        $$('.dict-file-item', dictFileList).forEach(el => el.classList.remove('drag-over', 'drag-over-after'));
        over.item.classList.add(_dictDragBefore ? 'drag-over' : 'drag-over-after');
      };
      const onDictDragEnd = () => {
        document.removeEventListener('pointermove', onDictDragMove);
        document.removeEventListener('pointerup', onDictDragEnd);
        document.removeEventListener('pointercancel', onDictDragEnd);
        if (_dictDragActive && _dictDragFi >= 0 && _dictDragOverFi >= 0 && _dictDragOverFi !== _dictDragFi) {
          reorderDictFiles(_dictDragFi, _dictDragOverFi, _dictDragBefore);
        }
        _dictDragFi = -1;
        _dictDragOverFi = -1;
        _dictDragPointerId = null;
        _dictDragStartY = 0;
        _dictDragActive = false;
        clearDictDragMarks();
        // Clear the click-suppression latch after any trailing click has fired.
        setTimeout(() => { _dictDragSuppressClick = false; }, 0);
      };
      dictFileList.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        const item = e.target.closest('.dict-file-item');
        if (!item) return;
        const fi = parseInt(item.getAttribute('data-dict-drag'), 10);
        if (Number.isNaN(fi)) return;
        _dictDragFi = fi;
        _dictDragOverFi = -1;
        _dictDragBefore = true;
        _dictDragPointerId = e.pointerId;
        _dictDragStartY = e.clientY;
        _dictDragActive = false;
        _dictDragSuppressClick = false;
        document.addEventListener('pointermove', onDictDragMove);
        document.addEventListener('pointerup', onDictDragEnd);
        document.addEventListener('pointercancel', onDictDragEnd);
      });
      // After a real drag the browser may still emit a click on the label; swallow
      // it so the checkbox is not toggled unintentionally. Capture phase so it runs
      // before the label's default activation.
      dictFileList.addEventListener('click', (e) => {
        if (!_dictDragSuppressClick) return;
        _dictDragSuppressClick = false;
        e.preventDefault();
        e.stopPropagation();
      }, true);
    }
    const dictResults = $('dictResults');
    if (dictResults) {
      dictResults.addEventListener('click', (e) => {
        // Full-text pager controls. Handled before the group/item delegation so a
        // click on 上一頁 / 下一頁 never falls through to a result open.
        const pageBtn = e.target.closest('[data-dict-page]');
        if (pageBtn) {
          if (pageBtn.disabled) return;
          const dir = pageBtn.getAttribute('data-dict-page');
          if (dir === 'next') dictFulltextNextPage();
          else if (dir === 'prev') dictFulltextPrevPage();
          return;
        }
        // Clicking a dictionary name header collapses/uncollapses that group's results.
        const fileHeader = e.target.closest('.dict-result-file');
        if (fileHeader) {
          const group = fileHeader.closest('.dict-result-group');
          if (group) group.classList.toggle('collapsed');
          return;
        }
        const item = e.target.closest('.dict-result-item');
        if (!item) return;
        const file = item.getAttribute('data-file');
        const line = item.getAttribute('data-line');
        if (!file) return;
        const query = ($('dictSearchInput')?.value || '').trim();
        sendDictEvent('lookup', { file, headword: item.getAttribute('data-headword') || '', query });
        const highlight = state.dictMode === 'fulltext' ? query : null;
        openFile(file, line ? parseInt(line, 10) : null, highlight || null);
        // On touch/narrow screens the right dict panel overlays the reader, so
        // collapse it once a result is opened to reveal the entry.
        if (isMobileBrowser()) toggleDictSidebar(false);
      });
      // Per-page scroll memory: record the current page's scroll offset as the user
      // scrolls (also mirrored into state.dictFulltextScrollTop on tab switch).
      dictResults.addEventListener('scroll', () => {
        if (state.dictMode !== 'fulltext') return;
        const cache = state.dictFulltextCache;
        const page = cache && Array.isArray(cache.pages) ? cache.pages[cache.pageIndex] : null;
        if (page) page.scrollTop = dictResults.scrollTop;
        state.dictFulltextScrollTop = dictResults.scrollTop;
      }, { passive: true });
    }
    const entryNavPrev = $('entryNavPrev');
    const entryNavNext = $('entryNavNext');
    if (entryNavPrev) entryNavPrev.addEventListener('click', () => dictNavStep(-1));
    if (entryNavNext) entryNavNext.addEventListener('click', () => dictNavStep(1));
    syncDictToggleVisibility();

    // ── Content Header Action Delegation (Copy-link & Bookmark) ──
    const contentHeader = $('contentHeader');
    if (contentHeader) {
      contentHeader.addEventListener('click', (e) => {
        const copyBtn = e.target.closest('#copyLinkBtn');
        if (copyBtn) {
          e.preventDefault();
          const lbl = copyBtn.querySelector('#copyLinkLabel');
          const url = decodeURIComponent(window.location.href);
          const doConfirm = () => {
            if (lbl) lbl.textContent = '✓ 已複製';
            copyBtn.classList.add('copied');
            showToast('🔗 已複製經文連結至剪貼簿', 'success');
            setTimeout(() => {
              if (lbl) lbl.textContent = '連結';
              copyBtn.classList.remove('copied');
            }, 2000);
          };
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).then(doConfirm).catch(() => {
              if (fallbackCopy(url)) doConfirm(); else showToast('❌ 複製失敗', 'error');
            });
          } else {
            if (fallbackCopy(url)) doConfirm(); else showToast('❌ 複製失敗', 'error');
          }
          return;
        }

        const bkmBtn = e.target.closest('#bookmarkBtn');
        if (bkmBtn) {
          e.preventDefault();
          const currentFile = state.currentFile;
          if (currentFile) {
            const titleEl = contentHeader.querySelector('.file-title');
            const title = titleEl ? titleEl.textContent : '';
            toggleBookmark(currentFile, title);
          }
        }
      });
    }

    // ── Keyboard shortcuts ──
    document.addEventListener('keydown', (e) => {
      // ESC key → Exit open modals / settings overlays / search bar
      if (e.key === 'Escape') {
        if (isUserMenuOpen()) {
          closeUserMenu(true);
          return;
        }
        if (isLibraryOpen()) {
          closeLibrary();
          return;
        }
        const annOverlay = $('announcementModalOverlay');
        if (annOverlay && annOverlay.style.display !== 'none' && annOverlay.style.display !== '') {
          closeAnnouncementModal(true);
          return;
        }
        const adminOverlay = $('adminSettingsOverlay');
        if (adminOverlay && adminOverlay.style.display !== 'none' && adminOverlay.style.display !== '') {
          closeAdminModal();
          return;
        }
        const userOverlay = $('userSettingsOverlay');
        if (userOverlay && userOverlay.style.display !== 'none' && userOverlay.style.display !== '') {
          closeUserSettingsModal();
          return;
        }
        const setupOverlay = $('adminSetupOverlay');
        if (setupOverlay && setupOverlay.style.display !== 'none' && setupOverlay.style.display !== '') {
          setupOverlay.style.display = 'none';
          return;
        }
        const pageSearch = $('pageSearchBar');
        if (pageSearch && pageSearch.classList.contains('visible')) {
          closePageSearch();
          return;
        }
        if (state.dictSidebarOpen) {
          toggleDictSidebar(false);
          return;
        }
        if ((isMobileBrowser() || window.innerWidth <= 768) && !$('sidebar')?.classList.contains('collapsed')) {
          closeMobileSidebars();
          return;
        }
      }

      // Ctrl/Cmd + F → page search
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        if (state.currentFile) {
          e.preventDefault();
          openPageSearch();
        }
      }
      // Ctrl/Cmd + +/= → increase font
      if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '=')) {
        e.preventDefault();
        applyFontSize(state.fontSize + 1);
      }
      // Ctrl/Cmd + - → decrease font
      if ((e.ctrlKey || e.metaKey) && e.key === '-') {
        e.preventDefault();
        applyFontSize(state.fontSize - 1);
      }

      // Ctrl/Cmd + S → Quick save in Admin Settings Modal
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        const adminOverlay = $('adminSettingsOverlay');
        if (adminOverlay && adminOverlay.style.display !== 'none' && adminOverlay.style.display !== '') {
          e.preventDefault();
          const paneConfig = $('adminPaneConfig');
          const paneSeo = $('adminPaneSeo');
          const paneSuggest = $('adminPaneSuggest');
          if (paneConfig && paneConfig.style.display !== 'none') {
            performSaveSettings(false, false);
          } else if (paneSeo && paneSeo.style.display !== 'none') {
            const form = $('adminSeoForm');
            if (form) {
              if (typeof form.requestSubmit === 'function') form.requestSubmit();
              else form.dispatchEvent(new Event('submit', { cancelable: true }));
            }
          } else if (paneSuggest && paneSuggest.style.display !== 'none') {
            const form = $('adminSuggestForm');
            if (form) {
              if (typeof form.requestSubmit === 'function') form.requestSubmit();
              else form.dispatchEvent(new Event('submit', { cancelable: true }));
            }
          }
        }
      }
    });

    // Modal backdrop click exit listener
    ['userSettingsOverlay', 'adminSettingsOverlay', 'adminSetupOverlay'].forEach(id => {
      const el = $(id);
      if (el) {
        el.addEventListener('click', (evt) => {
          if (evt.target === el) {
            if (id === 'adminSettingsOverlay') {
              closeAdminModal();
            } else if (id === 'userSettingsOverlay') {
              closeUserSettingsModal();
            } else {
              el.style.display = 'none';
            }
          }
        });
      }
    });

    // ── Back to top ──
    const backToTop = $('backToTop');
    const contentEl = $('content');
    let scrollRafPending = false;
    contentEl.addEventListener('scroll', () => {
      if (state.currentFile) {
        saveReadProgress(state.currentFile);
      }
      if (scrollRafPending) return;
      scrollRafPending = true;
      requestAnimationFrame(() => {
        backToTop.classList.toggle('visible', contentEl.scrollTop > 400);
        scrollRafPending = false;
      });
    });
    backToTop.addEventListener('click', () => {
      contentEl.scrollTo({ top: 0, behavior: 'smooth' });
    });

    // ── Sidebar resize ──
    setupResizeHandle();
    setupDictResizeHandle();
    setupSelectionPopup();

    // ── 右上角整合選單 ──
    setupUserMenu();

    // ── Setting Menu Tab Navigation ──
    $$('.settings-tab-btn', $('userSettingsTabsNav')).forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-tab');
        $$('.settings-tab-btn', $('userSettingsTabsNav')).forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        btn.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
        $$('.settings-tab-pane', $('userSettingsOverlay')).forEach(pane => {
          pane.style.display = pane.id === `pane-${tab}` ? 'flex' : 'none';
        });
        if (tab === 'recommended') {
          fetchSuggestList(false);
        }
      });
    });

    // ── Setting Menu Controls ──
    const settingThemeSel = $('settingThemeSelect');
    if (settingThemeSel) {
      settingThemeSel.addEventListener('change', (e) => applyTheme(e.target.value));
    }

    const textAlignGroup = $('settingTextAlignGroup');
    if (textAlignGroup) {
      $$('.segment-btn', textAlignGroup).forEach(btn => {
        btn.addEventListener('click', () => applyTextAlign(btn.getAttribute('data-value')));
      });
    }

    const lineHeightGroup = $('settingLineHeightGroup');
    if (lineHeightGroup) {
      $$('.segment-btn', lineHeightGroup).forEach(btn => {
        btn.addEventListener('click', () => applyLineHeight(btn.getAttribute('data-value')));
      });
    }

    const maxWidthGroup = $('settingMaxWidthGroup');
    if (maxWidthGroup) {
      $$('.segment-btn', maxWidthGroup).forEach(btn => {
        btn.addEventListener('click', () => applyMaxWidth(btn.getAttribute('data-value')));
      });
    }

    const autoProgressCheck = $('settingAutoReadProgressCheck');
    if (autoProgressCheck) {
      autoProgressCheck.addEventListener('change', (e) => applyAutoReadProgress(e.target.checked));
    }

    const looseSearchCheck = $('settingLooseSearchCheck');
    if (looseSearchCheck) {
      looseSearchCheck.addEventListener('change', (e) => setSearchMode(e.target.checked ? 'loose' : 'strict'));
    }

    const autoS2TCheck = $('settingAutoS2TCheck');
    if (autoS2TCheck) {
      autoS2TCheck.addEventListener('change', (e) => applyAutoS2T(e.target.checked));
    }

    $('userSettingsCloseBtn').addEventListener('click', () => {
      closeUserSettingsModal();
    });
    $('userSettingsDoneBtn').addEventListener('click', () => {
      closeUserSettingsModal();
    });

    // ── User Preferences Backup & Restore ──
    const btnExportPref = $('btnExportUserPreferences');
    if (btnExportPref) {
      btnExportPref.addEventListener('click', () => {
        exportUserPreferences();
      });
    }

    const btnImportPref = $('btnImportUserPreferences');
    const inputImportPref = $('inputImportUserPreferences');
    if (btnImportPref && inputImportPref) {
      btnImportPref.addEventListener('click', () => {
        inputImportPref.click();
      });
      inputImportPref.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (file) {
          importUserPreferences(file);
        }
        inputImportPref.value = '';
      });
    }

    // Announcement Modal Listeners (Ack, Close X, Backdrop Click)
    const annAckBtn = $('announcementModalAckBtn');
    if (annAckBtn) {
      annAckBtn.addEventListener('click', () => {
        closeAnnouncementModal(true);
      });
    }
    const annCloseBtn = $('announcementModalCloseBtn');
    if (annCloseBtn) {
      annCloseBtn.addEventListener('click', () => {
        closeAnnouncementModal(true);
      });
    }
    const annOverlay = $('announcementModalOverlay');
    if (annOverlay) {
      annOverlay.addEventListener('click', (e) => {
        if (e.target === annOverlay) {
          closeAnnouncementModal(true);
        }
      });
    }

    // Menu Sub-Modals (登入 / Admin Vault Settings)
    $('menuOpenAdminLoginBtn').addEventListener('click', () => {
      closeUserSettingsModal();
      openAccountAuth('login');
    });

    const vaultBtn = $('menuOpenVaultSettingsBtn');
    if (vaultBtn) {
      vaultBtn.addEventListener('click', async () => {
        $('userSettingsOverlay').style.display = 'none';
        await openSettingsOverlay();
      });
    }

    // ── Single-User Local Maintenance ──
    // A desktop/mobile bundle has no administrator account, so these actions are
    // authorised by the loopback origin instead of a password (lib/auth.js).
    // They send no token: there is none to send.
    const localStatus = $('localMaintenanceStatus');

    function setLocalStatus(message, kind) {
      if (!localStatus) return;
      if (!message) {
        localStatus.style.display = 'none';
        localStatus.textContent = '';
        return;
      }
      localStatus.style.display = 'block';
      localStatus.textContent = message;
      localStatus.classList.toggle('is-busy', kind === 'busy');
      localStatus.classList.toggle('is-error', kind === 'error');
    }

    /**
     * Run one local maintenance action with consistent busy/error reporting.
     * @param {string} label   human-readable action name for messages
     * @param {string} path    /api/admin/... endpoint
     * @param {string} doneMsg message shown on success
     */
    async function runLocalMaintenance(label, path, doneMsg) {
      setLocalStatus(`⏳ ${label}中，請稍候…（大型經論庫可能需要數分鐘）`, 'busy');
      try {
        const res = await fetch(path, { method: 'POST' });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setLocalStatus(`❌ ${label}失敗：${data.error || `HTTP ${res.status}`}`, 'error');
          showToast(`❌ ${label}失敗`, 'error', 3500);
          return false;
        }
        setLocalStatus(`✅ ${doneMsg}`, 'ok');
        showToast(`✅ ${doneMsg}`, 'success', 3000);
        return true;
      } catch (err) {
        setLocalStatus(`❌ ${label}失敗：${err.message || '網路錯誤'}`, 'error');
        showToast(`❌ ${label}失敗`, 'error', 3500);
        return false;
      }
    }

    const localRebuildBtn = $('btnLocalRebuildIndex');
    if (localRebuildBtn) {
      localRebuildBtn.addEventListener('click', async () => {
        if (!confirm('確定要重建全文索引嗎？\n這將重新掃描經論檔庫並重建 Bigram 倒排索引。')) return;
        await runLocalMaintenance('重建全文索引', '/api/admin/rebuild-index', '全文索引已開始重建，可繼續閱讀');
      });
    }

    const localRebuildDictBtn = $('btnLocalRebuildDictIndex');
    if (localRebuildDictBtn) {
      localRebuildDictBtn.addEventListener('click', async () => {
        if (!confirm('確定要重建辭典索引嗎？')) return;
        await runLocalMaintenance('重建辭典索引', '/api/admin/rebuild-dict-index', '辭典索引已開始重建');
      });
    }

    const localClearCacheBtn = $('btnLocalClearCache');
    if (localClearCacheBtn) {
      localClearCacheBtn.addEventListener('click', async () => {
        if (!confirm('確定要清除快取嗎？\n下次開啟經文時會重新建立快取。')) return;
        await runLocalMaintenance('清除快取', '/api/admin/clear-cache', '快取已清除');
      });
    }

    const localOpenSettingsBtn = $('btnLocalOpenVaultSettings');
    if (localOpenSettingsBtn) {
      localOpenSettingsBtn.addEventListener('click', async () => {
        $('userSettingsOverlay').style.display = 'none';
        await openSettingsOverlay();
      });
    }

    // ── Setup Form Submission ──
    $('adminSetupForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = $('setupUsername').value.trim();
      const email = ($('setupEmail') ? $('setupEmail').value : '').trim();
      const password = $('setupPassword').value;
      const confirm = $('setupPasswordConfirm').value;
      const siteUrl = ($('setupSiteUrl') ? $('setupSiteUrl').value : '').trim();
      const setupToken = ($('setupToken') ? $('setupToken').value : '').trim();
      const errorEl = $('setupErrorMsg');

      if (!username && !email) {
        errorEl.textContent = 'Email 與帳號名稱至少要填一個';
        errorEl.style.display = 'block';
        return;
      }

      if (!setupToken) {
        errorEl.textContent = '請輸入伺服器日誌中的一次性設定碼';
        errorEl.style.display = 'block';
        return;
      }

      if (!siteUrl) {
        errorEl.textContent = '請填寫首頁權威 URL';
        errorEl.style.display = 'block';
        return;
      }

      if (!/^https?:\/\//i.test(siteUrl)) {
        errorEl.textContent = '首頁權威 URL 格式不正確，必須以 http:// 或 https:// 開頭';
        errorEl.style.display = 'block';
        return;
      }

      if (password !== confirm) {
        errorEl.textContent = '密碼與確認密碼不符';
        errorEl.style.display = 'block';
        return;
      }

      try {
        const res = await fetch('/api/admin/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, email, password, siteUrl, setupToken })
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || '設定失敗');
        }
        errorEl.style.display = 'none';
        $('adminSetupOverlay').style.display = 'none';

        // 建立完成即已登入（cookie），直接進後台的「帳號系統」分頁接著做開站設定（寄信、Turnstile）。
        state.isAdmin = true;
        await refreshAccountMe();
        await openSettingsOverlay();
        const setupTab = $('adminTabAccountSystemBtn');
        if (setupTab && !setupTab.hidden && setupTab.style.display !== 'none') setupTab.click();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.style.display = 'block';
      }
    });

    // ── Settings Form Toggle Interactions ──
    const versionToggleEl = $('settingsEnableVersion');
    if (versionToggleEl) versionToggleEl.addEventListener('change', syncFooterToggleInputs);
    const downloadToggleEl = $('settingsEnableDownload');
    if (downloadToggleEl) downloadToggleEl.addEventListener('change', syncFooterToggleInputs);
    const dictToggleEl = $('settingsEnableDictionary');
    if (dictToggleEl) dictToggleEl.addEventListener('change', syncFooterToggleInputs);
    const announcementToggleEl = $('settingsEnableAnnouncement');
    if (announcementToggleEl) announcementToggleEl.addEventListener('change', syncFooterToggleInputs);

    // ── Settings Form Submission ──
    async function performSaveSettings(createIfNotExists = false, closeAfterSave = false) {
      const siteName = $('settingsSiteName').value;
      const siteUrl = ($('settingsSiteUrl') || {}).value || '';
      const mdRoot = $('settingsMdRoot').value;
      const defaultFontSize = parseInt($('settingsFontSize').value);
      const defaultTheme = $('settingsTheme').value;
      const enableVersion = $('settingsEnableVersion').checked;
      const version = $('settingsVersion').value;
      const enableDownload = $('settingsEnableDownload').checked;
      const downloadUrl = $('settingsDownloadUrl').value;
      const dictionaryEnabled = ($('settingsEnableDictionary') || {}).checked;
      const dictionaryPath = ($('settingsDictionaryPath') || {}).value;
      const enableAnnouncement = ($('settingsEnableAnnouncement') || {}).checked;
      const announcementMessage = ($('settingsAnnouncementMessage') || {}).value;
      const maxProximityDistance = parseInt(($('settingsMaxProximityDistance') || {}).value) || 150;
      const defaultSearchMode = ($('settingsDefaultSearchMode') || {}).value || 'loose';
      const timezone = ($('settingsTimezone') || {}).value || 'auto';
      storage.set(STORAGE_KEYS.ADMIN_TZ, timezone);
      const errorEl = $('settingsErrorMsg');
      const successEl = $('settingsSuccessMsg');

      try {
        const res = await fetch('/api/admin/settings', {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            settings: {
              siteName, siteUrl, mdRoot, defaultFontSize, defaultTheme, createIfNotExists,
              enableVersion, version, enableDownload, downloadUrl, dictionaryEnabled, dictionaryPath, maxProximityDistance, defaultSearchMode, timezone,
              enableAnnouncement, announcementMessage
            }
          })
        });
        const data = await res.json();
        if (!res.ok) {
          if (res.status === 404 && data.code === 'DIR_NOT_FOUND') {
            const targetLabel = data.field === 'dictionaryPath' ? '辭典目錄' : '目錄';
            const confirmCreate = window.confirm(`指定的${targetLabel}路徑不存在：\n${data.path || mdRoot || dictionaryPath}\n\n是否要自動創建此目錄？`);
            if (confirmCreate) {
              return await performSaveSettings(true, closeAfterSave);
            }
          }
          throw new Error(data.error || '儲存失敗');
        }
        errorEl.style.display = 'none';

        if (data.settings) {
          _lastAdminSettings = data.settings;
          if (data.settings.defaultFontSize) {
            state.defaultFontSize = parseInt(data.settings.defaultFontSize);
            const userSavedFont = storage.get(STORAGE_KEYS.FONT_SIZE);
            if (userSavedFont) {
              applyFontSize(parseInt(userSavedFont), true);
            } else {
              applyFontSize(state.defaultFontSize, false);
            }
          }
          if (data.settings.defaultTheme) {
            const userSavedTheme = storage.get(STORAGE_KEYS.THEME);
            if (!userSavedTheme) {
              applyTheme(data.settings.defaultTheme, false);
            }
          }
          if (data.settings.siteName) {
            state.siteName = data.settings.siteName;
            updateSiteNameUI();
          }
          if (data.settings.dictionaryEnabled !== undefined) {
            state.dictionaryEnabled = !!data.settings.dictionaryEnabled;
            syncDictToggleVisibility();
          }
          if (data.settings.enableAnnouncement !== undefined) {
            appConfig.enableAnnouncement = data.settings.enableAnnouncement;
          }
          if (data.settings.announcementMessage !== undefined) {
            appConfig.announcementMessage = data.settings.announcementMessage;
          }
          if (data.settings.announcementUpdatedAt !== undefined) {
            appConfig.announcementUpdatedAt = data.settings.announcementUpdatedAt;
          }
          if (!appConfig.announcement) appConfig.announcement = {};
          appConfig.announcement.enabled = !!data.settings.enableAnnouncement;
          appConfig.announcement.message = data.settings.announcementMessage || '';
          appConfig.announcement.updatedAt = data.settings.announcementUpdatedAt || 0;
          updateWelcomeFooter(data.settings);
        }

        // Reload the file tree and update UI with new paths
        await loadTree();
        showToast('✅ 後台系統設定已成功儲存並生效', 'success');
        setAdminDirty(false);

        if (closeAfterSave) {
          closeAdminModal(true);
        } else {
          successEl.textContent = '設定已成功儲存';
          successEl.style.display = 'block';
          setTimeout(() => {
            successEl.style.display = 'none';
          }, 3000);
        }
        return true;
      } catch (err) {
        successEl.style.display = 'none';
        errorEl.textContent = err.message;
        errorEl.style.display = 'block';
        return false;
      }
    }

    $('adminSettingsForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      await performSaveSettings(false, false);
    });

    const saveAndCloseBtn = $('settingsSaveAndCloseBtn');
    if (saveAndCloseBtn) {
      saveAndCloseBtn.addEventListener('click', async () => {
        await performSaveSettings(false, true);
      });
    }

    $('settingsCancelBtn').addEventListener('click', () => {
      closeAdminModal();
    });

    $('settingsCloseBtn').addEventListener('click', () => {
      closeAdminModal();
    });

    // ── Logout ──
    $('settingsLogoutBtn').addEventListener('click', async () => {
      let ok = true;
      try {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}'
        });
      } catch (err) {
        console.error('Logout request failed:', err);
        ok = false;
      }
      state.isAdmin = false;
      setAccountUser(null);
      closeAdminModal();
      showToast(ok ? '👋 管理員已順利登出' : '❌ 登出請求失敗，但本機已登出', ok ? 'info' : 'error');
    });
  }

  function openUserSettingsOverlay() {
    renderMaxWidthControl();
    fetchSuggestList(false);

    const s2tChk = $('settingAutoS2TCheck');
    if (s2tChk) s2tChk.checked = !!state.autoS2T;
    updateSearchModeUI();
    updateDisplayScriptUI();
    const autoProgressChk = $('settingAutoReadProgressCheck');
    if (autoProgressChk) autoProgressChk.checked = !!state.autoReadProgress;

    const appVer = (window.__APP_CONFIG__ && window.__APP_CONFIG__.appVersion) ? String(window.__APP_CONFIG__.appVersion).trim() : '4.2.5';
    const cleanVer = appVer.startsWith('v') ? appVer : ('v' + appVer);
    const footerVer = $('userSettingsFooterVersion');
    const systemVer = $('systemTabVersion');
    if (footerVer) footerVer.textContent = '版本 ' + cleanVer;
    if (systemVer) systemVer.textContent = cleanVer;

    const statusText = $('adminStatusText');
    const loginBtn = $('menuOpenAdminLoginBtn');
    const vaultBtn = $('menuOpenVaultSettingsBtn');

    if (state.isSingleUser) {
      // No account exists to log into; the local user is already authorised.
      if (statusText) statusText.textContent = '單機模式：本機免登入，可直接使用系統維護功能';
      if (loginBtn) loginBtn.style.display = 'none';
      // In single-user mode the maintenance panel lives in this very tab, so the
      // "open admin settings" shortcut is redundant and stays hidden.
      if (vaultBtn) vaultBtn.style.display = 'none';
    } else if (state.account.user) {
      const u = state.account.user;
      const who = u.displayName || u.email || u.username;
      if (statusText) statusText.textContent = `目前登入：${who}${state.isAdmin ? '（管理員）' : ''}`;
      if (loginBtn) loginBtn.style.display = 'none';
      if (vaultBtn) vaultBtn.style.display = state.isAdmin ? 'inline-block' : 'none';
    } else if (state.isAdmin) {
      if (statusText) statusText.textContent = '登入狀態：管理員 ✅';
      if (loginBtn) loginBtn.style.display = 'none';
      if (vaultBtn) vaultBtn.style.display = 'inline-block';
    } else {
      if (statusText) statusText.textContent = '登入狀態：尚未登入';
      if (loginBtn) loginBtn.style.display = 'inline-block';
      if (vaultBtn) vaultBtn.style.display = 'none';
    }

    $('userSettingsOverlay').style.display = 'flex';
    document.body.classList.add('modal-open');
  }

  // ═══════════════════════════════════════════════════════════
  // §21 ADMIN & USER PREFERENCES PANELS
  //
  // 這是全檔最大的區塊（約 2,400 行、44 個函式），內部可再分為六個
  // 子群。原標記只給了一個籠統標題，導致要改其中一個功能時得整段
  // 讀完。以下為子群索引（行號會隨改動位移，以函式名為準）：
  //
  //   §21.1 面板開關與髒值追蹤   closeAdminModal, setAdminDirty,
  //                              setupAdminDirtyTracking
  //   §21.2 帳號與設定維護       setupPathDiagnostics, setupChangePassword,
  //                              setupConfigBackupAndRestore, setupHardwareClearCache
  //   §21.3 流量趨勢圖繪製       computeNiceScale, monotonePath,
  //                              renderAnalyticsTrendChart（純計算 + SVG 路徑）
  //   §21.4 硬體監控儀表板       formatBytes, formatUptime, loadHardwareStats,
  //                              renderHardwareDashboard, setupHardwareIndexRebuild,
  //                              setupHardwareDictIndexRebuild, setupHardwareAutoRefresh
  //   §21.5 日誌與流量報表       openSettingsOverlay, filterLogEntries, fetchAdminLogs,
  //                              renderAdminLogs, loadAdminAnalytics, renderAdminAnalytics
  //   §21.6 設定表單與 SEO       setupAdminTabEvents, setupArticlePicker,
  //                              setupSuggestFormEvents, loadSuggestSettings,
  //                              loadSeoSettings, setupAdminSeoEvents
  // ═══════════════════════════════════════════════════════════
  let hwAutoRefreshTimer = null;
  let indexRebuildPollingTimer = null;
  let dictIndexRebuildPollingTimer = null;
  // Handles for the persistent 'loading' toasts shown while an index rebuild is in
  // flight. They are pointer-events:none with no close button, so every exit path
  // (completion, request error, polling failure, modal close) must dismiss them.
  let indexRebuildToast = null;
  let dictIndexRebuildToast = null;

  // 關閉重建中的持久型 Toast（若存在）。所有結束路徑都必須呼叫，避免卡住無法關閉。
  function dismissIndexRebuildToast() {
    if (indexRebuildToast) { indexRebuildToast.dismiss(); indexRebuildToast = null; }
  }
  function dismissDictIndexRebuildToast() {
    if (dictIndexRebuildToast) { dictIndexRebuildToast.dismiss(); dictIndexRebuildToast = null; }
  }

  function closeUserSettingsModal() {
    const overlay = $('userSettingsOverlay');
    if (overlay) overlay.style.display = 'none';
    document.body.classList.remove('modal-open');
  }

  function closeAdminModal(force = false) {
    if (!force && state._adminDirty) {
      const confirmLeave = window.confirm('您有尚未儲存的變更，確定要離開嗎？未儲存的內容將會遺失。');
      if (!confirmLeave) return;
    }
    setAdminDirty(false);

    const overlay = $('adminSettingsOverlay');
    if (overlay) overlay.style.display = 'none';
    const setupOverlay = $('adminSetupOverlay');
    if (setupOverlay) setupOverlay.style.display = 'none';
    document.body.classList.remove('modal-open');
    if (hwAutoRefreshTimer) {
      clearInterval(hwAutoRefreshTimer);
      hwAutoRefreshTimer = null;
    }
    if (indexRebuildPollingTimer) {
      clearInterval(indexRebuildPollingTimer);
      indexRebuildPollingTimer = null;
    }
    if (dictIndexRebuildPollingTimer) {
      clearInterval(dictIndexRebuildPollingTimer);
      dictIndexRebuildPollingTimer = null;
    }
    // 關閉後台面板時一併收掉「重建中」持久型 Toast，否則它永遠不會消失。
    dismissIndexRebuildToast();
    dismissDictIndexRebuildToast();
  }

  function setAdminDirty(isDirty) {
    state._adminDirty = !!isDirty;
    updateAdminDirtyUI(state._adminDirty);
  }

  function updateAdminDirtyUI(isDirty) {
    const adminBadge = $('adminUnsavedIndicator');
    const seoBadge = $('seoUnsavedIndicator');
    const suggestBadge = $('suggestUnsavedIndicator');
    if (adminBadge) adminBadge.style.display = isDirty ? 'inline-block' : 'none';
    if (seoBadge) seoBadge.style.display = isDirty ? 'inline-block' : 'none';
    if (suggestBadge) suggestBadge.style.display = isDirty ? 'inline-block' : 'none';
  }

  function setupAdminDirtyTracking() {
    if (state._adminDirtyTrackingSetup) return;
    state._adminDirtyTrackingSetup = true;

    ['adminSettingsForm', 'adminSeoForm', 'adminSuggestForm'].forEach(formId => {
      const form = $(formId);
      if (!form) return;
      form.addEventListener('input', (e) => {
        if (e.target.id === 'suggestArticleSearchInput' || 
            e.target.id === 'adminCurrentPassword' || 
            e.target.id === 'adminNewPassword' || 
            e.target.id === 'adminConfirmPassword') return;
        setAdminDirty(true);
      });
      form.addEventListener('change', (e) => {
        if (e.target.id === 'suggestArticleSearchInput') return;
        setAdminDirty(true);
      });
    });
  }

  function setupPathDiagnostics() {
    const btnMdRoot = $('btnDiagnoseMdRoot');
    const btnDict = $('btnDiagnoseDict');
    const resMdRoot = $('diagnoseMdRootResult');
    const resDict = $('diagnoseDictResult');

    async function runDiagnose(targetPath, type, resultEl, btnEl) {
      if (!targetPath) {
        if (resultEl) {
          resultEl.className = 'diagnose-result error';
          resultEl.innerHTML = '⚠️ 請先輸入路徑';
          resultEl.style.display = 'block';
        }
        return;
      }
      const origText = btnEl ? btnEl.textContent : '';
      if (btnEl) {
        btnEl.disabled = true;
        btnEl.textContent = '⏳ 檢測中…';
      }
      if (resultEl) {
        resultEl.className = 'diagnose-result';
        resultEl.innerHTML = '<span style="opacity: 0.7;">🔍 正在檢測伺服器端路徑與檔案結構…</span>';
        resultEl.style.display = 'block';
      }

      try {
        const res = await fetch('/api/admin/diagnose-path', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ targetPath, type })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '檢測失敗');

        if (!data.exists) {
          resultEl.className = 'diagnose-result error';
          resultEl.innerHTML = `❌ <b>路徑不存在</b>：<code>${escHtml(data.path)}</code><br><span style="font-size:11px;">${escHtml(data.error || '')}</span>`;
        } else if (!data.isDir) {
          resultEl.className = 'diagnose-result error';
          resultEl.innerHTML = `❌ <b>非目錄結構</b>：<code>${escHtml(data.path)}</code> 為檔案而非目錄。`;
        } else if (!data.readable) {
          resultEl.className = 'diagnose-result error';
          resultEl.innerHTML = `❌ <b>無讀取權限</b>：伺服器行程無法讀取此目錄，請檢查檔案系統權限。`;
        } else {
          resultEl.className = 'diagnose-result success';
          const writeBadge = data.writable ? '、具備寫入權限 ✅' : '（唯讀）';
          if (type === 'dict') {
            const sample = (data.sampleNames && data.sampleNames.length > 0) ? `<br><span style="font-size: 11px; opacity: 0.85;">辭典檔案範例: ${data.sampleNames.map(s => escHtml(s)).join(', ')}</span>` : '';
            resultEl.innerHTML = `✅ <b>路徑有效</b>：共掃描到 <b>${data.count}</b> 個辭典檔案${writeBadge}。${sample}`;
          } else {
            const sample = (data.sampleNames && data.sampleNames.length > 0) ? `<br><span style="font-size: 11px; opacity: 0.85;">經文範例: ${data.sampleNames.map(s => escHtml(s)).join(', ')}</span>` : '';
            resultEl.innerHTML = `✅ <b>路徑有效</b>：共掃描到 <b>${data.count}</b> 部經文檔案 (.md)${writeBadge}。${sample}`;
          }
        }
      } catch (err) {
        if (resultEl) {
          resultEl.className = 'diagnose-result error';
          resultEl.innerHTML = `❌ 檢測失敗: ${escHtml(err.message)}`;
        }
      } finally {
        if (btnEl) {
          btnEl.disabled = false;
          btnEl.textContent = origText;
        }
      }
    }

    if (btnMdRoot && !btnMdRoot._hasDiagnoseHandler) {
      btnMdRoot._hasDiagnoseHandler = true;
      btnMdRoot.addEventListener('click', () => {
        const val = ($('settingsMdRoot') || {}).value || '';
        runDiagnose(val, 'vault', resMdRoot, btnMdRoot);
      });
    }

    if (btnDict && !btnDict._hasDiagnoseHandler) {
      btnDict._hasDiagnoseHandler = true;
      btnDict.addEventListener('click', () => {
        const val = ($('settingsDictionaryPath') || {}).value || '';
        runDiagnose(val, 'dict', resDict, btnDict);
      });
    }
  }

  function setupChangePassword() {
    const btn = $('btnChangePassword');
    const currentInput = $('adminCurrentPassword');
    const newInput = $('adminNewPassword');
    const confirmInput = $('adminConfirmPassword');
    const msgEl = $('changePasswordMsg');

    if (!btn || btn._hasChangePasswordHandler) return;
    btn._hasChangePasswordHandler = true;

    btn.addEventListener('click', async () => {
      const currentPassword = currentInput ? currentInput.value : '';
      const newPassword = newInput ? newInput.value : '';
      const confirmPassword = confirmInput ? confirmInput.value : '';

      if (msgEl) {
        msgEl.textContent = '';
        msgEl.className = 'form-hint';
      }

      if (!currentPassword) {
        if (msgEl) {
          msgEl.textContent = '❌ 請輸入目前密碼';
          msgEl.className = 'form-error-text';
        }
        if (currentInput) currentInput.focus();
        return;
      }

      if (!newPassword || newPassword.length < 8) {
        if (msgEl) {
          msgEl.textContent = '❌ 新密碼長度至少需為 8 個字元';
          msgEl.className = 'form-error-text';
        }
        if (newInput) newInput.focus();
        return;
      }

      if (newPassword !== confirmPassword) {
        if (msgEl) {
          msgEl.textContent = '❌ 兩次輸入的新密碼不相符';
          msgEl.className = 'form-error-text';
        }
        if (confirmInput) confirmInput.focus();
        return;
      }

      btn.disabled = true;
      btn.textContent = '更新中…';

      try {
        const res = await fetch('/api/admin/password', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ currentPassword, newPassword })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '更新密碼失敗');

        if (currentInput) currentInput.value = '';
        if (newInput) newInput.value = '';
        if (confirmInput) confirmInput.value = '';

        if (msgEl) {
          msgEl.textContent = '✅ ' + (data.message || '密碼已成功更新！');
          msgEl.className = 'form-success-text';
          setTimeout(() => { if (msgEl) msgEl.textContent = ''; }, 4000);
        }
        showToast('✅ 管理員密碼已成功更新，已登出其他裝置', 'success');
      } catch (err) {
        if (msgEl) {
          msgEl.textContent = '❌ ' + err.message;
          msgEl.className = 'form-error-text';
        }
        showToast('❌ 更新密碼失敗：' + err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = '更新管理員密碼';
      }
    });
  }

  function setupConfigBackupAndRestore() {
    const exportBtn = $('btnExportConfig');
    const importBtn = $('btnImportConfig');
    const fileInput = $('configImportFileInput');

    if (exportBtn && !exportBtn._hasExportHandler) {
      exportBtn._hasExportHandler = true;
      exportBtn.addEventListener('click', async () => {
        try {
          const res = await fetch('/api/admin/settings', {
            headers: {}
          });
          if (!res.ok) throw new Error('讀取設定失敗');
          const data = await res.json();
          const appVer = (window.__APP_CONFIG__ && window.__APP_CONFIG__.appVersion) ? String(window.__APP_CONFIG__.appVersion).trim() : '4.2.5';
          const exportData = {
            exportDate: new Date().toISOString(),
            app: 'mdWebview',
            version: data.settings?.version || appVer.replace(/^v/, ''),
            settings: data.settings || {}
          };
          const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          const dateStr = new Date().toISOString().slice(0, 10);
          a.download = `mdWebview-config-backup-${dateStr}.json`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          showToast('📥 設定檔備份已成功下載', 'success');
        } catch (err) {
          showToast('❌ 匯出備份失敗：' + err.message, 'error');
        }
      });
    }

    if (importBtn && fileInput && !importBtn._hasImportHandler) {
      importBtn._hasImportHandler = true;
      importBtn.addEventListener('click', () => {
        fileInput.click();
      });

      fileInput.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;

        try {
          const text = await file.text();
          const json = JSON.parse(text);
          const settingsToRestore = json.settings || json;

          if (!settingsToRestore || typeof settingsToRestore !== 'object') {
            throw new Error('備份檔案格式無效');
          }

          const confirmRestore = window.confirm(
            `確定要還原備份檔案「${file.name}」嗎？\n\n系統將會覆蓋當前網站名稱、外觀、SEO 與推薦閱讀設定。`
          );
          if (!confirmRestore) {
            fileInput.value = '';
            return;
          }

          const res = await fetch('/api/admin/settings', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ settings: settingsToRestore })
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || '還原設定失敗');

          showToast('✅ 設定備份已成功還原！', 'success');
          fileInput.value = '';
          await openSettingsOverlay();
        } catch (err) {
          showToast('❌ 還原失敗：' + err.message, 'error');
          fileInput.value = '';
        }
      });
    }
  }

  function setupHardwareClearCache() {
    const btn = $('hwClearCacheBtn');
    if (!btn || btn._hasClearHandler) return;
    btn._hasClearHandler = true;

    btn.addEventListener('click', async () => {
      const orig = btn.textContent;
      btn.disabled = true;
      btn.textContent = '🧹 清理中…';
      try {
        const res = await fetch('/api/admin/clear-cache', {
          method: 'POST',
          headers: {}
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '清理失敗');
        showToast(`🧹 ${data.message || '快取已成功清空'}`, 'success');
        await loadHardwareStats();
      } catch (err) {
        showToast('❌ 清空快取失敗：' + err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = orig;
      }
    });
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const val = (bytes / Math.pow(1024, i)).toFixed(i >= 2 ? 1 : 0);
    return `${val} ${units[i]}`;
  }

  function formatUptime(seconds) {
    if (!seconds || seconds <= 0) return '0 秒';
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    const parts = [];
    if (days > 0) parts.push(`${days}天`);
    if (hours > 0) parts.push(`${hours}時`);
    if (mins > 0) parts.push(`${mins}分`);
    if (parts.length === 0 || secs > 0) parts.push(`${secs}秒`);
    return parts.join(' ');
  }

  // ── §21.3 SVG Visualizations & Chart Helpers ───────────────────
  // 純計算 + DOM 繪製，不碰網路與 state；computeNiceScale / monotonePath
  // 由 tests/test-analytics-chart.test.js 直接抽出來實跑驗證。

  /**
   * 選擇「好看」的 Y 軸步長：一定是整數、且剛好涵蓋最大值。
   *
   * 舊版用 Math.round(maxY / 3 * i) 直接算刻度，當 maxY 很小（例如 1）時
   * 會產生 0, 0, 1, 1 這種重複刻度；較大的數字也落在不整齊的間隔上。
   */
  function computeNiceScale(maxValue, tickCount = 4) {
    const safeMax = Math.max(1, Math.ceil(maxValue));
    const rawStep = safeMax / tickCount;
    const exp = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const frac = rawStep / exp;
    // 2.5 也列入，否則 100 這種常見最大值會被推到 0/50/100 三個稀疏刻度，
    // 而不是 0/25/50/75/100 五個。
    const niceFrac = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 2.5 ? 2.5 : frac <= 5 ? 5 : 10;
    // 這些都是「次數」，步長至少為 1，否則會出現 0.5 這種無意義刻度。
    const step = Math.max(1, Math.round(niceFrac * exp));
    return { max: Math.ceil(safeMax / step) * step, step };
  }

  /**
   * 單調三次曲線（Fritsch–Carlson）。
   *
   * 比直線柔和，又不像 Catmull–Rom 會在劇烈起伏處 overshoot 到負值——
   * 那會讓折線畫到座標軸下方，看起來像資料出錯。
   */
  function monotonePath(points) {
    const n = points.length;
    if (n === 0) return '';
    if (n === 1) return `M ${points[0].x},${points[0].y}`;
    if (n === 2) {
      return `M ${points[0].x},${points[0].y} L ${points[1].x},${points[1].y}`;
    }

    const dx = [];
    const slope = [];
    for (let i = 0; i < n - 1; i++) {
      dx[i] = points[i + 1].x - points[i].x;
      slope[i] = dx[i] === 0 ? 0 : (points[i + 1].y - points[i].y) / dx[i];
    }

    const tangent = new Array(n);
    tangent[0] = slope[0];
    for (let i = 1; i < n - 1; i++) {
      // 相鄰斜率異號（或為 0）時取 0，形成平坦的極值，避免 overshoot
      tangent[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
    }
    tangent[n - 1] = slope[n - 2];

    for (let i = 0; i < n - 1; i++) {
      if (slope[i] === 0) {
        tangent[i] = 0;
        tangent[i + 1] = 0;
        continue;
      }
      const a = tangent[i] / slope[i];
      const b = tangent[i + 1] / slope[i];
      const s = a * a + b * b;
      if (s > 9) {
        const tau = 3 / Math.sqrt(s);
        tangent[i] = tau * a * slope[i];
        tangent[i + 1] = tau * b * slope[i];
      }
    }

    let d = `M ${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`;
    for (let i = 0; i < n - 1; i++) {
      const h = dx[i];
      const c1x = points[i].x + h / 3;
      const c1y = points[i].y + (tangent[i] * h) / 3;
      const c2x = points[i + 1].x - h / 3;
      const c2y = points[i + 1].y - (tangent[i + 1] * h) / 3;
      d += ` C ${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ` +
           `${points[i + 1].x.toFixed(1)},${points[i + 1].y.toFixed(1)}`;
    }
    return d;
  }

  function renderAnalyticsTrendChart(dailyTrend) {
    const wrapper = $('analyticsTrendChartWrapper');
    if (!wrapper) return;

    if (!Array.isArray(dailyTrend) || dailyTrend.length === 0) {
      wrapper.innerHTML = `<div class="panel-placeholder"><span class="placeholder-icon">📊</span><span>尚無趨勢數據</span></div>`;
      return;
    }

    const width = 720;
    const height = 220;
    const padding = { top: 26, right: 18, bottom: 34, left: 48 };
    const chartW = Math.max(1, width - padding.left - padding.right);
    const chartH = Math.max(1, height - padding.top - padding.bottom);

    const count = dailyTrend.length;
    const viewVals = dailyTrend.map(d => Number(d.views) || 0);
    const ipVals = dailyTrend.map(d => Number(d.uniqueIps) || 0);
    const { max: maxY, step: yStep } = computeNiceScale(
      Math.max(1, ...viewVals, ...ipVals), 4
    );

    const getX = (i) => padding.left + (count === 1 ? chartW / 2 : (i / (count - 1)) * chartW);
    const getY = (v) => padding.top + chartH - (Math.min(Number(v) || 0, maxY) / maxY) * chartH;
    const baseY = padding.top + chartH;

    const viewPoints = viewVals.map((v, i) => ({ x: getX(i), y: getY(v) }));
    const ipPoints = ipVals.map((v, i) => ({ x: getX(i), y: getY(v) }));

    const viewPathD = monotonePath(viewPoints);
    const ipPathD = monotonePath(ipPoints);
    const viewAreaD =
      `${viewPathD} L ${(padding.left + chartW).toFixed(1)},${baseY} ` +
      `L ${padding.left.toFixed(1)},${baseY} Z`;

    // Y 軸格線與刻度
    let grid = '';
    for (let v = 0; v <= maxY + 1e-9; v += yStep) {
      const y = getY(v).toFixed(1);
      grid += `<line class="trend-grid-line" x1="${padding.left}" y1="${y}" ` +
              `x2="${(padding.left + chartW).toFixed(1)}" y2="${y}" />`;
      grid += `<text class="trend-axis-label" x="${padding.left - 10}" y="${(Number(y) + 3.5).toFixed(1)}" ` +
              `text-anchor="end">${Math.round(v).toLocaleString()}</text>`;
    }

    // X 軸標籤（避免擁擠）
    const labelStep = Math.max(1, Math.ceil(count / 7));
    let xLabels = '';
    dailyTrend.forEach((d, i) => {
      if (i % labelStep === 0 || i === count - 1) {
        const raw = String(d.date || '');
        let short = raw;
        if (raw.includes(' ')) short = raw.split(' ')[1];
        else if (raw.length >= 10) short = raw.slice(5);
        xLabels += `<text class="trend-axis-label" x="${getX(i).toFixed(1)}" y="${height - 10}" ` +
                   `text-anchor="middle">${escHtml(short)}</text>`;
      }
    });

    // 資料點：小而不搶眼；實際互動靠整片感應區 + 聚焦點
    let dots = '';
    viewVals.forEach((v, i) => {
      dots += `<circle class="trend-dot trend-dot-view" cx="${getX(i).toFixed(1)}" ` +
              `cy="${getY(v).toFixed(1)}" r="2.6" />`;
    });
    ipVals.forEach((v, i) => {
      dots += `<circle class="trend-dot trend-dot-ip" cx="${getX(i).toFixed(1)}" ` +
              `cy="${getY(v).toFixed(1)}" r="2.2" />`;
    });

    wrapper.innerHTML = `
      <div id="chartFloatingTooltip" class="chart-floating-tooltip" style="display: none;"></div>
      <svg viewBox="0 0 ${width} ${height}" class="analytics-trend-svg" role="img"
           aria-label="全站流量與檢索趨勢圖">
        <defs>
          <linearGradient id="viewTrendGrad" x1="0" y1="0" x2="0" y2="1">
            <stop class="trend-grad-0" offset="0%" />
            <stop class="trend-grad-1" offset="55%" />
            <stop class="trend-grad-2" offset="100%" />
          </linearGradient>
        </defs>
        ${grid}
        ${xLabels}
        <path class="trend-area" d="${viewAreaD}" fill="url(#viewTrendGrad)" />
        <path class="trend-glow" d="${viewPathD}" />
        <path class="trend-line trend-line-views" d="${viewPathD}" />
        <path class="trend-line trend-line-ips" d="${ipPathD}" />
        <line class="chart-cursor-line" x1="0" y1="${padding.top}" x2="0" y2="${baseY}" />
        <circle class="trend-focus trend-focus-view" r="5" />
        <circle class="trend-focus trend-focus-ip" r="4.2" />
        ${dots}
        <!-- 感應區刻意覆蓋整個繪圖區高度：滑鼠移到任一高度都能觸發該日細部數據，
             不必精準命中直徑僅數 px 的資料點。必須放在最後才能蓋在圖形之上。 -->
        <rect class="chart-hit-area" x="0" y="0" width="${width}" height="${height}"
              fill="transparent" />
      </svg>
      <div class="analytics-chart-legend">
        <span class="chart-legend-item">
          <span class="chart-legend-line"></span>閱讀點閱數 (Page Views)
        </span>
        <span class="chart-legend-item">
          <span class="chart-legend-line is-dashed"></span>獨立訪客數 (Unique IPs)
        </span>
      </div>
    `;

    const tooltip = $('chartFloatingTooltip');
    const svgEl = wrapper.querySelector('.analytics-trend-svg');
    if (!tooltip || !svgEl) return;

    const cursor = svgEl.querySelector('.chart-cursor-line');
    const focusView = svgEl.querySelector('.trend-focus-view');
    const focusIp = svgEl.querySelector('.trend-focus-ip');
    const hitArea = svgEl.querySelector('.chart-hit-area');
    if (!cursor || !focusView || !focusIp || !hitArea) return;

    const hideTooltip = () => {
      cursor.style.opacity = '0';
      focusView.style.opacity = '0';
      focusIp.style.opacity = '0';
      tooltip.style.display = 'none';
      tooltip.classList.remove('is-left');
    };

    const showTooltip = (evt) => {
      const rect = svgEl.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      // 只需要水平位置：垂直方向不論在哪個高度，都對應到最近的那一天，
      // 因此整片感應區都能觸發，而不只是資料點附近。
      const svgX = (evt.clientX - rect.left) * (width / rect.width);
      let idx = 0;
      let best = Infinity;
      for (let i = 0; i < count; i++) {
        const dist = Math.abs(getX(i) - svgX);
        if (dist < best) {
          best = dist;
          idx = i;
        }
      }

      const point = dailyTrend[idx];
      const x = getX(idx);
      const yView = getY(viewVals[idx]);
      const yIp = getY(ipVals[idx]);

      cursor.setAttribute('x1', x.toFixed(1));
      cursor.setAttribute('x2', x.toFixed(1));
      cursor.style.opacity = '1';

      focusView.setAttribute('cx', x.toFixed(1));
      focusView.setAttribute('cy', yView.toFixed(1));
      focusView.style.opacity = '1';

      focusIp.setAttribute('cx', x.toFixed(1));
      focusIp.setAttribute('cy', yIp.toFixed(1));
      focusIp.style.opacity = '1';

      tooltip.innerHTML =
        `<span class="chart-tt-date">${escHtml(String(point.date || ''))}</span>` +
        `<span class="chart-tt-row"><span class="chart-tt-swatch is-view"></span>` +
        `<span>閱讀點閱</span><b class="chart-tt-num">${viewVals[idx].toLocaleString()}</b></span>` +
        `<span class="chart-tt-row"><span class="chart-tt-swatch is-ip"></span>` +
        `<span>獨立訪客</span><b class="chart-tt-num">${ipVals[idx].toLocaleString()}</b></span>`;
      tooltip.style.display = 'block';

      // 提示框放在游標線「側邊」：兩個資料點都落在游標線正上方，
      // 而兩點可能相距上百 px、圖表頂端又常沒有空間，因此往上或往下
      // 放都一定會蓋掉其中一個點。水平錯開就不會重疊。
      //
      // 座標系：絕對定位子元素的包含區塊是父層的 **padding box**，
      // 其原點在 border 內緣（padding 含在裡面），因此
      //   元素座標 = clientX - (容器 left + border)
      // 且可用寬高就是 clientWidth / clientHeight。
      // 先前誤把 padding 也加進原點，導致提示框整整偏左一個 padding，
      // 反而壓在資料點上。
      const wrapRect = wrapper.getBoundingClientRect();
      const cs = getComputedStyle(wrapper);
      const originX = wrapRect.left + (parseFloat(cs.borderLeftWidth) || 0);
      const originY = wrapRect.top + (parseFloat(cs.borderTopWidth) || 0);
      const innerW = wrapper.clientWidth;
      const innerH = wrapper.clientHeight;

      const tw = tooltip.offsetWidth;
      const th = tooltip.offsetHeight;

      // 用聚焦點的實際畫面座標（與容器同一座標系），避免換算 viewBox 出錯
      const viewRect = focusView.getBoundingClientRect();
      const anchorX = viewRect.left + viewRect.width / 2 - originX;

      const GAP = 14;
      // 預設放右側；右邊不夠就放左側，並在必要時夾回容器內
      let left = anchorX + GAP;
      if (left + tw > innerW) {
        left = anchorX - GAP - tw;
        tooltip.classList.add('is-left');
      } else {
        tooltip.classList.remove('is-left');
      }
      left = Math.max(0, Math.min(left, Math.max(0, innerW - tw)));

      // 垂直對齊圖表頂端，夾在容器內
      const svgTop = svgEl.getBoundingClientRect().top - originY;
      const top = Math.max(0, Math.min(svgTop, Math.max(0, innerH - th)));

      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
    };

    hitArea.addEventListener('pointermove', showTooltip);
    hitArea.addEventListener('pointerdown', showTooltip);
    hitArea.addEventListener('pointerleave', hideTooltip);
    hitArea.addEventListener('pointercancel', hideTooltip);
  }

  // ── §21.4 Hardware Monitor Dashboard ───────────────────────────
  // 對應後端 /api/admin/hardware（server.js 的 getSystemHardwareStats）。
  // 含索引重建按鈕與自動刷新計時器；計時器握把宣告在 §21 開頭。

  async function loadHardwareStats() {
    try {
      const res = await fetch('/api/admin/hardware', {
        headers: {}
      });
      if (!res.ok) return;
      const data = await res.json();
      renderHardwareDashboard(data);
    } catch (err) {
      console.error('Failed to load hardware stats:', err);
      showToast('❌ 硬體狀態載入失敗', 'error');
    }
  }

  function renderHardwareDashboard(data) {
    if (!data) return;

    // Header & Docker badge
    const dockerBadge = $('hwDockerBadge');
    if (dockerBadge) {
      dockerBadge.textContent = data.system.isDocker ? '🐳 Docker 容器環境' : '💻 原生主機環境';
      dockerBadge.className = data.system.isDocker ? 'hardware-badge-docker' : 'hardware-badge-docker host-env';
    }
    const uptimeText = $('hwUptimeText');
    if (uptimeText) {
      uptimeText.textContent = `容器運行時間: ${formatUptime(data.system.processUptime)} (主機: ${formatUptime(data.system.sysUptime)})`;
    }

    // CPU Card
    const cpuModel = $('hwCpuModel');
    if (cpuModel) cpuModel.textContent = `${data.cpu.model} (${data.system.arch})`;
    const cpuCores = $('hwCpuCores');
    if (cpuCores) cpuCores.textContent = `${data.cpu.cores} 核心`;

    const cpuUsageText = $('hwCpuUsageText');
    const cpuUsageFill = $('hwCpuUsageFill');
    if (cpuUsageText) cpuUsageText.textContent = `${data.cpu.usagePct || 0}%`;
    if (cpuUsageFill) {
      const cpuPct = Math.min(100, Math.max(0, data.cpu.usagePct || 0));
      cpuUsageFill.style.width = `${cpuPct}%`;
      cpuUsageFill.className = 'progress-bar-fill' + (cpuPct > 80 ? ' danger' : cpuPct > 50 ? ' warning' : ' fill-accent');
    }



    const load1m = $('hwLoad1m');
    const load5m = $('hwLoad5m');
    const load15m = $('hwLoad15m');
    if (load1m) load1m.textContent = data.cpu.loadAvg[0];
    if (load5m) load5m.textContent = data.cpu.loadAvg[1];
    if (load15m) load15m.textContent = data.cpu.loadAvg[2];

    const cpuBadge = $('hwCpuStatusBadge');
    if (cpuBadge) {
      const loadRatio = data.cpu.loadAvg[0] / (data.cpu.cores || 1);
      if (loadRatio > 1.5) {
        cpuBadge.textContent = '高負載';
        cpuBadge.className = 'metric-status-badge danger';
      } else if (loadRatio > 0.9) {
        cpuBadge.textContent = '上升中';
        cpuBadge.className = 'metric-status-badge warning';
      } else {
        cpuBadge.textContent = '良好';
        cpuBadge.className = 'metric-status-badge';
      }
    }

    // Memory Card
    const rssText = $('hwRssText');
    const rssFill = $('hwRssFill');
    if (rssText) rssText.textContent = `${formatBytes(data.memory.rss)} / ${formatBytes(data.memory.containerLimit)}`;
    if (rssFill) {
      const rssPct = Math.min(100, Math.max(0, data.memory.rssUsagePct || 0));
      rssFill.style.width = `${rssPct}%`;
      rssFill.className = 'progress-bar-fill' + (rssPct > 85 ? ' danger' : rssPct > 65 ? ' warning' : '');
    }

    const heapText = $('hwHeapText');
    const heapFill = $('hwHeapFill');
    if (heapText) heapText.textContent = `${formatBytes(data.memory.heapUsed)} / ${formatBytes(data.memory.heapTotal)}`;
    if (heapFill) {
      const heapPct = Math.min(100, Math.max(0, data.memory.heapUsagePct || 0));
      heapFill.style.width = `${heapPct}%`;
    }

    const externalText = $('hwExternalText');
    if (externalText) externalText.textContent = formatBytes(data.memory.external || 0);
    const arrayBuffersText = $('hwArrayBuffersText');
    if (arrayBuffersText) arrayBuffersText.textContent = formatBytes(data.memory.arrayBuffers || 0);

    const memBadge = $('hwMemStatusBadge');
    if (memBadge) {
      if (data.memory.rssUsagePct > 85) {
        memBadge.textContent = '緊繃';
        memBadge.className = 'metric-status-badge danger';
      } else if (data.memory.rssUsagePct > 65) {
        memBadge.textContent = '偏高';
        memBadge.className = 'metric-status-badge warning';
      } else {
        memBadge.textContent = '健康';
        memBadge.className = 'metric-status-badge';
      }
    }

    // Storage & Filesystem Card
    const diskText = $('hwDiskText');
    const diskFill = $('hwDiskFill');
    const fs = data.storage.vaultFs;
    if (diskText) diskText.textContent = `${formatBytes(fs.used)} / ${formatBytes(fs.total)} (${fs.usagePct}%)`;
    if (diskFill) {
      diskFill.style.width = `${fs.usagePct || 0}%`;
    }

    const nodeVer = $('hwNodeVer');
    if (nodeVer) nodeVer.textContent = `${data.system.nodeVersion}`;
    const platform = $('hwPlatform');
    if (platform) platform.textContent = `${data.system.platform} (${data.system.arch})`;
    const workerStatus = $('hwWorkerStatus');
    if (workerStatus) workerStatus.textContent = `${data.workers.idle}/${data.workers.count} 就緒`;

    const cacheSize = $('hwCacheSize');
    if (cacheSize) cacheSize.textContent = formatBytes(data.storage.cacheSizeBytes);
    const analyticsSize = $('hwAnalyticsSize');
    if (analyticsSize) analyticsSize.textContent = formatBytes(data.storage.analyticsStoreSizeBytes);
    const logsSize = $('hwLogsSize');
    if (logsSize) logsSize.textContent = formatBytes(data.storage.logsDirSizeBytes);

    const vaultPath = $('hwVaultPath');
    if (vaultPath) {
      vaultPath.textContent = data.storage.vaultPath || '--';
      vaultPath.title = data.storage.vaultPath || '';
    }

    // Index Status Card
    const indexStatus = $('hwIndexStatus');
    if (indexStatus) {
      if (data.index.building) {
        indexStatus.textContent = '建置中 ⏳';
      } else if (data.index.ready) {
        indexStatus.textContent = '就緒 ✅';
      } else {
        indexStatus.textContent = '未建置 ⚠️';
      }
    }

    const indexUnits = $('hwIndexUnits');
    if (indexUnits) indexUnits.textContent = (data.index.totalUnits || 0).toLocaleString();

    const bigramCount = $('hwBigramCount');
    if (bigramCount) {
      bigramCount.textContent = `${(data.index.uniqueBigrams || 0).toLocaleString()} 筆 (檔案: ${data.index.totalFiles} 個)`;
    }

    const indexCacheSize = $('hwIndexCacheSize');
    if (indexCacheSize) {
      const bytes = (data.index && data.index.cacheSizeBytes) || (data.storage && data.storage.cacheSizeBytes) || 0;
      indexCacheSize.textContent = formatBytes(bytes);
    }

    const indexCreatedAt = $('hwIndexCreatedAt');
    if (indexCreatedAt) {
      const mtime = data.index.createdAt || data.index.lastModified;
      if (mtime) {
        indexCreatedAt.textContent = formatTimestampWithTZ(mtime);
      } else {
        indexCreatedAt.textContent = '未建立';
      }
    }

    const rebuildBtn = $('hwRebuildIndexBtn');
    if (rebuildBtn) {
      if (data.index.building) {
        rebuildBtn.disabled = true;
        rebuildBtn.textContent = '⏳ 重建中…';
      } else if (!indexRebuildPollingTimer) {
        rebuildBtn.disabled = false;
        rebuildBtn.textContent = '⚡ 手動重建索引';
      }
    }

    // Dictionary Index Status (side-by-side with full-text index)
    if (data.dictIndex) {
      const dictStatus = $('hwDictIndexStatus');
      if (dictStatus) {
        if (!data.dictIndex.enabled) {
          dictStatus.textContent = '未啟用';
        } else if (data.dictIndex.building) {
          dictStatus.textContent = '建置中 ⏳';
        } else if (data.dictIndex.ready) {
          dictStatus.textContent = '就緒 ✅';
        } else {
          dictStatus.textContent = '未建置 ⚠️';
        }
      }

      const dictUnits = $('hwDictIndexUnits');
      if (dictUnits) dictUnits.textContent = (data.dictIndex.totalUnits || 0).toLocaleString();

      const dictBigramCount = $('hwDictBigramCount');
      if (dictBigramCount) {
        dictBigramCount.textContent = `${(data.dictIndex.uniqueBigrams || 0).toLocaleString()} 筆 (檔案: ${data.dictIndex.totalFiles} 個)`;
      }

      const dictCacheSize = $('hwDictIndexCacheSize');
      if (dictCacheSize) dictCacheSize.textContent = formatBytes(data.dictIndex.cacheSizeBytes || 0);

      const dictCreatedAt = $('hwDictIndexCreatedAt');
      if (dictCreatedAt) {
        const mtime = data.dictIndex.createdAt || data.dictIndex.lastModified;
        if (mtime) dictCreatedAt.textContent = formatTimestampWithTZ(mtime);
        else dictCreatedAt.textContent = '未建立';
      }

      const dictRebuildBtn = $('hwRebuildDictIndexBtn');
      if (dictRebuildBtn) {
        if (data.dictIndex.building) {
          dictRebuildBtn.disabled = true;
          dictRebuildBtn.textContent = '⏳ 重建中…';
        } else if (!dictIndexRebuildPollingTimer) {
          dictRebuildBtn.disabled = false;
          dictRebuildBtn.textContent = '📖 重建辭典索引';
        }
      }
    }

    // Search Engine & Cache Performance Card
    if (data.search) {
      const searchHitRate = $('hwSearchHitRate');
      if (searchHitRate) searchHitRate.textContent = `${data.search.hitRatePct || 0}% (命中: ${data.search.cacheHits || 0}/${data.search.totalQueries || 0})`;
      
      const searchAvgTime = $('hwSearchAvgTime');
      if (searchAvgTime) searchAvgTime.textContent = `${data.search.avgSearchTimeMs || 0} ms`;
      
      const searchCacheEntries = $('hwSearchCacheEntries');
      if (searchCacheEntries) searchCacheEntries.textContent = `${data.search.cacheEntries || 0} 筆`;
      
      const vaultTotalSize = $('hwVaultTotalSize');
      if (vaultTotalSize) vaultTotalSize.textContent = formatBytes(data.search.vaultTotalSizeBytes || 0);

      const lastSearchTime = $('hwLastSearchTime');
      if (lastSearchTime) lastSearchTime.textContent = `${data.search.lastSearchTimeMs || 0} ms`;
    }

    // Network & Throughput Card
    if (data.network) {
      const networkRpm = $('hwNetworkRpm');
      if (networkRpm) networkRpm.textContent = `${data.network.requestsPerMin || 0} req/min`;
      
      const networkAvgLatency = $('hwNetworkAvgLatency');
      if (networkAvgLatency) networkAvgLatency.textContent = `${data.network.avgResponseTimeMs || 0} ms`;
      
      const networkTotalReqs = $('hwNetworkTotalReqs');
      if (networkTotalReqs) networkTotalReqs.textContent = `${(data.network.totalRequests || 0).toLocaleString()} 次`;
      
      const activeSessions = $('hwActiveSessions');
      if (activeSessions) activeSessions.textContent = `${data.network.activeSessions || 0} 個`;
    }
  }

  function setupHardwareIndexRebuild() {
    const rebuildBtn = $('hwRebuildIndexBtn');
    if (!rebuildBtn || rebuildBtn.dataset.bound) return;
    rebuildBtn.dataset.bound = 'true';

    rebuildBtn.onclick = async () => {
      if (rebuildBtn.disabled) return;

      if (!confirm('確定要手動重建全文索引嗎？\n這將重新掃描經文檔庫並重建 Bigram 倒排索引。')) {
        return;
      }

      try {
        rebuildBtn.disabled = true;
        rebuildBtn.textContent = '⏳ 重建中…';

        const res = await fetch('/api/admin/rebuild-index', {
          method: 'POST',
          headers: {}
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          showToast(`❌ 重建索引失敗：${errData.error || `HTTP ${res.status}`}`, 'error', 3500);
          rebuildBtn.disabled = false;
          rebuildBtn.textContent = '⚡ 手動重建索引';
          return;
        }

        // 持久型進度 Toast：真正的完成時間由下方輪詢得知（非固定 3 秒），
        // 因此不使用有限 duration 假裝進度。
        indexRebuildToast = showToast('全文索引重建中…', 'loading', 0);

        await loadHardwareStats();

        if (indexRebuildPollingTimer) clearInterval(indexRebuildPollingTimer);
        indexRebuildPollingTimer = setInterval(async () => {
          try {
            const statsRes = await fetch('/api/admin/hardware', {
              headers: {}
            });
            if (!statsRes.ok) {
              // 輪詢端點失敗：無法再得知完成時間，收掉 Toast 並停止輪詢。
              clearInterval(indexRebuildPollingTimer);
              indexRebuildPollingTimer = null;
              dismissIndexRebuildToast();
              rebuildBtn.disabled = false;
              rebuildBtn.textContent = '⚡ 手動重建索引';
              showToast('全文索引重建狀態查詢失敗', 'error');
              return;
            }
            const data = await statsRes.json();
            renderHardwareDashboard(data);

            if (!data.index.building) {
              clearInterval(indexRebuildPollingTimer);
              indexRebuildPollingTimer = null;
              rebuildBtn.disabled = false;
              rebuildBtn.textContent = '⚡ 手動重建索引';
              dismissIndexRebuildToast();
              showToast('✅ 全文索引重建完成！', 'success', 3000);
            }
          } catch (err) {
            console.error('Error polling hardware stats during rebuild:', err);
            clearInterval(indexRebuildPollingTimer);
            indexRebuildPollingTimer = null;
            dismissIndexRebuildToast();
            rebuildBtn.disabled = false;
            rebuildBtn.textContent = '⚡ 手動重建索引';
            showToast('全文索引重建狀態查詢失敗', 'error');
          }
        }, 1500);

      } catch (err) {
        console.error('Failed to rebuild search index:', err);
        dismissIndexRebuildToast();
        showToast(`❌ 重建索引失敗：${err.message}`, 'error', 3500);
        rebuildBtn.disabled = false;
        rebuildBtn.textContent = '⚡ 手動重建索引';
      }
    };
  }

  function setupHardwareDictIndexRebuild() {
    const rebuildBtn = $('hwRebuildDictIndexBtn');
    if (!rebuildBtn || rebuildBtn.dataset.bound) return;
    rebuildBtn.dataset.bound = 'true';

    rebuildBtn.onclick = async () => {
      if (rebuildBtn.disabled) return;

      if (!confirm('確定要手動重建辭典索引嗎？\n這將重新掃描辭典目錄並重建辭典 Bigram 倒排索引。')) {
        return;
      }

      try {
        rebuildBtn.disabled = true;
        rebuildBtn.textContent = '⏳ 重建中…';

        const res = await fetch('/api/admin/rebuild-dict-index', {
          method: 'POST',
          headers: {}
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          showToast(`❌ 重建辭典索引失敗：${errData.error || `HTTP ${res.status}`}`, 'error', 3500);
          rebuildBtn.disabled = false;
          rebuildBtn.textContent = '📖 重建辭典索引';
          return;
        }

        // 同全文索引：以持久型 Toast 呈現真正的非同步建置狀態。
        dictIndexRebuildToast = showToast('辭典索引重建中…', 'loading', 0);

        await loadHardwareStats();

        if (dictIndexRebuildPollingTimer) clearInterval(dictIndexRebuildPollingTimer);
        dictIndexRebuildPollingTimer = setInterval(async () => {
          try {
            const statsRes = await fetch('/api/admin/hardware', {
              headers: {}
            });
            if (!statsRes.ok) {
              clearInterval(dictIndexRebuildPollingTimer);
              dictIndexRebuildPollingTimer = null;
              dismissDictIndexRebuildToast();
              rebuildBtn.disabled = false;
              rebuildBtn.textContent = '📖 重建辭典索引';
              showToast('辭典索引重建狀態查詢失敗', 'error');
              return;
            }
            const data = await statsRes.json();
            renderHardwareDashboard(data);

            if (!data.dictIndex.building) {
              clearInterval(dictIndexRebuildPollingTimer);
              dictIndexRebuildPollingTimer = null;
              rebuildBtn.disabled = false;
              rebuildBtn.textContent = '📖 重建辭典索引';
              dismissDictIndexRebuildToast();
              showToast('✅ 辭典索引重建完成！', 'success', 3000);
            }
          } catch (err) {
            console.error('Error polling hardware stats during dict index rebuild:', err);
            clearInterval(dictIndexRebuildPollingTimer);
            dictIndexRebuildPollingTimer = null;
            dismissDictIndexRebuildToast();
            rebuildBtn.disabled = false;
            rebuildBtn.textContent = '📖 重建辭典索引';
            showToast('辭典索引重建狀態查詢失敗', 'error');
          }
        }, 1500);

      } catch (err) {
        console.error('Failed to rebuild dictionary index:', err);
        dismissDictIndexRebuildToast();
        showToast(`❌ 重建辭典索引失敗：${err.message}`, 'error', 3500);
        rebuildBtn.disabled = false;
        rebuildBtn.textContent = '📖 重建辭典索引';
      }
    };
  }

  function setupHardwareAutoRefresh() {
    const refreshBtn = $('hwRefreshBtn');
    const select = $('hwAutoRefreshSelect');

    setupHardwareIndexRebuild();
    setupHardwareDictIndexRebuild();
    setupHardwareClearCache();

    if (refreshBtn) {
      refreshBtn.onclick = () => loadHardwareStats();
    }

    if (select) {
      select.onchange = () => {
        if (hwAutoRefreshTimer) clearInterval(hwAutoRefreshTimer);
        const interval = parseInt(select.value, 10);
        if (interval > 0) {
          hwAutoRefreshTimer = setInterval(loadHardwareStats, interval);
        }
      };
      const initialInterval = parseInt(select.value, 10);
      if (initialInterval > 0 && !hwAutoRefreshTimer) {
        hwAutoRefreshTimer = setInterval(loadHardwareStats, initialInterval);
      }
    }
  }

  // 後台需要重新登入（逾期、還原資料庫後）：走同一套帳號登入，管理員登入後直接回到後台。
  function openLoginOverlay() {
    openAccountAuth('login', { afterLogin: 'admin' });
  }

  // ── §21.5 Admin Logs & Analytics Reports ───────────────────────
  // 登入入口、日誌檢視（含時區與篩選）、流量報表與 CSV/JSON 匯出。

  async function openSettingsOverlay() {
    setupAdminTabEvents();
    if (!state.isSingleUser) refreshAdminSetupDot();
    const errorEl = $('settingsErrorMsg');
    const successEl = $('settingsSuccessMsg');
    errorEl.style.display = 'none';
    successEl.style.display = 'none';

    // 後台標題版本徽章：與偏好設定面板一致，一律顯示目前執行中的核心版本。
    const adminHeaderVer = $('adminSettingsHeaderVersion');
    if (adminHeaderVer) {
      const rawVer = (window.__APP_CONFIG__ && window.__APP_CONFIG__.appVersion) ? String(window.__APP_CONFIG__.appVersion).trim() : '4.2.5';
      adminHeaderVer.textContent = rawVer.startsWith('v') ? rawVer : ('v' + rawVer);
    }

    try {
      const res = await fetch('/api/admin/settings', {
        headers: {}
      });
      if (!res.ok) {
        // Token invalid/expired. Single-user mode has no login to fall back to,
        // so never send the user to a login overlay that cannot authorise them.
        if (state.isSingleUser) {
          showToast('❌ 系統設定載入失敗', 'error');
          return;
        }
        state.isAdmin = false;
        closeAdminModal();
        openLoginOverlay();
        return;
      }
      const data = await res.json();
      $('settingsSiteName').value = data.settings.siteName || 'mdWebview';
      if ($('settingsSiteUrl')) $('settingsSiteUrl').value = data.settings.siteUrl || '';
      $('settingsMdRoot').value = data.settings.mdRoot;
      $('settingsFontSize').value = data.settings.defaultFontSize;
      $('settingsTheme').value = data.settings.defaultTheme;
      $('settingsEnableVersion').checked = !!data.settings.enableVersion;
      $('settingsVersion').value = data.settings.version || '';
      $('settingsEnableDownload').checked = !!data.settings.enableDownload;
      $('settingsDownloadUrl').value = data.settings.downloadUrl || '';
      const dictEnabledEl = $('settingsEnableDictionary');
      if (dictEnabledEl) dictEnabledEl.checked = !!data.settings.dictionaryEnabled;
      const dictPathEl = $('settingsDictionaryPath');
      if (dictPathEl) dictPathEl.value = data.settings.dictionaryPath || '';
      const proxEl = $('settingsMaxProximityDistance');
      if (proxEl) proxEl.value = data.settings.maxProximityDistance || 150;
      const searchModeEl = $('settingsDefaultSearchMode');
      if (searchModeEl) searchModeEl.value = (data.settings.defaultSearchMode === 'strict') ? 'strict' : 'loose';
      const tzEl = $('settingsTimezone');
      if (tzEl) tzEl.value = data.settings.timezone || storage.get(STORAGE_KEYS.ADMIN_TZ) || 'auto';
      const announceToggleEl = $('settingsEnableAnnouncement');
      if (announceToggleEl) announceToggleEl.checked = !!data.settings.enableAnnouncement;
      const announceMsgEl = $('settingsAnnouncementMessage');
      if (announceMsgEl) announceMsgEl.value = data.settings.announcementMessage || '';
      if (typeof syncFooterToggleInputs === 'function') syncFooterToggleInputs();
      $('adminSettingsOverlay').style.display = 'flex';
      document.body.classList.add('modal-open');

      // Preload data for the other admin tabs so they are populated the moment
      // the panel opens. Analytics and SEO reporting only exist for a public
      // site, so a single-user bundle skips those two requests entirely rather
      // than firing fetches that are answered with 404.
      const preloads = [
        loadSuggestSettings(data.settings).catch(() => {}),
        fetchAdminLogs().catch(() => {})
      ];
      if (!state.isSingleUser) {
        preloads.push(loadAdminAnalytics().catch(() => {}));
      }
      Promise.all(preloads);
      enhanceAdminCards();
      wireAdminConfigLights();
      refreshAdminConfigLights();
    } catch (err) {
      console.error('Error fetching settings:', err);
      showToast('❌ 系統設定載入失敗', 'error');
    }
  }

  // ── Admin Logs Tab Logic ─────────────────────────────────
  let stateAdminLogs = [];
  let stateAdminLogCategory = 'all';

  function filterLogEntries(entries, keyword, category) {
    return entries.filter(item => {
      if (category && category !== 'all') {
        const tag = (item.tag || '').toUpperCase();
        const msg = (item.message || '').toLowerCase();
        const lvl = (item.level || '').toUpperCase();

        if (category === 'error') {
          // AUTH is kept in the error/security bucket (login failure/lockout) so the
          // new server-side Auth tag stays reachable from an existing category.
          const isErr = lvl === 'ERROR' || lvl === 'WARN' || tag.includes('ERR') || msg.includes('error') || msg.includes('fail') || tag.includes('AUTH');
          if (!isErr) return false;
        } else if (category === 'security') {
          // 認證與設定變更事件（伺服器新增的 Auth / Config 標籤）。
          if (!tag.includes('AUTH') && !tag.includes('CONFIG')) return false;
        } else if (category === 'http') {
          if (tag !== 'HTTP') return false;
        } else if (category === 'search') {
          if (!tag.includes('SEARCH') && !tag.includes('INDEX')) return false;
        } else if (category === 'render') {
          if (tag !== 'RENDER') return false;
        } else if (category === 'bot') {
          const isBot = item.isBot === true || tag.includes('BOT') || msg.includes('bot') || msg.includes('crawler') || msg.includes('spider');
          if (!isBot) return false;
        }
      }

      if (keyword) {
        const text = `${item.timestamp} ${item.level} ${item.tag} ${item.ip || ''} ${item.message}`.toLowerCase();
        if (!text.includes(keyword.toLowerCase())) return false;
      }
      return true;
    });
  }

  // Timezone Formatting Helper (Centralized Admin Timezone)
  function getEffectiveTimezone() {
    const sel = $('settingsTimezone');
    const val = sel ? sel.value : (storage.get(STORAGE_KEYS.ADMIN_TZ) || 'auto');
    if (val && val !== 'auto') return val;
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Taipei';
    } catch (_) {
      return 'Asia/Taipei';
    }
  }

  function formatTimestampWithTZ(isoStr, tz) {
    if (!isoStr) return '';
    try {
      const d = new Date(isoStr);
      if (isNaN(d.getTime())) return isoStr;
      const targetTz = (tz === 'auto' || !tz) ? getEffectiveTimezone() : tz;
      const formatter = new Intl.DateTimeFormat(activeLocale(), {
        timeZone: targetTz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      });
      return formatter.format(d).replace(/\//g, '-');
    } catch (_) {
      return isoStr.replace('T', ' ').replace('Z', '');
    }
  }

  async function fetchAdminLogs() {
    const viewer = $('adminLogViewer');
    if (!viewer) return;
    viewer.innerHTML = '<div class="search-loading"><div class="spinner"></div><span>載入日誌中…</span></div>';
    try {
      const headers = {};
      const res = await fetch('/api/admin/logs', { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      stateAdminLogs = Array.isArray(data.logs) ? data.logs : [];
      renderAdminLogs();
    } catch (err) {
      viewer.innerHTML = `<div class="panel-placeholder"><span class="placeholder-icon">⚠️</span><span>無法讀取系統日誌: ${escHtml(err.message)}</span></div>`;
    }
  }

  function renderAdminLogs() {
    const viewer = $('adminLogViewer');
    const searchInput = $('adminLogSearchInput');
    const filterText = searchInput ? searchInput.value.trim() : '';
    if (!viewer) return;

    const currentTz = getEffectiveTimezone();
    const filtered = filterLogEntries(stateAdminLogs, filterText, stateAdminLogCategory);

    const countEl = $('adminLogsCount');
    if (countEl) {
      countEl.textContent = `共 ${filtered.length} 條日誌紀錄 (最多顯示最近 600 條)`;
    }

    if (filtered.length === 0) {
      viewer.innerHTML = '<div class="panel-placeholder"><span class="placeholder-icon">📜</span><span>沒有找到匹配的日誌紀錄</span></div>';
      return;
    }

    const html = filtered.map(item => {
      const formattedTime = formatTimestampWithTZ(item.timestamp, currentTz);
      const levelClass = item.level || 'INFO';
      const ipStr = item.ip || '127.0.0.1';
      return `<div class="log-entry"><div class="log-meta"><span class="log-time">[${escHtml(formattedTime)}]</span><span class="log-badge ${escHtml(levelClass)}">${escHtml(item.level)}</span><span class="log-tag">[${escHtml(item.tag)}]</span><span class="log-ip" data-ip="${escHtml(ipStr)}" title="點擊以此 IP 篩選">[IP: ${escHtml(ipStr)}]</span></div><div class="log-msg">${escHtml(item.message)}</div></div>`;
    }).join('');

    viewer.innerHTML = html;

    const autoScrollCb = $('adminLogAutoScroll');
    if (!autoScrollCb || autoScrollCb.checked) {
      viewer.scrollTop = viewer.scrollHeight;
    }

    viewer.querySelectorAll('.log-ip').forEach(el => {
      el.addEventListener('click', (e) => {
        const targetIp = e.currentTarget.getAttribute('data-ip');
        if (targetIp && searchInput) {
          searchInput.value = targetIp;
          renderAdminLogs();
        }
      });
    });
  }

  function setupAdminLogControls() {
    const catContainer = $('adminLogCategories');
    if (catContainer && !catContainer._hasControls) {
      catContainer._hasControls = true;
      catContainer.querySelectorAll('.log-cat-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          catContainer.querySelectorAll('.log-cat-btn').forEach(b => b.classList.remove('active'));
          e.currentTarget.classList.add('active');
          stateAdminLogCategory = e.currentTarget.getAttribute('data-cat') || 'all';
          renderAdminLogs();
        });
      });
    }

    const downloadBtn = $('adminLogDownloadBtn');
    if (downloadBtn && !downloadBtn._hasDownloadHandler) {
      downloadBtn._hasDownloadHandler = true;
      downloadBtn.addEventListener('click', () => {
        if (!stateAdminLogs || stateAdminLogs.length === 0) {
          showToast('⚠️ 目前無可下載的日誌', 'warning');
          return;
        }
        const tz = getEffectiveTimezone();
        const searchInput = $('adminLogSearchInput');
        const filterText = searchInput ? searchInput.value.trim() : '';
        const logsToExport = filterLogEntries(stateAdminLogs, filterText, stateAdminLogCategory);

        const lines = logsToExport.map(item => {
          const time = formatTimestampWithTZ(item.timestamp, tz);
          return `[${time}] [${item.level || 'INFO'}] [${item.tag || 'SYS'}] [IP: ${item.ip || '127.0.0.1'}] ${item.message}`;
        });

        const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `mdWebview-logs-${new Date().toISOString().slice(0, 10)}.log`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast(`📥 已成功下載 ${logsToExport.length} 條日誌紀錄`, 'success');
      });
    }
  }

  // Analytics Dashboard Logic
  let stateAnalyticsRange = '1d';

  async function loadAdminAnalytics() {
    const tableBody = $('analyticsTopFilesTable');
    if (tableBody) {
      tableBody.innerHTML = '<tr><td colspan="5" class="analytics-empty">載入數據中…</td></tr>';
    }
    try {
      const headers = {};
      const tz = getEffectiveTimezone();
      const res = await fetch(`/api/admin/analytics?range=${stateAnalyticsRange}&tz=${encodeURIComponent(tz)}`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      renderAdminAnalytics(data);
    } catch (err) {
      if (tableBody) {
        tableBody.innerHTML = `<tr><td colspan="5" class="analytics-empty">⚠️ 載入失敗: ${escHtml(err.message)}</td></tr>`;
      }
    }
  }

  function renderAdminAnalytics(data) {
    if (!data) return;
    const tz = getEffectiveTimezone();

    const totalViewsEl = $('analyticsTotalViews');
    const uniqueIpsEl = $('analyticsUniqueIps');
    const activeFilesEl = $('analyticsActiveFiles');
    const totalSearchesEl = $('analyticsTotalSearches');

    if (totalViewsEl) totalViewsEl.textContent = (data.summary?.totalViews || 0).toLocaleString();
    if (uniqueIpsEl) uniqueIpsEl.textContent = (data.summary?.uniqueIps || 0).toLocaleString();
    if (activeFilesEl) activeFilesEl.textContent = (data.summary?.activeFiles || 0).toLocaleString();
    if (totalSearchesEl) totalSearchesEl.textContent = (data.summary?.totalSearches || 0).toLocaleString();
    const avgViewsEl = $('analyticsAvgViewsPerDoc');
    if (avgViewsEl) {
      const views = data.summary?.totalViews || 0;
      const files = data.summary?.activeFiles || 0;
      avgViewsEl.textContent = files > 0 ? (views / files).toFixed(1) : '0';
    }
    const dictSearchesEl = $('analyticsDictSearches');
    const dictLookupsEl = $('analyticsDictLookups');
    if (dictSearchesEl) dictSearchesEl.textContent = (data.summary?.dictSearches || 0).toLocaleString();
    if (dictLookupsEl) dictLookupsEl.textContent = (data.summary?.dictLookups || 0).toLocaleString();

    // SVG Visualizations
    renderAnalyticsTrendChart(data.dailyTrend || []);

    const topFilesTable = $('analyticsTopFilesTable');
    if (topFilesTable) {
      if (!data.topFiles || data.topFiles.length === 0) {
        topFilesTable.innerHTML = '<tr><td colspan="5" class="analytics-empty">尚無瀏覽紀錄數據</td></tr>';
      } else {
        topFilesTable.innerHTML = data.topFiles.map((file, idx) => {
          const formattedTime = formatTimestampWithTZ(file.lastAccess, tz);
          const fileUrl = `/?file=${encodeURIComponent(file.path)}`;
          return `<tr>
            <td style="text-align: center; font-weight: 600;">${idx + 1}</td>
            <td>
              <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                <a href="#" class="analytics-file-link" data-path="${escHtml(file.path)}" title="${escHtml(file.path)}" style="color: var(--accent); font-weight: 600; text-decoration: none;">${escHtml(file.fileName)}</a>
                <a href="${escHtml(fileUrl)}" target="_blank" class="table-action-link" title="在新分頁開啟閱讀此經文">📖 檢視 ↗</a>
              </div>
            </td>
            <td style="text-align: right; font-weight: 700; color: var(--link-color);">${file.views.toLocaleString()}</td>
            <td style="text-align: right; font-weight: 600;">${file.uniqueIps.toLocaleString()}</td>
            <td style="color: var(--text-secondary); font-size: 12px;">${escHtml(formattedTime)}</td>
          </tr>`;
        }).join('');

        topFilesTable.querySelectorAll('.analytics-file-link').forEach(link => {
          link.addEventListener('click', (e) => {
            e.preventDefault();
            const filePath = e.currentTarget.getAttribute('data-path');
            if (filePath) {
              closeAdminModal();
              openFile(filePath);
            }
          });
        });
      }
    }

    const topSearchesTable = $('analyticsTopSearchesTable');
    if (topSearchesTable) {
      if (!data.topSearches || data.topSearches.length === 0) {
        topSearchesTable.innerHTML = '<tr><td colspan="4" class="analytics-empty">尚無搜尋紀錄</td></tr>';
      } else {
        topSearchesTable.innerHTML = data.topSearches.map((item, idx) => `<tr>
          <td style="text-align: center; font-weight: 600;">${idx + 1}</td>
          <td style="font-weight: 600;">${escHtml(item.query)}</td>
          <td style="text-align: right; font-weight: 700; color: var(--accent);">${item.count.toLocaleString()}</td>
          <td style="text-align: center;">
            <button type="button" class="table-action-link analytics-replay-search" data-query="${escHtml(item.query)}" title="以這個關鍵字重新搜尋，重現使用者的搜尋結果">🔍 檢視</button>
          </td>
        </tr>`).join('');

        topSearchesTable.querySelectorAll('.analytics-replay-search').forEach(btn => {
          btn.addEventListener('click', (e) => {
            const q = e.currentTarget.getAttribute('data-query');
            if (!q) return;
            closeAdminModal();
            activateSearchPanel(q);
          });
        });
      }
    }

    const topLookupsTable = $('analyticsTopLookupsTable');
    if (topLookupsTable) {
      if (!data.topLookups || data.topLookups.length === 0) {
        topLookupsTable.innerHTML = '<tr><td colspan="6" class="analytics-empty">尚無辭典查閱紀錄</td></tr>';
      } else {
        topLookupsTable.innerHTML = data.topLookups.map((item, idx) => {
          const formattedTime = formatTimestampWithTZ(item.lastLookup, tz);
          return `<tr>
            <td style="text-align: center; font-weight: 600;">${idx + 1}</td>
            <td style="font-weight: 600;">${escHtml(item.headword)}</td>
            <td style="color: var(--text-secondary);">${escHtml(item.fileName)}</td>
            <td style="text-align: right; font-weight: 700; color: var(--link-color);">${item.count.toLocaleString()}</td>
            <td style="color: var(--text-secondary); font-size: calc(12.5px * var(--ui-font-scale, 1));">${escHtml(formattedTime)}</td>
            <td style="text-align: center;">
              <button type="button" class="table-action-link analytics-replay-lookup" data-headword="${escHtml(item.headword)}" title="在辭典側欄重新查詢這個詞條，重現使用者的查閱結果">📖 檢視</button>
            </td>
          </tr>`;
        }).join('');

        topLookupsTable.querySelectorAll('.analytics-replay-lookup').forEach(btn => {
          btn.addEventListener('click', (e) => {
            const hw = e.currentTarget.getAttribute('data-headword');
            if (!hw) return;
            closeAdminModal();
            toggleDictSidebar(true);
            const input = $('dictSearchInput');
            if (input) input.value = hw;
            runDictSearch(hw);
          });
        });
      }
    }

    const topDictSearchesTable = $('analyticsTopDictSearchesTable');
    if (topDictSearchesTable) {
      if (!data.topDictSearches || data.topDictSearches.length === 0) {
        topDictSearchesTable.innerHTML = '<tr><td colspan="4" class="analytics-empty">尚無辭典搜尋紀錄</td></tr>';
      } else {
        topDictSearchesTable.innerHTML = data.topDictSearches.map((item, idx) => `<tr>
          <td style="text-align: center; font-weight: 600;">${idx + 1}</td>
          <td style="font-weight: 600;">${escHtml(item.query)}</td>
          <td style="text-align: right; font-weight: 700; color: var(--accent);">${item.count.toLocaleString()}</td>
          <td style="text-align: center;">
            <button type="button" class="table-action-link analytics-replay-dictsearch" data-query="${escHtml(item.query)}" title="在辭典側欄重新搜尋這個關鍵字，重現使用者的搜尋結果">📖 檢視</button>
          </td>
        </tr>`).join('');

        topDictSearchesTable.querySelectorAll('.analytics-replay-dictsearch').forEach(btn => {
          btn.addEventListener('click', (e) => {
            const q = e.currentTarget.getAttribute('data-query');
            if (!q) return;
            closeAdminModal();
            toggleDictSidebar(true);
            const input = $('dictSearchInput');
            if (input) input.value = q;
            runDictSearch(q);
          });
        });
      }
    }

    const topIpsTable = $('analyticsTopIpsTable');
    if (topIpsTable) {
      if (!data.ipDistribution || data.ipDistribution.length === 0) {
        topIpsTable.innerHTML = '<tr><td colspan="3" class="analytics-empty">尚無 IP 紀錄</td></tr>';
      } else {
        topIpsTable.innerHTML = data.ipDistribution.map((item, idx) => `<tr>
          <td style="text-align: center; font-weight: 600;">${idx + 1}</td>
          <td><span class="log-ip">${escHtml(item.ip)}</span></td>
          <td style="text-align: right; font-weight: 700; color: var(--link-color);">${item.requests.toLocaleString()}</td>
        </tr>`).join('');
      }
    }

    applyAnalyticsTableFilter();
  }

  function setupAnalyticsTableFilter() {
    const input = $('analyticsTableFilterInput');
    if (!input || input._hasFilterHandler) return;
    input._hasFilterHandler = true;

    input.addEventListener('input', () => {
      applyAnalyticsTableFilter();
    });
  }

  function applyAnalyticsTableFilter() {
    const input = $('analyticsTableFilterInput');
    if (!input) return;
    const q = input.value.trim().toLowerCase();
    const tables = [
      $('analyticsTopFilesTable'),
      $('analyticsTopSearchesTable'),
      $('analyticsTopLookupsTable'),
      $('analyticsTopDictSearchesTable'),
      $('analyticsTopIpsTable')
    ];

    tables.forEach(tbody => {
      if (!tbody) return;
      const rows = tbody.querySelectorAll('tr');
      rows.forEach(tr => {
        if (tr.querySelector('.analytics-empty')) return;
        const text = tr.textContent.toLowerCase();
        tr.style.display = (!q || text.includes(q)) ? '' : 'none';
      });
    });
  }

  // ── §21.6 Settings Forms, Article Picker, Suggest & SEO ────────
  // 分頁切換與表單綁定、文章挑選器、推薦清單設定、Sitemap 與 SEO 工具。

  function setupAdminTabEvents() {
    if (state._adminTabEventsSetup) return;
    state._adminTabEventsSetup = true;

    const tabConfigBtn = $('adminTabConfigBtn');
    const tabSeoBtn = $('adminTabSeoBtn');
    const tabHardwareBtn = $('adminTabHardwareBtn');
    const tabLogsBtn = $('adminTabLogsBtn');
    const tabAnalyticsBtn = $('adminTabAnalyticsBtn');
    const tabSuggestBtn = $('adminTabSuggestBtn');
    const tabUsersBtn = $('adminTabUsersBtn');
    const tabAccountSystemBtn = $('adminTabAccountSystemBtn');
    const paneUsers = $('adminPaneUsers');
    const paneAccountSystem = $('adminPaneAccountSystem');
    const paneConfig = $('adminPaneConfig');
    const paneSeo = $('adminPaneSeo');
    const paneHardware = $('adminPaneHardware');
    const paneLogs = $('adminPaneLogs');
    const paneAnalytics = $('adminPaneAnalytics');
    const paneSuggest = $('adminPaneSuggest');
    const refreshBtn = $('adminLogRefreshBtn');
    const searchInput = $('adminLogSearchInput');
    const settingsTzSelect = $('settingsTimezone');

    function hideAllPanes() {
      if (hwAutoRefreshTimer) {
        clearInterval(hwAutoRefreshTimer);
        hwAutoRefreshTimer = null;
      }
      [paneConfig, paneSeo, paneHardware, paneLogs, paneAnalytics, paneSuggest, paneUsers, paneAccountSystem].forEach(p => { if (p) p.style.display = 'none'; });
      [tabConfigBtn, tabSeoBtn, tabHardwareBtn, tabLogsBtn, tabAnalyticsBtn, tabSuggestBtn, tabUsersBtn, tabAccountSystemBtn].forEach(b => { if (b) b.classList.remove('active'); });
    }

    function activateTab(btn, pane, callback) {
      hideAllPanes();
      if (btn) {
        btn.classList.add('active');
        btn.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
      }
      if (pane) pane.style.display = 'block';
      if (callback) callback();
    }

    if (tabConfigBtn) {
      tabConfigBtn.addEventListener('click', () => {
        activateTab(tabConfigBtn, paneConfig);
      });
    }

    if (tabSeoBtn) {
      tabSeoBtn.addEventListener('click', () => {
        activateTab(tabSeoBtn, paneSeo, () => {
          loadSeoSettings();
          updateOgLivePreview();
        });
      });
    }

    if (tabHardwareBtn) {
      tabHardwareBtn.addEventListener('click', () => {
        activateTab(tabHardwareBtn, paneHardware, () => {
          loadHardwareStats();
          setupHardwareAutoRefresh();
        });
      });
    }

    if (tabLogsBtn) {
      tabLogsBtn.addEventListener('click', () => {
        activateTab(tabLogsBtn, paneLogs, () => {
          fetchAdminLogs();
        });
      });
    }

    if (tabAnalyticsBtn) {
      tabAnalyticsBtn.addEventListener('click', () => {
        activateTab(tabAnalyticsBtn, paneAnalytics, () => {
          loadAdminAnalytics();
        });
      });
    }

    if (tabSuggestBtn) {
      tabSuggestBtn.addEventListener('click', () => {
        activateTab(tabSuggestBtn, paneSuggest, () => {
          loadSuggestSettings();
        });
      });
    }

    if (tabUsersBtn) {
      tabUsersBtn.addEventListener('click', () => {
        activateTab(tabUsersBtn, paneUsers, () => {
          setupAdminAccountEvents();
          loadAdminUsersTab();
        });
      });
    }

    if (tabAccountSystemBtn) {
      tabAccountSystemBtn.addEventListener('click', () => {
        activateTab(tabAccountSystemBtn, paneAccountSystem, () => {
          setupAdminAccountEvents();
          loadAdminAccountSystemTab();
        });
      });
    }

    if (settingsTzSelect) {
      settingsTzSelect.addEventListener('change', () => {
        const val = settingsTzSelect.value;
        storage.set(STORAGE_KEYS.ADMIN_TZ, val);
        if (stateAdminLogs && stateAdminLogs.length > 0) renderAdminLogs();
        if ($('adminPaneAnalytics') && $('adminPaneAnalytics').style.display !== 'none') {
          loadAdminAnalytics();
        }
      });
    }

    const rangeNav = $('analyticsRangeNav');
    if (rangeNav) {
      rangeNav.querySelectorAll('.analytics-range-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          rangeNav.querySelectorAll('.analytics-range-btn').forEach(b => b.classList.remove('active'));
          e.currentTarget.classList.add('active');
          stateAnalyticsRange = e.currentTarget.getAttribute('data-range') || '7d';
          loadAdminAnalytics();
        });
      });
    }

    const csvExportBtn = $('analyticsExportCsvBtn');
    const jsonExportBtn = $('analyticsExportJsonBtn');

    const exportAnalytics = async (format) => {
      const tz = getEffectiveTimezone();
      const params = new URLSearchParams({ range: stateAnalyticsRange, format, tz });
      try {
        const response = await fetch(`/api/admin/analytics/export?${params}`, {
          headers: {}
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `analytics-report-${stateAnalyticsRange}.${format}`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        showToast(`📥 已成功導出分析數據報告 (${format.toUpperCase()})`, 'success');
      } catch (err) {
        console.warn('[Analytics] Export failed:', err);
        showToast('❌ 分析數據報告導出失敗', 'error');
      }
    };

    if (csvExportBtn) csvExportBtn.addEventListener('click', () => exportAnalytics('csv'));
    if (jsonExportBtn) jsonExportBtn.addEventListener('click', () => exportAnalytics('json'));

    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        fetchAdminLogs();
        showToast('🔄 系統日誌與狀態已更新', 'info');
      });
    }

    if (searchInput) {
      searchInput.addEventListener('input', debounce(() => renderAdminLogs(), 200));
    }

    // Initialize all admin enhancement handlers
    setupPathDiagnostics();
    setupChangePassword();
    setupConfigBackupAndRestore();
    setupHardwareClearCache();
    setupArticlePicker();
    setupSeoSitemapActions();
    setupAdminLogControls();
    setupAnalyticsTableFilter();
    setupAdminDirtyTracking();

    // Suggest form events (only once)
    setupSuggestFormEvents();
  }

  function getFlattenedMarkdownFiles() {
    const result = [];
    if (!state.treeData) return result;
    (function walk(list) {
      if (!Array.isArray(list)) return;
      for (const n of list) {
        if (n.type === 'file' && n.path && n.path.toLowerCase().endsWith('.md')) {
          result.push({ name: n.name, path: n.path });
        }
        if (n.children) walk(n.children);
      }
    })(state.treeData);
    return result;
  }

  function setupArticlePicker() {
    const searchInput = $('suggestArticleSearchInput');
    const clearBtn = $('suggestArticleClearBtn');
    const dropdown = $('suggestArticleDropdown');
    const adminTextarea = $('suggestAdminList');

    if (!searchInput || !dropdown || !adminTextarea || searchInput._hasPickerHandler) return;
    searchInput._hasPickerHandler = true;

    function closeDropdown() {
      dropdown.style.display = 'none';
      dropdown.innerHTML = '';
    }

    searchInput.addEventListener('input', () => {
      const q = searchInput.value.trim().toLowerCase();
      if (!q) {
        if (clearBtn) clearBtn.style.display = 'none';
        closeDropdown();
        return;
      }
      if (clearBtn) clearBtn.style.display = 'block';

      const allFiles = getFlattenedMarkdownFiles();
      const matched = [];
      for (const file of allFiles) {
        if (file.name.toLowerCase().includes(q) || file.path.toLowerCase().includes(q)) {
          matched.push(file);
          if (matched.length >= 25) break;
        }
      }

      if (matched.length === 0) {
        dropdown.innerHTML = '<div class="article-picker-item" style="color: var(--text-muted); cursor: default;">未找到符合的經文</div>';
        dropdown.style.display = 'block';
        return;
      }

      dropdown.innerHTML = matched.map(f => `
        <div class="article-picker-item" data-path="${escHtml(f.path)}">
          <span style="font-weight: 500;">${escHtml(f.name)}</span>
          <span class="article-picker-item-path">${escHtml(f.path)}</span>
        </div>
      `).join('');
      dropdown.style.display = 'block';

      dropdown.querySelectorAll('.article-picker-item').forEach(item => {
        item.addEventListener('click', () => {
          const filePath = item.getAttribute('data-path');
          if (!filePath) return;
          const currentLines = adminTextarea.value.split('\n').map(l => l.trim()).filter(Boolean);
          if (!currentLines.includes(filePath)) {
            currentLines.push(filePath);
            adminTextarea.value = currentLines.join('\n');
            setAdminDirty(true);
            showToast(`➕ 已加入「${filePath}」至推薦清單`, 'info');
          } else {
            showToast(`「${filePath}」已在推薦清單中`, 'info');
          }
          searchInput.value = '';
          if (clearBtn) clearBtn.style.display = 'none';
          closeDropdown();
        });
      });
    });

    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        searchInput.value = '';
        clearBtn.style.display = 'none';
        closeDropdown();
      });
    }

    document.addEventListener('click', (e) => {
      if (!searchInput.contains(e.target) && !dropdown.contains(e.target)) {
        closeDropdown();
      }
    });
  }

  function updateOgLivePreview() {
    const card = $('ogLivePreviewCard');
    if (!card) return;

    const siteName = ($('settingsSiteName') ? $('settingsSiteName').value.trim() : state.siteName) || 'mdWebview';
    const desc = ($('seoSiteDescription') ? $('seoSiteDescription').value.trim() : '') || '佛典經論電子書閱讀器與辭典查詢系統';
    const ogImg = ($('seoOgImage') ? $('seoOgImage').value.trim() : '') || '/og-preview.png';
    let siteUrl = ($('settingsSiteUrl') ? $('settingsSiteUrl').value.trim() : '') || window.location.origin;

    let domain = 'mbt.mahabodhi.co';
    try {
      const u = new URL(siteUrl.startsWith('http') ? siteUrl : `https://${siteUrl}`);
      domain = u.hostname;
    } catch (_) {
      domain = window.location.hostname || 'mbt.mahabodhi.co';
    }

    const domainEl = $('ogPreviewDomain');
    const titleEl = $('ogPreviewTitle');
    const descEl = $('ogPreviewDesc');
    const imgEl = $('ogPreviewImg');

    if (domainEl) domainEl.textContent = domain;
    if (titleEl) titleEl.textContent = `${siteName} — 佛典經論閱讀器`;
    if (descEl) descEl.textContent = desc;
    if (imgEl) {
      imgEl.src = ogImg || '/og-preview.png';
      imgEl.onerror = () => { imgEl.src = '/icon-512.png'; };
    }
  }

  function setupSeoSitemapActions() {
    const btnRebuild = $('btnRebuildSitemap');
    const btnPing = $('btnPingSearchEngines');
    const resultMsg = $('seoRebuildResultMsg');

    if (btnRebuild && !btnRebuild._hasRebuildHandler) {
      btnRebuild._hasRebuildHandler = true;
      btnRebuild.addEventListener('click', async () => {
        const origText = btnRebuild.textContent;
        btnRebuild.disabled = true;
        btnRebuild.textContent = '🔄 生成中…';
        if (resultMsg) {
          resultMsg.className = 'form-hint';
          resultMsg.innerHTML = '<span style="opacity: 0.7;">正在掃描經文庫並建置最新 Sitemap XML…</span>';
          resultMsg.style.display = 'block';
        }

        try {
          const res = await fetch('/api/admin/rebuild-sitemap', {
            method: 'POST',
            headers: {}
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || '生成失敗');

          if (resultMsg) {
            const formattedTime = formatSitemapDateTime(data.sitemapBuiltAt || Date.now());
            resultMsg.className = 'form-success-text';
            resultMsg.innerHTML = `✅ <b>Sitemap 重建完成</b>：共包含 <b>${data.totalUrls}</b> 個經文網址，耗時 <b>${data.durationMs}ms</b>。<br>建立時間：<b>${formattedTime}</b> | <a href="${data.sitemapUrl}" target="_blank" style="color: var(--accent);">檢視 Sitemap ↗</a>`;
          }
          showToast(`✅ Sitemap 已成功重新生成 (${data.totalUrls} 筆)`, 'success');
          await fetchSeoStats();
        } catch (err) {
          if (resultMsg) {
            resultMsg.className = 'form-error-text';
            resultMsg.textContent = '❌ ' + err.message;
          }
          showToast('❌ Sitemap 重建失敗：' + err.message, 'error');
        } finally {
          btnRebuild.disabled = false;
          btnRebuild.textContent = origText;
        }
      });
    }

    if (btnPing && !btnPing._hasPingHandler) {
      btnPing._hasPingHandler = true;
      btnPing.addEventListener('click', () => {
        const baseUrl = ($('settingsSiteUrl') ? $('settingsSiteUrl').value.trim() : '') || window.location.origin;
        const sitemapUrl = `${baseUrl}/sitemap.xml`;
        const googlePingUrl = `https://www.google.com/ping?sitemap=${encodeURIComponent(sitemapUrl)}`;
        const bingPingUrl = `https://www.bing.com/ping?sitemap=${encodeURIComponent(sitemapUrl)}`;

        window.open(googlePingUrl, '_blank');
        window.open(bingPingUrl, '_blank');

        if (resultMsg) {
          resultMsg.className = 'form-success-text';
          resultMsg.innerHTML = `📡 已在新分頁中向 Google 與 Bing 發送 Sitemap 爬取通知 (${escHtml(sitemapUrl)})`;
          resultMsg.style.display = 'block';
        }
        showToast('📡 已向 Google 與 Bing 發送 Sitemap 爬取通知', 'info');
      });
    }
  }

  let _suggestFormEventsSetup = false;
  function setupSuggestFormEvents() {
    if (_suggestFormEventsSetup) return;
    _suggestFormEventsSetup = true;

    const selectAllBtn = $('suggestDictSelectAllBtn');
    const selectNoneBtn = $('suggestDictSelectNoneBtn');
    if (selectAllBtn) {
      selectAllBtn.addEventListener('click', () => {
        const cbs = document.querySelectorAll('.suggest-dict-cb');
        cbs.forEach(cb => { cb.checked = true; });
      });
    }
    if (selectNoneBtn) {
      selectNoneBtn.addEventListener('click', () => {
        const cbs = document.querySelectorAll('.suggest-dict-cb');
        cbs.forEach(cb => { cb.checked = false; });
      });
    }

    const cancelBtn = $('suggestCancelBtn');
    if (cancelBtn && !cancelBtn._hasCancelHandler) {
      cancelBtn._hasCancelHandler = true;
      cancelBtn.addEventListener('click', () => {
        closeAdminModal();
      });
    }


    const form = $('adminSuggestForm');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errorEl = $('suggestErrorMsg');
      const successEl = $('suggestSuccessMsg');
      if (errorEl) errorEl.style.display = 'none';
      if (successEl) successEl.style.display = 'none';

      const adminListRaw = ($('suggestAdminList') || {}).value || '';
      const blackListRaw = ($('suggestBlackList') || {}).value || '';
      const adminPickCountRaw = ($('suggestAdminPickCount') || {}).value;
      const hotPickCountRaw = ($('suggestHotPickCount') || {}).value;
      const dailyWordCountRaw = ($('suggestDailyWordCount') || {}).value;
      const dailyWordRotateHourRaw = ($('suggestDailyWordRotateHour') || {}).value;

      const parsedAdminPick = parseInt(adminPickCountRaw, 10);
      const adminPickCount = Number.isFinite(parsedAdminPick) ? Math.max(0, Math.min(20, parsedAdminPick)) : 3;

      const parsedHotPick = parseInt(hotPickCountRaw, 10);
      const hotPickCount = Number.isFinite(parsedHotPick) ? Math.max(0, Math.min(20, parsedHotPick)) : 5;

      const parsedDailyCount = parseInt(dailyWordCountRaw, 10);
      const dailyWordCount = Number.isFinite(parsedDailyCount) ? Math.max(0, Math.min(20, parsedDailyCount)) : 3;

      const parsedDailyRotate = parseInt(dailyWordRotateHourRaw, 10);
      const dailyWordRotateHour = Number.isFinite(parsedDailyRotate) ? Math.max(1, Math.min(168, parsedDailyRotate)) : 12;

      const enabled = !!(($('suggestEnabled') || {}).checked);

      // Collect checked dictionaries
      const checkedDicts = [];
      const cbs = document.querySelectorAll('.suggest-dict-cb:checked');
      cbs.forEach(cb => { if (cb.value) checkedDicts.push(cb.value); });

      // Parse textarea lines
      const adminList = adminListRaw.split('\n').map(l => l.trim()).filter(Boolean);
      const blackList = blackListRaw.split('\n').map(l => l.trim()).filter(Boolean);

      try {
        // Fetch current settings to preserve other fields
        const getRes = await fetch('/api/admin/settings', {
          headers: {}
        });
        if (!getRes.ok) throw new Error('Unable to load settings');
        const current = await getRes.json();
        const s = current.settings || {};

        const res = await fetch('/api/admin/settings', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            settings: {
              suggestList: {
                adminList,
                adminPickCount,
                blackList,
                hotPickCount,
                dailyWordCount,
                dailyWordDicts: checkedDicts,
                dailyWordRotateHour,
                enabled
              }
            }
          })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '儲存失敗');

        _lastAdminSettings = data.settings || null;
        setAdminDirty(false);

        if (successEl) {
          successEl.textContent = '推薦設定已儲存';
          successEl.style.display = 'block';
          setTimeout(() => { successEl.style.display = 'none'; }, 3000);
        }
        showToast('✅ 推薦閱讀設定已儲存', 'success');
        // Refresh the homepage suggest list
        fetchSuggestList(false);
      } catch (err) {
        if (errorEl) {
          errorEl.textContent = err.message;
          errorEl.style.display = 'block';
        }
        showToast('推薦閱讀設定儲存失敗：' + err.message, 'error');
      }
    });

    setupAdminSeoEvents();
  }

  async function loadSuggestSettings(passedSettings = null) {
    const dictListContainer = $('suggestDictCheckboxList');
    const dictNoticeEl = $('suggestDictNotice');

    try {
      // 1. Kick off fetching dict files immediately in parallel
      const dictPromise = fetch('/api/dict-files')
        .then(r => r.ok ? r.json() : { enabled: false, files: [] })
        .catch(err => {
          console.warn('[Admin] Failed to fetch dict files:', err);
          return { enabled: false, files: [] };
        });

      // 2. Resolve settings: use passed, cached, or fetch
      let settings = passedSettings || _lastAdminSettings;
      if (!settings) {
        try {
          const res = await fetch('/api/admin/settings', {
            headers: {}
          });
          if (res.ok) {
            const data = await res.json();
            settings = data.settings || {};
            _lastAdminSettings = settings;
          }
        } catch (err) {
          console.warn('[Admin] Failed to fetch admin settings:', err);
        }
      } else {
        _lastAdminSettings = settings;
      }

      const sl = (settings && settings.suggestList) || {};
      const dictEnabled = settings ? (settings.dictionaryEnabled === true) : true;

      const adminListEl = $('suggestAdminList');
      const blackListEl = $('suggestBlackList');
      const adminPickEl = $('suggestAdminPickCount');
      const hotPickEl = $('suggestHotPickCount');
      const dailyCountEl = $('suggestDailyWordCount');
      const dailyRotateEl = $('suggestDailyWordRotateHour');
      const enabledEl = $('suggestEnabled');

      if (adminListEl && settings) adminListEl.value = (sl.adminList || []).join('\n');
      if (blackListEl && settings) blackListEl.value = (sl.blackList || []).join('\n');
      if (adminPickEl && settings) adminPickEl.value = sl.adminPickCount ?? 3;
      if (hotPickEl && settings) hotPickEl.value = sl.hotPickCount ?? 5;
      if (dailyCountEl && settings) dailyCountEl.value = sl.dailyWordCount ?? 3;
      if (dailyRotateEl && settings) dailyRotateEl.value = sl.dailyWordRotateHour ?? 12;
      if (enabledEl && settings) enabledEl.checked = sl.enabled === true;

      // 3. Render dictionary files
      const dictData = await dictPromise;
      const files = dictData.files || [];

      if (!dictEnabled || !dictData.enabled) {
        if (dictNoticeEl) {
          dictNoticeEl.textContent = '⚠️ 系統尚未開啟「辭典查詢」功能（請至「網站設定」Tab 啟用），目前無法抽取每日單詞。';
          dictNoticeEl.style.display = 'block';
        }
      } else {
        if (dictNoticeEl) dictNoticeEl.style.display = 'none';
      }

      if (dictListContainer) {
        if (files.length === 0) {
          dictListContainer.innerHTML = '<span class="suggest-dict-loading">尚未安裝任何辭典檔案</span>';
        } else {
          const selectedDicts = new Set(sl.dailyWordDicts || []);
          const checkAllByDefault = (!sl.dailyWordDicts || sl.dailyWordDicts.length === 0);

          dictListContainer.innerHTML = '';
          for (const df of files) {
            const label = document.createElement('label');
            label.className = 'suggest-dict-checkbox-item';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.value = df.name;
            cb.checked = checkAllByDefault || selectedDicts.has(df.name) || selectedDicts.has(df.fileName) || selectedDicts.has(df.relPath);
            cb.className = 'suggest-dict-cb';

            const span = document.createElement('span');
            span.textContent = df.name;

            label.appendChild(cb);
            label.appendChild(span);
            dictListContainer.appendChild(label);
          }
        }
      }
    } catch (err) {
      console.error('[Admin] Error loading suggest settings:', err);
      if (dictListContainer) {
        dictListContainer.innerHTML = '<span class="suggest-dict-loading">無法載入辭典清單</span>';
      }
    }
  }

  // ── SEO Settings Tab ──
  async function loadSeoSettings(passedSettings = null) {
    try {
      let settings = passedSettings || _lastAdminSettings;
      if (!settings) {
        try {
          const res = await fetch('/api/admin/settings', {
            headers: {}
          });
          if (res.ok) {
            const data = await res.json();
            settings = data.settings || {};
            _lastAdminSettings = settings;
          }
        } catch (err) {
          console.warn('[Admin] Failed to fetch settings for SEO:', err);
        }
      }

      if (settings) {
        const descEl = $('seoSiteDescription');
        const kwEl = $('seoKeywords');
        const ogImgEl = $('seoOgImage');
        const robIdxEl = $('seoRobotsIndex');
        const blockAiEl = $('seoBlockAiBots');
        const disallowEl = $('seoDisallowPaths');
        const gVerEl = $('googleSiteVerification');
        const bingVerEl = $('bingSiteVerification');
        const baiduVerEl = $('baiduSiteVerification');
        const searchBoxEl = $('seoEnableSearchBox');
        const summaryEl = $('seoHomepageSummary');

        if (descEl) descEl.value = settings.seoSiteDescription || '';
        if (kwEl) kwEl.value = settings.seoKeywords || '';
        if (ogImgEl) ogImgEl.value = settings.seoOgImage || '/og-preview.png';
        if (robIdxEl) robIdxEl.checked = settings.seoRobotsIndex === true;
        if (blockAiEl) blockAiEl.checked = settings.seoBlockAiBots !== false;
        if (disallowEl) disallowEl.value = settings.seoDisallowPaths || '/api/\n/vendor/';
        if (gVerEl) gVerEl.value = settings.googleSiteVerification || '';
        if (bingVerEl) bingVerEl.value = settings.bingSiteVerification || '';
        if (baiduVerEl) baiduVerEl.value = settings.baiduSiteVerification || '';
        if (searchBoxEl) searchBoxEl.checked = settings.seoEnableSearchBox === true;
        if (summaryEl) summaryEl.value = settings.seoHomepageSummary || '';
      }

      await fetchSeoStats();
      updateOgLivePreview();
    } catch (err) {
      console.error('[Admin] Error loading SEO settings:', err);
    }
  }

  function formatSitemapDateTime(ts) {
    if (!ts || ts <= 0) return '尚未建立';
    try {
      const d = new Date(ts);
      if (isNaN(d.getTime())) return '尚未建立';
      const pad = n => String(n).padStart(2, '0');
      const yyyy = d.getFullYear();
      const mm = pad(d.getMonth() + 1);
      const dd = pad(d.getDate());
      const hh = pad(d.getHours());
      const min = pad(d.getMinutes());
      const ss = pad(d.getSeconds());
      return `${yyyy}/${mm}/${dd} ${hh}:${min}:${ss}`;
    } catch (_) {
      return '尚未建立';
    }
  }

  async function fetchSeoStats() {
    try {
      const res = await fetch('/api/admin/seo-stats', {
        headers: {}
      });
      if (!res.ok) return;
      const data = await res.json();

      const totalFilesEl = $('seoStatTotalFiles');
      const sitemapStatusEl = $('seoStatSitemapStatus');
      const sitemapTimeEl = $('seoStatSitemapTime');
      const baseUrlEl = $('seoStatBaseUrl');
      const robotsLink = $('seoRobotsLink');
      const sitemapLink = $('seoSitemapLink');

      if (totalFilesEl) totalFilesEl.textContent = (data.totalMarkdownFiles || 0).toLocaleString() + ' 部';
      if (sitemapStatusEl) sitemapStatusEl.textContent = data.sitemapCached ? '已就緒 (快取中)' : '就緒 (即時生成)';
      if (sitemapTimeEl) sitemapTimeEl.textContent = formatSitemapDateTime(data.sitemapBuiltAt);
      if (baseUrlEl) baseUrlEl.textContent = data.effectiveBaseUrl || window.location.origin;
      if (robotsLink && data.robotsUrl) robotsLink.href = data.robotsUrl;
      if (sitemapLink && data.sitemapUrl) sitemapLink.href = data.sitemapUrl;
    } catch (err) {
      console.warn('[Admin] Failed to fetch SEO stats:', err);
    }
  }

  function setupAdminSeoEvents() {
    const seoForm = $('adminSeoForm');
    const cancelBtn = $('seoCancelBtn');
    const successMsg = $('seoSuccessMsg');
    const errorMsg = $('seoErrorMsg');

    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        closeAdminModal();
      });
    }

    ['seoSiteDescription', 'seoOgImage'].forEach(id => {
      const el = $(id);
      if (el && !el._hasOgListener) {
        el._hasOgListener = true;
        el.addEventListener('input', () => updateOgLivePreview());
      }
    });
    const siteNameEl = $('settingsSiteName');
    if (siteNameEl && !siteNameEl._hasOgListener) {
      siteNameEl._hasOgListener = true;
      siteNameEl.addEventListener('input', () => updateOgLivePreview());
    }

    if (seoForm) {
      seoForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (successMsg) successMsg.style.display = 'none';
        if (errorMsg) errorMsg.style.display = 'none';

        const submitBtn = $('seoSubmitBtn');
        if (submitBtn) submitBtn.disabled = true;

        try {
          const payload = {
            seoSiteDescription: ($('seoSiteDescription') || {}).value || '',
            seoKeywords: ($('seoKeywords') || {}).value || '',
            seoOgImage: ($('seoOgImage') || {}).value || '',
            seoRobotsIndex: ($('seoRobotsIndex') || {}).checked,
            seoBlockAiBots: ($('seoBlockAiBots') || {}).checked,
            seoDisallowPaths: ($('seoDisallowPaths') || {}).value || '',
            googleSiteVerification: ($('googleSiteVerification') || {}).value || '',
            bingSiteVerification: ($('bingSiteVerification') || {}).value || '',
            baiduSiteVerification: ($('baiduSiteVerification') || {}).value || '',
            seoEnableSearchBox: ($('seoEnableSearchBox') || {}).checked,
            seoHomepageSummary: ($('seoHomepageSummary') || {}).value || ''
          };

          const res = await fetch('/api/admin/settings', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ settings: payload })
          });

          const data = await res.json();
          if (!res.ok) throw new Error(data.error || '儲存 SEO 設定失敗');

          if (data.settings) _lastAdminSettings = data.settings;
          setAdminDirty(false);
          updateOgLivePreview();
          showToast('✅ 搜尋引擎優化 (SEO) 設定已成功儲存並生效', 'success');
          if (successMsg) {
            successMsg.textContent = '✅ 設定已成功更新';
            successMsg.style.display = 'inline';
            setTimeout(() => { successMsg.style.display = 'none'; }, 3000);
          }
          await fetchSeoStats();
        } catch (err) {
          showToast('❌ 儲存失敗：' + err.message, 'error');
          if (errorMsg) {
            errorMsg.textContent = '❌ ' + err.message;
            errorMsg.style.display = 'inline';
          }
        } finally {
          if (submitBtn) submitBtn.disabled = false;
        }
      });
    }
  }

  // ═══════════════════════════════════════════════════════════
  // §21.7 使用者帳號（登入、註冊、我的帳號、後台「使用者」與「帳號系統」分頁）
  //
  // Session 放在 HttpOnly cookie，前端不保存任何 token；state.account.user
  // 只是畫面用的快照（/api/me）。單機模式沒有帳號，整段功能隱藏。
  // ═══════════════════════════════════════════════════════════
  const PROVIDER_LABELS = { google: 'Google', facebook: 'Facebook', apple: 'Apple' };
  const ACCOUNT_URL_PARAMS = ['auth', 'token', 'status', 'mode', 'code'];
  const authUi = { view: 'login', openedAt: 0, resetToken: '', turnstileWidget: null, turnstileToken: '', needTurnstile: false, pendingReauth: null, afterLogin: '' };

  /** JSON 請求；回傳 { ok, status, data }，不丟出例外（網路錯誤時 status 為 0）。 */
  async function accountApi(url, { method = 'GET', body } = {}) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    try {
      const res = await fetch(url, opts);
      let data = {};
      try { data = await res.json(); } catch (_) {}
      return { ok: res.ok, status: res.status, data };
    } catch (_) {
      return { ok: false, status: 0, data: { error: '網路連線失敗，請稍後再試' } };
    }
  }

  /** 需要「10 分鐘內重新驗證」的操作：遇到 REAUTH_REQUIRED 就先請使用者驗證，再重試一次。 */
  async function withReauth(run) {
    const first = await run();
    if (first.status !== 403 || !first.data || first.data.code !== 'REAUTH_REQUIRED') return first;
    const passed = await openReauthOverlay();
    if (!passed) return { ok: false, status: 403, data: { error: '已取消', code: 'REAUTH_CANCELLED' } };
    return run();
  }

  function fmtDateTime(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function describeUserAgent(ua) {
    const s = String(ua || '');
    const browser = /Edg\//.test(s) ? 'Edge' : /Chrome\//.test(s) ? 'Chrome' : /Firefox\//.test(s) ? 'Firefox' : /Safari\//.test(s) ? 'Safari' : '瀏覽器';
    const os = /iPhone|iPad/.test(s) ? 'iOS' : /Android/.test(s) ? 'Android' : /Mac OS X/.test(s) ? 'macOS' : /Windows/.test(s) ? 'Windows' : /Linux/.test(s) ? 'Linux' : '';
    return os ? `${browser} · ${os}` : browser;
  }

  function showBox(el, text) {
    if (!el) return;
    el.textContent = text || '';
    el.style.display = text ? 'block' : 'none';
  }

  // ── 右上角整合選單：帳號狀態、繁簡、主題、偏好設定、我的帳號、後台、登出 ──
  function accountsEnabled() {
    return !state.isSingleUser && !!(state.account.config && state.account.config.accountsEnabled);
  }

  /** 依登入狀態與部署模式更新按鈕外觀與選單項目；任何時候呼叫都安全。 */
  function updateUserMenu() {
    const btn = $('userMenuBtn');
    if (!btn) return;
    const user = state.account.user;
    const accounts = accountsEnabled();
    const name = user ? String(user.displayName || user.email || user.username || '?') : '';
    const initial = name ? Array.from(name)[0].toUpperCase() : '';

    btn.classList.toggle('signed-in', !!user);
    btn.classList.toggle('no-accounts', !accounts && !user);
    const label = user ? `選單（${name}）：帳號、繁簡、主題與設定` : '選單：帳號、繁簡、主題與設定';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    if ($('userMenuInitial')) $('userMenuInitial').textContent = initial;

    const accountBox = $('userMenuAccount');
    if (accountBox) accountBox.hidden = !accounts && !user;
    const avatar = $('userMenuAvatar');
    if (avatar) {
      avatar.textContent = initial || '👤';
      avatar.classList.toggle('signed-out', !user);
    }
    if ($('userMenuName')) $('userMenuName').textContent = user ? name : '尚未登入';
    if ($('userMenuRole')) $('userMenuRole').hidden = !(user && user.role === 'admin');
    const sub = $('userMenuSub');
    if (sub) {
      const detail = user ? (user.email && user.email !== name ? user.email : (user.username && user.username !== name ? user.username : '')) : '登入後可同步書籤與閱讀進度';
      sub.textContent = detail;
      sub.hidden = !detail;
    }
    if ($('userMenuAuthRow')) $('userMenuAuthRow').hidden = !!user;
    const cfg = state.account.config || {};
    if ($('userMenuRegisterBtn')) $('userMenuRegisterBtn').hidden = cfg.registrationMode === 'closed';

    if ($('userMenuAccountBtn')) $('userMenuAccountBtn').hidden = !user;
    const showAdmin = state.isSingleUser || state.isAdmin;
    if ($('userMenuAdminBtn')) $('userMenuAdminBtn').hidden = !showAdmin;
    if ($('userMenuAdminLabel')) $('userMenuAdminLabel').textContent = state.isSingleUser ? '系統設定' : '後台系統設定';
    if ($('userMenuLogoutBtn')) $('userMenuLogoutBtn').hidden = !user;
    if ($('userMenuLogoutSep')) $('userMenuLogoutSep').hidden = !user;
    if ($('userMenuFontSize') && state.fontSize) $('userMenuFontSize').textContent = state.fontSize;
    updateLibraryCount();
  }

  function updateUserMenuScript() {
    $$('#userMenuScriptGroup .user-menu-seg-btn').forEach(b => {
      const on = b.getAttribute('data-value') === state.displayScript;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }

  function updateUserMenuTheme(theme) {
    $$('#userMenuThemeGroup .user-menu-theme').forEach(b => {
      const on = b.getAttribute('data-value') === theme;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }

  function isUserMenuOpen() {
    const panel = $('userMenuPanel');
    return !!panel && !panel.hidden;
  }

  function userMenuItems() {
    return Array.from($$('#userMenuPanel button')).filter(b => !b.hidden && b.offsetParent !== null);
  }

  function openUserMenu() {
    const panel = $('userMenuPanel');
    if (!panel) return;
    dismissDisplayScriptNotice();
    updateUserMenu();
    updateUserMenuScript();
    updateUserMenuTheme(state.currentTheme || document.documentElement.getAttribute('data-theme'));
    panel.hidden = false;
    $('userMenuBtn').setAttribute('aria-expanded', 'true');
    const items = userMenuItems();
    const first = items.find(b => b.classList.contains('active')) || items[0];
    if (first) first.focus({ preventScroll: true });
  }

  function closeUserMenu(returnFocus = false) {
    const panel = $('userMenuPanel');
    if (!panel || panel.hidden) return;
    panel.hidden = true;
    $('userMenuBtn').setAttribute('aria-expanded', 'false');
    if (returnFocus) $('userMenuBtn').focus({ preventScroll: true });
  }

  /** 點選單項目：先關選單再做事，避免選單蓋在開出來的視窗上。 */
  function userMenuAction(fn) {
    return (e) => {
      e.preventDefault();
      closeUserMenu();
      fn();
    };
  }

  function setupUserMenu() {
    const btn = $('userMenuBtn');
    const panel = $('userMenuPanel');
    if (!btn || !panel) return;

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isUserMenuOpen()) closeUserMenu();
      else openUserMenu();
    });
    document.addEventListener('click', (e) => {
      if (isUserMenuOpen() && !e.target.closest('#userMenu')) closeUserMenu();
    });
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeUserMenu(true);
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
        const items = userMenuItems();
        if (!items.length) return;
        e.preventDefault();
        const i = items.indexOf(document.activeElement);
        let next;
        if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = items.length - 1;
        else if (e.key === 'ArrowDown') next = i < 0 ? 0 : (i + 1) % items.length;
        else next = i <= 0 ? items.length - 1 : i - 1;
        items[next].focus();
      }
    });
    panel.addEventListener('focusout', (e) => {
      if (e.relatedTarget && !e.relatedTarget.closest('#userMenu')) closeUserMenu();
    });

    // 繁簡與主題：在選單內直接切換，選單保持開著，看得到切換結果
    $$('#userMenuScriptGroup .user-menu-seg-btn').forEach(b => {
      b.addEventListener('click', () => {
        const v = normalizeDisplayScript(b.getAttribute('data-value'));
        if (v && v !== state.displayScript) {
          dismissDisplayScriptNotice();
          applyDisplayScript(v, true, { announce: true });
        }
      });
    });
    $$('#userMenuThemeGroup .user-menu-theme').forEach(b => {
      b.addEventListener('click', () => {
        const theme = b.getAttribute('data-value');
        if (theme && theme !== state.currentTheme) applyTheme(theme, true);
      });
    });

    // 字級：選單保持開著，看得到字變大變小
    $('userMenuFontDec').addEventListener('click', () => applyFontSize(state.fontSize - 1));
    $('userMenuFontInc').addEventListener('click', () => applyFontSize(state.fontSize + 1));
    $('userMenuLibraryBtn').addEventListener('click', userMenuAction(() => openLibrary()));
    setupLibrary();

    $('userMenuLoginBtn').addEventListener('click', userMenuAction(() => openAccountAuth('login')));
    $('userMenuRegisterBtn').addEventListener('click', userMenuAction(() => openAccountAuth('register')));
    $('userMenuSettingsBtn').addEventListener('click', userMenuAction(() => openUserSettingsOverlay()));
    $('userMenuAccountBtn').addEventListener('click', userMenuAction(() => openAccountSettings()));
    $('userMenuAdminBtn').addEventListener('click', userMenuAction(() => openSettingsOverlay()));
    $('userMenuLogoutBtn').addEventListener('click', userMenuAction(() => accountLogout()));

    updateUserMenu();
    updateUserMenuScript();
    updateUserMenuTheme(state.currentTheme || document.documentElement.getAttribute('data-theme'));
  }

  // ── 書籤與歷程：右側抽屜 ──
  // 書籤依資料夾分組（可收合），可篩選、依加入順序或名稱排序；歷程依日期分組，
  // 顯示上次讀到的位置。分頁、排序、收合狀態只是個人便利，存在 localStorage。
  const libraryUi = (() => {
    const saved = storage.getJson(STORAGE_KEYS.LIBRARY_PREFS, null) || {};
    return {
      tab: saved.tab === 'recent' ? 'recent' : 'bookmarks',
      sort: saved.sort === 'name' ? 'name' : 'new',
      collapsed: (saved.collapsed && typeof saved.collapsed === 'object') ? saved.collapsed : {},
      q: ''
    };
  })();
  let libraryCloseTimer = null;

  function saveLibraryPrefs() {
    storage.setJson(STORAGE_KEYS.LIBRARY_PREFS, { tab: libraryUi.tab, sort: libraryUi.sort, collapsed: libraryUi.collapsed });
  }

  function isLibraryOpen() {
    const d = $('libraryDrawer');
    return !!d && d.classList.contains('open');
  }

  function updateLibraryCount() {
    const el = $('userMenuLibraryCount');
    if (!el) return;
    const n = (state.bookmarks || []).length;
    el.textContent = n ? `${n} 書籤` : '';
  }

  /** 書籤所在資料夾：辭典條目歸到「辭典」，主樹檔案取上層路徑。 */
  function libraryFolderOf(filePath) {
    if (!filePath) return '';
    if (filePath.startsWith('dict:')) return '辭典';
    const parts = filePath.split('/');
    parts.pop();
    return parts.length ? parts.join(' / ') : '根目錄';
  }

  function libraryTitleOf(item) {
    if (item.fileName) return item.fileName;
    const clean = (item.filePath || '').replace(/^dict:/, '');
    return clean.split('/').pop().replace(/\.md$/i, '');
  }

  function libraryDayGroup(ts) {
    if (typeof ts !== 'number') return 2;
    const d = new Date(ts);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = today.getTime();
    if (d.getTime() >= start) return 0;
    if (d.getTime() >= start - 86400000) return 1;
    return 2;
  }

  function libraryMatches(item, q) {
    if (!q) return true;
    const hay = `${libraryTitleOf(item)} ${item.filePath || ''}`.toLowerCase();
    return hay.includes(q);
  }

  /**
   * 正規化閱讀進度百分比：夾在 0–100 並四捨五入。
   *
   * 進度會經由 library-sync 跨裝置同步，伺服器端只做粗粒度驗證，回來的值仍可能
   * 越界（例如 130）或帶小數（37.4）。直接塞進 style 的 width 會讓進度條畫出容器
   * 之外，百分比文字也會變成「37.4%」。這裡一次收斂成整數。
   *
   * @param {{pct?: number}|null} item 書籤或歷程條目
   * @returns {number|null} 0–100 的整數；該條目沒有進度時回 null
   */
  function libraryProgressPct(item) {
    if (!item || typeof item.pct !== 'number' || !Number.isFinite(item.pct)) return null;
    return Math.max(0, Math.min(100, Math.round(item.pct)));
  }

  /**
   * 進度條標記。書籤與歷程共用同一份，兩邊視覺才不會各說各話。
   * @param {number|null} pct 已正規化的百分比
   * @returns {string} HTML 片段；沒有進度時回空字串
   */
  function libraryProgressBarHtml(pct) {
    if (typeof pct !== 'number') return '';
    return `<span class="library-bar" aria-hidden="true"><i style="width:${pct}%"></i></span>`;
  }

  function renderLibrary() {
    const listEl = $('libraryList');
    if (!listEl) return;
    renderSyncStatus();
    const bookmarks = state.bookmarks || [];
    const recent = state.recentFiles || [];
    const isBm = libraryUi.tab === 'bookmarks';
    $('libraryCountBookmarks').textContent = bookmarks.length;
    $('libraryCountRecent').textContent = recent.length;
    for (const [id, on] of [['libraryTabBookmarks', isBm], ['libraryTabRecent', !isBm]]) {
      const t = $(id);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
    }
    listEl.setAttribute('aria-labelledby', isBm ? 'libraryTabBookmarks' : 'libraryTabRecent');

    const sortBtn = $('librarySortBtn');
    sortBtn.hidden = !isBm;
    sortBtn.textContent = libraryUi.sort === 'name' ? '名稱 A→Z' : '最新優先';

    // 繼續閱讀：上次讀到的檔案與位置
    const resume = $('libraryResumeBtn');
    const last = storage.getJson(STORAGE_KEYS.LAST_READ_PROGRESS, null);
    const showResume = !isBm && !!(last && last.filePath);
    resume.hidden = !showResume;
    if (showResume) {
      const r = recent.find(i => i.filePath === last.filePath);
      $('libraryResumeTitle').textContent = r ? libraryTitleOf(r) : libraryTitleOf({ filePath: last.filePath });
      $('libraryResumePct').textContent = r && typeof r.pct === 'number' ? `上次讀到 ${r.pct}%` : '';
    }

    const q = libraryUi.q.trim().toLowerCase();
    let html = '';
    if (isBm) {
      const items = bookmarks.map((b, i) => ({ b, i })).filter(x => libraryMatches(x.b, q));
      if (libraryUi.sort === 'name') {
        items.sort((x, y) => libraryTitleOf(x.b).localeCompare(libraryTitleOf(y.b), 'zh-Hant'));
      }
      if (!items.length) {
        html = bookmarks.length
          ? `<div class="library-empty">沒有符合「${escHtml(libraryUi.q.trim())}」的書籤</div>`
          : `<div class="library-empty">還沒有書籤。開啟經文後，點標題旁的 🔖 加書籤。</div>`;
      } else {
        const groups = new Map();
        for (const x of items) {
          const f = libraryFolderOf(x.b.filePath);
          if (!groups.has(f)) groups.set(f, []);
          groups.get(f).push(x.b);
        }
        for (const [folder, list] of groups) {
          const open = !!q || !libraryUi.collapsed[folder];
          html += `<button type="button" class="library-group" data-folder="${escHtml(folder)}" aria-expanded="${open}">`
            + `<span class="library-chevron" aria-hidden="true">${open ? '▾' : '▸'}</span><span class="library-group-name">${escHtml(folder)}</span>`
            + `<span class="library-group-count">${list.length}</span></button>`;
          if (!open) continue;
          for (const b of list) {
            const current = b.filePath === state.currentFile ? ' current' : '';
            // 書籤自己記閱讀進度（隨帳號同步）；舊書籤還沒有時，借用歷程裡的進度
            const prog = typeof b.pct === 'number' ? b : recent.find(r => r.filePath === b.filePath);
            const progLine = prog && prog.line ? Number(prog.line) || 0 : 0;
            // 與「歷程」一致的進度呈現：細進度條 + 右側百分比。
            // 進度沿用同一組 .library-bar / .library-pct 樣式，兩邊視覺才不會各說各話。
            const pct = libraryProgressPct(prog);
            html += `<div class="library-item${current}">`
              + `<button type="button" class="library-open" data-file="${escHtml(b.filePath)}"${progLine ? ` data-line="${progLine}"` : ''} title="${escHtml(b.filePath || '')}">`
              + `<span class="library-item-title">${escHtml(libraryTitleOf(b))}</span>`
              + (b.time ? `<span class="library-item-sub">加入於 ${escHtml(b.time)}</span>` : '')
              + libraryProgressBarHtml(pct)
              + `</button>`
              + (pct !== null ? `<span class="library-pct" title="上次讀到的位置">${pct}%</span>` : '')
              + `<button type="button" class="library-del" data-del-bookmark="${escHtml(b.filePath)}" title="移除書籤" aria-label="移除書籤：${escHtml(libraryTitleOf(b))}">✕</button>`
              + `</div>`;
          }
        }
      }
    } else {
      const items = recent.filter(r => libraryMatches(r, q));
      if (!items.length) {
        html = recent.length
          ? `<div class="library-empty">沒有符合「${escHtml(libraryUi.q.trim())}」的紀錄</div>`
          : `<div class="library-empty">還沒有閱讀紀錄。開啟過的經文會出現在這裡（最多 20 筆）。</div>`;
      } else {
        const labels = ['今天', '昨天', '更早'];
        [0, 1, 2].forEach(g => {
          const list = items.filter(r => libraryDayGroup(r.ts) === g);
          if (!list.length) return;
          html += `<div class="library-group static"><span class="library-group-name">${labels[g]}</span><span class="library-group-count">${list.length}</span></div>`;
          for (const r of list) {
            // 百分比一律夾在 0–100：跨裝置同步回來的值可能越界，會把進度條畫出容器外。
            const pct = libraryProgressPct(r);
            const current = r.filePath === state.currentFile ? ' current' : '';
            html += `<div class="library-item${current}">`
              + `<button type="button" class="library-open" data-file="${escHtml(r.filePath)}"${r.line ? ` data-line="${Number(r.line) || ''}"` : ''} title="${escHtml(r.filePath || '')}">`
              + `<span class="library-item-title">${escHtml(libraryTitleOf(r))}</span>`
              + `<span class="library-item-sub">${escHtml(libraryFolderOf(r.filePath))}${r.time ? ` · ${escHtml(r.time)}` : ''}</span>`
              + libraryProgressBarHtml(pct)
              + `</button>`
              + (pct !== null ? `<span class="library-pct" title="上次讀到的位置">${pct}%</span>` : '')
              + `<button type="button" class="library-del" data-del-recent="${escHtml(r.filePath)}" title="移除紀錄" aria-label="移除紀錄：${escHtml(libraryTitleOf(r))}">✕</button>`
              + `</div>`;
          }
        });
      }
    }
    listEl.innerHTML = html;

    const clearBtn = $('libraryClearBtn');
    clearBtn.hidden = isBm ? !bookmarks.length : !recent.length;
    clearBtn.textContent = isBm ? '清除全部書籤' : '清除全部歷程';
  }

  function openLibrary(tab) {
    const drawer = $('libraryDrawer');
    const scrim = $('libraryScrim');
    if (!drawer) return;
    if (tab) libraryUi.tab = tab;
    if (libraryCloseTimer) { clearTimeout(libraryCloseTimer); libraryCloseTimer = null; }
    renderLibrary();
    drawer.hidden = false;
    scrim.hidden = false;
    requestAnimationFrame(() => {
      drawer.classList.add('open');
      scrim.classList.add('open');
    });
    // 觸控裝置不自動聚焦篩選框，免得一打開就跳出鍵盤
    const target = isMobileBrowser() ? $(libraryUi.tab === 'bookmarks' ? 'libraryTabBookmarks' : 'libraryTabRecent') : $('libraryFilter');
    setTimeout(() => target && target.focus({ preventScroll: true }), 30);
  }

  function closeLibrary(returnFocus = true) {
    const drawer = $('libraryDrawer');
    const scrim = $('libraryScrim');
    if (!drawer || drawer.hidden) return;
    drawer.classList.remove('open');
    scrim.classList.remove('open');
    libraryCloseTimer = setTimeout(() => {
      drawer.hidden = true;
      scrim.hidden = true;
      libraryCloseTimer = null;
    }, 220);
    if (returnFocus && $('userMenuBtn')) $('userMenuBtn').focus({ preventScroll: true });
  }

  function setLibraryTab(tab) {
    if (libraryUi.tab === tab) return;
    libraryUi.tab = tab;
    saveLibraryPrefs();
    renderLibrary();
  }

  function setupLibrary() {
    const drawer = $('libraryDrawer');
    if (!drawer) return;
    $('libraryCloseBtn').addEventListener('click', () => closeLibrary());
    $('libraryScrim').addEventListener('click', () => closeLibrary());
    $$('.library-tab', drawer).forEach(t => {
      t.addEventListener('click', () => setLibraryTab(t.getAttribute('data-tab')));
      t.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        setLibraryTab(libraryUi.tab === 'bookmarks' ? 'recent' : 'bookmarks');
        $(libraryUi.tab === 'bookmarks' ? 'libraryTabBookmarks' : 'libraryTabRecent').focus();
      });
    });
    $('libraryFilter').addEventListener('input', (e) => {
      libraryUi.q = e.target.value;
      renderLibrary();
    });
    $('librarySortBtn').addEventListener('click', () => {
      libraryUi.sort = libraryUi.sort === 'name' ? 'new' : 'name';
      saveLibraryPrefs();
      renderLibrary();
    });
    $('libraryResumeBtn').addEventListener('click', () => {
      closeLibrary(false);
      if (!restoreReadProgress(true)) showToast('沒有可以繼續的閱讀紀錄', 'info');
    });
    $('libraryClearBtn').addEventListener('click', () => {
      if (libraryUi.tab === 'bookmarks') {
        if (!confirm('確定要清除所有書籤？')) return;
        state.bookmarks = [];
        persistLibrary('b');
        renderBookmarksList();
        if (state.currentFile) updateBookmarkButtonUI(state.currentFile);
        showToast('🗑️ 已清除所有書籤', 'success');
      } else {
        if (!confirm('確定要清除所有閱讀歷程？')) return;
        state.recentFiles = [];
        persistLibrary('h');
        renderRecentFilesList();
        showToast('🗑️ 已成功清除所有閱讀紀錄', 'success');
      }
    });
    $('libraryList').addEventListener('click', (e) => {
      const delRecent = e.target.closest('[data-del-recent]');
      if (delRecent) {
        const file = delRecent.getAttribute('data-del-recent');
        state.recentFiles = (state.recentFiles || []).filter(i => i.filePath !== file);
        persistLibrary('h');
        renderRecentFilesList();
        return;
      }
      const del = e.target.closest('[data-del-bookmark]');
      if (del) {
        const file = del.getAttribute('data-del-bookmark');
        state.bookmarks = (state.bookmarks || []).filter(i => i.filePath !== file);
        persistLibrary('b');
        renderBookmarksList();
        if (state.currentFile === file) updateBookmarkButtonUI(file);
        showToast('🗑️ 已從書籤移除', 'success');
        return;
      }
      const group = e.target.closest('[data-folder]');
      if (group) {
        if (libraryUi.q.trim()) return;
        const f = group.getAttribute('data-folder');
        if (libraryUi.collapsed[f]) delete libraryUi.collapsed[f];
        else libraryUi.collapsed[f] = true;
        saveLibraryPrefs();
        renderLibrary();
        return;
      }
      const open = e.target.closest('[data-file]');
      if (open) {
        const file = open.getAttribute('data-file');
        const line = parseInt(open.getAttribute('data-line'), 10) || undefined;
        closeLibrary(false);
        openFile(file, line);
      }
    });
    // 抽屜開著時，Tab 鍵只在抽屜裡循環
    drawer.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const f = Array.from(drawer.querySelectorAll('button, input')).filter(el => !el.hidden && el.offsetParent !== null && el.tabIndex !== -1);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    updateLibraryCount();
  }

  // ── 啟動：讀設定、目前登入者、處理信件連結與第三方登入回來的網址 ──
  async function initAccounts() {
    // 先把網址上的 auth 參數拿下來並清掉，避免 token 留在瀏覽紀錄或被分享出去。
    const params = new URLSearchParams(window.location.search);
    const authAction = params.get('auth');
    const authParams = {};
    if (authAction) {
      for (const k of ACCOUNT_URL_PARAMS) {
        if (params.has(k)) authParams[k] = params.get(k);
        params.delete(k);
      }
      const qs = params.toString();
      history.replaceState(history.state, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash);
    }
    if (state.isSingleUser) return;

    const cfg = await accountApi('/api/auth/config');
    if (!cfg.ok || !cfg.data.accountsEnabled) {
      state.account.config = cfg.ok ? cfg.data : null;
      return;
    }
    state.account.config = cfg.data;
    updateUserMenu();
    updateLegalLinks();
    setupLibrarySync();
    setupAccountEvents();
    await refreshAccountMe();
    if (authAction) await handleAuthLink(authAction, authParams);
  }

  function updateLegalLinks() {
    const legal = (state.account.config && state.account.config.legal) || {};
    const any = !!(legal.privacy || legal.terms);
    const wrap = $('welcomeLegalLinks');
    if (wrap) wrap.hidden = !any;
    if ($('welcomePrivacyLink')) $('welcomePrivacyLink').hidden = !legal.privacy;
    if ($('welcomeTermsLink')) $('welcomeTermsLink').hidden = !legal.terms;
    if ($('accountLegalLinks')) $('accountLegalLinks').hidden = !any;
  }

  async function refreshAccountMe() {
    if (state.isSingleUser) return null;
    const r = await accountApi('/api/me');
    setAccountUser(r.ok ? r.data.user : null);
    return state.account.user;
  }

  function setAccountUser(user) {
    state.account.user = user || null;
    if (user && user.role === 'admin') state.isAdmin = true;
    if (!user) state.isAdmin = false;
    updateUserMenu();
    if (user && user.needsConsent) openOverlay('consentOverlay');
    onLibraryAccountChange(user);
  }

  function openOverlay(id) {
    const el = $(id);
    if (!el) return;
    el.style.display = 'flex';
    document.body.classList.add('modal-open');
  }

  function closeOverlay(id) {
    const el = $(id);
    if (!el) return;
    el.style.display = 'none';
    const anyOpen = Array.from(document.querySelectorAll('.modal-overlay')).some(o => o.style.display === 'flex');
    if (!anyOpen) document.body.classList.remove('modal-open');
  }

  const OAUTH_ERRORS = {
    DENIED: '你取消了第三方登入',
    OAUTH_FAILED: '第三方登入失敗，請再試一次',
    NO_BASE_URL: '網站尚未設定對外網址，暫時無法使用第三方登入',
    LOGIN_REQUIRED: '請先登入',
    IDENTITY_MISMATCH: '這不是你綁定的帳號',
    IDENTITY_IN_USE: '這個第三方帳號已經綁定在別的帳號上',
    ALREADY_LINKED: '你已經綁定了這家的另一個帳號',
    EMAIL_IN_USE: '這個 Email 已有帳號。請先用密碼登入，再到「我的帳號」綁定',
    REGISTRATION_CLOSED: '目前暫停開放註冊',
    INVITE_REQUIRED: '目前採邀請制，請用邀請碼以 Email 註冊',
    RATE_LIMITED: '註冊人數過多，請稍後再試',
    DISPOSABLE_EMAIL: '不接受這個信箱網域',
    ACCOUNT_DISABLED: '這個帳號已被停用'
  };

  async function handleAuthLink(action, p) {
    if (action === 'verify' || action === 'email') {
      const url = action === 'verify' ? '/api/auth/verify' : '/api/auth/confirm-email';
      const r = await accountApi(url, { method: 'POST', body: { token: p.token || '' } });
      if (r.ok) {
        if (r.data.user) setAccountUser(r.data.user);
        else await refreshAccountMe();
        showToast(`✅ ${r.data.message || '已完成'}`, 'success', 3500);
      } else {
        showToast(`❌ ${r.data.error || '連結無效或已過期'}`, 'error', 4000);
      }
    } else if (action === 'reset') {
      authUi.resetToken = p.token || '';
      openAccountAuth('reset');
    } else if (action === 'login') {
      if (!state.account.user) openAccountAuth('login');
    } else if (action === 'oauth') {
      if (p.status === 'ok') {
        await refreshAccountMe();
        if (p.mode === 'link') {
          showToast('✅ 已綁定登入方式', 'success');
          openAccountSettings();
        } else if (p.mode === 'reauth') {
          showToast('✅ 已重新驗證身分，請再執行一次剛才的操作', 'success', 4000);
          openAccountSettings();
        } else {
          showToast('✅ 已登入', 'success');
        }
      } else {
        showToast(`❌ ${OAUTH_ERRORS[p.code] || '第三方登入失敗'}`, 'error', 4500);
      }
    }
  }

  // ── 登入／註冊卡片 ──
  const AUTH_VIEWS = {
    login: { title: '登入', submit: '登入' },
    register: { title: '註冊', submit: '建立帳號' },
    forgot: { title: '忘記密碼', submit: '寄送重設連結' },
    resend: { title: '重寄驗證信', submit: '重寄驗證信' },
    reset: { title: '設定新密碼', submit: '更新密碼並登入' }
  };

  function openAccountAuth(view = 'login', opts = {}) {
    authUi.afterLogin = opts.afterLogin || '';
    setAuthView(view);
    openOverlay('accountAuthOverlay');
    const first = view === 'reset' ? $('accountPassword') : $('accountEmail');
    if (first) setTimeout(() => first.focus(), 50);
  }

  function setAuthView(view) {
    const cfg = state.account.config || {};
    authUi.view = view;
    authUi.openedAt = Date.now();
    authUi.needTurnstile = false;
    const card = document.querySelector('#accountAuthOverlay .account-card');
    if (card) { card.setAttribute('data-view', view); card.classList.remove('is-done'); }
    $('accountAuthDone').hidden = true;
    $$('#accountAuthOverlay [data-views]').forEach(el => {
      el.hidden = !el.getAttribute('data-views').split(' ').includes(view);
    });
    $('accountAuthTitle').textContent = AUTH_VIEWS[view].title;
    $('accountAuthSubmit').textContent = AUTH_VIEWS[view].submit;
    $('accountEmailLabel').textContent = view === 'login' ? 'Email 或帳號名稱' : 'Email';
    $('accountEmail').type = view === 'login' ? 'text' : 'email';
    const pw = $('accountPassword');
    pw.value = '';
    pw.autocomplete = view === 'login' ? 'current-password' : 'new-password';
    $('accountPasswordLabel').textContent = view === 'login' ? '密碼' : '新密碼';
    pw.placeholder = view === 'login' ? '' : `至少 ${cfg.passwordMinLength || 8} 個字元`;

    const descs = {
      login: '登入後，管理員可以進入後台；之後的版本會在這裡同步你的書籤與閱讀進度。',
      register: cfg.registrationPaused ? '註冊功能尚未設定完成，請稍後再來。' : '用 Email 註冊，我們會寄一封驗證信給你。',
      forgot: '輸入註冊時的 Email，我們會寄一封重設密碼的連結（1 小時內有效）。',
      resend: '輸入註冊時的 Email，我們會再寄一次驗證信。',
      reset: '請設定新的密碼。更新後，其他裝置都會登出。'
    };
    $('accountAuthDesc').textContent = descs[view];

    const legal = cfg.legal || {};
    const consentRow = $('accountConsentRow');
    if (consentRow) consentRow.hidden = view !== 'register' || !(legal.privacy || legal.terms);
    const invite = $('accountInviteGroup');
    if (invite) invite.hidden = view !== 'register' || cfg.registrationMode !== 'invite';
    const gotoRegister = $('accountGotoRegister');
    if (gotoRegister && view === 'login') gotoRegister.hidden = cfg.registrationMode === 'closed';

    renderProviderButtons($('accountProviders'), 'login', view === 'login' || view === 'register');
    $('accountProvidersDivider').hidden = $('accountProviders').hidden;
    showBox($('accountAuthError'), '');
    showBox($('accountAuthSuccess'), '');
    $('accountAuthSubmit').disabled = view === 'register' && (cfg.registrationPaused || cfg.registrationMode === 'closed');
    updateTurnstile();
  }

  function renderProviderButtons(container, mode, visible = true) {
    if (!container) return;
    const providers = ((state.account.config && state.account.config.providers) || []);
    container.innerHTML = '';
    container.hidden = !visible || providers.length === 0;
    for (const id of providers) {
      const a = document.createElement('a');
      a.className = `modal-btn secondary-btn provider-btn provider-${id}`;
      a.href = `/api/auth/${id}?mode=${mode}`;
      a.textContent = mode === 'reauth' ? `用 ${PROVIDER_LABELS[id] || id} 驗證` : `使用 ${PROVIDER_LABELS[id] || id} 繼續`;
      container.appendChild(a);
    }
  }

  // Turnstile：註冊、忘記密碼、重寄驗證信一定要；登入只在伺服器要求時（連續失敗後）才出現。
  let turnstileLoading = null;
  function loadTurnstile() {
    if (window.turnstile) return Promise.resolve(window.turnstile);
    if (turnstileLoading) return turnstileLoading;
    turnstileLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.onload = () => resolve(window.turnstile);
      s.onerror = () => { turnstileLoading = null; reject(new Error('Turnstile load failed')); };
      document.head.appendChild(s);
    });
    return turnstileLoading;
  }

  function mountTurnstile(container, action, onToken) {
    const siteKey = state.account.config && state.account.config.turnstileSiteKey;
    if (!container || !siteKey) return Promise.resolve(null);
    container.hidden = false;
    container.innerHTML = '';
    return loadTurnstile().then(ts => ts.render(container, {
      sitekey: siteKey,
      action,
      theme: LIGHT_THEMES.has(document.documentElement.getAttribute('data-theme')) ? 'light' : 'auto',
      callback: (t) => onToken(t),
      'expired-callback': () => onToken(''),
      'error-callback': () => onToken('')
    })).catch(() => {
      container.textContent = '人機驗證載入失敗，請檢查網路後重新整理頁面。';
      return null;
    });
  }

  function updateTurnstile() {
    const box = $('accountTurnstile');
    const cfg = state.account.config || {};
    const need = !!cfg.turnstileSiteKey && (['register', 'forgot', 'resend'].includes(authUi.view) || (authUi.view === 'login' && authUi.needTurnstile));
    authUi.turnstileToken = '';
    if (authUi.turnstileWidget !== null && window.turnstile) {
      try { window.turnstile.remove(authUi.turnstileWidget); } catch (_) {}
    }
    authUi.turnstileWidget = null;
    if (!need) {
      if (box) { box.hidden = true; box.innerHTML = ''; }
      return;
    }
    mountTurnstile(box, authUi.view, (t) => { authUi.turnstileToken = t; })
      .then(id => { authUi.turnstileWidget = id; });
  }

  function resetTurnstile() {
    authUi.turnstileToken = '';
    if (authUi.turnstileWidget !== null && window.turnstile) {
      try { window.turnstile.reset(authUi.turnstileWidget); } catch (_) {}
    }
  }

  // 寄出信件後，把整張卡片換成一份完整說明：信寄到哪、接下來怎麼做、沒收到怎麼辦。
  // 伺服器的回覆刻意不透露信箱是否已註冊，所以標題只說「已送出」。
  const AUTH_DONE = {
    register: {
      title: '註冊申請已送出',
      steps: ['打開信箱，找一封來自本站的驗證信', '點信裡的驗證連結（24 小時內有效）', '驗證完成後，回到這裡登入'],
      resend: true
    },
    resend: {
      title: '驗證信已重新寄出',
      steps: ['打開信箱，找最新的那一封驗證信', '點信裡的驗證連結（24 小時內有效）', '驗證完成後，回到這裡登入'],
      resend: false
    },
    forgot: {
      title: '重設密碼信已寄出',
      steps: ['打開信箱，找一封重設密碼的信', '點信裡的連結（1 小時內有效）', '設定新密碼後就會自動登入'],
      resend: false
    }
  };

  function showAuthDone(view, email, message) {
    const info = AUTH_DONE[view];
    if (!info) return;
    const card = document.querySelector('#accountAuthOverlay .account-card');
    if (card) card.classList.add('is-done');
    $('accountAuthDoneTitle').textContent = info.title;
    const emailEl = $('accountAuthDoneEmail');
    emailEl.textContent = email ? `寄到：${email}` : '';
    emailEl.hidden = !email;
    const steps = $('accountAuthDoneSteps');
    steps.innerHTML = '';
    for (const text of info.steps) {
      const li = document.createElement('li');
      li.textContent = text;
      steps.appendChild(li);
    }
    const note = message || '如果這個信箱可以使用，我們已寄出信件，請查收。';
    $('accountAuthDoneNote').textContent = /垃圾郵件/.test(note) ? note : `${note}（也請看看垃圾郵件匣）`;
    $('accountAuthDoneResend').hidden = !info.resend;
    $('accountAuthDone').hidden = false;
    setTimeout(() => $('accountAuthDoneOk').focus(), 30);
  }

  async function submitAccountAuth() {
    const view = authUi.view;
    const errorEl = $('accountAuthError');
    const okEl = $('accountAuthSuccess');
    showBox(errorEl, '');
    showBox(okEl, '');
    const email = $('accountEmail').value.trim();
    const password = $('accountPassword').value;
    const antiBot = {
      website: $('accountWebsite').value,
      elapsedMs: Date.now() - authUi.openedAt,
      turnstileToken: authUi.turnstileToken
    };
    const btn = $('accountAuthSubmit');
    btn.disabled = true;
    let r;
    try {
      if (view === 'login') {
        r = await accountApi('/api/auth/login', { method: 'POST', body: { identifier: email, password, turnstileToken: authUi.turnstileToken } });
        if (r.ok) {
          closeOverlay('accountAuthOverlay');
          setAccountUser(r.data.user);
          showToast(`✅ 歡迎回來${r.data.user && r.data.user.displayName ? `，${r.data.user.displayName}` : ''}`, 'success');
          if (authUi.afterLogin === 'admin') {
            authUi.afterLogin = '';
            if (state.isAdmin) await openSettingsOverlay();
            else showToast('已登入，但這個帳號沒有管理權限', 'info', 3500);
          }
          return;
        }
        if (r.data.code === 'TURNSTILE_REQUIRED') {
          authUi.needTurnstile = true;
          updateTurnstile();
        }
      } else if (view === 'register') {
        r = await accountApi('/api/auth/register', {
          method: 'POST',
          body: Object.assign({
            email, password,
            displayName: $('accountDisplayName').value.trim(),
            inviteCode: $('accountInviteCode').value.trim(),
            agree: $('accountAgree').checked
          }, antiBot)
        });
      } else if (view === 'forgot') {
        r = await accountApi('/api/auth/reset-request', { method: 'POST', body: Object.assign({ email }, antiBot) });
      } else if (view === 'resend') {
        r = await accountApi('/api/auth/resend-verification', { method: 'POST', body: Object.assign({ email }, antiBot) });
      } else if (view === 'reset') {
        r = await accountApi('/api/auth/reset', { method: 'POST', body: { token: authUi.resetToken, password } });
        if (r.ok) {
          authUi.resetToken = '';
          closeOverlay('accountAuthOverlay');
          setAccountUser(r.data.user);
          showToast(`✅ ${r.data.message || '密碼已更新'}`, 'success', 3500);
          return;
        }
      }
      if (r.ok) {
        $('accountPassword').value = '';
        showAuthDone(view, email, r.data.message);
      } else {
        showBox(errorEl, r.data.error || '發生錯誤，請稍後再試');
      }
    } finally {
      btn.disabled = false;
      resetTurnstile();
    }
  }

  // ── 我的帳號 ──
  async function openAccountSettings() {
    const user = await refreshAccountMe();
    if (!user) {
      openAccountAuth('login');
      return;
    }
    showBox($('accountSettingsMsg'), '');
    showBox($('accountSettingsError'), '');
    renderAccountSettings(user);
    openOverlay('accountSettingsOverlay');
    loadMySessions();
  }

  function renderAccountSettings(user) {
    $('accountMeEmail').textContent = user.email ? `${user.email}${user.emailVerified ? '' : '（尚未驗證）'}` : '尚未設定';
    $('accountMeUsernameRow').hidden = !user.username;
    $('accountMeUsername').textContent = user.username || '';
    $('accountMeName').value = user.displayName || '';
    $('accountNewEmail').value = '';
    $('accountCurrentPassword').value = '';
    $('accountNewPassword').value = '';
    $('accountCurrentPasswordRow').hidden = !user.hasPassword;
    $('accountPasswordTitle').textContent = user.hasPassword ? '密碼' : '設定密碼（目前只用第三方登入）';
    $('accountAdminBtn').hidden = user.role !== 'admin';

    const providers = (state.account.config && state.account.config.providers) || [];
    const linked = new Map((user.identities || []).map(i => [i.provider, i]));
    const section = $('accountProvidersSection');
    section.hidden = providers.length === 0 && linked.size === 0;
    const list = $('accountIdentityList');
    list.innerHTML = '';
    const ids = Array.from(new Set(providers.concat(Array.from(linked.keys()))));
    for (const id of ids) {
      const row = document.createElement('div');
      row.className = 'account-list-row';
      const info = linked.get(id);
      row.innerHTML = `<span><strong>${escHtml(PROVIDER_LABELS[id] || id)}</strong> <span class="field-hint">${info ? `已綁定${info.email ? `（${escHtml(info.email)}）` : ''}` : '未綁定'}</span></span>`;
      if (info) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'modal-btn secondary-btn small-btn';
        b.textContent = '解除綁定';
        b.addEventListener('click', async () => {
          if (!confirm(`確定要解除 ${PROVIDER_LABELS[id] || id} 登入嗎？`)) return;
          const r = await accountApi(`/api/me/identities/${id}`, { method: 'DELETE' });
          if (r.ok) { setAccountUser(r.data.user); renderAccountSettings(r.data.user); showBox($('accountSettingsMsg'), '已解除綁定'); }
          else showBox($('accountSettingsError'), r.data.error || '解除失敗');
        });
        row.appendChild(b);
      } else if (providers.includes(id)) {
        const a = document.createElement('a');
        a.className = 'modal-btn secondary-btn small-btn';
        a.href = `/api/auth/${id}?mode=link`;
        a.textContent = '綁定';
        row.appendChild(a);
      }
      list.appendChild(row);
    }
  }

  async function loadMySessions() {
    const list = $('accountSessionList');
    list.innerHTML = '<div class="field-hint">載入中…</div>';
    const r = await accountApi('/api/me/sessions');
    if (!r.ok) { list.innerHTML = `<div class="field-hint">${escHtml(r.data.error || '載入失敗')}</div>`; return; }
    list.innerHTML = '';
    for (const s of r.data.sessions) {
      const row = document.createElement('div');
      row.className = 'account-list-row';
      row.innerHTML = `<span>${escHtml(describeUserAgent(s.userAgent))}${s.current ? ' <span class="account-badge">這台裝置</span>' : ''}<br><span class="field-hint">${escHtml(s.ip || '')} · 最近使用 ${escHtml(fmtDateTime(s.lastSeenAt))}</span></span>`;
      if (!s.current) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'modal-btn secondary-btn small-btn';
        b.textContent = '登出';
        b.addEventListener('click', async () => {
          const d = await accountApi(`/api/me/sessions/${s.id}`, { method: 'DELETE' });
          if (d.ok) loadMySessions();
          else showBox($('accountSettingsError'), d.data.error || '登出失敗');
        });
        row.appendChild(b);
      }
      list.appendChild(row);
    }
  }

  async function accountLogout() {
    // 先把書籤與歷程送上帳號，成功才清掉這台裝置上的本機資料
    const cleared = await finishLibrarySyncBeforeLogout();
    const hadLocal = (state.bookmarks || []).length || (state.recentFiles || []).length;
    await accountApi('/api/auth/logout', { method: 'POST', body: {} });
    setAccountUser(null);
    if (!cleared && hadLocal) showToast('目前無法同步，書籤與歷程先保留在這台裝置，下次登入時會同步', 'info', 4500);
    closeOverlay('accountSettingsOverlay');
    closeOverlay('consentOverlay');
    showToast('👋 已登出', 'info');
  }

  // 重新驗證：有密碼的人輸入密碼；只用第三方登入的人跳去該家驗證（回來後要再按一次）。
  function openReauthOverlay() {
    const user = state.account.user;
    if (!user) return Promise.resolve(false);
    $('reauthPassword').value = '';
    $('reauthPasswordGroup').hidden = !user.hasPassword;
    $('reauthSubmitBtn').hidden = !user.hasPassword;
    const providers = (user.providers || []).filter(p => ((state.account.config && state.account.config.providers) || []).includes(p));
    const box = $('reauthProviders');
    box.innerHTML = '';
    box.hidden = providers.length === 0;
    for (const id of providers) {
      const a = document.createElement('a');
      a.className = `modal-btn secondary-btn provider-btn provider-${id}`;
      a.href = `/api/auth/${id}?mode=reauth`;
      a.textContent = `用 ${PROVIDER_LABELS[id] || id} 驗證`;
      box.appendChild(a);
    }
    showBox($('reauthError'), '');
    openOverlay('reauthOverlay');
    if (user.hasPassword) setTimeout(() => $('reauthPassword').focus(), 50);
    return new Promise(resolve => { authUi.pendingReauth = resolve; });
  }

  function finishReauth(ok) {
    closeOverlay('reauthOverlay');
    const resolve = authUi.pendingReauth;
    authUi.pendingReauth = null;
    if (resolve) resolve(ok);
  }

  let accountEventsReady = false;
  function setupAccountEvents() {
    if (accountEventsReady) return;
    accountEventsReady = true;

    $('accountAuthCloseBtn').addEventListener('click', () => closeOverlay('accountAuthOverlay'));
    $('accountAuthForm').addEventListener('submit', (e) => { e.preventDefault(); submitAccountAuth(); });
    $$('#accountAuthOverlay [data-goto]').forEach(b => b.addEventListener('click', () => setAuthView(b.getAttribute('data-goto'))));
    $('accountAuthDoneOk').addEventListener('click', () => closeOverlay('accountAuthOverlay'));
    $('accountAuthDoneLogin').addEventListener('click', () => setAuthView('login'));
    $('accountAuthDoneResend').addEventListener('click', () => setAuthView('resend'));

    $('accountSettingsCloseBtn').addEventListener('click', () => closeOverlay('accountSettingsOverlay'));
    $('accountLogoutBtn').addEventListener('click', accountLogout);
    $('accountAdminBtn').addEventListener('click', async () => {
      closeOverlay('accountSettingsOverlay');
      state.isAdmin = true;
      await openSettingsOverlay();
    });
    $('accountSaveNameBtn').addEventListener('click', async () => {
      const r = await accountApi('/api/me', { method: 'PATCH', body: { displayName: $('accountMeName').value } });
      if (r.ok) { setAccountUser(r.data.user); showBox($('accountSettingsError'), ''); showBox($('accountSettingsMsg'), '名稱已儲存'); }
      else showBox($('accountSettingsError'), r.data.error || '儲存失敗');
    });

    let emailTurnstileToken = '';
    let emailTurnstileShown = false;
    let emailTurnstileWidget = null;
    $('accountChangeEmailBtn').addEventListener('click', async () => {
      const cfg = state.account.config || {};
      if (cfg.turnstileSiteKey && !emailTurnstileToken) {
        if (!emailTurnstileShown) {
          emailTurnstileShown = true;
          mountTurnstile($('accountEmailTurnstile'), 'change_email', (t) => { emailTurnstileToken = t; })
            .then(id => { emailTurnstileWidget = id; });
        }
        showBox($('accountSettingsError'), '請先完成下方的人機驗證，再按一次「變更 Email」');
        return;
      }
      const r = await accountApi('/api/me/email', { method: 'POST', body: { newEmail: $('accountNewEmail').value.trim(), turnstileToken: emailTurnstileToken } });
      emailTurnstileToken = '';
      if (window.turnstile && emailTurnstileWidget !== null) { try { window.turnstile.reset(emailTurnstileWidget); } catch (_) {} }
      if (r.ok) { showBox($('accountSettingsError'), ''); showBox($('accountSettingsMsg'), r.data.message); $('accountNewEmail').value = ''; }
      else showBox($('accountSettingsError'), r.data.error || '變更失敗');
    });

    $('accountChangePasswordBtn').addEventListener('click', async () => {
      const body = { currentPassword: $('accountCurrentPassword').value, newPassword: $('accountNewPassword').value };
      const r = await withReauth(() => accountApi('/api/auth/password', { method: 'POST', body }));
      if (r.ok) {
        showBox($('accountSettingsError'), '');
        showBox($('accountSettingsMsg'), r.data.message || '密碼已更新');
        await refreshAccountMe();
        renderAccountSettings(state.account.user);
        loadMySessions();
      } else if (r.data.code !== 'REAUTH_CANCELLED') {
        showBox($('accountSettingsError'), r.data.error || '更新失敗');
      }
    });

    $('accountLogoutOthersBtn').addEventListener('click', async () => {
      const r = await accountApi('/api/me/sessions', { method: 'DELETE' });
      if (r.ok) { showBox($('accountSettingsMsg'), `已登出 ${r.data.removed} 個其他裝置`); loadMySessions(); }
      else showBox($('accountSettingsError'), r.data.error || '登出失敗');
    });

    $('reauthCancelBtn').addEventListener('click', () => finishReauth(false));
    $('reauthForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const r = await accountApi('/api/auth/reauth', { method: 'POST', body: { password: $('reauthPassword').value } });
      if (r.ok) finishReauth(true);
      else showBox($('reauthError'), r.data.error || '驗證失敗');
    });

    $('consentAcceptBtn').addEventListener('click', async () => {
      const r = await accountApi('/api/auth/accept-terms', { method: 'POST', body: {} });
      closeOverlay('consentOverlay');
      if (r.ok) setAccountUser(r.data.user);
    });
    $('consentLogoutBtn').addEventListener('click', accountLogout);
  }

  // ── 後台：使用者分頁 ──
  const adminUsersState = { page: 1, limit: 50, total: 0, eventsBefore: null };

  function adminNotice(id, text) {
    showBox($(id), text);
  }

  async function loadAdminUsersTab() {
    enhanceAdminCards();
    adminUsersState.page = 1;
    $('adminUserDetail').hidden = true;
    await Promise.all([loadAdminUsers(), loadAdminRegistration(), loadAdminInvites(), loadAdminBotStats(), loadAdminLockouts(), loadAdminEvents(true)]);
  }

  async function loadAdminUsers() {
    const q = new URLSearchParams({
      q: $('adminUsersSearch').value.trim(),
      status: $('adminUsersStatus').value,
      role: $('adminUsersRole').value,
      provider: $('adminUsersProvider').value,
      verified: $('adminUsersVerified').value,
      page: String(adminUsersState.page),
      limit: String(adminUsersState.limit)
    });
    const r = await accountApi(`/api/admin/users?${q}`);
    const tbody = $('adminUsersTbody');
    if (!r.ok) {
      adminNotice('adminUsersNotice', r.data.error || '載入使用者失敗');
      tbody.innerHTML = '';
      return;
    }
    adminNotice('adminUsersNotice', '');
    adminUsersState.total = r.data.total;
    $('adminUsersTotal').textContent = `共 ${r.data.total} 位`;
    setAdminCardLight('users', 'ok', `共 ${r.data.total} 位使用者`);
    const pages = Math.max(1, Math.ceil(r.data.total / r.data.limit));
    $('adminUsersPageInfo').textContent = `第 ${r.data.page} / ${pages} 頁`;
    $('adminUsersPrev').disabled = r.data.page <= 1;
    $('adminUsersNext').disabled = r.data.page >= pages;
    if (!r.data.users.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="analytics-empty">沒有符合的使用者</td></tr>';
      return;
    }
    tbody.innerHTML = '';
    for (const u of r.data.users) {
      const tr = document.createElement('tr');
      tr.className = 'admin-user-row';
      const methods = [u.has_password ? '密碼' : ''].concat(String(u.providers || '').split(',').filter(Boolean).map(p => PROVIDER_LABELS[p] || p)).filter(Boolean).join('、') || '—';
      tr.innerHTML = `<td><strong>${escHtml(u.display_name || '')}</strong><br><span class="field-hint">${escHtml(u.email || u.username || '')}${u.email && !u.email_verified_at ? '（未驗證）' : ''}</span></td>
        <td>${escHtml(methods)}</td>
        <td>${u.role === 'admin' ? '管理員' : '使用者'}${u.status === 'disabled' ? ' · <span class="account-badge danger">停用</span>' : ''}</td>
        <td>${escHtml(fmtDateTime(u.created_at))}</td>
        <td>${escHtml(fmtDateTime(u.last_login_at))}</td>`;
      tr.addEventListener('click', () => loadAdminUserDetail(u.id));
      tbody.appendChild(tr);
    }
  }

  async function loadAdminUserDetail(id) {
    const box = $('adminUserDetail');
    const r = await accountApi(`/api/admin/users/${id}`);
    if (!r.ok) { adminNotice('adminUsersNotice', r.data.error || '載入失敗'); return; }
    renderAdminUserDetail(r.data.user);
    box.hidden = false;
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function renderAdminUserDetail(u) {
    const box = $('adminUserDetail');
    const me = state.account.user;
    box.innerHTML = `<div class="admin-user-detail-head"><strong>${escHtml(u.displayName || u.email || u.username)}</strong>
      <span class="field-hint">#${u.id} · ${escHtml(u.email || '沒有 Email')}${u.username ? ` · 帳號名稱 ${escHtml(u.username)}` : ''}</span></div>
      <div class="field-hint">註冊 ${escHtml(fmtDateTime(u.createdAt))} · 最近登入 ${escHtml(fmtDateTime(u.lastLoginAt))} · 登入中的裝置 ${u.sessions.length} 個 · 同意條款版本 ${escHtml(u.termsVersion || '—')}</div>
      <div class="admin-user-actions"></div>
      <details><summary>最近紀錄</summary><div class="account-list">${u.recentEvents.map(e => `<div class="account-list-row"><span>${escHtml(fmtDateTime(e.at))} · ${escHtml(e.event)}${e.detail ? ` · ${escHtml(e.detail)}` : ''}</span><span class="field-hint">${escHtml(e.ip || '')}</span></div>`).join('') || '<div class="field-hint">沒有紀錄</div>'}</div></details>`;
    const actions = box.querySelector('.admin-user-actions');
    const add = (label, handler, cls = 'secondary-btn') => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `modal-btn ${cls} small-btn`;
      b.textContent = label;
      b.addEventListener('click', handler);
      actions.appendChild(b);
    };
    const done = async (r, msg) => {
      if (r.ok) {
        showToast(`✅ ${msg}`, 'success');
        if (r.data.user) renderAdminUserDetail(r.data.user);
        else box.hidden = true;
        loadAdminUsers();
      } else if (r.data.code !== 'REAUTH_CANCELLED') {
        showToast(`❌ ${r.data.error || '操作失敗'}`, 'error', 3500);
      }
    };
    const isSelf = me && me.id === u.id;
    if (u.status === 'active') {
      if (!isSelf) add('停用', async () => {
        if (!confirm('停用後這個帳號會立即登出且無法登入。確定嗎？')) return;
        done(await accountApi(`/api/admin/users/${u.id}/status`, { method: 'POST', body: { status: 'disabled' } }), '已停用');
      });
    } else {
      add('啟用', async () => done(await accountApi(`/api/admin/users/${u.id}/status`, { method: 'POST', body: { status: 'active' } }), '已啟用'));
    }
    if (u.role === 'admin') {
      if (!isSelf) add('取消管理員', async () => {
        done(await withReauth(() => accountApi(`/api/admin/users/${u.id}/role`, { method: 'POST', body: { role: 'user' } })), '已改為一般使用者');
      });
    } else {
      add('設為管理員', async () => {
        if (!confirm('管理員可以修改網站設定與管理所有帳號。確定嗎？')) return;
        done(await withReauth(() => accountApi(`/api/admin/users/${u.id}/role`, { method: 'POST', body: { role: 'admin' } })), '已設為管理員');
      });
    }
    if (u.sessions.length) add('強制登出', async () => done(await accountApi(`/api/admin/users/${u.id}/logout`, { method: 'POST', body: {} }), '已登出所有裝置'));
    if (u.email && !u.emailVerified) add('重寄驗證信', async () => done(await accountApi(`/api/admin/users/${u.id}/resend-verification`, { method: 'POST', body: {} }), '已寄出驗證信'));
    if (u.email) add('寄重設密碼信', async () => done(await accountApi(`/api/admin/users/${u.id}/send-reset`, { method: 'POST', body: {} }), '已寄出重設密碼信'));
    for (const p of u.providers || []) {
      add(`解除 ${PROVIDER_LABELS[p] || p}`, async () => {
        if (!confirm(`解除這個帳號的 ${PROVIDER_LABELS[p] || p} 登入？`)) return;
        done(await accountApi(`/api/admin/users/${u.id}/unlink`, { method: 'POST', body: { provider: p } }), '已解除綁定');
      });
    }
    add('匯出資料', async () => {
      const r = await accountApi(`/api/admin/users/${u.id}/export`);
      if (!r.ok) { showToast(`❌ ${r.data.error || '匯出失敗'}`, 'error'); return; }
      downloadJson(r.data, `account-${u.id}.json`);
    });
    if (!isSelf) add('刪除帳號', async () => {
      if (!confirm(`確定要刪除「${u.email || u.username || u.id}」？帳號與同步資料會立即刪除，無法復原。`)) return;
      done(await withReauth(() => accountApi(`/api/admin/users/${u.id}`, { method: 'DELETE' })), '帳號已刪除');
    }, 'danger-btn');
  }

  function downloadJson(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    downloadBlob(blob, filename);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const REG_BLOCKER_TEXT = { PUBLIC_BASE_URL: '尚未設定對外網址（PUBLIC_BASE_URL 或首頁權威 URL）', MAIL: '尚未設定寄信（MAIL_PROVIDER、MAIL_API_KEY、MAIL_FROM）' };

  async function loadAdminRegistration() {
    const r = await accountApi('/api/admin/registration');
    if (!r.ok) return;
    $('adminRegMode').value = r.data.mode;
    $('adminRegCap').value = r.data.hourlyCap;
    $('adminRegDomains').value = (r.data.disposableDomains || []).join('\n');
    const blockers = (r.data.blockers || []).map(b => REG_BLOCKER_TEXT[b] || b);
    setAdminCardLight('registration', blockers.length ? 'bad' : r.data.mode === 'closed' ? 'warn' : 'ok',
      blockers.length ? `註冊暫停中：${blockers.join('；')}` : r.data.mode === 'closed' ? '已關閉註冊' : r.data.mode === 'invite' ? '需邀請碼註冊' : '開放註冊');
    showBox($('adminRegBlockers'), blockers.length ? `註冊與寄信類功能暫停中：${blockers.join('；')}` : '');
  }

  async function loadAdminInvites() {
    const r = await accountApi('/api/admin/invites');
    if (r.ok) renderAdminInvites(r.data.invites);
  }

  function renderAdminInvites(invites) {
    const list = $('adminInviteList');
    list.innerHTML = '';
    if (!invites.length) { list.innerHTML = '<div class="field-hint">還沒有邀請碼</div>'; return; }
    for (const inv of invites) {
      const expired = inv.expires_at && inv.expires_at < Date.now();
      const state_ = inv.revoked_at ? '已作廢' : expired ? '已過期' : inv.uses_left <= 0 ? '已用完' : `剩 ${inv.uses_left} 次`;
      const row = document.createElement('div');
      row.className = 'account-list-row';
      row.innerHTML = `<span><code>…${escHtml(inv.code_hint || '')}</code> ${escHtml(inv.note || '')}<br><span class="field-hint">${escHtml(state_)} · 已用 ${inv.uses_count} 次 · ${inv.expires_at ? `到 ${escHtml(fmtDateTime(inv.expires_at))}` : '不過期'}</span></span>`;
      if (!inv.revoked_at && !expired && inv.uses_left > 0) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'modal-btn secondary-btn small-btn';
        b.textContent = '作廢';
        b.addEventListener('click', async () => {
          const d = await accountApi(`/api/admin/invites/${inv.id}/revoke`, { method: 'POST', body: {} });
          if (d.ok) renderAdminInvites(d.data.invites);
        });
        row.appendChild(b);
      }
      list.appendChild(row);
    }
  }

  async function loadAdminBotStats() {
    const r = await accountApi('/api/admin/bot-stats');
    if (!r.ok) return;
    const b = r.data.blocked || {};
    const ts = r.data.turnstile || {};
    setAdminCardLight('bots', r.data.capHitAt ? 'warn' : 'off', r.data.capHitAt ? `最近達到每小時註冊上限（${fmtDateTime(r.data.capHitAt)}）` : '');
    $('adminBotStats').innerHTML = `<div class="account-list">
      <div class="account-list-row"><span>人機驗證未通過</span><strong>${b.turnstile || 0}</strong></div>
      <div class="account-list-row"><span>隱藏欄位／填表太快</span><strong>${b.honeypot || 0}</strong></div>
      <div class="account-list-row"><span>超過註冊次數限制</span><strong>${b.ratelimit || 0}</strong></div>
      <div class="account-list-row"><span>拒絕的信箱網域</span><strong>${b.disposable || 0}</strong></div>
      <div class="account-list-row"><span>新註冊（24 小時／最近 1 小時）</span><strong>${r.data.signups24h} / ${r.data.signupsLastHour}</strong></div>
    </div>
    <div class="field-hint">Turnstile：${ts.configured ? '已啟用' : '未設定（只靠隱藏欄位與限速）'}${r.data.capHitAt ? ` · 最近一次達到每小時上限：${escHtml(fmtDateTime(r.data.capHitAt))}` : ''}</div>`;
  }

  async function loadAdminLockouts() {
    const r = await accountApi('/api/admin/lockouts');
    if (r.ok) renderAdminLockouts(r.data);
  }

  function renderAdminLockouts(data) {
    const list = $('adminLockoutList');
    list.innerHTML = '';
    setAdminCardLight('lockouts', data.accounts.length + data.ips.length ? 'warn' : 'ok', data.accounts.length + data.ips.length ? `${data.accounts.length + data.ips.length} 個帳號或 IP 被鎖定中` : '沒有被鎖定的帳號或 IP');
    const rows = data.accounts.map(a => ({ key: a.key, text: `帳號 ${a.key}：失敗 ${a.fails} 次${a.lockedUntil ? `，鎖到 ${fmtDateTime(a.lockedUntil)}` : ''}` }))
      .concat(data.ips.map(i => ({ key: i.ip, text: `IP ${i.ip}：15 分鐘內失敗 ${i.fails} 次${i.locked ? '（暫停登入）' : ''}` })));
    if (!rows.length) { list.innerHTML = '<div class="field-hint">目前沒有被鎖定的帳號或 IP</div>'; return; }
    for (const row of rows) {
      const el = document.createElement('div');
      el.className = 'account-list-row';
      el.innerHTML = `<span>${escHtml(row.text)}</span>`;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'modal-btn secondary-btn small-btn';
      b.textContent = '解除';
      b.addEventListener('click', async () => {
        const d = await accountApi('/api/admin/lockouts/clear', { method: 'POST', body: { key: row.key } });
        if (d.ok) renderAdminLockouts(d.data);
      });
      el.appendChild(b);
      list.appendChild(el);
    }
  }

  async function loadAdminEvents(reset) {
    if (reset) adminUsersState.eventsBefore = null;
    const q = new URLSearchParams({ limit: '100' });
    const ev = $('adminEventsFilter').value.trim();
    const ip = $('adminEventsIp').value.trim();
    if (ev) q.set('event', ev);
    if (ip) q.set('ip', ip);
    if (adminUsersState.eventsBefore) q.set('before', String(adminUsersState.eventsBefore));
    const r = await accountApi(`/api/admin/auth-events?${q}`);
    const tbody = $('adminEventsTbody');
    if (!r.ok) return;
    if (reset) tbody.innerHTML = '';
    for (const e of r.data.events) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${escHtml(fmtDateTime(e.at))}</td><td>${escHtml(e.event)}</td><td>${escHtml(e.user_label || (e.user_id ? `#${e.user_id}` : '—'))}${e.actor_label ? `<br><span class="field-hint">由 ${escHtml(e.actor_label)}</span>` : ''}</td><td>${escHtml(e.ip || '')}</td><td>${escHtml(e.detail || '')}</td>`;
      tbody.appendChild(tr);
    }
    if (reset && !r.data.events.length) tbody.innerHTML = '<tr><td colspan="5" class="analytics-empty">沒有紀錄</td></tr>';
    const last = r.data.events[r.data.events.length - 1];
    adminUsersState.eventsBefore = last ? last.id : null;
    $('adminEventsMoreBtn').hidden = r.data.events.length < 100;
  }

  // ── 後台：帳號系統分頁 ──
  // ── 後台區塊狀態燈與收合 ──
  // 每張 .config-card 標題前有紅綠燈（綠＝正常、黃＝需要注意、紅＝有問題、灰＝沒有需要監控的狀態），
  // 右側有展開／收合箭頭；收合狀態記在 localStorage。燈號由各區塊載入時拿到的真實設定／健康資料決定。
  const ADMIN_LIGHT_LABEL = { ok: '正常', warn: '注意', bad: '異常', off: '未啟用' };
  const ADMIN_LIGHT_RANK = { off: 0, ok: 1, warn: 2, bad: 3 };
  const ADMIN_COLLAPSE_KEY = 'mdwebview.adminCollapsed';
  const adminLightParts = {};

  function readAdminCollapsed() {
    try { return JSON.parse(localStorage.getItem(ADMIN_COLLAPSE_KEY) || '{}') || {}; } catch (_) { return {}; }
  }

  function writeAdminCollapsed(map) {
    try { localStorage.setItem(ADMIN_COLLAPSE_KEY, JSON.stringify(map)); } catch (_) {}
  }

  function setAdminCardCollapsed(card, collapsed, persist) {
    card.classList.toggle('collapsed', collapsed);
    const btn = card.querySelector('.config-card-toggle');
    if (btn) {
      btn.setAttribute('aria-expanded', String(!collapsed));
      btn.title = collapsed ? '展開' : '收合';
    }
    if (persist && card.dataset.card) {
      const map = readAdminCollapsed();
      if (collapsed) map[card.dataset.card] = 1; else delete map[card.dataset.card];
      writeAdminCollapsed(map);
    }
  }

  /** 幫每張卡片補上狀態燈與收合箭頭（只做一次）。 */
  function enhanceAdminCards() {
    const saved = readAdminCollapsed();
    document.querySelectorAll('.config-card[data-card]').forEach(card => {
      if (card.dataset.lightsReady) return;
      const header = card.querySelector('.config-card-header');
      if (!header) return;
      card.dataset.lightsReady = '1';
      const light = document.createElement('span');
      light.className = 'status-light off';
      light.setAttribute('role', 'img');
      light.setAttribute('aria-label', '狀態：未啟用');
      light.title = '這個區塊沒有需要監控的狀態';
      header.insertBefore(light, header.firstChild);
      const text = document.createElement('span');
      text.className = 'status-light-text';
      header.insertBefore(text, header.querySelector('.config-card-title').nextSibling);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'config-card-toggle';
      btn.setAttribute('aria-label', '展開或收合此區塊');
      btn.textContent = '▾';
      header.appendChild(btn);
      header.classList.add('collapsible');
      header.addEventListener('click', ev => {
        if (ev.target.closest('button:not(.config-card-toggle), a, input, select, label')) return;
        setAdminCardCollapsed(card, !card.classList.contains('collapsed'), true);
      });
      setAdminCardCollapsed(card, !!saved[card.dataset.card], false);
      renderAdminCardLight(card.dataset.card);
    });
  }

  function renderAdminCardLight(key) {
    const card = document.querySelector(`.config-card[data-card="${key}"]`);
    if (!card) return;
    const parts = Object.values(adminLightParts[key] || {});
    const worst = parts.reduce((a, b) => (ADMIN_LIGHT_RANK[b.level] > ADMIN_LIGHT_RANK[a.level] ? b : a), { level: 'off', text: '' });
    const light = card.querySelector('.status-light');
    const label = card.querySelector('.status-light-text');
    if (!light) return;
    light.className = `status-light ${worst.level}`;
    const notable = parts.filter(p => p.level === worst.level).map(p => p.text).filter(Boolean).join('；');
    const text = notable || (worst.level === 'off' ? '' : ADMIN_LIGHT_LABEL[worst.level]);
    light.title = text || '這個區塊沒有需要監控的狀態';
    light.setAttribute('aria-label', `狀態：${ADMIN_LIGHT_LABEL[worst.level]}${text ? `，${text}` : ''}`);
    label.textContent = worst.level === 'off' ? '' : text;
  }

  /** level: ok | warn | bad | off。同一張卡片可由多個 part 回報，取最嚴重的那個。 */
  function setAdminCardLight(key, level, text, part) {
    (adminLightParts[key] = adminLightParts[key] || {})[part || 'main'] = { level, text: text || '' };
    renderAdminCardLight(key);
  }

  let adminLightsWired = false;
  function wireAdminConfigLights() {
    if (adminLightsWired) return;
    adminLightsWired = true;
    const onEdit = ev => { if (ev.target.closest && ev.target.closest('#adminPaneConfig, #adminPaneSeo')) refreshAdminConfigLights(); };
    document.addEventListener('input', onEdit);
    document.addEventListener('change', onEdit);
  }

  function refreshAdminConfigLights() {
    const val = id => { const el = $(id); return el ? (el.type === 'checkbox' ? el.checked : String(el.value || '').trim()) : ''; };
    const L = setAdminCardLight;
    L('site', !val('settingsMdRoot') ? 'bad' : !val('settingsSiteUrl') ? 'warn' : 'ok',
      !val('settingsMdRoot') ? '尚未設定經文目錄' : !val('settingsSiteUrl') ? '未設定首頁權威 URL（影響驗證信連結與 SEO）' : '經文目錄與網址都已設定');
    L('reading', 'off');
    const footerIssues = [];
    if (val('settingsEnableDownload') && !val('settingsDownloadUrl')) footerIssues.push('已開啟離線下載但沒有填下載網址');
    if (val('settingsEnableDictionary') && !val('settingsDictionaryPath')) footerIssues.push('已開啟辭典但沒有填辭典路徑');
    L('footer', footerIssues.length ? 'warn' : 'ok', footerIssues.join('；'));
    L('announce', !val('settingsEnableAnnouncement') ? 'off' : val('settingsAnnouncementMessage') ? 'ok' : 'warn',
      !val('settingsEnableAnnouncement') ? '' : val('settingsAnnouncementMessage') ? '彈窗顯示中' : '已開啟但沒有訊息內容');
    L('password', 'off');
    L('cfgbackup', 'off');
    const robots = val('seoRobotsIndex');
    L('indexing', !robots ? 'warn' : val('seoSiteDescription') ? 'ok' : 'warn',
      !robots ? '已禁止搜尋引擎收錄' : val('seoSiteDescription') ? '允許收錄，已填網站描述' : '允許收錄，但還沒有填網站描述');
    L('og', val('seoOgImage') ? 'ok' : 'warn', val('seoOgImage') ? '已設定分享預覽圖' : '還沒有設定分享預覽圖');
    const verified = ['googleSiteVerification', 'bingSiteVerification', 'baiduSiteVerification'].filter(id => val(id)).length;
    L('webmaster', verified ? 'ok' : 'off', verified ? `已填 ${verified} 個驗證碼` : '');
    L('schema', val('seoEnableSearchBox') ? 'ok' : 'off', val('seoEnableSearchBox') ? '已啟用站內搜尋框結構化資料' : '');
  }

  async function loadAdminAccountSystemTab() {
    enhanceAdminCards();
    const ov = await accountApi('/api/admin/accounts-overview');
    if (!ov.ok) {
      adminNotice('adminAccountSysNotice', ov.data.error || '帳號功能目前無法使用');
      return;
    }
    const o = ov.data;
    const notes = [];
    if (o.adminNeedsEmail) notes.push('你的管理員帳號還沒有 Email，忘記密碼時無法自行重設。請到右上角「我的帳號」補上。');
    adminNotice('adminAccountSysNotice', notes.join(' '));
    $('adminPublicBaseUrl').textContent = o.publicBaseUrl ? `${o.publicBaseUrl}${o.publicBaseUrlSource === 'env' ? '（環境變數）' : '（首頁權威 URL）'}` : '未設定';
    renderAdminDbStatus(o.database);
    renderAdminSetup(o.setup);
    await Promise.all([loadAdminTurnstile(), loadAdminProviders(), loadAdminMail(), loadAdminMailDns(), loadAdminLegal(), loadAdminBackups()]);
  }

  // 開站設定：每一步對應一張卡片，按「前往」捲到那張卡片。
  const ADMIN_SETUP_HINTS = {
    baseUrl: '驗證信裡的連結要用網站的正式網址，在「系統設定」的「首頁權威 URL」填寫',
    mail: '填入 Resend 的 API 金鑰與寄件 Email',
    mailTest: '寄一封信給自己，確認收得到（也請看看是不是被當成垃圾信）',
    turnstile: '填入 Cloudflare Turnstile 的 Site key 與 Secret key',
    turnstileTest: '親自通過一次驗證，確認網域設定正確',
    sso: '在「第三方登入」填入金鑰並打開開關，讀者就能用 Google、Facebook、Apple 帳號登入'
  };
  const ADMIN_SETUP_TARGETS = { baseUrl: 'config', mail: 'adminMailCard', mailTest: 'adminMailTestTo', turnstile: 'adminTurnstileCard', turnstileTest: 'adminTurnstileLiveBtn', sso: 'adminSsoCard' };

  function renderAdminSetup(setup) {
    if (!setup) return;
    updateAdminSetupDot(setup);
    const list = $('adminSetupSteps');
    list.innerHTML = '';
    const current = setup.steps.find(st => !st.done);
    setup.steps.forEach((st, i) => {
      const li = document.createElement('li');
      li.className = `setup-step${st.done ? ' done' : ''}${st === current ? ' current' : ''}`;
      li.innerHTML = `<span class="setup-step-mark">${st.done ? '✓' : i + 1}</span>
        <span class="setup-step-text"><strong>${escHtml(st.label)}</strong>${st.required ? '' : ' <span class="field-hint" style="display:inline">（建議）</span>'}
        <span class="field-hint">${st.done && st.at ? `完成於 ${escHtml(fmtDateTime(st.at))}` : escHtml(ADMIN_SETUP_HINTS[st.id] || '')}</span></span>`;
      if (!st.done) {
        const go = document.createElement('button');
        go.type = 'button';
        go.className = `modal-btn ${st === current ? 'submit-btn' : 'secondary-btn'} small-btn`;
        go.textContent = '前往';
        go.addEventListener('click', () => goToAdminSetupStep(st.id));
        li.appendChild(go);
      }
      list.appendChild(li);
    });
    const badge = $('adminSetupBadge');
    const done = setup.steps.filter(st => st.done).length;
    setAdminCardLight('setup', !setup.requiredComplete ? 'bad' : setup.complete ? 'ok' : 'warn',
      !setup.requiredComplete ? `必要步驟尚未完成（${done} / ${setup.steps.length}）` : setup.complete ? '全部完成' : `必要步驟完成，還有建議步驟（${done} / ${setup.steps.length}）`);
    badge.textContent = setup.complete ? '全部完成' : `${done} / ${setup.steps.length}`;
    badge.classList.toggle('danger', !setup.requiredComplete);
  }

  function updateAdminSetupDot(setup) {
    const dot = $('adminAccountSysDot');
    if (dot) dot.hidden = !setup || setup.requiredComplete;
  }

  function goToAdminSetupStep(id) {
    const target = ADMIN_SETUP_TARGETS[id];
    if (target === 'config') {
      $('adminTabConfigBtn').click();
      setTimeout(() => { const el = $('settingsSiteUrl'); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.focus(); } }, 300);
      return;
    }
    const el = $(target);
    if (!el) return;
    const card = el.closest('.config-card');
    const howto = card && card.querySelector('details.setup-howto');
    if (howto && (id === 'mail' || id === 'turnstile')) howto.open = true;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (el.tagName === 'INPUT' || el.tagName === 'BUTTON') setTimeout(() => el.focus(), 400);
  }

  /** 登入後台時檢查一次，開站設定沒完成就在「帳號系統」分頁上亮紅點。 */
  async function refreshAdminSetupDot() {
    const r = await accountApi('/api/admin/accounts-overview');
    if (r.ok) updateAdminSetupDot(r.data.setup);
    return r.ok ? r.data.setup : null;
  }

  // ── 第三方登入（Google、Facebook、Apple）──
  // 設定引導：依本站實際的對外網址產生要貼進服務商後台的值，每個值都有複製鈕。
  function ssoValue(value) {
    return '<span class="sso-val"><code>' + escHtml(value) + '</code><button type="button" class="sso-copy-val" data-copy="' + escHtml(value) + '">複製</button></span>';
  }

  function ssoHowto(id, p) {
    let origin = '', host = '', parent = '';
    try { const u = new URL(p.callbackUrl); origin = u.origin; host = u.hostname; } catch (_) { /* 還沒設對外網址 */ }
    if (host && !/^\d+\.\d+\.\d+\.\d+$/.test(host)) parent = host.split('.').slice(-2).join('.');
    const cb = p.callbackUrl;
    const noUrl = '<strong>（還沒有對外網址：請先到「系統設定」填寫首頁權威 URL，這裡才會顯示要貼的值。）</strong>';
    const v = (x) => x ? ssoValue(x) : noUrl;
    const privacy = origin ? origin + '/privacy' : '';
    const terms = origin ? origin + '/terms' : '';
    if (id === 'google') return [
      '<strong>建立專案。</strong>開 <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener">Google Cloud 建立專案</a>，專案名稱隨意（例如本站名稱），按「建立」，然後確認畫面上方的專案選單選的是它。',
      '<strong>設定「Google 驗證平台」（OAuth 同意畫面）。</strong>開 <a href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noopener">Google 驗證平台</a>，按「開始使用」，依序填：<ul>' +
        '<li>應用程式名稱：讀者在 Google 授權畫面上看到的名稱，建議用本站名稱。</li>' +
        '<li>使用者支援電子郵件：選你自己的 Gmail。</li>' +
        '<li>目標對象：選「外部」（只有 Google Workspace 組織內部使用才選「內部」）。</li>' +
        '<li>聯絡資訊：填一個你收得到信的信箱。</li>' +
        '<li>同意《Google API 服務使用者資料政策》後按「建立」。</li></ul>',
      '<strong>品牌宣傳。</strong>到左側「品牌宣傳」，填「已授權網域」' + (parent ? '：' + ssoValue(parent) + '（只填主網域，不含 https:// 與子網域）' : '，填網站的主網域（例如 example.com，不含 https:// 與子網域）') + '，並填：<ul>' +
        '<li>應用程式首頁：' + v(origin) + '</li>' +
        '<li>應用程式隱私權政策連結：' + v(privacy) + '</li>' +
        '<li>應用程式服務條款連結：' + v(terms) + '</li></ul>' +
        '最下面按「儲存」。畫面出現「已儲存品牌宣傳變更！」就是成功。',
      '<strong>資料存取（範圍）。</strong>到左側「資料存取」→「新增或移除範圍」，勾選 <code>.../auth/userinfo.email</code>、<code>.../auth/userinfo.profile</code> 與 <code>openid</code>，儲存。只用這三個「非機密」範圍，不需要送 Google 審查。',
      '<strong>建立 OAuth 用戶端。</strong>到左側「用戶端」→「建立用戶端」（或 <a href="https://console.cloud.google.com/auth/clients/create" target="_blank" rel="noopener">直接開這頁</a>），「應用程式類型」選「網頁應用程式」，名稱隨意，然後兩個欄位這樣填：<ul>' +
        '<li><strong>已授權的 JavaScript 來源</strong>（必填，留空會顯示「來源無效：URI 不得留空」）：按「新增 URI」貼上 ' + v(origin) + '。這是網站的「來源」，只有 https://網域，<strong>後面不要加路徑、不要加結尾斜線</strong>。本站是伺服器端登入，這欄實際上用不到，但 Google 要求一定要填。</li>' +
        '<li><strong>已授權的重新導向 URI</strong>：按「新增 URI」貼上 ' + v(cb) + '。這個要<strong>一字不差</strong>，包含 https、網域、路徑，結尾沒有斜線。</li></ul>' +
        '「Use this client for an AI-powered agent」不要勾。按「建立」。',
      '<strong>複製金鑰。</strong>建立後出現的視窗有「用戶端 ID」與「用戶端密鑰」，分別貼到下面對應欄位。密鑰之後只能在該用戶端頁面查看／新增，貼完再離開比較保險。',
      '<strong>發布狀態。</strong>到「目標對象」：狀態是「測試中」時，只有你加入「測試使用者」名單的 Gmail（最多 100 個）能登入，其他人會看到「存取遭封鎖」。要開放給所有讀者，按「發布應用程式」改成「正式版」。只用上述三個範圍，不需要 Google 驗證審查；未驗證時畫面可能多出提示，不影響登入。',
      '<strong>等待生效。</strong>Google 說明「設定可能需要 5 分鐘至數小時才會生效」。剛儲存就檢查若出現 redirect_uri_mismatch，先等幾分鐘再按「檢查設定」。',
      '<strong>常見錯誤。</strong><ul>' +
        '<li><code>redirect_uri_mismatch</code>（錯誤 400）：「已授權的重新導向 URI」與回調網址不是一字不差。常見原因：http／https 不同、有多餘斜線、網域有 www 或沒有、改了設定還沒生效。</li>' +
        '<li><code>access_blocked</code>／「存取遭封鎖」：發布狀態仍是「測試中」而該 Gmail 不在測試使用者名單；到「目標對象」加入或改成「正式版」。</li>' +
        '<li>「來源無效：URI 不得留空」：「已授權的 JavaScript 來源」沒填，貼上網站來源即可。</li>' +
        '<li><code>invalid_client</code>：用戶端 ID 或密鑰貼錯，或貼到前後多了空白。</li>' +
        '<li>授權畫面顯示的是舊名稱或不是本站：到「品牌宣傳」修改應用程式名稱。</li></ul>'
    ];
    if (id === 'facebook') return [
      '<strong>建立應用程式。</strong>開 <a href="https://developers.facebook.com/apps/" target="_blank" rel="noopener">Meta for Developers</a>，用你的 Facebook 帳號登入並註冊為開發人員，按「建立應用程式」。名稱用本站名稱，聯絡電子郵件填你收得到信的信箱；用途選「驗證和要求用戶資料」（使用 Facebook 登入）；商家選「我還不想連結商家資產管理組合」即可。',
      '<strong>加入 Facebook 登入。</strong>在應用程式面板的「使用案例」，點「驗證和要求用戶資料」→「自訂」，新增 <code>email</code> 權限（<code>public_profile</code> 預設就有）。這兩個是基本權限，不需要送 Meta 審核。',
      '<strong>填登入設定。</strong>到「Facebook 登入」→「設定」，確認：<ul>' +
        '<li>用戶端 OAuth 登入：開</li><li>網頁版 OAuth 登入：開</li><li>強制使用 HTTPS 進行 OAuth 重新導向：開</li>' +
        '<li><strong>有效的 OAuth 重新導向 URI</strong>：貼上 ' + v(cb) + '（一字不差，結尾沒有斜線），按「儲存變更」。</li></ul>',
      '<strong>基本資料。</strong>「應用程式設定」→「基本資料」，填：<ul>' +
        '<li>應用程式網域：' + v(host) + '</li>' +
        '<li>隱私權政策網址：' + v(privacy) + '</li>' +
        '<li>服務條款網址：' + v(terms) + '</li>' +
        '<li>使用者資料刪除：選「資料刪除說明網址」，填 ' + v(privacy) + '（本站隱私權政策已說明如何申請刪除）。</li>' +
        '<li>類別：選「教育」或最接近的項目。</li></ul>按「儲存變更」。',
      '<strong>複製金鑰。</strong>同一頁最上面有「應用程式編號」（App ID）與「應用程式密鑰」（按「顯示」，會要你輸入 Facebook 密碼），貼到下面對應欄位。',
      '<strong>切換到「上線」。</strong>頁面最上方的應用程式模式開關從「開發中」切到「上線」。必須先填好隱私權政策網址與類別才能切換。開發中時，只有應用程式的管理員、開發人員與測試人員能登入，其他人會看到「此應用程式目前無法使用」。',
      '<strong>常見錯誤。</strong><ul>' +
        '<li>「URL 已遭封鎖：重新導向失敗」：回調網址沒加到「有效的 OAuth 重新導向 URI」，或「用戶端／網頁版 OAuth 登入」沒開。</li>' +
        '<li>「無法載入網址：這個網址的網域未包含在應用程式網域中」：「基本資料」的應用程式網域沒填對。</li>' +
        '<li>「此應用程式目前無法使用」：還在「開發中」模式。</li>' +
        '<li>登入成功但沒有電子郵件：使用者的 Facebook 帳號沒有已驗證的信箱，或拒絕提供；這種情況本站不會自動合併到既有帳號。</li></ul>'
    ];
    return [
      '<strong>前置條件。</strong>需要付費的 <a href="https://developer.apple.com/programs/" target="_blank" rel="noopener">Apple Developer Program</a> 會員（美金 99 元／年）。網站必須是 https，不能是 localhost 或 IP。以下都在 <a href="https://developer.apple.com/account/resources/identifiers/list" target="_blank" rel="noopener">Certificates, Identifiers &amp; Profiles</a>。',
      '<strong>建立 App ID。</strong>Identifiers → 「+」→ App IDs → App → 填描述與 Bundle ID（例如 <code>' + escHtml(parent ? parent.split('.').reverse().join('.') + '.web' : 'com.example.web') + '</code>），Capabilities 勾選「Sign in with Apple」，Continue → Register。',
      '<strong>建立 Services ID。</strong>Identifiers → 「+」→ Services IDs → 描述填本站名稱，Identifier 填例如 <code>' + escHtml(parent ? parent.split('.').reverse().join('.') + '.signin' : 'com.example.signin') + '</code>。這個 Identifier 就是下面的「Services ID」。Register 之後再點進去，勾選「Sign in with Apple」→ Configure：<ul>' +
        '<li>Primary App ID：選上一步的 App ID。</li>' +
        '<li>Domains and Subdomains：' + v(host) + '（不含 https://）。</li>' +
        '<li>Return URLs：' + v(cb) + '（一字不差）。</li></ul>按 Next → Done → Continue → Save。',
      '<strong>建立 Key。</strong>Keys → 「+」→ 名稱隨意，勾選「Sign in with Apple」→ Configure 選剛才的 App ID → Save → Continue → Register。<strong>Download 只能下載一次</strong>，請保存好 <code>.p8</code> 檔；頁面上的 Key ID（10 碼）貼到下面。',
      '<strong>Team ID。</strong>在 <a href="https://developer.apple.com/account#MembershipDetailsCard" target="_blank" rel="noopener">會員資格詳細資料</a> 的 Team ID（10 碼英數字）。',
      '<strong>貼私鑰。</strong>把 .p8 檔的完整內容（含 BEGIN／END PRIVATE KEY 那兩行）貼到私鑰欄位，或按「選擇檔案」載入。本站會自動產生 Apple 要求的 client secret，不需要自己算。',
      '<strong>注意事項。</strong><ul>' +
        '<li>Apple 只在使用者<strong>第一次</strong>授權時提供姓名；之後登入不會再給。</li>' +
        '<li>使用者可選「隱藏我的電子郵件」，信箱會是 <code>@privaterelay.appleid.com</code>。要寄信給這類地址，須到 Services → Sign in with Apple for Email Communication 登記寄信網域與寄件信箱（Resend 的寄信網域）。</li>' +
        '<li>Return URLs 必須是 https 的公開網址，Apple 會用跨站 POST 呼叫它。</li></ul>',
      '<strong>常見錯誤。</strong><ul>' +
        '<li><code>invalid_client</code>：Services ID、Team ID、Key ID 或私鑰其中之一不對；Services ID 要填 Services ID，不是 App ID。</li>' +
        '<li><code>invalid_request</code>／Invalid redirect_uri：Return URLs 與回調網址不一致，或網域沒登記。</li>' +
        '<li>登入後跳回本站出現錯誤：確認網站是 https 且反向代理沒有擋掉 POST 回調。</li></ul>'
    ];
  }

  async function loadAdminProviders() {
    const r = await accountApi('/api/admin/auth-providers');
    if (!r.ok) return;
    const list = $('adminProviderList');
    list.innerHTML = '';
    const active = r.data.providers.filter(p => p.active).length;
    const idle = r.data.providers.filter(p => p.configured && !p.active).length;
    setAdminCardLight('sso', active ? 'ok' : 'warn', active ? `${active} 個登入方式啟用中${idle ? `，${idle} 個已關閉` : ''}` : idle ? '金鑰已設定但全部關閉' : '還沒有啟用任何第三方登入（選用）');
    for (const p of r.data.providers) {
      const section = document.createElement('section');
      section.className = 'sso-provider';
      section.dataset.provider = p.id;
      list.appendChild(section);
      renderAdminProvider(section, p);
    }
  }

  function ssoStatusBadge(p) {
    if (p.active) return '<span class="account-badge">啟用中</span>';
    if (p.configured) return '<span class="account-badge danger">已關閉</span>';
    return '<span class="account-badge danger">未設定</span>';
  }

  function renderAdminProvider(section, p) {
    const id = p.id;
    const canToggle = p.configured;
    const webSet = p.fields.filter(f => f.source === 'web');
    const locked = p.fields.filter(f => f.locked);
    section.innerHTML = `
      <div class="sso-head">
        <strong>${escHtml(p.label)}</strong>
        <span class="sso-status">${ssoStatusBadge(p)}</span>
        <label class="toggle-switch sso-toggle-wrap" title="${canToggle ? '在登入畫面顯示這個登入方式' : '金鑰填齊並通過檢查後才能開啟'}">
          <input type="checkbox" class="sso-toggle" ${p.enabled && p.configured ? 'checked' : ''} ${canToggle ? '' : 'disabled'} aria-label="${escHtml(p.label)} 登入開關">
          <span class="toggle-slider"></span>
        </label>
      </div>
      <details class="setup-howto"><summary>怎麼申請 ${escHtml(p.label)} 的金鑰？（完整逐步說明）</summary><ol class="sso-steps">${ssoHowto(id, p).map(t => `<li>${t}</li>`).join('')}</ol></details>
      <div class="sso-callback">
        <span class="field-hint">回調網址（加到 ${escHtml(p.label)} 後台的重新導向 URI）</span>
        ${p.callbackUrl ? `<div class="account-inline-form"><input type="text" readonly class="sso-callback-input" value="${escHtml(p.callbackUrl)}" aria-label="${escHtml(p.label)} 回調網址"><button type="button" class="modal-btn secondary-btn small-btn sso-copy">複製</button></div>` : '<span class="field-hint">還沒有對外網址，請先到「系統設定」填寫首頁權威 URL。</span>'}
      </div>
      <div class="setup-form sso-fields"></div>
      <div class="field-hint sso-lock-note"></div>
      <div class="account-inline-form">
        <button type="button" class="modal-btn submit-btn small-btn sso-save">儲存並檢查</button>
        <button type="button" class="modal-btn secondary-btn small-btn sso-check" ${p.configured ? '' : 'hidden'}>檢查設定</button>
        <button type="button" class="modal-btn secondary-btn small-btn sso-clear" ${webSet.length ? '' : 'hidden'}>清除網頁上設定的金鑰</button>
      </div>
      <div class="setup-result sso-result" style="display: none;"></div>`;

    const fieldsBox = section.querySelector('.sso-fields');
    const inputs = {};
    for (const f of p.fields) {
      const wrap = document.createElement('div');
      wrap.className = 'sso-field';
      const inputId = `sso-${id}-${f.key}`;
      const label = document.createElement('label');
      label.className = 'field-hint';
      label.htmlFor = inputId;
      label.textContent = f.label;
      const input = document.createElement(f.multiline ? 'textarea' : 'input');
      input.id = inputId;
      if (f.multiline) { input.rows = 4; } else { input.type = f.secret ? 'password' : 'text'; }
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.disabled = !!f.locked;
      input.placeholder = f.set && f.secret ? (f.source === 'file' ? '已由伺服器上的私鑰檔設定' : `已設定（${f.masked}），要更換才需要填`) : (f.placeholder || '');
      if (!f.secret && f.value) input.value = f.value;
      inputs[f.key] = input;
      wrap.appendChild(label);
      wrap.appendChild(input);
      if (f.locked) {
        const note = document.createElement('span');
        note.className = 'field-hint';
        note.textContent = f.source === 'file' ? `由環境變數 ${p.keyFile ? p.keyFile.env : 'APPLE_PRIVATE_KEY_PATH'} 指定的檔案提供` : `由環境變數 ${f.env} 設定，優先於網頁設定`;
        wrap.appendChild(note);
      }
      if (f.unreadable) {
        const note = document.createElement('span');
        note.className = 'field-hint';
        note.textContent = '之前存的內容無法解密（伺服器上的 secrets.key 可能遺失），請重新填寫。';
        wrap.appendChild(note);
      }
      if (f.multiline && !f.locked) {
        const pick = document.createElement('input');
        pick.type = 'file';
        pick.accept = '.p8,.pem,.txt';
        pick.className = 'sso-file';
        pick.setAttribute('aria-label', '選擇 .p8 檔');
        pick.addEventListener('change', async () => {
          const file = pick.files && pick.files[0];
          if (file) input.value = await file.text();
        });
        wrap.appendChild(pick);
      }
      fieldsBox.appendChild(wrap);
    }
    if (p.keyFile && !p.keyFile.readable) {
      section.querySelector('.sso-lock-note').textContent = `環境變數 ${p.keyFile.env} 指向的私鑰檔讀不到，請確認路徑與權限，或改在網頁上貼私鑰。`;
    } else if (locked.length && locked.some(f => f.source !== 'file')) {
      section.querySelector('.sso-lock-note').textContent = '標示「由環境變數設定」的欄位優先於網頁設定，要改請改伺服器的 .env。';
    }

    const result = section.querySelector('.sso-result');
    const messages = {
      valid: '✅ 服務商接受這組金鑰',
      invalid: '❌ 服務商不接受這組金鑰，請回到它的後台重新複製',
      incomplete: '金鑰還沒填齊',
      unreachable: '⚠️ 暫時連不上服務商，稍後再試',
      uncertain: '⚠️ 服務商回了無法判斷的結果，請實際用這個方式登入一次確認',
      redirect_mismatch: '⚠️ 金鑰正確，但回調網址還沒登記到服務商後台，請把上面的回調網址加進它的重新導向 URI（要一字不差），否則登入會失敗'
    };
    const refresh = (providers) => {
      const fresh = providers.find(x => x.id === id);
      if (fresh) renderAdminProvider(section, fresh);
      return section.querySelector('.sso-result');
    };
    const afterSave = async (r, { toggle }) => {
      if (!r.ok) {
        if (r.data.code === 'REAUTH_CANCELLED') { if (toggle) refresh([p]); return; }
        if (toggle) { const out = refresh([p]); showSetupResult(out, 'error', [`❌ ${r.data.error || '儲存失敗'}`]); }
        else showSetupResult(result, 'error', [`❌ ${r.data.error || '儲存失敗'}`]);
        return;
      }
      const out = refresh(r.data.providers);
      const lines = [toggle ? '✅ 已更新' : '✅ 已儲存'];
      if (r.data.check && r.data.check.state === 'valid') lines.push('服務商接受這組金鑰');
      (r.data.warnings || []).forEach(w => lines.push(`⚠️ ${w}`));
      const fresh = r.data.providers.find(x => x.id === id);
      if (!toggle && fresh && fresh.configured && !fresh.enabled) lines.push('下一步：打開上方的開關，讀者就能在登入畫面看到這個登入方式。');
      if (!toggle && fresh && fresh.configured && fresh.enabled) lines.push('已經顯示在登入畫面。建議用另一個瀏覽器實際登入一次確認回調網址有設對。');
      showSetupResult(out, (r.data.warnings || []).length ? '' : 'ok', lines);
      renderAdminSetup(r.data.setup);
      refreshAccountConfig();
    };

    section.querySelector('.sso-toggle').addEventListener('change', async (e) => {
      const enabled = e.target.checked;
      e.target.disabled = true;
      const r = await withReauth(() => accountApi('/api/admin/auth-providers/settings', { method: 'POST', body: { provider: id, enabled } }));
      await afterSave(r, { toggle: true });
    });

    section.querySelector('.sso-save').addEventListener('click', async () => {
      const btn = section.querySelector('.sso-save');
      const fields = {};
      for (const f of p.fields) {
        if (f.locked) continue;
        fields[f.key] = inputs[f.key].value;
      }
      btn.disabled = true;
      showSetupResult(result, '', ['向 ' + p.label + ' 確認金鑰中…']);
      const r = await withReauth(() => accountApi('/api/admin/auth-providers/settings', { method: 'POST', body: { provider: id, fields } }));
      btn.disabled = false;
      await afterSave(r, { toggle: false });
    });

    section.querySelector('.sso-check').addEventListener('click', async () => {
      showSetupResult(result, '', ['向 ' + p.label + ' 確認金鑰中…']);
      const r = await accountApi('/api/admin/auth-providers/check', { method: 'POST', body: { provider: id } });
      if (!r.ok) { showSetupResult(result, 'error', [`❌ ${r.data.error || '檢查失敗'}`]); return; }
      const st = r.data.check.state;
      showSetupResult(result, st === 'valid' ? 'ok' : (st === 'invalid' ? 'error' : ''), [messages[st] || st, r.data.check.detail && st === 'invalid' ? r.data.check.detail : '']);
    });

    section.querySelector('.sso-clear').addEventListener('click', async () => {
      if (!confirm(`清除網頁上設定的 ${p.label} 金鑰？清除後讀者無法再用 ${p.label} 登入，已綁定的帳號仍保留。`)) return;
      const clear = p.fields.filter(f => f.source === 'web').map(f => f.key);
      const r = await withReauth(() => accountApi('/api/admin/auth-providers/settings', { method: 'POST', body: { provider: id, clear } }));
      await afterSave(r, { toggle: true });
    });

    section.querySelectorAll('.sso-copy-val').forEach((b) => b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(b.dataset.copy); showToast('✅ 已複製', 'success', 1500); }
      catch (_) { showToast('複製失敗，請手動選取', 'info', 2500); }
    }));
    const copy = section.querySelector('.sso-copy');
    if (copy) {
      copy.addEventListener('click', async () => {
        const input = section.querySelector('.sso-callback-input');
        try { await navigator.clipboard.writeText(input.value); showToast('✅ 已複製回調網址', 'success', 1800); }
        catch (_) { input.select(); document.execCommand('copy'); showToast('已選取，請按 Ctrl/⌘+C 複製', 'info', 2500); }
      });
    }
  }

  async function loadAdminMail() {
    const r = await accountApi('/api/admin/mail');
    if (r.ok) { renderAdminMail(r.data); fillAdminMailForm(r.data); }
  }

  function settingSourceText(d) {
    if (!d || !d.source) return '未設定';
    return d.source === 'env' ? `由環境變數 ${d.env} 設定` : '在網頁上設定';
  }

  function parseMailFrom(from) {
    const m = String(from || '').trim().match(/^(?:(.*?)\s*<\s*([^\s<>@]+@[^\s<>@]+)\s*>|([^\s<>@]+@[^\s<>@]+))$/);
    if (!m) return { name: '', address: '' };
    return m[2] ? { name: m[1].replace(/^"|"$/g, '').trim(), address: m[2] } : { name: '', address: m[3] };
  }

  function fillAdminMailForm(m) {
    const st = m.settings || {};
    const provider = $('adminMailProvider');
    provider.value = m.provider || (st.provider && st.provider.source ? '' : 'resend');
    provider.disabled = !!(st.provider && st.provider.locked);
    const key = $('adminMailApiKey');
    key.value = '';
    key.disabled = !!(st.apiKey && st.apiKey.locked);
    key.placeholder = st.apiKey && st.apiKey.set ? `已設定（${st.apiKey.masked}），要更換才需要填` : 're_ 開頭';
    const from = parseMailFrom(m.from);
    $('adminMailFromName').value = from.name || (m.from ? '' : (($('settingsSiteName') || {}).value || 'mdWebview').trim());
    $('adminMailFromAddress').value = from.address;
    const fromLocked = !!(st.from && st.from.locked);
    $('adminMailFromName').disabled = fromLocked;
    $('adminMailFromAddress').disabled = fromLocked;
    $('adminMailClearKeyBtn').hidden = !(st.apiKey && st.apiKey.source === 'web');
    const locked = ['provider', 'apiKey', 'from'].filter(k => st[k] && st[k].locked).map(k => st[k].env);
    const notes = [];
    if (locked.length) notes.push(`${locked.join('、')} 已在伺服器的環境變數設定，優先於網頁設定，這裡不能修改。`);
    if (st.apiKey && st.apiKey.unreadable) notes.push('之前存的金鑰無法解密（伺服器上的 secrets.key 可能遺失），請重新貼上金鑰。');
    $('adminMailLockNote').textContent = notes.join(' ');
    syncAdminMailFormState();
  }

  function syncAdminMailFormState() {
    $('adminMailResendFields').hidden = $('adminMailProvider').value !== 'resend';
  }

  function showSetupResult(el, kind, lines) {
    el.classList.add('setup-result');
    el.classList.toggle('ok', kind === 'ok');
    el.classList.toggle('error', kind === 'error');
    el.textContent = lines.filter(Boolean).join('\n');
    el.style.display = lines.some(Boolean) ? 'block' : 'none';
  }

  function renderAdminMail(m) {
    const st = m.settings || {};
    const mailOk = m.configured && m.provider === 'resend';
    setAdminCardLight('mail', mailOk ? (m.failures24h > 0 ? 'warn' : 'ok') : m.provider === 'log' ? 'warn' : 'bad',
      mailOk ? (m.failures24h > 0 ? `24 小時內寄送失敗 ${m.failures24h} 封` : '可以寄信') : m.provider === 'log' ? '測試模式，信不會真的寄出' : '無法寄信，註冊與重設密碼信都寄不出去');
    const providerText = m.provider === 'resend' ? 'Resend' : m.provider === 'log' ? '只寫進日誌（測試用，不會真的寄出）' : '停用';
    const missingLabels = { MAIL_PROVIDER: '寄信服務', MAIL_API_KEY: 'API 金鑰', MAIL_FROM: '寄件 Email' };
    const missing = (m.missingEnv || []).length ? `<div class="account-list-row"><span>還缺</span><span class="account-badge danger">${escHtml(m.missingEnv.map(n => missingLabels[n] || n).join('、'))}</span></div>` : '';
    $('adminMailStatus').innerHTML = `
      <div class="account-list-row"><span>狀態</span><span>${m.configured && m.provider === 'resend' ? '<span class="account-badge">可以寄信</span>' : m.provider === 'log' ? '<span class="account-badge danger">測試模式</span>' : '<span class="account-badge danger">無法寄信</span>'}</span></div>
      <div class="account-list-row"><span>寄信服務</span><span>${escHtml(providerText)}<br><span class="field-hint">${escHtml(settingSourceText(st.provider))}</span></span></div>
      <div class="account-list-row"><span>寄件人</span><span>${escHtml(m.from || '未設定')}${m.from ? `<br><span class="field-hint">${escHtml(settingSourceText(st.from))}</span>` : ''}</span></div>
      <div class="account-list-row"><span>API 金鑰</span><span>${m.apiKeySet ? `<span class="account-badge">已設定 ${escHtml((st.apiKey && st.apiKey.masked) || '')}</span><br><span class="field-hint">${escHtml(settingSourceText(st.apiKey))}</span>` : '<span class="account-badge danger">未設定</span>'}</span></div>
      ${missing}
      <div class="account-list-row"><span>最近一次寄出</span><span>${m.lastSentAt ? escHtml(fmtDateTime(m.lastSentAt)) : '—'}</span></div>
      <div class="account-list-row"><span>24 小時內寄送失敗</span><span>${m.failures24h}</span></div>`;
  }

  async function loadAdminMailDns() {
    const box = $('adminMailDns');
    box.innerHTML = '<div class="field-hint">檢查中…</div>';
    const r = await accountApi('/api/admin/mail/dns');
    if (!r.ok) { box.innerHTML = `<div class="field-hint">${escHtml(r.data.error || '檢查失敗')}</div>`; return; }
    renderAdminMailDns(r.data);
  }

  function renderAdminMailDns(d) {
    const box = $('adminMailDns');
    if (!d.domain) { box.innerHTML = '<div class="field-hint">先在上面填好寄件 Email，才能檢查寄件網域的 DNS。</div>'; return; }
    box.innerHTML = '';
    for (const rec of d.records) {
      const badge = rec.ok ? '<span class="account-badge">正常</span>' : rec.required ? '<span class="account-badge danger">找不到</span>' : '<span class="account-badge danger">建議新增</span>';
      const row = document.createElement('div');
      row.className = 'account-list-row';
      row.innerHTML = `<span><strong>${escHtml(rec.label)}</strong> ${badge}${rec.required ? '' : ' <span class="field-hint">（選用）</span>'}
        <br><span class="field-hint">${escHtml(rec.type)} <code>${escHtml(rec.name)}</code></span>
        ${rec.ok ? '' : `<br><span class="field-hint">${escHtml(rec.hint)}</span>`}
        ${rec.found.length ? `<br><span class="field-hint">目前：${escHtml(rec.found.join(' ； '))}</span>` : ''}</span>`;
      box.appendChild(row);
    }
    const resendText = {
      known: d.resend && d.resend.domainStatus === 'verified' ? '✅ Resend 回報這個網域已驗證，可以寄信' : `⚠️ Resend 回報這個網域的狀態是「${d.resend && d.resend.domainStatus}」，驗證通過前寄不出信（DNS 剛改過的話，到 Resend 的 Domains 頁面按 Verify DNS Records）`,
      domain_missing: `⚠️ Resend 帳號裡沒有 ${d.domain} 這個網域，請先在 Resend 的 Domains 新增`,
      send_only: '這把金鑰只能寄信，查不到 Resend 上的驗證狀態；以上是 DNS 實際查到的結果。到 Resend 的 Domains 頁面看到 Verified 就代表可以寄信',
      invalid: '⚠️ Resend 不接受目前的 API 金鑰，無法查詢網域狀態',
      unreachable: '暫時連不上 Resend，無法查詢網域狀態'
    };
    const lines = [];
    if (d.resend && resendText[d.resend.state]) lines.push(resendText[d.resend.state]);
    if (d.note) lines.push(d.note);
    lines.push(`檢查時間：${fmtDateTime(d.checkedAt)}。DNS 剛修改後可能要幾分鐘才會生效；Cloudflare 的記錄請設為「僅 DNS」（灰雲）。`);
    for (const text of lines) {
      const foot = document.createElement('div');
      foot.className = 'field-hint';
      foot.textContent = text;
      box.appendChild(foot);
    }
  }

  async function loadAdminTurnstile() {
    const r = await accountApi('/api/admin/turnstile');
    if (r.ok) { renderAdminTurnstile(r.data); fillAdminTurnstileForm(r.data); }
  }

  function fillAdminTurnstileForm(t) {
    const st = t.settings || {};
    const site = $('adminTurnstileSiteKey');
    site.value = t.siteKey || '';
    site.disabled = !!(st.siteKey && st.siteKey.locked);
    const secret = $('adminTurnstileSecret');
    secret.value = '';
    secret.disabled = !!(st.secret && st.secret.locked);
    secret.placeholder = st.secret && st.secret.set ? `已設定（${st.secret.masked}），要更換才需要填` : '0x 開頭';
    $('adminTurnstileHowtoHost').textContent = t.expectedHostname || '你的網域';
    $('adminTurnstileDisableBtn').hidden = !((st.siteKey && st.siteKey.source === 'web') || (st.secret && st.secret.source === 'web'));
    const locked = ['siteKey', 'secret'].filter(k => st[k] && st[k].locked).map(k => st[k].env);
    const notes = [];
    if (locked.length) notes.push(`${locked.join('、')} 已在伺服器的環境變數設定，優先於網頁設定，這裡不能修改。`);
    if (st.secret && st.secret.unreadable) notes.push('之前存的 secret 無法解密（伺服器上的 secrets.key 可能遺失），請重新貼上。');
    $('adminTurnstileLockNote').textContent = notes.join(' ');
    $('adminTurnstileLiveBtn').disabled = !t.configured;
  }

  function renderAdminTurnstile(t) {
    setAdminCardLight('turnstile', t.configured ? 'ok' : 'warn', t.configured ? '已設定' : '未設定（選用，用來擋機器人註冊）');
    const yes = text => `<span class="account-badge">${text}</span>`;
    const no = text => `<span class="account-badge danger">${text}</span>`;
    const last = t.lastResult;
    $('adminTurnstileStatus').innerHTML = `
      <div class="account-list-row"><span>狀態</span><span>${t.configured ? yes('已啟用') : no('未啟用')}</span></div>
      <div class="account-list-row"><span>Site key</span><span>${t.siteKey ? `<code>${escHtml(t.siteKey)}</code>` : no('未設定')}</span></div>
      <div class="account-list-row"><span>Secret</span><span>${t.secretSet ? yes(`已設定 ${escHtml((t.settings && t.settings.secret && t.settings.secret.masked) || '')}`) : no('未設定')}</span></div>
      ${t.usesTestKeys ? '<div class="account-list-row"><span>金鑰種類</span><span class="account-badge danger">Cloudflare 測試金鑰，正式網站請換掉</span></div>' : ''}
      <div class="account-list-row"><span>Cloudflare 上要允許的網域</span><span>${escHtml(t.expectedHostname || '—')}</span></div>
      <div class="account-list-row"><span>最近一次驗證</span><span>${last ? `${last.ok ? '通過' : `未通過 ${escHtml(last.reason || '')}`} · ${escHtml(fmtDateTime(last.at))}` : '—'}</span></div>
      <div class="account-list-row"><span>保護的動作</span><span>${escHtml((t.protects || []).join('、'))}</span></div>
      ${t.configured ? '' : '<div class="field-hint">未啟用時，註冊與登入只靠隱藏欄位、停留時間與次數限制擋機器人。</div>'}`;
  }

  const TURNSTILE_REASON_TEXT = {
    'hostname-mismatch': '網域不符：Cloudflare 上這個 widget 的 Hostname 沒有包含目前的網站網域',
    'invalid-input-secret': 'Secret 不對',
    'invalid-input-response': '驗證碼無效或已過期，請再試一次',
    'timeout-or-duplicate': '驗證碼已過期或用過了，請再試一次',
    'missing-input-response': '沒有取得驗證碼'
  };

  let adminTurnstileWidget = null;
  async function startAdminTurnstileLiveTest() {
    const box = $('adminTurnstileLiveBox');
    const out = $('adminTurnstileCheckResult');
    const info = await accountApi('/api/admin/turnstile');
    if (!info.ok || !info.data.configured) { out.textContent = '請先填好 Site key 與 Secret key'; return; }
    box.hidden = false;
    box.innerHTML = '';
    out.textContent = '請完成下方的驗證…';
    let ts;
    try { ts = await loadTurnstile(); } catch (_) { out.textContent = '載入 Turnstile 失敗，請檢查網路或瀏覽器的擋廣告外掛'; return; }
    if (adminTurnstileWidget !== null) { try { ts.remove(adminTurnstileWidget); } catch (_) {} }
    adminTurnstileWidget = ts.render(box, {
      sitekey: info.data.siteKey,
      action: 'admin-test',
      theme: document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark',
      callback: async (token) => {
        out.textContent = '向 Cloudflare 確認中…';
        const r = await accountApi('/api/admin/turnstile/verify', { method: 'POST', body: { token } });
        if (!r.ok) { out.textContent = r.data.error || '驗證失敗'; return; }
        out.textContent = r.data.ok
          ? '✅ 實測通過，訪客可以正常註冊'
          : `❌ ${TURNSTILE_REASON_TEXT[r.data.reason] || (r.data.unavailable ? '暫時連不上 Cloudflare' : r.data.reason || '未通過')}`;
        renderAdminTurnstile(r.data.info);
        renderAdminSetup(r.data.setup);
      },
      'error-callback': (code) => {
        out.textContent = String(code).startsWith('110200')
          ? '❌ 網域不符：請到 Cloudflare 的 Turnstile 設定，把目前的網域加進 Hostname'
          : `❌ Turnstile 顯示失敗（${code}），請確認 Site key 是否正確`;
        return true;
      }
    });
  }

  async function loadAdminLegal() {
    const r = await accountApi('/api/admin/legal');
    if (!r.ok) return;
    $('adminLegalPrivacy').value = r.data.privacy || '';
    $('adminLegalTerms').value = r.data.terms || '';
    $('adminLegalMajor').checked = false;
    setAdminCardLight('legal', r.data.version ? 'ok' : 'warn', r.data.version ? `已發布第 ${r.data.version} 版` : '尚未發布，開放註冊前應先發布');
    $('adminLegalVersion').textContent = r.data.version ? `第 ${r.data.version} 版 · ${fmtDateTime(r.data.updatedAt)}` : '尚未發布';
  }

  function renderAdminDbStatus(d) {
    const box = $('adminDbStatus');
    setAdminCardLight('db', !d || !d.available ? 'bad' : d.inMemory ? 'warn' : 'ok',
      !d || !d.available ? '資料庫無法使用' : d.inMemory ? '記憶體資料庫，重啟後資料消失' : '資料庫正常', 'db');
    if (!d || !d.available) {
      box.innerHTML = `<div class="account-list-row"><span>資料庫</span><strong>無法使用</strong></div>${d && d.error ? `<div class="field-hint">${escHtml(d.error)}</div>` : ''}`;
      return;
    }
    box.innerHTML = `
      <div class="account-list-row"><span>結構版本</span><span>${d.userVersion} / ${d.schemaVersion}${d.lastMigrationAt ? `（${escHtml(fmtDateTime(d.lastMigrationAt))} 升級）` : ''}</span></div>
      <div class="account-list-row"><span>大小</span><span>${escHtml(formatBytes(d.size + d.walSize))}${d.inMemory ? '（記憶體資料庫，重啟後消失）' : ''}</span></div>
      <div class="account-list-row"><span>帳號數</span><span>${d.users}</span></div>`;
  }

  async function loadAdminBackups() {
    const r = await accountApi('/api/admin/db-backups');
    if (r.ok) renderAdminBackups(r.data.backups, r.data.status);
  }

  function renderAdminBackups(backups, status) {
    const list = $('adminBackupList');
    list.innerHTML = '';
    $('adminBackupNowBtn').disabled = !!(status && status.inMemory) || !(status && status.backupsEnabled);
    setAdminCardLight('db', !(status && status.backupsEnabled) ? 'warn' : backups.length ? 'ok' : 'warn',
      !(status && status.backupsEnabled) ? '自動備份未啟用' : backups.length ? '' : '還沒有任何備份', 'backups');
    if (!backups.length) { list.innerHTML = '<div class="field-hint">還沒有備份</div>'; return; }
    for (const b of backups) {
      const row = document.createElement('div');
      row.className = 'account-list-row';
      row.innerHTML = `<span>${escHtml(b.name)}<br><span class="field-hint">${escHtml(fmtDateTime(b.mtime))} · ${escHtml(formatBytes(b.size))}</span></span>`;
      const dl = document.createElement('button');
      dl.type = 'button';
      dl.className = 'modal-btn secondary-btn small-btn';
      dl.textContent = '下載';
      dl.addEventListener('click', async () => {
        const fetchFile = async () => {
          const res = await fetch(`/api/admin/db-backups/download?name=${encodeURIComponent(b.name)}`, { credentials: 'same-origin' });
          if (res.ok) return { ok: true, status: 200, blob: await res.blob(), data: {} };
          let data = {};
          try { data = await res.json(); } catch (_) {}
          return { ok: false, status: res.status, data };
        };
        const r = await withReauth(fetchFile);
        if (r.ok) downloadBlob(r.blob, b.name);
        else if (r.data.code !== 'REAUTH_CANCELLED') showToast(`❌ ${r.data.error || '下載失敗'}`, 'error');
      });
      const rs = document.createElement('button');
      rs.type = 'button';
      rs.className = 'modal-btn danger-btn small-btn';
      rs.textContent = '還原';
      rs.addEventListener('click', async () => {
        if (!confirm(`用 ${b.name} 覆蓋目前的帳號資料庫？備份之後新增或修改的帳號會消失（還原前會先自動備份目前的資料庫）。`)) return;
        const clearSessions = $('adminRestoreClearSessions').checked;
        const r = await withReauth(() => accountApi('/api/admin/db-backups/restore', { method: 'POST', body: { name: b.name, clearSessions } }));
        if (r.ok) {
          showToast('✅ 已還原帳號資料庫', 'success', 3500);
          if (clearSessions) {
            setAccountUser(null);
            closeAdminModal();
            openLoginOverlay();
            return;
          }
          loadAdminAccountSystemTab();
        } else if (r.data.code !== 'REAUTH_CANCELLED') {
          showToast(`❌ ${r.data.error || '還原失敗'}`, 'error', 4000);
        }
      });
      row.appendChild(dl);
      row.appendChild(rs);
      list.appendChild(row);
    }
  }

  let adminAccountEventsReady = false;
  function setupAdminAccountEvents() {
    if (adminAccountEventsReady) return;
    adminAccountEventsReady = true;
    const reload = () => { adminUsersState.page = 1; loadAdminUsers(); };
    $('adminUsersSearch').addEventListener('input', debounce(reload, 300));
    ['adminUsersStatus', 'adminUsersRole', 'adminUsersProvider', 'adminUsersVerified'].forEach(id => $(id).addEventListener('change', reload));
    $('adminUsersPrev').addEventListener('click', () => { adminUsersState.page = Math.max(1, adminUsersState.page - 1); loadAdminUsers(); });
    $('adminUsersNext').addEventListener('click', () => { adminUsersState.page += 1; loadAdminUsers(); });

    $('adminRegSaveBtn').addEventListener('click', async () => {
      const r = await accountApi('/api/admin/registration', {
        method: 'POST',
        body: { mode: $('adminRegMode').value, hourlyCap: $('adminRegCap').value, disposableDomains: $('adminRegDomains').value }
      });
      if (r.ok) { showToast('✅ 註冊設定已儲存', 'success'); loadAdminRegistration(); refreshAccountConfig(); }
      else showToast(`❌ ${r.data.error || '儲存失敗'}`, 'error');
    });

    $('adminInviteCopyBtn').addEventListener('click', async () => {
      const code = $('adminInviteNewCode').textContent;
      try { await navigator.clipboard.writeText(code); showToast('✅ 已複製邀請碼', 'success', 1800); }
      catch (_) {
        const range = document.createRange();
        range.selectNodeContents($('adminInviteNewCode'));
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
        showToast('請按 Ctrl+C／⌘C 複製已選取的邀請碼', 'info', 3000);
      }
    });

    $('adminInviteCreateBtn').addEventListener('click', async () => {
      const r = await accountApi('/api/admin/invites', {
        method: 'POST',
        body: { usesLeft: $('adminInviteUses').value, expiresInDays: $('adminInviteDays').value, note: $('adminInviteNote').value }
      });
      if (!r.ok) { showToast(`❌ ${r.data.error || '產生失敗'}`, 'error'); return; }
      $('adminInviteNewCode').textContent = r.data.code;
      $('adminInviteNew').hidden = false;
      $('adminInviteNote').value = '';
      renderAdminInvites(r.data.invites);
    });

    $('adminLockoutClearAllBtn').addEventListener('click', async () => {
      const r = await accountApi('/api/admin/lockouts/clear', { method: 'POST', body: {} });
      if (r.ok) renderAdminLockouts(r.data);
    });
    $('adminEventsRefreshBtn').addEventListener('click', () => loadAdminEvents(true));
    $('adminEventsMoreBtn').addEventListener('click', () => loadAdminEvents(false));

    $('adminMailTestBtn').addEventListener('click', async () => {
      const r = await accountApi('/api/admin/mail/test', { method: 'POST', body: { to: $('adminMailTestTo').value.trim() } });
      if (r.ok) { showToast(`✅ ${r.data.message}，請到信箱確認（也看看垃圾郵件匣）`, 'success', 5000); renderAdminMail(r.data.status); renderAdminSetup(r.data.setup); }
      else showToast(`❌ ${r.data.error || '寄信失敗'}`, 'error', 4000);
    });

    $('adminMailDnsBtn').addEventListener('click', loadAdminMailDns);

    $('adminTurnstileCheckBtn').addEventListener('click', async () => {
      const out = $('adminTurnstileCheckResult');
      out.textContent = '檢查中…';
      const r = await accountApi('/api/admin/turnstile/test', { method: 'POST', body: {} });
      if (!r.ok) { out.textContent = r.data.error || '檢查失敗'; return; }
      const msg = {
        not_set: 'Secret 尚未設定',
        unreachable: `連不上 Cloudflare（${r.data.detail || ''}），請稍後再試`,
        invalid_secret: '❌ Cloudflare 不接受這個 secret，請確認 TURNSTILE_SECRET_KEY',
        test_secret: '⚠️ 這是 Cloudflare 測試 secret，任何人都會通過驗證',
        valid: '✅ Cloudflare 接受這個 secret'
      };
      out.textContent = msg[r.data.state] || r.data.state;
      renderAdminTurnstile(r.data.info);
    });


    $('adminMailProvider').addEventListener('change', syncAdminMailFormState);

    $('adminMailSaveBtn').addEventListener('click', async () => {
      const btn = $('adminMailSaveBtn');
      const out = $('adminMailSaveResult');
      const name = $('adminMailFromName').value.trim().replace(/[<>"]/g, '');
      const address = $('adminMailFromAddress').value.trim();
      const body = {};
      if (!$('adminMailProvider').disabled) body.provider = $('adminMailProvider').value;
      const resend = $('adminMailProvider').value === 'resend';
      const key = resend ? $('adminMailApiKey').value.trim() : '';
      if (resend) {
        if (!key && !$('adminMailApiKey').disabled && !$('adminMailApiKey').placeholder.startsWith('已設定')) {
          showSetupResult(out, 'error', ['請貼上 Resend 的 API 金鑰']);
          return;
        }
        if (!$('adminMailFromAddress').disabled) {
          if (!address) { showSetupResult(out, 'error', ['請填寄件 Email，例如 noreply@你的網域']); return; }
          body.from = name ? `${name} <${address}>` : address;
        }
        if (key) body.apiKey = key;
      }
      btn.disabled = true;
      showSetupResult(out, '', [key ? '向 Resend 確認金鑰中…' : '儲存中…']);
      const r = await withReauth(() => accountApi('/api/admin/mail/settings', { method: 'POST', body }));
      btn.disabled = false;
      if (!r.ok) {
        if (r.data.code === 'REAUTH_CANCELLED') { showSetupResult(out, '', []); return; }
        showSetupResult(out, 'error', [`❌ ${r.data.error || '儲存失敗'}`]);
        return;
      }
      const lines = ['✅ 已儲存'];
      if (r.data.keyCheck && r.data.keyCheck.state === 'valid_send_only') lines.push('Resend 金鑰有效（只能寄信，這是建議的權限）');
      if (r.data.keyCheck && r.data.keyCheck.state === 'valid') lines.push('Resend 金鑰有效（完整權限）');
      (r.data.warnings || []).forEach(w => lines.push(`⚠️ ${w}`));
      if (r.data.mail.configured && r.data.mail.provider === 'resend') lines.push('下一步：確認下方 DNS 都是「正常」，然後寄一封測試信給自己。');
      showSetupResult(out, (r.data.warnings || []).length ? '' : 'ok', lines);
      renderAdminMail(r.data.mail);
      fillAdminMailForm(r.data.mail);
      renderAdminSetup(r.data.setup);
      loadAdminMailDns();
      refreshAccountConfig();
    });

    $('adminMailClearKeyBtn').addEventListener('click', async () => {
      if (!confirm('移除網頁上設定的 Resend 金鑰？移除後無法寄驗證信，註冊與忘記密碼會暫停。')) return;
      const r = await withReauth(() => accountApi('/api/admin/mail/settings', { method: 'POST', body: { clearApiKey: true } }));
      if (!r.ok) { if (r.data.code !== 'REAUTH_CANCELLED') showToast(`❌ ${r.data.error || '移除失敗'}`, 'error'); return; }
      showSetupResult($('adminMailSaveResult'), '', ['已移除金鑰']);
      renderAdminMail(r.data.mail);
      fillAdminMailForm(r.data.mail);
      renderAdminSetup(r.data.setup);
      refreshAccountConfig();
    });

    $('adminTurnstileSaveBtn').addEventListener('click', async () => {
      const btn = $('adminTurnstileSaveBtn');
      const out = $('adminTurnstileSaveResult');
      const body = {};
      if (!$('adminTurnstileSiteKey').disabled) body.siteKey = $('adminTurnstileSiteKey').value.trim();
      const secret = $('adminTurnstileSecret').value.trim();
      if (secret) body.secret = secret;
      btn.disabled = true;
      showSetupResult(out, '', [secret ? '向 Cloudflare 確認 secret 中…' : '儲存中…']);
      const r = await withReauth(() => accountApi('/api/admin/turnstile/settings', { method: 'POST', body }));
      btn.disabled = false;
      if (!r.ok) {
        if (r.data.code === 'REAUTH_CANCELLED') { showSetupResult(out, '', []); return; }
        showSetupResult(out, 'error', [`❌ ${r.data.error || '儲存失敗'}`]);
        return;
      }
      const lines = ['✅ 已儲存'];
      if (r.data.secretCheck && r.data.secretCheck.state === 'valid') lines.push('Cloudflare 接受這個 secret');
      (r.data.warnings || []).forEach(w => lines.push(`⚠️ ${w}`));
      if (r.data.info.configured) lines.push('下一步：按「開始實測」親自通過一次驗證。');
      showSetupResult(out, (r.data.warnings || []).length ? '' : 'ok', lines);
      renderAdminTurnstile(r.data.info);
      fillAdminTurnstileForm(r.data.info);
      renderAdminSetup(r.data.setup);
      refreshAccountConfig();
    });

    $('adminTurnstileDisableBtn').addEventListener('click', async () => {
      if (!confirm('停用 Turnstile？之後註冊只靠隱藏欄位與次數限制擋機器人。')) return;
      const r = await withReauth(() => accountApi('/api/admin/turnstile/settings', { method: 'POST', body: { disable: true } }));
      if (!r.ok) { if (r.data.code !== 'REAUTH_CANCELLED') showToast(`❌ ${r.data.error || '停用失敗'}`, 'error'); return; }
      showSetupResult($('adminTurnstileSaveResult'), '', ['已停用 Turnstile']);
      $('adminTurnstileLiveBox').hidden = true;
      renderAdminTurnstile(r.data.info);
      fillAdminTurnstileForm(r.data.info);
      renderAdminSetup(r.data.setup);
      refreshAccountConfig();
    });

    $('adminTurnstileLiveBtn').addEventListener('click', startAdminTurnstileLiveTest);

    $('adminLegalSaveBtn').addEventListener('click', async () => {
      const major = $('adminLegalMajor').checked;
      if (major && !confirm('勾選「重大變更」後，所有已註冊的人下次登入都要重新同意。確定發布嗎？')) return;
      const r = await accountApi('/api/admin/legal', {
        method: 'POST',
        body: { privacy: $('adminLegalPrivacy').value, terms: $('adminLegalTerms').value, major }
      });
      if (r.ok) { showToast('✅ 已發布', 'success'); loadAdminLegal(); refreshAccountConfig(); }
      else showToast(`❌ ${r.data.error || '發布失敗'}`, 'error');
    });

    $('adminBackupNowBtn').addEventListener('click', async () => {
      const r = await accountApi('/api/admin/db-backups', { method: 'POST', body: {} });
      if (r.ok) { showToast(`✅ 已備份 ${r.data.backup.name}`, 'success'); renderAdminBackups(r.data.backups, { backupsEnabled: true }); }
      else showToast(`❌ ${r.data.error || '備份失敗'}`, 'error');
    });
  }

  async function refreshAccountConfig() {
    const cfg = await accountApi('/api/auth/config');
    if (cfg.ok) {
      state.account.config = cfg.data;
      updateLegalLinks();
    }
  }

  // ═══════════════════════════════════════════════════════════
  // §22 UTILITIES (escHtml, formatDate, debounce, helpers)
  // ═══════════════════════════════════════════════════════════

  function debounce(fn, delay) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  function escHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function setupSelectionPopup() {
    let popup = $('selectionSharePopup');
    if (!popup) {
      popup = document.createElement('div');
      popup.id = 'selectionSharePopup';
      popup.className = 'selection-share-popup';
      popup.innerHTML = `
        <button id="selectionSearchBtn" title="在全文庫中搜尋此文字">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
            <path fill-rule="evenodd" d="M11.5 7a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0zm-.82 4.74a6 6 0 111.06-1.06l3.04 3.04a.75.75 0 11-1.06 1.06l-3.04-3.04z"/>
          </svg>
          <span>全文庫搜尋</span>
        </button>
        <div class="popup-divider"></div>
        <button id="selectionDictBtn" title="在辭典中查詢此詞條">
          <svg width="13" height="13" viewBox="0 0 512 512" fill="currentColor">
            <path d="M448 360V24c0-13.3-10.7-24-24-24H96C43 0 0 43 0 96v320c0 53 43 96 96 96h328c13.3 0 24-10.7 24-24v-16c0-7.5-3.5-14.3-8.9-18.7-4.2-15.4-4.2-59.3 0-74.7 5.4-4.3 8.9-11.1 8.9-18.6zM128 134c0-3.3 2.7-6 6-6h212c3.3 0 6 2.7 6 6v20c0 3.3-2.7 6-6 6H134c-3.3 0-6-2.7-6-6v-20zm0 64c0-3.3 2.7-6 6-6h212c3.3 0 6 2.7 6 6v20c0 3.3-2.7 6-6 6H134c-3.3 0-6-2.7-6-6v-20z"/>
          </svg>
          <span>辭典查詢</span>
        </button>
        <div class="popup-divider"></div>
        <button id="selectionShareBtn" title="分享此段落與行數">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
            <path d="M11 2.5a2.5 2.5 0 11.603 1.628l-6.718 3.12a2.499 2.499 0 010 1.504l6.718 3.12a2.5 2.5 0 11-.488.928L4.397 9.77a2.5 2.5 0 110-3.54l6.718-3.12A2.499 2.499 0 0111 2.5z"/>
          </svg>
          <span id="selectionShareLabel">分享指定行</span>
        </button>
      `;
      document.body.appendChild(popup);
    }

    const searchBtn = $('selectionSearchBtn');
    const dictBtn = $('selectionDictBtn');
    const shareBtn = $('selectionShareBtn');
    const shareLabel = $('selectionShareLabel');
    let currentShareUrl = '';
    let currentLineNum = null;
    // 簡體顯示時盡量還原成繁體原文，搜尋框與網址顯示的就是經文原字；
    // 無法還原時保留畫面上的簡體字，由字組比對涵蓋。
    let currentSelectedText = '';

    // 觸發來源：桌機滑鼠放開走 mouseup；手機長按選字、拖曳選取把手時頁面
    // 收不到可靠的 mouseup（iOS 拖把手連 touch 事件都沒有），改由 selectionchange
    // 去抖觸發，touchend 為備援。三者共用同一個計時器，不會重複計算。
    const SELECTION_MOUSE_DELAY = 50;
    const SELECTION_CHANGE_DELAY = 300;
    const SELECTION_TOUCH_DELAY = 400;
    let selectionTimer = null;
    let mouseSelecting = false;      // 滑鼠按住拖曳中，交給 mouseup 處理
    let lastInputWasTouch = false;   // 觸控時彈窗放在選取下方，避開系統選單
    let popupTouchGuardUntil = 0;    // 點彈窗按鈕時選取可能先被清掉，暫緩隱藏

    const hidePopup = () => popup.classList.remove('visible');
    const scheduleSelectionCheck = (delay) => {
      clearTimeout(selectionTimer);
      selectionTimer = setTimeout(updateSelectionPopup, delay);
    };

    function updateSelectionPopup() {
      selectionTimer = null;
      const selection = window.getSelection();
      const text = selection ? selection.toString().trim() : '';

      if (!text || !state.currentFile || selection.rangeCount === 0) {
        if (Date.now() >= popupTouchGuardUntil) hidePopup();
        return;
      }

      // Check if the selection is inside markdownBody
      const range = selection.getRangeAt(0);
      const container = $('markdownBody');
      if (!container || !container.contains(range.commonAncestorContainer)) {
        hidePopup();
        return;
      }

      // Get the line number of the start of selection
      const lineNum = getSelectionLineNumber(selection);
      if (!lineNum) {
        hidePopup();
        return;
      }

      currentSelectedText = text;
      const ds = window.mdDisplayScript;
      if (isHansDisplay() && ds && ds.isActive()) {
        const orig = ds.originalTextOfRange(range);
        if (orig && orig.trim()) currentSelectedText = orig.trim();
      }
      currentLineNum = lineNum;

      // Show popup
      popup.classList.toggle('touch', lastInputWasTouch);
      popup.classList.add('visible');

      const popupWidth = popup.offsetWidth || 280;
      const popupHeight = popup.offsetHeight || 34;
      const rect = range.getBoundingClientRect();
      const rects = range.getClientRects();
      const firstRect = rects.length ? rects[0] : rect;
      const lastRect = rects.length ? rects[rects.length - 1] : rect;

      // 可見範圍以 visualViewport 為準（手機雙指放大時 innerWidth 不等於可見寬度）
      const vv = window.visualViewport;
      const viewLeft = vv ? vv.offsetLeft : 0;
      const viewTop = vv ? vv.offsetTop : 0;
      const viewWidth = vv ? vv.width : window.innerWidth;
      const viewHeight = vv ? vv.height : window.innerHeight;

      let top;
      let left;
      if (lastInputWasTouch) {
        // iOS／Android 的原生選單都在選取上方，彈窗放在最後一行下方，
        // 並留出選取把手的高度；下方不夠時才放到第一行上方。
        const HANDLE_GAP = 28;
        top = lastRect.bottom + HANDLE_GAP;
        left = lastRect.left + lastRect.width / 2 - popupWidth / 2;
        if (top + popupHeight > viewTop + viewHeight - 8) {
          top = firstRect.top - popupHeight - HANDLE_GAP;
        }
      } else {
        // Right above the selection; flip below when there is no room
        top = rect.top - popupHeight - 8;
        left = rect.left + rect.width / 2 - popupWidth / 2;
        if (top < viewTop + 8) top = rect.bottom + 8;
      }

      if (left < viewLeft + 10) left = viewLeft + 10;
      if (left + popupWidth > viewLeft + viewWidth - 10) {
        left = Math.max(viewLeft + 10, viewLeft + viewWidth - popupWidth - 10);
      }
      top = Math.max(viewTop + 4, Math.min(top, viewTop + viewHeight - popupHeight - 4));

      popup.style.top = `${Math.max(0, top + window.scrollY)}px`;
      popup.style.left = `${Math.max(0, left + window.scrollX)}px`;

      // Update share link using unencoded Chinese URL
      const baseUrl = window.location.origin + window.location.pathname;
      const cleanFile = state.currentFile.split('&').join('%26').split('#').join('%23');
      currentShareUrl = `${baseUrl}?file=${cleanFile}&line=${lineNum}`;

      // Reset label
      shareLabel.textContent = `分享第 ${lineNum} 行`;
      shareBtn.classList.remove('copied');
    }

    document.addEventListener('pointerdown', (e) => {
      if (popup.contains(e.target)) return;
      lastInputWasTouch = e.pointerType === 'touch' || e.pointerType === 'pen';
      mouseSelecting = e.pointerType === 'mouse' && e.button === 0;
    }, true);

    document.addEventListener('mouseup', () => {
      mouseSelecting = false;
      // Small timeout to let selection clear/update
      scheduleSelectionCheck(lastInputWasTouch ? SELECTION_TOUCH_DELAY : SELECTION_MOUSE_DELAY);
    });

    document.addEventListener('touchend', (e) => {
      if (popup.contains(e.target)) return;
      lastInputWasTouch = true;
      mouseSelecting = false;
      scheduleSelectionCheck(SELECTION_TOUCH_DELAY);
    }, { passive: true });

    document.addEventListener('selectionchange', () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        clearTimeout(selectionTimer);
        selectionTimer = null;
        if (Date.now() >= popupTouchGuardUntil) hidePopup();
        return;
      }
      if (mouseSelecting) return;
      // 選取仍在變動（拖曳把手中）：先藏起來，停手後再依新位置顯示
      if (!shareBtn.classList.contains('copied')) hidePopup();
      scheduleSelectionCheck(SELECTION_CHANGE_DELAY);
    });

    // 觸碰彈窗按鈕時，系統可能在 click 前先清掉選取；暫緩隱藏讓 click 能送達
    popup.addEventListener('touchstart', () => {
      popupTouchGuardUntil = Date.now() + 800;
    }, { passive: true });

    // Prevent selection from clearing when clicking the popup button
    popup.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    // 1. 全文庫搜尋按鈕
    searchBtn.addEventListener('click', () => {
      if (!currentSelectedText) return;
      popup.classList.remove('visible');

      let rawSelected = (currentSelectedText || '').trim();
      rawSelected = rawSelected.replace(/^[「『（("“'‘【《〈`*=_~#\s]+|[」』）)"”'’】》〉`*=_~#\s，、。；：！？!?.,;:]+$/g, '').trim();
      const searchInput = $('globalSearchInput');
      if (searchInput) searchInput.focus();
      activateSearchPanel(rawSelected);
    });

    // 2. 辭典查詢按鈕
    dictBtn.addEventListener('click', async () => {
      if (!currentSelectedText) return;
      const selectedText = currentSelectedText; // capture before popup hides
      popup.classList.remove('visible');

      // Enable dictionary and open right sidebar
      if (!state.dictionaryEnabled) {
        state.dictionaryEnabled = true;
        syncDictToggleVisibility();
      }
      toggleDictSidebar(true);

      // Ensure dict headwords are loaded before searching
      await ensureDictHeadwords();

      let rawSelected = (selectedText || '').trim();
      rawSelected = rawSelected.replace(/^[「『（("“'‘【《〈`*=_~#\s]+|[」』）)"”'’】》〉`*=_~#\s，、。；：！？!?.,;:]+$/g, '').trim();
      const dictInput = $('dictSearchInput');
      if (dictInput) {
        dictInput.value = rawSelected;
        dictInput.focus();
      }
      runDictSearch(rawSelected);
    });

    // 3. 分享指定行按鈕
    shareBtn.addEventListener('click', () => {
      if (!currentShareUrl) return;
      const rawUrl = decodeURIComponent(currentShareUrl);
      // Capture now: the async clipboard path below runs after the user may have
      // selected another line, and the toast must name the line actually copied.
      const shareLineNum = currentLineNum;

      // Update address bar to unencoded Chinese URL with line number
      if (state.currentFile && currentLineNum) {
        const cleanFile = state.currentFile.split('&').join('%26').split('#').join('%23');
        const searchStr = `?file=${cleanFile}&line=${currentLineNum}`;
        history.pushState(null, '', window.location.pathname + searchStr);
        scrollToLine(currentLineNum);
      }

      const doCopySuccess = () => {
        shareLabel.textContent = '✓ 已複製';
        shareBtn.classList.add('copied');
        showToast(`✓ 已複製第 ${shareLineNum} 行分享連結`, 'success');
        setTimeout(() => {
          popup.classList.remove('visible');
        }, 1500);
      };

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(rawUrl).then(doCopySuccess).catch(() => {
          if (fallbackCopy(rawUrl)) doCopySuccess(); else showToast('❌ 複製失敗', 'error');
        });
      } else {
        if (fallbackCopy(rawUrl)) doCopySuccess(); else showToast('❌ 複製失敗', 'error');
      }
    });

    // Close popup on mousedown anywhere else
    document.addEventListener('mousedown', (e) => {
      if (!popup.contains(e.target)) {
        popup.classList.remove('visible');
      }
    });
  }

  function getSelectionLineNumber(selection) {
    if (!selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    const startContainer = range.startContainer;
    
    if (cachedLineAnchors.length === 0) return null;
    
    let low = 0;
    let high = cachedLineAnchors.length - 1;
    let bestAnchor = null;

    // Binary search to find the closest preceding or containing anchor in O(log N) comparisons
    while (low <= high) {
      const mid = (low + high) >> 1;
      const anchor = cachedLineAnchors[mid];
      const rel = anchor.compareDocumentPosition(startContainer);
      
      if (anchor === startContainer || 
          (rel & Node.DOCUMENT_POSITION_CONTAINED_BY) || 
          (rel & Node.DOCUMENT_POSITION_FOLLOWING)) {
        bestAnchor = anchor;
        low = mid + 1; // Look for a closer preceding anchor
      } else {
        high = mid - 1; // Anchor is after the selection start point
      }
    }
    
    return bestAnchor ? parseInt(bestAnchor.getAttribute('data-line')) : null;
  }

  // ═══════════════════════════════════════════════════════════
  // §23 BOOT ENTRY (DOMContentLoaded → init)
  // ═══════════════════════════════════════════════════════════
  document.addEventListener('DOMContentLoaded', init);
})();
