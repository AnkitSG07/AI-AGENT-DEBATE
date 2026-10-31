# Protected operator calling and private services — R13

This server-only module protects the existing browser call routes and the Hub's
Zoho Mail, Google Contacts, Documents and SH AI integration routes. It does not
replace native room calling, the native device registry, Odoo login, or the
existing Render profile-password authority. An Odoo UID, Origin header,
presence heartbeat, build number, or device label is never sufficient authority.

## Integration contract

```js
import {
  createOperatorBrowserAuth,
  createProfileLoginLimiter,
  constantTimePasswordEqual
} from './operator-browser-auth.js';

const operatorBrowserAuth = createOperatorBrowserAuth({
  secret: process.env.PROFILE_SESSION_SECRET,
  readProfileSession, // Existing verified signed cookie -> {profile, exp}, or null.
  authenticateNative: async (rawBearer, req) => {
    const device = await operatorFirestoreRuntime.deviceRegistry.authenticate(rawBearer);
    // Also enforce the existing administrator-revoked device environment list.
    // Return the authenticated registry row; never accept a body-supplied UID.
    return device;
  },
  backendOrigin: 'https://ai-agent-debate.onrender.com',
  allowedHubOrigins: ['https://www.smarthandicrafts.com'],
});

// Register after JSON parsing, before legacy call/push handlers. Readiness may
// use late runtime closures; do not dereference an uninitialized runtime here.
app.use(operatorBrowserAuth.guard);
// Register the dynamic popup before express.static('public'). Both aliases
// receive an injected nonce and public origin configuration.
operatorBrowserAuth.registerRoutes(app);
```

The native callback receives `(rawBearer, req)` and returns the current registry
row with `id`, `tokenExpiresAt`, and `revokedAt`. The actual registry API is
`deviceRegistry.authenticate(rawBearer)`. Deliberate registry errors have
`registryError === true`; 400/401/403 mean invalid enrollment, while SDK and
storage errors remain retryable 503. The factory never exposes raw exception
messages or a device credential.

`PROFILE_SESSION_SECRET` must be an explicitly configured secret containing at
least 32 non-whitespace characters. There is no fallback to concatenated profile
passwords. If absent or too short, the factory still initializes; browser issue,
refresh, and capability verification return 503, and `browserAuthReady` is false.
Valid native history authentication remains available. Secret configuration has
not been verified against the current production environment in this task.

The factory returns `{guard, registerRoutes, verifyToken, publicConfig}`.
`verifyToken()` always enforces the short access expiry. Its optional
`expectedOrigin` parameter binds validation to the request's exact Hub Origin.

## Issuing and renewing browser authority

`POST /api/operator-browser-auth/token` requires:

- A current signed Render profile cookie for `Smart handicrafts` or `SUDO`.
- `Origin: https://ai-agent-debate.onrender.com` and
  `X-SH-Operator-Auth: 1`.
- JSON `{origin: '<exact allowlisted Hub origin>', previousToken?: '<cap>'}`.

The response contains a short capability, expiry, server-generated base device,
tab/session, and composite operator IDs. The capability has a distinct signed
purpose, issuer, role, exact Hub origin, explicit integration scopes, 10-minute
access expiry, and an absolute grant no longer than the current profile session
or two hours. Caller-supplied identity, scope and expiry fields cannot alter it.

A valid previous capability preserves the same actor. A short-access-expired
capability may recover that actor **only in the issuer**, after an independent
current Render profile check and while the original absolute grant remains
valid. The origin/profile must match. Recovery preserves original scopes,
actor IDs, grant start and absolute expiry; it does not silently create a new
owner for an existing call. Neither controls nor the exported verifier accepts
expired access.

`POST /api/operator-browser-auth/refresh` requires the currently valid capability
in `Authorization: Bearer ...` and the exact signed Hub Origin. It needs no
cross-origin Render cookie. It renews the access interval, preserving all
authority and never passing the original absolute expiry. The frontend must
singleflight renewal, retain the old capability only in memory for explicit
reconnect, clear it on logout, and never replay rejected mutation requests.

Capabilities are stateless. Closing/logout removes the frontend's copy; an
already-issued stolen copy can remain usable within its bounded grant. Secret
rotation invalidates all browser capabilities. This implementation does not add
per-capability server revocation or pretend that a client logout is revocation.

## Popup protocol

Open `/operator-auth?origin=<encoded exact Hub origin>&state=<random32+chars>`.
No credential, device identifier, or previous token is allowed in that URL.

1. Popup checks its own backend origin, opener, target origin and state, then
   posts `{type:'sh-operator-auth-ready', state}` to the exact Hub origin.
2. The opener validates `event.source`, Render origin and state, then replies
   `{type:'sh-operator-auth-context', state, previousToken}` to the exact backend
   origin. The previous capability remains an in-memory value.
3. The popup validates the exact source/origin/state before issuing anything.
   Even manual retry/login cannot bypass this handshake.
4. Success posts `{type:'sh-operator-browser-auth', state, token, expiresAt,
   authExpiresAt, operatorDeviceId, baseDeviceId, operatorSessionId}` to the
   exact Hub origin. The window closes. The opener must validate the same
   source/origin/state before accepting it.

The popup reuses an existing signed Render profile or submits the existing
`/api/profile-login` form API. The password input is cleared before awaiting the
request and is never sent to the opener. CSP uses per-response script/style
nonces, self-only network access and denied framing. The route is no-store and
no-referrer. No bearer is placed in localStorage, a URL, HTML configuration, or
an embed shared secret. An absolute-expired/profile-changed previous grant
requires an explicit "Start a new call session" action; actor replacement is
not silent.

## Exact protected surface

The guard covers all descendants of:

- `/api/whatsapp-calls`
- `/api/odoo/call-log`
- `/api/operator-call-locks`
- `/api/operator-call-transfer`
- `/api/operator-devices`
- `/api/zoho-mail` (`mail:read`, `mail:write`)
- `/api/google-contacts` (`contacts:read`, `contacts:write`)
- `/api/odoo-documents` (`documents:read`, `documents:write`)
- `/api/ai-mode` (`ai:read`, `ai:write`)
- `/api/debug/webhooks` (`calls:read`, `calls:write`)

Fresh browser grants contain the ten scopes: `calls`, `mail`, `contacts`,
`documents` and `ai`, each with read/write. Refreshing or recovering a pre-R13
grant preserves its original scopes; it cannot expand authority. Start a new
explicit operator session during the coordinated R13 upgrade if the old grant
has only call scopes. Sending a document by email needs both `documents:write`
and `mail:write`, including normalized whitespace/case aliases.

Generic `/api/odoo` and `/api/labels` tools require their existing signed Render
profile and same-origin JSON writes. Profile determines role; the client cannot
claim `admin`. Hub/native capabilities do not grant generic service-account RPC.
The independently authenticated Odoo sale-confirmed callbacks remain exceptions.
OAuth authorization and callbacks require a signed initiating profile; OAuth
state is bound to the exact profile/session. See
[the R13 migration guide](docs/r13/backend-private-integrations.md) for the exact
route and callback contracts.

It also covers exact push paths `/api/push/subscribe`, `/unsubscribe`, `/status`,
`/test`, and `/test-call`. `/api/push/public-key` stays public.

For browser requests, the middleware overwrites all recognized body/query
device, session, lock and actor aliases from the verified capability. Transfer
request/cancel source identity is likewise overwritten; the selected target
remains a request parameter. A signed Render profile cookie is accepted on
the exact push helper paths only. Push writes require the same-origin action
header above. GET `/api/push/test-call` is refused because it sends a push;
use authenticated POST.

Existing handler-level resource ownership and lifecycle checks still apply.
Subscription replacement and unsubscribe check the derived actor against the existing
owner inside the atomic mutation. Reauthentication on the same physical browser
may migrate ownership only with the exact endpoint and both existing subscription
keys. An endpoint alone never authorizes takeover or deletion. The native FCM
registry is separate and is not migrated by this browser helper.

The public `/api/whatsapp-calls/config` returns only an authentication marker.
A valid browser capability reaches the existing operational config handler.
Native config requests receive the public marker. Anonymous requests never
receive configured business numbers or provider details.

The Hub opens `/api/whatsapp-calls/events` using fetch streaming with its scoped
Authorization header. It parses only bounded ready and call-status hint events;
the ordinary authenticated API supplies the corresponding exact call record.
The server closes the stream at the access-token expiry, and the Hub renews its
lease and reconnects. Polling remains the fallback during connection loss.
Unsigned EventSource requests and URL credentials are refused. No bearer token
is placed in the stream URL, browser storage, logs, or notification links.

## Native history read boundary

Native device bearers are accepted only for GET/HEAD:

- `/api/whatsapp-calls/logs`
- `/api/whatsapp-calls/recent`
- `/api/whatsapp-calls/incoming`
- `/api/whatsapp-calls/:callId` with a bounded valid ID, excluding reserved
  control, diagnostics and stream names.

The credential stays in Android's native API client and never enters WebView
JavaScript. Successful protected history responses carry `X-SH-Call-History: sh-call-history-v1`.
The R12 Java transport refuses an unmarked successful response before reading its
body, so an older backend cannot expose raw SDP through the WebView bridge.
The guard wraps JSON output with `projectNativeCallHistory`, an
allowlist projection that preserves bounded call/event IDs, status, customer
display fields, timestamps, selected history flags and notes. It excludes raw
webhooks, SDP/session descriptions, room join objects, device tokens, provider
responses and raw errors. Numeric Odoo/event IDs survive projection. A native
bearer cannot mutate any legacy call, lock, presence, transfer or push route.

## Existing login helper integration

Use `createProfileLoginLimiter().check(req)` before password comparison;
`success(req)` clears the successful IP's budget. Its bounded in-memory window
limits repeated attempts; it is not a distributed rate limiter. Use
`constantTimePasswordEqual(suppliedPassword, configuredPassword)` instead of
plain equality. Empty/unconfigured expected passwords never match. Return the
limiter's deliberate 429 status with a sanitized error message. Existing
profile cookie signing and allowed-profile choices remain authoritative.

## Verification and remaining release gates

Run on the pinned Node 24 release:

```sh
node --test operator-browser-auth.test.mjs tests/operator-call-security.test.mjs
node tests/operator-private-integration.test.mjs
node tests/operator-ai-r13.test.mjs
```

The focused authorization suite has 22 passing synthetic tests, and the actual
server-handler security suite has 20 passing integration tests (42 total). It exercises issuer
authority, origin/purpose/scope validation, expiration and non-expanding renewal,
identity recovery, actor alias replacement, protected route families, native
history projection, native mutation denial, storage-failure classification,
weak-secret behavior, push CSRF, login rate limits, and executed popup JavaScript
source/origin/state/race handling. It makes no live profile login, provider call,
FCM send or production mutation.

The guard, dynamic popup, frontend transport and native read proxy are wired in
this source. Live release gates remain: verify strong production secret/profile
configuration, deploy a compatible backend and embed, install the APK signed with
the existing key, test actual cookie/popup behavior, and verify calls on physical
devices. The current task has not completed those live checks. Old browser clients
without the new connection transport cannot continue using unauthenticated
legacy call endpoints; coordinate this rollout instead of publishing only one layer.

The R12 anonymous Zoho read/send/reply finding is fixed in this source, together
with compatible Hub transport for Google Contacts, Documents and SH AI. Full
actual-server HTTP tests exercise the real middleware ordering and handlers with
synthetic provider transports. Source-bound automated reply and handover receipt
transactions also run against the official Firestore SDK and local emulator.
These checks do not establish production credentials, current Odoo schema,
provider delivery, physical phone behavior, or security of unrelated products in
the large shared server. The R13 migration guide records those boundaries.

## Notification companion

`operator-notifications-auth.js` uses the existing Render operator profile login
for browser push setup. It does not impersonate an Odoo login or expose a native
bearer. It accepts only the exact push setup/test endpoints and methods, includes
the same-origin action header on writes, and never replays a failed mutation.
Notification tests report server acceptance rather than asserting phone delivery.
Reset sends the subscription ownership proof and waits for a successful server
acknowledgement before removing local delivery. The companion does not poll
private call/device APIs or create a second calling session; history, devices and
call actions return to the main Hub. Ten offline Chromium checks execute this
actual page and helper, including malformed acknowledgements and safe error text.
