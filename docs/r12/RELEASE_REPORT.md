# Smart Handicrafts SH Chat — R12 review and release report

Date: 29 October 2026

## Release decision

**R12 is a built and locally verified release candidate. Production approval is
blocked.** The Android build is unsigned, no reviewed code was pushed or deployed
in this session, and no physical WhatsApp audio/notification/transfer test was
performed. A separate confirmed authorization gap remains in the existing Zoho
mail backend. Do not install this candidate under a different signing identity
or describe all application features as passed.

The companion `SH-Chat-R12-Checklist.md` covers **105 individual requirements**
from the handoff and subsequent requests. A simulated pass is labelled as such;
source inspection is not a runtime pass, and unknown results remain visible.

## What changed

### Call state, ownership and cleanup

The reviewed backend and native changes address the failure patterns behind
stuck “already in call,” ringing after answer, delayed End, stale Connected and
unsafe transfer-back controls:

- A lost Answer acknowledgement resumes the exact existing media leg. An
  uncertain Dial/Connect result does not trigger an unrelated second call.
- An outgoing SDP answer arriving before the dial response is retained privately
  and correlated once. Late terminal events and conflicting answers cannot
  resurrect a completed call.
- The first incoming Answer transaction schedules cancellation of other devices'
  ringing before waiting for a provider response.
- Failure or delay in FCM/history work cannot hold up customer termination or a
  settled device reservation. An unresolved provider/media operation retains its
  exact reservation until compensating cleanup finishes.
- Local End invalidates the attempt, disables local audio and returns to the
  matching chat before network cleanup. LiveKit's blocking disposal runs off the
  Android UI thread, with serialized disposal before a new room joins.
- A durable queue and WorkManager retry exact call/leg cleanup after interrupted
  work. A concurrent enqueue can no longer strand cleanup behind a lost wakeup.
- Delayed screens, notifications, transfer dialogs and commands carry the exact
  attempt, enrollment and ownership leg, including A → B → A transfers.
- A new incoming intent during another active call cannot reuse the old call's
  controls. Once the old call ends, the waiting call is rechecked for eligibility.
- Enrollment replacement invalidates old pending microphone/permission/start
  work and releases old local media. Ordinary renewal of the same enrollment
  does not falsely cancel it.
- Customer track loss invalidates media readiness. Connection/reconnection
  watchdogs do not depend on a slow status request; a successful signaling
  response alone is not used as proof of a connected audio call.

The final Android source also includes API31+ CallStyle notifications, observed
audio-route state, portrait orientation, disabled WebView zoom controls, system
theme handling and scrollable large-font call content with essential controls
remaining visible. These source/build results do not prove physical audio routes
or notification delivery.

### Hub integration and visual verification

Native controls now use actual provider call IDs, not `session:` render keys or
generic history event IDs. A keyed call banner retains its DOM when unchanged,
can reopen an outgoing attempt before a provider ID exists, and only closes the
matching attempt/leg. It does not fabricate a remote “ended” history event.

The offline UI review executed the actual full embed. It checked the mobile
Chats home, desktop two-panel layout, name-to-contact-info navigation, frameless
photos/albums, mail folders, camera chooser, conversation actions, missed calls,
label color/create/apply behavior, long press, system dark mode, delayed chat
switches, independent drafts and simulated keyboard space. One hundred unchanged
photo/missed-call refreshes preserved nodes without DOM mutations. Group captions
and the camera chooser's rounded visible focus treatment were corrected.

Many of these large UI features were already present in the restored reference.
They were exercised and inspected here; they are not all represented as newly
implemented features. Physical iOS/Android layout and the actual published Odoo
wrapper still require verification.

### Call and push authorization

Legacy call, lock, presence, transfer, call-log and web-push helper endpoints now
require appropriate operator authority. A signed Render operator profile issues
a short scoped browser capability, bound to the exact Hub origin. An Odoo UID,
Origin header or user-supplied device label is not treated as authentication.

The browser capability stays in memory and in an Authorization header. The popup
checks source, origin and state; renewal cannot extend the original absolute
grant. A rejected mutation is not automatically replayed. Call-event updates use
bounded authenticated fetch streaming, and the server closes a stream when its
opening access capability expires.

The Android history bridge retains the enrolled bearer in Java and permits only
fixed-origin, bounded GET requests. The server projects history through an
allowlist that excludes SDP, raw provider payloads and join/device credentials.
Android refuses a successful history response before reading its body unless
the matching `sh-call-history-v1` response marker is present.

Web-push replacement/reset verifies ownership inside the storage mutation.
Authenticated re-registration on the same browser must prove the exact existing
subscription keys; an endpoint alone cannot transfer or delete another device's
subscription. The notification companion requires sign-in, checks server
acknowledgements, and keeps local delivery intact if a reset fails. Its test
button reports server acceptance rather than claiming a phone received it.

### Messaging and AI preservation checks

The final bounded preservation review caught an attachment race: a WhatsApp
reply window could close during upload, after the initial check but before
`message_post`. The patched path checks the freshest record for the captured
conversation before each upload and immediately before posting, rejects duplicate
concurrent upload batches, and retains the draft on failure. Closing the workspace
also prevents a late upload completion from sending a message.

Template pickers show confirmed approved templates, and both contact/broadcast
and selected-chat send entry points freshly recheck the exact template status
before attempting a send. Unknown or unapproved status is not treated as approval.
The existing fallback stops after an ambiguous send outcome instead of attempting
another method that might duplicate a message. A template send does not reopen
the free-text window.

AI status changes require an explicit successful acknowledgement of the requested
mode; HTTP200 with empty/malformed data no longer confirms a toggle. Existing
server-background guards, immediate local customer linkage and serialized toggle
behavior were included in the preservation review. The existing app-open policy
still pushes global AI mode to manual: opening another device can disable global
automation. That multi-device policy remains a recorded product decision, not an
assumed solved feature. Real AI automation, memory and handover are not certified.

## Executed verification

| Suite | Passed | Scope |
| --- | ---: | --- |
| Existing backend/core tests | 245 | Current source, synthetic provider/FCM effects |
| New backend lifecycle regressions | 43 | Lost responses, ownership, cleanup, stale events and transfer races |
| Reporting/retention tests | 48 | XLSX/archive/read-back/deletion guard simulations |
| Official Firestore SDK integration | 5 | Actual SDK 8.7.1 against a local emulator |
| Browser authorization module | 22 | Signed authority, origin/scope/expiry and popup behavior |
| Actual server push/SSE handlers | 20 | Ownership, expiry, replacement and resource cleanup |
| Browser/VM Hub pack | 124 | Real UI/functions with mocked HTTP and synthetic records |
| Messaging/template/customer/AI preservation | 34 | Actual extracted functions with controlled asynchronous responses |
| Android release unit/Robolectric tests | 147 | Release variant, zero failures/errors/skips |
| **Total executed passing checks** | **688** | **Local verification; not physical or production certification** |

Android release assembly and vital lint also passed. The unsigned APK passed
16KiB ZIP alignment. These build gates are reported separately from the 688 tests.

Every automated check used synthetic records, fake service responses or a local
emulator. The Firestore integration checks used the actual official SDK, but not
the production project. No customer call, message, email or test push was sent.

Baseline reproductions are retained separately from successful current runs.
The R11 security comparison substitutes actual old server handlers while retaining
the current auth/ownership modules to isolate handler regressions; it is not a
complete old-deployment security simulation. Historical R11 Android verification
is explicitly labelled and is not used as proof that R12 is signed.

The included verification manifest records exact source/build hashes and the
scope of each suite. This was a focused deep review of calling, transport,
selected UI and preservation paths. It is not a claim that every line of the
large unrelated mail, sales, AI and document implementations has been audited.

## Android artifact and signing

- Package: `com.smarthandicrafts.operatorhub`
- Version: `1.0-r12`, versionCode `12`
- APK: `SH-Chat-1.0-r12-unsigned.apk`
- Size: **59,469,402 bytes**
- SHA256: `f78e82079781a28d16f125038198b98d0b3d78468dd28c8e94ef6e11a7dab5cd`
- Android release tests, release build, vital lint and 16KiB ZIP alignment passed.
- Signature verification correctly reports unsigned. This file is **not an
  installable update** until it is signed with the original release key.

Required existing certificate SHA256:

`c1ca4799a7c1ff26ed2e188f3622d6b3b6144450ba656fde6f438629e75c4382`

The original signing backup was not available to this session. No new key was
generated. The standalone Android source/guide contains the original signing
configuration and current release evidence; production enrollment/server secrets
and private signing keys are excluded.

## Deployment and remaining blockers

1. **Signing/access:** supply the original release signing backup, or access to
   an existing authorized signing pipeline. Authenticated GitHub/Render/Odoo
   browser access was not available in this session. The browser connection
   reported that the originating browser context is required.
2. **Current deployment identity:** the public GitHub main check still returned
   `8b863b7638acfa8c981c67ca536a0c0c83a46b94`. The unauthenticated Odoo page returned
   403. The existing Render version URL returned 404, so it could not identify
   that deployment; this does not by itself prove the service is down. A safe
   public backend version/protocol endpoint was added to the candidate source.
3. **Coordinated rollout:** new browser calling requires the protected transport
   and an explicit strong `PROFILE_SESSION_SECRET` plus the existing allowed
   Render profile credentials. Native history needs the matching sanitized
   backend. Do not publish only one component and assume older clients support it.
4. **Broader authorization:** existing Zoho message-read, send and reply endpoints
   are outside the new call/push guard. This is a confirmed production blocker.
   Compatible authenticated transport and server checks for those features need
   their own implementation and regression pass. Other private integration
   families need equivalent review.
5. **Physical acceptance:** two operator phones and a separate customer endpoint
   are required to verify real media, notification delivery and transfer. The
   required cases below have not been run.
6. **Other Odoo workflows:** real upload/send, contact write, quotation/activity,
   template method, mail, Google contact, document and AI operations need current
   account/model/configuration verification. Mocked UI success does not establish
   database permissions or delivery.

The source and patch are prepared for GitHub, but no remote branch/PR, Render
deployment, published Odoo edit or installed-app update is claimed.

## Physical acceptance matrix — all unrun

| Scenario | Required observation |
| --- | --- |
| Incoming call in foreground | Correct customer, prompt ringing, one Answer, two-way speech, accurate connected state/timer. |
| Incoming while locked/backgrounded | Visible call alert, correct Answer/Decline actions, no duplicate browser/native call screen. |
| Task removed/process reclaimed | Document actual OS behavior and push arrival; distinguish this from explicit force-stop. |
| Customer cancels before answer | Ringing stops and late Answer cannot reopen the call. |
| Decline without an already-open app | No microphone capture; remote ringing stops; next call is available. |
| Outgoing answered/declined/busy/no-answer | Correct state transition for each result, no false Connected, no unexplained 15–20 second failure. |
| Local End and immediate callback | Local audio/UI ends without waiting for HTTP; callback succeeds once remote cleanup settles. |
| Remote End | Local microphone and controls close; no stale busy reservation. |
| Lost Accept/Dial/End response | Same attempt is recovered/cleaned; no second customer call or newer-call termination. |
| Two devices answer together | Exactly one owner; the other device stops ringing and cannot operate the winner's call. |
| Transfer A → B | Customer keeps two-way audio; A remains until B readiness, then A's microphone is released. |
| Transfer B → A | Fresh leg ownership; old notifications/dialogs from A's first leg cannot End the new leg. |
| Transfer decline/timeout/target offline | Original customer/source call remains usable and target reservation clears. |
| Customer hangs up during transfer | Terminal state wins and both devices release resources. |
| Source goes offline after transfer | Target/customer speech continues; no hidden dependence on the former source device. |
| Wi-Fi/mobile-data changes | Accurate reconnect state and bounded failure, no orphan microphone or stale Connected. |
| Silence/mute | Silence does not falsely terminate a healthy call; mute changes the actual microphone. |
| Earpiece/speaker/Bluetooth/wired | Actual selected route matches UI; permissions and disconnection restore a valid route. |
| Enrollment changes during call/permission wait | Old identity stops; a pending action cannot silently run under the replacement identity. |
| Fresh install and signed upgrade | Correct Odoo login/return, no flash/404 loop, existing session/enrollment retained on compatible upgrade. |
| Real mobile UI | Safe areas, keyboard, long press, dark theme, orientation policy and photo layouts remain usable. |
| Render restart/redeploy | Device registrations persist; active/uncertain call recovery follows recorded ownership and cleanup rules. |

Record UI, push, provider and media timestamps separately. The local controls are
designed to respond without network waits, but no real latency figure is asserted
without a measured phone run. Android force-stop, notification-channel settings,
DND and OEM background restrictions remain platform factors. Video calling and
Core-Telecom/watch/car/headset hardware Answer/End are not implemented here.

## Reference documentation

- Odoo 19 WhatsApp: https://www.odoo.com/documentation/19.0/applications/productivity/whatsapp.html
- Android CallStyle notifications: https://developer.android.com/develop/ui/compose/notifications/call-style
- Android notification channels: https://developer.android.com/develop/ui/compose/notifications/channels
- Firebase receive/force-stop conditions: https://firebase.google.com/docs/cloud-messaging/flutter/receive-messages
- Android system bar appearance API: https://developer.android.com/reference/androidx/core/view/WindowInsetsControllerCompat
