/* ================================================================
   sw.js — mdWebview Service Worker (Tiered Hybrid Offline Caching)
   - App Shell: Cache-First / Stale-While-Revalidate
   - Sutra Content (/api/render & friends): Network-First with Cache Fallback
   - Search & Admin: Network-Only (no stale cache / quota risk)
   ================================================================ */

const CACHE_VERSION = 'v__APP_VERSION__'; // 由 server 在送出時換成 package.json 的版本
const SHELL_CACHE = `mdwebview-shell-${CACHE_VERSION}`;
const CONTENT_CACHE = `mdwebview-content-${CACHE_VERSION}`;

// Core App Shell Assets required for 0ms boot and offline reader UI
const SHELL_ASSETS = [
  '/',
  '/style.css',
  '/app.js',
  '/library-sync.js',
  '/highlights.js',
  '/kepan-sidebar.js',
  '/share-card.js',
  '/marked.min.js',
  '/i18n/boot.js',
  '/i18n/zh-TW.js',
  '/i18n/zh-CN.js',
  '/i18n/i18n.js',
  '/i18n/content-terms.js',
  '/i18n/display-script.js',
  '/i18n/search-variants.js',
  // 簡體顯示才會載入，但離線時也要能切換，故一併預快取（約 110 KB）
  '/vendor/opencc/t2cn.js',
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
  '/vendor/pele/pele.global.js'
];

const MAX_CONTENT_CACHE_ITEMS = 150;

// 朗讀（TTS）音檔：以內容雜湊為網址、永不改變，所以快取名稱不綁 app 版本——升版時不會被清掉。
// 不放進 CONTENT_CACHE（那裡只留 150 筆）。播放過與預取的句子都會留在這裡，離線也能重聽。
const TTS_CACHE = 'mdwebview-tts-v1';
const TTS_AUDIO_PREFIX = '/api/tts/audio/';
const MAX_TTS_CACHE_ITEMS = 6000; // 每句約 40 KB（AAC 64k），約 240 MB

// Which /api/ endpoints may be stored for offline reading. Everything else
// (search, dictionary, admin…) stays network-only: its answers are
// request-specific and would only bloat the quota.
//
// `/api/render` is the endpoint the reader actually calls for a document's
// HTML, so without it "already-read texts stay readable offline" was not true.
// `/api/section-index` and `/api/render-chunk` are what large (>=1MB) texts use
// instead, so they must be cacheable too or those texts break offline.
const CONTENT_PATHS = [
  '/api/tree',
  '/api/render',
  '/api/section-index',
  '/api/render-chunk'
];

// Query parameters the server ignores when producing a response. Two requests
// differing only in these must share one cache entry: `/api/render` accepts a
// `line` hint that only the client uses for scrolling (the server never reads
// it), so keying on it would store the same document once per scroll position.
const IGNORED_QUERY_PARAMS = ['line'];

/**
 * Build the Cache Storage key for a request, dropping parameters the server
 * ignores. Keeps every meaningful parameter (notably `path`, `from`, `to`), so
 * distinct documents and chunks never collide.
 *
 * The original request is reused as the init so its headers survive: responses
 * carry `Vary: Accept-Encoding`, and Cache Storage matches on the stored
 * request's headers, so a bare `{ method: 'GET' }` key could fail to match the
 * entry it just wrote.
 */
function contentCacheKey(req) {
  const url = new URL(req.url);
  let changed = false;
  for (const name of IGNORED_QUERY_PARAMS) {
    if (url.searchParams.has(name)) {
      url.searchParams.delete(name);
      changed = true;
    }
  }
  return changed ? new Request(url.toString(), req) : req;
}


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
//
// 預快取必須帶上？v= 版本號，否則會與 fetch 時的版本判斷對不上：
// 不帶參數時 CACHE_VERSION 一升版，舊的無參數條目仍可能被 ignoreSearch 命中。
// 這裡統一補上 ?v=<CACHE_VERSION>，讓快取鍵與頁面請求一致。
const VERSIONED_SHELL_ASSETS = SHELL_ASSETS.map(
  u => (u.includes('?') ? u : `${u}?v=${CACHE_VERSION.replace(/^v/, '')}`)
);

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => {
        return Promise.allSettled(
          VERSIONED_SHELL_ASSETS.map(url => cache.add(url).catch(err => {
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
          // Only delete cache names owned by this app. Other applications on
          // the same origin may use the origin-wide Cache Storage namespace.
          const isMdWebviewCache = key.startsWith('mdwebview-shell-') || key.startsWith('mdwebview-content-');
          if (isMdWebviewCache && key !== SHELL_CACHE && key !== CONTENT_CACHE) {
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

  // 0. 朗讀音檔 -> Cache-First（內容不可變）。快取裡存完整的 200 回應；
  //    <audio> 的 Range 請求由這裡切出 206（iOS Safari 沒有 206 會無法播放或拖曳）。
  if (url.pathname.startsWith(TTS_AUDIO_PREFIX)) {
    event.respondWith(handleTtsAudio(event, req, url));
    return;
  }

  // A. Dynamic APIs -> Network-Only (never stale, avoid quota bloat)
  // Everything under /api/ is network-only unless it can be read offline.
  if (url.pathname.startsWith('/api/')) {
    if (!CONTENT_PATHS.includes(url.pathname)) {
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

  // C. Content API (/api/render, /api/tree, /api/section-index,
  //    /api/render-chunk) -> Network-First with Cache Fallback, so texts the
  //    user has already opened stay readable without a network.
  if (CONTENT_PATHS.includes(url.pathname)) {
    const cacheKey = contentCacheKey(req);
    event.respondWith(
      fetch(req)
        .then(networkRes => {
          // Only store plain, fully-successful GET responses. A 206 (range) or
          // an error body must never be replayed as if it were the document.
          if (networkRes && networkRes.status === 200 && req.method === 'GET') {
            const copy = networkRes.clone();
            event.waitUntil(
              caches.open(CONTENT_CACHE)
                .then(async cache => {
                  await cache.put(cacheKey, copy);
                  await trimCache(CONTENT_CACHE, MAX_CONTENT_CACHE_ITEMS);
                })
                .catch(() => {})
            );
          }
          return networkRes;
        })
        .catch(() => {
          return caches.match(cacheKey).then(cached => {
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
  //
  // index.html 走 network-first，所以伺服器一更新，頁面立刻拿到新 HTML；
  // 但若靜態資源照樣回舊快取，就會出現「HTML 是新的、app.js 還是舊的」
  // 的新舊混用狀態。實際發生過：統計表已長出「操作」欄位，按鈕卻不存在，
  // 因為表頭來自新 HTML，而按鈕程式碼在舊 app.js 裡。
  //
  // 因此當請求帶的 ?v= 與本 SW 的 CACHE_VERSION 不一致時，代表頁面比 SW 新，
  // 改走 network-first，確保不會供應過期的 JS／CSS。版本一致時仍走原本的
  // stale-while-revalidate，維持 0ms 啟動。
  const reqVersion = url.searchParams.get('v');
  const swVersion = CACHE_VERSION.replace(/^v/, '');
  if (reqVersion && reqVersion !== swVersion) {
    event.respondWith(
      fetch(req)
        .then(networkRes => {
          if (networkRes && networkRes.status === 200) {
            const copy = networkRes.clone();
            event.waitUntil(
              caches.open(SHELL_CACHE).then(cache => cache.put(req, copy)).catch(() => {})
            );
          }
          return networkRes;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then(
          cached => cached || new Response('', { status: 504, statusText: 'Gateway Timeout' })
        ))
    );
    return;
  }

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

// ── 朗讀音檔 ─────────────────────────────────────────────────────────
// 解析單一位元組範圍；無法使用的標頭回 null（回完整內容），超出範圍回 { unsatisfiable: true }。
function parseTtsRange(header, size) {
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header || '');
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start; let end;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return { unsatisfiable: true };
    start = Math.max(0, size - n); end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (m[2] !== '' && Number(m[2]) < start) return null;
  }
  if (size === 0 || start >= size) return { unsatisfiable: true };
  return { start, end };
}

async function ttsRangeResponse(cached, rangeHeader) {
  if (!rangeHeader) return cached;
  const buf = await cached.arrayBuffer();
  const range = parseTtsRange(rangeHeader, buf.byteLength);
  const type = cached.headers.get('Content-Type') || 'audio/mp4';
  if (!range) return new Response(buf, { status: 200, headers: { 'Content-Type': type, 'Content-Length': String(buf.byteLength), 'Accept-Ranges': 'bytes' } });
  if (range.unsatisfiable) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${buf.byteLength}` } });
  return new Response(buf.slice(range.start, range.end + 1), {
    status: 206,
    headers: {
      'Content-Type': type, 'Content-Length': String(range.end - range.start + 1),
      'Content-Range': `bytes ${range.start}-${range.end}/${buf.byteLength}`, 'Accept-Ranges': 'bytes'
    }
  });
}

async function handleTtsAudio(event, req, url) {
  const key = url.pathname; // 不含查詢字串與 Range：一個 sha 一筆
  const rangeHeader = req.headers.get('range');
  let cache = null;
  try {
    cache = await caches.open(TTS_CACHE);
    const cached = await cache.match(key);
    if (cached) return ttsRangeResponse(cached, rangeHeader);
  } catch (_) { /* Cache Storage 不可用：直接走網路 */ }
  // 快取沒有：向伺服器要完整的檔（不帶 Range），存起來再依原請求回應
  try {
    const full = await fetch(key, { credentials: 'same-origin' });
    if (full.status !== 200 || !/^audio\//i.test(full.headers.get('Content-Type') || '')) return full;
    if (cache) {
      const copy = full.clone();
      // 清理要列出所有鍵，幾千筆時不便宜：大約每 50 次寫入才做一次
      event.waitUntil(cache.put(key, copy).then(() => (Math.random() < 0.02 ? trimCache(TTS_CACHE, MAX_TTS_CACHE_ITEMS) : null)).catch(() => {}));
    }
    return ttsRangeResponse(full, rangeHeader);
  } catch (err) {
    return new Response('', { status: 504, statusText: 'TTS audio unavailable offline' });
  }
}
