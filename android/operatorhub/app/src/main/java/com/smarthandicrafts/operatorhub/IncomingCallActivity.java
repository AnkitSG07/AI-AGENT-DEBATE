package com.smarthandicrafts.operatorhub;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Button;
import android.widget.ImageView;
import android.graphics.drawable.GradientDrawable;
import androidx.core.content.ContextCompat;
import org.json.JSONObject;

/** Native alert only: media starts in the authenticated Hub after the operator chooses Accept. */
public final class IncomingCallActivity extends Activity {
    private String callId; private TextView status; private final Handler handler = new Handler(Looper.getMainLooper());
    private final BroadcastReceiver receiver = new BroadcastReceiver() { @Override public void onReceive(Context c, Intent i) { if (callId != null && callId.equals(i.getStringExtra("call_id")) && !new NativeStore(c).alertActive(callId)) finish(); } };
    private final Runnable expiryCheck = new Runnable() { public void run() { if (!new NativeStore(IncomingCallActivity.this).alertActive(callId)) finish(); else handler.postDelayed(this, 1000); } };
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        if (Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true); }
        else getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | android.view.WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        callId = getIntent().getStringExtra("call_id");
        if (!HubPolicy.validCallId(callId) || !new NativeStore(this).alertActive(callId)) { finish(); return; }
        LinearLayout layout = new LinearLayout(this); layout.setOrientation(LinearLayout.VERTICAL); layout.setGravity(Gravity.CENTER);
        layout.setBackgroundColor(NativeUi.background(this)); int padding = NativeUi.dp(this, 28); layout.setPadding(padding, padding, padding, padding);
        TextView brand = NativeUi.text(this, "SH Chat", 15, true); brand.setGravity(Gravity.CENTER); layout.addView(brand);
        ImageView logo = new ImageView(this); logo.setImageBitmap(NativeBrand.logo(this)); logo.setContentDescription("Smart Handicrafts logo");
        logo.setScaleType(ImageView.ScaleType.FIT_CENTER);
        GradientDrawable logoFrame = new GradientDrawable(); logoFrame.setShape(GradientDrawable.OVAL); logoFrame.setColor(android.graphics.Color.WHITE);
        logo.setBackground(logoFrame); logo.setClipToOutline(true);
        LinearLayout.LayoutParams logoSize = new LinearLayout.LayoutParams(NativeUi.dp(this, 120), NativeUi.dp(this, 120)); logoSize.setMargins(0, NativeUi.dp(this, 20), 0, NativeUi.dp(this, 20)); layout.addView(logo, logoSize);
        TextView title = NativeUi.text(this, "Incoming WhatsApp call", 30, true); title.setGravity(Gravity.CENTER); layout.addView(title);
        status = NativeUi.text(this, "Smart Handicrafts · Audio call", 17, false); status.setGravity(Gravity.CENTER); layout.addView(status);
        LinearLayout actions = new LinearLayout(this); actions.setOrientation(LinearLayout.HORIZONTAL);
        Button open = NativeUi.button(this, "Open call", v -> {
            CallAlerts.cancel(this, callId);
            startActivity(new Intent(this, MainActivity.class).putExtra("call_id", callId).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)); finish();
        });
        Button dismiss = NativeUi.button(this, "Dismiss", v -> { new NativeStore(this).dismiss(callId); CallAlerts.cancel(this, callId); finish(); });
        GradientDrawable dismissShape = new GradientDrawable(); dismissShape.setColor(NativeBrand.RED); dismissShape.setCornerRadius(NativeUi.dp(this, 24)); dismiss.setBackground(dismissShape);
        LinearLayout.LayoutParams buttonSize = new LinearLayout.LayoutParams(0, NativeUi.dp(this, 56), 1); buttonSize.setMargins(0, NativeUi.dp(this, 20), NativeUi.dp(this, 6), NativeUi.dp(this, 12));
        LinearLayout.LayoutParams dismissSize = new LinearLayout.LayoutParams(0, NativeUi.dp(this, 56), 1); dismissSize.setMargins(NativeUi.dp(this, 6), NativeUi.dp(this, 20), 0, NativeUi.dp(this, 12));
        actions.addView(open, buttonSize); actions.addView(dismiss, dismissSize); layout.addView(actions, new LinearLayout.LayoutParams(-1, -2));
        TextView hint = NativeUi.text(this, "Dismiss silences this alert. It does not reject the customer's call.", 13, false); hint.setTextColor(NativeUi.muted(this)); hint.setGravity(Gravity.CENTER); layout.addView(hint);
        setContentView(layout);
        IntentFilter filter = new IntentFilter("com.smarthandicrafts.operatorhub.CALL_ALERT_CHANGED");
        ContextCompat.registerReceiver(this, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED);
        handler.post(expiryCheck);
        NativeStore store = new NativeStore(this);
        HubApplication.IO.execute(() -> {
            try {
                JSONObject call = NativeApi.request("/calls/" + android.net.Uri.encode(callId), "GET", null, store.token()).getJSONObject("call");
                runOnUiThread(() -> { if (isFinishing()) return; if (!call.optBoolean("answerable")) { store.terminate(callId); CallAlerts.cancel(this, callId); finish(); } else status.setText(call.optString("callerName", "Customer") + "\nWhatsApp audio call"); });
            } catch (Exception e) { runOnUiThread(() -> { if (!isFinishing()) status.setText("Open SH Chat to check this call."); }); }
        });
    }
    @Override protected void onDestroy() { handler.removeCallbacks(expiryCheck); try { unregisterReceiver(receiver); } catch (Exception ignored) { } super.onDestroy(); }
}
