/**
 * @file lib/static-cache.js — Static Assets, Response Compression, and SSR Injection
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { APP_ROOT, APP_VERSION, CONFIG_PATH, MIME_TYPES, SECURITY_HEADERS } = require('./constants');
const { getBaseUrl, isCrawlerRequest, safeDecodeURIComponent } = require('./utils');
const { config } = require('./config');

const STATIC_CACHE_TTL_MS = 5000;
const MAX_STATIC_CACHE_ENTRIES = 200;
const staticCache = new Map();

function sendCompressed(req, res, statusCode, headers, data) {
  const acceptEncoding = (req && req.headers ? req.headers['accept-encoding'] : '') || '';
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
    res.writeHead(statusCode, Object.assign({}, headers, {
      'Content-Length': payload.length
    }));
    res.end(payload);
  }
}

function indexHtmlHeaders(extra, nonce) {
  const csp = SECURITY_HEADERS['Content-Security-Policy'].replace(
    "script-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`
  );
  return Object.assign({}, extra, SECURITY_HEADERS, { 'Content-Security-Policy': csp });
}

function escapeHtmlString(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function safeJsonForScript(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function getIndexHtml(nonce, req, callback) {
  if (typeof req === 'function') {
    callback = req;
    req = null;
  }
  const renderDynamicIndex = (templateBuf, nonce) => {
    let html = templateBuf.toString('utf-8');
    const defaultTheme = escapeHtmlString(config.settings.defaultTheme || 'obsidian-dark');
    const defaultFontSize = parseInt(config.settings.defaultFontSize, 10) || 16;
    const siteName = escapeHtmlString(config.settings.siteName || 'mdWebview');
    const baseUrl = getBaseUrl(req, config.settings.siteUrl);
    const canonicalBase = baseUrl ? `${baseUrl}/` : '/';
    let rawOgImage = (config.settings.seoOgImage || '/og-preview.png').trim();
    const ogImageUrl = rawOgImage.startsWith('http://') || rawOgImage.startsWith('https://')
      ? rawOgImage
      : (baseUrl ? `${baseUrl}${rawOgImage.startsWith('/') ? '' : '/'}${rawOgImage}` : rawOgImage);
    const siteDesc = escapeHtmlString(config.settings.seoSiteDescription || '');
    const siteKeywords = escapeHtmlString(config.settings.seoKeywords || '');
    const robotsContent = config.settings.seoRobotsIndex === true ? 'index, follow' : 'noindex, nofollow';
    const gVer = escapeHtmlString(config.settings.googleSiteVerification || '');
    const bingVer = escapeHtmlString(config.settings.bingSiteVerification || '');
    const baiduVer = escapeHtmlString(config.settings.baiduSiteVerification || '');

    if (html.includes('<link rel="canonical"')) {
      html = html.replace(/<link rel="canonical"[^>]*>/i, `<link rel="canonical" href="${canonicalBase}">`);
    } else if (baseUrl) {
      html = html.replace('</head>', `  <link rel="canonical" href="${canonicalBase}">\n</head>`);
    }

    if (html.includes('<meta property="og:url"')) {
      html = html.replace(/<meta property="og:url"[^>]*>/i, `<meta property="og:url" content="${canonicalBase}">`);
    } else if (baseUrl) {
      html = html.replace('</head>', `  <meta property="og:url" content="${canonicalBase}">\n</head>`);
    }

    html = html.replace(/<meta property="og:image" content="[^"]*">/i, `<meta property="og:image" content="${ogImageUrl}">`);
    html = html.replace(/<meta name="twitter:image" content="[^"]*">/i, `<meta name="twitter:image" content="${ogImageUrl}">`);

    html = html.replace(/<meta property="og:site_name" content="[^"]*">/i, `<meta property="og:site_name" content="${siteName}">`);
    html = html.replace(/<meta property="og:title" content="[^"]*">/i, `<meta property="og:title" content="${siteName} — 佛典經論閱讀器">`);
    html = html.replace(/<meta name="twitter:title" content="[^"]*">/i, `<meta name="twitter:title" content="${siteName} — 佛典經論閱讀器">`);

    if (siteDesc) {
      html = html.replace(/<meta name="description" content="[^"]*">/i, `<meta name="description" content="${siteDesc}">`);
      html = html.replace(/<meta property="og:description" content="[^"]*">/i, `<meta property="og:description" content="${siteDesc}">`);
      html = html.replace(/<meta name="twitter:description" content="[^"]*">/i, `<meta name="twitter:description" content="${siteDesc}">`);
    }

    if (siteKeywords) {
      if (html.includes('<meta name="keywords"')) {
        html = html.replace(/<meta name="keywords" content="[^"]*">/i, `<meta name="keywords" content="${siteKeywords}">`);
      } else {
        html = html.replace('</head>', `  <meta name="keywords" content="${siteKeywords}">\n</head>`);
      }
    }

    if (html.includes('<meta name="robots"')) {
      html = html.replace(/<meta name="robots" content="[^"]*">/i, `<meta name="robots" content="${robotsContent}">`);
    } else {
      html = html.replace('</head>', `  <meta name="robots" content="${robotsContent}">\n</head>`);
    }

    let searchEngineVerTags = '';
    if (gVer) searchEngineVerTags += `  <meta name="google-site-verification" content="${gVer}">\n`;
    if (bingVer) searchEngineVerTags += `  <meta name="msvalidate.01" content="${bingVer}">\n`;
    if (baiduVer) searchEngineVerTags += `  <meta name="baidu-site-verification" content="${baiduVer}">\n`;
    if (searchEngineVerTags) {
      html = html.replace('</head>', `${searchEngineVerTags}</head>`);
    }

    const themeColors = {
      'obsidian-dark': '#181825',
      'obsidian-light': '#e6e9ef',
      'solarized': '#002b36',
      'zen': '#ece5d8',
      'gruvbox': '#1d2021'
    };
    const initialThemeColor = themeColors[defaultTheme] || '#181825';

    html = html.replace(/<meta name="theme-color" content="[^"]*">/i, `<meta name="theme-color" id="metaThemeColor" content="${initialThemeColor}">`);

    html = html.replace(/<html([^>]*)>/i, (_, attrs) => {
      if (/data-theme="[^"]*"/i.test(attrs)) {
        attrs = attrs.replace(/data-theme="[^"]*"/i, `data-theme="${defaultTheme}"`);
      } else {
        attrs += ` data-theme="${defaultTheme}"`;
      }

      if (/style="[^"]*"/i.test(attrs)) {
        attrs = attrs.replace(/style="([^"]*)"/i, `style="$1; --content-font-size: ${defaultFontSize}px; background-color: ${initialThemeColor};"`);
      } else {
        attrs += ` style="--content-font-size: ${defaultFontSize}px; background-color: ${initialThemeColor};"`;
      }
      return `<html${attrs}>`;
    });

    html = html.replace(
      /<span id="fontSizeDisplay" class="font-size-display">\d+<\/span>/i,
      `<span id="fontSizeDisplay" class="font-size-display">${defaultFontSize}</span>`
    );

    html = html.replace(/<title>.*?<\/title>/i, `<title>${siteName} — 佛典經論閱讀器</title>`);
    html = html.replace(/<span class="logo-text">.*?<\/span>/i, `<span class="logo-text">${siteName}</span>`);
    html = html.replace(/<h1 class="welcome-title">.*?<\/h1>/i, `<h1 class="welcome-title">${siteName}</h1>`);
    html = html.replace(/<h2 class="announcement-header-title" id="announcementModalTitle">.*?<\/h2>/i, `<h2 class="announcement-header-title" id="announcementModalTitle">${siteName}線上閱讀</h2>`);

    const clientSettings = Object.assign({}, config.settings);
    delete clientSettings.mdRoot;
    delete clientSettings.dictionaryPath;
    clientSettings.appVersion = APP_VERSION;
    clientSettings.enableAnnouncement = !!config.settings.enableAnnouncement;
    clientSettings.announcement = {
      enabled: !!config.settings.enableAnnouncement,
      message: config.settings.announcementMessage || '',
      updatedAt: config.settings.announcementUpdatedAt || 0
    };
    const configScript = `<script nonce="${nonce}">(function(){try{var t=localStorage.getItem('mdWebview-user-theme')||${safeJsonForScript(defaultTheme)};var c={'obsidian-dark':'#181825','obsidian-light':'#e6e9ef','solarized':'#002b36','zen':'#ece5d8','gruvbox':'#1d2021'}[t]||'#181825';document.documentElement.setAttribute('data-theme',t);document.documentElement.style.backgroundColor=c;var m=document.getElementById('metaThemeColor');if(m)m.setAttribute('content',c);var f=localStorage.getItem('mdWebview-user-fontsize');if(f){document.documentElement.style.setProperty('--content-font-size',f+'px');}}catch(e){}})();window.__APP_CONFIG__ = ${safeJsonForScript(clientSettings)};</script>`;
    if (html.includes('</head>')) {
      html = html.replace('</head>', `${configScript}\n</head>`);
    } else {
      html = configScript + html;
    }

    return Buffer.from(html, 'utf-8');
  };

  const indexPath = path.join(APP_ROOT, 'index.html');
  fs.readFile(indexPath, (err, data) => {
    if (err) return callback(err);
    callback(null, renderDynamicIndex(data, nonce));
  });
}

function serveStatic(req, res, pathname, query = {}) {
  // Restrict methods for static files
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, Object.assign({ 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
    res.end('Method Not Allowed');
    return;
  }

  let filePath = path.join(APP_ROOT, safeDecodeURIComponent(pathname));

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

  // 1. Blacklist Check: Block hidden files/folders, server backend source code, sensitive folders, and project config files
  const isHiddenFile = baseName.startsWith('.') || relative.split(path.sep).some(segment => segment.startsWith('.'));
  // Note: md-worker.js is a client-side Web Worker, not server backend source.
  const isServerSource = baseName === 'server.js' || baseName === 'render-worker.js' || baseName === 'index-worker.js';
  const isSensitiveFolder = relative.split(path.sep).some(segment => [
    'node_modules', 'logs', 'dicts', 'data', '.git', '.github', 'lib', 'tests'
  ].includes(segment));
  const isSensitiveConfig = resolved === CONFIG_PATH || 
                            baseName === 'package.json' || 
                            baseName === 'package-lock.json' || 
                            baseName === 'Dockerfile' || 
                            baseName === 'docker-compose.yml' ||
                            baseName.toLowerCase() === 'readme.md';

  if (!isSafe || isHiddenFile || isServerSource || isSensitiveFolder || isSensitiveConfig) {
    res.writeHead(403, Object.assign({ 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
    res.end('Forbidden');
    return;
  }

  // 2. Whitelist Check: Allow explicit public client assets and safe static media/font/document extensions
  const ALLOWED_EXACT_FILES = new Set([
    'index.html', 'app.js', 'style.css', 'marked.min.js', 's2t.js', 'md-worker.js', 
    'favicon.ico', 'favicon.svg', 'robots.txt', 'sitemap.xml', 'manifest.json', 'sw.js',
    'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png', 'favicon-32.png', 'favicon-16.png', 'icon.svg', 'og-preview.png'
  ]);
  const ALLOWED_EXTENSIONS = new Set(['.css', '.js', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.woff', '.woff2', '.ttf', '.pdf', '.xml', '.txt']);

  const isAllowedExact = ALLOWED_EXACT_FILES.has(baseName);
  const isAllowedExt = ALLOWED_EXTENSIONS.has(ext);

  if (!isAllowedExact && !isAllowedExt) {
    res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, SECURITY_HEADERS));
    res.end('Not Found');
    return;
  }

  if (baseName === 'index.html' && (pathname === '/' || pathname === '/index.html')) {
    const nonce = crypto.randomBytes(16).toString('base64');
    getIndexHtml(nonce, req, (err, data) => {
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
      const headers = indexHtmlHeaders({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        'ETag': etag
      }, nonce);
      sendCompressed(req, res, 200, headers, data);
    });
    return;
  }

  const serveCached = (entry) => {
    if (req.headers['if-none-match'] === entry.etag) {
      res.writeHead(304, Object.assign({ 'ETag': entry.etag, 'Cache-Control': entry.headers['Cache-Control'] }, SECURITY_HEADERS));
      res.end();
      return;
    }
    sendCompressed(req, res, 200, entry.headers, entry.data);
  };

  const now = Date.now();
  const cached = staticCache.get(resolved);

  if (cached && (now - cached.cachedAt) < STATIC_CACHE_TTL_MS) {
    serveCached(cached);
    return;
  }

  fs.stat(resolved, (err, stats) => {
    if (err || !stats.isFile()) {
      if (cached) staticCache.delete(resolved);

      if (ext && ext !== '.html') {
        res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, SECURITY_HEADERS));
        res.end('Not Found');
        return;
      }

      if (isCrawlerRequest(req, query)) {
        res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, SECURITY_HEADERS));
        res.end('Not Found');
        return;
      }

      const nonce = crypto.randomBytes(16).toString('base64');
      getIndexHtml(nonce, req, (err2, data) => {
        if (err2) {
          res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
          res.end('Not Found');
          return;
        }

        const etag = `W/"index-${data.length}"`;
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304, Object.assign({ 'ETag': etag, 'Cache-Control': 'no-cache' }, SECURITY_HEADERS));
          res.end();
          return;
        }

        const headers = indexHtmlHeaders({
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
          'ETag': etag
        }, nonce);

        sendCompressed(req, res, 200, headers, data);
      });
      return;
    }

    const mtimeMs = stats.mtimeMs;
    const size = stats.size;
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
      cached.cachedAt = now;
      serveCached(cached);
      return;
    }

    const etag = `W/"${size}-${Math.floor(mtimeMs)}"`;
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    let cacheControl = 'no-cache';
    if (baseName === 'sw.js') {
      cacheControl = 'no-cache, no-store, must-revalidate';
    } else {
      const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const hasVersionQuery = urlObj.search && /[?&]v=/.test(urlObj.search);
      if (hasVersionQuery) {
        cacheControl = 'public, max-age=31536000, immutable';
      } else if (ext === '.png' || ext === '.jpg' || ext === '.ico') {
        cacheControl = 'public, max-age=86400';
      }
    }

    const headers = Object.assign({
      'Content-Type': contentType,
      'Cache-Control': cacheControl,
      'ETag': etag
    }, SECURITY_HEADERS);

    if (baseName === 'sw.js') {
      headers['Service-Worker-Allowed'] = '/';
    } else if (baseName === 'manifest.json') {
      headers['Content-Type'] = 'application/manifest+json; charset=utf-8';
    }

    fs.readFile(resolved, (err3, data) => {
      if (err3) {
        res.writeHead(500, Object.assign({ 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
        res.end('Server Error');
        return;
      }
      if (size <= 5 * 1024 * 1024) {
        const entry = { mtimeMs, size, etag, headers, data, cachedAt: now };
        if (staticCache.size >= MAX_STATIC_CACHE_ENTRIES) {
          const firstKey = staticCache.keys().next().value;
          if (firstKey) staticCache.delete(firstKey);
        }
        staticCache.set(resolved, entry);
        serveCached(entry);
      } else {
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304, Object.assign({ 'ETag': etag, 'Cache-Control': cacheControl }, SECURITY_HEADERS));
          res.end();
          return;
        }
        sendCompressed(req, res, 200, headers, data);
      }
    });
  });
}

module.exports = {
  sendCompressed,
  sendJSON,
  indexHtmlHeaders,
  escapeHtmlString,
  safeJsonForScript,
  getIndexHtml,
  serveStatic,
  staticCache
};
