import { createHash } from 'node:crypto';
import { endianness } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { AccessToken, TrackSource as GrantTrackSource } from 'livekit-server-sdk';
import { MediaError, identifier, requireValue } from '../media/errors.mjs';
import { VOICE_GREETING } from './ai-voice-knowledge.mjs';

const RATE = 24_000;
const FRAME_MS = 20;
const FRAME_BYTES = RATE * FRAME_MS / 1000 * 2;
const START_BUFFER_MS = 260;
const START_BUFFER_BYTES = START_BUFFER_MS / FRAME_MS * FRAME_BYTES;
const SOURCE_QUEUE_MS = 340;
const MAX_OUTPUT_BYTES = RATE * 2 * 30;
const MAX_INPUT_BACKLOG = 192 * 1024;
const PCM_FORMAT = { type: 'audio/pcm', rate: RATE };
const LITTLE_ENDIAN = endianness() === 'LE';
const CALLER_CHECK_TIMEOUT_MS = 3500;
const CALLER_CHECK = 'Decide whether the last audio item is the caller addressing the Smart Handicrafts product desk. Earlier audio, when supplied, is only conversational context. Return exactly CALLER or IGNORE. CALLER includes short clear answers such as yes, haan, or a quantity, and questions or corrections directed to the desk in English, Hindi, or Hinglish. IGNORE includes side conversations, television, echo of the desk, overlapping speakers with no clear caller, or speech directed to somebody else. If you cannot tell, return IGNORE. Do not transcribe or answer the audio.';
const WAIT_FOR_USER = { type: 'function', name: 'wait_for_user',
  description: 'Stay quiet when nobody is addressing you. Use for background conversation, TV, music, or unrelated speech. Do not speak before using this tool.',
  parameters: { type: 'object', properties: {}, additionalProperties: false } };

function mediaError(code, message) {
  return new MediaError(`AI_VOICE_${code}`, message, 502);
}

function notify(callback, value) {
  if (typeof callback === 'function') void Promise.resolve().then(() => callback(value)).catch(() => {});
}

function pcmBytes(samples) {
  if (LITTLE_ENDIAN) return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const bytes = Buffer.alloc(samples.byteLength);
  for (let i = 0; i < samples.length; i++) bytes.writeInt16LE(samples[i], i * 2);
  return bytes;
}

function pcmSamples(bytes) {
  // Each SDK frame must own its full ArrayBuffer. The native SDK reads from byte zero.
  const samples = new Int16Array(bytes.length / 2);
  if (LITTLE_ENDIAN) new Uint8Array(samples.buffer).set(bytes);
  else for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * 2);
  return samples;
}

/** Prepare the LiveKit audio publisher and configure Realtime before accepting the call. */
export async function startAiVoiceMedia(options, { rtc: injectedRtc, WebSocketClient = globalThis.WebSocket,
  loadVoiceFilter = async () => (await import('@livekit/noise-cancellation-node')).BackgroundVoiceCancellation()
} = {}) {
  const {
    roomName, customerIdentity, livekitUrl, livekitApiKey, livekitApiSecret, livekitToken,
    openaiApiKey, model = 'gpt-realtime', voice = 'cedar', instructions, tools = [],
    onToolCall, onError, onDisconnect, onMediaReady, onPlaybackStats, onVoiceIsolation, isolateCallerVoice = false,
    signal, timeoutMs = 8_000, mediaTimeoutMs = 15_000, callerCheckTimeoutMs = CALLER_CHECK_TIMEOUT_MS
  } = options;
  const identity = options.identity || `sh-ai-${createHash('sha256').update(identifier(roomName, 'room')).digest('hex').slice(0, 40)}`;
  identifier(roomName, 'room');
  identifier(identity, 'assistant identity');
  identifier(customerIdentity, 'customer identity');
  requireValue(customerIdentity !== identity && typeof WebSocketClient === 'function' && Array.isArray(tools) &&
    tools.every(tool => tool?.type === 'function' && typeof tool.name === 'string') &&
    /^wss:\/\//.test(livekitUrl || '') && !!openaiApiKey && !!instructions &&
    !!(livekitToken || (livekitApiKey && livekitApiSecret)),
  'AI_VOICE_CONFIG', 'AI voice media configuration is incomplete.', 503);
  if (signal?.aborted) throw mediaError('ABORTED', 'AI voice startup was cancelled.');

  const rtc = injectedRtc || await import('@livekit/rtc-node').catch(() => {
    throw mediaError('LIVEKIT_SDK', 'The LiveKit audio SDK could not start.');
  });
  if (signal?.aborted) throw mediaError('ABORTED', 'AI voice startup was cancelled.');
  const token = livekitToken || await (async () => {
    const access = new AccessToken(livekitApiKey, livekitApiSecret, { identity, name: 'AI assistant', ttl: 120 });
    access.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true, canPublishData: false,
      canUpdateOwnMetadata: false, canPublishSources: [GrantTrackSource.MICROPHONE] });
    return access.toJwt();
  })().catch(() => { throw mediaError('LIVEKIT_TOKEN', 'The AI participant token could not be created.'); });
  if (signal?.aborted) throw mediaError('ABORTED', 'AI voice startup was cancelled.');

  const voiceFilter = isolateCallerVoice ? Promise.resolve().then(loadVoiceFilter).catch(() => null) : null;
  const room = new rtc.Room();
  const lifecycle = new AbortController();
  let toolTurn = new AbortController();
  const toolNames = new Set(tools.map(tool => tool.name));
  const handledToolCalls = new Set();
  const requestedPublications = new WeakSet();
  const audioParts = new Map();
  const output = [];
  const callerItems = new Map();
  const deletingItems = new Set();
  const finishedCallerItems = new Set();
  let socket, source, localTrack, reader, closeTask, disconnectTask, mediaTimer;
  let connected = false, published = false, configured = false, started = false, closed = false;
  let callerHasAudio = false, mediaReady = false, activated = false, greeting = '', queuedBytes = 0;
  let playbackGeneration = 0, pumping = false, priming = false, playbackStarted = false;
  let rebufferCount = 0, interruptions = 0, ignoredTurns = 0, callerCheckFailures = 0;
  let turn = 0, speaking = false, replyPending = false, responding, responseNumber = 0;
  let callerCheck, callerCheckNumber = 0, activeCallerItem;
  const configuration = Promise.withResolvers();
  const stopped = Promise.withResolvers();

  function send(event) {
    if (closed || socket?.readyState !== 1) return false;
    try {
      socket.send(JSON.stringify(event));
      return true;
    } catch {
      return false;
    }
  }

  function detachRoom() {
    if (connected) disconnectTask ||= Promise.resolve().then(() => room.disconnect()).catch(() => {});
    return disconnectTask;
  }

  function stopReader() {
    const current = reader;
    reader = undefined;
    if (current?.reader) void current.reader.cancel().catch(() => {});
  }

  function close() {
    if (closed) return closeTask || Promise.resolve();
    closed = true;
    clearTimeout(mediaTimer);
    clearTimeout(callerCheck?.timer);
    callerItems.clear();
    deletingItems.clear();
    finishedCallerItems.clear();
    signal?.removeEventListener('abort', abort);
    lifecycle.abort();
    stopReader();
    output.length = 0;
    audioParts.clear();
    if (activated) notify(onPlaybackStats, { rebufferCount, interruptions, ignoredTurns, callerCheckFailures });
    try { source?.clearQueue(); } catch { /* The room may already be disconnected. */ }
    try { socket?.close(); } catch { /* The socket may already be closed. */ }
    const disconnect = detachRoom();
    const releaseAudio = (async () => {
      if (localTrack) await localTrack.close(false).catch(() => {});
      await source?.close().catch(() => {});
    })();
    closeTask = Promise.race([Promise.all([disconnect, releaseAudio]), delay(750, undefined, { ref: false })]).then(() => {});
    return closeTask;
  }

  function fail(error, { report = true } = {}) {
    if (closed) return;
    stopped.reject(error);
    void close();
    if (report) notify(onError, error);
    if (started && report) notify(onDisconnect, error);
  }

  function abort() {
    fail(mediaError('ABORTED', 'AI voice media was cancelled.'), { report: false });
  }

  function requestResponse() {
    if (!activated || !callerHasAudio || !mediaReady || speaking || callerItems.size || deletingItems.size ||
        responding || closed || !(greeting || replyPending)) return;
    const event = { type: 'response.create', event_id: `ai-voice-response-${++responseNumber}` };
    if (greeting) {
      event.response = { instructions: `${instructions}\n\n${greeting}`, tool_choice: 'none' };
      greeting = '';
    } else {
      replyPending = false;
    }
    responding = { turn, callerItemId: activeCallerItem };
    if (!send(event)) fail(mediaError('REALTIME_DISCONNECTED', 'The AI voice connection was lost.'));
  }

  function checkMediaReady() {
    if (closed || !configured || !published || !callerHasAudio) return;
    if (mediaReady) {
      clearTimeout(mediaTimer);
      requestResponse();
      return;
    }
    if (priming) return;
    priming = true;
    // Start the outbound RTP path with silence before generating the greeting.
    const silence = new Int16Array(RATE / 20);
    void source.captureFrame(new rtc.AudioFrame(silence, RATE, 1, silence.length)).then(() => {
      priming = false;
      if (closed || !callerHasAudio) return;
      mediaReady = true;
      notify(onMediaReady);
      checkMediaReady();
    }).catch(() => fail(mediaError('LIVEKIT_AUDIO_OUTPUT', 'The AI assistant could not start outbound audio.')));
  }

  function waitForCallerMedia() {
    clearTimeout(mediaTimer);
    mediaTimer = setTimeout(() => fail(mediaError('CALLER_MEDIA_TIMEOUT', 'The caller audio did not reach the AI assistant.')), mediaTimeoutMs);
    mediaTimer.unref?.();
  }

  function discardPlayback() {
    let queuedSamples = Math.ceil((source?.queuedDuration || 0) * RATE / 1000);
    const pending = [...audioParts.values()].reverse();
    playbackGeneration++;
    playbackStarted = false;
    output.length = 0;
    queuedBytes = 0;
    audioParts.clear();
    source?.clearQueue();
    for (const part of pending) {
      const unplayed = Math.min(queuedSamples, part.sent + part.padding);
      queuedSamples -= unplayed;
      const played = part.sent - Math.max(0, unplayed - part.padding);
      if (played < part.received || !part.done) {
        send({ type: 'conversation.item.truncate', event_id: 'ai-voice-truncate', item_id: part.itemId,
          content_index: part.contentIndex, audio_end_ms: Math.floor(played * 1000 / RATE) });
      }
    }
  }

  function receiveTrack(track, publication, participant) {
    if (closed || reader || participant?.identity !== customerIdentity || publication?.kind !== rtc.TrackKind.KIND_AUDIO) return;
    const current = { sid: publication.sid, reader: null };
    reader = current;
    void (async () => {
      try {
        const streamOptions = { sampleRate: RATE, numChannels: 1, frameSizeMs: FRAME_MS };
        const filter = voiceFilter && await voiceFilter;
        if (closed || reader !== current) return;
        if (filter) {
          try {
            current.reader = new rtc.AudioStream(track, { ...streamOptions, noiseCancellation: filter }).getReader();
          } catch {
            // Fall back to the original caller audio and Realtime suppression.
            send({ type: 'session.update', session: { type: 'realtime',
              audio: { input: { noise_reduction: { type: 'near_field' } } } } });
          }
        }
        if (isolateCallerVoice) notify(onVoiceIsolation, !!current.reader);
        current.reader ||= new rtc.AudioStream(track, streamOptions).getReader();
        while (!closed && reader === current) {
          const { value: frame, done } = await current.reader.read();
          if (done || closed || reader !== current) break;
          if (!frame?.data?.length || frame.sampleRate !== RATE || frame.channels !== 1) continue;
          if (!callerHasAudio) {
            callerHasAudio = true;
            checkMediaReady();
          }
          if (!activated || !configured) continue;
          if (socket.bufferedAmount > MAX_INPUT_BACKLOG ||
              !send({ type: 'input_audio_buffer.append', audio: pcmBytes(frame.data).toString('base64') })) {
            fail(mediaError('REALTIME_AUDIO_INPUT', 'The AI voice connection could not receive caller audio.'));
          }
        }
      } catch {
        if (reader === current) fail(mediaError('CALLER_AUDIO', 'The AI assistant lost the caller audio.'));
      } finally {
        if (reader === current) loseTrack(publication);
        if (current.reader) {
          await current.reader.cancel().catch(() => {});
          current.reader.releaseLock();
        }
      }
    })();
  }

  function subscribe(publication, participant) {
    if (closed || participant?.identity !== customerIdentity || publication?.kind !== rtc.TrackKind.KIND_AUDIO) return;
    if (publication.track) receiveTrack(publication.track, publication, participant);
    else if (!requestedPublications.has(publication)) {
      requestedPublications.add(publication);
      publication.setSubscribed(true);
    }
  }

  function subscribeExisting() {
    const caller = room.remoteParticipants.get(customerIdentity);
    if (caller) for (const publication of caller.trackPublications.values()) subscribe(publication, caller);
  }

  function loseTrack(publication) {
    if (closed || reader?.sid !== publication.sid) return;
    stopReader();
    callerHasAudio = false;
    if (activated) waitForCallerMedia();
    forgetCallerCheck();
    for (const [id, item] of callerItems) if (item.added) discardCallerItem(id);
    callerItems.clear();
    activeCallerItem = undefined;
    // Keep the call attached while LiveKit delivers a replacement publication.
    // Discard old output and invalidate its pending response while audio is unavailable.
    interruptTurn();
    speaking = false;
    replyPending = false;
    discardPlayback();
    if (responding?.id) send({ type: 'response.cancel', event_id: 'ai-voice-cancel', response_id: responding.id });
    send({ type: 'input_audio_buffer.clear' });
  }

  function interruptTurn() {
    turn++;
    toolTurn.abort();
    toolTurn = new AbortController();
  }

  function discardCallerItem(id) {
    ignoredTurns++;
    deletingItems.add(id);
    if (!send({ type: 'conversation.item.delete', event_id: `sh-drop-${id}`, item_id: id }))
      fail(mediaError('REALTIME_DISCONNECTED', 'The AI voice connection was lost.'));
  }

  function forgetCallerCheck() {
    if (!callerCheck) return;
    clearTimeout(callerCheck.timer);
    if (callerCheck.responseId) send({ type: 'response.cancel', event_id: 'ai-voice-cancel', response_id: callerCheck.responseId });
    callerCheck = undefined;
  }

  function verifyNextCaller() {
    if (closed || callerCheck || !callerItems.size) return;
    const [id, item] = callerItems.entries().next().value;
    if (!item.committed || !item.added) return;
    if (callerItems.size > 3) {
      callerItems.delete(id);
      discardCallerItem(id);
      verifyNextCaller();
      return;
    }
    const eventId = `sh-caller-check-${++callerCheckNumber}`;
    callerCheck = { id, eventId, timer: setTimeout(() => finishCallerCheck(false, true), callerCheckTimeoutMs) };
    callerCheck.timer.unref?.();
    const input = [activeCallerItem, id].filter(Boolean).map(id => ({ type: 'item_reference', id }));
    const request = { type: 'response.create', event_id: eventId, response: {
      conversation: 'none', metadata: { sh_caller_check: eventId }, output_modalities: ['text'],
      input, instructions: CALLER_CHECK, tool_choice: 'none', max_output_tokens: 8
    } };
    if (!send(request)) fail(mediaError('REALTIME_DISCONNECTED', 'The AI voice connection was lost.'));
  }

  function finishCallerCheck(confirmed, failed = false) {
    if (!callerCheck) return;
    const { id } = callerCheck;
    forgetCallerCheck();
    callerItems.delete(id);
    finishedCallerItems.add(id);
    if (finishedCallerItems.size > 64) finishedCallerItems.delete(finishedCallerItems.values().next().value);
    if (failed) callerCheckFailures++;
    if (!confirmed) discardCallerItem(id);
    else {
      if (responding || output.length || source?.queuedDuration > FRAME_MS) {
        interruptions++;
        discardPlayback();
        if (responding?.id) send({ type: 'response.cancel', event_id: 'ai-voice-cancel', response_id: responding.id });
      }
      interruptTurn();
      activeCallerItem = id;
      greeting = '';
      replyPending = true;
    }
    verifyNextCaller();
    requestResponse();
  }

  function observeCallerItem(id, stage) {
    if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id) || deletingItems.has(id) || finishedCallerItems.has(id)) return;
    const item = callerItems.get(id) || {};
    item[stage] = true;
    callerItems.set(id, item);
    verifyNextCaller();
  }

  function pruneAudio() {
    let queued = Math.ceil((source?.queuedDuration || 0) * RATE / 1000);
    for (const [key, part] of [...audioParts.entries()].reverse()) {
      const unplayed = Math.min(queued, part.sent + part.padding);
      queued -= unplayed;
      if (!unplayed && part.done && part.sent === part.received) audioParts.delete(key);
    }
  }

  async function pumpOutput() {
    if (pumping || closed) return;
    pumping = true;
    try {
      while (output.length && !closed) {
        const generation = playbackGeneration;
        const { part, bytes, realSamples } = output.shift();
        queuedBytes -= bytes.length;
        const samples = pcmSamples(bytes);
        part.sent += realSamples;
        part.padding += samples.length - realSamples;
        try {
          await source.captureFrame(new rtc.AudioFrame(samples, RATE, 1, samples.length));
        } catch {
          if (generation === playbackGeneration && !closed) {
            fail(mediaError('LIVEKIT_AUDIO_OUTPUT', 'The AI assistant could not play audio to the caller.'));
          }
        }
        if (generation !== playbackGeneration && !closed) source.clearQueue();
      }
      if (!closed) pruneAudio();
    } finally {
      pumping = false;
    }
  }

  function playAvailableAudio() {
    if (pumping || closed || !output.length) return;
    if (playbackStarted && source.queuedDuration < FRAME_MS / 2) {
      // A fresh burst after the native queue drained mid-reply needs a
      // prebuffer again. A completed short reply can play immediately.
      playbackStarted = false;
      if (output[0].part.sent && !output[0].part.done) rebufferCount++;
    }
    if (!playbackStarted && queuedBytes < START_BUFFER_BYTES && !output[0].part.done) return;
    playbackStarted = true;
    void pumpOutput().catch(() => fail(mediaError('LIVEKIT_AUDIO_OUTPUT', 'The AI assistant could not play audio to the caller.')));
  }

  function appendOutput(event) {
    if (!callerHasAudio || !responding || responding.id !== event.response_id || responding.turn !== turn) return;
    pruneAudio();
    const key = `${event.item_id}:${event.content_index}`;
    let part = audioParts.get(key);
    if (!part) {
      part = { itemId: event.item_id, contentIndex: event.content_index, responseId: event.response_id,
        sent: 0, padding: 0, received: 0, done: false, remainder: Buffer.alloc(0) };
      audioParts.set(key, part);
    }
    const bytes = Buffer.concat([part.remainder, Buffer.from(event.delta, 'base64')]);
    part.received += Math.floor(bytes.length / 2) - Math.floor(part.remainder.length / 2);
    if (queuedBytes + bytes.length > MAX_OUTPUT_BYTES) {
      fail(mediaError('REALTIME_AUDIO_OUTPUT', 'The AI assistant received too much queued audio.'));
      return;
    }
    let offset = 0;
    while (offset + FRAME_BYTES <= bytes.length) {
      output.push({ part, bytes: bytes.subarray(offset, offset + FRAME_BYTES), realSamples: FRAME_BYTES / 2 });
      queuedBytes += FRAME_BYTES;
      offset += FRAME_BYTES;
    }
    part.remainder = bytes.subarray(offset);
    playAvailableAudio();
  }

  function finishOutput(responseId) {
    for (const part of audioParts.values()) {
      if (part.responseId !== responseId || part.done) continue;
      part.done = true;
      const tail = part.remainder.subarray(0, part.remainder.length & ~1);
      part.remainder = Buffer.alloc(0);
      if (tail.length) {
        // LiveKit packetizes in whole audio blocks. Pad the last frame so
        // short word endings play now instead of being held for the next turn.
        const frame = Buffer.alloc(FRAME_BYTES);
        tail.copy(frame);
        output.push({ part, bytes: frame, realSamples: tail.length / 2 });
        queuedBytes += frame.length;
      }
    }
    playAvailableAudio();
  }

  async function executeTools(response, { turn: responseTurn, callerItemId }) {
    const calls = (response.output || []).filter(item => item.type === 'function_call' && item.call_id && !handledToolCalls.has(item.call_id));
    if (!calls.length) return;
    const toolSignal = AbortSignal.any([lifecycle.signal, toolTurn.signal]);
    for (const item of calls) handledToolCalls.add(item.call_id);
    const wait = calls.some(item => item.name === WAIT_FOR_USER.name);
    if (wait && callerItemId) {
      if (activeCallerItem === callerItemId) activeCallerItem = undefined;
      discardCallerItem(callerItemId);
    }
    for (const item of calls) {
      if (closed) return;
      let result = '{"status":"unavailable"}';
      try {
        if (item.name === WAIT_FOR_USER.name) result = '{"status":"listening"}';
        else if (!wait && !toolSignal.aborted && toolNames.has(item.name) && typeof onToolCall === 'function' &&
            Buffer.byteLength(item.arguments || '') <= 4096) {
          const args = JSON.parse(item.arguments);
          if (args && typeof args === 'object' && !Array.isArray(args)) {
            const value = await onToolCall({ name: item.name, arguments: args, callId: item.call_id, signal: toolSignal });
            const json = JSON.stringify(value);
            if (!toolSignal.aborted && json && Buffer.byteLength(json) <= 32 * 1024) result = json;
          }
        }
      } catch { /* Let the caller know the requested information is unavailable. */ }
      if (!closed) send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: item.call_id, output: result } });
    }
    if (!wait && !closed && responseTurn === turn) {
      replyPending = true;
      requestResponse();
    }
  }

  function receiveEvent(event) {
    switch (event.type) {
      case 'session.updated':
        configured = true;
        configuration.resolve();
        checkMediaReady();
        break;
      case 'input_audio_buffer.speech_started':
        if (!activated) break;
        speaking = true;
        break;
      case 'input_audio_buffer.committed':
        if (!activated) break;
        speaking = false;
        observeCallerItem(event.item_id, 'committed');
        requestResponse();
        break;
      case 'conversation.item.added':
      case 'conversation.item.created':
        if (activated && event.item?.role === 'user' && event.item.content?.some(part => part.type === 'input_audio'))
          observeCallerItem(event.item.id, 'added');
        break;
      case 'conversation.item.deleted':
        if (deletingItems.delete(event.item_id)) requestResponse();
        break;
      case 'response.created':
        if (event.response?.metadata?.sh_caller_check) {
          if (event.response.metadata.sh_caller_check === callerCheck?.eventId) callerCheck.responseId = event.response.id;
          break;
        }
        if (responding) {
          responding.id = event.response.id;
          if (responding.turn !== turn) {
            send({ type: 'response.cancel', event_id: 'ai-voice-cancel', response_id: responding.id });
          }
        }
        break;
      case 'response.output_audio.delta':
        appendOutput(event);
        break;
      case 'response.output_audio.done':
        finishOutput(event.response_id);
        break;
      case 'response.done': {
        const response = event.response;
        if (response?.metadata?.sh_caller_check) {
          if (response.metadata.sh_caller_check === callerCheck?.eventId) {
            callerCheck.responseId = undefined;
            const text = response.output?.flatMap(item => item.content || []).map(part => part.text || '').join('').trim();
            const valid = response.status === 'completed' && (text === 'CALLER' || text === 'IGNORE');
            finishCallerCheck(valid && text === 'CALLER', !valid);
          }
          break;
        }
        if (!responding || responding.id !== response?.id) break;
        const completed = responding;
        const responseTurn = completed.turn;
        responding = undefined;
        finishOutput(response.id);
        if (response.status === 'failed' && responseTurn === turn) {
          fail(mediaError('REALTIME_RESPONSE', 'The AI assistant could not generate a voice response.'));
          break;
        }
        if (response.status === 'completed' && responseTurn === turn) {
          void executeTools(response, completed).catch(() => fail(mediaError('REALTIME_TOOL', 'The AI assistant could not complete a tool response.')));
        }
        requestResponse();
        break;
      }
      case 'error':
        if (callerCheck && event.error?.event_id === callerCheck.eventId) finishCallerCheck(false, true);
        else if (event.error?.event_id?.startsWith('sh-caller-check-')) break;
        else if (!configured) fail(mediaError('REALTIME_SESSION', 'OpenAI did not accept the AI voice session configuration.'));
        else if (!['ai-voice-truncate', 'ai-voice-cancel'].includes(event.error?.event_id)) {
          fail(mediaError('REALTIME_EVENT', 'OpenAI rejected an AI voice operation.'));
        }
        break;
    }
  }

  function handleRoomEvent(action) {
    return (...args) => {
      if (closed) return;
      try { action(...args); }
      catch { fail(mediaError('LIVEKIT_AUDIO', 'The AI assistant could not process call audio.')); }
    };
  }

  room.on(rtc.RoomEvent.TrackPublished, handleRoomEvent(subscribe));
  room.on(rtc.RoomEvent.TrackSubscribed, handleRoomEvent(receiveTrack));
  room.on(rtc.RoomEvent.TrackUnpublished, handleRoomEvent((publication, participant) => {
    if (participant?.identity === customerIdentity) loseTrack(publication);
  }));
  room.on(rtc.RoomEvent.TrackUnsubscribed, handleRoomEvent((_track, publication, participant) => {
    if (participant?.identity === customerIdentity) loseTrack(publication);
  }));
  room.on(rtc.RoomEvent.Reconnected, handleRoomEvent(subscribeExisting));
  room.on(rtc.RoomEvent.ParticipantDisconnected, handleRoomEvent(participant => {
    if (participant?.identity === customerIdentity) fail(mediaError('CALLER_LEFT', 'The caller left the AI voice room.'));
  }));
  room.on(rtc.RoomEvent.Disconnected, handleRoomEvent(() => {
    fail(mediaError('LIVEKIT_DISCONNECTED', 'The AI assistant lost the call room connection.'));
  }));

  async function connectRoom() {
    try {
      await room.connect(livekitUrl, token, { autoSubscribe: false, dynacast: false });
    } catch {
      throw mediaError('LIVEKIT_CONNECT', 'The AI assistant could not join the call room.');
    }
    connected = true;
    if (closed) { void detachRoom(); return; }
    try {
      subscribeExisting();
      source = new rtc.AudioSource(RATE, 1, SOURCE_QUEUE_MS);
      localTrack = rtc.LocalAudioTrack.createAudioTrack('Smart Handicrafts voice', source);
      await room.localParticipant.publishTrack(localTrack, new rtc.TrackPublishOptions({ source: rtc.TrackSource.SOURCE_MICROPHONE }));
    } catch {
      throw mediaError('LIVEKIT_PUBLISH', 'The AI assistant could not publish call audio.');
    }
    if (!closed) {
      published = true;
      checkMediaReady();
    }
  }

  async function connectRealtime() {
    const url = new URL('wss://api.openai.com/v1/realtime');
    url.searchParams.set('model', model);
    try {
      socket = new WebSocketClient(url, { headers: { Authorization: `Bearer ${openaiApiKey}` } });
    } catch {
      throw mediaError('REALTIME_CONNECT', 'The AI assistant could not connect to OpenAI Realtime.');
    }
    socket.addEventListener('open', async () => {
      const filter = voiceFilter && await voiceFilter;
      if (closed) return;
      if (!send({ type: 'session.update', event_id: 'ai-voice-session', session: {
        type: 'realtime', instructions, output_modalities: ['audio'], max_output_tokens: 512,
        tools: [...tools, WAIT_FOR_USER], tool_choice: 'auto', audio: {
          input: { format: PCM_FORMAT, noise_reduction: filter ? null : { type: 'near_field' },
            turn_detection: { type: 'server_vad', threshold: 0.65, prefix_padding_ms: 300,
              silence_duration_ms: 450, create_response: false, interrupt_response: false } },
          output: { format: PCM_FORMAT, voice }
        }
      } })) {
        fail(mediaError('REALTIME_SESSION', 'The AI assistant could not configure OpenAI Realtime.'));
      }
    });
    socket.addEventListener('message', message => {
      if (closed) return;
      try { receiveEvent(JSON.parse(message.data)); }
      catch { fail(mediaError('REALTIME_PROTOCOL', 'The AI assistant received an invalid voice event.')); }
    });
    const disconnected = () => fail(mediaError(configured ? 'REALTIME_DISCONNECTED' : 'REALTIME_CONNECT',
      configured ? 'The AI voice connection was lost.' : 'The AI assistant could not connect to OpenAI Realtime.'));
    socket.addEventListener('error', disconnected);
    socket.addEventListener('close', disconnected);
    return configuration.promise;
  }

  signal?.addEventListener('abort', abort, { once: true });
  const startupTimer = setTimeout(() => fail(mediaError('START_TIMEOUT', 'The AI assistant could not start before the call deadline.')), timeoutMs);
  try {
    await Promise.race([stopped.promise, Promise.all([connectRoom(), connectRealtime()])]);
    if (closed) await stopped.promise;
    started = true;
  } catch (error) {
    void close();
    throw error;
  } finally {
    clearTimeout(startupTimer);
  }

  return {
    get ready() { return !closed; },
    speak(greetingInstructions = VOICE_GREETING) {
      if (closed) throw mediaError('CLOSED', 'The AI voice connection is closed.');
      if (activated) return;
      activated = true;
      greeting = greetingInstructions || VOICE_GREETING;
      if (!callerHasAudio || !mediaReady) waitForCallerMedia();
      checkMediaReady();
    },
    close
  };
}
