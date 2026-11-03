import { createHash } from 'node:crypto';
import { requireValue } from '../media/errors.mjs';
import { callStoreKey } from '../media/transfer-controller.mjs';
import { customerOnHold } from '../media/attended-transfer.mjs';

const digest = value => createHash('sha256').update(String(value)).digest('hex');

/** Recording intent travels with the existing canonical call. Audio stays on
 * the enrolled handset until an authenticated background upload reaches Odoo.
 * No media worker, token, participant or extra status read is created here. */
export class DeviceRecording {
  constructor({ runtime, files }) { this.runtime = runtime; this.files = files; }
  state(call) {
    const r = call?.deviceRecording;
    if (!r) return null;
    return { mode: 'device', id: r.id, startedAt: r.startedAt,
      active: !!call.active && r.active === true,
      state: !call.active || !r.active ? 'saved' : 'recording',
      ownerDeviceId: call.owner.deviceId, ownerLegId: call.owner.legId,
      paused: customerOnHold(call), error: '', uploadPending: true };
  }
  async change({ actor, call, id }, action, body) {
    requireValue(actor.nativeBuild >= 24, 'DEVICE_RECORDING_UPDATE_REQUIRED', 'Install SH Chat R24 to record on this phone.', 409);
    const requestId = body.requestId;
    requireValue(typeof requestId === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(requestId),
      'INVALID_REQUEST_ID', 'A stable recording request is required.', 400);
    const recordingId = `rec_${digest(`${id}:${actor.deviceId}:${requestId}`).slice(0, 40)}`;
    // An Odoo failure may delay Record, never Answer, End or customer audio.
    if (action === 'start') {
      requireValue(!call.deviceRecording?.active || call.deviceRecording.id === recordingId,
        'RECORDING_ACTIVE', 'This call is already being recorded.', 409);
      await this.files.beginRecording(id, recordingId,
        { mode: 'device', startedAt: this.runtime.now(), deviceId: actor.deviceId });
    }
    const changed = await this.runtime.store.transaction(async tx => {
      const current = await tx.get(callStoreKey(id));
      requireValue(current?.active && current.owner.deviceId === actor.deviceId && current.owner.legId === call.owner.legId,
        'CALL_OWNER_REQUIRED', 'Recording ownership changed. Reopen the current call.', 409);
      if (action === 'start') {
        if (current.deviceRecording?.id === recordingId) return current;
        requireValue(!current.deviceRecording?.active, 'RECORDING_ACTIVE', 'This call is already being recorded.', 409);
        current.deviceRecording = { id: recordingId, active: true, startedAt: this.runtime.now(), requestId };
      } else {
        requireValue(current.deviceRecording && body.recordingId === current.deviceRecording.id,
          'RECORDING_CHANGED', 'This recording has changed. Refresh the call.', 409);
        if (!current.deviceRecording.active) return current;
        current.deviceRecording.active = false; current.deviceRecording.stoppedAt = this.runtime.now();
      }
      current.version++; current.updatedAt = this.runtime.now(); tx.set(callStoreKey(id), current);
      return current;
    });
    // Hints only wake the existing authoritative status path.
    void Promise.resolve().then(() => this.runtime.provider.signalControlState?.({ roomName: changed.roomName,
      identities: [changed.owner.identity, changed.transfer?.targetIdentity].filter(Boolean) })).catch(() => {});
    return this.state(changed);
  }
  async upload(authorized, recordingId, body) {
    requireValue(authorized.actor.nativeBuild >= 24 && /^[a-zA-Z0-9_-]{8,100}$/.test(recordingId),
      'INVALID_RECORDING', 'Invalid recording identity.', 400);
    const { segmentId, index, capturedAt, pcm } = body;
    requireValue(typeof segmentId === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(segmentId) &&
      Number.isSafeInteger(index) && index >= 0 && index <= 14400 &&
      Number.isSafeInteger(capturedAt) && capturedAt > 0 && capturedAt <= this.runtime.now() + 120000 &&
      capturedAt >= this.runtime.now() - 8 * 86400000 &&
      typeof pcm === 'string' && pcm.length > 0 && pcm.length <= 427000 && /^[A-Za-z0-9+/]+={0,2}$/.test(pcm),
      'INVALID_RECORDING_PART', 'Invalid recording segment.', 400);
    const bytes = Buffer.from(pcm, 'base64');
    requireValue(bytes.length <= 320000 && bytes.length % 2 === 0 && bytes.toString('base64') === pcm,
      'INVALID_RECORDING_PART', 'Invalid recording audio.', 400);
    const manifest = await this.files.recordingMetadata(authorized.id, recordingId);
    requireValue(manifest?.mode === 'device' && capturedAt >= manifest.startedAt - 120000,
      'RECORDING_NOT_FOUND', 'Device recording not found.', 404);
    await this.files.saveDevicePart(authorized.id, recordingId, authorized.actor.deviceId,
      { segmentId, index, capturedAt }, bytes);
    return { saved: true };
  }
}
