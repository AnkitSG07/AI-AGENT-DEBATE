package com.smarthandicrafts.operatorhub;

import android.app.Application;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import java.util.List;
import java.util.stream.Collectors;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class) @Config(sdk = {28, 35}, application = Application.class)
public class NativeRoomIncomingEventTest {
    @org.junit.Rule public final OfflineNativeApiRule offlineApi = new OfflineNativeApiRule();
    private static final String CALL = "out_0123456789abcdef0123456789abcdef";
    private Application app;
    private NotificationManager manager;
    @Before public void setup() {
        app = RuntimeEnvironment.getApplication();
        app.getSharedPreferences("native_private", Context.MODE_PRIVATE).edit().clear().commit();
        Shadows.shadowOf(app).grantPermissions(android.Manifest.permission.POST_NOTIFICATIONS);
        manager = app.getSystemService(NotificationManager.class); manager.cancelAll();
        CallAlerts.createChannels(app);
    }
    private List<Intent> hints() {
        return Shadows.shadowOf(app).getBroadcastIntents().stream()
            .filter(intent -> NativeRoomNotifications.CHANGED.equals(intent.getAction())).collect(Collectors.toList());
    }
    private void assertIncomingHint(String transfer) {
        int before = hints().size();
        NativeRoomNotifications.show(app, CALL, transfer, System.currentTimeMillis() + 60000);
        assertNotNull(Shadows.shadowOf(manager).getNotification(NativeRoomNotifications.key(CALL, transfer), 101));
        List<Intent> hints = hints(); assertEquals(before + 1, hints.size());
        Intent hint = hints.get(before);
        assertEquals(app.getPackageName(), hint.getPackage());
        assertEquals(CALL, hint.getStringExtra("call_id"));
        assertEquals(transfer, hint.getStringExtra("transfer_id"));
        assertEquals("incoming", hint.getStringExtra("event"));
        assertFalse(hint.getBooleanExtra("alert_terminal", false));
        assertFalse(hint.hasExtra("snapshot"));
        assertEquals(new NativeStore(app).credential().generation, hint.getLongExtra("enrollment_generation", -1));
        assertEquals(5, hint.getExtras().size());
    }
    @Test public void incomingCallAndTransferProduceOneScopedHintPerExactIdentity() {
        assertIncomingHint(""); assertIncomingHint("tr_destination_0123456789");
    }
    @Test @Config(sdk = 35) public void deniedNotificationPermissionStillWakesForegroundInbox() {
        Shadows.shadowOf(app).denyPermissions(android.Manifest.permission.POST_NOTIFICATIONS);
        NativeRoomNotifications.show(app, CALL, "", System.currentTimeMillis() + 60000);
        assertNull(Shadows.shadowOf(manager).getNotification(NativeRoomNotifications.key(CALL, ""), 101));
        assertEquals(1, hints().size()); Intent hint = hints().get(0);
        assertEquals("incoming", hint.getStringExtra("event"));
        assertEquals(app.getPackageName(), hint.getPackage());
        assertEquals(new NativeStore(app).credential().generation, hint.getLongExtra("enrollment_generation", -1));
    }
    @Test public void cancellationRemainsDistinctFromAnIncomingHint() {
        NativeRoomNotifications.cancelTerminal(app, CALL, "tr_destination_0123456789");
        assertEquals(1, hints().size()); Intent hint = hints().get(0);
        assertTrue(hint.getBooleanExtra("alert_terminal", false));
        assertEquals("ended", hint.getStringExtra("event"));
        assertEquals(new NativeStore(app).credential().generation, hint.getLongExtra("enrollment_generation", -1));
    }
}
