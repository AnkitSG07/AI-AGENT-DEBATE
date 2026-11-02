import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, deferred, gatewayFixture } from './operator-r12-helpers.mjs';
import { recoverMediaWork } from '../media-store/firestore-media-store.mjs';
import { cleanupRetryDelay } from '../media/cleanup-retry.mjs';
import { MediaError } from '../media/errors.mjs';
import { LiveKitWhatsAppProvider } from '../media/livekit-provider.mjs';
import { callStoreKey } from '../media/transfer-controller.mjs';

const within = promise => Promise.race([promise.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 300))]);

test('End sends ring cancellation while the audio provider disconnect is blocked', async () => {
  const f = fixture(), connected = await f.connected(), entered = deferred(), release = deferred(), alerted = deferred();
  f.provider.terminateCustomer = async () => { entered.resolve(); await release.promise; };
  f.runtime.notify = async event => { if (event.event === 'ended') alerted.resolve(); };
  await f.runtime.end('a', connected.call.sessionId, { expectedOwnerLegId: connected.call.ownerLegId, requestId: 'cancel-priority-test' });
  const work = f.runtime.dispatchRealtimeWork(connected.call.sessionId);
  await entered.promise;
  let reached;
  try { reached = await within(alerted.promise); }
  finally { release.resolve(); await work; }
  assert.equal(reached, true, 'a provider timeout cannot become a ring-cancellation delay');
});

test('committed End browser hint is published before blocked provider acknowledgement', async () => {
  const f = fixture(), connected = await f.connected(), entered = deferred(), release = deferred(), projected = deferred();
  f.provider.terminateCustomer = async () => { entered.resolve(); await release.promise; };
  const gateway = gatewayFixture(f, { onCallState: async ({ view }) => { if (view.terminal) projected.resolve(); } });
  await f.runtime.end('a', connected.call.sessionId, { expectedOwnerLegId: connected.call.ownerLegId, requestId: 'projection-priority-test' });
  await entered.promise;
  let reached;
  try { reached = await within(projected.promise); }
  finally { release.resolve(); await new Promise(resolve => setTimeout(resolve, 10)); await gateway.close(); }
  assert.equal(reached, true);
});

test('recent and active cleanup retain fast retries; only stale terminal failures back off', () => {
  assert.equal(cleanupRetryDelay(1, null, 1000), 2000);
  assert.equal(cleanupRetryDelay(20, null, 1000), 30000);
  assert.equal(cleanupRetryDelay(20, { endedAt: 1000 }, 299000), 30000);
  assert.equal(cleanupRetryDelay(20, { endedAt: 1000 }, 301000), 3600000);
});

test('a day of stale failed call cleanup stays bounded and never claims a successful disconnect', async t => {
  const f = fixture(), connected = await f.connected(); let attempts = 0;
  f.provider.terminateCustomer = async () => { attempts++; throw new MediaError('MEDIA_PROVIDER_ERROR', 'Synthetic failure', 502); };
  await f.runtime.end('a', connected.call.sessionId, { expectedOwnerLegId: connected.call.ownerLegId, requestId: 'quota-stale-cleanup' });
  f.advance(301000);
  const before = f.db.version;
  for (let tick = 0; tick < 86400000 / 15000; tick++) {
    f.advance(15000);
    await recoverMediaWork({ store: f.store, controller: f.controller, workerId: 'bounded-cleanup-day',
      recoverSession: id => f.runtime.recoverSession(id, { limit: 8 }) });
  }
  const current = { call: await f.runtime.view(await f.runtime.locate(connected.call.sessionId)) };
  t.diagnostic(JSON.stringify({ simulatedHours: 24, attempts, documentWrites: f.db.version - before }));
  assert.ok(attempts <= 40); assert.ok(f.db.version - before < 500);
  assert.equal(current.call.endConfirmed, false);
  assert.equal(current.call.cleanupPending, true);
});

const absenceProvider = listParticipants => new LiveKitWhatsAppProvider(
  { origin: 'https://synthetic.livekit.cloud', apiKey: 'synthetic', apiSecret: 'synthetic' },
  { clients: { connector: {}, rooms: { listParticipants } } });

test('connector absence requires the exact room and customer, including non-active participants', async () => {
  const seen = [], provider = absenceProvider(async room => { seen.push(room); return [{ identity: 'exact-customer', state: 0 }]; });
  const binding = { roomName: 'exact-room', customerIdentity: 'exact-customer' };
  assert.equal(await provider.confirmCustomerAbsent(binding), false);
  assert.deepEqual(seen, ['exact-room']);
  provider.rooms.listParticipants = async () => [{ identity: 'another-customer', state: 2 }];
  assert.equal(await provider.confirmCustomerAbsent(binding), true);
});

test('only official room absence proves connector cleanup; permissions, timeout and malformed rows do not', async () => {
  const binding = { roomName: 'exact-room', customerIdentity: 'exact-customer' };
  const provider = absenceProvider(async () => { throw Object.assign(Error('synthetic'), { code: 'not_found', status: 404 }); });
  assert.equal(await provider.confirmCustomerAbsent(binding), true);
  for (const error of [Object.assign(Error('synthetic'), { status: 404 }),
    Object.assign(Error('synthetic'), { code: 'permission_denied', status: 403 }), Error('synthetic timeout')]) {
    provider.rooms.listParticipants = async () => { throw error; };
    await assert.rejects(provider.confirmCustomerAbsent(binding));
  }
  provider.rooms.listParticipants = async () => null;
  await assert.rejects(provider.confirmCustomerAbsent(binding));
});

async function confirmedCleanupFixture(absence) {
  const f = fixture(), connected = await f.connected();
  f.provider.terminateCustomer = async () => { throw new MediaError('MEDIA_PROVIDER_ERROR', 'Synthetic repeated disconnect', 502); };
  if (absence) f.provider.confirmCustomerAbsent = absence;
  await f.runtime.ingestVerifiedMetaEvent({ verified: true, eventId: 'confirmed-customer-ended', type: 'terminate',
    callId: connected.call.callId, phoneNumberId: 'business-1', occurredAtMs: f.now() });
  return { f, connected };
}

test('confirmed End settles a failed connector disconnect only after exact absence and keeps operator detach cleanup', async () => {
  const observed = [], { f, connected } = await confirmedCleanupFixture(async binding => { observed.push(binding); return true; });
  const before = await f.store.get(callStoreKey(connected.call.callId));
  f.provider.detachOperator = async () => { throw Error('synthetic detach failure'); };
  await f.controller.drainOutbox(connected.call.callId);
  const call = await f.store.get(callStoreKey(connected.call.callId));
  assert.deepEqual(observed, [{ roomName: before.roomName, customerIdentity: before.customerIdentity }]);
  assert.equal(call.outbox.find(job => job.kind === 'terminate').status, 'done');
  assert.ok(call.outbox.some(job => job.kind === 'detach' && job.status === 'pending'));
  assert.equal(call.terminal.confirmedAt, before.terminal.confirmedAt);
});

test('local End cannot use room absence to fabricate confirmation, and confirmed End keeps retrying on present/unknown customer', async () => {
  const f = fixture(), connected = await f.connected(); let checked = 0;
  f.provider.terminateCustomer = async () => { throw Error('synthetic failure'); };
  f.provider.confirmCustomerAbsent = async () => { checked++; return true; };
  await f.runtime.end('a', connected.call.sessionId, { expectedOwnerLegId: connected.call.ownerLegId, requestId: 'no-false-absence-end' });
  await f.controller.drainOutbox(connected.call.callId);
  assert.equal(checked, 0);
  assert.equal((await f.runtime.view(await f.runtime.locate(connected.call.sessionId))).endConfirmed, false);
  for (const absence of [async () => false, async () => { throw Error('synthetic lookup failure'); }]) {
    const { f: other, connected: call } = await confirmedCleanupFixture(absence);
    await other.controller.drainOutbox(call.call.callId);
    assert.equal((await other.store.get(callStoreKey(call.call.callId))).outbox.find(job => job.kind === 'terminate').status, 'pending');
  }
});

test('verified connector absence removes a confirmed ended call from a full day of recovery writes', async t => {
  async function simulate(verifyAbsence) {
    let checks = 0;
    const { f, connected } = await confirmedCleanupFixture(verifyAbsence ? async () => { checks++; return true; } : null);
    await f.runtime.recoverSession(connected.call.sessionId, { limit: 8 });
    const before = f.db.version;
    for (let minute = 0; minute < 1440; minute++) {
      f.advance(60000);
      await recoverMediaWork({ store: f.store, controller: f.controller, workerId: 'confirmed-ended-day',
        recoverSession: id => f.runtime.recoverSession(id, { limit: 8 }) });
    }
    return { writes: f.db.version - before, checks,
      pending: (await f.store.get(callStoreKey(connected.call.callId))).outbox.filter(job => job.status !== 'done').length };
  }
  const beforeFix = await simulate(false), afterFix = await simulate(true);
  t.diagnostic(JSON.stringify({ simulatedHours: 24, beforeFix, afterFix }));
  assert.ok(beforeFix.writes > 200); assert.ok(beforeFix.pending > 0);
  assert.deepEqual(afterFix, { writes: 0, checks: 1, pending: 0 });
});

test('provider End arriving during a failed business disconnect enables exact absence verification on retry', async () => {
  const f = fixture(), connected = await f.connected(), entered = deferred(), release = deferred(), reasons = [];
  f.provider.terminateCustomer = async job => { reasons.push(job.reason); entered.resolve(); await release.promise; throw Error('synthetic disconnect failure'); };
  let checks = 0;
  f.provider.confirmCustomerAbsent = async () => { checks++; return true; };
  await f.runtime.end('a', connected.call.sessionId, { expectedOwnerLegId: connected.call.ownerLegId, requestId: 'provider-end-during-disconnect' });
  const draining = f.controller.drainOutbox(connected.call.callId, { limit: 1 });
  await entered.promise;
  await f.runtime.ingestVerifiedMetaEvent({ verified: true, eventId: 'provider-ended-during-running-job', type: 'terminate',
    callId: connected.call.callId, phoneNumberId: 'business-1', occurredAtMs: f.now() });
  release.resolve(); await draining;
  assert.equal(checks, 0, 'the first lease had no committed terminal proof');
  f.advance(3000); await f.controller.drainOutbox(connected.call.callId);
  assert.deepEqual(reasons, ['BUSINESS_INITIATED', 'USER_INITIATED']);
  assert.equal(checks, 1);
  assert.equal((await f.store.get(callStoreKey(connected.call.callId))).outbox.find(job => job.kind === 'terminate').status, 'done');
});
