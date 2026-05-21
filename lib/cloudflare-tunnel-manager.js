const fs = require("node:fs");
const path = require("node:path");
const {
  PROCESS_NAME,
  LOG_FILE,
  buildPortHostname,
  buildTunnelArtifacts,
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
  }

  getSettings() {
    return resolveTunnelSettings(this.env);
  }

  isEnabled() {
    return this.getSettings().enabled;
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
    const { stdout } = await this.execAsync(
      `ps -ef | grep -v grep | grep -F ${shellQuote(PROCESS_NAME)} || true`,
      {
        cwd: this.cwd,
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      }
    );
    return Boolean(String(stdout || "").trim());
  }

  async stop() {
    await this.execAsync(`pkill -9 -f ${shellQuote(PROCESS_NAME)} >/dev/null 2>&1 || true`, {
      cwd: this.cwd,
      timeout: 5000,
    });
  }

  readLogTail(limit = 4000) {
    const logPath = path.join(this.cwd, LOG_FILE);
    if (!fs.existsSync(logPath)) {
      return "";
    }
    try {
      return fs.readFileSync(logPath, "utf8").slice(-limit);
    } catch {
      return "";
    }
  }

  async sync(reason = "manual") {
    if (!this.isEnabled()) {
      return { enabled: false, running: false, reason: "tunnel token not configured" };
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
    const settings = this.getSettings();
    const bindings = this.readPortBindings();
    const artifacts = buildTunnelArtifacts({
      runtimeDir: this.cwd,
      env: this.env,
      bindings,
    });

    await this.ensureCloudflared();
    await this.stop();

    const quotedBin = shellQuote(this.cloudflaredPath);
    const quotedLog = shellQuote(artifacts.logPath);
    let command;

    if (settings.useRemoteConfig && settings.token) {
      const quotedToken = shellQuote(settings.token);
      command =
        `nohup bash -c 'exec -a ${shellQuote(PROCESS_NAME)} ${quotedBin} tunnel run ` +
        `--token ${quotedToken} --no-autoupdate --protocol http2 >> ${quotedLog} 2>&1' ` +
        ">/dev/null 2>&1 &";
    } else {
      const quotedConfig = shellQuote(artifacts.configPath);
      command =
        `nohup bash -c 'exec -a ${shellQuote(PROCESS_NAME)} ${quotedBin} tunnel ` +
        `--config ${quotedConfig} run --no-autoupdate --protocol http2 >> ${quotedLog} 2>&1' ` +
        ">/dev/null 2>&1 &";
    }

    this.logger.log(`sync named tunnel (${reason})`);
    fs.writeFileSync(artifacts.logPath, "", "utf8");
    await this.execAsync(command, {
      cwd: this.cwd,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });

    await sleep(800);
    const running = await this.isRunning();
    if (!running) {
      const tail = this.readLogTail(800);
      throw new Error(`启动固定隧道失败${tail ? `: ${tail.trim()}` : ""}`);
    }

    return {
      enabled: true,
      running,
      reason,
      nodeUrl: this.buildNodeUrl(),
      baotaUrl: this.buildBaotaUrl(),
      ingressRules: artifacts.ingressRules,
      logTail: this.readLogTail(),
    };
  }

  async status() {
    const settings = this.getSettings();
    const running = await this.isRunning();
    return {
      enabled: settings.enabled,
      running,
      remoteConfig: settings.useRemoteConfig,
      nodeHostname: settings.nodeHostname,
      btHostname: settings.btHostname,
      xrayPort: settings.xrayPort,
      btPort: settings.btPort,
      nodeUrl: this.buildNodeUrl(),
      baotaUrl: this.buildBaotaUrl(),
      bindings: this.readPortBindings(),
      logTail: this.readLogTail(),
    };
  }

  async ensureRunning(reason = "keepalive") {
    if (!this.isEnabled()) {
      return { started: false, enabled: false };
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
