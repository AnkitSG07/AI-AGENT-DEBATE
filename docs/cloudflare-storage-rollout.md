# SH Chat storage update

This update keeps the existing APK and HTTP contracts. Odoo remains responsible
for customer chat content and Odoo sessions. Firebase Cloud Messaging remains the
notification delivery provider. The private Cloudflare Worker replaces the
Firestore records used by the operator registry, call coordination, unread state
and copied reporting data. LiveKit and Cloudflare TURN keep their media roles.

The Worker is isolated until a verified migration activates it. Creating the
Worker alone does not change production routing. No enrollment invitation is
bootstrapped against the new store: existing credential hashes, generations,
expiry, revoked devices and consumed invitations are copied exactly.

## Configuration

Cloudflare's `cloudflare/operator-store/wrangler.jsonc` uses Workers Free-compatible
SQLite Durable Objects. Deploy with its locked Wrangler version. Set separate,
random, server-only `SH_STORE_SECRET` and `SH_STORE_MIGRATION_SECRET` secrets.
Never put either key in Git, the APK, an Odoo embed or a URL. The Worker authenticates
requests before invoking its Durable Object. It exposes no public data browser.

On Render, initially keep `SH_ANDROID_REGISTRY_BACKEND=firestore` and set:

| Variable | Value |
| --- | --- |
| `SH_CLOUDFLARE_STORE_URL` | The deployed Worker's HTTPS origin |
| `SH_CLOUDFLARE_STORE_SECRET` | Same value as the Worker's normal secret |
| `SH_CLOUDFLARE_MIGRATION_SECRET` | Same value as the Worker's migration secret |
| `SH_CLOUDFLARE_MIGRATION_ENABLED` | `true` during the supervised migration |
| `SH_OPERATOR_FIRESTORE_PREFIX` | The existing prefix, unchanged |

Keep the existing Firebase service account for FCM. Storage configuration must not
replace the Android Firebase project or require a new APK.

## Rollout order

1. Run `npm ci --ignore-scripts` at the root and in `cloudflare/operator-store`,
   then `npm run test:operator-cloudflare`. Run the existing R13 verifier and
   isolated real-media suite. Do not use real customers as automated test targets.
2. Deploy and verify the isolated Worker, including denied unauthenticated
   requests. It must have its SQLite binding and both distinct secrets before use.
3. Deploy the compatible Render code during a quiet period with no voice/video
   calls or pending media cleanup. Render restarts terminate in-process media
   workers; zero-downtime HTTP routing alone does not preserve that audio.
4. Wait for all pre-journal Render instances and draining requests to stop before
   preparing the migration. An old process must not write after the copy begins.
5. From the signed SUDO device-management page, prepare the migration and copy the
   source namespace. Source writes continue and append after-images/deletion
   records atomically to the source journal. Replay does not send notifications.
6. Run the combined cutover action. Expensive inventory and checksum work happens
   while the source remains writable. The final source transaction requires a
   quiet call state and a small bounded media inventory (at most 100 rows and
   512 KiB; larger inventories pause before taking the gate lock), fences source operations, and catches the remaining journal
   tail before checksum sealing and activation. New requests wait briefly while
   activation finishes. Do not expose a standalone fence action.
7. Confirm the verified count/checksum and target readiness. Check existing device
   authentication, unread state, history and call controls. Verify physical phone
   notifications and two-way audio separately; FCM acceptance is not handset receipt.
8. Set `SH_ANDROID_REGISTRY_BACKEND=cloudflare` and disable migration controls.
   Deploy that final configuration only during another quiet period. This removes
   the source-gate read from future process starts. Retain the source backup.

## Recovery

Before fencing, a failed copy or verification leaves the current source selected.
Retry the same migration; source-version checks prevent older snapshot pages from
resurrecting deleted records. Lost commit acknowledgements replay the same
idempotent commit rather than issuing another domain action.

After fencing, resume the combined cutover action. If the target was sealed or
activated before an acknowledgement was lost, verify the persisted manifest and
finish readiness. If the process was lost earlier, recovery may need a full
fenced source verification. Do not fall back to stale Firestore after target
writes. New code enforces the durable fence even when migration administration
is disabled. Never roll back to a pre-fence implementation or delete the gate.

## Free allowances

Free allowances are finite. Monitor Worker requests/CPU, Durable Object requests,
rows read/written and storage separately from Firebase FCM, LiveKit participant
minutes and TURN bandwidth. This migration does not promise unlimited usage or
guaranteed sub-second mobile delivery. Do not rotate accounts to evade quotas or
enable a paid plan automatically. A storage-only update cannot remove all network,
mobile OS, SFU, provider or cold-start latency.
