import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, deferred } from './operator-r12-helpers.mjs';
import { sessionKey } from '../call-runtime/call-runtime.mjs';
import { deviceReservationKey } from '../media/transfer-controller.mjs';

const modern = () => {
  const f = fixture();
  for (const device of f.devices.values()) device.nativeBuild = 23;
  return f;
};
async function within(promise, milliseconds = 300) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error('Action waited for the blocked provider')), milliseconds);
  })]); } finally { clearTimeout(timer); }
}
async function settled(f, id, operation) {
  for (let i = 0; i < 100; i++) {
    const session = await f.runtime.locate(id);
    if (session?.operations[operation]?.status !== 'issued') return session;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('Background provider result was not persisted');
}

for (const direction of ['incoming', 'outgoing']) {
  test(`R23 ${direction} joins while the sole provider operation is still blocked`, async () => {
    const f = modern(), entered = deferred(), release = deferred();
    const operation = direction === 'incoming' ? 'accept' : 'dial';
    const method = direction === 'incoming' ? 'acceptIncoming' : 'dialOutgoing';
    const original = f.provider[method]; let count = 0;
    f.provider[method] = async data => { count++; entered.resolve(); await release.promise; return original(data); };
    if (direction === 'incoming') await f.incoming();
    const start = () => direction === 'incoming' ? f.accept() :
      f.runtime.outgoing('a', { to: '919999999999', requestId: 'r23-parallel-dial' });
    const pending = start(); let joined;
    try {
      await entered.promise;
      joined = await within(pending);
      assert.ok(joined.join.token);
      assert.equal(joined.call.roomReady, false);
      assert.equal(joined.call.phase, direction === 'incoming' ? 'accepting' : 'dialing');
      const duplicate = await within(start());
      assert.equal(duplicate.join.identity, joined.join.identity);
      assert.equal(duplicate.join.legId, joined.join.legId);
      assert.equal(count, 1);
      await assert.rejects(f.runtime.ready('a', joined.call.sessionId, {
        version: joined.call.version, readinessNonce: joined.readinessNonce,
        evidence: { legId: joined.join.legId }
      }), { code: 'READINESS_STALE' });
    } finally { release.resolve(); await pending; }
    const final = await settled(f, joined.call.sessionId, operation);
    assert.equal(final.operations[operation].status, 'acknowledged');
    assert.equal(final.mediaReadyAt, undefined);
  });
}

test('R23 early outgoing join retains late-cancel compensation and never redials', async () => {
  const f = modern(), release = deferred(); let dials = 0;
  const dial = f.provider.dialOutgoing;
  f.provider.dialOutgoing = async data => { dials++; await release.promise; return dial(data); };
  const pending = f.runtime.outgoing('a', { to: '919999999999', requestId: 'r23-cancel-dial' });
  let joined;
  try {
    joined = await within(pending);
    await f.runtime.end('a', joined.call.sessionId, { requestId: 'r23-early-end', expectedOwnerLegId: joined.join.legId });
  } finally { release.resolve(); }
  await settled(f, joined.call.sessionId, 'dial');
  await f.runtime.recoverSession(joined.call.sessionId);
  const status = await f.runtime.status('a', joined.call.sessionId);
  assert.equal(status.call.roomReady, false);
  assert.ok(f.effects.some(event => event.kind === 'terminate' && event.callId === 'call-out-1'));
  assert.equal(dials, 1);
  assert.equal(await f.store.get(deviceReservationKey('a')), undefined);
});

test('R23 early Answer does not return a room token after enrollment is revoked during signing', async () => {
  const f = modern(), entered = deferred(), release = deferred();
  const issue = f.provider.issueOperatorJoin;
  f.provider.issueOperatorJoin = async data => { entered.resolve(); await release.promise; return issue(data); };
  await f.incoming();
  const outcome = f.accept().then(value => ({ value }), error => ({ error }));
  await entered.promise;
  f.devices.get('a').revoked = true;
  release.resolve();
  const result = await outcome;
  assert.equal(result.error?.code, 'DEVICE_BINDING_INVALID');
  assert.equal(result.value, undefined);
  await settled(f, 'call-in-1', 'accept');
});

test('R23 losing phone cannot join the early Answer owned by another device', async () => {
  const f = modern(), release = deferred();
  const accept = f.provider.acceptIncoming;
  f.provider.acceptIncoming = async data => { await release.promise; return accept(data); };
  await f.incoming();
  try {
    const first = await within(f.accept());
    await assert.rejects(f.accept('call-in-1', 'b'), { code: 'CALL_ANSWERED_ELSEWHERE' });
    assert.equal(first.call.ownerDeviceId, 'a');
  } finally { release.resolve(); await settled(f, 'call-in-1', 'accept'); }
});

async function joining(f) {
  await f.incoming();
  const joined = await f.accept();
  await settled(f, joined.call.sessionId, 'accept');
  return joined;
}
const evidenceFor = joined => ({ version: joined.call.version, readinessNonce: joined.readinessNonce,
  evidence: { legId: joined.join.legId } });

test('R23 real exact-leg readiness survives harmless provider version updates before and during verification', async () => {
  const f = modern(), joined = await joining(f);
  const bump = () => f.store.transaction(async tx => {
    const session = await tx.get(sessionKey(joined.call.sessionId));
    session.version++; tx.set(sessionKey(session.id), session);
  });
  await bump();
  const verify = f.runtime.verifyReadiness;
  f.runtime.verifyReadiness = async data => { await bump(); return verify(data); };
  const ready = await f.runtime.ready('a', joined.call.sessionId, evidenceFor(joined));
  assert.equal(ready.call.roomReady, true);
  assert.equal(ready.call.ownerDeviceId, 'a');
});

test('R23 stale readiness cannot bypass a different leg, nonce, future version or terminal state', async () => {
  const f = modern(), joined = await joining(f), id = joined.call.sessionId;
  const base = evidenceFor(joined);
  const latest = await f.runtime.status('a', id);
  for (const [body, code] of [
    [{ ...base, version: latest.call.version - 1, evidence: { legId: 'old-leg' } }, 'STALE_CALL_VERSION'],
    [{ ...base, readinessNonce: 'old-nonce' }, 'READINESS_STALE'],
    [{ ...base, version: latest.call.version + 1 }, 'STALE_CALL_VERSION']
  ]) await assert.rejects(f.runtime.ready('a', id, body), { code });
  const verify = f.runtime.verifyReadiness;
  f.runtime.verifyReadiness = async data => {
    await f.runtime.end('a', id, { expectedOwnerLegId: joined.join.legId, requestId: 'r23-end-during-proof' });
    return verify(data);
  };
  await assert.rejects(f.runtime.ready('a', id, base), { code: 'CALL_CHANGED' });
  assert.equal((await f.runtime.status('a', id)).call.roomReady, false);
});

for (const preMedia of [false, true]) {
  test(`End detaches the operator while customer disconnect is blocked (${preMedia ? 'joining' : 'connected'})`, async () => {
    const f = fixture(), release = deferred(), disconnectEntered = deferred(), detached = deferred();
    let call;
    if (preMedia) { await f.incoming(); call = await f.accept(); } else call = await f.connected();
    f.provider.terminateCustomer = async () => { disconnectEntered.resolve(); await release.promise; };
    const detach = f.provider.detachOperator;
    f.provider.detachOperator = async data => { await detach(data); detached.resolve(); };
    await f.runtime.end('a', call.call.sessionId, { expectedOwnerLegId: call.call.ownerLegId, requestId: 'r23-parallel-cleanup' });
    const cleanup = f.runtime.dispatchCriticalCleanup(call.call.sessionId);
    try {
      await disconnectEntered.promise;
      await within(detached.promise);
    } finally { release.resolve(); await cleanup; }
    assert.equal(f.effects.filter(event => event.kind === 'detach').length, 1);
    assert.equal(await f.store.get(deviceReservationKey('a')), undefined);
  });
}


test('a slow room-control hint cannot block an authenticated transfer or End', async () => {
  const f = fixture(), connected = await f.connected(), release = deferred(), hints = [];
  f.devices.get('a').nativeBuild = 23; f.devices.get('b').nativeBuild = 23;
  f.provider.signalControlState = async hint => { hints.push(hint); await release.promise; };
  try {
    const invite = await within(f.runtime.transfer('a', connected.call.sessionId, 'invite', {
      version: connected.call.version, toDeviceId: 'b', requestId: 'r23-hint-invite' }));
    const accepted = await within(f.runtime.transfer('b', connected.call.sessionId, 'accept', {
      transferId: invite.call.transfer.id, expectedTransferId: invite.call.transfer.id }));
    assert.ok(accepted.join);
    assert.ok(hints.some(hint => hint.identities.includes(accepted.join.identity)));
    await within(f.runtime.end('a', connected.call.sessionId, {
      expectedOwnerLegId: connected.call.ownerLegId, requestId: 'r23-hint-end' }));
  } finally { release.resolve(); }
});

test('room-control hints target only the supplied operator identities and contain no call content', async () => {
  const { LiveKitWhatsAppProvider } = await import('../media/livekit-provider.mjs');
  const calls = [];
  const provider = new LiveKitWhatsAppProvider({ origin: 'https://test.livekit.cloud' },
    { clients: { connector: {}, rooms: { sendData: async (...args) => calls.push(args) } } });
  await provider.signalControlState({ roomName: 'test-room', identities: ['operator-a', 'operator-b', 'operator-a'] });
  await provider.signalControlState({ roomName: 'test-room', identities: [] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].toString(), 'refresh');
  assert.deepEqual(calls[0][3], { destinationIdentities: ['operator-a', 'operator-b'], topic: 'sh-call-control-v1' });
});

const providerEvent = (f, type, callId, suffix = '') => ({ verified: true,
  eventId: `r23-provider-${type}-${suffix || 'first'}`, type, callId,
  phoneNumberId: 'business-1', occurredAtMs: f.now(),
  ...(type === 'connect' ? { answerSdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' } : {}) });

for (const type of ['accepted', 'connect']) {
  test(`trusted outgoing ${type} wakes the joined operator after commit without waiting on delivery`, async () => {
    const f = modern(), release = deferred(), hints = [];
    const joined = await f.runtime.outgoing('a', { to: '919999999999', requestId: `r23-event-${type}` });
    const session = await settled(f, joined.call.sessionId, 'dial');
    f.provider.signalControlState = async hint => { hints.push(hint); await release.promise; };
    const event = providerEvent(f, type, session.providerCallId);
    try {
      const result = await within(f.runtime.ingestVerifiedMetaEvent(event));
      assert.deepEqual(Object.keys(result).sort(), ['handled', 'sessionId', 'terminal']);
      assert.equal(hints.length, 1);
      assert.deepEqual(hints[0], { roomName: session.roomName, identities: [joined.join.identity] });
      const saved = await f.runtime.locate(session.id);
      assert.ok(type === 'accepted' ? saved.customerAcceptedAt : saved.answerSdp);
      assert.equal(saved.mediaReadyAt, undefined, 'a wake is never proof of connected audio');
      await f.runtime.ingestVerifiedMetaEvent(event);
      await f.runtime.ingestVerifiedMetaEvent(providerEvent(f, type, session.providerCallId, 'duplicate-delivery'));
      assert.equal(hints.length, 1, 'duplicate IDs and repeated same-state events must not amplify wakes');
    } finally { release.resolve(); }
  });
}

test('customer Hang-up wakes both exact operator legs during transfer and excludes the customer', async () => {
  const f = modern(), joined = await joining(f);
  const connected = await f.runtime.ready('a', joined.call.sessionId, evidenceFor(joined));
  const invited = await f.runtime.transfer('a', joined.call.sessionId, 'invite', {
    version: connected.call.version, toDeviceId: 'b', requestId: 'r23-remote-end-invite' });
  const target = await f.runtime.transfer('b', joined.call.sessionId, 'accept', {
    transferId: invited.call.transfer.id, expectedTransferId: invited.call.transfer.id });
  const hints = [], release = deferred();
  f.provider.signalControlState = async hint => { hints.push(hint); await release.promise; };
  const event = providerEvent(f, 'terminate', joined.call.providerCallId);
  try {
    await within(f.runtime.ingestVerifiedMetaEvent(event));
    assert.equal(hints.length, 1);
    assert.deepEqual(new Set(hints[0].identities), new Set([joined.join.identity, target.join.identity]));
    assert.ok(!hints[0].identities.includes(joined.join.customerIdentity));
    assert.equal((await f.runtime.status('b', joined.call.sessionId)).call.phase, 'ended');
    await f.runtime.ingestVerifiedMetaEvent(event);
    await f.runtime.ingestVerifiedMetaEvent(providerEvent(f, 'terminate', joined.call.providerCallId, 'again'));
    assert.equal(hints.length, 1);
  } finally { release.resolve(); }
});

test('failed or untrusted provider-event transactions cannot send a room wake', async () => {
  const f = modern(), joined = await joining(f), hints = [];
  f.provider.signalControlState = async hint => { hints.push(hint); };
  const event = providerEvent(f, 'terminate', joined.call.providerCallId);
  await assert.rejects(f.runtime.ingestVerifiedMetaEvent({ ...event, verified: false }), { code: 'UNVERIFIED_WEBHOOK' });
  f.db.failBeforeCommit = Error('synthetic database commit failure');
  await assert.rejects(f.runtime.ingestVerifiedMetaEvent(event), { code: 'MEDIA_STORE_UNAVAILABLE' });
  assert.equal(hints.length, 0);
  assert.equal((await f.runtime.locate(joined.call.sessionId)).terminal, undefined);
  await f.runtime.ingestVerifiedMetaEvent(event);
  assert.equal(hints.length, 1);
});

test('legacy phone webhooks retain their contract without sending unsupported room hints', async () => {
  const f = fixture(), joined = await f.connected(), hints = [];
  f.provider.signalControlState = async hint => { hints.push(hint); };
  await f.runtime.ingestVerifiedMetaEvent(providerEvent(f, 'terminate', joined.call.providerCallId));
  assert.equal(hints.length, 0);
  assert.equal((await f.runtime.status('a', joined.call.sessionId)).call.phase, 'ended');
});

for (const synchronous of [true, false]) {
  test(`a ${synchronous ? 'throwing' : 'rejecting'} room wake cannot fail a committed provider Hang-up`, async () => {
    const f = modern(), joined = await joining(f);
    f.provider.signalControlState = () => {
      if (synchronous) throw Error('synthetic transport unavailable');
      return Promise.reject(Error('synthetic transport unavailable'));
    };
    const result = await f.runtime.ingestVerifiedMetaEvent(providerEvent(f, 'terminate', joined.call.providerCallId));
    assert.equal(result.terminal, true);
    assert.equal((await f.runtime.status('a', joined.call.sessionId)).call.phase, 'ended');
  });
}
