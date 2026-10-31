package com.smarthandicrafts.operatorhub

import android.Manifest
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.*
import androidx.core.content.ContextCompat
import kotlinx.coroutines.*
import org.json.JSONObject
import java.util.UUID

/** A native, microphone foreground service owns the room independently of the Odoo WebView. */
class NativeRoomCallService : Service() {
    companion object {
        @Volatile private var instance: NativeRoomCallService? = null
        @JvmStatic fun snapshot(): JSONObject? = instance?.viewState()
        @JvmStatic fun isRunning(): Boolean = instance != null && instance?.closed == false
        /** True only when this exact live call was ended locally on the UI thread. */
        @JvmStatic fun endFromNotification(callId: String): Boolean {
            // An old unscoped notification must not control a newer same-call media leg.
            return false
        }
        @JvmStatic fun endFromNotification(callId: String, clientAttemptId: String, ownerLegId: String): Boolean {
            if (Looper.myLooper() != Looper.getMainLooper()) return false
            val service = instance?.takeIf { NativeRoomControl.matches(clientAttemptId, ownerLegId, it.requestId, it.legId, it.closed)
                && (it.callId == callId || it.providerCallId == callId || it.requestId == callId) } ?: return false
            service.endLocally()
            return true
        }
        @JvmStatic fun commandForAttempt(attempt: String, ownerLeg: String, action: String, value: String): Boolean {
            if (Looper.myLooper() != Looper.getMainLooper()) return false
            val service = instance?.takeIf { NativeRoomControl.matches(attempt, ownerLeg, it.requestId, it.legId, it.closed) } ?: return false
            if (!service.current()) return false
            when (action) {
                "end" -> service.endLocally()
                "mute" -> if (service.readyCommitted) service.engine?.setMuted(!service.muted)
                "speaker" -> service.engine?.setSpeaker(!service.speaker)
                "transfer" -> service.inviteTransfer(value)
                "cancel-transfer" -> if (value == service.sourceTransferId) service.cancelTransfer()
                else -> return false
            }
            return true
        }
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val guard = NativeRoomPolicy.Epoch()
    private var epoch = 0L
    @Volatile private var closed = false
    private var engine: NativeRoomMedia? = null
    private var callApi = NativeRoomCleanupProcessor.Requester { path, method, body, bearer ->
        if (method == "GET") NativeApi.controlRequest(path, method, body, bearer) else NativeApi.request(path, method, body, bearer)
    }
    private lateinit var credential: DeviceLeasePolicy.Credential
    private lateinit var store: NativeStore
    private var callId = ""
    private var providerCallId = ""
    private var transferId = ""
    private var sourceTransferId = ""
    private var transferStillCompleting = false
    private var channelId = 0
    private var displayName = "Customer"
    private var state = "preparing"
    private var detail = "Preparing secure audio"
    private var nonce = ""
    private var legId = ""
    private var version = 0L
    private val health = NativeRoomCallHealth()
    private var startedAt = 0L
    private var readyCommitted = false
    private var readyInFlight = false
    private var muted = false
    private var customerMuted = false
    private var bidirectionalAudio = false
    private var speaker = false
    private var pollStarted = false
    private var joinRecoveryInFlight = false
    private var outgoingAttempt = false
    private var lastStatusOkAt = 0L
    private var audioRoute = "Phone"
    private var proximityLock: PowerManager.WakeLock? = null
    private var transferRequestId = ""
    private var transferInFlight = false
    private var cancelTransferInFlight = false
    private var pollWake = kotlinx.coroutines.channels.Channel<Unit>(kotlinx.coroutines.channels.Channel.CONFLATED)
    private var lastEvidence: JSONObject? = null
    private var lastEvidenceAt = 0L
    private var publishedSnapshot = ""
    private var failureStage = ""
    private var failureCode = ""
    private var requestId = UUID.randomUUID().toString()
    private var alertReceiverRegistered = false
    private val credentialListener = SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
        if (key == "enrollment_generation" || key == "device_token" || key == "device_id") {
            Handler(Looper.getMainLooper()).post { if (::credential.isInitialized && !closed) current() }
        }
    }
    private val alertReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.getStringExtra("snapshot") != null || intent?.getBooleanExtra("alert_terminal", false) != true || closed) return
            val id = intent?.getStringExtra("call_id") ?: return
            if (id == callId || id == providerCallId) pollWake.trySend(Unit)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null
    override fun onCreate() {
        super.onCreate(); instance = this; store = NativeStore(this)
        store.watchCredential(credentialListener)
        ContextCompat.registerReceiver(this, alertReceiver, IntentFilter(NativeRoomNotifications.CHANGED), ContextCompat.RECEIVER_NOT_EXPORTED)
        alertReceiverRegistered = true
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent == null || epoch != 0L) return START_NOT_STICKY
        val clientAttempt = intent.getStringExtra("client_attempt_id")
        if (NativeRoomUiBinding.validAttemptId(clientAttempt)) requestId = clientAttempt!!
        callId = intent.getStringExtra("call_id") ?: ""
        transferId = intent.getStringExtra("transfer_id") ?: ""
        channelId = intent.getIntExtra("channel_id", 0)
        displayName = (intent.getStringExtra("display_name") ?: "Customer").take(160)
        if (store.roomAttemptCancelled(requestId)) { finishLocal("ended", "Call cancelled"); return START_NOT_STICKY }
        val outgoing = intent.getStringExtra("room_action") == "outgoing"
        outgoingAttempt = outgoing
        val phone = intent.getStringExtra("phone") ?: ""
        if ((outgoing && !NativeRoomPolicy.validPhone(phone)) || (!outgoing && !HubPolicy.validCallId(callId))
            || (transferId.isNotEmpty() && !NativeRoomPolicy.validTransferId(transferId))
            || checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            finishLocal("failed", "Call audio could not start. Check the call details and microphone permission."); return START_NOT_STICKY
        }
        credential = store.credential()
        if (!intent.hasExtra("enrollment_generation") || intent.getLongExtra("enrollment_generation", -1) != credential.generation
            || intent.getStringExtra("enrolled_device_id") != credential.deviceId) {
            finishLocal("failed", "Device registration changed. Reopen the call."); return START_NOT_STICKY
        }
        if (!DeviceLeasePolicy.valid(credential, System.currentTimeMillis())) { finishLocal("failed", "Register this phone before starting call audio."); return START_NOT_STICKY }
        if (ActiveCallService.isActiveForAny()) { finishLocal("unavailable", "Finish the browser call before starting another call."); return START_NOT_STICKY }
        epoch = guard.begin(); startedAt = SystemClock.elapsedRealtime(); lastStatusOkAt = startedAt
        health.start(startedAt)
        val note = NativeRoomNotifications.ongoing(this, callId.ifEmpty { requestId }, transferId, "Preparing call audio")
        try {
            if (Build.VERSION.SDK_INT >= 30) startForeground(NativeRoomNotifications.ACTIVE_ID, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
            else startForeground(NativeRoomNotifications.ACTIVE_ID, note)
        } catch (_: RuntimeException) { finishLocal("failed", "Android could not start call audio. Open SH Chat and try again."); return START_NOT_STICKY }
        emit()
        // Deadlines/credential release must run even while a status or provider request is blocked.
        scope.launch {
            while (!closed) {
                if (!current()) break
                val timeout = health.timeout(readyCommitted, SystemClock.elapsedRealtime())
                if (timeout.isNotEmpty()) { endLocally(timeout, failed = true); break }
                delay(250)
            }
        }
        scope.launch {
            try {
                // /accept and /outgoing themselves authenticate and require enabled capabilities.
                // Avoid a second network round trip after the user's Answer/Call gesture.
                if (!current()) return@launch
                val body = JSONObject().put("requestId", requestId)
                if (outgoing) body.put("to", phone)
                // The R16 server atomically binds this exact invitation/target. The
                // immutable transfer ID avoids a status round trip on every Answer.
                if (transferId.isNotEmpty()) body.put("expectedTransferId", transferId)
                val path = if (outgoing) "/calls/outgoing" else path(if (transferId.isEmpty()) "accept" else "transfers/${Uri.encode(transferId)}/accept")
                // Retry only this same idempotency key. Never redial after an ambiguous response.
                var result: JSONObject? = null
                var last: Exception? = null
                var attempt = 0
                var waitingForReservation = false
                val alertExpiry = if (outgoing) 0 else store.roomAlertExpiry(callId, transferId)
                val busyBudget = if (alertExpiry > 0) minOf(15000L, maxOf(0L, alertExpiry - System.currentTimeMillis())) else 15000L
                val busyDeadline = SystemClock.elapsedRealtime() + busyBudget
                while (current() && attempt <= 2) {
                    if (waitingForReservation && store.roomAlertClosed(callId, transferId)) {
                        finishLocal("ended", "The incoming call is no longer available."); return@launch
                    }
                    if (waitingForReservation && SystemClock.elapsedRealtime() >= busyDeadline) {
                        last = NativeApi.ApiException(409, "The previous call is still finishing. Try Answer again.", JSONObject().put("code", "DEVICE_BUSY")); break
                    }
                    try { result = request(path, "POST", body); break }
                    catch (error: Exception) {
                        last = error
                        if (current() && transferId.isNotEmpty() && !body.has("version") && error is NativeApi.ApiException && error.errorCode == "STALE_CALL_VERSION") {
                            // R13–R15 servers require a version. Only that explicit
                            // rejection may retry via their original guarded contract;
                            // keep the same invitation and idempotency key throughout.
                            val checked = request(path("status"), "GET").optJSONObject("call") ?: throw IllegalStateException("Transfer is no longer available.")
                            version = checked.optLong("version", -1)
                            if (version < 0) throw IllegalStateException("Transfer version was missing.")
                            body.put("version", version); continue
                        }
                        if (current() && !outgoing && transferId.isEmpty() && error is NativeApi.ApiException && error.errorCode == "DEVICE_BUSY") {
                            waitingForReservation = true
                            // An outgoing response may reserve the device just after the
                            // waiting-call screen observed availability. Retry this exact
                            // explicitly accepted call while durable cleanup settles.
                            if (store.roomAlertClosed(callId, transferId)) {
                                finishLocal("ended", "The incoming call is no longer available."); return@launch
                            }
                            if (SystemClock.elapsedRealtime() < busyDeadline) {
                                state = "joining"; detail = "Finishing the previous call before answering"; emit()
                                NativeRoomCleanup.drain(this@NativeRoomCallService)
                                delay(500); continue
                            }
                            last = NativeApi.ApiException(409, "The previous call is still finishing. Try Answer again.", JSONObject().put("code", "DEVICE_BUSY"))
                            break
                        }
                        if (current() && error is NativeApi.ApiException && error.sessionId.isNotEmpty()) {
                            callId = error.sessionId; beginPolling(); state = "joining"; detail = "Checking the call connection"; emit(); return@launch
                        }
                        if (current() && !outgoing && error is NativeApi.ApiException && error.errorCode in listOf("CALL_OPERATION_PENDING", "MEDIA_REQUEST_UNCERTAIN")) {
                            beginPolling(); state = "joining"; detail = "Checking the existing call connection"; emit(); return@launch
                        }
                        if (!current() || error is NativeApi.ApiException && error.status in 400..499) break
                        attempt++; delay(1200)
                    }
                }
                if (result == null) throw last ?: IllegalStateException("Call could not start.")
                // User End or local unregister wins over a delayed successful accept.
                if (!current()) { cleanupLateAccept(result); if (!closed) finishLocal("ended", "Device registration changed"); return@launch }
                if (!outgoing) { store.closeRoomAlert(callId, transferId); NativeRoomNotifications.cancel(this@NativeRoomCallService, callId, transferId) }
                if (result.optJSONObject("join") == null) {
                    val pending = result.optJSONObject("call") ?: throw IllegalStateException("Call details were missing.")
                    val id = NativeRoomJson.text(pending,"sessionId", NativeRoomJson.text(pending,"callId"))
                    require(HubPolicy.validCallId(id)) { "Invalid call identity." }
                    callId = id; applyStatus(result)
                } else consumeJoin(result)
                beginPolling()
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) {
                if (current()) { authFailure(error); if (current()) endLocally(readable(error), failed = true) }
            }
        }
        return START_NOT_STICKY
    }

    private fun current(): Boolean {
        if (closed || !guard.current(epoch) || !::credential.isInitialized) return false
        if (!NativeRoomControl.sameCredential(credential, store.credential())) {
            // Releasing local capture never terminates a different/new device's remote call.
            finishLocal("ended", "Device registration changed; local audio stopped")
            return false
        }
        return true
    }
    private fun path(suffix: String) = "/calls/${Uri.encode(callId)}/$suffix"
    private suspend fun request(path: String, method: String, body: JSONObject? = null, evidenceCapturedAt: Long = 0): JSONObject = withContext(Dispatchers.IO) {
        if (!store.matchesCredential(credential)) throw IllegalStateException("Device registration changed.")
        if (evidenceCapturedAt > 0) {
            val evidence = body?.optJSONObject("evidence") ?: throw IllegalStateException("Missing audio observations.")
            val age = evidence.optLong("sampleAgeMs") + SystemClock.elapsedRealtime() - evidenceCapturedAt
            if (age > 2000 || age < 0) throw IllegalStateException("Audio observations expired before transmission.")
            evidence.put("sampleAgeMs", age)
        }
        val result = try { callApi.request(path, method, body, credential.bearer) }
        catch (error: NativeApi.ApiException) {
            if (closed && error.sessionId.isNotEmpty()) NativeRoomCleanup.enqueue(this@NativeRoomCallService, credential, error.sessionId, transferId, legId)
            throw error
        }
        // Cancellation of the coroutine cannot discard an accept which already reached the server.
        if (closed && method == "POST" && (path.endsWith("/accept") || path.endsWith("/outgoing") || path.endsWith("/ready"))) cleanupLateAccept(result)
        result
    }

    private fun consumeJoin(result: JSONObject) {
        if (!current()) return
        val call = result.optJSONObject("call") ?: throw IllegalStateException("Call details were missing.")
        val newId = NativeRoomJson.text(call,"sessionId", NativeRoomJson.text(call,"callId"))
        require(HubPolicy.validCallId(newId)) { "Invalid call identity." }
        callId = newId; providerCallId = NativeRoomJson.text(call,"providerCallId")
        if (call.optString("customerName").isNotEmpty()) displayName = call.optString("customerName").take(160)
        else if (displayName == "Customer" && call.optString("customerPhone").isNotEmpty()) displayName = "+" + call.optString("customerPhone").take(32)
        version = maxOf(version, call.optLong("version", 0)); guard.acceptVersion(epoch, version)
        nonce = result.optString("readinessNonce", call.optString("readinessNonce"))
        val join = result.optJSONObject("join") ?: throw IllegalStateException("Call audio authorization was missing.")
        legId = join.optString("legId", result.optString("legId"))
        join.put("legId", legId)
        require(nonce.isNotEmpty() && legId.isNotEmpty()) { "Call audio authorization was incomplete." }
        state = if (transferId.isEmpty()) "joining" else "transferring"; detail = if (transferId.isEmpty()) "Connecting audio" else "Joining the customer; the other phone stays connected"
        engine = NativeRoomEngine(this, object : NativeRoomEngine.Listener {
            override fun onTransport(transport: String) {
                if (!current()) return
                if (transport == "disconnected") {
                    // SDK Disconnected is final; Reconnecting has its own recoverable event.
                    // Transfer detach returns to chat now. Cleanup rechecks ownership and cannot end B's call.
                    endLocally("Call audio ended"); return
                } else if (transport == "receiving-muted" && readyCommitted && muted) {
                    health.evidence(); markConnected(); return
                } else if (transport == "customer-muted" || transport == "customer-unmuted") {
                    customerMuteChanged(transport == "customer-muted"); return
                } else if (transport == "focus-lost") {
                    health.focus(false, SystemClock.elapsedRealtime()); state = "paused"; detail = "Audio paused by another phone call"
                } else if (transport == "focus-gained") {
                    health.focus(true, SystemClock.elapsedRealtime()); state = "reconnecting"; detail = "Resuming call audio"
                } else if (transport == "reconnecting" || transport == "customer-left" || transport == "media-lost") {
                    health.mediaLost(SystemClock.elapsedRealtime()); lastEvidence = null; lastEvidenceAt = 0
                    state = if (readyCommitted) "reconnecting" else "joining"; detail = "Reconnecting audio"
                    pollWake.trySend(Unit)
                } else if (!health.fresh()) {
                    state = if (transferId.isEmpty()) "joining" else "transferring"; detail = "Connecting audio"
                }
                emit()
            }
            override fun onEvidence(evidence: JSONObject) {
                recordMediaEvidence(evidence)
            }
            override fun onMuteChanged(value: Boolean) { if (current()) { muted = value; emit() } }
            override fun onAudioRoute(route: String, isSpeaker: Boolean) { if (current()) { audioRoute = route; speaker = isSpeaker; emit() } }
            override fun onRouteUnavailable() { if (current()) { detail = "Audio route could not change; the call stays active"; emit() } }
            override fun onFailure(stage: NativeRoomAudioSetup.Stage, code: String, message: String) {
                if (!current()) return
                failureStage = stage.name; failureCode = code
                store.audioFailureIfMatches(credential, stage.name, code, System.currentTimeMillis())
                endLocally(message, failed = true)
            }
        })
        engine?.connect(join); emit()
    }

    private fun customerMuteChanged(value: Boolean) {
        if (!current()) return
        val changed = customerMuted != value
        customerMuted = value
        if (changed) {
            bidirectionalAudio = false; lastEvidence = null; lastEvidenceAt = 0
            if (!value) {
                // Unmuting is not proof that customer audio has resumed. Require a
                // new real decoded-audio sample before clearing this transition.
                health.mediaLost(SystemClock.elapsedRealtime())
                state = if (readyCommitted) "reconnecting" else "joining"
                detail = "Connecting customer audio"
            }
        }
        if (value && readyCommitted && health.fresh()) markConnected()
        else {
            if (value && transferId.isNotEmpty()) detail = "Waiting for the customer's microphone; the first phone stays connected"
            emit()
        }
    }

    private fun recordMediaEvidence(evidence: JSONObject) {
        if (!current()) return
        customerMuted = evidence.optBoolean("customerMuted")
        bidirectionalAudio = evidence.optString("readinessMode") != "customer-muted-transport"
        lastEvidence = evidence; lastEvidenceAt = SystemClock.elapsedRealtime(); health.evidence()
        if (!readyCommitted && transferId.isNotEmpty() && !bidirectionalAudio) {
            // Muted-only transport may start an ordinary call, but cannot prove
            // that a transfer destination hears the customer. Keep the source.
            detail = "Waiting for the customer's microphone; the first phone stays connected"
            emit(); return
        }
        if (readyCommitted) markConnected() else sendReadiness(evidence)
    }

    private fun sendReadiness(evidence: JSONObject) {
        if (!current() || readyInFlight || nonce.isEmpty()) return
        readyInFlight = true
        val capturedEpoch = epoch
        val evidenceAt = SystemClock.elapsedRealtime()
        scope.launch {
            try {
                val body = JSONObject().put("version", version).put("readinessNonce", nonce).put("evidence", evidence)
                val suffix = if (transferId.isEmpty()) "ready" else "transfers/${Uri.encode(transferId)}/ready"
                val result = request(path(suffix), "POST", body, evidenceAt)
                if (!guard.current(capturedEpoch) || !current()) return@launch
                applyStatus(result)
                if (!current()) return@launch
                val call = result.optJSONObject("call") ?: return@launch
                if (call.optString("ownerDeviceId") == credential.deviceId && call.optBoolean("roomReady")) {
                    readyCommitted = true
                    // After ownership commits, target End is an ordinary customer call End.
                    transferId = ""
                    if (health.fresh() && SystemClock.elapsedRealtime() - evidenceAt <= 5000) markConnected()
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) {
                if (current()) {
                    authFailure(error)
                    if (error is NativeApi.ApiException && error.status == 401) endLocally("Device authorization expired.")
                    // A 409 or transient provider readiness response is reconciled by the next status poll.
                }
            } finally { readyInFlight = false }
        }
    }

    private fun beginPolling() {
        if (pollStarted || !HubPolicy.validCallId(callId)) return
        pollStarted = true
        scope.launch {
            while (!closed) {
                if (!current()) { finishLocal("ended", "Device registration changed; local audio stopped"); break }
                try {
                    val result = request(path("status"), "GET")
                    if (!current()) break
                    lastStatusOkAt = SystemClock.elapsedRealtime(); applyStatus(result)
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (error: Exception) {
                    if (!current()) break
                    authFailure(error)
                    if (error is NativeApi.ApiException && error.status == 401) { endLocally("Device authorization expired."); break }
                    if (error is NativeApi.ApiException && error.status == 404) { finishLocal("ended", "Call ended"); break }
                    // A short control outage must not destroy a healthy, independent media leg.
                    if (SystemClock.elapsedRealtime() - lastStatusOkAt > 30000) {
                        detail = if (readyCommitted && health.fresh()) "Audio active; call controls are reconnecting" else "Checking the call connection"
                        emit()
                    }
                }
                withTimeoutOrNull(1000) { pollWake.receive() }
            }
        }
    }

    private fun applyStatus(result: JSONObject) {
        val call = result.optJSONObject("call") ?: return
        val incomingVersion = call.optLong("version", -1)
        if (!guard.acceptVersion(epoch, incomingVersion)) return
        version = incomingVersion
        providerCallId = NativeRoomJson.text(call,"providerCallId", providerCallId)
        if (channelId == 0) channelId = call.optInt("channelId", 0)
        val phase = call.optString("phase")
        if (HubPolicy.terminal(phase) || phase == "ending") { finishLocal("ended", "Call ended"); return }
        val owner = NativeRoomJson.text(call,"ownerDeviceId")
        val ownerLeg = NativeRoomJson.text(call,"ownerLegId")
        if (legId.isNotEmpty() && owner == credential.deviceId && ownerLeg.isNotEmpty() && ownerLeg != legId) {
            finishLocal("transferred", "This call is now on a different audio connection"); return
        }
        if (engine == null && owner == credential.deviceId && phase in listOf("joining", "ringing", "connecting", "accepted", "connected", "uncertain", "accepting")) recoverJoin()
        val transfer = call.optJSONObject("transfer")
        transferStillCompleting = transfer?.optString("status") == "completing"
        if (transferId.isEmpty() && owner.isNotEmpty() && owner != credential.deviceId) {
            finishLocal("transferred", "Call transferred to the other phone"); return
        }
        if (transferId.isNotEmpty()) {
            if (owner == credential.deviceId && call.optBoolean("roomReady")) {
                readyCommitted = true; transferId = ""
                if (health.fresh()) markConnected()
            } else if (transfer != null && transfer.optString("transferId", transfer.optString("id")) == transferId
                && transfer.optString("status", transfer.optString("state", transfer.optString("phase"))) in listOf("declined", "cancelled", "expired", "failed")) {
                finishLocal("ended", "Transfer ended; the first phone keeps the customer"); return
            }
        }
        sourceTransferId = if (transfer != null && transfer.optString("fromDeviceId") == credential.deviceId && transfer.optString("status", transfer.optString("state", transfer.optString("phase"))) !in listOf("completed", "committed", "declined", "cancelled", "expired", "failed"))
            transfer.optString("transferId", transfer.optString("id")) else ""
        if (!readyCommitted && call.optBoolean("roomReady") && owner == credential.deviceId && engine != null && health.fresh()) {
            readyCommitted = true; markConnected()
        }
        if (!readyCommitted && phase == "ringing") { state = "ringing"; detail = "Ringing" }
        if (!readyCommitted && phase in listOf("joining", "connecting", "accepted")) { state = "joining"; detail = "Connecting audio" }
        if (!readyCommitted && phase == "dialing") { state = "calling"; detail = "Calling" }
        if (!readyCommitted && phase == "uncertain") { state = "joining"; detail = "Checking the existing call connection" }
        if (sourceTransferId.isNotEmpty() && readyCommitted) detail = "Waiting for the other phone; your audio stays connected"
        if (!readyCommitted && transferId.isNotEmpty() && customerMuted)
            detail = "Waiting for the customer's microphone; the first phone stays connected"
        emit()
    }

    private fun recoverJoin() {
        if (!current() || joinRecoveryInFlight) return
        joinRecoveryInFlight = true
        scope.launch {
            try {
                val suffix = if (transferId.isEmpty()) "accept" else "transfers/${Uri.encode(transferId)}/accept"
                val result = request(path(suffix), "POST", JSONObject().put("requestId", requestId).put("version", version))
                if (current() && engine == null) {
                    if (result.optJSONObject("join") == null) applyStatus(result) else consumeJoin(result)
                }
            } catch (error: Exception) { if (current()) authFailure(error) }
            finally { joinRecoveryInFlight = false }
        }
    }

    private fun markConnected() {
        val firstConnection = health.connectedAt() == 0L
        if (!current() || !health.connected(readyCommitted, SystemClock.elapsedRealtime())) return
        if (firstConnection) store.clearAudioFailureIfMatches(credential)
        state = "connected"
        detail = when {
            transferInFlight -> "Inviting the other phone"
            sourceTransferId.isNotEmpty() -> "Transferring; your audio stays connected"
            customerMuted -> "Customer microphone muted"
            else -> "Connected"
        }
        emit()
    }

    private fun inviteTransfer(deviceId: String) {
        if (!current() || !readyCommitted || !health.fresh() || !store.nativeRoomTransfers() || transferInFlight || sourceTransferId.isNotEmpty() || !deviceId.matches(Regex("android_[A-Za-z0-9_-]{16,100}")) || deviceId == credential.deviceId) return
        transferInFlight = true; transferRequestId = UUID.randomUUID().toString()
        detail = "Inviting the other phone"; emit()
        val body = JSONObject().put("toDeviceId", deviceId).put("version", version).put("requestId", transferRequestId)
        scope.launch {
            try { val result = requestIdempotent(path("transfers"), body); if (current()) applyStatus(result) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { if (current()) { detail = "Checking the transfer invitation. Your audio stays connected."; emit(); authFailure(error); pollWake.trySend(Unit) } }
            finally { transferInFlight = false; if (current()) emit() }
        }
    }

    private fun cancelTransfer() {
        if (!current() || sourceTransferId.isEmpty() || cancelTransferInFlight) return
        cancelTransferInFlight = true
        val selected = sourceTransferId
        val body = JSONObject().put("version", version).put("requestId", UUID.randomUUID().toString())
        scope.launch {
            try { val result = requestIdempotent(path("transfers/${Uri.encode(selected)}/cancel"), body); if (current()) applyStatus(result) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { if (current()) { detail = "Checking transfer status"; emit(); authFailure(error) } }
            finally { cancelTransferInFlight = false; if (current()) { pollWake.trySend(Unit); emit() } }
        }
    }
    private suspend fun requestIdempotent(endpoint: String, body: JSONObject): JSONObject {
        var last: Exception? = null
        repeat(2) { attempt ->
            try { return request(endpoint, "POST", body) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) {
                last = error
                if (!current() || error is NativeApi.ApiException && error.status in 400..499 || attempt == 1) throw error
                // The exact same invitation/cancel key is replayed, never a second invitation.
                delay(400)
            }
        }
        throw last ?: IllegalStateException("Call operation did not complete.")
    }

    private fun endLocally(message: String = "Call ended", failed: Boolean = false) {
        if (closed) return
        val id = callId; val transfer = transferId; val ownedLeg = legId
        finishLocal(if (failed) "failed" else "ended", message)
        if (!HubPolicy.validCallId(id)) {
            if (outgoingAttempt) NativeRoomCleanup.enqueueOutgoingCancellation(this, credential, requestId)
            return
        }
        NativeRoomCleanup.enqueue(this, credential, id, transfer, ownedLeg)
    }

    private fun cleanupLateAccept(result: JSONObject) {
        val call = result.optJSONObject("call") ?: return
        val id = NativeRoomJson.text(call,"sessionId", NativeRoomJson.text(call,"callId"))
        if (!HubPolicy.validCallId(id)) return
        // An arbitrarily late status/ready response may describe a later transfer-back owner.
        // Only this local leg, or the explicit original join descriptor, can bind cleanup.
        val lateLeg = legId.ifEmpty { result.optJSONObject("join")?.optString("legId") ?: "" }
        NativeRoomCleanup.enqueue(this, credential, id, transferId, lateLeg)
    }

    private fun authFailure(error: Exception) {
        if (error is NativeApi.ApiException && error.status == 401) store.clearEnrollmentIfMatches(credential, error.message)
    }
    private fun readable(error: Exception) = if (error is NativeApi.ApiException) error.message ?: "Call could not connect." else "Call could not connect. Please check your connection and try again."

    private fun viewState(): JSONObject = JSONObject().put("callId", callId).put("providerCallId", providerCallId).put("transferId", transferId)
        .put("clientAttemptId", requestId).put("outgoingRequestId", if (outgoingAttempt) requestId else "")
        .put("ownerLegId", legId)
        .put("sourceTransferId", sourceTransferId).put("channelId", channelId).put("displayName", displayName).put("state", state)
        .put("detail", detail).put("connectedAtElapsed", health.connectedAt()).put("muted", muted).put("speaker", speaker).put("audioRoute", audioRoute)
        .put("customerMuted", customerMuted).put("bidirectionalAudio", bidirectionalAudio && !muted && !customerMuted && health.fresh())
        .put("transportReady", readyCommitted && health.fresh() && !closed)
        .put("failureStage", failureStage).put("failureCode", failureCode)
        .put("transferPending", transferInFlight).put("cancelTransferPending", cancelTransferInFlight)
        .put("canTransfer", readyCommitted && health.fresh() && !closed && !transferInFlight && !transferStillCompleting && sourceTransferId.isEmpty() && store.nativeRoomTransfers()).put("closed", closed)

    private fun emit() {
        updateProximity()
        val snapshot = viewState()
        val serialized = snapshot.toString()
        if (serialized == publishedSnapshot) return
        publishedSnapshot = serialized
        sendBroadcast(Intent(NativeRoomNotifications.CHANGED).setPackage(packageName).putExtra("snapshot", serialized))
        if (!closed) getSystemService(android.app.NotificationManager::class.java).notify(NativeRoomNotifications.ACTIVE_ID,
            NativeRoomNotifications.ongoing(this, callId.ifEmpty { requestId }, transferId, detail))
    }
    private fun updateProximity() {
        val needed = readyCommitted && !closed && audioRoute == "Phone"
        try {
            val power = getSystemService(PowerManager::class.java)
            if (needed && proximityLock == null && power.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK))
                proximityLock = power.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "SHChat:call-proximity").apply { setReferenceCounted(false) }
            val lock = proximityLock ?: return
            if (needed && !lock.isHeld) lock.acquire()
            else if (!needed && lock.isHeld) lock.release()
        } catch (_: RuntimeException) { /* Devices without the sensor retain the ordinary touch UI. */ }
    }
    private fun finishLocal(next: String, text: String) {
        if (closed) return
        closed = true; guard.close(); state = next; detail = text
        store.cancelRoomAttempt(requestId)
        engine?.close(); engine = null
        if (HubPolicy.validCallId(callId)) { store.closeRoomAlert(callId, transferId); NativeRoomNotifications.cancel(this, callId, transferId) }
        emit(); stopForeground(STOP_FOREGROUND_REMOVE); stopSelf()
    }
    override fun onDestroy() {
        // Never terminate the customer merely because Android recreated/destroyed the UI or service.
        closed = true; guard.close(); engine?.close(); engine = null
        updateProximity()
        store.unwatchCredential(credentialListener)
        if (alertReceiverRegistered) { unregisterReceiver(alertReceiver); alertReceiverRegistered = false }
        scope.cancel(); if (instance === this) instance = null
        stopForeground(STOP_FOREGROUND_REMOVE); super.onDestroy()
    }
}
