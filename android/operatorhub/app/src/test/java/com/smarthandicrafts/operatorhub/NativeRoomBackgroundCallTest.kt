package com.smarthandicrafts.operatorhub

import android.app.Activity
import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import android.content.Intent
import android.os.Looper
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
import org.robolectric.android.controller.ServiceController
import org.robolectric.annotation.Config
import java.util.concurrent.ExecutorService
import java.util.concurrent.TimeUnit

/** The actual Service stays alive while call screens and unrelated Activities leave. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], application = Application::class)
class NativeRoomBackgroundCallTest {
    private val call = "out_0123456789abcdef0123456789abcdef"
    private val attempt = "de3cc9b1-d0f7-4c06-a677-2c99cf8ef319"
    private lateinit var controller: ServiceController<NativeRoomCallService>
    private lateinit var service: NativeRoomCallService
    private lateinit var media: Media
    private lateinit var previousConnections: Any
    private class Media : NativeRoomMedia {
        var closed = 0
        var silenced = 0
        override fun connect(descriptor: JSONObject) = Unit
        override fun setMuted(value: Boolean) = Unit
        override fun setSpeaker(value: Boolean) = Unit
        override fun silenceForClose(): Boolean { silenced++; return true }
        override fun close() { closed++ }
    }
    private fun set(name: String, value: Any) = NativeRoomCallService::class.java.getDeclaredField(name).apply { isAccessible = true }.set(service, value)
    private fun get(name: String): Any = NativeRoomCallService::class.java.getDeclaredField(name).apply { isAccessible = true }.get(service)
    private fun emit() = NativeRoomCallService::class.java.getDeclaredMethod("emit").apply { isAccessible = true }.invoke(service)
    private fun note(): Notification? = Shadows.shadowOf(RuntimeEnvironment.getApplication().getSystemService(NotificationManager::class.java))
        .getNotification(NativeRoomNotifications.ACTIVE_ID)
    private fun shown(): Intent = NativeRoomNotifications.activity(RuntimeEnvironment.getApplication(), call, "", "show")
        .putExtra("client_attempt_id", attempt).putExtra("owner_leg_id", "leg-A1").putExtra("channel_id", 73)

    @Before fun connectedCall() {
        val app = RuntimeEnvironment.getApplication()
        Shadows.shadowOf(app).grantPermissions("com.smarthandicrafts.operatorhub.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION")
        CallAlerts.createChannels(app)
        val factory = NativeApi::class.java.getDeclaredField("connections").apply { isAccessible = true }
        previousConnections = factory.get(null)
        // No lifecycle/notification test may reach the production transport.
        factory.set(null, NativeApi.ConnectionFactory { throw NativeApi.ApiException(404, "Synthetic ended call", JSONObject()) })
        val store = NativeStore(app); val device = "android_1234567890abcdefghijklmnop"
        assertTrue(store.enrollIfGeneration(device, "$device.abcdefghijklmnopqrstuvwxyz0123456789", System.currentTimeMillis() + 1000000, store.credential().generation))
        controller = Robolectric.buildService(NativeRoomCallService::class.java).create()
        service = controller.get(); media = Media()
        set("credential", store.credential()); set("callId", call); set("requestId", attempt); set("legId", "leg-A1")
        set("engine", media); set("readyCommitted", true); set("state", "connected"); set("detail", "Connected")
        set("channelId", 73); set("displayName", "Test customer")
        set("epoch", (get("guard") as NativeRoomPolicy.Epoch).begin())
        (get("health") as NativeRoomCallHealth).apply { start(1); evidence(); connected(true, 100) }
        service.startForeground(NativeRoomNotifications.ACTIVE_ID, NativeRoomNotifications.ongoing(service, call, "", "Connected"))
        emit(); Shadows.shadowOf(Looper.getMainLooper()).idle()
    }
    @After fun done() {
        controller.destroy(); Shadows.shadowOf(Looper.getMainLooper()).idle()
        for (name in listOf("FRESH_CONTROL_IO", "CONTROL_IO")) {
            val executor = NativeRoomCleanup::class.java.getDeclaredField(name).apply { isAccessible = true }.get(null) as ExecutorService
            executor.submit {}.get(3, TimeUnit.SECONDS)
        }
        NativeApi::class.java.getDeclaredField("connections").apply { isAccessible = true }.set(null, previousConnections)
    }
    private fun assertAudioStillOwned() {
        assertTrue(NativeRoomCallService.isRunning())
        assertEquals(attempt, NativeRoomCallService.snapshot()!!.getString("clientAttemptId"))
        assertFalse(NativeRoomCallService.snapshot()!!.getBoolean("closed"))
        assertEquals(0, media.closed); assertEquals(0, media.silenced)
        assertNotNull(note())
        assertTrue(note()!!.flags and Notification.FLAG_ONGOING_EVENT != 0)
        assertFalse(note()!!.flags and Notification.FLAG_AUTO_CANCEL != 0)
    }

    @Test fun backReturnsToTheSourceChatAndDestroyingTheCallScreenKeepsAudioAndNotification() {
        val screen = Robolectric.buildActivity(NativeRoomCallActivity::class.java, shown()).setup()
        screen.get().onBackPressed()
        val navigation = Shadows.shadowOf(screen.get()).nextStartedActivity
        assertEquals(MainActivity::class.java.name, navigation.component!!.className)
        assertEquals(73, navigation.getIntExtra("channel_id", 0))
        assertFalse(navigation.hasExtra("native_closed_call_id"))
        assertTrue(screen.get().isFinishing)
        screen.pause().stop().destroy(); Shadows.shadowOf(Looper.getMainLooper()).idle()
        assertAudioStillOwned()
    }

    @Test fun switchingAppsAndRemovingTheUiTaskDoesNotEndTheCallAndNotificationReopensTheSameAttempt() {
        val screen = Robolectric.buildActivity(NativeRoomCallActivity::class.java, shown()).setup()
        screen.pause().stop()
        val other = Robolectric.buildActivity(Activity::class.java).setup()
        other.pause().stop().destroy()
        screen.destroy()
        service.onTaskRemoved(Intent(Intent.ACTION_MAIN))
        assertAudioStillOwned()
        val reopen = Shadows.shadowOf(note()!!.contentIntent).savedIntent
        assertEquals(call, reopen.getStringExtra("call_id"))
        assertEquals(attempt, reopen.getStringExtra("client_attempt_id"))
        assertEquals("leg-A1", reopen.getStringExtra("owner_leg_id"))
        assertEquals("show", reopen.getStringExtra("room_action"))
        val restored = Robolectric.buildActivity(NativeRoomCallActivity::class.java, reopen).setup()
        try {
            val status = NativeRoomCallActivity::class.java.getDeclaredField("status").apply { isAccessible = true }.get(restored.get()) as TextView
            assertEquals("Connected", status.text.toString())
            assertAudioStillOwned()
        } finally { restored.pause().stop().destroy() }
    }

    @Test fun notificationEndStillClosesOnlyTheExactBackgroundCall() {
        val ongoing = note()!!
        val action = ongoing.actions.single { it.title.toString() == "End" }
        val intent = Shadows.shadowOf(action.actionIntent).savedIntent
        assertEquals(attempt, intent.getStringExtra("client_attempt_id"))
        assertEquals("leg-A1", intent.getStringExtra("owner_leg_id"))
        assertFalse(NativeRoomCallService.endFromNotification(call, "23f5e680-949b-45a7-93c5-24f2e85a8375", "leg-old"))
        assertAudioStillOwned()
        assertTrue(NativeRoomCallService.endFromNotification(call, attempt, "leg-A1"))
        assertFalse(NativeRoomCallService.isRunning())
        assertEquals(1, media.closed)
        assertTrue(NativeRoomCallService.snapshot()!!.optBoolean("closed"))
    }
}
