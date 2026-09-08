/** 사용법 텍스트 — --help와 사용법 오류 시 출력 */
export const USAGE = `nebula — 디바이스 팜 CLI

사용법: nebula <커맨드> [플래그]

커맨드
  health                          서버 생존 확인
  devices list                    기기 목록
  devices get --device-id <id>    기기 상세
  devices occupy [--device-id <id>] [--platform ios] [--tags a,b]
  devices release                 점유 해제 (세션 또는 --occupant-id)
  devices keepalive               점유 활동 연장 (장시간 점유 유지)
  devices session [--clear]       저장된 점유 세션 확인/삭제
  tap --x <n> --y <n>             좌표 탭 (pt)
  swipe --from-x --from-y --to-x --to-y [--duration-ms 300]
  type --text <문자열>            텍스트 입력 (기기 키보드 포커스 필요)
  press --button home             하드웨어 버튼
  ui-dump [--out tree.txt]        접근성 트리 덤프
  screenshot [--out shot.jpg]     화면 캡처 (--out 없으면 --json에서만 base64 출력)

전역 플래그
  --server <url>       서버 주소 (env NEBULA_SERVER_URL, 기본 http://localhost:3000)
  --token <token>      클라이언트 토큰 (env NEBULA_CLIENT_TOKEN 권장 — ps 노출 방지)
  --device-id <id>     대상 기기 (미지정 시 저장된 세션의 기기)
  --occupant-id <id>   점유자 ID (미지정 시 env NEBULA_OCCUPANT_ID → 세션 파일)
  --json               결과를 JSON 원문으로 출력
  --timeout-ms <n>     요청 타임아웃 (기본 20000)
  --help               이 도움말

세션: devices occupy 성공 시 ~/.nebula/session.json(0600)에 저장,
      release 성공·점유 만료(403) 시 자동 정리. NEBULA_SESSION_FILE로 경로 변경.

종료 코드: 0 성공 / 1 일반 실패 / 2 사용법 / 3 인증·권한 / 4 없음·충돌 / 5 게이트웨이`;
