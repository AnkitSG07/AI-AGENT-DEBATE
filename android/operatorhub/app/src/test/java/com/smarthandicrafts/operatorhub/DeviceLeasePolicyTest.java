package com.smarthandicrafts.operatorhub;

import org.junit.Test;
import static org.junit.Assert.*;

public class DeviceLeasePolicyTest {
    private static final long NOW = 1793188800000L;
    private static final String ID = "android_1234567890abcdefghijklmnop";
    private static final String TOKEN = ID + ".abcdefghijklmnopqrstuvwxyz0123456789";
    private DeviceLeasePolicy.Credential credential(long expiry, long generation) {
        return new DeviceLeasePolicy.Credential(ID, TOKEN, expiry, generation);
    }
    @Test public void healthyLeaseDoesNotCheckConfigOrRenew() {
        assertEquals(DeviceLeasePolicy.Plan.NONE, DeviceLeasePolicy.plan(credential(NOW + 8L * 86400000, 1), NOW, 0, 0, false));
    }
    @Test public void sevenDayBoundaryRequestsOnlyOneCapabilityCheck() {
        DeviceLeasePolicy.Credential c = credential(NOW + DeviceLeasePolicy.RENEW_WINDOW_MS, 1);
        assertEquals(DeviceLeasePolicy.Plan.CHECK_CAPABILITY, DeviceLeasePolicy.plan(c, NOW, 0, 0, false));
        assertEquals(DeviceLeasePolicy.Plan.NONE, DeviceLeasePolicy.plan(c, NOW + 1, NOW, 0, false));
    }
    @Test public void supportedServerRenewsWhileOldServerIsSkippedUntilCapabilityCacheExpires() {
        DeviceLeasePolicy.Credential c = credential(NOW + 2L * 86400000, 1);
        assertEquals(DeviceLeasePolicy.Plan.RENEW, DeviceLeasePolicy.plan(c, NOW, 0, NOW, true));
        assertEquals(DeviceLeasePolicy.Plan.NONE, DeviceLeasePolicy.plan(c, NOW, 0, NOW, false));
        assertEquals(DeviceLeasePolicy.Plan.CHECK_CAPABILITY, DeviceLeasePolicy.plan(c, NOW + DeviceLeasePolicy.CAPABILITY_CACHE_MS, 0, NOW, false));
    }
    @Test public void expiredMissingOrMismatchedCredentialsNeverRenew() {
        assertEquals(DeviceLeasePolicy.Plan.NONE, DeviceLeasePolicy.plan(credential(NOW, 1), NOW, 0, 0, true));
        assertEquals(DeviceLeasePolicy.Plan.NONE, DeviceLeasePolicy.plan(credential(NOW - 1, 1), NOW, 0, 0, true));
        assertEquals(DeviceLeasePolicy.Plan.NONE, DeviceLeasePolicy.plan(new DeviceLeasePolicy.Credential(ID, "", NOW + 1000, 1), NOW, 0, 0, true));
        assertFalse(DeviceLeasePolicy.valid(new DeviceLeasePolicy.Credential(ID, "android_other_device_1234567890.secret_abcdefghijklmnopqrstuvwxyz", NOW + 1000, 1), NOW));
    }
    @Test public void retriesAreThrottledAndShorterOnlyWhenExpiryIsWithinOneHour() {
        DeviceLeasePolicy.Credential normal = credential(NOW + 2L * 86400000, 1), urgent = credential(NOW + 600000, 1);
        assertEquals(DeviceLeasePolicy.Plan.NONE, DeviceLeasePolicy.plan(normal, NOW, NOW - 14L * 60000, NOW, true));
        assertEquals(DeviceLeasePolicy.Plan.RENEW, DeviceLeasePolicy.plan(normal, NOW, NOW - 15L * 60000, NOW, true));
        assertEquals(DeviceLeasePolicy.Plan.NONE, DeviceLeasePolicy.plan(urgent, NOW, NOW - 59000, NOW, true));
        assertEquals(DeviceLeasePolicy.Plan.RENEW, DeviceLeasePolicy.plan(urgent, NOW, NOW - 60000, NOW, true));
    }
    @Test public void aBackwardClockChangeDoesNotFreezeCapabilityChecks() {
        assertEquals(DeviceLeasePolicy.Plan.CHECK_CAPABILITY, DeviceLeasePolicy.plan(credential(NOW + 100000, 1), NOW, NOW + 1000, NOW + 1000, true));
    }
    @Test public void responseReceivedAfterOldExpiryCanSaveTheServerConfirmedFutureLease() {
        DeviceLeasePolicy.Credential started = credential(NOW + 1000, 1);
        assertTrue(DeviceLeasePolicy.valid(started, NOW));
        assertFalse(DeviceLeasePolicy.valid(started, NOW + 2000));
        assertTrue(DeviceLeasePolicy.acceptsExpiry(started, started, ID, NOW + DeviceLeasePolicy.TOKEN_TTL_MS, NOW + 2000));
    }
    @Test public void oldResponseCannotReviveSignoutOrAReenrolledCredential() {
        DeviceLeasePolicy.Credential previous = credential(NOW + 1000, 1);
        assertFalse(DeviceLeasePolicy.acceptsExpiry(new DeviceLeasePolicy.Credential("", "", 0, 2), previous, ID, NOW + 86400000, NOW));
        assertFalse(DeviceLeasePolicy.acceptsExpiry(new DeviceLeasePolicy.Credential(ID, ID + ".different_secret_abcdefghijklmnopqrstuvwxyz", NOW + 1000, 2), previous, ID, NOW + 86400000, NOW));
        // Idempotent enrollment recovery can return the same bearer. Local generation still wins.
        assertFalse(DeviceLeasePolicy.acceptsExpiry(credential(NOW + 1000, 3), previous, ID, NOW + 86400000, NOW));
    }
    @Test public void expiryMustBeBoundedMonotonicAndForTheExactDevice() {
        DeviceLeasePolicy.Credential c = credential(NOW + 86400000, 1);
        assertFalse(DeviceLeasePolicy.acceptsExpiry(c, c, "android_another_device_1234567890", NOW + 2L * 86400000, NOW));
        assertFalse(DeviceLeasePolicy.acceptsExpiry(c, c, ID, NOW, NOW));
        assertFalse(DeviceLeasePolicy.acceptsExpiry(c, c, ID, NOW + 1000, NOW));
        assertFalse(DeviceLeasePolicy.acceptsExpiry(c, c, ID, Long.MAX_VALUE, NOW));
        assertTrue(DeviceLeasePolicy.acceptsExpiry(c, c, ID, NOW + 2L * 86400000, NOW));
    }
    @Test public void concurrentOldTokenRefreshCannotShortenANewerRenewal() {
        DeviceLeasePolicy.Credential dispatched = credential(NOW + 86400000, 1), renewed = credential(NOW + DeviceLeasePolicy.TOKEN_TTL_MS, 1);
        assertTrue(DeviceLeasePolicy.sameIdentity(renewed, dispatched));
        assertFalse(DeviceLeasePolicy.acceptsExpiry(renewed, dispatched, ID, dispatched.expiresAt, NOW));
    }
    @Test public void only401ForTheExactCurrentCredentialInvalidatesEnrollment() {
        DeviceLeasePolicy.Credential c = credential(NOW + 1000, 1);
        assertTrue(DeviceLeasePolicy.shouldInvalidate(401, c, c));
        assertFalse(DeviceLeasePolicy.shouldInvalidate(401, false, c, c));
        for (int status : new int[] { 403, 429, 500, 503 }) assertFalse(DeviceLeasePolicy.shouldInvalidate(status, c, c));
        assertFalse(DeviceLeasePolicy.shouldInvalidate(401, credential(NOW + 1000, 2), c));
    }
}
