import { createHash, randomUUID } from 'node:crypto';
import { MediaError, identifier, requireValue } from './errors.mjs';
import { operatorIdentity } from './livekit-provider.mjs';

const digest = value => createHash('sha256').update(identifier(value)).digest('hex');
export const callStoreKey = callId => `media_calls/${digest(callId)}`;
export const deviceReservationKey = deviceId => `media_reservations/${digest(deviceId)}`;
const PENDING = new Set(['invited', 'connecting']);
// Bound normal call documents below the production store's 512 KiB limit.
// Refuse new invitations at the cap; never discard replay/terminal evidence.
export const MAX_TRANSFERS_PER_CALL = 64;
const copy = value => structuredClone(value);
const fail = (code, message, status = 409) => { throw new MediaError(code, message, status); };
const exactVersion = (call, expected) => requireValue(Number.isSafeInteger(expected) && expected === call.version,
  'STALE_CALL_VERSION', 'Call state changed; refresh before this action.');
const matchReservation = (row, call, transferId) => row?.callId === call.id && (!transferId || row.transferId === transferId);

function visible(call, transfer = call.transfer) {
  return { callId: call.id, version: call.version, active: call.active,
    ownerDeviceId: call.owner.deviceId, status: call.status, terminal: call.terminal || null,
    endConfirmed: !!call.terminal?.confirmedAt,
    transfer: transfer ? {
      id: transfer.id, status: transfer.status, fromDeviceId: transfer.fromDeviceId,
      toDeviceId: transfer.toDeviceId, createdAt: transfer.createdAt,
      expiresAt: transfer.expiresAt, completedAt: transfer.completedAt || null,
      reason: transfer.reason || null
    } : null,
    cleanupPending: call.outbox.some(job => job.status !== 'done') };
}

function transferById(call, transferId) {
  return call.transfer?.id === transferId ? call.transfer : call.transferHistory?.[transferId];
}

function addJob(call, job) {
  if (!call.outbox.some(existing => existing.id === job.id))
    call.outbox.push({ ...job, status: 'pending', attempts: 0, notBefore: 0 });
}

function detachJob(call, identity, transferId, now, deviceId) {
  if (!identity) return;
  addJob(call, { id: `detach:${identity}`, kind: 'detach', identity,
    roomName: call.roomName, transferId, deviceId, revokeBeforeMs: now });
}

const cleanupReservation = (callId, identity, transferId = '') => ({ callId, identity, transferId, kind: 'cleanup' });

/**
 * Create only AFTER a trusted call coordinator establishes a connector room and
 * verifies the original operator's media. This is a record factory, not a route.
 * It must be stored with an atomic "absent only" create and owner reservation.
 */
export function newBridgedCall({ callId, roomName, customerIdentity, tenantId, owner,
  provider = 'livekit-whatsapp', now = Date.now() }) {
  [callId, roomName, customerIdentity, tenantId, owner?.deviceId, owner?.userId, owner?.legId]
    .forEach(value => identifier(value));
  return {
    id: callId, roomName, customerIdentity, tenantId, provider,
    active: true, status: 'connected', mediaAnchor: 'room', version: 1,
    owner: { deviceId: owner.deviceId, userId: owner.userId, legId: owner.legId,
      identity: operatorIdentity(owner.deviceId, owner.legId) },
    transfer: null, transferHistory: {}, requests: {}, outbox: [], createdAt: now, updatedAt: now
  };
}

/**
 * Provider-neutral authenticated transfer state machine.
 *
 * store: durable=true; get(key); transaction(async tx => value), where tx.get is
 * async, tx.set/tx.delete stage changes atomically across ALL keys. Transactions
 * may retry; callbacks contain no provider, push, token, or other external I/O.
 *
 * authenticate(context) MUST verify the real request credential and enrolled
 * device binding. It must never copy operator_device_id from request JSON.
 * resolveDevice(deviceId) MUST read the durable authorized device registry.
 *
 * rolloutGuard defaults OFF. A passing control-API probe is not sufficient.
 * verifyReadiness defaults DENY until an actual room client and telemetry path
 * exist. This module does not invent bidirectional audio evidence.
 */
export class TransferController {
  constructor({ store, provider, authenticate, resolveDevice, rolloutGuard = async () => false,
    verifyReadiness, verifyProviderEvent, now = Date.now, invitationMs = 60000, evidenceMaxAgeMs = 5000 }) {
    requireValue(store?.durable === true && typeof store.transaction === 'function' && typeof store.get === 'function',
      'DURABLE_STORE_REQUIRED', 'Call transfer requires a durable transactional store.', 503);
    requireValue(provider && typeof authenticate === 'function' && typeof resolveDevice === 'function',
      'MEDIA_INTEGRATION_MISSING', 'Media provider and authenticated device resolution are required.', 503);
    requireValue(invitationMs >= 15000 && invitationMs <= 120000 && evidenceMaxAgeMs > 0 && evidenceMaxAgeMs <= 10000,
      'INVALID_CONFIG', 'Invalid transfer timing configuration.', 503);
    Object.assign(this, { store, provider, authenticate, resolveDevice, rolloutGuard,
      verifyReadiness, verifyProviderEvent, now, invitationMs, evidenceMaxAgeMs });
  }

  async actor(context) {
    const actor = await this.authenticate(context);
    requireValue(actor?.authenticated === true && actor.canCall === true && actor.deviceId && actor.userId && actor.tenantId,
      'UNAUTHENTICATED_DEVICE', 'A signed-in, enrolled operator device is required.', 401);
    const registered = await this.resolveDevice(actor.deviceId, context);
    requireValue(registered && registered.revoked !== true && registered.deviceId === actor.deviceId &&
      registered.userId === actor.userId && registered.tenantId === actor.tenantId,
      'DEVICE_BINDING_INVALID', 'This device is not enrolled for the authenticated operator.', 403);
    return actor;
  }

  validateRollout(validation) {
    requireValue(validation && validation.enabled === true && validation.provider === this.provider.kind &&
      validation.clientProtocol === 'sh-room-audio-v1' && typeof validation.liveTwoDeviceEvidenceId === 'string' &&
      validation.liveTwoDeviceEvidenceId.length >= 8,
      'TRANSFER_MEDIA_NOT_VALIDATED', 'Room audio and two-device handoff have not been validated for this release.', 501);
  }

  async requireRollout() { this.validateRollout(await this.rolloutGuard()); }

  async recheckActor(context, previous) {
    const current = await this.actor(context);
    requireValue(current.deviceId === previous.deviceId && current.userId === previous.userId && current.tenantId === previous.tenantId,
      'DEVICE_BINDING_CHANGED', 'The authenticated device binding changed during this operation.', 403);
  }

  requireCall(call, actor) {
    requireValue(call, 'CALL_NOT_FOUND', 'Call not found.', 404);
    if (actor) requireValue(call.tenantId === actor.tenantId, 'CALL_FORBIDDEN', 'This call belongs to another workspace.', 403);
  }

  requireActive(call) {
    requireValue(call.active && !call.terminal && call.status === 'connected', 'CALL_ENDED', 'This call is no longer active.');
    requireValue(call.mediaAnchor === 'room' && call.provider === this.provider.kind,
      'CALL_NOT_BRIDGED', 'A direct browser call cannot be transferred through a media room.');
  }

  requireTransfer(call, transferId, actor, role) {
    const transfer = transferById(call, identifier(transferId, 'transfer ID'));
    requireValue(transfer, 'TRANSFER_NOT_FOUND', 'This exact transfer was not found.', 404);
    const allowed = role === 'target' ? transfer.toDeviceId === actor.deviceId :
      role === 'source' ? transfer.fromDeviceId === actor.deviceId :
      [transfer.toDeviceId, transfer.fromDeviceId].includes(actor.deviceId);
    requireValue(allowed, 'TRANSFER_FORBIDDEN', 'This transfer belongs to another device.', 403);
    return transfer;
  }

  async invite(context, { callId, toDeviceId, expectedVersion, requestId, observedCall }) {
    const actor = await this.actor(context);
    await this.requireRollout(context, { callId, toDeviceId }, actor);
    identifier(callId, 'call ID'); identifier(toDeviceId, 'target device');
    requireValue(typeof requestId === 'string' && /^[A-Za-z0-9_-]{8,120}$/.test(requestId),
      'INVALID_REQUEST_ID', 'A stable request ID is required.', 400);
    requireValue(actor.deviceId !== toDeviceId, 'SAME_DEVICE', 'Choose another device.', 400);
    const target = await this.resolveDevice(toDeviceId);
    requireValue(target && target.deviceId === toDeviceId && target.tenantId === actor.tenantId &&
      target.revoked !== true && target.receiveCalls !== false && target.mediaProtocol === 'sh-room-audio-v1',
      'TARGET_UNAVAILABLE', 'The target device is unavailable or lacks the room audio client.');
    await this.expire(callId, observedCall);
    const transferId = `tr_${randomUUID()}`;
    return this.store.transaction(async tx => {
      const [call, targetReservation, sourceReservation] = await Promise.all([
        tx.get(callStoreKey(callId)), tx.get(deviceReservationKey(toDeviceId)),
        tx.get(deviceReservationKey(actor.deviceId))
      ]);
      this.requireCall(call, actor);
      const replay = call.requests[`${actor.deviceId}:${requestId}`];
      if (replay) {
        requireValue(replay.toDeviceId === toDeviceId, 'REQUEST_ID_CONFLICT', 'This request ID belongs to a different destination.');
        return { ...visible(call, transferById(call, replay.transferId)), replayed: true };
      }
      this.requireActive(call); exactVersion(call, expectedVersion);
      requireValue(Object.keys(call.requests).length < MAX_TRANSFERS_PER_CALL,
        'TRANSFER_HISTORY_LIMIT', 'This call has reached its transfer-attempt limit; existing cleanup and ending remain available.');
      requireValue(call.owner.deviceId === actor.deviceId && call.owner.userId === actor.userId,
        'NOT_CALL_OWNER', 'Only the current owner can transfer this call.', 403);
      requireValue(matchReservation(sourceReservation, call) && sourceReservation.kind === 'owner',
        'OWNER_RESERVATION_MISSING', 'The active call ownership must be reconciled first.');
      requireValue(!call.transfer || !['invited', 'connecting', 'completing'].includes(call.transfer.status),
        'TRANSFER_PENDING', 'Another transfer is already in progress.');
      const now = this.now();
      requireValue(!targetReservation,
        'TARGET_BUSY', 'The target device is already handling a call or invitation.');
      if (call.transfer) call.transferHistory[call.transfer.id] = call.transfer;
      const transfer = {
        id: transferId, status: 'invited', fromDeviceId: actor.deviceId, sourceIdentity: call.owner.identity,
        toDeviceId, toUserId: target.userId, createdAt: now, expiresAt: now + this.invitationMs,
        requestId, generation: call.version + 1
      };
      call.transfer = transfer;
      call.requests[`${actor.deviceId}:${requestId}`] = { transferId, toDeviceId };
      call.version++; call.updatedAt = now;
      tx.set(deviceReservationKey(toDeviceId), { callId, transferId, kind: 'invite', expiresAt: transfer.expiresAt });
      tx.set(callStoreKey(callId), call);
      return visible(call);
    });
  }

  async accept(context, { callId, transferId, expectedVersion, expectedTransferId, observedCall }) {
    const actor = await this.actor(context);
    await this.requireRollout(context, { callId, transferId }, actor);
    await this.expire(callId, observedCall);
    const attemptId = `leg_${randomUUID()}`;
    const readinessNonce = randomUUID();
    const prepared = await this.store.transaction(async tx => {
      const [call, reservation] = await Promise.all([
        tx.get(callStoreKey(callId)), tx.get(deviceReservationKey(actor.deviceId))
      ]);
      this.requireCall(call, actor);
      const transfer = this.requireTransfer(call, transferId, actor, 'target');
      if (expectedTransferId !== undefined) requireValue(expectedTransferId === transfer.id,
        'TRANSFER_CHANGED', 'The exact invitation identity changed before accepting.');
      if (['completed', 'completing'].includes(transfer.status)) return { result: visible(call, transfer) };
      this.requireActive(call);
      requireValue(call.transfer?.id === transfer.id && PENDING.has(transfer.status) && transfer.expiresAt > this.now(),
        'TRANSFER_EXPIRED', 'This transfer is no longer available.');
      requireValue(call.owner.deviceId === transfer.fromDeviceId && call.owner.identity === transfer.sourceIdentity &&
        matchReservation(reservation, call, transfer.id) && reservation.kind === 'invite',
        'TRANSFER_CHANGED', 'Call ownership or target reservation changed.');
      requireValue(transfer.toUserId === actor.userId, 'DEVICE_BINDING_CHANGED', 'The target device enrollment changed.', 403);
      if (transfer.status === 'invited') {
        // An explicit immutable invitation identity can authorize the initial
        // accept without a preceding status GET. All ownership, reservation,
        // target/enrollment and expiry checks above remain authoritative.
        if (!(expectedVersion === undefined && expectedTransferId === transfer.id)) exactVersion(call, expectedVersion);
        Object.assign(transfer, { status: 'connecting', attemptId, readinessNonce,
          targetIdentity: operatorIdentity(actor.deviceId, attemptId), acceptedAt: this.now() });
        call.version++; call.updatedAt = this.now();
        tx.set(callStoreKey(callId), call);
      }
      // Duplicate accept resumes the SAME leg. It never issues a second Meta accept.
      return { call: copy(call), transfer: copy(transfer) };
    });
    if (prepared.result) return prepared.result;
    const { call, transfer } = prepared;
    const join = await this.provider.issueOperatorJoin({ roomName: call.roomName, deviceId: actor.deviceId,
      legId: transfer.attemptId, ttlSeconds: Math.min(90, Math.max(15, Math.ceil((transfer.expiresAt - this.now()) / 1000))) });
    await this.recheckActor(context, actor);
    const latest = await this.store.get(callStoreKey(callId));
    this.requireCall(latest, actor); this.requireActive(latest);
    requireValue(latest.transfer?.id === transfer.id && latest.transfer.status === 'connecting' &&
      latest.transfer.attemptId === transfer.attemptId && latest.transfer.expiresAt > this.now(),
      'TRANSFER_CHANGED', 'Transfer ended while the join token was being created.');
    requireValue(join.identity === transfer.targetIdentity, 'PROVIDER_IDENTITY_MISMATCH', 'The media join identity did not match the target leg.', 502);
    return { ...visible(latest), join, readinessNonce: transfer.readinessNonce };
  }

  async confirmReady(context, { callId, transferId, expectedVersion, readinessNonce, evidence, observedCall }) {
    const actor = await this.actor(context);
    await this.requireRollout(context, { callId, transferId }, actor);
    await this.expire(callId, observedCall);
    const snapshot = await this.store.get(callStoreKey(callId));
    this.requireCall(snapshot, actor);
    const transfer = this.requireTransfer(snapshot, transferId, actor, 'target');
    if (['completing', 'completed'].includes(transfer.status)) return { ...visible(snapshot, transfer), replayed: true };
    this.requireActive(snapshot); exactVersion(snapshot, expectedVersion);
    requireValue(transfer.toUserId === actor.userId, 'DEVICE_BINDING_CHANGED', 'The target device enrollment changed.', 403);
    requireValue(transfer.status === 'connecting' && transfer.expiresAt > this.now() &&
      transfer.readinessNonce === readinessNonce, 'READINESS_STALE', 'This readiness attempt is no longer current.');
    requireValue(typeof this.verifyReadiness === 'function', 'CLIENT_MEDIA_NOT_INTEGRATED',
      'The native room client and trusted bidirectional readiness path are not integrated.', 501);
    const observation = await this.provider.inspectParticipants({ roomName: snapshot.roomName,
      customerIdentity: snapshot.customerIdentity, operatorIdentity: transfer.targetIdentity,
      sourceIdentity: transfer.sourceIdentity });
    requireValue(observation.customerActive && observation.customerAudioPublished && observation.operatorActive &&
      observation.operatorAudioPublished && observation.sourceActive,
      'MEDIA_NOT_READY', 'The customer, source, and target audio participants are not all ready.');
    // This hook must verify actual client session/track/RTP evidence. A boolean
    // copied from the request body is not a production implementation.
    const proof = await this.verifyReadiness({ actor: copy(actor), call: copy(snapshot), transfer: copy(transfer),
      observation: copy(observation), providerObservation: observation, evidence });
    const now = this.now();
    requireValue(proof?.verified === true && proof.bidirectionalAudio === true && proof.callId === callId &&
      proof.transferId === transfer.id && proof.attemptId === transfer.attemptId && proof.deviceId === actor.deviceId &&
      proof.identity === transfer.targetIdentity && proof.readinessNonce === transfer.readinessNonce &&
      Number.isFinite(proof.observedAt) && proof.observedAt >= transfer.acceptedAt && proof.observedAt <= now &&
      now - proof.observedAt <= this.evidenceMaxAgeMs &&
      Number.isFinite(observation.observedAt) && observation.observedAt <= now && now - observation.observedAt <= this.evidenceMaxAgeMs,
      'MEDIA_NOT_VERIFIED', 'Fresh bidirectional audio evidence is required before the source can leave.');
    // Revocation during a slow provider/telemetry check must be observed before commit.
    await this.recheckActor(context, actor);
    return this.store.transaction(async tx => {
      const [call, destination, source] = await Promise.all([
        tx.get(callStoreKey(callId)), tx.get(deviceReservationKey(actor.deviceId)),
        tx.get(deviceReservationKey(transfer.fromDeviceId))
      ]);
      this.requireCall(call, actor); this.requireActive(call);
      const current = this.requireTransfer(call, transferId, actor, 'target');
      // Terminal events, cancellation, expiry or another commit during I/O win.
      exactVersion(call, snapshot.version);
      requireValue(current.status === 'connecting' && current.attemptId === transfer.attemptId &&
        current.readinessNonce === transfer.readinessNonce && current.expiresAt > this.now() &&
        this.now() - proof.observedAt <= this.evidenceMaxAgeMs &&
        this.now() - observation.observedAt <= this.evidenceMaxAgeMs &&
        current.toUserId === actor.userId && call.owner.deviceId === current.fromDeviceId &&
        matchReservation(destination, call, current.id) && destination.kind === 'invite' &&
        matchReservation(source, call) && source.kind === 'owner',
        'TRANSFER_CHANGED', 'Transfer changed while audio was being checked.');
      current.status = 'completing'; current.mediaReadyAt = now;
      call.owner = { deviceId: actor.deviceId, userId: actor.userId, legId: current.attemptId, identity: current.targetIdentity };
      call.version++; call.updatedAt = now;
      // Only source detachment follows this commit. Never terminate the customer.
      detachJob(call, current.sourceIdentity, current.id, now, current.fromDeviceId);
      // Do not advertise A as idle while its old room leg still exists.
      tx.set(deviceReservationKey(current.fromDeviceId), cleanupReservation(callId, current.sourceIdentity, current.id));
      tx.set(deviceReservationKey(actor.deviceId), { callId, kind: 'owner', transferId: current.id });
      tx.set(callStoreKey(callId), call);
      return visible(call);
    });
  }

  async stopTransfer(context, { callId, transferId, expectedVersion, action }) {
    requireValue(['cancel', 'decline'].includes(action), 'INVALID_INPUT', 'Invalid transfer action.', 400);
    const actor = await this.actor(context);
    // Cancellation remains available even if a rollout is disabled mid-call.
    return this.store.transaction(async tx => {
      const call = await tx.get(callStoreKey(callId));
      this.requireCall(call, actor);
      const transfer = this.requireTransfer(call, transferId, actor, action === 'decline' ? 'target' : 'source');
      const reservation = await tx.get(deviceReservationKey(transfer.toDeviceId));
      if (['cancelled', 'declined', 'expired', 'failed'].includes(transfer.status)) return { ...visible(call, transfer), replayed: true };
      exactVersion(call, expectedVersion);
      requireValue(PENDING.has(transfer.status), 'TRANSFER_ALREADY_COMMITTED', 'The handoff has already committed to its new owner.');
      transfer.status = action === 'decline' ? 'declined' : 'cancelled';
      transfer.reason = action; call.version++; call.updatedAt = this.now();
      detachJob(call, transfer.targetIdentity, transfer.id, this.now(), transfer.toDeviceId);
      if (matchReservation(reservation, call, transfer.id)) {
        if (transfer.targetIdentity) tx.set(deviceReservationKey(transfer.toDeviceId), cleanupReservation(callId, transfer.targetIdentity, transfer.id));
        else tx.delete(deviceReservationKey(transfer.toDeviceId));
      }
      tx.set(callStoreKey(callId), call);
      return visible(call, transfer);
    });
  }

  async expire(callId, observedCall) {
    // The calling runtime already read this record for exact ownership/binding.
    // Only a due mutation needs a transaction. Action transactions independently
    // recheck expiry/current invitation, so a stale snapshot grants no authority.
    const observed = observedCall === undefined ? await this.store.get(callStoreKey(callId)) : observedCall;
    if (!observed?.transfer || !PENDING.has(observed.transfer.status) || observed.transfer.expiresAt > this.now()) return false;
    return this.store.transaction(async tx => {
      const call = await tx.get(callStoreKey(callId));
      if (!call?.transfer || !PENDING.has(call.transfer.status) || call.transfer.expiresAt > this.now()) return false;
      const transfer = call.transfer;
      const reservation = await tx.get(deviceReservationKey(transfer.toDeviceId));
      transfer.status = 'expired'; transfer.reason = 'no_answer'; call.version++; call.updatedAt = this.now();
      detachJob(call, transfer.targetIdentity, transfer.id, this.now(), transfer.toDeviceId);
      if (matchReservation(reservation, call, transfer.id)) {
        if (transfer.targetIdentity) tx.set(deviceReservationKey(transfer.toDeviceId), cleanupReservation(callId, transfer.targetIdentity, transfer.id));
        else tx.delete(deviceReservationKey(transfer.toDeviceId));
      }
      tx.set(callStoreKey(callId), call);
      return true;
    });
  }

  async endByOperator(context, { callId, expectedVersion }) {
    const actor = await this.actor(context);
    return this.#endCall(callId, { actor, expectedVersion, reason: 'BUSINESS_INITIATED' });
  }

  async providerEnded(eventContext) {
    requireValue(typeof this.verifyProviderEvent === 'function', 'UNVERIFIED_WEBHOOK', 'Signed provider-event verification is required.', 401);
    const event = await this.verifyProviderEvent(eventContext);
    requireValue(event?.verified === true && event.type === 'terminated' && event.callId,
      'UNVERIFIED_WEBHOOK', 'A verified terminal provider event is required.', 401);
    return this.#endCall(event.callId, { reason: 'USER_INITIATED' });
  }

  async #endCall(callId, { actor, expectedVersion, reason }) {
    return this.store.transaction(async tx => {
      const call = await tx.get(callStoreKey(callId));
      this.requireCall(call, actor);
      if (actor) requireValue(call.owner.deviceId === actor.deviceId && call.owner.userId === actor.userId,
        'NOT_CALL_OWNER', 'Only the current owner may end the customer call.', 403);
      if (!call.active) {
        if (reason === 'USER_INITIATED' && !call.terminal?.confirmedAt) {
          call.status = 'ended'; call.terminal.confirmedAt = this.now(); call.version++;
          const disconnect = call.outbox.find(job => job.id === 'customer-disconnect');
          // A verified Meta terminate event needs connector cleanup only; don't
          // make a second unnecessary Graph terminate after the customer ended.
          if (disconnect?.status === 'pending') disconnect.reason = 'USER_INITIATED';
          tx.set(callStoreKey(callId), call);
        }
        return { ...visible(call), replayed: true };
      }
      if (actor) exactVersion(call, expectedVersion);
      const target = call.transfer?.toDeviceId;
      const ownerReservation = await tx.get(deviceReservationKey(call.owner.deviceId));
      const targetReservation = target && target !== call.owner.deviceId ? await tx.get(deviceReservationKey(target)) : null;
      const now = this.now();
      call.active = false; call.status = reason === 'USER_INITIATED' ? 'ended' : 'ending';
      call.terminal = { reason, endedAt: now, ...(reason === 'USER_INITIATED' ? { confirmedAt: now } : {}) };
      call.version++; call.updatedAt = now;
      if (call.transfer && ['invited', 'connecting', 'completing'].includes(call.transfer.status)) {
        call.transfer.status = 'cancelled'; call.transfer.reason = 'call_ended';
      }
      addJob(call, { id: 'customer-disconnect', kind: 'terminate', callId, reason });
      detachJob(call, call.owner.identity, '', now, call.owner.deviceId);
      detachJob(call, call.transfer?.targetIdentity, call.transfer?.id, now, target);
      detachJob(call, call.transfer?.sourceIdentity, call.transfer?.id, now, call.transfer?.fromDeviceId);
      if (matchReservation(ownerReservation, call))
        tx.set(deviceReservationKey(call.owner.deviceId), cleanupReservation(callId, call.owner.identity));
      if (target && matchReservation(targetReservation, call, call.transfer?.id)) {
        if (call.transfer?.targetIdentity)
          tx.set(deviceReservationKey(target), cleanupReservation(callId, call.transfer.targetIdentity, call.transfer.id));
        else tx.delete(deviceReservationKey(target));
      }
      tx.set(callStoreKey(callId), call);
      return visible(call);
    });
  }

  /** Internal worker, not an unauthenticated route. Leases survive process restarts. */
  async drainOutbox(callId, { limit = 8 } = {}) {
    requireValue(Number.isInteger(limit) && limit > 0 && limit <= 32, 'INVALID_INPUT', 'Invalid cleanup batch size.', 400);
    const results = [];
    for (let i = 0; i < limit; i++) {
      const leaseId = randomUUID();
      const job = await this.store.transaction(async tx => {
        const call = await tx.get(callStoreKey(callId));
        if (!call) return null;
        const now = this.now();
        const eligible = item => (item.status === 'pending' && item.notBefore <= now) ||
          (item.status === 'running' && item.leaseUntil <= now);
        // Customer end has priority over a failing source-detach retry.
        const pending = call.outbox.find(item => item.kind === 'terminate' && eligible(item)) || call.outbox.find(eligible);
        if (!pending) return null;
        Object.assign(pending, { status: 'running', leaseId, leaseUntil: now + 45000, attempts: pending.attempts + 1 });
        tx.set(callStoreKey(callId), call);
        return copy(pending);
      });
      if (!job) break;
      let succeeded = false;
      try {
        if (job.kind === 'detach') await this.provider.detachOperator(job);
        else if (job.kind === 'terminate') await this.provider.terminateCustomer(job);
        else fail('INVALID_CLEANUP_JOB', 'Unknown cleanup operation.');
        succeeded = true;
      } catch { /* Persist retry state, without leaking provider credentials/errors. */ }
      await this.store.transaction(async tx => {
        const call = await tx.get(callStoreKey(callId));
        const current = call?.outbox.find(item => item.id === job.id);
        if (!current || current.leaseId !== leaseId) return;
        const reservation = job.kind === 'detach' && job.deviceId ? await tx.get(deviceReservationKey(job.deviceId)) : null;
        current.status = succeeded ? 'done' : 'pending';
        current.notBefore = this.now() + Math.min(30000, 1000 * 2 ** Math.min(current.attempts, 5));
        delete current.leaseId; delete current.leaseUntil;
        if (succeeded && job.kind === 'terminate' && !call.active && !call.terminal?.confirmedAt) {
          call.status = 'ended'; call.terminal.confirmedAt = this.now(); call.version++;
        }
        if (succeeded && job.kind === 'detach' && call.active && call.transfer?.id === job.transferId &&
          call.transfer.status === 'completing' && call.transfer.sourceIdentity === job.identity) {
          call.transfer.status = 'completed'; call.transfer.completedAt = this.now(); call.version++;
        }
        if (succeeded && reservation?.kind === 'cleanup' && matchReservation(reservation, call) && reservation.identity === job.identity)
          tx.delete(deviceReservationKey(job.deviceId));
        tx.set(callStoreKey(callId), call);
      });
      results.push({ jobId: job.id, succeeded });
    }
    return results;
  }
}
