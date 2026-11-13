// Manual drafts share the Hub's scoped operator authentication. This module has
// no message sender, database dependency or background work.
import { OPERATOR_OPENAI_CONVERSATION_LIMIT, OPERATOR_OPENAI_INSTRUCTION_LIMIT } from './operator-openai-draft.js';

export function registerOperatorAiDraftRoutes(app, { provider, enabled = false, clock = Date.now } = {}) {
  const attempts = new Map();
  const active = new Set();

  app.post('/api/ai-mode/draft', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const actor = req.operatorAuth;
    if (actor?.kind !== 'browser' || !actor.scopes?.includes('ai:write') || !actor.baseDeviceId) {
      return res.status(401).json({ ok: false, code: 'OPERATOR_AUTH_REQUIRED',
        error: 'Connect operator services to prepare an AI reply.' });
    }
    if (!enabled || !provider?.configured()) {
      return res.status(503).json({ ok: false, code: 'AI_DRAFT_NOT_CONFIGURED',
        error: 'AI reply drafts need to be enabled by the administrator.' });
    }

    const { channelId, conversation, instruction = '' } = req.body || {};
    if (!Number.isSafeInteger(channelId) || channelId <= 0 || typeof conversation !== 'string' ||
        !conversation.trim() || conversation.length > OPERATOR_OPENAI_CONVERSATION_LIMIT ||
        typeof instruction !== 'string' || instruction.length > OPERATOR_OPENAI_INSTRUCTION_LIMIT) {
      return res.status(400).json({ ok: false, code: 'INVALID_AI_DRAFT_INPUT',
        error: 'Select a conversation with recent text messages and try again.' });
    }

    const key = actor.baseDeviceId;
    const now = clock();
    for (const [id, row] of attempts) if (row.until <= now) attempts.delete(id);
    const row = attempts.get(key) || { count: 0, until: now + 60000 };
    if (active.has(key) || active.size >= 4 || row.count >= 10 || (!attempts.has(key) && attempts.size >= 1000)) {
      res.setHeader('Retry-After', '10');
      return res.status(429).json({ ok: false, code: 'AI_DRAFT_BUSY',
        error: 'Please wait for the current reply draft before trying again.' });
    }
    row.count++;
    attempts.set(key, row);
    active.add(key);
    const controller = new AbortController();
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', cancel);
    try {
      const result = await provider.generate({ conversation, instruction, signal: controller.signal });
      if (!controller.signal.aborted) return res.json({ ok: true, channelId, ...result });
    } catch (error) {
      if (controller.signal.aborted) return;
      const known = error?.operatorAiDraftError === true;
      return res.status(known ? error.status : 503).json({ ok: false,
        code: known ? error.code : 'AI_DRAFT_UNAVAILABLE',
        error: known ? error.message : 'AI reply drafts are temporarily unavailable. Please try again.' });
    } finally {
      res.removeListener('close', cancel);
      active.delete(key);
    }
  });
}
