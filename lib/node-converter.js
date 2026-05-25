const fs = require("node:fs");
const path = require("node:path");

const VIRTUAL_SUBMISSION = {
  uuid: "00000000-0000-4000-8000-000000000001",
  host: "placeholder.local",
  urlpath: "placeholder",
};

const SUBSCRIPTION_CHANNELS = [
  { name: "owo", sub: "owo.o00o.ooo" },
  { name: "天诚", sub: "cm.soso.edu.kg" },
  { name: "周润发", sub: "zrf.zrf.me" },
  { name: "文烨", sub: "sub.keaeye.icu" },
  { name: "Kristi", sub: "sub.mot.cloudns.biz" },
  { name: "Mia", sub: "sub.xinyitang.dpdns.org" },
  { name: "辣子鸡", sub: "sub.lzjbaby.com" },
];

function buildSubscriptionUrl(sub, submission = VIRTUAL_SUBMISSION) {
  const params = new URLSearchParams({
    uuid: submission.uuid,
    encryption: "none",
    security: "tls",
    type: "ws",
    host: submission.host,
    path: submission.urlpath,
  });
  return `https://${sub}/sub?${params.toString()}`;
}

function parseVlessLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed.startsWith("vless://")) {
    return null;
  }

  const hashIndex = trimmed.lastIndexOf("#");
  const encodedName = hashIndex >= 0 ? trimmed.slice(hashIndex + 1) : "";
  const ipPort = trimmed.split("@")[1]?.split("?")[0];
  if (!ipPort) {
    return null;
  }

  return { ipPort, encodedName };
}

function buildLocalNode({ ipPort, encodedName }, session) {
  const uuid = String(session.uuid || "").trim();
  const host = String(session.host || "").trim();
  const urlpath = String(session.urlpath || "").trim();
  const fragment = encodedName ? `#${encodedName}` : "";

  return `vless://${uuid}@${ipPort}?encryption=none&security=tls&type=ws&host=${host}&path=/${urlpath}${fragment}`;
}

function convertSubscriptionNodes(decodedContent, session) {
  const uuid = String(session.uuid || "").trim();
  const host = String(session.host || "").trim();
  const urlpath = String(session.urlpath || "").trim();

  if (!uuid || !host || !urlpath) {
    throw new Error("节点会话信息不完整");
  }

  const lines = String(decodedContent || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const converted = [];
  const seen = new Set();

  for (const line of lines) {
    const parsed = parseVlessLine(line);
    if (!parsed) {
      continue;
    }

    const dedupeKey = `${parsed.ipPort}#${parsed.encodedName}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);

    converted.push(buildLocalNode(parsed, session));
  }

  if (converted.length === 0) {
    converted.push(
      `vless://${uuid}@${host}:443?encryption=none&security=tls&type=ws&host=${host}&path=/${urlpath}#默认节点_TLS`
    );
  }

  return `${converted.join("\n")}\n`;
}

function loadNodeSession(runtimeDir) {
  const sessionPath = path.join(runtimeDir, "node-session.json");
  if (!fs.existsSync(sessionPath)) {
    return null;
  }

  try {
    const data = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
    const uuid = String(data.uuid || "").trim();
    const urlpath = String(data.urlpath || "").trim();
    const host = String(data.host || "").trim();

    if (!uuid || !urlpath || !host) {
      return null;
    }

    return { uuid, urlpath, host, port: data.port };
  } catch {
    return null;
  }
}

async function fetchChannelSubscription(channel, fetchImpl = fetch, submission = VIRTUAL_SUBMISSION) {
  const response = await fetchImpl(buildSubscriptionUrl(channel.sub, submission), channel);
  if (!response.ok) {
    throw new Error(`${channel.name} 订阅请求失败: ${response.status}`);
  }

  const encoded = (await response.text()).trim();
  if (!encoded) {
    return "";
  }

  return Buffer.from(encoded, "base64").toString("utf8");
}

async function fetchAllSubscriptionNodes(
  fetchImpl = fetch,
  channels = SUBSCRIPTION_CHANNELS,
  submission = VIRTUAL_SUBMISSION
) {
  const results = await Promise.allSettled(
    channels.map((channel) => fetchChannelSubscription(channel, fetchImpl, submission))
  );

  return results
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value)
    .filter(Boolean)
    .join("\n");
}

async function buildSubscriptionContent(runtimeDir, fetchImpl = fetch) {
  const session = loadNodeSession(runtimeDir);
  if (!session) {
    return {
      ok: false,
      message: "未找到 node-session.json，请先启动服务",
    };
  }

  let decodedContent = "";
  try {
    decodedContent = await fetchAllSubscriptionNodes(fetchImpl);
  } catch (error) {
    return {
      ok: false,
      message: `获取订阅失败: ${error.message}`,
    };
  }

  return {
    ok: true,
    content: convertSubscriptionNodes(decodedContent, session),
  };
}

module.exports = {
  VIRTUAL_SUBMISSION,
  SUBSCRIPTION_CHANNELS,
  buildSubscriptionUrl,
  parseVlessLine,
  buildLocalNode,
  convertSubscriptionNodes,
  loadNodeSession,
  fetchChannelSubscription,
  fetchAllSubscriptionNodes,
  buildSubscriptionContent,
};
