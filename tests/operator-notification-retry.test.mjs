import test from 'node:test';
import assert from 'node:assert/strict';
import { registryFixture, deferred } from './operator-r12-helpers.mjs';
import { createAndroidPushBridge } from '../operator-android-push.js';
import { fcmFailure, notificationRetryDelay } from '../operator-notification-retry.js';

const incoming = (at, id = 81) => ({ verifiedIncoming: true, channel: { id: 73, channel_type: 'whatsapp' },
  message: { id, model: 'discuss.channel', res_id: 73, date: new Date(at).toISOString(), body: 'Synthetic message' } });
const settle = () => new Promise(resolve => setImmediate(resolve));

test('FCM distinguishes permanent project mismatch from generic IAM failure and honors quota retry minimum', () => {
  const mismatch = fcmFailure({ error: { details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'SENDER_ID_MISMATCH' }] } }, 403);
  assert.equal(mismatch.senderMismatch, true);
  assert.equal(fcmFailure({ error: { status: 'PERMISSION_DENIED' } }, 403).senderMismatch, false);
  assert.equal(notificationRetryDelay(1, fcmFailure({}, 429)), 60000);
  assert.equal(notificationRetryDelay(1, fcmFailure({}, 503, '120')), 120000);
});

test('real HTTP FCM mismatch clears only the rejected token and never device authentication', async () => {
  const f = registryFixture(), enrolled = await f.enroll(); let sends = 0;
  const bridge = createAndroidPushBridge({ env: f.env, deviceRegistry: f.registry, clock: () => 1800000000000,
    readCall: async () => null, logger: {}, fetchImpl: async url => {
      if (url.includes('oauth2')) return { ok: true, json: async () => ({ access_token: 'synthetic-access', expires_in: 3600 }) };
      sends++;
      return { ok: false, status: 403, json: async () => ({ error: { details: [
        { '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'SENDER_ID_MISMATCH' }] } }) };
    } });
  await bridge.publishMessage(incoming(1800000000000));
  const device = await f.registry.getDevice(enrolled.result.body.deviceId);
  assert.equal(device.fcmToken, ''); assert.equal(device.revokedAt, 0);
  assert.ok(await f.registry.authenticate(enrolled.result.body.deviceToken)); assert.equal(sends, 1);
});

test('a token refreshed during failed push cannot be erased by old-project cleanup', async () => {
  const f = registryFixture(), enrolled = await f.enroll();
  const bridge = createAndroidPushBridge({ env: f.env, deviceRegistry: f.registry, clock: () => 1800000000000,
    readCall: async () => null, logger: {}, delivery: async () => {
      await f.registry.updateToken(enrolled.result.body.deviceToken, { fcmToken: 'new_project_token_abcdefghijklmnopqrstuvwxyz' });
      throw Object.assign(Error('synthetic'), { status: 403, senderMismatch: true });
    } });
  await bridge.publishMessage(incoming(1800000000000));
  assert.equal((await f.registry.getDevice(enrolled.result.body.deviceId)).fcmToken, 'new_project_token_abcdefghijklmnopqrstuvwxyz');
});

test('confirmed duplicate message scans use zero further database reads or writes', async t => {
  const f = registryFixture(); await f.enroll(); let reads = 0;
  const get = f.db.get.bind(f.db); f.db.get = (...args) => { reads++; return get(...args); };
  const value = incoming(1800000000000);
  await f.bridge.publishMessage(value); await settle();
  const beforeReads = reads, beforeWrites = f.db.version;
  for (let i = 0; i < 75; i++) await f.bridge.publishMessage(value);
  assert.equal(reads - beforeReads, 0); assert.equal(f.db.version - beforeWrites, 0);
  assert.equal(f.deliveries.length, 1);
  t.diagnostic('75 duplicate discovery callbacks: 0 additional document reads/writes');
});

test('failed notification backoff survives another bridge and never delays a different message', async () => {
  let at = 1800000000000, sends = 0;
  const f = registryFixture({ clock: () => at }); await f.enroll();
  const make = () => createAndroidPushBridge({ env: f.env, deviceRegistry: f.registry, clock: () => at,
    readCall: async () => null, logger: {}, delivery: async () => {
      sends++; throw Object.assign(Error('synthetic quota'), { status: 429, retryAfterMs: 60000 });
    } });
  await make().publishMessage(incoming(at));
  const before = f.db.version;
  at += 4000; await make().publishMessage(incoming(at - 4000));
  assert.equal(sends, 1); assert.equal(f.db.version, before, 'backoff must not claim or rewrite a failed delivery');
  await make().publishMessage(incoming(at, 82)); assert.equal(sends, 2, 'a distinct event does not queue behind the old message');
  at += 60000; await make().publishMessage(incoming(at - 64000)); assert.equal(sends, 3);
});

test('concurrent duplicate discoveries share one operation while a fresh event proceeds', async () => {
  const entered = deferred(), release = deferred(); let sends = 0;
  const f = registryFixture({ delivery: async (_, data) => { sends++; if (data.message_id === '81') { entered.resolve(); await release.promise; } } });
  await f.enroll();
  const a = f.bridge.publishMessage(incoming(1800000000000)); await entered.promise;
  const b = f.bridge.publishMessage(incoming(1800000000000));
  await f.bridge.publishMessage(incoming(1800000000000, 82));
  release.resolve(); await Promise.all([a, b]); assert.equal(sends, 2);
});

test('a successful push does not prevent the independent unread write from recovering', async () => {
  const f = registryFixture(); await f.enroll(); let attempts = 0, sends = 0;
  const bridge = createAndroidPushBridge({ env: f.env, deviceRegistry: { ...f.registry,
    observeAppMessages: async input => { if (++attempts === 1) throw Error('Synthetic storage outage'); return f.registry.observeAppMessages(input); } },
    clock: () => 1800000000000, readCall: async () => null, logger: {}, delivery: async () => { sends++; } });
  const event = incoming(1800000000000);
  await bridge.publishMessage(event); await settle();
  assert.equal(sends, 1);
  assert.equal(await bridge.observeIncomingMessages({ channel: event.channel, messages: [event.message], verifiedIncoming: true }), true);
  await bridge.publishMessage(event); assert.equal(sends, 1, 'only the ledger retries, not an acknowledged notification');
  assert.equal((await f.registry.listAppMessageState([73]))[0].unreadCount, 1);
});
