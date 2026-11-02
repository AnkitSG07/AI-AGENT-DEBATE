# Firestore usage follow-up — 2 November 2026

The supplied Firebase screenshots show approximately 3,200 daily reads and 1,600 daily writes (6.5% and 8.1% of the displayed limits). These are cumulative project totals, not a measurement of the user's latest three or four notification tests and two calls.

The migration copied 362 existing records into the new database and verified their contents. That activity contributes to the new project's usage. Historical retry counters copied with those records are cumulative across the migration and must not be presented as today's usage.

The live audit found 23 terminal sessions, no active canonical calls, and five remaining customer-disconnect cleanup jobs. Four were imported older calls; one followed the new incoming call. The provider had confirmed that these calls ended, but that confirmation alone does not prove that the corresponding LiveKit connector participant has disappeared. The old cleanup path continued retrying disconnect when the connector returned an error.

The correction retains exact call/room/participant binding and completes cleanup only after an authenticated provider terminal event and an authoritative absence check. A remaining participant, unavailable room lookup or permission error must preserve pending cleanup. It does not remove call history or fabricate a successful disconnect.

A 24-hour regression simulation of one confirmed-ended call with a failed repeated disconnect produced 231 further document writes with the old behavior. With the correction, one exact absence check completed cleanup and subsequent recovery produced zero further writes for that call. This is a controlled scenario, not a project-wide zero-usage guarantee. The race where a provider End arrives during an in-flight business disconnect is also covered.

Also corrected the deferred WhatsApp webhook follow-up's undefined `fields` variable. Executed regression tests cover forwarding call events, waking message discovery only after successful Odoo forwarding, and recording a forwarding failure without falsely waking discovery.

Final frozen Node 24 unit, private HTTP and frontend VM verification passed 842 checks with zero failures or source changes during the run. Independent review checked the exact absence conditions, provider-End race, detached-operator cleanup and lease guards. Existing APK and Odoo embed assets do not require rebuilding for this server-only correction.

The server's logs from the latest two calls showed Answer handling at 2,956 ms (2,636 ms in the audio provider request), outgoing setup at 2,640 ms (2,340 ms in the provider request), and End handling at 131–159 ms. Incoming push was submitted successfully in 291 ms. These server measurements are not handset audio or notification-display measurements.

Exact per-operation attribution of the supplied daily totals remains unavailable. The existing service-account permissions do not grant Cloud Monitoring access. Remaining bounded recovery discovery and security/retention housekeeping use some database operations even when no new message is sent; zero idle usage is not claimed. The five-second Render health ping does not itself read or write Firestore.
