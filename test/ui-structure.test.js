const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(
  path.join(__dirname, "..", "views", "panel.html"),
  "utf8"
);

async function testV2RayPanelStructure() {
  assert.match(html, /id="v2ray-content"/);
  assert.match(html, /id="v2ray-info"/);
  assert.match(html, /id="refresh-v2ray"/);
  assert.match(html, /function\s+getV2RayInfo\s*\(/);
}

async function testMainPanelsAreInsideTabContent() {
  assert.match(
    html,
    /<div class="tab-content" id="infoTabContent">[\s\S]*id="v2ray-content"[\s\S]*id="server-content"[\s\S]*id="baota-content"[\s\S]*id="port-tunnel-content"[\s\S]*id="logs-content"[\s\S]*id="terminal-content"[\s\S]*<\/div>/
  );
}

async function testAllLoadingPanelsHaveErrorFallbacks() {
  assert.match(html, /setPanelText\("v2ray-info"/);
  assert.match(html, /setPanelText\("server-info"/);
  assert.match(html, /setPanelText\("system-logs-content"/);
  assert.match(html, /setPanelText\("process-logs-content"/);
  assert.match(html, /setPanelText\("files-logs-content"/);
  assert.match(html, /setPanelText\("argo-logs-content"/);
  assert.match(html, /setPanelText\("baota-login-info"/);
  assert.match(html, /setPanelText\("baota-install-log"/);
  assert.match(html, /setPanelText\("baota-tunnel-log"/);
  assert.match(html, /setPanelText\("baota-logs-content"/);
}

async function testLogsPanelShowsStartupAndRuntimeLogs() {
  assert.match(html, /suoha-start\.log/);
  assert.match(html, /suoha\.log/);
  assert.match(html, /xray\.log/);
  assert.match(html, /argo\.log/);
}

async function testFetchJsonAcceptsRequestOptions() {
  assert.match(html, /async function fetchJson\(url, options = \{\}\)/);
  assert.match(html, /fetch\(url, \{ \.\.\.options, cache: "no-store" \}\)/);
}

async function testBaotaPanelStructure() {
  assert.match(html, /id="baota-content"/);
  assert.match(html, /id="baota-login-info"/);
  assert.match(html, /id="refresh-baota"/);
  assert.match(html, /function\s+getBaotaInfo\s*\(/);
  assert.match(html, /\/baota-info/);
  assert.match(html, /\/start-baota/);
  assert.match(html, /baota-install\.log/);
}

async function testTabsHaveLocalFallbackSwitcher() {
  assert.match(html, /function setupTabs\(/);
  assert.match(html, /setupTabs\("infoTabs"\)/);
  assert.match(html, /setupTabs\("logsSubTabs"\)/);
  assert.match(html, /setupTabs\("baotaSubTabs"\)/);
}

async function testPanelHasLogoutAction() {
  assert.match(html, /id="logout-btn"/);
  assert.match(html, /\/admin\/logout/);
  assert.match(html, /window\.location\.href = "\/admin"/);
}

async function testPortTunnelPanelStructure() {
  assert.match(html, /id="port-tunnel-content"/);
  assert.match(html, /id="bind-port-btn"/);
  assert.match(html, /id="port-input"/);
  assert.match(html, /function\s+getPortTunnels\s*\(/);
  assert.match(html, /\/port-tunnels\/bind/);
  assert.match(html, /\/port-tunnels\/unbind/);
}

async function testNamedTunnelConfigPanelStructure() {
  assert.match(html, /id="named-tunnel-content"/);
  assert.match(html, /id="save-tunnel-config-btn"/);
  assert.match(html, /id="start-tunnel-btn"/);
  assert.match(html, /id="tunnel-account-id"/);
  assert.match(html, /id="tunnel-id"/);
  assert.match(html, /id="named-tunnel-runtime-log"/);
  assert.match(html, /id="overview-tunnel-label"/);
  assert.match(html, /\/tunnel-config/);
  assert.match(html, /function\s+saveTunnelConfig\s*\(/);
  assert.match(html, /function\s+isNamedTunnelTabActive\s*\(/);
  assert.doesNotMatch(html, /restart-tunnel-btn/);
}

async function testOverviewRefreshSkipsTunnelConfigOnActiveTab() {
  assert.match(html, /async function refreshOverview\(options = \{\}\)/);
  assert.match(html, /!isNamedTunnelTabActive\(\)/);
  assert.match(html, /setPanelText\("named-tunnel-runtime-log"/);
}

async function testPanelDoesNotAutoPoll() {
  assert.doesNotMatch(html, /setInterval\(updateServiceStatus/);
  assert.doesNotMatch(html, /setInterval\(getBaotaInfo/);
  assert.doesNotMatch(html, /setInterval\(\(\) => getPortTunnels/);
}

async function testTerminalPanelStructure() {
  assert.match(html, /id="terminal-content"/);
  assert.match(html, /id="terminal-container"/);
  assert.match(html, /id="terminal-tab"/);
  assert.match(html, /id="terminal-reconnect-btn"/);
  assert.match(html, /function connectTerminal\s*\(/);
  assert.match(html, /\/terminal-info/);
  assert.match(html, /xterm\.min\.js/);
}

module.exports = {
  testV2RayPanelStructure,
  testMainPanelsAreInsideTabContent,
  testAllLoadingPanelsHaveErrorFallbacks,
  testLogsPanelShowsStartupAndRuntimeLogs,
  testBaotaPanelStructure,
  testFetchJsonAcceptsRequestOptions,
  testTabsHaveLocalFallbackSwitcher,
  testPanelHasLogoutAction,
  testPortTunnelPanelStructure,
  testNamedTunnelConfigPanelStructure,
  testOverviewRefreshSkipsTunnelConfigOnActiveTab,
  testPanelDoesNotAutoPoll,
  testTerminalPanelStructure,
};
