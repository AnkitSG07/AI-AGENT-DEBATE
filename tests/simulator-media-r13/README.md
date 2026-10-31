# R13 real audio integration simulator

This is an executable integration test, with actual media transport. It starts
an isolated LiveKit SFU, Firestore emulator, the production native call HTTP
routes and call coordinator, and independent Chromium peers. Test peers generate
different tones and decode the remote audio. Two-way audio checks require growing
RTP byte and packet counters, decoded PCM, correct tone frequency, successful
ICE/DTLS, and matching participant/track IDs returned by the real RoomService API.
The initially muted customer case separately proves transport readiness with an
exact provider-confirmed muted track, then verifies two-way audio after unmute.

The production configuration continues to require a LiveKit Cloud origin. No
development origin or test credential was added to the production configuration.
The local provider is injected only by this separately invoked test harness.

## What is real

- LiveKit server 1.13.11, pinned official Linux AMD64 binary.
- LiveKit browser SDK 2.23.0 and independent Chromium WebRTC connections.
- Opus audio, generated at 440 Hz for the synthetic customer, 660 Hz for phone A
  and 880 Hz for phone B; decoded RMS and frequency measurements are recorded.
- Official server SDK 2.18.0, including token creation, participant listing and
  removal.
- Official Firestore SDK 8.7.1 and emulator 1.19.8, with real transactional call,
  transfer and reservation records.
- Actual `mountNativeCallRoutes`, `CallRuntime`, startup gating, native readiness
  verification, transfer controller and Firestore media store.

## Explicit substitutions and limits

LiveKit's WhatsApp Connector is Cloud-only. Four external connector methods are
replaced by an isolated test customer that really joins/leaves the SFU; generated
Meta event fixtures supply the external offer, answer, acceptance and termination.
The test does **not** contact Meta, a customer's phone, the production project,
FCM or Odoo. The test device identities are synthetic, not the real enrollment
registry. A coordinator recreation test reopens the same emulator data; it does
not deploy Render or restart an actual cloud service.

These tests verify media and application behavior on a local network. They do
not measure mobile-data latency, acoustic hardware, Bluetooth, lock-screen push,
Doze, telecom integration or cloud connector behavior. LiveKit Cloud-only token
revocation cannot be proved by the self-hosted SFU. The accompanying revocation
test models the documented time constraint independently and the release still
needs a cloud smoke test for that feature.

## Reproduce

Use the repository's pinned Node 24 version, Python 3.12+, Java 17 and
Linux AMD64. Install the repository's dependencies with `npm ci`. Install a
separate Playwright 1.62.1 tool environment and its Chromium binary. The suite
never reads production secrets and all service listeners bind to 127.0.0.1.

From the repository root:

```bash
python tests/simulator-media-r13/prepare-tools.py
npm install --prefix /tmp/sh-r13-playwright --no-save playwright@1.62.1
/tmp/sh-r13-playwright/node_modules/.bin/playwright install --with-deps chromium
```

Set `SH_PLAYWRIGHT_MODULE` to the absolute path of that Playwright module,
`SH_TEST_CHROMIUM` to its installed Chromium executable, `SH_TEST_JAVA` to the
Java executable, and `SH_FIRESTORE_EMULATOR_JAR` to the verified JAR path printed
by `prepare-tools.py`. The tool preparer creates a sibling `tooling/r13-media`
directory outside the repository to keep downloaded binaries out of Git.
Set `SH_MEDIA_TOOLING` to an existing verified tooling directory when resuming
in another workspace; its default remains that sibling directory.

```bash
SH_R13_REAL_MEDIA_TESTS=1 SH_VERIFY_OUTPUT=verification/r13/media \
  node scripts/verify-r13.mjs media
node --test-reporter=tap tests/simulator-media-r13/provider-revocation.test.mjs
node --test-reporter=tap tests/simulator-media-r13/answer-contention.test.mjs
```

The local ports are 17880 (LiveKit HTTP), 17881 (RTC TCP), 17882 (RTC UDP),
17883 (test HTTP/routes) and 18089 (Firestore). They must be available. Running
the suite may require local socket permission in a sandbox. It checks those ports
before starting, refusing to attach to a leftover or unrelated service. It will refuse to
start without `SH_R13_REAL_MEDIA_TESTS=1`. Emulator project and listener origins
are fixed to safe local values, regardless of production environment settings.
Cloud metadata discovery is explicitly disabled. Browser HTTP requests to
nonlocal origins are blocked. Run this after a resource-heavy Android emulator
has stopped; a saturated software emulator distorted one local attempt. That
failed attempt is preserved as `evidence/resource-contention-run.tap`, not counted
as a passing media result.

## Scenario coverage

| Scenario | Required observable result |
| --- | --- |
| Incoming Answer | Actual two-way decoded tones; production readiness commits Connected. |
| Initial acoustic silence | Incoming RTP/PCM progresses and readiness succeeds before anyone speaks. |
| Initially muted customer | Exact subscribed customer track is provider-confirmed muted; fresh ICE/DTLS/outbound RTP establishes transport. Evidence explicitly records that incoming/bidirectional audio has not yet been verified. Unmuting then restores real two-way decoded tones. |
| Outgoing answer | Actual early media cannot bypass the separate trusted ACCEPTED gate. |
| 25-second call | Audio still flows after the reported 15–20 second failure window. |
| Silence and mute | Healthy silence does not end the call; actual publication mute is observed; unmute restores audio. |
| End and immediate callback | Old participants and reservation clear; the next call exchanges audio. |
| Two simultaneous answers | One durable owner, one external accept, one customer media leg. |
| Decline and customer cancellation | No new media join; late Answer cannot resurrect the old call. |
| A → B → A | Same customer participant; fresh operator legs; old source unsubscribes; old source browser goes offline and closes; new RTP/PCM grows in both remaining directions; stale old-leg End rejected. |
| Declined/offline invitation | No room token before explicit accept; no target participant; source/customer keep audio. |
| Target lacking media | Readiness fails and source retains ownership. |
| Coordinator recreation | Same Firestore ownership and existing media; no duplicate customer call. |
| Customer ends mid-transfer | Terminal state wins and both operator participants are removed. |
| Revoked/invalid credentials | Actual HTTP handlers reject mutations and policy recovery removes old media. |
| Lost Accept/Dial acknowledgement | Exact original attempt recovers; no second external customer call. |
| Duplicate End | No duplicate termination or stale busy reservation. |
| Signal/full reconnect | Official SDK fault injection replaces actual transports; decoded audio returns in both directions. |
| Real invitation timeout | Real elapsed expiry releases the target and preserves source audio. |
| One-way audio | Muted/unpublished direction prevents readiness; both real directions must recover. |

The handoff is intentionally a warm handoff: only **after target Accept**, both
operator publications can briefly be present while the target's media is
verified. The customer retains source audio during preparation. The suite
measures that overlap and verifies the old source track is removed after commit.
An unaccepted or declined invitation has no room join or customer audio.

## Revocation fix

The old provider used the persisted cleanup time plus 60 seconds as the Cloud
revocation cutoff. The API requires that cutoff to be within 60 seconds of its
current time. Rounding could send a new job beyond the positive limit; after a
long outage/redeploy, an old queued timestamp could be outside the negative
limit, repeatedly blocking exact-leg cleanup.

The provider now derives the cutoff from the current retry time, one integer
second ahead. That stays well inside the API limit and invalidates a same-second
token for the exact old participant, including refreshed tokens. It does not
change the immutable target identity. Invalid clocks fail before a request.
`revocation-before.tap` records eight failing cases against the original code;
`revocation-current.tap` records ten passing cases after the fix.

## Evidence

`evidence/verification.json` contains the scenario results, measured media data,
versions and exact hashes of the tested implementation. It fails the run if
those source files change while the test runs. A new run first writes a nonpassing
`running` manifest so an interrupted attempt cannot inherit a prior pass. All 17
scenarios must complete successfully; an aborted or timed-out scenario remains
nonpassing. The verifier writes the TAP result and its SHA-256 to
`verification/r13/media/`; `livekit.log` and `firestore.log` in the simulator's
evidence directory are local process logs. A manually redirected historical run
may also be present as `evidence/run.tap`.
Successful endpoint acknowledgement is never used as evidence that a real phone
received a call or heard audio.

Primary references:

- https://docs.livekit.io/transport/self-hosting/local/
- https://docs.livekit.io/telephony/connectors/whatsapp/
- https://docs.livekit.io/reference/other/roomservice-api/
- https://docs.livekit.io/frontends/reference/tokens-grants/
- https://docs.livekit.io/intro/basics/connect/
- https://github.com/livekit/livekit/releases/tag/v1.13.11

## Concurrent Answer fix

The actual Firestore emulator run exposed pessimistic-lock contention when two
phones claimed the same incoming call at once. One owner was still selected, but
the loser could receive a delayed temporary-storage error. The coordinator now
orders only each exact session's initial claim transactions within that process.
It releases that short queue before provider/audio/notification work, so the loser
can receive an immediate ownership response. The Firestore transaction remains
authoritative across separate processes and restarts. Different calls are not
serialized together. A bounded regression verifies claim ordering, immediate
loser feedback before provider acknowledgment, independent coordinators, and
queue release after rejection.

## Initial customer mute

`startup-audio-probe.mjs` reproduced the difference on the actual local SFU:
acoustic silence still produced incoming RTP, while a customer publication muted
before the operator joined did not. The former already passed readiness; the
latter previously remained in Connecting until the initial join timeout.

Initial muted calls now have a separate, corroborated transport-ready proof.
The native client must report the exact subscribed customer track plus fresh
publisher/subscriber ICE and DTLS and real outbound RTP. The provider must
independently report that exact active customer track as muted and the operator
microphone as active. The proof preserves the real incoming counters and sets
`bidirectionalAudio: false`; call history records the initial proof mode. An
unmuted, missing or mismatched customer track cannot use this exception.

Transfers continue to require incoming audio progress before removing their
source, and the native UI explains that it is waiting for the customer's
microphone while the original phone keeps the call. The separate
`startup-audio-readiness.test.mjs` checks spoofed mute, missing tracks, stale
samples, outgoing acceptance, the joining deadline and transfer rejection.

## Actual Android SDK fixture

The dedicated Android instrumentation suite uses the production
`NativeRoomEngine` and pinned Android LiveKit SDK against the same local SFU and
generated customer tone. Run it on the isolated API 35 emulator after following
the tooling preparation above:

```bash
SH_SIMULATOR_SERIAL=emulator-5554 \
  bash android/operatorhub/run-native-media-simulation.sh
```

Set `ANDROID_SDK_ROOT` and the Playwright/Chromium paths described above. The
runner creates a temporary local certificate authority with
`prepare-native-tls.py`, copies only its public certificate into the test APK,
builds the simulation APKs, and verifies that the embedded certificate matches.
Use `SH_NATIVE_MEDIA_OUTPUT` for a persistent scratch output directory and
`SH_NATIVE_MEDIA_TLS` only when its private keys remain outside the repository.
Preparing certificates before an independent APK build is supported; skipping
the runner's build requires `SH_SIMULATOR_SKIP_BUILD=1` and an exact certificate
match in that already-built APK.

The test-only client resolves exactly `sh-r13-simulator.livekit.cloud` to emulator
loopback and trusts only the generated test CA, preserving hostname verification.
ADB reverses emulator TCP 443 to host TLS 18443 and emulator TCP 17881 to the
local SFU's TCP media listener. The fixture also uses 17880 and 17883, so it must
run separately from the browser media suite. The runner stops its own fixture
and removes its ADB reverses when finished. An externally managed fixture is
used only with explicit `SH_NATIVE_FIXTURE_EXTERNAL=1`.

The native suite checks decoded customer audio, outbound emulator microphone
RTP, mute/unmute and an initially muted customer. Its raw instrumentation result
determines whether those two tests actually passed; a compiled APK or a suite
that executed zero tests is not a pass. This remains a local emulator test, with
no Meta or FCM delivery, physical microphone/speaker, Bluetooth or cellular
network proof. TLS material and host overrides exist only in the test fixture
and `androidTest` code, outside release application trust policy.

## Waiting-call availability

The authenticated status endpoint reports `deviceAvailable` from the current
device's durable reservation. This lets the native UI wait for cleanup after
ending a prior call, including an outgoing attempt whose provider call ID has
not arrived. The response is an observation; the atomic Answer transaction
still decides ownership. `device-availability.test.mjs` verifies cleanup,
failed storage reads, another caller winning after a status observation, and
safe reuse of the same incoming Answer request ID after `DEVICE_BUSY`. Busy
rejection writes no accept result and dispatches no provider operation; after
cleanup, the retry and its replay produce only one provider accept.

An invited transfer target has its own reservation, so it is intentionally not
globally available. The additional `deviceAvailableForCall` observation is true
for that transfer only when the current live invitation, exact reservation,
provider call ID, target enrollment binding and expiry all match. A missing or
stale invitation reservation cannot authorize ending the old local call. Atomic
transfer Accept still rechecks ownership and availability after the observation.
