# SH Chat R24 candidate

R24 keeps optional work outside voice Answer, End, and microphone setup.

- Recording copies authorized local and remote PCM from the phone's existing LiveKit room. It adds no recorder participant. Sinks attach only when recording is selected. Mixing, private durable upload queue, Odoo writes, and retry scheduling run away from call control. Both transfer phones need R24 to continue device recording. Private operator handover audio is excluded; this interval is silent in the recording. Sequential private WAV parts are played by the existing recordings screen.
- Hold workers prepare only after selecting **Transfer with message**, while the device picker is open. They do not hold the customer until the normal invitation commits. Unused preparation closes after 20 seconds; completed hold and recorder workers disconnect without waiting for archival uploads. Direct transfer uses neither preparation nor a hold worker.
- App settings show estimated monthly LiveKit participant minutes from updated phones, workers, and customer call records. Uploads are cumulative and idempotent in Odoo, with no Firestore usage-counter polling. Estimates omit earlier/unobserved usage and initial customer setup time, and do not measure bandwidth. LiveKit Cloud remains authoritative for its 5,000-minute / 50-GB allowance; this view does not prevent exhaustion or rotate accounts.
- Odoo attachment uploads refresh a stale CSRF token once only after an explicit invalid-CSRF rejection. Ambiguous failed writes are not replayed. Actual session expiry preserves text drafts for the same Odoo user and requests sign-in. Permission errors do not masquerade as session expiry. Native room audio remains independent of the WebView session.

## Optional private video links

Video is disabled by default and requires all three server settings:

- `SH_VIDEO_LINKS_ENABLED=true`
- `SH_VIDEO_TURN_KEY_ID`
- `SH_VIDEO_TURN_API_TOKEN`

Configure a Cloudflare Realtime TURN account and review its free allowance and billing behavior before enabling. No paid plan or billing is enabled by the code. Credentials stay on the server; browsers receive temporary relay credentials. The user shares the **customer** link; the customer opens it and grants camera/microphone access. This is a separate browser video call, not a WhatsApp Business video call.

The native operator screen supports mute, camera off, camera switch, speaker, End, picture-in-picture, and an ongoing notification. It cannot run concurrently with a voice room on the same phone. Video signaling uses bounded in-memory events and Server-Sent Events, without LiveKit or Firestore. A restart expires links. Invitations expire after 10 minutes, calls after 30 minutes. Only two participants can claim each link; video transfer, merge, and recording are not implemented.

## Verification

Run `node scripts/verify-r13.mjs unit http browser` with the pinned Playwright tool and Chromium, and Android `bash gradlew :app:testDebugUnitTest :app:lintVitalRelease :app:assembleRelease`. Real media is separately checked by `tests/simulator-media-r13/real-media.test.mjs` and `call-tools-media.test.mjs` using isolated services, synthetic participants, and no production credentials.

The workspace can run browser UI tests but disallows the network-interface inspection needed by the local SFU and local WebRTC ICE. Run those media checks in GitHub Actions or the isolated verification service. Do not treat infrastructure-blocked runs as passes. Passing isolated tests does not establish real-phone latency; verify with both enrolled phones on the actual mobile/Wi-Fi paths.
