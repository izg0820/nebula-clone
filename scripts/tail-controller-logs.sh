#!/usr/bin/env bash

set -euo pipefail
shopt -s nullglob

log_dir="${NEBULA_CONTROLLER_LOG_DIR:-$HOME/.nebula/logs}"
mkdir -p "$log_dir"

echo "iOS Controller 로그를 기다리는 중입니다: $log_dir"

while true; do
  log_files=("$log_dir"/controller-*.log)
  if ((${#log_files[@]} > 0)); then
    exec tail -n 100 -F "${log_files[@]}"
  fi
  sleep 1
done
