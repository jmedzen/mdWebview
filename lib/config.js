/**
 * @file lib/config.js — Configuration Management and Hot-Reloading
 */

const fs = require('fs');
const path = require('path');
const { APP_ROOT, CONFIG_PATH } = require('./constants');
const { clearRealpathCache } = require('./utils');

function deriveDictRoot(mdRoot) {
  const base = mdRoot || process.env.MD_ROOT || path.join(APP_ROOT, 'md');
  return path.join(path.dirname(path.resolve(base)), 'dicts');
}

let memoizedMdRoot = null;

function invalidateMdRootMemo() {
  memoizedMdRoot = null;
  clearRealpathCache();
}

const config = {
  admin: null, // { username, passwordHash, salt }
  settings: {
    mdRoot: process.env.MD_ROOT || path.join(APP_ROOT, 'md'),
    defaultFontSize: parseInt(process.env.DEFAULT_FONT_SIZE, 10) || 16,
    defaultTheme: process.env.DEFAULT_THEME || 'obsidian-dark',
    siteName: process.env.SITE_NAME || 'mdWebview',
    siteUrl: process.env.SITE_URL || '',
    enableVersion: process.env.ENABLE_VERSION ? process.env.ENABLE_VERSION === 'true' : false,
    version: process.env.VERSION || '',
    enableDownload: process.env.ENABLE_DOWNLOAD ? process.env.ENABLE_DOWNLOAD === 'true' : false,
    downloadUrl: process.env.DOWNLOAD_URL || '',
    dictionaryEnabled: process.env.DICTIONARY_ENABLED ? process.env.DICTIONARY_ENABLED === 'true' : false,
    dictionaryPath: process.env.DICTIONARY_PATH || deriveDictRoot(),
    enableAnnouncement: process.env.ENABLE_ANNOUNCEMENT ? process.env.ENABLE_ANNOUNCEMENT === 'true' : false,
    announcementMessage: process.env.ANNOUNCEMENT_MESSAGE || '',
    announcementUpdatedAt: 0,
    suggestListUpdatedAt: 0,
    suggestList: {
      adminList: [],
      adminPickCount: 3,
      blackList: [],
      hotPickCount: 5,
      dailyWordCount: 3,
      dailyWordDicts: [],
      dailyWordRotateHour: 12,
      enabled: false
    },
    seoSiteDescription: process.env.SEO_SITE_DESCRIPTION || '',
    seoKeywords: process.env.SEO_KEYWORDS || '',
    seoOgImage: process.env.SEO_OG_IMAGE || '/og-preview.png',
    seoRobotsIndex: process.env.SEO_ROBOTS_INDEX !== undefined ? process.env.SEO_ROBOTS_INDEX === 'true' : false,
    seoBlockAiBots: process.env.SEO_BLOCK_AI_BOTS !== undefined ? process.env.SEO_BLOCK_AI_BOTS === 'true' : true,
    seoDisallowPaths: process.env.SEO_DISALLOW_PATHS || '/api/\n/vendor/',
    googleSiteVerification: process.env.GOOGLE_SITE_VERIFICATION || '',
    bingSiteVerification: process.env.BING_SITE_VERIFICATION || '',
    baiduSiteVerification: process.env.BAIDU_SITE_VERIFICATION || '',
    seoEnableSearchBox: process.env.SEO_ENABLE_SEARCH_BOX !== undefined ? process.env.SEO_ENABLE_SEARCH_BOX === 'true' : false,
    seoHomepageSummary: process.env.SEO_HOMEPAGE_SUMMARY || ''
  }
};

/**
 * 從三個優先層級載入並合併設定：
 * 1. 環境變數
 * 2. APP_ROOT/config.json
 * 3. CONFIG_PATH (/data/config.json)
 */
function loadConfig() {
  try {
    if (process.env.SITE_NAME) config.settings.siteName = process.env.SITE_NAME;
    if (process.env.SITE_URL) config.settings.siteUrl = process.env.SITE_URL;
    if (process.env.ENABLE_VERSION !== undefined) config.settings.enableVersion = process.env.ENABLE_VERSION === 'true';
    if (process.env.VERSION !== undefined) config.settings.version = process.env.VERSION;
    if (process.env.ENABLE_DOWNLOAD !== undefined) config.settings.enableDownload = process.env.ENABLE_DOWNLOAD === 'true';
    if (process.env.DOWNLOAD_URL !== undefined) config.settings.downloadUrl = process.env.DOWNLOAD_URL;
    if (process.env.ENABLE_ANNOUNCEMENT !== undefined) config.settings.enableAnnouncement = process.env.ENABLE_ANNOUNCEMENT === 'true';
    if (process.env.ANNOUNCEMENT_MESSAGE !== undefined) config.settings.announcementMessage = process.env.ANNOUNCEMENT_MESSAGE;
    if (process.env.SEO_SITE_DESCRIPTION !== undefined) config.settings.seoSiteDescription = process.env.SEO_SITE_DESCRIPTION;
    if (process.env.SEO_KEYWORDS !== undefined) config.settings.seoKeywords = process.env.SEO_KEYWORDS;
    if (process.env.SEO_OG_IMAGE !== undefined) config.settings.seoOgImage = process.env.SEO_OG_IMAGE;
    if (process.env.SEO_ROBOTS_INDEX !== undefined) config.settings.seoRobotsIndex = process.env.SEO_ROBOTS_INDEX === 'true';
    if (process.env.SEO_BLOCK_AI_BOTS !== undefined) config.settings.seoBlockAiBots = process.env.SEO_BLOCK_AI_BOTS === 'true';
    if (process.env.SEO_DISALLOW_PATHS !== undefined) config.settings.seoDisallowPaths = process.env.SEO_DISALLOW_PATHS;
    if (process.env.GOOGLE_SITE_VERIFICATION !== undefined) config.settings.googleSiteVerification = process.env.GOOGLE_SITE_VERIFICATION;
    if (process.env.BING_SITE_VERIFICATION !== undefined) config.settings.bingSiteVerification = process.env.BING_SITE_VERIFICATION;
    if (process.env.BAIDU_SITE_VERIFICATION !== undefined) config.settings.baiduSiteVerification = process.env.BAIDU_SITE_VERIFICATION;
    if (process.env.SEO_ENABLE_SEARCH_BOX !== undefined) config.settings.seoEnableSearchBox = process.env.SEO_ENABLE_SEARCH_BOX === 'true';
    if (process.env.SEO_HOMEPAGE_SUMMARY !== undefined) config.settings.seoHomepageSummary = process.env.SEO_HOMEPAGE_SUMMARY;

    const defaultConfigPath = path.join(APP_ROOT, 'config.json');
    if (fs.existsSync(defaultConfigPath)) {
      const raw = fs.readFileSync(defaultConfigPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed.settings) config.settings = { ...config.settings, ...parsed.settings };
      if (parsed.admin && !config.admin) config.admin = parsed.admin;
    }

    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed.settings) {
        config.settings = { ...config.settings, ...parsed.settings };
      }
      if (parsed.admin !== undefined) {
        config.admin = parsed.admin;
      }
    }
  } catch (err) {
    console.error('Error loading config:', err);
  } finally {
    invalidateMdRootMemo();
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
    invalidateMdRootMemo();
    return true;
  } catch (err) {
    console.error('[Config] Error saving config to ' + CONFIG_PATH + ':', err);
    throw err;
  }
}

let configWatcher = null;
function setupConfigWatcher(onReload) {
  try {
    if (fs.existsSync(CONFIG_PATH) && !configWatcher) {
      configWatcher = fs.watch(CONFIG_PATH, (eventType) => {
        if (eventType === 'change') {
          try {
            loadConfig();
            if (typeof onReload === 'function') onReload();
          } catch (_) {}
        }
      });
    }
  } catch (_) {}
}

function resetConfigWatcher() {
  if (configWatcher) {
    try { configWatcher.close(); } catch (_) {}
    configWatcher = null;
  }
}

function getMdRoot() {
  if (memoizedMdRoot) return memoizedMdRoot;
  const configured = config.settings.mdRoot;

  if (configured && fs.existsSync(configured)) {
    try {
      const items = fs.readdirSync(configured);
      if (items.some(name => !name.startsWith('.'))) {
        memoizedMdRoot = configured;
        return configured;
      }
    } catch (_) {}
  }

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
          memoizedMdRoot = candidate;
          return candidate;
        }
      } catch (_) {}
    }
  }

  memoizedMdRoot = configured || path.join(APP_ROOT, 'md');
  return memoizedMdRoot;
}

function getDictionaryPath() {
  if (!config.settings.dictionaryEnabled) return null;
  const p = config.settings.dictionaryPath;
  if (!p) return null;
  return path.resolve(p);
}

async function isRealPathWithinMdRoot(resolvedPath) {
  const { isRealPathWithinRoot } = require('./utils');
  return isRealPathWithinRoot(getMdRoot(), resolvedPath);
}

// Initial load
loadConfig();

module.exports = {
  config,
  loadConfig,
  saveConfig,
  setupConfigWatcher,
  resetConfigWatcher,
  getMdRoot,
  deriveDictRoot,
  getDictionaryPath,
  invalidateMdRootMemo,
  isRealPathWithinMdRoot
};
