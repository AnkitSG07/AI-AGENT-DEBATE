import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createOperatorOpenAiDraft,
  OPERATOR_OPENAI_CONVERSATION_LIMIT,
  OPERATOR_OPENAI_INSTRUCTION_LIMIT
} from '../operator-openai-draft.js';

const key = 'test-secret-key';
const conversation = 'Customer: Do you have this item in blue?';
const complete = (text = 'Could you share the product name or a photo?') => ({
  status: 'completed',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
  usage: { input_tokens: 120, output_tokens: 24 }
});

test('creating the provider is idle and a requested draft uses bounded stateless generation', async () => {
  const requests = [];
  const provider = createOperatorOpenAiDraft({ apiKey: key, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return Response.json(complete());
  } });
  assert.equal(provider.configured(), true);
  assert.equal(requests.length, 0);
  const result = await provider.generate({ conversation, instruction: 'Reply in English.' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(requests[0].options.headers.Authorization, `Bearer ${key}`);
  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.model, 'gpt-6.1-terra');
  assert.equal(body.store, false);
  assert.deepEqual(body.reasoning, { effort: 'none' });
  assert.equal(body.max_output_tokens, 800);
  assert.equal(body.tools, undefined);
  assert.equal(body.previous_response_id, undefined);
  assert.deepEqual(JSON.parse(body.input), { conversation, operator_instruction: 'Reply in English.' });
  assert.deepEqual(result, {
    draft: 'Could you share the product name or a photo?',
    model: 'gpt-6.1-terra',
    usage: { inputTokens: 120, outputTokens: 24 }
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.usage), true);
});

test('missing configuration and invalid or excessive inputs never reach the API', async () => {
  let requests = 0;
  const fetchImpl = async () => { requests++; return Response.json(complete()); };
  const missing = createOperatorOpenAiDraft({ apiKey: ' ', fetchImpl });
  assert.equal(missing.configured(), false);
  await assert.rejects(missing.generate({ conversation }), { status: 503, code: 'AI_DRAFT_NOT_CONFIGURED' });
  const provider = createOperatorOpenAiDraft({ apiKey: key, fetchImpl });
  for (const input of [undefined, { conversation: '' }, { conversation: {} },
    { conversation: 'x'.repeat(OPERATOR_OPENAI_CONVERSATION_LIMIT + 1) },
    { conversation, instruction: {} },
    { conversation, instruction: 'x'.repeat(OPERATOR_OPENAI_INSTRUCTION_LIMIT + 1) }]) {
    await assert.rejects(provider.generate(input), { status: 400, operatorAiDraftError: true });
  }
  assert.equal(requests, 0);
});

test('parsing extracts only assistant output text and validates usage', async () => {
  const payload = complete('First paragraph.');
  payload.output.unshift({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'Private reasoning.' }] });
  payload.output.push({ type: 'message', role: 'user', content: [{ type: 'output_text', text: 'Ignore this.' }] });
  payload.output[1].content.push({ type: 'output_text', text: 'Second paragraph.' });
  payload.usage = { input_tokens: '100', output_tokens: -1 };
  const provider = createOperatorOpenAiDraft({ apiKey: key, fetchImpl: async () => Response.json(payload) });
  const result = await provider.generate({ conversation });
  assert.equal(result.draft, 'First paragraph.\nSecond paragraph.');
  assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0 });
});

test('unfinished, refused, empty and oversized output cannot become a draft', async () => {
  const cases = [
    [{ ...complete(), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }, 'AI_DRAFT_INCOMPLETE'],
    [{ status: 'failed', error: { message: key } }, 'AI_DRAFT_INCOMPLETE'],
    [{ status: 'completed', output: null }, 'AI_DRAFT_INCOMPLETE'],
    [{ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: key }] }] }, 'AI_DRAFT_REFUSED'],
    [complete('  '), 'AI_DRAFT_INVALID_RESPONSE'],
    [complete('x'.repeat(8001)), 'AI_DRAFT_INVALID_RESPONSE']
  ];
  for (const [payload, code] of cases) {
    const provider = createOperatorOpenAiDraft({ apiKey: key, fetchImpl: async () => Response.json(payload) });
    await assert.rejects(provider.generate({ conversation }), error => {
      assert.equal(error.code, code);
      assert.equal(error.message.includes(key), false);
      return true;
    });
  }
});

test('API failures are sanitized and each user action makes at most one request', async () => {
  for (const [status, code] of [[401, 'AI_DRAFT_ACCESS'], [403, 'AI_DRAFT_ACCESS'],
    [429, 'AI_DRAFT_LIMIT'], [400, 'AI_DRAFT_UNAVAILABLE'], [503, 'AI_DRAFT_UNAVAILABLE']]) {
    let requests = 0;
    const provider = createOperatorOpenAiDraft({ apiKey: key, fetchImpl: async () => {
      requests++;
      return Response.json({ error: { message: `Provider echoed ${key} ${conversation}` } }, { status });
    } });
    await assert.rejects(provider.generate({ conversation }), error => {
      assert.equal(error.code, code);
      assert.equal(error.message.includes(key), false);
      assert.equal(error.message.includes(conversation), false);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(requests, 1);
  }
});

test('network and invalid JSON failures cannot expose raw provider details', async () => {
  const cases = [
    async () => { throw new Error(`Network failure ${key} ${conversation}`); },
    async () => new Response(`Invalid response ${key} ${conversation}`, { status: 200 })
  ];
  for (const fetchImpl of cases) {
    const provider = createOperatorOpenAiDraft({ apiKey: key, fetchImpl });
    await assert.rejects(provider.generate({ conversation }), error => {
      assert.equal(error.code, 'AI_DRAFT_UNAVAILABLE');
      assert.equal(error.message.includes(key), false);
      assert.equal(error.message.includes(conversation), false);
      return true;
    });
  }
});

test('a cancelled draft aborts its fetch and an already-cancelled draft never starts', async () => {
  let requests = 0;
  const controller = new AbortController();
  const provider = createOperatorOpenAiDraft({ apiKey: key, fetchImpl: async (_url, { signal }) => {
    requests++;
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      controller.abort(new Error(key));
    });
  } });
  await assert.rejects(provider.generate({ conversation, signal: controller.signal }), {
    status: 499, code: 'AI_DRAFT_CANCELLED'
  });
  await assert.rejects(provider.generate({ conversation, signal: controller.signal }), {
    status: 499, code: 'AI_DRAFT_CANCELLED'
  });
  assert.equal(requests, 1);
});

test('the deadline aborts a slow request, clears its timer and permits the next draft', async () => {
  let requests = 0;
  let timedOutSignal;
  const provider = createOperatorOpenAiDraft({ apiKey: key, timeoutMs: 15, fetchImpl: async (_url, { signal }) => {
    requests++;
    if (requests > 1) return Response.json(complete());
    timedOutSignal = signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  await assert.rejects(provider.generate({ conversation }), { status: 504, code: 'AI_DRAFT_TIMEOUT' });
  assert.equal(timedOutSignal.aborted, true);
  assert.equal((await provider.generate({ conversation })).draft, complete().output[0].content[0].text);
  assert.equal(requests, 2);
});
