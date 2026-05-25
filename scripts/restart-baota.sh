#!/usr/bin/env bash
# 重置宝塔展示信息并重新采集面板地址（不卸载 /www/server/panel）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
RUNTIME_DIR="${ARGO_RUNTIME_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
export ARGO_RUNTIME_DIR="$RUNTIME_DIR"
export RESTART_ONLY=true
export REASON="${REASON:-restart}"

install_script="${RUNTIME_DIR}/install-baota.sh"
if [ ! -f "$install_script" ]; then
  install_script="${SCRIPT_DIR%/scripts}/install-baota.sh"
fi

if [ ! -f "$install_script" ]; then
  echo "未找到 install-baota.sh" >&2
  exit 1
fi

exec bash "$install_script"
