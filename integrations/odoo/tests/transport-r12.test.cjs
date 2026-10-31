const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { androidDir, backendDir } = require('./source-paths.cjs');
const { chromium } = require(process.env.SH_PLAYWRIGHT_MODULE || 'playwright');
const native = fs.readFileSync(path.join(androidDir, 'app/src/main/assets/sh-native-hub-read.js'), 'utf8');
const auth = fs.readFileSync(path.join(backendDir, 'public/operator-browser-auth.js'), 'utf8');
const HUB = 'https://www.smarthandicrafts.com/livechat-api-test', API = 'https://ai-agent-debate.onrender.com';
let browser;
test.before(async () => { browser = await chromium.launch({ headless: true, executablePath: process.env.SH_TEST_CHROMIUM, args: ['--no-sandbox'] }); });
test.after(async () => { await browser?.close(); });
async function harness({ nativeBridge = false, pageUrl = HUB, tokenLifetime = 600000, popup = 'success', handle, manualStream = false } = {}) {
  const context = await browser.newContext(), requests = [];
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === API && url.pathname === '/operator-auth') {
      const state = url.searchParams.get('state'), origin = url.searchParams.get('origin');
      const body = `<!doctype html><meta charset="utf-8"><title>Mock authorized call sign-in</title><script>
        window.receivedContext = null;
        addEventListener('message', event => {
          if(event.origin !== ${JSON.stringify(origin)} || event.source !== opener || event.data.state !== ${JSON.stringify(state)}) return;
          receivedContext = event.data;
          opener.postMessage({type:'test-transport-context',previousToken:event.data.previousToken},${JSON.stringify(origin)});
          ${popup === 'success' ? `opener.postMessage({type:'sh-operator-browser-auth',state:${JSON.stringify(state)},token:'test-scoped-capability-${'x'.repeat(48)}',expiresAt:Date.now()+${tokenLifetime},authExpiresAt:Date.now()+7200000,operatorDeviceId:'browser_test::session_test'},${JSON.stringify(origin)});` : ''}
        });
        opener.postMessage({type:'sh-operator-auth-ready',state:${JSON.stringify(state)}},${JSON.stringify(origin)});
      </script>`;
      return route.fulfill({ status: 200, contentType: 'text/html', body });
    }
    if (request.isNavigationRequest()) return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><button id="connect">Connect</button>' });
    requests.push({ url: request.url(), method: request.method(), headers: request.headers(), body: request.postData() });
    if (handle && await handle(route, requests)) return;
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ ok: true, network: true }) });
  });
  const page = await context.newPage();
  await page.goto(pageUrl);
  await page.evaluate(() => {
    window.nativeMessages = [];
    window.authContexts = []; addEventListener('message', event => { if (event.data?.type === 'test-transport-context') authContexts.push(event.data.previousToken); });
    window.SHNative = { postMessage: message => nativeMessages.push(JSON.parse(message)) };
    const open = window.open.bind(window); window.open = (...args) => (window.lastPopup = open(...args));
  });
  if (nativeBridge) await page.addScriptTag({ content: native });
  if (manualStream) await page.evaluate(() => {
    const original = fetch; window.streamCancelled = false;
    window.fetch = (input, options) => {
      if (new URL(String(input), location.href).pathname === '/api/whatsapp-calls/events') {
        window.streamAuthorization = new Headers(options.headers).get('Authorization');
        return Promise.resolve(new Response(new ReadableStream({
          start(controller) { window.streamController = controller; }, cancel() { window.streamCancelled = true; }
        }), { headers: { 'Content-Type':'text/event-stream' } }));
      }
      return original(input, options);
    };
  });
  await page.addScriptTag({ content: auth });
  await page.evaluate(() => document.getElementById('connect').onclick = () => {
    window.connectResult = null;
    window.SHOperatorAuth?.connect().then(() => window.connectResult = 'connected', error => window.connectResult = error.message);
  });
  return { context, page, requests, async close() { await context.close(); } };
}
async function connect(h) {
  await h.page.locator('#connect').click();
  await h.page.waitForFunction(() => window.connectResult === 'connected');
}
test('native call history crosses only the typed bridge, with no bearer or network request', async () => {
  const h = await harness({ nativeBridge: true });
  await h.page.evaluate(() => { window.readResult = fetch('https://ai-agent-debate.onrender.com/api/whatsapp-calls/logs?limit=40').then(r => r.json()); });
  const message = await h.page.evaluate(() => nativeMessages[0]);
  assert.equal(message.type, 'hub-call-read'); assert.equal(message.path, '/api/whatsapp-calls/logs?limit=40');
  assert.deepEqual(Object.keys(message).sort(), ['path', 'requestId', 'type']);
  await h.page.evaluate(m => dispatchEvent(new CustomEvent('sh-native-call-read', { detail: { requestId: m.requestId, status: 200, body: { ok: true, calls: [] } } })), message);
  assert.deepEqual(await h.page.evaluate(() => readResult), { ok: true, calls: [] });
  assert.equal(h.requests.length, 0); await h.close();
});
test('native history bridge cannot turn a POST into an authenticated native call action', async () => {
  const h = await harness({ nativeBridge: true });
  const result = await h.page.evaluate(async () => {
    try { await fetch('https://ai-agent-debate.onrender.com/api/whatsapp-calls/terminate', { method: 'POST', body: '{}' }); }
    catch (e) { return { code: e.code, sent: nativeMessages.length }; }
  });
  assert.equal(result.code, 'OPERATOR_AUTH_REQUIRED'); assert.equal(result.sent, 0); assert.equal(h.requests.length, 0); await h.close();
});
test('call bridge and browser auth stay disabled on a different Odoo page', async () => {
  const h = await harness({ nativeBridge: true, pageUrl: 'https://www.smarthandicrafts.com/shop' });
  assert.deepEqual(await h.page.evaluate(() => [!!window.SHOperatorAuth, !!window.SHNativeHistory]), [false, false]);
  await h.page.evaluate(() => fetch('https://ai-agent-debate.onrender.com/api/whatsapp-calls/logs'));
  assert.equal(h.requests.length, 1); assert.equal(await h.page.evaluate(() => nativeMessages.length), 0); await h.close();
});
test('aborted native history rejects once and ignores its late response', async () => {
  const h = await harness({ nativeBridge: true });
  await h.page.evaluate(() => {
    const control = new AbortController();
    window.readResult = fetch('https://ai-agent-debate.onrender.com/api/whatsapp-calls/incoming', { signal: control.signal }).catch(e => e.name);
    control.abort();
    const message = nativeMessages[0];
    dispatchEvent(new CustomEvent('sh-native-call-read', { detail: { requestId: message.requestId, status: 200, body: { ok: true } } }));
  });
  assert.equal(await h.page.evaluate(() => readResult), 'AbortError'); await h.close();
});
test('native history limits pending work and cancels it when the page leaves', async () => {
  const h = await harness({ nativeBridge: true });
  const result = await h.page.evaluate(async () => {
    const jobs = Array.from({ length: 7 }, () => fetch('https://ai-agent-debate.onrender.com/api/whatsapp-calls/logs').catch(e => e.name));
    dispatchEvent(new Event('pagehide'));
    return { count: nativeMessages.length, results: await Promise.all(jobs) };
  });
  assert.equal(result.count, 6); assert.equal(result.results.filter(x => x === 'AbortError').length, 6); assert.equal(result.results[6], 'Error'); await h.close();
});
test('native read installation is idempotent and keeps unrelated Odoo RPC unchanged', async () => {
  const h = await harness({ nativeBridge: true }); await h.page.addScriptTag({ content: native });
  await h.page.evaluate(() => fetch('/web/session/get_session_info', { method: 'POST', body: '{}' }));
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].headers.authorization, undefined);
  assert.equal(await h.page.evaluate(() => nativeMessages.length), 0); await h.close();
});
test('unauthenticated browser controls fail before network; only public configuration is fetched', async () => {
  const h = await harness();
  assert.equal(await h.page.evaluate(async () => {
    try { await fetch('https://ai-agent-debate.onrender.com/api/whatsapp-calls/outgoing', { method: 'POST' }); }
    catch (e) { return e.code; }
  }), 'OPERATOR_AUTH_REQUIRED');
  await h.page.evaluate(() => fetch('https://ai-agent-debate.onrender.com/api/whatsapp-calls/config'));
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].headers.authorization, undefined); await h.close();
});
test('verified popup handshake authorizes exact call origin without putting a bearer in storage or URLs', async () => {
  const h = await harness(); await connect(h);
  await h.page.evaluate(() => fetch('https://ai-agent-debate.onrender.com/api/whatsapp-calls/reject', { method: 'POST', body: '{}' }));
  assert.equal(h.requests.length, 1); assert.match(h.requests[0].headers.authorization, /^Bearer test-scoped-capability-/);
  assert.ok(!h.requests[0].url.includes('capability'));
  assert.deepEqual(await h.page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
  assert.equal((await h.page.evaluate(() => SHOperatorAuth.identity())).operatorDeviceId, 'browser_test::session_test');
  await h.page.evaluate(() => fetch('/web/session/get_session_info', { method: 'POST', body: '{}' }));
  assert.equal(h.requests[1].headers.authorization, undefined); await h.close();
});
test('wrong origin, wrong source and wrong handshake state cannot authorize a browser', async () => {
  const h = await harness({ popup: 'hold' }); await h.page.locator('#connect').click();
  await h.page.waitForFunction(() => !!window.lastPopup);
  await h.page.evaluate(() => {
    const data = { type: 'sh-operator-browser-auth', state: 'wrong', token: 'x'.repeat(60), expiresAt: Date.now()+600000, operatorDeviceId: 'attacker::id' };
    dispatchEvent(new MessageEvent('message', { origin: 'https://evil.invalid', source: lastPopup, data }));
    dispatchEvent(new MessageEvent('message', { origin: 'https://ai-agent-debate.onrender.com', source: window, data }));
    dispatchEvent(new MessageEvent('message', { origin: 'https://ai-agent-debate.onrender.com', source: lastPopup, data }));
  });
  assert.equal(await h.page.evaluate(() => SHOperatorAuth.connected()), false); assert.equal(h.requests.length, 0); await h.close();
});
test('a rejected control is never replayed, and clears only the capability that made it', async () => {
  const h = await harness({ handle: async route => {
    await route.fulfill({ status: 401, contentType: 'application/json', body: '{"ok":false}' }); return true;
  } }); await connect(h);
  const status = await h.page.evaluate(async () => (await fetch('https://ai-agent-debate.onrender.com/api/whatsapp-calls/accept', { method: 'POST', body: '{}' })).status);
  assert.equal(status, 401); assert.equal(h.requests.length, 1); assert.equal(await h.page.evaluate(() => SHOperatorAuth.connected()), false); await h.close();
});
test('a valid session does not delay End behind a pending renewal round trip', async () => {
  let renewal;
  const h = await harness({ tokenLifetime: 90000, handle: async route => {
    if (route.request().url().endsWith('/refresh')) { renewal = route; return true; } return false;
  } }); await connect(h);
  const result = await h.page.evaluate(async () => (await fetch('https://ai-agent-debate.onrender.com/api/whatsapp-calls/terminate', { method: 'POST', body: '{}' })).json());
  assert.equal(result.network, true); assert.ok(renewal); assert.equal(h.requests.filter(r => r.url.endsWith('/refresh')).length, 1);
  await renewal.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false}' }); await h.close();
});
test('blocked popup yields a usable error without leaking a request or credential', async () => {
  const h = await harness(); await h.page.evaluate(() => window.open = () => null);
  await h.page.locator('#connect').click();
  await h.page.waitForFunction(() => typeof window.connectResult === 'string');
  assert.match(await h.page.evaluate(() => connectResult), /Allow the operator sign-in window/); assert.equal(h.requests.length, 0); await h.close();
});
test('a failed access lease retains only memory-held identity proof for authenticated reconnect', async () => {
  const h = await harness({ handle: async route => { await route.fulfill({ status: 401, contentType: 'application/json', body: '{"ok":false}' }); return true; } });
  await connect(h);
  await h.page.evaluate(() => fetch('https://ai-agent-debate.onrender.com/api/whatsapp-calls/logs'));
  assert.equal(await h.page.evaluate(() => SHOperatorAuth.connected()), false);
  await connect(h);
  const prior = await h.page.evaluate(() => authContexts);
  assert.equal(prior[0], ''); assert.match(prior[1], /^test-scoped-capability-/);
  assert.deepEqual(await h.page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]); await h.close();
});
test('explicit browser call logout erases reconnect identity as well as active authority', async () => {
  const h = await harness(); await connect(h);
  await h.page.evaluate(() => SHOperatorAuth.clear()); await connect(h);
  assert.deepEqual(await h.page.evaluate(() => authContexts), ['', '']); await h.close();
});
test('explicit logout cancels a pending popup and its late success cannot reconnect', async () => {
  const h = await harness({ popup: 'hold' });
  const popupPromise = h.context.waitForEvent('page'); await h.page.locator('#connect').click();
  const popup = await popupPromise; await popup.waitForURL('**/operator-auth?**');
  const state = new URL(popup.url()).searchParams.get('state');
  await h.page.evaluate(state => {
    SHOperatorAuth.clear();
    dispatchEvent(new MessageEvent('message', { origin: 'https://ai-agent-debate.onrender.com', source: lastPopup,
      data: { type:'sh-operator-browser-auth', state, token:'x'.repeat(60), expiresAt:Date.now()+600000,
        authExpiresAt:Date.now()+7200000,operatorDeviceId:'browser_test::session_test' } }));
  }, state);
  assert.equal(await h.page.evaluate(() => SHOperatorAuth.connected()), false);
  assert.equal(await h.page.evaluate(() => connectResult), 'Call sign-in was cancelled.');
  assert.equal(h.requests.length, 0); await h.close();
});
test('browser call hints stream with header authority and no token in the event URL', async () => {
  const h = await harness({ handle: async route => {
    if (!route.request().url().includes('/events')) return false;
    await route.fulfill({ status:200, contentType:'text/event-stream', body:': keepalive\n\nevent: ready\ndata: {"refresh":true}\n\nevent: call-status\ndata: {"call_id":"wa:test-1"}\n\n' }); return true;
  } }); await connect(h);
  const values = await h.page.evaluate(() => new Promise(resolve => {
    const got = [], stream = SHOperatorAuth.openCallEvents('https://ai-agent-debate.onrender.com/api/whatsapp-calls/events?operator_device_id=browser_test%3A%3Asession_test');
    stream.addEventListener('ready', event => got.push(JSON.parse(event.data)));
    stream.addEventListener('call-status', event => got.push(JSON.parse(event.data)));
    stream.onerror = () => { stream.close(); resolve(got); };
  }));
  assert.deepEqual(values, [{ refresh:true }, { call_id:'wa:test-1' }]);
  assert.equal(h.requests.length, 1); assert.match(h.requests[0].headers.authorization, /^Bearer test-scoped-capability-/);
  assert.ok(!h.requests[0].url.includes('token') && !h.requests[0].url.includes('capability')); await h.close();
});
test('explicit call logout closes its event stream and cancels the reader immediately', async () => {
  const h = await harness({ manualStream:true }); await connect(h);
  await h.page.evaluate(() => {
    window.hints = []; window.streamErrors = 0;
    window.stream = SHOperatorAuth.openCallEvents('https://ai-agent-debate.onrender.com/api/whatsapp-calls/events');
    stream.addEventListener('ready', event => hints.push(JSON.parse(event.data)));
    stream.onerror = () => streamErrors++;
  });
  await h.page.waitForFunction(() => !!window.streamController);
  await h.page.evaluate(() => streamController.enqueue(new TextEncoder().encode('event: ready\ndata: {"refresh":true}\n\n')));
  await h.page.waitForFunction(() => hints.length === 1);
  await h.page.evaluate(() => SHOperatorAuth.clear());
  await h.page.waitForFunction(() => streamCancelled);
  assert.equal(await h.page.evaluate(() => streamErrors), 0);
  assert.match(await h.page.evaluate(() => streamAuthorization), /^Bearer test-scoped-capability-/); await h.close();
});
test('event transport rejects a different origin without forwarding a browser credential', async () => {
  const h = await harness(); await connect(h);
  assert.match(await h.page.evaluate(() => { try { SHOperatorAuth.openCallEvents('https://evil.invalid/api/whatsapp-calls/events'); } catch (error) { return error.message; } }), /Unsupported call event stream/);
  assert.equal(h.requests.length, 0); await h.close();
});
