/* Smart Handicrafts Operator Call Service Worker - Web Push v37 visual call actions */
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
      title: 'SH Operator Call',
      body: event.data ? event.data.text() : 'New customer message',
      data: {}
    };
  }
}

function cleanPhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function formatPhone(value) {
  const phone = cleanPhone(value);
  return phone ? `+${phone}` : '';
}

function isWhatsappCallPayload(payload, data) {
  const template = String(data.notificationTemplate || data.template || payload.template || '').toLowerCase();
  const channelType = String(data.channelType || payload.channelType || '').toLowerCase();
  const channelLabel = String(data.channelLabel || payload.channelLabel || '').toLowerCase();
  return template === 'whatsapp_call' || channelType === 'whatsapp_call' || channelLabel.includes('call');
}

function operatorAppUrl(data, payload) {
  return data.url || payload.url || '/operator-notifications';
}

function buildNotification(payload, data, isCall) {
  const customerName = String(data.customerName || data.customer_name || data.name || payload.customerName || '').trim();
  const phone = data.phone || data.customerPhone || data.customer_phone || data.from || '';
  const phoneText = formatPhone(phone);
  const title = isCall ? (customerName || phoneText || 'WhatsApp Caller') : (payload.title || 'SH Operator Hub');
  const body = isCall
    ? `${phoneText || 'Incoming WhatsApp call'}\nWhatsApp voice call`
    : (payload.body || 'New customer message. Tap to open chat.');

  const options = {
    body,
    icon: isCall ? (payload.icon || data.icon || '/icons/icon-192.png') : (payload.icon || '/icons/icon-192.png'),
    badge: isCall ? (payload.badge || data.badge || '/icons/badge-96.png') : (payload.badge || '/icons/badge-96.png'),
    image: payload.image || data.image || undefined,
    tag: payload.tag || (isCall ? (`sh-active-whatsapp-call-${data.callId || data.call_id || phone || Date.now()}`) : (`sh-chat-${data.channelId || 'new'}`)),
    renotify: true,
    requireInteraction: isCall ? true : !!payload.requireInteraction,
    timestamp: Date.now(),
    vibrate: payload.vibrate || (isCall ? [280, 90, 280, 90, 280, 90, 500] : [120, 70, 120]),
    data: {
      ...data,
      url: operatorAppUrl(data, payload),
      notificationTemplate: data.template || payload.template || (isCall ? 'whatsapp_call' : 'chat'),
      callId: data.callId || data.call_id || '',
      phone: cleanPhone(phone),
      customerName: customerName || phoneText || 'WhatsApp Caller'
    },
    actions: isCall
      ? [
          { action: 'open_decline_visual', title: 'Decline' },
          { action: 'open_answer_visual', title: 'Answer' }
        ]
      : (payload.actions || [{ action: 'open', title: 'Open Chat' }])
  };

  Object.keys(options).forEach((key) => {
    if (options[key] === undefined || options[key] === '') delete options[key];
  });

  return { title, options };
}

self.addEventListener('push', (event) => {
  const payload = normalizePushPayload(event);
  const data = payload.data || {};
  const isCall = isWhatsappCallPayload(payload, data);
  const built = buildNotification(payload, data, isCall);
  event.waitUntil(self.registration.showNotification(built.title, built.options));
});

async function openOrFocusUrl(rawUrl) {
  const target = new URL(rawUrl || '/operator-notifications', self.location.origin);
  const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });

  for (const client of allClients) {
    try {
      const clientUrl = new URL(client.url);
      if (clientUrl.origin === target.origin && clientUrl.pathname === target.pathname) {
        if ('focus' in client) await client.focus();
        if ('navigate' in client) await client.navigate(target.toString());
        return;
      }
    } catch (e) {}
  }

  if (clients.openWindow) return clients.openWindow(target.toString());
}

self.addEventListener('notificationclick', (event) => {
  const data = (event.notification && event.notification.data) || {};
  const targetUrl = data.url || '/operator-notifications';
  event.notification.close();

  // Decline and Answer are visual call-style buttons only.
  // Both open the main Operator Call app. The real Accept/Reject happens inside the app UI.
  event.waitUntil(openOrFocusUrl(targetUrl));
});
