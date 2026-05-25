const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  DEFAULT_BAOTA_PORT,
  SETTINGS_FILE,
  loadBaotaSettings,
  saveBaotaSettings,
  buildBaotaSettingsResponse,
} = require("../lib/baota-settings");

async function testLoadBaotaSettingsCreatesPersistentDefaults() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baota-settings-"));
  try {
    const first = loadBaotaSettings(dir);
    const second = loadBaotaSettings(dir);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, SETTINGS_FILE), "utf8"));

    assert.equal(first.port, DEFAULT_BAOTA_PORT);
    assert.match(first.safePath, /^\/btblog-[a-z0-9]{8}$/);
    assert.equal(first.username, "btadmin");
    assert.match(first.password, /^[A-Za-z0-9_-]{18}$/);
    assert.deepEqual(second, first);
    assert.equal(stored.safePath, first.safePath);
    assert.equal(stored.password, first.password);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testSaveBaotaSettingsValidatesAndPreservesBlankPassword() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baota-settings-"));
  try {
    const initial = loadBaotaSettings(dir);
    const saved = saveBaotaSettings(dir, {
      port: "21222",
      safePath: "my-safe-entry",
      username: "panel_user",
      password: "",
    });

    assert.equal(saved.port, 21222);
    assert.equal(saved.safePath, "/my-safe-entry");
    assert.equal(saved.username, "panel_user");
    assert.equal(saved.password, initial.password);
    assert.throws(
      () => saveBaotaSettings(dir, { port: "70000" }),
      /端口必须是 1-65535/
    );
    assert.throws(
      () => saveBaotaSettings(dir, { safePath: "/" }),
      /安全入口必须以 \//
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testBaotaSettingsResponseDoesNotExposePassword() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baota-settings-"));
  try {
    const settings = saveBaotaSettings(dir, {
      port: "21222",
      safePath: "/fixed-path",
      username: "admin2",
      password: "secret-pass-123",
    });
    const response = buildBaotaSettingsResponse(settings, path.join(dir, SETTINGS_FILE));

    assert.equal(response.port, 21222);
    assert.equal(response.safePath, "/fixed-path");
    assert.equal(response.username, "admin2");
    assert.equal(response.hasPassword, true);
    assert.equal(Object.hasOwn(response, "password"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = {
  testLoadBaotaSettingsCreatesPersistentDefaults,
  testSaveBaotaSettingsValidatesAndPreservesBlankPassword,
  testBaotaSettingsResponseDoesNotExposePassword,
};
