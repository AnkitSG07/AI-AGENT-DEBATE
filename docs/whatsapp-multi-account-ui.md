# WhatsApp account scope in SH Chat

The R13 inbox has an account selector and an account identity on each WhatsApp
conversation and its open chat. **All conversations** is the default and keeps
WhatsApp, website chats and groups together. Choosing an account narrows the
existing search, unread, favorites, labels and reply-window filters. Filter counts
retain their existing inbox-wide behavior. Filtering never switches the open
conversation, moves its draft or changes the sender of a reply.

The choices come only from `wa_account_id` on the Odoo conversations the current
user can read. The relation's display name is shown with the Odoo account ID so
two identically named accounts remain distinguishable. A numeric relation without
a name is shown as `WhatsApp account #ID`. Missing or invalid relations are grouped
as `WhatsApp account unavailable`. If a selected account disappears from the
loaded conversations, the selector returns to All conversations. Accounts with no
loaded conversation are not listed; the existing Load more action can expose more
conversations and account choices.

The existing `whatsapp_number` channel field identifies the customer. It is never
presented as the business sender's number. The UI can show a business phone number
only if Odoo includes it in the account's display name. A separately verified
business-number mapping would require an authorized backend integration.

This change prepares the inbox for accounts that Odoo already delivers. It does
not onboard another number, change Meta subscriptions, register a phone, alter
Render configuration or provide Coexistence echo/history/contact ingestion.
Odoo's support for those provider events must be confirmed separately. The
existing channel-bound sends, unread state and call runtime are unchanged.

## Local checks

Use Node 24 and the existing offline Playwright/Chromium test setup:

```sh
node scripts/sync-hub-r13.mjs
SH_PLAYWRIGHT_MODULE=/absolute/path/to/playwright \
SH_TEST_CHROMIUM=/absolute/path/to/chromium \
node --test integrations/odoo/tests/r13/whatsapp-accounts-browser.test.cjs
```

The browser suite uses the real complete embed and synthetic Odoo records. All
network requests are fulfilled locally. It covers mixed-source filtering,
account identity and fallbacks, account-scope refresh, unread preservation, and
reply binding when the same customer has conversations on different accounts.
The HTML and pasteable TXT delivery must remain byte-identical.
