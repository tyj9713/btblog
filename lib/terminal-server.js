const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const TERMINAL_WS_PATH = "/admin/terminal/ws";
const DEFAULT_MAX_SESSIONS = 5;
const DEFAULT_TICKET_TTL_MS = 300_000;
const KEEPALIVE_MS = 15_000;

function loadPtyModule() {
  try {
    return require("node-pty");
  } catch {
    return null;
  }
}

function createTicketStore(ttlMs = DEFAULT_TICKET_TTL_MS) {
  const tickets = new Map();

  return {
    issue(session) {
      const ticket = crypto.randomBytes(24).toString("hex");
      tickets.set(ticket, { session, exp: Date.now() + ttlMs });
      return ticket;
    },
    consume(ticket) {
      if (!ticket) {
        return null;
      }
      const item = tickets.get(ticket);
      tickets.delete(ticket);
      if (!item || item.exp < Date.now()) {
        return null;
      }
      return item.session;
    },
  };
}

function parseInitialSize(req) {
  let cols = 80;
  let rows = 24;
  try {
    const url = new URL(req.url || "/", "http://localhost");
    const parsedCols = Number.parseInt(url.searchParams.get("cols") || "", 10);
    const parsedRows = Number.parseInt(url.searchParams.get("rows") || "", 10);
    if (Number.isInteger(parsedCols) && parsedCols >= 20 && parsedCols <= 400) {
      cols = parsedCols;
    }
    if (Number.isInteger(parsedRows) && parsedRows >= 5 && parsedRows <= 200) {
      rows = parsedRows;
    }
  } catch {
    // ignore
  }
  return { cols, rows };
}

function spawnInteractiveShell(options) {
  const {
    cwd,
    cols,
    rows,
    shellPath = process.env.TERMINAL_SHELL || "bash",
    logger = console,
  } = options;

  const env = {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    LANG: process.env.LANG || "C.UTF-8",
  };
  const shellArgs = ["-i"];
  const pty = loadPtyModule();

  if (pty) {
    return {
      kind: "pty",
      process: pty.spawn(shellPath, shellArgs, {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env,
      }),
    };
  }

  if (process.platform !== "win32") {
    try {
      return {
        kind: "pipe",
        process: spawn("script", ["-q", "-c", `${shellPath} -i`, "/dev/null"], {
          cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        }),
      };
    } catch (error) {
      logger.warn?.(`terminal script fallback failed: ${error.message}`);
    }
  }

  return {
    kind: "pipe",
    process: spawn(shellPath, shellArgs, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    }),
  };
}

function bindShellToSocket(ws, shellBundle, logger = console) {
  const { kind, process: shell } = shellBundle;
  let closed = false;

  const writeToShell = (data) => {
    if (kind === "pty") {
      shell.write(data);
      return;
    }
    if (shell.stdin?.writable) {
      shell.stdin.write(data);
    }
  };

  const cleanup = () => {
    if (closed) {
      return;
    }
    closed = true;
    try {
      if (kind === "pty") {
        shell.kill();
      } else {
        shell.kill("SIGTERM");
      }
    } catch {
      // ignore
    }
  };

  const forwardOutput = (chunk) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(chunk);
    }
  };

  if (kind === "pty") {
    shell.onData(forwardOutput);
    shell.onExit(({ exitCode, signal }) => {
      logger.log?.(`terminal pty exit code=${exitCode ?? "null"} signal=${signal ?? "null"}`);
      if (ws.readyState === ws.OPEN) {
        ws.close(1000, "shell-exit");
      }
      cleanup();
    });
  } else {
    shell.stdout.on("data", forwardOutput);
    shell.stderr.on("data", forwardOutput);
    shell.on("error", (error) => {
      logger.error?.(`terminal shell error: ${error.message}`);
      if (ws.readyState === ws.OPEN) {
        ws.send(`\r\n[terminal] shell error: ${error.message}\r\n`);
        ws.close(1011, "shell-error");
      }
      cleanup();
    });
    shell.on("exit", (code, signal) => {
      logger.log?.(`terminal shell exit code=${code ?? "null"} signal=${signal ?? "null"}`);
      if (ws.readyState === ws.OPEN) {
        ws.close(1000, "shell-exit");
      }
      cleanup();
    });
  }

  ws.on("message", (data) => {
    const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
    if (text.startsWith("{")) {
      try {
        const message = JSON.parse(text);
        if (message.type === "resize" && kind === "pty" && typeof shell.resize === "function") {
          const cols = Number.parseInt(message.cols, 10);
          const rows = Number.parseInt(message.rows, 10);
          if (
            Number.isInteger(cols) &&
            Number.isInteger(rows) &&
            cols >= 20 &&
            rows >= 5
          ) {
            shell.resize(cols, rows);
          }
        }
      } catch {
        writeToShell(data);
      }
      return;
    }
    writeToShell(data);
  });

  const pingTimer = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.ping();
      return;
    }
    clearInterval(pingTimer);
  }, KEEPALIVE_MS);

  ws.on("close", () => {
    clearInterval(pingTimer);
    cleanup();
  });
  ws.on("error", (error) => {
    clearInterval(pingTimer);
    logger.error?.(`terminal websocket error: ${error.message}`);
    cleanup();
  });
}

function createTerminalServer(options = {}) {
  const {
    server,
    getSession,
    cwd,
    logger = console,
    maxSessions = DEFAULT_MAX_SESSIONS,
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

  const ticketStore = createTicketStore(options.ticketTtlMs || DEFAULT_TICKET_TTL_MS);
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  let activeSessions = 0;

  function rejectUpgrade(socket, statusCode, statusText) {
    socket.write(`HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }

  function authorizeUpgrade(req) {
    const session = getSession(req);
    if (session) {
      return session;
    }
    try {
      const url = new URL(req.url || "/", "http://localhost");
      return ticketStore.consume(url.searchParams.get("ticket"));
    } catch {
      return null;
    }
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

    if (!authorizeUpgrade(req)) {
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

  wss.on("connection", (ws, req) => {
    activeSessions += 1;
    const { cols, rows } = parseInitialSize(req);
    const shellBundle = spawnInteractiveShell({ cwd, cols, rows, logger });

    ws.on("close", () => {
      activeSessions = Math.max(0, activeSessions - 1);
    });

    bindShellToSocket(ws, shellBundle, logger);
    logger.log?.(`terminal session started (${shellBundle.kind}, ${cols}x${rows})`);
  });

  return {
    wss,
    issueTicket(session) {
      if (!session) {
        throw new Error("terminal ticket requires authenticated session");
      }
      return ticketStore.issue(session);
    },
  };
}

module.exports = {
  TERMINAL_WS_PATH,
  DEFAULT_MAX_SESSIONS,
  createTerminalServer,
  spawnInteractiveShell,
  isPtyAvailable: () => loadPtyModule() !== null,
};
