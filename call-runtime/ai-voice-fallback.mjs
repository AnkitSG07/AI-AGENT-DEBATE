import { createHash, randomUUID } from 'node:crypto';
import { startAiVoiceMedia } from './ai-voice-media.mjs';

const phone = value => String(value || '').trim().replace(/^\+/, '');
const validPhone = value => /^[1-9]\d{6,14}$/.test(value);
const maxOfferAgeMs = 25000;

/** Arm only verified, recent incoming calls covered by the server's rollout. */
export function createAiVoiceFallback({ env = process.env, loadInstructions, tools, callTool, saveEnquiry,
  startMedia = startAiVoiceMedia, humanAnswerInProgress = () => false, logger = console,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const allowed = new Set(String(env.SH_AI_VOICE_PILOT_CALLERS || '').split(',').map(phone).filter(validPhone));
  const allCallers = env.SH_AI_VOICE_ALL_CALLERS === 'true';
  const apiKey = String(env.OPENAI_API_KEY || '').trim();
  if (env.SH_AI_VOICE_ENABLED !== 'true' || !apiKey || (!allowed.size && !allCallers)) return null;
  const ringMs = Number(env.SH_AI_VOICE_RING_SECONDS || 12) * 1000;
  const maxCallMs = Number(env.SH_AI_VOICE_MAX_SECONDS || 180) * 1000;
  if (!Number.isSafeInteger(ringMs) || ringMs < 5000 || ringMs > 18000 ||
      !Number.isSafeInteger(maxCallMs) || maxCallMs < 30000 || maxCallMs > 300000) {
    logger.warn?.('SH_AI_VOICE pilot configuration is invalid.');
    return null;
  }
  const active = new Map();
  let instructions, closed = false;
  const log = (stage, stats) => logger.info?.('SH_AI_VOICE', JSON.stringify({ stage, ...stats }));

  function release(entry) {
    if (active.get(entry.id) === entry) active.delete(entry.id);
    if (entry.timer !== undefined) clearTimer(entry.timer);
    entry.controller.abort();
    const media = entry.media;
    entry.media = null;
    if (media) void Promise.resolve().then(() => media.close()).catch(() => {});
  }
  async function end(entry, reason) {
    release(entry);
    if (!entry.claimStarted) return;
    try { await entry.runtime.endAiIncoming(entry.id, entry.operationId, reason); }
    catch { log('cleanup_deferred'); }
  }
  async function run(entry) {
    const { id, runtime, operationId, controller } = entry;
    const current = () => active.get(id) === entry && !controller.signal.aborted;
    const beforeClaim = () => current() && now() - entry.offeredAt < maxOfferAgeMs &&
      !humanAnswerInProgress(entry.callId);
    try {
      if (!beforeClaim()) return;
      const session = await runtime.locate(id);
      if (!beforeClaim() || !session || session.phase !== 'ringing' || session.owner || session.routeChoice || session.terminal ||
          phone(session.customerPhone) !== entry.caller) return;
      const config = runtime.provider.config;
      const identity = 'sh-voice-' + createHash('sha256').update(operationId).digest('hex').slice(0, 32);
      instructions ||= Promise.resolve().then(loadInstructions).catch(error => { instructions = null; throw error; });
      const prompt = await instructions;
      if (!beforeClaim()) return;
      let ready = Promise.resolve();
      let callerAudio = false, accepted = false;
      const onReady = () => {
        callerAudio = true;
        if (accepted && current()) ready = runtime.markAiIncomingReady(id, operationId)
          .then(() => log('media_ready'), () => log('readiness_write_failed'));
      };
      const media = await startMedia({ roomName: session.roomName, customerIdentity: session.customerIdentity,
        identity, livekitUrl: config.wsUrl, livekitApiKey: config.apiKey, livekitApiSecret: config.apiSecret,
        openaiApiKey: apiKey, model: env.SH_AI_VOICE_MODEL || 'gpt-realtime', voice: env.SH_AI_VOICE_NAME || 'cedar',
        isolateCallerVoice: allowed.has(entry.caller) && env.SH_AI_VOICE_ISOLATION !== 'false',
        instructions: prompt, tools, signal: controller.signal, timeoutMs: 6000,
        onMediaReady: onReady,
        onPlaybackStats: stats => log('playback', stats),
        onVoiceIsolation: configured => log(configured ? 'caller_filter_configured' : 'caller_filter_unavailable'),
        onError: error => {
          if (/^AI_VOICE_[A-Z_]+$/.test(error?.code || '')) log(error.code);
        },
        onToolCall: async request => {
          if (!accepted || !current() || request.signal?.aborted) return { status: 'unavailable' };
          if (request.name !== 'capture_enquiry') return callTool(request);
          await ready;
          if (!current() || request.signal?.aborted) return { status: 'unavailable' };
          return saveEnquiry({ request, session: { ...session, verifiedCustomerPhone: entry.caller }, operationId, runtime });
        },
        onDisconnect: () => {
          if (current()) void end(entry, 'AI_VOICE_DISCONNECTED');
        }
      });
      entry.media = media;
      if (!beforeClaim()) return;
      entry.claimStarted = true;
      const result = await runtime.acceptAiIncoming(id, { operationId, identity, maxCallMs, mayClaim: beforeClaim, canDispatch: current });
      if (!result || !current()) return;
      accepted = true;
      if (callerAudio) onReady();
      entry.timer = setTimer(() => void end(entry, 'AI_VOICE_TIME_LIMIT'), Math.max(1, result.deadlineAt - now()));
      entry.timer?.unref?.();
      await media.speak();
      if (!current()) return;
      entry.keepOpen = true;
      log('answered');
    } catch {
      log('fallback_unavailable');
      await end(entry, 'AI_VOICE_FAILED');
    } finally {
      if (!entry.keepOpen) release(entry);
    }
  }

  return {
    schedule({ id, callId, callerPhone, occurredAtMs, runtime }) {
      const caller = phone(callerPhone), age = now() - occurredAtMs;
      if (closed || !validPhone(caller) || !(allCallers || allowed.has(caller)) || !Number.isFinite(age) || age < -3000 ||
          age >= maxOfferAgeMs - ringMs || active.has(id) || active.size >= 2) return;
      const controller = new AbortController();
      const entry = { id, callId, caller, offeredAt: Math.min(occurredAtMs, now()), runtime, controller,
        operationId: randomUUID() };
      active.set(id, entry);
      entry.timer = setTimer(() => void run(entry), ringMs);
      entry.timer?.unref?.();
    },
    stop(id) {
      const entry = active.get(id);
      if (entry) release(entry);
    },
    async close() {
      closed = true;
      await Promise.all([...active.values()].map(entry => end(entry, 'AI_VOICE_SHUTDOWN')));
    }
  };
}
