# SH Chat R12 — native call fixes and verification

**Candidate:** `1.0-r12`, Android build `12`  
**Package:** `com.smarthandicrafts.operatorhub`  
**Hub:** https://www.smarthandicrafts.com/livechat-api-test

## Release status

This source contains the R12 Android call fixes. The accompanying APK is an **unsigned release candidate**. Android cannot install it until it is signed. The organization's original signing key is not available in this workspace; no replacement key has been created. The installed R11 package is retained unchanged.

For an in-place update, the original key's certificate SHA-256 must match:

`c1ca4799a7c1ff26ed2e188f3622d6b3b6144450ba656fde6f438629e75c4382`

Do not uninstall the current app to work around a signing mismatch. A correctly signed update with this package identity preserves local device enrollment and Odoo sign-in. A different key cannot update the installed app. The unsigned APK and source have separate integrity records; historical signed-APK verification is not R12 verification.

**Physical phones, real WhatsApp audio, FCM timing and LiveKit transfer continuity have not been tested for this R12 candidate.** Local tests use simulated Android activities/services and injected media/HTTP. The live Odoo embed could not be authenticated during this audit. Historical R11 records are isolated under `verification/baseline-r11` and `docs/README-R11-history.md`.

## Changes

### Immediate local End and durable cleanup

End invalidates the exact attempt, disables local audio transmission, releases the call UI and returns to its source conversation. Slow server cleanup cannot keep the call screen open. The pinned SDK's blocking room release runs on a serialized background disposal queue; a new connection waits for disposal without blocking the UI.

Remote cleanup is persisted before scheduling. An immediate attempt is followed by network-constrained WorkManager retry, so cleanup no longer depends only on the current process. Work queued while another cleanup request is blocked is not stranded. Retries retain the same request key, enrollment, call and original media leg. Offline local release is distinct from confirmed remote termination.

Explicit Decline works when the call screen was opened from the Hub without an FCM record. A stale decline cannot reject a call another phone has answered. End before Android delivers a service-start intent writes a cancellation tombstone so that late start cannot reopen audio.

### Accurate Answer, connection and recovery

Answer gives local feedback, requests the microphone after the user action, then sends the actual authorized call operation without an extra after-tap capability request. The backend still checks enrollment, build, protocol and enabled calling.

Signaling success or a room token does not show Connected. The connected state requires authorized server ownership/readiness and actual media evidence; outgoing customer acceptance remains required. Loss of the exact customer track invalidates old readiness and shows reconnecting. Join and reconnect deadlines run independently of HTTP polling. Silence or a muted microphone does not alone cause a call failure.

Audio focus changes pause local capture/output safely. Fresh evidence is required after reacquisition. Actual audio-route callbacks determine the speaker state; Bluetooth/wired routes take precedence over the phone earpiece, and speaker is explicitly selectable. Microphone control failures are surfaced without falsely showing successful mute.

Uncertain responses reconcile the existing call and original request ID. An outgoing status-only response remains pending instead of failing or redialing. An incoming pending response without a new session ID recovers through its known call ID. Exhausted ambiguous starts queue cleanup instead of leaving an unexplained busy reservation. The R11 exact-customer SDK permission workaround remains covered by a real pinned-SDK serialization test.

### Scoped controls and enrollment changes

End, mute, speaker, transfer, cancel-transfer and delayed transfer selections are bound to the exact client attempt and owner leg. A → B → A retains one customer call ID but creates a new media leg; an old A action cannot terminate the new A leg.

Activity intents, permission results and delayed resume callbacks retain their original enrollment. Re-enrollment cannot reuse an earlier answer authorization. The service checks generation/device again before media or a call request. A normal expiry extension of the same credential still works.

Unregistering stops old local capture even while a status request is blocked. A second incoming call shown while busy has disabled Answer and available Decline. When the existing call ends, the waiting call is rechecked and Answer becomes available without auto-answering or adopting the previous call's snapshot.

### Transfer

The source phone retains audio while the target explicitly accepts and joins. The existing readiness protocol commits ownership only after target transport/media evidence. Brief overlap between the authorized operators is intentional. A target decline or pre-commit failure must preserve the source customer call.

Duplicate transfer taps are coalesced. A lost invitation acknowledgement retries the same invitation key. No new customer call is dialed. Cleanup cannot adopt a later status response's different owner leg. These ownership/retry cases are locally simulated; actual spoken two-phone handoff remains a release gate.

### Native UI, notifications and settings

Android 12 and later use `Notification.CallStyle`, with older-version action fallbacks. Accept opens an Activity; a background receiver never acquires the microphone. Incoming and transfer actions retain call, transfer, attempt, leg and enrollment identity. A visual notification cancellation is distinct from a real terminal alert, so an old alert tombstone cannot abort an explicit Resume.

Answer/Decline/End sit outside the scrolling call content. The 320 × 480 layout at 1.8× system font was rendered with End visible. Buttons have touch feedback and accessible microphone/output state labels. The back control returns to chat while retaining an established call. System theme colors are preserved. This is a simulated Android layout, not a physical-device measurement.

Settings checks the incoming channel's actual importance/sound and links to its settings. Enrollment registers the native build/protocol before advertising call readiness. A Firebase test notification alone does not prove timely incoming-call delivery.

### Hub integration and history security

The packaged bridge retains exact call/attempt/leg IDs, avoids duplicate native starts, and preserves close events while Odoo loads. Browser and native media cannot intentionally start together. Existing Odoo chat, contacts, sales, follow-ups, mail and document workflows stay in the signed-in WebView.

Call history uses a narrow fixed-origin native GET proxy; credentials stay native. Successful history responses require the R12 backend header `X-SH-Call-History: sh-call-history-v1`. An older unmarked response is rejected before its body is read, preventing old raw call payloads from reaching the WebView. Deploy the matching protected R12 backend before enabling this history path. The media protocol remains `sh-room-audio-v1`.

## Verification records

See `NATIVE_CALLS_VERIFICATION.json` for the current build/test result, `verification/r12` for current JUnit/build/render evidence, and `SOURCE_MANIFEST.json` for included file hashes. Baseline R11 signature records are explicitly historical.

The tests cover actual SDK serialization, API response boundaries, cleanup races, blocked status during credential replacement, transfer-back ownership, uncertain response recovery, duplicate invitation retry, permissions/resume changes, notification PendingIntent identity and small-screen control placement. No customer calls, live pushes or production service mutations are performed by these Android tests.

## Physical acceptance test

Use two enrolled operator phones **A** and **B**, plus a separate WhatsApp customer endpoint **C** with a designated internal test contact. Use the same signed R12 build on both phones and record the matching backend commit.

| Scenario | Required observation |
| --- | --- |
| A calls C; C accepts | Exchange and repeat different spoken phrases both ways; accurate Ringing/Joining/Connected; stable for at least two minutes. |
| C calls; A answers foreground, background and locked | Exact call opens, correct permission handling, both audio directions and correct output. |
| A and B answer simultaneously | Exactly one owner wins; the losing phone stops ringing without a competing customer connection. |
| C declines/hangs up during ringing, joining or connected | No false Connected or restored stale state; no stranded microphone. |
| A ends and immediately calls again | Prompt local audio/UI release, no old-attempt revival; verify remote cleanup separately and no persistent false busy state. |
| A transfers to B; B accepts | A keeps C during joining; B/C confirm both audio directions; ownership moves to B and A leaves. |
| Disable A's network after committed transfer | B and C continue at least 60 seconds, proving independence from A. |
| B declines/ignores/loses network/denies microphone before commit | A retains C; no extra dial; an expired invitation cannot later take ownership. |
| Transfer A → B → A, then trigger an old control | Old A controls cannot mutate the new A leg. |
| Wi-Fi/mobile-data change, headset routes, silence, mute, competing audio | Correct output/mute state; bounded reconnecting; silence alone does not fail the call. |
| End/Decline offline, kill/reopen process, restore network | Local audio stays ended; persisted exact cleanup completes without ending another owner's leg. |
| Re-enroll during permission wait or blocked status | Old permission cannot start new media; old capture closes; a fresh authorized action works. |

Record actual notification-to-screen, tap-to-feedback, acceptance-to-two-way-audio and end-to-chat timings. These are measurements to collect, not guarantees established by local tests. Do not include tokens, raw SDP or recorded customer audio in reports.

## Platform limits

Native room audio uses a microphone foreground service. CallStyle does not add Android Telecom/Core-Telecom integration or headset hardware answer/hang-up controls; those remain separate work. Full-screen alerts depend on Android eligibility/settings. Notifications, channel sound/importance, Do Not Disturb, battery restrictions, network availability and manual Force stop affect delivery. Reopen after a manual Force stop.

Odoo's session authorizes embedded business workflows. Firestore-backed native enrollment separately authorizes calls/notifications and survives Render redeployments. Thirty-day lease renewal applies only to a still-valid supported credential; revoked/expired registrations are not silently renewed. This package changes no server log-retention/deletion policy.

## Build and sign

Use JDK 17, Android SDK 35 and the included Gradle 8.11.1 wrapper:

```sh
./gradlew :app:testReleaseUnitTest :app:assembleRelease
```

Output: `app/build/outputs/apk/release/app-release-unsigned.apk`. Keep the original key/password outside the source tree. Use Android build-tools `zipalign`/`apksigner`, then verify the signed APK and original certificate before delivery. Do not place signing passwords on command lines or in source.

Sources include the public Firebase client identifiers, Android resources, Gradle wrapper and tests. They exclude private signing material, service-account private keys, enrollment codes, local SDK paths, build outputs and dependency caches. Public Firebase client configuration is not an Admin credential.
