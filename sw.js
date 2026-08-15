// Scripture Scout service worker — Web Push only.
// Deliberately has NO fetch handler / offline cache: the app is 100% online
// (every screen depends on live Supabase calls), so caching pages here would
// just risk serving stale content. Its only job is to receive and display
// push notifications, and to route a tap back into the app.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
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
