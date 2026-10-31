// Executes selected, unmodified server.js handlers in a VM. All credentials,
// subscriptions, timers and storage are synthetic; there is no network client.
// SH_TEST_SERVER can point to an exported earlier server.js for regression proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, createECDH } from 'node:crypto';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { createOperatorBrowserAuth } from '../operator-browser-auth.js';
import { assertPushSubscriptionOwner, canManagePushSubscription } from '../operator-push-ownership.js';

const serverPath = process.env.SH_TEST_SERVER || new URL('../server.js', import.meta.url);
const source = await readFile(serverPath, 'utf8');
const HUB = 'https://www.smarthandicrafts.com';
const BACKEND = 'https://ai-agent-debate.onrender.com';
const START = 1800000000000;
const SECRET = 'offline-security-fixture-only-abcdefghijklmnopqrstuvwxyz0123456789';
const nativeId = 'android_11111111-2222-3333-4444-555555555555';
const nativeToken = `${nativeId}.${'A'.repeat(43)}`;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => structuredClone(value);

function sourceFunction(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `Actual server function ${name} must exist.`);
  const end = source.indexOf('\n}', start);
  assert.ok(end > start, `Actual server function ${name} must have a complete declaration.`);
  return source.slice(start, end + 2);
}
function sourceRoute(method, path) {
  const marker = `app.${method}("${path}",`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `Actual server ${method} handler must exist.`);
  const end = source.indexOf('\n});', start);
  assert.ok(end > start, 'Actual server route must have a complete declaration.');
  return source.slice(start, end + 4);
}

function subscription(index = 1, encoding = 'base64url') {
  // Real-format public curve points, with fixed synthetic auth secrets. Nothing
  // here is connected to a push service or an enrolled browser/device.
  const ecdh = createECDH('prime256v1');
  const privateKey = Buffer.alloc(32); privateKey[31] = index;
  ecdh.setPrivateKey(privateKey);
  return { endpoint: `https://push.invalid/offline-subscription-${index}`,
    keys: { auth: Buffer.alloc(16, index).toString(encoding), p256dh: ecdh.getPublicKey().toString(encoding) } };
}
function record(actor, value = subscription()) {
  return { endpoint: value.endpoint, subscription: clone(value), device_id: actor.baseDeviceId,
    lock_device_id: actor.operatorDeviceId, operator_session_id: actor.operatorSessionId,
    receive_calls: false, receive_chats: true, status: 'away', in_call: false };
}

function fixture() {
  let clock = START, rows = [], present = [], writes = 0, reads = 0, timerId = 0;
  const routes = new Map(), authRoutes = new Map(), timers = new Map(), logs = [];
  const later = (kind, fn, delay) => {
    const handle = { id: ++timerId, kind, fn, delay: Math.max(1, Number(delay)), at: clock + Math.max(1, Number(delay)), unref() {} };
    timers.set(handle.id, handle); return handle;
  };
  const clear = handle => { if (handle) timers.delete(handle.id); };
  const context = {
    app: { post: (path, fn) => routes.set(`POST ${path}`, fn), get: (path, fn) => routes.set(`GET ${path}`, fn) },
    Date: class extends Date { static now() { return clock; } },
    now: () => new Date(clock).toISOString(),
    allowedOrigins: [HUB], WEB_PUSH_OPERATOR_AUDIENCE: 'operator',
    webPushConfigured: () => true, assertPushSubscriptionOwner,
    operatorHubPresenceRows: () => clone(present),
    whatsappCallProviderId: row => typeof row?.call_id === 'string' ? row.call_id : '',
    mutatePushSubscriptions: async update => {
      reads++;
      const candidate = update(clone(rows));
      rows = clone(candidate); writes++;
      return clone(rows);
    },
    setTimeout: (fn, delay) => later('timeout', fn, delay), clearTimeout: clear,
    setInterval: (fn, delay) => later('interval', fn, delay), clearInterval: clear,
    console: Object.fromEntries(['log','warn','error','info','debug'].map(name => [name, (...args) => logs.push({ name, args })]))
  };
  const vmSource = [
    sourceFunction('aiModeSafeString'), sourceFunction('normalizeOperatorDeviceStatus'),
    sourceFunction('normalizeOperatorDeviceId'), sourceFunction('normalizePushSubscriptionPayload'),
    sourceRoute('post', '/api/push/subscribe'), sourceRoute('post', '/api/push/unsubscribe'),
    'const whatsappCallEventClients = new Map();', sourceFunction('publishWhatsappCallHints'),
    sourceRoute('get', '/api/whatsapp-calls/events'),
    'globalThis.clients = whatsappCallEventClients; globalThis.hints = publishWhatsappCallHints;'
  ].join('\n\n');
  vm.runInNewContext(vmSource, context, { filename: 'actual-operator-server-handlers.vm.js', timeout: 1000 });
  const auth = createOperatorBrowserAuth({ secret: SECRET, backendOrigin: BACKEND, allowedHubOrigins: [HUB],
    clock: () => clock, readProfileSession: req => req.profileSession,
    authenticateNative: async raw => raw === nativeToken ? { id: nativeId, tokenExpiresAt: clock + 60000, revokedAt: 0 } : null });
  auth.registerRoutes({ post: (path, fn) => authRoutes.set(`POST ${path}`, fn), get: (path, fn) => authRoutes.set(`GET ${path}`, fn) });

  function req(path, { method = 'GET', headers = {}, body = {}, actor, profileSession } = {}) {
    return Object.assign(new EventEmitter(), { method, originalUrl: path, url: path, path: path.split('?')[0],
      query: Object.fromEntries(new URL(path, BACKEND).searchParams), body: clone(body),
      headers: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])),
      operatorAuth: actor, profileSession, ip: '192.0.2.12' });
  }
  function res({ writes: writeResults = [] } = {}) {
    const value = Object.assign(new EventEmitter(), { statusCode: 200, headers: {}, chunks: [], payload: undefined,
      writableEnded: false, endedCount: 0, flushed: false,
      setHeader(key, item) { this.headers[key.toLowerCase()] = item; },
      status(status) { this.statusCode = status; return this; },
      json(body) { this.payload = body; return this; }, send(body) { this.payload = body; return this; },
      flushHeaders() { this.flushed = true; },
      write(chunk) { this.chunks.push(chunk); const result = writeResults.shift(); if (result instanceof Error) throw result; return result !== false; },
      end() { if (!this.writableEnded) { this.writableEnded = true; this.endedCount++; this.emit('close'); } return this; }
    });
    return value;
  }
  async function issue() {
    const request = req('/api/operator-browser-auth/token', { method: 'POST',
      headers: { Origin: BACKEND, 'X-SH-Operator-Auth': '1' }, body: { origin: HUB },
      profileSession: { profile: 'Smart handicrafts', exp: clock + 7200000 } });
    const response = res(); await authRoutes.get('POST /api/operator-browser-auth/token')(request, response);
    assert.equal(response.statusCode, 200);
    return { ...response.payload, ...auth.verifyToken(response.payload.token) };
  }
  async function call(path, options = {}, { guarded = true, responseOptions, payload } = {}) {
    const request = req(path, options), response = res(responseOptions);
    let next = false;
    if (guarded) await auth.guard(request, response, () => { next = true; });
    else next = true;
    if (next) {
      if (payload !== undefined) response.json(payload);
      else {
        const handler = routes.get(`${request.method === 'HEAD' ? 'GET' : request.method} ${request.path}`);
        assert.ok(handler, 'The selected actual server handler is present.');
        await handler(request, response);
      }
    }
    return { req: request, res: response, next };
  }
  return { issue, call, auth, clients: context.clients, hints: context.hints,
    setRows: value => { rows = clone(value); }, rows: () => clone(rows), writes: () => writes, reads: () => reads,
    presence: value => { present = clone(value); }, timers, logs, now: () => clock,
    advance(ms) {
      const end = clock + ms; let count = 0;
      while (true) {
        const due = [...timers.values()].filter(item => item.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        assert.ok(++count < 10000, 'The fake timer queue must remain bounded.');
        clock = due.at;
        if (due.kind === 'timeout') timers.delete(due.id); else due.at += due.delay;
        due.fn();
      }
      clock = end;
    }
  };
}
const browserHeaders = actor => ({ Origin: HUB, Authorization: `Bearer ${actor.token}` });
const presence = actor => ({ lock_device_id: actor.operatorDeviceId, client_source: 'odoo_operator_hub' });
const streamPath = actor => `/api/whatsapp-calls/events?operator_device_id=${encodeURIComponent(actor.operatorDeviceId)}`;
const bodyWith = (actor, value) => ({ deviceId: actor.baseDeviceId, subscription: clone(value) });
const sameRows = (a, b) => assert.equal(hash(a), hash(b), 'Subscription rows must remain byte-equivalent on rejection.');

test('actual push handlers are never entered for anonymous or native control requests', async () => {
  const f = fixture();
  for (const path of ['/api/push/subscribe', '/api/push/unsubscribe']) {
    const body = { endpoint: subscription().endpoint, subscription: subscription() };
    const anonymous = await f.call(path, { method: 'POST', body });
    assert.equal(anonymous.next, false); assert.equal(anonymous.res.statusCode, 401);
    const native = await f.call(path, { method: 'POST', body, headers: { Authorization: `Bearer ${nativeToken}` } });
    assert.equal(native.next, false); assert.equal(native.res.statusCode, 403);
  }
  assert.equal(f.reads(), 0); assert.equal(f.writes(), 0); assert.equal(f.logs.length, 0);
});

test('actual subscribe uses the signed actor instead of submitted device and lock identities', async () => {
  const f = fixture(), actor = await f.issue(), forged = await f.issue();
  const { req, res } = await f.call('/api/push/subscribe', { method: 'POST', headers: browserHeaders(actor),
    body: { ...bodyWith(forged, subscription()), lockDeviceId: forged.operatorDeviceId, operatorSessionId: forged.operatorSessionId } });
  assert.equal(res.statusCode, 200); assert.equal(f.writes(), 1);
  assert.equal(f.rows()[0].device_id, actor.baseDeviceId);
  assert.equal(f.rows()[0].lock_device_id, actor.operatorDeviceId);
  assert.equal(req.operatorAuth.kind, 'browser'); assert.equal(f.logs.length, 0);
});

test('an authenticated current subscription owner can update keys and remove its exact endpoint', async () => {
  const f = fixture(), actor = await f.issue(), other = await f.issue();
  const untouched = record(other, subscription(2)); f.setRows([record(actor), untouched]);
  const rotated = { ...subscription(3), endpoint: subscription().endpoint };
  const update = await f.call('/api/push/subscribe', { method: 'POST', headers: browserHeaders(actor), body: bodyWith(actor, rotated) });
  assert.equal(update.res.statusCode, 200); assert.equal(f.rows().length, 2);
  assert.equal(hash(f.rows().find(row => row.endpoint === untouched.endpoint)), hash(untouched));
  const removed = await f.call('/api/push/unsubscribe', { method: 'POST', headers: browserHeaders(actor), body: { endpoint: rotated.endpoint } });
  assert.equal(removed.res.statusCode, 200); sameRows(f.rows(), [untouched]); assert.equal(f.logs.length, 0);
});

test('endpoint-only unsubscribe by another authenticated operator is denied without a storage write', async () => {
  const f = fixture(), owner = await f.issue(), other = await f.issue();
  const before = [record(owner), record(other, subscription(2))]; f.setRows(before);
  const { res } = await f.call('/api/push/unsubscribe', { method: 'POST', headers: browserHeaders(other), body: { endpoint: subscription().endpoint } });
  assert.equal(res.statusCode, 403); sameRows(f.rows(), before); assert.equal(f.writes(), 0); assert.equal(f.logs.length, 0);
});

test('subscribe takeover with endpoint but unrelated valid subscription keys is denied atomically', async () => {
  const f = fixture(), owner = await f.issue(), other = await f.issue();
  const before = [record(owner)]; f.setRows(before);
  const forged = { ...subscription(2), endpoint: subscription().endpoint };
  const { res } = await f.call('/api/push/subscribe', { method: 'POST', headers: browserHeaders(other), body: bodyWith(owner, forged) });
  assert.equal(res.statusCode, 403); sameRows(f.rows(), before); assert.equal(f.writes(), 0);
});

test('both subscription auth and public-key proofs are required for subscribe and unsubscribe migration', async () => {
  const f = fixture(), owner = await f.issue(), other = await f.issue(), original = subscription(), wrong = subscription(2);
  const before = [record(owner, original)];
  const candidates = [
    { ...original, keys: { ...original.keys, auth: wrong.keys.auth } },
    { ...original, keys: { ...original.keys, p256dh: wrong.keys.p256dh } },
    { ...original, keys: { p256dh: original.keys.p256dh } },
    { ...original, keys: { auth: original.keys.auth } },
    { ...original, keys: { ...original.keys, auth: Buffer.alloc(15).toString('base64url') } },
    { ...original, keys: { ...original.keys, p256dh: Buffer.alloc(64).toString('base64url') } }
  ];
  for (const value of candidates) for (const operation of ['subscribe', 'unsubscribe']) {
    f.setRows(before);
    const { res } = await f.call(`/api/push/${operation}`, { method: 'POST', headers: browserHeaders(other),
      body: { endpoint: original.endpoint, subscription: value } });
    // Missing fields are rejected by the real subscribe normalizer before the owner check.
    assert.ok([400,403].includes(res.statusCode)); sameRows(f.rows(), before);
  }
  assert.equal(f.writes(), 0); assert.equal(f.logs.length, 0);
});

test('same-browser key possession permits reauthentication migration and then denies the previous actor endpoint-only access', async () => {
  const f = fixture(), originalActor = await f.issue(), newActor = await f.issue(), value = subscription();
  f.setRows([record(originalActor, value)]);
  const migrated = await f.call('/api/push/subscribe', { method: 'POST', headers: browserHeaders(newActor), body: bodyWith(newActor, value) });
  assert.equal(migrated.res.statusCode, 200); assert.equal(f.rows()[0].device_id, newActor.baseDeviceId);
  const after = f.rows();
  const stale = await f.call('/api/push/unsubscribe', { method: 'POST', headers: browserHeaders(originalActor), body: { endpoint: value.endpoint } });
  assert.equal(stale.res.statusCode, 403); sameRows(f.rows(), after);
  const removed = await f.call('/api/push/unsubscribe', { method: 'POST', headers: browserHeaders(newActor), body: { endpoint: value.endpoint } });
  assert.equal(removed.res.statusCode, 200); assert.equal(f.rows().length, 0); assert.equal(f.logs.length, 0);
});

test('an unbound legacy subscription can migrate only with both exact existing keys, including equivalent base64 encodings', async () => {
  const f = fixture(), actor = await f.issue();
  const old = subscription(1, 'base64');
  f.setRows([{ endpoint: old.endpoint, subscription: old }]);
  const migrated = await f.call('/api/push/subscribe', { method: 'POST', headers: browserHeaders(actor), body: bodyWith(actor, subscription(1, 'base64url')) });
  assert.equal(migrated.res.statusCode, 200); assert.equal(f.rows()[0].device_id, actor.baseDeviceId);
});

test('unsubscribe migration proof is bound to the exact endpoint selected for removal', async () => {
  const f = fixture(), owner = await f.issue(), other = await f.issue();
  const before = [record(owner), record(other, subscription(2))]; f.setRows(before);
  const value = { ...subscription(), endpoint: subscription(2).endpoint };
  const { res } = await f.call('/api/push/unsubscribe', { method: 'POST', headers: browserHeaders(other),
    body: { endpoint: subscription().endpoint, subscription: value } });
  assert.equal(res.statusCode, 403); sameRows(f.rows(), before); assert.equal(f.writes(), 0);
});

test('ownership helper rejects native or absent actors even when subscription keys match', async () => {
  const f = fixture(), actor = await f.issue(), stored = record(actor), value = subscription();
  for (const invalid of [undefined, {}, { ...actor, kind: 'native-history' }, { ...actor, kind: 'browser', baseDeviceId: 'forged' }])
    assert.equal(canManagePushSubscription(stored, invalid, value), false);
  assert.equal(canManagePushSubscription(stored, { ...actor, kind: 'browser' }, null), true);
  assert.equal(f.logs.length, 0);
});

test('actual SSE handler independently refuses missing, non-browser, expired and invalid authorization', async () => {
  const f = fixture(), actor = await f.issue(); f.presence([presence(actor)]);
  for (const supplied of [undefined, { ...actor, kind: 'profile' }, { ...actor, kind: 'native-history' },
    { ...actor, kind: 'browser', exp: START }, { ...actor, kind: 'browser', exp: START + 0.5 }]) {
    const { res } = await f.call(streamPath(actor), { actor: supplied, headers: { Origin: HUB } }, { guarded: false });
    assert.equal(res.statusCode, 401); assert.equal(res.chunks.length, 0); assert.equal(f.clients.size, 0);
  }
  assert.equal(f.timers.size, 0);
});

test('SSE uses the signed browser actor and cannot substitute another operator presence via query aliases', async () => {
  const f = fixture(), actor = await f.issue(), other = await f.issue();
  f.presence([presence(other)]);
  const rejected = await f.call(streamPath(other), { headers: browserHeaders(actor) });
  assert.equal(rejected.res.statusCode, 403); assert.equal(f.clients.size, 0);
  f.presence([presence(actor), presence(other)]);
  const accepted = await f.call(streamPath(other), { headers: browserHeaders(actor) });
  assert.equal(accepted.res.statusCode, 200); assert.equal(accepted.req.query.operator_device_id, actor.operatorDeviceId);
  assert.equal(f.clients.has(actor.operatorDeviceId), true); assert.equal(f.clients.has(other.operatorDeviceId), false);
  accepted.req.emit('aborted'); assert.equal(f.timers.size, 0);
});

test('SSE refuses wrong origin, wrong presence source and HEAD without leaving stream resources', async () => {
  const f = fixture(), actor = await f.issue(); f.presence([presence(actor)]);
  const wrongOrigin = await f.call(streamPath(actor), { headers: { ...browserHeaders(actor), Origin: 'https://untrusted.invalid' } });
  assert.equal(wrongOrigin.res.statusCode, 403);
  f.presence([{ ...presence(actor), client_source: 'arbitrary' }]);
  const wrongSource = await f.call(streamPath(actor), { headers: browserHeaders(actor) });
  assert.equal(wrongSource.res.statusCode, 403);
  f.presence([presence(actor)]);
  const head = await f.call(streamPath(actor), { method: 'HEAD', headers: browserHeaders(actor) });
  assert.equal(head.res.statusCode, 405); assert.equal(f.clients.size, 0); assert.equal(f.timers.size, 0);
});

test('SSE expires at its exact opening capability deadline and clears heartbeat, timeout and client map', async () => {
  const f = fixture(), actor = await f.issue(); f.presence([presence(actor)]);
  const { res } = await f.call(streamPath(actor), { headers: browserHeaders(actor) });
  assert.equal(res.statusCode, 200); assert.equal(f.clients.size, 1);
  f.advance(actor.exp - START - 1); assert.equal(res.writableEnded, false);
  f.advance(1); assert.equal(res.writableEnded, true); assert.equal(res.endedCount, 1);
  assert.equal(f.clients.size, 0); assert.equal(f.timers.size, 0);
  const count = res.chunks.length; f.advance(60000); f.hints([{ call_id: 'later' }]); assert.equal(res.chunks.length, count);
});

test('replaced SSE stream closes once and delayed old cleanup cannot close the newer client', async () => {
  const f = fixture(), actor = await f.issue(); f.presence([presence(actor)]);
  const old = await f.call(streamPath(actor), { headers: browserHeaders(actor) });
  const previous = f.clients.get(actor.operatorDeviceId);
  const fresh = await f.call(streamPath(actor), { headers: browserHeaders(actor) });
  assert.equal(old.res.writableEnded, true); assert.equal(old.res.endedCount, 1);
  const newResources = new Set(f.timers.keys());
  assert.ok(newResources.size > 0, 'The replacement owns its heartbeat resources.');
  old.req.emit('aborted'); old.res.emit('close'); previous.close();
  assert.equal(f.clients.size, 1); assert.equal(f.clients.get(actor.operatorDeviceId).res, fresh.res);
  assert.equal(fresh.res.writableEnded, false); assert.deepEqual(new Set(f.timers.keys()), newResources);
  fresh.req.emit('aborted'); assert.equal(f.clients.size, 0); assert.equal(f.timers.size, 0);
});

test('SSE abort, response close and response error each release every owned resource', async () => {
  for (const event of ['aborted','close','error']) {
    const f = fixture(), actor = await f.issue(); f.presence([presence(actor)]);
    const stream = await f.call(streamPath(actor), { headers: browserHeaders(actor) });
    (event === 'aborted' ? stream.req : stream.res).emit(event, event === 'error' ? Error('synthetic transport failure') : undefined);
    assert.equal(f.clients.size, 0); assert.equal(f.timers.size, 0); assert.equal(stream.res.endedCount, 1);
  }
});

test('SSE heartbeat closes a stream whose canonical browser presence has expired', async () => {
  const f = fixture(), actor = await f.issue(); f.presence([presence(actor)]);
  const { res } = await f.call(streamPath(actor), { headers: browserHeaders(actor) });
  f.presence([]); f.advance(15000);
  assert.equal(res.writableEnded, true); assert.equal(f.clients.size, 0); assert.equal(f.timers.size, 0);
});

test('SSE backpressure on ready, heartbeat or a hint closes rather than growing a response buffer', async () => {
  for (const stage of ['ready','heartbeat','hint']) {
    const f = fixture(), actor = await f.issue(); f.presence([presence(actor)]);
    const { res } = await f.call(streamPath(actor), { headers: browserHeaders(actor) },
      { responseOptions: { writes: stage === 'ready' ? [false] : [true,false] } });
    if (stage === 'heartbeat') f.advance(15000);
    if (stage === 'hint') f.hints([{ call_id: 'one' }, { call_id: 'two' }]);
    assert.equal(res.writableEnded, true); assert.equal(f.clients.size, 0); assert.equal(f.timers.size, 0);
    assert.ok(res.chunks.length <= 2);
  }
});

test('actual SSE hints deduplicate IDs and never include raw events, SDP, customer details or credentials', async () => {
  const f = fixture(), actor = await f.issue(); f.presence([presence(actor)]);
  const { res } = await f.call(streamPath(actor), { headers: browserHeaders(actor) });
  f.hints([{ call_id: 'exact-call', customer_name: 'PRIVATE_NAME', customer_phone: 'PRIVATE_PHONE',
    sdp: 'PRIVATE_SDP', authorization: actor.token }, { call_id: 'exact-call' }]);
  const event = res.chunks.filter(value => value.startsWith('event: call-status'));
  assert.equal(event.length, 1);
  const data = JSON.parse(event[0].split('data: ')[1].trim());
  assert.equal(Object.keys(data).sort().join(','), 'call_id,changed_at'); assert.equal(data.call_id, 'exact-call');
  const content = res.chunks.join('');
  for (const secret of ['PRIVATE_NAME','PRIVATE_PHONE','PRIVATE_SDP',actor.token]) assert.equal(content.includes(secret), false);
  assert.equal(f.logs.length, 0); res.emit('close');
});

test('authenticated native history is explicitly version-marked and projects out SDP, tokens and raw provider data', async () => {
  const f = fixture();
  const raw = { ok: true, calls: [{ id: 42, call_id: 'history-call', status: 'ended', raw: { sdp: 'PRIVATE_SDP' },
    sdp: 'PRIVATE_SDP', join: { token: 'PRIVATE_TOKEN' }, customer_name: 'Example', provider: { token: 'PRIVATE_TOKEN' } }] };
  const { res } = await f.call('/api/whatsapp-calls/recent', { headers: { Authorization: `Bearer ${nativeToken}` } }, { payload: raw });
  assert.equal(res.statusCode, 200); assert.equal(res.headers['x-sh-call-history'], 'sh-call-history-v1');
  assert.equal(res.payload.calls[0].id, 42); assert.equal(res.payload.calls[0].call_id, 'history-call');
  const body = JSON.stringify(res.payload);
  for (const privateValue of ['PRIVATE_SDP','PRIVATE_TOKEN',nativeToken]) assert.equal(body.includes(privateValue), false);
  assert.equal(f.logs.length, 0);
});
