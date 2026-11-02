import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageNotificationWorker } from '../operator-message-worker.js';
import { deferred } from './operator-r12-helpers.mjs';
const settle = () => new Promise(resolve => setImmediate(resolve));

test('idle discovery never hydrates or publishes and defaults to one-second repair', async () => {
  const timers = [];
  const worker = createMessageNotificationWorker({ scan: async () => [], hydrate: async () => { throw Error('idle hydration'); },
    publish: async () => { throw Error('idle push'); }, setTimeoutImpl: (_, delay) => { timers.push(delay); return 1; }, clearTimeoutImpl() {} });
  worker.start(); await worker.tick(); await settle();
  // A concurrent wake coalesces immediately; the next ordinary scan uses 1s.
  await worker.tick(); assert.equal(timers.at(-1), 1000); worker.close();
});

test('a stalled send cannot block discovery and dispatch of a newer event', async () => {
  const blocked = deferred(), events = []; let rows = [{ id: 1 }];
  const worker = createMessageNotificationWorker({ scan: async () => rows, hydrate: async value => value,
    publish: async row => { events.push(row.id); if (row.id === 1) await blocked.promise; return { ok: true }; } });
  await worker.tick(); await settle(); rows = [{ id: 2 }, { id: 1 }];
  await worker.tick(); await settle(); assert.deepEqual(events, [1, 2]);
  blocked.resolve(); await settle(); await worker.tick(); await settle();
  assert.deepEqual(events, [1, 2]); worker.close();
});

test('discovery is bounded and retry errors preserve a later attempt', async () => {
  let at = 1000, attempts = 0, hydration = 0;
  const worker = createMessageNotificationWorker({ now: () => at, scan: async () => [{ id: 1 }],
    hydrate: async rows => { hydration++; return rows; }, publish: async () => { attempts++; if (attempts === 1) throw Error('offline'); return { ok: true }; } });
  await worker.tick(); await settle(); await worker.tick(); assert.equal(attempts, 1); assert.equal(hydration, 1);
  at += 2000; await worker.tick(); await settle(); assert.equal(attempts, 2); worker.close();
});
