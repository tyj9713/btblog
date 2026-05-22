#!/usr/bin/env bash
# 仅停止 Quick Tunnel（tunnel --url），不触碰固定隧道（tunnel run）
set -euo pipefail

# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/common.sh"

pkill -9 -f 'cloudflared-linux tunnel --url' >/dev/null 2>&1 || true
