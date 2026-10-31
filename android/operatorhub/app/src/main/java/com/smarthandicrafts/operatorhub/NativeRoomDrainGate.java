package com.smarthandicrafts.operatorhub;

/** Serializes cleanup drains without losing work enqueued while a request is in flight. */
final class NativeRoomDrainGate {
    private long requested, observed;
    private boolean running;
    synchronized boolean request() {
        requested++;
        if (running) return false;
        running = true; observed = requested; return true;
    }
    /** Atomically either takes another pass or relinquishes the runner to a later request. */
    synchronized boolean repeatOrRelease() {
        if (requested != observed) { observed = requested; return true; }
        running = false; return false;
    }
}
