import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, deferred, gatewayFixture } from './operator-r12-helpers.mjs';
import { recoverMediaWork } from '../media-store/firestore-media-store.mjs';
import { cleanupRetryDelay } from '../media/cleanup-retry.mjs';
import { MediaError } from '../media/errors.mjs';

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
