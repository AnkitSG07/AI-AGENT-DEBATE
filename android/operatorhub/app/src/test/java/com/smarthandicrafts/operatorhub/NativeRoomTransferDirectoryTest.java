package com.smarthandicrafts.operatorhub;

import org.junit.Test;
import java.util.Collections;
import static org.junit.Assert.*;

public class NativeRoomTransferDirectoryTest {
    private final NativeRoomTransferDirectory directory = new NativeRoomTransferDirectory();
    @Test public void prefetchAndRepeatedPickerTapsShareOneRequestAndFreshResult() {
        long ticket = directory.begin("call-a:leg-a:credential-a", 100, false);
        assertTrue(ticket > 0);
        assertEquals(0, directory.begin("call-a:leg-a:credential-a", 101, true));
        assertTrue(directory.complete("call-a:leg-a:credential-a", ticket,
            Collections.singletonList(new NativeRoomTransferDirectory.Entry("target", "Phone")), 110));
        assertEquals(0, directory.begin("call-a:leg-a:credential-a", 111, true));
        assertEquals("target", directory.cached("call-a:leg-a:credential-a", 111).get(0).id);
    }
    @Test public void rendersNeverCreatePeriodicPollingAfterCacheExpires() {
        long ticket = directory.begin("call", 100, false);
        directory.complete("call", ticket, Collections.emptyList(), 100);
        assertNull(directory.cached("call", 15100));
        for (int i = 0; i < 100; i++) assertEquals(0, directory.begin("call", 15100 + i * 1000, false));
        assertTrue(directory.begin("call", 200000, true) > 0);
    }
    @Test public void failedPrefetchCanBeRetriedByExplicitTap() {
        long ticket = directory.begin("call", 100, false);
        assertTrue(directory.failed("call", ticket));
        assertEquals(0, directory.begin("call", 101, false));
        assertTrue(directory.begin("call", 102, true) > ticket);
    }
    @Test public void callOwnerAndCredentialChangesRejectOldResults() {
        long old = directory.begin("call:old-owner:old-credential", 100, false);
        long fresh = directory.begin("call:new-owner:new-credential", 101, false);
        assertFalse(directory.complete("call:old-owner:old-credential", old, Collections.emptyList(), 102));
        assertFalse(directory.failed("call:old-owner:old-credential", old));
        assertTrue(directory.complete("call:new-owner:new-credential", fresh, Collections.emptyList(), 103));
        assertNull(directory.cached("call:old-owner:old-credential", 104));
    }
    @Test public void endInvalidatesAnInflightDirectoryAndEmptySuccessHasBoundedLifetime() {
        long ticket = directory.begin("call", 100, false); directory.invalidate();
        assertFalse(directory.complete("call", ticket, Collections.emptyList(), 101));
        ticket = directory.begin("next-call", 102, false);
        directory.complete("next-call", ticket, Collections.emptyList(), 103);
        assertNotNull(directory.cached("next-call", 104));
        assertNull(directory.cached("next-call", 15103));
    }
}
