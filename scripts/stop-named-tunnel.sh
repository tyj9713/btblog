#!/usr/bin/env bash
set -euo pipefail

# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/common.sh"

pkill -9 -f 'btblog-named-tunnel' >/dev/null 2>&1 || true
pkill -9 -f 'cloudflared-linux tunnel run' >/dev/null 2>&1 || true
pkill -9 -f 'cloudflared-linux tunnel .*run' >/dev/null 2>&1 || true
pkill -9 -f './cloudflared-linux tunnel run' >/dev/null 2>&1 || true
pkill -9 -f './cloudflared-linux tunnel .*run' >/dev/null 2>&1 || true
