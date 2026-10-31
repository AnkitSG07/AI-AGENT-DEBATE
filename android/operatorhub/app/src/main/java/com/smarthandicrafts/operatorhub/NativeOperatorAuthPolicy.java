package com.smarthandicrafts.operatorhub;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/** The separate Render profile may authorize integrations; a device enrollment never does. */
final class NativeOperatorAuthPolicy {
    static final String ORIGIN = "https://ai-agent-debate.onrender.com";
    private static URI parse(String value) {
        if (value == null || value.length() > 2048 || value.indexOf('\\') >= 0 || value.matches(".*[\\x00-\\x20\\x7f].*")) return null;
        try {
            URI uri = new URI(value);
            if (!"https".equals(uri.getScheme()) || !"ai-agent-debate.onrender.com".equals(uri.getHost()) ||
                uri.getRawUserInfo() != null || uri.getPort() != -1 || uri.getRawFragment() != null) return null;
            return uri;
        } catch (Exception ignored) { return null; }
    }
    static boolean allowedPage(String value) {
        URI uri = parse(value);
        if (uri == null || !("/operator-auth".equals(uri.getRawPath()) || "/operator-auth.html".equals(uri.getRawPath()))) return false;
        String query = uri.getRawQuery();
        if (query == null) return false;
        Map<String,String> fields = new HashMap<>();
        try {
            for (String part : query.split("&", -1)) {
                String[] pair = part.split("=", 2);
                if (pair.length != 2 || !("origin".equals(pair[0]) || "state".equals(pair[0])) || fields.containsKey(pair[0])) return false;
                fields.put(pair[0], URLDecoder.decode(pair[1], StandardCharsets.UTF_8.name()));
            }
        } catch (Exception ignored) { return false; }
        return fields.size() == 2 && HubPolicy.ODOO_ORIGIN.equals(fields.get("origin")) &&
            fields.getOrDefault("state", "").matches("[A-Za-z0-9_-]{32,128}");
    }
    static boolean allowedResource(String value, String method, boolean mainFrame) {
        if (mainFrame) return "GET".equals(method) && allowedPage(value);
        URI uri = parse(value);
        if (uri == null || uri.getRawQuery() != null) return false;
        return "POST".equals(method) && ("/api/profile-login".equals(uri.getRawPath()) ||
            "/api/operator-browser-auth/token".equals(uri.getRawPath()));
    }
    /** Only a document-specific signed share link may leave the Hub for this origin. */
    static boolean allowedDocumentLink(String value) {
        URI uri = parse(value);
        return uri != null && uri.getRawPath().matches("/api/odoo-documents/(view|download)/[1-9][0-9]{0,15}") &&
            uri.getRawQuery() != null && uri.getRawQuery().matches("share=shd1\\.[A-Za-z0-9_-]{1,1000}\\.[A-Za-z0-9_-]{43}");
    }
    private NativeOperatorAuthPolicy() { }
}
