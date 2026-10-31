import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createOperatorAiReplyAuth } from '../operator-ai-reply-auth.js';
import { createOdooHandoverDispatcher, parseHandoverUserIds } from '../operator-handover.js';
import { FirestoreFake, deferred } from './operator-r12-helpers.mjs';
import { documentContentDisposition } from '../operator-document-links.js';

const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
const START = 1800000000000, SECRET = 'offline-only-r13-ai-secret-abcdefghijklmnopqrstuvwxyz';
function sourceFunction(name) {
  const start = source.indexOf(`function ${name}(`); assert.ok(start > 0, name);
  const from = source.slice(start - 6, start) === 'async ' ? start - 6 : start;
  // Destructured parameter lists also contain a column-zero `}`. Only a
  // standalone closing brace ends these top-level server function declarations.
  const end = /^\}$/m.exec(source.slice(start)); assert.ok(end, name);
  return source.slice(from, start + end.index + 1);
}
function constant(name) {
  const start = source.indexOf(`const ${name} =`); assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n};', start) + 3);
}
function load(names, context = {}, constants = []) {
  vm.createContext(context);
  vm.runInContext([...constants.map(constant), ...names.map(sourceFunction)].join('\n'), context);
  return context;
}
function replyFixture({ db = new FirestoreFake() } = {}) {
  let now = START;
  const state = { mode: 'zapier', epoch: 'offline-epoch-1', revision: 1, enabled_since_ms: START - 10000 };
  const options = { secret: SECRET, getState: () => state, getFirestore: () => db, clock: () => now };
  const auth = createOperatorAiReplyAuth(options);
  const issue = extra => auth.issue({ channelId: 22, sourceMessageId: 50, sourceTimestamp: START - 1000, ...extra });
  return { auth, db, options, state, issue, now: value => { now = value; } };
}

test('AI reply grant binds exact source message, channel, epoch and enable timestamp', () => {
  const f = replyFixture(), token = f.issue();
  const claims = f.auth.verify(token, 22);
  assert.equal(claims.sourceMessageId, 50); assert.equal(claims.channelId, 22); assert.equal(claims.revision, 1);
  assert.throws(() => f.auth.verify(token, 23), error => error.code === 'INVALID_AI_REPLY_GRANT');
  for (const sourceTimestamp of [START - 10001, START - 10000, 0, START + 30001])
    assert.throws(() => f.issue({ sourceTimestamp }));
  assert.throws(() => f.auth.verify('shb1.not.an-operator-reply-grant', 22));
  assert.throws(() => f.auth.verify(token.slice(0, -4) + 'xxxx', 22));
});

test('AI reply grant expires and OFF→ON or restart cannot authorize an old decision', () => {
  const f = replyFixture(), token = f.issue();
  f.state.mode = 'manual'; assert.throws(() => f.auth.verify(token, 22), error => error.code === 'AI_MODE_CHANGED');
  f.state.mode = 'zapier'; f.state.revision++; assert.throws(() => f.auth.verify(token, 22), error => error.code === 'AI_MODE_CHANGED');
  f.state.revision--; f.state.epoch = 'new-server-epoch'; assert.throws(() => f.auth.verify(token, 22), error => error.code === 'AI_MODE_CHANGED');
  f.state.epoch = 'offline-epoch-1'; f.now(START + 600000);
  assert.throws(() => f.auth.verify(token, 22), error => error.code === 'AI_REPLY_GRANT_EXPIRED');
});

test('AI grants fail closed without strong signing authority or persistent storage', () => {
  const f = replyFixture();
  for (const options of [{ ...f.options, secret: 'short' }, { ...f.options, getFirestore: () => null }]) {
    const auth = createOperatorAiReplyAuth(options); assert.equal(auth.configured(), false);
    assert.throws(() => auth.issue({ channelId: 22, sourceMessageId: 50, sourceTimestamp: START - 1000 }), error => error.status === 503);
  }
});

test('concurrent AI callbacks arbitrate one durable send attempt', async () => {
  const f = replyFixture(), token = f.issue();
  const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => f.auth.claim({ token, channelId: 22, reply: 'Fixture answer' })));
  assert.equal(attempts.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(x => x.status === 'rejected' && x.reason.code === 'AI_REPLY_OUTCOME_PENDING').length, 11);
  assert.equal(f.db.documents.size, 1);
});

test('completed AI receipt survives new controller and acknowledges retries without a second attempt', async () => {
  const f = replyFixture(), token = f.issue(), input = { token, channelId: 22, reply: 'Fixture answer' };
  const receipt = await f.auth.claim(input); await f.auth.finish(receipt, 'complete', 830);
  const recreated = createOperatorAiReplyAuth(f.options);
  assert.equal((await recreated.completed(input)).messageId, 830);
  assert.equal((await recreated.claim(input)).replay, true);
  await assert.rejects(() => recreated.claim({ ...input, reply: 'Different answer' }), { code: 'AI_REPLY_CONFLICT' });
  assert.equal(f.db.documents.size, 1);
});

test('unknown and blocked AI outcomes never reopen a send slot', async () => {
  for (const state of ['uncertain','blocked']) {
    const f = replyFixture(), input = { token: f.issue(), channelId: 22, reply: 'Fixture answer' };
    const receipt = await f.auth.claim(input); await f.auth.finish(receipt, state);
    await assert.rejects(() => f.auth.claim(input), { code: state === 'blocked' ? 'AI_REPLY_BLOCKED' : 'AI_REPLY_OUTCOME_PENDING' });
  }
});

test('lost receipt ACK cannot result in a second AI attempt', async () => {
  const f = replyFixture(), input = { token: f.issue(), channelId: 22, reply: 'Fixture answer' };
  f.db.failAfterCommit = new Error('Synthetic commit acknowledgement loss');
  await assert.rejects(() => f.auth.claim(input), { code: 'AI_REPLY_STORAGE_UNAVAILABLE' });
  f.db.failAfterCommit = null;
  await assert.rejects(() => f.auth.claim(input), { code: 'AI_REPLY_OUTCOME_PENDING' });
  assert.equal(f.db.documents.size, 1);
});

test('AI mode change during transaction prevents claim commit', async () => {
  const f = replyFixture(), token = f.issue(), original = f.db.runTransaction.bind(f.db);
  f.db.runTransaction = fn => original(async tx => fn({ ...tx, get: async ref => {
    const row = await tx.get(ref); f.state.revision++; return row;
  }}));
  await assert.rejects(() => f.auth.claim({ token, channelId: 22, reply: 'Fixture' }), { code: 'AI_MODE_CHANGED' });
  assert.equal(f.db.documents.size, 0);
});

test('actual channel window policy fails closed for missing expiry, inactive and unknown channels', () => {
  const ctx = load(['aiModeParseOdooDateMs','aiModeCanPostToChannel'], { Date: class extends Date { static now() { return START; } } });
  for (const channel of [{}, { channel_type: 'unexpected' }, { channel_type: 'whatsapp', whatsapp_channel_active: true },
    { channel_type: 'whatsapp', whatsapp_channel_valid_until: new Date(START).toISOString() }, { channel_type: 'livechat', active: false }])
    assert.equal(ctx.aiModeCanPostToChannel(channel), false);
  assert.equal(ctx.aiModeCanPostToChannel({ channel_type: 'whatsapp', whatsapp_channel_valid_until: new Date(START + 1000).toISOString() }), true);
  assert.equal(ctx.aiModeCanPostToChannel({ channel_type: 'livechat' }), true);
});

function sendFixture({ current, stillCurrent = () => true, messageId = 830 } = {}) {
  const posts = [], locks = [];
  const ctx = load(['aiModePostTextToOdooChannel'], { aiModeSafeString: value => String(value || ''),
    aiModeLooksLikeUnsafeCustomerReply: () => false, aiModeLooksLikeCustomerEcho: () => false,
    readOdooChannelForDocumentShare: async () => typeof current === 'function' ? current() : current,
    aiModeCanPostToChannel: channel => channel.open === true,
    aiModeShouldBlockDuplicateOutbound: (id, body) => { locks.push({ id, body }); return false; },
    odooExecute: async (...args) => { posts.push(args); return messageId; } });
  return { posts, locks, send: () => ctx.aiModePostTextToOdooChannel(7, { id: 22, channel_type: 'whatsapp', open: true }, 'Fixture answer', stillCurrent) };
}
test('actual send rechecks fresh exact channel, does not consume dedupe slot on closed window', async () => {
  const f = sendFixture({ current: { id: 22, channel_type: 'whatsapp', open: false } });
  assert.equal((await f.send()).reason, 'whatsapp_reply_window_closed'); assert.equal(f.posts.length, 0); assert.equal(f.locks.length, 0);
});
test('actual send checks exact mode lease after asynchronous channel read', async () => {
  const started = deferred(), gate = deferred(); let current = true;
  const f = sendFixture({ current: async () => { started.resolve(); await gate.promise; return { id: 22, channel_type: 'whatsapp', open: true }; },
    stillCurrent: () => current });
  const sending = f.send(); await started.promise; current = false; gate.resolve();
  assert.equal((await sending).reason, 'ai_mode_changed_before_send'); assert.equal(f.posts.length, 0);
});
test('actual send preserves WhatsApp and Live Chat message types and records provider message ID', async () => {
  for (const [channel_type, message_type] of [['whatsapp','whatsapp_message'],['livechat','comment']]) {
    const f = sendFixture({ current: { id: 22, channel_type, open: true } });
    assert.equal((await f.send()).messageId, 830); assert.equal(f.posts[0][4].message_type, message_type);
  }
});
test('actual send refuses a fresh channel response for a different conversation', async () => {
  const f = sendFixture({ current: { id: 23, channel_type: 'whatsapp', open: true } });
  await assert.rejects(() => f.send(), /confirm.*channel/i);
  assert.equal(f.posts.length, 0); assert.equal(f.locks.length, 0);
});
test('actual send never reports success for an unconfirmed Odoo message ID', async () => {
  for (const messageId of [null, false, {}, [], '830', 0, -1, 1.5]) {
    const f = sendFixture({ current: { id: 22, channel_type: 'whatsapp', open: true }, messageId });
    await assert.rejects(() => f.send(), /message.*confirm|confirm.*message/i);
    assert.equal(f.posts.length, 1, 'An ambiguous acknowledgement must not trigger an automatic resend.');
  }
});

function workerFixture() {
  const remembered = [], pushed = [], forwarded = [];
  const state = { mode: 'zapier', epoch: 'epoch-1', revision: 1, enabled_since_ms: START - 20000 };
  const ctx = load(['aiModeCaptureLease','aiModeLeaseCurrent','aiModeHasWorkerAttachments','aiModeProcessWorkerMessage'], {
    Date: class extends Date { static now() { return START; } }, console: { log() {} }, aiModeGlobalState: state,
    aiModeMessagePlainText: message => message.body || '', aiModeParseOdooDateMs: Date.parse,
    AI_MODE_BACKGROUND_CUSTOMER_SETTLE_MS: 1000, aiModeBackgroundState: { processed_count: 0 },
    aiModeBackgroundRememberProcessedId: async id => remembered.push(id),
    sendOperatorPushNotification: async value => { pushed.push(value); return { ok: true }; },
    sendIncomingWhatsAppToZapier: async value => { forwarded.push(value); return { ok: true }; }
  });
  const run = date => ctx.aiModeProcessWorkerMessage({ uid: 7, userContext: {}, channel: { id: 22, channel_type: 'whatsapp' },
    messages: [], latestCustomerMessage: { id: 51, date, body: 'Fixture inbound' } });
  return { ctx, state, remembered, pushed, forwarded, run };
}
test('actual worker rejects older, equal and missing timestamp instead of replying to old inbox history', async () => {
  for (const date of [new Date(START - 20001).toISOString(), new Date(START - 20000).toISOString(), '']) {
    const f = workerFixture(); assert.equal((await f.run(date)).skipped, 'older_than_mode_enable_time');
    assert.equal(f.pushed.length, 0); assert.equal(f.forwarded.length, 0); assert.deepEqual(f.remembered, [51]);
  }
});
test('actual worker does not forward after another device changes mode during notification await', async () => {
  const f = workerFixture(), gate = deferred(), started = deferred();
  f.ctx.sendOperatorPushNotification = async () => { started.resolve(); await gate.promise; return { ok: true }; };
  const running = f.run(new Date(START - 5000).toISOString()); await started.promise;
  f.state.mode = 'manual'; f.state.revision++; f.state.mode = 'zapier'; f.state.revision++; gate.resolve();
  assert.equal((await running).skipped, 'ai_mode_changed_during_processing'); assert.equal(f.forwarded.length, 0);
});
test('actual internal AI dispatcher directly executes handler and never bypasses HTTP authorization', async () => {
  let called = 0;
  const ctx = load(['aiModeCallLocalDecisionEngine'], { handleAiModeChat: async (req,res) => {
    called++; assert.equal(req.operatorAuth.kind, 'internal-worker'); res.json({ ok: true, source: req.body.source });
  }, fetch: () => { throw new Error('Internal work must not use unprotected loopback HTTP'); } });
  assert.equal((await ctx.aiModeCallLocalDecisionEngine({ source: 'fixture' })).source, 'fixture'); assert.equal(called, 1);
  ctx.handleAiModeChat = async (_req,res) => res.status(503).json({ ok: false, error: 'Fixture failure' });
  await assert.rejects(() => ctx.aiModeCallLocalDecisionEngine({}), /Fixture failure/);
});

test('persistent context is valid bounded JSON and preserves human-handover hold on oversized context', () => {
  const ctx = load(['aiModeOdooContextJson','aiModeParseContextJson']);
  const large = { large: 'x'.repeat(100000), handover_wait: { hold_until: '2026-10-30T12:00:00Z', assigned_to: 'Khushagra' },
    rest: Array.from({ length: 200 }, () => 'x'.repeat(4000)) };
  const serialized = ctx.aiModeOdooContextJson(large), parsed = JSON.parse(serialized);
  assert.ok(serialized.length <= 50000); assert.equal(parsed.handover_wait.assigned_to, 'Khushagra'); assert.equal(parsed._truncated, true);
  const clean = ctx.aiModeParseContextJson('{"__proto__":{"polluted":true},"constructor":{"prototype":{}} ,"customer":"Fixture"}');
  assert.equal(Object.hasOwn(clean, '__proto__'), false); assert.equal(Object.hasOwn(clean, 'constructor'), false); assert.equal(clean.customer, 'Fixture');
});

function memoryFixture() {
  const calls = []; let memory = null;
  const ctx = load(['aiModeSafeString','aiModeOdooDatetime','aiModeOdooSelectionAssignedTo','aiModeOdooMemoryStatus','aiModeOdooJson',
    'aiModeOdooContextJson','aiModeParseContextJson','aiModeOdooFindMemoryRecord','aiModeOdooLoadMemoryContext','aiModeOdooUpsertMemory','aiModeOdooCreateHandoverLog'], {
    AI_MODE_MEMORY_MODEL: 'x_ai_operator_memory', AI_MODE_HANDOVER_MODEL: 'x_ai_handover_log', aiModeOdooEnabled: () => true,
    odooLoginCached: async () => 7, console: { warn() {} },
    operatorHandoverDispatcher: { dispatch: async () => ({ ok: false, activity_created: false, human_notified: false, status: 'unmapped_assignee' }) },
    odooExecute: async (_uid, model, method, args, kwargs) => {
      calls.push({ model, method, args, kwargs });
      if (method === 'search_read') return memory ? [memory] : [];
      if (method === 'create') return 73;
      return true;
    }
  }, ['AI_MODE_MEMORY_FIELDS','AI_MODE_HANDOVER_FIELDS']);
  return { ctx, calls, setMemory: row => { memory = row; } };
}
test('actual memory create and update use exact x_ai_operator_memory/x_studio_context_json contract', async () => {
  const f = memoryFixture(), input = { chatId: '22', customerName: 'Fixture', customerPhone: '+919000000001', channel: 'whatsapp',
    message: 'Fixture', odooChannelId: 22, aiResult: { level: 3, handover_required: true, assigned_to: 'Khushagra', active_context: { requirement: 'Fixture item' } } };
  const created = await f.ctx.aiModeOdooUpsertMemory(input); assert.equal(created.action, 'created');
  const write = f.calls.find(x => x.method === 'create'); assert.equal(write.model, 'x_ai_operator_memory');
  assert.equal(JSON.parse(write.args[0].x_studio_context_json).requirement, 'Fixture item');
  f.setMemory({ id: 73, x_studio_context_json: '{"requirement":"Previously saved"}', x_studio_x_status: 'handed_over' });
  const loaded = await f.ctx.aiModeOdooLoadMemoryContext('22'); assert.equal(loaded.found, true); assert.equal(loaded.contextJson.requirement, 'Previously saved');
  const updated = await f.ctx.aiModeOdooUpsertMemory(input); assert.equal(updated.action, 'updated');
  assert.equal(f.calls.filter(x => x.method === 'write')[0].args[0][0], 73);
});
test('actual handover record is not misrepresented as human notification when no delivery mapping exists', async () => {
  const f = memoryFixture();
  const r = await f.ctx.aiModeOdooCreateHandoverLog({ chatId: '22', customerName: 'Fixture', odooChannelId: 22,
    aiResult: { level: 3, handover_required: true, assigned_to: 'Vibhu', internal_notification: 'Fixture needs review' } });
  assert.equal(r.ok, true); assert.equal(r.id, 73); assert.equal(r.needs_notification, true); assert.equal(r.delivery.human_notified, false);
  assert.equal(f.calls[0].model, 'x_ai_handover_log'); assert.equal(f.calls[0].args[0].x_studio_x_assigned_to, 'Vibhu');
});

function handoverFixture({ mapping = '{"kushagra":17,"vibhu":18}', userActive = true, share = false, partner = 51, db = new FirestoreFake(), lostCreate = false } = {}) {
  const calls = [];
  const execute = async (model, method, args, kwargs) => {
    calls.push({ model, method, args, kwargs });
    if (model === 'res.users') return [{ id: args[0][0], active: userActive, share }];
    if (model === 'discuss.channel' && method === 'fields_get') return { channel_type: {}, active: {}, whatsapp_partner_id: {} };
    if (model === 'discuss.channel') return [{ id: 22, channel_type: 'whatsapp', active: true, whatsapp_partner_id: partner ? [partner, 'Fixture'] : false }];
    if (model === 'res.partner') return [{ id: partner, active: true }];
    if (model === 'ir.model') return [{ id: 93, model: 'res.partner' }];
    if (model === 'ir.model.data') return [{ res_id: 4 }];
    if (model === 'mail.activity') { if (lostCreate) throw new Error('Synthetic create accepted but reply lost'); return 96; }
    throw new Error('Unexpected fixture operation');
  };
  const options = { userIdsJson: mapping, getFirestore: () => db, execute, clock: () => START };
  return { dispatcher: createOdooHandoverDispatcher(options), calls, db, options,
    input: { handoverId: 73, sourceMessageId: 50, channelId: 22, assignedTo: 'Khushagra', summary: 'Fixture handover', note: '<script>bad()</script>\nNeeds review' } };
}
test('handover configuration rejects unknown names and unsafe IDs; no guessed recipient or contact creation', async () => {
  for (const raw of ['[]','{"unknown":7}','{"vibhu":-1}','{"vibhu":"17"}','{"kushagra":17,"khushagra":18}']) assert.equal(parseHandoverUserIds(raw), null);
  const f = handoverFixture({ mapping: '{}' }); const r = await f.dispatcher.dispatch(f.input);
  assert.equal(r.status, 'unmapped_assignee'); assert.equal(f.calls.length, 0); assert.equal(f.db.documents.size, 0);
});
test('handover requires authoritative active internal assignee and existing linked customer', async () => {
  for (const options of [{ userActive: false }, { share: true }, { partner: 0 }]) {
    const f = handoverFixture(options), r = await f.dispatcher.dispatch(f.input);
    assert.equal(r.activity_created, false); assert.equal(f.calls.filter(x => x.model === 'mail.activity').length, 0);
  }
});
test('handover creates assigned Odoo activity with escaped internal note and exact customer link', async () => {
  const f = handoverFixture(), r = await f.dispatcher.dispatch(f.input);
  assert.equal(r.status, 'created'); assert.equal(r.activity_id, 96); assert.equal(r.human_notified, false);
  const activity = f.calls.find(x => x.model === 'mail.activity').args[0];
  assert.equal(activity.res_id, 51); assert.equal(activity.user_id, 17); assert.equal(activity.res_model_id, 93);
  assert.match(activity.note, /&lt;script&gt;/); assert.ok(!activity.note.includes('<script>'));
});
test('handover activity is durable and deduplicates same source across controller restart and log recreation', async () => {
  const f = handoverFixture(); await f.dispatcher.dispatch(f.input);
  const restarted = createOdooHandoverDispatcher(f.options);
  const repeated = await restarted.dispatch({ ...f.input, handoverId: 74 });
  assert.equal(repeated.status, 'already_created'); assert.equal(f.calls.filter(x => x.model === 'mail.activity').length, 1);
});
test('lost Odoo activity acknowledgement leaves durable pending receipt instead of duplicate activity', async () => {
  const f = handoverFixture({ lostCreate: true });
  assert.equal((await f.dispatcher.dispatch(f.input)).status, 'activity_outcome_pending');
  assert.equal((await f.dispatcher.dispatch(f.input)).status, 'activity_outcome_pending');
  assert.equal(f.calls.filter(x => x.model === 'mail.activity').length, 1);
});
test('concurrent handover callbacks produce one assigned activity', async () => {
  const f = handoverFixture();
  const results = await Promise.all(Array.from({ length: 8 }, () => f.dispatcher.dispatch(f.input)));
  assert.equal(results.filter(x => x.status === 'created').length, 1);
  assert.equal(f.calls.filter(x => x.model === 'mail.activity').length, 1);
});
test('document disposition supports Unicode names without invalid HTTP headers or CRLF injection', () => {
  const value = documentContentDisposition('प्रमाणपत्र "fixture"\r\n.pdf', 'attachment');
  assert.ok(!/[\r\n]/.test(value)); assert.match(value, /filename\*=UTF-8''/);
  assert.match(value, /%E0/); assert.equal(Buffer.byteLength(value, 'ascii'), value.length);
});
