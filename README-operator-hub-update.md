# Smart Handicrafts® Operator Hub r5 — GitHub/Render installation

This package targets `bb2d0860082171d791af74a6a2b57984e2ab8919` in https://github.com/AnkitSG07/AI-AGENT-DEBATE.

## Replace these three repository files

- `server.js`
- `public/operator-notifications.html`
- `public/operator-call.html`

The server replacement is required for outgoing recipient ACCEPTED/REJECTED processing and the foreground event stream. The final public check still reported the earlier call-routing-r3 server. Deploy the matching r5 backend before using the new embed.

`public/sh-operator-sw.js` is unchanged and should remain at its existing Render/GitHub path. No Odoo-domain root JavaScript or service-worker file is needed. The notification page remains device setup; actual calling stays in the main Odoo Hub. `/operator-call` hands off to that Hub.

## Replace the Odoo embed

Replace the complete old snippet on https://www.smarthandicrafts.com/livechat-api-test with `odoo/smart-handicrafts-whatsapp-embed.txt` from the ZIP. Keep one copy. Save/publish, then reopen the mobile shortcut.

Expected markers:

- Embed: `2026.10.28-ui-r5`
- `/api/whatsapp-calls/config` → `server_patch_version`: `2026-10-28-operator-hub-call-lifecycle-r5`

## Review and verification

The package contains a unified patch, `source-manifest.json`, the full notes, screenshots and test reports. The patch was checked against the exact recorded baseline and reconstructs all three replacement files byte-for-byte. Review newer repository changes before applying to a different revision.

No files in this package have been committed, deployed or published by this session. All call/UI regression tests are synthetic; real Meta audio, signed-in Odoo workflows and physical-phone/background push acceptance remain live validation steps. See `operator-hub-r5-notes.md` and `verification-report.md` for the specific boundaries.
