# R13 backend recovery review

The resumed review recovered unfinished R13 source beyond the previously
delivered R12 commit. This record covers backend authorization, AI state,
automated replies, documents and handover. It is local test evidence, not a
claim that Render, Odoo, Zoho, Google, Zapier or physical phones were tested.

## Current continuation verification (30 October 2026)

The second recovery resumed the actual R13 tree, rather than rebuilding the old
R12 candidate. Fresh outputs are under
`verification/recovery-current/backend/`. The older evidence below is retained
as history and is not added to the current totals.

The current review reproduced and corrected three additional exact-record
failures in the complete Express server:

| Defect | Reproduced result before correction | Current behavior |
| --- | --- | --- |
| An AI source grant for channel22 could use the first returned Odoo channel even when it was channel23. | The synthetic callback returned `posted: true`; the provider fixture received the send against the wrong channel. | The callback requires the exact numeric channel identity before claiming a receipt or sending. A mismatch returns409 `AI_CHANNEL_CHANGED`. After a correct read is restored, the original untouched grant can make its one authorized attempt. |
| A signed document41 link could serve bytes from a mismatched attachment response. | The preview returned200 and synthetic attachment72 bytes. | Both preview and download validate the current attachment ID. A mismatch fails closed with502 and cannot continue to a redirect or another binary fallback. |
| The direct document-binary fallback accepted a different document record. | A signed document41 preview returned200 and synthetic document42 bytes. | Both access actions require the exact document ID before decoding/serving the fallback. The valid exact-record fallback still succeeds. |

`identity-regressions-before.tap` contains the three expected failures against
the preserved implementation. The corrected full HTTP suite contains25 passing
tests and no skipped cases. These were local synthetic requests; no real customer
message or private document was sent or disclosed.

| Freshly executed suite | Passed |
| --- | ---: |
| Core storage/call tests |245|
| R12 call lifecycle/race tests |43|
| Reporting/retention tests |48|
| Browser authority tests |22|
| Actual call/push handler authorization tests |20|
| AI/memory/handover/final-send tests |27|
| Complete Express/private integration HTTP tests |25|
| Cloud revocation policy, answer contention, initial audio readiness, device availability units |33|
| Official Firestore SDK/local emulator call/storage tests |5|
| Official Firestore SDK/local emulator AI/handover tests |5|
| **Current backend total** |**473**|

`current-backend-report.json` records the final source hashes and individual TAP
hashes. The33 media policy unit tests belong to this total; do not add them again
when combining the independent SFU/Android reports. The first Node child-process
runner was blocked by sandbox `EPERM` and executed no tests; its files are
isolated in `sandbox-startup/` and are excluded from the passing count. Direct
unit execution succeeded, and the approved loopback-only HTTP/Firestore runs
succeeded. The owned Firestore emulator was stopped afterward.

The exact-record fixes modify the backend server and synthetic HTTP fixture,
not the call runtime, media provider, Android source, or Hub embed. Existing
real-media evidence must retain its own execution date and source-hash audit.

The backend source and local regression gate now pass. The existing coordinated
deployment requirements below remain: current production profile/callback
configuration, the actual Zapier reply-grant mapping, production Odoo field/ACL
and Firestore access, and the originally signed app/real provider acceptance.
This continuation did not authenticate to or mutate those production services.

## Recovered implementation

The R13 working source already contained scoped authorization for Zoho Mail,
Google Contacts, Documents and SH AI; signed recipient document links;
source-bound automated-reply grants; Firestore reply/handover receipts;
profile-bound OAuth state; and stricter independently authenticated provider
callbacks. Those changes were recovered and tested instead of discarded.

The R13 notes claimed that opening a second Hub merely reads the shared AI
mode. Inspection of the actual recovered embed contradicted that claim: both
startup and one sign-in recovery path still called the old forced-OFF routine.
The resumed frontend review corrected those actual call sites and added
startup/reconnection tests. Backend tests alone do not establish client
bootstrap behavior; see the frontend verification for that evidence.

## Additional defects reproduced and corrected

| Defect | Before-fix evidence | Corrected behavior |
| --- | --- | --- |
| AI writes could omit both epoch and revision, bypassing cross-device conflict checks. | The actual preserved R13 server accepted a stale unversioned OFF write with HTTP200 after another operator enabled AI. | Both `/api/ai-mode` and `/api/ai-mode/global` require a nonempty epoch and a nonnegative integer revision. Missing fields produce400; stale values produce409 with current state. Eight competing writes against the same revision produce one winner. |
| A fresh Odoo read could return a different channel, whose reply-window state was then trusted. | The document-sharing HTTP regression received channel23 for requested channel22; the pre-fix server still sent and returned200. | The reader validates the exact numeric record ID. The final message boundary also validates the channel before any dedupe reservation or send. |
| Odoo message-post results without a positive integer message ID were reported as successful. | A null message-post result produced `posted: true` on the preserved server; extracted production send-function tests reproduced the same defect for malformed acknowledgements. | The send boundary rejects absent/malformed acknowledgements. Automated replies retain an uncertain durable receipt, report503, and reject callback retries without sending again. Document sharing reports the unconfirmed outcome instead of success. |
| SH AI could report ON although its required Zapier reply secret was missing and every callback would fail. | The actual-server regression enabled AI with an empty callback secret and received200. | Enabling requires forwarding enabled, an environment-configured valid HTTPS webhook, nonblank reply secret, strong signing authority and Firestore receipts. Missing settings leave the mode/revision unchanged and return a specific503 configuration error. Both supported webhook environment aliases pass. |

These three regressions were run against a temporary copy of the preserved
pre-fix `server.js`; all three failed for the intended reason. They then passed
against the corrected source as part of the full HTTP suite. Historical
regression failures are intentionally retained and must not be counted as
current release failures or successes.

## Verification record

| Suite | Passed | Evidence |
| --- | ---: | --- |
| Core storage/call tests |245| `verification/r13/backend-review/tests__operator-r10.test.mjs.tap` |
| R12 call lifecycle/race tests |43| `verification/r13/backend-review/tests__operator-r12.test.mjs.tap` |
| Reporting/retention tests |48| `verification/r13/backend-review/reporting__test__operator-reporting.test.mjs.tap` |
| Browser authority tests |22| `verification/r13/backend-review/operator-browser-auth.test.mjs.tap` |
| Actual call/push handler authorization tests |20| `verification/r13/backend-review/tests__operator-call-security.test.mjs.tap` |
| AI/memory/handover/final-send tests |27| `verification/r13/backend-review/tests__operator-ai-r13.test.mjs.tap` |
| Complete actual Express server/private integration HTTP tests |22| `verification/r13/backend-review/private-after.tap` |
| Official Firestore SDK/local emulator call/storage tests |5| `verification/r13/firestore-review/tests__operator-r12-emulator.test.mjs.tap` |
| Official Firestore SDK/local emulator AI/handover tests |5| `verification/r13/firestore-review/tests__operator-ai-r13-emulator.test.mjs.tap` |
| **Total in this backend review** |**437**| Browser UI, Android and media suites are counted separately. |

The authoritative combined release run may supersede these focused logs after
other agents finish their changes. Do not add earlier25-test AI runs or18/20-test
HTTP runs to these totals; they are superseded versions of the same suites.

Before-fix evidence:

- `verification/r13/backend-review/private-regressions-before.tap`: three
  actual-server regressions, all failing on the preserved source as expected.
- `verification/r13/backend-review/ai-send-before.tap`: two additional
  assertions against the actual extracted send function, failing as expected.
- `verification/r13/backend-review/ai-send-after.tap`: corrected production
  function suite,27 passing tests.
- `verification/r13/backend-review/ai-configuration-before.tap`: missing
  callback-secret enablement reproduced before adding the configuration gate.

The HTTP fixture runs the full server and its actual middleware order. All
external provider fetches are intercepted with explicit synthetic fixtures;
unknown outbound requests are refused. The fixture binds only127.0.0.1. It now
starts children without inherited test-runner flags, limits local HTTP/IPC
waits, and reports listener startup errors instead of silently hanging.

The sandbox initially denied listener creation. That unsuccessful startup is
recorded separately in `sandbox-startup-blocked.tap`; it is not a code-behavior
result. Auto-reviewed execution of the isolated loopback tests then succeeded.
The Firestore emulator used a512MiB Java heap and was shut down after the tests.

## Deployment compatibility requirements

1. Deploy the matching R13 backend, Odoo embed and authenticated popup/helper
   together. Old anonymous mail/contacts/document/AI requests are deliberately
   rejected. Do not restore anonymous routes as a compatibility shortcut.
2. Verify strong `PROFILE_SESSION_SECRET` and the existing authorized Render
   profile passwords through a protected configuration/readiness path. Never
   copy secret values into source, logs, the embed or this report.
3. Establish a new operator services session during the coordinated upgrade
   when an existing R12 grant has only call scopes. Renewal intentionally never
   increases the scopes of an earlier grant.
4. Keep AI manual until the Zapier reply step maps the new `ai_reply_grant`
   unchanged and retains its configured secret header. The source-bound grant
   cannot be safely replaced by a legacy callback exception. Configure the
   existing valid webhook in `ZAPIER_INCOMING_WHATSAPP_WEBHOOK_URL`, or its
   supported legacy alias `ZAPIER_WEBHOOK_URL`. The old hardcoded catch URL
   fallback is removed; it must not be copied into a release report.
5. Preserve valid current Firestore credentials and use the new receipt
   collections. Emulator success does not establish production IAM or remote
   connectivity. TTL timestamps do not enable a Firestore TTL policy.
6. Verify existing Meta and Odoo callback secrets before switching traffic.
   Missing authentication now fails closed; provider callbacks remain
   independently authenticated and do not require browser operator login.
7. Configure only verified active internal Odoo user IDs for human handover.
   A device name is not a user ID. The receipt proves activity creation at most;
   it does not prove that a human received a push or read the activity.
8. Verify the production Odoo models, fields and access rights separately. The
   tests use the documented source contract and synthetic provider records.
9. Publish the matching native call-status protocol before installing the R13
   Android candidate. The waiting-call transition reads `deviceAvailable` for
   an ordinary incoming call and `deviceAvailableForCall` for the exact current
   transfer invitation. A transfer's own reservation must not be described as
   globally free. Missing or malformed fields fail visibly before the current
   audio is ended; the atomic Accept operation remains authoritative after any
   status observation. These fields prove neither production reachability nor
   physical call continuity.

An acknowledged local mode change is not a remote Zapier delivery check. The
backend status endpoint exposes configuration booleans, while actual remote
service delivery and the current Zap workflow remain separate release gates.

No customer calls, messages, emails, quotations, activities, notifications or
production records were created by this review.
