package com.smarthandicrafts.operatorhub;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;

/** Exact local-release events waiting for the signed-in Hub to become ready. */
public final class NativeCallCloseQueue {
    private static final int LIMIT = 32;
    private final LinkedHashMap<String, Closed> pending = new LinkedHashMap<>();

    public static final class Closed {
        public final String callId, providerCallId, clientAttemptId, ownerLegId;
        private Closed(String callId, String providerCallId, String clientAttemptId, String ownerLegId) {
            this.callId = callId; this.providerCallId = providerCallId; this.clientAttemptId = clientAttemptId; this.ownerLegId = ownerLegId;
        }
    }

    public void offer(String callId, String providerCallId) {
        offer(callId, providerCallId, "", "");
    }
    public void offer(String callId, String providerCallId, String clientAttemptId, String ownerLegId) {
        String call = HubPolicy.validCallId(callId) ? callId : "";
        String provider = HubPolicy.validCallId(providerCallId) ? providerCallId : "";
        String attempt = NativeRoomUiBinding.validAttemptId(clientAttemptId) ? clientAttemptId : "";
        String leg = HubPolicy.validCallId(ownerLegId) ? ownerLegId : "";
        if (call.isEmpty() && provider.isEmpty()) return;
        // A transfer back to this phone keeps the call ID but has a new attempt/leg.
        // NUL cannot occur in these validated identities, so the keys cannot collide.
        pending.put(call + "\u0000" + provider + "\u0000" + attempt + "\u0000" + leg, new Closed(call, provider, attempt, leg));
        while (pending.size() > LIMIT) pending.remove(pending.keySet().iterator().next());
    }

    public List<Closed> drain() {
        ArrayList<Closed> result = new ArrayList<>(pending.values());
        pending.clear();
        return result;
    }
}
