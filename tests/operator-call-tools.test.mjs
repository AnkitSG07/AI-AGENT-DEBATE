import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { OdooCallFiles, wavHeader } from '../call-runtime/odoo-call-files.mjs';
import { CallTools } from '../call-runtime/call-tools.mjs';
import { CallAudioManager } from '../media/call-audio-manager.mjs';
import { DeviceRecording } from '../call-runtime/device-recording.mjs';
import { MediaUsage, monthlySlices } from '../call-runtime/media-usage.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const call = { id: 'call-tools-test', active: true, roomName: 'room-tools-test', customerIdentity: 'customer', owner: { identity: 'A', deviceId: 'a' } };
function audioFixture(options = {}) {
  const children = [], parts = [], manifest = [];
  const files = { beginRecording: async (...args) => { manifest.push(args); }, savePart: async (...args) => { parts.push(args); }, ...options.files };
  const manager = new CallAudioManager({ provider: { config: { apiKey: 'devkey', apiSecret: 'development-key-for-isolated-unit-test', wsUrl: 'ws://127.0.0.1:17880' } },
    ...options, files, spawn: () => {
      const child = new EventEmitter(); child.connected = true; child.commands = []; children.push(child);
      child.kill = () => { child.connected = false; child.emit('exit'); };
      child.send = (message, callback) => {
        child.commands.push(message); callback?.();
        queueMicrotask(() => {
          if (!child.connected) return;
          if (message.type === 'connect') {
            if (options.connectGate) void options.connectGate.then(() => child.emit('message', { type: 'ready' }));
            else child.emit('message', { type: 'ready' });
          }
          if (message.type === 'prepare-hold') child.emit('message', { type: 'prepared' });
          if (message.type === 'record') child.emit('message', { type: 'recording' });
          if (message.type === 'stop-record') child.emit('message', { type: 'stopped' });
          if (message.type === 'close') child.kill();
        });
      };
      return child;
    } });
  return { manager, children, parts, manifest };
}

test('concurrent recording starts with one request use one worker and one recording', async () => {
  const f = audioFixture();
  const [a, b] = await Promise.all([f.manager.start(call, { deviceId: 'a' }, 'record-request-1'), f.manager.start(call, { deviceId: 'a' }, 'record-request-1')]);
  assert.equal(f.children.length, 1); assert.equal(f.manifest.length, 1); assert.equal(a.id, b.id);
  assert.equal(f.children[0].commands.filter(item => item.type === 'record').length, 1);
  await assert.rejects(f.manager.start(call, { deviceId: 'a' }, 'different-request'), error => error.code === 'RECORDING_ACTIVE');
  f.manager.close(call.id); await tick();
});

test('simultaneous hold preparation and recording reuse the same media connection', async () => {
  const f = audioFixture();
  await Promise.all([f.manager.prepareHold(call), f.manager.prepareHold(call), f.manager.start(call, { deviceId: 'a' }, 'record-request-1')]);
  assert.equal(f.children.length, 1); assert.equal(f.manager.healthyHold(call.id), true);
  assert.equal(f.children[0].commands.filter(item => item.type === 'prepare-hold').length, 1);
  f.manager.close(call.id); await tick();
});

test('hangup before worker authorization resolves cannot start a late media worker', async () => {
  const f = audioFixture(); const pending = f.manager.ensure(call); f.manager.close(call.id);
  await assert.rejects(pending, error => error.code === 'CALL_AUDIO_CLOSED'); assert.equal(f.children.length, 0);
});

test('ordinary status polling cannot close a media worker while it is starting', async () => {
  const gate = deferred(); const f = audioFixture({ connectGate: gate.promise });
  const pending = f.manager.ensure(call); await tick(); await tick();
  assert.equal(f.children.length, 1); f.manager.sync(call);
  assert.equal(f.children[0].commands.some(item => item.type === 'close'), false);
  gate.resolve(); await pending; f.manager.close(call.id); await tick();
});

test('stop during slow Odoo manifest creation cannot start recording afterward', async () => {
  const gate = deferred(), entered = deferred();
  const f = audioFixture({ files: { beginRecording: async () => { entered.resolve(); await gate.promise; } } });
  const pending = f.manager.start(call, { deviceId: 'a' }, 'record-request-1');
  await entered.promise; f.manager.stop(call.id); gate.resolve(); await pending; await tick();
  assert.equal(f.children[0].commands.some(item => item.type === 'record'), false);
  f.manager.close(call.id); await tick();
});

test('recording storage backlog releases the unused recorder while preserving queued uploads', async () => {
  const gate = deferred(); const f = audioFixture({ files: { savePart: async () => gate.promise } });
  await f.manager.start(call, { deviceId: 'a' }, 'record-request-1');
  const child = f.children[0], id = f.manager.state(call.id).id;
  for (let index = 0; index < 7; index++) child.emit('message', { type: 'part', recordingId: id, index, pcm: Buffer.alloc(320) });
  assert.equal(f.manager.calls.get(call.id).pending, 4); assert.equal(f.manager.state(call.id).state, 'failed');
  await tick(); // The worker acknowledges that final PCM has crossed IPC.
  assert.equal(child.commands.some(item => item.type === 'close'), true);
  gate.resolve(); await f.manager.calls.get(call.id).queue;
  assert.equal(f.manager.calls.get(call.id).pending, 0);
  f.manager.close(call.id); await tick();
});

test('a failed held-call worker requests recovery while ordinary recording failure does not', async () => {
  const failed = []; const f = audioFixture({ onHoldFailure: id => failed.push(id) });
  await f.manager.prepareHold(call);
  f.manager.sync({ ...call, transfer: { mode: 'consult', status: 'connecting', consultStage: 'private', targetIdentity: 'B' } });
  f.children[0].kill(); await tick(); assert.deepEqual(failed, [call.id]); assert.equal(f.manager.healthyHold(call.id), false);
});

function odooFixture() {
  let now = 1000; const rows = [];
  const files = new OdooCallFiles({ now: () => ++now, execute: async (model, method, args, kwargs = {}) => {
    assert.equal(model, 'ir.attachment');
    if (method === 'create') { const row = { ...args[0], id: rows.length + 1, file_size: Buffer.from(args[0].datas, 'base64').length }; rows.push(row); return row.id; }
    if (method === 'read') return rows.filter(row => args[0].includes(row.id));
    if (method === 'write') { for (const row of rows.filter(row => args[0].includes(row.id))) Object.assign(row, args[1]); return true; }
    assert.equal(method, 'search_read');
    const result = rows.filter(row => args[0].every(([key, operator, value]) => operator === '=' ? row[key] === value : String(row[key]).startsWith(value.slice(0, -1))));
    return result.reverse().slice(0, kwargs.limit).map(row => Object.fromEntries(kwargs.fields.map(key => [key, row[key]])));
  } });
  return { files, rows };
}

test('notes are private, editable only by their author, and a retry cannot change saved text', async () => {
  const { files, rows } = odooFixture(); const a = { deviceId: 'a' }, body = { noteId: 'note-id-1234', requestId: 'save-id-1234', text: 'हिन्दी and English' };
  await files.saveNote('call-1', a, body); await files.saveNote('call-1', a, body);
  assert.equal(rows.length, 1); assert.equal(rows[0].public, false);
  await assert.rejects(files.saveNote('call-1', { deviceId: 'b' }, { ...body, requestId: 'save-id-other' }), error => error.code === 'NOTE_OWNER_REQUIRED');
  await assert.rejects(files.saveNote('call-1', a, { ...body, text: 'changed retry' }), error => error.code === 'NOTE_SAVE_CONFLICT');
  await files.saveNote('call-1', a, { ...body, requestId: 'save-id-edit', text: 'Updated requirements' });
  assert.deepEqual((await files.notes('call-1')).map(row => row.text), ['Updated requirements']);
});

test('recorded WAV parts are idempotent, playable, and inaccessible from another call', async () => {
  const { files, rows } = odooFixture(); const id = 'rec-test-123456';
  await files.beginRecording('call-1', id, { startedAt: 1000, deviceId: 'a' });
  const pcm = Buffer.alloc(32000); pcm.writeInt16LE(512, 0);
  const attachment = await files.savePart('call-1', id, 0, pcm); await files.savePart('call-1', id, 0, pcm);
  assert.equal(rows.length, 2); const bytes = await files.audio('call-1', id, attachment);
  assert.deepEqual(bytes.subarray(0, 44), wavHeader(pcm.length)); assert.equal(bytes.readInt16LE(44), 512);
  assert.equal((await files.recordings('call-1'))[0].parts[0].durationSeconds, 1);
  await assert.rejects(files.audio('call-2', id, attachment), error => error.code === 'RECORDING_NOT_FOUND');
  await assert.rejects(files.audio('call-1', 'rec-another-1234', attachment), error => error.code === 'RECORDING_NOT_FOUND');
});

test('recording and notes require a current authenticated call participant', async () => {
  const session = { id: 'session-1', providerCallId: call.id, owner: { deviceId: 'a' }, bindings: { b: {} } };
  let actor = { deviceId: 'outsider', nativeBuild: 22 };
  const runtime = { authenticatedSession: async () => [actor, session], requireSession: () => {}, store: { get: async () => call } };
  const tools = new CallTools({ runtime, files: {}, audio: {} });
  await assert.rejects(tools.authorize(null, session.id), error => error.code === 'CALL_RECORD_FORBIDDEN');
  actor = { deviceId: 'b', nativeBuild: 22 }; await tools.authorize(null, session.id);
  await assert.rejects(tools.authorize(null, session.id, true), error => error.code === 'CALL_OWNER_REQUIRED');
  actor = { deviceId: 'a', nativeBuild: 22 }; await tools.authorize(null, session.id, true);
});

test('stopping a recorder disconnects its SDK without waiting for Odoo storage', async () => {
  const gate = deferred(); const f = audioFixture({ files: { savePart: async () => gate.promise } });
  await f.manager.start(call, { deviceId: 'a' }, 'record-request-stop');
  const child = f.children[0]; child.emit('message', { type: 'part', recordingId: f.manager.state(call.id).id, index: 0, pcm: Buffer.alloc(320) });
  f.manager.stop(call.id); await tick();
  assert.equal(child.connected, false); assert.equal(f.manager.calls.get(call.id).pending, 1);
  gate.resolve(); await f.manager.calls.get(call.id).queue;
  assert.equal(f.manager.state(call.id).state, 'saved', JSON.stringify(f.manager.state(call.id)));
});

test('recording stop preserves a hold worker and leaving hold releases it immediately', async () => {
  const f = audioFixture();
  await f.manager.prepareHold(call); await f.manager.start(call, { deviceId: 'a' }, 'record-held-1');
  const held = { ...call, transfer: { mode: 'consult', status: 'connecting', consultStage: 'private', targetIdentity: 'B' } };
  f.manager.sync(held); await tick(); f.manager.stop(call.id); await tick();
  assert.equal(f.children[0].connected, true);
  f.manager.sync(call); await tick();
  assert.equal(f.children[0].connected, false);
});

function deviceFixture() {
  const { files, rows } = odooFixture(); let current = { ...structuredClone(call), version: 1, owner: { deviceId: 'a', legId: 'leg-a', identity: 'A' } };
  let now = 1000000;
  const runtime = { now: () => now, provider: { signalControlState: async () => {} }, store: {
    transaction: async work => work({ get: async () => structuredClone(current), set: (_key, value) => { current = value; } }) } };
  const recorder = new DeviceRecording({ runtime, files });
  return { recorder, files, rows, get current() { return current; }, actor: { deviceId: 'a', nativeBuild: 24 },
    setOwner: deviceId => { current.owner = { deviceId, legId: 'leg-' + deviceId, identity: deviceId.toUpperCase() }; } };
}

test('device recording follows canonical ownership with no SDK worker and safe idempotent stop', async () => {
  const f = deviceFixture(); const auth = { actor: f.actor, call: f.current, id: call.id };
  const body = { requestId: 'device-record-123' };
  const a = await f.recorder.change(auth, 'start', body);
  const b = await f.recorder.change(auth, 'start', body);
  assert.equal(a.id, b.id); assert.equal(f.rows.length, 1); assert.equal(a.mode, 'device');
  f.setOwner('b'); assert.equal(f.recorder.state(f.current).ownerDeviceId, 'b');
  await assert.rejects(f.recorder.change(auth, 'stop', { ...body, recordingId: a.id }), e => e.code === 'CALL_OWNER_REQUIRED');
  await f.recorder.change({ actor: { deviceId: 'b', nativeBuild: 24 }, call: f.current, id: call.id }, 'stop', { ...body, recordingId: a.id });
  assert.equal(f.recorder.state(f.current).active, false);
});

test('device segments survive handover, retry once, and reject conflicting or malformed audio', async () => {
  const f = deviceFixture(); const auth = { actor: f.actor, call: f.current, id: call.id };
  const recording = await f.recorder.change(auth, 'start', { requestId: 'device-record-123' });
  const body = { segmentId: 'segment-12345', index: 0, capturedAt: 1000000, pcm: Buffer.alloc(320, 1).toString('base64') };
  f.setOwner('b');
  await f.recorder.upload(auth, recording.id, body); await f.recorder.upload(auth, recording.id, body);
  assert.equal(f.rows.filter(x => x.mimetype === 'audio/wav').length, 1);
  await assert.rejects(f.recorder.upload(auth, recording.id, { ...body, pcm: Buffer.alloc(320, 2).toString('base64') }), e => e.code === 'RECORDING_PART_CONFLICT');
  await assert.rejects(f.recorder.upload(auth, recording.id, { ...body, pcm: '!invalid' }), e => e.code === 'INVALID_RECORDING_PART');
  await assert.rejects(f.recorder.upload(auth, 'rec-other-1234', body), e => e.code === 'RECORDING_NOT_FOUND');
});

test('monthly estimates split boundaries and cumulative retries never double-count a connection', async () => {
  const start = Date.UTC(2026, 10, 30, 23, 59, 55), now = Date.UTC(2026, 11, 1, 0, 1);
  assert.deepEqual(monthlySlices(start, 20000), [{ month: '2026-11', milliseconds: 5000 }, { month: '2026-12', milliseconds: 15000 }]);
  const { files } = odooFixture(); const usage = new MediaUsage({ files, project: 'project', now: () => now });
  await usage.record('connection-a', { startedAt: start, durationMs: 10000 });
  await usage.record('connection-a', { startedAt: start, durationMs: 20000 });
  await usage.record('connection-a', { startedAt: start, durationMs: 10000 });
  const summary = await usage.summary(); assert.equal(summary.participantMinutes, .25); assert.equal(summary.partial, true);
  assert.equal(summary.dataUsageGB, null); assert.equal(summary.observations, 1);
  await assert.rejects(usage.record('connection-a', { startedAt: start + 1, durationMs: 20000 }), e => e.code === 'MEDIA_USAGE_CONFLICT');
});

test('explicit handover preparation warms once without holding or changing call ownership', async () => {
  let now = 1000000;
  const f = audioFixture({ now: () => now });
  const session = {id: 'session-warm', providerCallId: call.id, owner: {deviceId: 'a'}};
  const original = structuredClone(call);
  const runtime = { now: () => now, authenticatedSession: async () => [{deviceId: 'a', nativeBuild: 24}, session],
    requireSession: () => {}, requireEnabled: async () => {}, store: {get: async () => original} };
  const tools = new CallTools({runtime, files: {}, audio: f.manager});
  await Promise.all([tools.warmHandover({}, session.id), tools.warmHandover({}, session.id)]);
  assert.equal(f.children.length, 1); assert.deepEqual(original, call);
  assert.ok(f.children[0].commands.every(c => c.hold !== true));
  now += 20001; f.manager.releaseIdle(f.manager.calls.get(call.id)); await tick();
  assert.equal(f.children[0].connected, false);
});

test('slow usage storage cannot hold a call status response or keep a media worker connected', async () => {
  const gate = deferred(), uploads = [];
  let now = 1000000;
  const tools = new CallTools({runtime: {now: () => now}, files: {}, audio: {sync() {}, state: () => ({state: 'idle'})}});
  tools.usage.record = async (...args) => {uploads.push(args); await gate.promise;};
  const current = {...call, createdAt: now - 30000};
  assert.deepEqual(tools.view(current), {state: 'idle'});
  await tick(); assert.equal(uploads.length, 1);
  for (let i=0; i<50; i++) tools.view(current);
  await tick(); assert.equal(uploads.length, 1);
  gate.resolve(); await tick(); now += 1000;
  tools.view({...current, active: false, terminal: {endedAt: now}}); await tick();
  assert.equal(uploads.length, 2); assert.equal(uploads[1][1].durationMs, 31000);
  assert.equal(uploads[1][2], 'customer-estimate');
});
