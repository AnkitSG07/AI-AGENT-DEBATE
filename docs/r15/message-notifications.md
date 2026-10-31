# SH Chat R15 message notifications

## Problem and resulting behavior

R14 sent Android message IDs and a chat URL, without sender or message text.
The Android renderer filled in fixed "New customer message" / "Open SH Chat"
labels. Opening the correct chat already worked; the notification itself could
not show the requested preview because its payload did not contain one.

R15 adds bounded sender names and plain message previews to the verified incoming
worker's FCM data for devices advertising native build 15 or later. Existing
R13/R14 devices retain their ID-only payload. Opening R15 refreshes its registered
FCM token/build metadata using the existing device enrollment.

The native notification uses Android MessagingStyle with the actual sender,
message text, initials avatar, timestamp and up to eight recent delivered
messages. Different chats have distinct notifications and immutable deep links.
Two or more chats receive a local inbox summary. Group conversations keep their
conversation title separate from the message author. Textless attachments use
photo/audio/video/attachment labels when that metadata is available.

Fresh out-of-order messages are accepted once within a bounded 32-ID replay
window per chat, rather than dropping every ID below the last received ID.
History is sorted by message timestamp/ID; an older arrival does not overwrite
the newest preview. The upgrade retains the previous APK's deduplication floor.
Replay state is capped at 128 chats and displayed notifications at 24 chats.

Tapping a message opens its exact conversation. Local removal affects only that
conversation; a stale tap cannot clear a newer message. Dismissal updates the
summary. These UI actions do not fabricate a server read receipt or send a reply.

## Data boundaries

- Trusted-source, exact channel/model, freshness, device eligibility, per-device
  receiveChats and durable delivery claims remain required on the backend.
- Names and text come from verified worker records. HTML markup, scripts, styles,
  comments and layout-control characters are stripped; Unicode and emoji remain
  readable within byte/code-point limits. Native delivery performs no additional
  customer-message fetch, so rendering does not add a network round trip.
- Preview text is kept in Android's bounded notification history, not a new
  application preference/database or diagnostic log.
- A private notification has a generic public version. Android's permission,
  lock-screen privacy, muted-channel, sound and importance choices are honored.
  The existing sh_messages_v1 channel is reused; its settings are not reset.
- Notification/shortcut publication and enrollment changes share a final
  credential-generation fence. Logout or replacement enrollment removes message
  previews/shortcuts and replay state. A delayed callback for an old enrollment
  cannot recreate the previews. Call notifications are unaffected by that cleanup.

## Release and verification

Android package: com.smarthandicrafts.operatorhub, versionCode 15 / 1.0-r15.
This release includes R14's call-path corrections without modifying the call
runtime or its audio-readiness/ownership gates. The R13/R14 fresh-release signing
certificate is preserved, allowing an in-place upgrade over those APKs.

Backend tests cover plain names/text, HTML/Unicode, byte limits, fallback/media
labels, rich versus legacy payloads, correct chat routing, duplicate callbacks,
trusted-source checks, channel checks and receiveChats opt-out. Android tests
exercise the actual NotificationCompat/Android serialization under Robolectric
on API 26, 28 and 35, including permission denial, immutable intents, per-chat
history, summary/dismissal, replay/reordering, upgrade migration and logout races.
Exact final results and APK identity are recorded in verification.json.

No physical phone, actual FCM delivery, vendor lock-screen behavior or real call
timing was measured on this host. Local synthetic/Android JVM results are not a
physical-device acceptance pass. No customer messages/calls are sent by tests.

## Phone acceptance after updating

1. Install R15 over the existing R13/R14 app and open it once while online.
2. Send a real incoming message from another phone with SH Chat in foreground,
   background and locked state. Check sender and preview according to Android's
   notification privacy settings.
3. Send several messages and messages from two contacts. Expand the notification,
   check order/grouping and tap each chat; the intended contact should open.
4. Dismiss one conversation and verify the remaining chat/summary. Log out and
   verify that previous message previews disappear.
5. Repeat R14's outgoing, incoming, both-direction hangup and transfer timing
   acceptance. Record actual delays and the safe SH_CALL_* stage timings.

Inline Reply/Mark as read and customer profile-photo retrieval are not introduced
by this release. It implements the requested sender/text previews and native
conversation behavior without advertising actions lacking a native send/read
authorization contract.
