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

// ── Deployment target ─────────────────────────────────────────────────────
// One server codebase serves two very different deployments:
//
//   web        — the historical multi-user public site. Needs an administrator
//                account (created on first run), SEO metadata, a canonical
//                public URL and visit analytics.
//   *-app      — a single-user desktop/mobile bundle. There is exactly one
//                person at the keyboard, reachable only over loopback, so the
//                admin account, SEO and analytics are meaningless overhead and
//                actively harmful: the first-run admin modal blocks the reader
//                until a *public canonical URL* is supplied, which a local user
//                does not have.
//
// The variable is validated rather than trusted: an unknown or misspelled value
// falls back to 'web', the fail-closed choice, because requiring an
// administrator is the safe default for anything reachable from a network.
const DEPLOY_TARGETS = ['web', 'mac-app', 'win-app', 'linux-app', 'ios-app', 'android-app'];
const SINGLE_USER_TARGETS = ['mac-app', 'win-app', 'linux-app', 'ios-app', 'android-app'];
const DEFAULT_DEPLOY_TARGET = 'web';

/**
 * Normalize a raw MDW_DEPLOY_TARGET value into a supported target.
 *
 * Exported separately from DEPLOY_TARGET so it can be unit-tested directly:
 * this module resolves its constants at require() time, so a test cannot change
 * process.env and re-require to exercise the decision table.
 *
 * @param {string|undefined|null} value raw environment value
 * @returns {string} a supported target; DEFAULT_DEPLOY_TARGET when unrecognized
 */
function normalizeDeployTarget(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (DEPLOY_TARGETS.includes(raw)) return raw;
  return DEFAULT_DEPLOY_TARGET;
}

/** True when the raw value was non-empty but not a supported target. */
function isUnknownDeployTarget(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return raw !== '' && !DEPLOY_TARGETS.includes(raw);
}

const DEPLOY_TARGET = normalizeDeployTarget(process.env.MDW_DEPLOY_TARGET);

/**
 * True for every non-web target: a bundle used by one person on one machine.
 * This is the switch that disables the admin account, SEO and analytics.
 */
const IS_SINGLE_USER = DEPLOY_TARGET !== DEFAULT_DEPLOY_TARGET;

/** A human-readable label for logs and the UI. */
const DEPLOY_TARGET_LABEL = {
  web: 'Web (multi-user)',
  'mac-app': 'macOS App (single-user)',
  'win-app': 'Windows App (single-user)',
  'linux-app': 'Linux App (single-user)',
  'ios-app': 'iOS App (single-user)',
  'android-app': 'Android App (single-user)'
}[DEPLOY_TARGET];

const PORT = process.env.PORT || 8330;

// Desktop shells pin a stable port so the page origin — and therefore
// localStorage — survives restarts. If that port is taken, walk upward instead
// of failing to bind; without this a second instance (or any other process on
// the port) would crash the server at startup.
const PORT_SCAN = process.env.MDW_PORT_SCAN === 'true' || process.env.MDW_PORT_SCAN === '1';
const PORT_SCAN_RANGE = 10;

// Single-user bundles are loopback-only. MDW_ALLOW_LAN=true deliberately widens
// that to the local network for people who want to read their own library from
// another device — but it does NOT widen privileged maintenance endpoints, which
// stay restricted to loopback in lib/auth.js regardless of this flag.
const ALLOW_LAN = process.env.MDW_ALLOW_LAN === 'true' || process.env.MDW_ALLOW_LAN === '1';

// Bind host. Servers keep the historical all-interfaces behaviour; a
// single-user bundle defaults to loopback so the reader is never exposed to the
// local network unless the user opts in with MDW_ALLOW_LAN.
const DEFAULT_HOST = IS_SINGLE_USER && !ALLOW_LAN ? '127.0.0.1' : '0.0.0.0';
const HOST = process.env.HOST || DEFAULT_HOST;
// Privileged maintenance operations are loopback-only for every single-user
// bundle — MDW_ALLOW_LAN deliberately does NOT widen them, because that flag is
// about reading your own library from another device, not about handing it
// administrative control.
const IS_LOOPBACK_ONLY = IS_SINGLE_USER;

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(USER_DATA, 'config.json');

let APP_VERSION = '4.2.1';
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
  // challenges.cloudflare.com：Cloudflare Turnstile 人機驗證（登入、註冊表單才載入）。
  // 第三方登入是整頁導向（GET），不受 form-action 限制，所以 form-action 維持 'self'。
  'Content-Security-Policy': "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline' fonts.googleapis.com; font-src 'self' fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-src https://challenges.cloudflare.com; frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self';"
};

module.exports = {
  APP_ROOT,
  USER_DATA,
  DEPLOY_TARGET,
  DEPLOY_TARGETS,
  DEFAULT_DEPLOY_TARGET,
  DEPLOY_TARGET_LABEL,
  SINGLE_USER_TARGETS,
  IS_SINGLE_USER,
  IS_LOOPBACK_ONLY,
  ALLOW_LAN,
  PORT_SCAN,
  PORT_SCAN_RANGE,
  normalizeDeployTarget,
  isUnknownDeployTarget,
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
