import { ReportError, id, requireValue } from './schema.mjs';
import { zipDownload } from './xlsx-writer.mjs';

/** Handler factory only. Nothing is mounted or scheduled. The caller must supply
 * real administrator authorization (and CSRF validation for cookie sessions).
 * Enrolled native call permission alone does not imply export/purge permission. */
export function createReportHandlers({ service, authorize = async () => null } = {}) {
  requireValue(service?.tenantId && typeof authorize === 'function', 'INVALID_REPORT_CONFIG', 'A report service and administrator authorization adapter are required.');
  const authorized = async (req, operation) => {
    const actor = await authorize(req, { operation, tenantId: service.tenantId });
    requireValue(actor?.authenticated === true, 'ADMIN_AUTH_REQUIRED', 'Administrator authentication is required.', 401);
    requireValue(actor.allowed === true && actor.tenantId === service.tenantId && id(actor.subjectId),
      'ADMIN_PERMISSION_REQUIRED', 'Administrator permission for this report operation is required.', 403);
    return actor;
  };
  const wrap = handler => async (req, res) => {
    try { await handler(req, res); }
    catch (error) {
      const safe = error instanceof ReportError ? error : new ReportError('REPORT_UNAVAILABLE', 'The report operation is temporarily unavailable.', 503);
      res.status(safe.statusCode).json({ ok: false, code: safe.code, error: safe.message });
    }
  };
  const download = (res, file) => {
    res.setHeader('Content-Type', file.mimeType); res.setHeader('Content-Disposition', `attachment; filename="${file.name}"`);
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.send(file.bytes);
  };
  return Object.freeze({
    export: wrap(async (req, res) => {
      await authorized(req, 'export');
      const { fromMs, beforeMs, kinds, limit, archive } = req.body || {};
      const bundle = await service.createExport({ fromMs, beforeMs, kinds, limit });
      let archiveStatus = 'not-requested';
      if (archive === true) {
        try { await service.archiveExport(bundle); archiveStatus = 'verified'; }
        catch { archiveStatus = 'unavailable'; }
      }
      res.setHeader('X-SH-Export-ID', bundle.batch.id); res.setHeader('X-SH-Archive-Status', archiveStatus);
      res.setHeader('X-SH-Record-Count', String(bundle.batch.rows.length));
      res.setHeader('X-SH-Export-Has-More', bundle.batch.selection.hasMore ? 'true' : 'false');
      download(res, { name: `sh-history-${bundle.batch.id}.zip`, mimeType: 'application/zip', bytes: await zipDownload(bundle) });
    }),
    workbook: wrap(async (req, res) => { await authorized(req, 'export'); download(res, (await service.downloadArchive(req.params.exportId)).xlsx); }),
    manifest: wrap(async (req, res) => { await authorized(req, 'export'); download(res, (await service.downloadArchive(req.params.exportId)).manifest); }),
    status: wrap(async (req, res) => { await authorized(req, 'export'); res.setHeader('Cache-Control', 'no-store'); res.json(await service.status(req.params.exportId)); }),
    purge: wrap(async (req, res) => {
      const actor = await authorized(req, 'purge');
      const result = await service.purge(req.params.exportId, { dryRun: req.body?.dryRun !== false,
        workerId: `admin:${actor.subjectId}`, maxChunks: req.body?.maxChunks ?? 3 });
      res.setHeader('Cache-Control', 'no-store'); res.json(result);
    })
  });
}
