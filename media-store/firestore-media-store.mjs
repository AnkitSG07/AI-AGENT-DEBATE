// Server-only durable transaction and recovery-index adapter. No provider calls,
// native routes, credentials, feature activation or history deletion live here.
import { createHash, randomUUID } from 'node:crypto';
import { MediaError } from '../media/errors.mjs';

const HASH = value => createHash('sha256').update(String(value)).digest('hex');
const MAX_DUE = Number.MAX_SAFE_INTEGER;
const MAX_CALL_BYTES = 512 * 1024;
const MAX_OTHER_BYTES = 32 * 1024;
const MAX_PENDING_ANSWER_BYTES = 256 * 1024;
const MAX_WRITES = 450;
const PENDING_TRANSFER = new Set(['invited', 'connecting']);
const FINAL_TRANSFER = new Set(['completed', 'declined', 'cancelled', 'expired', 'failed']);
const clone = value => structuredClone(value);
const isObject = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const validTime = value => Number.isSafeInteger(value) && value >= 0;
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 220 && !/[\u0000-\u001f\u007f]/.test(value);
const eventIdentifier = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);

export class MediaStoreError extends MediaError {
  constructor(code, message, statusCode = 409) {
    super(code, message, statusCode);
    this.name = 'MediaStoreError';
    this.mediaStoreError = true;
  }
}
const fail = (code, message, statusCode = 409) => { throw new MediaStoreError(code, message, statusCode); };
const unavailable = () => new MediaStoreError('MEDIA_STORE_UNAVAILABLE', 'Durable call storage is temporarily unavailable.', 503);
function requireInput(condition, message) { if (!condition) fail('INVALID_MEDIA_STORE_INPUT', message, 400); }

function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  fail('INVALID_MEDIA_RECORD', 'Call storage accepts finite JSON values only.', 400);
}
const fingerprint = value => HASH(canonical(value));
function boundedValue(value, bytes) {
  requireInput(isObject(value), 'A plain record is required.');
  const serialized = canonical(value);
  if (Buffer.byteLength(serialized) > bytes) fail('MEDIA_RECORD_LIMIT', 'Call state exceeded its bounded record size.', 503);
  return clone(value);
}
function parseKey(key) {
  const match = typeof key === 'string' && /^media_(calls|reservations|sessions|events)\/([a-f0-9]{64})$/.exec(key);
  requireInput(match, 'Only exact hashed private media record keys are accepted.');
  return { kind: match[1], id: match[2] };
}
function callKeyFor(id) { requireInput(identifier(id), 'An exact call ID is required.'); return `media_calls/${HASH(id)}`; }
function reservationKeyFor(id) { requireInput(identifier(id), 'An exact device ID is required.'); return `media_reservations/${HASH(id)}`; }
export function sessionStoreKey(id) { requireInput(identifier(id), 'An exact media session ID is required.'); return `media_sessions/${HASH(id)}`; }
export function eventStoreKey(id) { requireInput(eventIdentifier(id), 'An exact private provider event key is required.'); return `media_events/${HASH(id)}`; }

function readEnvelope(snapshot, key) {
  if (!snapshot.exists) return undefined;
  const row = snapshot.data();
  if (!row || row.schema !== 1 || row.key !== key || !Number.isSafeInteger(row.revision) || row.revision < 1 ||
      !validTime(row.updatedAt) || !isObject(row.data)) throw unavailable();
  try {
    const kind = parseKey(key).kind;
    if (kind === 'calls') validateCall(row.data, key);
    else if (kind === 'reservations') validateReservation(row.data);
    else if (kind === 'sessions') validateSession(row.data, key);
    else validateEvent(row.data, key);
  } catch { throw unavailable(); }
  return row;
}

function validateCall(value, key, before) {
  const call = boundedValue(value, MAX_CALL_BYTES);
  requireInput(identifier(call.id) && callKeyFor(call.id) === key && identifier(call.tenantId) &&
    identifier(call.roomName) && identifier(call.customerIdentity) && identifier(call.provider), 'Invalid immutable call identity.');
  requireInput(typeof call.active === 'boolean' && identifier(call.status) && call.mediaAnchor === 'room' &&
    Number.isSafeInteger(call.version) && call.version >= 1 && isObject(call.owner) &&
    ['deviceId', 'userId', 'identity', 'legId'].every(field => identifier(call.owner[field])) &&
    isObject(call.requests) && isObject(call.transferHistory) && Array.isArray(call.outbox) &&
    validTime(call.createdAt) && validTime(call.updatedAt), 'Invalid bridged-call record.');
  requireInput(call.outbox.length <= 200 && Object.keys(call.transferHistory).length <= 64 &&
    Object.keys(call.requests).length <= 64, 'Call transfer history exceeds its bounded capacity.');
  const jobIds = new Set();
  for (const job of call.outbox) {
    requireInput(isObject(job) && identifier(job.id) && !jobIds.has(job.id) && ['detach', 'terminate'].includes(job.kind) &&
      ['pending', 'running', 'done'].includes(job.status) && Number.isSafeInteger(job.attempts) && job.attempts >= 0 && validTime(job.notBefore), 'Invalid call cleanup job.');
    if (job.status === 'running') requireInput(identifier(job.leaseId) && validTime(job.leaseUntil), 'A running cleanup job needs an exact bounded lease.');
    jobIds.add(job.id);
  }
  for (const transfer of [...Object.values(call.transferHistory), ...(call.transfer ? [call.transfer] : [])]) {
    requireInput(isObject(transfer) && identifier(transfer.id) && identifier(transfer.fromDeviceId) && identifier(transfer.toDeviceId) &&
      ['invited', 'connecting', 'completing', ...FINAL_TRANSFER].includes(transfer.status) &&
      validTime(transfer.createdAt) && validTime(transfer.expiresAt) && Number.isSafeInteger(transfer.generation) && transfer.generation >= 1,
    'Invalid transfer record.');
  }
  if (!call.active) requireInput(isObject(call.terminal) && validTime(call.terminal.endedAt) &&
    ['BUSINESS_INITIATED', 'USER_INITIATED'].includes(call.terminal.reason) &&
    (call.terminal.confirmedAt === undefined || (validTime(call.terminal.confirmedAt) && call.terminal.confirmedAt >= call.terminal.endedAt)),
  'An inactive call needs durable, valid terminal state.');
  if (call.active && call.terminal) fail('TERMINAL_CALL_WINS', 'A terminal call cannot become active.');
  if (!before) return call;
  for (const field of ['id', 'tenantId', 'roomName', 'customerIdentity', 'provider', 'mediaAnchor', 'createdAt']) {
    if (call[field] !== before[field]) fail('CALL_IDENTITY_IMMUTABLE', 'The persisted call media identity cannot change.');
  }
  if (call.version < before.version) fail('STALE_CALL_VERSION', 'Call versions cannot move backwards.');
  if (!before.active || before.terminal) {
    if (call.active || !call.terminal || call.terminal.endedAt !== before.terminal?.endedAt || call.terminal.reason !== before.terminal?.reason ||
        (before.terminal?.confirmedAt !== undefined && call.terminal.confirmedAt !== before.terminal.confirmedAt) ||
        canonical(call.owner) !== canonical(before.owner) || (before.status === 'ended' && call.status !== 'ended')) {
      fail('TERMINAL_CALL_WINS', 'Terminal call state takes precedence over delayed writes.');
    }
  }
  for (const [request, prior] of Object.entries(before.requests)) if (!call.requests[request] || canonical(call.requests[request]) !== canonical(prior)) {
    fail('CALL_IDEMPOTENCY_IMMUTABLE', 'Persisted request results cannot be removed or changed.');
  }
  for (const [id, prior] of Object.entries(before.transferHistory)) if (!call.transferHistory[id] || canonical(call.transferHistory[id]) !== canonical(prior)) {
    fail('TRANSFER_HISTORY_IMMUTABLE', 'Completed transfer history cannot be removed or rewritten.');
  }
  if (before.transfer && FINAL_TRANSFER.has(before.transfer.status)) {
    const next = call.transfer?.id === before.transfer.id ? call.transfer : call.transferHistory[before.transfer.id];
    if (!next || canonical(next) !== canonical(before.transfer)) fail('TRANSFER_GENERATION_WINS', 'An old transfer cannot become pending again or change its target.');
  } else if (before.transfer) {
    if (call.transfer?.id !== before.transfer.id) fail('TRANSFER_GENERATION_WINS', 'A pending or completing transfer cannot be replaced.');
    for (const field of ['id', 'fromDeviceId', 'toDeviceId', 'toUserId', 'sourceIdentity', 'requestId', 'generation', 'createdAt', 'expiresAt']) {
      if (call.transfer[field] !== before.transfer[field]) fail('TRANSFER_GENERATION_WINS', 'The current transfer identity and generation cannot change.');
    }
    const allowed = {
      invited: new Set(['invited', 'connecting', 'declined', 'cancelled', 'expired', 'failed']),
      connecting: new Set(['connecting', 'completing', 'declined', 'cancelled', 'expired', 'failed']),
      completing: new Set(['completing', 'completed', ...(call.active ? [] : ['cancelled'])])
    };
    if (!allowed[before.transfer.status]?.has(call.transfer.status)) fail('TRANSFER_GENERATION_WINS', 'Transfer state cannot move backwards.');
    for (const field of ['attemptId', 'readinessNonce', 'targetIdentity', 'acceptedAt']) if (before.transfer[field] !== undefined && call.transfer[field] !== before.transfer[field]) {
      fail('TRANSFER_GENERATION_WINS', 'The accepted media leg and readiness challenge cannot change.');
    }
  }
  for (const prior of before.outbox) {
    const next = call.outbox.find(job => job.id === prior.id);
    if (!next || next.attempts < prior.attempts || (prior.status === 'done' && next.status !== 'done')) {
      fail('CLEANUP_GENERATION_WINS', 'Acknowledged cleanup cannot be removed, replayed or rolled backwards.');
    }
    for (const field of ['id', 'kind', 'identity', 'roomName', 'deviceId', 'callId', 'transferId', 'revokeBeforeMs']) {
      if (next[field] !== prior[field]) fail('CLEANUP_TARGET_IMMUTABLE', 'A persisted cleanup job cannot be retargeted.');
    }
    if (next.reason !== prior.reason && !(prior.kind === 'terminate' && prior.status === 'pending' &&
        prior.reason === 'BUSINESS_INITIATED' && next.reason === 'USER_INITIATED' && !call.active && call.terminal?.confirmedAt !== undefined)) {
      fail('CLEANUP_TARGET_IMMUTABLE', 'A persisted cleanup reason cannot change except after verified customer termination.');
    }
  }
  // Outbox lease/attempt bookkeeping intentionally does not change the UI call
  // version. The envelope revision still advances for every committed mutation.
  if (call.version === before.version) {
    const semantics = row => ({ active: row.active, status: row.status, owner: row.owner, terminal: row.terminal || null,
      transfer: row.transfer, transferHistory: row.transferHistory, requests: row.requests });
    if (canonical(semantics(call)) !== canonical(semantics(before))) fail('STALE_CALL_VERSION', 'A semantic call update needs a newer version.');
  }
  return call;
}

function validateReservation(value) {
  const row = boundedValue(value, MAX_OTHER_BYTES);
  requireInput(identifier(row.callId) && ['owner', 'invite', 'cleanup', 'pending'].includes(row.kind), 'Invalid device reservation.');
  if (row.kind === 'invite') requireInput(identifier(row.transferId) && validTime(row.expiresAt), 'Invalid invitation reservation.');
  if (row.kind === 'cleanup') requireInput(identifier(row.identity), 'Cleanup reservations require an exact media identity.');
  if (row.kind === 'pending' || row.sessionId !== undefined) requireInput(identifier(row.sessionId) && identifier(row.deviceId), 'Session reservations require exact session and device IDs.');
  if (row.kind === 'pending') requireInput(row.callId === row.sessionId, 'A pending reservation remains bound to its stable session ID.');
  return row;
}

function validateEvent(value, key) {
  const event = boundedValue(value, value?.kind === 'pending-answer' ? MAX_PENDING_ANSWER_BYTES : MAX_OTHER_BYTES);
  requireInput(eventIdentifier(event.id) && eventStoreKey(event.id) === key, 'Provider-event marker must match its exact event key.');
  if (event.kind === 'pending-answer') requireInput(
    event.id === `answer:${HASH(event.providerCallId)}` &&
    ['tenantId', 'phoneNumberId', 'providerCallId', 'providerFingerprint'].every(field => identifier(event[field])) &&
    validTime(event.createdAt) && typeof event.answerSdp === 'string' && event.answerSdp.length < 200000 &&
    Buffer.byteLength(event.answerSdp, 'utf8') < 240000 && /^v=0\r?\n/.test(event.answerSdp) &&
    /(?:^|\r?\n)m=audio\s/.test(event.answerSdp),
  'An early answer requires an exact private business/call binding and bounded audio SDP.');
  return event;
}

function validateSession(value, key, before) {
  const session = boundedValue(value, MAX_CALL_BYTES);
  requireInput(identifier(session.id) && sessionStoreKey(session.id) === key && identifier(session.tenantId) &&
    identifier(session.provider) && ['incoming', 'outgoing'].includes(session.direction) && identifier(session.phase) &&
    Number.isSafeInteger(session.version) && session.version >= 1 && validTime(session.createdAt) && validTime(session.updatedAt),
  'Invalid private media session.');
  requireInput(isObject(session.operations) && Object.keys(session.operations).length <= 32 &&
    Array.isArray(session.outbox) && session.outbox.length <= 200, 'A media session requires bounded durable operations and cleanup.');
  for (const operation of Object.values(session.operations)) requireInput(isObject(operation) && identifier(operation.id) &&
    ['issued', 'uncertain', 'acknowledged', 'provider-ended', 'failed'].includes(operation.status) &&
    validTime(operation.issuedAt) && validTime(operation.leaseUntil), 'Invalid issued media operation.');
  const jobIds = new Set();
  for (const job of session.outbox) {
    requireInput(isObject(job) && identifier(job.id) && !jobIds.has(job.id) &&
      ['notify', 'connect', 'reject', 'terminate', 'detach'].includes(job.kind) &&
      ['pending', 'running', 'done'].includes(job.status) && Number.isSafeInteger(job.attempts) &&
      job.attempts >= 0 && validTime(job.notBefore), 'Invalid session cleanup job.');
    if (job.status === 'running') requireInput(identifier(job.leaseId) && validTime(job.leaseUntil), 'A running session job requires an exact execution lease.');
    jobIds.add(job.id);
  }
  if (session.providerCallId !== undefined && session.providerCallId !== null && session.providerCallId !== '') requireInput(identifier(session.providerCallId), 'Invalid provider call binding.');
  if (session.owner !== undefined && session.owner !== null) requireInput(isObject(session.owner) &&
    ['deviceId', 'userId', 'legId', 'identity'].every(field => identifier(session.owner[field])), 'Invalid session owner binding.');
  if (session.nextActionAtMs !== undefined && session.nextActionAtMs !== null) requireInput(validTime(session.nextActionAtMs), 'Invalid session recovery deadline.');
  if (session.customerAcceptedAt !== undefined && session.customerAcceptedAt !== null) requireInput(validTime(session.customerAcceptedAt), 'Invalid provider acceptance timestamp.');
  if (session.routeChoice !== undefined) requireInput(['native', 'legacy'].includes(session.routeChoice), 'Invalid immutable call route selection.');
  if (session.legacyClaim !== undefined) requireInput(isObject(session.legacyClaim) && identifier(session.legacyClaim.operationId) &&
    validTime(session.legacyClaim.claimedAt) && session.routeChoice === 'legacy', 'A legacy route claim needs an exact operation and timestamp.');
  if (session.routeChoice === 'legacy') requireInput(session.legacyClaim && !session.owner && session.terminal?.nativeOnly === true &&
    session.terminal.reason === 'LEGACY_CLAIMED' && session.outbox.every(job => job.kind === 'notify'),
  'A legacy route cannot own or change native/customer media.');
  if (session.terminal) requireInput(isObject(session.terminal) && identifier(session.terminal.reason) && validTime(session.terminal.endedAt) &&
    (session.terminal.confirmedAt === undefined || (validTime(session.terminal.confirmedAt) && session.terminal.confirmedAt >= session.terminal.endedAt)) &&
    (['ending', 'ended', 'failed'].includes(session.phase) || session.phase === 'answered_elsewhere' && session.routeChoice === 'legacy'),
  'A terminal session needs valid terminal state and cannot be connected.');
  if (session.phase === 'connected') requireInput(identifier(session.providerCallId) && session.owner && !session.terminal, 'A connected session needs its exact provider call and owner.');
  if (!before) return session;
  if (session.version < before.version) fail('STALE_SESSION_VERSION', 'Media session versions cannot move backwards.');
  for (const field of ['id', 'tenantId', 'provider', 'direction', 'createdAt']) if (session[field] !== before[field]) {
    fail('SESSION_IDENTITY_IMMUTABLE', 'The persisted media session routing cannot change.');
  }
  for (const field of ['providerCallId', 'roomName', 'customerIdentity', 'phoneNumberId', 'requestId', 'customerAcceptedAt']) {
    if (before[field] !== undefined && before[field] !== null && before[field] !== '' && session[field] !== before[field]) {
      fail('SESSION_IDENTITY_IMMUTABLE', 'An assigned media routing identity cannot change.');
    }
  }
  if (before.routeChoice !== undefined && session.routeChoice !== before.routeChoice ||
      before.legacyClaim !== undefined && canonical(session.legacyClaim || null) !== canonical(before.legacyClaim)) {
    fail('SESSION_ROUTE_IMMUTABLE', 'An assigned browser/native call route and its exact claim cannot change.');
  }
  if (before.terminal) {
    if (!session.terminal || session.terminal.endedAt !== before.terminal.endedAt || session.terminal.reason !== before.terminal.reason ||
        (before.terminal.confirmedAt !== undefined && session.terminal.confirmedAt !== before.terminal.confirmedAt) ||
        canonical(session.owner || null) !== canonical(before.owner || null) || (before.phase === 'ended' && session.phase !== 'ended')) {
      fail('TERMINAL_SESSION_WINS', 'Terminal session intent takes precedence over delayed signaling results.');
    }
  }
  for (const [name, prior] of Object.entries(before.operations)) {
    const next = session.operations[name];
    if (!next || ['id', 'issuedAt', 'leaseUntil'].some(field => next[field] !== prior[field])) {
      fail('SESSION_OPERATION_IMMUTABLE', 'An issued provider operation cannot be removed, replaced or extended.');
    }
    if ((prior.status !== 'issued' && next.status === 'issued') ||
        (['acknowledged', 'provider-ended', 'failed'].includes(prior.status) && next.status === 'uncertain')) {
      fail('SESSION_OPERATION_GENERATION_WINS', 'A resolved or uncertain provider operation cannot be issued again.');
    }
  }
  for (const prior of before.outbox) {
    const next = session.outbox.find(job => job.id === prior.id);
    if (!next || next.attempts < prior.attempts || (prior.status === 'done' && next.status !== 'done')) {
      fail('CLEANUP_GENERATION_WINS', 'Session cleanup cannot be removed, replayed or rolled backwards.');
    }
    for (const field of ['id', 'kind', 'identity', 'roomName', 'deviceId', 'callId', 'transferId', 'toDeviceId', 'event', 'revokeBeforeMs']) {
      if (next[field] !== prior[field]) fail('CLEANUP_TARGET_IMMUTABLE', 'A persisted session job cannot be retargeted.');
    }
    if (next.reason !== prior.reason && !(prior.kind === 'terminate' && prior.status === 'pending' &&
        prior.reason === 'BUSINESS_INITIATED' && next.reason === 'USER_INITIATED' && session.terminal?.confirmedAt !== undefined)) {
      fail('CLEANUP_TARGET_IMMUTABLE', 'A session termination reason can change only after verified customer termination.');
    }
  }
  if (session.version === before.version) {
    const semantic = row => ({ phase: row.phase, providerCallId: row.providerCallId || null, owner: row.owner || null,
      terminal: row.terminal || null, roomName: row.roomName || null, customerIdentity: row.customerIdentity || null,
      customerAcceptedAt: row.customerAcceptedAt ?? null });
    if (canonical(semantic(session)) !== canonical(semantic(before))) fail('STALE_SESSION_VERSION', 'A semantic session update needs a newer version.');
  }
  return session;
}

function sessionProjection(session) {
  const callKey = sessionStoreKey(session.id), id = HASH(`${callKey}:session-recovery`);
  const sourceDueAtMs = session.nextActionAtMs === undefined || session.nextActionAtMs === null ? MAX_DUE : session.nextActionAtMs;
  const value = { callId: session.id, callKey, sessionId: session.id, workType: 'session', workId: session.id, transferId: '', sourceDueAtMs,
    data: { sessionId: session.id, version: session.version, phase: session.phase, nextActionAtMs: session.nextActionAtMs ?? null } };
  return { id, value };
}

function projections(call) {
  const transfers = new Map(), jobs = new Map();
  const callKey = callKeyFor(call.id);
  for (const transfer of [...Object.values(call.transferHistory), ...(call.transfer ? [call.transfer] : [])]) {
    const id = HASH(`${callKey}:transfer:${transfer.id}`);
    transfers.set(id, { callId: call.id, callKey, transferId: transfer.id, data: clone(transfer) });
    const workId = HASH(`${callKey}:expire:${transfer.id}`);
    const currentPending = call.active && !call.terminal && call.transfer?.id === transfer.id && PENDING_TRANSFER.has(transfer.status);
    jobs.set(workId, { callId: call.id, callKey, workType: 'expire', workId: transfer.id, transferId: transfer.id,
      sourceDueAtMs: currentPending ? transfer.expiresAt : MAX_DUE,
      data: { transferId: transfer.id, generation: transfer.generation, expiresAt: transfer.expiresAt, status: transfer.status } });
  }
  for (const job of call.outbox) {
    const workId = HASH(`${callKey}:cleanup:${job.id}`);
    jobs.set(workId, { callId: call.id, callKey, workType: 'cleanup', workId: job.id, transferId: job.transferId || '',
      sourceDueAtMs: job.status === 'done' ? MAX_DUE : job.status === 'running' ? job.leaseUntil : job.notBefore,
      data: clone(job) });
  }
  return { transfers, jobs };
}

/**
 * Implements TransferController's durable store contract. Firestore callbacks may
 * retry; callers must keep provider/network/user-visible side effects outside.
 * Canonical call data remains one atomic record. Transfer/job projections are
 * derived atomically and only used for lookup and bounded recovery discovery.
 */
export function createFirestoreMediaStore({ firestore, collectionPrefix = 'sh_operator_media', clock = Date.now,
  recoveryLeaseMs = 60000, onTiming = () => {} } = {}) {
  requireInput(firestore && typeof firestore.collection === 'function' && typeof firestore.runTransaction === 'function', 'A server Firestore client is required.');
  requireInput(/^[A-Za-z][A-Za-z0-9_]{0,80}$/.test(collectionPrefix), 'Invalid media namespace.');
  requireInput(Number.isSafeInteger(recoveryLeaseMs) && recoveryLeaseMs >= 45000 && recoveryLeaseMs <= 120000, 'Recovery leases must be between 45 and 120 seconds.');
  const collections = Object.fromEntries(['calls', 'reservations', 'transfers', 'jobs', 'sessions', 'events'].map(name => [name, firestore.collection(`${collectionPrefix}_${name}`)]));
  const reference = key => { const parsed = parseKey(key); return collections[parsed.kind].doc(parsed.id); };
  const nowMs = () => { const now = clock(); if (!validTime(now) || !now) throw unavailable(); return now; };
  const guarded = async (operation, stage) => {
    const started = performance.now(); let ok = false;
    try { const value = await operation(); ok = true; return value; }
    catch (error) { if (error instanceof MediaError) throw error; throw unavailable(); }
    finally { if (stage) try { onTiming({ stage, elapsedMs: Math.round(performance.now() - started), ok }); } catch { /* diagnostics only */ } }
  };

  async function get(key) {
    const ref = reference(key);
    return guarded(async () => clone(readEnvelope(await ref.get(), key)?.data), 'read');
  }

  async function transaction(operation) {
    requireInput(typeof operation === 'function', 'A transaction callback is required.');
    return guarded(() => firestore.runTransaction(async native => {
      const reads = new Map(), staged = new Map(); let writing = false;
      const read = async key => {
        if (reads.has(key)) return reads.get(key);
        const row = readEnvelope(await native.get(reference(key)), key);
        reads.set(key, row); return row;
      };
      const tx = Object.freeze({
        get: async key => {
          if (writing) fail('READS_BEFORE_WRITES', 'Read all transaction records before staging writes.', 400);
          parseKey(key); return clone((await read(key))?.data);
        },
        set: (key, value) => { parseKey(key); writing = true; staged.set(key, { value: clone(value), createOnly: staged.get(key)?.createOnly || !reads.has(key) }); },
        create: (key, value) => { parseKey(key); writing = true; staged.set(key, { value: clone(value), createOnly: true }); },
        delete: key => {
          const parsed = parseKey(key);
          if (parsed.kind !== 'reservations') fail('CALL_DELETE_FORBIDDEN', 'Call/session records and event replay protection cannot be deleted by this adapter.');
          if (!reads.has(key)) fail('CONDITIONAL_READ_REQUIRED', 'Read the exact reservation before removing it.');
          writing = true; staged.set(key, { remove: true });
        }
      });
      const result = await operation(tx);
      if (!staged.size) return result;
      // Absent-only creates still need snapshot reads before any native write.
      // Read their independent keys in one RPC, retaining the same transaction
      // snapshot, validation and retry behavior instead of serial round trips.
      const missing = [...staged.keys()].filter(key => !reads.has(key));
      if (missing.length && typeof native.getAll === 'function') {
        const snapshots = await native.getAll(...missing.map(reference));
        missing.forEach((key, index) => reads.set(key, readEnvelope(snapshots[index], key)));
      } else await Promise.all(missing.map(read));
      const now = nowMs(), writes = [], changedCalls = [], changedSessions = [], reservationChanges = [];
      // All writes are buffered. Even an unread create gets a transactional
      // absent-only read before any native Firestore mutation is staged.
      for (const [key, change] of staged) {
        const parsed = parseKey(key), before = await read(key), ref = reference(key);
        if (change.remove) {
          if (before?.data.kind === 'owner') fail('OWNER_RESERVATION_PROTECTED', 'An owner reservation must transition to verified cleanup before removal.');
          if (before) writes.push({ kind: 'delete', ref });
          continue;
        }
        if (change.createOnly && before) fail('RECORD_ALREADY_EXISTS', 'A call or device reservation already exists.');
        const value = parsed.kind === 'calls' ? validateCall(change.value, key, before?.data) :
          parsed.kind === 'reservations' ? validateReservation(change.value) :
          parsed.kind === 'sessions' ? validateSession(change.value, key, before?.data) : validateEvent(change.value, key);
        if (parsed.kind === 'events' && before && canonical(before.data) !== canonical(value)) fail('EVENT_ALREADY_PROCESSED', 'A processed provider-event marker cannot be rewritten.');
        if (parsed.kind === 'reservations') reservationChanges.push({ key, before: before?.data, value });
        const envelope = { schema: 1, key, revision: (before?.revision || 0) + 1, updatedAt: now, data: value };
        writes.push({ kind: before ? 'set' : 'create', ref, value: envelope });
        if (parsed.kind === 'calls') changedCalls.push({ before: before?.data, call: value, revision: envelope.revision });
        if (parsed.kind === 'sessions') changedSessions.push({ before: before?.data, session: value, revision: envelope.revision });
      }
      for (const { key, before, value } of reservationChanges) {
        if (value.sessionId && key !== reservationKeyFor(value.deviceId)) fail('DEVICE_RESERVATION_CONFLICT', 'Session reservation device must match its exact hashed key.');
        if (!before) continue;
        if (before.kind === 'cleanup' && value.kind !== 'cleanup') fail('DEVICE_RESERVATION_CONFLICT', 'Cleanup reservations must be released before another ownership claim.');
        if (before.kind === 'owner' && !['owner', 'cleanup'].includes(value.kind)) fail('DEVICE_RESERVATION_CONFLICT', 'An active owner cannot become a pending invitation.');
        const promotion = before.kind === 'pending' && value.kind === 'owner';
        if (!promotion && before.callId === value.callId) continue;
        const sessionId = before.sessionId;
        if (!identifier(sessionId) || !['pending', 'cleanup'].includes(before.kind)) fail('DEVICE_RESERVATION_CONFLICT', 'A device reservation cannot move to another call.');
        const sessionKey = sessionStoreKey(sessionId);
        const session = staged.get(sessionKey)?.value || (await read(sessionKey))?.data;
        if (!session || key !== reservationKeyFor(before.deviceId) || session.owner?.deviceId !== before.deviceId ||
            session.providerCallId !== value.callId) fail('DEVICE_RESERVATION_CONFLICT', 'The new reservation must match its persisted provider call and device.');
        if (promotion) {
          const promoted = staged.get(callKeyFor(value.callId))?.value;
          if (!staged.has(sessionKey) || session.phase !== 'connected' || session.terminal || !promoted ||
              promoted.owner?.deviceId !== before.deviceId || promoted.tenantId !== session.tenantId || promoted.roomName !== session.roomName) {
            fail('SESSION_PROMOTION_REQUIRED', 'Promote the connected session, exact call and owner together.');
          }
        } else if (value.kind !== 'cleanup' || value.sessionId !== sessionId || value.deviceId !== before.deviceId || !session.terminal) {
          fail('DEVICE_RESERVATION_CONFLICT', 'Only terminal cleanup may bind a pending session to its final provider call.');
        }
      }
      // A new call and its owner must be created together, absent-only. This also
      // rejects the legacy test pattern when its blind owner set would overwrite.
      for (const change of changedCalls) if (!change.before) {
        const owner = staged.get(reservationKeyFor(change.call.owner.deviceId));
        if (!owner || owner.remove || owner.value?.callId !== change.call.id || owner.value?.kind !== 'owner') {
          fail('OWNER_RESERVATION_REQUIRED', 'Create the initial call and its exact owner reservation atomically.');
        }
      }
      // Multi-leg End can project several cleanup jobs. Their prior leases are
      // independent reads in this same transaction, not sequential RPCs.
      const jobRefs = new Map();
      for (const { before, call } of changedCalls) {
        const previous = before ? projections(before).jobs : new Map();
        for (const [id, value] of projections(call).jobs)
          if (!previous.has(id) || fingerprint(previous.get(id)) !== fingerprint(value)) jobRefs.set(id, collections.jobs.doc(id));
      }
      for (const { before, session } of changedSessions) {
        const { id, value } = sessionProjection(session);
        if (!before || fingerprint(sessionProjection(before).value) !== fingerprint(value)) jobRefs.set(id, collections.jobs.doc(id));
      }
      const jobEntries = [...jobRefs], jobSnapshots = new Map();
      if (jobEntries.length) {
        const refs = jobEntries.map(([, ref]) => ref);
        const snapshots = typeof native.getAll === 'function' ? await native.getAll(...refs) : await Promise.all(refs.map(ref => native.get(ref)));
        jobEntries.forEach(([id], index) => jobSnapshots.set(id, snapshots[index]));
      }
      for (const { before, call, revision } of changedCalls) {
        const previous = before ? projections(before) : { transfers: new Map(), jobs: new Map() };
        const next = projections(call);
        for (const [id, value] of next.transfers) {
          const prior = previous.transfers.get(id);
          if (prior && fingerprint(prior) === fingerprint(value)) continue;
          writes.push({ kind: 'set', ref: collections.transfers.doc(id), value: { schema: 1, ...value, callRevision: revision, updatedAt: now } });
        }
        for (const [id, value] of next.jobs) {
          const prior = previous.jobs.get(id);
          if (prior && fingerprint(prior) === fingerprint(value)) continue;
          const ref = collections.jobs.doc(id), snapshot = jobSnapshots.get(id), existing = snapshot.exists ? snapshot.data() : null;
          if (existing && (existing.schema !== 1 || existing.callKey !== value.callKey || existing.workId !== value.workId)) throw unavailable();
          const leaseUntil = existing?.claimUntilMs || 0, retryAt = existing?.retryNotBeforeMs || 0;
          writes.push({ kind: 'set', ref, value: { schema: 1, ...value, sourceFingerprint: fingerprint(value), callRevision: revision,
            claimId: existing?.claimId || '', claimGeneration: existing?.claimGeneration || 0,
            claimUntilMs: leaseUntil, workerId: existing?.workerId || '', retryNotBeforeMs: retryAt,
            availableAtMs: Math.max(value.sourceDueAtMs, leaseUntil, retryAt), createdAt: existing?.createdAt || now, updatedAt: now } });
        }
      }
      for (const { before, session, revision } of changedSessions) {
        const { id, value } = sessionProjection(session);
        if (before && fingerprint(sessionProjection(before).value) === fingerprint(value)) continue;
        const ref = collections.jobs.doc(id), snapshot = jobSnapshots.get(id), existing = snapshot.exists ? snapshot.data() : null;
        if (existing && (existing.schema !== 1 || existing.callKey !== value.callKey || existing.workType !== 'session')) throw unavailable();
        const leaseUntil = existing?.claimUntilMs || 0, retryAt = existing?.retryNotBeforeMs || 0;
        writes.push({ kind: 'set', ref, value: { schema: 1, ...value, sourceFingerprint: fingerprint(value), callRevision: revision,
          claimId: existing?.claimId || '', claimGeneration: existing?.claimGeneration || 0, claimUntilMs: leaseUntil,
          workerId: existing?.workerId || '', retryNotBeforeMs: retryAt, availableAtMs: Math.max(value.sourceDueAtMs, leaseUntil, retryAt),
          createdAt: existing?.createdAt || now, updatedAt: now } });
      }
      if (writes.length > MAX_WRITES) fail('MEDIA_TRANSACTION_LIMIT', 'Call update exceeded its bounded transaction size.', 503);
      for (const write of writes) {
        if (write.kind === 'delete') native.delete(write.ref);
        else if (write.kind === 'create') native.create(write.ref, write.value);
        else native.set(write.ref, write.value);
      }
      return result;
    }), 'transaction');
  }

  /** Trusted coordinator helper; never converts/replaces an existing call. */
  async function createCall(call) {
    const key = callKeyFor(call?.id), ownerKey = reservationKeyFor(call?.owner?.deviceId);
    return transaction(async tx => {
      if (await tx.get(key)) fail('CALL_ALREADY_EXISTS', 'This call already has persisted routing/state.');
      if (await tx.get(ownerKey)) fail('DEVICE_BUSY', 'The initial operator is already reserved by a call.');
      tx.create(key, call); tx.create(ownerKey, { callId: call.id, kind: 'owner' });
      return clone(call);
    });
  }

  function validateWork(row, id) {
    if (!row || row.schema !== 1 || !identifier(row.callId) || row.callKey !== (row.workType === 'session' ? sessionStoreKey(row.callId) : callKeyFor(row.callId)) ||
        !['cleanup', 'expire', 'session'].includes(row.workType) || !identifier(row.workId) ||
        !validTime(row.sourceDueAtMs) || !validTime(row.availableAtMs) || !validTime(row.claimUntilMs) ||
        !Number.isSafeInteger(row.claimGeneration) || row.claimGeneration < 0 || !/^[a-f0-9]{64}$/.test(id)) throw unavailable();
    return row;
  }
  async function claimDueWork({ workerId, limit = 16 } = {}) {
    requireInput(identifier(workerId), 'A stable worker identity is required.');
    requireInput(Number.isInteger(limit) && limit > 0 && limit <= 32, 'Recovery query limit must be between 1 and 32.');
    return guarded(async () => {
      const now = nowMs();
      // One indexed range query, bounded before data is read. Done jobs use MAX_DUE
      // and cannot starve the first page. Active leases move availableAt forward.
      const candidates = await collections.jobs.where('availableAtMs', '<=', now).orderBy('availableAtMs', 'asc').limit(limit).get();
      const claims = [];
      for (const candidate of candidates.docs) {
        const claimId = randomUUID();
        const claim = await firestore.runTransaction(async tx => {
          const snapshot = await tx.get(candidate.ref);
          if (!snapshot.exists) return null;
          const row = validateWork(snapshot.data(), snapshot.id), currentTime = nowMs();
          if (row.availableAtMs > currentTime || row.claimUntilMs > currentTime) return null;
          const call = readEnvelope(await tx.get(reference(row.callKey)), row.callKey)?.data;
          if (!call) throw unavailable();
          const current = row.workType === 'session' ? sessionProjection(call).value : projections(call).jobs.get(snapshot.id);
          if (!current || fingerprint(current) !== row.sourceFingerprint) throw unavailable();
          if (current.sourceDueAtMs > currentTime) return null;
          const generation = row.claimGeneration + 1, claimUntilMs = currentTime + recoveryLeaseMs;
          tx.set(candidate.ref, { ...row, claimId, claimGeneration: generation, claimUntilMs, workerId,
            availableAtMs: Math.max(row.sourceDueAtMs, claimUntilMs), updatedAt: currentTime });
          return { jobId: snapshot.id, callId: row.callId, ...(row.workType === 'session' ? { sessionId: row.sessionId } : {}), workType: row.workType, workId: row.workId,
            claimId, claimGeneration: generation, claimUntilMs, workerId };
        });
        if (claim) claims.push(claim);
      }
      return claims;
    });
  }
  function validClaim(claim) {
    requireInput(claim && /^[a-f0-9]{64}$/.test(claim.jobId || '') && identifier(claim.claimId) &&
      Number.isSafeInteger(claim.claimGeneration) && claim.claimGeneration > 0 && identifier(claim.workerId), 'An exact recovery claim is required.');
  }
  const matchesClaim = (row, claim) => row.claimId === claim.claimId && row.claimGeneration === claim.claimGeneration && row.workerId === claim.workerId;
  async function releaseWork(claim, { retryAfterMs = 0 } = {}) {
    validClaim(claim);
    requireInput(Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0 && retryAfterMs <= 300000, 'Recovery backoff must be at most five minutes.');
    return guarded(() => firestore.runTransaction(async tx => {
      const ref = collections.jobs.doc(claim.jobId), snapshot = await tx.get(ref);
      if (!snapshot.exists) return { released: false };
      const row = validateWork(snapshot.data(), snapshot.id);
      if (!matchesClaim(row, claim)) return { released: false };
      const now = nowMs(), retryNotBeforeMs = retryAfterMs ? now + retryAfterMs : 0;
      tx.set(ref, { ...row, claimId: '', workerId: '', claimUntilMs: 0, retryNotBeforeMs,
        availableAtMs: Math.max(row.sourceDueAtMs, retryNotBeforeMs), updatedAt: now });
      return { released: true };
    }));
  }
  async function renewWorkLease(claim) {
    validClaim(claim);
    return guarded(() => firestore.runTransaction(async tx => {
      const ref = collections.jobs.doc(claim.jobId), snapshot = await tx.get(ref);
      if (!snapshot.exists) return { renewed: false };
      const row = validateWork(snapshot.data(), snapshot.id), now = nowMs();
      if (!matchesClaim(row, claim) || row.claimUntilMs <= now) return { renewed: false };
      const claimUntilMs = now + recoveryLeaseMs;
      tx.set(ref, { ...row, claimUntilMs, availableAtMs: Math.max(row.sourceDueAtMs, claimUntilMs, row.retryNotBeforeMs || 0), updatedAt: now });
      return { renewed: true, claimUntilMs };
    }));
  }

  return Object.freeze({ durable: true, collectionPrefix, get, transaction, createCall, claimDueWork, releaseWork, renewWorkLease });
}

/**
 * Bounded internal recovery sweep. It deliberately does not consult a rollout
 * enable switch: already committed cleanup must continue after transfers are off.
 * Canonical job execution/acknowledgement stays in TransferController. Scanner
 * leases only coordinate discovery and never overwrite its 45-second job leases.
 */
export async function recoverMediaWork({ store, controller, workerId, recoverSession, limit = 16, drainLimit = 1 } = {}) {
  requireInput(store?.durable === true && typeof store.claimDueWork === 'function' &&
    typeof controller?.expire === 'function' && typeof controller?.drainOutbox === 'function', 'A durable media store and controller are required.');
  requireInput(Number.isInteger(drainLimit) && drainLimit >= 1 && drainLimit <= 8, 'Cleanup work per call must be bounded.');
  const claims = await store.claimDueWork({ workerId, limit }), results = [];
  for (const claim of claims) {
    // Claims returned earlier in a batch may have expired while another call was
    // cleaned. Never invoke media effects under an already-expired scanner lease.
    const lease = await store.renewWorkLease(claim);
    if (!lease.renewed) { results.push({ callId: claim.callId, processed: false, stale: true }); continue; }
    let succeeded = false;
    try {
      if (claim.workType === 'session') {
        requireInput(typeof recoverSession === 'function', 'A trusted session recovery callback is required.');
        await recoverSession(claim.sessionId, { claim });
      } else {
        await controller.expire(claim.callId);
        await controller.drainOutbox(claim.callId, { limit: drainLimit });
      }
      succeeded = true;
    } catch { /* Keep private SDK/provider details out of recovery output. */ }
    const release = await store.releaseWork(claim, { retryAfterMs: succeeded ? 0 : 5000 });
    results.push({ callId: claim.callId, processed: succeeded, released: release.released });
  }
  return results;
}
