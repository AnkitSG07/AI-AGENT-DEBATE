#!/usr/bin/env bash
set -euo pipefail

# Real production NativeRoomEngine + Android SDK against a local-only SFU and tone.
# This runs only the distinct .simulation package, never an enrolled production app.
cd "$(dirname "$0")"
sim_project="$PWD"
sim_repo="$(cd ../.. && pwd)"
: "${ANDROID_SDK_ROOT:=${ANDROID_HOME:-}}"
if [ -z "$ANDROID_SDK_ROOT" ]; then echo 'Set ANDROID_SDK_ROOT.' >&2; exit 2; fi
sim_adb="$ANDROID_SDK_ROOT/platform-tools/adb"
sim_serial="${SH_SIMULATOR_SERIAL:-emulator-5556}"
sim_package='com.smarthandicrafts.operatorhub.simulation'
sim_runner='com.smarthandicrafts.operatorhub.simulation.test/androidx.test.runner.AndroidJUnitRunner'
sim_output="${SH_NATIVE_MEDIA_REPORT_DIR:-build/reports/native-media-simulation}"
mkdir -p "$sim_output"
sim_output="$(cd "$sim_output" && pwd)"
sim_qemu="$("$sim_adb" -s "$sim_serial" shell getprop ro.kernel.qemu | tr -d '\r')"
sim_sdk="$("$sim_adb" -s "$sim_serial" shell getprop ro.build.version.sdk | tr -d '\r')"
if [ "$sim_qemu" != '1' ] || [ "$sim_sdk" != '35' ]; then
  echo 'Refusing: an isolated Android15/API35 emulator is required.' >&2; exit 2
fi

if [ -z "${SH_NATIVE_MEDIA_OUTPUT:-}" ]; then
  SH_NATIVE_MEDIA_OUTPUT="$(mktemp -d "${TMPDIR:-/tmp}/sh-native-media.XXXXXX")"
fi
export SH_NATIVE_MEDIA_OUTPUT
export SH_NATIVE_MEDIA_TLS="${SH_NATIVE_MEDIA_TLS:-$SH_NATIVE_MEDIA_OUTPUT/tls}"
python3 "$sim_repo/tests/simulator-media-r13/prepare-native-tls.py"
if [ "${SH_SIMULATOR_SKIP_BUILD:-0}" != '1' ]; then
  bash gradlew --no-daemon --console=plain --max-workers=2 :app:assembleDebug :app:assembleDebugAndroidTest > "$sim_output/build.log" 2>&1
fi
# A changed test CA requires a rebuilt test APK. Never disable certificate checks.
python3 - "$SH_NATIVE_MEDIA_TLS/ca.crt" app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk <<'PY'
import pathlib,sys,zipfile
with zipfile.ZipFile(sys.argv[2]) as apk:
    if apk.read('assets/native-media-ca.crt') != pathlib.Path(sys.argv[1]).read_bytes():
        raise SystemExit('Native test APK has a different test CA; rebuild it before running.')
PY

sim_fixture_pid=''
cleanup() {
  "$sim_adb" -s "$sim_serial" shell am force-stop "$sim_package" >/dev/null 2>&1 || true
  "$sim_adb" -s "$sim_serial" reverse --remove tcp:443 >/dev/null 2>&1 || true
  "$sim_adb" -s "$sim_serial" reverse --remove tcp:17881 >/dev/null 2>&1 || true
  if [ -n "$sim_fixture_pid" ]; then kill "$sim_fixture_pid" 2>/dev/null || true; wait "$sim_fixture_pid" 2>/dev/null || true; fi
  if [ -f "$SH_NATIVE_MEDIA_OUTPUT/fixture-observations.json" ]; then
    cp "$SH_NATIVE_MEDIA_OUTPUT/fixture-observations.json" "$sim_output/fixture-observations.json"
  fi
}
trap cleanup EXIT
if [ "${SH_NATIVE_FIXTURE_EXTERNAL:-0}" != '1' ]; then
  : > "$sim_output/fixture.log"
  SH_R13_NATIVE_MEDIA_FIXTURE=1 node "$sim_repo/tests/simulator-media-r13/native-engine-fixture.mjs" > "$sim_output/fixture.log" 2>&1 &
  sim_fixture_pid=$!
fi
python3 - "$sim_fixture_pid" "$sim_output/fixture.log" <<'PY'
import http.client,json,os,pathlib,sys,time
owned_pid=int(sys.argv[1]) if sys.argv[1] else None
deadline=time.monotonic()+90
while time.monotonic()<deadline:
    if owned_pid is not None:
        try:os.kill(owned_pid,0)
        except ProcessLookupError:raise SystemExit('The owned native fixture exited; inspect fixture.log.')
        own_ready=False
        for line in pathlib.Path(sys.argv[2]).read_text(errors='replace').splitlines():
            try:
                value=json.loads(line)
                own_ready=own_ready or value.get('ready') is True and value.get('localOnly') is True and value.get('hostname')=='sh-r13-simulator.livekit.cloud'
            except (ValueError,AttributeError):pass
        if not own_ready:
            time.sleep(.5);continue
    try:
        connection=http.client.HTTPConnection('127.0.0.1',17883,timeout=2)
        connection.request('GET','/sim/health');response=connection.getresponse();data=json.loads(response.read());connection.close()
        if response.status==200 and data.get('ready') and data.get('localOnly'):break
    except (OSError,ValueError):pass
    time.sleep(.5)
else:raise SystemExit('The local native media fixture did not become ready.')
PY
if [ -n "$sim_fixture_pid" ]; then kill -0 "$sim_fixture_pid"; fi

"$sim_adb" -s "$sim_serial" reverse tcp:443 tcp:18443
"$sim_adb" -s "$sim_serial" reverse tcp:17881 tcp:17881
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
for sim_permission in RECORD_AUDIO BLUETOOTH_CONNECT POST_NOTIFICATIONS; do
  "$sim_adb" -s "$sim_serial" shell pm grant "$sim_package" "android.permission.$sim_permission"
done
"$sim_adb" -s "$sim_serial" shell settings put global http_proxy 127.0.0.1:9
"$sim_adb" -s "$sim_serial" shell cmd appops set "$sim_package" USE_FULL_SCREEN_INTENT deny
"$sim_adb" -s "$sim_serial" logcat -c
"$sim_adb" -s "$sim_serial" shell am instrument -w -r \
  -e class com.smarthandicrafts.operatorhub.NativeMediaInstrumentationTest \
  -e shNativeMediaFixture 1 "$sim_runner" | tee "$sim_output/instrumentation.txt"
"$sim_adb" -s "$sim_serial" logcat -d > "$sim_output/logcat.txt"
if ! rg -q '^OK \(2 tests\)' "$sim_output/instrumentation.txt" || \
   rg -q '^INSTRUMENTATION_STATUS_CODE: -' "$sim_output/instrumentation.txt" || \
   [ "$(rg -c '^INSTRUMENTATION_STATUS_CODE: 0$' "$sim_output/instrumentation.txt" || true)" != '2' ]; then
  echo 'Native SDK simulation failed; inspect the recorded evidence.' >&2; exit 1
fi
echo "Native SDK simulation passed. Evidence: $sim_output"
echo 'Scope: actual Android engine, SDK, local SFU, RTP and decoded customer audio. Meta/FCM and physical hardware remain separate.'
