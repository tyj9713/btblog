const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")
);

async function testNodeEngineTargetsNode22() {
  assert.equal(packageJson.engines.node, ">=22 <23");
}

async function testDependenciesOnlyIncludeRuntimeImports() {
  assert.deepEqual(Object.keys(packageJson.dependencies).sort(), ["express", "node-pty", "ws"]);
}

module.exports = {
  testNodeEngineTargetsNode22,
  testDependenciesOnlyIncludeRuntimeImports,
};
