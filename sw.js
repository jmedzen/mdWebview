/* ================================================================
   sw.js — mdWebview Service Worker (Tiered Hybrid Offline Caching)
   - App Shell: Cache-First / Stale-While-Revalidate
   - Sutra Content: Network-First with Cache Fallback
   - Search & Admin: Network-Only (no stale cache / quota risk)
   ================================================================ */

const CACHE_VERSION = 'v3.3.0';
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
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png',
  '/og-preview.png',
  '/vendor/katex/katex.min.css',
  '/vendor/katex/katex.min.js',
  '/vendor/mermaid/mermaid.min.js'
];

// 1. Install: Pre-cache App Shell and skip waiting
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[SW] Pre-cache failed:', err))
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
    }).then(() => self.clients.claim())
  );
});

// 3. Fetch: Tiered Hybrid Caching Strategy
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  // A. Admin & Heavy Search APIs -> Network-Only (never stale, avoid quota bloat)
  if (
    url.pathname.startsWith('/api/admin') ||
    url.pathname.startsWith('/api/search') ||
    url.pathname.startsWith('/api/dict-search')
  ) {
    return;
  }

  // B. Navigation requests (HTML page loads) -> Network-First, fallback to cached App Shell
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(networkRes => {
          if (networkRes && networkRes.status === 200 && (url.pathname === '/' || url.pathname === '/index.html')) {
            const copy = networkRes.clone();
            caches.open(SHELL_CACHE).then(cache => cache.put('/', copy));
          }
          return networkRes;
        })
        .catch(() => {
          return caches.match('/').then(cached => {
            return cached || caches.match('/index.html');
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
            caches.open(CONTENT_CACHE).then(cache => cache.put(req, copy));
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
    caches.match(req).then(cached => {
      const fetchPromise = fetch(req)
        .then(networkRes => {
          if (networkRes && networkRes.status === 200) {
            const copy = networkRes.clone();
            caches.open(SHELL_CACHE).then(cache => cache.put(req, copy));
          }
          return networkRes;
        })
        .catch(() => null);

      return cached || fetchPromise;
    })
  );
});

// 4. Message: Support immediate reload on new version
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
