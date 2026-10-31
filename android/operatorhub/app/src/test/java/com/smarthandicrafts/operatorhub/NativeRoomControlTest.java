package com.smarthandicrafts.operatorhub;

import org.junit.Test;
import static org.junit.Assert.*;

public class NativeRoomControlTest {
    private static final String A = "de3cc9b1-d0f7-4c06-a677-2c99cf8ef319", B = "23f5e680-949b-45a7-93c5-24f2e85a8375";
    @Test public void oldScreenCannotControlAnotherCallOrTransferredBackLeg() {
        assertFalse(NativeRoomControl.matches(A, "old-leg", B, "new-leg", false));
        assertFalse(NativeRoomControl.matches(A, "old-leg", A, "new-leg", false));
    }
    @Test public void earlyEndMayAcquireItsOwnLegWithoutChangingAttempt() {
        assertTrue(NativeRoomControl.matches(A, "", A, "leg-after-accept", false));
        assertTrue(NativeRoomControl.matches(A, "leg", A, "leg", false));
    }
    @Test public void missingAttemptOrClosedCallCannotBeUpgradedFromCurrentState() {
        assertFalse(NativeRoomControl.matches("", "leg", A, "leg", false));
        assertFalse(NativeRoomControl.matches(null, "", A, "", false));
        assertFalse(NativeRoomControl.matches(A, "leg", A, "leg", true));
    }
    @Test public void realTerminalDuringPermissionClosesPendingAnswerOnly() {
        assertTrue(NativeRoomControl.mayDismissPendingAnswer(true, true, false));
        assertFalse(NativeRoomControl.mayDismissPendingAnswer(true, false, false)); // visual silence is not terminal
        assertFalse(NativeRoomControl.mayDismissPendingAnswer(false, true, false));
        assertFalse(NativeRoomControl.mayDismissPendingAnswer(true, true, true)); // never tears down established audio
    }
}
