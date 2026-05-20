const express = require("express");
const app = express();
const path = require("node:path");
const exec = require("node:child_process").exec;
const { execSync } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs");
const { ServiceManager, buildReadyResponse } = require("./lib/service-manager");
const { BaotaManager } = require("./lib/baota-manager");
const { resolveRuntimeDir } = require("./lib/runtime");

const execAsync = promisify(exec);
const runtimeDir = resolveRuntimeDir(process.env, __dirname);
fs.mkdirSync(runtimeDir, { recursive: true });

const serviceManager = new ServiceManager({
  execAsync,
  logger: console,
  cwd: runtimeDir,
  logFile: runtimePath('suoha-start.log'),
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

function runtimePath(fileName) {
  return path.join(runtimeDir, fileName);
}

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

// 使用express.json中间件解析JSON请求体
app.use(express.json());

// 增加路由以提供HTML页面
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

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
    const ready = buildReadyResponse(await serviceManager.status(), process.uptime());
    res.status(ready.statusCode).json(ready.body);
  } catch (error) {
    res.status(503).json({
      ok: false,
      uptime: process.uptime(),
      error: error.message,
    });
  }
});

// 获取suoha服务状态
app.get('/suoha-status', async (req, res) => {
  try {
    res.json(await serviceManager.status());
  } catch (error) {
    console.error("服务状态检查失败:", error.message);
    res.status(500).json({ error: "服务状态检查失败", message: error.message });
  }
});

// 获取服务器信息
app.get('/server-info', (req, res) => {
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

// 获取v2ray链接信息
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
app.get('/baota-info', async (req, res) => {
  try {
    const status = await baotaManager.status();
    const logs = baotaManager.getLogs();
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

app.post('/start-baota', async (req, res) => {
  try {
    const alreadyStarting = baotaManager.isStarting();
    baotaManager.start("manual").catch((error) => {
      console.error("后台启动宝塔任务失败:", error.message);
    });
    res.json({
      message: alreadyStarting ? "宝塔任务正在执行中" : "宝塔安装/隧道任务已提交",
      starting: true,
    });
  } catch (error) {
    res.status(500).json({
      message: "提交宝塔任务失败",
      error: error.message,
    });
  }
});

// 获取v2ray链接信息
app.get('/v2ray-info', (req, res) => {
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
app.post('/start-suoha', async (req, res) => {
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
app.post('/restart-suoha', async (req, res) => {
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
app.post('/stop-suoha', async (req, res) => {
  console.log("开始停止suoha服务...");
  try {
    res.json(await serviceManager.stop());
  } catch (error) {
    console.error("停止服务失败:", error.message);
    res.status(500).json({ message: "停止服务失败", error: error.message });
  }
});

// 获取日志
app.get('/logs', (req, res) => {
  try {
    // 检查系统和进程信息
    const sysInfo = runCommand("uname -a 2>&1; df -h 2>&1; ls -la 2>&1");
    const processInfo = runCommand("ps -ef 2>&1 | grep -E 'xray|cloudflared|suoha' || true");
    const fileCheck = runCommand(`ls -la ${shellQuote(runtimeDir)} ${shellQuote(runtimePath('suoha.sh'))} ${shellQuote(runtimePath('v2ray.txt'))} ${shellQuote(runtimePath('xray'))} ${shellQuote(runtimePath('cloudflared-linux'))} 2>&1 || true`);
    
    res.json({
      ok: true,
      systemInfo: sysInfo,
      processes: processInfo,
      fileStatus: fileCheck,
      runtimeDir,
      startLog: readLogFile('suoha-start.log'),
      suohaLog: readLogFile('suoha.log'),
      xrayLog: readLogFile('xray.log'),
      argoLog: readLogFile('argo.log'),
      baotaInstallLog: readLogFile('baota-install.log'),
      baotaTunnelLog: readLogFile('baota-argo.log'),
      baotaPanelUrl: readLogFile('baota-panel-url.txt'),
      baotaDefault: readLogFile('baota-default.txt'),
    });
  } catch (error) {
    res.status(500).json({ error: "获取日志信息失败", message: error.message });
  }
});

// 哪吒相关控制（保留原有代码，但默认不启用）
app.post('/start-nezha', (req, res) => {
  exec("bash nezha.sh", (err, stdout, stderr) => {
    if (err) {
      res.status(500).send({ message: "启动哪吒客户端失败", error: err });
    } else {
      res.send({ message: "哪吒客户端启动成功" });
    }
  });
});

app.post('/restart-nezha', (req, res) => {
  exec("pkill -9 nezha-agent && bash nezha.sh", (err, stdout, stderr) => {
    if (err) {
      res.status(500).send({ message: "重启哪吒客户端失败", error: err });
    } else {
      res.send({ message: "哪吒客户端重启成功" });
    }
  });
});

app.post('/stop-nezha', (req, res) => {
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
});
