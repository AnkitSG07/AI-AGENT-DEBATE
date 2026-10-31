package com.smarthandicrafts.operatorhub;

import android.content.Context;
import android.content.SharedPreferences;
import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

/** Persist first, attempt now, and schedule OS-managed retries without starting call audio. */
public final class NativeRoomCleanup {
    private static final NativeRoomDrainGate GATE = new NativeRoomDrainGate();
    private static final Object LOCK = new Object();
    public static void enqueueOutgoingCancellation(Context context, DeviceLeasePolicy.Credential credential, String requestId) {
        if (requestId == null || !requestId.matches("[A-Za-z0-9_-]{16,100}")) return;
        enqueueRecord(context, credential, "outgoing:" + requestId, "", "", requestId, "end", "");
    }
    public static void enqueue(Context context, DeviceLeasePolicy.Credential credential, String callId, String transferId) {
        enqueue(context, credential, callId, transferId, "");
    }
    public static void enqueue(Context context, DeviceLeasePolicy.Credential credential, String callId, String transferId, String expectedOwnerLegId) {
        if (!HubPolicy.validCallId(callId)) return;
        String leg = expectedOwnerLegId == null ? "" : expectedOwnerLegId;
        if (!leg.isEmpty() && !leg.matches("[A-Za-z0-9_-]{1,180}")) return;
        enqueueRecord(context, credential, callId + ":" + leg + ":" + safe(transferId), callId, transferId, "", "end", leg);
    }
    public static void enqueueDecline(Context context, DeviceLeasePolicy.Credential credential, String callId, String transferId) {
        if (!HubPolicy.validCallId(callId)) return;
        enqueueRecord(context, credential, "decline:" + (safe(transferId).isEmpty() ? callId : transferId), callId, transferId, "", "decline", "");
    }
    private static String safe(String value) { return value == null ? "" : value; }
    private static void enqueueRecord(Context context, DeviceLeasePolicy.Credential credential, String key, String callId, String transferId, String outgoingRequestId, String intent, String leg) {
        Context app = context.getApplicationContext(); NativeStore store = new NativeStore(app);
        if (!store.matchesCredential(credential) || !DeviceLeasePolicy.valid(credential, System.currentTimeMillis())) return;
        if (!safe(transferId).isEmpty() && !NativeRoomPolicy.validTransferId(transferId)) return;
        try {
            // Results from an old enrollment cannot remove a newly registered device's work.
            key = "end:" + credential.generation + ":" + key;
            JSONObject record = new JSONObject().put("callId", callId).put("transferId", safe(transferId)).put("ownerLegId", leg)
                .put("deviceId", credential.deviceId).put("generation", credential.generation).put("credentialHash", NativeRoomCleanupProcessor.digest(credential.bearer))
                .put("requestId", UUID.randomUUID().toString()).put("outgoingRequestId", outgoingRequestId).put("intent", intent)
                .put("createdAt", System.currentTimeMillis()).put("attempts", 0);
            synchronized (LOCK) {
                // Duplicate taps and late ACKs retain the same idempotency key and retry age.
                if (!prefs(app).contains(key) && !prefs(app).edit().putString(key, record.toString()).commit()) throw new IllegalStateException();
            }
            schedule(app); drain(app);
        } catch (Exception ignored) { store.problemIfMatches(credential, "Local audio stopped; reopen the app to check server call cleanup."); }
    }
    static void schedule(Context context) {
        try {
            OneTimeWorkRequest work = new OneTimeWorkRequest.Builder(NativeRoomCleanupWorker.class)
                .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS).build();
            // Work arriving during a worker's last snapshot gets a subsequent OS-managed pass.
            WorkManager.getInstance(context).enqueueUniqueWork("sh-native-call-cleanup", ExistingWorkPolicy.APPEND_OR_REPLACE, work);
        } catch (RuntimeException ignored) { new NativeStore(context).problem("Local audio stopped. Reopen SH Chat if server cleanup remains pending."); }
    }
    public static void drain(Context context) {
        Context app = context.getApplicationContext();
        if (!hasRecords(app) || !GATE.request()) return;
        HubApplication.IO.execute(() -> {
            boolean pending = runOwned(app);
            // The OS retry is sufficient beyond a short immediate retry; no background polling loop.
            if (pending) schedule(app);
        });
    }
    /** Called on WorkManager's worker thread, including after process loss/reboot. */
    static boolean drainWorker(Context context) {
        Context app = context.getApplicationContext();
        if (!hasRecords(app)) return false;
        if (!GATE.request()) return true;
        return runOwned(app);
    }
    private static boolean runOwned(Context app) {
        boolean pending;
        do {
            try { pending = processor(app).runPass(System.currentTimeMillis()); }
            catch (RuntimeException ignored) { pending = true; }
        } while (GATE.repeatOrRelease());
        return pending;
    }
    private static NativeRoomCleanupProcessor processor(Context app) {
        SharedPreferences preferences = prefs(app); NativeStore store = new NativeStore(app);
        return new NativeRoomCleanupProcessor(new NativeRoomCleanupProcessor.Queue() {
            public List<String> keys() { List<String> keys = new ArrayList<>(); for (String key : preferences.getAll().keySet()) if (key.startsWith("end:")) keys.add(key); return keys; }
            public JSONObject read(String key) throws Exception {
                synchronized (LOCK) {
                    try { return preferences.contains(key) ? new JSONObject(preferences.getString(key, "{}")) : null; }
                    catch (Exception error) { preferences.edit().remove(key).commit(); return null; }
                }
            }
            public void remove(String key, String requestId) throws Exception { synchronized (LOCK) { JSONObject current = read(key); if (current != null && requestId.equals(current.optString("requestId"))) preferences.edit().remove(key).commit(); } }
            public void update(String key, String requestId, JSONObject value) throws Exception { synchronized (LOCK) { JSONObject current = read(key); if (current != null && requestId.equals(current.optString("requestId"))) preferences.edit().putString(key, value.toString()).commit(); } }
        }, new NativeRoomCleanupProcessor.Device() {
            public DeviceLeasePolicy.Credential current() { return store.credential(); }
            public void unauthorized(DeviceLeasePolicy.Credential expected, String message) { store.clearEnrollmentIfMatches(expected, message); }
            public void problem(DeviceLeasePolicy.Credential expected, String message) { store.problemIfMatches(expected, message); }
        }, NativeApi::controlRequest);
    }
    private static boolean hasRecords(Context context) { for (String key : prefs(context).getAll().keySet()) if (key.startsWith("end:")) return true; return false; }
    private static SharedPreferences prefs(Context context) { return context.getSharedPreferences("native_room_cleanup", Context.MODE_PRIVATE); }
    private NativeRoomCleanup() { }
}
