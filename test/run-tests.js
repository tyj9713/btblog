const suites = [
  require("./package.test"),
  require("./runtime.test"),
  require("./service-manager.test"),
  require("./ui-structure.test"),
  require("./public-pages.test"),
  require("./auth.test"),
  require("./port-tunnel-manager.test"),
  require("./cloudflare-tunnel-config.test"),
  require("./cloudflare-tunnel-manager.test"),
  require("./cloudflare-tunnel-scripts.test"),
  require("./cleanup-runtime.test"),
  require("./start-named-tunnel.test"),
  require("./baota-manager.test"),
];

async function main() {
  let failed = 0;

  for (const suite of suites) {
    for (const [name, run] of Object.entries(suite)) {
      try {
        await run();
        console.log(`PASS ${name}`);
      } catch (error) {
        failed += 1;
        console.error(`FAIL ${name}`);
        console.error(error && error.stack ? error.stack : error);
      }
    }
  }

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main();
