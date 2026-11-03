package com.smarthandicrafts.operatorhub;

import java.io.IOException;
import java.lang.reflect.Field;
import org.junit.rules.TestRule;
import org.junit.runner.Description;
import org.junit.runners.model.Statement;

/** Unit tests may install in-memory connections, but never contact the backend. */
public final class OfflineNativeApiRule implements TestRule {
    private static void blockDefaultConnections() throws Exception {
        Field factory = NativeApi.class.getDeclaredField("connections");
        factory.setAccessible(true);
        factory.set(null, (NativeApi.ConnectionFactory) url -> {
            throw new IOException("Native API network access is disabled in unit tests");
        });
    }
    @Override public Statement apply(Statement test, Description description) {
        return new Statement() {
            @Override public void evaluate() throws Throwable {
                blockDefaultConnections();
                try { test.evaluate(); }
                // Background cleanup may outlive a test; leave the default
                // blocked instead of restoring a real HTTPS connection.
                finally { blockDefaultConnections(); }
            }
        };
    }
}
