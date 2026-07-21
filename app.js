/* ================================================================
   mdWebview — Application Logic
   Tree · Viewer · Search · Theme · FontSize
   ================================================================ */

(function () {
  'use strict';

  // ── State ─────────────────────────────────────────────────
  const state = {
    currentFile: null,
    currentTheme: localStorage.getItem('mdWebview-theme') || 'obsidian-dark',
    fontSize: parseInt(localStorage.getItem('mdWebview-fontsize')) || 16,
    sidebarTab: 'files',
    sidebarCollapsed: false,
    treeData: null,
    pageSearchMatches: [],
    pageSearchIndex: -1,
    scrollSpyObserver: null,
    adminToken: localStorage.getItem('mdWebview-admin-token') || null,
    siteName: 'mdWebview',
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
    applyTheme(state.currentTheme);
    applyFontSize(state.fontSize);
    setupEventListeners();
    await loadTree();

    // Open file from URL query or hash on first load
    const urlInfo = getFileFromURL();
    if (urlInfo) {
      await openFile(urlInfo.file, urlInfo.line);
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

      // If client doesn't have custom font size / theme settings saved in localStorage,
      // load default settings configured by the server.
      if (!localStorage.getItem('mdWebview-fontsize') && data.settings && data.settings.defaultFontSize) {
        state.fontSize = data.settings.defaultFontSize;
      }
      if (!localStorage.getItem('mdWebview-theme') && data.settings && data.settings.defaultTheme) {
        state.currentTheme = data.settings.defaultTheme;
      }
      if (data.settings && data.settings.siteName) {
        state.siteName = data.settings.siteName;
        updateSiteNameUI();
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

  // ═══════════════════════════════════════════════════════════
  // TREE VIEW
  // ═══════════════════════════════════════════════════════════

  async function loadTree() {
    const container = $('fileTree');
    try {
      const res = await fetch('/api/tree');
      if (!res.ok) throw new Error('Failed to load tree');
      state.treeData = await res.json();
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
    if (state.currentFile === filePath && !scrollToLineNum) return;
    state.currentFile = filePath;

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
    const lines = body.split('\n');
    const cleanLines = [];
    const footnotes = [];
    const footnoteMap = {};
    let currentFootnote = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = line.match(/^\[\^([^\]]+)\]:\s*(.*)$/);
      if (match) {
        const id = match[1]; const text = match[2];
        currentFootnote = { id, text: [text] };
        footnotes.push(currentFootnote);
        footnoteMap[id] = currentFootnote;
      } else if (currentFootnote && (line.startsWith('    ') || line.startsWith('\t'))) {
        currentFootnote.text.push(line);
      } else if (currentFootnote && line.trim() === '') {
        let isContinuation = false;
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].trim() === '') continue;
          if (lines[j].startsWith('    ') || lines[j].startsWith('\t')) isContinuation = true;
          break;
        }
        if (isContinuation) { currentFootnote.text.push(line); }
        else { currentFootnote = null; cleanLines.push(line); }
      } else { currentFootnote = null; cleanLines.push(line); }
    }

    const bodyLines = cleanLines;
    const annotatedLines = [];
    let prevWasBlank = true;
    bodyLines.forEach((line, idx) => {
      const lineNum = idx + 1;
      const trimmed = line.trim();
      const isBlockStart = /^#{1,6}\s/.test(trimmed) || /^[-*+]\s/.test(trimmed) ||
        /^\d+\.\s/.test(trimmed) || /^>/.test(trimmed) || /^```/.test(trimmed) ||
        (prevWasBlank && trimmed.length > 0);
      if (isBlockStart) annotatedLines.push(`<span id="L${lineNum}" data-line="${lineNum}" class="line-anchor"></span>`);
      annotatedLines.push(line);
      prevWasBlank = trimmed.length === 0;
    });

    let html = marked.parse(annotatedLines.join('\n'));
    const refCounter = {};
    html = html.replace(/\[\^([^\]]+)\]/g, (m, id) => {
      if (!refCounter[id]) refCounter[id] = 0;
      refCounter[id]++;
      return `<a href="#fn-def-${id}" id="fn-ref-${id}-${refCounter[id]}" class="footnote-ref" title="註 ${id}">[${id}]</a>`;
    });

    if (footnotes.length > 0) {
      let fhtml = '<div class="footnotes"><hr class="footnotes-divider"><ul class="footnotes-list">';
      footnotes.forEach((fn) => {
        const id = fn.id;
        let fnRendered = marked.parse(fn.text.join('\n').trim()).trim();
        const count = refCounter[id] || 0;
        let bl = count === 1 ? ` <a href="#fn-ref-${id}-1" class="footnote-backlink" title="返回">↩</a>` : '';
        if (count > 1) { bl = ' '; for (let r = 1; r <= count; r++) bl += `<a href="#fn-ref-${id}-${r}" class="footnote-backlink">↩<sup>${r}</sup></a> `; }
        if (fnRendered.includes('</p>')) { const li = fnRendered.lastIndexOf('</p>'); fnRendered = fnRendered.slice(0,li)+bl+fnRendered.slice(li); } else fnRendered += bl;
        fhtml += `<li class="footnote-item" id="fn-def-${id}" data-id="${id}"><span class="footnote-label">[${id}]</span><div class="footnote-item-content">${fnRendered}</div></li>`;
      });
      fhtml += '</ul></div>';
      html += fhtml;
    }
    return html;
  }

  // ═══════════════════════════════════════════════════════════
  // TABLE OF CONTENTS
  // ═══════════════════════════════════════════════════════════

  function generateTOC(headings) {
    const tocList = $('tocList');
    headings = headings || $$('h1, h2, h3, h4, h5, h6', $('markdownBody'));

    if (headings.length === 0) {
      tocList.innerHTML = '<div class="panel-placeholder"><span class="placeholder-icon">📑</span><span>此文件沒有標題</span></div>';
      return;
    }

    tocList.innerHTML = '';

    // Detect the shallowest heading level in this document (H1, or H2 if no H1, etc.)
    const minLevel = Math.min(...Array.from(headings).map(h => parseInt(h.tagName.charAt(1))));

    // Group by top-level heading: each one starts a new collapsible section
    const groups = []; // [{leader: element|null, items: [heading...]}, ...]
    let currentGroup = null;

    headings.forEach(h => {
      const level = parseInt(h.tagName.charAt(1));
      if (level === minLevel) {
        currentGroup = { leader: h, items: [] };
        groups.push(currentGroup);
      } else {
        if (!currentGroup) {
          currentGroup = { leader: null, items: [] };
          groups.push(currentGroup);
        }
        currentGroup.items.push(h);
      }
    });

    const fragment = document.createDocumentFragment();
    groups.forEach(group => {
      if (group.leader) {
        const groupEl = document.createElement('div');
        groupEl.className = 'toc-group';

        const headerBtn = document.createElement('button');
        headerBtn.className = 'toc-group-header';
        const chevron = document.createElement('span');
        chevron.className = 'toc-group-chevron expanded';
        chevron.textContent = '›';
        const label = document.createElement('span');
        label.textContent = group.leader.textContent;
        label.title = group.leader.textContent;
        label.style.flex = '1';
        label.style.overflow = 'hidden';
        label.style.textOverflow = 'ellipsis';
        label.style.whiteSpace = 'nowrap';
        headerBtn.appendChild(chevron);
        headerBtn.appendChild(label);

        const children = document.createElement('div');
        children.className = 'toc-group-children expanded';

        headerBtn.addEventListener('click', () => {
          group.leader.scrollIntoView({ behavior: 'smooth', block: 'start' });
          const isExpanded = children.classList.contains('expanded');
          if (isExpanded) {
            children.classList.remove('expanded');
            chevron.classList.remove('expanded');
          } else {
            children.classList.add('expanded');
            chevron.classList.add('expanded');
          }
        });

        group.items.forEach(h => {
          children.appendChild(makeTocItem(h));
        });

        groupEl.appendChild(headerBtn);
        groupEl.appendChild(children);
        fragment.appendChild(groupEl);
      } else {
        // Items before first top-level heading — render flat
        group.items.forEach(h => fragment.appendChild(makeTocItem(h)));
      }
    });

    tocList.appendChild(fragment);

    setupScrollSpy(headings);
  }

  function makeTocItem(h) {
    const level = parseInt(h.tagName.charAt(1));
    const item = document.createElement('a');
    item.className = 'toc-item';
    item.setAttribute('data-level', level);
    item.setAttribute('data-target', h.id);
    item.textContent = h.textContent;
    item.title = h.textContent;
    item.addEventListener('click', (e) => {
      e.preventDefault();
      h.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    return item;
  }

  function tocCollapseAll() {
    const btn = $('tocCollapseAllBtn');
    const groups = $$('.toc-group-children', $('tocList'));
    const anyExpanded = Array.from(groups).some(el => el.classList.contains('expanded'));

    if (anyExpanded) {
      // Collapse all
      groups.forEach(el => el.classList.remove('expanded'));
      $$('.toc-group-chevron', $('tocList')).forEach(el => el.classList.remove('expanded'));
      btn.title = '展開全部';
    } else {
      // Expand all
      groups.forEach(el => el.classList.add('expanded'));
      $$('.toc-group-chevron', $('tocList')).forEach(el => el.classList.add('expanded'));
      btn.title = '摺疊全部';
    }
  }

  function setupScrollSpy(headings) {
    if (state.scrollSpyObserver) {
      state.scrollSpyObserver.disconnect();
    }

    const tocList = $('tocList');
    const tocItems = $$('.toc-item', tocList);
    if (tocItems.length === 0) return;

    headings = headings || $$('h1, h2, h3, h4, h5, h6', $('markdownBody'));

    // Create a fast lookup map targetId -> tocItem element for O(1) active class setting
    const tocMap = new Map();
    tocItems.forEach((item) => {
      const target = item.getAttribute('data-target');
      if (target) tocMap.set(target, item);
    });

    let currentActiveItem = tocList.querySelector('.toc-item.active');
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

            // Debounce active item scroll-into-view to avoid stutter/competing scroll animations
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

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    $('themeSelect').value = theme;
    localStorage.setItem('mdWebview-theme', theme);
    state.currentTheme = theme;
  }

  // ═══════════════════════════════════════════════════════════
  // FONT SIZE
  // ═══════════════════════════════════════════════════════════

  function applyFontSize(size) {
    size = Math.max(12, Math.min(28, size));
    state.fontSize = size;
    document.documentElement.style.setProperty('--content-font-size', size + 'px');
    $('fontSizeDisplay').textContent = size;
    localStorage.setItem('mdWebview-fontsize', size);
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
    $('themeSelect').addEventListener('change', (e) => {
      applyTheme(e.target.value);
    });

    // ── Footnotes Click Delegation ──
    $('markdownBody').addEventListener('click', (e) => {
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
    $('fontDecrease').addEventListener('click', () => applyFontSize(state.fontSize - 1));
    $('fontIncrease').addEventListener('click', () => applyFontSize(state.fontSize + 1));

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

    // ── Admin Button Click ──
    $('adminSettingsBtn').addEventListener('click', async () => {
      if (state.adminToken) {
        await openSettingsOverlay();
      } else {
        openLoginOverlay();
      }
    });

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
    $('adminLoginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
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
    });

    $('loginCancelBtn').addEventListener('click', () => {
      $('adminLoginOverlay').style.display = 'none';
    });

    // ── Settings Form Submission ──
    $('adminSettingsForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const siteName = $('settingsSiteName').value;
      const mdRoot = $('settingsMdRoot').value;
      const defaultFontSize = parseInt($('settingsFontSize').value);
      const defaultTheme = $('settingsTheme').value;
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
            settings: { siteName, mdRoot, defaultFontSize, defaultTheme }
          })
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || '儲存失敗');
        }
        errorEl.style.display = 'none';
        successEl.textContent = '設定已成功儲存';
        successEl.style.display = 'block';
        setTimeout(() => {
          successEl.style.display = 'none';
        }, 3000);

        if (data.settings && data.settings.siteName) {
          state.siteName = data.settings.siteName;
          updateSiteNameUI();
        }

        // Reload the file tree and update UI with new paths
        await loadTree();
      } catch (err) {
        successEl.style.display = 'none';
        errorEl.textContent = err.message;
        errorEl.style.display = 'block';
      }
    });

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
