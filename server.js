const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { marked } = require('marked');  // Server-side Markdown rendering

// Configure marked once at startup
marked.setOptions({ breaks: false, gfm: true, headerIds: true, mangle: false });

const PORT = process.env.PORT || 8330;
const APP_ROOT = path.resolve(process.cwd());
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(APP_ROOT, 'config.json');

let config = {
  admin: null, // { username, passwordHash, salt }
  settings: {
    mdRoot: process.env.MD_ROOT || path.join(APP_ROOT, 'md'),
    defaultFontSize: 16,
    defaultTheme: 'obsidian-dark',
    siteName: 'mdWebview'
  }
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed.settings) {
        config.settings = { ...config.settings, ...parsed.settings };
      }
      if (parsed.admin) {
        config.admin = parsed.admin;
      }
    }
  } catch (err) {
    console.error('Error loading config:', err);
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error saving config:', err);
  }
}

loadConfig();

function getMdRoot() {
  return config.settings.mdRoot;
}

// MIME types
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

// Security Headers
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' fonts.googleapis.com; font-src 'self' fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'"
};

function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, Object.assign({
    'Content-Type': 'application/json; charset=utf-8'
  }, SECURITY_HEADERS));
  res.end(JSON.stringify(data));
}

// ── API: Directory Tree ──────────────────────────────────────
function handleTree(req, res) {
  function scanDir(dir, relativePath) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return [];
    }
    const result = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = relativePath ? relativePath + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {
        const children = scanDir(fullPath, relPath);
        if (children.length > 0) {
          result.push({
            name: entry.name,
            path: relPath,
            type: 'directory',
            children: children,
          });
        }
      } else if (entry.name.endsWith('.md')) {
        result.push({
          name: entry.name.replace(/\.md$/, ''),
          path: relPath,
          type: 'file',
        });
      }
    }
    result.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-TW', { numeric: true, sensitivity: 'base' });
    });
    return result;
  }

  try {
    const tree = scanDir(getMdRoot(), '');
    sendJSON(res, 200, tree);
  } catch (err) {
    sendJSON(res, 500, { error: err.message });
  }
}

// ── API: File Content ────────────────────────────────────────
function handleFile(req, res, query) {
  const filePath = query.path;
  if (!filePath) {
    return sendJSON(res, 400, { error: 'Missing path parameter' });
  }

  const line = query.line;
  if (line) {
    console.log(`[API File] Reading file "${filePath}" with requested line: ${line}`);
  }

  if (filePath.includes('\0')) {
    return sendJSON(res, 400, { error: 'Invalid path' });
  }

  const fullPath = path.join(getMdRoot(), filePath);
  const resolved = path.resolve(fullPath);

  // Check for path traversal using path.relative to prevent partial-name matching
  const relative = path.relative(getMdRoot(), resolved);
  const isSafe = !relative.startsWith('..') && !path.isAbsolute(relative);

  if (!isSafe) {
    return sendJSON(res, 403, { error: 'Access denied' });
  }

  try {
    const raw = fs.readFileSync(resolved, 'utf-8');
    // Return both raw content (for search/edit) and pre-rendered HTML
    sendJSON(res, 200, { content: raw, path: filePath, line: line || null });
  } catch (err) {
    sendJSON(res, 404, { error: 'File not found: ' + filePath });
  }
}

// ── Render: Server-Side Markdown → HTML ─────────────────────
function renderMarkdownSSR(body) {
  // 1. Extract footnotes
  const lines = body.split('\n');
  const cleanLines = [];
  const footnotes = [];
  const footnoteMap = {};
  let currentFootnote = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^\[\^([^\]]+)\]:\s*(.*)$/);
    if (match) {
      const id = match[1], text = match[2];
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

  // 2. Inject line-number anchors
  const bodyLines = cleanLines.join('\n').split('\n');
  const annotatedLines = [];
  let prevWasBlank = true;
  bodyLines.forEach((line, idx) => {
    const lineNum = idx + 1;
    const trimmed = line.trim();
    const isBlockStart = /^#{1,6}\s/.test(trimmed) || /^[-*+]\s/.test(trimmed) ||
      /^\d+\.\s/.test(trimmed) || /^>/.test(trimmed) || /^```/.test(trimmed) ||
      (prevWasBlank && trimmed.length > 0);
    if (isBlockStart)
      annotatedLines.push(`<span id="L${lineNum}" data-line="${lineNum}" class="line-anchor"></span>`);
    annotatedLines.push(line);
    prevWasBlank = trimmed.length === 0;
  });

  // 3. Parse main body
  let html = marked.parse(annotatedLines.join('\n'));

  // 4. Footnote references
  const refCounter = {};
  html = html.replace(/\[\^([^\]]+)\]/g, (m, id) => {
    if (!refCounter[id]) refCounter[id] = 0;
    refCounter[id]++;
    return `<a href="#fn-def-${id}" id="fn-ref-${id}-${refCounter[id]}" class="footnote-ref" title="\u8a3b ${id}">[${id}]</a>`;
  });

  // 5. Footnotes section
  if (footnotes.length > 0) {
    let fhtml = '<div class="footnotes"><hr class="footnotes-divider"><ul class="footnotes-list">';
    footnotes.forEach((fn) => {
      const id = fn.id;
      let fnRendered = marked.parse(fn.text.join('\n').trim()).trim();
      const count = refCounter[id] || 0;
      let bl = count === 1 ? ` <a href="#fn-ref-${id}-1" class="footnote-backlink" title="\u8fd4\u56de">↩</a>` : '';
      if (count > 1) { bl = ' '; for (let r = 1; r <= count; r++) bl += `<a href="#fn-ref-${id}-${r}" class="footnote-backlink">↩<sup>${r}</sup></a> `; }
      if (fnRendered.includes('</p>')) { const li = fnRendered.lastIndexOf('</p>'); fnRendered = fnRendered.slice(0,li)+bl+fnRendered.slice(li); } else fnRendered += bl;
      fhtml += `<li class="footnote-item" id="fn-def-${id}" data-id="${id}"><span class="footnote-label">[${id}]</span><div class="footnote-item-content">${fnRendered}</div></li>`;
    });
    fhtml += '</ul></div>';
    html += fhtml;
  }

  return html;
}

function handleRender(req, res, query) {
  const filePath = query.path;
  if (!filePath || filePath.includes('\0')) {
    return sendJSON(res, 400, { error: 'Invalid path' });
  }

  const fullPath = path.join(getMdRoot(), filePath);
  const resolved = path.resolve(fullPath);
  const relative = path.relative(getMdRoot(), resolved);
  const isSafe = !relative.startsWith('..') && !path.isAbsolute(relative);
  if (!isSafe) return sendJSON(res, 403, { error: 'Access denied' });

  try {
    let raw = fs.readFileSync(resolved, 'utf-8');

    // Strip frontmatter before rendering
    let frontmatter = {};
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (fmMatch) {
      fmMatch[1].split('\n').forEach((l) => {
        const [k, ...v] = l.split(':');
        if (k && v.length) frontmatter[k.trim()] = v.join(':').trim();
      });
      raw = fmMatch[2];
    }

    const html = renderMarkdownSSR(raw);
    sendJSON(res, 200, { html, frontmatter, path: filePath, line: query.line || null });
  } catch (err) {
    sendJSON(res, 404, { error: 'File not found: ' + filePath });
  }
}

// ── API: Full-text Search ────────────────────────────────────
function handleSearch(req, res, query) {
  const q = query.q;
  if (!q || q.trim().length === 0) {
    return sendJSON(res, 400, { error: 'Missing query parameter' });
  }

  const results = [];
  const MAX_RESULTS = 150;
  const SNIPPET_RADIUS = 60;

  function searchDir(dir, relativePath) {
    if (results.length >= MAX_RESULTS) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return;
    }
    for (const entry of entries) {
      if (results.length >= MAX_RESULTS) return;
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = relativePath ? relativePath + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {
        searchDir(fullPath, relPath);
      } else if (entry.name.endsWith('.md')) {
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const lines = content.split('\n');
          let fileMatches = 0;
          for (let i = 0; i < lines.length && results.length < MAX_RESULTS; i++) {
            const idx = lines[i].indexOf(q);
            if (idx !== -1) {
              const start = Math.max(0, idx - SNIPPET_RADIUS);
              const end = Math.min(lines[i].length, idx + q.length + SNIPPET_RADIUS);
              let snippet = lines[i].substring(start, end).trim();
              if (start > 0) snippet = '…' + snippet;
              if (end < lines[i].length) snippet = snippet + '…';
              results.push({
                file: relPath,
                fileName: entry.name.replace(/\.md$/, ''),
                line: i + 1,
                snippet: snippet,
              });
              fileMatches++;
              if (fileMatches >= 10) break;
            }
          }
        } catch (err) {
          // skip
        }
      }
    }
  }

  searchDir(getMdRoot(), '');
  sendJSON(res, 200, { query: q, results, total: results.length, capped: results.length >= MAX_RESULTS });
}

// ── Static File Server ───────────────────────────────────────
function serveStatic(req, res, pathname) {
  // Restrict methods for static files
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, Object.assign({ 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
    res.end('Method Not Allowed');
    return;
  }

  let filePath = path.join(APP_ROOT, decodeURIComponent(pathname));

  // Default to index.html
  if (pathname === '/' || pathname === '') {
    filePath = path.join(APP_ROOT, 'index.html');
  }

  if (pathname.includes('\0')) {
    res.writeHead(400, Object.assign({ 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
    res.end('Invalid path');
    return;
  }

  const resolved = path.resolve(filePath);
  
  // Check for path traversal using path.relative to prevent partial-name matching
  const relative = path.relative(APP_ROOT, resolved);
  const isSafe = !relative.startsWith('..') && !path.isAbsolute(relative);

  const isForbidden = !isSafe || 
                      resolved === CONFIG_PATH || 
                      path.basename(resolved) === 'package.json' || 
                      path.basename(resolved) === 'package-lock.json';
  if (isForbidden) {
    res.writeHead(403, Object.assign({ 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
    res.end('Forbidden');
    return;
  }

  fs.stat(resolved, (err, stats) => {
    if (err || !stats.isFile()) {
      // Fallback to index.html for SPA routing
      const indexPath = path.join(APP_ROOT, 'index.html');
      fs.readFile(indexPath, (err2, data) => {
        if (err2) {
          res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
          res.end('Not Found');
          return;
        }
        res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, SECURITY_HEADERS));
        res.end(data);
      });
      return;
    }

    const ext = path.extname(resolved).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(resolved, (err3, data) => {
      if (err3) {
        res.writeHead(500, Object.assign({ 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
        res.end('Server Error');
        return;
      }
      res.writeHead(200, Object.assign({ 'Content-Type': contentType }, SECURITY_HEADERS));
      res.end(data);
    });
  });
}

// Session store mapping: token -> { expiry: timestamp }
const sessions = new Map();
const SESSION_DURATION = 2 * 60 * 60 * 1000; // 2 hours session expiry

// Rate limiting / brute-force protection map: ip -> { attempts: count, lockUntil: timestamp }
const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCK_DURATION = 15 * 60 * 1000; // 15 minutes lockout

function getClientIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function timingSafeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA); // dummy operation
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function hashPassword(password, salt, iterations = 100000) {
  if (!salt) {
    salt = crypto.randomBytes(16).toString('hex');
  }
  const hash = crypto.pbkdf2Sync(password, salt, iterations, 64, 'sha512').toString('hex');
  return { salt, hash, iterations };
}

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function isAuthenticated(req) {
  const token = req.headers['x-admin-token'];
  if (!token) return false;
  const session = sessions.get(token);
  if (!session) return false;
  
  if (Date.now() > session.expiry) {
    sessions.delete(token); // Session expired
    return false;
  }
  
  // Slide session expiry on active request
  session.expiry = Date.now() + SESSION_DURATION;
  return true;
}

function readJSONBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    const MAX_SIZE = 1024 * 1024; // 1MB size limit to prevent DoS memory exhaustion
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > MAX_SIZE) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        resolve({});
      }
    });
    req.on('error', (err) => {
      reject(err);
    });
  });
}

// ── HTTP Server ──────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsed.pathname;
  const query = Object.fromEntries(parsed.searchParams);

  // Log share link access if present
  if ((pathname === '/' || pathname === '') && query.file) {
    console.log(`[HTTP Server] Share Link accessed for file: "${query.file}" at line: ${query.line || 'none'}`);
  }

  // API routes
  if (pathname === '/api/tree' && req.method === 'GET') {
    return handleTree(req, res);
  }
  if (pathname === '/api/file' && req.method === 'GET') {
    return handleFile(req, res, query);
  }
  if (pathname === '/api/render' && req.method === 'GET') {
    return handleRender(req, res, query);
  }
  if (pathname === '/api/search' && req.method === 'GET') {
    return handleSearch(req, res, query);
  }

  // Admin API routes
  if (pathname === '/api/admin/status' && req.method === 'GET') {
    return sendJSON(res, 200, {
      isSetup: !!config.admin,
      isAuthenticated: isAuthenticated(req),
      settings: {
        defaultFontSize: config.settings.defaultFontSize,
        defaultTheme: config.settings.defaultTheme,
        siteName: config.settings.siteName || 'mdWebview'
      }
    });
  }
  if (pathname === '/api/admin/setup' && req.method === 'POST') {
    if (config.admin) {
      return sendJSON(res, 400, { error: 'Admin already configured' });
    }
    return readJSONBody(req).then(data => {
      const { username, password } = data;
      if (!username || !password || username.trim() === '' || password.trim() === '') {
        return sendJSON(res, 400, { error: 'Username and password are required' });
      }
      const { salt, hash } = hashPassword(password);
      config.admin = {
        username: username.trim(),
        passwordHash: hash,
        salt: salt
      };
      saveConfig();
      return sendJSON(res, 200, { success: true });
    }).catch(err => {
      return sendJSON(res, 500, { error: err.message });
    });
  }
  if (pathname === '/api/admin/login' && req.method === 'POST') {
    if (!config.admin) {
      return sendJSON(res, 400, { error: 'Admin not configured' });
    }

    const ip = getClientIP(req);
    const attempt = loginAttempts.get(ip) || { attempts: 0, lockUntil: 0 };

    if (Date.now() < attempt.lockUntil) {
      const waitMinutes = Math.ceil((attempt.lockUntil - Date.now()) / 60000);
      return sendJSON(res, 429, { error: `登入失敗次數過多，請於 ${waitMinutes} 分鐘後再試。` });
    }

    return readJSONBody(req).then(data => {
      const { username, password } = data;
      if (!username || !password) {
        return sendJSON(res, 400, { error: 'Username and password are required' });
      }

      let { hash } = hashPassword(password, config.admin.salt, 100000);
      if (hash !== config.admin.passwordHash) {
        // Fallback for legacy 1000 iterations
        const legacy = hashPassword(password, config.admin.salt, 1000);
        if (legacy.hash === config.admin.passwordHash) {
          hash = legacy.hash;
        }
      }

      const isUsernameCorrect = timingSafeCompare(username, config.admin.username);
      const isPasswordCorrect = timingSafeCompare(hash, config.admin.passwordHash);

      if (isUsernameCorrect && isPasswordCorrect) {
        loginAttempts.delete(ip); // Clear attempts on success
        const token = generateSessionToken();
        sessions.set(token, { expiry: Date.now() + SESSION_DURATION });
        return sendJSON(res, 200, { success: true, token });
      } else {
        attempt.attempts += 1;
        if (attempt.attempts >= MAX_ATTEMPTS) {
          attempt.lockUntil = Date.now() + LOCK_DURATION;
          console.warn(`[Security Alert] IP ${ip} locked out for 15 minutes due to ${MAX_ATTEMPTS} failed login attempts.`);
        } else {
          loginAttempts.set(ip, attempt);
        }
        return sendJSON(res, 401, { error: '帳號或密碼錯誤' });
      }
    }).catch(err => {
      return sendJSON(res, 500, { error: err.message });
    });
  }
  if (pathname === '/api/admin/logout' && req.method === 'POST') {
    const token = req.headers['x-admin-token'];
    if (token) {
      sessions.delete(token);
    }
    return sendJSON(res, 200, { success: true });
  }
  if (pathname === '/api/admin/settings' && req.method === 'GET') {
    if (!isAuthenticated(req)) {
      return sendJSON(res, 401, { error: 'Unauthorized' });
    }
    return sendJSON(res, 200, { settings: config.settings });
  }
  if (pathname === '/api/admin/settings' && req.method === 'POST') {
    if (!isAuthenticated(req)) {
      return sendJSON(res, 401, { error: 'Unauthorized' });
    }
    return readJSONBody(req).then(data => {
      const { mdRoot, defaultFontSize, defaultTheme, siteName } = data.settings || {};
      if (!mdRoot || mdRoot.trim() === '') {
        return sendJSON(res, 400, { error: 'Directory path cannot be empty' });
      }
      try {
        const resolvedPath = path.resolve(mdRoot.trim());
        const stats = fs.statSync(resolvedPath);
        if (!stats.isDirectory()) {
          return sendJSON(res, 400, { error: 'Provided path is not a directory' });
        }
      } catch (err) {
        return sendJSON(res, 400, { error: 'Directory path does not exist or is not readable' });
      }

      config.settings.mdRoot = path.resolve(mdRoot.trim());
      if (defaultFontSize) {
        config.settings.defaultFontSize = Math.max(12, Math.min(28, parseInt(defaultFontSize)));
      }
      if (defaultTheme) {
        config.settings.defaultTheme = defaultTheme;
      }
      if (siteName !== undefined) {
        config.settings.siteName = siteName.trim() || 'mdWebview';
      }
      saveConfig();
      return sendJSON(res, 200, { success: true, settings: config.settings });
    }).catch(err => {
      return sendJSON(res, 500, { error: err.message });
    });
  }

  // Static files
  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log('');
  console.log('  🪷  mdWebview is running');
  console.log('  ───────────────────────');
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Vault:   ${getMdRoot()}`);
  console.log('');
});
