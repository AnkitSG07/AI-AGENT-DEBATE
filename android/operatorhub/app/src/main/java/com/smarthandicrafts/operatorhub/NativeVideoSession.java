package com.smarthandicrafts.operatorhub;

import android.content.Context;
import android.content.Intent;
import android.os.SystemClock;

/** One in-process video activity, including the permission/waiting stage.
 * Invitations are never written to shared storage or placed in notification text. */
final class NativeVideoSession {
    private static Intent descriptor;
    private static long started;
    static synchronized boolean active() {
        if (descriptor != null && SystemClock.elapsedRealtime() - started > 31 * 60000L) descriptor = null;
        return descriptor != null;
    }
    static synchronized void begin(Context context, String operator, String customer, String name, String requestId) {
        if (!NativeVideoCallActivity.validUrl(operator, "operator") || !NativeVideoCallActivity.validUrl(customer, "customer")) throw new IllegalArgumentException("Invalid video invitation");
        descriptor = new Intent(context, NativeVideoCallActivity.class)
            .putExtra("operator_url", operator).putExtra("customer_url", customer)
            .putExtra("display_name", name).putExtra("request_id", requestId)
            .putExtra("invitation_status", "Sending invitation…");
        started = SystemClock.elapsedRealtime();
    }
    static synchronized Intent open(Context context) {
        return (active() ? new Intent(descriptor) : new Intent(context, NativeVideoCallActivity.class))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    }
    static synchronized boolean updateInvitation(String requestId, String status) {
        if (!active() || !requestId.equals(descriptor.getStringExtra("request_id"))) return false;
        descriptor.putExtra("invitation_status", status); return true;
    }
    static synchronized String invitationStatus() { return active() ? descriptor.getStringExtra("invitation_status") : ""; }
    static synchronized boolean finish(String operator) {
        if (descriptor == null || !java.util.Objects.equals(operator, descriptor.getStringExtra("operator_url"))) return false;
        descriptor = null; return true;
    }
}
