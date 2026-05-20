const assert = require("node:assert/strict");

const { resolveRuntimeDir } = require("../lib/runtime");

async function testDefaultRuntimeDirUsesAppDirectory() {
  assert.equal(resolveRuntimeDir({}, "/home/site/wwwroot"), "/home/site/wwwroot");
}

async function testRuntimeDirCanBeOverridden() {
  assert.equal(
    resolveRuntimeDir({ ARGO_RUNTIME_DIR: "/home/argoblog" }, "/home/site/wwwroot"),
    "/home/argoblog"
  );
}

module.exports = {
  testDefaultRuntimeDirUsesAppDirectory,
  testRuntimeDirCanBeOverridden,
};
