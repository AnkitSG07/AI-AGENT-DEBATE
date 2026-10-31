package com.smarthandicrafts.operatorhub;

import java.net.URI;
import java.net.URLDecoder;
import java.util.HashMap;
import java.util.regex.Pattern;

/** Pure policy helpers: no network, Android context or credentials. */
public final class HubPolicy {
    public static final String ODOO_ORIGIN = "https://www.smarthandicrafts.com";
    public static final String HUB_URL = ODOO_ORIGIN + "/livechat-api-test";
    public static final String LOGIN_URL = ODOO_ORIGIN + "/web/login?redirect=%2Flivechat-api-test";
    // This URL is used only after an explicit "Use another account" tap.
    public static final String SWITCH_ACCOUNT_URL = ODOO_ORIGIN + "/web/session/logout?redirect=%2Fweb%2Flogin%3Fredirect%3D%252Flivechat-api-test";
    public static final String BACKEND_ORIGIN = "https://ai-agent-debate.onrender.com";
    public static final String API_BASE = BACKEND_ORIGIN + "/api/operator-android";
    private static final Pattern CALL_ID = Pattern.compile("[A-Za-z0-9_:.@+=/-]{1,240}");

    public static boolean trustedOdoo(String url) { return exactOrigin(url, "www.smarthandicrafts.com"); }
    public static boolean trustedHubPage(String url) {
        try { return trustedOdoo(url) && "/livechat-api-test".equals(new URI(url).getRawPath()); }
        catch (Exception ignored) { return false; }
    }
    public static boolean authPage(String url) {
        if (!trustedOdoo(url)) return false;
        try { return new URI(url).getRawPath().matches("/web/(?:login(?:/[^?#]*)?|reset_password|signup)/?"); }
        catch (Exception ignored) { return false; }
    }
    public static boolean postLoginLanding(String url) {
        if (!trustedOdoo(url)) return false;
        try {
            String path = new URI(url).getRawPath();
            return "/odoo".equals(path) || path.startsWith("/odoo/") || "/web".equals(path) || "/my".equals(path)
                || "/my/home".equals(path) || "/web/login_successful".equals(path);
        } catch (Exception ignored) { return false; }
    }
    public static boolean trustedDownload(String url) { return trustedOdoo(url) || exactOrigin(url, "ai-agent-debate.onrender.com"); }
    public static boolean sameDocumentFragment(String current, String next) {
        if (!trustedHubPage(current) || !trustedHubPage(next)) return false;
        try {
            URI target = new URI(next);
            return target.getRawFragment() != null && current.split("#", 2)[0].equals(next.split("#", 2)[0]);
        } catch (Exception ignored) { return false; }
    }
    private static boolean exactOrigin(String url, String host) {
        try {
            URI u = new URI(url);
            return "https".equalsIgnoreCase(u.getScheme()) && host.equalsIgnoreCase(u.getHost())
                && u.getRawUserInfo() == null && (u.getPort() == -1 || u.getPort() == 443);
        } catch (Exception ignored) { return false; }
    }
    public static boolean externalWeb(String url) {
        try { URI u = new URI(url); return "https".equalsIgnoreCase(u.getScheme()) && u.getHost() != null && u.getRawUserInfo() == null; }
        catch (Exception ignored) { return false; }
    }
    public static boolean validCallId(String id) { return id != null && CALL_ID.matcher(id).matches(); }
    public static boolean validCallHubUrl(String url, String callId) {
        if (!validCallId(callId) || !trustedOdoo(url)) return false;
        try {
            URI u = new URI(url);
            if (!"/livechat-api-test".equals(u.getRawPath()) || u.getRawFragment() != null || u.getRawQuery() == null) return false;
            HashMap<String, String> query = new HashMap<>();
            for (String part : u.getRawQuery().split("&")) {
                String[] pair = part.split("=", 2); if (pair.length != 2) return false;
                String key = URLDecoder.decode(pair[0], "UTF-8"), value = URLDecoder.decode(pair[1], "UTF-8");
                if (query.put(key, value) != null) return false;
            }
            return query.size() == 2 && "call".equals(query.get("mode")) && callId.equals(query.get("call_id"));
        } catch (Exception ignored) { return false; }
    }
    public static boolean freshIncoming(long issued, long expiry, long now) {
        return issued > 0 && issued <= now + 30000 && expiry > now && expiry > issued
            && expiry - issued <= 120000 && now - issued <= 120000;
    }
    public static boolean terminal(String state) {
        return state != null && (state.equals("ended") || state.equals("terminated") || state.equals("failed")
            || state.equals("rejected") || state.equals("declined") || state.equals("cancelled")
            || state.equals("canceled") || state.equals("completed") || state.equals("missed"));
    }
    public static String safeFilename(String name) {
        String cleaned = name == null ? "download" : name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (cleaned.isEmpty() || cleaned.equals(".") || cleaned.equals("..")) cleaned = "download";
        return cleaned.length() > 120 ? cleaned.substring(cleaned.length() - 120) : cleaned;
    }
    private HubPolicy() { }
}
