package com.smarthandicrafts.operatorhub;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;
import android.content.Context;

public final class HubMessagingService extends FirebaseMessagingService {
    @Override public void onNewToken(String token) { ((HubApplication)getApplication()).updateToken(token); }
    @Override public void onMessageReceived(RemoteMessage message) {
        dispatchData(this, message.getData());
    }
    // Shared receive boundary: instrumentation can inject an already-delivered
    // synthetic FCM data envelope without adding an exported debug receiver.
    static void dispatchData(Context context, Map<String, String> d) {
        if ("sh_operator_transfer".equals(d.get("type")) || ("sh_operator_call".equals(d.get("type")) && "livekit".equals(d.get("engine")))) {
            String id = d.get("call_id");
            String transfer = "sh_operator_transfer".equals(d.get("type")) ? d.get("transfer_id") : "";
            if (!HubPolicy.validCallHubUrl(d.get("hub_url"), id) || transfer == null || (!transfer.isEmpty() && !NativeRoomPolicy.validTransferId(transfer))) return;
            NativeStore store = new NativeStore(context);
            if ("ended".equals(d.get("event"))) {
                // End push is an alert tombstone only. Authoritative status owns an established media leg.
                store.closeRoomAlert(id, transfer); NativeRoomNotifications.cancelTerminal(context, id, transfer); return;
            }
            if (!"incoming".equals(d.get("event"))) return;
            try {
                long issued = Long.parseLong(d.get("issued_at_ms")), expiry = Long.parseLong(d.get("expires_at_ms"));
                if (store.roomIncoming(id, transfer, issued, expiry)) NativeRoomNotifications.show(context, id, transfer, expiry);
            } catch (Exception ignored) { }
            return;
        }
        if ("sh_operator_message".equals(d.get("type"))) {
            try {
                long channel = Long.parseLong(d.get("channel_id")), id = Long.parseLong(d.get("message_id"));
                long issued = Long.parseLong(d.get("issued_at_ms")), expiry = Long.parseLong(d.get("expires_at_ms"));
                String expected = HubPolicy.HUB_URL + "?channel_id=" + channel + "&channel=" + channel;
                if (channel <= Integer.MAX_VALUE && expected.equals(d.get("hub_url")) && new NativeStore(context).receiveMessage(channel, id, issued, expiry)) MessageAlerts.show(context, (int)channel, false);
            } catch (Exception ignored) { }
            return;
        }
        if ("sh_operator_test".equals(d.get("type"))) {
            try {
                long issued = Long.parseLong(d.get("issued_at_ms")), expiry = Long.parseLong(d.get("expires_at_ms")), now = System.currentTimeMillis();
                NativeStore store = new NativeStore(context);
                String testId = d.get("test_id");
                if (store.enrolled() && testId != null && testId.matches("[A-Za-z0-9-]{16,80}") && issued > 0 && issued <= now + 30000 && expiry > now && expiry - issued <= 300000) { store.testReceived(testId); MessageAlerts.show(context, 0, true); }
            } catch (Exception ignored) { }
            return;
        }
        if (!"sh_operator_call".equals(d.get("type"))) return;
        String id = d.get("call_id");
        if (!HubPolicy.validCallHubUrl(d.get("hub_url"), id)) return;
        NativeStore store = new NativeStore(context);
        if ("ended".equals(d.get("event"))) {
            // An end push also means answered elsewhere. It only stops this incoming alert.
            // It must never terminate an established local WebRTC call.
            store.terminate(id); CallAlerts.cancel(context, id); return;
        }
        if (!"incoming".equals(d.get("event"))) return;
        try {
            long issued = Long.parseLong(d.get("issued_at_ms")), expiry = Long.parseLong(d.get("expires_at_ms"));
            if (store.incoming(id, issued, expiry)) CallAlerts.show(context, id, expiry);
        } catch (Exception ignored) { }
    }
}
