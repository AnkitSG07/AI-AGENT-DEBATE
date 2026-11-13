import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { setImmediate, setTimeout } from 'node:timers/promises';
import { startAiVoiceMedia } from '../call-runtime/ai-voice-media.mjs';

const CUSTOMER = { identity: 'exact-caller', trackPublications: new Map() };
const OTHER = { identity: 'other-participant' };
const events = Object.fromEntries(['TrackPublished', 'TrackSubscribed', 'TrackUnpublished', 'TrackUnsubscribed', 'Reconnected',
  'ParticipantDisconnected', 'Disconnected'].map(name => [name, name]));
const tool = { type: 'function', name: 'lookup_catalog', parameters: { type: 'object' } };

function harness(overrides = {}) {
  const seen = { rtc: [], frames: [], errors: [], disconnects: [], sent: [], ready: 0, tool: [], cleared: 0 };
  class Room extends EventEmitter {
    constructor() {
      super();
      this.remoteParticipants = new Map();
      this.localParticipant = { publishTrack: async (track, options) => { seen.published = { track, options }; } };
      seen.room = this;
    }
    async connect(url, token, options) {
      seen.rtc.push({ url, token, options });
      if (overrides.connect) await overrides.connect;
    }
    async disconnect() { seen.roomDisconnected = true; this.emit(events.Disconnected); }
  }
  class AudioSource {
    constructor(rate, channels, queueSize) { Object.assign(this, { rate, channels, queueSize, queuedDuration: 0 }); seen.source = this; }
    async captureFrame(frame) {
      seen.frames.push(frame);
      if (seen.capture) await seen.capture(frame);
    }
    clearQueue() { seen.cleared++; this.queuedDuration = 0; }
    async close() { seen.sourceClosed = true; }
  }
  class AudioFrame {
    constructor(data, sampleRate, channels, samplesPerChannel) { Object.assign(this, { data, sampleRate, channels, samplesPerChannel }); }
  }
  class AudioStream {
    constructor(track, options) {
      if (options.noiseCancellation && overrides.rejectVoiceFilter) throw Error('filter unavailable');
      seen.streamOptions = options;
      return track.stream;
    }
  }
  class WebSocketClient extends EventTarget {
    constructor(url, options) {
      super();
      this.readyState = 0;
      this.bufferedAmount = 0;
      seen.websocket = { url, options };
      seen.socket = this;
      queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); });
    }
    send(data) {
      const event = JSON.parse(data);
      seen.sent.push(event);
      if (event.type === 'session.update' && !overrides.deferSession) queueMicrotask(() => this.receive({ type: 'session.updated' }));
    }
    receive(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  const rtc = { Room, RoomEvent: events, AudioSource, AudioFrame, AudioStream, TrackKind: { KIND_AUDIO: 1 },
    TrackSource: { SOURCE_MICROPHONE: 1 }, TrackPublishOptions: class { constructor(options) { Object.assign(this, options); } },
    LocalAudioTrack: { createAudioTrack: () => ({ async close() { seen.trackClosed = true; } }) } };
  const start = options => startAiVoiceMedia({ roomName: 'private-call', customerIdentity: CUSTOMER.identity,
    livekitUrl: 'wss://test.livekit.cloud', livekitToken: 'fake-token', openaiApiKey: 'fake-key',
    instructions: 'Use the customer-facing knowledge file.', tools: [tool],
    onMediaReady: () => seen.ready++, onError: error => seen.errors.push(error), onDisconnect: error => seen.disconnects.push(error),
    onToolCall: async request => { seen.tool.push(request); return { status: 'ok' }; }, ...options
  }, { rtc, WebSocketClient, loadVoiceFilter: overrides.loadVoiceFilter });
  const publication = (participant = CUSTOMER, sid = 'track-a') => {
    let controller;
    const stream = new ReadableStream({ start(value) { controller = value; } });
    const pub = { sid, kind: 1, subscribed: false, setSubscribed(value) { this.subscribed = value; } };
    const track = { stream };
    seen.room.emit(events.TrackPublished, pub, participant);
    return {
      pub, track, participant,
      subscribe() { seen.room.emit(events.TrackSubscribed, track, pub, participant); },
      frame(data = new Int16Array([42, -91])) { controller.enqueue(new AudioFrame(data, 24_000, 1, data.length)); }
    };
  };
  const response = (id, output = []) => seen.socket.receive({ type: 'response.done', response: { id, status: 'completed', output } });
  const responseStarted = id => seen.socket.receive({ type: 'response.created', response: { id } });
  const delta = (id, bytes, item = 'item', index = 0) => seen.socket.receive({ type: 'response.output_audio.delta',
    response_id: id, item_id: item, content_index: index, delta: bytes.toString('base64') });
  return { seen, start, publication, response, responseStarted, delta };
}

const sent = (state, type) => state.sent.filter(event => event.type === type);

await test('prepares the room and session before greeting and only forwards exact caller PCM', async () => {
  const h = harness();
  const voice = await h.start();
  assert.equal(voice.ready, true);
  assert.equal(h.seen.rtc[0].options.autoSubscribe, false);
  assert.equal(h.seen.websocket.url.toString(), 'wss://api.openai.com/v1/realtime?model=gpt-realtime');
  assert.equal(h.seen.websocket.options.headers.Authorization, 'Bearer fake-key');
  assert.equal(h.seen.published.options.source, 1);
  assert.deepEqual(sent(h.seen, 'session.update')[0].session.audio.input.format, { type: 'audio/pcm', rate: 24000 });
  assert.equal(sent(h.seen, 'session.update')[0].session.audio.output.voice, 'cedar');
  assert.equal(sent(h.seen, 'session.update')[0].session.audio.input.turn_detection.threshold, 0.65);
  assert.deepEqual(sent(h.seen, 'session.update')[0].session.audio.input.noise_reduction, { type: 'near_field' });
  assert.ok(sent(h.seen, 'session.update')[0].session.tools.some(value => value.name === 'wait_for_user'));
  assert.ok(h.seen.source.queueSize >= 180);
  assert.equal(h.seen.ready, 0);
  assert.equal(voice.speak('Greet in Hindi.'), undefined);
  const other = h.publication(OTHER);
  other.subscribe();
  other.frame();
  await setImmediate();
  assert.equal(other.pub.subscribed, false);
  assert.equal(h.seen.ready, 0);
  assert.equal(sent(h.seen, 'response.create').length, 0);
  const caller = h.publication();
  assert.equal(caller.pub.subscribed, true);
  caller.subscribe();
  const padded = Int16Array.from([999, 42, -91, 999]);
  caller.frame(padded.subarray(1, 3));
  await setImmediate();
  assert.equal(h.seen.ready, 1);
  assert.deepEqual(h.seen.streamOptions, { sampleRate: 24000, numChannels: 1, frameSizeMs: 20 });
  assert.deepEqual(Buffer.from(sent(h.seen, 'input_audio_buffer.append')[0].audio, 'base64'), Buffer.from([42, 0, 165, 255]));
  const [greeting] = sent(h.seen, 'response.create');
  assert.match(greeting.response.instructions, /customer-facing knowledge file\.\n\nGreet in Hindi\./);
  assert.equal(greeting.response.tool_choice, 'none');
  assert.equal(h.seen.frames[0].samplesPerChannel, 1200);
  assert.ok(h.seen.frames[0].data.every(sample => sample === 0));
  await voice.close();
  await voice.close();
  assert.equal(voice.ready, false);
  assert.equal(h.seen.trackClosed, true);
  assert.equal(h.seen.sourceClosed, true);
  assert.equal(h.seen.roomDisconnected, true);
  assert.deepEqual(h.seen.disconnects, []);
});

await test('reports exact caller readiness before speak and leaves the microphone disabled until activation', async () => {
  const h = harness();
  const voice = await h.start();
  const caller = h.publication();
  caller.subscribe();
  caller.frame();
  await setImmediate();
  assert.equal(h.seen.ready, 1);
  assert.equal(sent(h.seen, 'input_audio_buffer.append').length, 0);
  voice.speak();
  assert.equal(sent(h.seen, 'response.create').length, 1);
  await voice.close();
});

await test('filters the pilot caller track before Realtime and falls back if the native filter fails', async () => {
  const filter = { moduleId: 'test-filter', options: {} };
  for (const rejectVoiceFilter of [false, true]) {
    const h = harness({ rejectVoiceFilter, loadVoiceFilter: async () => filter });
    const isolation = [];
    const voice = await h.start({ isolateCallerVoice: true, onVoiceIsolation: value => isolation.push(value) });
    voice.speak();
    const caller = h.publication();
    caller.subscribe();
    caller.frame();
    await setImmediate();
    assert.equal(h.seen.streamOptions.noiseCancellation, rejectVoiceFilter ? undefined : filter);
    const configs = sent(h.seen, 'session.update');
    assert.equal(configs[0].session.audio.input.noise_reduction, null);
    if (rejectVoiceFilter) assert.deepEqual(configs[1].session.audio.input.noise_reduction, { type: 'near_field' });
    assert.deepEqual(isolation, [!rejectVoiceFilter]);
    assert.equal(sent(h.seen, 'input_audio_buffer.append').length, 1);
    await voice.close();
  }
});

await test('preserves PCM offsets across deltas and cuts queued audio on a caller interruption', async () => {
  const h = harness();
  const voice = await h.start();
  const caller = h.publication();
  caller.subscribe();
  caller.frame();
  voice.speak();
  await setImmediate();
  h.responseStarted('greet');
  const pcm = Buffer.alloc(960 * 9);
  pcm.writeInt16LE(-222, 0);
  pcm.writeInt16LE(345, 960);
  const pendingCapture = Promise.withResolvers();
  h.seen.capture = () => pendingCapture.promise;
  h.delta('greet', pcm.subarray(0, 101));
  assert.equal(h.seen.frames.length, 1, 'short first burst is held before playout');
  h.delta('greet', pcm.subarray(101));
  assert.equal(h.seen.frames[1].data[0], -222);
  assert.equal(h.seen.frames.length, 2);
  h.seen.source.queuedDuration = 5;
  h.seen.socket.receive({ type: 'input_audio_buffer.speech_started' });
  assert.equal(h.seen.cleared, 1);
  assert.deepEqual(sent(h.seen, 'conversation.item.truncate'), [{ type: 'conversation.item.truncate', event_id: 'ai-voice-truncate',
    item_id: 'item', content_index: 0, audio_end_ms: 15 }]);
  pendingCapture.resolve();
  h.delta('greet', pcm);
  h.seen.socket.receive({ type: 'input_audio_buffer.committed' });
  assert.equal(sent(h.seen, 'response.create').length, 1);
  h.seen.socket.receive({ type: 'response.done', response: { id: 'greet', status: 'cancelled', output: [] } });
  await setImmediate();
  assert.equal(h.seen.frames.length, 2);
  assert.equal(sent(h.seen, 'response.create').length, 2);
  await voice.close();
});

await test('a short reply flushes when complete and pads the final audio frame', async () => {
  const h = harness();
  const voice = await h.start();
  const caller = h.publication();
  caller.subscribe();
  caller.frame();
  voice.speak();
  await setImmediate();
  h.responseStarted('short');
  const pcm = Buffer.alloc(960 + 240);
  pcm.writeInt16LE(-222, 0);
  pcm.writeInt16LE(345, 960);
  h.delta('short', pcm.subarray(0, 101));
  h.delta('short', pcm.subarray(101));
  assert.equal(h.seen.frames.length, 1);
  h.response('short');
  await setImmediate();
  assert.deepEqual(h.seen.frames.slice(1).map(frame => [frame.samplesPerChannel, frame.data[0]]), [[480, -222], [480, 345]]);
  assert.ok(h.seen.frames[2].data.subarray(120).every(sample => sample === 0));
  await voice.close();
});

await test('a source underrun re-buffers before feeding the next partial burst', async () => {
  const h = harness();
  const stats = [];
  const voice = await h.start({ onPlaybackStats: value => stats.push(value) });
  const caller = h.publication();
  caller.subscribe();
  caller.frame();
  voice.speak();
  await setImmediate();
  h.responseStarted('bursty');
  h.delta('bursty', Buffer.alloc(960 * 9));
  await setImmediate();
  assert.equal(h.seen.frames.length, 10);
  h.seen.source.queuedDuration = 0;
  h.delta('bursty', Buffer.alloc(960 * 2));
  assert.equal(h.seen.frames.length, 10);
  h.delta('bursty', Buffer.alloc(960 * 7));
  await setImmediate();
  assert.equal(h.seen.frames.length, 19);
  await voice.close();
  assert.deepEqual(stats, [{ rebufferCount: 1, interruptions: 0 }]);
});

await test('passes tool arguments once, denies unlisted names, and follows a completed tool result', async () => {
  const h = harness();
  const voice = await h.start();
  voice.speak();
  const caller = h.publication();
  caller.subscribe();
  caller.frame();
  await setImmediate();
  h.responseStarted('greet');
  h.response('greet');
  h.seen.socket.receive({ type: 'input_audio_buffer.committed' });
  h.responseStarted('lookup');
  const calls = [
    { type: 'function_call', name: 'lookup_catalog', arguments: '{"query":"lamp"}', call_id: 'allowed' },
    { type: 'function_call', name: 'unlisted', arguments: '{}', call_id: 'rejected' }
  ];
  h.response('lookup', calls);
  h.response('lookup', calls);
  await setImmediate();
  assert.equal(h.seen.tool.length, 1);
  assert.equal(h.seen.tool[0].signal.aborted, false);
  assert.deepEqual(h.seen.tool[0].arguments, { query: 'lamp' });
  assert.deepEqual(sent(h.seen, 'conversation.item.create').map(event => event.item.output), ['{"status":"ok"}', '{"status":"unavailable"}']);
  assert.equal(sent(h.seen, 'response.create').length, 3);
  await voice.close();
  assert.equal(h.seen.tool[0].signal.aborted, true);
});

await test('background conversation gets no audible follow-up or business tool effects', async () => {
  const h = harness();
  const voice = await h.start();
  voice.speak();
  const caller = h.publication();
  caller.subscribe();
  caller.frame();
  await setImmediate();
  h.responseStarted('greet');
  h.response('greet');
  h.seen.socket.receive({ type: 'input_audio_buffer.committed' });
  h.responseStarted('background');
  h.response('background', [
    { type: 'function_call', name: 'wait_for_user', arguments: '{}', call_id: 'wait' },
    { type: 'function_call', name: 'lookup_catalog', arguments: '{"query":"lamp"}', call_id: 'ignore' }
  ]);
  assert.match(sent(h.seen, 'response.create')[0].response.instructions, /Smart Handicrafts’ automated product desk/);
  assert.equal(sent(h.seen, 'response.create').length, 2);
  assert.deepEqual(h.seen.tool, []);
  assert.equal(sent(h.seen, 'conversation.item.create')[0].item.output, '{"status":"listening"}');
  h.seen.socket.receive({ type: 'input_audio_buffer.committed' });
  assert.equal(sent(h.seen, 'response.create').length, 3);
  await voice.close();
});

await test('invalidates a second pending tool when the caller interrupts the first', async () => {
  const h = harness();
  const held = Promise.withResolvers();
  const voice = await h.start({ onToolCall: async request => { h.seen.tool.push(request); return held.promise; } });
  voice.speak();
  const caller = h.publication();
  caller.subscribe();
  caller.frame();
  await setImmediate();
  h.responseStarted('greet');
  h.response('greet');
  h.seen.socket.receive({ type: 'input_audio_buffer.committed' });
  h.responseStarted('lookup');
  h.response('lookup', ['first', 'second'].map(call_id => ({ type: 'function_call', name: 'lookup_catalog', arguments: '{}', call_id })));
  assert.equal(h.seen.tool[0].signal.aborted, false);
  h.seen.socket.receive({ type: 'input_audio_buffer.speech_started' });
  assert.equal(h.seen.tool[0].signal.aborted, true);
  held.resolve({ status: 'ok' });
  await setImmediate();
  assert.deepEqual(h.seen.tool.map(request => request.callId), ['first']);
  assert.equal(sent(h.seen, 'response.create').length, 2);
  await voice.close();
});

await test('fails closed on OpenAI session rejection or missing caller RTP without leaking provider details', async () => {
  const rejected = harness({ deferSession: true });
  const failed = rejected.start();
  rejected.seen.socket.receive({ type: 'error', error: { message: 'secret provider detail' } });
  await assert.rejects(failed, error => error.code === 'AI_VOICE_REALTIME_SESSION' && !/secret/.test(error.message));
  await setImmediate();
  assert.equal(rejected.seen.roomDisconnected, true);
  assert.deepEqual(rejected.seen.disconnects, []);
  const h = harness();
  const voice = await h.start({ mediaTimeoutMs: 3 });
  voice.speak();
  await setTimeout(20);
  assert.equal(voice.ready, false);
  assert.deepEqual(h.seen.disconnects.map(error => error.code), ['AI_VOICE_CALLER_MEDIA_TIMEOUT']);
});

await test('startup timeout closes a LiveKit room that joins after the deadline', async () => {
  const lateJoin = Promise.withResolvers();
  const h = harness({ connect: lateJoin.promise });
  await assert.rejects(h.start({ timeoutMs: 3 }), { code: 'AI_VOICE_START_TIMEOUT' });
  assert.equal(h.seen.socket.readyState, 3);
  lateJoin.resolve();
  await setImmediate();
  assert.equal(h.seen.roomDisconnected, true);
  assert.equal(h.seen.published, undefined);
  assert.deepEqual(h.seen.disconnects, []);
});

await test('caller disconnect or abort closes both transports and only involuntary disconnect is reported', async () => {
  const h = harness();
  const voice = await h.start();
  h.seen.room.emit(events.ParticipantDisconnected, OTHER);
  assert.equal(voice.ready, true);
  h.seen.room.emit(events.ParticipantDisconnected, CUSTOMER);
  await setImmediate();
  assert.equal(voice.ready, false);
  assert.deepEqual(h.seen.disconnects.map(error => error.code), ['AI_VOICE_CALLER_LEFT']);
  const second = harness();
  const controller = new AbortController();
  const closing = await second.start({ signal: controller.signal });
  controller.abort();
  await setImmediate();
  assert.equal(closing.ready, false);
  assert.deepEqual(second.seen.disconnects, []);
  assert.equal(second.seen.socket.readyState, 3);
});
