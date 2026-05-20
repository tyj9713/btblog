const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(
  path.join(__dirname, "..", "public", "index.html"),
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
    /<div class="tab-content" id="infoTabContent">[\s\S]*id="v2ray-content"[\s\S]*id="server-content"[\s\S]*id="logs-content"[\s\S]*<\/div>/
  );
}

async function testAllLoadingPanelsHaveErrorFallbacks() {
  assert.match(html, /setPanelText\("v2ray-info"/);
  assert.match(html, /setPanelText\("server-info"/);
  assert.match(html, /setPanelText\("system-logs-content"/);
  assert.match(html, /setPanelText\("process-logs-content"/);
  assert.match(html, /setPanelText\("files-logs-content"/);
  assert.match(html, /setPanelText\("argo-logs-content"/);
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

async function testTabsHaveLocalFallbackSwitcher() {
  assert.match(html, /function setupTabs\(/);
  assert.match(html, /setupTabs\("infoTabs"\)/);
  assert.match(html, /setupTabs\("logsSubTabs"\)/);
}

module.exports = {
  testV2RayPanelStructure,
  testMainPanelsAreInsideTabContent,
  testAllLoadingPanelsHaveErrorFallbacks,
  testLogsPanelShowsStartupAndRuntimeLogs,
  testFetchJsonAcceptsRequestOptions,
  testTabsHaveLocalFallbackSwitcher,
};
