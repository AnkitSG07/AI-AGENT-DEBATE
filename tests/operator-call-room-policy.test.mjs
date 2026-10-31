import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './operator-r12-helpers.mjs';
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
