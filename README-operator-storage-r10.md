# SH Chat R10: persistent native device registration

## Deployment status

This change is prepared for review. It does not enable real audio transfer, alter
the Odoo embed, or claim that a phone received an FCM notification. The earlier
R9 transfer guard remains in place.

The Firebase project `smart-handicrafts` has a Standard `(default)` Firestore
database in `asia-south1` (Mumbai), on the Spark plan. Client rules deny all
reads/writes. Server access uses IAM and the existing private service account
already held by Render; no private key is included here or in the APK.

## What changes

`operator-firestore-registry.js` stores device identities, current credential
hashes, FCM tokens, invitation-consumption evidence, rotations, and notification
delivery claims in separate Firestore collections. Transactions coordinate
multiple server instances. Configuring Firestore never falls back to `/tmp`
when a credential, IAM, storage or network error occurs.

The bridge retains existing routes and adds authenticated
`POST /api/operator-android/devices/renew`. The same valid bearer receives a new,
bounded expiry; revoked/expired bearers cannot renew. Server-storage failures are
503, not phone-authorization 401. The APK must persist the returned expiry; old
APKs do not call the renewal route automatically.

Short encrypted enrollment/rotation response recovery lasts at most two minutes.
A startup and five-minute bounded maintenance pass removes expired ciphertext,
while retaining used-code and credential-revocation evidence. This maintenance
does not delete devices or call history.

FCM sends happen outside database transactions. Firestore and FCM cannot commit
atomically: a lost FCM acknowledgment can still cause duplicate delivery. The
APK's exact-event deduplication and ended-call tombstones remain required.

## Configuration after IAM approval and migration preparation

```dotenv
SH_ANDROID_REGISTRY_BACKEND=firestore
SH_OPERATOR_FIRESTORE_DATABASE=(default)
SH_OPERATOR_FIRESTORE_PREFIX=sh_operator
SH_FIRESTORE_ALLOW_BOOTSTRAP_ENROLLMENT=false
```

Keep the existing correct `SH_ANDROID_FIREBASE_PROJECT_ID=smart-handicrafts`
and private `SH_ANDROID_FIREBASE_SERVICE_ACCOUNT_JSON` in Render. The private
account needs the Cloud Datastore User (`roles/datastore.user`) role in this
project, in addition to its existing FCM role. Do not grant Owner or publish
the credential in GitHub, the website, or the APK.

The official server SDK is pinned to `@google-cloud/firestore` 8.7.1, compatible
with the backend's declared Node 18 runtime. The currently newest major has a
different Node requirement and was not silently substituted.

`configured: true` is local configuration validation. Public
`storageAvailable: true` proves a bounded metadata read succeeded; it does not
prove write access or notification receipt. Verify an actual registration write
and a matching phone receipt separately before declaring the deployment ready.

## First migration must be deliberate

The existing free Render instance stores device records in an ephemeral file.
A fresh Firestore database cannot reconstruct those private registrations or
know whether an old environment enrollment code was consumed.

Either import a complete, securely obtained registry snapshot including device,
installation, credential, and consumed-code records before switching, or perform
one-time re-enrollment using fresh invitations. Never adopt a phone's claimed
device ID or arbitrary bearer as proof of its previous authorization.

Bootstrap enrollment defaults OFF, so a previously consumed environment code
cannot become reusable merely because Firestore is empty. The registry's
`issueEnrollment()` method can create a new random, expiring invitation from an
authenticated administrative server context. It has no unauthenticated HTTP
endpoint. Do not enable bootstrap with an old code. If a fresh bootstrap code
is deliberately used, enable the flag only after ensuring it is unused, enroll
the intended phone, then turn the flag back off; its consumed hash persists.

## Validation

Run `npm run test:operator-storage`. The source tests exercise compatibility,
two-instance enrollment, lease renewal, revocation, response loss, delivery
claims, cancellation, storage failures, and private configuration validation.
Test credentials are generated locally and have no production access.

The same adapter was tested against the official Firestore emulator 1.22.0 with
SDK 8.7.1, using localhost and a `demo-` project. These checks do not establish
production IAM write access, real FCM receipt, Android background behavior or
two-way customer audio.

## Remaining call work

Persisting devices does not transfer an existing WebRTC connection. The isolated
media foundation uses LiveKit's official SDK and separate customer/operator room
legs, but production call-state storage, authenticated device-to-Odoo binding,
native room audio, readiness telemetry, signaling integration and real phone
acceptance tests must be completed before enabling it.

Existing call logs/ownership in `server.js` are not moved to Firestore by this
device-registry patch. The 30-day Excel archive/export-and-delete workflow is
also not enabled. That future job must archive and verify history before deleting
eligible records, and must exclude device credentials, current calls, active
transfers, pending cleanup, and consumed invitation evidence.

## Live acceptance before release

1. Verify a real Firestore registration write and the device's exact FCM receipt.
2. Redeploy Render and confirm the same device bearer/identity remains usable.
3. Verify valid renewal persists its new expiry on the phone; verify revoked
   credentials remain denied and temporary storage failures retain enrollment.
4. Validate ordinary incoming/outgoing calls and cancellation on other devices.
5. For future transfer enablement, use two operator phones plus a separate
   customer WhatsApp endpoint. After transfer, disconnect the source phone's
   network and verify the destination/customer audio continues in both directions.
