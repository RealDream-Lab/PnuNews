const CACHE_NAME = 'pnunews-shell-v0.1.24';
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/offline.html',
  '/icons/pnu-logo.v3.png',
  '/reader/styles.v0.1.24.css',
  '/reader/app.v0.1.24.js',
  '/shared/theme.v0.1.24.js',
  '/shared/dock.v0.1.24.js',
  '/shared/live-plan.v0.1.24.js',
  '/fonts/Vazirmatn-Regular.v1.woff2',

  '/fonts/Vazirmatn-Bold.v1.woff2',
];
const CONFIG_CACHE = 'pnunews-config-v1';
const FEED_CACHE = 'pnunews-last-feed-v1';
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

function staleWhileRevalidate(request, cacheName, event, { singleEntry = false } = {}) {
  const cachePromise = caches.open(cacheName);
  const update = cachePromise.then(async (cache) => {
    const response = await fetch(request);
    if (response.ok) {
      if (singleEntry) {
        const keys = await cache.keys();
        await Promise.all(keys.filter((key) => key.url !== request.url).map((key) => cache.delete(key)));
      }
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
    event.respondWith(staleWhileRevalidate(request, FEED_CACHE, event, { singleEntry: true }));
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
