/**
 * @file lib/constants.js — System Constants and Default Configurations
 */

const path = require('path');
const fs = require('fs');

// APP_ROOT holds the read-only application payload (static assets, worker
// scripts, lib/, vendor/). USER_DATA holds everything writable: config, logs and
// the bigram index `.bin` caches. On a server install both resolve to the same
// directory, preserving historical behaviour. A desktop bundle points USER_DATA
// at a per-user directory so the app directory can stay read-only and versioned
// (required by macOS/Windows installers and by any auto-updater).
const APP_ROOT = path.resolve(process.cwd());
const USER_DATA = path.resolve(process.env.MDW_USER_DATA || APP_ROOT);
const PORT = process.env.PORT || 8330;
// Bind host. Servers keep the historical all-interfaces behaviour; desktop
// shells set 127.0.0.1 so the reader is never exposed to the local network.
const HOST = process.env.HOST || '0.0.0.0';
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(USER_DATA, 'config.json');

let APP_VERSION = '3.8.1';
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));
  if (pkg && pkg.version) APP_VERSION = pkg.version;
} catch (_) {}

const MAX_LOG_BUFFER = 600;

const CRAWLER_UA_REGEX = /googlebot|bingbot|yandex|baiduspider|duckduckbot|slurp|sogou|exabot|facebookexternalhit|facebot|twitterbot|rogerbot|linkedinbot|embedly|quoralinkpreview|showyoubot|outbrain|pinterest|slackbot|vkshare|w3c_validator|applebot|petalbot|bytespider|semrushbot|ahrefsbot/i;

const LOG_DIR = process.env.LOG_DIR || path.join(USER_DATA, 'logs');
const ANALYTICS_STORE_PATH = path.join(LOG_DIR, 'analytics-aggregates.json');
const ANALYTICS_STORE_VERSION = 3;

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
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf':  'font/ttf',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' fonts.googleapis.com; font-src 'self' fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self';"
};

module.exports = {
  APP_ROOT,
  USER_DATA,
  PORT,
  HOST,
  CONFIG_PATH,
  APP_VERSION,
  MAX_LOG_BUFFER,
  CRAWLER_UA_REGEX,
  LOG_DIR,
  ANALYTICS_STORE_PATH,
  ANALYTICS_STORE_VERSION,
  MIME_TYPES,
  SECURITY_HEADERS
};
