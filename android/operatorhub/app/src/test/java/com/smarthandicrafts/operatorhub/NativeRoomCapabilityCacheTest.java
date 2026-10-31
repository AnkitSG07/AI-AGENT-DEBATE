package com.smarthandicrafts.operatorhub;

import org.junit.Test;
import static org.junit.Assert.*;

public class NativeRoomCapabilityCacheTest {
    private DeviceLeasePolicy.Credential credential(long generation, String bearer, long expiry) {
        return new DeviceLeasePolicy.Credential("android_1234567890abcdefghijklmnop", bearer, expiry, generation);
    }

    @Test public void activityAndServiceReuseOneFreshCheckForTheSameEnrollment() {
        NativeRoomCapabilityCache cache = new NativeRoomCapabilityCache();
        DeviceLeasePolicy.Credential a = credential(1, "same", 999999);
        assertNull(cache.get(a, 1000));
        cache.remember(a, true, 1000);
        assertEquals(Boolean.TRUE, cache.get(a, 1200));
        assertEquals(Boolean.TRUE, cache.get(a, 15999));
        assertNull(cache.get(a, 16000));
    }

    @Test public void unregisterReenrollGenerationAndBearerChangesAlwaysNeedFreshAuthorization() {
        NativeRoomCapabilityCache cache = new NativeRoomCapabilityCache();
        cache.remember(credential(1, "first", 999999), true, 1000);
        assertNull(cache.get(credential(2, "first", 999999), 1100));
        assertNull(cache.get(credential(1, "different", 999999), 1100));
        assertNull(cache.get(null, 1100));
    }

    @Test public void leaseRenewalKeepsTheSameAuthenticatedIdentityWithoutExtendingCacheTtl() {
        NativeRoomCapabilityCache cache = new NativeRoomCapabilityCache();
        cache.remember(credential(1, "same", 5000), true, 1000);
        assertEquals(Boolean.TRUE, cache.get(credential(1, "same", 999999), 1100));
        assertNull(cache.get(credential(1, "same", 999999), 16000));
    }

    @Test public void clockResetAndExplicitInvalidationCannotReuseAuthorization() {
        NativeRoomCapabilityCache cache = new NativeRoomCapabilityCache();
        DeviceLeasePolicy.Credential a = credential(1, "same", 999999);
        cache.remember(a, true, 1000);
        assertNull(cache.get(a, 999));
        cache.clear(); assertNull(cache.get(a, 1100));
    }

    @Test public void disabledCapabilityStaysDisabledAndTransientFailureDoesNotExtendOldCheck() {
        NativeRoomCapabilityCache cache = new NativeRoomCapabilityCache();
        DeviceLeasePolicy.Credential a = credential(1, "same", 999999);
        cache.remember(a, false, 1000);
        assertEquals(Boolean.FALSE, cache.get(a, 1100));
        // A failing network refresh never calls remember; the expired value cannot authorize.
        assertNull(cache.get(a, 16000));
        assertNull(cache.get(a, 17000));
    }
}
