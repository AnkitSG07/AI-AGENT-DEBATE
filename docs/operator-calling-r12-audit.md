# Operator calling R12: backend audit and regression record

Audit date: 2026-10-29. Baseline: public `main` commit `8b863b7638acfa8c981c67ca536a0c0c83a46b94` (R11).

This is the backend portion of the coordinated R12 change. The Android engine, WebView bridge, Odoo embed, and browser authentication changes have separate owners and validation records. No customer call, live push, provider mutation, production deployment, or device enrollment was performed by this audit.

## Result

The audit reproduced call-state and cleanup races, added 43 focused regressions against the actual production modules, and fixed them without changing the media protocol, minimum production native build, rollout flags, administrator enrollment policy, or messaging/business workflows.

Final verification on the production Node engine, **18.20.8**:

| Suite | Result | What it establishes |
| --- | --- | --- |
| Published R10/R11 backend baseline | 245/245 passed | Existing registry, gateway, provider, call coordinator, transfer, and media-store behavior remains covered. |
| R12 backend regressions | 43/43 passed | Lost acknowledgements, event ordering, terminal/owner races, notification timing, enrollment metadata, and safe cleanup. |
| Existing reporting suite | 48/48 passed | Reporting and archive behavior remains compatible. |
| Official Firestore 8.7.1 SDK against a local Firestore emulator | 5/5 passed | The new transaction/read/write ordering and race handling also work with the real SDK. |

Fifteen regression cases were recorded failing before their corresponding fixes. Eight failed against the untouched baseline; seven additional failures were found during the deeper race audit. The machine-readable inventory identifies them. Tests use synthetic provider/notification effects; they do not prove live audio, real FCM delivery latency, or physical-phone handoff.

## Fixed behavior

### Answer response loss and outgoing event ordering

An incoming provider Accept request can succeed while its HTTP acknowledgement is lost. The old coordinator then kept the session uncertain and refused a useful retry. Recovery now inspects the exact stored customer participant in the exact room. Fresh provider presence can recover the original join credentials and readiness nonce without sending another Accept. Presence alone never marks audio Connected; the normal readiness checks still apply. Customer termination, an expired joining deadline, and changed enrollment remain authoritative.

An outgoing SDP answer could arrive before the dial response established the provider-call route. It was previously dropped when no opaque correlation was present. Verified early answers now have a bounded, private, immutable pending record. The dial result or later trusted correlation consumes it in the same transaction that checks terminal and customer-accepted markers. Different answers cannot silently replace the first one. A terminal event received first prevents a later answer from connecting the call.

Connect is now recorded as an issued provider operation before sending SDP. An uncertain response is reconciled rather than blindly replayed. Actual readiness can settle a successful unknown response. A definite rejection ends the call. If End races an already in-flight Connect, the reservation is retained; late settlement queues a compensating disconnect for that exact old call. No later call or newer operator leg is targeted.

### Immediate alert cancellation and independent media cleanup

The first native Answer ownership transaction now records an alert-cancellation job and wakes recovery before waiting for the provider Accept response. Other enrolled phones stop ringing through the existing native `engine: livekit`, `event: ended` notification. This event cancels the incoming alert; it is not a command to hang up an established native room.

Media disconnect and participant detach run before compatibility history, notification retries, and report projection. History projection remains ordered and coalesced per call but no longer holds up media cleanup. A stalled first-answer cancellation cannot hold up a revoked owner's cleanup.

A failed notification used to keep a fully settled pre-media call's device reservation busy. Notification work is now excluded from the media-release prerequisite. Release still requires confirmed termination, no uncertain provider operation, successful media cleanup, and the exact matching session/device/identity reservation. Failed detach or a still-issued Connect continues to hold the reservation. Notification retries remain durable after the device becomes available again.

### Exact media-leg ownership

Authenticated call responses now include `call.ownerLegId`. End accepts optional `expectedOwnerLegId` and refuses a different current leg with `CALL_LEG_CHANGED`. The terminal transition, canonical call state, and reservations are updated coherently rather than through a split pre-media/canonical path.

An old queued End from device A must not terminate a later A → B → A ownership leg. The original outgoing request cancellation likewise refuses to end an ownership leg created by a subsequent transfer. An unanswered transfer's unused target reservation is released when the customer call ends.

Credential checks now use the exact current media-leg binding. Re-enrolling the same physical device does not authorize the old credential's call. Recovery can derive a committed transfer's exact binding from canonical transfer history if the redundant session update was interrupted. An invitation is not treated as revoked merely because recovery runs between the canonical invitation transaction and its session-binding write. Eligibility reads the session and canonical owner coherently, avoiding a stale-snapshot cancellation of a newly committed owner.

### Enrollment, stale offers, and bounded Decline

Fresh registration and authenticated FCM-token refresh now preserve the validated native build and media protocol. This makes a newly enrolled supported phone eligible before it has opened the main Activity and performed a later capability request. Administrator invitation labels remain authoritative. Existing enrollment fingerprints and one-use invitation replay behavior remain unchanged; retrying a consumed invitation cannot mutate an established credential through new metadata.

Incoming ringing expiry is bounded by the trusted provider event time. An offer delivered 89 seconds after it occurred has about one second remaining, rather than receiving another 90-second window. FCM payload expiry is also bounded by the exact incoming/transfer deadline. Future timestamps cannot extend the normal incoming window.

The native Reject path uses a separate fixed-origin Meta adapter with an abortable 10-second HTTP deadline and sanitized errors. It confirms rejection only on an explicit successful provider response. A verified customer terminal event settles an unneeded queued Reject without another Graph mutation. The legacy browser provider adapter is unchanged by this patch.

Owned calls retain a 15-second durable eligibility deadline while still joining, so enrollment revocation/expiry is not deferred until the full joining timeout. Internal route/event keys now accommodate the documented 220-character provider-call ID plus their private prefixes; public call-ID limits do not change.

## API compatibility and rollout

- Protocol remains `sh-room-audio-v1`; production minimum native build remains 10. New calls still require the existing server-owned rollout policy and supported enrolled device. No environment flag was enabled here.
- New field: `call.ownerLegId` on status and ordinary join responses.
- New optional End input: `expectedOwnerLegId`. R12 must persist the leg captured for that call; it must not overwrite it with a later leg when retrying a queued End.
- R11 End without leg metadata remains accepted on the original leg and a device's first transferred-to leg. After that same device has a different earlier leg in the same call, ambiguous legacy End is rejected with `CALL_LEG_REQUIRED`. The operator must use the updated app/rebind explicitly; silently applying an old End to the new call would be unsafe.
- `MEDIA_REQUEST_UNCERTAIN` includes `sessionId`. `CALL_OPERATION_PENDING` may omit it for an already-issued incoming Answer: the client already has the exact incoming call ID and should resume that ID. Neither result authorizes a new dial key or another provider Accept.
- Native first-answer notification cancellation uses the existing ended-alert contract. The established audio session is ended through authenticated call state, participant detach, and provider terminal events.
- Provider/room tokens, SDP, stored credentials, and private pending-answer records are not added to public history/status DTOs. Join credentials remain restricted to the authenticated owning leg.

The coordinated R12 browser authentication patch is separate. The baseline legacy call/history/lock routes were not protected by a sufficient authenticated actor; CORS and device-supplied presence are not authentication. The root integration must deploy the compatible scoped browser capability path and native sanitized history proxy together with the corresponding embed/APK. This lifecycle patch does not claim to resolve that independent security issue by itself.

## Audited production surfaces

| File | Functions/behavior inspected |
| --- | --- |
| `call-runtime/call-runtime.mjs` | Authentication, binding and rollout gates; incoming/connect/accepted/terminate ingestion; ordinary accept/dial/reject/end; ambiguous-result reconciliation; readiness; transfer wrappers; canonical/session terminal state; outbox leases; eligibility/presence; reservation release; legacy arbitration and verified Odoo channel metadata. |
| `call-runtime/routes.mjs` | Bearer API dispatch, sanitized errors, immediate durable-work wake-up, version/identity inputs. |
| `call-runtime/startup.mjs` | Real provider construction, configuration probe versus readiness distinction, rollout gating, device-bound transfer validation, native Reject wiring. |
| `call-runtime/readiness.mjs` | Fresh schema/nonce/room/identity/track evidence, packet/PCM/transport checks, provider participant corroboration, client evidence limits. |
| `media/transfer-controller.mjs` | Invite replay, exact version/actor validation, target reservation, explicit accept, source preservation, readiness commit, decline/cancel/expiry, terminal monotonicity, detach-only cleanup, retry leases. |
| `media/livekit-provider.mjs` | Pinned official SDK calls, incoming/outgoing connector semantics, exact participant identities, scoped operator tokens, participant detach, customer disconnect, inspection and safe provider errors. |
| `media/errors.mjs` | Identifier limits and safe typed error contract. |
| `media/native-meta-reject.mjs` | Fixed provider origin, exact call/business request, timeout, explicit acknowledgement, redacted errors. |
| `media-store/firestore-media-store.mjs` | Transaction staging and read ordering, monotonic terminal/version invariants, immutable operations/events/outbox targets, pending/owner/cleanup reservations, recovery projections and leases, bounds. |
| `operator-firestore-registry.js` | One-use enrollment and replay, administrator names, credential generation/expiry/revocation, metadata refresh, delivery claims, deduplication and current-device checks. |
| `operator-android-push.js` | Registration/token routes, capability metadata, native incoming/transfer payloads, deadline bounds, high-priority delivery configuration, exact delivery claims and terminal suppression. |
| `operator-media-gateway.js` | Trusted raw-body Meta signature verification, event extraction, runtime startup/rollout, native bearer identity, incoming dispatch/recovery, state projection, legacy arbitration and native-history ownership. |
| `server.js` calling sections | Raw-body webhook/signature entry, native ingestion ordering, call normalization, incoming/outgoing/accepted/terminal projection, provider Graph adapter, legacy Answer/Reject/End, SSE/presence/lock/disabled legacy-transfer routes, call-log aliases, native read adapter, runtime mount/start/close. Changes to the root auth integration are reviewed separately. |

The gateway, runtime, provider, controller, readiness verifier, store, registry, and push modules were read as complete functional modules. `server.js` is a large multi-feature server; this audit reviewed the calling integration and route families rather than claiming every unrelated line was audited. The exact test list and source hashes are in `docs/operator-calling-r12-verification.json`.

## Running verification

Install the existing locked dependencies using Node 18.20.8, then run:

```sh
npm run test:operator-storage
npm run test:operator-reporting
```

The storage runner executes the published baseline and the new R12 suite in separate processes, using the actual repository production imports. The browser-auth suite is separate:

```sh
npm run test:operator-call-auth
```

For the SDK integration suite, first start a local Firestore emulator at `127.0.0.1:8089` with project `demo-sh-operator-r12`, then explicitly opt in:

```sh
SH_R12_EMULATOR_TESTS=1 FIRESTORE_EMULATOR_HOST=127.0.0.1:8089 npm run test:operator-r12:emulator
```

The integration test refuses any other host and uses the hardcoded demo project. Its provider calls and notification transport are synthetic. It requires no live credentials.

## Physical acceptance still required

Use two enrolled operator phones A/B and a separate actual customer WhatsApp endpoint C. Do not substitute a synthetic call-log row, FCM receipt, SDK configuration probe, or local test telemetry for this check.

1. Customer C calls; A and B ring. A answers once. B's incoming alert stops. Both A and C exchange unique spoken phrases, and the timer starts only after confirmed customer acceptance/media readiness.
2. A invites B. A ↔ C audio remains usable while B is ringing. B explicitly accepts; during warm handoff there may be a brief authorized overlap. After readiness and ownership commit, B ↔ C exchange new phrases and A returns to chat with its microphone released.
3. Disable A's network or power A off. B ↔ C must continue for at least a minute. End on B; C ends, B returns to the correct chat, and a new call succeeds without a stale busy error.
4. Repeat for outgoing calls and transfer back B → A. Queue/delay an old A End to confirm it cannot terminate the new A leg. Decline, timeout, cancel, target offline/busy, microphone denial, simultaneous answers, and customer hang-up during transfer must preserve the valid source call or leave the whole call terminal as appropriate.
5. Exercise locked/background/terminated app, Wi-Fi ↔ cellular, headset/Bluetooth, network loss/recovery, and a control-server redeploy while media stays on its independent provider. Record invite receipt, button feedback, actual audio start, handoff interruption, remote end, and final chat return timestamps.

No numerical real-device latency or audio-quality claim follows from the automated results. Immediate local Answer/Decline/End feedback and microphone/UI teardown are Android/UI responsibilities verified in the separate R12 app work; server/provider settlement still depends on network responses, truthful terminal events, and bounded retries.
