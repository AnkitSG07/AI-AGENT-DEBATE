import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, deferred } from '../operator-r12-helpers.mjs';
import { deviceReservationKey, callStoreKey } from '../../media/transfer-controller.mjs';
import { sessionKey } from '../../call-runtime/call-runtime.mjs';

test('status reports only the authenticated device reservation, independently of another call owner', async () => {
  const f = fixture(); await f.incoming();
  assert.equal((await f.runtime.status('a', 'call-in-1')).deviceAvailable, true);
  assert.equal((await f.runtime.status('a', 'call-in-1')).deviceAvailableForCall, true);
  await f.accept('call-in-1', 'b');
  assert.equal((await f.runtime.status('a', 'call-in-1')).deviceAvailable, true);
  assert.equal((await f.runtime.status('b', 'call-in-1')).deviceAvailable, false);
});

test('waiting-call status sees a pending outgoing reservation before any provider call ID arrives', async () => {
  const f = fixture(); await f.incoming('waiting-call');
  const entered = deferred(), release = deferred(), dial = f.provider.dialOutgoing;
  f.provider.dialOutgoing = async data => { entered.resolve(); await release.promise; return dial(data); };
  const pending = f.runtime.outgoing('a', { to: '919999999999', requestId: 'pending-outgoing-status' });
  try {
    await entered.promise;
    const status = await f.runtime.status('a', 'waiting-call');
    assert.equal(status.call.ownerDeviceId, null);
    assert.equal(status.deviceAvailable, false);
    assert.equal(status.deviceAvailableForCall, false);
  } finally { release.resolve(); await pending; }
});

test('local End acknowledgement does not report available until durable cleanup releases the reservation', async () => {
  const f = fixture(); const active = await f.connected(); await f.incoming('waiting-call');
  await f.runtime.end('a', active.call.sessionId, { version: active.call.version,
    requestId: 'end-before-waiting-answer', expectedOwnerLegId: active.call.ownerLegId });
  assert.equal((await f.runtime.status('a', 'waiting-call')).deviceAvailable, false);
  for (let i = 0; i < 3; i++) await f.runtime.recoverSession(active.call.sessionId);
  assert.equal((await f.runtime.status('a', 'waiting-call')).deviceAvailable, true);
});

test('storage failure cannot be mistaken for an available device', async () => {
  const f = fixture(); await f.incoming();
  const read = f.store.get.bind(f.store);
  f.runtime.store = { ...f.store, get: async key => {
    if (key === deviceReservationKey('a')) throw Error('SIMULATED_RESERVATION_READ_UNAVAILABLE');
    return read(key);
  } };
  await assert.rejects(f.runtime.status('a', 'call-in-1'), /SIMULATED_RESERVATION_READ_UNAVAILABLE/);
});

test('an earlier available observation cannot bypass atomic ownership when another call wins', async () => {
  const f = fixture(); await f.incoming('first-call'); await f.incoming('waiting-call');
  assert.equal((await f.runtime.status('a', 'waiting-call')).deviceAvailable, true);
  await f.accept('first-call', 'a');
  await assert.rejects(f.accept('waiting-call', 'a'), { code: 'DEVICE_BUSY' });
  assert.equal((await f.runtime.status('a', 'waiting-call')).deviceAvailable, false);
});

test('DEVICE_BUSY does not persist an accept result and the same request ID succeeds once cleanup releases the device', async () => {
  const f = fixture(); const active = await f.connected(); await f.incoming('waiting-call');
  const requestId = 'answer-after-prior-cleanup';
  const accepts = () => f.effects.filter(effect => effect.kind === 'accept' && effect.callId === 'waiting-call');
  const before = await f.runtime.locate('waiting-call');
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(f.runtime.accept('a', 'waiting-call', { requestId }), { code: 'DEVICE_BUSY' });
    assert.deepEqual(await f.runtime.locate('waiting-call'), before);
    assert.equal(accepts().length, 0);
  }
  await f.runtime.end('a', active.call.sessionId, { version: active.call.version,
    requestId: 'release-prior-call', expectedOwnerLegId: active.call.ownerLegId });
  await assert.rejects(f.runtime.accept('a', 'waiting-call', { requestId }), { code: 'DEVICE_BUSY' });
  for (let i = 0; i < 3; i++) await f.runtime.recoverSession(active.call.sessionId);
  const accepted = await f.runtime.accept('a', 'waiting-call', { requestId });
  assert.equal(accepted.call.ownerDeviceId, 'a');
  assert.equal((await f.runtime.locate('waiting-call')).operations.accept.id, requestId);
  assert.equal(accepts().length, 1);
  const replay = await f.runtime.accept('a', 'waiting-call', { requestId });
  assert.equal(replay.call.ownerLegId, accepted.call.ownerLegId);
  assert.equal(accepts().length, 1);
});

test('an exact live target invitation is available for its own call while remaining globally reserved', async () => {
  const f = fixture(); const active = await f.connected(); await f.incoming('unrelated-call');
  const invited = await f.runtime.transfer('a', active.call.sessionId, 'invite', {
    version: active.call.version, toDeviceId: 'b', requestId: 'availability-exact-invite'
  });
  const state = await f.runtime.status('b', active.call.sessionId);
  assert.equal(state.deviceAvailable, false);
  assert.equal(state.deviceAvailableForCall, true);
  assert.equal((await f.runtime.status('a', active.call.sessionId)).deviceAvailableForCall, false);
  assert.equal((await f.runtime.status('b', 'unrelated-call')).deviceAvailableForCall, false);
  await f.runtime.transfer('b', active.call.sessionId, 'accept', {
    version: invited.call.version, transferId: invited.call.transfer.id
  });
  const connecting = await f.runtime.status('b', active.call.sessionId);
  assert.equal(connecting.call.transfer.status, 'connecting');
  assert.equal(connecting.deviceAvailable, false);
  assert.equal(connecting.deviceAvailableForCall, true);
});

test('transfer availability fails closed for missing, mismatched, expired or old-enrollment invite reservations', async () => {
  const f = fixture(); const active = await f.connected();
  await f.runtime.transfer('a', active.call.sessionId, 'invite', {
    version: active.call.version, toDeviceId: 'b', requestId: 'availability-stale-invite'
  });
  const reservationKey = deviceReservationKey('b'), canonicalKey = callStoreKey(active.call.callId);
  const reservation = await f.store.get(reservationKey), canonical = await f.store.get(canonicalKey);
  const session = await f.runtime.locate(active.call.sessionId);
  // Simulate a stale or missing read without bypassing production write guards.
  // The normal store correctly refuses moving an existing reservation to another call.
  const observations = new Map(), read = f.store.get.bind(f.store);
  f.runtime.store = { ...f.store, get: async key => observations.has(key)
    ? structuredClone(observations.get(key)) : read(key) };
  for (const [name, change] of [
    ['missing reservation', null],
    ['another call', { ...reservation, callId: 'another-call' }],
    ['old transfer', { ...reservation, transferId: 'old-transfer' }],
    ['cleanup still running', { ...reservation, kind: 'cleanup' }],
    ['expired reservation', { ...reservation, expiresAt: f.now() - 1 }]
  ]) {
    observations.set(reservationKey, change || undefined);
    assert.equal((await f.runtime.status('b', active.call.sessionId)).deviceAvailableForCall, false, name);
  }
  observations.delete(reservationKey);
  for (const [name, change] of [
    ['expired invitation', { ...canonical, transfer: { ...canonical.transfer, expiresAt: f.now() - 1 } }],
    ['different target user', { ...canonical, transfer: { ...canonical.transfer, toUserId: 'native:other' } }],
    ['changed source owner', { ...canonical, owner: { ...canonical.owner, deviceId: 'c' } }],
    ['ended call', { ...canonical, active: false }]
  ]) {
    observations.set(canonicalKey, change);
    assert.equal((await f.runtime.status('b', active.call.sessionId)).deviceAvailableForCall, false, name);
  }
  observations.delete(canonicalKey);
  f.devices.get('b').credentialGeneration++;
  assert.equal((await f.runtime.status('b', active.call.sessionId)).deviceAvailableForCall, false, 'old enrollment');
  f.devices.get('b').credentialGeneration--;
  observations.set(sessionKey(session.id), { ...session, transferBindings: {} });
  assert.equal((await f.runtime.status('b', active.call.sessionId)).deviceAvailableForCall, false, 'missing exact binding');
});
