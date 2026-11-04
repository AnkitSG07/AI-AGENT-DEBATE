// Server-internal migration controls. Mount only behind the existing SUDO gate.
// This module returns operational summaries, never source rows or credentials.
import { createHash, randomUUID } from 'node:crypto';
import { FieldPath, FieldValue } from '@google-cloud/firestore';
import { decodeCloudflareValue } from './operator-cloudflare-client.js';
import { createCloudflareMigrationTransport, createStorageMigrationManager } from './operator-storage-migration.js';

const ACTIONS = Object.freeze({ prepare: 'prepare', copy: 'copySnapshot', replay: 'replay', cutover: 'cutover' });
const MEDIA_KINDS = ['calls', 'sessions', 'reservations', 'events', 'jobs', 'transfers'];
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const code = (value, fallback = 'STORAGE_MIGRATION_FAILED') => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(value) ? value : fallback;
const failure = (name, status = 503) => Object.assign(new Error('Storage administration is unavailable or needs verification.'), {
  code: name, status, storageMigrationError: true
});
const string = value => typeof value === 'string' && /^[A-Za-z0-9_-]{0,128}$/.test(value) ? value : '';
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
function summary(value) {
  if (!plain(value)) return null;
  return {
    mode: string(value.mode), migrationId: string(value.migrationId), epoch: count(value.epoch), phase: string(value.phase),
    targetReady: value.targetReady === true, snapshotComplete: value.snapshotComplete === true,
    copied: count(value.copied), replayed: count(value.replayed), verifiedCount: count(value.verifiedCount),
    verifiedChecksum: typeof value.verifiedChecksum === 'string' && /^[a-f0-9]{64}$/.test(value.verifiedChecksum) ? value.verifiedChecksum : '',
    lastError: value.lastError ? code(value.lastError) : '', running: value.running === true
  };
}
const terminalConfirmed = row => plain(row.terminal) && Number.isSafeInteger(row.terminal.endedAt) &&
  row.terminal.endedAt >= 0 && Number.isSafeInteger(row.terminal.confirmedAt) && row.terminal.confirmedAt >= row.terminal.endedAt;
const settledOutbox = row => Array.isArray(row.outbox) && row.outbox.every(item => plain(item) && item.status === 'done');
const settledOperations = row => plain(row.operations) && Object.values(row.operations)
  .every(item => plain(item) && ['acknowledged', 'provider-ended', 'failed'].includes(item.status));
const exactString = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
const mediaId = value => createHash('sha256').update(value).digest('hex');
const providerBinding = (tenantId, callId) => exactString(tenantId) && exactString(callId) ? JSON.stringify([tenantId, callId]) : '';

// Pure classification runs over the manager's complete, versioned live source
// manifest AFTER journal replay, outside the final gate transaction. The
// manager's bounded journal-suffix proof detects new/unexamined writes before
// fencing, so lifetime history is never reread under the gate's lock.
function classifyQuietManifest(documents, prefix) {
    if (!Array.isArray(documents)) throw failure('STORAGE_QUIET_SCAN_INVALID');
    const rows = Object.fromEntries(MEDIA_KINDS.map(kind => [kind, []]));
    const seen = new Set();
    for (const document of documents) {
      if (!plain(document) || typeof document.path !== 'string' || seen.has(document.path)) throw failure('STORAGE_QUIET_RECORD_INVALID');
      seen.add(document.path);
      const [collection, id, extra] = document.path.split('/');
      if (extra !== undefined || !id) throw failure('STORAGE_QUIET_RECORD_INVALID');
      if (!collection.startsWith(`${prefix}_media_`)) continue;
      const kind = collection.slice(`${prefix}_media_`.length);
      if (!MEDIA_KINDS.includes(kind)) throw failure('STORAGE_QUIET_RECORD_UNSUPPORTED');
      let row; try { row = decodeCloudflareValue(document.data); } catch { throw failure('STORAGE_QUIET_RECORD_INVALID'); }
      if (!plain(row)) throw failure('STORAGE_QUIET_RECORD_INVALID');
      if (['calls', 'sessions', 'reservations', 'events'].includes(kind)) {
        if (row.schema !== 1 || row.key !== `media_${kind}/${id}` || !Number.isSafeInteger(row.revision) || row.revision < 1 || !plain(row.data))
          throw failure('STORAGE_QUIET_RECORD_INVALID');
        row = row.data;
        if (kind !== 'reservations' && (!exactString(row.id) || mediaId(row.id) !== id)) throw failure('STORAGE_QUIET_RECORD_INVALID');
      }
      rows[kind].push(row);
    }
    if (rows.reservations.length) return false; // Expired or uncertain reservations still own exact media cleanup.
    const settledCalls = new Set(), settledSessions = new Set(), settledProviderCalls = new Set(), terminalEvents = new Set();
    for (const event of rows.events) if (event.kind === 'terminal') {
      const binding = providerBinding(event.tenantId, event.providerCallId);
      if (!binding || event.id !== `terminal:${event.providerCallId}` || !Number.isSafeInteger(event.createdAt) || event.createdAt < 0)
        throw failure('STORAGE_QUIET_RECORD_INVALID');
      terminalEvents.add(binding);
    }
    for (const call of rows.calls) {
      const binding = providerBinding(call.tenantId, call.id);
      if (!binding || typeof call.active !== 'boolean' || !settledOutbox(call)) return false;
      if (call.active || !terminalConfirmed(call)) return false;
      if (call.transfer && !['completed', 'declined', 'cancelled', 'expired', 'failed'].includes(call.transfer.status)) return false;
      settledCalls.add(call.id); settledProviderCalls.add(binding);
    }
    for (const session of rows.sessions) {
      const binding = providerBinding(session.tenantId, session.providerCallId);
      const legacyRow = session.routeChoice === 'legacy' || session.terminal?.nativeOnly === true;
      const legacyEnded = ['answered_elsewhere', 'ended'].includes(session.phase) && session.routeChoice === 'legacy' &&
        session.direction === 'incoming' && plain(session.operations) && Object.keys(session.operations).length === 0 &&
        Array.isArray(session.outbox) && session.outbox.every(item => item?.kind === 'notify') &&
        session.terminal?.nativeOnly === true && session.terminal.reason === 'LEGACY_CLAIMED' &&
        Number.isSafeInteger(session.terminal.endedAt) && session.terminal.endedAt >= 0 && exactString(session.legacyClaim?.operationId) &&
        session.legacyClaim.claimedAt === session.terminal.endedAt && !session.owner && binding && terminalEvents.has(binding);
      if (!exactString(session.id) || !exactString(session.tenantId) || !settledOutbox(session) || !settledOperations(session) ||
          (legacyRow ? !legacyEnded : !['ended', 'failed'].includes(session.phase) || !terminalConfirmed(session))) return false;
      settledSessions.add(session.id);
      if (binding) { settledCalls.add(session.providerCallId); settledProviderCalls.add(binding); }
    }
    const eventKinds = new Set(['terminal', 'customer-accepted', 'pending-answer', 'route', 'provider-event', 'outgoing-cancel']);
    for (const event of rows.events) {
      if (!eventKinds.has(event.kind)) throw failure('STORAGE_QUIET_EVENT_UNSUPPORTED');
      if (['pending-answer', 'customer-accepted'].includes(event.kind) &&
          (!providerBinding(event.tenantId, event.providerCallId) ||
           !settledProviderCalls.has(providerBinding(event.tenantId, event.providerCallId)) &&
           !terminalEvents.has(providerBinding(event.tenantId, event.providerCallId)))) return false;
    }
    for (const projection of rows.jobs) {
      if (!plain(projection.data) || !['session', 'cleanup', 'expire'].includes(projection.workType)) throw failure('STORAGE_QUIET_JOB_UNSUPPORTED');
      if (projection.workType === 'session') {
        if (!settledSessions.has(projection.sessionId)) return false;
      } else if (!settledCalls.has(projection.callId) ||
          projection.workType === 'cleanup' && projection.data.status !== 'done') return false;
    }
    for (const projection of rows.transfers) {
      if (!plain(projection.data) || !settledCalls.has(projection.callId) ||
          !['completed', 'declined', 'cancelled', 'expired', 'failed'].includes(projection.data.status)) return false;
    }
    return true;
}

export function createStorageMigrationAdministration({ runtime, env = process.env,
  managerFactory = createStorageMigrationManager, transportFactory = createCloudflareMigrationTransport } = {}) {
  let manager, configurationError = '', closed = false, activeJob = null, lastJob = null;
  const migration = runtime?.migration;
  try {
    if (env.SH_CLOUDFLARE_MIGRATION_ENABLED !== 'true' || migration?.enabled !== true) throw failure('STORAGE_MIGRATION_DISABLED');
    if (runtime?.configured !== true || migration.targetConfigured !== true || !migration.source?.collection ||
        typeof migration.source.runTransaction !== 'function' || typeof migration.source.listCollections !== 'function')
      throw failure('STORAGE_MIGRATION_NOT_CONFIGURED');
    const prefix = runtime.collectionPrefix;
    if (typeof prefix !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(prefix)) throw failure('STORAGE_MIGRATION_NOT_CONFIGURED');
    const targetMigration = transportFactory({ endpoint: env.SH_CLOUDFLARE_STORE_URL,
      secret: env.SH_CLOUDFLARE_MIGRATION_SECRET, storeSecret: env.SH_CLOUDFLARE_STORE_SECRET });
    manager = managerFactory({ firestore: migration.source, collectionPrefix: prefix,
      targetMigration, serverTimestamp: () => FieldValue.serverTimestamp(), documentIdField: FieldPath.documentId(),
      maxDocuments: 20000, maxBytes: 64 * 1024 * 1024, maxDurationMs: 10 * 60000, pageSize: 50, maxJournalPasses: 1000,
      classifyQuietManifest: documents => classifyQuietManifest(documents, prefix),
      assertNoActiveCalls: () => {
        if (typeof migration.assertNoActiveVideoCalls !== 'function' || typeof migration.beginVideoCutoverGuard !== 'function')
          throw failure('STORAGE_VIDEO_QUIET_CHECK_REQUIRED');
        const result = migration.assertNoActiveVideoCalls();
        if (result !== true && result !== false) throw failure('STORAGE_VIDEO_QUIET_CHECK_INVALID');
        return result;
      },
      beforeFence: async () => {
        if (typeof migration.beginVideoCutoverGuard !== 'function') throw failure('STORAGE_VIDEO_QUIET_CHECK_REQUIRED');
        const release = migration.beginVideoCutoverGuard();
        if (typeof release !== 'function') throw failure('STORAGE_VIDEO_QUIET_CHECK_INVALID');
        return release;
      }
    });
  } catch (error) { configurationError = error?.storageMigrationError ? code(error.code) : 'STORAGE_MIGRATION_NOT_CONFIGURED'; }
  const jobSummary = job => job ? { id: job.id, action: job.action, state: job.state, startedAt: job.startedAt,
    completedAt: job.completedAt, errorCode: job.errorCode } : null;
  async function status() {
    let state = null, errorCode = configurationError;
    if (manager && !closed) {
      try { state = summary(await manager.status()); }
      catch (error) { errorCode = code(error?.code, 'STORAGE_MIGRATION_STATUS_UNAVAILABLE'); }
    }
    return { configured: !!manager, enabled: env.SH_CLOUDFLARE_MIGRATION_ENABLED === 'true', closed,
      running: !!activeJob, errorCode, job: jobSummary(activeJob || lastJob), migration: state };
  }
  function run(action) {
    if (typeof action !== 'string' || !Object.hasOwn(ACTIONS, action)) throw failure('STORAGE_MIGRATION_ACTION_INVALID', 400);
    if (closed) throw failure('STORAGE_MIGRATION_CLOSED');
    if (!manager) throw failure(configurationError || 'STORAGE_MIGRATION_NOT_CONFIGURED');
    if (activeJob) throw failure('STORAGE_MIGRATION_BUSY', 409);
    if (action === 'cutover' && (typeof migration.assertNoActiveVideoCalls !== 'function' || typeof migration.beginVideoCutoverGuard !== 'function'))
      throw failure('STORAGE_VIDEO_QUIET_CHECK_REQUIRED');
    const job = { id: randomUUID(), action, state: 'running', startedAt: Date.now(), completedAt: null, errorCode: '' };
    activeJob = job;
    // Keep the slot until the actual bounded manager operation settles. Never
    // race a timeout that would allow another mutation while cutover still runs.
    job.promise = Promise.resolve().then(() => manager[ACTIONS[action]]()).then(() => { job.state = 'succeeded'; }, error => {
      job.state = 'failed'; job.errorCode = code(error?.code);
    }).finally(() => { job.completedAt = Date.now(); lastJob = job; activeJob = null; });
    return { accepted: true, job: jobSummary(job) };
  }
  async function close() { closed = true; if (activeJob) await activeJob.promise; }
  return { status, run, close };
}
