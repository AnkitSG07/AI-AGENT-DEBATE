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
        if (value == null || maxCodePoints <= 0) return "";
        int end = Math.min(value.length(), 4096);
        if (end > 0 && end < value.length() && Character.isHighSurrogate(value.charAt(end - 1))) end--;
        // Android uses ICU for regexes; Java's embedded (?U) flag throws on
        // Android despite passing desktop JVM/Robolectric tests. Scan bounded
        // code points instead, preserving emoji joiners and Unicode text.
        StringBuilder text = new StringBuilder(Math.min(end, Math.min(maxCodePoints, 4096) * 2));
        boolean space = false; int count = 0;
        for (int index = 0; index < end; ) {
            int point = value.codePointAt(index); index += Character.charCount(point);
            if (Character.isWhitespace(point) || Character.isSpaceChar(point) || Character.isISOControl(point) ||
                point == 0x85 || point >= 0x202a && point <= 0x202e || point >= 0x2066 && point <= 0x2069 ||
                point >= 0xd800 && point <= 0xdfff) {
                space = text.length() > 0; continue;
            }
            if (space) { text.append(' '); count++; space = false; }
            text.appendCodePoint(point); count++;
            if (count > maxCodePoints) {
                text.setLength(text.offsetByCodePoints(0, maxCodePoints - 1));
                return text.append('…').toString();
            }
        }
        return text.toString();
    }
    /** Minimal fallback has no date/group formatting or regex dependency. */
    static MessageNotificationData fallback(Map<String, String> data, long now) {
        boolean supported = "sh-message-preview-v1".equals(data.get("preview_protocol"));
        String sender = supported ? clean(data.get("sender_name"), 80) : "";
        if (sender.isEmpty() && supported) sender = clean(data.get("conversation_name"), 80);
        String preview = supported ? clean(data.get("message_preview"), 400) : "";
        return new MessageNotificationData(sender.isEmpty() ? "Customer" : sender, "Customer",
            preview.isEmpty() ? "New message" : preview, false, now);
    }
    private static long number(String value, long fallback) { try { return Long.parseLong(value); } catch (Exception ignored) { return fallback; } }
}
