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
    @Test public void shortCustomerLinkAndResumeIntentKeepTheExactOperatorSession() {
        android.content.Context app = org.robolectric.RuntimeEnvironment.getApplication();
        String operator = NativeVideoCallActivity.ORIGIN + "/video-call.html#" + "a".repeat(32) + ".operator." + "b".repeat(32);
        String customer = NativeVideoCallActivity.ORIGIN + "/v/" + "c".repeat(24);
        assertTrue(NativeVideoCallActivity.validUrl(customer, "customer"));
        assertFalse(NativeVideoCallActivity.validUrl(customer, "operator"));
        assertFalse(NativeVideoCallActivity.validUrl(customer + "?redirect=evil", "customer"));
        NativeVideoSession.begin(app, operator, customer, "Test customer", "video-request-001");
        try {
            assertTrue(NativeVideoSession.active());
            android.content.Intent resume = NativeVideoSession.open(app);
            assertEquals(operator, resume.getStringExtra("operator_url"));
            assertEquals(customer, resume.getStringExtra("customer_url"));
            assertTrue((resume.getFlags() & android.content.Intent.FLAG_ACTIVITY_NEW_TASK) != 0);
            assertFalse(NativeVideoSession.updateInvitation("stale-request", "sent"));
            assertTrue(NativeVideoSession.updateInvitation("video-request-001", "Invitation sent in chat"));
            assertEquals("Invitation sent in chat", NativeVideoSession.invitationStatus());
            assertFalse(NativeVideoSession.finish("old-video")); assertTrue(NativeVideoSession.active());
        } finally { NativeVideoSession.finish(operator); }
        assertFalse(NativeVideoSession.active());
    }
    @Test public void videoHasASeparateTaskSoOpeningSingleTaskChatCannotDestroyIt() throws Exception {
        android.content.Context app = org.robolectric.RuntimeEnvironment.getApplication();
        android.content.pm.ActivityInfo video = app.getPackageManager().getActivityInfo(new android.content.ComponentName(app, NativeVideoCallActivity.class), 0);
        android.content.pm.ActivityInfo main = app.getPackageManager().getActivityInfo(new android.content.ComponentName(app, MainActivity.class), 0);
        assertNotEquals(main.taskAffinity, video.taskAffinity);
        assertTrue(video.taskAffinity.endsWith(".video"));
        assertEquals(android.content.pm.ActivityInfo.LAUNCH_SINGLE_TASK, video.launchMode);
    }
}
