# Complete recovered SH Chat R13 calling and authenticated Hub candidate

## Why this change is needed

The live R11 branch predates the interrupted R12/R13 work. Operators need call
ownership, cancellation and transfer state to agree across the Android app,
browser and backend. Private Hub integrations also need the same explicit
operator authorization boundary as call controls. The recovered client could
write the shared AI mode OFF on startup, while several provider-response paths
trusted a different record from the one the operator had authorized.

## What this candidate changes

- Recovers the Android project, matching Odoo embed, backend changes and
  reproducible isolated verification harnesses into one reviewed source tree.
- Preserves enrollment generation and exact call/attempt ownership across
  acknowledgement loss, terminal updates, redial and two-operator transfer.
- Corrects incoming CallStyle validity when full-screen access is denied, using
  Android's own heads-up fallback while retaining exact Answer/Decline actions.
- Adds authenticated browser services and a restricted native sign-in window;
  protects Mail, Contacts, Documents and AI; sanitizes displayed HTML mail.
- Reads shared AI state at startup, requires revision-aware explicit writes,
  and binds automatic replies and document delivery to the exact Odoo records.
- Keeps durable receipts for uncertain reply/handover outcomes, so a lost
  response cannot silently authorize a second send.
- Adds explicit native Request call permission and Check permission actions,
  with authenticated Meta status checks, durable request receipts, number and
  enrollment binding, provider eligibility and an uncertain-send fence. A
  submitted message never becomes calling consent.
- Adds a requirements-to-evidence checklist and a workflow covering backend,
  browser, Firestore, real local RTP/audio and separate Android OS/native tests.
- Corrects Android CI's separate-shell working-directory and early-failure
  behavior with one wrapper. It requires hardware acceleration, attempts both
  instrumentation suites, records each result and fails if either suite fails.

## Validation and release scope

The accompanying verification report identifies the exact source tree and APK
checksums. It separates newly executed checks, recovered executions whose source
hashes still match, historical regression failures, and current unverified or
failing gates. Provider fixtures do not prove production delivery. The Android
test package has a separate simulation identity; the production candidate
excludes its fixture Activity, private test keys and test CA.

Current Android acceptance is open. The full JVM build passed 205 cases across
23 suites, but the final API35 OS run stopped after four passing cases and two
failures when the host OOM counter increased and the emulator disappeared. Six
OS cases remain incomplete, and the two native media cases did not start. The
Answer-case cleanup exception and WebView fixture startup timeout are retained
as failed outcomes, not converted into passes. A stable accelerated run must
resolve them before this candidate can be accepted for production.

The original Android signing key, coordinated Odoo/backend configuration and
real Cloud/phone acceptance remain separate release steps. The native permission
workflow has isolated backend and Android test evidence; actual customer consent
and production delivery remain live acceptance steps. Required video calling and
dedicated watch/car/headset Answer/End controls remain unmet. The separate
add-teammate and private-consultation workflows are explicitly optional and
unimplemented. The requirements checklist keeps each gap visible.

Render automatically deploys `main`. Keep this review on
`sh-chat-r13-reviewed-simulation` until the matching release components and
remaining acceptance gates have been confirmed.
