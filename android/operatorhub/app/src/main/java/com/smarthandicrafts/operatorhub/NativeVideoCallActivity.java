package com.smarthandicrafts.operatorhub;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.media.AudioManager;
import android.net.Uri;
import android.os.*;
import android.util.Rational;
import android.view.*;
import android.webkit.*;
import android.widget.*;
import androidx.core.content.ContextCompat;
import androidx.webkit.*;
import org.json.JSONObject;
import java.util.*;

/** Separate WebRTC screen. Voice-call room ownership and LiveKit are untouched. */
public final class NativeVideoCallActivity extends Activity {
    static final String ORIGIN = "https://ai-agent-debate.onrender.com";
    private WebView web;
    private LinearLayout root, shareBar;
    private String operatorUrl = "", customerUrl = "";
    private boolean ended, receiverRegistered, endRequested;
    private static final java.util.concurrent.ExecutorService CLEANUP = java.util.concurrent.Executors.newCachedThreadPool();
    private final BroadcastReceiver focusReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            if (intent.getBooleanExtra("failed", false)) { Toast.makeText(context, "Video could not acquire the microphone. Your other call stays active.", Toast.LENGTH_LONG).show(); endVideo(); return; }
            if (web != null) web.evaluateJavascript("window.SHVideoFocus?.(" + intent.getBooleanExtra("allowed", false) + ")", null);
        }
    };
    static boolean sameOrigin(Uri uri) { return uri != null && ORIGIN.equals(uri.getScheme() + "://" + uri.getAuthority()); }
    static void cancelLink(Context context, String url) {
        if (!validUrl(url, "operator")) return;
        String id = Uri.parse(url).getFragment().split("\\.")[0];
        Context app = context.getApplicationContext(); DeviceLeasePolicy.Credential credential = new NativeStore(app).credential();
        CLEANUP.execute(() -> {
            for (int attempt = 0; attempt < 2; attempt++) {
                if (!new NativeStore(app).matchesCredential(credential)) return;
                try { NativeApi.request("/video-calls/" + id + "/end", "POST", new JSONObject(), credential.bearer); return; }
                catch (Exception ignored) { /* Local media is already stopped; retry exact link only. */ }
            }
        });
    }
    private void requestEnd() { if (!endRequested) { endRequested = true; cancelLink(this, operatorUrl); } }
    static boolean validUrl(String url, String role) {
        if (url == null) return false;
        Uri parsed = Uri.parse(url);
        return ORIGIN.equals(parsed.getScheme() + "://" + parsed.getAuthority()) && "/video-call.html".equals(parsed.getPath()) && parsed.getQuery() == null &&
            parsed.getFragment() != null && parsed.getFragment().matches("[A-Za-z0-9_-]{32}\\." + role + "\\.[A-Za-z0-9_-]{32}");
    }
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        if (getIntent().getBooleanExtra("end", false)) { NativeVideoCallService.end(this); finish(); return; }
        if (NativeRoomCallService.isRunning()) { Toast.makeText(this, "Finish your voice call before opening video.", Toast.LENGTH_LONG).show(); finish(); return; }
        operatorUrl = getIntent().getStringExtra("operator_url"); customerUrl = getIntent().getStringExtra("customer_url");
        if (!validUrl(operatorUrl, "operator") || !validUrl(customerUrl, "customer")) { NativeVideoCallService.end(this); finish(); return; }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(0xff101e24); setContentView(root);
        shareBar = new LinearLayout(this); shareBar.setOrientation(LinearLayout.HORIZONTAL);
        Button share = new Button(this); share.setText("Share customer link"); share.setOnClickListener(v -> {
            Intent send = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "Join our private SH Chat video call: " + customerUrl);
            startActivity(Intent.createChooser(send, "Send video invitation"));
        });
        Button copy = new Button(this); copy.setText("Copy link"); copy.setOnClickListener(v -> {
            getSystemService(ClipboardManager.class).setPrimaryClip(ClipData.newPlainText("Private SH Chat video invitation", customerUrl));
            Toast.makeText(this, "Customer link copied. Paste it into your chat.", Toast.LENGTH_LONG).show();
        });
        shareBar.addView(share, new LinearLayout.LayoutParams(0, -2, 1)); shareBar.addView(copy, new LinearLayout.LayoutParams(0, -2, 1)); root.addView(shareBar);
        ContextCompat.registerReceiver(this, focusReceiver, new IntentFilter(NativeVideoCallService.FOCUS), ContextCompat.RECEIVER_NOT_EXPORTED); receiverRegistered = true;
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED || checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(new String[]{Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO}, 240);
        else openPage();
    }
    private void openPage() {
        if (ended || web != null) return;
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) { Toast.makeText(this, "Update Android System WebView to use video calls.", Toast.LENGTH_LONG).show(); finish(); return; }
        web = new WebView(this); root.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));
        WebSettings settings = web.getSettings(); settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(false);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(false); settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW); settings.setMediaPlaybackRequiresUserGesture(false);
        WebViewCompat.addWebMessageListener(web, "SHVideoNative", Collections.singleton(ORIGIN), (view, message, origin, mainFrame, reply) -> {
            if (!mainFrame || !sameOrigin(origin) || ended) return;
            try {
                JSONObject data = new JSONObject(message.getData()); String type = data.optString("type");
                if ("ended".equals(type)) endVideo();
                else if ("speaker".equals(type)) {
                    AudioManager audio = getSystemService(AudioManager.class); audio.setSpeakerphoneOn(data.optBoolean("enabled"));
                    web.evaluateJavascript("window.SHVideoSpeaker?.(" + audio.isSpeakerphoneOn() + ")", null);
                }
            } catch (Exception ignored) { }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return !validUrl(request.getUrl().toString(), "operator"); }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, android.net.http.SslError error) { handler.cancel(); endVideo(); }
            @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) { endVideo(); return true; }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) {
                if (ended || NativeRoomCallService.isRunning() || !sameOrigin(request.getOrigin()) || !hasWindowFocus()) { request.deny(); return; }
                for (String resource : request.getResources()) if (!PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource) && !PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) { request.deny(); return; }
                try { NativeVideoCallService.begin(NativeVideoCallActivity.this); request.grant(request.getResources()); }
                catch (RuntimeException failure) { request.deny(); endVideo(); }
            }
        });
        web.loadUrl(operatorUrl);
    }
    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request != 240) return;
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) openPage();
        else { Toast.makeText(this, "Camera and microphone access are needed for video.", Toast.LENGTH_LONG).show(); finish(); }
    }
    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); if (intent.getBooleanExtra("end", false)) endVideo(); }
    private void endVideo() {
        if (ended) return; ended = true;
        requestEnd();
        if (web != null) web.evaluateJavascript("window.SHVideoEnd?.()", null);
        NativeVideoCallService.end(this); finish();
    }
    @Override public void onBackPressed() {
        if (NativeVideoCallService.isRunning() && getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) {
            enterPictureInPictureMode(new PictureInPictureParams.Builder().setAspectRatio(new Rational(3, 4)).build());
            startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT));
        } else if (!NativeVideoCallService.isRunning()) endVideo();
        else moveTaskToBack(true);
    }
    @Override protected void onUserLeaveHint() {
        super.onUserLeaveHint(); if (NativeVideoCallService.isRunning() && !ended && getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE))
            enterPictureInPictureMode(new PictureInPictureParams.Builder().setAspectRatio(new Rational(3, 4)).build());
    }
    @Override public void onPictureInPictureModeChanged(boolean inPip, Configuration config) { super.onPictureInPictureModeChanged(inPip, config); if (shareBar != null) shareBar.setVisibility(inPip ? View.GONE : View.VISIBLE); }
    @Override protected void onStop() { super.onStop(); if (web != null && !isInPictureInPictureMode()) web.evaluateJavascript("window.SHVideoBackground?.()", null); }
    @Override protected void onDestroy() {
        requestEnd();
        if (receiverRegistered) unregisterReceiver(focusReceiver);
        if (web != null) { web.evaluateJavascript("window.SHVideoEnd?.()", null); web.destroy(); web = null; }
        NativeVideoCallService.end(this); super.onDestroy();
    }
}
