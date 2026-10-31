# SH Chat R16: actual call latency and notification delivery

R15 had responsive call UI but slow server actions. Render production timing
records from the R15 commit show Accept at 8,586ms, transfer invitation at
9,239–9,667ms, transfer acceptance at 9,434ms, transfer readiness at 11,347ms,
and End at 4,274ms. These are server action durations, not acoustic or total
handset-to-handset measurements. The provider's successful Accept was 2,243ms;
individual participant inspections took 439–845ms. Low observed CPU/memory
usage does not suggest CPU or memory saturation as the cause of those samples.

## Critical path corrections

- Authenticate current credentials using one batched, fresh read-only Firestore
  transaction. The token's device ID is only a read selector. The digest, index,
  active generation, matching device, expiry and revocation still authorize it.
  Opaque imported tokens retain their indexed lookup. No past readTime, grace
  period or cross-request credential cache is introduced.
- Batch independent absent-only record reads within media transactions, keeping
  snapshot consistency, immutable records and atomic reservation validation.
- Reuse a committed provider-operation result during initial call setup, then
  retain the final fresh authentication and current-state checks before joining.
  End wakes durable cleanup and returns its own committed terminal snapshot
  without waiting for extra response-projection reads.
- Evaluate the production transfer policy once in the controller gate instead
  of repeatedly enumerating the registry in nested authorization wrappers.
  Check other involved devices in parallel and retain fresh credential rechecks.
- Skip an expiry mutation when the already-read call has no due transfer. The
  action's transaction independently checks the current transfer and expiry.
- Keep no-op stopped-invitation reconciliation off normal invite/accept/ready
  responses. Durable recovery still handles terminal invitation alerts.
- Perform independent final call/session reads together after final credential
  authentication, and reuse that canonical record in the response projection.
- R16 transfer Answer sends the exact immutable invitation ID directly. The
  server atomically checks target, enrollment binding, current invitation,
  expiry and state. Older versioned clients retain their existing contract;
  R16 falls back only after an older server explicitly requires a version.
- Inspect provider participants once per transfer readiness operation. Only the
  exact, same-provider, same-room, fresh server-held observation may be consumed;
  copied, client-invented, old or cross-provider data requires a fresh lookup.
  Exact track identities, source, mute state and real native RTP proof remain.

Connected continues to require genuine audio evidence. Ownership, transfer
handoff, revocation and terminal-state precedence remain authoritative. UI text
and shorter artificial timers are not used to claim faster audio.

## R15 notification regression

R15 assigned a group to every message notification but omitted the group summary
when only one chat was active. Android requires an explicit group summary even
on current Android versions. R16 corrects that rendering contract, including
the single-chat summary's sender, preview and exact conversation deep link.
The summary is silent; it must not produce a second audible alert.
This is a confirmed code contract defect; its contribution to the user's
specific missing handset alerts has not been proven by physical-device traces.

Official platform reference:
https://developer.android.com/develop/ui/views/notifications/group

The old message receive path could also permanently deduplicate a message before
its notification was successfully rendered. R16 handles rendering outcomes and
records safe diagnostics rather than silently losing that failure. Final tests
and detailed changes are recorded in verification.json.

The existing generic Web Push no_subscribers log refers to browser subscriptions.
It does not establish whether the independent native FCM branch sent, failed or
skipped a message. Native delivery diagnostics must distinguish those outcomes.

## Measurement and acceptance

Server diagnostics separate authentication, policy, durable storage and provider
operations. Native diagnostics separate room connection, microphone publication,
first real evidence and server-versus-outside-server HTTP time. Diagnostics use
fixed stage names and durations; they do not log customer text, IDs, SDP, tokens
or credentials. They are observations, not audio-readiness signals.

The user's target is actual ringing, Answer-to-two-way-audio and remote End within
two seconds on fast device internet, with transfer allowed four to five seconds.
Those targets have not been measured as achieved on
physical phones in this environment. Local tests establish ordering and safety,
not a mobile carrier, FCM, Meta or media-cloud latency guarantee.

Install the R16 APK over the existing R13/R14/R15 fresh-release app, then open it
once online. Keep the existing Odoo embed. Retest a single-chat message, several
messages, two chats, foreground/background and locked state; then measure real
incoming/outgoing audio, both-direction hangup and transfer A→B→A. Compare the
same stage timings to the R15 observations before claiming the target is met.
