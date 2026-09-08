#!/usr/bin/env bash
# launchd용 Agent 기동 래퍼 — .env에 없는 수퍼바이저·미러링 키만 저장소 기준 기본값 주입
# (scripts/dev.sh의 agent_env_default와 동일 정책 — .env에 명시된 값은 절대 덮지 않음)
# 이게 없으면 launchd 데몬은 기기를 발견만 하고 Controller를 안 띄워 조작이 불가능해짐
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
agent_dir="$repo_root/packages/agent"

env_default() {
  local key="$1" value="$2"
  if ! grep -q "^${key}=" "$agent_dir/.env" 2>/dev/null; then
    export "$key=$value"
  fi
}

env_default NEBULA_XCODEBUILD_ENABLED true
env_default NEBULA_CONTROLLER_PROJECT "$repo_root/controller-ios/NebulaController.xcodeproj"

helper_bin="$repo_root/mirror-helper/.build/debug/mirror-helper"
if [ -x "$helper_bin" ]; then
  env_default NEBULA_MIRROR_HELPER "$helper_bin"
fi

cd "$agent_dir"
# NEBULA_NODE는 daemon.sh install이 plist에 심음 (launchd PATH에 nvm 등이 없을 수 있음)
exec "${NEBULA_NODE:-node}" --env-file-if-exists=.env dist/main.js
