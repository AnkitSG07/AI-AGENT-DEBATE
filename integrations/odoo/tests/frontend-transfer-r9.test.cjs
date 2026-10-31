const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
process.argv[2] ||= process.env.SH_TEST_EMBED || path.resolve(__dirname, '../smart-handicrafts-whatsapp-embed-r13.html');
const { makeHarness, startOutgoing, pendingTransfer, flush, plain, ANSWER, testedFile, testedHash } = require('./test_r7_call_lifecycle.cjs');
const results = [];

function hooks(h) {
  for (const name of ['canTransferWhatsappCall', 'renderWhatsappTransferChoices', 'pollWhatsappSourceTransfer', 'cancelWhatsappSourceTransfer', 'loadWhatsappCallConfiguration']) h.api[name] = vm.runInContext(name, h.ctx);
  return h;
}

async function incoming(h, id = 'wacid.R9_TEST') {
  const call = h.addCall(id);
  await h.api.pollRecentWhatsappCalls();
  await h.api.routeWhatsappIncomingAction('accept', h.api.whatsappCallKey(call));
  const session = h.api.runtime.session;
  assert(session, 'ordinary incoming call creates a session');
  assert.equal(h.peers.length, 1);
  h.peers[0].connect();
  await flush();
  assert.equal(h.state.whatsappCallIsConnected, true);
  return session;
}

function legacySource(h, session) {
  const transfer = { transfer_id: 'tr_r9_old', call_id: session.callId, from_device_id: h.owner,
    to_device_id: 'other_device::other_session', from_operator: 'Hub Operator', status: 'pending',
    expires_at: new Date(Date.now() + 60000).toISOString() };
  session.sentTransfer = transfer;
  h.api.renderWhatsappTransferChoices();
  return transfer;
}

function legacyResponse(h, session, responder) {
  const base = h.ctx.appFetch;
  h.ctx.appFetch = async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    if (!url.pathname.startsWith('/api/operator-call-transfer/')) return base(rawUrl, options);
    const body = options.body ? JSON.parse(options.body) : null;
    if (body) h.commands.push({ path: url.pathname, body }); else h.reads.push(url.pathname + url.search);
    const result = await responder(url, body);
    return { ok: true, status: 200, json: async () => plain(result) };
  };
}

async function check(name, test) {
  const h = hooks(makeHarness());
  let failure;
  try { await test(h); await flush(); } catch (error) { failure = error; }
  try { await h.cleanup(); } catch (error) { failure ||= error; }
  results.push({ name, passed: !failure, ...(failure ? { error: String(failure.stack || failure) } : {}) });
  console.log((failure ? 'FAIL ' : 'PASS ') + name);
}

(async () => {
  await check('ordinary incoming answer uses one microphone, one provider accept; end releases audio', async h => {
    const session = await incoming(h);
    assert.equal(h.micRequests, 1);
    const accepts = h.commands.filter(c => c.path === '/api/whatsapp-calls/accept');
    assert.equal(accepts.length, 1);
    assert.equal('transfer_id' in accepts[0].body, false);
    assert.equal(h.api.canTransferWhatsappCall(), false);
    assert.equal(h.ctx.whatsappCallTransferBtn.disabled, true);
    assert.equal(h.ctx.whatsappCallTransferBtn.textContent, 'Transfer unavailable');
    await h.api.endActiveWhatsappCall();
    assert.equal(session.finished, true);
    assert(h.tracks.every(track => track.stopped));
    assert.equal(h.peers[0].connectionState, 'closed');
    assert.equal(h.state.whatsappCallPanelOpen, false);
  });

  await check('old backend with no transfer capability cannot open a picker or request transfer', async h => {
    await incoming(h);
    assert.equal(h.api.runtime.callConfig?.transfer, undefined);
    await h.api.openWhatsappTransferChoices();
    await h.api.requestWhatsappCallTransfer('other_device::other_session');
    assert.equal(h.commands.filter(c => c.path.startsWith('/api/operator-call-transfer/')).length, 0);
    assert.equal(h.reads.filter(p => p.startsWith('/api/operator-devices?')).length, 0);
    assert.equal(h.api.runtime.transferSelectorOpen, false);
    assert.equal(h.micRequests, 1);
    assert.equal(h.peers.length, 1);
    assert(h.toasts.some(value => value.includes('Call transfer unavailable')));
  });

  await check('a server available=true flag cannot enable an unimplemented media adapter', async h => {
    await incoming(h);
    h.api.runtime.callConfig = { transfer: { available: true, enabled: true, mode: 'pretend_supported' } };
    assert.equal(h.api.canTransferWhatsappCall(), false);
    await h.api.routeWhatsappIncomingAction('transfer');
    await h.api.routeWhatsappIncomingAction('send-transfer', 'other_device::other_session');
    assert.equal(h.commands.filter(c => c.path.startsWith('/api/operator-call-transfer/')).length, 0);
    assert.equal(h.commands.filter(c => c.path === '/api/whatsapp-calls/accept').length, 1);
    assert.equal(h.micRequests, 1);
  });

  await check('legacy target invitation cannot ring, open microphone, claim ownership or repeat accept', async h => {
    const transfer = pendingTransfer(h);
    await h.api.pollRecentWhatsappCalls();
    assert.equal(await h.api.pollWhatsappPendingTransfer(), null);
    assert.equal(h.api.runtime.pendingTransfer, null);
    assert.equal(h.api.findIncomingWhatsappCall(), null);
    assert.equal(h.api.findAnswerableWhatsappCall(), null);
    const call = h.server.calls.get(transfer.call_id);
    await h.api.routeWhatsappIncomingAction('accept', h.api.whatsappCallKey(call));
    await h.api.acceptIncomingWhatsappCall();
    assert.equal(h.micRequests, 0);
    assert.equal(h.peers.length, 0);
    assert.equal(h.api.runtime.session, null);
    assert.equal(h.commands.filter(c => /\/accept$|\/claim$/.test(c.path)).length, 0);
  });

  await check('a transfer notification is explanatory only and cannot mutate call state', async h => {
    const transfer = pendingTransfer(h);
    const opened = await h.api.openWhatsappCallNotification({ mode: 'transfer', transfer_id: transfer.transfer_id, call_id: transfer.call_id });
    assert.equal(opened, false);
    assert.equal(h.micRequests, 0);
    assert.equal(h.commands.length, 0);
    assert.equal(h.api.runtime.session, null);
    assert(h.toasts.some(value => value.includes('Call transfer unavailable')));
  });

  await check('an exact legacy target accepted lock does not prematurely stop source audio', async h => {
    const session = await incoming(h);
    const transfer = legacySource(h, session);
    const targetLock = { call_id: session.callId, operator_device_id: transfer.to_device_id,
      transfer_id: transfer.transfer_id, action: 'accepted', media_connected: false };
    h.server.locks.set(session.callId, targetLock);
    h.api.mergeWhatsappCallLogs([{ ...h.server.calls.get(session.callId), lock: targetLock, locked_by_other: true }]);
    assert.equal(h.api.runtime.session, session);
    assert.equal(session.finished, false);
    assert.equal(h.peers[0].connectionState, 'connected');
    assert(h.tracks.every(track => !track.stopped));
    assert.equal(h.api.whatsappCallCurrentStatus(session.call), 'Call connected');
    session.lastLockRenewedAt = 0;
    await h.api.postWhatsappHubPresence({ force: true });
    assert.equal(h.api.runtime.session, session, 'renewal conflict must not turn bookkeeping into handoff proof');
  });

  await check('an unrelated foreign owner still stops local audio safely', async h => {
    const session = await incoming(h);
    legacySource(h, session);
    h.api.mergeWhatsappCallLogs([{ ...h.server.calls.get(session.callId), locked_by_other: true,
      lock: { call_id: session.callId, operator_device_id: 'unrelated_owner', transfer_id: 'unrelated_transfer', action: 'accepted' } }]);
    assert.equal(session.finished, true);
    assert.equal(h.peers[0].connectionState, 'closed');
    assert(h.tracks.every(track => track.stopped));
  });

  await check('provider terminal event always closes audio despite an exact legacy transfer lock', async h => {
    const session = await incoming(h);
    const transfer = legacySource(h, session);
    h.api.mergeWhatsappCallLogs([{ ...h.server.calls.get(session.callId), event: 'terminate', status: 'ended', timestamp: Date.now() / 1000,
      locked_by_other: true, lock: { call_id: session.callId, operator_device_id: transfer.to_device_id, transfer_id: transfer.transfer_id, action: 'accepted' } }]);
    assert.equal(session.finished, true);
    assert(h.tracks.every(track => track.stopped));
  });

  await check('legacy decline and expiry refresh status without ending the source call', async h => {
    const session = await incoming(h);
    const transfer = legacySource(h, session);
    let status = 'declined';
    legacyResponse(h, session, url => {
      assert.equal(url.pathname, '/api/operator-call-transfer/status');
      assert.equal(url.searchParams.get('operator_device_id'), h.owner);
      assert.equal(url.searchParams.get('transfer_id'), transfer.transfer_id);
      assert.equal(url.searchParams.get('call_id'), session.callId);
      return { ok: true, pending: false, transfer: { ...transfer, status } };
    });
    await h.api.pollWhatsappSourceTransfer(session);
    assert.match(h.byId('shWhatsappCallTransferStatus').textContent, /declined/);
    status = 'expired'; session.transferStatusCheckedAt = 0;
    await h.api.pollWhatsappSourceTransfer(session);
    assert.match(h.byId('shWhatsappCallTransferStatus').textContent, /expired/);
    assert.equal(session.finished, false);
    assert(h.tracks.every(track => !track.stopped));
    assert.equal(h.commands.filter(c => /\/terminate$|\/reject$/.test(c.path)).length, 0);
  });

  await check('cancelling a legacy invitation uses exact source identity and preserves customer audio', async h => {
    const session = await incoming(h);
    const transfer = legacySource(h, session);
    legacyResponse(h, session, (url, body) => {
      assert.equal(url.pathname, '/api/operator-call-transfer/cancel');
      assert.equal(body.operator_device_id, h.owner);
      assert.equal(body.call_id, session.callId);
      assert.equal(body.transfer_id, transfer.transfer_id);
      return { ok: true, transfer: { ...transfer, status: 'cancelled' } };
    });
    await h.api.routeWhatsappIncomingAction('cancel-transfer');
    assert.match(h.byId('shWhatsappCallTransferStatus').textContent, /cancelled/);
    assert.equal(session.finished, false);
    assert(h.tracks.every(track => !track.stopped));
    assert.equal(h.commands.filter(c => c.path.endsWith('/terminate')).length, 0);
  });

  await check('mismatched legacy transfer responses cannot replace source status or ownership', async h => {
    const session = await incoming(h);
    const transfer = legacySource(h, session);
    legacyResponse(h, session, () => ({ ok: true, transfer: { ...transfer, call_id: 'other_call', status: 'cancelled' },
      call: { call_id: 'other_call', event: 'terminate', status: 'ended' } }));
    await h.api.pollWhatsappSourceTransfer(session);
    assert.equal(session.sentTransfer.status, 'pending');
    await h.api.cancelWhatsappSourceTransfer();
    assert.equal(session.sentTransfer.status, 'pending');
    assert.match(h.byId('shWhatsappCallTransferStatus').textContent, /could not be verified/);
    assert.equal(session.finished, false);
  });

  await check('a status response started before cancellation cannot resurrect the invitation', async h => {
    const session = await incoming(h);
    const transfer = legacySource(h, session);
    let resolveStatus;
    const oldStatus = new Promise(resolve => { resolveStatus = resolve; });
    legacyResponse(h, session, url => url.pathname.endsWith('/status') ? oldStatus :
      { ok: true, transfer: { ...transfer, status: 'cancelled' } });
    const polling = h.api.pollWhatsappSourceTransfer(session);
    await h.api.cancelWhatsappSourceTransfer();
    assert.equal(session.sentTransfer.status, 'cancelled');
    resolveStatus({ ok: true, pending: true, transfer: { ...transfer, status: 'pending' } });
    await polling;
    assert.equal(session.sentTransfer.status, 'cancelled');
    assert.match(h.byId('shWhatsappCallTransferStatus').textContent, /cancelled/);
    assert.equal(session.finished, false);
  });

  await check('ordinary outgoing call still waits for provider acceptance plus connected transport', async h => {
    const session = await startOutgoing(h);
    h.peers[0].connect();
    assert.equal(h.state.whatsappCallIsConnected, false);
    Object.assign(h.server.calls.get(session.callId), { sdp: ANSWER, sdp_type: 'answer', remote_answer_available: true,
      event: 'accepted', status: 'connected', provider_answer_confirmed: true, provider_status: 'ACCEPTED', timestamp: Date.now() / 1000 });
    await h.api.pollWhatsappActiveSession(session);
    await flush();
    assert.equal(h.state.whatsappCallIsConnected, true);
    assert.equal(h.commands.filter(c => c.path.endsWith('/outgoing')).length, 1);
    assert.equal(h.micRequests, 1);
    await h.api.endActiveWhatsappCall();
    assert.equal(session.finished, true);
  });

  await check('R12 artifact versions, identical text copy and unambiguous colleague labels', async () => {
    const html = fs.readFileSync(testedFile, 'utf8');
    assert.match(html, /data-build="2026\.10\.30-ui-r13"/);
    assert.match(html, /Interface r13/);
    assert.equal(fs.readFileSync(testedFile.replace(/\.html$/, '.txt'), 'utf8'), html);
    assert.match(html, /<strong>Add colleague to chat<\/strong>/);
    assert.doesNotMatch(html, /Add a colleague|<b>Add colleague<\/b>|<strong>Add Colleague<\/strong>/);
    assert.match(html, /id="shWhatsappCallTransferUnavailable"/);
    assert.doesNotMatch(html, /fetchWhatsappCallJson\("\/api\/operator-call-transfer\/(?:accept|request)"/);
    for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) if (script[1].trim()) new vm.Script(script[1]);
  });

  const report = { build: '2026.10.30-ui-r13', tested_file: testedFile, tested_html_sha256: testedHash,
    all_actions_synthetic: true, live_calls_or_production_mutations: false,
    count: results.length, passed: results.filter(r => r.passed).length, failed: results.filter(r => !r.passed).length,
    completed_at: new Date().toISOString(), results };
  fs.writeFileSync(path.join(__dirname, 'frontend-transfer-r9-results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, failed: report.failed, sha256: testedHash }));
  if (report.failed) process.exitCode = 1;
})();
