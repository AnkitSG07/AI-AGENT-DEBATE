# SH Chat R12 independent call review

Review date: 2026-10-29. This is a working review and release coverage record, not a claim of production or physical two-phone verification.

## Scope and evidence levels

The review covers the Android native call entry points, push notifications, permissions, PendingIntents, call ownership, cleanup, media evidence, Hub/native bridge, and the corresponding backend lifecycle. The R11 Android source was restored from the previously delivered source archive. Backend baseline is commit `8b863b7638acfa8c981c67ca536a0c0c83a46b94`. R12 files are being changed by their designated owners, so a confirmed baseline defect remains open here until the replacement and relevant test are independently reviewed.

Evidence labels:

- **Inspected**: source control flow reviewed; no physical execution implied.
- **Automated**: a named local regression or simulation has a recorded passing result.
- **Owner verification pending**: a defect was sent to the implementation owner; the replacement has not yet been independently reviewed.
- **Physical gate**: requires a signed installation on actual phones, with the stated OS/network state.

This review does not authorize or perform live customer calls, messages, notifications, service changes, or production deployment. The Android, backend, and embed owners implement their respective fixes. This reviewer maintains evidence in `work/call-audit-r12`, implemented the new scoped browser-call authorization module/popup, and owns the offline full-embed UI harness. The designated owners retain native, lifecycle, server integration and production embed changes. No live services were changed by this review.

## Confirmed findings

| ID | Finding and reproducible interleaving | Impact | Owner and current status |
| --- | --- | --- | --- |
| A1 | `NativeRoomCleanup.drain()` snapshots saved jobs while `RUNNING=true`. Enqueue B while network request A is blocked; A succeeds with `retry=false`; worker exits without rechecking B. | A persisted End/Decline can remain unsent until another external drain. | **R12 patch independently inspected.** Monotonic dirty drain gate repeats after concurrent enqueue; request-ID settlement cannot remove a newer record. Relevant cases pass in the final 147-test Android release suite; physical behavior remains unverified. |
| A2 | Explicit Decline from a call screen without an active local FCM alert reaches `NativeRoomActionReceiver`, which returns at `roomAlertActive=false`. | UI closes but the customer continues ringing. | **R12 patch independently inspected.** Explicit Activity Decline queues exact call/transfer directly with its captured credential; passive stale notification dismissal remains separately gated. Relevant cases pass in the final 147-test Android release suite; physical behavior remains unverified. |
| A3 | Incoming Activity has `starting=true` during capability/permission work. An exact ended push clears the invitation, but the Activity cancellation guard excludes `starting`. A later permission continuation can start an already ended call. | Stale accept UI/service work after cancellation or answer on another phone. | **R12 patch independently inspected.** Only an exact terminal alert invalidates pending Answer; visual cancel does not consume an old tombstone and break same-owner Resume. Relevant cases pass in the final 147-test Android release suite; physical behavior remains unverified. |
| A4 | Receiver keeps `goAsync()` for 8 seconds, while cleanup can perform GET plus POST with 12-second connect and 15-second read timeouts. Subsequent retries use an in-process handler only. | Saved cleanup is durable as data, but background execution is not durable after process loss. | **R12 patch independently inspected.** Queue commit precedes immediate drain and network-constrained WorkManager APPEND_OR_REPLACE scheduling; credential/call/leg guards survive retries. Actual OS execution remains a physical gate. |
| A5 | Settings sends native protocol/build at enrollment, but the baseline backend registration and token-update bridge do not persist them. Only later native authenticated routes populate capability metadata. | A newly enrolled/backgrounded device can pass a generic push test yet be omitted from native incoming calls until Main resumes. | **Passed — backend owner simulation and SDK emulator.** Enrollment/token update validates and persists native protocol/build before first invitation. Independently reviewed. |
| A6 | Baseline Hub native End only called the in-process call service; no matching service meant no backend cleanup. | Backend can retain an owned call after process/service loss. | **R12 exact-ID cleanup fallback independently inspected.** MainActivity queues durable cleanup if no matching service handles End; final Android marker/control tests pass. |
| A7 | Exact customer track unsubscribe emits `joining`, but service preserves `mediaFresh=true` after earlier evidence and ignores joining in that state. Customer participant departure is ignored. | Connected/audio-active UI may persist when the customer track is absent, especially during status API stalls. | **R12 source independently inspected.** Exact track/participant loss invalidates media freshness; health deadlines run without waiting for HTTP. Final native health cases pass; real media remains a gate. |
| A8 | Enrollment changes while a status HTTP request is in flight. On return or catch, `if (!current()) break` exits polling without `finishLocal`; media callbacks also return early because `current=false`. | **Local microphone/room can be orphaned after credentials change.** | **R12 source independently inspected.** Credential listener and current-identity checks dispose local media before returning; later start continuation also bound to captured enrollment (A12). Relevant cases pass in the final 147-test Android release suite. |
| A9 | Activity controls post an unbound `NativeRoomCallService.command`. A transfer dialog or queued button callback originating on A can run after the current service has become B. | An old control can mute, end, or transfer the newer call. | **R12 source independently inspected; Hub simulations passed.** Activity, notification and transfer controls carry exact attempt/leg; old dialogs and same-call transfer-back controls cannot adopt newer ownership. Relevant cases pass in the final 147-test Android release suite. |
| A10 | Accept/Dial commits on the backend but all response deliveries fail. The startup catch calls `finishLocal` without durable End or outgoing-request cancellation. | App reports failure while the server/customer attempt remains active until timeout. | **R12 source independently inspected; backend simulations passed.** Same-key Accept/Dial retries, exact existing-leg recovery, durable End/request cancellation and late-result reconciliation replace definite-failure assumptions. Native lost-Accept, lost-Dial and repeated-transfer/lost-ACK cases pass. |
| B1 | Native incoming `accept()` commits an owner without enqueuing the ended/ring-dismissal notification used by other paths. | Other registered phones can continue ringing after one phone answers. | **Passed — backend simulation.** First-answer owner commit persists cancellation before slow provider work; two enrolled-device simulation verifies cancellation while provider response is blocked. Physical FCM latency remains unverified. |
| B2 | A new incoming offer with trusted occurrence 89 seconds ago passes an age check, then receives a fresh `now + 90s` deadline. | Late/stale offers can ring beyond their intended provider answer lifetime. | **Passed — backend simulation.** Deadline derives from trusted original occurrence; later push send time cannot extend it. Native physical delayed-push behavior remains unverified. |
| B3 | Pre-media reservation release requires every outbox item, including FCM notify, to be done. Provider/leg cleanup can be complete while notify repeatedly fails. | Device remains busy for notification failure, causing “already in call” after media ended. | **Passed — backend simulation and actual SDK emulator.** Release ignores notification completion but requires confirmed terminal/media settlement, no pending operation and exact reservation identity. |
| B4 | An outgoing provider SDP-answer event can arrive before the dial response binds providerCallId to its local session. Baseline route-less event does not retain the answer for later binding. | Signaling answer can be lost even though the customer accepted. | **Passed — backend simulation and actual SDK emulator.** Typed private immutable pending-answer marker accepts bounded 50KB SDP, binds tenant/number/provider, rejects conflicts and obeys terminal-first behavior. |
| A11 | An Activity rendering active call A receives a new incoming intent for B. Its binding resets but old active controls remain; B has no visible Decline. A first layout fix also kept Accept disabled after A ended. | Stale controls and a waiting call that cannot be accepted without reopening. | **R12 patch independently inspected.** Busy layout explicitly shows B/Decline, hides A controls, and a guarded busyWaiting path revalidates B when A closes without adopting A or auto-answering. Actual Activity/service regression passes in the final native suite. |
| A12 | Enrollment is replaced while Answer waits for permission/resume or while the OS queues service start. The prior flow captures current credential only in Service, allowing an old action under the new identity. | Old notification/user action can initiate work as a replacement device enrollment. | **R12 patch independently inspected.** Screen/start credential remains captured; identity and current validity rechecked; internal service Intent requires exact device/generation. Benign same-identity expiry extension remains valid. Actual Activity/service regression passes in the final native suite. |
| B5 | Operator End acknowledges early cleanup while an outgoing Connect HTTP effect remains in flight. Releasing the reservation before late Connect settles can permit a new call while the old effect remains unresolved. | Premature availability and late provider side effect. | **Passed — backend simulation and actual SDK emulator.** Issued operation remains unresolved through bounded lease; late settlement or crash recovery schedules exact-call compensation before reservation release. |
| B6 | Eligibility sweep reads old session credential bindings, then a newly committed canonical transfer owner. | Healthy new owner can be misclassified as revoked. | **Passed — backend simulation.** Session/canonical snapshot is read coherently; owner leg binding derives from exact committed transfer/history and policy termination rechecks expected identity. Independently reviewed. |

## Requirements and coverage matrix

The complete original-and-follow-up checklist is `ALL_FEATURE_CHECKLIST.md`. This table covers the independently reviewed call boundary. **Inspected** means source review; **passed simulation** means the named executed local suite, not physical end-to-end success.

| Requirement / scenario | Current evidence | Remaining verification or limitation |
| --- | --- | --- |
| Correct customer call entry, real provider IDs and early outgoing reopen | Browser bridge 27 and extracted actual embed 11 passed; exact ID/control paths independently read | Current Odoo/APK publication and real dialing permission/provider outcome |
| Immediate local End and exact same-call/leg isolation | Browser close/transfer-back cases passed; local-first native disposal and captured attempt/leg controls inspected | Final native release tests pass; measured phone microphone/UI release remains |
| Durable End/Decline and no cleanup lost wakeup | WorkManager, persisted request IDs, dirty drain gate and cleanup processor inspected | Drain and simulated process-restart cases pass; OS scheduling and offline recovery on phones remain |
| Decline without a prior FCM record | Explicit Activity path inspected; exact credential/call/transfer preserved | Actual no-FCM Decline simulation passes; real customer ringing termination remains |
| Pending Answer while terminal push/permission/resume/enrollment changes | Terminal-only cancellation, exact start tickets and captured credential/service generation guard inspected | Final credential/terminal/permission and service-start regressions/build pass; physical behavior remains |
| Waiting second call after active call ends | Busy layout and exact waiting-call revalidation inspected; no auto-answer or snapshot adoption | Actual second-intent/busy-close Activity regression passes; physical notification navigation remains |
| One phone answers and others stop ringing | Backend R12 first-owner/notification simulation passed, including stalled provider response | Actual two-phone FCM timing and ring cessation |
| Stale offer/push cannot extend ring lifetime | Trusted-occurrence and push-expiry simulations passed | Real late delivery/duplicate provider events |
| Fresh enrollment immediately joins incoming-device selection | Backend simulation and actual Firestore SDK emulator passed | Live enrollment/project/FCM delivery |
| Lost Accept/Dial/Connect and early SDP order | Backend R12 simulation and SDK emulator passed; one-shot effects/exact late compensation independently reviewed | Native lost-ACK cases pass; real provider/network sequence remains |
| Ended pre-media call releases device despite failed notification | Backend simulation and SDK emulator passed | Physical immediate callback; unresolved media is deliberately retained as busy |
| Connected/timer reflects actual media and track loss clears stale evidence | RTP/PCM/ICE/DTLS + accepted-event contract inspected; native health/track-loss source inspected | Real speech, silence, one-way audio, reconnect and 15–20 second disconnect diagnosis on final app |
| Transfer keeps source until target verified and preserves customer on target failure | Backend protocol simulations passed; transfer binding/terminal invariants independently reviewed | Final native simulations pass; real A→B→A audio handoff and mute/route behavior remain |
| Old owner/control cannot end newer transfer leg | Hub/backend simulations passed; scoped native controls/cleanup read | Native scoped-control/cleanup tests pass; real delayed notifications/actions remain |
| Credentials change during active or pending call | Active media listener/release and screen/start/service guards inspected | Credential/lease/start/service simulations pass; physical revoke/renew/re-enroll remains |
| Notification identity/CallStyle/full-screen fallback | Immutable call/action/enrollment PendingIntents, attempt/leg End and CallStyle source inspected | Physical Android 12–15, user permissions, DND, OEM battery/lock screen |
| Background task removal versus force-stop | FCM service/foreground audio inspected | Physical task-removal/process-reclaim testing; force-stop requires reopen |
| OS audio routes/focus/hardware controls | Route observation and permission source inspected | Real speaker/earpiece/wired/Bluetooth/focus; Core-Telecom, watch/car/hardware answer/hangup not implemented |
| Video | Current engine is audio only | Not implemented; no claim of video support |
| Photos, missed calls, keyboard space, contact info, tags and dark UI | Actual full-embed UI 16 passed with synthetic server data; demo screenshots reviewed | Real Odoo rights/writes, physical mobile safe areas/IME and deployed asset version |

## Executed automated evidence

`browser-verification.json` records the final **124/124 offline browser checks** at embed SHA-256 `e4a501acae8c119dbe181ee4efc7b4815c9927bda7a567a0e7bce2b4900d2e9f`:

| Suite/log | Passed | Scope |
| --- | ---: | --- |
| `ui-r12-tests.tap` | 27 | Native bridge, exact IDs, captured attempt/leg, same-call transfer-back, early outgoing and unrelated tool preservation |
| `embed-r12-tests.tap` | 11 | Actual extracted embed functions, stable native banner, close identity, ringtone and old ringing suppression |
| `hub-ui-r12-tests.tap` | 16 | Actual full HTML/CSS/render/events in offline Chromium, mocked Odoo, demo-only screenshots |
| `transport-r12-tests.tap` | 18 | Exact origin/source/state auth, refresh/logout/reconnect, authenticated fetch-SSE and native history transport |
| `notification-setup-r12-tests.tap` | 10 | Authenticated notification companion setup, private-poll removal, acknowledgement before reset/test |
| `legacy-hub-r12.log` | 15 | Existing browser call lifecycle regressions |
| `frontend-transfer-r12.log` | 14 | Browser transfer compatibility |
| `android-transfer-guard-r12.log` | 13 | Unsafe legacy transfer stays blocked inside native app |

The full UI harness intercepts **all** requests and retains actual production render/state/event code. It proves deterministic DOM/layout behavior under the tested fixtures, including zero DOM churn for 100 unchanged photo/missed-call refreshes. It does not verify Odoo server writes or actual OS keyboard/audio/push behavior. The original R11 bridge reproduced 10 failures in `ui-r11-reproductions.tap`; the final passing pack is a separate later run, not added to a synthetic cumulative coverage score.

Backend owner executed original core 245, R12 lifecycle 43 and reporting 48 local tests. It also executed **5/5** on Node18.20.8, official Firestore SDK8.7.1 and official local emulator1.19.8: competing Answer; large early SDP/lost Dial correlation; FCM-independent release; blocked Connect versus End with compensation; immediate enrollment metadata. No provider/FCM side effects were sent. The final lifecycle/store commit `09118d554c21fd64b044302f821e2eaf4597a051` received an independent narrow no-new-blocker source review.

Native final gate passed **147/147** with zero failures/errors/skips. This reviewer parsed every final JUnit XML under `work/operator-android/app/build/test-results/testReleaseUnitTest` and read `work/android-build/r12-final-release.log`, which ends with successful `testReleaseUnitTest`, lintVital and `assembleRelease`. The owner executed the build; this review did not rerun it. Representative executed cases include:

- `NativeRoomDrainGateTest.enqueueWhileEarlierHttpIsBlockedCannotBeStranded` and `NativeRoomCleanupProcessorTest.transientFailureSurvivesProcessRestartWithSameRequestId`.
- `explicitDeclineNeedsNoFcmRecordAndRejectsOnlyUnownedRing`, `oldAEndCannotEndTheSameCallTransferredBackToANewLeg`, `queuedEndRetainsExactOwnerLegInItsPost`, and `outgoingLostAckCancellationKeepsTheOriginalDialKey`.
- `terminalNotificationWhilePermissionIsOpenCannotStartAudioLater`, `visualCancelDoesNotAbortExplicitResumeBecauseOfAnOldAlertTombstone`, and `differentIncomingIntentResetsOldActiveControlsWithoutEndingTheActiveCall` (also exercises re-enabling waiting B after A closes without auto-answer).
- `permissionResultCannotStartUnderAReplacementEnrollment`, `resumeContinuationCannotStartUnderAReplacementEnrollment`, `delayedAndroidStartCannotUseAReplacementEnrollment`, and `benignLeaseRenewalDuringPermissionPromptRetainsTheAuthorizedStart`.
- `registrationRemovalClosesActualServiceMediaEvenWhileStatusIsBlocked`, `networkFailureAfterCredentialChangeCannotLeaveTheOldMicrophoneOpen`, `oldOwnerStatusAfterAtoBtoAReleasesOldMediaWithoutTerminatingNewLeg`, and `repeatedTransferTapAndLostAckReuseTheSameInvitationKey`.
- `trackLossImmediatelyInvalidatesOldReadiness`, `silenceIsNotAReconnectFailure`, `joinDeadlineRunsWithoutAnyStatusResponse`, and `sdkDisposeDoesNotBlockCallerAndNewRoomWaitsForOldDisposal`.
- Six native history boundary cases include old server/wrong marker refusal before body read, fixed-origin marked GET, mutation denial and bounded response size.

The native 320×480, font-scale1.8 screenshot at `work/operator-android/app/build/reports/r12-native-ui/call-320x480-large-font.png` was independently viewed: Back and End are visible and content scrolls. This is a Robolectric rendering with an example customer, not a phone screenshot. Release APK assembly is **unsigned** until the unavailable original signing key is supplied; installation/upgrade and physical audio are still unverified.

## Authorization and deployment gates

Legacy call/read/control/lock/presence/transfer endpoints previously lacked sufficient authentication; forgeable Origin was not authority. The new scoped capability module derives a short browser credential from the permitted Render profile, binds exact Hub origin/device identity and expiry, keeps credentials out of URLs/storage, and restricts native bearer use on legacy routes to a projected history DTO. Root added authenticated fetch-SSE, expiry-bound streams, subscription ownership enforcement and a native DTO version marker. The auth module passed 22/22 and actual selected server push/SSE handlers passed 20/20 on Node18.20.8; seven handler regressions fail on the selected R11 handler baseline. The baseline deliberately retains the current external auth/ownership modules, isolating server-handler changes rather than testing the whole R11 app. These use real production functions with synthetic storage/clocks, not a whole-app startup or production test. Evidence is `work/backend-audit/operator-call-security-verification.json`; production secret/configuration remains unverified.

**Known broader backend blocker:** source confirmed `/api/zoho-mail/message/:messageId`, `/api/zoho-mail/send` and `/api/zoho-mail/reply` outside the new call/push guard. Their compatible browser/native authorization migration has not been completed by this call patch. Google contacts, documents and AI endpoint families have not been independently exhaustively audited here. Do not infer that they are secure or insecure without that review, or call the whole backend production-ready.

Public read-only deployment recheck (`deployment-read-check.json`) still reports GitHub main `8b863b7638acfa8c981c67ca536a0c0c83a46b94`, Odoo Hub403 without a session and Render version endpoint404. Root added a non-sensitive backend version/protocol handler locally; that is not evidence of deployment or of Odoo/APK version. Signing-key continuity, final APK upgrade and actual Odoo/Render/GitHub release remain open.

## Source reviewed

Android whole-file review at baseline/current checkpoint: `HubMessagingService`, `NativeRoomNotifications`, `NativeRoomActionReceiver`, `CallAlerts`, `CallDismissReceiver`, `IncomingCallActivity`, `NativeRoomCleanup`, `HubApplication`, `NativeApi`, `NativeStore`, `NativeRoomPolicy`, `HubPolicy`, `DeviceLeasePolicy`, `ActiveCallService`, `NativeRoomCallService`, `NativeRoomEngine`, `SettingsActivity`, `NativeRoomCallActivity`, `MainActivity`, `AndroidManifest.xml`, and `app/build.gradle`.

Current R12 bridge/queue review: `sh-native-room-bridge.js`, `sh-call-transfer-guard.js`, `NativeCallCloseQueue.java`, its four test cases, and changed MainActivity native entry/close/capability paths.

Backend whole-file review: native route module, push bridge and media gateway. Targeted lifecycle/store review includes incoming ingestion, accept/dial binding, terminal handling, outbox execution, pre-media reservation release, immutable events, session monotonic checks, size limits and relevant index exemptions. This is not a claim that all unrelated CRM/mail/AI/Odoo workflows were retested.

## Primary platform sources

These documents constrain supported behavior; source inspection and simulations cannot replace physical OS testing.

- Firebase message priority and short message callback lifetime: https://firebase.google.com/docs/cloud-messaging/android-message-priority
- Firebase Android reception: https://firebase.google.com/docs/cloud-messaging/android/receive-messages
- Firebase Android force-stop/reopen precondition: https://firebase.google.com/docs/cloud-messaging/flutter/receive-messages
- Android foreground-service background and while-in-use microphone restrictions: https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start
- Android call notification templates: https://developer.android.com/develop/ui/compose/notifications/call-style
- Android user-controlled notification channels: https://developer.android.com/develop/ui/compose/notifications/channels
- Android per-channel importance/sound API: https://developer.android.com/reference/android/app/NotificationChannel
- Android PendingIntent identity and immutable/update behavior: https://developer.android.com/reference/android/app/PendingIntent
- Android broadcast execution lifetime: https://developer.android.com/reference/android/content/BroadcastReceiver
- Android broadcast background-work guidance: https://developer.android.com/develop/background-work/background-tasks/broadcasts
- Android full-screen intent limits: https://source.android.com/docs/core/permissions/fsi-limits
- Android time-sensitive notification behavior: https://developer.android.com/develop/ui/views/notifications/time-sensitive
- Android Core-Telecom responsibilities and audio-route ownership: https://developer.android.com/develop/connectivity/telecom/voip-app/telecom

Notification timeout was specifically checked against AOSP: timeout cancellation can invoke the notification delete PendingIntent. Therefore this review does **not** classify “no separate Activity expiry timer” alone as a confirmed bug. The confirmed cancellation issue is the Activity's pending-start guard in A3.

## Physical acceptance gates before calling the release verified

Use two enrolled operator phones plus a consenting test customer. Record OS/build, app signature/version, backend revision and network for each run. Do not use customer production conversations for unrequested testing.

1. Incoming to both phones: Answer A; B stops ringing; A has bidirectional audio; End A immediately stops capture/returns chat; customer ends; a new call can start without busy residue.
2. Decline from lock-screen notification, app call screen, and Hub before a push record exists. Repeat with temporary network loss; remote cleanup eventually reconciles without touching another owner.
3. Outgoing: customer accepts, rejects, is busy, does not answer, and answers just as operator ends. Verify early provider event ordering, correct phase/timer, no 15–20 second false-failure, and no delayed call resurrection.
4. Transfer A→B: target accepts/declines/times out; target loses network; source cancels; customer hangs up during readiness; delayed old actions cannot end the surviving owner. Verify speech continuity and source microphone closure, not only UI ownership.
5. Permission and OS states: microphone denied then granted, notification channel disabled, full-screen denied, locked/unlocked, background, task removed, process reclaimed, force-stop/reopen, battery saver/Doze, and notification taps after expiry.
6. Audio/network changes: speaker, earpiece, wired headset, Bluetooth connect/disconnect, cellular interruption, audio focus loss, Wi-Fi↔mobile data and temporary outage. Confirm reconnect presentation and bounded cleanup.
7. Enrollment revoked/cleared/renewed during blocked signaling and active media. Old capture must close; renewal of the same identity must not interrupt a healthy call; no stale job may act under a new identity.

Known release gates outside this reviewer scope: signing-key continuity and the ability to publish/verify the actual Odoo/Render/GitHub assets. No deployment or compatible signed upgrade is claimed by this document.

## Final preservation supplement

After this independent call review, a bounded preservation review exercised actual attachment, template, customer-link and AI functions. The final 34 tests pass; the full browser124 pack was rerun successfully against the final embed hash above. See PRESERVATION_REVIEW.md and preservation-verification.json. This supplement does not extend the independent native review to live Odoo, mailbox or AI operations.
