const fs = require("node:fs");
const path = require("node:path");
const { runScript } = require("./script-runner");

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

  async resolveHostname(port) {
    if (!this.tunnelManager) {
      return "";
    }
    try {
      const { stdout } = await runScript(this.execAsync, "tunnel-port-hostname.sh", {
        cwd: this.cwd,
        timeout: 10_000,
        env: { PORT: String(port) },
      });
      return String(stdout || "").trim();
    } catch {
      return "";
    }
  }

  async ensureCloudflared() {
    if (fs.existsSync(this.cloudflaredPath)) {
      return this.cloudflaredPath;
    }

    const { stdout } = await runScript(this.execAsync, "ensure-cloudflared.sh", {
      cwd: this.cwd,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    const binPath = String(stdout || "").trim().split(/\r?\n/).pop();
    if (!binPath || !fs.existsSync(binPath)) {
      throw new Error("cloudflared 下载失败");
    }
    return binPath;
  }

  async isProcessRunning(port) {
    if (this.usesNamedTunnel()) {
      return this.tunnelManager.isRunning();
    }

    const { stdout } = await runScript(this.execAsync, "port-tunnel-running.sh", {
      cwd: this.cwd,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      env: { PORT: String(port) },
    });
    return Boolean(String(stdout || "").trim());
  }

  async stopTunnel(port) {
    if (this.usesNamedTunnel()) {
      return;
    }

    await runScript(this.execAsync, "stop-port-tunnel.sh", {
      cwd: this.cwd,
      timeout: 5000,
      env: { PORT: String(port) },
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
      const hostname = this.getTunnelRecord(port)?.hostname || (await this.resolveHostname(port));
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

    await runScript(this.execAsync, "start-port-tunnel.sh", {
      cwd: this.cwd,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      env: {
        PORT: String(port),
        PROTOCOL: protocol,
      },
    });

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
    const hostname = await this.resolveHostname(port);

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
