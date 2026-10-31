package com.smarthandicrafts.operatorhub;

import android.Manifest;
import android.app.Activity;
import android.app.Instrumentation;
import android.app.Notification;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.os.SystemClock;
import android.service.notification.StatusBarNotification;
import android.view.MotionEvent;
import android.view.View;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.TextView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.lang.reflect.Field;
import java.net.URL;
import java.security.Principal;
import java.security.cert.Certificate;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;
import javax.net.ssl.HttpsURLConnection;
import static org.junit.Assert.*;

/** Real Android system/WebView/notification tests; remote provider and FCM transport are excluded. */
@RunWith(AndroidJUnit4.class)
public class NativeSystemInstrumentationTest {
    private final Instrumentation instrumentation=InstrumentationRegistry.getInstrumentation();
    private final Context context=instrumentation.getTargetContext();
    private NativeStore store;
    private Object oldConnections;
    private final CopyOnWriteArrayList<String> requests=new CopyOnWriteArrayList<>();
    private static final String CALL="out_0123456789abcdef0123456789abcdef";
    private static final String DEVICE="android_simulation_0123456789abcdef";
    private NotificationManager manager;
    @Before public void setup() throws Exception {
        context.getSharedPreferences("native_private",Context.MODE_PRIVATE).edit().clear().commit();
        context.getSharedPreferences("native_room_cleanup",Context.MODE_PRIVATE).edit().clear().commit();
        store=new NativeStore(context);assertTrue(store.enrollIfGeneration(DEVICE,DEVICE+".simulation-token-abcdefghijklmnopqrstuvwxyz",System.currentTimeMillis()+3600000,store.credential().generation));
        Field connection=NativeApi.class.getDeclaredField("connections");connection.setAccessible(true);oldConnections=connection.get(null);
        connection.set(null,(NativeApi.ConnectionFactory)url->new FakeConnection(url));
        manager=context.getSystemService(NotificationManager.class);manager.cancelAll();CallAlerts.createChannels(context);
        instrumentation.getUiAutomation().executeShellCommand("pm grant "+context.getPackageName()+" "+Manifest.permission.POST_NOTIFICATIONS).close();
    }
    @After public void cleanup() throws Exception {
        manager.cancelAll();store.clearEnrollment();
        Field connection=NativeApi.class.getDeclaredField("connections");connection.setAccessible(true);connection.set(null,oldConnections);
    }
    private final class FakeConnection extends HttpsURLConnection {
        FakeConnection(URL url){super(url);}
        @Override public int getResponseCode(){requests.add(getRequestMethod()+" "+url.getPath());return 200;}
        @Override public InputStream getInputStream(){String value=url.getPath().endsWith("/status")?"{\"ok\":true,\"call\":{\"phase\":\"ringing\",\"version\":1,\"ownerDeviceId\":null}}":"{\"ok\":true}";return new ByteArrayInputStream(value.getBytes(java.nio.charset.StandardCharsets.UTF_8));}
        @Override public java.io.OutputStream getOutputStream(){return new ByteArrayOutputStream();}
        @Override public void connect(){} @Override public void disconnect(){} @Override public boolean usingProxy(){return false;}
        @Override public String getCipherSuite(){return "SIMULATION";} @Override public Certificate[] getLocalCertificates(){return null;}
        @Override public Certificate[] getServerCertificates(){return null;} @Override public Principal getPeerPrincipal(){return null;} @Override public Principal getLocalPrincipal(){return null;}
    }
    private Map<String,String> incoming(String event){long now=System.currentTimeMillis();Map<String,String> data=new HashMap<>();data.put("type","sh_operator_call");data.put("engine","livekit");data.put("event",event);data.put("call_id",CALL);data.put("hub_url",HubPolicy.HUB_URL+"?mode=call&call_id="+CALL);data.put("issued_at_ms",String.valueOf(now));data.put("expires_at_ms",String.valueOf(now+60000));return data;}
    private Notification notification(String tag){for(StatusBarNotification value:manager.getActiveNotifications())if(tag.equals(value.getTag()))return value.getNotification();return null;}
    private void await(BooleanSupplier condition) throws Exception {await("Android system condition",condition,()->"");}
    private void await(String stage,BooleanSupplier condition,Supplier<String> diagnostics) throws Exception {long until=SystemClock.elapsedRealtime()+15000;while(!condition.getAsBoolean()&&SystemClock.elapsedRealtime()<until)Thread.sleep(40);assertTrue("Expected "+stage+" did not occur: "+diagnostics.get(),condition.getAsBoolean());}
    private Notification incomingNotification() throws Exception {HubMessagingService.dispatchData(context,incoming("incoming"));await(()->notification(NativeRoomNotifications.key(CALL,""))!=null);return notification(NativeRoomNotifications.key(CALL,""));}
    private void tapElement(ActivityScenario<SimulationHostActivity> scenario, String id) throws Exception {
        AtomicReference<String> rectangle=new AtomicReference<>();CountDownLatch ready=new CountDownLatch(1);
        scenario.onActivity(a->a.web.evaluateJavascript("(()=>{const r=document.getElementById('"+id+"').getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2,ratio:devicePixelRatio})})()",value->{rectangle.set(value);ready.countDown();}));assertTrue(ready.await(20,TimeUnit.SECONDS));
        JSONObject point=new JSONObject((String)new org.json.JSONTokener(rectangle.get()).nextValue());int[] location=new int[2];scenario.onActivity(a->a.web.getLocationOnScreen(location));
        float x=location[0]+(float)(point.getDouble("x")*point.getDouble("ratio")),y=location[1]+(float)(point.getDouble("y")*point.getDouble("ratio"));long down=SystemClock.uptimeMillis();
        instrumentation.sendPointerSync(MotionEvent.obtain(down,down,MotionEvent.ACTION_DOWN,x,y,0));instrumentation.sendPointerSync(MotionEvent.obtain(down,down+80,MotionEvent.ACTION_UP,x,y,0));
    }
    @Test public void deliveredIncomingEnvelopeCreatesRealCallStyleActions() throws Exception {
        assertFalse("This regression must run with full-screen special access denied",manager.canUseFullScreenIntent());
        Notification value=incomingNotification();assertEquals(Notification.CATEGORY_CALL,value.category);assertTrue(value.extras.getString(Notification.EXTRA_TEMPLATE).contains("CallStyle"));
        assertEquals(Notification.VISIBILITY_PRIVATE,value.visibility);assertNotNull(value.extras.getParcelable("android.answerIntent"));assertNotNull(value.extras.getParcelable("android.declineIntent"));assertTrue(store.roomAlertActive(CALL,""));assertFalse(NativeRoomCallService.isRunning());
    }
    @Test public void realDeclinePendingIntentStopsAlertAndQueuesExactRejectWithoutMicrophone() throws Exception {
        Notification value=incomingNotification();android.app.PendingIntent decline=value.extras.getParcelable("android.declineIntent");assertNotNull(decline);decline.send();
        await(()->!store.roomAlertActive(CALL,"")&&notification(NativeRoomNotifications.key(CALL,""))==null);
        await(()->requests.stream().anyMatch(path->path.endsWith("/calls/"+CALL+"/reject")));assertFalse(NativeRoomCallService.isRunning());
    }
    @Test public void dismissSilencesWithoutRejectingCustomer() throws Exception {
        Notification value=incomingNotification();assertNotNull(value.deleteIntent);value.deleteIntent.send();
        // The tombstone is persisted before system_server processes cancellation.
        // Wait for both existing assertions, within the same bounded deadline.
        await("dismissed alert and OS notification cancellation",()->!store.roomAlertActive(CALL,"")&&notification(NativeRoomNotifications.key(CALL,""))==null,
            ()->"alertActive="+store.roomAlertActive(CALL,"")+",notificationPresent="+(notification(NativeRoomNotifications.key(CALL,""))!=null));
        assertNull(notification(NativeRoomNotifications.key(CALL,"")));assertTrue(requests.stream().noneMatch(path->path.endsWith("/reject")));
    }
    @Test public void terminalBeforeIncomingCannotResurrectNotification() throws Exception {
        HubMessagingService.dispatchData(context,incoming("ended"));HubMessagingService.dispatchData(context,incoming("incoming"));
        assertTrue(store.roomAlertClosed(CALL,""));assertNull(notification(NativeRoomNotifications.key(CALL,"")));
    }
    @Test public void expiredAndMisdirectedEnvelopesDoNotRing() throws Exception {
        Map<String,String> data=incoming("incoming");data.put("expires_at_ms",String.valueOf(System.currentTimeMillis()-1));HubMessagingService.dispatchData(context,data);
        data=incoming("incoming");data.put("hub_url","https://evil.example/?call_id="+CALL);HubMessagingService.dispatchData(context,data);
        assertNull(notification(NativeRoomNotifications.key(CALL,"")));assertFalse(store.roomAlertActive(CALL,""));
    }
    @Test public void oldEnrollmentActionCannotDeclineNewRegistrationAlert() throws Exception {
        Notification old=incomingNotification();android.app.PendingIntent decline=old.extras.getParcelable("android.declineIntent");
        store.clearEnrollment();assertTrue(store.enrollIfGeneration(DEVICE,DEVICE+".replacement-simulation-abcdefghijklmnopqrstuvwxyz",System.currentTimeMillis()+3600000,store.credential().generation));
        store.roomIncoming(CALL,"",System.currentTimeMillis(),System.currentTimeMillis()+60000);NativeRoomNotifications.show(context,CALL,"",System.currentTimeMillis()+60000);
        decline.send();instrumentation.waitForIdleSync();assertTrue(store.roomAlertActive(CALL,""));assertTrue(requests.isEmpty());
    }
    @Test public void answerPendingIntentOpensCorrectCallAndTerminalWinsDuringPermissionPrompt() throws Exception {
        // The emulator run deliberately never grants RECORD_AUDIO. This exercises
        // Android's real permission/Activity path without pretending to prove speech.
        assertNotEquals(android.content.pm.PackageManager.PERMISSION_GRANTED,context.checkSelfPermission(Manifest.permission.RECORD_AUDIO));
        try(ActivityScenario<SimulationHostActivity> foreground=ActivityScenario.launch(SimulationHostActivity.class)){
            Instrumentation.ActivityMonitor monitor=instrumentation.addMonitor(NativeRoomCallActivity.class.getName(),null,false);
            try {
                Notification value=incomingNotification();android.app.PendingIntent answer=value.extras.getParcelable("android.answerIntent");assertNotNull(answer);answer.send();
                Activity shown=instrumentation.waitForMonitorWithTimeout(monitor,20000);assertNotNull("Android did not open the answer Activity",shown);assertEquals(CALL,shown.getIntent().getStringExtra("call_id"));
                assertFalse(NativeRoomCallService.isRunning());HubMessagingService.dispatchData(context,incoming("ended"));
                await("terminal call closes permission-stage Activity",shown::isFinishing,
                    ()->"finishing="+shown.isFinishing()+",destroyed="+shown.isDestroyed()+",alertClosed="+store.roomAlertClosed(CALL,"")+",serviceRunning="+NativeRoomCallService.isRunning());assertFalse(NativeRoomCallService.isRunning());
            }finally{instrumentation.removeMonitor(monitor);}
        }
    }
    @Test public void messageEnvelopeCreatesPrivateConversationNotification() throws Exception {
        long now=System.currentTimeMillis();Map<String,String> data=new HashMap<>();data.put("type","sh_operator_message");data.put("channel_id","73");data.put("message_id","901");data.put("issued_at_ms",String.valueOf(now));data.put("expires_at_ms",String.valueOf(now+30000));data.put("hub_url",HubPolicy.HUB_URL+"?channel_id=73&channel=73");
        HubMessagingService.dispatchData(context,data);await(()->notification("message:73")!=null);Notification value=notification("message:73");assertEquals(Notification.VISIBILITY_PRIVATE,value.visibility);assertTrue(value.extras.getString(Notification.EXTRA_TEMPLATE).contains("BigTextStyle"));assertNotNull(value.contentIntent);
        HubMessagingService.dispatchData(context,data);assertEquals(1,manager.getActiveNotifications().length); // one standalone conversation alert
    }
    @Test public void realWebViewPopupConnectsThroughExactOpenerWithoutNativeCredential() throws Exception {
        // Genuine pointer input is necessary: programmatic click() is not a user gesture.
        try(ActivityScenario<SimulationHostActivity> scenario=ActivityScenario.launch(SimulationHostActivity.class)){
            AtomicReference<SimulationHostActivity> host=new AtomicReference<>();scenario.onActivity(host::set);
            await("Hub WebView initial page",()->host.get().pageReady,()->host.get().diagnostics());
            tapElement(scenario,"connect");
            await("operator popup authentication",()->"connected".equals(host.get().result),()->host.get().diagnostics());assertTrue(host.get().popupOpened);assertEquals(1,host.get().tokenRequests);assertEquals("",host.get().otherNavigation);assertEquals("undefined",host.get().popupNativeVisibility);
            AtomicReference<String> connected=new AtomicReference<>();CountDownLatch checked=new CountDownLatch(1);scenario.onActivity(a->a.web.evaluateJavascript("JSON.stringify({connected:SHOperatorAuth.connected(),device:SHOperatorAuth.identity().operatorDeviceId})",value->{connected.set(value);checked.countDown();}));assertTrue(checked.await(20,TimeUnit.SECONDS));
            assertTrue(connected.get().contains("web_0123456789abcdef0123456789abcdef"));assertFalse(connected.get().contains(DEVICE));
        }
    }
    @Test public void popupRejectsNonGesture() throws Exception {
        try(ActivityScenario<SimulationHostActivity> scenario=ActivityScenario.launch(SimulationHostActivity.class)){
            scenario.onActivity(a->{android.os.Message message=android.os.Message.obtain();message.obj=a.web.new WebViewTransport();assertFalse(a.auth.open(a.web,false,message));});
        }
    }
    @Test public void delayedQuotationNavigationPreservesUserOpenedBlankWindow() throws Exception {
        try(ActivityScenario<SimulationHostActivity> scenario=ActivityScenario.launch(SimulationHostActivity.class)){
            AtomicReference<SimulationHostActivity> host=new AtomicReference<>();scenario.onActivity(host::set);await("quotation Hub WebView initial page",()->host.get().pageReady,()->host.get().diagnostics());
            tapElement(scenario,"quotation");
            await("quotation popup navigation",()->"https://www.smarthandicrafts.com/odoo/sales/17".equals(host.get().otherNavigation),()->host.get().diagnostics());
            assertTrue(host.get().popupOpened);assertEquals(0,host.get().tokenRequests);
        }
    }
    @Test public void nativeCallScreenDeclaresPortraitAndEndFitsViewport() throws Exception {
        Intent open=new Intent(context,NativeRoomCallActivity.class).putExtra("room_action","dial").putExtra("channel_id",73).putExtra("display_name","Simulation customer");
        try(ActivityScenario<NativeRoomCallActivity> scenario=ActivityScenario.launch(open)){
            scenario.onActivity(a->{try{
                assertEquals(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT,a.getRequestedOrientation());
                JSONObject view=new JSONObject().put("callId",CALL).put("clientAttemptId","de3cc9b1-d0f7-4c06-a677-2c99cf8ef319").put("ownerLegId","simulation-leg").put("channelId",73).put("displayName","Simulation customer").put("detail","Connected").put("state","connected");
                java.lang.reflect.Method render=NativeRoomCallActivity.class.getDeclaredMethod("render",JSONObject.class);render.setAccessible(true);render.invoke(a,view);
            }catch(Exception error){throw new AssertionError(error);}});
            instrumentation.waitForIdleSync();
            scenario.onActivity(a->{try{Field f=NativeRoomCallActivity.class.getDeclaredField("end");f.setAccessible(true);Button end=(Button)f.get(a);android.graphics.Rect visible=new android.graphics.Rect();assertTrue(end.getGlobalVisibleRect(visible));assertEquals(View.VISIBLE,end.getVisibility());assertTrue(end.isEnabled());assertTrue(visible.height()>=NativeUi.dp(a,48));}catch(Exception error){throw new AssertionError(error);}});
        }
    }
}
