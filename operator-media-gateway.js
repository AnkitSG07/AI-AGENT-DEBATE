// Root integration boundary: trusted Meta bytes, enrolled Android identity and
// server-owned rollout policy. Provider credentials never leave this module.
import { createHmac, timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import { createFirestoreMediaStore, recoverMediaWork } from './media-store/firestore-media-store.mjs';
import { createNativeCallRuntime } from './call-runtime/startup.mjs';
import { mountNativeCallRoutes } from './call-runtime/routes.mjs';
import { sessionKey, eventKey } from './call-runtime/call-runtime.mjs';
import { MediaError } from './media/errors.mjs';

export function verifyMetaWebhook(req, secret) {
  if (typeof secret !== 'string' || !secret.trim()) return false;
  const signature = String(req.headers?.['x-hub-signature-256'] || '');
  if (!/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
  const bytes = req.rawBodyBuffer || (typeof req.rawBody === 'string' ? Buffer.from(req.rawBody, 'utf8') : null);
  if (!Buffer.isBuffer(bytes)) return false;
  const expected = createHmac('sha256', secret).update(bytes).digest();
  const actual = Buffer.from(signature.slice(7), 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Compatibility projection for the existing Odoo/history UI. It contains no
// room token or SDP, and Connected requires the coordinator's media readiness.
export function nativeCallHistoryEvent({ session, view }, at = Date.now()) {
  if (!session?.providerCallId || session.routeChoice === 'legacy') return null;
  const connectedAt = Number(session.mediaReadyAt || 0), ended = !!view.terminal;
  const reason = String(view.terminal?.reason || '').toLowerCase();
  let status = connectedAt && view.roomReady ? 'connected' : session.direction === 'outgoing' ? 'outgoing_ringing' :
    !view.ownerDeviceId && view.phase === 'ringing' ? 'incoming_ringing' : 'connecting';
  if (ended) status = !view.endConfirmed ? 'ending' : /reject|declin/.test(reason) ? 'declined' :
    /timed_out|no_answer/.test(reason) && !connectedAt ? session.direction === 'incoming' ? 'missed' : 'no_answer' : 'ended';
  const endedAt = Number(view.terminal?.endedAt || 0);
  const projection = { status, active: !ended, answerable: status === 'incoming_ringing',
    connected: !!connectedAt, native_media: true, native_owner_device_id: view.ownerDeviceId || '',
    provider_answer_confirmed: !!connectedAt, end_confirmed: !!view.endConfirmed,
    connected_at: connectedAt ? new Date(connectedAt).toISOString() : '',
    ended_at: endedAt ? new Date(endedAt).toISOString() : '',
    duration_seconds: connectedAt && endedAt >= connectedAt ? Math.floor((endedAt - connectedAt) / 1000) : 0 };
  return { id: `native_${createHash('sha256').update(JSON.stringify([session.id, session.version, view.version, status, view.ownerDeviceId, view.endConfirmed])).digest('hex')}`,
    call_id: session.providerCallId, event: status, status, direction: session.direction,
    customer_phone: session.customerPhone || '', customer_name: session.customerName || '',
    phone_number_id: session.phoneNumberId, odoo_channel_id: session.channelId || 0,
    timestamp: Math.floor(at / 1000), date: new Date(at).toISOString(), received_at: new Date(at).toISOString(),
    source: 'operator_native_media', native_version: Number(view.version) || Number(session.version) || 0,
    native_projection: projection, _odoo_sync_pending: true };
}

export function createOperatorMediaGateway({ firestoreRuntime, pushBridge, rejectIncoming,
  env = process.env, logger = console, now = Date.now,
  storeFactory = createFirestoreMediaStore, runtimeFactory = createNativeCallRuntime,
  onCallState = async () => {} } = {}) {
  const registry = firestoreRuntime?.deviceRegistry;
  const appSecret = String(env.META_WHATSAPP_APP_SECRET || env.WHATSAPP_APP_SECRET || env.META_APP_SECRET || '').trim();
  const phoneNumberId = String(env.WHATSAPP_PHONE_NUMBER_ID || env.META_WHATSAPP_PHONE_NUMBER_ID ||
    env.WHATSAPP_CALL_PHONE_NUMBER_ID || env.PHONE_NUMBER_ID || '').trim();
  const unavailable = () => new MediaError('NATIVE_CALLS_UNAVAILABLE', 'Native calling is not configured on the server yet.', 503);
  let bundle = null, mediaStore = null, timer = null, work = null, probe = null, probeVerified = false, nextProbeAt = 0;
  const persistenceExpected = env.SH_ANDROID_REGISTRY_BACKEND === 'firestore' || !!env.LIVEKIT_URL;
  const workerId = `render_${randomUUID()}`;
  const publishedStates = new Map();
  const historyWork = new Map();
  const housekeepingWork = new Map();
  // Reuse only the row returned by the immediately preceding authentication
  // of this request. Every recheck authenticates again and replaces it. There
  // is no cross-request or time-based credential/revocation cache.
  const authenticatedRows = new WeakMap();
  const blocked = new Set(String(env.SH_ANDROID_REVOKED_DEVICE_IDS || '').split(',').map(s => s.trim()).filter(Boolean));
  const roomCallingRequested = () => env.SH_NATIVE_CALLS_ENABLED === 'true' && !!appSecret;
  // Room control does not depend on enumerating the transfer pilot. Keep that
  // durable registry read on transfer/capability paths where its IDs are used.
  const roomPolicy = async () => ({ roomCalling: roomCallingRequested() });
  const normalize = row => row ? { deviceId: row.id, userId: `native:${row.id}`, tenantId: 'smart-handicrafts',
    credentialGeneration: row.credentialGeneration, credentialExpiresAt: row.tokenExpiresAt,
    nativeBuild: Number.isSafeInteger(row.nativeBuild) ? row.nativeBuild : 0,
    mediaProtocol: row.mediaProtocol || '', revoked: !!row.revokedAt || blocked.has(row.id),
    receiveCalls: row.receiveCalls !== false, label: row.deviceLabel || 'Operator device', authenticated: true, canCall: true } : null;
  const mapRegistryError = error => new MediaError(
    error?.registryError && error.status < 500 ? error.code || 'DEVICE_AUTH_REQUIRED' : 'DEVICE_STORAGE_UNAVAILABLE',
    error?.registryError && error.status < 500 ? error.message : 'Device storage is temporarily unavailable.',
    error?.registryError && error.status < 500 ? error.status : 503);
  async function authenticate(req) {
    authenticatedRows.delete(req);
    if (!registry) throw unavailable();
    const bearer = String(req.headers?.authorization || '');
    if (!/^Bearer [A-Za-z0-9_.-]{45,240}$/.test(bearer)) throw new MediaError('DEVICE_AUTH_REQUIRED', 'Enroll this device in App settings first.', 401);
    try {
      const raw = bearer.slice(7);
      let row = await registry.authenticate(raw);
      const build = req.headers?.['x-sh-native-build'], protocol = req.headers?.['x-sh-media-protocol'];
      if (build !== undefined || protocol !== undefined) {
        const numeric = Number(build);
        if (!/^\d{1,6}$/.test(String(build || '')) || !Number.isSafeInteger(numeric) ||
            numeric < 1 || numeric > 100000 || protocol !== 'sh-room-audio-v1')
          throw new MediaError('INVALID_CLIENT_METADATA', 'The native client metadata is invalid.', 400);
        if (row.nativeBuild !== numeric || row.mediaProtocol !== protocol)
          row = await registry.updateNativeClient(raw, { nativeBuild: numeric, mediaProtocol: protocol });
      }
      const current = normalize(row);
      authenticatedRows.set(req, current);
      return current;
    } catch (error) { if (error instanceof MediaError) throw error; throw mapRegistryError(error); }
  }
  async function resolveDevice(id, req) {
    const authenticated = req && authenticatedRows.get(req);
    if (authenticated?.deviceId === id) return { ...authenticated };
    try { return normalize(await registry.getDevice(id)); }
    catch (error) { throw mapRegistryError(error); }
  }
  async function listDevices() {
    try { return (await registry.listDevices()).filter(row => !row.revokedAt && row.tokenExpiresAt > now()).slice(0, 16).map(normalize); }
    catch (error) { throw mapRegistryError(error); }
  }
  const policy = async () => {
    let ids = String(env.SH_NATIVE_PILOT_DEVICE_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
    // An explicit deployment setting may enroll this small team's supported
    // phones into the pilot automatically. These are server-registry identities
    // admitted by administrator-issued invitations, never IDs supplied by a call request.
    if (!ids.length && env.SH_NATIVE_PILOT_USE_ENROLLED_DEVICES === 'true' && registry) {
      const rows = await listDevices();
      ids = rows.filter(row => !row.revoked && row.nativeBuild >= 10 && row.mediaProtocol === 'sh-room-audio-v1' &&
        row.receiveCalls !== false && row.credentialExpiresAt > now()).map(row => row.deviceId);
    }
    return { roomCalling: roomCallingRequested(),
      transferEnabled: env.SH_NATIVE_TRANSFER_PILOT_ENABLED === 'true', mode: 'pilot',
      pilotEnabled: env.SH_NATIVE_TRANSFER_PILOT_ENABLED === 'true', pilotDeviceIds: ids,
      reason: !appSecret ? 'The Meta webhook signing secret is required.' : env.SH_NATIVE_CALLS_ENABLED !== 'true' ?
        'Native calling is awaiting activation.' : ids.length > 4 ? 'Choose up to four enrolled phones for the transfer pilot.' : '' };
  };
  try {
    if (registry && firestoreRuntime?.firestore) {
      mediaStore = storeFactory({ firestore: firestoreRuntime.firestore,
        collectionPrefix: `${firestoreRuntime.collectionPrefix}_media`, clock: now, recoveryLeaseMs: 60000,
        onTiming: value => logger.info?.('SH_CALL_STORAGE_TIMING', JSON.stringify(value)) });
    }
    if (mediaStore && phoneNumberId) {
      bundle = runtimeFactory({ store: mediaStore, env, authenticate, resolveDevice, listDevices,
        onRuntimeTiming: value => logger.info?.('SH_CALL_RUNTIME_TIMING', JSON.stringify(value)),
        onTiming: value => logger.info?.('SH_CALL_PROVIDER_TIMING', JSON.stringify(value)),
        capabilities: policy, roomCapabilities: roomPolicy, rejectIncoming, onWorkAvailable: id => queueRecovery(id), phoneNumberId, minimumNativeBuild: 10, now,
        notify: async event => pushBridge.publishRoomEvent({ ...event, stillCurrent: async () => {
          const current = await bundle.runtime.locate(event.session.id);
          if (!current) return false;
          if (event.event.endsWith('ended')) return true;
          if (event.event === 'incoming') return !current.terminal && !current.owner && current.phase === 'ringing' && current.deadlineAt > now();
          const view = await bundle.runtime.view(current);
          return view.transfer?.id === event.transferId && view.transfer?.status === 'invited';
        } }) });
    }
  } catch {
    // SDK errors can contain sensitive request fields. Only a stable summary is logged.
    logger.warn?.('Native room configuration is unavailable; legacy calling remains available.');
  }
  async function publishCurrentState(id) {
    const session = await bundle.runtime.locate(id);
    if (session && session.routeChoice !== 'legacy' && session.providerCallId) {
      const view = await bundle.runtime.view(session);
      const stamp = JSON.stringify([session.version, view.version, view.phase, view.ownerDeviceId, view.endConfirmed]);
      if (publishedStates.get(session.id) !== stamp) {
        await onCallState({ session, view });
        publishedStates.set(session.id, stamp);
        if (publishedStates.size > 1000) publishedStates.delete(publishedStates.keys().next().value);
      }
    }
  }
  function queueHistoryProjection(id) {
    const pending = historyWork.get(id);
    if (pending) { pending.dirty = true; return; }
    const state = { dirty: true };
    historyWork.set(id, state);
    void (async () => {
      try {
        // Coalesce per call, preserving projection order without placing file,
        // Odoo or report I/O on the authoritative media cleanup path.
        while (state.dirty) { state.dirty = false; await publishCurrentState(id); }
      } catch { logger.warn?.('Native call history projection will retry.'); }
      finally { historyWork.delete(id); }
    })();
  }
  async function recoverSession(id) {
    // A committed, still-ringing incoming alert must not wait for compatibility
    // history I/O or active-call/transfer housekeeping. The runtime claims the
    // same durable outbox job; fresh state and per-device delivery claims still
    // suppress stale, answered and duplicate alerts across workers.
    // Terminal work takes the cleanup lane immediately, skipping no-op alert
    // claims. Setup signaling and transfer push have independent durable leases.
    if (bundle.runtime.dispatchRealtimeWork) await bundle.runtime.dispatchRealtimeWork(id);
    else await bundle.runtime.dispatchIncomingAlert(id);
    // Publish committed intent before slower provider cleanup so the browser
    // inbox stops ringing immediately when native ownership/end is recorded.
    queueHistoryProjection(id);
    // Every wake above can still dispatch End/SDP/FCM independently. Only the
    // slower full reconciliation is coalesced: concurrent POST/webhook wakes
    // must not pile up transactions against the same call's authoritative rows.
    const pending = housekeepingWork.get(id);
    if (pending) { pending.dirty = true; return pending.promise; }
    const state = { dirty: true, promise: null };
    housekeepingWork.set(id, state);
    state.promise = (async () => {
      let result;
      try {
        while (state.dirty) {
          state.dirty = false;
          result = await bundle.runtime.recoverSession(id);
          queueHistoryProjection(id);
        }
        return result;
      } finally {
        // A failed pass cannot wedge this call. Durable due-index recovery and
        // the next explicit wake can always begin a new reconciliation pass.
        if (housekeepingWork.get(id) === state) housekeepingWork.delete(id);
      }
    })();
    return state.promise;
  }
  const queueRecovery = id => setImmediate(() => { recoverSession(id).catch(() => {}); });
  async function runRecovery() {
    if (!bundle || work) return work;
    work = recoverMediaWork({ store: mediaStore, controller: bundle.controller, workerId,
      recoverSession, limit: 16, drainLimit: 1 })
      .catch(() => logger.warn?.('Native call recovery will retry.'))
      .finally(() => { work = null; });
    return work;
  }
  async function verifyConfiguration() {
    if (!bundle) throw unavailable();
    if (probe) return probe;
    probe = bundle.verifyConfiguration().then(value => { probeVerified = true; return value; })
      .catch(error => { probeVerified = false; nextProbeAt = now() + 60000; throw error; })
      .finally(() => { probe = null; });
    return probe;
  }
  async function durableLocate(id) {
    if (bundle) return bundle.runtime.locate(id);
    if (!mediaStore) { if (persistenceExpected) throw unavailable(); return null; }
    const direct = await mediaStore.get(sessionKey(id));
    if (direct) return direct;
    const route = await mediaStore.get(eventKey(`route:${id}`));
    return route?.sessionId ? mediaStore.get(sessionKey(route.sessionId)) : null;
  }
  return {
    appSecretConfigured: !!appSecret,
    verifyWebhook: req => verifyMetaWebhook(req, appSecret),
    async verifyConfiguration() { return verifyConfiguration(); },
    mount(app) {
      if (bundle) mountNativeCallRoutes(app, { runtime: bundle.runtime, scheduleRecovery: queueRecovery,
        onTiming: value => { if (value.action !== 'status' || value.elapsedMs >= 750) logger.info?.('SH_CALL_TIMING', JSON.stringify(value)); } });
      else app.get('/api/operator-android/capabilities', async (req, res) => {
        try { await authenticate(req); res.set('Cache-Control', 'no-store').json({ ok: true,
          capabilities: { protocol: 'sh-room-audio-v1', minimumNativeBuild: 10, nativeRoomCalls: false,
            roomCalling: false, transferEnabled: false, reason: 'Native media configuration is incomplete.' } }); }
        catch (error) { res.status(error.statusCode || 503).json({ ok: false, error: error.message }); }
      });
    },
    start() {
      if (!bundle || timer) return;
      // Control reachability is only a configuration check, never audio evidence.
      void verifyConfiguration().catch(() => logger.warn?.('LiveKit configuration check will retry.'));
      void runRecovery();
      timer = setInterval(() => {
        void runRecovery();
        if (!probeVerified && !probe && now() >= nextProbeAt)
          void verifyConfiguration().catch(() => logger.warn?.('LiveKit configuration check will retry.'));
      }, 15000); timer.unref?.();
    },
    async close() { if (timer) clearInterval(timer); timer = null; if (work) await work; },
    async hasNativeCall(id) { const row = await durableLocate(id); return !!row && row.routeChoice !== 'legacy'; },
    async claimLegacyIncoming(id, operationId) {
      if (!bundle) {
        const row = await durableLocate(id);
        if (row && (row.routeChoice !== 'legacy' || row.legacyClaim?.operationId !== operationId)) throw unavailable();
        return { allowed: true, claimed: !!row, managed: !!row };
      }
      const result = await bundle.runtime.claimLegacyIncoming(id, operationId);
      if (result.sessionId) queueRecovery(result.sessionId);
      return result;
    },
    async assertLegacyControl(id) {
      const row = await durableLocate(id);
      if (row && row.routeChoice !== 'legacy')
        throw new MediaError('NATIVE_CALL_OWNED', 'Use SH Chat native call controls for this call.', 409);
    },
    async attachVerifiedChannel(callId, channelId) {
      if (!bundle || !Number.isSafeInteger(channelId) || channelId <= 0) return;
      return bundle.runtime.attachVerifiedChannel(callId, channelId);
    },
    async ingestVerifiedEvents(events = []) {
      if (!bundle) return { handled: 0 };
      let handled = 0;
      for (const row of events) {
        if (row.phone_number_id !== phoneNumberId) continue;
        const raw = row.raw?.call || {}, session = row.session || raw.session || raw.connect?.session || {};
        const terminal = /^(?:terminate|terminated|reject|rejected|declined|failed|busy|no_answer|missed|ended|completed)$/.test(row.event) ||
          /^(?:failed|busy|rejected|completed|no_answer)$/.test(String(row.status || '').toLowerCase());
        const offer = row.direction === 'incoming' && session.sdp_type === 'offer' && !!session.sdp;
        const answer = row.direction === 'outgoing' && session.sdp_type === 'answer' && !!session.sdp;
        const accepted = String(row.provider_status || raw.status || '').toUpperCase() === 'ACCEPTED' ||
          ['accept', 'accepted'].includes(String(raw.event || '').toLowerCase());
        if (!terminal && !offer && !answer && !accepted) continue;
        // New native calls stop when disabled; old bound calls still reconcile.
        if (offer && !roomCallingRequested() && !await bundle.runtime.locate(row.call_id)) continue;
        const types = terminal ? ['terminate'] : [...(offer ? ['incoming'] : []), ...(answer ? ['connect'] : []), ...(accepted ? ['accepted'] : [])];
        for (const type of types) {
        const receivedAt = now(), started = performance.now();
        const result = await bundle.runtime.ingestVerifiedMetaEvent({ verified: true,
          eventId: createHash('sha256').update(JSON.stringify([type, row.id || [row.call_id, row.event, row.status,
            row.timestamp, createHash('sha256').update(String(session.sdp || '')).digest('hex')]])).digest('hex'),
          type, callId: row.call_id, phoneNumberId,
          direction: row.direction, offerSdp: offer ? session.sdp : undefined, answerSdp: answer ? session.sdp : undefined,
          opaqueSessionId: raw.biz_opaque_callback_data || raw.opaque_callback_data || undefined,
          customerPhone: row.customer_phone, customerName: row.customer_name,
          channelId: Number.isSafeInteger(Number(row.odoo_channel_id)) && Number(row.odoo_channel_id) > 0 ? Number(row.odoo_channel_id) : undefined,
          occurredAtMs: Number(row.timestamp) * 1000 });
        const timestamp = Number(row.timestamp) * 1000;
        logger.info?.('SH_CALL_WEBHOOK_TIMING', JSON.stringify({ event: type,
          elapsedMs: Math.round(performance.now() - started),
          ...(Number.isFinite(timestamp) && timestamp > 0 ? { providerAgeAtReceiveMs: Math.max(0, receivedAt - timestamp) } : {}),
          handled: result.handled === true }));
        if (result.handled) handled++;
        if (result.sessionId) queueRecovery(result.sessionId);
        }
      }
      return { handled };
    }
  };
}
