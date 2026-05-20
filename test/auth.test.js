const assert = require("node:assert/strict");
const {
  createAuth,
  safeEqual,
  signPayload,
  verifySignedToken,
  parseCookies,
} = require("../lib/auth");

function mockReq(cookies = {}, body = {}) {
  return {
    headers: {
      cookie: Object.entries(cookies)
        .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
        .join("; "),
    },
    body,
  };
}

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    redirect(url) {
      this.redirectUrl = url;
      return this;
    },
  };
  return res;
}

async function testSafeEqual() {
  assert.equal(safeEqual("secret", "secret"), true);
  assert.equal(safeEqual("secret", "wrong"), false);
  assert.equal(safeEqual("short", "longer"), false);
}

async function testSignedSessionRoundTrip() {
  const token = signPayload(
    { user: "admin", exp: Date.now() + 60_000 },
    "test-secret"
  );
  const session = verifySignedToken(token, "test-secret");
  assert.equal(session.user, "admin");
}

async function testExpiredSessionRejected() {
  const token = signPayload(
    { user: "admin", exp: Date.now() - 1000 },
    "test-secret"
  );
  assert.equal(verifySignedToken(token, "test-secret"), null);
}

async function testVerifyLogin() {
  const auth = createAuth({
    env: {
      ADMIN_PASSWORD: "panel-pass",
      ADMIN_USERNAME: "admin",
      SESSION_SECRET: "fixed-secret",
    },
  });
  assert.equal(auth.verifyLogin("admin", "panel-pass"), true);
  assert.equal(auth.verifyLogin("admin", "wrong"), false);
  assert.equal(auth.verifyLogin("other", "panel-pass"), false);
}

async function testLoginSetsCookieAndRedirectsPayload() {
  const auth = createAuth({
    env: {
      ADMIN_PASSWORD: "panel-pass",
      SESSION_SECRET: "fixed-secret",
    },
  });
  const req = mockReq({}, { username: "admin", password: "panel-pass" });
  const res = mockRes();

  auth.handleLogin(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.match(res.headers["Set-Cookie"], /btblog_session=/);
}

async function testRequireAuthBlocksAnonymousRequests() {
  const auth = createAuth({
    env: {
      ADMIN_PASSWORD: "panel-pass",
      SESSION_SECRET: "fixed-secret",
    },
  });
  const req = mockReq();
  const res = mockRes();
  let nextCalled = false;

  auth.requireAuth(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
}

async function testRequireAuthAllowsValidSession() {
  const auth = createAuth({
    env: {
      ADMIN_PASSWORD: "panel-pass",
      SESSION_SECRET: "fixed-secret",
    },
  });
  const token = auth.createSessionToken();
  const req = mockReq({ btblog_session: token });
  const res = mockRes();
  let nextCalled = false;

  auth.requireAuth(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
}

async function testParseCookies() {
  const cookies = parseCookies("a=1; btblog_session=abc%3D");
  assert.equal(cookies.a, "1");
  assert.equal(cookies.btblog_session, "abc=");
}

module.exports = {
  testSafeEqual,
  testSignedSessionRoundTrip,
  testExpiredSessionRejected,
  testVerifyLogin,
  testLoginSetsCookieAndRedirectsPayload,
  testRequireAuthBlocksAnonymousRequests,
  testRequireAuthAllowsValidSession,
  testParseCookies,
};
