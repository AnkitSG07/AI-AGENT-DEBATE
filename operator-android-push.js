// Smart Handicrafts Android push bridge. Server only: never bundle this file or
// a Firebase service-account key in an APK or a public web directory.
import { createHash, createPrivateKey, createSign, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename, unlink, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { messageNotificationPreview } from './operator-message-preview.js';

export const ANDROID_PUSH_VERSION = '2026-10-31-android-push-r15-message-previews';
const PREFIX = '/api/operator-android';
const HUB = 'https://www.smarthandicrafts.com/livechat-api-test';
const OAUTH = 'https://oauth2.googleapis.com/token';
const MAX_DEVICES = 500;
const ALERT_TTL_MS = 30000;
const MAX_RING_AGE_MS = 90000;
const MESSAGE_TTL_MS = 5 * 60000;
const TOKEN_TTL_MS = 30 * 86400000;
const DELIVERY_LEASE_MS = 60000;
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
const deliverySent = row => row?.state === 'sent' || (!row?.state && Number(row?.sentAt) > 0);
const sameDelivery = (row, value) => row.deviceId === value.deviceId && row.event === value.event &&
  (value.callId ? row.callId === value.callId : row.messageId === value.messageId);

function nativeClientMetadata(req) {
  const body = req.body || {}, headers = req.headers || {};
  const headerBuild = headers['x-sh-native-build'], headerProtocol = headers['x-sh-media-protocol'];
  const hasBody = body.nativeBuild !== undefined || body.mediaProtocol !== undefined;
  const hasHeaders = headerBuild !== undefined || headerProtocol !== undefined;
  if (!hasBody && !hasHeaders) return {};
  const nativeBuild = hasBody ? body.nativeBuild : /^\d{1,6}$/.test(String(headerBuild || '')) ? Number(headerBuild) : NaN;
  const mediaProtocol = hasBody ? body.mediaProtocol : headerProtocol;
  if (!Number.isSafeInteger(nativeBuild) || nativeBuild < 1 || nativeBuild > 100000 || mediaProtocol !== 'sh-room-audio-v1' ||
      hasHeaders && (!/^\d{1,6}$/.test(String(headerBuild || '')) || Number(headerBuild) !== nativeBuild || headerProtocol !== mediaProtocol))
    throw fail(400, 'The native client build and media protocol are invalid or inconsistent.');
  return { nativeBuild, mediaProtocol };
}

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
 *  deviceRegistry is the server-only registry domain adapter. Firestore mode
 *  requires it; a missing/unavailable adapter never falls back to a local file.
 */
export function createAndroidPushBridge({ env = process.env, fetchImpl = globalThis.fetch, readCall,
  clock = Date.now, logger = console, devicesPath, deviceRegistry, delivery, retryDelay = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (typeof readCall !== 'function') throw new TypeError('readCall callback is required');
  const config = configuration(env);
  const storageMode = String(env.SH_ANDROID_REGISTRY_BACKEND || (deviceRegistry ? 'firestore' : 'file')).trim().toLowerCase();
  const useExternalRegistry = storageMode !== 'file' || !!deviceRegistry;
  const path = resolve(devicesPath || env.SH_ANDROID_DEVICES_PATH || './android-operator-devices.json');
  let registry = null, loading = null, serial = Promise.resolve();
  let accessToken = '', accessExpiresAt = 0, accessPromise = null;
  const rates = new Map(), callQueues = new Map(), messageQueues = new Map(), appMessageQueues = new Map();
  let sentCount = 0, failedCount = 0;

  async function registryCall(method, ...args) {
    if (!deviceRegistry || !['file', 'firestore'].includes(storageMode) || typeof deviceRegistry[method] !== 'function') {
      throw fail(503, 'Android device storage is temporarily unavailable.');
    }
    try { return await deviceRegistry[method](...args); }
    catch (error) {
      // A Firestore IAM/auth error describes SERVER storage, not a revoked phone.
      // Never expose SDK text or convert a transient failure into device 401.
      if (error?.registryError === true && [400, 401, 403, 409, 429].includes(Number(error.status))) {
        throw fail(Number(error.status), error.message);
      }
      throw fail(503, 'Android device storage is temporarily unavailable.');
    }
  }

  async function load() {
    if (useExternalRegistry) throw fail(503, 'Local Android storage is disabled.');
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
    })().finally(() => { loading = null; });
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
  const listDevices = async () => useExternalRegistry ? registryCall('listDevices') : (await load()).devices;
  const getDevice = async id => useExternalRegistry ? registryCall('getDevice', id) : (await load()).devices.find(row => row.id === id);
  const getDeliveries = async scope => useExternalRegistry ? registryCall('getDeliveries', scope) :
    (await load()).deliveries.filter(row => scope.callId ? row.callId === scope.callId : row.messageId === scope.messageId);
  function eligibleDevice(row, event) {
    return !!row && !row.revokedAt && !config.revokedIds.has(row.id) && row.tokenExpiresAt > clock() && !!row.fcmToken &&
      (event === 'incoming' ? row.receiveCalls !== false : event === 'message' ? row.receiveChats !== false : true);
  }
  async function claimDelivery(value) {
    if (useExternalRegistry) return registryCall('claimDelivery', value);
    const claimId = randomUUID();
    return mutate(store => {
      const device = store.devices.find(row => row.id === value.deviceId);
      if (!eligibleDevice(device, value.event) || value.expiresAtMs <= clock()) return { claimed: false };
      const current = store.deliveries.find(row => sameDelivery(row, value));
      if (current && (deliverySent(current) || (current.state === 'claimed' && current.claimUntilMs > clock()))) return { claimed: false };
      const deliveryId = HASH(JSON.stringify([value.deviceId, value.callId || '', value.messageId || '', value.event]));
      const next = { ...value, deliveryId, claimId, state: 'claimed', createdAt: current?.createdAt || clock(),
        updatedAt: clock(), claimUntilMs: clock() + DELIVERY_LEASE_MS };
      store.deliveries = store.deliveries.filter(row => !sameDelivery(row, value) &&
        Math.max(Number(row.sentAt) || 0, Number(row.updatedAt) || 0, Number(row.createdAt) || 0) > clock() - 86400000);
      if (store.deliveries.length >= 10000) throw fail(503, 'Android notification storage requires maintenance.');
      store.deliveries.push(next);
      return { claimed: true, claimId, deliveryId, claimUntilMs: next.claimUntilMs, device: { ...device } };
    });
  }
  async function finishDelivery(value) {
    if (useExternalRegistry) return registryCall('finishDelivery', value);
    return mutate(store => {
      const row = store.deliveries.find(item => item.deliveryId === value.deliveryId && item.claimId === value.claimId);
      if (!row || row.state !== 'claimed') return { finished: false };
      row.state = value.outcome; row.updatedAt = clock();
      if (value.outcome === 'sent') row.sentAt = clock();
      return { finished: true };
    });
  }
  async function clearFcmToken(id, expectedFcmToken) {
    if (useExternalRegistry) return registryCall('clearFcmToken', id, expectedFcmToken);
    return mutate(store => {
      const row = store.devices.find(item => item.id === id && item.fcmToken === expectedFcmToken);
      if (row) { row.fcmToken = ''; row.updatedAt = clock(); }
    });
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
    const device = useExternalRegistry ? await registryCall('authenticate', raw.slice(7)) :
      (await load()).devices.find(row => equal(row.tokenHash, digest));
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
        if (status >= 500) res.setHeader('Retry-After', '5');
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
    const nativeClient = nativeClientMetadata(req);
    const id = installation(body.installationId), token = fcmTokenValue(body.fcmToken);
    const code = text(body.enrollmentCode, 256);
    if (!id || !token) throw fail(400, 'A valid installation ID and Firebase token are required.');
    if (useExternalRegistry) {
      const requestId = body.requestId === undefined ? '' : installation(body.requestId);
      if (body.requestId !== undefined && !requestId) throw fail(400, 'A valid enrollment request ID is required.');
      const result = await registryCall('enroll', { installationId: id, fcmToken: token, enrollmentCode: code,
        requestId, deviceLabel: text(body.deviceLabel, 120) || 'Android operator device', ...nativeClient });
      return { ok: true, ...result, version: ANDROID_PUSH_VERSION };
    }
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
        tokenExpiresAt: expiresAt, revokedAt: 0, receiveCalls: true, receiveChats: true, ...nativeClient });
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
  async function liveCall(id) {
    try { return exactMinimalCall(id, await readCall(id)); }
    catch { throw fail(503, 'Call status is temporarily unavailable. Device enrollment is unchanged.'); }
  }
  function registerRoutes(app) {
    app.get(`${PREFIX}/config`, route(async () => {
      let enrollmentEnabled = false, storageAvailable = !useExternalRegistry;
      if (config.enabled && config.enrollmentCode) {
        try {
          enrollmentEnabled = useExternalRegistry ? await registryCall('isEnrollmentAvailable', config.enrollmentCode) :
            !(await load()).usedEnrollmentHashes.includes(HASH(config.enrollmentCode));
          storageAvailable = true;
        } catch { storageAvailable = false; }
      }
      if (config.enabled && useExternalRegistry && typeof deviceRegistry?.checkAvailability === 'function') {
        try { storageAvailable = await registryCall('checkAvailability') === true; }
        catch { storageAvailable = false; }
      }
      return { ok: true, enabled: config.enabled, enrollmentEnabled, version: ANDROID_PUSH_VERSION,
        packageName: config.packageName, firebase: config.enabled ? config.firebase : null, storageAvailable,
        capabilities: { enrollmentInvitations: useExternalRegistry && storageMode === 'firestore' &&
          typeof deviceRegistry?.issueEnrollment === 'function', deviceLeaseRenewal: !useExternalRegistry ||
          (['file', 'firestore'].includes(storageMode) && typeof deviceRegistry?.renewLease === 'function') },
        deviceLeaseTtlMs: TOKEN_TTL_MS };
    }));
    app.post(`${PREFIX}/devices/register`, route(registration));
    app.post(`${PREFIX}/devices/token`, route(async req => {
      const device = await authenticated(req), token = fcmTokenValue(req.body?.fcmToken);
      const nativeClient = nativeClientMetadata(req);
      if (!token) throw fail(400, 'A valid Firebase token is required.');
      if (useExternalRegistry) {
        const value = { fcmToken: token, ...nativeClient };
        if (typeof req.body?.receiveCalls === 'boolean') value.receiveCalls = req.body.receiveCalls;
        if (typeof req.body?.receiveChats === 'boolean') value.receiveChats = req.body.receiveChats;
        return { ok: true, ...await registryCall('updateToken', String(req.headers.authorization).slice(7), value) };
      }
      return mutate(store => {
        const row = store.devices.find(item => item.id === device.id && !item.revokedAt);
        if (!row || row.tokenExpiresAt <= clock()) throw fail(401, 'Device enrollment expired or was revoked.');
        row.fcmToken = token; row.updatedAt = clock(); Object.assign(row, nativeClient);
        if (typeof req.body?.receiveCalls === 'boolean') row.receiveCalls = req.body.receiveCalls;
        if (typeof req.body?.receiveChats === 'boolean') row.receiveChats = req.body.receiveChats;
        return { ok: true, deviceId: row.id, receiveCalls: row.receiveCalls, receiveChats: row.receiveChats !== false, expiresAt: row.tokenExpiresAt };
      });
    }));
    app.post(`${PREFIX}/devices/renew`, route(async req => {
      const device = await authenticated(req);
      // Reusing the same valid bearer makes a lost-response retry safe. This does
      // not revive expired/revoked devices or change a concurrently refreshed FCM token.
      if (useExternalRegistry) return { ok: true, ...await registryCall('renewLease', String(req.headers.authorization).slice(7)) };
      return mutate(store => {
        const row = store.devices.find(item => item.id === device.id && !item.revokedAt);
        if (!row || config.revokedIds.has(row.id) || row.tokenExpiresAt <= clock()) throw fail(401, 'Device enrollment expired or was revoked.');
        row.tokenExpiresAt = Math.max(row.tokenExpiresAt, clock() + TOKEN_TTL_MS); row.updatedAt = clock();
        return { ok: true, deviceId: row.id, expiresAt: row.tokenExpiresAt };
      });
    }));
    app.post(`${PREFIX}/devices/unregister`, route(async req => {
      const device = await authenticated(req);
      if (useExternalRegistry) return { ok: true, ...await registryCall('revoke', String(req.headers.authorization).slice(7)) };
      return mutate(store => {
        const row = store.devices.find(item => item.id === device.id);
        if (row) { row.revokedAt = clock(); row.fcmToken = ''; row.updatedAt = clock(); }
        return { ok: true, revoked: true };
      });
    }));
    app.post(`${PREFIX}/messages/state`, route(async req => {
      await authenticated(req);
      return { ok: true, channels: await registryCall('listAppMessageState', req.body?.channelIds) };
    }));
    for (const action of ['read', 'unread']) app.post(`${PREFIX}/messages/${action}`, route(async req => {
      await authenticated(req);
      const state = await registryCall('changeAppMessageState', String(req.headers.authorization).slice(7),
        { channelId: req.body?.channelId, expectedStateVersion: req.body?.expectedStateVersion,
          ...(action === 'read' ? { throughMessageId: req.body?.throughMessageId } : { unread: true }) });
      return { ok: true, channels: [state], state };
    }));
    app.post(`${PREFIX}/devices/test`, route(async req => {
      const device = await authenticated(req);
      limited(`test:${device.id}`, 3);
      if (!device.fcmToken) throw fail(409, 'Refresh this device Firebase token before testing.');
      const testId = randomUUID();
      try {
        await send(device, { type: 'sh_operator_test', test_id: testId,
          issued_at_ms: String(clock()), expires_at_ms: String(clock() + MESSAGE_TTL_MS) });
      } catch {
        throw fail(503, 'Firebase delivery is temporarily unavailable. Device enrollment is unchanged.');
      }
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
    if (Number(data.expires_at_ms) <= clock()) throw Object.assign(new Error('Notification expired before delivery'), { status: 410 });
    const { response, body } = await http(`https://fcm.googleapis.com/v1/projects/${config.firebase.projectId}/messages:send`, {
      method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { token: device.fcmToken, data,
        android: { priority: 'HIGH', ttl: ['sh_operator_call', 'sh_operator_transfer'].includes(data.type) ? '30s' : `${Math.max(1, Math.min(300, Math.ceil((Number(data.expires_at_ms) - clock()) / 1000)))}s`,
          // Chat messages and call/transfer events are distinct, content-bearing
          // data messages. Per-chat/call collapse keys can both replace content
          // and exceed FCM's four pending keys per token, losing unrelated alerts.
          // Expiry, durable event claims and Android tombstones still reject stale
          // or repeated events, including an End delivered before Incoming.
          ...(data.type === 'sh_operator_test' ? { collapse_key: `sh-test-${device.id}` } : {}),
          restricted_package_name: config.packageName } } })
    });
    if (response.status === 401) { accessToken = ''; accessExpiresAt = 0; }
    if (!response.ok || typeof body.name !== 'string') {
      const unregistered = body?.error?.details?.some(item => item.errorCode === 'UNREGISTERED');
      throw Object.assign(new Error('Firebase push delivery failed'), { unregistered, status: response.status });
    }
    return { ok: true };
  }
  async function deliverNotification({ descriptor, data, stillCurrent = async () => true }) {
    let claim = null, accepted = false, attemptedDevice = null;
    try {
      claim = await claimDelivery({ ...descriptor, expiresAtMs: Number(data.expires_at_ms) });
      if (!claim?.claimed) {
        // A different worker may still own the lease. Its network response is
        // not proof of delivery, so native outbox jobs must retry this case.
        const rows = await getDeliveries(descriptor.callId ? { callId: descriptor.callId } : { messageId: descriptor.messageId });
        const current = rows.find(row => sameDelivery(row, descriptor));
        return current?.state === 'claimed' && !deliverySent(current) ? 'pending' : 'skipped';
      }
      const validDevice = async () => {
        const [device, current] = await Promise.all([getDevice(descriptor.deviceId), stillCurrent()]);
        if (!eligibleDevice(device, descriptor.event) || clock() >= Number(data.expires_at_ms)) return null;
        if (!current || clock() >= Number(data.expires_at_ms) ||
            (claim.claimUntilMs && clock() >= claim.claimUntilMs)) return null;
        return device;
      };
      const cancel = async () => {
        await finishDelivery({ deliveryId: claim.deliveryId, claimId: claim.claimId, outcome: 'cancelled' });
        return 'skipped';
      };
      attemptedDevice = await validDevice();
      if (!attemptedDevice) return await cancel();
      try { await send(attemptedDevice, data); }
      catch (firstError) {
        if (firstError.unregistered || (firstError.status >= 400 && firstError.status < 500 && ![401, 429].includes(firstError.status))) throw firstError;
        await retryDelay(750);
        attemptedDevice = await validDevice();
        if (!attemptedDevice) return await cancel();
        await send(attemptedDevice, data);
      }
      accepted = true;
      const receipt = await finishDelivery({ deliveryId: claim.deliveryId, claimId: claim.claimId, outcome: 'sent' });
      if (receipt?.finished !== true) throw fail(503, 'Notification delivery could not be confirmed in storage.');
      sentCount++;
      return 'sent';
    } catch (error) {
      failedCount++;
      // If FCM accepted but receipt persistence failed, keep the claim until its
      // lease expires. Retrying immediately could duplicate a delivered alert.
      // FCM acceptance + registry commit are not an exactly-once transaction;
      // Android still deduplicates the exact call/message event on receipt.
      if (claim?.claimed && !accepted) {
        await finishDelivery({ deliveryId: claim.deliveryId, claimId: claim.claimId, outcome: 'failed' }).catch(() => {});
      }
      if (error.unregistered && attemptedDevice) {
        await clearFcmToken(attemptedDevice.id, attemptedDevice.fcmToken).catch(() => {});
      }
      logger.warn?.('Android notification delivery unavailable', { status: Number(error.status) || 0, unregistered: !!error.unregistered });
      return 'failed';
    }
  }
  async function publishOne(id) {
    if (!config.enabled) return { ok: false, skipped: 'not_configured' };
    const current = await liveCall(id);
    if (!current) return { ok: false, skipped: 'not_incoming' };
    const [devices, previous] = await Promise.all([listDevices(), getDeliveries({ callId: id })]);
    const event = current.answerable ? 'incoming' : 'ended';
    // A claimed/failed send may have reached FCM despite a lost acknowledgement.
    // Terminal cancellation therefore also covers those exact incoming attempts.
    const incomingTargets = new Set(previous.filter(row => row.event === 'incoming').map(row => row.deviceId));
    if (event === 'ended' && !incomingTargets.size) return { ok: true, skipped: 'not_previously_alerted' };
    const sentTo = new Set(previous.filter(row => row.event === event && deliverySent(row)).map(row => row.deviceId));
    const targets = devices.filter(row => eligibleDevice(row, event) &&
      (event !== 'ended' || incomingTargets.has(row.id)) && !sentTo.has(row.id));
    let sent = 0, failed = 0, nextTarget = 0;
    async function deliverNext() {
      while (nextTarget < targets.length) {
        const snapshot = targets[nextTarget++];
        const latest = await liveCall(id);
        if (!latest || (event === 'incoming' && !latest.answerable)) break;
        const data = { type: 'sh_operator_call', event, call_id: id, state: latest.state,
          issued_at_ms: String(clock()), expires_at_ms: String(clock() + ALERT_TTL_MS), hub_url: fixedHubUrl(id) };
        const outcome = await deliverNotification({ descriptor: { callId: id, deviceId: snapshot.id, event }, data,
          stillCurrent: async () => {
            const call = await liveCall(id);
            return !!call && (event !== 'incoming' || call.answerable);
          } });
        if (outcome === 'sent') sent++;
        if (outcome === 'failed') failed++;
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
  // Called only by the authenticated, durable room-call coordinator. FCM wakes
  // an enrolled client; the client rechecks server state before any call action.
  async function publishRoomEvent({ session, event, transferId = '', toDeviceId = '', expiresAtMs, stillCurrent = async () => true } = {}) {
    const started = performance.now();
    configured();
    const id = callIdValue(session?.id), isTransfer = event === 'transfer-incoming' || event === 'transfer-ended';
    if (!id || !['incoming', 'ended', 'transfer-incoming', 'transfer-ended'].includes(event) ||
        (isTransfer && (!callIdValue(transferId) || !toDeviceId))) throw fail(400, 'A valid exact room-call event is required.');
    const deliveryEvent = event.endsWith('incoming') ? 'incoming' : 'ended';
    // Transfers use a separate bounded deduplication key; the real call and
    // transfer IDs stay in the signed-in client payload, never in credentials.
    const scopeId = isTransfer ? `transfer_${HASH(JSON.stringify([id, transferId]))}` : id;
    const rows = toDeviceId ? [await getDevice(toDeviceId)].filter(Boolean) : await listDevices();
    const targets = rows.filter(row => eligibleDevice(row, deliveryEvent) &&
      row.mediaProtocol === 'sh-room-audio-v1' && row.nativeBuild >= 10 &&
      (!toDeviceId || row.id === toDeviceId));
    let sent = 0, failed = 0;
    await Promise.all(targets.map(async device => {
      const deadline = isTransfer ? expiresAtMs : session.deadlineAt;
      const expiry = deliveryEvent === 'incoming' && Number.isSafeInteger(deadline) ?
        Math.min(clock() + ALERT_TTL_MS, deadline) : clock() + ALERT_TTL_MS;
      if (deliveryEvent === 'incoming' && expiry <= clock()) return;
      const data = { type: isTransfer ? 'sh_operator_transfer' : 'sh_operator_call', engine: 'livekit',
        event: deliveryEvent, call_id: id, issued_at_ms: String(clock()),
        expires_at_ms: String(expiry), hub_url: fixedHubUrl(id) };
      if (isTransfer) data.transfer_id = transferId;
      const outcome = await deliverNotification({ descriptor: { callId: scopeId, deviceId: device.id, event: deliveryEvent }, data, stillCurrent });
      if (outcome === 'sent') sent++;
      if (outcome === 'failed' || outcome === 'pending') failed++;
    }));
    logger.info?.('SH_CALL_PUSH_TIMING', JSON.stringify({ event, elapsedMs: Math.round(performance.now() - started), sent, failed }));
    if (failed) throw fail(503, 'Native call alerts will retry after notification delivery recovers.');
    return { ok: true, sent, failed };
  }
  async function observeIncomingMessages({ channel = {}, messages = [], verifiedIncoming = false, seedExisting = false } = {}) {
    const channelId = positiveId(channel.id);
    if (verifiedIncoming !== true || !channelId || !['whatsapp', 'livechat', 'chat'].includes(channel.channel_type) || !Array.isArray(messages)) return;
    const ids = messages.slice(0, 100).filter(message => {
      const at = odooDateMs(message?.date);
      return positiveId(message?.id) && message?.model === 'discuss.channel' && positiveId(message?.res_id) === channelId &&
        at > 0 && at <= clock() + 5000 && (seedExisting === true || clock() - at <= MESSAGE_TTL_MS);
    }).map(message => Number(message.id));
    if (!ids.length || !useExternalRegistry || typeof deviceRegistry?.observeAppMessages !== 'function') return;
    let queued = appMessageQueues.get(channelId);
    if (queued) {
      ids.forEach(id => queued.ids.add(id));
      while (queued.ids.size > 100) queued.ids.delete(Math.min(...queued.ids));
      return queued.promise;
    }
    if (appMessageQueues.size >= 1000) { logger.warn?.('SH_APP_MESSAGE_STATE busy'); return; }
    queued = { ids: new Set(ids), promise: null };
    appMessageQueues.set(channelId, queued);
    queued.promise = Promise.resolve().then(async () => {
      while (queued.ids.size) {
        const messageIds = [...queued.ids]; queued.ids.clear();
        await registryCall('observeAppMessages', { channelId: Number(channelId), messageIds });
      }
    }).catch(() => { logger.warn?.('SH_APP_MESSAGE_STATE unavailable'); })
      .finally(() => { if (appMessageQueues.get(channelId) === queued) appMessageQueues.delete(channelId); });
    return queued.promise;
  }
  function publishMessage({ channel = {}, message = {}, verifiedIncoming = false } = {}) {
    const started = performance.now();
    const report = (outcome, counts = {}) => {
      // Counts and fixed labels only: no text, names, phone/chat/message/device
      // IDs, push tokens, credentials or arbitrary exception messages.
      try { logger.info?.('SH_MESSAGE_PUSH', JSON.stringify({ outcome, ...counts, elapsedMs: Math.round(performance.now() - started) })); } catch { /* diagnostics only */ }
    };
    if (!config.enabled) { report('not_configured'); return Promise.resolve({ ok: false, skipped: 'not_configured' }); }
    const channelId = positiveId(channel.id), messageId = positiveId(message.id);
    const messageAt = odooDateMs(message.date);
    if (verifiedIncoming !== true || !channelId || !messageId || message.model !== 'discuss.channel' ||
        positiveId(message.res_id) !== channelId || !['whatsapp', 'livechat', 'chat'].includes(channel.channel_type) ||
        !messageAt || messageAt > clock() + 5000 || clock() - messageAt > MESSAGE_TTL_MS) {
      report('not_a_recent_verified_incoming_message');
      return Promise.resolve({ ok: false, skipped: 'not_a_recent_verified_incoming_message' });
    }
    const operation = (messageQueues.get(messageId) || Promise.resolve()).catch(() => {}).then(async () => {
      // Unread persistence is separately retried by the trusted worker. A slow
      // ledger transaction must not delay Firebase delivery to the phone.
      void observeIncomingMessages({ channel, messages: [message], verifiedIncoming });
      const [devices, previous] = await Promise.all([listDevices(), getDeliveries({ messageId })]);
      const delivered = new Set(previous.filter(deliverySent).map(row => row.deviceId));
      const eligible = devices.filter(row => eligibleDevice(row, 'message') && messageAt >= row.createdAt - 5000);
      const targets = eligible.filter(row => !delivered.has(row.id));
      let sent = 0, failed = 0, pending = 0, skipped = 0, nextTarget = 0;
      async function deliverNextMessage() {
        while (nextTarget < targets.length) {
          const snapshot = targets[nextTarget++];
          if (clock() >= messageAt + MESSAGE_TTL_MS) break;
          const data = { type: 'sh_operator_message', channel_id: channelId, message_id: messageId,
            issued_at_ms: String(clock()), expires_at_ms: String(messageAt + MESSAGE_TTL_MS), hub_url: messageHubUrl(channelId) };
          // Existing R13/R14 devices retain their ID-only envelope. New clients
          // explicitly support the requested sender/text conversation previews.
          if (snapshot.nativeBuild >= 15) Object.assign(data, messageNotificationPreview(channel, message),
            { message_at_ms: String(messageAt), preview_protocol: 'sh-message-preview-v1' });
          const outcome = await deliverNotification({ descriptor: { messageId, channelId, deviceId: snapshot.id, event: 'message' }, data });
          if (outcome === 'sent') sent++;
          if (outcome === 'failed') failed++;
          if (outcome === 'pending') pending++;
          if (outcome === 'skipped') skipped++;
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, targets.length) }, deliverNextMessage));
      report(!targets.length ? eligible.length ? 'already_delivered' : 'no_eligible_devices' : failed || pending ? 'delivery_incomplete' : 'processed',
        { devices: devices.length, eligible: eligible.length, targets: targets.length, sent, failed, pending, skipped });
      return { ok: failed === 0, sent, failed };
    });
    messageQueues.set(messageId, operation);
    operation.catch(() => { report('storage_or_processing_failed'); });
    operation.finally(() => { if (messageQueues.get(messageId) === operation) messageQueues.delete(messageId); }).catch(() => {});
    return operation;
  }
  return { registerRoutes, publishCallEvents, publishRoomEvent, publishMessage, observeIncomingMessages, status: () => ({ version: ANDROID_PUSH_VERSION, enabled: config.enabled, storageMode, sentCount, failedCount }) };
}
