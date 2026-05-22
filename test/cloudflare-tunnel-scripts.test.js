const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const tunnelLib = fs.readFileSync(
  path.join(__dirname, "..", "scripts", "tunnel-lib.sh"),
  "utf8"
);
const syncScript = fs.readFileSync(
  path.join(__dirname, "..", "scripts", "sync-named-tunnel.sh"),
  "utf8"
);

async function testTunnelLibUsesPythonForCloudflareApi() {
  assert.match(tunnelLib, /command == "publish"/);
  assert.match(tunnelLib, /api\.cloudflare\.com/);
}

async function testSyncNamedTunnelOrchestratesShellSteps() {
  assert.match(syncScript, /tunnel_publish_routes/);
  assert.match(syncScript, /ensure-cloudflared\.sh/);
  assert.match(syncScript, /start-named-tunnel\.sh/);
}

module.exports = {
  testTunnelLibUsesPythonForCloudflareApi,
  testSyncNamedTunnelOrchestratesShellSteps,
};
