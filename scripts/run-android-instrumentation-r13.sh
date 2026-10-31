#!/usr/bin/env bash
# Linux CI orchestration: run both suites and retain either suite's failure.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(dirname -- "$script_dir")"
cd "$repo_root/android/operatorhub"
summary_dir="$PWD/build/reports/instrumentation-suites"
mkdir -p "$summary_dir"

if [[ ! -c /dev/kvm || ! -r /dev/kvm || ! -w /dev/kvm ]]; then
  printf '%s\n' 'Android CI requires accessible KVM; software emulation is not accepted for this gate.' >&2
  exit 2
fi
sdk_root_for_verification="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
if [[ -z "$sdk_root_for_verification" || ! -x "$sdk_root_for_verification/emulator/emulator" ]]; then
  printf '%s\n' 'Android CI cannot locate the installed emulator for its acceleration check.' >&2
  exit 2
fi
"$sdk_root_for_verification/emulator/emulator" -accel-check >"$summary_dir/acceleration.txt" 2>&1
cat "$summary_dir/acceleration.txt"

export SH_SIMULATOR_SKIP_BUILD=1
export SH_SIMULATOR_SERIAL="${SH_SIMULATOR_SERIAL:-emulator-5554}"
system_status=0
if bash run-system-simulation.sh; then
  :
else
  system_status=$?
fi

# Keep this independent: an OS assertion failure must not silently skip media.
native_status=0
if bash run-native-media-simulation.sh; then
  :
else
  native_status=$?
fi

both_passed=false
if [[ "$system_status" -eq 0 && "$native_status" -eq 0 ]]; then
  both_passed=true
fi
printf '{"system_exit_code":%s,"native_media_exit_code":%s,"both_passed":%s}\n' \
  "$system_status" "$native_status" "$both_passed" >"$summary_dir/status.json"
printf 'Android OS runner exit: %s; native media runner exit: %s\n' "$system_status" "$native_status"
if [[ "$both_passed" != true ]]; then
  exit 1
fi
