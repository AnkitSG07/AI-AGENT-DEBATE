import test from 'node:test';
import assert from 'node:assert/strict';
import { registryFixture, deferred } from './operator-r12-helpers.mjs';
import { createAndroidPushBridge } from '../operator-android-push.js';
const channel = { id: 73, channel_type: 'whatsapp', name: 'PRIVATE_NAME' };
const record = (now, id, extra = {}) => ({ id, model: 'discuss.channel', res_id: 73, date: new Date(now).toISOString(), body: 'PRIVATE_MESSAGE', ...extra });
const version = async f => (await f.registry.listAppMessageState([73]))[0].stateVersion;

test('trusted incoming message IDs persist app unread independently of Odoo read fields and list never marks read', async () => {
  const now = () => 1800000000000, f = registryFixture({ clock: now }), enrollment = await f.enroll();
  await f.bridge.observeIncomingMessages({ channel: { ...channel, unread_counter: 0 }, verifiedIncoming: true,
    messages: [record(now(), 10), record(now(), 8), record(now(), 9), record(now(), 9)] });
  const bearer = enrollment.result.body.deviceToken;
  for (let i = 0; i < 2; i++) {
    const result = await f.request('POST', '/api/operator-android/messages/state', { channelIds: [73] }, bearer);
    assert.equal(result.status, 200); assert.deepEqual(result.body.channels, [{ channelId: 73, stateVersion: 1, latestMessageId: 10, readThroughMessageId: 0, unreadCount: 3 }]);
  }
  const appRows = Object.entries(f.db.dump()).filter(([path]) => path.includes('_app_messages/'));
  assert.equal(appRows.length, 1); assert.doesNotMatch(JSON.stringify(appRows), /PRIVATE_/);
});

test('partial actual app reads preserve newer messages and team-app reads propagate across enrolled devices', async () => {
  const f = registryFixture(), first = await f.enroll(), second = await f.enroll('0000000000000002');
  await f.registry.observeAppMessages({ channelId: 73, messageIds: [8, 9, 10] });
  const read = await f.request('POST', '/api/operator-android/messages/read', { channelId: 73, throughMessageId: 9, expectedStateVersion: await version(f) }, first.result.body.deviceToken);
  assert.equal(read.body.state.unreadCount, 1); assert.equal(read.body.state.readThroughMessageId, 9);
  await f.registry.observeAppMessages({ channelId: 73, messageIds: [11] });
  const other = await f.request('POST', '/api/operator-android/messages/state', { channelIds: [73] }, second.result.body.deviceToken);
  assert.equal(other.body.channels[0].unreadCount, 2);
  await f.request('POST', '/api/operator-android/messages/read', { channelId: 73, throughMessageId: 11, expectedStateVersion: await version(f) }, second.result.body.deviceToken);
  assert.equal((await f.registry.listAppMessageState([73]))[0].unreadCount, 0);
});

test('manual app unread is durable without moving the read watermark and background replay cannot clear it', async () => {
  const f = registryFixture(), e = await f.enroll(), token = e.result.body.deviceToken;
  await f.registry.observeAppMessages({ channelId: 73, messageIds: [10] });
  await f.registry.changeAppMessageState(token, { channelId: 73, throughMessageId: 10, expectedStateVersion: await version(f) });
  const unread = await f.request('POST', '/api/operator-android/messages/unread', { channelId: 73, expectedStateVersion: await version(f) }, token);
  assert.equal(unread.body.state.readThroughMessageId, 10); assert.equal(unread.body.state.unreadCount, 1);
  await f.registry.observeAppMessages({ channelId: 73, messageIds: [8, 9, 10] });
  assert.equal((await f.registry.listAppMessageState([73]))[0].unreadCount, 1);
  await f.registry.changeAppMessageState(token, { channelId: 73, throughMessageId: 999999999, expectedStateVersion: await version(f) });
  assert.equal((await f.registry.listAppMessageState([73]))[0].readThroughMessageId, 10, 'cannot acknowledge unseen future IDs');
  await f.registry.observeAppMessages({ channelId: 73, messageIds: [11] });
  assert.equal((await f.registry.listAppMessageState([73]))[0].unreadCount, 1);
});

test('trusted historical seed is conservative unread without replaying old phone notifications', async () => {
  const now = () => 1800000000000, f = registryFixture({ clock: now }); await f.enroll();
  const old = record(now() - 86400000, 50);
  await f.bridge.observeIncomingMessages({ channel, verifiedIncoming: true, seedExisting: true, messages: [old] });
  assert.equal((await f.registry.listAppMessageState([73]))[0].unreadCount, 1);
  await f.bridge.publishMessage({ channel, message: old, verifiedIncoming: true });
  assert.equal(f.deliveries.length, 0);
});

test('untrusted and wrong-channel input cannot create app unread and notification opt-out does not mark a chat read', async () => {
  const now = () => 1800000000000, f = registryFixture({ clock: now }), e = await f.enroll();
  await f.bridge.observeIncomingMessages({ channel, verifiedIncoming: false, messages: [record(now(), 10)] });
  await f.bridge.observeIncomingMessages({ channel, verifiedIncoming: true, messages: [record(now(), 10, { res_id: 74 })] });
  assert.equal((await f.registry.listAppMessageState([73]))[0].unreadCount, 0);
  await f.registry.updateToken(e.result.body.deviceToken, { fcmToken: e.body.fcmToken, receiveChats: false });
  await f.bridge.publishMessage({ channel, message: record(now(), 11), verifiedIncoming: true });
  assert.equal(f.deliveries.length, 0); assert.equal((await f.registry.listAppMessageState([73]))[0].unreadCount, 1);
});

test('app read mutations reject revoked credentials, malformed channel IDs and unbounded batches', async () => {
  const f = registryFixture(), e = await f.enroll();
  await assert.rejects(() => f.registry.listAppMessageState(new Array(101).fill(73)), { status: 400 });
  await assert.rejects(() => f.registry.listAppMessageState([-1]), { status: 400 });
  await assert.rejects(() => f.registry.changeAppMessageState(e.result.body.deviceToken, { channelId: 73, throughMessageId: -1 }), { status: 400 });
  await f.registry.revokeDevice(e.result.body.deviceId);
  await assert.rejects(() => f.registry.changeAppMessageState(e.result.body.deviceToken, { channelId: 73, throughMessageId: 10, expectedStateVersion: 0 }), { status: 401 });
  assert.equal((await f.request('POST', '/api/operator-android/messages/state', { channelIds: [73] })).status, 401);
});

test('a timed-out old read cannot clear a later manual unread and newer incoming IDs survive stale reads', async () => {
  const f = registryFixture(), e = await f.enroll(), token = e.result.body.deviceToken;
  await f.registry.observeAppMessages({ channelId: 73, messageIds: [10] });
  const oldVersion = await version(f);
  await f.registry.changeAppMessageState(token, { channelId: 73, unread: true, expectedStateVersion: oldVersion });
  await assert.rejects(() => f.registry.changeAppMessageState(token, { channelId: 73, throughMessageId: 10, expectedStateVersion: oldVersion }), { status: 409, code: 'APP_MESSAGE_STATE_CHANGED' });
  assert.equal((await f.registry.listAppMessageState([73]))[0].unreadCount, 1);
  const beforeIncoming = await version(f);
  await f.registry.observeAppMessages({ channelId: 73, messageIds: [11] });
  await assert.rejects(() => f.registry.changeAppMessageState(token, { channelId: 73, throughMessageId: 10, expectedStateVersion: beforeIncoming }), { status: 409 });
  await f.registry.changeAppMessageState(token, { channelId: 73, throughMessageId: 10, expectedStateVersion: await version(f) });
  const state = (await f.registry.listAppMessageState([73]))[0];
  assert.equal(state.unreadCount, 1); assert.equal(state.latestMessageId, 11); assert.equal(state.readThroughMessageId, 10);
});

test('Firebase send is not blocked behind an app-unread ledger transaction', async () => {
  const now = () => 1800000000000, f = registryFixture({ clock: now }); await f.enroll();
  const entered = deferred(), release = deferred(); let sent = 0, timer;
  const bridge = createAndroidPushBridge({ env: f.env, clock: now, readCall: async () => null,
    deviceRegistry: { ...f.registry, observeAppMessages: async input => { entered.resolve(); await release.promise; return f.registry.observeAppMessages(input); } },
    delivery: async () => { sent++; return { ok: true }; }, logger: { info() {}, warn() {} } });
  const input = { channel, message: record(now(), 10), verifiedIncoming: true };
  const sending = bridge.publishMessage(input); await entered.promise;
  try {
    const completed = await Promise.race([sending.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 150); })]);
    assert.equal(completed, true); assert.equal(sent, 1);
  } finally { clearTimeout(timer); release.resolve(); await sending; await bridge.observeIncomingMessages({ channel, messages: [input.message], verifiedIncoming: true }); }
});
