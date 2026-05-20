function resolveRuntimeDir(env = process.env, appDir = process.cwd()) {
  return env.ARGO_RUNTIME_DIR || appDir;
}

module.exports = {
  resolveRuntimeDir,
};
