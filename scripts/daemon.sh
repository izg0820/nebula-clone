#!/usr/bin/env bash
# Nebula 상시 데몬 관리 — launchd LaunchAgent로 서버·Agent를 로그인 시 자동 기동 + 크래시 시 재기동
#
# 사용:
#   scripts/daemon.sh install     # 빌드 → plist 설치 → 기동 (재실행 시 갱신)
#   scripts/daemon.sh uninstall   # 중지 + plist 제거
#   scripts/daemon.sh status      # 서비스 상태 (pid, 마지막 종료 코드)
#   scripts/daemon.sh restart     # 재기동
#
# 주의: scripts/dev.sh(개발 세션)와 동시 사용 불가 — dev.sh가 감지하고 거부함
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
launch_agents_dir="$HOME/Library/LaunchAgents"
services=(com.nebula.server com.nebula.agent)

blue() { printf '\033[1;34m[daemon]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[daemon]\033[0m %s\n' "$*" >&2; exit 1; }

is_loaded() {
  launchctl print "gui/$(id -u)/$1" >/dev/null 2>&1
}

do_install() {
  command -v node >/dev/null || fail "node 필요"
  command -v pnpm >/dev/null || fail "pnpm 필요"
  [ -f "$repo_root/packages/server/.env" ] || fail "packages/server/.env 없음 — .env.example 참고"
  [ -f "$repo_root/packages/agent/.env" ]  || fail "packages/agent/.env 없음 — .env.example 참고"
  # Agent는 agent-launch.sh가 수퍼바이저 기본값을 주입 — Controller 프로젝트가 없으면 조작 불가이므로 선검사
  if ! grep -q '^NEBULA_XCODEBUILD_ENABLED=' "$repo_root/packages/agent/.env" \
     && [ ! -d "$repo_root/controller-ios/NebulaController.xcodeproj" ]; then
    fail "controller-ios/NebulaController.xcodeproj 없음 — controller-ios에서 xcodegen generate 먼저 (또는 agent .env에 수퍼바이저 설정 명시)"
  fi

  blue "빌드 중..."
  (cd "$repo_root" && pnpm -s build >/dev/null) || fail "빌드 실패 — pnpm build로 확인"
  mkdir -p "$repo_root/.dev-logs" "$launch_agents_dir"

  local node_path
  node_path="$(command -v node)"
  for service in "${services[@]}"; do
    local template="$repo_root/deploy/launchd/$service.plist.template"
    local target="$launch_agents_dir/$service.plist"
    [ -f "$template" ] || fail "템플릿 없음: $template"
    # 재설치 시 기존 서비스 내리고 교체
    if is_loaded "$service"; then
      launchctl bootout "gui/$(id -u)/$service" 2>/dev/null || true
    fi
    sed -e "s|{{REPO}}|$repo_root|g" -e "s|{{NODE}}|$node_path|g" "$template" > "$target"
    launchctl bootstrap "gui/$(id -u)" "$target" || fail "$service bootstrap 실패"
    blue "$service 설치·기동 완료"
  done
  blue "로그: $repo_root/.dev-logs/daemon-{server,agent}.log"
  blue "상태 확인: scripts/daemon.sh status"
}

do_uninstall() {
  for service in "${services[@]}"; do
    if is_loaded "$service"; then
      launchctl bootout "gui/$(id -u)/$service" || true
      blue "$service 중지"
    fi
    rm -f "$launch_agents_dir/$service.plist"
  done
  blue "제거 완료"
}

do_status() {
  for service in "${services[@]}"; do
    if ! is_loaded "$service"; then
      blue "$service: 미설치"
      continue
    fi
    local info pid exit_code
    info="$(launchctl print "gui/$(id -u)/$service" 2>/dev/null)"
    pid="$(printf '%s' "$info" | awk '/^\tpid = /{print $3}')"
    exit_code="$(printf '%s' "$info" | awk '/last exit code/{print $NF}')"
    blue "$service: pid=${pid:-없음(대기)} last-exit=${exit_code:--}"
  done
}

do_restart() {
  for service in "${services[@]}"; do
    is_loaded "$service" || fail "$service 미설치 — scripts/daemon.sh install 먼저"
    launchctl kickstart -k "gui/$(id -u)/$service"
    blue "$service 재기동"
  done
}

command="${1:-}"
if [ "$command" = "install" ];   then do_install;   exit 0; fi
if [ "$command" = "uninstall" ]; then do_uninstall; exit 0; fi
if [ "$command" = "status" ];    then do_status;    exit 0; fi
if [ "$command" = "restart" ];   then do_restart;   exit 0; fi
fail "사용법: scripts/daemon.sh install|uninstall|status|restart"
