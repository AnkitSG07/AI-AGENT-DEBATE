/* Smart Handicrafts Operator Call Service Worker - Web Push v36 call-card style */
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
  return phone ? `+${phone}` : 'WhatsApp call';
}

function isWhatsappCallPayload(payload, data) {
  const template = String(data.notificationTemplate || data.template || payload.template || '').toLowerCase();
  const channelType = String(data.channelType || payload.channelType || '').toLowerCase();
  const channelLabel = String(data.channelLabel || payload.channelLabel || '').toLowerCase();
  return template === 'whatsapp_call' || channelType === 'whatsapp_call' || channelLabel.includes('call');
}

function buildTargetUrl(data, payload) {
  return data.url || payload.url || '/operator-notifications';
}

function buildNotificationOptions(payload, data, isCall) {
  const customerName = String(data.customerName || data.customer_name || data.name || payload.customerName || '').trim();
  const phone = data.phone || data.customerPhone || data.customer_phone || data.from || '';
  const callerTitle = customerName || (phone ? formatPhone(phone) : 'WhatsApp Caller');

  const title = isCall ? callerTitle : (payload.title || 'SH Operator Hub');
  const body = isCall
    ? (phone ? `${formatPhone(phone)}\nWhatsApp voice call` : 'WhatsApp voice call')
    : (payload.body || 'New customer message. Tap to open chat.');

  const targetUrl = buildTargetUrl(data, payload);

  const options = {
    body,
    icon: isCall
      ? (payload.icon || data.icon || '/icons/icon-192.png')
      : (payload.icon || '/icons/icon-192.png'),
    badge: isCall
      ? (payload.badge || data.badge || '/icons/badge-96.png')
      : (payload.badge || '/icons/badge-96.png'),
    image: payload.image || data.image || undefined,
    tag: payload.tag || (isCall
      ? (`smart-handicrafts-call-${data.callId || data.call_id || Date.now()}`)
      : (`smart-handicrafts-chat-${data.channelId || 'new'}`)),
    renotify: payload.renotify !== false,
    requireInteraction: isCall ? true : !!payload.requireInteraction,
    timestamp: Date.now(),
    vibrate: payload.vibrate || (isCall ? [280, 90, 280, 90, 280, 90, 500] : [120, 70, 120]),
    data: {
      ...data,
      url: targetUrl,
      notificationTemplate: data.template || payload.template || (isCall ? 'whatsapp_call' : 'chat'),
      isWhatsappCall: isCall ? '1' : '',
      callId: data.callId || data.call_id || '',
      phone: cleanPhone(phone),
      customerName: callerTitle
    },
    actions: isCall
      ? [
          { action: 'decline_call', title: 'Decline' },
          { action: 'answer_call', title: 'Answer' }
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
  const built = buildNotificationOptions(payload, data, isCall);
  event.waitUntil(self.registration.showNotification(built.title, built.options));
});

async function openOrFocusUrl(targetUrl) {
  const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  const target = new URL(targetUrl, self.location.origin);

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

async function rejectWhatsappCall(data) {
  const callId = data.callId || data.call_id || '';
  if (!callId) return;
  try {
    await fetch('/api/whatsapp-calls/reject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ call_id: callId })
    });
  } catch (e) {}
}

self.addEventListener('notificationclick', (event) => {
  const data = (event.notification && event.notification.data) || {};
  const rawUrl = data.url || '/operator-notifications';
  event.notification.close();

  event.waitUntil((async () => {
    if (event.action === 'decline_call') {
      await rejectWhatsappCall(data);
      return;
    }

    // Tap on notification body or Answer button opens the same SH Operator Call app.
    await openOrFocusUrl(rawUrl);
  })());
});
