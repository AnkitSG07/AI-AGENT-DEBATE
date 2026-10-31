package com.smarthandicrafts.operatorhub;

import io.livekit.android.room.participant.ParticipantTrackPermission;
import java.util.Collections;

/** Compatibility at the pinned SDK boundary plus diagnostics that never include SDK error text. */
public final class NativeRoomAudioSetup {
    public enum Stage {
        AUTHORIZATION, ROOM_JOIN, IDENTITY, MICROPHONE_PERMISSION, MICROPHONE_PUBLISH,
        CUSTOMER_SUBSCRIPTION, AUDIO_ACTIVE, MICROPHONE_CONTROL
    }

    public static ParticipantTrackPermission customerPermission(String expectedIdentity) {
        if (expectedIdentity == null || !expectedIdentity.matches("[A-Za-z0-9_-]{1,180}"))
            throw new IllegalArgumentException("A customer audio identity is required.");
        // LiveKit Android 2.29.2 serializes both nullable fields into protobuf string setters.
        // A null unused SID throws before microphone publication. Empty means unset on the wire;
        // the exact customer identity still restricts subscription and is never broadened.
        return new ParticipantTrackPermission(expectedIdentity, "", true, Collections.emptyList());
    }

    public static String failureCode(Stage stage, Throwable error) {
        String reason = error instanceof SecurityException ? "PERMISSION"
            : error instanceof NullPointerException ? "NULL_VALUE"
            : error instanceof IllegalArgumentException ? "INVALID_VALUE"
            : error instanceof IllegalStateException ? "STATE"
            : error instanceof java.io.IOException ? "NETWORK" : "SDK";
        return "AUDIO_" + stage.name() + "_" + reason;
    }

    public static String failureMessage(Stage stage) {
        switch (stage) {
            case AUTHORIZATION: return "Call audio authorization was incomplete. Try the call again.";
            case IDENTITY: return "This phone could not verify the call's audio identity.";
            case MICROPHONE_PERMISSION: return "The call's microphone access could not be prepared. Try again.";
            case MICROPHONE_PUBLISH: return "The microphone could not connect. Check microphone permission and try again.";
            case CUSTOMER_SUBSCRIPTION: return "The customer's audio could not connect. Try the call again.";
            case MICROPHONE_CONTROL: return "Could not change the microphone. Try the call again.";
            case AUDIO_ACTIVE: return "The audio connection stopped unexpectedly.";
            default: return "The audio connection could not start. Check your connection and try again.";
        }
    }

    private NativeRoomAudioSetup() { }
}
