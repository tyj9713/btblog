const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const welcomeHtml = fs.readFileSync(
  path.join(__dirname, "..", "public", "welcome.html"),
  "utf8"
);
const adminLoginHtml = fs.readFileSync(
  path.join(__dirname, "..", "public", "admin-login.html"),
  "utf8"
);

async function testWelcomePageStructure() {
  assert.match(welcomeHtml, /Welcome/);
  assert.match(welcomeHtml, /href="\/admin"/);
  assert.match(welcomeHtml, /href="\/healthz"/);
}

async function testAdminLoginPageStructure() {
  assert.match(adminLoginHtml, /管理员登录/);
  assert.match(adminLoginHtml, /ADMIN_PASSWORD/);
  assert.match(adminLoginHtml, /\/admin\/login/);
  assert.match(adminLoginHtml, /\/admin\/session/);
}

module.exports = {
  testWelcomePageStructure,
  testAdminLoginPageStructure,
};
