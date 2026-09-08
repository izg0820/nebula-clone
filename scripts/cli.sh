#!/usr/bin/env bash
# nebula CLI 실행 래퍼 — fresh checkout(dist 없음)에서도 pnpm cli가 동작하게 최초 1회 빌드
# 빌드 출력은 stderr로 보냄: stdout은 CLI 결과 전용 (--json 파이프 오염 방지)
# dist가 이미 있으면 빌드 생략 — 소스 수정 후에는 pnpm build로 갱신할 것
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
cli_entry="$repo_root/packages/cli/dist/main.js"

if [ ! -f "$cli_entry" ]; then
  echo "[cli] 최초 빌드 중 (@nebula/client → @nebula/cli)..." >&2
  (cd "$repo_root" && pnpm -s --filter @nebula/client build && pnpm -s --filter @nebula/cli build) >&2
fi

exec node "$cli_entry" "$@"
