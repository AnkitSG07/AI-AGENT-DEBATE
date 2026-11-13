import assert from 'node:assert/strict';
import test from 'node:test';
import { createVoiceCatalogLookup, createVoiceEnquiryCapture, loadVoiceInstructions,
  VOICE_CATALOG_TOOL, VOICE_ENQUIRY_TOOL } from '../call-runtime/ai-voice-knowledge.mjs';

test('voice instructions load Smart Handicrafts product and handover rules under call policy', async () => {
  const instructions = await loadVoiceInstructions();
  for (const pattern of [/English, Hindi, or Hinglish/, /ask one genuinely missing question/i,
    /recorded enquiry does not schedule a callback/, /Odoo pricelist authority/, /AS-B-201-SLD/,
    /2600mAh battery should be the primary/, /205 is the fast-charging option/, /Khushagra/, /Vibhu/]) {
    assert.match(instructions, pattern);
  }
  assert.doesNotMatch(instructions, /AI Modes|WhatsApp number if missing/);
  assert.equal(VOICE_CATALOG_TOOL.name, 'lookup_catalog');
  assert.equal(VOICE_ENQUIRY_TOOL.name, 'capture_enquiry');
});

test('catalog lookup ranks exact SKUs and aliases without exposing price, stock or backend data', async () => {
  const queries = [];
  const lookup = createVoiceCatalogLookup({ getCatalog: async query => {
    queries.push(query);
    return { ok: true, products: [
      { name: 'Custom driver', sku: 'AS-B-201-SLD-CTM' },
      { id: 1952, name: 'Driver - 201 Rechargeable 1 Color', sku: 'AS-B-201-SLD', price: 250,
        list_price: 250, qty_available: 500, description: 'List price and stock', privateField: 'internal' },
      { name: 'Cree COB 3W', sku: 'SH-COB-3', variantSkus: ['SH-COB-3-WARM'], variantNames: ['Warm Colour'] },
      { name: 'Cree COB 13W', sku: 'SH-COB-13' }
    ] };
  } });
  const exact = await lookup({ query: '  as-b-201-sld  ' });
  assert.equal(exact.status, 'found');
  assert.deepEqual(exact.matches, [{ name: 'Driver - 201 Rechargeable 1 Color', sku: 'AS-B-201-SLD' }]);
  const product = await lookup({ query: '3 watt COB' });
  assert.deepEqual(product.matches.map(row => row.sku), ['SH-COB-3']);
  assert.deepEqual((await lookup({ query: 'SH-COB-3-WARM' })).matches[0].variantNames, ['Warm Colour']);
  assert.equal((await lookup({ query: 'driver color' })).status, 'found');
  assert.equal((await lookup({ query: 'unlisted bulb' })).status, 'not_found');
  assert.deepEqual(queries, ['as-b-201-sld', '3 watt COB', 'SH-COB-3-WARM', 'driver color', 'unlisted bulb']);
});

test('integration and compatibility references are independent of live catalog availability', async () => {
  const lookup = createVoiceCatalogLookup({ getCatalog: async () => { throw new Error('private provider detail'); } });
  const result = await lookup({ query: 'AS-B-201-SLD', relatedQuery: 'SH-COB-3' });
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.matches, []);
  assert.match(result.integration[0].title, /AS-B-201-SLD/);
  assert.ok(result.compatibility.some(row => row.sku === 'AS-B-201-SLD' &&
    row.relations.some(item => item.sku === 'SH-COB-3' && item.relation === 'recommended')));
  assert.doesNotMatch(JSON.stringify(result), /private provider detail|sales_price|qty_available|fixed_price/);
  assert.ok((await lookup({ query: 'panel mount connector lamp base' })).integration.some(row => /PANEL MOUNT/.test(row.title)));
  assert.ok((await lookup({ query: 'SH-COB-3', relatedQuery: 'AS-B-201-SLD' })).compatibility.length);
  assert.deepEqual((await lookup({ query: 'AS-B-201-SLD', relatedQuery: 'made-up-fan-99' })).compatibility, []);
});

test('catalog rejects contact-like and malformed queries before reading Odoo', async () => {
  let reads = 0;
  const lookup = createVoiceCatalogLookup({ getCatalog: () => { reads++; } });
  for (const args of [null, {}, { query: 'LED someone@example.com' }, { query: 'LED +91 (9315) 155031' },
    { query: 'LED ९३१५१५५०३१' }, { query: 'LED', relatedQuery: 'https://example.com' }, { query: 'x'.repeat(121) }]) {
    assert.deepEqual(await lookup(args), { status: 'invalid_query', matches: [] });
  }
  assert.equal(reads, 0);
});

test('enquiry capture deduplicates confirmed details and forwards only supported fields', async () => {
  const saved = [];
  const capture = createVoiceEnquiryCapture({ onCapture: async enquiry => { saved.push(enquiry); return true; } });
  const request = { topic: 'kit', nextStep: 'sales_review', application: '<b>table lamp</b>',
    power: 'rechargeable', light: 'single COB', wattage: '3W', quantity: '50', phone: '+919315155031' };
  const results = await Promise.all([capture(request), capture({ ...request, power: '  rechargeable  ' })]);
  assert.deepEqual(results, [{ status: 'captured' }, { status: 'captured' }]);
  assert.deepEqual(saved, [{ topic: 'kit', nextStep: 'sales_review', application: 'table lamp',
    power: 'rechargeable', light: 'single COB', wattage: '3W', quantity: '50' }]);
  assert.deepEqual(await capture({ ...request, summary: 'Email at user@example.com' }), { status: 'invalid_enquiry' });
  assert.deepEqual(await capture({ ...request, summary: 'x'.repeat(321) }), { status: 'invalid_enquiry' });
  assert.deepEqual(await capture({ ...request, topic: 'callback' }), { status: 'invalid_enquiry' });
  assert.deepEqual(await capture({ topic: 'kit', nextStep: 'sales_review' }), { status: 'invalid_enquiry' });
  assert.equal(saved.length, 1);
});

test('enquiry capture reports success only after staff review is accepted and retries failures', async () => {
  const request = { topic: 'technical', nextStep: 'technical_review', product: 'AS-B-201-SLD' };
  assert.deepEqual(await createVoiceEnquiryCapture()(request), { status: 'unavailable' });
  let attempts = 0;
  const capture = createVoiceEnquiryCapture({ onCapture: async () => {
    attempts++;
    if (attempts === 1) throw new Error('unavailable');
    if (attempts === 2) return { ok: false };
    return true;
  } });
  assert.deepEqual(await capture(request), { status: 'unavailable' });
  assert.deepEqual(await capture(request), { status: 'unavailable' });
  assert.deepEqual(await capture(request), { status: 'captured' });
  assert.deepEqual(await capture(request), { status: 'captured' });
  assert.equal(attempts, 3);
});

test('a timed-out capture keeps its in-flight write and recognizes later acceptance', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const review = Promise.withResolvers();
  let attempts = 0;
  const capture = createVoiceEnquiryCapture({ onCapture: () => { attempts++; return review.promise; } });
  const request = { topic: 'kit', nextStep: 'sales_review', application: 'table lamp' };
  const first = capture(request);
  const duplicate = capture(request);
  t.mock.timers.tick(5000);
  assert.deepEqual(await first, { status: 'unavailable' });
  assert.deepEqual(await duplicate, { status: 'unavailable' });
  const completion = capture(request);
  review.resolve(true);
  assert.deepEqual(await completion, { status: 'captured' });
  assert.equal(attempts, 1);
});
