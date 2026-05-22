#!/usr/bin/env bash
set -euo pipefail

# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/common.sh"

echo "===== system ====="
uname -a 2>&1 || true
df -h 2>&1 || true
echo
echo "===== processes ====="
ps -ef 2>&1 | grep -E 'xray|cloudflared|suoha|btblog-named-tunnel' || true
echo
echo "===== runtime files ====="
ls -la "$RUNTIME_DIR" \
  "${RUNTIME_DIR}/suoha.sh" \
  "${RUNTIME_DIR}/v2ray.txt" \
  "${RUNTIME_DIR}/xray" \
  "${RUNTIME_DIR}/cloudflared-linux" \
  "${RUNTIME_DIR}/named-tunnel.log" 2>&1 || true
