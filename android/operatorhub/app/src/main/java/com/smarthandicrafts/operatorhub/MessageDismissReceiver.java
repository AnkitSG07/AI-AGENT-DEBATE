package com.smarthandicrafts.operatorhub;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Cleans the exact local alert after dismissal. Does not send or mark server messages read. */
public final class MessageDismissReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        MessageAlerts.dismissed(context, intent);
    }
}
