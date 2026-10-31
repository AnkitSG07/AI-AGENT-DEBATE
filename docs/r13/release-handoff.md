# SH Chat R13 recovered release handoff

## Release identity

This continuation recovered the interrupted R13 working tree after the R12
checkpoint `f528707a515fd46e5ab342b4564058c6794809e4`. The recovered source and
historical test reports were preserved separately from the new verification.
The candidate branch is `sh-chat-r13-reviewed-simulation`.

| Component | Identity |
| --- | --- |
| Android production package | `com.smarthandicrafts.operatorhub` |
| Android candidate | `1.0-r13`, versionCode `13` |
| Hub UI build | `2026.10.30-ui-r13` |
| Backend release | `2026-10-30-operator-hub-r13-private-integrations` |
| Backend public version endpoint | `GET /api/operator-app/version` |
| Verification runtime | Node24; Android15/API35 for the isolated OS harness |

The delivered release report records the final commit, artifact checksums,
execution counts and unresolved gates. Historical results are not added to fresh
results as if they were distinct tests. A compiled APK is not an executed Android
test, and local media transport is not a live WhatsApp call.

## Changes recovered and completed

The recovered R13 source protects private Mail, Contacts, Documents and AI APIs,
adds source-bound automated-reply grants and durable reply/handover receipts,
and gives the Android WebView a narrowly scoped operator sign-in popup. The Hub
uses a pinned sanitizer for HTML mail and preserves its existing conversation,
document, template, quotation and contact workflows under synthetic scenarios.

The resumed review corrected additional defects:

- Opening or reconnecting a Hub now reads the shared AI state. It no longer
  sends a global OFF write as a side effect of startup.
- Every explicit AI write includes the observed epoch and revision. Missing or
  stale versions are rejected, conflicting response fields remain unconfirmed,
  and uncertain acknowledgements require a fresh read before another action.
- AI cannot report enabled when required forwarding, reply authority or durable
  receipt configuration is missing. The old source-embedded webhook fallback
  has been removed; the existing valid webhook must be configured privately.
- Final message sends verify the exact requested Odoo channel and require a
  positive integer message ID. Ambiguous replies retain an uncertain receipt
  and do not silently retry.
- Signed document preview/download checks the exact attachment or document
  identity returned by Odoo before serving binary content. A mismatched record
  cannot fall through to a different attachment or document.
- Cloud participant revocation uses a fresh retry-time cutoff instead of an
  old persisted cleanup timestamp. The Cloud-only API remains a separate gate.
- Concurrent incoming Answer claims are briefly ordered per exact session in
  one coordinator, with Firestore remaining authoritative across coordinators.
- A customer who joins muted can establish a separately identified transport
  state after exact track/provider/ICE/DTLS/outgoing-RTP checks. The UI does not
  claim that two-way sound was verified. Transfers still keep the original
  operator until actual incoming audio has been observed at the target.
- Call waiting adds an explicit End current & answer transition, tied to the
  displayed call identity and durable release of the device reservation.
- Incoming CallStyle notifications retain their full-screen PendingIntent when
  the user has denied full-screen access. Android enforces that choice by
  displaying its permitted heads-up presentation. Omitting the intent while no
  foreground service is running made the notification invalid. The new API35
  regression failed on the previous code and passes on the corrected source;
  the actual OS run and its permission state are reported separately.

The notification behavior follows Android's
[NotificationManagerCompat API documentation](https://developer.android.com/reference/androidx/core/app/NotificationManagerCompat#canUseFullScreenIntent())
and [full-screen intent limits](https://source.android.com/docs/core/permissions/fsi-limits).
The application does not grant itself full-screen access or start a microphone
service to make an incoming alert valid.

## Explicit WhatsApp calling permission

The Android dialer now has separate **Request call permission** and **Check
permission** controls. Every response is bound to the exact destination and
current enrollment. A stable request identifier is saved before dispatch so
process loss or a repeated tap cannot silently send another message. Changing
the number or enrollment invalidates an in-flight UI response.

The server uses Meta's documented request and status shapes from the official
sample, with its business number, Graph origin, API version and access token
kept server-owned. Authentication, durable receipts and provider eligibility are
checked before the sole explicit dispatch. Permission status is refreshed from
Meta; a message acknowledgement never grants consent. Temporary expiry,
provider refusal, a closed customer reply window and uncertain outcomes have
separate handling. Uncertain sends remain fenced rather than being retried.
No constructor, GET, webhook, timer or recovery worker sends a permission message.

Read `docs/r13/call-permission-contract.md` for the verified contract, endpoint
DTOs, source attribution and limitations. The flow covers explicit free-form
requests; it does not create an unapproved template or infer that a customer
rejected a request merely because current status is `no_permission`. Calling
remains subject to Meta's live authorization. No live permission request was
sent during these isolated tests.

## Evidence and simulation boundaries

The final completed verification groups contain 973 distinct passing checks:
741 JavaScript, 10 Firestore, 17 local browser/media and 205 Android JVM. Of
those counted passes, 576 were freshly executed in this continuation and 397
retain their earlier executions with matching relevant source hashes.

The current API35 OS retry is separately recorded as **four passes, two failures
and six incomplete cases** after a host OOM event interrupted it. Its four passes
are excluded from the 973 complete-group total. The Answer case failed during
AndroidX ActivityScenario cleanup; the real WebView popup case timed out before
its synthetic main document started. Both remain failed outcomes. The two
native SDK/media cases did not start. The existing CI suites need a stable
accelerated runner before those Android acceptance gates can be cleared.

| Layer | Real execution | Substituted or outside scope |
| --- | --- | --- |
| Backend and private HTTP | Actual production modules, full Express middleware/handlers, cryptography, lifecycle and reporting code | Provider responses, external accounts and customer data |
| Browser Hub | Production HTML/CSS/functions in Chromium, actual DOM/events and request ordering | Odoo database, Render responses, Zoho/Google/Zapier and customer delivery |
| Firestore | Official SDK and local emulator transactions, competing operations, restart/recovery behavior | Production IAM, quota, indexes, cloud network and Render deployment |
| Call media | Local LiveKit SFU, official SDKs, independent Chromium peers, Opus RTP, decoded PCM and measured tones | Four Cloud WhatsApp connector methods, trusted Meta event fixtures and synthetic device enrollment |
| Android JVM | Production classes under unit/Robolectric execution | Android device hardware and actual FCM delivery |
| Android OS | Executable separate API35 instrumentation suite for notifications, PendingIntent, Activity and WebView | Injected provider responses and already-delivered FCM data; see actual execution outcome |
| Android native media | Executable production NativeRoomEngine/SDK against isolated TLS SFU and real RTP/decoded audio | Test-only TLS/DNS Room transport, emulator microphone input, physical audio hardware and Meta/FCM; see actual execution outcome |

The native media harness pins a freshly generated public test CA in androidTest.
Its private test keys are created outside the repository. The production package
has no test CA, fixture Activity or development server allowance. The two Android
instrumentation classes have separate runners, so a skipped media test cannot
silently count as an OS-suite pass.

The real media scenarios cover incoming/outgoing calls; actual initial silence
and a muted customer; the reported15–20 second failure interval; immediate
callback; simultaneous Answer; decline/cancellation; A→B→A handoff after the old
source browser is offline and closed; failed/declined/expired transfers;
customer hangup during transfer; invalid/revoked authority; lost Accept/Dial
acknowledgements; duplicate End; coordinator recreation; and SDK reconnection.
Measured source shutdown, participant identity and new audio counters are
required evidence for a transfer, rather than a changed ownership label alone.

## Reproduce the local gates

Use `.node-version` and the locked dependencies. The following commands create
isolated synthetic test data only:

```sh
npm ci --ignore-scripts
node scripts/verify-r13.mjs unit http browser
node scripts/run-firestore-r13.mjs
SH_R13_REAL_MEDIA_TESTS=1 node scripts/verify-r13.mjs media
```

Browser/media tests require the pinned tools and environment paths described in
`tests/simulator-media-r13/README.md`. Android instructions and the two dedicated
runners are in `android/operatorhub/README.md`. The GitHub Actions workflow builds
the unsigned release, runs the JVM checks and explicitly invokes both Android
instrumentation suites. Its Linux wrapper,
`scripts/run-android-instrumentation-r13.sh`, requires accessible KVM and a
successful emulator acceleration check. It attempts the native suite even when
the OS suite fails, records both exit statuses, and fails the job if either
runner fails. Its hosted execution is a separate outcome from local validation;
this recovery did not dispatch an authenticated GitHub run.

## Original signing identity

The actual R11 signed APK was checked with Android apksigner. The expected
certificate SHA-256 is:

`c1ca4799a7c1ff26ed2e188f3622d6b3b6144450ba656fde6f438629e75c4382`

The private backup `SH-Chat-PRIVATE-signing-backup.zip` was not recovered from
the inspected files or connected file locations. No replacement production key
was generated. The unsigned release is build output and cannot be presented as
a compatible installed-app update. The separate `.simulation` app has a debug
identity and cannot update the enrolled production package.

`scripts/sign-android-r13.py` accepts the original key through the private
signing environment, validates exact package/version and absence of debug
fixtures, aligns the APK, signs a temporary copy and verifies the existing
certificate before publishing the output. It refuses an existing output path.
Passwords are read through `SH_CHAT_STORE_PASSWORD` and `SH_CHAT_KEY_PASSWORD`,
not command-line password arguments. Its successful signing path remains
unexecuted until the original key is supplied.

## Coordinated rollout

Preserve existing valid environment values and review
`docs/r13/backend-private-integrations.md`. In particular, the Zapier reply step
must echo the exact incoming `ai_reply_grant`; the required server secret and
Firestore receipts must be configured; and human handover recipients must use
verified internal Odoo user IDs. Configuration booleans are not provider health
checks. AI stays manual until the coordinated setup is verified.

Deploy matching backend, browser helper, R13 embed and originally signed Android
package. Inspect the version endpoint, deployed commit, actual Odoo asset bytes
and APK certificate/checksum together. Test a compatible upgrade that retains
enrollment and the user's Odoo session. Do not uninstall the production app to
work around a signing mismatch.

The user's GitHub and Render connections are now working. GitHub authenticated
as `AnkitSG07`, the owner of `AnkitSG07/AI-AGENT-DEBATE`, and reported repository
admin and push permissions. The repository is public. Its existing SH Chat
branches are R9, R10 and R11; the inspected Actions and release collections were
empty. Connection setup is no longer a release blocker.

Render identified the exact matching service `srv-d6hc161aae7s73bqu1c0` in the
connected workspace. Its live deploy `dep-dbhlaovb9u1s73a1nqc0` runs commit
`8b863b7638acfa8c981c67ca536a0c0c83a46b94`, the R11 merge. The service builds
with `npm install`, starts with `npm start`, and automatically deploys commits
on `main`. Pushing the separate candidate branch does not change this live
branch. Public Render health returned200, while the R13 app-version endpoint
returned404 and Android config retained its R10 compatibility marker.

No repository push, Render deployment, Odoo page replacement or live
customer/provider action was performed in this resumed local verification.
A Git push dry run was rejected by automatic approval review because it could
authenticate or transmit source without specific approval of the reviewed
payload and public destination. The rejected action was not performed through
another interface. The delivered report records any subsequent publication
authorization and outcome separately. The connected browser also reported that
the originating browser context was missing; this did not prevent the successful
GitHub and Render connector reads.

Final acceptance still needs the actual configured Cloud connector and Meta
calling permission, real incoming/outgoing audio on the signed app, two-phone
handoff, FCM background/locked delivery, mobile-network changes and the supported
speaker/earpiece/Bluetooth routes. A simulator does not manufacture provider
permission, certify a physical microphone, or override Android force-stop.
The full requirements evidence keeps unsupported or incomplete features visible,
including the required video-calling capability. The explicit native
permission-request/status workflow is now implemented; its live customer
acceptance remains separately unverified. System CallStyle notifications are
present; the requested dedicated watch, car and headset Answer/End integration
is not implemented in this release. Bluetooth audio routing alone does not
satisfy those remote-control requirements.

The last authenticated Render service configuration uses a free instance. The
[official free-instance documentation](https://render.com/docs/free) describes
spin-down after 15 minutes of idle time and about one minute to wake. This is a
separate production latency constraint for incoming calls. No hosting plan or
billing change was made; always-on readiness needs an appropriate deployment
configuration and measured real-phone/provider acceptance.
