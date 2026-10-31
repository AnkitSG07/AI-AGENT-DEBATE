package com.smarthandicrafts.operatorhub;

import android.app.Application;
import android.content.Intent;
import android.os.Looper;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import java.lang.reflect.Field;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class) @Config(sdk=28,application=Application.class)
public class NativeCallPermissionUiTest {
    private Application app;private NativeStore store;
    private static final String TO=NativeCallPermissionStateTest.TO;
    @Before public void setup(){
        app=RuntimeEnvironment.getApplication();app.getSharedPreferences("native_private",0).edit().clear().commit();
        Shadows.shadowOf(app).grantPermissions("com.smarthandicrafts.operatorhub.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION");
        store=new NativeStore(app);String id="android_permission_device_1234567";
        assertTrue(store.enrollIfGeneration(id,id+".abcdefghijklmnopqrstuvwxyz0123456789",System.currentTimeMillis()+1000000,store.credential().generation));
    }
    private static Object field(Object object,String name) throws Exception {Field f=object.getClass().getDeclaredField(name);f.setAccessible(true);return f.get(object);}
    private static void set(Object object,String name,Object value) throws Exception {Field f=object.getClass().getDeclaredField(name);f.setAccessible(true);f.set(object,value);}
    private ActivityController<NativeRoomCallActivity> open(){return Robolectric.buildActivity(NativeRoomCallActivity.class,new Intent(app,NativeRoomCallActivity.class).putExtra("room_action","dial").putExtra("phone",TO)).setup();}
    private Button button(NativeRoomCallActivity a,String name)throws Exception{return (Button)field(a,name);}
    private void awaitIdle(NativeRoomCallActivity a) throws Exception {
        long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);
        while((Boolean)field(a,"permissionBusy")&&System.nanoTime()<until){Shadows.shadowOf(Looper.getMainLooper()).idle();Thread.sleep(5);}
        Shadows.shadowOf(Looper.getMainLooper()).idle();assertFalse((Boolean)field(a,"permissionBusy"));
    }
    private void noCall(){assertFalse(NativeRoomCallService.isRunning());assertNull(Shadows.shadowOf(app).getNextStartedService());}
    @Test public void checkIsReadOnlyAndAllowedResultNeverAutoDials() throws Exception {
        try(ActivityController<NativeRoomCallActivity> c=open()){
            NativeRoomCallActivity a=c.get();AtomicInteger calls=new AtomicInteger();
            set(a,"callApi",(NativeRoomCleanupProcessor.Requester)(path,method,body,bearer)->{
                assertEquals("/call-permission/status?to="+TO,path);assertEquals("GET",method);assertNull(body);calls.incrementAndGet();
                return NativeCallPermissionStateTest.response("permanent",true,false,0,"","");});
            button(a,"checkCallPermission").performClick();awaitIdle(a);assertEquals(1,calls.get());assertTrue(button(a,"accept").isEnabled());assertFalse(button(a,"requestCallPermission").isEnabled());noCall();
        }
    }
    @Test public void explicitRequestPersistsExactReceiptAndSentDoesNotEnableCall() throws Exception {
        try(ActivityController<NativeRoomCallActivity> c=open()){
            NativeRoomCallActivity a=c.get();AtomicInteger calls=new AtomicInteger();AtomicReference<String> receipt=new AtomicReference<>();
            set(a,"callApi",(NativeRoomCleanupProcessor.Requester)(path,method,body,bearer)->{
                assertEquals("/call-permission/request",path);assertEquals("POST",method);assertEquals(TO,body.getString("to"));
                String id=body.getString("requestId");assertEquals(id,store.callPermissionRequestId(store.credential(),TO));receipt.set(id);calls.incrementAndGet();
                return NativeCallPermissionStateTest.response("no_permission",false,false,0,"sent",id);});
            button(a,"requestCallPermission").performClick();awaitIdle(a);assertEquals(1,calls.get());assertNotNull(receipt.get());
            assertFalse(button(a,"accept").isEnabled());assertFalse(button(a,"requestCallPermission").isEnabled());
            assertTrue(((TextView)field(a,"callPermissionStatus")).getText().toString().contains("A sent message is not permission"));noCall();
        }
    }
    @Test public void lostRequestAcknowledgementRequiresCheckAndRetainsIdAcrossRecreation() throws Exception {
        String saved;
        try(ActivityController<NativeRoomCallActivity> c=open()){
            NativeRoomCallActivity a=c.get();set(a,"callApi",(NativeRoomCleanupProcessor.Requester)(path,method,body,bearer)->{throw new java.io.IOException("lost ACK");});
            button(a,"requestCallPermission").performClick();awaitIdle(a);saved=store.callPermissionRequestId(store.credential(),TO);assertTrue(NativeCallPermissionState.validRequestId(saved));
            assertFalse(button(a,"requestCallPermission").isEnabled());assertTrue(button(a,"checkCallPermission").isEnabled());assertFalse(button(a,"accept").isEnabled());noCall();
        }
        final String expected=saved;
        try(ActivityController<NativeRoomCallActivity> c=open()){
            NativeRoomCallActivity a=c.get();set(a,"callApi",(NativeRoomCleanupProcessor.Requester)(path,method,body,bearer)->{
                assertEquals(expected,body.getString("requestId"));return NativeCallPermissionStateTest.response("unknown",false,false,0,"uncertain",expected);});
            button(a,"requestCallPermission").performClick();awaitIdle(a);assertFalse(button(a,"requestCallPermission").isEnabled());noCall();
        }
    }
    @Test public void definiteWindowBlockIsActionableAndRequiresFreshCheck() throws Exception {
        try(ActivityController<NativeRoomCallActivity> c=open()){
            NativeRoomCallActivity a=c.get();set(a,"callApi",(NativeRoomCleanupProcessor.Requester)(path,method,body,bearer)->{
                throw new NativeApi.ApiException(409,"blocked",new JSONObject().put("code","CALL_PERMISSION_WINDOW_CLOSED")
                    .put("request",new JSONObject().put("requestId",body.getString("requestId")).put("state","blocked")));});
            button(a,"requestCallPermission").performClick();awaitIdle(a);
            String message=((TextView)field(a,"callPermissionStatus")).getText().toString();
            assertTrue(message.contains("messaging window is closed"));assertTrue(message.contains("No permission request was sent"));
            assertFalse(message.contains("unconfirmed"));assertFalse(button(a,"requestCallPermission").isEnabled());assertTrue(button(a,"checkCallPermission").isEnabled());noCall();
        }
    }
    @Test public void changedDestinationCannotReceiveOldPermissionResult() throws Exception {
        CountDownLatch entered=new CountDownLatch(1),release=new CountDownLatch(1),finished=new CountDownLatch(1);
        try(ActivityController<NativeRoomCallActivity> c=open()){
            NativeRoomCallActivity a=c.get();set(a,"callApi",(NativeRoomCleanupProcessor.Requester)(path,method,body,bearer)->{entered.countDown();assertTrue(release.await(5,TimeUnit.SECONDS));finished.countDown();return NativeCallPermissionStateTest.response("permanent",true,false,0,"","");});
            button(a,"checkCallPermission").performClick();assertTrue(entered.await(5,TimeUnit.SECONDS));((EditText)field(a,"dialInput")).setText("919009999999");release.countDown();assertTrue(finished.await(5,TimeUnit.SECONDS));Thread.sleep(20);Shadows.shadowOf(Looper.getMainLooper()).idle();
            assertNull(field(a,"permissionState"));assertFalse(((TextView)field(a,"callPermissionStatus")).getText().toString().contains("Calls allowed"));noCall();
        }finally{release.countDown();}
    }
    @Test public void reenrollmentInvalidatesAnInFlightPermissionResult() throws Exception {
        CountDownLatch entered=new CountDownLatch(1),release=new CountDownLatch(1);
        try(ActivityController<NativeRoomCallActivity> c=open()){
            NativeRoomCallActivity a=c.get();set(a,"callApi",(NativeRoomCleanupProcessor.Requester)(path,method,body,bearer)->{entered.countDown();assertTrue(release.await(5,TimeUnit.SECONDS));return NativeCallPermissionStateTest.response("permanent",true,false,0,"","");});
            button(a,"checkCallPermission").performClick();assertTrue(entered.await(5,TimeUnit.SECONDS));store.clearEnrollment();release.countDown();awaitIdle(a);
            assertFalse(button(a,"accept").isEnabled());assertFalse(button(a,"requestCallPermission").isEnabled());assertTrue(((TextView)field(a,"callPermissionStatus")).getText().toString().contains("registration changed"));noCall();
        }finally{release.countDown();}
    }
    @Test public void permissionThatExpiresAfterCheckCannotStartOnALaterCallTap() throws Exception {
        try(ActivityController<NativeRoomCallActivity> c=open()){
            NativeRoomCallActivity a=c.get();long before=System.currentTimeMillis()-60000;
            JSONObject response=NativeCallPermissionStateTest.response("temporary",true,false,System.currentTimeMillis()-1000,"","");
            response.getJSONObject("permission").put("checkedAtMs",before);
            NativeCallPermissionState previous=NativeCallPermissionState.parse(response,TO,"",before);
            assertTrue(previous.canCall);set(a,"permissionState",previous);set(a,"permissionDestination",TO);
            button(a,"accept").performClick();assertFalse(button(a,"accept").isEnabled());
            assertTrue(((TextView)field(a,"callPermissionStatus")).getText().toString().contains("not current"));noCall();
        }
    }
    @Test public void mismatchedServerNumberCannotEnableTheCallButton() throws Exception {
        try(ActivityController<NativeRoomCallActivity> c=open()){
            NativeRoomCallActivity a=c.get();set(a,"callApi",(NativeRoomCleanupProcessor.Requester)(path,method,body,bearer)->NativeCallPermissionStateTest.response("permanent",true,false,0,"","").put("to","919009999999"));
            button(a,"checkCallPermission").performClick();awaitIdle(a);assertFalse(button(a,"accept").isEnabled());assertNull(field(a,"permissionState"));noCall();
        }
    }
}
