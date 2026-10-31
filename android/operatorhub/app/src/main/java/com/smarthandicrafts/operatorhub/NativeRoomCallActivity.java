package com.smarthandicrafts.operatorhub;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.Gravity;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.View;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.EditText;
import android.widget.Toast;
import android.widget.ScrollView;
import androidx.core.content.ContextCompat;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.UUID;

/** A genuine native call screen; the Odoo WebView can sleep without owning the audio. */
public final class NativeRoomCallActivity extends Activity {
    private String callId = "", transferId = "", action = "show", phone = "", displayName = "Customer";
    private int channelId;
    private String expectedAttemptId = "";
    private boolean starting, registered, resumed, returnOnResume, busyWaiting;
    private String busyAttemptId = "", busyOwnerLegId = "";
    private boolean waitingCleanupRequired;
    private WaitingAnswer waitingAnswer;
    private static final class WaitingAnswer {
        final long generation, deadline;
        final String callId, transferId, sourceAttemptId, sourceOwnerLegId;
        final DeviceLeasePolicy.Credential credential;
        boolean checking, sourceEnded;
        WaitingAnswer(long generation, String callId, String transferId, DeviceLeasePolicy.Credential credential,
            String sourceAttemptId, String sourceOwnerLegId, boolean sourceEnded) {
            this.generation = generation; this.callId = callId; this.transferId = transferId; this.credential = credential;
            this.sourceAttemptId = sourceAttemptId; this.sourceOwnerLegId = sourceOwnerLegId; this.sourceEnded = sourceEnded;
            deadline = SystemClock.elapsedRealtime() + 30000;
        }
    }
    private NativeRoomCleanupProcessor.Requester callApi = NativeApi::request;
    private long uiGeneration;
    private final NativeRoomStartGate startGate = new NativeRoomStartGate();
    private DeviceLeasePolicy.Credential pendingStartCredential;
    private DeviceLeasePolicy.Credential screenCredential;
    private TextView title, status, timer, hint;
    private EditText dialInput;
    private ImageView avatar;
    private Button accept, decline, mute, speaker, transfer, end, cancelTransfer;
    private LinearLayout incomingActions, activeActions, callPermissionActions;
    private TextView callPermissionStatus;
    private Button requestCallPermission, checkCallPermission;
    private long permissionGeneration;
    private boolean permissionBusy, permissionOutcomeUncertain;
    private String permissionDestination="";
    private NativeCallPermissionState permissionState;
    private AlertDialog transferDialog;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private JSONObject latest;
    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            String snapshot = intent.getStringExtra("snapshot");
            if (snapshot != null) {
                try { JSONObject value = new JSONObject(snapshot); if (sameCall(value)) render(value); else if (value.optBoolean("closed")) releaseBusyIfPossible(); } catch (Exception ignored) { }
            } else {
                JSONObject running = NativeRoomCallService.snapshot();
                boolean matchingService = running != null && !running.optBoolean("closed") && sameCall(running);
                boolean exactAlert = intent.getBooleanExtra("alert_terminal",false) && callId.equals(intent.getStringExtra("call_id")) && transferId.equals(intent.getStringExtra("transfer_id"));
                if (NativeRoomControl.mayDismissPendingAnswer(exactAlert, new NativeStore(context).roomAlertClosed(callId, transferId), matchingService)) {
                    uiGeneration++; startGate.invalidate(); starting = false; finish();
                }
            }
        }
    };
    private final Runnable tick = new Runnable() {
        @Override public void run() {
            releaseBusyIfPossible();
            if (latest != null && !latest.optBoolean("closed")) {
                long started = latest.optLong("connectedAtElapsed");
                if (started > 0) { long seconds = Math.max(0, (SystemClock.elapsedRealtime() - started) / 1000); timer.setText(String.format(java.util.Locale.ROOT, "%02d:%02d", seconds / 60, seconds % 60)); }
            }
            if (latest == null && !starting && HubPolicy.validCallId(callId)) {
                long expiry = new NativeStore(NativeRoomCallActivity.this).roomAlertExpiry(callId,transferId);
                if (expiry > 0 && expiry <= System.currentTimeMillis()) { finish(); return; }
            }
            handler.postDelayed(this, 1000);
        }
    };

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        if (!NativeRoomNotifications.currentEnrollment(this, getIntent())) { finish(); return; }
        if (Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true); }
        else getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | android.view.WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        readIntent(getIntent()); buildUi();
        ContextCompat.registerReceiver(this, receiver, new IntentFilter(NativeRoomNotifications.CHANGED), ContextCompat.RECEIVER_NOT_EXPORTED); registered = true;
        JSONObject snapshot = NativeRoomCallService.snapshot();
        if (snapshot != null && !snapshot.optBoolean("closed")) {
            if (action.equals("outgoing") || callId.isEmpty() || sameCall(snapshot)) { render(snapshot); if (action.equals("transfer")) chooseTransfer(); }
            else showBusyIncoming();
        } else if (action.equals("dial")) showDialer("Enter the customer's country code and phone number.");
        else if (action.equals("callback")) resolveCallback();
        // Begin now against this intent; service start itself waits for the resumed activity.
        else if (action.equals("accept") || action.equals("outgoing")) beginAccept();
        else verifyWaitingCall();
        handler.post(tick);
    }
    private void readIntent(Intent intent) {
        resetCallPermission();
        uiGeneration++; startGate.invalidate(); pendingStartCredential = null; starting = false; returnOnResume = false; busyWaiting = false; latest = null;
        waitingAnswer = null; waitingCleanupRequired = false; busyAttemptId = ""; busyOwnerLegId = "";
        screenCredential = new NativeStore(this).credential();
        if (transferDialog != null) { transferDialog.dismiss(); transferDialog = null; }
        expectedAttemptId = string(intent, "client_attempt_id");
        if (!NativeRoomUiBinding.validAttemptId(expectedAttemptId)) expectedAttemptId = "";
        callId = string(intent, "call_id"); transferId = string(intent, "transfer_id");
        action = string(intent, "room_action"); phone = string(intent, "phone");
        displayName = string(intent, "display_name"); if (displayName.isEmpty()) displayName = phone.isEmpty() ? "Customer" : "+" + phone;
        displayName = displayName.substring(0, Math.min(160, displayName.length()));
        channelId = intent.getIntExtra("channel_id", 0);
    }
    private static String string(Intent intent, String key) { String value = intent.getStringExtra(key); return value == null ? "" : value; }
    private boolean sameCall(JSONObject value) {
        return NativeRoomUiBinding.matches(expectedAttemptId, callId, transferId,
            value.optString("clientAttemptId", value.optString("outgoingRequestId")),
            value.optString("callId"), value.optString("providerCallId"), value.optString("transferId"));
    }

    private void buildUi() {
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(NativeUi.background(this)); int pad = NativeUi.dp(this, 18);
        root.setPadding(pad, pad, pad, pad);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(android.view.WindowInsets.Type.systemBars() | android.view.WindowInsets.Type.displayCutout());
                int bottom = Math.max(bars.bottom, insets.getInsets(android.view.WindowInsets.Type.ime()).bottom);
                view.setPadding(pad + bars.left, NativeUi.dp(this, 8) + bars.top, pad + bars.right, NativeUi.dp(this, 8) + bottom);
            } else view.setPadding(pad, NativeUi.dp(this, 8) + insets.getSystemWindowInsetTop(), pad, NativeUi.dp(this, 8) + insets.getSystemWindowInsetBottom());
            return insets;
        });
        LinearLayout heading = new LinearLayout(this); heading.setGravity(Gravity.CENTER_VERTICAL);
        android.widget.ImageButton back = new android.widget.ImageButton(this); back.setImageResource(R.drawable.ic_call_back); back.setColorFilter(NativeUi.foreground(this));
        back.setContentDescription("Return to chat; keep the active call connected"); back.setOnClickListener(view -> returnToChat());
        GradientDrawable backCircle = new GradientDrawable(); backCircle.setShape(GradientDrawable.OVAL); backCircle.setColor(NativeUi.dark(this) ? Color.rgb(39,51,59) : Color.rgb(241,243,242));
        back.setBackground(new android.graphics.drawable.RippleDrawable(android.content.res.ColorStateList.valueOf(Color.argb(45,0,135,107)),backCircle,null));
        back.setPadding(NativeUi.dp(this,12),NativeUi.dp(this,12),NativeUi.dp(this,12),NativeUi.dp(this,12));
        heading.addView(back, new LinearLayout.LayoutParams(NativeUi.dp(this, 48), NativeUi.dp(this, 48)));
        TextView brand = NativeUi.text(this, "SH Chat", 18, true); brand.setGravity(Gravity.CENTER);
        heading.addView(brand, new LinearLayout.LayoutParams(0, -2, 1)); root.addView(heading);
        ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true); scroll.setClipToPadding(false);
        LinearLayout content = new LinearLayout(this); content.setOrientation(LinearLayout.VERTICAL); content.setGravity(Gravity.CENTER_HORIZONTAL);
        content.setPadding(0, NativeUi.dp(this, 12), 0, NativeUi.dp(this, 12)); scroll.addView(content, new ScrollView.LayoutParams(-1, -2));
        root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        TextView kind = NativeUi.text(this, transferId.isEmpty() ? "WhatsApp audio call" : "Incoming call transfer", 15, false);
        kind.setTextColor(NativeUi.muted(this)); kind.setGravity(Gravity.CENTER); content.addView(kind);
        ImageView logo = new ImageView(this); avatar = logo; logo.setImageBitmap(NativeBrand.logo(this)); logo.setContentDescription("Smart Handicrafts");
        logo.setScaleType(ImageView.ScaleType.FIT_CENTER); int logoPad = NativeUi.dp(this, 14); logo.setPadding(logoPad, logoPad, logoPad, logoPad);
        GradientDrawable circle = new GradientDrawable(); circle.setShape(GradientDrawable.OVAL); circle.setColor(Color.WHITE); logo.setBackground(circle); logo.setClipToOutline(true);
        content.addView(logo, new LinearLayout.LayoutParams(NativeUi.dp(this, 112), NativeUi.dp(this, 112)));
        title = NativeUi.text(this, displayName, 28, true); title.setGravity(Gravity.CENTER); title.setMaxLines(3); content.addView(title);
        status = NativeUi.text(this, transferId.isEmpty() ? "Incoming call" : "Accept to join the customer", 17, false);
        status.setGravity(Gravity.CENTER); status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); content.addView(status);
        timer = NativeUi.text(this, "", 20, false); timer.setGravity(Gravity.CENTER); content.addView(timer);
        dialInput = new EditText(this); dialInput.setInputType(android.text.InputType.TYPE_CLASS_PHONE); dialInput.setSingleLine(true);
        dialInput.setTextColor(NativeUi.foreground(this)); dialInput.setHintTextColor(NativeUi.muted(this)); dialInput.setHint("Country code and phone number");
        dialInput.setText(phone); dialInput.setTextSize(20); dialInput.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(32)});
        content.addView(dialInput, new LinearLayout.LayoutParams(-1, -2)); dialInput.setMinimumHeight(NativeUi.dp(this, 56)); dialInput.setVisibility(View.GONE);
        activeActions = new LinearLayout(this); activeActions.setOrientation(LinearLayout.VERTICAL);
        LinearLayout audio = new LinearLayout(this); audio.setOrientation(LinearLayout.HORIZONTAL);
        mute = NativeUi.button(this, "Mute", view -> command("mute", ""));
        speaker = NativeUi.button(this, "Speaker", view -> command("speaker", "")); addHalf(audio, mute); addHalf(audio, speaker); activeActions.addView(audio);
        transfer = NativeUi.button(this, "Transfer to another phone", view -> chooseTransfer()); actionSize(transfer); activeActions.addView(transfer);
        cancelTransfer = NativeUi.button(this, "Cancel transfer", view -> command("cancel-transfer", latest == null ? "" : latest.optString("sourceTransferId")));
        actionSize(cancelTransfer); activeActions.addView(cancelTransfer); cancelTransfer.setVisibility(View.GONE);
        activeActions.setVisibility(View.GONE); content.addView(activeActions, new LinearLayout.LayoutParams(-1, -2));
        hint = NativeUi.text(this, transferId.isEmpty() ? "Your microphone starts only after you choose Accept." : "The first phone stays connected until this phone is ready.", 13, false);
        hint.setTextColor(NativeUi.muted(this)); hint.setGravity(Gravity.CENTER); content.addView(hint);
        callPermissionActions=new LinearLayout(this);callPermissionActions.setOrientation(LinearLayout.VERTICAL);
        callPermissionStatus=NativeUi.text(this,"Check permission or explicitly send a permission request for this number.",13,false);
        callPermissionStatus.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        callPermissionActions.addView(callPermissionStatus,new LinearLayout.LayoutParams(-1,-2));
        requestCallPermission=NativeUi.button(this,"Request call permission",view->queryCallPermission(true));
        checkCallPermission=NativeUi.button(this,"Check permission",view->queryCallPermission(false));
        actionSize(requestCallPermission);actionSize(checkCallPermission);
        callPermissionActions.addView(requestCallPermission);callPermissionActions.addView(checkCallPermission);
        callPermissionActions.setVisibility(View.GONE);content.addView(callPermissionActions,new LinearLayout.LayoutParams(-1,-2));
        dialInput.addTextChangedListener(new TextWatcher(){
            @Override public void beforeTextChanged(CharSequence value,int start,int count,int after) { }
            @Override public void onTextChanged(CharSequence value,int start,int before,int count) { resetCallPermission(); }
            @Override public void afterTextChanged(Editable value) { }
        });
        // Answer/Decline/End stay outside the scrolling content, including on small screens and large fonts.
        incomingActions = new LinearLayout(this); incomingActions.setOrientation(LinearLayout.HORIZONTAL);
        decline = NativeUi.button(this, "Decline", view -> decline()); accept = NativeUi.button(this, "Accept", view -> callButtonTapped());
        paintRed(decline); addHalf(incomingActions, decline); addHalf(incomingActions, accept); root.addView(incomingActions);
        end = NativeUi.button(this, "End call", view -> endCall()); paintRed(end); actionSize(end); end.setVisibility(View.GONE); root.addView(end);
        setContentView(root);
    }
    private void actionSize(Button button) {
        button.setMinimumHeight(NativeUi.dp(this, 52)); button.setPadding(NativeUi.dp(this, 12), NativeUi.dp(this, 10), NativeUi.dp(this, 12), NativeUi.dp(this, 10));
        LinearLayout.LayoutParams size = new LinearLayout.LayoutParams(-1, -2); size.setMargins(0, NativeUi.dp(this, 6), 0, NativeUi.dp(this, 6)); button.setLayoutParams(size);
    }
    private void addHalf(LinearLayout row, Button button) {
        actionSize(button); LinearLayout.LayoutParams size = new LinearLayout.LayoutParams(0, -2, 1);
        size.setMargins(NativeUi.dp(this, 4), NativeUi.dp(this, 6), NativeUi.dp(this, 4), NativeUi.dp(this, 6)); row.addView(button, size);
    }
    private boolean command(String action, String value) {
        return latest != null && NativeRoomCallService.commandForAttempt(expectedAttemptId, latest.optString("ownerLegId"), action, value);
    }
    private void endCall() {
        uiGeneration++; startGate.invalidate(); starting = false;
        String endingAttempt = expectedAttemptId;
        NativeStore store = new NativeStore(this);
        if (NativeRoomUiBinding.validAttemptId(endingAttempt)) store.cancelRoomAttempt(endingAttempt);
        boolean handled = command("end", "");
        if (handled) {
            JSONObject closed = NativeRoomCallService.snapshot(); if (closed != null && sameCall(closed)) latest = closed;
        } else if (NativeRoomUiBinding.validAttemptId(endingAttempt)) {
            if (action.equals("outgoing") && callId.isEmpty()) NativeRoomCleanup.enqueueOutgoingCancellation(this, screenCredential, endingAttempt);
            else if (HubPolicy.validCallId(callId)) NativeRoomCleanup.enqueue(this, screenCredential, callId, transferId, latest == null ? "" : latest.optString("ownerLegId"));
        }
        if (!handled) markLocalClose();
        returnToChat();
    }
    private void markLocalClose() {
        try {
            JSONObject value = latest == null ? new JSONObject() : new JSONObject(latest.toString());
            latest = value.put("closed",true).put("callId",callId).put("clientAttemptId",expectedAttemptId);
        } catch (Exception ignored) { }
    }
    private void paintRed(Button button) { GradientDrawable bg = new GradientDrawable(); bg.setColor(NativeBrand.RED); bg.setCornerRadius(NativeUi.dp(this, 24)); button.setBackground(new android.graphics.drawable.RippleDrawable(android.content.res.ColorStateList.valueOf(Color.argb(55,255,255,255)),bg,null)); }

    private void verifyWaitingCall() {
        if (!HubPolicy.validCallId(callId)) { status.setText("This call is no longer available."); accept.setEnabled(false); return; }
        NativeStore store = new NativeStore(this); DeviceLeasePolicy.Credential credential = store.credential(); long generation = ++uiGeneration;
        String selectedId = callId;
        HubApplication.IO.execute(() -> {
            try {
                JSONObject result = callApi.request("/calls/" + Uri.encode(selectedId) + "/status", "GET", null, credential.bearer);
                JSONObject call = result.optJSONObject("call");
                runOnUiThread(() -> {
                    if (isFinishing() || generation != uiGeneration || !store.matchesCredential(credential) || call == null) return;
                    if (HubPolicy.terminal(call.optString("phase"))) {
                        String destination = call.optString("customerPhone");
                        if (NativeRoomPolicy.validPhone(destination)) { phone = destination; dialInput.setText(phone); action = "dial"; showDialer("Call ended. You can call this customer again."); }
                        else { status.setText("Call ended"); accept.setEnabled(false); }
                    }
                    String customer = call.optString("customerName", call.optString("callerName"));
                    if (!customer.isEmpty()) { displayName = customer; title.setText(customer); }
                    String owner = NativeRoomJson.text(call,"ownerDeviceId");
                    if (!HubPolicy.terminal(call.optString("phase")) && !owner.isEmpty() && transferId.isEmpty()) {
                        if (owner.equals(credential.deviceId)) { accept.setText("Resume call"); status.setText("Resume this phone's call audio"); }
                        else { accept.setEnabled(false); status.setText("This call was answered on another phone."); }
                    }
                });
            } catch (Exception error) { runOnUiThread(() -> { if (!isFinishing() && generation == uiGeneration) status.setText("Check your connection, then tap Accept to verify this call."); }); }
        });
    }
    private void showDialer(String message) {
        dialInput.setText(phone);resetCallPermission();callPermissionActions.setVisibility(View.VISIBLE);
        busyWaiting = false; waitingAnswer = null; waitingCleanupRequired = false; busyAttemptId = ""; busyOwnerLegId = "";
        action = "dial"; title.setText(displayName); status.setText(message); dialInput.setVisibility(View.VISIBLE); incomingActions.setVisibility(View.VISIBLE);
        activeActions.setVisibility(View.GONE); end.setVisibility(View.GONE); accept.setText("Call"); accept.setEnabled(true); decline.setText("Cancel");
        hint.setText("The customer must allow WhatsApp calls from your business.");
        avatar.setVisibility(View.GONE); timer.setVisibility(View.GONE);
    }
    private void resetCallPermission() {
        permissionGeneration++;permissionBusy=false;permissionOutcomeUncertain=false;permissionState=null;permissionDestination="";
        if (callPermissionStatus!=null) callPermissionStatus.setText("Check permission or explicitly send a permission request for this number.");
        if (requestCallPermission!=null) {requestCallPermission.setText("Request call permission");requestCallPermission.setEnabled(true);}
        if (checkCallPermission!=null) checkCallPermission.setEnabled(true);
        if (accept!=null&&"dial".equals(action)) accept.setEnabled(true);
    }
    private void queryCallPermission(boolean send) {
        if (isFinishing()||permissionBusy||!"dial".equals(action)) return;
        final String selected=NativeCallPermissionState.normalize(dialInput.getText().toString());
        if (selected.isEmpty()) {callPermissionStatus.setText("Enter a valid number including its country code.");return;}
        NativeStore store=new NativeStore(this);DeviceLeasePolicy.Credential credential=store.credential();
        if (!DeviceLeasePolicy.valid(credential,System.currentTimeMillis())||!DeviceLeasePolicy.sameIdentity(credential,screenCredential)) {
            callPermissionStatus.setText("Device registration changed. Register this phone again before requesting permission.");return;
        }
        if (send&&(permissionOutcomeUncertain||(selected.equals(permissionDestination)&&permissionState!=null&&!permissionState.canRequest))) return;
        String savedId=store.callPermissionRequestId(credential,selected);
        if (send) {
            boolean explicitNew=selected.equals(permissionDestination)&&permissionState!=null&&permissionState.canRequest
                &&("sent".equals(permissionState.requestState)||"blocked".equals(permissionState.requestState));
            if (savedId.isEmpty()||explicitNew) savedId=UUID.randomUUID().toString();
            if (!store.rememberCallPermissionRequest(credential,selected,savedId)) {
                callPermissionStatus.setText("Could not safely save this request. No message was sent.");return;
            }
        }
        final String requestId=savedId;final long ticket=++permissionGeneration;
        permissionBusy=true;requestCallPermission.setEnabled(false);checkCallPermission.setEnabled(false);accept.setEnabled(false);
        callPermissionStatus.setText((send?"Requesting call permission from +":"Checking call permission for +")+selected+"…");
        HubApplication.IO.execute(()->{
            try {
                String path=send?"/call-permission/request":"/call-permission/status?to="+Uri.encode(selected)+(requestId.isEmpty()?"":"&requestId="+Uri.encode(requestId));
                JSONObject body=send?new JSONObject().put("to",selected).put("requestId",requestId):null;
                JSONObject result=callApi.request(path,send?"POST":"GET",body,credential.bearer);
                NativeCallPermissionState state=NativeCallPermissionState.parse(result,selected,requestId,System.currentTimeMillis());
                runOnUiThread(()->{
                    if (!permissionCallbackCurrent(ticket,selected,credential,store)) return;
                    permissionBusy=false;permissionOutcomeUncertain=false;permissionDestination=selected;permissionState=state;
                    callPermissionStatus.setText(state.message());checkCallPermission.setEnabled(true);
                    requestCallPermission.setText("sent".equals(state.requestState)?"Request permission again":"Request call permission");
                    requestCallPermission.setEnabled(state.canRequest);accept.setEnabled(state.canCall);
                });
            } catch (Exception error) {
                runOnUiThread(()->{
                    if (!permissionCallbackCurrent(ticket,selected,credential,store)) return;
                    permissionBusy=false;permissionState=null;permissionDestination=selected;
                    NativeApi.ApiException apiError=error instanceof NativeApi.ApiException?(NativeApi.ApiException)error:null;
                    boolean blocked=send&&apiError!=null&&apiError.errorCode.matches("CALL_PERMISSION_WINDOW_CLOSED|CALL_PERMISSION_REQUEST_BLOCKED|CALL_PERMISSION_UNAVAILABLE|CALL_PERMISSION_STATUS_UNAVAILABLE")
                        &&(apiError.permissionRequestId.isEmpty()||requestId.equals(apiError.permissionRequestId))
                        &&(apiError.permissionRequestState.isEmpty()||"blocked".equals(apiError.permissionRequestState));
                    permissionOutcomeUncertain=permissionOutcomeUncertain||(send&&!blocked);
                    String explanation=blocked?NativeCallPermissionState.blockedMessage(apiError.errorCode,"+"+selected)
                        :send?"Request delivery for +"+selected+" is unconfirmed. Use Check permission before trying again."
                        :"Could not confirm call permission for +"+selected+". Check again when your connection is available.";
                    if (apiError!=null&&(apiError.status==401||apiError.status==403))
                        explanation="Device authorization expired or was denied. Register this phone again.";
                    callPermissionStatus.setText(explanation);checkCallPermission.setEnabled(true);requestCallPermission.setEnabled(!send&&!permissionOutcomeUncertain);accept.setEnabled(false);
                });
            }
        });
    }
    private boolean permissionCallbackCurrent(long ticket,String selected,DeviceLeasePolicy.Credential credential,NativeStore store) {
        if (isFinishing()||ticket!=permissionGeneration||!"dial".equals(action)
            ||!selected.equals(NativeCallPermissionState.normalize(dialInput.getText().toString()))) return false;
        if (!store.matchesCredential(credential)) {
            permissionBusy=false;permissionOutcomeUncertain=true;
            callPermissionStatus.setText("Device registration changed. Reopen the call screen.");
            requestCallPermission.setEnabled(false);checkCallPermission.setEnabled(false);accept.setEnabled(false);return false;
        }
        return true;
    }
    private void showBusyIncoming() {
        resetCallPermission();callPermissionActions.setVisibility(View.GONE);
        startGate.invalidate(); pendingStartCredential = null; starting = false; busyWaiting = true;
        waitingAnswer = null;
        JSONObject active = NativeRoomCallService.snapshot();
        busyAttemptId = active == null ? "" : active.optString("clientAttemptId");
        busyOwnerLegId = active == null ? "" : active.optString("ownerLegId");
        title.setText(displayName); status.setText("A call is already active on this phone.");
        dialInput.setVisibility(View.GONE); avatar.setVisibility(View.VISIBLE); timer.setText(""); timer.setVisibility(View.GONE);
        incomingActions.setVisibility(View.VISIBLE); activeActions.setVisibility(View.GONE); end.setVisibility(View.GONE);
        accept.setText("End current & answer");
        accept.setEnabled(HubPolicy.validCallId(callId) && NativeRoomUiBinding.validAttemptId(busyAttemptId)
            && DeviceLeasePolicy.valid(screenCredential, System.currentTimeMillis()));
        decline.setText("Decline");
        hint.setText("Answering ends your current call. Decline keeps your current call connected.");
    }
    private void releaseBusyIfPossible() {
        if (waitingAnswer != null) { checkWaitingAnswer(waitingAnswer); return; }
        if (!busyWaiting || isFinishing() || NativeRoomCallService.isRunning()) return;
        busyWaiting = false; waitingCleanupRequired = true;
        title.setText(displayName); status.setText(transferId.isEmpty() ? "Incoming call" : "Accept to join the customer");
        accept.setText("Accept"); accept.setEnabled(true);
        hint.setText("Your microphone starts only after you choose Accept.");
        // Reconcile this waiting call only; never adopt the other call or auto-answer it.
        verifyWaitingCall();
    }
    private void callButtonTapped() {
        if (permissionBusy) return;
        if ("dial".equals(action)&&permissionState!=null&&permissionDestination.equals(NativeCallPermissionState.normalize(dialInput.getText().toString()))
            &&(!permissionState.canCall||("temporary".equals(permissionState.status)&&permissionState.expiresAtMs<=System.currentTimeMillis()))) {
            callPermissionStatus.setText("Call permission is not current for +"+permissionDestination+". Use Check permission before calling.");accept.setEnabled(false);return;
        }
        if (busyWaiting || waitingCleanupRequired) { endCurrentAndAnswer(); return; }
        if (action.equals("dial")) {
            String entered = dialInput.getText().toString().trim();
            String destination = entered.matches("\\+?[1-9][0-9 ()-]*") ? entered.replaceAll("[^0-9]", "") : "";
            if (!NativeRoomPolicy.validPhone(destination)) { status.setText("Enter a valid number including its country code."); return; }
            phone = destination; callId = ""; transferId = ""; action = "outgoing";
        }
        beginAccept();
    }
    private void endCurrentAndAnswer() {
        if (waitingAnswer != null || starting || isFinishing()) return;
        NativeStore store = new NativeStore(this); DeviceLeasePolicy.Credential credential = store.credential();
        if (!HubPolicy.validCallId(callId) || store.roomAlertClosed(callId, transferId)
            || (store.roomAlertExpiry(callId, transferId) > 0 && store.roomAlertExpiry(callId, transferId) <= System.currentTimeMillis())) {
            accept.setEnabled(false); status.setText("This incoming call has ended."); return;
        }
        if (!DeviceLeasePolicy.valid(credential, System.currentTimeMillis()) || !DeviceLeasePolicy.sameIdentity(credential, screenCredential)
            || !NativeRoomNotifications.currentEnrollment(this, getIntent())) {
            accept.setEnabled(false); status.setText("Device registration changed. Reopen the call."); return;
        }
        JSONObject active = NativeRoomCallService.snapshot();
        if (active != null && !active.optBoolean("closed")) {
            // The gesture authorizes only the attempt and leg displayed with this button.
            // Never retarget a delayed tap to a replacement call or a returned transfer leg.
            if (!busyAttemptId.equals(active.optString("clientAttemptId"))
                || (!busyOwnerLegId.isEmpty() && !busyOwnerLegId.equals(active.optString("ownerLegId")))) {
                showBusyIncoming(); status.setText("The active call changed. Choose again to end that call."); return;
            }
        }
        startGate.invalidate(); pendingStartCredential = null; starting = false; busyWaiting = false; waitingCleanupRequired = true;
        WaitingAnswer next = new WaitingAnswer(++uiGeneration, callId, transferId, credential, busyAttemptId, busyOwnerLegId,
            active == null || active.optBoolean("closed")); waitingAnswer = next;
        accept.setEnabled(false); accept.setText("Checking incoming call…"); status.setText("Checking that the incoming call is still available…");
        hint.setText(next.sourceEnded ? "Your previous audio has stopped. Checking whether this phone is ready to answer."
            : "Your current call stays connected while the incoming call is checked.");
        checkWaitingAnswer(next);
    }
    private boolean currentWaitingAnswer(WaitingAnswer selected) {
        return waitingAnswer == selected && selected.generation == uiGeneration && !isFinishing() && !isDestroyed()
            && selected.callId.equals(callId) && selected.transferId.equals(transferId);
    }
    private void waitingAnswerStopped(WaitingAnswer selected, String message, boolean retry) {
        if (!currentWaitingAnswer(selected)) return;
        waitingAnswer = null; accept.setText(retry ? "Retry answer" : "Accept"); accept.setEnabled(retry); status.setText(message);
    }
    private void checkWaitingAnswer(WaitingAnswer selected) {
        if (!currentWaitingAnswer(selected) || selected.checking) return;
        NativeStore store = new NativeStore(this);
        if (!store.matchesCredential(selected.credential) || !DeviceLeasePolicy.valid(store.credential(), System.currentTimeMillis())) {
            waitingAnswerStopped(selected, "Device registration changed. Reopen the call.", false); return;
        }
        long expiry = store.roomAlertExpiry(selected.callId, selected.transferId);
        if (store.roomAlertClosed(selected.callId, selected.transferId) || (expiry > 0 && expiry <= System.currentTimeMillis())) {
            waitingAnswerStopped(selected, "This incoming call has ended.", false); return;
        }
        if (SystemClock.elapsedRealtime() >= selected.deadline) {
            waitingAnswerStopped(selected, selected.sourceEnded ? "The previous call is still finishing. Check your connection, then retry answer."
                : "The incoming call check timed out. Your current call stays connected. Retry answer.", true); return;
        }
        if (!resumed) return;
        JSONObject active = NativeRoomCallService.snapshot();
        if (selected.sourceEnded && active != null && !active.optBoolean("closed")) {
            waitingAnswerStopped(selected, "Another call is now active. Reopen this incoming call.", false); return;
        }
        selected.checking = true;
        HubApplication.IO.execute(() -> {
            try {
                JSONObject result = callApi.request("/calls/" + Uri.encode(selected.callId) + "/status", "GET", null, selected.credential.bearer);
                runOnUiThread(() -> {
                    selected.checking = false;
                    if (!currentWaitingAnswer(selected)) return;
                    if (!store.matchesCredential(selected.credential)) { waitingAnswerStopped(selected, "Device registration changed. Reopen the call.", false); return; }
                    JSONObject call = result.optJSONObject("call");
                    boolean exact = call != null && (selected.callId.equals(NativeRoomJson.text(call, "callId"))
                        || selected.callId.equals(NativeRoomJson.text(call, "providerCallId")) || selected.callId.equals(NativeRoomJson.text(call, "sessionId")));
                    if (!exact || !(result.opt("deviceAvailable") instanceof Boolean)) {
                        waitingAnswerStopped(selected, "Call availability could not be verified. Update operator services, then retry answer.", true); return;
                    }
                    if (HubPolicy.terminal(call.optString("phase"))) { waitingAnswerStopped(selected, "This incoming call has ended.", false); return; }
                    if (selected.transferId.isEmpty()) {
                        if (!NativeRoomJson.text(call, "ownerDeviceId").isEmpty()) { waitingAnswerStopped(selected, "This call was answered on another phone.", false); return; }
                        if (!"ringing".equals(call.optString("phase")) && !"incoming".equals(call.optString("phase"))) {
                            waitingAnswerStopped(selected, "This incoming call is no longer available.", false); return;
                        }
                    } else {
                        JSONObject invitation = call.optJSONObject("transfer");
                        if (invitation == null || !selected.transferId.equals(invitation.optString("id"))
                            || !selected.credential.deviceId.equals(invitation.optString("toDeviceId")) || !"invited".equals(invitation.optString("status"))) {
                            waitingAnswerStopped(selected, "This transfer is no longer available.", false); return;
                        }
                        if (!(result.opt("deviceAvailableForCall") instanceof Boolean)) {
                            waitingAnswerStopped(selected, "Transfer availability could not be verified. Update operator services, then retry answer.", true); return;
                        }
                        if (!result.optBoolean("deviceAvailableForCall")) {
                            waitingAnswerStopped(selected, "This transfer is no longer available on this phone.", false); return;
                        }
                    }
                    long currentExpiry = store.roomAlertExpiry(selected.callId, selected.transferId);
                    if (store.roomAlertClosed(selected.callId, selected.transferId) || (currentExpiry > 0 && currentExpiry <= System.currentTimeMillis())) {
                        waitingAnswerStopped(selected, "This incoming call has ended.", false); return;
                    }
                    if (SystemClock.elapsedRealtime() >= selected.deadline) {
                        waitingAnswerStopped(selected, selected.sourceEnded ? "The previous call is still finishing. Check your connection, then retry answer."
                            : "The incoming call check timed out. Your current call stays connected. Retry answer.", true); return;
                    }
                    if (!selected.sourceEnded) {
                        // Validate the exact incoming call before ending anything, then bind the
                        // delayed result back to the originally displayed attempt and media leg.
                        JSONObject current = NativeRoomCallService.snapshot();
                        if (current != null && !current.optBoolean("closed")) {
                            if (!selected.sourceAttemptId.equals(current.optString("clientAttemptId"))
                                || (!selected.sourceOwnerLegId.isEmpty() && !selected.sourceOwnerLegId.equals(current.optString("ownerLegId")))) {
                                waitingAnswerStopped(selected, "The active call changed. Reopen this incoming call.", false); return;
                            }
                            if (!resumed) { handler.postDelayed(() -> checkWaitingAnswer(selected), 500); return; }
                            if (!DeviceLeasePolicy.valid(store.credential(), System.currentTimeMillis())
                                || !NativeRoomCallService.commandForAttempt(selected.sourceAttemptId, selected.sourceOwnerLegId, "end", "")) {
                                waitingAnswerStopped(selected, "The active call changed. Reopen this incoming call.", false); return;
                            }
                        }
                        selected.sourceEnded = true; accept.setText("Answering…"); status.setText("Finishing the previous call…");
                        hint.setText("Your previous audio has stopped. Checking that this incoming call is still available.");
                        // Pre-End availability is stale by definition. Read both incoming state
                        // and this device's reservation again after local audio has stopped.
                        handler.post(() -> checkWaitingAnswer(selected)); return;
                    }
                    boolean deviceCanAccept = selected.transferId.isEmpty() ? result.optBoolean("deviceAvailable") : result.optBoolean("deviceAvailableForCall");
                    if (resumed && deviceCanAccept && NativeRoomCallService.snapshot() == null) {
                        // The durable reservation must be free after cleanup; the server's atomic
                        // transfer exception requires this exact target invitation's reservation.
                        // Accept still wins any race after this observation. A local End ACK alone
                        // never means that a new call may reserve this device.
                        waitingAnswer = null; waitingCleanupRequired = false; busyWaiting = false; beginAccept();
                    } else handler.postDelayed(() -> checkWaitingAnswer(selected), 500);
                });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    selected.checking = false;
                    if (!currentWaitingAnswer(selected)) return;
                    if (!selected.sourceEnded) {
                        waitingAnswerStopped(selected, "Could not verify the incoming call. Your current call stays connected. Retry answer.", true); return;
                    }
                    status.setText("Checking your connection before answering…");
                    handler.postDelayed(() -> checkWaitingAnswer(selected), 1000);
                });
            }
        });
    }
    private void resolveCallback() {
        if (!HubPolicy.validCallId(callId)) { showDialer("Enter the customer number to call."); return; }
        status.setText("Looking up the customer"); accept.setEnabled(false);
        NativeStore store = new NativeStore(this); DeviceLeasePolicy.Credential credential = store.credential(); long generation = ++uiGeneration;
        String selectedId = callId;
        HubApplication.IO.execute(() -> {
            try {
                JSONObject call = callApi.request("/calls/" + Uri.encode(selectedId) + "/status", "GET", null, credential.bearer).getJSONObject("call");
                String destination = call.optString("customerPhone"), name = call.optString("customerName");
                runOnUiThread(() -> {
                    if (isFinishing() || generation != uiGeneration || !store.matchesCredential(credential)) return;
                    if (!NativeRoomPolicy.validPhone(destination)) { showDialer("Enter the customer number to call."); return; }
                    phone = destination; displayName = name.isEmpty() ? "+" + phone : name; title.setText(displayName);
                    action = "outgoing"; callId = ""; transferId = ""; beginAccept();
                });
            } catch (Exception error) { runOnUiThread(() -> { if (!isFinishing() && generation == uiGeneration) showDialer("Enter the number for this earlier call."); }); }
        });
    }
    private void beginAccept() {
        if (starting || isFinishing()) return;
        resetCallPermission();callPermissionActions.setVisibility(View.GONE);
        JSONObject running = NativeRoomCallService.snapshot();
        if (running != null && !running.optBoolean("closed")) {
            if (sameCall(running) || action.equals("outgoing")) render(running);
            else showBusyIncoming();
            return;
        }
        if (ActiveCallService.isActiveForAny()) { status.setText("Finish the browser call before starting another call."); return; }
        if ((!action.equals("outgoing") && !HubPolicy.validCallId(callId)) || (action.equals("outgoing") && !NativeRoomPolicy.validPhone(phone))) { status.setText("Invalid call details."); return; }
        DeviceLeasePolicy.Credential selectedCredential = new NativeStore(this).credential();
        if (!DeviceLeasePolicy.valid(selectedCredential, System.currentTimeMillis())) { status.setText("Register this phone in App settings before answering."); return; }
        if (!DeviceLeasePolicy.sameIdentity(selectedCredential, screenCredential) || !NativeRoomNotifications.currentEnrollment(this, getIntent())) { status.setText("Device registration changed. Reopen the call."); accept.setEnabled(false); return; }
        starting = true; accept.setEnabled(false); status.setText(action.equals("outgoing") ? "Starting call" : "Answering call");
        long startTicket = startGate.begin(); pendingStartCredential = selectedCredential; ++uiGeneration;
        if (HubPolicy.validCallId(callId)) NativeRoomNotifications.cancel(this, callId, transferId);
        // The authoritative native API authenticates and checks capabilities. No extra network
        // check belongs between a user's Answer gesture and the foreground microphone service.
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            if (Build.VERSION.SDK_INT >= 31 && checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED)
                requestCallPermissions(startTicket, new String[]{Manifest.permission.RECORD_AUDIO, Manifest.permission.BLUETOOTH_CONNECT}, 41);
            else requestCallPermissions(startTicket, new String[]{Manifest.permission.RECORD_AUDIO}, 41);
        } else if (Build.VERSION.SDK_INT >= 31 && checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED)
            requestCallPermissions(startTicket, new String[]{Manifest.permission.BLUETOOTH_CONNECT}, 42);
        else startAudioService(startTicket);
    }
    private void requestCallPermissions(long ticket, String[] permissions, int requestCode) {
        if (!startGate.awaitPermission(ticket, requestCode)) {
            startGate.cancel(ticket); starting = false; accept.setEnabled(true);
            status.setText("Finish the phone's permission prompt, then tap Accept or Call again."); return;
        }
        requestPermissions(permissions, requestCode);
    }
    private void startAudioService(long ticket) {
        if (isFinishing() || !startGate.current(ticket)) return;
        DeviceLeasePolicy.Credential currentCredential = new NativeStore(this).credential();
        if (!DeviceLeasePolicy.sameIdentity(currentCredential, pendingStartCredential) || !DeviceLeasePolicy.valid(currentCredential, System.currentTimeMillis())) {
            startGate.cancel(ticket); pendingStartCredential = null; starting = false; accept.setEnabled(false);
            status.setText("Device registration changed. Reopen the call."); return;
        }
        if (!resumed) { handler.postDelayed(() -> startAudioService(ticket), 100); return; }
        JSONObject active = NativeRoomCallService.snapshot();
        if (active != null && !active.optBoolean("closed")) {
            if (sameCall(active) || action.equals("outgoing")) render(active);
            else showBusyIncoming();
            return;
        }
        // Wait for the just-ended service instance to be destroyed before a fresh attempt.
        if (active != null && active.optBoolean("closed")) { handler.postDelayed(() -> startAudioService(ticket), 50); return; }
        if (ActiveCallService.isActiveForAny()) { startGate.cancel(ticket); starting = false; accept.setEnabled(true); status.setText("Finish the browser call before starting another call."); return; }
        if (!startGate.takeStart(ticket)) return;
        android.view.inputmethod.InputMethodManager keyboard = getSystemService(android.view.inputmethod.InputMethodManager.class);
        keyboard.hideSoftInputFromWindow(dialInput.getWindowToken(), 0); dialInput.clearFocus(); avatar.setVisibility(View.VISIBLE); timer.setVisibility(View.VISIBLE);
        // Bind before startForegroundService: its first snapshot has no outgoing server ID yet.
        expectedAttemptId = UUID.randomUUID().toString();
        Intent intent = new Intent(this, NativeRoomCallService.class).putExtra("call_id", callId).putExtra("transfer_id", transferId)
            .putExtra("client_attempt_id", expectedAttemptId)
            .putExtra("enrollment_generation", pendingStartCredential.generation).putExtra("enrolled_device_id", pendingStartCredential.deviceId)
            .putExtra("room_action", action.equals("outgoing") ? "outgoing" : "accept").putExtra("phone", phone)
            .putExtra("display_name", displayName).putExtra("channel_id", channelId);
        try { startForegroundService(intent); dialInput.setVisibility(View.GONE); incomingActions.setVisibility(View.GONE); activeActions.setVisibility(View.VISIBLE); end.setVisibility(View.VISIBLE); mute.setEnabled(false); speaker.setEnabled(false); transfer.setEnabled(false); status.setText("Connecting audio"); }
        catch (RuntimeException error) { new NativeStore(this).cancelRoomAttempt(expectedAttemptId); starting = false; incomingActions.setVisibility(View.VISIBLE); activeActions.setVisibility(View.GONE); end.setVisibility(View.GONE); accept.setEnabled(true); status.setText("Android could not start call audio. Reopen the app and try again."); }
    }
    private void decline() {
        uiGeneration++; startGate.invalidate();
        if (!action.equals("dial") && !action.equals("outgoing") && HubPolicy.validCallId(callId)) {
            NativeStore store = new NativeStore(this);
            if (store.matchesCredential(screenCredential)) {
                store.closeRoomAlert(callId, transferId); NativeRoomNotifications.cancel(this, callId, transferId);
                // Explicit user Decline also works for calls opened in the Hub without an FCM record.
                NativeRoomCleanup.enqueueDecline(this, screenCredential, callId, transferId);
            }
            markLocalClose();
        }
        returnToChat();
    }
    private void render(JSONObject value) {
        resetCallPermission();callPermissionActions.setVisibility(View.GONE);
        startGate.invalidate(); busyWaiting = false; waitingAnswer = null; waitingCleanupRequired = false;
        String attempt = value.optString("clientAttemptId", value.optString("outgoingRequestId"));
        if (NativeRoomUiBinding.validAttemptId(attempt)) expectedAttemptId = attempt;
        latest = value; starting = false; callId = value.optString("callId", callId); transferId = value.optString("transferId", transferId);
        channelId = value.optInt("channelId", channelId);
        title.setText(value.optString("displayName", displayName)); status.setText(value.optString("detail"));
        dialInput.setVisibility(View.GONE); avatar.setVisibility(View.VISIBLE); timer.setVisibility(View.VISIBLE);
        incomingActions.setVisibility(View.GONE); activeActions.setVisibility(View.VISIBLE); end.setVisibility(View.VISIBLE);
        boolean closed = value.optBoolean("closed"); boolean ready = "connected".equals(value.optString("state"));
        mute.setEnabled(ready); speaker.setEnabled(!closed && !value.optString("ownerLegId").isEmpty()); end.setEnabled(!closed); transfer.setEnabled(value.optBoolean("canTransfer"));
        mute.setText(value.optBoolean("muted") ? "Unmute" : "Mute"); speaker.setText(value.optBoolean("speaker") ? "Speaker on" : "Speaker");
        mute.setContentDescription(value.optBoolean("muted") ? "Unmute microphone" : "Mute microphone");
        speaker.setContentDescription("Audio output: " + value.optString("audioRoute", "Phone") + ". " + (value.optBoolean("speaker") ? "Turn speaker off" : "Turn speaker on"));
        if (Build.VERSION.SDK_INT >= 30) { mute.setStateDescription(value.optBoolean("muted") ? "Muted" : "Unmuted"); speaker.setStateDescription(value.optString("audioRoute", "Phone")); }
        cancelTransfer.setEnabled(!value.optBoolean("cancelTransferPending"));
        cancelTransfer.setVisibility(value.optString("sourceTransferId").isEmpty() ? View.GONE : View.VISIBLE);
        hint.setText(value.optString("transferId").isEmpty() ? "Audio continues when you return to chat." : "Joining the customer while the first phone stays connected.");
        if (closed) {
            if ("failed".equals(value.optString("state")) || "unavailable".equals(value.optString("state"))) Toast.makeText(this, value.optString("detail"), Toast.LENGTH_LONG).show();
            if (resumed) returnToChat(); else returnOnResume = true;
        }
    }
    private void chooseTransfer() {
        JSONObject active = NativeRoomCallService.snapshot(); if (active == null || !sameCall(active) || !active.optBoolean("canTransfer")) return;
        String selectedAttempt = active.optString("clientAttemptId"), selectedLeg = active.optString("ownerLegId"); long generation = uiGeneration;
        NativeStore store = new NativeStore(this); DeviceLeasePolicy.Credential credential = store.credential(); String id = active.optString("callId");
        transfer.setEnabled(false);
        HubApplication.IO.execute(() -> {
            try {
                JSONObject result = callApi.request("/devices?callId=" + Uri.encode(id), "GET", null, credential.bearer);
                JSONArray devices = result.optJSONArray("devices"); ArrayList<String> labels = new ArrayList<>(), ids = new ArrayList<>();
                if (devices != null) for (int i = 0; i < devices.length(); i++) {
                    JSONObject device = devices.optJSONObject(i); if (device == null) continue;
                    String deviceId = device.optString("deviceId", device.optString("id"));
                    if (deviceId.equals(credential.deviceId) || device.optBoolean("busy") || !device.optBoolean("available", false) || !device.optBoolean("eligible", true)
                        || device.optInt("nativeBuild", 0) < 10 || !NativeRoomPolicy.PROTOCOL.equals(device.optString("mediaProtocol"))) continue;
                    ids.add(deviceId); labels.add(device.optString("deviceLabel", device.optString("label", "Operator phone")));
                }
                runOnUiThread(() -> {
                    if (isFinishing() || generation != uiGeneration || !store.matchesCredential(credential)) return;
                    JSONObject current = NativeRoomCallService.snapshot();
                    if (current == null || !NativeRoomControl.matches(selectedAttempt, selectedLeg, current.optString("clientAttemptId"), current.optString("ownerLegId"), current.optBoolean("closed"))) return;
                    transfer.setEnabled(current.optBoolean("canTransfer"));
                    if (ids.isEmpty()) { Toast.makeText(this, "No other available registered phones.", Toast.LENGTH_LONG).show(); return; }
                    transferDialog = new AlertDialog.Builder(this).setTitle("Transfer call to")
                        .setItems(labels.toArray(new String[0]), (dialog, selected) -> {
                            if (generation == uiGeneration && store.matchesCredential(credential)) NativeRoomCallService.commandForAttempt(selectedAttempt, selectedLeg, "transfer", ids.get(selected));
                        }).setNegativeButton("Cancel", null).show();
                });
            } catch (Exception error) { runOnUiThread(() -> { if (!isFinishing() && generation == uiGeneration && selectedAttempt.equals(expectedAttemptId)) { transfer.setEnabled(latest != null && latest.optBoolean("canTransfer")); Toast.makeText(this, "Could not load registered phones. Your call stays connected.", Toast.LENGTH_LONG).show(); } }); }
        });
    }
    private void returnToChat() {
        if (isFinishing()) return;
        Intent intent = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (channelId > 0) intent.putExtra("channel_id", channelId);
        JSONObject closedCall = NativeRoomCallService.snapshot();
        if (closedCall == null || !sameCall(closedCall) || !closedCall.optBoolean("closed")) closedCall = latest;
        if (closedCall != null && closedCall.optBoolean("closed")) {
            intent.putExtra("native_closed_call_id", closedCall.optString("callId"));
            intent.putExtra("native_closed_provider_id", closedCall.optString("providerCallId"));
            intent.putExtra("native_closed_attempt_id", closedCall.optString("clientAttemptId"));
            intent.putExtra("native_closed_owner_leg_id", closedCall.optString("ownerLegId"));
        }
        startActivity(intent); finish();
    }
    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent); if (!NativeRoomNotifications.currentEnrollment(this, intent)) return; setIntent(intent); readIntent(intent);
        JSONObject active = NativeRoomCallService.snapshot();
        if (active != null && !active.optBoolean("closed")) {
            // Explicitly opening the current service may bind it; unrelated broadcasts never do.
            if (sameCall(active) || action.equals("outgoing") || callId.isEmpty()) {
                render(active); if (action.equals("transfer")) chooseTransfer();
            } else showBusyIncoming();
        } else if (action.equals("accept") || action.equals("outgoing")) beginAccept();
        else if (action.equals("dial")) showDialer("Enter the customer's country code and phone number.");
        else if (action.equals("callback")) resolveCallback();
        else {
            title.setText(displayName); incomingActions.setVisibility(View.VISIBLE); activeActions.setVisibility(View.GONE); end.setVisibility(View.GONE);
            dialInput.setVisibility(View.GONE); avatar.setVisibility(View.VISIBLE); timer.setText(""); timer.setVisibility(View.GONE);
            accept.setText("Accept"); accept.setEnabled(true); decline.setText("Decline"); verifyWaitingCall();
        }
    }
    @Override protected void onResume() { super.onResume(); resumed = true; if (returnOnResume) returnToChat(); else releaseBusyIfPossible(); }
    @Override protected void onPause() { resumed = false; super.onPause(); }
    @Override public void onBackPressed() { if (NativeRoomCallService.isRunning()) returnToChat(); else super.onBackPressed(); }
    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        long ticket = startGate.permissionResult(code);
        if (ticket == NativeRoomStartGate.NONE) return;
        if (code == 41) {
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) startAudioService(ticket);
            else { startGate.cancel(ticket); starting = false; accept.setEnabled(true); status.setText("Microphone permission is needed to answer. The customer has not been connected to this phone."); }
        }
        // Bluetooth is optional; a denied route permission must not deny the microphone call.
        if (code == 42) startAudioService(ticket);
    }
    @Override protected void onDestroy() { permissionGeneration++; uiGeneration++; startGate.invalidate(); if (transferDialog != null) transferDialog.dismiss(); handler.removeCallbacksAndMessages(null); if (registered) unregisterReceiver(receiver); super.onDestroy(); }
}
