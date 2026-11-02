import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { OdooCallFiles, wavHeader } from '../call-runtime/odoo-call-files.mjs';
import { CallTools } from '../call-runtime/call-tools.mjs';
import { CallAudioManager } from '../media/call-audio-manager.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const call = { id: 'call-tools-test', active: true, roomName: 'room-tools-test', customerIdentity: 'customer', owner: { identity: 'A', deviceId: 'a' } };
function audioFixture(options = {}) {
  const children = [], parts = [], manifest = [];
  const files = { beginRecording: async (...args) => { manifest.push(args); }, savePart: async (...args) => { parts.push(args); }, ...options.files };
  const manager = new CallAudioManager({ provider: { config: { apiKey: 'devkey', apiSecret: 'development-key-for-isolated-unit-test', wsUrl: 'ws://127.0.0.1:17880' } },
    files, ...options, spawn: () => {
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

test('recording storage backlog is bounded and does not terminate customer or hold audio', async () => {
  const gate = deferred(); const f = audioFixture({ files: { savePart: async () => gate.promise } });
  await f.manager.start(call, { deviceId: 'a' }, 'record-request-1');
  const child = f.children[0], id = f.manager.state(call.id).id;
  for (let index = 0; index < 7; index++) child.emit('message', { type: 'part', recordingId: id, index, pcm: Buffer.alloc(320) });
  assert.equal(f.manager.calls.get(call.id).pending, 4); assert.equal(f.manager.state(call.id).state, 'failed');
  assert.equal(child.commands.some(item => item.type === 'close'), false);
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
