const fs = require("node:fs");
const path = require("node:path");
const { runScript, resolveScript } = require("./script-runner");

const DEFAULT_SCRIPT = "install-baota.sh";
const URL_FILE = "baota-panel-url.txt";
const DEFAULT_FILE = "baota-default.txt";
const INSTALL_LOG = "baota-install.log";
const TUNNEL_LOG = "baota-argo.log";
const BAOTA_PANEL_BIN = "/www/server/panel/BT-Panel";

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function stripAnsi(value) {
  return String(value || "").replace(/\x1b\[[0-9;]*m/g, "");
}

async function readPanelPort(execAsync, runtimeDir, fallbackPort = 8888) {
  try {
    const { stdout } = await runScript(execAsync, "read-baota-panel-port.sh", {
      cwd: runtimeDir,
      timeout: 5000,
    });
    const port = Number.parseInt(String(stdout || "").trim(), 10);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      return port;
    }
  } catch {
    // ignore
  }
  return fallbackPort;
}

function formatBaotaCredentials(defaultInfo) {
  const lines = String(defaultInfo || "").split(/\r?\n/);
  const kept = [];

  for (const line of lines) {
    const trimmed = stripAnsi(line).trim();
    if (!trimmed) {
      continue;
    }
    if (/^=+$/.test(trimmed)) {
      continue;
    }
    if (/BT-Panel default info/i.test(trimmed)) {
      continue;
    }
    if (/外网ipv4面板地址|内网面板地址|外网面板地址|内网ipv6面板地址/i.test(trimmed)) {
      continue;
    }
    if (/^panel=|^port=|^path=|^#/.test(trimmed)) {
      continue;
    }
    kept.push(trimmed);
  }

  return kept.join("\n").trim();
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

function isBaotaPanelPresent(fsModule = fs) {
  return fsModule.existsSync(BAOTA_PANEL_BIN);
}

function clearStaleBaotaMarker(installedMarker, logger = console) {
  if (!installedMarker || !fs.existsSync(installedMarker)) {
    return false;
  }
  if (isBaotaPanelPresent()) {
    return false;
  }

  try {
    fs.unlinkSync(installedMarker);
    logger.warn?.(
      "已清除宝塔安装标记：面板文件不存在，将触发重新安装"
    );
    return true;
  } catch (error) {
    logger.error?.(`清除宝塔安装标记失败: ${error.message}`);
    return false;
  }
}

function parseBaotaStatus(stdout, options = {}) {
  const lines = String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/\bgrep\b/.test(line));

  const panelRunning = lines.some((line) => /(BT-Panel|\/www\/server\/panel\/)/.test(line));
  const namedTunnelRunning = lines.some((line) => /btblog-named-tunnel/.test(line));
  const quickTunnelRunning = lines.some((line) => /baota-panel-tunnel/.test(line));

  const panelUrl = readTextFile(options.urlFile);
  const fsModule = options.fs || fs;
  const installed = isBaotaPanelPresent(fsModule);
  const needsReinstall =
    !installed &&
    Boolean(options.installedMarker && fsModule.existsSync(options.installedMarker));

  const panelUrlLine = panelUrl.split("\n").find((line) => line.startsWith("http")) || "";
  const namedUrl = Boolean(panelUrlLine && !/trycloudflare\.com/i.test(panelUrlLine));
  const tunnelRunning = namedUrl ? namedTunnelRunning : quickTunnelRunning;

  return {
    installed,
    needsReinstall,
    panelRunning,
    tunnelRunning,
    ready: installed && panelRunning && tunnelRunning && Boolean(panelUrlLine),
    panelUrl: panelUrlLine,
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
    this.defaultFile = options.defaultFile;
    this.installLog = options.installLog;
    this.tunnelLog = options.tunnelLog;
    this.installedMarker = options.installedMarker;
    this.startPromise = null;
    this.operatorStopped = false;
    clearStaleBaotaMarker(this.installedMarker, this.logger);
  }

  async status() {
    const { stdout } = await runScript(this.execAsync, "process-status-baota.sh", {
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

  async stop() {
    this.operatorStopped = true;
    await runScript(this.execAsync, "stop-baota-panel.sh", {
      cwd: this.cwd,
      timeout: 30_000,
    });
    return { message: "宝塔面板已停止" };
  }

  async restart(reason = "manual") {
    this.operatorStopped = false;
    if (this.startPromise) {
      await this.startPromise.catch(() => {});
    }
    this.logger.log(`restarting baota: ${reason}`);
    await runScript(this.execAsync, "restart-baota.sh", {
      cwd: this.cwd,
      background: true,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      env: { REASON: reason },
    });
    return {
      message: "宝塔重启/刷新任务已在后台执行",
      status: await this.status(),
    };
  }

  async ensureRunning(reason = "keepalive") {
    const status = await this.status();
    if (this.operatorStopped) {
      return { started: false, suppressed: true, status };
    }
    const healthy =
      status.installed &&
      status.panelRunning &&
      status.tunnelRunning &&
      Boolean(status.panelUrl);
    if (healthy) {
      return { started: false, status };
    }
    const result = await this.start(reason);
    return { started: true, status, result };
  }

  appendInstallLog(message) {
    if (!this.installLog) {
      return;
    }
    try {
      fs.appendFileSync(
        this.installLog,
        `\n[${new Date().toISOString()}] ${message}\n`,
        "utf8"
      );
    } catch (error) {
      this.logger.error(`写入宝塔日志失败: ${error.message}`);
    }
  }

  async _start(reason) {
    this.logger.log(`starting baota install/tunnel: ${reason}`);
    const scriptPath =
      typeof this.script === "function" ? this.script() : this.script;
    const resolvedScript = path.isAbsolute(scriptPath)
      ? scriptPath
      : resolveScript(path.basename(scriptPath), { cwd: this.cwd });

    this.appendInstallLog(`starting baota install/tunnel: ${reason}`);
    await runScript(this.execAsync, path.basename(resolvedScript), {
      cwd: this.cwd,
      scriptPath: resolvedScript,
      background: true,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });

    return {
      message: "宝塔安装/隧道任务已在后台启动",
      status: await this.status(),
    };
  }

  async getLogs() {
    const panelUrlRaw = readTextFile(this.urlFile);
    const defaultInfo = readTextFile(this.defaultFile);
    const credentials = formatBaotaCredentials(defaultInfo);
    const panelPort = await readPanelPort(this.execAsync, this.cwd);
    return {
      installLog: readTextFile(this.installLog) || `${INSTALL_LOG}不存在`,
      tunnelLog: readTextFile(this.tunnelLog) || `${TUNNEL_LOG}不存在`,
      panelUrl: panelUrlRaw || `${URL_FILE}不存在`,
      defaultInfo: defaultInfo || `${DEFAULT_FILE}不存在`,
      credentials: credentials || "",
      loginInfo: credentials || defaultInfo || panelUrlRaw || "暂无登录信息",
      panelPort,
    };
  }
}

module.exports = {
  BaotaManager,
  parseBaotaStatus,
  isBaotaPanelPresent,
  clearStaleBaotaMarker,
  formatBaotaCredentials,
  readPanelPort,
  shellQuote,
  BAOTA_PANEL_BIN,
  URL_FILE,
  DEFAULT_FILE,
  INSTALL_LOG,
  TUNNEL_LOG,
};
