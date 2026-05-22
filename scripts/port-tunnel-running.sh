#!/usr/bin/env bash
set -euo pipefail

# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/common.sh"

port="${PORT:-}"
if [ -z "$port" ]; then
  echo "PORT 未设置" >&2
  exit 1
fi

ps -ef | grep -v grep | grep -F "port-tunnel-${port}" || true
