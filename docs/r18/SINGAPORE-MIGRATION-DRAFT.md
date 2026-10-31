# Singapore free-only migration draft

Status: review only. This document and its prepared scripts do not create a service, change a production start command, change Meta routing, or move a database.

The user's latest budget decision is Free hosting only. It replaces the earlier paid-compute proposal. The existing Oregon service stays on Free; no paid resource or billing change is authorized by this draft. `infra/render-singapore-preflight.yaml` now explicitly uses `plan: free` and starts only the isolated read-only check.

## Free budget and heartbeat

Render provides 750 running Free instance hours per workspace per calendar month, shared by all Free web services. One continuously running service uses up to 744 hours in a 31-day month. Two continuously running services require 1,440–1,488 hours, so a permanently awake Oregon proxy plus Singapore backend cannot fit that allowance. Inspect actual workspace usage before even a short additional preflight. Stop that measurement service when finished; do not leave it running alongside the current app.

The existing application's health heartbeat now runs every five seconds, uses a four-second deadline and one outstanding request, drains a bounded response body, and stops during shutdown. It prefers its own validated `RENDER_EXTERNAL_URL` before the public `APP_URL`, so a future copied public origin cannot accidentally ping the wrong service. Normal result logs are limited to one per minute, with transitions reported immediately. No database, provider or credential check runs in the health route.

This is best-effort traffic while the process is running. A stopped process cannot wake itself, and a heartbeat does not override Render's restart, idle, quota or usage policies. It also cannot remove the measured Oregon-to-Mumbai database round trips. Both 30 seconds and five seconds are below the documented 15-minute idle interval; increasing heartbeat frequency does not establish the requested real call latency.

## Evidence and objective

The existing Firestore database is in `asia-south1` (Mumbai). The current Render application is in Oregon. Real R17 phone-test logs showed individual registry/media reads around 250–300 ms and transactions around 800 ms. An incoming Answer request took 6,640 ms, including a 2,282 ms provider request. Repeated database trips across these regions are a material part of the delay; changing the call-screen labels cannot remove them.

Place the full application in Singapore while retaining the existing Firestore database and its data. Measure real incoming alert arrival, accepted-call RTP, transfer RTP, and remote End after the move. A regional move improves the network path but does not by itself guarantee the requested 1–2 second call limit or 4–5 second transfer limit.

## Public-origin choice

For a sustainable Free-only regional move, prefer one Singapore full application and a coordinated direct-origin APK/Odoo update, followed by stopping the old full runtime. This is a separate migration from the heartbeat change; it has not been activated. Preserve the shared database and existing enrollment authority, and use one full worker cohort. The short read-only preflight can measure Singapore-to-Mumbai reads before preparing that cutover.

The compatibility option preserves `https://ai-agent-debate.onrender.com` as the public origin, with its Oregon service running a separate, lightweight, fixed-upstream reverse proxy to the Singapore application. It can be considered only for a bounded transition within the remaining shared Free allowance, not as two permanently awake Free services. The prepared entrypoint is `node scripts/hosting-proxy.mjs`; it imports built-ins only and does not initialize any application runtime. Set its server-owned `SH_HOSTING_PROXY_UPSTREAM` to the approved Singapore HTTPS Render origin while keeping `APP_URL` at the old public origin. It rejects self-routing against `APP_URL` and `RENDER_EXTERNAL_HOSTNAME`. This removes Oregon-to-Firestore operations while adding one Oregon-to-Singapore request hop. No production start command or proxy setting has been changed.

A redirect is insufficient. `NativeApi.java` disables redirects, Android trusts the existing host, and browser authentication binds its popup origin and signed issuer to that origin. Moving phones and the embed directly to a new Singapore/custom origin is a separate application update.

| Existing origin binding | Repository location |
| --- | --- |
| Android backend/API origin and trusted downloads | `android/operatorhub/app/src/main/java/com/smarthandicrafts/operatorhub/HubPolicy.java` |
| Native history origin; redirects disabled | `android/operatorhub/app/src/main/java/com/smarthandicrafts/operatorhub/NativeApi.java` |
| Native auth/resource/document host checks | `android/operatorhub/app/src/main/java/com/smarthandicrafts/operatorhub/NativeOperatorAuthPolicy.java` |
| Injected Hub read and transfer assets | `android/operatorhub/app/src/main/assets/sh-native-hub-read.js`, `sh-call-transfer-guard.js` |
| Odoo notifications, popup and integration API bases | `integrations/odoo/smart-handicrafts-whatsapp-embed-r13.html` and `.txt` |
| Browser fetch, popup, issuer and message origin | `public/operator-browser-auth.js`, `operator-browser-auth.js` |
| Notification authorization origin | `public/operator-notifications-auth.js` |
| Admin/report Origin checks and OAuth callbacks | `operator-admin.js`, `operator-reporting-runtime.js`, `server.js` |

For compatibility routing, Singapore retains `APP_URL=https://ai-agent-debate.onrender.com`. `APP_URL` alone cannot implement a direct-origin migration: the browser-auth and document-link factories currently also default to the old origin. Profile cookies are host-only and must remain valid through the proxy. Existing signed document URLs can live for up to seven days, so their old hostname must remain reachable.

## Configuration and state that must remain identical

- Firestore project ID, database ID, collection prefix, registry backend, server service-account authority, revoked-device configuration, and existing device credentials. Do not create an empty replacement database or bootstrap/re-enroll devices as part of the region move.
- Meta phone-number identity, access token, app signing secret, webhook verification token and API-version settings. Preserve all configured webhook aliases.
- LiveKit URL/project, API key/secret and provider fingerprint inputs. Do not change media projects during this cutover; existing calls belong to their original provider fingerprint.
- Firebase sender/project, Android package/application registration and FCM credentials.
- `PROFILE_SESSION_SECRET`, profile passwords, browser-auth configuration, VAPID key pair, Odoo and other integration credentials, OAuth callback configuration and revocation settings.
- File-backed legacy history and pending Odoo synchronization (`WHATSAPP_CALL_LOGS_PATH`), browser push subscriptions (`WEB_PUSH_SUBSCRIPTIONS_PATH`), AI settings/rules/memory, and other intentionally persisted application files. The Firestore native registry/media/reports stay in place and must not be copied or reset.

A full-service move is preferable to sending only native calls to Singapore: native call history and SSE hints are emitted by the application process. Splitting the processes can leave the old browser UI listening to a different process and different file-backed history.

## Required proxy behavior

- Use a server-configured, fixed HTTPS upstream. Never accept a client-supplied upstream URL. Avoid forwarding back to the same public proxy and creating a loop.
- Preserve method, path, query and exact raw request bytes. Forward bearer authorization, cookies, Origin, `X-SH-*` metadata and Meta signature headers. Do not parse and reserialize webhook JSON.
- Preserve upstream status, response body, `Set-Cookie`, cache/security headers and `Server-Timing`; configure trusted forwarded address handling explicitly.
- Stream SSE without buffering and propagate disconnects. Do not impose the ordinary short JSON timeout on the long-lived call event stream.
- Bound connection/request failures and do not automatically replay mutation requests. An interrupted Answer, Connect, End or transfer request can have an unknown outcome and must use the existing durable reconciliation path.
- Proxy both GET verification and POST delivery for `/webhook`, `/whatsapp/webhook`, `/api/whatsapp/webhook` and `/api/meta/whatsapp/webhook`.
- Verify byte-exact HMAC behavior, authorization headers, browser writes, cookies, SSE and failure behavior locally before routing production requests.

## Worker ownership

No current environment flag makes the full server a safe proxy-only process. Startup creates Firestore and starts registry maintenance, native recovery and reporting. History retry has its own 30-second timer. `AI_MODE_BACKGROUND_WORKER_ENABLED=false` disables only the AI loop. `SH_NATIVE_CALLS_ENABLED=false` blocks new room-call admission but still permits existing-session recovery and cleanup.

Native durable claims and leases arbitrate multiple instances, but that does not establish safe active-active behavior for file-backed legacy state or AI/Odoo work. Use one full application worker cohort during this migration. A Singapore standby must not accidentally run the full worker set before its activation; the necessary role/standby implementation must be reviewed before provisioning or starting it with production authority.

## Cutover checklist

1. Prepare the same reviewed application version and authority configuration for Singapore. Inventory file-backed state and integration callbacks without printing secrets. Keep automatic deployment and background-worker behavior explicit.
2. Review `scripts/hosting-proxy.mjs` and its isolated tests in `tests/hosting-proxy.test.mjs`. It streams raw HTTP/SSE, strips hop-by-hop headers, preserves credentials/signatures/status/cookies/timing, and never follows redirects or retries mutations. It is not yet activated.
3. Review the isolated read-only `scripts/hosting-preflight.mjs` and draft `infra/render-singapore-preflight.yaml`. The draft starts only preflight, keeps automatic deploy off, and contains 92 internal Render references to the existing service's environment values rather than placing secret values in Git. The preflight checks the existing database location and bounded read latency without starting the application, providers, notifications or workers. Separately verify provider-control configuration before full activation. Do not use customer calls or send test notifications as a readiness check.
4. Choose a quiet cutover interval and coordinated direct-origin APK/Odoo deployment. Drain and stop Oregon's full application before activating Singapore's full worker cohort. Use the standalone Oregon proxy only if a short compatibility interval is required and its Free hours are available; do not add a heartbeat to that proxy. Existing shutdown drains HTTP/reporting/recovery work with bounded deadlines; unknown provider outcomes must still reconcile durably. Stop the old service after the transition so only one full Free service remains running.
5. Check browser authentication, native enrollment continuity, notifications, webhook verification, reporting and SSE. Compare `SH_CALL_STORAGE_TIMING`, `SH_CALL_REGISTRY_TIMING`, `SH_CALL_PROVIDER_TIMING` and request timing. Then perform an authorized real-phone test measuring audio and remote disconnect, not only UI transitions.
6. Optionally update Meta's callback to the direct Singapore URL after verification and signature checks. This removes the Oregon detour from incoming delivery; retain old aliases for compatibility and delayed deliveries.
7. Consider a later direct Singapore/custom-origin APK and Odoo embed update to remove the compatibility hop. Update every origin binding in the table together and retain old signed links for their remaining lifetime.

## Rollback checklist

1. Drain and stop Singapore's full worker cohort. Preserve the shared database, collection prefix, provider identity and secrets.
2. Restore Oregon as the sole full application runtime using the reviewed compatible application version and preserved file-backed state. Restore routing/start commands without a self-proxy loop.
3. If Meta was changed, restore its previous callback and verify GET/POST delivery. Do not replay issued/uncertain provider operations manually.
4. Confirm existing device authentication, call reconciliation, notifications and SSE. A rollback must not reset the registry, change database namespaces, or require fresh enrollment merely because the server region changed.
