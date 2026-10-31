# Provider and FCM audit after R16

## Confirmed FCM delivery defect and correction

The R16 HTTP payload set a distinct `collapse_key` for every chat, call and
transfer. Firebase documents a maximum of four pending collapse keys per
registration token, with unspecified key retention beyond that limit. A newer
message with the same key may also replace an undelivered earlier message.
Those semantics do not fit distinct content-bearing chat/call/transfer events.

The correction omits `collapse_key` for those real data events. Notification
delivery tests alone keep one bounded key per device. Existing short call TTL,
durable delivery claims, exact identities and native terminal tombstones remain.
Removing collapsing does not make FCM ordered or prove delivery to a handset.
FCM's bounded non-collapsible queue also remains a platform constraint.

Official reference, retrieved during this review:
https://firebase.google.com/docs/cloud-messaging/customize-messages/collapsible-message-types

The new HTTP-level tests exercise the real `send` payload instead of the fixture's
injected delivery bypass. They cover six conversations, multiple messages in one
conversation, incoming/ended call and transfer pairs, replay suppression, stale
alert cancellation and the dedicated delivery-test payload.

## Remaining call latency budget

| Path | Sequential work before the real event |
| --- | --- |
| Incoming alert | Durable session/outbox claim and current-state checks → device eligibility/delivery claim → fresh device/session checks → OAuth when cold → FCM acceptance → handset delivery/render |
| Incoming Answer | Fresh server authority and durable owner claim → LiveKit/Meta Accept acknowledgement → native join response → Android room connection/publication → real media progress |
| Outgoing audio | Durable outgoing operation → provider dial → customer Answer webhook → durable one-shot SDP dispatch → provider Connect → actual media progress |
| Remote End | Durable terminal intent and cleanup claim → provider Disconnect → customer's media stack disconnect |

`acceptIncoming` already sends `waitUntilAnswered: false`; it requests a signaling
acknowledgement rather than waiting for customer audio. Native joining still
starts after that HTTP response. R15 production evidence recorded one provider
Accept at 2,243ms, so a universal two-second total cannot be inferred from fast
handset internet alone. This audit does not establish current R16 phone timings.

The pinned LiveKit SDK uses Node's global `fetch`; the application constructs and
reuses provider clients. There is no per-request custom agent disabling normal
connection pooling. `failover: false` prevents automatic regional mutation replay.
The configured 15-second provider timeout bounds a failed or uncertain request;
it is not an intentional successful-call sleep. Reducing it to two seconds could
create more uncertain call operations without making the provider act faster.

No new asynchronous prejoin protocol is introduced in this correction. Overlapping
native room setup with the durable provider Accept operation would require an
explicit protocol and terminal/ownership/recovery tests; that is different from
loosening the real audio-readiness gate or falsely displaying Connected.

## Verification limits

No external customer call, live test push or service configuration mutation was
performed by this audit. Existing real audio, expiry, ownership and revocation
gates must remain. A physical test measuring ringing, first two-way speech,
transfer completion and remote End is still necessary to establish the requested
two-second call and five-second transfer targets.
