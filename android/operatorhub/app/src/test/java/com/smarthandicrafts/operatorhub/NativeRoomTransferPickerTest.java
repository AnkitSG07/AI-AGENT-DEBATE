package com.smarthandicrafts.operatorhub;

import android.app.Application;
import android.app.AlertDialog;
import android.content.Intent;
import android.os.Looper;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.android.controller.ServiceController;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executor;
import static org.junit.Assert.*;

@RunWith(org.robolectric.RobolectricTestRunner.class)
@Config(sdk = 28, application = Application.class)
public class NativeRoomTransferPickerTest {
    private static final String CALL = "out_0123456789abcdef0123456789abcdef";
    private static final String ATTEMPT = "de3cc9b1-d0f7-4c06-a677-2c99cf8ef319";
    private ActivityController<NativeRoomCallActivity> activityController;
    private ServiceController<NativeRoomCallService> serviceController;
    private NativeRoomCallActivity activity;
    private NativeRoomCallService service;
    private NativeStore store;
    private final List<Runnable> pending = new ArrayList<>();
    private static void set(Object object, String name, Object value) throws Exception {
        Field field = object.getClass().getDeclaredField(name); field.setAccessible(true); field.set(object, value);
    }
    private static Object get(Object object, String name) throws Exception {
        Field field = object.getClass().getDeclaredField(name); field.setAccessible(true); return field.get(object);
    }
    private void choose() throws Exception { Method m = NativeRoomCallActivity.class.getDeclaredMethod("chooseTransfer"); m.setAccessible(true); m.invoke(activity); }
    private void render() throws Exception { Method m = NativeRoomCallActivity.class.getDeclaredMethod("render", JSONObject.class); m.setAccessible(true); m.invoke(activity, NativeRoomCallService.snapshot()); }
    private AlertDialog dialog() throws Exception { return (AlertDialog)get(activity, "transferDialog"); }
    private JSONObject devices() throws Exception {
        return new JSONObject().put("ok", true).put("devices", new JSONArray().put(new JSONObject()
            .put("deviceId", "android_target_device_123456789").put("deviceLabel", "Other phone")
            .put("available", true).put("nativeBuild", 20).put("mediaProtocol", NativeRoomPolicy.PROTOCOL)));
    }
    @Before public void setup() throws Exception {
        Application app = RuntimeEnvironment.getApplication();
        Shadows.shadowOf(app).grantPermissions("com.smarthandicrafts.operatorhub.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION");
        store = new NativeStore(app); String id = "android_1234567890abcdefghijklmnop";
        store.enrollIfGeneration(id, id + ".abcdefghijklmnopqrstuvwxyz0123456789", System.currentTimeMillis() + 1000000, store.credential().generation);
        store.roomCapabilitiesIfMatches(store.credential(), true, true, System.currentTimeMillis());
        activityController = Robolectric.buildActivity(NativeRoomCallActivity.class,
            new Intent(app, NativeRoomCallActivity.class).putExtra("room_action", "dial")).setup(); activity = activityController.get();
        set(activity, "directoryIo", (Executor)pending::add);
        set(activity, "callApi", (NativeRoomCleanupProcessor.Requester)(path, method, body, bearer) -> devices());
        serviceController = Robolectric.buildService(NativeRoomCallService.class).create(); service = serviceController.get();
        set(service, "credential", store.credential()); set(service, "callId", CALL); set(service, "requestId", ATTEMPT);
        set(service, "legId", "leg-a"); set(service, "readyCommitted", true); set(service, "state", "connected");
        NativeRoomPolicy.Epoch guard = (NativeRoomPolicy.Epoch)get(service, "guard"); set(service, "epoch", guard.begin());
        NativeRoomCallHealth health = (NativeRoomCallHealth)get(service, "health"); health.start(1); health.evidence(); health.connected(true, 2);
        set(activity, "callId", CALL); set(activity, "expectedAttemptId", ATTEMPT);
        render();
    }
    @After public void teardown() { if (activityController != null) activityController.pause().stop().destroy(); if (serviceController != null) serviceController.destroy(); Shadows.shadowOf(Looper.getMainLooper()).idle(); }
    @Test public void opensImmediatelyWhileDiscoveryIsBlockedAndCoalescesRepeatedTaps() throws Exception {
        assertEquals(1, pending.size()); choose(); AlertDialog first = dialog();
        assertNotNull(first); assertTrue(first.isShowing());
        assertEquals("Loading registered phones…", first.getListView().getAdapter().getItem(0));
        assertFalse(first.getListView().getAdapter().isEnabled(0));
        choose(); render(); assertSame(first, dialog()); assertEquals(1, pending.size());
        pending.remove(0).run(); Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertEquals("Other phone", first.getListView().getAdapter().getItem(0)); assertTrue(first.getListView().getAdapter().isEnabled(0));
        first.dismiss(); choose(); assertEquals(0, pending.size());
        assertEquals("Other phone", dialog().getListView().getAdapter().getItem(0));
    }
    @Test public void oldOwnerResponseCannotFillOrReopenTheNewOwnersPicker() throws Exception {
        choose(); AlertDialog old = dialog(); Runnable oldRequest = pending.remove(0);
        set(service, "legId", "leg-b"); render();
        assertFalse(old.isShowing()); choose(); AlertDialog next = dialog();
        oldRequest.run(); Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertEquals("Loading registered phones…", next.getListView().getAdapter().getItem(0));
        assertEquals(1, pending.size()); pending.remove(0).run(); Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertEquals("Other phone", next.getListView().getAdapter().getItem(0));
    }
    @Test public void cancelledPickerStaysClosedWhenThePrefetchCompletes() throws Exception {
        choose(); AlertDialog old = dialog(); old.dismiss(); pending.remove(0).run(); Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertNull(dialog()); assertFalse(old.isShowing()); choose(); assertEquals("Other phone", dialog().getListView().getAdapter().getItem(0));
    }
    @Test public void failedPrefetchShowsRetryableErrorWithoutEndingAudio() throws Exception {
        set(activity, "callApi", (NativeRoomCleanupProcessor.Requester)(path, method, body, bearer) -> { throw new java.io.IOException("synthetic unavailable"); });
        choose(); pending.remove(0).run(); Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertTrue(dialog().getListView().getAdapter().getItem(0).toString().startsWith("Could not load phones"));
        assertFalse(NativeRoomCallService.snapshot().optBoolean("closed"));
        dialog().dismiss(); choose(); assertEquals(1, pending.size());
    }
}
