// Uses the isolated native-engine-fixture only. No customer or cloud connection.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RoomServiceClient } from 'livekit-server-sdk';
import { createNativeReadinessVerifier } from '../../call-runtime/readiness.mjs';

assert.equal(process.env.SH_R13_NATIVE_MEDIA_FIXTURE, '1', 'Explicit local fixture opt-in required');
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.SH_PLAYWRIGHT_MODULE || 'playwright');
const origin = 'http://127.0.0.1:17883';
const out = resolve(process.env.SH_STARTUP_AUDIO_OUTPUT || 'verification/r13/startup-audio/actual.json');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(path, value) {
  const response = await fetch(origin + path, { method: value === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  assert.equal(response.status, 200); return response.json();
}
const health = await api('/sim/health'); assert.equal(health.localOnly, true); assert.equal(health.ready, true);
const records = [];
let browser;
try {
  await api('/sim/reset', {});
  await api('/sim/customer', { muted: true });
  const join = await api('/sim/join');
  browser = await chromium.launch({ executablePath: process.env.SH_TEST_CHROMIUM || chromium.executablePath(),
    headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage'] });
  const context = await browser.newContext();
  await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1'
    ? route.continue() : route.abort('blockedbyclient'));
  const page = await context.newPage(); await page.goto(origin + '/peer');
  await page.evaluate(data => window.joinPeer(data), { ...join, url: 'ws://127.0.0.1:17880', frequency: 660 });
  const rooms = new RoomServiceClient('http://127.0.0.1:17880', 'devkey', 'secret', { failover: false });
  const verify = createNativeReadinessVerifier({ provider: { rooms, run: async (_, fn) => fn() } });
  const call = { id: 'local-initial-audio-probe', roomName: join.roomName, customerIdentity: join.customerIdentity,
    readinessNonce: 'local-readiness-nonce', owner: { deviceId: 'android-emulator', legId: join.legId, identity: join.identity } };
  const actor = { deviceId: 'android-emulator' };
  async function sampleWhen(predicate) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const row = await page.evaluate(id => window.peerSnapshot(id), join.customerIdentity);
      if (predicate(row)) return row;
      await pause(150);
    }
    throw Error('No matching real media observation');
  }
  const muted = await sampleWhen(row => row.state === 'connected' && row.outbound.packets > 20 && row.customerAudioTrackSid);
  const sample = await page.evaluate(data => window.peerEvidence(data), join);
  delete sample.after; delete sample.decodedTone;
  Object.assign(sample, { readinessMode: 'customer-muted-transport', customerMuted: true, customerTrackSubscribed: true });
  let proof, errorCode;
  try { proof = await verify({ actor, call, evidence: sample }); } catch (error) { errorCode = error.code; }
  const shouldBlock = process.env.SH_EXPECT_INITIAL_MUTE_BLOCKED === '1';
  if (shouldBlock) assert.equal(errorCode, 'MEDIA_NOT_READY');
  else { assert.equal(proof?.transportReady, true); assert.equal(proof?.bidirectionalAudio, false); }
  records.push({ scenario: 'real customer publication muted before operator joins', observedBefore: muted,
    evidence: sample, proof: proof || null, errorCode: errorCode || null });

  await api('/sim/customer', { silent: true, muted: false });
  const silent = await sampleWhen(row => row.inbound.packets > 30 && row.frames > 20000 && row.rms < .001);
  const silentSample = await page.evaluate(data => window.peerEvidence(data), join);
  delete silentSample.after; delete silentSample.decodedTone;
  const silentProof = await verify({ actor, call, evidence: silentSample });
  assert.equal(silentProof.verified, true); assert.equal(silentProof.bidirectionalAudio, true);
  records.push({ scenario: 'real silent customer before initial readiness has RTP and PCM',
    observedBefore: silent, evidence: silentSample, proof: silentProof });
  await mkdir(resolve(out, '..'), { recursive: true });
  await writeFile(out, JSON.stringify({ at: new Date().toISOString(),
    localOnly: true, expectedInitialMuteBlocked: shouldBlock, passed: true, records }, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, expectedInitialMuteBlocked: shouldBlock, cases: records.length, output: out }));
} finally {
  await browser?.close();
  await api('/sim/reset', {}).catch(() => {});
}
