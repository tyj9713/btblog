const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const script = fs.readFileSync(
  path.join(__dirname, "..", "scripts", "cleanup-runtime.sh"),
  "utf8"
);

async function testCleanupRemovesLogsAndBaotaInfo() {
  assert.match(script, /baota-default\.txt/);
  assert.match(script, /baota-panel-url\.txt/);
  assert.match(script, /named-tunnel\.log/);
  assert.doesNotMatch(script, /named-tunnel-settings\.json/);
}

module.exports = {
  testCleanupRemovesLogsAndBaotaInfo,
};
