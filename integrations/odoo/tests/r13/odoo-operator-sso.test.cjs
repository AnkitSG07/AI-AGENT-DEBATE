'use strict';

const assert = require('node:assert/strict');
const { createHash, webcrypto } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const hub = 'https://www.smarthandicrafts.com';
const backend = 'https://ai-agent-debate.onrender.com';
const challengePath = '/api/operator-browser-auth/odoo/challenge';
const tokenPath = '/api/operator-browser-auth/odoo/token';
const proofPath = '/web/dataset/call_kw/x_sh_operator_proof/create';
const settingsPath = '/api/ai-mode';
const draftPath = `${settingsPath}/draft`;
const productsPath = `${settingsPath}/product-suggestions`;
const deviceChallengePath = '/api/operator-browser-auth/android/challenge';
const deviceTokenPath = '/api/operator-browser-auth/android/token';
const challenge = 'b'.repeat(43);
const desktopToken = `shb1.${'x'.repeat(45)}.${'y'.repeat(45)}`;
const androidToken = `shb1.${'d'.repeat(45)}.${'e'.repeat(45)}`;
const lookupToken = 'x'.repeat(32);

const embedPath = resolve(process.env.SH_TEST_EMBED || resolve(__dirname, '../../smart-handicrafts-whatsapp-embed-r13.html'));
const embed = readFileSync(embedPath, 'utf8');
const helperSource = /<!-- SH_OPERATOR_AUTH_R13_START -->\s*<script>([\s\S]*?)<\/script>\s*<!-- SH_OPERATOR_AUTH_R13_END -->/.exec(embed)?.[1];
assert.ok(helperSource, 'Missing SH Chat authorization helper');

function fixture({ disabled = false, denyProof = false, uid = 7, android = false, rejectWrite = false, beforeToken } = {}) {
  const requests = [], popups = [];
  const profile = { source: 'odoo', odooUid: uid, token: desktopToken,
    operatorDeviceId: `web_${lookupToken}::tab_${'b'.repeat(24)}` };
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' }
  });
  const window = new EventTarget();
  window.top = window;
  window.open = (...args) => { popups.push(args); throw Error('Unexpected separate sign-in'); };
  if (android) {
    window.SHNativeHistory = { protocol: 'sh-call-history-v1' };
    window.SHNative = { postMessage() {} };
  }
  window.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input, hub);
    const method = init.method || 'GET';
    const headers = new Headers(init.headers);
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    requests.push({ url, method, headers, body, credentials: init.credentials, redirect: init.redirect });
    assert.ok([hub, backend].includes(url.origin), `Unexpected fetch to ${url.origin}`);
    const now = Date.now();
    switch (url.pathname) {
    case challengePath:
      return disabled ? json({ ok: false, code: 'ODOO_SSO_DISABLED' }, 503)
        : json({ ok: true, challenge, issuedAt: now, expiresAt: now + 45000 });
    case proofPath:
      if (denyProof) return json({ error: { data: { name: 'odoo.exceptions.AccessError' } } });
      return json({ result: 371 });
    case tokenPath:
      await beforeToken?.();
      return json({ ok: true, ...profile, expiresAt: now + 600000, authExpiresAt: now + 600000 });
    case deviceChallengePath:
      return json({ ok: true, challenge, verifier: 'a'.repeat(43), expiresAt: now + 45000 });
    case deviceTokenPath:
      return json({ ok: true, source: 'android', token: androidToken, expiresAt: now + 600000 });
    case '/api/whatsapp-calls/recent':
      return json({ ok: true });
    default:
      if (rejectWrite && url.pathname === settingsPath && method === 'POST') return json({ ok: false }, 401);
      return json({ ok: true });
    }
  };
  const runtime = vm.createContext({ window, location: new URL(`${hub}/livechat-api-test`), crypto: webcrypto,
    URL, Headers, Request, AbortController, DOMException, EventTarget, CustomEvent, MessageEvent, TextEncoder, TextDecoder,
    console, setTimeout: (fn, ms) => setTimeout(fn, ms).unref(), clearTimeout, setInterval, clearInterval, queueMicrotask });
  vm.runInContext(helperSource, runtime, { filename: embedPath });
  assert.ok(window.SHOperatorAuth, 'SH Chat did not install its authorization helper');
  return { auth: window.SHOperatorAuth, requests, popups,
    fetch: (path, method = 'GET', options = {}) => window.fetch(backend + path, { method, ...options }) };
}

function assertOdooProof(f) {
  const [request, proof, exchange] = f.requests;
  assert.deepEqual(f.requests.slice(0, 3).map(x => [x.url.origin, x.url.pathname, x.method]), [
    [backend, challengePath, 'POST'], [hub, proofPath, 'POST'], [backend, tokenPath, 'POST']
  ]);
  assert.deepEqual(request.body, {});
  assert.equal(request.credentials, 'omit');
  assert.deepEqual(proof.body.params, { model: 'x_sh_operator_proof', method: 'create',
    args: [{ x_name: createHash('sha256').update(challenge).digest('hex') }], kwargs: {} });
  assert.equal(proof.credentials, 'same-origin');
  assert.equal(proof.headers.get('Authorization'), null);
  assert.deepEqual(exchange.body, { challenge, proofId: 371 });
  assert.equal(exchange.credentials, 'omit');
}

test('desktop AI settings, drafts and suggestions share one verified Odoo session', async () => {
  const f = fixture();
  f.auth.setOdooUser(7);
  const routes = [[settingsPath, 'GET'], [settingsPath, 'POST'], [draftPath, 'POST'], [productsPath, 'POST']];
  const responses = await Promise.all(routes.map(([path, method]) => f.fetch(path, method)));
  assert.ok(responses.every(response => response.status === 200));
  assertOdooProof(f);
  const traffic = f.requests.slice(3);
  assert.deepEqual(traffic.map(request => [request.url.pathname, request.method]).sort(), [...routes].sort());
  assert.ok(traffic.every(request => request.headers.get('Authorization') === `Bearer ${desktopToken}` && request.credentials === 'omit'));
  const restricted = [['/api/whatsapp-calls/logs', 'GET'], ['/api/zoho-mail/status', 'GET'],
    ['/api/google-contacts/search', 'GET'], ['/api/odoo-documents/tree', 'GET'],
    ['/api/ai-mode/chat', 'POST'], [draftPath, 'GET'], [productsPath, 'GET']];
  for (const [path, method] of restricted) await assert.rejects(f.fetch(path, method));
  assert.equal(f.requests.length, routes.length + 3, 'The Odoo token must not be sent to unrelated operator services');
  assert.deepEqual(f.popups, []);
});

test('desktop AI access stays closed without a popup when Odoo proof is unavailable or denied', async () => {
  for (const [options, paths] of [[{ disabled: true }, [challengePath]], [{ denyProof: true }, [challengePath, proofPath]]]) {
    const f = fixture(options);
    f.auth.setOdooUser(7);
    await assert.rejects(f.fetch(settingsPath));
    assert.deepEqual(f.requests.map(request => request.url.pathname), paths);
    assert.deepEqual(f.popups, []);
  }
});

test('the explicit non-AI connection still opens the existing operator sign-in', async () => {
  const f = fixture();
  f.auth.setOdooUser(7);
  await assert.rejects(async () => f.auth.connect(), /Unexpected separate sign-in/);
  assert.equal(f.popups.length, 1);
  assert.equal(new URL(f.popups[0][0]).pathname, '/operator-auth');
  assert.deepEqual(f.requests, []);
});

test('a missing or changed Odoo account never authorizes the protected request', { timeout: 5000 }, async () => {
  const missing = fixture();
  await assert.rejects(missing.fetch(settingsPath));
  assert.deepEqual(missing.requests, []);
  missing.auth.setOdooUser(7);
  assert.equal((await missing.fetch(settingsPath)).status, 200);
  assertOdooProof(missing);

  let releaseToken, observedToken;
  const tokenReached = new Promise(resolve => { observedToken = resolve; });
  const pauseToken = new Promise(resolve => { releaseToken = resolve; });
  const changed = fixture({ beforeToken: () => { observedToken(); return pauseToken; } });
  changed.auth.setOdooUser(7);
  const response = changed.fetch(settingsPath);
  const rejected = assert.rejects(response);
  await tokenReached;
  changed.auth.setOdooUser(8);
  releaseToken();
  await rejected;
  assert.equal(changed.auth.connected(), false);
  assertOdooProof(changed);
  assert.equal(changed.requests.length, 3);
  assert.deepEqual(changed.popups, []);
});

test('an unauthorized AI settings write stops after one attempt', async () => {
  const f = fixture({ rejectWrite: true });
  f.auth.setOdooUser(7);
  assert.equal((await f.fetch(settingsPath, 'POST')).status, 401);
  assertOdooProof(f);
  assert.deepEqual(f.requests.slice(3).map(request => [request.method, request.url.pathname]), [['POST', settingsPath]]);
  assert.deepEqual(f.popups, []);
});

test('Android AI traffic retains enrollment proof without opening an operator sign-in', async () => {
  const f = fixture({ android: true });
  const responses = await Promise.all([f.fetch(settingsPath), f.fetch(productsPath, 'POST')]);
  assert.ok(responses.every(response => response.status === 200));
  assert.deepEqual(f.requests.slice(0, 3).map(request => request.url.pathname),
    [deviceChallengePath, '/api/whatsapp-calls/recent', deviceTokenPath]);
  assert.equal(f.requests[1].url.searchParams.get('operator_device_id'), `sh_proof_${challenge}`);
  assert.equal(f.requests[1].headers.get('Authorization'), null);
  assert.ok(f.requests.slice(3).every(request => request.headers.get('Authorization') === `Bearer ${androidToken}`));
  assert.deepEqual(f.popups, []);
});
