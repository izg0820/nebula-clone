# nebula-clone

토스 디바이스 팜 Nebula 클론 — **iOS + Android**, 실기기 구동이 목표.
배경·아키텍처 다이어그램·로드맵은 [README.md](./README.md) 참고. 이 파일은 작업 규칙과 불변식만 담는다.

## 배포 토폴로지 (설계 불변식)

- **오케스트레이션 서버**: 오라클 클라우드 (공인 IP 노출 — 보안 기본값은 항상 닫힘)
- **Agent**: 집 맥미니, NAT 뒤 → **Agent가 서버로 아웃바운드 WS 터널을 유지** (`/agent`).
  서버→Agent 방향으로 직접 접속하는 코드를 만들지 말 것. 명령·스트림 모두 이 터널 경유
- **기기**: iPhone 공기계 1대 (USB, Developer Mode 필요) + Android 1대 (ZFold8, USB 디버깅).
  Android 조작·UI 덤프는 Wi-Fi로도 되지만 미러링 캡처는 USB 필수
- **세션리스**: Appium식 세션 없음. 기기별 Controller(iOS: XCUITest 러너 / Android: instrumentation 러너)는
  상시 구동(pre-warm), 모든 조작은 stateless HTTP. 세션 생성/관리 개념을 다시 들여오지 말 것
- **플랫폼 대칭**: Android 러너가 iOS와 **동일한 Controller HTTP 계약**을 구현 → Agent의 명령 경로
  (CommandExecutor·ControllerClient)는 플랫폼 무관·무변경. 플랫폼 분기는 발견(DiscoverySource)·
  러너 기동(수퍼바이저)·미러링(스트림 팩토리)에만 존재

## 모노레포 구조 (Nx package-based + pnpm workspace)

```
packages/server   # @nebula/server — NestJS 오케스트레이션 (명령 프록시 + 스트림 릴레이)
packages/agent    # @nebula/agent — 맥 데몬: 발견·터널·수퍼바이저·스트림 캡처 (프레임워크 금지)
packages/shared   # @nebula/shared — WS 프로토콜·액션·프레임 코덱 (server/agent/web 공용)
packages/web      # @nebula/web — React 콘솔 (기기 목록·점유·미러링 뷰·클릭 탭)
packages/client   # @nebula/client — SDK: openapi.json 생성 타입 + fetch 래퍼 (웹·CLI 공용, 런타임 deps 0)
packages/cli      # @nebula/cli — nebula 커맨드 (client에만 의존, node:util parseArgs)
controller-ios/   # Swift/XCUITest + XcodeGen — 실기기 검증 완료
mirror-helper/    # Swift CLI — 원문 H.264 방식, macOS 26 차단으로 보류 (README 참고)
android-controller/ # Kotlin/Gradle — runner(제어 APK: instrumentation+HTTP) + mirror(app_process dex).
                    #   Nx 그래프 밖 (scripts/build-android.sh로 빌드). 실기기 검증 완료
deploy/launchd/   # LaunchAgent 템플릿 — scripts/daemon.sh가 치환·설치 (상시 데몬)
```

- Nx는 package-based 모드 — `project.json` 만들지 말 것. 각 패키지 `package.json` 스크립트가 태스크
- 루트 명령: `pnpm build` / `pnpm test` (= `nx run-many`), `pnpm affected`, `pnpm graph`
- 새 네이티브 의존성은 `pnpm-workspace.yaml`의 `allowBuilds`에 승인 필요 (pnpm 11)

## 코드 컨벤션

- else 사용 금지 → early return 패턴 사용
- 삼항 연산자 사용 금지
- switch 문 사용 금지 → 객체 맵 또는 early return 사용
- 함수는 단일 책임 원칙 준수
- 타입은 명시적으로 선언
- any 사용 금지
- default export 대신 named export 사용
- 높은 응집도와 낮은 결합도를 준수
- 백엔드 파일명: kebab-case + `.controller.ts` / `.service.ts` / `.module.ts` / `.entity.ts` / `.dto.ts` 접미사
- 프론트엔드 컴포넌트 파일명: PascalCase
- DB 컬럼명: snake_case
- 모든 작업이 끝나면 마무리 단계에서 안티패턴이 있는지 검증하여 리팩토링 진행
- 코드 해석에 필요하지 않은 주석은 지양함

## 아키텍처 원칙

- shared에는 유틸 함수만 존재. 프로젝트는 shared만 import (`packages/shared` 생성 시 적용)
- NestJS 모듈 소유권 분리: 엔티티의 Repository는 해당 엔티티를 소유한 모듈의 Service에서만 접근.
  다른 모듈은 Service를 통해서만 데이터 접근 (예: AgentsModule → DevicesService 경유,
  DevicesRepository 직접 접근 금지)
- 인증 경계: 모든 엔드포인트는 글로벌 TokenGuard로 보호. 공개 엔드포인트만 `@Public()` 데코레이터를
  명시적으로 부여 (참고: `packages/server/src/auth/`)
- 프론트엔드 데이터 접근: 모든 API 호출은 공용 클라이언트 레이어로 일원화, 컴포넌트에서 직접 fetch 금지
  (`packages/web` 구현 시 구체화)
- 공유 타입은 단방향 흐름: server/agent/web ← `@nebula/shared`. shared는 런타임 의존성 없이
  타입과 도메인 enum만 보유
- 공통 TS/JS 상세 규칙은 전역 `~/.claude/rules/common/*.md` (coding-style, security, patterns, hooks) 참조

## 서버 (packages/server) 핵심 규칙

- **도메인 vs 공개 타입 분리**: `Device`(내부, `occupantId` 포함) ↔ `PublicDevice`(응답용).
  `occupantId`는 해제 권한 비밀값 — **점유 응답 외 어떤 API 응답에도 노출 금지**
- **점유 모델**: `tryOccupy`는 SQLite 트랜잭션으로 원자적 (better-sqlite3 동기 + 단일 스레드 전제).
  Agent 단선(`markAgentOffline`)은 점유를 **유지**(터널 블립 유예), 회수 경로는 둘 —
  하트비트 만료 스윕(`markStaleOffline`, offline 처리)과 유휴 만료 스윕(`expireIdleOccupations`)
- **점유 sliding TTL** (기본 10분, `NEBULA_OCCUPATION_TTL_MS`): 갱신 지점은 occupy / 명령 실행 /
  `POST /devices/:id/keepalive` **셋뿐** — Agent 하트비트·스트림 시청은 활동으로 치지 않는다
  (켜둔 탭이 점유를 영구화하면 원래 버그와 동형). 같은 이유로 웹 keepalive도 무조건 반복이 아니라
  **사용자 입력 기준 30분 유휴 상한**(`KEEPALIVE_IDLE_LIMIT_MS`)에서 중단 — 방치 탭은 서버가 회수.
  유휴 만료는 `status`를 바꾸지 않아 즉시 재점유 가능.
  불변식: `occupant_id`와 `last_activity_at`은 항상 함께 설정/해제. 만료 시 시청자는 4408로 종료
- **DB 마이그레이션**: `CREATE TABLE IF NOT EXISTS`는 기존 파일에 컬럼을 추가하지 않음 —
  컬럼 추가 시 `ensureDeviceColumns`(PRAGMA table_info + ALTER TABLE + 백필)에 반드시 등록
- **모듈 방향**: Streams → Devices 의존이 존재. 역방향 호출 금지(순환) — Devices의 결과로 Streams를
  움직여야 하면 `OccupancyModule`처럼 양쪽을 import하는 조립 모듈에서 배선 (CommandsModule과 같은 패턴)
- **스트림 인가**: `/stream` 시청은 점유자 전용 — `occupantId` 쿼리 검증 (불일치 4403)
- **WS 게이트웨이**: 연결 시 `NEBULA_AGENT_TOKEN` 검증(실패 4401), agentId 형식 `[A-Za-z0-9_-]{1,64}`(위반 4400),
  중복 agentId는 기존 소켓 4409 대체. disconnect 처리 전 "현행 소켓인지" 확인 필수
- **저장소 접근은 `DevicesRepository` 인터페이스로만** — Redis 등 교체 대비. 구현체 직접 주입 금지
- Swagger는 `ENABLE_DOCS=true`일 때만 (전역 가드를 타지 않는 Express 직등록 라우트라 무인증 노출됨)
- 환경 변수: `.env.example` 참고. 토큰 24자 미만·`change-me*`·두 토큰 동일값은 기동 거부가 정상 동작
- **OpenAPI 생성물 규칙**: 서버 API 변경 시 `pnpm openapi` 필수 — `packages/server/openapi.json`과
  `packages/client/src/generated/api-schema.ts`는 커밋 산출물이며 **손으로 수정 금지**
  (서버·client의 드리프트 테스트가 어긋남을 실패로 강제). 응답은 반드시 클래스 DTO + @ApiOkResponse —
  interface/mapped type 반환은 스펙에서 빈 스키마가 됨 (스펙 테스트가 차단)
- **웹은 API 타입을 재선언하지 말고 `@nebula/client`만 소비** (드리프트 원인 소거).
  vite/vitest에서 CJS 워크스페이스 패키지는 optimizeDeps.include + commonjsOptions.include +
  test.server.deps.inline 3종에 등록해야 named import가 동작

## 빌드·테스트 함정 (겪은 것들)

- **TypeScript 5.9 고정** — TS 7(네이티브)은 ts-jest 비호환 + 구 tsconfig 옵션 제거로 실패. 올리지 말 것
- **Nest 12는 ESM** — 런타임은 Node 24 require(esm)으로 동작하지만, Jest는
  `NODE_OPTIONS='--experimental-vm-modules'` 필요 (test 스크립트에 이미 포함)
- pnpm은 루트 `node_modules`에 심볼릭 링크를 안 둠 — 스크래치 스크립트에서 모듈 require 시
  `packages/server/node_modules/...` 경로 사용
- 스모크 테스트: 서버를 `DB_PATH=':memory:'`로 띄우고 가짜 Agent(ws 클라이언트)로 register→occupy→release 검증

## 현재 상태 (2026-09-08)

- **Phase 1 완료**: 서버(occupy/release/레지스트리/인증/하트비트 만료/rate limit) + Agent(기기 발견,
  WS 터널, 백오프 재연결, ping keepalive). 리뷰(내부 Opus + Codex) HIGH 전부 반영
- **Phase 2 파이프라인 완료**: `POST /devices/:id/actions/{tap,swipe,type,ui-dump}` → 게이트웨이
  sendCommand(requestId 상관, 15초 타임아웃) → Agent CommandExecutor → Controller HTTP.
  가짜 Controller로 e2e 검증 완료. 프로토콜은 `@nebula/shared`로 추출됨
- **Phase 2 실기기 검증 완료** (2026-09-07, wincrane2/iOS 26.6.1): 자동 발견 → 점유 → 서버 API
  탭·스와이프·UI 덤프 전 구간 실동작. 실측 확정 사실: devicectl JSON은
  `hardwareProperties.platform`('iOS')만 있고 `platformIdentifier` 없음 / XCUITest 러너의
  `DispatchQueue.main.sync` 라우팅은 XCTWaiter 대기 중 정상 드레인됨 / codesign은 GUI 세션에서
  키체인 "항상 허용" 1회 후 비대화형 셸에서도 동작 (errSecInternalComponent 예방)
- **Phase 2.5 완료** (2026-09-07 실기기 검증): `ControllerSupervisor`가 기기별 xcodebuild 러너 +
  iproxy 자동 기동·헬스 폴링·백오프 재기동 (강제 kill → 2초 복구 실측). 준비 기기는
  `controller-ready` 태그. 활성화는 `NEBULA_XCODEBUILD_ENABLED=true`. 기기 없이 개발할 땐
  `NEBULA_STATIC_DEVICES`. 미검증 잔여: 7일 재서명 자동 갱신(시간 경과 필요)
- **Phase 3 완료 (H.264 미러링, 원문 방식)**: 실측 **40fps/8KB/frame**. 파이프라인:
  mirror-helper(캡처 장치→VideoToolbox H.264) → Agent H264Stream(stdout 패킷 파싱) →
  터널 바이너리 프레임 → StreamsRelay → 브라우저 WebCodecs. **H.264 단독** — Agent가 기기 발견
  주기마다 상시 구동(pre-warm), JPEG 스크린샷 폴백·서버 스트림 제어(startStream/stopStream)는
  제거됨 (느려서 폐기, 2026-09-07). 헬퍼 미설정 시 미러링 비활성. **macOS 26 함정 (실측)**: ① iOS 캡처 장치가
  DiscoverySession에 안 보임 → CMIO 열거로 UID 얻어 `AVCaptureDevice(uniqueID:)` 직접 열기
  ② 최초 발행이 QuickTime 소스 열람으로 트리거됨 — 발행 후엔 QuickTime 종료해도 유지되나
  **콜드 스타트(재연결·재부팅) 자가 발행 미검증** (안 되면 QuickTime 활성화 킥 필요, 백로그).
  탭 좌표는 pt 기준이라 웹이 점유 직후 스크린샷 1회로 pt 크기 확보 후 비율 환산
- **Phase 4 완료** (2026-09-08): ① 점유 sliding TTL (알려진 이슈였던 "occupantId 분실 시 영구 잠김"
  해소 — 위 "서버 핵심 규칙" 참고) ② OpenAPI 파이프라인 + `@nebula/client`(웹 수렴) + `nebula` CLI
  ③ launchd 상시 데몬(`scripts/daemon.sh`) + 서버 크래시 안전망. **launchd 실설치 검증은 미실시**
- **성능 실측** (2026-09-08, 순차·localhost): 저장소 renewOccupation 0.02ms / 서버+터널 오버헤드
  p50 4.4ms(가짜 Controller) / 실기기 탭 왕복 p50 **301ms** (저수준 이벤트 합성 도입 전 755ms —
  controller-ios/README 참고), ui-dump 397ms, screenshot 202ms / 미러링 53~59fps.
  탭의 남은 ~250ms는 XCTest 이벤트 합성 XPC 내부 — 원문 52ms까지는 미달 (후속 과제)
- **러너 이벤트 경로**: 탭·스와이프는 EventSynthesizer(비공개 API) 우선 + XCUI 폴백.
  completion 블록은 `(Bool, NSError?)` — 시그니처 다르면 SIGSEGV (실기기 크래시 리포트로 확정,
  Xcode/iOS 업그레이드 시 재검증 필요)
- **Phase 5 완료 (Android 지원, 전부 자체 개발)** (2026-09-10 실기기 검증, ZFold8/SM-F971N/Android 17):
  원문(토스) 방식대로 자체 개발 — 제어는 커스텀 instrumentation APK(ADB+UiAutomation, 의존성 0,
  자체 HTTP 서버가 iOS와 동일 계약), 미러링은 app_process(shell UID) 데몬(hidden
  `DisplayManager.createVirtualDisplay` + MediaCodec H.264 → 자체 프로토콜). 발견은
  플랫폼별 DiscoverySource 합성. **실측**: 탭 왕복 p50 **31.9ms**(원문 59ms·iOS 301ms 대비),
  ui-dump 31ms, screenshot 62ms, 미러링 50~65fps, 러너 강제 종료 복구 9초.
  한글 입력 IME 없이 ACTION_SET_TEXT로 동작. 접힘↔펼침 해상도 전환(1248×1972↔2448×1848)은
  DisplayProbe 폴링이 감지해 세션 자동 재구성. hidden API 지원은 보유 기기 조합만
  (android-controller/README '지원 기기'). **미검증**: 웹 브라우저 디코더의 펼침 전환 육안 확인,
  다른 삼성/제조사 빌드에서의 hidden API 존재
- **Android 튜닝 env** (2026-09-10): 수퍼바이저·미러·러너 타이밍 23개를 `NEBULA_ANDROID_*`로 노출.
  device-side(미러 데몬·러너)는 Agent가 app_process/`am instrument -e` 인자로 전달 (.env.example 참고)
- **실기기 연결 참고 (iOS)**: iOS 발견은 `tunnelState`로 실연결 판정 — `pairingState`는 USB 분리 후에도
  'paired'로 남아 유령 online을 만들어서 (2026-09-10 수정). 연결된 기기의 tunnelState 값은 재연결 시 확인 필요
- **실기기 연결 참고**: devicectl·usbmuxd·XCUITest는 Wi-Fi로도 동작 (실제로 무선으로 전 파이프라인
  동작 확인됨). 단 미러링 캡처 장치는 USB 필수였음
- **리뷰 백로그(MEDIUM)**: 서버 heartbeat 미매칭 무시, 두 오프라인 경로 `agent_id` 불일치,
  Controller HTTP 직렬 큐 head-of-line(캡처 중 /health 지연 → 수퍼바이저 오탐 재기동 가능),
  스크린샷 인코딩이 러너 메인 스레드 점유, 수퍼바이저·헬퍼 재기동 상한/서킷 브레이커 부재,
  iproxy만 죽어도 러너 전체 재빌드, 재기동 경로 포트 쿨다운 미적용, 서버→Agent 방향 keepalive 부재,
  백오프 지터 없음, 7일 프로비저닝 만료가 무한 재기동 루프로 귀결(식별·알림 없음),
  launchd 데몬 로그 로테이션 없음, mirror-helper --name 매칭(동명 기기 구분 불가 — --udid 미구현),
  agent 테스트가 nx 병렬 실행에서 간헐 플레이크(단독 실행은 항상 그린 — 타이밍 계열 추정, 미확정)

## 이 프로젝트만의 주의

- Apple 서명: 무료 Apple ID 사용 — XCUITest 러너 프로비저닝 7일 만료.
  Agent가 `xcodebuild -allowProvisioningUpdates`로 주기 재서명하는 방향 (GUI 없이 되는지 미검증)
- Agent WS 메시지 프로토콜(`register`/`heartbeat`)이 server·agent 양쪽에 생기면
  `packages/shared`로 타입 추출할 것 (지금은 server에만 있어 보류)
