import { createHash, randomUUID } from 'node:crypto';
import { MediaError, identifier, requireValue } from '../media/errors.mjs';
import { callStoreKey, deviceReservationKey, newBridgedCall } from '../media/transfer-controller.mjs';
import { roomNameFor, customerIdentity, operatorIdentity } from '../media/livekit-provider.mjs';

const hash = value => createHash('sha256').update(String(value)).digest('hex');
export const sessionKey = id => `media_sessions/${hash(identifier(id))}`;
export const eventKey = id => `media_events/${hash(identifier(id))}`;
export const outgoingSessionId = (tenantId, deviceId, requestId) => `out_${hash(`${tenantId}:${deviceId}:${requestId}`).slice(0, 48)}`;
const outgoingCancelId = (tenantId, deviceId, requestId) => `cancel:${hash(`${tenantId}:${deviceId}:${requestId}`)}`;
const routeId = id => `route:${identifier(id)}`;
const terminalId = id => `terminal:${identifier(id)}`;
const acceptedId = id => `accepted:${identifier(id)}`;
const copy = value => structuredClone(value);
const isDue = (job, now) => job.status === 'pending' && job.notBefore <= now || job.status === 'running' && job.leaseUntil <= now;
const exact = (value, expected) => requireValue(Number.isSafeInteger(expected) && value === expected,
  'STALE_CALL_VERSION', 'Call state changed; refresh before this action.');
const request = value => { requireValue(typeof value === 'string' && /^[A-Za-z0-9_-]{8,120}$/.test(value), 'INVALID_REQUEST_ID', 'A stable request ID is required.', 400); return value; };
const safePhone = value => { requireValue(typeof value === 'string' && /^[1-9][0-9]{6,14}$/.test(value), 'INVALID_PHONE', 'Use a country-code phone number without a leading +.', 400); return value; };
const operationPending = session => Object.values(session.operations || {}).some(op => ['issued', 'uncertain'].includes(op.status));
function job(session, data) {
  if (!session.outbox.some(item => item.id === data.id)) session.outbox.push({ ...data, status: 'pending', attempts: 0, notBefore: 0 });
}
function schedule(session, now) {
  const outstanding = session.outbox.filter(item => item.status !== 'done').map(item => item.status === 'running' ? item.leaseUntil : item.notBefore);
  const deadlines = [];
  if (!session.terminal) deadlines.push(session.phase === 'connected' ? now + 15000 : session.deadlineAt);
  if (operationPending(session)) deadlines.push(now + 15000);
  session.nextActionAtMs = Math.min(...outstanding, ...deadlines.filter(Number.isFinite));
  if (!Number.isFinite(session.nextActionAtMs)) session.nextActionAtMs = null;
}
function terminalize(session, reason, now, { confirmed = false } = {}) {
  if (!session.terminal) session.terminal = { reason, endedAt: now };
  if (confirmed && !session.terminal.confirmedAt) session.terminal.confirmedAt = now;
  session.phase = session.terminal.confirmedAt ? 'ended' : 'ending';
  session.version++; session.updatedAt = now;
  if (session.providerCallId && !session.mediaReadyAt && (session.direction === 'outgoing' || session.owner))
    job(session, { id: `terminate:${session.providerCallId}`, kind: 'terminate', callId: session.providerCallId,
    reason: confirmed ? 'USER_INITIATED' : 'BUSINESS_INITIATED' });
  if (session.direction === 'incoming' && !session.owner && !confirmed && session.routeChoice !== 'legacy')
    job(session, { id: 'reject-incoming', kind: 'reject', callId: session.providerCallId });
  if (session.owner && !session.mediaReadyAt) job(session, { id: `detach:${session.owner.identity}`, kind: 'detach', roomName: session.roomName,
    identity: session.owner.identity, deviceId: session.owner.deviceId, revokeBeforeMs: now });
  job(session, { id: 'ended-notification', kind: 'notify', event: 'ended' });
  schedule(session, now);
}
const sameBinding = (actor, binding) => binding && actor.deviceId === binding.deviceId && actor.userId === binding.userId &&
  actor.credentialGeneration === binding.credentialGeneration;
function ownerBinding(session, call) {
  const saved = session.bindings?.[call.owner.deviceId];
  if (saved?.identity === call.owner.identity) return saved;
  const transfer = call.transfer;
  const target = transfer && session.transferBindings?.[transfer.id];
  // Recovery after ownership commit but before the redundant session binding
  // update derives the exact leg only from the committed canonical transfer.
  if (target && transfer.targetIdentity === call.owner.identity && transfer.toDeviceId === call.owner.deviceId &&
    ['completing', 'completed'].includes(transfer.status))
    return { ...target, identity: transfer.targetIdentity, legId: transfer.attemptId };
  return undefined;
}
function terminalCanonical(call, now, { confirmed = false, policyReason } = {}) {
  if (call.active) {
    call.active = false; call.status = confirmed ? 'ended' : 'ending';
    call.terminal = { reason: confirmed ? 'USER_INITIATED' : 'BUSINESS_INITIATED', endedAt: now,
      ...(confirmed ? { confirmedAt: now } : {}), ...(policyReason ? { policyReason } : {}) };
    call.version++; call.updatedAt = now;
    if (call.transfer && ['invited', 'connecting', 'completing'].includes(call.transfer.status)) {
      call.transfer.status = 'cancelled'; call.transfer.reason = 'call_ended';
    }
  } else if (confirmed && !call.terminal.confirmedAt) {
    call.terminal.confirmedAt = now; call.status = 'ended'; call.version++; call.updatedAt = now;
    const old = call.outbox.find(item => item.id === 'customer-disconnect');
    if (old?.status === 'pending') old.reason = 'USER_INITIATED';
  }
  job(call, { id: 'customer-disconnect', kind: 'terminate', callId: call.id,
    reason: confirmed ? 'USER_INITIATED' : 'BUSINESS_INITIATED' });
  const legs = new Map([[call.owner.deviceId, call.owner.identity]]);
  if (call.transfer?.sourceIdentity) legs.set(call.transfer.fromDeviceId, call.transfer.sourceIdentity);
  if (call.transfer?.targetIdentity) legs.set(call.transfer.toDeviceId, call.transfer.targetIdentity);
  for (const [deviceId, identity] of legs) job(call, { id: `detach:${identity}`, kind: 'detach', identity,
    deviceId, roomName: call.roomName, transferId: call.transfer?.id || '', revokeBeforeMs: now });
}

/** Server-only coordinator. Instantiation does not mount routes or enable media.
 * All Meta events must come from the root server's verified raw-body webhook.
 * Device identity is derived from enrolled bearer credentials, not Odoo cookies.
 * Provider calls and notification delivery never occur inside a transaction. */
export class CallRuntime {
  constructor({ store, provider, transferController, authenticate, resolveDevice, listDevices,
    capabilities = async () => ({ roomCalling: false, transferEnabled: false }), verifyReadiness,
    rejectIncoming, notify = async () => {}, phoneNumberId, tenantId = 'smart-handicrafts',
    minimumNativeBuild = 1, operatorAbsentGraceMs = 45000, now = Date.now }) {
    requireValue(store?.durable === true && provider && typeof authenticate === 'function' && typeof resolveDevice === 'function',
      'CALL_RUNTIME_CONFIG', 'A durable store, media provider and verified device authentication are required.', 503);
    identifier(phoneNumberId); identifier(tenantId);
    requireValue(Number.isSafeInteger(minimumNativeBuild) && minimumNativeBuild >= 1, 'CALL_RUNTIME_CONFIG', 'A minimum native build is required.', 503);
    requireValue(Number.isSafeInteger(operatorAbsentGraceMs) && operatorAbsentGraceMs >= 30000 && operatorAbsentGraceMs <= 120000,
      'CALL_RUNTIME_CONFIG', 'The operator reconnect grace must be between 30 and 120 seconds.', 503);
    Object.assign(this, { store, provider, transferController, authenticate, resolveDevice, listDevices,
      capabilityProvider: capabilities, verifyReadiness, rejectIncoming, notify, phoneNumberId, tenantId, minimumNativeBuild, operatorAbsentGraceMs, now });
  }

  async actor(context, { media = true } = {}) {
    const value = await this.authenticate(context);
    requireValue(value?.authenticated === true && value.canCall === true && value.tenantId === this.tenantId,
      'UNAUTHENTICATED_DEVICE', 'An enrolled operator bearer credential is required.', 401);
    const registered = await this.resolveDevice(identifier(value.deviceId));
    requireValue(registered && registered.revoked !== true && registered.deviceId === value.deviceId &&
      registered.userId === value.userId && registered.tenantId === this.tenantId &&
      Number.isSafeInteger(value.credentialGeneration) && value.credentialGeneration >= 1 &&
      registered.credentialGeneration === value.credentialGeneration &&
      Number.isFinite(registered.credentialExpiresAt) && registered.credentialExpiresAt > this.now(),
      'DEVICE_BINDING_INVALID', 'The enrolled credential is expired, revoked or changed.', 403);
    if (media) requireValue(registered.mediaProtocol === 'sh-room-audio-v1' && Number.isSafeInteger(registered.nativeBuild) &&
      registered.nativeBuild >= this.minimumNativeBuild, 'NATIVE_UPDATE_REQUIRED', 'This device needs the supported native room-audio build.', 426);
    return { deviceId: registered.deviceId, userId: registered.userId, tenantId: this.tenantId,
      credentialGeneration: registered.credentialGeneration, nativeBuild: registered.nativeBuild,
      mediaProtocol: registered.mediaProtocol, credentialExpiresAt: registered.credentialExpiresAt,
      authenticated: true, canCall: true };
  }

  async recheck(context, initial) {
    const current = await this.actor(context);
    requireValue(sameBinding(current, initial), 'DEVICE_BINDING_CHANGED', 'The enrolled credential changed during this operation.', 403);
    return current;
  }

  async capabilities(context) {
    const actor = await this.actor(context, { media: false });
    const value = await this.capabilityProvider();
    return { protocol: 'sh-room-audio-v1', roomCalling: value?.roomCalling === true,
      transferEnabled: value?.roomCalling === true && value?.transferEnabled === true &&
        (value.mode !== 'pilot' || value.pilotDeviceIds?.includes(actor.deviceId)), mode: value?.mode || 'disabled',
      minimumNativeBuild: this.minimumNativeBuild, nativeRoomUrl: this.provider.config.wsUrl,
      reason: String(value?.reason || '').slice(0, 240) };
  }

  async requireEnabled({ transfer = false } = {}) {
    const value = await this.capabilityProvider();
    requireValue(value?.roomCalling === true && (!transfer || value.transferEnabled === true),
      transfer ? 'TRANSFER_MEDIA_NOT_VALIDATED' : 'ROOM_CALLING_NOT_ENABLED',
      transfer ? 'This release has not enabled verified audio handoff.' : 'Native room calling is not enabled for this release.', 501);
  }

  providerFor(session) {
    requireValue(session.provider === this.provider.kind && session.providerFingerprint === this.provider.config.fingerprint,
      'MEDIA_PROJECT_CHANGED', 'This call belongs to another media configuration; reconcile it with its original provider.', 503);
    return this.provider;
  }

  async locate(id) {
    identifier(id);
    const direct = await this.store.get(sessionKey(id));
    if (direct) return direct;
    const route = await this.store.get(eventKey(routeId(id)));
    return route?.sessionId ? this.store.get(sessionKey(route.sessionId)) : undefined;
  }

  async isMediaAnchored(id) {
    const session = await this.locate(id);
    return !!session && session.tenantId === this.tenantId && session.routeChoice !== 'legacy';
  }

  /** Server-only result of the existing verified Odoo call/contact lookup.
   * Linking metadata must not invalidate an in-flight readiness version. */
  async attachVerifiedChannel(id, channelId) {
    identifier(id);
    requireValue(Number.isSafeInteger(channelId) && channelId > 0,
      'INVALID_CHANNEL_ID', 'A verified positive Odoo channel ID is required.', 400);
    const located = await this.locate(id);
    if (!located || located.tenantId !== this.tenantId) return { attached: false, reason: 'not_found' };
    return this.store.transaction(async tx => {
      const session = await tx.get(sessionKey(located.id)); this.requireSession(session);
      if (session.channelId && session.channelId !== channelId) return { attached: false, reason: 'already_linked', channelId: session.channelId };
      if (session.channelId !== channelId) {
        session.channelId = channelId; session.updatedAt = this.now();
        tx.set(sessionKey(session.id), session);
      }
      return { attached: true, sessionId: session.id, channelId };
    });
  }

  /** Root must authorize the existing Odoo/browser action first. This atomically
   * arbitrates first answer only; it never sends Meta accept/reject/terminate. */
  async claimLegacyIncoming(id, operationId) {
    identifier(operationId, 'legacy operation ID');
    const located = await this.locate(id);
    if (!located) return { allowed: true, claimed: false, managed: false };
    return this.store.transaction(async tx => {
      const session = await tx.get(sessionKey(located.id)); this.requireSession(session);
      if (session.routeChoice === 'legacy') {
        requireValue(session.legacyClaim?.operationId === operationId, 'CALL_ALREADY_CLAIMED', 'Another legacy operation already claimed this call.');
        return { allowed: true, claimed: true, replayed: true, sessionId: session.id };
      }
      requireValue(session.direction === 'incoming' && session.phase === 'ringing' && !session.owner && !session.terminal &&
        Object.keys(session.operations).length === 0, 'CALL_OWNED_BY_NATIVE', 'An enrolled native device already owns or ended this call.');
      const now = this.now();
      session.routeChoice = 'legacy'; session.legacyClaim = { operationId, claimedAt: now };
      session.phase = 'answered_elsewhere'; session.terminal = { reason: 'LEGACY_CLAIMED', endedAt: now, nativeOnly: true };
      session.version++; session.updatedAt = now;
      job(session, { id: 'ended-notification', kind: 'notify', event: 'ended' });
      schedule(session, now); tx.set(sessionKey(session.id), session);
      return { allowed: true, claimed: true, replayed: false, sessionId: session.id };
    });
  }

  requireSession(session) {
    requireValue(session && session.tenantId === this.tenantId, 'CALL_NOT_FOUND', 'Call not found.', 404);
  }

  async view(session) {
    const call = session.providerCallId ? await this.store.get(callStoreKey(session.providerCallId)) : null;
    const terminal = call?.terminal || session.terminal || null;
    return { sessionId: session.id, callId: session.providerCallId || session.id, providerCallId: session.providerCallId || null,
      phase: call ? call.status : session.phase, version: call?.version || session.version, sessionVersion: session.version,
      direction: session.direction, ownerDeviceId: call?.owner?.deviceId || session.owner?.deviceId || null,
      roomReady: !!call?.active && call.status === 'connected', endConfirmed: !!terminal?.confirmedAt,
      customerAcceptedAt: session.customerAcceptedAt || null,
      cleanupPending: session.outbox.some(item => item.status !== 'done') || !!call?.outbox.some(item => item.status !== 'done') ||
        (!!terminal && operationPending(session)), terminal,
      customerPhone: session.customerPhone || '', customerName: session.customerName || '',
      channelId: Number.isSafeInteger(session.channelId) && session.channelId > 0 ? session.channelId : 0,
      transfer: call?.transfer ? { id: call.transfer.id, status: call.transfer.status, fromDeviceId: call.transfer.fromDeviceId,
        toDeviceId: call.transfer.toDeviceId, expiresAt: call.transfer.expiresAt, reason: call.transfer.reason || null } : null };
  }

  async status(context, id) {
    await this.actor(context, { media: false });
    const session = await this.locate(id); this.requireSession(session);
    return { call: await this.view(session) };
  }

  async availableDevices(context, id) {
    const actor = await this.actor(context); await this.requireEnabled({ transfer: true });
    const session = await this.locate(id); this.requireSession(session);
    const call = session.providerCallId ? await this.store.get(callStoreKey(session.providerCallId)) : null;
    requireValue(call?.active && call.owner.deviceId === actor.deviceId, 'NOT_CALL_OWNER', 'Only the current operator can choose a transfer target.', 403);
    const rows = await this.listDevices?.({ tenantId: this.tenantId, limit: 16 });
    requireValue(Array.isArray(rows) && rows.length <= 16, 'DEVICE_LIST_UNAVAILABLE', 'The bounded device list is unavailable.', 503);
    const result = [];
    for (const row of rows) {
      if (row.deviceId === actor.deviceId || row.revoked || row.tenantId !== this.tenantId || row.mediaProtocol !== 'sh-room-audio-v1' ||
        row.nativeBuild < this.minimumNativeBuild || row.credentialExpiresAt <= this.now() || row.receiveCalls === false) continue;
      const reservation = await this.store.get(deviceReservationKey(row.deviceId));
      const policy = await this.capabilityProvider();
      if (policy.mode === 'pilot' && (!policy.pilotDeviceIds?.includes(actor.deviceId) || !policy.pilotDeviceIds?.includes(row.deviceId))) continue;
      result.push({ deviceId: row.deviceId, label: String(row.label || 'Operator device').slice(0, 120), available: !reservation,
        nativeBuild: row.nativeBuild, mediaProtocol: row.mediaProtocol });
    }
    return { devices: result };
  }

  async join(context, session, actor) {
    requireValue(!session.terminal && sameBinding(actor, session.owner), 'CALL_NOT_OWNED', 'This join belongs to another active enrolled leg.', 403);
    const join = await this.providerFor(session).issueOperatorJoin({ roomName: session.roomName,
      deviceId: actor.deviceId, legId: session.owner.legId, ttlSeconds: 90 });
    await this.recheck(context, actor);
    const current = await this.store.get(sessionKey(session.id)); this.requireSession(current);
    requireValue(!current.terminal && sameBinding(actor, current.owner) && current.owner.legId === session.owner.legId &&
      current.deadlineAt > this.now(), 'CALL_ENDED', 'The call ended or changed while joining.');
    requireValue(join.identity === current.owner.identity, 'MEDIA_IDENTITY_MISMATCH', 'The provider join identity does not match this leg.', 502);
    return { call: await this.view(current), join: { ...join, legId: current.owner.legId, customerIdentity: current.customerIdentity },
      readinessNonce: current.readinessNonce };
  }

  /** No client may call this directly. Root verifies Meta signature/raw bytes. */
  async ingestVerifiedMetaEvent(event) {
    requireValue(event?.verified === true && ['incoming', 'connect', 'accepted', 'terminate'].includes(event.type),
      'UNVERIFIED_WEBHOOK', 'A verified provider call event is required.', 401);
    identifier(event.eventId); identifier(event.callId);
    requireValue(event.phoneNumberId === this.phoneNumberId, 'BUSINESS_NUMBER_MISMATCH', 'This event belongs to another business number.', 403);
    const marker = `evt:${hash(event.eventId)}`;
    const located = await this.locate(event.callId);
    let sessionId = located?.id;
    if (!sessionId && event.opaqueSessionId) {
      const outgoing = await this.store.get(sessionKey(identifier(event.opaqueSessionId)));
      if (outgoing?.direction === 'outgoing' && outgoing.phoneNumberId === this.phoneNumberId) sessionId = outgoing.id;
    }
    if (!sessionId && event.type === 'incoming') { await this.requireEnabled(); sessionId = event.callId; }
    if (!sessionId && !['accepted', 'terminate'].includes(event.type)) return { handled: false };
    const now = this.now();
    if (event.type === 'incoming') requireValue(typeof event.offerSdp === 'string' && event.offerSdp.length < 200000 &&
      /^v=0\r?\n/.test(event.offerSdp) && /(?:^|\r?\n)m=audio\s/.test(event.offerSdp), 'INVALID_SDP', 'An actual incoming audio offer is required.', 400);
    const result = await this.store.transaction(async tx => {
      const [existingMarker, route, terminal, accepted] = await Promise.all([
        tx.get(eventKey(marker)), tx.get(eventKey(routeId(event.callId))),
        tx.get(eventKey(terminalId(event.callId))), tx.get(eventKey(acceptedId(event.callId)))
      ]);
      const resolvedSessionId = sessionId || route?.sessionId;
      const session = resolvedSessionId ? await tx.get(sessionKey(resolvedSessionId)) : undefined;
      if (existingMarker) return { handled: !!session, sessionId: session?.id, replayed: true };
      const canonical = event.type === 'terminate' ? await tx.get(callStoreKey(event.callId)) : null;
      const reservations = new Map();
      if (event.type === 'terminate') {
        const ids = new Set([session?.owner?.deviceId, canonical?.owner?.deviceId,
          canonical?.transfer?.fromDeviceId, canonical?.transfer?.toDeviceId].filter(Boolean));
        for (const deviceId of ids) reservations.set(deviceId, await tx.get(deviceReservationKey(deviceId)));
      }
      requireValue(!route || route.sessionId === resolvedSessionId, 'CALL_ROUTE_CONFLICT', 'The provider call is already bound to another session.');
      let next = session;
      if (!next && event.type === 'incoming') {
        next = { id: sessionId, tenantId: this.tenantId, provider: this.provider.kind, providerFingerprint: this.provider.config.fingerprint,
          phoneNumberId: this.phoneNumberId, providerCallId: event.callId, direction: 'incoming', phase: 'ringing', version: 1,
          roomName: roomNameFor(sessionId), customerIdentity: customerIdentity(sessionId), owner: null,
          customerPhone: String(event.customerPhone || '').slice(0, 32), customerName: String(event.customerName || '').slice(0, 160),
          channelId: Number.isSafeInteger(event.channelId) && event.channelId > 0 ? event.channelId : 0,
          offerSdp: event.offerSdp, operations: {}, outbox: [], bindings: {}, createdAt: now, updatedAt: now, deadlineAt: now + 90000 };
        if (terminal || Number.isFinite(event.occurredAtMs) && now - event.occurredAtMs > 90000)
          terminalize(next, terminal ? 'USER_INITIATED' : 'TIMED_OUT', now, { confirmed: !!terminal });
        else job(next, { id: 'incoming-notification', kind: 'notify', event: 'incoming' });
      }
      if (next) {
        requireValue(next.tenantId === this.tenantId && (!next.providerCallId || next.providerCallId === event.callId),
          'CALL_ROUTE_CONFLICT', 'The provider call does not match this durable attempt.');
        next.providerCallId = event.callId;
        if (event.type === 'connect' && next.direction === 'outgoing') {
          requireValue(typeof event.answerSdp === 'string' && event.answerSdp.length < 200000 && /^v=0\r?\n/.test(event.answerSdp),
            'INVALID_SDP', 'An actual outgoing audio answer is required.', 400);
          if (!next.terminal && !next.mediaReadyAt) { next.answerSdp = event.answerSdp; next.phase = 'connecting';
            job(next, { id: 'connect-answer', kind: 'connect', callId: event.callId }); }
          if (next.operations.dial) next.operations.dial.status = 'acknowledged';
        }
        // SDP negotiation and ringback RTP do not mean the recipient picked up.
        // Only a trusted Meta ACCEPTED event can satisfy the outgoing answer gate.
        if (next.direction === 'outgoing' && !next.terminal && !terminal && event.type !== 'terminate' &&
          (accepted || event.type === 'accepted')) {
          next.customerAcceptedAt ||= accepted?.acceptedAt || now;
          if (next.operations.dial) next.operations.dial.status = 'acknowledged';
          if (!next.mediaReadyAt) next.phase = next.answerSdp ? 'connecting' : 'ringing';
        }
        if (event.type === 'terminate' || terminal) {
          for (const op of Object.values(next.operations)) if (['issued', 'uncertain'].includes(op.status)) op.status = 'provider-ended';
          terminalize(next, 'USER_INITIATED', now, { confirmed: true });
        } else { next.version++; next.updatedAt = now; schedule(next, now); }
      }
      if (canonical) {
        terminalCanonical(canonical, now, { confirmed: true });
        tx.set(callStoreKey(canonical.id), canonical);
      }
      if (event.type === 'terminate' && next) for (const [deviceId, reservation] of reservations) {
        if (!reservation || ![next.id, event.callId].includes(reservation.callId)) continue;
        const identity = canonical?.owner?.deviceId === deviceId ? canonical.owner.identity :
          canonical?.transfer?.toDeviceId === deviceId ? canonical.transfer.targetIdentity :
          canonical?.transfer?.fromDeviceId === deviceId ? canonical.transfer.sourceIdentity :
          next.owner?.deviceId === deviceId ? next.owner.identity : null;
        if (identity) tx.set(deviceReservationKey(deviceId), { ...reservation, kind: 'cleanup', identity, deviceId });
        else if (reservation.kind === 'invite') tx.delete(deviceReservationKey(deviceId));
      }
      if (event.type === 'terminate' && !terminal) tx.set(eventKey(terminalId(event.callId)),
        { id: terminalId(event.callId), kind: 'terminal', providerCallId: event.callId, tenantId: this.tenantId, createdAt: now });
      if (event.type === 'accepted' && !accepted) tx.set(eventKey(acceptedId(event.callId)),
        { id: acceptedId(event.callId), kind: 'customer-accepted', providerCallId: event.callId,
          tenantId: this.tenantId, acceptedAt: now, createdAt: now });
      if (next) {
        if (!route) tx.set(eventKey(routeId(event.callId)), { id: routeId(event.callId), kind: 'route', sessionId: next.id,
          providerCallId: event.callId, tenantId: this.tenantId, createdAt: now });
        tx.set(sessionKey(next.id), next);
      }
      tx.set(eventKey(marker), { id: marker, kind: 'provider-event', eventType: event.type, providerCallId: event.callId,
        sessionId: next?.id || '', tenantId: this.tenantId, createdAt: now });
      return { handled: !!next, sessionId: next?.id, terminal: event.type === 'terminate' };
    });
    return result;
  }

  async accept(context, id, { requestId }) {
    const actor = await this.actor(context); request(requestId);
    const snapshot = await this.locate(id); this.requireSession(snapshot);
    if (snapshot.mediaReadyAt) return this.resume(context, snapshot, actor);
    if (!snapshot.owner) await this.requireEnabled();
    const legId = `leg_${randomUUID()}`, readinessNonce = randomUUID();
    const prepared = await this.store.transaction(async tx => {
      const session = await tx.get(sessionKey(snapshot.id));
      const reservation = await tx.get(deviceReservationKey(actor.deviceId));
      this.requireSession(session);
      requireValue(!session.terminal && session.deadlineAt > this.now(), 'CALL_ENDED', 'This call is no longer answerable.');
      requireValue(session.routeChoice !== 'legacy', 'CALL_ANSWERED_ELSEWHERE', 'The browser operator already claimed this call.');
      if (session.owner) {
        requireValue(sameBinding(actor, session.owner), 'CALL_ANSWERED_ELSEWHERE', 'Another enrolled device owns this call.');
        requireValue(reservation?.sessionId === session.id && ['pending', 'owner'].includes(reservation.kind),
          'OWNER_RESERVATION_MISSING', 'Call ownership must be reconciled before joining.');
        requireValue(!['accepting', 'dialing', 'uncertain'].includes(session.phase), 'CALL_OPERATION_PENDING',
          'The existing provider operation is still being reconciled.');
        return { session, issueProvider: false };
      }
      requireValue(session.direction === 'incoming' && session.phase === 'ringing' && !reservation,
        reservation ? 'DEVICE_BUSY' : 'CALL_NOT_ANSWERABLE', 'This device or incoming call is no longer available.');
      session.owner = { deviceId: actor.deviceId, userId: actor.userId, credentialGeneration: actor.credentialGeneration,
        nativeBuild: actor.nativeBuild, legId, identity: operatorIdentity(actor.deviceId, legId) };
      session.bindings[actor.deviceId] = copy(session.owner); session.readinessNonce = readinessNonce;
      session.routeChoice = 'native';
      session.phase = 'accepting'; session.version++; session.updatedAt = this.now(); session.deadlineAt = this.now() + 120000;
      session.operations.accept = { id: requestId, status: 'issued', issuedAt: this.now(), leaseUntil: this.now() + 45000 };
      schedule(session, this.now());
      tx.set(deviceReservationKey(actor.deviceId), { callId: session.id, sessionId: session.id, deviceId: actor.deviceId, kind: 'pending' });
      tx.set(sessionKey(session.id), session);
      return { session, issueProvider: true };
    });
    if (prepared.issueProvider) {
      let dispatched = false;
      try {
        await this.recheck(context, actor);
        const provider = this.providerFor(prepared.session);
        requireValue(!(await this.store.get(sessionKey(prepared.session.id))).terminal, 'CALL_ENDED', 'The call ended before answering started.');
        dispatched = true;
        const result = await provider.acceptIncoming({ callId: prepared.session.providerCallId,
          phoneNumberId: this.phoneNumberId, offerSdp: prepared.session.offerSdp, roomName: prepared.session.roomName });
        await this.finishProviderOperation(prepared.session.id, 'accept', result);
      } catch (error) {
        await this.failProviderOperation(prepared.session.id, 'accept', error, { notDispatched: !dispatched });
        throw this.publicProviderError(error);
      }
    }
    const current = await this.store.get(sessionKey(prepared.session.id));
    await this.recheck(context, actor);
    return this.join(context, current, actor);
  }

  async resume(context, session, actor) {
    const call = await this.store.get(callStoreKey(session.providerCallId));
    const binding = call ? ownerBinding(session, call) : null;
    requireValue(call?.active && !session.terminal && call.owner.deviceId === actor.deviceId && call.owner.userId === actor.userId &&
      sameBinding(actor, binding) && binding.identity === call.owner.identity,
      'NOT_CALL_OWNER', 'This device no longer owns the active media leg.', 403);
    const join = await this.providerFor(session).issueOperatorJoin({ roomName: call.roomName,
      deviceId: actor.deviceId, legId: call.owner.legId, ttlSeconds: 90 });
    await this.recheck(context, actor);
    const latest = await this.store.get(callStoreKey(call.id));
    const latestSession = await this.store.get(sessionKey(session.id));
    requireValue(latest?.active && !latestSession.terminal && latest.owner.identity === call.owner.identity && join.identity === call.owner.identity,
      'CALL_ENDED', 'The call owner changed while restoring audio.');
    return { call: await this.view(latestSession), join: { ...join, legId: call.owner.legId, customerIdentity: call.customerIdentity },
      readinessNonce: call.transfer?.toDeviceId === actor.deviceId ? call.transfer.readinessNonce : session.readinessNonce };
  }

  async outgoing(context, { to, requestId }) {
    const actor = await this.actor(context); await this.requireEnabled(); safePhone(to); request(requestId);
    const id = outgoingSessionId(this.tenantId, actor.deviceId, requestId);
    const legId = `leg_${randomUUID()}`, nonce = randomUUID();
    const prepared = await this.store.transaction(async tx => {
      const existing = await tx.get(sessionKey(id));
      const reservation = await tx.get(deviceReservationKey(actor.deviceId));
      const cancelled = await tx.get(eventKey(outgoingCancelId(this.tenantId, actor.deviceId, requestId)));
      if (existing) {
        requireValue(existing.customerPhone === to && sameBinding(actor, existing.owner), 'REQUEST_ID_CONFLICT',
          'This request ID belongs to another destination or enrollment.');
        return { session: existing, issueProvider: false };
      }
      if (cancelled) {
        requireValue(cancelled.credentialGeneration === actor.credentialGeneration, 'REQUEST_ID_CONFLICT', 'This cancelled request belongs to an earlier enrollment.');
        return { cancelled: true };
      }
      requireValue(!reservation, 'DEVICE_BUSY', 'This device is still handling or cleaning up another call.');
      const now = this.now(), owner = { deviceId: actor.deviceId, userId: actor.userId, credentialGeneration: actor.credentialGeneration,
        nativeBuild: actor.nativeBuild, legId, identity: operatorIdentity(actor.deviceId, legId) };
      const session = { id, tenantId: this.tenantId, provider: this.provider.kind, providerFingerprint: this.provider.config.fingerprint,
        phoneNumberId: this.phoneNumberId, direction: 'outgoing', phase: 'dialing', version: 1,
        routeChoice: 'native',
        roomName: roomNameFor(id), customerIdentity: customerIdentity(id), owner, bindings: { [actor.deviceId]: copy(owner) },
        customerPhone: to, customerName: '', readinessNonce: nonce, requestId, outbox: [],
        operations: { dial: { id: requestId, status: 'issued', issuedAt: now, leaseUntil: now + 45000 } },
        createdAt: now, updatedAt: now, deadlineAt: now + 120000 };
      schedule(session, now);
      tx.set(sessionKey(id), session);
      tx.set(deviceReservationKey(actor.deviceId), { callId: id, sessionId: id, deviceId: actor.deviceId, kind: 'pending' });
      return { session, issueProvider: true };
    });
    if (prepared.cancelled) return { sessionId: id, cancelled: true, call: { sessionId: id, callId: id, providerCallId: null,
      phase: 'ended', direction: 'outgoing', ownerDeviceId: actor.deviceId, roomReady: false, endConfirmed: true, cleanupPending: false,
      version: 0, sessionVersion: 0, transfer: null } };
    if (prepared.issueProvider) {
      let dispatched = false;
      try {
        await this.recheck(context, actor);
        const provider = this.providerFor(prepared.session);
        requireValue(!(await this.store.get(sessionKey(id))).terminal, 'CALL_ENDED', 'The outgoing call was cancelled before dialing.');
        dispatched = true;
        const result = await provider.dialOutgoing({ phoneNumberId: this.phoneNumberId,
          to, requestId: id, roomName: prepared.session.roomName, ringingTimeout: 60 });
        await this.finishProviderOperation(id, 'dial', result);
      } catch (error) {
        await this.failProviderOperation(id, 'dial', error, { notDispatched: !dispatched });
        // Include only the durable session locator. Never retry the dial here.
        const publicError = this.publicProviderError(error); publicError.sessionId = id; throw publicError;
      }
    }
    const current = await this.store.get(sessionKey(id));
    if (current.terminal || ['dialing', 'uncertain'].includes(current.phase)) return { call: await this.view(current) };
    return this.join(context, current, actor);
  }

  /** A cancellation marker also wins if the original dial request arrives later. */
  async cancelOutgoing(context, requestId) {
    const actor = await this.actor(context, { media: false }); request(requestId);
    const id = outgoingSessionId(this.tenantId, actor.deviceId, requestId), marker = outgoingCancelId(this.tenantId, actor.deviceId, requestId);
    await this.store.transaction(async tx => {
      const existing = await tx.get(eventKey(marker));
      if (existing) {
        requireValue(existing.credentialGeneration === actor.credentialGeneration, 'REQUEST_ID_CONFLICT', 'This request belongs to an earlier enrollment.');
        return;
      }
      tx.set(eventKey(marker), { id: marker, kind: 'outgoing-cancel', sessionId: id, tenantId: this.tenantId,
        deviceId: actor.deviceId, userId: actor.userId, credentialGeneration: actor.credentialGeneration, createdAt: this.now() });
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      const session = await this.store.get(sessionKey(id));
      if (!session) return { sessionId: id, cancelled: true, awaitingOriginalRequest: true };
      requireValue(sameBinding(actor, session.owner), 'NOT_CALL_OWNER', 'This outgoing attempt belongs to another enrollment.', 403);
      const view = await this.view(session);
      if (view.ownerDeviceId !== actor.deviceId) return { sessionId: id, cancelled: false, ownershipMoved: true, call: view };
      if (session.terminal) return { sessionId: id, cancelled: true, call: view };
      try { return { sessionId: id, cancelled: true, ...await this.end(context, id, { version: view.version, requestId }) }; }
      catch (error) { if (error.code !== 'STALE_CALL_VERSION' || attempt === 2) throw error; }
    }
  }

  publicProviderError(error) {
    if (error instanceof MediaError && !['MEDIA_PROVIDER_ERROR', 'MEDIA_REQUEST_UNCERTAIN'].includes(error.code)) return error;
    return new MediaError(error?.outcomeUnknown === false ? 'MEDIA_PROVIDER_ERROR' : 'MEDIA_REQUEST_UNCERTAIN',
      error?.outcomeUnknown === false ? 'The provider did not accept this operation.' : 'The provider result is uncertain; the existing attempt is being reconciled.', 502);
  }

  async finishProviderOperation(id, operation, result) {
    identifier(result?.callId);
    return this.store.transaction(async tx => {
      const session = await tx.get(sessionKey(id)); this.requireSession(session);
      const route = await tx.get(eventKey(routeId(result.callId)));
      const terminal = await tx.get(eventKey(terminalId(result.callId)));
      const accepted = await tx.get(eventKey(acceptedId(result.callId)));
      requireValue(result.roomName === session.roomName && result.customerIdentity === session.customerIdentity &&
        (!session.providerCallId || session.providerCallId === result.callId) && (!route || route.sessionId === id),
        'MEDIA_IDENTITY_MISMATCH', 'The provider returned an unexpected call or room identity.', 502);
      session.providerCallId = result.callId;
      session.operations[operation].status = 'acknowledged'; session.operations[operation].acknowledgedAt = this.now();
      if (terminal && !session.terminal) terminalize(session, 'USER_INITIATED', this.now(), { confirmed: true });
      if (session.terminal) {
        // A cancellation can precede the provider's response. This distinct
        // cleanup key must run even if an earlier terminate saw no room leg.
        job(session, { id: `terminate:late-${operation}`, kind: 'terminate', callId: result.callId,
          reason: session.terminal.confirmedAt ? 'USER_INITIATED' : 'BUSINESS_INITIATED' });
      } else {
        if (session.direction === 'outgoing' && accepted) session.customerAcceptedAt ||= accepted.acceptedAt;
        if (!session.mediaReadyAt) session.phase = operation === 'accept' ? 'joining' : session.answerSdp ? 'connecting' : 'ringing';
      }
      session.version++; session.updatedAt = this.now(); schedule(session, this.now());
      if (!route) tx.set(eventKey(routeId(result.callId)), { id: routeId(result.callId), kind: 'route', sessionId: id,
        providerCallId: result.callId, tenantId: this.tenantId, createdAt: this.now() });
      tx.set(sessionKey(id), session);
      return session;
    });
  }

  async failProviderOperation(id, operation, error, { notDispatched = false } = {}) {
    await this.store.transaction(async tx => {
      const session = await tx.get(sessionKey(id)); this.requireSession(session);
      const current = session.operations[operation];
      // An early verified connect/terminate webhook may already have resolved it.
      if (!current || ['acknowledged', 'provider-ended'].includes(current.status)) return;
      current.status = notDispatched || error?.outcomeUnknown === false ? 'failed' : 'uncertain';
      current.failedAt = this.now(); current.errorCode = notDispatched ? 'NOT_DISPATCHED' : error?.outcomeUnknown === false ? 'PROVIDER_REJECTED' : 'OUTCOME_UNCERTAIN';
      if (current.status === 'failed') {
        terminalize(session, 'FAILED', this.now(), { confirmed: operation === 'dial' && !session.providerCallId });
        if (operation === 'accept') job(session, { id: 'reject-after-failure', kind: 'reject', callId: session.providerCallId });
      } else if (!session.terminal) { session.phase = 'uncertain'; session.version++; session.updatedAt = this.now(); }
      schedule(session, this.now()); tx.set(sessionKey(id), session);
    });
  }

  async ready(context, id, { version, readinessNonce, evidence }) {
    const actor = await this.actor(context);
    const snapshot = await this.locate(id); this.requireSession(snapshot);
    if (snapshot.phase === 'connected' && !snapshot.terminal) {
      const call = await this.store.get(callStoreKey(snapshot.providerCallId));
      requireValue(call?.active && call.owner.deviceId === actor.deviceId && call.owner.userId === actor.userId &&
        sameBinding(actor, ownerBinding(snapshot, call)), 'NOT_CALL_OWNER', 'This device no longer owns the active call.', 403);
      return { call: await this.view(snapshot), replayed: true };
    }
    requireValue(!snapshot.terminal && sameBinding(actor, snapshot.owner), 'NOT_CALL_OWNER', 'This readiness belongs to another active device.', 403);
    exact(snapshot.version, version);
    requireValue(['joining', 'connecting', 'ringing'].includes(snapshot.phase) && snapshot.providerCallId &&
      snapshot.readinessNonce === readinessNonce && snapshot.deadlineAt > this.now(),
      'READINESS_STALE', 'This exact call leg is no longer joining.');
    requireValue(snapshot.direction !== 'outgoing' || Number.isFinite(snapshot.customerAcceptedAt),
      'CUSTOMER_NOT_ACCEPTED', 'The customer has not yet accepted this outgoing call.');
    requireValue(typeof this.verifyReadiness === 'function', 'NATIVE_READINESS_UNAVAILABLE', 'Native media readiness is not integrated.', 501);
    const proof = await this.verifyReadiness({ actor, call: snapshot, evidence });
    const now = this.now();
    requireValue(proof?.verified === true && proof.bidirectionalAudio === true && proof.callId === snapshot.id &&
      proof.deviceId === actor.deviceId && proof.identity === snapshot.owner.identity && proof.readinessNonce === snapshot.readinessNonce &&
      Number.isFinite(proof.observedAt) && proof.observedAt <= now && now - proof.observedAt <= 5000,
      'MEDIA_NOT_VERIFIED', 'Fresh corroborated audio progress is required.');
    await this.recheck(context, actor);
    await this.store.transaction(async tx => {
      const session = await tx.get(sessionKey(snapshot.id));
      const reservation = await tx.get(deviceReservationKey(actor.deviceId));
      const existing = await tx.get(callStoreKey(snapshot.providerCallId));
      requireValue(!session.terminal && session.version === snapshot.version && session.deadlineAt > this.now() &&
        (session.direction !== 'outgoing' || Number.isFinite(session.customerAcceptedAt)) &&
        this.now() - proof.observedAt <= 5000 && sameBinding(actor, session.owner) && session.readinessNonce === readinessNonce &&
        reservation?.kind === 'pending' && reservation.sessionId === session.id && !existing,
        'CALL_CHANGED', 'Call state changed while media readiness was being checked.');
      const call = newBridgedCall({ callId: session.providerCallId, roomName: session.roomName, customerIdentity: session.customerIdentity,
        tenantId: this.tenantId, owner: session.owner, provider: session.provider, now: this.now() });
      // The native UI compares versions across joining and connected states.
      // Promoting to canonical storage must not reset that public counter to 1.
      call.version = session.version + 1;
      // Real decoded/RTP readiness resolves a possibly lost Connect acknowledgement.
      // Do not replay SDP against an already established customer media leg.
      const answerJob = session.outbox.find(item => item.id === 'connect-answer');
      if (answerJob && answerJob.status !== 'done') { answerJob.status = 'done'; delete answerJob.leaseId; delete answerJob.leaseUntil; }
      session.phase = 'connected'; session.mediaReadyAt = this.now(); session.version++; session.updatedAt = this.now(); schedule(session, this.now());
      tx.set(sessionKey(session.id), session);
      tx.set(callStoreKey(call.id), call);
      tx.set(deviceReservationKey(actor.deviceId), { callId: call.id, sessionId: session.id, deviceId: actor.deviceId, kind: 'owner' });
    });
    return { call: await this.view(await this.store.get(sessionKey(snapshot.id))) };
  }

  async end(context, id, { version, requestId, reject = false }) {
    const actor = await this.actor(context, { media: false }); request(requestId);
    const snapshot = await this.locate(id); this.requireSession(snapshot);
    const canonical = snapshot.providerCallId ? await this.store.get(callStoreKey(snapshot.providerCallId)) : null;
    if (canonical) {
      requireValue(!reject, 'CALL_ALREADY_ANSWERED', 'Use End for an answered call.');
      requireValue(this.transferController, 'CALL_RUNTIME_CONFIG', 'The connected call controller is unavailable.', 503);
      await this.transferController.endByOperator(context, { callId: canonical.id, expectedVersion: version });
      await this.markSessionEnded(snapshot.id, 'BUSINESS_INITIATED', false);
    } else await this.store.transaction(async tx => {
      const session = await tx.get(sessionKey(snapshot.id));
      const reservation = session.owner ? await tx.get(deviceReservationKey(session.owner.deviceId)) : null;
      requireValue(!session.owner || sameBinding(actor, session.owner), 'NOT_CALL_OWNER', 'Another device owns this call.', 403);
      if (session.terminal) return;
      exact(session.version, version);
      requireValue(!reject || session.direction === 'incoming' && session.phase === 'ringing' && !session.owner,
        'CALL_ALREADY_ANSWERED', 'This call has already started answering.');
      terminalize(session, reject ? 'REJECTED' : 'BUSINESS_INITIATED', this.now());
      if (session.owner && reservation?.sessionId === session.id)
        tx.set(deviceReservationKey(session.owner.deviceId), { ...reservation, kind: 'cleanup', identity: session.owner.identity });
      schedule(session, this.now()); tx.set(sessionKey(session.id), session);
    });
    return { call: await this.view(await this.store.get(sessionKey(snapshot.id))) };
  }

  async markSessionEnded(id, reason, confirmed) {
    return this.store.transaction(async tx => {
      const session = await tx.get(sessionKey(id)); this.requireSession(session);
      terminalize(session, reason, this.now(), { confirmed });
      tx.set(sessionKey(id), session);
      return session;
    });
  }

  async transfer(context, id, action, body = {}) {
    const actor = await this.actor(context);
    if (!['decline', 'cancel'].includes(action)) await this.requireEnabled({ transfer: true });
    requireValue(this.transferController, 'TRANSFER_MEDIA_NOT_VALIDATED', 'The transfer controller is not installed.', 501);
    const session = await this.locate(id); this.requireSession(session);
    requireValue(session.providerCallId && !session.terminal, 'CALL_ENDED', 'This call is no longer active.');
    const callId = session.providerCallId;
    let result;
    if (action === 'invite') {
      const target = await this.resolveDevice(identifier(body.toDeviceId));
      requireValue(target && target.tenantId === this.tenantId && target.revoked !== true && target.receiveCalls !== false &&
        target.mediaProtocol === 'sh-room-audio-v1' && target.nativeBuild >= this.minimumNativeBuild &&
        target.credentialExpiresAt > this.now() && Number.isSafeInteger(target.credentialGeneration),
        'TARGET_UNAVAILABLE', 'The destination enrollment is not ready for native room calls.');
      result = await this.transferController.invite(context, { callId, toDeviceId: body.toDeviceId,
        expectedVersion: body.version, requestId: request(body.requestId) });
      await this.store.transaction(async tx => {
        const current = await tx.get(sessionKey(session.id));
        current.transferBindings ||= {};
        const old = current.transferBindings[result.transfer.id];
        if (!old) {
          current.transferBindings[result.transfer.id] = { deviceId: target.deviceId, userId: target.userId,
            credentialGeneration: target.credentialGeneration, nativeBuild: target.nativeBuild };
          current.version++; current.updatedAt = this.now();
          job(current, { id: `transfer-invite:${result.transfer.id}`, kind: 'notify', event: 'transfer-incoming',
            transferId: result.transfer.id, toDeviceId: target.deviceId });
          schedule(current, this.now()); tx.set(sessionKey(current.id), current);
        }
      });
    } else {
      const currentCall = await this.store.get(callStoreKey(callId));
      const transfer = currentCall?.transfer?.id === body.transferId ? currentCall.transfer : currentCall?.transferHistory?.[body.transferId];
      requireValue(transfer, 'TRANSFER_NOT_FOUND', 'This transfer was not found.', 404);
      if (['accept', 'ready'].includes(action)) {
        const binding = session.transferBindings?.[transfer.id];
        requireValue(sameBinding(actor, binding), 'DEVICE_BINDING_CHANGED', 'The invitation belongs to an earlier enrolled credential.', 403);
      }
      if (action === 'accept') result = await this.transferController.accept(context,
        { callId, transferId: body.transferId, expectedVersion: body.version });
      else if (action === 'ready') {
        result = await this.transferController.confirmReady(context, { callId, transferId: body.transferId,
          expectedVersion: body.version, readinessNonce: body.readinessNonce, evidence: body.evidence });
        await this.store.transaction(async tx => {
          const current = await tx.get(sessionKey(session.id));
          const binding = current.transferBindings?.[transfer.id];
          if (binding) { current.bindings[actor.deviceId] = { ...binding, legId: transfer.attemptId, identity: transfer.targetIdentity };
            current.version++; current.updatedAt = this.now(); schedule(current, this.now()); tx.set(sessionKey(current.id), current); }
        });
      } else if (['decline', 'cancel'].includes(action)) result = await this.transferController.stopTransfer(context,
        { callId, transferId: body.transferId, expectedVersion: body.version, action });
      else throw new MediaError('INVALID_TRANSFER_ACTION', 'Unknown transfer action.', 400);
    }
    await this.syncTransferNotifications(session.id);
    const fresh = await this.store.get(sessionKey(session.id));
    const response = { call: await this.view(fresh) };
    if (result.join) {
      const currentCall = await this.store.get(callStoreKey(callId));
      await this.recheck(context, actor);
      requireValue(currentCall?.active && !fresh.terminal && currentCall.transfer?.id === body.transferId &&
        currentCall.transfer.status === 'connecting' && sameBinding(actor, fresh.transferBindings?.[body.transferId]),
        'TRANSFER_CHANGED', 'The invitation changed while the room token was being prepared.');
      response.join = { ...result.join, customerIdentity: session.customerIdentity, legId: currentCall.transfer.attemptId };
      response.readinessNonce = result.readinessNonce;
    }
    return response;
  }

  async syncTransferNotifications(id) {
    return this.store.transaction(async tx => {
      const session = await tx.get(sessionKey(id));
      if (!session?.providerCallId) return;
      const call = await tx.get(callStoreKey(session.providerCallId));
      if (!call) return;
      const before = session.outbox.length;
      for (const transfer of [...Object.values(call.transferHistory), ...(call.transfer ? [call.transfer] : [])]) {
        if (!['declined', 'cancelled', 'expired', 'failed'].includes(transfer.status)) continue;
        job(session, { id: `transfer-ended:${transfer.id}`, kind: 'notify', event: 'transfer-ended',
          transferId: transfer.id, toDeviceId: transfer.toDeviceId, reason: transfer.reason || transfer.status });
      }
      if (session.outbox.length !== before) {
        session.version++; session.updatedAt = this.now(); schedule(session, this.now()); tx.set(sessionKey(id), session);
      }
    });
  }

  /** Supply this callback to TransferController.verifyReadiness. The native
   * observations are verified first, then the persisted credential generation
   * is checked again before the controller's versioned ownership transaction. */
  async verifyTransferReadiness(data) {
    requireValue(typeof this.verifyReadiness === 'function', 'NATIVE_READINESS_UNAVAILABLE', 'Native media readiness is not integrated.', 501);
    const session = await this.locate(data.call.id); this.requireSession(session);
    requireValue(!session.terminal, 'CALL_ENDED', 'The call has already ended.');
    const binding = session.transferBindings?.[data.transfer.id];
    requireValue(sameBinding(data.actor, binding), 'DEVICE_BINDING_CHANGED', 'This readiness belongs to an earlier device enrollment.', 403);
    const result = await this.verifyReadiness(data);
    const current = await this.resolveDevice(data.actor.deviceId);
    const latest = await this.store.get(sessionKey(session.id));
    requireValue(!latest.terminal && current && !current.revoked && current.credentialExpiresAt > this.now() &&
      sameBinding(current, binding), 'DEVICE_BINDING_CHANGED', 'The device enrollment changed while audio was being verified.', 403);
    return result;
  }

  /** Verified policy action for a revoked/expired owner; no client can invoke it.
   * Persist canonical terminal state before any asynchronous provider cleanup. */
  async terminateForPolicy(id, reason = 'CREDENTIAL_REVOKED', { expectedOwnerIdentity } = {}) {
    await this.store.transaction(async tx => {
      const session = await tx.get(sessionKey(id)); this.requireSession(session);
      const call = session.providerCallId ? await tx.get(callStoreKey(session.providerCallId)) : null;
      if (expectedOwnerIdentity && (call?.owner?.identity || session.owner?.identity) !== expectedOwnerIdentity) return;
      const identities = new Map();
      if (session.owner) identities.set(session.owner.deviceId, session.owner.identity);
      if (call?.owner) identities.set(call.owner.deviceId, call.owner.identity);
      if (call?.transfer?.sourceIdentity) identities.set(call.transfer.fromDeviceId, call.transfer.sourceIdentity);
      if (call?.transfer?.targetIdentity) identities.set(call.transfer.toDeviceId, call.transfer.targetIdentity);
      const reservations = new Map();
      for (const deviceId of identities.keys()) reservations.set(deviceId, await tx.get(deviceReservationKey(deviceId)));
      const now = this.now();
      terminalize(session, reason, now);
      if (call && call.active) {
        terminalCanonical(call, now, { policyReason: reason });
        tx.set(callStoreKey(call.id), call);
      }
      for (const [deviceId, identity] of identities) {
        const reservation = reservations.get(deviceId);
        if (reservation && (reservation.callId === session.id || reservation.callId === session.providerCallId))
          tx.set(deviceReservationKey(deviceId), { ...reservation, kind: 'cleanup', identity, deviceId });
      }
      schedule(session, now); tx.set(sessionKey(session.id), session);
    });
  }

  async reconcileEligibility(session) {
    const call = session.providerCallId ? await this.store.get(callStoreKey(session.providerCallId)) : null;
    if (call && !call.active && !session.terminal) {
      await this.markSessionEnded(session.id, call.terminal.reason, !!call.terminal.confirmedAt);
      return;
    }
    const owner = call?.active ? call.owner : session.terminal ? null : session.owner;
    if (owner) {
      const binding = session.bindings[owner.deviceId] || Object.values(session.transferBindings || {}).find(row => row.deviceId === owner.deviceId);
      const row = await this.resolveDevice(owner.deviceId);
      if (!binding || !row || row.revoked || row.userId !== binding.userId || row.credentialGeneration !== binding.credentialGeneration ||
        row.credentialExpiresAt <= this.now() || row.tenantId !== this.tenantId) {
        await this.terminateForPolicy(session.id, 'CREDENTIAL_REVOKED', { expectedOwnerIdentity: owner.identity }); return;
      }
    }
    if (call?.active && !session.terminal) await this.reconcileOperatorPresence(session, call);
    if (call?.active && call.transfer && ['invited', 'connecting'].includes(call.transfer.status)) {
      const binding = session.transferBindings?.[call.transfer.id], row = await this.resolveDevice(call.transfer.toDeviceId);
      if (!binding || !row || row.revoked || row.userId !== binding.userId || row.credentialGeneration !== binding.credentialGeneration ||
        row.credentialExpiresAt <= this.now()) {
        // Expire only the target invitation; preserve the existing operator/customer.
        await this.store.transaction(async tx => {
          const current = await tx.get(callStoreKey(call.id));
          const reservation = await tx.get(deviceReservationKey(call.transfer.toDeviceId));
          if (!current?.active || current.transfer?.id !== call.transfer.id || !['invited', 'connecting'].includes(current.transfer.status)) return;
          const tr = current.transfer; tr.status = 'cancelled'; tr.reason = 'target_credential_revoked'; current.version++; current.updatedAt = this.now();
          if (tr.targetIdentity) job(current, { id: `detach:${tr.targetIdentity}`, kind: 'detach', roomName: current.roomName,
            identity: tr.targetIdentity, deviceId: tr.toDeviceId, transferId: tr.id, revokeBeforeMs: this.now() });
          if (reservation?.callId === current.id && reservation.transferId === tr.id) {
            if (tr.targetIdentity) tx.set(deviceReservationKey(tr.toDeviceId), { ...reservation, kind: 'cleanup', identity: tr.targetIdentity });
            else tx.delete(deviceReservationKey(tr.toDeviceId));
          }
          tx.set(callStoreKey(current.id), current);
        });
      }
    }
  }

  async reconcileOperatorPresence(session, snapshot) {
    let observation;
    try {
      observation = await this.providerFor(session).inspectParticipants({ roomName: snapshot.roomName,
        customerIdentity: snapshot.customerIdentity, operatorIdentity: snapshot.owner.identity, sourceIdentity: snapshot.owner.identity });
    } catch (error) {
      // Only the official provider's exact room-not-found result proves absence;
      // transport/auth/configuration errors never do.
      if (error?.providerCode !== 'not_found') return;
      observation = { observedAt: this.now(), operatorActive: false, roomMissing: true };
    }
    if (!Number.isFinite(observation.observedAt) || observation.observedAt > this.now() || this.now() - observation.observedAt > 5000) return;
    const missing = await this.store.transaction(async tx => {
      const current = await tx.get(sessionKey(session.id));
      const call = await tx.get(callStoreKey(snapshot.id));
      if (!call?.active || current.terminal || call.owner.identity !== snapshot.owner.identity) return false;
      if (observation.operatorActive) {
        if (current.ownerAbsent) { delete current.ownerAbsent; current.version++; current.updatedAt = this.now(); tx.set(sessionKey(current.id), current); }
        return false;
      }
      const prior = current.ownerAbsent;
      if (prior?.identity === call.owner.identity && observation.observedAt - prior.since >= this.operatorAbsentGraceMs) return true;
      if (!prior || prior.identity !== call.owner.identity) {
        current.ownerAbsent = { identity: call.owner.identity, since: observation.observedAt };
        current.version++; current.updatedAt = this.now(); tx.set(sessionKey(current.id), current);
      }
      return false;
    });
    if (missing) await this.terminateForPolicy(session.id, 'OPERATOR_DISCONNECTED', { expectedOwnerIdentity: snapshot.owner.identity });
  }

  /** Send only the existing incoming-alert job before slower reconciliation.
   * No provider action or new alert is created here. The ordinary recovery path
   * shares its lease, fresh-state check, retry and settlement implementation. */
  async dispatchIncomingAlert(id) {
    const effects = await this.drainSessionOutbox(id, { limit: 1, incomingOnly: true });
    return { dispatched: effects.some(item => item.succeeded), effects };
  }

  async drainSessionOutbox(id, { limit, incomingOnly = false }) {
    requireValue(Number.isInteger(limit) && limit >= 1 && limit <= 8, 'INVALID_INPUT', 'Recovery must be bounded.', 400);
    const effects = [];
    for (let index = 0; index < limit; index++) {
      const leaseId = randomUUID();
      const claimed = await this.store.transaction(async tx => {
        const current = await tx.get(sessionKey(id));
        if (!current) return null;
        if (incomingOnly && (current.direction !== 'incoming' || current.terminal || current.owner ||
            current.phase !== 'ringing' || current.deadlineAt <= this.now())) return null;
        const selected = incomingOnly ? current.outbox.find(item => item.kind === 'notify' && item.event === 'incoming' && isDue(item, this.now())) :
          current.outbox.find(item => ['terminate', 'reject'].includes(item.kind) && isDue(item, this.now())) ||
          current.outbox.find(item => isDue(item, this.now()));
        if (!selected) return null;
        Object.assign(selected, { status: 'running', leaseId, leaseUntil: this.now() + 45000, attempts: selected.attempts + 1 });
        schedule(current, this.now()); tx.set(sessionKey(id), current);
        return { session: current, job: copy(selected) };
      });
      if (!claimed) break;
      let succeeded = false;
      try {
        const current = await this.store.get(sessionKey(id));
        const item = claimed.job;
        if (item.kind === 'connect') {
          if (!current.terminal && !current.mediaReadyAt) await this.providerFor(current).connectOutgoing({ callId: current.providerCallId, answerSdp: current.answerSdp });
        } else if (item.kind === 'terminate') await this.providerFor(current).terminateCustomer(item);
        else if (item.kind === 'detach') await this.providerFor(current).detachOperator(item);
        else if (item.kind === 'reject') {
          requireValue(typeof this.rejectIncoming === 'function', 'REJECT_PROVIDER_UNAVAILABLE', 'The server reject adapter is unavailable.', 503);
          await this.rejectIncoming({ callId: item.callId, phoneNumberId: this.phoneNumberId });
        } else if (item.kind === 'notify') {
          let eligible = ['ended', 'transfer-ended'].includes(item.event) || item.event === 'incoming' && !current.terminal && !current.owner && current.phase === 'ringing' && current.deadlineAt > this.now();
          if (item.event === 'transfer-incoming' && !current.terminal) {
            const active = await this.store.get(callStoreKey(current.providerCallId));
            eligible = active?.active && active.transfer?.id === item.transferId && active.transfer.status === 'invited';
          }
          if (eligible) await this.notify({ session: current, event: item.event,
            transferId: item.transferId, toDeviceId: item.toDeviceId, reason: item.reason });
        } else throw new MediaError('INVALID_JOB', 'Unknown session recovery operation.');
        succeeded = true;
      } catch { /* Persist retry; do not put SDK details/tokens/SDP into records. */ }
      await this.store.transaction(async tx => {
        const current = await tx.get(sessionKey(id));
        const item = current.outbox.find(row => row.id === claimed.job.id);
        if (!item || item.leaseId !== leaseId) return;
        item.status = succeeded ? 'done' : 'pending'; item.notBefore = this.now() + Math.min(30000, 1000 * 2 ** Math.min(item.attempts, 5));
        delete item.leaseId; delete item.leaseUntil;
        if (succeeded && ['terminate', 'reject'].includes(item.kind) && current.terminal && !operationPending(current) &&
          current.outbox.filter(row => ['terminate', 'reject'].includes(row.kind)).every(row => row.status === 'done') && !current.terminal.confirmedAt) {
          current.terminal.confirmedAt = this.now(); current.phase = 'ended'; current.version++;
        }
        current.updatedAt = this.now(); schedule(current, this.now()); tx.set(sessionKey(id), current);
      });
      effects.push({ kind: claimed.job.kind, succeeded });
    }
    return effects;
  }

  /** Idempotent, bounded recovery entry point called by the persisted due index. */
  async recoverSession(id, { limit = 4 } = {}) {
    requireValue(Number.isInteger(limit) && limit >= 1 && limit <= 8, 'INVALID_INPUT', 'Recovery must be bounded.', 400);
    let session = await this.store.get(sessionKey(id)); if (!session) return { recovered: false };
    await this.reconcileEligibility(session);
    if (session.providerCallId && this.transferController) await this.transferController.expire(session.providerCallId);
    await this.syncTransferNotifications(id);
    await this.store.transaction(async tx => {
      const current = await tx.get(sessionKey(id));
      const now = this.now();
      for (const op of Object.values(current.operations)) if (op.status === 'issued' && op.leaseUntil <= now) {
        op.status = 'uncertain'; if (!current.terminal) current.phase = 'uncertain'; current.version++;
      }
      if (!current.terminal && current.phase !== 'connected' && current.deadlineAt <= now) {
        terminalize(current, 'TIMED_OUT', now);
      }
      current.updatedAt = now; schedule(current, now); tx.set(sessionKey(id), current);
    });
    const effects = await this.drainSessionOutbox(id, { limit });
    session = await this.store.get(sessionKey(id));
    if (session.providerCallId && this.transferController) await this.transferController.drainOutbox(session.providerCallId, { limit: 2 });
    await this.releasePreMediaReservation(id);
    return { recovered: true, effects };
  }

  async releasePreMediaReservation(id) {
    await this.store.transaction(async tx => {
      const session = await tx.get(sessionKey(id));
      if (!session?.owner || !session.terminal?.confirmedAt || operationPending(session) || session.outbox.some(item => item.status !== 'done')) return;
      const call = session.providerCallId ? await tx.get(callStoreKey(session.providerCallId)) : null;
      const reservation = await tx.get(deviceReservationKey(session.owner.deviceId));
      if (call || !reservation || reservation.sessionId !== session.id || !['pending', 'cleanup'].includes(reservation.kind)) return;
      if (reservation.kind === 'pending') {
        // Two commits deliberately preserve the explicit cleanup transition.
        tx.set(deviceReservationKey(session.owner.deviceId), { ...reservation, kind: 'cleanup', identity: session.owner.identity });
        session.nextActionAtMs = this.now(); tx.set(sessionKey(id), session);
      } else tx.delete(deviceReservationKey(session.owner.deviceId));
    });
  }
}
