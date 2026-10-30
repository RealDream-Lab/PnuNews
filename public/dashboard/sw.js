// Service worker of the management dashboard (scope /dashboard/). Separate from the reader's /sw.js and with its
// own cache names (pndash-*), so the reader's cleanup never touches it. API calls and uploads are never cached.
const CACHE_NAME = 'pndash-shell-v0.1.44';
const SHELL_ASSETS = [
  '/dashboard/',
  '/offline.html',
  '/icons/pnu-logo.v3.png',
  '/dashboard/styles.v0.1.44.css',
  '/dashboard/dashboard.v0.1.44.js',
  '/shared/theme.v0.1.44.js',
  '/shared/rich-editor.v0.1.44.js',
  '/shared/jalali.v1.js',
  '/fonts/Vazirmatn-Regular.v1.woff2',
  '/fonts/Vazirmatn-Medium.v1.woff2',
  '/fonts/Vazirmatn-Bold.v1.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)));
});

// A new version waits until the page asks for it (the update banner in the dashboard sends SKIP_WAITING).
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key.startsWith('pndash-') && key !== CACHE_NAME).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});

// Versioned files (name.v0.1.44.js, icons .v3.png, fonts .v1.woff2) never change under the same URL.
const VERSIONED = /\.v[\d.]+\.(?:js|css|png|ico|woff2)$/;

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(async () => await caches.match('/offline.html') || Response.error()));
    return;
  }

  if (VERSIONED.test(url.pathname)) {
    event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)));
      }
      return response;
    })));
  }
});
