import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { createOperatorBrowserAuth, ODOO_OPERATOR_SCOPES } from './operator-browser-auth.js';
import { createOdooOperatorChallenges, ODOO_OPERATOR_CHALLENGE_TTL_MS } from './operator-odoo-sso-challenges.js';

const SECRET = 'synthetic-odoo-operator-proof-secret-abcdefghijklmnopqrstuvwxyz';
const HUB = 'https://www.smarthandicrafts.com';
const OTHER_HUB = 'https://smarthandicrafts.com';
const BACKEND = 'https://ai-agent-debate.onrender.com';
const START = 1800000000000;
const CHALLENGE_PATH = '/api/operator-browser-auth/odoo/challenge';
const TOKEN_PATH = '/api/operator-browser-auth/odoo/token';
const sha = value => createHash('sha256').update(value).digest('hex');
const claimsOf = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
function sign(claims) {
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(SECRET), Buffer.from('sh-operator-browser-auth'),
    Buffer.from('capability-signature-v1'), 32));
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `shb1.${payload}.${createHmac('sha256', key).update(`shb1.${payload}`).digest('base64url')}`;
}
function response() {
  return { statusCode: 200, headers: {}, payload: null, next: 0,
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.payload = value; return this; }
  };
}
function request(path, { method = 'POST', body = {}, origin = HUB, headers = {}, ip = '192.0.2.1' } = {}) {
  return { path: path.split('?')[0], originalUrl: path, url: path, method, body, ip, query: {},
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), ...headers } };
}
function fixture({ verifier, ...overrides } = {}) {
  let now = START;
  const routes = new Map(), verifications = [];
  const auth = createOperatorBrowserAuth({ secret: SECRET, backendOrigin: BACKEND,
    allowedHubOrigins: [HUB, OTHER_HUB], odooSsoEnabled: true, clock: () => now,
    verifyOdooOperatorProof: async proof => {
      verifications.push(proof);
      return verifier ? verifier(proof) : { uid: 42, scopes: [...ODOO_OPERATOR_SCOPES] };
    }, ...overrides });
  auth.registerRoutes({ get: (path, handler) => routes.set(`GET ${path}`, handler),
    post: (path, handler) => routes.set(`POST ${path}`, handler) });
  async function invoke(path, options) {
    const req = request(path, options), res = response();
    const handler = routes.get(`${req.method} ${req.path}`);
    assert.ok(handler);
    await handler(req, res);
    return { req, res };
  }
  async function challenge(options) {
    const result = await invoke(CHALLENGE_PATH, options);
    assert.equal(result.res.statusCode, 200);
    return result.res.payload;
  }
  async function issue({ previousToken, origin = HUB, proofId = 91 } = {}) {
    const nonce = await challenge({ origin });
    return invoke(TOKEN_PATH, { origin, body: { challenge: nonce.challenge, proofId,
      ...(previousToken ? { previousToken } : {}) } });
  }
  async function guard(path, token, { method = 'GET', origin = HUB, body = {} } = {}) {
    const req = request(path, { method, origin, body, headers: { authorization: `Bearer ${token}` } }), res = response();
    await auth.guard(req, res, () => { res.next++; });
    return { req, res };
  }
  return { auth, invoke, challenge, issue, guard, verifications, at: value => { now = value; } };
}

test('challenge nonces are cryptographic, exact-origin bound, digest-only and expire once', () => {
  let now = START;
  const store = createOdooOperatorChallenges({ allowedOrigins: [HUB, OTHER_HUB], clock: () => now });
  const first = store.issue({ origin: HUB, ip: 'test' });
  const second = store.issue({ origin: HUB, ip: 'test' });
  assert.match(first.challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.challenge, second.challenge);
  assert.equal(first.issuedAt, START);
  assert.equal(first.expiresAt, START + ODOO_OPERATOR_CHALLENGE_TTL_MS);
  assert.throws(() => store.consume({ origin: OTHER_HUB, ip: 'test', challenge: first.challenge }), { code: 'ODOO_PROOF_CHALLENGE_INVALID' });
  const consumed = store.consume({ origin: HUB, ip: 'new-network', challenge: first.challenge });
  assert.deepEqual(consumed, { digest: sha(first.challenge), issuedAt: first.issuedAt, expiresAt: first.expiresAt });
  assert.equal(Object.isFrozen(consumed), true);
  assert.throws(() => store.consume({ origin: HUB, ip: 'test', challenge: first.challenge }), { code: 'ODOO_PROOF_CHALLENGE_INVALID' });
  now = second.expiresAt;
  assert.throws(() => store.consume({ origin: HUB, ip: 'test', challenge: second.challenge }), { code: 'ODOO_PROOF_CHALLENGE_INVALID' });
  assert.throws(() => store.issue({ origin: 'https://untrusted.invalid', ip: 'test' }), { code: 'ODOO_ORIGIN_REQUIRED' });
});

test('challenge maps and per-source rates are bounded without background timers', () => {
  let now = START;
  const store = createOdooOperatorChallenges({ allowedOrigins: [HUB], clock: () => now,
    maxChallenges: 2, maxRateKeys: 2, limitPerMinute: 2 });
  store.issue({ origin: HUB, ip: 'one' });
  store.issue({ origin: HUB, ip: 'one' });
  assert.throws(() => store.issue({ origin: HUB, ip: 'one' }), { code: 'ODOO_AUTH_RATE_LIMITED' });
  assert.throws(() => store.issue({ origin: HUB, ip: 'two' }), { code: 'ODOO_AUTH_RATE_LIMITED' });
  assert.throws(() => store.issue({ origin: HUB, ip: 'three' }), { code: 'ODOO_AUTH_RATE_LIMITED' });
  now += 60000;
  assert.match(store.issue({ origin: HUB, ip: 'three' }).challenge, /^[A-Za-z0-9_-]{43}$/);
});

test('SSO stays disabled without explicit server configuration and does not inspect proofs', async () => {
  for (const options of [{ odooSsoEnabled: false }, { odooSsoEnabled: 'true' }, { verifyOdooOperatorProof: undefined }]) {
    const f = fixture(options);
    assert.equal((await f.invoke(CHALLENGE_PATH)).res.payload.code, 'ODOO_SSO_DISABLED');
    assert.equal((await f.invoke(TOKEN_PATH)).res.payload.code, 'ODOO_SSO_DISABLED');
    assert.equal(f.verifications.length, 0);
  }
});

test('SSO endpoints require exact approved Origin, JSON, no queries and an exact request schema', async () => {
  const f = fixture();
  for (const options of [{ origin: null }, { origin: 'https://untrusted.invalid' }, { origin: HUB + '/' }]) {
    assert.equal((await f.invoke(CHALLENGE_PATH, options)).res.statusCode, 403);
  }
  for (const options of [{ body: [] }, { body: null }, { body: { uid: 1 } },
    { headers: { 'content-type': 'text/plain' } }, { headers: { 'content-type': 'application/jsonp' } }]) {
    assert.equal((await f.invoke(CHALLENGE_PATH, options)).res.statusCode, 400);
  }
  assert.equal((await f.invoke(CHALLENGE_PATH + '?origin=' + encodeURIComponent(HUB))).res.statusCode, 400);
  const nonce = await f.challenge();
  for (const body of [{ challenge: nonce.challenge, proofId: '91' }, { challenge: nonce.challenge, proofId: 0 },
    { challenge: nonce.challenge, proofId: 91, uid: 1 }, { challenge: nonce.challenge, proofId: 91, scopes: ['ai:write'] },
    { challenge: nonce.challenge, proofId: 91, previousToken: {} }, { proofId: 91 },
    { challenge: 'x'.repeat(44), proofId: 91 }]) {
    assert.equal((await f.invoke(TOKEN_PATH, { body })).res.statusCode, 400);
  }
  assert.equal(f.verifications.length, 0);
});

test('fresh Odoo proof produces a signed ten-minute non-SUDO operator grant', async () => {
  const f = fixture(), nonce = await f.challenge();
  const { res } = await f.invoke(TOKEN_PATH, { body: { challenge: nonce.challenge, proofId: 91 } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(f.verifications, [{ proofId: 91, digest: sha(nonce.challenge), issuedAt: START, expiresAt: START + 45000 }]);
  const value = res.payload, claims = f.auth.verifyToken(value.token, { expectedOrigin: HUB });
  assert.equal(claims.source, 'odoo');
  assert.equal(claims.odooUid, 42);
  assert.equal(claims.profile, 'Odoo operator');
  assert.equal(claims.exp, START + 600000);
  assert.equal(claims.authExpiresAt, claims.exp);
  assert.deepEqual(value.scopes, [...ODOO_OPERATOR_SCOPES]);
  assert.equal(value.source, 'odoo'); assert.equal(value.odooUid, 42);
  assert.match(value.operatorDeviceId, /^web_[a-f0-9]{32}::tab_[a-f0-9]{24}$/);
  assert.equal(JSON.stringify(claims).includes(nonce.challenge), false);
  assert.equal(JSON.stringify(claims).includes(sha(nonce.challenge)), false);
});

test('the challenge is consumed before asynchronous proof lookup so replay cannot duplicate grants', async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const f = fixture({ verifier: async () => {
    entered.resolve(); await release.promise;
    return { uid: 42, scopes: ['ai:draft'] };
  } });
  const nonce = await f.challenge();
  const body = { challenge: nonce.challenge, proofId: 91 };
  const pending = f.invoke(TOKEN_PATH, { body });
  await entered.promise;
  const replay = await f.invoke(TOKEN_PATH, { body });
  assert.equal(replay.res.statusCode, 401);
  assert.equal(replay.res.payload.code, 'ODOO_PROOF_CHALLENGE_INVALID');
  assert.equal(f.verifications.length, 1);
  release.resolve();
  assert.equal((await pending).res.statusCode, 200);
});

test('concurrent Odoo lookups are bounded and completed verification frees admission', async t => {
  const release = Promise.withResolvers(), entered = Promise.withResolvers();
  let count = 0;
  const f = fixture({ verifier: async () => {
    count++; if (count === 16) entered.resolve();
    await release.promise;
    return { uid: 42, scopes: ['ai:draft'] };
  } });
  t.after(() => release.resolve());
  const pending = [];
  for (let i = 0; i < 16; i++) {
    const nonce = await f.challenge();
    pending.push(f.invoke(TOKEN_PATH, { body: { challenge: nonce.challenge, proofId: i + 1 } }));
  }
  await entered.promise;
  const blocked = await f.issue();
  assert.equal(blocked.res.statusCode, 429);
  assert.equal(blocked.res.payload.code, 'ODOO_AUTH_RATE_LIMITED');
  assert.equal(f.verifications.length, 16);
  release.resolve();
  for (const result of await Promise.all(pending)) assert.equal(result.res.statusCode, 200);
  assert.equal((await f.issue()).res.statusCode, 200);
});

test('failed, late or unauthorized proofs cannot be reused and never expose verifier details', async () => {
  for (const verifier of [() => null, () => ({ uid: 0, scopes: ['ai:draft'] }),
    () => ({ uid: 42, scopes: ['ai:write'] }), () => ({ uid: 42, scopes: [] }),
    () => ({ uid: 42, scopes: ['ai:draft', 'ai:draft'] }),
    () => ({ uid: 42, scopes: ['settings:write'] }),
    () => { throw Error('private upstream credential'); }]) {
    const f = fixture({ verifier }), nonce = await f.challenge();
    const body = { challenge: nonce.challenge, proofId: 91 };
    const first = await f.invoke(TOKEN_PATH, { body });
    assert.ok([403, 503].includes(first.res.statusCode));
    assert.equal(JSON.stringify(first.res.payload).includes('private'), false);
    assert.equal((await f.invoke(TOKEN_PATH, { body })).res.payload.code, 'ODOO_PROOF_CHALLENGE_INVALID');
    assert.equal(f.verifications.length, 1);
  }
  const late = fixture({ verifier: () => { late.at(START + 45000); return { uid: 42, scopes: ['ai:draft'] }; } });
  assert.equal((await late.issue()).res.payload.code, 'ODOO_PROOF_CHALLENGE_INVALID');
});

test('fresh proof renews the same verified Odoo identity and expiry without broadening scopes', async () => {
  let scopes = [...ODOO_OPERATOR_SCOPES];
  const f = fixture({ verifier: () => ({ uid: 42, scopes }) });
  const first = (await f.issue()).res.payload;
  f.at(START + 480000); scopes = ['ai:draft'];
  const renewed = (await f.issue({ previousToken: first.token })).res.payload;
  assert.equal(renewed.operatorDeviceId, first.operatorDeviceId);
  assert.equal(renewed.expiresAt, START + 480000 + 600000);
  assert.deepEqual(renewed.scopes, ['ai:draft']);
  const claims = f.auth.verifyToken(renewed.token, { expectedOrigin: HUB });
  assert.equal(claims.grantIssuedAt, START + 480000);
  assert.notEqual(claims.jti, claimsOf(first.token).jti);
  assert.equal(f.verifications.length, 2);
  const refreshed = await f.invoke('/api/operator-browser-auth/refresh', {
    headers: { authorization: `Bearer ${renewed.token}` }
  });
  assert.equal(refreshed.res.payload.code, 'ODOO_PROOF_REQUIRED');
});

test('expired Odoo grants cannot act; only fresh proof may briefly recover their prior identity', async () => {
  const f = fixture(), first = (await f.issue()).res.payload;
  f.at(START + 600000);
  assert.throws(() => f.auth.verifyToken(first.token, { expectedOrigin: HUB }), { code: 'BROWSER_CAPABILITY_EXPIRED' });
  assert.equal((await f.guard('/api/ai-mode/draft', first.token, { method: 'POST' })).res.statusCode, 401);
  const recovered = await f.issue({ previousToken: first.token });
  assert.equal(recovered.res.statusCode, 200);
  assert.equal(recovered.res.payload.operatorDeviceId, first.operatorDeviceId);
  f.at(START + 900000);
  assert.equal((await f.issue({ previousToken: first.token })).res.payload.code, 'BROWSER_CAPABILITY_EXPIRED');
});

test('proof renewal refuses account switching, foreign origins and profile-token confusion', async () => {
  let uid = 42;
  const f = fixture({ verifier: () => ({ uid, scopes: ['ai:draft'] }) });
  const first = (await f.issue()).res.payload;
  uid = 43;
  assert.equal((await f.issue({ previousToken: first.token })).res.payload.code, 'ODOO_OPERATOR_CHANGED');
  assert.equal((await f.issue({ previousToken: first.token, origin: OTHER_HUB })).res.payload.code, 'BROWSER_ORIGIN_MISMATCH');
  const legacyClaims = { ...claimsOf(first.token), profile: 'Smart handicrafts', scopes: ['ai:write'] };
  delete legacyClaims.source; delete legacyClaims.odooUid;
  assert.equal((await f.issue({ previousToken: sign(legacyClaims) })).res.payload.code, 'ODOO_OPERATOR_CHANGED');
});

test('Odoo grants allow only scoped call, mail, contact, document and SH AI operations', async () => {
  const f = fixture(), token = (await f.issue()).res.payload.token;
  for (const [path, method] of [
    ['/api/whatsapp-calls/config', 'GET'], ['/api/whatsapp-calls/events', 'GET'],
    ['/api/whatsapp-calls/provider-id', 'GET'], ['/api/whatsapp-calls/accept', 'POST'],
    ['/api/whatsapp-calls/terminate', 'POST'], ['/api/odoo/call-log/update-note', 'POST'],
    ['/api/operator-devices/heartbeat', 'POST'], ['/api/operator-call-transfer/request', 'POST'],
    ['/api/operator-call-transfer/status', 'GET'], ['/api/zoho-mail/messages', 'GET'],
    ['/api/zoho-mail/message/123456', 'GET'], ['/api/zoho-mail/reply', 'POST'],
    ['/api/odoo-documents/tree', 'GET'], ['/api/odoo-documents/file/42', 'GET'],
    ['/api/odoo-documents/share', 'POST'], ['/api/ai-mode/draft', 'POST'], ['/api/ai-mode/product-suggestions', 'POST'],
    ['/api/ai-mode', 'GET'], ['/api/ai-mode', 'POST'], ['/api/push/subscribe', 'POST'],
    ['/api/google-contacts/search', 'GET'], ['/api/google-contacts/import-to-odoo', 'POST']
  ]) {
    const { req, res } = await f.guard(path, token, { method,
      body: { deviceId: 'spoofed', operator_name: 'SUDO' } });
    assert.equal(res.next, 1, `${method} ${path}: ${JSON.stringify(res.payload)}`);
    assert.equal(req.operatorAuth.kind, 'browser');
    assert.equal(req.operatorAuth.source, 'odoo');
    assert.equal(req.operatorAuth.odooUid, 42);
    assert.equal(req.body.operator_name, 'Odoo operator');
    assert.equal(req.body.deviceId, claimsOf(token).baseDeviceId);
  }
  for (const [path, method] of [
    ['/api/ai-mode', 'PUT'], ['/api/ai-mode/global', 'POST'], ['/api/ai-mode/status', 'GET'], ['/api/ai-mode/chat', 'POST'],
    ['/api/ai-mode/draft', 'GET'], ['/api/ai-mode/product-suggestions', 'GET'],
    ['/api/whatsapp-calls/diagnostics', 'GET'], ['/api/whatsapp-calls/admin', 'GET'],
    ['/api/whatsapp-calls/test', 'POST'], ['/api/debug/webhooks', 'GET'], ['/api/push/test', 'POST'],
    ['/api/odoo/partners', 'POST'], ['/api/labels', 'GET'], ['/zoho/auth', 'GET'],
    ['/api/zoho-mail/admin', 'POST'], ['/api/odoo-documents/share', 'DELETE']
  ]) {
    const { res } = await f.guard(path, token, { method });
    assert.equal(res.statusCode, 403, `${method} ${path}`);
    assert.equal(res.next, 0);
  }
  assert.equal(f.verifications.length, 1, 'ordinary protected actions use the signed grant without another Odoo RPC');
});

test('SH AI settings and inference require separate scopes, and repeat proofs share the same quota identity', async () => {
  const f = fixture({ verifier: () => ({ uid: 42, scopes: ['ai:draft'] }) });
  const first = (await f.issue()).res.payload, second = (await f.issue()).res.payload;
  assert.equal(first.baseDeviceId, second.baseDeviceId);
  assert.notEqual(first.operatorSessionId, second.operatorSessionId);
  assert.equal((await f.guard('/api/ai-mode/draft', first.token, { method: 'POST' })).res.next, 1);
  assert.equal((await f.guard('/api/ai-mode/product-suggestions', first.token, { method: 'POST' })).res.next, 1);
  for (const method of ['GET', 'POST']) {
    const settings = await f.guard('/api/ai-mode', first.token, { method });
    assert.equal(settings.res.payload.code, 'OPERATOR_SCOPE_REQUIRED');
  }
});

test('removed Odoo scopes cannot be exercised with a still unexpired capability', async () => {
  let current = ['ai:draft', 'ai:settings'];
  const verifier = Object.assign(async () => ({ uid: 42, scopes: current }), { scopesFor: () => current });
  const f = fixture({ verifyOdooOperatorProof: verifier });
  const { token } = (await f.issue()).res.payload;
  current = ['ai:draft'];
  assert.equal((await f.guard('/api/ai-mode', token)).res.payload.code, 'OPERATOR_SCOPE_REQUIRED');
  assert.equal((await f.guard('/api/ai-mode/draft', token, { method: 'POST' })).res.next, 1);
  assert.equal(f.verifications.length, 0, 'existing grants should not trigger another Odoo verification');
});

test('scope, signature and source checks prevent Odoo elevation and require mail scope for emailed documents', async () => {
  const f = fixture(), token = (await f.issue()).res.payload.token, claims = claimsOf(token);
  for (const delta of [{ profile: 'SUDO' }, { scopes: ['ai:write'] }, { scopes: ['erp:write'] },
    { odooUid: '42' }, { source: 'unknown' }, { authExpiresAt: START + 600001 }]) {
    assert.throws(() => f.auth.verifyToken(sign({ ...claims, ...delta }), { expectedOrigin: HUB }), { code: 'INVALID_BROWSER_CAPABILITY' });
  }
  assert.equal((await f.guard('/api/ai-mode/draft', token.slice(0, -2) + 'xx', { method: 'POST' })).res.statusCode, 401);
  assert.equal((await f.guard('/api/ai-mode/draft', token, { method: 'POST', origin: OTHER_HUB })).res.statusCode, 403);
  const docs = sign({ ...claims, scopes: ['documents:write'] });
  assert.equal((await f.guard('/api/odoo-documents/share', docs, { method: 'POST', body: { channel: 'email' } })).res.payload.code, 'OPERATOR_SCOPE_REQUIRED');
  const disabled = fixture({ odooSsoEnabled: false });
  assert.throws(() => disabled.auth.verifyToken(token, { expectedOrigin: HUB }), { code: 'ODOO_SSO_DISABLED' });
});
