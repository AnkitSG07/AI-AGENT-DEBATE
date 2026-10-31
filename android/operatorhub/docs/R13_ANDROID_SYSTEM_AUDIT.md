# R13 Android system audit

## Scope and identities

The production application remains `com.smarthandicrafts.operatorhub`, version code 13, version name `1.0-r13`. Its release APK remains unsigned because the original signing key is unavailable. The required original certificate SHA-256 is `c1ca4799a7c1ff26ed2e188f3622d6b3b6144450ba656fde6f438629e75c4382`.

The instrumented simulator uses the distinct package `com.smarthandicrafts.operatorhub.simulation`. Its test package is `com.smarthandicrafts.operatorhub.simulation.test`. They use a local Android debug certificate, cannot update the production app, and do not reuse operator enrollment or Odoo cookies. The fixture Activity, synthetic HTTP responders and profile credentials exist only in debug/androidTest source sets. Release APK contents are inspected separately to confirm their exclusion.

## Changes found through review

The protected mail, Google Contacts, Documents and AI integrations require a fresh operator profile capability. Native enrollment is intentionally insufficient for those business records. The Android WebView previously did not create the popup required by the browser's source-checked `postMessage` handshake. R13 adds an isolated child WebView opened only from a trusted Hub page and an actual user gesture.

The child accepts the exact Render authentication page with an exact Odoo origin and a bounded random state. Its only remote requests are that page and the two same-origin profile login/token POST routes. It has no `SHNative` bridge, JavaScript interface, file/content access, third-party cookie access, camera/microphone grants, nested popup or arbitrary redirect path. The captured parent generation must remain current. Parent navigation, Activity destruction, explicit close, TLS failure, main-page failure and renderer loss dispose of the child. The native device credential never enters JavaScript.

Two additional cross-feature regressions were found before release freeze. Quotation creation opens `about:blank` during a user tap, waits for Odoo to create the draft, then navigates the saved window. Destroying the initial placeholder loses this workflow. The child now keeps only an initial inert `about:blank` before an accepted auth navigation; the later Odoo destination returns through the main Activity's normal trusted navigation. Auth redirects cannot use this exception after the auth page loads.

Signed Document Center view/download links also target a new window. A broad Render-origin exclusion previously dropped these user actions. A separate narrow policy allows only HTTPS signed `shd1` document links with a numeric document ID and exactly one `share` parameter. These links are not accepted as auth content or native-proxied JSON requests. The backend still verifies their signature, record, action and expiration.

The existing Firebase service's delivered-data handler is factored into a package-private method so instrumentation can exercise the real notification and PendingIntent implementation without exporting an injection receiver. Real FCM transport is outside that method's test scope.

The first executed API 35 suite exposed five missing incoming notifications when full-screen special access was denied. `NativeRoomNotifications` had removed the full-screen PendingIntent while using incoming CallStyle before a foreground service existed. The correction keeps the immutable intent and lets Android enforce denied access with its heads-up fallback. Call identity, transfer, enrollment generation, private visibility and Answer/Decline behavior remain bound to the original notification. The test deliberately keeps special access denied. See the official [full-screen intent permission behavior](https://source.android.com/docs/core/permissions/fsi-limits) and [notification manager documentation](https://developer.android.com/reference/androidx/core/app/NotificationManagerCompat#canUseFullScreenIntent()).

## Explicit call-permission workflow

The native dialer exposes separate Request call permission and Check permission actions. Both bind their asynchronous result to the selected number, current Activity generation and enrolled device credential generation. A stable request ID is saved before dispatch and survives recreation. A sent provider message is not customer permission. A lost acknowledgement stays uncertain, disables repeat sending and requires Check; there is no automatic resend or call. New request IDs are created only for a later explicit eligible request. Temporary permissions show their expiry and are rechecked against local time before Call; provider status remains authoritative. Recognized blocked-window responses explain that the customer must message first. Contradictory or malformed flags fail closed. This implements the explicit Request/Check workflow; it does not claim a fresh provider preflight for every future use of a previously checked permanent grant.

The final build adds 19 focused JVM cases across NativeCallPermissionStateTest and NativeCallPermissionUiTest. They cover exact number/request matching, strict booleans/statuses, sent-versus-consent, expiry, stable IDs across recreation, enrollment changes, explicit-action behavior and known blocked outcomes. No tests contact Meta or send a real customer message.

## Unit and build checks

The final release-variant suite passed 205 tests across 23 suites with zero failures, errors or skips. It covers the retained R12 behaviors, auth/document boundaries, waiting-call Activity/service scenarios, muted-customer and lifecycle regressions, and the denied-full-screen incoming notification regression. All 107 tracked Android build inputs were hashed before and after the successful build and match the current source. The new regression was first run with the old conditional in an isolated copy: it failed on the removed full-screen PendingIntent. It passes with the correction. The auth/document cases cover exact origin/path/nonce, authority confusion, traversal/fragment aliases, malformed/duplicate/extra query parameters, exact POST resource boundaries, signed document navigation and rejection of JSON API/unsigned access.

Current machine-readable build, test, APK and source hashes are in `NATIVE_CALLS_VERIFICATION.json` and `SOURCE_MANIFEST.json`. Fresh XML, raw APK inspections and the successful build log are under `../../../verification/recovery-current/android`; `build-current.json` contains portable evidence paths and hashes. Earlier `verification/r13` records remain historical. The simulator runner is `run-system-simulation.sh`.

## Android system test design

The 12 instrumented scenarios use actual Android OS notification objects, PendingIntents, Activities, permissions and WebView. Their remote provider replies and already-delivered FCM data are synthetic. They cover CallStyle action creation, Decline's durable exact-call cleanup, dismissal without rejection, terminal-before-incoming ordering, invalid/expired envelopes, stale enrollment action rejection, Answer routing and termination during a real microphone permission prompt, MessagingStyle deduplication, the actual popup opener handshake, refusal of a popup without a user gesture, asynchronous blank-window quotation navigation, and visible portrait End controls.

The runner first verifies Android 15/API 35 and QEMU. It clears only the separate simulator package, blocks emulator HTTP through a closed local proxy, leaves microphone permission denied, grants notification permission, and disables full-screen interruption so foreground PendingIntent tests are deterministic. This suite must not be run against an operator's physical phone. Its outcome is recorded explicitly; compiled instrumentation is not treated as executed instrumentation.

## Actual local emulator execution

There is no accessible `/dev/kvm` in this environment. The final attempt used the retained Android 15/API 35 AOSP x86_64 image, two virtual CPUs and a 320 by 640 display at 160 dpi. The emulator automatically raised the requested 1536 MiB guest RAM to **2560 MiB**; the lower request did not reduce its actual guest memory. Gradle and the emulator ran sequentially under an **8 GiB shared cgroup limit**. Large unrelated RAM-backed files remained outside this task's control.

The final build first completed with no emulator running. Its Gradle cache was archived with every file checksum verified, and only reproducible task-owned caches/intermediates were reclaimed afterward. APKs, source, 23 JUnit reports and audits were preserved. No compatibility, storage, permission, assertion or timing gate was bypassed.

Both final simulation APKs installed and AOT-compiled successfully. The first final-source instrumentation attempt was killed by Android for a process-start ANR before JUnit; com.android.phone also had a startup ANR. Host OOM counters did not change during that attempt. It is preserved under `completion/system-final` with **zero completed cases**. A cold simulation UI display later took about 32 seconds; a subsequent warm launch returned Status: ok with a 250 ms Android WaitTime. Those are observations of this software emulator, not physical-device performance guarantees.

The single authorized retry reused the identical installed/AOT APKs, original test assertions and original deadlines. It reached JUnit and completed **six of twelve cases: four passed and two failed**. While case seven was active, host cgroup counters rose from **oom=11 / oom_kill=3** to **oom=12 / oom_kill=4**, and emulator PID 240302 disappeared. The kernel's exact victim record was unavailable, so the evidence records the coincident OOM and emulator loss without claiming a captured kernel attribution. Six OS cases remain incomplete. Final logcat collection failed because the device was gone; raw instrumentation statuses survive under `completion/system-final-retry`.

| Final-source case | Observed outcome |
|---|---|
| Terminal-before-incoming cannot resurrect notification | Passed |
| Expired or misdirected envelopes do not ring | Passed |
| Private conversation notification and deduplication | Passed |
| Incoming CallStyle with real Answer/Decline PendingIntents and denied full-screen access | Passed |
| Answer routing and terminal event during permission prompt | Failed in AndroidX ActivityScenario.close: current Activity state unexpectedly null, last stage STARTED |
| Real WebView popup opener handshake | Failed before fixture main-page start: progress 10, no page callbacks or intercepted requests by the original deadline |
| Decline, dismissal, old-enrollment action, non-gesture popup, delayed quotation and portrait End controls | Incomplete in this final-source retry |

Inspection of both failure traces and the corresponding source did not demonstrate a specific production exception or a safe code change that would resolve the failure. The cleanup exception is within AndroidX test lifecycle code; the WebView assertion fails before an auth handshake exists. Both remain failed instrumented outcomes and need reproduction on an adequately resourced accelerated runner. Neither is silently waived or counted as a pass.

The two actual NativeRoomEngine/LiveKit instrumentation cases were **not started**. After emulator loss, baseline nonreclaimable host memory was approximately 4.23 GB, with another observed 3.5–4 GB required by the software emulator before adding the local SFU/Chromium fixture. Restarting the same workload would not provide a safe reserve. The 205 JVM cases, release lint, assemblies and final APK identities remain valid; the interrupted OS run is not aggregated as a passing twelve-case suite.

Historical five-pass/seven-failure and eight-pass/four-failure OS attempts remain separately labeled. They are not substituted for final-source execution. The older shared-disk failure is also retained with its `No space left on device` traces; none of those failed records are counted as current passing tests.

## Concrete verification continuation

Use the existing `.github/workflows/sh-chat-r13-verify.yml` Android job on a runner with working hardware virtualization and measured memory/disk headroom. It prepares the local test CA and media tooling, builds before starting the API 35 emulator, then runs the unchanged `run-system-simulation.sh` and `run-native-media-simulation.sh`. Confirm usable `/dev/kvm` and emulator acceleration instead of assuming a requested setting was applied. Keep the build and emulator phases sequential. If the OS suite fails again, preserve its failure and run the native suite separately on a clean isolated emulator so it receives an independent outcome. Do not expand deadlines, disable Android gates or label compilation as execution.

The continuation is local-source ready but has not been published or dispatched by this Android task. Original production signing and physical-device acceptance remain separate requirements.

## Remaining production gates

Core-Telecom integration and remote headset/watch/car Answer/End callbacks are not implemented in this candidate. CallStyle notifications and selectable audio routes do not establish that requested capability.

A local OS or browser simulator does not establish real Meta WhatsApp signaling, FCM delivery delay, a locked physical phone's full-screen eligibility, real microphone/speaker/Bluetooth routing, cellular network transitions, customer audio quality, or spoken two-phone handoff. The backend media simulator has its own evidence and must not be described as the native Android media engine. The native engine keeps its strict production LiveKit Cloud URL policy; this audit does not relax it for a local simulator.

The release APK needs the original key and an original-certificate verification before it can update installed devices. Physical acceptance remains required on two enrolled phones and a designated internal WhatsApp test endpoint, using the matching backend and Hub revision. Do not uninstall the production app or replace its signing identity to work around a missing key. See `docs/README-R12-history.md` for the retained detailed call/transfer physical acceptance matrix.

## Latest build evidence

The final production candidate SHA-256 is `2196a8427237d889774f92d3622c5887f7fd85913ca1991ebd485a9ebd0deade`. `aapt` confirms the unchanged production package, version code 13, version name `1.0-r13` and non-debuggable manifest. Android `apksigner` correctly rejects the unsigned production candidate; both separate simulation APKs pass signature verification. All three pass 16 KiB ZIP alignment. All six inspected arm64-v8a and x86_64 ELF libraries also have compatible PT_LOAD segment alignment; this structural inspection is not a 16 KiB runtime execution claim. The production APK excludes the simulator Activity, instrumentation classes, fixture assets, test CA and local fixture hostname.

The browser bridge suite passed 27 cases earlier in this continuation and its runtime source is unchanged. Its count belongs to the browser suite, separately from the 205 JVM cases and the 12 OS plus two native SDK instrumentation cases. Native media uses a microphone track carrying simulator silence and a generated customer tone; it does not establish spoken-call quality on physical hardware.
