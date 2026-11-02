// Opt-in local media test. Generated tones stand in for customer/operator voice.
// Real SFU, browser DTLS/SRTP, codec worker, publication permissions and WAVs;
// no WhatsApp, Odoo, Firebase, customer calls, or production credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import express from 'express';
import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import { CallAudioManager } from '../../media/call-audio-manager.mjs';
import { callMediaIdentity } from '../../media/livekit-provider.mjs';
import { wavHeader } from '../../call-runtime/odoo-call-files.mjs';
const require = createRequire(import.meta.url);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, description, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await pause(100); }
  throw Error(`Timed out: ${description}`);
}
test('hold music, private handover privacy, conference, and continuous recorded WAV parts',
  { skip: process.env.SH_R22_MEDIA_TESTS !== '1', timeout: 120000 }, async () => {
    const here = dirname(fileURLToPath(import.meta.url)), tooling = resolve(here, '../../../tooling/r13-media');
    const out = resolve(process.env.SH_MEDIA_TEST_OUTPUT || resolve(here, '../../verification/r22/media'));
    await mkdir(out, { recursive: true });
    const log = createWriteStream(resolve(out, 'sfu.log'));
    const sfu = spawn(resolve(tooling, 'server/livekit-server'), ['--dev', '--bind', '127.0.0.1', '--node-ip', '127.0.0.1', '--udp-port', '17882',
      '--config-body', 'port: 17880\nrtc:\n  tcp_port: 17881\n  use_external_ip: false\n  enable_loopback_candidate: true\nlogging:\n  level: warn\n'], { stdio: ['ignore', 'pipe', 'pipe'] });
    sfu.stdout.pipe(log); sfu.stderr.pipe(log);
    let browser, server, manager;
    const parts = [], phases = [];
    const roomName = 'isolated-r22-handover', mediaIdentity = callMediaIdentity(roomName);
    const call = { id: 'isolated-r22-call', active: true, roomName, customerIdentity: 'customer', owner: { deviceId: 'a', identity: 'A' } };
    try {
      const rooms = new RoomServiceClient('http://127.0.0.1:17880', 'devkey', 'secret', { requestTimeout: 1, failover: false });
      await until(async () => { if (sfu.exitCode !== null) throw Error('Local SFU exited; see sfu.log');
        try { await rooms.listRooms(); return true; } catch { return false; } }, 'local SFU');
      const app = express(); app.get('/peer', (_, res) => res.sendFile(resolve(here, 'peer.html')));
      app.get('/livekit-client.umd.js', (_, res) => res.sendFile(resolve(tooling, 'client/package/dist/livekit-client.umd.js')));
      server = app.listen(17883, '127.0.0.1'); await once(server, 'listening');
      const { chromium } = require(process.env.SH_PLAYWRIGHT_MODULE || 'playwright');
      browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
      async function peer(identity, frequency) {
        const token = new AccessToken('devkey', 'secret', { identity, ttl: 120 });
        token.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true, canPublishSources: [TrackSource.MICROPHONE] });
        const page = await browser.newPage(); await page.goto('http://127.0.0.1:17883/peer');
        await page.evaluate(data => window.joinPeer(data), { url: 'ws://127.0.0.1:17880', token: await token.toJwt(), frequency });
        return page;
      }
      async function route(page, publishTo, subscribeTo) {
        await page.evaluate(async ({ publishTo, subscribeTo }) => {
          // Match native privacy transitions: close capture, replace publication,
          // apply exact permissions, then reopen the fresh microphone.
          const next = localTrack.mediaStreamTrack.clone(); next.enabled = false;
          localTrack.mediaStreamTrack.enabled = false;
          await room.localParticipant.unpublishTrack(localTrack, true);
          room.localParticipant.setTrackSubscriptionPermissions(false, publishTo.map(participantIdentity => ({ participantIdentity, allowAll: true })));
          localTrack = new LK.LocalAudioTrack(next, undefined, true);
          localPublication = await room.localParticipant.publishTrack(localTrack, { source: LK.Track.Source.Microphone });
          next.enabled = true;
          for (const participant of room.remoteParticipants.values()) for (const publication of participant.trackPublications.values())
            publication.setSubscribed(subscribeTo.includes(participant.identity));
        }, { publishTo, subscribeTo });
      }
      async function hears(page, identity, audible, label) {
        await until(async () => { const sample = await page.evaluate(id => window.peerSnapshot(id), identity);
          return audible ? sample.rms > .001 && sample.frames > 2000 : sample.rms < .0001; }, label);
      }
      const customer = await peer('customer', 440), a = await peer('A', 660);
      await route(a, ['customer', mediaIdentity], ['customer']);
      await hears(customer, 'A', true, 'customer hears A');
      manager = new CallAudioManager({ provider: { config: { apiKey: 'devkey', apiSecret: 'secret', wsUrl: 'ws://127.0.0.1:17880' } },
        files: { beginRecording: async () => {}, savePart: async (callId, recordingId, index, pcm) => {
          parts.push({ index, pcm: Buffer.from(pcm) }); await writeFile(resolve(out, `recording-${index}.wav`), Buffer.concat([wavHeader(pcm.length), pcm]));
        } } });
      await manager.start(call, { deviceId: 'a' }, 'isolated-recording-request');
      await until(() => manager.state(call.id).state === 'recording', 'recording actually started');
      const recordingAt = Date.now(); await pause(3000);
      const prepareAt = Date.now(); await manager.prepareHold(call); phases.push({ name: 'hold preparation', elapsedMs: Date.now() - prepareAt });
      const held = { ...call, transfer: { mode: 'consult', status: 'connecting', consultStage: 'private', targetIdentity: 'B' } };
      manager.sync(held); await route(a, ['B'], ['B']);
      const b = await peer('B', 880); await route(b, ['A'], ['A']);
      // New B publication is explicitly subscribed after it exists, as on Android.
      await a.evaluate(() => { for (const p of room.remoteParticipants.values()) for (const t of p.trackPublications.values()) t.setSubscribed(p.identity === 'B'); });
      await hears(a, 'B', true, 'A hears private B'); await hears(b, 'A', true, 'B hears private A');
      await hears(customer, 'A', false, 'customer cannot hear private A'); await hears(customer, 'B', false, 'customer cannot hear private B');
      await hears(customer, mediaIdentity, true, 'customer hears actual hold piano');
      const privateStartMs = Date.now() - recordingAt; await pause(3000);
      const privateEndMs = Date.now() - recordingAt;
      const merged = { ...held, transfer: { ...held.transfer, consultStage: 'merged' } }; manager.sync(merged);
      await route(a, ['customer', 'B', mediaIdentity], ['customer', 'B']);
      await route(b, ['customer', 'A', mediaIdentity], ['customer', 'A']);
      await hears(customer, 'A', true, 'conference customer hears A'); await hears(customer, 'B', true, 'conference customer hears B');
      await hears(customer, mediaIdentity, false, 'hold piano stops after merge');
      await hears(a, 'B', true, 'conference A hears B'); await hears(b, 'A', true, 'conference B hears A');
      const rss = await readFile(`/proc/${manager.calls.get(call.id).child.pid}/status`, 'utf8');
      phases.push({ name: 'audio worker memory', residentKiB: Number(/VmRSS:\s+(\d+)/.exec(rss)?.[1] || 0) });
      await pause(Math.max(0, 32500 - (Date.now() - recordingAt)));
      manager.stop(call.id); await until(() => manager.state(call.id).state === 'saved', 'recording flushed to WAV');
      assert.ok(parts.length >= 2, 'recording crosses a 30-second archive boundary');
      const pcm = Buffer.concat(parts.sort((a,b) => a.index - b.index).map(part => part.pcm));
      function amplitude(frequency, startMs, durationMs = 600) {
        const first = Math.floor(startMs * 16), count = Math.floor(durationMs * 16); let re = 0, im = 0;
        for (let n = 0; n < count; n++) { const sample = pcm.readInt16LE((first + n) * 2) / 32768;
          re += sample * Math.cos(2 * Math.PI * frequency * n / 16000); im += sample * Math.sin(2 * Math.PI * frequency * n / 16000); }
        return 2 * Math.hypot(re, im) / count;
      }
      const privateMs = Math.min(privateEndMs - 1000, privateStartMs + 1000);
      assert.ok(amplitude(440, privateMs) > .005, 'customer stays recorded while held');
      assert.ok(amplitude(660, privateMs) < .002 && amplitude(880, privateMs) < .002, 'private operator discussion is excluded from customer recording');
      for (const ms of [29500, 30050, 31000]) assert.ok(amplitude(440, ms) > .005, `customer audio continues across part boundary at ${ms}ms`);
      phases.push({ name: 'recorded duration', seconds: pcm.length / 32000, parts: parts.length,
        customerPrivateAmplitude: amplitude(440, privateMs), privateOperatorAmplitude: Math.max(amplitude(660, privateMs), amplitude(880, privateMs)) });
      await writeFile(resolve(out, 'result.json'), JSON.stringify({ passed: true, phases }, null, 2));
    } finally {
      manager?.close(call.id); await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));
      if (sfu.exitCode === null && sfu.signalCode === null) { sfu.kill('SIGTERM'); await once(sfu, 'exit').catch(() => {}); } log.end();
    }
  });
