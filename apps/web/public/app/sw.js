/* Only the public offline document is cached. Account data, app HTML and API responses stay on the network. */
const OFFLINE_CACHE = 'workloom-offline-v1';
const OFFLINE_URL = '/app/offline.html';
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const response = await fetch(OFFLINE_URL, { cache: 'reload', credentials: 'omit' });
    if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) throw new Error('Offline page unavailable');
    const cache = await caches.open(OFFLINE_CACHE);
    await cache.put(OFFLINE_URL, response);
  })());
});
// Updates take over when previous app windows close. Never force a reload while someone is editing.
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(names => Promise.all(names.filter(name => name.startsWith('workloom-offline-') && name !== OFFLINE_CACHE).map(name => caches.delete(name)))));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || event.request.mode !== 'navigate' || url.origin !== self.location.origin || !url.pathname.startsWith('/app/') || url.pathname.startsWith('/app/auth/')) return;
  event.respondWith(fetch(event.request).catch(async () => {
    const cached = await caches.match(OFFLINE_URL, { cacheName: OFFLINE_CACHE });
    return cached ?? Response.error();
  }));
});
