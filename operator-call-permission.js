// Explicit native WhatsApp call-permission requests. No constructor, GET,
// webhook or retry worker sends a customer message. See docs/r13/call-permission-contract.md.
import { createHash, randomUUID } from 'node:crypto';
import { MediaError, requireValue } from './media/errors.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const REQUEST_REPEAT_GUARD_MS = 30000; // Our repeat-tap debounce, not a Meta rate limit.
const SEND_UNCERTAIN_AFTER_MS = 20000;
const REQUEST_TEXT = 'May Smart Handicrafts call you about your enquiry? Please choose whether to allow calls.';
const fail = (code, message, status = 409, details = {}) => new MediaError(code, message, status, details);
const phone = value => {
  requireValue(typeof value === 'string' && /^[1-9][0-9]{6,14}$/.test(value),
    'INVALID_PHONE', 'Use a country-code phone number without a leading +.', 400);
  return value;
};
const requestId = value => {
  requireValue(typeof value === 'string' && /^[A-Za-z0-9_-]{8,120}$/.test(value),
    'INVALID_REQUEST_ID', 'Keep the same request ID when checking a permission request.', 400);
  return value;
};
const unknownPermission = now => ({ status: 'unknown', canCall: false, canRequest: false,
  expiresAtMs: null, checkedAtMs: now, reason: 'Calling permission has not been verified.', limits: [] });

/** Parse only the Meta sample's established status/action fields. Unknown or
 * contradictory permission/expiry data never becomes calling authority. */
export function parseCallPermissionStatus(data, now = Date.now()) {
  requireValue(plain(data) && !data.error && (data.messaging_product === undefined || data.messaging_product === 'whatsapp') && plain(data.permission) && Array.isArray(data.actions) && data.actions.length <= 32,
    'CALL_PERMISSION_STATUS_UNAVAILABLE', 'Meta did not return a verifiable calling-permission status. Check again.', 502);
  const result = unknownPermission(now), actions = new Map();
  for (const item of data.actions) {
    if (!plain(item) || !['send_call_permission_request', 'start_call'].includes(item.action_name)) continue;
    requireValue(!actions.has(item.action_name) && typeof item.can_perform_action === 'boolean' &&
      (item.limits === undefined || Array.isArray(item.limits) && item.limits.length <= 16),
      'CALL_PERMISSION_STATUS_UNAVAILABLE', 'Meta returned inconsistent calling-permission eligibility. Check again.', 502);
    let eligible = item.can_perform_action;
    for (const limit of item.limits || []) {
      requireValue(plain(limit) && typeof limit.time_period === 'string' && /^P[A-Z0-9.]{1,39}$/.test(limit.time_period) &&
        Number.isSafeInteger(limit.max_allowed) && limit.max_allowed >= 0 && Number.isSafeInteger(limit.current_usage) && limit.current_usage >= 0,
        'CALL_PERMISSION_STATUS_UNAVAILABLE', 'Meta returned an invalid calling-permission limit. Check again.', 502);
      if (limit.current_usage >= limit.max_allowed) eligible = false;
      result.limits.push({ actionName: item.action_name, timePeriod: limit.time_period,
        maxAllowed: limit.max_allowed, currentUsage: limit.current_usage });
    }
    actions.set(item.action_name, eligible);
  }
  const status = data.permission.status;
  if (status === 'permanent') result.status = status;
  else if (status === 'temporary') {
    const seconds = data.permission.expiration_time;
    if (positive(seconds) && Number.isSafeInteger(seconds * 1000)) {
      result.expiresAtMs = seconds * 1000;
      result.status = result.expiresAtMs > now ? 'temporary' : 'expired';
    }
  } else if (status === 'no_permission') result.status = status;
  const permitted = result.status === 'permanent' || result.status === 'temporary';
  result.canCall = permitted && actions.get('start_call') === true;
  result.canRequest = !permitted && result.status !== 'unknown' && actions.get('send_call_permission_request') === true;
  result.reason = result.canCall ? 'Meta currently allows calling this customer.' : permitted
    ? 'Permission exists, but Meta does not currently allow a call. Check again later.' : result.canRequest
      ? 'Request permission explicitly; the customer must accept before you call.' : result.status === 'expired'
        ? 'Calling permission expired. Meta does not currently allow another request.' : result.status === 'unknown'
          ? 'Meta returned an unrecognized or incomplete permission status. Check again.'
          : 'Calling permission is not granted, and Meta does not currently allow another request.';
  return result;
}

async function boundedJson(response) {
  requireValue(response && typeof response.status === 'number' && response.body?.getReader,
    'CALL_PERMISSION_PROVIDER_INVALID', 'Meta returned an unreadable permission response.', 502);
  const reader = response.body.getReader(), chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      requireValue(bytes <= 65536, 'CALL_PERMISSION_PROVIDER_INVALID', 'Meta returned an oversized permission response.', 502);
      chunks.push(Buffer.from(part.value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fail('CALL_PERMISSION_PROVIDER_INVALID', 'Meta returned an invalid permission response.', 502); }
  requireValue(plain(value), 'CALL_PERMISSION_PROVIDER_INVALID', 'Meta returned an invalid permission response.', 502);
  return value;
}

/** Fixed Graph origin and server-owned number/version/token; no provider URL,
 * credential or business identity is accepted from the Android request. */
export function createMetaCallPermissionProvider({ phoneNumberId, apiVersion, metaToken,
  fetchImpl = globalThis.fetch, clock = Date.now, timeoutMs = 15000 } = {}) {
  const version = String(apiVersion || '').replace(/^v/, '');
  requireValue(/^\d{5,30}$/.test(phoneNumberId || '') && /^(23|24|25|26)\.0$/.test(version) &&
    typeof metaToken === 'string' && metaToken.length > 0 && typeof fetchImpl === 'function' &&
    Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 15000,
    'CALL_PERMISSION_UNAVAILABLE', 'Calling-permission configuration is unavailable.', 503);
  const origin = `https://graph.facebook.com/v${version}/${phoneNumberId}`;
  async function perform(method, suffix, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await fetchImpl(`${origin}${suffix}`, { method, redirect: 'error',
        signal: controller.signal, headers: { Authorization: `Bearer ${metaToken}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      return { response, data: await boundedJson(response) };
    } finally { clearTimeout(timer); }
  }
  return {
    async check(to) {
      phone(to);
      try {
        const { response, data } = await perform('GET', `/call_permissions?user_wa_id=${encodeURIComponent(to)}`);
        requireValue(response.status >= 200 && response.status < 300 && !data.error,
          'CALL_PERMISSION_STATUS_UNAVAILABLE', 'Meta could not verify calling permission. Check again before requesting or calling.', 502);
        return parseCallPermissionStatus(data, clock());
      } catch {
        throw fail('CALL_PERMISSION_STATUS_UNAVAILABLE', 'Meta could not verify calling permission. Check again before requesting or calling.', 502);
      }
    },
    async send(to) {
      phone(to);
      try {
        const { response, data } = await perform('POST', '/messages', {
          messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'interactive',
          interactive: { type: 'call_permission_request', body: { text: REQUEST_TEXT }, action: { name: 'call_permission_request' } }
        });
        if (response.status >= 400 && response.status < 500 && response.status !== 408 && plain(data.error)) {
          const providerCode = Number.isSafeInteger(data.error.code) ? data.error.code : null;
          // The exact body is never exposed/logged. A clear provider description
          // may select a helpful explanation; no numerical error schema is guessed.
          const windowClosed = /re.?engagement|customer service window|outside.{0,40}window|24.{0,15}hour|template/i
            .test(String(data.error.message || ''));
          return { state: 'blocked', messageId: null, providerCode,
            code: windowClosed ? 'CALL_PERMISSION_WINDOW_CLOSED' : 'CALL_PERMISSION_REQUEST_BLOCKED',
            reason: windowClosed
              ? 'Meta requires an open customer reply window for this free-form request. Ask the customer to message first, or use your existing approved-template workflow.'
              : 'Meta did not accept the permission request. Check request eligibility, the customer reply window and calling configuration before a new request.' };
        }
        const id = data.messages?.[0]?.id;
        const exactRecipient = data.contacts === undefined || Array.isArray(data.contacts) && data.contacts.length === 1 &&
          data.contacts[0]?.wa_id === to;
        if (response.status >= 200 && response.status < 300 && !data.error && exactRecipient &&
          (data.messaging_product === undefined || data.messaging_product === 'whatsapp') && Array.isArray(data.messages) &&
          data.messages.length === 1 && typeof id === 'string' && /^wamid\.[A-Za-z0-9+/=_-]{4,500}$/.test(id))
          return { state: 'sent', messageId: id, providerCode: null, code: null, reason: 'Permission request submitted. Waiting for the customer; this is not permission to call.' };
      } catch { /* No automatic resend after timeout, malformed ACK, or lost response. */ }
      return { state: 'uncertain', messageId: null, providerCode: null, code: null,
        reason: 'The request outcome is uncertain. Check permission and the customer conversation; do not send it again automatically.' };
    }
  };
}

/** Separate durable receipt namespace, using the existing native runtime for
 * every enrollment/tenant/credential check. Provider I/O never runs in a transaction. */
export function createOperatorCallPermission({ getRuntime, getFirestore, collectionPrefix = () => 'sh_operator',
  clock = Date.now, providerFactory = options => createMetaCallPermissionProvider(options) } = {}) {
  const storageError = () => fail('CALL_PERMISSION_STORAGE_UNAVAILABLE',
    'The permission request record is unavailable. Check status before attempting another request.', 503);
  function store() {
    const db = getFirestore?.(), prefix = collectionPrefix();
    requireValue(db?.collection && db?.runTransaction && typeof prefix === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,80}$/.test(prefix),
      'CALL_PERMISSION_UNAVAILABLE', 'Durable calling-permission storage is unavailable.', 503);
    return { db, collection: db.collection(`${prefix}_call_permissions`) };
  }
  async function access(context, to) {
    phone(to);
    const runtime = getRuntime?.();
    requireValue(runtime && typeof runtime.actor === 'function' && typeof runtime.recheck === 'function',
      'CALL_PERMISSION_UNAVAILABLE', 'Native calling-permission service is not configured.', 503);
    const actor = await runtime.actor(context);
    await runtime.requireEnabled();
    const provider = providerFactory({ phoneNumberId: runtime.phoneNumberId,
      apiVersion: runtime.provider.config.apiVersion, metaToken: runtime.provider.config.metaToken, clock });
    const { db, collection } = store();
    const scope = hash(JSON.stringify([runtime.tenantId, runtime.phoneNumberId, to]));
    return { runtime, actor, provider, db, collection, scope, to,
      targetRef: collection.doc(`target_${scope}`),
      operationRef: id => collection.doc(`request_${hash(JSON.stringify([runtime.tenantId, runtime.phoneNumberId, actor.deviceId, id]))}`) };
  }
  const binding = actor => ({ deviceId: actor.deviceId, userId: actor.userId,
    tenantId: actor.tenantId, credentialGeneration: actor.credentialGeneration });
  const sameActor = (row, actor) => row && row.deviceId === actor.deviceId && row.userId === actor.userId &&
    row.tenantId === actor.tenantId && row.credentialGeneration === actor.credentialGeneration;
  function validate(row, a, id, ownerRequired = true) {
    requireValue(row?.schema === 1 && row.scope === a.scope && row.to === a.to && row.phoneNumberId === a.runtime.phoneNumberId &&
      row.tenantId === a.runtime.tenantId && row.requestId === id && (!ownerRequired || sameActor(row.binding, a.actor)) &&
      ['sending', 'sent', 'uncertain', 'blocked'].includes(row.state) && positive(row.createdAtMs) && positive(row.updatedAtMs),
      'CALL_PERMISSION_REQUEST_CONFLICT', 'This request ID belongs to another customer, enrollment or operation. Check the original request.', 409);
    return row;
  }
  function validateTarget(target, a) {
    if (!target) return;
    requireValue(target.schema === 1 && target.scope === a.scope && target.to === a.to &&
      /^request_[a-f0-9]{64}$/.test(target.operationId || '') && typeof target.attemptId === 'string' &&
      /^[a-f0-9-]{36}$/.test(target.attemptId) && ['sending', 'sent', 'uncertain', 'blocked'].includes(target.state) &&
      typeof target.resolved === 'boolean' && positive(target.updatedAtMs),
      'CALL_PERMISSION_REQUEST_CONFLICT', 'The saved customer permission record is inconsistent. Check the original request.', 409);
  }
  function summary(row, replayed = true) {
    if (!row) return null;
    const state = row.state === 'sending' && clock() - row.createdAtMs >= SEND_UNCERTAIN_AFTER_MS ? 'uncertain' : row.state;
    const code = state === 'blocked'
      ? row.code === 'CALL_PERMISSION_WINDOW_CLOSED' ? 'CALL_PERMISSION_WINDOW_CLOSED' : 'CALL_PERMISSION_REQUEST_BLOCKED'
      : null;
    const reason = code === 'CALL_PERMISSION_WINDOW_CLOSED'
      ? 'This free-form request needs an open customer reply window. Ask the customer to message first, or use your existing approved-template workflow.'
      : state === 'blocked' ? 'The permission request was not accepted. Check current eligibility and calling configuration before a new request.'
        : state === 'sent' ? 'Meta accepted the permission request; calling permission is not necessarily granted. Check the current status.'
          : state === 'sending' ? 'The permission request is in progress. Check its status.'
            : 'The request outcome is uncertain. Check permission and the customer conversation; do not send it again automatically.';
    return { requestId: row.requestId, state, code, reason, messageId: row.messageId || null,
      createdAtMs: row.createdAtMs, updatedAtMs: row.updatedAtMs, replayed };
  }
  function pending(target) {
    return target && !target.resolved && (['sending', 'uncertain'].includes(target.state) ||
      target.state === 'sent' && clock() < target.updatedAtMs + REQUEST_REPEAT_GUARD_MS);
  }
  async function readReceipt(a, id) {
    try {
      const targetSnap = await a.targetRef.get(), target = targetSnap.exists ? targetSnap.data() : null;
      const ref = id ? a.operationRef(id) : target?.operationId ? a.collection.doc(target.operationId) : null;
      const snap = ref ? await ref.get() : null;
      let row = snap?.exists ? snap.data() : null;
      if (id && row) validate(row, a, id);
      if (!id && row) { validate(row, a, row.requestId, false); if (!sameActor(row.binding, a.actor)) row = null; }
      validateTarget(target, a);
      return { row, target };
    } catch (error) { if (error instanceof MediaError) throw error; throw storageError(); }
  }
  function dto(a, permission, row, target, replayed = true) {
    const result = { ...permission, limits: permission.limits.map(value => ({ ...value })) };
    if (pending(target) && !result.canCall) {
      result.canRequest = false;
      result.reason = ['sending', 'uncertain'].includes(target.state)
        ? 'A request is in progress or its outcome is uncertain. Check permission and the customer conversation before doing anything else.'
        : 'A permission request was just submitted. Wait for the customer and check status.';
    }
    return { to: a.to, permission: result, request: summary(row, replayed) };
  }
  async function resolveGranted(a, permission, target) {
    // A fresh granted state resolves the need for a request, even when a prior
    // send ACK was lost. It does NOT rewrite that historical send as confirmed.
    if (!permission.canCall || !target || target.resolved) return target;
    try {
      return await a.db.runTransaction(async tx => {
        const snap = await tx.get(a.targetRef), current = snap.exists ? snap.data() : null;
        if (!current || current.operationId !== target.operationId || current.resolved) return current;
        const next = { ...current, resolved: true, resolvedAtMs: clock() };
        tx.set(a.targetRef, next); return next;
      });
    } catch { throw storageError(); }
  }
  async function status(context, input) {
    const to = phone(input?.to), id = input?.requestId === undefined ? undefined : requestId(input.requestId);
    const a = await access(context, to);
    // Validate an explicitly requested immutable identity before provider I/O.
    await readReceipt(a, id);
    const permission = await a.provider.check(to);
    await a.runtime.recheck(context, a.actor);
    // Another device can claim/send while Graph is responding. Never return
    // its older empty fence as permission to send another customer request.
    const saved = await readReceipt(a, id);
    const target = await resolveGranted(a, permission, saved.target);
    return dto(a, permission, saved.row, target);
  }
  async function finish(a, row, outcome) {
    try {
      return await a.db.runTransaction(async tx => {
        const [operationSnap, targetSnap] = await Promise.all([tx.get(a.operationRef(row.requestId)), tx.get(a.targetRef)]);
        const current = operationSnap.exists ? operationSnap.data() : null;
        validate(current, a, row.requestId);
        requireValue(current.attemptId === row.attemptId && current.state === 'sending',
          'CALL_PERMISSION_REQUEST_CONFLICT', 'The permission request changed during dispatch. Check status.', 409);
        const next = { ...current, ...outcome, updatedAtMs: clock() };
        tx.set(a.operationRef(row.requestId), next);
        const target = targetSnap.exists ? targetSnap.data() : null;
        if (target?.operationId === a.operationRef(row.requestId).id && target.attemptId === row.attemptId) {
          tx.set(a.targetRef, { ...target, state: next.state, updatedAtMs: next.updatedAtMs });
        }
        return next;
      });
    } catch (error) { if (error instanceof MediaError) throw error; throw storageError(); }
  }
  async function request(context, input) {
    const to = phone(input?.to), id = requestId(input?.requestId), a = await access(context, to);
    const saved = await readReceipt(a, id);
    let permission = await a.provider.check(to);
    await a.runtime.recheck(context, a.actor);
    if (saved.row) return dto(a, permission, saved.row, saved.target, true);
    requireValue(permission.canRequest === true, 'CALL_PERMISSION_REQUEST_BLOCKED', permission.reason, 409);
    let claimed;
    try {
      claimed = await a.db.runTransaction(async tx => {
        const [operationSnap, targetSnap] = await Promise.all([tx.get(a.operationRef(id)), tx.get(a.targetRef)]);
        if (operationSnap.exists) return { replayed: true, row: validate(operationSnap.data(), a, id) };
        const target = targetSnap.exists ? targetSnap.data() : null;
        validateTarget(target, a);
        requireValue(!pending(target), 'CALL_PERMISSION_REQUEST_BLOCKED',
          'Another permission request is pending or uncertain for this customer. Check status instead of sending it again.', 409);
        const row = { schema: 1, scope: a.scope, to, phoneNumberId: a.runtime.phoneNumberId, tenantId: a.runtime.tenantId,
          requestId: id, binding: binding(a.actor), attemptId: randomUUID(), state: 'sending', messageId: null,
          createdAtMs: clock(), updatedAtMs: clock() };
        tx.set(a.operationRef(id), row);
        tx.set(a.targetRef, { schema: 1, scope: a.scope, to, operationId: a.operationRef(id).id,
          attemptId: row.attemptId, state: row.state, resolved: false, updatedAtMs: row.updatedAtMs });
        return { replayed: false, row };
      });
    } catch (error) { if (error instanceof MediaError) throw error; throw storageError(); }
    if (claimed.replayed) return dto(a, permission, claimed.row, { state: claimed.row.state, updatedAtMs: claimed.row.updatedAtMs }, true);
    let outcome;
    try {
      // Firestore contention can delay the claim. Refresh eligibility while
      // holding our durable fence, then check the exact credential once more
      // immediately before the only consequential dispatch.
      await a.runtime.requireEnabled();
      await a.runtime.recheck(context, a.actor);
      permission = await a.provider.check(to);
      requireValue(permission.canRequest === true, 'CALL_PERMISSION_REQUEST_BLOCKED', permission.reason, 409);
      await a.runtime.requireEnabled();
      await a.runtime.recheck(context, a.actor);
    } catch (error) {
      await finish(a, claimed.row, { state: 'blocked', code: error instanceof MediaError ? error.code : 'CALL_PERMISSION_UNAVAILABLE',
        messageId: null, reason: 'Authorization or eligibility could not be confirmed before dispatch; no request was sent.' });
      throw error;
    }
    try { outcome = await a.provider.send(to); }
    catch { outcome = { state: 'uncertain', messageId: null, reason: 'The provider outcome is uncertain. Check permission before any new request.' }; }
    if (!outcome || !['sent', 'blocked', 'uncertain'].includes(outcome.state))
      outcome = { state: 'uncertain', messageId: null, reason: 'The provider outcome is uncertain. Check permission before any new request.' };
    const row = await finish(a, claimed.row, outcome), target = { state: row.state, updatedAtMs: row.updatedAtMs };
    const result = dto(a, permission, row, target, false);
    result.permission.canRequest = false;
    result.permission.reason = outcome.reason;
    if (outcome.state === 'blocked') throw fail(outcome.code || 'CALL_PERMISSION_REQUEST_BLOCKED', outcome.reason, 409,
      { request: summary(row, false), providerCode: outcome.providerCode ?? null });
    return result;
  }
  function mount(app) {
    const wrap = (action, isPost) => async (req, res) => {
      res.set('Cache-Control', 'no-store');
      try {
        const input = isPost ? req.body : req.query;
        requireValue(plain(input) && JSON.stringify(input).length <= 1024 &&
          Object.keys(input).every(key => ['to', 'requestId'].includes(key)),
          'INVALID_INPUT', 'Use only the customer number and stable request ID for this action.', 400);
        const result = await action(req, input);
        res.status(200).json({ ok: true, ...result });
      } catch (error) {
        const known = error instanceof MediaError;
        res.status(known ? error.statusCode : 503).json({ ok: false,
          code: known ? error.code : 'CALL_PERMISSION_UNAVAILABLE',
          error: known ? error.message : 'Calling-permission service is temporarily unavailable.',
          ...(known && error.request ? { request: error.request } : {}),
          ...(known && Number.isSafeInteger(error.providerCode) ? { providerCode: error.providerCode } : {}) });
      }
    };
    app.get('/api/operator-android/call-permission/status', wrap(status, false));
    app.post('/api/operator-android/call-permission/request', wrap(request, true));
  }
  return { status, request, mount };
}
