package com.smarthandicrafts.operatorhub;

/** Call deadlines and media liveness are independent of HTTP polling and speech/silence. */
final class NativeRoomCallHealth {
    static final long JOIN_TIMEOUT_MS = 90000, RECONNECT_TIMEOUT_MS = 30000;
    private long startedAt, connectedAt, reconnectAt;
    private boolean fresh, focusPaused;
    void start(long now) { startedAt = now; connectedAt = 0; reconnectAt = 0; fresh = false; focusPaused = false; }
    void evidence() { fresh = true; reconnectAt = 0; }
    void mediaLost(long now) { fresh = false; if (connectedAt > 0 && reconnectAt == 0) reconnectAt = now; }
    void focus(boolean available, long now) {
        focusPaused = !available;
        if (!available) { fresh = false; reconnectAt = 0; }
        else mediaLost(now);
    }
    boolean connected(boolean serverReady, long now) {
        if (!serverReady || !fresh || focusPaused) return false;
        if (connectedAt == 0) connectedAt = now;
        return true;
    }
    String timeout(boolean serverReady, long now) {
        if (!serverReady && now - startedAt >= JOIN_TIMEOUT_MS) return "Call audio did not become ready.";
        if (!focusPaused && reconnectAt > 0 && now - reconnectAt >= RECONNECT_TIMEOUT_MS) return "Audio connection was lost.";
        return "";
    }
    boolean fresh() { return fresh && !focusPaused; }
    boolean focusPaused() { return focusPaused; }
    long connectedAt() { return connectedAt; }
}
