#!/usr/bin/env bash
# Android 러너 APK + 미러 dex 빌드 — pnpm/Nx 그래프 밖 (controller-ios와 동일 취급)
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
project="$repo_root/android-controller"

[ -f "$project/local.properties" ] \
  || { echo "android-controller/local.properties 없음 — local.properties.example 복사 후 sdk.dir 확인" >&2; exit 1; }

# AGP는 JDK 17+ 요구 — 시스템 기본이 구버전이어도 동작하게 JAVA_HOME 고정
if [ -z "${JAVA_HOME:-}" ]; then
  JAVA_HOME="$(/usr/libexec/java_home -v 21 2>/dev/null || /usr/libexec/java_home -v 17)"
  export JAVA_HOME
fi

cd "$project"
./gradlew :runner:assembleDebug :mirror:assembleDebug "$@"
echo
echo "러너 APK: $project/runner/build/outputs/apk/debug/runner-debug.apk"
echo "미러 dex: $project/mirror/build/outputs/apk/debug/mirror-debug.apk"
