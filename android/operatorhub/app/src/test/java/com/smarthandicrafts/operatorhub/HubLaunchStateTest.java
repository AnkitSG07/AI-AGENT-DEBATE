package com.smarthandicrafts.operatorhub;

import org.junit.Test;
import static org.junit.Assert.*;

public class HubLaunchStateTest {
    @Test public void earlyHubReadyWaitsForFallbackScriptBeforeRevealingOrDispatching() {
        HubLaunchState state = new HubLaunchState();
        long page = state.navigation(HubPolicy.HUB_URL);
        state.hubReady(); state.finished();
        assertFalse(state.isPrepared());
        assertFalse(state.mayReveal(page, false, false));
        state.prepared(page);
        assertTrue(state.isPrepared());
        assertTrue(state.mayReveal(page, false, false));
    }

    @Test public void delayedScriptCallbackCannotPrepareAnotherNavigation() {
        HubLaunchState state = new HubLaunchState();
        long oldPage = state.navigation(HubPolicy.HUB_URL);
        long newPage = state.navigation(HubPolicy.LOGIN_URL); state.finished();
        state.prepared(oldPage);
        assertFalse(state.isPrepared());
        assertFalse(state.mayReveal(newPage, true, false));
        state.prepared(newPage);
        assertTrue(state.mayReveal(newPage, true, false));
    }

    @Test public void freshInstallRequiresFinishedAndStyledRealLogin() {
        HubLaunchState state = new HubLaunchState();
        long page = state.navigation(HubPolicy.LOGIN_URL);
        assertFalse(state.mayReveal(page, true, false));
        state.prepared(state.generation()); state.finished();
        assertFalse(state.mayReveal(page, false, false));
        assertTrue(state.mayReveal(page, true, false));
        assertTrue(state.isAuthFlow());
    }

    @Test public void loggedInRedirectWaitsForHubReadyAndPageFinish() {
        HubLaunchState state = new HubLaunchState();
        state.navigation(HubPolicy.LOGIN_URL);
        long hub = state.navigation(HubPolicy.HUB_URL);
        assertFalse(state.mayReveal(hub, false, false));
        state.hubReady();
        assertFalse(state.mayReveal(hub, false, false));
        state.prepared(state.generation()); state.finished();
        assertTrue(state.mayReveal(hub, false, false));
        assertFalse(state.isAuthFlow());
    }

    @Test public void hubFinishedBeforeReadyStaysBehindNativeCover() {
        HubLaunchState state = new HubLaunchState();
        long page = state.navigation(HubPolicy.HUB_URL);
        state.prepared(state.generation()); state.finished();
        assertFalse(state.mayReveal(page, false, false));
        state.hubReady();
        assertTrue(state.mayReveal(page, false, false));
    }

    @Test public void visualCallbackForPreviousPageCannotRevealNewPage() {
        HubLaunchState state = new HubLaunchState();
        long oldPage = state.navigation(HubPolicy.LOGIN_URL);
        state.prepared(state.generation()); state.finished();
        long currentPage = state.navigation(HubPolicy.ODOO_ORIGIN + "/web/login/totp");
        state.prepared(state.generation()); state.finished();
        assertFalse(state.mayReveal(oldPage, true, false));
        assertTrue(state.mayReveal(currentPage, true, false));
        assertFalse(state.current(HubPolicy.LOGIN_URL));
        assertTrue(state.current(HubPolicy.ODOO_ORIGIN + "/web/login/totp"));
    }

    @Test public void deniedAccountDoesNotRepeatLoginForever() {
        HubLaunchState state = new HubLaunchState();
        state.navigation(HubPolicy.LOGIN_URL);
        long page = state.navigation(HubPolicy.HUB_URL);
        state.failed(); state.prepared(state.generation()); state.finished(); state.hubReady();
        assertFalse(state.recoverAuthenticationOnce());
        assertFalse(state.mayReveal(page, false, true));
        assertTrue(state.isAuthFlow());
    }

    @Test public void expiredSuccessfulSessionGetsOneAutomaticRecovery() {
        HubLaunchState state = new HubLaunchState();
        state.navigation(HubPolicy.HUB_URL); state.prepared(state.generation()); state.finished(); state.hubReady();
        assertTrue(state.recoverAuthenticationOnce());
        assertFalse(state.recoverAuthenticationOnce());
        state.navigation(HubPolicy.LOGIN_URL);
        state.navigation(HubPolicy.HUB_URL); state.failed();
        assertFalse(state.recoverAuthenticationOnce());
    }

    @Test public void normalOdooWorkIsPreservedAfterHubReady() {
        HubLaunchState state = new HubLaunchState();
        assertTrue(state.shouldReturnToHub(HubPolicy.ODOO_ORIGIN + "/odoo/discuss"));
        assertTrue(state.shouldReturnToHub(HubPolicy.ODOO_ORIGIN + "/my/home"));
        assertFalse(state.shouldReturnToHub(HubPolicy.ODOO_ORIGIN + "/web/login/totp"));
        state.navigation(HubPolicy.HUB_URL); state.prepared(state.generation()); state.finished(); state.hubReady();
        assertFalse(state.shouldReturnToHub(HubPolicy.ODOO_ORIGIN + "/odoo/sales/42"));
        long sale = state.navigation(HubPolicy.ODOO_ORIGIN + "/odoo/sales/42"); state.prepared(state.generation()); state.finished();
        assertTrue(state.mayReveal(sale, false, false));
    }

    @Test public void onlyTrustedHubCanCompleteAuthenticationGate() {
        HubLaunchState state = new HubLaunchState();
        long auth = state.navigation(HubPolicy.LOGIN_URL); state.prepared(state.generation()); state.finished(); state.hubReady();
        assertTrue(state.isAuthFlow());
        assertFalse(state.mayReveal(auth, false, false));
        long external = state.navigation("https://www.smarthandicrafts.com.evil.test/livechat-api-test");
        state.prepared(state.generation()); state.finished(); state.hubReady();
        assertTrue(state.isAuthFlow());
        assertFalse(state.mayReveal(external, true, true));
    }

    @Test public void oldWebviewCanRevealAVisibleHubOnlyAfterPageFinish() {
        HubLaunchState state = new HubLaunchState();
        long page = state.navigation(HubPolicy.HUB_URL);
        assertFalse(state.mayReveal(page, false, true));
        state.prepared(state.generation()); state.finished(); assertTrue(state.mayReveal(page, false, true));
        state.failed(); assertFalse(state.mayReveal(page, false, true));
    }

    @Test public void confirmedVisualFallbackEndsLoginRoutingWithoutInventingABridge() {
        HubLaunchState state = new HubLaunchState();
        long page = state.navigation(HubPolicy.HUB_URL); state.prepared(state.generation()); state.finished();
        assertTrue(state.mayReveal(page, false, true));
        state.hubReady();
        assertFalse(state.shouldReturnToHub(HubPolicy.ODOO_ORIGIN + "/odoo/sales/42"));
    }
}
