const fs = require('node:fs');
const path = require('node:path');
const { androidDir, backendDir } = require('./source-paths.cjs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const asset = path.join(androidDir, 'app/src/main/assets/sh-call-transfer-guard.js');
const source = fs.readFileSync(asset, 'utf8');
const backend = 'https://ai-agent-debate.onrender.com';
const accept = backend + '/api/whatsapp-calls/accept';
const results = [];

function harness({ href = 'https://www.smarthandicrafts.com/livechat-api-test', frame = false, rootPresent = true } = {}) {
  const calls = [], ids = new Map(), events = new Map(), windowEvents = new Map();
  function node(tag = 'div') {
    const classes = new Set();
    return { tag, id: '', textContent: '', children: [], attributes: {}, disabled: false,
      setAttribute(k, v) { this.attributes[k] = String(v); },
      getAttribute(k) { return Object.hasOwn(this.attributes,k) ? this.attributes[k] : null; },
      removeAttribute(k) { delete this.attributes[k]; },
      classList: { add: value=>classes.add(value), remove: value=>classes.delete(value), contains: value=>classes.has(value), toggle(value,on) { const enabled=on===undefined?!classes.has(value):on; if(enabled)classes.add(value);else classes.delete(value);return enabled; } },
      appendChild(child) { this.children.push(child); if (child.id) ids.set(child.id, child); return child; },
      append(...children) { children.forEach(child => this.appendChild(child)); },
      querySelector() { return ids.get('test-card'); }, closest() { return null; }
    };
  }
  const root = node(); root.id = 'shOperatorApp';
  const button = node('button'); button.id = 'shWhatsappCallTransferBtn';
  const card = node(); card.id = 'test-card';
  const mount = () => { ids.set(root.id, root); ids.set(button.id, button); ids.set(card.id, card); };
  if (rootPresent) mount();
  const document = { head: node('head'), documentElement: node('html'), readyState: 'loading',
    getElementById: id => ids.get(id) || null, createElement: node,
    addEventListener(name, callback, options) { if (!events.has(name)) events.set(name, []); events.get(name).push({ callback, options }); }
  };
  const original = async (input, init) => { calls.push({ input, init }); return new Response('{"ok":true}', { status: 200 }); };
  const ctx = { console, URL, URLSearchParams, Request, Response, Headers, FormData, Blob, ArrayBuffer, Uint8Array, TextDecoder,
    ReadableStream, Promise, Object, JSON, document, location: new URL(href), fetch: original,
    addEventListener(name, callback) { if (!windowEvents.has(name)) windowEvents.set(name, []); windowEvents.get(name).push(callback); } };
  ctx.window = ctx; ctx.top = frame ? {} : ctx;
  vm.createContext(ctx); vm.runInContext(source, ctx);
  return { ctx, calls, ids, events, windowEvents, original, root, button, card, mount,
    rerun() { vm.runInContext(source, ctx); } };
}

async function blocked(response) { assert.equal(response.status, 501); assert.equal((await response.json()).code, 'TRANSFER_MEDIA_NOT_CONFIGURED'); }
async function check(name, test) {
  try { await test(); results.push({ name, passed: true }); console.log('PASS ' + name); }
  catch (error) { results.push({ name, passed: false, error: String(error.stack || error) }); console.log('FAIL ' + name); }
}

(async () => {
  await check('guard runs only in exact trusted Hub main frame', async () => {
    for (const options of [{ href: 'https://www.smarthandicrafts.com/web/login' }, { href: 'https://www.smarthandicrafts.com/livechat-api-test/other' },
      { href: 'https://www.smarthandicrafts.com.attacker.invalid/livechat-api-test' }, { frame: true }]) {
      const h = harness(options); assert.equal(h.ctx.fetch, h.original); assert.equal(h.ctx.__shCallTransferGuardR9, undefined); assert.equal(h.events.size, 0);
    }
    const trailing = harness({ href: 'https://www.smarthandicrafts.com/livechat-api-test/?call_id=123' });
    assert.equal(trailing.ctx.__shCallTransferGuardR9.transferAvailable, false);
  });

  await check('exact transfer request and accept routes are blocked for URL, Request and trailing slash forms', async () => {
    const h = harness();
    for (const endpoint of ['/api/operator-call-transfer/request', '/api/operator-call-transfer/accept/']) {
      for (const input of [backend + endpoint + '?x=1', new URL(backend + endpoint), new Request(backend + endpoint, { method: 'POST', body: '{}' })]) {
        await blocked(await h.ctx.fetch(input, { method: 'POST' }));
      }
    }
    assert.equal(h.calls.length, 0);
  });

  await check('ordinary JSON accept keeps original arguments, headers and body', async () => {
    const h = harness();
    for (const payload of [{ call_id: 'real', sdp: 'offer' }, { call_id: 'real', transfer_id: '' }, { call_id: 'real', transferId: null }]) {
      const init = { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Test': 'same' }, body: JSON.stringify(payload) };
      assert.equal((await h.ctx.fetch(accept, init)).status, 200);
      assert.equal(h.calls.at(-1).input, accept); assert.equal(h.calls.at(-1).init, init);
    }
  });

  await check('nonempty transfer IDs in either JSON alias or query are blocked', async () => {
    const h = harness();
    for (const key of ['transfer_id', 'transferId']) {
      await blocked(await h.ctx.fetch(accept, { method: 'POST', body: JSON.stringify({ [key]: 'tr_old', call_id: 'real' }) }));
      await blocked(await h.ctx.fetch(accept + '?' + key + '=tr_old', { method: 'POST', body: '{}' }));
    }
    assert.equal(h.calls.length, 0);
  });

  await check('FormData and URLSearchParams preserve ordinary bodies and block all duplicate transfer fields', async () => {
    const h = harness();
    for (const Constructor of [FormData, URLSearchParams]) {
      const ordinary = new Constructor(); ordinary.append('call_id', 'real');
      assert.equal((await h.ctx.fetch(accept, { method: 'POST', body: ordinary })).status, 200);
      const unsafe = new Constructor(); unsafe.append('transfer_id', ''); unsafe.append('transfer_id', 'tr_old');
      await blocked(await h.ctx.fetch(accept, { method: 'POST', body: unsafe }));
    }
    await blocked(await h.ctx.fetch(accept, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'call_id=real&transfer_id=tr_old' }));
    assert.equal(h.calls.length, 2);
  });

  await check('Request body is inspected through a clone and never consumed before original fetch', async () => {
    const h = harness();
    const request = new Request(accept, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"call_id":"real"}' });
    assert.equal((await h.ctx.fetch(request)).status, 200);
    assert.equal(request.bodyUsed, false);
    assert.equal(h.calls[0].input, request);
    assert.equal(await request.text(), '{"call_id":"real"}');
    const unsafe = new Request(accept, { method: 'POST', body: '{"transfer_id":"tr_old"}' });
    await blocked(await h.ctx.fetch(unsafe));
    assert.equal(unsafe.bodyUsed, false);
    assert.equal(h.calls.length, 1);
  });

  await check('Request init body overrides are inspected according to the actual supplied body', async () => {
    const h = harness();
    const unsafe = new Request(accept, { method: 'POST', body: '{"transfer_id":"tr_old"}' });
    const normal = new Request(accept, { method: 'POST', body: '{"call_id":"real"}' });
    assert.equal((await h.ctx.fetch(unsafe, { body: '{"call_id":"real"}' })).status, 200);
    await blocked(await h.ctx.fetch(normal, { body: '{"transferId":"tr_old"}' }));
    assert.equal(h.calls.length, 1);
  });

  await check('Blob and byte bodies are inspected; opaque streams and malformed bodies fail closed at accept only', async () => {
    const h = harness();
    for (const body of [new Blob(['{"transfer_id":"tr_old"}'], { type: 'application/json' }), new TextEncoder().encode('{"transferId":"tr_old"}'),
      new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{}')); controller.close(); } }), '{broken', { transfer_id: 'tr_old' }]) {
      await blocked(await h.ctx.fetch(accept, { method: 'POST', body }));
    }
    assert.equal(h.calls.length, 0);
    for (const body of [new Blob(['{"call_id":"real"}']), new TextEncoder().encode('{"call_id":"real"}')]) {
      assert.equal((await h.ctx.fetch(accept, { method: 'POST', body })).status, 200);
    }
    assert.equal(h.calls.length, 2);
  });

  await check('ordinary call controls, legacy cleanup and unrelated origins/routes remain untouched', async () => {
    const h = harness();
    const routes = ['/api/whatsapp-calls/outgoing', '/api/whatsapp-calls/reject', '/api/whatsapp-calls/terminate',
      '/api/operator-call-transfer/cancel', '/api/operator-call-transfer/decline', '/api/operator-call-transfer/status',
      '/api/operator-call-locks/claim', '/api/operator-devices/heartbeat', '/api/operator-call-transfer/request/other'];
    for (const route of routes) {
      const input = backend + route, init = { method: 'POST', body: '{"transfer_id":"old"}' };
      assert.equal((await h.ctx.fetch(input, init)).status, 200); assert.equal(h.calls.at(-1).init, init);
    }
    for (const url of ['https://www.smarthandicrafts.com/api/whatsapp-calls/accept', 'https://ai-agent-debate.onrender.com.attacker.invalid/api/operator-call-transfer/request']) {
      assert.equal((await h.ctx.fetch(url, { method: 'POST', body: '{"transfer_id":"old"}' })).status, 200);
    }
    assert.equal(h.calls.length, routes.length + 2);
  });

  await check('legacy UI actions are captured without blocking ordinary accept and notes are added once', async () => {
    const h = harness();
    assert.equal(h.button.disabled, true); assert.equal(h.button.textContent, 'Transfer unavailable');
    assert(h.ids.has('shNativeTransferUnavailable'));
    const capture = h.events.get('click')[0]; assert.equal(capture.options, true);
    let prevented = 0, stopped = 0;
    const control = { closest: selector => selector === '#shOperatorApp' ? h.root : null };
    capture.callback({ target: { closest: selector => selector.includes('data-whatsapp-call-action') ? control : h.root },
      preventDefault() { prevented++; }, stopImmediatePropagation() { stopped++; } });
    assert.equal(prevented, 1); assert.equal(stopped, 1);
    capture.callback({ target: { closest: selector => selector === '#shOperatorApp' ? h.root : null },
      preventDefault() { prevented++; }, stopImmediatePropagation() { stopped++; } });
    assert.equal(prevented, 1); assert.equal(stopped, 1);
    assert.equal(h.card.children.filter(child => child.id === 'shNativeTransferUnavailable').length, 1);
  });

  await check('guard is idempotent and installs UI after DOM readiness without polling timers', async () => {
    const h = harness({ rootPresent: false }); const wrapped = h.ctx.fetch;
    h.rerun(); assert.equal(h.ctx.fetch, wrapped); assert.equal(h.events.get('click').length, 1);
    h.mount(); h.events.get('DOMContentLoaded')[0].callback();
    assert.equal(h.button.disabled, true);
    assert.doesNotMatch(source, /setInterval|setTimeout/);
    new vm.Script(source);
  });

  process.argv[2] = path.resolve(__dirname, 'fixtures/legacy-r8-call-runtime.html');
  const { makeHarness, pendingTransfer, flush } = require('./test_r7_call_lifecycle.cjs');
  function protectLegacy(h) {
    Object.assign(h.ctx, { URL, URLSearchParams, Request, Response, Headers, FormData, Blob, ArrayBuffer, Uint8Array, TextDecoder });
    h.ctx.location = new URL('https://www.smarthandicrafts.com/livechat-api-test');
    h.ctx.window.top = h.ctx.window;
    h.ctx.document.getElementById = () => null;
    h.ctx.document.addEventListener = () => {};
    h.ctx.AI_MODE_BACKEND_BASE = backend;
    vm.runInContext(source, h.ctx);
    h.ctx.appFetch = (...args) => h.ctx.window.fetch(...args);
  }

  await check('live R8 target acceptance is stopped before microphone, lock takeover or provider accept', async () => {
    const h = makeHarness();
    try {
      protectLegacy(h);
      const transfer = pendingTransfer(h);
      await h.api.pollRecentWhatsappCalls();
      await h.api.pollWhatsappPendingTransfer();
      await h.api.routeWhatsappIncomingAction('accept', h.api.whatsappCallKey(h.server.calls.get(transfer.call_id)));
      await flush();
      assert.equal(h.micRequests, 0);
      assert.equal(h.peers.length, 0);
      assert.equal(h.commands.filter(c => /\/accept$|\/claim$|\/terminate$/.test(c.path)).length, 0);
      assert.equal(h.server.locks.get(transfer.call_id).operator_device_id, transfer.from_device_id);
      assert.equal(h.commands.filter(c => c.path === '/api/operator-call-transfer/decline').length, 1, 'legacy cleanup remains allowed');
    } finally { await h.cleanup(); }
  });

  await check('live R8 source keeps ordinary audio and cannot create a new unsafe invitation', async () => {
    const h = makeHarness();
    try {
      protectLegacy(h);
      const call = h.addCall('wacid.R8_PROTECTED');
      await h.api.pollRecentWhatsappCalls();
      await h.api.routeWhatsappIncomingAction('accept', h.api.whatsappCallKey(call));
      h.peers[0].connect(); await flush();
      const session = h.api.runtime.session;
      h.server.devices = [{ lock_device_id: 'second::session', client_source: 'odoo_operator_hub', status: 'online',
        presence_expires_at: new Date(Date.now() + 60000).toISOString(), receive_calls: true, in_call: false }];
      await h.api.openWhatsappTransferChoices();
      await h.api.requestWhatsappCallTransfer('second::session');
      assert.equal(h.commands.filter(c => c.path === '/api/operator-call-transfer/request').length, 0);
      assert.equal(h.commands.filter(c => c.path === '/api/whatsapp-calls/accept').length, 1);
      assert.equal(session.finished, false); assert.equal(h.state.whatsappCallIsConnected, true);
      assert(h.tracks.every(track => !track.stopped));
      await h.api.endActiveWhatsappCall();
      assert.equal(session.finished, true); assert(h.tracks.every(track => track.stopped));
    } finally { await h.cleanup(); }
  });

  const report = { asset, sha256: crypto.createHash('sha256').update(source).digest('hex'),
    all_actions_synthetic: true, live_calls_or_production_mutations: false,
    count: results.length, passed: results.filter(r => r.passed).length, failed: results.filter(r => !r.passed).length,
    completed_at: new Date().toISOString(), results };
  fs.writeFileSync(path.join(__dirname, 'android-transfer-guard-results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, failed: report.failed, sha256: report.sha256 }));
  if (report.failed) process.exitCode = 1;
})();
