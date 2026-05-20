#!/bin/bash
# 宝塔面板全自动安装 + Cloudflare Quick Tunnel 暴露管理端口
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
RUNTIME_DIR="${ARGO_RUNTIME_DIR:-$SCRIPT_DIR}"
cd "$RUNTIME_DIR"

INSTALL_LOG="${RUNTIME_DIR}/baota-install.log"
TUNNEL_LOG="${RUNTIME_DIR}/baota-argo.log"
URL_FILE="${RUNTIME_DIR}/baota-panel-url.txt"
DEFAULT_FILE="${RUNTIME_DIR}/baota-default.txt"
MARKER_FILE="${RUNTIME_DIR}/.baota-installed"
PERSIST_WWW_ROOT="${RUNTIME_DIR}/baota-www-root"
INSTALL_SCRIPT_URL="${BT_INSTALL_URL:-https://bt.cxinyun.com/install/install_panel.sh}"

log() {
  echo "[$(date -Iseconds)] $*" | tee -a "$INSTALL_LOG"
}

panel_files_exist() {
  [ -f /www/server/panel/BT-Panel ] || [ -x /www/server/panel/BT-Panel ]
}

clear_stale_install_marker() {
  if [ -f "$MARKER_FILE" ] && ! panel_files_exist; then
    log "安装标记存在但 /www/server/panel 缺失，清除旧标记与过期地址文件"
    rm -f "$MARKER_FILE" "$URL_FILE" "$DEFAULT_FILE"
  fi
}

restore_persisted_www() {
  if panel_files_exist; then
    return 0
  fi
  if [ ! -d "$PERSIST_WWW_ROOT/server/panel" ]; then
    return 1
  fi

  log "从持久化目录恢复宝塔 /www: $PERSIST_WWW_ROOT"
  rm -rf /www
  ln -sfn "$PERSIST_WWW_ROOT" /www
  panel_files_exist
}

persist_www_tree() {
  if ! panel_files_exist; then
    return 1
  fi

  if [ -L /www ] && [ "$(readlink -f /www 2>/dev/null || true)" = "$(readlink -f "$PERSIST_WWW_ROOT" 2>/dev/null || true)" ]; then
    log "宝塔 /www 已链接到持久化目录"
    return 0
  fi

  if [ -d "$PERSIST_WWW_ROOT/server/panel" ]; then
    log "持久化目录已有宝塔文件，重建 /www 链接"
    rm -rf /www
    ln -sfn "$PERSIST_WWW_ROOT" /www
    return 0
  fi

  if [ -d /www/server/panel ] && [ ! -L /www ]; then
    log "迁移宝塔 /www 到持久化目录: $PERSIST_WWW_ROOT"
    mkdir -p "$(dirname "$PERSIST_WWW_ROOT")"
    mv /www "$PERSIST_WWW_ROOT"
    ln -sfn "$PERSIST_WWW_ROOT" /www
    log "宝塔文件已持久化到运行目录"
  fi
}

is_baota_installed() {
  panel_files_exist
}

download_cloudflared_binary() {
  case "$(uname -m)" in
    x86_64 | x64 | amd64)
      curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared-linux
      ;;
    aarch64 | arm64)
      curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 -o cloudflared-linux
      ;;
    *)
      log "架构 $(uname -m) 未适配 cloudflared"
      return 1
      ;;
  esac
}

ensure_cloudflared() {
  if [ -f "${RUNTIME_DIR}/cloudflared-linux" ] && [ -x "${RUNTIME_DIR}/cloudflared-linux" ]; then
    return 0
  fi
  log "下载 cloudflared..."
  download_cloudflared_binary
  chmod +x "${RUNTIME_DIR}/cloudflared-linux"
}

install_baota_panel() {
  if is_baota_installed; then
    log "宝塔已安装，跳过 install_panel.sh"
    return 0
  fi

  if ! command -v wget >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
      apt-get update -y && apt-get install -y wget curl
    elif command -v yum >/dev/null 2>&1; then
      yum install -y wget curl
    fi
  fi

  log "开始下载宝塔安装脚本: $INSTALL_SCRIPT_URL"
  wget -O "${RUNTIME_DIR}/bt-install.sh" "$INSTALL_SCRIPT_URL"

  log "开始非交互安装宝塔（自动应答 y）..."
  # 安装过程可能多次询问，使用 yes 持续应答
  if yes | bash "${RUNTIME_DIR}/bt-install.sh" >>"$INSTALL_LOG" 2>&1; then
    log "宝塔安装命令执行完成"
  else
    log "宝塔安装命令返回非零，若面板文件已存在则继续"
  fi

  if panel_files_exist; then
    touch "$MARKER_FILE"
    persist_www_tree || true
    log "宝塔安装成功"
  else
    rm -f "$MARKER_FILE"
    log "未检测到宝塔面板，请查看 $INSTALL_LOG"
    return 1
  fi
}

read_panel_port() {
  if [ -f /www/server/panel/data/port.pl ]; then
    tr -d '[:space:]' </www/server/panel/data/port.pl
    return
  fi
  echo "8888"
}

read_panel_path() {
  if [ -f /www/server/panel/data/admin_path.pl ]; then
    local p
    p="$(tr -d '[:space:]' </www/server/panel/data/admin_path.pl)"
    if [ -n "$p" ]; then
      case "$p" in
        /*) echo "$p" ;;
        *) echo "/$p" ;;
      esac
      return
    fi
  fi
  echo ""
}

save_bt_default() {
  if [ -x /usr/bin/bt ]; then
    /usr/bin/bt default >"$DEFAULT_FILE" 2>&1 || true
  elif command -v bt >/dev/null 2>&1; then
    bt default >"$DEFAULT_FILE" 2>&1 || true
  elif [ -f /www/server/panel/BT-Panel ]; then
    {
      echo "# bt 命令不可用，以下为面板路径信息"
      echo "panel=/www/server/panel"
      echo "port=$(read_panel_port)"
      echo "path=$(read_panel_path)"
    } >"$DEFAULT_FILE"
  fi
}

stop_panel_tunnel() {
  pkill -9 -f 'baota-panel-tunnel' >/dev/null 2>&1 || true
}

is_panel_running() {
  pgrep -f '/www/server/panel/BT-Panel' >/dev/null 2>&1 || pgrep -f 'BT-Panel' >/dev/null 2>&1
}

start_baota_service() {
  if ! panel_files_exist; then
    return 1
  fi
  if is_panel_running; then
    log "宝塔面板进程已在运行"
    return 0
  fi

  log "尝试启动宝塔面板服务..."
  if [ -f /www/server/panel/init.sh ]; then
    bash /www/server/panel/init.sh start >>"$INSTALL_LOG" 2>&1 || true
  fi
  if [ -f /etc/init.d/bt ]; then
    /etc/init.d/bt start >>"$INSTALL_LOG" 2>&1 || true
  fi
  if [ -x /usr/bin/bt ]; then
    /usr/bin/bt start >>"$INSTALL_LOG" 2>&1 || true
  elif command -v bt >/dev/null 2>&1; then
    bt start >>"$INSTALL_LOG" 2>&1 || true
  fi

  sleep 2
  if is_panel_running; then
    log "宝塔面板已启动"
    return 0
  fi

  log "宝塔面板未能自动启动；若容器重启后 bt 不存在，可依赖 /www/server/panel/init.sh 或点击面板重新安装"
  return 1
}

start_panel_tunnel() {
  ensure_cloudflared || return 1
  stop_panel_tunnel
  : >"$TUNNEL_LOG"

  local port path origin
  port="$(read_panel_port)"
  path="$(read_panel_path)"
  origin="https://127.0.0.1:${port}"

  log "为宝塔面板启动隧道: ${origin}${path}"
  run_panel_tunnel() {
    exec -a baota-panel-tunnel "${RUNTIME_DIR}/cloudflared-linux" tunnel \
      --url "$origin" \
      --no-tls-verify \
      --no-autoupdate \
      --protocol http2 \
      >>"$TUNNEL_LOG" 2>&1
  }

  run_panel_tunnel &
  local cf_pid=$!

  local n=0 retry=0 host=""
  while [ "$n" -lt 90 ]; do
    n=$((n + 1))
    if ! ps -p "$cf_pid" >/dev/null 2>&1; then
      log "cloudflared 退出，重试隧道"
      run_panel_tunnel &
      cf_pid=$!
      retry=$((retry + 1))
      [ "$retry" -ge 3 ] && break
    fi
    host="$(grep -Eo '[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | tail -n 1 || true)"
    if [ -n "$host" ]; then
      break
    fi
    sleep 1
  done

  if [ -z "$host" ]; then
    log "未能从 $TUNNEL_LOG 解析 trycloudflare 地址"
    return 1
  fi

  {
    echo "https://${host}${path}"
    echo ""
    echo "# 本地面板"
    echo "${origin}${path}"
    echo ""
    if [ -f "$DEFAULT_FILE" ]; then
      cat "$DEFAULT_FILE"
    elif [ -x /usr/bin/bt ]; then
      /usr/bin/bt default 2>/dev/null || true
    elif command -v bt >/dev/null 2>&1; then
      bt default 2>/dev/null || true
    fi
  } >"$URL_FILE"

  log "宝塔外网访问地址已写入 $URL_FILE"
  cat "$URL_FILE" | tee -a "$INSTALL_LOG"
}

main() {
  mkdir -p "$RUNTIME_DIR"
  echo "" >>"$INSTALL_LOG"
  echo "[$(date -Iseconds)] install-baota.sh 启动, runtime=$RUNTIME_DIR" | tee -a "$INSTALL_LOG"

  clear_stale_install_marker
  restore_persisted_www || true

  install_baota_panel || true
  restore_persisted_www || true
  start_baota_service || true
  save_bt_default
  start_panel_tunnel || log "宝塔隧道启动失败，可稍后由保活重试"

  log "install-baota.sh 结束"
}

main "$@"
