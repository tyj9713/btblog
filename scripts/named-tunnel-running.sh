#!/usr/bin/env bash
set -euo pipefail

# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/common.sh"

PID_FILE="${RUNTIME_DIR}/named-tunnel.pid"
if [ -f "$PID_FILE" ]; then
  pid="$(tr -d '\r\n' < "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1; then
    ps -p "$pid" -o pid=,comm=,args= 2>/dev/null || ps -ef | grep -E "^[[:space:]]*${pid}[[:space:]]" || true
    exit 0
  fi
fi

checks=(
  'btblog-named-tunnel'
  'cloudflared-linux tunnel'
  "${RUNTIME_DIR}/cloudflared-linux tunnel"
)

for pattern in "${checks[@]}"; do
  if pgrep -f "$pattern" >/dev/null 2>&1; then
    pgrep -af "$pattern" || true
    exit 0
  fi
done
