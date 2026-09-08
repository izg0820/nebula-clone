# nebula-clone

토스 디바이스 팜 **Nebula** 따라해보기 — **iOS 단독 버전**
(원문: [토스는 어떻게 수백 대의 기기를 하나의 테스트 인프라로 만들었을까](https://toss.tech/article/device-farm-nebula))

## 원문 요약 — Nebula가 푸는 문제

- 팀마다 Appium 세팅 + 기기 5~10대를 각자 운영 → 중복 작업, 자원 분산, 보안 관리 부담
- 이를 **전사 공용 디바이스 팜**으로 중앙화: 웹 콘솔 / SDK / CLI 로 누구나 실기기 점유·조작
- Appium을 버리고 **자체 드라이버** 개발: 세션리스(stateless HTTP) + 상시 pre-warm 컨트롤러로
  클릭 52ms(Appium 702ms), 세션 시작 15~40초 오버헤드 제거
- iOS 미러링이 최대 난제: USB 직결 캡처는 조작 세션과 충돌, Appium MJPEG는 10~15fps 슬라이드쇼.
  macOS 내장 캡처 장치를 활용해 "보면서 동시에 조작" + 60~120fps 달성

## 이 클론의 범위

- **iOS만 구현** — Android는 범위 외 (원문과 달리 기기가 iPhone 공기계 1대)
- **실제 구동이 목표** — 실기기에서 점유 → 조작 → 미러링까지 돌아가는 상태까지 간다
  (달성 — 전 구간 실기기 검증 완료, 로드맵 참고)
- **로컬 실행 전용** — 클라우드 배포는 범위에서 제외. 단 설계는 "서버가 공인망, Agent가 NAT 뒤"
  토폴로지를 전제해 아웃바운드 터널 구조를 유지한다

## 목표 아키텍처

원문과 동일한 4계층 구조. 설계 토폴로지는 "오케스트레이션 = 클라우드(공인 IP), 호스트 = 집 맥미니"를
전제해 명령 방향을 뒤집는다 — NAT 뒤의 Agent가 서버로 **아웃바운드 WS 터널**을 상시 유지하고,
명령·미러링 스트림 모두 이 터널을 경유한다. (실행은 로컬 — 서버·Agent·웹을 같은 맥에서 구동)

```mermaid
flowchart TB
    subgraph client["① 클라이언트 계층"]
        WEB["웹 콘솔<br/>(미러링 뷰 + 클릭 조작)"]
        CLI["CLI / SDK<br/>(테스트 코드에서 호출)"]
    end

    subgraph server["② 서버 계층 — 오케스트레이션 (공인망 배포 전제 설계)"]
        API["NestJS REST API<br/>occupy / release / action 프록시<br/>+ 토큰 인증 (보안 기본값 닫힘)"]
        REG["디바이스 레지스트리<br/>(상태·태그·점유 정보)"]
        LOCK["점유 원자성<br/>(SQLite 트랜잭션 → 확장 시 Redis)"]
    end

    subgraph agent["③ 에이전트 계층 — 집 맥미니"]
        AG["Agent 데몬 (plain TS)<br/>- devicectl 로 iPhone 자동 발견<br/>- 서버로 WS 터널·하트비트<br/>- 기기별 Controller·미러링 프로세스 관리(pre-warm)"]
    end

    subgraph device["④ 기기 계층 — iPhone (기기당 1세트 상시 구동)"]
        CTRL["Controller 서버<br/>XCUITest 러너가 HTTP 서버 호스팅<br/>탭·입력·UI 덤프 (WDA 방식)"]
        MIRROR["미러링 헬퍼 (맥미니에서 실행)<br/>macOS 캡처 장치 → H.264 → WS"]
    end

    WEB -->|"REST + WS"| API
    CLI -->|REST| API
    API --> REG
    API --> LOCK
    AG ==>|"아웃바운드 WS 터널 상시 유지<br/>(NAT 뒤 → 클라우드, 명령·스트림 모두 경유)"| API
    AG -->|"xcodebuild 로 기동·감시"| CTRL
    AG -->|"프로세스 기동·감시"| MIRROR
```

### 핵심 설계 결정

| 항목 | 원문 (Nebula) | 이 클론 | 이유 |
|---|---|---|---|
| 플랫폼 | Android + iOS | **iOS만** | 보유 기기가 iPhone 공기계 1대 |
| 드라이버 | Appium 대체 자체 개발 (Swift + XCTest) | 동일 — 자체 XCUITest 러너 (WDA 구조 참고) | 이 프로젝트의 학습 핵심 |
| 세션 모델 | 세션리스, 컨트롤러 상시 구동 | 동일 — XCUITest 러너 상시 구동 + stateless HTTP | 세션 오버헤드 제거 구조 체험 |
| 테스트 큐 | Kafka + Runner 병렬 소비 | 생략 → 동기 REST만 | 규모상 불필요 (YAGNI) |
| 점유 락 | 분산 락 | SQLite 트랜잭션 원자 점유 (`DevicesRepository` 인터페이스로 저장소 분리) | 서버 1대면 충분 |
| 명령 방향 | 서버 → Agent (사내망) | Agent → 서버 아웃바운드 WS 터널 | 맥미니가 NAT 뒤라는 전제 유지 |
| iOS 미러링 | macOS 내장 캡처 장치, 60~120fps | 동일 — CoreMediaIO 캡처 → VideoToolbox **H.264 단독** (실측 40~60fps) | 초기 JPEG 스크린샷 폴백(3.5fps)은 느려서 폐기 |
| API 스펙 | OpenAPI → 코드 생성 (계약 우선) | 코드 우선 생성 → 클라이언트 자동 생성 | Nest 생태계(`@nestjs/swagger`)에 자연스러운 방향 |

### 점유 → 조작 → 해제 흐름

```mermaid
sequenceDiagram
    participant C as 클라이언트
    participant S as 서버
    participant A as Agent (맥미니)
    participant D as Controller(iPhone)

    A--)S: WS 터널 연결 + 기기 등록·하트비트 (상시)
    C->>S: POST /devices/occupy {tags}
    S->>S: 태그 필터 + 락 획득
    S-->>C: 200 {deviceId, token}
    C->>S: POST /devices/{id}/actions/tap {x, y}
    S->>A: WS 터널로 명령 전달
    A->>D: HTTP (상시 구동 중 — 세션 생성 없음)
    D-->>C: 결과
    C->>S: POST /devices/{id}/release
    S->>S: 락 해제 + 기기 상태 리셋
```

## 기술 스택 (확정)

- **서버**: **NestJS** — 레지스트리/점유/명령 프록시/미러링 릴레이를 모듈 경계로 대응.
  점유 원자성은 SQLite 트랜잭션(better-sqlite3), 저장소 교체는 `DevicesRepository` 인터페이스,
  하트비트 만료는 `@nestjs/schedule`(Cron), 터널·릴레이는 `@nestjs/websockets` 게이트웨이,
  경계 검증은 class-validator. 공인망 노출 전제라 토큰 인증 필수(보안 기본값 닫힘)
- **Agent**: 프레임워크 없는 **plain TypeScript 데몬** (맥미니) — `xcrun devicectl`로 기기 발견,
  서버로 WS 터널 유지, `xcodebuild test-without-building`으로 Controller 기동·감시,
  mirror-helper 프로세스 상시 구동(pre-warm)
- **iOS Controller**: **Swift + XCUITest** — XCTest 러너 안에서 HTTP 서버를 호스팅하고
  `XCUICoordinate.tap()` / `typeText()` / accessibility 스냅샷(UI 덤프)을 노출 (WebDriverAgent 구조 참고,
  기능은 최소로 자체 구현)
- **미러링 (H.264 단독)**: Swift 헬퍼(`mirror-helper`) — macOS가 USB 연결된 iPhone을 캡처 장치로
  인식(CoreMediaIO — QuickTime 녹화와 같은 메커니즘) → AVFoundation 캡처 → VideoToolbox H.264 →
  Agent가 터널로 바이너리 푸시 (실기기 검증 완료. 초기의 XCUITest 스크린샷 폴링 폴백은 폐기)
- **웹 콘솔**: React + TypeScript + Vite, WebCodecs `VideoDecoder`로 H.264 디코딩 (실기기 검증 완료)
- **저장소**: SQLite (레지스트리 + 점유 상태)
- **SDK/CLI**: `@nebula/client` — OpenAPI 스펙(`packages/server/openapi.json`)에서
  openapi-typescript로 타입만 생성 + 얇은 fetch 래퍼 (브라우저·Node 공용, 웹 콘솔도 이것을 소비).
  `@nebula/cli` — 그 위에 구축한 `nebula` 커맨드 (의존성 없는 node:util parseArgs)
- **레포 구조**: pnpm workspace + Nx 모노레포 (`server` / `agent` / `shared` / `web` / `client` / `cli`) +
  `controller-ios` (Swift, XcodeGen — workspace 밖)

## 실행 환경 요구사항

- **맥 1대** — 서버·Agent·웹 콘솔·미러링 헬퍼 실행, Xcode 설치 (XCUITest 러너 빌드·기동에 필수)
- **iPhone 공기계 1대** — 설정에서 **Developer Mode 활성화** (iOS 16+).
  발견·조작은 Wi-Fi로도 동작하지만 **미러링 캡처 장치는 USB 연결 필수** (실측)
- **코드 서명** — XCUITest 러너를 기기에 설치하려면 서명 필요.
  무료 Apple ID는 7일마다 재서명, 유료 개발자 계정($99/년)은 1년 유효
- Node.js 24+, pnpm

## 실행 방법

### 새 맥 온보딩 (최초 1회)

`pnpm dev` 한 방이 되기 전에 스크립트가 대신 못 해주는 단계들. 순서대로:

```bash
# 1) 도구 — Xcode는 App Store에서 전체 설치 (CLT만으로는 xcodebuild·devicectl 불가)
brew install xcodegen libimobiledevice   # xcodegen: 프로젝트 생성 / libimobiledevice: iproxy
# Node 24+, pnpm 준비

# 2) 의존성
git clone <repo> && cd nebula-clone && pnpm install

# 3) 설정 파일 3개 (전부 gitignore — 커밋 안 됨)
cp packages/server/.env.example packages/server/.env   # 토큰 2개 생성: openssl rand -hex 32 (서로 다르게)
cp packages/agent/.env.example packages/agent/.env     # 서버 주소 + 같은 Agent 토큰
cp controller-ios/local.yml.example controller-ios/local.yml   # 본인 Apple Team ID 기입

# 4) Apple 서명 최초 1회 (GUI 필요)
cd controller-ios && xcodegen generate && open NebulaController.xcodeproj
#   → Signing에서 Personal Team 지정. 첫 xcodebuild 때 키체인 프롬프트는 반드시 "항상 허용"
#     ("허용"만 누르면 비대화형 셸에서 errSecInternalComponent로 계속 실패)
```

기기(iPhone) 쪽: 설정에서 **개발자 모드** 활성화(iOS 16+), 맥 **신뢰**, 러너 설치 동안 **잠금 해제**
상태 유지. 미러링은 **USB 연결 필수**이고, macOS 26에서는 최초 1회 QuickTime의 동영상 녹화
소스 목록을 열어 캡처 장치 발행을 트리거해야 할 수 있다 (mirror-helper/README.md).

이후는 아래 `pnpm dev`만 — 빠진 도구·설정은 스크립트가 검사해서 안내한다.

### 한 번에 실행 (개발 세션)

```bash
pnpm dev           # 빌드 → 서버 → Agent → 웹 콘솔, 로그는 한 화면 (= scripts/dev.sh)
pnpm dev -- --fake # 기기 없이 — 정적 가짜 기기로 서버·웹 파이프라인만
```

- 종료는 Ctrl-C 한 번 (Agent가 러너·iproxy·헬퍼까지 정리)
- **재실행하면 기존 스택을 자동 종료하고 새로 시작**한다
- 수퍼바이저·미러링 설정이 .env에 없으면 저장소 기준 기본값을 자동 주입하고,
  mirror-helper 미빌드 시 빌드를 시도한다 (실패해도 미러링만 빠진 채 진행)

### 상시 데몬으로 실행 (launchd 자동 복구)

로그인 시 자동 기동 + 크래시 시 자동 재기동이 필요하면 launchd LaunchAgent로 설치한다.

```bash
scripts/daemon.sh install    # 빌드 → plist 설치(~/Library/LaunchAgents) → 기동
scripts/daemon.sh status     # pid·마지막 종료 코드
scripts/daemon.sh restart
scripts/daemon.sh uninstall
```

- 서버·Agent 프로세스가 죽으면 launchd가 10초 간격(ThrottleInterval)으로 되살린다
- `dev.sh`(개발 세션)와 동시 사용 불가 — dev.sh가 감지하고 거부함
- 로그: `.dev-logs/daemon-{server,agent}.log` (로테이션 없음 — 백로그)

### CLI

```bash
export NEBULA_SERVER_URL=http://localhost:3000
export NEBULA_CLIENT_TOKEN=<서버 .env의 NEBULA_CLIENT_TOKEN>

pnpm cli devices list
pnpm cli devices occupy --platform ios     # 점유 — 세션이 ~/.nebula/session.json에 저장됨
pnpm cli tap --x 200 --y 400               # 이후 커맨드는 기기·occupantId 생략 가능
pnpm cli screenshot --out shot.jpg
pnpm cli devices keepalive                 # 명령 없이 오래 점유할 때 (sliding TTL 연장)
pnpm cli devices release
```

전체 커맨드·플래그·종료 코드는 [packages/cli/README.md](./packages/cli/README.md) 참고.

### OpenAPI 스펙과 클라이언트 생성

- 스펙은 코드 우선: 서버 데코레이터 → `packages/server/openapi.json`(커밋 산출물) →
  `@nebula/client`의 생성 타입(`src/generated/api-schema.ts`, 커밋 산출물)
- **서버 API를 바꾸면 `pnpm openapi`로 재생성**해야 한다 — 안 하면 서버·client의
  드리프트 테스트가 실패한다 (생성물은 손으로 고치지 말 것)
- `ENABLE_DOCS=true`면 같은 문서가 `/docs`(Swagger UI)로도 노출된다

### 개별 실행

```bash
pnpm install

# 1) 서버
cd packages/server
cp .env.example .env   # 토큰 교체 필수 — openssl rand -hex 32 (24자 미만·플레이스홀더면 기동 실패)
pnpm build && pnpm start        # 개발 모드: pnpm start:dev

# 2) 미러링 헬퍼 (선택 — 미설정 시 미러링만 비활성, 조작은 동작)
cd mirror-helper && swift build

# 3) Agent
cd packages/agent
cp .env.example .env   # 서버 주소·토큰 + NEBULA_XCODEBUILD_ENABLED + NEBULA_MIRROR_HELPER
pnpm build && pnpm start

# 4) 웹 콘솔
cd packages/web && pnpm start:dev   # 설정 패널에 서버 주소·클라이언트 토큰 입력

# 테스트: 루트에서 pnpm test (Nx 캐시 적용)
```

- REST 문서: `http://localhost:3000/docs` (Swagger) — 무인증 노출이라 `ENABLE_DOCS=true`일 때만 활성 (기본 꺼짐)
- 클라이언트 인증: `Authorization: Bearer $NEBULA_CLIENT_TOKEN`
- Agent WS 터널: `ws://host:3000/agent?agentId=<id>&token=$NEBULA_AGENT_TOKEN`

## 로드맵

- [x] **Phase 1 — 뼈대**: NestJS 서버(occupy/release/레지스트리/토큰 인증) + Agent(devicectl 기기 발견,
      WS 터널, 하트비트) — 로컬 e2e 구동 확인 (실기기 발견은 Phase 2에서 검증 완료,
      클라우드 배포는 로컬 전용으로 확정하며 범위 제외)
- [x] **Phase 2 — 제어**: 명령 파이프라인 전 구간 **실기기 검증 완료** (2026-09-07, iPhone/iOS 26.6.1) —
      devicectl 자동 발견 → 점유 → 서버 API 탭·스와이프·UI 덤프가 USB(iproxy) 경유로 실제 동작.
      XCUITest 러너의 main.sync 런루프 전제, hardwareProperties.platform 필드 파싱도 실측 확정
- [x] **Phase 2.5 — 운영 자동화**: Controller 수퍼바이저 실기기 검증 완료 (2026-09-07) —
      `NEBULA_XCODEBUILD_ENABLED=true`면 Agent가 기기별 러너·iproxy를 자동 기동, 10초 헬스 폴링,
      죽으면 백오프 재기동(강제 kill → 2초 후 복구 실측). 준비된 기기는 `controller-ready` 태그로
      점유 필터 가능. 남은 것: 7일 재서명 자동화 검증(시간 경과 필요)
- [x] **Phase 3 — 미러링 (H.264, 원문 방식)**: 실기기 검증 완료 (2026-09-07) — **40fps, 8KB/frame,
      1290×2796**. macOS 캡처 장치(CoreMediaIO) → VideoToolbox H.264(`mirror-helper`) → Agent가
      터널로 바이너리 푸시 → 서버 릴레이(`/stream` WS) → 브라우저 WebCodecs 디코딩.
      H.264 단독 상시 구동(pre-warm) — 초기의 JPEG 스크린샷 폴백(3.5fps)은 느려서 제거.
      macOS 26 함정 2개(DiscoverySession 미노출 → CMIO UID 직접 열기, 최초 발행 트리거)는
      mirror-helper/README.md 참고 — 콜드 스타트 자가 발행은 미검증
- [x] **Phase 4 — 확장** (2026-09-08):
      ① **점유 만료(sliding TTL)** — 활동(점유·명령·keepalive) 기준 10분 TTL, 30초 스윕이 회수.
      기기는 online 유지(즉시 재점유 가능), 만료 시 스트림 시청자는 4408로 종료. 웹은 30초 keepalive 자동
      ② **CLI/SDK** — openapi.json(코드 우선 생성) → openapi-typescript 타입 → `@nebula/client`
      (웹 콘솔도 소비) → `nebula` CLI (점유 세션 파일, 종료 코드 규약)
      ③ **프로세스 자동 복구** — launchd LaunchAgent(`scripts/daemon.sh`)로 서버·Agent 상시화
      (자식 프로세스 복구는 Phase 2.5에서 완료). launchd 실설치 검증은 미실시

## 원문 대비 의도적 생략

Android 전체, Kafka 파이프라인, 다중 Runner, 무중단 배포, 보안·컴플라이언스 정책, AppCenter 연동,
AI 에이전트 — 학습 범위 밖이거나 규모상 불필요. 구조만 원문을 따르고 구현은 최소로 유지한다.
