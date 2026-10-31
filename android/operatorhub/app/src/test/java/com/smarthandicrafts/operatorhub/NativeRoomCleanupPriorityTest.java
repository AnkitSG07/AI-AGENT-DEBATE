package com.smarthandicrafts.operatorhub;

import android.app.Application;
import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Robolectric;
import org.robolectric.Shadows;
import org.robolectric.android.controller.ServiceController;
import org.robolectric.annotation.Config;
import javax.net.ssl.HttpsURLConnection;
import java.net.URL;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.security.cert.Certificate;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.atomic.AtomicBoolean;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class) @Config(sdk = 28, application = Application.class)
public class NativeRoomCleanupPriorityTest {
    private static final String OLD = "out_0123456789abcdef0123456789abcdef";
    private static final String FRESH = "out_abcdef0123456789abcdef0123456789";
    private static Field field(Class<?> type, String name) throws Exception {
        Field value = type.getDeclaredField(name); value.setAccessible(true); return value;
    }
    private static final class Connection extends HttpsURLConnection {
        final ByteArrayOutputStream sent = new ByteArrayOutputStream();
        final CountDownLatch entered, release;
        final AtomicInteger requests;
        final AtomicReference<JSONObject> body;
        Connection(URL url, CountDownLatch entered, CountDownLatch release, AtomicInteger requests, AtomicReference<JSONObject> body) {
            super(url); this.entered = entered; this.release = release; this.requests = requests; this.body = body;
        }
        public void connect() { }
        public void disconnect() { }
        public boolean usingProxy() { return false; }
        public String getCipherSuite() { return "TEST-NO-NETWORK"; }
        public Certificate[] getLocalCertificates() { return new Certificate[0]; }
        public Certificate[] getServerCertificates() { return new Certificate[0]; }
        public OutputStream getOutputStream() { return sent; }
        public int getResponseCode() {
            try {
                body.set(new JSONObject(sent.toString(StandardCharsets.UTF_8.name())));
                requests.incrementAndGet(); entered.countDown();
                assertTrue("The fake request must be released by the test", release.await(10, TimeUnit.SECONDS));
                return 200;
            } catch (Exception error) { throw new AssertionError(error); }
        }
        public InputStream getInputStream() { return new ByteArrayInputStream("{\"ok\":true}".getBytes(StandardCharsets.UTF_8)); }
    }
    @Test public void freshEndBypassesBlockedOldRetryAndDuplicateTapsDoNotDuplicateItsRequest() throws Exception {
        Application app = RuntimeEnvironment.getApplication();
        app.getSharedPreferences("native_private", Context.MODE_PRIVATE).edit().clear().commit();
        SharedPreferences queue = app.getSharedPreferences("native_room_cleanup", Context.MODE_PRIVATE); queue.edit().clear().commit();
        NativeStore store = new NativeStore(app); String id = "android_1234567890abcdefghijklmnop";
        assertTrue(store.enrollIfGeneration(id, id + ".abcdefghijklmnopqrstuvwxyz0123456789", System.currentTimeMillis() + 86400000, 0));
        DeviceLeasePolicy.Credential credential = store.credential();
        String oldKey = "end:" + credential.generation + ":" + OLD + ":old-leg:";
        queue.edit().putString(oldKey, new JSONObject().put("callId", OLD).put("transferId", "").put("ownerLegId", "old-leg")
            .put("intent", "end").put("deviceId", id).put("generation", credential.generation)
            .put("credentialHash", NativeRoomCleanupProcessor.digest(credential.bearer)).put("requestId", "older-cleanup-request-0001")
            .put("outgoingRequestId", "").put("createdAt", System.currentTimeMillis()).put("attempts", 1).toString()).commit();
        CountDownLatch oldEntered = new CountDownLatch(1), oldRelease = new CountDownLatch(1), freshEntered = new CountDownLatch(1), freshRelease = new CountDownLatch(1);
        AtomicInteger oldRequests = new AtomicInteger(), freshRequests = new AtomicInteger();
        AtomicReference<JSONObject> oldBody = new AtomicReference<>(), freshBody = new AtomicReference<>();
        Field factory = field(NativeApi.class, "connections"); Object previous = factory.get(null);
        factory.set(null, (NativeApi.ConnectionFactory) url -> {
            assertTrue(url.getPath().endsWith("/end"));
            if (url.getPath().contains(OLD)) return new Connection(url, oldEntered, oldRelease, oldRequests, oldBody);
            assertTrue(url.getPath().contains(FRESH)); return new Connection(url, freshEntered, freshRelease, freshRequests, freshBody);
        });
        try {
            NativeRoomCleanup.drain(app);
            assertTrue("An older retry must actually be stalled", oldEntered.await(3, TimeUnit.SECONDS));
            NativeRoomCleanup.enqueue(app, credential, FRESH, "", "fresh-leg");
            assertTrue("The current End must reach transport without releasing the old retry", freshEntered.await(3, TimeUnit.SECONDS));
            assertEquals(1, oldRelease.getCount());
            assertEquals("fresh-leg", freshBody.get().getString("expectedOwnerLegId"));
            String requestId = freshBody.get().getString("requestId");
            for (int i = 0; i < 5; i++) NativeRoomCleanup.enqueue(app, credential, FRESH, "", "fresh-leg");
            // The immediate lane and retry lane share the same per-record claim.
            ((ExecutorService)field(NativeRoomCleanup.class, "FRESH_CONTROL_IO").get(null)).submit(() -> {}).get(3, TimeUnit.SECONDS);
            assertEquals(1, freshRequests.get());
            String freshKey = "end:" + credential.generation + ":" + FRESH + ":fresh-leg:";
            assertEquals(requestId, new JSONObject(queue.getString(freshKey, "{}")).getString("requestId"));
            freshRelease.countDown();
            ((ExecutorService)field(NativeRoomCleanup.class, "FRESH_CONTROL_IO").get(null)).submit(() -> {}).get(3, TimeUnit.SECONDS);
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
            while (queue.contains(freshKey) && System.nanoTime() < deadline) Thread.sleep(5);
            assertFalse("The fresh ACK must remove only its own persisted record", queue.contains(freshKey));
            oldRelease.countDown();
            ((ExecutorService)field(NativeRoomCleanup.class, "CONTROL_IO").get(null)).submit(() -> {}).get(3, TimeUnit.SECONDS);
            assertEquals(1, oldRequests.get()); assertEquals(1, freshRequests.get()); assertTrue(queue.getAll().isEmpty());
        } finally {
            oldRelease.countDown(); freshRelease.countDown();
            ((ExecutorService)field(NativeRoomCleanup.class, "CONTROL_IO").get(null)).submit(() -> {}).get(3, TimeUnit.SECONDS);
            ((ExecutorService)field(NativeRoomCleanup.class, "FRESH_CONTROL_IO").get(null)).submit(() -> {}).get(3, TimeUnit.SECONDS);
            factory.set(null, previous); queue.edit().clear().commit();
        }
    }
    @Test public void actualServiceSilencesAndDispatchesEndBeforePotentiallyBlockingSdkClose() throws Exception {
        Application app = RuntimeEnvironment.getApplication();
        Shadows.shadowOf(app).grantPermissions("com.smarthandicrafts.operatorhub.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION");
        app.getSharedPreferences("native_private", Context.MODE_PRIVATE).edit().clear().commit();
        SharedPreferences queue = app.getSharedPreferences("native_room_cleanup", Context.MODE_PRIVATE); queue.edit().clear().commit();
        NativeStore store = new NativeStore(app); String id = "android_1234567890abcdefghijklmnop", attempt = "f2f388b0-6d16-4c1e-8e5d-df1698c75e15";
        assertTrue(store.enrollIfGeneration(id, id + ".abcdefghijklmnopqrstuvwxyz0123456789", System.currentTimeMillis() + 86400000, 0));
        ServiceController<NativeRoomCallService> controller = Robolectric.buildService(NativeRoomCallService.class).create();
        NativeRoomCallService service = controller.get();
        field(NativeRoomCallService.class, "credential").set(service, store.credential());
        field(NativeRoomCallService.class, "callId").set(service, FRESH);
        field(NativeRoomCallService.class, "requestId").set(service, attempt);
        field(NativeRoomCallService.class, "legId").set(service, "fresh-leg");
        NativeRoomPolicy.Epoch guard = (NativeRoomPolicy.Epoch)field(NativeRoomCallService.class, "guard").get(service);
        long epoch = guard.begin(); field(NativeRoomCallService.class, "epoch").setLong(service, epoch);
        CountDownLatch closeEntered = new CountDownLatch(1), closeRelease = new CountDownLatch(1), postEntered = new CountDownLatch(1);
        AtomicInteger posts = new AtomicInteger(); AtomicBoolean silenced = new AtomicBoolean(); AtomicReference<Throwable> observerFailure = new AtomicReference<>();
        field(NativeRoomCallService.class, "engine").set(service, new NativeRoomMedia() {
            public void connect(JSONObject descriptor) { }
            public void setMuted(boolean value) { }
            public void setSpeaker(boolean value) { }
            public boolean silenceForClose() { silenced.set(true); return true; }
            public void close() {
                assertTrue("Local PCM is silenced before SDK close", silenced.get());
                closeEntered.countDown();
                try { assertTrue(closeRelease.await(5, TimeUnit.SECONDS)); }
                catch (InterruptedException error) { throw new AssertionError(error); }
            }
        });
        Field factory = field(NativeApi.class, "connections"); Object previous = factory.get(null);
        AtomicReference<JSONObject> body = new AtomicReference<>();
        factory.set(null, (NativeApi.ConnectionFactory) url -> new Connection(url, postEntered, new CountDownLatch(0), posts, body));
        Thread observer = new Thread(() -> {
            try {
                assertTrue(closeEntered.await(3, TimeUnit.SECONDS));
                assertFalse("Late media callbacks cannot revive this attempt", guard.current(epoch));
                assertTrue("End must reach transport while SDK close is still blocked", postEntered.await(3, TimeUnit.SECONDS));
                assertEquals("fresh-leg", body.get().getString("expectedOwnerLegId"));
            } catch (Throwable failure) { observerFailure.set(failure); }
            finally { closeRelease.countDown(); }
        });
        try {
            observer.start();
            assertTrue(NativeRoomCallService.commandForAttempt(attempt, "fresh-leg", "end", ""));
            observer.join(4000); assertFalse(observer.isAlive());
            if (observerFailure.get() != null) throw new AssertionError(observerFailure.get());
            assertTrue(NativeRoomCallService.snapshot().optBoolean("closed"));
            ((ExecutorService)field(NativeRoomCleanup.class, "FRESH_CONTROL_IO").get(null)).submit(() -> {}).get(3, TimeUnit.SECONDS);
            ((ExecutorService)field(NativeRoomCleanup.class, "CONTROL_IO").get(null)).submit(() -> {}).get(3, TimeUnit.SECONDS);
            assertEquals(1, posts.get());
        } finally {
            closeRelease.countDown(); observer.join(4000); controller.destroy();
            ((ExecutorService)field(NativeRoomCleanup.class, "CONTROL_IO").get(null)).submit(() -> {}).get(3, TimeUnit.SECONDS);
            ((ExecutorService)field(NativeRoomCleanup.class, "FRESH_CONTROL_IO").get(null)).submit(() -> {}).get(3, TimeUnit.SECONDS);
            factory.set(null, previous); queue.edit().clear().commit();
        }
    }
}
