/* Smart Handicrafts Operator Hub Service Worker - Web Push v11 notification templates */
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

function normalizePushPayload(event) {
  try {
    return event.data ? event.data.json() : {};
  } catch (e) {
    return {
      title: 'SH Operator Hub',
      body: event.data ? event.data.text() : 'New customer message',
      data: {}
    };
  }
}

function notificationActionTitle(payload) {
  const data = payload && payload.data ? payload.data : {};
  const channelType = String(data.channelType || payload.channelType || '').toLowerCase();
  const channelLabel = String(data.channelLabel || payload.channelLabel || '').toLowerCase();

  if (channelType === 'whatsapp' || channelLabel.includes('whatsapp')) return 'Open WhatsApp Chat';
  if (channelType === 'livechat' || channelLabel.includes('live')) return 'Open Live Chat';
  return 'Open Chat';
}

self.addEventListener('push', (event) => {
  const payload = normalizePushPayload(event);
  const data = payload.data || {};

  const title = payload.title || 'SH Operator Hub';
  const body = payload.body || 'New customer message. Tap to open chat.';

  const options = {
    body,
    icon: payload.icon || '/icons/icon-192.png',
    badge: payload.badge || '/icons/badge-96.png',
    tag: payload.tag || ('smart-handicrafts-chat-' + (data.channelId || 'new')),
    renotify: payload.renotify !== false,
    requireInteraction: !!payload.requireInteraction,
    timestamp: Date.now(),
    data: {
      ...data,
      url: data.url || payload.url || '/operator-notifications',
      notificationTemplate: data.template || payload.template || 'chat'
    },
    actions: [
      { action: 'open', title: notificationActionTitle(payload) }
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

    if (clients.openWindow) return clients.openWindow(targetUrl);
  })());
});
