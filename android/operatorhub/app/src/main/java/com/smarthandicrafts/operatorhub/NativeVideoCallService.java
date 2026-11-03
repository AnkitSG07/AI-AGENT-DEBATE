package com.smarthandicrafts.operatorhub;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.media.*;
import android.os.*;
import androidx.core.app.ServiceCompat;

/** Keeps the user-started video call visible to Android while its Activity is
 * in picture-in-picture. Contains no account or room credentials. */
public final class NativeVideoCallService extends Service {
    static final String FOCUS = "com.smarthandicrafts.operatorhub.VIDEO_FOCUS";
    private static volatile boolean running;
    private AudioManager audio;
    private AudioFocusRequest focus;
    private int previousMode;
    private boolean previousSpeaker;
    private PowerManager.WakeLock wake;
    public static boolean isRunning() { return running; }
    public static void begin(Context context) { running = true; try { context.startForegroundService(new Intent(context, NativeVideoCallService.class)); } catch (RuntimeException e) { running = false; throw e; } }
    public static void end(Context context) { running = false; context.stopService(new Intent(context, NativeVideoCallService.class)); }
    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel("sh_video_active", "Active video calls", NotificationManager.IMPORTANCE_LOW));
        PendingIntent open = PendingIntent.getActivity(this, 940, new Intent(this, NativeVideoCallActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent end = PendingIntent.getActivity(this, 941, new Intent(this, NativeVideoCallActivity.class).putExtra("end", true).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification note = new Notification.Builder(this, "sh_video_active").setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("SH Chat video call").setContentText("Tap to return to your call")
            .setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true).setCategory(Notification.CATEGORY_CALL)
            .addAction(new Notification.Action.Builder(null, "End", end).build()).build();
        ServiceCompat.startForeground(this, 9240, note, Build.VERSION.SDK_INT >= 30 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA | ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE : 0);
        if (audio == null) {
            audio = getSystemService(AudioManager.class); previousMode = audio.getMode(); previousSpeaker = audio.isSpeakerphoneOn();
            focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                .setOnAudioFocusChangeListener(change -> sendBroadcast(new Intent(FOCUS).setPackage(getPackageName()).putExtra("allowed", change == AudioManager.AUDIOFOCUS_GAIN))).build();
            if (audio.requestAudioFocus(focus) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
                sendBroadcast(new Intent(FOCUS).setPackage(getPackageName()).putExtra("allowed", false).putExtra("failed", true));
                running = false; stopSelf(); return START_NOT_STICKY;
            }
            audio.setMode(AudioManager.MODE_IN_COMMUNICATION); audio.setSpeakerphoneOn(true);
            wake = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SHChat:VideoCall"); wake.acquire(31 * 60000L);
        }
        running = true; return START_NOT_STICKY;
    }
    @Override public void onDestroy() {
        running = false;
        if (audio != null) { audio.abandonAudioFocusRequest(focus); audio.setSpeakerphoneOn(previousSpeaker); audio.setMode(previousMode); }
        if (wake != null && wake.isHeld()) wake.release();
        super.onDestroy();
    }
}
