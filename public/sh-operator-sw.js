/* Smart Handicrafts Operator Hub Service Worker - Web Push v27 call receiver */
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
  const template = String(data.notificationTemplate || data.template || payload.template || '').toLowerCase();
  const channelType = String(data.channelType || payload.channelType || '').toLowerCase();
  const channelLabel = String(data.channelLabel || payload.channelLabel || '').toLowerCase();

  if (template === 'whatsapp_call' || channelType === 'whatsapp_call' || channelLabel.includes('call')) return 'Answer Call';
  if (channelType === 'whatsapp' || channelLabel.includes('whatsapp')) return 'Open WhatsApp Chat';
  if (channelType === 'livechat' || channelLabel.includes('live')) return 'Open Live Chat';
  return 'Open Chat';
}

self.addEventListener('push', (event) => {
  const payload = normalizePushPayload(event);
  const data = payload.data || {};
  const template = String(data.notificationTemplate || data.template || payload.template || '').toLowerCase();
  const isCall = template === 'whatsapp_call' || String(data.channelType || '').toLowerCase() === 'whatsapp_call';

  const title = payload.title || (isCall ? 'Incoming WhatsApp Call' : 'SH Operator Hub');
  const body = payload.body || (isCall ? 'Tap to answer in Operator Call.' : 'New customer message. Tap to open chat.');

  const options = {
    body,
    icon: payload.icon || '/icons/icon-192.png',
    badge: payload.badge || '/icons/badge-96.png',
    image: payload.image || data.image || undefined,
    tag: payload.tag || (isCall ? ('smart-handicrafts-call-' + (data.callId || Date.now())) : ('smart-handicrafts-chat-' + (data.channelId || 'new'))),
    renotify: payload.renotify !== false,
    requireInteraction: isCall ? true : !!payload.requireInteraction,
    timestamp: Date.now(),
    vibrate: payload.vibrate || (isCall ? [250, 90, 250, 90, 250, 90, 400] : [120, 70, 120]),
    data: {
      ...data,
      url: data.url || payload.url || (isCall ? '/operator-call' : '/operator-notifications'),
      notificationTemplate: data.template || payload.template || (isCall ? 'whatsapp_call' : 'chat')
    },
    actions: payload.actions || [
      { action: 'open', title: notificationActionTitle(payload) }
    ]
  };

  Object.keys(options).forEach((key) => {
    if (options[key] === undefined || options[key] === '') delete options[key];
  });

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
    const target = new URL(targetUrl);

    for (const client of allClients) {
      try {
        const clientUrl = new URL(client.url);
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
