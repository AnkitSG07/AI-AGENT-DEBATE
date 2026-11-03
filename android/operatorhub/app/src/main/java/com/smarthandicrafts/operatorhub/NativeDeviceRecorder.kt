package com.smarthandicrafts.operatorhub

import android.content.Context
import android.os.SystemClock
import android.util.Base64
import org.json.JSONObject
import java.nio.ByteBuffer
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Copies PCM off the audio callback; mixing, disk I/O and upload scheduling
 * run independently of the SDK audio, main and call-control threads. */
internal class NativeDeviceRecorder(context: Context, private val callId: String,
    private val credential: DeviceLeasePolicy.Credential, private val legId: String, private val onState: (String, String) -> Unit) {
    private val app = context.applicationContext
    private val work = Executors.newSingleThreadScheduledExecutor()
    private val queued = AtomicInteger()
    @Volatile private var active = false
    @Volatile private var closed = false
    @Volatile var routeAllowed = true
    @Volatile var microphoneAllowed = true
    private var configuredId = ""
    private var configuredActive = false
    @Volatile private var generation = 0L
    private var mixer: NativePcmMixer? = null
    private var startTick = 0L
    private var connectionTick = 0L
    private var connectionWall = 0L
    private var lastUsageTick = 0L
    private val connectionId = UUID.randomUUID().toString()
    init { work.scheduleAtFixedRate({
        safely {
            if (active) mixer?.advance(SystemClock.elapsedRealtime() - startTick)
        }
        // Usage accounting failure cannot stop an otherwise healthy recording.
        if (connectionTick > 0 && SystemClock.elapsedRealtime() - lastUsageTick >= 60000) runCatching { usage() }
    }, 250, 250, TimeUnit.MILLISECONDS) }
    fun wantsTracks() = !closed && configuredActive
    fun connected(wall: Long = System.currentTimeMillis(), tick: Long = SystemClock.elapsedRealtime()) {
        if (closed) return
        work.execute { if (connectionTick == 0L) {
            connectionTick = tick; connectionWall = wall; lastUsageTick = tick
        } }
    }
    fun configure(value: JSONObject) {
        val id = value.optString("id")
        val wanted = value.optString("mode") == "device" && value.optBoolean("active") &&
            value.optString("ownerDeviceId") == credential.deviceId && value.optString("ownerLegId") == legId
        if (closed || id == configuredId && configuredActive == wanted) return
        active = false; configuredId = id; configuredActive = wanted
        val ticket = ++generation
        work.execute { safely {
            if (ticket != generation) return@safely
            finish()
            if (!closed && wanted) {
                val segmentId = UUID.randomUUID().toString(); val wall = System.currentTimeMillis()
                startTick = SystemClock.elapsedRealtime()
                mixer = NativePcmMixer { index, offset, bytes ->
                    NativeMediaUploads.enqueue(app, credential, "/calls/${android.net.Uri.encode(callId)}/recordings/$id/parts",
                        JSONObject().put("segmentId", segmentId).put("index", index).put("capturedAt", wall + offset)
                            .put("pcm", Base64.encodeToString(bytes, Base64.NO_WRAP)))
                }
                active = true; onState("recording", "")
            } else onState("saved", "")
        } }
    }
    fun capture(track: String, buffer: ByteBuffer, bits: Int, rate: Int, channels: Int, local: Boolean) {
        if (closed || !active || !routeAllowed || local && !microphoneAllowed) return
        if (buffer.remaining() > 192000) return
        if (queued.incrementAndGet() > 250) {
            queued.decrementAndGet(); active = false; onState("failed", "Recording stopped because this phone is busy. Saved audio is retained."); return
        }
        val bytes = ByteArray(buffer.remaining()); buffer.duplicate().get(bytes)
        val at = SystemClock.elapsedRealtime()
        val ticket = generation
        try { work.execute {
            try { safely { if (ticket == generation) mixer?.add(track, bytes, bits, rate, channels, at - startTick) } }
            finally { queued.decrementAndGet() }
        } } catch (_: RuntimeException) { queued.decrementAndGet() }
    }
    private fun finish() {
        mixer?.advance(SystemClock.elapsedRealtime() - startTick, true); mixer = null
    }
    private fun usage() {
        if (connectionTick == 0L) return
        lastUsageTick = SystemClock.elapsedRealtime()
        NativeMediaUploads.enqueue(app, credential, "/calls/${android.net.Uri.encode(callId)}/media-usage",
            JSONObject().put("connectionId", connectionId).put("startedAt", connectionWall)
                .put("durationMs", (lastUsageTick - connectionTick).coerceAtLeast(0)))
    }
    private fun safely(action: () -> Unit) {
        try { action() } catch (_: Exception) {
            active = false; mixer = null; onState("failed", "Recording could not be saved. Check pending uploads in App settings.")
        }
    }
    fun close() {
        if (closed) return
        closed = true; active = false
        work.execute { safely { finish() }; safely { usage() }; work.shutdown() }
    }
}
