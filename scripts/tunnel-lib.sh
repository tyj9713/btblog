#!/usr/bin/env bash
# Cloudflare 固定隧道：配置解析、ingress、API 推送、本地 config
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/common.sh"

SETTINGS_FILE="${RUNTIME_DIR}/named-tunnel-settings.json"
PORT_STATE_FILE="${RUNTIME_DIR}/port-tunnels.json"
SHELL_ENV_FILE="${RUNTIME_DIR}/named-tunnel.env"
CONFIG_FILE="${RUNTIME_DIR}/cloudflared-config.yml"
CREDENTIALS_FILE="${RUNTIME_DIR}/cloudflared-credentials.json"
TUNNEL_LOG="${RUNTIME_DIR}/named-tunnel.log"
SYNC_RESULT_FILE="${RUNTIME_DIR}/named-tunnel-sync-result.json"
ROUTE_PUBLISH_FILE="${RUNTIME_DIR}/named-tunnel-route-publish.json"

tunnel_log() {
  echo "[$(timestamp_iso)] $*" | tee -a "$TUNNEL_LOG"
}

tunnel_python() {
  "$PYTHON_BIN" - "$RUNTIME_DIR" "$@" <<'PY'
import base64
import json
import os
import re
import sys

runtime = sys.argv[1]
argv = sys.argv[2:]
command = argv[0] if argv else ""

settings_path = os.path.join(runtime, "named-tunnel-settings.json")
state_path = os.path.join(runtime, "port-tunnels.json")
data = {}
if os.path.isfile(settings_path):
    with open(settings_path, encoding="utf-8") as fh:
        data = json.load(fh)


def read_env(name, default=""):
    value = str(data.get(name, "")).strip()
    if value:
        return value
    return (os.environ.get(name) or os.environ.get(f"APPSETTING_{name}") or default).strip()


def parse_port(raw, fallback):
    try:
        port = int(str(raw).strip())
    except Exception:
        return fallback
    return port if 1 <= port <= 65535 else fallback


def normalize_host(value):
    value = re.sub(r"^https?://", "", value.strip(), flags=re.I).rstrip("/").lower()
    return value


def decode_token(token):
    token = token.strip()
    if not token or token.count(".") < 2:
        return None
    payload = token.split(".")[1]
    payload += "=" * ((4 - len(payload) % 4) % 4)
    payload = payload.replace("-", "+").replace("_", "/")
    try:
        body = json.loads(base64.b64decode(payload))
    except Exception:
        return None
    if not all(body.get(k) for k in ("a", "t", "s")):
        return None
    return {
        "AccountTag": body["a"],
        "TunnelID": body["t"],
        "TunnelSecret": body["s"],
    }


def resolve_settings():
    token = read_env("CLOUDFLARE_TUNNEL_TOKEN")
    credentials_file = read_env("CLOUDFLARE_TUNNEL_CREDENTIALS_FILE")
    credentials = None
    if credentials_file and os.path.isfile(credentials_file):
        try:
            with open(credentials_file, encoding="utf-8") as fh:
                cred = json.load(fh)
            if all(cred.get(k) for k in ("AccountTag", "TunnelID", "TunnelSecret")):
                credentials = cred
        except Exception:
            credentials = None
    token_credentials = decode_token(token) if token else None
    account_id = read_env("CLOUDFLARE_ACCOUNT_ID")
    tunnel_id = read_env("CLOUDFLARE_TUNNEL_ID")
    explicit = None
    if account_id and tunnel_id:
        explicit = {
            "AccountTag": account_id,
            "TunnelID": tunnel_id,
            "TunnelSecret": (token_credentials or {}).get("TunnelSecret", ""),
        }
    credentials = explicit or credentials or token_credentials

    local_flag = read_env("CLOUDFLARE_TUNNEL_LOCAL_CONFIG").lower()
    remote_flag = read_env("CLOUDFLARE_TUNNEL_REMOTE_CONFIG").lower()
    use_local = local_flag == "true" or remote_flag == "false"

    bt_port = parse_port(read_env("BT_PORT", "8888"), 8888)
    port_file = "/www/server/panel/data/port.pl"
    if os.path.isfile(port_file):
        try:
            bt_port = parse_port(open(port_file, encoding="utf-8").read(), bt_port)
        except Exception:
            pass

    return {
        "enabled": bool(token or credentials),
        "token": token,
        "credentials": credentials,
        "accountId": account_id or (credentials or {}).get("AccountTag", ""),
        "tunnelId": tunnel_id or (credentials or {}).get("TunnelID", ""),
        "nodeHostname": normalize_host(read_env("TUNNEL_NODE_HOSTNAME") or read_env("NODE_HOSTNAME")),
        "btHostname": normalize_host(read_env("TUNNEL_BT_HOSTNAME") or read_env("BT_HOSTNAME")),
        "xrayPort": parse_port(read_env("XRAY_PORT", "10086"), 10086),
        "btPort": bt_port,
        "portDomain": normalize_host(read_env("TUNNEL_PORT_DOMAIN")),
        "portHostPrefix": read_env("TUNNEL_PORT_HOST_PREFIX", "p") or "p",
        "portHostTemplate": read_env("TUNNEL_PORT_HOST_TEMPLATE"),
        "apiToken": read_env("CLOUDFLARE_API_TOKEN"),
        "useLocalConfig": use_local,
        "useRemoteConfig": not use_local,
    }


def build_port_hostname(port, settings):
    template = settings.get("portHostTemplate") or ""
    domain = settings.get("portDomain") or ""
    prefix = settings.get("portHostPrefix") or "p"
    if template:
        return normalize_host(template.replace("{port}", str(port)))
    if domain:
        return normalize_host(f"{prefix}{port}.{domain}")
    return ""


def build_ingress(settings):
    rules = []
    if settings.get("nodeHostname"):
        rules.append({
            "hostname": settings["nodeHostname"],
            "service": f"http://127.0.0.1:{settings['xrayPort']}",
        })
    if settings.get("btHostname"):
        rules.append({
            "hostname": settings["btHostname"],
            "service": f"https://127.0.0.1:{settings['btPort']}",
            "originRequest": {"noTLSVerify": True},
        })

    if os.path.isfile(state_path):
        try:
            state = json.load(open(state_path, encoding="utf-8"))
            for key in sorted(state.keys(), key=lambda item: int(item) if str(item).isdigit() else item):
                try:
                    port = int(key)
                except Exception:
                    continue
                item = state.get(key) or {}
                protocol = str(item.get("protocol") or "http").lower()
                protocol = "https" if protocol == "https" else "http"
                hostname = str(item.get("hostname") or "").strip() or build_port_hostname(port, settings)
                if not hostname:
                    continue
                rule = {"hostname": hostname, "service": f"{protocol}://127.0.0.1:{port}"}
                if protocol == "https":
                    rule["originRequest"] = {"noTLSVerify": True}
                rules.append(rule)
        except Exception:
            pass

    rules.append({"service": "http_status:404"})
    return rules


def yaml_quote(value):
    return json.dumps(str(value))


def render_config_yaml(tunnel_id, credentials_path, ingress_rules):
    lines = [
        f"tunnel: {tunnel_id}",
        f"credentials-file: {credentials_path}",
        "ingress:",
    ]
    for rule in ingress_rules:
        lines.append("  -")
        if rule.get("hostname"):
            lines.append(f"    hostname: {yaml_quote(rule['hostname'])}")
        lines.append(f"    service: {yaml_quote(rule['service'])}")
        if rule.get("originRequest", {}).get("noTLSVerify"):
            lines.append("    originRequest:")
            lines.append("      noTLSVerify: true")
    return "\n".join(lines) + "\n"


if command == "settings":
    print(json.dumps(resolve_settings()))
elif command == "ingress":
    print(json.dumps(build_ingress(resolve_settings())))
elif command == "baota-port":
    settings = resolve_settings()
    print(settings["btPort"])
elif command == "port-hostname":
    port = int(argv[1])
    settings = resolve_settings()
    print(build_port_hostname(port, settings))
elif command == "config-status":
    settings = resolve_settings()
    config = data
    print(json.dumps({
        "configured": settings["enabled"],
        "settingsFile": settings_path,
        "hasTunnelToken": bool(str(config.get("CLOUDFLARE_TUNNEL_TOKEN", "")).strip()),
        "hasApiToken": bool(str(config.get("CLOUDFLARE_API_TOKEN", "")).strip()),
        "accountId": settings["accountId"],
        "tunnelId": settings["tunnelId"],
        "nodeHostname": settings["nodeHostname"],
        "btHostname": settings["btHostname"],
        "portDomain": settings["portDomain"],
        "portHostPrefix": settings["portHostPrefix"],
        "portHostTemplate": settings.get("portHostTemplate") or "",
        "xrayPort": settings["xrayPort"],
        "btPort": settings["btPort"],
        "btPortEffective": settings["btPort"],
        "remoteConfig": settings["useRemoteConfig"],
    }))
elif command == "sync-env":
    import shlex

    keys = [
        "CLOUDFLARE_TUNNEL_TOKEN",
        "CLOUDFLARE_API_TOKEN",
        "CLOUDFLARE_ACCOUNT_ID",
        "CLOUDFLARE_TUNNEL_ID",
        "CLOUDFLARE_TUNNEL_REMOTE_CONFIG",
        "CLOUDFLARE_TUNNEL_LOCAL_CONFIG",
        "TUNNEL_NODE_HOSTNAME",
        "TUNNEL_BT_HOSTNAME",
        "TUNNEL_PORT_DOMAIN",
        "TUNNEL_PORT_HOST_PREFIX",
        "TUNNEL_PORT_HOST_TEMPLATE",
        "XRAY_PORT",
        "BT_PORT",
    ]
    env_path = os.path.join(runtime, "named-tunnel.env")
    lines = [
        "# Generated by btblog from named-tunnel-settings.json",
        "# Do not edit manually; update via admin panel.",
        "",
    ]
    for key in keys:
        value = str(data.get(key, "")).strip()
        if value:
            lines.append(f"export {key}={shlex.quote(value)}")
    lines.append("")
    if not data:
        if os.path.isfile(env_path):
            os.remove(env_path)
    else:
        os.makedirs(runtime, exist_ok=True)
        with open(env_path, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines))
    print(env_path)
elif command == "build-local":
    settings = resolve_settings()
    ingress = build_ingress(settings)
    if not settings.get("credentials"):
        raise SystemExit("CLOUDFLARE_TUNNEL_TOKEN 无效，或请设置 CLOUDFLARE_TUNNEL_CREDENTIALS_FILE")
    if not settings.get("nodeHostname") and not settings.get("btHostname") and len(ingress) <= 1:
        raise SystemExit("请至少设置 TUNNEL_NODE_HOSTNAME、TUNNEL_BT_HOSTNAME 或绑定一个端口")
    credentials_path = os.path.join(runtime, "cloudflared-credentials.json")
    config_path = os.path.join(runtime, "cloudflared-config.yml")
    os.makedirs(runtime, exist_ok=True)
    with open(credentials_path, "w", encoding="utf-8") as fh:
        json.dump(settings["credentials"], fh, indent=2)
        fh.write("\n")
    config_yaml = render_config_yaml(settings["tunnelId"], credentials_path, ingress)
    with open(config_path, "w", encoding="utf-8") as fh:
        fh.write(config_yaml)
    print(json.dumps({"configPath": config_path, "credentialsPath": credentials_path}))
elif command == "publish":
    import urllib.error
    import urllib.request

    reason = argv[1] if len(argv) > 1 else "manual"
    settings = resolve_settings()
    ingress = build_ingress(settings)
    result = {"skipped": True, "reason": ""}

    if not settings["enabled"]:
        result["reason"] = "固定隧道 token 未配置"
    elif settings["useLocalConfig"]:
        result["reason"] = "本地配置模式不推送 Cloudflare API 路由"
    elif not settings.get("apiToken"):
        result["reason"] = "CLOUDFLARE_API_TOKEN 未配置"
    elif not settings.get("credentials"):
        result["reason"] = "未配置 Account ID / Tunnel ID，且 token 无法解析"
    elif not any(rule.get("hostname") for rule in ingress):
        result["reason"] = "未配置节点域名、宝塔域名或端口域名"
    else:
        cred = settings["credentials"]
        api_rules = []
        for rule in ingress:
            item = {"service": rule["service"]}
            if rule.get("hostname"):
                item["hostname"] = rule["hostname"]
            if rule.get("originRequest"):
                item["originRequest"] = rule["originRequest"]
            api_rules.append(item)
        body = json.dumps({"config": {"ingress": api_rules}}).encode("utf-8")
        url = (
            "https://api.cloudflare.com/client/v4/accounts/"
            f"{cred['AccountTag']}/cfd_tunnel/{cred['TunnelID']}/configurations"
        )
        request = urllib.request.Request(
            url,
            data=body,
            method="PUT",
            headers={
                "Authorization": f"Bearer {settings['apiToken']}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            payload = json.loads(error.read().decode("utf-8") or "{}")
            messages = "; ".join(
                item.get("message", "") for item in payload.get("errors", []) if item.get("message")
            )
            raise SystemExit(f"Cloudflare API 更新隧道路由失败: {messages or error.code}")
        if not payload.get("success"):
            messages = "; ".join(
                item.get("message", "") for item in payload.get("errors", []) if item.get("message")
            )
            raise SystemExit(f"Cloudflare API 更新隧道路由失败: {messages or 'unknown'}")
        result = {"skipped": False, "result": payload.get("result"), "reason": reason}

    publish_path = os.path.join(runtime, "named-tunnel-route-publish.json")
    with open(publish_path, "w", encoding="utf-8") as fh:
        json.dump(result, fh)
    print(json.dumps(result))
PY
}

tunnel_resolve_settings_json() {
  tunnel_python settings
}

tunnel_build_ingress_json() {
  tunnel_python ingress
}

tunnel_read_baota_port() {
  tunnel_python baota-port
}

tunnel_build_port_hostname() {
  local port="$1"
  tunnel_python port-hostname "$port"
}

tunnel_config_status_json() {
  tunnel_python config-status
}

tunnel_sync_runtime_env() {
  tunnel_python sync-env >/dev/null
  printf '%s' "$SHELL_ENV_FILE"
}

tunnel_build_local_artifacts() {
  tunnel_python build-local >/dev/null
}

tunnel_publish_routes() {
  local reason="${1:-manual}"
  tunnel_python publish "$reason"
}
