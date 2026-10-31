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
    suspend fun awaitPrevious(): Boolean {
        val pending = synchronized(lock) { tail } ?: return true
        return withTimeoutOrNull(5000) { pending.join(); true } == true
    }
}
