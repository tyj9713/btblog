const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { CloudflareTunnelManager } = require("../lib/cloudflare-tunnel-manager");

function normalizeHostname(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function mockTunnelScriptExec(settingsFile) {
  return async (command) => {
    if (/tunnel-config-status\.sh/.test(command)) {
      const data =
        settingsFile && fs.existsSync(settingsFile)
          ? JSON.parse(fs.readFileSync(settingsFile, "utf8"))
          : {};
      const token = String(data.CLOUDFLARE_TUNNEL_TOKEN || "").trim();
      return {
        stdout: JSON.stringify({
          configured: Boolean(token),
          hasTunnelToken: Boolean(token),
          hasApiToken: Boolean(String(data.CLOUDFLARE_API_TOKEN || "").trim()),
          accountId: String(data.CLOUDFLARE_ACCOUNT_ID || "").trim(),
          tunnelId: String(data.CLOUDFLARE_TUNNEL_ID || "").trim(),
          nodeHostname: normalizeHostname(data.TUNNEL_NODE_HOSTNAME),
          btHostname: normalizeHostname(data.TUNNEL_BT_HOSTNAME),
          portDomain: normalizeHostname(data.TUNNEL_PORT_DOMAIN),
          portHostPrefix: String(data.TUNNEL_PORT_HOST_PREFIX || "p").trim() || "p",
          portHostTemplate: String(data.TUNNEL_PORT_HOST_TEMPLATE || "").trim(),
          xrayPort: Number.parseInt(data.XRAY_PORT, 10) || 10086,
          btPort: Number.parseInt(data.BT_PORT, 10) || 8888,
          btPortEffective: Number.parseInt(data.BT_PORT, 10) || 8888,
          remoteConfig: String(data.CLOUDFLARE_TUNNEL_LOCAL_CONFIG || "").toLowerCase() !== "true",
        }),
        stderr: "",
      };
    }
    return { stdout: "{}", stderr: "" };
  };
}

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
      execAsync: mockTunnelScriptExec(settingsFile),
    });

    const status = await manager.configStatus();
    assert.equal(status.hasTunnelToken, true);
    assert.equal(status.nodeHostname, "file.example.com");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testEnvironmentAloneDoesNotEnableManagedTunnel() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "named-tunnel-manager-"));
  try {
    const settingsFile = path.join(dir, "named-tunnel-settings.json");
    const manager = new CloudflareTunnelManager({
      cwd: dir,
      settingsFile,
      env: {
        CLOUDFLARE_TUNNEL_TOKEN: "env-token",
        TUNNEL_NODE_HOSTNAME: "env.example.com",
      },
      execAsync: mockTunnelScriptExec(settingsFile),
    });

    const status = await manager.configStatus();
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

    let publishCommand = "";
    manager.execAsync = async (command) => {
      if (/publish-tunnel-routes\.sh/.test(command)) {
        publishCommand = command;
        return {
          stdout: JSON.stringify({ skipped: false, result: { id: "ok" } }),
          stderr: "",
        };
      }
      if (/sync-tunnel-runtime\.sh/.test(command)) {
        return { stdout: "", stderr: "" };
      }
      if (/tunnel-config-status\.sh/.test(command)) {
        return {
          stdout: JSON.stringify({
            configured: true,
            hasTunnelToken: true,
            hasApiToken: true,
            accountId: "account-id",
            tunnelId: "tunnel-id",
            nodeHostname: "node.example.com",
          }),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    };
    const result = await manager.saveConfig({
      CLOUDFLARE_TUNNEL_TOKEN: "",
      CLOUDFLARE_API_TOKEN: "",
      CLOUDFLARE_ACCOUNT_ID: "account-id",
      CLOUDFLARE_TUNNEL_ID: "tunnel-id",
      TUNNEL_NODE_HOSTNAME: "node.example.com",
    });
    const stored = JSON.parse(fs.readFileSync(settingsFile, "utf8"));

    assert.equal(stored.CLOUDFLARE_TUNNEL_TOKEN, "existing-token");
    assert.equal(stored.CLOUDFLARE_API_TOKEN, "existing-api-token");
    assert.equal(stored.CLOUDFLARE_ACCOUNT_ID, "account-id");
    assert.equal(stored.CLOUDFLARE_TUNNEL_ID, "tunnel-id");
    assert.equal(stored.TUNNEL_NODE_HOSTNAME, "node.example.com");
    assert.equal(result.routePublish.skipped, false);
    assert.match(publishCommand, /publish-tunnel-routes\.sh/);
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

    manager.execAsync = async (command) => {
      if (/tunnel-config-status\.sh/.test(command)) {
        return {
          stdout: JSON.stringify({
            accountId: "account-id",
            tunnelId: "tunnel-id",
          }),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    };
    const status = await manager.configStatus();
    assert.equal(status.accountId, "account-id");
    assert.equal(status.tunnelId, "tunnel-id");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testStoredConfigOverridesProcessEnvForShellScripts() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "named-tunnel-manager-"));
  try {
    const settingsFile = path.join(dir, "named-tunnel-settings.json");
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({
        CLOUDFLARE_TUNNEL_TOKEN: "file-token",
        TUNNEL_NODE_HOSTNAME: "node.new.example.com",
        TUNNEL_BT_HOSTNAME: "bt.new.example.com",
      }),
      "utf8"
    );
    const env = {
      CLOUDFLARE_TUNNEL_TOKEN: "env-token",
      TUNNEL_NODE_HOSTNAME: "node.old.example.com",
      TUNNEL_BT_HOSTNAME: "bt.old.example.com",
    };
    const manager = new CloudflareTunnelManager({
      cwd: dir,
      settingsFile,
      env,
      execAsync: async () => ({ stdout: "", stderr: "" }),
    });

    manager.execAsync = async (command) => {
      if (/sync-tunnel-runtime\.sh/.test(command)) {
        manager.applyStoredConfigToProcessEnv(env);
        const shellEnv = [
          "# Generated by btblog from named-tunnel-settings.json",
          "",
          "export TUNNEL_NODE_HOSTNAME='node.new.example.com'",
          "export TUNNEL_BT_HOSTNAME='bt.new.example.com'",
          "export CLOUDFLARE_TUNNEL_TOKEN='file-token'",
          "",
        ].join("\n");
        fs.writeFileSync(path.join(dir, "named-tunnel.env"), shellEnv, "utf8");
        return { stdout: path.join(dir, "named-tunnel.env"), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    await manager.syncRuntimeConfig();
    assert.equal(env.TUNNEL_NODE_HOSTNAME, "node.new.example.com");
    assert.equal(env.TUNNEL_BT_HOSTNAME, "bt.new.example.com");
    assert.equal(env.CLOUDFLARE_TUNNEL_TOKEN, "file-token");

    const shellEnv = fs.readFileSync(path.join(dir, "named-tunnel.env"), "utf8");
    assert.match(shellEnv, /export TUNNEL_NODE_HOSTNAME='node\.new\.example\.com'/);
    assert.match(shellEnv, /export TUNNEL_BT_HOSTNAME='bt\.new\.example\.com'/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testSaveConfigPreservesExistingHostnamesWhenBlank() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "named-tunnel-manager-"));
  try {
    const settingsFile = path.join(dir, "named-tunnel-settings.json");
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({
        CLOUDFLARE_TUNNEL_TOKEN: "existing-token",
        TUNNEL_NODE_HOSTNAME: "node.example.com",
        TUNNEL_BT_HOSTNAME: "bt.example.com",
      }),
      "utf8"
    );
    const manager = new CloudflareTunnelManager({
      cwd: dir,
      settingsFile,
      env: {},
      execAsync: async () => ({ stdout: "", stderr: "" }),
    });

    manager.execAsync = async (command) => {
      if (/publish-tunnel-routes\.sh|sync-tunnel-runtime\.sh|tunnel-config-status\.sh/.test(command)) {
        return { stdout: "{}", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    await manager.saveConfig({
      CLOUDFLARE_TUNNEL_TOKEN: "",
      TUNNEL_NODE_HOSTNAME: "",
      TUNNEL_BT_HOSTNAME: "bt.updated.example.com",
      CLOUDFLARE_ACCOUNT_ID: "account-id",
      CLOUDFLARE_TUNNEL_ID: "tunnel-id",
    });

    const stored = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    assert.equal(stored.TUNNEL_NODE_HOSTNAME, "node.example.com");
    assert.equal(stored.TUNNEL_BT_HOSTNAME, "bt.updated.example.com");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = {
  testConfigFileOverridesEnvironment,
  testEnvironmentAloneDoesNotEnableManagedTunnel,
  testSaveConfigPreservesExistingSecretsWhenBlank,
  testConfigStatusExposesAccountAndTunnelIds,
  testStoredConfigOverridesProcessEnvForShellScripts,
  testSaveConfigPreservesExistingHostnamesWhenBlank,
};
