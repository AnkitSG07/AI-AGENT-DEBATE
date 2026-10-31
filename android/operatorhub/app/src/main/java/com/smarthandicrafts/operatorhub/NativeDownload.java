package com.smarthandicrafts.operatorhub;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Environment;
import android.webkit.URLUtil;
import android.widget.Toast;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.URL;
import javax.net.ssl.HttpsURLConnection;

/** Follows only validated same-origin redirects; Odoo cookies cannot leak to a redirect target. */
public final class NativeDownload {
    public static void download(Activity activity, String url, String cookie, String ua, String disposition, String mime) {
        Toast.makeText(activity, "Downloading…", Toast.LENGTH_SHORT).show();
        HubApplication.IO.execute(() -> {
            HttpsURLConnection conn = null; File output = null;
            try {
                URL current = new URL(url); String origin = current.getProtocol() + "://" + current.getAuthority();
                for (int n = 0; n < 5; n++) {
                    if (!HubPolicy.trustedDownload(current.toString()) || !(current.getProtocol() + "://" + current.getAuthority()).equals(origin)) throw new Exception("Download redirected to another site. Open the link in your browser.");
                    conn = (HttpsURLConnection) current.openConnection(); conn.setConnectTimeout(15000); conn.setReadTimeout(30000); conn.setInstanceFollowRedirects(false);
                    conn.setRequestProperty("User-Agent", ua);
                    if (cookie != null && HubPolicy.trustedOdoo(current.toString())) conn.setRequestProperty("Cookie", cookie);
                    int status = conn.getResponseCode();
                    if (status >= 300 && status < 400) { String location = conn.getHeaderField("Location"); conn.disconnect(); conn = null; if (location == null) throw new Exception("Download redirect was incomplete."); current = new URL(current, location); continue; }
                    if (status != 200) throw new Exception("Download was not available. Sign in to Odoo and try again.");
                    break;
                }
                if (conn == null || conn.getResponseCode() != 200) throw new Exception("Too many download redirects.");
                if (conn.getContentLengthLong() > 100L * 1024 * 1024) throw new Exception("This file is over 100 MB. Download it in your browser.");
                String type = conn.getContentType(); if (type == null) type = mime; if (type == null) type = "application/octet-stream";
                String name = HubPolicy.safeFilename(URLUtil.guessFileName(url, disposition, type));
                File dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS); if (dir == null) throw new Exception("Download storage unavailable."); dir.mkdirs();
                output = new File(dir, System.currentTimeMillis() + "-" + name);
                try (InputStream in = conn.getInputStream(); FileOutputStream out = new FileOutputStream(output)) {
                    byte[] bytes = new byte[8192]; long total = 0; int count;
                    while ((count = in.read(bytes)) != -1) { total += count; if (total > 100L * 1024 * 1024) throw new Exception("File exceeds the in-app download limit."); out.write(bytes, 0, count); }
                }
                File finished = output; String actualType = type.split(";", 2)[0];
                activity.runOnUiThread(() -> {
                    if (activity.isFinishing()) return;
                    Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".files", finished);
                    Intent view = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, actualType).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    try { activity.startActivity(Intent.createChooser(view, "Open downloaded file")); }
                    catch (Exception ignored) { Toast.makeText(activity, "File downloaded. No app can open this file type.", Toast.LENGTH_LONG).show(); }
                });
            } catch (Exception e) {
                if (output != null) output.delete(); activity.runOnUiThread(() -> Toast.makeText(activity, e.getMessage(), Toast.LENGTH_LONG).show());
            } finally { if (conn != null) conn.disconnect(); }
        });
    }
    private NativeDownload() { }
}
