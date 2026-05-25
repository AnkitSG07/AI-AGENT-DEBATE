/* Smart Handicrafts Operator Hub Service Worker - Web Push v6 notification center */
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = { title: 'Smart Handicrafts', body: event.data ? event.data.text() : 'New message' };
  }

  const title = payload.title || 'New customer message';
  const options = {
    body: payload.body || 'Open Operator Hub to reply.',
    icon: payload.icon || '/icons/icon-192.png',
    badge: payload.badge || '/icons/badge-96.png',
    tag: payload.tag || 'smart-handicrafts-chat',
    renotify: payload.renotify !== false,
    requireInteraction: !!payload.requireInteraction,
    data: payload.data || {},
    actions: [
      { action: 'open', title: 'Open Chat' }
    ]
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification && event.notification.data && event.notification.data.url) || '/';

  event.waitUntil((async () => {
    const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      if ('focus' in client) {
        client.focus();
        if ('navigate' in client) {
          try { await client.navigate(url); } catch (e) {}
        }
        return;
      }
    }
    if (clients.openWindow) return clients.openWindow(url);
  })());
});
