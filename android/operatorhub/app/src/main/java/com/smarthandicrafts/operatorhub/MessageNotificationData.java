package com.smarthandicrafts.operatorhub;

import java.util.Map;

/** Plain bounded preview data. Callers separately validate enrollment, routing and expiry. */
final class MessageNotificationData {
    final String sender, conversation, preview;
    final boolean group;
    final long at;
    private MessageNotificationData(String sender, String conversation, String preview, boolean group, long at) {
        this.sender = sender; this.conversation = conversation; this.preview = preview; this.group = group; this.at = at;
    }
    static MessageNotificationData from(Map<String, String> data, long now) {
        boolean supported = "sh-message-preview-v1".equals(data.get("preview_protocol"));
        String name = supported ? clean(data.get("sender_name"), 80) : "";
        String conversation = supported ? clean(data.get("conversation_name"), 80) : "";
        String preview = supported ? clean(data.get("message_preview"), 400) : "";
        long at = number(data.get("message_at_ms"), number(data.get("issued_at_ms"), now));
        if (at <= 0 || at > now + 30000 || now - at > 300000) at = now;
        return new MessageNotificationData(name.isEmpty() ? conversation.isEmpty() ? "Customer" : conversation : name,
            conversation.isEmpty() ? name.isEmpty() ? "Customer" : name : conversation,
            preview.isEmpty() ? "New message" : preview, supported && "true".equals(data.get("group_conversation")), at);
    }
    static String clean(String value, int maxCodePoints) {
        int end = value == null ? 0 : Math.min(value.length(), 4096);
        if (end > 0 && end < value.length() && Character.isHighSurrogate(value.charAt(end - 1))) end--;
        String text = value == null ? "" : value.substring(0, end)
            .replaceAll("[\\p{Cntrl}\\u202A-\\u202E\\u2066-\\u2069]", " ").replaceAll("(?U)\\s+", " ").trim();
        int count = text.codePointCount(0, text.length());
        return count <= maxCodePoints ? text : text.substring(0, text.offsetByCodePoints(0, maxCodePoints - 1)) + "…";
    }
    private static long number(String value, long fallback) { try { return Long.parseLong(value); } catch (Exception ignored) { return fallback; } }
}
