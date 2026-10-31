import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, hkdfSync } from 'node:crypto';
import vm from 'node:vm';
import {
  createOperatorBrowserAuth, constantTimePasswordEqual, createProfileLoginLimiter,
  isProtectedOperatorPath, projectNativeCallHistory, OPERATOR_BROWSER_TOKEN_TTL_MS
} from './operator-browser-auth.js';

const SECRET = 'test-only-operator-profile-secret-abcdefghijklmnopqrstuvwxyz';
const HUB = 'https://www.smarthandicrafts.com';
const BACKEND = 'https://ai-agent-debate.onrender.com';
const OTHER = 'https://other.invalid';
const START = 1800000000000;
const NATIVE_ID = 'android_11111111-2222-3333-4444-555555555555';
const NATIVE_TOKEN = `${NATIVE_ID}.${'A'.repeat(43)}`;

function request(path, { method = 'GET', headers = {}, body, session, ip = '192.0.2.1' } = {}) {
  const query = Object.fromEntries(new URL(path, BACKEND).searchParams);
  return { originalUrl: path, url: path, path: path.split('?')[0], method,
    headers: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])),
    body, session, ip, query };
}
function response() {
  return { statusCode: 200, headers: {}, payload: undefined, next: 0,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.payload = value; return this; },
    send(value) { this.payload = value; return this; }
  };
}
function fixture(options = {}) {
  let now = START;
  const routes = new Map();
  const authenticated = [];
  const auth = createOperatorBrowserAuth({ secret: SECRET, backendOrigin: BACKEND,
    allowedHubOrigins: [HUB], clock: () => now, readProfileSession: req => req.session,
    authenticateNative: async raw => { authenticated.push(raw); return { id: NATIVE_ID, tokenExpiresAt: now + 60000, revokedAt: 0 }; },
    ...options });
  auth.registerRoutes({ get: (path, handler) => routes.set(`GET ${path}`, handler),
    post: (path, handler) => routes.set(`POST ${path}`, handler) });
  const invoke = async (path, opts = {}) => {
    const req = request(path, opts), res = response();
    const handler = routes.get(`${req.method} ${req.path}`);
    assert.ok(handler, `No handler for ${req.method} ${req.path}`);
    await handler(req, res); return { req, res };
  };
  const issue = async (opts = {}) => invoke('/api/operator-browser-auth/token', { method: 'POST',
    headers: { Origin: BACKEND, 'X-SH-Operator-Auth': '1' }, body: { origin: HUB },
    session: { profile: 'Smart handicrafts', exp: START + 7200000 }, ...opts });
  const guard = async (path, opts = {}, payload) => {
    const req = request(path, opts), res = response();
    await auth.guard(req, res, () => { res.next++; if (payload !== undefined) res.json(payload); });
    return { req, res };
  };
  return { auth, routes, issue, invoke, guard, authenticated, now: () => now, at: value => { now = value; } };
}
const browserHeaders = token => ({ Authorization: `Bearer ${token}`, Origin: HUB });
const claimsOf = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
function signedClaims(claims) {
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(SECRET), Buffer.from('sh-operator-browser-auth'),
    Buffer.from('capability-signature-v1'), 32));
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `shb1.${payload}.${createHmac('sha256', key).update(`shb1.${payload}`).digest('base64url')}`;
}

test('issuer requires a verified allowed Render profile, exact origin, and action header', async () => {
  const f = fixture();
  for (const opts of [
    { session: null }, { session: { profile: 'Accounts', exp: START + 10000 } },
    { session: { profile: 'SUDO', exp: START } },
    { headers: { Origin: HUB, 'X-SH-Operator-Auth': '1' } },
    { headers: { Origin: BACKEND } },
    { headers: { Origin: `${BACKEND}.evil.invalid`, 'X-SH-Operator-Auth': '1' } },
    { body: { origin: `${HUB}/` } }, { body: { origin: OTHER } }
  ]) {
    const { res } = await f.issue(opts);
    assert.ok([400, 401, 403].includes(res.statusCode)); assert.equal(res.payload.token, undefined);
    assert.equal(res.headers['cache-control'], 'no-store');
  }
  for (const profile of ['Smart handicrafts', 'SUDO']) {
    const { res } = await f.issue({ session: { profile, exp: START + 7200000 } });
    assert.equal(res.statusCode, 200); assert.equal(f.auth.verifyToken(res.payload.token).profile, profile);
  }
});

test('issuer creates server identity, short fixed-purpose scope and bounded absolute lease', async () => {
  const f = fixture();
  const { res } = await f.issue({ body: { origin: HUB, operatorDeviceId: 'attacker', profile: 'SUDO', scopes: ['admin'], exp: START + 999999999 } });
  assert.equal(res.statusCode, 200);
  const c = f.auth.verifyToken(res.payload.token, { expectedOrigin: HUB });
  assert.match(c.baseDeviceId, /^web_[a-f0-9]{32}$/); assert.match(c.operatorSessionId, /^tab_[a-f0-9]{24}$/);
  assert.equal(c.operatorDeviceId, `${c.baseDeviceId}::${c.operatorSessionId}`);
  assert.deepEqual(c.scopes, ['calls:read', 'calls:write', 'mail:read', 'mail:write', 'contacts:read', 'contacts:write',
    'documents:read', 'documents:write', 'ai:read', 'ai:write']); assert.equal(c.profile, 'Smart handicrafts');
  assert.equal(c.exp - c.iat, OPERATOR_BROWSER_TOKEN_TTL_MS); assert.equal(c.authExpiresAt, START + 7200000);
  assert.equal(c.aud, 'sh-operator-legacy-calls'); assert.equal(c.iss, BACKEND);
  assert.equal(Object.isFrozen(c), true);
});

test('fresh grant cannot outlive the verified profile expiry or two hours', async () => {
  const f = fixture();
  const short = await f.issue({ session: { profile: 'SUDO', exp: START + 30000 } });
  assert.equal(short.res.payload.expiresAt, START + 30000); assert.equal(short.res.payload.authExpiresAt, START + 30000);
  const long = await f.issue({ session: { profile: 'SUDO', exp: START + 999999999 } });
  assert.equal(long.res.payload.authExpiresAt, START + 7200000);
});

test('reconnect recovers expired short access only under a current matching profile and original absolute lease', async () => {
  const f = fixture(), first = (await f.issue()).res.payload, before = claimsOf(first.token);
  f.at(START + 660000);
  const denied = await f.issue({ session: null, body: { origin: HUB, previousToken: first.token } });
  assert.equal(denied.res.statusCode, 401);
  const changed = await f.issue({ session: { profile: 'SUDO', exp: START + 99999999 }, body: { origin: HUB, previousToken: first.token } });
  assert.equal(changed.res.statusCode, 403);
  const recovered = await f.issue({ session: { profile: 'Smart handicrafts', exp: START + 99999999 }, body: { origin: HUB, previousToken: first.token } });
  assert.equal(recovered.res.statusCode, 200);
  const after = f.auth.verifyToken(recovered.res.payload.token);
  for (const key of ['operatorDeviceId', 'baseDeviceId', 'operatorSessionId', 'grantIssuedAt', 'authExpiresAt', 'hubOrigin', 'profile']) assert.equal(after[key], before[key]);
  assert.deepEqual(after.scopes, before.scopes);
  assert.throws(() => f.auth.verifyToken(first.token, { recoverExpiredAccess: true }), error => error.status === 401);
  f.at(before.authExpiresAt);
  assert.equal((await f.issue({ session: { profile: 'Smart handicrafts', exp: START + 99999999 }, body: { origin: HUB, previousToken: first.token } })).res.statusCode, 401);
});

test('refresh preserves the grant and actor and never enlarges caller-supplied scopes or absolute expiry', async () => {
  const f = fixture(), first = (await f.issue()).res.payload, before = claimsOf(first.token);
  f.at(START + 480000);
  const { res } = await f.invoke('/api/operator-browser-auth/refresh', { method: 'POST', headers: browserHeaders(first.token),
    body: { scopes: ['admin'], profile: 'SUDO', authExpiresAt: START + 999999999, operatorDeviceId: 'attacker' } });
  assert.equal(res.statusCode, 200);
  const after = f.auth.verifyToken(res.payload.token);
  for (const key of ['operatorDeviceId', 'baseDeviceId', 'operatorSessionId', 'grantIssuedAt', 'authExpiresAt', 'hubOrigin', 'profile']) assert.equal(after[key], before[key]);
  assert.deepEqual(after.scopes, before.scopes); assert.equal(after.exp, START + 1080000);
  assert.notEqual(after.jti, before.jti);
  const readOnly = signedClaims({ ...before, scopes: ['calls:read'] });
  const refreshedReadOnly = await f.invoke('/api/operator-browser-auth/refresh', { method: 'POST', headers: browserHeaders(readOnly), body: { scopes: ['calls:write'] } });
  assert.deepEqual(f.auth.verifyToken(refreshedReadOnly.res.payload.token).scopes, ['calls:read']);
});

test('refresh and call controls reject expired access, wrong/missing origin, native and profile token confusion', async () => {
  const f = fixture(), token = (await f.issue()).res.payload.token;
  for (const headers of [browserHeaders(NATIVE_TOKEN), browserHeaders('profile-session-not-a-capability'),
    { Authorization: `Bearer ${token}`, Origin: OTHER }, { Authorization: `Bearer ${token}` }]) {
    const { res } = await f.invoke('/api/operator-browser-auth/refresh', { method: 'POST', headers });
    assert.ok([401, 403].includes(res.statusCode));
  }
  f.at(START + 600000);
  assert.equal((await f.invoke('/api/operator-browser-auth/refresh', { method: 'POST', headers: browserHeaders(token) })).res.statusCode, 401);
  assert.equal((await f.guard('/api/whatsapp-calls/terminate', { method: 'POST', headers: browserHeaders(token) })).res.statusCode, 401);
});

test('signature, audience, issuer, role, identity and scope validation are independent', async () => {
  const f = fixture(), token = (await f.issue()).res.payload.token, c = claimsOf(token);
  assert.throws(() => f.auth.verifyToken(`${token.slice(0, -2)}ab`));
  const invalid = [ { aud: 'native-room' }, { iss: OTHER }, { profile: 'Accounts' }, { operatorDeviceId: 'attacker' },
    { hubOrigin: OTHER }, { scopes: ['admin'] }, { scopes: ['calls:read', 'calls:read'] }, { scopes: [] },
    { exp: c.exp + 1 }, { authExpiresAt: START + 7200001 }, { iat: START + 60000 }, { jti: 'bad' } ];
  for (const change of invalid) assert.throws(() => f.auth.verifyToken(signedClaims({ ...c, ...change })), error => error.status === 401);
  const readOnly = signedClaims({ ...c, scopes: ['calls:read'] });
  assert.equal((await f.guard('/api/whatsapp-calls/recent', { headers: browserHeaders(readOnly) })).res.next, 1);
  assert.equal((await f.guard('/api/whatsapp-calls/accept', { method: 'POST', headers: browserHeaders(readOnly) })).res.statusCode, 403);
});

test('all legacy call, lock, presence, transfer and exact push helper routes require authority', async () => {
  const f = fixture();
  const routes = ['/api/whatsapp-calls/incoming', '/api/whatsapp-calls/call_1', '/api/whatsapp-calls/logs',
    '/api/whatsapp-calls/diagnostics', '/api/odoo/call-log/recent', '/api/odoo/call-log/update-note',
    '/api/operator-call-locks/claim', '/api/operator-call-locks/release', '/api/operator-call-locks/active',
    '/api/operator-call-transfer/request', '/api/operator-call-transfer/accept', '/api/operator-call-transfer/pending',
    '/api/operator-devices', '/api/operator-devices/status', '/api/operator-devices/heartbeat',
    '/api/push/subscribe', '/api/push/unsubscribe', '/api/push/status', '/api/push/test', '/api/push/test-call'];
  for (const path of routes) {
    assert.equal(isProtectedOperatorPath(path), true);
    const { res } = await f.guard(path, { method: 'POST', headers: { Origin: HUB }, body: { uid: 1, operator_device_id: 'SUDO' } });
    assert.equal(res.statusCode, 401, path); assert.equal(res.next, 0);
  }
  for (const path of ['/api/push/public-key', '/api/whatsapp-calls-extra', '/api/product-bot']) {
    assert.equal(isProtectedOperatorPath(path), false); assert.equal((await f.guard(path)).res.next, 1);
  }
  assert.equal((await f.guard('/API/WHATSAPP-CALLS/ACCEPT/')).res.statusCode, 401);
  assert.equal((await f.guard('/api/whatsapp-calls/accept', { method: 'OPTIONS' })).res.next, 1);
});

test('public config exposes only auth capability markers; authenticated desktop reaches operational config', async () => {
  const f = fixture();
  const publicResult = await f.guard('/api/whatsapp-calls/config');
  assert.equal(publicResult.res.next, 0); assert.equal(publicResult.res.payload.authRequired, true);
  assert.equal(publicResult.res.payload.browserAuthReady, true);
  assert.deepEqual(Object.keys(publicResult.res.payload).sort(), ['ok', 'version', 'authRequired', 'browserAuthReady', 'browserTokenTtlMs', 'authenticatedEventStream'].sort());
  const token = (await f.issue()).res.payload.token;
  const privateResult = await f.guard('/api/whatsapp-calls/config', { headers: browserHeaders(token) }, { operational: true });
  assert.equal(privateResult.res.next, 1); assert.equal(privateResult.res.payload.operational, true);
  const nativeResult = await f.guard('/api/whatsapp-calls/config', { headers: { Authorization: `Bearer ${NATIVE_TOKEN}` } });
  assert.equal(nativeResult.res.next, 0); assert.equal(nativeResult.res.payload.authRequired, true);
});

test('derived actor replaces every legacy caller alias and transfer source, preserving chosen target', async () => {
  const f = fixture(), issued = (await f.issue()).res.payload;
  const { req, res } = await f.guard('/api/operator-call-transfer/request?device_id=spoof&operator_device_id=spoof', {
    method: 'POST', headers: browserHeaders(issued.token), body: { deviceId: 'spoof', operatorDeviceId: 'spoof',
      from_operator_device_id: 'another-phone', from_device_id: 'another-phone', to_device_id: 'selected-target',
      to_operator_device_id: 'selected-target', operatorName: 'SUDO', operator_session_id: 'spoof', lock_device_id: 'spoof' } });
  assert.equal(res.next, 1);
  for (const value of [req.body, req.query]) {
    for (const key of ['operatorDeviceId', 'operator_device_id', 'actor_device_id', 'lockDeviceId', 'lock_device_id',
      'operatorLockDeviceId', 'operator_lock_device_id', 'from_operator_device_id', 'from_device_id']) assert.equal(value[key], issued.operatorDeviceId, key);
    assert.equal(value.deviceId, issued.baseDeviceId); assert.equal(value.device_id, issued.baseDeviceId);
    assert.equal(value.operatorSessionId, issued.operatorSessionId); assert.equal(value.operator_session_id, issued.operatorSessionId);
    assert.equal(value.operatorName, 'Smart handicrafts'); assert.equal(value.client_source, 'odoo_operator_hub');
  }
  assert.equal(req.body.to_device_id, 'selected-target'); assert.equal(req.body.to_operator_device_id, 'selected-target');
  assert.equal(Object.isFrozen(req.operatorAuth), true);
});

test('call event streaming requires header authority and rejects URL credentials', async () => {
  const f = fixture(), token = (await f.issue()).res.payload.token;
  for (const key of ['token', 'access_token', 'Authorization', 'bearer', 'deviceToken']) {
    const { res } = await f.guard(`/api/whatsapp-calls/events?${key}=synthetic`, { headers: browserHeaders(token) });
    assert.equal(res.statusCode, 400); assert.equal(res.next, 0);
  }
  assert.equal((await f.guard('/api/whatsapp-calls/events', { headers: browserHeaders(token) })).res.next, 1);
  assert.equal((await f.guard('/api/whatsapp-calls/events')).res.statusCode, 401);
});

test('native authenticated history projection keeps useful IDs but strips nested SDP, raw payloads, joins and credentials', async () => {
  const f = fixture();
  const dangerous = { id: 42, call_id: 'provider-id', customer_name: 'Test customer', status: 'ended', timestamp: START,
    sdp: 'private-offer', session: { sdp: 'private-answer' }, raw: { token: 'private-provider-key' },
    join: { token: 'private-room-token' }, deviceToken: 'private-device-key', metadata: { sdp: 'private' },
    call_note: 'Operator note', events: [{ id: 43, call_id: 'provider-id', event: 'terminate', raw: { sdp: 'private' } }] };
  for (const path of ['/api/whatsapp-calls/logs', '/api/whatsapp-calls/recent', '/api/whatsapp-calls/incoming', '/api/whatsapp-calls/provider-id']) {
    const { req, res } = await f.guard(path, { headers: { Authorization: `Bearer ${NATIVE_TOKEN}` } },
      { ok: true, calls: [dangerous], call: dangerous, events: [dangerous], raw: 'private', odoo_error: 'private credential' });
    assert.equal(res.next, 1); assert.equal(req.operatorAuth.kind, 'native-history');
    const text = JSON.stringify(res.payload); assert.equal(text.includes('private'), false);
    assert.equal(res.payload.call.id, 42); assert.equal(res.payload.call.call_id, 'provider-id');
    assert.equal(res.payload.call.events[0].id, 43);
  }
  assert.equal(f.authenticated.length, 4);
  const error = projectNativeCallHistory({ ok: false, error: 'upstream private credential', details: dangerous });
  assert.deepEqual(error, { ok: false, error: 'Call history is unavailable.' });
});

test('native history authorization never permits legacy writes, diagnostics, push registration or query-token streams', async () => {
  const f = fixture();
  for (const [path, method] of [
    ['/api/whatsapp-calls/accept','POST'], ['/api/whatsapp-calls/reject','POST'], ['/api/whatsapp-calls/terminate','POST'],
    ['/api/operator-call-locks/claim','POST'], ['/api/operator-call-transfer/accept','POST'], ['/api/operator-devices','GET'],
    ['/api/push/subscribe','POST'], ['/api/odoo/call-log/recent','GET'], ['/api/whatsapp-calls/diagnostics','GET'],
    ['/api/whatsapp-calls/events','GET'], ['/api/whatsapp-calls/call%20invalid','GET']
  ]) {
    const { res } = await f.guard(path, { method, headers: { Authorization: `Bearer ${NATIVE_TOKEN}`, Origin: HUB } });
    assert.equal(res.statusCode, 403, path); assert.equal(res.next, 0);
  }
  assert.equal(f.authenticated.length, 0);
});

test('native storage faults remain retryable 503; deliberate revocation, expiry or identity mismatch are 401', async () => {
  for (const [error, status] of [[Object.assign(Error('private SDK details'), { status: 401 }), 503],
    [Object.assign(Error('revoked'), { status: 401, registryError: true }), 401]]) {
    const f = fixture({ authenticateNative: async () => { throw error; } });
    const { res } = await f.guard('/api/whatsapp-calls/logs', { headers: { Authorization: `Bearer ${NATIVE_TOKEN}` } });
    assert.equal(res.statusCode, status); assert.equal(JSON.stringify(res.payload).includes('private'), false);
  }
  for (const device of [null, { id: NATIVE_ID, tokenExpiresAt: START }, { id: NATIVE_ID, tokenExpiresAt: START + 1000, revokedAt: START },
    { id: 'android_99999999-2222-3333-4444-555555555555', tokenExpiresAt: START + 1000 }]) {
    const f = fixture({ authenticateNative: async () => device });
    assert.equal((await f.guard('/api/whatsapp-calls/logs', { headers: { Authorization: `Bearer ${NATIVE_TOKEN}` } })).res.statusCode, 401);
  }
});

test('missing/weak browser secret never crashes startup or breaks valid native history', async () => {
  for (const secret of [undefined, '', 'short', ' '.repeat(40)]) {
    const f = fixture({ secret });
    assert.equal(f.auth.publicConfig().browserAuthReady, false);
    assert.equal((await f.issue()).res.statusCode, 503);
    assert.equal((await f.invoke('/api/operator-browser-auth/refresh', { method: 'POST', headers: browserHeaders('shb1.x.x') })).res.statusCode, 503);
    assert.equal((await f.guard('/api/whatsapp-calls/logs', { headers: { Authorization: `Bearer ${NATIVE_TOKEN}` } }, { ok: true, calls: [] })).res.next, 1);
  }
});

test('push helpers allow only authenticated browser or permitted same-origin profile with write CSRF checks', async () => {
  const f = fixture(), session = { profile: 'SUDO', exp: START + 60000 };
  assert.equal((await f.guard('/api/push/subscribe', { method: 'POST', session, headers: { Origin: HUB, 'X-SH-Operator-Auth': '1' } })).res.statusCode, 403);
  assert.equal((await f.guard('/api/push/subscribe', { method: 'POST', session, headers: { Origin: BACKEND } })).res.statusCode, 403);
  const subscribed = await f.guard('/api/push/subscribe', { method: 'POST', session, headers: { Origin: BACKEND, 'X-SH-Operator-Auth': '1' }, body: { deviceId: 'attacker' } });
  assert.equal(subscribed.res.next, 1); assert.equal(subscribed.req.operatorAuth.kind, 'profile');
  assert.notEqual(subscribed.req.body.deviceId, 'attacker');
  assert.equal((await f.guard('/api/push/status', { session })).res.next, 1);
  assert.equal((await f.guard('/api/whatsapp-calls/logs', { session })).res.statusCode, 401);
  assert.equal((await f.guard('/api/push/test-call', { session })).res.statusCode, 405);
});

test('bounded login limiter counts failed attempts and passwords require a configured constant-length comparison', () => {
  let now = START; const limiter = createProfileLoginLimiter({ clock: () => now, maxAttempts: 2, windowMs: 1000, maxKeys: 2 });
  const a = request('/', { ip: '192.0.2.1' }), b = request('/', { ip: '192.0.2.2' }), c = request('/', { ip: '192.0.2.3' });
  limiter.check(a); limiter.check(a); assert.throws(() => limiter.check(a), e => e.status === 429);
  limiter.check(b); assert.throws(() => limiter.check(c), e => e.status === 429);
  limiter.success(a); limiter.check(a); now += 1000; limiter.check(c);
  assert.equal(constantTimePasswordEqual('test password', 'test password'), true);
  for (const [actual, expected] of [['wrong', 'test password'], ['', ''], ['anything', ''], [null, 'test password'], ['x'.repeat(1025), 'test password']])
    assert.equal(constantTimePasswordEqual(actual, expected), false);
});

test('popup route validates allowlisted exact origins/state and emits nonce CSP with no query credentials', async () => {
  const f = fixture(), state = 'a'.repeat(64);
  for (const path of ['/operator-auth', `/operator-auth?origin=${encodeURIComponent(OTHER)}&state=${state}`,
    `/operator-auth?origin=${encodeURIComponent(HUB)}&state=short`, `/operator-auth?origin=${encodeURIComponent(HUB)}&state=${state}&token=secret`]) {
    assert.equal((await f.invoke(path)).res.statusCode, 400);
  }
  const { res } = await f.invoke(`/operator-auth?origin=${encodeURIComponent(HUB)}&state=${state}`);
  assert.equal(res.statusCode, 200); assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(res.headers['content-security-policy'], /script-src 'nonce-[A-Za-z0-9+/=]+'/);
  assert.equal(res.headers['cross-origin-opener-policy'], 'unsafe-none');
  assert.equal(res.headers['x-frame-options'], 'DENY'); assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.equal(res.payload.includes('__SH_OPERATOR_AUTH_'), false); assert.equal(res.payload.includes('localStorage'), false);
  assert.match(res.headers['content-type'], /charset=utf-8/);
});

function popupHarness(html, { opener = true, pageOrigin = BACKEND, search = `?origin=${encodeURIComponent(HUB)}&state=${'a'.repeat(64)}`, fetchResponse } = {}) {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  const publicConfig = scripts.find(match => /application\/json/.test(match[1]))[2];
  const source = scripts.find(match => !/application\/json/.test(match[1]))[2];
  const elements = new Map(), messages = [], requests = [], listeners = new Map(); let closed = 0;
  const get = id => {
    if (!elements.has(id)) {
      const classes = new Set(['hidden']);
      elements.set(id, { textContent: id === 'public-config' ? publicConfig : '', value: '', disabled: false,
        handlers: new Map(), classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) },
        addEventListener(type, handler) { this.handlers.set(type, handler); } });
    }
    return elements.get(id);
  };
  const sourceWindow = { postMessage: (data, target) => messages.push({ data, target }) };
  const window = { opener: opener ? sourceWindow : null, close: () => { closed++; }, addEventListener: (type, fn) => listeners.set(type, fn) };
  const fetch = async (path, options) => {
    requests.push({ path, options, passwordAtFetch: get('password').value });
    return fetchResponse ? fetchResponse(path, options) : { ok: false, status: 401, json: async () => ({ ok: false, error: 'Sign in.' }) };
  };
  vm.runInNewContext(source, { window, document: { getElementById: get }, location: { origin: pageOrigin, search },
    URLSearchParams, fetch, Date: { now: () => START }, Object, Error, Number, JSON, String, RegExp });
  return { elements, get, messages, requests, sourceWindow, listeners, closed: () => closed };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('popup ignores wrong source/origin/state; only exact opener context reaches issuer without URL/storage tokens', async () => {
  const f = fixture(), state = 'a'.repeat(64), html = (await f.invoke(`/operator-auth?origin=${encodeURIComponent(HUB)}&state=${state}`)).res.payload;
  const h = popupHarness(html);
  assert.deepEqual(JSON.parse(JSON.stringify(h.messages[0])), { data: { type: 'sh-operator-auth-ready', state }, target: HUB });
  h.get('continue').handlers.get('click')(); await settle(); assert.equal(h.requests.length, 0);
  const handler = h.listeners.get('message');
  for (const event of [
    { source: {}, origin: HUB, data: { type: 'sh-operator-auth-context', state } },
    { source: h.sourceWindow, origin: OTHER, data: { type: 'sh-operator-auth-context', state } },
    { source: h.sourceWindow, origin: HUB, data: { type: 'sh-operator-auth-context', state: 'wrong' } },
    { source: h.sourceWindow, origin: HUB, data: { type: 'sh-operator-auth-context', state, previousToken: NATIVE_TOKEN } }
  ]) { handler(event); await settle(); }
  assert.equal(h.requests.length, 0);
  handler({ source: h.sourceWindow, origin: HUB, data: { type: 'sh-operator-auth-context', state, previousToken: 'shb1.synthetic.signature' } });
  await settle(); assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].path, '/api/operator-browser-auth/token');
  assert.deepEqual(JSON.parse(h.requests[0].options.body), { origin: HUB, previousToken: 'shb1.synthetic.signature' });
  assert.equal(h.requests[0].options.credentials, 'same-origin'); assert.equal(h.requests[0].options.headers['X-SH-Operator-Auth'], '1');
  handler({ source: h.sourceWindow, origin: HUB, data: { type: 'sh-operator-auth-context', state } }); await settle();
  assert.equal(h.requests.length, 1);
});

test('popup delivery validates response and sends capability only to exact opener target', async () => {
  const f = fixture(), state = 'a'.repeat(64), issued = (await f.issue()).res.payload;
  const html = (await f.invoke(`/operator-auth?origin=${encodeURIComponent(HUB)}&state=${state}`)).res.payload;
  const h = popupHarness(html, { fetchResponse: async () => ({ ok: true, status: 200, json: async () => issued }) });
  h.listeners.get('message')({ source: h.sourceWindow, origin: HUB, data: { type: 'sh-operator-auth-context', state } }); await settle();
  assert.equal(h.messages.length, 2); assert.equal(h.messages[1].target, HUB);
  assert.equal(h.messages[1].data.type, 'sh-operator-browser-auth'); assert.equal(h.messages[1].data.token, issued.token);
  assert.equal(h.closed(), 1);
  for (const options of [{ opener: false }, { pageOrigin: OTHER }, { search: `?origin=${encodeURIComponent(OTHER)}&state=${state}` }]) {
    const wrong = popupHarness(html, options); assert.equal(wrong.requests.length, 0); assert.equal(wrong.messages.length, 0);
  }
});

test('popup clears password before async profile login and never forwards it to opener', async () => {
  const f = fixture(), state = 'a'.repeat(64), issued = (await f.issue()).res.payload;
  const html = (await f.invoke(`/operator-auth?origin=${encodeURIComponent(HUB)}&state=${state}`)).res.payload;
  let signedIn = false;
  const h = popupHarness(html, { fetchResponse: async path => {
    if (path === '/api/profile-login') { signedIn = true; return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
    return signedIn ? { ok: true, status: 200, json: async () => issued } : { ok: false, status: 401, json: async () => ({ ok: false, error: 'Sign in.' }) };
  } });
  h.listeners.get('message')({ source: h.sourceWindow, origin: HUB, data: { type: 'sh-operator-auth-context', state } }); await settle();
  h.get('profile').value = 'Smart handicrafts'; h.get('password').value = 'test-only-password';
  await h.get('form').handlers.get('submit')({ preventDefault() {} });
  assert.equal(h.requests[1].path, '/api/profile-login'); assert.equal(h.requests[1].passwordAtFetch, '');
  assert.equal(h.get('password').value, ''); assert.equal(JSON.stringify(h.messages).includes('test-only-password'), false);
  assert.equal(JSON.parse(h.requests[2].options.body).password, undefined);
});

test('absolute-expired popup identity changes only after explicit new-session click', async () => {
  const f = fixture(), state = 'a'.repeat(64), issued = (await f.issue()).res.payload;
  const html = (await f.invoke(`/operator-auth?origin=${encodeURIComponent(HUB)}&state=${state}`)).res.payload;
  const h = popupHarness(html, { fetchResponse: async (_path, options) => JSON.parse(options.body).previousToken ?
    { ok: false, status: 401, json: async () => ({ ok: false, code: 'BROWSER_CAPABILITY_EXPIRED', error: 'Previous session expired.' }) } :
    { ok: true, status: 200, json: async () => issued } });
  h.listeners.get('message')({ source: h.sourceWindow, origin: HUB, data: { type: 'sh-operator-auth-context', state, previousToken: 'shb1.expired.signature' } });
  await settle(); assert.equal(h.requests.length, 1); assert.equal(h.messages.length, 1);
  assert.equal(h.get('continue').textContent, 'Start a new call session');
  h.get('continue').handlers.get('click')(); await settle();
  assert.equal(h.requests.length, 2); assert.equal(JSON.parse(h.requests[1].options.body).previousToken, undefined);
  assert.equal(h.messages.length, 2); assert.equal(h.closed(), 1);
});
