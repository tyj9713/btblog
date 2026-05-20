const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_SCRIPT = "install-baota.sh";
const URL_FILE = "baota-panel-url.txt";
const INSTALL_LOG = "baota-install.log";
const TUNNEL_LOG = "baota-argo.log";
const PROCESS_COMMAND =
  "ps -ef | grep -v grep | grep -E 'baota-panel-tunnel|/www/server/panel/BT-Panel' || true";

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function readTextFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return "";
  }
  try {
    return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return "";
  }
}

function parseBaotaStatus(stdout, options = {}) {
  const lines = String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/\bgrep\b/.test(line));

  const panelRunning = lines.some((line) => /BT-Panel/.test(line));
  const tunnelRunning = lines.some((line) => /baota-panel-tunnel/.test(line));

  const panelUrl = readTextFile(options.urlFile);
  const installed =
    Boolean(options.installedMarker && fs.existsSync(options.installedMarker)) ||
    fs.existsSync("/www/server/panel/BT-Panel");

  return {
    installed,
    panelRunning,
    tunnelRunning,
    ready: installed && tunnelRunning && Boolean(panelUrl),
    panelUrl: panelUrl.split("\n").find((line) => line.startsWith("http")) || "",
    processes: lines.join("\n"),
  };
}

class BaotaManager {
  constructor(options = {}) {
    this.execAsync = options.execAsync;
    this.logger = options.logger || console;
    this.cwd = options.cwd;
    this.script = options.script || DEFAULT_SCRIPT;
    this.urlFile = options.urlFile;
    this.installLog = options.installLog;
    this.tunnelLog = options.tunnelLog;
    this.installedMarker = options.installedMarker;
    this.startPromise = null;
    this.operatorStopped = false;
  }

  async status() {
    const { stdout } = await this.execAsync(PROCESS_COMMAND, {
      cwd: this.cwd,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return parseBaotaStatus(stdout, {
      urlFile: this.urlFile,
      installedMarker: this.installedMarker,
    });
  }

  async start(reason = "manual") {
    this.operatorStopped = false;
    if (this.startPromise) {
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

  async ensureRunning(reason = "keepalive") {
    const status = await this.status();
    if (this.operatorStopped) {
      return { started: false, suppressed: true, status };
    }
    if (status.ready) {
      return { started: false, status };
    }
    const result = await this.start(reason);
    return { started: true, status, result };
  }

  async _start(reason) {
    this.logger.log(`starting baota install/tunnel: ${reason}`);
    const scriptPath =
      typeof this.script === "function" ? this.script() : this.script;
    const quoted = shellQuote(scriptPath);

    await this.execAsync(`chmod +x ${quoted}`, {
      cwd: this.cwd,
      timeout: 10000,
    });

    const result = await this.execAsync(`bash ${quoted} 2>&1`, {
      cwd: this.cwd,
      timeout: 60 * 60 * 1000,
      maxBuffer: 8 * 1024 * 1024,
    });

    return {
      message: "宝塔安装/隧道脚本已执行",
      details: result.stdout || "",
      status: await this.status(),
    };
  }

  getLogs() {
    return {
      installLog: readTextFile(this.installLog) || `${INSTALL_LOG}不存在`,
      tunnelLog: readTextFile(this.tunnelLog) || `${TUNNEL_LOG}不存在`,
      panelUrl: readTextFile(this.urlFile) || `${URL_FILE}不存在`,
    };
  }
}

module.exports = {
  BaotaManager,
  parseBaotaStatus,
  shellQuote,
  URL_FILE,
  INSTALL_LOG,
  TUNNEL_LOG,
};
