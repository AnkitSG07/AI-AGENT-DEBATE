/**
 * LOCAL ONLY: actual LiveKit audio fixture for NativeRoomEngine instrumentation.
 * TLS is pinned only by androidTest; no release URL, trust or media policy changes.
 * Use adb reverse tcp:443 tcp:18443 and tcp:17881 tcp:17881. The test-only client
 * resolves sh-r13-simulator.livekit.cloud to emulator loopback, preserving normal
 * hostname and certificate verification against the generated test CA.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import { operatorIdentity, customerIdentity } from '../../media/livekit-provider.mjs';

assert.equal(process.env.SH_R13_NATIVE_MEDIA_FIXTURE, '1', 'Explicit local fixture opt-in required');
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const TOOLING = resolve(process.env.SH_MEDIA_TOOLING || resolve(ROOT, 'tooling/r13-media'));
const OUT = resolve(process.env.SH_NATIVE_MEDIA_OUTPUT || resolve(ROOT, 'native-media-fixture'));
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.SH_PLAYWRIGHT_MODULE || 'playwright');
const TLS = resolve(process.env.SH_NATIVE_MEDIA_TLS || join(OUT, 'tls'));
const HOST = 'sh-r13-simulator.livekit.cloud';
const LK_HTTP = 'http://127.0.0.1:17880', LK_WS = 'ws://127.0.0.1:17880';
const key = 'devkey', secret = 'secret'; // public upstream development defaults
const rooms = new RoomServiceClient(LK_HTTP, key, secret, { failover: false, requestTimeout: 5 });
const evidence = [], processes = [], logs = [];
let browser, page, context, fixture, server, tlsServer, stopping = false;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(fn, label, timeout = 20000) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await pause(150);
  }
  throw Error(`${label}: ${last?.message || 'timed out'}`);
}
async function jwt(identity, room) {
  const t = new AccessToken(key, secret, { identity, ttl: '10m' });
  t.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true,
    canPublishSources: [TrackSource.MICROPHONE], canPublishData: false });
  return t.toJwt();
}
async function checkpoint() {
  await writeFile(join(OUT, 'fixture-observations.json'), JSON.stringify({
    scope: 'Local SFU, generated customer tone, native Android engine instrumentation. No Meta, FCM or physical audio hardware.',
    externalCalls: false, hostname: HOST, events: evidence
  }, null, 2) + '\n');
}
async function reset() {
  if (fixture) {
    await page.evaluate(() => window.leavePeer());
    await rooms.deleteRoom(fixture.roomName).catch(() => {});
  }
  const legId = 'native-' + randomUUID();
  const roomName = 'native-' + randomUUID();
  fixture = { url: 'wss://' + HOST, roomName, legId,
    identity: operatorIdentity('android-emulator', legId),
    customerIdentity: customerIdentity(legId) };
  await page.evaluate(data => window.joinPeer(data), {
    url: LK_WS, token: await jwt(fixture.customerIdentity, roomName), frequency: 440
  });
  evidence.push({ event: 'new-room', at: new Date().toISOString(), roomName,
    identity: fixture.identity, customerIdentity: fixture.customerIdentity });
  await checkpoint();
}
function proxy(req, res) {
  const target = http.request({ hostname: '127.0.0.1', port: 17880,
    path: req.url, method: req.method, headers: req.headers }, upstream => {
    res.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(res);
  });
  target.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(target);
}
function upgrade(req, socket, head) {
  const target = http.request({ hostname: '127.0.0.1', port: 17880,
    path: req.url, method: req.method, headers: req.headers });
  target.on('upgrade', (res, upstream, upstreamHead) => {
    socket.write(`HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n` +
      Object.entries(res.headers).map(([name, value]) => `${name}: ${value}`).join('\r\n') + '\r\n\r\n');
    if (head.length) upstream.write(head);
    if (upstreamHead.length) socket.write(upstreamHead);
    socket.pipe(upstream); upstream.pipe(socket);
    socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy());
  });
  target.on('response', res => { socket.end(`HTTP/1.1 ${res.statusCode} Rejected\r\nConnection: close\r\n\r\n`); });
  target.on('error', () => socket.destroy());
  target.end();
}
async function close() {
  if (stopping) return;
  stopping = true;
  await checkpoint().catch(() => {});
  await browser?.close().catch(() => {});
  server?.close(); tlsServer?.close();
  await Promise.all(processes.map(child => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timeout = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000);
    child.once('exit', () => { clearTimeout(timeout); resolve(); });
    child.kill('SIGTERM');
  })));
  for (const log of logs) log.end();
}
process.on('SIGTERM', () => close().finally(() => process.exit(0)));
process.on('SIGINT', () => close().finally(() => process.exit(0)));

await mkdir(OUT, { recursive: true });
try {
  // Fail if any unrelated service already owns a fixture port.
  for (const port of [17880, 17881, 17883, 18443]) {
    await new Promise((resolve, reject) => {
      const probe = http.createServer(); probe.on('error', reject);
      probe.listen(port, '127.0.0.1', () => probe.close(resolve));
    });
  }
  const log = createWriteStream(join(OUT, 'livekit-native.log')); logs.push(log);
  const lk = spawn(process.env.SH_LIVEKIT_SERVER || join(TOOLING, 'server/livekit-server'), [
    '--dev', '--bind', '127.0.0.1', '--node-ip', '127.0.0.1', '--config-body',
    'port: 17880\nrtc:\n  tcp_port: 17881\n  force_tcp: true\n  use_external_ip: false\n  enable_loopback_candidate: true\nlogging:\n  level: warn\n'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  processes.push(lk); lk.stdout.pipe(log, { end: false }); lk.stderr.pipe(log, { end: false });
  await waitFor(async () => (await fetch(LK_HTTP)).ok, 'LiveKit starts');
  const app = express(); app.use(express.json({ limit: '32kb' }));
  app.use('/sim', (_, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/peer', (_, res) => res.sendFile(join(HERE, 'peer.html')));
  app.get('/livekit-client.umd.js', (_, res) => res.sendFile(join(TOOLING, 'client/package/dist/livekit-client.umd.js')));
  app.get('/sim/health', (_, res) => res.json({ ok: true, ready: !!fixture, localOnly: true }));
  app.get('/sim/join', async (_, res, next) => {
    try { res.json({ ...fixture, token: await jwt(fixture.identity, fixture.roomName) }); } catch (error) { next(error); }
  });
  app.post('/sim/reset', async (_, res, next) => {
    try { await reset(); res.json({ ok: true }); } catch (error) { next(error); }
  });
  app.get('/sim/state', async (_, res, next) => {
    try {
      const rows = await rooms.listParticipants(fixture.roomName);
      const snapshot = await page.evaluate(id => window.peerSnapshot(id), fixture.identity);
      res.json({ roomName: fixture.roomName, identity: fixture.identity,
        participants: rows.map(row => ({ identity: row.identity, sid: row.sid, state: row.state,
          tracks: row.tracks.map(t => ({ sid: t.sid, muted: t.muted, type: t.type })) })),
        customerSnapshot: snapshot });
    } catch (error) { next(error); }
  });
  app.post('/sim/customer', async (req, res, next) => {
    try {
      if (typeof req.body.muted === 'boolean') await page.evaluate(value => window.setMute(value), req.body.muted);
      if (typeof req.body.silent === 'boolean') await page.evaluate(value => window.setSilence(value), req.body.silent);
      if (req.body.leave === true) await page.evaluate(() => window.leavePeer());
      evidence.push({ event: 'customer-control', at: new Date().toISOString(),
        muted: req.body.muted, silent: req.body.silent, leave: req.body.leave });
      await checkpoint(); res.json({ ok: true });
    } catch (error) { next(error); }
  });
  app.post('/sim/evidence', async (req, res, next) => {
    try {
      // The instrumentation payload contains stage/events/counters only.
      const text = JSON.stringify(req.body);
      if (/"(?:token|authorization|password|secret)"/i.test(text)) return res.status(400).json({ error: 'Do not log credentials' });
      evidence.push({ event: 'native-observation', at: new Date().toISOString(), data: req.body });
      await checkpoint(); res.json({ ok: true });
    } catch (error) { next(error); }
  });
  app.use((error, _, res, next) => { res.status(500).json({ error: 'Local fixture request failed' }); });
  server = app.listen(17883, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  tlsServer = https.createServer({ key: await readFile(join(TLS, 'server.key')),
    cert: await readFile(join(TLS, 'server.crt')) }, (req, res) => {
      const path = req.url.split('?')[0];
      evidence.push({ event: 'tls-request', at: new Date().toISOString(), method: req.method, path });
      if (path === '/settings/regions') {
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ regions: [] }));
      } else if (path.startsWith('/sim/')) app(req, res); else proxy(req, res);
    });
  tlsServer.on('upgrade', upgrade);
  tlsServer.listen(18443, '127.0.0.1');
  await new Promise(resolve => tlsServer.once('listening', resolve));
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.SH_TEST_CHROMIUM || chromium.executablePath(),
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--disable-dev-shm-usage'] });
  context = await browser.newContext();
  await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1'
    ? route.continue() : route.abort('blockedbyclient'));
  page = await context.newPage();
  await page.goto('http://127.0.0.1:17883/peer');
  await reset();
  console.log(JSON.stringify({ ready: true, localOnly: true, hostname: HOST,
    descriptor: `https://${HOST}/sim/join`, output: OUT }));
} catch (error) {
  console.error(error.message); await close(); process.exitCode = 1;
}
