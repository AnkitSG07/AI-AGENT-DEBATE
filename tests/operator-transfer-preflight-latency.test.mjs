import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, deferred } from './operator-r12-helpers.mjs';
import { sessionKey } from '../call-runtime/call-runtime.mjs';
import { callStoreKey } from '../media/transfer-controller.mjs';

const observedWithin = async promise => {
  let timer;
  try { return await Promise.race([promise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 200); })]); }
  finally { clearTimeout(timer); }
};

test('invalid destination is rejected before either transfer preflight lookup starts', async () => {
  const f = fixture(), call = await f.connected();
  const store = f.runtime.store, get = store.get.bind(store);
  let canonicalReads = 0, destinationReads = 0;
  f.runtime.store = { ...store, get: async key => {
    if (key === callStoreKey(call.call.providerCallId)) canonicalReads++;
    return get(key);
  } };
  const resolve = f.runtime.resolveDevice;
  f.runtime.resolveDevice = async (...args) => { if (args[0] === undefined) destinationReads++; return resolve(...args); };
  await assert.rejects(f.runtime.transfer('a', call.call.sessionId, 'invite', {
    version: call.call.version, requestId: 'parallel-transfer-invalid'
  }), { code: 'INVALID_INPUT' });
  assert.equal(canonicalReads, 0, 'invalid input must not leave an unobserved parallel lookup');
  assert.equal(destinationReads, 0);
});

test('transfer invite starts destination lookup while the independent canonical hint is in flight', async () => {
  const f = fixture(), call = await f.connected();
  const canonical = deferred(), destination = deferred(), release = deferred();
  const store = f.runtime.store, get = store.get.bind(store), resolve = f.runtime.resolveDevice;
  let held = false;
  f.runtime.store = { ...store, get: async key => {
    if (!held && key === callStoreKey(call.call.providerCallId)) {
      held = true; canonical.resolve(); await release.promise;
    }
    return get(key);
  } };
  f.runtime.resolveDevice = async (...args) => {
    if (args[0] === 'b') destination.resolve();
    return resolve(...args);
  };
  const inviting = f.runtime.transfer('a', call.call.sessionId, 'invite', {
    version: call.call.version, toDeviceId: 'b', requestId: 'parallel-transfer-preflight'
  });
  await canonical.promise;
  let overlapped;
  try { overlapped = await observedWithin(destination.promise); }
  finally { release.resolve(); }
  const result = await inviting;
  assert.equal(overlapped, true, 'an independent registry read must not wait for the canonical hint round trip');
  assert.equal(result.call.transfer.status, 'invited');
  assert.equal(result.call.ownerDeviceId, 'a');
});

test('revocation after the overlapping hint is caught by authoritative transfer validation', async () => {
  const f = fixture(), call = await f.connected();
  const canonical = deferred(), release = deferred(), destination = deferred();
  const store = f.runtime.store, get = store.get.bind(store), resolve = f.runtime.resolveDevice;
  let held = false;
  f.runtime.store = { ...store, get: async key => {
    if (!held && key === callStoreKey(call.call.providerCallId)) {
      held = true; canonical.resolve(); await release.promise;
    }
    return get(key);
  } };
  f.runtime.resolveDevice = async (...args) => {
    const value = await resolve(...args);
    if (args[0] === 'b') destination.resolve();
    return value;
  };
  const outcome = f.runtime.transfer('a', call.call.sessionId, 'invite', {
    version: call.call.version, toDeviceId: 'b', requestId: 'parallel-transfer-revoked'
  }).then(value => ({ value }), error => ({ error }));
  await canonical.promise;
  let overlapped;
  try {
    overlapped = await observedWithin(destination.promise);
    f.devices.get('b').revoked = true;
  } finally { release.resolve(); }
  const result = await outcome;
  assert.equal(overlapped, true);
  assert.ok(result.error, 'an old preflight hint cannot authorize a revoked destination');
  assert.equal(result.error.code, 'TARGET_UNAVAILABLE');
  f.runtime.store = store;
  const current = await f.runtime.status('a', call.call.sessionId);
  assert.equal(current.call.ownerDeviceId, 'a');
  assert.equal(current.call.transfer, null);
});

test('committed invitation wakes notification delivery before response projection reads finish', async () => {
  const f = fixture(), call = await f.connected();
  const blocked = deferred(), delivered = deferred(), release = deferred();
  const store = f.runtime.store, get = store.get.bind(store), transaction = store.transaction.bind(store);
  let committed = false, responseReads = 0, wake;
  f.runtime.store = { ...store,
    transaction: async operation => {
      const result = await transaction(operation);
      if (!committed) committed = (await get(sessionKey(call.call.sessionId)))?.outbox
        ?.some(item => item.event === 'transfer-incoming') === true;
      return result;
    },
    get: async key => {
      // The two response reads start synchronously together, before the queued
      // delivery wake. Keep the real outbox's own freshness reads available.
      if (committed && ++responseReads <= 2) { blocked.resolve(); await release.promise; }
      return get(key);
    }
  };
  f.runtime.onWorkAvailable = id => {
    wake = Promise.resolve().then(() => f.runtime.dispatchSetupSignals(id));
    return wake;
  };
  f.runtime.notify = async event => { if (event.event === 'transfer-incoming') delivered.resolve(); };
  const inviting = f.runtime.transfer('a', call.call.sessionId, 'invite', {
    version: call.call.version, toDeviceId: 'b', requestId: 'parallel-transfer-dispatch'
  });
  await blocked.promise;
  let prompt;
  try { prompt = await observedWithin(delivered.promise); }
  finally { release.resolve(); }
  const result = await inviting;
  if (wake) await wake;
  assert.equal(prompt, true, 'FCM dispatch must not queue behind the source response projection');
  assert.equal(result.call.transfer.status, 'invited');
});
