package com.smarthandicrafts.operatorhub;

import java.util.HashMap;
import java.util.Map;
import org.junit.Test;
import static org.junit.Assert.*;

public class MessageNotificationDataTest {
    @Test public void unicodeAndEmojiStayReadableWithinBoundedPreviews() {
        String text = MessageNotificationData.clean("नमस्ते 👋 " + "😀".repeat(500), 80);
        assertTrue(text.startsWith("नमस्ते 👋")); assertEquals(80, text.codePointCount(0, text.length()));
        assertTrue(text.endsWith("…")); assertFalse(Character.isHighSurrogate(text.charAt(text.length() - 2)));
    }
    @Test public void hiddenControlsAndWhitespaceCannotSpoofSenderLayout() {
        assertEquals("Ankit Garia test", MessageNotificationData.clean(" Ankit\nGaria\u202e\u0000test ", 80));
    }
    @Test public void unicodeSpaceSeparatorsAndC1ControlsCollapseWithoutRegexFlags() {
        assertEquals("Ankit Garia test", MessageNotificationData.clean("\u00a0Ankit\u0085\u2007Garia\u202f\u2066test\u2069 ", 80));
        assertEquals("👨‍👩‍👧‍👦 नमस्ते", MessageNotificationData.clean("👨‍👩‍👧‍👦\u3000नमस्ते", 80));
        assertEquals("a b", MessageNotificationData.clean("a\ud800b", 80));
    }
    @Test public void emptyLimitsAndInputBoundsNeverSplitSurrogatePairs() {
        assertEquals("", MessageNotificationData.clean("anything", 0));
        assertEquals("…", MessageNotificationData.clean("😀😀", 1));
        assertEquals("a…", MessageNotificationData.clean("a b", 2));
        String value = MessageNotificationData.clean("x".repeat(4095) + "😀tail", 5000);
        assertEquals(4095, value.length()); assertTrue(value.chars().allMatch(c -> c == 'x'));
    }
    @Test public void malformedDatesFallBackToNowAndUnversionedTextIsNotUsed() {
        Map<String, String> data = new HashMap<>(); data.put("sender_name", "Ignored"); data.put("message_preview", "Ignored");
        data.put("message_at_ms", "not-a-date");
        MessageNotificationData result = MessageNotificationData.from(data, 1000000);
        assertEquals("Customer", result.sender); assertEquals("New message", result.preview); assertEquals(1000000, result.at);
        data.put("preview_protocol", "sh-message-preview-v1"); data.put("conversation_name", "Ankit"); data.put("sender_name", "");
        data.put("message_at_ms", "2000000"); result = MessageNotificationData.from(data, 1000000);
        assertEquals("Ankit", result.sender); assertEquals(1000000, result.at);
    }
}
