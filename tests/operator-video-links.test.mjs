import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { VideoLinks } from '../call-runtime/video-links.mjs';

function fixture(t, enabled = true) {
  let now = 1000000, turnCalls = 0;
  const service = new VideoLinks({now: () => now, authorize: async context => ({deviceId: context.deviceId || 'a', nativeBuild: 24}),
    env: {SH_VIDEO_LINKS_ENABLED: String(enabled), SH_VIDEO_TURN_KEY_ID: 'test-key', SH_VIDEO_TURN_API_TOKEN: 'test-secret'},
    fetchImpl: async (url, options) => { turnCalls++; assert.ok(url.startsWith('https://rtc.live.cloudflare.com/')); assert.equal(JSON.parse(options.body).ttl, 2100);
      return {ok: true, json: async () => ({iceServers: [{urls: ['turn:turn.cloudflare.com:443?transport=udp', 'turn:turn.cloudflare.com:53'], username: 'temporary-user', credential: 'temporary-password'}]})}; } });
  t.after(() => service.close());
  return {service, get turnCalls() {return turnCalls;}, advance(ms) {now += ms;}};
}
function identity(url) { const [id, role, token] = new URL(url).hash.slice(1).split('.'); return {id, role, token, clientId: 'client-identity-' + role}; }
async function session(f) {
  const links = await f.service.create({}, {requestId: 'request-video-0001'});
  return {links, operator: identity(links.operatorUrl), customer: identity(links.customerUrl)};
}
test('video stays disabled without an explicitly configured relay and makes no relay request', async t => {
  const f = fixture(t, false); await assert.rejects(f.service.create({}, {requestId: 'request-0001'}), {code: 'VIDEO_NOT_CONFIGURED'}); assert.equal(f.turnCalls, 0);
});
test('repeated Create is one private room and never opens a LiveKit participant', async t => {
  const f = fixture(t), {links} = await session(f);
  assert.deepEqual(await f.service.create({}, {requestId: 'request-video-0001'}), links);
  assert.equal(f.service.rooms.size, 1); assert.equal(f.turnCalls, 2); assert.notEqual(links.operatorUrl, links.customerUrl);
  assert.equal(new URL(links.customerUrl).search, '');
  await assert.rejects(f.service.create({}, {requestId: 'request-video-0002'}), {code: 'VIDEO_BUSY'});
});
test('short-lived relay credentials are coalesced per participant and no long-term secret reaches the page', async t => {
  const f = fixture(t), {operator: a, customer: b} = await session(f);
  const [one, two] = await Promise.all([f.service.join(a.id, a.token, a), f.service.join(a.id, a.token, a)]);
  assert.deepEqual(one, two); assert.equal(f.turnCalls, 2); assert.equal(one.iceServers[0].urls.length, 1);
  await f.service.join(b.id, b.token, b); assert.equal(f.turnCalls, 2);
  assert.ok(!JSON.stringify(one).includes('test-secret'));
});
test('private role cannot be stolen by another device, guessed token or unjoined client', async t => {
  const f = fixture(t), {operator: a} = await session(f);
  assert.throws(() => f.service.access(a.id, a.token, a.clientId), {code: 'VIDEO_JOIN_REQUIRED'});
  await f.service.join(a.id, a.token, a);
  await assert.rejects(f.service.join(a.id, a.token, {...a, clientId: 'different-client-123'}), {code: 'VIDEO_ALREADY_JOINED'});
  assert.throws(() => f.service.access(a.id, 'x'.repeat(32), a.clientId), {code: 'VIDEO_ACCESS_DENIED'});
  assert.throws(() => f.service.access(a.id, 'é'.repeat(32), a.clientId), {code: 'VIDEO_ACCESS_DENIED'});
});
test('invitation expiry blocks a new join but an already joined participant may reconnect', async t => {
  const f = fixture(t), {operator: a, customer: b} = await session(f);
  await f.service.join(a.id, a.token, a); f.advance(11 * 60000);
  await f.service.join(a.id, a.token, a);
  await assert.rejects(f.service.join(b.id, b.token, b), {code: 'VIDEO_LINK_EXPIRED'});
});
test('ordered signals are delivered once to the opposite role and customer cannot impersonate an offer', async t => {
  const f = fixture(t), {operator: a, customer: b} = await session(f);
  await f.service.join(a.id, a.token, a); await f.service.join(b.id, b.token, b);
  const body = {...b, type: 'ready', messageId: 'signal-ready-1234'};
  f.service.signal(b.id, b.token, body); f.service.signal(b.id, b.token, body);
  const room = f.service.rooms.get(a.id); assert.equal(room.events.length, 1); assert.equal(room.events[0].to, 'operator');
  assert.throws(() => f.service.signal(b.id, b.token, {...b, type: 'offer', sdp: 'v=0\r\n', messageId: 'signal-offer-1234'}), {code: 'INVALID_VIDEO_SIGNAL'});
});
test('End immediately releases both event streams and revokes the room links', async t => {
  const f = fixture(t), {operator: a, customer: b} = await session(f);
  await f.service.join(a.id, a.token, a); await f.service.join(b.id, b.token, b);
  const delivered = [], ended = [], room = f.service.rooms.get(a.id);
  for (const role of ['operator', 'customer']) room.subscribers.set(role, {write: data => {delivered.push(data); return true;}, end: () => ended.push(role)});
  f.service.signal(a.id, a.token, {...a, type: 'end', messageId: 'signal-end-1234'});
  assert.equal(delivered.length, 2); assert.deepEqual(ended, ['operator', 'customer']); assert.equal(room.subscribers.size, 0);
  assert.throws(() => f.service.access(a.id, b.token, b.clientId), {code: 'VIDEO_ENDED'});
});
test('HTTP signaling uses bearer headers and receives live events without a database polling loop', async t => {
  const f = fixture(t), {operator: a, customer: b} = await session(f);
  const app = express(); app.use(express.json()); f.service.mount(app);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => {server.closeAllConnections(); server.close();});
  const base = `http://127.0.0.1:${server.address().port}/api/sh-video/${a.id}`;
  const post = (p, body) => fetch(base + '/join', {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + p.token}, body: JSON.stringify(body)});
  assert.equal((await post(a, a)).status, 200); assert.equal((await post(b, b)).status, 200);
  const abort = new AbortController(); t.after(() => abort.abort());
  const response = await fetch(`${base}/events?clientId=${a.clientId}`, {headers: {Authorization: 'Bearer ' + a.token}, signal: abort.signal});
  const reader = response.body.getReader(); await reader.read();
  const sent = await fetch(base + '/signal', {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + b.token}, body: JSON.stringify({...b, type: 'ready', messageId: 'live-ready-1234'})});
  assert.equal(sent.status, 200); const event = await reader.read(); assert.match(new TextDecoder().decode(event.value), /"type":"ready"/);
  abort.abort();
});

test('native End revokes an unjoined link, is idempotent and cannot close another device link', async t => {
  const f = fixture(t), {operator: a} = await session(f);
  await assert.rejects(f.service.endFromDevice({deviceId: 'b'}, a.id), {code: 'VIDEO_ACCESS_DENIED'});
  assert.deepEqual(await f.service.endFromDevice({}, a.id), {ended: true});
  assert.deepEqual(await f.service.endFromDevice({}, a.id), {ended: true});
  assert.equal(f.turnCalls, 2);
  await assert.rejects(f.service.join(a.id, a.token, a), {code: 'VIDEO_ENDED'});
  const next = await f.service.create({}, {requestId: 'request-video-0002'});
  assert.notEqual(next.operatorUrl, f.service.links(f.service.rooms.get(a.id)).operatorUrl);
  f.advance(60001); f.service.prune(); assert.equal(f.service.rooms.size, 1);
});

test('slow relay preparation never blocks Create or End and is reused by Join', async t => {
  let release, requests = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const service = new VideoLinks({authorize: async () => ({deviceId: 'a', nativeBuild: 24}),
    env: {SH_VIDEO_LINKS_ENABLED: 'true', SH_VIDEO_TURN_KEY_ID: 'fixture', SH_VIDEO_TURN_API_TOKEN: 'fixture'},
    fetchImpl: async () => { requests++; await gate; return {ok: true, json: async () => ({iceServers: []})}; }});
  t.after(() => {release(); service.close();});
  const links = await service.create({}, {requestId: 'slow-relay-1234'});
  const a = identity(links.operatorUrl);
  assert.equal(requests, 2);
  const joining = service.join(a.id, a.token, a);
  const rejected = assert.rejects(joining, {code: 'VIDEO_ENDED'});
  assert.deepEqual(await service.endFromDevice({}, a.id), {ended: true});
  release(); await rejected;
  assert.equal(requests, 2, 'Join must reuse the preparation already in flight');
});

test('R25 customer links are short, open without a fragment, and previews cannot claim the seat', async t => {
  const f = fixture(t); f.service.authorize = async () => ({deviceId: 'a', nativeBuild: 25});
  const links = await f.service.create({}, {requestId: 'short-video-0001'}), code = new URL(links.customerUrl).pathname.split('/').at(-1);
  assert.match(links.customerUrl, /^https:\/\/ai-agent-debate\.onrender\.com\/v\/[A-Za-z0-9_-]{24}$/);
  assert.ok(links.customerUrl.length < 70);
  const first = f.service.invitation(code), second = f.service.invitation(code);
  assert.deepEqual(first, second); assert.equal(first.role, 'customer');
  assert.equal(f.service.rooms.get(first.id).roles.customer.clientId, undefined);
  await f.service.join(first.id, first.token, {clientId:'real-customer-client-001'});
  assert.equal(f.service.rooms.get(first.id).roles.customer.clientId, 'real-customer-client-001');
  await f.service.endFromDevice({}, first.id); assert.throws(() => f.service.invitation(code), {code:'VIDEO_LINK_EXPIRED'});
});
test('explicit fresh R25 call replaces only the same device abandoned room', async t => {
  const f = fixture(t); f.service.authorize = async c => ({deviceId: c.deviceId || 'a', nativeBuild: 25});
  const a = await session(f), b = await f.service.create({deviceId: 'b'}, {requestId:'other-video-0001'});
  const old = identity(a.links.operatorUrl), other = identity(b.operatorUrl);
  await f.service.create({}, {requestId:'new-video-0002', replaceActive:true});
  assert.equal(f.service.rooms.get(old.id).ended, true); assert.equal(f.service.rooms.get(other.id).ended, false);
});
test('short-link HTTP page is no-store and invitation resolver returns only customer access', async t => {
  const f = fixture(t); f.service.authorize = async () => ({deviceId: 'a', nativeBuild: 25});
  const links = await f.service.create({}, {requestId:'page-video-0001'}), path = new URL(links.customerUrl).pathname;
  const app = express(); app.use(express.json()); f.service.mount(app);
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(() => {server.closeAllConnections(); server.close();});
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(base + path); assert.equal(page.status, 200); assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer'); assert.match(await page.text(), /Join video call/);
  const response = await fetch(base + '/api/sh-video/invitation', {method:'POST',headers:{Authorization:'Bearer ' + path.split('/').at(-1)}});
  const data = await response.json(); assert.equal(data.role,'customer'); assert.notEqual(data.token, identity(links.operatorUrl).token);
});
