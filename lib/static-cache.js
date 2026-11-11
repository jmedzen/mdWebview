/**
 * @file lib/static-cache.js — Static Assets, Response Compression, and SSR Injection
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { APP_ROOT, APP_VERSION, CONFIG_PATH, MIME_TYPES, SECURITY_HEADERS, DEPLOY_TARGET, IS_SINGLE_USER, DEPLOY_TARGET_LABEL } = require('./constants');
const { getBaseUrl, isCrawlerRequest, safeDecodeURIComponent } = require('./utils');
const { config } = require('./config');
const { getAssetVersion } = require('./asset-version');

// 延遲取得 logger：static-cache 於 server.js 中先於 logger 載入，且 logger→analytics→auth→utils
// 的依賴鏈可能導致循環。以 lazy accessor 取得，尚未就緒時退回 console，永不拋錯。
let loggerRef = null;
function getLogger() {
  if (loggerRef) return loggerRef;
  try {
    const mod = require('./logger');
    if (mod && mod.Logger) {
      loggerRef = mod.Logger;
      return loggerRef;
    }
  } catch (_) {}
  return console;
}

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

  // The response body varies with Accept-Encoding, so shared/intermediary caches
  // must not hand a gzip body to a client that cannot decode it. Set on both
  // branches so the negotiated representation is always keyed correctly.
  const vary = { 'Vary': 'Accept-Encoding' };

  if (isCompressible && data.length > 1024 && acceptEncoding.includes('gzip')) {
    zlib.gzip(data, { level: zlib.constants.Z_BEST_SPEED }, (err, compressed) => {
      if (err) {
        res.writeHead(statusCode, Object.assign({}, headers, vary));
        res.end(data);
        return;
      }
      res.writeHead(statusCode, Object.assign({}, headers, vary, {
        'Content-Encoding': 'gzip',
        'Content-Length': compressed.length
      }));
      res.end(compressed);
    });
  } else {
    res.writeHead(statusCode, Object.assign({}, headers, vary, {
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

  // See sendCompressed(): the body varies with Accept-Encoding.
  const vary = { 'Vary': 'Accept-Encoding' };

  const acceptEncoding = res.reqHeadersAcceptEncoding || '';
  if (payload.length > 1024 && acceptEncoding.includes('gzip')) {
    zlib.gzip(payload, { level: zlib.constants.Z_BEST_SPEED }, (err, compressed) => {
      if (err) {
        res.writeHead(statusCode, Object.assign({}, headers, vary));
        res.end(payload);
        return;
      }
      res.writeHead(statusCode, Object.assign({}, headers, vary, {
        'Content-Encoding': 'gzip',
        'Content-Length': compressed.length
      }));
      res.end(compressed);
    });
  } else {
    res.writeHead(statusCode, Object.assign({}, headers, vary, {
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
    // 版本號唯一來源是 package.json：模板裡的 __APP_VERSION__ 在這裡換成實際版本。
    // 但資源網址的 ?v= 是「破快取用」，不能只靠人工升版號：dev 每次 push 都不升版，
    // 而 ?v= 的資源被標成 immutable，舊使用者會永遠拿舊檔。所以 ?v= 後面換成內容指紋
    // （<版本>-<雜湊>，見 lib/asset-version.js），其餘位置（畫面上顯示的版本）仍是純版本號。
    const assetVersion = getAssetVersion();
    let html = templateBuf.toString('utf-8')
      .replace(/\?v=__APP_VERSION__/g, () => `?v=${assetVersion}`)
      .replace(/__APP_VERSION__/g, APP_VERSION);
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
      html = html.replace(/<link rel="canonical"[^>]*>/i, () => `<link rel="canonical" href="${escapeHtmlString(canonicalBase)}">`);
    } else if (baseUrl) {
      html = html.replace('</head>', () => `  <link rel="canonical" href="${escapeHtmlString(canonicalBase)}">\n</head>`);
    }

    if (html.includes('<meta property="og:url"')) {
      html = html.replace(/<meta property="og:url"[^>]*>/i, () => `<meta property="og:url" content="${escapeHtmlString(canonicalBase)}">`);
    } else if (baseUrl) {
      html = html.replace('</head>', () => `  <meta property="og:url" content="${escapeHtmlString(canonicalBase)}">\n</head>`);
    }

    html = html.replace(/<meta property="og:image" content="[^"]*">/i, () => `<meta property="og:image" content="${escapeHtmlString(ogImageUrl)}">`);
    html = html.replace(/<meta name="twitter:image" content="[^"]*">/i, () => `<meta name="twitter:image" content="${escapeHtmlString(ogImageUrl)}">`);

    html = html.replace(/<meta property="og:site_name" content="[^"]*">/i, () => `<meta property="og:site_name" content="${siteName}">`);
    html = html.replace(/<meta property="og:title" content="[^"]*">/i, () => `<meta property="og:title" content="${siteName} — 佛典經論閱讀器">`);
    html = html.replace(/<meta name="twitter:title" content="[^"]*">/i, () => `<meta name="twitter:title" content="${siteName} — 佛典經論閱讀器">`);

    if (siteDesc) {
      html = html.replace(/<meta name="description" content="[^"]*">/i, () => `<meta name="description" content="${siteDesc}">`);
      html = html.replace(/<meta property="og:description" content="[^"]*">/i, () => `<meta property="og:description" content="${siteDesc}">`);
      html = html.replace(/<meta name="twitter:description" content="[^"]*">/i, () => `<meta name="twitter:description" content="${siteDesc}">`);
    }

    if (siteKeywords) {
      if (html.includes('<meta name="keywords"')) {
        html = html.replace(/<meta name="keywords" content="[^"]*">/i, () => `<meta name="keywords" content="${siteKeywords}">`);
      } else {
        html = html.replace('</head>', () => `  <meta name="keywords" content="${siteKeywords}">\n</head>`);
      }
    }

    if (html.includes('<meta name="robots"')) {
      html = html.replace(/<meta name="robots" content="[^"]*">/i, () => `<meta name="robots" content="${robotsContent}">`);
    } else {
      html = html.replace('</head>', () => `  <meta name="robots" content="${robotsContent}">\n</head>`);
    }

    let searchEngineVerTags = '';
    if (gVer) searchEngineVerTags += `  <meta name="google-site-verification" content="${gVer}">\n`;
    if (bingVer) searchEngineVerTags += `  <meta name="msvalidate.01" content="${bingVer}">\n`;
    if (baiduVer) searchEngineVerTags += `  <meta name="baidu-site-verification" content="${baiduVer}">\n`;
    if (searchEngineVerTags) {
      html = html.replace('</head>', () => `${searchEngineVerTags}</head>`);
    }

    // ── WebSite + SearchAction 結構化資料 ──────────────────────────────
    // 「Google 搜尋框結構化標記」(seoEnableSearchBox) 過去只是存進 config.json
    // 並畫在 UI 上，從來沒有任何程式碼讀取它，是名副其實的空轉開關。這裡補上
    // 真正的產出。
    //
    // 誠實的預期管理：Google 已於 2024-11-21 全面下線 Sitelinks Search Box，
    // 因此這段標記不會在 Google 搜尋結果產生站內檢索框。保留它的理由是
    // 語意完整（宣告本站有可深層連結的搜尋端點），對 schema.org 消費者、
    // AI 檢索器與第三方工具仍有價值，且 Google 明確表示殘留不受支援的標記
    // 不會造成錯誤。
    //
    // 只掛首頁：WebSite 描述的是整個站台，散落在每個子頁面只會製造重複節點。
    // 單機模式不輸出——那時整站 robots.txt 已全面 Disallow，不該再主動邀請檢索。
    if (config.settings.seoEnableSearchBox === true && !IS_SINGLE_USER) {
      let isHomepage = true;
      if (req && typeof req.url === 'string') {
        const rawQuery = req.url.split('#')[0];
        const qIdx = rawQuery.indexOf('?');
        const reqPathname = safeDecodeURIComponent(qIdx === -1 ? rawQuery : rawQuery.slice(0, qIdx));
        const reqQuery = qIdx === -1 ? '' : rawQuery.slice(qIdx + 1);
        isHomepage = (reqPathname === '/' || reqPathname === '/index.html');
        // 經文 SSR 走的是 /?file=...&ssr=1，路徑同樣是 "/"，單看路徑會誤判
        // 而把 WebSite 節點重複塞進每一篇經文。以 file 參數排除。
        if (/(^|&)file=/.test(reqQuery)) isHomepage = false;
      }

      if (isHomepage) {
        const websiteLd = {
          '@context': 'https://schema.org',
          '@type': 'WebSite',
          name: config.settings.siteName || 'mdWebview',
          url: canonicalBase,
          inLanguage: 'zh-TW'
        };
        // 沒有絕對網址就無法組出可用的 search target，寧可只留 WebSite 節點
        // 也不要送出一個相對路徑的樣板讓檢索器無所適從。
        if (baseUrl) {
          websiteLd.potentialAction = {
            '@type': 'SearchAction',
            target: {
              '@type': 'EntryPoint',
              urlTemplate: `${canonicalBase}?search={search_term_string}`
            },
            'query-input': 'required name=search_term_string'
          };
        }
        const websiteTag = `  <script type="application/ld+json" nonce="${nonce}">${safeJsonForScript(websiteLd)}</script>\n`;
        html = html.replace('</head>', () => `${websiteTag}</head>`);
      }
    }

    const themeColors = {
      'obsidian-dark': '#0f1522',
      'obsidian-light': '#eeeeec',
      'solarized': '#141814',
      'zen': '#ece5d8',
      'gruvbox': '#1d2021'
    };
    const initialThemeColor = themeColors[defaultTheme] || '#0f1522';

    html = html.replace(/<meta name="theme-color" content="[^"]*">/i, () => `<meta name="theme-color" id="metaThemeColor" content="${initialThemeColor}">`);

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

    html = html.replace(/<title>.*?<\/title>/i, () => `<title>${siteName} — 佛典經論閱讀器</title>`);
    html = html.replace(/<span class="logo-text">.*?<\/span>/i, () => `<span class="logo-text">${siteName}</span>`);
    html = html.replace(/<h1 class="welcome-title">.*?<\/h1>/i, () => `<h1 class="welcome-title">${siteName}</h1>`);

    const clientSettings = Object.assign({}, config.settings);
    delete clientSettings.mdRoot;
    delete clientSettings.dictionaryPath;
    clientSettings.appVersion = APP_VERSION;
    // 頁面載入當下的資源指紋；前端定期與 /api/version 比對，不同就提示重新載入。
    clientSettings.assetVersion = assetVersion;
    // Deployment mode is a client concern too: it decides whether the first-run
    // administrator modal may appear, whether the admin/SEO/analytics tabs are
    // reachable, and whether maintenance actions need a password.
    clientSettings.deployTarget = DEPLOY_TARGET;
    clientSettings.deployTargetLabel = DEPLOY_TARGET_LABEL;
    clientSettings.isSingleUser = IS_SINGLE_USER;
    clientSettings.authMode = IS_SINGLE_USER ? 'single-user' : 'admin';
    clientSettings.enableAnnouncement = !!config.settings.enableAnnouncement;
    clientSettings.announcement = {
      enabled: !!config.settings.enableAnnouncement,
      message: config.settings.announcementMessage || '',
      updatedAt: config.settings.announcementUpdatedAt || 0,
      collapsed: config.settings.announcementCollapsedCount ?? 3
    };
    // The early inline script runs before first paint, so stamping the deploy
    // target on <html> here lets CSS hide web-only UI (and vice versa) without
    // the administrator modal flashing into view on a single-user launch.
    const configScript = `<script nonce="${nonce}">(function(){try{document.documentElement.setAttribute('data-deploy-target',${safeJsonForScript(DEPLOY_TARGET)});}catch(e){}try{var t=localStorage.getItem('mdWebview-user-theme')||${safeJsonForScript(defaultTheme)};var c={'obsidian-dark':'#0f1522','obsidian-light':'#eeeeec','solarized':'#141814','zen':'#ece5d8','gruvbox':'#1d2021','paper':'#f3efe6','moon':'#e7ecf4','bamboo':'#e8ecdf'}[t]||'#0f1522';document.documentElement.setAttribute('data-theme',t);document.documentElement.style.backgroundColor=c;var m=document.getElementById('metaThemeColor');if(m)m.setAttribute('content',c);var f=localStorage.getItem('mdWebview-user-fontsize');if(f){document.documentElement.style.setProperty('--content-font-size',f+'px');}}catch(e){}})();window.__APP_CONFIG__ = ${safeJsonForScript(clientSettings)};</script>`;
    if (html.includes('</head>')) {
      html = html.replace('</head>', () => `${configScript}\n</head>`);
    } else {
      html = configScript + html;
    }

    return Buffer.from(html, 'utf-8');
  };

  const indexPath = path.join(APP_ROOT, 'index.html');
  fs.readFile(indexPath, (err, data) => {
    if (err) {
      // index.html 是 SSR 的根基；讀取失敗並非一般 404 流量，必須留下痕跡。
      if (err.code !== 'ENOENT') getLogger().error('SSR', `Failed to read index.html for SSR: ${indexPath}`, err);
      return callback(err);
    }
    callback(null, renderDynamicIndex(data, nonce));
  });
}

/**
 * 內容雜湊 ETag。
 *
 * 過去用 `size-mtime`：同樣大小的修改（改一個數字、換一個字）加上被正規化的 mtime
 * （可重現建置、COPY 保留來源時間）就會得到相同 ETag，瀏覽器重新驗證時被回 304，
 * 繼續用舊檔。內容雜湊不依賴檔案時間；我們本來就要讀完整檔案才送出，多算一次 sha1
 * 的成本（app.js 約 1 ms）可以忽略。保留 W/ 前綴：gzip 與非 gzip 版本位元組不同，
 * 弱驗證才符合語意。
 */
function contentEtag(data) {
  return `W/"${crypto.createHash('sha1').update(data).digest('hex').slice(0, 20)}"`;
}

/**
 * 靜態資源的 Cache-Control，依「這次請求的網址」決定，不可存進共用的記憶體快取項目——
 * 同一個檔案可能以 `app.js?v=…`、`app.js` 等不同網址被請求，先到的請求不能決定後到者的快取政策。
 *
 *  - `?v=` 等於目前資源指紋 → immutable（網址本身就代表這份內容，一年內不必再問）。
 *  - `?v=` 與目前指紋不同（舊頁面、手打的網址）→ no-cache：回傳的是「現在的內容」，
 *    若標成 immutable，舊網址會把新內容永久釘在瀏覽器裡，下次又對不上。
 *  - 沒有 ?v= → no-cache（每次以 ETag 重新驗證，內容沒變就是便宜的 304）；
 *    圖片類沒有內容會常改的需求，維持一天。
 */
function staticCacheControl(reqUrl, ext) {
  let v = null;
  try { v = new URL(reqUrl, 'http://localhost').searchParams.get('v'); } catch (_) { /* 網址異常視為沒有 v */ }
  if (v) return v === getAssetVersion() ? 'public, max-age=31536000, immutable' : 'no-cache';
  if (ext === '.png' || ext === '.jpg' || ext === '.ico') return 'public, max-age=86400';
  return 'no-cache';
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
    'node_modules', 'logs', 'index', 'dicts', 'data', '.git', '.github', 'lib', 'tests', 'tools', 'tts-cache'
  ].includes(segment));
  // Never expose a config file through static serving, even when CONFIG_PATH
  // points outside APP_ROOT or uses a non-default filename.
  const isSensitiveConfig = resolved === path.resolve(CONFIG_PATH) ||
                            baseName.toLowerCase() === 'config.json' ||
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
    'index.html', 'app.js', 'style.css', 'marked.min.js', 'md-worker.js', 
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
      // No ETag / 304 for the app shell. Every response carries a fresh CSP
      // nonce, so the body is never byte-identical; worse, a 304 would make the
      // browser keep the cached HTML (old nonce) but adopt the 304's headers,
      // whose CSP has no matching nonce — blocking the inline config script on
      // every reload. A length-based ETag also served stale settings whenever
      // an edit (e.g. the announcement) kept the same byte length.
      const headers = indexHtmlHeaders({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache'
      }, nonce);
      sendCompressed(req, res, 200, headers, data);
    });
    return;
  }

  // sw.js 不走記憶體快取：它內含的 CACHE_VERSION 取決於「所有前端檔案」的指紋，
  // 而不只是 sw.js 自己的 mtime／大小。若跟其他檔案一樣以 sw.js 本身的 mtime 快取，
  // app.js 改了、sw.js 沒改，就會一直送出舊指紋，Service Worker 永遠不更新。
  // 檔案只有幾 KB，每次現讀現換最單純。
  if (resolved === path.join(APP_ROOT, 'sw.js')) {
    fs.readFile(resolved, (swErr, swData) => {
      if (swErr) {
        if (swErr.code !== 'ENOENT') getLogger().error('HTTP', `Failed to read static asset: ${resolved}`, swErr);
        res.writeHead(swErr.code === 'ENOENT' ? 404 : 500, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, SECURITY_HEADERS));
        res.end(swErr.code === 'ENOENT' ? 'Not Found' : 'Server Error');
        return;
      }
      // CACHE_VERSION 與頁面的 ?v= 同源（資源指紋），sw.js 本身不用手動升版
      const assetVersion = getAssetVersion();
      const body = Buffer.from(swData.toString('utf-8').replace(/__APP_VERSION__/g, () => assetVersion), 'utf-8');
      sendCompressed(req, res, 200, Object.assign({
        'Content-Type': MIME_TYPES[ext] || 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Service-Worker-Allowed': '/'
      }, SECURITY_HEADERS), body);
    });
    return;
  }

  const serveCached = (entry) => {
    // Cache-Control 依本次請求網址決定（見 staticCacheControl），不從 entry 取。
    const cacheControl = staticCacheControl(req.url, ext);
    if (req.headers['if-none-match'] === entry.etag) {
      res.writeHead(304, Object.assign({ 'ETag': entry.etag, 'Cache-Control': cacheControl }, SECURITY_HEADERS));
      res.end();
      return;
    }
    sendCompressed(req, res, 200, Object.assign({}, entry.headers, { 'Cache-Control': cacheControl }), entry.data);
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

      // 一般檔案不存在 (ENOENT) 屬正常流量，其餘 I/O 失敗需留下痕跡。
      if (err && err.code !== 'ENOENT') getLogger().error('HTTP', `Failed to stat static asset: ${resolved}`, err);

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

        // See the index.html branch above: no ETag / 304 for nonce-bearing HTML.
        const headers = indexHtmlHeaders({
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache'
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

    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(resolved, (err3, data) => {
      if (err3) {
        getLogger().error('HTTP', `Failed to read static asset: ${resolved}`, err3);
        res.writeHead(500, Object.assign({ 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
        res.end('Server Error');
        return;
      }

      // entry.headers 不含 Cache-Control：它依請求網址而異，在 serveCached 補上。
      const headers = Object.assign({
        'Content-Type': baseName === 'manifest.json' ? 'application/manifest+json; charset=utf-8' : contentType,
        'ETag': contentEtag(data)
      }, SECURITY_HEADERS);

      const entry = { mtimeMs, size, etag: headers.ETag, headers, data, cachedAt: now };
      if (size <= 5 * 1024 * 1024) {
        if (staticCache.size >= MAX_STATIC_CACHE_ENTRIES) {
          const firstKey = staticCache.keys().next().value;
          if (firstKey) staticCache.delete(firstKey);
        }
        staticCache.set(resolved, entry);
      }
      serveCached(entry);
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
  staticCache,
  contentEtag,
  staticCacheControl
};
