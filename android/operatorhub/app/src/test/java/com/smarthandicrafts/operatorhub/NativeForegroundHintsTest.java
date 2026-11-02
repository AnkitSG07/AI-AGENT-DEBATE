package com.smarthandicrafts.operatorhub;

import android.app.Application;
import android.content.BroadcastReceiver;
import android.content.Intent;
import android.view.View;
import android.webkit.WebView;
import android.widget.LinearLayout;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.Set;
import java.util.concurrent.ThreadPoolExecutor;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class) @Config(sdk=28, application=Application.class)
public class NativeForegroundHintsTest {
    MainActivity activity; WebView web; NativeStore store; BroadcastReceiver receiver;
    Field field(String name) throws Exception { Field f=MainActivity.class.getDeclaredField(name); f.setAccessible(true); return f; }
    void set(String name,Object value) throws Exception { field(name).set(activity,value); }
    void drain() throws Exception { Method m=MainActivity.class.getDeclaredMethod("dispatchPending");m.setAccessible(true);m.invoke(activity); }
    String script() { return String.valueOf(Shadows.shadowOf(web).getLastEvaluatedJavascript()); }
    Intent message(int channel,long generation) { return new Intent(MessageAlerts.CHANGED).putExtra("channel_id",channel).putExtra("enrollment_generation",generation); }
    @Before public void setup() throws Exception {
        activity=Robolectric.buildActivity(MainActivity.class).get();web=new WebView(activity);web.loadUrl(HubPolicy.HUB_URL);
        set("web",web);set("hubReady",true);set("visible",true);
        LinearLayout cover=new LinearLayout(activity);cover.setVisibility(View.GONE);set("loadingCover",cover);
        HubLaunchState launch=(HubLaunchState)field("launch").get(activity);launch.navigation(HubPolicy.HUB_URL);launch.prepared(launch.generation());launch.finished();launch.hubReady();
        store=new NativeStore(activity);store.clearEnrollment();String id="android_foreground_fixture_01";
        assertTrue(store.enrollIfGeneration(id,id+".abcdefghijklmnopqrstuvwxyz0123456789",System.currentTimeMillis()+3600000,store.credential().generation));
        receiver=(BroadcastReceiver)field("nativeRoomReceiver").get(activity);
    }
    @After public void cleanup() throws Exception {
        ((ThreadPoolExecutor)field("messageStateIO").get(activity)).shutdownNow();((ThreadPoolExecutor)field("hubReadIO").get(activity)).shutdownNow();
        store.clearEnrollment();web.destroy();
    }
    @Test public void acceptedMessageImmediatelyInvalidatesOnlyItsChatWithoutTextOrBearer() {
        receiver.onReceive(activity,message(73,store.credential().generation));
        assertTrue(script(),script().contains("sh-native-message-changed"));assertTrue(script().contains("channelId:73"));assertFalse(script().contains(store.token()));
        assertFalse(NativeRoomCallService.isRunning());
    }
    @Test public void callHintRequestsAnExactRefreshWithoutOpeningOrAnswering() {
        receiver.onReceive(activity,new Intent(NativeRoomNotifications.CHANGED).putExtra("call_id","out_0123456789abcdef0123456789abcdef")
            .putExtra("event","incoming").putExtra("enrollment_generation",store.credential().generation));
        assertTrue(script(),script().contains("sh-native-call-changed"));assertTrue(script().contains("incoming"));
        assertFalse(script().contains("sh-native-call-action"));assertFalse(NativeRoomCallService.isRunning());
    }
    @Test public void backgroundHintWaitsForVisiblePreparedPage() throws Exception {
        set("visible",false);receiver.onReceive(activity,message(73,store.credential().generation));
        assertFalse(script().contains("sh-native-message-changed"));set("visible",true);drain();assertTrue(script().contains("channelId:73"));
    }
    @Test public void staleEnrollmentAndLogoutCannotReleaseOldChatHints() throws Exception {
        receiver.onReceive(activity,message(74,store.credential().generation-1));assertFalse(script().contains("sh-native-message-changed"));
        set("visible",false);receiver.onReceive(activity,message(73,store.credential().generation));store.clearEnrollment();set("visible",true);drain();
        assertFalse(script().contains("sh-native-message-changed"));
    }
    @Test public void hintsNeverReachAnUntrustedPageAndTheQueueIsBounded() throws Exception {
        web.loadUrl("https://untrusted.example/");
        for(int i=1;i<=100;i++)receiver.onReceive(activity,message(i,store.credential().generation));
        assertFalse(script().contains("sh-native-message-changed"));assertEquals(32,((Set<?>)field("pendingMessageHints").get(activity)).size());
    }
}
