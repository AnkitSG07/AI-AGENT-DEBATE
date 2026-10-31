package com.smarthandicrafts.operatorhub;

import org.json.JSONObject;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;

/** The retryable server half of local End/Decline. Its queue holds hashes, never bearer tokens. */
final class NativeRoomCleanupProcessor {
    static final long MAX_AGE_MS = 24L * 60 * 60 * 1000;
    interface Queue {
        List<String> keys();
        JSONObject read(String key) throws Exception;
        void remove(String key, String requestId) throws Exception;
        void update(String key, String requestId, JSONObject value) throws Exception;
    }
    interface Device {
        DeviceLeasePolicy.Credential current();
        void unauthorized(DeviceLeasePolicy.Credential expected, String message);
        void problem(DeviceLeasePolicy.Credential expected, String message);
    }
    interface Requester { JSONObject request(String path, String method, JSONObject body, String bearer) throws Exception; }
    private final Queue queue;
    private final Device device;
    private final Requester api;
    NativeRoomCleanupProcessor(Queue queue, Device device, Requester api) { this.queue = queue; this.device = device; this.api = api; }

    boolean runPass(long now) {
        boolean pending = false;
        for (String key : queue.keys()) {
            JSONObject record = null;
            DeviceLeasePolicy.Credential credential = device.current();
            try {
                record = queue.read(key);
                if (record == null) continue;
                String requestId = record.optString("requestId");
                if (!matches(credential, record) || now - record.optLong("createdAt", 0) > MAX_AGE_MS
                    || !DeviceLeasePolicy.valid(credential, now)) { queue.remove(key, requestId); continue; }
                String outgoing = record.optString("outgoingRequestId");
                if (outgoing.matches("[A-Za-z0-9_-]{16,100}")) {
                    api.request("/calls/outgoing/" + encode(outgoing) + "/cancel", "POST",
                        new JSONObject().put("requestId", outgoing), credential.bearer);
                    queue.remove(key, requestId); continue;
                }
                String id = record.optString("callId"), transferId = record.optString("transferId");
                if (!HubPolicy.validCallId(id)) { queue.remove(key, requestId); continue; }
                String expectedLeg = record.optString("ownerLegId");
                if ("end".equals(record.optString("intent")) && transferId.isEmpty() && !expectedLeg.isEmpty()) {
                    // Current server validates ownership + immutable leg atomically.
                    // A status GET here added a full phone/server/database round trip.
                    if (!DeviceLeasePolicy.sameIdentity(credential, device.current())) { queue.remove(key, requestId); continue; }
                    try {
                        api.request("/calls/" + encode(id) + "/end", "POST",
                            new JSONObject().put("requestId", requestId).put("expectedOwnerLegId", expectedLeg), credential.bearer);
                        queue.remove(key, requestId); continue;
                    } catch (NativeApi.ApiException error) {
                        // R13 servers require the older versioned contract. Keep
                        // compatibility while the backend/APK rollout overlaps.
                        if (!"STALE_CALL_VERSION".equals(error.errorCode)) throw error;
                    }
                }
                JSONObject call = api.request("/calls/" + encode(id) + "/status", "GET", null, credential.bearer).getJSONObject("call");
                if (!DeviceLeasePolicy.sameIdentity(credential, device.current())) { queue.remove(key, requestId); continue; }
                JSONObject transfer = call.optJSONObject("transfer");
                String transferKey = transfer == null ? "" : transfer.optString("transferId", transfer.optString("id"));
                String transferStatus = transfer == null ? "" : transfer.optString("status");
                String target = transfer == null ? "" : transfer.optString("toDeviceId");
                NativeRoomPolicy.Cleanup action = "decline".equals(record.optString("intent"))
                    ? NativeRoomPolicy.declineAction(credential.deviceId, NativeRoomJson.text(call,"ownerDeviceId"), call.optString("phase"), transferId, transferKey, transferStatus, target)
                    : NativeRoomPolicy.cleanupAction(credential.deviceId, NativeRoomJson.text(call,"ownerDeviceId"), call.optString("phase"), transferId, transferKey, transferStatus, target);
                // Never adopt a newly observed owner leg for an old queued End (A -> B -> A).
                if (action == NativeRoomPolicy.Cleanup.END && !expectedLeg.isEmpty() && !expectedLeg.equals(NativeRoomJson.text(call,"ownerLegId"))) action = NativeRoomPolicy.Cleanup.NONE;
                if (action == NativeRoomPolicy.Cleanup.END && !transferId.isEmpty() && expectedLeg.isEmpty() && !transferId.equals(transferKey)) action = NativeRoomPolicy.Cleanup.NONE;
                if (action != NativeRoomPolicy.Cleanup.NONE) {
                    String suffix = action == NativeRoomPolicy.Cleanup.END ? "/end" : action == NativeRoomPolicy.Cleanup.REJECT ? "/reject" : "/transfers/" + encode(transferId) + "/decline";
                    JSONObject body = new JSONObject().put("version", call.optLong("version", -1)).put("requestId", requestId);
                    if (action == NativeRoomPolicy.Cleanup.END && !expectedLeg.isEmpty()) body.put("expectedOwnerLegId", expectedLeg);
                    api.request("/calls/" + encode(id) + suffix, "POST", body, credential.bearer);
                }
                queue.remove(key, requestId);
            } catch (Exception error) {
                if (record == null) continue;
                String requestId = record.optString("requestId");
                int status = error instanceof NativeApi.ApiException ? ((NativeApi.ApiException)error).status : 0;
                String code = error instanceof NativeApi.ApiException ? ((NativeApi.ApiException)error).errorCode : "";
                try {
                    if (!DeviceLeasePolicy.sameIdentity(credential, device.current())) queue.remove(key, requestId);
                    else if (status == 401) { device.unauthorized(credential, error.getMessage()); queue.remove(key, requestId); }
                    else if ((status == 404 && record.optString("outgoingRequestId").isEmpty())
                        || "CALL_LEG_CHANGED".equals(code) || "CALL_LEG_REQUIRED".equals(code)
                        || "NOT_CALL_OWNER".equals(code)) queue.remove(key, requestId);
                    else {
                        record.put("attempts", record.optInt("attempts") + 1);
                        queue.update(key, requestId, record); pending = true;
                        device.problem(credential, "Local audio stopped. Call cleanup is queued and will retry when the connection is available.");
                    }
                } catch (Exception ignored) { pending = true; }
            }
        }
        return pending;
    }
    static boolean matches(DeviceLeasePolicy.Credential credential, JSONObject record) throws Exception {
        return credential.deviceId.equals(record.optString("deviceId")) && credential.generation == record.optLong("generation", -1)
            && digest(credential.bearer).equals(record.optString("credentialHash"));
    }
    static String digest(String value) throws Exception {
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        StringBuilder result = new StringBuilder(); for (byte part : hash) result.append(String.format(java.util.Locale.ROOT, "%02x", part & 255)); return result.toString();
    }
    private static String encode(String value) throws Exception { return URLEncoder.encode(value, StandardCharsets.UTF_8.name()); }
}
