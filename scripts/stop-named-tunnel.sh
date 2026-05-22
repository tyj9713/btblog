#!/usr/bin/env bash
set -euo pipefail

# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/common.sh"

PID_FILE="${RUNTIME_DIR}/named-tunnel.pid"
if [ -f "$PID_FILE" ]; then
  pid="$(tr -d '\r\n' < "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$pid" ]; then
    kill -9 "$pid" >/dev/null 2>&1 || true
  fi
  rm -f "$PID_FILE"
fi

pkill -9 -f 'btblog-named-tunnel' >/dev/null 2>&1 || true
pkill -9 -f "${RUNTIME_DIR}/cloudflared-linux tunnel" >/dev/null 2>&1 || true
pkill -9 -f 'cloudflared-linux tunnel run' >/dev/null 2>&1 || true
pkill -9 -f 'cloudflared-linux tunnel .*run' >/dev/null 2>&1 || true
