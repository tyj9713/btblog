const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  parseBaotaStatus,
  clearStaleBaotaMarker,
  isBaotaPanelPresent,
} = require("../lib/baota-manager");

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
    {
      urlFile,
      installedMarker,
      fs: {
        existsSync(filePath) {
          if (filePath === installedMarker) {
            return true;
          }
          if (String(filePath).endsWith("BT-Panel")) {
            return true;
          }
          return false;
        },
      },
    }
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

async function testInstalledRequiresPanelFiles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baota-test-"));
  const installedMarker = path.join(dir, ".baota-installed");
  fs.writeFileSync(installedMarker, "", "utf8");

  const status = parseBaotaStatus("", {
    urlFile: path.join(dir, "missing-url.txt"),
    installedMarker,
    fs: {
      existsSync(filePath) {
        if (filePath === installedMarker) {
          return true;
        }
        return false;
      },
    },
  });

  assert.equal(status.installed, false);
  assert.equal(status.needsReinstall, true);

  fs.rmSync(dir, { recursive: true, force: true });
}

async function testClearStaleBaotaMarker() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baota-test-"));
  const marker = path.join(dir, ".baota-installed");
  fs.writeFileSync(marker, "", "utf8");

  const cleared = clearStaleBaotaMarker(marker, { warn() {} });
  assert.equal(cleared, !isBaotaPanelPresent());
  assert.equal(fs.existsSync(marker), isBaotaPanelPresent());

  fs.rmSync(dir, { recursive: true, force: true });
}

async function testFormatBaotaCredentialsRemovesIpAddresses() {
  const { formatBaotaCredentials } = require("../lib/baota-manager");
  const formatted = formatBaotaCredentials(`
==================================================================
\u001b[32mBT-Panel default info!\u001b[0m
==================================================================
外网ipv4面板地址: https://13.75.73.169:21222/7ddfcad6
内网面板地址:     https://169.254.129.2:21222/7ddfcad6
username: admin
password: abc123
`);

  assert.doesNotMatch(formatted, /13\.75\.73\.169/);
  assert.doesNotMatch(formatted, /169\.254\.129\.2/);
  assert.match(formatted, /username: admin/);
  assert.match(formatted, /password: abc123/);
}

module.exports = {
  testParseBaotaStatus,
  testParseBaotaStatusRequiresPanelAndTunnel,
  testInstalledRequiresPanelFiles,
  testClearStaleBaotaMarker,
  testFormatBaotaCredentialsRemovesIpAddresses,
};

