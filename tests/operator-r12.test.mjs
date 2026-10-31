import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, deferred, registryFixture, gatewayFixture, fakeFcmToken } from './operator-r12-helpers.mjs';
import { MediaError } from '../media/errors.mjs';
import { sessionKey, eventKey, outgoingSessionId } from '../call-runtime/call-runtime.mjs';
import { deviceReservationKey, callStoreKey } from '../media/transfer-controller.mjs';
import { createHash } from 'node:crypto';
import { createBoundedNativeReject } from '../media/native-meta-reject.mjs';

const sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const uncertain = () => new MediaError('MEDIA_REQUEST_UNCERTAIN', 'Synthetic lost response.', 502,
  { outcomeUnknown: true, operation: 'AcceptWhatsAppCall' });
const event = (f, type, callId, extra = {}) => ({ verified: true, type, callId,
  eventId: `${type}-${callId}`, phoneNumberId: 'business-1', occurredAtMs: f.now(), ...extra });

test('lost incoming Accept acknowledgement resumes the exact existing leg without accepting twice', async () => {
  let accepts = 0, observations = 0, f;
  f = fixture({ provider: { acceptIncoming: async () => { accepts++; throw uncertain(); },
    inspectParticipants: async () => ({ observedAt: f.now(), customerActive: ++observations > 1 }) } });
  await f.incoming();
  await assert.rejects(() => f.accept(), error => error.code === 'MEDIA_REQUEST_UNCERTAIN');
  const before = await f.runtime.locate('call-in-1');
  const resumed = await f.accept();
  assert.equal(accepts, 1);
  assert.equal(resumed.join.identity, before.owner.identity);
  assert.equal(resumed.join.legId, before.owner.legId);
  assert.equal(resumed.call.roomReady, false);
  assert.equal(resumed.call.phase, 'joining');
});

test('a lost Accept response can recover immediately without displaying a definite failure', async () => {
  let accepts = 0;
  const f = fixture({ provider: { acceptIncoming: async () => { accepts++; throw uncertain(); } } });
  await f.incoming();
  const accepted = await f.accept();
  assert.ok(accepted.join);
  assert.equal(accepts, 1);
  assert.equal(accepted.call.roomReady, false);
});

test('lost Accept remains pending when exact customer presence is unavailable or stale', async () => {
  for (const observation of [{ customerActive: false }, { customerActive: true, observedAt: 1 }]) {
    let accepts = 0, f;
    f = fixture({ provider: { acceptIncoming: async () => { accepts++; throw uncertain(); },
      inspectParticipants: async () => ({ observedAt: f.now(), ...observation }) } });
    await f.incoming();
    await assert.rejects(() => f.accept(), error => error.code === 'MEDIA_REQUEST_UNCERTAIN' && error.sessionId === 'call-in-1');
    await assert.rejects(() => f.accept(), error => error.code === 'CALL_OPERATION_PENDING');
    assert.equal(accepts, 1);
    assert.ok(await f.store.get(deviceReservationKey('a')));
  }
});

test('customer termination wins while lost-Accept observation is in flight', async () => {
  const entered = deferred(), released = deferred();
  let f;
  f = fixture({ provider: { acceptIncoming: async () => { throw uncertain(); }, inspectParticipants: async () => {
    entered.resolve(); await released.promise; return { observedAt: f.now(), customerActive: true };
  } } });
  await f.incoming();
  const pending = f.accept().catch(error => error);
  await entered.promise;
  await f.runtime.ingestVerifiedMetaEvent(event(f, 'terminate', 'call-in-1'));
  released.resolve();
  assert.ok((await pending) instanceof MediaError);
  assert.ok((await f.runtime.status('a', 'call-in-1')).call.terminal);
});

test('an outgoing SDP answer received before the dial response is retained and connected once', async () => {
  const entered = deferred(), released = deferred();
  let f;
  f = fixture({ provider: { dialOutgoing: async data => {
    entered.resolve(); await released.promise;
    const saved = await f.store.get(sessionKey(data.requestId));
    return { callId: 'early-outgoing', roomName: saved.roomName, customerIdentity: saved.customerIdentity };
  } } });
  const pending = f.runtime.outgoing('a', { to: '919999999999', requestId: 'early-answer-0001' });
  await entered.promise;
  try {
    const answer = await f.runtime.ingestVerifiedMetaEvent(event(f, 'connect', 'early-outgoing', { answerSdp: sdp }));
    assert.equal(answer.handled, true);
  } finally { released.resolve(); }
  const started = await pending;
  await f.runtime.recoverSession(started.call.sessionId);
  assert.equal((await f.runtime.locate('early-outgoing')).answerSdp, sdp);
  assert.equal(f.effects.filter(row => row.kind === 'connect').length, 1);
  assert.equal((await f.runtime.status('a', 'early-outgoing')).call.roomReady, false);
});

test('early SDP survives a lost dial acknowledgement and later trusted opaque correlation', async () => {
  const f = fixture({ provider: { dialOutgoing: async () => { throw uncertain(); } } });
  const requestId = 'early-and-lost-dial-1';
  await assert.rejects(() => f.runtime.outgoing('a', { to: '919999999999', requestId }), { code: 'MEDIA_REQUEST_UNCERTAIN' });
  await f.runtime.ingestVerifiedMetaEvent(event(f, 'connect', 'early-lost-call', { answerSdp: sdp }));
  const id = outgoingSessionId('smart-handicrafts', 'a', requestId);
  await f.runtime.ingestVerifiedMetaEvent(event(f, 'accepted', 'early-lost-call', { opaqueSessionId: id }));
  const resumed = await f.runtime.accept('a', id, { requestId });
  assert.ok(resumed.join);
  assert.equal((await f.runtime.locate(id)).answerSdp, sdp);
  await f.runtime.recoverSession(id);
  assert.equal(f.effects.filter(row => row.kind === 'connect').length, 1);
});

test('early SDP followed by provider termination never connects when the dial response finally arrives', async () => {
  const entered = deferred(), released = deferred();
  let f;
  f = fixture({ provider: { dialOutgoing: async data => {
    entered.resolve(); await released.promise;
    const saved = await f.runtime.locate(data.requestId);
    return { callId: 'early-ended-call', roomName: saved.roomName, customerIdentity: saved.customerIdentity };
  } } });
  const pending = f.runtime.outgoing('a', { to: '919999999999', requestId: 'early-ended-request' });
  await entered.promise;
  await f.runtime.ingestVerifiedMetaEvent(event(f, 'connect', 'early-ended-call', { answerSdp: sdp }));
  await f.runtime.ingestVerifiedMetaEvent(event(f, 'terminate', 'early-ended-call'));
  released.resolve();
  const result = await pending;
  await f.runtime.recoverSession(result.call.sessionId);
  assert.ok((await f.runtime.locate(result.call.sessionId)).terminal);
  assert.equal(f.effects.filter(row => row.kind === 'connect').length, 0);
});

test('early-answer records support real-sized private SDP, reject conflicting answers, and stay immutable', async () => {
  const f = fixture(), callId = 'large-early-answer';
  const answerSdp = sdp + 'a=x-test:' + 'x'.repeat(50000) + '\r\n';
  await f.runtime.ingestVerifiedMetaEvent(event(f, 'connect', callId, { answerSdp }));
  const id = `answer:${createHash('sha256').update(callId).digest('hex')}`;
  const marker = await f.store.get(eventKey(id));
  assert.equal(marker.answerSdp, answerSdp);
  assert.equal(marker.tenantId, 'smart-handicrafts');
  await assert.rejects(() => f.runtime.ingestVerifiedMetaEvent(event(f, 'connect', callId,
    { eventId: 'different-answer-event', answerSdp: sdp })), { code: 'SDP_ANSWER_CONFLICT' });
  await assert.rejects(() => f.store.transaction(async tx => {
    const row = await tx.get(eventKey(id)); row.answerSdp = sdp; tx.set(eventKey(id), row);
  }));
  assert.equal((await f.store.get(eventKey(id))).answerSdp, answerSdp);
});

test('an early duplicate without a route may acquire trusted opaque correlation without rewriting its immutable marker', async () => {
  const f = fixture({ provider: { dialOutgoing: async () => { throw uncertain(); } } });
  const requestId = 'duplicate-early-request';
  await assert.rejects(() => f.runtime.outgoing('a', { to: '919999999999', requestId }));
  const id = outgoingSessionId('smart-handicrafts', 'a', requestId);
  const answer = event(f, 'connect', 'duplicate-early-call', { answerSdp: sdp });
  await f.runtime.ingestVerifiedMetaEvent(answer);
  await f.runtime.ingestVerifiedMetaEvent({ ...answer, opaqueSessionId: id });
  const first = await f.runtime.locate(id);
  assert.equal(first.answerSdp, sdp);
  await f.runtime.ingestVerifiedMetaEvent({ ...answer, opaqueSessionId: id });
  assert.equal((await f.runtime.locate(id)).version, first.version);
});

test('a delayed verified incoming offer retains its original bounded ringing lifetime', async () => {
  const f = fixture();
  await f.runtime.ingestVerifiedMetaEvent(event(f, 'incoming', 'late-offer', {
    offerSdp: sdp, occurredAtMs: f.now() - 89000
  }));
  assert.equal((await f.runtime.locate('late-offer')).deadlineAt, f.now() + 1000);
  f.advance(1001);
  await f.runtime.dispatchIncomingAlert('late-offer');
  assert.equal(f.effects.filter(row => row.kind === 'notify' && row.event === 'incoming').length, 0);
});

test('claiming an incoming call durably cancels other-device ringing before provider answer completes', async () => {
  const entered = deferred(), released = deferred();
  let f;
  f = fixture({ provider: { acceptIncoming: async data => {
    entered.resolve(); await released.promise;
    const saved = await f.runtime.locate(data.callId);
    return { callId: data.callId, roomName: data.roomName, customerIdentity: saved.customerIdentity };
  } } });
  await f.incoming();
  const pending = f.accept();
  await entered.promise;
  try {
    const current = await f.runtime.locate('call-in-1');
    assert.ok(current.outbox.some(row => row.kind === 'notify' && row.event === 'ended' && row.status === 'pending'));
  } finally { released.resolve(); }
  await pending;
});

test('failed FCM delivery does not keep a settled pre-media call device busy', async () => {
  const f = fixture({ runtime: { notify: async () => { throw Error('Synthetic FCM outage'); } } });
  await f.incoming();
  const accepted = await f.accept();
  await f.runtime.end('a', accepted.call.sessionId, { version: accepted.call.version, requestId: 'end-before-media' });
  await f.runtime.recoverSession(accepted.call.sessionId, { limit: 8 });
  await f.runtime.recoverSession(accepted.call.sessionId, { limit: 8 });
  const session = await f.runtime.locate(accepted.call.sessionId);
  assert.ok(session.terminal.confirmedAt);
  assert.ok(session.outbox.some(row => row.kind === 'notify' && row.status !== 'done'));
  assert.equal(await f.store.get(deviceReservationKey('a')), undefined);
  const next = await f.runtime.outgoing('a', { to: '919999999999', requestId: 'after-ended-0001' });
  assert.ok(next.join);
});

test('connected customer cleanup starts before a stalled notification delivery', async () => {
  const entered = deferred(), released = deferred();
  const f = fixture({ runtime: { notify: async ({ event: name }) => {
    if (name === 'ended') { entered.resolve(); await released.promise; }
  } } });
  const connected = await f.connected();
  await f.runtime.end('a', connected.call.sessionId, { version: connected.call.version, requestId: 'end-connected-1' });
  const recovering = f.runtime.recoverSession(connected.call.sessionId);
  await entered.promise;
  try { assert.ok(f.effects.some(row => row.kind === 'terminate')); }
  finally { released.resolve(); }
  await recovering;
});

test('an End intent bound to an earlier operator leg cannot terminate the current leg', async () => {
  const f = fixture();
  const connected = await f.connected();
  await assert.rejects(() => f.runtime.end('a', connected.call.sessionId, {
    version: connected.call.version, requestId: 'old-leg-end-001', expectedOwnerLegId: 'leg_previous'
  }), error => error.code === 'CALL_LEG_CHANGED');
  assert.equal((await f.runtime.status('a', connected.call.sessionId)).call.roomReady, true);
});

test('an uncertain outgoing Connect response is not blindly replayed by recovery', async () => {
  let connects = 0;
  const f = fixture({ provider: { connectOutgoing: async () => { connects++; throw uncertain(); } } });
  const started = await f.runtime.outgoing('a', { to: '919999999999', requestId: 'connect-uncertain-1' });
  await f.runtime.ingestVerifiedMetaEvent(event(f, 'connect', started.call.callId, { answerSdp: sdp }));
  await f.runtime.recoverSession(started.call.sessionId);
  f.advance(4000);
  await f.runtime.recoverSession(started.call.sessionId);
  assert.equal(connects, 1);
});

test('End during an in-flight Connect preserves its reservation until exact late-response cleanup settles', async () => {
  const entered = deferred(), released = deferred();
  const f = fixture({ provider: { connectOutgoing: async () => { entered.resolve(); await released.promise; } } });
  const started = await f.runtime.outgoing('a', { to: '919999999999', requestId: 'blocked-connect-end' });
  await f.runtime.ingestVerifiedMetaEvent(event(f, 'connect', started.call.callId, { answerSdp: sdp }));
  const connecting = f.runtime.recoverSession(started.call.sessionId);
  await entered.promise;
  const state = await f.runtime.status('a', started.call.sessionId);
  await f.runtime.end('a', started.call.sessionId, { version: state.call.version, requestId: 'end-blocked-connect' });
  await f.runtime.recoverSession(started.call.sessionId);
  try { assert.ok(await f.store.get(deviceReservationKey('a'))); }
  finally { released.resolve(); }
  await connecting;
  await f.runtime.recoverSession(started.call.sessionId);
  assert.ok(f.effects.filter(row => row.kind === 'terminate').length >= 2);
  assert.ok(f.effects.filter(row => row.kind === 'terminate').every(row => row.callId === started.call.callId));
  assert.equal(await f.store.get(deviceReservationKey('a')), undefined);
});

test('fresh real-leg readiness resolves an uncertain Connect without resending SDP', async () => {
  let connects = 0;
  const f = fixture({ provider: { connectOutgoing: async () => { connects++; throw uncertain(); } } });
  const started = await f.runtime.outgoing('a', { to: '919999999999', requestId: 'connect-readiness-1' });
  await f.runtime.ingestVerifiedMetaEvent(event(f, 'connect', started.call.callId, { answerSdp: sdp }));
  await f.runtime.ingestVerifiedMetaEvent(event(f, 'accepted', started.call.callId));
  await f.runtime.recoverSession(started.call.sessionId);
  const status = await f.runtime.status('a', started.call.sessionId);
  const ready = await f.runtime.ready('a', started.call.sessionId, {
    version: status.call.version, readinessNonce: started.readinessNonce, evidence: { unitTest: true }
  });
  assert.equal(ready.call.roomReady, true);
  await f.runtime.recoverSession(started.call.sessionId);
  assert.equal(connects, 1);
  assert.equal((await f.runtime.locate(started.call.sessionId)).operations.connect.status, 'acknowledged');
});

test('a definite Connect rejection ends and cleans the call without retrying the mutation', async () => {
  let connects = 0;
  const f = fixture({ provider: { connectOutgoing: async () => {
    connects++; throw new MediaError('MEDIA_PROVIDER_ERROR', 'Synthetic definite rejection', 502, { outcomeUnknown: false });
  } } });
  const started = await f.runtime.outgoing('a', { to: '919999999999', requestId: 'connect-rejected-1' });
  await f.runtime.ingestVerifiedMetaEvent(event(f, 'connect', started.call.callId, { answerSdp: sdp }));
  await f.runtime.recoverSession(started.call.sessionId);
  await f.runtime.recoverSession(started.call.sessionId);
  assert.equal(connects, 1);
  assert.ok((await f.runtime.locate(started.call.sessionId)).terminal);
  assert.equal(await f.store.get(deviceReservationKey('a')), undefined);
});

test('enrollment persists native capability metadata before the first background call', async () => {
  const h = registryFixture();
  const enrolled = await h.enroll();
  assert.equal(enrolled.result.status, 200);
  const row = await h.registry.getDevice(enrolled.result.body.deviceId);
  assert.equal(row.nativeBuild, 12);
  assert.equal(row.mediaProtocol, 'sh-room-audio-v1');
  assert.equal(row.deviceLabel, 'Phone 1');
  await h.bridge.publishRoomEvent({ session: { id: 'first-background-call', deadlineAt: 1800000001000 }, event: 'incoming' });
  assert.equal(h.deliveries.length, 1);
  assert.equal(h.deliveries[0].data.expires_at_ms, '1800000001000');
});

test('enrollment retries preserve the credential and cannot use metadata to mutate consumed invitations', async () => {
  const h = registryFixture();
  const enrolled = await h.enroll();
  const replay = await h.request('POST', '/api/operator-android/devices/register', { ...enrolled.body, nativeBuild: 13 });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.deviceToken, enrolled.result.body.deviceToken);
  assert.equal(replay.body.replayed, true);
  assert.equal((await h.registry.getDevice(replay.body.deviceId)).nativeBuild, 12);
});

test('FCM token refresh atomically updates supported client metadata with the same valid enrollment', async () => {
  const h = registryFixture();
  const enrolled = await h.enroll('0000000000000001', {});
  const updated = await h.request('POST', '/api/operator-android/devices/token', {
    fcmToken: `${fakeFcmToken}_new`, nativeBuild: 12, mediaProtocol: 'sh-room-audio-v1'
  }, enrolled.result.body.deviceToken);
  assert.equal(updated.status, 200);
  const row = await h.registry.getDevice(enrolled.result.body.deviceId);
  assert.equal(row.nativeBuild, 12);
  assert.equal(row.fcmToken, `${fakeFcmToken}_new`);
  await h.registry.revoke(enrolled.result.body.deviceToken);
  assert.equal((await h.request('POST', '/api/operator-android/devices/token', {
    fcmToken: fakeFcmToken, nativeBuild: 99, mediaProtocol: 'sh-room-audio-v1'
  }, enrolled.result.body.deviceToken)).status, 401);
});

test('invalid enrollment metadata is rejected before consuming its one-use invitation', async () => {
  const h = registryFixture();
  const enrolled = await h.enroll('0000000000000001', { nativeBuild: '12', mediaProtocol: 'sh-room-audio-v1' });
  assert.equal(enrolled.result.status, 400);
  assert.equal(await h.registry.isEnrollmentAvailable(enrolled.body.enrollmentCode), true);
  const valid = await h.request('POST', '/api/operator-android/devices/register', { ...enrolled.body, nativeBuild: 12 });
  assert.equal(valid.status, 200);
});

test('expired incoming/transfer alert deadlines cannot be extended by a fresh FCM send time', async () => {
  const h = registryFixture();
  const enrolled = await h.enroll();
  await h.bridge.publishRoomEvent({ session: { id: 'already-expired', deadlineAt: 1800000000000 }, event: 'incoming' });
  assert.equal(h.deliveries.length, 0);
  await h.bridge.publishRoomEvent({ session: { id: 'active-call', deadlineAt: 1700000000000 }, event: 'transfer-incoming',
    transferId: 'transfer-fresh', toDeviceId: enrolled.result.body.deviceId, expiresAtMs: 1800000000500 });
  assert.equal(h.deliveries[0].data.expires_at_ms, '1800000000500');
});

test('compatibility history I/O cannot hold customer termination or call recovery open', async () => {
  const f = fixture(), entered = deferred(), released = deferred(), terminated = deferred();
  const original = f.provider.terminateCustomer;
  f.provider.terminateCustomer = async args => { await original(args); terminated.resolve(); };
  const gateway = gatewayFixture(f, { onCallState: async () => { entered.resolve(); await released.promise; } });
  const connected = await f.connected();
  await entered.promise;
  await f.runtime.end('a', connected.call.sessionId, { version: connected.call.version, requestId: 'history-stall-end-1' });
  const reached = await Promise.race([terminated.promise.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 300))]);
  released.resolve();
  assert.equal(reached, true);
  await gateway.close();
});

async function move(f, id, source, target, requestId) {
  const state = await f.runtime.status(source, id);
  const invite = await f.runtime.transfer(source, id, 'invite', { version: state.call.version, toDeviceId: target, requestId });
  const accept = await f.runtime.transfer(target, id, 'accept', { version: invite.call.version, transferId: invite.call.transfer.id });
  await f.runtime.transfer(target, id, 'ready', { version: accept.call.version, transferId: invite.call.transfer.id,
    readinessNonce: accept.readinessNonce, evidence: { unitTest: true } });
  await f.runtime.dispatchCriticalCleanup(id);
  return f.runtime.status(target, id);
}

test('R11 End remains compatible on the original leg but cannot end a transferred-back new leg', async () => {
  const f = fixture();
  const connected = await f.connected();
  const original = connected.call.ownerLegId;
  await move(f, connected.call.sessionId, 'a', 'b', 'move-a-b-0001');
  const returned = await move(f, connected.call.sessionId, 'b', 'a', 'move-b-a-0001');
  assert.notEqual(returned.call.ownerLegId, original);
  await assert.rejects(() => f.runtime.end('a', returned.call.sessionId, { version: returned.call.version,
    requestId: 'legacy-queued-end' }), { code: 'CALL_LEG_REQUIRED' });
  await assert.rejects(() => f.runtime.end('a', returned.call.sessionId, { version: returned.call.version,
    requestId: 'bound-old-end-001', expectedOwnerLegId: original }), { code: 'CALL_LEG_CHANGED' });
  const ended = await f.runtime.end('a', returned.call.sessionId, { version: returned.call.version,
    requestId: 'new-leg-end-0001', expectedOwnerLegId: returned.call.ownerLegId });
  assert.ok(ended.call.terminal);
});

test('R11 End without leg metadata remains valid on a first transferred-to device', async () => {
  const f = fixture();
  const connected = await f.connected();
  const moved = await move(f, connected.call.sessionId, 'a', 'b', 'first-move-a-b');
  const ended = await f.runtime.end('b', moved.call.sessionId, { version: moved.call.version, requestId: 'legacy-new-owner-end' });
  assert.ok(ended.call.terminal);
});

test('an outgoing request cancellation cannot end its original device after transfer back on a new leg', async () => {
  const f = fixture(), requestId = 'outgoing-returned-1';
  const started = await f.runtime.outgoing('a', { to: '919999999999', requestId });
  await f.runtime.ingestVerifiedMetaEvent(event(f, 'accepted', started.call.callId));
  const state = await f.runtime.status('a', started.call.sessionId);
  await f.runtime.ready('a', started.call.sessionId, { version: state.call.version, readinessNonce: started.readinessNonce,
    evidence: { unitTest: true } });
  await move(f, started.call.sessionId, 'a', 'b', 'out-move-a-b-01');
  await move(f, started.call.sessionId, 'b', 'a', 'out-move-b-a-01');
  const cancelled = await f.runtime.cancelOutgoing('a', requestId);
  assert.equal(cancelled.ownershipMoved, true);
  assert.equal(cancelled.call.roomReady, true);
});

test('ending during an unanswered transfer releases the unjoined target without waiting for its expiry', async () => {
  const f = fixture(), connected = await f.connected();
  const invite = await f.runtime.transfer('a', connected.call.sessionId, 'invite', {
    version: connected.call.version, toDeviceId: 'b', requestId: 'unanswered-transfer-1'
  });
  await f.runtime.end('a', connected.call.sessionId, { version: invite.call.version, requestId: 'end-during-invite-1' });
  assert.equal(await f.store.get(deviceReservationKey('b')), undefined);
  assert.equal((await f.store.get(callStoreKey(connected.call.callId))).active, false);
});

test('a new credential generation on the same device cannot transfer the old enrollment media leg', async () => {
  const f = fixture(), connected = await f.connected();
  f.devices.get('a').credentialGeneration++;
  await assert.rejects(() => f.runtime.transfer('a', connected.call.sessionId, 'invite', {
    version: connected.call.version, toDeviceId: 'b', requestId: 'changed-enrollment-transfer'
  }), { code: 'DEVICE_BINDING_CHANGED' });
  assert.equal(await f.store.get(deviceReservationKey('b')), undefined);
});

test('recovery derives a committed return-transfer binding if its redundant session update was lost', async () => {
  const f = fixture(), connected = await f.connected();
  await move(f, connected.call.sessionId, 'a', 'b', 'to-b-before-reenrollment');
  f.devices.get('a').credentialGeneration++;
  const status = await f.runtime.status('b', connected.call.sessionId);
  const invited = await f.runtime.transfer('b', connected.call.sessionId, 'invite', {
    version: status.call.version, toDeviceId: 'a', requestId: 'back-to-new-enrollment'
  });
  const accepted = await f.runtime.transfer('a', connected.call.sessionId, 'accept', {
    version: invited.call.version, transferId: invited.call.transfer.id
  });
  // Simulate the exact process-loss boundary after canonical commit and before
  // CallRuntime.transfer writes its redundant per-device session binding.
  await f.controller.confirmReady('a', { callId: connected.call.callId, transferId: invited.call.transfer.id,
    expectedVersion: accepted.call.version, readinessNonce: accepted.readinessNonce, evidence: { unitTest: true } });
  await f.runtime.recoverSession(connected.call.sessionId);
  const recovered = await f.runtime.status('a', connected.call.sessionId);
  assert.equal(recovered.call.roomReady, true);
  assert.equal(recovered.call.ownerDeviceId, 'a');
  assert.equal(recovered.call.terminal, null);
});

test('a recovery sweep cannot cancel a new transfer between invitation commit and its session binding', async () => {
  const f = fixture(), connected = await f.connected(), entered = deferred(), released = deferred();
  const invite = f.controller.invite.bind(f.controller);
  f.controller.invite = async (...args) => { const result = await invite(...args); entered.resolve(); await released.promise; return result; };
  const pending = f.runtime.transfer('a', connected.call.sessionId, 'invite', {
    version: connected.call.version, toDeviceId: 'b', requestId: 'racing-transfer-binding'
  });
  await entered.promise;
  await f.runtime.recoverSession(connected.call.sessionId);
  released.resolve();
  const result = await pending;
  assert.equal(result.call.transfer.status, 'invited');
  assert.equal(result.call.ownerDeviceId, 'a');
  const accepted = await f.runtime.transfer('b', connected.call.sessionId, 'accept', {
    version: result.call.version, transferId: result.call.transfer.id
  });
  assert.ok(accepted.join);
});

test('two enrolled phones stop ringing at first-answer commit while the provider response is still pending', async () => {
  const entered = deferred(), released = deferred(), cancelled = deferred();
  let f;
  f = fixture({ provider: { acceptIncoming: async args => {
    entered.resolve(); await released.promise;
    const current = await f.runtime.locate(args.callId);
    return { callId: args.callId, roomName: current.roomName, customerIdentity: current.customerIdentity };
  } } });
  const h = registryFixture({ clock: f.now });
  const a = (await h.enroll('0000000000000001')).result.body;
  const b = (await h.enroll('0000000000000002')).result.body;
  for (const device of [a, b]) f.devices.set(device.deviceId, { ...f.devices.get('a'), deviceId: device.deviceId, userId: `native:${device.deviceId}` });
  f.runtime.notify = async payload => {
    await h.bridge.publishRoomEvent({ ...payload, stillCurrent: async () => {
      const current = await f.runtime.locate(payload.session.id);
      return payload.event === 'ended' || !current.terminal && !current.owner;
    } });
    if (payload.event === 'ended') cancelled.resolve();
  };
  f.runtime.onWorkAvailable = id => f.runtime.dispatchRingCancellation(id);
  await f.incoming();
  await f.runtime.dispatchIncomingAlert('call-in-1');
  assert.equal(h.deliveries.filter(row => row.data.event === 'incoming').length, 2);
  const accepted = f.runtime.accept(a.deviceId, 'call-in-1', { requestId: 'two-phone-answer-1' });
  await entered.promise;
  await cancelled.promise;
  try {
    assert.equal(h.deliveries.filter(row => row.data.event === 'ended').length, 2);
    assert.ok(h.deliveries.every(row => row.data.engine === 'livekit' && row.data.call_id === 'call-in-1'));
    assert.equal((await f.runtime.status(a.deviceId, 'call-in-1')).call.phase, 'accepting');
    await assert.rejects(() => f.runtime.accept(b.deviceId, 'call-in-1', { requestId: 'competing-answer-1' }), { code: 'CALL_ANSWERED_ELSEWHERE' });
    await f.runtime.dispatchRingCancellation('call-in-1');
    assert.equal(h.deliveries.filter(row => row.data.event === 'ended').length, 2);
  } finally { released.resolve(); }
  assert.ok((await accepted).join);
});

test('decline and transfer timeout preserve the original operator/customer leg and release only the target', async () => {
  for (const action of ['decline', 'cancel', 'expiry']) {
    const f = fixture(), connected = await f.connected();
    const invited = await f.runtime.transfer('a', connected.call.sessionId, 'invite', {
      version: connected.call.version, toDeviceId: 'b', requestId: `transfer-stop-${action}`
    });
    const accepted = await f.runtime.transfer('b', connected.call.sessionId, 'accept', {
      version: invited.call.version, transferId: invited.call.transfer.id
    });
    if (action === 'expiry') f.advance(61000);
    else await f.runtime.transfer(action === 'cancel' ? 'a' : 'b', connected.call.sessionId, action, {
      version: accepted.call.version, transferId: invited.call.transfer.id
    });
    await f.runtime.recoverSession(connected.call.sessionId);
    const state = await f.runtime.status('a', connected.call.sessionId);
    assert.equal(state.call.ownerDeviceId, 'a'); assert.equal(state.call.roomReady, true);
    assert.equal(await f.store.get(deviceReservationKey('b')), undefined);
    assert.equal(f.effects.filter(row => row.kind === 'terminate').length, 0);
    assert.ok(f.effects.filter(row => row.kind === 'detach').every(row => row.identity === accepted.join.identity));
  }
});

test('operator End wins while initial readiness proof is in flight', async () => {
  const entered = deferred(), released = deferred();
  const f = fixture();
  await f.incoming(); const accepted = await f.accept();
  f.runtime.verifyReadiness = async data => { entered.resolve(); await released.promise; return f.proof(data); };
  const ready = f.ready(accepted).catch(error => error);
  await entered.promise;
  await f.runtime.end('a', accepted.call.sessionId, { version: accepted.call.version, requestId: 'end-before-ready-1',
    expectedOwnerLegId: accepted.join.legId });
  released.resolve();
  assert.ok((await ready) instanceof MediaError);
  assert.equal(await f.store.get(callStoreKey(accepted.call.callId)), undefined);
  await f.runtime.recoverSession(accepted.call.sessionId);
  assert.ok((await f.runtime.status('a', accepted.call.sessionId)).call.terminal);
});

test('failed operator detach still keeps the exact pre-media reservation busy', async () => {
  const f = fixture({ provider: { detachOperator: async () => { throw Error('Synthetic detach outage'); } } });
  await f.incoming(); const accepted = await f.accept();
  await f.runtime.end('a', accepted.call.sessionId, { version: accepted.call.version, requestId: 'detach-failure-end' });
  await f.runtime.recoverSession(accepted.call.sessionId);
  assert.ok(await f.store.get(deviceReservationKey('a')));
  await assert.rejects(() => f.runtime.outgoing('a', { to: '919999999999', requestId: 'blocked-next-dial' }), { code: 'DEVICE_BUSY' });
});

test('verified customer termination settles a queued unanswered Reject without another Graph action', async () => {
  const f = fixture(); await f.incoming();
  const state = await f.runtime.status('a', 'call-in-1');
  await f.runtime.end('a', 'call-in-1', { version: state.call.version, requestId: 'reject-before-end-1', reject: true });
  await f.runtime.ingestVerifiedMetaEvent(event(f, 'terminate', 'call-in-1'));
  await f.runtime.recoverSession('call-in-1');
  assert.equal(f.effects.filter(row => row.kind === 'reject').length, 0);
  assert.ok((await f.runtime.locate('call-in-1')).outbox.filter(row => row.kind === 'reject').every(row => row.status === 'done'));
});

test('bounded native Reject uses one exact Meta request and confirms only explicit success', async () => {
  const requests = [];
  const reject = createBoundedNativeReject({ metaToken: 'synthetic-server-token', apiVersion: '23.0', fetchImpl: async (url, options) => {
    requests.push({ url, options }); return { ok: true, status: 200, json: async () => ({ success: true }) };
  } });
  assert.deepEqual(await reject({ callId: 'call-exact-123', phoneNumberId: '123456' }), { rejected: true, callId: 'call-exact-123' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://graph.facebook.com/v23.0/123456/calls');
  assert.equal(requests[0].options.redirect, 'error');
  assert.deepEqual(JSON.parse(requests[0].options.body), { messaging_product: 'whatsapp', call_id: 'call-exact-123', action: 'reject' });
});

test('bounded native Reject aborts stalled HTTP and never exposes provider bodies or credentials', async () => {
  let aborted = false;
  const reject = createBoundedNativeReject({ metaToken: 'PRIVATE-SYNTHETIC-TOKEN', apiVersion: '23.0', timeoutMs: 10,
    fetchImpl: async (url, { signal }) => new Promise((resolve, fail) => signal.addEventListener('abort', () => {
      aborted = true; fail(Error('PRIVATE-SYNTHETIC-TOKEN raw SDK body'));
    }, { once: true })) });
  await assert.rejects(() => reject({ callId: 'call-timeout', phoneNumberId: '123456' }), error => {
    assert.equal(error.code, 'NATIVE_REJECT_TIMEOUT'); assert.equal(error.outcomeUnknown, true);
    assert.ok(!JSON.stringify(error).includes('PRIVATE')); assert.ok(!String(error).includes('PRIVATE')); return true;
  });
  assert.equal(aborted, true);
  for (const data of [{ success: false }, { error: { message: 'PRIVATE raw response' } }]) {
    const invalid = createBoundedNativeReject({ metaToken: 'synthetic', apiVersion: '23.0',
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => data }) });
    await assert.rejects(() => invalid({ callId: 'call-no-success', phoneNumberId: '123456' }), error =>
      error.code === 'NATIVE_REJECT_UNCONFIRMED' && !String(error).includes('PRIVATE'));
  }
});

test('new calls cannot be enabled by a disabled rollout or unsupported native build', async () => {
  const f = fixture(); await f.incoming();
  f.runtime.capabilityProvider = async () => ({ roomCalling: false, transferEnabled: false });
  await assert.rejects(() => f.accept(), { code: 'ROOM_CALLING_NOT_ENABLED' });
  await assert.rejects(() => f.runtime.outgoing('a', { to: '919999999999', requestId: 'disabled-outgoing-1' }), { code: 'ROOM_CALLING_NOT_ENABLED' });
  assert.equal(f.effects.filter(row => ['accept', 'dial'].includes(row.kind)).length, 0);
  f.runtime.capabilityProvider = async () => ({ roomCalling: true, transferEnabled: true });
  f.devices.get('a').nativeBuild = 9;
  await assert.rejects(() => f.accept(), { code: 'NATIVE_UPDATE_REQUIRED' });
  assert.equal(f.effects.filter(row => ['accept', 'dial'].includes(row.kind)).length, 0);
});

test('an eligibility sweep with an old session snapshot cannot revoke a newly committed owner', async () => {
  const f = fixture(), connected = await f.connected();
  const oldSession = await f.runtime.locate(connected.call.sessionId);
  await move(f, connected.call.sessionId, 'a', 'b', 'owner-changed-during-sweep');
  await f.runtime.reconcileEligibility(oldSession);
  const state = await f.runtime.status('b', connected.call.sessionId);
  assert.equal(state.call.roomReady, true);
  assert.equal(state.call.ownerDeviceId, 'b');
  assert.equal(state.call.terminal, null);
});

test('revoked-owner media cleanup does not wait for a stalled first-answer cancellation notification', async () => {
  const entered = deferred(), released = deferred(), terminated = deferred();
  const f = fixture({ runtime: { notify: async ({ event: name }) => {
    if (name === 'ended') { entered.resolve(); await released.promise; }
  } } });
  const original = f.provider.terminateCustomer;
  f.provider.terminateCustomer = async args => { await original(args); terminated.resolve(); };
  const connected = await f.connected(); f.devices.get('a').revoked = true;
  const recovering = f.runtime.recoverSession(connected.call.sessionId);
  await entered.promise;
  const reached = await Promise.race([terminated.promise.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 300))]);
  released.resolve(); await recovering;
  assert.equal(reached, true);
  assert.ok((await f.runtime.locate(connected.call.sessionId)).terminal);
});

test('a provider ID at the supported220-character limit still fits private route and terminal markers', async () => {
  const f = fixture(), callId = 'c'.repeat(220);
  await f.runtime.ingestVerifiedMetaEvent(event(f, 'incoming', callId, { eventId: 'maximum-id-offer', offerSdp: sdp }));
  assert.equal((await f.runtime.locate(callId)).providerCallId, callId);
  const accepted = await f.runtime.accept('a', callId, { requestId: 'maximum-id-accept' });
  await f.runtime.end('a', callId, { version: accepted.call.version, requestId: 'maximum-id-end' });
  await f.runtime.ingestVerifiedMetaEvent(event(f, 'terminate', callId, { eventId: 'maximum-id-ended' }));
  assert.ok((await f.runtime.status('a', callId)).call.terminal);
});

test('owned calls still joining retain a periodic eligibility deadline instead of waiting for the full join timeout', async () => {
  const f = fixture(); await f.incoming(); const accepted = await f.accept();
  await f.runtime.recoverSession(accepted.call.sessionId);
  const session = await f.runtime.locate(accepted.call.sessionId);
  assert.ok(session.nextActionAtMs <= f.now() + 15000);
  f.advance(15000); f.devices.get('a').revoked = true;
  await f.runtime.recoverSession(accepted.call.sessionId);
  assert.ok((await f.runtime.locate(accepted.call.sessionId)).terminal);
  assert.equal(await f.store.get(deviceReservationKey('a')), undefined);
});
