package com.smarthandicrafts.operatorhub;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;

public final class CallAlerts {
    public static final String INCOMING = "sh_incoming_calls_v1", ACTIVE = "sh_active_calls_v1";
    public static void createChannels(Context context) {
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        NotificationChannel incoming = new NotificationChannel(INCOMING, "Incoming WhatsApp calls", NotificationManager.IMPORTANCE_HIGH);
        incoming.setDescription("Incoming customer calls while this operator device is enrolled");
        incoming.enableVibration(true);
        incoming.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).build());
        incoming.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        nm.createNotificationChannel(incoming);
        NotificationChannel active = new NotificationChannel(ACTIVE, "Active SH Chat call", NotificationManager.IMPORTANCE_LOW);
        active.setSound(null, null); nm.createNotificationChannel(active);
    }
    static PendingIntent open(Context context, String id, boolean incomingScreen) {
        int flags = Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP;
        if (!incomingScreen) flags |= Intent.FLAG_ACTIVITY_SINGLE_TOP;
        Intent intent = new Intent(context, incomingScreen ? IncomingCallActivity.class : MainActivity.class)
            .setData(Uri.parse("shoperator://call/" + Uri.encode(id)))
            .putExtra("call_id", id).addFlags(flags);
        return PendingIntent.getActivity(context, 1, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
    public static void show(Context context, String id, long expiry) {
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        if (!nm.areNotificationsEnabled()) return;
        Intent dismiss = new Intent(context, CallDismissReceiver.class).setData(Uri.parse("shoperator://dismiss/" + Uri.encode(id))).putExtra("call_id", id);
        PendingIntent silence = PendingIntent.getBroadcast(context, 2, dismiss, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = new Notification.Builder(context, INCOMING)
            .setSmallIcon(R.drawable.ic_notification).setLargeIcon(NativeBrand.logo(context)).setColor(NativeBrand.GREEN)
            .setContentTitle("Incoming WhatsApp call")
            .setContentText("Open SH Chat to answer. Dismiss silences this phone.")
            .setCategory(Notification.CATEGORY_CALL).setVisibility(Notification.VISIBILITY_PRIVATE)
            .setContentIntent(open(context, id, true)).setDeleteIntent(silence).setAutoCancel(false)
            .setOnlyAlertOnce(true).setTimeoutAfter(Math.max(1, expiry - System.currentTimeMillis()))
            .addAction(new Notification.Action.Builder(null, "Open call", open(context, id, false)).build())
            .addAction(new Notification.Action.Builder(null, "Dismiss", silence).build());
        if (Build.VERSION.SDK_INT < 34 || nm.canUseFullScreenIntent()) b.setFullScreenIntent(open(context, id, true), true);
        Notification notification = b.build(); notification.flags |= Notification.FLAG_INSISTENT;
        nm.notify("call:" + id, 100, notification);
    }
    public static void cancel(Context context, String id) {
        if (HubPolicy.validCallId(id)) context.getSystemService(NotificationManager.class).cancel("call:" + id, 100);
        Intent update = new Intent("com.smarthandicrafts.operatorhub.CALL_ALERT_CHANGED").setPackage(context.getPackageName()).putExtra("call_id", id);
        context.sendBroadcast(update);
    }
    private CallAlerts() { }
}
