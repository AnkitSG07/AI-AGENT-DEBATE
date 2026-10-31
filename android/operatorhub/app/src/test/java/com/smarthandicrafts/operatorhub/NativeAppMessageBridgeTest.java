package com.smarthandicrafts.operatorhub;

import android.app.Application;
import android.os.Looper;
import android.view.View;
import android.webkit.WebView;
import android.widget.LinearLayout;
import org.junit.Test;
import org.junit.Before;
import org.junit.After;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.Shadows;
import org.json.JSONObject;
import org.json.JSONArray;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class) @Config(sdk=28, application=Application.class)
public class NativeAppMessageBridgeTest {
    private MainActivity activity;
    private WebView web;
    private NativeStore store;
    private AtomicInteger requests;
    private final String requestId="12345678-1234-4234-8234-123456789abc";
    private static Field field(String name) throws Exception { Field f=MainActivity.class.getDeclaredField(name); f.setAccessible(true); return f; }
    private static Method method(String name,Class<?>... parameters) throws Exception { Method m=MainActivity.class.getDeclaredMethod(name,parameters); m.setAccessible(true); return m; }
    private void set(String name,Object value) throws Exception { field(name).set(activity,value); }
    private JSONObject request(String operation) throws Exception { return new JSONObject().put("type","appMessageState").put("requestId",requestId)
        .put("operation",operation).put("channelId",73).put("expectedStateVersion",2).put("throughMessageId",91).put("channelIds",new JSONArray().put(73)); }
    private void command(JSONObject request) throws Exception { method("receiveBridge",JSONObject.class).invoke(activity,request); }
    private JSONObject reply() throws Exception {
        String script=Shadows.shadowOf(web).getLastEvaluatedJavascript();
        assertNotNull(script); String prefix="window.dispatchEvent(new CustomEvent('sh-native-message-state',{detail:";
        assertTrue(script,script.startsWith(prefix)); return new JSONObject(script.substring(prefix.length(),script.length()-4));
    }
    private JSONObject waitForReply() throws Exception {
        long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(3);
        while(System.nanoTime()<until) {
            Shadows.shadowOf(Looper.getMainLooper()).idle();
            String script=Shadows.shadowOf(web).getLastEvaluatedJavascript();
            if(script!=null && script.contains("sh-native-message-state")) return reply();
            Thread.yield();
        }
        fail("The native message bridge did not reply"); return null;
    }
    @Before public void setup() throws Exception {
        activity=Robolectric.buildActivity(MainActivity.class).get(); web=new WebView(activity); web.loadUrl(HubPolicy.HUB_URL);
        set("web",web); set("hubReady",true); set("visible",true); set("messageWindowFocused",true);
        LinearLayout cover=new LinearLayout(activity); cover.setVisibility(View.GONE); set("loadingCover",cover);
        HubLaunchState launch=(HubLaunchState)field("launch").get(activity); launch.navigation(HubPolicy.HUB_URL);
        launch.prepared(launch.generation()); launch.finished(); launch.hubReady();
        store=new NativeStore(activity); store.clearEnrollment();
        assertTrue(store.enrollIfGeneration("android_synthetic_device_01","android_synthetic_device_01.abcdefghijklmnopqrstuvwxyz0123456789",System.currentTimeMillis()+3600000,store.credential().generation));
        requests=new AtomicInteger();
        set("messageStateRequester",(MainActivity.MessageStateRequester)(operation,data,bearer) -> {
            requests.incrementAndGet(); assertEquals(store.token(),bearer);
            if (!"list".equals(operation)) assertEquals(2,data.getLong("expectedStateVersion"));
            return new JSONObject().put("ok",true).put("channels",new JSONArray().put(new JSONObject().put("channelId",73)
                .put("stateVersion",3).put("latestMessageId",91).put("readThroughMessageId",91).put("unreadCount",0)));
        });
    }
    @After public void cleanup() throws Exception {
        ((ThreadPoolExecutor)field("messageStateIO").get(activity)).shutdownNow();
        ((ThreadPoolExecutor)field("hubReadIO").get(activity)).shutdownNow(); store.clearEnrollment(); web.destroy();
    }
    @Test public void foregroundFocusedPreparedHubCanReadWithoutExposingCredential() throws Exception {
        command(request("read")); JSONObject result=waitForReply();
        assertTrue(result.getBoolean("ok")); assertEquals(200,result.getInt("status")); assertEquals(requestId,result.getString("requestId"));
        assertEquals(1,requests.get()); assertFalse(result.toString().contains(store.token()));
    }
    @Test public void backgroundAndUnfocusedHubCannotMarkRead() throws Exception {
        set("visible",false); command(request("read")); assertEquals(409,reply().getInt("status"));
        set("visible",true); set("messageWindowFocused",false); command(request("read")); assertEquals(409,reply().getInt("status"));
        assertEquals(0,requests.get());
    }
    @Test public void unpreparedOrCoveredHubCannotMarkRead() throws Exception {
        ((LinearLayout)field("loadingCover").get(activity)).setVisibility(View.VISIBLE);
        command(request("read")); assertEquals(409,reply().getInt("status"));
        ((LinearLayout)field("loadingCover").get(activity)).setVisibility(View.GONE);
        ((HubLaunchState)field("launch").get(activity)).navigation(HubPolicy.HUB_URL);
        command(request("read")); assertEquals(409,reply().getInt("status")); assertEquals(0,requests.get());
    }
    @Test public void readQueuedBeforeLossOfFocusIsCancelledEvenWhenFocusReturns() throws Exception {
        ThreadPoolExecutor executor=(ThreadPoolExecutor)field("messageStateIO").get(activity);
        CountDownLatch workers=new CountDownLatch(2), release=new CountDownLatch(1);
        Runnable block=() -> { workers.countDown(); try { release.await(); } catch(InterruptedException ignored) { Thread.currentThread().interrupt(); } };
        executor.execute(block); executor.execute(block); assertTrue(workers.await(3,TimeUnit.SECONDS));
        command(request("read")); activity.onWindowFocusChanged(false); activity.onWindowFocusChanged(true);
        release.countDown(); assertEquals(409,waitForReply().getInt("status")); assertEquals(0,requests.get());
    }
    @Test public void enrollmentChangeWhileQueuedPreventsTheOldBearerRequest() throws Exception {
        ThreadPoolExecutor executor=(ThreadPoolExecutor)field("messageStateIO").get(activity);
        CountDownLatch workers=new CountDownLatch(2), release=new CountDownLatch(1);
        Runnable block=() -> { workers.countDown(); try { release.await(); } catch(InterruptedException ignored) { Thread.currentThread().interrupt(); } };
        executor.execute(block); executor.execute(block); assertTrue(workers.await(3,TimeUnit.SECONDS));
        command(request("list")); store.clearEnrollment(); release.countDown();
        assertEquals(401,waitForReply().getInt("status")); assertEquals(0,requests.get());
    }
    @Test public void failureReplyContainsOnlyGenericError() throws Exception {
        set("messageStateRequester",(MainActivity.MessageStateRequester)(operation,data,bearer) -> { throw new Exception("sensitive SDK response and token"); });
        command(request("list")); JSONObject result=waitForReply();
        assertFalse(result.getBoolean("ok")); assertEquals(503,result.getInt("status"));
        assertFalse(result.toString().contains("sensitive")); assertFalse(result.toString().contains("token"));
    }
    @Test public void stateConflictRemains409WithoutDroppingTheEnrollmentOrLeakingPayload() throws Exception {
        set("messageStateRequester",(MainActivity.MessageStateRequester)(operation,data,bearer) -> {
            throw new NativeApi.ApiException(409,"Private SDK response",new JSONObject().put("code","APP_MESSAGE_STATE_CHANGED").put("secret","must-not-cross"));
        });
        command(request("read")); JSONObject result=waitForReply();
        assertFalse(result.getBoolean("ok")); assertEquals(409,result.getInt("status")); assertTrue(store.enrolled());
        assertEquals("APP_MESSAGE_STATE_CHANGED",result.getJSONObject("body").getString("code"));
        assertFalse(result.toString().contains("Private")); assertFalse(result.toString().contains("must-not-cross"));
    }
    @Test public void arbitrary409CodesCannotCrossTheBridgeOrTriggerConflictRetries() throws Exception {
        set("messageStateRequester",(MainActivity.MessageStateRequester)(operation,data,bearer) -> {
            throw new NativeApi.ApiException(409,"Private SDK response",new JSONObject().put("code","PRIVATE_UNKNOWN_CODE"));
        });
        command(request("read")); JSONObject result=waitForReply();
        assertEquals(409,result.getInt("status")); assertFalse(result.getJSONObject("body").has("code"));
        assertFalse(result.toString().contains("PRIVATE_UNKNOWN_CODE"));
    }
}
