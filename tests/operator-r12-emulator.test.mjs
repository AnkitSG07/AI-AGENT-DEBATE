// Explicit local-only gate. Never point this suite at a real Firebase project.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { fixture, deferred, registryFixture } from './operator-r12-helpers.mjs';
import { createFirestoreMediaStore, eventStoreKey } from '../media-store/firestore-media-store.mjs';
import { MediaError } from '../media/errors.mjs';
import { outgoingSessionId } from '../call-runtime/call-runtime.mjs';
import { deviceReservationKey } from '../media/transfer-controller.mjs';

if (process.env.SH_R12_EMULATOR_TESTS !== '1' || process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8089')
  throw Error('This suite requires explicit localhost8089 emulator opt-in; production use is forbidden.');
const db = new Firestore({ projectId: 'demo-sh-operator-r12' });
after(async () => db.terminate());
const sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const make = (options = {}) => {
  let f;
  const store = createFirestoreMediaStore({ firestore: db, collectionPrefix: `r12_${randomUUID().replaceAll('-', '')}`,
    clock: () => f?.now() || 1800000000000 });
  f = fixture({ ...options, store, db }); return f;
};
const event = (f, type, callId, extra = {}) => ({ verified: true, type, callId, eventId: `${type}-${callId}`,
  phoneNumberId: 'business-1', occurredAtMs: f.now(), ...extra });

test('official Firestore transactions arbitrate competing answers and preserve the winning media leg', async () => {
  const f = make(); await f.incoming();
  const results = await Promise.allSettled([f.accept('call-in-1', 'a'), f.accept('call-in-1', 'b')]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(f.effects.filter(row => row.kind === 'accept').length, 1);
  const accepted = results.find(row => row.status === 'fulfilled').value;
  const owner = accepted.call.ownerDeviceId;
  const connected = await f.ready(accepted, owner);
  assert.equal(connected.call.roomReady, true);
  const other = owner === 'a' ? 'b' : 'a';
  await assert.rejects(() => f.runtime.end(other, connected.call.sessionId,
    { version: connected.call.version, requestId: 'emulator-wrong-owner' }), { code: 'NOT_CALL_OWNER' });
  await f.runtime.end(owner, connected.call.sessionId, { version: connected.call.version,
    requestId: 'emulator-owner-end', expectedOwnerLegId: connected.call.ownerLegId });
  await f.runtime.recoverSession(connected.call.sessionId);
  assert.equal(await f.store.get(deviceReservationKey(owner)), undefined);
});

test('official Firestore persists a large early answer across lost dial ACK and later correlation', async () => {
  const f = make({ provider: { dialOutgoing: async () => { throw new MediaError('MEDIA_REQUEST_UNCERTAIN', 'Synthetic response loss', 502,
    { outcomeUnknown: true }); } } });
  const requestId = 'emulator-lost-dial-1', id = outgoingSessionId('smart-handicrafts', 'a', requestId);
  await assert.rejects(() => f.runtime.outgoing('a', { to: '919999999999', requestId }));
  const answerSdp = sdp + `a=x-offline:${'x'.repeat(50000)}\r\n`;
  await f.runtime.ingestVerifiedMetaEvent(event(f, 'connect', 'emulator-early', { answerSdp }));
  await f.runtime.ingestVerifiedMetaEvent(event(f, 'accepted', 'emulator-early', { opaqueSessionId: id }));
  const resumed = await f.runtime.accept('a', id, { requestId });
  assert.ok(resumed.join);
  await f.runtime.recoverSession(id);
  await f.runtime.recoverSession(id);
  assert.equal((await f.runtime.locate(id)).answerSdp, answerSdp);
  assert.equal(f.effects.filter(row => row.kind === 'connect').length, 1);
});

test('official Firestore cleanup releases a settled pre-media reservation despite FCM outage', async () => {
  const f = make({ runtime: { notify: async () => { throw Error('Synthetic notification outage'); } } });
  await f.incoming(); const accepted = await f.accept();
  await f.runtime.end('a', accepted.call.sessionId, { version: accepted.call.version,
    requestId: 'emulator-pre-media-end', expectedOwnerLegId: accepted.join.legId });
  await f.runtime.recoverSession(accepted.call.sessionId);
  assert.equal(await f.store.get(deviceReservationKey('a')), undefined);
  assert.ok((await f.runtime.locate(accepted.call.sessionId)).outbox.some(row => row.kind === 'notify' && row.status !== 'done'));
  const next = await f.runtime.outgoing('a', { to: '919999999999', requestId: 'emulator-next-call' });
  assert.ok(next.join);
});

test('official Firestore End during blocked Connect retains exact reservation until compensation', async () => {
  const entered = deferred(), released = deferred();
  const f = make({ provider: { connectOutgoing: async () => { entered.resolve(); await released.promise; } } });
  const started = await f.runtime.outgoing('a', { to: '919999999999', requestId: 'emulator-blocked-connect' });
  await f.runtime.ingestVerifiedMetaEvent(event(f, 'connect', started.call.callId, { answerSdp: sdp }));
  const connecting = f.runtime.recoverSession(started.call.sessionId);
  await entered.promise;
  const state = await f.runtime.status('a', started.call.sessionId);
  await f.runtime.end('a', started.call.sessionId, { version: state.call.version, requestId: 'emulator-racing-end' });
  await f.runtime.recoverSession(started.call.sessionId);
  assert.ok(await f.store.get(deviceReservationKey('a')));
  released.resolve(); await connecting; await f.runtime.recoverSession(started.call.sessionId);
  assert.equal(await f.store.get(deviceReservationKey('a')), undefined);
  assert.ok(f.effects.filter(row => row.kind === 'terminate').length >= 2);
});

test('official Firestore enrollment metadata is committed before the first native alert', async () => {
  const h = registryFixture({ db });
  const enrolled = await h.enroll(randomUUID().replaceAll('-', ''));
  assert.equal(enrolled.result.status, 200);
  const row = await h.registry.getDevice(enrolled.result.body.deviceId);
  assert.equal(row.nativeBuild, 12); assert.equal(row.mediaProtocol, 'sh-room-audio-v1');
  const replay = await h.request('POST', '/api/operator-android/devices/register', enrolled.body);
  assert.equal(replay.body.deviceToken, enrolled.result.body.deviceToken);
  await h.bridge.publishRoomEvent({ session: { id: `emulator-alert-${randomUUID()}`, deadlineAt: 1800000001000 }, event: 'incoming' });
  assert.ok(h.deliveries.some(item => item.device.id === enrolled.result.body.deviceId && item.data.engine === 'livekit'));
});

test('official Firestore batch read-only authentication observes revocation without cached authority', async () => {
  const h = registryFixture({ db });
  const enrolled = await h.enroll(randomUUID().replaceAll('-', ''));
  assert.equal(enrolled.result.status, 200);
  const { deviceId, deviceToken } = enrolled.result.body;
  assert.equal((await h.registry.authenticate(deviceToken)).id, deviceId);
  await h.registry.revokeDevice(deviceId);
  await assert.rejects(() => h.registry.authenticate(deviceToken), { status: 401 });
});

test('official Firestore explicit media read batch uses one SDK getAll and preserves absent-only atomicity', async () => {
  let calls = 0, recordReads = 0;
  const instrumented = {
    collection: (...args) => db.collection(...args),
    runTransaction: callback => db.runTransaction(native => callback(new Proxy(native, {
      get(target, field) {
        if (field === 'getAll') return (...refs) => { calls++; recordReads += refs.length; return target.getAll(...refs); };
        const value = Reflect.get(target, field); return typeof value === 'function' ? value.bind(target) : value;
      }
    })))
  };
  const store = createFirestoreMediaStore({ firestore: instrumented, collectionPrefix: `r17_${randomUUID().replaceAll('-', '')}` });
  const a = eventStoreKey('batch-a'), b = eventStoreKey('batch-b');
  await store.transaction(async tx => { tx.create(a, { id: 'batch-a' }); tx.create(b, { id: 'batch-b' }); });
  calls = 0; recordReads = 0;
  await store.transaction(async tx => {
    const rows = await tx.getAll([a, b, a]);
    assert.deepEqual(rows, [{ id: 'batch-a' }, { id: 'batch-b' }, { id: 'batch-a' }]);
    assert.deepEqual(await tx.get(a), { id: 'batch-a' });
  });
  assert.equal(calls, 1); assert.equal(recordReads, 2);
  await assert.rejects(() => store.transaction(async tx => { tx.create(a, { id: 'batch-a', replaced: true }); }), { code: 'RECORD_ALREADY_EXISTS' });
});

test('official Firestore app-only unread persists IDs and rejects stale read after manual unread', async () => {
  const h = registryFixture({ db }), enrolled = await h.enroll(randomUUID().replaceAll('-', ''));
  const channelId = Number.parseInt(randomUUID().slice(0, 7), 16) + 1000;
  const token = enrolled.result.body.deviceToken;
  await h.registry.observeAppMessages({ channelId, messageIds: [10, 11] });
  const first = (await h.registry.listAppMessageState([channelId]))[0];
  assert.equal(first.unreadCount, 2); assert.equal(first.stateVersion, 1);
  const manual = await h.registry.changeAppMessageState(token, { channelId, unread: true, expectedStateVersion: first.stateVersion });
  await assert.rejects(() => h.registry.changeAppMessageState(token, { channelId, throughMessageId: 11, expectedStateVersion: first.stateVersion }), { status: 409 });
  await h.registry.observeAppMessages({ channelId, messageIds: [12] });
  const current = (await h.registry.listAppMessageState([channelId]))[0];
  assert.ok(current.stateVersion > manual.stateVersion);
  const viewed = await h.registry.changeAppMessageState(token, { channelId, throughMessageId: 11, expectedStateVersion: current.stateVersion });
  assert.equal(viewed.unreadCount, 1); assert.equal(viewed.readThroughMessageId, 11);
});
