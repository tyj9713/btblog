const fs = require("node:fs");
const path = require("node:path");

const PROJECT_ROOT = path.join(__dirname, "..");
const SCRIPTS_DIR = path.join(PROJECT_ROOT, "scripts");

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function resolveScript(name, options = {}) {
  const cwd = options.cwd || process.cwd();
  const candidates = [
    path.join(cwd, "scripts", name),
    path.join(SCRIPTS_DIR, name),
    path.join(PROJECT_ROOT, name),
    path.join(cwd, name),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return path.join(SCRIPTS_DIR, name);
}

async function runScript(execAsync, scriptName, options = {}) {
  const scriptPath = options.scriptPath || resolveScript(scriptName, options);
  const quoted = shellQuote(scriptPath);
  const cwd = options.cwd || process.cwd();
  const env = {
    ...process.env,
    ...(options.env || {}),
    ARGO_RUNTIME_DIR: cwd,
  };

  if (options.chmod !== false) {
    await execAsync(`chmod +x ${quoted}`, {
      cwd,
      timeout: options.chmodTimeout || 10_000,
    });
  }

  const suffix = options.args ? ` ${options.args}` : "";
  const command = options.background
    ? `nohup bash ${quoted}${suffix} >/dev/null 2>&1 &`
    : `bash ${quoted}${suffix} 2>&1`;

  return execAsync(command, {
    cwd,
    timeout: options.timeout || 120_000,
    maxBuffer: options.maxBuffer || 4 * 1024 * 1024,
    env,
    shell: options.shell || "/bin/bash",
  });
}

module.exports = {
  runScript,
  resolveScript,
  shellQuote,
  SCRIPTS_DIR,
  PROJECT_ROOT,
};
