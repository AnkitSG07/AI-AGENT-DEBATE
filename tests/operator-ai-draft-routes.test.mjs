import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, hkdfSync } from 'node:crypto';
import express from 'express';
import { createOperatorBrowserAuth } from '../operator-browser-auth.js';
import { createOperatorAiSwitch } from '../operator-ai-switch.js';
import { registerOperatorAiDraftRoutes } from '../operator-ai-draft-routes.js';

const SECRET = 'synthetic-draft-test-profile-secret-abcdefghijklmnopqrstuvwxyz';
const HUB = 'https://www.smarthandicrafts.com';
const BACKEND = 'https://ai-agent-debate.onrender.com';
const START = 1800000000000;
const DRAFT_PATH = '/api/ai-mode/draft';
const INPUT = { channelId: 42, conversation: 'Customer: Is blue available?', instruction: 'Ask for the product name.' };
const RESULT = { draft: 'Could you share the product name?', model: 'gpt-6.1-terra', usage: { inputTokens: 80, outputTokens: 12 } };

function signedClaims(claims) {
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(SECRET), Buffer.from('sh-operator-browser-auth'),
    Buffer.from('capability-signature-v1'), 32));
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `shb1.${payload}.${createHmac('sha256', key).update(`shb1.${payload}`).digest('base64url')}`;
}

async function fixture(t, { enabled = true, configured = true, generate = async () => RESULT, authOptions = {} } = {}) {
  let now = START;
  const calls = [];
  const app = express();
  app.use(express.json());
  const auth = createOperatorBrowserAuth({ secret: SECRET, backendOrigin: BACKEND,
    allowedHubOrigins: [HUB], clock: () => now,
    readProfileSession: req => req.headers['x-test-profile-session'] === 'synthetic-session'
      ? { profile: 'Smart handicrafts', exp: START + 7200000 } : null,
    authenticateNative: async () => { throw new Error('Native inference must be rejected before device lookup.'); },
    ...authOptions
  });
  auth.registerRoutes(app);
  app.use(auth.guard);
  registerOperatorAiDraftRoutes(app, { enabled, clock: () => now,
    provider: { configured: () => configured, generate: input => { calls.push(input); return generate(input); } }
  });
  app.use(createOperatorAiSwitch({ enabled: false }));
  app.post('/api/ai-mode/chat', (_req, res) => res.json({ unexpectedLegacyInference: true }));
  app.post('/api/whatsapp-calls/terminate', (_req, res) => res.json({ ok: true, callAction: 'available' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(path = DRAFT_PATH, { token, origin = HUB, body = INPUT, headers = {}, signal, method = 'POST' } = {}) {
    const response = await fetch(base + path, { method,
      headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      ...(method !== 'GET' ? { body: JSON.stringify(body) } : {}), signal: signal || AbortSignal.timeout(3000)
    });
    return { status: response.status, headers: response.headers, data: await response.json() };
  }

  async function issue() {
    const response = await request('/api/operator-browser-auth/token', { origin: BACKEND,
      headers: { 'X-SH-Operator-Auth': '1', 'X-Test-Profile-Session': 'synthetic-session' }, body: { origin: HUB } });
    assert.equal(response.status, 200);
    return response.data.token;
  }
  return { request, issue, calls, at: value => { now = value; } };
}

test('real capability guard denies unauthenticated, foreign-origin, native and insufficient-scope inference', async t => {
  const f = await fixture(t);
  const token = await f.issue();
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  const readOnly = signedClaims({ ...claims, scopes: ['ai:read'] });
  const attempts = [
    [{}, 401],
    [{ headers: { 'X-Test-Profile-Session': 'synthetic-session' } }, 401],
    [{ body: { ...INPUT, operatorAuth: { kind: 'browser', baseDeviceId: 'spoofed', scopes: ['ai:write'] } } }, 401],
    [{ token, origin: 'https://untrusted.invalid' }, 403],
    [{ token, origin: null }, 403],
    [{ token: `android_11111111-2222-3333-4444-555555555555.${'A'.repeat(43)}` }, 403],
    [{ token: readOnly }, 403]
  ];
  for (const [options, status] of attempts) {
    const response = await f.request(DRAFT_PATH, options);
    assert.equal(response.status, status);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.data.ok, false);
  }
  assert.equal(f.calls.length, 0);
});

test('manual drafting succeeds through the real guard while global automated inference remains disabled', async t => {
  const f = await fixture(t);
  const token = await f.issue();
  const response = await f.request(DRAFT_PATH, { token });
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, { ok: true, channelId: 42, ...RESULT });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].conversation, INPUT.conversation);
  assert.equal(f.calls[0].instruction, INPUT.instruction);
  assert.equal(f.calls[0].signal.aborted, false);
  const legacy = await f.request('/api/ai-mode/chat', { token });
  assert.equal(legacy.status, 503);
  assert.equal(legacy.data.code, 'AI_DISABLED');
  assert.equal(f.calls.length, 1);
});

test('enrolled-device proof grants manual drafting, reauthorization keeps admission identity, and revocation blocks inference', async t => {
  const id = 'android_11111111-2222-3333-4444-555555555555', nativeToken = `${id}.${'A'.repeat(43)}`;
  let current = { id, credentialGeneration: 1, revokedAt: 0, tokenExpiresAt: START + 3600000 };
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const f = await fixture(t, { generate: async () => { entered.resolve(); await release.promise; return RESULT; },
    authOptions: { androidAccessEnabled: true,
      authenticateNative: async raw => { assert.equal(raw, nativeToken); return current; },
      verifyAndroidCapability: async () => current } });
  async function enrolledGrant() {
    const challenge = await f.request('/api/operator-browser-auth/android/challenge', { body: {} });
    assert.equal(challenge.status, 200);
    const marker = await f.request(`/api/whatsapp-calls/recent?operator_device_id=sh_proof_${challenge.data.challenge}`,
      { method: 'GET', token: nativeToken, origin: null });
    assert.equal(marker.status, 200); assert.deepEqual(marker.data, { ok: true, calls: [] });
    const grant = await f.request('/api/operator-browser-auth/android/token', {
      body: { challenge: challenge.data.challenge, verifier: challenge.data.verifier } });
    assert.equal(grant.status, 200); return grant.data;
  }
  const first = await enrolledGrant(), browserToken = await f.issue();
  const pending = f.request(DRAFT_PATH, { token: first.token });
  t.after(() => release.resolve());
  await entered.promise;
  const second = await enrolledGrant();
  assert.equal(second.baseDeviceId, first.baseDeviceId);
  assert.notEqual(second.operatorSessionId, first.operatorSessionId);
  assert.equal((await f.request(DRAFT_PATH, { token: second.token, body: { ...INPUT, deviceId: 'spoofed' } })).status, 429);
  assert.equal((await f.request('/api/whatsapp-calls/terminate', { token: browserToken, body: {} })).status, 200);
  assert.equal((await f.request('/api/ai-mode/chat', { token: second.token })).status, 403);
  release.resolve();
  assert.deepEqual((await pending).data, { ok: true, channelId: 42, ...RESULT });
  current = { ...current, revokedAt: START };
  assert.equal((await f.request(DRAFT_PATH, { token: second.token })).status, 401);
  assert.equal(f.calls.length, 1);
});

test('disabled configuration and invalid inputs consume no provider calls', async t => {
  for (const options of [{ enabled: false }, { configured: false }]) {
    const f = await fixture(t, options);
    const response = await f.request(DRAFT_PATH, { token: await f.issue() });
    assert.equal(response.status, 503);
    assert.equal(response.data.code, 'AI_DRAFT_NOT_CONFIGURED');
    assert.equal(f.calls.length, 0);
  }
  const f = await fixture(t);
  const token = await f.issue();
  for (const body of [[], {}, { ...INPUT, channelId: '42' }, { ...INPUT, channelId: 0 },
    { ...INPUT, conversation: '' }, { ...INPUT, conversation: [] },
    { ...INPUT, conversation: 'x'.repeat(24001) }, { ...INPUT, instruction: 'x'.repeat(1001) }]) {
    const response = await f.request(DRAFT_PATH, { token, body });
    assert.equal(response.status, 400);
    assert.equal(response.data.code, 'INVALID_AI_DRAFT_INPUT');
  }
  assert.equal(f.calls.length, 0);
});

test('a pending draft blocks duplicate inference while call controls remain available', async t => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const f = await fixture(t, { generate: async () => { entered.resolve(); await release.promise; return RESULT; } });
  const token = await f.issue();
  const pending = f.request(DRAFT_PATH, { token });
  t.after(() => release.resolve());
  await entered.promise;
  const duplicate = await f.request(DRAFT_PATH, { token, body: { ...INPUT, baseDeviceId: 'spoofed-other-device' } });
  assert.equal(duplicate.status, 429);
  assert.equal(duplicate.data.code, 'AI_DRAFT_BUSY');
  assert.equal(duplicate.headers.get('retry-after'), '10');
  const call = await f.request('/api/whatsapp-calls/terminate', { token, body: {} });
  assert.equal(call.status, 200);
  assert.equal(call.data.callAction, 'available');
  assert.equal(f.calls.length, 1);
  release.resolve();
  assert.equal((await pending).status, 200);
});

test('per-operator request limit resets after the time window and cannot be bypassed through body identity', async t => {
  const f = await fixture(t);
  const token = await f.issue();
  for (let i = 0; i < 10; i++) {
    const response = await f.request(DRAFT_PATH, { token, body: { ...INPUT, deviceId: `spoofed-${i}` } });
    assert.equal(response.status, 200);
  }
  const blocked = await f.request(DRAFT_PATH, { token });
  assert.equal(blocked.status, 429);
  assert.equal(f.calls.length, 10);
  f.at(START + 60000);
  assert.equal((await f.request(DRAFT_PATH, { token })).status, 200);
  assert.equal(f.calls.length, 11);
});

test('global concurrency limit bounds provider work across separate authorized operators', async t => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let count = 0;
  const f = await fixture(t, { generate: async () => {
    count++;
    if (count === 4) entered.resolve();
    await release.promise;
    return RESULT;
  } });
  const tokens = [];
  for (let i = 0; i < 5; i++) tokens.push(await f.issue());
  const pending = tokens.slice(0, 4).map(token => f.request(DRAFT_PATH, { token }));
  t.after(() => release.resolve());
  await entered.promise;
  assert.equal((await f.request(DRAFT_PATH, { token: tokens[4] })).status, 429);
  assert.equal(f.calls.length, 4);
  release.resolve();
  for (const response of await Promise.all(pending)) assert.equal(response.status, 200);
  assert.equal((await f.request(DRAFT_PATH, { token: tokens[4] })).status, 200);
});

test('closing a request aborts generation and releases the operator slot', async t => {
  const entered = Promise.withResolvers();
  const cancelled = Promise.withResolvers();
  let count = 0;
  const f = await fixture(t, { generate: async ({ signal }) => {
    count++;
    if (count > 1) return RESULT;
    entered.resolve();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
      cancelled.resolve();
      reject(new Error('synthetic provider cancellation'));
    }, { once: true }));
  } });
  const token = await f.issue();
  const controller = new AbortController();
  const pending = f.request(DRAFT_PATH, { token, signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await entered.promise;
  controller.abort();
  await rejected;
  await cancelled.promise;
  const response = await f.request(DRAFT_PATH, { token });
  assert.equal(response.status, 200);
  assert.equal(f.calls.length, 2);
});

test('raw provider errors are hidden and a failed request releases the active slot', async t => {
  let count = 0;
  const privateDetails = 'sk-synthetic-provider-secret with private customer text';
  const f = await fixture(t, { generate: async () => {
    count++;
    if (count === 1) throw new Error(privateDetails);
    if (count === 2) throw Object.assign(new Error('AI usage is temporarily limited.'), {
      operatorAiDraftError: true, status: 429, code: 'AI_DRAFT_LIMIT'
    });
    return RESULT;
  } });
  const token = await f.issue();
  const raw = await f.request(DRAFT_PATH, { token });
  assert.equal(raw.status, 503);
  assert.equal(raw.data.code, 'AI_DRAFT_UNAVAILABLE');
  assert.equal(JSON.stringify(raw.data).includes(privateDetails), false);
  const known = await f.request(DRAFT_PATH, { token });
  assert.equal(known.status, 429);
  assert.equal(known.data.code, 'AI_DRAFT_LIMIT');
  assert.equal((await f.request(DRAFT_PATH, { token })).status, 200);
  assert.equal(f.calls.length, 3);
});
