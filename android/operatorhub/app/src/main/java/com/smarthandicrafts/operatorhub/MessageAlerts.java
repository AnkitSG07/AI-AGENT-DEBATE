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
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.service.notification.StatusBarNotification;
import androidx.core.app.NotificationCompat;
import androidx.core.app.Person;
import androidx.core.content.pm.ShortcutInfoCompat;
import androidx.core.content.pm.ShortcutManagerCompat;
import androidx.core.graphics.drawable.IconCompat;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;

/** Actual sender/text conversation notifications. Preview history stays with Android's notification service. */
public final class MessageAlerts {
    static final String CHANNEL = "sh_messages_v1", GROUP = "sh-chat-messages", SUMMARY = "message:summary";
    static final String GENERATION = "sh_message_generation", LATEST_ID = "sh_message_latest_id", MESSAGE_ID = "sh_message_id";
    private static final String COUNT = "sh_message_count", TITLE = "sh_message_title", PREVIEW = "sh_message_preview";
    private static final int ID = 300, SUMMARY_ID = 301, HISTORY_LIMIT = 8, CHAT_LIMIT = 24;
    private static final Object LOCK = new Object();

    public static void show(Context context, int channel, boolean test) {
        if (!test) { show(context, channel, 0, java.util.Collections.emptyMap()); return; }
        NotificationManager nm = manager(context); if (!permitted(context, nm)) return;
        nm.createNotificationChannel(new NotificationChannel("sh_test_v1", "Notification delivery tests", NotificationManager.IMPORTANCE_DEFAULT));
        PendingIntent target = PendingIntent.getActivity(context, 3, new Intent(context, SettingsActivity.class)
            .setData(Uri.parse("shoperator://notification-test")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        nm.notify("firebase-test", ID, new NotificationCompat.Builder(context, "sh_test_v1")
            .setSmallIcon(R.drawable.ic_message_notification).setLargeIcon(NativeBrand.logo(context)).setColor(NativeBrand.GREEN)
            .setContentTitle("Firebase test received").setContentText("SH Chat received the backend's push notification.")
            .setStyle(new NotificationCompat.BigTextStyle().bigText("SH Chat received this Firebase test notification on your phone."))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE).setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setAutoCancel(true).setContentIntent(target).build());
    }

    public static void show(Context context, int channel, long messageId, Map<String, String> data) {
        show(context, channel, messageId, data, new NativeStore(context).credential());
    }
    static boolean show(Context context, int channel, long messageId, Map<String, String> data, DeviceLeasePolicy.Credential credential) {
        if (channel <= 0) return false;
        NativeStore store = new NativeStore(context);
        if (!DeviceLeasePolicy.valid(credential, System.currentTimeMillis())) return false;
        MessageNotificationData preview = MessageNotificationData.from(data, System.currentTimeMillis());
        synchronized (LOCK) {
            NotificationManager nm = manager(context); if (!permitted(context, nm)) { delivery("blocked_permission"); return false; }
            // Android preserves existing user channel/sound/importance choices.
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Customer messages", NotificationManager.IMPORTANCE_HIGH));
            if (nm.getNotificationChannel(CHANNEL).getImportance() == NotificationManager.IMPORTANCE_NONE) { delivery("blocked_channel"); return false; }
            Notification old = null;
            for (StatusBarNotification row : conversations(nm)) if (tag(channel).equals(row.getTag()) &&
                row.getNotification().extras.getLong(GENERATION, -1) == credential.generation) old = row.getNotification();
            final boolean replacing = old != null;
            ArrayList<NotificationCompat.MessagingStyle.Message> messages = new ArrayList<>();
            if (old != null) {
                NotificationCompat.MessagingStyle prior = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(old);
                if (prior != null) messages.addAll(prior.getMessages());
                for (NotificationCompat.MessagingStyle.Message row : messages)
                    if (messageId > 0 && row.getExtras().getLong(MESSAGE_ID) == messageId) return true;
            }
            Person customer = new Person.Builder().setName(preview.sender).setKey("sh-sender:" + channel + ":" + preview.sender)
                .setIcon(IconCompat.createWithBitmap(avatar(preview.sender))).build();
            NotificationCompat.MessagingStyle.Message incoming = new NotificationCompat.MessagingStyle.Message(preview.preview, preview.at, customer);
            incoming.getExtras().putLong(MESSAGE_ID, messageId); messages.add(incoming);
            messages.sort(Comparator.comparingLong(NotificationCompat.MessagingStyle.Message::getTimestamp)
                .thenComparingLong(row -> row.getExtras().getLong(MESSAGE_ID)));
            while (messages.size() > HISTORY_LIMIT) messages.remove(0);
            NotificationCompat.MessagingStyle.Message latest = messages.get(messages.size() - 1);
            String title = preview.group ? preview.conversation : String.valueOf(latest.getPerson().getName());
            long latestId = Math.max(messageId, old == null ? 0 : old.extras.getLong(LATEST_ID));
            int count = Math.min(999, (old == null ? 0 : old.extras.getInt(COUNT, 1)) + 1);
            Intent open = openIntent(context, channel, credential.generation).putExtra(LATEST_ID, latestId);
            PendingIntent target = PendingIntent.getActivity(context, 3, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            Intent dismissed = new Intent(context, MessageDismissReceiver.class).setData(open.getData())
                .putExtra("channel_id", channel).putExtra(GENERATION, credential.generation);
            PendingIntent delete = PendingIntent.getBroadcast(context, 4, dismissed, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            NotificationCompat.MessagingStyle style = new NotificationCompat.MessagingStyle(new Person.Builder().setName("You").setKey("sh-operator").build())
                .setGroupConversation(preview.group);
            if (preview.group) style.setConversationTitle(preview.conversation);
            for (NotificationCompat.MessagingStyle.Message row : messages) style.addMessage(row);
            Bundle extras = new Bundle(); extras.putLong(GENERATION, credential.generation); extras.putLong(LATEST_ID, latestId);
            extras.putInt(COUNT, count); extras.putString(TITLE, title); extras.putString(PREVIEW, String.valueOf(latest.getText()));
            NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL)
                .setSmallIcon(R.drawable.ic_message_notification).setLargeIcon(avatar(title)).setColor(NativeBrand.GREEN)
                .setContentTitle(title).setContentText(latest.getText()).setStyle(style).addPerson(customer)
                .setWhen(latest.getTimestamp()).setShowWhen(true).setNumber(count).addExtras(extras)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE).setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setPublicVersion(publicNotification(context)).setAutoCancel(true).setContentIntent(target).setDeleteIntent(delete)
                .setGroup(GROUP).setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
                .setOnlyAlertOnce(old != null && messageId < old.extras.getLong(LATEST_ID));
            // This final enrollment fence also covers OS notification/shortcut writes.
            // Logout clears old previews under the same fence, so late callbacks cannot recreate them.
            return store.withMessageCredential(credential, () -> {
                String shortcut = "sh-chat-" + credential.generation + "-" + channel;
                try {
                    if (ShortcutManagerCompat.pushDynamicShortcut(context, new ShortcutInfoCompat.Builder(context, shortcut)
                        .setShortLabel(title).setIntent(new Intent(open).setAction(Intent.ACTION_VIEW))
                        .setPerson(customer).setLongLived(true).setIcon(IconCompat.createWithBitmap(avatar(title))).build())) builder.setShortcutId(shortcut);
                } catch (RuntimeException ignored) { /* a launcher/rate-limit failure cannot hide a message */ }
                List<StatusBarNotification> active = conversations(nm);
                active.sort(recency());
                if (!replacing && active.size() >= CHAT_LIMIT) nm.cancel(active.get(0).getTag(), ID);
                nm.notify(tag(channel), ID, builder.build()); refreshSummary(context, nm, credential.generation);
            });
        }
    }

    /** A rich-style/bitmap/launcher failure must not silently discard the message. */
    static boolean fallback(Context context, int channel, long messageId, Map<String, String> data, DeviceLeasePolicy.Credential credential) {
        NotificationManager nm = manager(context); if (channel <= 0 || !permitted(context, nm)) return false;
        nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Customer messages", NotificationManager.IMPORTANCE_HIGH));
        if (nm.getNotificationChannel(CHANNEL).getImportance() == NotificationManager.IMPORTANCE_NONE) return false;
        MessageNotificationData preview = MessageNotificationData.from(data, System.currentTimeMillis());
        synchronized (LOCK) {
            return new NativeStore(context).withMessageCredential(credential, () -> {
                Bundle extras = new Bundle(); extras.putLong(GENERATION, credential.generation); extras.putLong(LATEST_ID, messageId);
                extras.putInt(COUNT, 1); extras.putString(TITLE, preview.sender); extras.putString(PREVIEW, preview.preview);
                PendingIntent open = PendingIntent.getActivity(context, 3, openIntent(context, channel, credential.generation).putExtra(LATEST_ID, messageId),
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                nm.notify(tag(channel), ID, new NotificationCompat.Builder(context, CHANNEL).setSmallIcon(R.drawable.ic_message_notification)
                    .setContentTitle(preview.sender).setContentText(preview.preview).setStyle(new NotificationCompat.BigTextStyle().bigText(preview.preview))
                    .setCategory(NotificationCompat.CATEGORY_MESSAGE).setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setPublicVersion(publicNotification(context))
                    .addExtras(extras).setContentIntent(open).setAutoCancel(true).setWhen(preview.at).setGroup(GROUP)
                    .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN).build());
                refreshSummary(context, nm, credential.generation);
                delivery("posted_fallback");
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
            NotificationManager nm = manager(context); if (nm == null) return;
            store.withMessageCredential(credential, () -> {
                for (StatusBarNotification row : conversations(nm)) if (tag(channel).equals(row.getTag()) &&
                    row.getNotification().extras.getLong(GENERATION, -1) == generation &&
                    row.getNotification().extras.getLong(LATEST_ID) <= intent.getLongExtra(LATEST_ID, 0)) nm.cancel(row.getTag(), ID);
                refreshSummary(context, nm, generation);
            });
        }
    }
    static void dismissed(Context context, long generation) {
        NativeStore store = new NativeStore(context); DeviceLeasePolicy.Credential credential = store.credential();
        if (credential.generation != generation) return;
        synchronized (LOCK) { store.withMessageCredential(credential, () -> { NotificationManager nm = manager(context); if (nm != null) refreshSummary(context, nm, generation); }); }
    }
    // Intentionally no LOCK/native-store access: called while the enrollment fence is held.
    static void clearAll(Context context) {
        try {
            NotificationManager nm = manager(context);
            if (nm != null) for (StatusBarNotification row : nm.getActiveNotifications())
                if (row.getTag() != null && row.getTag().startsWith("message:")) nm.cancel(row.getTag(), row.getId());
            ShortcutManager sm = context.getSystemService(ShortcutManager.class);
            if (sm != null) {
                ArrayList<String> ids = new ArrayList<>();
                for (ShortcutInfo shortcut : sm.getDynamicShortcuts()) if (shortcut.getId().startsWith("sh-chat-")) ids.add(shortcut.getId());
                for (ShortcutInfo shortcut : sm.getPinnedShortcuts()) if (shortcut.getId().startsWith("sh-chat-")) ids.add(shortcut.getId());
                ShortcutManagerCompat.removeLongLivedShortcuts(context, ids);
            }
        } catch (RuntimeException ignored) { /* unsupported launcher/notification service */ }
    }
    private static void refreshSummary(Context context, NotificationManager nm, long generation) {
        List<StatusBarNotification> rows = conversations(nm);
        rows.removeIf(row -> row.getNotification().extras.getLong(GENERATION, -1) != generation);
        if (rows.isEmpty()) { nm.cancel(SUMMARY, SUMMARY_ID); return; }
        rows.sort(recency().reversed());
        int total = 0;
        NotificationCompat.InboxStyle style = new NotificationCompat.InboxStyle();
        for (StatusBarNotification row : rows) {
            Bundle extras = row.getNotification().extras; total += extras.getInt(COUNT, 1);
            style.addLine(extras.getString(TITLE, "Customer") + ": " + extras.getString(PREVIEW, "New message"));
        }
        style.setBigContentTitle(total + " new messages").setSummaryText(rows.size() + " conversations");
        StatusBarNotification single = rows.size() == 1 ? rows.get(0) : null;
        Intent target = single == null ? new Intent(context, MainActivity.class)
            .setData(Uri.parse("shoperator://messages")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            : openIntent(context, Integer.parseInt(single.getTag().substring(8)), generation).putExtra(LATEST_ID, single.getNotification().extras.getLong(LATEST_ID));
        PendingIntent open = PendingIntent.getActivity(context, 5, target, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        nm.notify(SUMMARY, SUMMARY_ID, new NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_message_notification).setColor(NativeBrand.GREEN)
            .setContentTitle(single == null ? "SH Chat" : single.getNotification().extras.getString(TITLE, "Customer"))
            .setContentText(single == null ? total + " new messages from " + rows.size() + " conversations" : single.getNotification().extras.getString(PREVIEW, "New message")).setStyle(style)
            .setNumber(total).setGroup(GROUP).setGroupSummary(true).setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
            .setOnlyAlertOnce(true).setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setPublicVersion(publicNotification(context))
            .setAutoCancel(true).setContentIntent(open).build());
    }
    private static Notification publicNotification(Context context) {
        return new NotificationCompat.Builder(context, CHANNEL).setSmallIcon(R.drawable.ic_message_notification)
            .setContentTitle("SH Chat").setContentText("New message").setVisibility(NotificationCompat.VISIBILITY_PUBLIC).build();
    }
    private static List<StatusBarNotification> conversations(NotificationManager nm) {
        ArrayList<StatusBarNotification> result = new ArrayList<>();
        for (StatusBarNotification row : nm.getActiveNotifications()) if (row.getId() == ID && row.getTag() != null && row.getTag().matches("message:[1-9][0-9]*")) result.add(row);
        return result;
    }
    private static Comparator<StatusBarNotification> recency() {
        return Comparator.comparingLong((StatusBarNotification row) -> row.getNotification().when)
            .thenComparingLong(row -> row.getNotification().extras.getLong(LATEST_ID));
    }
    static String tag(int channel) { return "message:" + channel; }
    private static NotificationManager manager(Context context) { return context.getSystemService(NotificationManager.class); }
    static void delivery(String code) { android.util.Log.i("SHMessageDelivery", code); }
    private static boolean permitted(Context context, NotificationManager manager) {
        return manager != null && (Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) && manager.areNotificationsEnabled();
    }
    private static Bitmap avatar(String name) {
        Bitmap result = Bitmap.createBitmap(128, 128, Bitmap.Config.ARGB_8888); Canvas canvas = new Canvas(result);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG); paint.setColor(NativeBrand.GREEN); canvas.drawCircle(64, 64, 64, paint);
        String[] parts = name.trim().split("\\s+"); String initials = parts[0].isEmpty() ? "?" : new String(Character.toChars(parts[0].codePointAt(0)));
        if (parts.length > 1) initials += new String(Character.toChars(parts[parts.length - 1].codePointAt(0)));
        paint.setColor(Color.WHITE); paint.setTextSize(44); paint.setTextAlign(Paint.Align.CENTER);
        canvas.drawText(initials.toUpperCase(java.util.Locale.ROOT), 64, 64 - (paint.ascent() + paint.descent()) / 2, paint);
        return result;
    }
    private MessageAlerts() { }
}
