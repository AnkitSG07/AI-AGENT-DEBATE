package com.smarthandicrafts.operatorhub;

import android.app.Activity;
import android.app.Dialog;
import android.graphics.Bitmap;
import android.net.http.SslError;
import android.os.Message;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebResourceError;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.Button;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.function.LongSupplier;
import java.util.function.Consumer;

/** An isolated, user-opened auth window with Chromium's real opener/postMessage relation. */
final class NativeOperatorAuthWindow {
    private final Activity activity;
    private final LongSupplier generation;
    private final Consumer<String> otherUserNavigation;
    private WebView owner, popup;
    private Dialog dialog;
    private long openedGeneration;
    NativeOperatorAuthWindow(Activity activity, LongSupplier generation, Consumer<String> otherUserNavigation) {
        this.activity = activity; this.generation = generation; this.otherUserNavigation = otherUserNavigation;
    }
    boolean open(WebView source, boolean userGesture, Message result) {
        if (!userGesture || source == null || !HubPolicy.trustedHubPage(source.getUrl()) || popup != null ||
            activity.isFinishing() || activity.isDestroyed() || result == null || !(result.obj instanceof WebView.WebViewTransport)) return false;
        owner = source; openedGeneration = generation.getAsLong();
        WebView child = new WebView(activity); popup = child;
        WebSettings settings = child.getSettings();
        settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(false);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false); settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportZoom(false); settings.setBuiltInZoomControls(false);
        settings.setSafeBrowsingEnabled(true); settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        CookieManager.getInstance().setAcceptThirdPartyCookies(child, false);
        // Deliberately no SHNative listener, JavascriptInterface, file chooser, downloads or capture grants.
        child.setWebViewClient(new WebViewClient() {
            private boolean acceptedAuthNavigation;
            private boolean current() {
                return popup == child && owner == source && generation.getAsLong() == openedGeneration &&
                    HubPolicy.trustedHubPage(source.getUrl()) && !activity.isFinishing() && !activity.isDestroyed();
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // Quotation creation opens a blank user window before its asynchronous
                // Odoo request. Keep that inert placeholder until its real destination.
                if (current() && request.isForMainFrame() && !acceptedAuthNavigation && "about:blank".equals(request.getUrl().toString())) return false;
                boolean allowed = current() && request.isForMainFrame() && NativeOperatorAuthPolicy.allowedPage(request.getUrl().toString());
                if (allowed) acceptedAuthNavigation = true;
                else leave(request.getUrl().toString(), request.isForMainFrame());
                return !allowed;
            }
            private void leave(String url, boolean mainFrame) {
                boolean forward = mainFrame && !acceptedAuthNavigation && current();
                close();
                // Preserve a user-opened Odoo quotation/document link. Once auth has
                // loaded, a redirect can never escape into another app or page.
                if (forward) otherUserNavigation.accept(url);
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (NativeOperatorAuthPolicy.allowedResource(request.getUrl().toString(), request.getMethod(), request.isForMainFrame())) return null;
                return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", Collections.singletonMap("Cache-Control", "no-store"),
                    new ByteArrayInputStream("This resource is outside operator sign-in.".getBytes(StandardCharsets.UTF_8)));
            }
            @Override public void onPageStarted(WebView view, String url, Bitmap icon) {
                if (current() && !acceptedAuthNavigation && "about:blank".equals(url)) return;
                if (!current() || !NativeOperatorAuthPolicy.allowedPage(url)) leave(url, true);
                else acceptedAuthNavigation = true;
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) { handler.cancel(); close(); }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) { if (request.isForMainFrame()) close(); }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) { if (request.isForMainFrame()) close(); }
            @Override public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) { close(); return true; }
            @Override public void onPageFinished(WebView view, String url) { CookieManager.getInstance().flush(); }
        });
        child.setWebChromeClient(new WebChromeClient() {
            @Override public void onCloseWindow(WebView window) { if (window == popup) close(); }
            @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
            @Override public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message message) { return false; }
        });
        LinearLayout content = new LinearLayout(activity); content.setOrientation(LinearLayout.VERTICAL);
        content.setBackgroundColor(NativeUi.background(activity));
        Button back = NativeUi.button(activity, "Back to SH Chat", view -> close());
        content.addView(back, new LinearLayout.LayoutParams(-1, NativeUi.dp(activity, 52)));
        content.addView(child, new LinearLayout.LayoutParams(-1, 0, 1));
        dialog = new Dialog(activity); dialog.setContentView(content); dialog.setCancelable(true);
        dialog.setOnDismissListener(ignored -> dispose()); dialog.show();
        if (dialog.getWindow() != null) dialog.getWindow().setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        WebView.WebViewTransport transport = (WebView.WebViewTransport)result.obj;
        transport.setWebView(child); result.sendToTarget();
        return true;
    }
    void close() {
        Dialog previous = dialog; dialog = null;
        if (previous != null && previous.isShowing()) previous.dismiss();
        dispose();
    }
    private void dispose() {
        WebView old = popup; popup = null; owner = null;
        if (old == null) return;
        old.stopLoading();
        if (old.getParent() instanceof ViewGroup) ((ViewGroup)old.getParent()).removeView(old);
        old.destroy();
    }
}
