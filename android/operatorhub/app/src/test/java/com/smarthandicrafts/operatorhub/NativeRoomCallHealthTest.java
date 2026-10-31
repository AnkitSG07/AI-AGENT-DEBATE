package com.smarthandicrafts.operatorhub;

import org.junit.Test;
import static org.junit.Assert.*;

public class NativeRoomCallHealthTest {
    @Test public void signalingAndMediaEachRequireTheOtherBeforeConnected() {
        NativeRoomCallHealth call = new NativeRoomCallHealth(); call.start(1000);
        assertFalse(call.connected(true, 2000));
        call.evidence(); assertFalse(call.connected(false, 2000));
        assertTrue(call.connected(true, 3000)); assertEquals(3000, call.connectedAt());
    }
    @Test public void trackLossImmediatelyInvalidatesOldReadiness() {
        NativeRoomCallHealth call = new NativeRoomCallHealth(); call.start(1000); call.evidence(); call.connected(true, 2000);
        call.mediaLost(5000); assertFalse(call.fresh()); assertFalse(call.connected(true, 5100));
        assertEquals("", call.timeout(true, 34999)); assertFalse(call.timeout(true, 35000).isEmpty());
        call.evidence(); assertTrue(call.connected(true, 36000)); assertEquals(2000, call.connectedAt());
    }
    @Test public void silenceIsNotAReconnectFailure() {
        NativeRoomCallHealth call = new NativeRoomCallHealth(); call.start(1000); call.evidence(); call.connected(true, 2000);
        assertEquals("", call.timeout(true, 3600000)); assertTrue(call.fresh());
    }
    @Test public void joinDeadlineRunsWithoutAnyStatusResponse() {
        NativeRoomCallHealth call = new NativeRoomCallHealth(); call.start(1000);
        assertEquals("", call.timeout(false, 90999)); assertFalse(call.timeout(false, 91000).isEmpty());
    }
    @Test public void systemAudioInterruptionRequiresFreshRecoveryButPreservesTheTimer() {
        NativeRoomCallHealth call = new NativeRoomCallHealth(); call.start(1000); call.evidence(); call.connected(true, 2000);
        call.focus(false, 3000); assertFalse(call.connected(true, 4000)); assertEquals("", call.timeout(true, 90000));
        call.focus(true, 90000); assertFalse(call.connected(true, 91000)); call.evidence();
        assertTrue(call.connected(true, 92000)); assertEquals(2000, call.connectedAt());
    }
}
