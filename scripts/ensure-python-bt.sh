#!/usr/bin/env bash
# 宝塔 bt 命令依赖 /usr/bin/python，容器内通常只有 python3
set -euo pipefail

if [ -x /usr/bin/python ]; then
  exit 0
fi

install_python3() {
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y && apt-get install -y python3
    return 0
  fi
  if command -v yum >/dev/null 2>&1; then
    yum install -y python3
    return 0
  fi
  if command -v apk >/dev/null 2>&1; then
    apk add --no-cache python3
    return 0
  fi
  return 1
}

if ! command -v python3 >/dev/null 2>&1; then
  install_python3 || {
    echo "无法安装 python3，bt 命令可能不可用" >&2
    exit 1
  }
fi

if [ "$(id -u)" = "0" ] && [ ! -e /usr/bin/python ]; then
  ln -sf "$(command -v python3)" /usr/bin/python
fi
