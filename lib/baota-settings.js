const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SETTINGS_FILE = "baota-settings.json";
const DEFAULT_BAOTA_PORT = 8888;
const DEFAULT_BAOTA_USERNAME = "btadmin";

function randomToken(length) {
  return crypto
    .randomBytes(Math.ceil((length * 3) / 4))
    .toString("base64url")
    .slice(0, length);
}

function normalizePort(value, fallback = DEFAULT_BAOTA_PORT) {
  const raw = value === undefined || value === null || value === "" ? fallback : value;
  const port = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("端口必须是 1-65535 之间的数字");
  }
  return port;
}

function normalizeSafePath(value) {
  const raw = String(value || "").trim() || `/btblog-${randomToken(8).toLowerCase()}`;
  const safePath = raw.startsWith("/") ? raw : `/${raw}`;
  if (safePath === "/" || !/^\/[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/.test(safePath)) {
    throw new Error("安全入口必须以 / 开头，并使用 3-64 位字母、数字、下划线或横线");
  }
  return safePath;
}

function normalizeUsername(value) {
  const username = String(value || DEFAULT_BAOTA_USERNAME).trim();
  if (!/^[A-Za-z0-9_@.-]{3,32}$/.test(username)) {
    throw new Error("用户名必须是 3-32 位字母、数字或 _ @ . -");
  }
  return username;
}

function normalizePassword(value, fallback = "") {
  const password = String(value || fallback || randomToken(18)).trim();
  if (password.length < 8 || password.length > 64) {
    throw new Error("密码长度必须是 8-64 位");
  }
  return password;
}

function settingsPath(runtimeDir) {
  return path.join(runtimeDir, SETTINGS_FILE);
}

function writeSettings(runtimeDir, settings) {
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(settingsPath(runtimeDir), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function normalizeSettings(input = {}, existing = {}) {
  return {
    port: normalizePort(input.port ?? existing.port),
    safePath: normalizeSafePath(input.safePath ?? existing.safePath),
    username: normalizeUsername(input.username ?? existing.username),
    password: normalizePassword(input.password, existing.password),
  };
}

function loadBaotaSettings(runtimeDir, env = process.env) {
  let stored = {};
  const filePath = settingsPath(runtimeDir);
  if (fs.existsSync(filePath)) {
    try {
      stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      stored = {};
    }
  }

  const settings = normalizeSettings({
    port: stored.port ?? env.BT_PORT,
    safePath: stored.safePath ?? env.BT_SAFE_PATH,
    username: stored.username ?? env.BT_USERNAME,
    password: stored.password ?? env.BT_PASSWORD,
  });
  writeSettings(runtimeDir, settings);
  return settings;
}

function saveBaotaSettings(runtimeDir, input = {}) {
  const existing = loadBaotaSettings(runtimeDir);
  const settings = normalizeSettings(input, existing);
  writeSettings(runtimeDir, settings);
  return settings;
}

function buildBaotaSettingsResponse(settings, filePath) {
  return {
    settingsFile: filePath,
    port: settings.port,
    safePath: settings.safePath,
    username: settings.username,
    hasPassword: Boolean(settings.password),
  };
}

module.exports = {
  SETTINGS_FILE,
  DEFAULT_BAOTA_PORT,
  loadBaotaSettings,
  saveBaotaSettings,
  buildBaotaSettingsResponse,
};
