package com.smarthandicrafts.operatorhub;

import android.content.Context;
import android.os.SystemClock;
import org.json.JSONObject;

/** Current authenticated server capability, never inferred from a push or a web constant. */
public final class NativeRoomCapabilities {
    private static final NativeRoomCapabilityCache CACHE = new NativeRoomCapabilityCache();
    public static synchronized boolean refresh(Context context, DeviceLeasePolicy.Credential credential) throws Exception {
        NativeStore store = new NativeStore(context);
        if (!store.matchesCredential(credential) || !DeviceLeasePolicy.valid(store.credential(), System.currentTimeMillis())) return false;
        // Startup/settings checks reuse a fresh authenticated hint. Answer/Call sends directly
        // to /accept or /outgoing, where the server authorizes the actual operation.
        Boolean fresh = CACHE.get(credential, SystemClock.elapsedRealtime());
        if (fresh != null) return fresh;
        try {
            JSONObject result = NativeApi.request("/capabilities", "GET", null, credential.bearer);
            if (!store.matchesCredential(credential)) return false;
            JSONObject capabilities = result.optJSONObject("capabilities");
            boolean enabled = capabilities != null && capabilities.optBoolean("nativeRoomCalls")
                && capabilities.optInt("minimumNativeBuild", Integer.MAX_VALUE) <= BuildConfig.VERSION_CODE
                && NativeRoomPolicy.PROTOCOL.equals(capabilities.optString("protocol", result.optString("protocol")));
            if (!store.roomCapabilitiesIfMatches(credential, enabled,
                    enabled && capabilities.optBoolean("transferEnabled"), System.currentTimeMillis())) return false;
            CACHE.remember(credential, enabled, SystemClock.elapsedRealtime());
            return enabled;
        } catch (Exception error) {
            if (store.matchesCredential(credential)) {
                int status = error instanceof NativeApi.ApiException ? ((NativeApi.ApiException)error).status : 0;
                if (status == 401 || status == 403 || status == 404) {
                    CACHE.clear(); store.roomCapabilitiesIfMatches(credential, false, false, System.currentTimeMillis());
                }
                if (status == 401) store.clearEnrollmentIfMatches(credential, error.getMessage());
                // A temporary outage retains the last UI hint, but cannot refresh an expired cache entry.
            }
            throw error;
        }
    }
    private NativeRoomCapabilities() { }
}
