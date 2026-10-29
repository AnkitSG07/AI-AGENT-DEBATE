import { randomUUID } from 'node:crypto';
import { KINDS, MAX_ROWS, DAY_MS, clone, canonical, digest, id, externalId, time, guarded, unavailable, requireValue,
  normalizeRecord, validateRecord, recordDocumentId } from './schema.mjs';

const HASH = /^[a-f0-9]{64}$/;
const planOf = batch => ({ schema: 1, id: batch.id, tenantId: batch.tenantId, createdAtMs: batch.createdAtMs,
  selection: batch.selection, rows: batch.rows, xlsx: batch.xlsx, manifest: batch.manifest });
export const exportPlanHash = batch => digest(planOf(batch));

export function createFirestoreReportStore({ firestore, tenantId = 'smart-handicrafts',
  collectionPrefix = 'sh_operator_reports', clock = Date.now, purgeLeaseMs = 60000 } = {}) {
  requireValue(firestore?.collection && firestore?.runTransaction && id(tenantId) &&
    /^[A-Za-z][A-Za-z0-9_]{0,60}_reports$/.test(collectionPrefix), 'INVALID_REPORT_CONFIG', 'A separate report-only Firestore namespace is required.');
  requireValue(Number.isSafeInteger(purgeLeaseMs) && purgeLeaseMs >= 30000 && purgeLeaseMs <= 120000,
    'INVALID_REPORT_CONFIG', 'Purge leases must be bounded.');
  const collections = Object.fromEntries([...KINDS, 'exports', 'collector', 'deferred', 'receipts'].map(kind => [kind, firestore.collection(`${collectionPrefix}_${kind}`)]));
  const now = () => { const value = clock(); if (!time(value) || !value) throw unavailable(); return value; };
  const refFor = reference => {
    requireValue(reference && KINDS.includes(reference.kind) && HASH.test(reference.documentId), 'INVALID_REPORT_SCOPE', 'Only explicit immutable report records can be addressed.');
    return collections[reference.kind].doc(reference.documentId);
  };
  function readRecord(snapshot, kind) {
    if (!snapshot.exists) return undefined;
    try { return validateRecord(snapshot.data(), { kind, tenantId, documentId: snapshot.id }); } catch { throw unavailable(); }
  }
  function readReceipt(snapshot, reference) {
    if (!snapshot.exists) return undefined;
    const row = snapshot.data();
    if (!row || row.schema !== 1 || row.tenantId !== tenantId || row.kind !== reference.kind || row.recordId !== reference.recordId ||
        row.documentId !== reference.documentId || !HASH.test(row.contentHash) || !HASH.test(row.fingerprint) ||
        !['present', 'archived'].includes(row.state) || row.state === 'archived' && (!id(row.exportId) || !time(row.archivedAtMs))) throw unavailable();
    return row;
  }
  const presentReceipt = record => ({ schema: 1, tenantId, kind: record.kind, recordId: record.recordId,
    documentId: recordDocumentId(record), contentHash: digest(record.data), fingerprint: record.fingerprint, state: 'present' });
  function readBatch(snapshot) {
    if (!snapshot.exists) return undefined;
    const row = snapshot.data();
    try {
      requireValue(row && row.schema === 1 && row.id === snapshot.id && row.tenantId === tenantId && time(row.createdAtMs) &&
        ['prepared', 'archived', 'purging', 'completed'].includes(row.status) && Array.isArray(row.rows) && row.rows.length > 0 && row.rows.length <= MAX_ROWS &&
        row.rows.every(record => KINDS.includes(record.kind) && HASH.test(record.documentId) && HASH.test(record.fingerprint) && HASH.test(record.contentHash) && time(record.occurredAtMs)) &&
        row.planHash === exportPlanHash(row) && Number.isSafeInteger(row.purge.cursor) && row.purge.cursor >= 0 && row.purge.cursor <= row.rows.length,
      'INVALID_EXPORT', 'Invalid export metadata.');
    } catch { throw unavailable(); }
    return row;
  }

  async function append(record) {
    const normalized = normalizeRecord({ ...record, tenantId, createdAtMs: now() });
    const reference = collections[normalized.kind].doc(recordDocumentId(normalized));
    return guarded(() => firestore.runTransaction(async tx => {
      const previous = readRecord(await tx.get(reference), normalized.kind);
      const receiptRef = collections.receipts.doc(reference.id), expectedReceipt = presentReceipt(normalized);
      const receipt = readReceipt(await tx.get(receiptRef), expectedReceipt);
      if (receipt) {
        requireValue(receipt.contentHash === expectedReceipt.contentHash, 'REPORT_ALREADY_FINALIZED', 'This report ID already has another finalized outcome.', 409);
        if (receipt.state === 'archived') {
          requireValue(!previous, 'REPORT_RECEIPT_CONFLICT', 'An archived report unexpectedly reappeared; reconcile its history before modifying it.', 503);
          return { created: false, archived: true, recordId: normalized.recordId };
        }
        requireValue(previous && receipt.fingerprint === previous.fingerprint, 'REPORT_RECEIPT_CONFLICT', 'A finalized report record is missing or changed.', 503);
      }
      if (previous) {
        // Backfill/retry timestamps may differ; source data and operational time may not.
        requireValue(canonical(previous.data) === canonical(normalized.data) && previous.occurredAtMs === normalized.occurredAtMs,
          'REPORT_ALREADY_FINALIZED', 'This immutable report already contains another outcome.', 409);
        if (!receipt) tx.create(receiptRef, presentReceipt(previous));
        return { created: false, recordId: previous.recordId };
      }
      tx.create(reference, normalized); tx.create(receiptRef, expectedReceipt);
      return { created: true, recordId: normalized.recordId };
    }));
  }

  async function select({ fromMs = 0, beforeMs, kinds = KINDS, limit = MAX_ROWS } = {}) {
    requireValue(time(fromMs) && time(beforeMs) && fromMs < beforeMs && beforeMs <= now() &&
      Array.isArray(kinds) && kinds.length > 0 && new Set(kinds).size === kinds.length && kinds.every(kind => KINDS.includes(kind)) &&
      Number.isInteger(limit) && limit >= 1 && limit <= MAX_ROWS, 'INVALID_REPORT_SELECTION', 'Use a bounded report type and date range.');
    return guarded(async () => {
      const queries = await Promise.all(kinds.map(async kind => {
        const snapshot = await collections[kind].where('occurredAtMs', '>=', fromMs).where('occurredAtMs', '<', beforeMs)
          .orderBy('occurredAtMs', 'asc').limit(limit).get();
        return { full: snapshot.size === limit, rows: snapshot.docs.map(row => readRecord(row, kind)) };
      }));
      const all = queries.flatMap(query => query.rows).sort((a, b) => a.occurredAtMs - b.occurredAtMs || a.kind.localeCompare(b.kind) || a.recordId.localeCompare(b.recordId));
      return { rows: all.slice(0, limit), hasMore: all.length > limit || queries.some(query => query.full) };
    });
  }

  async function createBatch(plan) {
    requireValue(id(plan?.id) && plan.tenantId === tenantId && plan.schema === 1 && plan.rows?.length > 0 && plan.rows.length <= MAX_ROWS &&
      Buffer.byteLength(canonical(plan)) <= 256 * 1024, 'INVALID_EXPORT', 'A bounded export plan is required.');
    const row = { ...clone(plan), planHash: exportPlanHash(plan), status: 'prepared', archive: null,
      purge: { cursor: 0, deleted: 0, missing: 0, skipped: 0, claimId: '', generation: 0, leaseUntilMs: 0, workerId: '' } };
    return guarded(() => firestore.runTransaction(async tx => {
      const reference = collections.exports.doc(plan.id), snapshot = await tx.get(reference);
      requireValue(!snapshot.exists, 'EXPORT_ALREADY_EXISTS', 'This export ID already exists.', 409);
      tx.create(reference, row); return clone(row);
    }));
  }
  async function getBatch(batchId) {
    requireValue(id(batchId), 'INVALID_EXPORT_ID', 'An exact export ID is required.');
    return guarded(async () => clone(readBatch(await collections.exports.doc(batchId).get())));
  }
  async function readBatchRecords(batchId) {
    const batch = await getBatch(batchId);
    requireValue(batch && !batch.archive && batch.status === 'prepared', 'EXPORT_ALREADY_ARCHIVED',
      'Only an unarchived immutable export can be regenerated.', 409);
    return guarded(async () => {
      const rows = [];
      for (const entry of batch.rows) {
        const row = readRecord(await refFor(entry).get(), entry.kind);
        requireValue(row && row.fingerprint === entry.fingerprint && row.occurredAtMs === entry.occurredAtMs,
          'EXPORT_SOURCE_CHANGED', 'The exact source reports are no longer available; cleanup remains blocked.', 409);
        rows.push(row);
      }
      return { batch, rows };
    });
  }
  async function markArchived(batchId, planHash, archive) {
    requireValue(id(batchId) && HASH.test(planHash) && Buffer.byteLength(canonical(archive)) <= 8192,
      'INVALID_ARCHIVE', 'A bounded verified archive receipt is required.');
    return guarded(() => firestore.runTransaction(async tx => {
      const reference = collections.exports.doc(batchId), row = readBatch(await tx.get(reference));
      requireValue(row && row.planHash === planHash, 'EXPORT_CHANGED', 'The export plan changed.', 409);
      if (row.archive) return row;
      requireValue(row.status === 'prepared', 'EXPORT_CHANGED', 'This export cannot accept a new archive.', 409);
      row.archive = { ...clone(archive), verifiedAtMs: now() }; row.status = 'archived'; tx.set(reference, row); return clone(row);
    }));
  }

  async function claimPurge({ batchId, planHash, workerId }) {
    requireValue(id(batchId) && HASH.test(planHash) && id(workerId), 'INVALID_PURGE', 'An exact export and purge worker are required.');
    const claimId = randomUUID();
    return guarded(() => firestore.runTransaction(async tx => {
      const reference = collections.exports.doc(batchId), row = readBatch(await tx.get(reference)), timestamp = now();
      requireValue(row && row.planHash === planHash && row.archive, 'ARCHIVE_REQUIRED', 'A verified durable archive is required before cleanup.', 409);
      if (row.status === 'completed') return { completed: true, batch: row };
      requireValue(row.purge.leaseUntilMs <= timestamp, 'PURGE_BUSY', 'Another worker is processing this export.', 409);
      const generation = row.purge.generation + 1;
      Object.assign(row.purge, { claimId, workerId, generation, leaseUntilMs: timestamp + purgeLeaseMs });
      row.status = 'purging'; tx.set(reference, row);
      return { completed: false, claim: { batchId, planHash, claimId, workerId, generation }, batch: clone(row) };
    }));
  }
  const matches = (row, claim) => row && row.planHash === claim.planHash && row.purge.claimId === claim.claimId &&
    row.purge.generation === claim.generation && row.purge.workerId === claim.workerId;
  async function deleteChunk(claim, { limit = 40 } = {}) {
    requireValue(claim && id(claim.batchId) && id(claim.claimId) && Number.isInteger(limit) && limit >= 1 && limit <= 50,
      'INVALID_PURGE', 'Cleanup requires an exact bounded claim.');
    return guarded(() => firestore.runTransaction(async tx => {
      const batchRef = collections.exports.doc(claim.batchId), row = readBatch(await tx.get(batchRef)), timestamp = now();
      requireValue(matches(row, claim) && row.purge.leaseUntilMs > timestamp, 'PURGE_CLAIM_STALE', 'The cleanup lease expired or changed.', 409);
      const entries = row.rows.slice(row.purge.cursor, row.purge.cursor + limit), snapshots = [];
      for (const entry of entries) {
        const receiptRef = collections.receipts.doc(entry.documentId);
        snapshots.push({ entry, ref: refFor(entry), snapshot: await tx.get(refFor(entry)), receiptRef,
          receipt: readReceipt(await tx.get(receiptRef), entry) });
      }
      const retentionCutoff = timestamp - 30 * DAY_MS;
      for (const { entry, ref, snapshot, receiptRef, receipt } of snapshots) {
        const record = readRecord(snapshot, entry.kind);
        const eligible = entry.occurredAtMs < retentionCutoff && entry.occurredAtMs < row.selection.beforeMs;
        const tombstone = { schema: 1, tenantId, kind: entry.kind, recordId: entry.recordId, documentId: entry.documentId,
          contentHash: entry.contentHash, fingerprint: entry.fingerprint, state: 'archived', exportId: row.id, archivedAtMs: timestamp };
        if (!record) {
          row.purge.missing++;
          if (eligible && receipt?.state !== 'archived') tx.set(receiptRef, tombstone);
          continue;
        }
        if (record.fingerprint !== entry.fingerprint || record.occurredAtMs !== entry.occurredAtMs ||
            !eligible) { row.purge.skipped++; continue; }
        requireValue(!receipt || receipt.state === 'present' && receipt.fingerprint === entry.fingerprint && receipt.contentHash === entry.contentHash,
          'REPORT_RECEIPT_CONFLICT', 'Report finalization state changed; source records are retained.', 503);
        tx.delete(ref); tx.set(receiptRef, tombstone); row.purge.deleted++;
      }
      row.purge.cursor += entries.length; row.purge.leaseUntilMs = timestamp + purgeLeaseMs;
      if (row.purge.cursor === row.rows.length) {
        row.status = 'completed'; row.completedAtMs = timestamp;
        Object.assign(row.purge, { claimId: '', workerId: '', leaseUntilMs: 0 });
      }
      tx.set(batchRef, row); return clone(row);
    }));
  }
  async function releasePurge(claim) {
    return guarded(() => firestore.runTransaction(async tx => {
      const reference = collections.exports.doc(claim.batchId), row = readBatch(await tx.get(reference));
      if (!matches(row, claim)) return { released: false };
      Object.assign(row.purge, { claimId: '', workerId: '', leaseUntilMs: 0 });
      if (row.status !== 'completed') row.status = 'archived';
      tx.set(reference, row); return { released: true };
    }));
  }
  async function setDeferred(sessionId, pending) {
    requireValue(externalId(sessionId) && typeof pending === 'boolean', 'INVALID_REPORT_SOURCE', 'An exact terminal session is required.');
    return guarded(() => firestore.runTransaction(async tx => {
      const reference = collections.deferred.doc(digest({ tenantId, sessionId })), snapshot = await tx.get(reference);
      if (!pending) { if (snapshot.exists) tx.delete(reference); return; }
      const existing = snapshot.exists ? snapshot.data() : null;
      requireValue(!existing || existing.sessionId === sessionId && existing.tenantId === tenantId,
        'REPORT_SOURCE_CHANGED', 'The deferred report identity changed.', 503);
      tx.set(reference, { schema: 1, sessionId, tenantId, availableAtMs: now() + 30000 });
    }));
  }
  async function deferredSessions(limit = 16) {
    requireValue(Number.isInteger(limit) && limit > 0 && limit <= 32, 'INVALID_REPORT_LIMIT', 'Deferred reporting must be bounded.');
    return guarded(async () => {
      const rows = await collections.deferred.where('availableAtMs', '<=', now()).orderBy('availableAtMs', 'asc').limit(limit).get();
      return rows.docs.map(snapshot => {
        const row = snapshot.data();
        if (row.schema !== 1 || row.tenantId !== tenantId || !externalId(row.sessionId)) throw unavailable();
        return row.sessionId;
      });
    });
  }
  async function claimCollection(workerId) {
    requireValue(id(workerId), 'INVALID_REPORT_WORKER', 'A collection worker identity is required.');
    const claimId = randomUUID();
    return guarded(() => firestore.runTransaction(async tx => {
      const reference = collections.collector.doc('terminal_sessions'), snapshot = await tx.get(reference), timestamp = now();
      const state = snapshot.exists ? snapshot.data() : { schema: 1, tenantId, cursor: null, claimId: '', workerId: '', leaseUntilMs: 0, generation: 0 };
      if (state.schema !== 1 || state.tenantId !== tenantId || !time(state.leaseUntilMs)) throw unavailable();
      if (state.leaseUntilMs > timestamp) return null;
      const next = { ...state, claimId, workerId, generation: state.generation + 1, leaseUntilMs: timestamp + purgeLeaseMs };
      tx.set(reference, next); return clone(next);
    }));
  }
  async function finishCollection(claim, cursor) {
    return guarded(() => firestore.runTransaction(async tx => {
      const reference = collections.collector.doc('terminal_sessions'), snapshot = await tx.get(reference);
      if (!snapshot.exists) return { advanced: false };
      const state = snapshot.data();
      if (state.claimId !== claim.claimId || state.generation !== claim.generation || state.workerId !== claim.workerId || state.leaseUntilMs <= now()) return { advanced: false };
      tx.set(reference, { ...state, cursor: clone(cursor), claimId: '', workerId: '', leaseUntilMs: 0 });
      return { advanced: true };
    }));
  }
  return Object.freeze({ durable: true, tenantId, collectionPrefix, append, select, createBatch, getBatch, readBatchRecords, markArchived,
    claimPurge, deleteChunk, releasePurge, setDeferred, deferredSessions, claimCollection, finishCollection });
}
