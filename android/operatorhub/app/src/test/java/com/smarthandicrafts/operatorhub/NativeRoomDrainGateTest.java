package com.smarthandicrafts.operatorhub;

import org.junit.Test;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.Assert.*;

public class NativeRoomDrainGateTest {
    @Test public void enqueueWhileEarlierHttpIsBlockedCannotBeStranded() throws Exception {
        NativeRoomDrainGate gate = new NativeRoomDrainGate(); AtomicInteger queue = new AtomicInteger(1), processed = new AtomicInteger();
        CountDownLatch snapshot = new CountDownLatch(1), release = new CountDownLatch(1);
        assertTrue(gate.request());
        Thread runner = new Thread(() -> {
            do {
                int selected = queue.getAndSet(0); snapshot.countDown();
                try { assertTrue(release.await(2, TimeUnit.SECONDS)); } catch (InterruptedException e) { throw new AssertionError(e); }
                processed.addAndGet(selected);
            } while (gate.repeatOrRelease());
        });
        runner.start(); assertTrue(snapshot.await(2, TimeUnit.SECONDS));
        queue.incrementAndGet(); assertFalse(gate.request()); release.countDown(); runner.join(2000);
        assertFalse(runner.isAlive()); assertEquals(2, processed.get()); assertEquals(0, queue.get());
    }
    @Test public void enqueueAfterRunnerReleaseStartsANewRunner() {
        NativeRoomDrainGate gate = new NativeRoomDrainGate(); assertTrue(gate.request()); assertFalse(gate.repeatOrRelease());
        assertTrue(gate.request()); assertFalse(gate.repeatOrRelease());
    }
    @Test public void multipleRequestsCoalesceWithoutCreatingConcurrentRunners() {
        NativeRoomDrainGate gate = new NativeRoomDrainGate(); assertTrue(gate.request());
        for (int i = 0; i < 100; i++) assertFalse(gate.request());
        assertTrue(gate.repeatOrRelease()); assertFalse(gate.repeatOrRelease());
    }
}
