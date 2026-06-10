// Service Worker for Uncited PWA
// Bump the cache names to force a clean cache on upgrade — the previous
// `v1` ended up holding stale /api responses from an API outage window.
const CACHE_NAME = 'uncited-v2';
const STATIC_CACHE = 'uncited-static-v2';

// Assets to cache immediately on install
const STATIC_ASSETS = [
  '/',
  '/icon.svg',
  '/favicon.ico'
];

// Install event - cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME && name !== STATIC_CACHE)
          .map((name) => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});

// Fetch event - network first, fall back to cache.
// NEVER cache /api/* responses — those are dynamic user-scoped data and
// the server's Cache-Control already handles edge caching. Caching them
// in the SW caused the stuck "empty feed on hard refresh" bug whenever
// an API response briefly 0'd out during a deploy.
self.addEventListener('fetch', (event) => {
  // Skip non-GET requests
  if (event.request.method !== 'GET') {
    return;
  }

  // Skip chrome-extension and other non-http(s) requests
  if (!event.request.url.startsWith('http')) {
    return;
  }

  const url = new URL(event.request.url);
  const isApi = url.pathname.startsWith('/api/');

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (isApi) {
          // API responses — return as-is, do not cache.
          return response;
        }

        // Cache successful non-API responses (static assets, pages).
        if (response.status === 200) {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }

        return response;
      })
      .catch(() => {
        // Network failed. Only serve cached responses for non-API requests —
        // we'd rather fail loudly than show stale user data.
        if (isApi) {
          return new Response('[]', {
            status: 503,
            headers: new Headers({
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
            }),
          });
        }
        return caches.match(event.request).then((cachedResponse) => {
          if (cachedResponse) {
            return cachedResponse;
          }

          // If not in cache and offline, return offline page for navigations
          if (event.request.mode === 'navigate') {
            return caches.match('/');
          }

          return new Response('Offline - content not available', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: new Headers({
              'Content-Type': 'text/plain'
            })
          });
        });
      })
  );
});
