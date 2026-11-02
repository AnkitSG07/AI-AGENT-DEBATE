package com.smarthandicrafts.operatorhub

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

class NativeRoomDisposalTest {
    @Test fun mutedCloseLetsSdkReleaseOwnTrackStoppingWithoutASecondRtcWait() = runBlocking {
        val stops = AtomicInteger(); val releases = AtomicInteger()
        NativeRoomDisposal.releaseRoom(true,
            stopTracks = { stops.incrementAndGet() },
            release = {
                // Pinned Room.release -> LocalParticipant.cleanup stops its tracks.
                stops.incrementAndGet(); releases.incrementAndGet()
            })
        assertTrue(NativeRoomDisposal.awaitPrevious())
        assertEquals("A safely muted close must not stop each track twice", 1, stops.get())
        assertEquals(1, releases.get())
    }

    @Test fun failedImmediateMuteStopsTracksBeforeReturningAndStillReleasesInOrder() = runBlocking {
        val stopped = AtomicBoolean(); val entered = CountDownLatch(1); val allowRelease = CountDownLatch(1)
        NativeRoomDisposal.releaseRoom(false,
            stopTracks = { stopped.set(true) },
            release = { assertTrue(stopped.get()); entered.countDown(); assertTrue(allowRelease.await(3, TimeUnit.SECONDS)) })
        assertTrue("Mute failure must stop capture synchronously", stopped.get())
        assertTrue(entered.await(2, TimeUnit.SECONDS))
        val nextRoomReleased = AtomicBoolean(false)
        NativeRoomDisposal.enqueue { nextRoomReleased.set(true) }
        assertFalse(nextRoomReleased.get())
        allowRelease.countDown()
        assertTrue(NativeRoomDisposal.awaitPrevious()); assertTrue(nextRoomReleased.get())
    }

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
