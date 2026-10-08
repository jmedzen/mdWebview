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

function extractAnalyticsPath(entry) {
  if (entry.path) return entry.path;
  if (!entry.message) return '';
  const access = entry.message.match(/Access file: "([^"]+)"/);
  if (access) return access[1];
  const loaded = entry.message.match(/Loaded document(?: \(.*?\))?: "([^"]+)"/);
  if (loaded) return loaded[1];
  const notMod = entry.message.match(/304 Not Modified: "([^"]+)"/);
  if (notMod) return notMod[1];
  const pathMatch = entry.message.match(/path=([^&\s]+)/);
  if (!pathMatch) return '';
  try { return decodeURIComponent(pathMatch[1]); } catch (_) { return pathMatch[1]; }
}

function extractAnalyticsQuery(entry) {
  if (entry.query) return String(entry.query).trim();
  if (!entry.message) return '';
  const queryMatch = entry.message.match(/(?:Dict(?:ionary)? )?Query: "([^"]+)"/i);
  if (queryMatch) return queryMatch[1].trim();
  const paramMatch = entry.message.match(/q=([^&\s]+)/);
  if (!paramMatch) return '';
  try { return decodeURIComponent(paramMatch[1]).trim(); } catch (_) { return paramMatch[1].trim(); }
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

function getClientIP(req) {
  if (!req) return '127.0.0.1';
  let ip = '';
  const socketIp = req.socket ? (req.socket.remoteAddress || '127.0.0.1') : '127.0.0.1';
  const cleanSocketIp = socketIp.startsWith('::ffff:') ? socketIp.substring(7) : socketIp;

  // Trust proxy headers ONLY if explicitly configured via TRUST_PROXY env var
  let trustProxy = process.env.TRUST_PROXY === 'true' || process.env.TRUST_PROXY === '1';
  if (!trustProxy && process.env.TRUST_PROXY) {
    const trustedList = process.env.TRUST_PROXY.split(',').map(s => s.trim());
    if (trustedList.includes(cleanSocketIp)) trustProxy = true;
  }

  if (trustProxy && req.headers) {
    // 1. Cloudflare Connecting IP
    const cfIp = req.headers['cf-connecting-ip'];
    if (cfIp && typeof cfIp === 'string') {
      const trimmed = cfIp.trim();
      const cleanCf = trimmed.startsWith('::ffff:') ? trimmed.substring(7) : trimmed;
      if (net.isIP(cleanCf)) ip = cleanCf;
    }

    // 2. True-Client-IP
    if (!ip) {
      const trueClientIp = req.headers['true-client-ip'];
      if (trueClientIp && typeof trueClientIp === 'string') {
        const trimmed = trueClientIp.trim();
        const cleanTrue = trimmed.startsWith('::ffff:') ? trimmed.substring(7) : trimmed;
        if (net.isIP(cleanTrue)) ip = cleanTrue;
      }
    }

    // 3. X-Forwarded-For
    if (!ip) {
      const forwarded = req.headers['x-forwarded-for'];
      if (forwarded && typeof forwarded === 'string') {
        const candidate = forwarded.split(',')[0].trim();
        const cleanFwd = candidate.startsWith('::ffff:') ? candidate.substring(7) : candidate;
        if (net.isIP(cleanFwd)) ip = cleanFwd;
      }
    }

    // 4. X-Real-IP
    if (!ip) {
      const realIp = req.headers['x-real-ip'];
      if (realIp && typeof realIp === 'string') {
        const trimmed = realIp.trim();
        const cleanReal = trimmed.startsWith('::ffff:') ? trimmed.substring(7) : trimmed;
        if (net.isIP(cleanReal)) ip = cleanReal;
      }
    }
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
  if (siteUrl && siteUrl.trim()) {
    return siteUrl.trim().replace(/\/+$/, '');
  }
  if (process.env.SITE_URL) {
    return process.env.SITE_URL.replace(/\/+$/, '');
  }
  if (req && req.headers) {
    const rawProto = req.headers['x-forwarded-proto'] || (req.socket && req.socket.encrypted ? 'https' : 'http');
    const proto = rawProto.split(',')[0].trim();
    const host = req.headers.host || 'localhost:8330';
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
  getClientIP,
  getBaseUrl,
  safeDecodeURI,
  safeDecodeURIComponent
};
