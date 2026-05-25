#!/usr/bin/env bash
set -euo pipefail

# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/common.sh"

echo "===== system ====="
uname -a 2>&1 || true
df -h 2>&1 || true
echo
echo "===== processes ====="
ps -ef 2>&1 | grep -E 'xray|cloudflared|suoha|btblog-named-tunnel|tunnel run' || true
echo
echo "===== named tunnel pid ====="
if [ -f "${RUNTIME_DIR}/named-tunnel.pid" ]; then
  echo "pid file: $(tr -d '\r\n' < "${RUNTIME_DIR}/named-tunnel.pid" 2>/dev/null || true)"
  pgrep -af 'cloudflared-linux tunnel' 2>/dev/null || echo "pgrep: no cloudflared tunnel process"
else
  echo "named-tunnel.pid 不存在"
fi
echo
echo "===== runtime files ====="
ls -la "$RUNTIME_DIR" \
  "${RUNTIME_DIR}/suoha.sh" \
  "${RUNTIME_DIR}/raw-nodes.txt" \
  "${RUNTIME_DIR}/node-session.json" \
  "${RUNTIME_DIR}/xray" \
  "${RUNTIME_DIR}/cloudflared-linux" \
  "${RUNTIME_DIR}/named-tunnel.log" 2>&1 || true
