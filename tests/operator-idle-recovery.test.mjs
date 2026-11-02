import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, deferred } from './operator-r12-helpers.mjs';
import { outgoingSessionId } from '../call-runtime/call-runtime.mjs';
import { deviceReservationKey } from '../media/transfer-controller.mjs';
import { recoverMediaWork } from '../media-store/firestore-media-store.mjs';
import { MediaError } from '../media/errors.mjs';

async function unknownDial(requestId) {
  const f = fixture({ provider: { dialOutgoing: async () => {
    throw new MediaError('MEDIA_REQUEST_UNCERTAIN', 'Synthetic lost response', 502, { outcomeUnknown: true });
  } } });
  await assert.rejects(f.runtime.outgoing('a', { to: '919999999999', requestId }));
  const id = outgoingSessionId('smart-handicrafts', 'a', requestId);
  f.advance(121000); await f.runtime.recoverSession(id, { limit: 8 });
  return { f, id };
}

test('an expired unknown Dial with no provider ID remains fenced without writing every recovery tick for a day', async t => {
  let dials = 0;
  const f = fixture({ provider: { dialOutgoing: async () => {
    dials++; throw new MediaError('MEDIA_REQUEST_UNCERTAIN', 'Synthetic lost response', 502, { outcomeUnknown: true });
  } } });
  const requestId = 'park-unknown-dial';
  await assert.rejects(f.runtime.outgoing('a', { to: '919999999999', requestId }));
  const id = outgoingSessionId('smart-handicrafts', 'a', requestId);
  f.advance(121000);
  await f.runtime.recoverSession(id, { limit: 8 });
  const before = f.db.version, effects = f.effects.length;
  for (let tick = 0; tick < 86400000 / 15000; tick++) {
    f.advance(15000);
    await recoverMediaWork({ store: f.store, controller: f.controller, workerId: 'idle-day-test',
      recoverSession: selected => f.runtime.recoverSession(selected, { limit: 8 }) });
  }
  const current = await f.runtime.locate(id);
  t.diagnostic(JSON.stringify({ simulatedHours: 24, documentWrites: f.db.version - before, dials }));
  assert.ok(current.terminal);
  assert.equal(current.operations.dial.status, 'uncertain');
  assert.equal(current.nextActionAtMs, null, 'There is no provider ID to poll or terminate; the exact webhook/response is the only possible next input');
  assert.equal(f.db.version - before, 0, 'A full day of idle recovery must make zero document writes');
  assert.equal(f.effects.length, effects); assert.equal(dials, 1, 'Unknown Dial cannot be blindly retried');
  assert.equal((await f.store.get(deviceReservationKey('a'))).sessionId, id, 'Do not release ownership on an uncertain provider outcome');
});

for (const type of ['connect', 'accepted']) test(`a late exact ${type} wakes a parked unknown Dial and disconnects only its newly identified customer`, async () => {
  const { f, id } = await unknownDial('park-late-' + type);
  await f.runtime.ingestVerifiedMetaEvent({ verified: true, type, eventId: 'late-' + type,
    callId: 'late-known-customer', opaqueSessionId: id, phoneNumberId: 'business-1', occurredAtMs: f.now(),
    ...(type === 'connect' ? { answerSdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' } : {}) });
  await f.runtime.recoverSession(id, { limit: 8 });
  const current = await f.runtime.locate(id);
  assert.ok(current.terminal); assert.equal(current.phase, 'ended');
  assert.ok(f.effects.some(row => row.kind === 'terminate' && row.callId === 'late-known-customer'));
  assert.equal(f.effects.filter(row => row.kind === 'connect').length, 0, 'A late answer cannot reopen terminal audio');
  assert.equal(await f.store.get(deviceReservationKey('a')), undefined, 'Release only after that exact customer cleanup acknowledges');
  assert.equal(current.nextActionAtMs, null);
});

test('a redundant recovery wake does not rewrite a completed session', async () => {
  const f = fixture(); await f.incoming(); const accepted = await f.accept();
  await f.runtime.end('a', accepted.call.sessionId, { version: accepted.call.version, requestId: 'settled-noop-end' });
  await f.runtime.recoverSession(accepted.call.sessionId, { limit: 8 });
  await f.runtime.recoverSession(accepted.call.sessionId, { limit: 8 });
  const before = f.db.version;
  f.advance(15000); await f.runtime.recoverSession(accepted.call.sessionId, { limit: 8 });
  assert.equal(f.db.version, before, 'Unchanged completion cannot consume another document write');
});

test('a stale ended-alert delivery cannot keep a fully disconnected call writing recovery forever', async () => {
  const f = fixture({ runtime: { notify: async () => { throw Error('Synthetic FCM outage'); } } });
  await f.incoming(); const accepted = await f.accept();
  await f.runtime.end('a', accepted.call.sessionId, { version: accepted.call.version, requestId: 'expire-stale-alert' });
  await f.runtime.recoverSession(accepted.call.sessionId, { limit: 8 });
  let current = await f.runtime.locate(accepted.call.sessionId);
  assert.ok(current.outbox.some(item => item.kind === 'notify' && item.status !== 'done'));
  f.advance(61000); await f.runtime.recoverSession(accepted.call.sessionId, { limit: 8 });
  current = await f.runtime.locate(accepted.call.sessionId);
  assert.ok(current.terminal.confirmedAt, 'Notification expiry cannot stand in for customer disconnection');
  assert.ok(current.outbox.filter(item => item.kind === 'notify').every(item => item.status === 'done'));
  assert.equal(current.nextActionAtMs, null);
  assert.equal(await f.store.get(deviceReservationKey('a')), undefined);
});

test('parking an expired in-flight Dial preserves late HTTP-response compensation', async () => {
  const entered = deferred(), release = deferred(); let f;
  f = fixture({ provider: { dialOutgoing: async data => {
    entered.resolve(); await release.promise;
    const saved = await f.runtime.locate(data.requestId);
    return { callId: 'late-http-customer', roomName: data.roomName, customerIdentity: saved.customerIdentity };
  } } });
  const requestId = 'park-late-http-dial', id = outgoingSessionId('smart-handicrafts', 'a', requestId);
  const dialing = f.runtime.outgoing('a', { to: '919999999999', requestId });
  await entered.promise;
  await f.runtime.cancelOutgoing('a', requestId);
  f.advance(46000); await f.runtime.recoverSession(id, { limit: 8 });
  assert.equal((await f.runtime.locate(id)).nextActionAtMs, null);
  assert.ok(await f.store.get(deviceReservationKey('a')));
  release.resolve(); await dialing;
  await f.runtime.recoverSession(id, { limit: 8 });
  assert.ok(f.effects.some(row => row.kind === 'terminate' && row.callId === 'late-http-customer'));
  assert.equal(await f.store.get(deviceReservationKey('a')), undefined);
});

test('the first notification delivery deadline cannot be extended by delayed state writes', async () => {
  const f = fixture(); await f.incoming(); const accepted = await f.accept();
  await f.runtime.dispatchRingCancellation(accepted.call.sessionId);
  const { sessionKey } = await import('../call-runtime/call-runtime.mjs');
  await assert.rejects(f.store.transaction(async tx => {
    const session = await tx.get(sessionKey(accepted.call.sessionId));
    const alert = session.outbox.find(item => item.notificationExpiresAtMs !== undefined);
    assert.ok(alert); alert.notificationExpiresAtMs += 60000;
    tx.set(sessionKey(accepted.call.sessionId), session);
  }), { code: 'CLEANUP_TARGET_IMMUTABLE' });
});

test('a timed-out uncertain incoming Accept settles only after exact customer disconnect and detach acknowledge', async () => {
  let f;
  f = fixture({ provider: {
    acceptIncoming: async () => { throw new MediaError('MEDIA_REQUEST_UNCERTAIN', 'Synthetic lost Accept response', 502, { outcomeUnknown: true }); },
    inspectParticipants: async () => ({ observedAt: f.now(), customerActive: false })
  } });
  await f.incoming(); await assert.rejects(f.accept());
  f.advance(121000); await f.runtime.recoverSession('call-in-1', { limit: 8 });
  await f.runtime.recoverSession('call-in-1', { limit: 8 });
  const current = await f.runtime.locate('call-in-1');
  assert.ok(f.effects.some(row => row.kind === 'terminate' && row.callId === 'call-in-1'));
  assert.equal(current.operations.accept.status, 'provider-ended');
  assert.ok(current.terminal.confirmedAt); assert.equal(current.nextActionAtMs, null);
  assert.equal(await f.store.get(deviceReservationKey('a')), undefined);
});

test('a late Accept HTTP acknowledgement still gets its own cleanup after expired-operation recovery', async () => {
  const entered = deferred(), release = deferred(); let f;
  f = fixture({ provider: { acceptIncoming: async data => {
    entered.resolve(); await release.promise;
    const saved = await f.runtime.locate(data.callId);
    return { callId: data.callId, roomName: data.roomName, customerIdentity: saved.customerIdentity };
  } } });
  await f.incoming(); const accepting = f.accept().catch(error => error);
  await entered.promise;
  const status = await f.runtime.status('a', 'call-in-1');
  await f.runtime.end('a', 'call-in-1', { version: status.call.version, requestId: 'end-long-accept' });
  f.advance(46000); await f.runtime.recoverSession('call-in-1', { limit: 8 });
  const before = f.effects.filter(row => row.kind === 'terminate').length;
  release.resolve(); await accepting;
  await f.runtime.recoverSession('call-in-1', { limit: 8 });
  assert.ok(f.effects.filter(row => row.kind === 'terminate').length > before,
    'Expiry cleanup cannot consume the separate delayed HTTP-result compensation key');
  assert.ok(f.effects.filter(row => row.kind === 'terminate').every(row => row.callId === 'call-in-1'));
});
