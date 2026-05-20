const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { parseBaotaStatus } = require("../lib/baota-manager");

async function testParseBaotaStatus() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baota-test-"));
  const urlFile = path.join(dir, "baota-panel-url.txt");
  const installedMarker = path.join(dir, ".baota-installed");
  fs.writeFileSync(urlFile, "https://demo.trycloudflare.com/abc\n", "utf8");
  fs.writeFileSync(installedMarker, "", "utf8");

  const status = parseBaotaStatus(
    `
root 1 0 baota-panel-tunnel --url https://127.0.0.1:8888
root 2 0 /www/server/panel/BT-Panel
`,
    { urlFile, installedMarker }
  );

  assert.equal(status.panelRunning, true);
  assert.equal(status.tunnelRunning, true);
  assert.equal(status.panelUrl, "https://demo.trycloudflare.com/abc");
  assert.equal(status.ready, true);

  fs.rmSync(dir, { recursive: true, force: true });
}

async function testParseBaotaStatusRequiresPanelAndTunnel() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baota-test-"));
  const urlFile = path.join(dir, "baota-panel-url.txt");
  const installedMarker = path.join(dir, ".baota-installed");
  fs.writeFileSync(urlFile, "https://demo.trycloudflare.com/abc\n", "utf8");
  fs.writeFileSync(installedMarker, "", "utf8");

  const unhealthy = parseBaotaStatus(
    `
root 1 0 baota-panel-tunnel --url https://127.0.0.1:8888
`,
    { urlFile, installedMarker }
  );

  assert.equal(unhealthy.panelRunning, false);
  assert.equal(unhealthy.tunnelRunning, true);
  assert.equal(unhealthy.ready, false);

  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = {
  testParseBaotaStatus,
  testParseBaotaStatusRequiresPanelAndTunnel,
};

