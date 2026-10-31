/* Browser fallback regression cases retained from the earlier tested Hub.
 * The removed browser transfer protocol is covered by frontend-transfer-r9.test.cjs;
 * native room transfer is covered by the Android/backend R12 suites. */
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
process.argv[2] ||= process.env.SH_TEST_EMBED || path.resolve(__dirname, '../smart-handicrafts-whatsapp-embed-r13.html');
const {makeHarness,startOutgoing,pendingTransfer,draftUnchanged,plain,flush,delay,deferred,OFFER,ANSWER,testedFile,testedHash} = require('./test_r7_call_lifecycle.cjs');
const results=[];
async function check(name, run) {
 const h=makeHarness(); let error;
 try {await run(h);await flush();} catch(e) {error=e;}
 try {await h.cleanup();} catch(e) {error ||= e;}
 results.push({name,passed:!error,...(error?{error:String(error.stack||error)}:{})});
 console.log((error?'FAIL ':'PASS ')+name);
}
(async()=>{
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

  await check('incoming and outgoing deep links focus/prefill only without microphone, calls, or chat jumps', async h => {
    h.addCall('wacid.LINK'); h.ctx.location.search = '?mode=call&call_id=wacid.LINK'; await h.api.openIncomingWhatsappNotificationFromUrl();
    assert.equal(h.micRequests, 0); assert.equal(h.commands.length, 0); draftUnchanged(h);
    h.ctx.location.search = '?mode=outgoing&phone=919999000003&name=Charlie'; await h.api.openIncomingWhatsappNotificationFromUrl();
    assert.equal(h.ctx.whatsappCallPhoneInput.value, '+919999000003'); assert.equal(h.api.runtime.dialTarget.customer_name, 'Charlie'); assert.equal(h.micRequests, 0); assert.equal(h.commands.length, 0); draftUnchanged(h);
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
 fs.writeFileSync(path.join(__dirname,'legacy-hub-r12-results.json'),JSON.stringify({testedFile,testedHash,all_actions_synthetic:true,passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length,results},null,2)+'\n');
 if(results.some(x=>!x.passed))process.exitCode=1;
})();
