package com.smarthandicrafts.operatorhub;

/** Small, credential-free navigation gate. Odoo remains responsible for authentication. */
public final class HubLaunchState {
    private long generation;
    private boolean finished, failed, ready, prepared, authFlow = true, authAttempted = true;
    private String currentUrl = "";

    public long navigation(String url) {
        generation++;
        currentUrl = url == null ? "" : url;
        finished = false; failed = false; ready = false; prepared = false;
        if (HubPolicy.authPage(currentUrl)) { authFlow = true; authAttempted = true; }
        return generation;
    }
    public long generation() { return generation; }
    public boolean current(String url) { return currentUrl.equals(url); }
    public void prepared(long expectedGeneration) { if (generation == expectedGeneration) prepared = true; }
    public boolean isPrepared() { return prepared; }
    public void finished() { finished = true; }
    public void failed() { failed = true; }
    public void hubReady() {
        if (failed || !HubPolicy.trustedHubPage(currentUrl)) return;
        ready = true; authFlow = false; authAttempted = false;
    }
    public boolean isAuthFlow() { return authFlow; }
    public void requestAuthentication() { authFlow = true; authAttempted = true; }
    public boolean recoverAuthenticationOnce() {
        if (authAttempted) return false;
        requestAuthentication();
        return true;
    }
    public boolean shouldReturnToHub(String url) { return authFlow && HubPolicy.postLoginLanding(url); }
    public boolean mayReveal(long expectedGeneration, boolean styledAuth, boolean visibleHubFallback) {
        if (generation != expectedGeneration || !prepared || !finished || failed || !HubPolicy.trustedOdoo(currentUrl)) return false;
        if (HubPolicy.authPage(currentUrl)) return styledAuth;
        if (HubPolicy.trustedHubPage(currentUrl)) return ready || visibleHubFallback;
        return !authFlow;
    }
}
