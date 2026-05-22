#!/usr/bin/env bash
# 固定隧道完整同步：推送路由、生成本地配置、下载 cloudflared、启动 connector
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck disable=SC1091
source "${script_dir}/tunnel-lib.sh"

reason="${REASON:-manual}"
result_file="$SYNC_RESULT_FILE"

write_result() {
  python3 - "$result_file" <<'PY'
import json, sys
path, payload = sys.argv[1], json.loads(sys.stdin.read())
with open(path, "w", encoding="utf-8") as fh:
    json.dump(payload, fh)
print(json.dumps(payload))
PY
}

fail() {
  local message="$1"
  tunnel_log "$message"
  python3 -c 'import json,sys; json.dump({"ok":False,"enabled":False,"running":False,"error":sys.argv[1]}, open(sys.argv[2],"w",encoding="utf-8"))' "$message" "$result_file"
  exit 1
}

settings_json="$(tunnel_resolve_settings_json)"
enabled="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["enabled"])' "$settings_json")"
if [ "$enabled" != "True" ]; then
  fail "CLOUDFLARE_TUNNEL_TOKEN 未设置或无效"
fi

tunnel_log "sync start (${reason})"
tunnel_sync_runtime_env >/dev/null

route_publish='{"skipped":true,"reason":"仅启动 connector"}'
use_remote="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["useRemoteConfig"])' "$settings_json")"
if [ "$use_remote" = "True" ]; then
  if publish_json="$(tunnel_publish_routes "$reason" 2>>"$TUNNEL_LOG")"; then
    route_publish="$publish_json"
    if [ "$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("skipped"))' "$route_publish")" = "True" ]; then
      reason_text="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("reason",""))' "$route_publish")"
      tunnel_log "route publish skipped: ${reason_text:-仅启动 connector}"
    else
      tunnel_log "route publish ok via Cloudflare API (${reason})"
    fi
  else
    route_publish="$(cat "$ROUTE_PUBLISH_FILE" 2>/dev/null || echo '{"skipped":false,"error":"publish failed"}')"
    tunnel_log "route publish failed, still starting connector"
  fi
fi

use_local="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["useLocalConfig"])' "$settings_json")"
if [ "$use_local" = "True" ]; then
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
  fail "启动固定隧道失败"
fi

node_host="$(python3 -c 'import json,sys; s=json.loads(sys.argv[1]); print(s.get("nodeHostname",""))' "$settings_json")"
bt_host="$(python3 -c 'import json,sys; s=json.loads(sys.argv[1]); print(s.get("btHostname",""))' "$settings_json")"
node_url=""
bt_url=""
if [ -n "$node_host" ]; then
  node_url="https://${node_host}"
fi
if [ -n "$bt_host" ]; then
  bt_url="https://${bt_host}"
fi

ingress_json="$(tunnel_build_ingress_json)"
payload="$(python3 - "$reason" "$running" "$node_url" "$bt_url" "$route_publish" "$ingress_json" <<'PY'
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
printf '%s' "$payload" | write_result
