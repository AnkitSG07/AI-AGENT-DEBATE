# SH Chat R20 — quota and call-path fixes

The existing Firebase architecture is retained following the user's clarification. A subsequent request asks for a new Firebase project; creation and migration have not completed and no old data has been deleted.

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

815 backend/private-HTTP/VM checks pass with no source changes during the frozen run. The Android clean test execution reported 279 tests across 32 suites with zero failures/errors/skips; lint and device harness compile succeeded. Final APK manifest/Dex identity is separately verified before signing.

Host ICU reproduced the old unsupported regex; the fixed production formatter has no regex dependency. Browser UI execution is not a pass: the available vendor browser crashes before test setup, and the Playwright browser download was unavailable. No actual handset push delivery, live two-phone audio test, 2-second call latency or 5-second transfer latency is established by these local results. Remaining provider and inter-region database latency still requires measurement.

The live Odoo page currently requires sign-in (403 observed), so the tested embed cannot yet be installed through that session. The new Firebase account is signed in and the SH Chat project form is prepared, but accepting Firebase terms requires the user's confirmation. No new project credentials or production cutover have been applied.
