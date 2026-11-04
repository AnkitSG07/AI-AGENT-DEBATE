# SH Chat private operator store

This Worker is a SQLite-backed Durable Object for the existing server-side SH
Chat document adapters. It does not expose a public database browser or replace
the domain checks for call ownership, current credentials, enrollment or unread
versions. The existing production backend remains selected until a separately
verified migration is activated and the server configuration is changed.

The configured Worker name is `sh-chat-state`. It exports `OperatorStore`, bound
as `OPERATOR_STORE`, with `new_sqlite_classes` in its first migration. The binding
routes only to `idFromName(SH_STORE_TENANT)`; clients cannot choose another tenant.
`SH_STORE_PREFIX` restricts records to the known registry, call, message and
report collection suffixes. No request can execute arbitrary SQL.

## Authentication

Set separate server-only `SH_STORE_SECRET` and `SH_STORE_MIGRATION_SECRET` values,
each at least 32 bytes. Neither value belongs in Git, the APK, an Odoo embed or a
browser URL. Identical credentials are rejected. `POST /rpc` uses the normal
secret; `POST /migration` uses only the migration secret.

Each request has `Content-Type: application/json` and these headers:

- `x-sh-store-timestamp`: current epoch milliseconds as 13 decimal digits.
- `x-sh-store-nonce`: a new random base64url identifier of 20–100 characters.
- `x-sh-store-signature`: hex HMAC-SHA256 of the following UTF-8 text, using the
  appropriate secret: `timestamp + "\n" + nonce + "\n" + pathname + "\n" +
  sha256(exactRequestBody)`.

Signatures expire within a 60-second clock window. Mutation nonces are persisted
to reject replay across a restart, with indexed bounded expiry cleanup. Reads,
queries, write-free transaction checks, and migration status/checksum use a
bounded in-memory replay window, avoiding database writes for status/auth polls.
An evicted object may repeat a previously signed read within its short signature
window; it cannot use this path to mutate state. TLS is required by
the Node client. The Worker does not enable cross-origin browser requests and
never logs request bodies or exception details.

## RPC contract

All request bodies contain `version: 1`.

- `read`: `{op:"read", paths:["collection/document", ...]}` returns ordered
  snapshots `{path,exists,revision,data?}`. Revision zero means never created;
  deleted tombstones retain positive revisions, preventing delete/recreate ABA.
- `query`: `{op:"query", query:{collection,where:[],orderBy:[],limit?,startAfter?}}`
  returns snapshots plus `guard:{query,fingerprint}`. Comparisons support `==`,
  `<`, `<=`, `>` and `>=` on the application's scalar query fields. Nested
  terminal timestamps, deterministic document-ID ties, and snapshot cursors are
  supported. Documents missing an ordered field are excluded. An unbounded query
  exceeding 1,000 documents fails instead of silently truncating.
- `commit`: `{op:"commit",requestId,reads:[{path,revision}],queries:[guard],
  writes:[{type:"set"|"create"|"delete",path,data?}]}` checks all revisions and
  query fingerprints and applies all writes inside one synchronous SQLite
  transaction. `TRANSACTION_CONFLICT` is the only retryable callback conflict.
  A create-existing failure is semantic. Exact duplicate commit identities return
  the recorded acknowledgement; changing the payload is rejected. Domain
  validators retain their existing business request idempotency as well.

The Node adapter owns the lossless byte/timestamp JSON codec. The Worker stores
encoded records opaquely. Bodies/results are bounded to 8 MiB, documents to
1 MiB, and transactions to 450 writes. No local-file fallback exists.

## Staged migration

Normal RPC fails with `STORE_NOT_ACTIVE` before activation. Migration operations
require the separate migration credential and a stable `migrationId`.

1. `begin` opens an initially empty staging area.
2. `import` accepts a stable batch `requestId` and `documents`, each containing
   `path`, encoded `data` **or** `deleted:true`, and exact
   `sourceVersion:{seconds:"decimal-string",nanos:integer}`. Older source versions
   are ignored; equal versions with different contents fail atomically. Deletion
   tombstones prevent stale snapshot pages from resurrecting deleted records.
3. `checksum` returns only the live count and checksum. SHA-256 is computed over
   `path + "\n" + canonical(encodedData) + "\n"` for live records ordered by path.
   Canonical JSON sorts object keys, preserves array order and finite JSON types.
4. `seal` verifies `expectedCount` and `expectedChecksum` and closes imports.
5. `activate` verifies the same count/checksum and atomically promotes staging.
   It cannot overwrite an existing active store. Exact activation replay is safe.

The exporter/orchestrator must enable an atomic source mutation journal before
copying, replay deltas, fence source writes at final cutover, and verify the final
manifest. Active calls must remain on their original backend. The Worker does not
pretend that two databases can commit one application change atomically.

## Verification

`npm ci --ignore-scripts` then `npm test` runs real SQLite guard/migration tests
and isolated workerd tests for signed requests, replay rejection, activation,
the Node client, bytes/timestamps, contention and pagination. Domain runtime tests
in the repository verify enrollment, revocation, call transfers and unread state
against this Worker. `wrangler deploy --dry-run` builds without deploying.

This uses the Workers Free-compatible SQLite storage backend. Request, compute,
row-operation and storage limits still apply. Mutation replay protection and
commit acknowledgements are storage operations; monitor them along with domain
records. Read-only replay protection uses no SQL rows.
