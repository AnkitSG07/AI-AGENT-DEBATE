import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {VideoLinks} from '../call-runtime/video-links.mjs';
const require = createRequire(import.meta.url);
const {chromium} = require(process.env.SH_PLAYWRIGHT_MODULE || 'playwright');

test('two real local WebRTC peers exchange audio/video, mute, disable camera and end promptly', {timeout: 60000}, async t => {
  const service = new VideoLinks({authorize: async () => ({deviceId: 'isolated-phone', nativeBuild: 24}),
    env: {SH_VIDEO_LINKS_ENABLED: 'true', SH_VIDEO_TURN_KEY_ID: 'local-fixture', SH_VIDEO_TURN_API_TOKEN: 'unused'},
    // A local loopback test uses host ICE; it cannot prove the external TURN service.
    fetchImpl: async () => ({ok: true, json: async () => ({iceServers: []})})});
  const app = express(); app.use(express.json()); service.mount(app);
  app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(() => {service.close(); server.closeAllConnections(); server.close();});
  const base = `http://127.0.0.1:${server.address().port}`;
  const links = await service.create({}, {requestId: 'isolated-video-12345'});
  const browser = await chromium.launch({executablePath: process.env.SH_TEST_CHROMIUM, headless: true,
    args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required']});
  t.after(() => browser.close());
  const peers = [];
  for (const url of [links.operatorUrl, links.customerUrl]) {
    const page = await browser.newPage({viewport: {width: 390, height: 844}});
    await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    await page.addInitScript(() => {
      window.__peers = []; const Peer = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends Peer { constructor(...args) {super(...args); window.__peers.push(this);} };
    });
    await page.goto(base + '/video-call.html' + new URL(url).hash);
    await page.getByRole('button', {name: 'Join video call', exact: true}).click(); peers.push(page);
  }
  try { await Promise.all(peers.map(page => page.waitForFunction(() => document.getElementById('liveStatus').textContent === 'Connected', null, {timeout: 15000}))); }
  catch (error) { for (const page of peers) t.diagnostic(JSON.stringify(await page.evaluate(() => ({status: document.getElementById('liveStatus').textContent, peers: window.__peers.map(p => ({state:p.connectionState, ice:p.iceConnectionState, gathering:p.iceGatheringState, signaling:p.signalingState}))})))); throw error; }
  for (const page of peers) {
    await page.waitForFunction(async () => {
      const stats = [...(await window.__peers[0].getStats()).values()];
      return ['audio', 'video'].every(kind => stats.some(s => s.type === 'inbound-rtp' && s.kind === kind && s.bytesReceived > 100 && (kind === 'audio' || s.framesDecoded > 0)));
    });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await peers[0].getByRole('button', {name: 'Mute microphone', exact: true}).click();
  assert.equal(await peers[0].evaluate(() => window.__peers[0].getSenders().find(s => s.track?.kind === 'audio').track.enabled), false);
  await peers[0].getByRole('button', {name: 'Unmute microphone', exact: true}).click();
  assert.equal(await peers[0].evaluate(() => window.__peers[0].getSenders().find(s => s.track?.kind === 'audio').track.enabled), true);
  await peers[0].getByRole('button', {name: 'Turn camera off', exact: true}).click();
  assert.equal(await peers[0].evaluate(() => window.__peers[0].getSenders().find(s => s.track?.kind === 'video').track.enabled), false);
  const started = performance.now();
  await peers[0].getByRole('button', {name: 'End call', exact: true}).click();
  await peers[1].waitForFunction(() => document.getElementById('liveStatus').textContent === 'The other participant ended the call.');
  assert.ok(performance.now() - started < 2000, 'Local End should not wait for any upload or previous signal');
  for (const page of peers) assert.equal(await page.evaluate(() => window.__peers[0].connectionState), 'closed');
});
