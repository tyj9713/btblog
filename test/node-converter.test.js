const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  VIRTUAL_SUBMISSION,
  SUBSCRIPTION_CHANNELS,
  buildSubscriptionUrl,
  parseVlessLine,
  buildLocalNode,
  convertSubscriptionNodes,
  buildSubscriptionContent,
} = require("../lib/node-converter");

const session = {
  uuid: "11111111-2222-3333-4444-555555555555",
  host: "node.example.com",
  urlpath: "11111111",
};

function testSubscriptionChannelsIncludeAllProviders() {
  const subs = SUBSCRIPTION_CHANNELS.map((channel) => channel.sub);
  assert.deepEqual(subs, [
    "owo.o00o.ooo",
    "cm.soso.edu.kg",
    "zrf.zrf.me",
    "sub.keaeye.icu",
    "sub.mot.cloudns.biz",
    "sub.xinyitang.dpdns.org",
    "sub.lzjbaby.com",
  ]);
}

function testBuildSubscriptionUrlUsesVirtualSubmission() {
  const url = buildSubscriptionUrl("cm.soso.edu.kg");

  assert.match(url, /^https:\/\/cm\.soso\.edu\.kg\/sub\?/);
  assert.match(url, new RegExp(`uuid=${VIRTUAL_SUBMISSION.uuid}`));
  assert.match(url, new RegExp(`host=${VIRTUAL_SUBMISSION.host}`));
  assert.match(url, new RegExp(`path=${VIRTUAL_SUBMISSION.urlpath}`));
  assert.doesNotMatch(url, /11111111-2222-3333-4444-555555555555/);
}

function testParseVlessLineExtractsIpPortAndTitle() {
  const parsed = parseVlessLine(
    "vless://fake@1.2.3.4:8443?type=ws#%E6%97%A5%E6%9C%AC%E8%8A%82%E7%82%B9"
  );

  assert.deepEqual(parsed, {
    ipPort: "1.2.3.4:8443",
    encodedName: "%E6%97%A5%E6%9C%AC%E8%8A%82%E7%82%B9",
  });
}

function testBuildLocalNodeUsesRealSession() {
  const node = buildLocalNode(
    { ipPort: "1.2.3.4:443", encodedName: "%E6%97%A5%E6%9C%AC" },
    session
  );

  assert.match(node, /vless:\/\/11111111-2222-3333-4444-555555555555@1\.2\.3\.4:443/);
  assert.match(node, /host=node\.example\.com/);
  assert.match(node, /path=\/11111111/);
  assert.match(node, /#%E6%97%A5%E6%9C%AC$/);
}

function testConvertSubscriptionNodesIncludesAllRegions() {
  const raw = [
    "vless://old@1.2.3.4:443?type=ws#%E6%97%A5%E6%9C%AC",
    "vless://old@5.6.7.8:443?type=ws#%E5%BE%B7%E5%9B%BD",
  ].join("\n");

  const result = convertSubscriptionNodes(raw, session);

  assert.match(result, /1\.2\.3\.4:443/);
  assert.match(result, /5\.6\.7\.8:443/);
}

function testConvertSubscriptionNodesDedupesByIpPortAndTitle() {
  const raw = [
    "vless://old@1.2.3.4:443?type=ws#%E6%97%A5%E6%9C%AC",
    "vless://other@1.2.3.4:443?type=ws#%E6%97%A5%E6%9C%AC",
  ].join("\n");

  const result = convertSubscriptionNodes(raw, session);
  assert.equal(result.trim().split("\n").length, 1);
}

function testConvertSubscriptionNodesUsesDefaultWhenEmpty() {
  const result = convertSubscriptionNodes("", session);

  assert.match(result, /#默认节点_TLS/);
  assert.match(result, /@node\.example\.com:443/);
}

async function testBuildSubscriptionContentMergesMultipleChannels() {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-converter-"));
  fs.writeFileSync(
    path.join(runtimeDir, "node-session.json"),
    JSON.stringify({ ...session, port: 10086 })
  );

  const responses = {
    "https://owo.o00o.ooo/sub": Buffer.from(
      "vless://old@1.2.3.4:443?type=ws#%E6%97%A5%E6%9C%AC\n",
      "utf8"
    ).toString("base64"),
    "https://cm.soso.edu.kg/sub": Buffer.from(
      "vless://old@5.6.7.8:443?type=ws#%E9%A6%99%E6%B8%AF\n",
      "utf8"
    ).toString("base64"),
  };

  const result = await buildSubscriptionContent(runtimeDir, async (url) => {
    const key = String(url).split("?")[0];
    const body = responses[key];
    if (!body) {
      return { ok: false, text: async () => "" };
    }
    return { ok: true, text: async () => body };
  });

  assert.equal(result.ok, true);
  assert.match(result.content, /1\.2\.3\.4:443/);
  assert.match(result.content, /5\.6\.7\.8:443/);
}

module.exports = {
  testSubscriptionChannelsIncludeAllProviders,
  testBuildSubscriptionUrlUsesVirtualSubmission,
  testParseVlessLineExtractsIpPortAndTitle,
  testBuildLocalNodeUsesRealSession,
  testConvertSubscriptionNodesIncludesAllRegions,
  testConvertSubscriptionNodesDedupesByIpPortAndTitle,
  testConvertSubscriptionNodesUsesDefaultWhenEmpty,
  testBuildSubscriptionContentMergesMultipleChannels,
};
