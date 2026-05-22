#!/usr/bin/env bash
set -euo pipefail

# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/common.sh"

ps -ef | grep -v grep | grep -E 'xray/xray|cloudflared-linux' || true
