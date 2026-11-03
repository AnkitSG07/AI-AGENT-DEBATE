import { MediaError, requireValue } from '../media/errors.mjs';
import { callStoreKey } from '../media/transfer-controller.mjs';
import { CallAudioManager } from '../media/call-audio-manager.mjs';
import { customerOnHold } from '../media/attended-transfer.mjs';
import { DeviceRecording } from './device-recording.mjs';
import { MediaUsage } from './media-usage.mjs';
import { VideoLinks } from './video-links.mjs';

export class CallTools {
  constructor({ runtime, files, audio, env }) {
    this.runtime = runtime; this.files = files;
    this.recovering = new Map();
    this.customerUsage = new Map();
    this.usage = new MediaUsage({ files, project: runtime.provider?.config?.wsUrl, now: runtime.now });
    this.audio = audio || new CallAudioManager({ provider: runtime.provider, files, onHoldFailure: id => this.recoverHold(id),
      onUsage: (id, data) => this.usage.record(`worker:${id}`, data, 'worker') });
    this.deviceRecording = new DeviceRecording({ runtime, files });
    this.video = new VideoLinks({ authorize: context => runtime.actor(context, { media: false }), env, now: runtime.now });
  }
  participant(actor, session) {
    return session.owner?.deviceId === actor.deviceId || !!session.bindings?.[actor.deviceId] ||
      Object.values(session.transferBindings || {}).some(binding => binding.deviceId === actor.deviceId);
  }
  async authorize(context, id, write = false) {
    const [actor, session] = await this.runtime.authenticatedSession(context, id, { media: false });
    this.runtime.requireSession(session);
    requireValue(this.participant(actor, session), 'CALL_RECORD_FORBIDDEN', 'This call record belongs to its participating operators.', 403);
    const call = session.providerCallId ? await this.runtime.store.get(callStoreKey(session.providerCallId)) : null;
    if (write) requireValue(call?.active && call.owner.deviceId === actor.deviceId && actor.nativeBuild >= 22 && !session.terminal,
      'CALL_OWNER_REQUIRED', 'The current operator on R22 can control recording.', 403);
    return { actor, session, call, id: session.providerCallId || session.id };
  }
  async records(context, id) {
    const authorized = await this.authorize(context, id);
    const [notes, recordings] = await Promise.all([this.files.notes(authorized.id), this.files.recordings(authorized.id)]);
    return { notes, recordings, recording: this.deviceRecording.state(authorized.call) || this.audio.state(authorized.id) };
  }
  async note(context, id, body) {
    const authorized = await this.authorize(context, id);
    const notes = await this.files.saveNote(authorized.id, authorized.actor, body);
    return { notes };
  }
  async recording(context, id, action, body) {
    const authorized = await this.authorize(context, id, true);
    if (body.mode === 'device' || authorized.call.deviceRecording?.active) {
      requireValue(!['starting', 'recording', 'saving'].includes(this.audio.state(authorized.id).state),
        'RECORDING_ACTIVE', 'Stop the existing server recording first.', 409);
      return { recording: await this.deviceRecording.change(authorized, action, body) };
    }
    if (action === 'stop') return { recording: this.audio.stop(authorized.id) };
    requireValue(typeof body.requestId === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(body.requestId),
      'INVALID_REQUEST_ID', 'A recording request identity is required.', 400);
    requireValue(!authorized.call.transfer || authorized.call.transfer.mode !== 'consult' ||
      !['invited', 'connecting'].includes(authorized.call.transfer.status) || authorized.call.transfer.consultStage === 'merged',
      'HANDOVER_IN_PROGRESS', 'Start recording before or after the private handover.');
    const recording = await this.audio.start(authorized.call, authorized.actor, body.requestId);
    let current;
    try {
      const refreshed = await this.authorize(context, id, true);
      current = refreshed.call;
      this.audio.sync(current);
    } catch (error) { this.audio.close(authorized.id); throw error; }
    return { recording: current?.active ? recording : this.audio.state(authorized.id) };
  }
  async recent(context) {
    const actor = await this.runtime.actor(context, { media: false });
    const rows = await this.files.recent();
    const records = [];
    for (const row of rows) {
      const session = await this.runtime.locate(row.callId);
      if (session?.tenantId === actor.tenantId && this.participant(actor, session)) records.push({ ...row,
        customerName: session.customerName || '', customerPhone: session.customerPhone || '' });
    }
    return { records };
  }
  view(call) {
    this.audio.sync(call);
    this.observeCustomerUsage(call);
    if (customerOnHold(call) && !this.audio.healthyHold(call.id)) void this.recoverHold(call.id).catch(() => {});
    return this.deviceRecording.state(call) || this.audio.state(call?.id);
  }
  observeCustomerUsage(call) {
    if (!Number.isSafeInteger(call?.createdAt) || !call?.customerIdentity) return;
    const now = this.runtime.now(), end = call.terminal?.endedAt || now;
    const prior = this.customerUsage.get(call.id);
    if (prior?.pending) { if (!call.active) prior.final = call; return; }
    if (prior?.complete || prior && call.active && now - prior.at < 60000) return;
    const row = { at: now, pending: true, complete: false }; this.customerUsage.set(call.id, row);
    // Canonical creation follows the customer join; this is a lower-bound
    // connector estimate. Accounting is never awaited by call control.
    void Promise.resolve().then(() => this.usage.record(`customer:${call.id}`,
      { startedAt: call.createdAt, durationMs: Math.max(0, end - call.createdAt) }, 'customer-estimate'))
      .then(() => { row.complete = !call.active; }).catch(() => { row.at = now - 45000; })
      .finally(() => { row.pending = false; if (row.final) this.observeCustomerUsage(row.final); });
    if (this.customerUsage.size > 200) for (const [id, item] of this.customerUsage) {
      if (item.complete) this.customerUsage.delete(id);
      if (this.customerUsage.size <= 100) break;
    }
  }
  async recoverHold(id) {
    if (this.recovering.has(id)) return this.recovering.get(id);
    const work = Promise.resolve().then(async () => {
      const call = await this.runtime.store.get(callStoreKey(id));
      if (!customerOnHold(call) || this.audio.healthyHold(id)) return;
      if (await this.runtime.transferController.abortConsultation(id, call.transfer.id)) {
        const session = await this.runtime.locate(id);
        if (session) this.runtime.signalWork(session.id);
        this.audio.close(id);
      }
    });
    this.recovering.set(id, work);
    try { return await work; } finally { if (this.recovering.get(id) === work) this.recovering.delete(id); }
  }
  async prepareHandover(call) { return this.audio.prepareHold(call); }
  async warmHandover(context, id) {
    const { call } = await this.authorize(context, id, true);
    requireValue(!customerOnHold(call), 'HANDOVER_IN_PROGRESS', 'This call is already in a private handover.', 409);
    await this.runtime.requireEnabled({ transfer: true });
    await this.audio.prepareHold(call);
    // This endpoint never changes call routing or ownership. The invitation
    // still checks both enrollments and hold readiness at its commit boundary.
    const current = await this.runtime.store.get(callStoreKey(call.id));
    if (!current?.active) this.audio.close(call.id);
    return { prepared: !!current?.active && this.audio.healthyHold(call.id) };
  }
  mount(app) {
    this.video.mount(app);
    const prefix = '/api/operator-android';
    const wrap = (operation, limit = 18000) => async (req, res) => {
      try {
        res.set('Cache-Control', 'no-store');
        requireValue(JSON.stringify(req.body || {}).length <= limit, 'INVALID_INPUT', 'Call data is too large.', 400);
        const result = await operation(req, res);
        if (!res.headersSent) res.json({ ok: true, ...result });
      } catch (error) {
        if (res.headersSent) { res.end(); return; }
        res.status(error instanceof MediaError ? error.statusCode : 503).json({ ok: false,
          code: error instanceof MediaError ? error.code : 'CALL_RECORD_UNAVAILABLE',
          error: error instanceof MediaError ? error.message : 'Call notes or recording storage is temporarily unavailable. Your call is still connected.' });
      }
    };
    app.get(`${prefix}/call-records`, wrap(req => this.recent(req)));
    app.get(`${prefix}/media-usage`, wrap(async req => {
      await this.runtime.actor(req, { media: false }); return { usage: await this.usage.summary() };
    }));
    app.post(`${prefix}/calls/:callId/media-usage`, wrap(async req => {
      const authorized = await this.authorize(req, req.params.callId);
      const body = req.body || {};
      requireValue(typeof body.connectionId === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(body.connectionId),
        'INVALID_MEDIA_USAGE', 'Invalid media connection identity.', 400);
      return this.usage.record(`phone:${authorized.id}:${authorized.actor.deviceId}:${body.connectionId}`, body);
    }));
    app.get(`${prefix}/calls/:callId/records`, wrap(req => this.records(req, req.params.callId)));
    app.post(`${prefix}/calls/:callId/prepare-handover`, wrap(req => this.warmHandover(req, req.params.callId)));
    app.post(`${prefix}/calls/:callId/recordings/:recordingId/parts`, wrap(async req => {
      const authorized = await this.authorize(req, req.params.callId);
      return this.deviceRecording.upload(authorized, req.params.recordingId, req.body || {});
    }, 430000));
    app.post(`${prefix}/calls/:callId/notes`, wrap(req => this.note(req, req.params.callId, req.body || {})));
    for (const action of ['start', 'stop']) app.post(`${prefix}/calls/:callId/recording/${action}`,
      wrap(req => this.recording(req, req.params.callId, action, req.body || {})));
    app.get(`${prefix}/calls/:callId/recordings/:recordingId/:partId`, wrap(async (req, res) => {
      const authorized = await this.authorize(req, req.params.callId);
      const bytes = await this.files.audio(authorized.id, req.params.recordingId, Number(req.params.partId));
      res.set('Content-Type', 'audio/wav'); res.set('X-Content-Type-Options', 'nosniff');
      res.set('Accept-Ranges', 'bytes');
      const range = String(req.headers.range || '');
      if (range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(range);
        const start = match ? Number(match[1]) : -1;
        const end = match && match[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
        if (start < 0 || start > end || start >= bytes.length) { res.set('Content-Range', `bytes */${bytes.length}`); res.status(416).end(); return; }
        res.set('Content-Range', `bytes ${start}-${end}/${bytes.length}`); res.status(206).send(bytes.subarray(start, end + 1));
      } else res.send(bytes);
    }));
  }
}
