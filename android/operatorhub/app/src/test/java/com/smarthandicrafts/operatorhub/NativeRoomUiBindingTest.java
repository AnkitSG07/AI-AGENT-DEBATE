package com.smarthandicrafts.operatorhub;

import org.junit.Test;
import static org.junit.Assert.*;

public class NativeRoomUiBindingTest {
    private static final String ATTEMPT = "e6c1391a-ddbf-4074-8d42-88ef0b092786";
    private static final String OTHER = "b62fe2aa-3f5e-4f0f-ae7e-82d26ba0305e";

    @Test public void outgoingScreenKeepsItsAttemptFromPreparingThroughCanonicalCallAndEnd() {
        // The first service broadcast has no server ID. A later /outgoing result assigns it.
        assertTrue(match(ATTEMPT, "", "", ATTEMPT, "", "", ""));
        assertTrue(match(ATTEMPT, "", "", ATTEMPT, "out_123", "wa_456", ""));
        // Rendering the canonical ID must not lose the attempt binding for a terminal broadcast.
        assertTrue(match(ATTEMPT, "out_123", "", ATTEMPT, "out_123", "wa_456", ""));
    }

    @Test public void anotherAttemptCannotBeAdoptedBeforeOrAfterServerResponse() {
        assertFalse(match(ATTEMPT, "", "", OTHER, "", "", ""));
        assertFalse(match(ATTEMPT, "", "", OTHER, "out_other", "wa_other", ""));
        assertFalse(match(ATTEMPT, "out_123", "", OTHER, "out_123", "wa_456", ""));
    }

    @Test public void lateClosedSnapshotFromPreviousAttemptCannotCloseNextCallScreen() {
        assertFalse(match(OTHER, "", "", ATTEMPT, "out_123", "wa_456", ""));
        assertTrue(match(OTHER, "", "", OTHER, "out_789", "wa_987", ""));
    }

    @Test public void emptyCallIdsAreNeverAnIdentityWithoutTheExactAttempt() {
        assertFalse(match("", "", "", "", "", "", ""));
        assertFalse(match("", "", "", ATTEMPT, "out_123", "", ""));
        assertFalse(match(null, null, null, null, null, null, null));
        assertFalse(match("bad", "out_123", "", "bad", "out_123", "wa_456", ""));
    }

    @Test public void incomingScreenCanBindUsingExactProviderOrCanonicalCallId() {
        assertTrue(match("", "wa_456", "", ATTEMPT, "out_123", "wa_456", ""));
        assertTrue(match("", "out_123", "", ATTEMPT, "out_123", "wa_456", ""));
        assertFalse(match("", "wa_other", "", ATTEMPT, "out_123", "wa_456", ""));
    }

    @Test public void transferInvitationMustMatchBeforeServiceAttemptIsKnown() {
        assertTrue(match("", "wa_456", "transfer_1", ATTEMPT, "out_123", "wa_456", "transfer_1"));
        assertFalse(match("", "wa_456", "transfer_1", ATTEMPT, "out_123", "wa_456", "transfer_2"));
        // Once explicitly bound to the service attempt, its successful transfer may clear transferId.
        assertTrue(match(ATTEMPT, "out_123", "transfer_1", ATTEMPT, "out_123", "wa_456", ""));
    }

    @Test public void trustedCurrentServiceSnapshotMayRebindReopenedActivity() {
        // Activity render(snapshot()) explicitly adopts this attempt; broadcasts alone cannot.
        String reopenedAttempt = ATTEMPT;
        assertTrue(match(reopenedAttempt, "out_123", "", ATTEMPT, "out_123", "wa_456", ""));
        assertFalse(match(reopenedAttempt, "out_123", "", OTHER, "out_other", "wa_other", ""));
    }

    @Test public void tappingPreparingNotificationRebindsOnlyItsExactOutgoingAttempt() {
        assertTrue(match("", ATTEMPT, "", ATTEMPT, "", "", ""));
        assertTrue(match("", ATTEMPT, "", ATTEMPT, "out_123", "wa_456", ""));
        assertFalse(match("", ATTEMPT, "", OTHER, "", "", ""));
        assertFalse(match("", ATTEMPT, "", OTHER, "out_other", "wa_other", ""));
    }

    @Test public void attemptIdsMustBeFullCanonicalUuidValues() {
        assertTrue(NativeRoomUiBinding.validAttemptId(ATTEMPT));
        assertFalse(NativeRoomUiBinding.validAttemptId(null));
        assertFalse(NativeRoomUiBinding.validAttemptId(""));
        assertFalse(NativeRoomUiBinding.validAttemptId("1-1-1-1-1"));
        assertFalse(NativeRoomUiBinding.validAttemptId(ATTEMPT + "x"));
    }

    private boolean match(String expectedAttempt, String expectedCall, String expectedTransfer,
                          String actualAttempt, String actualCall, String actualProvider, String actualTransfer) {
        return NativeRoomUiBinding.matches(expectedAttempt, expectedCall, expectedTransfer,
                actualAttempt, actualCall, actualProvider, actualTransfer);
    }
}
