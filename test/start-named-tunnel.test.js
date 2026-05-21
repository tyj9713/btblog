const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const script = fs.readFileSync(
  path.join(__dirname, "..", "start-named-tunnel.sh"),
  "utf8"
);

async function testNamedTunnelUsesExplicitTokenFlag() {
  assert.match(script, /tunnel --no-autoupdate run --token \$\{quoted_token\}/);
}

async function testLocalConfigUsesOfficialRunParameterOrder() {
  assert.match(script, /tunnel --config \$\{quoted_config\} --no-autoupdate run/);
}

async function testNamedTunnelLoadsStoredEnvFile() {
  assert.match(script, /named-tunnel\.env/);
}

module.exports = {
  testNamedTunnelUsesExplicitTokenFlag,
  testLocalConfigUsesOfficialRunParameterOrder,
  testNamedTunnelLoadsStoredEnvFile,
};
