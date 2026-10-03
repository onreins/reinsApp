/**
 * Issue a hosted trading key from the command line (phase 2 adds the API).
 *
 *   npm run runner:key -- balance
 *   npm run runner:key -- savings '{"buyUsd":2,"everyHours":24,"targetShare":0.5}'
 *   npm run runner:key -- balance '{}' --owner 0xYourWallet   only that owner's agent may use it
 *
 * Prints the address only. Create an agent with that address as its trading
 * key (the create page's "I have a bot's address"), and the next pass of the
 * runner picks it up. A key no agent uses within a day is forgotten.
 */
import { loadConfig } from "./config.js";
import { openStore } from "./store.js";
import { createKeystore } from "./keystore.js";
import { settingsFor, STRATEGIES } from "./brains/index.js";

const args = process.argv.slice(2);
const ownerAt = args.indexOf("--owner");
const owner = ownerAt >= 0 ? args.splice(ownerAt, 2)[1] : null;
const [strategy, json = "{}"] = args;
try {
  if (!strategy) throw new Error(`name a strategy: ${Object.keys(STRATEGIES).join(" or ")}`);
  const settings = settingsFor(strategy, JSON.parse(json));
  if (owner !== null && !/^0x[0-9a-fA-F]{40}$/.test(owner ?? "")) throw new Error("--owner must be a 0x address");
  const config = loadConfig();
  const store = openStore(config.dbPath);
  const { address, sealed } = createKeystore({ masterKey: config.masterKey }).generate();
  store.issueKey({ address, sealed, strategy, settings, owner, at: Date.now() });
  store.close();
  console.log(`\n  ${STRATEGIES[strategy].label} key: ${address}`);
  console.log(`  settings: ${JSON.stringify(settings)}${owner ? `
  owner: ${owner}` : ""}`);
  console.log("  Use it as the agent's trading key. Unused keys are forgotten after a day.\n");
} catch (err) {
  console.error(`\n  ${err.message}\n`);
  process.exit(1);
}
