const suites = [
  require("./package.test"),
  require("./runtime.test"),
  require("./service-manager.test"),
  require("./ui-structure.test"),
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
