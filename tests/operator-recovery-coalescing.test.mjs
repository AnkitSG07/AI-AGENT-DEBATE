import test from 'node:test';
import assert from 'node:assert/strict';
import { createOperatorMediaGateway } from '../operator-media-gateway.js';
import { deferred } from './operator-r12-helpers.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const until = async condition => {
  for (let i = 0; i < 100; i++) { if (condition()) return; await tick(); }
  assert.fail('Expected isolated recovery work to reach its test barrier');
};
function make({ realtime = async () => {}, recover = async () => ({ recovered: true }) } = {}) {
  let wake;
  const gateway = createOperatorMediaGateway({
    firestoreRuntime: { firestore: {}, collectionPrefix: 'test_recovery', deviceRegistry: {} },
    env: { WHATSAPP_PHONE_NUMBER_ID: 'business-1', META_WHATSAPP_APP_SECRET: 'test-secret', SH_NATIVE_CALLS_ENABLED: 'true' },
    storeFactory: () => ({}),
    runtimeFactory: args => {
      wake = args.onWorkAvailable;
      return { runtime: { dispatchRealtimeWork: realtime, recoverSession: recover, locate: async () => null },
        controller: {}, verifyConfiguration: async () => ({ controlApiReachable: true }) };
    },
    logger: { warn() {} }
  });
  return { gateway, wake };
}

test('same-call wakes keep priority independent and coalesce full housekeeping with one dirty follow-up', async () => {
  const first = deferred(); let priority = 0, passes = 0, active = 0, maximum = 0;
  const f = make({ realtime: async () => { priority++; }, recover: async () => {
    passes++; active++; maximum = Math.max(maximum, active);
    try { if (passes === 1) await first.promise; return { recovered: true }; }
    finally { active--; }
  } });
  f.wake('call-a'); await until(() => passes === 1);
  for (let i = 0; i < 12; i++) f.wake('call-a');
  await until(() => priority === 13); await tick();
  assert.equal(passes, 1); assert.equal(maximum, 1);
  first.resolve(); await until(() => passes === 2 && active === 0); await tick();
  assert.equal(passes, 2); assert.equal(maximum, 1);
  f.wake('call-a'); await until(() => passes === 3);
  await f.gateway.close();
});

test('End priority reaches a call while earlier priority FCM and full housekeeping are stalled', async () => {
  const push = deferred(), housekeeping = deferred(); let events = 0, ended = false, passes = 0;
  const f = make({ realtime: async () => {
    events++;
    if (events === 2) await push.promise;
    if (events === 3) ended = true;
  }, recover: async () => { passes++; if (passes === 1) await housekeeping.promise; return { recovered: true }; } });
  f.wake('call-a'); await until(() => passes === 1);
  f.wake('call-a'); await until(() => events === 2);
  f.wake('call-a'); await until(() => ended);
  assert.equal(passes, 1, 'End dispatch must not await either old FCM or reconciliation');
  push.resolve(); housekeeping.resolve(); await until(() => passes >= 2); await tick();
  await f.gateway.close();
});

test('unrelated calls reconcile in parallel while a call has stalled housekeeping', async () => {
  const blocked = deferred(); let a = 0, b = 0;
  const f = make({ recover: async id => {
    if (id === 'call-a') { a++; await blocked.promise; } else b++;
    return { recovered: true };
  } });
  f.wake('call-a'); await until(() => a === 1);
  f.wake('call-b'); await until(() => b === 1);
  blocked.resolve(); await tick(); await f.gateway.close();
});

test('failed housekeeping clears its per-call entry so the next wake can retry', async () => {
  let passes = 0;
  const f = make({ recover: async () => { passes++; if (passes === 1) throw Error('Synthetic durable transport failure'); return { recovered: true }; } });
  f.wake('call-a'); await until(() => passes === 1); await tick();
  f.wake('call-a'); await until(() => passes === 2); await tick();
  await f.gateway.close();
});
