const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  decodeTunnelToken,
  resolveTunnelSettings,
  buildPortHostname,
  buildIngressRules,
  renderConfigYaml,
  buildTunnelArtifacts,
  normalizeHostname,
} = require("../lib/cloudflare-tunnel-config");

function makeToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
    "base64url"
  );
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

async function testDecodeTunnelToken() {
  const token = makeToken({
    a: "account-id",
    t: "tunnel-id",
    s: "secret-value",
  });
  assert.deepEqual(decodeTunnelToken(token), {
    AccountTag: "account-id",
    TunnelID: "tunnel-id",
    TunnelSecret: "secret-value",
  });
}

async function testResolveTunnelSettings() {
  const token = makeToken({ a: "a1", t: "t1", s: "s1" });
  const settings = resolveTunnelSettings({
    CLOUDFLARE_TUNNEL_TOKEN: token,
    TUNNEL_NODE_HOSTNAME: "https://Node.Example.com/",
    TUNNEL_BT_HOSTNAME: "bt.example.com",
    XRAY_PORT: "10086",
    BT_PORT: "8888",
    TUNNEL_PORT_DOMAIN: "example.com",
    TUNNEL_PORT_HOST_PREFIX: "p",
  });

  assert.equal(settings.enabled, true);
  assert.equal(settings.nodeHostname, "node.example.com");
  assert.equal(settings.btHostname, "bt.example.com");
  assert.equal(settings.xrayPort, 10086);
  assert.equal(settings.btPort, 8888);
  assert.equal(settings.useRemoteConfig, true);
  assert.equal(settings.useLocalConfig, false);
}

async function testResolveAzureAppSettingFallback() {
  const token = makeToken({ a: "a1", t: "t1", s: "s1" });
  const settings = resolveTunnelSettings({
    APPSETTING_CLOUDFLARE_TUNNEL_TOKEN: token,
    APPSETTING_TUNNEL_NODE_HOSTNAME: "node.hk.example.com",
  });
  assert.equal(settings.enabled, true);
  assert.equal(settings.token, token);
  assert.equal(settings.nodeHostname, "node.hk.example.com");
}

async function testOpaqueTokenEnablesRemoteConnector() {
  const settings = resolveTunnelSettings({
    CLOUDFLARE_TUNNEL_TOKEN: "opaque-dashboard-token",
    CLOUDFLARE_TUNNEL_REMOTE_CONFIG: "true",
  });

  assert.equal(settings.enabled, true);
  assert.equal(settings.credentials, null);
  assert.equal(settings.useRemoteConfig, true);
}

async function testRemoteConfigDoesNotRequireLocalCredentialsOrHostname() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "named-tunnel-remote-"));
  try {
    const artifacts = buildTunnelArtifacts({
      runtimeDir: dir,
      env: {
        CLOUDFLARE_TUNNEL_TOKEN: "opaque-dashboard-token",
        CLOUDFLARE_TUNNEL_REMOTE_CONFIG: "true",
      },
      bindings: [],
    });

    assert.equal(artifacts.enabled, true);
    assert.equal(artifacts.configYaml, "");
    assert.equal(fs.existsSync(path.join(dir, "cloudflared-credentials.json")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testLocalConfigStillRequiresCredentials() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "named-tunnel-local-"));
  try {
    assert.throws(
      () =>
        buildTunnelArtifacts({
          runtimeDir: dir,
          env: {
            CLOUDFLARE_TUNNEL_TOKEN: "opaque-dashboard-token",
            CLOUDFLARE_TUNNEL_LOCAL_CONFIG: "true",
            TUNNEL_NODE_HOSTNAME: "node.example.com",
          },
          bindings: [],
        }),
      /CLOUDFLARE_TUNNEL_TOKEN 无效/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testBuildPortHostname() {
  const settings = resolveTunnelSettings({
    TUNNEL_PORT_DOMAIN: "example.com",
    TUNNEL_PORT_HOST_PREFIX: "p",
  });
  assert.equal(buildPortHostname(8080, settings), "p8080.example.com");
}

async function testBuildIngressRules() {
  const settings = resolveTunnelSettings({
    TUNNEL_NODE_HOSTNAME: "node.example.com",
    TUNNEL_BT_HOSTNAME: "bt.example.com",
    XRAY_PORT: "10086",
    BT_PORT: "8888",
    TUNNEL_PORT_DOMAIN: "example.com",
  });

  const rules = buildIngressRules(settings, [{ port: 3000, protocol: "http" }]);
  assert.equal(rules.length, 4);
  assert.equal(rules[0].hostname, "node.example.com");
  assert.equal(rules[0].service, "http://127.0.0.1:10086");
  assert.equal(rules[1].service, "https://127.0.0.1:8888");
  assert.equal(rules[2].hostname, "p3000.example.com");
  assert.equal(rules[3].service, "http_status:404");
}

async function testRenderConfigYaml() {
  const yaml = renderConfigYaml("tunnel-id", "/tmp/credentials.json", [
    { hostname: "node.example.com", service: "http://127.0.0.1:10086" },
    { service: "http_status:404" },
  ]);
  assert.match(yaml, /tunnel: tunnel-id/);
  assert.match(yaml, /hostname: "node.example.com"/);
  assert.match(yaml, /service: "http:\/\/127.0.0.1:10086"/);
}

async function testNormalizeHostname() {
  assert.equal(normalizeHostname(" HTTPS://Node.Example.com/ "), "node.example.com");
}

module.exports = {
  testDecodeTunnelToken,
  testResolveTunnelSettings,
  testResolveAzureAppSettingFallback,
  testOpaqueTokenEnablesRemoteConnector,
  testRemoteConfigDoesNotRequireLocalCredentialsOrHostname,
  testLocalConfigStillRequiresCredentials,
  testBuildPortHostname,
  testBuildIngressRules,
  testRenderConfigYaml,
  testNormalizeHostname,
};
