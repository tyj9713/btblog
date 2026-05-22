#!/usr/bin/env bash
set -euo pipefail

# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/tunnel-lib.sh"

port="${PORT:-}"
if [ -z "$port" ]; then
  echo "PORT 未设置" >&2
  exit 1
fi

tunnel_build_port_hostname "$port"
