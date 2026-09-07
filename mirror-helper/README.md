# mirror-helper (보류 — macOS 26에서 차단)

원문 Nebula의 미러링 해법(macOS 내장 iOS 화면 캡처 장치 + H.264)을 재현하려던 Swift CLI.
CoreMediaIO `AllowScreenCaptureDevices` 활성화 → AVFoundation 캡처 → VideoToolbox H.264 →
stdout 프레임 스트림까지 구현돼 있으나, **macOS 26에서는 동작하지 않는다.**

## 차단 판정 근거 (2026-09-07 실측)

- USB 연결·잠금 해제·카메라 권한 허용 상태에서 CMIO 저수준 열거에도 iPhone 캡처 장치 미발행
- **QuickTime Player의 동영상 녹화 소스에도 iPhone이 나타나지 않음** — OS 레벨에서 경로 자체가 사라짐
- 구형 DAL 플러그인 아키텍처가 macOS 26에서 제거되면서 Apple의 iOS USB 캡처 장치도
  함께 사라진 것으로 추정 (Apple 공식 문서로는 미확인)

## 재검토 조건

- **구버전 macOS(15 이하) 호스트**에서는 동작할 가능성 높음 — 맥미니가 구버전이면 이 코드로 재시도
- 대안: QuickTime USB 프로토콜 직접 구현(quicktime_video_hack류) — 고난도, 최신 iOS 지원 불확실

## 현재 미러링 구현

XCUITest 스크린샷 푸시 스트리밍(`packages/agent/src/stream-manager.ts`)이 대신 사용 중 — 3.5fps.

```bash
swift build
./.build/debug/mirror-helper --list        # 캡처 장치 나열 (진단 로그 포함)
./.build/debug/mirror-helper --list-cmio   # CMIO 저수준 열거 (진단용)
./.build/debug/mirror-helper --udid <UDID> # H.264 스트림 (동작 환경에서)
```
