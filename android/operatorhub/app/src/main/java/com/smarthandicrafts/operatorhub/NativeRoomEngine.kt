package com.smarthandicrafts.operatorhub

import android.content.Context
import android.media.AudioManager
import android.os.SystemClock
import io.livekit.android.ConnectOptions
import io.livekit.android.LiveKit
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import io.livekit.android.room.participant.AudioTrackPublishDefaults
import io.livekit.android.room.track.RemoteAudioTrack
import io.livekit.android.room.track.RemoteTrackPublication
import io.livekit.android.room.track.Track
import com.twilio.audioswitch.AudioDevice
import com.twilio.audioswitch.AudioDeviceChangeListener
import kotlinx.coroutines.*
import livekit.org.webrtc.AudioTrackSink
import livekit.org.webrtc.RTCStatsReport
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicLong
import kotlin.coroutines.resume

/** Owns native media only. Neither room signaling nor a subscribed track is called Connected. */
internal class NativeRoomEngine(context: Context, private val listener: Listener) : NativeRoomMedia {
    interface Listener {
        fun onTransport(state: String)
        fun onEvidence(evidence: JSONObject)
        fun onFailure(stage: NativeRoomAudioSetup.Stage, code: String, message: String)
        fun onMuteChanged(value: Boolean)
        fun onAudioRoute(route: String, isSpeaker: Boolean)
        fun onRouteUnavailable()
    }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val engineCreatedAt = SystemClock.elapsedRealtime()
    private val room = LiveKit.create(context.applicationContext)
    @Volatile private var closed = false
    private var failureReported = false
    private var setupStage = NativeRoomAudioSetup.Stage.AUTHORIZATION
    private var stageStartedAt = engineCreatedAt
    private var join = JSONObject()
    private var customerTrack: RemoteAudioTrack? = null
    private var customerTrackSid = ""
    private val decodedFrames = AtomicLong()
    private var previous: Sample? = null
    private var speaker = false
    private var muted = false
    private var mutePending = false
    private var focusLost = false
    private var startupEvidenceSent = false
    private var immediatelySilenced = false
    private val routeListener = object : AudioDeviceChangeListener {
        override fun invoke(audioDevices: List<AudioDevice>, selectedAudioDevice: AudioDevice?) {
            scope.launch {
                if (closed) return@launch
                speaker = selectedAudioDevice is AudioDevice.Speakerphone
                val label = when (selectedAudioDevice) {
                    is AudioDevice.BluetoothHeadset -> "Bluetooth"
                    is AudioDevice.WiredHeadset -> "Wired headset"
                    is AudioDevice.Speakerphone -> "Speaker"
                    is AudioDevice.Earpiece -> "Phone"
                    else -> "Audio device"
                }
                listener.onAudioRoute(label, speaker)
            }
        }
    }
    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        scope.launch {
            if (closed) return@launch
            if (change == AudioManager.AUDIOFOCUS_GAIN) {
                focusLost = false; previous = null
                room.setMicrophoneMute(false); room.setSpeakerMute(false)
                listener.onTransport("focus-gained")
            } else if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK) {
                focusLost = true; previous = null
                // Do not mix a cellular call's audio with this customer's conversation.
                room.setMicrophoneMute(true); room.setSpeakerMute(true)
                listener.onTransport("focus-lost")
            }
        }
    }
    private val sink = AudioTrackSink { _, _, _, _, frames, _ -> if (!closed) decodedFrames.addAndGet(frames.toLong()) }

    override fun connect(descriptor: JSONObject) {
        join = descriptor
        android.util.Log.i("SHCallTiming", "audio-engine-created elapsedMs=" + (SystemClock.elapsedRealtime() - engineCreatedAt))
        scope.launch {
            try {
                require(NativeRoomPolicy.validRoomUrl(join.optString("url"))) { "Invalid native audio server." }
                require(join.optString("token").length in 16..16384 && join.optString("identity").isNotEmpty()
                    && join.optString("legId").isNotEmpty() && join.optString("customerIdentity").isNotEmpty()) { "Incomplete call authorization." }
                launch {
                    room.events.collect { event ->
                        if (!closed) try { handle(event) }
                        catch (cancelled: CancellationException) { throw cancelled }
                        catch (error: Exception) { reportFailure(error) }
                    }
                }
                listener.onTransport("joining")
                room.audioSwitchHandler?.apply {
                    loggingEnabled = false
                    preferredDeviceList = listOf(AudioDevice.BluetoothHeadset::class.java, AudioDevice.WiredHeadset::class.java,
                        AudioDevice.Earpiece::class.java, AudioDevice.Speakerphone::class.java)
                    registerAudioDeviceChangeListener(routeListener)
                    registerOnAudioFocusChangeListener(focusListener)
                }
                // Subscribe only to the customer, never automatically to other operator microphones.
                stage(NativeRoomAudioSetup.Stage.ROOM_JOIN)
                if (!NativeRoomDisposal.awaitPrevious()) throw IllegalStateException("The previous audio connection is still closing.")
                if (closed) return@launch
                android.util.Log.i("SHCallTiming", "audio-previous-disposal elapsedMs=" + (SystemClock.elapsedRealtime() - stageStartedAt))
                room.connect(join.getString("url"), join.getString("token"), ConnectOptions(autoSubscribe = false))
                if (closed) return@launch
                stage(NativeRoomAudioSetup.Stage.IDENTITY)
                require(room.localParticipant.identity?.value == join.getString("identity")) { "The audio identity did not match this call." }
                stage(NativeRoomAudioSetup.Stage.MICROPHONE_PERMISSION)
                room.localParticipant.setTrackSubscriptionPermissions(false,
                    listOf(NativeRoomAudioSetup.customerPermission(join.getString("customerIdentity"))))
                // Disable DTX while proving fresh outgoing RTP even if the operator is silent.
                stage(NativeRoomAudioSetup.Stage.MICROPHONE_PUBLISH)
                room.audioTrackPublishDefaults = AudioTrackPublishDefaults(audioBitrate = 24000, dtx = false, red = true, preconnect = false)
                if (!room.localParticipant.setMicrophoneEnabled(true)) throw IllegalStateException("Microphone could not start.")
                if (closed) return@launch
                stage(NativeRoomAudioSetup.Stage.CUSTOMER_SUBSCRIPTION)
                subscribeCustomer()
                stage(NativeRoomAudioSetup.Stage.AUDIO_ACTIVE)
                launch { while (isActive && !closed) { sample(); delay(if (startupEvidenceSent) 1000 else 500) } }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { reportFailure(error) }
        }
    }

    private fun stage(next: NativeRoomAudioSetup.Stage) {
        val now = SystemClock.elapsedRealtime()
        android.util.Log.i("SHCallTiming", "audio-stage=" + setupStage.name + " elapsedMs=" + (now - stageStartedAt) + " totalMs=" + (now - engineCreatedAt))
        setupStage = next; stageStartedAt = now
    }

    private fun reportFailure(error: Exception, stage: NativeRoomAudioSetup.Stage = setupStage) {
        if (closed || failureReported) return
        failureReported = true
        // Never retain/log throwable.message, stack traces, room tokens, SDP, or customer details.
        listener.onFailure(stage, NativeRoomAudioSetup.failureCode(stage, error), NativeRoomAudioSetup.failureMessage(stage))
    }

    private fun handle(event: RoomEvent) {
        when (event) {
            is RoomEvent.Connected -> { previous = null; listener.onTransport("joining"); subscribeCustomer() }
            is RoomEvent.Reconnecting -> { previous = null; listener.onTransport("reconnecting") }
            is RoomEvent.Reconnected -> { previous = null; listener.onTransport("joining"); subscribeCustomer() }
            is RoomEvent.ParticipantConnected, is RoomEvent.TrackPublished -> subscribeCustomer()
            is RoomEvent.ParticipantDisconnected -> if (event.participant.identity?.value == join.optString("customerIdentity")) {
                clearCustomerTrack(); listener.onTransport("customer-left")
            }
            is RoomEvent.TrackSubscribed -> {
                val track = event.track
                if (event.participant.identity?.value == join.optString("customerIdentity") && track is RemoteAudioTrack) {
                    customerTrack?.removeSink(sink)
                    customerTrack = track; customerTrackSid = event.publication.sid
                    decodedFrames.set(0); previous = null; track.addSink(sink)
                } else (event.publication as? RemoteTrackPublication)?.setSubscribed(false)
            }
            is RoomEvent.TrackUnsubscribed -> if (event.track.sid == customerTrackSid) {
                clearCustomerTrack(); listener.onTransport("media-lost")
            }
            is RoomEvent.TrackUnpublished -> if (event.participant.identity?.value == join.optString("customerIdentity") && event.publication.sid == customerTrackSid) {
                clearCustomerTrack(); listener.onTransport("media-lost")
            }
            is RoomEvent.TrackMuted -> if (event.participant.identity?.value == join.optString("customerIdentity") && event.publication.sid == customerTrackSid) {
                previous = null; listener.onTransport("customer-muted")
            }
            is RoomEvent.TrackUnmuted -> if (event.participant.identity?.value == join.optString("customerIdentity") && event.publication.sid == customerTrackSid) {
                previous = null; listener.onTransport("customer-unmuted")
            }
            is RoomEvent.Disconnected -> listener.onTransport("disconnected")
            else -> Unit
        }
    }
    private fun clearCustomerTrack() {
        customerTrack?.removeSink(sink); customerTrack = null; customerTrackSid = ""; previous = null
    }

    private fun subscribeCustomer() {
        for (participant in room.remoteParticipants.values) {
            val customer = participant.identity?.value == join.optString("customerIdentity")
            for (publication in participant.trackPublications.values) {
                (publication as? RemoteTrackPublication)?.setSubscribed(customer && publication.kind == Track.Kind.AUDIO)
                if (customer && publication.track is RemoteAudioTrack && customerTrack !== publication.track) {
                    customerTrack?.removeSink(sink)
                    customerTrack = publication.track as RemoteAudioTrack; customerTrackSid = publication.sid
                    decodedFrames.set(0); previous = null; customerTrack?.addSink(sink)
                }
            }
        }
    }

    private data class Sample(val at: Long, val packetsOut: Long, val bytesOut: Long, val packetsIn: Long,
        val bytesIn: Long, val frames: Long, val localSid: String, val customerSid: String, val ice: Boolean, val dtls: Boolean)

    private suspend fun peerStats(publisher: Boolean): RTCStatsReport? = withTimeoutOrNull(1500) {
        suspendCancellableCoroutine { continuation ->
            val callback = livekit.org.webrtc.RTCStatsCollectorCallback { report -> if (continuation.isActive) continuation.resume(report) }
            if (publisher) room.getPublisherRTCStats(callback) else room.getSubscriberRTCStats(callback)
        }
    }

    private fun transport(report: RTCStatsReport?): Pair<Boolean, Boolean> {
        val stats = report?.statsMap ?: return false to false
        val transports = stats.values.filter { it.type == "transport" }
        val connected = transports.firstOrNull { it.members["dtlsState"] == "connected" } ?: return false to false
        val pair = stats[connected.members["selectedCandidatePairId"]?.toString()]
        return (pair?.type == "candidate-pair" && pair.members["state"] == "succeeded") to true
    }

    private fun count(report: RTCStatsReport?, type: String, field: String): Long = report?.statsMap?.values
        ?.filter { it.type == type && (it.members["kind"] == "audio" || it.members["mediaType"] == "audio") }
        ?.sumOf { (it.members[field] as? Number)?.toLong() ?: 0 } ?: 0

    private suspend fun sample() {
        try {
            val requestedAt = SystemClock.elapsedRealtime()
            if (room.state != Room.State.CONNECTED || focusLost) { previous = null; return }
            val remote = customerTrack ?: return
            val local = room.localParticipant.trackPublications.values.firstOrNull { it.source == Track.Source.MICROPHONE && it.track != null } ?: return
            val localTrack = local.track ?: return
            // All four observations share one deadline. Sequential waits could exceed the
            // freshness budget even when each individual stats callback was healthy.
            val reports = withTimeoutOrNull(1500) {
                coroutineScope {
                    val outgoing = async { localTrack.getRTCStats() }
                    val incoming = async { remote.getRTCStats() }
                    val publisher = async { peerStats(true) }
                    val subscriber = async { peerStats(false) }
                    listOf(outgoing.await(), incoming.await(), publisher.await(), subscriber.await())
                }
            } ?: return
            val out = reports[0] ?: return; val incoming = reports[1] ?: return
            val publisher = transport(reports[2]); val subscriber = transport(reports[3])
            if (closed || focusLost || customerTrack !== remote || room.state != Room.State.CONNECTED || SystemClock.elapsedRealtime() - requestedAt > 1500) return
            val sample = Sample(requestedAt, count(out, "outbound-rtp", "packetsSent"), count(out, "outbound-rtp", "bytesSent"),
                count(incoming, "inbound-rtp", "packetsReceived"), count(incoming, "inbound-rtp", "bytesReceived"), decodedFrames.get(),
                local.sid, customerTrackSid, publisher.first && subscriber.first, publisher.second && subscriber.second)
            val old = previous; previous = sample
            if (old == null || old.localSid != sample.localSid || old.customerSid != sample.customerSid) return
            val duration = sample.at - old.at; val age = SystemClock.elapsedRealtime() - sample.at
            val po = sample.packetsOut - old.packetsOut; val bo = sample.bytesOut - old.bytesOut
            val pi = sample.packetsIn - old.packetsIn; val bi = sample.bytesIn - old.bytesIn; val frames = sample.frames - old.frames
            if (muted && duration in 500L..5000L && age in 0L..2000L && pi > 0 && bi > 0 && frames > 0 && sample.ice && sample.dtls) {
                // Restores an already-established intentionally muted call after a network change.
                // This never submits initial/bidirectional readiness to the server.
                listener.onTransport("receiving-muted"); return
            }
            val customerPublication = room.remoteParticipants.values
                .firstOrNull { it.identity?.value == join.optString("customerIdentity") }
                ?.trackPublications?.values?.firstOrNull { it.sid == sample.customerSid && it.track === remote }
            val customerMuted = customerPublication?.muted == true
            val customerSubscribed = customerPublication?.subscribed == true
            val bidirectional = NativeRoomPolicy.mediaReady(duration, age, po, bo, pi, bi, frames, sample.ice, sample.dtls)
            val mutedTransport = customerMuted && NativeRoomPolicy.customerMutedTransportReady(duration, age,
                po, bo, pi, bi, frames, sample.ice, sample.dtls, customerMuted, customerSubscribed)
            if (!bidirectional && !mutedTransport) return
            val evidence = JSONObject().put("protocol", NativeRoomPolicy.PROTOCOL).put("legId", join.getString("legId"))
                .put("identity", join.getString("identity")).put("roomName", join.getString("roomName"))
                .put("participantSid", room.localParticipant.sid.value).put("localAudioTrackSid", sample.localSid)
                .put("customerIdentity", join.getString("customerIdentity")).put("customerAudioTrackSid", sample.customerSid)
                .put("sampleDurationMs", duration).put("sampleAgeMs", age)
                .put("outbound", JSONObject().put("packetsDelta", po).put("bytesDelta", bo))
                .put("inbound", JSONObject().put("packetsDelta", pi).put("bytesDelta", bi).put("decodedFramesDelta", frames))
                .put("iceState", "succeeded").put("dtlsState", "connected")
                .put("customerMuted", customerMuted)
            if (mutedTransport) evidence.put("readinessMode", "customer-muted-transport").put("customerTrackSubscribed", true)
            if (!startupEvidenceSent) android.util.Log.i("SHCallTiming", "audio-first-evidence elapsedMs=" + (SystemClock.elapsedRealtime() - engineCreatedAt))
            startupEvidenceSent = true
            listener.onEvidence(evidence)
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { previous = null /* No guessed readiness on a missing/unsupported stat. */ }
    }

    override fun setMuted(value: Boolean) {
        if (closed || mutePending) return
        mutePending = true; previous = null
        scope.launch {
            try {
                if (!room.localParticipant.setMicrophoneEnabled(!value)) throw IllegalStateException("Microphone update failed.")
                if (!closed) { muted = value; listener.onMuteChanged(value) }
            }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { reportFailure(error, NativeRoomAudioSetup.Stage.MICROPHONE_CONTROL) }
            finally { mutePending = false }
        }
    }

    override fun setSpeaker(value: Boolean) {
        if (closed) return
        val handler = room.audioSwitchHandler ?: run { listener.onRouteUnavailable(); return }
        try {
            // Null restores Bluetooth/wired/earpiece priority; the route callback owns the UI state.
            val device = if (value) handler.availableAudioDevices.firstOrNull { it is AudioDevice.Speakerphone } else null
            if (value && device == null) { listener.onRouteUnavailable(); return }
            handler.selectDevice(device)
        } catch (_: Exception) { listener.onRouteUnavailable() }
    }

    override fun silenceForClose(): Boolean {
        // The pinned SDK delegates these directly to the ADM's volatile mute
        // flags. Track.stop() instead waits on the RTC executor via Future.get().
        val microphone = runCatching { room.setMicrophoneMute(true) }.isSuccess
        val playout = runCatching { room.setSpeakerMute(true) }.isSuccess
        immediatelySilenced = microphone && playout
        return immediatelySilenced
    }

    override fun close() {
        if (closed) return
        closed = true
        room.audioSwitchHandler?.unregisterAudioDeviceChangeListener(routeListener)
        room.audioSwitchHandler?.unregisterOnAudioFocusChangeListener(focusListener)
        val detachedCustomerTrack = customerTrack
        customerTrack = null; customerTrackSid = ""; previous = null; decodedFrames.set(0)
        // Disable local audio immediately. SDK disconnect/disposal itself can block while
        // waiting for its transport lock and must not hold the End button/UI thread.
        val silenced = immediatelySilenced || silenceForClose()
        val tracks = room.localParticipant.trackPublications.values.mapNotNull { it.track }
        // Preserve the prior fail-closed stop path if immediate ADM muting is
        // unavailable. The ordinary successful close never waits on RTC here.
        if (!silenced) tracks.forEach { track -> runCatching { track.stop() } }
        scope.cancel()
        NativeRoomDisposal.enqueue {
            runCatching { detachedCustomerTrack?.removeSink(sink) }
            if (silenced) tracks.forEach { track -> runCatching { track.stop() } }
            room.release()
        }
    }
}
