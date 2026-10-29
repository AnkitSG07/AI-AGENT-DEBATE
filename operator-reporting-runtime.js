// Server-only wiring. Report failures never participate in call/audio control.
import { randomUUID } from 'node:crypto';
import { createFirestoreMediaStore } from './media-store/firestore-media-store.mjs';
import { createFirestoreReportStore } from './reporting/firestore-report-store.mjs';
import { createReportService } from './reporting/report-service.mjs';
import { createTerminalReportCollector, createFirestoreTerminalReportSource } from './reporting/terminal-collector.mjs';
import { createOdooArchiveAdapter } from './reporting/odoo-archive.mjs';
import { createFirestoreArchiveAdapter } from './reporting/firestore-archive.mjs';
import { createReportRetentionWorker } from './reporting/retention-worker.mjs';
import { createReportHandlers } from './reporting/routes.mjs';
import { ReportError, requireValue } from './reporting/schema.mjs';

export function createOperatorReportingRuntime({ firestoreRuntime, mediaStore: providedMediaStore,
  authorize, executeOdoo, getArchiveCompanyId, env = process.env, logger = console, now = Date.now,
  timers = { setInterval, clearInterval }, archiveDiscoveryTimeoutMs = 10000 } = {}) {
  const workerId = `report-${randomUUID()}`, tenantId = 'smart-handicrafts';
  let mediaStore, reportStore, collector, service, retention, configured = false, timer = null, work = null, retentionWork = null;
  let archiveAdapter = null, archiveLookup = null, lastWarningAt = -Infinity;
  const archiveBackend = String(env.SH_OPERATOR_ARCHIVE_BACKEND || 'odoo').trim().toLowerCase();
  const retentionOptIn = env.SH_OPERATOR_REPORT_RETENTION_ENABLED === 'true';
  let archiveConfigured = false;
  const rates = new Map();
  let origin;
  try {
    const configuredUrl = new URL(env.APP_URL || 'https://ai-agent-debate.onrender.com');
    if (!['https:', 'http:'].includes(configuredUrl.protocol)) throw Error('Invalid origin');
    origin = configuredUrl.origin;
  } catch { origin = null; }
  const warn = () => {
    if (now() - lastWarningAt < 60000) return;
    lastWarningAt = now(); logger.warn?.('Operator report collection is unavailable and will retry; call handling is unaffected.');
  };
  const storageUnavailable = () => new ReportError('REPORT_STORAGE_UNAVAILABLE', 'Persistent report storage is not configured or is unavailable.', 503);

  async function discoverArchive() {
    requireValue(typeof executeOdoo === 'function', 'ARCHIVE_NOT_CONFIGURED', 'The existing backend Odoo connection is unavailable.', 503);
    let companyId;
    if (typeof getArchiveCompanyId === 'function') companyId = await getArchiveCompanyId();
    else {
      // This fallback only works if Odoo supplies the exact current account UID.
      // Never select the first user/company or assume account/company ID 1.
      const context = await executeOdoo('res.users', 'context_get', [], {});
      requireValue(Number.isSafeInteger(context?.uid) && context.uid > 0, 'ARCHIVE_COMPANY_UNVERIFIED',
        'The backend account company must be verified before archiving.', 503);
      const users = await executeOdoo('res.users', 'read', [[context.uid], ['id', 'company_id']], {});
      requireValue(users?.[0]?.id === context.uid && Array.isArray(users[0].company_id),
        'ARCHIVE_COMPANY_UNVERIFIED', 'Odoo did not return the current backend account company.', 503);
      companyId = users[0].company_id[0];
    }
    requireValue(Number.isSafeInteger(companyId) && companyId > 0, 'ARCHIVE_COMPANY_UNVERIFIED', 'A verified Odoo company is required.', 503);
    const companies = await executeOdoo('res.company', 'read', [[companyId], ['id']], {});
    requireValue(companies?.[0]?.id === companyId, 'ARCHIVE_COMPANY_UNVERIFIED', 'The backend account cannot verify its archive company.', 503);
    return createOdooArchiveAdapter({ execute: executeOdoo, parent: { model: 'res.company', id: companyId } });
  }
  function getArchive() {
    if (archiveAdapter) return Promise.resolve(archiveAdapter);
    if (archiveLookup) return archiveLookup;
    const timeoutMs = Number.isSafeInteger(archiveDiscoveryTimeoutMs) && archiveDiscoveryTimeoutMs >= 10 && archiveDiscoveryTimeoutMs <= 30000
      ? archiveDiscoveryTimeoutMs : 10000;
    let deadline;
    archiveLookup = Promise.race([Promise.resolve().then(discoverArchive), new Promise((_resolve, reject) => {
      deadline = setTimeout(() => reject(new ReportError('ARCHIVE_DISCOVERY_TIMEOUT', 'Odoo archive verification timed out.', 503)), timeoutMs);
    })]).then(adapter => { archiveAdapter = adapter; return adapter; })
      .finally(() => { clearTimeout(deadline); archiveLookup = null; });
    return archiveLookup;
  }
  const lazyArchive = { durable: true, kind: 'odoo-ir-attachment',
    put: async file => (await getArchive()).put(file), read: async locator => (await getArchive()).read(locator) };

  try {
    if (firestoreRuntime?.configured === true && firestoreRuntime.firestore) {
      const basePrefix = firestoreRuntime.collectionPrefix || 'sh_operator';
      mediaStore = providedMediaStore || createFirestoreMediaStore({ firestore: firestoreRuntime.firestore,
        collectionPrefix: `${basePrefix}_media`, clock: now });
      reportStore = createFirestoreReportStore({ firestore: firestoreRuntime.firestore, tenantId,
        collectionPrefix: `${basePrefix}_reports`, clock: now });
      const source = createFirestoreTerminalReportSource({ firestore: firestoreRuntime.firestore, tenantId,
        collectionPrefix: mediaStore.collectionPrefix || `${basePrefix}_media`, clock: now });
      collector = createTerminalReportCollector({ mediaStore, reportStore, source });
      const archive = archiveBackend === 'firestore' ? createFirestoreArchiveAdapter({ firestore: firestoreRuntime.firestore,
        tenantId, collectionPrefix: reportStore.collectionPrefix, clock: now }) : archiveBackend === 'odoo' ? lazyArchive : null;
      archiveConfigured = !!archive;
      service = createReportService({ store: reportStore, archive, allowDeletion: retentionOptIn && archiveConfigured, clock: now });
      retention = createReportRetentionWorker({ firestore: firestoreRuntime.firestore, service, tenantId,
        collectionPrefix: reportStore.collectionPrefix, enabled: retentionOptIn && archiveConfigured, clock: now, workerId });
      configured = true;
    }
  } catch { warn(); }

  async function authorizeRequest(req) {
    requireValue(typeof authorize === 'function' && await authorize(req) === true, 'ADMIN_AUTH_REQUIRED',
      'Sign in with the SUDO administrator profile.', 401);
    requireValue(typeof env.PROFILE_SESSION_SECRET === 'string' && env.PROFILE_SESSION_SECRET.trim().length >= 32 &&
      typeof env.PROFILE_PASS_SUDO === 'string' && env.PROFILE_PASS_SUDO.trim().length > 0,
    'ADMIN_SESSION_NOT_CONFIGURED', 'A strong explicit profile-session secret and SUDO password are required for report administration.', 503);
    if (req.method !== 'GET') {
      requireValue(origin && req.headers?.origin === origin && req.headers?.['x-sh-admin-action'] === '1',
        'ADMIN_ORIGIN_REQUIRED', 'Open this action from the Operator Hub administration page.', 403);
      const key = req.ip || req.socket?.remoteAddress || 'admin', previous = rates.get(key), timestamp = now();
      const rate = previous && previous.until > timestamp ? previous : { count: 0, until: timestamp + 60000 };
      rate.count++; rates.set(key, rate);
      for (const [client, row] of rates) if (row.until <= timestamp) rates.delete(client);
      if (rates.size > 512) rates.delete(rates.keys().next().value);
      requireValue(rate.count <= 12, 'ADMIN_RATE_LIMIT', 'Please wait before another reporting action.', 429);
    } else {
      requireValue((!req.headers?.origin || req.headers.origin === origin) && req.headers?.['sec-fetch-site'] !== 'cross-site',
        'ADMIN_ORIGIN_REQUIRED', 'Open report downloads from the Operator Hub administration page.', 403);
    }
    if (!configured) throw storageUnavailable();
    return { authenticated: true, allowed: true, tenantId, subjectId: 'profile:SUDO' };
  }
  const status = () => ({ configured, archiveBackend, archiveConfigured,
    archiveCompanyVerified: archiveBackend === 'odoo' && !!archiveAdapter,
    deletionEnabled: configured && retentionOptIn && archiveConfigured,
    retentionDays: 30, maxExportRows: 250, collectionIntervalMs: 30 * 60000,
    retention: retention?.status() || { enabled: false, scope: 'immutable_report_copies_only', canonicalMediaRetentionChanged: false, devicesDeleted: false } });
  function mount(app) {
    const target = service || { tenantId };
    const handlers = createReportHandlers({ service: target, authorize: authorizeRequest });
    app.post('/api/operator-reports/export', handlers.export);
    app.get('/api/operator-reports/exports/:exportId/workbook.xlsx', handlers.workbook);
    app.get('/api/operator-reports/exports/:exportId/manifest.json', handlers.manifest);
    app.get('/api/operator-reports/exports/:exportId', handlers.status);
    app.post('/api/operator-reports/exports/:exportId/purge', handlers.purge);
    app.get('/api/operator-reports/status', async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      try { await authorizeRequest(req); res.json({ ok: true, ...status() }); }
      catch (error) { const safe = error instanceof ReportError ? error : storageUnavailable();
        res.status(safe.statusCode).json({ ok: false, code: safe.code, error: safe.message }); }
    });
  }
  async function collectSession(sessionId) {
    if (!collector) return { status: 'unavailable' };
    try { return await collector.collectSession(sessionId); }
    catch { warn(); return { status: 'deferred' }; }
  }
  function sweep() {
    if (!collector) return Promise.resolve({ status: 'unavailable' });
    if (work) return work;
    work = Promise.resolve().then(() => collector.scan({ workerId, limit: 16 }))
      .catch(() => { warn(); return { status: 'deferred' }; })
      .finally(() => { work = null; });
    return work;
  }
  function retentionSweep() {
    if (!retention) return Promise.resolve({ status: 'unavailable' });
    if (retentionWork) return retentionWork;
    retentionWork = retention.run().catch(() => { warn(); return { status: 'deferred' }; })
      .finally(() => { retentionWork = null; });
    return retentionWork;
  }
  function start() {
    if (!configured || timer) return;
    const tick = () => { void sweep(); void retentionSweep(); };
    tick(); timer = timers.setInterval(tick, 30 * 60000); timer.unref?.();
  }
  async function close() {
    if (timer) timers.clearInterval(timer); timer = null;
    if (work) await work;
    if (retentionWork) await retentionWork;
    // The shared Firestore client's lifetime belongs to firestoreRuntime.
  }
  return Object.freeze({ configured, mount, start, close, collectSession, sweep, retentionSweep, status });
}
