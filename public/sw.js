const CACHE_NAME = 'pnunews-shell-v0.1.78';
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/offline.html',
  '/icons/pnu-logo.v3.png',
  '/reader/styles.v0.1.78.css',
  '/reader/app.v0.1.78.js',
  '/shared/theme.v0.1.78.js',
  '/shared/dock.v0.1.78.js',
  '/shared/live-plan.v0.1.78.js',
  '/fonts/Vazirmatn-Regular.v1.woff2',

  '/fonts/Vazirmatn-Bold.v1.woff2',
];
const CONFIG_CACHE = 'pnunews-config-v1';
const FEED_CACHE = 'pnunews-last-feed-v2';
const IMAGE_CACHE = 'pnunews-images-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)));
});

// A new version waits until the page asks for it (see the update banner in reader/app).
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys
    .filter((key) => key.startsWith('pnunews-') && ![CACHE_NAME, CONFIG_CACHE, FEED_CACHE, IMAGE_CACHE].includes(key))
    .map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

function staleWhileRevalidate(request, cacheName, event) {
  const cachePromise = caches.open(cacheName);
  const update = cachePromise.then(async (cache) => {
    const response = await fetch(request);
    if (response.ok) {
      await cache.put(request, response.clone());
      if (cacheName === IMAGE_CACHE) {
        const keys = await cache.keys();
        await Promise.all(keys.slice(0, Math.max(0, keys.length - 80)).map((key) => cache.delete(key)));
      }
    }
    return response;
  }).catch(() => null);
  event.waitUntil(update.then(() => undefined));
  return cachePromise.then((cache) => cache.match(request)).then((cached) => cached || update).then((response) => response || Response.error());
}

// The feed: paint from the cache first (instant on a weak mobile connection), but never leave it at that.
//  - A plain first-page request is answered from the cache and refreshed in the background for the next visit.
//  - A request carrying `live=` (the page's own "is there anything newer?" check, sent once the first page is on
//    screen, after a resume and by the live channel) always goes to the network and its answer replaces the cached
//    first page, so the next open is already current.
// The cache key never contains `live`, so a check can never evict or hide the entry the next visit will read.
const FEED_CACHE_MAX_ENTRIES = 8;

function feedCacheKey(url) {
  const key = new URL(url.href);
  key.searchParams.delete('live');
  return new Request(key.href);
}

async function fetchFeedFresh(request) {
  // `no-cache` makes the browser revalidate instead of reusing a response its HTTP cache still considers fresh.
  return fetch(request, { cache: 'no-cache' });
}

async function storeFeed(cache, key, response) {
  if (!response.ok) return;
  await cache.put(key, response.clone());
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - FEED_CACHE_MAX_ENTRIES)).map((old) => cache.delete(old)));
}

async function handleFeed(request, url, event) {
  const cache = await caches.open(FEED_CACHE);
  const key = feedCacheKey(url);

  if (url.searchParams.has('live')) {
    const response = await fetchFeedFresh(request);
    event.waitUntil(storeFeed(cache, key, response).catch(() => {}));
    return response;
  }

  const cached = await cache.match(key);
  const update = fetchFeedFresh(request).then(async (response) => {
    await storeFeed(cache, key, response);
    return response;
  }).catch(() => null);
  event.waitUntil(update.then(() => undefined));
  if (cached) return cached;
  return (await update) || Response.error();
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || request.method !== 'GET') return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(async () => {
      const shell = await caches.match('/');
      if (url.pathname === '/' && shell) return shell;
      return await caches.match('/offline.html') || Response.error();
    }));
    return;
  }

  if (url.pathname === '/api/public/config') {
    event.respondWith(staleWhileRevalidate(request, CONFIG_CACHE, event));
    return;
  }

  if (url.pathname === '/api/public/feed') {
    // Only the first page is ever cached; later pages (cursor) always come straight from the network.
    if (url.searchParams.has('cursor')) return;
    event.respondWith(handleFeed(request, url, event));
    return;
  }

  if (url.pathname.startsWith('/media/img/') || url.pathname.startsWith('/media/placeholder/') || url.pathname.startsWith('/covers/')) {
    event.respondWith(staleWhileRevalidate(request, IMAGE_CACHE, event));
    return;
  }

  if (SHELL_ASSETS.includes(url.pathname)) {
    event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
  }
});
