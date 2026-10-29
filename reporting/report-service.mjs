import { randomUUID } from 'node:crypto';
import { DAY_MS, KINDS, MAX_ROWS, MIME_XLSX, canonical, clone, id, time, reportRefs, sha256, requireValue, ReportError } from './schema.mjs';
import { writeHistoryWorkbook } from './xlsx-writer.mjs';

const jsonBytes = object => Buffer.from(`${canonical(object)}\n`, 'utf8');
const artifact = (name, mimeType, bytes) => ({ name, mimeType, size: bytes.length, sha256: sha256(bytes), bytes });
const metadata = file => ({ name: file.name, mimeType: file.mimeType, size: file.size, sha256: file.sha256 });
const visible = batch => ({ exportId: batch.id, status: batch.status, createdAtMs: batch.createdAtMs, recordCount: batch.rows.length,
  selection: clone(batch.selection), archiveVerified: !!batch.archive,
  archiveVerifiedAtMs: batch.archive?.verifiedAtMs || null,
  cleanup: { processed: batch.purge.cursor, deleted: batch.purge.deleted, alreadyMissing: batch.purge.missing, skipped: batch.purge.skipped,
    remaining: batch.rows.length - batch.purge.cursor } });

export function createReportService({ store, archive = null, writeWorkbook = writeHistoryWorkbook, clock = Date.now,
  allowDeletion = false, archiveTimeoutMs = 15000 } = {}) {
  requireValue(store?.durable === true && typeof writeWorkbook === 'function', 'INVALID_REPORT_CONFIG', 'A durable report store and workbook exporter are required.');
  requireValue(Number.isSafeInteger(archiveTimeoutMs) && archiveTimeoutMs >= 10 && archiveTimeoutMs <= 60000,
    'INVALID_REPORT_CONFIG', 'Archive requests require a bounded timeout.');
  const archiveRequest = async operation => {
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(operation), new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new ReportError('ARCHIVE_TIMEOUT', 'Archive verification timed out; source reports are retained.', 503)), archiveTimeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  };
  const now = () => { const value = clock(); requireValue(time(value) && value > 0, 'INVALID_CLOCK', 'A valid server timestamp is required.', 503); return value; };
  const getBatch = async exportId => {
    const batch = await store.getBatch(exportId); requireValue(batch, 'EXPORT_NOT_FOUND', 'This export was not found.', 404); return batch;
  };
  async function createExport({ fromMs = 0, beforeMs = now() - 30 * DAY_MS, kinds = KINDS, limit = MAX_ROWS } = {}) {
    const selected = await store.select({ fromMs, beforeMs, kinds, limit });
    requireValue(selected.rows.length > 0, 'NO_REPORTS', 'There are no finalized reports in this date range.', 404);
    const exportId = randomUUID(), createdAtMs = now();
    const selection = { fromMs, beforeMs, kinds: [...kinds], limit, hasMore: selected.hasMore };
    const workbookBytes = Buffer.from(await writeWorkbook({ rows: clone(selected.rows), exportId, createdAtMs, selection }));
    requireValue(workbookBytes.length > 0 && workbookBytes.length <= 10 * 1024 * 1024, 'EXPORT_LIMIT', 'The workbook exceeded its size limit.', 413);
    const xlsx = artifact(`sh-history-${exportId}.xlsx`, MIME_XLSX, workbookBytes);
    const manifestData = { schema: 1, exportId, tenantId: store.tenantId, createdAtMs, selection, workbook: metadata(xlsx),
      recordCount: selected.rows.length, records: selected.rows, note: 'Only immutable report copies are eligible for 30-day cleanup. Operational/authentication collections are excluded.' };
    const manifest = artifact(`sh-history-${exportId}.manifest.json`, 'application/json', jsonBytes(manifestData));
    requireValue(manifest.size <= 4 * 1024 * 1024, 'EXPORT_LIMIT', 'The manifest exceeded its size limit.', 413);
    const batch = await store.createBatch({ schema: 1, id: exportId, tenantId: store.tenantId, createdAtMs, selection,
      rows: reportRefs(selected.rows), xlsx: metadata(xlsx), manifest: metadata(manifest) });
    return { batch, xlsx, manifest };
  }
  async function resumeExport(exportId) {
    const batch = await getBatch(exportId);
    if (batch.archive) return { batch, ...await verifyArchive(batch) };
    requireValue(typeof store.readBatchRecords === 'function', 'EXPORT_RESUME_UNAVAILABLE', 'This export cannot be resumed safely.', 503);
    const saved = await store.readBatchRecords(exportId);
    const xlsx = artifact(batch.xlsx.name, MIME_XLSX, Buffer.from(await writeWorkbook({ rows: clone(saved.rows),
      exportId: batch.id, createdAtMs: batch.createdAtMs, selection: clone(batch.selection) })));
    const manifest = artifact(batch.manifest.name, 'application/json', jsonBytes({ schema: 1, exportId: batch.id,
      tenantId: store.tenantId, createdAtMs: batch.createdAtMs, selection: clone(batch.selection), workbook: metadata(xlsx),
      recordCount: saved.rows.length, records: saved.rows,
      note: 'Only immutable report copies are eligible for 30-day cleanup. Operational/authentication collections are excluded.' }));
    validateFile(xlsx, batch.xlsx); validateFile(manifest, batch.manifest);
    return { batch, xlsx, manifest };
  }
  function validateFile(file, expected) {
    requireValue(file && file.name === expected.name && file.mimeType === expected.mimeType &&
      file.bytes instanceof Uint8Array && file.bytes.length === expected.size && sha256(file.bytes) === expected.sha256,
    'EXPORT_CHANGED', 'The supplied export file does not match its immutable plan.', 409);
  }
  async function verifyArchive(batch) {
    requireValue(archive && typeof archive.read === 'function' && batch.archive, 'ARCHIVE_REQUIRED', 'A durable verified archive is not available.', 409);
    let xlsxBytes, manifestBytes;
    try {
      const reads = await archiveRequest(() => Promise.allSettled([archive.read(batch.archive.xlsx), archive.read(batch.archive.manifest)]));
      if (reads.some(result => result.status !== 'fulfilled')) throw Error('Archive read failed');
      [xlsxBytes, manifestBytes] = reads.map(result => result.value);
    }
    catch { throw new ReportError('ARCHIVE_UNAVAILABLE', 'The archive could not be read back; report records are retained.', 503); }
    requireValue(xlsxBytes instanceof Uint8Array && manifestBytes instanceof Uint8Array &&
      xlsxBytes.length === batch.xlsx.size && manifestBytes.length === batch.manifest.size &&
      sha256(xlsxBytes) === batch.xlsx.sha256 && sha256(manifestBytes) === batch.manifest.sha256,
    'ARCHIVE_VERIFICATION_FAILED', 'Archive bytes do not match the export; report records are retained.', 502);
    let manifest;
    try { manifest = JSON.parse(Buffer.from(manifestBytes).toString('utf8')); } catch { throw new ReportError('ARCHIVE_VERIFICATION_FAILED', 'The archived manifest is invalid.', 502); }
    requireValue(manifest.exportId === batch.id && manifest.tenantId === store.tenantId && manifest.workbook.sha256 === batch.xlsx.sha256 &&
      manifest.recordCount === batch.rows.length && canonical(reportRefs(manifest.records)) === canonical(batch.rows),
    'ARCHIVE_VERIFICATION_FAILED', 'The archived manifest does not cover these exact records.', 502);
    return { xlsx: { ...batch.xlsx, bytes: Buffer.from(xlsxBytes) }, manifest: { ...batch.manifest, bytes: Buffer.from(manifestBytes) } };
  }
  async function archiveExport(bundle) {
    const batch = await getBatch(bundle?.batch?.id);
    if (batch.archive) { await verifyArchive(batch); return visible(batch); }
    requireValue(archive?.durable === true && typeof archive.put === 'function' && typeof archive.read === 'function',
      'ARCHIVE_NOT_CONFIGURED', 'The durable archive is not configured. Download remains available; cleanup stays blocked.', 503);
    validateFile(bundle.xlsx, batch.xlsx); validateFile(bundle.manifest, batch.manifest);
    let receipts;
    try {
      // Uploads are outside Firestore transactions. A retry may leave a private
      // duplicate attachment, but cannot lose/delete source report records.
      const xlsx = await archiveRequest(() => archive.put({ ...bundle.xlsx, exportId: batch.id }));
      const manifest = await archiveRequest(() => archive.put({ ...bundle.manifest, exportId: batch.id }));
      receipts = { provider: archive.kind, xlsx, manifest };
    } catch { throw new ReportError('ARCHIVE_UNAVAILABLE', 'The archive upload did not complete. Download remains available; records are retained.', 503); }
    await verifyArchive({ ...batch, archive: receipts });
    return visible(await store.markArchived(batch.id, batch.planHash, receipts));
  }
  async function downloadArchive(exportId) {
    const batch = await getBatch(exportId); return { batch, ...await verifyArchive(batch) };
  }
  async function purge(exportId, { dryRun = true, workerId = `purge-${randomUUID()}`, maxChunks = 3 } = {}) {
    requireValue(id(exportId) && id(workerId) && Number.isInteger(maxChunks) && maxChunks >= 1 && maxChunks <= 5,
      'INVALID_PURGE', 'Use an exact export and bounded cleanup pass.');
    let batch = await getBatch(exportId);
    const oldCount = batch.rows.slice(batch.purge.cursor).filter(row => row.occurredAtMs < now() - 30 * DAY_MS).length;
    if (dryRun !== false) {
      let blockedBy = !batch.archive ? 'archive_not_verified' : null, archiveReadBackVerified = false;
      if (batch.archive) {
        try { await verifyArchive(batch); archiveReadBackVerified = true; }
        catch (error) { blockedBy = error.code === 'ARCHIVE_VERIFICATION_FAILED' ? 'archive_integrity_failed' : 'archive_unavailable'; }
      }
      if (!blockedBy && !allowDeletion) blockedBy = 'deletion_disabled';
      return { ...visible(batch), dryRun: true, eligibleByAge: oldCount, archiveReadBackVerified,
        deletionEnabled: allowDeletion === true, blockedBy };
    }
    requireValue(allowDeletion === true, 'REPORT_DELETION_DISABLED', 'Automatic report deletion has not been enabled.', 403);
    await verifyArchive(batch); // Every real purge pass re-reads both complete objects.
    const acquired = await store.claimPurge({ batchId: batch.id, planHash: batch.planHash, workerId });
    if (acquired.completed) return { ...visible(acquired.batch), dryRun: false };
    try {
      for (let index = 0; index < maxChunks; index++) {
        batch = await store.deleteChunk(acquired.claim);
        if (batch.status === 'completed') break;
      }
    } finally { await store.releasePurge(acquired.claim); }
    return { ...visible(await getBatch(exportId)), dryRun: false };
  }
  return Object.freeze({ tenantId: store.tenantId, createExport, resumeExport, archiveExport, downloadArchive, purge,
    status: async exportId => visible(await getBatch(exportId)) });
}
