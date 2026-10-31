package com.smarthandicrafts.operatorhub;

import org.junit.Test;
import static org.junit.Assert.*;

public class NativeHubReadPolicyTest {
    @Test public void acceptsOnlyBoundedCallHistoryShapes() {
        assertTrue(NativeHubReadPolicy.allowedPath("/api/whatsapp-calls/config"));
        assertTrue(NativeHubReadPolicy.allowedPath("/api/whatsapp-calls/logs?limit=200&phone=%2B918000000001"));
        assertTrue(NativeHubReadPolicy.allowedPath("/api/whatsapp-calls/incoming?operator_device_id=browser_1%3A%3Asession_2"));
        assertTrue(NativeHubReadPolicy.allowedPath("/api/whatsapp-calls/recent?live=1&since_ms=1793000000000"));
        assertTrue(NativeHubReadPolicy.allowedPath("/api/whatsapp-calls/wacid%3Aa%2Fb%2Bc%3D"));
    }
    @Test public void rejectsMutationsSecretsAndOtherRoutes() {
        for (String path : new String[]{"accept", "reject", "terminate", "outgoing", "events", "diagnostics", "test", "note", "cancel-pending-outgoing"})
            assertFalse(path, NativeHubReadPolicy.allowedPath("/api/whatsapp-calls/" + path));
        assertFalse(NativeHubReadPolicy.allowedPath("/api/operator-android/devices"));
        assertFalse(NativeHubReadPolicy.allowedPath("/api/whatsapp-calls/logs?token=private"));
        assertFalse(NativeHubReadPolicy.allowedPath("/api/whatsapp-calls/config?limit=1"));
    }
    @Test public void rejectsUrlTraversalAmbiguityAndUnboundedReads() {
        for (String value : new String[]{"https://other.invalid/api/whatsapp-calls/logs", "//other.invalid/api/whatsapp-calls/logs",
            "/api/whatsapp-calls/%2e%2e", "/api/whatsapp-calls/%252e%252e", "/api/whatsapp-calls/logs#secret",
            "/api/whatsapp-calls/logs?limit=201", "/api/whatsapp-calls/logs?limit=0", "/api/whatsapp-calls/logs?limit=1&limit=2",
            "/api/whatsapp-calls/logs?phone=%0a1234567", "/api/whatsapp-calls/incoming?operator_device_id=x%26y",
            "/api/whatsapp-calls/recent?since_ms=9007199254740992", "/api/whatsapp-calls/a/status"})
            assertFalse(value, NativeHubReadPolicy.allowedPath(value));
    }
    @Test public void requestIdentifiersCannotBecomeJavascript() {
        assertTrue(NativeHubReadPolicy.validRequestId("12345678-1234-4234-8234-123456789abc"));
        assertFalse(NativeHubReadPolicy.validRequestId("\"});window.alert(1);//"));
        assertFalse(NativeHubReadPolicy.validRequestId(""));
        assertFalse(NativeHubReadPolicy.validRequestId(null));
    }
}
