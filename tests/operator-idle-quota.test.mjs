import test from 'node:test';
import assert from 'node:assert/strict';
import { registryFixture } from './operator-r12-helpers.mjs';
import { createRecoveryCadence } from '../operator-recovery-cadence.js';

const channel = { id: 73, channel_type: 'whatsapp' };
const message = (now, id) => ({ id, model: 'discuss.channel', res_id: 73, date: new Date(now).toISOString() });
test('repeated Odoo scans of committed IDs do not reread Firestore; fresh and older unseen IDs still do', async () => {
  let now = 1800000000000, calls = 0;
  const f = registryFixture({ clock: () => now });
  const run = f.db.runTransaction.bind(f.db);
  f.db.runTransaction = (callback, options) => { if (!options?.readOnly) calls++; return run(callback, options); };
  const scan = ids => f.bridge.observeIncomingMessages({ channel, verifiedIncoming: true, seedExisting: true, messages: ids.map(id => message(now, id)) });
  await scan([11, 12]);
  for (let i = 0; i < 100; i++) { now += 4000; await scan([11, 12]); }
  assert.equal(calls, 1);
  await scan([10, 11, 12, 13]); assert.equal(calls, 2);
  assert.equal((await f.registry.listAppMessageState([73]))[0].unreadCount, 4);
  now += 600001; await scan([11, 12]); assert.equal(calls, 3, 'bounded positive observation cache expires');
});
test('failed unread observation is retried; only the successful commit is remembered', async () => {
  const now = 1800000000000, f = registryFixture({ clock: () => now });
  let calls = 0; const run = f.db.runTransaction.bind(f.db);
  f.db.runTransaction = (callback, options) => { if (!options?.readOnly && ++calls === 1) return Promise.reject(Error('storage unavailable')); return run(callback, options); };
  const scan = () => f.bridge.observeIncomingMessages({ channel, verifiedIncoming: true, messages: [message(now, 11)] });
  await scan(); await scan(); await scan();
  assert.equal(calls, 2); assert.equal((await f.registry.listAppMessageState([73]))[0].unreadCount, 1);
});
test('positive observation cache never authorizes a revoked phone or clears its unread state', async () => {
  const now = 1800000000000, f = registryFixture({ clock: () => now }), enrolled = await f.enroll();
  await f.bridge.observeIncomingMessages({ channel, verifiedIncoming: true, messages: [message(now, 11)] });
  await f.registry.revokeDevice(enrolled.result.body.deviceId);
  const result = await f.request('POST', '/api/operator-android/messages/state', { channelIds: [73] }, enrolled.result.body.deviceToken);
  assert.equal(result.status, 401);
  assert.equal((await f.registry.listAppMessageState([73]))[0].unreadCount, 1);
});
test('an empty day of recovery discovery uses 1440 scans instead of 5760', () => {
  let now = 1800000000000, scans = 0; const cadence = createRecoveryCadence({ now: () => now });
  for (let i = 0; i < 5760; i++, now += 15000) {
    const ticket = cadence.begin(); if (ticket) { scans++; cadence.finish(ticket, { count: 0 }); }
  }
  assert.equal(scans, 1440);
});
test('committed activity beats an in-flight empty/error scan and pending work keeps the short cadence', () => {
  let now = 1000; const cadence = createRecoveryCadence({ now: () => now });
  const old = cadence.begin(); cadence.wake(); cadence.finish(old, { failed: true });
  const fresh = cadence.begin(); assert.ok(fresh); cadence.finish(fresh, { count: 1 });
  now += 14999; assert.equal(cadence.begin(), null); now++; assert.ok(cadence.begin());
});
test('storage outages back off to five minutes while explicit call actions wake immediately', () => {
  let now = 1000; const cadence = createRecoveryCadence({ now: () => now });
  for (const delay of [30000, 60000, 120000, 240000, 300000, 300000]) {
    const ticket = cadence.begin(); assert.ok(ticket); cadence.finish(ticket, { failed: true });
    now += delay - 1; assert.equal(cadence.begin(), null); now++;
  }
  cadence.wake(); assert.ok(cadence.begin());
});
