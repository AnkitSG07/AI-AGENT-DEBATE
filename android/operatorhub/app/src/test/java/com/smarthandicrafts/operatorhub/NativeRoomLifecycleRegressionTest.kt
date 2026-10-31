package com.smarthandicrafts.operatorhub

import android.Manifest
import android.app.Application
import android.content.Intent
import android.os.Looper
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
import org.robolectric.android.controller.ServiceController
import org.robolectric.annotation.Config
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], application = Application::class)
class NativeRoomLifecycleRegressionTest {
    private lateinit var controller: ServiceController<NativeRoomCallService>
    private lateinit var service: NativeRoomCallService
    private lateinit var store: NativeStore
    private val a = "de3cc9b1-d0f7-4c06-a677-2c99cf8ef319"
    private val b = "23f5e680-949b-45a7-93c5-24f2e85a8375"
    private val call = "out_0123456789abcdef0123456789abcdef"
    private lateinit var fake: FakeMedia
    private class FakeMedia : NativeRoomMedia {
        var closes = 0; var muteChanges = 0; var speakerChanges = 0
        override fun connect(descriptor: JSONObject) = Unit
        override fun setMuted(value: Boolean) { muteChanges++ }
        override fun setSpeaker(value: Boolean) { speakerChanges++ }
        override fun close() { closes++ }
    }
    @Before fun setup() {
        val context = RuntimeEnvironment.getApplication()
        Shadows.shadowOf(context).grantPermissions("com.smarthandicrafts.operatorhub.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION")
        store = NativeStore(context)
        val id = "android_1234567890abcdefghijklmnop"
        store.enrollIfGeneration(id, "$id.abcdefghijklmnopqrstuvwxyz0123456789", System.currentTimeMillis() + 1000000, store.credential().generation)
        controller = Robolectric.buildService(NativeRoomCallService::class.java).create()
        service = controller.get(); fake = FakeMedia()
        set("credential", store.credential()); set("callId", call); set("requestId", a); set("legId", "leg-A1")
        set("engine", fake); set("readyCommitted", true); set("state", "connected")
        val guard = get("guard") as NativeRoomPolicy.Epoch; set("epoch", guard.begin())
        val health = get("health") as NativeRoomCallHealth; health.start(1); health.evidence(); health.connected(true, 2)
        set("lastStatusOkAt", android.os.SystemClock.elapsedRealtime())
    }
    @After fun teardown() { if (::controller.isInitialized) controller.destroy(); Shadows.shadowOf(Looper.getMainLooper()).idle() }
    private fun set(name: String, value: Any) { NativeRoomCallService::class.java.getDeclaredField(name).apply { isAccessible = true }.set(service, value) }
    private fun get(name: String): Any? = NativeRoomCallService::class.java.getDeclaredField(name).apply { isAccessible = true }.get(service)
    private fun invoke(name: String) { NativeRoomCallService::class.java.getDeclaredMethod(name).apply { isAccessible = true }.invoke(service) }
    private fun evidence(value: JSONObject) { NativeRoomCallService::class.java.getDeclaredMethod("recordMediaEvidence",JSONObject::class.java).apply { isAccessible = true }.invoke(service,value) }
    private fun boundStart(intent: Intent): Intent = intent.putExtra("enrollment_generation",store.credential().generation).putExtra("enrolled_device_id",store.deviceId())
    private fun runMainUntil(condition: () -> Boolean) {
        val end = System.nanoTime() + TimeUnit.SECONDS.toNanos(3)
        while (!condition() && System.nanoTime() < end) { Shadows.shadowOf(Looper.getMainLooper()).idleFor(10,TimeUnit.MILLISECONDS); Thread.sleep(5) }
        assertTrue("Expected asynchronous call transition did not occur", condition())
    }
    @Test fun registrationRemovalClosesActualServiceMediaEvenWhileStatusIsBlocked() {
        val entered = CountDownLatch(1); val release = CountDownLatch(1); val returned = CountDownLatch(1)
        set("callApi", NativeRoomCleanupProcessor.Requester { _, _, _, _ ->
            entered.countDown(); assertTrue(release.await(3,TimeUnit.SECONDS)); returned.countDown()
            JSONObject().put("ok",true).put("call",JSONObject().put("version",7).put("phase","connected").put("ownerDeviceId",store.deviceId()).put("ownerLegId","leg-A1").put("roomReady",true))
        })
        invoke("beginPolling"); runMainUntil { entered.count == 0L }
        store.clearEnrollment(); Shadows.shadowOf(Looper.getMainLooper()).idle()
        assertEquals(1,fake.closes); assertFalse(NativeRoomCallService.isRunning()); assertTrue(NativeRoomCallService.snapshot()!!.optBoolean("closed"))
        release.countDown(); runMainUntil { returned.count == 0L }; Shadows.shadowOf(Looper.getMainLooper()).idle()
        assertEquals(1,fake.closes); assertFalse(NativeRoomCallService.isRunning())
    }
    @Test fun networkFailureAfterCredentialChangeCannotLeaveTheOldMicrophoneOpen() {
        val entered = CountDownLatch(1); val release = CountDownLatch(1); val returned = CountDownLatch(1)
        set("callApi", NativeRoomCleanupProcessor.Requester { _, _, _, _ -> entered.countDown(); assertTrue(release.await(3,TimeUnit.SECONDS)); returned.countDown(); throw IOException("simulated dropped response") })
        invoke("beginPolling"); runMainUntil { entered.count == 0L }
        store.clearEnrollment(); Shadows.shadowOf(Looper.getMainLooper()).idle(); release.countDown(); runMainUntil { returned.count == 0L }
        assertEquals(1,fake.closes); assertFalse(NativeRoomCallService.isRunning())
    }
    @Test fun lateTransferDialogAndOldScreenCannotControlANewerAttempt() {
        set("requestId", b); set("legId", "leg-A2")
        assertFalse(NativeRoomCallService.commandForAttempt(a,"leg-A1","mute",""))
        assertFalse(NativeRoomCallService.commandForAttempt(a,"leg-A1","speaker",""))
        assertFalse(NativeRoomCallService.commandForAttempt(a,"leg-A1","transfer","android_other_device_12345678"))
        assertFalse(NativeRoomCallService.endFromNotification(call,a,"leg-A1"))
        assertEquals(0,fake.closes); assertEquals(0,fake.muteChanges); assertEquals(0,fake.speakerChanges)
        assertTrue(NativeRoomCallService.commandForAttempt(b,"leg-A2","mute","")); assertEquals(1,fake.muteChanges)
    }
    @Test fun serviceRefusesAnAttemptCancelledBeforeAndroidDeliveredStartIntent() {
        controller.destroy()
        store.cancelRoomAttempt(b)
        controller = Robolectric.buildService(NativeRoomCallService::class.java).create(); service = controller.get()
        val starts = Intent().putExtra("client_attempt_id",b).putExtra("room_action","outgoing").putExtra("phone","919876543210")
        service.onStartCommand(starts,0,1)
        assertTrue(NativeRoomCallService.snapshot()!!.optBoolean("closed")); assertEquals("Call cancelled",NativeRoomCallService.snapshot()!!.optString("detail"))
    }
    @Test fun oldOwnerStatusAfterAtoBtoAReleasesOldMediaWithoutTerminatingNewLeg() {
        val status = JSONObject().put("ok",true).put("call",JSONObject().put("version",10).put("phase","connected")
            .put("ownerDeviceId",store.deviceId()).put("ownerLegId","leg-A2").put("roomReady",true))
        NativeRoomCallService::class.java.getDeclaredMethod("applyStatus",JSONObject::class.java).apply { isAccessible = true }.invoke(service,status)
        assertEquals(1,fake.closes); assertTrue(NativeRoomCallService.snapshot()!!.optBoolean("closed")); assertEquals("transferred",NativeRoomCallService.snapshot()!!.optString("state"))
    }
    @Test fun outgoingLostAckStatusOnlyResultKeepsSameAttemptAndDoesNotRedial() {
        controller.destroy(); controller = Robolectric.buildService(NativeRoomCallService::class.java).create(); service = controller.get()
        Shadows.shadowOf(RuntimeEnvironment.getApplication()).grantPermissions(Manifest.permission.RECORD_AUDIO)
        val dials = AtomicInteger(); val polls = AtomicInteger(); val accepts = AtomicInteger()
        val pending = JSONObject().put("ok",true).put("call",JSONObject().put("sessionId",call).put("version",3).put("phase","uncertain").put("ownerDeviceId",store.deviceId()))
        set("callApi", NativeRoomCleanupProcessor.Requester { path, _, body, _ ->
            when {
                path == "/calls/outgoing" -> { dials.incrementAndGet(); assertEquals(b,body.getString("requestId")); pending }
                path.endsWith("/status") -> { polls.incrementAndGet(); pending }
                path.endsWith("/accept") -> { accepts.incrementAndGet(); throw NativeApi.ApiException(409,"operation pending",JSONObject().put("code","CALL_OPERATION_PENDING")) }
                else -> throw AssertionError("Unexpected request")
            }
        })
        service.onStartCommand(boundStart(Intent().putExtra("client_attempt_id",b).putExtra("room_action","outgoing").putExtra("phone","919876543210")),0,1)
        runMainUntil { polls.get() > 0 && accepts.get() > 0 }
        assertEquals(1,dials.get()); assertFalse(NativeRoomCallService.snapshot()!!.optBoolean("closed"))
        assertEquals(call,NativeRoomCallService.snapshot()!!.optString("callId")); assertEquals(0L,NativeRoomCallService.snapshot()!!.optLong("connectedAtElapsed"))
    }
    @Test fun pendingIncomingAcceptWithoutSessionIdReconcilesExistingCallInsteadOfFailing() {
        controller.destroy(); controller = Robolectric.buildService(NativeRoomCallService::class.java).create(); service = controller.get()
        Shadows.shadowOf(RuntimeEnvironment.getApplication()).grantPermissions(Manifest.permission.RECORD_AUDIO)
        val polls = AtomicInteger()
        set("callApi", NativeRoomCleanupProcessor.Requester { path, _, _, _ ->
            if (path.endsWith("/status")) {
                polls.incrementAndGet(); JSONObject().put("ok",true).put("call",JSONObject().put("sessionId",call).put("version",3).put("phase","uncertain").put("ownerDeviceId",store.deviceId()))
            } else throw NativeApi.ApiException(409,"operation pending",JSONObject().put("code","CALL_OPERATION_PENDING"))
        })
        service.onStartCommand(boundStart(Intent().putExtra("client_attempt_id",b).putExtra("room_action","accept").putExtra("call_id",call)),0,1)
        runMainUntil { polls.get() > 0 }; assertFalse(NativeRoomCallService.snapshot()!!.optBoolean("closed"))
        assertEquals(call,NativeRoomCallService.snapshot()!!.optString("callId")); assertEquals(0L,NativeRoomCallService.snapshot()!!.optLong("connectedAtElapsed"))
    }
    @Test fun repeatedTransferTapAndLostAckReuseTheSameInvitationKey() {
        store.roomCapabilitiesIfMatches(store.credential(),true,true,System.currentTimeMillis())
        val first = CountDownLatch(1); val posted = java.util.Collections.synchronizedList(mutableListOf<String>())
        set("callApi", NativeRoomCleanupProcessor.Requester { path, _, body, _ ->
            assertTrue(path.endsWith("/transfers")); posted.add(body.getString("requestId"))
            if (posted.size == 1) { first.countDown(); throw IOException("lost first response") }
            JSONObject().put("ok",true).put("call",JSONObject().put("version",9).put("phase","connected").put("ownerDeviceId",store.deviceId()).put("ownerLegId","leg-A1").put("roomReady",true)
                .put("transfer",JSONObject().put("id","T1").put("status","invited").put("fromDeviceId",store.deviceId()).put("toDeviceId","android_other_device_12345678")))
        })
        assertTrue(NativeRoomCallService.commandForAttempt(a,"leg-A1","transfer","android_other_device_12345678"))
        assertTrue(NativeRoomCallService.commandForAttempt(a,"leg-A1","transfer","android_other_device_12345678"))
        runMainUntil { first.count == 0L }; Shadows.shadowOf(Looper.getMainLooper()).idleFor(500,TimeUnit.MILLISECONDS)
        runMainUntil { posted.size == 2 && NativeRoomCallService.snapshot()!!.optString("sourceTransferId") == "T1" }
        assertEquals(posted[0],posted[1]); assertEquals(2,posted.size); assertEquals(0,fake.closes)
    }
    @Test fun delayedAndroidStartCannotUseAReplacementEnrollment() {
        val queued = boundStart(Intent().putExtra("client_attempt_id",b).putExtra("room_action","accept").putExtra("call_id",call))
        controller.destroy(); controller = Robolectric.buildService(NativeRoomCallService::class.java).create(); service = controller.get()
        val requests = AtomicInteger(); set("callApi",NativeRoomCleanupProcessor.Requester { _,_,_,_ -> requests.incrementAndGet(); throw AssertionError("Stale start made a request") })
        Shadows.shadowOf(RuntimeEnvironment.getApplication()).grantPermissions(Manifest.permission.RECORD_AUDIO)
        store.clearEnrollment(); val replacement="android_replacement_device_12345678"
        assertTrue(store.enrollIfGeneration(replacement,"$replacement.abcdefghijklmnopqrstuvwxyz0123456789",System.currentTimeMillis()+1000000,store.credential().generation))
        service.onStartCommand(queued,0,1); Shadows.shadowOf(Looper.getMainLooper()).idle()
        assertEquals(0,requests.get()); assertFalse(NativeRoomCallService.isRunning())
        assertEquals("Device registration changed. Reopen the call.",NativeRoomCallService.snapshot()!!.optString("detail"))
    }
    @Test fun mutedCustomerShowsTransportReadyWithoutClaimingBidirectionalAudio() {
        evidence(JSONObject().put("readinessMode","customer-muted-transport").put("customerMuted",true))
        val view=NativeRoomCallService.snapshot()!!
        assertEquals("connected",view.optString("state")); assertEquals("Customer microphone muted",view.optString("detail"))
        assertTrue(view.optBoolean("transportReady")); assertTrue(view.optBoolean("customerMuted")); assertFalse(view.optBoolean("bidirectionalAudio"))
    }
    @Test fun customerUnmuteNeedsFreshRealMediaBeforeTheUiClaimsRecoveredAudio() {
        evidence(JSONObject().put("readinessMode","customer-muted-transport").put("customerMuted",true))
        NativeRoomCallService::class.java.getDeclaredMethod("customerMuteChanged",Boolean::class.javaPrimitiveType).apply { isAccessible = true }.invoke(service,false)
        assertEquals("reconnecting",NativeRoomCallService.snapshot()!!.optString("state")); assertFalse(NativeRoomCallService.snapshot()!!.optBoolean("bidirectionalAudio"))
        evidence(JSONObject().put("customerMuted",false))
        assertEquals("Connected",NativeRoomCallService.snapshot()!!.optString("detail")); assertTrue(NativeRoomCallService.snapshot()!!.optBoolean("bidirectionalAudio"))
    }
    @Test fun transferNeverCommitsOnMutedOnlyEvidenceAndKeepsDestinationPending() {
        set("readyCommitted",false); set("transferId","transfer-A-to-B"); set("nonce","simulation-nonce")
        val requests=AtomicInteger();set("callApi",NativeRoomCleanupProcessor.Requester{_,_,_,_->requests.incrementAndGet();throw AssertionError("Muted-only transfer must not send ready")})
        evidence(JSONObject().put("readinessMode","customer-muted-transport").put("customerMuted",true)); Shadows.shadowOf(Looper.getMainLooper()).idle()
        assertEquals(0,requests.get()); assertFalse(NativeRoomCallService.snapshot()!!.optBoolean("transportReady")); assertFalse(NativeRoomCallService.snapshot()!!.optBoolean("closed"))
        assertEquals("transfer-A-to-B",NativeRoomCallService.snapshot()!!.optString("transferId"));assertTrue(NativeRoomCallService.snapshot()!!.optString("detail").contains("first phone stays connected"))
    }
    @Test fun incomingBusyReservationRetriesTheSameAnswerAfterPreviousCleanup() {
        controller.destroy();controller=Robolectric.buildService(NativeRoomCallService::class.java).create();service=controller.get()
        Shadows.shadowOf(RuntimeEnvironment.getApplication()).grantPermissions(Manifest.permission.RECORD_AUDIO)
        val answers=java.util.Collections.synchronizedList(mutableListOf<String>())
        set("callApi",NativeRoomCleanupProcessor.Requester{path,_,body,_->
            if(path.endsWith("/accept")){
                answers.add(body.getString("requestId"))
                if(answers.size==1)throw NativeApi.ApiException(409,"Previous reservation still settling",JSONObject().put("code","DEVICE_BUSY"))
            }
            JSONObject().put("ok",true).put("call",JSONObject().put("sessionId",call).put("version",3).put("phase","ringing").put("ownerDeviceId",JSONObject.NULL))
        })
        service.onStartCommand(boundStart(Intent().putExtra("client_attempt_id",b).putExtra("room_action","accept").putExtra("call_id",call)),0,1)
        runMainUntil{answers.size==1&&NativeRoomCallService.snapshot()!!.optString("detail")=="Finishing the previous call before answering"}
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(600,TimeUnit.MILLISECONDS);runMainUntil{answers.size==2}
        assertEquals(listOf(b,b),answers);assertFalse(NativeRoomCallService.snapshot()!!.optBoolean("closed"));assertNull(get("engine"))
    }
    @Test fun terminalIncomingAlertCancelsBusyRetriesWithoutOpeningMicrophone() {
        controller.destroy();controller=Robolectric.buildService(NativeRoomCallService::class.java).create();service=controller.get()
        Shadows.shadowOf(RuntimeEnvironment.getApplication()).grantPermissions(Manifest.permission.RECORD_AUDIO)
        val answers=AtomicInteger()
        set("callApi",NativeRoomCleanupProcessor.Requester{path,_,_,_->
            assertTrue(path.endsWith("/accept"));answers.incrementAndGet();throw NativeApi.ApiException(409,"Previous reservation still settling",JSONObject().put("code","DEVICE_BUSY"))
        })
        service.onStartCommand(boundStart(Intent().putExtra("client_attempt_id",b).putExtra("room_action","accept").putExtra("call_id",call)),0,1)
        runMainUntil{answers.get()==1};store.closeRoomAlert(call,"");Shadows.shadowOf(Looper.getMainLooper()).idleFor(600,TimeUnit.MILLISECONDS)
        runMainUntil{NativeRoomCallService.snapshot()!!.optBoolean("closed")}
        assertEquals("The incoming call is no longer available.",NativeRoomCallService.snapshot()!!.optString("detail"));assertNull(get("engine"));assertEquals(1,answers.get())
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(2,TimeUnit.SECONDS);assertEquals(1,answers.get())
    }
    @Test fun persistentBusyReservationHasABoundedWaitAndNeverStartsAudio() {
        controller.destroy();controller=Robolectric.buildService(NativeRoomCallService::class.java).create();service=controller.get()
        Shadows.shadowOf(RuntimeEnvironment.getApplication()).grantPermissions(Manifest.permission.RECORD_AUDIO)
        val answers=AtomicInteger()
        set("callApi",NativeRoomCleanupProcessor.Requester{path,_,body,_->
            assertTrue(path.endsWith("/accept"));assertEquals(b,body.getString("requestId"));answers.incrementAndGet()
            throw NativeApi.ApiException(409,"Previous reservation still settling",JSONObject().put("code","DEVICE_BUSY"))
        })
        service.onStartCommand(boundStart(Intent().putExtra("client_attempt_id",b).putExtra("room_action","accept").putExtra("call_id",call)),0,1)
        runMainUntil{NativeRoomCallService.snapshot()!!.optString("detail")=="Finishing the previous call before answering"}
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(16,TimeUnit.SECONDS);runMainUntil{NativeRoomCallService.snapshot()!!.optBoolean("closed")}
        assertEquals("The previous call is still finishing. Try Answer again.",NativeRoomCallService.snapshot()!!.optString("detail"));assertNull(get("engine"))
        val settled=answers.get();Shadows.shadowOf(Looper.getMainLooper()).idleFor(2,TimeUnit.SECONDS);assertEquals(settled,answers.get())
    }
}
