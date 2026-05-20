const crypto = require("node:crypto");

const COOKIE_NAME = "btblog_session";
const DEFAULT_SESSION_HOURS = 24;

function parseCookies(header) {
  const cookies = {};
  if (!header) {
    return cookies;
  }
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = trimmed.slice(0, separator);
    const value = trimmed.slice(separator + 1);
    cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) {
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function signPayload(payload, secret) {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(data)
    .digest("base64url");
  return `${data}.${signature}`;
}

function verifySignedToken(token, secret) {
  if (!token || !secret) {
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 2) {
    return null;
  }
  const [data, signature] = parts;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(data)
    .digest("base64url");

  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    sigBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(sigBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    if (!payload || typeof payload.exp !== "number" || payload.exp < Date.now()) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function shouldUseSecureCookie(env = process.env) {
  if (env.ADMIN_COOKIE_SECURE === "true") {
    return true;
  }
  if (env.ADMIN_COOKIE_SECURE === "false") {
    return false;
  }
  return Boolean(env.WEBSITE_SITE_NAME || env.NODE_ENV === "production");
}

function createAuth(options = {}) {
  const env = options.env || process.env;
  const password = String(env.ADMIN_PASSWORD || "");
  const username = String(env.ADMIN_USERNAME || "admin");
  const sessionSecret =
    String(env.SESSION_SECRET || "") ||
    crypto.randomBytes(32).toString("hex");
  const sessionHours = Number(env.ADMIN_SESSION_HOURS || DEFAULT_SESSION_HOURS);
  const sessionTtlMs =
    Number.isFinite(sessionHours) && sessionHours > 0
      ? sessionHours * 60 * 60 * 1000
      : DEFAULT_SESSION_HOURS * 60 * 60 * 1000;
  const secureCookie = shouldUseSecureCookie(env);

  function isConfigured() {
    return password.length > 0;
  }

  function verifyLogin(inputUsername, inputPassword) {
    if (!isConfigured()) {
      return false;
    }
    if (!safeEqual(inputUsername, username)) {
      return false;
    }
    return safeEqual(inputPassword, password);
  }

  function createSessionToken() {
    return signPayload(
      {
        user: username,
        exp: Date.now() + sessionTtlMs,
      },
      sessionSecret
    );
  }

  function getSession(req) {
    const cookies = parseCookies(req.headers.cookie);
    return verifySignedToken(cookies[COOKIE_NAME], sessionSecret);
  }

  function buildSessionCookie(token) {
    const maxAgeSeconds = Math.floor(sessionTtlMs / 1000);
    const parts = [
      `${COOKIE_NAME}=${encodeURIComponent(token)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${maxAgeSeconds}`,
    ];
    if (secureCookie) {
      parts.push("Secure");
    }
    return parts.join("; ");
  }

  function buildClearSessionCookie() {
    const parts = [`${COOKIE_NAME}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
    if (secureCookie) {
      parts.push("Secure");
    }
    return parts.join("; ");
  }

  function requireAuth(req, res, next) {
    if (!isConfigured()) {
      return res.status(503).json({
        error: "管理员认证未配置",
        message: "请在应用服务环境变量中设置 ADMIN_PASSWORD",
      });
    }
    if (getSession(req)) {
      return next();
    }
    return res.status(401).json({
      error: "未授权",
      message: "请先登录管理员账号",
    });
  }

  function handleLogin(req, res) {
    if (!isConfigured()) {
      return res.status(503).json({
        ok: false,
        message: "未配置 ADMIN_PASSWORD，无法登录",
      });
    }

    const inputUsername = String(req.body?.username || "").trim();
    const inputPassword = String(req.body?.password || "");

    if (!verifyLogin(inputUsername, inputPassword)) {
      return res.status(401).json({
        ok: false,
        message: "用户名或密码错误",
      });
    }

    const token = createSessionToken();
    res.setHeader("Set-Cookie", buildSessionCookie(token));
    return res.json({
      ok: true,
      message: "登录成功",
      redirect: "/admin/panel",
    });
  }

  function handleLogout(_req, res) {
    res.setHeader("Set-Cookie", buildClearSessionCookie());
    return res.json({
      ok: true,
      message: "已退出登录",
      redirect: "/",
    });
  }

  function handleSession(req, res) {
    if (!isConfigured()) {
      return res.json({
        authenticated: false,
        configured: false,
      });
    }
    const session = getSession(req);
    return res.json({
      authenticated: Boolean(session),
      configured: true,
      username: session ? session.user : null,
    });
  }

  function redirectIfAuthenticated(req, res, next) {
    if (getSession(req)) {
      return res.redirect("/admin/panel");
    }
    return next();
  }

  function requirePageAuth(req, res, next) {
    if (!isConfigured()) {
      return res.redirect("/admin?error=not-configured");
    }
    if (getSession(req)) {
      return next();
    }
    return res.redirect("/admin");
  }

  return {
    COOKIE_NAME,
    isConfigured,
    verifyLogin,
    createSessionToken,
    getSession,
    requireAuth,
    requirePageAuth,
    redirectIfAuthenticated,
    handleLogin,
    handleLogout,
    handleSession,
    buildSessionCookie,
    buildClearSessionCookie,
  };
}

module.exports = {
  COOKIE_NAME,
  createAuth,
  parseCookies,
  safeEqual,
  signPayload,
  verifySignedToken,
};
