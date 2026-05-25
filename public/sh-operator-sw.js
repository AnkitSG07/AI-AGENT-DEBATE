/* Smart Handicrafts Operator Hub Service Worker - Web Push v9 exact chat opener */
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

  const rawUrl = (event.notification && event.notification.data && event.notification.data.url) || '/operator-notifications';
  let targetUrl = rawUrl;
  try {
    targetUrl = new URL(rawUrl, self.location.origin).toString();
  } catch (e) {}

  event.waitUntil((async () => {
    const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });

    // If the target page is already open, focus it and navigate it to the exact chat URL.
    for (const client of allClients) {
      try {
        const clientUrl = new URL(client.url);
        const target = new URL(targetUrl);
        if (clientUrl.origin === target.origin && clientUrl.pathname === target.pathname) {
          if ('focus' in client) await client.focus();
          if ('navigate' in client) await client.navigate(targetUrl);
          return;
        }
      } catch (e) {}
    }

    // Otherwise open the Operator Hub URL from the push payload.
    if (clients.openWindow) return clients.openWindow(targetUrl);
  })());
});
