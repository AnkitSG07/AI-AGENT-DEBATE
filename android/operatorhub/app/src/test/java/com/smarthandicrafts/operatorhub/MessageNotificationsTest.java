package com.smarthandicrafts.operatorhub;

import android.app.Application;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import androidx.core.app.NotificationCompat;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implements;
import org.robolectric.annotation.Implementation;
import org.robolectric.shadows.ShadowNotificationManager;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class) @Config(sdk = 28, application = Application.class)
public class MessageNotificationsTest {
    private Application app;
    private NotificationManager manager;
    private NativeStore store;
    @Before public void setup() {
        app = RuntimeEnvironment.getApplication();
        app.getSharedPreferences("native_private", Context.MODE_PRIVATE).edit().clear().commit();
        manager = app.getSystemService(NotificationManager.class); manager.cancelAll();
        store = new NativeStore(app); enroll();
    }
    private void enroll() {
        String id = "android_1234567890abcdefghijklmnop";
        assertTrue(store.enrollIfGeneration(id, id + ".abcdefghijklmnopqrstuvwxyz0123456789",
            System.currentTimeMillis() + 86400000, store.credential().generation));
    }
    private Map<String, String> data(int channel, long message, String name, String text) {
        long now = System.currentTimeMillis();
        Map<String, String> result = new HashMap<>();
        result.put("type", "sh_operator_message"); result.put("channel_id", "" + channel); result.put("message_id", "" + message);
        result.put("issued_at_ms", "" + now); result.put("expires_at_ms", "" + (now + 60000)); result.put("message_at_ms", "" + now);
        result.put("hub_url", HubPolicy.HUB_URL + "?channel_id=" + channel + "&channel=" + channel);
        result.put("preview_protocol", "sh-message-preview-v1"); result.put("sender_name", name);
        result.put("conversation_name", name); result.put("message_preview", text); result.put("group_conversation", "false");
        return result;
    }
    private void post(int channel, long message, String name, String text) { HubMessagingService.dispatchData(app, data(channel, message, name, text)); }
    private Notification notification(int channel) { return Shadows.shadowOf(manager).getNotification(MessageAlerts.tag(channel), 300); }
    private Notification summary() { return Shadows.shadowOf(manager).getNotification(MessageAlerts.SUMMARY, 301); }
    private NotificationCompat.MessagingStyle style(int channel) { return NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(notification(channel)); }

    @Test public void senderTextPrivacyAndExactChatSurviveAndroidNotificationSerialization() {
        post(73, 801, "Ankit Garia", "Is the 3W kit available? 👋");
        Notification n = notification(73); assertNotNull(n);
        NotificationCompat.MessagingStyle style = style(73); assertNotNull(style);
        assertFalse(style.isGroupConversation()); assertEquals(1, style.getMessages().size());
        assertEquals("Ankit Garia", style.getMessages().get(0).getPerson().getName().toString());
        assertEquals("Is the 3W kit available? 👋", style.getMessages().get(0).getText().toString());
        assertEquals("Ankit Garia", n.extras.getCharSequence(Notification.EXTRA_TITLE).toString());
        assertEquals(Notification.VISIBILITY_PRIVATE, n.visibility); assertNotNull(n.publicVersion);
        assertEquals("New message", n.publicVersion.extras.getCharSequence(Notification.EXTRA_TEXT).toString());
        assertNull(n.fullScreenIntent); assertNotNull(summary());
        assertEquals(MessageAlerts.GROUP, n.getGroup()); assertEquals(n.getGroup(), summary().getGroup());
        assertTrue((summary().flags & Notification.FLAG_GROUP_SUMMARY) != 0);
        assertEquals(73, Shadows.shadowOf(summary().contentIntent).getSavedIntent().getIntExtra("channel_id", 0));
        Intent tap = Shadows.shadowOf(n.contentIntent).getSavedIntent();
        assertEquals(73, tap.getIntExtra("channel_id", 0)); assertEquals(MainActivity.class.getName(), tap.getComponent().getClassName());
        assertEquals("shoperator://message/" + store.credential().generation + "/73", tap.getDataString());
        assertEquals(801, tap.getLongExtra(MessageAlerts.LATEST_ID, 0));
    }
    @Test public void separateChatsKeepSeparatePendingIntentsAndCreateAnInboxSummary() {
        post(73, 801, "Ankit", "First order"); post(74, 802, "Vibhu", "Second order");
        Intent first = Shadows.shadowOf(notification(73).contentIntent).getSavedIntent();
        Intent second = Shadows.shadowOf(notification(74).contentIntent).getSavedIntent();
        assertNotEquals(first.getData(), second.getData());
        assertEquals(73, first.getIntExtra("channel_id", 0)); assertEquals(74, second.getIntExtra("channel_id", 0));
        assertNotNull(summary()); assertTrue((summary().flags & Notification.FLAG_GROUP_SUMMARY) != 0);
        assertEquals(2, summary().number); assertEquals(3, manager.getActiveNotifications().length);
    }
    @Test public void repeatedDeliveryDoesNotDuplicateAndExpandableHistoryIsBounded() {
        for (int i = 1; i <= 12; i++) post(73, 800 + i, "Ankit", "Order " + i);
        post(73, 812, "Ankit", "Duplicate callback");
        List<NotificationCompat.MessagingStyle.Message> messages = style(73).getMessages();
        assertEquals(8, messages.size()); assertEquals("Order 5", messages.get(0).getText().toString());
        assertEquals("Order 12", messages.get(7).getText().toString()); assertEquals(12, notification(73).number);
    }
    @Test public void freshOutOfOrderMessagesAppearOnceWithoutReplacingLatestText() {
        Map<String, String> newest = data(73, 1002, "Ankit", "Newer message");
        Map<String, String> older = data(73, 1001, "Ankit", "Earlier message");
        older.put("message_at_ms", "" + (System.currentTimeMillis() - 1000));
        HubMessagingService.dispatchData(app, newest); HubMessagingService.dispatchData(app, older); HubMessagingService.dispatchData(app, older);
        List<NotificationCompat.MessagingStyle.Message> messages = style(73).getMessages();
        assertEquals(2, messages.size()); assertEquals("Earlier message", messages.get(0).getText().toString());
        assertEquals("Newer message", messages.get(1).getText().toString()); assertEquals(2, notification(73).number);
        assertEquals(1002, notification(73).extras.getLong(MessageAlerts.LATEST_ID));
    }
    @Test public void tappingOneConversationKeepsOtherChatsAndAnOlderTapCannotClearANewerMessage() {
        post(73, 801, "Ankit", "First"); post(74, 802, "Vibhu", "Other chat");
        Intent oldTap = new Intent(Shadows.shadowOf(notification(73).contentIntent).getSavedIntent());
        post(73, 803, "Ankit", "New message arrived during tap");
        MessageAlerts.opened(app, oldTap); assertNotNull(notification(73));
        Intent currentTap = Shadows.shadowOf(notification(73).contentIntent).getSavedIntent();
        MessageAlerts.opened(app, currentTap); assertNull(notification(73)); assertNotNull(notification(74)); assertNotNull(summary());
        assertEquals(74, Shadows.shadowOf(summary().contentIntent).getSavedIntent().getIntExtra("channel_id", 0));
    }
    @Test public void groupNotificationUsesConversationTitleAndPreservesActualSender() {
        Map<String, String> incoming = data(73, 801, "Ankit", "Hello team");
        incoming.put("group_conversation", "true"); incoming.put("conversation_name", "Sales team");
        HubMessagingService.dispatchData(app, incoming);
        assertTrue(style(73).isGroupConversation()); assertEquals("Sales team", style(73).getConversationTitle().toString());
        assertEquals("Ankit", style(73).getMessages().get(0).getPerson().getName().toString());
    }
    @Test public void staleMalformedWrongHubAndUnenrolledEnvelopesCannotDisplayPreviews() {
        Map<String, String> incoming = data(73, 801, "Private sender", "Private message");
        incoming.put("hub_url", "https://untrusted.example/?channel_id=73"); HubMessagingService.dispatchData(app, incoming);
        incoming = data(73, 801, "Private sender", "Private message"); incoming.put("expires_at_ms", "" + (System.currentTimeMillis() - 1));
        HubMessagingService.dispatchData(app, incoming);
        incoming = data(73, 801, "Private sender", "Private message"); incoming.put("message_id", "not-an-id"); HubMessagingService.dispatchData(app, incoming);
        store.clearEnrollment(); HubMessagingService.dispatchData(app, data(73, 801, "Private sender", "Private message"));
        assertEquals(0, manager.getActiveNotifications().length);
    }
    @Test public void logoutClearsMessagePreviewsAndLateCallbacksCannotRecreateThem() {
        post(73, 801, "Ankit", "Private message"); post(74, 802, "Vibhu", "Other private message");
        DeviceLeasePolicy.Credential old = store.credential();
        Notification unrelated = new NotificationCompat.Builder(app, MessageAlerts.CHANNEL).setSmallIcon(R.drawable.ic_message_notification).setContentTitle("Call").build();
        manager.notify("call:unchanged", 101, unrelated);
        store.clearEnrollment(); assertNull(notification(73)); assertNull(notification(74)); assertNull(summary());
        assertNotNull(Shadows.shadowOf(manager).getNotification("call:unchanged", 101));
        enroll();
        MessageAlerts.show(app, 73, 803, data(73, 803, "Old account", "Late callback"), old);
        assertNull(notification(73)); assertFalse(store.receiveMessage(73, 803, System.currentTimeMillis(), System.currentTimeMillis() + 60000, old));
        post(73, 801, "New account", "Same channel and ID can be new here"); assertNotNull(notification(73));
        assertEquals("New account", style(73).getMessages().get(0).getPerson().getName().toString());
    }
    @Test public void migrationPreservesOldDeduplicationFloorWhileNewChatsAllowReordering() {
        SharedPreferences prefs = app.getSharedPreferences("native_private", Context.MODE_PRIVATE);
        prefs.edit().putLong("message:73", 900).commit();
        post(73, 900, "Ankit", "Already shown by R14"); assertNull(notification(73));
        post(73, 902, "Ankit", "New after upgrade"); post(73, 899, "Ankit", "Old duplicate"); post(73, 901, "Ankit", "Fresh reordered message");
        assertEquals(2, style(73).getMessages().size()); assertEquals(2, notification(73).number);
    }
    @Test public void legacyEnvelopeHasSafeFallbackAndDoesNotInventCustomerContent() {
        Map<String, String> incoming = data(73, 801, "Unversioned name", "Unversioned text"); incoming.remove("preview_protocol");
        HubMessagingService.dispatchData(app, incoming);
        assertEquals("Customer", style(73).getMessages().get(0).getPerson().getName().toString());
        assertEquals("New message", style(73).getMessages().get(0).getText().toString());
    }
    @Test @Config(sdk = 26) public void androidEightRetainsReadableMessagingStyleAndTapRouting() {
        post(73, 801, "Ankit", "Android 8 message"); assertNotNull(notification(73));
        assertEquals("Android 8 message", style(73).getMessages().get(0).getText().toString());
        assertEquals(73, Shadows.shadowOf(notification(73).contentIntent).getSavedIntent().getIntExtra("channel_id", 0));
    }
    @Test @Config(sdk = 35) public void androidFifteenRequiresPermissionAndUsesImmutableTapIntents() {
        Shadows.shadowOf(app).denyPermissions(android.Manifest.permission.POST_NOTIFICATIONS);
        post(73, 801, "Ankit", "Permission denied"); assertNull(notification(73));
        Shadows.shadowOf(app).grantPermissions(android.Manifest.permission.POST_NOTIFICATIONS);
        post(73, 802, "Ankit", "Permission granted"); assertNotNull(notification(73)); assertTrue(notification(73).contentIntent.isImmutable());
        assertTrue(notification(73).deleteIntent.isImmutable());
    }
    @Test public void channelUpdatePreservesTheUsersExistingImportanceChoice() {
        manager.createNotificationChannel(new NotificationChannel(MessageAlerts.CHANNEL, "Existing customer messages", NotificationManager.IMPORTANCE_LOW));
        post(73, 801, "Ankit", "Retain user settings");
        assertEquals(NotificationManager.IMPORTANCE_LOW, manager.getNotificationChannel(MessageAlerts.CHANNEL).getImportance());
        assertNotNull(notification(73));
    }
    @Test public void boundedReplayStateRejectsEvictedDuplicatesAndInvalidTimeRanges() {
        long now = System.currentTimeMillis();
        for (int i = 1; i <= 40; i++) assertTrue(store.receiveMessage(73, i, now, now + 60000));
        assertFalse(store.receiveMessage(73, 1, now, now + 60000));
        assertFalse(store.receiveMessage(74, 1, now + 10000, now + 5000));
        assertFalse(store.receiveMessage(74, 1, now, now + 300001));
        for (int i = 74; i <= 204; i++) assertTrue(store.receiveMessage(i, i, now, now + 60000));
        long count = app.getSharedPreferences("native_private", Context.MODE_PRIVATE).getAll().keySet().stream().filter(key -> key.startsWith("message:")).count();
        assertEquals(128, count);
    }
    @Test public void dismissalUpdatesSummaryAndConversationLimitKeepsLatestChats() {
        String sameTimestamp = "" + System.currentTimeMillis();
        for (int i = 1; i <= 26; i++) {
            Map<String, String> incoming = data(i, 800 + i, "Customer " + i, "Message " + i);
            incoming.put("message_at_ms", sameTimestamp); HubMessagingService.dispatchData(app, incoming);
        }
        assertEquals(25, manager.getActiveNotifications().length); // 24 chats + one group summary
        assertNull(notification(1)); assertNotNull(notification(26));
        for (int i = 3; i < 26; i++) manager.cancel(MessageAlerts.tag(i), 300);
        new MessageDismissReceiver().onReceive(app, new Intent().putExtra(MessageAlerts.GENERATION, store.credential().generation));
        assertNotNull(summary()); assertNotNull(notification(26));
        assertEquals(26, Shadows.shadowOf(summary().contentIntent).getSavedIntent().getIntExtra("channel_id", 0));
        manager.cancel(MessageAlerts.tag(26), 300);
        new MessageDismissReceiver().onReceive(app, new Intent().putExtra(MessageAlerts.GENERATION, store.credential().generation));
        assertNull(summary());
    }

    @Test @Config(sdk = 35) public void aMessageNotPostedForDeniedPermissionCanBeRetriedAfterPermissionIsGranted() {
        Map<String, String> incoming = data(73, 801, "Ankit", "Please show after permission");
        Shadows.shadowOf(app).denyPermissions(android.Manifest.permission.POST_NOTIFICATIONS);
        HubMessagingService.dispatchData(app, incoming); assertNull(notification(73));
        Shadows.shadowOf(app).grantPermissions(android.Manifest.permission.POST_NOTIFICATIONS);
        HubMessagingService.dispatchData(app, incoming); assertNotNull(notification(73)); assertNotNull(summary());
        assertEquals(1, notification(73).number);
    }
    @Test public void rollbackRemovesOnlyTheUnpostedIdAndCannotChangeAReplacementEnrollment() {
        long now = System.currentTimeMillis(); DeviceLeasePolicy.Credential credential = store.credential();
        assertTrue(store.receiveMessage(73, 801, now, now + 60000, credential));
        assertTrue(store.receiveMessage(73, 802, now, now + 60000, credential));
        store.unpostedMessage(73, 801, credential);
        assertTrue(store.receiveMessage(73, 801, now, now + 60000, credential));
        assertFalse(store.receiveMessage(73, 802, now, now + 60000, credential));
        store.clearEnrollment(); enroll(); assertTrue(store.receiveMessage(73, 801, now, now + 60000));
        store.unpostedMessage(73, 801, credential);
        assertFalse(store.receiveMessage(73, 801, now, now + 60000));
    }
    @Test public void rollbackAfterAFullReplayWindowCannotReadmitPreviouslyEvictedDuplicates() {
        long now = System.currentTimeMillis(); DeviceLeasePolicy.Credential credential = store.credential();
        for (int i = 1; i <= 33; i++) assertTrue(store.receiveMessage(73, i, now, now + 60000));
        store.unpostedMessage(73, 33, credential);
        assertFalse(store.receiveMessage(73, 1, now, now + 60000));
        assertTrue(store.receiveMessage(73, 33, now, now + 60000));
        assertFalse(store.receiveMessage(73, 32, now, now + 60000));
    }
    @Test public void simpleFallbackRetainsActualPreviewExactChatAndAValidGroupSummary() {
        assertTrue(MessageAlerts.fallback(app, 73, 801, data(73, 801, "Ankit", "Readable fallback"), store.credential()));
        assertEquals("Ankit", notification(73).extras.getCharSequence(Notification.EXTRA_TITLE).toString());
        assertEquals("Readable fallback", notification(73).extras.getCharSequence(Notification.EXTRA_TEXT).toString());
        assertNotNull(summary());
        Intent tap = Shadows.shadowOf(summary().contentIntent).getSavedIntent();
        assertEquals(73, tap.getIntExtra("channel_id", 0)); MessageAlerts.opened(app, tap);
        assertNull(notification(73)); assertNull(summary());
    }
    @Test @Config(shadows = RichStyleFailure.class) public void anActualRichPostFailureFallsBackInsteadOfSilentlyLosingTheMessage() {
        post(73, 801, "Ankit", "Fallback survives a style failure");
        Notification shown = notification(73); assertNotNull(shown); assertNotNull(summary());
        assertEquals("Ankit", shown.extras.getCharSequence(Notification.EXTRA_TITLE).toString());
        assertEquals("Fallback survives a style failure", shown.extras.getCharSequence(Notification.EXTRA_TEXT).toString());
        assertTrue(shown.extras.getString(Notification.EXTRA_TEMPLATE).contains("BigTextStyle"));
        assertFalse(store.receiveMessage(73, 801, System.currentTimeMillis(), System.currentTimeMillis() + 60000));
    }
    @Implements(NotificationManager.class) public static class RichStyleFailure extends ShadowNotificationManager {
        @Implementation @Override protected void notify(String tag, int id, Notification notification) {
            if (notification.extras.getString(Notification.EXTRA_TEMPLATE, "").contains("MessagingStyle")) throw new IllegalArgumentException("Synthetic rich-style failure");
            super.notify(tag, id, notification);
        }
    }
}
