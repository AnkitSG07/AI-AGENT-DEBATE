# SH Chat R11 — update and call verification

**Release:** 1.0-r11, Android build 11  
**Package:** `com.smarthandicrafts.operatorhub`  
**Hub:** https://www.smarthandicrafts.com/livechat-api-test

## Install over the existing app

Install **SH-Chat-1.0-r11.apk** on both operator phones as an update. It uses the same package and signing certificate as R10. **Do not uninstall the existing app or clear its storage:** an in-place update preserves the local Odoo sign-in, enrolled device identity and saved registration. An expired or administrator-revoked registration still needs a fresh enrollment; the update does not bypass that restriction.

Open the updated app and check **App settings** shows **1.0-r11**. Allow microphone access when starting or accepting a call, Android notifications, and Bluetooth permission when using a headset. Review Android's incoming-call/full-screen notification setting where available. Compatible Google Play services and Android System WebView remain required; minimum supported Android version is Android 8.

If the app requests Odoo sign-in, use the normal Odoo fields. The Odoo website session authorizes chat/customer/sales work. Native device enrollment independently authorizes the notification and calling backend. This package contains no enrollment codes.

## What R11 fixes

### Audio setup stopped before the microphone was published

The pinned LiveKit Android 2.29.2 SDK was given a customer identity and a null optional participant SID. Its serializer passed that null into a protobuf string setter, causing a reproducible exception before microphone publication. The app then closed its audio connection and requested customer-call cleanup.

R11 supplies the unused SID as an empty string. The exact customer identity restriction remains in place; permission is not expanded to all participants. A regression test invokes the actual pinned SDK serializer, reproduces the old crash and verifies the corrected wire message.

### Outgoing calls stayed on “Preparing secure audio”

The first outgoing update has no server call ID. The screen previously lost its binding when the server assigned that ID, so later connection and end events were ignored. R11 gives each start a client attempt ID before the service begins and retains it through the canonical call ID and terminal state. Reopening the preparing-call notification follows the same attempt. Unrelated or stale updates cannot take over the screen.

### Old asynchronous actions could affect a newly opened call

Call start, permission results and delayed activity-resume callbacks are bound to a single-use authorization ticket. A new intent, decline or activity destruction invalidates the previous ticket. An older Android permission prompt cannot authorize a different call, and a callback can start its service only once.

### Duplicate setup checks added avoidable delay

The activity and foreground service now reuse a successful authenticated capability check for up to 15 seconds. This cache is tied to the exact native device, bearer and enrollment generation. The server still authorizes every actual call operation. Transient failures do not turn expired checks into fresh authorization.

### Setup failures were hidden

An audio setup failure now returns to chat with an explanatory toast. **App settings → Last call audio problem** retains a safe stage/error code and timestamp for troubleshooting. Raw SDK exception messages, room tokens, SDP and customer details are not retained in that diagnostic. The next successfully established call clears the old problem.

## What has and has not been verified

The Android release compilation, complete unit suite, actual SDK serialization regression, APK signature and signing-certificate match are recorded in **SH-Chat-r11-apk-verification.json** and the source archive's **NATIVE_CALLS_VERIFICATION.json**. The source archive includes the JUnit results and build/signature records.

**Real-phone audio has not yet been retested on R11.** The R10 failures were reported from actual phones; the R11 fixes were reproduced and verified locally against the SDK and application policies. A successful build or backend setup check does not establish two-way audio, background delivery timing, Bluetooth behavior or transfer continuity.

The Android update removes an after-tap capability round trip. It does not guarantee an incoming notification will arrive within a fixed number of seconds. The backend/FCM path and phone power/network settings need the separate live timing test below. Backend deployment details are provided with the deployment report; this archive records the Android build.

The Odoo Hub was previously verified with published build `2026.10.29-ui-r10`. R11 preserves that Hub integration and its narrow compatibility bridge for the observed R8/R9 controls. Existing chat, contact, quotation, follow-up, mail and document workflows continue in the signed-in Odoo website.

## Verify calls before normal use

Use two enrolled operator phones **A** and **B**, plus a separate actual WhatsApp customer endpoint **C**. Use a designated internal test contact. Both operator phones should run this exact R11 APK. Customer calling permission still applies to outbound WhatsApp calls.

| Test | Required observation |
| --- | --- |
| A calls C; C accepts | A and C exchange and repeat a phrase in both directions. The call remains usable beyond two minutes. Ringing/Joining changes to Connected only after the actual media and server readiness conditions. |
| C calls the business; A accepts | The exact incoming call opens. Confirm both directions of audio and a stable connected timer. |
| C declines or hangs up | The UI leaves ringing/connected appropriately and does not restore an older state. |
| A ends and immediately calls C again | Local microphone/audio stops promptly and the app returns to the source chat. The next call does not falsely report “already in call”. Remote cleanup confirmation is checked separately. |
| A transfers to B; B accepts | A stays with C while B joins. Brief overlap between the two authorized operators is expected. B and C confirm two-way audio; ownership then moves to B and A returns to chat. |
| Switch off A's network after completed transfer | B and C keep speaking for at least 60 seconds. This verifies B is independent of the source phone. |
| B declines, ignores the invitation, loses connectivity or denies microphone permission before transfer commits | A keeps the customer call. No second customer call is dialed, and a stale invitation cannot later take ownership. |
| C hangs up during answer or transfer | Terminal state wins over late requests, notifications and media callbacks. |
| Repeat with a locked/backgrounded phone, Wi-Fi/mobile data and Bluetooth | Record actual notification, acceptance-to-audio, audio route and end-to-chat behavior on each device. |

Record app/server versions, device labels, network conditions, timestamps, call/transfer identifiers and outcomes. Include the safe App settings error code if a setup fails. Do not include access tokens, native bearers, raw SDP or recorded customer audio in the report.

## Registration and notification checks

Existing Firestore-backed device identities remain independent of Render redeployments. The 30-day native lease renews near expiry when supported and while still valid. A revoked or expired device is not silently re-enrolled. The app keeps a valid credential during transient server/storage failures.

Use **Send Firebase test notification** in App settings and confirm the matching test actually reaches that phone. Server acceptance alone does not prove delivery. Android notification permission, Do Not Disturb, battery restrictions, network access and a manual Force stop can affect delivery. After a manual Force stop, reopen the app.

Keep durable device identity, revocation and enrollment records separate from any call-log retention/export job. This Android package does not enable log deletion or change server retention settings.

## Build from source

Use JDK 17, Android SDK 35 and the included Gradle 8.11.1 wrapper. Configure your own SDK path in `local.properties` or the Android development environment, then run:

```sh
./gradlew :app:testReleaseUnitTest :app:assembleRelease
```

The build output is unsigned until signed with the organization's retained key. Keep the key and password outside the source tree. A different signing key cannot update the installed app in place.

The archive includes Android sources, resources, tests, wrapper and verification records. It retains the public Firebase client identifiers required by the app. It excludes signing keys/passwords, Firebase service-account private keys, server secrets, enrollment codes, local SDK paths, build outputs and caches. Historical R9/R10 notes are labelled as history; this guide describes the R11 release.

## Package integrity

- APK SHA-256: `30d6eef46dcb4553d9b7f9792af6e8f15c76b3ede8d4e8c1d7841154c3b7f5a4`
- Signing certificate SHA-256: `c1ca4799a7c1ff26ed2e188f3622d6b3b6144450ba656fde6f438629e75c4382`
- Version: `1.0-r11` / build `11`.
- Complete Android unit suite: **87 passed, 0 failures**.
- APK signature, same-certificate update compatibility and 16 KiB ZIP alignment: verified locally.
- Real-phone R11 audio, transfer and notification-timing retests: **pending**.
