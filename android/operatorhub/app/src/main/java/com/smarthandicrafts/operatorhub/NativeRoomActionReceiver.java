package com.smarthandicrafts.operatorhub;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;

/** No microphone acquisition from a background receiver. Accept always opens an Activity. */
public final class NativeRoomActionReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        String callId = intent.getStringExtra("call_id"), transferId = intent.getStringExtra("transfer_id");
        String action = intent.getStringExtra("room_action");
        if (transferId == null) transferId = "";
        if (!HubPolicy.validCallId(callId) || (!transferId.isEmpty() && !NativeRoomPolicy.validTransferId(transferId))) return;
        if (!NativeRoomNotifications.currentEnrollment(context, intent)) return;
        if ("end".equals(action)) {
            String attempt = intent.getStringExtra("client_attempt_id"), leg = intent.getStringExtra("owner_leg_id");
            PendingResult pending = goAsync();
            if (!NativeRoomCallService.endFromNotification(callId, attempt == null ? "" : attempt, leg == null ? "" : leg)) {
                NativeStore store = new NativeStore(context); DeviceLeasePolicy.Credential credential = store.credential();
                String outgoing = intent.getStringExtra("outgoing_request_id");
                if (outgoing != null && !outgoing.isEmpty()) NativeRoomCleanup.enqueueOutgoingCancellation(context, credential, outgoing);
                else NativeRoomCleanup.enqueue(context, credential, callId, transferId, leg);
            }
            // Allows WorkManager's durable enqueue to finish even when this was the last UI action.
            new Handler(Looper.getMainLooper()).postDelayed(pending::finish, 8000);
            return;
        }
        if (!"decline".equals(action) && !"silence".equals(action)) return;
        NativeStore store = new NativeStore(context);
        if (!store.roomAlertActive(callId, transferId)) { NativeRoomNotifications.cancel(context, callId, transferId); return; }
        store.closeRoomAlert(callId, transferId);
        if ("decline".equals(action)) NativeRoomNotifications.cancelTerminal(context, callId, transferId);
        else NativeRoomNotifications.cancel(context, callId, transferId);
        if ("silence".equals(action)) return;
        DeviceLeasePolicy.Credential credential = store.credential();
        if (!DeviceLeasePolicy.valid(credential, System.currentTimeMillis())) return;
        PendingResult pending = goAsync();
        // Persist before releasing the broadcast; retries survive process loss and never reject a call answered elsewhere.
        NativeRoomCleanup.enqueueDecline(context, credential, callId, transferId);
        // Keep the process available for the immediate attempt without exceeding Android's broadcast budget.
        new Handler(Looper.getMainLooper()).postDelayed(pending::finish, 8000);
    }
}
