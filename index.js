const express = require("express");
const app = express();
const path = require("node:path");
const exec = require("node:child_process").exec;
const { execSync } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs");
const { ServiceManager, buildReadyResponse } = require("./lib/service-manager");
const { BaotaManager } = require("./lib/baota-manager");
const { PortTunnelManager } = require("./lib/port-tunnel-manager");
const { CloudflareTunnelManager } = require("./lib/cloudflare-tunnel-manager");
const { resolveRuntimeDir } = require("./lib/runtime");
const { createAuth } = require("./lib/auth");

const execAsync = promisify(exec);
const runtimeDir = resolveRuntimeDir(process.env, __dirname);
const auth = createAuth();
fs.mkdirSync(runtimeDir, { recursive: true });

function runtimePath(fileName) {
  return path.join(runtimeDir, fileName);
}

const cloudflareTunnelManager = new CloudflareTunnelManager({
  execAsync,
  logger: console,
  cwd: runtimeDir,
  env: process.env,
  cloudflaredPath: path.join(runtimeDir, "cloudflared-linux"),
  stateFile: path.join(runtimeDir, "port-tunnels.json"),
  settingsFile: path.join(runtimeDir, "named-tunnel-settings.json"),
});

const serviceManager = new ServiceManager({
  execAsync,
  logger: console,
  cwd: runtimeDir,
  logFile: runtimePath('suoha-start.log'),
  namedTunnelEnabled: cloudflareTunnelManager.isEnabled(),
  script: () => {
    const generatedScript = runtimePath('suoha.sh');
    return fs.existsSync(generatedScript) ? generatedScript : path.join(__dirname, 'suoha.sh');
  },
});

const baotaManager = new BaotaManager({
  execAsync,
  logger: console,
  cwd: runtimeDir,
  urlFile: runtimePath('baota-panel-url.txt'),
  defaultFile: runtimePath('baota-default.txt'),
  installLog: runtimePath('baota-install.log'),
  tunnelLog: runtimePath('baota-argo.log'),
  installedMarker: runtimePath('.baota-installed'),
  script: () => {
    const generatedScript = runtimePath('install-baota.sh');
    return fs.existsSync(generatedScript)
      ? generatedScript
      : path.join(__dirname, 'install-baota.sh');
  },
});

const portTunnelManager = new PortTunnelManager({
  execAsync,
  logger: console,
  cwd: runtimeDir,
  cloudflaredPath: runtimePath("cloudflared-linux"),
  stateFile: runtimePath("port-tunnels.json"),
  maxTunnels: Number(process.env.MAX_PORT_TUNNELS || 8),
  tunnelManager: cloudflareTunnelManager,
});

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function runCommand(command) {
  try {
    return execSync(command, { timeout: 10000, maxBuffer: 1024 * 1024 }).toString();
  } catch (error) {
    const output = error.stdout ? error.stdout.toString() : "";
    const stderr = error.stderr ? error.stderr.toString() : "";
    return [
      output.trim(),
      stderr.trim(),
      `命令执行失败: ${error.message}`,
    ].filter(Boolean).join("\n");
  }
}

function readLogFile(fileName) {
  const filePath = runtimePath(fileName);
  if (!fs.existsSync(filePath)) {
    return `${fileName}不存在`;
  }

  try {
    return fs.readFileSync(filePath, 'utf8') || `${fileName}为空`;
  } catch (error) {
    return `读取${fileName}失败: ${error.message}`;
  }
}

async function buildServiceStatus() {
  const status = await serviceManager.status();
  const tunnel = await cloudflareTunnelManager.status();
  const namedTunnelEnabled = cloudflareTunnelManager.isEnabled();

  if (!namedTunnelEnabled) {
    return {
      ...status,
      namedTunnelEnabled: false,
    };
  }

  const argoRunning = tunnel.running;
  return {
    ...status,
    namedTunnelEnabled: true,
    namedTunnel: tunnel,
    argoRunning,
    bothRunning: status.xrayRunning && argoRunning,
  };
}

async function buildTunnelLogs() {
  const namedTunnelEnabled = cloudflareTunnelManager.isEnabled();
  if (!namedTunnelEnabled) {
    return {
      namedTunnelEnabled: false,
      tunnelLog: readLogFile("baota-argo.log"),
    };
  }

  const tunnel = await cloudflareTunnelManager.status();
  return {
    namedTunnelEnabled: true,
    tunnel,
    tunnelLog: cloudflareTunnelManager.buildLogSummary(tunnel),
  };
}

// 使用express.json中间件解析JSON请求体
app.use(express.json());

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "welcome.html"));
});

app.get("/admin", auth.redirectIfAuthenticated, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin-login.html"));
});

app.get("/admin/panel", auth.requirePageAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, "views", "panel.html"));
});

app.post("/admin/login", (req, res) => auth.handleLogin(req, res));
app.post("/admin/logout", (req, res) => auth.handleLogout(req, res));
app.get("/admin/session", (req, res) => auth.handleSession(req, res));

// 静态资源（不含控制面板 HTML）
app.use(express.static("public", { index: false }));

// Azure App Service health check / Always On probe target.
app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    runtimeDir,
  });
});

app.get('/readyz', async (req, res) => {
  try {
    const status = await buildServiceStatus();
    const ready = buildReadyResponse(status, process.uptime());
    res.status(ready.statusCode).json(ready.body);
  } catch (error) {
    res.status(503).json({
      ok: false,
      uptime: process.uptime(),
      error: error.message,
    });
  }
});

app.get("/tunnel-status", auth.requireAuth, async (req, res) => {
  try {
    res.json({
      ...(await cloudflareTunnelManager.status()),
      config: cloudflareTunnelManager.configStatus(),
    });
  } catch (error) {
    res.status(500).json({
      error: "获取固定隧道状态失败",
      message: error.message,
    });
  }
});

app.get("/tunnel-config", auth.requireAuth, async (req, res) => {
  try {
    res.json(cloudflareTunnelManager.configStatus());
  } catch (error) {
    res.status(500).json({
      error: "获取固定隧道配置失败",
      message: error.message,
    });
  }
});

app.post("/tunnel-config", auth.requireAuth, async (req, res) => {
  try {
    const result = await cloudflareTunnelManager.saveConfig(req.body || {});
    res.json({ ok: true, message: "固定隧道配置已保存", ...result });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error.message,
      logTail: cloudflareTunnelManager.readLogTail(),
    });
  }
});

app.post("/tunnel-sync", auth.requireAuth, async (req, res) => {
  try {
    const result = await cloudflareTunnelManager.sync("manual");
    res.json({ ok: true, message: "固定隧道已启动", ...result });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error.message,
      logTail: cloudflareTunnelManager.readLogTail(),
    });
  }
});

// 获取suoha服务状态
app.get('/suoha-status', auth.requireAuth, async (req, res) => {
  try {
    res.json(await buildServiceStatus());
  } catch (error) {
    console.error("服务状态检查失败:", error.message);
    res.status(500).json({ error: "服务状态检查失败", message: error.message });
  }
});

// 获取服务器信息
app.get('/server-info', auth.requireAuth, (req, res) => {
  exec("cat /etc/os-release 2>&1; uname -a 2>&1; curl -s --max-time 8 https://speed.cloudflare.com/meta 2>&1", (err, stdout, stderr) => {
    const parts = [];
    if (stdout) parts.push(stdout.trim());
    if (stderr) parts.push(stderr.trim());
    if (err) parts.push(`命令执行失败: ${err.message}`);

    res.json({
      ok: !err,
      info: parts.filter(Boolean).join("\n\n") || "暂无服务器信息",
    });
  });
});

// 订阅链接（公开，供客户端直接拉取）
app.get('/xxxooo', (req, res) => {
  const v2rayPath = runtimePath('v2ray.txt');
  if (fs.existsSync(v2rayPath)) {
    fs.readFile(v2rayPath, 'utf8', (err, data) => {
      if (err) {
        res.status(500).send("读取v2ray.txt失败");
      } else {
        res.send(data);
      }
    });
  } else {
    res.send("未找到v2ray.txt，请先启动服务");
  }
});

// 宝塔面板状态与外网隧道地址
app.get('/baota-info', auth.requireAuth, async (req, res) => {
  try {
    const status = await baotaManager.status();
    const logs = baotaManager.getLogs();
    const tunnelLogs = await buildTunnelLogs();

    if (tunnelLogs.namedTunnelEnabled) {
      logs.tunnelLog = tunnelLogs.tunnelLog;
      status.tunnelRunning = Boolean(tunnelLogs.tunnel?.running);
      status.namedTunnelEnabled = true;
      status.namedTunnel = tunnelLogs.tunnel;
      status.ready =
        status.installed &&
        status.panelRunning &&
        status.tunnelRunning &&
        Boolean(status.panelUrl);
    } else {
      status.namedTunnelEnabled = false;
    }

    res.json({
      ...status,
      logs,
    });
  } catch (error) {
    res.status(500).json({
      error: "获取宝塔信息失败",
      message: error.message,
    });
  }
});

app.post('/start-baota', auth.requireAuth, async (req, res) => {
  try {
    const alreadyStarting = baotaManager.isStarting();
    baotaManager.start("manual").catch((error) => {
      console.error("后台启动宝塔任务失败:", error.message);
    });
    res.json({
      message: alreadyStarting ? "宝塔任务正在执行中" : "宝塔面板/隧道任务已在后台启动，请查看安装日志",
      starting: true,
    });
  } catch (error) {
    res.status(500).json({
      message: "提交宝塔任务失败",
      error: error.message,
    });
  }
});

// 端口临时隧道绑定
app.get("/port-tunnels", auth.requireAuth, async (req, res) => {
  try {
    res.json(await portTunnelManager.list());
  } catch (error) {
    res.status(500).json({
      error: "获取端口隧道列表失败",
      message: error.message,
    });
  }
});

app.post("/port-tunnels/bind", auth.requireAuth, async (req, res) => {
  try {
    const result = await portTunnelManager.bind(req.body?.port, {
      protocol: req.body?.protocol,
    });
    res.json({
      ok: true,
      ...result,
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      message: error.message,
    });
  }
});

app.post("/port-tunnels/unbind", auth.requireAuth, async (req, res) => {
  try {
    const result = await portTunnelManager.unbind(req.body?.port);
    res.json({
      ok: true,
      ...result,
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      message: error.message,
    });
  }
});

// 获取v2ray链接信息
app.get('/v2ray-info', auth.requireAuth, (req, res) => {
  const v2rayPath = runtimePath('v2ray.txt');
  if (fs.existsSync(v2rayPath)) {
    fs.readFile(v2rayPath, 'utf8', (err, data) => {
      if (err) {
        res.status(500).json({ error: "读取v2ray.txt失败" });
      } else {
        res.json({ content: data });
      }
    });
  } else {
    res.json({ content: "未找到v2ray.txt，请先启动服务" });
  }
});

// 启动suoha服务
app.post('/start-suoha', auth.requireAuth, async (req, res) => {
  console.log("开始启动suoha服务...");
  try {
    const alreadyStarting = serviceManager.isStarting();
    serviceManager.start("manual").catch((error) => {
      console.error("后台启动服务失败:", error.message);
    });
    res.json({ 
      message: alreadyStarting ? "服务正在启动中" : "启动任务已提交",
      starting: true,
    });
  } catch (error) {
    console.error("启动服务失败:", error.message);
    res.status(500).json({ 
      message: "启动服务失败", 
      error: error.message,
      details: error.stdout ? error.stdout.toString() : "无详细输出"
    });
  }
});

// 重启suoha服务
app.post('/restart-suoha', auth.requireAuth, async (req, res) => {
  console.log("开始重启suoha服务...");
  try {
    serviceManager.restart("manual").catch((error) => {
      console.error("后台重启服务失败:", error.message);
    });
    res.json({ 
      message: "重启任务已提交",
      starting: true,
    });
  } catch (error) {
    console.error("重启服务失败:", error.message);
    res.status(500).json({ 
      message: "重启服务失败", 
      error: error.message,
      details: error.stdout ? error.stdout.toString() : "无详细输出"
    });
  }
});

// 停止suoha服务
app.post('/stop-suoha', auth.requireAuth, async (req, res) => {
  console.log("开始停止suoha服务...");
  try {
    res.json(await serviceManager.stop());
  } catch (error) {
    console.error("停止服务失败:", error.message);
    res.status(500).json({ message: "停止服务失败", error: error.message });
  }
});

// 获取日志
app.get('/logs', auth.requireAuth, async (req, res) => {
  try {
    const sysInfo = runCommand("uname -a 2>&1; df -h 2>&1; ls -la 2>&1");
    const processInfo = runCommand("ps -ef 2>&1 | grep -E 'xray|cloudflared|suoha|btblog-named-tunnel' || true");
    const fileCheck = runCommand(`ls -la ${shellQuote(runtimeDir)} ${shellQuote(runtimePath('suoha.sh'))} ${shellQuote(runtimePath('v2ray.txt'))} ${shellQuote(runtimePath('xray'))} ${shellQuote(runtimePath('cloudflared-linux'))} ${shellQuote(runtimePath('named-tunnel.log'))} 2>&1 || true`);
    const tunnelLogs = await buildTunnelLogs();

    res.json({
      ok: true,
      systemInfo: sysInfo,
      processes: processInfo,
      fileStatus: fileCheck,
      runtimeDir,
      namedTunnelEnabled: tunnelLogs.namedTunnelEnabled,
      startLog: readLogFile('suoha-start.log'),
      suohaLog: readLogFile('suoha.log'),
      xrayLog: readLogFile('xray.log'),
      argoLog: tunnelLogs.namedTunnelEnabled
        ? "已启用固定隧道，请查看 tunnelLog / named-tunnel.log"
        : readLogFile('argo.log'),
      baotaInstallLog: readLogFile('baota-install.log'),
      baotaTunnelLog: tunnelLogs.tunnelLog,
      namedTunnelLog: tunnelLogs.tunnelLog,
      tunnelLog: tunnelLogs.tunnelLog,
      baotaPanelUrl: readLogFile('baota-panel-url.txt'),
      baotaDefault: readLogFile('baota-default.txt'),
    });
  } catch (error) {
    res.status(500).json({ error: "获取日志信息失败", message: error.message });
  }
});

// 哪吒相关控制（保留原有代码，但默认不启用）
app.post('/start-nezha', auth.requireAuth, (req, res) => {
  exec("bash nezha.sh", (err, stdout, stderr) => {
    if (err) {
      res.status(500).send({ message: "启动哪吒客户端失败", error: err });
    } else {
      res.send({ message: "哪吒客户端启动成功" });
    }
  });
});

app.post('/restart-nezha', auth.requireAuth, (req, res) => {
  exec("pkill -9 nezha-agent && bash nezha.sh", (err, stdout, stderr) => {
    if (err) {
      res.status(500).send({ message: "重启哪吒客户端失败", error: err });
    } else {
      res.send({ message: "哪吒客户端重启成功" });
    }
  });
});

app.post('/stop-nezha', auth.requireAuth, (req, res) => {
  exec("pkill -9 nezha-agent", (err, stdout, stderr) => {
    if (err) {
      res.status(500).send({ message: "停止哪吒客户端失败", error: err });
    } else {
      res.send({ message: "哪吒客户端停止成功" });
    }
  });
});

// suoha服务保活
function keep_suoha_alive() {
  serviceManager.ensureRunning("keepalive")
    .then((result) => {
      console.log(result.started ? "梭哈服务已由保活启动" : "梭哈服务正在运行");
    })
    .catch((error) => {
      console.error("梭哈服务保活检查失败:", error.message);
    });
}

// 设置保活检查的间隔时间，单位为毫秒
setInterval(keep_suoha_alive, 45 * 1000);

function keep_baota_alive() {
  baotaManager.ensureRunning("keepalive").then((result) => {
    if (result.started) {
      console.log("宝塔安装/隧道已由保活触发");
    }
  }).catch((error) => {
    console.error("宝塔保活检查失败:", error.message);
  });
}

setInterval(keep_baota_alive, 3 * 60 * 1000);
keep_baota_alive();

console.log("固定隧道不会自动启动，请在管理面板保存配置后手动启动");

// 启动entrypoint.sh脚本
exec(`bash ${shellQuote(path.join(__dirname, 'entrypoint.sh'))}`, {
  cwd: runtimeDir,
  timeout: 120000,
  maxBuffer: 4 * 1024 * 1024,
}, function (err, stdout, stderr) {
  if (err) {
    console.error("Error executing entrypoint.sh: ", err);
  } else {
    console.log("entrypoint.sh executed successfully: ", stdout);
  }
});

// 启动express服务器
const port = process.env.PORT || 443;
app.listen(port, () => {
  console.log(`Server listening on port ${port}!`);
  if (!auth.isConfigured()) {
    console.warn("ADMIN_PASSWORD 未配置：管理面板与受保护 API 不可用，请在应用服务环境变量中设置。");
  }
});
