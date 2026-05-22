#!/usr/bin/env bash
set -euo pipefail

# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/common.sh"

pkill -9 -f 'xray/xray' >/dev/null 2>&1 || true

if [ "${NAMED_TUNNEL_ENABLED:-false}" != "true" ]; then
  pkill -9 -f 'cloudflared-linux tunnel --url' >/dev/null 2>&1 || true
fi
