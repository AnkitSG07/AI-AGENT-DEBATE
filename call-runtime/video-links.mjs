import { randomBytes, timingSafeEqual } from 'node:crypto';
import { requireValue, MediaError } from '../media/errors.mjs';

const opaque = () => randomBytes(24).toString('base64url');
const same = (a, b) => typeof a === 'string' && /^[A-Za-z0-9_-]{32}$/.test(a) && typeof b === 'string' && /^[A-Za-z0-9_-]{32}$/.test(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const other = role => role === 'operator' ? 'customer' : 'operator';

/** Two-person browser video. Signaling is event-driven and memory bounded;
 * audio/video flows peer-to-peer or through TURN, never through Firestore,
 * LiveKit, the recording worker, or the WhatsApp voice-call controller.
 * A Render restart expires links; it cannot terminate an existing voice call.
 */
export class VideoLinks {
  constructor({ authorize, env = process.env, fetchImpl = fetch, now = Date.now }) {
    Object.assign(this, { authorize, env, fetchImpl, now });
    this.rooms = new Map(); this.limits = new Map();
  }
  enabled() {
    return this.env.SH_VIDEO_LINKS_ENABLED === 'true' && !!this.env.SH_VIDEO_TURN_KEY_ID && !!this.env.SH_VIDEO_TURN_API_TOKEN;
  }
  prune() {
    for (const [id, room] of this.rooms) if (this.now() > room.expiresAt || room.ended && this.now() - room.endedAt > 60000) { this.end(room); this.rooms.delete(id); }
    for (const [id, row] of this.limits) if (this.now() > row.until) this.limits.delete(id);
  }
  async create(context, body) {
    requireValue(this.enabled(), 'VIDEO_NOT_CONFIGURED', 'Video links need the free TURN service configured first.', 501);
    const actor = await this.authorize(context); this.prune();
    requireValue(actor.nativeBuild >= 24, 'VIDEO_UPDATE_REQUIRED', 'Install SH Chat R24 for video links.', 409);
    requireValue(typeof body.requestId === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(body.requestId), 'INVALID_REQUEST_ID', 'A video request identity is required.', 400);
    const prior = [...this.rooms.values()].find(r => r.deviceId === actor.deviceId && r.requestId === body.requestId);
    if (prior && !prior.ended) return this.links(prior);
    requireValue(![...this.rooms.values()].some(r => r.deviceId === actor.deviceId && !r.ended), 'VIDEO_BUSY', 'End the current video link before creating another.', 409);
    const limit = this.limits.get(actor.deviceId) || { count: 0, until: this.now() + 3600000 };
    requireValue(limit.count < 12 && [...this.rooms.values()].filter(r => !r.ended).length < 20,
      'VIDEO_BUSY', 'Video links are busy. Try again shortly.', 429);
    limit.count++; this.limits.set(actor.deviceId, limit);
    const room = { id: opaque(), deviceId: actor.deviceId, requestId: body.requestId,
      createdAt: this.now(), expiresAt: this.now() + 30 * 60000, joinUntil: this.now() + 10 * 60000,
      roles: { operator: { token: opaque() }, customer: { token: opaque() } },
      events: [], sequence: 0, subscribers: new Map(), seen: new Set(), signalWindow: this.now(), signals: 0, ended: false };
    this.rooms.set(room.id, room);
    room.timer = setTimeout(() => { this.end(room); this.rooms.delete(room.id); }, 30 * 60000); room.timer.unref?.();
    // Overlap relay credential generation with camera permission and sharing.
    // A slow relay must not block creating or ending a link, or voice calling.
    // Each participant keeps separate credentials and coalesces a later Join.
    for (const participant of Object.values(room.roles)) void this.iceServers(participant).catch(() => {});
    return this.links(room);
  }
  links(room) {
    const origin = this.env.SH_VIDEO_PUBLIC_ORIGIN || 'https://ai-agent-debate.onrender.com';
    requireValue(/^https:\/\/[a-z0-9.-]+(?::\d+)?$/.test(origin), 'VIDEO_CONFIG_INVALID', 'Video origin configuration is invalid.', 503);
    const link = role => `${origin}/video-call.html#${room.id}.${role}.${room.roles[role].token}`;
    return { operatorUrl: link('operator'), customerUrl: link('customer'), expiresAt: room.joinUntil };
  }
  access(id, token, clientId, claim = false) {
    this.prune(); const room = this.rooms.get(id);
    requireValue(room && !room.ended, 'VIDEO_ENDED', 'This video link has ended. Ask for a new link.', 410);
    const role = ['operator', 'customer'].find(r => same(room.roles[r].token, token));
    requireValue(role, 'VIDEO_ACCESS_DENIED', 'This video link is not valid.', 403);
    requireValue(typeof clientId === 'string' && /^[A-Za-z0-9_-]{16,100}$/.test(clientId), 'VIDEO_CLIENT_REQUIRED', 'A video participant identity is required.', 400);
    const participant = room.roles[role];
    requireValue(!participant.clientId || participant.clientId === clientId, 'VIDEO_ALREADY_JOINED', 'This private link is already open on another device.', 409);
    if (claim && !participant.clientId) {
      requireValue(this.now() < room.joinUntil, 'VIDEO_LINK_EXPIRED', 'This video invitation expired. Ask for a new link.', 410);
      participant.clientId = clientId;
    }
    requireValue(participant.clientId === clientId, 'VIDEO_JOIN_REQUIRED', 'Join this video call first.', 403);
    return { room, role, participant };
  }
  async iceServers(participant) {
    if (!participant.ice) participant.ice = (async () => {
      const id = encodeURIComponent(this.env.SH_VIDEO_TURN_KEY_ID);
      const response = await this.fetchImpl(`https://rtc.live.cloudflare.com/v1/turn/keys/${id}/credentials/generate-ice-servers`, {
        method: 'POST', signal: AbortSignal.timeout(12000), headers: { Authorization: `Bearer ${this.env.SH_VIDEO_TURN_API_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: 2100 }) });
      requireValue(response.ok, 'VIDEO_RELAY_UNAVAILABLE', 'Video relay is temporarily unavailable. Your voice calls are unaffected.', 503);
      const data = await response.json();
      requireValue(Array.isArray(data.iceServers) && data.iceServers.length <= 8, 'VIDEO_RELAY_UNAVAILABLE', 'Video relay returned an invalid configuration.', 503);
      return data.iceServers.map(row => ({ ...row, urls: (Array.isArray(row.urls) ? row.urls : [row.urls]).filter(url => typeof url === 'string' && !/:53(?:\?|$)/.test(url)) }));
    })().catch(error => { participant.ice = null; throw error; });
    return participant.ice;
  }
  async join(id, token, body) {
    const access = this.access(id, token, body.clientId, true);
    const iceServers = await this.iceServers(access.participant);
    requireValue(!access.room.ended, 'VIDEO_ENDED', 'This video call has ended.', 410);
    return { role: access.role, iceServers, expiresAt: access.room.expiresAt };
  }
  emit(room, to, data) {
    const event = { id: ++room.sequence, to, data }; room.events.push(event);
    if (room.events.length > 128) room.events.shift();
    const listener = room.subscribers.get(to);
    if (listener && !listener.write(`id: ${event.id}\ndata: ${JSON.stringify(data)}\n\n`)) listener.end();
  }
  signal(id, token, body) {
    const { room, role } = this.access(id, token, body.clientId);
    requireValue(typeof body.messageId === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(body.messageId), 'INVALID_VIDEO_SIGNAL', 'Invalid signal identity.', 400);
    const key = `${role}:${body.messageId}`;
    if (room.seen.has(key)) return { delivered: true };
    if (this.now() - room.signalWindow > 60000) { room.signalWindow = this.now(); room.signals = 0; }
    requireValue(++room.signals <= 300 && room.seen.size < 3000, 'VIDEO_RATE_LIMIT', 'Video signaling is busy.', 429);
    const { type, sdp, candidate } = body;
    requireValue(['ready', 'offer', 'answer', 'candidate', 'restart', 'end'].includes(type), 'INVALID_VIDEO_SIGNAL', 'Unsupported video action.', 400);
    if (type === 'offer' || type === 'answer') requireValue((type === 'offer') === (role === 'operator') && typeof sdp === 'string' && sdp.startsWith('v=0') && sdp.length < 50000, 'INVALID_VIDEO_SIGNAL', 'Invalid video negotiation.', 400);
    if (type === 'candidate') requireValue(candidate && typeof candidate.candidate === 'string' && candidate.candidate.length <= 4096 &&
      (candidate.sdpMid == null || typeof candidate.sdpMid === 'string' && candidate.sdpMid.length < 32) &&
      (candidate.sdpMLineIndex == null || Number.isInteger(candidate.sdpMLineIndex) && candidate.sdpMLineIndex >= 0 && candidate.sdpMLineIndex < 10), 'INVALID_VIDEO_SIGNAL', 'Invalid network candidate.', 400);
    room.seen.add(key);
    if (type === 'end') this.end(room);
    else this.emit(room, other(role), { type, ...(sdp ? { sdp } : {}), ...(type === 'candidate' ? { candidate: { candidate: candidate.candidate, sdpMid: candidate.sdpMid, sdpMLineIndex: candidate.sdpMLineIndex, usernameFragment: String(candidate.usernameFragment || '').slice(0, 256) } } : {}) });
    return { delivered: true };
  }
  end(room) {
    if (room.ended) return;
    room.ended = true; room.endedAt = this.now(); clearTimeout(room.timer);
    for (const role of ['operator', 'customer']) { this.emit(room, role, { type: 'end' }); room.subscribers.get(role)?.end(); }
    room.subscribers.clear(); room.events = []; room.seen.clear();
  }
  async endFromDevice(context, id) {
    const actor = await this.authorize(context), room = this.rooms.get(id);
    if (!room) return { ended: true };
    requireValue(room.deviceId === actor.deviceId, 'VIDEO_ACCESS_DENIED', 'This video link belongs to another device.', 403);
    this.end(room); return { ended: true };
  }
  mount(app) {
    const token = req => String(req.headers.authorization || '').replace(/^Bearer /, '');
    const wrap = action => async (req, res) => {
      res.set('Cache-Control', 'no-store');
      try {
        requireValue(JSON.stringify(req.body || {}).length <= 60000, 'VIDEO_INPUT_TOO_LARGE', 'Video request is too large.', 413);
        const result = await action(req, res); if (!res.headersSent) res.json({ ok: true, ...result });
      } catch (e) { if (!res.headersSent) res.status(e instanceof MediaError ? e.statusCode : 503).json({ ok: false,
        code: e instanceof MediaError ? e.code : 'VIDEO_UNAVAILABLE', error: e instanceof MediaError ? e.message : 'Video is temporarily unavailable.' }); else res.end(); }
    };
    app.get('/api/operator-android/video-config', wrap(async req => { await this.authorize(req); return { enabled: this.enabled() }; }));
    app.post('/api/operator-android/video-calls', wrap(req => this.create(req, req.body)));
    app.post('/api/operator-android/video-calls/:id/end', wrap(req => this.endFromDevice(req, req.params.id)));
    app.post('/api/sh-video/:id/join', wrap(req => this.join(req.params.id, token(req), req.body)));
    app.post('/api/sh-video/:id/signal', wrap(req => this.signal(req.params.id, token(req), req.body)));
    app.get('/api/sh-video/:id/events', wrap(async (req, res) => {
      const { room, role } = this.access(req.params.id, token(req), req.query.clientId);
      const after = Number(req.query.after || 0);
      requireValue(Number.isSafeInteger(after) && after >= 0 && after <= room.sequence, 'INVALID_VIDEO_CURSOR', 'Invalid signal cursor.', 400);
      if (room.events.length && after < room.events[0].id - 1) throw new MediaError('VIDEO_RESYNC_REQUIRED', 'Rejoin the video call.', 409);
      room.subscribers.get(role)?.end();
      res.set({ 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no', 'Referrer-Policy': 'no-referrer' }); res.flushHeaders();
      room.subscribers.set(role, res); res.write(': connected\n\n');
      for (const event of room.events) if (event.to === role && event.id > after) res.write(`id: ${event.id}\ndata: ${JSON.stringify(event.data)}\n\n`);
      const timer = setInterval(() => res.write(': keep-alive\n\n'), 15000); timer.unref?.();
      res.on('close', () => { clearInterval(timer); if (room.subscribers.get(role) === res) room.subscribers.delete(role); });
    }));
  }
  close() { for (const room of this.rooms.values()) this.end(room); this.rooms.clear(); this.limits.clear(); }
}
