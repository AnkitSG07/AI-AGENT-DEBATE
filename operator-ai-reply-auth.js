// Authorization and durable exactly-once-attempt receipts for automated replies.
// An ambiguous provider outcome is never retried as a second customer message.
import { createHash, createHmac, hkdfSync, randomUUID, timingSafeEqual } from 'node:crypto';

const PREFIX = 'shai1', TTL_MS = 10 * 60 * 1000;
const fail = (status, code, message) => Object.assign(new Error(message), { status, code, operatorAiReplyError: true });
const requireValue = (value, status, code, message) => { if (!value) throw fail(status, code, message); };
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const positive = value => Number.isSafeInteger(value) && value > 0;

export function createOperatorAiReplyAuth({ secret, getState, getFirestore, collectionPrefix = () => 'sh_operator', clock = Date.now } = {}) {
  const key = typeof secret === 'string' && secret.replace(/\s/g, '').length >= 32
    ? Buffer.from(hkdfSync('sha256', Buffer.from(secret), Buffer.from('sh-operator-ai-replies'), Buffer.from('reply-grant-v1'), 32)) : null;
  const signature = payload => createHmac('sha256', key).update(`${PREFIX}.${payload}`).digest('base64url');
  const store = () => {
    const db = getFirestore?.();
    requireValue(db?.collection && db?.runTransaction && /^[A-Za-z][A-Za-z0-9_]{0,80}$/.test(collectionPrefix()),
      503, 'AI_REPLY_STORAGE_UNAVAILABLE', 'Automated reply storage is unavailable. A human operator should handle this conversation.');
    return db;
  };
  function ready() {
    requireValue(key, 503, 'AI_REPLY_AUTH_UNAVAILABLE', 'Automated reply authorization is not configured.');
    store();
  }
  function current(claims) {
    const state = getState?.();
    return !!state && state.mode === 'zapier' && claims.epoch === state.epoch && claims.revision === state.revision &&
      claims.enabledSince === state.enabled_since_ms && claims.sourceTimestamp > state.enabled_since_ms;
  }
  function issue({ channelId, sourceMessageId, sourceTimestamp }) {
    ready(); const state = getState?.(), now = clock();
    requireValue(state?.mode === 'zapier' && typeof state.epoch === 'string' && Number.isSafeInteger(state.revision),
      409, 'AI_MODE_OFF', 'SH AI is not enabled for this reply.');
    requireValue(positive(channelId) && positive(sourceMessageId) && positive(sourceTimestamp) && sourceTimestamp > state.enabled_since_ms &&
      sourceTimestamp <= now + 30000, 400, 'INVALID_AI_SOURCE', 'A verified new incoming message is required.');
    const claims = { v: 1, channelId, sourceMessageId, sourceTimestamp, epoch: state.epoch, revision: state.revision,
      enabledSince: state.enabled_since_ms, issuedAt: now, expiresAt: now + TTL_MS };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${PREFIX}.${payload}.${signature(payload)}`;
  }
  function verify(token, channelId) {
    ready();
    requireValue(typeof token === 'string' && token.length <= 1800, 401, 'AI_REPLY_GRANT_REQUIRED', 'A valid source-bound AI reply grant is required.');
    const parts = token.split('.');
    requireValue(parts.length === 3 && parts[0] === PREFIX && /^[A-Za-z0-9_-]{1,1400}$/.test(parts[1]) && /^[A-Za-z0-9_-]{43}$/.test(parts[2]),
      401, 'INVALID_AI_REPLY_GRANT', 'The AI reply grant is invalid.');
    const expected = Buffer.from(signature(parts[1]), 'base64url'), actual = Buffer.from(parts[2], 'base64url');
    requireValue(expected.length === actual.length && timingSafeEqual(expected, actual), 401, 'INVALID_AI_REPLY_GRANT', 'The AI reply grant is invalid.');
    let claims;
    try { claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { throw fail(401, 'INVALID_AI_REPLY_GRANT', 'The AI reply grant is invalid.'); }
    requireValue(claims?.v === 1 && positive(channelId) && claims.channelId === channelId && positive(claims.sourceMessageId) &&
      positive(claims.sourceTimestamp) && positive(claims.issuedAt) && positive(claims.expiresAt) && positive(claims.enabledSince) &&
      /^[A-Za-z0-9_-]{1,100}$/.test(claims.epoch || '') && Number.isSafeInteger(claims.revision) && claims.revision >= 0 &&
      claims.issuedAt <= clock() + 30000 && claims.expiresAt > claims.issuedAt && claims.expiresAt - claims.issuedAt <= TTL_MS &&
      claims.sourceTimestamp <= claims.issuedAt + 30000,
    401, 'INVALID_AI_REPLY_GRANT', 'The AI reply grant is invalid.');
    requireValue(clock() < claims.expiresAt, 410, 'AI_REPLY_GRANT_EXPIRED', 'This AI reply expired. A human operator should review the conversation.');
    requireValue(current(claims), 409, 'AI_MODE_CHANGED', 'This reply belongs to an earlier AI session.');
    return Object.freeze(claims);
  }
  async function claim({ token, channelId, reply }) {
    const claims = verify(token, channelId);
    requireValue(typeof reply === 'string' && reply.trim().length > 0 && reply.length <= 8000, 400, 'INVALID_AI_REPLY', 'A bounded reply is required.');
    const id = hash(`${claims.epoch}:${claims.revision}:${channelId}:${claims.sourceMessageId}`), replyHash = hash(reply.trim()), attemptId = randomUUID();
    const db = store(), ref = db.collection(`${collectionPrefix()}_ai_reply_receipts`).doc(id);
    try {
      return await db.runTransaction(async tx => {
        const old = await tx.get(ref);
        requireValue(current(claims) && clock() < claims.expiresAt, 409, 'AI_MODE_CHANGED', 'This reply belongs to an earlier AI session.');
        if (old.exists) {
          const row = old.data();
          requireValue(row.replyHash === replyHash, 409, 'AI_REPLY_CONFLICT', 'A different reply already claimed this incoming message.');
          if (row.state === 'complete') return { replay: true, claims, id, replyHash, state: 'complete', messageId: row.messageId || null };
          throw fail(409, row.state === 'blocked' ? 'AI_REPLY_BLOCKED' : 'AI_REPLY_OUTCOME_PENDING',
            'This incoming message already has a reply attempt. Check the conversation before sending anything again.');
        }
        tx.set(ref, { id, replyHash, attemptId, state: 'processing', channelId, sourceMessageId: claims.sourceMessageId,
          epoch: claims.epoch, revision: claims.revision, createdAt: clock(), updatedAt: clock(), grantExpiresAt: claims.expiresAt,
          deleteAfter: new Date(clock() + 30 * 24 * 3600000) });
        return { replay: false, claims, id, replyHash, attemptId, state: 'processing' };
      });
    } catch (error) {
      if (error.operatorAiReplyError) throw error;
      throw fail(503, 'AI_REPLY_STORAGE_UNAVAILABLE', 'Reply authorization could not be recorded. No send was attempted.');
    }
  }
  async function completed({ token, channelId, reply }) {
    const claims = verify(token, channelId);
    requireValue(typeof reply === 'string' && reply.trim().length > 0 && reply.length <= 8000, 400, 'INVALID_AI_REPLY', 'A bounded reply is required.');
    const id = hash(`${claims.epoch}:${claims.revision}:${channelId}:${claims.sourceMessageId}`), replyHash = hash(reply.trim());
    try {
      const snap = await store().collection(`${collectionPrefix()}_ai_reply_receipts`).doc(id).get();
      if (!snap.exists) return null;
      const row = snap.data();
      requireValue(row.replyHash === replyHash, 409, 'AI_REPLY_CONFLICT', 'A different reply already claimed this incoming message.');
      if (row.state === 'complete') return { replay: true, messageId: row.messageId || null };
      throw fail(409, row.state === 'blocked' ? 'AI_REPLY_BLOCKED' : 'AI_REPLY_OUTCOME_PENDING',
        'This incoming message already has a reply attempt. Check the conversation before sending anything again.');
    } catch (error) {
      if (error.operatorAiReplyError) throw error;
      throw fail(503, 'AI_REPLY_STORAGE_UNAVAILABLE', 'The existing reply outcome is unavailable. No send was attempted.');
    }
  }
  async function finish(receipt, state, messageId = null) {
    requireValue(receipt && !receipt.replay && typeof receipt.attemptId === 'string' && ['complete','blocked','uncertain'].includes(state),
      409, 'INVALID_AI_RECEIPT', 'The reply receipt is invalid.');
    const db = store(), ref = db.collection(`${collectionPrefix()}_ai_reply_receipts`).doc(receipt.id);
    try {
      await db.runTransaction(async tx => {
        const snap = await tx.get(ref), row = snap.exists ? snap.data() : null;
        requireValue(row?.attemptId === receipt.attemptId && row.replyHash === receipt.replyHash && row.state === 'processing',
          409, 'AI_RECEIPT_CHANGED', 'The reply receipt changed.');
        tx.set(ref, { ...row, state, updatedAt: clock(), messageId: positive(messageId) ? messageId : null });
      });
    } catch (error) {
      if (error.operatorAiReplyError) throw error;
      throw fail(503, 'AI_REPLY_RECEIPT_PENDING', 'The reply outcome could not be confirmed. Check the conversation before retrying.');
    }
  }
  return Object.freeze({ issue, verify, claim, completed, finish, current, configured: () => { try { ready(); return true; } catch { return false; } } });
}
