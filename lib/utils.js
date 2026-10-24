/**
 * @file lib/utils.js — General Utility Functions
 */

const fs = require('fs');
const path = require('path');
const { CRAWLER_UA_REGEX } = require('./constants');

const realpathCache = new Map(); // root -> canonical realpath

function clearRealpathCache() {
  realpathCache.clear();
}

/**
 * Escape XML special characters for sitemap.xml and robots.txt
 */
function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Format timestamp in given timezone
 */
function formatTimestampInTz(timestamp, tz = 'auto', format = 'date') {
  try {
    const d = new Date(timestamp);
    if (Number.isNaN(d.getTime())) return '';
    const timeZone = (tz && tz !== 'auto') ? tz : 'UTC';
    if (format === 'hour') {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hourCycle: 'h23'
      }).formatToParts(d);
      const y = parts.find(p => p.type === 'year')?.value;
      const m = parts.find(p => p.type === 'month')?.value;
      const day = parts.find(p => p.type === 'day')?.value;
      const h = parts.find(p => p.type === 'hour')?.value;
      return `${y}-${m}-${day} ${h}:00`;
    }
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    return formatter.format(d);
  } catch (_) {
    const d = new Date(timestamp);
    return format === 'hour'
      ? `${d.toISOString().substring(0, 10)} ${d.toISOString().substring(11, 13)}:00`
      : d.toISOString().split('T')[0];
  }
}

/**
 * Mulberry32 32-bit PRNG generator
 */
function mulberry32(seed) {
  return function() {
    let t = (seed += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Bot detection utilities
 */
function getCrawlerName(req, query) {
  if (query && (query.crawler === '1' || query.ssr === '1')) return 'crawler-debug';
  const ua = req && req.headers ? (req.headers['user-agent'] || '') : '';
  const match = ua.match(CRAWLER_UA_REGEX);
  return match ? match[0].toLowerCase() : null;
}

function isCrawlerRequest(req, query) {
  return Boolean(getCrawlerName(req, query));
}

function isBotEntry(entry) {
  if (!entry) return false;
  if (entry.isBot) return true;
  if (entry.bot) return true;
  if (entry.tag === 'SSR') return true;
  if (entry.tag === 'ShareLink') return true;
  if (entry.tag === 'Index') return true;
  if (entry.tag === 'Process') return true;
  if (entry.level === 'DEBUG' && entry.tag !== 'Render') return true;
  if (entry.message) {
    if (/\[Bot:\s*[^\]]+\]/i.test(entry.message)) return true;
    if (entry.message.includes('/robots.txt') || entry.message.includes('/sitemap.xml')) return true;
    if (entry.message.includes('/favicon.ico') ||
        entry.message.includes('/apple-touch-icon') ||
        entry.message.includes('/apple-touch-icon-precomposed.png') ||
        entry.message.includes('/style.css') ||
        entry.message.includes('/marked.min.js') ||
        entry.message.includes('/null') ||
        entry.message.includes('Indexing progress')) {
      return true;
    }
  }
  return false;
}

// HTTP 存取記錄尾綴，例如 " -> 200 (12ms)" 或舊格式 " -> 200"。單次解碼後
// path=/q= 的值可能含空白（例如 q=一切 法），擷取前必須先剝除此尾綴，
// 否則狀態碼會被一併納入值中。
const ACCESS_LOG_SUFFIX_RE = / -> \d{3}(?: \(\d+ms\))?$/;

function stripAccessLogSuffix(message) {
  return message.replace(ACCESS_LOG_SUFFIX_RE, '');
}

function extractAnalyticsPath(entry) {
  if (entry.path) return entry.path;
  if (!entry.message) return '';
  const access = entry.message.match(/Access file: "([^"]+)"/);
  if (access) return access[1];
  const loaded = entry.message.match(/Loaded document(?: \(.*?\))?: "([^"]+)"/);
  if (loaded) return loaded[1];
  const notMod = entry.message.match(/304 Not Modified: "([^"]+)"/);
  if (notMod) return notMod[1];
  // [^&]* 而非 [^&\s]+：值本身可能含空白，改以 & 與已剝除的尾綴為界。
  const pathMatch = stripAccessLogSuffix(entry.message).match(/path=([^&]*)/);
  if (!pathMatch || !pathMatch[1]) return '';
  const raw = pathMatch[1].trim();
  try { return decodeURIComponent(raw); } catch (_) { return raw; }
}

function extractAnalyticsQuery(entry) {
  if (entry.query) return String(entry.query).trim();
  if (!entry.message) return '';
  const queryMatch = entry.message.match(/(?:Dict(?:ionary)? )?Query: "([^"]+)"/i);
  if (queryMatch) return queryMatch[1].trim();
  const paramMatch = stripAccessLogSuffix(entry.message).match(/q=([^&]*)/);
  if (!paramMatch || !paramMatch[1]) return '';
  const raw = paramMatch[1].trim();
  try { return decodeURIComponent(raw).trim(); } catch (_) { return raw; }
}

/**
 * Symlink traversal and escape defense
 */
async function getRootRealpath(root) {
  if (realpathCache.has(root)) return realpathCache.get(root);
  const real = await fs.promises.realpath(root);
  realpathCache.set(root, real);
  return real;
}

async function isRealPathWithinRoot(root, resolvedPath) {
  const realTarget = await fs.promises.realpath(resolvedPath);
  const realRoot = await getRootRealpath(root);
  const rel = path.relative(realRoot, realTarget);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * True when any segment of a root-relative path is hidden (".obsidian",
 * ".git", ".env", ...). The tree scanner never lists these, so nothing in the
 * UI links to them; serving them would only leak plugin settings / tokens.
 */
function hasHiddenSegment(relPath) {
  return String(relPath || '').split(/[\\/]+/).some(seg => seg.startsWith('.') && seg !== '.');
}

/** Only Markdown documents are served as readable text. */
function isMarkdownPath(p) {
  return path.extname(String(p || '')).toLowerCase() === '.md';
}

// Directories that must never become a content root: pointing the vault at
// one of these turns every public read endpoint into a host file browser.
const FORBIDDEN_ROOT_PREFIXES = ['/etc', '/proc', '/sys', '/dev', '/boot', '/root', '/bin', '/sbin', '/lib', '/lib64', '/usr', '/run'];

/**
 * True when `dir` is unacceptable as mdRoot / dictionaryPath: the filesystem
 * root (or a Windows drive root), a system directory or anything under one,
 * or the application directory itself.
 */
function isForbiddenContentRoot(dir, appRoot) {
  const resolved = path.resolve(String(dir || ''));
  if (resolved === path.parse(resolved).root) return true;
  if (appRoot && resolved === path.resolve(appRoot)) return true;
  if (process.platform !== 'win32') {
    for (const prefix of FORBIDDEN_ROOT_PREFIXES) {
      if (resolved === prefix || resolved.startsWith(prefix + '/')) return true;
    }
  }
  return false;
}

function flattenMarkdownFiles(nodes, acc = []) {
  if (!Array.isArray(nodes)) return acc;
  for (const node of nodes) {
    if (node.type === 'file') {
      acc.push(node);
    } else if (node.type === 'directory' && Array.isArray(node.children)) {
      flattenMarkdownFiles(node.children, acc);
    }
  }
  return acc;
}

const net = require('net');

function normalizeIp(value) {
  if (typeof value !== 'string') return '';
  let s = value.trim();
  if (s.startsWith('[') && s.includes(']')) s = s.slice(1, s.indexOf(']')); // [v6]:port
  if (s.startsWith('::ffff:')) s = s.substring(7);
  return net.isIP(s) ? s : '';
}

// Addresses a reverse proxy (e.g. cloudflared, nginx, Docker bridge gateway)
// realistically connects from: loopback, RFC1918, link-local, IPv6 ULA.
// A request whose TCP peer is one of these came through infrastructure we
// control; a request from a public peer bypassed the proxy and must not be
// allowed to choose its own IP via headers.
const PRIVATE_PROXY_RANGES = new net.BlockList();
PRIVATE_PROXY_RANGES.addSubnet('127.0.0.0', 8, 'ipv4');
PRIVATE_PROXY_RANGES.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE_PROXY_RANGES.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE_PROXY_RANGES.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE_PROXY_RANGES.addSubnet('169.254.0.0', 16, 'ipv4');
PRIVATE_PROXY_RANGES.addAddress('::1', 'ipv6');
PRIVATE_PROXY_RANGES.addSubnet('fc00::', 7, 'ipv6');
PRIVATE_PROXY_RANGES.addSubnet('fe80::', 10, 'ipv6');

function isInBlockList(list, ip) {
  const family = net.isIPv6(ip) ? 'ipv6' : 'ipv4';
  try { return list.check(ip, family); } catch (_) { return false; }
}

let cachedTrustSpec = null;
let cachedTrustPolicy = null;

/**
 * Parse TRUST_PROXY into a policy. Re-parsed only when the env value changes.
 *   unset / "false" / "0"  → never trust forwarding headers
 *   "true" / "1"           → trust them only when the TCP peer is loopback or a
 *                            private/internal address (cloudflared, Docker
 *                            bridge, nginx on the same host or LAN)
 *   "all"                  → trust every peer (legacy behaviour, unsafe if the
 *                            origin port is reachable from the Internet)
 *   "1.2.3.4,10.0.0.0/8"   → trust only these peer IPs / CIDRs
 */
function getTrustPolicy() {
  const spec = (process.env.TRUST_PROXY || '').trim();
  if (spec === cachedTrustSpec && cachedTrustPolicy) return cachedTrustPolicy;
  let policy;
  const lower = spec.toLowerCase();
  if (!spec || lower === 'false' || lower === '0') {
    policy = { mode: 'off' };
  } else if (lower === 'true' || lower === '1') {
    policy = { mode: 'list', list: PRIVATE_PROXY_RANGES };
  } else if (lower === 'all' || lower === '*') {
    policy = { mode: 'all' };
  } else {
    const list = new net.BlockList();
    for (const raw of spec.split(',').map(s => s.trim()).filter(Boolean)) {
      const [addr, bits] = raw.split('/');
      const ip = normalizeIp(addr);
      if (!ip) continue;
      const family = net.isIPv6(ip) ? 'ipv6' : 'ipv4';
      try {
        if (bits !== undefined) list.addSubnet(ip, parseInt(bits, 10), family);
        else list.addAddress(ip, family);
      } catch (_) {}
    }
    policy = { mode: 'list', list };
  }
  cachedTrustSpec = spec;
  cachedTrustPolicy = policy;
  return policy;
}

function isTrustedProxyPeer(ip, policy = getTrustPolicy()) {
  if (!ip || policy.mode === 'off') return false;
  if (policy.mode === 'all') return true;
  return isInBlockList(policy.list, ip);
}

let warnedUntrustedProxyPeer = false;

function getClientIP(req) {
  if (!req) return '127.0.0.1';
  let ip = '';
  const socketIp = req.socket ? (req.socket.remoteAddress || '127.0.0.1') : '127.0.0.1';
  const cleanSocketIp = socketIp.startsWith('::ffff:') ? socketIp.substring(7) : socketIp;

  const policy = getTrustPolicy();
  const trustProxy = isTrustedProxyPeer(cleanSocketIp, policy);

  if (trustProxy && req.headers) {
    // 1. Cloudflare (incl. Cloudflare Tunnel): set by Cloudflare's edge and
    //    overwritten on every request, so a client cannot inject it.
    ip = normalizeIp(req.headers['cf-connecting-ip']);

    // 2. X-Forwarded-For: proxies APPEND, so the left-most entries are whatever
    //    the client sent. Walk from the right and take the first hop that is not
    //    itself a trusted proxy — that is the address our proxy chain saw.
    if (!ip) {
      const forwarded = req.headers['x-forwarded-for'];
      if (forwarded && typeof forwarded === 'string') {
        const hops = forwarded.split(',').map(normalizeIp).filter(Boolean);
        for (let i = hops.length - 1; i >= 0; i--) {
          if (i === 0 || !isTrustedProxyPeer(hops[i], policy)) { ip = hops[i]; break; }
        }
      }
    }

    // 3. X-Real-IP (nginx convention; set, not appended, by the proxy)
    if (!ip) ip = normalizeIp(req.headers['x-real-ip']);
  } else if (!trustProxy && policy.mode !== 'off' && !warnedUntrustedProxyPeer &&
             req.headers && (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'])) {
    // Proxy trust is enabled but this peer is not on the trust list. Either
    // someone is bypassing the proxy, or the proxy runs on an address we do not
    // recognise — in which case every visitor would collapse into that one IP.
    // Say so once so a misconfiguration is visible in the container log.
    warnedUntrustedProxyPeer = true;
    console.warn(`[Proxy] Ignoring forwarding headers from untrusted peer ${cleanSocketIp}. ` +
      'If this is your reverse proxy / cloudflared, add it to TRUST_PROXY (e.g. TRUST_PROXY=' + cleanSocketIp + ').');
  }

  if (!ip || !net.isIP(ip)) {
    ip = cleanSocketIp;
  }
  if (ip.startsWith('::ffff:')) {
    ip = ip.substring(7);
  }
  if (!net.isIP(ip)) {
    ip = '127.0.0.1';
  }
  return ip;
}

let lastKnownBaseUrl = null;
function getBaseUrl(req, siteUrl = '') {
  let configuredSiteUrl = (typeof siteUrl === 'string' && siteUrl.trim()) ? siteUrl.trim() : '';
  if (!configuredSiteUrl) {
    try {
      const { config } = require('./config');
      if (config && config.settings && typeof config.settings.siteUrl === 'string' && config.settings.siteUrl.trim()) {
        configuredSiteUrl = config.settings.siteUrl.trim();
      }
    } catch (_) {}
  }
  if (configuredSiteUrl) {
    return configuredSiteUrl.replace(/\/+$/, '');
  }
  if (process.env.SITE_URL) {
    return process.env.SITE_URL.replace(/\/+$/, '');
  }
  if (req && req.headers) {
    // X-Forwarded-* are only meaningful when set by our own proxy; from any
    // other peer they are attacker-chosen. The derived URL is also remembered
    // (lastKnownBaseUrl) and reused by background sitemap rebuilds, so an
    // unvalidated Host could poison every crawler-facing absolute URL.
    const socketIp = req.socket ? String(req.socket.remoteAddress || '').replace(/^::ffff:/, '') : '';
    const fromProxy = isTrustedProxyPeer(socketIp);
    const fallbackProto = req.socket && req.socket.encrypted ? 'https' : 'http';
    const rawProto = fromProxy && typeof req.headers['x-forwarded-proto'] === 'string'
      ? req.headers['x-forwarded-proto'] : fallbackProto;
    let proto = rawProto.split(',')[0].trim().toLowerCase();
    if (proto !== 'http' && proto !== 'https') proto = fallbackProto;
    const rawHost = (fromProxy && typeof req.headers['x-forwarded-host'] === 'string' && req.headers['x-forwarded-host'])
      || req.headers.host || 'localhost:8330';
    const host = String(rawHost).split(',')[0].trim();
    // hostname / IPv4 / [IPv6] with an optional port — nothing else.
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i.test(host)) {
      return lastKnownBaseUrl || 'http://localhost:8330';
    }
    const url = `${proto}://${host}`;
    lastKnownBaseUrl = url;
    return url;
  }
  return lastKnownBaseUrl || 'http://localhost:8330';
}

function safeDecodeURI(str) {
  if (typeof str !== 'string' || !str.includes('%')) return str;
  try {
    return decodeURIComponent(str);
  } catch (_) {
    return str.replace(/(?:%[0-9A-Fa-f]{2})+/g, (match) => {
      try {
        return decodeURIComponent(match);
      } catch (_) {
        return match;
      }
    });
  }
}

function safeDecodeURIComponent(str) {
  if (typeof str !== 'string') return str;
  try {
    return decodeURIComponent(str);
  } catch (_) {
    return str;
  }
}

module.exports = {
  escapeXml,
  formatTimestampInTz,
  mulberry32,
  getCrawlerName,
  isCrawlerRequest,
  isBotEntry,
  extractAnalyticsPath,
  extractAnalyticsQuery,
  getRootRealpath,
  isRealPathWithinRoot,
  clearRealpathCache,
  flattenMarkdownFiles,
  hasHiddenSegment,
  isMarkdownPath,
  isForbiddenContentRoot,
  getClientIP,
  isTrustedProxyPeer,
  getBaseUrl,
  safeDecodeURI,
  safeDecodeURIComponent
};
