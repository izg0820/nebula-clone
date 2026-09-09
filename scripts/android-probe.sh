#!/usr/bin/env bash
# Android 기기 사전 프로브 (읽기 전용) — 미러링·제어 설계의 미확정 항목(U1~U7)을 실기기에서 확인
# 출력을 android-controller/README.md의 "지원 기기" 섹션에 원문 보존할 것
set -uo pipefail

command -v adb >/dev/null || { echo "adb 필요 — brew install --cask android-platform-tools" >&2; exit 1; }

serial="${1:-$(adb devices | awk 'NR==2 {print $1}')}"
[ -n "$serial" ] || { echo "연결된 기기 없음 — USB 연결 + USB 디버깅 허용 확인" >&2; exit 1; }
run() { echo "── $*"; adb -s "$serial" shell "$@" 2>&1; echo; }

echo "═══ 기기: $serial"
echo "── [U7] 기기 정보"
adb -s "$serial" shell getprop ro.product.model
adb -s "$serial" shell getprop ro.build.version.release
adb -s "$serial" shell getprop ro.build.version.sdk
adb -s "$serial" shell getprop ro.build.display.id
echo

echo "── [U1] shell 권한 (CAPTURE_VIDEO_OUTPUT 필수 — 미러링 게이트)"
adb -s "$serial" shell dumpsys package com.android.shell 2>/dev/null | grep -iE "CAPTURE_VIDEO_OUTPUT|INJECT_EVENTS|ACCESS_SURFACE_FLINGER" | sort -u
echo

echo "── [U3] 디스플레이 구조 (접힌 상태와 펼친 상태에서 각각 실행해 비교할 것)"
adb -s "$serial" shell dumpsys display 2>/dev/null | grep -E "mDisplayId|DisplayDeviceInfo|state=" | head -20
run wm size
run wm density

echo "── [U6 참고] hidden_api_policy (미설정이 정상 — 우리는 변경하지 않음)"
adb -s "$serial" shell settings get global hidden_api_policy
echo

echo "── [U2] hidden DisplayManager.createVirtualDisplay 존재 여부는 미러 데몬 기동 시 리플렉션 로그로 판명"
echo "── [U4] am instrument 수명은 러너 구현 후: adb shell 프로세스 kill → adb shell ps -A | grep nebula"
echo "═══ 프로브 완료 — 이 출력을 android-controller/README.md '지원 기기' 섹션에 붙여넣기"
