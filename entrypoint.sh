#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
script_dir="$SCRIPT_DIR"
cd "$SCRIPT_DIR" || exit 1
RUNTIME_DIR="${ARGO_RUNTIME_DIR:-$SCRIPT_DIR}"
export ARGO_RUNTIME_DIR="$RUNTIME_DIR"

if [ -f "${script_dir}/scripts/cleanup-runtime.sh" ]; then
  echo "清理旧日志与过期宝塔信息..."
  chmod +x "${script_dir}/scripts/cleanup-runtime.sh"
  bash "${script_dir}/scripts/cleanup-runtime.sh" || true
fi

if [ -f "${RUNTIME_DIR}/named-tunnel.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "${RUNTIME_DIR}/named-tunnel.env"
  set +a
fi

# 哪吒的4个参数
NEZHA_SERVER="ip-tz.971314.xyz"
NEZHA_PORT="15555"
NEZHA_KEY="7JQFyDBT8XEc6krnqb"
#NEZHA_TLS=""
# nps客户端的3个参数
NPC_SERVER="nps.971314.xyz:8025"
NPC_VKEY="pribxlhr4wh4z5e0"
# NPC_TYPE="tcp"

# 使用部署包内自带的 suoha.sh，避免每次启动覆盖成会强制重下文件的旧模板
generate_suoha() {
  if [ ! -f "${script_dir}/suoha.sh" ]; then
    echo "错误: 未找到 ${script_dir}/suoha.sh"
    return 1
  fi

  chmod +x "${script_dir}/suoha.sh"
  echo "已使用部署目录中的 suoha.sh，跳过覆盖生成"
}

generate_nezha() {
  cat > nezha.sh << EOF
#!/usr/bin/env bash

# 哪吒的4个参数
NEZHA_SERVER="$NEZHA_SERVER"
NEZHA_PORT="$NEZHA_PORT"
NEZHA_KEY="$NEZHA_KEY"
NEZHA_TLS="$NEZHA_TLS"

# 检测是否已运行
check_run() {
  [[ \$(pgrep -laf nezha-agent) ]] && echo "哪吒客户端正在运行中!" && exit
}

# 三个变量不全则不安装哪吒客户端
check_variable() {
  [[ -z "\${NEZHA_SERVER}" || -z "\${NEZHA_PORT}" || -z "\${NEZHA_KEY}" ]] && exit
}

# 下载最新版本 Nezha Agent
download_agent() {
  if [ ! -e nezha-agent ]; then
    URL=\$(wget -qO- -4 "https://api.github.com/repos/nezhahq/agent/releases/latest"  | grep -o "https.*linux_amd64.zip")
    URL=\${URL:-https://github.com/nezhahq/agent/releases/download/v0.15.6/nezha-agent_linux_amd64.zip} 
    wget -t 2 -T 10 -N \${URL}
    unzip -qod ./ nezha-agent_linux_amd64.zip && rm -f nezha-agent_linux_amd64.zip
  fi
}

# 运行客户端
run() {
  TLS=\${NEZHA_TLS:+'--tls'}
  [[ ! \$PROCESS =~ nezha-agent && -e nezha-agent ]] && ./nezha-agent -s \${NEZHA_SERVER}:\${NEZHA_PORT} -p \${NEZHA_KEY} \${TLS} 2>&1 &
}

check_run
check_variable
download_agent
run
EOF
}

generate_npc() {
  cat > npc.sh << EOF
#!/usr/bin/env bash

# nps客户端的3个参数
NPC_SERVER="$NPC_SERVER"
NPC_VKEY="$NPC_VKEY"
# NPC_TYPE="$NPC_TYPE"

# 检测是否已运行
check_run() {
  [[ \$(pgrep -laf npc) ]] && echo "nps客户端正在运行中!" && exit
}

# 下载nps客户端
download_npc() {
  if [ ! -e npc ]; then
    wget -t 2 -T 10 -N "https://github.com/ehang-io/nps/releases/download/v0.26.8/linux_amd64_client.tar.gz"
    tar -xzvf ./linux_amd64_client.tar.gz && rm -f linux_amd64_client.tar.gz
  fi
}

# 安装并启动nps客户端
run() {
  [[ ! \$PROCESS =~ npc && -e npc ]] && ./npc -server=\${NPC_SERVER} -vkey=\${NPC_VKEY} -type=tcp
}

check_run
download_npc
run
EOF
}

# 生成所有脚本
echo "开始生成脚本..."
generate_suoha
generate_nezha
generate_npc

echo "准备运行suoha.sh..."
ls -la suoha.sh
# 默认运行suoha.sh而不是nezha和npc
if [ -e suoha.sh ]; then
  echo "执行suoha.sh脚本..."
  chmod +x suoha.sh
  bash suoha.sh > suoha.log 2>&1 &
  echo "suoha.sh已在后台启动，查看日志: cat suoha.log"
else
  echo "suoha.sh文件不存在，创建失败"
fi

# 宝塔全自动安装 + 管理端口隧道（非交互 yes）
if [ -f "${script_dir}/install-baota.sh" ]; then
  echo "执行 install-baota.sh（宝塔安装与隧道）..."
  chmod +x "${script_dir}/install-baota.sh"
  export ARGO_RUNTIME_DIR="${ARGO_RUNTIME_DIR:-$(pwd)}"
  bash "${script_dir}/install-baota.sh" >>"${ARGO_RUNTIME_DIR}/baota-install.log" 2>&1 &
  echo "install-baota.sh 已在后台启动，查看: cat baota-install.log / baota-panel-url.txt"
fi

# 固定隧道由 suoha 在 Xray 就绪后自动 sync；宝塔装好后 install-baota 推送面板端口路由
if [ -n "${CLOUDFLARE_TUNNEL_TOKEN:-${APPSETTING_CLOUDFLARE_TUNNEL_TOKEN:-}}" ]; then
  echo "已配置固定隧道：suoha 启动 Xray 后将自动拉起 cloudflared"
else
  echo "未设置 CLOUDFLARE_TUNNEL_TOKEN，跳过固定隧道"
fi

# [ -e npc.sh ] && bash npc.sh
# [ -e nezha.sh ] && bash nezha.sh
