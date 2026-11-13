import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, hkdfSync } from 'node:crypto';
import { createOperatorBrowserAuth, ANDROID_OPERATOR_SCOPES } from './operator-browser-auth.js';
import { createAndroidAccessChallenges } from './operator-android-access.js';

const SECRET = 'synthetic-android-operator-access-secret-abcdefghijklmnopqrstuvwxyz';
const HUB = 'https://www.smarthandicrafts.com', BACKEND = 'https://ai-agent-debate.onrender.com';
const START = 1800000000000, ID = 'android_11111111-2222-3333-4444-555555555555';
const NATIVE = `${ID}.${'A'.repeat(43)}`;
const CHALLENGE_PATH = '/api/operator-browser-auth/android/challenge';
const TOKEN_PATH = '/api/operator-browser-auth/android/token';
const markerPath = value => `/api/whatsapp-calls/recent?operator_device_id=sh_proof_${value}`;
const claimsOf = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
function sign(claims) {
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(SECRET), Buffer.from('sh-operator-browser-auth'),
    Buffer.from('capability-signature-v1'), 32));
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `shb1.${payload}.${createHmac('sha256', key).update(`shb1.${payload}`).digest('base64url')}`;
}
function response() {
  return { statusCode: 200, headers: {}, payload: null, next: 0,
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.payload = value; return this; }
  };
}
function request(path, { method = 'POST', body = {}, origin = HUB, headers = {}, ip = '192.0.2.1' } = {}) {
  return { path: path.split('?')[0], originalUrl: path, url: path, method, body, ip, query: {},
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), ...headers } };
}
function fixture({ verify, authenticate, ...overrides } = {}) {
  let now = START, device = { id: ID, credentialGeneration: 1, tokenExpiresAt: START + 3600000, revokedAt: 0 };
  const routes = new Map(), authentications = [], checks = [];
  const auth = createOperatorBrowserAuth({ secret: SECRET, backendOrigin: BACKEND,
    allowedHubOrigins: [HUB, 'https://smarthandicrafts.com'], androidAccessEnabled: true, clock: () => now,
    authenticateNative: async raw => {
      authentications.push(raw);
      if (authenticate) return authenticate(raw);
      if (raw !== NATIVE) throw Object.assign(Error('invalid credential'), { registryError: true, status: 401 });
      return device;
    },
    verifyAndroidCapability: async proof => { checks.push(proof); return verify ? verify(proof) : device; },
    ...overrides });
  auth.registerRoutes({ get: (path, handler) => routes.set(`GET ${path}`, handler),
    post: (path, handler) => routes.set(`POST ${path}`, handler) });
  async function invoke(path, options) {
    const req = request(path, options), res = response();
    const handler = routes.get(`${req.method} ${req.path}`);
    assert.ok(handler); await handler(req, res); return { req, res };
  }
  async function guard(path, token, { method = 'GET', origin = HUB, body = {} } = {}) {
    const req = request(path, { method, origin, body, headers: token ? { authorization: `Bearer ${token}` } : {} }), res = response();
    await auth.guard(req, res, () => { res.next++; res.json({ ok: true, calls: [{ call_id: 'ordinary-history' }] }); });
    return { req, res };
  }
  async function challenge() {
    const result = await invoke(CHALLENGE_PATH);
    assert.equal(result.res.statusCode, 200); return result.res.payload;
  }
  async function issue() {
    const nonce = await challenge();
    assert.equal((await guard(markerPath(nonce.challenge), NATIVE, { origin: null })).res.statusCode, 200);
    return invoke(TOKEN_PATH, { body: { challenge: nonce.challenge, verifier: nonce.verifier } });
  }
  return { auth, invoke, challenge, guard, issue, authentications, checks,
    at: value => { now = value; }, device: value => { device = value; } };
}

test('challenge needs both independent public nonce and private verifier and is origin-bound and single-use', () => {
  let now = START;
  const store = createAndroidAccessChallenges({ clock: () => now });
  const nonce = store.issue({ origin: HUB, ip: 'test' });
  assert.match(nonce.challenge, /^[A-Za-z0-9_-]{43}$/); assert.match(nonce.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(nonce.challenge, nonce.verifier); assert.equal(nonce.expiresAt, START + 60000);
  const body = { ...nonce, origin: HUB, ip: 'test' };
  assert.throws(() => store.consume(body), { status: 409, code: 'ANDROID_CHALLENGE_PENDING' });
  store.inspectMarker({ challenge: nonce.challenge, ip: 'test' });
  store.acknowledge({ challenge: nonce.challenge, deviceId: ID, credentialGeneration: 1 });
  assert.throws(() => store.consume({ ...body, verifier: nonce.challenge }), { status: 403 });
  assert.throws(() => store.consume({ ...body, origin: 'https://other.invalid' }), { status: 403 });
  assert.deepEqual(store.consume(body), { deviceId: ID, credentialGeneration: 1, expiresAt: nonce.expiresAt });
  assert.throws(() => store.consume(body), { status: 410, code: 'ANDROID_CHALLENGE_EXPIRED' });
  const expired = store.issue({ origin: HUB, ip: 'test' }); now = expired.expiresAt;
  assert.throws(() => store.inspectMarker({ challenge: expired.challenge, ip: 'test' }), { status: 410 });
});

test('challenge state and issue/exchange source rates are bounded without timers', () => {
  let now = START;
  const store = createAndroidAccessChallenges({ clock: () => now, maxChallenges: 2, maxRateKeys: 2, maxPerMinute: 2 });
  store.issue({ origin: HUB, ip: 'one' }); store.issue({ origin: HUB, ip: 'one' });
  assert.throws(() => store.issue({ origin: HUB, ip: 'one' }), { code: 'ANDROID_AUTH_RATE_LIMITED' });
  assert.throws(() => store.issue({ origin: HUB, ip: 'two' }), { code: 'ANDROID_AUTH_RATE_LIMITED' });
  assert.throws(() => store.issue({ origin: HUB, ip: 'three' }), { code: 'ANDROID_AUTH_RATE_LIMITED' });
  now += 60000; assert.ok(store.issue({ origin: HUB, ip: 'three' }));
});

test('feature disabled, missing registry and malformed cross-origin requests fail without proof or history', async () => {
  for (const options of [{ androidAccessEnabled: false }, { androidAccessEnabled: 'true' }, { verifyAndroidCapability: undefined }]) {
    const f = fixture(options);
    assert.equal((await f.invoke(CHALLENGE_PATH)).res.payload.code, 'ANDROID_OPERATOR_ACCESS_DISABLED');
    assert.equal((await f.invoke(TOKEN_PATH)).res.payload.code, 'ANDROID_OPERATOR_ACCESS_DISABLED');
    const marker = await f.guard(markerPath('A'.repeat(43)), NATIVE);
    assert.equal(marker.res.statusCode, 503); assert.equal(marker.res.next, 0);
    assert.equal(f.authentications.length, 0);
  }
  const f = fixture();
  for (const options of [{ origin: null }, { origin: 'https://other.invalid' }, { origin: 'https://smarthandicrafts.com' }])
    assert.equal((await f.invoke(CHALLENGE_PATH, options)).res.statusCode, 403);
  for (const options of [{ body: [] }, { body: null }, { body: { deviceId: ID } },
    { headers: { 'content-type': 'text/plain' } }, { headers: { 'content-type': 'application/jsonp' } }])
    assert.equal((await f.invoke(CHALLENGE_PATH, options)).res.statusCode, 400);
  assert.equal((await f.invoke(CHALLENGE_PATH + '?token=bad')).res.statusCode, 400);
  assert.equal((await f.invoke(TOKEN_PATH, { body: { challenge: 'A'.repeat(43), verifier: 'B'.repeat(43), scopes: ['ai:write'] } })).res.statusCode, 400);
  assert.equal(f.checks.length, 0);
});

test('only a fresh authenticated native marker may prove a nonce and its response contains no capability or verifier', async () => {
  const f = fixture(), nonce = await f.challenge();
  for (const token of [null, 'shb1.invalid.invalid']) {
    const { res } = await f.guard(markerPath(nonce.challenge), token);
    assert.equal(res.statusCode, 403); assert.equal(res.next, 0);
  }
  assert.equal(f.authentications.length, 0);
  const { res } = await f.guard(markerPath(nonce.challenge), NATIVE, { origin: null });
  assert.equal(res.statusCode, 200); assert.equal(res.next, 0);
  assert.deepEqual(res.payload, { ok: true, calls: [] });
  assert.equal(res.headers['x-sh-call-history'], 'sh-call-history-v1');
  assert.equal(f.authentications.length, 1);
  for (const secret of [nonce.verifier, NATIVE, ID]) assert.equal(JSON.stringify(res).includes(secret), false);
  const ordinary = await f.guard('/api/whatsapp-calls/recent', NATIVE, { origin: null });
  assert.equal(ordinary.res.next, 1); assert.equal(ordinary.res.payload.calls[0].call_id, 'ordinary-history');
});

test('all malformed/reserved marker variants stop before ordinary history and expired markers never clear enrollment with 401', async () => {
  const f = fixture(), nonce = await f.challenge(), marker = markerPath(nonce.challenge);
  for (const path of [marker + '&live=1', marker + '&operator_device_id=other',
    marker.replace('recent?', 'logs?'), marker.replace('recent?', 'RECENT?'),
    marker.replace(nonce.challenge, 'bad'), marker + '&verifier=' + nonce.verifier]) {
    const { res } = await f.guard(path, NATIVE);
    assert.equal(res.statusCode, 400, path); assert.equal(res.next, 0);
  }
  assert.equal((await f.guard(marker, NATIVE, { method: 'POST' })).res.statusCode, 400);
  f.at(nonce.expiresAt);
  const expired = await f.guard(marker, NATIVE);
  assert.equal(expired.res.statusCode, 410); assert.equal(expired.res.next, 0);
  assert.equal(f.authentications.length, 0);
});

test('marker device errors distinguish actual revocation from temporary registry failure', async () => {
  for (const [error, status] of [[Object.assign(Error('revoked'), { registryError: true, status: 401 }), 401],
    [Error('private storage details'), 503]]) {
    const f = fixture({ authenticate: async () => { throw error; } }), nonce = await f.challenge();
    const { res } = await f.guard(markerPath(nonce.challenge), NATIVE);
    assert.equal(res.statusCode, status); assert.equal(res.next, 0);
    assert.equal(JSON.stringify(res.payload).includes('private'), false);
  }
});

test('same-device marker retry is idempotent but another enrolled device cannot overwrite its proof', () => {
  const store = createAndroidAccessChallenges({ clock: () => START }), nonce = store.issue({ origin: HUB });
  const marker = { challenge: nonce.challenge, deviceId: ID, credentialGeneration: 1 };
  store.acknowledge(marker); store.acknowledge(marker);
  assert.throws(() => store.acknowledge({ ...marker, credentialGeneration: 2 }), { status: 409 });
  assert.throws(() => store.acknowledge({ ...marker, deviceId: 'different' }), { status: 409 });
});

test('finalization consumes proof before async verification and requires current enrollment again', async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const f = fixture({ verify: async () => {
    entered.resolve(); await release.promise;
    return { id: ID, credentialGeneration: 1, revokedAt: 0, tokenExpiresAt: START + 3600000 };
  } });
  const nonce = await f.challenge(); await f.guard(markerPath(nonce.challenge), NATIVE);
  const body = { challenge: nonce.challenge, verifier: nonce.verifier };
  const pending = f.invoke(TOKEN_PATH, { body }); await entered.promise;
  assert.equal((await f.invoke(TOKEN_PATH, { body })).res.statusCode, 410);
  release.resolve(); const { res } = await pending;
  assert.equal(res.statusCode, 200); assert.equal(f.checks.length, 1);
  const claims = f.auth.verifyToken(res.payload.token, { expectedOrigin: HUB });
  assert.equal(claims.source, 'android'); assert.equal(claims.profile, 'Android operator');
  assert.equal(claims.nativeDeviceId, ID); assert.equal(claims.nativeCredentialGeneration, 1);
  assert.equal(claims.exp, START + 600000); assert.equal(claims.authExpiresAt, claims.exp);
  assert.deepEqual(res.payload.scopes, [...ANDROID_OPERATOR_SCOPES]);
  assert.equal(JSON.stringify(res.payload).includes(NATIVE), false);
  assert.equal(JSON.stringify(claims).includes(nonce.verifier), false);
  assert.equal(JSON.stringify(claims).includes(nonce.challenge), false);
});

test('expiry, revocation or rotation between native proof and finalization deny the grant', async () => {
  for (const device of [null, { id: ID, credentialGeneration: 1, revokedAt: START, tokenExpiresAt: START + 3600000 },
    { id: ID, credentialGeneration: 2, revokedAt: 0, tokenExpiresAt: START + 3600000 },
    { id: ID, credentialGeneration: 1, revokedAt: 0, tokenExpiresAt: START }]) {
    const f = fixture(), nonce = await f.challenge(); await f.guard(markerPath(nonce.challenge), NATIVE);
    f.device(device);
    assert.equal((await f.invoke(TOKEN_PATH, { body: { challenge: nonce.challenge, verifier: nonce.verifier } })).res.statusCode, 401);
  }
  const f = fixture({ verify: async () => {
    f.at(START + 60000); return { id: ID, credentialGeneration: 1, revokedAt: 0, tokenExpiresAt: START + 3600000 };
  } });
  assert.equal((await f.issue()).res.statusCode, 410);
});

test('identity pseudonym stays stable across reauthorization and rotation without disclosing the native credential', async () => {
  const f = fixture(), first = (await f.issue()).res.payload;
  f.device({ id: ID, credentialGeneration: 2, revokedAt: 0, tokenExpiresAt: START + 300000 });
  const second = (await f.issue()).res.payload;
  assert.equal(first.baseDeviceId, second.baseDeviceId);
  assert.notEqual(first.operatorSessionId, second.operatorSessionId);
  assert.equal(second.expiresAt, START + 300000);
  assert.match(first.baseDeviceId, /^web_[a-f0-9]{32}$/); assert.equal(first.baseDeviceId.includes(ID), false);
  assert.equal((await f.invoke('/api/operator-browser-auth/refresh', {
    headers: { authorization: `Bearer ${second.token}` }
  })).res.payload.code, 'ANDROID_ENROLLMENT_PROOF_REQUIRED');
});

test('Android capabilities allow exact mail, document and AI draft operations with fresh checks each time', async () => {
  const f = fixture(), token = (await f.issue()).res.payload.token;
  const paths = [['/api/zoho-mail/status', 'GET'], ['/api/zoho-mail/messages', 'GET'],
    ['/api/zoho-mail/message/1234', 'GET'], ['/api/zoho-mail/send', 'POST'], ['/api/zoho-mail/reply', 'POST'],
    ['/api/odoo-documents/tree', 'GET'], ['/api/odoo-documents/file/42', 'GET'],
    ['/api/odoo-documents/share', 'POST'], ['/api/ai-mode/draft', 'POST']];
  for (const [path, method] of paths) {
    const { req, res } = await f.guard(path, token, { method, body: { deviceId: 'spoofed', operator_name: 'SUDO' } });
    assert.equal(res.next, 1, path); assert.equal(req.operatorAuth.kind, 'browser');
    assert.equal(req.operatorAuth.source, 'android'); assert.equal(req.body.deviceId, claimsOf(token).baseDeviceId);
    assert.equal(req.body.operator_name, 'Android operator');
  }
  assert.equal(f.checks.length, paths.length + 1);
  f.device({ id: ID, credentialGeneration: 1, revokedAt: START, tokenExpiresAt: START + 3600000 });
  assert.equal((await f.guard('/api/ai-mode/draft', token, { method: 'POST' })).res.statusCode, 401);
});

test('Android capabilities never grant call controls, admin, OAuth, contacts, ERP or automated AI or trigger their registry lookups', async () => {
  const f = fixture(), token = (await f.issue()).res.payload.token;
  for (const [path, method] of [
    ['/api/whatsapp-calls/config', 'GET'], ['/api/whatsapp-calls/recent', 'GET'], ['/api/whatsapp-calls/accept', 'POST'],
    ['/api/operator-call-transfer/request', 'POST'], ['/api/operator-devices', 'GET'],
    ['/api/ai-mode', 'GET'], ['/api/ai-mode/global', 'POST'], ['/api/ai-mode/chat', 'POST'], ['/api/ai-mode/draft', 'GET'],
    ['/api/debug/webhooks', 'GET'], ['/api/push/subscribe', 'POST'], ['/api/google-contacts/search', 'GET'],
    ['/api/odoo/partners', 'POST'], ['/api/labels', 'GET'], ['/zoho/auth', 'GET'],
    ['/api/zoho-mail/admin', 'POST'], ['/api/odoo-documents/share', 'DELETE']
  ]) {
    const { res } = await f.guard(path, token, { method });
    assert.equal(res.statusCode, 403, `${method} ${path}`); assert.equal(res.next, 0);
  }
  assert.equal(f.checks.length, 1);
});

test('Android signature, origin, scope and generation claims cannot be used to elevate permissions', async () => {
  const f = fixture(), token = (await f.issue()).res.payload.token, claims = claimsOf(token);
  for (const delta of [{ profile: 'SUDO' }, { source: 'unknown' }, { scopes: ['ai:write'] },
    { scopes: ['calls:write'] }, { nativeCredentialGeneration: 0 }, { baseDeviceId: 'web_' + 'b'.repeat(32) },
    { authExpiresAt: START + 600001 }])
    assert.throws(() => f.auth.verifyToken(sign({ ...claims, ...delta }), { expectedOrigin: HUB }), { code: 'INVALID_BROWSER_CAPABILITY' });
  assert.equal((await f.guard('/api/ai-mode/draft', token, { method: 'POST', origin: 'https://other.invalid' })).res.statusCode, 403);
  const docs = sign({ ...claims, scopes: ['documents:write'] });
  assert.equal((await f.guard('/api/odoo-documents/share', docs, { method: 'POST', body: { channel: 'email' } })).res.payload.code, 'OPERATOR_SCOPE_REQUIRED');
  assert.equal(f.checks.length, 1);
  f.at(START + 600000);
  assert.equal((await f.guard('/api/ai-mode/draft', token, { method: 'POST' })).res.statusCode, 401);
});

test('per-device registry verification is bounded and temporary faults do not expose storage details', async t => {
  const release = Promise.withResolvers(), entered = Promise.withResolvers();
  let mode = 'ready', count = 0;
  const f = fixture({ verify: async () => {
    if (mode === 'fail') throw Error('private storage credential');
    if (mode === 'hang') { count++; if (count === 8) entered.resolve(); await release.promise; }
    return { id: ID, credentialGeneration: 1, revokedAt: 0, tokenExpiresAt: START + 3600000 };
  } });
  const token = (await f.issue()).res.payload.token;
  mode = 'hang';
  const pending = Array.from({ length: 8 }, () => f.guard('/api/zoho-mail/messages', token));
  t.after(() => release.resolve()); await entered.promise;
  assert.equal((await f.guard('/api/zoho-mail/messages', token)).res.statusCode, 429);
  release.resolve(); for (const result of await Promise.all(pending)) assert.equal(result.res.next, 1);
  mode = 'fail';
  const failed = await f.guard('/api/zoho-mail/messages', token);
  assert.equal(failed.res.statusCode, 503); assert.equal(failed.res.payload.code, 'DEVICE_AUTH_UNAVAILABLE');
  assert.equal(JSON.stringify(failed.res.payload).includes('private'), false);
  mode = 'ready'; assert.equal((await f.guard('/api/zoho-mail/messages', token)).res.next, 1);
});
