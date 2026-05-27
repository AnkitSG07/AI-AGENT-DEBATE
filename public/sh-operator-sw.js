self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

function readPayload(event) {
  try { return event.data ? event.data.json() : {}; }
  catch { return { title: 'SH Operator Call', body: event.data ? event.data.text() : 'New customer message', data: {} }; }
}

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function plusPhone(value) {
  const p = digits(value);
  return p ? `+${p}` : '';
}

function isCall(payload, data) {
  const template = String(data.notificationTemplate || data.template || payload.template || '').toLowerCase();
  const channelType = String(data.channelType || payload.channelType || '').toLowerCase();
  const channelLabel = String(data.channelLabel || payload.channelLabel || '').toLowerCase();
  return template === 'whatsapp_call' || channelType === 'whatsapp_call' || channelLabel.includes('call');
}

function callUrl(data, payload) {
  const callId = data.callId || data.call_id || payload.callId || payload.call_id || '';
  const phone = digits(data.phone || data.customerPhone || data.customer_phone || data.from || payload.phone || '');
  const name = data.customerName || data.customer_name || data.name || payload.customerName || payload.name || '';
  return `/operator-notifications?mode=call&callId=${encodeURIComponent(callId)}&phone=${encodeURIComponent(phone)}&name=${encodeURIComponent(name)}`;
}

function appUrl(data, payload, call) {
  return call ? callUrl(data, payload) : (data.url || payload.url || '/operator-notifications');
}

function build(payload, data, call) {
  const name = String(data.customerName || data.customer_name || data.name || payload.customerName || '').trim();
  const phone = data.phone || data.customerPhone || data.customer_phone || data.from || '';
  const phoneText = plusPhone(phone);
  const title = call ? (name || phoneText || 'WhatsApp Caller') : (payload.title || 'SH Operator Hub');
  const body = call ? `${phoneText || 'Incoming WhatsApp call'}\nTap to open answer screen` : (payload.body || 'New customer message. Tap to open.');
  const options = {
    body,
    icon: payload.icon || data.icon || '/icons/icon-192.png',
    badge: payload.badge || data.badge || '/icons/badge-96.png',
    tag: payload.tag || (call ? `sh-call-${data.callId || data.call_id || phone || Date.now()}` : `sh-chat-${data.channelId || 'new'}`),
    renotify: true,
    requireInteraction: !!call || !!payload.requireInteraction,
    timestamp: Date.now(),
    vibrate: payload.vibrate || (call ? [280, 90, 280, 90, 500] : [120, 70, 120]),
    data: {
      ...data,
      url: appUrl(data, payload, call),
      notificationTemplate: data.template || payload.template || (call ? 'whatsapp_call' : 'chat'),
      callId: data.callId || data.call_id || '',
      phone: digits(phone),
      customerName: name || phoneText || 'WhatsApp Caller'
    },
    actions: call ? [{ action: 'open_answer', title: 'Open' }] : (payload.actions || [{ action: 'open', title: 'Open' }])
  };
  Object.keys(options).forEach(k => { if (options[k] === undefined || options[k] === '') delete options[k]; });
  return { title, options };
}

self.addEventListener('push', event => {
  const payload = readPayload(event);
  const data = payload.data || {};
  const call = isCall(payload, data);
  const item = build(payload, data, call);
  event.waitUntil(self.registration.showNotification(item.title, item.options));
});

async function openUrl(rawUrl) {
  const target = new URL(rawUrl || '/operator-notifications', self.location.origin);
  const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of all) {
    try {
      const current = new URL(client.url);
      if (current.origin === target.origin && current.pathname === target.pathname) {
        if ('focus' in client) await client.focus();
        if ('navigate' in client) await client.navigate(target.toString());
        return;
      }
    } catch {}
  }
  if (clients.openWindow) return clients.openWindow(target.toString());
}

self.addEventListener('notificationclick', event => {
  const data = event.notification?.data || {};
  event.notification.close();
  event.waitUntil(openUrl(data.url || '/operator-notifications'));
});
