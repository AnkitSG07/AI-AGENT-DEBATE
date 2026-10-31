import test from 'node:test';
import assert from 'node:assert/strict';
import { ParticipantInfo_State, TrackType } from 'livekit-server-sdk';
import { createNativeReadinessVerifier } from '../../call-runtime/readiness.mjs';
import { fixture as runtimeFixture } from '../operator-r12-helpers.mjs';

function fixture() {
  const data = {
    actor: { deviceId: 'operator-a' },
    call: { id: 'call-a', roomName: 'room-a', customerIdentity: 'customer-a', readinessNonce: 'nonce-a',
      owner: { legId: 'leg-a', identity: 'native-a', deviceId: 'operator-a' } },
    evidence: { protocol: 'sh-room-audio-v1', legId: 'leg-a', identity: 'native-a', roomName: 'room-a',
      customerIdentity: 'customer-a', participantSid: 'PA_A', localAudioTrackSid: 'TR_A', customerAudioTrackSid: 'TR_C',
      sampleDurationMs: 1000, sampleAgeMs: 30, iceState: 'succeeded', dtlsState: 'connected',
      outbound: { packetsDelta: 30, bytesDelta: 2100 },
      inbound: { packetsDelta: 0, bytesDelta: 0, decodedFramesDelta: 0 },
      readinessMode: 'customer-muted-transport', customerMuted: true, customerTrackSubscribed: true }
  };
  const rows = [
    { sid: 'PA_A', identity: 'native-a', state: ParticipantInfo_State.ACTIVE,
      tracks: [{ sid: 'TR_A', type: TrackType.AUDIO, muted: false }] },
    { sid: 'PA_C', identity: 'customer-a', state: ParticipantInfo_State.ACTIVE,
      tracks: [{ sid: 'TR_C', type: TrackType.AUDIO, muted: true }] }
  ];
  const provider = { rooms: { listParticipants: async () => rows }, run: async (_, fn) => fn() };
  return { data, rows, verify: createNativeReadinessVerifier({ provider, now: () => 1800000000000 }) };
}

test('initial provider-confirmed customer mute establishes transport without fabricating decoded audio', async () => {
  const { data, verify } = fixture();
  const proof = await verify(data);
  assert.equal(proof.verified, true);
  assert.equal(proof.transportReady, true);
  assert.equal(proof.customerMuted, true);
  assert.equal(proof.bidirectionalAudio, false);
  assert.equal(proof.audiblePlaybackVerified, false);
  assert.equal(proof.evidenceKind, 'authenticated-sdk-rtc-with-provider-confirmed-customer-mute');
  assert.deepEqual(data.evidence.inbound, { packetsDelta: 0, bytesDelta: 0, decodedFramesDelta: 0 });
});

test('initial acoustic silence uses genuine RTP and PCM evidence with no speech-level threshold', async () => {
  const { data, rows, verify } = fixture();
  rows[1].tracks[0].muted = false;
  data.evidence.inbound = { packetsDelta: 30, bytesDelta: 1200, decodedFramesDelta: 48000 };
  delete data.evidence.readinessMode; delete data.evidence.customerMuted; delete data.evidence.customerTrackSubscribed;
  const proof = await verify(data);
  assert.equal(proof.verified, true);
  assert.equal(proof.bidirectionalAudio, true);
  assert.equal(proof.customerMuted, false);
});

test('a client cannot bypass absent inbound audio by claiming that an unmuted customer is muted', async () => {
  const { data, rows, verify } = fixture(); rows[1].tracks[0].muted = false;
  await assert.rejects(verify(data), { code: 'MEDIA_NOT_READY' });
});

test('a missing or different customer track cannot satisfy muted transport readiness', async () => {
  for (const change of [rows => rows[1].tracks = [], rows => rows[1].tracks[0].sid = 'TR_OLD',
    rows => rows[1].state = ParticipantInfo_State.DISCONNECTED]) {
    const { data, rows, verify } = fixture(); change(rows);
    await assert.rejects(verify(data), { code: 'MEDIA_NOT_READY' });
  }
});

test('muted readiness requires an actually subscribed customer track and exact explicit mode', async () => {
  for (const patch of [{ customerTrackSubscribed: false }, { customerMuted: false }, { readinessMode: 'connected' }]) {
    const { data, verify } = fixture(); Object.assign(data.evidence, patch);
    await assert.rejects(verify(data), { code: 'MEDIA_NOT_READY' });
  }
});

test('muted readiness still requires fresh established transports and real operator RTP', async () => {
  for (const patch of [{ outbound: { packetsDelta: 0, bytesDelta: 0 } }, { dtlsState: 'connecting' },
    { iceState: 'failed' }, { sampleAgeMs: 2500 }, { sampleDurationMs: 20 },
    { inbound: { packetsDelta: -1, bytesDelta: 0, decodedFramesDelta: 0 } }]) {
    const { data, verify } = fixture(); Object.assign(data.evidence, patch);
    await assert.rejects(verify(data), { code: 'MEDIA_NOT_READY' });
  }
});

test('operator microphone mute cannot be disguised as a customer-mute exception', async () => {
  const { data, rows, verify } = fixture(); rows[0].tracks[0].muted = true;
  await assert.rejects(verify(data), { code: 'MEDIA_NOT_READY' });
});

test('initial-muted transport proof cannot commit a transfer without decoded customer audio', async () => {
  const { data, verify } = fixture();
  data.transfer = { attemptId: 'leg-a', targetIdentity: 'native-a', toDeviceId: 'operator-a',
    readinessNonce: 'nonce-a', sourceIdentity: 'source-a' };
  await assert.rejects(verify(data), { code: 'MEDIA_NOT_READY' });
});

function installObservedTracks(runtime, accepted) {
  const data = fixture().data;
  Object.assign(data.evidence, { legId: accepted.join.legId, identity: accepted.join.identity,
    roomName: accepted.join.roomName, customerIdentity: accepted.join.customerIdentity });
  const rows = [
    { sid: 'PA_A', identity: accepted.join.identity, state: ParticipantInfo_State.ACTIVE,
      tracks: [{ sid: 'TR_A', type: TrackType.AUDIO, muted: false }] },
    { sid: 'PA_C', identity: accepted.join.customerIdentity, state: ParticipantInfo_State.ACTIVE,
      tracks: [{ sid: 'TR_C', type: TrackType.AUDIO, muted: true }] }
  ];
  runtime.runtime.verifyReadiness = createNativeReadinessVerifier({
    provider: { rooms: { listParticipants: async () => rows }, run: async (_, fn) => fn() }, now: runtime.now });
  return { rows, evidence: data.evidence };
}

test('runtime accepts corroborated customer-mute transport and preserves an honest proof after joining timeout', async () => {
  const f = runtimeFixture(); await f.incoming(); const accepted = await f.accept();
  const { evidence } = installObservedTracks(f, accepted);
  const result = await f.runtime.ready('a', accepted.call.sessionId,
    { version: accepted.call.version, readinessNonce: accepted.readinessNonce, evidence });
  assert.equal(result.call.phase, 'connected'); assert.equal(result.call.roomReady, true);
  assert.deepEqual(result.call.mediaReadiness, { mode: 'customer-muted-transport',
    bidirectionalAudioVerifiedAtReady: false, customerMutedAtReady: true, observedAt: f.now() });
  f.advance(95000); await f.runtime.recoverSession(accepted.call.sessionId);
  const state = await f.runtime.status('a', accepted.call.sessionId);
  assert.equal(state.call.phase, 'connected'); assert.equal(state.call.terminal, null);
});

test('muted transport cannot bypass the outgoing customer-acceptance gate', async () => {
  const f = runtimeFixture();
  const accepted = await f.runtime.outgoing('a', { to: '919999999999', requestId: 'initial-muted-outgoing' });
  const { evidence } = installObservedTracks(f, accepted);
  await assert.rejects(f.runtime.ready('a', accepted.call.sessionId,
    { version: accepted.call.version, readinessNonce: accepted.readinessNonce, evidence }), { code: 'CUSTOMER_NOT_ACCEPTED' });
});

test('a generic transport-ready boolean cannot bypass runtime audio proof validation', async () => {
  const f = runtimeFixture(); await f.incoming(); const accepted = await f.accept();
  f.runtime.verifyReadiness = async data => ({ ...f.proof(data), bidirectionalAudio: false,
    customerMuted: true, transportReady: true });
  await assert.rejects(f.ready(accepted), { code: 'MEDIA_NOT_VERIFIED' });
});
