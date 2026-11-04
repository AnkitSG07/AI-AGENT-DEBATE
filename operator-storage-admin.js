// Server-internal migration controls. Mount only behind the existing SUDO gate.
// This module returns operational summaries, never source rows or credentials.
import { randomUUID } from 'node:crypto';
import { FieldPath, FieldValue } from '@google-cloud/firestore';
import { createCloudflareMigrationTransport, createStorageMigrationManager } from './operator-storage-migration.js';

const ACTIONS = Object.freeze({ prepare: 'prepare', copy: 'copySnapshot', replay: 'replay', cutover: 'cutover' });
// This last fence must stay short. Larger historical inventories require a
// separately reviewed quiet-query index; they are rejected while source writes
// remain available rather than holding the gate through a long history scan.
const QUIET_DOCUMENT_LIMIT = 100;
const QUIET_BYTE_LIMIT = 512 * 1024;
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
  Number.isSafeInteger(row.terminal.confirmedAt) && row.terminal.confirmedAt >= row.terminal.endedAt;
const settledOutbox = row => Array.isArray(row.outbox) && row.outbox.every(item => plain(item) && item.status === 'done');
const settledOperations = row => plain(row.operations) && Object.values(row.operations)
  .every(item => plain(item) && ['acknowledged', 'provider-ended', 'failed'].includes(item.status));
function checkQuietBounds(results) {
  if (results.some(result => !Array.isArray(result?.docs))) throw failure('STORAGE_QUIET_SCAN_INVALID');
  if (results.reduce((total, result) => total + result.docs.length, 0) > QUIET_DOCUMENT_LIMIT) throw failure('STORAGE_QUIET_SCAN_LIMIT');
  let bytes = 0;
  for (const result of results) for (const doc of result.docs) {
    const serialized = JSON.stringify(doc.data());
    if (typeof serialized !== 'string' || (bytes += Buffer.byteLength(serialized)) > QUIET_BYTE_LIMIT) throw failure('STORAGE_QUIET_SCAN_LIMIT');
  }
}

// All durable observations use the manager's SAME native source transaction.
// Collection queries include absent rows, so a concurrent new ringing session,
// reservation or pending answer cannot escape the source gate's atomic fence.
function quietPointCheck({ source, prefix, migration }) {
  return async tx => {
    const videoQuiet = () => {
      const result = migration.assertNoActiveVideoCalls();
      if (result !== true && result !== false) throw failure('STORAGE_VIDEO_QUIET_CHECK_INVALID');
      return result;
    };
    if (!videoQuiet()) return false;
    const kinds = MEDIA_KINDS;
    const results = await Promise.all(kinds.map(kind => tx.get(source.collection(`${prefix}_media_${kind}`).limit(QUIET_DOCUMENT_LIMIT + 1))));
    checkQuietBounds(results);
    const rows = Object.fromEntries(kinds.map((kind, index) => [kind, results[index].docs.map(doc => {
      const row = doc.data();
      if (!plain(row)) throw failure('STORAGE_QUIET_RECORD_INVALID');
      if (['calls', 'sessions', 'reservations', 'events'].includes(kind)) {
        if (row.schema !== 1 || row.key !== `media_${kind}/${doc.id}` || !Number.isSafeInteger(row.revision) || row.revision < 1 || !plain(row.data))
          throw failure('STORAGE_QUIET_RECORD_INVALID');
        return row.data;
      }
      return row;
    })]));
    if (rows.reservations.length) return false; // Expired or uncertain reservations still own exact media cleanup.
    const settledCalls = new Set(), settledSessions = new Set();
    for (const call of rows.calls) {
      if (typeof call.id !== 'string' || typeof call.active !== 'boolean' || !settledOutbox(call)) return false;
      if (call.active || !terminalConfirmed(call)) return false;
      if (call.transfer && !['completed', 'declined', 'cancelled', 'expired', 'failed'].includes(call.transfer.status)) return false;
      settledCalls.add(call.id);
    }
    for (const session of rows.sessions) {
      // Native-only legacy claims do not prove that browser media has ended.
      if (typeof session.id !== 'string' || !['ended', 'failed'].includes(session.phase) ||
          !terminalConfirmed(session) || !settledOutbox(session) || !settledOperations(session)) return false;
      settledSessions.add(session.id);
      if (typeof session.providerCallId === 'string' && session.providerCallId) settledCalls.add(session.providerCallId);
    }
    const terminalEvents = new Set(rows.events.filter(event => event.kind === 'terminal').map(event => event.providerCallId));
    const eventKinds = new Set(['terminal', 'customer-accepted', 'pending-answer', 'route', 'provider-event', 'outgoing-cancel']);
    for (const event of rows.events) {
      if (!eventKinds.has(event.kind)) throw failure('STORAGE_QUIET_EVENT_UNSUPPORTED');
      if (['pending-answer', 'customer-accepted'].includes(event.kind) &&
          !settledCalls.has(event.providerCallId) && !terminalEvents.has(event.providerCallId)) return false;
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
    return videoQuiet();
  };
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
      assertNoActiveCalls: async tx => {
        if (typeof migration.assertNoActiveVideoCalls !== 'function' || typeof migration.beginVideoCutoverGuard !== 'function')
          throw failure('STORAGE_VIDEO_QUIET_CHECK_REQUIRED');
        return quietPointCheck({ source: migration.source, prefix, migration })(tx);
      },
      beforeFence: async () => {
        if (typeof migration.beginVideoCutoverGuard !== 'function') throw failure('STORAGE_VIDEO_QUIET_CHECK_REQUIRED');
        // Reject a large quiet-point inventory BEFORE taking the source gate's
        // transaction lock or pausing video admission. The transaction repeats
        // these bounded queries to protect against new media rows/phantoms.
        checkQuietBounds(await Promise.all(MEDIA_KINDS.map(kind =>
          migration.source.collection(`${prefix}_media_${kind}`).limit(QUIET_DOCUMENT_LIMIT + 1).get())));
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
