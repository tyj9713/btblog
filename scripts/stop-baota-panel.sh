#!/usr/bin/env bash
set -euo pipefail

# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/common.sh"

bash "${RUNTIME_DIR}/scripts/ensure-python-bt.sh" >>/dev/null 2>&1 \
  || bash "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/ensure-python-bt.sh" >>/dev/null 2>&1 \
  || true

if [ -f /etc/init.d/bt ]; then
  /etc/init.d/bt stop >/dev/null 2>&1 || true
fi
if [ -x /usr/bin/bt ]; then
  /usr/bin/bt stop >/dev/null 2>&1 || true
fi
if [ -f /www/server/panel/init.sh ]; then
  bash /www/server/panel/init.sh stop >/dev/null 2>&1 || true
fi

pkill -f '/www/server/panel/BT-Panel' >/dev/null 2>&1 || true
