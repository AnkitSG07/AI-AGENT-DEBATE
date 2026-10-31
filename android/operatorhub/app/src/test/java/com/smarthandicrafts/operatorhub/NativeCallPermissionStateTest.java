package com.smarthandicrafts.operatorhub;

import android.app.Application;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class) @Config(sdk=28,application=Application.class)
public class NativeCallPermissionStateTest {
    static final String TO="919001234567",ID="de3cc9b1-d0f7-4c06-a677-2c99cf8ef319";
    static JSONObject response(String status,boolean canCall,boolean canRequest,long expiry,String state,String id) throws Exception {
        JSONObject value=new JSONObject().put("ok",true).put("to",TO).put("permission",new JSONObject().put("status",status)
            .put("canCall",canCall).put("canRequest",canRequest).put("checkedAtMs",System.currentTimeMillis())
            .put("expiresAtMs",expiry>0?expiry:JSONObject.NULL));
        return value.put("request",state.isEmpty()?JSONObject.NULL:new JSONObject().put("requestId",id).put("state",state));
    }
    @Test public void normalizesDialerNumbersAndRejectsMalformedDestinations() {
        assertEquals(TO,NativeCallPermissionState.normalize("+91 (900) 123-4567"));
        for(String invalid:new String[]{"0919001234567","javascript:919001234567","+91abc001234567","123","9999999999999999",""})
            assertEquals(invalid,"",NativeCallPermissionState.normalize(invalid));
    }
    @Test public void deliveredRequestNeverCreatesCustomerPermission() throws Exception {
        NativeCallPermissionState value=NativeCallPermissionState.parse(response("no_permission",true,true,0,"sent",ID),TO,ID,System.currentTimeMillis());
        assertFalse(value.canCall);assertTrue(value.message().contains("A sent message is not permission"));
    }
    @Test public void expiredTemporaryPermissionCannotEnableCalling() throws Exception {
        NativeCallPermissionState value=NativeCallPermissionState.parse(response("temporary",true,true,System.currentTimeMillis()-1000,"",""),TO,"",System.currentTimeMillis());
        assertFalse(value.canCall);assertTrue(value.message().contains("expired"));
    }
    @Test public void temporaryAndPermanentPermissionsAreDistinct() throws Exception {
        NativeCallPermissionState temporary=NativeCallPermissionState.parse(response("temporary",true,true,System.currentTimeMillis()+60000,"",""),TO,"",System.currentTimeMillis());
        NativeCallPermissionState permanent=NativeCallPermissionState.parse(response("permanent",true,true,0,"",""),TO,"",System.currentTimeMillis());
        assertTrue(temporary.canCall);assertFalse(temporary.canRequest);assertTrue(temporary.message().contains("until"));
        assertTrue(permanent.canCall);assertFalse(permanent.canRequest);assertFalse(permanent.message().contains("until"));
    }
    @Test public void sendingOrUncertainRequestsNeverAllowAnotherSend() throws Exception {
        for(String state:new String[]{"sending","uncertain"}){
            NativeCallPermissionState value=NativeCallPermissionState.parse(response("unknown",false,true,0,state,ID),TO,ID,System.currentTimeMillis());
            assertFalse(value.canCall);assertFalse(value.canRequest);assertTrue(value.message().contains("unconfirmed"));
        }
    }
    @Test public void exactNumberAndRequestIdentityAreRequired() throws Exception {
        JSONObject other=response("permanent",true,false,0,"sent",ID).put("to","919009999999");
        assertThrows(Exception.class,()->NativeCallPermissionState.parse(other,TO,ID,System.currentTimeMillis()));
        JSONObject wrongId=response("permanent",true,false,0,"sent","another-valid-request");
        assertThrows(Exception.class,()->NativeCallPermissionState.parse(wrongId,TO,ID,System.currentTimeMillis()));
    }
    @Test public void malformedFlagsUnknownStatesAndExpiryFailClosed() throws Exception {
        JSONObject flags=response("permanent",true,false,0,"","");flags.getJSONObject("permission").put("canCall","true");
        assertThrows(Exception.class,()->NativeCallPermissionState.parse(flags,TO,"",System.currentTimeMillis()));
        JSONObject unknown=response("maybe",true,false,0,"","");
        assertThrows(Exception.class,()->NativeCallPermissionState.parse(unknown,TO,"",System.currentTimeMillis()));
        JSONObject temporary=response("temporary",true,false,0,"","");
        assertThrows(Exception.class,()->NativeCallPermissionState.parse(temporary,TO,"",System.currentTimeMillis()));
    }
    @Test public void contradictoryRequestEligibilityFailsClosedAndOkMustBeBoolean() throws Exception {
        for(String status:new String[]{"unknown","permanent","temporary"}){
            NativeCallPermissionState value=NativeCallPermissionState.parse(response(status,false,true,System.currentTimeMillis()+60000,"",""),TO,"",System.currentTimeMillis());
            assertFalse(value.canRequest);assertFalse(value.canCall);
        }
        JSONObject stringOk=response("no_permission",false,true,0,"","").put("ok","true");
        assertThrows(Exception.class,()->NativeCallPermissionState.parse(stringOk,TO,"",System.currentTimeMillis()));
    }
    @Test public void blockedReceiptExplainsClosedWindowWithoutClaimingDelivery() throws Exception {
        JSONObject response=response("no_permission",false,false,0,"blocked",ID);
        response.getJSONObject("request").put("code","CALL_PERMISSION_WINDOW_CLOSED");
        NativeCallPermissionState value=NativeCallPermissionState.parse(response,TO,ID,System.currentTimeMillis());
        assertTrue(value.message().contains("messaging window is closed"));assertTrue(value.message().contains("No permission request was sent"));assertFalse(value.canCall);
    }
    private NativeStore enrolled() {
        NativeStore store=new NativeStore(RuntimeEnvironment.getApplication());String device="android_permission_device_1234567";
        assertTrue(store.enrollIfGeneration(device,device+".abcdefghijklmnopqrstuvwxyz0123456789",System.currentTimeMillis()+1000000,store.credential().generation));return store;
    }
    @Test public void requestReceiptSurvivesStoreRecreationButIsBoundToEnrollmentAndNumber() {
        NativeStore store=enrolled();DeviceLeasePolicy.Credential old=store.credential();assertTrue(store.rememberCallPermissionRequest(old,TO,ID));
        NativeStore reopened=new NativeStore(RuntimeEnvironment.getApplication());assertEquals(ID,reopened.callPermissionRequestId(old,TO));
        assertEquals("",reopened.callPermissionRequestId(old,"919009999999"));store.clearEnrollment();enrolled();
        assertEquals("",store.callPermissionRequestId(old,TO));assertEquals("",store.callPermissionRequestId(store.credential(),TO));
        assertFalse(store.rememberCallPermissionRequest(old,TO,"replacement-request"));
    }
    @Test public void invalidRequestIdentitiesAreNotPersisted() {
        NativeStore store=enrolled();assertFalse(store.rememberCallPermissionRequest(store.credential(),TO,"bad"));
        assertFalse(store.rememberCallPermissionRequest(store.credential(),"not-a-number",ID));
    }
}
