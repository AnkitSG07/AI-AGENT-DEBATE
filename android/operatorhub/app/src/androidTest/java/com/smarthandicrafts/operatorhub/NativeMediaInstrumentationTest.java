package com.smarthandicrafts.operatorhub;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.SystemClock;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import io.livekit.android.LiveKit;
import io.livekit.android.LiveKitOverrides;
import io.livekit.android.RoomOptions;
import io.livekit.android.room.Room;
import java.io.InputStream;
import java.lang.reflect.Field;
import java.net.InetAddress;
import java.net.Proxy;
import java.net.UnknownHostException;
import java.security.KeyStore;
import java.security.cert.CertificateFactory;
import java.util.Collections;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/**
 * Executes the unchanged production NativeRoomEngine and pinned Android LiveKit SDK.
 * Only the test Room's TLS and DNS transport is redirected to an isolated local SFU.
 * A real Android microphone track publishes silence and receives a generated customer
 * tone. This proves native RTP/decoded audio, not phone hardware or Meta/FCM transport.
 */
@RunWith(AndroidJUnit4.class)
public class NativeMediaInstrumentationTest {
    private static final String HOST = "sh-r13-simulator.livekit.cloud";
    private final android.app.Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
    private final Context context = instrumentation.getTargetContext();
    private final CopyOnWriteArrayList<JSONObject> observations = new CopyOnWriteArrayList<>();
    private final CopyOnWriteArrayList<JSONObject> readiness = new CopyOnWriteArrayList<>();
    private final AtomicReference<String> failure = new AtomicReference<>("");
    private final AtomicReference<Boolean> muted = new AtomicReference<>(false);
    private OkHttpClient client;
    private NativeRoomEngine engine;

    private OkHttpClient fixtureClient() throws Exception {
        assertEquals("Explicit isolated native media fixture opt-in required", "1", InstrumentationRegistry.getArguments().getString("shNativeMediaFixture"));
        KeyStore pins = KeyStore.getInstance(KeyStore.getDefaultType()); pins.load(null);
        try (InputStream input = instrumentation.getContext().getAssets().open("native-media-ca.crt")) {
            pins.setCertificateEntry("isolated-native-simulator", CertificateFactory.getInstance("X.509").generateCertificate(input));
        }
        TrustManagerFactory factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()); factory.init(pins);
        X509TrustManager trust = (X509TrustManager)factory.getTrustManagers()[0];
        SSLContext tls = SSLContext.getInstance("TLS"); tls.init(null, new javax.net.ssl.TrustManager[]{trust}, null);
        return new OkHttpClient.Builder().sslSocketFactory(tls.getSocketFactory(), trust)
            // Only this test client avoids the emulator's closed external HTTP proxy.
            // DNS rejects every non-fixture host; hostname verification remains enabled.
            .proxy(Proxy.NO_PROXY).dns(host -> {
                if (!HOST.equals(host)) throw new UnknownHostException("The isolated test permits only its fixture hostname");
                return Collections.singletonList(InetAddress.getByAddress(new byte[]{127,0,0,1}));
            }).callTimeout(45, java.util.concurrent.TimeUnit.SECONDS).build();
    }
    private JSONObject request(String path, JSONObject body) throws Exception {
        Request.Builder request = new Request.Builder().url("https://"+HOST+path);
        if (body != null) request.post(RequestBody.create(body.toString(), MediaType.get("application/json")));
        try(Response response = client.newCall(request.build()).execute()) {
            assertTrue("Local fixture request failed: "+path+" ("+response.code()+")", response.isSuccessful());
            assertNotNull(response.body()); return new JSONObject(response.body().string());
        }
    }
    private void observe(String event, String value) {
        try { observations.add(new JSONObject().put("event",event).put("value",value).put("elapsedMs",SystemClock.elapsedRealtime())); }
        catch(Exception error) { throw new AssertionError(error); }
    }
    private void await(String label, BooleanSupplier condition) throws Exception {
        long deadline=SystemClock.elapsedRealtime()+120000;
        while(!condition.getAsBoolean() && failure.get().isEmpty() && SystemClock.elapsedRealtime()<deadline) Thread.sleep(100);
        assertEquals("Native media failure during "+label,"",failure.get());
        assertTrue(label+" did not complete within 120 seconds",condition.getAsBoolean());
    }
    private void connect(JSONObject descriptor) throws Exception {
        connect(descriptor,false);
    }
    private void connect(JSONObject descriptor,boolean initiallyMuted) throws Exception {
        readiness.clear(); failure.set(""); muted.set(false);
        assertTrue("Production server URL policy is used unchanged",NativeRoomPolicy.validRoomUrl(descriptor.getString("url")));
        AtomicReference<Room> unused = new AtomicReference<>();
        instrumentation.runOnMainSync(()->{
            try {
                engine=new NativeRoomEngine(context,new NativeRoomEngine.Listener(){
                    public void onTransport(String state){observe("transport",state);}
                    public void onEvidence(JSONObject evidence){readiness.add(evidence);observe("media-ready",evidence.optString("legId"));}
                    public void onFailure(NativeRoomAudioSetup.Stage stage,String code,String message){failure.set(stage.name()+":"+code);observe("failure",failure.get());}
                    public void onMuteChanged(boolean value){muted.set(value);observe("muted",String.valueOf(value));}
                    public void onAudioRoute(String route,boolean isSpeaker){observe("route",route);}
                    public void onRouteUnavailable(){observe("route-unavailable","");}
                });
                Field field=NativeRoomEngine.class.getDeclaredField("room");field.setAccessible(true);
                unused.set((Room)field.get(engine));
            }catch(Exception error){throw new AssertionError(error);}
        });
        // This unconnected default Room is never used. Disposal occurs off the UI thread.
        unused.get().release();
        instrumentation.runOnMainSync(()->{
            try {
                Room room=LiveKit.INSTANCE.create(context,new RoomOptions(),new LiveKitOverrides(client,null,null,null,null,null));
                Field field=NativeRoomEngine.class.getDeclaredField("room");field.setAccessible(true);field.set(engine,room);
                engine.connect(descriptor);
            }catch(Exception error){throw new AssertionError(error);}
        });
        await(initiallyMuted?"explicit muted-customer native transport":"real native bidirectional RTP and customer decoding",()->!readiness.isEmpty());
        JSONObject sample=readiness.get(readiness.size()-1);
        assertEquals("succeeded",sample.getString("iceState")); assertEquals("connected",sample.getString("dtlsState"));
        assertTrue(sample.getJSONObject("outbound").getLong("packetsDelta")>0);
        if(initiallyMuted){
            assertEquals("customer-muted-transport",sample.getString("readinessMode"));
            assertTrue(sample.getBoolean("customerMuted"));assertTrue(sample.getBoolean("customerTrackSubscribed"));
            assertTrue(sample.getJSONObject("inbound").getLong("packetsDelta")>=0);
            assertTrue(sample.getJSONObject("inbound").getLong("decodedFramesDelta")>=0);
        }else{
            assertFalse(sample.optBoolean("customerMuted"));
            assertTrue(sample.getJSONObject("inbound").getLong("packetsDelta")>0);
            assertTrue(sample.getJSONObject("inbound").getLong("decodedFramesDelta")>0);
        }
        request("/sim/evidence",new JSONObject().put("event","native-readiness").put("evidence",sample));
    }
    private JSONObject waitForCustomerReceipt() throws Exception {
        long deadline=SystemClock.elapsedRealtime()+60000; JSONObject last=new JSONObject();
        do {
            last=request("/sim/state",null);
            JSONObject snapshot=last.optJSONObject("customerSnapshot");
            JSONObject inbound=snapshot==null?null:snapshot.optJSONObject("inbound");
            if(inbound!=null&&inbound.optLong("packets")>0&&snapshot.optLong("frames")>0)return last;
            Thread.sleep(250);
        }while(SystemClock.elapsedRealtime()<deadline);
        fail("Real customer participant did not decode the native microphone RTP"); return last;
    }
    private void closeAndVerify() throws Exception {
        NativeRoomEngine closing=engine;engine=null;if(closing==null)return;
        long start=SystemClock.elapsedRealtime(); instrumentation.runOnMainSync(closing::close);
        observe("local-close-ms",String.valueOf(SystemClock.elapsedRealtime()-start));
        long deadline=SystemClock.elapsedRealtime()+60000;boolean gone=false;
        do {
            JSONObject state=request("/sim/state",null);JSONArray participants=state.getJSONArray("participants");
            gone=true;for(int i=0;i<participants.length();i++)if(state.getString("identity").equals(participants.getJSONObject(i).getString("identity")))gone=false;
            if(!gone)Thread.sleep(250);
        }while(!gone&&SystemClock.elapsedRealtime()<deadline);
        assertTrue("Closed native participant must leave the real SFU",gone);
    }
    @Test public void actualNativeEnginePublishesReceivesMutesAndRedials() throws Exception {
        assertEquals(PackageManager.PERMISSION_GRANTED,context.checkSelfPermission(Manifest.permission.RECORD_AUDIO));
        client=fixtureClient();
        try(ActivityScenario<SimulationHostActivity> foreground=ActivityScenario.launch(SimulationHostActivity.class)){
            request("/sim/reset",new JSONObject());connect(request("/sim/join",null));
            JSONObject firstCustomer=waitForCustomerReceipt();
            request("/sim/evidence",new JSONObject().put("event","customer-receives-native").put("snapshot",firstCustomer.getJSONObject("customerSnapshot")));
            instrumentation.runOnMainSync(()->engine.setMuted(true));await("actual SDK mute acknowledgement",()->muted.get());
            instrumentation.runOnMainSync(()->engine.setMuted(false));await("actual SDK unmute acknowledgement",()->!muted.get());
            int prior=readiness.size();await("fresh bidirectional evidence after unmute",()->readiness.size()>prior);
            closeAndVerify();
            request("/sim/reset",new JSONObject());connect(request("/sim/join",null));waitForCustomerReceipt();
            closeAndVerify();
            request("/sim/evidence",new JSONObject().put("event","native-engine-scenario-passed").put("observations",new JSONArray(observations)));
        }finally{
            if(engine!=null){NativeRoomEngine closing=engine;engine=null;instrumentation.runOnMainSync(closing::close);}
            if(client!=null){
                try{request("/sim/evidence",new JSONObject().put("event","native-engine-final").put("failure",failure.get()).put("observations",new JSONArray(observations)));}catch(Exception ignored){}
                client.dispatcher().executorService().shutdown();client.connectionPool().evictAll();
            }
        }
    }
    @Test public void actualInitiallyMutedCustomerUsesTransportThenProvesAudioAfterUnmute() throws Exception {
        assertEquals(PackageManager.PERMISSION_GRANTED,context.checkSelfPermission(Manifest.permission.RECORD_AUDIO));
        client=fixtureClient();
        try(ActivityScenario<SimulationHostActivity> foreground=ActivityScenario.launch(SimulationHostActivity.class)){
            request("/sim/reset",new JSONObject());request("/sim/customer",new JSONObject().put("muted",true));
            connect(request("/sim/join",null),true);waitForCustomerReceipt();
            readiness.clear();request("/sim/customer",new JSONObject().put("muted",false));
            await("real decoded customer audio after unmute",()->readiness.stream().anyMatch(value->!value.optBoolean("customerMuted")&&value.optJSONObject("inbound")!=null&&value.optJSONObject("inbound").optLong("decodedFramesDelta")>0));
            JSONObject audible=readiness.stream().filter(value->!value.optBoolean("customerMuted")&&value.optJSONObject("inbound")!=null&&value.optJSONObject("inbound").optLong("decodedFramesDelta")>0).findFirst().get();
            request("/sim/evidence",new JSONObject().put("event","native-initial-mute-then-audio-passed").put("evidence",audible));
            closeAndVerify();
        }finally{
            if(engine!=null){NativeRoomEngine closing=engine;engine=null;instrumentation.runOnMainSync(closing::close);}
            if(client!=null){
                try{request("/sim/evidence",new JSONObject().put("event","native-initial-mute-final").put("failure",failure.get()).put("observations",new JSONArray(observations)));}catch(Exception ignored){}
                client.dispatcher().executorService().shutdown();client.connectionPool().evictAll();
            }
        }
    }
}
