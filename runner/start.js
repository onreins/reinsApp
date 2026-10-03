/**
 * The one way in to the runner's commands:
 *
 *   node runner/start.js run [--once]           the runner (npm run runner)
 *   node runner/start.js key <strategy> ...     issue a hosted key (npm run runner:key)
 *   node runner/start.js admin <command> ...    status, resume (npm run runner:admin)
 *
 * It checks the Node version before anything else is loaded: the store uses
 * Node's built-in SQLite, and on an older Node that fails with a confusing
 * module error before any of the runner's own code could explain it.
 */
const MIN = [22, 13];
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < MIN[0] || (major === MIN[0] && minor < MIN[1])) {
  console.error(`\n  The runner needs Node ${MIN.join(".")} or later (it uses node:sqlite); this is ${process.versions.node}.\n`);
  process.exit(1);
}

const [command, ...rest] = process.argv.slice(2);
const fail = (err) => {
  console.error(`\n  ${err?.message ?? err}\n`);
  process.exit(1);
};

if (command === "run") {
  const { startRunner } = await import("./index.js");
  const { loadConfig } = await import("./config.js");
  try {
    const result = await startRunner(loadConfig(), { once: rest.includes("--once") });
    if (result === false) process.exit(1);
  } catch (err) {
    fail(err);
  }
} else if (command === "key") {
  process.argv.splice(2, 1); // issue-key reads its own arguments
  await import("./issue-key.js");
} else if (command === "admin") {
  const { run } = await import("./admin.js");
  try {
    run(rest);
  } catch (err) {
    fail(err);
  }
} else {
  fail("say what to start: run, key or admin");
}
