# SH Chat R14 call latency correction

## Observed deployment and scope

The starting production commit was `be45a0c457262df9fa864ffa2c32dc8630379ac0`
on `AnkitSG07/AI-AGENT-DEBATE/main`, observed live on Render deployment
`dep-dbippbp5efls73d9pul0`. Its source matched the delivered R13 source tree
(the Windows Gradle wrapper used normalized line endings). This was already R13;
deploying R13 again would not explain or resolve the reported delays.

Reported problems: outgoing setup takes 5–10 seconds, remote hangup can lag,
local End returns to chat while the customer remains connected, incoming alerts
arrive late, and transfer invitation/audio setup take several seconds.

Production logs showed genuine connect/accepted/terminate webhooks but did not
contain per-stage latency measurements. Those logs do not establish the exact
phone-to-phone delay or attribute all of it to one component. The observed Render
service uses a free instance in Oregon. No hosting plan, region, database or
billing setting was changed.

## Corrections

- Dispatch an already-persisted outgoing SDP answer before eligibility/presence
  housekeeping. Retain the original one-shot operation and durable job lease.
- Dispatch a committed transfer invitation before slower housekeeping. FCM and
  outgoing signalling use separate lanes. An End during a stalled transfer push
  can still reach the customer cleanup lane.
- Skip irrelevant incoming-alert claims when a terminal call needs cleanup.
- Reuse the registry row from the immediately preceding authentication of the
  same request, avoiding a redundant read. Every authorization recheck still
  authenticates afresh. Target-device and recovery reads remain durable; no
  time-based credential cache or revocation grace was introduced.
- Read independent reservation records together inside their existing atomic
  transactions. Fetch the bounded transfer-device list concurrently and read
  its policy once, rather than rereading the entire registry for each phone.
- A currently owned immutable call leg may End without a preliminary status GET.
  The server atomically checks the same enrollment, ownership and leg. Versioned
  callers and unowned Reject retain their existing version checks. Old legs and
  other phones cannot use this to end the new owner’s call.
- The Android cleanup queue attempts that exact-leg End directly. It falls back
  to the versioned R13 contract if the older server returns STALE_CALL_VERSION.
  Transfer-target cleanup retains its status check, because it must distinguish
  declining a joining invitation from ending an already committed owned leg.
- Give Android End/Decline a dedicated executor, separate from Hub history and
  registration work. Persist cleanup before attempting it, keeping OS retries.
- Sample initial real RTP/decoded-audio evidence every 500ms until the first
  valid observation, then return to the original 1000ms interval. Minimum sample
  duration, track/room identity, ICE/DTLS, fresh counters and transfer proof remain
  enforced. This changes observation cadence, not the meaning of Connected.

The final call-state read remains AFTER a potentially slow credential recheck.
A new regression demonstrates that doing those particular operations in parallel
could return a join response after End. That ordering is preserved. General
parallelization must not weaken terminal-state precedence.

## Diagnostics

The server emits SH_CALL_TIMING for control actions (and slow status reads),
SH_CALL_PROVIDER_TIMING for connector/control operations,
SH_CALL_WEBHOOK_TIMING for durable event handling and provider-event age at
ingress, and SH_CALL_PUSH_TIMING for alert fanout. Successful controls also expose
Server-Timing. Android logs fixed action names and elapsed time under SHCallTiming.
No credentials, room tokens, SDP, request bodies, customer numbers, device IDs or
call IDs are included in these timing records.

These records distinguish provider-to-server delivery, durable state work,
connector calls, FCM fanout and phone control round trips. They cannot establish
acoustic speech timing without an actual phone test.

## Verification and limits

The focused latency regressions cover blocked housekeeping, competing one-shot
SDP dispatch, exact-leg End, wrong-owner/obsolete-leg rejection, fresh registry
rechecks, transfer push stalled during End, bounded device-list reads, timing-log
privacy and End during a slow final enrollment recheck.

The full backend/HTTP/unit execution result is recorded separately. Test providers
and accounts are synthetic. Browser execution on this host is blocked by the
sandbox denying Chromium's local Unix socket creation; this is not a browser
acceptance pass. Physical phones, Meta, real FCM delivery, LiveKit Cloud audio,
locked-screen behavior and the user's actual network latency remain live
acceptance work. No customer was called or messaged by this verification.

The Android package is versionCode 14 / 1.0-r14. It must be signed with the same
fresh-release certificate as the delivered R13 APK, whose SHA256 is
`4bb1e06ee31a93cbd5ccc27b5c26862eb782ea9dff773e2e73fa0d73bfc2fb7a`.
That identity differs from the old R11 key. An R13 fresh-release installation can
update in place; an old-key R11 installation cannot.

The Odoo embed and its expected R13 UI build are unchanged by this native-call
patch. Server release identity may still name the R13 private integration
protocol; use the deployed Git commit and Android version to identify this patch.

## Physical acceptance to record

1. Outgoing: Call tap → recipient ring → recipient Answer → first two-way speech.
2. Both directions: End tap → local audio stop → remote call ended, including End
   during setup and an immediate redial.
3. Incoming: caller ring → alert received in foreground/background/locked state →
   Answer → first two-way speech. Confirm an ended call never appears connected.
4. Transfer A→B→A: Invite → target alert → target Answer → audio at target → source
   removal; source stays until fresh target audio proof. Decline and failed target
   preserve the original customer conversation.

Record the stage timings before deciding whether a remaining delay comes from
code, provider delivery, hosting location, radio/network setup or the handset.
No fixed physical-phone latency guarantee follows from local synthetic passes.
