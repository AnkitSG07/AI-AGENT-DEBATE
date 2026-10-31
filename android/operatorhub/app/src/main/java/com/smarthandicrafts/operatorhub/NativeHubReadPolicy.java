package com.smarthandicrafts.operatorhub;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Arrays;
import java.util.Set;

/** Only call-history JSON can cross from the enrolled native device to the Hub.
 * Media, credentials, arbitrary URLs and all legacy call mutations are excluded. */
public final class NativeHubReadPolicy {
    private static final String PREFIX = "/api/whatsapp-calls/";
    public static boolean validRequestId(String id) {
        return id != null && id.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}");
    }
    public static boolean allowedPath(String value) {
        if (value == null || value.length() > 1500 || !value.startsWith(PREFIX)) return false;
        try {
            URI uri = new URI(value);
            if (uri.isAbsolute() || uri.getRawAuthority() != null || uri.getRawFragment() != null) return false;
            String tail = uri.getRawPath().substring(PREFIX.length());
            if (tail.isEmpty() || tail.contains("/") || tail.contains("\\")) return false;
            boolean config = tail.equals("config"), logs = tail.equals("logs"), recent = tail.equals("recent"), incoming = tail.equals("incoming");
            if (!config && !logs && !recent && !incoming) {
                if (Arrays.asList("events", "diagnostics", "test", "accept", "reject", "terminate", "outgoing", "note", "cancel-pending-outgoing").contains(tail)) return false;
                String id = URLDecoder.decode(tail, StandardCharsets.UTF_8.name());
                if (!HubPolicy.validCallId(id) || id.contains("..")) return false;
            }
            String query = uri.getRawQuery();
            if (query == null || query.isEmpty()) return true;
            if (config) return false;
            Set<String> seen = new HashSet<>();
            for (String part : query.split("&", -1)) {
                String[] pair = part.split("=", 2);
                if (pair.length != 2) return false;
                String key = URLDecoder.decode(pair[0], StandardCharsets.UTF_8.name());
                String val = URLDecoder.decode(pair[1], StandardCharsets.UTF_8.name());
                if (!seen.add(key)) return false;
                if ("operator_device_id".equals(key)) {
                    if (!val.matches("[A-Za-z0-9_:.-]{1,160}")) return false;
                } else if (logs && "limit".equals(key)) {
                    if (!val.matches("[0-9]{1,3}") || Integer.parseInt(val) < 1 || Integer.parseInt(val) > 200) return false;
                } else if (logs && "phone".equals(key)) {
                    if (!val.matches("\\+?[1-9][0-9]{6,14}")) return false;
                } else if (recent && "live".equals(key)) {
                    if (!val.equals("0") && !val.equals("1")) return false;
                } else if (recent && "since_ms".equals(key)) {
                    if (!val.matches("[0-9]{1,16}") || Long.parseLong(val) > 9007199254740991L) return false;
                } else return false;
            }
            return true;
        } catch (Exception error) { return false; }
    }
    private NativeHubReadPolicy() { }
}
