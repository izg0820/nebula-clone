#!/usr/bin/env bash

set -euo pipefail

session_name="${NEBULA_TMUX_SESSION:-nebula}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
action="${1:-start}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "필수 명령을 찾을 수 없습니다: $1" >&2
    exit 1
  fi
}

session_exists() {
  tmux has-session -t "$session_name" 2>/dev/null
}

attach_session() {
  if [[ -n "${TMUX:-}" ]]; then
    tmux switch-client -t "$session_name"
  else
    exec tmux attach-session -t "$session_name"
  fi
}

stop_session() {
  if ! session_exists; then
    echo "tmux 세션이 실행 중이 아닙니다: $session_name"
    return
  fi

  # Agent가 SIGINT를 받아 xcodebuild와 iproxy를 정리할 시간을 준다.
  while IFS= read -r pane_id; do
    tmux send-keys -t "$pane_id" C-c
  done < <(tmux list-panes -s -t "$session_name" -F '#{pane_id}')

  sleep 2
  tmux kill-session -t "$session_name" 2>/dev/null || true
  echo "tmux 세션을 종료했습니다: $session_name"
}

start_session() {
  require_command tmux
  require_command pnpm

  local missing_env=0
  for env_file in packages/server/.env packages/agent/.env; do
    if [[ ! -f "$repo_root/$env_file" ]]; then
      echo "환경 설정 파일이 없습니다: $env_file" >&2
      echo "  cp $env_file.example $env_file" >&2
      missing_env=1
    fi
  done
  if ((missing_env)); then
    exit 1
  fi

  local controller_project="$repo_root/controller-ios/NebulaController.xcodeproj"
  local mirror_helper="$repo_root/mirror-helper/.build/debug/mirror-helper"
  if [[ ! -d "$controller_project" ]]; then
    echo "생성된 iOS Controller 프로젝트가 없습니다: $controller_project" >&2
    echo "  (cd controller-ios && xcodegen generate)" >&2
    exit 1
  fi
  if [[ ! -x "$mirror_helper" ]]; then
    echo "빌드된 미러링 헬퍼가 없습니다: $mirror_helper" >&2
    echo "  swift build --package-path mirror-helper" >&2
    exit 1
  fi

  if session_exists; then
    echo "기존 tmux 세션에 연결합니다: $session_name"
    attach_session
    return
  fi

  local server_pane agent_pane web_pane controller_log_pane agent_command
  printf -v agent_command \
    'NEBULA_XCODEBUILD_ENABLED=true NEBULA_CONTROLLER_PROJECT=%q NEBULA_MIRROR_HELPER=%q pnpm nx run @nebula/agent:start:dev' \
    "$controller_project" "$mirror_helper"

  server_pane="$(tmux new-session -d -P -F '#{pane_id}' \
    -s "$session_name" -n dev -c "$repo_root" \
    'pnpm nx run @nebula/server:start:dev')"
  agent_pane="$(tmux split-window -h -P -F '#{pane_id}' \
    -t "$server_pane" -c "$repo_root" \
    "$agent_command")"
  web_pane="$(tmux split-window -v -P -F '#{pane_id}' \
    -t "$server_pane" -c "$repo_root" \
    'pnpm nx run @nebula/web:start:dev')"
  controller_log_pane="$(tmux split-window -v -P -F '#{pane_id}' \
    -t "$agent_pane" -c "$repo_root" \
    'bash scripts/tail-controller-logs.sh')"

  tmux select-pane -t "$server_pane" -T server
  tmux select-pane -t "$agent_pane" -T agent
  tmux select-pane -t "$web_pane" -T web
  tmux select-pane -t "$controller_log_pane" -T controller
  tmux set-option -t "$session_name" remain-on-exit on
  tmux set-option -t "$session_name" pane-border-status top
  tmux set-option -t "$session_name" pane-border-format ' #{pane_title} '
  tmux select-layout -t "$session_name:dev" tiled >/dev/null
  tmux select-pane -t "$server_pane"

  attach_session
}

case "$action" in
  start)
    start_session
    ;;
  stop)
    require_command tmux
    stop_session
    ;;
  restart)
    require_command tmux
    stop_session
    start_session
    ;;
  *)
    echo "사용법: $0 [start|stop|restart]" >&2
    exit 2
    ;;
esac
