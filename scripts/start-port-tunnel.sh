#!/usr/bin/env bash
set -euo pipefail

# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/common.sh"

port="${PORT:-}"
protocol="${PROTOCOL:-http}"
if [ -z "$port" ]; then
  echo "PORT 未设置" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PORT="$port" "${script_dir}/stop-port-tunnel.sh" || true
bin="$("${script_dir}/ensure-cloudflared.sh")"
origin="${protocol}://127.0.0.1:${port}"
process_name="port-tunnel-${port}"
log_file="${RUNTIME_DIR}/port-tunnel-${port}.log"
: >"$log_file"

tls_flag=""
if [ "$protocol" = "https" ]; then
  tls_flag="--no-tls-verify "
fi

quoted_bin=$(printf '%q' "$bin")
quoted_origin=$(printf '%q' "$origin")
quoted_log=$(printf '%q' "$log_file")
quoted_name=$(printf '%q' "$process_name")

nohup bash -c "exec -a ${quoted_name} ${quoted_bin} tunnel --url ${quoted_origin} ${tls_flag}--no-autoupdate --protocol http2 >> ${quoted_log} 2>&1" >/dev/null 2>&1 &

sleep 1
if ! pgrep -f "$process_name" >/dev/null 2>&1; then
  tail -n 20 "$log_file" >&2 || true
  echo "启动 cloudflared 失败" >&2
  exit 1
fi
