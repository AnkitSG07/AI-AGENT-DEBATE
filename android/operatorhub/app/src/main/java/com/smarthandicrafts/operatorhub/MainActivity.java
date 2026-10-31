package com.smarthandicrafts.operatorhub;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.content.Context;
import android.content.BroadcastReceiver;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.view.Gravity;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebResourceError;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import androidx.core.content.FileProvider;
import androidx.core.content.ContextCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import org.json.JSONObject;
import java.io.File;
import java.util.ArrayList;
import java.util.Collections;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.RejectedExecutionException;

public final class MainActivity extends Activity {
    private WebView web;
    private LinearLayout shell, toolbar;
    private FrameLayout pageFrame;
    private LinearLayout loadingCover;
    private TextView loadingTitle, loadingMessage;
    private ProgressBar loadingProgress;
    private Button retryPage, switchAccount;
    private TextView title;
    private boolean hubReady, visible;
    private boolean messageWindowFocused;
    private volatile long messageReadEpoch;
    private boolean bridgeSupported;
    private String startupScript = "";
    private final HubLaunchState launch = new HubLaunchState();
    private final NativeOperatorAuthWindow operatorAuthWindow = new NativeOperatorAuthWindow(this, () -> launch.generation(), this::openOtherUserNavigation);
    private void openOtherUserNavigation(String url) {
        if (web == null) return;
        if (HubPolicy.trustedOdoo(url)) {
            if (!activeCall.isEmpty()) { toast("Finish the call before opening another Odoo page."); return; }
            web.loadUrl(url);
        } else if (HubPolicy.externalWeb(url) && (!url.startsWith(NativeOperatorAuthPolicy.ORIGIN) || NativeOperatorAuthPolicy.allowedDocumentLink(url))) {
            try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE)); }
            catch (Exception ignored) { toast("No browser is available for this link."); }
        }
    }
    private final Handler startupHandler = new Handler(Looper.getMainLooper());
    private Runnable loadingTimeout;
    private Runnable loadingProbe;
    private String pendingCall = "", activeCall = "";
    private int pendingChannel;
    private long intentGeneration;
    private PermissionRequest microphoneRequest;
    private ValueCallback<Uri[]> fileCallback;
    private Uri cameraOutput;
    private boolean nativeRoomReceiverRegistered;
    private String publishedNativeCapabilities = "";
    private final NativeCallCloseQueue pendingNativeCloses = new NativeCallCloseQueue();
    // History polling cannot occupy the executor used to answer or finish calls.
    private final ThreadPoolExecutor hubReadIO = new ThreadPoolExecutor(2, 2, 30, TimeUnit.SECONDS,
        new ArrayBlockingQueue<>(4), new ThreadPoolExecutor.AbortPolicy());
    // Message polling and unread acknowledgements cannot queue ahead of call controls.
    private final ThreadPoolExecutor messageStateIO = new ThreadPoolExecutor(2, 2, 30, TimeUnit.SECONDS,
        new ArrayBlockingQueue<>(4), new ThreadPoolExecutor.AbortPolicy());
    interface MessageStateRequester { JSONObject request(String operation, JSONObject body, String bearer) throws Exception; }
    private MessageStateRequester messageStateRequester = NativeApi::appMessageState;
    private final BroadcastReceiver nativeRoomReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            try {
                JSONObject call = new JSONObject(intent.getStringExtra("snapshot"));
                if (call.optBoolean("closed")) rememberNativeClose(call.optString("callId"), call.optString("providerCallId"), call.optString("clientAttemptId"), call.optString("ownerLegId"));
            } catch (Exception ignored) { }
            publishNativeCallCapabilities(); dispatchPending();
        }
    };

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        shell = new LinearLayout(this); shell.setOrientation(LinearLayout.VERTICAL);
        toolbar = new LinearLayout(this); toolbar.setGravity(android.view.Gravity.CENTER_VERTICAL);
        int horizontal = NativeUi.dp(this, 12); toolbar.setPadding(horizontal, 0, horizontal, 0);
        title = NativeUi.text(this, "SH Chat", 12, true); title.setPadding(0, 0, 0, 0);
        toolbar.addView(title, new LinearLayout.LayoutParams(0, -1, 1)); title.setGravity(android.view.Gravity.CENTER_VERTICAL);
        Button settings = new Button(this); settings.setText("App settings"); settings.setTextSize(11); settings.setAllCaps(false); settings.setMinHeight(0); settings.setMinimumHeight(0); settings.setPadding(horizontal, 0, horizontal, 0);
        settings.setOnClickListener(v -> startActivity(new Intent(this, SettingsActivity.class)));
        toolbar.addView(settings, new LinearLayout.LayoutParams(-2, -1)); shell.addView(toolbar, new LinearLayout.LayoutParams(-1, NativeUi.dp(this, 34)));
        pageFrame = new FrameLayout(this); shell.addView(pageFrame, new LinearLayout.LayoutParams(-1, 0, 1));
        web = new WebView(this); pageFrame.addView(web, new FrameLayout.LayoutParams(-1, -1));
        createLoadingCover(); setContentView(shell);
        updateTheme(); configureWebView();
        ContextCompat.registerReceiver(this, nativeRoomReceiver, new IntentFilter(NativeRoomNotifications.CHANGED), ContextCompat.RECEIVER_NOT_EXPORTED);
        nativeRoomReceiverRegistered = true;
        // Let Odoo choose the logged-in redirect or its real authentication form.
        // Opening the protected Hub first used to expose its 403/404 page on a new install.
        loadAuthentication(false); handleIntent(getIntent());
    }
    private void createLoadingCover() {
        loadingCover = new LinearLayout(this); loadingCover.setOrientation(LinearLayout.VERTICAL);
        loadingCover.setGravity(Gravity.CENTER); int pad = NativeUi.dp(this, 30);
        loadingCover.setPadding(pad, pad, pad, pad); loadingCover.setClickable(true);
        ImageView logo = new ImageView(this); logo.setImageBitmap(NativeBrand.logo(this));
        logo.setContentDescription("Smart Handicrafts logo");
        loadingCover.addView(logo, new LinearLayout.LayoutParams(NativeUi.dp(this, 88), NativeUi.dp(this, 88)));
        loadingTitle = NativeUi.text(this, "SH Chat", 30, true); loadingTitle.setGravity(Gravity.CENTER);
        loadingCover.addView(loadingTitle);
        loadingMessage = NativeUi.text(this, "Opening your workspace…", 16, false); loadingMessage.setGravity(Gravity.CENTER);
        loadingMessage.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); loadingCover.addView(loadingMessage);
        loadingProgress = new ProgressBar(this); loadingProgress.setIndeterminateTintList(android.content.res.ColorStateList.valueOf(NativeBrand.GREEN));
        LinearLayout.LayoutParams progressSize = new LinearLayout.LayoutParams(NativeUi.dp(this, 30), NativeUi.dp(this, 30));
        progressSize.setMargins(0, NativeUi.dp(this, 20), 0, NativeUi.dp(this, 22)); loadingCover.addView(loadingProgress, progressSize);
        retryPage = NativeUi.button(this, "Try again", v -> loadAuthentication(false)); loadingCover.addView(retryPage);
        switchAccount = NativeUi.button(this, "Use another Odoo account", v -> loadAuthentication(true)); loadingCover.addView(switchAccount);
        pageFrame.addView(loadingCover, new FrameLayout.LayoutParams(-1, -1));
    }
    private void loadAuthentication(boolean changeAccount) {
        if (web == null) { recreate(); return; }
        launch.requestAuthentication(); showLoading("Opening your workspace…");
        web.loadUrl(changeAccount ? HubPolicy.SWITCH_ACCOUNT_URL : HubPolicy.LOGIN_URL);
    }
    private void showLoading(String message) {
        messageReadEpoch++;
        if (loadingTimeout != null) startupHandler.removeCallbacks(loadingTimeout);
        if (loadingProbe != null) startupHandler.removeCallbacks(loadingProbe);
        loadingTitle.setText("SH Chat"); loadingMessage.setText(message);
        loadingProgress.setVisibility(View.VISIBLE); retryPage.setVisibility(View.GONE); switchAccount.setVisibility(View.GONE);
        loadingCover.setVisibility(View.VISIBLE); toolbar.setVisibility(View.GONE);
        web.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
    }
    private void armLoadingTimeout() {
        if (loadingTimeout != null) startupHandler.removeCallbacks(loadingTimeout);
        long generation = launch.generation();
        loadingTimeout = () -> {
            if (web != null && generation == launch.generation() && loadingCover.getVisibility() == View.VISIBLE) {
                showLoadingFailure("This is taking longer than expected. Check your connection and try again.", false);
            }
        };
        startupHandler.postDelayed(loadingTimeout, 30000);
        // The Hub initializes asynchronously after onPageFinished. Probe only while
        // covered, so old WebViews without the native bridge and late access errors
        // cannot leave an otherwise completed page hidden indefinitely.
        loadingProbe = new Runnable() {
            @Override public void run() {
                if (web == null || generation != launch.generation() || loadingCover.getVisibility() != View.VISIBLE) return;
                if (HubPolicy.trustedHubPage(web.getUrl())) inspectPageForReveal();
                startupHandler.postDelayed(this, 500);
            }
        };
        startupHandler.postDelayed(loadingProbe, 500);
    }
    private void showLoadingFailure(String message, boolean blockReveal) {
        messageReadEpoch++;
        if (loadingTimeout != null) startupHandler.removeCallbacks(loadingTimeout);
        if (loadingProbe != null) startupHandler.removeCallbacks(loadingProbe);
        if (blockReveal) launch.failed();
        loadingTitle.setText("Let’s get you connected"); loadingMessage.setText(message);
        loadingProgress.setVisibility(View.GONE); retryPage.setVisibility(View.VISIBLE); switchAccount.setVisibility(View.VISIBLE);
        loadingCover.setVisibility(View.VISIBLE); toolbar.setVisibility(View.GONE);
        if (web != null) web.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
    }
    private void handleAccessFailure() {
        if (launch.recoverAuthenticationOnce()) { loadAuthentication(false); return; }
        showLoadingFailure("Your Odoo account could not open SH Chat. Use an account with access to the Operator Hub, or ask your administrator to check its page permissions.", true);
    }
    private void inspectPageForReveal() {
        if (web == null || !HubPolicy.trustedOdoo(web.getUrl())) return;
        final long generation = launch.generation();
        if (!launch.isPrepared()) return;
        web.evaluateJavascript(HubPageStyle.SNAPSHOT, value -> {
            if (web == null || isFinishing() || isDestroyed() || generation != launch.generation()) return;
            try {
                JSONObject page = new JSONObject(value);
                if (page.optBoolean("hubError")) { handleAccessFailure(); return; }
                boolean fallback = !bridgeSupported && page.optBoolean("visibleHub");
                if (!launch.mayReveal(generation, page.optBoolean("styledAuth"), fallback)) return;
                // The WebView stays visible underneath the cover so Chromium can paint it.
                // Release the cover only after these styled DOM updates are ready to draw.
                web.postVisualStateCallback(generation, new WebView.VisualStateCallback() {
                    @Override public void onComplete(long requestId) {
                        if (web == null || loadingCover.getVisibility() != View.VISIBLE || generation != launch.generation() || !launch.mayReveal(generation, page.optBoolean("styledAuth"), fallback)) return;
                        if (loadingTimeout != null) startupHandler.removeCallbacks(loadingTimeout);
                        if (loadingProbe != null) startupHandler.removeCallbacks(loadingProbe);
                        loadingCover.setVisibility(View.GONE);
                        toolbar.setVisibility(HubPolicy.authPage(web.getUrl()) ? View.GONE : View.VISIBLE);
                        web.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_AUTO);
                        if (fallback && HubPolicy.trustedHubPage(web.getUrl())) {
                            launch.hubReady();
                            // The old embed does not register native-action listeners without
                            // SHNative. Do not consume a pending notification as if delivered.
                            if (pendingChannel > 0 || !pendingCall.isEmpty()) toast("Update Android System WebView to open notification links directly in SH Chat. You can select the conversation here.");
                        }
                        dispatchPending();
                    }
                });
            } catch (Exception ignored) { }
        });
    }
    private void configureWebView() {
        WebView.setWebContentsDebuggingEnabled(false);
        WebSettings s = web.getSettings(); s.setJavaScriptEnabled(true); s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false); s.setAllowContentAccess(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        // Only the guarded operator sign-in popup below can create a second WebView.
        s.setSupportMultipleWindows(true); s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportZoom(false); s.setBuiltInZoomControls(false); s.setDisplayZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(true); s.setSafeBrowsingEnabled(true);
        s.setUserAgentString(s.getUserAgentString() + " SHOperatorAndroid/" + BuildConfig.VERSION_NAME);
        CookieManager.getInstance().setAcceptCookie(true); CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        try {
            startupScript = HubPageStyle.script(this);
            if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                WebViewCompat.addDocumentStartJavaScript(web, startupScript, Collections.singleton(HubPolicy.ODOO_ORIGIN));
            }
        } catch (Exception ignored) { startupScript = ""; }
        bridgeSupported = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER);
        if (bridgeSupported) {
            WebViewCompat.addWebMessageListener(web, "SHNative", Collections.singleton(HubPolicy.ODOO_ORIGIN), (view, message, origin, isMainFrame, reply) -> {
                if (!isMainFrame || web != view || !HubPolicy.trustedOdoo(origin.toString()) || !HubPolicy.trustedHubPage(web.getUrl())) return;
                if (message.getType() != WebMessageCompat.TYPE_STRING) return;
                String data = message.getData(); if (data == null || data.length() > 4096) return;
                try { JSONObject obj = new JSONObject(data); runOnUiThread(() -> receiveBridge(obj)); } catch (Exception ignored) { }
            });
        }
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (HubPolicy.trustedOdoo(url)) {
                    if (request.isForMainFrame() && !activeCall.isEmpty() && HubPolicy.trustedHubPage(view.getUrl()) && !HubPolicy.sameDocumentFragment(view.getUrl(), url)) {
                        toast("Finish the call before opening another Odoo page.");
                        return true;
                    }
                    if (request.isForMainFrame() && launch.shouldReturnToHub(url)) { view.loadUrl(HubPolicy.HUB_URL); return true; }
                    return false;
                }
                if (request.isForMainFrame() && HubPolicy.externalWeb(url)) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl()).addCategory(Intent.CATEGORY_BROWSABLE)); } catch (Exception ignored) { toast("No browser is available for this link."); }
                }
                return true;
            }
            @Override public void onPageStarted(WebView view, String url, Bitmap icon) {
                messageReadEpoch++;
                operatorAuthWindow.close();
                hubReady = false;
                launch.navigation(url);
                showLoading(HubPolicy.authPage(url) ? "Preparing your secure sign-in…" : "Opening your workspace…"); armLoadingTimeout();
                if (!activeCall.isEmpty()) { activeCall = ""; stopService(new Intent(MainActivity.this, ActiveCallService.class)); }
                if (launch.shouldReturnToHub(url)) view.loadUrl(HubPolicy.HUB_URL);
            }
            @Override public void onPageFinished(WebView view, String url) {
                CookieManager.getInstance().flush();
                if (web != view || !url.equals(view.getUrl()) || !HubPolicy.trustedOdoo(url)) return;
                launch.finished();
                if (startupScript.isEmpty()) { showLoadingFailure("The SH Chat screen could not be prepared. Reopen the app and try again.", true); return; }
                // Idempotent fallback also installs the R8 transfer guard before revealing a Hub
                // on older WebViews. Auth presentation itself only targets Odoo auth routes.
                final long generation = launch.generation();
                view.evaluateJavascript(startupScript, unused -> {
                    if (web == view && generation == launch.generation()) { launch.prepared(generation); inspectPageForReveal(); }
                });
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (!request.isForMainFrame() || web != view || !launch.current(request.getUrl().toString())) return;
                String url = request.getUrl().toString(); int status = response.getStatusCode();
                if (HubPolicy.trustedHubPage(url) && (status == 401 || status == 403 || status == 404)) handleAccessFailure();
                else showLoadingFailure("The Odoo website is temporarily unavailable. Please try again.", true);
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame() && web == view && launch.current(request.getUrl().toString())) showLoadingFailure("SH Chat could not connect. Check your internet connection and try again.", true);
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
                if (web == view && launch.current(error.getUrl())) showLoadingFailure("A secure connection to Odoo could not be verified. Check your device date and network, then retry.", true);
            }
            @Override public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                activeCall = ""; stopService(new Intent(MainActivity.this, ActiveCallService.class));
                intentGeneration++;
                pageFrame.removeView(view); view.destroy();
                web = null;
                showLoadingFailure("Android stopped the SH Chat page. Tap Try again to reopen it. Any previous call needs to be checked.", true);
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, android.os.Message result) {
                return view == web && visible && operatorAuthWindow.open(view, isUserGesture, result);
            }
            @Override public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> {
                    if (web == null || !visible || !HubPolicy.trustedOdoo(request.getOrigin().toString()) || !HubPolicy.trustedOdoo(web.getUrl())) { request.deny(); return; }
                    boolean audio = false; for (String resource : request.getResources()) if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) audio = true;
                    if (!audio) { request.deny(); return; }
                    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                    else { if (microphoneRequest != null) microphoneRequest.deny(); microphoneRequest = request; requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, 21); }
                });
            }
            @Override public void onPermissionRequestCanceled(PermissionRequest request) { if (microphoneRequest == request) microphoneRequest = null; }
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null); fileCallback = callback; cameraOutput = null;
                Intent choose = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
                String[] accepts = params.getAcceptTypes(); ArrayList<String> mime = new ArrayList<>();
                for (String accept : accepts) if (accept != null && accept.matches("[A-Za-z0-9.+_-]+/[A-Za-z0-9.+_*-]+")) mime.add(accept);
                if (mime.size() == 1) choose.setType(mime.get(0)); else if (!mime.isEmpty()) choose.putExtra(Intent.EXTRA_MIME_TYPES, mime.toArray(new String[0]));
                choose.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try {
                    if (params.isCaptureEnabled() && mime.stream().anyMatch(t -> t.startsWith("image/"))) {
                        Intent camera = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
                        if (camera.resolveActivity(getPackageManager()) != null) {
                            File dir = new File(getCacheDir(), "camera"); dir.mkdirs();
                            File output = File.createTempFile("capture-", ".jpg", dir);
                            cameraOutput = FileProvider.getUriForFile(MainActivity.this, getPackageName() + ".files", output);
                            camera.putExtra(MediaStore.EXTRA_OUTPUT, cameraOutput).addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                            startActivityForResult(camera, 23); return true;
                        }
                    }
                    startActivityForResult(choose, 22); return true;
                } catch (Exception e) { fileCallback.onReceiveValue(null); fileCallback = null; toast("No file picker is available."); return true; }
            }
        });
        web.setDownloadListener((url, ua, contentDisposition, mime, length) -> {
            if (!HubPolicy.trustedDownload(url)) { if (HubPolicy.externalWeb(url)) try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (Exception ignored) { } return; }
            String cookies = HubPolicy.trustedOdoo(url) ? CookieManager.getInstance().getCookie(url) : null;
            NativeDownload.download(this, url, cookies, ua, contentDisposition, mime);
        });
    }
    private void receiveBridge(JSONObject obj) {
        if (web == null || !HubPolicy.trustedHubPage(web.getUrl())) return;
        String type = obj.optString("type");
        if ("ready".equals(type)) { hubReady = true; publishedNativeCapabilities = ""; launch.hubReady(); inspectPageForReveal(); dispatchPending(); refreshNativeCallCapabilities(); }
        else if ("request-settings".equals(type)) startActivity(new Intent(this, SettingsActivity.class));
        else if ("hub-call-read".equals(type)) readHubCallHistory(obj);
        else if ("appMessageState".equals(type)) appMessageState(obj);
        else if ("native-call".equals(type) && hubReady) {
            if (!activeCall.isEmpty() && !NativeRoomCallService.isRunning()) { publishNativeCallCapabilities(); toast("Finish the current browser call before starting a native call."); return; }
            if (!new NativeStore(this).nativeRoomCalls() && !NativeRoomCallService.isRunning()) { publishNativeCallCapabilities(); toast("Native calling is not enabled. Check App settings and the server connection."); return; }
            String action = obj.optString("action"), id = obj.optString("callId"), phone = obj.optString("phone");
            if ("unavailable".equals(action)) { toast("This call is no longer available. Open the current call notification or call screen."); return; }
            JSONObject runningCall = NativeRoomCallService.snapshot();
            if (("end".equals(action) || "transfer".equals(action)) && runningCall != null && !runningCall.optBoolean("closed") &&
                NativeRoomUiBinding.matches("", id, "", runningCall.optString("clientAttemptId"), runningCall.optString("callId"), runningCall.optString("providerCallId"), runningCall.optString("transferId")) &&
                !matchesNativeControlAttempt(obj, runningCall)) {
                openCurrentNativeCall(); toast("The call screen has changed. Use its current controls."); return;
            }
            if ("current".equals(action)) {
                if (!openCurrentNativeCall()) { publishNativeCallCapabilities(); toast("That call has ended."); }
                return;
            }
            // A second tap can arrive before the outgoing provider ID exists.
            // Reopen the existing local attempt instead of launching another one.
            if (("start".equals(action) || "dial".equals(action) || "callback".equals(action)) && openCurrentNativeCall()) return;
            if ("start".equals(action)) {
                if (!NativeRoomPolicy.validPhone(phone)) { toast("A country-code customer phone number is required."); return; }
                startActivity(NativeRoomNotifications.activity(this, "", "", "outgoing").putExtra("phone", phone)
                    .putExtra("channel_id", Math.max(0, obj.optInt("channelId"))).putExtra("display_name", obj.optString("displayName", "Customer")));
            } else if ("dial".equals(action)) {
                startActivity(NativeRoomNotifications.activity(this, "", "", "dial").putExtra("phone", NativeRoomPolicy.validPhone(phone) ? phone : "")
                    .putExtra("channel_id", Math.max(0, obj.optInt("channelId"))).putExtra("display_name", obj.optString("displayName", "WhatsApp call")));
            } else if (("open".equals(action) || "transfer".equals(action) || "accept".equals(action) || "callback".equals(action)) && HubPolicy.validCallId(id)) {
                String nativeAction = "open".equals(action) ? "show" : action;
                startActivity(NativeRoomNotifications.activity(this, id, "", nativeAction)
                    .putExtra("channel_id", Math.max(0, obj.optInt("channelId")))
                    .putExtra("client_attempt_id", obj.optString("clientAttemptId"))
                    .putExtra("owner_leg_id", obj.optString("ownerLegId")));
            } else if ("reject".equals(action) && HubPolicy.validCallId(id)) {
                NativeStore store = new NativeStore(this); store.closeRoomAlert(id, ""); NativeRoomNotifications.cancel(this, id, "");
                NativeRoomCleanup.enqueueDecline(this, store.credential(), id, "");
                rememberNativeClose(id, ""); dispatchPending();
            } else if ("end".equals(action) && HubPolicy.validCallId(id)) {
                if (!NativeRoomCallService.endFromNotification(id, obj.optString("clientAttemptId"), obj.optString("ownerLegId"))) {
                    NativeStore store = new NativeStore(this);
                    NativeRoomCleanup.enqueue(this, store.credential(), id, "", obj.optString("ownerLegId"));
                }
                // Closing this exact local panel does not claim that the provider
                // has acknowledged cleanup; the durable, owner-checked job does that.
                rememberNativeClose(id, "", obj.optString("clientAttemptId"), obj.optString("ownerLegId")); dispatchPending();
            }
            else if ("incoming".equals(action)) {
                JSONObject invitation = new NativeStore(this).soleRoomInvitation();
                if (invitation == null) toast("Choose the incoming call notification to open the correct customer.");
                else startActivity(NativeRoomNotifications.activity(this, invitation.optString("callId"), invitation.optString("transferId"), "show"));
            }
        }
        else if ("call-state".equals(type) && hubReady) {
            if (NativeRoomCallService.isRunning()) return;
            String id = obj.optString("callId"), state = obj.optString("state"); if (!HubPolicy.validCallId(id)) return;
            if ("starting".equals(state) || "connecting".equals(state)) {
                if (activeCall.isEmpty() || activeCall.equals(id)) activeCall = id;
            } else if ("connected".equals(state)) {
                if (!activeCall.isEmpty() && !activeCall.equals(id)) return;
                activeCall = id; CallAlerts.cancel(this, id);
                if ((visible || ActiveCallService.isActiveFor(id)) && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    try { startForegroundService(new Intent(this, ActiveCallService.class).putExtra("call_id", id)); } catch (RuntimeException ignored) { }
                }
            } else if (HubPolicy.terminal(state) && id.equals(activeCall)) { activeCall = ""; stopService(new Intent(this, ActiveCallService.class)); CallAlerts.cancel(this, id); }
            publishNativeCallCapabilities();
        }
    }
    private boolean openCurrentNativeCall() {
        JSONObject current = NativeRoomCallService.snapshot();
        if (current == null || current.optBoolean("closed")) return false;
        startActivity(NativeRoomNotifications.activity(this, current.optString("callId"), current.optString("transferId"), "show")
            .putExtra("channel_id", current.optInt("channelId"))
            .putExtra("client_attempt_id", current.optString("clientAttemptId")));
        return true;
    }
    private static boolean matchesNativeControlAttempt(JSONObject command, JSONObject call) {
        String attempt = command.optString("clientAttemptId"), leg = command.optString("ownerLegId");
        return NativeRoomUiBinding.validAttemptId(attempt) && attempt.equals(call.optString("clientAttemptId")) &&
            (leg.isEmpty() || leg.equals(call.optString("ownerLegId")));
    }
    private void readHubCallHistory(JSONObject request) {
        String requestId = request.optString("requestId"), path = request.optString("path");
        if (!NativeHubReadPolicy.validRequestId(requestId)) return;
        final long pageGeneration = launch.generation();
        NativeStore store = new NativeStore(this);
        DeviceLeasePolicy.Credential credential = store.credential();
        if (!NativeHubReadPolicy.allowedPath(path)) {
            replyHubRead(requestId, 403, "This request is outside the call-history bridge.", null, pageGeneration, null); return;
        }
        if (!DeviceLeasePolicy.valid(credential, System.currentTimeMillis())) {
            replyHubRead(requestId, 401, "Enroll this device in App settings to read call history.", null, pageGeneration, null); return;
        }
        try {
            hubReadIO.execute(() -> {
                JSONObject body = null; String error = ""; int status = 200;
                try {
                    if (!store.matchesCredential(credential)) throw new IllegalStateException("Device enrollment changed.");
                    body = NativeApi.hubRead(path, credential.bearer);
                } catch (Exception failure) {
                    status = failure instanceof NativeApi.ApiException ? ((NativeApi.ApiException) failure).status : 503;
                    error = status == 401 || status == 403 ? "Call history authorization expired. Check App settings." : "Call history is temporarily unavailable.";
                    if (status == 401) store.clearEnrollmentIfMatches(credential, error);
                }
                final JSONObject result = body; final int resultStatus = status; final String resultError = error;
                runOnUiThread(() -> replyHubRead(requestId, resultStatus, resultError, result, pageGeneration, credential));
            });
        } catch (RejectedExecutionException busy) {
            replyHubRead(requestId, 429, "Call history is busy. Please retry shortly.", null, pageGeneration, credential);
        }
    }
    private void replyHubRead(String requestId, int status, String error, JSONObject body, long pageGeneration,
                              DeviceLeasePolicy.Credential credential) {
        if (isFinishing() || isDestroyed() || web == null || pageGeneration != launch.generation() || !HubPolicy.trustedHubPage(web.getUrl())) return;
        try {
            if (credential != null && !new NativeStore(this).matchesCredential(credential)) {
                status = 401; error = "Device enrollment changed. Check App settings."; body = null;
            }
            JSONObject detail = new JSONObject().put("requestId", requestId).put("status", status);
            detail.put("body", body != null ? body : new JSONObject().put("ok", false).put("error", error));
            web.evaluateJavascript("window.dispatchEvent(new CustomEvent('sh-native-call-read',{detail:" + detail + "}));", null);
        } catch (Exception ignored) { }
    }
    private boolean mayReadAppMessages(long pageGeneration) {
        return visible && messageWindowFocused && hubReady && web != null && !isFinishing() && !isDestroyed()
            && pageGeneration == launch.generation() && launch.isPrepared() && !launch.isAuthFlow()
            && HubPolicy.trustedHubPage(web.getUrl()) && loadingCover != null && loadingCover.getVisibility() != View.VISIBLE;
    }
    private void appMessageState(JSONObject request) {
        String requestId = request.optString("requestId"), operation = request.optString("operation");
        if (!NativeHubReadPolicy.validRequestId(requestId)) return;
        final long pageGeneration = launch.generation(), readEpoch = messageReadEpoch;
        final JSONObject data;
        try { data = NativeApi.appMessageStateInput(operation, request); }
        catch (Exception ignored) {
            replyAppMessageState(requestId, 400, null, pageGeneration, null); return;
        }
        if (!hubReady || ("read".equals(operation) && !mayReadAppMessages(pageGeneration))) {
            replyAppMessageState(requestId, 409, null, pageGeneration, null); return;
        }
        NativeStore store = new NativeStore(this);
        DeviceLeasePolicy.Credential credential = store.credential();
        if (!DeviceLeasePolicy.valid(credential, System.currentTimeMillis())) {
            replyAppMessageState(requestId, 401, null, pageGeneration, null); return;
        }
        try {
            messageStateIO.execute(() -> {
                JSONObject body = null; int status = 200; String code = "";
                try {
                    if (!store.matchesCredential(credential) || !DeviceLeasePolicy.valid(store.credential(), System.currentTimeMillis()))
                        throw new NativeApi.ApiException(401, "Device enrollment changed.");
                    // A queued read belongs to the foreground page that observed it.
                    // Navigation, pause, loss of window focus or destruction cancels that grant.
                    if ("read".equals(operation) && messageReadEpoch != readEpoch)
                        throw new NativeApi.ApiException(409, "The chat is no longer visible.");
                    body = messageStateRequester.request(operation, data, credential.bearer);
                } catch (Exception failure) {
                    status = failure instanceof NativeApi.ApiException ? ((NativeApi.ApiException) failure).status : 503;
                    if (status == 409 && failure instanceof NativeApi.ApiException
                        && "APP_MESSAGE_STATE_CHANGED".equals(((NativeApi.ApiException) failure).errorCode)) code = "APP_MESSAGE_STATE_CHANGED";
                    if (status == 401) store.clearEnrollmentIfMatches(credential, "Message authorization expired. Check App settings.");
                }
                final JSONObject result = body; final int resultStatus = status; final String resultCode = code;
                runOnUiThread(() -> replyAppMessageState(requestId, resultStatus, result, pageGeneration, credential, resultCode));
            });
        } catch (RejectedExecutionException busy) {
            replyAppMessageState(requestId, 429, null, pageGeneration, credential);
        }
    }
    private void replyAppMessageState(String requestId, int status, JSONObject body, long pageGeneration,
                                      DeviceLeasePolicy.Credential credential) {
        replyAppMessageState(requestId, status, body, pageGeneration, credential, "");
    }
    private void replyAppMessageState(String requestId, int status, JSONObject body, long pageGeneration,
                                      DeviceLeasePolicy.Credential credential, String code) {
        if (isFinishing() || isDestroyed() || web == null || pageGeneration != launch.generation() || !HubPolicy.trustedHubPage(web.getUrl())) return;
        try {
            if (credential != null && (!new NativeStore(this).matchesCredential(credential)
                || !DeviceLeasePolicy.valid(new NativeStore(this).credential(), System.currentTimeMillis()))) {
                status = 401; body = null;
            }
            boolean ok = status >= 200 && status < 300 && body != null;
            JSONObject failure = new JSONObject().put("ok", false).put("error", "Message state is temporarily unavailable.");
            if (status == 409 && "APP_MESSAGE_STATE_CHANGED".equals(code)) failure.put("code", "APP_MESSAGE_STATE_CHANGED");
            JSONObject detail = new JSONObject().put("requestId", requestId).put("ok", ok).put("status", status)
                .put("body", ok ? body : failure);
            web.evaluateJavascript("window.dispatchEvent(new CustomEvent('sh-native-message-state',{detail:" + detail + "}));", null);
        } catch (Exception ignored) { }
    }
    private boolean nativeCapabilityLoading;
    private void refreshNativeCallCapabilities() {
        NativeStore store = new NativeStore(this);
        publishNativeCallCapabilities();
        long age = System.currentTimeMillis() - store.roomCapabilityCheckedAt();
        if (nativeCapabilityLoading || !store.enrolled() || (age >= 0 && age < 60000)) return;
        DeviceLeasePolicy.Credential credential = store.credential(); nativeCapabilityLoading = true;
        HubApplication.IO.execute(() -> {
            try { NativeRoomCapabilities.refresh(this, credential); } catch (Exception ignored) { }
            runOnUiThread(() -> { nativeCapabilityLoading = false; if (!isFinishing() && !isDestroyed()) publishNativeCallCapabilities(); });
        });
    }
    private void publishNativeCallCapabilities() {
        if (web == null || !hubReady || !HubPolicy.trustedHubPage(web.getUrl())) return;
        try {
            JSONObject value = new JSONObject().put("nativeRoomCalls", (new NativeStore(this).nativeRoomCalls() && activeCall.isEmpty()) || NativeRoomCallService.isRunning())
                .put("protocol", NativeRoomPolicy.PROTOCOL).put("nativeBuild", BuildConfig.VERSION_CODE)
                .put("callHistoryProxy", true)
                .put("appMessageState", true)
                .put("activeCall", NativeRoomCallService.isRunning());
            JSONObject call = NativeRoomCallService.snapshot();
            if (call != null && !call.optBoolean("closed")) value.put("activeCallId", call.optString("callId"))
                .put("activeProviderCallId", call.optString("providerCallId"))
                .put("activeAttemptId", call.optString("clientAttemptId"))
                .put("activeOwnerLegId", call.optString("ownerLegId"))
                .put("callDisplayName", call.optString("displayName"))
                .put("callState", call.optString("state")).put("canTransfer", call.optBoolean("canTransfer"));
            String serialized = value.toString();
            if (serialized.equals(publishedNativeCapabilities)) return;
            publishedNativeCapabilities = serialized;
            web.evaluateJavascript("window.SHNativeCapabilities=" + serialized + ";window.dispatchEvent(new CustomEvent('sh-native-capabilities',{detail:window.SHNativeCapabilities}));", null);
        } catch (Exception ignored) { }
    }
    private void handleIntent(Intent intent) {
        final long generation = ++intentGeneration;
        pendingCall = ""; pendingChannel = 0;
        String id = intent.getStringExtra("call_id");
        int channel = intent.getIntExtra("channel_id", 0);
        rememberNativeClose(intent.getStringExtra("native_closed_call_id"), intent.getStringExtra("native_closed_provider_id"),
            intent.getStringExtra("native_closed_attempt_id"), intent.getStringExtra("native_closed_owner_leg_id"));
        if (web == null) return;
        dispatchPending();
        if (channel > 0) {
            MessageAlerts.opened(this, intent);
            pendingChannel = channel;
            ensureHubPage(); dispatchPending();
            return;
        }
        if (!HubPolicy.validCallId(id)) return;
        CallAlerts.cancel(this, id);
        if (id.equals(activeCall)) { pendingCall = id; dispatchPending(); return; }
        NativeStore store = new NativeStore(this);
        DeviceLeasePolicy.Credential credential = store.credential();
        if (!DeviceLeasePolicy.valid(credential, System.currentTimeMillis())) { toast("Enroll this device in App settings to verify incoming calls."); return; }
        HubApplication.IO.execute(() -> {
            try {
                if (!store.matchesCredential(credential)) return;
                JSONObject call = NativeApi.request("/calls/" + Uri.encode(id), "GET", null, credential.bearer).getJSONObject("call");
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed() || web == null || generation != intentGeneration || !store.matchesCredential(credential)) return;
                    if (!call.optBoolean("answerable") || !id.equals(call.optString("callId"))) { toast("This call is no longer waiting to be answered."); return; }
                    pendingCall = id;
                    ensureHubPage();
                    dispatchPending();
                });
            } catch (Exception e) {
                boolean unauthorized = e instanceof NativeApi.ApiException && ((NativeApi.ApiException)e).status == 401;
                if (unauthorized) {
                    if (!store.clearEnrollmentIfMatches(credential, e.getMessage())) return;
                } else if (!store.matchesCredential(credential)) return;
                runOnUiThread(() -> {
                    boolean current = unauthorized ? store.credential().generation == credential.generation + 1 : store.matchesCredential(credential);
                    if (!isFinishing() && !isDestroyed() && generation == intentGeneration && current) toast(unauthorized ? "Device enrollment expired or was revoked. Enroll again in App settings." : "Could not verify this call. Check the SH Chat call screen.");
                });
            }
        });
    }
    private void rememberNativeClose(String callId, String providerId) {
        pendingNativeCloses.offer(callId, providerId);
    }
    private void rememberNativeClose(String callId, String providerId, String attemptId, String ownerLegId) {
        pendingNativeCloses.offer(callId, providerId, attemptId, ownerLegId);
    }
    private void dispatchPending() {
        if (!hubReady || web == null || !HubPolicy.trustedHubPage(web.getUrl()) || !launch.isPrepared() || loadingCover.getVisibility() == View.VISIBLE) return;
        for (NativeCallCloseQueue.Closed closed : pendingNativeCloses.drain()) {
            try {
                JSONObject detail = new JSONObject().put("localReleased", true);
                if (!closed.callId.isEmpty()) detail.put("callId", closed.callId);
                if (!closed.providerCallId.isEmpty()) detail.put("providerCallId", closed.providerCallId);
                if (!closed.clientAttemptId.isEmpty()) detail.put("clientAttemptId", closed.clientAttemptId);
                if (!closed.ownerLegId.isEmpty()) detail.put("ownerLegId", closed.ownerLegId);
                web.evaluateJavascript("window.dispatchEvent(new CustomEvent('sh-native-call-closed',{detail:" + detail + "}));", null);
            } catch (Exception ignored) { }
        }
        if (pendingChannel > 0) {
            int channel = pendingChannel; pendingChannel = 0;
            web.evaluateJavascript("window.dispatchEvent(new CustomEvent('sh-native-chat-action',{detail:{channelId:" + channel + "}}));", null);
        }
        if (pendingCall.isEmpty()) return;
        String id = pendingCall; pendingCall = "";
        try { JSONObject detail = new JSONObject().put("action", "open").put("callId", id);
            web.evaluateJavascript("window.dispatchEvent(new CustomEvent('sh-native-call-action',{detail:" + detail + "}));", null);
        } catch (Exception ignored) { }
    }
    private void ensureHubPage() {
        if (web == null || !activeCall.isEmpty()) return;
        String current = web.getUrl();
        if (launch.isAuthFlow() || HubPolicy.trustedHubPage(current) || HubPolicy.authPage(current)) return;
        loadAuthentication(false);
    }
    private void updateTheme() {
        shell.setBackgroundColor(NativeUi.background(this)); toolbar.setBackgroundColor(NativeUi.background(this)); title.setTextColor(NativeUi.foreground(this));
        loadingCover.setBackgroundColor(NativeUi.background(this)); loadingTitle.setTextColor(NativeUi.foreground(this)); loadingMessage.setTextColor(NativeUi.muted(this));
        if (web != null) web.setBackgroundColor(NativeUi.background(this));
        // uiMode is handled without recreating this Activity. XML night resources
        // alone therefore leave the system bars in the theme used at launch.
        getWindow().setStatusBarColor(NativeUi.background(this));
        getWindow().setNavigationBarColor(NativeUi.background(this));
        WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        bars.setAppearanceLightStatusBars(!NativeUi.dark(this));
        bars.setAppearanceLightNavigationBars(!NativeUi.dark(this));
    }
    private void toast(String message) { Toast.makeText(this, message, Toast.LENGTH_LONG).show(); }
    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); handleIntent(intent); }
    @Override protected void onResume() {
        super.onResume(); visible = true; if (web != null) web.onResume();
        ((HubApplication)getApplication()).maybeRenewDeviceLease();
        refreshNativeCallCapabilities();
        NativeRoomCleanup.drain(this);
    }
    @Override protected void onPause() { visible = false; messageWindowFocused = false; messageReadEpoch++; CookieManager.getInstance().flush(); if (web != null && activeCall.isEmpty()) web.onPause(); super.onPause(); }
    @Override public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus); messageWindowFocused = hasFocus;
        if (!hasFocus) messageReadEpoch++;
    }
    @Override public void onConfigurationChanged(Configuration config) { super.onConfigurationChanged(config); updateTheme(); }
    @Override public void onBackPressed() { if (!activeCall.isEmpty()) moveTaskToBack(true); else if (web != null && web.canGoBack()) web.goBack(); else super.onBackPressed(); }
    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == 21 && microphoneRequest != null) {
            PermissionRequest pending = microphoneRequest; microphoneRequest = null;
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED && web != null && HubPolicy.trustedOdoo(web.getUrl()) && HubPolicy.trustedOdoo(pending.getOrigin().toString())) pending.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE}); else pending.deny();
        }
    }
    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if ((requestCode == 22 || requestCode == 23) && fileCallback != null) {
            Uri[] result = null;
            if (resultCode == RESULT_OK) {
                if (requestCode == 23 && cameraOutput != null) result = new Uri[]{cameraOutput};
                else if (data != null && data.getClipData() != null) {
                    ClipData clips = data.getClipData(); ArrayList<Uri> selected = new ArrayList<>();
                    for (int i = 0; i < Math.min(50, clips.getItemCount()); i++) { Uri uri = clips.getItemAt(i).getUri(); if (uri != null && "content".equals(uri.getScheme())) selected.add(uri); }
                    if (!selected.isEmpty()) result = selected.toArray(new Uri[0]);
                }
                else if (data != null && data.getData() != null && "content".equals(data.getData().getScheme())) result = new Uri[]{data.getData()};
            }
            fileCallback.onReceiveValue(result); fileCallback = null; cameraOutput = null;
        }
    }
    @Override protected void onDestroy() {
        messageReadEpoch++;
        operatorAuthWindow.close();
        hubReadIO.shutdownNow();
        messageStateIO.shutdownNow();
        if (nativeRoomReceiverRegistered) unregisterReceiver(nativeRoomReceiver);
        intentGeneration++;
        startupHandler.removeCallbacksAndMessages(null);
        if (microphoneRequest != null) microphoneRequest.deny(); if (fileCallback != null) fileCallback.onReceiveValue(null);
        // This Activity does not retain a WebView across recreation. Always release its media.
        // Unhandled configuration changes must not leave an old call/renderer behind a new Hub.
        stopService(new Intent(this, ActiveCallService.class));
        activeCall = ""; hubReady = false;
        if (web != null) { pageFrame.removeView(web); web.destroy(); web = null; }
        super.onDestroy();
    }
}
