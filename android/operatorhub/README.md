# SH Chat R13 — Android candidate and system simulation

**Release:** `1.0-r13`, version code `13`

**Production package:** `com.smarthandicrafts.operatorhub`

**Hub:** https://www.smarthandicrafts.com/livechat-api-test

The release APK is an **unsigned candidate**. It requires the existing organization's signing key before Android can install it as an update. Its original certificate SHA-256 must be:

`c1ca4799a7c1ff26ed2e188f3622d6b3b6144450ba656fde6f438629e75c4382`

No replacement release key has been generated. Do not uninstall an enrolled production app to work around a signing mismatch. The separately signed `SH Chat Simulator` package uses `.simulation` and is only an isolated test harness; it cannot update production or certify live customer calling.

## R13 changes

The native WebView now supports the protected operator-profile connection used by Mail, Google Contacts, Documents and AI. A narrowly scoped child WebView preserves the browser's real opener and source-checked message handshake. Only a trusted Hub page and a user gesture can open it. It exposes no native device credential or bridge, denies capture/file access, rejects off-contract resources, and closes when its parent navigation changes or the auth page fails.

Draft quotations keep their initial blank popup while Odoo creates the draft, then open the resulting Odoo page. Signed document view/download links are forwarded through a separate document-specific policy. Neither workflow weakens the protected auth-page policy.

Calls accepted while the customer is muted now use an explicit transport-ready state corroborated by the backend. The UI says **Customer microphone muted**; it never invents received audio. Unmute requires fresh decoded media. A transfer destination stays pending while the original phone keeps the customer until bidirectional audio is proven.

The waiting-call screen offers **End current & answer** after authenticating and validating the exact incoming call. It ends only the captured current attempt, waits for its local service and durable server reservation to release, and then starts the exact waiting call once. A narrow bounded same-request retry handles a delayed old reservation. Terminal calls, changed enrollments and stale controls cannot end a newer call.

Incoming CallStyle notifications now retain their immutable full-screen PendingIntent when the user denies full-screen special access. Android enforces that denial with its heads-up fallback; removing the intent made an incoming CallStyle invalid before a call foreground service existed. The instrumented regression keeps full-screen access denied.

The native dialer now has separate **Request call permission** and **Check permission** controls for the exact displayed country-code number. Request sends only after an explicit tap; neither action dials automatically. A provider message receipt is never treated as customer consent. Request IDs persist for the enrolled device and number before sending, so a lost acknowledgement cannot silently resend. Check displays provider permission state and temporary expiry, and preserves uncertain delivery until reconciliation. Nineteen focused JVM cases exercise identity binding, recreation, malformed responses, known blocked-window responses, expiry and explicit-action behavior.

The R12 call lifecycle, local End, durable cleanup, enrollment binding, transfer ownership, SDK permission serialization, portrait controls and private notifications remain in the source and regression suite. See [the R13 audit](docs/R13_ANDROID_SYSTEM_AUDIT.md) and [the retained R12 call details](docs/README-R12-history.md).

## Verification

`NATIVE_CALLS_VERIFICATION.json` records exact build, release-unit, simulator execution and APK outcomes. `SOURCE_MANIFEST.json` records source hashes. Fresh Android evidence is under `../../verification/recovery-current/android`; the older `verification/r13`, R12 and R11 records retain their original labels.

The final release unit build passed **205 tests across 23 suites**, with zero failures, errors or skipped tests. All **107 tracked build inputs** were hashed before and after the build and still match the current source. Release vital lint and all three APK assemblies passed. The current unsigned release APK SHA-256 is `2196a8427237d889774f92d3622c5887f7fd85913ca1991ebd485a9ebd0deade`. The earlier 186-test corrected-notification build is retained as historical evidence.

Final-APK OS instrumentation is **incomplete**. One attempt aborted during Android process startup before JUnit. After a documented readiness check, the one retry completed **4 passing and 2 failing cases**, then host memory exhaustion interrupted it with **6 OS cases incomplete**. The two failures remain failures: an AndroidX ActivityScenario cleanup exception in the Answer case, and a WebView initial-page timeout before the popup handshake. The two native SDK media cases were **not run** because the emulator had disappeared and the same shared host lacked safe headroom. Exact case names, final installed APK identity, raw statuses and OOM observations are preserved in `../../verification/recovery-current/android/completion/system-final-retry/run-audit.json`. Neither compilation nor a partial run is a passing 12+2 instrumentation suite.

Physical-phone WhatsApp audio, actual FCM transport and latency, background/locked delivery, Bluetooth, mobile-network changes and spoken two-phone handoff require their own acceptance record. Local Android and backend media simulations have separate scopes. The release should not be labeled production-accepted until those gates and original signing are complete.

## Build

Use JDK 17, Android SDK 35 and the included Gradle 8.11.1 wrapper:

```sh
bash gradlew --no-daemon --max-workers=2 :app:testReleaseUnitTest :app:lintVitalRelease :app:assembleRelease :app:assembleDebug :app:assembleDebugAndroidTest
```

The release output is `app/build/outputs/apk/release/app-release-unsigned.apk`. Keep signing credentials outside the repository. Align and sign with Android build-tools, then verify the resulting certificate against the original value above. A source hash or debug signature does not replace that verification.

## Run the isolated OS suite

Start a dedicated Android15/API35 AOSP x86_64 emulator. Hardware virtualization is strongly preferred. The runner refuses a physical phone or another API level:

```sh
ANDROID_SDK_ROOT=/path/to/android-sdk SH_SIMULATOR_SERIAL=emulator-5554 SH_SIMULATOR_SKIP_BUILD=1 bash run-system-simulation.sh
```

It installs only `.simulation` and `.simulation.test`, clears only that simulator application's data, blocks remote emulator HTTP, grants notification permission and deliberately leaves microphone permission denied. Full-screen notification interruption is disabled so the explicit foreground action tests are deterministic. Logs and a screenshot go to `build/reports/system-simulation` unless `SH_SIMULATOR_REPORT_DIR` is set.

On slow emulators, optional `SH_SIMULATOR_AOT_COMPILE=1` runs Android's standard `cmd package compile -m speed -f` for the installed simulator and test packages before execution. It does not change assertions, timeouts, permissions or APK contents.

The test fixture Activity and injected provider data are confined to `src/debug` and `src/androidTest`. They are excluded from release APKs. Release archives contain public Firebase client identifiers, no Firebase Admin private key, no production signing key, no enrollment code and no operator password.

## Actual native SDK media suite

`run-native-media-simulation.sh` runs two separate instrumented scenarios using the production `NativeRoomEngine` and actual pinned Android LiveKit SDK against an isolated local SFU. It checks actual native SDK microphone-track RTP carrying simulator silence, decoded customer-tone audio, mute/unmute, close/redial, and initially muted customer transport followed by decoded audio after unmute. It does not establish physical microphone, speaker or spoken-call quality. A source-only test CA and DNS override exist in `androidTest`; the release APK contains neither the test CA, fixture hostname nor test classes. Consult `NATIVE_CALLS_VERIFICATION.json` for the executed outcome; compilation alone is not a pass.

Install local LiveKit server and browser client assets under `SH_MEDIA_TOOLING`, provide Playwright/Chromium (`SH_PLAYWRIGHT_MODULE` and `SH_TEST_CHROMIUM` when needed), and run `tests/simulator-media-r13/prepare-native-tls.py` from the repository before building the test APK. Its private test keys must stay outside the repository. The runner owns fixture startup/teardown by default and refuses a non-emulator device.

```sh
ANDROID_SDK_ROOT=/path/to/android-sdk SH_SIMULATOR_SERIAL=emulator-5554 bash run-native-media-simulation.sh
```

Use `SH_SIMULATOR_SKIP_BUILD=1` only when the built test APK contains the same public test CA. `SH_NATIVE_FIXTURE_EXTERNAL=1` is reserved for an already-running isolated fixture with explicit `SH_NATIVE_MEDIA_OUTPUT`/`SH_NATIVE_MEDIA_TLS`; the runner still verifies the embedded CA. It runs the two native SDK cases only. The system runner separately requires exactly12 successful OS cases with zero skips/failures.
