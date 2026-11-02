package com.smarthandicrafts.operatorhub

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/** UI-thread control: capture privacy is immediate; publication changes remain acknowledged. */
internal class NativeRoomMicrophoneControl(
    private val scope: CoroutineScope,
    private val closed: () -> Boolean,
    private val captureMute: (Boolean) -> Unit,
    private val trackEnabled: suspend (Boolean) -> Boolean,
    private val changed: (Boolean) -> Unit,
    private val unavailable: () -> Unit
) {
    private var requested = false
    private var applied = false
    private var focusLost = false
    private var running = false

    fun focus(lost: Boolean) {
        focusLost = lost
        if (!closed()) try { captureMute(applied || lost) }
        catch (_: Exception) { unavailable() }
    }

    fun request(value: Boolean) {
        if (closed()) return
        requested = value
        if (value) {
            // This is the SDK ADM's actual capture gate, not an optimistic icon.
            // Muting never waits for RTC/signaling or a previous unmute request.
            try { captureMute(true) }
            catch (_: Exception) { requested = applied; unavailable(); return }
            applied = true; changed(true)
        }
        if (running) return
        running = true
        scope.launch {
            try {
                while (!closed()) {
                    val target = requested
                    try {
                        check(trackEnabled(!target)) { "Microphone control was not acknowledged" }
                        if (closed()) return@launch
                        if (target == requested) {
                            // Keep capture closed until unmute is actually acknowledged.
                            captureMute(target || focusLost)
                            applied = target; changed(target)
                            return@launch
                        }
                    } catch (cancelled: CancellationException) { throw cancelled }
                    catch (_: Exception) {
                        if (closed()) return@launch
                        if (target == requested) {
                            requested = applied
                            unavailable()
                            return@launch
                        }
                    }
                    // Coalesce intervening taps to the latest requested value.
                }
            } finally { running = false }
        }
    }
}
