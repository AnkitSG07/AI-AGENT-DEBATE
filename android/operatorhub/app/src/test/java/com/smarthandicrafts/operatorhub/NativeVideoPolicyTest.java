package com.smarthandicrafts.operatorhub;
import android.app.Application;
import android.net.Uri;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;
@RunWith(RobolectricTestRunner.class) @Config(sdk=28, application=Application.class)
public class NativeVideoPolicyTest {
    @Test public void onlyExactServerOriginMayCaptureMediaIncludingItsNormalizedSlash() {
        assertTrue(NativeVideoCallActivity.sameOrigin(Uri.parse(NativeVideoCallActivity.ORIGIN)));
        assertTrue(NativeVideoCallActivity.sameOrigin(Uri.parse(NativeVideoCallActivity.ORIGIN + "/")));
        assertFalse(NativeVideoCallActivity.sameOrigin(Uri.parse("https://ai-agent-debate.onrender.com.attacker.invalid/")));
        assertFalse(NativeVideoCallActivity.sameOrigin(Uri.parse("http://ai-agent-debate.onrender.com/")));
        assertFalse(NativeVideoCallActivity.sameOrigin(Uri.parse("https://user@ai-agent-debate.onrender.com/")));
    }
    @Test public void onlyPrivateOperatorLinksCanOpenTheNativeVideoScreen() {
        String base = NativeVideoCallActivity.ORIGIN + "/video-call.html#" + "a".repeat(32);
        String operator = base + ".operator." + "b".repeat(32);
        assertTrue(NativeVideoCallActivity.validUrl(operator, "operator"));
        assertFalse(NativeVideoCallActivity.validUrl(base + ".customer." + "b".repeat(32), "operator"));
        assertFalse(NativeVideoCallActivity.validUrl(operator.replace("html#", "html?redirect=evil#"), "operator"));
        assertFalse(NativeVideoCallActivity.validUrl(operator + ".extra", "operator"));
    }
}
