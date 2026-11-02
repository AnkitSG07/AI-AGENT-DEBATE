import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AccessToken, TrackSource } from 'livekit-server-sdk';
import { requireValue } from './errors.mjs';
import { customerOnHold } from './attended-transfer.mjs';
import { callMediaIdentity } from './livekit-provider.mjs';

/** Optional recording/hold media runs in a separate process. Neither native
 * codec failure nor Odoo archival is on the normal call control path. */
export class CallAudioManager {
  constructor({ provider, files, now = Date.now, spawn = fork, maximum = 2, onHoldFailure = () => {} }) {
    Object.assign(this, { provider, files, now, spawn, maximum, onHoldFailure });
    this.calls = new Map();
    this.starts = new Map();
  }
  state(id) {
    const row = this.calls.get(id);
    return { state: row?.recordState || 'idle', id: row?.recordingId || '', startedAt: row?.startedAt || 0,
      savedParts: row?.savedParts || 0, holdReady: !!row?.ready && !!row?.hold,
      error: row?.recordError || '' };
  }
  async ensure(call) {
    let row = this.calls.get(call.id);
    requireValue(!row?.stopping || !row.child && !row.initializing, 'CALL_AUDIO_BUSY', 'The previous recording is still closing.', 503);
    if (row && (row.child || row.initializing) && !row.stopping) { await row.started; return row; }
    requireValue(!row?.pending && row?.recordState !== 'saving', 'CALL_AUDIO_BUSY', 'The previous recording is still saving.', 503);
    requireValue([...this.calls.values()].filter(value => value.child || value.initializing).length < this.maximum,
      'CALL_AUDIO_BUSY', 'Recording and hold audio are busy. Your call is still connected.', 503);
    row = { id: call.id, recordState: 'idle', savedParts: 0, ready: false, hold: false, initializing: true, queue: Promise.resolve(), pending: 0 };
    this.calls.set(call.id, row);
    row.started = Promise.resolve().then(() => this.connect(call, row)).finally(() => { row.initializing = false; });
    row.started.catch(() => {});
    await row.started;
    return row;
  }
  async connect(call, row) {
    const token = new AccessToken(this.provider.config.apiKey, this.provider.config.apiSecret,
      { identity: callMediaIdentity(call.roomName), ttl: 120 });
    token.addGrant({ roomJoin: true, room: call.roomName, canPublish: true, canSubscribe: true,
      canPublishSources: [TrackSource.MICROPHONE], canPublishData: false });
    const jwt = await token.toJwt();
    requireValue(!row.stopping, 'CALL_AUDIO_CLOSED', 'The call audio task was cancelled.', 409);
    const child = this.spawn(fileURLToPath(new URL('./call-audio-worker.mjs', import.meta.url)), [],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced',
        // No account credentials are passed to the codec process; only its short room grant.
        env: { PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
          SH_AUDIO_WORKER: '1' }, execArgv: ['--max-old-space-size=96'] });
    row.child = child;
    const connected = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error('Audio worker did not connect.')); }, 12000);
      child.on('message', message => {
        if (message?.type === 'ready') { clearTimeout(timeout); row.ready = true; resolve(row); }
        else if (message?.type === 'part' && message.recordingId === row.recordingId && Buffer.isBuffer(message.pcm)) {
          if (row.pending >= 4 || message.pcm.length > 960000 || !Number.isSafeInteger(message.index) || message.index < 0) {
            this.fail(row, 'Recording storage is slow. Saved audio is available.'); return;
          }
          row.pending++;
          const recordingId = row.recordingId;
          row.queue = row.queue.then(async () => {
            for (let attempt = 0; attempt < 3; attempt++) {
              try { await this.files.savePart(call.id, recordingId, message.index, message.pcm); row.savedParts++; return; }
              catch { if (attempt === 2) throw new Error('archive'); await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); }
            }
          }).catch(() => this.fail(row, 'A recording part could not be saved. Your call is unaffected.'))
            .finally(() => { row.pending--; });
        } else if (message?.type === 'prepared') { row.prepared = true; row.preparedResolve?.(); }
        else if (message?.type === 'recording' && row.recordState === 'starting') row.recordState = 'recording';
        else if (message?.type === 'stopped') {
          row.recordState = row.recordState === 'failed' ? 'failed' : 'saving';
          void row.queue.finally(() => { if (row.recordState === 'saving') row.recordState = 'saved'; });
        } else if (message?.type === 'hold') row.hold = message.active === true;
        else if (message?.type === 'error') {
          this.fail(row, 'Recording or hold audio is unavailable. Your call is still connected.');
          this.holdFailed(row);
          row.preparedReject?.(new Error('Hold audio unavailable.'));
        }
      });
      child.once('error', () => { clearTimeout(timeout); reject(new Error('Audio worker could not start.')); });
      child.once('exit', () => {
        clearTimeout(timeout); row.ready = false; row.child = null;
        if (['starting', 'recording'].includes(row.recordState)) this.fail(row, 'Recording stopped. Previously saved audio is available.');
        this.holdFailed(row);
        row.preparedReject?.(new Error('Hold audio stopped.'));
        reject(new Error('Audio worker stopped.'));
      });
    });
    connected.catch(() => {});
    this.send(row, { type: 'connect', url: this.provider.config.wsUrl, token: jwt, customer: call.customerIdentity,
      owner: call.owner.identity, operators: [call.owner.identity], hold: false });
    await connected;
    return row;
  }
  send(row, message) { if (row?.child?.connected) row.child.send(message, error => { if (error) row.ready = false; }); }
  fail(row, error) {
    row.recordState = 'failed'; row.recordError = error;
    this.send(row, { type: 'stop-record' });
  }
  holdFailed(row) {
    if (row.stopping || !row.holdExpected) return;
    row.holdFailed = true;
    try { Promise.resolve(this.onHoldFailure(row.id)).catch(() => {}); } catch { /* next status retries recovery */ }
  }
  healthyHold(id) {
    const row = this.calls.get(id);
    return !!row && !row.stopping && !row.holdFailed && !!row.child && row.ready && row.prepared;
  }
  async start(call, actor, requestId) {
    const claim = this.starts.get(call.id);
    if (claim) {
      requireValue(claim.requestId === requestId, 'RECORDING_ACTIVE', 'This call is already starting a recording.');
      return claim.promise;
    }
    const promise = Promise.resolve().then(() => this.startOnce(call, actor, requestId));
    this.starts.set(call.id, { requestId, promise });
    try { return await promise; } finally { if (this.starts.get(call.id)?.promise === promise) this.starts.delete(call.id); }
  }
  async startOnce(call, actor, requestId) {
    const existing = this.calls.get(call.id);
    if (existing && existing.requestId === requestId) return this.state(call.id);
    requireValue(!existing || !['starting', 'recording', 'saving'].includes(existing.recordState),
      'RECORDING_ACTIVE', 'This call is already being recorded.');
    const row = await this.ensure(call);
    row.recordingId = `rec_${randomUUID()}`; row.requestId = requestId;
    row.recordState = 'starting'; row.startedAt = this.now(); row.savedParts = 0; row.recordError = '';
    try {
      await this.files.beginRecording(call.id, row.recordingId, { startedAt: row.startedAt, deviceId: actor.deviceId });
      if (!row.stopping && row.recordState === 'starting') this.send(row, { type: 'record', recordingId: row.recordingId });
    } catch { this.fail(row, 'Recording could not be saved to Odoo. Your call is still connected.'); }
    return this.state(call.id);
  }
  stop(id) {
    const row = this.calls.get(id);
    if (row && ['starting', 'recording'].includes(row.recordState)) { row.recordState = 'saving'; this.send(row, { type: 'stop-record' }); }
    return this.state(id);
  }
  async prepareHold(call) {
    const row = await this.ensure(call);
    row.preparingUntil = this.now() + 20000;
    if (!row.prepared) {
      if (!row.preparing) row.preparing = new Promise((resolve, reject) => {
          row.preparedResolve = resolve;
          row.preparedReject = reject;
          row.preparedTimer = setTimeout(() => reject(new Error('Hold audio unavailable.')), 8000);
          this.send(row, { type: 'prepare-hold', customer: call.customerIdentity, operators: [call.owner.identity], hold: false });
        }).finally(() => { clearTimeout(row.preparedTimer); row.preparedResolve = null; row.preparedReject = null; row.preparing = null; });
      await row.preparing;
    }
    return row;
  }
  async hold(call) {
    const row = await this.ensure(call);
    this.sync(call);
    return row;
  }
  sync(call) {
    const row = this.calls.get(call?.id);
    if (!row?.child) return;
    if (!call.active) { this.close(call.id); return; }
    if (row.initializing || !row.ready) return;
    const hold = customerOnHold(call), transfer = call.transfer;
    row.holdExpected = hold;
    const operators = hold ? [] : [...new Set([call.owner.identity,
      ...(transfer?.consultStage === 'merged' || transfer?.consultStage === 'conference' ? [transfer.targetIdentity] : [])].filter(Boolean))];
    const message = { type: 'state', hold, customer: call.customerIdentity, operators };
    const signature = JSON.stringify(message);
    if (signature !== row.signature) { row.signature = signature; this.send(row, message); }
    // Idle media workers are closed without touching call ownership or the customer.
    if (!hold && (row.preparingUntil || 0) < this.now() && !['starting', 'recording', 'saving'].includes(row.recordState)) this.close(call.id);
  }
  close(id) {
    const row = this.calls.get(id);
    if (!row || row.stopping) return;
    row.stopping = true;
    if (!row.child) return;
    this.send(row, { type: 'close' });
    const child = row.child;
    setTimeout(() => { if (row.child === child) child.kill(); }, 4000).unref?.();
    // Keep bounded status metadata, never an unbounded completed-call cache.
    if (this.calls.size > 100) for (const [key, item] of this.calls) {
      if (!item.child && key !== id) { this.calls.delete(key); if (this.calls.size <= 100) break; }
    }
  }
}
