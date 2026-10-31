// Actual Firestore SDK transactions against the explicitly opted-in loopback
// emulator. Odoo activity creation is a counted local fixture; no cloud access.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { createOperatorAiReplyAuth } from '../operator-ai-reply-auth.js';
import { createOdooHandoverDispatcher } from '../operator-handover.js';

if (process.env.SH_R12_EMULATOR_TESTS !== '1' || process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8089')
  throw Error('This suite requires explicit localhost8089 emulator opt-in; production use is forbidden.');
const db = new Firestore({ projectId: 'demo-sh-operator-r12' });
after(async () => db.terminate());
const NOW = 1800000000000, SECRET = 'local-emulator-r13-ai-secret-abcdefghijklmnopqrstuvwxyz';

function fixture() {
  const prefix = 'r13_' + randomUUID().replaceAll('-', '');
  const state = { mode: 'zapier', epoch: randomUUID(), revision: 1, enabled_since_ms: NOW - 10000 };
  const options = { secret: SECRET, getState: () => state, getFirestore: () => db, collectionPrefix: () => prefix, clock: () => NOW };
  const auth = createOperatorAiReplyAuth(options);
  const input = { token: auth.issue({ channelId: 22, sourceMessageId: 50, sourceTimestamp: NOW - 1000 }), channelId: 22, reply: 'Emulator fixture answer' };
  return { auth, input, prefix, options, state };
}

test('official Firestore transactions allow one AI reply attempt under twelve concurrent callbacks', async () => {
  const f = fixture();
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => f.auth.claim(f.input)));
  const winners = results.filter(row => row.status === 'fulfilled');
  assert.equal(winners.length, 1);
  assert.equal(results.filter(row => row.status === 'rejected' && row.reason.code === 'AI_REPLY_OUTCOME_PENDING').length, 11);
  const rows = await db.collection(f.prefix + '_ai_reply_receipts').get();
  assert.equal(rows.size, 1);
  assert.equal(rows.docs[0].data().state, 'processing');
  assert.equal(rows.docs[0].data().deleteAfter.toMillis(), NOW + 30 * 24 * 3600000);
  await f.auth.finish(winners[0].value, 'complete', 730);
  const recreated = createOperatorAiReplyAuth(f.options);
  assert.equal((await recreated.completed(f.input)).messageId, 730);
  assert.equal((await recreated.claim(f.input)).replay, true);
  await assert.rejects(() => recreated.claim({ ...f.input, reply: 'Different answer' }), { code: 'AI_REPLY_CONFLICT' });
});

test('official Firestore pending AI receipt survives controller loss without reopening a send slot', async () => {
  const f = fixture();
  await f.auth.claim(f.input); // Simulate controller loss after claim, before known provider acknowledgement.
  const recreated = createOperatorAiReplyAuth(f.options);
  await assert.rejects(() => recreated.claim(f.input), { code: 'AI_REPLY_OUTCOME_PENDING' });
  await assert.rejects(() => recreated.completed(f.input), { code: 'AI_REPLY_OUTCOME_PENDING' });
  assert.equal((await db.collection(f.prefix + '_ai_reply_receipts').get()).size, 1);
});

test('official Firestore receipt does not authorize an old grant after OFF→ON or a server epoch change', async () => {
  const f = fixture(), receipt = await f.auth.claim(f.input);
  await f.auth.finish(receipt, 'complete', 730);
  f.state.mode = 'manual'; f.state.revision++;
  await assert.rejects(() => f.auth.completed(f.input), { code: 'AI_MODE_CHANGED' });
  f.state.mode = 'zapier'; f.state.revision++;
  await assert.rejects(() => f.auth.claim(f.input), { code: 'AI_MODE_CHANGED' });
  f.state.revision = 1; f.state.epoch = randomUUID();
  await assert.rejects(() => createOperatorAiReplyAuth(f.options).completed(f.input), { code: 'AI_MODE_CHANGED' });
});

function handoverFixture({ failCreate = false } = {}) {
  const prefix = 'r13_' + randomUUID().replaceAll('-', '');
  let creates = 0;
  const execute = async (model, method, args) => {
    if (model === 'res.users') return [{ id: 17, active: true, share: false }];
    if (model === 'discuss.channel' && method === 'fields_get') return { channel_type: {}, active: {}, whatsapp_partner_id: {} };
    if (model === 'discuss.channel') return [{ id: 22, active: true, channel_type: 'whatsapp', whatsapp_partner_id: [51, 'Fixture'] }];
    if (model === 'res.partner') return [{ id: 51, active: true }];
    if (model === 'ir.model') return [{ id: 93, model: 'res.partner' }];
    if (model === 'ir.model.data') return [{ res_id: 4 }];
    if (model === 'mail.activity' && method === 'create') {
      creates++;
      assert.equal(args[0].user_id, 17); assert.equal(args[0].res_id, 51);
      if (failCreate) throw new Error('Synthetic Odoo acknowledgement loss');
      return 740;
    }
    throw new Error('Unexpected fixture Odoo operation');
  };
  const options = { userIdsJson: '{"kushagra":17}', getFirestore: () => db, collectionPrefix: () => prefix, execute, clock: () => NOW };
  const input = { handoverId: 73, sourceMessageId: 50, channelId: 22, assignedTo: 'Khushagra', summary: 'Fixture', note: 'Emulator only' };
  return { options, input, prefix, creates: () => creates, dispatcher: createOdooHandoverDispatcher(options) };
}

test('official Firestore handover transactions create one assigned activity and preserve replay outcome', async () => {
  const f = handoverFixture();
  const results = await Promise.all(Array.from({ length: 8 }, () => f.dispatcher.dispatch(f.input)));
  assert.equal(results.filter(row => row.status === 'created').length, 1);
  assert.equal(f.creates(), 1);
  const recreated = createOdooHandoverDispatcher(f.options);
  const replay = await recreated.dispatch({ ...f.input, handoverId: 74 });
  assert.equal(replay.status, 'already_created'); assert.equal(replay.activity_id, 740);
  assert.equal(replay.human_notified, false); assert.equal(f.creates(), 1);
  const rows = await db.collection(f.prefix + '_ai_handover_receipts').get();
  assert.equal(rows.size, 1); assert.equal(rows.docs[0].data().status, 'complete');
  assert.equal(rows.docs[0].data().deleteAfter.toMillis(), NOW + 30 * 24 * 3600000);
});

test('official Firestore preserves ambiguous Odoo handover outcome instead of creating a duplicate activity', async () => {
  const f = handoverFixture({ failCreate: true });
  assert.equal((await f.dispatcher.dispatch(f.input)).status, 'activity_outcome_pending');
  const replay = await createOdooHandoverDispatcher(f.options).dispatch(f.input);
  assert.equal(replay.status, 'activity_outcome_pending'); assert.equal(f.creates(), 1);
  const rows = await db.collection(f.prefix + '_ai_handover_receipts').get();
  assert.equal(rows.docs[0].data().status, 'processing');
});
