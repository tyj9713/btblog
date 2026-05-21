const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_XRAY_PORT = 10086;
const DEFAULT_BT_PORT = 8888;
const PROCESS_NAME = "btblog-named-tunnel";
const CONFIG_FILE = "cloudflared-config.yml";
const CREDENTIALS_FILE = "cloudflared-credentials.json";
const LOG_FILE = "named-tunnel.log";

function parsePort(value, fallback) {
  const port = Number.parseInt(String(value), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return fallback;
  }
  return port;
}

function normalizeHostname(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function decodeTunnelToken(token) {
  const trimmed = String(token || "").trim();
  if (!trimmed) {
    return null;
  }

  const parts = trimmed.split(".");
  if (parts.length < 2) {
    return null;
  }

  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const json = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    if (!json.a || !json.t || !json.s) {
      return null;
    }
    return {
      AccountTag: json.a,
      TunnelID: json.t,
      TunnelSecret: json.s,
    };
  } catch {
    return null;
  }
}

function readCredentialsFromFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  try {
    const json = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!json.AccountTag || !json.TunnelID || !json.TunnelSecret) {
      return null;
    }
    return json;
  } catch {
    return null;
  }
}

function resolveTunnelSettings(env = process.env) {
  const token = String(env.CLOUDFLARE_TUNNEL_TOKEN || "").trim();
  const credentialsFile = String(env.CLOUDFLARE_TUNNEL_CREDENTIALS_FILE || "").trim();
  const credentialsFromFile = credentialsFile
    ? readCredentialsFromFile(credentialsFile)
    : null;
  const credentialsFromToken = token ? decodeTunnelToken(token) : null;
  const credentials = credentialsFromFile || credentialsFromToken;

  return {
    enabled: Boolean(token || credentials),
    token,
    credentials,
    credentialsFile,
    nodeHostname: normalizeHostname(
      env.TUNNEL_NODE_HOSTNAME || env.NODE_HOSTNAME || ""
    ),
    btHostname: normalizeHostname(env.TUNNEL_BT_HOSTNAME || env.BT_HOSTNAME || ""),
    xrayPort: parsePort(env.XRAY_PORT, DEFAULT_XRAY_PORT),
    btPort: parsePort(env.BT_PORT, DEFAULT_BT_PORT),
    portDomain: normalizeHostname(env.TUNNEL_PORT_DOMAIN || ""),
    portHostPrefix: String(env.TUNNEL_PORT_HOST_PREFIX || "p").trim() || "p",
    portHostTemplate: String(env.TUNNEL_PORT_HOST_TEMPLATE || "").trim(),
    apiToken: String(env.CLOUDFLARE_API_TOKEN || "").trim(),
    useLocalConfig:
      String(env.CLOUDFLARE_TUNNEL_LOCAL_CONFIG || "")
        .trim()
        .toLowerCase() === "true",
    useRemoteConfig:
      String(env.CLOUDFLARE_TUNNEL_LOCAL_CONFIG || "")
        .trim()
        .toLowerCase() !== "true",
  };
}

function mapIngressForApi(ingressRules) {
  return ingressRules.map((rule) => {
    const item = { service: rule.service };
    if (rule.hostname) {
      item.hostname = rule.hostname;
    }
    if (rule.originRequest) {
      item.originRequest = rule.originRequest;
    }
    return item;
  });
}

async function publishRemoteIngress(credentials, ingressRules, apiToken) {
  if (!apiToken) {
    return { skipped: true, reason: "CLOUDFLARE_API_TOKEN 未设置" };
  }
  if (!credentials?.AccountTag || !credentials?.TunnelID) {
    throw new Error("无法从 token 解析 Account ID 或 Tunnel ID");
  }

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${credentials.AccountTag}/cfd_tunnel/${credentials.TunnelID}/configurations`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        config: {
          ingress: mapIngressForApi(ingressRules),
        },
      }),
    }
  );

  const json = await response.json();
  if (!response.ok || !json.success) {
    const message =
      json.errors?.map((item) => item.message).filter(Boolean).join("; ") ||
      `HTTP ${response.status}`;
    throw new Error(`Cloudflare API 更新隧道路由失败: ${message}`);
  }

  return { skipped: false, result: json.result };
}

function buildPortHostname(port, settings) {
  if (settings.portHostTemplate) {
    return normalizeHostname(
      settings.portHostTemplate.replace(/\{port\}/g, String(port))
    );
  }
  if (!settings.portDomain) {
    return "";
  }
  return normalizeHostname(`${settings.portHostPrefix}${port}.${settings.portDomain}`);
}

function readBaotaPanelPort(runtimeDir, fallbackPort) {
  const systemPortFile = "/www/server/panel/data/port.pl";
  if (fs.existsSync(systemPortFile)) {
    try {
      const value = Number.parseInt(fs.readFileSync(systemPortFile, "utf8").trim(), 10);
      if (Number.isInteger(value) && value >= 1 && value <= 65535) {
        return value;
      }
    } catch {
      // ignore
    }
  }
  return fallbackPort;
}

function buildIngressRules(settings, bindings = []) {
  const rules = [];

  if (settings.nodeHostname) {
    rules.push({
      hostname: settings.nodeHostname,
      service: `http://127.0.0.1:${settings.xrayPort}`,
    });
  }

  if (settings.btHostname) {
    rules.push({
      hostname: settings.btHostname,
      service: `https://127.0.0.1:${settings.btPort}`,
      originRequest: {
        noTLSVerify: true,
      },
    });
  }

  for (const binding of bindings) {
    const hostname = binding.hostname || buildPortHostname(binding.port, settings);
    if (!hostname) {
      continue;
    }
    const protocol = String(binding.protocol || "http").toLowerCase() === "https"
      ? "https"
      : "http";
    const rule = {
      hostname,
      service: `${protocol}://127.0.0.1:${binding.port}`,
    };
    if (protocol === "https") {
      rule.originRequest = { noTLSVerify: true };
    }
    rules.push(rule);
  }

  rules.push({ service: "http_status:404" });
  return rules;
}

function yamlQuote(value) {
  return JSON.stringify(String(value));
}

function renderConfigYaml(tunnelId, credentialsPath, ingressRules) {
  const lines = [
    `tunnel: ${tunnelId}`,
    `credentials-file: ${credentialsPath}`,
    "ingress:",
  ];

  for (const rule of ingressRules) {
    lines.push("  -");
    if (rule.hostname) {
      lines.push(`    hostname: ${yamlQuote(rule.hostname)}`);
    }
    lines.push(`    service: ${yamlQuote(rule.service)}`);
    if (rule.originRequest?.noTLSVerify) {
      lines.push("    originRequest:");
      lines.push("      noTLSVerify: true");
    }
  }

  return `${lines.join("\n")}\n`;
}

function buildTunnelArtifacts(options = {}) {
  const runtimeDir = options.runtimeDir || process.cwd();
  const env = options.env || process.env;
  const settings = resolveTunnelSettings(env);
  const bindings = Array.isArray(options.bindings) ? options.bindings : [];
  const btPort = readBaotaPanelPort(runtimeDir, settings.btPort);
  const effectiveSettings = { ...settings, btPort };

  const configPath = path.join(runtimeDir, CONFIG_FILE);
  const credentialsPath = path.join(runtimeDir, CREDENTIALS_FILE);
  const logPath = path.join(runtimeDir, LOG_FILE);

  if (!settings.enabled) {
    return {
      settings: effectiveSettings,
      enabled: false,
      configPath,
      credentialsPath,
      logPath,
      ingressRules: [],
    };
  }

  if (!settings.credentials) {
    throw new Error("CLOUDFLARE_TUNNEL_TOKEN 无效，或请设置 CLOUDFLARE_TUNNEL_CREDENTIALS_FILE");
  }

  if (!settings.nodeHostname && !settings.btHostname && bindings.length === 0) {
    throw new Error("请至少设置 TUNNEL_NODE_HOSTNAME、TUNNEL_BT_HOSTNAME 或绑定一个端口");
  }

  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(
    credentialsPath,
    `${JSON.stringify(settings.credentials, null, 2)}\n`,
    "utf8"
  );

  const ingressRules = buildIngressRules(effectiveSettings, bindings);
  const configYaml = settings.useRemoteConfig
    ? ""
    : renderConfigYaml(settings.credentials.TunnelID, credentialsPath, ingressRules);

  if (configYaml) {
    fs.writeFileSync(configPath, configYaml, "utf8");
  }

  return {
    settings: effectiveSettings,
    enabled: true,
    configPath,
    credentialsPath,
    logPath,
    ingressRules,
    configYaml,
    tunnelId: settings.credentials.TunnelID,
  };
}

module.exports = {
  DEFAULT_XRAY_PORT,
  DEFAULT_BT_PORT,
  PROCESS_NAME,
  CONFIG_FILE,
  CREDENTIALS_FILE,
  LOG_FILE,
  decodeTunnelToken,
  resolveTunnelSettings,
  buildPortHostname,
  buildIngressRules,
  renderConfigYaml,
  buildTunnelArtifacts,
  publishRemoteIngress,
  mapIngressForApi,
  readBaotaPanelPort,
  normalizeHostname,
};
