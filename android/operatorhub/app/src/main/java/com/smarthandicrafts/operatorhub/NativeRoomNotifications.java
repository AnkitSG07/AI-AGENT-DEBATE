package com.smarthandicrafts.operatorhub;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Person;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import org.json.JSONObject;

/** Native call UI, with distinct call/transfer/attempt PendingIntent identities. */
public final class NativeRoomNotifications {
    public static final String CHANGED = "com.smarthandicrafts.operatorhub.ROOM_CALL_CHANGED";
    public static final int ACTIVE_ID = 201;
    public static String key(String callId, String transferId) { return transferId.isEmpty() ? "room-call:" + callId : "room-transfer:" + transferId; }
    public static Intent activity(Context context, String callId, String transferId, String action) {
        return new Intent(context, NativeRoomCallActivity.class)
            .setData(Uri.parse("shoperator://native/" + Uri.encode(key(callId, transferId)) + "/" + action))
            .putExtra("call_id", callId).putExtra("transfer_id", transferId).putExtra("room_action", action)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    }
    private static JSONObject matchingActive(String id) {
        JSONObject active = NativeRoomCallService.snapshot();
        if (active == null || active.optBoolean("closed")) return null;
        return id.equals(active.optString("callId")) || id.equals(active.optString("providerCallId")) || id.equals(active.optString("clientAttemptId")) ? active : null;
    }
    private static void bindEnrollment(Context context, Intent intent) {
        DeviceLeasePolicy.Credential credential = new NativeStore(context).credential();
        intent.putExtra("enrollment_generation", credential.generation).putExtra("enrolled_device_id", credential.deviceId);
    }
    private static PendingIntent activityPending(Context context, String id, String transfer, String action) {
        Intent intent = activity(context, id, transfer, action); bindEnrollment(context, intent);
        JSONObject active = matchingActive(id);
        if (active != null) {
            intent.putExtra("client_attempt_id", active.optString("clientAttemptId")).putExtra("owner_leg_id", active.optString("ownerLegId"));
            intent.setData(Uri.parse(intent.getDataString() + "/" + Uri.encode(active.optString("clientAttemptId"))));
        }
        intent.setData(Uri.parse(intent.getDataString() + "/g" + intent.getLongExtra("enrollment_generation", -1)));
        return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
    private static PendingIntent actionPending(Context context, String id, String transfer, String action) {
        Intent intent = new Intent(context, NativeRoomActionReceiver.class)
            .setData(Uri.parse("shoperator://native-action/" + Uri.encode(key(id, transfer)) + "/" + action))
            .putExtra("call_id", id).putExtra("transfer_id", transfer).putExtra("room_action", action);
        bindEnrollment(context, intent);
        JSONObject active = "end".equals(action) ? matchingActive(id) : null;
        if (active != null) {
            intent.putExtra("outgoing_request_id", active.optString("outgoingRequestId"))
                .putExtra("client_attempt_id", active.optString("clientAttemptId")).putExtra("owner_leg_id", active.optString("ownerLegId"));
            intent.setData(Uri.parse(intent.getDataString() + "/" + Uri.encode(active.optString("clientAttemptId")) + "/" + Uri.encode(active.optString("ownerLegId"))));
        }
        intent.setData(Uri.parse(intent.getDataString() + "/g" + intent.getLongExtra("enrollment_generation", -1)));
        return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
    public static boolean currentEnrollment(Context context, Intent intent) {
        if (!intent.hasExtra("enrollment_generation")) return true; // Explicit, internal Hub action.
        DeviceLeasePolicy.Credential current = new NativeStore(context).credential();
        return current.generation == intent.getLongExtra("enrollment_generation", -1) && current.deviceId.equals(intent.getStringExtra("enrolled_device_id"));
    }
    public static void show(Context context, String id, String transfer, long expiry) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if ((Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            || !manager.areNotificationsEnabled()) return;
        PendingIntent answer = activityPending(context, id, transfer, "accept"), decline = actionPending(context, id, transfer, "decline");
        String name = transfer.isEmpty() ? "WhatsApp caller" : "Incoming call transfer";
        Notification.Builder builder = new Notification.Builder(context, CallAlerts.INCOMING)
            .setSmallIcon(R.drawable.ic_notification).setLargeIcon(NativeBrand.logo(context)).setColor(NativeBrand.GREEN)
            .setContentTitle(transfer.isEmpty() ? "Incoming WhatsApp call" : "Call transfer to this phone")
            .setContentText(transfer.isEmpty() ? "Answer in SH Chat" : "Accept to join the customer and take over the call")
            .setCategory(Notification.CATEGORY_CALL).setVisibility(Notification.VISIBILITY_PRIVATE)
            .setContentIntent(activityPending(context, id, transfer, "show"))
            .setDeleteIntent(actionPending(context, id, transfer, "silence"))
            .setOnlyAlertOnce(true).setAutoCancel(false).setTimeoutAfter(Math.max(1, expiry - System.currentTimeMillis()));
        if (Build.VERSION.SDK_INT >= 31) builder.setStyle(Notification.CallStyle.forIncomingCall(new Person.Builder().setName(name).setImportant(true).build(), decline, answer));
        else builder.addAction(new Notification.Action.Builder(null, "Decline", decline).build()).addAction(new Notification.Action.Builder(null, "Accept", answer).build());
        // An incoming CallStyle needs a full-screen intent while no call foreground
        // service is running. Keep it even when special access is denied: Android
        // enforces that choice and presents a heads-up notification instead.
        builder.setFullScreenIntent(activityPending(context, id, transfer, "show"), true);
        Notification value = builder.build(); value.flags |= Notification.FLAG_INSISTENT;
        manager.notify(key(id, transfer), 101, value);
    }
    public static Notification ongoing(Context context, String id, String transfer, String text) {
        JSONObject active = matchingActive(id);
        String name = active == null ? "SH Chat customer" : active.optString("displayName", "SH Chat customer");
        PendingIntent end = actionPending(context, id, transfer, "end");
        Notification.Builder builder = new Notification.Builder(context, CallAlerts.ACTIVE)
            .setSmallIcon(R.drawable.ic_notification).setLargeIcon(NativeBrand.logo(context)).setColor(NativeBrand.GREEN)
            .setContentTitle("SH Chat audio call").setContentText(text).setOngoing(true).setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_CALL).setVisibility(Notification.VISIBILITY_PRIVATE)
            .setContentIntent(activityPending(context, id, transfer, "show"));
        if (Build.VERSION.SDK_INT >= 31) builder.setStyle(Notification.CallStyle.forOngoingCall(new Person.Builder().setName(name.isEmpty() ? "Customer" : name).setImportant(true).build(), end));
        else builder.addAction(new Notification.Action.Builder(null, "End", end).build());
        long connected = active == null ? 0 : active.optLong("connectedAtElapsed");
        if (connected > 0) builder.setWhen(System.currentTimeMillis() - Math.max(0, SystemClock.elapsedRealtime() - connected)).setUsesChronometer(true);
        else builder.setShowWhen(false);
        return builder.build();
    }
    public static void cancel(Context context, String id, String transfer) {
        cancel(context, id, transfer, false);
    }
    public static void cancelTerminal(Context context, String id, String transfer) {
        cancel(context, id, transfer, true);
    }
    private static void cancel(Context context, String id, String transfer, boolean terminal) {
        context.getSystemService(NotificationManager.class).cancel(key(id, transfer), 101);
        context.sendBroadcast(new Intent(CHANGED).setPackage(context.getPackageName()).putExtra("call_id", id).putExtra("transfer_id", transfer).putExtra("alert_terminal", terminal));
    }
    private NativeRoomNotifications() { }
}
