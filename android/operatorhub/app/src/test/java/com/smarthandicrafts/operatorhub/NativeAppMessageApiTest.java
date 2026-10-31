package com.smarthandicrafts.operatorhub;

import android.app.Application;
import org.junit.Test;
import org.junit.Before;
import org.junit.After;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.json.JSONObject;
import org.json.JSONArray;
import javax.net.ssl.HttpsURLConnection;
import java.net.URL;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.cert.Certificate;
import java.lang.reflect.Field;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class) @Config(sdk=28, application=Application.class)
public class NativeAppMessageApiTest {
    private NativeApi.ConnectionFactory previous;
    private Fake connection;
    private AtomicInteger opened;
    private static final class Fake extends HttpsURLConnection {
        String body; int status=200; boolean closed;
        final ByteArrayOutputStream posted=new ByteArrayOutputStream();
        Fake(URL url) { super(url); }
        public void connect() { }
        public void disconnect() { closed=true; }
        public boolean usingProxy() { return false; }
        public String getCipherSuite() { return "TEST-NO-NETWORK"; }
        public Certificate[] getLocalCertificates() { return new Certificate[0]; }
        public Certificate[] getServerCertificates() { return new Certificate[0]; }
        public int getResponseCode() { return status; }
        public OutputStream getOutputStream() { return posted; }
        public InputStream getInputStream() { return new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8)); }
        public InputStream getErrorStream() { return getInputStream(); }
    }
    private static Field factory() throws Exception { Field f=NativeApi.class.getDeclaredField("connections"); f.setAccessible(true); return f; }
    private static JSONObject state() throws Exception { return new JSONObject().put("channelId",73).put("stateVersion",2).put("latestMessageId",91).put("readThroughMessageId",90).put("unreadCount",1); }
    @Before public void interceptAllNetwork() throws Exception {
        previous=(NativeApi.ConnectionFactory)factory().get(null); opened=new AtomicInteger();
        factory().set(null,(NativeApi.ConnectionFactory)url -> { opened.incrementAndGet(); connection=new Fake(url);
            connection.body=new JSONObject().put("ok",true).put("channels",new JSONArray().put(state().put("privateProviderPayload","must-not-cross")))
                .put("state",state()).put("deviceToken","must-not-cross").toString(); return connection; });
    }
    @After public void restore() throws Exception { factory().set(null,previous); }
    @Test public void listUsesFixedNativePostAndProjectsOnlyUnreadFields() throws Exception {
        JSONObject result=NativeApi.appMessageState("list",new JSONObject().put("channelIds",new JSONArray().put(73)),"synthetic-bearer");
        assertEquals(HubPolicy.API_BASE+"/messages/state",connection.getURL().toString());
        assertEquals("POST",connection.getRequestMethod()); assertEquals("Bearer synthetic-bearer",connection.getRequestProperty("Authorization"));
        assertFalse(connection.getInstanceFollowRedirects()); assertTrue(connection.closed);
        assertEquals(73,new JSONObject(connection.posted.toString("UTF-8")).getJSONArray("channelIds").getInt(0));
        assertEquals(5,result.getJSONArray("channels").getJSONObject(0).length());
        assertEquals(2,result.getJSONArray("channels").getJSONObject(0).getInt("stateVersion"));
        assertFalse(result.toString().contains("must-not-cross")); assertFalse(result.toString().contains("deviceToken"));
        assertEquals(1,result.getJSONObject("state").getInt("unreadCount"));
    }
    @Test public void readAndManualUnreadHaveSeparateFixedBodies() throws Exception {
        JSONObject request=new JSONObject().put("channelId",73).put("expectedStateVersion",2).put("throughMessageId",91).put("path","/calls/private/end");
        NativeApi.appMessageState("read",request,"synthetic-bearer");
        assertEquals(HubPolicy.API_BASE+"/messages/read",connection.getURL().toString());
        JSONObject read=new JSONObject(connection.posted.toString("UTF-8"));
        assertEquals(3,read.length()); assertEquals(2,read.getInt("expectedStateVersion"));
        NativeApi.appMessageState("unread",request,"synthetic-bearer");
        assertEquals(HubPolicy.API_BASE+"/messages/unread",connection.getURL().toString());
        JSONObject posted=new JSONObject(connection.posted.toString("UTF-8")); assertEquals(2,posted.length()); assertEquals(73,posted.getInt("channelId"));
        assertEquals(2,posted.getInt("expectedStateVersion"));
    }
    @Test public void invalidCommandsAndIdsCannotOpenNetwork() throws Exception {
        for(String operation:new String[]{"/calls/a/end","state","delete",""}) {
            try { NativeApi.appMessageState(operation,new JSONObject(),"synthetic-bearer"); fail(operation); } catch(Exception expected) { }
        }
        for(Object id:new Object[]{0,-1,1.5,"73",9007199254740992L,JSONObject.NULL}) {
            try { NativeApi.appMessageState("read",new JSONObject().put("channelId",id).put("expectedStateVersion",2).put("throughMessageId",91),"synthetic-bearer"); fail(String.valueOf(id)); } catch(Exception expected) { }
        }
        JSONArray tooMany=new JSONArray(); for(int i=0;i<101;i++) tooMany.put(i+1);
        try { NativeApi.appMessageState("list",new JSONObject().put("channelIds",tooMany),"synthetic-bearer"); fail(); } catch(Exception expected) { }
        try { NativeApi.appMessageState("list",new JSONObject().put("channelIds",new JSONArray()),""); fail(); } catch(NativeApi.ApiException expected) { assertEquals(401,expected.status); }
        assertEquals(0,opened.get());
    }
    @Test public void everyMutationRequiresAnExactSafeStateVersionIncludingZero() throws Exception {
        for(String operation:new String[]{"read","unread"}) {
            JSONObject request=new JSONObject().put("channelId",73).put("throughMessageId",91);
            try { NativeApi.appMessageState(operation,request,"synthetic-bearer"); fail("Missing version must fail"); } catch(Exception expected) { }
            for(Object version:new Object[]{-1,1.5,"2",9007199254740992L,JSONObject.NULL}) {
                request.put("expectedStateVersion",version);
                try { NativeApi.appMessageState(operation,request,"synthetic-bearer"); fail(String.valueOf(version)); } catch(Exception expected) { }
            }
            request.put("expectedStateVersion",0);
            assertEquals(0,NativeApi.appMessageStateInput(operation,request).getLong("expectedStateVersion"));
        }
        assertEquals(0,opened.get());
    }
    @Test public void malformedServerStateCannotReachTheHub() throws Exception {
        factory().set(null,(NativeApi.ConnectionFactory)url -> { connection=new Fake(url);
            connection.body="{\"ok\":true,\"channels\":[{\"channelId\":73,\"stateVersion\":2,\"latestMessageId\":91,\"readThroughMessageId\":90,\"unreadCount\":-1}],\"secret\":\"must-not-cross\"}"; return connection; });
        try { NativeApi.appMessageState("list",new JSONObject().put("channelIds",new JSONArray().put(73)),"synthetic-bearer"); fail(); }
        catch(Exception expected) { assertFalse(expected.getMessage().contains("must-not-cross")); }
        assertTrue(connection.closed);
    }
    @Test public void oldStateWithoutRevisionCannotBeMistakenForCurrentUnreadState() throws Exception {
        factory().set(null,(NativeApi.ConnectionFactory)url -> { connection=new Fake(url);
            JSONObject old=state(); old.remove("stateVersion"); connection.body=new JSONObject().put("ok",true).put("channels",new JSONArray().put(old)).toString(); return connection; });
        try { NativeApi.appMessageState("list",new JSONObject().put("channelIds",new JSONArray().put(73)),"synthetic-bearer"); fail(); }
        catch(Exception expected) { assertEquals("Invalid message-state data.",expected.getMessage()); }
        assertTrue(connection.closed);
    }
}
