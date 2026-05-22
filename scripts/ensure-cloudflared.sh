#!/usr/bin/env bash
set -euo pipefail

# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/common.sh"

BIN="${RUNTIME_DIR}/cloudflared-linux"
if [ -x "$BIN" ]; then
  printf '%s\n' "$BIN"
  exit 0
fi

arch="$(uname -m)"
case "$arch" in
  x86_64|x64|amd64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *)
    echo "当前架构不支持 cloudflared: ${arch:-unknown}" >&2
    exit 1
    ;;
esac

url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}"
curl -fsSL "$url" -o "$BIN"
chmod +x "$BIN"

if [ ! -x "$BIN" ]; then
  echo "cloudflared 下载失败" >&2
  exit 1
fi

printf '%s\n' "$BIN"
