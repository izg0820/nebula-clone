# @nebula/cli — `nebula` 커맨드

`@nebula/client` SDK 위에 구축한 디바이스 팜 CLI. 의존성 없는 `node:util` parseArgs 사용.

## 실행

워크스페이스에서는 루트 스크립트가 1순위 (bin 링크는 워크스페이스에 안 걸림):

```bash
pnpm cli devices list                        # 루트에서 (권장)
pnpm --filter @nebula/cli start -- health    # 대안
```

## 설정

| 항목 | 플래그 | 환경 변수 | 기본값 |
|---|---|---|---|
| 서버 주소 | `--server` | `NEBULA_SERVER_URL` | `http://localhost:3000` |
| 토큰 | `--token` | `NEBULA_CLIENT_TOKEN` | (필수 — health 제외) |
| 요청 타임아웃 | `--timeout-ms` | — | 20000 |
| 세션 파일 | — | `NEBULA_SESSION_FILE` | `~/.nebula/session.json` |

⚠ `--token`은 `ps`에 노출되므로 환경 변수 사용 권장. 토큰은 어떤 출력에도 실리지 않음.

## 커맨드

| 커맨드 | 플래그 | 설명 |
|---|---|---|
| `health` | — | 서버 생존 확인 (무인증) |
| `devices list` | — | 기기 목록 |
| `devices get` | `--device-id` | 기기 상세 |
| `devices occupy` | `--device-id` `--platform` `--tags a,b` | 점유 + 세션 저장 |
| `devices release` | (세션) | 해제 + 세션 삭제 |
| `devices keepalive` | (세션) | 점유 활동 연장 — 명령 없이 오래 점유할 때 |
| `devices session` | `--clear` | 저장된 세션 확인/삭제 |
| `tap` | `--x` `--y` | 좌표 탭 (pt) |
| `swipe` | `--from-x/y` `--to-x/y` `--duration-ms` | 스와이프 (기본 300ms) |
| `type` | `--text` | 텍스트 입력 (기기 키보드 포커스 필요) |
| `press` | `--button home` | 하드웨어 버튼 |
| `ui-dump` | `--out tree.txt` | 접근성 트리 (미지정 시 stdout) |
| `screenshot` | `--out shot.jpg` | 캡처 저장 — `--out` 없이는 `--json`만 허용 (base64를 터미널에 쏟지 않음) |

공통: `--json`(원문 JSON 한 줄 출력), `--help`.

## 점유 세션

- `devices occupy` 성공 시 `~/.nebula/session.json`(디렉터리 0700 / 파일 0600 —
  occupantId는 해제 권한 비밀값)에 **활성 점유 1건** 저장
- 이후 커맨드는 `--device-id`/`--occupant-id` 생략 가능
- occupantId 해석 우선순위: `--occupant-id` > `NEBULA_OCCUPANT_ID` > 세션 파일(같은 서버일 때만)
- 서버가 403(점유 만료·불일치)을 주면 세션을 자동 정리 — `devices occupy`로 다시 점유
- 점유는 sliding TTL(기본 10분) — 명령이 곧 활동이고, 명령 없이 유지하려면 `devices keepalive`

## 종료 코드

| 코드 | 의미 |
|---|---|
| 0 | 성공 |
| 1 | 일반 실패 (네트워크·타임아웃·예상 못한 예외) |
| 2 | 사용법 오류 (커맨드·플래그·값 형식) |
| 3 | 인증·권한 (401/403/429) |
| 4 | 대상 없음·충돌 (404/409) |
| 5 | 게이트웨이 (502/504 — Agent·기기 실패) |
