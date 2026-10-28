self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

// This worker stays on the Render origin. Call alerts open the Odoo Hub;
// they do not answer, claim a call, or replace a Render tab's active media.
const SH_OPERATOR_HUB_URL = 'https://www.smarthandicrafts.com/livechat-api-test';

function providerCallId(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : '';
  if (typeof value !== 'string' || !value || value.length > 220 || /[\s\u0000-\u001f\u007f]/.test(value)) return '';
  if (/^(?:null|undefined|none|nan|true|false|0)$/i.test(value)) return '';
  try { encodeURIComponent(value); } catch { return ''; }
  return value;
}

function callPhone(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) return '';
  if (typeof value === 'string' && !/^[+\d\s().-]+$/.test(value)) return '';
  const phone = digits(value);
  return /^\d{7,15}$/.test(phone) ? phone : '';
}

function callChannelId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  if (!/^\d+$/.test(String(value))) return '';
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? String(id) : '';
}

function callTarget(data = {}, payload = {}) {
  const sources = [data, data?.data, payload, payload?.data]
    .filter(value => value && typeof value === 'object' && !Array.isArray(value));
  const links = [];
  for (const source of sources) {
    if (typeof source.url !== 'string' || !source.url) continue;
    try {
      const url = new URL(source.url, self.location.origin);
      const oldCallPage = url.origin === self.location.origin && /^\/operator-(?:notifications|call)(?:\.html)?\/?$/.test(url.pathname);
      const hub = new URL(SH_OPERATOR_HUB_URL);
      const hubPage = url.origin === hub.origin && url.pathname === hub.pathname;
      if ((oldCallPage || hubPage) && (['call', 'incoming', 'outgoing', 'transfer', 'rejoin', 'recovery'].includes(String(url.searchParams.get('mode') || '').toLowerCase()) || url.searchParams.has('call_id') || url.searchParams.has('callId'))) links.push(url);
    } catch {}
  }
  // Queued notifications from the previous worker may keep the provider ID
  // only inside data.url. Never use a generic event id or choose another call.
  const rawIds = sources.flatMap(source => [source.callId, source.call_id])
    .concat(links.flatMap(url => url.searchParams.getAll('call_id').concat(url.searchParams.getAll('callId'))))
    .filter(value => value !== undefined && value !== null && value !== '');
  const ids = rawIds.map(providerCallId);
  const invalidTarget = sources.some(source => source.shHubCallTargetInvalid === true);
  const callId = !invalidTarget && ids.length && ids.every(id => id && id === ids[0]) ? ids[0] : '';
  const rawPhones = sources.flatMap(source => [source.phone, source.customerPhone, source.customer_phone, source.from])
    .concat(links.flatMap(url => url.searchParams.getAll('phone'))).filter(value => value !== undefined && value !== null && value !== '');
  const phones = rawPhones.map(callPhone);
  const invalidPhone = sources.some(source => source.shHubCallPhoneInvalid === true) ||
    (phones.length > 0 && !phones.every(phone => phone && phone === phones[0]));
  const phone = !invalidPhone && phones.length ? phones[0] : '';
  const channelKeys = ['channel_id', 'channelId', 'odoo_channel_id'];
  const channels = sources.flatMap(source => channelKeys.map(key => source[key]))
    .concat(links.flatMap(url => channelKeys.flatMap(key => url.searchParams.getAll(key))))
    .filter(value => value !== undefined && value !== null && value !== '').map(callChannelId);
  const invalidChannelId = sources.some(source => source.shHubCallChannelInvalid === true) ||
    (channels.length > 0 && !channels.every(id => id && id === channels[0]));
  const channelId = !invalidChannelId && channels.length ? channels[0] : '';
  const call = !!rawIds.length || !!links.length || sources.some(source => {
    const template = String(source.notificationTemplate || source.template || '').toLowerCase();
    const channelType = String(source.channelType || '').toLowerCase();
    const channelLabel = String(source.channelLabel || '').toLowerCase();
    return template === 'whatsapp_call' || channelType === 'whatsapp_call' || channelLabel.includes('call') || ['call', 'incoming', 'outgoing', 'transfer', 'rejoin', 'recovery'].includes(String(source.mode || '').toLowerCase());
  });
  return { call, callId, phone, channelId, invalidCallId: invalidTarget || (ids.length > 0 && !callId), invalidPhone, invalidChannelId };
}

function specializedHubCallUrl(data = {}, payload = {}) {
  const sources = [data, data?.data, payload, payload?.data]
    .filter(value => value && typeof value === 'object' && !Array.isArray(value));
  const modes = ['transfer', 'rejoin', 'recovery', 'outgoing'];
  const links = [];
  for (const source of sources) {
    if (typeof source.url !== 'string' || !source.url) continue;
    try {
      const url = new URL(source.url, self.location.origin);
      const hub = new URL(SH_OPERATOR_HUB_URL);
      const renderPage = url.origin === self.location.origin && /^\/operator-(?:notifications|call)(?:\.html)?\/?$/.test(url.pathname);
      if (renderPage || (url.origin === hub.origin && url.pathname === hub.pathname)) links.push(url);
    } catch {}
  }
  const values = keys => sources.flatMap(source => keys.map(key => source[key]))
    .concat(links.flatMap(url => keys.flatMap(key => url.searchParams.getAll(key))))
    .filter(value => value !== undefined && value !== null && value !== '');
  const suppliedModes = values(['mode']).map(value => String(value).toLowerCase());
  const explicitModes = suppliedModes.filter(value => modes.includes(value));
  const transferIds = values(['transfer_id', 'transferId']);
  const transferTokens = values(['transfer_token', 'transferToken']);
  const rejoinTokens = values(['rejoin_token', 'rejoinToken']);
  const recoveryTokens = values(['recovery_token', 'recoveryToken']);
  const call = callTarget(data, payload);
  const outgoing = call.call && values(['direction']).some(value => String(value).toLowerCase() === 'outgoing');
  const inferredModes = [...explicitModes];
  if (transferIds.length || transferTokens.length) inferredModes.push('transfer');
  if (rejoinTokens.length) inferredModes.push('rejoin');
  if (recoveryTokens.length) inferredModes.push('recovery');
  if (outgoing) inferredModes.push('outgoing');
  if (!inferredModes.length) return '';
  const uniqueModes = [...new Set(inferredModes)];
  const url = new URL(SH_OPERATOR_HUB_URL);
  if (uniqueModes.length !== 1 || new Set(suppliedModes).size > 1 || call.invalidCallId) return url.toString();
  const mode = uniqueModes[0];
  if (mode === 'transfer') {
    const validTransfer = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
    if (!call.callId || !transferIds.length || !transferIds.every(id => validTransfer(id) && id === transferIds[0])) return url.toString();
    url.searchParams.set('transfer_id', transferIds[0]);
  } else if (mode === 'outgoing') {
    if (!call.phone) return url.toString();
    const name = values(['customer_name', 'customerName', 'name']).find(value => typeof value === 'string');
    if (name) url.searchParams.set('name', name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0,160));
  } else if (!call.callId) {
    return url.toString();
  }
  // The Hub validates its own session and requires a user action. Do not copy
  // a Render session, transfer token, or media-recovery credential into Odoo.
  url.searchParams.set('mode', mode);
  if (call.callId) url.searchParams.set('call_id', call.callId);
  if (call.phone) url.searchParams.set('phone', call.phone);
  if (call.channelId) url.searchParams.set('channel_id', call.channelId);
  return url.toString();
}

function hubChatUrl(data = {}, payload = {}) {
  const sources = [data, data?.data, payload, payload?.data]
    .filter(value => value && typeof value === 'object' && !Array.isArray(value));
  const urls = sources.map(source => source.url).filter(value => typeof value === 'string' && value);
  const links = [];
  for (const value of urls) {
    try {
      const url = new URL(value, self.location.origin);
      const hub = new URL(SH_OPERATOR_HUB_URL);
      const renderPage = url.origin === self.location.origin && /^\/operator-(?:notifications|call)(?:\.html)?\/?$/.test(url.pathname);
      if (renderPage || (url.origin === hub.origin && url.pathname === hub.pathname)) links.push(url);
    } catch {}
  }
  // Preserve unrelated notification destinations, such as a document link.
  if (urls.length && !links.length) return '';
  const keys = ['channel_id', 'channelId', 'channel', 'odoo_channel_id'];
  const rawIds = sources.flatMap(source => keys.map(key => source[key]))
    .concat(links.flatMap(url => keys.flatMap(key => url.searchParams.getAll(key))))
    .filter(value => value !== undefined && value !== null && value !== '');
  const ids = rawIds.map(callChannelId);
  const target = new URL(SH_OPERATOR_HUB_URL);
  if (!sources.some(source => source.shHubChatTargetInvalid === true) && ids.length && ids.every(id => id && id === ids[0])) {
    target.searchParams.set('channel_id', ids[0]);
  }
  return target.toString();
}

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
  return callTarget(data, payload).call;
}

function callUrl(data, payload) {
  const target = callTarget(data, payload);
  const url = new URL(SH_OPERATOR_HUB_URL);
  // A missing, malformed, or conflicting ID opens the Hub without selecting
  // an arbitrary ringing caller by phone or by list position.
  if (!target.callId) return url.toString();
  url.searchParams.set('mode', 'call');
  url.searchParams.set('call_id', target.callId);
  if (target.phone) url.searchParams.set('phone', target.phone);
  if (target.channelId) url.searchParams.set('channel_id', target.channelId);
  return url.toString();
}

function appUrl(data, payload, call) {
  return specializedHubCallUrl(data, payload) || (call ? callUrl(data, payload) : (hubChatUrl(data, payload) || data.url || payload.url || SH_OPERATOR_HUB_URL));
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
    tag: payload.tag || (call ? `sh-call-${callTarget(data, payload).callId || phone || Date.now()}` : `sh-chat-${data.channelId || 'new'}`),
    renotify: true,
    requireInteraction: !!call || !!payload.requireInteraction,
    timestamp: Date.now(),
    vibrate: payload.vibrate || (call ? [280, 90, 280, 90, 500] : [120, 70, 120]),
    data: {
      ...data,
      url: appUrl(data, payload, call),
      notificationTemplate: data.template || payload.template || (call ? 'whatsapp_call' : 'chat'),
      callId: call ? callTarget(data, payload).callId : (data.callId || data.call_id || ''),
      // Keep an invalid push target invalid after top-level payload fields are gone.
      ...(call ? { shHubCallTargetInvalid: callTarget(data, payload).invalidCallId || specializedHubCallUrl(data, payload) === SH_OPERATOR_HUB_URL } : {}),
      ...(call ? { shHubCallPhoneInvalid: callTarget(data, payload).invalidPhone, shHubCallChannelInvalid: callTarget(data, payload).invalidChannelId } : {}),
      ...(!call && hubChatUrl(data, payload) === SH_OPERATOR_HUB_URL ? { shHubChatTargetInvalid: true } : {}),
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
  const target = new URL(rawUrl || SH_OPERATOR_HUB_URL, self.location.origin);
  if (target.origin !== self.location.origin) return clients.openWindow(target.toString());
  // Focus only an exact target. Never reload a client that may own a live call.
  const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of all) {
    try {
      const current = new URL(client.url);
      if (current.toString() === target.toString()) {
        if ('focus' in client) await client.focus();
        return;
      }
    } catch {}
  }
  if (clients.openWindow) return clients.openWindow(target.toString());
}

self.addEventListener('notificationclick', event => {
  const data = event.notification?.data || {};
  event.notification.close();
  const specializedUrl = specializedHubCallUrl(data, {});
  if (specializedUrl) {
    event.waitUntil(clients.openWindow(specializedUrl));
    return;
  }
  if (isCall({}, data)) {
    // Invoke directly from the click, before any async work. Render cannot
    // enumerate/control Odoo clients; opening a cross-origin page can resolve
    // to null on success. Do not retry or navigate an existing Render call tab.
    event.waitUntil(clients.openWindow(callUrl(data, {})));
    return;
  }
  event.waitUntil(openUrl(hubChatUrl(data, {}) || data.url || SH_OPERATOR_HUB_URL));
});
