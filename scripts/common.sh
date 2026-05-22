#!/usr/bin/env bash
# 运行目录与项目根目录（被其它 scripts source）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
RUNTIME_DIR="${ARGO_RUNTIME_DIR:-$PROJECT_ROOT}"
export ARGO_RUNTIME_DIR="$RUNTIME_DIR"
cd "$RUNTIME_DIR"
