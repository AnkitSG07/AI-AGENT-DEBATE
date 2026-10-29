import { createHash } from 'node:crypto';
import { AccessToken, ConnectorClient, RoomServiceClient, SessionDescription, TrackSource,
  TrackType, ParticipantInfo_State, DisconnectWhatsAppCallRequest_DisconnectReason } from 'livekit-server-sdk';
import { MediaError, identifier, requireValue } from './errors.mjs';

const DISCONNECT = DisconnectWhatsAppCallRequest_DisconnectReason;
const hash = value => createHash('sha256').update(String(value)).digest('hex');

export function operatorIdentity(deviceId, legId) {
  identifier(deviceId, 'enrolled device');
  identifier(legId, 'call leg');
  return `sh-op-${hash(deviceId).slice(0, 24)}-${hash(legId).slice(0, 24)}`;
}

export function customerIdentity(callKey) {
  return `sh-customer-${hash(identifier(callKey, 'call key')).slice(0, 32)}`;
}

export function roomNameFor(callKey) {
  return `sh-call-${hash(identifier(callKey, 'call key')).slice(0, 40)}`;
}

export function readLiveKitConfig(env = {}) {
  const raw = String(env.LIVEKIT_URL || '');
  let url;
  try { url = new URL(raw.replace(/^wss:/, 'https:')); } catch { /* reported below */ }
  const missing = ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET']
    .filter(name => !String(env[name] || '').trim());
  const metaToken = String(env.WHATSAPP_CALL_ACCESS_TOKEN || env.META_WHATSAPP_ACCESS_TOKEN || env.WHATSAPP_ACCESS_TOKEN || '');
  if (!metaToken) missing.push('WHATSAPP_CALL_ACCESS_TOKEN');
  requireValue(!missing.length, 'MEDIA_CONFIG_MISSING', `Missing media configuration: ${missing.join(', ')}.`, 503);
  // The built-in WhatsApp connector is Cloud-only. Do not accept hosts from requests.
  requireValue(url && url.protocol === 'https:' && url.hostname.endsWith('.livekit.cloud') &&
    !url.username && !url.password && !url.port && !url.search && !url.hash &&
    (url.pathname === '/' || url.pathname === ''),
    'MEDIA_CONFIG_INVALID', 'LIVEKIT_URL must be an HTTPS/WSS LiveKit Cloud project origin.', 503);
  const apiVersion = String(env.WHATSAPP_GRAPH_API_VERSION || 'v23.0').replace(/^v/, '');
  requireValue(/^(23|24|25|26)\.0$/.test(apiVersion), 'MEDIA_CONFIG_INVALID', 'Unsupported configured WhatsApp API version.', 503);
  return Object.freeze({
    origin: url.origin, wsUrl: url.origin.replace(/^https:/, 'wss:'),
    apiKey: String(env.LIVEKIT_API_KEY), apiSecret: String(env.LIVEKIT_API_SECRET),
    metaToken, apiVersion,
    fingerprint: hash(`${url.origin}\0${env.LIVEKIT_API_KEY}\0${apiVersion}`).slice(0, 32)
  });
}

function audioSdp(sdp, type) {
  requireValue(typeof sdp === 'string' && sdp.length < 262144 && /^v=0(?:\r?\n)/.test(sdp) &&
    /(?:^|\r?\n)m=audio\s/.test(sdp), 'INVALID_SDP', `A real audio SDP ${type} is required.`, 400);
  return new SessionDescription({ type, sdp });
}

/**
 * Node 18+ adapter using pinned official livekit-server-sdk 2.18.0.
 * No media travels through this process. SDK regional failover/replay is disabled
 * so an ambiguous outgoing request cannot silently place a duplicate call.
 * These low-level methods MUST remain behind authenticated application control.
 */
export class LiveKitWhatsAppProvider {
  constructor(config, { clients, now = Date.now, timeoutMs = 15000 } = {}) {
    this.config = config;
    this.now = now;
    const options = { requestTimeout: timeoutMs / 1000, failover: false };
    this.connector = clients?.connector || new ConnectorClient(config.origin, config.apiKey, config.apiSecret, options);
    this.rooms = clients?.rooms || new RoomServiceClient(config.origin, config.apiKey, config.apiSecret, options);
    this.kind = 'livekit-whatsapp';
  }

  async run(method, operation) {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof MediaError) throw error;
      const providerCode = /^[a-z_]{1,50}$/.test(error?.code || '') ? error.code : '';
      const outcomeUnknown = !providerCode || Number(error.status) >= 500;
      // Error bodies/metadata can contain credentials or SDP; expose neither.
      throw new MediaError(outcomeUnknown ? 'MEDIA_REQUEST_UNCERTAIN' : 'MEDIA_PROVIDER_ERROR',
        `Media request ${method} did not return a confirmed result.`, error.status === 404 ? 404 : 502,
        { providerCode, operation: method, outcomeUnknown });
    }
  }

  async probeControlApi() {
    await this.run('ListRooms', () => this.rooms.listRooms(['sh-readiness-probe-nonexistent']));
    return { provider: this.kind, fingerprint: this.config.fingerprint,
      checkedAt: this.now(), controlApiReachable: true, audioVerified: false, transferEnabled: false };
  }

  async acceptIncoming({ callId, phoneNumberId, offerSdp, roomName = roomNameFor(callId) }) {
    identifier(callId, 'provider call ID'); identifier(phoneNumberId, 'business number ID'); identifier(roomName, 'room');
    const identity = customerIdentity(callId);
    const result = await this.run('AcceptWhatsAppCall', () => this.connector.acceptWhatsAppCall({
      whatsappCallId: callId, whatsappPhoneNumberId: phoneNumberId,
      whatsappApiKey: this.config.metaToken, whatsappCloudApiVersion: this.config.apiVersion,
      roomName, participantIdentity: identity, sdp: audioSdp(offerSdp, 'offer'),
      // Return signaling acknowledgement, not a fabricated Connected state.
      waitUntilAnswered: false
    }));
    return { callId, roomName: result.roomName || roomName, customerIdentity: identity,
      provider: this.kind, signalingAccepted: true, audioConnected: false };
  }

  async dialOutgoing({ phoneNumberId, to, requestId, roomName = roomNameFor(requestId), ringingTimeout = 45 }) {
    identifier(phoneNumberId, 'business number ID'); identifier(requestId, 'outgoing request ID'); identifier(roomName, 'room');
    requireValue(typeof to === 'string' && /^[1-9][0-9]{6,14}$/.test(to), 'INVALID_PHONE', 'Use a country-code phone number without a leading +.', 400);
    requireValue(Number.isInteger(ringingTimeout) && ringingTimeout >= 15 && ringingTimeout <= 90,
      'INVALID_INPUT', 'Invalid ringing timeout.', 400);
    const identity = customerIdentity(requestId);
    const result = await this.run('DialWhatsAppCall', () => this.connector.dialWhatsAppCall({
      whatsappPhoneNumberId: phoneNumberId, whatsappToPhoneNumber: to,
      whatsappApiKey: this.config.metaToken, whatsappCloudApiVersion: this.config.apiVersion,
      whatsappBizOpaqueCallbackData: requestId, roomName, participantIdentity: identity,
      ringingTimeout
    }));
    if (!result.whatsappCallId) throw new MediaError('MEDIA_REQUEST_UNCERTAIN', 'The dial result did not include a provider call ID; reconcile before retrying.', 502,
      { operation: 'DialWhatsAppCall', outcomeUnknown: true });
    return { callId: result.whatsappCallId, roomName: result.roomName || roomName,
      customerIdentity: identity, provider: this.kind, audioConnected: false };
  }

  async connectOutgoing({ callId, answerSdp }) {
    identifier(callId, 'provider call ID');
    await this.run('ConnectWhatsAppCall', () => this.connector.connectWhatsAppCall(callId, audioSdp(answerSdp, 'answer')));
    return { callId, signalingAccepted: true, audioConnected: false };
  }

  async terminateCustomer({ callId, reason = 'BUSINESS_INITIATED' }) {
    identifier(callId, 'provider call ID');
    requireValue(['BUSINESS_INITIATED', 'USER_INITIATED'].includes(reason), 'INVALID_INPUT', 'Invalid disconnect reason.', 400);
    try {
      await this.run('DisconnectWhatsAppCall', () => this.connector.disconnectWhatsAppCall(callId,
        reason === 'BUSINESS_INITIATED' ? this.config.metaToken : '', DISCONNECT[reason]));
      return { ended: true };
    } catch (error) {
      // The official protocol warns repeated disconnects can return an error.
      if (error.providerCode === 'not_found') return { ended: true, alreadyAbsent: true };
      throw error;
    }
  }

  async issueOperatorJoin({ roomName, deviceId, legId, ttlSeconds = 90 }) {
    identifier(roomName, 'room');
    requireValue(Number.isInteger(ttlSeconds) && ttlSeconds >= 15 && ttlSeconds <= 120,
      'INVALID_INPUT', 'Join token lifetime must be 15–120 seconds.', 400);
    const identity = operatorIdentity(deviceId, legId);
    const issuedAt = this.now();
    const access = new AccessToken(this.config.apiKey, this.config.apiSecret, { identity, ttl: ttlSeconds });
    access.addGrant({
      roomJoin: true, room: roomName, canPublish: true, canSubscribe: true,
      canPublishSources: [TrackSource.MICROPHONE], canPublishData: false, canUpdateOwnMetadata: false
    });
    const token = await access.toJwt();
    return { url: this.config.wsUrl, token, roomName, identity, issuedAt, expiresAt: issuedAt + ttlSeconds * 1000 };
  }

  async inspectParticipants({ roomName, customerIdentity: customer, operatorIdentity: operator, sourceIdentity }) {
    identifier(roomName, 'room');
    const rows = await this.run('ListParticipants', () => this.rooms.listParticipants(roomName));
    const active = identity => rows.find(p => p.identity === identity && p.state === ParticipantInfo_State.ACTIVE);
    const target = active(operator);
    const customerRow = active(customer);
    const hasAudio = row => !!row?.tracks?.some(t => t.type === TrackType.AUDIO && t.muted !== true);
    return { observedAt: this.now(), customerActive: !!customerRow, customerAudioPublished: hasAudio(customerRow),
      operatorActive: !!target, operatorAudioPublished: hasAudio(target), sourceActive: !!active(sourceIdentity),
      // Presence and publication do not prove playout or bidirectional RTP.
      bidirectionalAudioVerified: false };
  }

  async detachOperator({ roomName, identity, revokeBeforeMs = this.now() }) {
    identifier(roomName, 'room');
    requireValue(typeof identity === 'string' && /^sh-op-[a-f0-9]{24}-[a-f0-9]{24}$/.test(identity),
      'INVALID_OPERATOR_LEG', 'Only an operator participant may be detached by this method.', 400);
    requireValue(Number.isSafeInteger(revokeBeforeMs) && revokeBeforeMs >= 0,
      'INVALID_INPUT', 'Invalid operator token revocation time.', 400);
    try {
      // The cutoff is strictly "nbf before". Include the documented one-minute
      // leeway so a token issued in the same second as cancellation is revoked.
      await this.run('RemoveParticipant', () => this.rooms.removeParticipant(roomName, identity,
        { revokeTokenTs: BigInt(Math.ceil(revokeBeforeMs / 1000) + 60) }));
      return { detached: true };
    } catch (error) {
      if (error.providerCode === 'not_found') return { detached: true, alreadyAbsent: true };
      throw error;
    }
  }
}

/** Safe default. Importing this module never changes the existing call routes. */
export function mediaReleaseCapabilities() {
  return { enabled: false, available: false, mode: 'legacy-direct', code: 'TRANSFER_MEDIA_NOT_VALIDATED',
    reason: 'Media-room calling and native device readiness have not completed live verification.' };
}
