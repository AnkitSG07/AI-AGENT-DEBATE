package com.smarthandicrafts.operatorhub

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class NativeRoomDisposalTest {
    @Test fun sdkDisposeDoesNotBlockCallerAndNewRoomWaitsForOldDisposal() = runBlocking {
        val entered = CountDownLatch(1); val release = CountDownLatch(1); val second = AtomicBoolean(false)
        NativeRoomDisposal.enqueue { entered.countDown(); assertTrue(release.await(3, TimeUnit.SECONDS)) }
        assertTrue(entered.await(2,TimeUnit.SECONDS))
        NativeRoomDisposal.enqueue { second.set(true) }
        assertFalse(second.get())
        release.countDown()
        assertTrue(NativeRoomDisposal.awaitPrevious()); assertTrue(second.get())
    }
}
