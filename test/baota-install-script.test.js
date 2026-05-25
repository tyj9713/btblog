const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const script = fs.readFileSync(path.join(__dirname, "..", "install-baota.sh"), "utf8");

async function testInstallScriptAppliesFixedBaotaSettings() {
  assert.match(script, /BAOTA_SETTINGS_FILE=/);
  assert.match(script, /load_baota_settings\(\)/);
  assert.match(script, /apply_baota_settings\(\)/);
  assert.match(script, /save_bt_default/);
  assert.match(script, /write_panel_url_file/);
}

async function testInstallScriptUsesFixedPortForNamedTunnelRoutes() {
  assert.match(script, /read_configured_panel_port\(\)/);
  assert.match(script, /port="\$\(read_panel_port\)"/);
}

module.exports = {
  testInstallScriptAppliesFixedBaotaSettings,
  testInstallScriptUsesFixedPortForNamedTunnelRoutes,
};
