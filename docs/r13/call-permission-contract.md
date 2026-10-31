# CALL-34 — Explicit native request for WhatsApp calling permission

This feature was completed from a newly located **Meta-maintained primary source**. The earlier `verification/recovery-current/media/call-permission-research.md` accurately records the previous documentation gap; it is historical and is not evidence that this new implementation is absent.

No live permission message, WhatsApp call, customer action or deployment was performed while implementing or testing this feature.

## Primary-source basis

Meta's [Business Messaging Sample Tech Provider App](https://github.com/fbsamples/business-messaging-sample-tech-provider-app) describes itself as a WhatsApp Business Platform reference implementation. Its source is copyright Meta Platforms and affiliates, MIT licensed. The reviewed immutable commit is **14703a3e1fdba9bcf75b2360b00817b6fcc9f79b**, dated 2026-08-17. The official GitHub connector supplied the actual complete file contents; public web fetching of the same GitHub file returned `DisabledError` and the Meta permission documentation still returned HTTP 429. The implementation uses the established API contract, not an inferred third-party provider wrapper.

| Confirmed contract | Exact primary evidence |
| --- | --- |
| Status: `GET /{phoneNumberId}/call_permissions?user_wa_id={customer}` | [`app/api/beUtils.ts`](https://github.com/fbsamples/business-messaging-sample-tech-provider-app/blob/14703a3e1fdba9bcf75b2360b00817b6fcc9f79b/app/api/beUtils.ts), lines 388–399 |
| Request: `POST /{phoneNumberId}/messages`; `messaging_product: whatsapp`, `recipient_type: individual`, `to`, `type: interactive`; interactive type/action name both `call_permission_request`; body text | Same file, lines 441–460 |
| Fixed Graph API origin, configured API version and bearer authorization | Same file, lines 674–721 |
| Request acknowledgement is `messages[0].id` | [`app/api/calls/request-permission/route.ts`](https://github.com/fbsamples/business-messaging-sample-tech-provider-app/blob/14703a3e1fdba9bcf75b2360b00817b6fcc9f79b/app/api/calls/request-permission/route.ts) |
| Permission values `no_permission`, `temporary`, `permanent` | [`app/types/calling.ts`](https://github.com/fbsamples/business-messaging-sample-tech-provider-app/blob/14703a3e1fdba9bcf75b2360b00817b6fcc9f79b/app/types/calling.ts), `CallPermissionInfo` |
| `temporary` uses `permission.expiration_time` in Unix seconds; request availability comes from `actions` and `can_perform_action` | [`app/components/InboxLayout.tsx`](https://github.com/fbsamples/business-messaging-sample-tech-provider-app/blob/14703a3e1fdba9bcf75b2360b00817b6fcc9f79b/app/components/InboxLayout.tsx), lines 178–195 and 453–470 |
| Reply is a `messages` webhook: message type `interactive`, interactive type `call_permission_reply`, response `accept` or `reject`; the sample re-fetches the status endpoint for current grant/expiry | Same file, lines 721–762 |
| Returned limit fields are `time_period`, `max_allowed`, `current_usage`; request action is `send_call_permission_request` | [`app/utils/calling.ts`](https://github.com/fbsamples/business-messaging-sample-tech-provider-app/blob/14703a3e1fdba9bcf75b2360b00817b6fcc9f79b/app/utils/calling.ts), lines 36–50 |
| `start_call` is the calling eligibility action | [`tests/unit/callingUtils.test.ts`](https://github.com/fbsamples/business-messaging-sample-tech-provider-app/blob/14703a3e1fdba9bcf75b2360b00817b6fcc9f79b/tests/unit/callingUtils.test.ts); its numerical values are fixtures and are **not** adopted as provider rules |
| Customer messages open a 24-hour service window, reset by each customer message | [WhatsApp's official Platform Pricing page](https://whatsappbusiness.com/products/platform-pricing/), Service section |
| Existing connector requires explicit calling permission, supports API 23.0–26.0 and expects destination number with country code without `+` | [LiveKit WhatsApp Connector](https://docs.livekit.io/telephony/connectors/whatsapp/), prerequisites and outbound parameters |

## Implemented scope

`operator-call-permission.js` adds a separately mounted native workflow. The existing `createNativeCallRuntime` result is captured through the gateway's existing `runtimeFactory` injection. Enrollment, device revocation, credential generation, tenant, supported build and calling activation are checked by the **same actual `CallRuntime.actor`, `recheck` and `requireEnabled` methods** as existing native calls. No separate browser-cookie or administrator shortcut is introduced.

The only send action is an explicit authenticated `POST` to request permission for the displayed exact customer. Merely constructing the service, opening the UI, checking status, receiving a webhook, or encountering an outgoing call failure does not send a request or dial a customer.

The provider adapter uses a fixed `https://graph.facebook.com` origin. Business phone ID, token and API version come from the server-owned native runtime. Requests cannot override those values, supply an arbitrary URL, or change tenant/device identity. The current app supports the existing digit-only international number format; BSUID identity is outside this change.

A request needs fresh positive provider eligibility before it can be claimed. The server then records the immutable operation and customer fence in Firestore. Because acquiring that claim can wait on contention, the server reads eligibility **again while owning the durable claim**, checks activation, and revalidates the original credential immediately before the only send. Changing permission, quota, enrollment or configuration during this period prevents dispatch.

## Native HTTP interface

All routes are under `/api/operator-android` and use the existing enrolled bearer plus native client headers.

- `GET /call-permission/status?to=919000000001` checks current provider authority and returns the latest request for this customer only when it belongs to this device and credential generation.
- An optional `requestId` query parameter selects one immutable request; it cannot be reused for another destination or enrollment.
- `POST /call-permission/request` accepts only `to` and `requestId`. The request ID is 8–120 ASCII letters, numbers, hyphens or underscores. Keep it stable through retries and process recreation.
- `to` is 7–15 digits, begins with a nonzero country code, and contains no leading `+`.
- Unsupported query/body fields are refused. Every response has `Cache-Control: no-store`.

A successful response contains `ok`, `to`, `permission` and `request`.

The permission object contains `status` (`unknown`, `no_permission`, `temporary`, `permanent`, or locally derived `expired`), `canCall`, `canRequest`, `expiresAtMs`, `checkedAtMs`, a safe explanatory `reason` and the returned provider limits. `canCall` requires both a valid current grant and positive `start_call` eligibility. Missing/unknown status, missing temporary expiry, duplicate actions and malformed action data never create authority. Exhausted or zero returned limits deny the action. No numerical Meta cap is hardcoded.

The optional request object contains its ID, state (`sending`, `sent`, `uncertain`, `blocked`), confirmed message ID or null, creation/update timestamps, replay flag, and allowlisted `code`/safe `reason`. Blocked records retain `CALL_PERMISSION_WINDOW_CLOSED` or `CALL_PERMISSION_REQUEST_BLOCKED` on GET and replay. Raw upstream error bodies, credentials and customer content are not returned.

**`sent` means a valid Meta message acknowledgement was received; it does not mean delivery or calling permission.** The client must display provider permission separately. `no_permission` does not distinguish never granted, declined or revoked and must not be labelled a confirmed denial or an indefinitely pending customer response.

## Durable attempt and uncertainty handling

Firestore uses the separate `${collectionPrefix}_call_permissions` namespace. Hashed document identities bind each request to the configured tenant/business number, customer, initiating device, user and credential generation. Tokens and bearer strings are never stored. No provider request executes inside a Firestore transaction.

The same operation ID is replayed rather than resent, including across server restarts and lost transaction acknowledgements. A shared customer fence prevents competing devices from sending while another request is in progress or uncertain. A confirmed send also has a **30-second local repeat-tap debounce**; this is application behavior, not a claim about Meta rate limits. After it, a genuinely new explicit request still needs fresh provider eligibility and a new ID.

If the provider times out, returns a server error, has an unreadable/oversized acknowledgement, omits a valid message ID, reports multiple message IDs, or echoes a different recipient, the outcome is uncertain and is never automatically retried. Lost durable settlement likewise preserves the existing send fence. Unsettled old `sending` records are presented as uncertain after the bounded dispatch interval; they are not expired back into permission to resend.

Status GET re-reads the durable customer fence **after** the provider response, so a slow lookup cannot hide a request another device just started. A fresh confirmed calling grant can resolve the need for a pending request without falsely rewriting the historical uncertain message acknowledgement as `sent`. A provider status response cannot prove whether a particular previously unacknowledged message was delivered; otherwise the uncertain fence remains and the operator is told to inspect the conversation.

## Window, templates and webhooks

This implementation sends the verified free-form permission message only. It does not invent a permission-template payload, automatically convert message type, or configure new templates. A clear provider window/template rejection produces an actionable blocked result: ask the customer to message first or use the existing approved-template workflow. Other definite provider rejections remain distinct from transport uncertainty.

Explicit Check and action-time authoritative GET provide the complete implemented reconciliation path. No new webhook parser is required, and a reply webhook is not trusted as permanent authority. Existing outgoing calling still uses the provider's permission enforcement. The workflow never automatically calls on receiving permission.

Unverified details are deliberately not encoded: hardcoded request/call counts, permission-specific reset rules, request reply correlation outside the established status path, automatic-revocation ordering, BSUID/parent BSUID support, and permission-template component schemas. The feature does not claim those capabilities or live-provider verification.

## Verification evidence

`tests/operator-call-permission.test.mjs` executes the actual new module, Graph adapter, native runtime authorization methods, durable transaction fake and loopback Express routes. Provider HTTP responses are synthetic and every adapter network function is replaced before execution. The suite covers permission parsing, expiry, exact recipient/body/origin, private identity checks, concurrent devices, durable replay and acknowledgement loss, final eligibility changes, stale GET races, provider rejection/uncertainty, no-send GET, and safe error persistence.

Results and exact input hashes are recorded separately in `verification/completion-current/call-permission/`. Existing suites that read or execute `server.js` are rerun as **replacement evidence**, not new unique cases. The previous base check count must not be increased by rerunning the same cases. Actual WhatsApp consent delivery, device installation and production rollout remain separate acceptance outcomes.
