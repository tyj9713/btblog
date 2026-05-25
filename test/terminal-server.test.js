const assert = require("node:assert/strict");
const http = require("node:http");
const { spawn } = require("node:child_process");

const {
  TERMINAL_WS_PATH,
  DEFAULT_SESSION_GRACE_MS,
  KEEPALIVE_MS,
  tryParseControlMessage,
  handleHeartbeatMessage,
  createTerminalServer,
  spawnInteractiveShell,
} = require("../lib/terminal-server");

function wsAvailable() {
  try {
    require.resolve("ws");
    return true;
  } catch {
    return false;
  }
}

async function testTerminalWsPathConstant() {
  assert.equal(TERMINAL_WS_PATH, "/admin/terminal/ws");
  assert.equal(KEEPALIVE_MS, 20_000);
  assert.equal(DEFAULT_SESSION_GRACE_MS, 120_000);
}

async function testTerminalHeartbeatMessages() {
  const sent = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    send(payload) {
      sent.push(payload);
    },
  };

  assert.equal(tryParseControlMessage('{"type":"ping"}')?.type, "ping");
  assert.equal(tryParseControlMessage("echo hello"), null);

  assert.equal(handleHeartbeatMessage({ type: "ping" }, ws), true);
  assert.deepEqual(sent, [JSON.stringify({ type: "pong" })]);
  assert.equal(handleHeartbeatMessage({ type: "pong" }, ws), true);
  assert.equal(handleHeartbeatMessage({ type: "resize", cols: 80, rows: 24 }, ws), false);
}

async function testCreateTerminalServerRequiresOptions() {
  assert.throws(
    () => createTerminalServer({}),
    /requires server, getSession, and cwd/
  );
}

async function testIssueTerminalTicketRequiresSession() {
  if (!wsAvailable()) {
    return;
  }
  const server = http.createServer((_req, res) => {
    res.end("ok");
  });
  const terminal = createTerminalServer({
    server,
    getSession: () => null,
    cwd: process.cwd(),
  });
  assert.throws(() => terminal.issueTicket(null), /requires authenticated session/);
}

async function testTerminalUpgradeRejectsUnauthorized() {
  if (process.platform === "win32" || !wsAvailable()) {
    return;
  }

  const server = http.createServer((_req, res) => {
    res.end("ok");
  });

  createTerminalServer({
    server,
    getSession: () => null,
    cwd: process.cwd(),
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    const response = await new Promise((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1",
        port,
        path: TERMINAL_WS_PATH,
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version": "13",
        },
      });
      req.on("response", resolve);
      req.on("error", reject);
      req.end();
    });
    assert.equal(response.statusCode, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function testTerminalUpgradeAcceptsTicket() {
  if (process.platform === "win32" || !wsAvailable()) {
    return;
  }

  const server = http.createServer((_req, res) => {
    res.end("ok");
  });

  const terminal = createTerminalServer({
    server,
    getSession: () => null,
    cwd: process.cwd(),
  });
  const ticket = terminal.issueTicket({ user: "admin" });

  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(
        "node",
        [
          "-e",
          `
const WebSocket = require("ws");
const ws = new WebSocket("ws://127.0.0.1:${port}${TERMINAL_WS_PATH}?ticket=${ticket}");
let output = "";
ws.on("message", (data) => { output += data.toString(); });
ws.on("close", () => {
  process.stdout.write(output);
  process.exit(output.length > 0 ? 0 : 1);
});
setTimeout(() => process.exit(2), 5000);
`,
        ],
        { stdio: ["ignore", "pipe", "inherit"] }
      );
      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.on("close", (code) => {
        if (code === 0) {
          resolve(stdout);
          return;
        }
        reject(new Error(`terminal client exited with ${code}: ${stdout}`));
      });
    });
    assert.ok(String(output).length > 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function testTerminalReconnectPreservesShellSession() {
  if (process.platform === "win32" || !wsAvailable()) {
    return;
  }

  const WebSocket = require("ws");
  const server = http.createServer((_req, res) => {
    res.end("ok");
  });

  const terminal = createTerminalServer({
    server,
    getSession: () => null,
    cwd: process.cwd(),
    sessionGraceMs: 5000,
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  function connect(ticket) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${TERMINAL_WS_PATH}?ticket=${ticket}`);
    let output = "";
    let sessionId = null;
    const sessionReady = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("terminal session id timeout")), 5000);
      ws.on("message", (data) => {
        const text = data.toString();
        try {
          const message = JSON.parse(text);
          if (message.type === "session" && message.sessionId) {
            sessionId = message.sessionId;
            clearTimeout(timer);
            resolve(sessionId);
            return;
          }
        } catch {
          // terminal output
        }
        output += text;
      });
      ws.on("error", reject);
    });
    return {
      ws,
      sessionReady,
      get output() {
        return output;
      },
    };
  }

  async function waitForOutput(client, pattern) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (pattern.test(client.output)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`timed out waiting for ${pattern}: ${client.output}`);
  }

  try {
    const first = connect(terminal.issueTicket({ user: "admin" }));
    const sessionId = await first.sessionReady;
    first.ws.send("export CODEX_RECONNECT_MARK=still_here\n");
    await new Promise((resolve) => setTimeout(resolve, 200));
    first.ws.close();
    await new Promise((resolve) => first.ws.once("close", resolve));

    const second = connect(terminal.issueTicket({ user: "admin" }, sessionId));
    await second.sessionReady;
    second.ws.send('printf "MARK:%s\\n" "$CODEX_RECONNECT_MARK"\nexit\n');
    await waitForOutput(second, /MARK:still_here/);
    await new Promise((resolve) => second.ws.once("close", resolve));
  } finally {
    terminal.wss.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function testSpawnInteractiveShellReturnsProcess() {
  if (process.platform === "win32") {
    return;
  }
  const shellBundle = spawnInteractiveShell({
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    shellPath: "/bin/sh",
  });
  assert.match(shellBundle.kind, /^(pty|pipe)$/);
  assert.ok(shellBundle.process);
  try {
    if (shellBundle.kind === "pty") {
      shellBundle.process.kill();
    } else {
      shellBundle.process.kill("SIGTERM");
    }
  } catch {
    // ignore
  }
}

module.exports = {
  testTerminalWsPathConstant,
  testTerminalHeartbeatMessages,
  testCreateTerminalServerRequiresOptions,
  testIssueTerminalTicketRequiresSession,
  testTerminalUpgradeRejectsUnauthorized,
  testTerminalUpgradeAcceptsTicket,
  testTerminalReconnectPreservesShellSession,
  testSpawnInteractiveShellReturnsProcess,
};
