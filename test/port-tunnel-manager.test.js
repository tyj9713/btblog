const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  parsePort,
  parseProtocol,
  buildOrigin,
  buildNamedTunnelUrl,
  extractTryCloudflareUrl,
  tunnelProcessName,
  tunnelLogFileName,
  PortTunnelManager,
} = require("../lib/port-tunnel-manager");

async function testParsePort() {
  assert.equal(parsePort("8080"), 8080);
  assert.throws(() => parsePort("0"), /1-65535/);
  assert.throws(() => parsePort("70000"), /1-65535/);
}

async function testParseProtocol() {
  assert.equal(parseProtocol("http"), "http");
  assert.equal(parseProtocol("HTTPS"), "https");
  assert.throws(() => parseProtocol("ftp"), /http 或 https/);
}

async function testExtractTryCloudflareUrl() {
  const log =
    "INF Registered tunnel connection ... https://demo-abc.trycloudflare.com ready";
  assert.equal(
    extractTryCloudflareUrl(log),
    "https://demo-abc.trycloudflare.com"
  );
}

async function testBuildOriginAndNames() {
  assert.equal(buildOrigin(3000, "http"), "http://127.0.0.1:3000");
  assert.equal(buildNamedTunnelUrl("demo.example.com"), "https://demo.example.com");
  assert.equal(tunnelProcessName(3000), "port-tunnel-3000");
  assert.equal(tunnelLogFileName(3000), "port-tunnel-3000.log");
}

async function testListReadsState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "port-tunnel-test-"));
  const stateFile = path.join(dir, "port-tunnels.json");
  fs.writeFileSync(
    stateFile,
    JSON.stringify(
      {
        "8080": {
          port: 8080,
          protocol: "http",
          origin: "http://127.0.0.1:8080",
          url: "https://demo.trycloudflare.com",
          logFile: "port-tunnel-8080.log",
          status: "ready",
        },
      },
      null,
      2
    ),
    "utf8"
  );

  const manager = new PortTunnelManager({
    cwd: dir,
    stateFile,
    execAsync: async () => ({ stdout: "", stderr: "" }),
  });

  const result = await manager.list();
  assert.equal(result.tunnels.length, 1);
  assert.equal(result.tunnels[0].port, 8080);
  assert.equal(result.tunnels[0].url, "https://demo.trycloudflare.com");

  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = {
  testParsePort,
  testParseProtocol,
  testExtractTryCloudflareUrl,
  testBuildOriginAndNames,
  testListReadsState,
};
