'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { context, deferred, source } = require('./production-functions.cjs');

function runtime() {
  return { channels: new Map(), pending: new Map(), lists: new Map(), readRequests: new Map(), acknowledged: new Map(), lastReadAttempts: new Map(), intents: new Map(),
    manualUnread: new Set(), lastApplied: new Map(), sequence: 0, frame: null };
}
function record(extra = {}) { return { channelId: 73, latestMessageId: 900, readThroughMessageId: 800, unreadCount: 3, stateVersion: 1, ...extra }; }

test('native unread is independent of website/Odoo counters, including a zero Odoo counter', () => {
  const r = runtime(); r.channels.set(73, record());
  const c = context(['channelUnreadCount'], { hasHubNativeBridge: () => true, appUnreadRuntime: r });
  assert.equal(c.channelUnreadCount({ id: 73, message_unread_counter: 0, _uiUnreadCount: 0 }), 3);
  assert.equal(c.channelUnreadCount({ id: 73, message_unread_counter: 100, unread_count: 100 }), 3);
  assert.equal(c.channelUnreadCount({ id: 74, message_unread_counter: 100 }), 0);
  assert.equal(r.channels.has(74), false, 'unknown app state must remain unknown, rather than becoming an Odoo zero read cursor');
});

test('the ordinary website retains its Odoo unread contract and native mode never calls Odoo mark-as-read', async () => {
  let calls = 0;
  const c = context(['channelUnreadCount', 'tryMarkChannelRead'], {
    hasHubNativeBridge: () => false, callKw: async () => { calls++; return true; }
  });
  assert.equal(c.channelUnreadCount({ id: 73, message_unread_counter: 4 }), 4);
  assert.equal(await c.tryMarkChannelRead(73), true); assert.equal(calls, 1);
  c.hasHubNativeBridge = () => true;
  assert.equal(await c.tryMarkChannelRead(73), false); assert.equal(calls, 1);
});

test('late list/read responses cannot roll back newer incoming messages or app read cursors', () => {
  const r = runtime(); let renders = 0;
  const c = context(['applyAppMessageState'], { state: { destroyed: false }, appUnreadRuntime: r,
    hasHubNativeBridge: () => true, applyFiltersAndRender: () => renders++, queueVisibleAppMessageRead() {} });
  assert.equal(c.applyAppMessageState({ ok: true, channels: [record()] }, 10), true);
  assert.equal(c.applyAppMessageState({ ok: true, channels: [record({ latestMessageId: 899 })] }, 11), false);
  assert.equal(c.applyAppMessageState({ ok: true, channels: [record({ readThroughMessageId: 799 })] }, 12), false);
  assert.equal(c.applyAppMessageState({ ok: true, channels: [record({ unreadCount: 0 })] }, 9), false);
  assert.equal(r.channels.get(73).unreadCount, 3);
  assert.equal(c.applyAppMessageState({ ok: true, state: record({ latestMessageId: 901, readThroughMessageId: 900, unreadCount: 1, stateVersion: 2 }) }, 13), true);
  assert.equal(r.channels.get(73).unreadCount, 1); assert.equal(renders, 2);
});

function viewFixture() {
  const r = runtime();
  r.channels.set(73, record({ latestMessageId: 802, readThroughMessageId: 800, unreadCount: 2 }));
  const c = {
    state: { selectedChannelId: 73, selectionEpoch: 1, isLoadingMessages: false, messages: [{ id: 801, res_id: 73 }, { id: 802, res_id: 73 }] },
    appUnreadRuntime: r, appMessageStateAvailable: () => true,
    document: { hidden: false, visibilityState: 'visible' },
    window: { innerWidth: 200, innerHeight: 300 },
    hubScreenStack: [], hubScreenVisible: panel => panel?.visible === true,
    appLayout: { classList: { contains: () => true } }, chatPanel: { classList: { contains: () => false } },
    appRoot: { classList: { contains: () => false } },
    messageThread: { dataset: { channelId: '73' }, getBoundingClientRect: () => ({ top: 0, bottom: 300, left: 0, right: 200, width: 200, height: 300 }),
      querySelectorAll: () => [
        { dataset: { messageId: '801' }, getBoundingClientRect: () => ({ top: 10, bottom: 30, left: 10, right: 190 }) },
        { dataset: { messageId: '802' }, getBoundingClientRect: () => ({ top: 400, bottom: 430, left: 10, right: 190 }) },
        { dataset: { messageId: '999999' }, getBoundingClientRect: () => ({ top: 10, bottom: 30, left: 10, right: 190 }) }
      ] }
  };
  return { r, c };
}

test('a chat view acknowledges only real messages intersecting its visible viewport', () => {
  const f = viewFixture(), c = context(['visibleAppMessageCursor'], f.c);
  assert.equal(c.visibleAppMessageCursor().throughMessageId, 801);
  c.messageThread.dataset.channelId = '74'; assert.equal(c.visibleAppMessageCursor(), null);
  c.messageThread.dataset.channelId = '73'; c.state.isLoadingMessages = true; assert.equal(c.visibleAppMessageCursor(), null);
});

test('a background document, list screen, invisible thread or manually unread chat cannot acknowledge messages', () => {
  const f = viewFixture(), c = context(['visibleAppMessageCursor'], f.c);
  c.document.hidden = true; assert.equal(c.visibleAppMessageCursor(), null); c.document.hidden = false;
  c.document.visibilityState = 'hidden'; assert.equal(c.visibleAppMessageCursor(), null); c.document.visibilityState = 'visible';
  c.appLayout.classList.contains = () => false; assert.equal(c.visibleAppMessageCursor(), null); c.appLayout.classList.contains = () => true;
  c.messageThread.getBoundingClientRect = () => ({ width: 0, height: 0 }); assert.equal(c.visibleAppMessageCursor(), null);
  f.c.messageThread.getBoundingClientRect = () => ({ top: 0, bottom: 300, left: 0, right: 200, width: 200, height: 300 });
  c.appUnreadRuntime.manualUnread.add(73); assert.equal(c.visibleAppMessageCursor(), null);
});

test('visibility is checked after painting, so switching away before the frame cannot mark anything read', () => {
  const f = viewFixture(); let frame, sent = 0;
  const c = context(['visibleAppMessageCursor', 'queueVisibleAppMessageRead', 'requestAppMessageMutation'], { ...f.c,
    requestAnimationFrame: fn => { frame = fn; return 1; }, requestAppMessageState: async () => { sent++; return { ok: true }; }, applyAppMessageState() {} });
  c.queueVisibleAppMessageRead(); assert.equal(sent, 0);
  c.document.hidden = true; frame(); assert.equal(sent, 0); assert.equal(c.appUnreadRuntime.frame, null);
});

test('a duplicate visible-frame callback cannot issue two simultaneous read acknowledgements', async () => {
  const f = viewFixture(), gate = deferred(); let frame, calls = 0;
  const c = context(['visibleAppMessageCursor', 'queueVisibleAppMessageRead', 'requestAppMessageMutation'], { ...f.c,
    requestAnimationFrame: fn => { frame = fn; return 1; }, requestAppMessageState: async (operation, value) => {
      calls++; assert.equal(operation, 'read'); assert.equal(value.channelId, 73); assert.equal(value.throughMessageId, 801); return gate.promise;
    }, applyAppMessageState() {} });
  c.queueVisibleAppMessageRead(); frame(); c.queueVisibleAppMessageRead(); frame(); assert.equal(calls, 1);
  gate.resolve({ ok: true, state: record({ latestMessageId: 801, readThroughMessageId: 801, unreadCount: 0 }) }); await c.appUnreadRuntime.readRequests.get(73);
  c.queueVisibleAppMessageRead(); frame(); assert.equal(calls, 1);
});

test('native Mark as unread waits for an earlier visible-read response and never changes Odoo', async () => {
  const r = runtime(), gate = deferred(); r.readRequests.set(73, gate.promise); const calls = [];
  r.channels.set(73, record());
  const c = context(['tryMarkChannelUnread', 'requestAppMessageMutation'], { state: { destroyed: false }, appUnreadRuntime: r, hasHubNativeBridge: () => true,
    requestAppMessageState: async (operation, body) => { calls.push([operation, body.channelId]); return { ok: true, state: record({ unreadCount: 1 }) }; },
    applyAppMessageState() {}, queueVisibleAppMessageRead() {}, callKw: async () => { throw Error('Must not call Odoo'); } });
  const pending = c.tryMarkChannelUnread(73); assert.equal(calls.length, 0); assert.equal(r.manualUnread.has(73), true);
  gate.resolve(); assert.equal(await pending, true); assert.deepEqual(calls, [['unread', 73]]);
});

test('native request replies are correlated, bounded and require successful native and server status', async () => {
  const r = runtime(), sent = [], timers = new Map(); let nextTimer = 0;
  const c = context(['appMessageRequestId', 'requestAppMessageState', 'receiveAppMessageState'], { appUnreadRuntime: r, appMessageStateAvailable: () => true, crypto: webcrypto,
    hasHubNativeBridge: () => true, postHubNativeMessage: value => { sent.push(value); return true; },
    setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer; }, clearTimeout: id => timers.delete(id) });
  const promise = c.requestAppMessageState('list', { channelIds: [73] });
  assert.equal(sent[0].type, 'appMessageState'); assert.match(sent[0].requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  c.receiveAppMessageState({ detail: { requestId: 'unknown', ok: true, status: 200, body: { ok: true } } }); assert.equal(r.pending.size, 1);
  c.receiveAppMessageState({ detail: { requestId: sent[0].requestId, ok: true, status: 200, body: { ok: true, channels: [] } } });
  assert.equal((await promise).ok, true); assert.equal(r.pending.size, 0); assert.equal(timers.size, 0);
  const failed = c.requestAppMessageState('read', { channelId: 73, throughMessageId: 801 });
  c.receiveAppMessageState({ detail: { requestId: sent[1].requestId, ok: false, status: 401, body: { ok: false } } });
  await assert.rejects(failed, /could not be synced/);
  const conflict = c.requestAppMessageState('read', { channelId: 73, throughMessageId: 801, expectedStateVersion: 1 });
  c.receiveAppMessageState({ detail: { requestId: sent[2].requestId, ok: false, status: 409, body: { ok: false, code: 'APP_MESSAGE_STATE_CHANGED' } } });
  await assert.rejects(conflict, error => error.status === 409 && error.code === 'APP_MESSAGE_STATE_CHANGED');
  const expired = c.requestAppMessageState('list', { channelIds: [73] }); [...timers.values()][0]();
  await assert.rejects(expired, /timed out/); assert.equal(r.pending.size, 0);
});

test('native unread lists request at most one hundred exact channel IDs per batch and coalesce matching work', async () => {
  const r = runtime(), calls = [], gate = deferred();
  const c = context(['refreshAppMessageStates'], { state: { destroyed: false, channels: Array.from({ length: 205 }, (_, i) => ({ id: i + 1 })) },
    appUnreadRuntime: r, appMessageStateAvailable: () => true, requestAppMessageState: async (operation, body) => {
      calls.push(body.channelIds); if (calls.length === 1) await gate.promise; return { ok: true, channels: [] };
    }, applyAppMessageState: () => true });
  const a = c.refreshAppMessageStates(), b = c.refreshAppMessageStates(); assert.equal(calls.length, 1);
  gate.resolve(); await Promise.all([a, b]); assert.deepEqual(calls.map(ids => ids.length), [100, 100, 5]);
  assert.equal(new Set(calls.flat()).size, 205);
});

test('the shipped native UI labels unknown unread state and marks only after message rendering', () => {
  assert.match(source, /App unread state is syncing/);
  assert.match(source, /if \(changed\) renderConversationCollection\(\);\s+queueVisibleAppMessageRead\(\);/);
});

test('the native request UUID fallback uses cryptographic bytes and retains the native UUID format', () => {
  const c = context(['appMessageRequestId'], { crypto: { getRandomValues: bytes => { bytes.fill(255); return bytes; } } });
  assert.equal(c.appMessageRequestId(), 'ffffffff-ffff-4fff-bfff-ffffffffffff');
  c.crypto = {}; assert.throws(() => c.appMessageRequestId(), /Secure app unread sync is unavailable/);
});

test('an advancing confirmed read cursor wins over a later-started list snapshot that ran before its commit', () => {
  const r = runtime();
  const c = context(['applyAppMessageState'], { state: { destroyed: false }, appUnreadRuntime: r,
    hasHubNativeBridge: () => true, applyFiltersAndRender() {}, queueVisibleAppMessageRead() {} });
  c.applyAppMessageState({ ok: true, channels: [record({ latestMessageId: 901, readThroughMessageId: 800, unreadCount: 4 })] }, 12);
  assert.equal(c.applyAppMessageState({ ok: true, state: record({ latestMessageId: 901, readThroughMessageId: 900, unreadCount: 1, stateVersion: 2 }) }, 11), true);
  assert.equal(r.channels.get(73).readThroughMessageId, 900); assert.equal(r.lastApplied.get(73), 12);
  assert.equal(c.applyAppMessageState({ ok: true, state: record({ latestMessageId: 901, readThroughMessageId: 900, unreadCount: 0, stateVersion: 1 }) }, 10), false,
    'a stale response with no advancing watermark cannot override a later manual unread state');
});

test('an offscreen thread, an unfocused page and a covering DOM overlay cannot acknowledge messages', () => {
  const f = viewFixture(), c = context(['visibleAppMessageCursor'], f.c);
  const originalArea = c.messageThread.getBoundingClientRect;
  c.messageThread.getBoundingClientRect = () => ({ top: 500, bottom: 800, left: 0, right: 200, width: 200, height: 300 });
  assert.equal(c.visibleAppMessageCursor(), null); c.messageThread.getBoundingClientRect = originalArea;
  c.document.hasFocus = () => false; assert.equal(c.visibleAppMessageCursor(), null); c.document.hasFocus = () => true;
  const node = c.messageThread.querySelectorAll()[0]; c.messageThread.querySelectorAll = () => [node];
  c.document.elementFromPoint = () => ({ overlay: true }); assert.equal(c.visibleAppMessageCursor(), null);
  c.document.elementFromPoint = () => node; assert.equal(c.visibleAppMessageCursor().throughMessageId, 801);
  c.hubScreenStack.push({ panel: { visible: true } }); assert.equal(c.visibleAppMessageCursor(), null, 'Calls/mail/tools screen on top blocks chat read even with positive underlying rectangles');
});

test('a worker-lagged read stores only the confirmed cursor and retries when a fresh list observes the message', async () => {
  const f = viewFixture(); let frame, calls = 0;
  f.r.channels.set(73, record({ latestMessageId: 800, readThroughMessageId: 799, unreadCount: 1 }));
  const c = context(['visibleAppMessageCursor', 'queueVisibleAppMessageRead', 'applyAppMessageState', 'requestAppMessageMutation'], { ...f.c,
    state: { ...f.c.state, destroyed: false }, hasHubNativeBridge: () => true, applyFiltersAndRender() {},
    requestAnimationFrame: fn => { frame = fn; return 1; }, requestAppMessageState: async () => {
      calls++; return { ok: true, state: record({ latestMessageId: calls === 1 ? 800 : 801, readThroughMessageId: calls === 1 ? 800 : 801, unreadCount: 0, stateVersion: calls === 1 ? 2 : 4 }) };
    } });
  c.queueVisibleAppMessageRead(); frame(); await f.r.readRequests.get(73);
  assert.equal(f.r.acknowledged.get(73), 800, 'requesting 801 is not proof that the backend confirmed 801');
  frame(); assert.equal(calls, 1, 'no hot retry loop while the ingestion worker has not observed a newer message');
  c.applyAppMessageState({ ok: true, channels: [record({ latestMessageId: 801, readThroughMessageId: 800, unreadCount: 1, stateVersion: 3 })] });
  frame(); await f.r.readRequests.get(73);
  assert.equal(calls, 2); assert.equal(f.r.acknowledged.get(73), 801);
});

test('manual unread followed by reopening clears the old successful-view acknowledgement and can mark the chat read again', async () => {
  const f = viewFixture(); let frame, reads = 0;
  f.r.acknowledged.set(73, 801); f.r.lastReadAttempts.set(73, { requestedThrough: 801, observedLatest: 801 });
  const c = context(['beginAppMessageView', 'tryMarkChannelUnread', 'visibleAppMessageCursor', 'queueVisibleAppMessageRead', 'requestAppMessageMutation'], { ...f.c,
    hasHubNativeBridge: () => true, applyAppMessageState() {},
    requestAnimationFrame: fn => { frame = fn; return 1; }, requestAppMessageState: async operation => {
      if (operation === 'read') reads++;
      return { ok: true, state: record({ latestMessageId: 801, readThroughMessageId: 801, unreadCount: operation === 'unread' ? 1 : 0 }) };
    } });
  await c.tryMarkChannelUnread(73); frame(); assert.equal(reads, 0);
  c.beginAppMessageView(73); c.queueVisibleAppMessageRead(); frame(); await f.r.readRequests.get(73);
  assert.equal(reads, 1); assert.equal(f.r.acknowledged.get(73), 801);
});

test('server state versions dominate client request start order, including a later manual unread with the same watermark', () => {
  const r = runtime(), c = context(['applyAppMessageState'], { state: { destroyed: false }, appUnreadRuntime: r,
    hasHubNativeBridge: () => true, applyFiltersAndRender() {}, queueVisibleAppMessageRead() {} });
  c.applyAppMessageState({ ok: true, state: record({ readThroughMessageId: 900, unreadCount: 1, stateVersion: 3 }) }, 10);
  assert.equal(c.applyAppMessageState({ ok: true, state: record({ readThroughMessageId: 900, unreadCount: 0, stateVersion: 2 }) }, 99), false);
  assert.equal(r.channels.get(73).unreadCount, 1);
  assert.equal(c.applyAppMessageState({ ok: true, state: record({ readThroughMessageId: 900, unreadCount: 0, stateVersion: 4 }) }, 9), true);
  assert.equal(r.channels.get(73).unreadCount, 0);
  assert.equal(c.applyAppMessageState({ ok: true, state: { channelId: 73, latestMessageId: 900, readThroughMessageId: 900, unreadCount: 1 } }, 100), false,
    'an unversioned response cannot overwrite authoritative app state');
});

test('a state conflict refreshes authority and retries only the current mutation with the confirmed version', async () => {
  const r = runtime(), calls = []; r.channels.set(73, record());
  const c = context(['requestAppMessageMutation', 'applyAppMessageState'], { state: { destroyed: false }, appUnreadRuntime: r,
    hasHubNativeBridge: () => true, applyFiltersAndRender() {}, queueVisibleAppMessageRead() {},
    requestAppMessageState: async (operation, values) => {
      calls.push({ operation, ...values });
      if (operation === 'list') return { ok: true, channels: [record({ stateVersion: 2 })] };
      if (values.expectedStateVersion === 1) throw Object.assign(Error('Conflict'), { code: 'APP_MESSAGE_STATE_CHANGED' });
      return { ok: true, state: record({ stateVersion: 3, readThroughMessageId: 900, unreadCount: 0 }) };
    } });
  const result = await c.requestAppMessageMutation('read', { channelId: 73, throughMessageId: 900 }, () => true);
  assert.equal(result.state.stateVersion, 3);
  assert.deepEqual(calls.map(row => [row.operation, row.expectedStateVersion]), [['read', 1], ['list', undefined], ['read', 2]]);
});

test('a conflicted old read never retries after the operator leaves the chat or marks it unread', async () => {
  const r = runtime(), gate = deferred(), calls = []; r.channels.set(73, record()); let current = true;
  const c = context(['requestAppMessageMutation'], { appUnreadRuntime: r,
    requestAppMessageState: async operation => { calls.push(operation); return gate.promise; }, applyAppMessageState() {} });
  const pending = c.requestAppMessageMutation('read', { channelId: 73, throughMessageId: 900 }, () => current);
  current = false; gate.reject(Object.assign(Error('Conflict'), { code: 'APP_MESSAGE_STATE_CHANGED' }));
  assert.equal(await pending, null); assert.deepEqual(calls, ['read']);
});

test('mutation conflicts are bounded and never become a hot retry loop', async () => {
  const r = runtime(); r.channels.set(73, record()); let mutations = 0, lists = 0;
  const c = context(['requestAppMessageMutation', 'applyAppMessageState'], { state: { destroyed: false }, appUnreadRuntime: r,
    hasHubNativeBridge: () => true, applyFiltersAndRender() {}, queueVisibleAppMessageRead() {},
    requestAppMessageState: async operation => {
      if (operation === 'list') return { ok: true, channels: [record({ stateVersion: ++lists + 1 })] };
      mutations++; throw Object.assign(Error('Conflict'), { code: 'APP_MESSAGE_STATE_CHANGED' });
    } });
  await assert.rejects(() => c.requestAppMessageMutation('read', { channelId: 73, throughMessageId: 900 }, () => true), { code: 'APP_MESSAGE_STATE_CHANGED' });
  assert.equal(mutations, 3); assert.equal(lists, 2);
});
