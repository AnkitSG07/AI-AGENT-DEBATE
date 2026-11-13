'use strict';
// The full Hub and the installed APK's history transport run in Chromium.
// Only Android's final native reply and external HTTP routes are simulated.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { launch, finish, fixture, messagesFor } = require('./workflow-harness.cjs');
const { Simulator } = require('./odoo-render-simulator.cjs');

const backend = 'https://ai-agent-debate.onrender.com';
const historyScript = fs.readFileSync(path.resolve(__dirname,
  '../../../../android/operatorhub/app/src/main/assets/sh-native-hub-read.js'), 'utf8');
const challengePath = '/api/operator-browser-auth/android/challenge';
const tokenPath = '/api/operator-browser-auth/android/token';
const draftPath = '/api/ai-mode/draft';
const mailPath = '/api/zoho-mail/status';
const documentPath = '/api/odoo-documents/tree';
const sendPath = '/api/zoho-mail/send';
const proofPath = challenge => `/api/whatsapp-calls/recent?operator_device_id=sh_proof_${challenge}`;
const scopes = ['mail:read', 'mail:write', 'documents:read', 'documents:write', 'ai:draft'];
const baseDeviceId = `web_${'a'.repeat(32)}`;
const operatorSessionId = `tab_${'b'.repeat(24)}`;

test.before(launch);
test.after(finish);

async function accessFixture({ native = true, nativeStatus = 200, holdProof = false, revokeWrite = false } = {}) {
  const simulator = new Simulator();
  simulator.models['mail.message'].push(...messagesFor(103));
  const seen = { challenges: [], exchanges: [], protected: [], legacy: 0, directHistory: [] };
  const protectedPaths = new Set([draftPath, mailPath, documentPath, sendPath]);
  const initScript = native ? `
    window.nativeReads = [];
    window.finishNativeRead = function (request, status) {
      window.dispatchEvent(new CustomEvent('sh-native-call-read', { detail: {
        requestId: request.requestId, status, body: status === 200 ? { ok: true, calls: [] }
          : { ok: false, error: 'Synthetic native history failure' }
      } }));
    };
    window.SHNative = { postMessage(message) {
      const request = JSON.parse(message);
      if (request.type !== 'hub-call-read') return;
      window.nativeReads.push(request);
      if (${holdProof} && request.path.includes('operator_device_id=sh_proof_')) return;
      const status = request.path.includes('operator_device_id=sh_proof_') ? ${nativeStatus} : 200;
      queueMicrotask(() => window.finishNativeRead(request, status));
    } };
    ${historyScript}
  ` : '';
  const f = await fixture({ initScript, services: async (route, url, req) => {
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.origin === backend && url.pathname === challengePath) {
      const challenge = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
      seen.challenges.push({ method: req.method(), body: req.postDataJSON(), challenge, verifier });
      await json({ ok: true, challenge, verifier, expiresAt: Date.now() + 45000 });
      return true;
    }
    if (url.origin === backend && url.pathname === tokenPath) {
      const token = `shb1.${randomBytes(48).toString('base64url')}.${randomBytes(32).toString('base64url')}`;
      seen.exchanges.push({ method: req.method(), body: req.postDataJSON(), token });
      const expiresAt = Date.now() + 600000;
      await json({ ok: true, token, expiresAt, authExpiresAt: expiresAt, source: 'android', scopes,
        operatorDeviceId: `${baseDeviceId}::${operatorSessionId}`, baseDeviceId, operatorSessionId });
      return true;
    }
    if (url.origin === backend && url.pathname === '/api/whatsapp-calls/recent' && url.searchParams.get('operator_device_id')?.startsWith('sh_proof_')) {
      seen.directHistory.push(req.url());
      await json({ ok: false }, 403);
      return true;
    }
    if (url.origin === backend && protectedPaths.has(url.pathname)) {
      const authorization = req.headers().authorization;
      seen.protected.push({ path: url.pathname, method: req.method(), authorization });
      if (authorization !== `Bearer ${seen.exchanges.at(-1)?.token}`) await json({ ok: false }, 401);
      else if (revokeWrite && url.pathname === sendPath)
        await json({ ok: false, code: 'ANDROID_CAPABILITY_REVOKED' }, 403);
      else if (url.pathname === draftPath) {
        const { channelId } = req.postDataJSON();
        await json({ ok: true, channelId, draft: 'Thanks for asking. What size would you like?' });
      } else await json({ ok: true });
      return true;
    }
    if (url.origin === backend && url.pathname === '/operator-auth') seen.legacy++;
    return simulator.route(route, url, req);
  } });
  return { ...f, simulator, seen };
}

function fetchProtected(page, paths) {
  return page.evaluate(async ({ origin, paths }) => Promise.all(paths.map(async path => {
    try {
      const response = await fetch(origin + path, path.endsWith('/send')
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' } : undefined);
      return { status: response.status };
    } catch (error) {
      return { blocked: true, code: error.code || '' };
    }
  })), { origin: backend, paths });
}

function nativeProofs(page) {
  return page.evaluate(() => (window.nativeReads || []).filter(read => read.path.includes('operator_device_id=sh_proof_')));
}

async function assertExchange(f, index = 0) {
  const { method, body, challenge, verifier } = f.seen.challenges[index];
  assert.equal(method, 'POST');
  assert.deepEqual(body, {});
  const proof = (await nativeProofs(f.page))[index];
  assert.deepEqual(Object.keys(proof).sort(), ['path', 'requestId', 'type']);
  assert.equal(proof.type, 'hub-call-read');
  assert.match(proof.requestId, /^[a-f0-9-]{36}$/);
  assert.equal(proof.path, proofPath(challenge));
  assert.ok(!proof.path.includes(verifier));
  const exchange = f.seen.exchanges[index];
  assert.equal(exchange.method, 'POST');
  assert.deepEqual(exchange.body, { challenge, verifier });
  assert.deepEqual(f.seen.directHistory, []);
  return exchange.token;
}

test('AI draft on an existing enrolled APK proves the device without opening a password window', async () => {
  const f = await accessFixture();
  try {
    await f.page.evaluate(() => __hubUiTest.selectChannel(103));
    assert.equal(await f.page.evaluate(() => window.SHNativeHistory.protocol), 'sh-call-history-v1');
    assert.equal(f.seen.challenges.length, 0);
    await f.page.locator('#shAiDraftBtn').click();
    await f.page.waitForFunction(() => !__hubUiTest.state.aiDraftRequest);
    assert.match(await f.page.locator('#shAiModeBody').innerText(), /What size would you like/);
    const token = await assertExchange(f);
    assert.equal(f.seen.challenges.length, 1);
    assert.equal(f.seen.exchanges.length, 1);
    assert.deepEqual(f.seen.protected, [{ path: draftPath, method: 'POST', authorization: `Bearer ${token}` }]);
    assert.equal(f.seen.legacy, 0);
    assert.equal(await f.page.locator('#shMessageInput').inputValue(), '');
    assert.equal(f.simulator.calls.filter(call => call.method === 'message_post').length, 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('concurrent mail and documents share one challenge, native proof and exchange', async () => {
  const f = await accessFixture();
  try {
    assert.deepEqual(await fetchProtected(f.page, [mailPath, documentPath]), [{ status: 200 }, { status: 200 }]);
    const token = await assertExchange(f);
    assert.equal(f.seen.challenges.length, 1);
    assert.equal((await nativeProofs(f.page)).length, 1);
    assert.equal(f.seen.exchanges.length, 1);
    assert.deepEqual(f.seen.protected.map(item => item.path).sort(), [documentPath, mailPath].sort());
    assert.ok(f.seen.protected.every(item => item.authorization === `Bearer ${token}`));
    assert.equal(f.seen.legacy, 0);
  } finally { await f.close(); }
});

test('the ordinary website does not attempt to authenticate as an enrolled Android device', async () => {
  const f = await accessFixture({ native: false });
  try {
    assert.equal((await fetchProtected(f.page, [mailPath]))[0].blocked, true);
    assert.equal(f.seen.challenges.length + f.seen.exchanges.length + f.seen.protected.length + f.seen.legacy, 0);
  } finally { await f.close(); }
});

test('an unenrolled device leaves the current reply intact and does not open legacy sign-in', async () => {
  const f = await accessFixture({ nativeStatus: 401 });
  try {
    await f.page.evaluate(() => __hubUiTest.selectChannel(103));
    await f.page.locator('#shMessageInput').fill('My original reply');
    await f.page.locator('#shAiDraftBtn').click();
    await f.page.waitForFunction(() => !__hubUiTest.state.aiDraftRequest);
    assert.match(await f.page.locator('#shAiModeBody').innerText(), /enroll|app settings/i);
    assert.equal(await f.page.locator('#shMessageInput').inputValue(), 'My original reply');
    assert.equal(await f.page.locator('#shAiModeUseBtn').isDisabled(), true);
    assert.equal(f.seen.challenges.length, 1);
    assert.equal((await nativeProofs(f.page)).length, 1);
    assert.equal(f.seen.exchanges.length + f.seen.protected.length + f.seen.legacy, 0);
  } finally { await f.close(); }
});

test('closing a draft while native proof is pending prevents the stale draft from being sent', async () => {
  const f = await accessFixture({ holdProof: true });
  try {
    await f.page.evaluate(() => __hubUiTest.selectChannel(103));
    await f.page.locator('#shAiDraftBtn').click();
    await f.page.waitForFunction(() => window.nativeReads.some(r => r.path.includes('operator_device_id=sh_proof_')));
    await f.page.locator('#shAiModePanelClose').click();
    await f.page.evaluate(() => {
      const request = window.nativeReads.find(r => r.path.includes('operator_device_id=sh_proof_'));
      window.finishNativeRead(request, 200);
    });
    assert.deepEqual(await fetchProtected(f.page, [mailPath]), [{ status: 200 }]);
    assert.deepEqual(f.seen.protected.map(item => item.path), [mailPath]);
    assert.equal(f.seen.legacy, 0);
    assert.equal(await f.page.locator('#shAiModePanel').isVisible(), false);
  } finally { await f.close(); }
});

test('a revoked Android grant does not replay a write, and the next explicit operation can reconnect', async () => {
  const f = await accessFixture({ revokeWrite: true });
  try {
    assert.deepEqual(await fetchProtected(f.page, [sendPath]), [{ status: 403 }]);
    const oldToken = await assertExchange(f);
    assert.deepEqual(f.seen.protected, [{ path: sendPath, method: 'POST', authorization: `Bearer ${oldToken}` }]);
    assert.equal(f.seen.challenges.length, 1);
    assert.equal(await f.page.evaluate(() => window.SHOperatorAuth.connected()), false);
    assert.deepEqual(await fetchProtected(f.page, [mailPath]), [{ status: 200 }]);
    const newToken = await assertExchange(f, 1);
    assert.notEqual(oldToken, newToken);
    assert.deepEqual(f.seen.protected.map(item => item.path), [sendPath, mailPath]);
    assert.equal(f.seen.challenges.length, 2);
    assert.equal(f.seen.exchanges.length, 2);
    assert.equal(f.seen.legacy, 0);
  } finally { await f.close(); }
});
