package com.smarthandicrafts.operatorhub;
import org.junit.Test;
import static org.junit.Assert.*;

public class HubPolicyTest {
    @Test public void authRoutesPreserveOdooLoginVerificationAndRecoveryOnlyOnExactOrigin() {
        assertTrue(HubPolicy.authPage(HubPolicy.LOGIN_URL));
        assertTrue(HubPolicy.authPage(HubPolicy.ODOO_ORIGIN + "/web/login/totp?redirect=%2Flivechat-api-test"));
        assertTrue(HubPolicy.authPage(HubPolicy.ODOO_ORIGIN + "/web/reset_password?token=synthetic"));
        assertTrue(HubPolicy.authPage(HubPolicy.ODOO_ORIGIN + "/web/signup/"));
        assertFalse(HubPolicy.authPage(HubPolicy.HUB_URL));
        assertFalse(HubPolicy.authPage(HubPolicy.ODOO_ORIGIN + "/web/login-spoof"));
        assertFalse(HubPolicy.authPage(HubPolicy.ODOO_ORIGIN + "/web%2Flogin"));
        assertFalse(HubPolicy.authPage("https://www.smarthandicrafts.com.evil.test/web/login"));
        assertFalse(HubPolicy.authPage("http://www.smarthandicrafts.com/web/login"));
        assertFalse(HubPolicy.authPage("https://fake@www.smarthandicrafts.com/web/login"));
    }
    @Test public void loginLandingRulesCannotReturnUntrustedOriginsOrInterruptVerification() {
        assertTrue(HubPolicy.postLoginLanding(HubPolicy.ODOO_ORIGIN + "/odoo"));
        assertTrue(HubPolicy.postLoginLanding(HubPolicy.ODOO_ORIGIN + "/odoo/discuss"));
        assertTrue(HubPolicy.postLoginLanding(HubPolicy.ODOO_ORIGIN + "/web#action=42"));
        assertFalse(HubPolicy.postLoginLanding(HubPolicy.ODOO_ORIGIN + "/web/login/totp"));
        assertFalse(HubPolicy.postLoginLanding(HubPolicy.ODOO_ORIGIN + "/web/reset_password"));
        assertFalse(HubPolicy.postLoginLanding("https://evil.test/odoo"));
    }
    @Test public void activeAudioMayChangeOnlyAHubFragmentWithoutUnloadingTheDocument() {
        assertTrue(HubPolicy.sameDocumentFragment(HubPolicy.HUB_URL, HubPolicy.HUB_URL + "#chat"));
        assertTrue(HubPolicy.sameDocumentFragment(HubPolicy.HUB_URL + "#call", HubPolicy.HUB_URL + "#chat"));
        assertFalse(HubPolicy.sameDocumentFragment(HubPolicy.HUB_URL, HubPolicy.HUB_URL));
        assertFalse(HubPolicy.sameDocumentFragment(HubPolicy.HUB_URL, HubPolicy.HUB_URL + "?reload=1#chat"));
        assertFalse(HubPolicy.sameDocumentFragment(HubPolicy.HUB_URL, HubPolicy.ODOO_ORIGIN + "/odoo/sales/42"));
        assertFalse(HubPolicy.sameDocumentFragment(HubPolicy.HUB_URL, "https://evil.test/livechat-api-test#chat"));
    }
    @Test public void originRejectsLookalikesCredentialsAndPorts() {
        assertTrue(HubPolicy.trustedOdoo(HubPolicy.HUB_URL));
        assertTrue(HubPolicy.trustedOdoo("https://www.smarthandicrafts.com:443/web/login"));
        assertFalse(HubPolicy.trustedOdoo("https://www.smarthandicrafts.com.evil.test/livechat-api-test"));
        assertFalse(HubPolicy.trustedOdoo("https://evil@www.smarthandicrafts.com/"));
        assertFalse(HubPolicy.trustedOdoo("http://www.smarthandicrafts.com/"));
        assertFalse(HubPolicy.trustedOdoo("https://www.smarthandicrafts.com:444/"));
        assertFalse(HubPolicy.trustedOdoo("file:///etc/passwd"));
        assertTrue(HubPolicy.trustedHubPage(HubPolicy.HUB_URL + "?channel_id=123"));
        assertFalse(HubPolicy.trustedHubPage("https://www.smarthandicrafts.com/web/login"));
    }
    @Test public void unsafeExternalSchemesCannotLaunch() {
        assertFalse(HubPolicy.externalWeb("javascript:alert(1)"));
        assertFalse(HubPolicy.externalWeb("intent://evil"));
        assertFalse(HubPolicy.externalWeb("content://evil"));
        assertTrue(HubPolicy.externalWeb("https://www.example.com/help"));
    }
    @Test public void backendCallDeepLinkMatchesExactCall() {
        String id = "wacid.HBgM123/abc+xyz=";
        String encoded = "wacid.HBgM123%2Fabc%2Bxyz%3D";
        String actualBackendUrl = HubPolicy.HUB_URL + "?mode=call&call_id=" + encoded;
        assertTrue(HubPolicy.validCallHubUrl(actualBackendUrl, id));
        assertTrue(HubPolicy.validCallHubUrl(HubPolicy.HUB_URL + "?call_id=" + encoded + "&mode=call", id));
        assertFalse(HubPolicy.validCallHubUrl(actualBackendUrl, "another-call"));
        assertFalse(HubPolicy.validCallHubUrl(actualBackendUrl + "&action=accept", id));
        assertFalse(HubPolicy.validCallHubUrl(actualBackendUrl + "&call_id=other", id));
        assertFalse(HubPolicy.validCallHubUrl(actualBackendUrl + "#other", id));
        assertFalse(HubPolicy.validCallHubUrl("https://evil.test/livechat-api-test?mode=call&call_id=" + encoded, id));
    }
    @Test public void pushesCannotRingLateOrFarInFuture() {
        long now = 1700000000000L;
        assertTrue(HubPolicy.freshIncoming(now - 1000, now + 45000, now));
        assertFalse(HubPolicy.freshIncoming(now - 120000, now - 1, now));
        assertFalse(HubPolicy.freshIncoming(now + 60000, now + 90000, now));
        assertFalse(HubPolicy.freshIncoming(now, now + 3600000, now));
    }
    @Test public void callAndDownloadNamesCannotInjectPaths() {
        assertTrue(HubPolicy.validCallId("wacid.HBgM123/abc+xyz="));
        assertFalse(HubPolicy.validCallId("<script>"));
        assertFalse(HubPolicy.validCallId("call\nHeader: injected"));
        assertEquals(".._.._secret.pdf", HubPolicy.safeFilename("../../secret.pdf"));
    }
}
