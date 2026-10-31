# R12 preservation review

**Result: 34 of 34 focused offline checks pass.** The same final suite against the captured prepatch embed reproduces 12 failures, with 22 preserved behaviors passing. The first, smaller probe was 23 tests with 20 passes and three failures; these runs overlap and must not be added together.

## Changes and preserved behavior

| Area | Source functions and starting lines | Evidence |
| --- | --- | --- |
| Reply windows and attachments | `isWhatsappWindowOpen` (1885); `postTextToChannel` (11195); `sendCurrentMessage` (11469); `sendAttachmentsFromInput` (7633) | Text is blocked when closed. Attachments recheck the captured channel's latest known window before every upload and before sending; overlapping actions are suppressed. Closing the workspace prevents a late send. Failed uploads preserve the draft, and switching chats does not redirect the message or overwrite another chat's warning. |
| Approved templates and fallback | `isApprovedWhatsappTemplate` (6783); `requireApprovedWhatsappTemplate` (6787); `loadWhatsappTemplates` (6798); `sendWhatsappTemplateWithFallbacks` (6863); `sendWhatsappTemplateToPartnerWithFallbacks` (6366); `isUnavailableWhatsappSendMethod` (6351) | Lists exclude unapproved/unknown statuses. Both send paths freshly read the exact template approval before any composer/send attempt. Network, validation and unrelated AttributeError failures stop further sends. Only the exact missing-method RPC error advances the method list. A successful template does not modify/reopen the free-text window. |
| Customer and sales linkage | `partnerIdFromChannel` (3327); `linkCustomerToConversation` (3333); `saveCustomerFromForm` (7376); `createQuotationForCurrentCustomer` (7423); `openFollowupModal` (7742); `saveFollowupActivity` (7766) | The captured form conversation receives the new partner. The local map supplies that contact immediately when the persistent Odoo relation is unavailable or denied. Draft quotation creation and follow-up creation use that same partner in the simulations. The quotation path does not call order confirmation. |
| AI ownership and default OFF | `forceAiModeOffOnAppOpen` (10810); `confirmedAiMode` (10839); `syncAiModeToServer` (10875); `setAiMode` (10927); `maybeHandleGlobalAiModeAfterInbox` (11274); `maybeHandleAiModeAfterMessages` (11375) | Both automatic browser scanners return immediately in server-background mode. Startup sends manual/OFF to the shared backend; later explicit ON is queued after it. Existing inbox IDs are marked when enabling. Unknown, malformed, mismatched and failed acknowledgements do not become confirmed UI state. |

## Scope and practical limits

The suite executes selected production JavaScript functions with synthetic RPC responses and deferred promises on Node18.20.8. It does not import the whole page or replace the broader Chromium UI checks. No live customer message, template, quotation, activity, call, notification or automation was sent or created.

The actual Odoo composer method and external delivery remain unverified. Generic fallback behavior is tested for routing and uncertainty handling only. When a send response is lost, the frontend stops and asks the operator to inspect the conversation; a later manual retry is not an exactly-once operation.

When Odoo cannot persist a contact relation, the new contact is usable through the local channel map in the current app instance. That temporary link is deliberately not represented as cross-device or reload persistence.

Default OFF remains global: opening another app instance requests manual mode on the same backend. The frontend does not periodically call `loadAiModeFromServer`, so another already-open instance can retain a stale switch appearance until it writes or reloads. This preserved global behavior was not silently changed.

The server worker and external Zapier automation were inspected only far enough to identify ownership boundaries. Background message processing, exact template account permissions, AI memory, clarification and handover are not established by these frontend simulations. The backend already has an enable-time filter with a five-second default grace, not a strict zero-grace cutoff.

## Reproducible files

- Test entry: `work/hub-r12/tests/preservation-r12.test.cjs`
- Final results: `work/call-audit-r12/preservation-current.tap`
- Same-suite prepatch results: `work/call-audit-r12/preservation-expanded-before.tap`
- Captured prepatch source: `work/call-audit-r12/preservation-before.html`
- Source hashes, function inventory and case list: `work/call-audit-r12/preservation-verification.json`

Final embed SHA256: `e4a501acae8c119dbe181ee4efc7b4815c9927bda7a567a0e7bce2b4900d2e9f`

Final test SHA256: `d0fc7868dca55ecb666bb692f60c39a4186b8a3e35711d4665496b39c0e09199`
