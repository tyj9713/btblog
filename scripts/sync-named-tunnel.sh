#!/usr/bin/env bash
# 固定隧道完整同步：推送路由、生成本地配置、下载 cloudflared、启动 connector
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck disable=SC1091
source "${script_dir}/tunnel-lib.sh"

reason="${REASON:-manual}"
result_file="$SYNC_RESULT_FILE"

write_result() {
  local payload="$1"
  "$PYTHON_BIN" -c '
import json, sys
path, payload = sys.argv[1], json.loads(sys.argv[2])
with open(path, "w", encoding="utf-8") as fh:
    json.dump(payload, fh)
print(json.dumps(payload))
' "$result_file" "$payload"
}

fail() {
  local message="$1"
  tunnel_log "$message"
  "$PYTHON_BIN" -c 'import json,sys; json.dump({"ok":False,"enabled":False,"running":False,"error":sys.argv[1]}, open(sys.argv[2],"w",encoding="utf-8"))' "$message" "$result_file"
  exit 1
}

json_flag() {
  local json="$1"
  local key="$2"
  "$PYTHON_BIN" -c 'import json,sys; print("yes" if json.loads(sys.argv[1]).get(sys.argv[2]) else "no")' "$json" "$key"
}

settings_json="$(tunnel_resolve_settings_json)"
if [ "$(json_flag "$settings_json" enabled)" != "yes" ]; then
  fail "CLOUDFLARE_TUNNEL_TOKEN 未设置或无效（请先在面板保存固定隧道配置）"
fi

tunnel_log "sync start (${reason})"
tunnel_sync_runtime_env >/dev/null

route_publish='{"skipped":true,"reason":"仅启动 connector"}'
if [ "$(json_flag "$settings_json" useRemoteConfig)" = "yes" ]; then
  if publish_json="$(tunnel_publish_routes "$reason" 2>>"$TUNNEL_LOG")"; then
    route_publish="$publish_json"
    if [ "$(json_flag "$route_publish" skipped)" = "yes" ]; then
      reason_text="$("$PYTHON_BIN" -c 'import json,sys; print(json.loads(sys.argv[1]).get("reason",""))' "$route_publish")"
      tunnel_log "route publish skipped: ${reason_text:-仅启动 connector}"
    else
      tunnel_log "route publish ok via Cloudflare API (${reason})"
    fi
  else
    route_publish="$(cat "$ROUTE_PUBLISH_FILE" 2>/dev/null || echo '{"skipped":false,"error":"publish failed"}')"
    tunnel_log "route publish failed, still starting connector"
  fi
fi

if [ "$(json_flag "$settings_json" useLocalConfig)" = "yes" ]; then
  tunnel_build_local_artifacts >>"$TUNNEL_LOG" 2>&1 || fail "生成本地 cloudflared 配置失败"
fi

"${script_dir}/ensure-cloudflared.sh" >>"$TUNNEL_LOG" 2>&1

start_script="${RUNTIME_DIR}/start-named-tunnel.sh"
if [ ! -f "$start_script" ]; then
  start_script="${script_dir%/scripts}/start-named-tunnel.sh"
fi
if [ ! -f "$start_script" ]; then
  fail "未找到 start-named-tunnel.sh"
fi
chmod +x "$start_script"
# shellcheck disable=SC1091
if [ -f "$SHELL_ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$SHELL_ENV_FILE"
  set +a
fi
bash "$start_script" >>"$TUNNEL_LOG" 2>&1 || fail "start-named-tunnel.sh 执行失败"

running="false"
if "${script_dir}/named-tunnel-running.sh" >/dev/null 2>&1; then
  running="true"
fi

if [ "$running" != "true" ]; then
  tail -n 30 "$TUNNEL_LOG" >&2 || true
  fail "启动固定隧道失败，请查看 named-tunnel.log"
fi

node_host="$("$PYTHON_BIN" -c 'import json,sys; print(json.loads(sys.argv[1]).get("nodeHostname",""))' "$settings_json")"
bt_host="$("$PYTHON_BIN" -c 'import json,sys; print(json.loads(sys.argv[1]).get("btHostname",""))' "$settings_json")"
node_url=""
bt_url=""
if [ -n "$node_host" ]; then
  node_url="https://${node_host}"
fi
if [ -n "$bt_host" ]; then
  bt_url="https://${bt_host}"
fi

ingress_json="$(tunnel_build_ingress_json)"
payload="$("$PYTHON_BIN" - "$reason" "$running" "$node_url" "$bt_url" "$route_publish" "$ingress_json" <<'PY'
import json, sys
reason, running, node_url, bt_url = sys.argv[1:5]
route_publish = json.loads(sys.argv[5])
ingress_rules = json.loads(sys.argv[6])
print(json.dumps({
    "ok": True,
    "enabled": True,
    "running": running == "true",
    "reason": reason,
    "nodeUrl": node_url,
    "baotaUrl": bt_url,
    "ingressRules": ingress_rules,
    "routePublish": route_publish,
}))
PY
)"

tunnel_log "sync ok (${reason})"
write_result "$payload"
