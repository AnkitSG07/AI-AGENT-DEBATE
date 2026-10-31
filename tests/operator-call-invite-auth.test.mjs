import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './operator-r12-helpers.mjs';
import { createNativeCallRuntime } from '../call-runtime/startup.mjs';
import { callStoreKey, deviceReservationKey } from '../media/transfer-controller.mjs';

async function setup() {
  const f = fixture(), connected = await f.connected(); let authCalls = 0;
  const s = createNativeCallRuntime({ store: f.store, provider: f.provider,
    authenticate: async context => { authCalls++; return f.actor(context); },
    resolveDevice: async id => structuredClone(f.devices.get(id)), phoneNumberId: 'business-1', now: f.now,
    capabilities: async () => ({ roomCalling: true, transferEnabled: true,
      mode: 'pilot', pilotEnabled: true, pilotDeviceIds: ['a', 'b'] }) });
  await s.verifyConfiguration();
  const body = { version: connected.call.version, toDeviceId: 'b', requestId: 'invite-auth-test' };
  return { ...f, ...s, connected, body, authCalls: () => authCalls,
    invite: () => s.runtime.transfer('a', connected.call.sessionId, 'invite', body) };
}

test('native invite uses one initial authentication and one fresh controller authentication', async () => {
  const f = await setup();
  const result = await f.invite();
  assert.equal(result.call.transfer.status, 'invited'); assert.equal(f.authCalls(), 2);
  assert.equal(f.effects.filter(row => ['accept', 'terminate', 'detach'].includes(row.kind)).length, 1,
    'inviting does not modify the existing customer/operator media legs');
});

for (const change of ['revoke', 'rotate']) test(`${change} after invite preflight prevents any invitation or reservation commit`, async () => {
  const f = await setup(), resolve = f.runtime.resolveDevice;
  f.runtime.resolveDevice = async (id, context) => {
    const value = await resolve(id, context);
    if (id === 'b' && context === undefined) {
      if (change === 'revoke') f.devices.get('a').revoked = true;
      else f.devices.get('a').credentialGeneration++;
    }
    return value;
  };
  // Request JSON cannot replace the runtime's original source generation.
  f.body.expectedSourceBinding = { deviceId: 'a', userId: 'native:a', tenantId: 'smart-handicrafts', credentialGeneration: 2 };
  const before = f.db.commits;
  await assert.rejects(f.invite(), { code: change === 'revoke' ? 'DEVICE_BINDING_INVALID' : 'DEVICE_BINDING_CHANGED' });
  assert.equal(f.authCalls(), 2); assert.equal(f.db.commits, before);
  const call = await f.store.get(callStoreKey(f.connected.call.providerCallId));
  assert.equal(call.transfer, null); assert.equal(await f.store.get(deviceReservationKey('b')), undefined);
});

test('malformed or mismatched source constraints cannot replace fresh controller authentication', async () => {
  const f = await setup(), before = f.db.commits;
  for (const expectedSourceBinding of [null, {}, { deviceId: 'a', userId: 'native:a', tenantId: 'smart-handicrafts', credentialGeneration: 0 },
    { deviceId: 'a', userId: 'another-user', tenantId: 'smart-handicrafts', credentialGeneration: 1 }]) {
    await assert.rejects(f.controller.invite('a', { callId: f.connected.call.providerCallId, toDeviceId: 'b',
      expectedVersion: f.body.version, requestId: 'invite-auth-invalid', expectedSourceBinding }), { code: 'DEVICE_BINDING_CHANGED' });
  }
  assert.equal(f.authCalls(), 4); assert.equal(f.db.commits, before);
});

test('custom controllers without source-binding support retain the runtime pre-invite recheck', async () => {
  const f = await setup(), original = f.runtime.transferController; let checks = 0;
  f.runtime.transferController = { enforcesRuntimeCapabilities: true, invite: original.invite.bind(original) };
  const recheck = f.runtime.recheck.bind(f.runtime);
  f.runtime.recheck = async (...args) => { checks++; return recheck(...args); };
  assert.equal((await f.invite()).call.transfer.status, 'invited');
  assert.equal(checks, 1); assert.equal(f.authCalls(), 3);
});
