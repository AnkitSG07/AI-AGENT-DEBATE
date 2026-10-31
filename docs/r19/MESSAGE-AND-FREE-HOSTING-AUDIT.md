# R19 message notification and free-hosting audit

The current R18 Render log at 2026-10-31T12:11:45.069Z recorded two message submissions accepted by Firebase, zero failures, and 1,692 ms dispatch time. This does not confirm receipt or display on either handset. Subsequent `already_delivered` records were durable submission deduplication, not handset acknowledgements. R19 renames that outcome `already_submitted`, adds an explicit acceptance count and unconfirmed receipt flag, and logs only a bounded target-build histogram without customer names, text, IDs or tokens.

## Notification correction

The preview-era renderer and its fallback both depended on notification inventory and grouping. Three new fault tests failed against the previous R18 code: grouped-post rejection could leave no notification, inventory failure could break the supposedly safe fallback, and opening/logout cleanup relied on the same inventory API. These are demonstrated code weaknesses, not proof of this phone's exact OEM error.

R19 defaults to a standalone native Android notification showing the actual sender and bounded message text. Group chats use their conversation title with the sender in the text. Expanded text has a separate bare title/text fallback. Posting no longer requires Person, avatar bitmap, launcher shortcuts, manual groups, summaries or notification inventory. Existing blocked/quiet channel and lock-screen privacy settings remain respected.

A local index stores only bounded channel/message IDs and sequence numbers. It preserves exact-chat routing, prevents delayed older messages or taps from replacing/clearing newer alerts, and cancels known message tags at logout without inventory or touching calls. Legacy group summaries are cancelled best effort after a successful post; their cleanup cannot undo a new alert. App-only unread tracking from R18 remains intact. No Odoo embed change is required for R19.

## Free hosting

The existing Oregon service remains on Render Free. The other Free service was observed suspended, and no additional service or paid plan was created. The heartbeat is now every 5 seconds with a 4-second deadline, one outstanding request, bounded response draining, safe self-origin selection, limited fixed-label logs and shutdown cancellation. It starts after listen and never blocks a call action.

This is best effort while the server runs. A stopped process cannot run a self-ping. Render can restart Free services and enforces a shared 750-hour monthly allowance. The five-second interval does not remove measured Oregon-to-Mumbai database latency. The Singapore preflight draft now explicitly uses Free; no regional migration has been activated, and two permanently awake Free instances are not proposed.

## Validation

- 760 backend/HTTP checks passed with no source changes during the final run, including 12 heartbeat tests.
- 261 Android JVM tests passed in 30 suites; the focused notification set covers API26/28/35.
- All five compatibility tests pass, including the three counterexamples that failed against R18.
- Release lint and assembly passed. The physical-device instrumentation harness compiled; it was not run on a phone.
- APK version19, existing release certificate, signature, 16KiB alignment and exact supplied-logo pixels were verified.

No customer messages or test calls were sent. A phone retest is still needed to confirm real FCM receipt/display and real call timings. App settings records the last message push received, posting outcome and message-channel status.

References: https://render.com/docs/free and https://render.com/docs/regions .
