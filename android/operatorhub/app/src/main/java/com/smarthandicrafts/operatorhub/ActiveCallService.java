package com.smarthandicrafts.operatorhub;

import android.app.Notification;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.Handler;
import android.os.Looper;

/** Holds foreground priority only for a visible, user-started Hub call with microphone permission. */
public final class ActiveCallService extends Service {
    private static volatile String runningCallId = "";
    public static boolean isActiveFor(String id) { return id != null && id.equals(runningCallId); }
    public static boolean isActiveForAny() { return !runningCallId.isEmpty(); }
    private final Handler watchdog = new Handler(Looper.getMainLooper());
    private final Runnable expire = this::stopSelf;
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String id = intent == null ? null : intent.getStringExtra("call_id");
        if (!HubPolicy.validCallId(id)) { stopSelf(); return START_NOT_STICKY; }
        if (NativeRoomCallService.isRunning()) { stopSelf(); return START_NOT_STICKY; }
        watchdog.removeCallbacks(expire); watchdog.postDelayed(expire, 90000);
        Notification n = new Notification.Builder(this, CallAlerts.ACTIVE).setSmallIcon(R.drawable.ic_notification)
            .setLargeIcon(NativeBrand.logo(this)).setColor(NativeBrand.GREEN)
            .setContentTitle("SH Chat audio call").setContentText("Tap to return to the call")
            .setCategory(Notification.CATEGORY_CALL).setOngoing(true).setOnlyAlertOnce(true).setContentIntent(CallAlerts.open(this, id, false)).build();
        try { if (Build.VERSION.SDK_INT >= 30) startForeground(200, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE); else startForeground(200, n); runningCallId = id; }
        catch (RuntimeException denied) { stopSelf(); }
        return START_NOT_STICKY;
    }
    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public void onDestroy() { runningCallId = ""; watchdog.removeCallbacks(expire); stopForeground(STOP_FOREGROUND_REMOVE); super.onDestroy(); }
}
