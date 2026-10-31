package com.smarthandicrafts.operatorhub;

import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import javax.net.ssl.HttpsURLConnection;

/** Backend-only JSON requests. Never forwards Odoo cookies or device bearer to another origin. */
public final class NativeApi {
    interface ConnectionFactory { HttpsURLConnection open(URL url) throws Exception; }
    private static ConnectionFactory connections = url -> (HttpsURLConnection)url.openConnection();
    public static JSONObject request(String path, String method, JSONObject data, String bearer) throws Exception {
        return request(path, method, data, bearer, 12000, 15000);
    }
    /** Short control/status requests must not block terminal reconciliation behind a long dial. */
    public static JSONObject controlRequest(String path, String method, JSONObject data, String bearer) throws Exception {
        return request(path, method, data, bearer, 3000, "GET".equals(method) ? 4000 : 8000);
    }
    /** Read-only Hub call records, with device credentials kept entirely in native code. */
    public static JSONObject hubRead(String path, String bearer) throws Exception {
        if (!NativeHubReadPolicy.allowedPath(path)) throw new Exception("Unsupported Hub call read.");
        return request("https://ai-agent-debate.onrender.com", path, "GET", null, bearer, 4000, 8000, 512 * 1024, true);
    }
    private static JSONObject request(String path, String method, JSONObject data, String bearer, int connectMs, int readMs) throws Exception {
        return request(HubPolicy.API_BASE, path, method, data, bearer, connectMs, readMs, 65536, false);
    }
    private static JSONObject request(String base, String path, String method, JSONObject data, String bearer, int connectMs, int readMs, int maxBytes, boolean requireHistoryProjection) throws Exception {
        if (!path.startsWith("/") || path.contains("..")) throw new Exception("Invalid request path");
        HttpsURLConnection c = connections.open(new URL(base + path));
        long started = android.os.SystemClock.elapsedRealtime();
        int observedStatus = 0;
        c.setConnectTimeout(connectMs); c.setReadTimeout(readMs); c.setInstanceFollowRedirects(false);
        c.setRequestMethod(method); c.setRequestProperty("Accept", "application/json");
        if (bearer != null && !bearer.isEmpty()) {
            c.setRequestProperty("Authorization", "Bearer " + bearer);
            c.setRequestProperty("X-SH-Native-Build", String.valueOf(BuildConfig.VERSION_CODE));
            c.setRequestProperty("X-SH-Media-Protocol", NativeRoomPolicy.PROTOCOL);
        }
        try {
            if (data != null) {
                byte[] bytes = data.toString().getBytes(StandardCharsets.UTF_8);
                c.setDoOutput(true); c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                c.setFixedLengthStreamingMode(bytes.length);
                try (java.io.OutputStream out = c.getOutputStream()) { out.write(bytes); }
            }
            int status = c.getResponseCode();
            observedStatus = status;
            if (requireHistoryProjection && status >= 200 && status < 300 && !"sh-call-history-v1".equals(c.getHeaderField("X-SH-Call-History")))
                throw new ApiException(503, "Call history needs the updated backend.");
            InputStream in = status >= 200 && status < 300 ? c.getInputStream() : c.getErrorStream();
            String text = "";
            if (in != null) try (InputStream stream = in; ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[4096]; int count;
                while ((count = stream.read(buffer)) != -1) { bytes.write(buffer, 0, count); if (bytes.size() > maxBytes) throw new Exception("Response too large"); }
                text = bytes.toString(StandardCharsets.UTF_8.name());
            }
            JSONObject result;
            try { result = new JSONObject(text); } catch (Exception ignored) { result = new JSONObject(); }
            if (status < 200 || status >= 300 || !result.optBoolean("ok", false)) {
                if (status == 401 || status == 403) throw new ApiException(status, "Device authorization expired or was denied. Enroll this device again.", result);
                if (status == 404) throw new ApiException(status, "Native call service is unavailable or this call has ended.", result);
                if (status == 409) throw new ApiException(status, path.startsWith("/devices/enroll")
                    ? "This enrollment code has already been used. Request a new code."
                    : "The call state changed. Checking the current call before continuing.", result);
                if (status == 429) throw new ApiException(status, "Too many attempts. Please wait and try again.", result);
                throw new ApiException(status, "The native service did not confirm the request (" + status + ").", result);
            }
            return result;
        } finally {
            c.disconnect();
            if (path.startsWith("/calls/")) {
                String action = path.endsWith("/status") ? "status" : path.endsWith("/end") ? "end"
                    : path.endsWith("/ready") ? "ready" : path.endsWith("/accept") ? "accept"
                    : path.endsWith("/cancel") ? "cancel" : path.endsWith("/transfers") ? "transfer-invite"
                    : path.endsWith("/outgoing") ? "outgoing" : "call-control";
                // Fixed stage names only: never log paths, tokens or customer details.
                android.util.Log.i("SHCallTiming", action + " elapsedMs=" + (android.os.SystemClock.elapsedRealtime() - started) + " status=" + observedStatus);
            }
        }
    }
    public static final class ApiException extends Exception {
        public final int status;
        public final String errorCode, sessionId, permissionRequestId, permissionRequestState;
        ApiException(int status, String text) { this(status, text, new JSONObject()); }
        ApiException(int status, String text, JSONObject response) {
            super(text); this.status = status;
            JSONObject error = response.optJSONObject("error");
            errorCode = response.optString("code", error == null ? "" : error.optString("code"));
            String id = NativeRoomJson.text(response,"sessionId", NativeRoomJson.text(error,"sessionId"));
            sessionId = HubPolicy.validCallId(id) ? id : "";
            JSONObject permissionRequest=response.optJSONObject("request");
            String permissionId=permissionRequest==null?"":permissionRequest.optString("requestId");
            String permissionState=permissionRequest==null?"":permissionRequest.optString("state");
            permissionRequestId=NativeCallPermissionState.validRequestId(permissionId)?permissionId:"";
            permissionRequestState=permissionState.matches("sending|sent|uncertain|blocked")?permissionState:"";
        }
    }
    private NativeApi() { }
}
