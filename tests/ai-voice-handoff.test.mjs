import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiVoiceHandoff } from '../call-runtime/ai-voice-handoff.mjs';

const session = {
  id: 'call-1', providerCallId: 'call-1', direction: 'incoming', channelId: 0,
  customerPhone: '12025550199', verifiedCustomerPhone: '+1 (202) 555-0101'
};
const enquiry = { topic: 'kit', application: '<bench> & shelf', quantity: 4, nextStep: 'sales_review' };

function fixture(execute = async () => 23, settleClaim = true) {
  const operations = [];
  let receipt;
  const handoff = createAiVoiceHandoff({
    execute: async (...args) => { operations.push(args); return execute(...args); },
    claim: async ({ operationId, enquiryHash }) => {
      assert.match(enquiryHash, /^[a-f0-9]{64}$/);
      if (receipt) return receipt.enquiryHash === enquiryHash ? receipt.status : 'conflict';
      receipt = { operationId, enquiryHash, status: 'processing' };
      return 'claimed';
    },
    settle: async ({ operationId, enquiryHash, status, leadId }) => {
      assert.equal(operationId, receipt.operationId);
      assert.equal(enquiryHash, receipt.enquiryHash);
      assert.equal(receipt.status, 'processing');
      if (!settleClaim) return false;
      receipt = { ...receipt, status, leadId };
      return true;
    }
  });
  return { handoff, operations, receipt: () => receipt };
}

test('a first-time caller’s enquiry creates an internal CRM lead with a verified callback number', async () => {
  const { handoff, operations, receipt } = fixture();
  assert.equal(await handoff({ session, operationId: 'tool-1', enquiry: { ...enquiry, email: 'caller@example.com' } }), true);
  assert.deepEqual(operations, [['crm.lead', 'create', [{
    name: 'WhatsApp voice enquiry · Kit', type: 'lead', partner_id: false, user_id: false, phone: '+12025550101',
    description: '<p>Call reference: call-1</p><p>Topic: Kit</p><p>Next step: Sales review</p>' +
      '<p>Application: &lt;bench&gt; &amp; shelf</p><p>Quantity: 4</p>'
  }], { context: { tracking_disable: true } }]]);
  const { operationId, status, leadId } = receipt();
  assert.deepEqual({ operationId, status, leadId }, { operationId: 'tool-1', status: 'complete', leadId: 23 });
});

test('the call can create only one lead across simultaneous and replayed tool calls', async () => {
  let finish;
  const response = new Promise(resolve => { finish = resolve; });
  const { handoff, operations } = fixture(() => response);
  const first = handoff({ session, operationId: 'tool-1', enquiry });
  assert.equal(await handoff({ session, operationId: 'tool-2', enquiry }), false);
  finish(23);
  assert.equal(await first, true);
  assert.equal(await handoff({ session, operationId: 'tool-3', enquiry }), true);
  assert.equal(await handoff({ session, operationId: 'tool-4', enquiry: { ...enquiry, quantity: 8 } }), false);
  assert.equal(operations.length, 1);
});

test('a failed or malformed Odoo response retains an uncertain receipt without replaying create', async () => {
  for (const execute of [async () => { throw new Error('connection dropped'); }, async () => '23']) {
    const { handoff, operations, receipt } = fixture(execute);
    assert.equal(await handoff({ session, operationId: 'tool-1', enquiry }), false);
    assert.equal(receipt().status, 'uncertain');
    assert.equal(receipt().leadId, undefined);
    assert.equal(await handoff({ session, operationId: 'tool-2', enquiry }), false);
    assert.equal(operations.length, 1);
  }
});

test('successful Odoo creation requires a persisted receipt before acknowledging', async () => {
  const { handoff, operations, receipt } = fixture(async () => 23, false);
  assert.equal(await handoff({ session, operationId: 'tool-1', enquiry }), false);
  assert.equal(receipt().status, 'processing');
  assert.equal(await handoff({ session, operationId: 'tool-2', enquiry }), false);
  assert.equal(operations.length, 1);
});

test('missing verified caller identity and invalid enquiries are rejected before claiming', async () => {
  const { handoff, operations, receipt } = fixture();
  for (const call of [
    { session: { ...session, verifiedCustomerPhone: '' }, enquiry },
    { session: { ...session, verifiedCustomerPhone: 'tel:12025550101' }, enquiry },
    { session: { ...session, direction: 'outgoing' }, enquiry },
    { session, enquiry: { ...enquiry, topic: 'unknown' } },
    { session, enquiry: { ...enquiry, nextStep: undefined } }
  ]) assert.equal(await handoff({ ...call, operationId: 'tool-1' }), false);
  assert.deepEqual(operations, []);
  assert.equal(receipt(), undefined);
});
