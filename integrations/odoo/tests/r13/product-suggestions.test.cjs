'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { context, deferred, node } = require('./production-functions.cjs');

const websiteUrl = 'https://www.smarthandicrafts.com/shop/led-77?attribute_values=31';
const record = { id: 33, name: '5V COB, warm white', sku: 'COB5-WW', websiteUrl,
  imageUrl: 'https://www.smarthandicrafts.com/web/image/product.product/33/image_512' };
const productFunctions = ['safeId', 'aiProductSuggestionsAvailable', 'isProductConversationDetail', 'aiProductLookupInput',
  'cancelAiProductSuggestions', 'renderAiProductSuggestions', 'normalizeAiProductSuggestion',
  'loadAiProductSuggestions', 'reconcileAiProductSuggestions'];

function productFixture() {
  const fixture = { enabled: true, rendered: '', calls: [] };
  const selectedChannel = { id: 101, channel_type: 'whatsapp', partner_id: [601, 'Customer'] };
  const c = context(productFunctions, {
    state: { selectedChannelId: 101, selectedChannel, session: { uid: 7 }, attachmentsById: { 90: { mimetype: 'image/png' } },
      productSuggestions: { context: null, results: new Map() }, messages: [
        { id: 1, res_id: 101, message_type: 'whatsapp_message', author_id: [601], body: '5V COB' },
        { id: 2, res_id: 101, message_type: 'whatsapp_message', author_id: [8], body: 'Which colour?' },
        { id: 3, res_id: 101, message_type: 'whatsapp_message', author_id: [601], body: 'Warm white', attachment_ids: [90] },
        { id: 4, res_id: 101, message_type: 'whatsapp_message', author_id: [7], body: 'We can check' },
        { id: 5, res_id: 102, message_type: 'whatsapp_message', author_id: [602], body: 'Different customer' }
      ] },
    appLayout: { classList: { contains: () => true } }, document: { hidden: false },
    isWhatsappWindowOpen: () => true, operatorAiFeatureEnabled: () => fixture.enabled,
    byId: () => node(), patchKeyedChildren: (_, markup) => { fixture.rendered = markup; },
    escapeHtml: String, getMessagePlainText: message => message.body, AI_MODE_BACKEND_BASE: 'https://backend.invalid',
    aiProductInputPhoto: async id => 'offline-photo-' + id,
    appFetch: async (url, options) => {
      fixture.calls.push({ url, ...options, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ ok: true, channelId: 101, suggestions: [
        record, { ...record, id: 34, name: 'Unverified image', websiteUrl: 'https://invalid.example/shop/a' }
      ] }) };
    }
  });
  return { c, fixture };
}

test('product lookup sends only the current chat, includes its customer photo and validates catalog URLs', async () => {
  const { c, fixture } = productFixture();
  c.reconcileAiProductSuggestions();
  const active = c.state.productSuggestions.context;
  c.reconcileAiProductSuggestions();
  clearTimeout(active.timer);
  await c.loadAiProductSuggestions(active);
  assert.equal(c.state.productSuggestions.context, active);
  assert.deepEqual(fixture.calls.map(call => call.body), [{
    channelId: 101, conversation: 'Customer: 5V COB\n\nTeam: Which colour?\n\nCustomer: Warm white [Photo attached]',
    image: 'offline-photo-90'
  }]);
  assert.match(fixture.rendered, /5V COB, warm white/);
  assert.match(fixture.rendered, /product\.product\/33\/image_512/);
  assert.doesNotMatch(fixture.rendered, /Unverified image/);
  c.cancelAiProductSuggestions();
  c.reconcileAiProductSuggestions();
  assert.match(fixture.rendered, /5V COB, warm white/);
  assert.equal(fixture.calls.length, 1, 'Reopening the same chat context uses the recent result.');
});

test('switching AI off cancels the lookup and rejects a late result', async () => {
  const { c, fixture } = productFixture();
  const response = deferred(), requested = deferred();
  c.appFetch = async () => { requested.resolve(); return response.promise; };
  c.reconcileAiProductSuggestions();
  const active = c.state.productSuggestions.context;
  clearTimeout(active.timer);
  const loading = c.loadAiProductSuggestions(active);
  await requested.promise;
  fixture.enabled = false;
  c.reconcileAiProductSuggestions();
  assert.equal(active.controller.signal.aborted, true);
  response.resolve({ ok: true, json: async () => ({ ok: true, channelId: 101, suggestions: [record] }) });
  await loading;
  assert.equal(fixture.rendered, '');
  assert.equal(c.state.productSuggestions.context, null);
  assert.equal(c.state.productSuggestions.results.size, 0);
});

test('a courtesy-only chat and another staff member’s question do not trigger inference', () => {
  const { c, fixture } = productFixture();
  const staff = c.state.messages[1];
  c.state.messages = [
    { ...c.state.messages[0], body: 'Hi there, sir!' },
    staff,
    { ...c.state.messages[2], body: 'Thank you, ji 🙏', attachment_ids: [] },
    { ...c.state.messages[4], id: 6, res_id: 101, body: 'धन्यवाद जी', author_id: [601] }
  ];
  c.reconcileAiProductSuggestions();
  assert.equal(c.state.productSuggestions.context, null);
  assert.deepEqual(fixture.calls, []);
});

test('a new customer detail replaces a pending lookup and keeps the most recent inbound photo', async () => {
  const { c, fixture } = productFixture();
  const sendNew = c.appFetch;
  const oldResponse = deferred(), started = deferred();
  c.appFetch = async () => { started.resolve(); return oldResponse.promise; };
  c.reconcileAiProductSuggestions();
  const old = c.state.productSuggestions.context;
  clearTimeout(old.timer);
  const loading = c.loadAiProductSuggestions(old);
  await started.promise;
  c.state.messages.push({ ...c.state.messages[2], id: 9, body: 'Actually, I need cool white.', attachment_ids: [] });
  c.reconcileAiProductSuggestions();
  const latest = c.state.productSuggestions.context;
  clearTimeout(latest.timer);
  assert.notEqual(latest, old);
  assert.equal(old.controller.signal.aborted, true);
  oldResponse.resolve({ ok: true, json: async () => ({ ok: true, channelId: 101, suggestions: [record] }) });
  await loading;
  assert.equal(fixture.rendered, '');
  c.appFetch = sendNew;
  await c.loadAiProductSuggestions(latest);
  assert.match(fixture.calls[0].body.conversation, /Customer: Actually, I need cool white\.$/);
  assert.equal(fixture.calls[0].body.image, 'offline-photo-90');
});

test('a staged photo is retrieved from its exact same-origin Odoo variant before sending', async () => {
  const productPath = '/web/image/product.product/33/image_512';
  const photoBytes = Uint8Array.of(255, 216, 255, 217);
  const c = context(['normalizeAiProductSuggestion', 'getProductAttachmentFile'], {
    File, appFetch: async (path, options) => {
      assert.equal(path, productPath);
      assert.equal(options.credentials, 'same-origin');
      assert.equal(options.redirect, 'error');
      return new Response(photoBytes, { headers: { 'Content-Type': 'image/jpeg' } });
    }
  });
  const product = c.normalizeAiProductSuggestion(record);
  const file = await c.getProductAttachmentFile(product);
  assert.equal(file.type, 'image/jpeg');
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), photoBytes);
});

test('selecting a product stages the exact link without sending, and Send keeps the photo on its original chat', async () => {
  const first = { id: 101, channel_type: 'whatsapp' }, next = { id: 102, channel_type: 'whatsapp' };
  const ready = deferred(), posts = [], uploads = [];
  const c = context(['updateProductAttachmentDraft', 'sendCurrentMessage', 'sendAttachmentsFromInput'], {
    state: { selectedChannelId: 101, selectedChannel: first, channels: [first, next], draftsByChannel: new Map(), productAttachmentsByChannel: new Map() },
    messageInput: node('Here is the product we discussed.'), sendButton: node(), attachFileBtn: node(),
    attachmentInput: node(), autoGrowTextarea() {}, renderProductAttachmentDraft() {}, updateComposerState() {}, isWhatsappWindowOpen: () => true,
    getProductAttachmentFile: async product => { assert.equal(product.id, 33); await ready.promise; return { name: 'photo.jpg' }; },
    uploadAttachmentToCurrentThread: async (file, channel) => { uploads.push([file.name, channel.id]); return 901; },
    messagePost: async (id, values) => posts.push([id, JSON.parse(JSON.stringify(values))]),
    loadMessages: async () => {}, loadChannels: async () => {}, showOperatorToast() {}
  });
  c.updateProductAttachmentDraft(record);
  assert.equal(c.messageInput.value, 'Here is the product we discussed.\n\n' + websiteUrl);
  assert.deepEqual(posts, []);
  const sending = c.sendCurrentMessage();
  c.state.selectedChannelId = next.id;
  c.state.selectedChannel = next;
  c.messageInput.value = 'Reply for another customer';
  await c.sendCurrentMessage();
  ready.resolve();
  await sending;
  assert.deepEqual(uploads, [['photo.jpg', 101]]);
  assert.deepEqual(posts, [[101, { body: 'Here is the product we discussed.\n\n' + websiteUrl, message_type: 'whatsapp_message',
    subtype_xmlid: 'mail.mt_comment', attachment_ids: [901] }]]);
  assert.equal(c.messageInput.value, 'Reply for another customer');
  assert.equal(c.state.productAttachmentsByChannel.size, 0);
});
