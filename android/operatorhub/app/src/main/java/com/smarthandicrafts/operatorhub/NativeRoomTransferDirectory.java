package com.smarthandicrafts.operatorhub;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Screen-local discovery only. A cached row never authorizes a transfer. */
final class NativeRoomTransferDirectory {
    static final long TTL_MS = 15000;
    static final class Entry {
        final String id, label;
        Entry(String id, String label) { this.id = id; this.label = label; }
    }
    private String binding = "";
    private long ticket, cachedAt;
    private boolean attempted, loading;
    private List<Entry> rows;

    void invalidate() { binding = ""; ticket++; attempted = false; loading = false; rows = null; }
    private void bind(String key) {
        if (!binding.equals(key)) { invalidate(); binding = key; }
    }
    List<Entry> cached(String key, long now) {
        if (!binding.equals(key) || rows == null || now < cachedAt || now - cachedAt >= TTL_MS) return null;
        return rows;
    }
    long begin(String key, long now, boolean explicit) {
        bind(key);
        if (loading || cached(key, now) != null || (!explicit && attempted)) return 0;
        attempted = true; loading = true;
        return ++ticket;
    }
    boolean complete(String key, long selectedTicket, List<Entry> result, long now) {
        if (!binding.equals(key) || selectedTicket != ticket || !loading) return false;
        rows = Collections.unmodifiableList(new ArrayList<>(result)); cachedAt = now; loading = false;
        return true;
    }
    boolean failed(String key, long selectedTicket) {
        if (!binding.equals(key) || selectedTicket != ticket || !loading) return false;
        loading = false; return true;
    }
}
