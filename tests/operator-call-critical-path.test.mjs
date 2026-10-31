import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, deferred } from './operator-r12-helpers.mjs';
import { createNativeCallRuntime } from '../call-runtime/startup.mjs';
import { callStoreKey } from '../media/transfer-controller.mjs';
import { LiveKitWhatsAppProvider } from '../media/livekit-provider.mjs';
import { createNativeReadinessVerifier } from '../call-runtime/readiness.mjs';
import { ParticipantInfo_State, TrackType } from 'livekit-server-sdk';

async function pilot(f) {
  let policyChecks = 0;
  const policy = { roomCalling: true, transferEnabled: true, mode: 'pilot', pilotEnabled: true, pilotDeviceIds: ['a', 'b'] };
  const service = createNativeCallRuntime({ store: f.store, provider: f.provider, authenticate: f.actor,
    resolveDevice: async id => structuredClone(f.devices.get(id)), listDevices: async () => [...f.devices.values()],
    capabilities: async () => { policyChecks++; return policy; }, phoneNumberId: 'business-1', now: f.now });
  service.runtime.verifyReadiness = async data => f.proof(data);
  await service.verifyConfiguration();
  return { ...service, policy, checks: () => policyChecks, reset: () => { policyChecks = 0; } };
}
async function invitation(f) {
  const connected = await f.connected();
  const invited = await f.runtime.transfer('a', connected.call.sessionId, 'invite', {
    version: connected.call.version, toDeviceId: 'b', requestId: 'critical-transfer-01'
  });
  return { connected, invited, id: connected.call.sessionId, transferId: invited.call.transfer.id };
}

test('pilot invite evaluates policy once and has only its two authority-changing transactions', async () => {
  const f = fixture(), connected = await f.connected(), service = await pilot(f);
  service.runtime.syncTransferNotifications = async () => { throw Error('normal invite must not reconcile unchanged stopped invitations'); };
  const before = f.db.transactionRuns; service.reset();
  const result = await service.runtime.transfer('a', connected.call.sessionId, 'invite', {
    version: connected.call.version, toDeviceId: 'b', requestId: 'critical-pilot-invite-01'
  });
  assert.equal(result.call.transfer.status, 'invited'); assert.equal(service.checks(), 1);
  assert.equal(f.db.transactionRuns - before, 2, 'claim invitation and bind its exact enrollment; no expire/sync no-op commits');
});

test('pilot accept evaluates policy once and has only its target claim transaction', async () => {
  const f = fixture(), { id, invited, transferId } = await invitation(f), service = await pilot(f);
  service.runtime.syncTransferNotifications = async () => { throw Error('normal accept must not reconcile stopped invitations'); };
  const before = f.db.transactionRuns; service.reset();
  const result = await service.runtime.transfer('b', id, 'accept', { version: invited.call.version, transferId });
  assert.ok(result.join); assert.equal(service.checks(), 1); assert.equal(f.db.transactionRuns - before, 1);
});

test('pilot readiness retains actual proof and ownership commits without unrelated expiry/sync transactions', async () => {
  const f = fixture(), { id, invited, transferId } = await invitation(f), service = await pilot(f);
  const accepted = await service.runtime.transfer('b', id, 'accept', { version: invited.call.version, transferId });
  const before = f.db.transactionRuns; service.reset();
  const result = await service.runtime.transfer('b', id, 'ready', { version: accepted.call.version,
    transferId, readinessNonce: accepted.readinessNonce, evidence: { unitTest: true } });
  assert.equal(result.call.ownerDeviceId, 'b'); assert.equal(service.checks(), 1);
  assert.equal(f.db.transactionRuns - before, 2, 'prove and commit canonical ownership, then persist exact session leg binding');
  assert.equal(f.effects.filter(row => row.kind === 'terminate').length, 0);
});

test('R16 exact invitation accept works without status/version and resumes the same target leg', async () => {
  const f = fixture(); f.devices.get('b').nativeBuild = 16;
  const { id, transferId } = await invitation(f);
  const accepted = await f.runtime.transfer('b', id, 'accept', { transferId, expectedTransferId: transferId });
  const replay = await f.runtime.transfer('b', id, 'accept', { transferId, expectedTransferId: transferId });
  assert.equal(accepted.call.transfer.status, 'connecting'); assert.equal(replay.join.identity, accepted.join.identity);
  assert.equal(replay.join.legId, accepted.join.legId);
  assert.equal(f.effects.filter(row => row.kind === 'accept').length, 1, 'a transfer never accepts the customer again');
});

test('version-free transfer accept requires explicit exact invitation and a supported native build', async () => {
  const f = fixture(), { id, transferId } = await invitation(f);
  await assert.rejects(f.runtime.transfer('b', id, 'accept', { transferId, expectedTransferId: transferId }), { code: 'STALE_CALL_VERSION' });
  f.devices.get('b').nativeBuild = 16;
  await assert.rejects(f.runtime.transfer('b', id, 'accept', { transferId }), { code: 'STALE_CALL_VERSION' });
  await assert.rejects(f.runtime.transfer('b', id, 'accept', { transferId, expectedTransferId: 'another-invitation' }), { code: 'TRANSFER_CHANGED' });
  await assert.rejects(f.runtime.transfer('c', id, 'accept', { transferId, expectedTransferId: transferId }), { code: 'DEVICE_BINDING_CHANGED' });
  assert.equal((await f.runtime.status('a', id)).call.transfer.status, 'invited');
});

test('expired exact invitation is not made joinable by the expiry fast path', async () => {
  const f = fixture(); f.devices.get('b').nativeBuild = 16;
  const { id, transferId } = await invitation(f); f.advance(60001);
  await assert.rejects(f.runtime.transfer('b', id, 'accept', { transferId, expectedTransferId: transferId }), { code: 'TRANSFER_EXPIRED' });
  assert.equal((await f.runtime.status('a', id)).call.transfer.status, 'expired');
});

test('an invitation becoming expired after preflight still fails the authoritative accept transaction', async () => {
  const f = fixture(); f.devices.get('b').nativeBuild = 16;
  const { id, transferId } = await invitation(f), prior = f.controller.expire.bind(f.controller);
  f.controller.expire = async (...args) => { const result = await prior(...args); f.advance(60001); return result; };
  await assert.rejects(f.runtime.transfer('b', id, 'accept', { transferId, expectedTransferId: transferId }), { code: 'TRANSFER_EXPIRED' });
  const current = await f.runtime.status('a', id); assert.equal(current.call.ownerDeviceId, 'a');
});

test('End while the final transfer join auth recheck is pending prevents join publication', async () => {
  const f = fixture(); f.devices.get('b').nativeBuild = 16;
  const { id, transferId, connected } = await invitation(f), entered = deferred(), release = deferred();
  const recheck = f.runtime.recheck.bind(f.runtime);
  f.runtime.recheck = async (context, actor) => { if (context === 'b') { entered.resolve(); await release.promise; } return recheck(context, actor); };
  const accepting = f.runtime.transfer('b', id, 'accept', { transferId, expectedTransferId: transferId });
  await entered.promise;
  await f.runtime.end('a', id, { expectedOwnerLegId: connected.call.ownerLegId, requestId: 'critical-end-while-auth' });
  release.resolve(); await assert.rejects(accepting, { code: 'TRANSFER_CHANGED' });
});

test('revocation while a transfer target join is being issued prevents token publication', async () => {
  const f = fixture(); f.devices.get('b').nativeBuild = 16;
  const { id, transferId } = await invitation(f), service = await pilot(f), issued = deferred(), release = deferred();
  const original = f.provider.issueOperatorJoin;
  f.provider.issueOperatorJoin = async (...args) => { const join = await original(...args); issued.resolve(); await release.promise; return join; };
  const accepting = service.runtime.transfer('b', id, 'accept', { transferId, expectedTransferId: transferId });
  await issued.promise; f.devices.get('b').revoked = true; release.resolve();
  await assert.rejects(accepting, { code: 'DEVICE_BINDING_INVALID' });
});

test('clock changes after a no-op expiry snapshot cannot authorize stale transfer readiness', async () => {
  const f = fixture(), { id, invited, transferId } = await invitation(f);
  const accepted = await f.runtime.transfer('b', id, 'accept', { transferId, version: invited.call.version });
  const observed = await f.store.get(callStoreKey(accepted.call.providerCallId)), before = f.db.transactionRuns;
  assert.equal(await f.controller.expire(accepted.call.providerCallId, observed), false);
  assert.equal(f.db.transactionRuns, before);
  f.advance(60001);
  await assert.rejects(f.runtime.transfer('b', id, 'ready', { transferId, version: accepted.call.version,
    readinessNonce: accepted.readinessNonce, evidence: { unitTest: true } }), { code: 'STALE_CALL_VERSION' });
  assert.equal((await f.runtime.status('a', id)).call.transfer.status, 'expired');
  assert.equal((await f.runtime.status('a', id)).call.ownerDeviceId, 'a');
});

test('runtime stage timing contains fixed labels and durations, never auth or call payloads', async () => {
  const spans = [], f = fixture({ runtime: { onRuntimeTiming: span => spans.push(span) } });
  const { id, invited, transferId } = await invitation(f);
  await f.runtime.transfer('b', id, 'accept', { transferId, version: invited.call.version });
  assert.ok(spans.some(row => row.stage === 'authenticate'));
  assert.ok(spans.some(row => row.stage === 'transfer-accept-controller'));
  for (const row of spans) {
    assert.deepEqual(Object.keys(row).sort(), ['elapsedMs', 'ok', 'stage']);
    assert.ok(/^[a-z-]+$/.test(row.stage)); assert.ok(Number.isFinite(row.elapsedMs));
  }
  const logged = JSON.stringify(spans); assert.ok(!logged.includes(id)); assert.ok(!logged.includes(transferId));
  f.runtime.onRuntimeTiming = () => { throw Error('broken telemetry'); };
  assert.equal((await f.runtime.status('a', id)).call.transfer.status, 'connecting');
});

function participantFixture() {
  let time = 1800000000000, calls = 0;
  const rows = [
    { identity: 'target-1', sid: 'PA_target', state: ParticipantInfo_State.ACTIVE, tracks: [{ sid: 'TR_operator', type: TrackType.AUDIO, muted: false }] },
    { identity: 'customer-1', sid: 'PA_customer', state: ParticipantInfo_State.ACTIVE, tracks: [{ sid: 'TR_customer', type: TrackType.AUDIO, muted: false }] },
    { identity: 'source-1', sid: 'PA_source', state: ParticipantInfo_State.ACTIVE, tracks: [{ sid: 'TR_source', type: TrackType.AUDIO, muted: false }] }
  ];
  const config = { fingerprint: 'synthetic-test-project' };
  const rooms = { listParticipants: async () => { calls++; return structuredClone(rows); } };
  const provider = new LiveKitWhatsAppProvider(config, { clients: { connector: {}, rooms }, now: () => time });
  const call = { id: 'call-1', roomName: 'room-1', customerIdentity: 'customer-1', owner: {} };
  const transfer = { id: 'tr_1', attemptId: 'leg_1', targetIdentity: 'target-1', toDeviceId: 'b', sourceIdentity: 'source-1', readinessNonce: 'nonce-1' };
  const evidence = { protocol: 'sh-room-audio-v1', legId: 'leg_1', identity: 'target-1', roomName: 'room-1', customerIdentity: 'customer-1',
    participantSid: 'PA_target', localAudioTrackSid: 'TR_operator', customerAudioTrackSid: 'TR_customer', sampleDurationMs: 500,
    sampleAgeMs: 0, iceState: 'succeeded', dtlsState: 'connected',
    inbound: { packetsDelta: 1, bytesDelta: 1, decodedFramesDelta: 1 }, outbound: { packetsDelta: 1, bytesDelta: 1 } };
  const args = { actor: { deviceId: 'b' }, call, transfer, evidence };
  const observe = () => provider.inspectParticipants({ roomName: call.roomName, customerIdentity: call.customerIdentity,
    operatorIdentity: transfer.targetIdentity, sourceIdentity: transfer.sourceIdentity });
  return { provider, rows, args, observe, calls: () => calls, advance: ms => { time += ms; },
    verify: createNativeReadinessVerifier({ provider, now: () => time }) };
}

test('one trusted provider snapshot verifies exact transfer tracks and native RTP without a second ListParticipants RPC', async () => {
  const f = participantFixture(), observation = await f.observe();
  const proof = await f.verify({ ...f.args, providerObservation: observation });
  assert.equal(proof.verified, true); assert.equal(proof.bidirectionalAudio, true); assert.equal(f.calls(), 1);
  await f.verify({ ...f.args, providerObservation: observation });
  assert.equal(f.calls(), 2, 'the server snapshot is consumed once, not cached across readiness requests');
});

test('serialized or client-invented participant booleans cannot substitute for an official room observation', async () => {
  const f = participantFixture(), observation = await f.observe();
  await f.verify({ ...f.args, providerObservation: structuredClone(observation) });
  assert.equal(f.calls(), 2, 'a lookalike object cannot mint the private provider snapshot identity');
});

test('expired and wrong-room snapshots force a fresh provider query', async () => {
  const f = participantFixture(), observation = await f.observe(); f.advance(5001);
  await f.verify({ ...f.args, providerObservation: observation }); assert.equal(f.calls(), 2);
  const other = await f.provider.inspectParticipants({ roomName: 'different-room', customerIdentity: 'customer-1', operatorIdentity: 'target-1', sourceIdentity: 'source-1' });
  await f.verify({ ...f.args, providerObservation: other }); assert.equal(f.calls(), 4);
});

test('a snapshot from another provider instance is not reusable', async () => {
  const first = participantFixture(), second = participantFixture(), observation = await first.observe();
  await second.verify({ ...second.args, providerObservation: observation });
  assert.equal(second.calls(), 1);
});

test('same-flow snapshot reuse still rejects wrong track SID or missing source media', async () => {
  const f = participantFixture(), observation = await f.observe();
  await assert.rejects(f.verify({ ...f.args, evidence: { ...f.args.evidence, customerAudioTrackSid: 'TR_wrong' }, providerObservation: observation }), { code: 'MEDIA_NOT_READY' });
  assert.equal(f.calls(), 1);
  f.rows.pop(); const missingSource = await f.observe();
  await assert.rejects(f.verify({ ...f.args, providerObservation: missingSource }), { code: 'SOURCE_MEDIA_MISSING' });
  assert.equal(f.calls(), 2);
});

test('End responds from its own authoritative commit and does not wait for response projection reads', async () => {
  const f = fixture(), connected = await f.connected(), originalStore = f.runtime.store;
  let signalled = false;
  f.runtime.onWorkAvailable = () => { signalled = true; };
  f.runtime.store = { ...originalStore, get: async key => { if (signalled) throw Error('post-commit view fetch must not delay End'); return originalStore.get(key); } };
  const result = await f.runtime.end('a', connected.call.sessionId, { expectedOwnerLegId: connected.call.ownerLegId, requestId: 'critical-end-snapshot' });
  assert.equal(signalled, true); assert.equal(result.call.phase, 'ending'); assert.ok(result.call.terminal);
  f.runtime.store = originalStore;
  assert.equal((await f.runtime.status('a', connected.call.sessionId)).call.phase, 'ending');
});
