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

  // ── State ─────────────────────────────────────────────────
  const state = {
    currentFile: null,
    currentTheme: userTheme || appConfig.defaultTheme || 'obsidian-dark',
    fontSize: userFont ? parseInt(userFont) : (appConfig.defaultFontSize || 16),
    textAlign: userAlign || 'justify',
    lineHeight: userLineHeight || '1.8',
    maxWidth: userMaxWidth || '800px',
    autoReadProgress: userReadProgress !== 'false',
    recentFiles: JSON.parse(localStorage.getItem('mdWebview-user-recentfiles') || '[]'),
    bookmarks: JSON.parse(localStorage.getItem('mdWebview-user-bookmarks') || '[]'),
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
  };

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
      console.error('[md-worker] Worker error, will recreate on next call:', err.message);
      _mdWorker.terminate();
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
    marked.setOptions({ breaks: false, gfm: true, headerIds: true, mangle: false });
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

    // Open file from URL query or hash on first load; if none, attempt restoring last read progress
    const urlInfo = getFileFromURL();
    if (urlInfo) {
      await openFile(urlInfo.file, urlInfo.line);
    } else {
      restoreReadProgress();
    }

    // Handle browser back / forward
    const handleUrlChange = async () => {
      const info = getFileFromURL();
      if (info && info.file !== state.currentFile) {
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
    // 1. Try query parameters first (server readable)
    const searchParams = new URLSearchParams(window.location.search);
    const searchFile = searchParams.get('file');
    if (searchFile) {
      const searchLine = searchParams.get('line') ? parseInt(searchParams.get('line')) : null;
      return { file: searchFile, line: searchLine };
    }

    // 2. Fallback to hash (backwards compatibility)
    const hash = window.location.hash;
    if (hash.startsWith('#file=')) {
      try {
        const params = new URLSearchParams(hash.slice(1));
        const file = params.get('file');
        const line = params.get('line') ? parseInt(params.get('line')) : null;
        return file ? { file, line } : null;
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  function scrollToLine(lineNum) {
    if (!lineNum) return;
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
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      // Brief highlight on the parent block
      const block = target.nextElementSibling || target.parentElement;
      if (block) {
        block.classList.add('line-highlight');
        setTimeout(() => block.classList.remove('line-highlight'), 2500);
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
  function goHome() {
    if (!state.currentFile) return; // already on home
    state.currentFile = null;

    const welcome = $('welcomeScreen');
    const wrapper = $('contentWrapper');
    const loading = $('contentLoading');

    welcome.style.display = 'flex';
    wrapper.style.display = 'none';
    loading.style.display = 'none';

    // Clear URL query parameters
    const cleanUrl = window.location.pathname;
    history.pushState(null, '', cleanUrl);

    // Reset document title
    document.title = `${state.siteName} — 佛典經論閱讀器`;

    // Remove active file highlight in tree
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
  // TREE VIEW
  // ═══════════════════════════════════════════════════════════

  async function loadTree() {
    const container = $('fileTree');
    try {
      const res = await fetch('/api/tree');
      if (!res.ok) throw new Error('Failed to load tree');
      state.treeData = await res.json();
      buildWikilinkIndex(state.treeData);
      container.innerHTML = '';
      const sorted = sortTreeNodes(state.treeData, state.fileSort);
      renderTreeNodes(sorted, container, 0);
    } catch (err) {
      container.innerHTML = `<div class="panel-placeholder"><span class="placeholder-icon">⚠️</span><span>載入失敗: ${err.message}</span></div>`;
    }
  }

  function renderTreeNodes(nodes, container, level) {
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
        renderTreeNodes(node.children, childrenEl, level + 1);

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

  function sortTreeNodes(nodes, sortMode) {
    // Deep-clone to avoid mutating original data
    const cloned = nodes.map(n => n.children
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
          if (icon) icon.textContent = '\uD83D\uDCC1';
        }
      });
      btn.title = '\u5c55\u958b\u5168\u90e8';
    } else {
      // Expand all
      allFolders.forEach(el => {
        el.classList.add('expanded');
        const row = el.previousElementSibling;
        if (row) {
          const chevron = row.querySelector('.tree-chevron');
          if (chevron) chevron.classList.add('expanded');
          const icon = row.querySelector('.tree-icon');
          if (icon) icon.textContent = '\uD83D\uDCC2';
        }
      });
      btn.title = '\u647a\u758a\u5168\u90e8';
    }
  }

  function highlightActiveFile(path) {
    $$('.tree-item-row.active').forEach((el) => el.classList.remove('active'));
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
    }
  }

  // ═══════════════════════════════════════════════════════════
  // FILE VIEWER
  // ═══════════════════════════════════════════════════════════

  async function openFile(filePath, scrollToLineNum) {
    state.currentFile = filePath;

    addRecentFile(filePath);
    updateBookmarkButtonUI(filePath);
    saveReadProgress(filePath);

    // Update URL search parameters — preserve line param if provided
    const params = new URLSearchParams();
    params.set('file', filePath);
    if (scrollToLineNum) params.set('line', scrollToLineNum);
    const newSearch = '?' + params.toString();
    if (window.location.search !== newSearch) {
      // Clear hash if any, and set search query parameters
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

    // Close page search
    closePageSearch();

    highlightActiveFile(filePath);

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
        if (scrollToLineNum) setTimeout(() => scrollToLine(scrollToLineNum), 80);
        else content.scrollTop = 0;
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
          updateCachedLineAnchors(el);
          const headings = Array.from(el.querySelectorAll('h1, h2, h3, h4, h5, h6'));
          headings.forEach((h, i) => { if (!h.id) h.id = 'heading-' + i; });
          const cachedMeta = renderCache.__meta ? renderCache.__meta.get(filePath) : {};
          renderContentHeader(filePath, cachedMeta || {});
          generateTOC(headings);
          loading.style.display = 'none';
          wrapper.style.display = 'block';
          if (scrollToLineNum) {
            setTimeout(() => scrollToLine(scrollToLineNum), 80);
          } else {
            content.scrollTop = 0;
          }
          document.title = `${(cachedMeta && cachedMeta.title) || filePath.split('/').pop().replace(/\.md$/, '')} — ${state.siteName}`;
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

      // Insert pre-rendered HTML — no client-side parsing
      const el = $('markdownBody');
      el.innerHTML = html;
      
      // Cache line anchors and query headings once
      updateCachedLineAnchors(el);
      const headings = Array.from(el.querySelectorAll('h1, h2, h3, h4, h5, h6'));
      headings.forEach((h, i) => { if (!h.id) h.id = 'heading-' + i; });

      // Cache for instant re-opens
      cacheSet(filePath, html);

      generateTOC(headings);
      loading.style.display = 'none';
      wrapper.style.display = 'block';

      if (scrollToLineNum) {
        setTimeout(() => scrollToLine(scrollToLineNum), 80);
      } else {
        content.scrollTop = 0;
      }

      document.title = `${frontmatter.title || filePath.split('/').pop().replace(/\.md$/, '')} — ${state.siteName}`;
    } catch (err) {
      loading.style.display = 'none';
      wrapper.style.display = 'block';
      $('markdownBody').innerHTML = `<div class="panel-placeholder"><span class="placeholder-icon">⚠️</span><span>載入失敗: ${err.message}</span></div>`;
    }
  }

  function parseFrontmatter(raw) {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) return { frontmatter: {}, body: raw };

    const fm = {};
    match[1].split('\n').forEach((line) => {
      const idx = line.indexOf(':');
      if (idx > 0) {
        const key = line.substring(0, idx).trim();
        let val = line.substring(idx + 1).trim();
        // Remove surrounding quotes
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        fm[key] = val;
      }
    });

    return { frontmatter: fm, body: match[2] };
  }

  function renderContentHeader(filePath, fm) {
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

    // Wire up copy-link button
    const btn = header.querySelector('#copyLinkBtn');
    const lbl = header.querySelector('#copyLinkLabel');
    if (btn) {
      btn.addEventListener('click', () => {
        const url = window.location.href;
        const doConfirm = () => {
          lbl.textContent = '✓ 已複製';
          btn.classList.add('copied');
          setTimeout(() => {
            lbl.textContent = '連結';
            btn.classList.remove('copied');
          }, 2000);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(doConfirm).catch(() => {
            fallbackCopy(url); doConfirm();
          });
        } else {
          fallbackCopy(url); doConfirm();
        }
      });
    }
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
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

  // Inline fallback: runs on main thread (same logic as md-worker.js)
  function inlineParseMarkdown(body) {
    if (!body) return '';

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

    if (!fileName && anchor) {
      // Pure anchor link within current file (e.g. [[#heading]])
      scrollToHeadingByText(anchor.substring(1));
      return;
    }

    // Resolve file name to tree path
    const filePath = wikilinkIndex.get(fileName) || wikilinkIndex.get(fileName.toLowerCase());
    if (!filePath) {
      console.warn(`[Wikilink] Could not resolve "${fileName}" — file not found in tree.`);
      return;
    }

    openFile(filePath).then(() => {
      if (anchor) {
        setTimeout(() => scrollToHeadingByText(anchor.substring(1)), 200);
      }
    });
  }

  /**
   * Scroll to a heading whose text matches the anchor text.
   * Obsidian anchors match by heading textContent, with flexible bracket handling.
   */
  function scrollToHeadingByText(text) {
    if (!text) return;
    const targetText = decodeURIComponent(text).trim();
    const cleanText = targetText.replace(/^【/, '').replace(/】$/, '').trim();

    const headings = $$('h1, h2, h3, h4, h5, h6', $('markdownBody'));
    for (const h of headings) {
      const hText = h.textContent.trim();
      const hCleanText = hText.replace(/^【/, '').replace(/】$/, '').trim();

      if (hText === targetText || hCleanText === cleanText || hText.includes(cleanText) || cleanText.includes(hText)) {
        h.scrollIntoView({ behavior: 'smooth', block: 'start' });
        h.classList.add('highlight-flash');
        setTimeout(() => h.classList.remove('highlight-flash'), 2000);
        return;
      }
    }
    console.warn(`[Wikilink] Heading "${targetText}" not found in document.`);
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
          h.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
      if (btn) btn.title = '摺疊全部';
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
      if (btn) btn.title = '展開全部';
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

    if (searchAbortController) searchAbortController.abort();
    searchAbortController = new AbortController();

    $('searchResults').innerHTML = '<div class="search-loading"><div class="spinner"></div><span>搜尋中…</span></div>';

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
        signal: searchAbortController.signal,
      });
      if (!res.ok) throw new Error('Search failed');
      const data = await res.json();
      renderSearchResults(data);
    } catch (err) {
      if (err.name === 'AbortError') return;
      $('searchResults').innerHTML = `<div class="panel-placeholder"><span class="placeholder-icon">⚠️</span><span>搜尋失敗: ${err.message}</span></div>`;
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

    for (const [file, group] of sortedGroups) {
      parts.push(`<div class="search-result-group">`);
      parts.push(`<div class="search-result-file" data-file-group="${escHtml(file)}">`);
      parts.push(`<span class="search-result-file-chevron expanded">›</span>`);
      parts.push(`<span class="search-result-file-icon">📄</span>${escHtml(group.fileName)}`);
      parts.push(`<span class="search-result-count">${group.items.length}</span></div>`);
      parts.push(`<div class="search-result-group-body">`);
      group.items.forEach((item) => {
        const snippet = highlightSearchTerm(item.snippet, data.query);
        parts.push(`
          <div class="search-result-item" data-file="${escHtml(item.file)}" data-line="${item.line}">
            <span class="search-result-line">第 ${item.line} 行</span>
            <span class="search-result-snippet">${snippet}</span>
          </div>`);
      });
      parts.push(`</div></div>`);
    }

    container.innerHTML = parts.join('');

    // Event delegation: single click handler for all search result interactions
    container.addEventListener('click', (e) => {
      // Collapse toggle on file header click
      const fileEl = e.target.closest('.search-result-file');
      if (fileEl) {
        const body = fileEl.nextElementSibling;
        const chevron = fileEl.querySelector('.search-result-file-chevron');
        if (body) {
          body.classList.toggle('collapsed');
          if (chevron) chevron.classList.toggle('collapsed');
        }
        return;
      }
      // Open-file click on result items
      const itemEl = e.target.closest('.search-result-item');
      if (itemEl) {
        const file = itemEl.getAttribute('data-file');
        openFile(file);
      }
    });
  }

  function searchCollapseAll() {
    const btn = $('searchCollapseAllBtn');
    const bodies = $$('.search-result-group-body', $('searchResults'));
    const anyExpanded = Array.from(bodies).some(el => !el.classList.contains('collapsed'));

    if (anyExpanded) {
      // Collapse all
      bodies.forEach(el => el.classList.add('collapsed'));
      $$('.search-result-file-chevron', $('searchResults')).forEach(el => el.classList.add('collapsed'));
      btn.title = '\u5c55\u958b\u5168\u90e8';
    } else {
      // Expand all
      bodies.forEach(el => el.classList.remove('collapsed'));
      $$('.search-result-file-chevron', $('searchResults')).forEach(el => el.classList.remove('collapsed'));
      btn.title = '\u647a\u758a\u5168\u90e8';
    }
  }

  function highlightSearchTerm(text, query) {
    const escaped = escHtml(text);
    const queryEscaped = escHtml(query);
    const regex = new RegExp(`(${escRegex(queryEscaped)})`, 'gi');
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

  function doPageSearch(query) {
    clearPageHighlights();
    state.pageSearchMatches = [];
    state.pageSearchIndex = -1;

    if (!query || query.trim().length === 0) {
      $('pageSearchCount').textContent = '';
      return;
    }

    const body = $('markdownBody');
    if (!body || !body.textContent) return;

    const matches = highlightTextNodes(body, query);
    state.pageSearchMatches = matches;

    if (matches.length > 0) {
      state.pageSearchIndex = 0;
      matches[0].classList.add('active');
      matches[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    $('pageSearchCount').textContent = matches.length > 0 ? `1/${matches.length}` : '0/0';
  }

  function navigatePageSearch(direction) {
    const matches = state.pageSearchMatches;
    if (matches.length === 0) return;

    // Remove current active
    if (state.pageSearchIndex >= 0 && state.pageSearchIndex < matches.length) {
      matches[state.pageSearchIndex].classList.remove('active');
    }

    // Move index
    state.pageSearchIndex += direction;
    if (state.pageSearchIndex >= matches.length) state.pageSearchIndex = 0;
    if (state.pageSearchIndex < 0) state.pageSearchIndex = matches.length - 1;

    // Set new active
    matches[state.pageSearchIndex].classList.add('active');
    matches[state.pageSearchIndex].scrollIntoView({ behavior: 'smooth', block: 'center' });

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
    const marks = $$('.search-highlight', $('markdownBody'));
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

  function applyTheme(theme, saveToLocalStorage = true) {
    document.documentElement.setAttribute('data-theme', theme);
    const select = $('themeSelect');
    if (select) select.value = theme;
    const settingSelect = $('settingThemeSelect');
    if (settingSelect) settingSelect.value = theme;

    if (saveToLocalStorage) {
      localStorage.setItem('mdWebview-user-theme', theme);
    }
    state.currentTheme = theme;
  }

  // ═══════════════════════════════════════════════════════════
  // FONT SIZE
  // ═══════════════════════════════════════════════════════════

  function applyFontSize(size, saveToLocalStorage = true) {
    size = Math.max(12, Math.min(28, size));
    state.fontSize = size;
    document.documentElement.style.setProperty('--content-font-size', size + 'px');
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

  function applyMaxWidth(mw, saveToLocalStorage = true) {
    if (!mw) mw = '800px';
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

  // ── Bookmarks ──────────────────────────────────────────────
  function toggleBookmark(filePath, title) {
    if (!filePath) return;
    const fileName = title || filePath.split('/').pop().replace(/\.md$/, '');
    let list = state.bookmarks || [];
    const idx = list.findIndex(item => item.filePath === filePath);
    let isBookmarked = false;

    if (idx >= 0) {
      list.splice(idx, 1);
      isBookmarked = false;
    } else {
      list.unshift({
        filePath,
        fileName,
        time: new Date().toLocaleDateString('zh-TW')
      });
      isBookmarked = true;
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
    const container = $('bookmarksList');
    if (!container) return;

    const list = state.bookmarks || [];
    if (list.length === 0) {
      container.innerHTML = `<div class="list-empty-hint">尚無收藏書籤。開啟經文時點擊標題旁邊的 🔖 按鈕即可新增書籤。</div>`;
      return;
    }

    let html = '';
    list.forEach(item => {
      html += `
        <div class="list-item-row" data-file="${escHtml(item.filePath)}">
          <span class="list-item-title">🔖 ${escHtml(item.fileName)}</span>
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

  // ── Read Progress Auto-Save / Restore ─────────────────────
  let _saveProgressTimer = null;
  function saveReadProgress(filePath) {
    if (!filePath || !state.autoReadProgress) return;
    if (_saveProgressTimer) clearTimeout(_saveProgressTimer);
    _saveProgressTimer = setTimeout(() => {
      const content = $('content');
      const progress = {
        filePath,
        scrollTop: content ? content.scrollTop : 0,
        timestamp: Date.now()
      };
      localStorage.setItem('mdWebview-last-read-progress', JSON.stringify(progress));
    }, 400);
  }

  function restoreReadProgress() {
    if (!state.autoReadProgress) return false;
    const raw = localStorage.getItem('mdWebview-last-read-progress');
    if (!raw) return false;
    try {
      const data = JSON.parse(raw);
      if (data && data.filePath) {
        openFile(data.filePath).then(() => {
          const content = $('content');
          if (content && data.scrollTop) {
            setTimeout(() => { content.scrollTop = data.scrollTop; }, 120);
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
        applyTheme(e.target.value);
      });
    }

    // ── Footnotes Click Delegation ──
    $('markdownBody').addEventListener('click', (e) => {
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
          targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
          targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          targetEl.classList.add('highlight-flash');
          setTimeout(() => {
            targetEl.classList.remove('highlight-flash');
          }, 2000);
        }
      }
    });

    // ── Font size ──
    const fontDec = $('fontDecrease');
    if (fontDec) fontDec.addEventListener('click', () => applyFontSize(state.fontSize - 1));
    const fontInc = $('fontIncrease');
    if (fontInc) fontInc.addEventListener('click', () => applyFontSize(state.fontSize + 1));

    // ── Global search ──
    const debouncedSearch = debounce(performGlobalSearch, 400);
    $('globalSearchInput').addEventListener('input', (e) => {
      debouncedSearch(e.target.value);
    });
    $('globalSearchInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        performGlobalSearch(e.target.value);
      }
    });
    $('globalSearchBtn').addEventListener('click', () => {
      performGlobalSearch($('globalSearchInput').value);
    });

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

    // ── Keyboard shortcuts ──
    document.addEventListener('keydown', (e) => {
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

    // ── Back to top ──
    const backToTop = $('backToTop');
    const contentEl = $('content');
    let scrollRafPending = false;
    contentEl.addEventListener('scroll', () => {
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
        }
      });
    }

    const clearBkmBtn = $('clearBookmarksBtn');
    if (clearBkmBtn) {
      clearBkmBtn.addEventListener('click', () => {
        if (confirm('確定要清除所有經文書籤與最愛？')) {
          state.bookmarks = [];
          localStorage.removeItem('mdWebview-user-bookmarks');
          renderBookmarksList();
          if (state.currentFile) updateBookmarkButtonUI(state.currentFile);
        }
      });
    }

    // Modal Close
    $('userSettingsCloseBtn').addEventListener('click', () => {
      $('userSettingsOverlay').style.display = 'none';
    });
    $('userSettingsDoneBtn').addEventListener('click', () => {
      $('userSettingsOverlay').style.display = 'none';
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
        
        // Open settings panel
        await openSettingsOverlay();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.style.display = 'block';
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
              enableVersion, version, enableDownload, downloadUrl 
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
            localStorage.removeItem('mdWebview-user-fontsize');
            applyFontSize(data.settings.defaultFontSize, false);
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

        if (closeAfterSave) {
          $('adminSettingsOverlay').style.display = 'none';
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
      $('adminSettingsOverlay').style.display = 'none';
    });

    $('settingsCloseBtn').addEventListener('click', () => {
      $('adminSettingsOverlay').style.display = 'none';
    });

    // ── Logout ──
    $('settingsLogoutBtn').addEventListener('click', async () => {
      try {
        await fetch('/api/admin/logout', {
          method: 'POST',
          headers: { 'X-Admin-Token': state.adminToken }
        });
      } catch (err) {
        console.error('Logout request failed:', err);
      }
      state.adminToken = null;
      localStorage.removeItem('mdWebview-admin-token');
      $('adminSettingsOverlay').style.display = 'none';
    });
  }

  function openUserSettingsOverlay() {
    renderRecentFilesList();
    renderBookmarksList();

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
  }

  // ── Helper functions for admin panels ──
  function openLoginOverlay() {
    $('loginUsername').value = '';
    $('loginPassword').value = '';
    $('loginErrorMsg').style.display = 'none';
    $('adminLoginOverlay').style.display = 'flex';
  }

  async function openSettingsOverlay() {
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
        $('adminSettingsOverlay').style.display = 'none';
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
      $('adminSettingsOverlay').style.display = 'flex';
    } catch (err) {
      console.error('Error fetching settings:', err);
    }
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

        // Update share link
        // Construct the URL using query parameters: ?file=...&line=...
        const baseUrl = window.location.origin + window.location.pathname;
        const params = new URLSearchParams();
        params.set('file', state.currentFile);
        params.set('line', lineNum);
        currentShareUrl = `${baseUrl}?${params.toString()}`;

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
      navigator.clipboard.writeText(currentShareUrl).then(() => {
        shareLabel.textContent = '✓ 已複製';
        shareBtn.classList.add('copied');
        setTimeout(() => {
          popup.classList.remove('visible');
        }, 1500);
      }).catch(() => {
        fallbackCopy(currentShareUrl);
        shareLabel.textContent = '✓ 已複製';
        shareBtn.classList.add('copied');
        setTimeout(() => {
          popup.classList.remove('visible');
        }, 1500);
      });
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
