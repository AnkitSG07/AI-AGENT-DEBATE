# SH Chat Firebase project migration

This tool copies the private SH Chat Firestore namespace into an existing, separately configured Firebase project. It does not create the destination project/database, change permissions, update Render settings, send notifications, delete source data, or certify real-phone delivery.

The executable is `scripts/migrate-sh-firestore.mjs`. Its reusable implementation is `scripts/sh-firestore-migration.mjs`.

## Maintenance requirement

Stop every source writer before exporting. Keep the source and destination writers stopped through final verification and the coordinated cutover. The flags `--source-paused` and `--destination-paused` are **operator confirmations**, not an automatic lock or proof that another client cannot write. The tool performs two complete source scans and compares values, document IDs, collection inventory and update timestamps; it fails if those passes differ. Repeat source verification immediately before switching the service.

Do not migrate during a live call. The inspection summary reports unsettled sessions and retained reservations. These records are copied intact; the tool never clears a device reservation or changes a pending provider operation to make the migration pass. Any unresolved operation needs review before service activation.

## Scope and format

The default prefix is `sh_operator`. Every root collection beginning exactly `sh_operator_` is included, together with all descendant collections. This includes devices, credential generations, installations, invitations, replay/rotation markers, delivery claims, app unread state, media sessions/calls/reservations/events/jobs, call permissions, AI/handover receipts, reporting records, retention state and private archive chunks. Unrelated root collections are excluded.

Subcollections below non-existing parent documents are traversed without creating those parents in the destination. Firestore wire types preserve 64-bit integers, bytes, timestamp nanoseconds, reference values, GeoPoints and special double values. References into the migrated namespace within the source database are retargeted to the destination database; external references are preserved.

Each document and the complete manifest have SHA-256 hashes. Verification also checks active credential/device generation bindings, exact media record key hashes, reservation device hashes and private archive chunk hashes. This verifies preservation of those invariants; it is not an exhaustive repair tool for pre-existing data defects.

## Private inputs and output

Account files and exports must be outside the Git repository. Files must have mode `0600`; never commit an export or service-account key. Exports contain private device registrations, message state and operational records. Do not paste them into chat, logs, public GitHub files or browser storage.

The CLI requires an explicit project ID matching its service-account file. Inside the **existing source Render environment**, `--account-env SH_ANDROID_FIREBASE_SERVICE_ACCOUNT_JSON` can replace `--account-file`; it uses the already configured identity without printing its value. No other environment variable is inspected for credentials.

The source account needs read/list access. The destination account needs read/list/create access. Provision and confirm these separately; the migration tool does not grant itself access. Emulator/endpoint overrides are rejected by this production CLI. All CLI failures emit a fixed code, excluding SDK messages, document payloads, IDs and secrets.

## Commands

Use the actual source/destination project IDs and private paths. These placeholders are not runnable configuration.

```bash
node scripts/migrate-sh-firestore.mjs export \
  --project SOURCE_PROJECT \
  --account-file /private/source-account.json \
  --file /private/sh-chat-export.json \
  --source-paused

node scripts/migrate-sh-firestore.mjs inspect \
  --file /private/sh-chat-export.json

node scripts/migrate-sh-firestore.mjs import \
  --project DESTINATION_PROJECT \
  --account-file /private/destination-account.json \
  --file /private/sh-chat-export.json \
  --expected-hash MANIFEST_SHA256_FROM_EXPORT \
  --source-paused --destination-paused

node scripts/migrate-sh-firestore.mjs verify-target \
  --project DESTINATION_PROJECT \
  --account-file /private/destination-account.json \
  --file /private/sh-chat-export.json

node scripts/migrate-sh-firestore.mjs verify-source \
  --project SOURCE_PROJECT \
  --account-file /private/source-account.json \
  --file /private/sh-chat-export.json \
  --source-paused
```

The database defaults to `(default)` and may be selected explicitly with `--database`. Export supports `--prefix` when the deployment uses a different private namespace. An existing export file is never overwritten.

Each scan uses one read-only task queue for parent discovery and collection document listing, in waves of at most 32 tasks. Root collections can therefore list documents concurrently, and missing parents still have their child collections discovered. Document, collection, byte, depth and time limits remain global; failed waves drain their started reads before returning, and inventories are sorted before hashing.

Import is create-only, in batches of at most 100 documents and conservatively less than the Firestore commit byte limit. The default scan limits are 20,000 document paths (including missing parents), 500 collections, 64 MiB of encoded document data and ten minutes per pass. Exceeding a bound fails closed.

If a destination commit acknowledgement is lost, stop and rerun the same import with the same expected manifest hash. The tool reads the destination first. Exact matches are skipped; conflicting or extra scoped documents stop the import before any new write. It never overwrites a conflict, deletes the source, or runs a compensating deletion. A successful destination verification means document count and full value hash match; it does not mean the service was switched.

## Coordinated activation

Only activate the new Render configuration after final source and destination verification succeed, required indexes/rules and the database region are configured, and pending-call findings have been reviewed. Copy or recreate the project's required operational configuration separately; documents do not include Firestore indexes, IAM, rules, TTL settings, Firebase Android app registration, Firebase Auth users, FCM credentials or client options.

Old FCM registration tokens belong to the old Firebase project. Copying a device record does **not** make its token sendable from the new project. Android devices need the new Firebase client configuration and new registration tokens. The current app explicitly clears enrollment when it detects a Firebase project change; plan and verify each phone's enrollment, incoming call alert, real message notification, sender/preview and chat opening after the cutover. Keep the source preserved for investigation/rollback, and never enable independent writers against both databases.

## Offline verification

```bash
node --test tests/operator-firestore-migration.test.mjs
```

The fake transport tests cover typed values, orphan subcollections, source drift, source write-time drift, identity bindings, conflicting targets, missing maintenance flags, same-project rejection, manifest tampering, bounded scans, lost-commit resumption and metadata-only CLI output. They do not claim production IAM, available quota, a successful live copy or phone delivery.

For environments with an HTTP egress proxy, `--rest` selects the official SDK HTTP transport. Honor the environment proxy and CA trust settings; do not disable TLS verification or route around a denied destination.
