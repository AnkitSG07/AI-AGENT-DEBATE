# Storage migration validation

Validated implementation: `4bd481c9e6aa7e90cebb9769875e092b897bd884`.
Production routing was not changed during this validation. The existing APK and
Odoo embed were not rebuilt or replaced.

## Isolated Render verification

Service: `sh-chat-r22-audio-verification` (existing Free service).
Deploy: `dep-dblf4tdg1s2s73eicb3g`, using
`tests/simulator-media-r13/Dockerfile.verify-cloudflare`.

| Check | Passed | Failed |
| --- | ---: | ---: |
| Existing unit, HTTP and browser verifier | 1,085 | 0 |
| Cloudflare client, domain runtime, migration, Worker and admin authorization | 114 | 0 |
| Administrator migration UI | 5 | 0 |
| WebKit invitation/browser handoff | 6 | 0 |
| Real hold music, private handover, conference and continuous recording scenario | 1 | 0 |
| Actual SFU audio, ownership, transfer and recovery scenarios | 20 | 0 |

The SFU suite verifies decoded bidirectional RTP, initial silence, A-to-B-to-A
handover after old-leg shutdown, stale old-leg End rejection, source preservation
when the target declines or has no audio, restart ownership recovery, lost
Accept/Dial acknowledgements, duplicate End cleanup and invitation timeout.
All customers, devices and notification transports in these tests are synthetic.
No customer was called and no real FCM notification was sent.

These results do not establish physical Android/iPhone latency or notification
receipt. Cloudflare's deployed CPU/latency, the actual source inventory, final
copy/checksum and enrolled-phone acceptance still need verification before the
production switch. The protected quiet-point check may pause the migration
without switching the current app.

The subsequent migration-guard revision also passed the expanded 131-case
Cloudflare suite and four actual Google Firestore SDK/emulator concurrency tests.
Those cover empty journals with retained history, a new call after preflight,
an already running source transaction crossing the fence, and a source call
starting after the final proof query. Completed history no longer has a lifetime
100-row limit. Active/uncertain calls and unproven legacy claims still block the
switch. The underlying media implementation from the Render verification remains
unchanged by this guard revision.

## Measured storage work

The existing domain adapters and production Node client were measured against
the actual local workerd/SQLite implementation using cursor `rowsRead` and
`rowsWritten`. Only test-loaded source was instrumented in memory. The deployed
source was not changed for metering. Current indexes were used; an experimental
sparse-index alternative was not included in this update.

| Operation | Worker requests | DO requests | SQL rows read | SQL rows written |
| --- | ---: | ---: | ---: | ---: |
| Device authentication | 1 | 1 | 3 | 0 |
| Connected native status, including authentication | 4 | 4 | 9 | 0 |
| Incoming call through connection | 26 | 26 | 130 | 147 |
| End and cleanup | 20 | 20 | 216 | 160 |
| Unread observation | 2 | 2 | 39 | 16 |
| 50 incoming messages to five phones, 250 accepted synthetic notifications | 1,451 | 1,451 | 157,233 | 8,501 |

Read-only nonce handling creates no persistent SQL writes. Mutation replay
protection and commit acknowledgements remain persistent.

For 30 daily calls of four minutes, five continuously foreground phones and 50
incoming messages, a rough normal baseline is about 53,000 Worker requests and
53,000 DO requests per day. Call transitions, message delivery and call-push
receipts account for approximately 27,000 SQL rows written per day, with reports,
maintenance, retries, transfers and extra activity adding usage. This is a
capacity estimate, not a guarantee or a quota reservation.

The nearer free allowance is likely the 100,000 daily requests for Workers and
DOs. SQLite's daily allowances are five million rows read and 100,000 rows
written. Storage, invocation CPU and other provider allowances also apply; a
new provider does not make these resources unlimited. Verify actual Cloudflare
CPU and usage after provisioning and before fencing the source.

References:

- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [SQLite storage metrics](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
