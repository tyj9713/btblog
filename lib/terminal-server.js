const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const TERMINAL_WS_PATH = "/admin/terminal/ws";
const DEFAULT_MAX_SESSIONS = 5;
const DEFAULT_TICKET_TTL_MS = 300_000;
const DEFAULT_SESSION_GRACE_MS = 120_000;
const KEEPALIVE_MS = 20_000;

function tryParseControlMessage(text) {
  if (!text.startsWith("{")) {
    return null;
  }
  try {
    const message = JSON.parse(text);
    if (message && typeof message.type === "string") {
      return message;
    }
  } catch {
    // ignore invalid JSON control payloads
  }
  return null;
}

function handleHeartbeatMessage(message, ws) {
  if (message.type === "ping") {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "pong" }));
    }
    return true;
  }
  if (message.type === "pong") {
    return true;
  }
  return false;
}

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
    issue(session, terminalSessionId = null) {
      const ticket = crypto.randomBytes(24).toString("hex");
      tickets.set(ticket, { session, terminalSessionId, exp: Date.now() + ttlMs });
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
      return {
        session: item.session,
        terminalSessionId: item.terminalSessionId,
      };
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

function createTerminalSession(shellBundle, logger = console, onExit = () => {}) {
  const { kind, process: shell } = shellBundle;
  const id = crypto.randomUUID();
  const sockets = new Set();
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
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) {
        socket.send(chunk);
      }
    }
  };

  const closeSockets = (code, reason) => {
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) {
        socket.close(code, reason);
      }
    }
  };

  if (kind === "pty") {
    shell.onData(forwardOutput);
    shell.onExit(({ exitCode, signal }) => {
      logger.log?.(`terminal pty exit code=${exitCode ?? "null"} signal=${signal ?? "null"}`);
      closeSockets(1000, "shell-exit");
      cleanup();
      onExit(id);
    });
  } else {
    shell.stdout.on("data", forwardOutput);
    shell.stderr.on("data", forwardOutput);
    shell.on("error", (error) => {
      logger.error?.(`terminal shell error: ${error.message}`);
      for (const socket of sockets) {
        if (socket.readyState === socket.OPEN) {
          socket.send(`\r\n[terminal] shell error: ${error.message}\r\n`);
          socket.close(1011, "shell-error");
        }
      }
      cleanup();
      onExit(id);
    });
    shell.on("exit", (code, signal) => {
      logger.log?.(`terminal shell exit code=${code ?? "null"} signal=${signal ?? "null"}`);
      closeSockets(1000, "shell-exit");
      cleanup();
      onExit(id);
    });
  }

  return {
    id,
    kind,
    get socketCount() {
      return sockets.size;
    },
    cleanup,
    attach(ws, onDetach = () => {}) {
      sockets.add(ws);
      ws.on("message", (data) => {
        const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
        const control = tryParseControlMessage(text);
        if (control) {
          if (handleHeartbeatMessage(control, ws)) {
            return;
          }
          if (control.type === "resize" && kind === "pty" && typeof shell.resize === "function") {
            const cols = Number.parseInt(control.cols, 10);
            const rows = Number.parseInt(control.rows, 10);
            if (
              Number.isInteger(cols) &&
              Number.isInteger(rows) &&
              cols >= 20 &&
              rows >= 5
            ) {
              shell.resize(cols, rows);
            }
            return;
          }
        }
        writeToShell(data);
      });

      const heartbeatTimer = setInterval(() => {
        if (ws.readyState !== ws.OPEN) {
          clearInterval(heartbeatTimer);
          return;
        }
        try {
          ws.ping();
          ws.send(JSON.stringify({ type: "ping" }));
        } catch {
          clearInterval(heartbeatTimer);
        }
      }, KEEPALIVE_MS);

      ws.on("close", () => {
        clearInterval(heartbeatTimer);
        sockets.delete(ws);
        onDetach();
      });
      ws.on("error", (error) => {
        clearInterval(heartbeatTimer);
        sockets.delete(ws);
        logger.error?.(`terminal websocket error: ${error.message}`);
        onDetach();
      });
    },
  };
}

function bindShellToSocket(ws, shellBundle, logger = console) {
  const terminalSession = createTerminalSession(shellBundle, logger);
  terminalSession.attach(ws, () => {
    if (terminalSession.socketCount === 0) {
      terminalSession.cleanup();
    }
  });
}

function createTerminalServer(options = {}) {
  const {
    server,
    getSession,
    cwd,
    logger = console,
    maxSessions = DEFAULT_MAX_SESSIONS,
    sessionGraceMs = DEFAULT_SESSION_GRACE_MS,
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
  const terminalSessions = new Map();
  let activeSessions = 0;

  function rejectUpgrade(socket, statusCode, statusText) {
    socket.write(`HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }

  function authorizeUpgrade(req) {
    const session = getSession(req);
    if (session) {
      try {
        const url = new URL(req.url || "/", "http://localhost");
        return { session, terminalSessionId: url.searchParams.get("sessionId") || null };
      } catch {
        return { session, terminalSessionId: null };
      }
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

    const authz = authorizeUpgrade(req);
    if (!authz) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }
    req.terminalAuth = authz;

    const requestedSessionId = authz.terminalSessionId;
    if (!terminalSessions.has(requestedSessionId) && activeSessions >= maxSessions) {
      rejectUpgrade(socket, 503, "Service Unavailable");
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws, req) => {
    const { cols, rows } = parseInitialSize(req);
    const requestedSessionId = req.terminalAuth?.terminalSessionId || null;
    let terminalSession = requestedSessionId ? terminalSessions.get(requestedSessionId) : null;

    if (terminalSession?.closeTimer) {
      clearTimeout(terminalSession.closeTimer);
      terminalSession.closeTimer = null;
    }

    if (!terminalSession) {
      activeSessions += 1;
      const shellBundle = spawnInteractiveShell({ cwd, cols, rows, logger });
      terminalSession = createTerminalSession(shellBundle, logger, (sessionId) => {
        const current = terminalSessions.get(sessionId);
        if (!current) {
          return;
        }
        if (current?.closeTimer) {
          clearTimeout(current.closeTimer);
        }
        terminalSessions.delete(sessionId);
        activeSessions = Math.max(0, activeSessions - 1);
      });
      terminalSessions.set(terminalSession.id, terminalSession);
      logger.log?.(`terminal session started (${terminalSession.kind}, ${cols}x${rows}, id=${terminalSession.id})`);
    } else {
      logger.log?.(`terminal session reattached (id=${terminalSession.id})`);
    }

    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "session", sessionId: terminalSession.id }));
    }
    terminalSession.attach(ws, () => {
      if (terminalSession.socketCount > 0 || terminalSession.closeTimer) {
        return;
      }
      terminalSession.closeTimer = setTimeout(() => {
        terminalSession.cleanup();
      }, sessionGraceMs);
      terminalSession.closeTimer.unref?.();
    });
  });

  return {
    wss,
    issueTicket(session, terminalSessionId = null) {
      if (!session) {
        throw new Error("terminal ticket requires authenticated session");
      }
      return ticketStore.issue(session, terminalSessionId);
    },
  };
}

module.exports = {
  TERMINAL_WS_PATH,
  DEFAULT_MAX_SESSIONS,
  DEFAULT_SESSION_GRACE_MS,
  KEEPALIVE_MS,
  tryParseControlMessage,
  handleHeartbeatMessage,
  createTerminalServer,
  createTerminalSession,
  spawnInteractiveShell,
  isPtyAvailable: () => loadPtyModule() !== null,
};
