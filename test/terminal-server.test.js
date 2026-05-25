const assert = require("node:assert/strict");
const http = require("node:http");
const { spawn } = require("node:child_process");

const {
  TERMINAL_WS_PATH,
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
  testCreateTerminalServerRequiresOptions,
  testIssueTerminalTicketRequiresSession,
  testTerminalUpgradeRejectsUnauthorized,
  testTerminalUpgradeAcceptsTicket,
  testSpawnInteractiveShellReturnsProcess,
};
