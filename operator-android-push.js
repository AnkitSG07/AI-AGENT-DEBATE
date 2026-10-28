// Smart Handicrafts Android push bridge. Server only: never bundle this file or
// a Firebase service-account key in an APK or a public web directory.
import { createHash, createPrivateKey, createSign, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename, unlink, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const ANDROID_PUSH_VERSION = '2026-10-28-android-push-r1';
const PREFIX = '/api/operator-android';
const HUB = 'https://www.smarthandicrafts.com/livechat-api-test';
const OAUTH = 'https://oauth2.googleapis.com/token';
const MAX_DEVICES = 500;
const ALERT_TTL_MS = 30000;
const MAX_RING_AGE_MS = 90000;
const MESSAGE_TTL_MS = 5 * 60000;
const TOKEN_TTL_MS = 30 * 86400000;
const HASH = value => createHash('sha256').update(String(value)).digest('hex');
const equal = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
const text = (value, max) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value) ? value.trim() : '';
const installation = value => /^[A-Za-z0-9_-]{16,120}$/.test(value || '') ? value : '';
const callIdValue = value => typeof value === 'string' && value.length > 0 && value.length <= 220 && !/[\s\u0000-\u001f\u007f]/u.test(value) && !/^(?:undefined|null|false|true)$/i.test(value) ? value : '';
const fcmTokenValue = value => typeof value === 'string' && value.length >= 20 && value.length <= 4096 && /^[A-Za-z0-9_:\-.]+$/.test(value) ? value : '';
const fail = (status, message) => Object.assign(new Error(message), { status });
const fixedHubUrl = id => { const url = new URL(HUB); url.searchParams.set('mode', 'call'); url.searchParams.set('call_id', id); return url.href; };
const positiveId = value => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? String(Number(value)) : '';
const messageHubUrl = id => { const url = new URL(HUB); url.searchParams.set('channel_id', id); url.searchParams.set('channel', id); return url.href; };
const odooDateMs = value => typeof value === 'string' ? Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? value.replace(' ', 'T') + 'Z' : value) : 0;

function configuration(env) {
  const firebase = {
    apiKey: text(env.SH_ANDROID_FIREBASE_API_KEY, 200),
    applicationId: text(env.SH_ANDROID_FIREBASE_APP_ID, 200),
    projectId: text(env.SH_ANDROID_FIREBASE_PROJECT_ID, 120),
    gcmSenderId: text(env.SH_ANDROID_FIREBASE_SENDER_ID, 40)
  };
  const packageName = text(env.SH_ANDROID_PACKAGE_NAME || 'com.smarthandicrafts.operatorhub', 180);
  let account = null;
  try { account = JSON.parse(env.SH_ANDROID_FIREBASE_SERVICE_ACCOUNT_JSON || 'null'); } catch {}
  const publicValid = /^AIza[A-Za-z0-9_-]{20,}$/.test(firebase.apiKey) && /^1:\d+:android:[A-Za-z0-9]+$/.test(firebase.applicationId) &&
    /^[a-z][a-z0-9-]{4,62}$/.test(firebase.projectId) && /^\d{5,30}$/.test(firebase.gcmSenderId) &&
    firebase.applicationId.split(':')[1] === firebase.gcmSenderId && /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName);
  let privateValid = account?.type === 'service_account' && account.project_id === firebase.projectId &&
    typeof account.private_key === 'string' && account.private_key.includes('BEGIN PRIVATE KEY') &&
    typeof account.client_email === 'string' && /^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/.test(account.client_email);
  try { privateValid = !!privateValid && createPrivateKey(account.private_key).asymmetricKeyType === 'rsa'; } catch { privateValid = false; }
  const enabled = env.SH_ANDROID_PUSH_ENABLED === 'true' && publicValid && privateValid;
  const enrollmentCode = text(env.SH_ANDROID_ENROLLMENT_CODE, 256);
  const revokedIds = new Set(String(env.SH_ANDROID_REVOKED_DEVICE_IDS || '').split(',').map(value => value.trim()).filter(Boolean));
  return { firebase, packageName, account, enabled, revokedIds, enrollmentCode: /^[A-Za-z0-9_-]{32,256}$/.test(enrollmentCode) ? enrollmentCode : '' };
}

/** readCall must return the latest exact durable lifecycle, not a webhook row.
 *  Optional handling:true prevents offering a call currently claimed in the Hub.
 *  delivery is an async DI hook only for tests; production always uses FCM HTTPv1.
 */
export function createAndroidPushBridge({ env = process.env, fetchImpl = globalThis.fetch, readCall,
  clock = Date.now, logger = console, devicesPath, delivery, retryDelay = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (typeof readCall !== 'function') throw new TypeError('readCall callback is required');
  const config = configuration(env);
  const path = resolve(devicesPath || env.SH_ANDROID_DEVICES_PATH || './android-operator-devices.json');
  let registry = null, loading = null, serial = Promise.resolve();
  let accessToken = '', accessExpiresAt = 0, accessPromise = null;
  const rates = new Map(), callQueues = new Map(), messageQueues = new Map();
  let sentCount = 0, failedCount = 0;

  async function load() {
    if (registry) return registry;
    if (!loading) loading = (async () => {
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8'));
        if (parsed?.schema !== 1 || !Array.isArray(parsed.devices) || !Array.isArray(parsed.usedEnrollmentHashes) || !Array.isArray(parsed.deliveries)) throw new Error('Invalid registry');
        registry = parsed;
      } catch (error) {
        if (error.code !== 'ENOENT') throw fail(503, 'Android device storage is unavailable.');
        registry = { schema: 1, devices: [], usedEnrollmentHashes: [], deliveries: [] };
      }
      return registry;
    })();
    return loading;
  }
  async function persist(next) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(next), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, path);
      registry = next;
    } catch (error) { await unlink(temporary).catch(() => {}); throw fail(503, 'Android device storage could not be saved.'); }
  }
  function mutate(fn) {
    const operation = serial.then(async () => {
      const before = await load();
      const next = JSON.parse(JSON.stringify(before));
      const result = await fn(next);
      await persist(next);
      return result;
    });
    serial = operation.catch(() => {});
    return operation;
  }
  function configured() { if (!config.enabled) throw fail(503, 'Native Android notifications are not configured on the server.'); }
  function limited(key, max, windowMs = 60000) {
    const now = clock();
    for (const [k, value] of rates) if (value.until <= now) rates.delete(k);
    if (rates.size > 10000) throw fail(429, 'Please wait before trying again.');
    const entry = rates.get(key) || { count: 0, until: now + windowMs };
    entry.count += 1; rates.set(key, entry);
    if (entry.count > max) throw fail(429, 'Please wait before trying again.');
  }
  async function authenticated(req) {
    configured();
    const raw = String(req.headers?.authorization || '');
    if (!/^Bearer [A-Za-z0-9_.-]{45,240}$/.test(raw)) throw fail(401, 'Device enrollment is required.');
    const digest = HASH(raw.slice(7));
    const store = await load();
    const device = store.devices.find(row => equal(row.tokenHash, digest));
    if (!device || device.revokedAt || config.revokedIds.has(device.id) || device.tokenExpiresAt <= clock()) throw fail(401, 'Device enrollment expired or was revoked.');
    limited(`device:${device.id}`, 120);
    return device;
  }
  function route(handler) {
    return async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      try { const output = await handler(req); res.json(output); }
      catch (error) {
        const status = Number(error.status) || 503;
        if (status >= 500) logger.warn?.('Android push route unavailable', { status });
        res.status(status).json({ ok: false, error: status >= 500 && !error.status ? 'Android notification service is temporarily unavailable.' : error.message });
      }
    };
  }
  async function registration(req) {
    configured();
    // req.ip is Express's peer address unless the deployment explicitly configures
    // trusted proxies. Never use caller-supplied X-Forwarded-For here.
    limited(`register:${req.ip || req.socket?.remoteAddress || 'unknown'}`, 8, 15 * 60000);
    const body = req.body || {};
    const id = installation(body.installationId), token = fcmTokenValue(body.fcmToken);
    const code = text(body.enrollmentCode, 256);
    if (!id || !token) throw fail(400, 'A valid installation ID and Firebase token are required.');
    if (!config.enrollmentCode || !equal(HASH(code), HASH(config.enrollmentCode))) throw fail(403, 'The enrollment code is invalid or unavailable.');
    return mutate(store => {
      const codeHash = HASH(config.enrollmentCode);
      if (store.usedEnrollmentHashes.includes(codeHash)) throw fail(409, 'This one-time enrollment code was already used. Ask the administrator for a new code.');
      store.devices = store.devices.filter(row => !row.revokedAt && row.tokenExpiresAt > clock());
      if (store.devices.some(row => row.installationId === id && !row.revokedAt && row.tokenExpiresAt > clock())) throw fail(409, 'This installation is already enrolled.');
      if (store.devices.filter(row => !row.revokedAt && row.tokenExpiresAt > clock()).length >= MAX_DEVICES) throw fail(503, 'The Android device limit has been reached.');
      if (store.usedEnrollmentHashes.length >= 10000) throw fail(503, 'Enrollment history requires administrator maintenance.');
      const deviceId = `android_${randomUUID()}`;
      const deviceToken = `${deviceId}.${randomBytes(32).toString('base64url')}`;
      const expiresAt = clock() + TOKEN_TTL_MS;
      store.devices = store.devices.filter(row => row.installationId !== id);
      store.devices.push({ id: deviceId, installationId: id, tokenHash: HASH(deviceToken), fcmToken: token,
        deviceLabel: text(body.deviceLabel, 120) || 'Android operator device', createdAt: clock(), updatedAt: clock(),
        tokenExpiresAt: expiresAt, revokedAt: 0, receiveCalls: true, receiveChats: true });
      store.usedEnrollmentHashes.push(codeHash);
      return { ok: true, deviceId, deviceToken, expiresAt, version: ANDROID_PUSH_VERSION };
    });
  }
  function exactMinimalCall(id, value) {
    if (!value || callIdValue(value.call_id || value.callId || value.id) !== id || value.direction !== 'incoming') return null;
    const startedAt = Date.parse(value.started_at || value.date || '') || Number(value.timestamp || 0) * 1000;
    const updatedAt = Date.parse(value.updated_at || value.date || '') || Number(value.timestamp || 0) * 1000;
    const active = value.active === true;
    const fresh = startedAt > 0 && startedAt <= clock() + 5000 && clock() - startedAt <= MAX_RING_AGE_MS;
    const answerable = active && fresh && value.answerable === true && value.status === 'incoming_ringing' && value.handling !== true;
    return { callId: id, state: text(value.status, 60) || 'unknown', active, answerable,
      issuedAtMs: updatedAt || clock(), expiresAtMs: Math.min(clock() + ALERT_TTL_MS, startedAt + MAX_RING_AGE_MS),
      hubUrl: fixedHubUrl(id), callerName: text(value.customer_name, 120) || 'WhatsApp customer' };
  }
  async function liveCall(id) { return exactMinimalCall(id, await readCall(id)); }
  function registerRoutes(app) {
    app.get(`${PREFIX}/config`, route(async () => {
      let enrollmentEnabled = false;
      if (config.enabled && config.enrollmentCode) {
        try { enrollmentEnabled = !(await load()).usedEnrollmentHashes.includes(HASH(config.enrollmentCode)); } catch {}
      }
      return { ok: true, enabled: config.enabled, enrollmentEnabled, version: ANDROID_PUSH_VERSION,
        packageName: config.packageName, firebase: config.enabled ? config.firebase : null };
    }));
    app.post(`${PREFIX}/devices/register`, route(registration));
    app.post(`${PREFIX}/devices/token`, route(async req => {
      const device = await authenticated(req), token = fcmTokenValue(req.body?.fcmToken);
      if (!token) throw fail(400, 'A valid Firebase token is required.');
      return mutate(store => {
        const row = store.devices.find(item => item.id === device.id && !item.revokedAt);
        if (!row || row.tokenExpiresAt <= clock()) throw fail(401, 'Device enrollment expired or was revoked.');
        row.fcmToken = token; row.updatedAt = clock();
        if (typeof req.body?.receiveCalls === 'boolean') row.receiveCalls = req.body.receiveCalls;
        if (typeof req.body?.receiveChats === 'boolean') row.receiveChats = req.body.receiveChats;
        return { ok: true, deviceId: row.id, receiveCalls: row.receiveCalls, receiveChats: row.receiveChats !== false, expiresAt: row.tokenExpiresAt };
      });
    }));
    app.post(`${PREFIX}/devices/unregister`, route(async req => {
      const device = await authenticated(req);
      return mutate(store => {
        const row = store.devices.find(item => item.id === device.id);
        if (row) { row.revokedAt = clock(); row.fcmToken = ''; row.updatedAt = clock(); }
        return { ok: true, revoked: true };
      });
    }));
    app.post(`${PREFIX}/devices/test`, route(async req => {
      const device = await authenticated(req);
      limited(`test:${device.id}`, 3);
      if (!device.fcmToken) throw fail(409, 'Refresh this device Firebase token before testing.');
      const testId = randomUUID();
      await send(device, { type: 'sh_operator_test', test_id: testId,
        issued_at_ms: String(clock()), expires_at_ms: String(clock() + MESSAGE_TTL_MS) });
      // FCM acceptance is not device receipt; the app confirms the matching ID
      // only after FirebaseMessagingService actually receives this data message.
      return { ok: true, accepted: true, testId, version: ANDROID_PUSH_VERSION };
    }));
    app.get(`${PREFIX}/calls/:callId`, route(async req => {
      await authenticated(req);
      const id = callIdValue(req.params?.callId);
      if (!id) throw fail(400, 'A valid exact call ID is required.');
      const call = await liveCall(id);
      if (!call) throw fail(404, 'This incoming call is unavailable.');
      return { ok: true, call, version: ANDROID_PUSH_VERSION };
    }));
  }
  async function http(url, options) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    timeout.unref?.();
    try {
      const response = await fetchImpl(url, { ...options, signal: controller.signal, redirect: 'error' });
      const body = await response.json();
      return { response, body };
    }
    finally { clearTimeout(timeout); }
  }
  async function oauthToken() {
    if (accessToken && accessExpiresAt > clock() + 60000) return accessToken;
    if (accessPromise) return accessPromise;
    accessPromise = (async () => {
      const issued = Math.floor(clock() / 1000);
      const head = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ iss: config.account.client_email,
        scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: OAUTH, iat: issued, exp: issued + 3600 })).toString('base64url');
      const input = `${head}.${payload}`;
      const signature = createSign('RSA-SHA256').update(input).sign(config.account.private_key, 'base64url');
      const { response, body } = await http(OAUTH, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${input}.${signature}` }).toString() });
      if (!response.ok || typeof body.access_token !== 'string' || !body.access_token) throw new Error('Firebase server authorization failed');
      accessToken = body.access_token;
      accessExpiresAt = clock() + Math.min(3600, Math.max(60, Number(body.expires_in) || 3600)) * 1000;
      return accessToken;
    })();
    try { return await accessPromise; } finally { accessPromise = null; }
  }
  async function send(device, data) {
    if (delivery) return delivery(device, data);
    const bearer = await oauthToken();
    const { response, body } = await http(`https://fcm.googleapis.com/v1/projects/${config.firebase.projectId}/messages:send`, {
      method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { token: device.fcmToken, data,
        android: { priority: 'HIGH', ttl: data.type !== 'sh_operator_call' ? `${Math.max(1, Math.min(300, Math.ceil((Number(data.expires_at_ms) - clock()) / 1000)))}s` : '30s',
          collapse_key: data.type === 'sh_operator_test' ? `sh-test-${device.id}` : data.type === 'sh_operator_message' ? `sh-chat-${data.channel_id}` : `sh-call-${HASH(data.call_id).slice(0, 32)}`,
          restricted_package_name: config.packageName } } })
    });
    if (response.status === 401) { accessToken = ''; accessExpiresAt = 0; }
    if (!response.ok || typeof body.name !== 'string') {
      const unregistered = body?.error?.details?.some(item => item.errorCode === 'UNREGISTERED');
      throw Object.assign(new Error('Firebase push delivery failed'), { unregistered, status: response.status });
    }
    return { ok: true };
  }
  async function publishOne(id) {
    if (!config.enabled) return { ok: false, skipped: 'not_configured' };
    let current = await liveCall(id);
    if (!current) return { ok: false, skipped: 'not_incoming' };
    const store = await load();
    const previous = store.deliveries.filter(row => row.callId === id);
    const event = current.answerable ? 'incoming' : 'ended';
    if (event === 'ended' && !previous.some(row => row.event === 'incoming')) return { ok: true, skipped: 'not_previously_alerted' };
    // Persisted delivery dedupe also stops a stale delayed webhook re-ringing a
    // terminal call after a server restart. Lifecycle is always re-read above.
    const sentTo = new Set(previous.filter(row => row.event === event).map(row => row.deviceId));
    const incomingTargets = new Set(previous.filter(row => row.event === 'incoming').map(row => row.deviceId));
    const targets = store.devices.filter(row => !row.revokedAt && !config.revokedIds.has(row.id) && row.tokenExpiresAt > clock() && row.fcmToken &&
      (event === 'ended' ? incomingTargets.has(row.id) : row.receiveCalls !== false) && !sentTo.has(row.id));
    let sent = 0, failed = 0, nextTarget = 0;
    async function deliverNext() {
    while (nextTarget < targets.length) {
      const snapshot = targets[nextTarget++];
      // Device revocation and a newly terminal lifecycle must win over queued
      // delivery. Never send an old incoming payload merely because it was queued.
      const device = (await load()).devices.find(row => row.id === snapshot.id && !row.revokedAt && !config.revokedIds.has(row.id) && row.tokenExpiresAt > clock());
      if (!device || !device.fcmToken || (event === 'incoming' && !device.receiveCalls)) continue;
      const currentCall = await liveCall(id);
      if (!currentCall || (event === 'incoming' && !currentCall.answerable)) break;
      const data = { type: 'sh_operator_call', event, call_id: id, state: currentCall.state,
        issued_at_ms: String(clock()), expires_at_ms: String(clock() + ALERT_TTL_MS), hub_url: fixedHubUrl(id) };
      try {
        try { await send(device, data); }
        catch (firstError) {
          if (firstError.unregistered || (firstError.status >= 400 && firstError.status < 500 && ![401, 429].includes(firstError.status))) throw firstError;
          await retryDelay(750);
          const newestDevice = (await load()).devices.find(row => row.id === device.id && !row.revokedAt && row.tokenExpiresAt > clock());
          const newestCall = await liveCall(id);
          if (!newestDevice || !newestDevice.fcmToken || config.revokedIds.has(device.id) ||
              !newestCall || (event === 'incoming' && (!newestCall.answerable || !newestDevice.receiveCalls))) continue;
          if (clock() >= Number(data.expires_at_ms)) continue;
          await send(newestDevice, data);
        }
        await mutate(next => {
          next.deliveries = next.deliveries.filter(row => row.sentAt > clock() - 86400000);
          next.deliveries.push({ callId: id, deviceId: device.id, event, sentAt: clock() });
          if (next.deliveries.length > 10000) next.deliveries = next.deliveries.slice(-10000);
        });
        sent++; sentCount++;
      } catch (error) {
        failed++; failedCount++;
        if (error.unregistered) await mutate(next => {
          const row = next.devices.find(item => item.id === device.id && item.fcmToken === device.fcmToken);
          if (row) { row.fcmToken = ''; row.updatedAt = clock(); }
        });
        logger.warn?.('Android call alert delivery failed', { status: Number(error.status) || 0, unregistered: !!error.unregistered });
      }
    }
    }
    await Promise.all(Array.from({ length: Math.min(4, targets.length) }, deliverNext));
    return { ok: failed === 0, sent, failed };
  }
  function publishCallEvents(rows = []) {
    const ids = [...new Set(rows.map(row => callIdValue(row?.call_id || row?.callId || '')).filter(Boolean))];
    return Promise.all(ids.map(id => {
      const operation = (callQueues.get(id) || Promise.resolve()).catch(() => {}).then(() => publishOne(id));
      callQueues.set(id, operation);
      operation.finally(() => { if (callQueues.get(id) === operation) callQueues.delete(id); }).catch(() => {});
      return operation;
    }));
  }
  function publishMessage({ channel = {}, message = {}, verifiedIncoming = false } = {}) {
    if (!config.enabled) return Promise.resolve({ ok: false, skipped: 'not_configured' });
    const channelId = positiveId(channel.id), messageId = positiveId(message.id);
    const messageAt = odooDateMs(message.date);
    if (verifiedIncoming !== true || !channelId || !messageId || message.model !== 'discuss.channel' ||
        positiveId(message.res_id) !== channelId || !['whatsapp', 'livechat', 'chat'].includes(channel.channel_type) ||
        !messageAt || messageAt > clock() + 5000 || clock() - messageAt > MESSAGE_TTL_MS) {
      return Promise.resolve({ ok: false, skipped: 'not_a_recent_verified_incoming_message' });
    }
    const operation = (messageQueues.get(messageId) || Promise.resolve()).catch(() => {}).then(async () => {
      const store = await load();
      const delivered = new Set(store.deliveries.filter(row => row.messageId === messageId).map(row => row.deviceId));
      const targets = store.devices.filter(row => !row.revokedAt && !config.revokedIds.has(row.id) && row.tokenExpiresAt > clock() && row.fcmToken &&
        row.receiveChats !== false && messageAt >= row.createdAt - 5000 && !delivered.has(row.id));
      let sent = 0, failed = 0, nextTarget = 0;
      async function deliverNextMessage() {
        while (nextTarget < targets.length) {
          const snapshot = targets[nextTarget++];
          const device = (await load()).devices.find(row => row.id === snapshot.id && !row.revokedAt && row.tokenExpiresAt > clock() && row.receiveChats !== false);
          if (!device?.fcmToken || config.revokedIds.has(device.id) || clock() >= messageAt + MESSAGE_TTL_MS) continue;
          const data = { type: 'sh_operator_message', channel_id: channelId, message_id: messageId,
            issued_at_ms: String(clock()), expires_at_ms: String(messageAt + MESSAGE_TTL_MS), hub_url: messageHubUrl(channelId) };
          try {
            try { await send(device, data); }
            catch (firstError) {
              if (firstError.unregistered || (firstError.status >= 400 && firstError.status < 500 && ![401, 429].includes(firstError.status))) throw firstError;
              await retryDelay(750);
              const newest = (await load()).devices.find(row => row.id === device.id && !row.revokedAt && row.tokenExpiresAt > clock() && row.receiveChats !== false);
              if (!newest?.fcmToken || config.revokedIds.has(device.id) || clock() >= Number(data.expires_at_ms)) continue;
              await send(newest, data);
            }
            await mutate(next => {
              next.deliveries = next.deliveries.filter(row => row.sentAt > clock() - 86400000);
              next.deliveries.push({ messageId, channelId, deviceId: device.id, event: 'message', sentAt: clock() });
              if (next.deliveries.length > 10000) next.deliveries = next.deliveries.slice(-10000);
            });
            sent++; sentCount++;
          } catch (error) {
            failed++; failedCount++;
            if (error.unregistered) await mutate(next => {
              const row = next.devices.find(item => item.id === device.id && item.fcmToken === device.fcmToken);
              if (row) { row.fcmToken = ''; row.updatedAt = clock(); }
            });
            logger.warn?.('Android message alert delivery failed', { status: Number(error.status) || 0, unregistered: !!error.unregistered });
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, targets.length) }, deliverNextMessage));
      return { ok: failed === 0, sent, failed };
    });
    messageQueues.set(messageId, operation);
    operation.finally(() => { if (messageQueues.get(messageId) === operation) messageQueues.delete(messageId); }).catch(() => {});
    return operation;
  }
  return { registerRoutes, publishCallEvents, publishMessage, status: () => ({ version: ANDROID_PUSH_VERSION, enabled: config.enabled, sentCount, failedCount }) };
}
