package com.smarthandicrafts.operatorhub;

/** One user-authorized call start across asynchronous checks, permission prompts and activity intents. */
public final class NativeRoomStartGate {
    public static final long NONE = -1L;
    private long generation, active = NONE, permissionTicket = NONE;
    private int permissionCode;

    public long begin() { active = ++generation; return active; }
    public boolean current(long ticket) { return ticket != NONE && ticket == active; }
    public void invalidate() { ++generation; active = NONE; }
    public void cancel(long ticket) { if (current(ticket)) invalidate(); }

    public boolean awaitPermission(long ticket, int requestCode) {
        // Android permits one prompt at a time. Keep an old prompt bound to its old ticket
        // until its result arrives; never overwrite it with a newer call's authorization.
        if (!current(ticket) || permissionTicket != NONE) return false;
        permissionTicket = ticket; permissionCode = requestCode; return true;
    }
    public long permissionResult(int requestCode) {
        if (permissionTicket == NONE || permissionCode != requestCode) return NONE;
        long ticket = permissionTicket; permissionTicket = NONE; permissionCode = 0;
        return current(ticket) ? ticket : NONE;
    }
    public boolean takeStart(long ticket) {
        if (!current(ticket)) return false;
        active = NONE; return true;
    }
}
