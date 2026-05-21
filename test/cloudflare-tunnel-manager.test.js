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

    const originalFetch = global.fetch;
    let requestedUrl = "";
    global.fetch = async (url) => {
      requestedUrl = String(url);
      return {
        ok: true,
        async json() {
          return { success: true, result: { id: "ok" } };
        },
      };
    };
    let result;
    try {
      result = await manager.saveConfig({
        CLOUDFLARE_TUNNEL_TOKEN: "",
        CLOUDFLARE_API_TOKEN: "",
        CLOUDFLARE_ACCOUNT_ID: "account-id",
        CLOUDFLARE_TUNNEL_ID: "tunnel-id",
        TUNNEL_NODE_HOSTNAME: "node.example.com",
      });
    } finally {
      global.fetch = originalFetch;
    }
    const stored = JSON.parse(fs.readFileSync(settingsFile, "utf8"));

    assert.equal(stored.CLOUDFLARE_TUNNEL_TOKEN, "existing-token");
    assert.equal(stored.CLOUDFLARE_API_TOKEN, "existing-api-token");
    assert.equal(stored.CLOUDFLARE_ACCOUNT_ID, "account-id");
    assert.equal(stored.CLOUDFLARE_TUNNEL_ID, "tunnel-id");
    assert.equal(stored.TUNNEL_NODE_HOSTNAME, "node.example.com");
    assert.equal(result.routePublish.skipped, false);
    assert.match(requestedUrl, /accounts\/account-id\/cfd_tunnel\/tunnel-id\/configurations/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testConfigStatusExposesAccountAndTunnelIds() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "named-tunnel-manager-"));
  try {
    const settingsFile = path.join(dir, "named-tunnel-settings.json");
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({
        CLOUDFLARE_TUNNEL_TOKEN: "opaque-token",
        CLOUDFLARE_ACCOUNT_ID: "account-id",
        CLOUDFLARE_TUNNEL_ID: "tunnel-id",
      }),
      "utf8"
    );
    const manager = new CloudflareTunnelManager({
      cwd: dir,
      settingsFile,
      env: {},
      execAsync: async () => ({ stdout: "", stderr: "" }),
    });

    const status = manager.configStatus();
    assert.equal(status.accountId, "account-id");
    assert.equal(status.tunnelId, "tunnel-id");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = {
  testConfigFileOverridesEnvironment,
  testEnvironmentAloneDoesNotEnableManagedTunnel,
  testSaveConfigPreservesExistingSecretsWhenBlank,
  testConfigStatusExposesAccountAndTunnelIds,
};
