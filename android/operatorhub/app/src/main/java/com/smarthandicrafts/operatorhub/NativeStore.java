package com.smarthandicrafts.operatorhub;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.UUID;

/** Native-only state. Backup and device transfer are disabled in the manifest. */
public final class NativeStore {
    private static final Object EVENT_LOCK = new Object();
    private final Context appContext;
    private final SharedPreferences prefs;
    public NativeStore(Context context) {
        appContext = context.getApplicationContext();
        prefs = appContext.getSharedPreferences("native_private", Context.MODE_PRIVATE);
    }
    public String installationId() {
        synchronized (EVENT_LOCK) {
        String id = prefs.getString("installation_id", "");
        if (id.isEmpty()) { id = UUID.randomUUID().toString(); prefs.edit().putString("installation_id", id).commit(); }
        return id;
            }
    }
    public String token() { return prefs.getString("device_token", ""); }
    public String deviceId() { return prefs.getString("device_id", ""); }
    public long expiresAt() { return prefs.getLong("device_expires", 0); }
    public boolean enrolled() { return !token().isEmpty() && expiresAt() > System.currentTimeMillis(); }
    public DeviceLeasePolicy.Credential credential() {
        synchronized (EVENT_LOCK) {
            return new DeviceLeasePolicy.Credential(deviceId(), token(), expiresAt(), prefs.getLong("enrollment_generation", 0));
        }
    }
    public boolean matchesCredential(DeviceLeasePolicy.Credential expected) {
        synchronized (EVENT_LOCK) { return DeviceLeasePolicy.sameIdentity(credential(), expected); }
    }
    /** Publish previews atomically with enrollment changes, including logout cleanup. */
    public boolean withMessageCredential(DeviceLeasePolicy.Credential expected, Runnable operation) {
        synchronized (EVENT_LOCK) {
            DeviceLeasePolicy.Credential current = credential();
            if (!DeviceLeasePolicy.sameIdentity(current, expected) || !DeviceLeasePolicy.valid(current, System.currentTimeMillis())) return false;
            operation.run(); return true;
        }
    }
    public void watchCredential(SharedPreferences.OnSharedPreferenceChangeListener listener) { prefs.registerOnSharedPreferenceChangeListener(listener); }
    public void unwatchCredential(SharedPreferences.OnSharedPreferenceChangeListener listener) { prefs.unregisterOnSharedPreferenceChangeListener(listener); }
    public String callPermissionRequestId(DeviceLeasePolicy.Credential expected,String phone) {
        synchronized (EVENT_LOCK) {
            if (!matchesCredential(expected)||!NativeRoomPolicy.validPhone(phone)) return "";
            return prefs.getString("call_permission_request:"+expected.generation+":"+phone,"");
        }
    }
    public boolean rememberCallPermissionRequest(DeviceLeasePolicy.Credential expected,String phone,String requestId) {
        synchronized (EVENT_LOCK) {
            if (!matchesCredential(expected)||!NativeRoomPolicy.validPhone(phone)||!NativeCallPermissionState.validRequestId(requestId)) return false;
            // Persist before sending: process loss must not turn an uncertain send into a new request.
            return prefs.edit().putString("call_permission_request:"+expected.generation+":"+phone,requestId).commit();
        }
    }
    public String fcmToken() { return prefs.getString("fcm_token", ""); }
    public void setFcmToken(String value) { prefs.edit().putString("fcm_token", value).apply(); }
    public String config() { return prefs.getString("firebase_config", ""); }
    public void setConfig(JSONObject config) { prefs.edit().putString("firebase_config", config.toString()).apply(); }
    public void enroll(JSONObject response) {
        synchronized (EVENT_LOCK) { enrollIfGeneration(response, prefs.getLong("enrollment_generation", 0)); }
    }
    public boolean enrollIfGeneration(JSONObject response, long expectedGeneration) {
        return enrollIfGeneration(response.optString("deviceId"), response.optString("deviceToken"), response.optLong("expiresAt"), expectedGeneration);
    }
    public boolean enrollIfGeneration(String id, String bearer, long expiry, long expectedGeneration) {
        synchronized (EVENT_LOCK) {
            long generation = prefs.getLong("enrollment_generation", 0);
            DeviceLeasePolicy.Credential candidate = new DeviceLeasePolicy.Credential(id, bearer, expiry, generation);
            if (generation != expectedGeneration || !DeviceLeasePolicy.valid(candidate, System.currentTimeMillis())) return false;
            boolean saved = prefs.edit().putString("device_id", id).putString("device_token", bearer).putLong("device_expires", expiry)
                .putLong("enrollment_generation", generation + 1).remove("lease_last_attempt").putString("last_problem", "").commit();
            if (saved) clearMessageStateLocked();
            return saved;
        }
    }
    public void clearEnrollment() {
        synchronized (EVENT_LOCK) { clearEnrollmentLocked(""); }
    }
    public DeviceLeasePolicy.Credential clearEnrollmentAndSnapshot() {
        synchronized (EVENT_LOCK) {
            DeviceLeasePolicy.Credential previous = credential(); clearEnrollmentLocked(""); return previous;
        }
    }
    private void clearEnrollmentLocked(String problem) {
        prefs.edit().remove("device_id").remove("device_token").remove("device_expires").remove("lease_last_attempt")
            .putLong("enrollment_generation", prefs.getLong("enrollment_generation", 0) + 1)
            .putString("last_problem", problem == null ? "" : problem).commit();
        clearMessageStateLocked();
    }
    private void clearMessageStateLocked() {
        SharedPreferences.Editor edit = prefs.edit();
        for (String key : prefs.getAll().keySet())
            if (key.startsWith("message:") || key.startsWith("message_time:") || key.startsWith("message_seen:") || key.startsWith("message_floor:")) edit.remove(key);
        edit.commit();
        MessageAlerts.clearAll(appContext);
    }
    public boolean clearEnrollmentIfMatches(DeviceLeasePolicy.Credential expected, String problem) {
        synchronized (EVENT_LOCK) {
            if (!DeviceLeasePolicy.sameIdentity(credential(), expected)) return false;
            clearEnrollmentLocked(problem); return true;
        }
    }
    public boolean applyLeaseExpiry(DeviceLeasePolicy.Credential expected, String responseDeviceId, long responseExpiry) {
        synchronized (EVENT_LOCK) {
            if (!DeviceLeasePolicy.acceptsExpiry(credential(), expected, responseDeviceId, responseExpiry, System.currentTimeMillis())) return false;
            return prefs.edit().putLong("device_expires", responseExpiry).putString("last_problem", "").commit();
        }
    }
    public void problemIfMatches(DeviceLeasePolicy.Credential expected, String text) {
        synchronized (EVENT_LOCK) { if (DeviceLeasePolicy.sameIdentity(credential(), expected)) problem(text); }
    }
    public void leaseCapability(boolean supported, long checkedAt) {
        synchronized (EVENT_LOCK) { prefs.edit().putBoolean("lease_renewal_supported", supported).putLong("lease_capability_checked", checkedAt).apply(); }
    }
    public boolean leaseRenewalSupported() { return prefs.getBoolean("lease_renewal_supported", false); }
    public static final class LeaseAttempt {
        public final DeviceLeasePolicy.Credential credential;
        public final DeviceLeasePolicy.Plan plan;
        LeaseAttempt(DeviceLeasePolicy.Credential credential, DeviceLeasePolicy.Plan plan) { this.credential = credential; this.plan = plan; }
    }
    public LeaseAttempt beginLeaseAttempt(long now) {
        synchronized (EVENT_LOCK) {
            DeviceLeasePolicy.Credential value = credential();
            DeviceLeasePolicy.Plan plan = DeviceLeasePolicy.plan(value, now, prefs.getLong("lease_last_attempt", 0),
                prefs.getLong("lease_capability_checked", 0), leaseRenewalSupported());
            if (plan == DeviceLeasePolicy.Plan.NONE) return null;
            prefs.edit().putLong("lease_last_attempt", now).apply();
            return new LeaseAttempt(value, plan);
        }
    }
    public void problem(String text) { prefs.edit().putString("last_problem", text).apply(); }
    public String problem() { return prefs.getString("last_problem", ""); }
    public void serverEnabled(boolean enabled) { prefs.edit().putBoolean("server_enabled", enabled).apply(); }
    public boolean serverEnabled() { return prefs.getBoolean("server_enabled", false); }
    public void roomCapability(boolean enabled, long checkedAt) {
        prefs.edit().putBoolean("native_room_calls", enabled).putLong("native_room_checked", checkedAt).apply();
    }
    public boolean roomCapabilitiesIfMatches(DeviceLeasePolicy.Credential expected, boolean enabled, boolean transfers, long checkedAt) {
        synchronized (EVENT_LOCK) {
            if (!matchesCredential(expected)) return false;
            prefs.edit().putBoolean("native_room_calls", enabled).putBoolean("native_room_transfers", enabled && transfers)
                .putLong("native_room_checked", checkedAt).apply(); return true;
        }
    }
    public void audioFailureIfMatches(DeviceLeasePolicy.Credential expected, String stage, String code, long at) {
        if (stage == null || code == null || !stage.matches("[A-Z_]{1,48}") || !code.matches("AUDIO_[A-Z_]{1,96}")) return;
        synchronized (EVENT_LOCK) {
            if (!matchesCredential(expected)) return;
            prefs.edit().putString("audio_failure_stage", stage).putString("audio_failure_code", code).putLong("audio_failure_at", at).apply();
        }
    }
    public void clearAudioFailureIfMatches(DeviceLeasePolicy.Credential expected) {
        synchronized (EVENT_LOCK) {
            if (matchesCredential(expected)) prefs.edit().remove("audio_failure_stage").remove("audio_failure_code").remove("audio_failure_at").apply();
        }
    }
    public String audioFailureCode() { return prefs.getString("audio_failure_code", ""); }
    public long audioFailureAt() { return prefs.getLong("audio_failure_at", 0); }
    public void transferCapability(boolean enabled) { prefs.edit().putBoolean("native_room_transfers", enabled).apply(); }
    public boolean nativeRoomTransfers() { return nativeRoomCalls() && prefs.getBoolean("native_room_transfers", false); }
    public boolean nativeRoomCalls() {
        long age = System.currentTimeMillis() - prefs.getLong("native_room_checked", 0);
        return enrolled() && prefs.getBoolean("native_room_calls", false) && age >= 0 && age < 21600000;
    }
    public long roomCapabilityCheckedAt() { return prefs.getLong("native_room_checked", 0); }
    public void cancelRoomAttempt(String attemptId) {
        if (!NativeRoomUiBinding.validAttemptId(attemptId)) return;
        synchronized (EVENT_LOCK) {
            long now = System.currentTimeMillis(); SharedPreferences.Editor edit = prefs.edit().putLong("room_cancelled:" + attemptId, now);
            for (String key : prefs.getAll().keySet()) if (key.startsWith("room_cancelled:") && now - prefs.getLong(key, 0) > 86400000) edit.remove(key);
            edit.commit();
        }
    }
    public boolean roomAttemptCancelled(String attemptId) { return NativeRoomUiBinding.validAttemptId(attemptId) && prefs.contains("room_cancelled:" + attemptId); }
    /** Call and transfer invitations have distinct replay tombstones. */
    public boolean roomIncoming(String callId, String transferId, long issued, long expiry) {
        synchronized (EVENT_LOCK) {
            long now = System.currentTimeMillis();
            if (!enrolled() || !HubPolicy.validCallId(callId) || !HubPolicy.freshIncoming(issued, expiry, now)
                || (!transferId.isEmpty() && !NativeRoomPolicy.validTransferId(transferId))) return false;
            String key = roomKey(callId, transferId);
            try {
                JSONObject old = new JSONObject(prefs.getString(key, "{}"));
                if (old.optBoolean("closed") || old.optLong("issued") >= issued) return false;
                JSONObject record = new JSONObject().put("callId", callId).put("transferId", transferId)
                    .put("issued", issued).put("expiry", expiry).put("stored", now);
                SharedPreferences.Editor edit = prefs.edit().putString(key, record.toString());
                for (String candidate : prefs.getAll().keySet()) if (candidate.startsWith("room_alert:")) {
                    try { if (now - new JSONObject(prefs.getString(candidate, "{}")).optLong("stored") > 86400000) edit.remove(candidate); }
                    catch (Exception ignored) { edit.remove(candidate); }
                }
                return edit.commit();
            } catch (Exception ignored) { return false; }
        }
    }
    public void closeRoomAlert(String callId, String transferId) {
        synchronized (EVENT_LOCK) {
            if (!HubPolicy.validCallId(callId) || (!transferId.isEmpty() && !NativeRoomPolicy.validTransferId(transferId))) return;
            try { prefs.edit().putString(roomKey(callId, transferId), new JSONObject().put("closed", true)
                .put("stored", System.currentTimeMillis()).toString()).commit(); } catch (Exception ignored) { }
        }
    }
    public boolean roomAlertActive(String callId, String transferId) {
        try { JSONObject value = new JSONObject(prefs.getString(roomKey(callId, transferId), "{}"));
            return enrolled() && callId.equals(value.optString("callId")) && !value.optBoolean("closed") && value.optLong("expiry") > System.currentTimeMillis();
        } catch (Exception ignored) { return false; }
    }
    public JSONObject soleRoomInvitation() {
        synchronized (EVENT_LOCK) {
            JSONObject sole = null;
            for (String key : prefs.getAll().keySet()) if (key.startsWith("room_alert:")) {
                try {
                    JSONObject record = new JSONObject(prefs.getString(key, "{}"));
                    if (!record.optBoolean("closed") && record.optLong("expiry") > System.currentTimeMillis()) {
                        if (sole != null) return null; sole = record;
                    }
                } catch (Exception ignored) { }
            }
            return sole;
        }
    }
    /** A cancelled alert is different from a call opened without any FCM history. */
    public boolean roomAlertClosed(String callId, String transferId) {
        try { return new JSONObject(prefs.getString(roomKey(callId, transferId), "{}")).optBoolean("closed"); }
        catch (Exception ignored) { return false; }
    }
    public long roomAlertExpiry(String callId, String transferId) {
        try { return new JSONObject(prefs.getString(roomKey(callId,transferId),"{}")).optLong("expiry",0); }
        catch (Exception ignored) { return 0; }
    }
    private static String roomKey(String callId, String transferId) { return "room_alert:" + (transferId.isEmpty() ? "call:" + callId : "transfer:" + transferId); }
    public boolean receiveMessage(long channel, long message, long issued, long expiry) {
        return receiveMessage(channel, message, issued, expiry, null);
    }
    public boolean receiveMessage(long channel, long message, long issued, long expiry, DeviceLeasePolicy.Credential expected) {
        synchronized (EVENT_LOCK) {
        long now = System.currentTimeMillis();
        if (expected != null && !DeviceLeasePolicy.sameIdentity(credential(), expected)) return false;
        if (!enrolled() || channel <= 0 || message <= 0 || issued <= 0 || issued > now + 30000 || expiry <= now || expiry <= issued || expiry - issued > 300000) return false;
        String key = "message:" + channel;
        String seenKey = "message_seen:" + channel;
        java.util.TreeSet<Long> seen = new java.util.TreeSet<>();
        try {
            JSONArray ids = new JSONArray(prefs.getString(seenKey, "[]"));
            for (int i = 0; i < ids.length(); i++) if (ids.optLong(i) > 0) seen.add(ids.optLong(i));
        } catch (Exception ignored) { }
        long highWater = prefs.getLong(key, 0);
        long migrationFloor = prefs.getLong("message_floor:" + channel, prefs.contains(seenKey) ? 0 : highWater);
        // Preserve the old APK's deduplication boundary on the first upgraded delivery.
        // Later fresh out-of-order FCM messages are accepted once within a bounded window.
        if (seen.contains(message) || message <= migrationFloor ||
            (seen.size() >= 32 && message < seen.first())) return false;
        seen.add(message);
        while (seen.size() > 32) migrationFloor = Math.max(migrationFloor, seen.pollFirst());
        SharedPreferences.Editor edit = prefs.edit().putLong(key, Math.max(highWater, message))
            .putString(seenKey, new JSONArray(seen).toString()).putLong("message_floor:" + channel, migrationFloor).putLong("message_time:" + channel, now);
        java.util.ArrayList<String> keys = new java.util.ArrayList<>();
        for (String candidate : prefs.getAll().keySet()) if (candidate.startsWith("message:") && !candidate.equals(key)) keys.add(candidate);
        keys.sort(java.util.Comparator.comparingLong(k -> prefs.getLong("message_time:" + k.substring(8), 0)));
        for (int i = 0; i < Math.max(0, keys.size() - 127); i++) {
            String old = keys.get(i); edit.remove(old).remove("message_time:" + old.substring(8)).remove("message_seen:" + old.substring(8)).remove("message_floor:" + old.substring(8));
        }
        edit.apply();
        return true;
            }
    }
    public void testReceived(String id) { prefs.edit().putLong("last_test_received", System.currentTimeMillis()).putString("last_test_id", id).apply(); }
    /** Undo only an unposted local delivery; never clears other IDs, the replay floor or account state. */
    public void unpostedMessage(long channel, long message, DeviceLeasePolicy.Credential expected) {
        synchronized (EVENT_LOCK) {
            if (!DeviceLeasePolicy.sameIdentity(credential(), expected)) return;
            try {
                String key = "message_seen:" + channel;
                JSONArray before = new JSONArray(prefs.getString(key, "[]")), after = new JSONArray();
                for (int i = 0; i < before.length(); i++) if (before.optLong(i) != message) after.put(before.optLong(i));
                prefs.edit().putString(key, after.toString()).apply();
            } catch (Exception ignored) { }
        }
    }
    public long lastTestReceived() { return prefs.getLong("last_test_received", 0); }
    public String lastTestId() { return prefs.getString("last_test_id", ""); }
    public void messageReceived() { prefs.edit().putLong("last_message_received_at", System.currentTimeMillis()).apply(); }
    public void messageOutcome(String code) {
        if (code == null || !code.matches("[a-z_]{1,48}")) return;
        prefs.edit().putString("last_message_outcome", code).putLong("last_message_outcome_at", System.currentTimeMillis()).apply();
    }
    public long lastMessageReceivedAt() { return prefs.getLong("last_message_received_at", 0); }
    public String lastMessageOutcome() { return prefs.getString("last_message_outcome", ""); }

    /** Serialised deduplication, with terminal tombstones retained for 24 hours. */
    public boolean incoming(String id, long issued, long expiry) {
        synchronized (EVENT_LOCK) {
        long now = System.currentTimeMillis();
        if (!HubPolicy.validCallId(id) || !HubPolicy.freshIncoming(issued, expiry, now) || !enrolled()) return false;
        prune(now);
        try {
            JSONObject record = new JSONObject(prefs.getString("call:" + id, "{}"));
            if (record.optBoolean("terminal") || record.optBoolean("dismissed")) return false;
            if (record.optLong("issued") >= issued) return false;
            JSONObject next = new JSONObject().put("issued", issued).put("expiry", expiry).put("stored", now);
            prefs.edit().putString("call:" + id, next.toString()).commit();
            return true;
        } catch (Exception ignored) { return false; }
            }
    }
    public void terminate(String id) {
        synchronized (EVENT_LOCK) {
        if (!HubPolicy.validCallId(id)) return;
        try { prefs.edit().putString("call:" + id, new JSONObject().put("terminal", true).put("stored", System.currentTimeMillis()).toString()).commit(); }
        catch (Exception ignored) { }
            }
    }
    public void dismiss(String id) {
        synchronized (EVENT_LOCK) {
        if (!HubPolicy.validCallId(id)) return;
        try {
            JSONObject record = new JSONObject(prefs.getString("call:" + id, "{}"));
            record.put("dismissed", true).put("stored", System.currentTimeMillis());
            prefs.edit().putString("call:" + id, record.toString()).commit();
        } catch (Exception ignored) { }
            }
    }
    public boolean alertActive(String id) {
        try { JSONObject j = new JSONObject(prefs.getString("call:" + id, "{}")); return !j.optBoolean("terminal") && !j.optBoolean("dismissed") && j.optLong("expiry") > System.currentTimeMillis(); }
        catch (Exception ignored) { return false; }
    }
    private void prune(long now) {
        SharedPreferences.Editor edit = prefs.edit();
        for (String key : prefs.getAll().keySet()) if (key.startsWith("call:")) {
            try { if (now - new JSONObject(prefs.getString(key, "{}")).optLong("stored") > 86400000) edit.remove(key); }
            catch (Exception ignored) { edit.remove(key); }
        }
        edit.apply();
    }
}
