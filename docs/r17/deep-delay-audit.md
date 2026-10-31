# SH Chat R17 deep delay audit

The reviewed baseline is R16 source tree `5687beeaae0255d357f700a3d7acb37ddb958a19`,
deployed as GitHub commit `0be628124c0f548e0171270ea292fb6cfcf98964`.
The live log query after its deployment returned no new call action, webhook or
push timing records at the time of this review. There is no measured R16
before/after phone comparison. Earlier production samples belong to R15.

The requested limits are two seconds for real call initiation/ringing,
Answer-to-two-way-audio and remote End on fast handset internet, and four to five
seconds for transfer. Caller-side ringing before an operator notification is a
separate incoming-delivery delay; an instant call screen does not establish any
of these limits.

The final R17 package also uses the user's supplied black-and-white SH Chat
Version 2 logo. The original PNG bytes are preserved in the native brand asset;
the adaptive launcher keeps padding for Android's icon masks on a black
background. The existing shared native-brand renderer uses the same image.

## Findings and corrections

| Finding | Effect | Correction and verification boundary |
| --- | --- | --- |
| Fresh Android End shared the serial retry drain with old cleanup | An old request with a slow server/network could delay a new exact-leg End | Persist the exact record, attempt fresh cleanup on a separate bounded executor, and share per-key in-flight claims with retries. Re-read the latest record to suppress stale snapshots after another lane settled it. |
| Synchronous SDK track stop and sink removal on Android's main thread | The pinned SDK can wait on its RTC executor before End was queued or UI teardown finished | Use the verified direct ADM microphone/speaker mute path, queue exact End before SDK disposal, and perform normal sink removal/track stop/release on the ordered disposal queue. Discard late frame callbacks; retain fail-closed handling and the previous-room disposal barrier. |
| Concurrent recovery wakes launched overlapping full housekeeping | More authority transactions could contend with call setup/transfer | Coalesce full housekeeping per session with a dirty follow-up. Every wake still independently dispatches critical End, SDP and alerts. Other calls remain independent; failures release the entry. |
| Concurrent individual transaction reads still started in two SDK rounds | Independent authority/reservation/notification reads could add a database round trip | Use explicit native transactional getAll batches. Retain snapshot consistency, immutable records, exact reservation validation and fresh authorization ordering. Dependent reads remain sequential. |
| Real content-bearing alerts used per-chat/per-call FCM collapse keys | Queued content could be replaced; the platform's four-key pending limit could discard distinct groups | Omit collapse keys for real message/call/transfer data. Keep short TTLs, durable delivery claims, native dedupe and ended-call tombstones. Only delivery-test notifications retain a bounded key. |

The notification transport correction is checked at the actual FCM HTTP payload
boundary; older delivery fixtures bypassed that serialization. It does not prove
that a particular handset received an alert. Platform limits, offline delivery,
permission/privacy settings and OEM background behavior remain separate factors.

## Incoming call path

The sequence is provider event delivery → verified webhook/durable call record →
priority alert recovery → exact eligible device/delivery claim → fresh call/device
checks → FCM acceptance → handset receipt → native notification rendering.
The R17 batch reads and recovery isolation reduce avoidable server work on this
path. They cannot make a provider deliver its webhook earlier or make an offline
phone receive a push immediately.

The native `SHCallAlertTiming` log separates monotonic receive-to-render-attempt
time from approximate server-issued-to-phone-receipt age. The latter uses two
wall clocks and may contain small clock skew; invalid/large differences are
reported as unknown. A render attempt does not claim the OS displayed the alert
or that the customer has been answered. No extra network request is added before
notification rendering. Only fixed event labels and numeric timings are logged.

## Remaining architecture and timing limits

Incoming Answer still performs fresh authority/durable ownership work, awaits
the provider Accept acknowledgement, then returns a join token to Android.
Android subsequently connects the room, publishes/subscribes audio and observes
genuine media progress. These stages are sequential. The prior 2,243ms provider
Accept sample alone exceeded the requested total two-second limit; it is not a
new R17 measurement or a fixed provider duration.

There is no unconditional successful-path ten-to-twenty-second sleep in the
reviewed provider/native code. Fifteen-second scans/timeouts and longer operation
leases are recovery bounds, not acceptable successful-path latency targets.
Shortening those bounds or removing authentication/audio proof would not make
the underlying operation faster.

The fresh cleanup lane is bounded to avoid unbounded threads; saturation still
falls back to durable retries. SDK disposal must finish before a new capture
session starts. FCM delivery is not ordered and has bounded queues/expiry. These
limits prevent an honest universal two-second guarantee from local tests alone.

## Acceptance status

Final executable tests, APK identity and deployment evidence are in the separate
verification and deployment files. Local failure-injection tests establish queue
ordering, correct batching and safety. The official emulator checks transaction
behavior. Neither is physical phone acceptance.

After installing R17 over the existing app and opening it once online, measure:

1. Caller ringing to the operator's incoming alert, in foreground, background and
   locked state, including after the phone has been idle.
2. Outgoing Call tap to actual customer ringing, and Answer tap to first two-way
   speech in both call directions.
3. End on each side to actual remote media stop, including an immediate redial
   with an older cleanup request still retrying.
4. Transfer invitation to the target alert, then target Answer to audio handoff
   and source removal, plus decline, expiry and End during transfer.
5. Single-chat messages, bursts and multiple chats; no ended call may ring later.

The two-second/five-second physical targets remain unverified until those tests
are recorded. No customer was called or messaged automatically by this audit.

Official FCM reference:
https://firebase.google.com/docs/cloud-messaging/customize-messages/collapsible-message-types
