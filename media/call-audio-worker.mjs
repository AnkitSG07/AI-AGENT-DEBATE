// Isolated optional media process. It has no Odoo, Firebase, Meta or API secret.
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { Room, RoomEvent, AudioSource, AudioFrame, AudioStream, LocalAudioTrack, TrackPublishOptions,
  TrackSource, TrackKind, dispose } from '@livekit/rtc-node';

const RATE = 16000, PART = RATE * 30;
let room, source, musicTrack, musicPublication, music, musicOffset = 0, closing = false;
let desired = { customer: '', operators: [], hold: false }, recording = null, musicTask = null;
const streams = new Map();
const send = message => { if (process.connected) process.send(message, () => {}); };

export function decodeMuLaw(bytes) {
  const pcm = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const value = ~bytes[i] & 255;
    const magnitude = (((value & 15) << 3) + 132) << ((value & 112) >> 4);
    pcm[i] = value & 128 ? 132 - magnitude : magnitude - 132;
  }
  return pcm;
}

function subscriptions() {
  if (!room) return;
  const allowed = new Set([desired.customer, ...desired.operators]);
  for (const participant of room.remoteParticipants.values()) for (const publication of participant.trackPublications.values()) {
    publication.setSubscribed(!!recording && allowed.has(participant.identity) && publication.kind === TrackKind.KIND_AUDIO);
  }
}
function flush(final = false) {
  if (!recording) return;
  const elapsed = Math.max(0, Math.floor((performance.now() - recording.at) * RATE / 1000));
  const count = final ? Math.min(PART, elapsed - recording.offset) : PART;
  if (count <= 0) return;
  const pcm = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, recording.samples[i])), i * 2);
  send({ type: 'part', recordingId: recording.id, index: recording.index++, pcm });
  recording.offset += count;
  recording.samples.copyWithin(0, count);
  recording.samples.fill(0, recording.samples.length - count);
}
function stopRecording() {
  if (!recording) { send({ type: 'stopped' }); return; }
  while (Math.floor((performance.now() - recording.at) * RATE / 1000) - recording.offset > PART) flush();
  flush(true); clearInterval(recording.timer); recording = null; subscriptions(); send({ type: 'stopped' });
}
function record(id) {
  if (recording?.id === id) return;
  if (recording) stopRecording();
  // Keep one second of overlap while streams arrive on either side of a part
  // boundary. Saving a part must not drop the next track's first audio frame.
  recording = { id, at: performance.now(), offset: 0, index: 0, samples: new Int32Array(PART + RATE), positions: new Map() };
  recording.timer = setInterval(() => {
    if (recording && performance.now() - recording.at >= (recording.offset + PART + RATE / 10) * 1000 / RATE) flush();
  }, 50);
  subscriptions(); send({ type: 'recording' });
}
async function receive(track, publication, participant) {
  if (streams.has(publication.sid)) return;
  const stream = new AudioStream(track, { sampleRate: RATE, numChannels: 1, frameSizeMs: 20 });
  const reader = stream.getReader(); streams.set(publication.sid, reader);
  try {
    while (!closing) {
      const { value: frame, done } = await reader.read();
      if (done) break;
      const current = recording;
      if (!current || ![desired.customer, ...desired.operators].includes(participant.identity)) continue;
      const expected = Math.max(0, Math.floor((performance.now() - current.at) * RATE / 1000) - frame.samplesPerChannel);
      let position = current.positions.get(publication.sid) ?? expected;
      if (Math.abs(position - expected) > RATE / 2) position = expected;
      while (position - current.offset >= current.samples.length) flush();
      for (let i = 0; i < frame.data.length; i++) {
        const index = position + i - current.offset;
        if (index >= 0 && index < current.samples.length) current.samples[index] += Math.round(frame.data[i] * 0.7);
      }
      current.positions.set(publication.sid, position + frame.samplesPerChannel);
    }
  } catch { if (!closing) send({ type: 'error' }); }
  finally { streams.delete(publication.sid); await reader.cancel().catch(() => {}); }
}
async function holdLoop() {
  while (!closing && source) {
    if (!desired.hold) { source.clearQueue(); await delay(20); continue; }
    const frame = new Int16Array(320);
    for (let i = 0; i < frame.length; i++) { frame[i] = music[musicOffset++ % music.length]; }
    await source.captureFrame(new AudioFrame(frame, RATE, 1, frame.length));
  }
}
async function setState(message) {
  desired = { customer: message.customer, operators: message.operators || [], hold: message.hold === true };
  subscriptions();
  if ((desired.hold || message.type === 'prepare-hold') && !musicTrack) {
    if (!music) music = decodeMuLaw(gunzipSync(Buffer.from(await readFile(new URL('./assets/hold-music.mulaw.gz.b64', import.meta.url), 'utf8'), 'base64')));
    if (closing) return;
    source = new AudioSource(RATE, 1, 60);
    musicTrack = LocalAudioTrack.createAudioTrack('SH Chat hold music', source);
    musicPublication = await room.localParticipant.publishTrack(musicTrack,
      new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));
    musicTask = holdLoop().catch(() => { if (!closing) send({ type: 'error' }); });
  }
  if (!desired.hold) source?.clearQueue();
  if (message.type === 'prepare-hold') send({ type: 'prepared' });
  send({ type: 'hold', active: desired.hold && !!musicPublication });
}
async function close() {
  if (closing) return;
  closing = true; stopRecording(); source?.clearQueue();
  for (const reader of streams.values()) void reader.cancel().catch(() => {});
  await room?.disconnect().catch(() => {});
  await source?.close().catch(() => {});
  await musicTask;
  await dispose();
  process.exit(0);
}
let actions = Promise.resolve();
if (process.env.SH_AUDIO_WORKER === '1') {
  process.on('message', message => {
    if (message?.type === 'close') { void close(); return; }
    actions = actions.then(async () => {
      if (closing) return;
      if (message?.type === 'connect') {
        room = new Room(); desired = { customer: message.customer, operators: message.operators, hold: false };
        room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => { void receive(track, publication, participant); });
        room.on(RoomEvent.TrackPublished, subscriptions);
        room.on(RoomEvent.ParticipantConnected, subscriptions);
        room.on(RoomEvent.Reconnected, subscriptions);
        room.on(RoomEvent.Disconnected, () => { void close(); });
        room.on(RoomEvent.ParticipantDisconnected, participant => {
          if (participant.identity === desired.customer) void close();
        });
        await room.connect(message.url, message.token, { autoSubscribe: false, dynacast: false });
        send({ type: 'ready' });
      } else if (['state', 'prepare-hold'].includes(message?.type)) await setState(message);
      else if (message?.type === 'record') record(message.recordingId);
      else if (message?.type === 'stop-record') stopRecording();
    }).catch(() => { send({ type: 'error' }); });
  });
  process.on('disconnect', () => { void close(); });
  process.on('SIGTERM', () => { void close(); });
}
