package com.smarthandicrafts.operatorhub;

import android.content.Context;
import android.graphics.Bitmap;
import android.util.Base64;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/** Presentation only. Does not read, copy, submit or store authentication field values. */
public final class HubPageStyle {
    public static String script(Context context) throws IOException {
        ByteArrayOutputStream png = new ByteArrayOutputStream();
        NativeBrand.logo(context).compress(Bitmap.CompressFormat.PNG, 100, png);
        String logo = "data:image/png;base64," + Base64.encodeToString(png.toByteArray(), Base64.NO_WRAP);
        return asset(context, "sh-startup.js")
            .replace("__SH_AUTH_CSS__", JSONObject.quote(asset(context, "sh-auth.css")))
            .replace("__SH_BRAND_LOGO__", JSONObject.quote(logo))
            + "\n" + asset(context, "sh-native-hub-read.js")
            + "\n" + asset(context, "sh-native-room-bridge.js")
            + "\n" + asset(context, "sh-call-transfer-guard.js");
    }
    private static String asset(Context context, String name) throws IOException {
        try (InputStream in = context.getAssets().open(name); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096]; int count;
            while ((count = in.read(buffer)) != -1) bytes.write(buffer, 0, count);
            return bytes.toString(StandardCharsets.UTF_8.name());
        }
    }
    public static final String SNAPSHOT = "(function(){if(window.top!==window||location.origin!=='https://www.smarthandicrafts.com')return {};" +
        "var root=document.documentElement,layout=document.getElementById('shAppLayout');return {" +
        "styledAuth:root.classList.contains('sh-native-auth')&&!!document.getElementById('sh-native-auth-css')&&!!document.querySelector('main')," +
        "visibleHub:!!document.getElementById('shOperatorApp')&&!!layout&&!layout.classList.contains('is-hidden')&&layout.getBoundingClientRect().height>80," +
        "hubError:!!document.querySelector('#shAuthState .sh-op-auth-error')};})()";
    private HubPageStyle() { }
}
