import { TransferController, callStoreKey, deviceReservationKey, transferDeadline } from './transfer-controller.mjs';
import { requireValue } from './errors.mjs';
import { readTransactionRecords } from './transaction-reads.mjs';

export const isConsultation = transfer => transfer?.mode === 'consult' &&
  ['invited', 'connecting'].includes(transfer.status);
export const customerOnHold = call => !!call?.active && isConsultation(call.transfer) &&
  !['customer', 'conference', 'merged'].includes(call.transfer.consultStage);

/** The established direct transfer keeps its original readiness/cleanup path.
 * A consultation adds an explicit source decision before that ownership commit. */
export class AttendedTransferController extends TransferController {
  async invite(context, args) {
    requireValue(args.mode === undefined || ['instant', 'consult'].includes(args.mode),
      'INVALID_TRANSFER_MODE', 'Choose instant transfer or transfer with message.', 400);
    if (args.mode === 'consult') {
      const [actor, target] = await Promise.all([this.actor(context), this.resolveDevice(args.toDeviceId)]);
      requireValue(actor.nativeBuild >= 22 && target?.nativeBuild >= 22,
        'HANDOVER_UPDATE_REQUIRED', 'Update both phones to R22 before a private handover.', 426);
    }
    return super.invite(context, args);
  }

  async expire(callId, observedCall) {
    const call = observedCall === undefined ? await this.store.get(callStoreKey(callId)) : observedCall;
    // A merged conference lasts for the call, not the invitation timer.
    if (isConsultation(call?.transfer) && call.transfer.consultStage === 'merged') return false;
    return super.expire(callId, call);
  }

  async decide(context, { callId, transferId, expectedVersion, action }) {
    requireValue(['complete', 'merge'].includes(action), 'INVALID_TRANSFER_ACTION', 'Invalid handover action.', 400);
    const actor = await this.actor(context);
    await this.requireRollout(context, { callId, transferId }, actor);
    return this.store.transaction(async tx => {
      const call = await tx.get(callStoreKey(callId));
      this.requireCall(call, actor); this.requireActive(call);
      const transfer = this.requireTransfer(call, transferId, actor, 'source');
      const next = action === 'complete' ? 'customer' : 'conference';
      if (isConsultation(transfer) && transfer.consultStage === next) return { replayed: true };
      requireValue(call.version === expectedVersion && Number.isSafeInteger(expectedVersion),
        'STALE_CALL_VERSION', 'Call state changed. Try the action again.');
      requireValue(call.owner.deviceId === actor.deviceId && call.owner.identity === transfer.sourceIdentity &&
        isConsultation(transfer) && transfer.consultReadyAt &&
        (transfer.consultStage === 'private' || action === 'complete' && transfer.consultStage === 'merged') &&
        (transfer.consultStage === 'merged' || transferDeadline(transfer) > this.now()),
        'HANDOVER_NOT_READY', 'Wait for the other operator to join the handover.');
      transfer.consultStage = next;
      transfer.consultDeadlineAt = this.now() + 60000;
      transfer.decisionAt = this.now();
      call.version++; call.updatedAt = this.now();
      tx.set(callStoreKey(callId), call);
      return { decided: true };
    });
  }

  async confirmReady(context, args) {
    const snapshot = await this.store.get(callStoreKey(args.callId));
    const transfer = snapshot?.transfer;
    if (!isConsultation(transfer) || transfer.id !== args.transferId || transfer.consultStage === 'customer')
      return super.confirmReady(context, args);
    const actor = await this.actor(context);
    await this.requireRollout(context, args, actor);
    this.requireCall(snapshot, actor); this.requireActive(snapshot);
    this.requireTransfer(snapshot, args.transferId, actor, 'target');
    if (transfer.consultReadyAt && ['private', 'merged'].includes(transfer.consultStage)) return { replayed: true };
    requireValue(snapshot.version === args.expectedVersion && transfer.status === 'connecting' &&
      transferDeadline(transfer) > this.now() && transfer.toUserId === actor.userId &&
      args.readinessNonce === transfer.readinessNonce, 'READINESS_STALE', 'This handover readiness is no longer current.');
    const conference = transfer.consultStage === 'conference';
    // In private mode the target must actually receive the source operator,
    // not merely join the room or receive the held customer's microphone.
    const peerCall = { ...snapshot, customerIdentity: conference ? snapshot.customerIdentity : transfer.sourceIdentity };
    const observation = await this.provider.inspectParticipants({ roomName: snapshot.roomName,
      customerIdentity: peerCall.customerIdentity, operatorIdentity: transfer.targetIdentity,
      sourceIdentity: transfer.sourceIdentity });
    requireValue(observation.customerActive && observation.customerAudioPublished && observation.operatorActive &&
      observation.operatorAudioPublished && observation.sourceActive, 'MEDIA_NOT_READY', 'The handover audio is not ready.');
    const proof = await this.verifyReadiness({ actor, call: peerCall, transfer,
      observation: structuredClone(observation), providerObservation: observation, evidence: args.evidence });
    const now = this.now();
    requireValue(proof?.verified && proof.bidirectionalAudio && proof.callId === snapshot.id &&
      proof.transferId === transfer.id && proof.attemptId === transfer.attemptId && proof.deviceId === actor.deviceId &&
      proof.identity === transfer.targetIdentity && proof.readinessNonce === transfer.readinessNonce &&
      proof.observedAt >= transfer.acceptedAt && proof.observedAt <= now && now - proof.observedAt <= this.evidenceMaxAgeMs,
      'MEDIA_NOT_VERIFIED', 'Fresh audio evidence is required for this handover.');
    await this.recheckActor(context, actor);
    return this.store.transaction(async tx => {
      const [call, source, target] = await readTransactionRecords(tx,
        [callStoreKey(args.callId), deviceReservationKey(transfer.fromDeviceId), deviceReservationKey(actor.deviceId)]);
      this.requireCall(call, actor); this.requireActive(call);
      const current = this.requireTransfer(call, args.transferId, actor, 'target');
      requireValue(call.version === snapshot.version && current.status === 'connecting' &&
        current.attemptId === transfer.attemptId && current.readinessNonce === args.readinessNonce &&
        transferDeadline(current) > this.now() && this.now() - proof.observedAt <= this.evidenceMaxAgeMs &&
        source?.callId === call.id && source.kind === 'owner' && call.owner.deviceId === current.fromDeviceId &&
        target?.callId === call.id && target.transferId === current.id && target.kind === 'invite',
        'TRANSFER_CHANGED', 'The handover changed while checking audio.');
      current.consultStage = conference ? 'merged' : 'private';
      current.consultReadyAt = now;
      current.consultDeadlineAt = conference ? Number.MAX_SAFE_INTEGER : now + 10 * 60 * 1000;
      call.version++; call.updatedAt = now;
      tx.set(callStoreKey(call.id), call);
      return { consultationReady: true, merged: conference };
    });
  }
}
