import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { createAiVoiceFallback } from '../call-runtime/ai-voice-fallback.mjs';
import { createOperatorMediaGateway, nativeCallHistoryEvent } from '../operator-media-gateway.js';
import { deferred, fixture } from './operator-r12-helpers.mjs';

const callId = 'call-in-1';
const callerPhone = '919999999999';
const env = { SH_AI_VOICE_ENABLED: 'true', SH_AI_VOICE_PILOT_CALLERS: callerPhone, OPENAI_API_KEY: 'test-key' };
const claim = { operationId: 'voice-claim-1', identity: 'sh-voice-' + 'a'.repeat(32),
  maxCallMs: 180000, mayClaim: () => true, canDispatch: () => true };
const terminate = runtime => runtime.ingestVerifiedMetaEvent({ verified: true,
  eventId: 'terminate-' + callId, type: 'terminate', callId, phoneNumberId: 'business-1' });

test('disabled or unscoped fallback starts no voice work', () => {
  assert.equal(createAiVoiceFallback({ env: { ...env, SH_AI_VOICE_ENABLED: 'false' } }), null);
  assert.equal(createAiVoiceFallback({ env: { ...env, SH_AI_VOICE_PILOT_CALLERS: '' } }), null);
  assert.equal(createAiVoiceFallback({ env: { ...env, OPENAI_API_KEY: '' } }), null);
});

test('the gateway arms only the first verified incoming offer using its original caller and timestamp', async () => {
  const f = fixture(), scheduled = [], stopped = [];
  const gateway = createOperatorMediaGateway({
    env: { WHATSAPP_PHONE_NUMBER_ID: 'business-1', META_WHATSAPP_APP_SECRET: 'test', SH_NATIVE_CALLS_ENABLED: 'true' },
    firestoreRuntime: { firestore: {}, collectionPrefix: 'sh_test', deviceRegistry: {} },
    storeFactory: () => f.store,
    runtimeFactory: () => ({ runtime: f.runtime, controller: f.controller }),
    voiceFallback: { schedule: value => scheduled.push(value), stop: id => stopped.push(id) },
    now: f.now, logger: {}
  });
  const timestamp = f.now() / 1000;
  const offer = { id: 'offer-1', call_id: callId, event: 'connect', direction: 'incoming', phone_number_id: 'business-1',
    customer_phone: callerPhone, business_display_phone_number: '919888888888', timestamp,
    raw: { call: { from: callerPhone, timestamp } },
    session: { sdp_type: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' } };
  await gateway.ingestVerifiedEvents([
    { ...offer, id: 'missing-from', call_id: 'missing-from', raw: { call: { timestamp } } },
    { ...offer, id: 'business-from', call_id: 'business-from', raw: { call: { from: '919888888888', timestamp } } },
    offer, offer, { ...offer, id: 'same-call-new-event' }
  ]);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].callerPhone, callerPhone);
  assert.equal(scheduled[0].occurredAtMs, f.now());
  await gateway.ingestVerifiedEvents([{ ...offer, id: 'terminal-1', event: 'terminate' }]);
  assert.deepEqual(stopped, [callId]);
});

function pilot(f, options = {}) {
  const timers = new Set(), events = [];
  const fallback = createAiVoiceFallback({ env, now: f.now, loadInstructions: async () => 'Approved knowledge',
    tools: [], callTool: async () => ({}), saveEnquiry: async () => ({ status: 'captured' }),
    setTimer(fn, ms) { const timer = { fn, ms }; timers.add(timer); return timer; },
    clearTimer(timer) { timers.delete(timer); },
    logger: { info() {} },
    startMedia: async media => {
      events.push('prepared');
      return { async speak() { events.push('greeting'); media.onMediaReady(); }, async close() { events.push('closed'); } };
    },
    ...options
  });
  const schedule = (overrides = {}) => fallback.schedule({ id: callId, callId, callerPhone, occurredAtMs: f.now(),
    runtime: f.runtime, ...overrides });
  async function fire(timer) {
    timers.delete(timer);
    f.advance(timer.ms);
    timer.fn();
    await turn();
  }
  return { fallback, timers, events, schedule, fire };
}

test('pilot waits for operators, rechecks freshness and skips other callers', async () => {
  const f = fixture(); await f.incoming();
  const p = pilot(f);
  p.schedule({ callerPhone: '919999999998' });
  p.schedule({ occurredAtMs: f.now() - 20000 });
  assert.equal(p.timers.size, 0);
  p.schedule(); p.schedule();
  assert.equal(p.timers.size, 1);
  assert.equal([...p.timers][0].ms, 12000);
  await f.runtime.dispatchIncomingAlert(callId);
  assert.deepEqual(f.effects.filter(effect => effect.kind === 'notify').map(effect => effect.event), ['incoming']);
  await p.fire([...p.timers][0]);
  assert.deepEqual(p.events, ['prepared', 'greeting']);
  const session = await f.runtime.locate(callId);
  assert.equal(session.phase, 'ai_connected');
  assert.equal(nativeCallHistoryEvent({ session, view: await f.runtime.view(session) }).status, 'connected');
  await f.runtime.dispatchRingCancellation(callId);
  assert.deepEqual(f.effects.filter(effect => effect.kind === 'notify').map(effect => effect.event), ['incoming', 'ended']);
  await p.fire([...p.timers][0]);
  assert.equal((await f.runtime.locate(callId)).terminal.reason, 'AI_VOICE_TIME_LIMIT');
  await f.runtime.dispatchCriticalCleanup(callId);
  assert.deepEqual(f.effects.filter(effect => ['reject', 'terminate'].includes(effect.kind)).map(effect => effect.kind), ['terminate']);
});

test('explicit general rollout still requires a valid caller identity', async () => {
  const f = fixture(); await f.incoming();
  const p = pilot(f, { env: { ...env, SH_AI_VOICE_PILOT_CALLERS: '', SH_AI_VOICE_ALL_CALLERS: 'true' } });
  p.schedule({ callerPhone: 'unknown' });
  assert.equal(p.timers.size, 0);
  p.schedule();
  assert.equal(p.timers.size, 1);
  await p.fallback.close();
});

test('a human can answer during the AI media setup', async () => {
  const f = fixture(); await f.incoming();
  const media = deferred(), started = deferred();
  const p = pilot(f, { startMedia: async () => { started.resolve(); return media.promise; } });
  p.schedule();
  const fired = p.fire([...p.timers][0]);
  await started.promise;
  await f.accept();
  media.resolve({ speak: () => assert.fail('must not greet'), close: () => p.events.push('closed') });
  await fired; await turn();
  assert.equal((await f.runtime.locate(callId)).owner.deviceId, 'a');
  assert.equal(f.effects.filter(effect => effect.kind === 'accept').length, 1);
  assert.deepEqual(p.events, ['closed']);
});

test('the preliminary browser answer lock keeps an otherwise eligible call ringing', async () => {
  const f = fixture(); await f.incoming();
  const p = pilot(f, { humanAnswerInProgress: () => true });
  p.schedule(); await p.fire([...p.timers][0]);
  assert.equal((await f.runtime.locate(callId)).phase, 'ringing');
  assert.deepEqual(p.events, []);
});

test('failed preparation leaves the call available for a normal answer', async () => {
  const f = fixture(); await f.incoming();
  const p = pilot(f, { startMedia: async () => { throw Error('test failure'); } });
  p.schedule(); await p.fire([...p.timers][0]);
  assert.equal((await f.runtime.locate(callId)).phase, 'ringing');
  assert.equal(p.timers.size, 0);
  await f.accept();
  assert.equal(f.effects.filter(effect => effect.kind === 'accept').length, 1);
});

test('only one durable claim wins, and neither human path can override it', async () => {
  const f = fixture(); await f.incoming();
  const [first, second] = await Promise.all([
    f.runtime.acceptAiIncoming(callId, claim),
    f.runtime.acceptAiIncoming(callId, { ...claim, operationId: 'voice-claim-2' })
  ]);
  assert.equal(first.routeChoice, 'ai'); assert.equal(second, null);
  await assert.rejects(f.accept(), { code: 'CALL_ANSWERED_ELSEWHERE' });
  await assert.rejects(f.runtime.claimLegacyIncoming(callId, 'legacy-claim'), { code: 'CALL_OWNED_BY_NATIVE' });
  await assert.rejects(f.runtime.end('a', callId, { requestId: 'human-end-1', version: first.version }), { code: 'NOT_CALL_OWNER' });
  assert.equal(f.effects.filter(effect => effect.kind === 'accept').length, 1);
});

test('customer hangup during Accept fences late success and queues exact cleanup', async () => {
  const entered = deferred(), release = deferred();
  const f = fixture({ provider: { async acceptIncoming(data) {
    entered.resolve(); await release.promise;
    const session = await f.runtime.locate(callId);
    return { callId: data.callId, roomName: data.roomName, customerIdentity: session.customerIdentity };
  } } });
  await f.incoming();
  const pending = f.runtime.acceptAiIncoming(callId, claim);
  await entered.promise; await terminate(f.runtime); release.resolve();
  assert.equal(await pending, null);
  const state = await f.runtime.locate(callId);
  assert.equal(state.terminal.reason, 'USER_INITIATED');
  assert.ok(state.outbox.some(row => row.id === 'terminate:late-accept'));
  assert.equal(state.outbox.some(row => row.kind === 'reject'), false);
});

test('uncertain provider response is never replayed and cleanup is durable', async () => {
  let attempted = 0;
  const f = fixture({ provider: { async acceptIncoming() { attempted++; throw Error('connection lost'); } } });
  await f.incoming();
  await assert.rejects(f.runtime.acceptAiIncoming(callId, claim));
  const state = await f.runtime.locate(callId);
  assert.equal(state.terminal.reason, 'AI_VOICE_FAILED');
  assert.ok(state.outbox.some(row => row.kind === 'terminate'));
  assert.equal(await f.runtime.acceptAiIncoming(callId, { ...claim, operationId: 'voice-claim-2' }), null);
  assert.equal(attempted, 1);
});

test('a single durable Odoo enquiry receipt survives customer hangup', async () => {
  const f = fixture(); await f.incoming(); await f.runtime.acceptAiIncoming(callId, claim);
  const enquiryHash = 'a'.repeat(64);
  assert.equal(await f.runtime.claimAiEnquiry(callId, claim.operationId, enquiryHash), null);
  await f.runtime.markAiIncomingReady(callId, claim.operationId);
  const receipts = await Promise.all([1, 2].map(() => f.runtime.claimAiEnquiry(callId, claim.operationId, enquiryHash)));
  assert.deepEqual(receipts.map(row => row.claimed).sort(), [false, true]);
  await terminate(f.runtime);
  assert.equal(await f.runtime.settleAiEnquiry(callId, claim.operationId, { status: 'created', leadId: 42 }), true);
  assert.equal((await f.runtime.locate(callId)).aiVoice.enquiry.leadId, 42);
  assert.equal(await f.runtime.settleAiEnquiry(callId, claim.operationId, { status: 'created', leadId: 43 }), false);
});
