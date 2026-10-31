package com.smarthandicrafts.operatorhub;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
public final class CallDismissReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        String id = intent.getStringExtra("call_id");
        if (HubPolicy.validCallId(id)) { new NativeStore(context).dismiss(id); CallAlerts.cancel(context, id); }
    }
}
