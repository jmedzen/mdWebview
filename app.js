/* ================================================================
   mdWebview — Application Logic
   Tree · Viewer · Search · Theme · FontSize
   ================================================================ */

(function () {
  'use strict';

  const appConfig = window.__APP_CONFIG__ || {};
  const userFont = localStorage.getItem('mdWebview-user-fontsize');
  const userTheme = localStorage.getItem('mdWebview-user-theme');
  const userAlign = localStorage.getItem('mdWebview-user-textalign');
  const userLineHeight = localStorage.getItem('mdWebview-user-lineheight');
  const userMaxWidth = localStorage.getItem('mdWebview-user-maxwidth');
  const userReadProgress = localStorage.getItem('mdWebview-user-readprogress');

  function safeJsonParse(key, fallback) {
    try {
      const item = localStorage.getItem(key);
      if (!item) return fallback;
      const parsed = JSON.parse(item);
      return Array.isArray(parsed) ? parsed : fallback;
    } catch (_) {
      return fallback;
    }
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

  // ── State ─────────────────────────────────────────────────
  const state = {
    currentFile: null,
    currentTheme: userTheme || appConfig.defaultTheme || 'obsidian-dark',
    defaultFontSize: appConfig.defaultFontSize ? parseInt(appConfig.defaultFontSize) : 16,
    fontSize: userFont ? parseInt(userFont) : (appConfig.defaultFontSize ? parseInt(appConfig.defaultFontSize) : 16),
    textAlign: userAlign || (isMobile ? 'left' : 'justify'),
    lineHeight: userLineHeight || '1.8',
    maxWidth: userMaxWidth || (isMobile ? '100%' : '800px'),
    autoReadProgress: userReadProgress !== 'false',
    isMobile: isMobile,
    recentFiles: safeJsonParse('mdWebview-user-recentfiles', []),
    bookmarks: safeJsonParse('mdWebview-user-bookmarks', []),
    sidebarTab: 'files',
    sidebarCollapsed: false,
    treeData: null,
    pageSearchMatches: [],
    pageSearchIndex: -1,
    scrollSpyObserver: null,
    adminToken: localStorage.getItem('mdWebview-admin-token') || null,
    siteName: appConfig.siteName || 'mdWebview',
    fileSort: 'name-asc',
    searchSort: 'relevance',
    lastSearchData: null,
    fileSizes: new Map(),
    virtual: null,
    pageSearchQuery: null,
  };

  // Files at/above this byte size use virtualized rendering (must match server LARGE_FILE_MIN_BYTES).
  const LARGE_FILE_MIN_BYTES = 1048576;

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

  // ── Init ──────────────────────────────────────────────────
  async function init() {
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
      }
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

    updateWelcomeShortcuts();
    updateWelcomeFooter(appConfig);
    setupEventListeners();
    await loadTree();
    fetchSuggestList(); // Load recommend & hot list for homepage

    // Open file from URL query or hash on first load; if home/frontpage specified, show welcome screen; if none, attempt restoring last read progress
    const urlInfo = getFileFromURL();
    if (urlInfo && urlInfo.isHome) {
      goHome(false);
    } else if (urlInfo && urlInfo.file) {
      await openFile(urlInfo.file, urlInfo.line);
    } else {
      restoreReadProgress();
    }

    // Handle browser back / forward
    const handleUrlChange = async () => {
      const info = getFileFromURL();
      if (info && info.isHome) {
        goHome(false);
      } else if (info && info.file && info.file !== state.currentFile) {
        await openFile(info.file, info.line);
      } else if (info && info.line) {
        // Same file, different line
        scrollToLine(info.line);
      }
    };
    window.addEventListener('hashchange', handleUrlChange);
    window.addEventListener('popstate', handleUrlChange);
  }

  function getFileFromURL() {
    const searchParams = new URLSearchParams(window.location.search);
    
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
      const match = window.location.search.match(/[?&]file=([^&]+)/);
      if (match) searchFile = match[1];
    }
    if (searchFile) {
      searchFile = decodeURIComponent(searchFile);
      const searchLine = searchParams.get('line') ? parseInt(searchParams.get('line')) : null;
      const searchQuery = searchParams.get('q') || searchParams.get('query') || null;
      return { file: searchFile, line: searchLine, query: searchQuery };
    }

    // 2. Fallback to hash (backwards compatibility)
    const hash = window.location.hash;
    if (hash.startsWith('#file=')) {
      try {
        const params = new URLSearchParams(hash.slice(1));
        const file = params.get('file');
        const line = params.get('line') ? parseInt(params.get('line')) : null;
        return file ? { file: decodeURIComponent(file), line } : null;
      } catch (e) {
        return null;
      }
    }
    if (hash === '#home' || hash === '#frontpage') {
      return { isHome: true };
    }

    return null;
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

  function highlightLineKeyword(anchorEl, query) {
    if (!anchorEl || !query || typeof query !== 'string') return;
    const terms = query.trim().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return;

    const regexPattern = terms.map(t => escRegex(t)).join('|');
    if (!regexPattern) return;
    const regex = new RegExp(`(${regexPattern})`, 'gi');

    const lineTextNodes = [];

    function collectTextNodes(node) {
      let curr = node;
      while (curr) {
        if (curr !== anchorEl && curr.nodeType === 1 && curr.classList.contains('line-anchor')) {
          return false;
        }
        if (curr.nodeType === 3) {
          if (curr.nodeValue && curr.nodeValue.length > 0) {
            lineTextNodes.push(curr);
          }
        } else if (curr.nodeType === 1 && curr !== anchorEl) {
          if (!curr.classList.contains('line-anchor')) {
            const shouldContinue = collectTextNodes(curr.firstChild);
            if (!shouldContinue) return false;
          }
        }
        curr = curr.nextSibling;
      }
      return true;
    }

    collectTextNodes(anchorEl.nextSibling);

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

        lastIdx = matchStart + matchText.length;
      }

      if (lastIdx < val.length) {
        fragment.appendChild(document.createTextNode(val.substring(lastIdx)));
      }

      if (textNode.parentNode) {
        textNode.parentNode.replaceChild(fragment, textNode);
      }
    });
  }

  function scrollToLine(lineNum, highlightQuery) {
    clearLineKeywordHighlights();
    if (!lineNum) return;

    if (isVirtualMode()) {
      scrollToLineVirtual(lineNum, highlightQuery);
      return;
    }

    // Try exact line anchor first
    let target = document.getElementById('L' + lineNum);
    if (!target) {
      // Find nearest line anchor using binary search on cachedLineAnchors
      if (!cachedLineAnchors.length) return;
      let low = 0;
      let high = cachedLineAnchors.length - 1;
      let best = cachedLineAnchors[0];
      let bestDiff = Math.abs(parseInt(best.dataset.line || 0) - lineNum);

      while (low <= high) {
        const mid = (low + high) >> 1;
        const el = cachedLineAnchors[mid];
        const n = parseInt(el.dataset.line || 0);
        const diff = Math.abs(n - lineNum);
        
        if (diff < bestDiff) {
          bestDiff = diff;
          best = el;
        }
        
        if (n === lineNum) {
          best = el;
          break;
        } else if (n < lineNum) {
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      target = best;
    }
    if (target) {
      safeScrollToElement(target, $('content'), 'start');
      // Brief highlight on the parent block
      const block = target.nextElementSibling || target.parentElement;
      if (block) {
        block.classList.add('line-highlight');
        setTimeout(() => block.classList.remove('line-highlight'), 2500);
      }
      if (highlightQuery) {
        highlightLineKeyword(target, highlightQuery);
      }
    }
  }

  // ── Admin Status Checker ──
  async function checkAdminStatus() {
    try {
      const headers = {};
      if (state.adminToken) {
        headers['X-Admin-Token'] = state.adminToken;
      }
      const res = await fetch('/api/admin/status', { headers });
      if (!res.ok) throw new Error('Status check failed');
      const data = await res.json();
      
      // If admin is not set, force show setup overlay
      if (!data.isSetup) {
        $('adminSetupOverlay').style.display = 'flex';
      } else {
        $('adminSetupOverlay').style.display = 'none';
      }

      // If token is invalid according to server, clear it
      if (!data.isAuthenticated) {
        state.adminToken = null;
        localStorage.removeItem('mdWebview-admin-token');
      }

      // Clean legacy contaminated keys from older versions
      localStorage.removeItem('mdWebview-fontsize');
      localStorage.removeItem('mdWebview-theme');

      // If client doesn't have custom user font size / theme settings saved in localStorage,
      // load default settings configured by the server.
      if (data.settings) {
        if (data.settings.defaultFontSize) {
          state.defaultFontSize = parseInt(data.settings.defaultFontSize);
        }
        const userSavedFont = localStorage.getItem('mdWebview-user-fontsize');
        if (userSavedFont) {
          applyFontSize(parseInt(userSavedFont), true);
        } else if (data.settings.defaultFontSize) {
          applyFontSize(data.settings.defaultFontSize, false);
        }

        const userSavedTheme = localStorage.getItem('mdWebview-user-theme');
        if (userSavedTheme) {
          applyTheme(userSavedTheme, true);
        } else if (data.settings.defaultTheme) {
          applyTheme(data.settings.defaultTheme, false);
        }

        if (data.settings.siteName) {
          state.siteName = data.settings.siteName;
          updateSiteNameUI();
        }

        updateWelcomeFooter(data.settings);
      }
    } catch (err) {
      console.error('Error checking admin status:', err);
      showToast('❌ 後台狀態載入失敗', 'error');
    }
  }

  function updateSiteNameUI() {
    $$('.logo-text').forEach(el => el.textContent = state.siteName);
    $$('.welcome-title').forEach(el => el.textContent = state.siteName);

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

    const parts = [];
    if (isVersionEnabled && settings.version && String(settings.version).trim()) {
      parts.push(`<span>版本：${escHtml(String(settings.version).trim())}</span>`);
    }
    if (isDownloadEnabled && settings.downloadUrl && String(settings.downloadUrl).trim()) {
      parts.push(`<span>下載：<a href="${escHtml(String(settings.downloadUrl).trim())}" target="_blank" rel="noopener noreferrer" class="welcome-download-link">離線閱讀完整版</a></span>`);
    }

    if (parts.length > 0) {
      footerEl.innerHTML = parts.join('<span class="welcome-footer-sep">·</span>');
      footerEl.style.display = 'flex';
    } else {
      footerEl.innerHTML = '';
      footerEl.style.display = 'none';
    }
  }
  // ── Go Home: close reader, return to welcome screen ────────
  function goHome(clearUrl = true) {
    state.currentFile = null;

    // Release any virtualized document and full-render scroll-spy observer so
    // returning home doesn't pin a large file's index, TOC rows, or headings.
    teardownVirtual();
    disconnectScrollSpy();
    headingTextMap.clear();
    cachedLineAnchors = [];

    const welcome = $('welcomeScreen');
    const wrapper = $('contentWrapper');
    const loading = $('contentLoading');

    if (welcome) welcome.style.display = 'flex';
    if (wrapper) wrapper.style.display = 'none';
    if (loading) loading.style.display = 'none';

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
  // SUGGEST LIST (Homepage Recommend & Hot)
  // ═══════════════════════════════════════════════════════════

  async function fetchSuggestList() {
    try {
      const res = await fetch('/api/suggest-list');
      if (!res.ok) return;
      const data = await res.json();
      const items = data.items || [];
      state._cachedSuggestItems = items;
      renderSuggestList(items, data.enabled !== false);
    } catch (_) {}
  }

  function resolveSuggestPath(rawPath) {
    if (!rawPath) return '';
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

      const icon = document.createElement('span');
      icon.className = 'suggest-item-icon';
      icon.textContent = item.type === 'hot' ? '✨' : '🪷';

      const name = document.createElement('span');
      name.className = 'suggest-item-name';
      name.textContent = item.fileName || item.path;

      const badge = document.createElement('span');
      badge.className = 'suggest-item-badge ' + (item.type === 'hot' ? 'suggest-badge-hot' : 'suggest-badge-admin');
      badge.textContent = item.type === 'hot' ? '熱門' : '推薦';

      li.appendChild(icon);
      li.appendChild(name);
      li.appendChild(badge);

      li.addEventListener('click', () => {
        const pathToOpen = resolveSuggestPath(item.path);
        if (pathToOpen) {
          openFile(pathToOpen);
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
  // TREE VIEW
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
      container.innerHTML = '';
      const sorted = sortTreeNodes(state.treeData, state.fileSort);
      renderTreeNodes(sorted, container, 0);
    } catch (err) {
      container.innerHTML = `<div class="panel-placeholder"><span class="placeholder-icon">⚠️</span><span>載入失敗: ${escHtml(err.message)}</span></div>`;
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

  function renderTreeNodes(nodes, container, level) {
    if (!Array.isArray(nodes) || !container) return;
    nodes.forEach((node, idx) => {
      const item = document.createElement('div');
      item.className = 'tree-item';

      if (node.type === 'directory') {
        item.innerHTML = `
          <div class="tree-item-row tree-folder" style="padding-left:${8 + level * 16}px" data-path="${escHtml(node.path)}">
            <span class="tree-chevron">›</span>
            <span class="tree-icon">📁</span>
            <span class="tree-name">${escHtml(node.name)}</span>
            <span class="tree-file-count">${countFiles(node)}</span>
          </div>
          <div class="tree-children"></div>
        `;
        const childrenEl = item.querySelector('.tree-children');
        if (Array.isArray(node.children)) {
          renderTreeNodes(node.children, childrenEl, level + 1);
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

      container.appendChild(item);
    });
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
        case 'modified-desc':
          // fallback to name if no mtime
          return b.name.localeCompare(a.name, 'zh-TW', { numeric: true, sensitivity: 'base' });
        case 'modified-asc':
          return a.name.localeCompare(b.name, 'zh-TW', { numeric: true, sensitivity: 'base' });
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
      indicator.title = `首頁 (${escHtml(state.siteName || '大覺藏集')})`;
    } else {
      const parts = filePath.split('/');
      const fileName = parts.pop().replace(/\.md$/, '');
      const folderName = parts.length > 0 ? parts[parts.length - 1] : '';
      const displayTitle = (meta && meta.title) ? meta.title : fileName;

      let html = `<span class="active-file-icon">📄</span><span class="active-file-title">${escHtml(displayTitle)}</span>`;
      if (folderName) {
        html += `<span class="active-file-folder">[${escHtml(folderName)}]</span>`;
      }

      indicator.innerHTML = html;
      indicator.title = `當前經論: ${filePath}`;
    }
  }

  function highlightActiveFile(path, meta) {
    updateActiveFileUI(path, meta);

    $$('.tree-item-row.active').forEach((el) => el.classList.remove('active'));
    if (!path) return;

    const target = document.querySelector(`.tree-file[data-path="${CSS.escape(path)}"]`);
    if (target) {
      target.classList.add('active');
      // Expand parent folders
      let parent = target.closest('.tree-children');
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

      // Auto-scroll active file item into view in sidebar
      setTimeout(() => {
        target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }, 100);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // FILE VIEWER
  // ═══════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════
  // VIRTUALIZED LARGE-FILE RENDERING
  // ═══════════════════════════════════════════════════════════

  function isVirtualMode() {
    return !!(state.virtual && state.virtual.filePath === state.currentFile);
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
        const res = await fetch(`/api/render-chunk?path=${encodeURIComponent(v.filePath)}&from=${from}&to=${to}`);
        if (!res.ok) throw new Error('chunk load failed: ' + res.status);
        // The user may have switched files while this chunk was in flight; if the
        // virtual document we belong to is no longer current, drop the result so it
        // can't be inserted into the wrong file's body.
        if (state.virtual !== v) return null;
        const html = await res.text();
        const sectionEl = document.createElement('section');
        sectionEl.className = 'chunk';
        sectionEl.setAttribute('data-chunk', ci);
        sectionEl.setAttribute('data-from', from);
        sectionEl.setAttribute('data-to', to);
        sectionEl.innerHTML = html;
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
          showToast('⚠️ 內容片段載入失敗，請重試', 'error');
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
      const h = v.chunkHeights.get(ci) || 0;
      if (!data || h <= 0) continue;
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

  function nearestCachedAnchor(lineNum) {
    if (!cachedLineAnchors.length) return null;
    let best = cachedLineAnchors[0], bestDiff = Infinity;
    for (const a of cachedLineAnchors) {
      const n = parseInt(a.dataset.line || '0', 10);
      const d = Math.abs(n - lineNum);
      if (d < bestDiff) { bestDiff = d; best = a; }
    }
    return best;
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
    for (let c = centerCi - radius; c <= centerCi + radius; c++) {
      if (c < 0 || c >= v.chunkRanges.length) continue;
      await ensureChunk(v.chunkRanges[c].from);
    }
    updateAvgPxPerLine();
    refreshSpacers();
    updateCachedLineAnchors($('markdownBody'));
  }

  async function scrollToLineVirtual(lineNum, highlightQuery) {
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
    if (!target) target = nearestCachedAnchor(lineNum);
    if (!target) {
      showToast(`⚠️ 找不到第 ${lineNum} 行`, 'warning');
      return;
    }

    const content = $('content');
    const targetRect = target.getBoundingClientRect();
    const containerRect = content.getBoundingClientRect();
    content.scrollTop = Math.max(0, content.scrollTop + (targetRect.top - containerRect.top) - 12);

    const block = target.nextElementSibling || target.parentElement;
    if (block) {
      block.classList.add('line-highlight');
      setTimeout(() => block.classList.remove('line-highlight'), 2500);
    }
    if (highlightQuery) highlightLineKeyword(target, highlightQuery);
    updateVirtualScrollSpy(lineNum);
  }

  async function jumpToEntry(entryIndex) {
    const v = state.virtual;
    if (!v) return;
    const line = v.entries[entryIndex] ? v.entries[entryIndex].ls : 1;
    await scrollToLineVirtual(line, null);
    if (isMobileBrowser()) {
      const sidebar = $('sidebar');
      if (sidebar && !sidebar.classList.contains('collapsed')) {
        sidebar.classList.add('collapsed');
        state.sidebarCollapsed = true;
      }
    }
  }

  function updateVirtualScrollSpy(line) {
    const v = state.virtual;
    if (!v || !v._tocRows || v._tocRows.length === 0) return;
    const ei = entryIndexForLine(line);
    const row = v._tocRows[ei];
    const prev = v._activeTocRow;
    // This runs on every scroll frame. Bail when the active entry is unchanged
    // so classList/scrollIntoView only touch the DOM at entry boundaries — doing
    // it per frame forced needless layout work during continuous scrolling.
    if (row === prev) return;
    if (prev) prev.classList.remove('active');
    if (row) {
      row.classList.add('active');
      v._activeTocRow = row;
      // Only invoked when the highlighted row actually changes; 'nearest' keeps
      // the (content-visibility) row in view without a full layout pass.
      row.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    }
  }

  // Build the TOC directly from the section index (not from DOM headings). For
  // very large files this can be tens of thousands of rows; rows use
  // `content-visibility: auto` (see style.css) so off-screen rows are cheap.
  // Tear down a virtualized (chunked) document: detach its scroll handler,
  // cancel any pending RAF, and release the large per-document structures
  // (section index, TOC rows, chunk/heights Maps) so switching to another file
  // or returning home doesn't pin them in memory for the session.
  function teardownVirtual() {
    const v = state.virtual;
    if (!v) return;
    const content = $('content');
    if (v._scrollHandler && content) content.removeEventListener('scroll', v._scrollHandler);
    if (v._scrollRaf) { cancelAnimationFrame(v._scrollRaf); v._scrollRaf = null; }
    if (v.chunks) v.chunks.clear();
    if (v.inflight) v.inflight.clear();
    if (v.errorChunks) v.errorChunks.clear();
    if (v.chunkHeights) v.chunkHeights.clear();
    if (v.headwordMap) v.headwordMap.clear();
    if (v.entryMap) v.entryMap.clear();
    v._tocRows = [];
    v.entries = null;
    v.groups = null;
    v.chunkRanges = null;
    state.virtual = null;
  }

  // Disconnect the full-render scroll-spy IntersectionObserver (if any) so it
  // stops observing the previous document's headings.
  function disconnectScrollSpy() {
    if (state.scrollSpyObserver) {
      state.scrollSpyObserver.disconnect();
      state.scrollSpyObserver = null;
    }
  }

  function renderVirtualTOC() {
    const v = state.virtual;
    const tocList = $('tocList');
    disconnectScrollSpy();
    tocList.innerHTML = '';
    const fragment = document.createDocumentFragment();
    const rows = [];
    const groupStarts = new Map();
    (v.groups || []).forEach(g => groupStarts.set(g.first, g));

    v.entries.forEach((e, i) => {
      if (groupStarts.has(i)) {
        const gr = document.createElement('div');
        gr.className = 'toc-group-row';
        gr.textContent = groupStarts.get(i).h || '';
        gr.title = gr.textContent;
        fragment.appendChild(gr);
      }
      const row = document.createElement('div');
      row.className = 'toc-item-row virtual';
      row.setAttribute('data-entry', i);
      const label = document.createElement('span');
      label.className = 'toc-item-label';
      label.textContent = e.h || '';
      label.title = e.h || '';
      row.appendChild(label);
      row.addEventListener('click', () => jumpToEntry(i));
      fragment.appendChild(row);
      rows.push(row);
    });

    if (rows.length === 0) {
      tocList.innerHTML = '<div class="panel-placeholder"><span class="placeholder-icon">📑</span><span>此文件沒有標題</span></div>';
      return;
    }

    tocList.appendChild(fragment);
    state.virtual._tocRows = rows;
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
  async function tryOpenVirtualFile(filePath, scrollToLineNum, highlightQuery) {
    const res = await fetch(`/api/section-index?path=${encodeURIComponent(filePath)}`);
    if (!res.ok) return false;
    const si = await res.json();
    if (!si || !si.large || !Array.isArray(si.entries) || si.entries.length === 0) return false;
    if (!Array.isArray(si.chunks) || si.chunks.length === 0) return false;

    const v = {
      filePath,
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
      _tocRows: [],
      _activeTocRow: null,
      _scrollHandler: null,
      _scrollRaf: null,
    };

    // Tear down any previous virtual document (large→large switch, or a prior
    // failed attempt) so its index, TOC rows and chunk Maps are released.
    teardownVirtual();
    state.virtual = v;

    si.entries.forEach((e, i) => {
      if (e.h && !v.headwordMap.has(e.h)) v.headwordMap.set(e.h, i);
      const clean = (e.h || '').replace(/^【/, '').replace(/】$/, '').trim();
      if (clean && !v.entryMap.has(clean)) v.entryMap.set(clean, i);
    });

    renderContentHeader(filePath, {});
    document.title = `${filePath.split('/').pop().replace(/\.md$/, '')} — ${state.siteName}`;

    renderVirtualTOC();
    setupVirtualScroll();

    // Spacer-based virtual scroll: a top/bottom spacer holds the pixel height of
    // all unmounted entries, so `content.scrollTop` maps to the absolute line
    // position and mounting/recycling a chunk never shifts already-visible text.
    $('markdownBody').innerHTML = '';
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
      await scrollToLineVirtual(scrollToLineNum, highlightQuery);
    } else {
      await ensureChunk(0);
      $('content').scrollTop = 0;
    }
    setTimeout(() => saveReadProgress(filePath), 350);
    return true;
  }

  async function openFile(filePath, scrollToLineNum, highlightQuery) {
    state.currentFile = filePath;
    log.info(`Opening file "${filePath}"${scrollToLineNum ? ` (Line: ${scrollToLineNum})` : ''}`);

    addRecentFile(filePath);
    updateBookmarkButtonUI(filePath);

    // If search selector is set to __CURRENT_FILE__, automatically update search results for newly opened file
    const searchFolderSelect = $('searchFolderSelect');
    if (searchFolderSelect && searchFolderSelect.value === '__CURRENT_FILE__') {
      const searchInput = $('globalSearchInput');
      if (searchInput && searchInput.value.trim()) {
        performGlobalSearch(searchInput.value.trim());
      }
    }

    // Update URL search parameters — preserve line param if provided using unencoded Chinese URL
    const cleanFile = filePath.split('&').join('%26').split('#').join('%23');
    let newSearch = `?file=${cleanFile}`;
    if (scrollToLineNum) newSearch += `&line=${scrollToLineNum}`;

    if (decodeURIComponent(window.location.search) !== decodeURIComponent(newSearch)) {
      const newUrl = window.location.pathname + newSearch;
      history.pushState(null, '', newUrl);
    }

    // Auto-collapse sidebar on mobile screens when opening a file
    if (window.innerWidth <= 768) {
      const sidebar = $('sidebar');
      if (!sidebar.classList.contains('collapsed')) {
        sidebar.classList.add('collapsed');
        state.sidebarCollapsed = true;
      }
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

    // Large files take the virtualized path (chunked render + lazy TOC) to keep the UI responsive.
    const fileSize = state.fileSizes.get(filePath) || 0;
    const forceFull = new URLSearchParams(window.location.search).get('full') === '1'
      || localStorage.getItem('mdWebview-force-full') === '1';
    if (fileSize >= LARGE_FILE_MIN_BYTES && !forceFull) {
      try {
        const handled = await tryOpenVirtualFile(filePath, scrollToLineNum, highlightQuery);
        if (handled) return;
      } catch (err) {
        console.warn('[Virtual] open failed, falling back to full render:', err);
        showToast('ℹ️ 大檔快速模式不可用，已改以全文模式開啟', 'info', 3000);
      }
    }

    // Full-render path: release any lingering virtual document and scroll-spy
    // observer from a previously opened file before rendering the new one.
    teardownVirtual();
    disconnectScrollSpy();

    try {
      // Check LRU cache first — cached files open instantly (no network at all)
      const cachedHtml = cacheGet(filePath);
      if (cachedHtml) {
        const cachedMeta = renderCache.__meta ? renderCache.__meta.get(filePath) : null;
        if (cachedMeta) renderContentHeader(filePath, cachedMeta);
        const el = $('markdownBody');
        el.innerHTML = cachedHtml;
        
        // Cache line anchors and query headings once
        updateCachedLineAnchors(el);
        const headings = Array.from(el.querySelectorAll('h1, h2, h3, h4, h5, h6'));
        headings.forEach((h, i) => { if (!h.id) h.id = 'heading-' + i; });
        
        generateTOC(headings);
        loading.style.display = 'none';
        wrapper.style.display = 'block';
        if (scrollToLineNum) setTimeout(() => scrollToLine(scrollToLineNum, highlightQuery), 80);
        else content.scrollTop = 0;
        setTimeout(() => saveReadProgress(filePath), 350);
        if (cachedMeta) {
          document.title = `${cachedMeta.title || filePath.split('/').pop().replace(/\.md$/, '')} — ${state.siteName}`;
        }
        return;
      }

      // Build fetch headers — send ETag for 304 Not Modified support
      const fetchHeaders = {};
      const cachedEtag = renderCache.__etag ? renderCache.__etag.get(filePath) : null;
      if (cachedEtag) fetchHeaders['If-None-Match'] = cachedEtag;

      // Abort any previous in-flight openFile fetch
      if (state._openFileAbort) state._openFileAbort.abort();
      const abortCtrl = new AbortController();
      state._openFileAbort = abortCtrl;

      // SSR endpoint returns raw HTML (text/html) + gzip: avoids JSON.parse overhead
      const res = await fetch(`/api/render?path=${encodeURIComponent(filePath)}&line=${scrollToLineNum || ''}`, {
        headers: fetchHeaders,
        signal: abortCtrl.signal
      });

      if (res.status === 304) {
        // Server says content unchanged — use cached HTML
        const cachedHtml = cacheGet(filePath);
        if (cachedHtml) {
          const el = $('markdownBody');
          el.innerHTML = cachedHtml;
          const cachedMeta = renderCache.__meta ? renderCache.__meta.get(filePath) : {};
          renderContentHeader(filePath, cachedMeta || {});
          
          loading.style.display = 'none';
          wrapper.style.display = 'block';
          if (scrollToLineNum) {
            setTimeout(() => scrollToLine(scrollToLineNum, highlightQuery), 80);
          } else {
            content.scrollTop = 0;
          }
          setTimeout(() => saveReadProgress(filePath), 350);
          document.title = `${(cachedMeta && cachedMeta.title) || filePath.split('/').pop().replace(/\.md$/, '')} — ${state.siteName}`;

          // Defer TOC generation & line-anchor indexing to idle time
          const scheduleIdle = window.requestIdleCallback || ((cb) => setTimeout(cb, 10));
          scheduleIdle(() => {
            updateCachedLineAnchors(el);
            const headings = Array.from(el.querySelectorAll('h1, h2, h3, h4, h5, h6'));
            headings.forEach((h, i) => { if (!h.id) h.id = 'heading-' + i; });
            generateTOC(headings);
          });
        }
        return;
      }
      if (!res.ok) throw new Error('File not found');

      // res.text() is much faster than res.json() for large HTML payloads
      const [html, metaB64, etag] = await Promise.all([
        res.text(),
        Promise.resolve(res.headers.get('X-Document-Meta') || 'e30='),
        Promise.resolve(res.headers.get('ETag') || '')
      ]);

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
      el.innerHTML = html;

      // Cache for instant re-opens
      cacheSet(filePath, html);

      // Reveal text immediately (FCP First)
      loading.style.display = 'none';
      wrapper.style.display = 'block';

      if (scrollToLineNum) {
        setTimeout(() => scrollToLine(scrollToLineNum, highlightQuery), 80);
      } else {
        content.scrollTop = 0;
      }
      setTimeout(() => saveReadProgress(filePath), 350);

      document.title = `${frontmatter.title || filePath.split('/').pop().replace(/\.md$/, '')} — ${state.siteName}`;

      // Defer TOC generation & line-anchor indexing to idle time (non-blocking)
      const scheduleIdle = window.requestIdleCallback || ((cb) => setTimeout(cb, 10));
      scheduleIdle(() => {
        updateCachedLineAnchors(el);
        const headings = Array.from(el.querySelectorAll('h1, h2, h3, h4, h5, h6'));
        headings.forEach((h, i) => { if (!h.id) h.id = 'heading-' + i; });
        generateTOC(headings);
      });
    } catch (err) {
      headingTextMap.clear();
      cachedLineAnchors = [];
      loading.style.display = 'none';
      wrapper.style.display = 'block';
      $('markdownBody').innerHTML = `<div class="panel-placeholder"><span class="placeholder-icon">⚠️</span><span>載入失敗: ${escHtml(err.message)}</span></div>`;
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
    const parts = filePath.split('/');
    const fileName = parts.pop().replace(/\.md$/, '');
    const folder = parts.join(' / ');

    let html = `<div class="file-path-row">`;
    html += `<div class="file-path">${escHtml(folder ? folder + ' / ' + fileName : fileName)}</div>`;
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
    el.innerHTML = html;

    // Add IDs to headings for scroll spy
    const headings = el.querySelectorAll('h1, h2, h3, h4, h5, h6');
    headings.forEach((h, i) => {
      if (!h.id) h.id = 'heading-' + i;
    });
  }

  function preprocessObsidianFormatting(text) {
    if (!text) return '';
    // 1. Fix Obsidian bolding with inner spaces/NBSP: ** text ** -> <strong>text</strong>
    text = text.replace(/\*\*([\s\u00A0]*[^\*\n]+?[\s\u00A0]*)\*\*/g, (m, p1) => {
      const trimmed = p1.trim().replace(/^[\s\u00A0]+|[\s\u00A0]+$/g, '');
      return '<strong>' + escHtml(trimmed) + '</strong>';
    });
    // 2. Fix Obsidian double underscore bolding: __ text __ -> <strong>text</strong>
    text = text.replace(/__([\s\u00A0]*[^_\n]+?[\s\u00A0]*)__/g, (m, p1) => {
      const trimmed = p1.trim().replace(/^[\s\u00A0]+|[\s\u00A0]+$/g, '');
      return '<strong>' + escHtml(trimmed) + '</strong>';
    });
    return text;
  }

  // Inline fallback: runs on main thread (same logic as md-worker.js)
  // Client-side mirror of the server's HTML sanitizer. Used only by the legacy
  // inline-markdown fallback (renderMarkdown → inlineParseMarkdown), which is
  // currently unreachable but kept safe in case it is ever wired back up.
  function sanitizeDangerousTags(html) {
    if (!html) return '';
    return html
      .replace(/<script\b[^>]*>[\s\S]*?(?:<\/script\s*>|$)/gi, '')
      .replace(/<\/?(?:script|iframe|embed|object|frame|frameset|style|math|form|base|meta|link|svg|video|audio|source|applet|noscript)\b[^>]*>/gi, '')
      .replace(/\bon[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '')
      .replace(/(href|src)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, (m, attr, val) => {
        const raw = /^["']/.test(val) ? val.slice(1, -1) : val;
        const decoded = raw
          .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
          .replace(/&#([0-9]+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
          .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&')
          .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
        if (/^\s*(?:javascript|vbscript)\s*:/i.test(decoded)) return attr + '="#"';
        if (attr.toLowerCase() === 'href' && /^\s*data\s*:/i.test(decoded)) return attr + '="#"';
        return m;
      });
  }

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
    let prevWasBlank = true;
    for (let i = 0; i < cleanLines.length; i++) {
      const line = cleanLines[i];
      const lineNum = i + 1;
      const trimmed = line.trim();
      const isBlockStart =
        /^#{1,6}\s/.test(trimmed) ||
        /^[-*+]\s/.test(trimmed) ||
        /^\d+\.\s/.test(trimmed) ||
        /^>/.test(trimmed) ||
        /^```/.test(trimmed) ||
        (prevWasBlank && trimmed.length > 0);
      if (isBlockStart) {
        annotatedLines.push(`<span id="L${lineNum}" data-line="${lineNum}" class="line-anchor"></span>`);
      }
      annotatedLines.push(line);
      prevWasBlank = trimmed.length === 0;
    }

    // ── 3. Parse main markdown body to HTML ─────────────────────
    let html = marked.parse(annotatedLines.join('\n'));
    html = sanitizeDangerousTags(html);

    // ── 4. Convert Obsidian-style [[wikilinks]] on HTML output ────
    if (html.includes('[[')) {
      html = convertWikilinks(html);
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
      let combinedFnHtml = marked.parse(combinedFnText).trim();
      combinedFnHtml = sanitizeDangerousTags(combinedFnHtml);
      if (combinedFnHtml.includes('[[')) {
        combinedFnHtml = convertWikilinks(combinedFnHtml);
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
  // OBSIDIAN WIKILINK SUPPORT
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
      }

      return `<a class="wikilink" data-wikilink-file="${escHtml(file)}" data-wikilink-anchor="${escHtml(anchor)}" href="javascript:void(0)" title="${escHtml(target)}">${escHtml(display)}</a>`;
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

      const clone = h.cloneNode(true);
      clone.querySelectorAll('.line-anchor').forEach(el => el.remove());
      const rawText = clone.textContent.trim();
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
  // TABLE OF CONTENTS
  // ═══════════════════════════════════════════════════════════

  function generateTOC(headings) {
    const tocList = $('tocList');
    headings = headings || $$('h1, h2, h3, h4, h5, h6', $('markdownBody'));

    // Filter valid headings & extract clean text (stripping .line-anchor spans)
    const validItems = [];
    headings.forEach((h) => {
      const clone = h.cloneNode(true);
      clone.querySelectorAll('.line-anchor').forEach(el => el.remove());
      const text = clone.textContent.trim();
      if (text) {
        validItems.push({ h, text, level: parseInt(h.tagName.charAt(1)) });
      }
    });

    if (validItems.length === 0) {
      tocList.innerHTML = '<div class="panel-placeholder"><span class="placeholder-icon">📑</span><span>此文件沒有標題</span></div>';
      return;
    }

    tocList.innerHTML = '';

    const minLevel = Math.min(...validItems.map(item => item.level));
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

      row.addEventListener('click', (e) => {
        if (e.target === chevron && !chevron.classList.contains('empty')) {
          e.stopPropagation();
          const isCollapsed = row.classList.toggle('collapsed');
          toggleSubtreeVisibility(rows, idx, isCollapsed);
        } else {
          safeScrollToElement(h, $('content'), 'start');
          if (isMobileBrowser()) {
            const sidebar = $('sidebar');
            if (sidebar && !sidebar.classList.contains('collapsed')) {
              sidebar.classList.add('collapsed');
              state.sidebarCollapsed = true;
            }
          }
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
      }
    }

    tocList.appendChild(fragment);
    setupScrollSpy(validItems.map(item => item.h));
  }

  function toggleSubtreeVisibility(rows, parentIdx, isCollapsed) {
    const parentLevel = parseInt(rows[parentIdx].getAttribute('data-level'));
    for (let i = parentIdx + 1; i < rows.length; i++) {
      const curLevel = parseInt(rows[i].getAttribute('data-level'));
      if (curLevel <= parentLevel) break; // End of subtree

      if (isCollapsed) {
        rows[i].classList.add('is-hidden');
      } else {
        rows[i].classList.remove('is-hidden');
        if (rows[i].classList.contains('collapsed')) {
          const childLevel = parseInt(rows[i].getAttribute('data-level'));
          while (i + 1 < rows.length && parseInt(rows[i + 1].getAttribute('data-level')) > childLevel) {
            i++;
            rows[i].classList.add('is-hidden');
          }
        }
      }
    }
  }

  function tocCollapseAll() {
    const btn = $('tocCollapseAllBtn');
    const rows = $$('.toc-item-row', $('tocList'));
    if (rows.length === 0) return;

    const anyCollapsed = Array.from(rows).some(el => el.classList.contains('collapsed'));

    if (anyCollapsed) {
      // Expand all
      rows.forEach(r => {
        r.classList.remove('collapsed');
        r.classList.remove('is-hidden');
      });
      updateCollapseBtnUI(btn, true);
    } else {
      // Collapse top parents
      const minLevel = Math.min(...Array.from(rows).map(r => parseInt(r.getAttribute('data-level'))));
      rows.forEach(r => {
        const level = parseInt(r.getAttribute('data-level'));
        if (level === minLevel) {
          const chev = r.querySelector('.toc-item-chevron');
          if (chev && !chev.classList.contains('empty')) {
            r.classList.add('collapsed');
          }
        } else {
          r.classList.add('is-hidden');
        }
      });
      updateCollapseBtnUI(btn, false);
    }
  }

  function setupScrollSpy(headings) {
    if (state.scrollSpyObserver) {
      state.scrollSpyObserver.disconnect();
    }

    const tocList = $('tocList');
    const tocItems = $$('.toc-item-row', tocList);
    if (tocItems.length === 0) return;

    headings = headings || $$('h1, h2, h3, h4, h5, h6', $('markdownBody'));

    const tocMap = new Map();
    tocItems.forEach((item) => {
      const target = item.getAttribute('data-target');
      if (target) tocMap.set(target, item);
    });

    let currentActiveItem = tocList.querySelector('.toc-item-row.active');
    let scrollIntoViewTimeout = null;

    const observer = new IntersectionObserver(
      (entries) => {
        let lastIntersectingId = null;
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            lastIntersectingId = entry.target.id;
          }
        });

        if (lastIntersectingId) {
          const nextActiveItem = tocMap.get(lastIntersectingId);
          if (nextActiveItem && nextActiveItem !== currentActiveItem) {
            if (currentActiveItem) {
              currentActiveItem.classList.remove('active');
            }
            nextActiveItem.classList.add('active');
            currentActiveItem = nextActiveItem;

            if (scrollIntoViewTimeout) {
              clearTimeout(scrollIntoViewTimeout);
            }
            scrollIntoViewTimeout = setTimeout(() => {
              nextActiveItem.scrollIntoView({ block: 'nearest', behavior: 'auto' });
            }, 50);
          }
        }
      },
      {
        root: $('content'),
        rootMargin: '-48px 0px -70% 0px',
        threshold: 0,
      }
    );

    headings.forEach((h) => observer.observe(h));
    state.scrollSpyObserver = observer;
  }

  // ═══════════════════════════════════════════════════════════
  // GLOBAL SEARCH
  // ═══════════════════════════════════════════════════════════

  let searchAbortController = null;

  async function performGlobalSearch(query) {
    if (!query || query.trim().length === 0) {
      $('searchResults').innerHTML = '<div class="panel-placeholder"><span class="placeholder-icon">🔍</span><span>輸入關鍵詞開始搜尋</span></div>';
      return;
    }

    let folder = $('searchFolderSelect') ? $('searchFolderSelect').value : '';

    if (folder === '__CURRENT_FILE__') {
      if (!state.currentFile) {
        $('searchResults').innerHTML = '<div class="panel-placeholder"><span class="placeholder-icon">📄</span><span>目前尚未開啟任何經文檔案</span></div>';
        return;
      }
      folder = state.currentFile;
    }

    if (searchAbortController) searchAbortController.abort();
    searchAbortController = new AbortController();

    $('searchResults').innerHTML = '<div class="search-loading"><div class="spinner"></div><span>搜尋中…</span></div>';

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&folder=${encodeURIComponent(folder)}`, {
        signal: searchAbortController.signal,
      });
      if (!res.ok) throw new Error('Search failed');
      const data = await res.json();
      renderSearchResults(data);
    } catch (err) {
      if (err.name === 'AbortError') return;
      $('searchResults').innerHTML = `<div class="panel-placeholder"><span class="placeholder-icon">⚠️</span><span>搜尋失敗: ${escHtml(err.message)}</span></div>`;
    }
  }

  function renderSearchResults(data) {
    const container = $('searchResults');
    state.lastSearchData = data;

    if (data.results.length === 0) {
      container.innerHTML = '<div class="panel-placeholder"><span class="placeholder-icon">🔍</span><span>沒有找到結果</span></div>';
      return;
    }

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
    const terms = rawQuery.trim().split(/\s+/).filter(Boolean);
    const escapedTerms = terms.map(t => escRegex(escHtml(t)));
    const precompiledRegex = escapedTerms.length > 0 ? new RegExp(`(${escapedTerms.join('|')})`, 'gi') : null;

    for (const [file, group] of sortedGroups) {
      parts.push(`<div class="search-result-group">`);
      parts.push(`<div class="search-result-file" data-file-group="${escHtml(file)}">`);
      parts.push(`<span class="search-result-file-chevron expanded">›</span>`);
      parts.push(`<span class="search-result-file-icon">📄</span>${escHtml(group.fileName)}`);
      parts.push(`<span class="search-result-count">${group.items.length}</span></div>`);
      parts.push(`<div class="search-result-group-body">`);
      group.items.forEach((item) => {
        const snippet = highlightSearchTerm(item.snippet, precompiledRegex);
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
      });
      parts.push(`</div></div>`);
    }

    container.innerHTML = parts.join('');
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

  function highlightSearchTerm(text, compiledRegexOrQuery) {
    const escaped = escHtml(text);
    if (!compiledRegexOrQuery) return escaped;

    let regex;
    if (compiledRegexOrQuery instanceof RegExp) {
      regex = compiledRegexOrQuery;
    } else {
      const queryEscaped = escHtml(compiledRegexOrQuery);
      regex = new RegExp(`(${escRegex(queryEscaped)})`, 'gi');
    }
    return escaped.replace(regex, '<mark>$1</mark>');
  }

  // ═══════════════════════════════════════════════════════════
  // PAGE SEARCH (In-page)
  // ═══════════════════════════════════════════════════════════

  function openPageSearch() {
    const bar = $('pageSearchBar');
    bar.classList.add('visible');
    const input = $('pageSearchInput');
    input.focus();
    input.select();
  }

  function closePageSearch() {
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

    if (!query || query.trim().length === 0) {
      $('pageSearchCount').textContent = '';
      return;
    }

    if (isVirtualMode()) {
      await doPageSearchVirtual(query.trim());
      return;
    }

    const body = $('markdownBody');
    if (!body || !body.textContent) return;

    const matches = highlightTextNodes(body, query);
    state.pageSearchMatches = matches;

    if (matches.length > 0) {
      state.pageSearchIndex = 0;
      matches[0].classList.add('active');
      safeScrollToElement(matches[0], $('content'), 'center');
    } else {
      showToast(`🔍 未找到符合「${query}」的內容`, 'warning');
    }

    $('pageSearchCount').textContent = matches.length > 0 ? `1/${matches.length}` : '0/0';
  }

  // Server-side in-page search for virtualized files: covers the whole document
  // (not just the ~7 mounted chunks). Returns matches [{ line, entryIndex, headword, snippet }].
  async function doPageSearchVirtual(query) {
    const v = state.virtual;
    if (!v) return;
    state.pageSearchQuery = query;
    try {
      const res = await fetch(`/api/search-file?path=${encodeURIComponent(v.filePath)}&q=${encodeURIComponent(query)}`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const matches = Array.isArray(data.matches) ? data.matches : [];
      state.pageSearchMatches = matches;
      state.pageSearchIndex = -1;
      if (matches.length > 0) {
        state.pageSearchIndex = 0;
        const m = matches[0];
        await scrollToLineVirtual(m.line, query);
        $('pageSearchCount').textContent = `1/${matches.length}`;
      } else {
        showToast(`🔍 未找到符合「${query}」的內容`, 'warning');
        $('pageSearchCount').textContent = '0/0';
      }
    } catch (err) {
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

  function highlightTextNodes(root, query) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const textNodes = [];
    while (walker.nextNode()) {
      textNodes.push(walker.currentNode);
    }

    const matches = [];
    const lowerQuery = query.toLowerCase();

    for (const textNode of textNodes) {
      const text = textNode.textContent;
      const lowerText = text.toLowerCase();

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
  // THEME
  // ═══════════════════════════════════════════════════════════

  function applyTheme(theme, saveToLocalStorage = true, notify = false) {
    document.documentElement.setAttribute('data-theme', theme);
    const select = $('themeSelect');
    if (select) select.value = theme;
    const settingSelect = $('settingThemeSelect');
    if (settingSelect) settingSelect.value = theme;

    if (saveToLocalStorage) {
      localStorage.setItem('mdWebview-user-theme', theme);
    }
    state.currentTheme = theme;

    // Force Mobile WebKit/Chromium GPU composite layer repaint for active file pill
    const activePill = $('headerActiveFile');
    if (activePill) {
      activePill.classList.add('theme-updating');
      void activePill.offsetWidth; // Force reflow & style recalculation
      setTimeout(() => activePill.classList.remove('theme-updating'), 60);
    }

    if (notify) {
      const themeMap = { 'obsidian-dark': '🌙 暗色 Dark', 'obsidian-light': '☀️ 亮色 Light', 'solarized': '🔆 Solarized', 'zen': '🍵 禪風 Zen', 'gruvbox': '🍂 Gruvbox' };
      showToast(`🎨 已切換閱讀主題為「${themeMap[theme] || theme}」`, 'info');
    }
  }

  // ═══════════════════════════════════════════════════════════
  // FONT SIZE
  // ═══════════════════════════════════════════════════════════

  function applyFontSize(size, saveToLocalStorage = true) {
    size = Math.max(12, Math.min(32, size));
    state.fontSize = size;
    document.documentElement.style.setProperty('--content-font-size', size + 'px');

    // Default base is configured by admin in settings (default 16px)
    const defaultBase = state.defaultFontSize || 16;
    const delta = size - defaultBase;

    // UI elements scale by 0.5x ratio relative to defaultBase
    // uiScale = 1 + (delta / (defaultBase * 2))
    const uiScale = 1 + (delta / (defaultBase * 2));
    document.documentElement.style.setProperty('--ui-font-scale', uiScale);

    const display = $('fontSizeDisplay');
    if (display) display.textContent = size;
    if (saveToLocalStorage) {
      localStorage.setItem('mdWebview-user-fontsize', size);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // TEXT ALIGN, LINE HEIGHT, MAX WIDTH, READ PROGRESS
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
      localStorage.setItem('mdWebview-user-textalign', align);
    }
  }

  function applyLineHeight(lh, saveToLocalStorage = true) {
    if (!lh) lh = '1.8';
    state.lineHeight = lh;
    document.documentElement.style.setProperty('--content-line-height', lh);

    const group = $('settingLineHeightGroup');
    if (group) {
      $$('.segment-btn', group).forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-value') === lh);
      });
    }

    if (saveToLocalStorage) {
      localStorage.setItem('mdWebview-user-lineheight', lh);
    }
  }

  function renderMaxWidthControl() {
    const group = $('settingMaxWidthGroup');
    if (!group) return;

    const isMobile = isMobileBrowser();
    let currentVal = state.maxWidth;
    if (!currentVal) {
      currentVal = isMobile ? '100%' : '800px';
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
    if (!mw) mw = isMobile ? '100%' : '800px';
    state.maxWidth = mw;
    document.documentElement.style.setProperty('--content-max-width', mw);

    const group = $('settingMaxWidthGroup');
    if (group) {
      $$('.segment-btn', group).forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-value') === mw);
      });
    }

    if (saveToLocalStorage) {
      localStorage.setItem('mdWebview-user-maxwidth', mw);
    }
  }

  function applyAutoReadProgress(enabled, saveToLocalStorage = true) {
    state.autoReadProgress = enabled;
    const chk = $('settingAutoReadProgressCheck');
    if (chk) chk.checked = enabled;

    if (saveToLocalStorage) {
      localStorage.setItem('mdWebview-user-readprogress', enabled ? 'true' : 'false');
    }
  }

  // ── Recent Files (Top 20) ──────────────────────────────────
  function addRecentFile(filePath, title) {
    if (!filePath) return;
    const fileName = title || filePath.split('/').pop().replace(/\.md$/, '');
    let list = state.recentFiles || [];
    list = list.filter(item => item.filePath !== filePath);
    list.unshift({
      filePath,
      fileName,
      time: new Date().toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    });
    if (list.length > 20) list = list.slice(0, 20);
    state.recentFiles = list;
    localStorage.setItem('mdWebview-user-recentfiles', JSON.stringify(list));
    renderRecentFilesList();
  }

  function renderRecentFilesList() {
    const container = $('recentFilesList');
    if (!container) return;

    const list = state.recentFiles || [];
    if (list.length === 0) {
      container.innerHTML = `<div class="list-empty-hint">尚無最近開啟的經文檔案</div>`;
      return;
    }

    let html = '';
    list.forEach(item => {
      html += `
        <div class="list-item-row" data-file="${escHtml(item.filePath)}">
          <span class="list-item-title">${escHtml(item.fileName)}</span>
          <span class="list-item-time">${escHtml(item.time || '')}</span>
          <button type="button" class="list-item-del-btn" data-del-file="${escHtml(item.filePath)}" title="移除紀錄">✕</button>
        </div>
      `;
    });
    container.innerHTML = html;

    $$('.list-item-row', container).forEach(row => {
      row.addEventListener('click', (e) => {
        const delBtn = e.target.closest('.list-item-del-btn');
        if (delBtn) {
          e.stopPropagation();
          const targetFile = delBtn.getAttribute('data-del-file');
          state.recentFiles = state.recentFiles.filter(i => i.filePath !== targetFile);
          localStorage.setItem('mdWebview-user-recentfiles', JSON.stringify(state.recentFiles));
          renderRecentFilesList();
          return;
        }
        const file = row.getAttribute('data-file');
        if (file) {
          $('userSettingsOverlay').style.display = 'none';
          openFile(file);
        }
      });
    });
  }

  // ── Toast Notification ────────────────────────────────────
  // Stacked, queue-aware toasts. `type` picks a border color and, when the
  // message doesn't already carry an emoji, a matching icon. `type: 'loading'`
  // (or duration 0/Infinity) yields a persistent toast; dismiss it via the
  // returned handle's .dismiss(). Rapid successive events stack instead of
  // clobbering each other.
  const TOAST_ICONS = { info: 'ℹ️', success: '✅', warning: '⚠️', error: '❌', loading: '⏳' };
  const TOAST_MAX_VISIBLE = 3;
  const TOAST_HIDE_MS = 300; // keep in sync with .toast-notification transition
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

  function showToast(msg, type = 'info', duration = 2200) {
    const container = $('toastContainer');
    if (!container) return { dismiss() {} };

    const icon = TOAST_ICONS[type] || TOAST_ICONS.info;
    const text = TOAST_HAS_ICON_RE.test(String(msg).trim())
      ? msg : `${icon} ${msg}`;

    const el = document.createElement('div');
    el.className = 'toast-notification' + (type !== 'info' ? ' toast-' + type : '');
    el.textContent = text;
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

  // ── Bookmarks ──────────────────────────────────────────────
  function toggleBookmark(filePath, title) {
    if (!filePath) {
      showToast('⚠️ 請先開啟一本經文檔案');
      return false;
    }
    const fileName = title || filePath.split('/').pop().replace(/\.md$/, '');
    let list = state.bookmarks || [];
    const idx = list.findIndex(item => item.filePath === filePath);
    let isBookmarked = false;

    if (idx >= 0) {
      list.splice(idx, 1);
      isBookmarked = false;
      showToast('🗑️ 已從書籤移除');
    } else {
      list.unshift({
        filePath,
        fileName,
        time: new Date().toLocaleDateString('zh-TW')
      });
      isBookmarked = true;
      showToast('🔖 已新增至書籤與最愛');
    }

    state.bookmarks = list;
    localStorage.setItem('mdWebview-user-bookmarks', JSON.stringify(list));
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

  function renderBookmarksList() {
    const targets = [$('bookmarksList'), $('sidebarBookmarksList')].filter(Boolean);
    if (targets.length === 0) return;

    const list = state.bookmarks || [];
    targets.forEach(container => {
      if (list.length === 0) {
        container.innerHTML = `<div class="list-empty-hint">尚無收藏書籤。閱讀經文時點擊 🔖 按鈕即可新增。</div>`;
        return;
      }

      let html = '';
      list.forEach(item => {
        const displayPath = item.filePath ? item.filePath.replace(/\.md$/i, '') : item.fileName;
        html += `
          <div class="list-item-row" data-file="${escHtml(item.filePath)}">
            <span class="list-item-title">🔖 ${escHtml(displayPath)}</span>
            <span class="list-item-time">${escHtml(item.time || '')}</span>
            <button type="button" class="list-item-del-btn" data-del-bookmark="${escHtml(item.filePath)}" title="移除書籤">✕</button>
          </div>
        `;
      });
      container.innerHTML = html;

      $$('.list-item-row', container).forEach(row => {
        row.addEventListener('click', (e) => {
          const delBtn = e.target.closest('.list-item-del-btn');
          if (delBtn) {
            e.stopPropagation();
            const targetFile = delBtn.getAttribute('data-del-bookmark');
            state.bookmarks = state.bookmarks.filter(i => i.filePath !== targetFile);
            localStorage.setItem('mdWebview-user-bookmarks', JSON.stringify(state.bookmarks));
            renderBookmarksList();
            if (state.currentFile === targetFile) updateBookmarkButtonUI(targetFile);
            showToast('🗑️ 已移除書籤');
            return;
          }
          const file = row.getAttribute('data-file');
          if (file) {
            if ($('userSettingsOverlay')) $('userSettingsOverlay').style.display = 'none';
            openFile(file);
          }
        });
      });
    });
  }

  // ── Read Progress Auto-Save / Restore ─────────────────────
  let _saveProgressTimer = null;
  function saveReadProgress(filePath) {
    if (!filePath || !state.autoReadProgress) return;
    if (_saveProgressTimer) clearTimeout(_saveProgressTimer);
    _saveProgressTimer = setTimeout(() => {
      const content = $('content');
      if (!content) return;

      // Find top visible line anchor if available
      let currentLine = null;
      const anchors = $$('.line-anchor[data-line]', $('markdownBody'));
      const contentRect = content.getBoundingClientRect();
      for (const a of anchors) {
        const rect = a.getBoundingClientRect();
        if (rect.top >= contentRect.top + 20) {
          currentLine = parseInt(a.getAttribute('data-line'));
          break;
        }
      }

      const progress = {
        filePath,
        scrollTop: content.scrollTop,
        line: currentLine,
        timestamp: Date.now()
      };
      localStorage.setItem('mdWebview-last-read-progress', JSON.stringify(progress));
    }, 250);
  }

  function restoreReadProgress() {
    if (!state.autoReadProgress) return false;
    const raw = localStorage.getItem('mdWebview-last-read-progress');
    if (!raw) return false;
    try {
      const data = JSON.parse(raw);
      if (data && data.filePath) {
        // Pass line for server-side rendering hint, but primarily use scrollTop for precise restoration
        openFile(data.filePath, data.line).then(() => {
          // Virtualized files restore by absolute line (openFile already scrolled);
          // scrollTop is meaningless there because chunk heights lazy-load.
          if ((state.fileSizes.get(data.filePath) || 0) >= LARGE_FILE_MIN_BYTES) return;
          const content = $('content');
          if (content && typeof data.scrollTop === 'number') {
            // Restore precise scroll position (overrides the line-based scroll from openFile)
            setTimeout(() => {
              content.scrollTo({ top: data.scrollTop, behavior: 'instant' });
            }, 150);
            setTimeout(() => {
              content.scrollTo({ top: data.scrollTop, behavior: 'instant' });
              // Re-save after final scroll position is settled
              saveReadProgress(data.filePath);
            }, 500);
          }
        });
        return true;
      }
    } catch (_) {}
    return false;
  }

  // ═══════════════════════════════════════════════════════════
  // SIDEBAR RESIZE
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

  // ═══════════════════════════════════════════════════════════
  // EVENT LISTENERS
  // ═══════════════════════════════════════════════════════════

  function setupEventListeners() {
    // ── Sidebar toggle ──
    $('sidebarToggle').addEventListener('click', () => {
      const sidebar = $('sidebar');
      sidebar.classList.toggle('collapsed');
      state.sidebarCollapsed = sidebar.classList.contains('collapsed');
    });

    // ── Logo / site name → go home ──
    document.querySelector('.app-logo')?.addEventListener('click', () => {
      goHome();
    });

    // ── Mobile: Close sidebar when clicking content area ──
    $('content').addEventListener('click', () => {
      if (window.innerWidth <= 768) {
        const sidebar = $('sidebar');
        if (!sidebar.classList.contains('collapsed')) {
          sidebar.classList.add('collapsed');
          state.sidebarCollapsed = true;
        }
      }
    });

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
        // Re-render tree with new sort
        const container = $('fileTree');
        container.innerHTML = '';
        renderTreeNodes(sortTreeNodes(state.treeData, sort), container, 0);
      });
    });

    // ── File Collapse All ──
    $('fileCollapseAllBtn').addEventListener('click', collapseAllFolders);

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

    // ── Search Collapse All ──
    $('searchCollapseAllBtn').addEventListener('click', searchCollapseAll);

    // ── TOC Collapse All ──
    $('tocCollapseAllBtn').addEventListener('click', tocCollapseAll);

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
              () => showToast(`✓ 已複製第 ${lineNum} 行分享連結`),
              () => showToast('❌ 複製失敗（剪貼簿權限被拒）', 'error')
            );
          } else {
            if (fallbackCopy(fullLineUrl)) showToast(`✓ 已複製第 ${lineNum} 行分享連結`);
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

    // ── Font size ──
    const fontDec = $('fontDecrease');
    if (fontDec) fontDec.addEventListener('click', () => applyFontSize(state.fontSize - 1));
    const fontInc = $('fontIncrease');
    if (fontInc) fontInc.addEventListener('click', () => applyFontSize(state.fontSize + 1));

    // ── Global search (Triggers ONLY on Enter key or Search button click) ──
    const searchInput = $('globalSearchInput');
    const searchBtn = $('globalSearchBtn');

    if (searchInput) {
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
          openFile(file, line ? parseInt(line, 10) : null, query);
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
        const loginOverlay = $('adminLoginOverlay');
        if (loginOverlay && loginOverlay.style.display !== 'none' && loginOverlay.style.display !== '') {
          loginOverlay.style.display = 'none';
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
    });

    // Modal backdrop click exit listener
    ['userSettingsOverlay', 'adminSettingsOverlay', 'adminLoginOverlay', 'adminSetupOverlay'].forEach(id => {
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

    // ── Header Active File Click (Scroll to Top) ──
    const headerActiveFile = $('headerActiveFile');
    if (headerActiveFile) {
      headerActiveFile.addEventListener('click', () => {
        const contentEl = $('content');
        if (contentEl) {
          contentEl.scrollTo({ top: 0, behavior: 'smooth' });
        }
      });
    }

    // ── Sidebar resize ──
    setupResizeHandle();
    setupSelectionPopup();

    // ── User Settings Gear Button Click ──
    $('adminSettingsBtn').addEventListener('click', () => {
      openUserSettingsOverlay();
    });

    // ── Setting Menu Tab Navigation ──
    $$('.settings-tab-btn', $('userSettingsTabsNav')).forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-tab');
        $$('.settings-tab-btn', $('userSettingsTabsNav')).forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        $$('.settings-tab-pane', $('userSettingsOverlay')).forEach(pane => {
          pane.style.display = pane.id === `pane-${tab}` ? 'flex' : 'none';
        });
        if (tab === 'recommended') {
          fetchSuggestList();
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

    const clearRecentBtn = $('clearRecentFilesBtn');
    if (clearRecentBtn) {
      clearRecentBtn.addEventListener('click', () => {
        if (confirm('確定要清除所有最近開啟的經文紀錄？')) {
          state.recentFiles = [];
          localStorage.removeItem('mdWebview-user-recentfiles');
          renderRecentFilesList();
          showToast('🗑️ 已成功清除所有閱讀紀錄', 'info');
        }
      });
    }

    const addBkmHandler = () => {
      if (state.currentFile) {
        toggleBookmark(state.currentFile);
      } else {
        showToast('⚠️ 請先點擊開啟一本經文');
      }
    };

    const sidebarBkmBtn = $('sidebarAddBookmarkBtn');
    if (sidebarBkmBtn) sidebarBkmBtn.addEventListener('click', addBkmHandler);

    const menuBkmBtn = $('menuAddCurrentBookmarkBtn');
    if (menuBkmBtn) menuBkmBtn.addEventListener('click', addBkmHandler);

    const clearBkmBtn = $('clearBookmarksBtn');
    if (clearBkmBtn) {
      clearBkmBtn.addEventListener('click', () => {
        if (confirm('確定要清除所有經文書籤與最愛？')) {
          state.bookmarks = [];
          localStorage.removeItem('mdWebview-user-bookmarks');
          renderBookmarksList();
          if (state.currentFile) updateBookmarkButtonUI(state.currentFile);
          showToast('🗑️ 已清除所有書籤');
        }
      });
    }

    // Modal Close
    $('userSettingsCloseBtn').addEventListener('click', () => {
      closeUserSettingsModal();
    });
    $('userSettingsDoneBtn').addEventListener('click', () => {
      closeUserSettingsModal();
    });

    // Menu Sub-Modals (Admin Login / Admin Vault Settings)
    $('menuOpenAdminLoginBtn').addEventListener('click', () => {
      $('userSettingsOverlay').style.display = 'none';
      openLoginOverlay();
    });

    const vaultBtn = $('menuOpenVaultSettingsBtn');
    if (vaultBtn) {
      vaultBtn.addEventListener('click', async () => {
        $('userSettingsOverlay').style.display = 'none';
        await openSettingsOverlay();
      });
    }

    // ── Setup Form Submission ──
    $('adminSetupForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = $('setupUsername').value;
      const password = $('setupPassword').value;
      const confirm = $('setupPasswordConfirm').value;
      const errorEl = $('setupErrorMsg');

      if (password !== confirm) {
        errorEl.textContent = '密碼與確認密碼不符';
        errorEl.style.display = 'block';
        return;
      }

      try {
        const res = await fetch('/api/admin/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || '設定失敗');
        }
        errorEl.style.display = 'none';
        $('adminSetupOverlay').style.display = 'none';
        
        // Show login overlay
        openLoginOverlay();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.style.display = 'block';
      }
    });

    // ── Login Form Submission ──
    const submitLoginForm = async () => {
      const username = $('loginUsername').value;
      const password = $('loginPassword').value;
      const errorEl = $('loginErrorMsg');

      try {
        const res = await fetch('/api/admin/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || '登入失敗');
        }
        errorEl.style.display = 'none';
        state.adminToken = data.token;
        localStorage.setItem('mdWebview-admin-token', data.token);
        $('adminLoginOverlay').style.display = 'none';
        showToast('🔑 管理員登入成功', 'success');
        
        // Open settings panel
        await openSettingsOverlay();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.style.display = 'block';
        showToast(`❌ 登入失敗：${err.message}`, 'error', 3500);
      }
    };

    $('adminLoginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      await submitLoginForm();
    });

    $('loginPassword').addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        await submitLoginForm();
      }
    });

    $('loginCancelBtn').addEventListener('click', () => {
      $('adminLoginOverlay').style.display = 'none';
    });

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
    }

    const versionToggleEl = $('settingsEnableVersion');
    if (versionToggleEl) versionToggleEl.addEventListener('change', syncFooterToggleInputs);
    const downloadToggleEl = $('settingsEnableDownload');
    if (downloadToggleEl) downloadToggleEl.addEventListener('change', syncFooterToggleInputs);

    // ── Settings Form Submission ──
    async function performSaveSettings(createIfNotExists = false, closeAfterSave = false) {
      const siteName = $('settingsSiteName').value;
      const mdRoot = $('settingsMdRoot').value;
      const defaultFontSize = parseInt($('settingsFontSize').value);
      const defaultTheme = $('settingsTheme').value;
      const enableVersion = $('settingsEnableVersion').checked;
      const version = $('settingsVersion').value;
      const enableDownload = $('settingsEnableDownload').checked;
      const downloadUrl = $('settingsDownloadUrl').value;
      const maxProximityDistance = parseInt(($('settingsMaxProximityDistance') || {}).value) || 150;
      const errorEl = $('settingsErrorMsg');
      const successEl = $('settingsSuccessMsg');

      try {
        const res = await fetch('/api/admin/settings', {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'X-Admin-Token': state.adminToken
          },
          body: JSON.stringify({
            settings: { 
              siteName, mdRoot, defaultFontSize, defaultTheme, createIfNotExists,
              enableVersion, version, enableDownload, downloadUrl, maxProximityDistance 
            }
          })
        });
        const data = await res.json();
        if (!res.ok) {
          if (res.status === 404 && data.code === 'DIR_NOT_FOUND') {
            const confirmCreate = window.confirm(`指定的目錄路徑不存在：\n${data.path || mdRoot}\n\n是否要自動創建此目錄？`);
            if (confirmCreate) {
              return await performSaveSettings(true, closeAfterSave);
            }
          }
          throw new Error(data.error || '儲存失敗');
        }
        errorEl.style.display = 'none';

        if (data.settings) {
          if (data.settings.defaultFontSize) {
            state.defaultFontSize = parseInt(data.settings.defaultFontSize);
            const userSavedFont = localStorage.getItem('mdWebview-user-fontsize');
            applyFontSize(userSavedFont ? parseInt(userSavedFont) : state.defaultFontSize, !!userSavedFont);
          }
          if (data.settings.defaultTheme) {
            localStorage.removeItem('mdWebview-user-theme');
            applyTheme(data.settings.defaultTheme, false);
          }
          if (data.settings.siteName) {
            state.siteName = data.settings.siteName;
            updateSiteNameUI();
          }
          updateWelcomeFooter(data.settings);
        }

        // Reload the file tree and update UI with new paths
        await loadTree();
        showToast('✅ 後台系統設定已成功儲存並生效', 'success');

        if (closeAfterSave) {
          closeAdminModal();
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
        await fetch('/api/admin/logout', {
          method: 'POST',
          headers: { 'X-Admin-Token': state.adminToken }
        });
      } catch (err) {
        console.error('Logout request failed:', err);
        ok = false;
      }
      state.adminToken = null;
      localStorage.removeItem('mdWebview-admin-token');
      closeAdminModal();
      showToast(ok ? '👋 管理員已順利登出' : '❌ 登出請求失敗，但本機已登出', ok ? 'info' : 'error');
    });
  }

  function openUserSettingsOverlay() {
    renderMaxWidthControl();
    renderRecentFilesList();
    renderBookmarksList();
    fetchSuggestList();

    const statusText = $('adminStatusText');
    const loginBtn = $('menuOpenAdminLoginBtn');
    const vaultBtn = $('menuOpenVaultSettingsBtn');

    if (state.adminToken) {
      if (statusText) statusText.textContent = '管理員登入狀態：已登入 ✅';
      if (loginBtn) loginBtn.style.display = 'none';
      if (vaultBtn) vaultBtn.style.display = 'inline-block';
    } else {
      if (statusText) statusText.textContent = '管理員登入狀態：尚未登入';
      if (loginBtn) loginBtn.style.display = 'inline-block';
      if (vaultBtn) vaultBtn.style.display = 'none';
    }

    $('userSettingsOverlay').style.display = 'flex';
    document.body.classList.add('modal-open');
  }

  // ── Helper functions for admin & user panels ──
  let hwAutoRefreshTimer = null;
  let indexRebuildPollingTimer = null;

  function closeUserSettingsModal() {
    const overlay = $('userSettingsOverlay');
    if (overlay) overlay.style.display = 'none';
    document.body.classList.remove('modal-open');
  }

  function closeAdminModal() {
    const overlay = $('adminSettingsOverlay');
    if (overlay) overlay.style.display = 'none';
    const loginOverlay = $('adminLoginOverlay');
    if (loginOverlay) loginOverlay.style.display = 'none';
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

  // ── SVG Visualizations & Chart Helpers ──────────────────────────

  function renderAnalyticsTrendChart(dailyTrend) {
    const wrapper = $('analyticsTrendChartWrapper');
    if (!wrapper) return;

    if (!Array.isArray(dailyTrend) || dailyTrend.length === 0) {
      wrapper.innerHTML = `<div class="panel-placeholder"><span class="placeholder-icon">📊</span><span>尚無趨勢數據</span></div>`;
      return;
    }

    const width = 640;
    const height = 180;
    const padding = { top: 20, right: 20, bottom: 30, left: 40 };
    const chartW = width - padding.left - padding.right;
    const chartH = height - padding.top - padding.bottom;

    const maxViews = Math.max(1, ...dailyTrend.map(d => d.views || 0));
    const maxIps = Math.max(1, ...dailyTrend.map(d => d.uniqueIps || 0));
    const maxY = Math.max(maxViews, maxIps);

    const count = dailyTrend.length;
    const getX = (i) => padding.left + (count === 1 ? chartW / 2 : (i / (count - 1)) * chartW);
    const getY = (val) => padding.top + chartH - (val / maxY) * chartH;

    const viewPoints = dailyTrend.map((d, i) => `${getX(i).toFixed(1)},${getY(d.views).toFixed(1)}`);
    const ipPoints = dailyTrend.map((d, i) => `${getX(i).toFixed(1)},${getY(d.uniqueIps).toFixed(1)}`);

    const viewPathD = `M ${viewPoints.join(' L ')}`;
    const ipPathD = `M ${ipPoints.join(' L ')}`;
    const viewAreaD = `M ${getX(0)},${padding.top + chartH} L ${viewPoints.join(' L ')} L ${getX(count - 1)},${padding.top + chartH} Z`;

    let gridLines = '';
    for (let i = 0; i <= 3; i++) {
      const yVal = Math.round((maxY / 3) * i);
      const yPos = getY(yVal);
      gridLines += `<line x1="${padding.left}" y1="${yPos}" x2="${width - padding.right}" y2="${yPos}" stroke="var(--border-subtle, rgba(255,255,255,0.06))" stroke-dasharray="3,3" />`;
      gridLines += `<text x="${padding.left - 8}" y="${yPos + 4}" font-size="10" fill="var(--text-muted)" text-anchor="end">${yVal}</text>`;
    }

    let xLabels = '';
    const step = Math.max(1, Math.floor(count / 6));
    dailyTrend.forEach((d, i) => {
      if (i % step === 0 || i === count - 1) {
        const xPos = getX(i);
        const shortDate = d.date.length >= 10 ? d.date.substring(5) : d.date;
        xLabels += `<text x="${xPos}" y="${height - 8}" font-size="10" fill="var(--text-muted)" text-anchor="middle">${shortDate}</text>`;
      }
    });

    let dots = '';
    dailyTrend.forEach((d, i) => {
      const cx = getX(i);
      const cyView = getY(d.views);
      const cyIp = getY(d.uniqueIps);
      dots += `<circle cx="${cx}" cy="${cyView}" r="4" fill="#7aa2f7" class="trend-dot" data-date="${d.date}" data-views="${d.views}" data-ips="${d.uniqueIps}" title="${d.date}: ${d.views} 點閱" />`;
      dots += `<circle cx="${cx}" cy="${cyIp}" r="3" fill="#2ac3de" class="trend-dot" data-date="${d.date}" data-views="${d.views}" data-ips="${d.uniqueIps}" title="${d.date}: ${d.uniqueIps} 獨立 IP" />`;
    });

    wrapper.innerHTML = `
      <svg viewBox="0 0 ${width} ${height}" class="analytics-trend-svg" style="width: 100%; height: auto; overflow: visible;">
        <defs>
          <linearGradient id="viewTrendGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#7aa2f7" stop-opacity="0.3"/>
            <stop offset="100%" stop-color="#7aa2f7" stop-opacity="0.0"/>
          </linearGradient>
        </defs>
        ${gridLines}
        ${xLabels}
        <path d="${viewAreaD}" fill="url(#viewTrendGrad)" />
        <path d="${viewPathD}" fill="none" stroke="#7aa2f7" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />
        <path d="${ipPathD}" fill="none" stroke="#2ac3de" stroke-width="2" stroke-dasharray="4,3" stroke-linejoin="round" stroke-linecap="round" />
        ${dots}
      </svg>
      <div class="analytics-chart-legend" style="display: flex; justify-content: center; gap: 20px; margin-top: 8px; font-size: 12px; color: var(--text-secondary);">
        <span style="display: flex; align-items: center; gap: 6px;"><span style="width: 12px; height: 3px; background: #7aa2f7; border-radius: 2px;"></span> 閱讀點閱數 (Page Views)</span>
        <span style="display: flex; align-items: center; gap: 6px;"><span style="width: 12px; height: 2px; background: #2ac3de; border-style: dashed;"></span> 獨立訪客數 (Unique IPs)</span>
      </div>
    `;
  }



  async function loadHardwareStats() {
    try {
      const res = await fetch('/api/admin/hardware', {
        headers: { 'X-Admin-Token': state.adminToken }
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

    // Storage Card
    const diskText = $('hwDiskText');
    const diskFill = $('hwDiskFill');
    const fs = data.storage.vaultFs;
    if (diskText) diskText.textContent = `${formatBytes(fs.used)} / ${formatBytes(fs.total)} (${fs.usagePct}%)`;
    if (diskFill) {
      diskFill.style.width = `${fs.usagePct || 0}%`;
    }

    const cacheSize = $('hwCacheSize');
    if (cacheSize) cacheSize.textContent = formatBytes(data.storage.cacheSizeBytes);
    const analyticsSize = $('hwAnalyticsSize');
    if (analyticsSize) analyticsSize.textContent = formatBytes(data.storage.analyticsStoreSizeBytes);
    const logsSize = $('hwLogsSize');
    if (logsSize) logsSize.textContent = formatBytes(data.storage.logsDirSizeBytes);

    // Runtime & Index Card
    const nodeVer = $('hwNodeVer');
    if (nodeVer) nodeVer.textContent = `${data.system.nodeVersion}`;
    const platform = $('hwPlatform');
    if (platform) platform.textContent = `${data.system.platform} (${data.system.arch})`;
    const workerStatus = $('hwWorkerStatus');
    if (workerStatus) workerStatus.textContent = `${data.workers.idle}/${data.workers.count} 就緒`;

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

    const bigramCount = $('hwBigramCount');
    if (bigramCount) {
      bigramCount.textContent = `${(data.index.uniqueBigrams || 0).toLocaleString()} 筆 (檔案: ${data.index.totalFiles} 個)`;
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
          headers: { 'X-Admin-Token': state.adminToken }
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          showToast(`❌ 重建索引失敗: ${errData.error || res.statusText}`, 'error', 3500);
          rebuildBtn.disabled = false;
          rebuildBtn.textContent = '⚡ 手動重建索引';
          return;
        }

        showToast('⏳ 已觸發全文索引重建，後台建置中…', 'info', 3000);

        await loadHardwareStats();

        if (indexRebuildPollingTimer) clearInterval(indexRebuildPollingTimer);
        indexRebuildPollingTimer = setInterval(async () => {
          try {
            const statsRes = await fetch('/api/admin/hardware', {
              headers: { 'X-Admin-Token': state.adminToken }
            });
            if (!statsRes.ok) return;
            const data = await statsRes.json();
            renderHardwareDashboard(data);

            if (!data.index.building) {
              clearInterval(indexRebuildPollingTimer);
              indexRebuildPollingTimer = null;
              rebuildBtn.disabled = false;
              rebuildBtn.textContent = '⚡ 手動重建索引';
              showToast('✅ 全文索引重建完成！', 'success', 3000);
            }
          } catch (err) {
            console.error('Error polling hardware stats during rebuild:', err);
          }
        }, 1500);

      } catch (err) {
        console.error('Failed to rebuild search index:', err);
        showToast(`❌ 重建索引失敗: ${err.message}`, 'error', 3500);
        rebuildBtn.disabled = false;
        rebuildBtn.textContent = '⚡ 手動重建索引';
      }
    };
  }

  function setupHardwareAutoRefresh() {
    const refreshBtn = $('hwRefreshBtn');
    const select = $('hwAutoRefreshSelect');

    setupHardwareIndexRebuild();

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

  function openLoginOverlay() {
    $('loginUsername').value = '';
    $('loginPassword').value = '';
    $('loginErrorMsg').style.display = 'none';
    $('adminLoginOverlay').style.display = 'flex';
  }

  async function openSettingsOverlay() {
    setupAdminTabEvents();
    const errorEl = $('settingsErrorMsg');
    const successEl = $('settingsSuccessMsg');
    errorEl.style.display = 'none';
    successEl.style.display = 'none';

    try {
      const res = await fetch('/api/admin/settings', {
        headers: { 'X-Admin-Token': state.adminToken }
      });
      if (!res.ok) {
        // Token invalid/expired
        state.adminToken = null;
        localStorage.removeItem('mdWebview-admin-token');
        closeAdminModal();
        openLoginOverlay();
        return;
      }
      const data = await res.json();
      $('settingsSiteName').value = data.settings.siteName || 'mdWebview';
      $('settingsMdRoot').value = data.settings.mdRoot;
      $('settingsFontSize').value = data.settings.defaultFontSize;
      $('settingsTheme').value = data.settings.defaultTheme;
      $('settingsEnableVersion').checked = !!data.settings.enableVersion;
      $('settingsVersion').value = data.settings.version || '';
      $('settingsEnableDownload').checked = !!data.settings.enableDownload;
      $('settingsDownloadUrl').value = data.settings.downloadUrl || '';
      const proxEl = $('settingsMaxProximityDistance');
      if (proxEl) proxEl.value = data.settings.maxProximityDistance || 150;
      if (typeof syncFooterToggleInputs === 'function') syncFooterToggleInputs();
      $('adminSettingsOverlay').style.display = 'flex';
      document.body.classList.add('modal-open');

      // Preload data for all admin tabs (Suggest, Analytics, Logs) so that
      // all 4 tabs and data analytics tables are populated immediately upon login/open
      Promise.all([
        loadSuggestSettings().catch(() => {}),
        loadAdminAnalytics().catch(() => {}),
        fetchAdminLogs().catch(() => {})
      ]);
    } catch (err) {
      console.error('Error fetching settings:', err);
      showToast('❌ 系統設定載入失敗', 'error');
    }
  }

  // ── Admin Logs Tab Logic ─────────────────────────────────
  let stateAdminLogs = [];

  // Timezone Formatting Helper
  function getEffectiveTimezone(selectId = 'adminLogTimezoneSelect') {
    const sel = $(selectId);
    const val = sel ? sel.value : 'auto';
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
      const formatter = new Intl.DateTimeFormat('zh-TW', {
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
      if (state.adminToken) {
        headers['X-Admin-Token'] = state.adminToken;
      }
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
    const filterText = searchInput ? searchInput.value.trim().toLowerCase() : '';
    if (!viewer) return;

    const currentTz = getEffectiveTimezone('adminLogTimezoneSelect');

    let filtered = stateAdminLogs;
    if (filterText) {
      filtered = stateAdminLogs.filter(item => {
        const text = `${item.timestamp} ${item.level} ${item.tag} ${item.ip || ''} ${item.message}`.toLowerCase();
        return text.includes(filterText);
      });
    }

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
    viewer.scrollTop = viewer.scrollHeight;

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

  // Analytics Dashboard Logic
  let stateAnalyticsRange = '1d';

  async function loadAdminAnalytics() {
    const tableBody = $('analyticsTopFilesTable');
    if (tableBody) {
      tableBody.innerHTML = '<tr><td colspan="6" class="analytics-empty">載入數據中…</td></tr>';
    }
    try {
      const headers = {};
      if (state.adminToken) {
        headers['X-Admin-Token'] = state.adminToken;
      }
      const tz = getEffectiveTimezone('analyticsTimezoneSelect');
      const res = await fetch(`/api/admin/analytics?range=${stateAnalyticsRange}&tz=${encodeURIComponent(tz)}`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      renderAdminAnalytics(data);
    } catch (err) {
      if (tableBody) {
        tableBody.innerHTML = `<tr><td colspan="6" class="analytics-empty">⚠️ 載入失敗: ${escHtml(err.message)}</td></tr>`;
      }
    }
  }

  function renderAdminAnalytics(data) {
    if (!data) return;
    const tz = getEffectiveTimezone('analyticsTimezoneSelect');

    const totalViewsEl = $('analyticsTotalViews');
    const uniqueIpsEl = $('analyticsUniqueIps');
    const activeFilesEl = $('analyticsActiveFiles');
    const totalSearchesEl = $('analyticsTotalSearches');

    if (totalViewsEl) totalViewsEl.textContent = (data.summary?.totalViews || 0).toLocaleString();
    if (uniqueIpsEl) uniqueIpsEl.textContent = (data.summary?.uniqueIps || 0).toLocaleString();
    if (activeFilesEl) activeFilesEl.textContent = (data.summary?.activeFiles || 0).toLocaleString();
    if (totalSearchesEl) totalSearchesEl.textContent = (data.summary?.totalSearches || 0).toLocaleString();

    // SVG Visualizations
    renderAnalyticsTrendChart(data.dailyTrend || []);

    const topFilesTable = $('analyticsTopFilesTable');
    if (topFilesTable) {
      if (!data.topFiles || data.topFiles.length === 0) {
        topFilesTable.innerHTML = '<tr><td colspan="6" class="analytics-empty">尚無瀏覽紀錄數據</td></tr>';
      } else {
        topFilesTable.innerHTML = data.topFiles.map((file, idx) => {
          const formattedTime = formatTimestampWithTZ(file.lastAccess, tz);
          return `<tr>
            <td style="text-align: center; font-weight: 600;">${idx + 1}</td>
            <td><a href="#" class="analytics-file-link" data-path="${escHtml(file.path)}" style="color: var(--accent); font-weight: 600; text-decoration: none;">${escHtml(file.fileName)}</a></td>
            <td style="color: var(--text-secondary); font-size: 12px;">${escHtml(file.path)}</td>
            <td style="text-align: right; font-weight: 700; color: #58a6ff;">${file.views.toLocaleString()}</td>
            <td style="text-align: right; font-weight: 600;">${file.uniqueIps.toLocaleString()}</td>
            <td style="color: var(--text-secondary); font-size: 12px;">${escHtml(formattedTime)}</td>
          </tr>`;
        }).join('');

        topFilesTable.querySelectorAll('.analytics-file-link').forEach(link => {
          link.addEventListener('click', (e) => {
            e.preventDefault();
            const filePath = e.currentTarget.getAttribute('data-path');
            if (filePath) {
              const modal = $('adminSettingsOverlay');
              if (modal) modal.style.display = 'none';
              openFile(filePath);
            }
          });
        });
      }
    }

    const topSearchesTable = $('analyticsTopSearchesTable');
    if (topSearchesTable) {
      if (!data.topSearches || data.topSearches.length === 0) {
        topSearchesTable.innerHTML = '<tr><td colspan="3" class="analytics-empty">尚無搜尋紀錄</td></tr>';
      } else {
        topSearchesTable.innerHTML = data.topSearches.map((item, idx) => `<tr>
          <td style="text-align: center; font-weight: 600;">${idx + 1}</td>
          <td style="font-weight: 600;">${escHtml(item.query)}</td>
          <td style="text-align: right; font-weight: 700; color: #bc8cff;">${item.count.toLocaleString()}</td>
        </tr>`).join('');
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
          <td style="text-align: right; font-weight: 700; color: #79c0ff;">${item.requests.toLocaleString()}</td>
        </tr>`).join('');
      }
    }
  }

  function setupAdminTabEvents() {
    if (state._adminTabEventsSetup) return;
    state._adminTabEventsSetup = true;

    const tabConfigBtn = $('adminTabConfigBtn');
    const tabHardwareBtn = $('adminTabHardwareBtn');
    const tabLogsBtn = $('adminTabLogsBtn');
    const tabAnalyticsBtn = $('adminTabAnalyticsBtn');
    const tabSuggestBtn = $('adminTabSuggestBtn');
    const paneConfig = $('adminPaneConfig');
    const paneHardware = $('adminPaneHardware');
    const paneLogs = $('adminPaneLogs');
    const paneAnalytics = $('adminPaneAnalytics');
    const paneSuggest = $('adminPaneSuggest');
    const refreshBtn = $('adminLogRefreshBtn');
    const searchInput = $('adminLogSearchInput');
    const logTzSelect = $('adminLogTimezoneSelect');
    const analyticsTzSelect = $('analyticsTimezoneSelect');

    function hideAllPanes() {
      if (hwAutoRefreshTimer) {
        clearInterval(hwAutoRefreshTimer);
        hwAutoRefreshTimer = null;
      }
      [paneConfig, paneHardware, paneLogs, paneAnalytics, paneSuggest].forEach(p => { if (p) p.style.display = 'none'; });
      [tabConfigBtn, tabHardwareBtn, tabLogsBtn, tabAnalyticsBtn, tabSuggestBtn].forEach(b => { if (b) b.classList.remove('active'); });
    }

    if (tabConfigBtn) {
      tabConfigBtn.addEventListener('click', () => {
        hideAllPanes();
        tabConfigBtn.classList.add('active');
        if (paneConfig) paneConfig.style.display = 'block';
      });
    }

    if (tabHardwareBtn) {
      tabHardwareBtn.addEventListener('click', () => {
        hideAllPanes();
        tabHardwareBtn.classList.add('active');
        if (paneHardware) paneHardware.style.display = 'block';
        loadHardwareStats();
        setupHardwareAutoRefresh();
      });
    }

    if (tabLogsBtn) {
      tabLogsBtn.addEventListener('click', () => {
        hideAllPanes();
        tabLogsBtn.classList.add('active');
        if (paneLogs) paneLogs.style.display = 'block';
        fetchAdminLogs();
      });
    }

    if (tabAnalyticsBtn) {
      tabAnalyticsBtn.addEventListener('click', () => {
        hideAllPanes();
        tabAnalyticsBtn.classList.add('active');
        if (paneAnalytics) paneAnalytics.style.display = 'block';
        loadAdminAnalytics();
      });
    }

    if (tabSuggestBtn) {
      tabSuggestBtn.addEventListener('click', () => {
        hideAllPanes();
        tabSuggestBtn.classList.add('active');
        if (paneSuggest) paneSuggest.style.display = 'block';
        loadSuggestSettings();
      });
    }

    if (logTzSelect) {
      logTzSelect.addEventListener('change', () => renderAdminLogs());
    }

    if (analyticsTzSelect) {
      analyticsTzSelect.addEventListener('change', () => loadAdminAnalytics());
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

    if (csvExportBtn) {
      csvExportBtn.addEventListener('click', () => {
        const tz = getEffectiveTimezone('analyticsTimezoneSelect');
        window.open(`/api/admin/analytics/export?range=${stateAnalyticsRange}&format=csv&tz=${encodeURIComponent(tz)}`, '_blank');
        showToast('📥 已成功導出分析數據報告 (CSV)', 'success');
      });
    }

    if (jsonExportBtn) {
      jsonExportBtn.addEventListener('click', () => {
        const tz = getEffectiveTimezone('analyticsTimezoneSelect');
        window.open(`/api/admin/analytics/export?range=${stateAnalyticsRange}&format=json&tz=${encodeURIComponent(tz)}`, '_blank');
        showToast('📥 已成功導出分析數據報告 (JSON)', 'success');
      });
    }

    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        fetchAdminLogs();
        showToast('🔄 系統日誌與狀態已更新', 'info');
      });
    }

    if (searchInput) {
      searchInput.addEventListener('input', debounce(() => renderAdminLogs(), 200));
    }

    // Suggest form events (only once)
    setupSuggestFormEvents();
  }

  let _suggestFormEventsSetup = false;
  function setupSuggestFormEvents() {
    if (_suggestFormEventsSetup) return;
    _suggestFormEventsSetup = true;

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
      const adminPickCount = parseInt(($('suggestAdminPickCount') || {}).value || '3');
      const hotPickCount = parseInt(($('suggestHotPickCount') || {}).value || '5');
      const enabled = !!(($('suggestEnabled') || {}).checked);

      // Parse textarea lines
      const adminList = adminListRaw.split('\n').map(l => l.trim()).filter(Boolean);
      const blackList = blackListRaw.split('\n').map(l => l.trim()).filter(Boolean);

      try {
        // Fetch current settings to preserve other fields
        const getRes = await fetch('/api/admin/settings', {
          headers: { 'X-Admin-Token': state.adminToken }
        });
        if (!getRes.ok) throw new Error('Unable to load settings');
        const current = await getRes.json();
        const s = current.settings || {};

        const res = await fetch('/api/admin/settings', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Admin-Token': state.adminToken
          },
          body: JSON.stringify({
            settings: {
              mdRoot: s.mdRoot,
              defaultFontSize: s.defaultFontSize,
              defaultTheme: s.defaultTheme,
              siteName: s.siteName,
              enableVersion: s.enableVersion,
              version: s.version,
              enableDownload: s.enableDownload,
              downloadUrl: s.downloadUrl,
              suggestList: { adminList, adminPickCount, blackList, hotPickCount, enabled }
            }
          })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '儲存失敗');

        if (successEl) {
          successEl.textContent = '推薦設定已儲存';
          successEl.style.display = 'block';
          setTimeout(() => { successEl.style.display = 'none'; }, 3000);
        }
        // Refresh the homepage suggest list
        fetchSuggestList();
      } catch (err) {
        if (errorEl) {
          errorEl.textContent = err.message;
          errorEl.style.display = 'block';
        }
      }
    });
  }

  async function loadSuggestSettings() {
    try {
      const res = await fetch('/api/admin/settings', {
        headers: { 'X-Admin-Token': state.adminToken }
      });
      if (!res.ok) return;
      const data = await res.json();
      const sl = (data.settings && data.settings.suggestList) || {};

      const adminListEl = $('suggestAdminList');
      const blackListEl = $('suggestBlackList');
      const adminPickEl = $('suggestAdminPickCount');
      const hotPickEl = $('suggestHotPickCount');
      const enabledEl = $('suggestEnabled');

      if (adminListEl) adminListEl.value = (sl.adminList || []).join('\n');
      if (blackListEl) blackListEl.value = (sl.blackList || []).join('\n');
      if (adminPickEl) adminPickEl.value = sl.adminPickCount ?? 3;
      if (hotPickEl) hotPickEl.value = sl.hotPickCount ?? 5;
      if (enabledEl) enabledEl.checked = sl.enabled === true;
    } catch (_) {}
  }

  // ═══════════════════════════════════════════════════════════
  // UTILITIES
  // ═══════════════════════════════════════════════════════════

  function debounce(fn, delay) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  function escHtml(str) {
    if (!str) return '';
    return str
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
        <button id="selectionShareBtn" title="分享此段落與行數">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M11 2.5a2.5 2.5 0 11.603 1.628l-6.718 3.12a2.499 2.499 0 010 1.504l6.718 3.12a2.5 2.5 0 11-.488.928L4.397 9.77a2.5 2.5 0 110-3.54l6.718-3.12A2.499 2.499 0 0111 2.5z"/>
          </svg>
          <span id="selectionShareLabel">分享指定行</span>
        </button>
      `;
      document.body.appendChild(popup);
    }

    const shareBtn = $('selectionShareBtn');
    const shareLabel = $('selectionShareLabel');
    let currentShareUrl = '';
    let currentLineNum = null;

    document.addEventListener('mouseup', () => {
      // Small timeout to let selection clear/update
      setTimeout(() => {
        const selection = window.getSelection();
        const text = selection.toString().trim();
        
        if (!text || !state.currentFile) {
          popup.classList.remove('visible');
          return;
        }

        // Check if the selection is inside markdownBody
        const range = selection.getRangeAt(0);
        const container = $('markdownBody');
        if (!container.contains(range.commonAncestorContainer)) {
          popup.classList.remove('visible');
          return;
        }

        // Get the line number of the start of selection
        const lineNum = getSelectionLineNumber(selection);
        if (!lineNum) {
          popup.classList.remove('visible');
          return;
        }

        // Calculate position: right above/right of the selection
        const rect = range.getBoundingClientRect();
        
        // Show popup
        popup.classList.add('visible');
        
        // Position it: center-top of selection range bounding box
        const popupWidth = popup.offsetWidth || 110;
        const popupHeight = popup.offsetHeight || 32;
        
        const top = rect.top + window.scrollY - popupHeight - 8;
        const left = rect.left + rect.width / 2 + window.scrollX - popupWidth / 2;
        
        popup.style.top = `${Math.max(0, top)}px`;
        popup.style.left = `${Math.max(0, left)}px`;

        // Update share link using unencoded Chinese URL
        const baseUrl = window.location.origin + window.location.pathname;
        const cleanFile = state.currentFile.split('&').join('%26').split('#').join('%23');
        currentLineNum = lineNum;
        currentShareUrl = `${baseUrl}?file=${cleanFile}&line=${lineNum}`;

        // Reset label
        shareLabel.textContent = `分享第 ${lineNum} 行`;
        shareBtn.classList.remove('copied');
      }, 50);
    });

    // Prevent selection from clearing when clicking the popup button
    popup.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    shareBtn.addEventListener('click', () => {
      if (!currentShareUrl) return;
      const rawUrl = decodeURIComponent(currentShareUrl);

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

  // ── Boot ──────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', init);
})();
