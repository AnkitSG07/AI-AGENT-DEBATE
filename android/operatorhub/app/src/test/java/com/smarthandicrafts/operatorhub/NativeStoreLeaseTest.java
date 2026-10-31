package com.smarthandicrafts.operatorhub;

import android.content.Context;
import android.content.ContextWrapper;
import android.content.SharedPreferences;
import org.junit.Test;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import static org.junit.Assert.*;

public class NativeStoreLeaseTest {
    private static final String ID = "android_1234567890abcdefghijklmnop";
    private static final String TOKEN = ID + ".abcdefghijklmnopqrstuvwxyz0123456789";
    private TestContext context() { return new TestContext(); }
    private NativeStore enrolled(TestContext context, long expiry) {
        NativeStore store = new NativeStore(context);
        assertTrue(store.enrollIfGeneration(ID, TOKEN, expiry, 0)); return store;
    }
    @Test public void successfulRenewalPersistsExpiryAndPreservesBearerAndFcmToken() {
        TestContext context = context(); long now = System.currentTimeMillis();
        NativeStore store = enrolled(context, now + 86400000); store.setFcmToken("unchanged_fcm");
        DeviceLeasePolicy.Credential expected = store.credential();
        assertTrue(store.applyLeaseExpiry(expected, ID, now + DeviceLeasePolicy.TOKEN_TTL_MS));
        NativeStore recreated = new NativeStore(context);
        assertEquals(now + DeviceLeasePolicy.TOKEN_TTL_MS, recreated.expiresAt()); assertEquals(TOKEN, recreated.token());
        assertEquals("unchanged_fcm", recreated.fcmToken()); assertTrue(recreated.matchesCredential(expected));
    }
    @Test public void aLateSuccessCannotUndoLocalDisable() {
        NativeStore store = enrolled(context(), System.currentTimeMillis() + 86400000);
        DeviceLeasePolicy.Credential expected = store.credential();
        store.clearEnrollment();
        assertFalse(store.applyLeaseExpiry(expected, ID, System.currentTimeMillis() + DeviceLeasePolicy.TOKEN_TTL_MS));
        assertEquals("", store.token()); assertFalse(store.enrolled());
    }
    @Test public void delayedRenewalAnd401CannotOverwriteAConcurrentNewEnrollment() throws Exception {
        NativeStore store = enrolled(context(), System.currentTimeMillis() + 86400000);
        DeviceLeasePolicy.Credential old = store.credential();
        ExecutorService io = Executors.newSingleThreadExecutor(); CountDownLatch response = new CountDownLatch(1);
        try {
            Future<Boolean> pending = io.submit(() -> { response.await(); return store.applyLeaseExpiry(old, ID, System.currentTimeMillis() + DeviceLeasePolicy.TOKEN_TTL_MS); });
            store.clearEnrollment();
            String newToken = ID + ".new_secret_abcdefghijklmnopqrstuvwxyz0123456789";
            assertTrue(store.enrollIfGeneration(ID, newToken, System.currentTimeMillis() + 86400000, store.credential().generation));
            response.countDown(); assertFalse(pending.get(2, TimeUnit.SECONDS));
            assertFalse(store.clearEnrollmentIfMatches(old, "Old request401")); assertEquals(newToken, store.token());
        } finally { response.countDown(); io.shutdownNow(); }
    }
    @Test public void generationProtectsAnIdempotentlyReenrolledIdenticalBearer() {
        NativeStore store = enrolled(context(), System.currentTimeMillis() + 86400000);
        DeviceLeasePolicy.Credential old = store.credential();
        store.clearEnrollment();
        assertTrue(store.enrollIfGeneration(ID, TOKEN, System.currentTimeMillis() + 86400000, store.credential().generation));
        assertFalse(store.applyLeaseExpiry(old, ID, System.currentTimeMillis() + DeviceLeasePolicy.TOKEN_TTL_MS));
        assertFalse(store.clearEnrollmentIfMatches(old, "Old401")); assertEquals(TOKEN, store.token());
    }
    @Test public void disablingDuringInitialEnrollmentCancelsItsPendingResponse() {
        NativeStore store = new NativeStore(context()); long requestedGeneration = store.credential().generation;
        store.clearEnrollment();
        assertFalse(store.enrollIfGeneration(ID, TOKEN, System.currentTimeMillis() + 86400000, requestedGeneration));
        assertEquals("", store.token());
    }
    @Test public void renewedExpiryCannotBeShortenedByAnOlderTokenRefreshResponse() {
        long now = System.currentTimeMillis(); NativeStore store = enrolled(context(), now + 86400000);
        DeviceLeasePolicy.Credential request = store.credential();
        assertTrue(store.applyLeaseExpiry(request, ID, now + DeviceLeasePolicy.TOKEN_TTL_MS));
        assertFalse(store.applyLeaseExpiry(request, ID, request.expiresAt));
        assertEquals(now + DeviceLeasePolicy.TOKEN_TTL_MS, store.expiresAt());
    }
    @Test public void foregroundAndStartupReserveOneAttemptAndPersistItsThrottle() {
        TestContext context = context(); long now = System.currentTimeMillis();
        NativeStore store = enrolled(context, now + 2L * 86400000);
        assertNotNull(store.beginLeaseAttempt(now)); assertNull(store.beginLeaseAttempt(now + 1));
        assertNull(new NativeStore(context).beginLeaseAttempt(now + 1000));
        assertNotNull(store.beginLeaseAttempt(now + DeviceLeasePolicy.RETRY_INTERVAL_MS));
    }
    @Test public void legacyCapabilityIsSkippedAndStorageErrorsDoNotClearEnrollment() {
        long now = System.currentTimeMillis(); NativeStore store = enrolled(context(), now + 86400000);
        DeviceLeasePolicy.Credential expected = store.credential();
        store.leaseCapability(false, now); assertNull(store.beginLeaseAttempt(now));
        store.problemIfMatches(expected, "Service temporarily unavailable503");
        assertEquals(TOKEN, store.token()); assertTrue(store.enrolled());
        assertNotNull(store.beginLeaseAttempt(now + DeviceLeasePolicy.CAPABILITY_CACHE_MS));
    }
    @Test public void anExistingApkEnrollmentWithNoGenerationMetadataCanRenewWithoutReenrollment() {
        TestContext context = context(); long now = System.currentTimeMillis();
        context.getSharedPreferences("native_private", Context.MODE_PRIVATE).edit().putString("device_id", ID)
            .putString("device_token", TOKEN).putLong("device_expires", now + 86400000).commit();
        NativeStore store = new NativeStore(context);
        DeviceLeasePolicy.Credential migrated = store.credential(); assertEquals(0, migrated.generation);
        assertTrue(DeviceLeasePolicy.valid(migrated, now)); assertNotNull(store.beginLeaseAttempt(now));
        assertTrue(store.applyLeaseExpiry(migrated, ID, now + DeviceLeasePolicy.TOKEN_TTL_MS)); assertEquals(TOKEN, store.token());
    }

    @Test public void oldCapabilityResponseCannotEnableOrDisableAReenrolledDevice() {
        long now = System.currentTimeMillis(); NativeStore store = enrolled(context(), now + 86400000);
        DeviceLeasePolicy.Credential old = store.credential();
        store.clearEnrollment();
        assertTrue(store.enrollIfGeneration(ID, TOKEN, now + 86400000, store.credential().generation));
        DeviceLeasePolicy.Credential current = store.credential();
        assertFalse(store.roomCapabilitiesIfMatches(old, true, true, now));
        assertFalse(store.nativeRoomCalls());
        assertTrue(store.roomCapabilitiesIfMatches(current, true, true, now));
        assertTrue(store.nativeRoomCalls()); assertTrue(store.nativeRoomTransfers());
        assertFalse(store.roomCapabilitiesIfMatches(old, false, false, now));
        assertTrue(store.nativeRoomCalls());
    }

    @Test public void audioDiagnosticPersistsOnlySafeCodesAndTheMatchingDeviceCanClearIt() {
        TestContext context = context(); long now = System.currentTimeMillis();
        NativeStore store = enrolled(context, now + 86400000); DeviceLeasePolicy.Credential expected = store.credential();
        store.audioFailureIfMatches(expected, "MICROPHONE_PERMISSION", "AUDIO_MICROPHONE_PERMISSION_NULL_VALUE", now);
        NativeStore reopened = new NativeStore(context);
        assertEquals("AUDIO_MICROPHONE_PERMISSION_NULL_VALUE", reopened.audioFailureCode()); assertEquals(now, reopened.audioFailureAt());
        reopened.audioFailureIfMatches(expected, "unsafe-stage", "private token and SDP", now);
        assertEquals("AUDIO_MICROPHONE_PERMISSION_NULL_VALUE", reopened.audioFailureCode());
        DeviceLeasePolicy.Credential other = new DeviceLeasePolicy.Credential(expected.deviceId, expected.bearer, expected.expiresAt, expected.generation + 1);
        reopened.clearAudioFailureIfMatches(other); assertFalse(reopened.audioFailureCode().isEmpty());
        reopened.clearAudioFailureIfMatches(expected); assertEquals("", reopened.audioFailureCode()); assertEquals(0, reopened.audioFailureAt());
    }

    private static final class TestContext extends ContextWrapper {
        private final MemoryPreferences preferences = new MemoryPreferences();
        TestContext() { super(null); }
        @Override public Context getApplicationContext() { return this; }
        @Override public SharedPreferences getSharedPreferences(String name, int mode) { return preferences; }
    }
    private static final class MemoryPreferences implements SharedPreferences {
        private final Map<String, Object> values = new HashMap<>();
        @Override public synchronized Map<String, ?> getAll() { return new HashMap<>(values); }
        @Override public synchronized String getString(String key, String fallback) { return values.containsKey(key) ? (String)values.get(key) : fallback; }
        @Override @SuppressWarnings("unchecked") public synchronized Set<String> getStringSet(String key, Set<String> fallback) { return values.containsKey(key) ? new HashSet<>((Set<String>)values.get(key)) : fallback; }
        @Override public synchronized int getInt(String key, int fallback) { return values.containsKey(key) ? (Integer)values.get(key) : fallback; }
        @Override public synchronized long getLong(String key, long fallback) { return values.containsKey(key) ? (Long)values.get(key) : fallback; }
        @Override public synchronized float getFloat(String key, float fallback) { return values.containsKey(key) ? (Float)values.get(key) : fallback; }
        @Override public synchronized boolean getBoolean(String key, boolean fallback) { return values.containsKey(key) ? (Boolean)values.get(key) : fallback; }
        @Override public synchronized boolean contains(String key) { return values.containsKey(key); }
        @Override public void registerOnSharedPreferenceChangeListener(OnSharedPreferenceChangeListener listener) { }
        @Override public void unregisterOnSharedPreferenceChangeListener(OnSharedPreferenceChangeListener listener) { }
        @Override public Editor edit() {
            return new Editor() {
                private final Map<String, Object> changes = new HashMap<>(); private boolean clear;
                @Override public Editor putString(String key, String value) { changes.put(key, value); return this; }
                @Override public Editor putStringSet(String key, Set<String> value) { changes.put(key, value == null ? null : new HashSet<>(value)); return this; }
                @Override public Editor putInt(String key, int value) { changes.put(key, value); return this; }
                @Override public Editor putLong(String key, long value) { changes.put(key, value); return this; }
                @Override public Editor putFloat(String key, float value) { changes.put(key, value); return this; }
                @Override public Editor putBoolean(String key, boolean value) { changes.put(key, value); return this; }
                @Override public Editor remove(String key) { changes.put(key, null); return this; }
                @Override public Editor clear() { clear = true; return this; }
                @Override public boolean commit() { apply(); return true; }
                @Override public void apply() {
                    synchronized (MemoryPreferences.this) {
                        if (clear) values.clear();
                        for (Map.Entry<String, Object> entry : changes.entrySet()) {
                            if (entry.getValue() == null) values.remove(entry.getKey()); else values.put(entry.getKey(), entry.getValue());
                        }
                    }
                }
            };
        }
    }
}
