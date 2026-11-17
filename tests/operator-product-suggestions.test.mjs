import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createOperatorProductSuggestions, registerOperatorProductSuggestionRoutes,
  validOperatorProductSuggestionContext } from '../operator-product-suggestions.js';

const origin = 'https://www.smarthandicrafts.com';
const variant = {
  id: 701,
  display_name: '[COB-5-WW] 5V COB LED (3W, Warm White)',
  default_code: 'COB-5-WW',
  website_url: '/shop/cob-led-80?attribute_values=2%2C47',
  website_meta_description: '3W COB LED, warm white, 5V',
  image_512: '14.2 Kb'
};
const otherVariant = { ...variant, id: 702, display_name: 'LED strip 12V', default_code: 'STRIP-12',
  website_url: '/shop/led-strip-90', image_512: false };
const fakeImage = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd9]).toString('base64')}`;

function modelResponse(selections, clarifyingQuestion = '') {
  return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant',
    content: [{ type: 'output_text', text: JSON.stringify({ selections, clarifyingQuestion }) }] }] }));
}

test('selected products use exact Odoo variant links and photos after a publication recheck', async () => {
  const lookups = [];
  let sent;
  const provider = createOperatorProductSuggestions({
    login: async () => 30,
    execute: async (uid, model, method, [domain, fields], options) => {
      assert.equal(uid, 30);
      assert.equal(model, 'product.product');
      assert.equal(method, 'search_read');
      assert.ok(domain.some(filter => filter[0] === 'product_tmpl_id.is_published' && filter[2] === true));
      assert.ok(domain.some(filter => filter[0] === 'sale_ok' && filter[2] === true));
      lookups.push({ domain, fields, options });
      return [variant, otherVariant, { ...variant, id: 44, website_url: 'https://unaffiliated.invalid/shop/led-80' }];
    },
    apiKey: 'test-only',
    fetchImpl: async (url, request) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      sent = JSON.parse(request.body);
      return modelResponse([{ id: 900, evidence: 'fabricated' }, { id: 701, evidence: 'Warm White' },
        { id: 701, evidence: 'duplicate' }, { id: 702, evidence: 'unavailable image' }], 'How many pieces do you need?');
    }
  });
  const result = await provider.generate({
    conversation: 'Customer: 5V COB chahiye\n\nCustomer: 3 watts warm white. Call me at +91 99999 88888 or write to test@example.com.',
    image: fakeImage
  });
  assert.deepEqual(result, { suggestions: [{ id: 701, name: variant.display_name, sku: 'COB-5-WW',
    websiteUrl: `${origin}/shop/cob-led-80?attribute_values=2,47`,
    imageUrl: `${origin}/web/image/product.product/701/image_512`, reason: 'Warm White' }],
    clarifyingQuestion: 'How many pieces do you need?' });
  assert.equal(lookups.length, 2);
  assert.ok(!lookups[0].fields.includes('image_512'));
  assert.deepEqual(lookups[1].domain.at(-1), ['id', 'in', [701, 702]]);
  assert.ok(lookups[1].options.context.bin_size);
  assert.equal(sent.store, false);
  assert.equal(sent.text.format.strict, true);
  const input = JSON.parse(sent.input[0].content[0].text);
  assert.deepEqual(input.catalog.map(row => row.id), [701, 702]);
  assert.doesNotMatch(input.conversation, /99999|88888|test@example/);
  assert.deepEqual(sent.input[0].content[1], { type: 'input_image', image_url: fakeImage, detail: 'auto' });
});

test('cached models cannot return a withdrawn product after its publication changes', async () => {
  const provider = createOperatorProductSuggestions({
    login: async () => 30,
    execute: async (uid, model, method, [domain]) => domain.some(filter => filter[0] === 'id') ? [] : [variant],
    apiKey: 'test-only',
    fetchImpl: async () => modelResponse([{ id: 701, evidence: 'Warm White' }])
  });
  assert.deepEqual(await provider.generate({ conversation: '5V COB warm white' }), { suggestions: [], clarifyingQuestion: '' });
});

test('customer images must be bounded JPEG data and arbitrary URLs are rejected', () => {
  assert.equal(validOperatorProductSuggestionContext({ conversation: '', image: fakeImage }), true);
  assert.equal(validOperatorProductSuggestionContext({ conversation: '', image: 'https://example.com/image.jpg' }), false);
  assert.equal(validOperatorProductSuggestionContext({ conversation: 'test', image: 'data:image/jpeg;base64,YQ==' }), false);
  assert.equal(validOperatorProductSuggestionContext({ conversation: 'a'.repeat(12001) }), false);
  assert.equal(validOperatorProductSuggestionContext({ conversation: '' }), false);
});

test('a greeting-only thread uses neither the catalog nor AI provider', async () => {
  const provider = createOperatorProductSuggestions({ apiKey: 'test-only',
    login: async () => assert.fail('Odoo called for a greeting'), execute: async () => [],
    fetchImpl: async () => assert.fail('OpenAI called for a greeting') });
  const result = await provider.generate({ conversation: 'Customer: Hi! 👋\n\nTeam: How can I help you?\n\nCustomer: नमस्ते जी' });
  assert.deepEqual(result, { suggestions: [], clarifyingQuestion: '' });
});

test('canceling while Odoo is pending prevents any request to OpenAI', async () => {
  let finishOdoo;
  const odooPending = new Promise(resolve => { finishOdoo = resolve; });
  let confirmOdooStarted;
  const odooStarted = new Promise(resolve => { confirmOdooStarted = resolve; });
  const provider = createOperatorProductSuggestions({ login: async () => 1,
    execute: async () => { confirmOdooStarted(); return odooPending; }, apiKey: 'test-only',
    fetchImpl: async () => assert.fail('OpenAI called after disable') });
  const disable = new AbortController();
  const work = provider.generate({ conversation: '3 watt COB', signal: disable.signal });
  await odooStarted;
  disable.abort();
  await assert.rejects(work, { code: 'AI_PRODUCT_SUGGESTIONS_CANCELLED' });
  finishOdoo([variant]);
});

test('route requires enrolled operator access and an active feature lease', async () => {
  let handle;
  let allowed = false;
  let calls = 0;
  let finishes = 0;
  let began;
  const beganWork = new Promise(resolve => { began = resolve; });
  const feature = new AbortController();
  registerOperatorProductSuggestionRoutes({ post(path, handler) {
    assert.equal(path, '/api/ai-mode/product-suggestions');
    handle = handler;
  } }, {
    startRequest(name) {
      assert.equal(name, 'productSuggestions');
      return allowed ? { signal: feature.signal, finish: () => { finishes++; } } : null;
    },
    provider: { generate: ({ signal }) => new Promise((resolve, reject) => {
      calls++;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      began();
    }) }
  });
  const response = () => Object.assign(new EventEmitter(), {
    setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; }
  });
  const req = { body: { channelId: 80, conversation: 'Customer: 5V COB' } };
  const unauthenticated = response();
  await handle(req, unauthenticated);
  assert.equal(unauthenticated.code, 401);
  req.operatorAuth = { kind: 'browser', source: 'android', baseDeviceId: 'device-1', scopes: ['ai:draft'] };
  const disabled = response();
  await handle(req, disabled);
  assert.equal(disabled.body.code, 'AI_FEATURE_DISABLED');
  assert.equal(calls, 0);

  allowed = true;
  const canceled = response();
  const work = handle(req, canceled);
  await beganWork;
  feature.abort();
  await work;
  assert.equal(calls, 1);
  assert.equal(canceled.code, 409);
  assert.equal(canceled.body.code, 'AI_FEATURE_DISABLED');
  assert.equal(finishes, 1);
});
