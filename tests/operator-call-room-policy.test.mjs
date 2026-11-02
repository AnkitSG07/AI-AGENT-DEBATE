import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, deferred } from './operator-r12-helpers.mjs';
import { deviceReservationKey } from '../media/transfer-controller.mjs';
import { createNativeCallRuntime } from '../call-runtime/startup.mjs';
import { createOperatorMediaGateway } from '../operator-media-gateway.js';

function service(f, overrides = {}) {
  return createNativeCallRuntime({ store: f.store, provider: f.provider, authenticate: f.actor,
    resolveDevice: async id => structuredClone(f.devices.get(id)), phoneNumberId: 'business-1', now: f.now,
    ...overrides });
}
const incoming = (runtime, id = 'room-policy-incoming') => runtime.ingestVerifiedMetaEvent({
  verified: true, eventId: `incoming-${id}`, type: 'incoming', callId: id, phoneNumberId: 'business-1',
  direction: 'incoming', customerPhone: '919999999999', offerSdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'
});

test('production room policy skips pilot enumeration while full capabilities still read current enrollments', async () => {
  let args, lists = 0;
  const at = 1800000000000;
  const env = { SH_ANDROID_REGISTRY_BACKEND: 'firestore', WHATSAPP_PHONE_NUMBER_ID: 'business-1',
    META_WHATSAPP_APP_SECRET: 'synthetic-webhook-secret', SH_NATIVE_CALLS_ENABLED: 'true',
    SH_NATIVE_TRANSFER_PILOT_ENABLED: 'true', SH_NATIVE_PILOT_USE_ENROLLED_DEVICES: 'true' };
  createOperatorMediaGateway({ env, now: () => at,
    firestoreRuntime: { firestore: {}, collectionPrefix: 'sh_operator', deviceRegistry: {
      listDevices: async () => { lists++; return ['a', 'b'].map(id => ({ id, credentialGeneration: 1,
        tokenExpiresAt: at + 60000, nativeBuild: 10, mediaProtocol: 'sh-room-audio-v1' })); }
    } },
    storeFactory: () => ({ durable: true }), runtimeFactory: value => { args = value; return { runtime: {} }; }
  });
  assert.equal((await args.roomCapabilities()).roomCalling, true);
  assert.equal(lists, 0, 'ordinary call admission has no unused pilot registry read');
  assert.deepEqual((await args.capabilities()).pilotDeviceIds, ['a', 'b']);
  assert.equal(lists, 1);
  await args.capabilities(); assert.equal(lists, 2, 'transfer/UI policy is still fresh on each evaluation');
  const f = fixture(), connected = await f.connected();
  const s = service(f, { capabilities: args.capabilities, listDevices: args.listDevices });
  await s.verifyConfiguration(); lists = 0;
  assert.deepEqual((await s.runtime.availableDevices('a', connected.call.sessionId)).devices.map(row => row.deviceId), ['b']);
  assert.equal(lists, 2, 'one pilot snapshot and one directory read; no repeated pilot preflight');
  env.SH_NATIVE_CALLS_ENABLED = 'false'; assert.equal((await args.roomCapabilities()).roomCalling, false);
});

test('room policy retains startup verification, explicit enablement and disable-new-calls gates', async () => {
  const f = fixture(); let enabled = true;
  const s = service(f, { roomCapabilities: async () => ({ roomCalling: enabled }),
    capabilities: async () => { throw Error('full transfer policy must not run for room admission'); } });
  await assert.rejects(incoming(s.runtime), { code: 'ROOM_CALLING_NOT_ENABLED' });
  await s.verifyConfiguration();
  await incoming(s.runtime);
  enabled = false;
  await assert.rejects(incoming(s.runtime, 'room-policy-disabled'), { code: 'ROOM_CALLING_NOT_ENABLED' });
  enabled = true; s.disableNewCalls();
  await assert.rejects(incoming(s.runtime, 'room-policy-unverified'), { code: 'ROOM_CALLING_NOT_ENABLED' });
});

test('incoming, Answer and outgoing avoid unrelated pilot reads without bypassing device authorization', async () => {
  const f = fixture(); let roomChecks = 0, fullChecks = 0;
  const s = service(f, { roomCapabilities: async () => { roomChecks++; return { roomCalling: true }; },
    capabilities: async () => { fullChecks++; throw Error('pilot registry unavailable'); } });
  await s.verifyConfiguration();
  await incoming(s.runtime);
  f.devices.get('a').revoked = true;
  await assert.rejects(s.runtime.accept('a', 'room-policy-incoming', { requestId: 'room-policy-answer' }), { code: 'DEVICE_BINDING_INVALID' });
  assert.equal(f.effects.filter(row => row.kind === 'accept').length, 0);
  f.devices.get('a').revoked = false;
  const accepted = await s.runtime.accept('a', 'room-policy-incoming', { requestId: 'room-policy-answer' });
  assert.ok(accepted.join); assert.equal(accepted.call.roomReady, false, 'a token is not real-audio readiness');
  await s.runtime.outgoing('b', { to: '919999999999', requestId: 'room-policy-outgoing' });
  assert.equal(fullChecks, 0); assert.equal(roomChecks, 3);
});

test('room admission cannot grant transfer pilot membership or hide current capability failures', async () => {
  const f = fixture(), connected = await f.connected(); let fullChecks = 0;
  const s = service(f, { roomCapabilities: async () => ({ roomCalling: true, transferEnabled: true, pilotDeviceIds: ['a', 'b'] }),
    capabilities: async () => { fullChecks++; return { roomCalling: true, transferEnabled: true,
      mode: 'pilot', pilotEnabled: true, pilotDeviceIds: ['a', 'c'] }; } });
  await s.verifyConfiguration();
  await assert.rejects(s.runtime.transfer('a', connected.call.sessionId, 'invite', {
    version: connected.call.version, toDeviceId: 'b', requestId: 'room-policy-transfer'
  }), { code: 'DEVICE_NOT_IN_TRANSFER_PILOT' });
  assert.equal(fullChecks, 1);
  const caps = await s.runtime.capabilities('a');
  assert.equal(caps.roomCalling, true); assert.equal(fullChecks, 2);
  s.runtime.capabilityProvider = async () => { throw Error('full policy unavailable'); };
  await assert.rejects(s.runtime.capabilities('a'), /full policy unavailable/);
});

test('existing runtime integrations keep the full policy when no room-only provider is supplied', async () => {
  const f = fixture(); let calls = 0, enabled = false;
  const s = service(f, { capabilities: async () => { calls++; return { roomCalling: enabled }; } });
  await s.verifyConfiguration();
  await assert.rejects(incoming(s.runtime), { code: 'ROOM_CALLING_NOT_ENABLED' });
  enabled = true; await incoming(s.runtime); assert.equal(calls, 2);
});

test('transfer picker overlaps fresh policy and directory reads and evaluates policy once', async () => {
  const f = fixture(), connected = await f.connected();
  const release = deferred(), directoryEntered = deferred(), policyEntered = deferred();
  let policies = 0, directories = 0;
  f.runtime.capabilityProvider = async () => {
    policies++; policyEntered.resolve(); await release.promise;
    return { roomCalling: true, transferEnabled: true, mode: 'pilot', pilotDeviceIds: ['a', 'b'] };
  };
  f.runtime.listDevices = async () => {
    directories++; directoryEntered.resolve(); await release.promise;
    return [...f.devices.values()].map(row => structuredClone(row));
  };
  const listing = f.runtime.availableDevices('a', connected.call.sessionId);
  let timer;
  try {
    const started = await Promise.race([
      Promise.all([directoryEntered.promise, policyEntered.promise]).then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), 1000); })
    ]);
    assert.equal(started, true, 'neither network lookup waits behind the other');
  } finally { clearTimeout(timer); release.resolve(); }
  const result = await listing;
  assert.equal(policies, 1); assert.equal(directories, 1);
  assert.deepEqual(result.devices.map(row => row.deviceId), ['b']);
  assert.equal(result.devices[0].available, true);
});

test('transfer picker rejects revoked/non-owner devices before directory reads and uses fresh disable state', async () => {
  const f = fixture(), connected = await f.connected();
  let policies = 0, directories = 0, enabled = true;
  f.runtime.capabilityProvider = async () => { policies++; return { roomCalling: true, transferEnabled: enabled }; };
  f.runtime.listDevices = async () => { directories++; return [...f.devices.values()].map(row => structuredClone(row)); };
  f.devices.get('a').revoked = true;
  await assert.rejects(f.runtime.availableDevices('a', connected.call.sessionId), { code: 'DEVICE_BINDING_INVALID' });
  f.devices.get('a').revoked = false;
  await assert.rejects(f.runtime.availableDevices('b', connected.call.sessionId), { code: 'NOT_CALL_OWNER' });
  assert.equal(policies, 0); assert.equal(directories, 0);
  await f.runtime.availableDevices('a', connected.call.sessionId);
  enabled = false;
  await assert.rejects(f.runtime.availableDevices('a', connected.call.sessionId), { code: 'TRANSFER_MEDIA_NOT_VALIDATED' });
  assert.equal(policies, 2); assert.equal(directories, 2, 'each authorized request gets a fresh directory');
});

test('transfer picker checks independent target reservations concurrently and preserves busy hints', async () => {
  const f = fixture(), connected = await f.connected();
  const release = deferred(), bothEntered = deferred(), entered = new Set();
  const get = f.store.get.bind(f.store);
  f.runtime.store = { ...f.store, get: async key => {
    if ([deviceReservationKey('b'), deviceReservationKey('c')].includes(key)) {
      entered.add(key); if (entered.size === 2) bothEntered.resolve();
      await release.promise;
      return key === deviceReservationKey('b') ? { kind: 'owner', callId: 'another-call' } : undefined;
    }
    return get(key);
  } };
  const listing = f.runtime.availableDevices('a', connected.call.sessionId);
  let timer;
  try {
    const started = await Promise.race([bothEntered.promise.then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), 1000); })]);
    assert.equal(started, true);
  } finally { clearTimeout(timer); release.resolve(); }
  assert.deepEqual((await listing).devices.map(({ deviceId, available }) => ({ deviceId, available })),
    [{ deviceId: 'b', available: false }, { deviceId: 'c', available: true }]);
});

test('transfer picker locates its call while authentication runs, without releasing a listing first', async () => {
  const f = fixture(), connected = await f.connected(), release = deferred(), located = deferred();
  const authenticate = f.runtime.authenticate, locate = f.runtime.locate.bind(f.runtime);
  let directoryReads = 0;
  f.runtime.authenticate = async context => { await release.promise; return authenticate(context); };
  f.runtime.locate = async id => { located.resolve(); return locate(id); };
  f.runtime.listDevices = async () => { directoryReads++; return [...f.devices.values()]; };
  const listing = f.runtime.availableDevices('a', connected.call.sessionId);
  let timer;
  try {
    const started = await Promise.race([located.promise.then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), 1000); })]);
    assert.equal(started, true, 'the call lookup does not wait behind credential transport');
    assert.equal(directoryReads, 0, 'the lookup hint grants no authority while authentication is pending');
  } finally { clearTimeout(timer); release.resolve(); }
  assert.equal((await listing).devices.length, 2);
});
