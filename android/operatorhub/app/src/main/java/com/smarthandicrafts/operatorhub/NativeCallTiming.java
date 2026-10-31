package com.smarthandicrafts.operatorhub;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Fixed-label diagnostics only. Never includes a URL, credential, identity or raw header. */
final class NativeCallTiming {
    private static final Pattern SERVER = Pattern.compile("(?:^|,)\\s*sh-call\\s*;\\s*dur=(\\d+(?:\\.\\d+)?)\\s*(?=,|$)");
    static long serverMillis(String header) {
        if (header == null || header.length() > 1024) return -1;
        Matcher match = SERVER.matcher(header);
        if (!match.find()) return -1;
        try {
            double value = Double.parseDouble(match.group(1));
            return Double.isFinite(value) && value >= 0 && value <= 300000 ? Math.round(value) : -1;
        } catch (NumberFormatException ignored) { return -1; }
    }
    static String requestSummary(String action, long elapsedMs, int status, String serverTiming) {
        String fixed;
        switch (action == null ? "" : action) {
            case "status": case "end": case "ready": case "accept": case "cancel":
            case "transfer-invite": case "outgoing": case "call-control": fixed = action; break;
            default: fixed = "call-control";
        }
        long elapsed = Math.max(0, elapsedMs), server = serverMillis(serverTiming);
        return fixed + " elapsedMs=" + elapsed + " status=" + status +
            (server < 0 ? " serverMs=unknown" : " serverMs=" + server + " outsideServerMs=" + Math.max(0, elapsed - server));
    }
    static String incomingSummary(boolean transfer, long issuedEpochMs, long receivedEpochMs, long renderAttemptMs) {
        long age = issuedEpochMs > 0 && receivedEpochMs >= issuedEpochMs ? receivedEpochMs - issuedEpochMs : -1;
        // Reject negative/large clock differences. Small clock skew can remain;
        // this approximate age is not a handset-to-handset timing measurement.
        if (age > 120000) age = -1;
        return (transfer ? "transfer-incoming" : "incoming") + " approxDeliveryAgeMs=" + (age < 0 ? "unknown" : Long.toString(age))
            + " renderAttemptMs=" + Math.max(0, renderAttemptMs);
    }
    private NativeCallTiming() { }
}
