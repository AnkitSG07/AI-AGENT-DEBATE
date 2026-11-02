package com.smarthandicrafts.operatorhub;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import org.json.JSONArray;
import org.json.JSONObject;
import java.text.DateFormat;
import java.util.Date;
import java.util.HashMap;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Notes and audio use explicit reads/saves; this screen never controls call media. */
public final class NativeCallRecordsActivity extends Activity {
    private static final ExecutorService IO = Executors.newFixedThreadPool(2);
    private String callId = "";
    private LinearLayout content;
    private TextView status;
    private DeviceLeasePolicy.Credential credential;
    private long generation;
    private MediaPlayer player;
    private boolean loading;

    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        String requested = getIntent().getStringExtra("call_id");
        if (HubPolicy.validCallId(requested)) callId = requested;
        credential = new NativeStore(this).credential();
        ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true); scroll.setFitsSystemWindows(true);
        LinearLayout panel = new LinearLayout(this); panel.setOrientation(LinearLayout.VERTICAL);
        int padding = NativeUi.dp(this, 20); panel.setPadding(padding,padding,padding,padding);
        panel.setBackgroundColor(NativeUi.background(this)); scroll.addView(panel);
        panel.addView(NativeUi.button(this,"Back", view -> finish()));
        panel.addView(NativeUi.text(this,"Call notes & recordings",24,true));
        status = NativeUi.text(this,"",14,false); panel.addView(status);
        panel.addView(NativeUi.button(this,"Refresh", view -> refresh()));
        if (!callId.isEmpty()) panel.addView(NativeUi.button(this,"Add note", view -> editNote(null)));
        panel.addView(NativeUi.button(this,"Stop playback", view -> stopPlayback()));
        content = new LinearLayout(this); content.setOrientation(LinearLayout.VERTICAL); panel.addView(content);
        setContentView(scroll); refresh();
    }
    private boolean current(long ticket) {
        return ticket == generation && !isFinishing() && !isDestroyed() && new NativeStore(this).matchesCredential(credential);
    }
    private String path(String suffix) { return "/calls/" + Uri.encode(callId) + "/" + suffix; }
    private void refresh() {
        if (loading) return;
        loading = true; long ticket = ++generation; status.setText("Loading…");
        IO.execute(() -> {
            try {
                JSONObject result = NativeApi.callRecords(callId.isEmpty() ? "/call-records" : path("records"), "GET", null, credential.bearer);
                runOnUiThread(() -> {
                    if (!current(ticket)) return;
                    loading = false; content.removeAllViews(); status.setText("");
                    if (callId.isEmpty()) showRecent(result.optJSONArray("records")); else showRecords(result);
                });
            } catch (Exception error) { runOnUiThread(() -> { if (current(ticket)) { loading = false; status.setText(message(error)); } }); }
        });
    }
    private void showRecent(JSONArray rows) {
        if (rows == null || rows.length() == 0) { status.setText("Your saved call notes and recordings will appear here."); return; }
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i); if (row == null) continue;
            String id = row.optString("callId"); if (!HubPolicy.validCallId(id)) continue;
            String name = row.optString("customerName"); if (name.isEmpty()) name = row.optString("customerPhone", "Customer");
            content.addView(NativeUi.button(this, name + "\n" + date(row.optLong("updatedAt")),
                view -> startActivity(new Intent(this, NativeCallRecordsActivity.class).putExtra("call_id", id))));
        }
    }
    private void showRecords(JSONObject result) {
        content.addView(NativeUi.text(this,"Notes",20,true));
        JSONArray notes = result.optJSONArray("notes");
        if (notes == null || notes.length() == 0) content.addView(NativeUi.text(this,"No notes yet.",15,false));
        else for (int i = 0; i < notes.length(); i++) {
            JSONObject note = notes.optJSONObject(i); if (note == null) continue;
            TextView text = NativeUi.text(this,note.optString("text"),16,false); text.setTextIsSelectable(true); content.addView(text);
            content.addView(NativeUi.text(this,date(note.optLong("updatedAt")),12,false));
            if (credential.deviceId.equals(note.optString("deviceId")))
                content.addView(NativeUi.button(this,"Edit note", view -> editNote(note)));
        }
        content.addView(NativeUi.text(this,"Recordings",20,true));
        JSONArray recordings = result.optJSONArray("recordings");
        if (recordings == null || recordings.length() == 0) content.addView(NativeUi.text(this,"No recordings yet.",15,false));
        else for (int i = 0; i < recordings.length(); i++) {
            JSONObject row = recordings.optJSONObject(i); if (row == null) continue;
            JSONArray parts = row.optJSONArray("parts");
            String id = row.optString("id");
            if (!id.matches("[A-Za-z0-9_-]{8,100}")) continue;
            content.addView(NativeUi.text(this,date(row.optLong("startedAt")),15,false));
            if (parts == null || parts.length() == 0) content.addView(NativeUi.text(this,"No saved audio available yet.",13,false));
            else content.addView(NativeUi.button(this,"Play recording", view -> {
                if (NativeRoomCallService.isRunning() || ActiveCallService.isActiveForAny()) {
                    Toast.makeText(this,"Play saved audio after the current call ends.",Toast.LENGTH_LONG).show(); return;
                }
                stopPlayback(); playPart(id, parts, 0);
            }));
        }
    }
    private void editNote(JSONObject existing) {
        EditText input = new EditText(this); input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        input.setMinLines(4); input.setMaxLines(12); input.setHint("Customer requirements, promises, next steps…");
        input.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(4000)});
        if (existing != null) input.setText(existing.optString("text"));
        String noteId = existing == null ? UUID.randomUUID().toString() : existing.optString("id");
        String[] saveAttempt = { "", "" };
        AlertDialog dialog = new AlertDialog.Builder(this).setTitle(existing == null ? "Add call note" : "Edit call note")
            .setView(input).setPositiveButton("Save",null).setNegativeButton("Cancel",null).create();
        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            String text = input.getText().toString().trim(); if (text.isEmpty()) { input.setError("Write a note first."); return; }
            if (!text.equals(saveAttempt[0])) { saveAttempt[0] = text; saveAttempt[1] = UUID.randomUUID().toString(); }
            String requestId = saveAttempt[1];
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(false);
            IO.execute(() -> {
                try {
                    NativeApi.callRecords(path("notes"),"POST",new JSONObject().put("text",text).put("noteId",noteId).put("requestId",requestId),credential.bearer);
                    runOnUiThread(() -> { if (!isFinishing() && new NativeStore(this).matchesCredential(credential)) { dialog.dismiss(); refresh(); } });
                } catch (Exception error) { runOnUiThread(() -> { if (!isFinishing()) {
                    dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(true); input.setError(message(error));
                } }); }
            });
        }));
        dialog.show();
    }
    private void playPart(String recordingId, JSONArray parts, int index) {
        if (isFinishing() || index >= parts.length() || !new NativeStore(this).matchesCredential(credential)) { stopPlayback(); return; }
        try {
            long id = parts.getJSONObject(index).getLong("id"); if (id <= 0) throw new Exception("Invalid recording.");
            player = new MediaPlayer(); MediaPlayer current = player;
            current.setAudioAttributes(new android.media.AudioAttributes.Builder().setContentType(android.media.AudioAttributes.CONTENT_TYPE_SPEECH)
                .setUsage(android.media.AudioAttributes.USAGE_MEDIA).build());
            HashMap<String,String> headers = new HashMap<>(); headers.put("Authorization","Bearer " + credential.bearer);
            headers.put("X-SH-Native-Build",String.valueOf(BuildConfig.VERSION_CODE)); headers.put("X-SH-Media-Protocol",NativeRoomPolicy.PROTOCOL);
            current.setDataSource(this,Uri.parse(HubPolicy.API_BASE + path("recordings/" + recordingId + "/" + id)),headers);
            current.setOnPreparedListener(value -> { if (player == value && !isFinishing()) { value.start(); status.setText("Playing recording"); } });
            current.setOnCompletionListener(value -> { if (player == value) { value.release(); player = null; playPart(recordingId,parts,index+1); } });
            current.setOnErrorListener((value, what, extra) -> { stopPlayback(); status.setText("Could not play this recording. Try again."); return true; });
            current.prepareAsync(); status.setText("Loading recording…");
        } catch (Exception error) { stopPlayback(); status.setText("Could not play this recording. Try again."); }
    }
    private void stopPlayback() { if (player != null) { player.release(); player = null; } if (status != null) status.setText(""); }
    private static String date(long time) { return DateFormat.getDateTimeInstance(DateFormat.MEDIUM,DateFormat.SHORT).format(new Date(time)); }
    private static String message(Exception error) { return error instanceof NativeApi.ApiException && error.getMessage() != null ? error.getMessage() : "Call records are temporarily unavailable. Try again."; }
    @Override protected void onStop() { stopPlayback(); super.onStop(); }
    @Override protected void onDestroy() { generation++; stopPlayback(); super.onDestroy(); }
}
