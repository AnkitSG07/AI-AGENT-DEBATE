package com.smarthandicrafts.operatorhub;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ShortcutInfo;
import android.content.pm.ShortcutManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.service.notification.StatusBarNotification;
import androidx.core.content.pm.ShortcutManagerCompat;
import java.util.ArrayList;
import java.util.Map;

/** Standalone sender/text alerts: posting never depends on inventory, grouping or launcher services. */
public final class MessageAlerts {
    static final String CHANNEL = "sh_messages_v1", SUMMARY = "message:summary";
    static final String GENERATION = "sh_message_generation", LATEST_ID = "sh_message_latest_id";
    private static final int ID = 300;
    private static final Object LOCK = new Object();

    static void createChannel(Context context) {
        NotificationManager nm = manager(context);
        // Preserve the user's existing sound/privacy/importance choices.
        if (nm != null) nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Customer messages", NotificationManager.IMPORTANCE_HIGH));
    }
    public static void show(Context context, int channel, boolean test) {
        if (!test) { show(context, channel, 0, java.util.Collections.emptyMap()); return; }
        NotificationManager nm = manager(context); if (!permitted(context, nm)) return;
        nm.createNotificationChannel(new NotificationChannel("sh_test_v1", "Notification delivery tests", NotificationManager.IMPORTANCE_DEFAULT));
        PendingIntent open = PendingIntent.getActivity(context, 3, new Intent(context, SettingsActivity.class).setData(Uri.parse("shoperator://notification-test")),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        nm.notify("firebase-test", ID, new Notification.Builder(context, "sh_test_v1").setSmallIcon(R.drawable.ic_message_notification)
            .setContentTitle("Firebase test received").setContentText("SH Chat received the backend's push notification.")
            .setCategory(Notification.CATEGORY_MESSAGE).setVisibility(Notification.VISIBILITY_PRIVATE).setAutoCancel(true).setContentIntent(open).build());
    }
    public static void show(Context context, int channel, long messageId, Map<String, String> data) {
        show(context, channel, messageId, data, new NativeStore(context).credential());
    }
    static boolean show(Context context, int channel, long messageId, Map<String, String> data, DeviceLeasePolicy.Credential credential) {
        return post(context, channel, messageId, data, credential, true);
    }
    /** Final fallback is native title/text, without even BigTextStyle. */
    static boolean fallback(Context context, int channel, long messageId, Map<String, String> data, DeviceLeasePolicy.Credential credential) {
        return post(context, channel, messageId, data, credential, false);
    }
    private static boolean post(Context context, int channel, long messageId, Map<String, String> data,
                                DeviceLeasePolicy.Credential credential, boolean expanded) {
        if (channel <= 0 || !DeviceLeasePolicy.valid(credential, System.currentTimeMillis())) return false;
        NotificationManager nm = manager(context); if (!permitted(context, nm)) return false;
        createChannel(context);
        NotificationChannel systemChannel = nm.getNotificationChannel(CHANNEL);
        if (systemChannel == null || systemChannel.getImportance() == NotificationManager.IMPORTANCE_NONE) return false;
        MessageNotificationData preview = MessageNotificationData.from(data, System.currentTimeMillis());
        String title = preview.group ? preview.conversation : preview.sender;
        String text = preview.group ? preview.sender + ": " + preview.preview : preview.preview;
        NativeStore store = new NativeStore(context);
        synchronized (LOCK) {
            return store.withMessageCredential(credential, () -> {
                if (messageId > 0 && store.postedMessageId(channel, credential) >= messageId) return;
                Intent target = openIntent(context, channel, credential.generation).putExtra(LATEST_ID, messageId);
                PendingIntent open = PendingIntent.getActivity(context, 3, target, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                PendingIntent dismiss = PendingIntent.getBroadcast(context, 4, new Intent(context, MessageDismissReceiver.class).setData(target.getData())
                    .putExtra("channel_id", channel).putExtra(GENERATION, credential.generation).putExtra(LATEST_ID, messageId),
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                Bundle extras = new Bundle(); extras.putLong(GENERATION, credential.generation); extras.putLong(LATEST_ID, messageId);
                Notification.Builder builder = new Notification.Builder(context, CHANNEL).setSmallIcon(R.drawable.ic_message_notification)
                    .setContentTitle(title).setContentText(text).setColor(NativeBrand.GREEN).setWhen(preview.at).setShowWhen(true)
                    .setCategory(Notification.CATEGORY_MESSAGE).setVisibility(Notification.VISIBILITY_PRIVATE).setPublicVersion(publicNotification(context))
                    .addExtras(extras).setAutoCancel(true).setContentIntent(open).setDeleteIntent(dismiss);
                if (expanded) builder.setStyle(new Notification.BigTextStyle().bigText(text));
                Notification notification = builder.build();
                // Save exact cleanup tags BEFORE posting; OS inventory is optional.
                for (int old : store.rememberMessageNotification(channel, credential)) nm.cancel(tag(old), ID);
                nm.notify(tag(channel), ID, notification);
                store.messageNotificationPosted(channel, messageId, credential);
                // An in-place upgrade can retain the old manual group parent.
                // Clear only that legacy summary after the standalone alert is safe.
                try { nm.cancel(SUMMARY, 301); } catch (RuntimeException ignored) { }
            });
        }
    }
    static Intent openIntent(Context context, int channel, long generation) {
        return new Intent(context, MainActivity.class).setData(Uri.parse("shoperator://message/" + generation + "/" + channel))
            .putExtra("channel_id", channel).putExtra(GENERATION, generation)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    }
    static void opened(Context context, Intent intent) {
        int channel = intent.getIntExtra("channel_id", 0); long generation = intent.getLongExtra(GENERATION, -1);
        if (channel <= 0 || generation < 0 || !openIntent(context, channel, generation).getData().equals(intent.getData())) return;
        NativeStore store = new NativeStore(context); DeviceLeasePolicy.Credential credential = store.credential();
        if (credential.generation != generation) return;
        synchronized (LOCK) {
            store.withMessageCredential(credential, () -> {
                if (store.postedMessageId(channel, credential) > intent.getLongExtra(LATEST_ID, 0)) return;
                NotificationManager nm = manager(context); if (nm != null) nm.cancel(tag(channel), ID);
                store.forgetMessageNotification(channel, credential);
            });
        }
    }
    static void dismissed(Context context, Intent intent) { opened(context, intent); }
    // No LOCK or NativeStore access: invoked while the enrollment fence is held.
    static void clearAll(Context context, int[] knownChannels) {
        NotificationManager nm = null;
        try { nm = manager(context); } catch (RuntimeException ignored) { }
        if (nm != null) {
            for (int channel : knownChannels) try { nm.cancel(tag(channel), ID); } catch (RuntimeException ignored) { }
            try { nm.cancel(SUMMARY, 301); } catch (RuntimeException ignored) { }
            // Best-effort migration cleanup of alerts from earlier APK versions.
            try { for (StatusBarNotification row : nm.getActiveNotifications())
                if (row.getTag() != null && row.getTag().startsWith("message:")) nm.cancel(row.getTag(), row.getId());
            } catch (RuntimeException ignored) { }
        }
        try {
            ShortcutManager shortcuts = context.getSystemService(ShortcutManager.class);
            if (shortcuts == null) return;
            ArrayList<String> ids = new ArrayList<>();
            for (ShortcutInfo shortcut : shortcuts.getDynamicShortcuts()) if (shortcut.getId().startsWith("sh-chat-")) ids.add(shortcut.getId());
            for (ShortcutInfo shortcut : shortcuts.getPinnedShortcuts()) if (shortcut.getId().startsWith("sh-chat-")) ids.add(shortcut.getId());
            ShortcutManagerCompat.removeLongLivedShortcuts(context, ids);
        } catch (RuntimeException ignored) { }
    }
    private static Notification publicNotification(Context context) {
        return new Notification.Builder(context, CHANNEL).setSmallIcon(R.drawable.ic_message_notification)
            .setContentTitle("SH Chat").setContentText("New message").setVisibility(Notification.VISIBILITY_PUBLIC).build();
    }
    static String tag(int channel) { return "message:" + channel; }
    private static NotificationManager manager(Context context) { return context.getSystemService(NotificationManager.class); }
    static void delivery(String code) { android.util.Log.i("SHMessageDelivery", code); }
    static String blockingReason(Context context) {
        NotificationManager nm = manager(context); if (!permitted(context, nm)) return "blocked_permission";
        NotificationChannel channel = nm.getNotificationChannel(CHANNEL);
        return channel != null && channel.getImportance() == NotificationManager.IMPORTANCE_NONE ? "blocked_channel" : "not_posted";
    }
    private static boolean permitted(Context context, NotificationManager manager) {
        return manager != null && (Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
            && manager.areNotificationsEnabled();
    }
    private MessageAlerts() { }
}
