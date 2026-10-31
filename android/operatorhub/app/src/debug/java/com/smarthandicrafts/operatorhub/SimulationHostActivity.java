package com.smarthandicrafts.operatorhub;

import android.app.Activity;
import android.graphics.Bitmap;
import android.os.Bundle;
import android.os.Message;
import android.os.SystemClock;
import android.webkit.ConsoleMessage;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewFeature;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;

/** Debug-variant test surface. It has no exported entry and never reaches a remote server. */
public final class SimulationHostActivity extends Activity {
    WebView web;
    NativeOperatorAuthWindow auth;
    volatile String result = "", otherNavigation = "", popupNativeVisibility = "";
    volatile int tokenRequests, blockedRequests;
    volatile boolean popupOpened;
    volatile boolean pageReady;
    volatile String lastPageUrl = "", lastPopupUrl = "", lastConsole = "", lastLoadError = "", rendererExit = "";
    volatile int pageProgress;
    volatile long pageStartedAt, pageFinishedAt;
    long generation;
    private String page, client, hubPage;
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        try {
            page = new String(getAssets().open("simulation/operator-auth.html").readAllBytes(), StandardCharsets.UTF_8)
                .replace("__SH_OPERATOR_AUTH_PUBLIC_CONFIG__", "{\"backendOrigin\":\"https://ai-agent-debate.onrender.com\",\"allowedHubOrigins\":[\"https://www.smarthandicrafts.com\"]}");
            client = new String(getAssets().open("simulation/operator-browser-auth.js").readAllBytes(), StandardCharsets.UTF_8);
        } catch (Exception failure) { throw new IllegalStateException(failure); }
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL);
        TextView heading = NativeUi.text(this,"SH Chat local OS simulation",18,true); root.addView(heading);
        web = new WebView(this); root.addView(web,new LinearLayout.LayoutParams(-1,0,1)); setContentView(root);
        web.getSettings().setJavaScriptEnabled(true); web.getSettings().setSupportMultipleWindows(true);
        web.getSettings().setJavaScriptCanOpenWindowsAutomatically(false);
        auth = new NativeOperatorAuthWindow(this, () -> generation, url -> otherNavigation=url);
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) throw new IllegalStateException("Web message support is required by the simulator");
        WebViewCompat.addWebMessageListener(web,"SHNative",Collections.singleton(HubPolicy.ODOO_ORIGIN),(view,message,origin,main,reply)->{
            if (main && message.getType()==WebMessageCompat.TYPE_STRING) {
                String data=message.getData();
                if(data.startsWith("popup-native:"))popupNativeVisibility=data.substring(13);
                else result=data;
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view,WebResourceRequest request) {
                // Serve exactly the synthetic Hub document at its real HTTPS origin.
                // loadDataWithBaseURL can expose an internal data: navigation to this
                // interceptor; blocking that navigation prevented the test page loading.
                if (request.isForMainFrame() && "GET".equals(request.getMethod())
                    && HubPolicy.HUB_URL.equals(request.getUrl().toString()))
                    return response(200,"OK","text/html",hubPage);
                blockedRequests++; return response(403,"Blocked","text/plain","Remote traffic disabled in simulator");
            }
            @Override public void onPageStarted(WebView view,String url,Bitmap icon) { lastPageUrl=safeUrl(url); pageStartedAt=SystemClock.elapsedRealtime(); diagnosticEvent("page-start"); }
            @Override public void onPageFinished(WebView view,String url) { lastPageUrl=safeUrl(url); pageFinishedAt=SystemClock.elapsedRealtime(); pageReady=HubPolicy.HUB_URL.equals(url); diagnosticEvent("page-finish"); }
            @Override public void onReceivedError(WebView view,WebResourceRequest request,WebResourceError error) { lastLoadError="code="+error.getErrorCode()+",main="+request.isForMainFrame()+",url="+safeUrl(request.getUrl().toString()); diagnosticEvent("load-error"); }
            @Override public void onReceivedHttpError(WebView view,WebResourceRequest request,WebResourceResponse error) { lastLoadError="http="+error.getStatusCode()+",main="+request.isForMainFrame()+",url="+safeUrl(request.getUrl().toString()); diagnosticEvent("http-error"); }
            @Override public boolean onRenderProcessGone(WebView view,RenderProcessGoneDetail detail) { rendererExit="crashed="+detail.didCrash()+",priority="+detail.rendererPriorityAtExit(); diagnosticEvent("renderer-gone"); return false; }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView view,int progress) { pageProgress=progress; }
            @Override public boolean onConsoleMessage(ConsoleMessage message) { lastConsole=message.messageLevel()+" line="+message.lineNumber()+" "+message.message().substring(0,Math.min(240,message.message().length())); diagnosticEvent("console"); return false; }
            @Override public boolean onCreateWindow(WebView source,boolean dialog,boolean userGesture,Message message) {
                boolean opened=auth.open(source,userGesture,message); popupOpened=opened;
                if (opened) {
                    WebView child=((WebView.WebViewTransport)message.obj).getWebView();
                    WebViewClient guard=child.getWebViewClient();
                    child.setWebViewClient(new WebViewClient() {
                        @Override public boolean shouldOverrideUrlLoading(WebView v,WebResourceRequest r) {return guard.shouldOverrideUrlLoading(v,r);}
                        @Override public void onPageStarted(WebView v,String u,Bitmap b){lastPopupUrl=safeUrl(u);diagnosticEvent("popup-start");guard.onPageStarted(v,u,b);}
                        @Override public void onPageFinished(WebView v,String u){lastPopupUrl=safeUrl(u);diagnosticEvent("popup-finish");guard.onPageFinished(v,u);}
                        @Override public WebResourceResponse shouldInterceptRequest(WebView v,WebResourceRequest r) {
                            WebResourceResponse denied=guard.shouldInterceptRequest(v,r);
                            if(denied!=null){blockedRequests++;return denied;}
                            if(r.isForMainFrame())return response(200,"OK","text/html",page.replace("<head>","<head><script>window.opener.postMessage({type:'simulation-native-check',native:typeof window.SHNative},'https://www.smarthandicrafts.com')</script>"));
                            if(r.getUrl().getPath().equals("/api/operator-browser-auth/token")) {
                                tokenRequests++;
                                return response(200,"OK","application/json","{\"ok\":true,\"token\":\"shb1.simulation-only-00000000000000000000000000000000000000000000\",\"expiresAt\":"+(System.currentTimeMillis()+300000)+",\"authExpiresAt\":"+(System.currentTimeMillis()+600000)+",\"operatorDeviceId\":\"web_0123456789abcdef0123456789abcdef::tab_0123456789abcdef01234567\",\"baseDeviceId\":\"web_0123456789abcdef0123456789abcdef\",\"operatorSessionId\":\"tab_0123456789abcdef01234567\"}");
                            }
                            return response(200,"OK","application/json","{\"ok\":true}");
                        }
                    });
                }
                return opened;
            }
        });
        String script = "window.addEventListener('sh-operator-auth-connected',()=>{document.getElementById('result').textContent='Connected';SHNative.postMessage('connected')});window.addEventListener('message',e=>{if(e.origin==='https://ai-agent-debate.onrender.com'&&e.data.type==='simulation-native-check')SHNative.postMessage('popup-native:'+e.data.native)});";
        hubPage="<!doctype html><meta name='viewport' content='width=device-width,initial-scale=1'><style>body{font:18px sans-serif;padding:24px}button{height:64px;width:240px}</style><h1>Hub simulator</h1><button id='connect' onclick=\"SHOperatorAuth.connect().catch(e=>{SHNative.postMessage(e.message)})\">Connect operator services</button><button id='quotation' onclick=\"const draft=window.open('about:blank','_blank');setTimeout(()=>{draft.location.href='https://www.smarthandicrafts.com/odoo/sales/17'},500)\">Draft quotation window</button><p id='result'>Ready</p><script>"+client+"</script><script>"+script+"</script>";
        web.loadUrl(HubPolicy.HUB_URL);
        diagnosticEvent("load-requested");
    }
    private static String safeUrl(String url) { android.net.Uri value=android.net.Uri.parse(url); return value.getScheme()+":"+(value.getHost()==null?"":"//"+value.getHost())+(value.getPath()==null?"":value.getPath()); }
    String diagnostics() { return "pageReady="+pageReady+",progress="+pageProgress+",url="+lastPageUrl+",startedAt="+pageStartedAt+",finishedAt="+pageFinishedAt+",popup="+popupOpened+",popupUrl="+lastPopupUrl+",tokenRequests="+tokenRequests+",blockedRequests="+blockedRequests+",result="+result+",console="+lastConsole+",error="+lastLoadError+",renderer="+rendererExit; }
    private void diagnosticEvent(String event) { android.util.Log.i("SHSimulation",event+" "+diagnostics()); }
    private static WebResourceResponse response(int status,String reason,String mime,String body){return new WebResourceResponse(mime,"UTF-8",status,reason,Collections.singletonMap("Cache-Control","no-store"),new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8)));}
    @Override protected void onDestroy(){auth.close();web.destroy();super.onDestroy();}
}
