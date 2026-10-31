package com.smarthandicrafts.operatorhub;

import android.app.Application;
import android.app.Notification;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.service.notification.StatusBarNotification;
import androidx.core.app.NotificationCompat;
import java.util.HashMap;
import java.util.Map;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.shadows.ShadowNotificationManager;
import static org.junit.Assert.*;

/** Fault containment tests, not a claim that a particular physical OEM has this fault. */
@RunWith(RobolectricTestRunner.class) @Config(sdk = 28, application = Application.class)
public class MessageNotificationCompatibilityTest {
    private Application app; private NativeStore store; private NotificationManager manager;
    @Before public void setup() {
        app = RuntimeEnvironment.getApplication(); app.getSharedPreferences("native_private", Context.MODE_PRIVATE).edit().clear().commit();
        manager = app.getSystemService(NotificationManager.class); manager.cancelAll();
        store = new NativeStore(app); String id = "android_1234567890abcdefghijklmnop";
        assertTrue(store.enrollIfGeneration(id, id + ".abcdefghijklmnopqrstuvwxyz0123456789", System.currentTimeMillis() + 86400000, 0));
    }
    private void deliver() {
        long now = System.currentTimeMillis(); Map<String, String> data = new HashMap<>();
        data.put("type", "sh_operator_message"); data.put("channel_id", "73"); data.put("message_id", "801");
        data.put("issued_at_ms", "" + now); data.put("expires_at_ms", "" + (now + 60000)); data.put("message_at_ms", "" + now);
        data.put("hub_url", HubPolicy.HUB_URL + "?channel_id=73&channel=73"); data.put("preview_protocol", "sh-message-preview-v1");
        data.put("sender_name", "Ankit"); data.put("message_preview", "The actual customer message 👋");
        HubMessagingService.dispatchData(app, data);
    }
    private Notification shown() { return Shadows.shadowOf(manager).getNotification("message:73", 300); }
    private void assertStandaloneNamedPreview() {
        Notification n = shown(); assertNotNull("An accepted message must retain a simple visible notification", n);
        assertNull("The compatibility notification cannot depend on grouping", n.getGroup());
        assertEquals("Ankit", n.extras.getCharSequence(Notification.EXTRA_TITLE).toString());
        assertEquals("The actual customer message 👋", n.extras.getCharSequence(Notification.EXTRA_TEXT).toString());
        assertEquals("posted", store.lastMessageOutcome());
        Intent tap = Shadows.shadowOf(n.contentIntent).getSavedIntent(); assertEquals(73, tap.getIntExtra("channel_id", 0));
    }
    @Test @Config(shadows = GroupsUnavailable.class) public void unsupportedGroupedPostingStillShowsActualSenderAndText() {
        deliver(); assertStandaloneNamedPreview();
    }
    @Test @Config(shadows = InventoryUnavailable.class) public void notificationInventoryFailureCannotBlockPostingOrExactChatOpening() {
        deliver(); assertStandaloneNamedPreview();
        MessageAlerts.opened(app, Shadows.shadowOf(shown().contentIntent).getSavedIntent()); assertNull(shown());
    }
    @Test @Config(shadows = InventoryUnavailable.class) public void logoutCancelsKnownMessageTagsWithoutNotificationInventoryAndKeepsCalls() {
        deliver(); assertStandaloneNamedPreview();
        manager.notify("call:unchanged", 101, new NotificationCompat.Builder(app, MessageAlerts.CHANNEL).setSmallIcon(R.drawable.ic_message_notification).setContentTitle("Call").build());
        store.clearEnrollment(); assertNull(shown());
        assertNotNull(Shadows.shadowOf(manager).getNotification("call:unchanged", 101));
    }
    @Test public void postingAfterAnInPlaceUpgradeRemovesOnlyTheOldManualSummary() {
        MessageAlerts.createChannel(app);
        manager.notify(MessageAlerts.SUMMARY, 301, new Notification.Builder(app, MessageAlerts.CHANNEL).setSmallIcon(R.drawable.ic_message_notification)
            .setContentTitle("Old group summary").setGroup("sh-chat-messages").setGroupSummary(true).build());
        manager.notify("call:unchanged", 101, new Notification.Builder(app, MessageAlerts.CHANNEL).setSmallIcon(R.drawable.ic_message_notification).setContentTitle("Call").build());
        deliver(); assertStandaloneNamedPreview();
        assertNull(Shadows.shadowOf(manager).getNotification(MessageAlerts.SUMMARY, 301));
        assertNotNull(Shadows.shadowOf(manager).getNotification("call:unchanged", 101));
    }
    @Test @Config(shadows = SummaryCleanupUnavailable.class) public void legacySummaryCleanupFailureCannotUndoThePostedMessage() {
        deliver(); assertStandaloneNamedPreview();
    }
    @Implements(NotificationManager.class) public static class GroupsUnavailable extends ShadowNotificationManager {
        @Implementation @Override protected void notify(String tag, int id, Notification notification) {
            if (notification.getGroup() != null) throw new IllegalArgumentException("Synthetic grouped notification failure");
            super.notify(tag, id, notification);
        }
    }
    @Implements(NotificationManager.class) public static class InventoryUnavailable extends ShadowNotificationManager {
        @Implementation @Override public StatusBarNotification[] getActiveNotifications() { throw new SecurityException("Synthetic own-inventory failure"); }
    }
    @Implements(NotificationManager.class) public static class SummaryCleanupUnavailable extends ShadowNotificationManager {
        @Implementation @Override protected void cancel(String tag, int id) {
            if (MessageAlerts.SUMMARY.equals(tag) && id == 301) throw new SecurityException("Synthetic summary cleanup failure");
            super.cancel(tag, id);
        }
    }
}
