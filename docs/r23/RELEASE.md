# SH Chat R23 — call setup and control latency

R23 starts the operator's real room connection while the provider processes Answer or Dial. R22 waited for the provider response before starting that connection. The device still reports Connected only after verified audio/transport readiness and, for outgoing calls, customer acceptance.

Changes:

- R23 devices receive the exact, authenticated room/leg token immediately after durable ownership is claimed. The sole provider operation continues in parallel. Legacy devices retain the previous response contract.
- Initial readiness is bound to the immutable operator leg, nonce, room, customer and reservation. Harmless provider acknowledgements no longer cause stale display-version retries. Terminal, revoked, different-leg and expired proofs still fail closed.
- A newer authoritative status can immediately reuse an unexpired audio sample. Each request copies the sample and retains its original capture time, avoiding both fabricated freshness and repeated aging.
- Customer disconnect and operator detach use independent durable leases and run concurrently. Terminal ring cancellation remains independent of both.
- Connected phones receive a targeted room-data wake after transfer decisions and provider setup. The packet contains only `refresh`; it cannot change call state. Android retrieves authenticated state before acting, and polling remains the fallback. Customer devices are excluded.
- New audio routes restart the 500 ms initial evidence cadence and wake sampling after subscription/routing, avoiding the ongoing-call health interval during handover.
- Mute, speaker, background calls, notes, recording, private handover, merge, hold music and the existing logo are preserved. AI remains disabled; this release adds no idle Firebase polling or database listeners.

Deployment: install the signed R23 APK on both/all operator phones and open the app once so enrollment metadata reports build 23. This backend change is backward compatible. The Odoo embed does not need changing for R23.

## Evidence and limits

The pre-change production logs on 2026-11-02 showed provider Answer at 1,930 ms, Dial at 2,782–3,156 ms, disconnect at 1,248–1,537 ms, and separate readiness requests rejected as `CUSTOMER_NOT_ACCEPTED` and `STALE_CALL_VERSION`. An incoming event completed ingestion at 13:57:28.174 UTC and FCM submission at 13:57:28.813 UTC. Provider timestamps have one-second granularity; FCM acceptance is not proof of handset receipt.

Validation records are in `verification.json` and `apk-verification.json`. The Android suite now blocks all unstubbed NativeApi connections, including late background cleanup; synthetic tests cannot send device credentials or requests to the live backend. The isolated media suite uses real SFU/WebRTC/RTP and generated tones, with a simulated WhatsApp connector and local Firestore emulator. It does not contact customers or production Firebase.

No physical two-phone timing run was available in this work session. The 1–2 s normal-action and 4–5 s transfer budgets remain handset acceptance targets, not measured guarantees. Provider/Meta/FCM latency, device wake-up and network setup can exceed them. In particular, overlapping work removes app-added delay but cannot turn a measured 3 s external Dial request into a guaranteed sub-2 s request.

For handset acceptance, measure actual two-way speech after Answer, remote silence/disconnect after End, alert arrival while foreground/background/locked, and target speech plus source detach for both instant and private transfers. Confirm mute/speaker and returning to any chat while audio continues. Include End during setup and an immediate callback.
