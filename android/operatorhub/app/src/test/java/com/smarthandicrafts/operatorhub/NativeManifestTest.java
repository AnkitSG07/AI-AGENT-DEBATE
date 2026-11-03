package com.smarthandicrafts.operatorhub;
import android.app.Application;
import android.content.pm.PackageManager;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;
@RunWith(RobolectricTestRunner.class) @Config(sdk=28, application=Application.class)
public class NativeManifestTest {
    @org.junit.Rule public OfflineNativeApiRule offlineApi = new OfflineNativeApiRule();
    @Test public void internalBroadcastPermissionIsDeclaredByMergedManifest() throws Exception {
        Application app = RuntimeEnvironment.getApplication();
        String permission = app.getPackageName() + ".DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION";
        android.content.pm.PackageInfo info = app.getPackageManager().getPackageInfo(app.getPackageName(), PackageManager.GET_PERMISSIONS);
        assertTrue(java.util.Arrays.toString(info.requestedPermissions), java.util.Arrays.asList(info.requestedPermissions).contains(permission));
        assertEquals("Internal receiver permission must be available: " + app.getPackageName(), PackageManager.PERMISSION_GRANTED, app.checkSelfPermission(permission));
    }
}
