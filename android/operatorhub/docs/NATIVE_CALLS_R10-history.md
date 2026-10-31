# SH Chat R10 native audio integration

## Scope and release gate

This Android source contains an audio-only LiveKit client, a microphone foreground service, a native incoming/active call screen, real notification actions, and a warm transfer flow. It preserves the R9 WebView calling path when the authenticated Render capability is disabled. App version remains **10 / 1.0-r10**; the release owner signs the APK with the existing app key.

The native path requires an authenticated `GET /api/operator-android/capabilities` response with `capabilities.nativeRoomCalls: true`, `protocol: "sh-room-audio-v1"`, and `minimumNativeBuild <= 10`. Transfer controls also require `transferEnabled: true`. A received push, an HTML constant, an SDK connection acknowledgment, or an enrollment request never enables the server release flag.

**Automated verification is not a real WhatsApp call test.** Physical Android incoming/outgoing calls, microphone routing, lock-screen delivery, OEM battery restrictions, and the source-phone-offline transfer proof must be checked with two enrolled operator phones plus a separate real WhatsApp test-customer endpoint. No customer calls or messages were sent during these local tests.

## Android behavior

- A native incoming notification offers Accept and Decline. Accept opens the native Activity, verifies current capability/device authorization, obtains microphone permission in the foreground, and starts the microphone foreground service. No microphone is requested merely because FCM arrived.
- Decline and End stop the local alert/audio immediately. A credential-bound saved cleanup request performs the corresponding server action. A storage/network failure retains the request for bounded immediate retries and another attempt on app foreground/startup.
- Ending while the outgoing call ID is still unknown sends the original request ID to the server's cancellation-tombstone route. The client never creates another dial request after local End.
- The room service owns audio independently of the Odoo WebView. Going back to the Hub leaves the native call active. Final SDK disconnection and explicit local End release microphone tracks, the room, audio routing/focus, and the foreground notification, then return to chat.
- A transient SDK Reconnecting event displays Reconnecting. It has a bounded recovery window. Final Disconnected is separate and closes local audio immediately.
- A media join is displayed as Joining or Transferring. Connected and the timer require fresh media evidence plus the server's authoritative readiness/ownership result.
- Notification updates and capability events are emitted only when their content changes. The Activity updates its timer text separately; call-state polling does not rebuild the full screen or notification each second.
- Device lease renewal remains intact. Only a matching dispatched device credential can be invalidated by 401. A transient 503 does not erase enrollment. Enrollment and FCM-token updates report `nativeBuild`, `mediaProtocol`, and native client support; authenticated API requests also include `X-SH-Native-Build` and `X-SH-Media-Protocol`.

## Warm handoff

Phone A remains connected while B receives a distinct transfer invitation. B must explicitly accept before joining or obtaining microphone access. B subscribes only to the exact customer identity supplied by the authenticated server. Its microphone publication permits that customer identity to subscribe; it does not grant all room participants access.

There may be a brief overlap in which both authorized operators can speak to the customer. This implementation is a warm handoff, not a private consultation feature. B sends the exact call/leg identity, nonce, version, and fresh media observations. The server commits the owner change before detaching A. A's final SDK detach returns it to chat without terminating the customer. A's saved End request, if one races that transfer, rechecks current ownership and cannot end B's call.

Declining, cancelling, or timing out B before commitment leaves A with the customer. If B's local End races a successful ownership commit, B ends its now-owned customer call; an old notification Decline does not become a customer hangup after acceptance. Terminal and monotonically versioned server state wins over late ringing/accept callbacks.

## Media evidence

`NativeRoomEngine.kt` uses the pinned official **LiveKit Android 2.29.2** SDK. It observes the microphone publication, the exact remote customer audio track, per-track RTC stats, publisher/subscriber transport stats, and decoded PCM-frame callbacks. The PCM data is neither saved nor sent; only counts are used.

The readiness payload is:

```json
{
  "version": 7,
  "readinessNonce": "server-generated-challenge",
  "evidence": {
    "protocol": "sh-room-audio-v1",
    "legId": "exact-authorized-leg",
    "identity": "exact-operator-identity",
    "roomName": "exact-room",
    "participantSid": "PA_...",
    "localAudioTrackSid": "TR_...",
    "customerIdentity": "exact-customer-identity",
    "customerAudioTrackSid": "TR_...",
    "sampleDurationMs": 1000,
    "sampleAgeMs": 10,
    "outbound": { "packetsDelta": 10, "bytesDelta": 400 },
    "inbound": { "packetsDelta": 10, "bytesDelta": 400, "decodedFramesDelta": 48000 },
    "iceState": "succeeded",
    "dtlsState": "connected"
  }
}
```

Samples must cover 500–5000 ms, be at most 2000 ms old at transmission, have increasing RTP packets/bytes in both directions and decoded customer frames, and report connected DTLS plus a succeeded selected candidate pair on both transports. The server corroborates participant/track identities and current ownership. This is authenticated SDK telemetry, not hardware attestation or proof that a human heard the other person. The live acceptance test must include spoken phrases in both directions.

An intentionally muted, already-established call may recover its local UI after fresh received customer audio and transport checks. That path never submits initial bidirectional readiness to the server.

## Render contract

All requests stay under the fixed HTTPS Render API origin and use the enrolled native bearer. Odoo cookies, user passwords, device bearers, and room join tokens are never passed through the JavaScript bridge.

| Route | Client use |
| --- | --- |
| `GET /capabilities` | Current supported native protocol/build and release gates |
| `POST /calls/outgoing` | `{to, requestId}`; retries retain the original request ID |
| `POST /calls/outgoing/:requestId/cancel` | Cancel the exact original outgoing attempt even before its provider ID exists |
| `GET /calls/:id/status` | One in-flight request, approximately once per second during an active call |
| `POST /calls/:id/accept` | Obtain/recover the same authorized leg; never redial on a lost acknowledgment |
| `POST /calls/:id/ready` | Exact nonce/version and fresh SDK evidence |
| `POST /calls/:id/reject` | Reject only an unowned incoming ringing call |
| `POST /calls/:id/end` | End only while this device still owns that call |
| `GET /devices?callId=...` | Available registered targets with supported build/protocol |
| `POST /calls/:id/transfers` | `{toDeviceId, version, requestId}` |
| `POST /calls/:id/transfers/:transferId/accept` | Exact invitation/current version; returns join and nonce |
| `POST /calls/:id/transfers/:transferId/ready` | Commit readiness for the exact transfer leg |
| `POST /calls/:id/transfers/:transferId/decline` | Decline only this pending target invitation |
| `POST /calls/:id/transfers/:transferId/cancel` | Source cancels its pending invitation |

Success responses use `{ok:true, call:{sessionId,callId,providerCallId,phase,version,ownerDeviceId,roomReady,transfer,...}}`. A join response also includes `{join:{url,token,roomName,identity,legId,customerIdentity},readinessNonce}`. `transfer.status` and `transfer.id` are the canonical fields. Only an HTTPS-controlled canonical `wss://<project>.livekit.cloud` join origin is accepted.

## FCM and Hub entry points

Native ordinary calls use `type: "sh_operator_call"`, `engine: "livekit"`, `event: "incoming" | "ended"`, exact `call_id`, `issued_at_ms`, `expires_at_ms`, and the canonical Hub deep link. Transfers use a separate `type: "sh_operator_transfer"` and an exact `transfer_id`. The local deduplication/tombstones for a transfer are separate from the earlier incoming call. An `ended` push silences an alert; it never directly terminates an established room leg.

The existing same-origin bridge remains:

```js
window.SHNative.postMessage(JSON.stringify({
  type: "native-call",
  action: "start",
  phone: "919999000001",
  channelId: 101,
  displayName: "Customer"
}));
```

Other supported actions are `open`, `transfer`, `accept`, `reject`, `callback`, and `end` with an exact `callId`; `dial` opens a native number form. `incoming` opens the sole stored pending native invitation for explicit acceptance. If multiple or no invitations can be identified, the app asks the operator to choose the correct incoming notification; it does not guess a customer.

The app publishes `window.SHNativeCapabilities` and `sh-native-capabilities`, including the protocol, build, feature flag, and non-secret active call ID/state when present. It refreshes the authenticated capability on foreground with a 60-second UI cache and verifies again before each new answer/start.

Native local release also emits `sh-native-call-closed` with `{localReleased:true, callId, providerCallId}`. This is a local microphone/room release event, not confirmation that the remote customer leg ended. The R10 embed closes only the focused matching call panel and suppresses stale ringing for that exact ID. The compatibility asset can close only panels with an actual DOM call key; it leaves unkeyed older panels and unrelated overlays alone. The Activity returns the exact known source `channelId` through the existing Odoo-authorized conversation navigation. Without a channel, it preserves the current conversation. Stale keyed End controls retain their original call ID and cannot end a newer native call.

The packaged `sh-native-room-bridge.js` also supports the observed R8/R9 DOM without requiring an immediate Odoo embed update. It intercepts only trusted clicks on known call controls while native capability is enabled. It reads the explicit chat phone subline, contact profile phone, dial input, or exact call-key attribute. It never extracts a phone from a contact name or uses the currently selected customer as the destination for a different call-history row. Earlier history entries unknown to the native server open a native number form. The old R9 transfer guard remains in place for legacy browser transfer routes; real transfer is available in the native call screen.

## Verification and remaining physical checks

The adjacent `NATIVE_CALLS_VERIFICATION.json` records the clean build plus final incremental return-cleanup build, test counts, source hash, and unsigned APK hash. Android unit tests cover media readiness, URL constraints, call epochs/version ordering, delayed callbacks, End/commit races, notification-decline semantics, and the existing session/lease policies. Offline Chromium tests exercise the packaged entry bridge against a synthetic fixture containing the observed R8 control markup.

No Android handset, Android emulator, actual WhatsApp audio, locked-screen acceptance, Bluetooth hardware, or carrier/Wi-Fi transfer was tested here. Run the release checklist in `work/firestore-r10/media/TWO_PHONE_ACCEPTANCE.md`, including an A→B transfer followed by disabling A's network/power while B and the customer continue speaking. Only that test can establish independent handoff on the actual phones and deployment.

Official API references used: [Android SDK](https://github.com/livekit/client-sdk-android), [Room stats](https://docs.livekit.io/reference/client-sdk-android/livekit-android-sdk/io.livekit.android.room/-room/), [remote audio track/sink](https://docs.livekit.io/reference/client-sdk-android/livekit-android-sdk/io.livekit.android.room.track/-remote-audio-track/), [subscription permissions](https://docs.livekit.io/reference/client-sdk-android/livekit-android-sdk/io.livekit.android.room.participant/-local-participant/set-track-subscription-permissions.html), and [audio routing](https://docs.livekit.io/reference/client-sdk-android/livekit-android-sdk/io.livekit.android.audio/-audio-switch-handler/index.html).
