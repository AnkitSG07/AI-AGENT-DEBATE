// Optional report-copy maintenance. Never deletes canonical calls, sessions,
// reservations, credentials, devices, receipts, export plans or archive chunks.
import { randomUUID } from 'node:crypto';
import { DAY_MS, clone, digest, guarded, id, requireValue, time, ReportError } from './schema.mjs';

export function createReportRetentionWorker({ firestore, service, tenantId = 'smart-handicrafts',
  collectionPrefix = 'sh_operator_reports', enabled = false, clock = Date.now,
  workerId = `retention-${randomUUID()}`, maxBatches = 2, batchRows = 100, leaseMs = 10 * 60000 } = {}) {
  requireValue(firestore?.collection && firestore?.runTransaction && service?.tenantId === tenantId && id(tenantId) && id(workerId) &&
    /^[A-Za-z][A-Za-z0-9_]{0,60}_reports$/.test(collectionPrefix) &&
    Number.isInteger(maxBatches) && maxBatches >= 1 && maxBatches <= 2 &&
    Number.isInteger(batchRows) && batchRows >= 1 && batchRows <= 100 &&
    Number.isSafeInteger(leaseMs) && leaseMs >= 2 * 60000 && leaseMs <= 10 * 60000,
  'INVALID_RETENTION_CONFIG', 'Retention needs a bounded report-only service and lease.');
  const reference = firestore.collection(`${collectionPrefix}_retention`).doc(digest({ tenantId, policy: '30_day_report_copies' }));
  const now = () => { const value = clock(); requireValue(time(value) && value > 0, 'INVALID_CLOCK', 'A valid retention timestamp is required.', 503); return value; };
  let cached = null, work = null;
  function read(snapshot) {
    if (!snapshot.exists) return { schema: 1, tenantId, generation: 0, claimId: '', workerId: '', leaseUntilMs: 0,
      nextRunAtMs: 0, pendingExportId: null, consecutiveFailures: 0, lastRun: null };
    const row = snapshot.data();
    requireValue(row?.schema === 1 && row.tenantId === tenantId && Number.isSafeInteger(row.generation) && row.generation >= 0 &&
      time(row.leaseUntilMs) && time(row.nextRunAtMs) && (row.pendingExportId === null || id(row.pendingExportId)) &&
      Number.isSafeInteger(row.consecutiveFailures) && row.consecutiveFailures >= 0,
    'RETENTION_STATE_INVALID', 'Retention progress cannot be verified; source reports are retained.', 503);
    return row;
  }
  const matches = (row, claim) => row.claimId === claim.claimId && row.generation === claim.generation && row.workerId === workerId && row.leaseUntilMs > now();
  async function claim() {
    const claimId = randomUUID();
    const result = await guarded(() => firestore.runTransaction(async tx => {
      const row = read(await tx.get(reference)), timestamp = now();
      if (row.leaseUntilMs > timestamp || row.nextRunAtMs > timestamp) return { state: row, claimed: false };
      const next = { ...row, generation: row.generation + 1, claimId, workerId, leaseUntilMs: timestamp + leaseMs };
      tx.set(reference, next); return { state: next, claimed: true };
    }));
    cached = clone(result.state); return result.claimed ? result.state : null;
  }
  async function checkpoint(owned, patch, finish = false) {
    const row = await guarded(() => firestore.runTransaction(async tx => {
      const current = read(await tx.get(reference));
      requireValue(matches(current, owned), 'RETENTION_CLAIM_STALE', 'Another maintenance worker owns this pass.', 409);
      const next = { ...current, ...clone(patch), leaseUntilMs: finish ? 0 : now() + leaseMs };
      if (finish) { next.claimId = ''; next.workerId = ''; }
      tx.set(reference, next); return next;
    }));
    cached = clone(row); return row;
  }
  const status = () => ({ enabled: enabled === true, scope: 'immutable_report_copies_only', retentionDays: 30,
    maxBatchesPerRun: maxBatches, maxRowsPerBatch: batchRows, nextRunAtMs: cached?.nextRunAtMs || null,
    running: !!cached && cached.leaseUntilMs > now(), pendingExportId: cached?.pendingExportId || null,
    lastRun: clone(cached?.lastRun || null), canonicalMediaRetentionChanged: false, devicesDeleted: false });

  async function execute() {
    if (enabled !== true) return { status: 'disabled', ...status() };
    let owned;
    try { owned = await claim(); }
    catch { return { status: 'deferred', code: 'RETENTION_STORAGE_UNAVAILABLE', ...status() }; }
    if (!owned) return { status: 'not_due_or_busy', ...status() };
    cached = clone(owned);
    const summary = { startedAtMs: now(), finishedAtMs: null, status: 'completed', exportCount: 0, recordCount: 0,
      deleted: 0, alreadyMissing: 0, skipped: 0, latestExportId: null, errorCode: null };
    let nextRunAtMs = now() + DAY_MS;
    try {
      for (let index = 0; index < maxBatches; index++) {
        let bundle, exportId = owned.pendingExportId;
        if (!exportId) {
          try { bundle = await service.createExport({ beforeMs: now() - 30 * DAY_MS, limit: batchRows }); }
          catch (error) { if (error instanceof ReportError && error.code === 'NO_REPORTS') break; throw error; }
          exportId = bundle.batch.id;
          owned = await checkpoint(owned, { pendingExportId: exportId });
        }
        const prior = await service.status(exportId);
        if (!prior.archiveVerified) {
          bundle ||= await service.resumeExport(exportId);
          await service.archiveExport(bundle);
        }
        // Fencing precedes each destructive phase. The service independently
        // reads both full archive files again and acquires its own purge lease.
        owned = await checkpoint(owned, {});
        const result = await service.purge(exportId, { dryRun: false, workerId, maxChunks: 5 });
        summary.latestExportId = exportId;
        if (result.cleanup.remaining > 0) { summary.status = 'backlog'; nextRunAtMs = now() + 30 * 60000; break; }
        summary.exportCount++; summary.recordCount += result.recordCount;
        summary.deleted += Math.max(0, result.cleanup.deleted - prior.cleanup.deleted);
        summary.alreadyMissing += Math.max(0, result.cleanup.alreadyMissing - prior.cleanup.alreadyMissing);
        summary.skipped += Math.max(0, result.cleanup.skipped - prior.cleanup.skipped);
        owned = await checkpoint(owned, { pendingExportId: null });
        if (!result.selection.hasMore) break;
        if (index === maxBatches - 1) { summary.status = 'backlog'; nextRunAtMs = now() + 30 * 60000; }
      }
      summary.finishedAtMs = now();
      await checkpoint(owned, { lastRun: summary, nextRunAtMs, consecutiveFailures: 0 }, true);
      return { status: summary.status, ...status() };
    } catch (error) {
      summary.status = 'deferred'; summary.finishedAtMs = now();
      summary.errorCode = error instanceof ReportError && /^[A-Z_]{1,64}$/.test(error.code) ? error.code : 'RETENTION_UNAVAILABLE';
      const failures = Math.min(16, owned.consecutiveFailures + 1);
      nextRunAtMs = now() + Math.min(DAY_MS, 30 * 60000 * 2 ** Math.min(failures - 1, 6));
      try { await checkpoint(owned, { lastRun: summary, nextRunAtMs, consecutiveFailures: failures }, true); }
      catch { /* A newer lease owns progress, or storage is down. Never undo it. */ }
      return { status: 'deferred', code: summary.errorCode, ...status() };
    }
  }
  function run() {
    if (work) return work;
    work = execute().finally(() => { work = null; }); return work;
  }
  return Object.freeze({ run, status });
}
