package com.smarthandicrafts.operatorhub;

import org.junit.Test;
import static org.junit.Assert.*;

public class NativeCallTimingTest {
    @Test public void serverDurationSeparatesMeasuredControlWorkFromOutsideTime() {
        assertEquals(8586, NativeCallTiming.serverMillis("sh-call;dur=8586.2"));
        assertEquals("accept elapsedMs=9100 status=200 serverMs=8586 outsideServerMs=514",
            NativeCallTiming.requestSummary("accept", 9100, 200, "sh-call;dur=8586.2"));
        assertEquals(12, NativeCallTiming.serverMillis("proxy;dur=50, sh-call;dur=12.4, other;dur=99"));
    }
    @Test public void unknownMalformedOrUnboundedHeadersCannotFabricateServerMeasurements() {
        for (String header : new String[]{null,"", "sh-call;dur=NaN", "sh-call;dur=Infinity", "sh-call;dur=-1", "other;dur=20", "x-sh-call;dur=20", "sh-call;dur=2000000", "sh-call;dur=20secret", "sh-call;dur=12," + "x".repeat(1024)})
            assertEquals(-1, NativeCallTiming.serverMillis(header));
        assertEquals("ready elapsedMs=30 status=503 serverMs=unknown", NativeCallTiming.requestSummary("ready",30,503,null));
    }
    @Test public void rawHeadersPathsAndIdentifiersNeverAppearInDiagnosticText() {
        String raw="secret-room-token, sh-call;dur=200.1";
        String line=NativeCallTiming.requestSummary("/calls/private-customer/end",199,200,raw);
        assertEquals("call-control elapsedMs=199 status=200 serverMs=200 outsideServerMs=0", line);
        assertFalse(line.contains("secret")); assertFalse(line.contains("private-customer"));
    }
}
