// Scripture Scout service worker.
// Two jobs: (1) receive and display Web Push notifications, and (2) keep the
// app shell (page, icons, mascot images, the bundled Supabase library) in a
// cache so the app still opens with no connection. Live data (everything on
// Supabase) is never cached here: those requests go straight to the network
// and the app shows its own offline message when they fail.

// Bump this when the list of cached files changes. Old caches are deleted on activate.
const SHELL_CACHE = 'ss-shell-v1';
const FONT_CACHE = 'ss-fonts-v1';

const SHELL_FILES = [
  './',
  'index.html',
  'site.webmanifest',
  'vendor/supabase-js-2.119.0.js',
  'favicon.ico',
  'favicon-96x96.png',
  'apple-touch-icon.png',
  'web-app-manifest-192x192.png',
  'web-app-manifest-512x512.png',
  'randy-default.webp',
  'randy-happy.webp',
  'randy-sad.webp',
  'randy-thinking.webp',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // One missing file must not block the whole install.
    await Promise.allSettled(SHELL_FILES.map(f => cache.add(new Request(f, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = [SHELL_CACHE, FONT_CACHE];
    const names = await caches.keys();
    await Promise.all(names.filter(n => n.startsWith('ss-') && !keep.includes(n)).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Fonts: show the cached copy straight away, refresh it in the background.
  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith((async () => {
      const cache = await caches.open(FONT_CACHE);
      const hit = await cache.match(req);
      const refresh = fetch(req).then(res => { if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()); return res; }).catch(() => null);
      return hit || (await refresh) || Response.error();
    })());
    return;
  }

  // Only same-origin requests below. Supabase and everything else go straight to the network.
  if (url.origin !== self.location.origin) return;

  // The page itself: network first so updates arrive, cached copy when offline.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      try {
        const res = await fetch(req);
        if (res && res.ok && (url.pathname.endsWith('/') || url.pathname.endsWith('index.html'))) cache.put('index.html', res.clone());
        return res;
      } catch (e) {
        const hit = await cache.match('index.html') || await cache.match('./');
        if (hit) return hit;
        throw e;
      }
    })());
    return;
  }

  // Static files (images, manifest): cached copy first, refreshed quietly in the background so
  // a changed image shows up next time. The bundled library has its version in its name, so it never needs refreshing.
  const cacheable = /\.(png|webp|svg|ico|js|json|webmanifest|css)$/.test(url.pathname);
  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const hit = await cache.match(req);
    const refresh = () => fetch(req).then(res => { if (res && res.ok && cacheable) cache.put(req, res.clone()); return res; });
    if (hit) {
      if (!url.pathname.includes('/vendor/')) event.waitUntil(refresh().catch(() => {}));
      return hit;
    }
    return refresh();
  })());
});

self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (e) { payload = { body: event.data ? event.data.text() : '' }; }

  const title = payload.title || 'Scripture Scout';
  const options = {
    body: payload.body || '',
    icon: payload.icon || '/web-app-manifest-192x192.png',
    badge: payload.badge || '/favicon-96x96.png',
    tag: payload.tag || undefined,
    data: payload.data || {},
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      const clientUrl = new URL(client.url);
      if (clientUrl.origin === self.location.origin && 'focus' in client) {
        client.postMessage({ type: 'notification-click', data: event.notification.data || {} });
        return client.focus();
      }
    }
    return self.clients.openWindow(targetUrl);
  })());
});
