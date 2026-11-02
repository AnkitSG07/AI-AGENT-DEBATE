import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
function extract(name) {
  const at = source.indexOf(`function ${name}(`), start = source.slice(at - 6, at) === 'async ' ? at - 6 : at;
  assert.ok(at > 0); const end = /^\}$/m.exec(source.slice(at)); assert.ok(end);
  return source.slice(start, at + end.index + 1);
}
function fixture({ ai = false, native = true, messages = [] } = {}) {
  const events = [], queried = [], state = { running: false, tick_count: 0 };
  const channels = [...new Set(messages.map(message => message.res_id))].map(id => ({ id, channel_type: id === 76 ? 'chat' : 'whatsapp' }));
  const context = { AI_MODE_BACKGROUND_WORKER_ENABLED: ai, AI_MODE_BACKGROUND_INTERVAL_MS: 4000, odooConfigured: true,
    aiModeGlobalState: { mode: 'zapier' }, aiModeBackgroundState: state, console: { log() {}, warn() {} }, Date,
    now: () => 'synthetic-time',
    androidPushBridge: { status: () => ({ enabled: native }), observeIncomingMessages: input => { events.push(['observe', input.channel.id]); return new Promise(() => {}); },
      publishMessage: async input => { events.push(['push', input.message.id]); return { ok: true }; } },
    aiModeBackgroundLoadProcessedIds: async () => { events.push(['load-ai']); },
    aiModeGetOdooUserContext: async () => ({ uid: 1 }), aiModeFetchRecentWorkerMessages: async () => messages,
    aiModeParseOdooDateMs: value => Date.parse(value), aiModeMessagePlainText: message => message.body || '',
    aiModeHasWorkerAttachments: () => false, aiModeSafeString: value => String(value),
    aiModeIsPreBootWorkerMessage: message => message.id === 10,
    aiModeBackgroundHasProcessed: id => id === 10, aiModeBackgroundIsProcessing: () => false,
    aiModeBackgroundIsInRetryCooldown: () => false,
    aiModeIsOwnOdooMessageForWorker: message => message.own === true, aiModeIsLikelySmartHandicraftsOutbound: message => message.outbound === true,
    aiModeBackgroundRememberProcessedIds: async () => { events.push(['journal']); },
    aiModeFetchActiveMemoryChannelIds: async () => [],
    aiModeFetchWorkerChannelsByIds: async (_, ids) => { queried.push(...ids); return channels.filter(channel => ids.includes(channel.id)); },
    aiModeFetchWorkerChannels: async () => channels,
    aiModeFetchWorkerMessages: async (_, id) => messages.filter(message => message.res_id === id),
    aiModeBackgroundCanAttempt: id => id !== 10,
    aiModeBackgroundStartProcessing: () => {}, aiModeBackgroundFinishProcessing: () => {},
    aiModeBackgroundRegisterSuccess: () => {}, aiModeBackgroundRegisterFailure: () => { throw Error('Worker should not fail'); },
    aiModeProcessWorkerMessage: async ({ channel }) => { events.push(['ai', channel.id]); },
    aiModeNormalizeOperationalMode: value => value,
    setInterval: () => ({ synthetic: true }), setTimeout: () => 1
  };
  vm.createContext(context); vm.runInContext(['nativeMessageBackgroundEnabled', 'aiModeBackgroundTick', 'startAiModeBackgroundWorker'].map(extract).join('\n'), context);
  return { context, state, events, queried };
}
const message = (id, res_id, extra = {}) => ({ id, res_id, model: 'discuss.channel', date: new Date(Date.now() - 1000).toISOString(), body: 'Synthetic customer message', ...extra });

test('disabled AI worker performs no discovery or AI work; the independent notification worker owns discovery', async () => {
  const f = fixture({ messages: [message(10, 73)] });
  await f.context.aiModeBackgroundTick();
  assert.deepEqual(f.events, []);
  assert.equal(f.state.running, false);
  f.context.startAiModeBackgroundWorker(); assert.equal(f.state.timer, undefined);
});
test('raw native candidates survive AI processed/preboot filters even when another AI-eligible channel exists', async () => {
  const f = fixture({ ai: true, messages: [message(10, 73), message(11, 74), message(12, 76)] });
  await f.context.aiModeBackgroundTick();
  assert.ok(f.queried.includes(73)); assert.ok(f.queried.includes(74)); assert.ok(f.queried.includes(76));
  assert.deepEqual(f.events.filter(row => row[0] === 'push').map(row => row[1]).sort(), [10, 11, 12]);
  assert.deepEqual(f.events.filter(row => row[0] === 'ai'), [['ai', 74]], 'internal chats and processed customer messages must not trigger AI');
});
test('own/outbound and expired messages never become native notification candidates', async () => {
  const f = fixture({ messages: [message(10, 73, { own: true }), message(11, 74, { outbound: true }), message(12, 75, { date: new Date(Date.now() - 86400000).toISOString() })] });
  await f.context.aiModeBackgroundTick();
  assert.equal(f.events.filter(row => row[0] === 'push').length, 0);
  assert.equal(f.events.filter(row => row[0] === 'ai').length, 0);
});
test('both disabled leaves the worker stopped without an Odoo scan', async () => {
  const f = fixture({ ai: false, native: false, messages: [message(10, 73)] });
  await f.context.aiModeBackgroundTick(); f.context.startAiModeBackgroundWorker();
  assert.equal(f.state.timer, undefined); assert.deepEqual(f.events, []); assert.deepEqual(f.queried, []);
});

function webhookFollowupFixture(forwardResult) {
  const events = [], warnings = [];
  const context = {
    forwardWhatsappWebhookToOdoo: async (req, body) => {
      events.push(['forward', req, body]);
      return await forwardResult;
    },
    nativeMessageWorker: { wake() { events.push(['wake']); } },
    recordWebhookDebugEvent: async (req, body, result) => { events.push(['record', req, body, result]); },
    console: { warn: (...args) => { warnings.push(args); } }
  };
  vm.createContext(context);
  vm.runInContext(['whatsappWebhookPayloadFields', 'queueWhatsappWebhookFollowup'].map(extract).join('\n'), context);
  return { context, events, warnings };
}
const flushFollowup = () => new Promise(resolve => setImmediate(resolve));

test('deferred call-only webhook forwarding records its result without waking message discovery', async () => {
  const f = webhookFollowupFixture({ ok: true, status: 200 });
  const req = { headers: {} }, body = { entry: [{ changes: [{ field: 'calls' }] }] };
  assert.equal(f.context.queueWhatsappWebhookFollowup(req, body, { received: 1 }), undefined);
  assert.deepEqual(f.events, [], 'forwarding must remain off the synchronous webhook acknowledgement path');
  await flushFollowup();
  assert.deepEqual(f.events.map(row => row[0]), ['forward', 'record']);
  assert.equal(f.events[1][1], req);
  assert.equal(f.events[1][2], body);
  assert.deepEqual(JSON.parse(JSON.stringify(f.events[1][3])), {
    received: 1, odoo_forward: { ok: true, status: 200 }, router_mode: true
  });
  assert.deepEqual(f.warnings, []);
});

test('deferred message webhook wakes discovery only after successful Odoo forwarding', async () => {
  let completeForward;
  const forward = new Promise(resolve => { completeForward = resolve; });
  const f = webhookFollowupFixture(forward);
  f.context.queueWhatsappWebhookFollowup({}, { entry: [{ changes: [{ field: 'messages' }] }] }, { received: 0 });
  await flushFollowup();
  assert.deepEqual(f.events.map(row => row[0]), ['forward']);
  completeForward({ ok: true, status: 200 });
  await flushFollowup();
  assert.deepEqual(f.events.map(row => row[0]), ['forward', 'wake', 'record']);
  assert.deepEqual(f.warnings, []);
});

test('failed deferred message forwarding is recorded without waking discovery', async () => {
  const f = webhookFollowupFixture({ ok: false, status: 503 });
  f.context.queueWhatsappWebhookFollowup({}, { entry: [{ changes: [{ field: 'messages' }] }] }, { received: 0 });
  await flushFollowup();
  assert.deepEqual(f.events.map(row => row[0]), ['forward', 'record']);
  assert.equal(f.events[1][3].odoo_forward.status, 503);
  assert.deepEqual(f.warnings, []);
});
