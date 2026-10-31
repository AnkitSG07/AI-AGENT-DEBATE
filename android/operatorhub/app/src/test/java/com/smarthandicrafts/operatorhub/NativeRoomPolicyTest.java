package com.smarthandicrafts.operatorhub;

import org.junit.Test;
import static org.junit.Assert.*;

public class NativeRoomPolicyTest {
    @Test public void explicitlyMutedSubscribedCustomerCanEstablishTransportWithoutInventedInboundAudio() {
        assertTrue(NativeRoomPolicy.customerMutedTransportReady(1000,10,4,160,0,0,0,true,true,true,true));
        assertFalse(NativeRoomPolicy.mediaReady(1000,10,4,160,0,0,0,true,true));
    }
    @Test public void silenceAloneOrAnUnsubscribedTrackCannotUseMutedTransportReadiness() {
        assertFalse(NativeRoomPolicy.customerMutedTransportReady(1000,10,4,160,0,0,0,true,true,false,true));
        assertFalse(NativeRoomPolicy.customerMutedTransportReady(1000,10,4,160,0,0,0,true,true,true,false));
    }
    @Test public void mutedTransportStillRequiresFreshOutgoingPacketsAndSecureTransport() {
        assertFalse(NativeRoomPolicy.customerMutedTransportReady(1000,2001,4,160,0,0,0,true,true,true,true));
        assertFalse(NativeRoomPolicy.customerMutedTransportReady(499,10,4,160,0,0,0,true,true,true,true));
        assertFalse(NativeRoomPolicy.customerMutedTransportReady(5001,10,4,160,0,0,0,true,true,true,true));
        assertFalse(NativeRoomPolicy.customerMutedTransportReady(1000,10,0,160,0,0,0,true,true,true,true));
        assertFalse(NativeRoomPolicy.customerMutedTransportReady(1000,10,4,0,0,0,0,true,true,true,true));
        assertFalse(NativeRoomPolicy.customerMutedTransportReady(1000,10,4,160,0,0,0,false,true,true,true));
        assertFalse(NativeRoomPolicy.customerMutedTransportReady(1000,10,4,160,0,0,0,true,false,true,true));
        assertFalse(NativeRoomPolicy.customerMutedTransportReady(1000,10,4,160,-1,0,0,true,true,true,true));
    }
    @Test public void roomTokensMayOnlyGoToCanonicalLiveKitCloudOrigin() {
        assertTrue(NativeRoomPolicy.validRoomUrl("wss://sh-test.livekit.cloud"));
        assertTrue(NativeRoomPolicy.validRoomUrl("wss://sh-test.livekit.cloud/"));
        assertFalse(NativeRoomPolicy.validRoomUrl("wss://sh-test.livekit.cloud.evil.test"));
        assertFalse(NativeRoomPolicy.validRoomUrl("wss://attacker@sh-test.livekit.cloud"));
        assertFalse(NativeRoomPolicy.validRoomUrl("wss://sh-test.livekit.cloud/?token=secret"));
        assertFalse(NativeRoomPolicy.validRoomUrl("https://sh-test.livekit.cloud"));
        assertFalse(NativeRoomPolicy.validRoomUrl("wss://sh-test.livekit.cloud:8080"));
    }
    @Test public void subscriptionAndSignalingAloneCannotBeReady() {
        assertFalse(ready(0, 0, 0, true, true));
        assertFalse(ready(8, 0, 50, true, true));
        assertFalse(ready(8, 8, 0, true, true));
    }
    @Test public void realPacketsAndDecodedSilenceDoNotNeedPositiveAudioEnergy() {
        assertTrue(ready(8, 8, 480, true, true));
    }
    @Test public void iceAndDtlsAreBothRequired() {
        assertFalse(ready(8, 8, 480, false, true));
        assertFalse(ready(8, 8, 480, true, false));
    }
    @Test public void staleAndTooShortSamplesAreRejected() {
        assertFalse(NativeRoomPolicy.mediaReady(499, 0, 3, 120, 3, 120, 480, true, true));
        assertFalse(NativeRoomPolicy.mediaReady(5001, 0, 3, 120, 3, 120, 480, true, true));
        assertFalse(NativeRoomPolicy.mediaReady(1000, 2001, 3, 120, 3, 120, 480, true, true));
        assertFalse(NativeRoomPolicy.mediaReady(1000, -1, 3, 120, 3, 120, 480, true, true));
    }
    @Test public void counterResetAfterReconnectIsNotFreshMedia() {
        assertFalse(NativeRoomPolicy.mediaReady(1000, 0, -2, 120, 3, 120, 480, true, true));
        assertFalse(NativeRoomPolicy.mediaReady(1000, 0, 3, -120, 3, 120, 480, true, true));
    }
    @Test public void localEndWinsOverLateAcceptCallback() {
        NativeRoomPolicy.Epoch session = new NativeRoomPolicy.Epoch(); long captured = session.begin();
        assertTrue(session.current(captured)); session.close();
        assertFalse(session.current(captured)); assertFalse(session.acceptVersion(captured, 100));
    }
    @Test public void aNewCallCannotBeOverwrittenByPreviousCallCallbacks() {
        NativeRoomPolicy.Epoch session = new NativeRoomPolicy.Epoch(); long old = session.begin();
        session.close(); long current = session.begin();
        assertFalse(session.acceptVersion(old, 200)); assertTrue(session.acceptVersion(current, 1));
    }
    @Test public void oldRingingPollCannotRegressNewerConnectedOrTransferStatus() {
        NativeRoomPolicy.Epoch session = new NativeRoomPolicy.Epoch(); long current = session.begin();
        assertTrue(session.acceptVersion(current, 6)); assertFalse(session.acceptVersion(current, 5));
        assertTrue(session.acceptVersion(current, 6)); assertTrue(session.acceptVersion(current, 7));
        assertEquals(7, session.version());
    }
    @Test public void transferIdentityCannotInjectAPathOrUseOrdinaryProviderCallId() {
        assertTrue(NativeRoomPolicy.validTransferId("transfer_799bbd5d-207c-4156"));
        assertFalse(NativeRoomPolicy.validTransferId("../../end"));
        assertFalse(NativeRoomPolicy.validTransferId("wa:call/123"));
        assertFalse(NativeRoomPolicy.validTransferId(""));
    }
    @Test public void outgoingPhoneIsCountryCodeDigitsOnly() {
        assertTrue(NativeRoomPolicy.validPhone("919876543210"));
        assertFalse(NativeRoomPolicy.validPhone("+919876543210"));
        assertFalse(NativeRoomPolicy.validPhone("0919876543210"));
        assertFalse(NativeRoomPolicy.validPhone("123"));
    }
    @Test public void staleSourceEndAfterTransferMustNeverEndTheNewOwnersCall() {
        assertEquals(NativeRoomPolicy.Cleanup.NONE, NativeRoomPolicy.cleanupAction("A", "B", "connected", "", "T1", "completed", "B"));
    }
    @Test public void targetEndWhileJoiningDeclinesOnlyItsInvitation() {
        assertEquals(NativeRoomPolicy.Cleanup.DECLINE_TRANSFER, NativeRoomPolicy.cleanupAction("B", "A", "connected", "T1", "T1", "connecting", "B"));
    }
    @Test public void targetLocalEndRacingSuccessfulCommitEndsItsOwnNowOwnedCall() {
        assertEquals(NativeRoomPolicy.Cleanup.END, NativeRoomPolicy.cleanupAction("B", "B", "connected", "T1", "T1", "completing", "B"));
    }
    @Test public void sourceMayEndWhileStillOwnerBeforeCommit() {
        assertEquals(NativeRoomPolicy.Cleanup.END, NativeRoomPolicy.cleanupAction("A", "A", "connected", "", "T1", "connecting", "B"));
    }
    @Test public void declinedOrReplacedInvitationCannotTerminateCustomer() {
        assertEquals(NativeRoomPolicy.Cleanup.NONE, NativeRoomPolicy.cleanupAction("B", "A", "connected", "T1", "T1", "declined", "B"));
        assertEquals(NativeRoomPolicy.Cleanup.NONE, NativeRoomPolicy.cleanupAction("B", "A", "connected", "T1", "T2", "invited", "B"));
    }
    @Test public void alreadyEndingServerNeedsNoSecondTermination() {
        assertEquals(NativeRoomPolicy.Cleanup.NONE, NativeRoomPolicy.cleanupAction("A", "A", "ending", "", "", "", ""));
        assertEquals(NativeRoomPolicy.Cleanup.NONE, NativeRoomPolicy.cleanupAction("A", "A", "ended", "", "", "", ""));
    }
    @Test public void notificationDeclineRejectsOnlyAnUnownedRingingCall() {
        assertEquals(NativeRoomPolicy.Cleanup.REJECT, NativeRoomPolicy.declineAction("A", "", "ringing", "", "", "", ""));
        assertEquals(NativeRoomPolicy.Cleanup.NONE, NativeRoomPolicy.declineAction("A", "B", "joining", "", "", "", ""));
    }
    @Test public void delayedNotificationDeclineCannotHangUpAlreadyAcceptedSamePhone() {
        assertEquals(NativeRoomPolicy.Cleanup.NONE, NativeRoomPolicy.declineAction("A", "A", "connected", "", "", "", ""));
        assertEquals(NativeRoomPolicy.Cleanup.NONE, NativeRoomPolicy.declineAction("B", "B", "connected", "T1", "T1", "completed", "B"));
    }
    @Test public void notificationTransferDeclineKeepsSourceConnected() {
        assertEquals(NativeRoomPolicy.Cleanup.DECLINE_TRANSFER, NativeRoomPolicy.declineAction("B", "A", "connected", "T1", "T1", "connecting", "B"));
    }
    private boolean ready(long outgoing, long incoming, long frames, boolean ice, boolean dtls) {
        return NativeRoomPolicy.mediaReady(1000, 10, outgoing, outgoing * 20, incoming, incoming * 20, frames, ice, dtls);
    }
}
