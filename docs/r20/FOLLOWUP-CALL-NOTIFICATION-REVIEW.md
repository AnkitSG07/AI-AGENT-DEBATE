# R20 server follow-up — 2 November 2026

## Observed production failures

Both non-revoked registered phones still reported native build 19. A non-delivering FCM `validate_only` request confirmed `SENDER_ID_MISMATCH` for both tokens in `sh-chat-896e0`. The actual message/call sends returned HTTP 403; message retries repeated approximately every four seconds. These tokens belong to the old project and require R20 installation, configuration refresh/restart and administrator re-enrollment. Installing the APK without obtaining a new-project token cannot complete notification migration.

The sampled incoming call reached the Render webhook 1,148 ms after its provider timestamp; durable webhook processing took 137 ms. Its first notification attempt took 1,157 ms and failed for both phones. No native Answer/Outgoing route timing was present after the migration during this inspection, so these logs cannot establish actual audio latency.

Four old calls also retained failing exact-provider cleanup jobs. Their retries had a permanent 30-second maximum delay and caused ongoing database writes. The records and unconfirmed outcomes must remain durable; a retry must not be presented as a successful disconnect.

## Changes

- Committed Answer/End cancellation notifications run alongside provider cleanup. Browser control-state hints do not wait for the provider acknowledgement. New incoming push retains priority over history projection.
- FCM structured sender-mismatch errors clear only the exact rejected token using compare-and-set. Device authentication remains intact; generic HTTP 403/IAM failures do not erase tokens. Transient/quota failures receive durable bounded retry deadlines, honoring Retry-After and the 60-second quota-error minimum.
- Concurrent duplicate message observations share one operation. Verified successful delivery results are remembered for the remaining message lifetime, so repeated discovery does not reread delivery/device records. Registration/token updates invalidate this bounded process-local optimization; fresh events still perform fresh authorization and durable delivery claims.
- Independent message discovery scans Odoo with a one-second repair cadence, wakes immediately after a successfully forwarded verified message webhook, and does not wait for AI, AI memory or older in-flight notification sends. Idle scans make no Firestore requests. A failed app-unread write retries independently of an already acknowledged push.
- FCM server authorization is warmed at server startup, outside the incoming-call path.
- Failed cleanup of terminal calls retains fast retries for five minutes, then backs off to at most one attempt per hour. Active transfers and newly committed call actions retain their immediate dispatch. Uncertain terminal operations use their real cleanup/lease deadlines instead of perpetually moving a 15-second timer.
- SH Chat AI is disabled by default through `SH_CHAT_AI_ENABLED=false`. AI inference, old-phone enable toggles and delayed Zapier replies are blocked. The AI worker, AI Odoo-memory access, hidden Gemini mode and Zapier forwarding are disabled. Manual messaging, notifications and calling have independent paths.

## Verification and remaining limits

The frozen Node 24 unit, private HTTP and frontend VM run passed **833 checks**, zero failures/skips, with no source changes during the run. New tests include stalled-provider cancellation, independent browser hints, stale cleanup, cross-worker notification backoff, token-refresh races, lost unread writes, duplicate discovery, independent notification work and deployment-disabled AI over real local HTTP.

A 24-hour simulation of one stale failed call cleanup made **34 provider attempts and 253 document writes**; it still reported an unconfirmed End. Seventy-five duplicate callbacks after a successful message delivery produced **zero additional document reads or writes**. These are bounded regression scenarios, not measured project-wide daily totals.

Live daily read/write/delete totals remain unverified: the existing service account received `PERMISSION_DENIED` from Cloud Monitoring, and the connected-browser tool had no originating browser context. No IAM permissions, billing plan or database quota were changed. Firestore Spark has finite daily limits; passing these regressions does not guarantee that all future traffic fits them.

The existing signed R20 APK and published Odoo embed remain compatible with this server follow-up. Two-phone testing after R20 enrollment is still needed to measure actual incoming alert, answer-to-audio, outgoing audio, hangup and transfer timings. No claim of a verified two-second end-to-end cap is made.

References: [FCM error handling](https://firebase.google.com/docs/cloud-messaging/error-codes), [Firestore quota limits](https://firebase.google.com/docs/firestore/quotas).
