/**
 * @file server.js — mdWebview Backend Server
 * @version 3.7.1
 *
 * 單一 Node.js HTTP 伺服器（無外部框架），提供：
 *   - SPA 首頁 SSR 注入（主題、字型、站名、公告、config）
 *   - 靜態資源服務（記憶體 LRU 快取 + ETag + Gzip）
 *   - Markdown Worker Thread Pool（SSR 爬蟲預渲染）
 *   - Bigram 雙字元倒排索引（全文搜尋 + 辭典搜尋）
 *   - 90 天持久化 Analytics Log + 7 天修剪排程
 *   - 後台管理 API（PBKDF2 auth + session + 設定儲存）
 *   - PWA 支援（動態 manifest.json、robots.txt、sitemap.xml）
 *
 * ── 段落索引（Section Map）────────────────────────────────────
 *   §0  Globals & Logging        System log buffer, bot detection, logger utility
 *   §1  Analytics & Log Pruning  90-day analytics store, 7-day pruning job
 *   §2  Worker Thread Pools      render-worker & persistent index-worker pools
 *   §3  Config & Symlink Defense loadConfig, saveConfig, symlink traversal check
 *   §4  Security Headers & SSR   CSP nonce, getIndexHtml() SSR injection
 *   §5  Compression & Helpers    sendCompressed (gzip), sendJSON
 *   §6  File Tree & Watcher      handleTree (/api/tree), fs.watch cache invalidation
 *   §7  SEO & Manifest           robots.txt, manifest.json, sitemap.xml
 *   §8  Crawler SSR              handleCrawlerSsr() pre-render for bots
 *   §9  File & Media Servers     handleFile (/api/file), handleMedia (/api/media)
 *   §10 Large-File Chunked API   handleSectionIndex, handleRender
 *   §11 Section Index Engine     getSectionIndex, binary disk cache (.bin)
 *   §12 Bigram Search Engine     buildSearchIndexAsync, binary cache, worker jobs
 *   §13 Dictionary Index & API   buildDictIndexAsync, handleDictHeadwords, handleDictSearch
 *   §14 Search Handlers          handleSearch (/api/search), handleFileSearch, handlePageSearch
 *   §15 Static Asset Cache       serveStatic, LRU memory cache, ETag
 *   §16 Auth & Rate Limiting     PBKDF2 hash, session store, sliding window rate limiter
 *   §17 Analytics API            handleAnalytics, handleAnalyticsExport (CSV/JSON)
 *   §18 Daily Words & Suggest    Mulberry32 deterministic RNG, handleSuggestList
 *   §19 System Hardware Stats    getSystemHardwareStats, handleHardwareStats
 *   §20 HTTP Server & Router     Main request dispatch & admin API routes
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const os = require('os');
const net = require('net');
const v8 = require('v8');
const readline = require('readline');
const { Worker } = require('worker_threads');
const { marked } = require('marked');  // Still needed for inline fallback
let toTraditional = s => s, hasSimplified = () => false;
try {
  const s2t = require('./s2t');
  toTraditional = s2t.toTraditional;
  hasSimplified = s2t.hasSimplified;
} catch (e) {
  // Graceful fallback if s2t is not available
}

// ── Core Native Modules (Refactored to lib/) ───────────────────────────────
const {
  APP_ROOT, PORT, CONFIG_PATH, APP_VERSION, MAX_LOG_BUFFER,
  CRAWLER_UA_REGEX, LOG_DIR, ANALYTICS_STORE_PATH, ANALYTICS_STORE_VERSION,
  MIME_TYPES, SECURITY_HEADERS
} = require('./lib/constants');

const {
  escapeXml, formatTimestampInTz, mulberry32, getCrawlerName,
  isCrawlerRequest, isBotEntry, extractAnalyticsPath, extractAnalyticsQuery,
  getRootRealpath, isRealPathWithinRoot, clearRealpathCache,
  flattenMarkdownFiles, getClientIP, getBaseUrl,
  safeDecodeURI, safeDecodeURIComponent
} = require('./lib/utils');

const {
  config, loadConfig, saveConfig, setupConfigWatcher, resetConfigWatcher,
  getMdRoot, deriveDictRoot, getDictionaryPath, invalidateMdRootMemo,
  isRealPathWithinMdRoot
} = require('./lib/config');

const {
  sessions, SESSION_DURATION, loginAttempts, MAX_ATTEMPTS, LOCK_DURATION,
  apiRateLimits, checkApiRateLimit, timingSafeCompare, hashPassword,
  generateSessionToken, verifySameOrigin, isAuthenticated, readJSONBody
} = require('./lib/auth');

const {
  workerPool, indexWorkerPool, initWorkerPool, initIndexWorkerPool,
  getIndexWorkerPool, renderWithWorker, executeIndexJob, runIndexWorkerPool,
  terminateWorkerPools
} = require('./lib/worker-pool');

const {
  analyticsStore, getLogFilePath, appendToPersistentLog, getAnalyticsEventId,
  updateAnalyticsStoreEntry, saveAnalyticsStore, queueAnalyticsStoreEntry,
  initializeAnalyticsStore, cleanOldLogsJob, buildAggregateAnalyticsData,
  getAnalyticsData, parseAnalyticsRange,
  setInMemoryLogBufferRef
} = require('./lib/analytics');

const {
  systemLogBuffer, pushToLogBuffer, Logger
} = require('./lib/logger');

const {
  sendCompressed, sendJSON, indexHtmlHeaders, escapeHtmlString,
  safeJsonForScript, getIndexHtml, serveStatic, staticCache
} = require('./lib/static-cache');

const {
  extractBigramsFromText, normalizeLooseTerm
} = require('./lib/text');

const {
  stripFrontmatter
} = require('./lib/markdown');

// Configure marked once at startup
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

// ── Last-resort error containment ──────────────────────────────────────────
// Never let an uncaught exception or unhandled rejection take down the whole
// server. Log it and keep serving. The per-request guards above handle the
// known vectors; this is defense-in-depth for anything unexpected.
process.on('uncaughtException', (err) => {
  Logger.error('Process', 'Uncaught exception', err);
});
process.on('unhandledRejection', (reason) => {
  Logger.error('Process', 'Unhandled rejection', reason instanceof Error ? reason : new Error(String(reason)));
});


// ── §2-§5 Worker Pool, Config, Static Cache, and SSR (refactored to lib/) ──

let cachedTree = null;
let cachedSitemapXml = null;
let treeWatcher = null;
const searchCache = new Map(); // key: "folder::q" -> { time, data }
const SEARCH_CACHE_MAX = 30;

const searchMetrics = {
  totalQueries: 0,
  cacheHits: 0,
  cacheMisses: 0,
  totalSearchTimeMs: 0,
  lastSearchTimeMs: 0
};

const httpMetrics = {
  totalRequests: 0,
  totalResponseTimeMs: 0,
  recentRequestTimes: [] // Timestamps for 60s sliding window RPM
};

// Bound the sliding-window RPM buffer so a flood of requests can never grow it
// unboundedly (the 30 req/s API rate limit ≈ 1800/min; 5000 gives ample headroom).
const MAX_RECENT_REQUEST_TIMES = 5000;

const VAULT_INDEX_DEBOUNCE_MS = 20000; // 20 秒延遲防抖，避免大量檔案異動時 CPU 卡死
let activeIndexBuildId = 0;
let treeWatcherDebounceTimer = null;
let treeWatcherStartTime = 0;
let treeWatcherChangeCount = 0;
let sitemapDirty = false;
let sitemapBuilding = false;
let lastKnownBaseUrl = '';

function setupTreeWatcher() {
  if (treeWatcher) return;
  try {
    const mdRoot = getMdRoot();
    if (fs.existsSync(mdRoot)) {
      treeWatcherStartTime = Date.now();
      treeWatcher = fs.watch(mdRoot, { recursive: true }, (eventType, filename) => {
        // Ignore initial macOS fs.watch attach noise within 3 seconds of initialization
        if (Date.now() - treeWatcherStartTime < 3000) {
          return;
        }

        // Ignore hidden system files (.DS_Store, .git, .tmp, etc.)
        if (filename && (filename.startsWith('.') || filename.includes('/.'))) {
          return;
        }

        // Invalidate tree and search cache; mark sitemap as dirty (deferred debounced update)
        cachedTree = null;
        searchCache.clear();
        sitemapDirty = true;
        if (filename) {
          if (sectionIndexCache.has(filename)) {
            sectionIndexCache.delete(filename);
          } else {
            for (const k of sectionIndexCache.keys()) {
              if (k === filename || k.endsWith('/' + filename)) {
                sectionIndexCache.delete(k);
              }
            }
          }
        } else {
          invalidateSectionIndexes();
        }

        // 立即中止任何正在進行中的舊索引建置，釋放 CPU 資源以因應正在進行的檔案寫入
        activeIndexBuildId++;
        searchIndex.building = false;

        // Debounce index rebuild and sitemap auto-update by 20 seconds to handle batch file operations cleanly.
        // 第一次檔案異動事件發生時絕不立即執行重建，必須等待完整 20 秒沉降期。
        // 若在 20 秒內又有新檔案變更，計時器將自動重置，重新計算 20 秒。
        treeWatcherChangeCount++;
        const isFirstEvent = !treeWatcherDebounceTimer;
        if (treeWatcherDebounceTimer) {
          clearTimeout(treeWatcherDebounceTimer);
        }
        if (isFirstEvent) {
          Logger.info('Index', `Vault file changed [#${treeWatcherChangeCount}]: "${filename || 'unknown'}" (${eventType}). Aborting active build & waiting ${VAULT_INDEX_DEBOUNCE_MS / 1000}s debounce before index & sitemap rebuild...`);
        } else {
          Logger.info('Index', `Vault file changed [#${treeWatcherChangeCount}]: "${filename || 'unknown'}" (${eventType}). Resetting countdown, waiting another ${VAULT_INDEX_DEBOUNCE_MS / 1000}s...`);
        }
        treeWatcherDebounceTimer = setTimeout(() => {
          const totalChanges = treeWatcherChangeCount;
          treeWatcherDebounceTimer = null;
          treeWatcherChangeCount = 0;
          Logger.info('Index', `Vault files quiet for ${VAULT_INDEX_DEBOUNCE_MS / 1000}s (accumulated ${totalChanges} change events). Starting Bigram Index build & Sitemap auto-update...`);
          buildSearchIndexAsync(true).catch(() => {});
          if (sitemapDirty) {
            Logger.info('SEO', `Triggering debounced sitemap auto-update after ${totalChanges} vault change events...`);
            autoRebuildSitemapAsync().catch(() => {});
          }
        }, VAULT_INDEX_DEBOUNCE_MS);
      });
    }
  } catch (err) {
    Logger.error('Index', 'Error setting up tree watcher', err);
  }
}

function resetTreeWatcher() {
  if (treeWatcherDebounceTimer) {
    clearTimeout(treeWatcherDebounceTimer);
    treeWatcherDebounceTimer = null;
  }
  treeWatcherChangeCount = 0;
  if (treeWatcher) {
    try {
      treeWatcher.close();
    } catch (err) {}
    treeWatcher = null;
  }
  invalidateMdRootMemo();
  cachedTree = null;
  cachedSitemapXml = null;
  sitemapDirty = true;
  searchCache.clear();
  searchIndex.ready = false;
  Logger.info('Index', 'Vault configuration changed: Resetting tree watcher, Bigram Index and Sitemap');
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
      promises.push(
        fs.promises.stat(fullPath)
          .then(st => ({ size: st.size, mtime: st.mtime }))
          .catch(() => ({ size: 0, mtime: null }))
          .then(({ size, mtime }) => {
            result.push({
              name: entry.name.replace(/\.md$/, ''),
              path: relPath,
              type: 'file',
              size,
              mtime
            });
          })
      );
    }
  }
  await Promise.all(promises);
  result.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-TW', { numeric: true, sensitivity: 'base' });
  });
  return result;
}

// ── §6 API: Directory Tree & Watcher ─────────────────────────
/**
 * 傳回整個 Markdown 保管庫的目錄樹（GET /api/tree）。
 * 首次呼叫時掃描磁碟並快取；後續呼叫命中記憶體快取。
 * 當 fs.watch 偵測到目錄異動時快取會被清除，觸發下次請求重新掃描。
 *
 * @param {http.IncomingMessage} req - HTTP 請求物件
 * @param {http.ServerResponse}  res - HTTP 回應物件
 */
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
    Logger.error('Tree', 'Failed to scan vault directory', err, req);
    sendJSON(res, 500, { error: 'Failed to load file tree' });
  }
}

// ── §7 SEO: Robots, Manifest & Sitemap ───────────────────────

function handleRobotsTxt(req, res) {
  const baseUrl = getBaseUrl(req);
  const lines = [];

  if (!config.settings || config.settings.seoRobotsIndex !== true) {
    lines.push('User-agent: *');
    lines.push('Disallow: /');
  } else {
    lines.push('User-agent: *');
    lines.push('Allow: /');

    const disallowRaw = (config.settings && config.settings.seoDisallowPaths) || '/api/\n/vendor/';
    const disallowList = String(disallowRaw)
      .split(/[\r\n,]+/)
      .map(s => s.trim())
      .filter(Boolean);

    for (const p of disallowList) {
      lines.push(`Disallow: ${p.startsWith('/') ? p : '/' + p}`);
    }

    if (config.settings && config.settings.seoBlockAiBots !== false) {
      lines.push('');
      lines.push('# Block AI Training & Scraper Bots');
      const aiBots = ['GPTBot', 'CCBot', 'ClaudeBot', 'Google-Extended', 'Bytespider', 'Diffbot'];
      for (const bot of aiBots) {
        lines.push(`User-agent: ${bot}`);
        lines.push('Disallow: /');
      }
    }
  }

  lines.push('');
  lines.push(`Sitemap: ${baseUrl}/sitemap.xml`);
  lines.push('');

  const robots = lines.join('\n');
  res.writeHead(200, Object.assign({
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'public, max-age=86400',
    'X-Content-Type-Options': 'nosniff'
  }, SECURITY_HEADERS));
  res.end(robots);
}

let cachedManifestRaw = null;
/**
 * 動態 PWA Web App Manifest 處理器 (GET /manifest.json)。
 * 依據伺服器當前 config.settings.siteName 動態替換 manifest 中的 name 與 short_name，
 * 並提供 ETag 與 1 小時快取控制。
 *
 * @param {http.IncomingMessage} req - HTTP 請求物件
 * @param {http.ServerResponse} res - HTTP 回應物件
 */
function handleManifestJson(req, res) {
  const manifestPath = path.join(APP_ROOT, 'manifest.json');
  const generateAndSend = (rawStr) => {
    try {
      const parsed = JSON.parse(rawStr);
      const siteName = (config.settings && config.settings.siteName) ? config.settings.siteName : 'mdWebview';
      parsed.name = `${siteName} — 佛典經論閱讀器`;
      parsed.short_name = siteName;
      const data = Buffer.from(JSON.stringify(parsed, null, 2), 'utf-8');
      const etag = `"${crypto.createHash('md5').update(data).digest('hex')}"`;
      const headers = Object.assign({
        'Content-Type': 'application/manifest+json; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
        'ETag': etag
      }, SECURITY_HEADERS);
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers);
        res.end();
        return;
      }
      sendCompressed(req, res, 200, headers, data);
    } catch (e) {
      const data = Buffer.from(rawStr, 'utf-8');
      sendCompressed(req, res, 200, { 'Content-Type': 'application/manifest+json; charset=utf-8' }, data);
    }
  };

  if (cachedManifestRaw) {
    generateAndSend(cachedManifestRaw);
  } else {
    fs.readFile(manifestPath, 'utf8', (err, content) => {
      if (err) {
        res.writeHead(500, Object.assign({ 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
        res.end('Server Error');
        return;
      }
      cachedManifestRaw = content;
      generateAndSend(cachedManifestRaw);
    });
  }
}

/**
 * 遍歷保管庫並產生標準 sitemap.xml 內容。
 * 支援傳入自訂 baseUrl 與預先掃描好的目錄樹（optionalTree），避免重複磁碟 I/O。
 *
 * @param {string} [baseUrl] - 網站基礎網址
 * @param {Array} [optionalTree] - 預先掃描的目錄樹（可選）
 * @returns {Promise<{ xml: string, totalUrls: number }>}
 */
async function generateSitemapXml(baseUrl, optionalTree = null) {
  let tree = optionalTree || cachedTree;
  if (!tree) {
    tree = await scanDirAsync(getMdRoot(), '');
    cachedTree = tree;
  }

  const files = flattenMarkdownFiles(tree);
  const today = new Date().toISOString().slice(0, 10);
  const effectiveBaseUrl = (baseUrl || getBaseUrl(null)).replace(/\/+$/, '');

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

  // 1. 首頁
  xml += '  <url>\n';
  xml += `    <loc>${escapeXml(effectiveBaseUrl)}/</loc>\n`;
  xml += `    <lastmod>${today}</lastmod>\n`;
  xml += '    <changefreq>daily</changefreq>\n';
  xml += '    <priority>1.0</priority>\n';
  xml += '  </url>\n';

  // 2. 所有 Markdown 檔案
  for (const file of files) {
    const locUrl = `${effectiveBaseUrl}/?file=${encodeURIComponent(file.path)}`;
    let lastmod = today;
    if (file.mtime) {
      try {
        lastmod = new Date(file.mtime).toISOString().slice(0, 10);
      } catch (_) {}
    }
    xml += '  <url>\n';
    xml += `    <loc>${escapeXml(locUrl)}</loc>\n`;
    xml += `    <lastmod>${lastmod}</lastmod>\n`;
    xml += '    <changefreq>monthly</changefreq>\n';
    xml += '    <priority>0.8</priority>\n';
    xml += '  </url>\n';
  }

  xml += '</urlset>\n';
  return { xml, totalUrls: files.length + 1 };
}

/**
 * 背景自動重新建置 sitemap.xml（防抖 20 秒沉降期滿時觸發）。
 * 在大量檔案上傳完畢且靜止後自動執行，防止爬蟲即時請求時承受 CPU 負載。
 */
async function autoRebuildSitemapAsync() {
  if (sitemapBuilding) {
    Logger.debug('SEO', 'Background sitemap rebuild already in progress, skipping duplicate trigger');
    return;
  }
  sitemapBuilding = true;
  try {
    const t0 = Date.now();
    Logger.info('SEO', 'Starting debounced background auto-rebuild for sitemap.xml...');
    const baseUrl = getBaseUrl(null);
    const { xml, totalUrls } = await generateSitemapXml(baseUrl);
    cachedSitemapXml = xml;
    sitemapDirty = false;
    const durationMs = Date.now() - t0;
    const xmlBytes = Buffer.byteLength(xml, 'utf8');
    const xmlKb = (xmlBytes / 1024).toFixed(1);
    Logger.info('SEO', `Sitemap automatically rebuilt in background: ${totalUrls} URLs (${xmlKb} KB) in ${durationMs}ms`);
  } catch (err) {
    Logger.error('SEO', 'Failed to auto-rebuild sitemap in background', err);
  } finally {
    sitemapBuilding = false;
  }
}

async function handleSitemapXml(req, res) {
  setupTreeWatcher();
  const baseUrl = getBaseUrl(req);

  // 1. 若已有快取：
  //    - 若目前處於大量檔案變更 debounce 期間（treeWatcherDebounceTimer 存在），或者 sitemap 尚未變更（!sitemapDirty）：
  //      立即回傳現有快取（Stale-While-Revalidate），避免大量檔案寫入時掃描磁碟造成 CPU 飆高！
  if (cachedSitemapXml && (treeWatcherDebounceTimer || !sitemapDirty)) {
    const isDebouncing = !!treeWatcherDebounceTimer;
    if (isDebouncing) {
      Logger.info('SEO', 'GET /sitemap.xml served from cache during vault write cooldown (debounce protected, Stale-While-Revalidate)', req);
    } else {
      Logger.debug('SEO', 'GET /sitemap.xml served from memory cache', req);
    }
    res.writeHead(200, Object.assign({
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff'
    }, SECURITY_HEADERS));
    return res.end(cachedSitemapXml);
  }

  // 2. 若快取不存在（冷啟動尚未生成）或防抖沉降已過且需即時建置：
  try {
    const t0 = Date.now();
    const { xml, totalUrls } = await generateSitemapXml(baseUrl);
    cachedSitemapXml = xml;
    sitemapDirty = false;
    const durationMs = Date.now() - t0;
    const xmlBytes = Buffer.byteLength(xml, 'utf8');
    const xmlKb = (xmlBytes / 1024).toFixed(1);
    Logger.info('SEO', `GET /sitemap.xml generated on demand: ${totalUrls} URLs (${xmlKb} KB) in ${durationMs}ms`, req);

    res.writeHead(200, Object.assign({
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff'
    }, SECURITY_HEADERS));
    res.end(cachedSitemapXml);
  } catch (err) {
    Logger.error('SEO', 'Failed to generate sitemap.xml', err, req);
    res.writeHead(500, Object.assign({ 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
    res.end('Failed to generate sitemap.xml');
  }
}

// ── §8 Crawler SSR Pre-rendering ─────────────────────────────

function extractMarkdownMetadata(rawMarkdown, fallbackName) {
  let title = fallbackName;
  // Match first heading: '# Title' or '## Title'
  const headingMatch = rawMarkdown.match(/^#{1,3}\s+(.+)$/m);
  if (headingMatch) {
    title = headingMatch[1].replace(/[*_~`]/g, '').trim();
  }

  // Extract description: first non-empty paragraph, stripped of markdown symbols
  const lines = rawMarkdown.split('\n');
  const descLines = [];
  let inFrontmatter = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (descLines.length > 0) break;
      continue;
    }
    if (trimmed === '---') {
      inFrontmatter = !inFrontmatter;
      continue;
    }
    if (inFrontmatter) continue;
    if (trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('![')) continue; // skip images
    if (trimmed.startsWith('```')) continue; // skip code blocks

    const cleanLine = trimmed
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // link text
      .replace(/[*_~`]/g, '')
      .replace(/^>\s*/, '');
    if (cleanLine) {
      descLines.push(cleanLine);
      if (descLines.join(' ').length >= 160) break;
    }
  }

  let description = descLines.join(' ').slice(0, 180).trim();
  if (!description) {
    description = `${title} — 線上閱讀佛典經論釋記。`;
  } else if (description.length >= 180) {
    description += '...';
  }

  return { title, description };
}

/**
 * 為爬蟲/搜尋引擎機器人執行 SSR 預渲染（伺服器端渲染），傳回完整 HTML。
 * 一般使用者請求則由前端 SPA 處理，不進入此函數。
 *
 * 處理流程：
 *   1. 路徑驗證與 symlink 逃逸防護
 *   2. 讀取目標 Markdown 檔案
 *   3. 透過 Markdown Worker Thread Pool 渲染為 HTML
 *   4. 萃取標題/描述（extractMarkdownMetadata）
 *   5. 注入 SSR 內容到 index.html 模板（meta 標籤、Schema.org JSON-LD、正文）
 *
 * @param {http.IncomingMessage} req      - HTTP 請求物件
 * @param {http.ServerResponse}  res      - HTTP 回應物件
 * @param {string}               filePath - 相對於 mdRoot 的 Markdown 路徑
 * @param {Object}               query    - 已解析的 URL 查詢參數
 */
async function handleCrawlerSsr(req, res, filePath, query) {
  const baseUrl = getBaseUrl(req);
  const siteName = escapeHtmlString(config.settings.siteName || 'mdWebview');
  let rawOgImage = (config.settings.seoOgImage || '/og-preview.png').trim();
  const ogImageUrl = rawOgImage.startsWith('http://') || rawOgImage.startsWith('https://')
    ? rawOgImage
    : (baseUrl ? `${baseUrl}${rawOgImage.startsWith('/') ? '' : '/'}${rawOgImage}` : rawOgImage);

  // ── Mode A: Crawler Homepage SSR (Rich Semantic Landing Page) ──────────
  if (!filePath) {
    const nonce = crypto.randomBytes(16).toString('base64');
    return getIndexHtml(nonce, req, async (err, baseHtmlBuffer) => {
      if (err) {
        res.writeHead(500, Object.assign({ 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
        return res.end('Server Error');
      }

      let html = baseHtmlBuffer.toString('utf-8');
      const canonicalUrl = `${baseUrl}/`;
      const pageTitle = `${siteName} — 佛典經論閱讀器`;
      const homeSummary = config.settings.seoHomepageSummary || config.settings.seoSiteDescription || `${siteName} — 線上閱讀與經論研習。`;
      const safeDesc = escapeHtmlString(config.settings.seoSiteDescription || homeSummary);

      // Render rich semantic homepage content for bots to eliminate Soft 404
      let crawlBody = `<div class="crawler-homepage-content" style="max-width:860px;margin:32px auto;padding:24px;line-height:1.8;">`;
      crawlBody += `<h1 style="font-size:2rem;margin-bottom:16px;">${siteName}</h1>`;
      crawlBody += `<p style="font-size:1.1rem;color:#555;margin-bottom:24px;">${escapeHtmlString(homeSummary)}</p>`;

      // Inject structured links to suggest list or vault
      try {
        const sl = config.settings.suggestList || {};
        if (sl.adminList && sl.adminList.length > 0) {
          crawlBody += `<h2 style="font-size:1.4rem;margin:24px 0 12px;">精選推薦經文</h2><ul>`;
          for (const item of sl.adminList.slice(0, 15)) {
            const cleanPath = String(item).trim();
            const displayName = path.basename(cleanPath, '.md');
            crawlBody += `<li><a href="${baseUrl}/?file=${encodeURIComponent(cleanPath)}">${escapeHtmlString(displayName)}</a></li>`;
          }
          crawlBody += `</ul>`;
        }
      } catch (_) {}

      crawlBody += `<p style="margin-top:32px;"><a href="${baseUrl}/sitemap.xml">檢視全站經文索引 Sitemap.xml</a></p>`;
      crawlBody += `</div>`;

      // Replace Title & Description
      html = html.replace(/<title>.*?<\/title>/i, `<title>${pageTitle}</title>`);
      html = html.replace(/<meta name="description" content="[^"]*">/i, `<meta name="description" content="${safeDesc}">`);

      // Reveal contentWrapper with rich homepage intro
      html = html.replace(/<div class="welcome-screen" id="welcomeScreen">/i, '<div class="welcome-screen" id="welcomeScreen" style="display:none">');
      html = html.replace(/<div class="content-wrapper" id="contentWrapper" style="display:none">/i, '<div class="content-wrapper" id="contentWrapper" style="display:block">');
      html = html.replace(/<article class="markdown-body" id="markdownBody"><\/article>/i, `<article class="markdown-body" id="markdownBody">${crawlBody}</article>`);

      const renderedBuf = Buffer.from(html, 'utf-8');
      const headers = indexHtmlHeaders({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=1800'
      }, nonce);
      return sendCompressed(req, res, 200, headers, renderedBuf);
    });
  }

  // ── Mode B: Crawler Sutra Document SSR ──────────────────────────────────
  if (filePath.includes('\0')) {
    res.writeHead(400, Object.assign({ 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
    return res.end('Invalid file parameter');
  }

  const fullPath = path.join(getMdRoot(), filePath);
  const resolved = path.resolve(fullPath);
  const relative = path.relative(getMdRoot(), resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    res.writeHead(403, Object.assign({ 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
    return res.end('Access denied');
  }

  try {
    if (!(await isRealPathWithinMdRoot(resolved))) {
      res.writeHead(403, Object.assign({ 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
      return res.end('Access denied');
    }

    const rawMarkdown = await fs.promises.readFile(resolved, 'utf-8');
    const fallbackName = path.basename(filePath, '.md');
    const { title, description } = extractMarkdownMetadata(rawMarkdown, fallbackName);

    // Render markdown to static HTML (strip frontmatter and pass lineOffset)
    const { body: crawlerBody, lineOffset: crawlerLineOffset } = stripFrontmatter(rawMarkdown);
    let bodyHtml = '';
    try {
      bodyHtml = await renderWithWorker(crawlerBody, filePath, crawlerLineOffset);
    } catch (_) {
      bodyHtml = marked.parse(crawlerBody);
    }

    const nonce = crypto.randomBytes(16).toString('base64');
    getIndexHtml(nonce, req, (err, baseHtmlBuffer) => {
      if (err) {
        res.writeHead(500, Object.assign({ 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
        return res.end('Server Error');
      }

      let html = baseHtmlBuffer.toString('utf-8');
      const canonicalUrl = `${baseUrl}/?file=${encodeURIComponent(filePath)}`;
      const pageTitle = `${escapeHtmlString(title)} — ${siteName}`;
      const safeDesc = escapeHtmlString(description);

      // 1. Replace Title & Description
      html = html.replace(/<title>.*?<\/title>/i, `<title>${pageTitle}</title>`);
      html = html.replace(/<meta name="description" content="[^"]*">/i, `<meta name="description" content="${safeDesc}">`);

      // 2. Replace Canonical & OpenGraph & Twitter tags
      html = html.replace(/<link rel="canonical"[^>]*>/i, `<link rel="canonical" href="${canonicalUrl}">`);
      html = html.replace(/<meta property="og:url"[^>]*>/i, `<meta property="og:url" content="${canonicalUrl}">`);
      html = html.replace(/<meta property="og:title"[^>]*>/i, `<meta property="og:title" content="${pageTitle}">`);
      html = html.replace(/<meta property="og:description"[^>]*>/i, `<meta property="og:description" content="${safeDesc}">`);
      html = html.replace(/<meta property="og:type"[^>]*>/i, `<meta property="og:type" content="article">`);
      html = html.replace(/<meta property="og:image" content="[^"]*">/i, `<meta property="og:image" content="${ogImageUrl}">`);
      html = html.replace(/<meta name="twitter:title"[^>]*>/i, `<meta name="twitter:title" content="${pageTitle}">`);
      html = html.replace(/<meta name="twitter:description"[^>]*>/i, `<meta name="twitter:description" content="${safeDesc}">`);
      html = html.replace(/<meta name="twitter:image" content="[^"]*">/i, `<meta name="twitter:image" content="${ogImageUrl}">`);

      // 3. Construct Breadcrumbs & Rich Article Schema.org JSON-LD
      const pathSegments = filePath.split('/').filter(Boolean);
      const breadcrumbItems = [
        {
          "@type": "ListItem",
          "position": 1,
          "name": config.settings.siteName || '首頁',
          "item": `${baseUrl}/`
        }
      ];
      for (let bi = 0; bi < pathSegments.length; bi++) {
        const seg = pathSegments[bi];
        const isLast = bi === pathSegments.length - 1;
        breadcrumbItems.push({
          "@type": "ListItem",
          "position": bi + 2,
          "name": isLast ? title : seg.replace(/\.md$/, ''),
          "item": isLast ? canonicalUrl : `${baseUrl}/?folder=${encodeURIComponent(pathSegments.slice(0, bi + 1).join('/'))}`
        });
      }

      const jsonLdGraph = {
        "@context": "https://schema.org",
        "@graph": [
          {
            "@type": "Article",
            "headline": title,
            "description": description,
            "image": ogImageUrl,
            "mainEntityOfPage": canonicalUrl,
            "inLanguage": "zh-TW",
            "publisher": {
              "@type": "Organization",
              "name": config.settings.siteName || 'mdWebview',
              "url": `${baseUrl}/`
            },
            "isPartOf": {
              "@type": "WebSite",
              "name": config.settings.siteName || 'mdWebview',
              "url": `${baseUrl}/`
            }
          },
          {
            "@type": "BreadcrumbList",
            "itemListElement": breadcrumbItems
          }
        ]
      };
      const jsonLdTag = `<script type="application/ld+json" nonce="${nonce}">${JSON.stringify(jsonLdGraph)}</script>`;
      html = html.replace('</head>', `  ${jsonLdTag}\n</head>`);

      // 4. Hide welcomeScreen and reveal contentWrapper with pre-rendered markdown
      html = html.replace(/<div class="welcome-screen" id="welcomeScreen">/i, '<div class="welcome-screen" id="welcomeScreen" style="display:none">');
      html = html.replace(/<div class="content-wrapper" id="contentWrapper" style="display:none">/i, '<div class="content-wrapper" id="contentWrapper" style="display:block">');
      html = html.replace(/<div class="content-header" id="contentHeader"><\/div>/i, `<div class="content-header" id="contentHeader"><h1 class="file-title">${escapeHtmlString(title)}</h1></div>`);
      html = html.replace(/<article class="markdown-body" id="markdownBody"><\/article>/i, `<article class="markdown-body" id="markdownBody">${bodyHtml}</article>`);

      const renderedBuf = Buffer.from(html, 'utf-8');
      const headers = indexHtmlHeaders({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=1800'
      }, nonce);
      sendCompressed(req, res, 200, headers, renderedBuf);
    });
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
      return res.end('File not found');
    }
    Logger.error('SSR', 'Crawler SSR rendering failed', err, req);
    res.writeHead(500, Object.assign({ 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
    res.end('Server Error');
  }
}

// ── §9 API: File & Media Servers ─────────────────────────────
/**
 * 傳回指定 Markdown 檔案的原始內容（GET /api/file?path=...）。
 * 包含路徑遍歷防護與 symlink 逃逸檢查；所有路徑均限制在 mdRoot 內。
 *
 * @param {http.IncomingMessage} req   - HTTP 請求物件
 * @param {http.ServerResponse}  res   - HTTP 回應物件
 * @param {Object}               query - 查詢參數，必須包含 `path`；可選 `line`（開啟時捲動至目標行）
 */
async function handleFile(req, res, query) {
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
    // Reject symlinks that escape the vault (realpath throws ENOENT → 404 below)
    if (!(await isRealPathWithinMdRoot(resolved))) {
      return sendJSON(res, 403, { error: 'Access denied' });
    }
    const raw = await fs.promises.readFile(resolved, 'utf-8');
    sendJSON(res, 200, { content: raw, path: filePath, line: line || null });
  } catch (err) {
    sendJSON(res, 404, { error: 'File not found: ' + filePath });
  }
}

// ── API: Media & Image File Server ───────────────────────────
/**
 * 提供 Markdown 文件引用的媒體檔案（圖片、PDF、音訊等，GET /api/media?path=...）。
 * 支援多層路徑解析策略：
 *   1. 相對於文件資料夾（query.doc 指定文件位置）
 *   2. 相對於 mdRoot 根目錄
 *   3. 全庫模糊搜尋（依 basename 比對）
 * 包含 MIME 類型推斷、ETag + Cache-Control、範圍請求（Range）支援。
 *
 * @param {http.IncomingMessage} req   - HTTP 請求物件（可含 Range 標頭）
 * @param {http.ServerResponse}  res   - HTTP 回應物件
 * @param {Object}               query - 查詢參數，必須包含 `path`；可選 `doc`（來源文件路徑）
 */
async function handleMedia(req, res, query) {
  let rawPath = query.path ? safeDecodeURIComponent(query.path).trim() : '';
  if (!rawPath) {
    res.writeHead(400, Object.assign({ 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
    return res.end('Missing path parameter');
  }

  // Normalize Windows path separators
  if (rawPath.includes('\\')) {
    rawPath = rawPath.replace(/\\/g, '/');
  }
  const baseName = path.basename(rawPath);
  const docPath = query.doc ? safeDecodeURIComponent(query.doc).trim() : '';
  const docFolder = docPath ? path.dirname(docPath) : '';

  const mdRoot = getMdRoot();
  let resolvedPath = null;

  // Candidate paths to check in order of priority (Climb from docFolder up to mdRoot)
  const candidates = [];

  let currFolder = docFolder;
  while (true) {
    if (currFolder && currFolder !== '.') {
      candidates.push(path.join(mdRoot, currFolder, rawPath));
      candidates.push(path.join(mdRoot, currFolder, baseName));
      candidates.push(path.join(mdRoot, currFolder, 'z-附件', baseName));
      candidates.push(path.join(mdRoot, currFolder, 'attachments', baseName));
      candidates.push(path.join(mdRoot, currFolder, 'media', baseName));
    } else {
      candidates.push(path.join(mdRoot, rawPath));
      candidates.push(path.join(mdRoot, baseName));
      candidates.push(path.join(mdRoot, 'z-附件', baseName));
      candidates.push(path.join(mdRoot, 'attachments', baseName));
      candidates.push(path.join(mdRoot, 'media', baseName));
    }
    if (!currFolder || currFolder === '.' || currFolder === '/' || currFolder === '') break;
    const parent = path.dirname(currFolder);
    if (parent === currFolder) break;
    currFolder = (parent === '.' || parent === '/') ? '' : parent;
  }

  for (const cand of candidates) {
    try {
      const stat = await fs.promises.stat(cand);
      if (stat.isFile()) {
        resolvedPath = cand;
        break;
      }
    } catch (_) {}
  }

  if (!resolvedPath) {
    res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
    return res.end('Media not found');
  }

  // Security check: ensure resolvedPath stays within mdRoot
  const relative = path.relative(mdRoot, resolvedPath);
  const isSafe = !relative.startsWith('..') && !path.isAbsolute(relative);
  if (!isSafe) {
    res.writeHead(403, Object.assign({ 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
    return res.end('Access denied');
  }

  // Symlink escape check: canonical target must stay within the vault
  if (!(await isRealPathWithinMdRoot(resolvedPath))) {
    res.writeHead(403, Object.assign({ 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
    return res.end('Access denied');
  }

  const ext = path.extname(resolvedPath).toLowerCase();
  const MIME_TYPES = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.bmp': 'image/bmp',
    '.pdf': 'application/pdf'
  };
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  try {
    const stat = await fs.promises.stat(resolvedPath);
    const etag = `W/"${stat.size}-${stat.mtimeMs}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, Object.assign({ 'ETag': etag, 'Cache-Control': 'public, max-age=86400' }, SECURITY_HEADERS));
      return res.end();
    }

    if (req.method === 'HEAD') {
      res.writeHead(200, Object.assign({
        'Content-Type': contentType,
        'Content-Length': stat.size,
        'ETag': etag,
        'Cache-Control': 'public, max-age=86400'
      }, SECURITY_HEADERS));
      return res.end();
    }

    const stream = fs.createReadStream(resolvedPath);
    const mediaHeaders = {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'ETag': etag,
      'Cache-Control': 'public, max-age=86400'
    };
    // Directly navigating to a vault .svg serves an executable same-origin document.
    // A restrictive CSP neutralizes any embedded script without affecting <img> use.
    if (ext === '.svg') {
      mediaHeaders['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'";
    }
    res.writeHead(200, Object.assign({}, SECURITY_HEADERS, mediaHeaders));

    stream.on('error', (streamErr) => {
      Logger.error('Media', `Error streaming media file "${resolvedPath}"`, streamErr, req);
      if (!res.headersSent) {
        res.writeHead(500, Object.assign({ 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
      }
      res.end();
      stream.destroy();
    });

    stream.pipe(res);
    // Destroy the source stream on early client disconnect to avoid fd/buffer leaks.
    const closeStream = () => stream.destroy();
    req.once('close', closeStream);
    res.once('close', closeStream);
  } catch (err) {
    res.writeHead(500, Object.assign({ 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
    res.end('Error serving media');
  }
}


/**
 * 渲染大型 Markdown 檔案的指定分塊（GET /api/render?path=...&chunk=N）。
 * 大型檔案（> 1MB）分為多個分塊以避免一次性渲染阻塞主線程。
 * 渲染工作透過 Worker Thread Pool 非同步執行；結果加入 LRU 記憶體快取。
 *
 * @param {http.IncomingMessage} req   - HTTP 請求物件
 * @param {http.ServerResponse}  res   - HTTP 回應物件
 * @param {Object}               query - 查詢參數：path（必要）、chunk（可選，預設 0）
 */
async function handleRender(req, res, query) {
  let filePath = query.path;
  if (!filePath || filePath.includes('\0')) {
    return sendJSON(res, 400, { error: 'Invalid path' });
  }

  // Normalize path segments (remove spaces around slashes)
  filePath = filePath.replace(/\\/g, '/').split('/').map(s => s.trim()).filter(Boolean).join('/');

  const { root, fsRel } = resolveRoot(filePath);
  let resolved = path.resolve(path.join(root, fsRel));

  // Fallback: if resolved file doesn't exist directly, try with .md extension
  if (!fs.existsSync(resolved) && !filePath.endsWith('.md')) {
    const mdCandidate = path.resolve(path.join(root, fsRel + '.md'));
    if (fs.existsSync(mdCandidate)) {
      resolved = mdCandidate;
      filePath = filePath + '.md';
    }
  }

  const relative = path.relative(root, resolved);
  const isSafe = !relative.startsWith('..') && !path.isAbsolute(relative);
  if (!isSafe) return sendJSON(res, 403, { error: 'Access denied' });

  try {
    const renderStart = Date.now();
    const stat = await fs.promises.stat(resolved);
    // Symlink escape check: canonical target must stay within its root
    if (!(await isRealPathWithinRoot(root, resolved))) {
      return sendJSON(res, 403, { error: 'Access denied' });
    }
    const etag = `W/"${stat.size}-${stat.mtimeMs}"`;
    if (req.headers['if-none-match'] === etag) {
      Logger.info('Render', `Loaded document (cached 304): "${filePath}" (${Date.now() - renderStart}ms)`, req, { path: filePath });
      res.writeHead(304, Object.assign({ 'ETag': etag, 'Cache-Control': 'no-cache' }, SECURITY_HEADERS));
      res.end();
      return;
    }

    let raw = await fs.promises.readFile(resolved, 'utf-8');

    // Strip frontmatter before rendering (O(1) fast scanning without regex string-duplication)
    const { body: renderedBody, frontmatter, lineOffset } = stripFrontmatter(raw);

    const abortCtrl = new AbortController();
    req.on('close', () => {
      try { abortCtrl.abort(); } catch (_) {}
    });

    // Offload CPU-bound rendering to worker thread pool
    const html = await renderWithWorker(renderedBody, filePath, lineOffset, abortCtrl.signal);
    Logger.info('Render', `Loaded document: "${filePath}" (${Date.now() - renderStart}ms)`, req, { path: filePath });

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
    if (err.message === 'Render cancelled by client' || req.destroyed) return;
    if (err.code === 'ENOENT') {
      return sendJSON(res, 404, { error: 'File not found: ' + filePath });
    }
    if (err.statusCode === 503 || err.code === 'QUEUE_FULL') {
      return sendJSON(res, 503, { error: 'Render queue is full' });
    }
    Logger.error('Render', `Error rendering file ${filePath}: ${err.message}`, err);
    sendJSON(res, 500, { error: 'Internal Server Error' });
  }
}

// ── §10 API: Large-File Chunked Rendering ─────────────────────────────────
// Multi-root path resolution. Dictionary files live outside the vault in
// config.settings.dictionaryPath and are addressed with a `dict:` prefix that rides
// through the client's opaque path string. `fsRel` is joined against the root on
// disk; `relPath` keeps the `dict:` prefix so cache keys / response `file` never
// collide with same-named vault files.
function resolveRoot(filePath) {
  const p = String(filePath || '');
  if (p.startsWith('dict:')) {
    return { root: config.settings.dictionaryPath, fsRel: p.slice(5), relPath: p };
  }
  return { root: getMdRoot(), fsRel: p, relPath: p };
}

// Normalizes + resolves a markdown path with the same traversal guard as handleRender.
function resolveMdPath(filePath) {
  let p = String(filePath || '').replace(/\\/g, '/').split('/').map(s => s.trim()).filter(Boolean).join('/');
  if (!p || p.includes('\0')) return null;
  const { root, fsRel, relPath } = resolveRoot(p);
  let resolved = path.resolve(path.join(root, fsRel));
  let outFsRel = fsRel;
  let outRelPath = relPath;
  if (!fs.existsSync(resolved) && !fsRel.endsWith('.md')) {
    const candidate = path.resolve(path.join(root, fsRel + '.md'));
    if (fs.existsSync(candidate)) { resolved = candidate; outFsRel = fsRel + '.md'; outRelPath = relPath + '.md'; }
  }
  const relative = path.relative(root, resolved);
  const isSafe = !relative.startsWith('..') && !path.isAbsolute(relative);
  if (!isSafe) return null;
  return { resolved, relPath: outRelPath, root };
}

/**
 * 傳回大型 Markdown 檔案的 Section Index（GET /api/section-index?path=...）。
 * 若檔案小於 LARGE_FILE_MIN_BYTES（1MB），回傳 `{ large: false }`，前端以普通模式渲染。
 * 若超過閾值，回傳 Section Index 供前端進行虛擬化分塊渲染。
 * Section Index 由 Worker Thread Pool 建立並快取於記憶體與磁碟（.bin）。
 *
 * @param {http.IncomingMessage} req   - HTTP 請求物件
 * @param {http.ServerResponse}  res   - HTTP 回應物件
 * @param {Object}               query - 查詢參數，必須包含 `path`
 */
async function handleSectionIndex(req, res, query) {
  const r = resolveMdPath(query.path);
  if (!r) return sendJSON(res, 404, { error: 'File not found' });

  try {
    const stat = await fs.promises.stat(r.resolved);
    // Symlink escape check: canonical target must stay within the vault
    if (!(await isRealPathWithinRoot(r.root, r.resolved))) {
      return sendJSON(res, 403, { error: 'Access denied' });
    }
    if (stat.size < LARGE_FILE_MIN_BYTES) {
      return sendJSON(res, 200, { large: false });
    }
    const idx = await getSectionIndex(r.resolved, stat, r.relPath);
    if (!idx || idx.entries.length === 0) {
      return sendJSON(res, 200, { large: false });
    }

    const etag = `W/"${stat.size}-${stat.mtimeMs}"`;
    if (req.headers['if-none-match'] === etag) {
      Logger.info('Render', `Loaded document (virtualized 304): "${r.relPath}"`, req, { path: r.relPath });
      res.writeHead(304, Object.assign({ 'ETag': etag, 'Cache-Control': 'no-cache' }, SECURITY_HEADERS));
      res.end();
      return;
    }

    // Trimmed client payload: only what the frontend needs for TOC + navigation.
    const entries = idx.entries.map(e => ({
      h: e.headword,
      ls: e.lineStart,
      le: e.lineEnd,
      level: e.level || (e.groupIdx > 0 ? e.groupIdx : 1)
    }));
    const groups = (idx.groups || []).map(g => ({ h: g.headword, first: g.firstEntry, last: g.lastEntry }));
    // Precomputed chunk boundaries (byte-bounded), so the client requests exactly
    // the ranges the chunk renderer will produce — no off-by-whole-chunk drift.
    const chunks = computeChunkRanges(idx);

    // Count a large-file open as a "view" so virtualized reads are visible to
    // analytics. `/api/section-index` is fetched once per open (mirroring the
    // Render log in handleRender); we log on the fresh-200 path only, matching
    // handleRender's skip on 304. Never log here per-chunk — that would inflate
    // views by the number of scrolled chunks.
    Logger.info('Render', `Loaded document (virtualized): "${r.relPath}"`, req, { path: r.relPath });

    res.setHeader('ETag', etag);
    sendJSON(res, 200, {
      large: true,
      file: idx.relPath,
      entryLevel: idx.entryLevel,
      preambleLineCount: idx.preambleLineCount,
      totalLines: idx.totalLines,
      entries,
      groups,
      chunks,
    });
  } catch (err) {
    sendJSON(res, 404, { error: 'File not found: ' + query.path });
  }
}

// ── API: Chunked Render (renders a slice of a large file) ─────────────────
const CHUNK_ENTRIES = 100;     // default max entries per chunk
const CHUNK_MAX_BYTES = 262144; // 256KB safety cap per render job

// Deterministic tiling of a large file's entries into byte-bounded chunks.
// Mirrors handleRenderChunk's from/to clamping exactly, so the client can
// request chunks by their precomputed [from, to] boundaries.
function computeChunkRanges(idx) {
  const total = idx.entries.length;
  const ranges = [];
  let from = 0;
  while (from < total) {
    let to = Math.min(from + CHUNK_ENTRIES - 1, total - 1);
    let start = (from === 0) ? 0 : idx.entries[from].offset;
    let end = idx.entries[to].offset + idx.entries[to].len;
    while (to > from && (end - start) > CHUNK_MAX_BYTES) {
      to--;
      end = idx.entries[to].offset + idx.entries[to].len;
    }
    ranges.push({
      from,
      to,
      lineStart: (from === 0) ? 1 : idx.entries[from].lineStart,
    });
    from = to + 1;
  }
  return ranges;
}

async function handleRenderChunk(req, res, query) {
  const r = resolveMdPath(query.path);
  if (!r) return sendJSON(res, 404, { error: 'File not found' });

  let from = parseInt(query.from, 10);
  let to = parseInt(query.to, 10);
  if (Number.isNaN(from) || Number.isNaN(to) || from < 0 || to < from) {
    return sendJSON(res, 400, { error: 'Invalid from/to range' });
  }

  try {
    const stat = await fs.promises.stat(r.resolved);
    // Symlink escape check: canonical target must stay within the vault
    if (!(await isRealPathWithinRoot(r.root, r.resolved))) {
      return sendJSON(res, 403, { error: 'Access denied' });
    }
    if (stat.size < LARGE_FILE_MIN_BYTES) {
      return handleRender(req, res, query); // small file: full render
    }
    const idx = await getSectionIndex(r.resolved, stat, r.relPath);
    if (!idx || idx.entries.length === 0) {
      return handleRender(req, res, query);
    }

    const total = idx.entries.length;
    from = Math.max(0, Math.min(from, total - 1));
    to = Math.max(from, Math.min(to, total - 1));
    if (to - from + 1 > CHUNK_ENTRIES) to = from + CHUNK_ENTRIES - 1;

    let start = (from === 0) ? 0 : idx.entries[from].offset;
    let end = idx.entries[to].offset + idx.entries[to].len;
    while (to > from && (end - start) > CHUNK_MAX_BYTES) {
      to--;
      end = idx.entries[to].offset + idx.entries[to].len;
    }

    const lineOffset = (from === 0) ? 0 : (idx.entries[from].lineStart - 1);
    const byteLen = end - start;

    const fh = await fs.promises.open(r.resolved, 'r');
    let body;
    try {
      const buf = Buffer.alloc(byteLen);
      await fh.read(buf, 0, byteLen, start);
      body = buf.toString('utf-8');
    } finally {
      await fh.close();
    }

    const abortCtrl = new AbortController();
    req.on('close', () => {
      try { abortCtrl.abort(); } catch (_) {}
    });

    const html = await renderWithWorker(body, r.relPath, lineOffset, abortCtrl.signal);

    const metaHeader = Buffer.from(JSON.stringify({
      from,
      to,
      lineStart: (from === 0) ? 1 : idx.entries[from].lineStart,
      totalEntries: total,
    }), 'utf-8').toString('base64');

    const etag = `W/"${stat.size}-${stat.mtimeMs}-${from}-${to}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, Object.assign({ 'ETag': etag, 'Cache-Control': 'no-cache' }, SECURITY_HEADERS));
      res.end();
      return;
    }

    const responseHeaders = Object.assign({
      'Content-Type': 'text/html; charset=utf-8',
      'ETag': etag,
      'Cache-Control': 'no-cache',
      'X-Chunk-Meta': metaHeader,
    }, SECURITY_HEADERS);

    const acceptEncoding = req.headers['accept-encoding'] || '';
    if (acceptEncoding.includes('gzip')) {
      zlib.gzip(Buffer.from(html, 'utf-8'), { level: zlib.constants.Z_BEST_SPEED }, (err, compressed) => {
        if (err) {
          res.writeHead(200, responseHeaders);
          res.end(html);
          return;
        }
        res.writeHead(200, Object.assign(responseHeaders, { 'Content-Encoding': 'gzip', 'Content-Length': compressed.length }));
        res.end(compressed);
      });
    } else {
      res.writeHead(200, responseHeaders);
      res.end(html);
    }
  } catch (err) {
    if (err.message === 'Render cancelled by client' || req.destroyed) return;
    if (err.code === 'ENOENT') {
      return sendJSON(res, 404, { error: 'File not found: ' + (query && query.path) });
    }
    if (err.statusCode === 503 || err.code === 'QUEUE_FULL') {
      return sendJSON(res, 503, { error: 'Render queue is full' });
    }
    Logger.error('Render', `Error rendering chunk for ${query && query.path}: ${err.message}`, err);
    sendJSON(res, 500, { error: 'Internal Server Error' });
  }
}

// ── §14 Search Handlers (Full-Text, Filename, In-Page) ───────
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
          name: node.name + '.md',
          size: node.size || 0
        });
      }
    }
  }
  walk(nodes);
  return files;
}

// ── §12 Full-Text Bigram Search Engine ───────────────────────────
const SEARCH_INDEX_CACHE_FILE = path.join(LOG_DIR, 'search-index-cache.json');
const SEARCH_INDEX_CACHE_BIN = path.join(LOG_DIR, 'search-index-cache.bin');

let searchIndex = {
  ready: false,
  building: false,
  vaultSig: null,
  createdAt: null,
  fileList: [],         // [{ id, relPath, name, fullPath }]
  fileMap: new Map(),   // relPath -> fileId
  units: [],            // unitId -> { fileId, entryIndex(-1=whole file), headword, byteOffset, byteLength, lineStart }
  bigrams: new Map(),   // bigram (e.g. "成無") -> number or Uint16Array/Uint32Array of unitId
};

// ── §11 Document Section Index Engine ─────────────────────────
const LARGE_FILE_MIN_BYTES = 1024 * 1024; // files >= 1MB get a section index
const SECTION_INDEX_CACHE_BIN = path.join(LOG_DIR, 'section-index-cache.bin');
const DICT_SECTION_INDEX_CACHE_BIN = path.join(LOG_DIR, 'dict-section-index-cache.bin');
const SECTION_INDEX_MAGIC = 0x53455832; // "SEX2"
const SECTION_INDEX_MAX_CACHE = 20;

const sectionIndexCache = new Map();    // relPath -> section index object (LRU, insertion order)
const dictSectionIndexCache = new Map(); // dict: relPath -> section index (unbounded; only a few dict files)
const sectionIndexPromises = new Map(); // relPath -> Promise (dedupe concurrent builds)
let sectionIndexBinLoaded = false;
let dictSectionIndexBinLoaded = false;
let sectionJobSeq = 0;

function setSectionIndex(relPath, idx) {
  if (sectionIndexCache.has(relPath)) sectionIndexCache.delete(relPath);
  sectionIndexCache.set(relPath, idx);
  while (sectionIndexCache.size > SECTION_INDEX_MAX_CACHE) {
    const oldest = sectionIndexCache.keys().next().value;
    sectionIndexCache.delete(oldest);
  }
}

function invalidateSectionIndexes() {
  sectionIndexCache.clear();
  sectionIndexBinLoaded = false;
}

function invalidateDictSectionIndexes() {
  dictSectionIndexCache.clear();
  dictSectionIndexBinLoaded = false;
  invalidateDailyWordCache();
}

/**
 * Builds a section index for one file in a transient worker_thread.
 * Section scanning is IO-bound, so files are parallelized across workers by the
 * caller (one worker per file), never within a single file.
 */
/**
 * Builds a section index for one file using the persistent IndexWorkerPool.
 * Section scanning is offloaded to the pool, avoiding per-file OS thread spawning.
 */
function buildSectionIndex(relPath, fullPath) {
  return executeIndexJob("section", { fullPath });
}

/**
 * 取得指定檔案的 Section Index（三層快取策略）：
 *   1. 記憶體快取（LRU，依 size + mtime 驗證有效性）
 *   2. 磁碟二進位快取（.bin 檔案，啟動時批量載入）
 *   3. 以 Worker Thread 即時掃描建立（最慢路徑）
 *
 * 辭典檔案使用獨立的無邊界快取（dictSectionIndexCache），
 * 避免其大型索引被保管庫的 20 條目 LRU 淘汰。
 *
 * @param {string}         fullPath - 檔案的絕對路徑
 * @param {fs.Stats}       stat     - 檔案的 stat 物件（用於 size/mtime 快取驗證）
 * @param {string}         relPath  - 相對路徑（辭典檔案以 'dict:' 前綴標識）
 * @returns {Promise<Object>}        Section Index 物件，包含 entries、groups 等欄位
 */
async function getSectionIndex(fullPath, stat, relPath) {
  // Dictionary files use a separate, unbounded cache + dedicated bin so their
  // (large) section indexes are never evicted by the vault's 20-entry LRU.
  const isDict = relPath.startsWith('dict:');
  const cache = isDict ? dictSectionIndexCache : sectionIndexCache;

  // 1. In-memory (validate against current size/mtime)
  const cached = cache.get(relPath);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    if (!isDict) setSectionIndex(relPath, cached); // refresh LRU order
    return cached;
  }

  // 2. Binary disk cache (load all once; small — only large files are indexed)
  const binPath = isDict ? DICT_SECTION_INDEX_CACHE_BIN : SECTION_INDEX_CACHE_BIN;
  const binLoaded = isDict ? dictSectionIndexBinLoaded : sectionIndexBinLoaded;
  if (!binLoaded) {
    try {
      const all = await loadAllSectionIndexesFromBinAsync(binPath);
      for (const idx of all) {
        if (isDict) dictSectionIndexCache.set(idx.relPath, idx);
        else setSectionIndex(idx.relPath, idx);
      }
      if (isDict) dictSectionIndexBinLoaded = true;
      else sectionIndexBinLoaded = true;
    } catch (_) {}
    const binHit = cache.get(relPath);
    if (binHit && binHit.size === stat.size && binHit.mtimeMs === stat.mtimeMs) return binHit;
  }

  // 3. Build (dedupe concurrent builds for the same file)
  const existing = sectionIndexPromises.get(relPath);
  if (existing) return existing;

  const promise = (async () => {
    const result = await buildSectionIndex(relPath, fullPath);
    const idx = {
      relPath,
      fullPath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      entryLevel: result.entryLevel,
      preambleLineCount: result.preambleLineCount,
      totalLines: result.totalLines,
      totalBytes: result.totalBytes,
      entries: result.entries,
      groups: result.groups,
    };
    if (isDict) dictSectionIndexCache.set(relPath, idx);
    else setSectionIndex(relPath, idx);
    sectionIndexPromises.delete(relPath);

    // Persist to disk asynchronously in the background
    if (isDict) saveDictSectionIndexBinAsync();
    else saveSectionIndexBinAsync();

    return idx;
  })().catch((err) => {
    sectionIndexPromises.delete(relPath);
    throw err;
  });

  sectionIndexPromises.set(relPath, promise);
  return promise;
}

/**
 * Aggregate binary format (one file, one section each):
 *   magic u32 | fileCount u32 | per-file records...
 * Per-file record:
 *   relPathLen u16 + relPath | size u32 | mtimeMs f64 | entryLevel u8 |
 *   preambleLineCount u32 | totalLines u32 | totalBytes u32 |
 *   entryCount u32 | groupCount u32 |
 *   entries: [ headwordLen u16 + headword | offset u32 | len u32 | lineStart u32 | lineEnd u32 | groupIdx i16 ]
 *   groups:  [ headwordLen u16 + headword | level u8 | firstEntry u32 | lastEntry u32 ]
 */
async function loadAllSectionIndexesFromBinAsync(binPath = SECTION_INDEX_CACHE_BIN) {
  const result = [];
  if (!fs.existsSync(binPath)) return result;
  const buf = await fs.promises.readFile(binPath);
  if (buf.length < 8) return result;
  let pos = 0;
  if (buf.readUInt32BE(pos) !== SECTION_INDEX_MAGIC) return result;
  pos += 4;
  const fileCount = buf.readUInt32BE(pos); pos += 4;
  if (fileCount > 50000 || pos + fileCount * 35 > buf.length) return result;

  for (let f = 0; f < fileCount; f++) {
    if (pos + 2 > buf.length) break;
    const relLen = buf.readUInt16BE(pos); pos += 2;
    if (pos + relLen + 33 > buf.length) break;
    const relPath = buf.toString('utf-8', pos, pos + relLen); pos += relLen;
    const size = buf.readUInt32BE(pos); pos += 4;
    const mtimeMs = buf.readDoubleBE(pos); pos += 8;
    const entryLevel = buf.readUInt8(pos); pos += 1;
    const preambleLineCount = buf.readUInt32BE(pos); pos += 4;
    const totalLines = buf.readUInt32BE(pos); pos += 4;
    const totalBytes = buf.readUInt32BE(pos); pos += 4;
    const entryCount = buf.readUInt32BE(pos); pos += 4;
    const groupCount = buf.readUInt32BE(pos); pos += 4;

    if (entryCount > 1000000 || pos + entryCount * 20 > buf.length) break;
    const entries = new Array(entryCount);
    let entryOk = true;
    for (let i = 0; i < entryCount; i++) {
      if (pos + 2 > buf.length) { entryOk = false; break; }
      const hLen = buf.readUInt16BE(pos); pos += 2;
      if (pos + hLen + 18 > buf.length) { entryOk = false; break; }
      const headword = buf.toString('utf-8', pos, pos + hLen); pos += hLen;
      const offset = buf.readUInt32BE(pos); pos += 4;
      const len = buf.readUInt32BE(pos); pos += 4;
      const lineStart = buf.readUInt32BE(pos); pos += 4;
      const lineEnd = buf.readUInt32BE(pos); pos += 4;
      const groupIdx = buf.readInt16BE(pos); pos += 2;
      const level = (groupIdx >= 1 && groupIdx <= 6) ? groupIdx : 1;
      entries[i] = { headword, offset, len, lineStart, lineEnd, groupIdx, level };
    }
    if (!entryOk) break;

    if (groupCount > 500000 || pos + groupCount * 11 > buf.length) break;
    const groups = new Array(groupCount);
    let groupOk = true;
    for (let i = 0; i < groupCount; i++) {
      if (pos + 2 > buf.length) { groupOk = false; break; }
      const hLen = buf.readUInt16BE(pos); pos += 2;
      if (pos + hLen + 9 > buf.length) { groupOk = false; break; }
      const headword = buf.toString('utf-8', pos, pos + hLen); pos += hLen;
      const level = buf.readUInt8(pos); pos += 1;
      const firstEntry = buf.readUInt32BE(pos); pos += 4;
      const lastEntry = buf.readUInt32BE(pos); pos += 4;
      groups[i] = { headword, level, firstEntry, lastEntry };
    }
    if (!groupOk) break;

    result.push({ relPath, size, mtimeMs, entryLevel, preambleLineCount, totalLines, totalBytes, entries, groups });
  }
  return result;
}

// Serializes section-index disk saves. Building several large-file indexes in
// quick succession triggers concurrent saves, and each writer reuses the same
// `.tmp` path — one writer's `rename` consumes it, leaving the other's rename
// failing with ENOENT. Chaining them makes writes strictly sequential.
let sectionIndexSaveChain = Promise.resolve();

async function saveSectionIndexBinAsync() {
  sectionIndexSaveChain = sectionIndexSaveChain.then(() => doSaveSectionIndexBin(sectionIndexCache, SECTION_INDEX_CACHE_BIN, 'section-index'));
  return sectionIndexSaveChain;
}

async function saveDictSectionIndexBinAsync() {
  sectionIndexSaveChain = sectionIndexSaveChain.then(() => doSaveSectionIndexBin(dictSectionIndexCache, DICT_SECTION_INDEX_CACHE_BIN, 'dict-section-index'));
  return sectionIndexSaveChain;
}

async function doSaveSectionIndexBin(cache, binPath, label) {
  try {
    const saveStart = Date.now();
    const files = Array.from(cache.values());
    if (files.length === 0) return;

    fs.mkdirSync(LOG_DIR, { recursive: true });

    let totalBytes = 4 + 4; // magic + fileCount
    for (const idx of files) {
      totalBytes += 2 + Buffer.byteLength(idx.relPath) + 4 + 8 + 1 + 4 + 4 + 4 + 4 + 4;
      for (const e of idx.entries) totalBytes += 2 + Buffer.byteLength(e.headword) + 4 + 4 + 4 + 4 + 2;
      for (const g of idx.groups) totalBytes += 2 + Buffer.byteLength(g.headword) + 1 + 4 + 4;
    }

    const buf = Buffer.allocUnsafe(totalBytes);
    let pos = 0;
    buf.writeUInt32BE(SECTION_INDEX_MAGIC, pos); pos += 4;
    buf.writeUInt32BE(files.length, pos); pos += 4;

    for (const idx of files) {
      const relB = Buffer.from(idx.relPath);
      buf.writeUInt16BE(relB.length, pos); pos += 2;
      relB.copy(buf, pos); pos += relB.length;
      buf.writeUInt32BE(idx.size, pos); pos += 4;
      buf.writeDoubleBE(idx.mtimeMs, pos); pos += 8;
      buf.writeUInt8(idx.entryLevel, pos); pos += 1;
      buf.writeUInt32BE(idx.preambleLineCount, pos); pos += 4;
      buf.writeUInt32BE(idx.totalLines, pos); pos += 4;
      buf.writeUInt32BE(idx.totalBytes, pos); pos += 4;
      buf.writeUInt32BE(idx.entries.length, pos); pos += 4;
      buf.writeUInt32BE(idx.groups.length, pos); pos += 4;

      for (const e of idx.entries) {
        const hB = Buffer.from(e.headword);
        buf.writeUInt16BE(hB.length, pos); pos += 2;
        hB.copy(buf, pos); pos += hB.length;
        buf.writeUInt32BE(e.offset, pos); pos += 4;
        buf.writeUInt32BE(e.len, pos); pos += 4;
        buf.writeUInt32BE(e.lineStart, pos); pos += 4;
        buf.writeUInt32BE(e.lineEnd, pos); pos += 4;
        const gIdx = e.level || e.groupIdx || 1;
        buf.writeInt16BE(gIdx, pos); pos += 2;
      }
      for (const g of idx.groups) {
        const hB = Buffer.from(g.headword);
        buf.writeUInt16BE(hB.length, pos); pos += 2;
        hB.copy(buf, pos); pos += hB.length;
        buf.writeUInt8(g.level, pos); pos += 1;
        buf.writeUInt32BE(g.firstEntry, pos); pos += 4;
        buf.writeUInt32BE(g.lastEntry, pos); pos += 4;
      }
    }

    const tmpFile = binPath + '.tmp';
    await fs.promises.writeFile(tmpFile, buf);
    try {
      await fs.promises.rename(tmpFile, binPath);
    } catch (err) {
      // Defense-in-depth: if the target already exists (e.g. a stray concurrent
      // save), the cache is effectively committed — ignore the ENOENT rather than
      // logging a spurious error. Any other error is real and rethrown.
      if (err.code === 'ENOENT' && fs.existsSync(binPath)) {
        // no-op: another writer already committed an equivalent file
      } else {
        throw err;
      }
    }
    Logger.info('Index', `Saved ${label} cache (${(buf.length / 1024 / 1024).toFixed(2)} MB, ${files.length} file(s)) in ${Date.now() - saveStart}ms`);
  } catch (err) {
    Logger.error('Index', `Failed to save ${label} cache`, err);
  }
}

/**
 * Computes a quick fingerprint of all files in vault based on path, size, and mtime
 */
function computeVaultSignature(files) {
  const sortedPaths = files.map(f => f.relPath).sort();
  const hash = crypto.createHash('md5');
  hash.update(`count:${sortedPaths.length}\n`);
  for (let i = 0; i < sortedPaths.length; i++) {
    hash.update(sortedPaths[i] + '\n');
  }
  return hash.digest('hex');
}

/**
 * Loads Bigram Index from binary disk cache (.bin) for ultra-fast startup and minimal RAM allocation
 */
async function loadSearchIndexFromBinCacheAsync(expectedVaultSig) {
  try {
    if (!fs.existsSync(SEARCH_INDEX_CACHE_BIN)) return false;
    Logger.info('Index', 'Loading Bigram Index from disk cache...');
    const loadStart = Date.now();
    const binBuf = await fs.promises.readFile(SEARCH_INDEX_CACHE_BIN);
    if (binBuf.length < 10) return false;

    let readPos = 0;
    const magic = binBuf.readUInt32BE(readPos); readPos += 4;
    // v4: punctuation/whitespace-transparent bigrams (loose search mode)
    if (magic !== 0x42475835 && magic !== 0x42475836) return false;
    const isUint16Format = (magic === 0x42475835);

    const sigLen = binBuf.readUInt16BE(readPos); readPos += 2;
    const vaultSig = binBuf.toString('utf-8', readPos, readPos + sigLen); readPos += sigLen;

    if (vaultSig !== expectedVaultSig) {
      Logger.info('Index', `Disk cache signature mismatch (Expected: ${expectedVaultSig.substring(0, 8)}, Cached: ${vaultSig.substring(0, 8)}), rebuilding...`);
      return false;
    }

    const fileCount = binBuf.readUInt32BE(readPos); readPos += 4;
    const unitCount = binBuf.readUInt32BE(readPos); readPos += 4;
    const bigramCount = binBuf.readUInt32BE(readPos); readPos += 4;

    if (fileCount > 500000 || readPos + fileCount * 10 > binBuf.length) return false;
    if (unitCount > 5000000 || readPos + unitCount * 22 > binBuf.length) return false;
    if (bigramCount > 5000000 || readPos + bigramCount * 5 > binBuf.length) return false;

    const fileList = new Array(fileCount);
    const fileMap = new Map();
    for (let i = 0; i < fileCount; i++) {
      if (readPos + 4 > binBuf.length) return false;
      const id = binBuf.readUInt32BE(readPos); readPos += 4;

      if (readPos + 2 > binBuf.length) return false;
      const relLen = binBuf.readUInt16BE(readPos); readPos += 2;
      if (readPos + relLen > binBuf.length) return false;
      const relPath = binBuf.toString('utf-8', readPos, readPos + relLen); readPos += relLen;

      if (readPos + 2 > binBuf.length) return false;
      const nameLen = binBuf.readUInt16BE(readPos); readPos += 2;
      if (readPos + nameLen > binBuf.length) return false;
      const name = binBuf.toString('utf-8', readPos, readPos + nameLen); readPos += nameLen;

      if (readPos + 2 > binBuf.length) return false;
      const fullLen = binBuf.readUInt16BE(readPos); readPos += 2;
      if (readPos + fullLen > binBuf.length) return false;
      const fullPath = binBuf.toString('utf-8', readPos, readPos + fullLen); readPos += fullLen;

      const fileObj = { id, relPath, name, fullPath };
      fileList[i] = fileObj;
      fileMap.set(relPath, id);
    }

    const units = new Array(unitCount);
    for (let i = 0; i < unitCount; i++) {
      if (readPos + 12 > binBuf.length) return false;
      const unitId = binBuf.readUInt32BE(readPos); readPos += 4;
      const fileId = binBuf.readUInt32BE(readPos); readPos += 4;
      const entryIndex = binBuf.readInt32BE(readPos); readPos += 4;

      if (readPos + 2 > binBuf.length) return false;
      const headwordLen = binBuf.readUInt16BE(readPos); readPos += 2;
      if (readPos + headwordLen > binBuf.length) return false;
      const headword = binBuf.toString('utf-8', readPos, readPos + headwordLen); readPos += headwordLen;

      if (readPos + 12 > binBuf.length) return false;
      const byteOffset = binBuf.readUInt32BE(readPos); readPos += 4;
      const byteLength = binBuf.readUInt32BE(readPos); readPos += 4;
      const lineStart = binBuf.readUInt32BE(readPos); readPos += 4;

      units[unitId] = { unitId, fileId, entryIndex, headword, byteOffset, byteLength, lineStart };
    }

    const bigrams = new Map();
    const itemBytes = isUint16Format ? 2 : 4;
    for (let i = 0; i < bigramCount; i++) {
      if (readPos + 1 > binBuf.length) return false;
      const bgLen = binBuf.readUInt8(readPos); readPos += 1;
      if (readPos + bgLen + 4 > binBuf.length) return false;
      const bgStr = binBuf.toString('utf-8', readPos, readPos + bgLen); readPos += bgLen;
      const count = binBuf.readUInt32BE(readPos); readPos += 4;

      if (count === 1) {
        if (readPos + itemBytes > binBuf.length) return false;
        const singleId = isUint16Format ? binBuf.readUInt16BE(readPos) : binBuf.readUInt32BE(readPos);
        readPos += itemBytes;
        bigrams.set(bgStr, singleId);
      } else {
        if (readPos + count * itemBytes > binBuf.length) return false;
        const arr = isUint16Format ? new Uint16Array(count) : new Uint32Array(count);
        if (isUint16Format) {
          for (let j = 0; j < count; j++) {
            arr[j] = binBuf.readUInt16BE(readPos); readPos += 2;
          }
        } else {
          for (let j = 0; j < count; j++) {
            arr[j] = binBuf.readUInt32BE(readPos); readPos += 4;
          }
        }
        bigrams.set(bgStr, arr);
      }
    }

    let createdAt = null;
    try {
      const stat = await fs.promises.stat(SEARCH_INDEX_CACHE_BIN);
      createdAt = stat.mtime ? stat.mtime.toISOString() : null;
    } catch (_) {}

    searchIndex = {
      ready: true,
      building: false,
      vaultSig: expectedVaultSig,
      createdAt,
      fileList,
      fileMap,
      units,
      bigrams
    };

    const loadRssGb = (process.memoryUsage().rss / (1024 * 1024 * 1024)).toFixed(2);
    Logger.info('Index', `Loaded Bigram Index from disk cache: ${fileCount} files, ${unitCount} units, ${bigrams.size} bigrams (RSS: ${loadRssGb} GB) in ${Date.now() - loadStart}ms`);
    if (global.gc) global.gc();
    return true;
  } catch (err) {
    Logger.error('Index', 'Failed to read binary search index cache', err);
    return false;
  }
}

class ChunkedBinaryWriter {
  constructor(filePath, chunkSize = 1024 * 1024) {
    this.filePath = filePath;
    this.chunkSize = chunkSize;
    this.buffer = Buffer.allocUnsafe(chunkSize);
    this.offset = 0;
    this.stream = fs.createWriteStream(filePath, { highWaterMark: chunkSize });
    this.totalBytes = 0;
    this.error = null;
    this.stream.on('error', (err) => { this.error = err; });
  }

  async _flush() {
    if (this.offset === 0) return;
    if (this.error) throw this.error;
    const slice = Buffer.from(this.buffer.subarray(0, this.offset));
    this.offset = 0;
    if (!this.stream.write(slice)) {
      await new Promise((resolve, reject) => {
        const onDrain = () => { cleanup(); resolve(); };
        const onError = (err) => { cleanup(); reject(err); };
        const cleanup = () => {
          this.stream.removeListener('drain', onDrain);
          this.stream.removeListener('error', onError);
        };
        this.stream.on('drain', onDrain);
        this.stream.on('error', onError);
      });
    }
  }

  async writeUInt8(val) {
    if (this.offset + 1 > this.chunkSize) await this._flush();
    this.buffer.writeUInt8(val, this.offset);
    this.offset += 1;
    this.totalBytes += 1;
  }

  async writeUInt16BE(val) {
    if (this.offset + 2 > this.chunkSize) await this._flush();
    this.buffer.writeUInt16BE(val, this.offset);
    this.offset += 2;
    this.totalBytes += 2;
  }

  async writeInt32BE(val) {
    if (this.offset + 4 > this.chunkSize) await this._flush();
    this.buffer.writeInt32BE(val, this.offset);
    this.offset += 4;
    this.totalBytes += 4;
  }

  async writeUInt32BE(val) {
    if (this.offset + 4 > this.chunkSize) await this._flush();
    this.buffer.writeUInt32BE(val, this.offset);
    this.offset += 4;
    this.totalBytes += 4;
  }

  async writeBuffer(buf) {
    let bufOffset = 0;
    while (bufOffset < buf.length) {
      const available = this.chunkSize - this.offset;
      if (available === 0) {
        await this._flush();
        continue;
      }
      const toCopy = Math.min(available, buf.length - bufOffset);
      buf.copy(this.buffer, this.offset, bufOffset, bufOffset + toCopy);
      this.offset += toCopy;
      bufOffset += toCopy;
      this.totalBytes += toCopy;
    }
  }

  async close() {
    await this._flush();
    if (this.error) throw this.error;
    await new Promise((resolve, reject) => {
      this.stream.end((err) => {
        if (err || this.error) reject(err || this.error);
        else resolve();
      });
    });
  }
}

/**
 * Saves Bigram index as compact binary cache file (.bin) atomically (Crash-Safe)
 */
async function saveSearchIndexBinCacheAsync(vaultSig, fileList, units, bigrams) {
  const tmpCacheFile = SEARCH_INDEX_CACHE_BIN + '.tmp';
  try {
    const saveStart = Date.now();
    const useUint16 = units.length < 65536;
    // v4: punctuation/whitespace-transparent bigrams (loose search mode)
    const magic = useUint16 ? 0x42475835 : 0x42475836;

    const writer = new ChunkedBinaryWriter(tmpCacheFile, 1024 * 1024);

    await writer.writeUInt32BE(magic);
    const sigBuf = Buffer.from(vaultSig || '');
    await writer.writeUInt16BE(sigBuf.length);
    await writer.writeBuffer(sigBuf);

    await writer.writeUInt32BE(fileList.length);
    await writer.writeUInt32BE(units.length);
    await writer.writeUInt32BE(bigrams.size);

    for (const f of fileList) {
      await writer.writeUInt32BE(f.id);

      const relB = Buffer.from(f.relPath);
      await writer.writeUInt16BE(relB.length);
      await writer.writeBuffer(relB);

      const nameB = Buffer.from(f.name);
      await writer.writeUInt16BE(nameB.length);
      await writer.writeBuffer(nameB);

      const fullB = Buffer.from(f.fullPath);
      await writer.writeUInt16BE(fullB.length);
      await writer.writeBuffer(fullB);
    }

    for (const u of units) {
      await writer.writeUInt32BE(u.unitId);
      await writer.writeUInt32BE(u.fileId);
      await writer.writeInt32BE(u.entryIndex);

      const hwB = Buffer.from(u.headword || '');
      await writer.writeUInt16BE(hwB.length);
      await writer.writeBuffer(hwB);

      await writer.writeUInt32BE(u.byteOffset);
      await writer.writeUInt32BE(u.byteLength);
      await writer.writeUInt32BE(u.lineStart);
    }

    for (const [bg, val] of bigrams.entries()) {
      const bgB = Buffer.from(bg);
      const isSingle = typeof val === 'number';
      const count = isSingle ? 1 : val.length;

      await writer.writeUInt8(bgB.length);
      await writer.writeBuffer(bgB);

      await writer.writeUInt32BE(count);

      if (useUint16) {
        if (isSingle) {
          await writer.writeUInt16BE(val);
        } else {
          for (let j = 0; j < count; j++) {
            await writer.writeUInt16BE(val[j]);
          }
        }
      } else {
        if (isSingle) {
          await writer.writeUInt32BE(val);
        } else {
          for (let j = 0; j < count; j++) {
            await writer.writeUInt32BE(val[j]);
          }
        }
      }
    }

    await writer.close();

    // Atomically rename temporary file for 100% crash-safe disk persistence
    await fs.promises.rename(tmpCacheFile, SEARCH_INDEX_CACHE_BIN);

    const sizeMb = (writer.totalBytes / (1024 * 1024)).toFixed(1);
    const rssGb = (process.memoryUsage().rss / (1024 * 1024 * 1024)).toFixed(2);
    Logger.info('Index', `Saved Binary Bigram Index cache (${sizeMb} MB, ${units.length} units, RSS ${rssGb} GB) atomically in ${Date.now() - saveStart}ms`);
  } catch (err) {
    try { await fs.promises.unlink(tmpCacheFile); } catch (_) {}
    Logger.error('Index', 'Failed to save binary search index cache', err);
  }
}

/**
 * Tries to load the Bigram index from disk cache if vault fingerprint matches
 */
async function loadSearchIndexFromCacheAsync(expectedVaultSig) {
  // Binary cache is the only on-disk format (the legacy JSON cache is retired).
  return loadSearchIndexFromBinCacheAsync(expectedVaultSig);
}

/**
 * Saves the compiled Bigram index to disk cache for fast server restart
 */
async function saveSearchIndexCacheAsync(vaultSig, fileList, bigrams) {
  try {
    const saveStart = Date.now();
    const bigramsArr = Array.from(bigrams.entries());
    const data = {
      version: '1.0',
      builtAt: new Date().toISOString(),
      vaultSig,
      fileList,
      bigrams: bigramsArr
    };
    const jsonStr = JSON.stringify(data);
    await fs.promises.writeFile(SEARCH_INDEX_CACHE_FILE, jsonStr, 'utf-8');
    const sizeMb = (Buffer.byteLength(jsonStr) / (1024 * 1024)).toFixed(1);
    Logger.info('Index', `Saved Bigram Index to disk cache (${sizeMb} MB) in ${Date.now() - saveStart}ms`);
  } catch (err) {
    Logger.error('Index', 'Failed to save search index cache', err);
  }
}

function extractBigrams(text, onBigram) {
  if (!text || typeof onBigram !== 'function') return;
  const set = extractBigramsFromText(text);
  for (const bg of set) {
    onBigram(bg);
  }
}

function extractQueryBigrams(text) {
  return Array.from(extractBigramsFromText(text));
}

// Sorted-merge intersection of two ascending numeric arrays — O(n+m), zero heap
// allocation. Shared by full-vault search and dictionary full-text search.
function intersectSorted(a, b) {
  const result = [];
  let i = 0, j = 0;
  const aLen = a.length, bLen = b.length;
  while (i < aLen && j < bLen) {
    const av = a[i], bv = b[j];
    if (av < bv) i++;
    else if (av > bv) j++;
    else { result.push(av); i++; j++; }
  }
  return result;
}

// Note: activeIndexBuildId is declared above near setupTreeWatcher (L1603)

// Note: runIndexWorkerPool is imported from lib/worker-pool.js


let searchIndexRebuildPending = false;

/**
 * 非同步建立/重建全庫 Bigram 雙字元倒排搜尋索引。
 * 遍歷 mdRoot 所有 Markdown 檔案，透過二進位磁碟快取 (.bin) 或工作執行緒分詞，
 * 支援中止正在執行的舊建置任務 (buildId 機制)。
 *
 * @param {boolean} [forceRebuild=false] - 是否強制忽略磁碟快取全量重建
 * @returns {Promise<void>}
 */
async function buildSearchIndexAsync(forceRebuild = false) {
  if (searchIndex.building) {
    if (forceRebuild) searchIndexRebuildPending = true;
    return;
  }

  const buildId = ++activeIndexBuildId;
  searchIndex.building = true;
  const indexStart = Date.now();

  try {
    if (!cachedTree || forceRebuild) {
      cachedTree = await scanDirAsync(getMdRoot(), '');
      setupTreeWatcher();
    }
    if (buildId !== activeIndexBuildId) {
      Logger.info('Index', `[Build #${buildId}] Aborted during initial directory scan.`);
      return;
    }

    const files = flattenTreeToFiles(cachedTree, getMdRoot());
    const vaultSig = computeVaultSignature(files);

    // If index is already ready and signature hasn't changed, skip rebuild!
    if (searchIndex.ready && searchIndex.vaultSig === vaultSig && !forceRebuild) {
      searchIndex.building = false;
      return;
    }

    // Try loading index from disk cache first if not forced
    if (!forceRebuild) {
      const loadedFromCache = await loadSearchIndexFromCacheAsync(vaultSig);
      if (buildId !== activeIndexBuildId) return;
      if (loadedFromCache) {
        Logger.info('Index', `Loaded valid Bigram Index from disk cache for ${files.length} files (${searchIndex.bigrams.size} unique 2-grams) in ${Date.now() - indexStart}ms (Vault Unchanged)`);
        searchIndex.building = false;
        return;
      }
    }

    const heapLimitMb = Math.round(v8.getHeapStatistics().heap_size_limit / (1024 * 1024));
    const startRssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
    if (heapLimitMb < 4096) {
      Logger.warn('Index', `[Build #${buildId}] Node heap size limit is ${heapLimitMb} MB (< 4096 MB). Bigram index build for large vaults may experience heap pressure. Consider setting NODE_OPTIONS=--max-old-space-size=6144 or higher.`);
    }
    Logger.info('Index', `Starting Full-text Bigram Inverted Index build #${buildId} for ${files.length} files (Heap limit: ${heapLimitMb} MB, Current RSS: ${startRssMb} MB)...`);

    // Build the unit list: large files → one unit per dictionary entry; small files → one whole-file unit.
    const fileList = [];
    const fileMap = new Map();
    const units = [];
    let unitSeq = 0;

    for (let fIdx = 0; fIdx < files.length; fIdx++) {
      if (buildId !== activeIndexBuildId) {
        Logger.info('Index', `[Build #${buildId}] Aborted during unit construction.`);
        return;
      }
      const file = files[fIdx];
      const fileId = fIdx;
      fileList[fileId] = { id: fileId, relPath: file.relPath, name: file.name, fullPath: file.fullPath };
      fileMap.set(file.relPath, fileId);

      if ((file.size || 0) >= LARGE_FILE_MIN_BYTES) {
        let idx = null;
        try {
          const stat = await fs.promises.stat(file.fullPath);
          idx = await getSectionIndex(file.fullPath, stat, file.relPath);
        } catch (_) {}
        if (idx && idx.entries && idx.entries.length > 0) {
          for (let ei = 0; ei < idx.entries.length; ei++) {
            const e = idx.entries[ei];
            units.push({ unitId: unitSeq++, fileId, entryIndex: ei, headword: e.headword, byteOffset: e.offset, byteLength: e.len, lineStart: e.lineStart });
          }
          continue;
        }
        // Fall through to a whole-file unit if the section index failed to build.
      }
      units.push({ unitId: unitSeq++, fileId, entryIndex: -1, headword: '', byteOffset: 0, byteLength: file.size || 0, lineStart: 1 });
    }

    // Group units by file path so each worker task reads one file handle and reuses it.
    const byFile = new Map();
    for (const u of units) {
      const fullPath = fileList[u.fileId].fullPath;
      let g = byFile.get(fullPath);
      if (!g) { g = { fullPath, units: [] }; byFile.set(fullPath, g); }
      g.units.push({ unitId: u.unitId, byteOffset: u.byteOffset, byteLength: u.byteLength });
    }
    const tasks = Array.from(byFile.values());

    const bigrams = new Map();
    const concurrency = Math.max(1, Math.min(os.cpus().length - 1, 8));
    let doneUnits = 0;
    const totalUnits = units.length;

    await runIndexWorkerPool(tasks,
      (task) => ({ type: 'index-build-file', payload: { fullPath: task.fullPath, units: task.units } }),
      (result, task) => {
        for (const r of result.results) {
          for (const bg of r.bigrams) {
            let list = bigrams.get(bg);
            if (!list) { list = []; bigrams.set(bg, list); }
            list.push(r.unitId);
          }
        }
        doneUnits += task.units.length;
        if (doneUnits % 20000 === 0 || doneUnits === totalUnits) {
          Logger.info('Index', `Indexing progress (build #${buildId}): ${doneUnits}/${totalUnits} units...`);
        }
      },
      concurrency);

    if (buildId !== activeIndexBuildId) {
      Logger.info('Index', `[Build #${buildId}] Aborted: Vault files modified during indexing.`);
      return;
    }

    // Sort posting lists for O(n+m) sorted-merge intersection, then compact in-place to TypedArrays
    const useUint16 = units.length < 65536;
    for (const [bg, list] of bigrams.entries()) {
      if (list.length === 1) {
        bigrams.set(bg, list[0]); // Primitive number (0 bytes V8 Heap overhead!)
      } else {
        list.sort((a, b) => a - b);
        bigrams.set(bg, useUint16 ? new Uint16Array(list) : new Uint32Array(list));
      }
    }

    const createdAt = new Date().toISOString();
    searchIndex = {
      ready: true,
      building: false,
      vaultSig,
      createdAt,
      fileList,
      fileMap,
      units,
      bigrams
    };

    const buildRssGb = (process.memoryUsage().rss / (1024 * 1024 * 1024)).toFixed(2);
    Logger.info('Index', `Full-text Bigram Index built #${buildId} for ${fileList.length} files / ${units.length} units (${bigrams.size} unique 2-grams, RSS: ${buildRssGb} GB) in ${Date.now() - indexStart}ms`);

    if (global.gc) global.gc();

    // Save binary cache to disk for ultra-fast server restarts
    await saveSearchIndexBinCacheAsync(vaultSig, fileList, units, bigrams);
    if (global.gc) global.gc();
  } catch (err) {
    if (err instanceof RangeError) {
      Logger.error('Index', `[Build #${buildId}] Out of memory / RangeError during Bigram index build (RSS: ${(process.memoryUsage().rss / (1024 * 1024 * 1024)).toFixed(2)} GB). Please increase container memory or NODE_OPTIONS=--max-old-space-size.`, err);
    } else {
      Logger.error('Index', `Failed to build Bigram search index #${buildId}`, err);
    }
  } finally {
    if (buildId === activeIndexBuildId) {
      searchIndex.building = false;
    }
    if (searchIndexRebuildPending) {
      searchIndexRebuildPending = false;
      buildSearchIndexAsync(true).catch(() => {});
    }
  }
}

// ── §13 Dictionary Bigram Index & API ─────────────────────────
// Separate from the vault `searchIndex`: dictionaries live in their own root
// (config.settings.dictionaryPath), are entry-level (one unit per headword), and
// are served by `/api/dict-headwords` + `/api/dict-search` only — never mixed into
// the main vault search or its disk cache.
const DICT_INDEX_CACHE_BIN = path.join(LOG_DIR, 'dict-index-cache.bin');

let dictIndex = {
  ready: false,
  building: false,
  dictSig: null,
  fileList: [],       // [{ id, relPath:'dict:*.md', name:'*.md', fullPath }]
  fileMap: new Map(), // relPath -> fileId
  units: [],          // unitId -> { fileId, entryIndex, headword, byteOffset, byteLength, lineStart }
  bigrams: new Map(),
};
const DICT_INDEX_DEBOUNCE_MS = 20000; // 20 秒延遲防抖，避免大量檔案異動時 CPU 卡死
let activeDictIndexBuildId = 0;
let dictWatcher = null;
let dictWatcherDebounceTimer = null;
let dictWatcherChangeCount = 0;

// Note: getDictionaryPath is imported from lib/config.js


// Lists `.md` files directly inside the dictionary root (flat, non-recursive).
function cleanHeadword(hw) {
  return String(hw || '').replace(/^【/, '').replace(/】$/, '').trim();
}

const DICT_HEADING_RE = /^(#{1,6})\s+(.*)$/;

// Fallback entry counter: scans a dictionary file's headings directly when its
// section index is unavailable (e.g. index build failed in a fresh container).
// Counts the deepest heading level — the entry level per scanSections() in
// index-worker.js — and only non-empty headwords, matching the count that
// handleDictHeadwords reports from a built index. Ensures 辭典選擇 never shows 0.
async function scanDictEntryCount(fullPath) {
  let headings = [];
  try {
    const text = await fs.promises.readFile(fullPath, 'utf-8');
    for (const line of text.split('\n')) {
      const m = DICT_HEADING_RE.exec(line);
      if (!m) continue;
      headings.push({ depth: m[1].length, clean: !!cleanHeadword(m[2]) });
    }
  } catch (_) {
    return 0;
  }
  if (headings.length === 0) return 0;
  let entryLevel = 0;
  for (const h of headings) if (h.depth > entryLevel) entryLevel = h.depth;
  let count = 0;
  for (const h of headings) if (h.depth === entryLevel && h.clean) count++;
  return count;
}

async function scanDictFiles() {
  const root = getDictionaryPath();
  if (!root) return [];
  let entries;
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || !entry.isFile() || !entry.name.endsWith('.md')) continue;
    const fullPath = path.join(root, entry.name);
    let size = 0;
    try { size = fs.statSync(fullPath).size; } catch (_) {}
    files.push({ relPath: 'dict:' + entry.name, name: entry.name, fullPath, size });
  }
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return files;
}

// Fingerprint of the dictionary folder (path + size + mtime) so the disk cache
// is only reused when the dictionary files are byte-for-byte unchanged.
async function computeDictSignature(files) {
  const hash = crypto.createHash('md5');
  hash.update(`count:${files.length}\n`);
  for (const f of files) {
    let mtime = '';
    try { mtime = String((await fs.promises.stat(f.fullPath)).mtimeMs); } catch (_) {}
    hash.update(`${f.relPath}\n${f.size}\n${mtime}\n`);
  }
  return hash.digest('hex');
}

async function loadDictIndexFromBinCacheAsync(expectedDictSig) {
  try {
    if (!fs.existsSync(DICT_INDEX_CACHE_BIN)) return false;
    const loadStart = Date.now();
    const binBuf = await fs.promises.readFile(DICT_INDEX_CACHE_BIN);
    if (binBuf.length < 10) return false;

    let readPos = 0;
    const magic = binBuf.readUInt32BE(readPos); readPos += 4;
    // v4: punctuation/whitespace-transparent bigrams (loose search mode)
    if (magic !== 0x44475835 && magic !== 0x44475836) return false;
    const isUint16Format = (magic === 0x44475835);

    const sigLen = binBuf.readUInt16BE(readPos); readPos += 2;
    const dictSig = binBuf.toString('utf-8', readPos, readPos + sigLen); readPos += sigLen;
    if (dictSig !== expectedDictSig) return false;

    const fileCount = binBuf.readUInt32BE(readPos); readPos += 4;
    const unitCount = binBuf.readUInt32BE(readPos); readPos += 4;
    const bigramCount = binBuf.readUInt32BE(readPos); readPos += 4;

    if (fileCount > 500000 || readPos + fileCount * 10 > binBuf.length) return false;
    if (unitCount > 5000000 || readPos + unitCount * 22 > binBuf.length) return false;
    if (bigramCount > 5000000 || readPos + bigramCount * 5 > binBuf.length) return false;

    const fileList = new Array(fileCount);
    const fileMap = new Map();
    for (let i = 0; i < fileCount; i++) {
      const id = binBuf.readUInt32BE(readPos); readPos += 4;
      const relLen = binBuf.readUInt16BE(readPos); readPos += 2;
      const relPath = binBuf.toString('utf-8', readPos, readPos + relLen); readPos += relLen;
      const nameLen = binBuf.readUInt16BE(readPos); readPos += 2;
      const name = binBuf.toString('utf-8', readPos, readPos + nameLen); readPos += nameLen;
      const fullLen = binBuf.readUInt16BE(readPos); readPos += 2;
      const fullPath = binBuf.toString('utf-8', readPos, readPos + fullLen); readPos += fullLen;
      const fileObj = { id, relPath, name, fullPath };
      fileList[i] = fileObj;
      fileMap.set(relPath, id);
    }

    const units = new Array(unitCount);
    for (let i = 0; i < unitCount; i++) {
      const unitId = binBuf.readUInt32BE(readPos); readPos += 4;
      const fileId = binBuf.readUInt32BE(readPos); readPos += 4;
      const entryIndex = binBuf.readInt32BE(readPos); readPos += 4;
      const headwordLen = binBuf.readUInt16BE(readPos); readPos += 2;
      const headword = binBuf.toString('utf-8', readPos, readPos + headwordLen); readPos += headwordLen;
      const byteOffset = binBuf.readUInt32BE(readPos); readPos += 4;
      const byteLength = binBuf.readUInt32BE(readPos); readPos += 4;
      const lineStart = binBuf.readUInt32BE(readPos); readPos += 4;
      units[unitId] = { unitId, fileId, entryIndex, headword, byteOffset, byteLength, lineStart };
    }

    const bigrams = new Map();
    for (let i = 0; i < bigramCount; i++) {
      const bgLen = binBuf.readUInt8(readPos); readPos += 1;
      const bgStr = binBuf.toString('utf-8', readPos, readPos + bgLen); readPos += bgLen;
      const count = binBuf.readUInt32BE(readPos); readPos += 4;
      if (count === 1) {
        const singleId = isUint16Format ? binBuf.readUInt16BE(readPos) : binBuf.readUInt32BE(readPos);
        readPos += isUint16Format ? 2 : 4;
        bigrams.set(bgStr, singleId);
      } else {
        const arr = isUint16Format ? new Uint16Array(count) : new Uint32Array(count);
        if (isUint16Format) {
          for (let j = 0; j < count; j++) { arr[j] = binBuf.readUInt16BE(readPos); readPos += 2; }
        } else {
          for (let j = 0; j < count; j++) { arr[j] = binBuf.readUInt32BE(readPos); readPos += 4; }
        }
        bigrams.set(bgStr, arr);
      }
    }

    let createdAt = null;
    try {
      const stat = await fs.promises.stat(DICT_INDEX_CACHE_BIN);
      createdAt = stat.mtime ? stat.mtime.toISOString() : null;
    } catch (_) {}

    dictIndex = { ready: true, building: false, dictSig: expectedDictSig, createdAt, fileList, fileMap, units, bigrams };
    const dictLoadRssGb = (process.memoryUsage().rss / (1024 * 1024 * 1024)).toFixed(2);
    Logger.info('DictIndex', `Loaded dictionary index from disk cache: ${fileCount} files, ${unitCount} units, ${bigrams.size} bigrams (RSS: ${dictLoadRssGb} GB) in ${Date.now() - loadStart}ms`);
    if (global.gc) global.gc();
    return true;
  } catch (err) {
    Logger.error('DictIndex', 'Failed to read dictionary index cache', err);
    return false;
  }
}

async function saveDictIndexBinCacheAsync(dictSig, fileList, units, bigrams) {
  const tmpCacheFile = DICT_INDEX_CACHE_BIN + '.tmp';
  try {
    const saveStart = Date.now();
    const useUint16 = units.length < 65536;
    // v4: punctuation/whitespace-transparent bigrams (loose search mode)
    const magic = useUint16 ? 0x44475835 : 0x44475836;

    const writer = new ChunkedBinaryWriter(tmpCacheFile, 1024 * 1024);

    await writer.writeUInt32BE(magic);
    const sigBuf = Buffer.from(dictSig || '');
    await writer.writeUInt16BE(sigBuf.length);
    await writer.writeBuffer(sigBuf);

    await writer.writeUInt32BE(fileList.length);
    await writer.writeUInt32BE(units.length);
    await writer.writeUInt32BE(bigrams.size);

    for (const f of fileList) {
      await writer.writeUInt32BE(f.id);
      const relB = Buffer.from(f.relPath);
      await writer.writeUInt16BE(relB.length);
      await writer.writeBuffer(relB);
      const nameB = Buffer.from(f.name);
      await writer.writeUInt16BE(nameB.length);
      await writer.writeBuffer(nameB);
      const fullB = Buffer.from(f.fullPath);
      await writer.writeUInt16BE(fullB.length);
      await writer.writeBuffer(fullB);
    }

    for (const u of units) {
      await writer.writeUInt32BE(u.unitId);
      await writer.writeUInt32BE(u.fileId);
      await writer.writeInt32BE(u.entryIndex);
      const hwB = Buffer.from(u.headword || '');
      await writer.writeUInt16BE(hwB.length);
      await writer.writeBuffer(hwB);
      await writer.writeUInt32BE(u.byteOffset);
      await writer.writeUInt32BE(u.byteLength);
      await writer.writeUInt32BE(u.lineStart);
    }

    for (const [bg, val] of bigrams.entries()) {
      const bgB = Buffer.from(bg);
      const isSingle = typeof val === 'number';
      const count = isSingle ? 1 : val.length;
      await writer.writeUInt8(bgB.length);
      await writer.writeBuffer(bgB);
      await writer.writeUInt32BE(count);
      if (useUint16) {
        if (isSingle) {
          await writer.writeUInt16BE(val);
        } else {
          for (let j = 0; j < count; j++) {
            await writer.writeUInt16BE(val[j]);
          }
        }
      } else {
        if (isSingle) {
          await writer.writeUInt32BE(val);
        } else {
          for (let j = 0; j < count; j++) {
            await writer.writeUInt32BE(val[j]);
          }
        }
      }
    }

    await writer.close();

    await fs.promises.rename(tmpCacheFile, DICT_INDEX_CACHE_BIN);
    const sizeMb = (writer.totalBytes / (1024 * 1024)).toFixed(1);
    const rssGb = (process.memoryUsage().rss / (1024 * 1024 * 1024)).toFixed(2);
    Logger.info('DictIndex', `Saved dictionary index cache (${sizeMb} MB, ${units.length} units, RSS ${rssGb} GB) in ${Date.now() - saveStart}ms`);
  } catch (err) {
    try { await fs.promises.unlink(tmpCacheFile); } catch (_) {}
    Logger.error('DictIndex', 'Failed to save dictionary index cache', err);
  }
}

/**
 * 非同步建立/重建辭典專用的 Bigram 雙字元倒排索引。
 * 辭典索引與全庫主索引完全分離，使用獨立的快取路徑（.dict.bin）與 buildId 機制。
 *
 * 流程與 buildSearchIndexAsync 相同但針對辭典檔案：
 *   1. 掃描辭典目錄（dictRoot），計算辭典簽章（dictSig）
 *   2. 若 dictSig 未變且非強制重建，直接回傳（跳過重建）
 *   3. 嘗試從磁碟 .bin 快取載入（loadDictIndexFromBinCacheAsync）
 *   4. 快取無效則透過 Worker Thread Pool 全量分詞建立
 *   5. 完成後非同步觸發 warmDictSectionIndexes() 預熱 section index
 *
 * @param {boolean} [forceRebuild=false] - 是否強制忽略磁碟快取全量重建
 * @returns {Promise<void>}
 */
let dictIndexRebuildPending = false;

async function buildDictIndexAsync(forceRebuild = false) {
  if (dictIndex.building) {
    if (forceRebuild) dictIndexRebuildPending = true;
    return;
  }

  const buildId = ++activeDictIndexBuildId;
  dictIndex.building = true;
  const indexStart = Date.now();

  try {
    const heapLimitMb = Math.round(v8.getHeapStatistics().heap_size_limit / (1024 * 1024));
    const startRssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
    Logger.info('DictIndex', `Starting dictionary index build #${buildId} (Heap limit: ${heapLimitMb} MB, Current RSS: ${startRssMb} MB)...`);

    const files = await scanDictFiles();
    if (buildId !== activeDictIndexBuildId) return;
    const dictSig = await computeDictSignature(files);

    if (dictIndex.ready && dictIndex.dictSig === dictSig && !forceRebuild) {
      dictIndex.building = false;
      return;
    }

    if (files.length === 0) {
      dictIndex = { ready: false, building: false, dictSig: null, fileList: [], fileMap: new Map(), units: [], bigrams: new Map() };
      return;
    }

    if (!forceRebuild) {
      const loaded = await loadDictIndexFromBinCacheAsync(dictSig);
      if (buildId !== activeDictIndexBuildId) return;
      if (loaded) { dictIndex.building = false; return; }
    }

    // One unit per entry (dictionaries are entry-level; whole-file fallback only
    // if a section index can't be built for a small dictionary file).
    const fileList = [];
    const fileMap = new Map();
    const units = [];
    let unitSeq = 0;

    for (let fIdx = 0; fIdx < files.length; fIdx++) {
      if (buildId !== activeDictIndexBuildId) return;
      const file = files[fIdx];
      const fileId = fIdx;
      fileList[fileId] = { id: fileId, relPath: file.relPath, name: file.name, fullPath: file.fullPath };
      fileMap.set(file.relPath, fileId);

      let idx = null;
      try {
        const stat = await fs.promises.stat(file.fullPath);
        idx = await getSectionIndex(file.fullPath, stat, file.relPath);
      } catch (_) {}
      if (idx && idx.entries && idx.entries.length > 0) {
        for (let ei = 0; ei < idx.entries.length; ei++) {
          const e = idx.entries[ei];
          units.push({ unitId: unitSeq++, fileId, entryIndex: ei, headword: e.headword, byteOffset: e.offset, byteLength: e.len, lineStart: e.lineStart });
        }
        continue;
      }
      units.push({ unitId: unitSeq++, fileId, entryIndex: -1, headword: '', byteOffset: 0, byteLength: file.size || 0, lineStart: 1 });
    }

    const byFile = new Map();
    for (const u of units) {
      const fullPath = fileList[u.fileId].fullPath;
      let g = byFile.get(fullPath);
      if (!g) { g = { fullPath, units: [] }; byFile.set(fullPath, g); }
      g.units.push({ unitId: u.unitId, byteOffset: u.byteOffset, byteLength: u.byteLength });
    }
    const tasks = Array.from(byFile.values());

    const bigrams = new Map();
    const concurrency = Math.max(1, Math.min(os.cpus().length - 1, 8));

    await runIndexWorkerPool(tasks,
      (task) => ({ type: 'index-build-file', payload: { fullPath: task.fullPath, units: task.units } }),
      (result) => {
        for (const r of result.results) {
          for (const bg of r.bigrams) {
            let list = bigrams.get(bg);
            if (!list) { list = []; bigrams.set(bg, list); }
            list.push(r.unitId);
          }
        }
      },
      concurrency);

    if (buildId !== activeDictIndexBuildId) return;

    // Compact posting lists in-place
    const useUint16 = units.length < 65536;
    for (const [bg, list] of bigrams.entries()) {
      if (list.length === 1) bigrams.set(bg, list[0]);
      else { list.sort((a, b) => a - b); bigrams.set(bg, useUint16 ? new Uint16Array(list) : new Uint32Array(list)); }
    }

    dictIndex = {
      ready: true,
      building: false,
      dictSig,
      createdAt: new Date().toISOString(),
      fileList,
      fileMap,
      units,
      bigrams
    };

    const dictRssGb = (process.memoryUsage().rss / (1024 * 1024 * 1024)).toFixed(2);
    Logger.info('DictIndex', `Dictionary full-text index built for ${fileList.length} files / ${units.length} entries (${bigrams.size} unique 2-grams, RSS: ${dictRssGb} GB) in ${Date.now() - indexStart}ms`);
    if (global.gc) global.gc();

    await saveDictIndexBinCacheAsync(dictSig, fileList, units, bigrams);
    if (global.gc) global.gc();
  } catch (err) {
    if (err instanceof RangeError) {
      Logger.error('DictIndex', `[Build #${buildId}] Out of memory / RangeError during dictionary index build (RSS: ${(process.memoryUsage().rss / (1024 * 1024 * 1024)).toFixed(2)} GB).`, err);
    } else {
      Logger.error('DictIndex', 'Failed to build dictionary index', err);
    }
  } finally {
    if (buildId === activeDictIndexBuildId) {
      dictIndex.building = false;
    }
    if (dictIndexRebuildPending) {
      dictIndexRebuildPending = false;
      buildDictIndexAsync(true).catch(() => {});
    }
  }
}

function invalidateDictIndex() {
  activeDictIndexBuildId++;
  dictIndex.ready = false;
  dictIndex.building = false;
  invalidateDailyWordCache();
}

/**
 * Builds the section index for every dictionary file in the background so the
 * first dictionary open is warm even after a restart. buildDictIndexAsync can
 * short-circuit after loading the bigram bin without ever building a section
 * index (server.js:2758-2761), which leaves the first click paying a full
 * 23MB scan; this closes that gap. Fire-and-forget — never blocks boot.
 */
async function warmDictSectionIndexes() {
  try {
    const files = await scanDictFiles();
    for (const f of files) {
      const stat = await fs.promises.stat(f.fullPath);
      await getSectionIndex(f.fullPath, stat, f.relPath);
    }
  } catch (_) {}
}

function setupDictWatcher() {
  if (dictWatcher) return;
  const root = getDictionaryPath();
  if (!root || !fs.existsSync(root)) return;
  try {
    dictWatcher = fs.watch(root, { recursive: true }, (eventType, filename) => {
      if (filename && (filename.startsWith('.') || filename.includes('/.'))) return;
      invalidateDictIndex();
      if (filename) {
        const dictKey = `dict:${filename}`;
        if (dictSectionIndexCache.has(dictKey)) {
          dictSectionIndexCache.delete(dictKey);
        } else {
          for (const k of dictSectionIndexCache.keys()) {
            if (k === dictKey || k.endsWith('/' + filename)) {
              dictSectionIndexCache.delete(k);
            }
          }
        }
      } else {
        invalidateDictSectionIndexes();
      }

      // 立即中止任何正在進行中的舊辭典索引建置，釋放 CPU
      activeDictIndexBuildId++;
      dictIndex.building = false;

      // 第一次檔案異動事件發生時絕不立即執行重建，必須等待完整 20 秒沉降期
      dictWatcherChangeCount++;
      const isFirstEvent = !dictWatcherDebounceTimer;
      if (dictWatcherDebounceTimer) {
        clearTimeout(dictWatcherDebounceTimer);
      }
      if (isFirstEvent) {
        Logger.info('DictIndex', `Dictionary file changed [#${dictWatcherChangeCount}]: "${filename || 'unknown'}" (${eventType}). Aborting active build & waiting ${DICT_INDEX_DEBOUNCE_MS / 1000}s debounce before index rebuild...`);
      } else {
        Logger.info('DictIndex', `Dictionary file changed [#${dictWatcherChangeCount}]: "${filename || 'unknown'}" (${eventType}). Resetting countdown, waiting another ${DICT_INDEX_DEBOUNCE_MS / 1000}s...`);
      }
      dictWatcherDebounceTimer = setTimeout(() => {
        const totalChanges = dictWatcherChangeCount;
        dictWatcherDebounceTimer = null;
        dictWatcherChangeCount = 0;
        Logger.info('DictIndex', `Dictionary files quiet for ${DICT_INDEX_DEBOUNCE_MS / 1000}s (accumulated ${totalChanges} change events). Starting Dictionary Index build...`);
        buildDictIndexAsync(true).catch(() => {});
      }, DICT_INDEX_DEBOUNCE_MS);
    });
  } catch (err) {
    Logger.error('DictIndex', 'Error setting up dictionary watcher', err);
  }
}

function resetDictWatcher() {
  if (dictWatcherDebounceTimer) { clearTimeout(dictWatcherDebounceTimer); dictWatcherDebounceTimer = null; }
  dictWatcherChangeCount = 0;
  if (dictWatcher) { try { dictWatcher.close(); } catch (_) {} dictWatcher = null; }
  invalidateDictIndex();
  invalidateDictSectionIndexes();
}

// ── API: Dictionary Headwords (client-side prefix/fuzzy index) ────────────
/**
 * 傳回所有辭典詞條索引（GET /api/dict/headwords），供前端在本地執行前綴搜尋。
 * 包含每個辭典檔案的名稱、詞條清單與詞條數量，並附加 ETag 支援 304 Not Modified。
 * 若辭典索引尚未就緒則等待建立完成後再回傳。
 *
 * @param {http.IncomingMessage} req - HTTP 請求物件（可含 If-None-Match 標頭）
 * @param {http.ServerResponse}  res - HTTP 回應物件
 */
async function handleDictHeadwords(req, res) {
  try {
    setupDictWatcher();
    const files = await scanDictFiles();
    if (files.length === 0) {
      return sendJSON(res, 200, { files: [], entries: [] });
    }

    // Compute per-file entry counts (cached section index, or a direct scan).
    const fileList = files.map(f => ({ path: f.relPath, name: f.name.replace(/\.md$/, ''), size: f.size, entryCount: 0 }));
    const perFileIdx = new Array(files.length).fill(null);
    const perFileMtime = new Array(files.length).fill('');
    for (let fi = 0; fi < files.length; fi++) {
      const f = files[fi];
      let stat = null;
      try { stat = await fs.promises.stat(f.fullPath); perFileMtime[fi] = String(stat.mtimeMs); } catch (_) {}
      let idx = null;
      try {
        if (stat) idx = await getSectionIndex(f.fullPath, stat, f.relPath);
      } catch (_) {}
      perFileIdx[fi] = idx;
      if (idx && idx.entries && idx.entries.length > 0) {
        for (const e of idx.entries) {
          if (cleanHeadword(e.headword)) fileList[fi].entryCount++;
        }
      } else {
        // Section index unavailable — fall back to a direct heading scan so the
        // entry count reflects the file contents instead of showing 0.
        fileList[fi].entryCount = await scanDictEntryCount(f.fullPath);
      }
    }

    // ETag folds the entry counts in, so a client that cached a `0` count before
    // the section index finished building is invalidated on the next poll instead
    // of being served a stale 304 forever (the old ETag only keyed on size+mtime).
    const etagParts = files.map((f, fi) => `${f.relPath}:${f.size}:${perFileMtime[fi]}:${fileList[fi].entryCount}`);
    const etag = `W/"${crypto.createHash('md5').update(etagParts.join('|')).digest('hex')}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, Object.assign({ 'ETag': etag, 'Cache-Control': 'no-cache' }, SECURITY_HEADERS));
      return res.end();
    }

    // Build the headword entries array from the already-loaded section indexes.
    const entries = [];
    for (let fi = 0; fi < files.length; fi++) {
      const idx = perFileIdx[fi];
      if (!idx || !idx.entries) continue;
      for (let ei = 0; ei < idx.entries.length; ei++) {
        const e = idx.entries[ei];
        const clean = cleanHeadword(e.headword);
        if (!clean) continue;
        entries.push([fi, ei, e.lineStart, clean]);
      }
    }

    const headers = Object.assign({ 'ETag': etag, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' }, SECURITY_HEADERS);
    sendCompressed(req, res, 200, headers, Buffer.from(JSON.stringify({ files: fileList, entries }), 'utf-8'));
  } catch (err) {
    Logger.error('Dict', 'Failed to list dictionary headwords', err);
    sendJSON(res, 500, { error: 'Failed to list dictionary headwords' });
  }
}

// ── API: Dictionary Files (lightweight list for Admin UI) ────────────────
async function handleDictFiles(req, res) {
  try {
    const root = getDictionaryPath();
    const enabled = config.settings.dictionaryEnabled === true && !!root;
    if (!enabled) {
      return sendJSON(res, 200, { enabled: false, files: [] });
    }
    const files = await scanDictFiles();
    const result = files.map(f => ({
      name: f.name.replace(/\.md$/, ''),
      fileName: f.name,
      relPath: f.relPath,
      size: f.size
    }));
    return sendJSON(res, 200, {
      enabled: true,
      files: result
    });
  } catch (err) {
    Logger.error('Dict', 'Failed to list dict files', err);
    sendJSON(res, 500, { error: 'Failed to list dictionary files' });
  }
}

// ── API: Dictionary Full-text Search ──────────────────────────────────────
/**
 * 在辭典獨立 Bigram 索引中執行全文搜尋（GET /api/dict/search?q=...）。
 * 支援簡繁轉換（toTraditional）；按 proximity 距離排序結果。
 * 每個辭典檔案最多回傳 DICT_SEARCH_MAX_PER_FILE（1500）筆命中，防止記憶體膨脹。
 *
 * @param {http.IncomingMessage} req   - HTTP 請求物件
 * @param {http.ServerResponse}  res   - HTTP 回應物件
 * @param {Object}               query - 查詢參數：q（必要）、files（可選，逗號分隔的辭典路徑限制）
 */
async function handleDictSearch(req, res, query) {
  // Cap full-text matches per selected dictionary. Without this, a common term
  // (e.g. 一切) yields tens of thousands of matches, and the unbounded `results`
  // array plus the client-side render balloon memory on repeated searches.
  const DICT_SEARCH_MAX_PER_FILE = 1500;
  const rawQ = (query.q || '').trim();
  const shouldS2T = query.s2t !== undefined ? (query.s2t === '1' || query.s2t === 'true') : true;
  const q = shouldS2T ? toTraditional(rawQ) : rawQ;
  if (!q || q.length === 0) {
    return sendJSON(res, 400, { error: 'Missing query parameter' });
  }
  const terms = q.split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return sendJSON(res, 400, { error: 'Missing query parameter' });
  }

  // Optional comma-separated list of `dict:` paths restricting the search.
  const filesParam = query.files ? String(query.files).split(',').map(s => s.trim()).filter(Boolean) : null;

  const maxProximityDist = Math.max(10, parseInt(config.settings.maxProximityDistance) || 150);

  try {
    if (!dictIndex.ready && !dictIndex.building && !dictWatcherDebounceTimer) {
      buildDictIndexAsync().catch(() => {});
    }
    setupDictWatcher();

    const files = await scanDictFiles();
    if (files.length === 0) {
      return sendJSON(res, 200, { query: q, results: [], total: 0, capped: false });
    }

    let fileSet = null;
    if (filesParam && filesParam.length > 0) fileSet = new Set(filesParam);

    const results = [];
    let candidateUnits = null;

    if (dictIndex.ready && terms.some(t => t.length >= 2) && dictIndex.units && dictIndex.units.length > 0) {
      let finalCandidates = null;
      for (const term of terms) {
        if (term.length < 2) continue;
        const qBigrams = extractQueryBigrams(term);
        if (qBigrams.length === 0) continue;
        let termCandidates = null;
        for (const bg of qBigrams) {
          const val = dictIndex.bigrams.get(bg);
          if (val === undefined || val === null) { termCandidates = []; break; }
          if (termCandidates === null) termCandidates = typeof val === 'number' ? [val] : Array.from(val);
          else {
            const posting = typeof val === 'number' ? [val] : val;
            termCandidates = intersectSorted(termCandidates, posting);
            if (termCandidates.length === 0) break;
          }
        }
        if (termCandidates !== null) {
          if (finalCandidates === null) finalCandidates = termCandidates;
          else { finalCandidates = intersectSorted(finalCandidates, termCandidates); if (finalCandidates.length === 0) break; }
        }
      }

      if (finalCandidates && finalCandidates.length > 0) {
        candidateUnits = finalCandidates.map(uid => dictIndex.units[uid]).filter(Boolean);
        if (fileSet) {
          candidateUnits = candidateUnits.filter(u => fileSet.has(dictIndex.fileList[u.fileId].relPath));
        }
        if (candidateUnits.length === 0) candidateUnits = null;
      }
    }

    let unitsToScan;
    if (candidateUnits && candidateUnits.length > 0) {
      unitsToScan = candidateUnits.map(u => {
        const f = dictIndex.fileList[u.fileId];
        return {
          unitId: u.unitId,
          file: f.relPath,
          fileName: f.name.replace(/\.md$/, ''),
          entryIndex: u.entryIndex,
          headword: u.headword,
          byteOffset: u.byteOffset,
          byteLength: u.byteLength,
          lineStart: u.lineStart,
          fullPath: f.fullPath,
        };
      });
    } else {
      const scanFiles = fileSet ? files.filter(f => fileSet.has(f.relPath)) : files;
      unitsToScan = scanFiles.map(f => ({
        unitId: -1,
        file: f.relPath,
        fileName: f.name.replace(/\.md$/, ''),
        entryIndex: -1,
        headword: '',
        byteOffset: 0,
        byteLength: f.size || 0,
        lineStart: 1,
        fullPath: f.fullPath,
      }));
    }

    const byFile = new Map();
    for (const u of unitsToScan) {
      let g = byFile.get(u.fullPath);
      if (!g) { g = { fullPath: u.fullPath, units: [] }; byFile.set(u.fullPath, g); }
      g.units.push(u);
    }
    const scanTasks = Array.from(byFile.values());
    const concurrency = Math.max(1, Math.min(os.cpus().length - 1, 8));

    let hitCap = false;
    await runIndexWorkerPool(scanTasks,
      (task) => ({ type: 'search-scan', payload: { fullPath: task.fullPath, units: task.units, terms, maxProximityDist, maxPerFile: DICT_SEARCH_MAX_PER_FILE } }),
      (result) => {
        if (result.matches.length >= DICT_SEARCH_MAX_PER_FILE) hitCap = true;
        for (const m of result.matches) {
          results.push({ file: m.file, fileName: m.fileName, headword: m.headword, entryIndex: m.entryIndex, line: m.line, snippet: m.snippet });
        }
      },
      concurrency);

    results.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));

    sendJSON(res, 200, { query: q, results, total: results.length, capped: hitCap });
  } catch (err) {
    Logger.error('Dict', `Dictionary search failed for "${q}"`, err);
    sendJSON(res, 500, { error: 'Dictionary search failed' });
  }
}

// ── API: Dictionary Analytics Event (client-side beacon) ────────────────────
// Fire-and-forget endpoint for the client-side dictionary panel. Dictionary
// queries auto-search on every keystroke (no Enter), so we deliberately do NOT
// count a search when the query is typed or the full-text endpoint is hit.
// Instead a single result CLICK is the only event that counts, and it records
// both 辭典查詢 (the query string that produced the result) and 辭典點閱 (the
// headword that was opened). This keeps the search/lookup counts in lockstep
// with actual user intent rather than debounced keystrokes.
//   kind: 'lookup' → a result was clicked; payload carries { file, headword, query }
// Never blocks the caller; a malformed body simply yields an empty payload.
async function handleDictEvent(req, res) {
  let data = {};
  try { data = await readJSONBody(req); } catch (_) {}
  const kind = String(data.kind || '').trim();
  const file = String(data.file || '').trim().slice(0, 500);
  const headword = String(data.headword || '').trim().slice(0, 300);
  const query = String(data.query || '').trim().slice(0, 500);

  if (kind === 'lookup') {
    if (!file && !headword) return sendJSON(res, 400, { error: 'Missing lookup target' });
    Logger.info('DictLookup', `Lookup: "${headword}" in ${file || '(unknown)'}`, req, { path: file || undefined, query: headword || undefined });
    if (query) {
      Logger.info('DictSearch', `Dictionary query: "${query}" (clicked)`, req, { query });
    }
    return sendJSON(res, 200, { ok: true });
  }
  return sendJSON(res, 400, { error: 'Unknown event kind' });
}

// ── API: Full-text Search ────────────────────────────────────
/**
 * 在全庫 Bigram 倒排索引中執行全文搜尋（GET /api/search?q=...）。
 * 支援多詞 AND 交集搜尋、簡繁轉換、資料夾範圍限制（folder 參數）。
 * 結果按 60 秒記憶體快取（cacheKey = folder::q），命中快取直接回傳。
 *
 * @param {http.IncomingMessage} req   - HTTP 請求物件
 * @param {http.ServerResponse}  res   - HTTP 回應物件
 * @param {Object}               query - 查詢參數：q（必要）、folder（可選，限制搜尋範圍）
 */
async function handleSearch(req, res, query) {
  const searchStart = Date.now();
  const mode = query.mode === 'loose' ? 'loose' : 'strict';
  const rawQ = (query.q || '').trim();
  const shouldS2T = query.s2t !== undefined ? (query.s2t === '1' || query.s2t === 'true') : true;
  const q = shouldS2T ? toTraditional(rawQ) : rawQ;
  if (!q || q.length === 0) {
    return sendJSON(res, 400, { error: 'Missing query parameter' });
  }

  let terms = q.split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return sendJSON(res, 400, { error: 'Missing query parameter' });
  }

  if (mode === 'loose') {
    terms = terms.map(normalizeLooseTerm).filter(Boolean);
    if (terms.length === 0) {
      return sendJSON(res, 200, { query: q, mode, terms: [], results: [], total: 0, capped: false });
    }
  }

  const targetFolder = query.folder ? query.folder.trim().replace(/^\/+|\/+$/g, '') : '';
  const cacheKey = `${mode}::${targetFolder}::${q}`;
  const cached = searchCache.get(cacheKey);
  if (cached && (Date.now() - cached.time) < 60000) {
    searchMetrics.totalQueries++;
    searchMetrics.cacheHits++;
    searchMetrics.lastSearchTimeMs = 0;
    Logger.info('Search', `[${mode}] Query: "${q}"${targetFolder ? `, Scope: "${targetFolder}"` : ''} (Cache Hit) -> ${cached.data.results.length} matches (0ms)`, req, { query: q });
    return sendJSON(res, 200, cached.data);
  }

  const results = [];
  const SNIPPET_RADIUS = 60;
  const maxProximityDist = Math.max(10, parseInt(config.settings.maxProximityDistance) || 150);

  try {
    // Reuse cached tree to avoid redundant filesystem traversal
    if (!cachedTree) {
      cachedTree = await scanDirAsync(getMdRoot(), '');
      setupTreeWatcher();
    }
    // Ensure Bigram Index build is triggered in background if not ready (and not in debounce waiting)
    if (!searchIndex.ready && !searchIndex.building && !treeWatcherDebounceTimer) {
      buildSearchIndexAsync().catch(() => {});
    }

    let files = flattenTreeToFiles(cachedTree, getMdRoot());
    const isFilenameOnly = targetFolder === '__FILENAME_ONLY__';
    const folderFilter = isFilenameOnly ? '' : targetFolder;

    // Filter files by target directory or specific file path if specified
    if (folderFilter) {
      files = files.filter(f => f.relPath === folderFilter || f.relPath.startsWith(folderFilter + '/'));
    }

    const initialFileCount = files.length;
    let usedIndex = false;
    let candidateUnits = null; // narrowed unit list (entry-level for large files); null = full scan

    // Bigram Inverted Index filtering using sorted-merge intersection (zero Set allocation)
    if (searchIndex.ready && terms.some(t => normalizeLooseTerm(t).length >= 2) && !isFilenameOnly && searchIndex.units && searchIndex.units.length > 0) {
      let finalCandidates = null; // sorted array of unit IDs

      for (const term of terms) {
        if (normalizeLooseTerm(term).length < 2) continue;
        const qBigrams = extractQueryBigrams(term);
        if (qBigrams.length === 0) continue;

        let termCandidates = null; // sorted array of unit IDs
        for (const bg of qBigrams) {
          const val = searchIndex.bigrams.get(bg);
          if (val === undefined || val === null) {
            termCandidates = [];
            break;
          }

          if (termCandidates === null) {
            termCandidates = typeof val === 'number' ? [val] : Array.from(val);
          } else {
            const posting = typeof val === 'number' ? [val] : val;
            termCandidates = intersectSorted(termCandidates, posting);
            if (termCandidates.length === 0) break;
          }
        }

        if (termCandidates !== null) {
          if (finalCandidates === null) {
            finalCandidates = termCandidates;
          } else {
            finalCandidates = intersectSorted(finalCandidates, termCandidates);
            if (finalCandidates.length === 0) break;
          }
        }
      }

      if (finalCandidates && finalCandidates.length > 0) {
        candidateUnits = finalCandidates
          .map(uid => searchIndex.units[uid])
          .filter(Boolean);

        if (folderFilter) {
          candidateUnits = candidateUnits.filter(u => {
            const f = searchIndex.fileList[u.fileId];
            return f && (f.relPath === folderFilter || f.relPath.startsWith(folderFilter + '/'));
          });
        }
        if (candidateUnits.length === 0) candidateUnits = null; // all filtered out → full-scan fallback
        else usedIndex = true;
      }
    }

    const isSingleFile = files.length === 1;
    const MAX_RESULTS = isSingleFile ? 5000 : 1500;
    const MAX_FILE_MATCHES = isSingleFile ? 5000 : 250;

    if (isFilenameOnly) {
      for (const file of files) {
        if (results.length >= MAX_RESULTS) break;
        const cleanName = file.name.replace(/\.md$/, '');
        const cleanNameLower = mode === 'loose' ? normalizeLooseTerm(cleanName).toLowerCase() : cleanName.toLowerCase();
        const relPathLower = mode === 'loose' ? normalizeLooseTerm(file.relPath).toLowerCase() : file.relPath.toLowerCase();

        const matchesAll = terms.every(term => {
          const tLower = (mode === 'loose' ? normalizeLooseTerm(term) : term).toLowerCase();
          return cleanNameLower.includes(tLower) || relPathLower.includes(tLower);
        });

        if (matchesAll) {
          results.push({
            file: file.relPath,
            fileName: cleanName,
            line: 1,
            snippet: `📄 檔名對比匹配: "${file.relPath}"`,
          });
        }
      }
    } else {
      // Build the list of units to scan. When the bigram index narrowed to a set of
      // candidate entries (large files) we scan only those; otherwise fall back to one
      // whole-file unit per file so every file is still covered.
      let unitsToScan;
      if (candidateUnits && candidateUnits.length > 0) {
        unitsToScan = candidateUnits.map(u => {
          const f = searchIndex.fileList[u.fileId];
          return {
            unitId: u.unitId,
            file: f.relPath,
            fileName: f.name.replace(/\.md$/, ''),
            entryIndex: u.entryIndex,
            headword: u.headword,
            byteOffset: u.byteOffset,
            byteLength: u.byteLength,
            lineStart: u.lineStart,
            fullPath: f.fullPath,
          };
        });
      } else {
        unitsToScan = files.map((f, i) => ({
          unitId: i,
          file: f.relPath,
          fileName: f.name.replace(/\.md$/, ''),
          entryIndex: -1,
          headword: '',
          byteOffset: 0,
          byteLength: f.size || 0,
          lineStart: 1,
          fullPath: f.fullPath,
        }));
      }

      // Group units by file → one worker task per file (reuses the file handle inside the worker).
      const byFile = new Map();
      for (const u of unitsToScan) {
        let g = byFile.get(u.fullPath);
        if (!g) { g = { fullPath: u.fullPath, units: [] }; byFile.set(u.fullPath, g); }
        g.units.push(u);
      }
      const scanTasks = Array.from(byFile.values());
      const concurrency = Math.max(1, Math.min(os.cpus().length - 1, 8));

      await runIndexWorkerPool(scanTasks,
        (task) => ({ type: 'search-scan', payload: { fullPath: task.fullPath, units: task.units, terms, maxProximityDist, maxPerFile: MAX_FILE_MATCHES, ignorePunct: mode === 'loose' } }),
        (result) => {
          for (const m of result.matches) {
            if (results.length >= MAX_RESULTS) break;
            results.push({ file: m.file, fileName: m.fileName, headword: m.headword, entryIndex: m.entryIndex, line: m.line, snippet: m.snippet });
          }
        },
        concurrency);

      // Post-processing: deduplicate adjacent matches in same file (within 2 lines).
      // Parallel workers produce non-deterministic order, so sort by (file, line) first.
      if (terms.length > 1 && results.length > 1) {
        results.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
        const deduped = [results[0]];
        for (let di = 1; di < results.length; di++) {
          const prev = deduped[deduped.length - 1];
          const curr = results[di];
          if (prev.file === curr.file && Math.abs(prev.line - curr.line) <= 2) continue;
          deduped.push(curr);
        }
        results.length = 0;
        for (const r of deduped) results.push(r);
      }
    }

    const searchDuration = Date.now() - searchStart;
    searchMetrics.totalQueries++;
    searchMetrics.cacheMisses++;
    searchMetrics.totalSearchTimeMs += searchDuration;
    searchMetrics.lastSearchTimeMs = searchDuration;

    const searchData = { query: q, mode, terms, results, total: results.length, capped: results.length >= MAX_RESULTS };
    if (searchCache.size >= SEARCH_CACHE_MAX) {
      const oldestKey = searchCache.keys().next().value;
      searchCache.delete(oldestKey);
    }
    searchCache.set(cacheKey, { time: Date.now(), data: searchData });

    const indexInfo = usedIndex ? ` (Index Candidates: ${candidateUnits ? candidateUnits.length : 0}/${searchIndex.units.length} units)` : '';
    Logger.info('Search', `[${mode}] Query: "${q}"${targetFolder ? `, Scope: "${targetFolder}"` : ''}${indexInfo} -> ${results.length} matches in ${searchDuration}ms`, req, { query: q });
    sendJSON(res, 200, searchData);
  } catch (err) {
    Logger.error('Search', `Search failed for query "${q}"`, err, req);
    sendJSON(res, 500, { error: 'Search failed' });
  }
}

// ── API: In-page (Ctrl+F) full-file search ─────────────────────
// Used by app.js `doPageSearchVirtual` for large files: returns EVERY match in a
// single file (ordered by line), scoped by entry so the client can jump to any
// entry — not just the currently-mounted virtualization chunks.
async function handleSearchFile(req, res, query) {
  const rawQ = (query.q || '').trim();
  const shouldS2T = query.s2t !== undefined ? (query.s2t === '1' || query.s2t === 'true') : true;
  const q = shouldS2T ? toTraditional(rawQ) : rawQ;
  const relPath = query.path;
  if (!q || !relPath) {
    return sendJSON(res, 400, { error: 'Missing query or path parameter' });
  }

  const terms = q.split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return sendJSON(res, 400, { error: 'Missing query parameter' });
  }

  const maxProximityDist = Math.max(10, parseInt(config.settings.maxProximityDistance) || 150);
  const MAX_RESULTS = 5000;

  try {
    if (!cachedTree) {
      cachedTree = await scanDirAsync(getMdRoot(), '');
      setupTreeWatcher();
    }
    if (!searchIndex.ready && !searchIndex.building && !treeWatcherDebounceTimer) {
      buildSearchIndexAsync().catch(() => {});
    }

    const files = flattenTreeToFiles(cachedTree, getMdRoot());
    const file = files.find(f => f.relPath === relPath);
    if (!file) {
      return sendJSON(res, 404, { error: 'File not found: ' + relPath });
    }

    // Prefer entry-level units from the index; fall back to one whole-file unit.
    let units = null;
    if (searchIndex.ready && searchIndex.fileMap && searchIndex.fileMap.has(relPath)) {
      const fileId = searchIndex.fileMap.get(relPath);
      const fileUnits = searchIndex.units.filter(u => u && u.fileId === fileId);
      if (fileUnits.length > 0) units = fileUnits;
    }
    if (!units) {
      units = [{ unitId: 0, fileId: -1, entryIndex: -1, headword: '', byteOffset: 0, byteLength: file.size || 0, lineStart: 1 }];
    }

    const scanUnits = units.map(u => ({
      unitId: u.unitId,
      file: file.relPath,
      fileName: file.name.replace(/\.md$/, ''),
      entryIndex: u.entryIndex,
      headword: u.headword,
      byteOffset: u.byteOffset,
      byteLength: u.byteLength,
      lineStart: u.lineStart,
    }));

    const matches = [];
    await runIndexWorkerPool([{ fullPath: file.fullPath, units: scanUnits }],
      (t) => ({ type: 'search-scan', payload: { fullPath: t.fullPath, units: t.units, terms, maxProximityDist, maxPerFile: MAX_RESULTS } }),
      (result) => {
        for (const m of result.matches) {
          matches.push({ line: m.line, entryIndex: m.entryIndex, headword: m.headword, snippet: m.snippet });
        }
      },
      1);

    matches.sort((a, b) => a.line - b.line);
    sendJSON(res, 200, { path: relPath, query: q, matches, total: matches.length });
  } catch (err) {
    Logger.error('Search', `Search-file failed for "${relPath}" / "${q}"`, err, req);
    sendJSON(res, 500, { error: 'File search failed' });
  }
}

// ── §15-§17 Static Cache, Auth, Rate Limiting, and Analytics (refactored to lib/) ──

function createBlacklistChecker(blackList) {
  if (!Array.isArray(blackList) || blackList.length === 0) {
    return () => false;
  }

  // Guard: Cap max rules to 100 and max length to 200 chars to prevent rule-flooding DoS
  const MAX_RULES = 100;
  const MAX_RULE_LENGTH = 200;

  const rules = blackList
    .slice(0, MAX_RULES)
    .map(p => String(p || '').trim().replace(/\\/g, '/'))
    .filter(p => p.length > 0 && p.length <= MAX_RULE_LENGTH);

  if (rules.length === 0) return () => false;

  const matchers = rules.map(rawRule => {
    // Collapse consecutive asterisks to prevent exponential backtracking
    let rule = rawRule.replace(/\*+/g, '*');

    // 1. Directory prefix match: e.g. "20-辭典/"
    if (rule.endsWith('/') && !rule.includes('*') && !rule.includes('?')) {
      const prefix = rule.toLowerCase();
      return (path) => path.toLowerCase().startsWith(prefix);
    }

    // 2. Optimized safe wildcard patterns
    if (rule.includes('*') || rule.includes('?')) {
      // 2a. Match all: "*"
      if (rule === '*') return () => true;

      // 2b. Simple suffix match: e.g. "*辭典.md" (only 1 star at start)
      if (rule.startsWith('*') && !rule.slice(1).includes('*') && !rule.includes('?')) {
        const suffix = rule.slice(1).toLowerCase();
        const suffixNoMd = suffix.endsWith('.md') ? suffix.slice(0, -3) : suffix;
        return (path) => {
          const lp = path.toLowerCase();
          return lp.endsWith(suffix) || lp.endsWith(suffixNoMd);
        };
      }

      // 2c. Simple prefix match: e.g. "20-辭典/*" (only 1 star at end)
      if (rule.endsWith('*') && !rule.slice(0, -1).includes('*') && !rule.includes('?')) {
        const prefix = rule.slice(0, -1).toLowerCase();
        return (path) => path.toLowerCase().startsWith(prefix);
      }

      // 2d. Simple substring contains: e.g. "*辭典*" (only 2 stars at ends)
      if (rule.startsWith('*') && rule.endsWith('*') && !rule.slice(1, -1).includes('*') && !rule.includes('?')) {
        const needle = rule.slice(1, -1).toLowerCase();
        return (path) => path.toLowerCase().includes(needle);
      }

      // 2e. General glob: Limit wildcards to max 4 to guarantee linear regex complexity
      const wildcardsCount = (rule.match(/[*?]/g) || []).length;
      if (wildcardsCount > 4) {
        // Fallback to safe substring matching for pathological patterns
        const cleaned = rule.replace(/[*?]/g, '').toLowerCase();
        return (path) => path.toLowerCase().includes(cleaned);
      }

      try {
        // Use segment-bounded [^/]* instead of .* so it never backtracks across directories
        const regexStr = '^' + rule
          .replace(/([.+^${}()|[\]\\])/g, '\\$1')
          .replace(/\*/g, '[^/]*')
          .replace(/\?/g, '[^/]') + '$';
        const regex = new RegExp(regexStr, 'i');
        return (path) => regex.test(path) || regex.test(path.replace(/\.md$/, ''));
      } catch (_) {
        return () => false;
      }
    }

    // 3. Exact file match (with or without .md)
    const ruleLower = rule.toLowerCase();
    const ruleWithMd = ruleLower.endsWith('.md') ? ruleLower : ruleLower + '.md';
    const ruleWithoutMd = ruleLower.endsWith('.md') ? ruleLower.slice(0, -3) : ruleLower;

    return (path) => {
      const lp = path.toLowerCase();
      const pathWithoutMd = lp.endsWith('.md') ? lp.slice(0, -3) : lp;
      return lp === ruleLower || lp === ruleWithMd || pathWithoutMd === ruleWithoutMd;
    };
  });

  return function isBlacklisted(path) {
    if (!path) return false;
    const normPath = String(path).trim().replace(/\\/g, '/');
    return matchers.some(matcher => matcher(normPath));
  };
}

const HOT_LIST_CACHE_TTL = 60000; // 60s memory cache to avoid scanning 90-day logs on every suggest-list call
let hotListCache = null;
let hotListCacheTime = 0;
let hotListCacheKey = "";

async function buildHotList(blackList) {
  const isBlacklisted = createBlacklistChecker(blackList);
  const now = Date.now();
  const cacheKey = JSON.stringify(blackList || []);
  if (hotListCache && hotListCacheKey === cacheKey && (now - hotListCacheTime) < HOT_LIST_CACHE_TTL) {
    return hotListCache;
  }

  // Collect top files for 7d, 30d, 90d windows
  const windows = [7, 30, 90];
  const windowMaps = windows.map(() => new Map());

  let files = [];
  try { files = await fs.promises.readdir(LOG_DIR); } catch (_) {}

  const maxCutoff = now - (90 * 24 * 60 * 60 * 1000);

  const seenHotIds = new Set();

  function processHotEntry(item) {
    if (isBotEntry(item)) return;
    if (item.tag !== 'Render') return;
    const id = item.id || getAnalyticsEventId(item);
    if (seenHotIds.has(id)) return;
    seenHotIds.add(id);

    let docPath = extractAnalyticsPath(item);
    if (!docPath) return;
    docPath = docPath.trim().replace(/\\/g, '/');
    if (isBlacklisted(docPath)) return;

    const t = new Date(item.timestamp).getTime();
    if (Number.isNaN(t)) return;
    windows.forEach((days, idx) => {
      if (t >= now - (days * 24 * 60 * 60 * 1000)) {
        const m = windowMaps[idx];
        const fileName = docPath.split('/').pop().replace(/\.md$/, '');
        let stat = m.get(docPath);
        if (!stat) { stat = { path: docPath, fileName, views: 0 }; m.set(docPath, stat); }
        stat.views++;
      }
    });
  }

  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;
    const filePath = path.join(LOG_DIR, file);
    try {
      const stats = await fs.promises.stat(filePath);
      if (stats.mtimeMs < maxCutoff - (24 * 60 * 60 * 1000)) continue;

      const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
      const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

      for await (const line of rl) {
        if (!line.trim()) continue;
        try { processHotEntry(JSON.parse(line)); } catch (_) {}
      }
    } catch (_) {}
  }

  // Also scan in-memory buffer (safely deduplicated by seenHotIds)
  for (const item of systemLogBuffer) {
    processHotEntry(item);
  }

  // Merge: 7d top5 -> 30d top5 -> 90d top5, deduplicated
  const seen = new Set();
  const result = [];
  for (let idx = 0; idx < windows.length; idx++) {
    const top5 = Array.from(windowMaps[idx].values())
      .sort((a, b) => b.views - a.views)
      .slice(0, 5);
    for (const item of top5) {
      if (!seen.has(item.path)) {
        seen.add(item.path);
        result.push({ path: item.path, fileName: item.fileName, views: item.views, source: `${windows[idx]}d` });
      }
    }
  }
  hotListCache = result;
  hotListCacheTime = now;
  hotListCacheKey = cacheKey;
  return result;
}

// ── §18 Daily Words & Suggest List ───────────────────────────────────────
let dailyWordCache = null;

function invalidateDailyWordCache() {
  dailyWordCache = null;
}
// Note: mulberry32 is imported from lib/utils.js


async function getDailyWords() {
  const sl = config.settings.suggestList || {};
  // Condition 1: suggestList must be enabled
  if (sl.enabled === false) return [];
  // Condition 2: dictionaryEnabled must be true with a valid dictionaryPath
  if (!config.settings.dictionaryEnabled) return [];
  const root = getDictionaryPath();
  if (!root) return [];

  const rawCount = parseInt(sl.dailyWordCount, 10);
  const count = Number.isFinite(rawCount) ? Math.max(0, Math.min(20, rawCount)) : 3;
  if (count <= 0) return [];

  const rotateHour = Math.max(1, Math.min(168, parseInt(sl.dailyWordRotateHour) || 12));
  const slotMs = rotateHour * 3600 * 1000;
  const currentSlot = Math.floor(Date.now() / slotMs);

  const selectedDicts = Array.isArray(sl.dailyWordDicts) ? sl.dailyWordDicts.filter(Boolean) : [];
  const cacheKey = `${currentSlot}_${count}_${rotateHour}_${selectedDicts.slice().sort().join(',')}`;

  if (dailyWordCache && dailyWordCache.cacheKey === cacheKey) {
    return dailyWordCache.items;
  }

  const allDictFiles = await scanDictFiles();
  if (!allDictFiles || allDictFiles.length === 0) return [];

  // Filter dictionary files based on selectedDicts
  let targetFiles = allDictFiles;
  if (selectedDicts.length > 0) {
    const selectedSet = new Set(selectedDicts);
    targetFiles = allDictFiles.filter(f =>
      selectedSet.has(f.name) ||
      selectedSet.has(f.name.replace(/\.md$/, '')) ||
      selectedSet.has(f.relPath)
    );
  }

  if (targetFiles.length === 0) {
    dailyWordCache = { cacheKey, items: [] };
    return [];
  }

  targetFiles.sort((a, b) => a.relPath.localeCompare(b.relPath));

  // Load section index for each target file
  const dictCandidates = [];
  for (const f of targetFiles) {
    let stat = null;
    try { stat = await fs.promises.stat(f.fullPath); } catch (_) {}
    if (!stat) continue;
    let idx = null;
    try {
      idx = await getSectionIndex(f.fullPath, stat, f.relPath);
    } catch (_) {}
    if (idx && idx.entries && idx.entries.length > 0) {
      const validEntries = [];
      for (const e of idx.entries) {
        const hw = cleanHeadword(e.headword);
        if (hw && hw.length > 0) {
          validEntries.push({ headword: hw, lineStart: e.lineStart });
        }
      }
      if (validEntries.length > 0) {
        dictCandidates.push({
          relPath: f.relPath,
          name: f.name.replace(/\.md$/, ''),
          entries: validEntries
        });
      }
    }
  }

  if (dictCandidates.length === 0) {
    dailyWordCache = { cacheKey, items: [] };
    return [];
  }

  // Deterministic Mulberry32 seeded by currentSlot
  const seed = ((currentSlot * 1664525 + 1013904223) ^ 0x5deece66) >>> 0;
  const rng = mulberry32(seed);

  const pickedWords = new Set();
  const result = [];
  const maxAttempts = count * 30;
  let attempts = 0;

  // Rotate starting dictionary deterministically
  let dictIdx = Math.floor(rng() * dictCandidates.length);

  while (result.length < count && attempts < maxAttempts) {
    attempts++;
    const dict = dictCandidates[dictIdx % dictCandidates.length];
    dictIdx++;

    const entryIdx = Math.floor(rng() * dict.entries.length);
    const entry = dict.entries[entryIdx];
    if (!pickedWords.has(entry.headword)) {
      pickedWords.add(entry.headword);
      result.push({
        path: dict.relPath,
        fileName: entry.headword,
        dictName: dict.name,
        line: entry.lineStart,
        type: 'dict'
      });
    }
  }

  dailyWordCache = { cacheKey, items: result };
  return result;
}

/**
 * 傳回首頁推薦列表（GET /api/suggest-list），包含公告資訊與推薦項目。
 *
 * 推薦項目組成（依後台設定的數量交錯排列）：
 *   - 管理員手選清單（adminList，從後台設定讀取）
 *   - 熱門閱讀（buildHotList，依 analytics 統計）
 *   - 辭典每日推薦詞（getDailyWords，按 Mulberry32 輪換）
 *
 * 關鍵設計：排序使用 Mulberry32 確定性 RNG，以 currentSlot（當前輪換槽）為種子。
 * 同一輪換視窗內（如 12 小時）的所有請求產生相同排序，避免前端簽章漂移
 * 導致公告彈窗誤觸發。
 *
 * @param {http.IncomingMessage} req - HTTP 請求物件
 * @param {http.ServerResponse}  res - HTTP 回應物件
 */
async function handleSuggestList(req, res) {
  try {
    const sl = config.settings.suggestList || {};
    const adminList = Array.isArray(sl.adminList) ? sl.adminList : [];
    const parsedAdminPick = parseInt(sl.adminPickCount, 10);
    const adminPickCount = Number.isFinite(parsedAdminPick) ? Math.max(0, Math.min(20, parsedAdminPick)) : 3;
    const parsedHotPick = parseInt(sl.hotPickCount, 10);
    const hotPickCount = Number.isFinite(parsedHotPick) ? Math.max(0, Math.min(20, parsedHotPick)) : 5;
    const blackList = Array.isArray(sl.blackList) ? sl.blackList : [];
    const isBlacklisted = createBlacklistChecker(blackList);

    // Rotation slot calculations: guarantees stability within the same rotation slot
    const rotateHour = Math.max(1, Math.min(168, parseInt(sl.dailyWordRotateHour, 10) || 12));
    const slotMs = rotateHour * 3600 * 1000;
    const currentSlot = Math.floor(Date.now() / slotMs);

    // Admin picks: filter blacklist then shuffle deterministically by currentSlot and pick adminPickCount
    const validAdmin = adminList
      .map(p => p.replace(/\\/g, '/').split('/').map(s => s.trim()).filter(Boolean).join('/'))
      .filter(p => p && !isBlacklisted(p));
    // Deterministic shuffle for admin list using Mulberry32 seeded by currentSlot
    const adminRng = mulberry32(((currentSlot * 2654435761) ^ 0xdeadbeef) >>> 0);
    const shuffledAdmin = [...validAdmin];
    for (let i = shuffledAdmin.length - 1; i > 0; i--) {
      const j = Math.floor(adminRng() * (i + 1));
      [shuffledAdmin[i], shuffledAdmin[j]] = [shuffledAdmin[j], shuffledAdmin[i]];
    }
    const adminPicks = shuffledAdmin.slice(0, adminPickCount).map(p => {
      const cleanNoExt = p.replace(/\.md$/i, '').trim();
      const fileName = cleanNoExt.split('/').pop().trim();
      return {
        path: p,
        fileName: fileName || p,
        type: 'admin'
      };
    });

    // Hot picks: from log analysis
    const hotRaw = await buildHotList(blackList);
    const normalizePath = p => (p || '').replace(/\\/g, '/').replace(/\.md$/i, '').trim().toLowerCase();
    const adminPathSet = new Set(adminPicks.map(a => normalizePath(a.path)));
    const hotPicks = hotRaw
      .filter(h => !adminPathSet.has(normalizePath(h.path)))
      .slice(0, hotPickCount)
      .map(h => ({ path: h.path, fileName: h.fileName, type: 'hot', source: h.source }));

    // Daily word picks: from installed dictionaries
    const dailyWordPicks = await getDailyWords();

    const items = [...adminPicks, ...hotPicks, ...dailyWordPicks];
    // Deterministically shuffle combined items using currentSlot so admin, hot picks and daily words interleave stably
    const interleaveRng = mulberry32(((currentSlot * 1103515245 + 12345) ^ 0x12345678) >>> 0);
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(interleaveRng() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    sendJSON(res, 200, {
      items,
      adminPickCount,
      hotPickCount,
      dailyWordCount: dailyWordPicks.length,
      enabled: sl.enabled !== false,
      suggestListUpdatedAt: config.settings.suggestListUpdatedAt || 0,
      announcement: {
        enabled: !!config.settings.enableAnnouncement,
        message: config.settings.announcementMessage || '',
        updatedAt: config.settings.announcementUpdatedAt || 0
      }
    });
  } catch (err) {
    Logger.error('Suggest', 'Failed to build suggestion list', err, req);
    sendJSON(res, 500, { error: 'Failed to load suggestions' });
  }
}

async function getDockerMemoryLimit() {
  try {
    const raw = await fs.promises.readFile('/sys/fs/cgroup/memory.max', 'utf-8');
    const val = raw.trim();
    if (val && val !== 'max') {
      const bytes = parseInt(val, 10);
      if (Number.isFinite(bytes) && bytes > 0) return bytes;
    }
  } catch (_) {}

  try {
    const raw = await fs.promises.readFile('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf-8');
    const val = raw.trim();
    if (val) {
      const bytes = parseInt(val, 10);
      if (Number.isFinite(bytes) && bytes > 0 && bytes < 9007199254740991) return bytes;
    }
  } catch (_) {}

  return os.totalmem();
}

async function getDirSizeAsync(dirPath) {
  let size = 0;
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        size += await getDirSizeAsync(full);
      } else if (entry.isFile()) {
        const s = await fs.promises.stat(full).catch(() => null);
        if (s) size += s.size;
      }
    }
  } catch (_) {}
  return size;
}

let lastCpuTimes = null;

function getCpuUsagePct() {
  const cpus = os.cpus();
  if (!cpus || cpus.length === 0) return 0;
  let totalIdle = 0;
  let totalTick = 0;
  for (const cpu of cpus) {
    for (const type in cpu.times) {
      totalTick += cpu.times[type];
    }
    totalIdle += cpu.times.idle;
  }
  if (!lastCpuTimes) {
    lastCpuTimes = { idle: totalIdle, total: totalTick };
    return 0;
  }
  const idleDelta = totalIdle - lastCpuTimes.idle;
  const totalDelta = totalTick - lastCpuTimes.total;
  lastCpuTimes = { idle: totalIdle, total: totalTick };
  if (totalDelta <= 0) return 0;
  const usedPct = 100 - (idleDelta / totalDelta) * 100;
  return parseFloat(Math.min(100, Math.max(0, usedPct)).toFixed(1));
}

function isDockerContainer() {
  try {
    if (fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv')) return true;
    if (fs.existsSync('/proc/1/cgroup')) {
      const content = fs.readFileSync('/proc/1/cgroup', 'utf-8');
      if (content.includes('docker') || content.includes('containerd') || content.includes('kubepods')) return true;
    }
  } catch (_) {}
  return false;
}

// ── §19 System Hardware Stats & Monitor ───────────────────────
async function getSystemHardwareStats() {
  const cpus = os.cpus() || [];
  const loadAvg = os.loadavg() || [0, 0, 0];
  const containerMemLimit = await getDockerMemoryLimit();
  const processMem = process.memoryUsage();
  const cpuUsagePct = getCpuUsagePct();
  const isDocker = isDockerContainer();

  let storageStats = { total: 0, free: 0, available: 0, used: 0, usagePct: 0 };
  try {
    const sf = await fs.promises.statfs(getMdRoot());
    const total = sf.blocks * sf.bsize;
    const free = sf.bfree * sf.bsize;
    const avail = sf.bavail * sf.bsize;
    const used = total - free;
    storageStats = {
      total,
      free,
      available: avail,
      used,
      usagePct: total > 0 ? parseFloat(((used / total) * 100).toFixed(1)) : 0
    };
  } catch (_) {}

  let cacheSize = 0;
  try {
    if (fs.existsSync(SEARCH_INDEX_CACHE_BIN)) {
      cacheSize = fs.statSync(SEARCH_INDEX_CACHE_BIN).size;
    } else if (fs.existsSync(SEARCH_INDEX_CACHE_FILE)) {
      cacheSize = fs.statSync(SEARCH_INDEX_CACHE_FILE).size;
    }
  } catch (_) {}

  let analyticsStoreSize = 0;
  try { analyticsStoreSize = (await fs.promises.stat(ANALYTICS_STORE_PATH)).size; } catch (_) {}
  const logsDirSize = await getDirSizeAsync(LOG_DIR);

  let indexFileMtime = searchIndex.createdAt || null;
  try {
    if (fs.existsSync(SEARCH_INDEX_CACHE_BIN)) {
      const stat = fs.statSync(SEARCH_INDEX_CACHE_BIN);
      indexFileMtime = stat.mtime ? stat.mtime.toISOString() : (stat.birthtime ? stat.birthtime.toISOString() : indexFileMtime);
    } else if (fs.existsSync(SEARCH_INDEX_CACHE_FILE)) {
      const stat = fs.statSync(SEARCH_INDEX_CACHE_FILE);
      indexFileMtime = stat.mtime ? stat.mtime.toISOString() : (stat.birthtime ? stat.birthtime.toISOString() : indexFileMtime);
    }
  } catch (err) {
    Logger.error('Hardware', 'Failed to stat search index cache file', err);
  }

  if (indexFileMtime) {
    searchIndex.createdAt = indexFileMtime;
  }

  let dictCacheSize = 0;
  let dictIndexFileMtime = dictIndex.createdAt || null;
  try {
    if (fs.existsSync(DICT_INDEX_CACHE_BIN)) {
      const stat = fs.statSync(DICT_INDEX_CACHE_BIN);
      dictCacheSize = stat.size;
      dictIndexFileMtime = stat.mtime ? stat.mtime.toISOString() : (stat.birthtime ? stat.birthtime.toISOString() : dictIndexFileMtime);
    }
  } catch (err) {
    Logger.error('Hardware', 'Failed to stat dictionary index cache file', err);
  }
  if (dictIndexFileMtime) {
    dictIndex.createdAt = dictIndexFileMtime;
  }

  const now = Date.now();
  const cutoff = now - 60000;
  httpMetrics.recentRequestTimes = httpMetrics.recentRequestTimes.filter(t => t >= cutoff);
  const requestsPerMin = httpMetrics.recentRequestTimes.length;
  const avgResponseTimeMs = httpMetrics.totalRequests > 0 ? parseFloat((httpMetrics.totalResponseTimeMs / httpMetrics.totalRequests).toFixed(1)) : 0;
  
  let activeSessions = 0;
  for (const [_, session] of sessions.entries()) {
    if (session && session.expiry > now) {
      activeSessions++;
    }
  }

  const totalSearchQueries = searchMetrics.totalQueries;
  const searchCacheHits = searchMetrics.cacheHits;
  const searchCacheMisses = searchMetrics.cacheMisses;
  const hitRatePct = totalSearchQueries > 0 ? parseFloat(((searchCacheHits / totalSearchQueries) * 100).toFixed(1)) : 0;
  const avgSearchTimeMs = searchCacheMisses > 0 ? parseFloat((searchMetrics.totalSearchTimeMs / searchCacheMisses).toFixed(1)) : 0;
  const vaultTotalSizeBytes = searchIndex.fileList ? searchIndex.fileList.reduce((acc, f) => acc + (f.size || 0), 0) : 0;

  return {
    timestamp: new Date().toISOString(),
    system: {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      isDocker,
      sysUptime: Math.floor(os.uptime()),
      processUptime: Math.floor(process.uptime())
    },
    cpu: {
      model: cpus.length > 0 ? cpus[0].model : 'Unknown CPU',
      cores: cpus.length,
      usagePct: cpuUsagePct,
      loadAvg: [
        parseFloat(loadAvg[0].toFixed(2)),
        parseFloat(loadAvg[1].toFixed(2)),
        parseFloat(loadAvg[2].toFixed(2))
      ]
    },
    memory: {
      containerLimit: containerMemLimit,
      hostTotal: os.totalmem(),
      hostFree: os.freemem(),
      rss: processMem.rss,
      heapTotal: processMem.heapTotal,
      heapUsed: processMem.heapUsed,
      external: processMem.external,
      arrayBuffers: processMem.arrayBuffers,
      rssUsagePct: parseFloat(((processMem.rss / containerMemLimit) * 100).toFixed(1)),
      heapUsagePct: parseFloat(((processMem.heapUsed / processMem.heapTotal) * 100).toFixed(1))
    },
    storage: {
      vaultPath: getMdRoot(),
      vaultFs: storageStats,
      cacheSizeBytes: cacheSize,
      analyticsStoreSizeBytes: analyticsStoreSize,
      logsDirSizeBytes: logsDirSize
    },
    index: {
      ready: searchIndex.ready,
      building: searchIndex.building,
      totalFiles: searchIndex.fileList ? searchIndex.fileList.length : 0,
      totalUnits: searchIndex.units ? searchIndex.units.length : 0,
      uniqueBigrams: searchIndex.bigrams ? searchIndex.bigrams.size : 0,
      cacheSizeBytes: cacheSize,
      vaultSig: searchIndex.vaultSig || '',
      createdAt: indexFileMtime,
      lastModified: indexFileMtime
    },
    dictIndex: {
      enabled: config.settings.dictionaryEnabled === true,
      ready: dictIndex.ready,
      building: dictIndex.building,
      totalFiles: dictIndex.fileList ? dictIndex.fileList.length : 0,
      totalUnits: dictIndex.units ? dictIndex.units.length : 0,
      uniqueBigrams: dictIndex.bigrams ? dictIndex.bigrams.size : 0,
      cacheSizeBytes: dictCacheSize,
      createdAt: dictIndexFileMtime,
      lastModified: dictIndexFileMtime
    },
    search: {
      totalQueries: totalSearchQueries,
      cacheHits: searchCacheHits,
      cacheMisses: searchCacheMisses,
      hitRatePct: hitRatePct,
      avgSearchTimeMs: avgSearchTimeMs,
      lastSearchTimeMs: searchMetrics.lastSearchTimeMs,
      cacheEntries: searchCache.size,
      vaultTotalSizeBytes: vaultTotalSizeBytes
    },
    network: {
      totalRequests: httpMetrics.totalRequests,
      requestsPerMin: requestsPerMin,
      avgResponseTimeMs: avgResponseTimeMs,
      activeSessions: activeSessions
    },
    workers: {
      renderCount: workerPool.length,
      renderIdle: workerPool.filter(w => w.idle).length,
      indexCount: indexWorkerPool.length,
      indexIdle: indexWorkerPool.filter(w => w.idle).length,
      count: workerPool.length + indexWorkerPool.length,
      idle: workerPool.filter(w => w.idle).length + indexWorkerPool.filter(w => w.idle).length
    }
  };
}

async function handleHardwareStats(req, res) {
  if (!isAuthenticated(req)) {
    return sendJSON(res, 401, { error: 'Unauthorized' });
  }
  try {
    const stats = await getSystemHardwareStats();
    return sendJSON(res, 200, stats);
  } catch (err) {
    return sendJSON(res, 500, { error: err.message });
  }
}

async function handleRebuildIndex(req, res) {
  if (!isAuthenticated(req)) {
    return sendJSON(res, 401, { error: 'Unauthorized' });
  }
  try {
    searchCache.clear();
    invalidateSectionIndexes();
    buildSearchIndexAsync(true).catch(err => {
      Logger.error('Index', 'Manual index rebuild error', err);
    });
    return sendJSON(res, 200, { success: true, message: 'Index rebuild initiated' });
  } catch (err) {
    return sendJSON(res, 500, { error: err.message });
  }
}

async function handleRebuildDictIndex(req, res) {
  if (!isAuthenticated(req)) {
    return sendJSON(res, 401, { error: 'Unauthorized' });
  }
  try {
    buildDictIndexAsync(true).catch(err => {
      Logger.error('DictIndex', 'Manual dictionary index rebuild error', err);
    });
    return sendJSON(res, 200, { success: true, message: 'Dictionary index rebuild initiated' });
  } catch (err) {
    return sendJSON(res, 500, { error: err.message });
  }
}

async function handleAdminPassword(req, res) {
  if (!isAuthenticated(req)) {
    return sendJSON(res, 401, { error: 'Unauthorized' });
  }
  if (!config.admin) {
    return sendJSON(res, 400, { error: 'Admin is not configured yet' });
  }

  try {
    const data = await readJSONBody(req);
    const { currentPassword, newPassword } = data;
    if (!currentPassword || !newPassword) {
      return sendJSON(res, 400, { error: '請提供目前密碼與新密碼' });
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return sendJSON(res, 400, { error: '新密碼長度至少需為 8 個字元' });
    }

    // Check current password
    const hashedCurrent = await hashPassword(currentPassword, config.admin.salt, 100000).catch(() => null);
    let isCurrentCorrect = hashedCurrent && timingSafeCompare(hashedCurrent.hash, config.admin.passwordHash);
    if (!isCurrentCorrect) {
      // Legacy fallback
      const legacy = await hashPassword(currentPassword, config.admin.salt, 1000).catch(() => null);
      isCurrentCorrect = legacy && timingSafeCompare(legacy.hash, config.admin.passwordHash);
    }
    if (!isCurrentCorrect) {
      return sendJSON(res, 403, { error: '目前密碼不正確' });
    }

    // Generate new salt and hash with 100,000 iterations
    const newCredentials = await hashPassword(newPassword);
    config.admin.passwordHash = newCredentials.hash;
    config.admin.salt = newCredentials.salt;
    saveConfig();

    // Revoke other session tokens, keeping current caller's session valid
    const currentToken = req.headers['x-admin-token'];
    for (const token of sessions.keys()) {
      if (token !== currentToken) {
        sessions.delete(token);
      }
    }

    Logger.info('Admin', `Admin password changed successfully from ${getClientIP(req)}`, null, req);
    return sendJSON(res, 200, { success: true, message: '管理員密碼已成功更新，已登出其他裝置。' });
  } catch (err) {
    return sendJSON(res, 500, { error: err.message });
  }
}

async function handleAdminDiagnosePath(req, res) {
  if (!isAuthenticated(req)) {
    return sendJSON(res, 401, { error: 'Unauthorized' });
  }

  try {
    const data = await readJSONBody(req);
    const { targetPath, type } = data; // type: 'vault' | 'dict'
    if (!targetPath || typeof targetPath !== 'string') {
      return sendJSON(res, 400, { error: '請提供要檢測的路徑' });
    }

    const resolved = path.resolve(targetPath.trim());
    if (!fs.existsSync(resolved)) {
      return sendJSON(res, 200, {
        exists: false,
        path: resolved,
        error: '該路徑不存在。請確認路徑或 Docker 卷是否已正確掛載。'
      });
    }

    const stats = fs.statSync(resolved);
    if (!stats.isDirectory()) {
      return sendJSON(res, 200, {
        exists: true,
        isDir: false,
        path: resolved,
        error: '該路徑存在但不是目錄（為一般檔案）。'
      });
    }

    // Check readability
    try {
      fs.accessSync(resolved, fs.constants.R_OK);
    } catch (e) {
      return sendJSON(res, 200, {
        exists: true,
        isDir: true,
        readable: false,
        path: resolved,
        error: '該目錄無讀取權限 (Permission Denied)。'
      });
    }

    let writable = true;
    try {
      fs.accessSync(resolved, fs.constants.W_OK);
    } catch (_) {
      writable = false;
    }

    let filesCount = 0;
    let sampleNames = [];
    if (type === 'dict') {
      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      const dictFiles = entries.filter(e => e.isFile() && !e.name.startsWith('.'));
      filesCount = dictFiles.length;
      sampleNames = dictFiles.slice(0, 8).map(e => e.name);
    } else {
      // type === 'vault': count markdown files quickly
      const stack = [resolved];
      while (stack.length > 0 && filesCount < 50000) {
        const cur = stack.pop();
        try {
          const entries = fs.readdirSync(cur, { withFileTypes: true });
          for (const ent of entries) {
            if (ent.name.startsWith('.')) continue;
            if (ent.isDirectory()) {
              stack.push(path.join(cur, ent.name));
            } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
              filesCount++;
              if (sampleNames.length < 5) sampleNames.push(ent.name);
            }
          }
        } catch (_) {}
      }
    }

    return sendJSON(res, 200, {
      exists: true,
      isDir: true,
      readable: true,
      writable,
      path: resolved,
      count: filesCount,
      sampleNames,
      type: type || 'vault'
    });
  } catch (err) {
    return sendJSON(res, 500, { error: err.message });
  }
}

async function handleAdminRebuildSitemap(req, res) {
  if (!isAuthenticated(req)) {
    return sendJSON(res, 401, { error: 'Unauthorized' });
  }

  try {
    const t0 = Date.now();
    cachedTree = null; // 強制重新掃描保管庫目錄樹
    const baseUrl = getBaseUrl(req);
    const { xml, totalUrls } = await generateSitemapXml(baseUrl);
    cachedSitemapXml = xml;
    sitemapDirty = false;

    const durationMs = Date.now() - t0;
    Logger.info('SEO', `Sitemap rebuilt: ${totalUrls} URLs generated in ${durationMs}ms`, null, req);

    return sendJSON(res, 200, {
      success: true,
      totalUrls,
      durationMs,
      sitemapUrl: `${baseUrl}/sitemap.xml`
    });
  } catch (err) {
    return sendJSON(res, 500, { error: err.message });
  }
}

function handleAdminClearCache(req, res) {
  if (!isAuthenticated(req)) {
    return sendJSON(res, 401, { error: 'Unauthorized' });
  }

  const staticCount = staticCache.size;
  const searchCount = searchCache.size;
  staticCache.clear();
  searchCache.clear();
  cachedSitemapXml = null;
  cachedTree = null;
  sitemapDirty = true;

  Logger.info('Admin', `In-memory caches cleared: ${staticCount} static entries, ${searchCount} search entries`, null, req);
  return sendJSON(res, 200, {
    success: true,
    staticCount,
    searchCount,
    message: `已清空 ${staticCount} 個靜態資源快取、${searchCount} 筆搜尋快取與 Sitemap 快取。`
  });
}

/**
 * 傳回已聚合的 Analytics 統計資料（GET /api/admin/analytics?range=...&tz=...）。
 * 需要後台認證（isAuthenticated）。
 *
 * @param {http.IncomingMessage} req   - HTTP 請求物件
 * @param {http.ServerResponse}  res   - HTTP 回應物件
 * @param {Object}               query - 查詢參數：range（7d/30d/90d，預設 30d）、tz（時區）
 */
async function handleAnalytics(req, res, query) {
  if (!isAuthenticated(req)) {
    return sendJSON(res, 401, { error: 'Unauthorized' });
  }

  try {
    const data = await getAnalyticsData(parseAnalyticsRange(query.range), query.tz || 'auto');
    return sendJSON(res, 200, data);
  } catch (err) {
    return sendJSON(res, 400, { error: err.message });
  }
}

async function handleAnalyticsExport(req, res, query) {
  if (!verifySameOrigin(req)) {
    return sendJSON(res, 403, { error: 'Forbidden: Cross-origin request blocked' });
  }

  const token = query.token || req.headers['x-admin-token'];
  let authorized = isAuthenticated(req);
  if (!authorized && token && sessions.has(token)) {
    const session = sessions.get(token);
    if (session && Date.now() < session.expiry) {
      authorized = true;
    }
  }
  if (!authorized) {
    return sendJSON(res, 401, { error: 'Unauthorized' });
  }

  const format = query.format === 'csv' ? 'csv' : 'json';
  let rangeKey;
  try { rangeKey = parseAnalyticsRange(query.range); } catch (err) { return sendJSON(res, 400, { error: err.message }); }
  const data = await getAnalyticsData(rangeKey, query.tz || 'auto');

  if (format === 'csv') {
    const tz = query.tz || 'auto';
    const formatTime = (ts) => {
      if (!ts) return '';
      try {
        const d = new Date(ts);
        if (Number.isNaN(d.getTime())) return String(ts);
        const timeZone = (tz && tz !== 'auto') ? tz : 'UTC';
        return new Intl.DateTimeFormat('zh-TW', {
          timeZone,
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit',
          hour12: false
        }).format(d).replace(/\//g, '-');
      } catch (_) {
        return String(ts);
      }
    };

    let csv = '\uFEFF';
    // 1. Report Metadata & Summary
    csv += `[數據分析報表 - mdWebview]\n`;
    csv += `時間範圍,${rangeKey},統計時區,${tz},報表生成時間,${formatTime(new Date())}\n\n`;

    csv += `[數據摘要]\n`;
    csv += `指標項目,數值\n`;
    csv += `總閱讀點閱數 (PV),${data.summary.totalViews || 0}\n`;
    csv += `獨立訪客數 (UV),${data.summary.uniqueIps || 0}\n`;
    csv += `搜尋總次數,${data.summary.totalSearches || 0}\n`;
    csv += `活躍文章數,${data.summary.activeFiles || 0}\n`;
    const avgViews = (data.summary.activeFiles > 0) ? (data.summary.totalViews / data.summary.activeFiles).toFixed(1) : '0';
    csv += `平均每篇點閱數,${avgViews}\n`;
    csv += `辭典搜尋次數,${data.summary.dictSearches || 0}\n`;
    csv += `辭典查閱詞條數,${data.summary.dictLookups || 0}\n\n`;

    // 2. Top Files
    csv += `[熱門閱讀經論排行 (Top ${data.topFiles.length})]\n`;
    csv += '排名,文章標題/檔名,文章路徑,總點閱數,獨立IP數,最後閱讀時間\n';
    data.topFiles.forEach((f, idx) => {
      csv += `${idx + 1},${sanitizeCsvField(f.fileName)},${sanitizeCsvField(f.path)},${f.views || 0},${f.uniqueIps || 0},${sanitizeCsvField(formatTime(f.lastAccess))}\n`;
    });
    csv += '\n';

    // 3. Top Searches
    if (data.topSearches && data.topSearches.length > 0) {
      csv += `[熱門全文搜尋關鍵字 (Top ${data.topSearches.length})]\n`;
      csv += '排名,搜尋關鍵字,搜尋次數,最後搜尋時間\n';
      data.topSearches.forEach((s, idx) => {
        csv += `${idx + 1},${sanitizeCsvField(s.query)},${s.count || 0},${sanitizeCsvField(formatTime(s.lastSearch))}\n`;
      });
      csv += '\n';
    }

    // 4. Top Dict Lookups
    if (data.topLookups && data.topLookups.length > 0) {
      csv += `[熱門辭典查閱詞條 (Top ${data.topLookups.length})]\n`;
      csv += '排名,查閱詞條,所屬辭典,查閱次數,最後查閱時間\n';
      data.topLookups.forEach((l, idx) => {
        csv += `${idx + 1},${sanitizeCsvField(l.headword)},${sanitizeCsvField(l.fileName || l.path)},${l.count || 0},${sanitizeCsvField(formatTime(l.lastLookup))}\n`;
      });
      csv += '\n';
    }

    // 5. Top Dict Searches
    if (data.topDictSearches && data.topDictSearches.length > 0) {
      csv += `[熱門辭典搜尋關鍵字 (Top ${data.topDictSearches.length})]\n`;
      csv += '排名,辭典關鍵字,搜尋次數,最後搜尋時間\n';
      data.topDictSearches.forEach((s, idx) => {
        csv += `${idx + 1},${sanitizeCsvField(s.query)},${s.count || 0},${sanitizeCsvField(formatTime(s.lastSearch))}\n`;
      });
      csv += '\n';
    }

    // 6. Top IPs
    if (data.ipDistribution && data.ipDistribution.length > 0) {
      csv += `[訪客來源 IP 分佈 (Top ${data.ipDistribution.length})]\n`;
      csv += '排名,IP 地址,請求次數,最後訪問時間\n';
      data.ipDistribution.forEach((ip, idx) => {
        csv += `${idx + 1},${sanitizeCsvField(ip.ip)},${ip.requests || 0},${sanitizeCsvField(formatTime(ip.lastAccess))}\n`;
      });
    }

    res.writeHead(200, Object.assign({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="analytics-report-${rangeKey}.csv"`
    }, SECURITY_HEADERS));
    return res.end(csv);
  } else {
    res.writeHead(200, Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="analytics-report-${rangeKey}.json"`
    }, SECURITY_HEADERS));
    return res.end(JSON.stringify(data, null, 2));
  }
}

// ── §20 HTTP Server & Main Request Router ────────────────────
const server = http.createServer((req, res) => {
  const reqStart = Date.now();
  res.reqHeadersAcceptEncoding = req.headers['accept-encoding'] || '';

  let parsed;
  try {
    const rawHost = req.headers.host || 'localhost';
    parsed = new URL(req.url, `http://${rawHost}`);
  } catch (_) {
    res.writeHead(400, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, SECURITY_HEADERS));
    return res.end('Bad Request: Invalid URL or Host header');
  }

  try {
    const pathname = parsed.pathname;
    const query = Object.fromEntries(parsed.searchParams);
    // Redact any ?token= session token so it never reaches the HTTP access log.
    const logSearch = parsed.search ? parsed.search.replace(/([?&]token=)[^&]*/gi, '$1[REDACTED]') : '';

  // HTTP Access Logging Middleware
  const origEnd = res.end;
  res.end = function(...args) {
    origEnd.apply(res, args);
    const duration = Date.now() - reqStart;
    const now = Date.now();

    httpMetrics.totalRequests++;
    httpMetrics.totalResponseTimeMs += duration;
    httpMetrics.recentRequestTimes.push(now);
    if (httpMetrics.recentRequestTimes.length > MAX_RECENT_REQUEST_TIMES) {
      httpMetrics.recentRequestTimes.splice(0, httpMetrics.recentRequestTimes.length - MAX_RECENT_REQUEST_TIMES);
    }

    const isSpecialTagRoute = pathname === '/api/search' || pathname === '/api/search-file' || pathname === '/api/render';
    if (!isSpecialTagRoute && (pathname.startsWith('/api/') || pathname.startsWith('/admin/') || res.statusCode >= 400 || duration > 50)) {
      Logger.info('HTTP', `${req.method} ${pathname}${logSearch || ''} -> ${res.statusCode} (${duration}ms)`, req, { durationMs: duration });
    } else {
      Logger.debug('HTTP', `${req.method} ${pathname} -> ${res.statusCode} (${duration}ms)`, req, { durationMs: duration });
    }
  };

  // Log share link access if present, and handle Crawler Dynamic SSR for Homepage or Specific Markdown File
  if (pathname === '/' || pathname === '') {
    const isBot = isCrawlerRequest(req, query);
    const botName = getCrawlerName(req, query);
    if (query.file) {
      Logger.info('ShareLink', `Access file: "${query.file}" at line: ${query.line || 'none'}${isBot ? ` [Bot: ${botName}]` : ''}`, req, { path: query.file, isBot, bot: botName, queryObj: query });
      if (isBot && (req.method === 'GET' || req.method === 'HEAD')) {
        return handleCrawlerSsr(req, res, query.file, query);
      }
    } else if (isBot && (req.method === 'GET' || req.method === 'HEAD')) {
      Logger.info('Crawler', `Homepage access from bot: ${botName}`, req, { isBot, bot: botName, queryObj: query });
      return handleCrawlerSsr(req, res, null, query);
    }
  }

  // Global API Rate Limiting Check (30 req/sec max)
  if (pathname.startsWith('/api/')) {
    if (!checkApiRateLimit(req, res, (ip, count) => {
      Logger.warn('RateLimit', `API rate limit exceeded (${count} req/s) for IP: ${ip}`, req);
    })) {
      res.writeHead(429, Object.assign({
        'Content-Type': 'application/json; charset=utf-8',
        'Retry-After': '1'
      }, SECURITY_HEADERS));
      res.end(JSON.stringify({ error: 'Too Many Requests', retryAfter: 1 }));
      return;
    }
  }

  // SEO & PWA routes
  if (pathname === '/robots.txt' && (req.method === 'GET' || req.method === 'HEAD')) {
    return handleRobotsTxt(req, res);
  }
  if (pathname === '/sitemap.xml' && (req.method === 'GET' || req.method === 'HEAD')) {
    return handleSitemapXml(req, res);
  }
  if (pathname === '/manifest.json' && (req.method === 'GET' || req.method === 'HEAD')) {
    return handleManifestJson(req, res);
  }

  // API routes
  if (pathname === '/api/tree' && req.method === 'GET') {
    return handleTree(req, res);
  }
  if (pathname === '/api/file' && req.method === 'GET') {
    return handleFile(req, res, query);
  }
  if (pathname === '/api/media' && (req.method === 'GET' || req.method === 'HEAD')) {
    return handleMedia(req, res, query);
  }
  if (pathname === '/api/render' && req.method === 'GET') {
    return handleRender(req, res, query);
  }
  if (pathname === '/api/section-index' && req.method === 'GET') {
    return handleSectionIndex(req, res, query);
  }
  if (pathname === '/api/render-chunk' && req.method === 'GET') {
    return handleRenderChunk(req, res, query);
  }
  if (pathname === '/api/search' && req.method === 'GET') {
    return handleSearch(req, res, query);
  }
  if (pathname === '/api/search-file' && req.method === 'GET') {
    return handleSearchFile(req, res, query);
  }
  if (pathname === '/api/dict-headwords' && req.method === 'GET') {
    return handleDictHeadwords(req, res);
  }
  if (pathname === '/api/dict-search' && req.method === 'GET') {
    return handleDictSearch(req, res, query);
  }
  if (pathname === '/api/dict-event' && req.method === 'POST') {
    return handleDictEvent(req, res);
  }
  if (pathname === '/api/dict-files' && req.method === 'GET') {
    return handleDictFiles(req, res);
  }

  // Admin API routes
  if (pathname === '/api/admin/status' && req.method === 'GET') {
    // Redact the absolute vault path (and any other filesystem-layout detail) from
    // the anonymous status payload — it is a useful recon primitive for traversal.
    const safeSettings = Object.assign({}, config.settings);
    delete safeSettings.mdRoot;
    delete safeSettings.dictionaryPath;
    return sendJSON(res, 200, {
      isSetup: !!config.admin,
      isAuthenticated: isAuthenticated(req),
      settings: safeSettings
    });
  }
  if (pathname === '/api/admin/analytics' && req.method === 'GET') {
    return handleAnalytics(req, res, query);
  }
  if (pathname === '/api/admin/analytics/export' && req.method === 'GET') {
    return handleAnalyticsExport(req, res, query);
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
    // Scheme A: First-run admin creation allows remote setup upon initial deployment.
    // Once configured, config.admin is persisted to disk and /api/admin/setup is permanently disabled.
    return readJSONBody(req).then(data => {
      const { username, password } = data;
      const siteUrl = (data.siteUrl || data.settingsSiteUrl || '').trim();
      if (!username || !password || username.trim() === '' || password.trim() === '') {
        return sendJSON(res, 400, { error: 'Username and password are required' });
      }
      if (!siteUrl) {
        return sendJSON(res, 400, { error: '首頁權威 URL (Canonical URL) 為必填項目' });
      }
      const cleanSiteUrl = siteUrl.replace(/\/+$/, '');
      if (!/^https?:\/\//i.test(cleanSiteUrl)) {
        return sendJSON(res, 400, { error: '首頁權威 URL 格式不正確，必須以 http:// 或 https:// 開頭' });
      }
      if (password.length < 8) {
        return sendJSON(res, 400, { error: '密碼長度至少需為 8 個字元' });
      }
      return hashPassword(password).then(({ salt, hash }) => {
        config.admin = {
          username: username.trim(),
          passwordHash: hash,
          salt: salt
        };
        config.settings.siteUrl = cleanSiteUrl;
        saveConfig();
        Logger.info('Admin', `Admin account "${username.trim()}" and siteUrl "${cleanSiteUrl}" successfully initialized from ${getClientIP(req)}`, null, req);
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
  if (pathname === '/api/admin/seo-stats' && req.method === 'GET') {
    if (!isAuthenticated(req)) {
      return sendJSON(res, 401, { error: 'Unauthorized' });
    }
    const baseUrl = getBaseUrl(req);
    const files = cachedTree ? flattenMarkdownFiles(cachedTree) : [];
    return sendJSON(res, 200, {
      totalMarkdownFiles: files.length,
      siteUrl: config.settings.siteUrl || '',
      effectiveBaseUrl: baseUrl,
      sitemapUrl: `${baseUrl}/sitemap.xml`,
      robotsUrl: `${baseUrl}/robots.txt`,
      sitemapCached: !!cachedSitemapXml,
      robotsIndex: config.settings.seoRobotsIndex === true,
      blockAiBots: config.settings.seoBlockAiBots !== false
    });
  }
  if (pathname === '/api/admin/settings' && req.method === 'POST') {
    if (!isAuthenticated(req)) {
      return sendJSON(res, 401, { error: 'Unauthorized' });
    }
    return readJSONBody(req).then(data => {
      const {
        mdRoot, defaultFontSize, defaultTheme, siteName, siteUrl, timezone, createIfNotExists,
        enableVersion, version, enableDownload, downloadUrl, suggestList, maxProximityDistance, defaultSearchMode,
        dictionaryEnabled, dictionaryPath, enableAnnouncement, announcementMessage,
        seoSiteDescription, seoKeywords, seoOgImage, seoRobotsIndex, seoBlockAiBots, seoDisallowPaths,
        googleSiteVerification, bingSiteVerification, baiduSiteVerification, seoEnableSearchBox, seoHomepageSummary
      } = data.settings || {};

      // Allow partial settings updates: if mdRoot is omitted, preserve existing config.settings.mdRoot
      if (mdRoot !== undefined && (!mdRoot || mdRoot.trim() === '')) {
        return sendJSON(res, 400, { error: 'Directory path cannot be empty' });
      }

      const resolvedPath = (mdRoot !== undefined)
        ? path.resolve(mdRoot.trim())
        : (config.settings.mdRoot ? path.resolve(config.settings.mdRoot) : '');

      if (!resolvedPath) {
        return sendJSON(res, 400, { error: 'Directory path cannot be empty' });
      }
      const nextDictEnabled = dictionaryEnabled !== undefined ? !!dictionaryEnabled : config.settings.dictionaryEnabled;
      const nextDictPath = (dictionaryPath !== undefined)
        ? (String(dictionaryPath).trim() ? path.resolve(String(dictionaryPath).trim()) : deriveDictRoot(resolvedPath))
        : config.settings.dictionaryPath;

      const updateSettings = () => {
        if (config.settings.mdRoot !== resolvedPath) {
          config.settings.mdRoot = resolvedPath;
          resetTreeWatcher();
        }
        if (defaultFontSize) {
          config.settings.defaultFontSize = Math.max(12, Math.min(32, parseInt(defaultFontSize)));
        }
        if (defaultTheme) {
          config.settings.defaultTheme = defaultTheme;
        }
        if (siteName !== undefined) {
          config.settings.siteName = siteName.trim() || 'mdWebview';
        }
        if (siteUrl !== undefined) {
          config.settings.siteUrl = String(siteUrl).trim().replace(/\/+$/, '');
        }
        if (timezone !== undefined) {
          config.settings.timezone = String(timezone).trim() || 'auto';
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
        if (enableAnnouncement !== undefined) {
          const nextEnabled = (enableAnnouncement === true || enableAnnouncement === 'true' || enableAnnouncement === 1 || enableAnnouncement === '1' || enableAnnouncement === 'on');
          if (config.settings.enableAnnouncement !== nextEnabled) {
            config.settings.enableAnnouncement = nextEnabled;
            config.settings.announcementUpdatedAt = Date.now();
          }
        }
        if (announcementMessage !== undefined) {
          const cleanMsg = String(announcementMessage).trim();
          if (config.settings.announcementMessage !== cleanMsg) {
            config.settings.announcementMessage = cleanMsg;
            config.settings.announcementUpdatedAt = Date.now();
          }
        }
        if (maxProximityDistance !== undefined) {
          const dist = parseInt(maxProximityDistance);
          if (!Number.isNaN(dist)) {
            config.settings.maxProximityDistance = Math.max(10, Math.min(5000, dist));
          }
        }
        if (defaultSearchMode !== undefined) {
          if (defaultSearchMode === 'strict' || defaultSearchMode === 'loose') {
            config.settings.defaultSearchMode = defaultSearchMode;
          }
        }
        if (suggestList !== undefined && typeof suggestList === 'object') {
          const sl = suggestList;
          const existing = config.settings.suggestList || {};
          config.settings.suggestList = {
            adminList: Array.isArray(sl.adminList) ? sl.adminList.map(String).filter(p => p.trim()) : existing.adminList || [],
            adminPickCount: Number.isFinite(parseInt(sl.adminPickCount, 10)) ? Math.max(0, Math.min(20, parseInt(sl.adminPickCount, 10))) : (existing.adminPickCount ?? 3),
            blackList: Array.isArray(sl.blackList) ? sl.blackList.map(String).filter(p => p.trim()) : existing.blackList || [],
            hotPickCount: Number.isFinite(parseInt(sl.hotPickCount, 10)) ? Math.max(0, Math.min(20, parseInt(sl.hotPickCount, 10))) : (existing.hotPickCount ?? 5),
            dailyWordCount: Number.isFinite(parseInt(sl.dailyWordCount, 10)) ? Math.max(0, Math.min(20, parseInt(sl.dailyWordCount, 10))) : (existing.dailyWordCount ?? 3),
            dailyWordDicts: Array.isArray(sl.dailyWordDicts) ? sl.dailyWordDicts.map(String).filter(p => p.trim()) : (existing.dailyWordDicts || []),
            dailyWordRotateHour: Number.isFinite(parseInt(sl.dailyWordRotateHour, 10)) ? Math.max(1, Math.min(168, parseInt(sl.dailyWordRotateHour, 10))) : (existing.dailyWordRotateHour ?? 12),
            enabled: sl.enabled !== undefined ? !!sl.enabled : (existing.enabled === true)
          };
          config.settings.suggestListUpdatedAt = Date.now();
          invalidateDailyWordCache();
          hotListCache = null;
        }

        // ── SEO Settings ──
        if (seoSiteDescription !== undefined) config.settings.seoSiteDescription = String(seoSiteDescription).trim();
        if (seoKeywords !== undefined) config.settings.seoKeywords = String(seoKeywords).trim();
        if (seoOgImage !== undefined) config.settings.seoOgImage = String(seoOgImage).trim();
        if (seoRobotsIndex !== undefined) config.settings.seoRobotsIndex = (seoRobotsIndex === true || seoRobotsIndex === 'true' || seoRobotsIndex === 1 || seoRobotsIndex === '1');
        if (seoBlockAiBots !== undefined) config.settings.seoBlockAiBots = (seoBlockAiBots === true || seoBlockAiBots === 'true' || seoBlockAiBots === 1 || seoBlockAiBots === '1');
        if (seoDisallowPaths !== undefined) config.settings.seoDisallowPaths = String(seoDisallowPaths).trim();
        if (googleSiteVerification !== undefined) config.settings.googleSiteVerification = String(googleSiteVerification).trim();
        if (bingSiteVerification !== undefined) config.settings.bingSiteVerification = String(bingSiteVerification).trim();
        if (baiduSiteVerification !== undefined) config.settings.baiduSiteVerification = String(baiduSiteVerification).trim();
        if (seoEnableSearchBox !== undefined) config.settings.seoEnableSearchBox = (seoEnableSearchBox === true || seoEnableSearchBox === 'true' || seoEnableSearchBox === 1 || seoEnableSearchBox === '1');
        if (seoHomepageSummary !== undefined) config.settings.seoHomepageSummary = String(seoHomepageSummary).trim();
        sitemapDirty = true;
        Logger.info('SEO', 'SEO configuration modified: Triggering sitemap background rebuild', null, req);
        autoRebuildSitemapAsync().catch(() => {});

        if (config.settings.dictionaryEnabled !== nextDictEnabled || config.settings.dictionaryPath !== nextDictPath) {
          config.settings.dictionaryEnabled = nextDictEnabled;
          config.settings.dictionaryPath = nextDictPath;
          resetDictWatcher();
        }
        saveConfig();
        return sendJSON(res, 200, { success: true, settings: config.settings });
      };

      // Determine if directory paths or dictionary settings are explicitly being modified
      const isDictExplicitlyUpdated = dictionaryEnabled !== undefined || dictionaryPath !== undefined;
      const isMdRootExplicitlyUpdated = mdRoot !== undefined && resolvedPath !== config.settings.mdRoot;

      const afterVaultOk = () => {
        // Only validate dictionary directory if dictionary settings are explicitly being updated in this request
        if (isDictExplicitlyUpdated && nextDictEnabled && nextDictPath) {
          return fs.promises.stat(nextDictPath).then(ds => {
            if (!ds.isDirectory()) {
              return sendJSON(res, 400, { error: 'Dictionary path is not a directory' });
            }
            return updateSettings();
          }).catch(err => {
            if (err.code === 'ENOENT') {
              if (createIfNotExists) {
                return fs.promises.mkdir(nextDictPath, { recursive: true })
                  .then(() => updateSettings())
                  .catch(mkdirErr => sendJSON(res, 500, { error: 'Failed to create dictionary directory: ' + mkdirErr.message }));
              }
              return sendJSON(res, 404, {
                error: `辭典目錄路徑 "${nextDictPath}" 不存在。`,
                code: 'DIR_NOT_FOUND',
                path: nextDictPath,
                field: 'dictionaryPath'
              });
            }
            return sendJSON(res, 400, { error: `Dictionary path does not exist or is not readable (${err.code || err.message})` });
          });
        }
        return updateSettings();
      };

      // If neither mdRoot nor dictionary settings were modified or specified, bypass directory checks (partial update)
      if (!isMdRootExplicitlyUpdated && !isDictExplicitlyUpdated) {
        return updateSettings();
      }

      // If only dictionary settings were updated, check dictionary directory directly
      if (!isMdRootExplicitlyUpdated) {
        return afterVaultOk();
      }

      return fs.promises.stat(resolvedPath).then(stats => {
        if (!stats.isDirectory()) {
          return sendJSON(res, 400, { error: 'Provided path is not a directory' });
        }
        return afterVaultOk();
      }).catch(err => {
        if (err.code === 'ENOENT') {
          if (createIfNotExists) {
            return fs.promises.mkdir(resolvedPath, { recursive: true })
              .then(() => afterVaultOk())
              .catch(mkdirErr => sendJSON(res, 500, { error: 'Failed to create directory: ' + mkdirErr.message }));
          }
          return sendJSON(res, 404, {
            error: `目錄路徑 "${resolvedPath}" 不存在。`,
            code: 'DIR_NOT_FOUND',
            path: resolvedPath,
            field: 'mdRoot'
          });
        }
        return sendJSON(res, 400, { error: `Directory path does not exist or is not readable (${err.code || err.message})` });
      });
    }).catch(err => {
      return sendJSON(res, 500, { error: err.message });
    });
  }

  // Admin hardware status API
  if (pathname === '/api/admin/hardware' && req.method === 'GET') {
    return handleHardwareStats(req, res);
  }

  // Admin rebuild index API
  if (pathname === '/api/admin/rebuild-index' && req.method === 'POST') {
    return handleRebuildIndex(req, res);
  }
  if (pathname === '/api/admin/rebuild-dict-index' && req.method === 'POST') {
    return handleRebuildDictIndex(req, res);
  }

  // Admin password change API
  if (pathname === '/api/admin/password' && req.method === 'POST') {
    return handleAdminPassword(req, res);
  }

  // Admin diagnose path API
  if (pathname === '/api/admin/diagnose-path' && req.method === 'POST') {
    return handleAdminDiagnosePath(req, res);
  }

  // Admin rebuild sitemap API
  if (pathname === '/api/admin/rebuild-sitemap' && req.method === 'POST') {
    return handleAdminRebuildSitemap(req, res);
  }

  // Admin clear cache API
  if (pathname === '/api/admin/clear-cache' && req.method === 'POST') {
    return handleAdminClearCache(req, res);
  }

  // Public suggest-list API (no auth required)
  if (pathname === '/api/suggest-list' && req.method === 'GET') {
    return handleSuggestList(req, res);
  }

    // Static files
    serveStatic(req, res, pathname, query);
  } catch (fatalErr) {
    Logger.error('HTTP', 'Unhandled server error during request routing', fatalErr, req);
    if (!res.headersSent) {
      try {
        res.writeHead(500, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, SECURITY_HEADERS));
        res.end('Internal Server Error');
      } catch (_) {}
    }
  }
});

server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.on('clientError', (err, socket) => {
  if (socket && !socket.destroyed) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  }
});

initWorkerPool();
initIndexWorkerPool();

if (require.main === module) {
  server.listen(PORT, () => {
    console.log('');
    console.log('  🪷  mdWebview is running');
    console.log('  ───────────────────────');
    console.log(`  Local:   http://localhost:${PORT}`);
    console.log(`  Vault:   ${getMdRoot()}`);
    console.log('');

    // Eagerly build Bigram Inverted Index & Sitemap in background on boot
    Logger.info('Boot', 'Pre-warming Bigram Index & Sitemap cache in background...');
    buildSearchIndexAsync().catch(() => {});
    autoRebuildSitemapAsync().catch(() => {});

    // Set up the dictionary directory watcher (and index) at boot so the index
    // rebuilds automatically when dictionary files change — not only on fulltext.
    if (config.settings.dictionaryEnabled) {
      setupDictWatcher();
      buildDictIndexAsync().catch(() => {});
      // Warm the (large) dictionary section indexes so the first entry open is
      // fast even after a restart, independent of the bigram index build above.
      warmDictSectionIndexes().catch(() => {});
    }
  });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    server,
    config,
    workerPool,
    indexWorkerPool,
    executeIndexJob,
    runIndexWorkerPool,
    renderWithWorker,
    buildSectionIndex,
    getSectionIndex,
    computeChunkRanges,
    isCrawlerRequest,
    getCrawlerName,
    getAnalyticsData,
    pushToLogBuffer,
    updateAnalyticsStoreEntry,
    initializeAnalyticsStore,
    formatTimestampInTz,
    isBotEntry,
    extractAnalyticsPath,
    extractAnalyticsQuery,
    buildAggregateAnalyticsData,
    handleAnalyticsExport,
    getDailyWords,
    mulberry32,
    invalidateDailyWordCache,
    scanDictFiles,
    handleSuggestList,
    handleDictFiles,
    resetTreeWatcher,
    resetDictWatcher,
    resetConfigWatcher,
    generateSitemapXml,
    autoRebuildSitemapAsync,
    terminateWorkerPools,
    saveSearchIndexBinCacheAsync,
    loadSearchIndexFromBinCacheAsync,
    saveDictIndexBinCacheAsync,
    loadDictIndexFromBinCacheAsync,
    buildSearchIndexAsync,
    buildDictIndexAsync,
    stripFrontmatter,
    ChunkedBinaryWriter
  };
}
