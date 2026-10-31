package com.smarthandicrafts.operatorhub;

import android.app.Application;
import org.junit.Test;
import org.junit.Before;
import org.junit.After;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.json.JSONObject;
import javax.net.ssl.HttpsURLConnection;
import java.net.URL;
import java.io.InputStream;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.security.cert.Certificate;
import java.lang.reflect.Field;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class) @Config(sdk=28,application=Application.class)
public class NativeApiHistoryBoundaryTest {
    private NativeApi.ConnectionFactory previous;
    private Fake connection;
    private AtomicInteger opened;
    private static final class Fake extends HttpsURLConnection {
        String marker, body="{\"ok\":true,\"calls\":[]}"; int status=200, reads; boolean closed;
        Fake(URL url) { super(url); }
        public void connect() { }
        public void disconnect() { closed=true; }
        public boolean usingProxy() { return false; }
        public String getCipherSuite() { return "TEST-NO-NETWORK"; }
        public Certificate[] getLocalCertificates() { return new Certificate[0]; }
        public Certificate[] getServerCertificates() { return new Certificate[0]; }
        public int getResponseCode() { return status; }
        public String getHeaderField(String key) { return "X-SH-Call-History".equals(key) ? marker : null; }
        public InputStream getInputStream() { reads++; return new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8)); }
        public InputStream getErrorStream() { return getInputStream(); }
    }
    private static Field factory() throws Exception { Field f=NativeApi.class.getDeclaredField("connections"); f.setAccessible(true); return f; }
    @Before public void interceptAllNetwork() throws Exception {
        previous=(NativeApi.ConnectionFactory)factory().get(null); opened=new AtomicInteger();
        connection=new Fake(new URL("https://ai-agent-debate.onrender.com/api/whatsapp-calls/logs?limit=1"));
        factory().set(null,(NativeApi.ConnectionFactory)url -> { opened.incrementAndGet(); assertEquals(connection.getURL(),url); return connection; });
    }
    @After public void restore() throws Exception { factory().set(null,previous); }
    @Test public void oldServerWithoutProjectionMarkerCannotExposeItsBody() throws Exception {
        connection.body="{\"ok\":true,\"offer_sdp\":\"never-return-this\"}";
        try { NativeApi.hubRead("/api/whatsapp-calls/logs?limit=1","test-bearer-not-real"); fail(); }
        catch(NativeApi.ApiException error) { assertEquals(503,error.status); assertEquals("Call history needs the updated backend.",error.getMessage()); }
        assertEquals(0,connection.reads); assertTrue(connection.closed);
    }
    @Test public void wrongMarkerAlsoFailsBeforeReading() throws Exception {
        connection.marker="sh-call-history-v0";
        try { NativeApi.hubRead("/api/whatsapp-calls/logs?limit=1","test-bearer-not-real"); fail(); }
        catch(NativeApi.ApiException error) { assertEquals(503,error.status); }
        assertEquals(0,connection.reads);
    }
    @Test public void authenticatedFixedOriginGetReturnsMarkedJsonWithoutRedirects() throws Exception {
        connection.marker="sh-call-history-v1";
        JSONObject result=NativeApi.hubRead("/api/whatsapp-calls/logs?limit=1","test-bearer-not-real");
        assertTrue(result.getBoolean("ok")); assertEquals("GET",connection.getRequestMethod());
        assertEquals("Bearer test-bearer-not-real",connection.getRequestProperty("Authorization"));
        assertFalse(connection.getInstanceFollowRedirects()); assertEquals(1,opened.get()); assertTrue(connection.closed);
    }
    @Test public void invalidHubMutationNeverOpensAnyConnection() throws Exception {
        try { NativeApi.hubRead("/api/whatsapp-calls/accept","test-bearer-not-real"); fail(); } catch(Exception expected) { }
        assertEquals(0,opened.get());
    }
    @Test public void oversizedProjectionIsRejectedAndConnectionClosed() throws Exception {
        connection.marker="sh-call-history-v1"; connection.body="{\"ok\":true,\"text\":\""+"x".repeat(512*1024)+"\"}";
        try { NativeApi.hubRead("/api/whatsapp-calls/logs?limit=1","test-bearer-not-real"); fail(); }
        catch(Exception error) { assertEquals("Response too large",error.getMessage()); }
        assertTrue(connection.closed);
    }
    @Test public void authErrorRemains401WithoutRequiringAHistorySuccessMarker() throws Exception {
        connection.status=401; connection.body="{\"ok\":false}";
        try { NativeApi.hubRead("/api/whatsapp-calls/logs?limit=1","test-bearer-not-real"); fail(); }
        catch(NativeApi.ApiException error) { assertEquals(401,error.status); }
    }
}
