package com.smarthandicrafts.operatorhub;

import android.app.Application;
import com.google.firebase.FirebaseApp;
import com.google.firebase.FirebaseOptions;
import com.google.firebase.messaging.FirebaseMessaging;
import org.json.JSONObject;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class HubApplication extends Application {
    public static final ExecutorService IO = Executors.newFixedThreadPool(3);
    private boolean leaseCheckRunning;
    @Override public void onCreate() {
        super.onCreate(); CallAlerts.createChannels(this); MessageAlerts.createChannel(this);
        NativeStore store = new NativeStore(this);
        try {
            if (!store.config().isEmpty()) {
                JSONObject saved = new JSONObject(store.config());
                // FirebaseInitProvider uses the bundled public configuration on a cold start.
                // A deliberately saved backend project migration takes effect on this restart.
                if (!FirebaseApp.getApps(this).isEmpty() && !saved.optString("applicationId").isEmpty()
                    && !saved.optString("applicationId").equals(FirebaseApp.getInstance().getOptions().getApplicationId())) FirebaseApp.getInstance().delete();
                initializeFirebase(saved);
            }
        } catch (Exception ignored) { }
        maybeRenewDeviceLease();
        NativeRoomCleanup.drain(this);
    }
    public synchronized boolean initializeFirebase(JSONObject firebase) {
        if (firebase == null) return false;
        try {
            String appId = firebase.optString("applicationId"), project = firebase.optString("projectId"), key = firebase.optString("apiKey"), sender = firebase.optString("gcmSenderId");
            if (appId.isEmpty() || project.isEmpty() || key.isEmpty() || sender.isEmpty()) return false;
            if (FirebaseApp.getApps(this).isEmpty()) FirebaseApp.initializeApp(this, new FirebaseOptions.Builder()
                .setApplicationId(appId).setProjectId(project).setApiKey(key).setGcmSenderId(sender).build());
            else if (!FirebaseApp.getInstance().getOptions().getApplicationId().equals(appId)) {
                NativeStore changed = new NativeStore(this);
                changed.setConfig(firebase); changed.clearEnrollment(); changed.setFcmToken("");
                FirebaseMessaging.getInstance().setAutoInitEnabled(false); FirebaseMessaging.getInstance().deleteToken();
                changed.problem("Firebase project changed. Restart the app, then enroll this device again."); return false;
            }
            new NativeStore(this).setConfig(firebase);
            FirebaseMessaging.getInstance().setAutoInitEnabled(true);
            FirebaseMessaging.getInstance().getToken().addOnSuccessListener(token -> updateToken(token));
            return true;
        } catch (Exception ignored) { new NativeStore(this).problem("Firebase could not initialize. Check the backend public configuration."); return false; }
    }
    public void updateToken(String token) {
        NativeStore store = new NativeStore(this); store.setFcmToken(token);
        DeviceLeasePolicy.Credential credential = store.credential();
        if (DeviceLeasePolicy.valid(credential, System.currentTimeMillis())) IO.execute(() -> {
            try {
                if (!store.matchesCredential(credential) || !token.equals(store.fcmToken()) ||
                    !DeviceLeasePolicy.valid(store.credential(), System.currentTimeMillis())) return;
                JSONObject result = NativeApi.request("/devices/token", "POST", new JSONObject().put("fcmToken", token).put("receiveCalls", true)
                    .put("nativeBuild", BuildConfig.VERSION_CODE).put("mediaProtocol", NativeRoomPolicy.PROTOCOL).put("nativeRoomCalls", true), credential.bearer);
                // Older servers already return these fields, but expiry renewal is
                // advertised separately. A stale response may never shorten a lease.
                if (credential.deviceId.equals(result.optString("deviceId"))) store.applyLeaseExpiry(credential, result.optString("deviceId"), result.optLong("expiresAt"));
                store.problemIfMatches(credential, "");
            } catch (Exception e) { handleCredentialFailure(store, credential, e, true); }
            finally { maybeRenewDeviceLease(); }
        });
    }
    public void recordBackendCapabilities(JSONObject config) {
        NativeStore store = new NativeStore(this);
        JSONObject capabilities = config == null ? null : config.optJSONObject("capabilities");
        boolean enabled = config != null && config.optBoolean("enabled") && getPackageName().equals(config.optString("packageName"));
        store.leaseCapability(enabled && capabilities != null && capabilities.optBoolean("deviceLeaseRenewal"), System.currentTimeMillis());
    }
    public void maybeRenewDeviceLease() {
        NativeStore store = new NativeStore(this);
        final NativeStore.LeaseAttempt attempt;
        synchronized (this) {
            if (leaseCheckRunning) return;
            attempt = store.beginLeaseAttempt(System.currentTimeMillis());
            if (attempt == null) return;
            leaseCheckRunning = true;
        }
        IO.execute(() -> {
            DeviceLeasePolicy.Credential credential = attempt.credential;
            boolean credentialRequestSent = false;
            try {
                if (!store.matchesCredential(credential)) return;
                if (attempt.plan == DeviceLeasePolicy.Plan.CHECK_CAPABILITY) {
                    JSONObject config = NativeApi.request("/config", "GET", null, null);
                    recordBackendCapabilities(config);
                }
                // Recheck after the config request: local disable/re-enrollment or
                // an expired lease must win before any authenticated renewal is sent.
                DeviceLeasePolicy.Credential current = store.credential();
                if (!store.leaseRenewalSupported() || !DeviceLeasePolicy.sameIdentity(current, credential) ||
                    !DeviceLeasePolicy.valid(current, System.currentTimeMillis())) return;
                credentialRequestSent = true;
                JSONObject result = NativeApi.request("/devices/renew", "POST", new JSONObject(), credential.bearer);
                if (!credential.deviceId.equals(result.optString("deviceId")) || result.optLong("expiresAt") <= System.currentTimeMillis() ||
                    result.optLong("expiresAt") <= credential.expiresAt) {
                    throw new Exception("The backend did not confirm this device's enrollment renewal.");
                }
                boolean saved = store.applyLeaseExpiry(credential, result.optString("deviceId"), result.optLong("expiresAt"));
                if (!saved && store.matchesCredential(credential) && result.optLong("expiresAt") >= store.expiresAt()) {
                    store.problemIfMatches(credential, "The device renewal could not be saved. Please reopen the app and retry.");
                }
            } catch (Exception e) { handleCredentialFailure(store, credential, e, credentialRequestSent); }
            finally { synchronized (HubApplication.this) { leaseCheckRunning = false; } }
        });
    }
    private void handleCredentialFailure(NativeStore store, DeviceLeasePolicy.Credential credential, Exception error, boolean credentialRequestSent) {
        int status = error instanceof NativeApi.ApiException ? ((NativeApi.ApiException)error).status : 0;
        if (DeviceLeasePolicy.shouldInvalidate(status, credentialRequestSent, store.credential(), credential)) {
            store.clearEnrollmentIfMatches(credential, error.getMessage());
        } else {
            // In particular, storage/server 503 responses preserve enrollment.
            store.problemIfMatches(credential, error.getMessage());
        }
    }
}
