package com.smarthandicrafts.operatorhub;

/** A screen/notification controls one user-authorized attempt, including its eventual media leg. */
public final class NativeRoomControl {
    public static boolean matches(String expectedAttempt, String expectedLeg, String actualAttempt, String actualLeg, boolean closed) {
        if (closed || !NativeRoomUiBinding.validAttemptId(expectedAttempt) || !expectedAttempt.equals(actualAttempt)) return false;
        // The first End button may have been rendered before the same attempt obtained its leg.
        return expectedLeg == null || expectedLeg.isEmpty() || expectedLeg.equals(actualLeg);
    }
    public static boolean sameCredential(DeviceLeasePolicy.Credential expected, DeviceLeasePolicy.Credential actual) {
        return DeviceLeasePolicy.sameIdentity(expected, actual);
    }
    public static boolean mayDismissPendingAnswer(boolean exactAlert, boolean alertClosed, boolean matchingServiceStarted) {
        return exactAlert && alertClosed && !matchingServiceStarted;
    }
    private NativeRoomControl() { }
}
