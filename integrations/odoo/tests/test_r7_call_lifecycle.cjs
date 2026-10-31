const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const testedFile = path.resolve(process.argv[2] || 'deliverables/smart-handicrafts-whatsapp-embed.html');
const html = fs.readFileSync(testedFile, 'utf8');
const testedHash = crypto.createHash('sha256').update(html).digest('hex');
const source = html.slice(html.indexOf('  const whatsappCallsRuntime = {'), html.indexOf('  // Incremental rendering:'));
const OFFER = 'v=0\r\no=- 123 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 0.0.0.0\r\na=mid:0\r\na=ice-ufrag:localtest\r\na=ice-pwd:synthetic-password-only\r\na=fingerprint:sha-256 00:00:00:00\r\na=setup:actpass\r\na=rtcp-mux\r\na=rtpmap:111 opus/48000/2\r\n';
const ANSWER = OFFER.replace('a=setup:actpass', 'a=setup:active');
const plain = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };

function makeNode(id = '') {
  const values = new Set(['is-hidden']);
  return { id, value: '', textContent: '', innerHTML: '', disabled: false, dataset: {}, attributes: {}, events: new Map(), srcObject: null,
    classList: { add: (...xs) => xs.forEach(x => values.add(x)), remove: (...xs) => xs.forEach(x => values.delete(x)),
      contains: x => values.has(x), toggle(x, flag) { if (flag === undefined) flag = !values.has(x); flag ? values.add(x) : values.delete(x); return flag; } },
    querySelector() { return null; }, setAttribute(name, value) { this.attributes[name] = String(value); }, getAttribute(name) { return this.attributes[name]; },
    addEventListener(name, callback) { this.events.set(name, callback); }, pause() {}, play() { return Promise.resolve(); }
  };
}

function makeHarness({ realtime = false } = {}) {
  const nodes = new Map(), timers = new Set(), timerCallbacks = new Map(), windowEvents = new Map();
  const byId = id => { if (!nodes.has(id)) nodes.set(id, makeNode(id)); return nodes.get(id); };
  const A = { id: 1, channel_type: 'whatsapp', name: 'Alice', whatsapp_number: '919999000001' };
  const B = { id: 2, channel_type: 'whatsapp', name: 'Bob', whatsapp_number: '919999000002' };
  const state = { channels: [A, B], selectedChannel: A, selectedChannelId: 1, messages: [], session: { uid: 7, name: 'Hub Operator' },
    autoRefreshEnabled: true, lifecycleController: new AbortController(), whatsappCallLogs: [], whatsappCallLastPollMs: 0,
    whatsappActiveCall: null, whatsappCallIsConnecting: false, whatsappCallIsConnected: false, whatsappLocalStream: null, whatsappPeerConnection: null, destroyed: false };
  const storage = initial => { const values = new Map(Object.entries(initial)); return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, String(value)), values }; };
  const localStorage = storage({ sh_operator_device: JSON.stringify({ deviceId: 'dev_hub', operatorName: 'Hub Operator', deviceLabel: 'Main Hub', status: 'online', receiveCalls: true, receiveChats: true }) });
  const sessionStorage = storage({ sh_operator_session_id_v1: 'session_hub' });
  const owner = 'dev_hub::session_hub';
  const server = { calls: new Map(), locks: new Map(), pending: null, devices: [], outgoingDeferred: null,
    microphoneDeferred: null, outgoingError: null, heartbeatAvailable: true, lastOutgoing: null };
  const commands = [], reads = [], tracks = [], peers = [], toasts = [];
  let micRequests = 0, channelSelections = 0;
  const attachLock = (call, identity = owner) => {
    const lock = server.locks.get(call.call_id);
    return { ...plain(call), locked_by_other: !!lock && lock.operator_device_id !== identity, lock: lock ? plain(lock) : null };
  };
  const call = (id, extra = {}) => ({ call_id: id, customer_phone: B.whatsapp_number, customer_name: 'Bob Caller', direction: 'incoming',
    status: 'incoming_ringing', event: 'connect', timestamp: Date.now() / 1000, sdp: OFFER, sdp_type: 'offer', phone_number_id: 'business-number', ...extra });
  const addCall = (id, extra = {}) => { const record = call(id, extra); server.calls.set(id, record); return record; };
  const outgoingResponse = body => {
    const id = `wacid.${body.client_request_id}`;
    const record = addCall(id, { direction: 'outgoing', event: 'outgoing', status: 'outgoing_ringing', customer_phone: body.to, customer_name: body.customer_name, sdp: '', sdp_type: '', remote_answer_available: false });
    return { ok: true, call_id: id, id, call: record, phone_number_id: 'business-number', client_request_id: body.client_request_id };
  };
  async function handle(path, url, body, options) {
    if (options.method === 'POST') {
      commands.push({ path, body: plain(body) });
      if (path === '/api/operator-devices/heartbeat') return { ok: true, updated: server.heartbeatAvailable, registered: server.heartbeatAvailable, presence: server.heartbeatAvailable, device: body, expires_at: new Date(Date.now() + 90000).toISOString() };
      if (path === '/api/operator-devices/status') return { ok: true, updated: false, device: null };
      if (path === '/api/operator-call-locks/claim') {
        const existing = server.locks.get(body.call_id);
        if (existing && existing.operator_device_id !== body.operator_device_id) return { errorStatus: 409, ok: false, error: 'Another owner has this call', lock: plain(existing) };
        const lock = { call_id: body.call_id, operator_device_id: body.operator_device_id, operator_name: body.operator_name };
        server.locks.set(body.call_id, lock); return { ok: true, lock };
      }
      if (path === '/api/operator-call-locks/release') {
        const lock = server.locks.get(body.call_id);
        if (lock && lock.operator_device_id !== body.operator_device_id) return { errorStatus: 409, ok: false, error: 'Foreign owner' };
        server.locks.delete(body.call_id); return { ok: true, released: true };
      }
      if (path === '/api/whatsapp-calls/outgoing') {
        server.lastOutgoing = body;
        if (server.outgoingError) throw new Error(server.outgoingError);
        if (server.outgoingDeferred) return server.outgoingDeferred.promise;
        return outgoingResponse(body);
      }
      if (path === '/api/whatsapp-calls/cancel-pending-outgoing') return { ok: true, pending: true, terminated: false, client_request_id: body.client_request_id };
      if (path === '/api/operator-call-transfer/request') {
        const transfer = { transfer_id: 'tr_sent', call_id: body.call_id, from_device_id: body.from_operator_device_id, to_device_id: body.to_operator_device_id, from_operator: body.from_operator, status: 'pending', expires_at: new Date(Date.now() + 90000).toISOString() };
        server.pending = { transfer, call: attachLock(server.calls.get(body.call_id)) }; return { ok: true, transfer };
      }
      if (path === '/api/operator-call-transfer/accept' || path === '/api/operator-call-transfer/decline') {
        const transfer = server.pending?.transfer;
        if (!transfer || transfer.transfer_id !== body.transfer_id || transfer.call_id !== body.call_id || transfer.to_device_id !== body.operator_device_id) return { errorStatus: 409, ok: false, error: 'Transfer not available to this session' };
        if (path.endsWith('/decline') && transfer.status === 'completed') return { ok: true, declined: false, reason: 'not_found' };
        transfer.status = path.endsWith('/decline') ? 'declined' : 'accepted';
        return { ok: true, transfer: plain(transfer), call: attachLock(server.calls.get(body.call_id), body.operator_device_id) };
      }
      if (path === '/api/whatsapp-calls/accept') {
        const record = server.calls.get(body.call_id); assert(record, 'accept must target an actual call');
        const previous = server.locks.get(body.call_id);
        if (body.transfer_id) {
          assert.equal(server.pending?.transfer.transfer_id, body.transfer_id);
          assert.equal(server.pending?.transfer.status, 'accepted');
          assert.equal(server.pending?.transfer.to_device_id, body.operator_device_id);
          assert.equal(previous.operator_device_id, server.pending.transfer.from_device_id);
          server.pending.transfer.status = 'completed';
        } else assert.equal(previous?.operator_device_id, body.operator_device_id, 'normal acceptance preclaims its own lock');
        const lock = { call_id: body.call_id, operator_device_id: body.operator_device_id, operator_name: body.operator_name, action: 'accepted', ...(body.transfer_id ? { transfer_id: body.transfer_id } : {}) };
        server.locks.set(body.call_id, lock); record.event = 'accepted'; record.status = 'connected'; record.timestamp = Date.now() / 1000;
        return { ok: true, lock, call: attachLock(record, body.operator_device_id) };
      }
      if (path === '/api/whatsapp-calls/terminate' || path === '/api/whatsapp-calls/reject') {
        const record = server.calls.get(body.call_id); assert(record, 'call controls must use actual provider ID');
        const lock = server.locks.get(body.call_id);
        if (lock && lock.operator_device_id !== body.operator_device_id) return { errorStatus: 409, ok: false, error: 'Foreign call owner' };
        const noAnswer = path.endsWith('/terminate') && body.reason === 'outgoing_no_answer' && !record.provider_answer_confirmed && record.provider_status !== 'ACCEPTED';
        record.event = path.endsWith('/reject') ? 'rejected' : noAnswer ? 'no_answer' : 'terminate'; record.status = path.endsWith('/reject') ? 'rejected' : noAnswer ? 'no_answer' : 'ended'; record.timestamp = Date.now() / 1000;
        return { ok: true, call_id: body.call_id, call: attachLock(record, body.operator_device_id) };
      }
      throw new Error(`Unmocked mutation ${path}`);
    }
    reads.push(path + url.search);
    if (path === '/api/whatsapp-calls/config') return { ok: true, own_numbers_last10: ['8888800000'], outgoing_timeout_ms: 75000 };
    if (path === '/api/operator-devices') return { ok: true, devices: plain(server.devices) };
    if (path === '/api/operator-call-transfer/pending') {
      const pending = server.pending;
      if (pending?.transfer.status === 'pending' && pending.transfer.to_device_id === url.searchParams.get('operator_device_id')) {
        return { ok: true, pending: true, transfer: plain(pending.transfer), call: attachLock(server.calls.get(pending.transfer.call_id), url.searchParams.get('operator_device_id')) };
      }
      return { ok: true, pending: false };
    }
    if (path.endsWith('/incoming')) return { ok: true, calls: [...server.calls.values()].filter(record => record.direction === 'incoming' && ['ringing', 'incoming_ringing'].includes(record.status)).map(record => attachLock(record, url.searchParams.get('operator_device_id'))) };
    if (path.endsWith('/recent') || path.endsWith('/logs')) return { ok: true, calls: [...server.calls.values()].map(record => attachLock(record)) };
    const id = decodeURIComponent(path.split('/').at(-1));
    const record = server.calls.get(id);
    return record ? { ok: true, call: attachLock(record, url.searchParams.get('operator_device_id')) } : { errorStatus: 404, ok: false, error: 'Call not found' };
  }
  async function mockFetch(rawUrl, options = {}) {
    const url = new URL(rawUrl, 'https://backend.invalid');
    const body = options.body ? JSON.parse(options.body) : {};
    let abortListener;
    const aborted = new Promise((resolve, reject) => {
      abortListener = () => reject(new Error('Aborted'));
      if (options.signal?.aborted) abortListener(); else options.signal?.addEventListener('abort', abortListener, { once: true });
    });
    try {
      const result = await Promise.race([handle(url.pathname, url, body, options), aborted]);
      return { ok: !result.errorStatus, status: result.errorStatus || 200, json: async () => plain(result) };
    } finally { options.signal?.removeEventListener('abort', abortListener); }
  }
  function stream() {
    const track = { kind: 'audio', enabled: true, stopped: false, stop() { this.stopped = true; } };
    tracks.push(track); return { getTracks: () => [track], getAudioTracks: () => [track] };
  }
  class Peer {
    constructor() { this.iceGatheringState = 'complete'; this.connectionState = 'new'; this.iceConnectionState = 'new'; this.signalingState = 'stable'; this.remoteDescriptions = []; peers.push(this); }
    addTrack() {} addEventListener() {} removeEventListener() {}
    async createOffer() { return { type: 'offer', sdp: OFFER }; }
    async createAnswer() { assert.equal(this.remoteDescription.type, 'offer'); return { type: 'answer', sdp: ANSWER }; }
    async setLocalDescription(value) { this.localDescription = plain(value); this.signalingState = value.type === 'offer' ? 'have-local-offer' : 'stable'; }
    async setRemoteDescription(value) { assert.match(value.sdp, /^v=0/); assert.match(value.sdp, /m=audio/); this.remoteDescription = plain(value); this.remoteDescriptions.push(plain(value)); this.signalingState = value.type === 'offer' ? 'have-remote-offer' : value.type === 'pranswer' ? 'have-remote-pranswer' : 'stable'; }
    close() { this.connectionState = 'closed'; this.iceConnectionState = 'closed'; this.signalingState = 'closed'; }
    connect() { this.connectionState = 'connected'; this.iceConnectionState = 'connected'; this.onconnectionstatechange?.(); this.oniceconnectionstatechange?.(); }
    fail() { this.connectionState = 'failed'; this.onconnectionstatechange?.(); }
  }
  const timer = (fn, ms, interval) => { let id; const run = () => { if (!interval) { timers.delete(id); timerCallbacks.delete(id); } fn(); }; id = interval ? setInterval(run, ms) : setTimeout(run, ms); timers.add(id); timerCallbacks.set(id, { fn, ms, interval }); return id; };
  const clear = id => { timers.delete(id); timerCallbacks.delete(id); clearTimeout(id); clearInterval(id); };
  const eventSources = [];
  class EventSourceMock {
    constructor(url) { this.url = url; this.listeners = new Map(); this.closed = false; eventSources.push(this); }
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    emit(name, data) { if (!this.closed) this.listeners.get(name)?.({ data: typeof data === 'string' ? data : JSON.stringify(data) }); }
    close() { this.closed = true; }
  }
  const ctx = { state, console, Date, Map, Set, Promise, Math, URL, URLSearchParams, AbortController,
    setTimeout: (fn, ms) => timer(fn, ms, false), setInterval: (fn, ms) => timer(fn, ms, true), clearTimeout: clear, clearInterval: clear,
    appRoot: { isConnected: true, classList: makeNode().classList, addEventListener() {}, contains() { return true; } },
    AI_MODE_BACKEND_BASE: 'https://backend.invalid', appFetch: mockFetch,
    window: { fetch: mockFetch, addEventListener: (name, fn) => windowEvents.set(name, fn) },
    document: { activeElement: null, hidden: false }, localStorage, sessionStorage, location: { search: '' },
    navigator: { userAgent: 'Synthetic harness', serviceWorker: { addEventListener() {} }, mediaDevices: { getUserMedia: async () => { micRequests++; return server.microphoneDeferred ? server.microphoneDeferred.promise : stream(); } } },
    RTCPeerConnection: Peer, MediaStream: class {}, byId,
    normalizePhoneForCompare: value => String(value || '').replace(/\D/g, ''), parseOdooUtc: value => new Date(value), channelDisplayName: value => value?.name || '',
    escapeHtml: value => String(value ?? ''), formatDateTime: value => String(value), formatTimeOnly: value => String(value),
    patchKeyedChildren: (element, value) => { if (element) element.innerHTML = value; }, setTextIfChanged: (element, value) => { if (element) element.textContent = String(value ?? ''); },
    hideInlineError: element => element?.classList.add('is-hidden'), showInlineError: (element, value) => { if (element) { element.textContent = value; element.classList.remove('is-hidden'); } },
    showOperatorToast: value => toasts.push(value), showPanel: element => element?.classList.remove('is-hidden'), hidePanel: element => element?.classList.add('is-hidden'),
    renderMessages() {}, loadChannels: async () => {}, closeMobileFloatingPanels() {}, channelUnreadCount: () => 0, applyFiltersAndRender() {},
    selectChannel: async id => { channelSelections++; state.selectedChannelId = id; state.selectedChannel = state.channels.find(channel => channel.id === id); },
    searchReadAvailable: async (model, domain) => [{ id: domain[0][2], channel_type: 'whatsapp', name: 'Archived customer', whatsapp_number: '919999000501' }]
  };
  if (realtime) ctx.window.EventSource = EventSourceMock;
  const refs = ['whatsappCallBtn', 'whatsappCallPanel', 'whatsappCallList', 'whatsappCallCurrent', 'whatsappCallSubtitle', 'whatsappCallAcceptBtn', 'whatsappCallRejectBtn', 'whatsappCallEndBtn', 'whatsappCallStartBtn', 'whatsappCallPhoneInput', 'whatsappCallMuteBtn', 'whatsappCallTransferBtn', 'whatsappCallError', 'whatsappRemoteAudio'];
  for (const ref of refs) ctx[ref] = byId(`ref:${ref}`);
  ctx.messageInput = { value: 'Keep Alice draft' };
  vm.createContext(ctx);
  vm.runInContext(source + '\nglobalThis.api={runtime:whatsappCallsRuntime,whatsappOperatorIdentity,mergeWhatsappCallLogs,whatsappCallKey,whatsappCallHasRemoteOffer,whatsappCallCurrentStatus,findIncomingWhatsappCall,findAnswerableWhatsappCall,pollRecentWhatsappCalls,pollWhatsappPendingTransfer,postWhatsappHubPresence,startWhatsappHubPresence,renderWhatsappCallPanel,routeWhatsappIncomingAction,openWhatsappOutgoingDial,startOutgoingWhatsappCall,acceptIncomingWhatsappCall,endActiveWhatsappCall,rejectIncomingWhatsappCall,toggleWhatsappMicrophoneMute,pollWhatsappActiveSession,applyWhatsappOutgoingAnswer,openWhatsappTransferChoices,requestWhatsappCallTransfer,isPendingWhatsappSourceTransfer,openWhatsappCallNotification,openIncomingWhatsappNotificationFromUrl,validWhatsappNotificationTarget,whatsappNotificationTargetFromQuery,setWhatsappCallAvailability,setupWhatsappIncomingUi,disposeWhatsappCalls};', ctx);
  const api = ctx.api;
  for (const name of ['fetchWhatsappCallById', 'syncWhatsappPeerState', 'queueWhatsappCallRealtimeRefresh', 'startWhatsappCallRealtime', 'stopWhatsappCallRealtime', 'startWhatsappCallForTarget']) {
    if (vm.runInContext(`typeof ${name}`, ctx) === 'function') api[name] = vm.runInContext(name, ctx);
  }
  api.whatsappOperatorIdentity();
  return { ctx, api, state, server, commands, reads, peers, tracks, byId, owner, addCall, outgoingResponse, stream, windowEvents, localStorage, toasts, eventSources,
    fireTimer(id) { const callback = timerCallbacks.get(id); assert(callback, 'timer must still be registered'); if (!callback.interval) clear(id); callback.fn(); },
    timerDetails(id) { return timerCallbacks.get(id); },
    get micRequests() { return micRequests; }, get channelSelections() { return channelSelections; },
    async cleanup() { state.destroyed = true; api.disposeWhatsappCalls(); await flush(); const remaining = timers.size; for (const id of [...timers]) clear(id); assert.equal(remaining, 0, 'destroy must clear all new call/presence timers'); } };
}

let groups = 0;
const results = [];
function saveResults(error = null) {
  fs.writeFileSync(path.join(__dirname, 'r7-call-lifecycle-results.json'), JSON.stringify({
    version: html.match(/data-build="([^"]+)"/)?.[1] || 'unknown', call_engine: 'r7', tested_file: testedFile, tested_html_sha256: testedHash,
    all_actions_synthetic: true, live_calls_or_production_mutations: false,
    completed_at: new Date().toISOString(), count: results.length, passed: results.filter(result => result.passed).length,
    failed: results.filter(result => !result.passed).length, results, ...(error ? { error: String(error.stack || error) } : {})
  }, null, 2) + '\n');
}
async function check(name, test) {
  const h = makeHarness();
  let failure = null;
  try { await test(h); await flush(); } catch (error) { failure = error; }
  try { await h.cleanup(); } catch (error) { failure ||= error; }
  results.push({ name, passed: !failure });
  if (failure) throw failure;
  groups++; console.log(`PASS ${name}`);
}
function draftUnchanged(h) { assert.equal(h.state.selectedChannelId, 1); assert.equal(h.ctx.messageInput.value, 'Keep Alice draft'); assert.equal(h.channelSelections, 0); }
async function startOutgoing(h) { h.api.openWhatsappOutgoingDial({ phone: '919999000002', name: 'Bob' }); await h.api.startOutgoingWhatsappCall(); return h.api.runtime.session; }
function pendingTransfer(h, changes = {}) {
  const record = h.addCall('wacid.TRANSFER', { event: 'accepted', status: 'connected' });
  const transfer = { transfer_id: 'tr_valid', call_id: record.call_id, from_device_id: 'dev_source::session_source', to_device_id: h.owner,
    from_operator: 'Source operator', status: 'pending', expires_at: new Date(Date.now() + 90000).toISOString(), ...changes };
  h.server.locks.set(record.call_id, { call_id: record.call_id, operator_device_id: 'dev_source::session_source', operator_name: 'Source operator' });
  h.server.pending = { transfer, call: record }; return transfer;
}

module.exports = { makeHarness, startOutgoing, pendingTransfer, draftUnchanged, plain, flush, delay, deferred, OFFER, ANSWER, testedFile, testedHash };

if (require.main === module) (async () => {
  await check('outgoing uses one real offer and request ID; final remote answer once; RTC controls Connected', async h => {
    const session = await startOutgoing(h); assert(session); const request = h.commands.find(command => command.path === '/api/whatsapp-calls/outgoing');
    assert.equal(request.body.sdp, OFFER); assert.equal(request.body.sdp_type, 'offer'); assert.equal(request.body.operator_device_id, h.owner); assert.ok(request.body.client_request_id); assert.equal(request.body.client_source, 'odoo_operator_hub');
    assert.equal(h.state.whatsappCallIsConnected, false);
    const heartbeatBusy = h.commands.findIndex(command => command.path.endsWith('/heartbeat') && command.body.inCall);
    const claim = h.commands.findIndex(command => command.path.endsWith('/claim'));
    if (heartbeatBusy >= 0) assert(claim < heartbeatBusy);
    const record = h.server.calls.get(session.callId); Object.assign(record, { sdp: ANSWER, sdp_type: 'answer', remote_answer_available: true, event: 'accepted', status: 'connected', provider_answer_confirmed: true, provider_status: 'ACCEPTED', timestamp: Date.now() / 1000 });
    await h.api.pollWhatsappActiveSession(); await h.api.pollWhatsappActiveSession();
    assert.equal(h.peers[0].remoteDescriptions.length, 1); assert.equal(h.peers[0].remoteDescription.sdp, ANSWER); assert.equal(h.state.whatsappCallIsConnected, false);
    h.peers[0].connect(); assert.equal(h.state.whatsappCallIsConnected, true); draftUnchanged(h);
    h.api.toggleWhatsappMicrophoneMute(); assert.equal(h.tracks[0].enabled, false); h.api.toggleWhatsappMicrophoneMute(); assert.equal(h.tracks[0].enabled, true);
    await h.api.endActiveWhatsappCall(); assert.equal(h.tracks[0].stopped, true); assert.equal(h.state.whatsappActiveCall, null);
    assert.equal(h.commands.find(command => command.path.endsWith('/terminate')).body.call_id, session.callId);
  });

  await check('cancel during microphone permission stops late stream and never posts an outgoing call', async h => {
    h.server.microphoneDeferred = deferred(); h.api.openWhatsappOutgoingDial({ phone: '919999000002' });
    const starting = h.api.startOutgoingWhatsappCall();
    for (let i = 0; i < 12 && !h.micRequests; i++) await flush();
    assert.equal(h.micRequests, 1); await h.api.endActiveWhatsappCall();
    const stream = h.stream(); h.server.microphoneDeferred.resolve(stream); await starting;
    assert(h.tracks.every(track => track.stopped)); assert.equal(h.commands.filter(command => command.path.endsWith('/outgoing')).length, 0); draftUnchanged(h);
  });

  await check('cancel before provider ID retains its exact guard until the late call is ended, then allows the next incoming call', async h => {
    h.server.outgoingDeferred = deferred(); h.api.openWhatsappOutgoingDial({ phone: '919999000002' });
    const starting = h.api.startOutgoingWhatsappCall();
    for (let i = 0; i < 15 && !h.server.lastOutgoing; i++) await flush();
    const first = plain(h.server.lastOutgoing); assert(first.client_request_id); const late = h.server.outgoingDeferred;
    await h.api.endActiveWhatsappCall(); await flush();
    assert(h.tracks[0].stopped);
    const cancel = h.commands.find(command => command.path.endsWith('/cancel-pending-outgoing'));
    assert.equal(cancel.body.client_request_id, first.client_request_id); assert.equal(cancel.body.operator_device_id, h.owner); assert.equal(cancel.body.phone, first.to);
    h.server.outgoingDeferred = null; await startOutgoing(h);
    const pending = h.api.runtime.session; assert(pending?.endUnconfirmed, 'keep the exact pending request guarded before placing any next call');
    assert.equal(h.commands.filter(command => command.path === '/api/whatsapp-calls/outgoing').length, 1);
    const incoming = h.addCall('wacid.NEXT_INCOMING'); await h.api.pollRecentWhatsappCalls();
    await h.api.routeWhatsappIncomingAction('accept', h.api.whatsappCallKey(incoming));
    assert.equal(h.api.runtime.session, pending, 'unconfirmed old provider call must still block a new session');
    late.resolve(h.outgoingResponse(first)); await starting;
    assert.equal(h.api.runtime.session, null);
    await h.api.routeWhatsappIncomingAction('accept', h.api.whatsappCallKey(incoming));
    const next=h.api.runtime.session;assert(next);assert.equal(next.mode,'incoming');assert.equal(h.state.whatsappActiveCall.call_id,next.callId);
    const end = h.commands.find(command => command.path.endsWith('/terminate') && command.body.call_id === `wacid.${first.client_request_id}`); assert(end);
    draftUnchanged(h);
  });

  await check('incoming remains in same Hub and preserves another customer draft', async h => {
    const call = h.addCall('wacid.INCOMING'); await h.api.pollRecentWhatsappCalls();
    assert.match(h.byId('shWhatsappIncomingBanner').innerHTML, /Bob Caller/); assert.equal(h.micRequests, 0);
    await h.api.routeWhatsappIncomingAction('accept', h.api.whatsappCallKey(call));
    assert.equal(h.peers[0].remoteDescription.sdp, OFFER); assert.equal(h.state.whatsappCallIsConnected, false);
    h.peers[0].connect(); assert.equal(h.state.whatsappCallIsConnected, true); draftUnchanged(h);
    await h.api.endActiveWhatsappCall(); assert.equal(h.tracks[0].stopped, true); assert.equal(h.state.whatsappActiveCall, null);
    assert.equal(h.commands.find(command => command.path === '/api/whatsapp-calls/terminate').body.call_id, call.call_id);
  });

  await check('declining a normal incoming call targets its exact ID without opening microphone', async h => {
    const call = h.addCall('wacid.DECLINED'); await h.api.pollRecentWhatsappCalls();
    await h.api.routeWhatsappIncomingAction('reject', h.api.whatsappCallKey(call));
    const reject = h.commands.find(command => command.path === '/api/whatsapp-calls/reject');
    assert.equal(reject.body.call_id, call.call_id); assert.equal(reject.body.operator_device_id, h.owner);
    assert.equal(h.micRequests, 0); assert.equal(h.api.findIncomingWhatsappCall(), null); draftUnchanged(h);
  });

  await check('failed connection state overrides stale connected ICE and stops local media', async h => {
    const call = h.addCall('wacid.FAILED'); await h.api.pollRecentWhatsappCalls(); await h.api.routeWhatsappIncomingAction('accept', h.api.whatsappCallKey(call));
    const session = h.api.runtime.session, peer = h.peers[0]; peer.connect();
    peer.connectionState = 'disconnected'; peer.onconnectionstatechange(); assert.equal(h.state.whatsappCallIsConnected, false); assert(session.disconnectTimer);
    peer.connect(); assert.equal(session.disconnectTimer, null);
    peer.connectionState = 'disconnected'; peer.onconnectionstatechange(); assert(session.disconnectTimer, 'second disconnect starts its own timeout');
    peer.connect(); peer.fail(); await flush(); await flush();
    assert.equal(h.api.runtime.session, null); assert.equal(h.tracks[0].stopped, true);
    assert(h.commands.some(command => command.path === '/api/whatsapp-calls/terminate' && command.body.call_id === call.call_id));
  });

  await check('provider cancellation before ID completes without a fabricated call or error', async h => {
    h.server.outgoingDeferred = deferred(); h.api.openWhatsappOutgoingDial({ phone: '919999000002' });
    const starting = h.api.startOutgoingWhatsappCall(); for (let i = 0; i < 15 && !h.server.lastOutgoing; i++) await flush();
    h.server.outgoingDeferred.resolve({ ok: true, cancelled: true, call_id: '', client_request_id: h.server.lastOutgoing.client_request_id }); await starting;
    assert.equal(h.api.runtime.session, null); assert.equal(h.api.runtime.pendingOutgoing.size, 0);
    assert.equal(h.api.runtime.finishedCall._uiEndLabel, 'Call cancelled'); assert.equal(h.state.whatsappCallLogs.length, 0);
    assert(h.tracks.every(track => track.stopped)); assert(!h.commands.some(command => command.path === '/api/whatsapp-calls/terminate'));
  });

  await check('normal incoming cancel during microphone permission stops late tracks and releases ownership', async h => {
    const call = h.addCall('wacid.INCOMING'); h.server.microphoneDeferred = deferred(); await h.api.pollRecentWhatsappCalls();
    const accepting = h.api.routeWhatsappIncomingAction('accept', h.api.whatsappCallKey(call));
    for (let i = 0; i < 12 && !h.micRequests; i++) await flush();
    await h.api.endActiveWhatsappCall(); const stream = h.stream(); h.server.microphoneDeferred.resolve(stream); await accepting;
    assert(h.tracks.every(track => track.stopped)); assert.equal(h.commands.filter(command => command.path === '/api/whatsapp-calls/accept').length, 0);
    await flush(); assert.equal(h.server.locks.has(call.call_id), false);
  });

  await check('retrying the same incoming call waits for its earlier delayed lock release', async h => {
    const call = h.addCall('wacid.RETRY'), gate = deferred(), fetch = h.ctx.appFetch;
    let releaseWaiting = false;
    h.ctx.appFetch = async (url, options) => {
      if (new URL(url).pathname === '/api/operator-call-locks/release' && !releaseWaiting) { releaseWaiting = true; await gate.promise; }
      return fetch(url, options);
    };
    h.server.microphoneDeferred = deferred(); await h.api.pollRecentWhatsappCalls();
    const first = h.api.routeWhatsappIncomingAction('accept', h.api.whatsappCallKey(call));
    for (let i = 0; i < 12 && !h.micRequests; i++) await flush();
    h.server.microphoneDeferred.reject(new Error('Microphone temporarily unavailable')); await first; await flush();
    assert.equal(releaseWaiting, true); assert.equal(h.api.runtime.session, null);
    h.server.microphoneDeferred = null;
    const retry = h.api.routeWhatsappIncomingAction('accept', h.api.whatsappCallKey(call));
    for (let i = 0; i < 8; i++) await flush();
    assert.equal(h.commands.filter(command => command.path === '/api/operator-call-locks/claim').length, 1, 'retry must wait until old release finishes');
    gate.resolve(); await retry; h.peers[0].connect();
    assert.equal(h.state.whatsappCallIsConnected, true); assert.equal(h.server.locks.get(call.call_id)?.operator_device_id, h.owner);
    assert.equal(h.commands.filter(command => command.path === '/api/operator-call-locks/claim').length, 2);
    assert.equal(h.commands.filter(command => command.path === '/api/operator-call-locks/release').length, 1);
    draftUnchanged(h);
  });

  await check('lost normal accept response ends the captured accepted call before releasing its lock', async h => {
    const call = h.addCall('wacid.LOST_ACCEPT'), fetch = h.ctx.appFetch;
    h.ctx.appFetch = async (url, options) => {
      const result = await fetch(url, options);
      if (new URL(url).pathname === '/api/whatsapp-calls/accept') throw new Error('Acceptance response was lost');
      return result;
    };
    await h.api.pollRecentWhatsappCalls(); await h.api.routeWhatsappIncomingAction('accept', h.api.whatsappCallKey(call)); await flush();
    assert.equal(h.api.runtime.session, null); assert(h.tracks.every(track => track.stopped));
    assert.equal(h.server.calls.get(call.call_id).status, 'ended'); assert.equal(h.server.locks.has(call.call_id), false);
    const terminate = h.commands.findIndex(command => command.path === '/api/whatsapp-calls/terminate');
    const release = h.commands.findIndex(command => command.path === '/api/operator-call-locks/release');
    assert(terminate >= 0 && release > terminate); assert.equal(h.commands[terminate].body.call_id, call.call_id); draftUnchanged(h);
  });

  await check('failed recipient acceptance declines only its transfer while source still owns the call', async h => {
    pendingTransfer(h); const fetch = h.ctx.appFetch;
    h.ctx.appFetch = async (url, options) => new URL(url).pathname === '/api/whatsapp-calls/accept' ?
      { ok: false, status: 500, json: async () => ({ ok: false, error: 'Provider acceptance failed' }) } : fetch(url, options);
    await h.api.pollRecentWhatsappCalls(); const call = h.api.findIncomingWhatsappCall(); await h.api.routeWhatsappIncomingAction('accept', h.api.whatsappCallKey(call));
    assert.equal(h.api.runtime.session, null); assert(h.tracks.every(track => track.stopped));
    assert.equal(h.server.pending.transfer.status, 'declined'); assert.equal(h.server.calls.get(call.call_id).status, 'connected');
    assert.equal(h.server.locks.get(call.call_id).operator_device_id, 'dev_source::session_source');
    assert(!h.commands.some(command => command.path === '/api/whatsapp-calls/terminate' || command.path === '/api/whatsapp-calls/reject'));
  });

  await check('lost completed transfer response reconciles exact target ownership before ending orphaned audio', async h => {
    pendingTransfer(h); const fetch = h.ctx.appFetch;
    h.ctx.appFetch = async (url, options) => {
      const result = await fetch(url, options); if (new URL(url).pathname === '/api/whatsapp-calls/accept') throw new Error('Transfer acceptance response was lost'); return result;
    };
    await h.api.pollRecentWhatsappCalls(); const call = h.api.findIncomingWhatsappCall(); await h.api.routeWhatsappIncomingAction('accept', h.api.whatsappCallKey(call));
    assert.equal(h.api.runtime.session, null); assert(h.tracks.every(track => track.stopped));
    assert.equal(h.server.calls.get(call.call_id).status, 'ended');
    const terminate = h.commands.find(command => command.path === '/api/whatsapp-calls/terminate'); assert.equal(terminate.body.call_id, call.call_id); assert.equal(terminate.body.operator_device_id, h.owner);
  });

  await check('pending source-owned transfer survives a real polling tick before Accept and skips generic claim', async h => {
    const transfer = pendingTransfer(h); await h.api.pollRecentWhatsappCalls();
    const record = h.api.findIncomingWhatsappCall(); assert(record); await h.api.routeWhatsappIncomingAction('open', h.api.whatsappCallKey(record));
    const interval = setInterval(() => h.api.pollRecentWhatsappCalls(), 1500);
    try { await delay(1750); } finally { clearInterval(interval); }
    assert(h.api.isPendingWhatsappSourceTransfer(h.api.findIncomingWhatsappCall())); assert.equal(h.micRequests, 0); assert.equal(h.state.whatsappCallPanelOpen, true);
    await h.api.acceptIncomingWhatsappCall();
    assert.equal(h.commands.filter(command => command.path === '/api/operator-call-locks/claim').length, 0, 'transfer must not preclaim source lock');
    const accept = h.commands.find(command => command.path === '/api/whatsapp-calls/accept'); assert.equal(accept.body.transfer_id, transfer.transfer_id); assert.equal(accept.body.call_id, transfer.call_id); assert.equal(accept.body.operator_device_id, h.owner);
    assert.equal(h.state.whatsappCallIsConnected, false); h.peers[0].connect(); assert.equal(h.state.whatsappCallIsConnected, true); draftUnchanged(h);
  });

  await check('expired or unexpected-owner transfers are never offered for acceptance', async h => {
    pendingTransfer(h, { expires_at: new Date(Date.now() - 1).toISOString() }); await h.api.pollRecentWhatsappCalls(); assert.equal(h.api.runtime.pendingTransfer, null);
    pendingTransfer(h); h.server.locks.set('wacid.TRANSFER', { operator_device_id: 'another::owner' }); await h.api.pollRecentWhatsappCalls(); assert.equal(h.api.runtime.pendingTransfer, null); assert.equal(h.micRequests, 0);
  });

  await check('declining a transfer never rejects the customer call', async h => {
    pendingTransfer(h); await h.api.pollRecentWhatsappCalls(); const call = h.api.findIncomingWhatsappCall();
    await h.api.routeWhatsappIncomingAction('reject', h.api.whatsappCallKey(call));
    assert(h.commands.some(command => command.path === '/api/operator-call-transfer/decline'));
    assert(!h.commands.some(command => command.path === '/api/whatsapp-calls/reject' || command.path === '/api/whatsapp-calls/terminate'));
    assert.equal(h.server.calls.get('wacid.TRANSFER').status, 'connected');
  });

  await check('source transfer preserves audio through provisional claim/renewal conflict/rollback, then stops only on confirmed takeover', async h => {
    const call = h.addCall('wacid.SOURCE'); await h.api.pollRecentWhatsappCalls(); await h.api.routeWhatsappIncomingAction('accept', h.api.whatsappCallKey(call)); h.peers[0].connect();
    h.server.devices = [
      { lock_device_id: 'dev_target::session_target', client_source: 'odoo_operator_hub', presence_expires_at: new Date(Date.now() + 80000).toISOString(), operator_name: 'Target operator', status: 'online', receive_calls: true, in_call: false },
      { lock_device_id: 'dev_old::session_old', client_source: 'odoo_operator_hub', presence_expires_at: new Date(Date.now() - 1).toISOString(), operator_name: 'Expired operator', status: 'online', receive_calls: true, in_call: false }
    ];
    await h.api.openWhatsappTransferChoices(); assert.match(h.byId('shWhatsappCallTransferList').innerHTML, /Target operator/); assert.doesNotMatch(h.byId('shWhatsappCallTransferList').innerHTML, /Expired operator/);
    await h.api.requestWhatsappCallTransfer('dev_target::session_target'); assert.equal(h.tracks[0].stopped, false); assert.equal(h.state.whatsappCallIsConnected, true);
    const request = h.commands.find(command => command.path === '/api/operator-call-transfer/request'); assert.equal(request.body.from_operator_device_id, h.owner); assert.equal(request.body.to_operator_device_id, 'dev_target::session_target');
    const sourceLock = h.server.locks.get(call.call_id), session = h.api.runtime.session;
    const provisional = { call_id: call.call_id, operator_device_id: 'dev_target::session_target', operator_name: 'Target operator', action: 'transfer_accepting', transfer_id: session.sentTransfer.transfer_id, expires_at: new Date(Date.now() + 80000).toISOString() };
    h.server.locks.set(call.call_id, provisional); await h.api.pollWhatsappActiveSession();
    assert.equal(h.api.runtime.session, session); assert.equal(h.tracks[0].stopped, false);
    const fetch = h.ctx.appFetch; h.ctx.appFetch = async (url, options) => new URL(url).pathname === '/api/operator-call-locks/claim' ?
      { ok: false, status: 409, json: async () => ({ ok: false, unavailable: true, error: 'Source still in call' }) } : fetch(url, options);
    session.lastLockRenewedAt = 0; await h.api.postWhatsappHubPresence({ force: true });
    assert.equal(h.api.runtime.session, session); assert.equal(h.tracks[0].stopped, false);
    h.ctx.appFetch = fetch; h.server.locks.set(call.call_id, sourceLock); await h.api.pollWhatsappActiveSession();
    assert.equal(h.api.runtime.session, session); assert.equal(h.state.whatsappCallIsConnected, true);
    h.server.locks.set(call.call_id, { ...provisional, action: 'accepted', accepted_at: new Date().toISOString() }); await h.api.pollWhatsappActiveSession();
    assert.equal(h.api.runtime.session, null); assert.equal(h.tracks[0].stopped, true); assert(!h.commands.some(command => command.path === '/api/whatsapp-calls/terminate'));
  });

  await check('incoming and outgoing deep links focus/prefill only without microphone, calls, or chat jumps', async h => {
    h.addCall('wacid.LINK'); h.ctx.location.search = '?mode=call&call_id=wacid.LINK'; await h.api.openIncomingWhatsappNotificationFromUrl();
    assert.equal(h.micRequests, 0); assert.equal(h.commands.length, 0); draftUnchanged(h);
    h.ctx.location.search = '?mode=outgoing&phone=919999000003&name=Charlie'; await h.api.openIncomingWhatsappNotificationFromUrl();
    assert.equal(h.ctx.whatsappCallPhoneInput.value, '+919999000003'); assert.equal(h.api.runtime.dialTarget.customer_name, 'Charlie'); assert.equal(h.micRequests, 0); assert.equal(h.commands.length, 0); draftUnchanged(h);
  });

  await check('transfer links require exact current-session pending transfer and never substitute another', async h => {
    const transfer = pendingTransfer(h); h.ctx.location.search = `?mode=transfer&call_id=${transfer.call_id}&transfer_id=${transfer.transfer_id}`;
    assert.equal(await h.api.openIncomingWhatsappNotificationFromUrl(), true); assert.equal(h.micRequests, 0); assert.equal(h.commands.length, 0); draftUnchanged(h);
    const before = h.api.runtime.focusedCallKey; h.ctx.location.search = '?mode=transfer&call_id=wacid.DIFFERENT&transfer_id=tr_wrong';
    assert.equal(await h.api.openIncomingWhatsappNotificationFromUrl(), false); assert.equal(h.api.runtime.focusedCallKey, before); assert.equal(h.micRequests, 0);
  });

  await check('recovery is status-only even for a real ringing call; ambiguous IDs and modes fail closed', async h => {
    const call = h.addCall('wacid.RECOVER'); h.ctx.location.search = `?mode=recovery&call_id=${call.call_id}`; await h.api.openIncomingWhatsappNotificationFromUrl();
    assert.equal(h.ctx.whatsappCallAcceptBtn.disabled, true); assert.equal(h.api.findAnswerableWhatsappCall(), null); assert.equal(h.api.findIncomingWhatsappCall(), null); assert.equal(h.micRequests, 0);
    for (const query of ['?mode=call&call_id=A&callId=B', '?mode=outgoing&mode=transfer&phone=919999000003', '?mode=call&call_id=A&call_id=A', '?mode=transfer&transfer_id=bad%20id&call_id=A']) {
      h.ctx.location.search = query; assert.equal(await h.api.openIncomingWhatsappNotificationFromUrl(), false);
    }
    assert.equal(h.commands.length, 0); draftUnchanged(h);
  });

  await check('presence respects shared manual availability and never claims push subscription', async h => {
    await h.api.postWhatsappHubPresence({ force: true }); assert.equal(h.api.runtime.presenceConfirmed, true);
    const profile = JSON.parse(h.localStorage.getItem('sh_operator_device')); profile.status = 'dnd'; h.localStorage.setItem('sh_operator_device', JSON.stringify(profile));
    await h.api.postWhatsappHubPresence({ force: true }); const last = h.commands.filter(command => command.path.endsWith('/heartbeat')).at(-1);
    assert.equal(last.body.status, 'dnd'); assert.equal(last.body.lockDeviceId, h.owner); assert.equal(last.body.client_source, 'odoo_operator_hub'); assert.equal(last.body.inCall, false);
    assert(!h.commands.some(command => command.path.includes('/push/')));
    await startOutgoing(h); assert.equal(h.commands.filter(command => command.path.endsWith('/outgoing')).length, 0);
  });

  await check('only explicit availability changes sync the paired base preference; closing does not persist Offline', async h => {
    await h.api.postWhatsappHubPresence({ force: true }); assert(!h.commands.some(command => command.path.endsWith('/status')));
    await h.api.setWhatsappCallAvailability('dnd');
    const preferences = h.commands.filter(command => command.path === '/api/operator-devices/status'); assert.equal(preferences.length, 1);
    assert.deepEqual(preferences[0].body, { deviceId: 'dev_hub', status: 'dnd' });
    assert.equal(h.api.runtime.profile.status, 'dnd');
    await h.api.postWhatsappHubPresence({ force: true, closing: true });
    assert.equal(h.commands.filter(command => command.path === '/api/operator-devices/status').length, 1);
    assert.equal(h.commands.filter(command => command.path.endsWith('/heartbeat')).at(-1).body.status, 'offline');
    assert.equal(JSON.parse(h.localStorage.getItem('sh_operator_device')).status, 'dnd');
  });

  await check('phone and channel link parsing rejects text and numeric coercions while preserving normal formatting', async h => {
    for (const phone of ['abc919999000001', { value: '919999000001' }, true, 1.2, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(h.api.validWhatsappNotificationTarget({ mode: 'outgoing', phone }), null);
    }
    assert.equal(h.api.validWhatsappNotificationTarget({ mode: 'outgoing', phone: '+91 (999) 900-0001' }).phone, '919999000001');
    assert.equal(h.api.validWhatsappNotificationTarget({ mode: 'outgoing', phone: 919999000001 }).phone, '919999000001');
    for (const id of ['1e3', '+1', ' 1', '1.0', true, {}, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(h.api.validWhatsappNotificationTarget({ mode: 'chat', channel_id: id }), null);
    }
    assert.equal(h.api.validWhatsappNotificationTarget({ mode: 'chat', channel_id: '501' }).channelId, 501);
    assert.equal(h.api.validWhatsappNotificationTarget({ mode: 'chat', channel_id: 501 }).channelId, 501);
    assert.equal(h.api.whatsappNotificationTargetFromQuery(new URLSearchParams('channel_id=1e3')), null);
    assert.equal(h.api.whatsappNotificationTargetFromQuery(new URLSearchParams('channel=501&channelId=502')), null);
    assert.equal(h.micRequests, 0); assert.equal(h.commands.length, 0);
  });

  console.log(`PASS ${groups} focused Hub r7 lifecycle groups; all backend/media/notification actions synthetic.`);
  saveResults();
})().catch(error => { saveResults(error); console.error(error); process.exitCode = 1; });
