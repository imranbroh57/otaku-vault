// Otaku Vault Service Worker — v5 (random picker; v4 was the features update)
// v1 never cached anything (caches.match on an always-empty cache) and
// index.html never registered the worker at all, so offline mode was broken.
// This version precaches the app shell and uses:
//  - cache-first for same-origin static files (icons, js, manifest)
//  - network-first with cache fallback for page navigations
//  - network-only for API calls (AniList / Firebase are POST or cross-origin)

const CACHE_NAME = 'otaku-vault-v15';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon.png',
  './icon-192.png',
  './icon-512.png',
  './welcome-voice.mp3',
  './favicon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; // never intercept AniList/Firebase POSTs

  const url = new URL(req.url);

  // Page navigation: fresh page when online, cached shell when offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Same-origin static files: serve from cache, refresh in background.
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(req).then((cached) => {
        const network = fetch(req).then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // Cross-origin GET (cover images, fonts): network, fall back to cache.
  e.respondWith(fetch(req).catch(() => caches.match(req)));
});

// v10.4: Web Push — show the notification the push helper sends.
self.addEventListener('push', (e) => {
  let data = { title: 'Otaku Vault', body: 'A new episode is out!' };
  try {
    if (e.data) data = Object.assign(data, e.data.json());
  } catch (err) { /* keep the defaults */ }
  const options = {
    body: data.body,
    icon: './icon-192.png',
    badge: './icon-192.png',
    data: { url: data.url || './' }
  };
  e.waitUntil(self.registration.showNotification(data.title, options));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) {
          if (c.navigate) c.navigate(target).catch(() => {});
          return c.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(target);
    })
  );
});
