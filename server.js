const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const os = require('os');
const { Worker } = require('worker_threads');
const { marked } = require('marked');  // Still needed for inline fallback

// Configure marked once at startup
marked.setOptions({ breaks: true, gfm: true, headerIds: true, mangle: false });

// ── System Log Buffer (Recent 250 logs) ─────────────────────────────────────
const MAX_LOG_BUFFER = 250;
const systemLogBuffer = [];

function pushToLogBuffer(level, tag, msg) {
  const messageStr = (typeof msg === 'object' && msg !== null) ? (msg.stack || msg.message || JSON.stringify(msg)) : String(msg);
  systemLogBuffer.push({
    timestamp: new Date().toISOString(),
    level,
    tag,
    message: messageStr
  });
  if (systemLogBuffer.length > MAX_LOG_BUFFER) {
    systemLogBuffer.shift();
  }
}

// ── Logger Utility ──────────────────────────────────────────────────────────
const Logger = {
  formatTimestamp() {
    return new Date().toISOString();
  },
  info(tag, msg) {
    pushToLogBuffer('INFO', tag, msg);
    console.log(`[${this.formatTimestamp()}] [INFO] [${tag}] ${msg}`);
  },
  warn(tag, msg) {
    pushToLogBuffer('WARN', tag, msg);
    console.warn(`[${this.formatTimestamp()}] [WARN] [${tag}] ${msg}`);
  },
  error(tag, msg, err) {
    pushToLogBuffer('ERROR', tag, err ? `${msg}: ${err.message || err}` : msg);
    console.error(`[${this.formatTimestamp()}] [ERROR] [${tag}] ${msg}`, err ? (err.stack || err) : '');
  },
  debug(tag, msg) {
    pushToLogBuffer('DEBUG', tag, msg);
    if (process.env.DEBUG) {
      console.log(`[${this.formatTimestamp()}] [DEBUG] [${tag}] ${msg}`);
    }
  }
};

// ── Worker Thread Pool ─────────────────────────────────────────────────────
// 動態偵測 CPU 核心數：預留 1 個核心給主事件迴圈，其餘全數投入背景 Worker Pool
const numCpus = os.cpus().length || 4;
const POOL_SIZE = Math.max(2, numCpus - 1);
const workerPool = [];
const jobCallbacks = new Map(); // jobId -> { resolve, reject }
let jobIdSeq = 0;
const jobQueue = []; // queue for when all workers are busy

function createWorker(index) {
  const WORKER_PATH = path.join(APP_ROOT, 'render-worker.js');
  const w = new Worker(WORKER_PATH);
  w.idle = true;
  w.currentJobId = null;
  w.index = index;

  w.on('message', ({ jobId, html, error }) => {
    const cb = jobCallbacks.get(jobId);
    if (cb) {
      jobCallbacks.delete(jobId);
      if (error) cb.reject(new Error(error));
      else cb.resolve(html);
    }
    w.currentJobId = null;
    w.idle = true;
    flushQueue();
  });

  w.on('error', (err) => {
    Logger.error('WorkerPool', `[Worker #${w.index}] Thread error`, err);
    if (w.currentJobId) {
      const cb = jobCallbacks.get(w.currentJobId);
      if (cb) {
        jobCallbacks.delete(w.currentJobId);
        cb.reject(err);
      }
      w.currentJobId = null;
    }
    w.idle = true;
    flushQueue();
  });

  w.on('exit', (code) => {
    console.warn(`[Worker ${w.index}] Exited with code ${code}. Re-spawning...`);
    
    // Clean up active job if it died mid-execution to prevent leaking callbacks
    if (w.currentJobId) {
      const cb = jobCallbacks.get(w.currentJobId);
      if (cb) {
        jobCallbacks.delete(w.currentJobId);
        cb.reject(new Error('Worker thread terminated unexpectedly'));
      }
    }
    
    // Remove the dead worker from the pool
    const idx = workerPool.indexOf(w);
    if (idx !== -1) {
      workerPool.splice(idx, 1);
    }
    
    // Respawn a new worker at the same index
    const newWorker = createWorker(w.index);
    workerPool.push(newWorker);
    flushQueue();
  });

  return w;
}

function initWorkerPool() {
  for (let i = 0; i < POOL_SIZE; i++) {
    const w = createWorker(i);
    workerPool.push(w);
  }
  console.log(`  Workers: ${POOL_SIZE} render thread(s) ready`);
}

function flushQueue() {
  if (jobQueue.length === 0) return;
  const freeWorker = workerPool.find(w => w.idle);
  if (!freeWorker) return;
  const { jobId, body, resolve, reject } = jobQueue.shift();
  jobCallbacks.set(jobId, { resolve, reject });
  freeWorker.currentJobId = jobId;
  freeWorker.idle = false;
  freeWorker.postMessage({ jobId, body });
}

const JOB_TIMEOUT_MS = 30000; // 30 seconds

function renderWithWorker(body) {
  return new Promise((resolve, reject) => {
    const jobId = ++jobIdSeq;
    const timer = setTimeout(() => {
      const cb = jobCallbacks.get(jobId);
      if (cb) {
        jobCallbacks.delete(jobId);
        cb.reject(new Error('Worker render timeout after 30s'));
      }
    }, JOB_TIMEOUT_MS);
    
    const wrappedResolve = (val) => { clearTimeout(timer); resolve(val); };
    const wrappedReject = (err) => { clearTimeout(timer); reject(err); };
    
    const freeWorker = workerPool.find(w => w.idle);
    if (freeWorker) {
      jobCallbacks.set(jobId, { resolve: wrappedResolve, reject: wrappedReject });
      freeWorker.currentJobId = jobId;
      freeWorker.idle = false;
      freeWorker.postMessage({ jobId, body });
    } else {
      // All workers busy — queue the job
      jobQueue.push({ jobId, body, resolve: wrappedResolve, reject: wrappedReject });
    }
  });
}

const PORT = process.env.PORT || 8330;
const APP_ROOT = path.resolve(process.cwd());
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(APP_ROOT, 'config.json');

let config = {
  admin: null, // { username, passwordHash, salt }
  settings: {
    mdRoot: process.env.MD_ROOT || path.join(APP_ROOT, 'md'),
    defaultFontSize: parseInt(process.env.DEFAULT_FONT_SIZE, 10) || 16,
    defaultTheme: process.env.DEFAULT_THEME || 'obsidian-dark',
    siteName: process.env.SITE_NAME || 'mdWebview',
    enableVersion: process.env.ENABLE_VERSION ? process.env.ENABLE_VERSION === 'true' : false,
    version: process.env.VERSION || '',
    enableDownload: process.env.ENABLE_DOWNLOAD ? process.env.ENABLE_DOWNLOAD === 'true' : false,
    downloadUrl: process.env.DOWNLOAD_URL || ''
  }
};

function loadConfig() {
  try {
    // 1. Initial environment variables as base defaults
    if (process.env.SITE_NAME) config.settings.siteName = process.env.SITE_NAME;
    if (process.env.ENABLE_VERSION !== undefined) config.settings.enableVersion = process.env.ENABLE_VERSION === 'true';
    if (process.env.VERSION !== undefined) config.settings.version = process.env.VERSION;
    if (process.env.ENABLE_DOWNLOAD !== undefined) config.settings.enableDownload = process.env.ENABLE_DOWNLOAD === 'true';
    if (process.env.DOWNLOAD_URL !== undefined) config.settings.downloadUrl = process.env.DOWNLOAD_URL;

    // 2. Try reading local config.json in APP_ROOT if present
    const defaultConfigPath = path.join(APP_ROOT, 'config.json');
    if (fs.existsSync(defaultConfigPath)) {
      const raw = fs.readFileSync(defaultConfigPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed.settings) config.settings = { ...config.settings, ...parsed.settings };
      if (parsed.admin && !config.admin) config.admin = parsed.admin;
    }

    // 3. HIGHEST PRIORITY: Persistent CONFIG_PATH (/data/config.json)
    // Saved admin settings must always override defaults across container updates!
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
  fs.promises.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8')
    .catch(err => console.error('Error saving config:', err));
}

loadConfig();

function getMdRoot() {
  const configured = config.settings.mdRoot;

  // 1. If configured path exists and contains files/directories, use it directly
  if (configured && fs.existsSync(configured)) {
    try {
      const items = fs.readdirSync(configured);
      if (items.some(name => !name.startsWith('.'))) {
        return configured;
      }
    } catch (_) {}
  }

  // 2. If configured path is invalid or empty (e.g. host absolute path inside Docker container),
  // fallback to candidates that actually exist and contain files
  const candidates = [
    process.env.MD_ROOT,
    '/data/md',
    '/data',
    path.join(APP_ROOT, 'md')
  ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      try {
        const items = fs.readdirSync(candidate);
        if (items.some(name => !name.startsWith('.'))) {
          config.settings.mdRoot = candidate;
          return candidate;
        }
      } catch (_) {}
    }
  }

  return configured || path.join(APP_ROOT, 'md');
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
  '.pdf':  'application/pdf',
};

// Security Headers
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' fonts.googleapis.com; font-src 'self' fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'"
};

let rawIndexHtml = null;
function getIndexHtml(callback) {
  const renderDynamicIndex = (templateBuf) => {
    let html = templateBuf.toString('utf-8');
    const defaultTheme = config.settings.defaultTheme || 'obsidian-dark';
    const defaultFontSize = config.settings.defaultFontSize || 16;
    const siteName = config.settings.siteName || 'mdWebview';

    // 1. Inject theme & font-size into <html> element
    html = html.replace(/<html([^>]*)>/i, (match, p1) => {
      let attrs = p1;
      if (/data-theme="[^"]*"/i.test(attrs)) {
        attrs = attrs.replace(/data-theme="[^"]*"/i, `data-theme="${defaultTheme}"`);
      } else {
        attrs += ` data-theme="${defaultTheme}"`;
      }

      if (/style="[^"]*"/i.test(attrs)) {
        attrs = attrs.replace(/style="([^"]*)"/i, `style="$1; --content-font-size: ${defaultFontSize}px;"`);
      } else {
        attrs += ` style="--content-font-size: ${defaultFontSize}px;"`;
      }
      return `<html${attrs}>`;
    });

    // 2. Inject font size display value
    html = html.replace(
      /<span id="fontSizeDisplay" class="font-size-display">\d+<\/span>/i,
      `<span id="fontSizeDisplay" class="font-size-display">${defaultFontSize}</span>`
    );

    // 3. Inject site name into title and logo
    html = html.replace(
      /<title>.*?<\/title>/i,
      `<title>${siteName} — 佛典經論閱讀器</title>`
    );
    html = html.replace(
      /<span class="logo-text">.*?<\/span>/i,
      `<span class="logo-text">${siteName}</span>`
    );

    // 4. Inject server config script
    const configScript = `<script>window.__APP_CONFIG__ = ${JSON.stringify(config.settings)};</script>`;
    if (html.includes('</head>')) {
      html = html.replace('</head>', `${configScript}\n</head>`);
    } else {
      html = configScript + html;
    }

    return Buffer.from(html, 'utf-8');
  };

  if (rawIndexHtml) {
    return callback(null, renderDynamicIndex(rawIndexHtml));
  }
  const indexPath = path.join(APP_ROOT, 'index.html');
  fs.readFile(indexPath, (err, data) => {
    if (err) return callback(err);
    rawIndexHtml = data;
    callback(null, renderDynamicIndex(rawIndexHtml));
  });
}

function sendCompressed(req, res, statusCode, headers, data) {
  const acceptEncoding = req.headers['accept-encoding'] || '';
  const contentType = headers['Content-Type'] || '';
  const isCompressible = contentType.includes('text/') || 
                         contentType.includes('javascript') || 
                         contentType.includes('json') || 
                         contentType.includes('xml');

  if (isCompressible && data.length > 1024 && acceptEncoding.includes('gzip')) {
    zlib.gzip(data, { level: zlib.constants.Z_BEST_SPEED }, (err, compressed) => {
      if (err) {
        res.writeHead(statusCode, headers);
        res.end(data);
        return;
      }
      res.writeHead(statusCode, Object.assign({}, headers, {
        'Content-Encoding': 'gzip',
        'Content-Length': compressed.length
      }));
      res.end(compressed);
    });
  } else {
    res.writeHead(statusCode, Object.assign({}, headers, {
      'Content-Length': data.length
    }));
    res.end(data);
  }
}

function sendJSON(res, statusCode, data) {
  const jsonStr = JSON.stringify(data);
  const payload = Buffer.from(jsonStr, 'utf-8');
  
  const headers = Object.assign({
    'Content-Type': 'application/json; charset=utf-8'
  }, SECURITY_HEADERS);

  // Use the cached Accept-Encoding from the response object (attached during request routing)
  const acceptEncoding = res.reqHeadersAcceptEncoding || '';
  if (payload.length > 1024 && acceptEncoding.includes('gzip')) {
    zlib.gzip(payload, { level: zlib.constants.Z_BEST_SPEED }, (err, compressed) => {
      if (err) {
        res.writeHead(statusCode, headers);
        res.end(payload);
        return;
      }
      res.writeHead(statusCode, Object.assign({}, headers, {
        'Content-Encoding': 'gzip',
        'Content-Length': compressed.length
      }));
      res.end(compressed);
    });
  } else {
    res.writeHead(statusCode, headers);
    res.end(payload);
  }
}

let cachedTree = null;
let treeWatcher = null;

function setupTreeWatcher() {
  if (treeWatcher) return;
  try {
    const mdRoot = getMdRoot();
    if (fs.existsSync(mdRoot)) {
      treeWatcher = fs.watch(mdRoot, { recursive: true }, (eventType, filename) => {
        // Invalidate tree cache on any change (add/remove/rename)
        cachedTree = null;
      });
    }
  } catch (err) {
    console.error('Error setting up tree watcher:', err);
  }
}

function resetTreeWatcher() {
  if (treeWatcher) {
    try {
      treeWatcher.close();
    } catch (err) {}
    treeWatcher = null;
  }
  cachedTree = null;
}

async function scanDirAsync(dir, relativePath) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    return [];
  }
  const result = [];
  const promises = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    const relPath = relativePath ? relativePath + '/' + entry.name : entry.name;
    if (entry.isDirectory()) {
      promises.push(
        scanDirAsync(fullPath, relPath).then(children => {
          if (children.length > 0) {
            result.push({
              name: entry.name,
              path: relPath,
              type: 'directory',
              children: children,
            });
          }
        })
      );
    } else if (entry.name.endsWith('.md')) {
      result.push({
        name: entry.name.replace(/\.md$/, ''),
        path: relPath,
        type: 'file',
      });
    }
  }
  await Promise.all(promises);
  result.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-TW', { numeric: true, sensitivity: 'base' });
  });
  return result;
}

// ── API: Directory Tree ──────────────────────────────────────
async function handleTree(req, res) {
  setupTreeWatcher();
  if (cachedTree) {
    return sendJSON(res, 200, cachedTree);
  }
  try {
    const tree = await scanDirAsync(getMdRoot(), '');
    cachedTree = tree;
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

  fs.promises.readFile(resolved, 'utf-8')
    .then(raw => {
      sendJSON(res, 200, { content: raw, path: filePath, line: line || null });
    })
    .catch(err => {
      sendJSON(res, 404, { error: 'File not found: ' + filePath });
    });
}


async function handleRender(req, res, query) {
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
    const renderStart = Date.now();
    const stat = await fs.promises.stat(resolved);
    const etag = `W/"${stat.size}-${stat.mtimeMs}"`;
    if (req.headers['if-none-match'] === etag) {
      Logger.debug('Render', `304 Not Modified: "${filePath}" (${Date.now() - renderStart}ms)`);
      res.writeHead(304, Object.assign({ 'ETag': etag, 'Cache-Control': 'no-cache' }, SECURITY_HEADERS));
      res.end();
      return;
    }

    let raw = await fs.promises.readFile(resolved, 'utf-8');

    // Strip frontmatter before rendering (O(1) fast scanning without regex string-duplication)
    let frontmatter = {};
    if (raw.startsWith('---\n') || raw.startsWith('---\r\n')) {
      const isCrlf = raw.startsWith('---\r\n');
      const startOffset = isCrlf ? 5 : 4;
      const endFmIndex = raw.indexOf(isCrlf ? '\r\n---' : '\n---', startOffset);
      if (endFmIndex !== -1) {
        const fmText = raw.substring(startOffset, endFmIndex);
        fmText.split(/\r?\n/).forEach((l) => {
          const idx = l.indexOf(':');
          if (idx !== -1) {
            const k = l.substring(0, idx).trim();
            const v = l.substring(idx + 1).trim();
            if (k) frontmatter[k] = v;
          }
        });
        const contentStart = endFmIndex + (isCrlf ? 5 : 4);
        const nextNL = raw.indexOf('\n', contentStart);
        raw = nextNL !== -1 ? raw.substring(nextNL + 1) : raw.substring(contentStart);
      }
    }

    // Offload CPU-bound rendering to worker thread pool
    const html = await renderWithWorker(raw);

    // Encode frontmatter as base64 in response header (avoids JSON wrapping the HTML)
    const metaHeader = Buffer.from(JSON.stringify(frontmatter), 'utf-8').toString('base64');

    const responseHeaders = Object.assign({
      'Content-Type': 'text/html; charset=utf-8',
      'ETag': etag,
      'Cache-Control': 'no-cache',
      'X-Document-Meta': metaHeader,
    }, SECURITY_HEADERS);

    // Gzip compress if client supports it — reduces payload ~10x
    const acceptEncoding = req.headers['accept-encoding'] || '';
    if (acceptEncoding.includes('gzip')) {
      zlib.gzip(Buffer.from(html, 'utf-8'), { level: zlib.constants.Z_BEST_SPEED }, (err, compressed) => {
        if (err) {
          res.writeHead(200, responseHeaders);
          res.end(html);
          return;
        }
        res.writeHead(200, Object.assign(responseHeaders, {
          'Content-Encoding': 'gzip',
          'Content-Length': compressed.length,
        }));
        res.end(compressed);
      });
    } else {
      res.writeHead(200, responseHeaders);
      res.end(html);
    }
  } catch (err) {
    sendJSON(res, 404, { error: 'File not found: ' + filePath });
  }
}

// ── API: Full-text Search ────────────────────────────────────
async function collectFilesAsync(dir, relativePath = '') {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    return [];
  }
  let files = [];
  const promises = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    const relPath = relativePath ? relativePath + '/' + entry.name : entry.name;
    if (entry.isDirectory()) {
      promises.push(
        collectFilesAsync(fullPath, relPath).then(subFiles => {
          files = files.concat(subFiles);
        })
      );
    } else if (entry.name.endsWith('.md')) {
      files.push({ fullPath, relPath, name: entry.name });
    }
  }
  await Promise.all(promises);
  return files;
}

function flattenTreeToFiles(nodes, mdRoot) {
  const files = [];
  function walk(nodeList) {
    for (const node of nodeList) {
      if (node.type === 'directory' && node.children) {
        walk(node.children);
      } else if (node.type === 'file') {
        files.push({
          fullPath: path.join(mdRoot, node.path),
          relPath: node.path,
          name: node.name + '.md'
        });
      }
    }
  }
  walk(nodes);
  return files;
}

// ── API: Full-text Search ────────────────────────────────────
async function handleSearch(req, res, query) {
  const searchStart = Date.now();
  const q = query.q;
  if (!q || q.trim().length === 0) {
    return sendJSON(res, 400, { error: 'Missing query parameter' });
  }

  const targetFolder = query.folder ? query.folder.trim().replace(/^\/+|\/+$/g, '') : '';
  const results = [];
  const SNIPPET_RADIUS = 60;

  try {
    // Reuse cached tree to avoid redundant filesystem traversal
    if (!cachedTree) {
      cachedTree = await scanDirAsync(getMdRoot(), '');
      setupTreeWatcher();
    }
    let files = flattenTreeToFiles(cachedTree, getMdRoot());

    // Filter files by target directory or specific file path if specified
    if (targetFolder) {
      files = files.filter(f => f.relPath === targetFolder || f.relPath.startsWith(targetFolder + '/'));
    }

    const isSingleFile = files.length === 1;
    const MAX_RESULTS = isSingleFile ? 1000 : 300;
    const MAX_FILE_MATCHES = isSingleFile ? 1000 : 50;

    const limit = 10;
    let fileIdx = 0;

    async function worker() {
      while (fileIdx < files.length && results.length < MAX_RESULTS) {
        const file = files[fileIdx++];
        if (!file) break;
        try {
          const content = await fs.promises.readFile(file.fullPath, 'utf-8');
          // Fast check to avoid splitting the file if it has no match
          if (!content.includes(q)) continue;

          let pos = 0;
          let lineNum = 1;
          let fileMatches = 0;
          while (pos < content.length && results.length < MAX_RESULTS && fileMatches < MAX_FILE_MATCHES) {
            const matchIdx = content.indexOf(q, pos);
            if (matchIdx === -1) break;
            
            // Count newlines from pos to matchIdx to get line number
            for (let j = pos; j < matchIdx; j++) {
              if (content.charCodeAt(j) === 10) lineNum++;
            }
            
            // Extract snippet around match
            const lineStart = content.lastIndexOf('\n', matchIdx) + 1;
            let lineEnd = content.indexOf('\n', matchIdx);
            if (lineEnd === -1) lineEnd = content.length;
            const lineText = content.substring(lineStart, lineEnd);
            const idxInLine = matchIdx - lineStart;
            const start = Math.max(0, idxInLine - SNIPPET_RADIUS);
            const end = Math.min(lineText.length, idxInLine + q.length + SNIPPET_RADIUS);
            let snippet = lineText.substring(start, end).trim();
            if (start > 0) snippet = '…' + snippet;
            if (end < lineText.length) snippet = snippet + '…';
            
            results.push({
              file: file.relPath,
              fileName: file.name.replace(/\.md$/, ''),
              line: lineNum,
              snippet: snippet,
            });
            fileMatches++;
            pos = matchIdx + q.length;
          }
        } catch (err) {
          // ignore
        }
      }
    }

    const workers = [];
    for (let i = 0; i < limit; i++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    Logger.info('Search', `Query: "${q}"${targetFolder ? `, Scope: "${targetFolder}"` : ''} -> ${results.length} matches in ${Date.now() - searchStart}ms`);
    sendJSON(res, 200, { query: q, results, total: results.length, capped: results.length >= MAX_RESULTS });
  } catch (err) {
    Logger.error('Search', `Search failed for query "${q}"`, err);
    sendJSON(res, 500, { error: err.message });
  }
}

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
  const baseName = path.basename(resolved);
  const ext = path.extname(resolved).toLowerCase();

  // 1. Blacklist Check: Block hidden files/folders, server backend source code, worker threads, and project config files
  const isHiddenFile = baseName.startsWith('.') || relative.split(path.sep).some(segment => segment.startsWith('.'));
  const isServerSource = baseName === 'server.js' || baseName === 'render-worker.js' || baseName === 'md-worker.js';
  const isSensitiveConfig = resolved === CONFIG_PATH || 
                            baseName === 'package.json' || 
                            baseName === 'package-lock.json' || 
                            baseName === 'Dockerfile' || 
                            baseName.toLowerCase() === 'readme.md';

  if (!isSafe || isHiddenFile || isServerSource || isSensitiveConfig) {
    res.writeHead(403, Object.assign({ 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
    res.end('Forbidden');
    return;
  }

  // 2. Whitelist Check: Allow explicit public client assets and safe static media/font/document extensions
  const ALLOWED_EXACT_FILES = new Set(['index.html', 'app.js', 'style.css', 'marked.min.js', 'favicon.ico']);
  const ALLOWED_EXTENSIONS = new Set(['.css', '.js', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.woff', '.woff2', '.ttf', '.pdf']);

  const isAllowedExact = ALLOWED_EXACT_FILES.has(baseName);
  const isAllowedExt = ALLOWED_EXTENSIONS.has(ext);

  if (!isAllowedExact && !isAllowedExt) {
    res.writeHead(403, Object.assign({ 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
    res.end('Access Denied');
    return;
  }

  // Intercept root or index.html requests to serve dynamic index with injected config.settings
  if (pathname === '/' || pathname === '' || path.basename(resolved) === 'index.html') {
    getIndexHtml((err, data) => {
      if (err) {
        res.writeHead(500, Object.assign({ 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
        res.end('Server Error');
        return;
      }
      const etag = `W/"index-${data.length}-${config.settings.defaultFontSize}-${config.settings.defaultTheme}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, Object.assign({ 'ETag': etag, 'Cache-Control': 'no-cache' }, SECURITY_HEADERS));
        res.end();
        return;
      }
      const headers = Object.assign({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        'ETag': etag
      }, SECURITY_HEADERS);
      sendCompressed(req, res, 200, headers, data);
    });
    return;
  }

  fs.stat(resolved, (err, stats) => {
    if (err || !stats.isFile()) {
      // Fallback to index.html for SPA routing
      getIndexHtml((err2, data) => {
        if (err2) {
          res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
          res.end('Not Found');
          return;
        }

        // SPA fallback ETag based on length
        const etag = `W/"index-${data.length}"`;
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304, Object.assign({ 'ETag': etag, 'Cache-Control': 'no-cache' }, SECURITY_HEADERS));
          res.end();
          return;
        }

        const headers = Object.assign({
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
          'ETag': etag
        }, SECURITY_HEADERS);

        sendCompressed(req, res, 200, headers, data);
      });
      return;
    }

    // Static file found — generate weak ETag based on size and mtime
    const mtime = stats.mtime.getTime();
    const size = stats.size;
    const etag = `W/"${size}-${mtime}"`;

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, Object.assign({ 'ETag': etag, 'Cache-Control': 'no-cache' }, SECURITY_HEADERS));
      res.end();
      return;
    }

    const ext = path.extname(resolved).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    // Set Cache-Control: immutable for versioned assets, no-cache for code, long cache for images
    let cacheControl = 'no-cache';
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const hasVersionQuery = urlObj.search && /[?&]v=/.test(urlObj.search);
    if (hasVersionQuery) {
      cacheControl = 'public, max-age=31536000, immutable';
    } else if (ext === '.png' || ext === '.jpg' || ext === '.ico') {
      cacheControl = 'public, max-age=86400';
    }

    const headers = Object.assign({
      'Content-Type': contentType,
      'Cache-Control': cacheControl,
      'ETag': etag
    }, SECURITY_HEADERS);

    fs.readFile(resolved, (err3, data) => {
      if (err3) {
        res.writeHead(500, Object.assign({ 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
        res.end('Server Error');
        return;
      }
      sendCompressed(req, res, 200, headers, data);
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
const MAX_LOGIN_ENTRIES = 10000;

function getClientIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

// ── Global API Rate Limiter (Sliding Window per IP: max 30 req/sec) ─────────
const apiRateLimits = new Map();
const API_RATE_LIMIT_WINDOW_MS = 1000;
const API_RATE_LIMIT_MAX = 30;

const MAX_RATE_LIMIT_ENTRIES = 10000;

function checkApiRateLimit(req, res) {
  const ip = getClientIP(req);
  const now = Date.now();
  let record = apiRateLimits.get(ip);

  if (!record || (now - record.windowStart) >= API_RATE_LIMIT_WINDOW_MS) {
    record = { count: 1, windowStart: now };
    apiRateLimits.set(ip, record);
    // Evict oldest entry if Map size exceeds limit
    if (apiRateLimits.size > MAX_RATE_LIMIT_ENTRIES) {
      const oldestKey = apiRateLimits.keys().next().value;
      apiRateLimits.delete(oldestKey);
    }
    return true;
  }

  record.count += 1;
  if (record.count > API_RATE_LIMIT_MAX) {
    Logger.warn('Security', `IP ${ip} exceeded API rate limit (${record.count} req/s). Blocked with 429.`);
    sendJSON(res, 429, { error: '請求過於頻繁 (429 Too Many Requests)，請稍後再試。' });
    return false;
  }

  return true;
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
  return new Promise((resolve, reject) => {
    if (!salt) {
      salt = crypto.randomBytes(16).toString('hex');
    }
    crypto.pbkdf2(password, salt, iterations, 64, 'sha512', (err, derivedKey) => {
      if (err) return reject(err);
      resolve({ salt, hash: derivedKey.toString('hex'), iterations });
    });
  });
}

// Clean up expired sessions and stale rate limit attempts every 1 hour to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (now > session.expiry) {
      sessions.delete(token);
    }
  }
  for (const [ip, attempt] of loginAttempts.entries()) {
    if (now > attempt.lockUntil && attempt.attempts > 0) {
      // Clear after lock duration has passed plus 1 hour idle time
      if (now > attempt.lockUntil + 60 * 60 * 1000) {
        loginAttempts.delete(ip);
      }
    }
  }
}, 60 * 60 * 1000);

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
  const reqStart = Date.now();
  res.reqHeadersAcceptEncoding = req.headers['accept-encoding'] || '';
  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsed.pathname;
  const query = Object.fromEntries(parsed.searchParams);

  // HTTP Access Logging Middleware
  const origEnd = res.end;
  res.end = function(...args) {
    origEnd.apply(res, args);
    const duration = Date.now() - reqStart;
    if (pathname.startsWith('/api/') || pathname.startsWith('/admin/') || res.statusCode >= 400 || duration > 50) {
      Logger.info('HTTP', `${req.method} ${pathname}${parsed.search || ''} -> ${res.statusCode} (${duration}ms)`);
    } else {
      Logger.debug('HTTP', `${req.method} ${pathname} -> ${res.statusCode} (${duration}ms)`);
    }
  };

  // Log share link access if present
  if ((pathname === '/' || pathname === '') && query.file) {
    Logger.info('ShareLink', `Access file: "${query.file}" at line: ${query.line || 'none'}`);
  }

  // Global API Rate Limiting Check (30 req/sec max)
  if (pathname.startsWith('/api/')) {
    if (!checkApiRateLimit(req, res)) {
      return;
    }
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
      settings: config.settings
    });
  }
  if (pathname === '/api/admin/logs' && req.method === 'GET') {
    if (!isAuthenticated(req)) {
      return sendJSON(res, 401, { error: 'Unauthorized' });
    }
    return sendJSON(res, 200, { logs: systemLogBuffer });
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
      return hashPassword(password).then(({ salt, hash }) => {
        config.admin = {
          username: username.trim(),
          passwordHash: hash,
          salt: salt
        };
        saveConfig();
        return sendJSON(res, 200, { success: true });
      });
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

      // Perform async hashing
      return hashPassword(password, config.admin.salt, 100000).then(({ hash }) => {
        if (hash === config.admin.passwordHash) {
          return { hash };
        }
        // Fallback for legacy 1000 iterations
        return hashPassword(password, config.admin.salt, 1000).then(legacy => {
          return { hash: legacy.hash === config.admin.passwordHash ? legacy.hash : hash };
        });
      }).then(({ hash }) => {
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
          }
          loginAttempts.set(ip, attempt); // Correctly save the attempt block in all paths
          // Evict oldest entries if over limit
          if (loginAttempts.size > MAX_LOGIN_ENTRIES) {
            const oldestKey = loginAttempts.keys().next().value;
            loginAttempts.delete(oldestKey);
          }
          return sendJSON(res, 401, { error: '帳號或密碼錯誤' });
        }
      });
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
      const { mdRoot, defaultFontSize, defaultTheme, siteName, createIfNotExists, enableVersion, version, enableDownload, downloadUrl } = data.settings || {};
      if (!mdRoot || mdRoot.trim() === '') {
        return sendJSON(res, 400, { error: 'Directory path cannot be empty' });
      }
      
      const resolvedPath = path.resolve(mdRoot.trim());

      const updateSettings = () => {
        if (config.settings.mdRoot !== resolvedPath) {
          config.settings.mdRoot = resolvedPath;
          resetTreeWatcher();
        }
        if (defaultFontSize) {
          config.settings.defaultFontSize = Math.max(12, Math.min(28, parseInt(defaultFontSize)));
        }
        if (defaultTheme) {
          config.settings.defaultTheme = defaultTheme;
        }
        if (siteName !== undefined) {
          config.settings.siteName = siteName.trim() || 'mdWebview';
        }
        if (enableVersion !== undefined) {
          config.settings.enableVersion = !!enableVersion;
        }
        if (version !== undefined) {
          config.settings.version = String(version).trim();
        }
        if (enableDownload !== undefined) {
          config.settings.enableDownload = !!enableDownload;
        }
        if (downloadUrl !== undefined) {
          config.settings.downloadUrl = String(downloadUrl).trim();
        }
        saveConfig();
        return sendJSON(res, 200, { success: true, settings: config.settings });
      };

      return fs.promises.stat(resolvedPath).then(stats => {
        if (!stats.isDirectory()) {
          return sendJSON(res, 400, { error: 'Provided path is not a directory' });
        }
        return updateSettings();
      }).catch(err => {
        if (err.code === 'ENOENT') {
          if (createIfNotExists) {
            return fs.promises.mkdir(resolvedPath, { recursive: true })
              .then(() => updateSettings())
              .catch(mkdirErr => sendJSON(res, 500, { error: 'Failed to create directory: ' + mkdirErr.message }));
          }
          return sendJSON(res, 404, { 
            error: `目錄路徑 "${resolvedPath}" 不存在。`, 
            code: 'DIR_NOT_FOUND',
            path: resolvedPath 
          });
        }
        return sendJSON(res, 400, { error: 'Directory path does not exist or is not readable' });
      });
    }).catch(err => {
      return sendJSON(res, 500, { error: err.message });
    });
  }

  // Static files
  serveStatic(req, res, pathname);
});

initWorkerPool();

server.listen(PORT, () => {
  console.log('');
  console.log('  🪷  mdWebview is running');
  console.log('  ───────────────────────');
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Vault:   ${getMdRoot()}`);
  console.log('');
});
