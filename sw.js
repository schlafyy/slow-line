// Network first so updates show up when online; the cached copy keeps the app opening offline.
// Articles themselves live in localStorage (see app.js), not here.
const CACHE = 'slowline-shell';
const SHELL = ['./', 'index.html', 'app.js', 'manifest.webmanifest', 'icon-180.png', 'icon-512.png',
  'fonts/hind-500-latin.woff2', 'fonts/hind-700-latin.woff2', 'fonts/serif-400-latin.woff2', 'fonts/serif-italic-400-latin.woff2'];
// other font subsets (Greek, accents, Cyrillic) are cached the first time an article needs them

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true })));
});
