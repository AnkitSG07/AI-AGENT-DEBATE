package com.smarthandicrafts.operatorhub;

import java.util.UUID;

/** Matches native UI updates to the exact service attempt before a server call ID exists. */
public final class NativeRoomUiBinding {
    public static boolean validAttemptId(String value) {
        if (value == null || value.length() != 36) return false;
        try { return UUID.fromString(value).toString().equalsIgnoreCase(value); }
        catch (IllegalArgumentException ignored) { return false; }
    }
    public static boolean matches(String expectedAttempt, String expectedCall, String expectedTransfer,
                                  String actualAttempt, String actualCall, String actualProvider, String actualTransfer) {
        if (expectedAttempt != null && !expectedAttempt.isEmpty()) {
            return validAttemptId(expectedAttempt) && expectedAttempt.equals(actualAttempt);
        }
        // Empty call IDs occur during outgoing setup; they are never an identity.
        if (expectedCall == null || expectedCall.isEmpty()) return false;
        if (expectedTransfer != null && !expectedTransfer.isEmpty() && !expectedTransfer.equals(actualTransfer)) return false;
        // The ongoing notification addresses the exact client attempt until /outgoing assigns an ID.
        if (validAttemptId(expectedCall) && expectedCall.equals(actualAttempt)) return true;
        return expectedCall.equals(actualCall) || expectedCall.equals(actualProvider);
    }
    private NativeRoomUiBinding() { }
}
