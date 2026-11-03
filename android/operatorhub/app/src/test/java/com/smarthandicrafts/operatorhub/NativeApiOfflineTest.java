package com.smarthandicrafts.operatorhub;

import android.app.Application;
import java.io.IOException;
import org.junit.Rule;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=28, application=Application.class)
public class NativeApiOfflineTest {
    @Rule public final OfflineNativeApiRule offlineApi = new OfflineNativeApiRule();
    @Test public void unstubbedControlRequestFailsBeforeAnyConnectionIsOpened() throws Exception {
        try { NativeApi.controlRequest("/calls/test-only/end", "POST", null, "synthetic-not-enrolled"); fail(); }
        catch (IOException expected) { assertTrue(expected.getMessage().contains("disabled in unit tests")); }
    }
    @Test public void unstubbedBackgroundRequestAlsoCannotReachTheBackend() throws Exception {
        try { NativeApi.request("/devices", "GET", null, "synthetic-not-enrolled"); fail(); }
        catch (IOException expected) { assertTrue(expected.getMessage().contains("disabled in unit tests")); }
    }
}
