package com.smarthandicrafts.operatorhub;

/** Pure timing and identity rules; no network, Android state or credential logging. */
public final class DeviceLeasePolicy {
    public static final long TOKEN_TTL_MS = 30L * 86400000L;
    public static final long RENEW_WINDOW_MS = 7L * 86400000L;
    public static final long CAPABILITY_CACHE_MS = 6L * 3600000L;
    public static final long RETRY_INTERVAL_MS = 15L * 60000L;
    private static final long CLOCK_SKEW_MS = 5L * 60000L;

    public enum Plan { NONE, CHECK_CAPABILITY, RENEW }
    public static final class Credential {
        public final String deviceId, bearer;
        public final long expiresAt, generation;
        public Credential(String deviceId, String bearer, long expiresAt, long generation) {
            this.deviceId = deviceId == null ? "" : deviceId;
            this.bearer = bearer == null ? "" : bearer;
            this.expiresAt = expiresAt; this.generation = generation;
        }
    }
    public static boolean valid(Credential value, long now) {
        return value != null && now > 0 && value.expiresAt > now && value.generation >= 0
            && value.deviceId.matches("android_[A-Za-z0-9_-]{16,100}")
            && value.bearer.matches("[A-Za-z0-9_.-]{45,240}") && value.bearer.startsWith(value.deviceId + ".");
    }
    public static boolean sameIdentity(Credential current, Credential expected) {
        return current != null && expected != null && !expected.bearer.isEmpty() && !expected.deviceId.isEmpty()
            && current.generation == expected.generation && current.deviceId.equals(expected.deviceId)
            && current.bearer.equals(expected.bearer);
    }
    public static boolean capabilityCheckDue(long checkedAt, long now) {
        return checkedAt <= 0 || now < checkedAt || now - checkedAt >= CAPABILITY_CACHE_MS;
    }
    public static Plan plan(Credential value, long now, long lastAttempt, long capabilityCheckedAt, boolean supported) {
        if (!valid(value, now) || value.expiresAt - now > RENEW_WINDOW_MS) return Plan.NONE;
        long retry = value.expiresAt - now <= 3600000L ? 60000L : RETRY_INTERVAL_MS;
        if (lastAttempt > 0 && now >= lastAttempt && now - lastAttempt < retry) return Plan.NONE;
        if (capabilityCheckDue(capabilityCheckedAt, now)) return Plan.CHECK_CAPABILITY;
        return supported ? Plan.RENEW : Plan.NONE;
    }
    public static boolean acceptsExpiry(Credential current, Credential expected, String responseDeviceId, long responseExpiry, long now) {
        // A request sent while valid may return after the old lease expires.
        // Accept its future expiry only for the exact still-installed credential.
        return sameIdentity(current, expected) && current.deviceId.equals(responseDeviceId)
            && now > 0 && responseExpiry > now && responseExpiry >= current.expiresAt
            && responseExpiry - now <= TOKEN_TTL_MS + CLOCK_SKEW_MS;
    }
    public static boolean shouldInvalidate(int status, Credential current, Credential expected) {
        return shouldInvalidate(status, true, current, expected);
    }
    public static boolean shouldInvalidate(int status, boolean authenticatedRequest, Credential current, Credential expected) {
        return authenticatedRequest && status == 401 && sameIdentity(current, expected);
    }
    private DeviceLeasePolicy() { }
}
