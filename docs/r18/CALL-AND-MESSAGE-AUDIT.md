# R18 call and message audit

## Measured R17 phone-test server timing

| Stage | Server elapsed |
| --- | ---: |
| Incoming webhook ingestion | 2,040 ms |
| Incoming FCM dispatch | 1,869 ms |
| Answer API | 6,640 ms |
| Provider Accept inside Answer | 2,282 ms |
| Ready API | 2,535 ms |
| Transfer invite API | 4,827 ms |
| Transfer FCM dispatch | 1,896 ms |
| Transfer Accept API | 3,970 ms |
| Transfer Ready API | 5,894 ms |
| End API | 2,827 ms |
| Provider disconnect request | 1,486 ms |

These measurements are from the real R17 test on 31 October 2026 around 10:52–10:53 UTC. They are server stages, not handset audio timings. The End-start to provider-disconnect acknowledgement interval inferred from the server timestamps was approximately 5.77 seconds.

Firestore metadata confirmed asia-south1 (Mumbai); the Render service is in Oregon. Warm point reads repeatedly took about 250–300 ms and transactions around 800 ms. Multiple sequential trips account for a material part of call delay. The Free instance also cannot assure immediate service after inactivity. A nearby always-running host is the prepared next step, requiring approval for its new recurring cost.

## Shipped code changes

Ordinary call admission no longer enumerates the transfer pilot. Accept, Ready, End and Transfer overlap the initial credential check with their non-authoritative session lookup, while final post-authentication state reads remain ordered to observe End. Transfer invite performs one fresh controller authentication with an explicit server-created source binding instead of two consecutive duplicate authentications. No credential cache, ownership bypass, premature Connected state, or removal of audio proof is used. Existing End/SDP/FCM priority lanes and background history projection remain in place.

Notification scanning runs when native push is enabled even if the AI worker is disabled. Raw incoming notification candidates are independent of AI processed/preboot/cooldown filters; fresh message bursts are considered before AI work. Internal Odoo chats can notify without invoking AI. Ledger observation is asynchronous and coalesced so it cannot hold FCM delivery. Durable per-device delivery deduplication and enrollment fences remain.

SH Chat now keeps team-wide app read state in a separate Firestore collection. Odoo website seen flags never clear it. A focused, resumed, prepared app may acknowledge only messages visible in the selected chat. Each mutation includes a server state version; stale delayed reads cannot overwrite a newer manual unread. UUID, worker-lag, manual-reopen, viewport, overlay, credential and ordering races are covered. A bounded historical incoming-message batch is conservatively seeded; old chats may become unread once because historical app views cannot be reconstructed.

The last observed R17 message events were accepted by FCM for two phones each with no send errors. Acceptance is not phone receipt. R18 Settings shows the last received message push, native post/rejection result, and blocked/quiet message-channel status, with a direct channel-settings button. It sends no background diagnostic polling or customer test pushes.

## Validation and limits

746 backend/HTTP checks, 13 official Firestore-emulator checks and 255 Android JVM tests in 29 suites passed. Clean release lint and assembly passed. APK signature, existing release certificate, 16 KiB alignment, version 18 and exact supplied-logo pixels were verified. Full browser regression launch was blocked because the expected Chromium executable is absent; all 128 affected browser cases failed their startup hook before application assertions. The focused unread frontend logic suite passed 20 tests and the live Odoo source is verified separately during publication.

Actual handset FCM receipt and the requested two-second calls / five-second transfers are not claimed as achieved. The proposed Singapore service starts in an isolated read-only preflight, then requires controlled worker/routing cutover. No hosting resource, billing plan, database location, Meta callback or LiveKit project is changed by the migration draft.

Official references: [Firestore latency guidance](https://firebase.google.com/docs/firestore/best-practices), [Render regions](https://render.com/docs/regions), [Render Free limits](https://render.com/docs/free), [Blueprint references](https://render.com/docs/blueprint-spec#referencing-service-properties).
