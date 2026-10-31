import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, deferred } from './operator-r12-helpers.mjs';
import { createOperatorMediaGateway } from '../operator-media-gateway.js';
import { mountNativeCallRoutes } from '../call-runtime/routes.mjs';

const waitFor = async (promise, ms = 250) => {
  let timer;
  try { return await Promise.race([promise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); })]); }
  finally { clearTimeout(timer); }
};

test('outgoing SDP reaches the connector while eligibility housekeeping is stalled', async () => {
  const f = fixture(), connected = deferred(), housekeeping = deferred();
  const started = await f.runtime.outgoing('a', { to: '919999999999', requestId: 'latency-outgoing-01' });
  await f.runtime.ingestVerifiedMetaEvent({ verified: true, eventId: 'latency-sdp-01', type: 'connect',
    callId: started.call.providerCallId, phoneNumberId: 'business-1', direction: 'outgoing',
    answerSdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n', occurredAtMs: f.now() });
  f.runtime.reconcileEligibility = async () => { await housekeeping.promise; };
  const original = f.provider.connectOutgoing;
  f.provider.connectOutgoing = async data => { await original(data); connected.resolve(); };
  const recovering = f.runtime.recoverSession(started.call.sessionId);
  let reached;
  try { reached = await waitFor(connected.promise); }
  finally { housekeeping.resolve(); await recovering; }
  assert.equal(reached, true, 'SDP must not wait behind unrelated eligibility/presence checks');
  assert.equal(f.effects.filter(row => row.kind === 'connect').length, 1);
});

test('transfer invitation reaches the target while presence housekeeping is stalled', async () => {
  const f = fixture(), delivered = deferred(), housekeeping = deferred();
  const connected = await f.connected();
  await f.runtime.transfer('a', connected.call.sessionId, 'invite', { version: connected.call.version,
    toDeviceId: 'b', requestId: 'latency-transfer-01' });
  f.runtime.notify = async event => { if (event.event === 'transfer-incoming') delivered.resolve(); };
  f.runtime.reconcileEligibility = async () => { await housekeeping.promise; };
  const recovering = f.runtime.recoverSession(connected.call.sessionId);
  let reached;
  try { reached = await waitFor(delivered.promise); }
  finally { housekeeping.resolve(); await recovering; }
  assert.equal(reached, true, 'the committed invitation must dispatch before presence housekeeping');
});

test('exact currently owned leg can End without a preceding status/version request', async () => {
  const f = fixture(), connected = await f.connected();
  const result = await f.runtime.end('a', connected.call.sessionId, {
    requestId: 'latency-exact-end-01', expectedOwnerLegId: connected.call.ownerLegId });
  assert.equal(result.call.phase, 'ending');
  await f.runtime.recoverSession(connected.call.sessionId);
  assert.equal(f.effects.filter(row => row.kind === 'terminate').length, 1);
});

test('version-free End still refuses another leg, another phone and missing exact-leg identity', async () => {
  const f = fixture(), connected = await f.connected(), id = connected.call.sessionId;
  for (const [actor, leg, code] of [['a', 'old-owner-leg', 'CALL_LEG_CHANGED'],
    ['b', connected.call.ownerLegId, 'NOT_CALL_OWNER'], ['a', undefined, 'STALE_CALL_VERSION']]) {
    await assert.rejects(f.runtime.end(actor, id, { requestId: 'latency-refuse-end-01',
      ...(leg ? { expectedOwnerLegId: leg } : {}) }), { code });
  }
  assert.equal((await f.runtime.status('a', id)).call.roomReady, true);
});

test('a fresh registry authentication supplies its exact device row without a duplicate cloud read', async () => {
  const device = { id: 'android_1234567890abcdefghijklmnop', credentialGeneration: 1,
    tokenExpiresAt: 1800001000000, nativeBuild: 13, mediaProtocol: 'sh-room-audio-v1' };
  let authenticateCount = 0, deviceReadCount = 0, args;
  const registry = { authenticate: async () => { authenticateCount++; if (device.revokedAt) throw { registryError: true, status: 401, code: 'DEVICE_AUTH_REQUIRED', message: 'revoked' }; return { ...device }; },
    getDevice: async () => { deviceReadCount++; return { ...device }; } };
  const gateway = createOperatorMediaGateway({ firestoreRuntime: { firestore: {}, collectionPrefix: 'latency', deviceRegistry: registry },
    env: { WHATSAPP_PHONE_NUMBER_ID: 'business-1' }, now: () => 1800000000000,
    storeFactory: () => ({ durable: true }), runtimeFactory: value => { args = value; return { runtime: {}, controller: {} }; }, logger: { warn() {} } });
  const req = { headers: { authorization: `Bearer ${device.id}.abcdefghijklmnopqrstuvwxyz1234567890` } };
  try {
    const auth = await args.authenticate(req);
    const resolved = await args.resolveDevice(auth.deviceId, req);
    assert.equal(resolved.deviceId, device.id);
    assert.equal(deviceReadCount, 0, 'the just-authenticated row already includes the current generation and expiry');
    await args.resolveDevice('android_other1234567890abcdefghijkl');
    assert.equal(deviceReadCount, 1, 'target/recovery lookups still read the durable registry');
    await args.authenticate(req);
    assert.equal(authenticateCount, 2, 'rechecks must perform fresh authentication, with no time-based credential cache');
    device.revokedAt = 1;
    await assert.rejects(args.authenticate(req), { code: 'DEVICE_AUTH_REQUIRED' });
  } finally { await gateway.close(); }
});

test('simultaneous priority setup wakes keep the connector SDP operation one-shot', async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  const call = await f.runtime.outgoing('a', { to: '919999999999', requestId: 'latency-racing-01' });
  await f.runtime.ingestVerifiedMetaEvent({ verified: true, eventId: 'latency-racing-answer', type: 'connect',
    callId: call.call.providerCallId, phoneNumberId: 'business-1', direction: 'outgoing',
    answerSdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n', occurredAtMs: f.now() });
  let calls = 0;
  f.provider.connectOutgoing = async () => { calls++; entered.resolve(); await release.promise; };
  const first = f.runtime.dispatchSetupSignals(call.call.sessionId);
  await entered.promise;
  try { await Promise.all(Array.from({ length: 4 }, () => f.runtime.dispatchSetupSignals(call.call.sessionId))); }
  finally { release.resolve(); await first; }
  assert.equal(calls, 1);
});

test('End dispatch still reaches the customer while a priority transfer push is stalled', async () => {
  const f = fixture(), entered = deferred(), release = deferred(), ended = deferred();
  const call = await f.connected();
  const invite = await f.runtime.transfer('a', call.call.sessionId, 'invite', { version: call.call.version,
    toDeviceId: 'b', requestId: 'latency-push-stall-01' });
  f.runtime.notify = async event => { if (event.event === 'transfer-incoming') { entered.resolve(); await release.promise; } };
  f.provider.terminateCustomer = async () => { ended.resolve(); };
  const setup = f.runtime.dispatchSetupSignals(call.call.sessionId);
  await entered.promise;
  await f.runtime.end('a', call.call.sessionId, { requestId: 'latency-end-stall-01', expectedOwnerLegId: call.call.ownerLegId });
  const recovery = f.runtime.recoverSession(call.call.sessionId);
  let reached;
  try { reached = await waitFor(ended.promise); }
  finally { release.resolve(); await setup; await recovery; }
  assert.equal(reached, true);
  assert.ok(invite.call.transfer.id);
});

test('transfer target listing reads policy a bounded number of times rather than per phone', async () => {
  const f = fixture(), call = await f.connected();
  let checks = 0;
  const prior = f.runtime.capabilityProvider;
  f.runtime.capabilityProvider = async () => { checks++; return prior(); };
  const rows = await f.runtime.availableDevices('a', call.call.sessionId);
  assert.ok(rows.devices.length >= 2);
  assert.equal(checks, 2, 'one release gate plus one list policy snapshot, independent of phone count');
});

test('route timings contain fixed action labels and elapsed time without request secrets', async () => {
  const routes = new Map(), timing = [], scheduled = [];
  const req = { method: 'POST', params: { callId: 'private-customer-call' },
    headers: { authorization: 'Bearer PRIVATE_DEVICE_CREDENTIAL' }, body: { token: 'PRIVATE_ROOM_TOKEN', sdp: 'PRIVATE_SDP' } };
  const result = {};
  const res = { set(key, value) { (result.headers ||= {})[key] = value; return this; },
    status(value) { result.status = value; return this; }, json(value) { result.body = value; return this; } };
  mountNativeCallRoutes({ post: (path, fn) => routes.set(path, fn), get() {} }, {
    runtime: { accept: async () => ({ call: { sessionId: 'private-customer-call' } }) },
    scheduleRecovery: id => scheduled.push(id), onTiming: row => timing.push(row) });
  await routes.get('/api/operator-android/calls/:callId/accept')(req, res);
  assert.equal(result.status, 200);
  assert.match(result.headers['Server-Timing'], /^sh-call;dur=\d+(?:\.\d+)?$/);
  assert.equal(timing[0].action, 'accept');
  assert.equal(timing[0].ok, true);
  assert.ok(Number.isSafeInteger(timing[0].elapsedMs));
  assert.doesNotMatch(JSON.stringify(timing), /PRIVATE_|private-customer-call/);
  assert.deepEqual(scheduled, ['private-customer-call']);
});

test('customer End during a slow final enrollment recheck prevents a late join response', async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  let issued = false;
  const issueJoin = f.provider.issueOperatorJoin;
  f.provider.issueOperatorJoin = async args => { issued = true; return issueJoin(args); };
  const recheck = f.runtime.recheck.bind(f.runtime);
  f.runtime.recheck = async (...args) => {
    if (issued) { entered.resolve(); await release.promise; }
    return recheck(...args);
  };
  await f.incoming();
  const accepting = f.accept();
  await entered.promise;
  const state = await f.runtime.status('a', 'call-in-1');
  await f.runtime.end('a', 'call-in-1', { version: state.call.version, requestId: 'end-during-auth-01' });
  release.resolve();
  await assert.rejects(accepting, { code: 'CALL_ENDED' });
});
