#!/usr/bin/env bash
# 部署/容器重启时清理旧日志与过期的宝塔展示信息（保留用户配置与二进制）
set -euo pipefail

# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/common.sh"

timestamp_iso() {
  date -Iseconds 2>/dev/null || date -u '+%Y-%m-%dT%H:%M:%SZ'
}

remove_if_exists() {
  local target="$1"
  if [ -e "$target" ]; then
    rm -f "$target"
    echo "[$(timestamp_iso)] removed: $(basename "$target")"
  fi
}

echo "[$(timestamp_iso)] cleanup-runtime: ${RUNTIME_DIR}"

static_files=(
  named-tunnel.log
  named-tunnel.pid
  named-tunnel-watch.pid
  named-tunnel-sync-result.json
  named-tunnel-route-publish.json
  baota-install.log
  baota-argo.log
  baota-default.txt
  baota-panel-url.txt
  suoha.log
  suoha-start.log
  xray.log
  argo.log
)

for name in "${static_files[@]}"; do
  remove_if_exists "${RUNTIME_DIR}/${name}"
done

shopt -s nullglob
for path in "${RUNTIME_DIR}"/port-tunnel-*.log; do
  remove_if_exists "$path"
done
shopt -u nullglob

# 面板文件已不存在时，清除安装标记以便重新采集宝塔信息
if [ -f "${RUNTIME_DIR}/.baota-installed" ] && [ ! -x /www/server/panel/BT-Panel ] && [ ! -f /www/server/panel/BT-Panel ]; then
  remove_if_exists "${RUNTIME_DIR}/.baota-installed"
fi

echo "[$(timestamp_iso)] cleanup-runtime done"
