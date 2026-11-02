import { MediaError, requireValue } from '../media/errors.mjs';
import { callStoreKey } from '../media/transfer-controller.mjs';
import { CallAudioManager } from '../media/call-audio-manager.mjs';
import { customerOnHold } from '../media/attended-transfer.mjs';

export class CallTools {
  constructor({ runtime, files, audio }) {
    this.runtime = runtime; this.files = files;
    this.recovering = new Map();
    this.audio = audio || new CallAudioManager({ provider: runtime.provider, files, onHoldFailure: id => this.recoverHold(id) });
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
    return { notes, recordings, recording: this.audio.state(authorized.id) };
  }
  async note(context, id, body) {
    const authorized = await this.authorize(context, id);
    const notes = await this.files.saveNote(authorized.id, authorized.actor, body);
    return { notes };
  }
  async recording(context, id, action, body) {
    const authorized = await this.authorize(context, id, true);
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
    if (customerOnHold(call) && !this.audio.healthyHold(call.id)) void this.recoverHold(call.id).catch(() => {});
    return this.audio.state(call?.id);
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
  mount(app) {
    const prefix = '/api/operator-android';
    const wrap = operation => async (req, res) => {
      try {
        res.set('Cache-Control', 'no-store');
        requireValue(JSON.stringify(req.body || {}).length <= 18000, 'INVALID_INPUT', 'Call notes are too large.', 400);
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
    app.get(`${prefix}/calls/:callId/records`, wrap(req => this.records(req, req.params.callId)));
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
