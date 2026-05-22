#!/usr/bin/env bash
# 运行目录与项目根目录（被其它 scripts source）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
RUNTIME_DIR="${ARGO_RUNTIME_DIR:-$PROJECT_ROOT}"
export ARGO_RUNTIME_DIR="$RUNTIME_DIR"
cd "$RUNTIME_DIR"

if command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON_BIN="python"
else
  echo "未找到 python3/python，无法执行隧道脚本" >&2
  exit 127
fi
export PYTHON_BIN

timestamp_iso() {
  date -Iseconds 2>/dev/null || date -u '+%Y-%m-%dT%H:%M:%SZ'
}
