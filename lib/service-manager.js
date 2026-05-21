const fs = require("node:fs");

const DEFAULT_PROCESS_COMMAND =
  "ps -ef | grep -v grep | grep -E 'xray/xray|cloudflared-linux' || true";
const DEFAULT_SCRIPT = "suoha.sh";

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function normalizeShellScriptLineEndings(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return false;
  }

  const content = fs.readFileSync(filePath);
  if (!content.includes(0x0d)) {
    return false;
  }

  const normalized = content
    .toString("utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  fs.writeFileSync(filePath, normalized, "utf8");
  return true;
}

function processLines(stdout) {
  return String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/\bgrep\b/.test(line));
}

function parseProcessStatus(stdout, options = {}) {
  const lines = processLines(stdout);
  const xrayRunning = lines.some((line) => /(^|\s)(\.\/)?xray\/xray(\s|$)/.test(line));
  const namedTunnelRunning = lines.some((line) => /btblog-named-tunnel/.test(line));
  const quickCloudflaredRunning = lines.some(
    (line) =>
      /cloudflared-linux/.test(line) &&
      !/btblog-named-tunnel|baota-panel-tunnel|port-tunnel-/.test(line)
  );
  const namedTunnelEnabled = Boolean(options.namedTunnelEnabled);
  const argoRunning = namedTunnelEnabled
    ? namedTunnelRunning
    : namedTunnelRunning || quickCloudflaredRunning;

  return {
    xrayRunning,
    argoRunning,
    namedTunnelRunning,
    bothRunning: xrayRunning && argoRunning,
    processes: lines.join("\n"),
  };
}

function buildReadyResponse(status, uptime) {
  const body = {
    ok: status.bothRunning,
    uptime,
    suoha: status,
  };

  return {
    statusCode: status.bothRunning ? 200 : 503,
    body,
  };
}

class ServiceManager {
  constructor(options = {}) {
    this.execAsync = options.execAsync;
    this.logger = options.logger || console;
    this.script = options.script || DEFAULT_SCRIPT;
    this.cwd = options.cwd;
    this.logFile = options.logFile;
    this.namedTunnelEnabled = Boolean(options.namedTunnelEnabled);
    this.startPromise = null;
    this.operatorStopped = false;
  }

  async status() {
    const { stdout } = await this.execAsync(DEFAULT_PROCESS_COMMAND, {
      cwd: this.cwd,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return parseProcessStatus(stdout, {
      namedTunnelEnabled: this.namedTunnelEnabled,
    });
  }

  async stop() {
    this.operatorStopped = true;
    await this.killProcesses();
    return { message: "服务停止成功" };
  }

  async killProcesses() {
    await this.execAsync("pkill -9 -f 'xray/xray' || true", {
      cwd: this.cwd,
      timeout: 10000,
    });
    if (this.namedTunnelEnabled) {
      return;
    }
    await this.execAsync("pkill -9 -f 'cloudflared-linux tunnel --url' || true", {
      cwd: this.cwd,
      timeout: 10000,
    });
  }

  async start(reason = "manual") {
    this.operatorStopped = false;
    if (this.startPromise) {
      this.logger.log(`suoha start already running, joining existing start: ${reason}`);
      return this.startPromise;
    }

    this.startPromise = this._start(reason).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  isStarting() {
    return Boolean(this.startPromise);
  }

  async restart(reason = "manual") {
    this.operatorStopped = false;
    if (this.startPromise) {
      await this.startPromise.catch(() => {});
    }
    await this.killProcesses();
    return this.start(`restart:${reason}`);
  }

  async ensureRunning(reason = "keepalive") {
    const status = await this.status();
    if (this.operatorStopped) {
      return { started: false, suppressed: true, status };
    }

    if (status.bothRunning) {
      return { started: false, status };
    }

    const result = await this.start(reason);
    return { started: true, status, result };
  }

  async _start(reason) {
    this.logger.log(`starting suoha service: ${reason}`);
    const scriptPath = typeof this.script === "function" ? this.script() : this.script;
    const script = shellQuote(scriptPath);
    if (normalizeShellScriptLineEndings(scriptPath)) {
      this.writeStartLog(`normalized CRLF line endings for ${scriptPath}\n`);
    }
    this.writeStartLog(`\n[${new Date().toISOString()}] starting suoha service: ${reason}\nscript=${scriptPath}\ncwd=${this.cwd || process.cwd()}\n`);
    await this.execAsync(`chmod +x ${script}`, {
      cwd: this.cwd,
      timeout: 10000,
    });

    let stdout = "";
    try {
      const result = await this.execAsync(`bash ${script} 2>&1`, {
        cwd: this.cwd,
        timeout: 120000,
        maxBuffer: 4 * 1024 * 1024,
      });
      stdout = result.stdout || "";
      this.writeStartLog(stdout);
    } catch (error) {
      stdout = [error.stdout, error.stderr, error.message]
        .filter(Boolean)
        .map((value) => value.toString())
        .join("\n");
      this.writeStartLog(stdout || error.message);
      throw error;
    }
    const status = await this.status();
    if (this.operatorStopped) {
      await this.killProcesses();
      return {
        message: "启动已被停止请求取消",
        details: stdout,
        status: await this.status(),
      };
    }

    return {
      message: status.bothRunning ? "服务启动成功" : "启动命令已执行，但进程未全部运行",
      details: stdout,
      status,
    };
  }

  writeStartLog(content) {
    if (!this.logFile) {
      return;
    }

    try {
      fs.appendFileSync(this.logFile, content, "utf8");
    } catch (error) {
      this.logger.error(`写入启动日志失败: ${error.message}`);
    }
  }
}

module.exports = {
  ServiceManager,
  parseProcessStatus,
  buildReadyResponse,
  shellQuote,
  normalizeShellScriptLineEndings,
};
