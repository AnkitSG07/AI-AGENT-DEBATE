import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './operator-r12-helpers.mjs';
import { sessionKey } from '../call-runtime/call-runtime.mjs';
import { callStoreKey, deviceReservationKey } from '../media/transfer-controller.mjs';
import { MediaError } from '../media/errors.mjs';
import { recoverMediaWork } from '../media-store/firestore-media-store.mjs';

async function endedBeforeReady({ absence, detachFails = false, confirmed = true } = {}) {
  const f = fixture();
  await f.incoming('previous-call');
  const accepted = await f.accept('previous-call', 'a');
  f.provider.terminateCustomer = async () => { throw new MediaError('MEDIA_PROVIDER_ERROR', 'Synthetic repeated disconnect', 502); };
  if (absence) f.provider.confirmCustomerAbsent = absence;
  if (detachFails) f.provider.detachOperator = async () => { throw Error('Synthetic detach unavailable'); };
  if (confirmed) await f.runtime.ingestVerifiedMetaEvent({ verified: true, type: 'terminate', eventId: 'previous-ended',
    callId: 'previous-call', phoneNumberId: 'business-1', occurredAtMs: f.now() });
  else await f.runtime.end('a', 'previous-call', { expectedOwnerLegId: accepted.call.ownerLegId, requestId: 'local-end-previous' });
  await f.runtime.drainSessionOutbox('previous-call', { limit: 8 });
  assert.equal(await f.store.get(callStoreKey('previous-call')), undefined, 'the call ended before media promotion');
  return { f, accepted };
}

test('pre-media confirmed End uses exact customer absence after a repeated disconnect error', async () => {
  const bindings = [];
  const { f } = await endedBeforeReady({ absence: async b => { bindings.push(b); return true; } });
  const session = await f.runtime.locate('previous-call');
  assert.deepEqual(bindings, [{ roomName: session.roomName, customerIdentity: session.customerIdentity }]);
  assert.equal(session.outbox.find(job => job.kind === 'terminate').status, 'done');
  assert.equal(await f.runtime.releasePreMediaReservation(session.id), true);
  assert.equal(await f.store.get(deviceReservationKey('a')), undefined);
});

for (const [name, absence] of [['present', async () => false], ['unknown', async () => { throw Error('Synthetic outage'); }]]) {
  test(`confirmed End with ${name} connector retains cleanup but releases a successfully detached operator`, async () => {
    const { f } = await endedBeforeReady({ absence });
    assert.equal((await f.runtime.locate('previous-call')).outbox.find(job => job.kind === 'terminate').status, 'pending');
    assert.equal(await f.runtime.releasePreMediaReservation('previous-call'), true);
    assert.equal(await f.store.get(deviceReservationKey('a')), undefined);
    const view = await f.runtime.view(await f.runtime.locate('previous-call'));
    assert.equal(view.endConfirmed, true); assert.equal(view.cleanupPending, true);
  });
}

test('local End intent alone cannot release a reserved phone or fabricate provider confirmation', async () => {
  let checked = 0;
  const { f } = await endedBeforeReady({ confirmed: false, absence: async () => { checked++; return true; } });
  assert.equal(checked, 0);
  assert.equal(await f.runtime.releasePreMediaReservation('previous-call'), false);
  assert.equal((await f.store.get(deviceReservationKey('a'))).kind, 'cleanup');
  await f.incoming('waiting-call');
  await assert.rejects(f.accept('waiting-call', 'a'), { code: 'DEVICE_BUSY' });
});

test('failed operator revocation keeps the old reservation even with confirmed customer absence', async () => {
  const { f } = await endedBeforeReady({ absence: async () => true, detachFails: true });
  assert.equal(await f.runtime.releasePreMediaReservation('previous-call'), false);
  await f.incoming('waiting-call');
  assert.equal((await f.runtime.status('a', 'waiting-call')).deviceAvailable, false);
  await assert.rejects(f.accept('waiting-call', 'a'), { code: 'DEVICE_BUSY' });
});

test('an unsettled provider operation keeps the reservation after confirmed End and operator detach', async () => {
  const { f } = await endedBeforeReady();
  await f.store.transaction(async tx => {
    const s = await tx.get(sessionKey('previous-call'));
    s.operations.lateSetup = { id: 'late-setup', status: 'issued', issuedAt: f.now(), leaseUntil: f.now() + 45000 };
    tx.set(sessionKey(s.id), s);
  });
  assert.equal(await f.runtime.releasePreMediaReservation('previous-call'), false);
  assert.ok(await f.store.get(deviceReservationKey('a')));
});

test('next Answer recovers the stale ended reservation within the same request without redial or early Connected', async () => {
  const { f } = await endedBeforeReady();
  await f.incoming('waiting-call');
  const accepted = await f.accept('waiting-call', 'a');
  assert.equal(accepted.call.sessionId, 'waiting-call');
  assert.equal(accepted.call.roomReady, false);
  assert.equal(f.effects.filter(e => e.kind === 'accept' && e.callId === 'waiting-call').length, 1);
  assert.equal((await f.store.get(deviceReservationKey('a'))).sessionId, 'waiting-call');
  await f.runtime.recoverSession('previous-call', { limit: 8 });
  assert.equal((await f.store.get(deviceReservationKey('a'))).sessionId, 'waiting-call', 'old cleanup cannot release a newer reservation');
});

test('next outbound call can recover that exact ended reservation without replaying its Dial', async () => {
  const { f } = await endedBeforeReady();
  const started = await f.runtime.outgoing('a', { to: '919999999999', requestId: 'out-after-ended-reservation' });
  assert.equal(started.call.direction, 'outgoing');
  assert.equal(f.effects.filter(e => e.kind === 'dial').length, 1);
  assert.notEqual((await f.store.get(deviceReservationKey('a'))).sessionId, 'previous-call');
});

test('the transfer directory restores an enrolled phone after proven terminal detach', async () => {
  const { f } = await endedBeforeReady();
  await f.incoming('another-call');
  const accepted = await f.accept('another-call', 'b');
  const connected = await f.ready(accepted, 'b');
  const directory = await f.runtime.availableDevices('b', connected.call.sessionId);
  assert.equal(directory.devices.find(row => row.deviceId === 'a').available, true);
  const transfer = await f.runtime.transfer('b', connected.call.sessionId, 'invite', {
    version: connected.call.version, toDeviceId: 'a', requestId: 'transfer-after-ended-reservation'
  });
  assert.equal(transfer.call.transfer.toDeviceId, 'a');
  assert.equal((await f.store.get(deviceReservationKey('a'))).kind, 'invite');
});

test('waiting-call availability recovers the old reservation without changing either customer call', async () => {
  const { f } = await endedBeforeReady();
  await f.incoming('waiting-call');
  const status = await f.runtime.status('a', 'waiting-call');
  assert.equal(status.deviceAvailable, true); assert.equal(status.deviceAvailableForCall, true);
  assert.equal(status.call.phase, 'ringing');
  assert.equal((await f.runtime.locate('previous-call')).phase, 'ended');
});

test('reservation recovery never releases a different device or a genuine active call', async () => {
  const { f } = await endedBeforeReady();
  assert.equal(await f.runtime.releasePreMediaReservation('previous-call', { expectedDeviceId: 'b' }), false);
  assert.ok(await f.store.get(deviceReservationKey('a')));
  await f.incoming('active-call'); await f.accept('active-call', 'b');
  await f.incoming('waiting-call');
  await assert.rejects(f.accept('waiting-call', 'b'), { code: 'DEVICE_BUSY' });
  assert.equal((await f.store.get(deviceReservationKey('b'))).sessionId, 'active-call');
});

test('settled pre-media customer absence produces no further day of cleanup writes', async () => {
  const { f } = await endedBeforeReady({ absence: async () => true });
  await f.runtime.recoverSession('previous-call', { limit: 8 });
  const before = f.db.version;
  for (let hour = 0; hour < 24; hour++) {
    f.advance(3600000);
    await recoverMediaWork({ store: f.store, controller: f.controller, workerId: 'settled-pre-media',
      recoverSession: id => f.runtime.recoverSession(id, { limit: 8 }) });
  }
  assert.equal(f.db.version, before);
});
