// Uygulama kabuğunu önbelleğe alır; veri istekleri her zaman ağdan gelir.
const CACHE = 'coktumu-v1';
const SHELL = ['/', '/styles.css', '/app.js', '/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (/^\/(api|ui|internal|discord)\//.test(url.pathname)) return;
  const isPage = e.request.mode === 'navigate';
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && (isPage || SHELL.includes(url.pathname))) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(isPage ? '/' : e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(isPage ? '/' : e.request)),
  );
});
