package com.smarthandicrafts.operatorhub;

import java.net.URI;

/** Pure call identity and readiness policy. No signaling response is media readiness. */
public final class NativeRoomPolicy {
    public static final String PROTOCOL = "sh-room-audio-v1";
    public static boolean validTransferId(String value) {
        return value != null && value.matches("[A-Za-z0-9_-]{1,160}");
    }
    public static boolean validPhone(String value) {
        return value != null && value.matches("[1-9][0-9]{6,14}");
    }
    public static boolean validRoomUrl(String value) {
        try {
            URI uri = new URI(value);
            return "wss".equals(uri.getScheme()) && uri.getHost() != null && uri.getHost().endsWith(".livekit.cloud")
                && uri.getHost().length() > ".livekit.cloud".length() && uri.getRawUserInfo() == null
                && (uri.getPort() == -1 || uri.getPort() == 443) && uri.getRawQuery() == null && uri.getRawFragment() == null
                && (uri.getPath().isEmpty() || "/".equals(uri.getPath()));
        } catch (Exception ignored) { return false; }
    }
    public static boolean mediaReady(long durationMs, long ageMs, long outgoingPackets, long outgoingBytes,
                                     long incomingPackets, long incomingBytes, long decodedFrames,
                                     boolean iceSucceeded, boolean dtlsConnected) {
        return durationMs >= 500 && durationMs <= 5000 && ageMs >= 0 && ageMs <= 2000
            && outgoingPackets > 0 && outgoingBytes > 0 && incomingPackets > 0 && incomingBytes > 0 && decodedFrames > 0
            && iceSucceeded && dtlsConnected;
    }
    /** An explicitly muted customer has no incoming PCM to prove. This establishes
     * transport only; the server must independently corroborate the same muted track. */
    public static boolean customerMutedTransportReady(long durationMs, long ageMs,
            long outgoingPackets, long outgoingBytes, long incomingPackets,
            long incomingBytes, long decodedFrames, boolean iceSucceeded,
            boolean dtlsConnected, boolean exactCustomerMuted, boolean exactCustomerSubscribed) {
        return durationMs >= 500 && durationMs <= 5000 && ageMs >= 0 && ageMs <= 2000
            && outgoingPackets > 0 && outgoingBytes > 0
            && incomingPackets >= 0 && incomingBytes >= 0 && decodedFrames >= 0
            && iceSucceeded && dtlsConnected && exactCustomerMuted && exactCustomerSubscribed;
    }
    public enum Cleanup { NONE, END, REJECT, DECLINE_TRANSFER }
    public static Cleanup cleanupAction(String actor, String owner, String phase, String requestedTransfer,
                                        String actualTransfer, String transferStatus, String target) {
        if (actor == null || actor.isEmpty() || HubPolicy.terminal(phase) || "ending".equals(phase)) return Cleanup.NONE;
        if (actor.equals(owner)) return Cleanup.END;
        if (requestedTransfer != null && !requestedTransfer.isEmpty() && requestedTransfer.equals(actualTransfer)
            && actor.equals(target) && ("invited".equals(transferStatus) || "connecting".equals(transferStatus))) return Cleanup.DECLINE_TRANSFER;
        return Cleanup.NONE;
    }
    public static Cleanup declineAction(String actor, String owner, String phase, String requestedTransfer,
                                        String actualTransfer, String transferStatus, String target) {
        if (actor == null || actor.isEmpty() || HubPolicy.terminal(phase) || "ending".equals(phase)) return Cleanup.NONE;
        if (requestedTransfer == null || requestedTransfer.isEmpty())
            return (owner == null || owner.isEmpty()) && "ringing".equals(phase) ? Cleanup.REJECT : Cleanup.NONE;
        if (!actor.equals(owner) && requestedTransfer.equals(actualTransfer) && actor.equals(target)
            && ("invited".equals(transferStatus) || "connecting".equals(transferStatus))) return Cleanup.DECLINE_TRANSFER;
        return Cleanup.NONE;
    }
    /** Late network/SDK callbacks may never recreate an ended or replaced local session. */
    public static final class Epoch {
        private long generation;
        private boolean closed = true;
        private long version = -1;
        public synchronized long begin() { closed = false; version = -1; return ++generation; }
        public synchronized boolean current(long captured) { return !closed && generation == captured; }
        public synchronized void close() { closed = true; ++generation; }
        public synchronized boolean acceptVersion(long captured, long incomingVersion) {
            if (!current(captured) || incomingVersion < 0 || incomingVersion < version) return false;
            version = incomingVersion; return true;
        }
        public synchronized long version() { return version; }
    }
    private NativeRoomPolicy() { }
}
