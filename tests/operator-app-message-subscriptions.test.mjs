import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppMessageState } from '../operator-app-message-state.js';
import { FirestoreFake, registryFixture } from './operator-r12-helpers.mjs';

function fixture(options = {}) {
  let now = 1800000000000;
  const db = new FirestoreFake(), collection = db.collection.bind(db), write = db.write.bind(db);
  const listeners = new Map(), history = [], timers = new Map();
  let starts = 0, stops = 0, deliveries = 0, sequence = 0;
  db.collection = path => {
    const c = collection(path), doc = c.doc.bind(c);
    c.doc = id => {
      const ref = doc(id);
      ref.onSnapshot = (next, fail) => {
        starts++;
        const listener = { next, fail, ref, closed: false };
        history.push(listener);
        const active = listeners.get(ref.path) || new Set(); active.add(listener); listeners.set(ref.path, active);
        if (options.synchronousFailure) fail(Error('PRIVATE_SDK_DETAILS'));
        else if (options.throwSubscribe) throw Error('PRIVATE_SDK_DETAILS');
        else if (!options.manualInitial) queueMicrotask(() => { if (!listener.closed) { deliveries++; next(db.snapshot(ref)); } });
        return () => { if (!listener.closed) { listener.closed = true; stops++; active.delete(listener); } };
      };
      return ref;
    };
    return c;
  };
  db.write = (ref, value, remove = false) => {
    write(ref, value, remove);
    const snapshot = db.snapshot(ref);
    if (options.pauseChanges) return;
    for (const listener of listeners.get(ref.path) || [])
      queueMicrotask(() => { if (!listener.closed) { deliveries++; listener.next(snapshot); } });
  };
  const subscriptionOptions = {
    maxEntries: 1000, idleMs: 900000, initialTimeoutMs: 8000, retryMs: 30000,
    setTimeoutImpl(callback, delay) { const id = ++sequence; timers.set(id, { callback, at: now + delay }); return { id, unref() {} }; },
    clearTimeoutImpl(handle) { timers.delete(handle?.id); }, ...options
  };
  const state = createAppMessageState({ firestore: db, collectionPrefix: 'test', clock: () => now, subscriptionOptions });
  return { state, db, history, stats: () => ({ starts, stops, deliveries, timers: timers.size }),
    async advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); } await Promise.resolve(); },
    fail(id = 73) { for (const l of listeners.get('test_app_messages/' + id) || []) l.fail(Error('PRIVATE_SDK_DETAILS')); },
    flush: async () => { await Promise.resolve(); await Promise.resolve(); }
  };
}

test('four idle phones share one unread subscription per chat instead of repeated Firestore list reads', async () => {
  const f = fixture(); const ids = Array.from({ length: 100 }, (_, i) => i + 1);
  try {
    for (let minute = 0; minute < 60; minute += 5) {
      const phones = await Promise.all(Array.from({ length: 4 }, () => f.state.list(ids)));
      assert.equal(phones[0].length, 100); assert.equal(phones[3][0].unreadCount, 0);
      await f.advance(5 * 60000);
    }
    assert.equal(f.db.transactionRuns, 0, 'Idle list requests must not issue repeated Firestore read transactions');
    assert.deepEqual(f.stats(), { starts: 100, stops: 0, deliveries: 100, timers: 1 });
  } finally { f.state.close?.(); }
});

test('committed local mutations and remote changes update the shared projection without a list query', async () => {
  const f = fixture();
  try {
    await f.state.list([73]);
    await f.state.observe({ channelId: 73, messageIds: [10, 11] });
    let value = (await f.state.list([73]))[0]; assert.equal(value.unreadCount, 2);
    await f.state.change({ channelId: 73, throughMessageId: 11, expectedStateVersion: value.stateVersion }, async () => {});
    value = (await f.state.list([73]))[0]; assert.equal(value.unreadCount, 0);
    const ref = f.db.collection('test_app_messages').doc('73'), before = f.db.dump()[ref.path];
    f.db.write(ref, { ...before, stateVersion: before.stateVersion + 1, manualUnread: true }); await f.flush();
    value = (await f.state.list([73]))[0]; assert.equal(value.unreadCount, 1); assert.equal(value.stateVersion, 3);
    assert.equal(f.stats().starts, 1); assert.equal(f.db.transactionRuns, 2, 'Only actual mutations use transactions');
  } finally { f.state.close?.(); }
});

test('a failed listener fails closed, detaches and backs off instead of serving stale unread state', async () => {
  const f = fixture();
  try {
    await f.state.list([73]); f.fail();
    await assert.rejects(f.state.list([73]), { status: 503, code: 'APP_MESSAGE_STATE_UNAVAILABLE' });
    await assert.rejects(f.state.list([73]), error => !error.message.includes('PRIVATE_SDK_DETAILS'));
    assert.equal(f.stats().starts, 1); assert.equal(f.stats().stops, 1);
    await f.advance(30000); assert.equal((await f.state.list([73]))[0].unreadCount, 0); assert.equal(f.stats().starts, 2);
  } finally { f.state.close?.(); }
});

test('old listener callbacks cannot overwrite a newer committed state or an evicted subscription', async () => {
  const f = fixture({ maxEntries: 1 });
  try {
    await f.state.list([73]); await f.state.observe({ channelId: 73, messageIds: [10] });
    const old = f.history[0], earlier = f.db.snapshot(old.ref);
    await f.state.observe({ channelId: 73, messageIds: [11] });
    old.next(earlier); assert.equal((await f.state.list([73]))[0].unreadCount, 2);
    await f.state.list([74]); assert.equal(f.stats().stops, 1);
    old.fail(Error('stale listener')); old.next(earlier);
    assert.equal((await f.state.list([74]))[0].unreadCount, 0); assert.equal(f.stats().starts, 2);
  } finally { f.state.close?.(); }
});

test('idle subscriptions expire and close detaches all watches without retaining pending waiters', async () => {
  const f = fixture();
  await f.state.list([73, 74]); await f.advance(900000);
  assert.equal(f.stats().stops, 2); assert.equal(f.stats().timers, 0);
  await f.state.list([73]); f.state.close();
  assert.equal(f.stats().stops, 3); assert.equal(f.stats().timers, 0);
  await assert.rejects(f.state.list([73]), { status: 503 });
});

test('unsupported injected Firestore clients keep the original fresh read-only transaction path', async () => {
  const db = new FirestoreFake(), state = createAppMessageState({ firestore: db, collectionPrefix: 'test' });
  assert.equal((await state.list([73]))[0].unreadCount, 0); assert.equal((await state.list([73]))[0].unreadCount, 0);
  assert.equal(db.transactionRuns, 2); state.close?.();
});

test('successful local commits are visible before delayed watch callbacks and failed commits never publish', async () => {
  const f = fixture({ pauseChanges: true });
  try {
    await f.state.list([73]);
    await f.state.observe({ channelId: 73, messageIds: [11] });
    const value = (await f.state.list([73]))[0]; assert.equal(value.unreadCount, 1); assert.equal(value.stateVersion, 1);
    f.db.failBeforeCommit = Error('transaction failed before commit');
    await assert.rejects(f.state.change({ channelId: 73, throughMessageId: 11, expectedStateVersion: value.stateVersion }, async () => {}));
    assert.deepEqual((await f.state.list([73]))[0], value);
    await f.state.change({ channelId: 73, throughMessageId: 11, expectedStateVersion: value.stateVersion }, async () => {});
    assert.equal((await f.state.list([73]))[0].unreadCount, 0);
  } finally { f.state.close(); }
});

test('missing initial snapshots time out, detach and retry with a bounded circuit', async () => {
  const f = fixture({ manualInitial: true });
  try {
    const pending = assert.rejects(f.state.list([73]), { status: 503 });
    await f.advance(8000); await pending;
    assert.equal(f.stats().starts, 1); assert.equal(f.stats().stops, 1); assert.equal(f.stats().timers, 0);
    await assert.rejects(f.state.list([73]), { status: 503 }); assert.equal(f.stats().starts, 1);
  } finally { f.state.close(); }
});

test('synchronous SDK registration failures release pending callers without leaked watches or timers', async () => {
  for (const options of [{ synchronousFailure: true }, { throwSubscribe: true }]) {
    const f = fixture(options);
    await assert.rejects(f.state.list([73]), error => error.status === 503 && !error.message.includes('PRIVATE_SDK_DETAILS'));
    assert.equal(f.stats().timers, 0);
    if (options.synchronousFailure) assert.equal(f.stats().stops, 1);
    f.state.close();
  }
});

test('closing while the initial snapshot is pending releases callers and cancels all timers', async () => {
  const f = fixture({ manualInitial: true });
  const pending = assert.rejects(f.state.list([73]), { status: 503 });
  f.state.close(); await pending;
  assert.equal(f.stats().stops, 1); assert.equal(f.stats().timers, 0);
});

test('an active unread projection never substitutes for fresh request authorization', async () => {
  const f = fixture(), api = registryFixture({ db: f.db });
  try {
    const enrollment = await api.enroll(), token = enrollment.result.body.deviceToken;
    const first = await api.request('POST', '/api/operator-android/messages/state', { channelIds: [73] }, token);
    assert.equal(first.status, 200); assert.equal(f.stats().starts, 1);
    await api.registry.revokeDevice(enrollment.result.body.deviceId);
    const later = await api.request('POST', '/api/operator-android/messages/state', { channelIds: [73] }, token);
    assert.equal(later.status, 401); assert.equal(f.stats().starts, 1);
  } finally { api.registry.closeAppMessageState?.(); f.state.close(); }
});


test('deleting a previously observed ledger invalidates the projection instead of serving it forever', async () => {
  const f = fixture();
  try {
    await f.state.list([73]); await f.state.observe({ channelId: 73, messageIds: [11] });
    const ref = f.db.collection('test_app_messages').doc('73');
    f.db.write(ref, undefined, true); await f.flush();
    await assert.rejects(f.state.list([73]), { status: 503 });
    await f.advance(30000); assert.equal((await f.state.list([73]))[0].unreadCount, 0);
  } finally { f.state.close(); }
});
