# Install SH Chat R20 after the Firebase move

1. Install `SH-Chat-1.0-r20.apk` over the existing SH Chat app on every operator phone.
2. Open **App settings** and tap **Check background alerts**. If the Firebase project-change notice appears, close and reopen SH Chat, then return to App settings.
3. Enter a fresh administrator enrollment code and tap **Enable background alerts**. Confirm that the device is enrolled, notifications are allowed and native calls are enabled by the server.
4. Tap **Send Firebase test notification**, then test a real incoming message and call on that phone. Verify the sender/message preview, exact chat opening, audible call connection and hang-up from both ends.

The new Firebase project needs new phone notification tokens. The old project's token cannot receive notifications sent by the new project. Your Odoo login remains separate.

Version: `1.0-r20` (20). Package: `com.smarthandicrafts.operatorhub`.

APK SHA-256: `e3b86f30011032e7abd6902c85ea97da3cc8c6a4840a29d187ec988563aa14a6`.

The APK uses the existing release signing key and supplied app logo. Automated checks do not certify real-phone delivery or a fixed call latency.
