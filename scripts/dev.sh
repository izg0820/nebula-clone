#!/usr/bin/env bash
# Nebula 전체 스택 원커맨드 실행 — 서버 → Agent → 웹 콘솔 (tmux 불필요, 로그는 한 화면에)
#
# 사용:
#   scripts/dev.sh          # 실기기 모드 (수퍼바이저 + H.264 미러링)
#   scripts/dev.sh --fake   # 기기 없이 — 정적 기기 1대로 서버·웹 파이프라인만
#
# 종료: Ctrl-C 한 번 (서버·Agent·웹 전부 정리, Agent는 자식 프로세스까지 정리)
#
# 전제: packages/server/.env, packages/agent/.env 존재 (.env.example 참고)
#   - agent .env에 수퍼바이저/미러링 설정이 없으면 저장소 기준 기본값을 자동 주입
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
logs_dir="$repo_root/.dev-logs"
mode="${1:-real}"

blue()  { printf '\033[1;34m[dev]\033[0m %s\n' "$*"; }
fail()  { printf '\033[1;31m[dev]\033[0m %s\n' "$*" >&2; exit 1; }

command -v pnpm >/dev/null || fail "pnpm 필요"
command -v node >/dev/null || fail "node 필요"
[ -f "$repo_root/packages/server/.env" ] || fail "packages/server/.env 없음 — cp .env.example .env 후 토큰 설정 (openssl rand -hex 32, 두 토큰은 서로 다르게)"
[ -f "$repo_root/packages/agent/.env" ]  || fail "packages/agent/.env 없음 — cp .env.example .env 후 서버 주소·토큰 설정"

# ── agent .env에 없는 키만 기본값 주입 (node --env-file은 이미 설정된 환경변수를 덮지 않음) ──
agent_env_default() {
  local key="$1" value="$2"
  if ! grep -q "^${key}=" "$repo_root/packages/agent/.env"; then
    export "$key=$value"
  fi
}

if [ "$mode" = "--fake" ]; then
  blue "가짜 기기 모드 — 수퍼바이저·미러링 비활성"
  export NEBULA_STATIC_DEVICES='[{"id":"fake-1","name":"Fake iPhone","osVersion":"26.0","tags":["fake"]}]'
  export NEBULA_XCODEBUILD_ENABLED=''
  export NEBULA_MIRROR_HELPER=''
else
  agent_env_default NEBULA_XCODEBUILD_ENABLED true
  agent_env_default NEBULA_CONTROLLER_PROJECT "$repo_root/controller-ios/NebulaController.xcodeproj"

  # mirror-helper — 없으면 빌드 시도, 실패해도 미러링만 빠진 채 진행
  helper_bin="$repo_root/mirror-helper/.build/debug/mirror-helper"
  if [ ! -x "$helper_bin" ] && command -v swift >/dev/null; then
    blue "mirror-helper 빌드 중..."
    (cd "$repo_root/mirror-helper" && swift build) || blue "mirror-helper 빌드 실패 — 미러링 없이 진행"
  fi
  if [ -x "$helper_bin" ]; then
    agent_env_default NEBULA_MIRROR_HELPER "$helper_bin"
  else
    blue "mirror-helper 미설치 — 미러링 비활성 (조작·UI 덤프는 동작)"
  fi

  # xcodeproj — 없으면 xcodegen으로 생성 (local.yml에 Team ID 필요)
  if [ ! -d "$repo_root/controller-ios/NebulaController.xcodeproj" ]; then
    [ -f "$repo_root/controller-ios/local.yml" ] || fail "controller-ios/local.yml 없음 — cp local.yml.example local.yml 후 Team ID 기입"
    command -v xcodegen >/dev/null || fail "xcodegen 필요 (brew install xcodegen)"
    blue "NebulaController.xcodeproj 생성 중..."
    (cd "$repo_root/controller-ios" && xcodegen generate)
  fi
fi

# ── launchd 데몬과 상호배제 — sweep이 데몬을 죽여도 launchd가 즉시 되살려 포트 경합이 됨 ──
for daemon_service in com.nebula.server com.nebula.agent; do
  if launchctl print "gui/$(id -u)/$daemon_service" >/dev/null 2>&1; then
    fail "launchd 데몬($daemon_service)이 실행 중 — scripts/daemon.sh uninstall 후 dev.sh 사용"
  fi
done

# ── 이전 스택 정리 — 재실행 시 기존 실행분을 전부 종료하고 새로 시작 ──
mkdir -p "$logs_dir"
pid_file="$logs_dir/dev.pid"

find_stack_pids() {
  # cwd가 packages/* 인 프로세스만 종료 대상 — 저장소 루트에서 도는 에디터·다른 도구 오인 종료 방지
  # -a 필수: 없으면 lsof가 -c/-d를 OR로 묶어 node 프로세스의 열린 파일 전부가 딸려 나옴
  lsof -nP -a -d cwd -c node -c mirror-helper -c iproxy -c xcodebuild 2>/dev/null |
    awk -v s="$repo_root/packages/server" \
        -v a="$repo_root/packages/agent" \
        -v w="$repo_root/packages/web" \
        '$NF == s || $NF == a || $NF == w { print $2 }' | sort -u || true
}

wait_stack_gone() {
  local max_ticks="$1"
  for _ in $(seq 1 "$max_ticks"); do
    [ -z "$(find_stack_pids)" ] && return 0
    sleep 0.1
  done
  return 1
}

stop_previous_stack() {
  # ① 이전 dev.sh가 살아 있으면 INT — 자체 trap이 서버·Agent(러너·iproxy·헬퍼 포함)까지 정리
  if [ -f "$pid_file" ]; then
    local prev_pid
    prev_pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [ -n "$prev_pid" ] && kill -0 "$prev_pid" 2>/dev/null \
       && ps -o command= -p "$prev_pid" 2>/dev/null | grep -q 'dev\.sh'; then
      blue "이전 dev.sh(pid $prev_pid) 종료 중..."
      kill -INT "$prev_pid" 2>/dev/null || true
      for _ in $(seq 1 150); do kill -0 "$prev_pid" 2>/dev/null || break; sleep 0.1; done
    fi
    rm -f "$pid_file"
  fi

  # ② 남은(고아 포함) 스택 프로세스 — TERM 후 graceful 대기, 안 죽으면 KILL
  local leftover pid
  leftover="$(find_stack_pids)"
  [ -z "$leftover" ] && return 0
  blue "기존 스택 프로세스 종료: $(echo "$leftover" | tr '\n' ' ')"
  for pid in $leftover; do kill "$pid" 2>/dev/null || true; done
  wait_stack_gone 80 && return 0
  for pid in $(find_stack_pids); do kill -9 "$pid" 2>/dev/null || true; done
  wait_stack_gone 20 || fail "기존 스택 프로세스가 종료되지 않음 — 수동 확인 필요 (lsof -d cwd로 packages/* 프로세스 확인)"
}

stop_previous_stack
echo $$ > "$pid_file"

# ── 포트 선점 검사 — 정리 후에도 잡혀 있으면 이 스택이 아닌 다른 프로세스 → 죽이지 않고 실패 ──
require_port_free() {
  local port="$1" owner
  owner="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | tail -n +2 | head -1 || true)"
  if [ -n "$owner" ]; then
    fail "포트 $port 이미 사용 중 (이 스택 아님 — 임의 종료 안 함) → $owner"
  fi
}

server_port="$(grep '^PORT=' "$repo_root/packages/server/.env" | cut -d= -f2 || true)"
server_port="${server_port:-3000}"
require_port_free "$server_port"
require_port_free 5173

# ── 빌드 ──────────────────────────────────────────────
blue "빌드 중 (shared·server·agent·web)..."
(cd "$repo_root" && pnpm -s build >/dev/null) || fail "빌드 실패 — pnpm build로 확인"

pids=()

cleanup() {
  trap - INT TERM EXIT
  blue "종료 중... (Agent가 러너·iproxy·헬퍼를 정리할 때까지 잠시 대기)"
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  # Agent의 graceful shutdown(최대 5초) 대기
  for pid in "${pids[@]}"; do
    for _ in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  done
  rm -f "$pid_file"
  blue "정리 완료"
}
trap cleanup INT TERM EXIT

# ── 서버 ──────────────────────────────────────────────
blue "서버 기동 (:$server_port)..."
(cd "$repo_root/packages/server" && exec node dist/main.js) > "$logs_dir/server.log" 2>&1 &
pids+=($!)

server_ready=false
for _ in $(seq 1 40); do
  if curl -sf "http://localhost:$server_port/health" >/dev/null 2>&1; then
    server_ready=true
    break
  fi
  sleep 0.5
done
[ "$server_ready" = true ] || fail "서버 health 응답 없음 — $logs_dir/server.log 확인 (토큰 검증 실패가 흔한 원인)"

# ── Agent ─────────────────────────────────────────────
blue "Agent 기동..."
(cd "$repo_root/packages/agent" && exec node --env-file-if-exists=.env dist/main.js) > "$logs_dir/agent.log" 2>&1 &
pids+=($!)

# ── 웹 콘솔 ───────────────────────────────────────────
blue "웹 콘솔 기동 (:5173)..."
(cd "$repo_root/packages/web" && exec npx vite --port 5173 --strictPort) > "$logs_dir/web.log" 2>&1 &
pids+=($!)

client_token="$(grep '^NEBULA_CLIENT_TOKEN=' "$repo_root/packages/server/.env" | cut -d= -f2)"
echo
blue "──────────────────────────────────────────────"
blue "웹 콘솔:        http://localhost:5173"
blue "  설정 패널에 입력 → 서버 주소 http://localhost:$server_port"
blue "  클라이언트 토큰: $client_token"
blue "서버 API:       http://localhost:$server_port"
blue "로그:           $logs_dir/{server,agent,web}.log"
blue "종료:           Ctrl-C"
blue "──────────────────────────────────────────────"
echo

# 세 로그를 한 화면에 스트리밍 — 백그라운드 + wait여야 Ctrl-C/kill 시 trap이 즉시 실행됨
# (tail을 포그라운드로 두면 스크립트만 시그널을 받았을 때 trap이 tail 종료까지 지연되어 자식이 샘)
tail -n +1 -F "$logs_dir/server.log" "$logs_dir/agent.log" "$logs_dir/web.log" &
pids+=($!)
wait $! || true
