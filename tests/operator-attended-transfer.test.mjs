import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, deferred } from './operator-r12-helpers.mjs';
import { AttendedTransferController, customerOnHold } from '../media/attended-transfer.mjs';
import { callStoreKey, deviceReservationKey } from '../media/transfer-controller.mjs';

function setup() {
  const f = fixture();
  for (const row of f.devices.values()) row.nativeBuild = 22;
  const original = f.controller;
  const controller = new AttendedTransferController({ store: f.store, provider: f.provider, authenticate: f.actor,
    resolveDevice: original.resolveDevice, now: f.now, rolloutGuard: original.rolloutGuard,
    verifyReadiness: data => f.runtime.verifyTransferReadiness(data) });
  f.controller = controller; f.runtime.transferController = controller;
  f.runtime.tools = { prepareHandover: async () => {}, view: () => ({ state: 'idle' }) };
  const invite = async mode => {
    const call = await f.connected();
    return f.runtime.transfer('a', call.call.sessionId, 'invite', {
      version: call.call.version, toDeviceId: 'b', requestId: 'attended-invite-01', mode });
  };
  const accept = async result => f.runtime.transfer('b', result.call.sessionId, 'accept', {
    version: result.call.version, transferId: result.call.transfer.id, expectedTransferId: result.call.transfer.id });
  const ready = async result => f.runtime.transfer('b', result.call.sessionId, 'ready', {
    version: result.call.version, transferId: result.call.transfer.id, readinessNonce: result.readinessNonce,
    evidence: { unitTest: true } });
  return { ...f, invite, accept, ready };
}

test('private handover keeps A and customer connected until A explicitly completes it', async () => {
  const f = setup(), invitation = await f.invite('consult'), accepted = await f.accept(invitation);
  let canonical = await f.store.get(callStoreKey(accepted.call.providerCallId));
  assert.equal(accepted.join.customerIdentity, canonical.transfer.sourceIdentity);
  assert.equal(accepted.join.actualCustomerIdentity, canonical.customerIdentity);
  assert.equal(customerOnHold(canonical), true);
  const privateReady = await f.ready(accepted);
  assert.equal(privateReady.call.ownerDeviceId, 'a');
  assert.equal(privateReady.call.transfer.consultReady, true);
  assert.equal((await f.store.get(callStoreKey(canonical.id))).outbox.filter(job => job.kind === 'detach').length, 0);
  const deciding = await f.runtime.transfer('a', privateReady.call.sessionId, 'complete', {
    transferId: privateReady.call.transfer.id, version: privateReady.call.version });
  assert.equal(deciding.call.ownerDeviceId, 'a', 'changing the route is not yet verified customer audio');
  assert.equal(deciding.call.transfer.consultStage, 'customer');
  assert.equal(customerOnHold(await f.store.get(callStoreKey(canonical.id))), true, 'music continues until destination customer audio is verified');
  const completed = await f.ready({ ...deciding, readinessNonce: accepted.readinessNonce });
  assert.equal(completed.call.ownerDeviceId, 'b');
  assert.equal(customerOnHold(await f.store.get(callStoreKey(canonical.id))), false);
  await assert.rejects(f.runtime.end('a', completed.call.sessionId, {requestId: 'source-late-end-001', expectedOwnerLegId: canonical.owner.legId}), error => ['NOT_CALL_OWNER', 'CALL_LEG_CHANGED'].includes(error.code));
  assert.equal((await f.store.get(callStoreKey(canonical.id))).active, true);
  await f.controller.drainOutbox(canonical.id);
  assert.equal(f.effects.some(effect => effect.kind === 'terminate'), false);
  assert.equal(f.effects.some(effect => effect.kind === 'detach' && effect.identity === canonical.owner.identity), true);
});

test('merge keeps both operator legs and customer; B leaving restores A', async () => {
  const f = setup(), accepted = await f.accept(await f.invite('consult')), ready = await f.ready(accepted);
  const mergedRoute = await f.runtime.transfer('a', ready.call.sessionId, 'merge', {
    transferId: ready.call.transfer.id, version: ready.call.version });
  const merged = await f.ready({ ...mergedRoute, readinessNonce: accepted.readinessNonce });
  assert.equal(merged.call.ownerDeviceId, 'a');
  assert.equal(merged.call.transfer.consultStage, 'merged');
  const before = await f.store.get(callStoreKey(merged.call.providerCallId));
  assert.equal(customerOnHold(before), false);
  assert.equal(before.outbox.some(row => row.kind === 'detach'), false);
  const expiryJobs = [...f.db.documents.values()].filter(row => row.workType === 'expire' && row.transferId === before.transfer.id);
  assert.ok(expiryJobs.length > 0); assert.ok(expiryJobs.every(row => row.sourceDueAtMs === Number.MAX_SAFE_INTEGER), 'merged calls leave the expiry recovery queue');
  f.advance(11 * 60 * 1000);
  assert.equal(await f.controller.expire(before.id), false, 'conference does not expire with the original invitation');
  const cancelled = await f.runtime.transfer('b', ready.call.sessionId, 'decline', {
    transferId: merged.call.transfer.id, version: merged.call.version });
  assert.equal(cancelled.call.ownerDeviceId, 'a');
  assert.equal(cancelled.call.transfer.status, 'declined');
  await f.controller.drainOutbox(before.id);
  assert.equal(f.effects.some(row => row.kind === 'terminate'), false);
});

test('private readiness extends only the due index; polling cannot renew the consultation', async () => {
  const f = setup(), accepted = await f.accept(await f.invite('consult'));
  const before = await f.store.get(callStoreKey(accepted.call.providerCallId));
  const ready = await f.ready(accepted);
  const current = await f.store.get(callStoreKey(before.id));
  assert.equal(current.transfer.expiresAt, before.transfer.expiresAt);
  assert.equal(current.transfer.consultDeadlineAt, f.now() + 600000);
  f.advance(65000);
  assert.equal((await f.runtime.status('b', ready.call.sessionId)).deviceAvailableForCall, true);
  await assert.rejects(f.store.transaction(async tx => {
    const call = await tx.get(callStoreKey(before.id)); call.version++; call.updatedAt = f.now(); call.transfer.consultDeadlineAt++;
    tx.set(callStoreKey(before.id), call);
  }), error => error.code === 'TRANSFER_GENERATION_WINS');
  f.advance(600000); assert.equal(await f.controller.expire(before.id), true);
});

test('lost hold media cancels only the exact private consultation, never a completed or merged route', async () => {
  const f = setup(), accepted = await f.accept(await f.invite('consult')), ready = await f.ready(accepted);
  assert.equal(await f.controller.abortConsultation(ready.call.providerCallId, 'wrong-transfer'), false);
  assert.equal(await f.controller.abortConsultation(ready.call.providerCallId, ready.call.transfer.id), true);
  const call = await f.store.get(callStoreKey(ready.call.providerCallId));
  assert.equal(call.active, true); assert.equal(call.owner.deviceId, 'a'); assert.equal(customerOnHold(call), false);
  assert.equal(call.transfer.reason, 'hold_audio_unavailable');
  await f.controller.drainOutbox(call.id); assert.equal(f.effects.some(effect => effect.kind === 'terminate'), false);
});

test('private handover cancellation and no-answer release only the destination', async () => {
  for (const action of ['cancel', 'decline', 'timeout']) {
    const f = setup(), invitation = await f.invite('consult');
    if (action === 'timeout') { f.advance(60001); await f.controller.expire(invitation.call.providerCallId); }
    else await f.runtime.transfer(action === 'cancel' ? 'a' : 'b', invitation.call.sessionId, action,
      { transferId: invitation.call.transfer.id, version: invitation.call.version });
    const call = await f.store.get(callStoreKey(invitation.call.providerCallId));
    assert.equal(call.active, true); assert.equal(call.owner.deviceId, 'a'); assert.equal(customerOnHold(call), false);
    assert.equal(await f.store.get(deviceReservationKey('b')), undefined);
  }
});

test('old builds remain supported for instant transfer but cannot receive a private handover', async () => {
  const f = setup(); f.devices.get('b').nativeBuild = 21;
  await assert.rejects(f.invite('consult'), error => error.code === 'HANDOVER_UPDATE_REQUIRED');
  const status = await f.runtime.status('a', 'call-in-1');
  const direct = await f.runtime.transfer('a', 'call-in-1', 'invite', {
    version: status.call.version, toDeviceId: 'b', requestId: 'direct-old-0001', mode: 'instant' });
  assert.equal(direct.call.transfer.mode, 'instant');
});

test('B cannot complete or merge A’s call, and stale A decisions cannot overwrite cancellation', async () => {
  const f = setup(), accepted = await f.accept(await f.invite('consult')), ready = await f.ready(accepted);
  const body = { transferId: ready.call.transfer.id, version: ready.call.version };
  await assert.rejects(f.runtime.transfer('b', ready.call.sessionId, 'merge', body), error => error.code === 'TRANSFER_FORBIDDEN');
  await f.runtime.transfer('a', ready.call.sessionId, 'cancel', body);
  await assert.rejects(f.runtime.transfer('a', ready.call.sessionId, 'complete', body), error => error.code === 'STALE_CALL_VERSION');
});

test('customer hangup during a slow consultation readiness check wins over the late result', async () => {
  const f = setup(), accepted = await f.accept(await f.invite('consult'));
  const entered = deferred(), release = deferred(), original = f.runtime.verifyReadiness;
  f.runtime.verifyReadiness = async value => { entered.resolve(); await release.promise; return original(value); };
  const pending = f.ready(accepted); pending.catch(() => {}); await entered.promise;
  await f.runtime.end('a', accepted.call.sessionId, { requestId: 'end-racing-0001', expectedOwnerLegId: (await f.store.get(callStoreKey(accepted.call.providerCallId))).owner.legId });
  release.resolve(); await assert.rejects(pending);
  const call = await f.store.get(callStoreKey(accepted.call.providerCallId));
  assert.equal(call.active, false); assert.equal(call.owner.deviceId, 'a');
});
