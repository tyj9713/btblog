const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  PROCESS_NAME,
  LOG_FILE,
  buildPortHostname,
  buildTunnelArtifacts,
  publishRemoteIngress,
  resolveTunnelSettings,
} = require("./cloudflare-tunnel-config");

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class CloudflareTunnelManager {
  constructor(options = {}) {
    this.execAsync = options.execAsync;
    this.logger = options.logger || console;
    this.cwd = options.cwd || process.cwd();
    this.env = options.env || process.env;
    this.cloudflaredPath =
      options.cloudflaredPath || path.join(this.cwd, "cloudflared-linux");
    this.stateFile = options.stateFile || path.join(this.cwd, "port-tunnels.json");
    this.syncPromise = null;
    this.lastError = "";
    this.lastSyncAt = "";
  }

  logPath() {
    return path.join(this.cwd, LOG_FILE);
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

  getSettings() {
    return resolveTunnelSettings(this.env);
  }

  isEnabled() {
    return Boolean(this.getSettings().credentials);
  }

  readPortBindings() {
    if (!fs.existsSync(this.stateFile)) {
      return [];
    }
    try {
      const state = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      const settings = this.getSettings();
      return Object.keys(state || {})
        .map((key) => Number.parseInt(key, 10))
        .filter((port) => Number.isInteger(port))
        .sort((a, b) => a - b)
        .map((port) => {
          const item = state[String(port)] || {};
          return {
            port,
            protocol: item.protocol || "http",
            hostname: item.hostname || buildPortHostname(port, settings),
          };
        });
    } catch {
      return [];
    }
  }

  buildNodeUrl() {
    const settings = this.getSettings();
    return settings.nodeHostname ? `https://${settings.nodeHostname}` : "";
  }

  buildBaotaUrl(panelPath = "") {
    const settings = this.getSettings();
    if (!settings.btHostname) {
      return "";
    }
    const suffix = panelPath && !panelPath.startsWith("/") ? `/${panelPath}` : panelPath || "";
    return `https://${settings.btHostname}${suffix}`;
  }

  buildLogSummary(status = null) {
    const current = status || {};
    const settings = this.getSettings();
    const lines = [
      "[固定隧道状态]",
      `enabled: ${this.isEnabled()}`,
      `running: ${Boolean(current.running)}`,
      `mode: ${settings.useRemoteConfig ? "token" : "local-config"}`,
      `node: ${settings.nodeHostname || "-"} -> 127.0.0.1:${settings.xrayPort}`,
      `bt: ${settings.btHostname || "-"} -> 127.0.0.1:${settings.btPort}`,
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

  async ensureCloudflared() {
    if (fs.existsSync(this.cloudflaredPath)) {
      return this.cloudflaredPath;
    }

    const archScript =
      "case \"$(uname -m)\" in " +
      "x86_64|x64|amd64) echo amd64 ;; " +
      "aarch64|arm64) echo arm64 ;; " +
      "*) echo unsupported ;; esac";

    const { stdout } = await this.execAsync(archScript, {
      cwd: this.cwd,
      timeout: 5000,
      shell: "/bin/bash",
    });
    const arch = String(stdout || "").trim();
    if (arch !== "amd64" && arch !== "arm64") {
      throw new Error(`当前架构不支持 cloudflared: ${arch || "unknown"}`);
    }

    const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`;
    const quotedBin = shellQuote(this.cloudflaredPath);
    this.appendLog(`downloading cloudflared (${arch})`);
    await this.execAsync(
      `curl -fsSL ${shellQuote(url)} -o ${quotedBin} && chmod +x ${quotedBin}`,
      {
        cwd: this.cwd,
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
      }
    );

    if (!fs.existsSync(this.cloudflaredPath)) {
      throw new Error("cloudflared 下载失败");
    }
    return this.cloudflaredPath;
  }

  async isRunning() {
    const checks = [
      `ps -ef | grep -v grep | grep -F ${shellQuote(PROCESS_NAME)} || true`,
      `ps -ef | grep -v grep | grep -F ${shellQuote(this.cloudflaredPath)} | grep -F 'tunnel run' || true`,
      `ps -ef | grep -v grep | grep -F ${shellQuote(this.cloudflaredPath)} | grep -F 'tunnel --config' || true`,
    ];

    for (const command of checks) {
      const { stdout } = await this.execAsync(command, {
        cwd: this.cwd,
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      });
      if (String(stdout || "").trim()) {
        return true;
      }
    }
    return false;
  }

  async stop() {
    await this.execAsync(`pkill -9 -f ${shellQuote(PROCESS_NAME)} >/dev/null 2>&1 || true`, {
      cwd: this.cwd,
      timeout: 5000,
    });
    await this.execAsync(
      `pkill -9 -f ${shellQuote(`${this.cloudflaredPath} tunnel`)} >/dev/null 2>&1 || true`,
      {
        cwd: this.cwd,
        timeout: 5000,
      }
    );
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

  startCloudflaredProcess(settings, artifacts) {
    const args =
      settings.useRemoteConfig && settings.token
        ? ["tunnel", "run", "--token", settings.token, "--no-autoupdate", "--protocol", "http2"]
        : [
            "tunnel",
            "--config",
            artifacts.configPath,
            "run",
            "--no-autoupdate",
            "--protocol",
            "http2",
          ];

    const logFd = fs.openSync(artifacts.logPath, "a");
    const child = spawn(this.cloudflaredPath, args, {
      cwd: this.cwd,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, ...this.env },
      argv0: PROCESS_NAME,
    });
    child.unref();
    fs.closeSync(logFd);
    this.appendLog(`started cloudflared pid=${child.pid || "unknown"} reason=${settings.useRemoteConfig ? "token" : "config"}`);
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
    const settings = this.getSettings();
    const bindings = this.readPortBindings();
    const artifacts = buildTunnelArtifacts({
      runtimeDir: this.cwd,
      env: this.env,
      bindings,
    });

    let routePublish = { skipped: true };
    if (settings.useRemoteConfig) {
      try {
        routePublish = await publishRemoteIngress(
          settings.credentials,
          artifacts.ingressRules,
          settings.apiToken
        );
        if (routePublish.skipped) {
          this.appendLog(
            "route publish skipped: CLOUDFLARE_API_TOKEN 未设置，将仅启动 connector"
          );
        } else {
          this.appendLog("route publish ok via Cloudflare API");
        }
      } catch (error) {
        routePublish = { skipped: false, error: error.message };
        this.appendLog(`route publish failed: ${error.message}`);
        this.logger.warn(`Cloudflare API 推送路由失败，仍尝试启动隧道: ${error.message}`);
      }
    }

    await this.ensureCloudflared();
    await this.stop();
    fs.writeFileSync(artifacts.logPath, "", "utf8");
    this.startCloudflaredProcess(settings, artifacts);

    await sleep(2500);
    let running = await this.isRunning();
    if (!running) {
      await sleep(2500);
      running = await this.isRunning();
    }

    if (!running) {
      const tail = this.readLogTail(1200);
      this.lastError = `启动固定隧道失败${tail ? `: ${tail.trim()}` : ""}`;
      this.appendLog(this.lastError);
      throw new Error(this.lastError);
    }

    this.lastSyncAt = new Date().toISOString();
    this.appendLog(`sync ok (${reason})`);
    return {
      enabled: true,
      running,
      reason,
      nodeUrl: this.buildNodeUrl(),
      baotaUrl: this.buildBaotaUrl(),
      ingressRules: artifacts.ingressRules,
      routePublish,
      logTail: this.readLogTail(),
    };
  }

  async status() {
    const settings = this.getSettings();
    const running = await this.isRunning();
    return {
      enabled: this.isEnabled(),
      running,
      remoteConfig: settings.useRemoteConfig,
      nodeHostname: settings.nodeHostname,
      btHostname: settings.btHostname,
      xrayPort: settings.xrayPort,
      btPort: settings.btPort,
      nodeUrl: this.buildNodeUrl(),
      baotaUrl: this.buildBaotaUrl(),
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
  shellQuote,
};
