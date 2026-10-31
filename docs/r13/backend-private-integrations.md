# R13 private integrations, automated replies and handover

This guide describes the repository implementation and local evidence. It does
not certify the deployed Render service, current Odoo database, Zapier flow,
OAuth registrations, or phone delivery. No real customer message, email, call,
push, quotation, or activity was created by these tests.

## Release identity and required rollout order

`GET /api/operator-app/version` is public and returns only release/protocol
identity. R13 reports `2026-10-30-operator-hub-r13-private-integrations`,
`expected_hub_ui_version: "r13"`, and
`expected_hub_ui_build: "2026.10.30-ui-r13"`. A valid Render-provided
`RENDER_GIT_COMMIT` is exposed as `build_commit`; otherwise it is `null`.
Authenticated `GET /api/ai-mode/status` also reports the release identity and
configuration booleans. A configured boolean checks local configuration; it is
not a successful remote-service health check.

Deploy the compatible backend, R13 Hub embed/helper, and Android auth-popup
implementation together. The private service APIs intentionally reject old
anonymous clients. Browser capabilities issued before R13 retain their old
scopes on renewal; explicitly establish a new operator session after the upgrade
if the old grant has only call scopes. The Odoo website login remains the
authority for same-origin Odoo workflows. Render operator sign-in is separate
and supplies bounded authority to its own integrations.

Preserve correct existing environment values. `.env.example` contains blank
placeholders, not a ready-to-paste production credential set. Configure missing
values in Render's environment, not in Git, HTML, a URL, or an APK.

## Private HTTP boundary

All guarded requests run through middleware before the existing handlers and
before static fallbacks. Authentication failures return JSON with a deliberate
status/code, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, and
`X-Content-Type-Options: nosniff`. They do not redirect AJAX to an HTML login page.

| Surface | Authority |
| --- | --- |
| `/api/zoho-mail` and descendants | `mail:read` for GET/HEAD; `mail:write` for mutations |
| `/api/google-contacts` and descendants | `contacts:read` or `contacts:write` |
| `/api/odoo-documents` and descendants | `documents:read` or `documents:write`; email sharing also requires `mail:write` |
| `/api/ai-mode` and descendants | `ai:read` or `ai:write` |
| Legacy call, lock, transfer, device-presence, call-log routes and `/api/debug/webhooks` | Existing call read/write scopes |
| `/api/odoo` and `/api/labels` tools | Signed Render `Smart handicrafts`, `Accounts`, or `SUDO` profile; exact same-origin JSON writes; derived role |
| Private self-training/telemetry/knowledge admin readers | Signed Render profile, using the same private-tool guard |
| `/zoho/auth`, `/zoho/callback`, `/google-contacts/auth`, `/google-contacts/callback` | Signed `Smart handicrafts` or `SUDO` profile; callback state bound to the initiating profile and session expiry |
| Document view/download with valid `share` token | Exact document/action grant, described below |

The exact private profile tools are `/api/self-training`,
`/api/self-training/feedback`, `/api/product-bot/self-training`,
`/api/product-bot/routing-telemetry`, `/kit-ai-knowledge-status`,
`/kit-ai-training-selection-values`, and `/kit-ai-approved-rules`.

`PROFILE_SESSION_SECRET` must contain at least 32 non-whitespace characters.
Use a generated random secret. The private boundary does not fall back to
concatenated profile passwords. Fresh grants require the existing Render
`Smart handicrafts` or `SUDO` password login and an exact allowed Hub origin.
Access lasts at most 10 minutes; authenticated renewal cannot exceed the original
profile grant, up to two hours. Renewal preserves the actor, origin and scopes.
Secrets/capabilities stay in memory and Authorization headers. The server replaces
client-supplied actor, device, session, role and toggle-author aliases where they
would otherwise reach a private handler.

The native enrolled bearer remains inside Android. It is accepted on only the
existing projected call-history reads; it does not gain mail, contacts, generic
Odoo RPC, or legacy call-control privileges. Android's new isolated sign-in
popup obtains the same scoped browser grant used by the Hub. The popup has no
native bridge and uses the exact opener/origin/state handshake. The server auth
page remains self-contained and needs only its existing profile-login and token
API calls. See `operator-browser-auth.README.md` for the full protocol.

Profile passwords are configured through `PROFILE_PASS_SMART_HANDICRAFTS`,
`PROFILE_PASS_SUDO`, and, for the existing finance tools,
`PROFILE_PASS_ACCOUNTS`. Capabilities are stateless. Client logout clears its copy;
it does not revoke a stolen copy at the server. Rotating `PROFILE_SESSION_SECRET`
invalidates existing browser capabilities, document links and AI reply grants.

## Independent provider callbacks

Provider callbacks are not forced through browser login:

* Odoo sale-confirmed aliases require the existing `ODOO_WEBHOOK_SECRET`.
* `/api/zapier/reply` requires `ZAPIER_REPLY_SECRET` and the new source-bound
  `ai_reply_grant`, below.
* Meta webhook POST aliases require a valid signature over the exact raw body.
  Configure the existing `META_WHATSAPP_APP_SECRET` (the existing
  `WHATSAPP_APP_SECRET` and `META_APP_SECRET` aliases remain supported).

Missing callback authentication fails closed with 503; invalid configured
authentication is rejected. This fixes paths that previously accepted callbacks
when the secret was empty. Existing Odoo callback authentication headers and Meta
verification paths are preserved. Signatures are checked before provider effects.

Zoho/Google OAuth state is single-use and bound to the initiating profile session.
Zoho's returned accounts-server cannot redirect a token exchange to a different
host: it must match the configured accounts base. OAuth token exchange and Zoho
refresh credentials use POST form bodies. A Zoho read may refresh and retry after
401; a send/reply mutation is never automatically replayed after 401, timeout, or
lost acknowledgement. An ambiguous result needs inspection of Sent mail before
the operator chooses whether to send again.

## Signed document links

Document DTOs now contain `view_url`, `download_url`, and `link_expires_at`.
Both URLs always use this backend and include `?share=shd1...`, even for a URL
document or an older Odoo portal-link mode. No raw Odoo access token is exposed
in the DTO. The link authorizes one record and one action for seven days; it
cannot list documents, access a second ID, become a download grant, or authorize
a POST. Expired links return 410. Whoever receives the link can use it until
expiry; this is an intentional recipient-sharing capability, not operator login.

The handler re-reads the exact active document. Binary previews use a sandbox
content policy and no-store headers. Unicode filenames are encoded safely for
HTTP Content-Disposition. URL documents are redirected only to a valid HTTPS
URL without embedded credentials; download query parameters preserve fragments.
Document failures return generic plain text to recipients, not provider exception
HTML. Underlying externally hosted URL documents retain the permissions of that
external host after redirect.

`POST /api/odoo-documents/share` ignores a caller-provided link and generates the
link from the requested document ID. It re-reads the selected Odoo conversation
immediately before posting. WhatsApp requires a current future reply-window
expiry; an active flag alone is insufficient. Closed WhatsApp windows cannot be
bypassed by choosing the `chat` alias. Live Chat posts retain
`message_type: "comment"`; WhatsApp uses `"whatsapp_message"`. The same fresh
channel check protects server automated free-text replies. Template sending does
not override this check or establish a reopened window.

## SH AI state and the required Zapier migration

The server starts in `manual` with a new unpredictable epoch. The visible
operator toggle remains OFF/ON → `manual`/`zapier`. Hidden modes remain disabled
unless the existing explicit configuration permits them. Merely opening another
R13 client reads the server mode; it does not write OFF over another operator.
The Hub displays and changes the authoritative mode after connecting services.

Read `GET /api/ai-mode`, then send one mode representation and its revision:

```json
{
  "mode": "zapier",
  "expectedEpoch": "epoch-from-the-last-read",
  "expectedRevision": 0
}
```

`POST /api/ai-mode` and `/api/ai-mode/global` reject malformed/conflicting mode
fields. Every write requires both a nonempty `expectedEpoch` and nonnegative
integer `expectedRevision`; omitting them returns 400 `INVALID_AI_REVISION` and
cannot bypass cross-device arbitration. A stale revision or epoch returns 409
`AI_MODE_CHANGED` with the current state.
Every accepted write increments revision. AI mode lives in the one backend
process; R13 does not claim distributed multi-instance mode coordination. A server
restart deliberately returns to manual and invalidates old outstanding grants.

Enabling Zapier requires forwarding to be enabled, a configured HTTPS webhook
without embedded credentials, a nonblank reply authentication secret, a strong
signing secret and the Firestore-backed receipt runtime. Missing configuration
returns a specific503 error without changing the shared mode. The status
endpoint reports configuration booleans and a blocker code without returning a
secret or the webhook URL. This check does not prove live Zapier delivery.

Set `ZAPIER_INCOMING_WHATSAPP_WEBHOOK_URL` to the existing valid webhook in the
server environment; the older `ZAPIER_WEBHOOK_URL` alias remains supported when
the primary setting is empty. The old source-embedded fallback URL is removed.
Deployments that relied on that fallback must configure their existing valid URL
before re-enabling AI. Do not paste it into Git, an embed or a report.

Incoming messages need a valid Odoo timestamp strictly later
than the enable time. The old five-second historical grace is removed. The worker
captures an epoch/revision lease and rechecks it after asynchronous work, before
forwarding, and at the final free-text send boundary. Internal decision-engine
calls execute the actual handler directly rather than bypassing HTTP auth through
an anonymous loopback request.

The existing incoming Zapier payload now includes `ai_reply_grant`, `ai_epoch`
and `ai_revision`. **Map one additional field in the Zap's reply step:**

| Reply JSON field | Source in the incoming trigger |
| --- | --- |
| `odoo_channel_id` | Existing `odooChannelId` |
| `reply` | Existing generated reply text |
| `ai_reply_grant` | Exact incoming `ai_reply_grant`, unchanged |

Keep the existing `x-zapier-secret` header. The optional epoch/revision fields can
also be echoed, but cannot replace the grant. Do not construct or transform the
grant in Zapier. There is no unauthenticated or legacy-grant bypass. The deployed
Zap must be updated before re-enabling AI; its current configuration has not been
verified in this task.

Each grant expires after ten minutes and binds the exact incoming Odoo message,
channel, source timestamp, enable time, epoch and revision. The reply handler
re-reads that source and verifies it is an incoming customer message in the exact
channel. Newer conversation content, including human intervention, rejects the
old decision. OFF, OFF→ON, a restart, changed source, missing/expired grant, closed
reply window or unavailable durable receipt state prevents a send.

A Firestore transaction claims one reply attempt for the exact source. Repeated
completed callbacks with the same text acknowledge the existing outcome. Different
text conflicts; pending, blocked and ambiguous attempts do not reopen a send slot.
If the provider accepted a message but its response was lost, the system cannot
prove delivery: it keeps an uncertain receipt and requires inspection, rather than
resending. This is at most one automated attempt per source/revision, not a claim
that two independent systems can provide atomic exactly-once delivery. An Odoo
message arriving in the unavoidable interval after the final read and before the
post is not prevented by a database transaction spanning both systems.

The final send boundary requires the freshly read Odoo channel ID to match the
requested conversation, and a successful `message_post` result must be a positive
integer message ID. Missing, malformed or lost acknowledgements never become
`posted: true`; automated attempts keep an uncertain durable receipt and cannot
silently resend on a callback retry. Document sharing uses the same checked
channel and message acknowledgement boundary.

## Persistent memory and human handover

The existing backend model/field contract is exactly:

* Model: `x_ai_operator_memory`
* Context field: `x_studio_context_json`

This source creates, reads and updates that exact field. Large context is now
bounded as valid JSON instead of slicing an arbitrary serialized string, and the
handover hold is retained with priority. Prototype-mutating keys are excluded
when parsing stored context. These are source/fixture tests; the fields and model
access rights in the current production database still require verification.

Set `SH_AI_HANDOVER_USER_IDS_JSON` to a JSON object mapping verified team keys to
positive active internal **`res.users` IDs**, not contact IDs, phone numbers or
registered-device names. Allowed keys are `test`, `ankit`, `kushagra`, `vibhu`;
`khushagra` is accepted as an alias. No live IDs are guessed. `{}` is a safe empty
mapping and means no automatic activity delivery.

The dispatcher validates the current internal user, re-reads the exact channel,
resolves its existing customer from authoritative Odoo links, checks the active
partner, and resolves the To Do activity type. It creates a `mail.activity` on
that customer assigned to the configured user, with an escaped internal note.
Missing recipient mapping, unlinked customer, model/type problems or unavailable
storage leave the handover marked as needing delivery; they never create a guessed
contact. A durable per-source/team receipt prevents duplicate activities across
competing callbacks or controller recreation. An ambiguous activity create stays
pending for reconciliation instead of being retried blindly.

An activity record is not proof that a person saw a push/email. The response
therefore reports `activity_created` separately and always keeps
`human_notified: false`. An existing text field containing an intended notification
is also not proof of delivery. The authenticated status endpoint exposes mapped
team keys and configuration booleans, not credentials or guessed recipients.

The public Kit AI feedback route remains available but can only create pending,
public-source feedback. Approved training requires either the existing independent
`TRAINING_ADMIN_KEY` or a signed same-origin JSON request from `SUDO`. Status/source
selection resolution now fails closed if the required Odoo option is missing;
it cannot silently promote pending public feedback to approved admin knowledge.

## Firestore configuration and retention boundary

Reuse the server-only Firestore runtime:

* `SH_ANDROID_REGISTRY_BACKEND=firestore`
* Existing correct `SH_ANDROID_FIREBASE_PROJECT_ID`
* Existing correct private `SH_ANDROID_FIREBASE_SERVICE_ACCOUNT_JSON`
* Existing database/prefix, or defaults `SH_OPERATOR_FIRESTORE_DATABASE=(default)`
  and `SH_OPERATOR_FIRESTORE_PREFIX=sh_operator`

New collections are `<prefix>_ai_reply_receipts` and
`<prefix>_ai_handover_receipts`. Receipts contain source IDs, hashes, actor routing
and outcome metadata; the AI reply receipt does not store the full customer reply.
Each receipt has a Firestore timestamp `deleteAfter` set to 30 days. **This field
does not activate a Firestore TTL policy or prove scheduled deletion.** No TTL
policy, production IAM change, export job or deletion was applied here. Keep
receipts long enough to prevent retries; do not delete active device identities
or unresolved receipts as part of a call-history export. The separate reporting
and archival subsystem has its own export/retention behavior; these new receipt
collections are not automatically included in those exports.

## Reproducible local verification

Use the pinned Node 24 runtime and installed lockfile dependencies:

```sh
node --test-reporter=tap operator-browser-auth.test.mjs
node --test-reporter=tap tests/operator-call-security.test.mjs
node --test-reporter=tap tests/operator-private-integration.test.mjs
node --test-reporter=tap tests/operator-ai-r13.test.mjs
```

The new private suite starts the **complete actual Express server** in a temporary
directory, including its real middleware order and handlers. Every external
request is intercepted; unknown outbound requests fail before networking.
Odoo/Zoho/Google and that suite's storage transport use synthetic fixtures.
It exercises anonymous denial, signed grants, scope isolation, actor derivation,
OAuth state, provider signatures, fresh reply windows, signed links, no mutation
replay, revision conflicts, exact-source Zapier callbacks, and pending-only training.

`tests/operator-ai-r13.test.mjs` additionally executes actual extracted server
functions for the worker, send boundary, persistent memory and handover log, plus
the production grant and activity dispatcher modules. It covers concurrency,
lost acknowledgements, enable cutoffs, mode races and valid bounded JSON.

`tests/operator-ai-r13-emulator.test.mjs` runs the actual Firestore SDK against an
explicitly local `demo-sh-operator-r12` emulator. It refuses to run unless
`SH_R12_EMULATOR_TESTS=1` and `FIRESTORE_EMULATOR_HOST=127.0.0.1:8089` are set. It
tests twelve competing AI claims, receipt recovery, epoch invalidation, eight
competing handovers and ambiguous Odoo acknowledgement recovery. Odoo remains a
counted local fixture. The R13 verifier includes this suite alongside the existing
five call/storage emulator cases. Use `scripts/run-firestore-r13.mjs` for an owned
emulator lifecycle; never point these tests at a real Firebase project.

Local successful tests do not establish live Zapier mapping, Odoo field/ACL
compatibility, external OAuth consent, production Firestore permissions,
background notification delivery or two-phone audio transfer. Those remain
separate observed deployment/device gates in the overall R13 report.
