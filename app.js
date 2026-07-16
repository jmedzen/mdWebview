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
  };

  // ── DOM Helpers ───────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const $$ = (sel, root) => (root || document).querySelectorAll(sel);

  // ── Init ──────────────────────────────────────────────────
  async function init() {
    await checkAdminStatus();
    applyTheme(state.currentTheme);
    applyFontSize(state.fontSize);
    setupEventListeners();
    await loadTree();
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
      renderTreeNodes(state.treeData, container, 0);
    } catch (err) {
      container.innerHTML = `<div class="panel-placeholder"><span class="placeholder-icon">⚠️</span><span>載入失敗: ${err.message}</span></div>`;
    }
  }

  function renderTreeNodes(nodes, container, level) {
    nodes.forEach((node, idx) => {
      const item = document.createElement('div');
      item.className = 'tree-item';
      item.style.animationDelay = `${Math.min(idx * 15, 300)}ms`;

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

  function countFiles(node) {
    if (node.type === 'file') return 1;
    return (node.children || []).reduce((sum, c) => sum + countFiles(c), 0);
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

  async function openFile(filePath) {
    if (state.currentFile === filePath) return;
    state.currentFile = filePath;

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
      const res = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`);
      if (!res.ok) throw new Error('File not found');
      const data = await res.json();

      const { frontmatter, body } = parseFrontmatter(data.content);
      renderContentHeader(filePath, frontmatter);
      await renderMarkdown(body);
      generateTOC();

      loading.style.display = 'none';
      wrapper.style.display = 'block';
      content.scrollTop = 0;

      // Update page title
      const title = frontmatter.title || filePath.split('/').pop().replace(/\.md$/, '');
      document.title = `${title} — ${state.siteName}`;
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

    let html = `<div class="file-path">${escHtml(folder ? folder + ' / ' + fileName : fileName)}</div>`;
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
  }

  async function renderMarkdown(body) {
    const el = $('markdownBody');

    // Configure marked
    marked.setOptions({
      breaks: false,
      gfm: true,
      headerIds: true,
      mangle: false,
    });

    // ── Extract footnote definitions from the markdown ──
    const lines = body.split('\n');
    const cleanLines = [];
    const footnotes = []; // array of { id, text }
    const footnoteMap = {};
    let currentFootnote = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match [^id]: text
      const match = line.match(/^\[\^([^\]]+)\]:\s*(.*)$/);
      if (match) {
        const id = match[1];
        const text = match[2];
        currentFootnote = { id, text: [text] };
        footnotes.push(currentFootnote);
        footnoteMap[id] = currentFootnote;
      } else if (currentFootnote && (line.startsWith('    ') || line.startsWith('\t'))) {
        // continuation of footnote text
        currentFootnote.text.push(line);
      } else if (currentFootnote && line.trim() === '') {
        // Lookahead to see if next line is indented or another footnote
        let isContinuation = false;
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].trim() === '') continue;
          if (lines[j].startsWith('    ') || lines[j].startsWith('\t')) {
            isContinuation = true;
          }
          break;
        }
        if (isContinuation) {
          currentFootnote.text.push(line);
        } else {
          currentFootnote = null;
          cleanLines.push(line);
        }
      } else {
        currentFootnote = null;
        cleanLines.push(line);
      }
    }

    const cleanBody = cleanLines.join('\n');

    // Render the main markdown body
    let html = marked.parse(cleanBody);

    // ── Process footnote references [^id] in the main body ──
    const refCounter = {};
    html = html.replace(/\[\^([^\]]+)\]/g, (match, id) => {
      if (!refCounter[id]) {
        refCounter[id] = 0;
      }
      refCounter[id]++;
      const refId = `fn-ref-${id}-${refCounter[id]}`;
      return `<a href="#fn-def-${id}" id="${refId}" class="footnote-ref" title="註 ${id}">[${id}]</a>`;
    });

    // ── Render and append footnotes section ──
    if (footnotes.length > 0) {
      let footnotesHtml = '<div class="footnotes"><hr class="footnotes-divider"><ul class="footnotes-list">';
      
      footnotes.forEach((fn) => {
        const id = fn.id;
        const fnText = fn.text.join('\n').trim();
        let fnRendered = marked.parse(fnText).trim();
        
        // Generate backlink(s)
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

        // Insert backlink into the last closing </p>
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

    el.innerHTML = html;

    // Add IDs to headings for scroll spy
    const headings = el.querySelectorAll('h1, h2, h3, h4, h5, h6');
    headings.forEach((h, i) => {
      if (!h.id) {
        h.id = 'heading-' + i;
      }
    });
  }

  // ═══════════════════════════════════════════════════════════
  // TABLE OF CONTENTS
  // ═══════════════════════════════════════════════════════════

  function generateTOC() {
    const tocList = $('tocList');
    const headings = $$('h1, h2, h3, h4, h5, h6', $('markdownBody'));

    if (headings.length === 0) {
      tocList.innerHTML = '<div class="panel-placeholder"><span class="placeholder-icon">📑</span><span>此文件沒有標題</span></div>';
      return;
    }

    tocList.innerHTML = '';
    headings.forEach((h) => {
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
      tocList.appendChild(item);
    });

    setupScrollSpy();
  }

  function setupScrollSpy() {
    if (state.scrollSpyObserver) {
      state.scrollSpyObserver.disconnect();
    }

    const tocItems = $$('.toc-item', $('tocList'));
    if (tocItems.length === 0) return;

    const headings = $$('h1, h2, h3, h4, h5, h6', $('markdownBody'));

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const id = entry.target.id;
            tocItems.forEach((item) => {
              item.classList.toggle('active', item.getAttribute('data-target') === id);
            });
            // Scroll TOC item into view
            const activeItem = document.querySelector('.toc-item.active');
            if (activeItem) {
              activeItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
          }
        });
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

    if (data.results.length === 0) {
      container.innerHTML = '<div class="panel-placeholder"><span class="placeholder-icon">🔍</span><span>沒有找到結果</span></div>';
      return;
    }

    let html = `<div class="search-status">找到 ${data.total} 個結果${data.capped ? '（已達上限）' : ''}</div>`;

    // Group by file
    const groups = {};
    data.results.forEach((r) => {
      if (!groups[r.file]) groups[r.file] = { fileName: r.fileName, items: [] };
      groups[r.file].items.push(r);
    });

    for (const [file, group] of Object.entries(groups)) {
      html += `<div class="search-result-group">`;
      html += `<div class="search-result-file"><span class="search-result-file-icon">📄</span>${escHtml(group.fileName)}</div>`;
      group.items.forEach((item) => {
        const snippet = highlightSearchTerm(item.snippet, data.query);
        html += `
          <div class="search-result-item" data-file="${escHtml(item.file)}" data-line="${item.line}">
            <span class="search-result-line">第 ${item.line} 行</span>
            <span class="search-result-snippet">${snippet}</span>
          </div>`;
      });
      html += `</div>`;
    }

    container.innerHTML = html;

    // Add click handlers
    $$('.search-result-item', container).forEach((el) => {
      el.addEventListener('click', () => {
        const file = el.getAttribute('data-file');
        openFile(file);
      });
    });
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
    marks.forEach((mark) => {
      const parent = mark.parentNode;
      if (parent) {
        parent.replaceChild(document.createTextNode(mark.textContent), mark);
        parent.normalize();
      }
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
    contentEl.addEventListener('scroll', () => {
      backToTop.classList.toggle('visible', contentEl.scrollTop > 400);
    });
    backToTop.addEventListener('click', () => {
      contentEl.scrollTo({ top: 0, behavior: 'smooth' });
    });

    // ── Sidebar resize ──
    setupResizeHandle();

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
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function escRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // ── Boot ──────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', init);
})();
