import test from 'node:test';
import assert from 'node:assert/strict';
import { createAndroidPushBridge } from '../operator-android-push.js';
import { registryFixture } from './operator-r12-helpers.mjs';

async function setup() {
  const now = () => 1800000000000;
  const f = registryFixture({ clock: now });
  const enrollment = await f.enroll('0000000000000001', { nativeBuild: 16, mediaProtocol: 'sh-room-audio-v1' });
  const messages = [], routes = new Map(); let oauthRequests = 0;
  const bridge = createAndroidPushBridge({ env: f.env, deviceRegistry: f.registry, clock: now, logger: {}, readCall: async () => null,
    fetchImpl: async (url, options) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        oauthRequests++;
        return { ok: true, status: 200, json: async () => ({ access_token: 'synthetic-private-oauth', expires_in: 3600 }) };
      }
      assert.equal(url, 'https://fcm.googleapis.com/v1/projects/sh-test-project/messages:send');
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      messages.push(JSON.parse(options.body).message);
      return { ok: true, status: 200, json: async () => ({ name: 'projects/sh-test-project/messages/synthetic-' + messages.length }) };
    } });
  bridge.registerRoutes({ get: (path, fn) => routes.set('GET ' + path, fn), post: (path, fn) => routes.set('POST ' + path, fn) });
  return { ...f, bridge, enrollment, messages, routes, now, oauthRequests: () => oauthRequests };
}

test('actual FCM HTTP chat payloads do not collapse six distinct conversations or same-chat content', async () => {
  const f = await setup();
  const incoming = (channel, id) => ({ verifiedIncoming: true, channel: { id: channel, channel_type: 'whatsapp', name: 'Customer' },
    message: { id, model: 'discuss.channel', res_id: channel, date: new Date(f.now()).toISOString(), body: '<p>Order ' + id + '</p>' } });
  for (let i = 1; i <= 6; i++) await f.bridge.publishMessage(incoming(70 + i, 800 + i));
  await f.bridge.publishMessage(incoming(71, 807));
  assert.equal(f.messages.length, 7);
  assert.equal(f.oauthRequests(), 1, 'OAuth is reused rather than adding authorization to every push');
  assert.deepEqual(f.messages.map(row => row.data.message_id), ['801', '802', '803', '804', '805', '806', '807']);
  for (const row of f.messages) {
    assert.equal(row.data.type, 'sh_operator_message');
    assert.equal(Object.hasOwn(row.android, 'collapse_key'), false);
    assert.equal(row.android.priority, 'HIGH');
    assert.equal(row.android.ttl, '300s');
    assert.equal(row.android.restricted_package_name, 'com.smarthandicrafts.operatorhub');
    assert.equal(Object.hasOwn(row, 'notification'), false, 'content remains an explicitly handled data message');
  }
  await f.bridge.publishMessage(incoming(71, 807));
  assert.equal(f.messages.length, 7, 'durable message dedupe remains separate from FCM collapsing');
});

test('actual FCM call and transfer events retain short TTL and exact identities without collapse-key eviction', async () => {
  const f = await setup(), session = { id: 'exact-call-1', deadlineAt: f.now() + 20000 };
  await f.bridge.publishRoomEvent({ session, event: 'incoming' });
  await f.bridge.publishRoomEvent({ session, event: 'ended' });
  const transfer = { session, transferId: 'exact-transfer-1', toDeviceId: f.enrollment.result.body.deviceId, expiresAtMs: f.now() + 20000 };
  await f.bridge.publishRoomEvent({ ...transfer, event: 'transfer-incoming' });
  await f.bridge.publishRoomEvent({ ...transfer, event: 'transfer-ended' });
  assert.equal(f.messages.length, 4);
  assert.deepEqual(f.messages.map(row => [row.data.type, row.data.event]), [
    ['sh_operator_call', 'incoming'], ['sh_operator_call', 'ended'], ['sh_operator_transfer', 'incoming'], ['sh_operator_transfer', 'ended']
  ]);
  for (const row of f.messages) {
    assert.equal(Object.hasOwn(row.android, 'collapse_key'), false);
    assert.equal(row.android.priority, 'HIGH'); assert.equal(row.android.ttl, '30s');
    assert.equal(row.data.call_id, session.id);
    if (row.data.type === 'sh_operator_transfer') assert.equal(row.data.transfer_id, transfer.transferId);
  }
  await f.bridge.publishRoomEvent({ ...transfer, event: 'transfer-incoming' });
  await f.bridge.publishRoomEvent({ session, event: 'incoming' });
  assert.equal(f.messages.length, 4, 'finished/terminal durable claims still suppress old ringing attempts');
});

test('a non-current call alert is still cancelled before FCM and test notifications alone may collapse', async () => {
  const f = await setup();
  await f.bridge.publishRoomEvent({ session: { id: 'already-ended', deadlineAt: f.now() + 20000 }, event: 'incoming', stillCurrent: async () => false });
  assert.equal(f.messages.length, 0);
  const result = {};
  const res = { setHeader() {}, status(value) { result.status = value; return this; }, json(value) { result.body = value; return this; } };
  await f.routes.get('POST /api/operator-android/devices/test')({ method: 'POST', body: {}, ip: 'synthetic',
    headers: { authorization: 'Bearer ' + f.enrollment.result.body.deviceToken } }, res);
  assert.equal(result.body.accepted, true); assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].data.type, 'sh_operator_test');
  assert.equal(f.messages[0].android.collapse_key, 'sh-test-' + f.enrollment.result.body.deviceId);
});
