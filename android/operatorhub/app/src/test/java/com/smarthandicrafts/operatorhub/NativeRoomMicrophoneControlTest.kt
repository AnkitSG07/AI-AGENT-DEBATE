package com.smarthandicrafts.operatorhub

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.*
import org.junit.Test

class NativeRoomMicrophoneControlTest {
    private class Port(scope: CoroutineScope) {
        var closed = false
        var failures = 0
        val capture = mutableListOf<Boolean>()
        val track = mutableListOf<Boolean>()
        val states = mutableListOf<Boolean>()
        var gate: (Boolean) -> Unit = { capture.add(it) }
        var update: suspend (Boolean) -> Boolean = { true }
        val control = NativeRoomMicrophoneControl(scope, { closed }, { gate(it) },
            { track.add(it); update(it) }, { states.add(it) }, { failures++ })
    }

    @Test fun mutingClosesRealCaptureBeforeTheTrackOperationReturns() = runBlocking {
        val port = Port(this); val release = CompletableDeferred<Boolean>()
        port.update = { release.await() }
        port.control.request(true)
        assertEquals(listOf(true), port.capture)
        assertEquals(listOf(true), port.states)
        yield(); assertEquals(listOf(false), port.track)
        release.complete(true); yield()
        assertTrue(port.capture.last()); assertEquals(0, port.failures)
    }

    @Test fun failedUnmuteKeepsCaptureMutedAndTheCallCanRetry() = runBlocking {
        val port = Port(this)
        port.control.request(true); yield()
        port.update = { throw IllegalStateException("synthetic RTC failure") }
        port.control.request(false); yield()
        assertTrue(port.capture.last()); assertTrue(port.states.last())
        assertEquals(1, port.failures)
        port.update = { true }; port.control.request(false); yield()
        assertFalse(port.capture.last()); assertFalse(port.states.last())
    }

    @Test fun captureGateFailureDoesNotPretendTheMicrophoneWasMuted() = runBlocking {
        val port = Port(this)
        port.gate = { throw IllegalStateException("synthetic capture failure") }
        port.control.request(true); yield()
        assertEquals(1, port.failures); assertTrue(port.states.isEmpty()); assertTrue(port.track.isEmpty())
    }

    @Test fun failedPublicationMuteLeavesTheActualCaptureGateClosed() = runBlocking {
        val port = Port(this); port.update = { false }
        port.control.request(true); yield()
        assertTrue(port.capture.last()); assertTrue(port.states.last()); assertEquals(1, port.failures)
    }

    @Test fun laterMuteCannotBeUndoneByAnEarlierBlockedUnmute() = runBlocking {
        val port = Port(this); val unmute = CompletableDeferred<Boolean>()
        port.control.request(true); yield()
        port.update = { enabled -> if (enabled) unmute.await() else true }
        port.control.request(false); yield()
        val beforeLateMute = port.capture.size
        port.control.request(true)
        assertTrue(port.capture.last())
        unmute.complete(true); yield()
        assertEquals(listOf(false, true, false), port.track)
        assertTrue(port.capture.drop(beforeLateMute).all { it })
        assertTrue(port.states.last())
    }

    @Test fun focusReturnPreservesUserMuteAndDoesNotBypassAnUnmuteInFlight() = runBlocking {
        val port = Port(this); val unmute = CompletableDeferred<Boolean>()
        port.control.request(true); yield()
        port.control.focus(true); port.control.focus(false)
        assertTrue(port.capture.takeLast(2).all { it })
        port.update = { unmute.await() }
        port.control.request(false); yield()
        port.control.focus(true); port.control.focus(false)
        assertTrue(port.capture.last())
        unmute.complete(true); yield()
        assertFalse(port.capture.last())
    }

    @Test fun closeIgnoresLateUnmuteAndFurtherControlCommands() = runBlocking {
        val port = Port(this); val unmute = CompletableDeferred<Boolean>()
        port.control.request(true); yield()
        port.update = { unmute.await() }
        port.control.request(false); yield()
        port.closed = true; val count = port.capture.size
        unmute.complete(true); yield()
        port.control.request(false); port.control.focus(false)
        assertEquals(count, port.capture.size); assertTrue(port.states.last())
    }
}
