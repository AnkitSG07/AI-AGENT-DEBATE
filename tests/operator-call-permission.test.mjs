import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createOperatorCallPermission, createMetaCallPermissionProvider, parseCallPermissionStatus } from '../operator-call-permission.js';
import { CallRuntime } from '../call-runtime/call-runtime.mjs';
import { MediaError } from '../media/errors.mjs';
import { FirestoreFake, deferred } from './operator-r12-helpers.mjs';

const START = 1800000000000, TO = '919000000001', OTHER = '919000000002';
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const noPermission = () => ({ messaging_product: 'whatsapp', permission: { status: 'no_permission' }, actions: [
  { action_name: 'send_call_permission_request', can_perform_action: true, limits: [
    { time_period: 'PT24H', max_allowed: 1, current_usage: 0 }, { time_period: 'P7D', max_allowed: 2, current_usage: 0 }] },
  { action_name: 'start_call', can_perform_action: false, limits: [] }
] });
const granted = (status = 'permanent', expiration = START / 1000 + 60) => ({
  messaging_product: 'whatsapp', permission: { status, ...(status === 'temporary' ? { expiration_time: expiration } : {}) },
  actions: [{ action_name: 'send_call_permission_request', can_perform_action: false },
    { action_name: 'start_call', can_perform_action: true }]
});
const ctx = name => ({ headers: { authorization: `Bearer fixture-${name}` } });
function fixture({ db = new FirestoreFake() } = {}) {
  let now = START, statusData = noPermission(), checkHook = null, sendHook = null, enabled = true;
  const calls = [];
  const devices = new Map(['a', 'b'].map(name => [name, { deviceId: `device-${name}`, userId: `operator-${name}`,
    tenantId: 'smart-handicrafts', credentialGeneration: 1, credentialExpiresAt: START + 3600000,
    nativeBuild: 13, mediaProtocol: 'sh-room-audio-v1', revoked: false, authenticated: true, canCall: true }]));
  const authOverrides = new Map();
  const runtime = new CallRuntime({ store: { durable: true }, provider: { kind: 'fixture', config: {
    metaToken: 'synthetic-provider-token', apiVersion: '26.0', fingerprint: 'synthetic-config-only' } },
    phoneNumberId: '123456789012345', minimumNativeBuild: 10,
    authenticate: async req => {
      const name = String(req.headers?.authorization || '').replace('Bearer fixture-', '');
      if (!devices.has(name)) throw new MediaError('DEVICE_AUTH_REQUIRED', 'Enroll this device first.', 401);
      return { ...devices.get(name), ...authOverrides.get(name) };
    },
    resolveDevice: async id => [...devices.values()].find(value => value.deviceId === id),
    capabilities: async () => ({ roomCalling: enabled }), now: () => now });
  const fetchImpl = async (value, options) => {
    const url = new URL(value);
    assert.equal(url.origin, 'https://graph.facebook.com');
    assert.equal(options.headers.Authorization, 'Bearer synthetic-provider-token');
    assert.equal(options.redirect, 'error');
    const call = { method: options.method, url: String(url), body: options.body ? JSON.parse(options.body) : null };
    calls.push(call);
    if (options.method === 'GET') {
      assert.equal(url.pathname, '/v26.0/123456789012345/call_permissions');
      assert.ok([TO, OTHER].includes(url.searchParams.get('user_wa_id')));
      if (checkHook) return checkHook(call);
      return json(statusData);
    }
    assert.equal(options.method, 'POST'); assert.equal(url.pathname, '/v26.0/123456789012345/messages');
    if (sendHook) return sendHook(call);
    return json({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.synthetic_accepted_message' }] });
  };
  const options = { getRuntime: () => runtime, getFirestore: () => db, collectionPrefix: () => 'fixture_sh', clock: () => now,
    providerFactory: params => createMetaCallPermissionProvider({ ...params, fetchImpl }) };
  return { api: createOperatorCallPermission(options), options, runtime, devices, authOverrides, db, calls,
    setNow: value => { now = value; }, setStatus: value => { statusData = value; },
    onCheck: value => { checkHook = value; }, onSend: value => { sendHook = value; },
    enable: value => { enabled = value; }, posts: () => calls.filter(row => row.method === 'POST'),
    input: (extra = {}) => ({ to: TO, requestId: 'request-one-0001', ...extra }) };
}

for (const type of ['permanent', 'temporary']) test(`provider ${type} permission requires fresh positive call-action eligibility`, () => {
  const data = granted(type), result = parseCallPermissionStatus(data, START);
  assert.equal(result.status, type); assert.equal(result.canCall, true); assert.equal(result.canRequest, false);
  assert.equal(result.expiresAtMs, type === 'temporary' ? START + 60000 : null);
  data.actions.find(x => x.action_name === 'start_call').can_perform_action = false;
  assert.equal(parseCallPermissionStatus(data, START).canCall, false);
});
test('temporary permission expires at the exact provider seconds boundary', () => {
  assert.equal(parseCallPermissionStatus(granted('temporary', START / 1000), START).status, 'expired');
  assert.equal(parseCallPermissionStatus(granted('temporary', START / 1000 - 1), START).canCall, false);
});
test('missing or malformed expiry never becomes a temporary grant', () => {
  for (const expiry of [undefined, null, '1800000060', -1, 0, NaN, 1.5, Number.MAX_SAFE_INTEGER]) {
    const data = granted('temporary'); data.permission.expiration_time = expiry;
    const result = parseCallPermissionStatus(data, START);
    assert.equal(result.status, 'unknown'); assert.equal(result.canCall, false); assert.equal(result.canRequest, false);
  }
});
test('unknown permission states and absent eligibility actions fail closed', () => {
  for (const status of ['granted', 'pending', 'denied', 'future_state']) {
    const data = granted(); data.permission.status = status;
    const result = parseCallPermissionStatus(data, START);
    assert.equal(result.status, 'unknown'); assert.equal(result.canCall, false); assert.equal(result.canRequest, false);
  }
  assert.equal(parseCallPermissionStatus({ permission: { status: 'permanent' }, actions: [] }, START).canCall, false);
});
test('permission limits are provider data; exhausted and contradictory eligibility is refused', () => {
  const data = noPermission();
  data.actions[0].limits = [{ time_period: 'P3D', max_allowed: 7, current_usage: 6 }];
  const result = parseCallPermissionStatus(data, START);
  assert.equal(result.canRequest, true);
  assert.deepEqual(result.limits[0], { actionName: 'send_call_permission_request', timePeriod: 'P3D', maxAllowed: 7, currentUsage: 6 });
  data.actions[0].limits[0].current_usage = 7;
  assert.equal(parseCallPermissionStatus(data, START).canRequest, false);
});
test('duplicate or malformed action contracts cannot authorize a request', () => {
  for (const data of [
    { permission: { status: 'no_permission' }, actions: [{ action_name: 'send_call_permission_request', can_perform_action: 'true' }] },
    { ...noPermission(), actions: [...noPermission().actions, noPermission().actions[0]] },
    { permission: { status: 'no_permission' }, actions: [{ action_name: 'send_call_permission_request', can_perform_action: true, limits: [{}] }] },
    { permission: { status: 'no_permission' }, actions: {} }, { error: { message: 'synthetic' } }
  ]) assert.throws(() => parseCallPermissionStatus(data, START), { code: 'CALL_PERMISSION_STATUS_UNAVAILABLE' });
});
test('opening service and GET status perform no customer message send or receipt allocation', async () => {
  const f = fixture(); assert.equal(f.calls.length, 0);
  const result = await f.api.status(ctx('a'), { to: TO });
  assert.equal(result.to, TO); assert.equal(result.permission.status, 'no_permission'); assert.equal(result.permission.canRequest, true);
  assert.equal(result.request, null); assert.equal(f.posts().length, 0); assert.equal(f.db.documents.size, 0);
});
test('explicit request dispatches exact established Graph body and distinguishes sent from consent', async () => {
  const f = fixture(), result = await f.api.request(ctx('a'), f.input());
  assert.equal(f.posts().length, 1);
  assert.deepEqual(f.posts()[0].body, { messaging_product: 'whatsapp', recipient_type: 'individual', to: TO, type: 'interactive',
    interactive: { type: 'call_permission_request', body: { text: 'May Smart Handicrafts call you about your enquiry? Please choose whether to allow calls.' },
      action: { name: 'call_permission_request' } } });
  assert.equal(result.request.state, 'sent'); assert.equal(result.request.messageId, 'wamid.synthetic_accepted_message');
  assert.equal(result.permission.canCall, false); assert.equal(result.permission.canRequest, false);
  assert.equal(result.request.replayed, false);
});
test('request ID replay after a confirmed send never sends a second message', async () => {
  const f = fixture(); await f.api.request(ctx('a'), f.input());
  const result = await f.api.request(ctx('a'), f.input());
  assert.equal(result.request.replayed, true); assert.equal(result.request.state, 'sent'); assert.equal(f.posts().length, 1);
});
test('same request survives server recreation without a duplicate dispatch', async () => {
  const f = fixture(); await f.api.request(ctx('a'), f.input());
  const recreated = createOperatorCallPermission(f.options);
  assert.equal((await recreated.request(ctx('a'), f.input())).request.state, 'sent'); assert.equal(f.posts().length, 1);
});
test('simultaneous identical taps and two controllers produce only one dispatch', async () => {
  const f = fixture(), other = createOperatorCallPermission(f.options);
  const values = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? other : f.api).request(ctx('a'), f.input())));
  assert.equal(values.length, 12); assert.equal(f.posts().length, 1);
  assert.ok(values.every(value => ['sending', 'sent'].includes(value.request.state)));
});
test('different devices and request IDs share a destination fence during dispatch', async () => {
  const f = fixture(), entered = deferred(), gate = deferred();
  f.onSend(async () => { entered.resolve(); await gate.promise; return json({ messages: [{ id: 'wamid.synthetic_message' }] }); });
  const first = f.api.request(ctx('a'), f.input()); await entered.promise;
  await assert.rejects(() => f.api.request(ctx('b'), f.input({ requestId: 'request-other-0002' })), { code: 'CALL_PERMISSION_REQUEST_BLOCKED' });
  gate.resolve(); await first; assert.equal(f.posts().length, 1);
});
test('request IDs cannot be reused for another customer', async () => {
  const f = fixture(); await f.api.request(ctx('a'), f.input());
  await assert.rejects(() => f.api.request(ctx('a'), f.input({ to: OTHER })), { code: 'CALL_PERMISSION_REQUEST_CONFLICT' });
  await assert.rejects(() => f.api.status(ctx('a'), f.input({ to: OTHER })), { code: 'CALL_PERMISSION_REQUEST_CONFLICT' });
  assert.equal(f.posts().length, 1);
});
test('enrollment credential rotation cannot adopt or replay the old operation identity', async () => {
  const f = fixture(); await f.api.request(ctx('a'), f.input()); f.devices.get('a').credentialGeneration = 2;
  await assert.rejects(() => f.api.request(ctx('a'), f.input()), { code: 'CALL_PERMISSION_REQUEST_CONFLICT' });
  assert.equal(f.posts().length, 1);
});
test('GET without a request ID exposes only this enrollment latest receipt', async () => {
  const f = fixture(); await f.api.request(ctx('a'), f.input());
  assert.equal((await f.api.status(ctx('a'), { to: TO })).request.requestId, f.input().requestId);
  const other = await f.api.status(ctx('b'), { to: TO });
  assert.equal(other.request, null); assert.equal(other.permission.canRequest, false);
  assert.equal(JSON.stringify(other).includes('device-a'), false);
});
for (const scenario of ['unauthenticated', 'revoked', 'expired', 'tenant', 'generation', 'canCall', 'build'])
  test(`native ${scenario} authority failure precedes every provider request`, async () => {
    const f = fixture(); let context = ctx('a');
    if (scenario === 'unauthenticated') context = { headers: {} };
    if (scenario === 'revoked') f.devices.get('a').revoked = true;
    if (scenario === 'expired') f.devices.get('a').credentialExpiresAt = START;
    if (scenario === 'tenant') f.authOverrides.set('a', { tenantId: 'other-company' });
    if (scenario === 'generation') f.authOverrides.set('a', { credentialGeneration: 2 });
    if (scenario === 'canCall') f.authOverrides.set('a', { canCall: false });
    if (scenario === 'build') f.devices.get('a').nativeBuild = 1;
    await assert.rejects(() => f.api.request(context, f.input()));
    assert.equal(f.calls.length, 0); assert.equal(f.db.documents.size, 0);
  });
test('calling activation and storage are required before a permission operation', async () => {
  const f = fixture(); f.enable(false);
  await assert.rejects(() => f.api.request(ctx('a'), f.input()), { code: 'ROOM_CALLING_NOT_ENABLED' });
  assert.equal(f.calls.length, 0);
  const api = createOperatorCallPermission({ ...f.options, getFirestore: () => null }); f.enable(true);
  await assert.rejects(() => api.request(ctx('a'), f.input()), { code: 'CALL_PERMISSION_UNAVAILABLE' });
  assert.equal(f.calls.length, 0);
});
test('revocation during provider eligibility lookup prevents receipt allocation and send', async () => {
  const f = fixture(); f.onCheck(async () => { f.devices.get('a').revoked = true; return json(noPermission()); });
  await assert.rejects(() => f.api.request(ctx('a'), f.input()), { code: 'DEVICE_BINDING_INVALID' });
  assert.equal(f.posts().length, 0); assert.equal(f.db.documents.size, 0);
});
test('revocation after durable claim blocks the last dispatch boundary', async () => {
  const f = fixture(), original = f.db.runTransaction.bind(f.db);
  f.db.runTransaction = async callback => {
    const result = await original(callback);
    if (result?.row?.state === 'sending') f.devices.get('a').revoked = true;
    return result;
  };
  await assert.rejects(() => f.api.request(ctx('a'), f.input()), { code: 'DEVICE_BINDING_INVALID' });
  assert.equal(f.posts().length, 0);
  assert.ok([...f.db.documents.values()].filter(x => x.requestId).every(x => x.state === 'blocked'));
});
test('provider ineligible and already-granted statuses never dispatch a permission message', async () => {
  for (const data of [granted(), (() => { const d = noPermission(); d.actions[0].can_perform_action = false; return d; })()]) {
    const f = fixture(); f.setStatus(data);
    await assert.rejects(() => f.api.request(ctx('a'), f.input()), { code: 'CALL_PERMISSION_REQUEST_BLOCKED' });
    assert.equal(f.posts().length, 0); assert.equal(f.db.documents.size, 0);
  }
});
test('provider lookup failure fails closed before creating a send operation', async () => {
  const f = fixture(); f.onCheck(async () => { throw Error('Synthetic provider lookup transport unavailable'); });
  await assert.rejects(() => f.api.request(ctx('a'), f.input()), { code: 'CALL_PERMISSION_STATUS_UNAVAILABLE' });
  assert.equal(f.posts().length, 0); assert.equal(f.db.documents.size, 0);
});
test('ambiguous provider send is persisted, holds new IDs and never automatically retries', async () => {
  const f = fixture(); f.onSend(async () => { throw Error('Synthetic message accepted then acknowledgement lost'); });
  const result = await f.api.request(ctx('a'), f.input());
  assert.equal(result.request.state, 'uncertain'); assert.equal(result.permission.canCall, false); assert.equal(result.permission.canRequest, false);
  f.setNow(START + 600000);
  await f.api.request(ctx('a'), f.input());
  await assert.rejects(() => f.api.request(ctx('a'), f.input({ requestId: 'new-request-00002' })), { code: 'CALL_PERMISSION_REQUEST_BLOCKED' });
  assert.equal((await f.api.status(ctx('a'), { to: TO })).request.state, 'uncertain'); assert.equal(f.posts().length, 1);
});
test('fresh permission grant reconciles need to request without inventing a message acknowledgement', async () => {
  const f = fixture(); f.onSend(async () => { throw Error('Synthetic lost ACK'); });
  await f.api.request(ctx('a'), f.input()); f.setStatus(granted());
  const result = await f.api.status(ctx('a'), f.input());
  assert.equal(result.permission.canCall, true); assert.equal(result.request.state, 'uncertain'); assert.equal(result.request.messageId, null);
  assert.equal(f.posts().length, 1);
});
test('status always rechecks provider expiry and revocation rather than keeping a stale local grant', async () => {
  const f = fixture(); f.setStatus(granted('temporary'));
  assert.equal((await f.api.status(ctx('a'), { to: TO })).permission.canCall, true);
  f.setNow(START + 60000);
  assert.equal((await f.api.status(ctx('a'), { to: TO })).permission.canCall, false);
  f.setStatus(noPermission());
  assert.equal((await f.api.status(ctx('a'), { to: TO })).permission.status, 'no_permission');
  assert.equal(f.posts().length, 0);
});
test('definite Meta window rejection is actionable and does not switch to an invented template', async () => {
  const f = fixture(); f.onSend(async () => json({ error: { code: 131047,
    message: 'Synthetic re-engagement error; use a template outside the customer service window. private-provider-marker' } }, 400));
  await assert.rejects(() => f.api.request(ctx('a'), f.input()), error => {
    assert.equal(error.code, 'CALL_PERMISSION_WINDOW_CLOSED'); assert.equal(error.request.state, 'blocked');
    assert.equal(error.message.includes('private-provider-marker'), false); return true;
  });
  assert.equal(f.posts().length, 1); assert.equal(f.posts()[0].body.type, 'interactive');
  assert.equal((await f.api.status(ctx('a'), f.input())).request.state, 'blocked');
});
test('known unsuccessful provider response is distinct from a transport-uncertain send', async () => {
  const f = fixture(); f.onSend(async () => json({ error: { code: 42, message: 'Synthetic provider eligibility rejection' } }, 429));
  await assert.rejects(() => f.api.request(ctx('a'), f.input()), { code: 'CALL_PERMISSION_REQUEST_BLOCKED' });
  const result = await f.api.request(ctx('a'), f.input());
  assert.equal(result.request.state, 'blocked'); assert.equal(f.posts().length, 1);
});
for (const scenario of ['server-error', 'missing-wamid', 'malformed-json', 'oversize', 'multiple-messages'])
  test(`${scenario} send response remains uncertain without retry`, async () => {
    const f = fixture();
    f.onSend(async () => scenario === 'server-error' ? json({ error: { code: 1 } }, 503)
      : scenario === 'missing-wamid' ? json({ success: true })
      : scenario === 'malformed-json' ? new Response('{not-json', { status: 200 })
      : scenario === 'oversize' ? new Response('x'.repeat(65537), { status: 200 })
      : json({ messages: [{ id: 'wamid.fixture_one' }, { id: 'wamid.fixture_two' }] }));
    assert.equal((await f.api.request(ctx('a'), f.input())).request.state, 'uncertain');
    await f.api.request(ctx('a'), f.input()); assert.equal(f.posts().length, 1);
  });
test('lost durable-claim acknowledgement cannot be retried into a provider send', async () => {
  const f = fixture(); f.db.failAfterCommit = Error('Synthetic claim ACK lost');
  await assert.rejects(() => f.api.request(ctx('a'), f.input()), { code: 'CALL_PERMISSION_STORAGE_UNAVAILABLE' });
  f.db.failAfterCommit = null; f.setNow(START + 25000);
  const result = await f.api.request(ctx('a'), f.input());
  assert.equal(result.request.state, 'uncertain'); assert.equal(f.posts().length, 0);
});
test('lost final receipt write does not reopen dispatch after a confirmed provider send', async () => {
  const f = fixture(); f.onSend(async () => { f.db.failBeforeCommit = Error('Synthetic settle storage down');
    return json({ messages: [{ id: 'wamid.confirmed_but_receipt_write_lost' }] }); });
  await assert.rejects(() => f.api.request(ctx('a'), f.input()), { code: 'CALL_PERMISSION_STORAGE_UNAVAILABLE' });
  f.db.failBeforeCommit = null; f.setNow(START + 25000);
  assert.equal((await f.api.request(ctx('a'), f.input())).request.state, 'uncertain'); assert.equal(f.posts().length, 1);
});
test('lost final transaction ACK is recovered from durable sent receipt without resend', async () => {
  const f = fixture(); f.onSend(async () => { f.db.failAfterCommit = Error('Synthetic settle ACK lost');
    return json({ messages: [{ id: 'wamid.durable_confirmed_message' }] }); });
  await assert.rejects(() => f.api.request(ctx('a'), f.input()), { code: 'CALL_PERMISSION_STORAGE_UNAVAILABLE' });
  f.db.failAfterCommit = null;
  assert.equal((await f.api.request(ctx('a'), f.input())).request.state, 'sent'); assert.equal(f.posts().length, 1);
});
test('a genuinely new explicit eligible request uses a new ID after local debounce', async () => {
  const f = fixture(); await f.api.request(ctx('a'), f.input());
  await assert.rejects(() => f.api.request(ctx('a'), f.input({ requestId: 'request-two-0002' })), { code: 'CALL_PERMISSION_REQUEST_BLOCKED' });
  f.setNow(START + 30000);
  assert.equal((await f.api.status(ctx('a'), { to: TO })).permission.canRequest, true);
  await f.api.request(ctx('a'), f.input({ requestId: 'request-two-0002' })); assert.equal(f.posts().length, 2);
});
test('bad numbers, request identities and unsafe upstream configuration fail before provider IO', async () => {
  const f = fixture();
  for (const to of ['+919000000001', '0919000000001', '9190/1234', '919000000001?x=1', TO + '\n', '', '123', {}, ['919000000001']])
    await assert.rejects(() => f.api.request(ctx('a'), f.input({ to })), { code: 'INVALID_PHONE' });
  for (const id of ['', 'short', '../request-123', 'a'.repeat(121), 17])
    await assert.rejects(() => f.api.request(ctx('a'), f.input({ requestId: id })), { code: 'INVALID_REQUEST_ID' });
  for (const options of [{ phoneNumberId: '../messages' }, { apiVersion: '26.0/evil' }, { metaToken: '' }])
    assert.throws(() => createMetaCallPermissionProvider({ phoneNumberId: '123456789012345', apiVersion: '26.0', metaToken: 'fixture', ...options }),
      { code: 'CALL_PERMISSION_UNAVAILABLE' });
  assert.equal(f.calls.length, 0);
});
test('new receipt records never store provider tokens or bearer credentials', async () => {
  const f = fixture(); await f.api.request(ctx('a'), f.input());
  const text = JSON.stringify(f.db.dump());
  for (const secret of ['synthetic-provider-token', 'Bearer fixture-a', 'Authorization', 'metaToken']) assert.equal(text.includes(secret), false);
  assert.ok([...f.db.documents.keys()].every(path => /^fixture_sh_call_permissions\/(request|target)_[a-f0-9]{64}$/.test(path)));
});
test('real Express routes enforce exact input, bearer authority and no-store; GET cannot send', async () => {
  const f = fixture(), app = express(); app.use(express.json({ limit: '4kb' })); f.api.mount(app);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/operator-android/call-permission`;
  try {
    let response = await fetch(`${base}/status?to=${TO}`);
    assert.equal(response.status, 401); assert.equal(response.headers.get('cache-control'), 'no-store');
    response = await fetch(`${base}/status?to=${TO}&access_token=forbidden`, { headers: ctx('a').headers });
    assert.equal(response.status, 400);
    response = await fetch(`${base}/request`, { method: 'POST', headers: { ...ctx('a').headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...f.input(), phoneNumberId: 'another-business' }) });
    assert.equal(response.status, 400); assert.equal(f.posts().length, 0);
    response = await fetch(`${base}/status?to=${TO}`, { headers: ctx('a').headers });
    assert.equal(response.status, 200); assert.equal((await response.json()).permission.canRequest, true); assert.equal(f.posts().length, 0);
    response = await fetch(`${base}/request`, { method: 'POST', headers: { ...ctx('a').headers, 'Content-Type': 'application/json' }, body: JSON.stringify(f.input()) });
    const result = await response.json(); assert.equal(response.status, 200); assert.equal(result.request.state, 'sent');
    assert.equal(result.permission.canCall, false); assert.equal(f.posts().length, 1);
    response = await fetch(`${base}/request?to=${TO}`, { headers: ctx('a').headers }); assert.equal(response.status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); server.closeAllConnections?.(); }
});

test('provider acknowledgement for a different WhatsApp recipient remains uncertain', async () => {
  const f = fixture(); f.onSend(async () => json({ messaging_product: 'whatsapp', contacts: [{ wa_id: OTHER }],
    messages: [{ id: 'wamid.ack_for_wrong_recipient' }] }));
  const result = await f.api.request(ctx('a'), f.input());
  assert.equal(result.request.state, 'uncertain'); assert.equal(result.request.messageId, null); assert.equal(f.posts().length, 1);
});
test('corrupted destination-fence state fails closed instead of permitting a duplicate', async () => {
  const f = fixture(); await f.api.request(ctx('a'), f.input());
  const entry = [...f.db.documents.entries()].find(([path]) => path.includes('/target_'));
  f.db.documents.set(entry[0], { ...entry[1], state: 'unknown_bad_state' });
  await assert.rejects(() => f.api.request(ctx('a'), f.input({ requestId: 'another-request-001' })), { code: 'CALL_PERMISSION_REQUEST_CONFLICT' });
  assert.equal(f.posts().length, 1);
});

test('zero provider maximum denies eligibility without inventing a positive allowance', () => {
  const data = noPermission(); data.actions[0].limits = [{ time_period: 'PT24H', max_allowed: 0, current_usage: 0 }];
  const result = parseCallPermissionStatus(data, START);
  assert.equal(result.canRequest, false); assert.equal(result.limits[0].maxAllowed, 0);
});
test('slow status GET sees a concurrently created uncertain destination fence', async () => {
  const f = fixture(), entered = deferred(), gate = deferred(); let checks = 0;
  f.onCheck(async () => { if (++checks === 1) { entered.resolve(); await gate.promise; } return json(noPermission()); });
  const checking = f.api.status(ctx('b'), { to: TO }); await entered.promise;
  f.onSend(async () => { throw Error('Synthetic lost send ACK'); });
  assert.equal((await f.api.request(ctx('a'), f.input())).request.state, 'uncertain');
  gate.resolve(); const result = await checking;
  assert.equal(result.permission.canRequest, false); assert.equal(result.request, null); assert.equal(f.posts().length, 1);
});
test('changed provider eligibility after durable claim blocks the sole dispatch', async () => {
  const f = fixture(); let checks = 0;
  f.onCheck(async () => { const data = noPermission(); if (++checks > 1) data.actions[0].can_perform_action = false; return json(data); });
  await assert.rejects(() => f.api.request(ctx('a'), f.input()), { code: 'CALL_PERMISSION_REQUEST_BLOCKED' });
  assert.equal(checks, 2); assert.equal(f.posts().length, 0);
  assert.ok([...f.db.documents.values()].filter(row => row.requestId).every(row => row.state === 'blocked'));
});
test('unavailable final eligibility lookup records known no-send rather than an ambiguous provider dispatch', async () => {
  const f = fixture(); let checks = 0;
  f.onCheck(async () => { if (++checks > 1) throw Error('Synthetic final status timeout'); return json(noPermission()); });
  await assert.rejects(() => f.api.request(ctx('a'), f.input()), { code: 'CALL_PERMISSION_STATUS_UNAVAILABLE' });
  assert.equal(f.posts().length, 0);
  f.onCheck(null);
  const result = await f.api.status(ctx('a'), f.input());
  assert.equal(result.request.state, 'blocked'); assert.equal(result.request.code, 'CALL_PERMISSION_REQUEST_BLOCKED');
});
test('credential revoked during final eligibility lookup still cannot dispatch', async () => {
  const f = fixture(); let checks = 0;
  f.onCheck(async () => { if (++checks > 1) f.devices.get('a').revoked = true; return json(noPermission()); });
  await assert.rejects(() => f.api.request(ctx('a'), f.input()), { code: 'DEVICE_BINDING_INVALID' });
  assert.equal(f.posts().length, 0);
});
test('calling disabled during final provider eligibility lookup prevents dispatch', async () => {
  const f = fixture(); let checks = 0;
  f.onCheck(async () => { if (++checks > 1) f.enable(false); return json(noPermission()); });
  await assert.rejects(() => f.api.request(ctx('a'), f.input()), { code: 'ROOM_CALLING_NOT_ENABLED' });
  assert.equal(checks, 2); assert.equal(f.posts().length, 0);
  assert.ok([...f.db.documents.values()].filter(row => row.requestId).every(row => row.state === 'blocked'));
});
test('window rejection explanation survives status/replay without leaking raw provider details', async () => {
  const f = fixture(); f.onSend(async () => json({ error: { code: 131047, message: 'Synthetic customer service window; PRIVATE-MARKER-XYZ' } }, 400));
  await assert.rejects(() => f.api.request(ctx('a'), f.input()));
  const result = await f.api.status(ctx('a'), f.input());
  assert.equal(result.request.code, 'CALL_PERMISSION_WINDOW_CLOSED'); assert.match(result.request.reason, /customer reply window/);
  assert.equal(JSON.stringify(result).includes('PRIVATE-MARKER-XYZ'), false);
  assert.equal((await f.api.request(ctx('a'), f.input())).request.code, 'CALL_PERMISSION_WINDOW_CLOSED');
  assert.equal(f.posts().length, 1);
});
