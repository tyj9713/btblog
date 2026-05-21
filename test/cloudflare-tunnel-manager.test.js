const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { CloudflareTunnelManager } = require("../lib/cloudflare-tunnel-manager");

async function testConfigFileOverridesEnvironment() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "named-tunnel-manager-"));
  try {
    const settingsFile = path.join(dir, "named-tunnel-settings.json");
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({
        CLOUDFLARE_TUNNEL_TOKEN: "file-token",
        TUNNEL_NODE_HOSTNAME: "file.example.com",
      }),
      "utf8"
    );
    const manager = new CloudflareTunnelManager({
      cwd: dir,
      settingsFile,
      env: {
        CLOUDFLARE_TUNNEL_TOKEN: "env-token",
        TUNNEL_NODE_HOSTNAME: "env.example.com",
      },
      execAsync: async () => ({ stdout: "", stderr: "" }),
    });

    const status = manager.configStatus();
    assert.equal(status.hasTunnelToken, true);
    assert.equal(status.nodeHostname, "file.example.com");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testEnvironmentAloneDoesNotEnableManagedTunnel() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "named-tunnel-manager-"));
  try {
    const manager = new CloudflareTunnelManager({
      cwd: dir,
      settingsFile: path.join(dir, "named-tunnel-settings.json"),
      env: {
        CLOUDFLARE_TUNNEL_TOKEN: "env-token",
        TUNNEL_NODE_HOSTNAME: "env.example.com",
      },
      execAsync: async () => ({ stdout: "", stderr: "" }),
    });

    const status = manager.configStatus();
    assert.equal(status.configured, false);
    assert.equal(status.hasTunnelToken, false);
    assert.equal(status.nodeHostname, "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testSaveConfigPreservesExistingSecretsWhenBlank() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "named-tunnel-manager-"));
  try {
    const settingsFile = path.join(dir, "named-tunnel-settings.json");
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({
        CLOUDFLARE_TUNNEL_TOKEN: "existing-token",
        CLOUDFLARE_API_TOKEN: "existing-api-token",
      }),
      "utf8"
    );
    const manager = new CloudflareTunnelManager({
      cwd: dir,
      settingsFile,
      env: {},
      execAsync: async () => ({ stdout: "", stderr: "" }),
    });

    const result = await manager.saveConfig({
      CLOUDFLARE_TUNNEL_TOKEN: "",
      CLOUDFLARE_API_TOKEN: "",
      TUNNEL_NODE_HOSTNAME: "node.example.com",
    });
    const stored = JSON.parse(fs.readFileSync(settingsFile, "utf8"));

    assert.equal(stored.CLOUDFLARE_TUNNEL_TOKEN, "existing-token");
    assert.equal(stored.CLOUDFLARE_API_TOKEN, "existing-api-token");
    assert.equal(stored.TUNNEL_NODE_HOSTNAME, "node.example.com");
    assert.equal(result.routePublish.skipped, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = {
  testConfigFileOverridesEnvironment,
  testEnvironmentAloneDoesNotEnableManagedTunnel,
  testSaveConfigPreservesExistingSecretsWhenBlank,
};
