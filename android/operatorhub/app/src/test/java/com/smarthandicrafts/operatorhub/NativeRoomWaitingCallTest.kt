package com.smarthandicrafts.operatorhub

import android.Manifest
import android.app.Application
import android.content.Intent
import android.os.Looper
import android.widget.Button
import android.widget.TextView
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows
import org.robolectric.android.controller.ActivityController
import org.robolectric.android.controller.ServiceController
import org.robolectric.annotation.Config
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.URL
import java.security.cert.Certificate
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.HttpsURLConnection

/** Real Activity/Service lifecycle and controls; HTTP and media are explicitly synthetic. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], application = Application::class)
class NativeRoomWaitingCallTest {
    private val oldCall = "out_0123456789abcdef0123456789abcdef"
    private val waitingCall = "out_waiting_valid_call_1234567890"
    private val attempt = "de3cc9b1-d0f7-4c06-a677-2c99cf8ef319"
    private val replacement = "23f5e680-949b-45a7-93c5-24f2e85a8375"
    private lateinit var serviceController: ServiceController<NativeRoomCallService>
    private var activityController: ActivityController<NativeRoomCallActivity>? = null
    private lateinit var service: NativeRoomCallService
    private lateinit var store: NativeStore
    private lateinit var media: FakeMedia
    private lateinit var previousNetwork: NativeApi.ConnectionFactory
    private val requests = AtomicInteger()
    private val reply = AtomicReference<JSONObject>()
    private var serviceDestroyed = false
    private val app get() = RuntimeEnvironment.getApplication()
    private val activity get() = activityController!!.get()
    private class FakeMedia : NativeRoomMedia {
        var closes = 0
        override fun connect(descriptor: JSONObject) = Unit
        override fun setMuted(value: Boolean) = Unit
        override fun setSpeaker(value: Boolean) = Unit
        override fun close() { closes++ }
    }
    private fun field(target: Any, name: String): Any? = target.javaClass.getDeclaredField(name).apply { isAccessible = true }.get(target)
    private fun set(target: Any, name: String, value: Any) = target.javaClass.getDeclaredField(name).apply { isAccessible = true }.set(target, value)
    private fun factory() = NativeApi::class.java.getDeclaredField("connections").apply { isAccessible = true }
    private fun button(name: String = "accept") = field(activity, name) as Button
    private fun message() = (field(activity, "status") as TextView).text.toString()
    private fun status(available: Boolean = false, phase: String = "ringing", owner: String = "", id: String = waitingCall): JSONObject =
        JSONObject().put("ok", true).put("deviceAvailable", available).put("call", JSONObject()
            .put("callId", id).put("sessionId", id).put("phase", phase).put("ownerDeviceId", owner))
    @Before fun setup() {
        Shadows.shadowOf(app).grantPermissions("com.smarthandicrafts.operatorhub.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION", Manifest.permission.RECORD_AUDIO)
        store = NativeStore(app)
        val id = "android_1234567890abcdefghijklmnop"
        assertTrue(store.enrollIfGeneration(id, "$id.abcdefghijklmnopqrstuvwxyz0123456789", System.currentTimeMillis() + 1000000, store.credential().generation))
        previousNetwork = factory().get(null) as NativeApi.ConnectionFactory
        // Cleanup runs through the real NativeApi parser, but every connection is intercepted.
        factory().set(null, NativeApi.ConnectionFactory { url -> object : HttpsURLConnection(url) {
            override fun connect() = Unit
            override fun disconnect() = Unit
            override fun usingProxy() = false
            override fun getCipherSuite() = "SYNTHETIC-NO-NETWORK"
            override fun getLocalCertificates(): Array<Certificate> = emptyArray()
            override fun getServerCertificates(): Array<Certificate> = emptyArray()
            override fun getResponseCode() = 200
            override fun getOutputStream() = ByteArrayOutputStream()
            override fun getInputStream() = ByteArrayInputStream(JSONObject().put("ok", true).put("call", JSONObject()
                .put("callId", if (url.path.contains(waitingCall)) waitingCall else oldCall).put("phase", "ended")).toString().toByteArray())
        } })
        serviceController = Robolectric.buildService(NativeRoomCallService::class.java).create()
        service = serviceController.get(); media = FakeMedia()
        set(service, "credential", store.credential()); set(service, "callId", oldCall); set(service, "requestId", attempt)
        set(service, "legId", "leg-A1"); set(service, "engine", media); set(service, "readyCommitted", true); set(service, "state", "connected")
        val guard = field(service, "guard") as NativeRoomPolicy.Epoch; set(service, "epoch", guard.begin())
        val health = field(service, "health") as NativeRoomCallHealth; health.start(1); health.evidence(); health.connected(true, 2)
        set(service, "lastStatusOkAt", android.os.SystemClock.elapsedRealtime())
        reply.set(status())
    }
    @After fun teardown() {
        activityController?.pause()?.stop()?.destroy()
        if (!serviceDestroyed) serviceController.destroy()
        Shadows.shadowOf(Looper.getMainLooper()).idle()
        app.getSharedPreferences("native_room_cleanup", 0).edit().clear().commit()
        factory().set(null, previousNetwork)
    }
    private fun open(transfer: String = "", requester: NativeRoomCleanupProcessor.Requester? = null) {
        val intent = Intent(app, NativeRoomCallActivity::class.java).putExtra("room_action", "show")
            .putExtra("call_id", waitingCall).putExtra("transfer_id", transfer).putExtra("display_name", "Waiting customer").putExtra("channel_id", 73)
        activityController = Robolectric.buildActivity(NativeRoomCallActivity::class.java, intent)
        set(activity, "callApi", requester ?: NativeRoomCleanupProcessor.Requester { path, method, body, bearer ->
            assertEquals("GET", method); assertNull(body); assertEquals("/calls/$waitingCall/status", path)
            assertEquals(store.credential().bearer, bearer); requests.incrementAndGet(); reply.get()
        })
        activityController!!.create().start().resume().visible()
    }
    private fun destroyOldService() { serviceController.destroy(); serviceDestroyed = true }
    private fun runMainUntil(condition: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (!condition() && System.nanoTime() < deadline) { Shadows.shadowOf(Looper.getMainLooper()).idleFor(20, TimeUnit.MILLISECONDS); Thread.sleep(5) }
        assertTrue("Expected waiting-call transition did not occur: ${if (activityController != null) message() else "no activity"}", condition())
    }
    @Test fun endCurrentStopsOnlyCapturedAudioThenWaitsForDurableAvailabilityBeforeOneAnswer() {
        open(); assertEquals("End current & answer", button().text.toString()); assertTrue(button().isEnabled)
        button().performClick(); button().performClick(); runMainUntil { media.closes == 1 }
        assertEquals(1, media.closes); assertTrue(NativeRoomCallService.snapshot()!!.optBoolean("closed"))
        assertEquals(waitingCall, field(activity, "callId")); assertFalse(activity.isFinishing)
        runMainUntil { requests.get() > 0 }; destroyOldService()
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(1, TimeUnit.SECONDS); assertNull(Shadows.shadowOf(app).nextStartedService)
        reply.set(status(true)); runMainUntil { field(activity, "expectedAttemptId") != "" }
        val started = Shadows.shadowOf(app).nextStartedService!!
        assertEquals(waitingCall, started.getStringExtra("call_id")); assertEquals("accept", started.getStringExtra("room_action"))
        assertEquals(73, started.getIntExtra("channel_id", 0)); assertEquals(store.credential().generation, started.getLongExtra("enrollment_generation", -1))
        assertNotEquals(attempt, started.getStringExtra("client_attempt_id")); assertNull(Shadows.shadowOf(app).nextStartedService)
    }
    @Test fun freeServerObservationStillWaitsForClosedServiceDestruction() {
        reply.set(status(true)); open(); button().performClick(); runMainUntil { media.closes == 1 }
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(1, TimeUnit.SECONDS); assertNull(Shadows.shadowOf(app).nextStartedService)
        destroyOldService(); runMainUntil { field(activity, "expectedAttemptId") != "" }
        assertEquals(waitingCall, Shadows.shadowOf(app).nextStartedService!!.getStringExtra("call_id"))
    }
    @Test fun staleButtonCannotEndAReplacementAttempt() {
        open(); set(service, "requestId", replacement); button().performClick()
        assertEquals(0, media.closes); assertTrue(NativeRoomCallService.isRunning()); assertEquals(0, requests.get())
        assertTrue(message().contains("active call changed")); assertNull(Shadows.shadowOf(app).nextStartedService)
    }
    @Test fun decliningWaitingCallKeepsCurrentAudioConnected() {
        open(); button("decline").performClick(); assertTrue(activity.isFinishing)
        assertEquals(0, media.closes); assertTrue(NativeRoomCallService.isRunning())
        assertEquals(oldCall, NativeRoomCallService.snapshot()!!.optString("callId")); assertNull(Shadows.shadowOf(app).nextStartedService)
    }
    @Test fun cancelledWaitingAlertCannotEndCurrentCallWhenButtonIsTapped() {
        open(); store.closeRoomAlert(waitingCall, ""); button().performClick()
        assertEquals(0, media.closes); assertTrue(NativeRoomCallService.isRunning()); assertFalse(button().isEnabled)
    }
    @Test fun staleButtonCannotEndTheSameCallTransferredBackOnAnotherLeg() {
        open(); set(service, "legId", "leg-A2"); button().performClick()
        assertEquals(0, media.closes); assertTrue(NativeRoomCallService.isRunning()); assertEquals(0, requests.get())
    }
    @Test fun serverEndedWaitingCallNeverStartsAfterOldAudioStops() {
        reply.set(status(true, "ended")); open(); button().performClick()
        runMainUntil { message().contains("incoming call has ended") }
        assertFalse(button().isEnabled); assertEquals(0, media.closes); assertTrue(NativeRoomCallService.isRunning()); assertNull(Shadows.shadowOf(app).nextStartedService)
    }
    @Test fun callAnsweredOnAnotherPhoneNeverStartsHere() {
        reply.set(status(true, "connected", "android_other_device_12345678")); open(); button().performClick()
        runMainUntil { message().contains("answered on another phone") }; assertEquals(0, media.closes); assertNull(Shadows.shadowOf(app).nextStartedService)
    }
    @Test fun mismatchedStatusCannotAuthorizeWaitingCallAnswer() {
        reply.set(status(true, id = oldCall)); open(); button().performClick()
        runMainUntil { message().contains("could not be verified") }; assertEquals("Retry answer", button().text.toString())
        assertNull(Shadows.shadowOf(app).nextStartedService)
    }
    @Test fun missingAvailabilityFromOldBackendFailsVisiblyWithoutSpeculativeAccept() {
        val oldResponse = status(true); oldResponse.remove("deviceAvailable"); reply.set(oldResponse)
        open(); button().performClick(); runMainUntil { message().contains("Update operator services") }; assertEquals(0, media.closes)
        assertNull(Shadows.shadowOf(app).nextStartedService)
    }
    @Test fun changedTransferInvitationCannotBeAcceptedAfterEndingSourceCall() {
        reply.set(status(true).put("call", JSONObject().put("callId", waitingCall).put("phase", "connected").put("transfer", JSONObject()
            .put("id", "new-transfer").put("toDeviceId", store.deviceId()).put("status", "invited"))))
        open("old-transfer"); button().performClick(); runMainUntil { message().contains("transfer is no longer available") }
        assertNull(Shadows.shadowOf(app).nextStartedService)
    }
    @Test fun terminalNotificationDuringWaitingPermissionPromptWinsOverLateGrant() {
        Shadows.shadowOf(app).denyPermissions(Manifest.permission.RECORD_AUDIO); reply.set(status(true)); open(); button().performClick(); runMainUntil { media.closes == 1 }; destroyOldService()
        runMainUntil { field(activity, "starting") == true }; assertNull(Shadows.shadowOf(app).nextStartedService)
        store.closeRoomAlert(waitingCall, ""); NativeRoomNotifications.cancelTerminal(app, waitingCall, "")
        Shadows.shadowOf(Looper.getMainLooper()).idle(); assertTrue(activity.isFinishing)
        activity.onRequestPermissionsResult(41, arrayOf(Manifest.permission.RECORD_AUDIO), intArrayOf(android.content.pm.PackageManager.PERMISSION_GRANTED))
        assertNull(Shadows.shadowOf(app).nextStartedService)
    }
    @Test fun delayedWaitingStatusCannotAnswerAfterReplacementIntent() {
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        open(requester = NativeRoomCleanupProcessor.Requester { path, _, _, _ ->
            if (path == "/calls/$waitingCall/status") { entered.countDown(); assertTrue(release.await(3, TimeUnit.SECONDS)); status(true) }
            else status(true, id = "out_new_waiting_call_1234567890")
        })
        button().performClick(); runMainUntil { entered.count == 0L }
        activityController!!.newIntent(Intent(app, NativeRoomCallActivity::class.java).putExtra("room_action", "show").putExtra("call_id", "out_new_waiting_call_1234567890"))
        release.countDown(); Shadows.shadowOf(Looper.getMainLooper()).idleFor(1, TimeUnit.SECONDS)
        assertEquals("out_new_waiting_call_1234567890", field(activity, "callId")); assertNull(Shadows.shadowOf(app).nextStartedService)
    }
    @Test fun replacementEnrollmentCancelsDelayedWaitingAuthorization() {
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        open(requester = NativeRoomCleanupProcessor.Requester { _, _, _, _ -> entered.countDown(); assertTrue(release.await(3, TimeUnit.SECONDS)); status(true) })
        button().performClick(); runMainUntil { entered.count == 0L }
        store.clearEnrollment(); val id = "android_replacement_device_12345678"
        store.enrollIfGeneration(id, "$id.abcdefghijklmnopqrstuvwxyz0123456789", System.currentTimeMillis() + 1000000, store.credential().generation)
        release.countDown(); runMainUntil { message().contains("registration changed") }; assertNull(Shadows.shadowOf(app).nextStartedService)
    }
    @Test fun failedIncomingPreflightPreservesCurrentAudioAndRequiresExplicitRetry() {
        open(requester = NativeRoomCleanupProcessor.Requester { _, _, _, _ -> throw java.io.IOException("synthetic disconnected network") })
        button().performClick(); runMainUntil { message().contains("Could not verify") }
        assertEquals(0, media.closes); assertTrue(NativeRoomCallService.isRunning()); assertEquals("Retry answer", button().text.toString())
        assertNull(Shadows.shadowOf(app).nextStartedService)
    }
    @Test fun delayedPreflightCannotEndAReplacementActiveAttempt() {
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        open(requester = NativeRoomCleanupProcessor.Requester { _, _, _, _ -> entered.countDown(); assertTrue(release.await(3, TimeUnit.SECONDS)); status(true) })
        button().performClick(); runMainUntil { entered.count == 0L }; assertEquals(0, media.closes)
        set(service, "requestId", replacement); set(service, "legId", "leg-A2"); release.countDown()
        runMainUntil { message().contains("active call changed") }; assertEquals(0, media.closes); assertTrue(NativeRoomCallService.isRunning())
        assertNull(Shadows.shadowOf(app).nextStartedService)
    }
    @Test fun customerEndDuringPreflightPreservesExistingCall() {
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        open(requester = NativeRoomCleanupProcessor.Requester { _, _, _, _ -> entered.countDown(); assertTrue(release.await(3, TimeUnit.SECONDS)); status(true, "ended") })
        button().performClick(); runMainUntil { entered.count == 0L }; assertEquals(0, media.closes); release.countDown()
        runMainUntil { message().contains("incoming call has ended") }; assertEquals(0, media.closes); assertTrue(NativeRoomCallService.isRunning())
    }
    @Test fun waitingCustomerEndDuringOldCallCleanupPreventsAnswer() {
        open(); button().performClick(); runMainUntil { media.closes == 1 }; destroyOldService()
        reply.set(status(true, "ended")); runMainUntil { message().contains("incoming call has ended") }
        assertEquals(1, media.closes); assertFalse(button().isEnabled); assertNull(Shadows.shadowOf(app).nextStartedService)
    }
    @Test fun endedWaitingCallCanBecomeExplicitCallbackAfterOldServiceEnds() {
        val ended = status(true, "ended"); ended.getJSONObject("call").put("customerPhone", "919876543210"); reply.set(ended)
        open(); assertTrue(NativeRoomCallService.commandForAttempt(attempt, "leg-A1", "end", "")); destroyOldService()
        runMainUntil { field(activity, "action") == "dial" }
        assertEquals(false, field(activity, "waitingCleanupRequired")); assertNull(field(activity, "waitingAnswer"))
        button().performClick(); runMainUntil { field(activity, "expectedAttemptId") != "" }
        val started = Shadows.shadowOf(app).nextStartedService!!
        assertEquals("outgoing", started.getStringExtra("room_action")); assertEquals("919876543210", started.getStringExtra("phone"))
        assertEquals("", started.getStringExtra("call_id")); assertNull(Shadows.shadowOf(app).nextStartedService)
    }
    private fun transferStatus(availableForThisCall: Boolean): JSONObject {
        val result = status(false, "connected", "android_source_device_12345678").put("deviceAvailableForCall", availableForThisCall)
        result.getJSONObject("call").put("transfer", JSONObject().put("id", "exact-invitation").put("toDeviceId", store.deviceId()).put("status", "invited"))
        return result
    }
    @Test fun exactWaitingTransferCanUseItsOwnInviteReservationWithoutClaimingDeviceGloballyFree() {
        reply.set(transferStatus(true)); open("exact-invitation"); button().performClick(); runMainUntil { media.closes == 1 }; destroyOldService()
        runMainUntil { field(activity, "expectedAttemptId") != "" }
        val started = Shadows.shadowOf(app).nextStartedService!!
        assertEquals(waitingCall, started.getStringExtra("call_id")); assertEquals("exact-invitation", started.getStringExtra("transfer_id"))
        assertEquals("accept", started.getStringExtra("room_action")); assertNull(Shadows.shadowOf(app).nextStartedService)
    }
    @Test fun mismatchedTransferReservationPreservesCurrentCallDespiteValidLookingInvitation() {
        reply.set(transferStatus(false)); open("exact-invitation"); button().performClick()
        runMainUntil { message().contains("no longer available on this phone") }
        assertEquals(0, media.closes); assertTrue(NativeRoomCallService.isRunning()); assertNull(Shadows.shadowOf(app).nextStartedService)
    }
}
