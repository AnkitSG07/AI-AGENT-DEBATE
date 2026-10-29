import { ParticipantInfo_State, TrackType } from 'livekit-server-sdk';
import { requireValue } from '../media/errors.mjs';

const boundedPositive = value => Number.isSafeInteger(value) && value > 0 && value <= 100000000;

/** Corroborates fresh authenticated native SDK observations with the exact room.
 * This is not hardware attestation and does not prove the customer heard sound.
 * Live spoken-phrase/source-offline acceptance tests remain a separate gate. */
export function createNativeReadinessVerifier({ provider, now = Date.now } = {}) {
  requireValue(provider?.rooms && typeof provider.rooms.listParticipants === 'function',
    'READINESS_PROVIDER_REQUIRED', 'An official room observation client is required.', 503);
  return async function verify({ actor, call, transfer, evidence }) {
    const owner = transfer ? { legId: transfer.attemptId, identity: transfer.targetIdentity, deviceId: transfer.toDeviceId } : call.owner;
    const nonce = transfer ? transfer.readinessNonce : call.readinessNonce;
    requireValue(evidence && evidence.protocol === 'sh-room-audio-v1' && evidence.legId === owner.legId &&
      evidence.identity === owner.identity && evidence.roomName === call.roomName &&
      evidence.customerIdentity === call.customerIdentity && actor.deviceId === owner.deviceId &&
      typeof evidence.participantSid === 'string' && typeof evidence.localAudioTrackSid === 'string' &&
      typeof evidence.customerAudioTrackSid === 'string',
      'MEDIA_EVIDENCE_MISMATCH', 'Audio observations must belong to the exact authenticated room leg.');
    requireValue(Number.isFinite(evidence.sampleDurationMs) && evidence.sampleDurationMs >= 500 && evidence.sampleDurationMs <= 5000 &&
      Number.isFinite(evidence.sampleAgeMs) && evidence.sampleAgeMs >= 0 && evidence.sampleAgeMs <= 2000 &&
      evidence.iceState === 'succeeded' && evidence.dtlsState === 'connected' &&
      boundedPositive(evidence.outbound?.packetsDelta) && boundedPositive(evidence.outbound?.bytesDelta) &&
      boundedPositive(evidence.inbound?.packetsDelta) && boundedPositive(evidence.inbound?.bytesDelta) &&
      boundedPositive(evidence.inbound?.decodedFramesDelta),
      'MEDIA_NOT_READY', 'Fresh inbound, outbound and decoded customer audio are required.');
    const rows = await provider.run('ListParticipants', () => provider.rooms.listParticipants(call.roomName));
    const active = identity => rows.find(row => row.identity === identity && row.state === ParticipantInfo_State.ACTIVE);
    const operator = active(owner.identity), customer = active(call.customerIdentity);
    const audio = (row, sid) => row?.tracks?.some(track => track.sid === sid && track.type === TrackType.AUDIO && track.muted !== true);
    requireValue(operator?.sid === evidence.participantSid && audio(operator, evidence.localAudioTrackSid) &&
      audio(customer, evidence.customerAudioTrackSid), 'MEDIA_NOT_READY', 'The provider has not confirmed the exact active audio tracks.');
    if (transfer) requireValue(active(transfer.sourceIdentity), 'SOURCE_MEDIA_MISSING', 'The source leg must stay connected until handoff readiness.');
    return { verified: true, bidirectionalAudio: true, callId: call.id, transferId: transfer?.id,
      attemptId: transfer?.attemptId || owner.legId, deviceId: actor.deviceId, identity: owner.identity,
      readinessNonce: nonce, observedAt: now(), evidenceKind: 'authenticated-sdk-rtc-and-decoded-pcm-correlated-with-provider',
      audiblePlaybackVerified: false };
  };
}
