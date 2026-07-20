const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
    const content = fs.readFileSync(resolved, 'utf-8');
    sendJSON(res, 200, { content, path: filePath, line: line || null });
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

const sessions = new Set();

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
  return token && sessions.has(token);
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

      if (username === config.admin.username && hash === config.admin.passwordHash) {
        const token = generateSessionToken();
        sessions.add(token);
        return sendJSON(res, 200, { success: true, token });
      } else {
        return sendJSON(res, 401, { error: 'Invalid username or password' });
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
