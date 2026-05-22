#!/usr/bin/env bash
set -euo pipefail

# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/common.sh"

action="${ACTION:-}"
case "$action" in
  start)
    bash "${RUNTIME_DIR}/nezha.sh"
    ;;
  restart)
    pkill -9 nezha-agent >/dev/null 2>&1 || true
    bash "${RUNTIME_DIR}/nezha.sh"
    ;;
  stop)
    pkill -9 nezha-agent >/dev/null 2>&1 || true
    ;;
  *)
    echo "ACTION 必须是 start|restart|stop" >&2
    exit 1
    ;;
esac
