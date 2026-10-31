package com.smarthandicrafts.operatorhub;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Person;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.graphics.drawable.Icon;

public final class MessageAlerts {
    public static void show(Context context, int channel, boolean test) {
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
        if (!nm.areNotificationsEnabled()) return;
        String channelName = test ? "sh_test_v1" : "sh_messages_v1";
        nm.createNotificationChannel(new NotificationChannel(channelName, test ? "Notification delivery tests" : "Customer messages", NotificationManager.IMPORTANCE_DEFAULT));
        Intent open = new Intent(context, test ? SettingsActivity.class : MainActivity.class)
            .setData(Uri.parse("shoperator://message/" + channel)).putExtra("channel_id", channel)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent target = PendingIntent.getActivity(context, 3, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder = new Notification.Builder(context, channelName).setSmallIcon(R.drawable.ic_message_notification)
            .setLargeIcon(NativeBrand.logo(context)).setColor(NativeBrand.GREEN)
            .setContentTitle(test ? "Firebase test received" : "New customer message")
            .setContentText(test ? "SH Chat received the backend's push notification." : "Open SH Chat to read and reply.")
            .setCategory(Notification.CATEGORY_MESSAGE).setVisibility(Notification.VISIBILITY_PRIVATE).setAutoCancel(true).setContentIntent(target);
        if (!test && Build.VERSION.SDK_INT >= 28) {
            Person operator = new Person.Builder().setName("You").setKey("sh-operator").build();
            Person customer = new Person.Builder().setName("Customer").setKey("sh-chat-" + channel)
                .setIcon(Icon.createWithBitmap(NativeBrand.logo(context))).build();
            Notification.MessagingStyle style = new Notification.MessagingStyle(operator)
                .setConversationTitle("Customer conversation").setGroupConversation(false)
                .addMessage("New message · Open SH Chat to read and reply", System.currentTimeMillis(), customer);
            builder.setStyle(style);
        } else {
            builder.setStyle(new Notification.BigTextStyle().bigText(test
                ? "SH Chat received this Firebase test notification on your phone."
                : "You have a new customer message. Open SH Chat to read and reply."));
        }
        // One tag per conversation keeps its updates together; Android groups multiple chats.
        // No Reply action is advertised until an authenticated native send workflow exists.
        nm.notify(test ? "firebase-test" : "message:" + channel, 300, builder.build());
    }
    private MessageAlerts() { }
}
