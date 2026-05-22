const fs = require("node:fs");
const path = require("node:path");
const { runScript } = require("./script-runner");

const SHELL_ENV_FILE = "named-tunnel.env";
const LOG_FILE = "named-tunnel.log";
const SYNC_RESULT_FILE = "named-tunnel-sync-result.json";
const ROUTE_PUBLISH_FILE = "named-tunnel-route-publish.json";
const STORED_CONFIG_KEYS = [
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
];

function readJsonFile(filePath, fallback = null) {
  if (!filePath || !fs.existsSync(filePath)) {
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

class CloudflareTunnelManager {
  constructor(options = {}) {
    this.execAsync = options.execAsync;
    this.logger = options.logger || console;
    this.cwd = options.cwd || process.cwd();
    this.env = options.env || process.env;
    this.settingsFile =
      options.settingsFile || path.join(this.cwd, "named-tunnel-settings.json");
    this.stateFile = options.stateFile || path.join(this.cwd, "port-tunnels.json");
    this.syncPromise = null;
    this.lastError = "";
    this.lastSyncAt = "";
    this.cachedSettings = null;
  }

  logPath() {
    return path.join(this.cwd, LOG_FILE);
  }

  syncResultPath() {
    return path.join(this.cwd, SYNC_RESULT_FILE);
  }

  routePublishPath() {
    return path.join(this.cwd, ROUTE_PUBLISH_FILE);
  }

  appendLog(message) {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    try {
      fs.mkdirSync(this.cwd, { recursive: true });
      fs.appendFileSync(this.logPath(), line, "utf8");
    } catch (error) {
      this.logger.error(`写入固定隧道日志失败: ${error.message}`);
    }
  }

  readStoredConfig() {
    if (!fs.existsSync(this.settingsFile)) {
      return {};
    }
    try {
      const config = JSON.parse(fs.readFileSync(this.settingsFile, "utf8"));
      return config && typeof config === "object" ? config : {};
    } catch (error) {
      this.lastError = `读取固定隧道配置失败: ${error.message}`;
      return {};
    }
  }

  writeStoredConfig(config) {
    fs.mkdirSync(this.cwd, { recursive: true });
    fs.writeFileSync(this.settingsFile, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    this.cachedSettings = null;
  }

  getConfigEnv() {
    return this.readStoredConfig();
  }

  applyStoredConfigToProcessEnv(baseEnv = process.env) {
    const stored = this.readStoredConfig();
    for (const key of STORED_CONFIG_KEYS) {
      const value = String(stored[key] ?? "").trim();
      if (value) {
        baseEnv[key] = value;
      }
    }
    return baseEnv;
  }

  sanitizeConfigInput(input = {}) {
    const current = this.readStoredConfig();
    const text = (name) => String(input[name] ?? "").trim();
    const keepSecret = (name) => {
      const value = text(name);
      return value || current[name] || "";
    };
    const keepText = (name, fallback = "") => {
      const value = text(name);
      return value || current[name] || fallback;
    };

    const config = {
      CLOUDFLARE_TUNNEL_TOKEN: keepSecret("CLOUDFLARE_TUNNEL_TOKEN"),
      CLOUDFLARE_API_TOKEN: keepSecret("CLOUDFLARE_API_TOKEN"),
      CLOUDFLARE_ACCOUNT_ID: keepText("CLOUDFLARE_ACCOUNT_ID"),
      CLOUDFLARE_TUNNEL_ID: keepText("CLOUDFLARE_TUNNEL_ID"),
      CLOUDFLARE_TUNNEL_REMOTE_CONFIG: "true",
      CLOUDFLARE_TUNNEL_LOCAL_CONFIG: "false",
      TUNNEL_NODE_HOSTNAME: keepText("TUNNEL_NODE_HOSTNAME"),
      TUNNEL_BT_HOSTNAME: keepText("TUNNEL_BT_HOSTNAME"),
      TUNNEL_PORT_DOMAIN: keepText("TUNNEL_PORT_DOMAIN"),
      TUNNEL_PORT_HOST_PREFIX: keepText("TUNNEL_PORT_HOST_PREFIX", "p"),
      TUNNEL_PORT_HOST_TEMPLATE: keepText("TUNNEL_PORT_HOST_TEMPLATE"),
      XRAY_PORT: keepText("XRAY_PORT", "10086"),
      BT_PORT: keepText("BT_PORT", "8888"),
    };

    return Object.fromEntries(
      Object.entries(config).filter(([, value]) => String(value || "").trim() !== "")
    );
  }

  async runTunnelScript(scriptName, options = {}) {
    return runScript(this.execAsync, scriptName, {
      cwd: this.cwd,
      timeout: options.timeout || 120_000,
      maxBuffer: options.maxBuffer || 4 * 1024 * 1024,
      env: {
        ...this.env,
        ...options.env,
        ARGO_RUNTIME_DIR: this.cwd,
        REASON: options.reason || "",
      },
    });
  }

  async loadSettings() {
    const { stdout } = await this.runTunnelScript("tunnel-resolve-settings.sh", {
      timeout: 15_000,
    });
    const settings = JSON.parse(String(stdout || "").trim() || "{}");
    this.cachedSettings = settings;
    return settings;
  }

  async getSettings() {
    if (this.cachedSettings) {
      return this.cachedSettings;
    }
    return this.loadSettings();
  }

  async configStatus() {
    const { stdout } = await this.runTunnelScript("tunnel-config-status.sh", {
      timeout: 15_000,
    });
    const status = JSON.parse(String(stdout || "").trim() || "{}");
    return {
      ...status,
      settingsFile: this.settingsFile,
    };
  }

  async saveConfig(input = {}) {
    const config = this.sanitizeConfigInput(input);
    this.writeStoredConfig(config);
    await this.syncRuntimeConfig();
    this.lastError = "";
    this.appendLog("config saved");

    let routePublish = { skipped: true, reason: "未执行路由推送" };
    try {
      const { stdout } = await this.runTunnelScript("publish-tunnel-routes.sh", {
        reason: "config-save",
        timeout: 60_000,
      });
      routePublish = JSON.parse(String(stdout || "").trim() || "{}");
    } catch (error) {
      routePublish = readJsonFile(this.routePublishPath(), {
        skipped: false,
        error: error.message,
      });
    }

    return {
      ...(await this.configStatus()),
      routePublish,
    };
  }

  async publishRoutes(reason = "manual") {
    try {
      const { stdout } = await this.runTunnelScript("publish-tunnel-routes.sh", {
        reason,
        timeout: 60_000,
      });
      const result = JSON.parse(String(stdout || "").trim() || "{}");
      if (!result.skipped) {
        this.appendLog(`route publish ok (${reason})`);
      }
      return result;
    } catch (error) {
      const fallback = readJsonFile(this.routePublishPath(), {
        skipped: false,
        error: error.message,
      });
      throw new Error(fallback.error || error.message);
    }
  }

  isEnabled() {
    const config = this.readStoredConfig();
    return Boolean(String(config.CLOUDFLARE_TUNNEL_TOKEN || "").trim());
  }

  readPortBindings() {
    const state = readJsonFile(this.stateFile, {});
    if (!state || typeof state !== "object") {
      return [];
    }
    return Object.keys(state)
      .map((key) => Number.parseInt(key, 10))
      .filter((port) => Number.isInteger(port))
      .sort((a, b) => a - b)
      .map((port) => {
        const item = state[String(port)] || {};
        return {
          port,
          protocol: item.protocol || "http",
          hostname: item.hostname || "",
        };
      });
  }

  buildNodeUrl(settings) {
    return settings.nodeHostname ? `https://${settings.nodeHostname}` : "";
  }

  buildBaotaUrl(settings, panelPath = "") {
    if (!settings.btHostname) {
      return "";
    }
    const suffix =
      panelPath && !panelPath.startsWith("/") ? `/${panelPath}` : panelPath || "";
    return `https://${settings.btHostname}${suffix}`;
  }

  buildLogSummary(status = null) {
    const settings = this.cachedSettings || {};
    const current = status || {};
    const lines = [
      "[固定隧道状态]",
      `enabled: ${this.isEnabled()}`,
      `running: ${Boolean(current.running)}`,
      `mode: ${settings.useRemoteConfig ? "token-env" : "local-config"}`,
      `node: ${settings.nodeHostname || "-"} -> 127.0.0.1:${settings.xrayPort || "-"}`,
      `bt: ${settings.btHostname || "-"} -> 127.0.0.1:${settings.btPort || "-"}`,
      `apiToken: ${settings.apiToken ? "已配置" : "未配置"}`,
      `lastSyncAt: ${this.lastSyncAt || "-"}`,
    ];
    if (this.lastError) {
      lines.push(`lastError: ${this.lastError}`);
    }
    if (current.needsPublicHostnames) {
      lines.push(
        "hint: 未设置 CLOUDFLARE_API_TOKEN 时，需要在 Cloudflare 控制台手动添加 Public Hostname"
      );
    }
    lines.push("", "===== named-tunnel.log =====", this.readLogTail(12000) || "暂无固定隧道日志");
    return lines.join("\n");
  }

  readLogTail(limit = 4000) {
    const logPath = this.logPath();
    if (!fs.existsSync(logPath)) {
      return "";
    }
    try {
      return fs.readFileSync(logPath, "utf8").slice(-limit);
    } catch {
      return "";
    }
  }

  async isRunning() {
    try {
      const { stdout } = await this.runTunnelScript("named-tunnel-running.sh", {
        timeout: 5000,
      });
      return Boolean(String(stdout || "").trim());
    } catch {
      return false;
    }
  }

  async stop() {
    await this.runTunnelScript("stop-named-tunnel.sh", { timeout: 5000 });
  }

  async syncRuntimeConfig() {
    this.applyStoredConfigToProcessEnv();
    await this.runTunnelScript("sync-tunnel-runtime.sh", { timeout: 15_000 });
    this.cachedSettings = null;
    return path.join(this.cwd, SHELL_ENV_FILE);
  }

  async sync(reason = "manual") {
    if (!this.isEnabled()) {
      this.lastError = "CLOUDFLARE_TUNNEL_TOKEN 未设置或无效";
      return { enabled: false, running: false, reason: this.lastError };
    }

    if (this.syncPromise) {
      return this.syncPromise;
    }

    this.syncPromise = this._sync(reason).finally(() => {
      this.syncPromise = null;
    });
    return this.syncPromise;
  }

  async _sync(reason) {
    this.lastError = "";
    this.appendLog(`sync start (${reason})`);

    try {
      await this.runTunnelScript("sync-named-tunnel.sh", {
        reason,
        timeout: 180_000,
      });
    } catch (error) {
      const tail = this.readLogTail(1200);
      this.lastError = error.message || `同步固定隧道失败${tail ? `: ${tail.trim()}` : ""}`;
      this.appendLog(this.lastError);
      throw new Error(this.lastError);
    }

    const result = readJsonFile(this.syncResultPath(), null);
    if (!result || !result.ok) {
      const message = result?.error || "同步固定隧道失败";
      this.lastError = message;
      this.appendLog(this.lastError);
      throw new Error(message);
    }

    const settings = await this.loadSettings();
    this.lastSyncAt = new Date().toISOString();
    this.appendLog(`sync ok (${reason})`);
    return {
      enabled: true,
      running: Boolean(result.running),
      reason,
      nodeUrl: result.nodeUrl || this.buildNodeUrl(settings),
      baotaUrl: result.baotaUrl || this.buildBaotaUrl(settings),
      ingressRules: result.ingressRules || [],
      routePublish: result.routePublish || readJsonFile(this.routePublishPath(), { skipped: true }),
      logTail: this.readLogTail(),
    };
  }

  async status() {
    const settings = await this.getSettings();
    const running = await this.isRunning();
    return {
      enabled: this.isEnabled(),
      running,
      remoteConfig: settings.useRemoteConfig,
      nodeHostname: settings.nodeHostname,
      btHostname: settings.btHostname,
      xrayPort: settings.xrayPort,
      btPort: settings.btPort,
      nodeUrl: this.buildNodeUrl(settings),
      baotaUrl: this.buildBaotaUrl(settings),
      bindings: this.readPortBindings(),
      needsPublicHostnames: settings.useRemoteConfig && !settings.apiToken,
      lastError: this.lastError,
      lastSyncAt: this.lastSyncAt,
      logTail: this.readLogTail(),
    };
  }

  async ensureRunning(reason = "keepalive") {
    if (!this.isEnabled()) {
      return { started: false, enabled: false, reason: this.lastError || "token missing" };
    }
    if (await this.isRunning()) {
      return { started: false, running: true };
    }
    const result = await this.sync(reason);
    return { started: true, running: result.running, result };
  }
}

module.exports = {
  CloudflareTunnelManager,
  SHELL_ENV_FILE,
  STORED_CONFIG_KEYS,
};
