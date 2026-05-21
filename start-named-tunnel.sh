#!/usr/bin/env bash
# 固定 Cloudflare Tunnel：与 Azure 手工验证一致的启动方式
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
RUNTIME_DIR="${ARGO_RUNTIME_DIR:-$SCRIPT_DIR}"
cd "$RUNTIME_DIR"

LOG="${RUNTIME_DIR}/named-tunnel.log"
TOKEN="${CLOUDFLARE_TUNNEL_TOKEN:-${APPSETTING_CLOUDFLARE_TUNNEL_TOKEN:-}}"
LOCAL_CONFIG="${CLOUDFLARE_TUNNEL_LOCAL_CONFIG:-${APPSETTING_CLOUDFLARE_TUNNEL_LOCAL_CONFIG:-false}}"
CONFIG_FILE="${RUNTIME_DIR}/cloudflared-config.yml"
BIN="${RUNTIME_DIR}/cloudflared-linux"

log() {
  echo "[$(date -Iseconds)] $*" | tee -a "$LOG"
}

stop_old() {
  pkill -9 -f 'btblog-named-tunnel' >/dev/null 2>&1 || true
  pkill -9 -f 'cloudflared-linux tunnel run' >/dev/null 2>&1 || true
  pkill -9 -f './cloudflared-linux tunnel run' >/dev/null 2>&1 || true
}

is_running() {
  pgrep -f 'btblog-named-tunnel' >/dev/null 2>&1 || pgrep -f 'cloudflared-linux tunnel run' >/dev/null 2>&1
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

quoted_log=$(printf '%q' "$LOG")
quoted_bin=$(printf '%q' "$BIN")
quoted_config=$(printf '%q' "$CONFIG_FILE")

if [ "${LOCAL_CONFIG,,}" = "true" ] && [ -f "$CONFIG_FILE" ]; then
  nohup bash -c "exec -a btblog-named-tunnel ${quoted_bin} tunnel --config ${quoted_config} run --no-autoupdate >> ${quoted_log} 2>&1" >/dev/null 2>&1 &
else
  quoted_token=$(printf '%q' "$TOKEN")
  nohup bash -c "exec -a btblog-named-tunnel env CLOUDFLARE_TUNNEL_TOKEN=${quoted_token} TUNNEL_TOKEN=${quoted_token} ${quoted_bin} tunnel run --no-autoupdate >> ${quoted_log} 2>&1" >/dev/null 2>&1 &
fi

for _ in $(seq 1 15); do
  sleep 1
  if is_running; then
    log "named tunnel started"
    exit 0
  fi
done

log "named tunnel failed to start"
tail -n 30 "$LOG" >&2 || true
exit 1
