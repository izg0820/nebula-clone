# Nebula iOS Controller

XCUITest 러너가 "끝나지 않는 테스트" 안에서 HTTP 서버를 호스팅하는 기기 제어부 (WebDriverAgent 방식).
탭·스와이프는 비공개 이벤트 합성 API를 우선 사용하고, 실패 시 XCUICoordinate로 폴백합니다.
iOS·Xcode 업데이트 시 호환성 확인이 필요합니다.
전체 스택 실행은 [루트 README](../README.md)를 참고하세요.

## HTTP API

| 경로 | 본문 | 응답 |
|---|---|---|
| `POST /health` | — | `{"status":"ok"}` |
| `POST /tap` | `{x, y}` (pt, 0~10000) | `{"ok":true}` |
| `POST /swipe` | `{fromX, fromY, toX, toY, durationMs}` | `{"ok":true}` |
| `POST /press` | `{button:"home"}` | `{"ok":true}` |
| `POST /type` | `{text}` (4000자 이하) | `{"ok":true}` |
| `POST /ui` | `{bundleId?}` — 러너는 지원하나 **Agent/서버 미배선**: 현재 항상 스프링보드 트리 반환 | `{"ok":true, "tree":"..."}` |
| `POST /screenshot` | — | `{"ok":true, "jpegBase64":"...", "widthPt":430, "heightPt":932}` |

- 서버는 **루프백(127.0.0.1) 전용 바인딩** — LAN 노출 없음, usbmuxd(USB) 포워딩으로만 접근
- `TEST_RUNNER_NEBULA_CONTROLLER_TOKEN` 설정 시 모든 요청에 `x-nebula-token` 헤더 필수 (불일치 401).
  Agent를 쓸 때는 러너에 직접 설정하지 말고 **Agent의 `NEBULA_CONTROLLER_TOKEN`** 을 설정할 것 —
  Agent가 러너 env 주입과 요청 헤더를 함께 배선함 (러너에만 설정하면 헬스체크 401 → 재기동 루프)
- 필드 검증 실패는 400, 미지원 경로는 404

## 단독 빌드·실행

```bash
brew install xcodegen
cd controller-ios
cp local.yml.example local.yml             # DEVELOPMENT_TEAM에 본인 Team ID 기입 (미추적 파일)
xcodegen generate                          # NebulaController.xcodeproj 생성
open NebulaController.xcodeproj            # 최초 1회: Signing에서 Personal Team 지정

# 기기 UDID 확인
xcrun devicectl list devices

# 러너 기동 (테스트가 끝나지 않고 서버로 상시 대기)
xcodebuild test \
  -project NebulaController.xcodeproj \
  -scheme NebulaController \
  -destination 'id=<UDID>' \
  -allowProvisioningUpdates
```

포트 변경: `TEST_RUNNER_NEBULA_CONTROLLER_PORT=8123` 을 xcodebuild 환경에 추가 (기본 8100).

## 맥 → 기기 접속 (USB 포트 포워딩)

러너의 HTTP 서버는 기기 안에서 listen 하므로 맥에서 직접 접근하려면 usbmuxd 포워딩 필요:

```bash
brew install libimobiledevice
iproxy 8100 8100 -u <UDID>    # 맥의 :8100 → 기기의 :8100
# 러너 상태 확인
curl -s -X POST http://127.0.0.1:8100/health
```

이 iproxy+curl 경로는 **러너 단독 스모크용**이다 (Agent 없이 러너만 검증). Agent 운영 경로는
수퍼바이저(`NEBULA_XCODEBUILD_ENABLED=true`)가 러너·iproxy를 자동 기동하므로 수동 포워딩은 불필요하다.

## 제약

- 텍스트 입력은 키보드 포커스가 필요하며, 한글 입력 호환성은 미검증
- XCUI 액션 실패(좌표 밖 등)가 테스트 실패로 이어져 러너가 죽을 수 있음 — Agent 수퍼바이저가 종료를 감지하면 재기동
- 무료 Apple ID 서명 시 7일마다 재서명 필요 (`-allowProvisioningUpdates`로 자동 갱신 시도, GUI 개입 없이 되는지 미검증)
