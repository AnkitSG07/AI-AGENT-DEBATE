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

test('native notification scan continues with AI worker explicitly disabled and never invokes AI or its journal', async () => {
  const f = fixture({ messages: [message(10, 73)] });
  await f.context.aiModeBackgroundTick();
  assert.deepEqual(f.events, [['observe', 73], ['push', 10]]);
  assert.equal(f.state.running, false); assert.equal(f.state.last_error, '');
  f.context.startAiModeBackgroundWorker(); assert.ok(f.state.timer);
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
