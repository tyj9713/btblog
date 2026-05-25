const assert = require("node:assert/strict");
const http = require("node:http");
const { spawn } = require("node:child_process");

const { TERMINAL_WS_PATH, createTerminalServer } = require("../lib/terminal-server");

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

async function testTerminalUpgradeAcceptsAuthorizedSession() {
  if (process.platform === "win32" || !wsAvailable()) {
    return;
  }

  const server = http.createServer((_req, res) => {
    res.end("ok");
  });

  createTerminalServer({
    server,
    getSession: () => ({ user: "admin" }),
    cwd: process.cwd(),
    shellPath: "/bin/sh",
    shellArgs: ["-c", "echo hello-terminal"],
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  let ws;
  try {
    ws = await new Promise((resolve, reject) => {
      const child = spawn(
        "node",
        [
          "-e",
          `
const WebSocket = require("ws");
const ws = new WebSocket("ws://127.0.0.1:${port}${TERMINAL_WS_PATH}");
let output = "";
ws.on("open", () => {});
ws.on("message", (data) => { output += data.toString(); });
ws.on("close", () => {
  process.stdout.write(output);
  process.exit(output.includes("hello-terminal") ? 0 : 1);
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
    assert.match(String(ws), /hello-terminal/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

module.exports = {
  testTerminalWsPathConstant,
  testCreateTerminalServerRequiresOptions,
  testTerminalUpgradeRejectsUnauthorized,
  testTerminalUpgradeAcceptsAuthorizedSession,
};
