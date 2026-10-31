package com.smarthandicrafts.operatorhub;

import org.junit.Test;
import java.util.List;
import static org.junit.Assert.*;

public class NativeCallCloseQueueTest {
    @Test public void twoCallsEndingWhileLoginLoadsBothReachTheHub() {
        NativeCallCloseQueue queue = new NativeCallCloseQueue();
        queue.offer("native-a", "wa:a"); queue.offer("native-b", "wa:b");
        List<NativeCallCloseQueue.Closed> events = queue.drain();
        assertEquals(2, events.size()); assertEquals("native-a", events.get(0).callId); assertEquals("wa:b", events.get(1).providerCallId);
        assertTrue(queue.drain().isEmpty());
    }
    @Test public void repeatedBroadcastAndActivityIntentDoNotDuplicateTheSameClose() {
        NativeCallCloseQueue queue = new NativeCallCloseQueue();
        queue.offer("native-a", "wa:a"); queue.offer("native-a", "wa:a");
        assertEquals(1, queue.drain().size());
    }
    @Test public void invalidAndMissingIdsCannotCloseAnArbitraryCall() {
        NativeCallCloseQueue queue = new NativeCallCloseQueue();
        queue.offer(null, ""); queue.offer("bad id", "bad\nprovider"); queue.offer("", "wa:valid");
        List<NativeCallCloseQueue.Closed> events = queue.drain();
        assertEquals(1, events.size()); assertEquals("", events.get(0).callId); assertEquals("wa:valid", events.get(0).providerCallId);
    }
    @Test public void boundedQueueKeepsTheMostRecentCallsInOrder() {
        NativeCallCloseQueue queue = new NativeCallCloseQueue();
        for (int i = 0; i < 40; i++) queue.offer("native-" + i, "wa:" + i);
        List<NativeCallCloseQueue.Closed> events = queue.drain();
        assertEquals(32, events.size()); assertEquals("native-8", events.get(0).callId); assertEquals("native-39", events.get(31).callId);
    }
    @Test public void returnTransferRetainsDifferentAttemptsForTheSameCall() {
        NativeCallCloseQueue queue = new NativeCallCloseQueue();
        String first="00000000-0000-4000-8000-000000000001",second="00000000-0000-4000-8000-000000000002";
        queue.offer("native-a","wa:a",first,"leg-1"); queue.offer("native-a","wa:a",second,"leg-3");
        List<NativeCallCloseQueue.Closed> events=queue.drain();
        assertEquals(2,events.size()); assertEquals(first,events.get(0).clientAttemptId); assertEquals("leg-3",events.get(1).ownerLegId);
    }
}
