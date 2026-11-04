# Production storage migration completed

Verified on 4 November 2026.

- The private `sh-chat-state` Worker and SQLite Durable Object are deployed.
- Production imported and checksum-verified **920 records** before activation.
- The imported manifest SHA-256 is
  `8ca789b12dd74d67a1de2172af332ed830aed7d9269b0002648815739ca6983e`.
- All **8** existing device registrations were preserved: **3 active**, **5 revoked**.
  Active devices retain build 25, credential expiry/generation and configured FCM tokens.
- Storage write/read verification passed after activation; LiveKit control was reachable.
- Render now uses `SH_ANDROID_REGISTRY_BACKEND=cloudflare` directly, with migration
  administration disabled. Starting the application no longer needs a Firestore
  gate read or a Firestore client.

Odoo continues to hold customer messages and Odoo sessions. Cloudflare holds
operator device credentials, call coordination, app unread state and report data.
Firebase remains the FCM notification provider. Existing APK and Odoo embed HTTP
contracts are unchanged; this update requires no APK replacement or reenrollment.
The old Firestore data is retained as a backup; production does not fall back to it.

The existing private archive adapter keeps its compatibility name and locator
format, but its injected database is now Cloudflare. The administration page calls
this a private database archive to avoid presenting that legacy name as the
current storage provider.

Validation includes the isolated Render verifier's 1,231 passing checks, followed
by the expanded 131 migration/storage checks, 4 official SDK/emulator transaction
races and the 25 Worker placement tests. Live production checks confirm storage,
registration preservation and media control configuration. They do not replace
physical phone checks of notification receipt or two-way audio, and do not prove
a fixed end-to-end call latency.

Provider quotas, Render cold starts, handset background restrictions and external
media/network latency still apply. No paid plan was enabled for this migration.
