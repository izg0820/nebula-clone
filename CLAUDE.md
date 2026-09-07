# nebula-clone

토스 디바이스 팜 Nebula 클론 — **iOS 단독**, 실기기 구동이 목표.
배경·아키텍처 다이어그램·로드맵은 [README.md](./README.md) 참고. 이 파일은 작업 규칙과 불변식만 담는다.

## 배포 토폴로지 (설계 불변식)

- **오케스트레이션 서버**: 오라클 클라우드 (공인 IP 노출 — 보안 기본값은 항상 닫힘)
- **Agent**: 집 맥미니, NAT 뒤 → **Agent가 서버로 아웃바운드 WS 터널을 유지** (`/agent`).
  서버→Agent 방향으로 직접 접속하는 코드를 만들지 말 것. 명령·스트림 모두 이 터널 경유
- **기기**: iPhone 공기계 1대 (USB, Developer Mode 필요). Android는 범위 외
- **세션리스**: Appium식 세션 없음. 기기별 Controller(XCUITest 러너)는 상시 구동(pre-warm),
  모든 조작은 stateless HTTP. 세션 생성/관리 개념을 다시 들여오지 말 것

## 모노레포 구조 (Nx package-based + pnpm workspace)

```
packages/server   # @nebula/server — NestJS 오케스트레이션 (Phase 1 + 명령 프록시)
packages/agent    # @nebula/agent — 맥미니 데몬, plain TS — 프레임워크 금지
packages/shared   # @nebula/shared — WS 프로토콜·액션 타입 단일 정의 (server/agent 공용)
packages/web      # React 콘솔 (예정)
controller-ios/   # Swift/XCUITest + XcodeGen — pnpm workspace 밖 (빌드 미검증)
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
  오프라인 전환(`markAgentOffline`/`markStaleOffline`)은 반드시 점유도 함께 해제
- **WS 게이트웨이**: 연결 시 `NEBULA_AGENT_TOKEN` 검증(실패 4401), agentId 형식 `[A-Za-z0-9_-]{1,64}`(위반 4400),
  중복 agentId는 기존 소켓 4409 대체. disconnect 처리 전 "현행 소켓인지" 확인 필수
- **저장소 접근은 `DevicesRepository` 인터페이스로만** — Redis 등 교체 대비. 구현체 직접 주입 금지
- Swagger는 `ENABLE_DOCS=true`일 때만 (전역 가드를 타지 않는 Express 직등록 라우트라 무인증 노출됨)
- 환경 변수: `.env.example` 참고. 토큰 24자 미만·`change-me*`는 기동 거부가 정상 동작

## 빌드·테스트 함정 (겪은 것들)

- **TypeScript 5.9 고정** — TS 7(네이티브)은 ts-jest 비호환 + 구 tsconfig 옵션 제거로 실패. 올리지 말 것
- **Nest 12는 ESM** — 런타임은 Node 24 require(esm)으로 동작하지만, Jest는
  `NODE_OPTIONS='--experimental-vm-modules'` 필요 (test 스크립트에 이미 포함)
- pnpm은 루트 `node_modules`에 심볼릭 링크를 안 둠 — 스크래치 스크립트에서 모듈 require 시
  `packages/server/node_modules/...` 경로 사용
- 스모크 테스트: 서버를 `DB_PATH=':memory:'`로 띄우고 가짜 Agent(ws 클라이언트)로 register→occupy→release 검증

## 현재 상태 (2026-09-04)

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
- **Phase 2.5 남은 것**: Agent의 xcodebuild 수퍼바이저(기동·감시·재시작), iproxy 포워딩 관리,
  7일 재서명 자동화 검증. Controller 주소는 임시로 `NEBULA_CONTROLLER_PORTS` 정적 설정,
  기기 없이 개발할 땐 `NEBULA_STATIC_DEVICES` 사용. 러너 기동 절차는 controller-ios/README.md
- **리뷰 백로그(MEDIUM)**: 서버 heartbeat 미매칭 무시, 두 오프라인 경로 `agent_id` 불일치,
  토큰 쿼리스트링 허용, supertest e2e 부재, WS maxPayload 미설정, agentId 정규화 충돌

## 이 프로젝트만의 주의

- Apple 서명: 무료 Apple ID 사용 — XCUITest 러너 프로비저닝 7일 만료.
  Agent가 `xcodebuild -allowProvisioningUpdates`로 주기 재서명하는 방향 (GUI 없이 되는지 미검증)
- Agent WS 메시지 프로토콜(`register`/`heartbeat`)이 server·agent 양쪽에 생기면
  `packages/shared`로 타입 추출할 것 (지금은 server에만 있어 보류)
