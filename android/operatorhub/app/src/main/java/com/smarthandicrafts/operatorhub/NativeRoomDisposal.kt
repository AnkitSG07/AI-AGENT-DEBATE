package com.smarthandicrafts.operatorhub

import kotlinx.coroutines.*

/** The SDK's disconnect uses runBlocking internally; keep it off Android's UI thread. */
internal object NativeRoomDisposal {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val lock = Any()
    private var tail: Deferred<Unit>? = null
    fun enqueue(dispose: () -> Unit) {
        synchronized(lock) {
            val previous = tail
            tail = scope.async {
                previous?.join()
                runCatching { dispose() }
                Unit
            }
        }
    }
    /** Room.release owns track stop/unpublish/disposal in the pinned SDK. An
     * unsilenced track still needs the synchronous fail-closed stop first. */
    fun releaseRoom(silenced: Boolean, stopTracks: () -> Unit, release: () -> Unit) {
        if (!silenced) stopTracks()
        // A successfully muted close must not wait on a redundant RTC-executor
        // stop before SDK release performs the same stop/unpublish/disposal.
        enqueue(release)
    }
    suspend fun awaitPrevious(): Boolean {
        val pending = synchronized(lock) { tail } ?: return true
        return withTimeoutOrNull(5000) { pending.join(); true } == true
    }
}
