# SH Chat R20 — quota and call-path fixes

The existing Firebase architecture is retained following the user's clarification. On 2 November 2026, SH Chat was moved to the new Spark project `sh-chat-896e0`. Its default Firestore database is in `us-west1`, alongside the existing free Render service in Oregon. The source project is preserved.

## Confirmed defects and fixes

- A terminal, uncertain outgoing Dial with no provider ID requeued every 15 seconds despite having no safe remote action to perform. A 24-hour regression produced 28,800 writes before the fix and zero repeated writes after parking it. Its ownership reservation remains. Exact late HTTP responses and correlated CONNECT/ACCEPTED events still wake durable compensation.
- Completed recovery passes no longer rewrite unchanged sessions. Obsolete notification hints have bounded retry deadlines; customer/media cleanup retains durable ownership checks and recovery.
- Empty recovery discovery slows to one scan per minute; storage failures back off to five minutes. Explicit committed call actions bypass this discovery delay.
- Shared bounded Firestore subscriptions supply unread projections. Credentials and sensitive mutations still use fresh authorization; no authorization cache or file fallback was introduced. Trusted repeated Odoo observations remember only successfully committed IDs, with bounded memory and expiry.
- Healthy realtime connections and R20's explicit foreground-hint capability replace rapid idle polling. R19 retains its fallback until upgraded. Active calls, reconnect repair, exact hints and manual actions retain immediate requests. Errors back off; history stays visible as stale and recovers on a successful response.
- A new call hint previously waited behind unrelated GETs with 20-second timeouts. Exact fresh reads now bypass them; request fencing prevents old responses overwriting newer state. Transfer target/call hints read concurrently, and durable invitations dispatch before response projection finishes.
- R15+ preview formatting used Java's embedded Unicode regex flag, which Android's ICU engine rejects. The bounded formatter now scans code points; fallback formatting and fixed, non-sensitive diagnostics are independent. The physical Android test now includes an actual preview envelope.
- R20 delivers ID-only package-scoped foreground hints, fenced by enrollment generation and trusted visible page. They refresh state and never answer a call or open a microphone. Redundant native SDK track stopping was removed while preserving immediate mute and prior-room disposal.

## Verification and limits

815 backend/private-HTTP/VM checks pass with no source changes during the frozen run. The Android build for the new Firebase project passed 279 tests across 32 suites with zero failures/errors/skips; lint reported zero errors and 87 warnings. Signature, package/version, bundled Firebase settings, 16 KiB alignment and the supplied logo's pixels were verified in the signed APK. The migration suite passes 13 tests, including bounded concurrent discovery, orphan parents, deterministic hashes and failure draining.

Host ICU reproduced the old unsupported regex; the fixed production formatter has no regex dependency. The local browser test runner could not start its vendor browser. Separately, the connected Odoo website editor published the merged embed, and its three saved script payloads and thirteen styles were read back and verified. The live Calls panel opened without the temporary-history warning. This does not establish handset push delivery, live two-phone audio, a 2-second call cap or a 5-second transfer cap.

## Completed project move

The maintenance export contained 362 documents in 17 collections. Two stable source passes, destination import verification and a final source verification matched the complete value hashes. Device and active-credential bindings passed; no held reservations or unsettled sessions were present. All 16 single-field index configurations match the source and are ready; there are no scoped TTL policies or composite indexes.

Only the five Firebase Render settings were merged. Public client configuration returned HTTP 200 with the new project and Android application ID. Deployment `dep-dbk5nklg1s2s739cm5ig`, commit `80d673d443262b79c5edc4470c6cd01f04756139`, became live at 09:46:43 UTC. Startup confirmed `us-west1`; sampled new-instance database reads were 22–97 ms and transactions 75–301 ms. These startup samples are not end-to-end call measurements. The requested five-second heartbeat remains enabled and returned HTTP 200; the free plan still has platform cold-start and availability limits.

Render briefly resumed its prior deployment before the full deployment applied the new settings. A separate stable source snapshot was therefore compared after cutover. There were no added or removed documents and no changed canonical business state. Thirteen existing documents contained only retry counters/times, derived job projections or reporting collector bookkeeping. Four pending termination jobs retained the same exact IDs, targets, status and recorded outcome; no newer provider acknowledgement or cleanup completion was lost. Both source snapshots are preserved, and stale worker leases/counters were not replayed over the live target.

The published Odoo merge preserves the live HTML and styles and replaces the three scripts with the tested R20 payloads. The merged artifact passed 100 frontend VM checks, 15 legacy-call checks, 14 transfer checks and all script syntax checks. The editor trimmed one trailing newline when saving; all script/style payloads matched on read-back.

Old FCM tokens belong to the source project. Each phone must install the new R20 APK, refresh App settings, restart when the project-change notice appears and enroll again using its administrator's code. Re-enrollment, notification permission, real message previews and actual call/audio timings still need to be confirmed on the phones.
