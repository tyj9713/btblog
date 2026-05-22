#!/usr/bin/env bash
# 固定 Cloudflare Tunnel：与 Azure 手工验证一致的启动方式
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
RUNTIME_DIR="${ARGO_RUNTIME_DIR:-$SCRIPT_DIR}"
cd "$RUNTIME_DIR"

if [ -f "${RUNTIME_DIR}/named-tunnel.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "${RUNTIME_DIR}/named-tunnel.env"
  set +a
fi

LOG="${RUNTIME_DIR}/named-tunnel.log"
PID_FILE="${RUNTIME_DIR}/named-tunnel.pid"
TOKEN="${CLOUDFLARE_TUNNEL_TOKEN:-${APPSETTING_CLOUDFLARE_TUNNEL_TOKEN:-}}"
LOCAL_CONFIG="${CLOUDFLARE_TUNNEL_LOCAL_CONFIG:-${APPSETTING_CLOUDFLARE_TUNNEL_LOCAL_CONFIG:-false}}"
CONFIG_FILE="${RUNTIME_DIR}/cloudflared-config.yml"
BIN="${RUNTIME_DIR}/cloudflared-linux"

timestamp_iso() {
  date -Iseconds 2>/dev/null || date -u '+%Y-%m-%dT%H:%M:%SZ'
}

log() {
  echo "[$(timestamp_iso)] $*" | tee -a "$LOG"
}

stop_old() {
  if [ -f "$PID_FILE" ]; then
    old_pid="$(tr -d '\r\n' < "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$old_pid" ] && kill -0 "$old_pid" >/dev/null 2>&1; then
      kill -9 "$old_pid" >/dev/null 2>&1 || true
    fi
    rm -f "$PID_FILE"
  fi
  pkill -9 -f 'btblog-named-tunnel' >/dev/null 2>&1 || true
  pkill -9 -f "${RUNTIME_DIR}/cloudflared-linux tunnel" >/dev/null 2>&1 || true
  pkill -9 -f 'cloudflared-linux tunnel run' >/dev/null 2>&1 || true
  pkill -9 -f 'cloudflared-linux tunnel .*run' >/dev/null 2>&1 || true
}

tunnel_pgrep() {
  pgrep -af 'btblog-named-tunnel|cloudflared-linux tunnel' 2>/dev/null || true
}

is_running() {
  if [ -f "$PID_FILE" ]; then
    pid="$(tr -d '\r\n' < "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1; then
      return 0
    fi
  fi
  tunnel_pgrep | grep -q .
}

if [ -z "$TOKEN" ] && [ "${LOCAL_CONFIG,,}" != "true" ]; then
  log "CLOUDFLARE_TUNNEL_TOKEN 未设置，跳过固定隧道"
  exit 1
fi

if [ ! -x "$BIN" ]; then
  log "cloudflared-linux 不存在或不可执行: $BIN"
  exit 1
fi

stop_old
log "starting named tunnel in $RUNTIME_DIR"

start_cmd() {
  if command -v setsid >/dev/null 2>&1; then
    setsid nohup "$@" >>"$LOG" 2>&1 &
  else
    nohup "$@" >>"$LOG" 2>&1 &
  fi
  echo $! >"$PID_FILE"
  log "cloudflared pid=$(cat "$PID_FILE")"
}

if [ "${LOCAL_CONFIG,,}" = "true" ] && [ -f "$CONFIG_FILE" ]; then
  start_cmd "$BIN" tunnel --config "$CONFIG_FILE" --no-autoupdate run
else
  start_cmd env CLOUDFLARE_TUNNEL_TOKEN="$TOKEN" TUNNEL_TOKEN="$TOKEN" \
    "$BIN" tunnel --no-autoupdate run --token "$TOKEN"
fi

for _ in $(seq 1 20); do
  sleep 1
  if is_running; then
    log "named tunnel started: $(tunnel_pgrep | head -n 1 | tr -d '\r')"
    exit 0
  fi
done

log "named tunnel failed to start"
log "process list: $(tunnel_pgrep | tr '\n' '; ')"
rm -f "$PID_FILE"
tail -n 30 "$LOG" >&2 || true
exit 1
