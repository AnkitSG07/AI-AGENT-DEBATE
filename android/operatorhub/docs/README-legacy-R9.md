# SH Chat — Smart Handicrafts Android R9

Native Android application package: `com.smarthandicrafts.operatorhub`.

The app hosts the existing authenticated Odoo Hub at `https://www.smarthandicrafts.com/livechat-api-test`. It adds native Firebase push reception, notification permission/settings, incoming-call alerts, file selection and an origin-restricted native bridge. It does not replace the Hub's WebRTC audio engine with a native engine.

## R9 startup and call safety

Version `1.0-r9` (code `9`) opens the real same-origin Odoo login URL with the Hub as its redirect. An existing Odoo WebView session can redirect straight to the Hub; a fresh install receives the real Odoo form. The packaged stylesheet gives that form SH Chat light/dark branding without reading credentials, replacing its fields, changing its action, or intercepting submission. Password errors, reset links and Odoo verification routes remain part of the original form.

A native loading cover stays above the WebView until the composed presentation/compatibility script is installed, the main document has finished and the styled login or authenticated Hub is ready to draw. Document-start injection is used when available, with a covered page-finished fallback. Stale callbacks cannot reveal a later navigation. Network failures, denied-page responses and a renderer crash have bounded recovery controls; an account without Hub permission is not sent through an endless login loop.

The packaged `sh-call-transfer-guard.js` protects this upgraded app even when the server still serves the R8 embed. It prevents the unsupported second-accept transfer path before the original Hub can acquire a target microphone or move ownership. Transfer is explicitly unavailable. This is a safety repair, **not an implementation of independent device-to-device audio transfer**. Older browser sessions and APKs need their own upgrade or the backend guard. A supported media handoff or stable server media bridge remains necessary.

Android Back and same-origin full-page links no longer unload an active call. Same-document navigation stays available; external links open outside the active WebView.

## Build

- Java 17, Android SDK 35, Android Build Tools 35.
- Android Gradle Plugin 8.9.2, Gradle 8.11.1.
- Minimum Android API 26 (Android 8); target/compile API 35.
- `./gradlew :app:assembleRelease :app:testReleaseUnitTest :app:lintRelease`
- Sign the release APK with the operator organization's retained signing key. Subsequent updates must use the same package name and signing key.

The **SH Chat** Android app is already registered in Firebase project **`smart-handicrafts`** with app ID `1:467493355898:android:d08efaaaa884eaa86196c3` and package `com.smarthandicrafts.operatorhub`. Reuse this registered app; do not create another one. FirebaseInitProvider initializes it from the bundled public identifiers in `res/values/google_services.xml`. The Google Services Gradle plugin is not required. Server service-account credentials are not included in the app.

Firebase Messaging auto-init starts disabled in the manifest. A successful backend-configuration check in App settings enables it and requests an FCM token, which can happen before native staff enrollment. Saved configuration can reinitialize messaging on a later cold start. The backend sender and a valid per-device enrollment are still required before background alerts are ready; possession of a Firebase token alone does not authorize alerts. Backend Firebase application ID is checked against the running app ID. A deliberate app/project migration requires a restart and new enrollment.

## Deployment dependencies

1. The deployed Hub must contain the R8-or-later authenticated ready/call-state bridge. The R9 APK is compatible with the existing R8 deployment.
2. The R8-or-later Render native-notification routes and Firebase sender must remain configured. Installing this APK does not require a Render restart.
3. Install the APK on Android 8 or later with compatible Google Play services, a working Android System WebView and network access. Sign in to Odoo, open App settings, allow notifications, and enroll using the administrator's one-time code. A code generated from 32 random bytes as base64url (43 characters) fits both app and server validation.
4. Enable the Android incoming-call screen permission if desired and supported.
5. Use **Send Firebase test notification**. An HTTP acknowledgement is only a send acknowledgement. The UI confirms delivery only when FirebaseMessagingService receives the matching test ID on this phone.

Native device bearers expire after 30 days; a fresh administrator enrollment code is required after expiry. Server enrollment storage must be retained across deployments. The supplied file-backed backend supports one process; multiple replicas require a shared transactional store. See the backend setup guide for the complete environment and restricted FCM sender-role requirements.

## Native protocol

The backend is fixed at `https://ai-agent-debate.onrender.com/api/operator-android`:

- GET `/config`: public enabled state and FirebaseOptions.
- POST `/devices/register`: one-time code, installation identifier, FCM token and device label.
- POST `/devices/token`: bearer-authenticated token renewal.
- POST `/devices/unregister`: bearer-authenticated device removal.
- POST `/devices/test`: bearer-authenticated test push request.
- GET `/calls/:callId`: bearer-authenticated exact-call status check.

Odoo session cookies are not used as native backend credentials. Device bearer credentials are stored in private native preferences, excluded from backup/device transfer, and never sent to the WebView. This token permits the registered operator device's alerts and call-status lookup; it does not sign the user into Odoo.

Push types:

- `sh_operator_call`: incoming/ended, exact call ID, short expiry, fixed Hub URL; no caller body, phone or SDP. The supplied backend sends a 30-second expiry; the app's validation rejects expiry windows longer than two minutes. Before the initial alert the app checks local expiry and terminal/dismissal records; current server state is rechecked in the incoming activity and before opening the call. End events stop the matching incoming alert and do not terminate an established WebRTC call.
- `sh_operator_message`: Odoo channel/message identifiers and five-minute expiry; generic notification without customer content. Tap opens the exact conversation.
- `sh_operator_test`: unique test ID and short expiry. Matching receipt is recorded locally.

The native call notification and full-screen activity offer **Open call** and **Dismiss**. Dismiss silences this phone; it does not reject the customer. Accept/Reject/End stay inside the Hub. The app deliberately does not label an unimplemented native action “Answer” or “Reject.”

The R8 page posts string JSON to `SHNative.postMessage` through AndroidX WebKit's origin-restricted WebMessageListener. Only `https://www.smarthandicrafts.com` main-frame messages are accepted:

- `{"type":"ready"}` after authenticated Hub initialization.
- `{"type":"call-state","callId":"...","state":"connected"}` and lifecycle transitions; an active-call heartbeat repeats at 15 seconds.
- `{"type":"request-settings"}`.

After an authenticated exact-call check and the page's ready event, native emits `CustomEvent('sh-native-call-action', {detail:{action:'open',callId:'...'}})`. Native events never auto-answer a call.

Message notification taps emit `CustomEvent('sh-native-chat-action', {detail:{channelId:123}})` after the page's ready event. This uses the Hub's existing conversation selection and preserves its draft/call state instead of reloading the WebView. The latest user notification intent supersedes any older pending lookup.

## Platform behavior and limits

- An incoming notification can alert while the app UI is closed, once FCM/server/device setup is complete and Android permits delivery.
- Full-screen launch depends on Android version, app permission, lock state, Focus/Do Not Disturb and system behavior. A heads-up notification may be shown instead.
- Force stop from Android settings prevents normal background delivery until the app is reopened.
- The foreground microphone service starts only for a verified connected Hub call while the UI is visible and microphone permission is granted. It is not an always-running polling service. A 90-second bridge heartbeat watchdog removes stale foreground ownership.
- WebRTC still runs in WebView. The foreground service improves process priority but does not establish native media resilience after renderer loss or guarantee uninterrupted background audio. Test lock-screen, network switching, headset/Bluetooth, interruptions and real two-way audio on physical devices.
- The APK loads the deployed Hub. Its R9 login presentation and transfer compatibility guard are packaged locally; the broader inbox and business workflows still come from the deployed page.

## Security decisions

- HTTPS only; TLS errors cancel; cleartext and mixed content blocked.
- WebView debugging disabled; no `addJavascriptInterface` fallback.
- File URL access disabled; file picker accepts content URIs only; private credentials are not file-provider paths.
- Microphone permission granted only to the trusted Odoo origin after Android user permission.
- Third-party main-frame links open in the external browser; unsafe intent/javascript/file URLs are not launched.
- Authenticated download redirects must stay on their original approved origin; cookies cannot follow a redirect to another site.
- Incoming events and terminal tombstones are synchronized across native wrappers; message deduplication is bounded to 128 channels.
- Local “Disable alerts” stops native display immediately and attempts server unregister. Unconfirmed unregister is reported.

## Verification boundaries

Pure Java unit tests exercise origin/URL rules, stale/future call windows and identifier/filename rules. A successful Gradle build verifies compilation and Android packaging, not real FCM receipt or WhatsApp audio. End-to-end receipt must be checked on an enrolled Android device; the app includes the matching-ID test for that purpose.

## Branding

The Android display name is **SH Chat**. The package and Firebase application identifiers are unchanged. The launcher uses the original Smart Handicrafts calligraphic PNG, copied without modification, on a white adaptive icon background. Its modest adaptive foreground inset protects the full mark under circular/squircle masks. Large notification icons and the incoming-call screen use the same original company logo. Android small status icons use monochrome phone/message symbols as required by the system. Customer-message notifications use native MessagingStyle on API28+ and retain one notification per conversation, with a readable fallback on older supported Android releases. The app does not advertise a native Reply/Reject operation that the backend does not implement.
