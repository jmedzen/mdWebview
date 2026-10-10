/* ================================================================
   sw.js — mdWebview Service Worker (Tiered Hybrid Offline Caching)
   - App Shell: Cache-First / Stale-While-Revalidate
   - Sutra Content: Network-First with Cache Fallback
   - Search & Admin: Network-Only (no stale cache / quota risk)
   ================================================================ */

const CACHE_VERSION = 'v3.6.9';
const SHELL_CACHE = `mdwebview-shell-${CACHE_VERSION}`;
const CONTENT_CACHE = `mdwebview-content-${CACHE_VERSION}`;

// Core App Shell Assets required for 0ms boot and offline reader UI
const SHELL_ASSETS = [
  '/',
  '/style.css',
  '/app.js',
  '/marked.min.js',
  '/s2t.js',
  '/md-worker.js',
  '/manifest.json',
  '/favicon.svg',
  '/favicon-32.png',
  '/favicon-16.png',
  '/favicon.ico',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png',
  '/og-preview.png',
  '/vendor/katex/katex.min.css',
  '/vendor/katex/katex.min.js',
  '/vendor/katex/fonts/KaTeX_Main-Regular.woff2',
  '/vendor/katex/fonts/KaTeX_Math-Italic.woff2',
  '/vendor/katex/fonts/KaTeX_Size1-Regular.woff2',
  '/vendor/katex/fonts/KaTeX_AMS-Regular.woff2',
  '/vendor/mermaid/mermaid.min.js'
];

const MAX_CONTENT_CACHE_ITEMS = 150;

async function trimCache(cacheName, maxItems) {
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    if (keys.length > maxItems) {
      const toDelete = keys.slice(0, keys.length - maxItems);
      for (const k of toDelete) {
        await cache.delete(k);
      }
    }
  } catch (_) {}
}

// 1. Install: Pre-cache App Shell with allSettled to prevent single-asset failure blocking SW
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => {
        return Promise.allSettled(
          SHELL_ASSETS.map(url => cache.add(url).catch(err => {
            console.warn(`[SW] Pre-cache asset skipped (${url}):`, err);
          }))
        );
      })
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

// 2. Activate: Clear old cache versions and claim active clients
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.map(key => {
          if (key !== SHELL_CACHE && key !== CONTENT_CACHE) {
            console.log('[SW] Removing stale cache:', key);
            return caches.delete(key);
          }
        })
      );
    })
    .then(() => trimCache(CONTENT_CACHE, MAX_CONTENT_CACHE_ITEMS))
    .then(() => self.clients.claim())
  );
});

// 3. Fetch: Tiered Hybrid Caching Strategy
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  // A. Dynamic APIs -> Network-Only (never stale, avoid quota bloat)
  // All /api/ routes except /api/file and /api/tree are strictly network-only
  if (url.pathname.startsWith('/api/')) {
    if (url.pathname !== '/api/file' && url.pathname !== '/api/tree') {
      return;
    }
  }

  // B. Navigation requests (HTML page loads) -> Network-First, fallback to cached App Shell
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(networkRes => {
          if (networkRes && networkRes.status === 200 && (url.pathname === '/' || url.pathname === '/index.html')) {
            const copy = networkRes.clone();
            event.waitUntil(
              caches.open(SHELL_CACHE).then(cache => cache.put('/', copy)).catch(() => {})
            );
          }
          return networkRes;
        })
        .catch(() => {
          return caches.match('/', { ignoreSearch: true }).then(cached => {
            return cached || caches.match('/index.html', { ignoreSearch: true });
          });
        })
    );
    return;
  }

  // C. Content API (/api/file & /api/tree) -> Network-First with Cache Fallback
  if (url.pathname === '/api/file' || url.pathname === '/api/tree') {
    event.respondWith(
      fetch(req)
        .then(networkRes => {
          if (networkRes && networkRes.status === 200) {
            const copy = networkRes.clone();
            event.waitUntil(
              caches.open(CONTENT_CACHE)
                .then(async cache => {
                  await cache.put(req, copy);
                  await trimCache(CONTENT_CACHE, MAX_CONTENT_CACHE_ITEMS);
                })
                .catch(() => {})
            );
          }
          return networkRes;
        })
        .catch(() => {
          return caches.match(req).then(cached => {
            if (cached) return cached;
            return new Response(JSON.stringify({
              error: '目前處於離線狀態，此經文尚未快取',
              offline: true
            }), {
              status: 503,
              headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
          });
        })
    );
    return;
  }

  // D. Static Assets (CSS, JS, Fonts, Icons, Vendor) -> Stale-While-Revalidate
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(cached => {
      const fetchPromise = fetch(req)
        .then(networkRes => {
          if (networkRes && networkRes.status === 200) {
            const copy = networkRes.clone();
            event.waitUntil(
              caches.open(SHELL_CACHE).then(cache => cache.put(req, copy)).catch(() => {})
            );
          }
          return networkRes;
        })
        .catch(() => null);

      return cached || fetchPromise.then(res => res || new Response('', { status: 504, statusText: 'Gateway Timeout' }));
    })
  );
});

// 4. Message: Support immediate reload on new version
self.addEventListener('message', event => {
  if (event.data && (event.data.type === 'SKIP_WAITING' || event.data.action === 'SKIP_WAITING')) {
    self.skipWaiting();
  }
});
