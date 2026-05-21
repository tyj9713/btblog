const fs = require("node:fs");
const path = require("node:path");

const STATE_FILE = "port-tunnels.json";
const DEFAULT_MAX_TUNNELS = 8;

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function parsePort(value) {
  const port = Number.parseInt(String(value), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("端口必须是 1-65535 之间的整数");
  }
  return port;
}

function parseProtocol(value) {
  const protocol = String(value || "http").toLowerCase();
  if (protocol !== "http" && protocol !== "https") {
    throw new Error("协议仅支持 http 或 https");
  }
  return protocol;
}

function tunnelProcessName(port) {
  return `port-tunnel-${port}`;
}

function tunnelLogFileName(port) {
  return `port-tunnel-${port}.log`;
}

function buildOrigin(port, protocol) {
  return `${protocol}://127.0.0.1:${port}`;
}

function extractTryCloudflareUrl(text) {
  const match = String(text || "").match(
    /https?:\/\/[a-z0-9-]+\.trycloudflare\.com[^\s]*/i
  );
  return match ? match[0].replace(/[)\]}>,]+$/, "") : "";
}

function buildNamedTunnelUrl(hostname) {
  const host = String(hostname || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  return host ? `https://${host}` : "";
}

function readJsonFile(filePath, fallback) {
  if (!filePath || !fs.existsSync(filePath)) {
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class PortTunnelManager {
  constructor(options = {}) {
    this.execAsync = options.execAsync;
    this.logger = options.logger || console;
    this.cwd = options.cwd;
    this.cloudflaredPath =
      options.cloudflaredPath || path.join(this.cwd, "cloudflared-linux");
    this.stateFile = options.stateFile || path.join(this.cwd, STATE_FILE);
    this.maxTunnels = Number(options.maxTunnels || DEFAULT_MAX_TUNNELS);
    this.tunnelManager = options.tunnelManager || null;
    this.bindPromises = new Map();
  }

  usesNamedTunnel() {
    return Boolean(this.tunnelManager && this.tunnelManager.isEnabled());
  }

  readState() {
    const state = readJsonFile(this.stateFile, {});
    return state && typeof state === "object" ? state : {};
  }

  writeState(state) {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  getTunnelRecord(port) {
    return this.readState()[String(port)] || null;
  }

  upsertTunnelRecord(port, patch) {
    const state = this.readState();
    const key = String(port);
    state[key] = {
      ...(state[key] || {}),
      port,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.writeState(state);
    return state[key];
  }

  removeTunnelRecord(port) {
    const state = this.readState();
    delete state[String(port)];
    this.writeState(state);
  }

  resolveHostname(port) {
    if (this.tunnelManager) {
      const settings = this.tunnelManager.getSettings();
      const { buildPortHostname } = require("./cloudflare-tunnel-config");
      return buildPortHostname(port, settings);
    }
    return "";
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

  async isProcessRunning(port) {
    if (this.usesNamedTunnel()) {
      return this.tunnelManager.isRunning();
    }

    const name = tunnelProcessName(port);
    const { stdout } = await this.execAsync(
      `ps -ef | grep -v grep | grep -F ${shellQuote(name)} || true`,
      {
        cwd: this.cwd,
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      }
    );
    return Boolean(String(stdout || "").trim());
  }

  async stopTunnel(port) {
    if (this.usesNamedTunnel()) {
      return;
    }

    const name = tunnelProcessName(port);
    await this.execAsync(`pkill -9 -f ${shellQuote(name)} >/dev/null 2>&1 || true`, {
      cwd: this.cwd,
      timeout: 5000,
    });
  }

  readTunnelLog(port) {
    if (this.usesNamedTunnel()) {
      return this.tunnelManager.readLogTail() || "";
    }

    const logPath = path.join(this.cwd, tunnelLogFileName(port));
    if (!fs.existsSync(logPath)) {
      return "";
    }
    try {
      return fs.readFileSync(logPath, "utf8");
    } catch {
      return "";
    }
  }

  async waitForTunnelUrl(port) {
    if (this.usesNamedTunnel()) {
      const hostname = this.getTunnelRecord(port)?.hostname || this.resolveHostname(port);
      const url = buildNamedTunnelUrl(hostname);
      if (!url) {
        throw new Error("未配置 TUNNEL_PORT_DOMAIN，无法生成端口固定域名");
      }
      return url;
    }

    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const url = extractTryCloudflareUrl(this.readTunnelLog(port));
      if (url) {
        return url;
      }
      const running = await this.isProcessRunning(port);
      if (!running) {
        throw new Error(`cloudflared 进程已退出，请查看 ${tunnelLogFileName(port)}`);
      }
      await sleep(1000);
    }
    throw new Error("等待临时隧道地址超时，请稍后刷新列表或查看日志");
  }

  async startTunnelProcess(port, protocol) {
    if (this.usesNamedTunnel()) {
      await this.tunnelManager.sync(`port-bind:${port}`);
      return;
    }

    await this.ensureCloudflared();
    await this.stopTunnel(port);

    const origin = buildOrigin(port, protocol);
    const processName = tunnelProcessName(port);
    const logFile = tunnelLogFileName(port);
    const logPath = path.join(this.cwd, logFile);
    fs.writeFileSync(logPath, "", "utf8");

    const quotedBin = shellQuote(this.cloudflaredPath);
    const quotedOrigin = shellQuote(origin);
    const quotedLog = shellQuote(logPath);
    const tlsFlag = protocol === "https" ? "--no-tls-verify " : "";

    const command =
      `nohup bash -c 'exec -a ${shellQuote(processName)} ${quotedBin} tunnel ` +
      `--url ${quotedOrigin} ${tlsFlag}--no-autoupdate --protocol http2 >> ${quotedLog} 2>&1' ` +
      ">/dev/null 2>&1 &";

    await this.execAsync(command, {
      cwd: this.cwd,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });

    await sleep(500);
    if (!(await this.isProcessRunning(port))) {
      const tail = this.readTunnelLog(port).slice(-800);
      throw new Error(
        `启动 cloudflared 失败${tail ? `: ${tail.trim()}` : ""}`
      );
    }
  }

  async bind(portInput, options = {}) {
    const port = parsePort(portInput);
    const protocol = parseProtocol(options.protocol);

    if (this.bindPromises.has(port)) {
      return this.bindPromises.get(port);
    }

    const task = this._bind(port, protocol).finally(() => {
      this.bindPromises.delete(port);
    });
    this.bindPromises.set(port, task);
    return task;
  }

  async _bind(port, protocol) {
    const state = this.readState();
    const activeCount = Object.keys(state).length;
    if (!state[String(port)] && activeCount >= this.maxTunnels) {
      throw new Error(`最多同时绑定 ${this.maxTunnels} 个端口，请先解绑其他端口`);
    }

    this.logger.log(`binding port tunnel: ${port} (${protocol})`);
    const origin = buildOrigin(port, protocol);
    const logFile = this.usesNamedTunnel() ? "named-tunnel.log" : tunnelLogFileName(port);
    const hostname = this.resolveHostname(port);

    if (this.usesNamedTunnel() && !hostname) {
      throw new Error("请设置 TUNNEL_PORT_DOMAIN 后再绑定固定域名端口");
    }

    this.upsertTunnelRecord(port, {
      protocol,
      origin,
      hostname,
      logFile,
      mode: this.usesNamedTunnel() ? "named" : "quick",
      status: "binding",
      url: "",
      createdAt: new Date().toISOString(),
    });

    try {
      await this.startTunnelProcess(port, protocol);
      const url = await this.waitForTunnelUrl(port);
      const record = this.upsertTunnelRecord(port, {
        protocol,
        origin,
        hostname,
        logFile,
        mode: this.usesNamedTunnel() ? "named" : "quick",
        status: "ready",
        url,
        running: true,
      });
      return {
        message: this.usesNamedTunnel()
          ? `端口 ${port} 已绑定固定域名 ${hostname}`
          : `端口 ${port} 已绑定临时隧道`,
        tunnel: await this.describeTunnel(port, record),
      };
    } catch (error) {
      this.upsertTunnelRecord(port, {
        protocol,
        origin,
        hostname,
        logFile,
        mode: this.usesNamedTunnel() ? "named" : "quick",
        status: "failed",
        url: "",
        running: await this.isProcessRunning(port),
        error: error.message,
      });
      throw error;
    }
  }

  async unbind(portInput) {
    const port = parsePort(portInput);
    this.removeTunnelRecord(port);

    if (this.usesNamedTunnel()) {
      await this.tunnelManager.sync(`port-unbind:${port}`);
    } else {
      await this.stopTunnel(port);
    }

    return {
      message: `端口 ${port} 已解绑`,
      port,
    };
  }

  async describeTunnel(port, record = null) {
    const item = record || this.getTunnelRecord(port);
    if (!item) {
      return null;
    }

    const running = await this.isProcessRunning(port);
    const log = this.readTunnelLog(port);
    const url =
      item.url ||
      buildNamedTunnelUrl(item.hostname) ||
      extractTryCloudflareUrl(log);

    return {
      port: Number(item.port || port),
      protocol: item.protocol || "http",
      origin: item.origin || buildOrigin(port, item.protocol || "http"),
      hostname: item.hostname || "",
      url,
      mode: item.mode || (this.usesNamedTunnel() ? "named" : "quick"),
      running,
      status: running && url ? "ready" : item.status || (running ? "starting" : "stopped"),
      logFile: item.logFile || tunnelLogFileName(port),
      createdAt: item.createdAt || null,
      updatedAt: item.updatedAt || null,
      error: item.error || "",
      logTail: log.slice(-4000),
    };
  }

  async list() {
    const state = this.readState();
    const ports = Object.keys(state)
      .map((key) => Number.parseInt(key, 10))
      .filter((port) => Number.isInteger(port))
      .sort((a, b) => a - b);

    const tunnels = [];
    for (const port of ports) {
      const tunnel = await this.describeTunnel(port, state[String(port)]);
      if (tunnel) {
        tunnels.push(tunnel);
      }
    }
    return {
      tunnels,
      maxTunnels: this.maxTunnels,
      mode: this.usesNamedTunnel() ? "named" : "quick",
    };
  }
}

module.exports = {
  PortTunnelManager,
  STATE_FILE,
  parsePort,
  parseProtocol,
  tunnelProcessName,
  tunnelLogFileName,
  buildOrigin,
  buildNamedTunnelUrl,
  extractTryCloudflareUrl,
  shellQuote,
};
