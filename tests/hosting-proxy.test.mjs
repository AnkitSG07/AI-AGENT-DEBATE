import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createHostingProxy, readHostingProxyConfig } from '../scripts/hosting-proxy.mjs';

const env = { APP_URL: 'https://ai-agent-debate.onrender.com', RENDER_EXTERNAL_HOSTNAME: 'ai-agent-debate.onrender.com',
  SH_HOSTING_PROXY_UPSTREAM: 'https://sh-chat-singapore.onrender.com' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function within(promise, ms = 1000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Test deadline')), ms); })]); }
  finally { clearTimeout(timer); }
}
async function harness(t, handler, options = {}) {
  const upstream = createServer(handler), requests = [];
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = createHostingProxy({ env, ...options, requestFactory: (args, callback) => {
    requests.push(args);
    return request({ ...args, protocol: 'http:', hostname: '127.0.0.1', port: upstream.address().port, agent: false }, callback);
  } });
  await proxy.start({ port: 0, host: '127.0.0.1' });
  t.after(async () => {
    await proxy.close();
    await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); });
  });
  return { proxy, requests, upstream, port: proxy.server.address().port };
}
function exchange(port, { path = '/', method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = request({ hostname: '127.0.0.1', port, path, method, headers, agent: false }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    outgoing.once('error', reject); outgoing.end(body);
  });
}

test('production upstream must be a fixed HTTPS Render origin distinct from both public and runtime hosts', () => {
  assert.equal(readHostingProxyConfig(env).hostname, 'sh-chat-singapore.onrender.com');
  for (const upstream of ['', 'http://sh-chat-singapore.onrender.com', 'https://example.com',
    'https://sh-chat-singapore.onrender.com.evil.test', 'https://u:p@sh-chat-singapore.onrender.com',
    'https://sh-chat-singapore.onrender.com:444', 'https://sh-chat-singapore.onrender.com/api',
    'https://sh-chat-singapore.onrender.com/?x=1', 'https://sh-chat-singapore.onrender.com/#fragment',
    'https://ai-agent-debate.onrender.com'])
    assert.throws(() => readHostingProxyConfig({ ...env, SH_HOSTING_PROXY_UPSTREAM: upstream }));
  assert.throws(() => readHostingProxyConfig({ ...env, RENDER_EXTERNAL_HOSTNAME: 'SH-CHAT-SINGAPORE.ONRENDER.COM' }));
  assert.throws(() => readHostingProxyConfig({ ...env, APP_URL: 'https://sh-chat-singapore.onrender.com.' }));
  assert.throws(() => readHostingProxyConfig({ ...env, RENDER_EXTERNAL_HOSTNAME: 'sh-chat-singapore.onrender.com.' }));
  assert.throws(() => readHostingProxyConfig({ ...env, APP_URL: '' }));
});

test('raw signed mutation, query and enrollment headers pass once; status, cookies and timing return intact', async t => {
  const body = Buffer.from('{ "text":"Customer ✓", "calls":[] }\n');
  const signature = 'sha256=' + createHmac('sha256', 'synthetic-test-secret').update(body).digest('hex');
  const seen = deferred();
  const h = await harness(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    seen.resolve({ method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(409, { 'Set-Cookie': ['profile_session=one; Secure; HttpOnly', 'other=two; Secure'],
      'Server-Timing': 'call;dur=12', 'X-SH-Call-History': 'sh-call-history-v1',
      Connection: 'X-Private-Hop', 'X-Private-Hop': 'remove-me', 'Keep-Alive': 'timeout=50' });
    res.end('unchanged conflict');
  });
  const result = await exchange(h.port, { method: 'POST', path: '/api/operator-android/calls/a/accept?raw=%2f&x=1&x=2', body,
    headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, Authorization: 'Bearer synthetic-token',
      Cookie: 'profile_session=old', Origin: env.APP_URL, 'X-SH-Native-Build': '18', 'X-SH-Media-Protocol': 'sh-room-audio-v1',
      'X-Hub-Signature-256': signature, Connection: 'X-Client-Hop', 'X-Client-Hop': 'remove-me' } });
  const captured = await within(seen.promise);
  assert.equal(captured.method, 'POST'); assert.equal(captured.path, '/api/operator-android/calls/a/accept?raw=%2f&x=1&x=2');
  assert.deepEqual(captured.body, body); assert.equal(captured.headers['x-hub-signature-256'], signature);
  assert.equal(captured.headers.authorization, 'Bearer synthetic-token'); assert.equal(captured.headers.cookie, 'profile_session=old');
  assert.equal(captured.headers.origin, env.APP_URL); assert.equal(captured.headers['x-sh-native-build'], '18');
  assert.equal(captured.headers['x-sh-media-protocol'], 'sh-room-audio-v1');
  assert.equal(captured.headers['x-client-hop'], undefined); assert.equal(captured.headers.host, 'sh-chat-singapore.onrender.com');
  assert.equal(result.status, 409); assert.equal(result.body.toString(), 'unchanged conflict');
  assert.deepEqual(result.headers['set-cookie'], ['profile_session=one; Secure; HttpOnly', 'other=two; Secure']);
  assert.equal(result.headers['server-timing'], 'call;dur=12'); assert.equal(result.headers['x-sh-call-history'], 'sh-call-history-v1');
  assert.equal(result.headers['x-private-hop'], undefined);
  assert.notEqual(result.headers['keep-alive'], 'timeout=50', 'Node may generate its own downstream connection header');
  assert.equal(h.requests.length, 1);
});

test('request paths cannot select an upstream host, and loop markers are refused before forwarding', async t => {
  const h = await harness(t, (req, res) => { res.end(req.url); });
  assert.equal((await exchange(h.port, { path: 'https://attacker.example/a' })).status, 400);
  assert.equal((await exchange(h.port, { headers: { 'X-SH-Hosting-Proxy-Hop': '1' } })).status, 508);
  assert.equal(h.requests.length, 0);
  const result = await exchange(h.port, { path: '//attacker.example/a?x=%2F' });
  assert.equal(result.body.toString(), '//attacker.example/a?x=%2F');
  assert.equal(h.requests[0].hostname, 'sh-chat-singapore.onrender.com');
});

test('redirects relay unchanged without following or replaying the mutation', async t => {
  let hits = 0;
  const h = await harness(t, (_req, res) => { hits++; res.writeHead(307, { Location: 'https://elsewhere.example/next' }); res.end('redirect'); });
  const result = await exchange(h.port, { method: 'POST', body: 'one attempt' });
  assert.equal(result.status, 307); assert.equal(result.headers.location, 'https://elsewhere.example/next');
  assert.equal(result.body.toString(), 'redirect'); assert.equal(hits, 1); assert.equal(h.requests.length, 1);
});

test('an ambiguous upstream mutation failure is reported without any retry or request detail', async t => {
  let hits = 0;
  const h = await harness(t, async (req, res) => { for await (const _ of req) { /* consume exact attempt */ } hits++; res.destroy(); });
  const result = await exchange(h.port, { method: 'POST', path: '/private-call-id', body: 'private-body' });
  assert.equal(result.status, 502); assert.equal(hits, 1); assert.equal(h.requests.length, 1);
  assert.deepEqual(JSON.parse(result.body), { ok: false, error: 'Upstream service unavailable.' });
});

test('waiting for upstream headers has a bounded timeout and never retries', async t => {
  const h = await harness(t, () => {}, { responseTimeoutMs: 25, connectTimeoutMs: 100 });
  const result = await within(exchange(h.port));
  assert.equal(result.status, 504); assert.equal(h.requests.length, 1);
});

test('SSE headers and events stream immediately and are not cut off by the response-header deadline', async t => {
  let upstreamResponse;
  const h = await harness(t, (_req, res) => {
    upstreamResponse = res;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    res.write('event: ready\ndata: first\n\n');
  }, { responseTimeoutMs: 40, streamIdleTimeoutMs: 500 });
  const first = deferred(), ended = deferred(); let received = '';
  const client = request({ hostname: '127.0.0.1', port: h.port, agent: false }, response => {
    assert.equal(response.headers['x-accel-buffering'], 'no'); assert.equal(response.headers['cache-control'], 'no-cache, no-transform');
    response.on('data', chunk => { received += chunk; first.resolve(); });
    response.on('error', error => ended.resolve(error)); response.on('end', () => ended.resolve());
  });
  client.on('error', error => ended.resolve(error)); client.end();
  await within(first.promise); assert.ok(received.includes('first'));
  await new Promise(resolve => setTimeout(resolve, 90));
  upstreamResponse.end('event: next\ndata: second\n\n');
  assert.equal(await within(ended.promise), undefined); assert.ok(received.includes('second')); assert.equal(h.requests.length, 1);
});

test('client disconnect cancels the live upstream stream', async t => {
  const upstreamClosed = deferred(), received = deferred();
  const h = await harness(t, (_req, res) => {
    res.once('close', upstreamClosed.resolve); res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: open\n\n');
  });
  const client = request({ hostname: '127.0.0.1', port: h.port, agent: false }, response => {
    response.once('data', () => { response.destroy(); client.destroy(); received.resolve(); });
    response.on('error', () => {});
  });
  client.on('error', () => {}); client.end();
  await within(received.promise); await within(upstreamClosed.promise); assert.equal(h.requests.length, 1);
});

test('a partial upstream response failure aborts the downstream instead of appending error JSON or retrying', async t => {
  let upstreamResponse;
  const h = await harness(t, (_req, res) => {
    upstreamResponse = res; res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': '100' }); res.write('partial bytes');
  });
  const received = deferred(), interrupted = deferred(); let body = '';
  const client = request({ hostname: '127.0.0.1', port: h.port, agent: false }, response => {
    response.on('data', chunk => { body += chunk; received.resolve(); });
    response.on('aborted', () => interrupted.resolve()); response.on('error', () => {});
  });
  client.on('error', () => {}); client.end();
  await within(received.promise); upstreamResponse.destroy(); await within(interrupted.promise);
  assert.equal(body, 'partial bytes'); assert.equal(h.requests.length, 1);
});

test('connection-nominated and proxy authorization headers are stripped rather than promoted end-to-end', async t => {
  const h = await harness(t, (req, res) => {
    res.end(JSON.stringify({ authorization: req.headers.authorization || '', proxy: req.headers['proxy-authorization'] || '',
      nominated: req.headers['x-nominated'] || '', te: req.headers.te || '' }));
  });
  const result = await exchange(h.port, { headers: { Authorization: 'Bearer deliberately-hop-only',
    'Proxy-Authorization': 'Basic never-forward', 'X-Nominated': 'remove', TE: 'trailers', Connection: 'AUTHORIZATION, X-Nominated' } });
  assert.deepEqual(JSON.parse(result.body), { authorization: '', proxy: '', nominated: '', te: '' });
});

test('proxy entrypoint imports only built-ins and the migration draft does not activate it', async () => {
  const source = await readFile(new URL('../scripts/hosting-proxy.mjs', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/from ['"]([^'"]+)['"]/g)].map(match => match[1]);
  assert.ok(imports.length >= 4); assert.ok(imports.every(name => name.startsWith('node:')));
  for (const timeout of [0, Infinity, -1]) assert.throws(() => createHostingProxy({ env, responseTimeoutMs: timeout }));
});
