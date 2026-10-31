package com.smarthandicrafts.operatorhub;

import org.json.JSONObject;

/** Android's JSON null must never become the literal call/device identity "null". */
final class NativeRoomJson {
    static String text(JSONObject object, String key) {
        if (object == null || object.isNull(key)) return "";
        Object value = object.opt(key); return value instanceof String ? (String)value : "";
    }
    static String text(JSONObject object, String key, String fallback) {
        String value = text(object,key); return value.isEmpty() ? fallback : value;
    }
    private NativeRoomJson() { }
}
