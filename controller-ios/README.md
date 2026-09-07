# Nebula iOS Controller

XCUITest 러너가 "끝나지 않는 테스트" 안에서 HTTP 서버를 호스팅하는 기기 제어부 (WebDriverAgent 방식).
**⚠ 전체 미검증** — Xcode 없는 맥에서 작성됨. 맥미니 + 실기기에서 아래 절차로 확정 필요.

## HTTP 계약 (Agent의 ControllerClient와 일치해야 함)

| 경로 | 본문 | 응답 |
|---|---|---|
| `POST /health` | — | `{"status":"ok"}` |
| `POST /tap` | `{x, y}` (pt, 0~10000) | `{"ok":true}` |
| `POST /swipe` | `{fromX, fromY, toX, toY, durationMs}` | `{"ok":true}` |
| `POST /type` | `{text}` (4000자 이하) | `{"ok":true}` |
| `POST /ui` | `{bundleId?}` — 전면 앱 트리를 얻으려면 bundleId 필수 | `{"ok":true, "tree":"..."}` |
| `POST /screenshot` | — | `{"ok":true, "jpegBase64":"...", "widthPt":430, "heightPt":932}` |

- 서버는 **루프백(127.0.0.1) 전용 바인딩** — LAN 노출 없음, usbmuxd(USB) 포워딩으로만 접근
- `TEST_RUNNER_NEBULA_CONTROLLER_TOKEN` 설정 시 모든 요청에 `x-nebula-token` 헤더 필수 (불일치 401)
- 필드 검증 실패는 400, 미지원 경로는 404

## 빌드·실행 (맥미니에서)

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
# 실기기 스모크 1순위: main.sync 런루프 전제 검증 — 이게 응답해야 나머지가 의미 있음
curl -s -X POST http://127.0.0.1:8100/health
```

Agent의 `NEBULA_CONTROLLER_PORTS='<UDID>:8100'` 은 이 포워딩된 맥 로컬 포트를 가리킨다.

## 알려진 제약 (v0)

- `typeText`는 키보드가 포커스된 상태에서만 동작 — WDA식 커스텀 IME 미구현 (한글은 되지만 방식이 다름, 미검증)
- XCUI 액션 실패(좌표 밖 등)가 테스트 실패로 이어져 러너가 죽을 수 있음 — Agent 수퍼바이저의 자동 재기동으로 커버 예정
- 무료 Apple ID 서명 시 7일마다 재서명 필요 (`-allowProvisioningUpdates`로 자동 갱신 시도, GUI 개입 없이 되는지 미검증)
