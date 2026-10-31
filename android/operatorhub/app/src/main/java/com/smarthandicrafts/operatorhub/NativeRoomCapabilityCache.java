package com.smarthandicrafts.operatorhub;

/** Short in-process reuse of a successful authenticated check; the call API still authorizes each operation. */
public final class NativeRoomCapabilityCache {
    public static final long TTL_MS = 15000L;
    private DeviceLeasePolicy.Credential credential;
    private long checkedAt;
    private boolean enabled;

    public synchronized Boolean get(DeviceLeasePolicy.Credential expected, long elapsedNow) {
        long age = elapsedNow - checkedAt;
        if (!DeviceLeasePolicy.sameIdentity(credential, expected) || age < 0 || age >= TTL_MS) return null;
        return enabled;
    }
    public synchronized void remember(DeviceLeasePolicy.Credential checkedCredential, boolean value, long elapsedNow) {
        credential = checkedCredential; enabled = value; checkedAt = elapsedNow;
    }
    public synchronized void clear() { credential = null; checkedAt = 0; enabled = false; }
}
