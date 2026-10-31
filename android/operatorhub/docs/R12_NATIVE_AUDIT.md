# R12 native call audit record

## Scope and evidence boundary

The R11 source archive and signed APK were restored and verified before editing. The native audio/call lifecycle, settings/enrollment, background notification controls and cleanup code were inspected together with the pinned LiveKit 2.29.2 and AudioSwitch implementations. The independent reviewer checked the ownership, cleanup, notification and permission/resume deltas. Root reviewed and changed the WebView bridge and corresponding assets separately.

The final release unit run executed **147 tests with zero failures, errors or skips**. The unsigned release build and Android release vital-lint gate passed. The tests are local simulations and SDK/component tests; they do not establish physical audio, actual background delivery, carrier behavior or real call-transfer continuity.

## Source inventory

| Component | Reviewed files | Relevant change or retained invariant |
| --- | --- | --- |
| Audio transport and disposal | `NativeRoomEngine.kt`, `NativeRoomMedia.kt`, `NativeRoomDisposal.kt`, `NativeRoomAudioSetup.java` | Actual customer-only audio; SDK null-SID workaround retained; concurrent bounded RTC stats; customer media loss; real route/focus state; nonblocking SDK release. |
| Native lifecycle and readiness | `NativeRoomCallService.kt`, `NativeRoomCallHealth.java`, `NativeRoomPolicy.java` | Exact attempt/leg, credential revocation release, independent join/reconnect watchdog, pending/uncertain operation recovery, no duplicate dial/accept, truthful Connected. |
| Call screen and action authorization | `NativeRoomCallActivity.java`, `NativeRoomStartGate.java`, `NativeRoomUiBinding.java`, `NativeRoomControl.java`, `NativeUi.java`, `ic_call_back.xml` | Scoped commands; immediate local close; permission/resume/enrollment races; incoming busy state and release; anchored primary controls; accessible button state and feedback. |
| Durable cleanup | `NativeRoomCleanup.java`, `NativeRoomCleanupProcessor.java`, `NativeRoomDrainGate.java`, `NativeRoomCleanupWorker.java` | Persisted exact intent; lost-wakeup protection; same request key; WorkManager retry; ownership/leg reconciliation; old credentials cannot act through a new enrollment. |
| Notifications and platform entry | `NativeRoomNotifications.java`, `NativeRoomActionReceiver.java`, `CallAlerts.java`, `HubMessagingService.java`, `AndroidManifest.xml` | CallStyle with fallback; distinct call/transfer/action identity; no background mic acquisition; terminal versus visual cancellation; notification generation guard. |
| Device identity and startup | `NativeStore.java`, `DeviceLeasePolicy.java`, `NativeRoomCapabilities.java`, `NativeRoomCapabilityCache.java`, `HubApplication.java`, `SettingsActivity.java` | Enrollment/protocol readiness; same-identity lease renewal; captured credential checks; channel settings diagnostics; no after-tap capability round trip. |
| Fixed API boundary | `NativeApi.java`, `NativeRoomJson.java` | Bounded JSON, no redirects, shorter control/status reads, actual JSON-null normalization, successful history marker required before reading body. |
| Legacy media coexistence | `ActiveCallService.java`, `IncomingCallActivity.java`, `CallDismissReceiver.java` | Existing legacy mode retained; overlapping native/browser audio guarded; old browser controls are handled by the protected backend/bridge. |
| Team-reviewed Hub integration | `MainActivity.java`, `HubPageStyle.java`, `HubLaunchState.java`, `NativeCallCloseQueue.java`, `NativeHubReadPolicy.java`, packaged JS/CSS | Fixed-origin authenticated history proxy; close-event queue; exact attempt/leg controls; native capability routing and repeated-tap handling; root's separate browser/DOM verification. |

Business workflow code remains the existing embedded Odoo UI. This native audit does not certify all Odoo mail, sales, documents or AI workflows, nor replace authenticated validation of the currently deployed Odoo embed.

## Executed regression coverage

| Test suite | Cases | Scope |
| --- | ---: | --- |
| `NativeRoomLifecycleRegressionTest` | 9 | Actual simulated service, blocked status plus unregister/reenroll, old commands, cancelled queued start, transferred-back owner leg, status-only outgoing recovery, incoming pending response, repeated transfer/lost ACK, stale enrollment at service entry. |
| `NativeRoomPlatformUiTest` | 9 | Actual simulated Activity/notifications, 320×480 font1.8 render, CallStyle/PendingIntent leg identity, terminal while permission waits, visual cancellation/Resume, exact-chat return, busy incoming switch/release, replacement enrollment during permission/resume, benign lease renewal. |
| `NativeRoomCleanupProcessorTest` | 14 | Explicit Decline, real JSON null, owner and media-leg changes, credential replacement, retry/process-restart semantics, stable outgoing cancellation, transferred target cleanup, stale 401 and bounded retention. |
| `NativeApiHistoryBoundaryTest` | 6 | Fake HTTPS connection exercising actual request implementation: absent/wrong marker rejected before body, allowed fixed origin, no redirects, bearer handling, rejected paths, 512KiB bound and real 401 propagation. |
| `NativeRoomCallHealthTest` | 5 | Server/media joint readiness, media loss, silence, independent deadlines and focus state. |
| `NativeRoomControlTest` | 4 | Scoped attempt/leg matching and pending-answer terminal rules. |
| `NativeRoomDrainGateTest` | 3 | Work enqueued during a blocked pass, release-boundary wakeup and coalescing. |
| `NativeRoomDisposalTest` | 1 | Blocking disposal moved off caller thread; the next room waits for the serialized disposal barrier. |
| Existing SDK, policies, UI binding, start tickets, leases, Hub policies plus root close/history rules | 96 | Preserved suite plus new root-owned exact-close queue/history-path policy checks. |

Sum: **147**. Tests use injected media/HTTP or local SDK/protobuf code. Synthetic test credentials and phone values are fixtures. No production customer communication is invoked.

## Build checks

- Android release compilation, complete release unit suite and release vital lint: passed.
- APK package: `com.smarthandicrafts.operatorhub`, version `1.0-r12` / code `12`.
- Minimum SDK 26, target/compile SDK 35; JDK17 and Gradle8.11.1.
- APK ZIP alignment checked with Android build-tools35 `zipalign -c -P 16 4`.
- APK signing check deliberately fails because the candidate is unsigned. This is not an installable update until signed with the original key.
- Restored R11 signature reverified independently as the original update identity; that does not sign R12.
- The generated small-screen render was visually inspected. No emulator/phone full-system audio was used.

## Gates still open

1. Original signing key recovery and final signed-package certificate verification.
2. Matching protected R12 backend rollout and authenticated deployed Hub check.
3. Two operator phones plus a separate WhatsApp customer endpoint: both directions of audio, competing answers, remote/local End, immediate redial and audio transfer with source phone offline after commit.
4. Measured FCM/background/locked timing; Wi-Fi/mobile-data changes; Bluetooth/wired/earpiece routes; competing cellular audio; real device screen/insets/large-font checks.
5. Telecom/Core-Telecom integration and headset hardware Answer/End are not implemented. CallStyle is not proof of those features.

No fixed millisecond latency guarantee, “all calls work” claim, or physical handoff verification is inferred from this record.
