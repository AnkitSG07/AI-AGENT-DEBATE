package com.smarthandicrafts.operatorhub;

import android.app.Application;
import android.app.Notification;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.view.View;
import android.widget.Button;
import android.widget.TextView;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.Before;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.android.controller.ServiceController;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.shadows.ShadowNotificationManager;
import java.io.File;
import java.io.FileOutputStream;
import java.lang.reflect.Field;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class) @Config(sdk = 28, application = Application.class, qualifiers = "w320dp-h480dp-port-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public class NativeRoomPlatformUiTest {
    private static final String CALL = "out_0123456789abcdef0123456789abcdef";
    private static final String A = "de3cc9b1-d0f7-4c06-a677-2c99cf8ef319", B = "23f5e680-949b-45a7-93c5-24f2e85a8375";
    @Before public void installedSignaturePermission() {
        // This signature permission is present in the merged APK; the fake package manager
        // does not automatically grant an application's own signature permission.
        Shadows.shadowOf(RuntimeEnvironment.getApplication()).grantPermissions("com.smarthandicrafts.operatorhub.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION");
    }
    private static Object field(Object object,String name) throws Exception { Field f=object.getClass().getDeclaredField(name); f.setAccessible(true); return f.get(object); }
    private static void set(Object object,String name,Object value) throws Exception { Field f=object.getClass().getDeclaredField(name); f.setAccessible(true); f.set(object,value); }
    @Test public void endRemainsVisibleOnSmallScreenWithLargeSystemFont() throws Exception {
        Application app=RuntimeEnvironment.getApplication(); Configuration config=new Configuration(app.getResources().getConfiguration()); config.fontScale=1.8f;
        app.getResources().updateConfiguration(config,app.getResources().getDisplayMetrics());
        Intent intent=new Intent(app,NativeRoomCallActivity.class).putExtra("room_action","dial").putExtra("display_name","Example Customer");
        try (ActivityController<NativeRoomCallActivity> controller=Robolectric.buildActivity(NativeRoomCallActivity.class,intent).setup()) {
            NativeRoomCallActivity activity=controller.get();
            JSONObject view=new JSONObject().put("callId",CALL).put("clientAttemptId",A).put("ownerLegId","leg-A1")
                .put("displayName","Example Customer").put("detail","Connected").put("state","connected").put("canTransfer",true).put("audioRoute","Phone");
            java.lang.reflect.Method render=NativeRoomCallActivity.class.getDeclaredMethod("render",JSONObject.class); render.setAccessible(true); render.invoke(activity,view);
            View root=activity.findViewById(android.R.id.content);
            root.measure(View.MeasureSpec.makeMeasureSpec(320,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(480,View.MeasureSpec.EXACTLY)); root.layout(0,0,320,480);
            Button end=(Button)field(activity,"end"); int[] position=new int[2]; end.getLocationInWindow(position);
            assertEquals(View.VISIBLE,end.getVisibility()); assertTrue(end.isEnabled());
            assertTrue("End control is below screen",position[1]+end.getHeight()<=480); assertTrue("End control clipped above screen",position[1]>=0);
            assertTrue("End touch target too short",end.getHeight()>=48);
            TextView hint=(TextView)field(activity,"hint"); assertTrue(hint.getParent() instanceof android.widget.LinearLayout);
            assertNotNull(((Button)field(activity,"speaker")).getContentDescription());
            Bitmap image=Bitmap.createBitmap(320,480,Bitmap.Config.ARGB_8888); root.draw(new Canvas(image));
            File file=new File("build/reports/r12-native-ui/call-320x480-large-font.png"); file.getParentFile().mkdirs();
            try(FileOutputStream output=new FileOutputStream(file)) { assertTrue(image.compress(Bitmap.CompressFormat.PNG,100,output)); }
        }
    }
    @Test @Config(sdk=31) public void nativeNotificationsUseCallStyleAndRetainExactLegPendingIntent() throws Exception {
        Application app=RuntimeEnvironment.getApplication(); CallAlerts.createChannels(app);
        ServiceController<NativeRoomCallService> controller=Robolectric.buildService(NativeRoomCallService.class).create();
        try {
            NativeRoomCallService service=controller.get(); set(service,"callId",CALL); set(service,"requestId",A); set(service,"legId","leg-A1");
            Notification first=NativeRoomNotifications.ongoing(app,CALL,"","Connected");
            assertTrue(first.extras.getString(Notification.EXTRA_TEMPLATE).contains("CallStyle"));
            Intent oldEnd=null; for(Notification.Action action:first.actions) {
                Intent saved=Shadows.shadowOf(action.actionIntent).getSavedIntent(); if("end".equals(saved.getStringExtra("room_action"))) oldEnd=saved;
            }
            assertNotNull(oldEnd); assertEquals(A,oldEnd.getStringExtra("client_attempt_id")); assertEquals("leg-A1",oldEnd.getStringExtra("owner_leg_id"));
            set(service,"requestId",B); set(service,"legId","leg-A2");
            Notification second=NativeRoomNotifications.ongoing(app,CALL,"","Connected");
            Intent newEnd=null; for(Notification.Action action:second.actions) { Intent saved=Shadows.shadowOf(action.actionIntent).getSavedIntent(); if("end".equals(saved.getStringExtra("room_action"))) newEnd=saved; }
            assertNotNull(newEnd); assertNotEquals(oldEnd.getData(),newEnd.getData()); assertEquals(A,oldEnd.getStringExtra("client_attempt_id"));
            assertEquals(B,newEnd.getStringExtra("client_attempt_id"));
        } finally { controller.destroy(); }
        NativeRoomNotifications.show(app,CALL,"transfer-example",System.currentTimeMillis()+30000);
        android.app.NotificationManager manager=app.getSystemService(android.app.NotificationManager.class);
        Notification incoming=Shadows.shadowOf(manager).getNotification(NativeRoomNotifications.key(CALL,"transfer-example"),101);
        assertNotNull(incoming); assertTrue(incoming.extras.getString(Notification.EXTRA_TEMPLATE).contains("CallStyle"));
        boolean answer=false,decline=false;
        for(Notification.Action action:incoming.actions) {
            Intent saved=Shadows.shadowOf(action.actionIntent).getSavedIntent(); assertEquals("transfer-example",saved.getStringExtra("transfer_id"));
            answer|="accept".equals(saved.getStringExtra("room_action")); decline|="decline".equals(saved.getStringExtra("room_action"));
        }
        assertTrue(answer); assertTrue(decline);
    }
    @Implements(android.app.NotificationManager.class)
    public static class DeniedFullScreenNotificationManager extends ShadowNotificationManager {
        @Implementation(minSdk=34) protected boolean canUseFullScreenIntent() { return false; }
    }
    @Test @Config(sdk=35, shadows=DeniedFullScreenNotificationManager.class)
    public void deniedFullScreenAccessRetainsValidIncomingCallStyleAndExactActions() throws Exception {
        Application app=RuntimeEnvironment.getApplication(); CallAlerts.createChannels(app);
        Shadows.shadowOf(app).grantPermissions(android.Manifest.permission.POST_NOTIFICATIONS);
        android.app.NotificationManager manager=app.getSystemService(android.app.NotificationManager.class);
        assertFalse(manager.canUseFullScreenIntent());
        NativeStore store=enrollForPrompt(app);
        NativeRoomNotifications.show(app,CALL,"transfer-denied-fsi",System.currentTimeMillis()+30000);
        Notification incoming=Shadows.shadowOf(manager).getNotification(NativeRoomNotifications.key(CALL,"transfer-denied-fsi"),101);
        assertNotNull(incoming); assertTrue(incoming.extras.getString(Notification.EXTRA_TEMPLATE).contains("CallStyle"));
        assertEquals(Notification.CATEGORY_CALL,incoming.category); assertEquals(Notification.VISIBILITY_PRIVATE,incoming.visibility);
        assertNotNull("Android must receive the FSI request to provide its permission-denied heads-up fallback",incoming.fullScreenIntent);
        assertTrue(incoming.fullScreenIntent.isImmutable());
        Intent shown=Shadows.shadowOf(incoming.fullScreenIntent).getSavedIntent();
        assertEquals(CALL,shown.getStringExtra("call_id")); assertEquals("transfer-denied-fsi",shown.getStringExtra("transfer_id"));
        assertEquals("show",shown.getStringExtra("room_action")); assertEquals(store.credential().generation,shown.getLongExtra("enrollment_generation",-1));
        boolean answer=false,decline=false;
        for(Notification.Action action:incoming.actions) {
            assertTrue(action.actionIntent.isImmutable()); Intent saved=Shadows.shadowOf(action.actionIntent).getSavedIntent();
            assertEquals(CALL,saved.getStringExtra("call_id")); assertEquals("transfer-denied-fsi",saved.getStringExtra("transfer_id"));
            assertEquals(store.credential().generation,saved.getLongExtra("enrollment_generation",-1));
            answer|="accept".equals(saved.getStringExtra("room_action")); decline|="decline".equals(saved.getStringExtra("room_action"));
        }
        assertTrue(answer); assertTrue(decline); assertFalse(NativeRoomCallService.isRunning());
    }
    @Test public void terminalNotificationWhilePermissionIsOpenCannotStartAudioLater() throws Exception {
        Application app=RuntimeEnvironment.getApplication(); NativeStore store=new NativeStore(app);
        String id="android_1234567890abcdefghijklmnop";
        assertTrue(store.enrollIfGeneration(id,id+".abcdefghijklmnopqrstuvwxyz0123456789",System.currentTimeMillis()+1000000,store.credential().generation));
        Shadows.shadowOf(app).denyPermissions(android.Manifest.permission.RECORD_AUDIO);
        Intent intent=new Intent(app,NativeRoomCallActivity.class).putExtra("room_action","accept").putExtra("call_id",CALL);
        try(ActivityController<NativeRoomCallActivity> controller=Robolectric.buildActivity(NativeRoomCallActivity.class,intent).setup()) {
            NativeRoomCallActivity activity=controller.get(); assertTrue((Boolean)field(activity,"starting"));
            store.closeRoomAlert(CALL,""); NativeRoomNotifications.cancelTerminal(app,CALL,"");
            Shadows.shadowOf(android.os.Looper.getMainLooper()).idle(); assertTrue(activity.isFinishing());
            activity.onRequestPermissionsResult(41,new String[]{android.Manifest.permission.RECORD_AUDIO},new int[]{android.content.pm.PackageManager.PERMISSION_GRANTED});
            Shadows.shadowOf(android.os.Looper.getMainLooper()).idle(); assertFalse(NativeRoomCallService.isRunning());
            assertNull(Shadows.shadowOf(app).getNextStartedService());
        }
    }
    @Test public void visualCancelDoesNotAbortExplicitResumeBecauseOfAnOldAlertTombstone() throws Exception {
        Application app=RuntimeEnvironment.getApplication(); NativeStore store=new NativeStore(app);
        String id="android_1234567890abcdefghijklmnop";
        assertTrue(store.enrollIfGeneration(id,id+".abcdefghijklmnopqrstuvwxyz0123456789",System.currentTimeMillis()+1000000,store.credential().generation));
        store.closeRoomAlert(CALL,""); Shadows.shadowOf(app).denyPermissions(android.Manifest.permission.RECORD_AUDIO);
        Intent intent=new Intent(app,NativeRoomCallActivity.class).putExtra("room_action","accept").putExtra("call_id",CALL);
        try(ActivityController<NativeRoomCallActivity> controller=Robolectric.buildActivity(NativeRoomCallActivity.class,intent).setup()) {
            Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
            assertFalse(controller.get().isFinishing()); assertTrue((Boolean)field(controller.get(),"starting"));
            assertNull(Shadows.shadowOf(app).getNextStartedService());
        }
    }
    @Test public void localEndReturnsToExactSourceChatWithoutWaitingForServer() throws Exception {
        Application app=RuntimeEnvironment.getApplication();
        Intent intent=new Intent(app,NativeRoomCallActivity.class).putExtra("room_action","dial").putExtra("channel_id",73);
        try(ActivityController<NativeRoomCallActivity> controller=Robolectric.buildActivity(NativeRoomCallActivity.class,intent).setup()) {
            NativeRoomCallActivity activity=controller.get();
            JSONObject view=new JSONObject().put("callId",CALL).put("providerCallId","wamid-test-call").put("clientAttemptId",A).put("ownerLegId","leg-A1")
                .put("channelId",73).put("displayName","Example Customer").put("detail","Connected").put("state","connected");
            java.lang.reflect.Method render=NativeRoomCallActivity.class.getDeclaredMethod("render",JSONObject.class); render.setAccessible(true); render.invoke(activity,view);
            ((Button)field(activity,"end")).performClick();
            assertTrue(activity.isFinishing()); Intent returned=Shadows.shadowOf(activity).getNextStartedActivity();
            assertNotNull(returned); assertEquals(73,returned.getIntExtra("channel_id",0));
            assertEquals(CALL,returned.getStringExtra("native_closed_call_id")); assertEquals(A,returned.getStringExtra("native_closed_attempt_id"));
            assertEquals("leg-A1",returned.getStringExtra("native_closed_owner_leg_id"));
        }
    }
    @Test public void differentIncomingIntentResetsOldActiveControlsWithoutEndingTheActiveCall() throws Exception {
        Application app=RuntimeEnvironment.getApplication();
        ServiceController<NativeRoomCallService> serviceController=Robolectric.buildService(NativeRoomCallService.class).create();
        try {
            NativeRoomCallService service=serviceController.get(); set(service,"callId",CALL); set(service,"requestId",A); set(service,"legId","leg-A1"); set(service,"state","connected");
            Intent first=new Intent(app,NativeRoomCallActivity.class).putExtra("room_action","show").putExtra("call_id",CALL).putExtra("client_attempt_id",A);
            try(ActivityController<NativeRoomCallActivity> controller=Robolectric.buildActivity(NativeRoomCallActivity.class,first).setup()) {
                NativeRoomCallActivity activity=controller.get(); assertEquals(View.VISIBLE,((Button)field(activity,"end")).getVisibility());
                activity.onNewIntent(new Intent(app,NativeRoomCallActivity.class).putExtra("room_action","show").putExtra("call_id","out_another_valid_call_12345678").putExtra("display_name","Other customer"));
                assertEquals("Other customer",((TextView)field(activity,"title")).getText().toString());
                assertEquals(View.GONE,((View)field(activity,"end")).getVisibility()); assertEquals(View.GONE,((View)field(activity,"activeActions")).getVisibility());
                assertEquals(View.GONE,((View)field(activity,"dialInput")).getVisibility()); assertEquals(View.GONE,((View)field(activity,"timer")).getVisibility());
                assertEquals(View.VISIBLE,((View)field(activity,"incomingActions")).getVisibility()); assertFalse(((Button)field(activity,"accept")).isEnabled()); assertTrue(((Button)field(activity,"decline")).isEnabled());
                assertEquals(CALL,NativeRoomCallService.snapshot().optString("callId")); assertFalse(NativeRoomCallService.snapshot().optBoolean("closed"));
                java.util.concurrent.atomic.AtomicInteger checks=new java.util.concurrent.atomic.AtomicInteger();
                set(activity,"callApi",(NativeRoomCleanupProcessor.Requester)(path,method,body,bearer)->{
                    assertEquals("/calls/out_another_valid_call_12345678/status",path); checks.incrementAndGet();
                    return new JSONObject().put("ok",true).put("call",new JSONObject().put("phase","incoming").put("ownerDeviceId",JSONObject.NULL));
                });
                set(service,"closed",true);
                app.sendBroadcast(new Intent(NativeRoomNotifications.CHANGED).setPackage(app.getPackageName()).putExtra("snapshot",NativeRoomCallService.snapshot().toString()));
                long until=System.nanoTime()+java.util.concurrent.TimeUnit.SECONDS.toNanos(2);
                while(checks.get()==0 && System.nanoTime()<until) { Shadows.shadowOf(android.os.Looper.getMainLooper()).idle(); Thread.sleep(5); }
                Shadows.shadowOf(android.os.Looper.getMainLooper()).idle(); assertEquals(1,checks.get());
                assertTrue(((Button)field(activity,"accept")).isEnabled()); assertFalse((Boolean)field(activity,"starting"));
                assertEquals("Other customer",((TextView)field(activity,"title")).getText().toString()); assertNull(Shadows.shadowOf(app).getNextStartedService());
            }
        } finally { serviceController.destroy(); }
    }
    private NativeStore enrollForPrompt(Application app) {
        NativeStore store=new NativeStore(app); String id="android_1234567890abcdefghijklmnop";
        assertTrue(store.enrollIfGeneration(id,id+".abcdefghijklmnopqrstuvwxyz0123456789",System.currentTimeMillis()+1000000,store.credential().generation));
        return store;
    }
    private void replaceEnrollment(NativeStore store) {
        store.clearEnrollment(); String id="android_replacement_device_12345678";
        assertTrue(store.enrollIfGeneration(id,id+".abcdefghijklmnopqrstuvwxyz0123456789",System.currentTimeMillis()+1000000,store.credential().generation));
    }
    @Test public void permissionResultCannotStartUnderAReplacementEnrollment() throws Exception {
        Application app=RuntimeEnvironment.getApplication(); NativeStore store=enrollForPrompt(app); Shadows.shadowOf(app).denyPermissions(android.Manifest.permission.RECORD_AUDIO);
        Intent intent=new Intent(app,NativeRoomCallActivity.class).putExtra("room_action","accept").putExtra("call_id",CALL);
        try(ActivityController<NativeRoomCallActivity> controller=Robolectric.buildActivity(NativeRoomCallActivity.class,intent).setup()) {
            NativeRoomCallActivity activity=controller.get(); assertTrue((Boolean)field(activity,"starting")); replaceEnrollment(store);
            Shadows.shadowOf(app).grantPermissions(android.Manifest.permission.RECORD_AUDIO);
            activity.onRequestPermissionsResult(41,new String[]{android.Manifest.permission.RECORD_AUDIO},new int[]{android.content.pm.PackageManager.PERMISSION_GRANTED});
            Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
            assertFalse((Boolean)field(activity,"starting")); assertNull(Shadows.shadowOf(app).getNextStartedService());
            assertEquals("Device registration changed. Reopen the call.",((TextView)field(activity,"status")).getText().toString());
        }
    }
    @Test public void resumeContinuationCannotStartUnderAReplacementEnrollment() throws Exception {
        Application app=RuntimeEnvironment.getApplication(); NativeStore store=enrollForPrompt(app); Shadows.shadowOf(app).grantPermissions(android.Manifest.permission.RECORD_AUDIO);
        Intent intent=new Intent(app,NativeRoomCallActivity.class).putExtra("room_action","accept").putExtra("call_id",CALL);
        try(ActivityController<NativeRoomCallActivity> controller=Robolectric.buildActivity(NativeRoomCallActivity.class,intent).create().start()) {
            assertTrue((Boolean)field(controller.get(),"starting")); replaceEnrollment(store); controller.resume();
            Shadows.shadowOf(android.os.Looper.getMainLooper()).idleFor(200,java.util.concurrent.TimeUnit.MILLISECONDS);
            assertNull(Shadows.shadowOf(app).getNextStartedService()); assertFalse((Boolean)field(controller.get(),"starting"));
        }
    }
    @Test public void benignLeaseRenewalDuringPermissionPromptRetainsTheAuthorizedStart() throws Exception {
        Application app=RuntimeEnvironment.getApplication(); NativeStore store=enrollForPrompt(app); DeviceLeasePolicy.Credential before=store.credential();
        Shadows.shadowOf(app).denyPermissions(android.Manifest.permission.RECORD_AUDIO);
        Intent intent=new Intent(app,NativeRoomCallActivity.class).putExtra("room_action","accept").putExtra("call_id",CALL);
        try(ActivityController<NativeRoomCallActivity> controller=Robolectric.buildActivity(NativeRoomCallActivity.class,intent).setup()) {
            assertTrue(store.applyLeaseExpiry(before,before.deviceId,System.currentTimeMillis()+2000000));
            Shadows.shadowOf(app).grantPermissions(android.Manifest.permission.RECORD_AUDIO);
            controller.get().onRequestPermissionsResult(41,new String[]{android.Manifest.permission.RECORD_AUDIO},new int[]{android.content.pm.PackageManager.PERMISSION_GRANTED});
            Intent started=Shadows.shadowOf(app).getNextStartedService(); assertNotNull(started);
            assertEquals(before.generation,started.getLongExtra("enrollment_generation",-1)); assertEquals(before.deviceId,started.getStringExtra("enrolled_device_id"));
            assertNull(Shadows.shadowOf(app).getNextStartedService());
        }
    }
}
