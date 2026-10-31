#!/usr/bin/env bash
set -euo pipefail

# Runs only the separately signed .simulation application on an Android emulator.
# Start a dedicated API35 AOSP AVD first; never point this at an operator's phone.
cd "$(dirname "$0")"
: "${ANDROID_SDK_ROOT:=${ANDROID_HOME:-}}"
if [ -z "$ANDROID_SDK_ROOT" ]; then
  echo 'Set ANDROID_SDK_ROOT to an installed Android SDK.' >&2
  exit 2
fi
sim_adb="$ANDROID_SDK_ROOT/platform-tools/adb"
sim_serial="${SH_SIMULATOR_SERIAL:-emulator-5556}"
sim_package='com.smarthandicrafts.operatorhub.simulation'
sim_runner='com.smarthandicrafts.operatorhub.simulation.test/androidx.test.runner.AndroidJUnitRunner'
sim_output="${SH_SIMULATOR_REPORT_DIR:-build/reports/system-simulation}"
mkdir -p "$sim_output"

sim_qemu="$("$sim_adb" -s "$sim_serial" shell getprop ro.kernel.qemu | tr -d '\r')"
sim_sdk="$("$sim_adb" -s "$sim_serial" shell getprop ro.build.version.sdk | tr -d '\r')"
if [ "$sim_qemu" != '1' ] || [ "$sim_sdk" != '35' ]; then
  echo 'This harness requires a dedicated Android15/API35 emulator; refusing another device.' >&2
  exit 2
fi

if [ "${SH_SIMULATOR_SKIP_BUILD:-0}" != '1' ]; then
  bash gradlew --no-daemon --console=plain --max-workers=2 \
    :app:testReleaseUnitTest :app:assembleRelease :app:assembleDebug :app:assembleDebugAndroidTest \
    > "$sim_output/build.log" 2>&1
fi

# Separate CI/workstation debug keys may differ. Reset only these disposable test
# packages; the production package is never addressed by this runner.
"$sim_adb" -s "$sim_serial" uninstall "$sim_package.test" >/dev/null 2>&1 || true
"$sim_adb" -s "$sim_serial" uninstall "$sim_package" >/dev/null 2>&1 || true
"$sim_adb" -s "$sim_serial" install -r app/build/outputs/apk/debug/app-debug.apk
"$sim_adb" -s "$sim_serial" install -r app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
if [ "${SH_SIMULATOR_AOT_COMPILE:-0}" = '1' ]; then
  # Standard Android compilation reduces cold-start work on software emulators.
  # It changes no APK, production behavior, test assertion or Android timeout.
  "$sim_adb" -s "$sim_serial" shell cmd package compile -m speed -f "$sim_package" | tee "$sim_output/aot-application.txt"
  "$sim_adb" -s "$sim_serial" shell cmd package compile -m speed -f "$sim_package.test" | tee "$sim_output/aot-instrumentation.txt"
  if ! rg -q '^Success' "$sim_output/aot-application.txt" || ! rg -q '^Success' "$sim_output/aot-instrumentation.txt"; then
    echo 'Android package compilation failed; inspect the AOT reports.' >&2
    exit 1
  fi
fi
"$sim_adb" -s "$sim_serial" shell pm clear "$sim_package" > "$sim_output/reset.txt"
"$sim_adb" -s "$sim_serial" shell pm grant "$sim_package" android.permission.POST_NOTIFICATIONS
"$sim_adb" -s "$sim_serial" shell pm revoke "$sim_package" android.permission.RECORD_AUDIO
# RECORD_AUDIO intentionally remains denied. The Answer test covers the real
# permission prompt and cancellation; it does not certify microphone hardware.
"$sim_adb" -s "$sim_serial" shell settings put global http_proxy 127.0.0.1:9
"$sim_adb" -s "$sim_serial" shell settings put global window_animation_scale 0
"$sim_adb" -s "$sim_serial" shell settings put global transition_animation_scale 0
"$sim_adb" -s "$sim_serial" shell settings put global animator_duration_scale 0
"$sim_adb" -s "$sim_serial" shell cmd appops set "$sim_package" USE_FULL_SCREEN_INTENT deny
"$sim_adb" -s "$sim_serial" logcat -c
"$sim_adb" -s "$sim_serial" shell am instrument -w -r \
  -e class com.smarthandicrafts.operatorhub.NativeSystemInstrumentationTest \
  "$sim_runner" | tee "$sim_output/instrumentation.txt"
"$sim_adb" -s "$sim_serial" logcat -d > "$sim_output/logcat.txt"
"$sim_adb" -s "$sim_serial" exec-out screencap -p > "$sim_output/screen.png"
"$sim_adb" -s "$sim_serial" shell am force-stop "$sim_package"
if ! rg -q '^OK \(12 tests\)' "$sim_output/instrumentation.txt" || \
   rg -q '^INSTRUMENTATION_STATUS_CODE: -' "$sim_output/instrumentation.txt" || \
   [ "$(rg -c '^INSTRUMENTATION_STATUS_CODE: 0$' "$sim_output/instrumentation.txt" || true)" != '12' ]; then
  echo 'Android system simulation failed; inspect the saved instrumented output.' >&2
  exit 1
fi
echo "Android system simulation passed. Reports: $sim_output"
echo 'Scope: real Android OS/WebView/notifications with synthetic provider and delivered FCM data; no production transport or physical audio claim.'
