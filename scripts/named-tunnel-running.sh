#!/usr/bin/env bash
set -euo pipefail

# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/common.sh"

checks=(
  'btblog-named-tunnel'
  'cloudflared-linux tunnel run'
  'cloudflared-linux tunnel .*run'
  './cloudflared-linux tunnel run'
  './cloudflared-linux tunnel .*run'
)

for pattern in "${checks[@]}"; do
  if pgrep -f "$pattern" >/dev/null 2>&1; then
    pgrep -af "$pattern" || true
    exit 0
  fi
done
