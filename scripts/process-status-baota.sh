#!/usr/bin/env bash
set -euo pipefail

# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/common.sh"

ps -ef | grep -v grep | grep -E 'baota-panel-tunnel|btblog-named-tunnel|BT-Panel|/www/server/panel/' || true
