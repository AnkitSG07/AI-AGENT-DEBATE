package com.smarthandicrafts.operatorhub;

import org.junit.Test;
import static org.junit.Assert.*;

public class NativeRoomStartGateTest {
    @Test public void aLateAcceptCapabilityResultCannotStartTheNewIntentCall() {
        NativeRoomStartGate gate = new NativeRoomStartGate(); long oldCall = gate.begin();
        gate.invalidate(); long newCall = gate.begin();
        assertFalse(gate.current(oldCall)); assertFalse(gate.takeStart(oldCall));
        assertTrue(gate.current(newCall)); assertTrue(gate.takeStart(newCall));
    }
    @Test public void oldPermissionResultCannotAuthorizeADifferentIncomingCall() {
        NativeRoomStartGate gate = new NativeRoomStartGate(); long a = gate.begin();
        assertTrue(gate.awaitPermission(a, 41));
        gate.invalidate(); long b = gate.begin();
        assertFalse(gate.awaitPermission(b, 41));
        assertEquals(NativeRoomStartGate.NONE, gate.permissionResult(41));
        assertFalse(gate.takeStart(a)); assertTrue(gate.current(b));
        assertTrue(gate.awaitPermission(b, 41));
        assertEquals(b, gate.permissionResult(41)); assertTrue(gate.takeStart(b));
    }
    @Test public void delayedStartWaitingForResumeCannotUseNewIntentFields() {
        NativeRoomStartGate gate = new NativeRoomStartGate(); long queued = gate.begin();
        gate.invalidate();
        assertFalse(gate.current(queued)); assertFalse(gate.takeStart(queued));
    }
    @Test public void permissionAndResumeCallbacksMayStartAnAttemptOnlyOnce() {
        NativeRoomStartGate gate = new NativeRoomStartGate(); long ticket = gate.begin();
        assertTrue(gate.awaitPermission(ticket, 42));
        assertEquals(ticket, gate.permissionResult(42));
        assertTrue(gate.takeStart(ticket)); assertFalse(gate.takeStart(ticket));
        assertEquals(NativeRoomStartGate.NONE, gate.permissionResult(42));
    }
    @Test public void declineOrDestructionInvalidatesPendingPermissionButDoesNotRelabelIt() {
        NativeRoomStartGate gate = new NativeRoomStartGate(); long ticket = gate.begin();
        assertTrue(gate.awaitPermission(ticket, 41)); gate.cancel(ticket);
        assertEquals(NativeRoomStartGate.NONE, gate.permissionResult(41));
        assertFalse(gate.takeStart(ticket));
    }
    @Test public void unrelatedPermissionCallbackCannotConsumeTheCallPrompt() {
        NativeRoomStartGate gate = new NativeRoomStartGate(); long ticket = gate.begin();
        assertTrue(gate.awaitPermission(ticket, 41));
        assertEquals(NativeRoomStartGate.NONE, gate.permissionResult(31));
        assertEquals(ticket, gate.permissionResult(41)); assertTrue(gate.takeStart(ticket));
    }
}
