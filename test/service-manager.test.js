const assert = require("node:assert/strict");

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  parseProcessStatus,
  ServiceManager,
  shellQuote,
  buildReadyResponse,
  normalizeShellScriptLineEndings,
} = require("../lib/service-manager");

async function testParseProcessStatus() {
  const status = parseProcessStatus(`
root 1 0 grep -E xray|cloudflared-linux
root 2 0 /bin/sh -c bash suoha.sh
root 3 0 ./xray/xray run -config xray/config.json
root 4 0 ./cloudflared-linux tunnel --url http://localhost:12345
`);

  assert.equal(status.xrayRunning, true);
  assert.equal(status.argoRunning, true);
  assert.equal(status.bothRunning, true);
}

async function testParseProcessStatusNamedTunnel() {
  const status = parseProcessStatus(
    `
root 3 0 ./xray/xray run -config xray/config.json
root 5 0 btblog-named-tunnel ./cloudflared-linux tunnel --config cloudflared-config.yml run
`,
    { namedTunnelEnabled: true }
  );

  assert.equal(status.xrayRunning, true);
  assert.equal(status.namedTunnelRunning, true);
  assert.equal(status.argoRunning, true);
  assert.equal(status.bothRunning, true);
}

async function testConcurrentStartCoalesces() {
  let runs = 0;
  const manager = new ServiceManager({
    execAsync: async (command) => {
      if (/bash\s+'.*suoha\.sh'/.test(command)) {
        runs += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return { stdout: "" };
    },
    logger: { log() {}, error() {} },
  });

  await Promise.all([
    manager.start("manual"),
    manager.start("keepalive"),
    manager.start("health"),
  ]);

  assert.equal(runs, 1);
}

async function testManualStopSuppressesKeepalive() {
  let starts = 0;
  const manager = new ServiceManager({
    execAsync: async (command) => {
      if (/bash\s+'.*suoha\.sh'/.test(command)) {
        starts += 1;
      }
      return { stdout: "" };
    },
    logger: { log() {}, error() {} },
  });

  await manager.stop();
  const result = await manager.ensureRunning("keepalive");

  assert.equal(result.suppressed, true);
  assert.equal(starts, 0);
}

async function testManualStartClearsStoppedState() {
  let starts = 0;
  const manager = new ServiceManager({
    execAsync: async (command) => {
      if (/bash\s+'.*suoha\.sh'/.test(command)) {
        starts += 1;
      }
      return { stdout: "" };
    },
    logger: { log() {}, error() {} },
  });

  await manager.stop();
  await manager.start("manual");

  assert.equal(starts, 1);
}

async function testShellQuoteHandlesSpaces() {
  assert.equal(
    shellQuote("/home/site/wwwroot/New project 3/suoha.sh"),
    "'/home/site/wwwroot/New project 3/suoha.sh'"
  );
}

function testNormalizeShellScriptLineEndings() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "suoha-crlf-"));
  const scriptPath = path.join(tempDir, "suoha.sh");
  fs.writeFileSync(scriptPath, "#!/bin/bash\r\necho ok\r\n");

  assert.equal(normalizeShellScriptLineEndings(scriptPath), true);
  assert.equal(fs.readFileSync(scriptPath, "utf8"), "#!/bin/bash\necho ok\n");
  assert.equal(normalizeShellScriptLineEndings(scriptPath), false);

  fs.rmSync(tempDir, { recursive: true, force: true });
}

async function testReadyResponseFailsWhenServicesMissing() {
  const response = buildReadyResponse({
    xrayRunning: true,
    argoRunning: false,
    bothRunning: false,
  }, 12);

  assert.equal(response.statusCode, 503);
  assert.equal(response.body.ok, false);
}

module.exports = {
  testParseProcessStatus,
  testParseProcessStatusNamedTunnel,
  testConcurrentStartCoalesces,
  testManualStopSuppressesKeepalive,
  testManualStartClearsStoppedState,
  testShellQuoteHandlesSpaces,
  testNormalizeShellScriptLineEndings,
  testReadyResponseFailsWhenServicesMissing,
};
