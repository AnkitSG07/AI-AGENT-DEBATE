# Smart Handicrafts Operator Hub — R13 embed

The complete self-contained HTML/CSS/JavaScript delivery is
**smart-handicrafts-whatsapp-embed-r13.html**. Its adjacent TXT copy is byte-identical.
Existing IDs, Odoo session requests and business tools are preserved. R12 files
remain as the previous review checkpoint, not the current delivery.

## Publish one compatible release

1. Back up the current Odoo embed and record its loader URLs.
2. Deploy the matching backend using the R13 private-integration migration guide.
   Check the public /api/operator-app/version marker. Pin Node to .node-version;
   an existing Render NODE_VERSION variable takes precedence over that file.
3. Sign the Android candidate with the **existing release key** and verify the
   original certificate. A newly generated key cannot update the installed
   production package while preserving its identity.
4. Replace the old Odoo embed with the entire R13 file. Do not append another
   copy. If your page uses a GitHub/Render loader, publish this exact revision
   behind a versioned URL and verify the returned code and MIME type. The native
   Android path needs no script or service worker on the Odoo domain root.
5. Open the Hub menu and use **Connect operator services**. Odoo retains its
   session for chats, contacts, quotations and activities. Render uses a separate
   short-lived scoped connection for calling, Zoho, Google Contacts, Documents
   and SH AI. Android supports its authorization window without exposing the
   enrolled device bearer to page JavaScript.
6. Check **Interface r13** and **2026.10.30-ui-r13** on mobile and desktop. A
   backend marker alone cannot establish the embed/APK version. Refreshing a
   shortcut cannot replace code that has not been published.
7. Complete the release checklist using the signed app and designated internal
   test phones. Local simulations do not establish that a production provider
   accepted a call or delivered a push.

No server secret, enrollment code, private key or Odoo password belongs in the
embed or a GitHub-hosted JavaScript file.

## R13 changes

- Prevent duplicate quotation, group, broadcast, document-share and mail actions
  while the first submission is pending. Do not automatically replay an
  uncertain provider mutation.
- Capture the original customer, message, draft and share recipient across
  awaits. Old contact searches, mail folders, document imports and editor saves
  cannot replace or close a newer screen.
- Revalidate the captured WhatsApp channel's reply window before free text,
  attachment and document sends. Templates do not reopen that window.
- Load beyond 250 conversations and page older than 160 messages; preserve
  expanded history and reading position across polling.
- Require current signed exact-record document links and show expiry clearly.
  No anonymous raw-ID URL fallback.
- Bundle integrity-verified DOMPurify 3.4.17 for email HTML. Remove active content,
  forms, embedded media and global styles while retaining readable formatting.
- Reconcile authoritative AI state across devices. A stale-device toggle uses
  the server epoch/revision and requires another explicit action after a
  conflict. Default OFF remains explicit; an unconfirmed write is visible.
- Retain stable keyed message/photo/call rendering, contact info, label colors,
  system theme, native call controls, exact call/attempt/leg IDs and local End
  return behavior from the verified R12 work.

## Repeat the verification

Use Node.js 24.22.1, install the repository dependencies with npm ci, and install
test-only Playwright 1.62.1/Chromium. Set SH_PLAYWRIGHT_MODULE and SH_TEST_CHROMIUM
to their absolute paths. From the repository root run:

    node scripts/sync-hub-r13.mjs
    node scripts/verify-r13.mjs unit http browser

The runner writes logs, source SHA-256 values and report.json under
verification/r13/current. It requires zero failed/skipped cases and unchanged
source during a run. Browser tests intercept every network request and use
invented records. Actual-server HTTP tests exercise the production Express routes
and authentication middleware with external Odoo/Zoho/Google services substituted.

See tests/simulator-media-r13/README.md for actual local audio decoding and
handoff tests. Android unit, notification and WebView instrumentation tests live
under android/operatorhub. The GitHub workflow repeats these groups on separate
runners, avoiding software-emulator/audio contention.

After editing public/operator-browser-auth.js, run sync-hub-r13.mjs before
testing/distributing. It synchronizes the inline helper and TXT; it publishes
nothing. The release checklist records actual results and remaining live checks.
