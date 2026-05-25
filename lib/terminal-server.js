const { spawn } = require("node:child_process");

const TERMINAL_WS_PATH = "/admin/terminal/ws";
const DEFAULT_MAX_SESSIONS = 5;

function createTerminalServer(options = {}) {
  const {
    server,
    getSession,
    cwd,
    logger = console,
    maxSessions = DEFAULT_MAX_SESSIONS,
    shellPath = process.env.TERMINAL_SHELL || "bash",
    shellArgs = ["-l"],
  } = options;

  if (!server || typeof getSession !== "function" || !cwd) {
    throw new Error("createTerminalServer requires server, getSession, and cwd");
  }

  let WebSocketServer;
  try {
    ({ WebSocketServer } = require("ws"));
  } catch (error) {
    throw new Error(`ws 模块未安装: ${error.message}`);
  }

  const wss = new WebSocketServer({ noServer: true });
  let activeSessions = 0;

  function rejectUpgrade(socket, statusCode, statusText) {
    socket.write(`HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }

  server.on("upgrade", (req, socket, head) => {
    let pathname = "";
    try {
      pathname = new URL(req.url || "/", "http://localhost").pathname;
    } catch {
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }

    if (pathname !== TERMINAL_WS_PATH) {
      return;
    }

    if (!getSession(req)) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }

    if (activeSessions >= maxSessions) {
      rejectUpgrade(socket, 503, "Service Unavailable");
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    activeSessions += 1;
    let closed = false;

    const shell = spawn(shellPath, shellArgs, {
      cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        LANG: process.env.LANG || "C.UTF-8",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const cleanup = () => {
      if (closed) {
        return;
      }
      closed = true;
      activeSessions = Math.max(0, activeSessions - 1);
      try {
        shell.kill("SIGTERM");
      } catch {
        // ignore
      }
    };

    shell.stdout.on("data", (chunk) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(chunk);
      }
    });

    shell.stderr.on("data", (chunk) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(chunk);
      }
    });

    shell.on("error", (error) => {
      logger.error?.(`terminal shell error: ${error.message}`);
      if (ws.readyState === ws.OPEN) {
        ws.send(`\r\n[terminal] shell error: ${error.message}\r\n`);
        ws.close(1011, "shell-error");
      }
      cleanup();
    });

    shell.on("exit", () => {
      if (ws.readyState === ws.OPEN) {
        ws.close(1000, "shell-exit");
      }
      cleanup();
    });

    ws.on("message", (data) => {
      if (shell.stdin.writable) {
        shell.stdin.write(data);
      }
    });

    ws.on("close", cleanup);
    ws.on("error", (error) => {
      logger.error?.(`terminal websocket error: ${error.message}`);
      cleanup();
    });
  });

  return wss;
}

module.exports = {
  TERMINAL_WS_PATH,
  DEFAULT_MAX_SESSIONS,
  createTerminalServer,
};
