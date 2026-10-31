package com.smarthandicrafts.operatorhub;

import io.livekit.android.room.participant.ParticipantTrackPermission;
import java.util.Collections;
import livekit.LivekitRtc;
import org.junit.Test;
import static org.junit.Assert.*;

public class NativeRoomAudioSetupTest {
    private static final String CUSTOMER = "sh-customer-0123456789abcdef0123456789abcdef";

    @Test public void pinnedSdkIdentityOnlyNullSidReproducesThePreMicrophoneCrash() {
        // This invokes the actual 2.29.2 dependency serializer, not a mocked protobuf model.
        ParticipantTrackPermission old = new ParticipantTrackPermission(CUSTOMER, null, true, Collections.emptyList());
        try { old.toProto$livekit_android_sdk_release(); fail("The pinned SDK null-field regression was not reproduced"); }
        catch (NullPointerException expected) { }
    }

    @Test public void compatibilityPermissionSerializesExactCustomerWithoutNullFields() {
        ParticipantTrackPermission fixed = NativeRoomAudioSetup.customerPermission(CUSTOMER);
        LivekitRtc.TrackPermission encoded = fixed.toProto$livekit_android_sdk_release();
        assertEquals(CUSTOMER, encoded.getParticipantIdentity());
        assertEquals("", encoded.getParticipantSid());
        assertTrue(encoded.getAllTracks());
        assertEquals(0, encoded.getTrackSidsCount());
    }

    @Test public void serializedPolicyStillExcludesEveryOtherParticipant() throws Exception {
        LivekitRtc.SubscriptionPermission policy = LivekitRtc.SubscriptionPermission.newBuilder()
            .setAllParticipants(false)
            .addTrackPermissions(NativeRoomAudioSetup.customerPermission(CUSTOMER).toProto$livekit_android_sdk_release())
            .build();
        LivekitRtc.SubscriptionPermission wire = LivekitRtc.SubscriptionPermission.parseFrom(policy.toByteArray());
        assertFalse(wire.getAllParticipants());
        assertEquals(1, wire.getTrackPermissionsCount());
        assertEquals(CUSTOMER, wire.getTrackPermissions(0).getParticipantIdentity());
    }

    @Test public void missingCustomerIdentityCannotFallBackToAnUnrestrictedPermission() {
        for (String invalid : new String[]{null, "", " ", "customer\nother", "*"}) {
            try { NativeRoomAudioSetup.customerPermission(invalid); fail("Unsafe customer identity accepted"); }
            catch (IllegalArgumentException expected) { }
        }
    }

    @Test public void retainedDiagnosticsContainOnlyStageAndClassifiedReason() {
        String secret = "private-token-and-sdp-never-retained";
        assertEquals("AUDIO_MICROPHONE_PERMISSION_NULL_VALUE", NativeRoomAudioSetup.failureCode(
            NativeRoomAudioSetup.Stage.MICROPHONE_PERMISSION, new NullPointerException(secret)));
        assertEquals("AUDIO_MICROPHONE_PUBLISH_PERMISSION", NativeRoomAudioSetup.failureCode(
            NativeRoomAudioSetup.Stage.MICROPHONE_PUBLISH, new SecurityException(secret)));
        for (NativeRoomAudioSetup.Stage stage : NativeRoomAudioSetup.Stage.values()) {
            String code = NativeRoomAudioSetup.failureCode(stage, new RuntimeException(secret));
            assertTrue(code.matches("AUDIO_[A-Z_]{1,96}"));
            assertFalse(code.contains(secret));
            assertFalse(NativeRoomAudioSetup.failureMessage(stage).contains(secret));
        }
    }
}
