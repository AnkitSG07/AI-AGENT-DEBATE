package com.smarthandicrafts.operatorhub;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;
import org.json.JSONObject;

public final class SettingsActivity extends Activity {
    private TextView status; private EditText code; private Button enroll; private boolean refreshing, serverReady;
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true); scroll.setBackgroundColor(NativeUi.background(this));
        LinearLayout panel = new LinearLayout(this); panel.setOrientation(LinearLayout.VERTICAL);
        int p = NativeUi.dp(this, 22); panel.setPadding(p, p, p, p); scroll.addView(panel);
        panel.addView(NativeUi.button(this, "Back to SH Chat", v -> finish()));
        panel.addView(NativeUi.text(this, "App settings", 28, true));
        panel.addView(NativeUi.text(this, "SH Chat · Smart Handicrafts · " + BuildConfig.VERSION_NAME, 14, false));
        status = NativeUi.text(this, "Checking background alert setup…", 16, false); panel.addView(status);
        panel.addView(NativeUi.button(this, "Check background alerts", v -> refresh()));
        panel.addView(NativeUi.button(this, "Send Firebase test notification", v -> sendTest()));
        panel.addView(NativeUi.button(this, "Allow notifications", v -> {
            if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 31);
            else openNotificationSettings();
        }));
        panel.addView(NativeUi.button(this, "Incoming-call screen settings", v -> {
            if (Build.VERSION.SDK_INT >= 34) startActivity(new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + getPackageName())));
            else openNotificationSettings();
        }));
        panel.addView(NativeUi.button(this, "Incoming-call sound and alert settings", v -> startActivity(new Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()).putExtra(Settings.EXTRA_CHANNEL_ID, CallAlerts.INCOMING))));
        panel.addView(NativeUi.text(this, "Enroll this operator device", 20, true));
        panel.addView(NativeUi.text(this, "Use the single-use enrollment code provided by your SH Chat administrator. Your Odoo login remains separate.", 14, false));
        code = new EditText(this); code.setSingleLine(true); code.setHint("Enrollment code"); code.setTextSize(16);
        code.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD); code.setImportantForAutofill(android.view.View.IMPORTANT_FOR_AUTOFILL_NO);
        panel.addView(code, new LinearLayout.LayoutParams(-1, NativeUi.dp(this, 56)));
        enroll = NativeUi.button(this, "Enable background alerts", v -> enrollDevice()); panel.addView(enroll);
        panel.addView(NativeUi.button(this, "Disable alerts on this device", v -> unregister()));
        panel.addView(NativeUi.text(this, "Accept opens the exact native call. Decline rejects that invitation; Dismiss silences this phone. An active call continues when you return to chat.", 14, false));
        panel.addView(NativeUi.text(this, "Android notification permissions, Focus/Do Not Disturb, connectivity and battery settings affect delivery. After Force stop in Android settings, reopen SH Chat. Active audio requires a working network connection.", 13, false));
        setContentView(scroll); refresh();
    }
    private void openNotificationSettings() { startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName())); }
    private void refresh() {
        if (refreshing) return; refreshing = true; status.setText("Checking the native notification service…");
        HubApplication.IO.execute(() -> {
            try {
                JSONObject config = NativeApi.request("/config", "GET", null, null);
                boolean enabled = config.optBoolean("enabled") && "com.smarthandicrafts.operatorhub".equals(config.optString("packageName"));
                NativeStore store = new NativeStore(this); store.serverEnabled(enabled);
                HubApplication application = (HubApplication)getApplication();
                application.recordBackendCapabilities(config);
                boolean initialized = enabled && application.initializeFirebase(config.optJSONObject("firebase"));
                if (initialized) application.maybeRenewDeviceLease();
                if (initialized && store.enrolled()) {
                    try { NativeRoomCapabilities.refresh(this, store.credential()); }
                    catch (Exception ignored) { /* Enrollment is retained; show the last confirmed call capability below. */ }
                }
                runOnUiThread(() -> {
                    refreshing = false; serverReady = enabled && initialized;
                    if (!serverReady) showStatus("Background alerts are not configured on the backend yet. You can continue using SH Chat while it is open.");
                    else if (store.enrolled()) showStatus("This device is enrolled for background alerts.");
                    else if (!store.token().isEmpty()) showStatus("This device's enrollment has expired. Ask your administrator for a new enrollment code.");
                    else showStatus("The backend is ready. Enter your administrator's enrollment code to enable this device.");
                });
            } catch (Exception e) { runOnUiThread(() -> { refreshing = false; serverReady = false; showStatus(e.getMessage() + "\nBackground alert readiness has not been verified."); }); }
        });
    }
    private void showStatus(String heading) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        String permission = nm.areNotificationsEnabled() ? "Notifications: allowed" : "Notifications: not allowed";
        String client = FirebaseApp.getApps(this).isEmpty() ? "Firebase client: not configured" : "Firebase client: configured";
        String full = Build.VERSION.SDK_INT < 34 || nm.canUseFullScreenIntent() ? "Incoming-call screen: allowed" : "Incoming-call screen: requires Android settings permission";
        android.app.NotificationChannel incoming = nm.getNotificationChannel(CallAlerts.INCOMING);
        String channel = incoming == null ? "Incoming-call channel: not created" : incoming.getImportance() == NotificationManager.IMPORTANCE_NONE
            ? "Incoming-call channel: blocked" : incoming.getImportance() < NotificationManager.IMPORTANCE_HIGH
            ? "Incoming-call channel: quiet; turn on alerting for call banners" : incoming.getSound() == null
            ? "Incoming-call channel: allowed, sound is off" : "Incoming-call channel: alerting with sound";
        long received = new NativeStore(this).lastTestReceived();
        String lastReceipt = received > 0 ? "\nLast Firebase test received: " + java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.SHORT, java.text.DateFormat.SHORT).format(new java.util.Date(received)) : "\nNo Firebase test has been received on this installation yet.";
        NativeStore store = new NativeStore(this);
        String audio = store.audioFailureCode().isEmpty() ? "" : "\nLast call audio problem: " + store.audioFailureCode()
            + "\n" + java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.SHORT, java.text.DateFormat.SHORT).format(new java.util.Date(store.audioFailureAt()));
        String calling = store.nativeRoomCalls() ? "Native calls: enabled by server" : "Native calls: not yet confirmed; use Check background alerts";
        status.setText(heading + "\n\n" + client + "\n" + permission + "\n" + channel + "\n" + full + "\n" + calling + lastReceipt + audio); enroll.setEnabled(serverReady && !refreshing);
    }
    private void enrollDevice() {
        String enrollmentCode = code.getText().toString().trim();
        if (!serverReady) { showStatus("Check the backend setup first."); return; }
        if (enrollmentCode.isEmpty() || enrollmentCode.length() > 200) { code.setError("Enter the administrator's enrollment code"); return; }
        enroll.setEnabled(false); status.setText("Registering this device…");
        NativeStore pendingStore = new NativeStore(this);
        long enrollmentGeneration = pendingStore.credential().generation;
        FirebaseMessaging.getInstance().getToken().addOnSuccessListener(token -> HubApplication.IO.execute(() -> {
            try {
                NativeStore store = new NativeStore(this);
                if (store.credential().generation != enrollmentGeneration) return;
                store.setFcmToken(token);
                JSONObject data = new JSONObject().put("installationId", store.installationId()).put("fcmToken", token)
                    .put("enrollmentCode", enrollmentCode).put("deviceLabel", Build.MANUFACTURER + " " + Build.MODEL)
                    .put("nativeBuild", BuildConfig.VERSION_CODE).put("mediaProtocol", NativeRoomPolicy.PROTOCOL).put("nativeRoomCalls", true);
                JSONObject response = NativeApi.request("/devices/register", "POST", data, null);
                if (response.optString("deviceToken").isEmpty() || response.optString("deviceId").isEmpty() || response.optLong("expiresAt") <= System.currentTimeMillis()) throw new Exception("The server returned an incomplete registration.");
                if (!store.enrollIfGeneration(response, enrollmentGeneration)) {
                    // A locally cancelled registration must not restore alerts.
                    // Do not revoke a newer enrollment that recovered the same bearer.
                    if (!response.optString("deviceToken").equals(store.token())) {
                        try { NativeApi.request("/devices/unregister", "POST", new JSONObject(), response.optString("deviceToken")); } catch (Exception ignored) { }
                    }
                    if (store.credential().generation == enrollmentGeneration) throw new Exception("Device enrollment could not be saved. Please try again.");
                    return;
                }
                ((HubApplication)getApplication()).maybeRenewDeviceLease();
                DeviceLeasePolicy.Credential confirmed = new DeviceLeasePolicy.Credential(response.optString("deviceId"),
                    response.optString("deviceToken"), response.optLong("expiresAt"), enrollmentGeneration + 1);
                // Finish client protocol registration even if the operator backgrounds Settings
                // without returning to MainActivity. Capability failure does not erase enrollment.
                boolean registeredForCalls;
                try { registeredForCalls = NativeRoomCapabilities.refresh(this, confirmed); }
                catch (Exception ignored) { registeredForCalls = false; }
                final boolean callReady = registeredForCalls;
                runOnUiThread(() -> {
                    if (store.matchesCredential(confirmed)) { code.setText(""); showStatus(callReady
                        ? "Device enrollment and native call capability confirmed. Test delivery on this phone."
                        : "Device enrollment saved. Use Check background alerts to finish verifying native calls."); }
                });
            } catch (Exception e) { runOnUiThread(() -> { if (pendingStore.credential().generation == enrollmentGeneration) showStatus(e.getMessage()); }); }
        })).addOnFailureListener(e -> {
            if (pendingStore.credential().generation == enrollmentGeneration) { enroll.setEnabled(true); showStatus("Firebase could not register this phone. Check Google Play services and network access, then retry."); }
        });
    }
    private void unregister() {
        NativeStore store = new NativeStore(this);
        DeviceLeasePolicy.Credential removed = store.clearEnrollmentAndSnapshot(); String token = removed.bearer;
        NotificationManager nm = getSystemService(NotificationManager.class);
        for (android.service.notification.StatusBarNotification n : nm.getActiveNotifications()) if (n.getId() != 200) nm.cancel(n.getTag(), n.getId());
        if (!FirebaseApp.getApps(this).isEmpty()) { FirebaseMessaging.getInstance().setAutoInitEnabled(false); FirebaseMessaging.getInstance().deleteToken(); }
        showStatus("Background alerts disabled on this phone.");
        if (!token.isEmpty()) HubApplication.IO.execute(() -> {
            try { NativeApi.request("/devices/unregister", "POST", new JSONObject(), token); }
            catch (Exception e) { runOnUiThread(() -> {
                if (store.credential().generation == removed.generation + 1) showStatus("Alerts are disabled locally. Server unregister was not confirmed; ask the administrator to revoke this device if needed.");
            }); }
        });
    }
    private void sendTest() {
        NativeStore store = new NativeStore(this);
        if (!store.enrolled()) { showStatus("Enroll this device before testing background alerts."); return; }
        DeviceLeasePolicy.Credential credential = store.credential();
        long started = System.currentTimeMillis(); showStatus("Requesting a real Firebase test. Delivery is not confirmed yet.");
        HubApplication.IO.execute(() -> {
            try {
                if (!store.matchesCredential(credential)) return;
                JSONObject result = NativeApi.request("/devices/test", "POST", new JSONObject(), credential.bearer);
                String requestedTestId = result.optString("testId");
                if (requestedTestId.isEmpty()) throw new Exception("The backend did not return a test receipt identifier.");
                runOnUiThread(() -> {
                    if (!store.matchesCredential(credential)) return;
                    showStatus("The backend accepted the test request. Waiting for this phone to receive it…");
                    android.os.Handler handler = new android.os.Handler(android.os.Looper.getMainLooper());
                    handler.postDelayed(new Runnable() { int attempts = 0; public void run() {
                        if (isFinishing() || !store.matchesCredential(credential)) return;
                        if (store.lastTestReceived() >= started && requestedTestId.equals(store.lastTestId())) showStatus("Firebase delivery confirmed: this phone received this test push.");
                        else if (++attempts < 15) handler.postDelayed(this, 2000);
                        else showStatus("The backend accepted the request, but this phone has not confirmed receipt. Check permissions, connectivity and Firebase configuration.");
                    } }, 1000);
                });
            } catch (Exception e) {
                boolean unauthorized = e instanceof NativeApi.ApiException && ((NativeApi.ApiException)e).status == 401;
                if (unauthorized) {
                    if (!store.clearEnrollmentIfMatches(credential, e.getMessage())) return;
                } else if (!store.matchesCredential(credential)) return;
                runOnUiThread(() -> {
                    if (unauthorized ? store.credential().generation == credential.generation + 1 : store.matchesCredential(credential)) showStatus(e.getMessage());
                });
            }
        });
    }
    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) { super.onRequestPermissionsResult(requestCode, permissions, results); refresh(); }
}
