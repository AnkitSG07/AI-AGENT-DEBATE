# Operator history export and verified archive cleanup

This component creates Excel exports from **immutable report copies** of completed calls and operational events. It can archive the workbook and a complete JSON manifest privately in the existing Firestore database, or use a verified private Odoo attachment destination. Cleanup is disabled by default and is restricted to report records older than 30 days whose exact exported contents have been read back from a durable archive.

It does not delete device registrations, credentials, enrollment history, active calls, canonical media sessions, provider-event tombstones, device reservations or cleanup jobs. The server-only runtime mounts administrator-authorized routes and supports an explicitly enabled retention worker; the lower-level modules mount no endpoints themselves.

## Verification and deployment status

- **48 tests pass on Node 18.20.8**, including the portable single-file test bundle. These exercise real XLSX generation/read-back, literal spreadsheet text, archive corruption and interruption, age limits, record changes, competing workers, crash/lost-ack recovery, administrator permissions, private Odoo attachment scope and idempotent report collection.
- **4 integration tests pass against the official Firestore emulator using SDK 8.7.1.** They cover actual conditional deletion and lease competition, terminal-only source queries with equal timestamps, persistent collection cursors and deferred settlement, private XLSX chunk archives with restart read-back, and two competing automatic retention workers. Only project `demo-sh-operator-registry-r10` at `127.0.0.1:8089` is used.
- The unit suite uses explicit storage/provider fixtures. The SDK suite exercises real Firestore SDK transactions and archive byte storage in the localhost emulator. Odoo remains a transport test double. No production archive was created or verified by this component's tests, and no production history was deleted. Automatic purge is off unless the explicit retention environment variable is enabled after live archive verification.

Evidence is recorded in `test/validation.json`, `test/node18-validation.tap`, and `test/emulator-validation.*`.

## Files

| File | Responsibility |
| --- | --- |
| `schema.mjs` | Strict report field allowlists, canonical hashes, settled-call projection and sanitized errors |
| `firestore-report-store.mjs` | Immutable report writes, bounded selection, export metadata, purge leases/checkpoints and collection progress |
| `terminal-collector.mjs` | Read-only terminal-session paging, idempotent call/transfer projection and durable deferred retry |
| `report-service.mjs` | Export plans, XLSX/manifest hashes, full archive read-back and guarded cleanup |
| `xlsx-writer.mjs` | Branded typed XLSX tables and a ZIP download containing both export files |
| `firestore-archive.mjs` | Bounded immutable private XLSX/manifest chunks, completion receipts and full read-back |
| `retention-worker.mjs` | Opt-in, leased and recoverable report-only 30-day export/archive/purge orchestration |
| `odoo-archive.mjs` | Private, company-bound `ir.attachment` adapter using an injected existing backend RPC helper |
| `routes.mjs` | Administrator-authorized handler factory; denies access until an authorization adapter is supplied |
| `firestore.indexes.json` | Index exemptions and one terminal-source index exception to merge with application configuration |

The production export dependencies are pinned to `exceljs` **4.4.0** and `jszip` **3.10.1** in `package-lock.json`. JSZip is used directly for the download containing the workbook **and** its manifest. Keeping the direct import explicitly pinned avoids relying on an incidental transitive dependency of ExcelJS. The existing application supplies its Firestore 8.7.1 client.

## Minimal server integration

```js
import { createFirestoreReportStore } from './reporting/firestore-report-store.mjs';
import { createReportService } from './reporting/report-service.mjs';
import { createTerminalReportCollector, createFirestoreTerminalReportSource } from './reporting/terminal-collector.mjs';

const reportStore = createFirestoreReportStore({
  firestore: existingServerFirestoreClient,
  tenantId: 'smart-handicrafts',
  collectionPrefix: 'sh_operator_reports',
});

const source = createFirestoreTerminalReportSource({
  firestore: existingServerFirestoreClient,
  collectionPrefix: mediaStore.collectionPrefix,
  tenantId: 'smart-handicrafts',
});
const collector = createTerminalReportCollector({ mediaStore, reportStore, source });

const reporting = createReportService({
  store: reportStore,
  archive: null,          // Download works before an archive is configured.
  allowDeletion: false,  // Keep off until the real archive has been verified.
});
```

After call recovery has finished, invoke `collector.collectSession(sessionId)` in its own caught/background step. Reporting failure must never change call/audio state or make an otherwise successful accept/end action fail.

```js
await callRuntime.recoverSession(sessionId);
try {
  await collector.collectSession(sessionId);
} catch (error) {
  // Log only a sanitized code, without raw SDK errors, credentials or SDP.
  logReportFailure(error.code || 'REPORT_UNAVAILABLE');
}
```

For bounded catch-up and retries, call `collector.scan({ workerId, limit: 16 })` at startup and on a modest interval. Each sweep reads at most 32 new terminal IDs and 32 deferred IDs, with a maximum requested limit of 32. The default is 16 of each. A persistent report-only lease prevents overlapping workers, and a persisted cursor resumes after redeployment. A failed sweep keeps its old cursor. Duplicate projection is safe.

The collector reads core media records and does not modify them. A call report requires confirmed termination from the canonical connected call, or from the pre-media session when no canonical call exists. Media cleanup must be finished, and no accept/dial operation may remain issued or uncertain. Notification-only retries do not prevent a completed call from appearing in reports. Unsettled terminal sessions enter a durable 30-second retry queue.

Completed transfers become separate `call_transfer` activity rows with deterministic IDs. Current and historical transfer records are deduplicated by transfer ID. Legacy browser claims marked `nativeOnly` are skipped because their actual browser-call history belongs to the existing browser path. Active sessions are not exported as finalized calls.

The terminal source cursor orders by immutable terminal time and document identity. It covers the runtime's normal newly terminated sessions. If an administrator later imports old terminal sessions behind that cursor, call `collectSession(id)` for those exact imported sessions or perform a controlled report-only cursor reset. Never alter or delete the core terminal records to force backfill.

## Data included and excluded

The report namespace must end with `_reports`, keeping it separate from operational and authentication collections. Default collections are:

| Collection | Data |
| --- | --- |
| `sh_operator_reports_calls` | Final call ID, direction, customer name/phone, UTC start/connect/end timestamps, outcome, operator label/device ID, duration and completed transfer count |
| `sh_operator_reports_activity` | Final event ID/type, optional call ID, UTC event time, operator label, status and bounded summary |
| `sh_operator_reports_exports` | Immutable export plan, hashes, archive locators and purge checkpoint |
| `sh_operator_reports_collector` | Terminal-source cursor and collection worker lease |
| `sh_operator_reports_deferred` | Exact unsettled terminal session IDs awaiting projection |
| `sh_operator_reports_receipts` | Minimal finalization/archive receipts preventing old call replay from recreating purged reports |
| `sh_operator_reports_archive_objects` | Immutable file metadata and ordered chunk hashes |
| `sh_operator_reports_archive_chunks` | Private immutable binary chunks, at most 192 KiB each |
| `sh_operator_reports_archive_bundles` | Two-file export binding and complete-bundle receipt |
| `sh_operator_reports_retention` | Report-only maintenance lease, pending export, next due time and last-run counters |

Only `calls` and `activity` report records may be deleted by a history purge. The other reporting collections are control/audit state. No API accepts an arbitrary collection name for deletion.

Unknown record fields are rejected. SDP, tokens, bearer credentials, raw provider errors, microphone data and message/file contents are not copied. A report is immutable: repeated writes of the same outcome succeed idempotently, while a different outcome for the same report ID raises a conflict. Customer names and phone numbers remain business data and require authenticated access to exports and archives.

## Download and archive flow

```js
const bundle = await reporting.createExport({
  // Defaults: all finalized reports before now minus 30 days.
  fromMs: 0,
  beforeMs: cutoffTimestamp,
  kinds: ['calls', 'activity'],
  limit: 250,
});
```

The result contains `batch`, `xlsx` and `manifest`. File objects contain `name`, `mimeType`, `size`, `sha256` and `bytes`. The manifest includes every normalized source report, its fingerprint, the exact selection and the workbook hash. The persisted export plan contains exact source references and both file hashes, allowing cleanup to prove which rows were archived.

Exports are bounded to 250 rows per batch. `selection.hasMore` explicitly identifies a partial result. Use a narrower date range for manual exports, or archive/verify/clean an old eligible batch and export the next batch. Do not describe a bounded batch as a complete month when `hasMore` is true. Recent-history downloads can use `beforeMs: Date.now()`, but records younger than 30 days remain ineligible for cleanup.

The workbook has `Calls` and/or `Activity` tables, frozen headers, filters, typed dates, numeric durations and preserved text phone numbers. All times are UTC. User strings are literal spreadsheet cells, including text starting with `=`; no customer text becomes a formula, macro or external-link object. The tests verify this by loading the generated XLSX.

`zipDownload(bundle)` returns a ZIP containing the XLSX and its matching JSON manifest. This remains available when the archive is unconfigured or unavailable. A local download is **not** treated as proof of a durable server archive and never authorizes deletion.

## Private Firestore archive

Set `SH_OPERATOR_ARCHIVE_BACKEND=firestore` in the existing server runtime. The adapter uses the already configured server SDK and database; it requires no Cloud Storage bucket, new credentials or billing-specific backup/TTL feature.

```js
import { createFirestoreArchiveAdapter } from './reporting/firestore-archive.mjs';
const archive = createFirestoreArchiveAdapter({
  firestore: existingServerFirestoreClient,
  tenantId: 'smart-handicrafts',
  collectionPrefix: 'sh_operator_reports',
});
```

The default caps are **192 KiB per chunk, 2 MiB per file and 4 MiB per workbook-plus-manifest bundle**. Only the exact export's XLSX and JSON manifest are accepted; this is not storage for audio, photos or arbitrary attachments. Chunk documents stay comfortably below Firestore's [1 MiB document limit](https://firebase.google.com/docs/firestore/quotas). An oversized export fails safely and retains its source reports.

An immutable slot reserves each file's name, length and hash. Each chunk is created once; retries validate existing bytes. The manifest must bind the same tenant, export ID and workbook hash. File completion is recorded only after every chunk has been read back and its full SHA-256 verified. Bundle completion requires both files. Reads refuse incomplete bundles, then verify every requested chunk and the complete file again. The service independently validates both files and exact report coverage before recording an archive receipt or deleting a report.

The adapter has no delete method. A completed archive with missing or changed bytes fails closed, including when a previously paused uploader resumes. It never repairs a completed archive silently. Partial upload retries can resume committed chunks without replacing them. Archives and receipts survive report cleanup.

Apply the supplied index exemptions, especially `sh_operator_reports_archive_chunks.bytes`. These operations use bounded document IDs rather than collection scans. A file uses `ceil(fileBytes / 196608)` chunks at the default setting; repeated integrity checks and transaction retries add reads, so this is intended for small report batches. The [official free quota](https://firebase.google.com/docs/firestore/quotas) currently includes 1 GiB stored data, 50,000 document reads/day and 20,000 writes and deletes/day for one eligible database. All application use shares those quotas. Retained archive bytes, core media state and receipts continue accumulating; report-copy cleanup is not a claim that the whole database is limited to 30 days or that storage is unlimited.

Client security rules should continue denying direct access. The existing server service account and administrator routes control access to archives; no public URLs or Firebase client tokens are created.

## Odoo archive adapter

The archive adapter reuses the existing server's authenticated RPC implementation:

```js
import { createOdooArchiveAdapter } from './reporting/odoo-archive.mjs';

const archive = createOdooArchiveAdapter({
  execute: async (model, method, args, kwargs) => {
    const uid = await odooLoginCached();
    return odooExecute(uid, model, method, args, kwargs);
  },
  parent: { model: 'res.company', id: verifiedCompanyId },
});
```

Discover and verify `verifiedCompanyId` through the existing authorized backend account; do not assume company ID 1. This module does not read environment secrets, log credentials, create a login, or assert that the current Odoo plan permits external RPC. Keep the archive unset until the actual account/API and destination permissions have been tested.

The adapter creates two binary `ir.attachment` records with `public: false`, scoped to the configured company record. It does not create public links or access tokens. The export ID and expected hash identify retry candidates. Uploads occur outside Firestore transactions. An interrupted upload may leave an extra private attachment, but cannot authorize report deletion.

Verification reads both full attachments back using `context: { bin_size: false }`. It rechecks attachment identity, name, MIME type, company binding, `public: false`, byte length and SHA-256. The service also checks the manifest's exact report coverage. An upload response alone is insufficient. Each upload/read-back operation has a 15-second deadline by default (`archiveTimeoutMs`, bounded to at most 60 seconds). A timed-out upload may later leave a private orphan attachment; no archive receipt is recorded and no source record is deleted.

```js
await reporting.archiveExport(bundle);
const archived = await reporting.downloadArchive(bundle.batch.id);
```

Archived downloads re-verify the complete stored files. Keep the archive's own retention and permissions appropriate for business records. This module never deletes archive attachments.

## Cleanup safety and restart behavior

```js
// Default: read-only preview, including fresh archive integrity verification.
const preview = await reporting.purge(exportId);

// Requires server construction with allowDeletion:true and explicit admin action.
const result = await reporting.purge(exportId, {
  dryRun: false,
  workerId: uniqueWorkerId,
  maxChunks: 3,
});
```

A real cleanup pass re-reads the complete workbook and manifest **every time** before claiming work. Missing, moved, public or corrupted archive attachments stop deletion. The persisted `archiveVerifiedAtMs` is historical evidence; it does not bypass fresh verification.

Each worker claims an export with a random ID, generation and recoverable 60-second lease. Each transaction reads the current export and up to 40 source rows before writing. It deletes a row only when all of these still hold:

1. The row is in an explicitly allowed report collection.
2. Its immutable content fingerprint and operational timestamp match the export plan.
3. It is older than 30 days and before the export cutoff.
4. The exact purge claim remains current and unexpired.

Deletion, a minimal archived-report receipt and cursor advancement commit together. The receipt retains only report identity, hashes and archive/export reference; it contains no report payload. A later terminal-call replay returns the archived result instead of recreating deleted history. Receipts are excluded from report-history cleanup. A lost response cannot make a restart delete a later page twice. Missing rows are counted separately; changed/recent rows are skipped and retained. An old worker cannot release or use a newer worker's claim. A request performs at most five chunks; the default is three. A later authorized pass resumes the saved cursor after rechecking the archive.

## Optional automatic 30-day report retention

Automatic cleanup is **off by default**. First deploy with `SH_OPERATOR_ARCHIVE_BACKEND=firestore`, use the administrator export action with private archiving enabled, and verify the actual production archive download/read-back. Only then opt in with:

```text
SH_OPERATOR_REPORT_RETENTION_ENABLED=true
```

The runtime checks at startup and every 30 minutes; the durable control record schedules a normal successful pass once per day. Each pass processes at most **two batches of 100 reports** older than 30 days. Each batch follows export → archive → full read-back → fresh verification → conditional report-only purge. Backlogs retry after 30 minutes. Errors preserve the pending export and source records, with bounded exponential retry delay from 30 minutes up to one day. A worker lease and exact generation prevent competing/restarted workers from replacing newer progress.

A persisted pending export resumes after redeployment. XLSX ZIP timestamps are normalized to the export timestamp so its bytes can be regenerated exactly from the saved immutable source rows. Regenerated bytes must match the original export plan hashes. Changed/missing source or archive data stops cleanup; it never silently switches the deletion plan. Purge checkpoints and minimal archived-report receipts protect lost responses and prevent terminal-call replay from recreating purged reports.

The runtime's status reports the retention scope, pending export, next due time, latest export ID and last-run counters. These counters describe report-copy maintenance, not canonical call deletion. There is no manual real-purge control in the administrator UI. Canonical call/session retention, terminal replay protection and device registration retention remain separate concerns; this is not a general database cleanup tool.

## Server runtime and administrator UI

`createOperatorReportingRuntime({ firestoreRuntime, mediaStore?, authorize, executeOdoo?, getArchiveCompanyId?, env, logger, now })` in `operator-reporting-runtime.js` uses the shared SDK client. `authorize(req)` must return strict boolean `true` only for a verified signed SUDO session. Administration also requires an explicit strong profile-session secret, SUDO password, exact origin and `X-SH-Admin-Action: 1` for mutations. Configuration secrets never appear in responses.

Call `runtime.mount(app)` once; `runtime.start()` starts the startup and interval checks. Call `runtime.close()` during shutdown without closing the shared SDK client. `runtime.collectSession(sessionId)` catches reporting failures, so a call-state callback may invoke it without making successful accept/end actions fail. `runtime.sweep()`, `runtime.retentionSweep()` and `runtime.status()` support integration/diagnostics. Reports use the same tenant and separate `${basePrefix}_reports` namespace.

`SH_OPERATOR_ARCHIVE_BACKEND=odoo` retains optional lazy discovery through existing server RPC; a verified account/company ID is required. The default remains `odoo` for compatibility, but Firestore must be selected explicitly for this deployment. Unknown archive backends keep downloads available and disable retention.

The **Call history export** section of `operator-admin.html` preserves existing login/device management. It accepts a UTC date range and optional private archival, downloads a ZIP containing XLSX plus manifest, shows record count/partial-batch status and whether archive read-back succeeded, and provides links to the latest automatic export. It does not offer a real-purge button. Its JavaScript passed syntax/structure checks; visual verification in the signed-in production browser remains an integration check.

## Administrator handler contract

`createReportHandlers({ service, authorize })` returns handlers but mounts none. Its default authorization denies everything. The authorization adapter receives `{ operation: 'export' | 'purge', tenantId }` and must return:

```js
{ authenticated: true, allowed: true, tenantId: 'smart-handicrafts', subjectId: 'odoo:VERIFIED_USER_ID' }
```

Those values must come from actual verified administrator authentication. A request body, native device ID or ordinary call permission is insufficient. Cookie-based administration also requires the application's CSRF protection. Purge permission can be narrower than export permission.

Suggested paths are:

| Method/path | Handler | Result |
| --- | --- | --- |
| `POST /api/operator-reports/export` | `handlers.export` | ZIP download; optional `archive:true`; download still succeeds if archiving fails |
| `GET /api/operator-reports/exports/:exportId/workbook.xlsx` | `handlers.workbook` | Verified archived workbook |
| `GET /api/operator-reports/exports/:exportId/manifest.json` | `handlers.manifest` | Verified archived manifest |
| `GET /api/operator-reports/exports/:exportId` | `handlers.status` | Sanitized metadata and progress |
| `POST /api/operator-reports/exports/:exportId/purge` | `handlers.purge` | Dry-run by default; explicit `dryRun:false` still needs server enablement and purge permission |

Downloads are marked `no-store` and `nosniff`. The export response supplies `X-SH-Export-ID`, `X-SH-Record-Count`, `X-SH-Export-Has-More` and `X-SH-Archive-Status` (`verified`, `unavailable` or `not-requested`). No raw archive credentials or provider errors are exposed.

## Indexes and running checks

Merge `firestore.indexes.json` into the application's index configuration. Report payloads, export row references, archive byte/chunk maps and retention counters do not need indexing. Keep top-level report `occurredAtMs` and deferred `availableAtMs` indexed. Terminal source paging needs the explicit ascending child-field exception `data.terminal.endedAt` on `sh_operator_media_sessions`; the rest of `data`, including SDP, remains exempt. Update collection names if a configured prefix changes.

```sh
npm ci --ignore-scripts
node --test test/operator-reporting.test.mjs
```

The emulator test hard-fails outside the dedicated localhost endpoint and uses the pinned registry test client's SDK 8.7.1:

```sh
firebase --project demo-sh-operator-registry-r10 \
  --config ../media-store/test/firebase.json emulators:exec --only firestore \
  'node test/emulator.test.mjs'
```

Production archive write/read-back, administrator route mounting, the explicit retention opt-in and any Odoo plan access remain integration checks. Passing local transport/emulator tests does not establish those account-specific capabilities. The portable 48-test bundle in `test/operator-reporting.test.mjs` embeds only tests and synthetic fixtures; all production modules and dependencies remain external runtime imports.
