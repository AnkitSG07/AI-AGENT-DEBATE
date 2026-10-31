/**
 * LOCAL ONLY. Actual SFU, Chromium RTCPeerConnections, generated/decoded audio,
 * RoomService SDK, Firestore emulator, application routes/runtime/readiness and
 * transfer controller. The unavailable Cloud-only WhatsApp connector is replaced
 * by an explicit test customer. No Meta, FCM or production Firebase traffic.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join as joinPath } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import express from 'express';
import { Firestore } from '@google-cloud/firestore';
import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import { LiveKitWhatsAppProvider } from '../../media/livekit-provider.mjs';
import { createNativeCallRuntime } from '../../call-runtime/startup.mjs';
import { mountNativeCallRoutes } from '../../call-runtime/routes.mjs';
import { createFirestoreMediaStore } from '../../media-store/firestore-media-store.mjs';
import { deviceReservationKey, callStoreKey } from '../../media/transfer-controller.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.SH_PLAYWRIGHT_MODULE || 'playwright');
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const TOOLING = resolve(process.env.SH_MEDIA_TOOLING || resolve(ROOT, 'tooling/r13-media'));
const OUT = resolve(process.env.SH_MEDIA_TEST_OUTPUT || joinPath(HERE, 'evidence'));
const HTTP = 'http://127.0.0.1:17883', LK_HTTP = 'http://127.0.0.1:17880', LK_WS = 'ws://127.0.0.1:17880';
const LK_KEY = 'devkey', LK_SECRET = 'secret'; // public upstream development defaults; never production
const processes = [], files = [], results = [], measurements = [];
let browser, db, httpServer, rooms;
let startingHashes, scenarioCount = 0;
const sourceFiles = ['peer.html','real-media.test.mjs','../../media/livekit-provider.mjs',
  '../../media/transfer-controller.mjs','../../media-store/firestore-media-store.mjs',
  '../../call-runtime/startup.mjs','../../call-runtime/call-runtime.mjs','../../call-runtime/routes.mjs','../../call-runtime/readiness.mjs'];
const sourceHashes = async()=>Object.fromEntries(await Promise.all(sourceFiles.map(async name=>[name,
  createHash('sha256').update(await readFile(joinPath(HERE,name))).digest('hex')])));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'; // synthetic external connector only

async function assertLocalPortsAvailable() {
  // Never accidentally attach to a leftover simulator or an unrelated service.
  // All probes close before this isolated run starts its own listeners.
  await Promise.all([17880,17881,17883,18089].map(port => new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  })));
  await new Promise((resolve, reject) => {
    const socket = createSocket('udp4');
    socket.once('error', error => { socket.close(); reject(error); });
    socket.bind(17882, '127.0.0.1', () => socket.close(resolve));
  });
}

async function waitFor(fn, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await pause(100);
  }
  throw new Error(`Timed out: ${message}${last ? ` (${last.message})` : ''}`);
}
function start(command, args, name, options = {}) {
  const log = createWriteStream(joinPath(OUT, name)); files.push(log);
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  child.once('error', e => log.write(String(e))); processes.push(child); return child;
}
async function token(identity, roomName) {
  const access = new AccessToken(LK_KEY, LK_SECRET, { identity, ttl: '10m' });
  access.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true,
    canPublishSources: [TrackSource.MICROPHONE], canPublishData: false });
  return access.toJwt();
}
async function peer(join, frequency) {
  const context = await browser.newContext();
  await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort('blockedbyclient'));
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type()==='error') process.stderr.write('PEER '+message.text()+'\n'); });
  await page.goto(HTTP + '/peer');
  const started = performance.now();
  const result = await page.evaluate(data => window.joinPeer(data), { ...join, frequency });
  return { page, context, result, errors, joinLatencyMs: performance.now() - started,
    async close() { await context.close(); } };
}
async function audio(fromPeer, identity, frequency, name) {
  let last;
  const value = await waitFor(async () => {
    const row = await fromPeer.page.evaluate(id => window.peerSnapshot(id), identity);
    last = row;
    return row.inbound.packets > 15 && row.outbound.packets > 15 && row.frames > 10000 && row.rms > .015 &&
      Math.abs(row.frequency - frequency) < 30 ? row : false;
  }, name).catch(error => { console.error('AUDIO SNAPSHOT',JSON.stringify(last)); throw error; });
  assert.ok(value.candidate.length, 'ICE succeeded');
  assert.ok(value.transport.every(t => t.dtlsState === 'connected'), 'DTLS connected');
  measurements.push({ name, at: new Date().toISOString(), identity, rms: value.rms,
    frequencyHz: value.frequency, decodedFrames: value.frames,
    inbound: value.inbound, outbound: value.outbound });
  return value;
}
async function continuingAudio(fromPeer, identity, frequency, name) {
  // A post-handoff snapshot alone can still contain counters from before the
  // source disappeared. Require newly received, decoded and transmitted media
  // after its browser context was actually closed.
  const before = await fromPeer.page.evaluate(id => window.peerSnapshot(id), identity);
  await pause(1000);
  const after = await audio(fromPeer, identity, frequency, name);
  const delta = {
    receivedPackets: (after.inbound.packets || 0) - (before.inbound.packets || 0),
    receivedBytes: (after.inbound.bytes || 0) - (before.inbound.bytes || 0),
    decodedFrames: after.frames - before.frames,
    sentPackets: (after.outbound.packets || 0) - (before.outbound.packets || 0),
    sentBytes: (after.outbound.bytes || 0) - (before.outbound.bytes || 0)
  };
  assert.ok(delta.receivedPackets > 15 && delta.receivedBytes > 0 && delta.decodedFrames > 10000,
    `New audio must arrive after source shutdown: ${JSON.stringify(delta)}`);
  assert.ok(delta.sentPackets > 15 && delta.sentBytes > 0,
    `New microphone media must leave after source shutdown: ${JSON.stringify(delta)}`);
  measurements.push({ name: name + ' fresh media after source shutdown',
    sampleMs: after.at - before.at, identity, ...delta });
}
async function evidence(p, join) {
  await audio(p, join.customerIdentity, 440, 'operator decodes customer tone');
  const value = await p.page.evaluate(data => window.peerEvidence(data), join);
  assert.ok(value.inbound.packetsDelta > 0 && value.inbound.bytesDelta > 0 && value.inbound.decodedFramesDelta > 0);
  assert.ok(value.outbound.packetsDelta > 0 && value.outbound.bytesDelta > 0);
  delete value.after; delete value.decodedTone;
  return value;
}
let current;

before(async () => {
  assert.equal(process.env.SH_R13_REAL_MEDIA_TESTS, '1', 'Explicit local test opt-in required');
  await mkdir(OUT, { recursive: true });
  startingHashes=await sourceHashes();
  // An interrupted run must not leave an older passing manifest as its result.
  await writeFile(joinPath(OUT, 'verification.json'), JSON.stringify({ timestamp: new Date().toISOString(),
    status: 'running', passed: false, expectedScenarioCount: scenarioCount, sources: startingHashes }, null, 2) + '\n');
  await assertLocalPortsAvailable();
  const server = process.env.SH_LIVEKIT_SERVER || joinPath(TOOLING, 'server/livekit-server');
  const chrome = process.env.SH_TEST_CHROMIUM || chromium.executablePath();
  const java = process.env.SH_TEST_JAVA || 'java';
  const firestoreJar = process.env.SH_FIRESTORE_EMULATOR_JAR || joinPath(TOOLING, 'cloud-firestore-emulator-v1.19.8.jar');
  // Fixed loopback ports and a demo project prevent accidental production use.
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:18089';
  process.env.METADATA_SERVER_DETECTION = 'none'; // never probe cloud identity in an emulator-only suite
  start(server, ['--dev', '--bind', '127.0.0.1', '--node-ip', '127.0.0.1', '--udp-port', '17882',
    '--config-body', 'port: 17880\nrtc:\n  tcp_port: 17881\n  use_external_ip: false\n  enable_loopback_candidate: true\nlogging:\n  level: warn\n'], 'livekit.log');
  start(java, ['-jar', firestoreJar, '--host=127.0.0.1', '--port=18089', '--project_id=demo-sh-operator-r13'], 'firestore.log');
  await waitFor(async () => (await fetch(LK_HTTP)).ok, 'local LiveKit startup');
  await waitFor(async () => (await fetch('http://127.0.0.1:18089')).status > 0, 'Firestore emulator startup', 30000);
  db = new Firestore({ projectId: 'demo-sh-operator-r13' });
  rooms = new RoomServiceClient(LK_HTTP, LK_KEY, LK_SECRET, { failover: false, requestTimeout: 5 });
  const app = express(); app.use(express.json({ limit: '24kb' }));
  app.get('/peer', (_, res) => res.sendFile(joinPath(HERE, 'peer.html')));
  app.get('/livekit-client.umd.js', (_, res) => res.sendFile(joinPath(TOOLING, 'client/package/dist/livekit-client.umd.js')));
  // Mount the real production route handlers once, forwarding to this test's
  // real runtime instance. Synthetic credentials are test dependencies only.
  const delegated = new Proxy({}, { get: (_, key) => (...args) => current.bundle.runtime[key](...args) });
  mountNativeCallRoutes(app, { runtime: delegated, scheduleRecovery: () => {} });
  httpServer = await new Promise(resolve => { const server = app.listen(17883, '127.0.0.1', () => resolve(server)); });
  browser = await chromium.launch({ executablePath: chrome, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
}, { timeout: 90000 });

after(async () => {
  if (current) await current.close();
  await browser?.close(); await db?.terminate();
  await new Promise(resolve => httpServer ? httpServer.close(resolve) : resolve());
  for (const child of processes) child.kill('SIGTERM');
  for (const stream of files) stream.end();
  const sources = await sourceHashes(),sourcesUnchanged=JSON.stringify(sources)===JSON.stringify(startingHashes);
  await writeFile(joinPath(OUT, 'verification.json'), JSON.stringify({ timestamp: new Date().toISOString(),
    scope: 'Actual local LiveKit SFU + Chromium audio/WebRTC + Firestore SDK/emulator + application runtime/routes/readiness/transfer controller. External WhatsApp connector and Meta events are explicitly synthetic; no real phones, Meta, FCM, cloud or production deployment.',
    versions: { livekitServer: '1.13.11', livekitClient: '2.23.0', livekitServerSDK: '2.18.0', firestoreSDK: '8.7.1', firestoreEmulator: '1.19.8', node: process.version },
    status: 'completed', expectedScenarioCount: scenarioCount, sources, sourcesUnchanged, checks: results, measurements,
    passed: results.length === scenarioCount && scenarioCount > 0 && results.every(row => row.passed && row.status === 'completed') && sourcesUnchanged }, null, 2) + '\n');
  assert.ok(sourcesUnchanged,'tested source must not change during the run');
});

function scenario(name, fn) {
  scenarioCount++;
  test(name, { timeout: 90000 }, async t => {
    const started = performance.now();
    const row = { name, passed: false, status: 'running', durationMs: 0 }; results.push(row);
    const aborted = () => {
      if (row.status !== 'running') return;
      row.status = 'aborted'; row.error = 'Scenario aborted or timed out'; row.durationMs = performance.now() - started;
    };
    t.signal.addEventListener('abort', aborted, { once: true });
    try {
      console.error('SCENARIO',name);
      if (current) await current.close();
      console.error('PREVIOUS CLEANED',name);
      current = await fixture();
      await fn(current);
      assert.equal(t.signal.aborted, false, 'An aborted scenario cannot pass');
      row.status = 'completed'; row.passed = true;
    } catch (error) {
      row.passed = false;
      if (row.status !== 'aborted') row.status = 'failed';
      row.error ||= error.message;
      throw error;
    } finally {
      row.durationMs = performance.now() - started;
      t.signal.removeEventListener('abort', aborted);
    }
  });
}

async function fixture() {
  const prefix = `r13media_${randomUUID().replaceAll('-','')}`;
  const devices = new Map(['a','b'].map(deviceId => [deviceId, { deviceId, userId: `test:${deviceId}`,
    tenantId: 'smart-handicrafts', credentialGeneration: 1, credentialExpiresAt: Date.now()+3600000,
    nativeBuild: 13, mediaProtocol: 'sh-room-audio-v1', receiveCalls: true, revoked: false }]));
  const allPeers = [], customers = new Map(), effects = [], roomNames = new Set(), faults = {};
  const authenticate = async req => { const id = String(req.headers?.authorization || '').replace('Bearer local-test-','');
    const row = devices.get(id); return row ? { ...row, authenticated: true, canCall: true } : null; };
  const connectCustomer = async (callId, roomName, identity) => {
    if(customers.get(callId)?.peer) return customers.get(callId).peer;
    roomNames.add(roomName);
    const p = await peer({ url: LK_WS, token: await token(identity,roomName) },440);
    allPeers.push(p); customers.set(callId,{roomName,identity,peer:p}); return p;
  };
  // Only these four external connector APIs are simulated. The room control and
  // audio clients below are real and exchange actual encrypted RTP/decoded PCM.
  const connector = {
    async acceptWhatsAppCall(args) { effects.push({kind:'accept',callId:args.whatsappCallId});
      try { await connectCustomer(args.whatsappCallId,args.roomName,args.participantIdentity); } catch(error) { console.error('LOCAL CUSTOMER CONNECTION',error);throw error; }
      if(faults.loseAcceptAck){faults.loseAcceptAck=false;throw Error('SIMULATED_ACCEPT_ACK_LOSS_AFTER_REAL_CUSTOMER_JOIN');}
      return {roomName:args.roomName}; },
    async dialWhatsAppCall(args) { const callId=`sim-call-${randomUUID()}`; effects.push({kind:'dial',callId});
      roomNames.add(args.roomName); await rooms.createRoom({name:args.roomName,emptyTimeout:60});
      customers.set(callId,{roomName:args.roomName,identity:args.participantIdentity});
      if(faults.loseDialAck){faults.loseDialAck=false;throw Error('SIMULATED_DIAL_ACK_LOSS_AFTER_REAL_ROOM_CREATE');}
      return {whatsappCallId:callId,roomName:args.roomName}; },
    async connectWhatsAppCall(callId) {effects.push({kind:'connect',callId});const c=customers.get(callId);assert.ok(c);await connectCustomer(callId,c.roomName,c.identity);return{};},
    async disconnectWhatsAppCall(callId) {effects.push({kind:'terminate',callId});const c=customers.get(callId);
      if(c){try{await rooms.removeParticipant(c.roomName,c.identity);}catch(error){if(error.code!=='not_found')throw error;}}
      if(c?.peer){await c.peer.close();c.peer=null;}return{};}
  };
  const provider = new LiveKitWhatsAppProvider({origin:LK_HTTP,wsUrl:LK_WS,apiKey:LK_KEY,apiSecret:LK_SECRET,
    metaToken:'local-test-meta-not-a-credential',apiVersion:'26.0',fingerprint:'local-simulator-r13'}, {clients:{connector,rooms}});
  const store = createFirestoreMediaStore({firestore:db,collectionPrefix:prefix});
  const f={devices,effects,customers,provider,store,allPeers,connectCustomer,faults};
  f.build = async()=>{
    f.bundle=createNativeCallRuntime({store,provider,authenticate,resolveDevice:async id=>devices.get(id),listDevices:async()=>[...devices.values()],
      capabilities:async()=>({roomCalling:true,transferEnabled:true,mode:'pilot',pilotEnabled:true,pilotDeviceIds:['a','b']}),
      phoneNumberId:'local-business-id', minimumNativeBuild:13,
      rejectIncoming:async ({callId})=>effects.push({kind:'reject',callId}),notify:async event=>effects.push({kind:'notify',event:event.event})});
    await f.bundle.verifyConfiguration();
  };
  await f.build();
  f.api=async(device,method,path,body,expected=200)=>{
    const response=await fetch(HTTP+'/api/operator-android'+path,{method,signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json',Authorization:'Bearer local-test-'+device},...(body?{body:JSON.stringify(body)}:{})});
    const value=await response.json(); assert.equal(response.status,expected,JSON.stringify(value)); return value;
  };
  f.status=async(device,id)=>f.api(device,'GET',`/calls/${encodeURIComponent(id)}/status`);
  f.event=async(type,callId,extra={})=>f.bundle.runtime.ingestVerifiedMetaEvent({verified:true,eventId:`sim-${type}-${randomUUID()}`,
    type,callId,phoneNumberId:'local-business-id',occurredAtMs:Date.now(),...extra});
  f.incoming=async()=>{const callId='sim-in-'+randomUUID();await f.event('incoming',callId,{direction:'incoming',customerPhone:'919999999999',offerSdp:sdp});return callId;};
  f.operator=async(join,frequency=660)=>{const p=await peer(join,frequency);allPeers.push(p);return p;};
  f.ready=async(device,accepted,p)=>{
    const sample=await evidence(p,accepted.join),state=await f.status(device,accepted.call.sessionId);
    return f.api(device,'POST',`/calls/${accepted.call.sessionId}/ready`,{version:state.call.version,readinessNonce:accepted.readinessNonce,evidence:sample});
  };
  f.connected=async(device='a')=>{const id=await f.incoming();const accepted=await f.api(device,'POST',`/calls/${id}/accept`,{requestId:'accept-'+randomUUID()});
    const p=await f.operator(accepted.join,device==='a'?660:880);const state=await f.ready(device,accepted,p);return {id,accepted,p,state};};
  f.recover=async id=>{for(let i=0;i<3;i++)await f.bundle.runtime.recoverSession(id);};
  f.end=async(device,id,legId)=>{const state=await f.status(device,id);const started=performance.now();
    const ended=await f.api(device,'POST',`/calls/${id}/end`,{version:state.call.version,requestId:'end-'+randomUUID(),expectedOwnerLegId:legId});
    measurements.push({name:'local HTTP End commit acknowledgement',milliseconds:performance.now()-started});await f.recover(id);return ended;};
  f.invite=async(from,to,id)=>{const state=await f.status(from,id);return f.api(from,'POST',`/calls/${id}/transfers`,
    {version:state.call.version,toDeviceId:to,requestId:'transfer-'+randomUUID()});};
  f.handoff=async(from,to,id)=>{
    const invite=await f.invite(from,to,id),tr=invite.call.transfer.id;
    const targetAvailability=await f.status(to,id);
    assert.equal(targetAvailability.deviceAvailable,false,'a transfer invitation reserves its target globally');
    assert.equal(targetAvailability.deviceAvailableForCall,true,'the exact live invitation is available for this call');
    const accepted=await f.api(to,'POST',`/calls/${id}/transfers/${tr}/accept`,{version:invite.call.version});
    const p=await f.operator(accepted.join,to==='a'?660:880);
    const sample=await evidence(p,accepted.join),state=await f.status(to,id);
    const before=await rooms.listParticipants(accepted.join.roomName);
    const sourceIdentity=from==='a'?f.lastAIdentity:f.lastBIdentity;
    assert.ok(before.some(row=>row.identity===sourceIdentity),'original source is still present before readiness');
    const customer=customers.get(id).peer;
    await audio(customer,sourceIdentity,from==='a'?660:880,'customer still decodes source during accepted warm handoff');
    await audio(customer,accepted.join.identity,to==='a'?660:880,'customer decodes explicitly accepted target before handoff commit');
    const overlapObservedAt=performance.now();
    const committed=await f.api(to,'POST',`/calls/${id}/transfers/${tr}/ready`,{version:state.call.version,
      readinessNonce:accepted.readinessNonce,evidence:sample});
    await f.recover(id);
    assert.equal((await f.status(to,id)).deviceAvailableForCall,false,'the committed owner remains reserved');
    assert.equal((await f.status(from,id)).deviceAvailable,true,'source cleanup releases its reservation');
    await waitFor(async()=>!await customer.page.evaluate(identity=>window.hasRemoteTrack(identity),sourceIdentity),'customer unsubscribes old source after handoff');
    assert.ok(!(await rooms.listParticipants(accepted.join.roomName)).some(row=>row.identity===sourceIdentity));
    measurements.push({name:'accepted warm handoff overlap until old source unsubscribed',from,to,
      minimumObservedOverlapMs:performance.now()-overlapObservedAt,sourceIdentity,targetIdentity:accepted.join.identity});
    if(to==='a')f.lastAIdentity=accepted.join.identity;else f.lastBIdentity=accepted.join.identity;
    return {p,accepted,committed,transferId:tr};
  };
  f.close=async()=>{await Promise.allSettled(allPeers.map(p=>p.close()));await Promise.allSettled([...roomNames].map(name=>rooms.deleteRoom(name)));};
  return f;
}

scenario('real incoming: exact production readiness verifies bidirectional RTP and decoded tones',async f=>{
  const {id,accepted,p,state}=await f.connected();assert.equal(state.call.roomReady,true);assert.equal(state.call.phase,'connected');
  assert.equal((await f.status('a',id)).deviceAvailable,false);
  assert.equal((await f.status('a',id)).deviceAvailableForCall,false);
  assert.equal((await f.status('b',id)).deviceAvailable,true);
  assert.equal((await f.status('b',id)).deviceAvailableForCall,true);
  await audio(f.customers.get(id).peer,accepted.join.identity,660,'customer decodes operator A tone');
  assert.equal(f.effects.filter(e=>e.kind==='accept').length,1);assert.deepEqual(p.errors,[]);
  const waiting=await f.incoming(),requestId='waiting-answer-'+randomUUID();
  const busy=await f.api('a','POST',`/calls/${waiting}/accept`,{requestId},409);
  assert.equal(busy.code,'DEVICE_BUSY');
  const current=await f.status('a',id);
  await f.api('a','POST',`/calls/${id}/end`,{version:current.call.version,
    requestId:'end-before-waiting-'+randomUUID(),expectedOwnerLegId:accepted.join.legId});
  assert.equal((await f.status('a',waiting)).deviceAvailable,false,
    'an End acknowledgement must not promise that durable cleanup has released the device');
  const cleaning=await f.api('a','POST',`/calls/${waiting}/accept`,{requestId},409);
  assert.equal(cleaning.code,'DEVICE_BUSY');
  assert.equal(f.effects.filter(e=>e.kind==='accept'&&e.callId===waiting).length,0);
  await f.recover(id);
  assert.equal((await f.status('a',waiting)).deviceAvailable,true);
  const next=await f.api('a','POST',`/calls/${waiting}/accept`,{requestId});
  const nextPeer=await f.operator(next.join);await f.ready('a',next,nextPeer);
  await audio(f.customers.get(waiting).peer,next.join.identity,660,'waiting caller hears operator after prior cleanup');
  const replay=await f.api('a','POST',`/calls/${waiting}/accept`,{requestId});
  assert.equal(replay.join.identity,next.join.identity);
  assert.equal(f.effects.filter(e=>e.kind==='accept'&&e.callId===waiting).length,1,
    'retrying the same busy Answer request and replaying success must issue only one external accept');
});

scenario('initial acoustic silence establishes real RTP and decoded readiness before the customer speaks',async f=>{
  const id=await f.incoming();
  const accepted=await f.api('a','POST',`/calls/${id}/accept`,{requestId:'silent-start-'+randomUUID()});
  const customer=f.customers.get(id).peer;
  await customer.page.evaluate(()=>window.setSilence(true));
  const p=await f.operator(accepted.join);
  await waitFor(async()=>{const row=await p.page.evaluate(id=>window.peerSnapshot(id),accepted.join.customerIdentity);
    return row.inbound.packets>20&&row.outbound.packets>20&&row.frames>20000&&row.rms<.001;},'initial silence with real RTP and playout samples');
  const sample=await p.page.evaluate(join=>window.peerEvidence(join),accepted.join);
  delete sample.after;delete sample.decodedTone;
  const state=await f.status('a',id);
  const ready=await f.api('a','POST',`/calls/${id}/ready`,{version:state.call.version,readinessNonce:accepted.readinessNonce,evidence:sample});
  assert.equal(ready.call.phase,'connected');assert.equal(ready.call.mediaReadiness.bidirectionalAudioVerifiedAtReady,true);
  measurements.push({name:'initial acoustic silence with actual transport progress',inbound:sample.inbound,outbound:sample.outbound});
  await customer.page.evaluate(()=>window.setSilence(false));
  await audio(p,accepted.join.customerIdentity,440,'customer starts speaking after silent initial connection');
  await audio(customer,accepted.join.identity,660,'customer hears operator after silent initial connection');
});

scenario('initial provider-confirmed customer mute connects transport honestly and later resumes two-way audio',async f=>{
  const id=await f.incoming();
  const accepted=await f.api('a','POST',`/calls/${id}/accept`,{requestId:'muted-start-'+randomUUID()});
  const customer=f.customers.get(id).peer;
  await customer.page.evaluate(()=>window.setMute(true));
  await waitFor(async()=>{const rows=await rooms.listParticipants(accepted.join.roomName);
    return rows.find(row=>row.identity===accepted.join.customerIdentity)?.tracks.some(track=>track.muted);},'provider observes initial customer mute');
  const p=await f.operator(accepted.join);
  await waitFor(async()=>{const row=await p.page.evaluate(id=>window.peerSnapshot(id),accepted.join.customerIdentity);
    return row.state==='connected'&&row.outbound.packets>20&&row.customerAudioTrackSid;},'exact muted customer track subscribed with outgoing RTP');
  const sample=await p.page.evaluate(join=>window.peerEvidence(join),accepted.join);
  delete sample.after;delete sample.decodedTone;
  Object.assign(sample,{readinessMode:'customer-muted-transport',customerMuted:true,customerTrackSubscribed:true});
  const state=await f.status('a',id);
  const ready=await f.api('a','POST',`/calls/${id}/ready`,{version:state.call.version,readinessNonce:accepted.readinessNonce,evidence:sample});
  assert.equal(ready.call.phase,'connected');assert.equal(ready.call.roomReady,true);
  assert.equal(ready.call.mediaReadiness.mode,'customer-muted-transport');
  assert.equal(ready.call.mediaReadiness.bidirectionalAudioVerifiedAtReady,false);
  assert.equal(sample.inbound.packetsDelta,0,'mute must not manufacture received media packets');
  measurements.push({name:'initial muted transport proof (not bidirectional audio)',inbound:sample.inbound,outbound:sample.outbound,
    mediaReadiness:ready.call.mediaReadiness});
  await f.recover(id);assert.equal((await f.status('a',id)).call.phase,'connected');
  const invitation=await f.invite('a','b',id),transferId=invitation.call.transfer.id;
  const targetAccepted=await f.api('b','POST',`/calls/${id}/transfers/${transferId}/accept`,{version:invitation.call.version});
  const target=await f.operator(targetAccepted.join,880);
  await waitFor(async()=>{const row=await target.page.evaluate(id=>window.peerSnapshot(id),targetAccepted.join.customerIdentity);
    return row.outbound.packets>20&&row.customerAudioTrackSid;},'muted-customer target transport');
  const targetSample=await target.page.evaluate(join=>window.peerEvidence(join),targetAccepted.join);
  delete targetSample.after;delete targetSample.decodedTone;
  Object.assign(targetSample,{readinessMode:'customer-muted-transport',customerMuted:true,customerTrackSubscribed:true});
  const targetState=await f.status('b',id);
  const refused=await f.api('b','POST',`/calls/${id}/transfers/${transferId}/ready`,{version:targetState.call.version,
    readinessNonce:targetAccepted.readinessNonce,evidence:targetSample},409);
  assert.equal(refused.code,'MEDIA_NOT_READY');
  const preserved=await f.status('a',id);assert.equal(preserved.call.ownerDeviceId,'a');
  assert.ok((await rooms.listParticipants(accepted.join.roomName)).some(row=>row.identity===accepted.join.identity));
  await waitFor(async()=>{const row=await customer.page.evaluate(id=>window.peerSnapshot(id),accepted.join.identity);
    return row.inbound.packets>20&&row.rms>.015&&Math.abs(row.frequency-660)<30;},'muted customer still hears original operator during deferred transfer');
  await f.api('a','POST',`/calls/${id}/transfers/${transferId}/cancel`,{version:preserved.call.version});await f.recover(id);
  assert.equal(await f.store.get(deviceReservationKey('b')),undefined);
  measurements.push({name:'muted-only target readiness defers handoff without removing original source',
    errorCode:refused.code,preservedOwner:preserved.call.ownerDeviceId});
  await customer.page.evaluate(()=>window.setMute(false));
  await audio(p,accepted.join.customerIdentity,440,'customer unmute restores inbound decoded audio');
  await audio(customer,accepted.join.identity,660,'customer hears operator after initial mute');
  assert.equal(f.effects.filter(effect=>effect.kind==='accept').length,1);
});

scenario('real outgoing: customer answer, 25-second healthy call, silence, mute and immediate callback',async f=>{
  const outgoing=await f.api('a','POST','/calls/outgoing',{to:'919999999999',requestId:'out-'+randomUUID()});
  const p=await f.operator(outgoing.join);const id=outgoing.call.sessionId,callId=outgoing.call.callId;
  assert.equal((await f.status('a',id)).call.roomReady,false);
  await f.event('connect',callId,{answerSdp:sdp});await f.recover(id);
  const earlyEvidence=await evidence(p,outgoing.join),earlyState=await f.status('a',id);
  const early=await f.api('a','POST',`/calls/${id}/ready`,{version:earlyState.call.version,
    readinessNonce:outgoing.readinessNonce,evidence:earlyEvidence},409);
  assert.equal(early.code,'CUSTOMER_NOT_ACCEPTED','even real early RTP is not a trusted recipient answer');
  await f.event('accepted',callId);
  const ready=await f.ready('a',outgoing,p);assert.equal(ready.call.phase,'connected');
  const customer=f.customers.get(callId).peer;
  await audio(customer,outgoing.join.identity,660,'outgoing customer decodes operator tone');
  const before=await p.page.evaluate(id=>window.peerSnapshot(id),outgoing.join.customerIdentity);
  // A real elapsed interval exceeds the reported 15–20 second disconnect window.
  for(let i=0;i<5;i++){await pause(5000);await f.recover(id);assert.equal((await f.status('a',id)).call.phase,'connected');}
  const after=await audio(p,outgoing.join.customerIdentity,440,'healthy audio after 25 seconds');
  assert.ok(after.inbound.packets-before.inbound.packets>700);
  await customer.page.evaluate(()=>window.setSilence(true));
  await waitFor(async()=>{const r=await p.page.evaluate(id=>window.peerSnapshot(id),outgoing.join.customerIdentity);return r.rms<.001&&r.inbound.packets>after.inbound.packets+20;},'decoded silence with transport progress');
  await f.recover(id);assert.equal((await f.status('a',id)).call.phase,'connected');
  await customer.page.evaluate(()=>window.setSilence(false));await audio(p,outgoing.join.customerIdentity,440,'audio resumes after silence');
  await p.page.evaluate(()=>window.setMute(true));
  await waitFor(async()=>{const rows=await rooms.listParticipants(outgoing.join.roomName);return rows.find(row=>row.identity===outgoing.join.identity)?.tracks.some(t=>t.muted);},'provider observes actual microphone mute');
  await f.recover(id);assert.equal((await f.status('a',id)).call.phase,'connected');
  await p.page.evaluate(()=>window.setMute(false));await audio(customer,outgoing.join.identity,660,'customer hears unmuted tone again');
  await f.end('a',id,outgoing.join.legId);assert.equal(await f.store.get(deviceReservationKey('a')),undefined);
  assert.equal((await f.status('a',id)).deviceAvailable,true);
  assert.equal((await rooms.listParticipants(outgoing.join.roomName)).length,0);
  const next=await f.connected();assert.equal(next.state.call.roomReady,true);
  assert.equal((await f.status('a',next.id)).deviceAvailable,false);
  await audio(f.customers.get(next.id).peer,next.accepted.join.identity,660,'immediate callback two-way audio');
});

scenario('competing incoming answers: actual transactions choose one owner and one customer audio leg',async f=>{
  const id=await f.incoming();
  const call=async device=>{const started=performance.now();const r=await fetch(HTTP+`/api/operator-android/calls/${id}/accept`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer local-test-'+device},body:JSON.stringify({requestId:'race-'+device+randomUUID()})});return {device,status:r.status,body:await r.json(),milliseconds:performance.now()-started};};
  const attempts=await Promise.all([call('a'),call('b')]);
  measurements.push({name:'real Firestore competing Answer response times',attempts:attempts.map(({device,status,milliseconds})=>({device,status,milliseconds}))});
  assert.equal(attempts.filter(r=>r.status===200).length,1);
  const winner=attempts.find(r=>r.status===200),loser=attempts.find(r=>r.status!==200);
  assert.ok([403,409].includes(loser.status),JSON.stringify({status:loser.status,body:loser.body}));assert.equal(f.effects.filter(r=>r.kind==='accept').length,1);
  const p=await f.operator(winner.body.join,winner.device==='a'?660:880);await f.ready(winner.device,winner.body,p);
  assert.equal((await f.status(winner.device,id)).deviceAvailable,false);
  assert.equal((await f.status(loser.device,id)).deviceAvailable,true);
  await audio(f.customers.get(id).peer,winner.body.join.identity,winner.device==='a'?660:880,'winning phone audio only');
  const participants=await rooms.listParticipants(winner.body.join.roomName);assert.equal(participants.length,2);
  const stale=await f.api(loser.device,'POST',`/calls/${id}/end`,{version:(await f.status(winner.device,id)).call.version,requestId:'loser-end-'+randomUUID()},403);
  assert.equal(stale.code,'NOT_CALL_OWNER');
});

scenario('decline and customer-cancel before answer never create media and release the next call',async f=>{
  const id=await f.incoming(),state=await f.status('a',id);
  await f.api('a','POST',`/calls/${id}/reject`,{version:state.call.version,requestId:'reject-'+randomUUID()});await f.recover(id);
  assert.equal(f.effects.filter(e=>e.kind==='reject').length,1);assert.equal(f.effects.filter(e=>e.kind==='accept').length,0);
  assert.equal(await f.store.get(deviceReservationKey('a')),undefined);
  const id2=await f.incoming();await f.event('terminate',id2);await f.recover(id2);
  const late=await f.api('a','POST',`/calls/${id2}/accept`,{requestId:'late-'+randomUUID()},409);assert.ok(late.code);
  assert.equal(f.effects.filter(e=>e.kind==='accept').length,0);
  const good=await f.connected();assert.equal(good.state.call.roomReady,true);
});

scenario('real A-to-B-to-A audio handoff survives source shutdown and rejects old-leg End',async f=>{
  const original=await f.connected();f.lastAIdentity=original.accepted.join.identity;const id=original.id;
  const customer=f.customers.get(id).peer;
  const customerSession=await customer.page.evaluate(()=>window.peerSnapshot('unsubscribed'));
  const toB=await f.handoff('a','b',id);
  assert.equal(toB.committed.call.ownerDeviceId,'b');
  await audio(customer,toB.accepted.join.identity,880,'customer decodes operator B after A detaches');
  await audio(toB.p,toB.accepted.join.customerIdentity,440,'B decodes customer after A detaches');
  assert.equal(await f.store.get(deviceReservationKey('a')),undefined);
  assert.equal((await original.p.page.evaluate(()=>window.peerSnapshot('missing'))).state,'disconnected');
  await original.p.context.setOffline(true);
  await original.p.close();
  await continuingAudio(customer,toB.accepted.join.identity,880,'customer hears B with original A shut down');
  await continuingAudio(toB.p,toB.accepted.join.customerIdentity,440,'B hears customer with original A shut down');
  const toA=await f.handoff('b','a',id);
  assert.notEqual(toA.accepted.join.identity,original.accepted.join.identity);
  await audio(customer,toA.accepted.join.identity,660,'customer decodes new operator A leg after transfer back');
  await audio(toA.p,toA.accepted.join.customerIdentity,440,'new A leg decodes customer after transfer back');
  await toB.p.context.setOffline(true);
  await toB.p.close();
  await continuingAudio(customer,toA.accepted.join.identity,660,'customer hears new A with B shut down');
  await continuingAudio(toA.p,toA.accepted.join.customerIdentity,440,'new A hears customer with B shut down');
  const customerAfter=await customer.page.evaluate(()=>window.peerSnapshot('unsubscribed'));
  assert.equal(customerAfter.participantSid,customerSession.participantSid,'customer remained the same live room participant');
  assert.equal(f.effects.filter(e=>e.kind==='accept').length,1);assert.equal(f.effects.filter(e=>e.kind==='terminate').length,0);
  const state=await f.status('a',id);
  const stale=await f.api('a','POST',`/calls/${id}/end`,{version:state.call.version,requestId:'old-leg-'+randomUUID(),expectedOwnerLegId:original.accepted.join.legId},409);
  assert.equal(stale.code,'CALL_LEG_CHANGED');
  assert.equal((await f.status('a',id)).call.phase,'connected');
  await f.end('a',id,toA.accepted.join.legId);
  assert.equal(await f.store.get(deviceReservationKey('a')),undefined);assert.equal(await f.store.get(deviceReservationKey('b')),undefined);
});

scenario('transfer decline and target missing audio preserve source media; false evidence cannot commit',async f=>{
  const original=await f.connected(),id=original.id;f.lastAIdentity=original.accepted.join.identity;
  const invite=await f.invite('a','b',id),tr=invite.call.transfer.id;
  assert.equal(invite.join,undefined,'unaccepted invitation receives no room token');
  assert.equal((await rooms.listParticipants(original.accepted.join.roomName)).length,2,'only source and customer are in the room before target accepts');
  await f.api('b','POST',`/calls/${id}/transfers/${tr}/decline`,{version:invite.call.version});await f.recover(id);
  assert.equal((await rooms.listParticipants(original.accepted.join.roomName)).length,2,'declining never joins customer media');
  assert.equal(await f.store.get(deviceReservationKey('b')),undefined);
  await audio(original.p,original.accepted.join.customerIdentity,440,'source continues after target declines');
  const invite2=await f.invite('a','b',id),tr2=invite2.call.transfer.id;
  const accepted=await f.api('b','POST',`/calls/${id}/transfers/${tr2}/accept`,{version:invite2.call.version});
  const bad=await f.api('b','POST',`/calls/${id}/transfers/${tr2}/ready`,{version:accepted.call.version,readinessNonce:accepted.readinessNonce,evidence:{protocol:'sh-room-audio-v1'}},409);
  assert.equal(bad.code,'MEDIA_NOT_READY');
  assert.equal((await f.status('a',id)).call.ownerDeviceId,'a');
  await audio(f.customers.get(id).peer,original.accepted.join.identity,660,'customer retains source after invalid readiness');
  const state=await f.status('a',id);await f.api('a','POST',`/calls/${id}/transfers/${tr2}/cancel`,{version:state.call.version});await f.recover(id);
  assert.equal(await f.store.get(deviceReservationKey('b')),undefined);
});

scenario('runtime restart reloads Firestore ownership without creating a second customer call',async f=>{
  const original=await f.connected(),id=original.id;
  const oldBundle=f.bundle;await f.build();assert.notEqual(f.bundle,oldBundle);
  const state=await f.status('a',id);assert.equal(state.call.phase,'connected');
  await f.recover(id);
  await audio(original.p,original.accepted.join.customerIdentity,440,'customer audio survives coordinator recreation');
  await audio(f.customers.get(id).peer,original.accepted.join.identity,660,'operator audio survives coordinator recreation');
  assert.equal(f.effects.filter(e=>e.kind==='accept').length,1);
  const resumed=await f.api('a','POST',`/calls/${id}/accept`,{requestId:'resume-'+randomUUID()});
  assert.equal(resumed.join.identity,original.accepted.join.identity);
  await f.end('a',id,original.accepted.join.legId);assert.equal(await f.store.get(deviceReservationKey('a')),undefined);
});

scenario('customer hangs up during transfer: terminal state wins and both real operator legs disconnect',async f=>{
  const original=await f.connected(),id=original.id;
  const invite=await f.invite('a','b',id),tr=invite.call.transfer.id;
  const accepted=await f.api('b','POST',`/calls/${id}/transfers/${tr}/accept`,{version:invite.call.version});
  const target=await f.operator(accepted.join,880);const sample=await evidence(target,accepted.join);
  await f.customers.get(id).peer.close();await f.event('terminate',id);await f.recover(id);
  const late=await f.api('b','POST',`/calls/${id}/transfers/${tr}/ready`,{version:accepted.call.version,readinessNonce:accepted.readinessNonce,evidence:sample},409);
  assert.equal(late.code,'CALL_ENDED');
  assert.equal((await f.status('a',id)).call.terminal!==null,true);
  assert.equal(await f.store.get(deviceReservationKey('a')),undefined);assert.equal(await f.store.get(deviceReservationKey('b')),undefined);
  assert.equal((await rooms.listParticipants(accepted.join.roomName)).length,0);
});

scenario('real route boundary rejects unauthenticated, invalid and revoked-device mutations',async f=>{
  await f.api('unknown','GET','/capabilities',null,401);
  await f.api('a','POST','/calls/outgoing',[],400);
  const good=await f.connected();f.devices.get('a').revoked=true;
  await f.api('a','POST',`/calls/${good.id}/end`,{version:good.state.call.version,requestId:'revoked-'+randomUUID()},403);
  await f.recover(good.id);
  assert.equal(await f.store.get(deviceReservationKey('a')),undefined);
  assert.equal((await rooms.listParticipants(good.accepted.join.roomName)).length,0);
});

scenario('lost Accept acknowledgement resumes the original actual media leg without accepting twice',async f=>{
  f.faults.loseAcceptAck=true;const id=await f.incoming(),requestId='lost-accept-'+randomUUID();
  // The production runtime observes the actual customer participant after the
  // ambiguous provider ACK and safely recovers this very request.
  const lost=await f.api('a','POST',`/calls/${id}/accept`,{requestId});assert.ok(lost.join);
  const accepted=await f.api('a','POST',`/calls/${id}/accept`,{requestId});
  assert.equal(accepted.join.legId,lost.join.legId);assert.equal(f.faults.loseAcceptAck,false);
  const p=await f.operator(accepted.join);await f.ready('a',accepted,p);
  await audio(f.customers.get(id).peer,accepted.join.identity,660,'customer hears original call after lost Accept acknowledgement');
  assert.equal(f.effects.filter(e=>e.kind==='accept').length,1);
  assert.equal((await rooms.listParticipants(accepted.join.roomName)).length,2);
});

scenario('lost Dial acknowledgement plus early answer reconnects exact original call and one audio leg',async f=>{
  f.faults.loseDialAck=true;const requestId='lost-dial-'+randomUUID();
  const lost=await f.api('a','POST','/calls/outgoing',{to:'919999999999',requestId},502);assert.equal(lost.code,'MEDIA_REQUEST_UNCERTAIN');
  assert.equal((await f.status('a',lost.sessionId)).deviceAvailable,false);
  const callId=f.effects.find(e=>e.kind==='dial').callId;
  await f.event('connect',callId,{answerSdp:sdp,opaqueSessionId:lost.sessionId});
  await f.event('accepted',callId,{opaqueSessionId:lost.sessionId});await f.recover(lost.sessionId);
  const accepted=await f.api('a','POST',`/calls/${lost.sessionId}/accept`,{requestId});
  const p=await f.operator(accepted.join);await f.ready('a',accepted,p);
  await audio(f.customers.get(callId).peer,accepted.join.identity,660,'customer hears recovered outgoing call');
  assert.equal(f.effects.filter(e=>e.kind==='dial').length,1);assert.equal(f.effects.filter(e=>e.kind==='connect').length,1);
});

scenario('duplicate End after an ignored HTTP acknowledgement cannot leave busy reservations or repeat customer termination',async f=>{
  const original=await f.connected(),id=original.id,body={version:original.state.call.version,
    requestId:'same-end-'+randomUUID(),expectedOwnerLegId:original.accepted.join.legId};
  await f.api('a','POST',`/calls/${id}/end`,body);await f.recover(id);
  await f.api('a','POST',`/calls/${id}/end`,body);await f.recover(id);
  assert.equal(await f.store.get(deviceReservationKey('a')),undefined);
  assert.equal(f.effects.filter(e=>e.kind==='terminate').length,1);
  const next=await f.connected();assert.equal(next.state.call.roomReady,true);
});

scenario('actual SDK signaling and full WebRTC reconnection restore both decoded audio directions',async f=>{
  const original=await f.connected(),id=original.id,customer=f.customers.get(id).peer;
  await audio(customer,original.accepted.join.identity,660,'customer audio before reconnect');
  const start=performance.now();
  // Official SDK fault injection closes/replaces actual transports; no test code
  // writes a fake Connected state or manufactures the audio counters.
  await original.p.page.evaluate(()=>window.faultScenario('signal-reconnect',250));
  await audio(original.p,original.accepted.join.customerIdentity,440,'customer tone after signaling reconnect');
  await original.p.page.evaluate(()=>window.faultScenario('full-reconnect'));
  const restored=await waitFor(async()=>{
    const row=await original.p.page.evaluate(id=>window.peerSnapshot(id),original.accepted.join.customerIdentity);
    return row.state==='connected'&&row.events.some(e=>e.type==='connection'&&e.state==='reconnecting')&&
      row.inbound.packets>20&&row.rms>.015&&Math.abs(row.frequency-440)<30?row:false;
  },'full media reconnection and newly decoded customer tone',25000);
  await audio(customer,original.accepted.join.identity,660,'customer decodes operator after full reconnect');
  await f.recover(id);assert.equal((await f.status('a',id)).call.phase,'connected');
  assert.equal(f.effects.filter(e=>e.kind==='accept').length,1);
  measurements.push({name:'local signaling plus full reconnect with recovered decoded audio',milliseconds:performance.now()-start,events:restored.events});
});

scenario('real invitation timeout releases target while customer and source audio continue',async f=>{
  const original=await f.connected(),id=original.id;
  // Use the production controller's minimum supported invitation period to
  // exercise a real elapsed expiry without manipulating the application clock.
  f.bundle.controller.invitationMs=15000;
  const invite=await f.invite('a','b',id);assert.equal(invite.call.transfer.status,'invited');
  assert.equal(invite.join,undefined);assert.equal((await rooms.listParticipants(original.accepted.join.roomName)).length,2);
  await pause(15200);await f.recover(id);
  const state=await f.status('a',id);assert.equal(state.call.transfer.status,'expired');assert.equal(state.call.ownerDeviceId,'a');
  assert.equal(await f.store.get(deviceReservationKey('b')),undefined);
  await audio(original.p,original.accepted.join.customerIdentity,440,'source continues after real invitation timeout');
  await audio(f.customers.get(id).peer,original.accepted.join.identity,660,'customer continues after real invitation timeout');
  const late=await f.api('b','POST',`/calls/${id}/transfers/${invite.call.transfer.id}/accept`,{version:state.call.version},409);
  assert.equal(late.code,'TRANSFER_EXPIRED');
});

scenario('one-way microphone publication cannot become Connected until both actual directions recover',async f=>{
  const id=await f.incoming(),accepted=await f.api('a','POST',`/calls/${id}/accept`,{requestId:'one-way-'+randomUUID()});
  const p=await f.operator(accepted.join),customer=f.customers.get(id).peer;
  await audio(p,accepted.join.customerIdentity,440,'customer audio before one-way fault');
  await p.page.evaluate(()=>window.setMute(true));
  await waitFor(async()=>{const rows=await rooms.listParticipants(accepted.join.roomName);return rows.find(r=>r.identity===accepted.join.identity)?.tracks.some(t=>t.muted);},'real operator publication is muted');
  const operatorMuted=await p.page.evaluate(join=>window.peerEvidence(join),accepted.join),state=await f.status('a',id);
  const rejected=await f.api('a','POST',`/calls/${id}/ready`,{version:state.call.version,readinessNonce:accepted.readinessNonce,evidence:operatorMuted},409);
  assert.equal(rejected.code,'MEDIA_NOT_READY');assert.equal((await f.status('a',id)).call.roomReady,false);
  await p.page.evaluate(()=>window.setMute(false));await customer.page.evaluate(()=>window.setMute(true));
  await waitFor(async()=>{const rows=await rooms.listParticipants(accepted.join.roomName);return rows.find(r=>r.identity===accepted.join.customerIdentity)?.tracks.some(t=>t.muted);},'real customer publication is muted');
  const customerMuted=await p.page.evaluate(join=>window.peerEvidence(join),accepted.join),fresh=await f.status('a',id);
  const alsoRejected=await f.api('a','POST',`/calls/${id}/ready`,{version:fresh.call.version,readinessNonce:accepted.readinessNonce,evidence:customerMuted},409);
  assert.equal(alsoRejected.code,'MEDIA_NOT_READY');assert.equal((await f.status('a',id)).call.roomReady,false);
  await customer.page.evaluate(()=>window.setMute(false));const ready=await f.ready('a',accepted,p);assert.equal(ready.call.phase,'connected');
  await audio(customer,accepted.join.identity,660,'both audio directions recover before Connected');
});
