// Keeps the app itself available offline (map tiles are not cached here,
// beyond what the browser caches on its own). Bump VERSION when files change.
const VERSION = 'v5';
const CACHE = `foraging-fog-map-${VERSION}`;
const SHELL = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest', 'icons/icon.svg',
  'js/app.js', 'js/config.js', 'js/data.js', 'js/drive.js', 'js/fit.js', 'js/fog.js', 'js/geo.js', 'js/parse.js', 'js/store.js',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('foraging-fog-map-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Same-origin files: serve from the network when online (so updates show up),
// fall back to the cache when offline. Everything else goes straight through.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Give the network a few seconds (weak signal in the woods), then use the cache.
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000));
  e.respondWith(
    // no-cache: always check for a newer copy, so an update shows up on the next visit.
    Promise.race([fetch(e.request, { cache: 'no-cache' }), timeout])
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))),
  );
});
